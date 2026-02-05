using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GameEngine.Configuration;
using GameEngine.Services;
using RNGClient;

namespace GameEngine.Play;

public sealed class SpinHandler
{
    private readonly GameConfigurationLoader _configurationLoader;
    private readonly WinEvaluator _winEvaluator;
    private readonly IRngClient _rngClient;
    private readonly ITimeService _timeService;
    private readonly FortunaPrng _fortunaPrng;
    private readonly ISpinTelemetrySink _telemetry;

    public SpinHandler(
        GameConfigurationLoader configurationLoader,
        WinEvaluator winEvaluator,
        ITimeService timeService,
        FortunaPrng fortunaPrng,
        IRngClient rngClient,
        ISpinTelemetrySink telemetry)
    {
        _configurationLoader = configurationLoader;
        _winEvaluator = winEvaluator;
        _timeService = timeService;
        _fortunaPrng = fortunaPrng;
        _rngClient = rngClient;
        _telemetry = telemetry;
    }

    public async Task<PlayResponse> PlayAsync(PlayRequest request, CancellationToken cancellationToken = default)
    {
        Console.WriteLine($"[SpinHandler] Processing play request for GameId: {request.GameId}");
        Console.WriteLine($"[SpinHandler] BaseBet: {request.BaseBet.Amount}, TotalBet: {request.TotalBet.Amount}");

        ValidateRequest(request);

        var configuration = await _configurationLoader.GetConfigurationAsync(request.GameId, cancellationToken);
        var roundId = CreateRoundId();
        Console.WriteLine($"[SpinHandler] RoundId: {roundId}");
        var nextState = request.EngineState?.Clone() ?? EngineSessionState.Create();
        var spinMode = request.IsFeatureBuy
            ? SpinMode.BuyEntry
            : nextState.IsInFreeSpins ? SpinMode.FreeSpins : SpinMode.BaseGame;

        var buyCost = request.IsFeatureBuy
            ? Money.FromBet(request.BaseBet.Amount, configuration.BuyFeature.CostMultiplier)
            : Money.Zero;

        var reelStrips = SelectReelStrips(configuration, spinMode, request.BetMode);
        var randomContext = await FetchRandomContext(configuration, reelStrips, request, roundId, spinMode, cancellationToken);
        var multiplierFactory = new Func<SymbolDefinition, decimal>(symbol =>
            AssignMultiplierValue(symbol, configuration, request.BetMode, spinMode, nextState.FreeSpins, randomContext));

        ReelBoardBase board;
        TopReel? topReel = null;

        if (configuration.Board.Megaways && configuration.Megaways is not null && randomContext.ReelHeights is not null)
        {
            if (configuration.Megaways.TopReel.Enabled)
            {
                var topReelStrips = reelStrips; // Use same strips for top reel
                topReel = TopReel.Create(
                    topReelStrips,
                    configuration.Megaways.TopReel.CoversReels,
                    configuration.Megaways.TopReel.SymbolCount,
                    randomContext.TopReelPosition ?? 0,
                    randomContext.TopReelSymbolSeeds,
                    _fortunaPrng);
            }

            board = MegawaysReelBoard.Create(
                reelStrips,
                configuration.SymbolMap,
                randomContext.ReelHeights,
                multiplierFactory,
                randomContext.ReelStartSeeds,
                topReel,
                configuration.Megaways.TopReel.Enabled ? configuration.Megaways.TopReel.CoversReels : null,
                _fortunaPrng);
        }
        else
        {
            board = ReelBoard.Create(
                reelStrips,
                configuration.SymbolMap,
                configuration.Board.Rows,
                multiplierFactory,
                randomContext.ReelStartSeeds,
                _fortunaPrng);
        }

        var cascades = new List<CascadeStep>();
        var wins = new List<SymbolWin>();
        var cascadeIndex = 0;
        Money totalWin = Money.Zero;
        Money scatterWin = Money.Zero;
        Money featureWin = nextState.FreeSpins?.FeatureWin ?? Money.Zero;
        int freeSpinsAwarded = 0;
        IReadOnlyList<IReadOnlyList<string>>? finalReelSymbols = null;

        while (true)
        {
            var reelSymbolsBefore = board.GetReelSymbols();
            
            // Get top reel symbols as codes for win evaluation
            IReadOnlyList<string>? topReelSymbolsForEval = null;
            if (board is MegawaysReelBoard megawaysBoardEval && megawaysBoardEval.TopReel is not null)
            {
                // Convert top reel symbol IDs to codes
                var topReelSymbolIds = megawaysBoardEval.TopReel.Symbols;
                var topReelCodes = new List<string>();
                foreach (var symbolId in topReelSymbolIds)
                {
                    if (configuration.SymbolMap.TryGetValue(symbolId, out var def))
                    {
                        topReelCodes.Add(def.Code);
                    }
                    else
                    {
                        // Fallback: use symbolId as-is if not found in map
                        topReelCodes.Add(symbolId);
                    }
                }
                topReelSymbolsForEval = topReelCodes;
            }
            
            // Log grid state before win evaluation (for verification / debugging)
            Console.WriteLine($"[SpinHandler] ===== CASCADE STEP {cascades.Count} - GRID BEFORE WIN EVALUATION ===== ");
            Console.WriteLine($"[SpinHandler] ReelSymbols: {reelSymbolsBefore.Count} columns");
            if (topReelSymbolsForEval != null)
                Console.WriteLine($"[SpinHandler] TopReelSymbolsBefore: [{string.Join(", ", topReelSymbolsForEval)}]");
            Console.WriteLine($"[SpinHandler] Main reels (rows 0 = bottom, top = row N-1):");
            for (int c = 0; c < reelSymbolsBefore.Count; c++)
            {
                var colList = reelSymbolsBefore[c];
                var syms = string.Join(", ", colList);
                Console.WriteLine($"[SpinHandler]   Reel {c} (height {colList.Count}): [{syms}]");
            }
            Console.WriteLine($"[SpinHandler] ----------------------------------------");

            // Evaluate wins using jagged array structure, including top reel symbols
            var evaluation = _winEvaluator.EvaluateMegaways(reelSymbolsBefore, topReelSymbolsForEval, configuration, request.TotalBet);

            if (evaluation.SymbolWins.Count > 0)
            {
                foreach (var sw in evaluation.SymbolWins)
                {
                    var posStr = sw.WinningPositions != null
                        ? string.Join(", ", sw.WinningPositions.Select(wp => $"({wp.Reel},{(wp.Position == -1 ? "top" : wp.Position.ToString())})"))
                        : "";
                    Console.WriteLine($"[SpinHandler] Win: Symbol={sw.SymbolCode}, Payout={sw.Payout.Amount}, Positions: [{posStr}]");
                }
                Console.WriteLine($"[SpinHandler] ----------------------------------------");
            }

            if (evaluation.SymbolWins.Count == 0)
            {
                finalReelSymbols = cascades.Count > 0 
                    ? cascades[^1].ReelSymbolsAfter 
                    : reelSymbolsBefore;
                break;
            }

            wins.AddRange(evaluation.SymbolWins);
            var cascadeBaseWin = evaluation.TotalWin;
            var cascadeFinalWin = cascadeBaseWin;
            decimal appliedMultiplier = 1m;

            // Collect multipliers from MULTIPLIER symbols (existing behavior)
            var multiplierSum = board.SumMultipliers();
            
            // Collect Wild multipliers from winning symbols (Buffalo King Megaways)
            decimal tumbleWildMultiplier = 1m;
            if (spinMode == SpinMode.FreeSpins && nextState.FreeSpins is not null)
            {
                var wildMultipliers = CollectWildMultipliersFromWinningSymbols(board, evaluation.SymbolWins, configuration);
                if (wildMultipliers.Count > 0)
                {
                    // Multiply all Wild multipliers together for this tumble
                    tumbleWildMultiplier = wildMultipliers.Aggregate(1m, (acc, val) => acc * val);
                }
            }

            if (spinMode == SpinMode.BaseGame || spinMode == SpinMode.BuyEntry)
            {
                if (multiplierSum > 0m && cascadeBaseWin.Amount > 0)
                {
                    appliedMultiplier = multiplierSum;
                    cascadeFinalWin = cascadeBaseWin * multiplierSum;
                }
            }
            else if (nextState.FreeSpins is not null)
            {
                // Add MULTIPLIER symbol values to total (existing behavior)
                if (multiplierSum > 0m)
                {
                    nextState.FreeSpins.TotalMultiplier += multiplierSum;
                }
                
                // Add tumble Wild multiplier to total (Buffalo King Megaways)
                if (tumbleWildMultiplier > 1m)
                {
                    nextState.FreeSpins.TotalMultiplier += tumbleWildMultiplier;
                }

                // Apply total multiplier (includes both MULTIPLIER symbols and Wild multipliers)
                if (nextState.FreeSpins.TotalMultiplier > 0m && cascadeBaseWin.Amount > 0)
                {
                    appliedMultiplier = nextState.FreeSpins.TotalMultiplier;
                    cascadeFinalWin = cascadeBaseWin * nextState.FreeSpins.TotalMultiplier;
                }
            }

            totalWin += cascadeFinalWin;

            if (spinMode == SpinMode.FreeSpins && nextState.FreeSpins is not null)
            {
                featureWin += cascadeFinalWin;
                nextState.FreeSpins.FeatureWin = featureWin;
            }

            // Remove only symbols at winning positions (contiguous reels), not all symbols of that code
            var positionsToRemove = evaluation.SymbolWins
                .SelectMany(win => win.WinningPositions ?? Array.Empty<WinningPosition>())
                .Select(wp => (wp.Reel, wp.Position))
                .ToList();

            // Capture top reel state before removal (for cascade step and frontend)
            // CRITICAL: Build list in ascending column order (1,2,3,4) so frontend slot index matches column
            IReadOnlyList<string>? topReelSymbolsBefore = null;
            if (board is MegawaysReelBoard megawaysBefore && megawaysBefore.TopReel is not null && configuration.Megaways?.TopReel?.CoversReels is not null)
            {
                var coversReels = configuration.Megaways.TopReel.CoversReels;
                var orderedCols = coversReels.OrderBy(c => c).ToList();
                var list = new List<string>(orderedCols.Count);
                foreach (var col in orderedCols)
                {
                    var symbolId = megawaysBefore.TopReel.GetSymbolForReel(col);
                    list.Add(configuration.SymbolMap.TryGetValue(symbolId, out var def) ? def.Code : symbolId);
                }
                topReelSymbolsBefore = list;
            }

            board.RemovePositions(positionsToRemove);

            // Replace winning top reel symbols with new symbols from the strip
            var topReelReelsToReplace = positionsToRemove.Where(p => p.Position == -1).Select(p => p.Reel).Distinct().ToList();
            if (board is MegawaysReelBoard megawaysBoard && megawaysBoard.TopReel is not null && topReelReelsToReplace.Count > 0 && configuration.Megaways?.TopReel?.CoversReels is { } coversReels)
            {
                var strip = reelStrips[coversReels[0]];
                megawaysBoard.ReplaceTopReelSymbolsAtReels(topReelReelsToReplace, strip, _fortunaPrng);
            }

            board.RemoveMultipliers();

            if (board.NeedsRefill)
            {
                board.Refill();
            }

            var reelSymbolsAfter = board.GetReelSymbols();

            // Capture top reel state after removal/refill (for cascade step and frontend)
            // When no top reel positions were removed, send the same as "before" so the frontend never shows wrong symbols
            IReadOnlyList<string>? topReelSymbolsAfter = null;
            if (topReelReelsToReplace.Count == 0 && topReelSymbolsBefore != null)
            {
                topReelSymbolsAfter = topReelSymbolsBefore;
            }
            else if (board is MegawaysReelBoard megawaysAfter && megawaysAfter.TopReel is not null && configuration.Megaways?.TopReel?.CoversReels is not null)
            {
                var list = new List<string>();
                foreach (var col in configuration.Megaways.TopReel.CoversReels)
                {
                    var symbolId = megawaysAfter.TopReel.GetSymbolForReel(col);
                    list.Add(configuration.SymbolMap.TryGetValue(symbolId, out var def) ? def.Code : symbolId);
                }
                topReelSymbolsAfter = list;
            }

            cascades.Add(new CascadeStep(
                Index: cascadeIndex++,
                ReelSymbolsBefore: reelSymbolsBefore,
                ReelSymbolsAfter: reelSymbolsAfter,
                WinsAfterCascade: evaluation.SymbolWins,
                BaseWin: cascadeBaseWin,
                AppliedMultiplier: appliedMultiplier,
                TotalWin: cascadeFinalWin,
                TopReelSymbolsBefore: topReelSymbolsBefore,
                TopReelSymbolsAfter: topReelSymbolsAfter));
        }

        var scatterOutcome = ResolveScatterOutcome(board, configuration, request.TotalBet);
        if (scatterOutcome is not null)
        {
            scatterWin = scatterOutcome.Win;
            totalWin += scatterWin;

            if ((spinMode == SpinMode.BaseGame || spinMode == SpinMode.BuyEntry) && scatterOutcome.FreeSpinsAwarded > 0)
            {
                InitializeFreeSpins(configuration, nextState, scatterOutcome.FreeSpinsAwarded);
                spinMode = SpinMode.FreeSpins;
                freeSpinsAwarded = scatterOutcome.FreeSpinsAwarded;
            }
            else if (spinMode == SpinMode.FreeSpins && nextState.FreeSpins is not null)
            {
                if (scatterOutcome.SymbolCount >= configuration.FreeSpins.RetriggerScatterCount)
                {
                    nextState.FreeSpins.SpinsRemaining += configuration.FreeSpins.RetriggerSpins;
                    nextState.FreeSpins.TotalSpinsAwarded += configuration.FreeSpins.RetriggerSpins;
                    freeSpinsAwarded = configuration.FreeSpins.RetriggerSpins;
                }
            }
        }

        if (spinMode == SpinMode.FreeSpins && nextState.FreeSpins is not null)
        {
            nextState.FreeSpins.SpinsRemaining = Math.Max(0, nextState.FreeSpins.SpinsRemaining - 1);
            nextState.FreeSpins.JustTriggered = false;

            if (nextState.FreeSpins.SpinsRemaining == 0)
            {
                nextState.FreeSpins = null;
            }
        }

        var maxWin = Money.FromBet(request.TotalBet.Amount, configuration.MaxWinMultiplier);
        if (totalWin.Amount > maxWin.Amount)
        {
            totalWin = maxWin;
            // Buffalo King Megaways: If max win is reached during free spins, end the round immediately
            if (spinMode == SpinMode.FreeSpins && nextState.FreeSpins is not null)
            {
                nextState.FreeSpins.SpinsRemaining = 0;
                nextState.FreeSpins = null;
            }
        }

        var featureSummary = nextState.FreeSpins is null
            ? null
            : new FeatureSummary(
                SpinsRemaining: nextState.FreeSpins.SpinsRemaining,
                TotalMultiplier: nextState.FreeSpins.TotalMultiplier,
                FeatureWin: nextState.FreeSpins.FeatureWin,
                TriggeredThisSpin: nextState.FreeSpins.JustTriggered);

        finalReelSymbols ??= board.GetReelSymbols();

        // Extract Megaways-specific data
        IReadOnlyList<int>? reelHeights = null;
        IReadOnlyList<string>? topReelSymbols = null;
        int? waysToWin = null;

        if (board is MegawaysReelBoard megawaysBoardResult)
        {
            // Reel heights should include top reel for covered columns (columns 1-4)
            var baseReelHeights = megawaysBoardResult.ReelHeights;
            var adjustedReelHeights = new List<int>(baseReelHeights);
            
            if (megawaysBoardResult.TopReel is not null && configuration.Megaways?.TopReel?.CoversReels is not null)
            {
                // Add +1 to reel heights for columns covered by top reel
                foreach (var coveredCol in configuration.Megaways.TopReel.CoversReels)
                {
                    if (coveredCol >= 0 && coveredCol < adjustedReelHeights.Count)
                    {
                        adjustedReelHeights[coveredCol] = adjustedReelHeights[coveredCol] + 1;
                    }
                }
            }
            
            reelHeights = adjustedReelHeights;
            waysToWin = megawaysBoardResult.CalculateWaysToWin();
            
            if (megawaysBoardResult.TopReel is not null && configuration.Megaways?.TopReel?.CoversReels is not null)
            {
                // CRITICAL FIX: Convert internal IDs (Sym1) to public Codes (FACE/BIRD)
                // This matches the format used by the main grid
                // Get the symbol for each covered column using GetSymbolForReel
                // This ensures we get the correct symbol based on the top reel's position
                var topReelCodes = new List<string>();
                foreach (var coveredCol in configuration.Megaways.TopReel.CoversReels)
                {
                    var symbolId = megawaysBoardResult.TopReel.GetSymbolForReel(coveredCol);
                    if (configuration.SymbolMap.TryGetValue(symbolId, out var def))
                    {
                        topReelCodes.Add(def.Code);
                    }
                    else
                    {
                        // Fallback: use symbolId as-is if not found in map
                        topReelCodes.Add(symbolId);
                    }
                }
                topReelSymbols = topReelCodes;
            }
        }

        // ===== BACKEND SYMBOL LOGGING =====
        // Log the final reel symbols so frontend can verify what should be displayed
        Console.WriteLine($"[SpinHandler] ===== FINAL REEL SYMBOLS (Backend Output) =====");
        
        if (finalReelSymbols != null)
        {
            Console.WriteLine($"[SpinHandler] ReelSymbols structure: {finalReelSymbols.Count} columns");
            
            if (reelHeights != null && reelHeights.Count > 0)
            {
                Console.WriteLine($"[SpinHandler] ReelHeights: [{string.Join(", ", reelHeights)}]");
                
                if (topReelSymbols != null)
                {
                    Console.WriteLine($"[SpinHandler] TopReelSymbols: [{string.Join(", ", topReelSymbols)}]");
                }
                
                // Log main reels (each column with its symbols)
                Console.WriteLine($"[SpinHandler] Main reels (rows 0 to reelHeight-1, bottom to top):");
                for (int col = 0; col < finalReelSymbols.Count && col < reelHeights.Count; col++)
                {
                    int reelHeight = reelHeights[col];
                    var reelSymbols = finalReelSymbols[col];
                    var symbolList = reelSymbols.Take(reelHeight).ToList();
                    Console.WriteLine($"[SpinHandler]   Reel {col} (height {reelHeight}): [{string.Join(", ", symbolList)}] (row 0=bottom, row {reelHeight-1}=top)");
                }
            }
            else
            {
                // Non-Megaways board
                Console.WriteLine($"[SpinHandler] ReelSymbols (all columns):");
                for (int col = 0; col < finalReelSymbols.Count; col++)
                {
                    var reelSymbols = finalReelSymbols[col];
                    Console.WriteLine($"[SpinHandler]   Reel {col}: [{string.Join(", ", reelSymbols)}]");
                }
            }
        }
        Console.WriteLine($"[SpinHandler] ================================================");

        Console.WriteLine($"[SpinHandler] Spin completed - TotalWin: {totalWin.Amount}, Cascades: {cascades.Count}, Wins: {wins.Count}");
        if (reelHeights != null)
        {
            Console.WriteLine($"[SpinHandler] Megaways - ReelHeights: [{string.Join(", ", reelHeights)}], WaysToWin: {waysToWin ?? 0}");
        }

        var response = new PlayResponse(
            StatusCode: 200,
            Win: totalWin,
            ScatterWin: scatterWin,
            FeatureWin: featureSummary?.FeatureWin ?? Money.Zero,
            BuyCost: buyCost,
            FreeSpinsAwarded: freeSpinsAwarded,
            RoundId: roundId,
            Timestamp: _timeService.UtcNow,
            NextState: nextState,
            Results: new ResultsEnvelope(
                Cascades: cascades,
                Wins: wins,
                Scatter: scatterOutcome,
                FreeSpins: featureSummary,
                RngTransactionId: roundId,
                ReelSymbols: finalReelSymbols,
                ReelHeights: reelHeights,
                TopReelSymbols: topReelSymbols,
                WaysToWin: waysToWin));

        _telemetry.Record(new SpinTelemetryEvent(
            GameId: request.GameId,
            BetMode: request.BetMode,
            SpinMode: spinMode,
            TotalBet: request.TotalBet.Amount + buyCost.Amount,
            TotalWin: totalWin.Amount,
            ScatterWin: scatterWin.Amount,
            FeatureWin: featureSummary?.FeatureWin.Amount ?? 0m,
            BuyCost: buyCost.Amount,
            Cascades: cascades.Count,
            TriggeredFreeSpins: freeSpinsAwarded > 0,
            FreeSpinMultiplier: nextState.FreeSpins?.TotalMultiplier ?? 0m,
            Timestamp: response.Timestamp));

        return response;
    }

    private static void ValidateRequest(PlayRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.GameId))
        {
            throw new ArgumentException("gameId is required.", nameof(request.GameId));
        }

        if (request.Bets is null || request.Bets.Count == 0)
        {
            throw new ArgumentException("At least one bet entry is required.", nameof(request.Bets));
        }

        if (request.EngineState is null)
        {
            throw new ArgumentException("Engine state is required.", nameof(request.EngineState));
        }

        if (request.TotalBet.Amount <= 0)
        {
            throw new ArgumentException("Total bet must be positive.", nameof(request.TotalBet));
        }
    }

    private IReadOnlyList<IReadOnlyList<string>> SelectReelStrips(
        GameConfiguration configuration,
        SpinMode mode,
        BetMode betMode)
    {
        return mode switch
        {
            SpinMode.FreeSpins => configuration.ReelLibrary.FreeSpins,
            SpinMode.BuyEntry => configuration.ReelLibrary.Buy,
            _ => SelectBaseReels(configuration, betMode)
        };
    }

    private IReadOnlyList<IReadOnlyList<string>> SelectBaseReels(GameConfiguration configuration, BetMode betMode)
    {
        var key = betMode == BetMode.Ante ? "ante" : "standard";
        if (!configuration.BetModes.TryGetValue(key, out var modeDefinition))
        {
            return configuration.ReelLibrary.High;
        }

        var lowWeight = Math.Max(0, modeDefinition.ReelWeights.Low);
        var highWeight = Math.Max(0, modeDefinition.ReelWeights.High);
        var total = lowWeight + highWeight;
        if (total <= 0)
        {
            return configuration.ReelLibrary.High;
        }

        var roll = _fortunaPrng.NextInt32(0, total);
        return roll < lowWeight ? configuration.ReelLibrary.Low : configuration.ReelLibrary.High;
    }

    private async Task<RandomContext> FetchRandomContext(
        GameConfiguration configuration,
        IReadOnlyList<IReadOnlyList<string>> reelStrips,
        PlayRequest request,
        string roundId,
        SpinMode spinMode,
        CancellationToken cancellationToken)
    {
        try
        {
            var maxRows = configuration.Board.MaxRows ?? configuration.Board.Rows;
            var multiplierSeedCount = configuration.Board.Megaways
                ? configuration.Board.Columns * maxRows
                : configuration.Board.Columns * configuration.Board.Rows;

            var pools = new List<PoolRequest>
            {
                new(
                    PoolId: "reel-starts",
                    DrawCount: reelStrips.Count,
                    Metadata: new Dictionary<string, object>
                    {
                        ["reelLengths"] = reelStrips.Select(strip => strip.Count).ToArray()
                    }),
                new(
                    PoolId: "multiplier-seeds",
                    DrawCount: multiplierSeedCount,
                    Metadata: new Dictionary<string, object>
                    {
                        ["multiplierValues"] = configuration.Multiplier.Values
                    })
            };

            if (configuration.Board.Megaways && configuration.Megaways is not null)
            {
                pools.Add(new(
                    PoolId: "reel-heights",
                    DrawCount: configuration.Board.Columns,
                    Metadata: new Dictionary<string, object>
                    {
                        ["reelHeightRanges"] = configuration.Megaways.ReelHeights.Select(rh => new { rh.Min, rh.Max }).ToArray()
                    }));

                if (configuration.Megaways.TopReel.Enabled)
                {
                    pools.Add(new(
                        PoolId: "top-reel-position",
                        DrawCount: 1,
                        Metadata: new Dictionary<string, object>
                        {
                            ["symbolCount"] = configuration.Megaways.TopReel.SymbolCount
                        }));
                    pools.Add(new(
                        PoolId: "top-reel-symbols",
                        DrawCount: configuration.Megaways.TopReel.SymbolCount,
                        Metadata: new Dictionary<string, object>()));
                }
            }

            var rngRequest = new JurisdictionPoolsRequest
            {
                GameId = request.GameId,
                RoundId = roundId,
                Pools = pools,
                TrackingData = new Dictionary<string, string>
                {
                    ["playerToken"] = request.PlayerToken,
                    ["mode"] = spinMode.ToString(),
                    ["betMode"] = request.BetMode.ToString()
                }
            };

            var response = await _rngClient.RequestPoolsAsync(rngRequest, cancellationToken).ConfigureAwait(false);
            var reelStartSeeds = ExtractIntegers(response, "reel-starts", reelStrips.Count);
            var multiplierSeeds = ExtractIntegers(response, "multiplier-seeds", multiplierSeedCount);

            IReadOnlyList<int>? reelHeights = null;
            int? topReelPosition = null;
            IReadOnlyList<int>? topReelSymbolSeeds = null;

            if (configuration.Board.Megaways && configuration.Megaways is not null)
            {
                var heightSeeds = ExtractIntegers(response, "reel-heights", configuration.Board.Columns);
                var rawHeights = GenerateReelHeights(configuration.Megaways.ReelHeights, heightSeeds, _fortunaPrng);
                reelHeights = configuration.Megaways.TopReel.Enabled
                    ? ClampReelHeightsForTopReel(rawHeights, configuration.Megaways.TopReel.CoversReels)
                    : rawHeights;

                if (configuration.Megaways.TopReel.Enabled)
                {
                    var topReelPosSeeds = ExtractIntegers(response, "top-reel-position", 1);
                    topReelPosition = Math.Abs(topReelPosSeeds[0]) % configuration.Megaways.TopReel.SymbolCount;
                    topReelSymbolSeeds = ExtractIntegers(response, "top-reel-symbols", configuration.Megaways.TopReel.SymbolCount);
                }
            }

            return RandomContext.FromSeeds(reelStartSeeds, multiplierSeeds, reelHeights, topReelPosition, topReelSymbolSeeds);
        }
        catch
        {
            var maxRows = configuration.Board.MaxRows ?? configuration.Board.Rows;
            var multiplierSeedCount = configuration.Board.Megaways
                ? configuration.Board.Columns * maxRows
                : configuration.Board.Columns * configuration.Board.Rows;
            return RandomContext.CreateFallback(reelStrips.Count, multiplierSeedCount, _fortunaPrng, configuration);
        }
    }

    private static IReadOnlyList<int> GenerateReelHeights(
        IReadOnlyList<ReelHeightRange> ranges,
        IReadOnlyList<int> seeds,
        FortunaPrng prng)
    {
        var heights = new List<int>(ranges.Count);
        for (var i = 0; i < ranges.Count; i++)
        {
            var range = ranges[i];
            var seed = i < seeds.Count ? seeds[i] : prng.NextInt32(0, int.MaxValue);
            var rangeSize = range.Max - range.Min + 1;
            var height = range.Min + (Math.Abs(seed) % rangeSize);
            heights.Add(height);
        }
        return heights;
    }

    /// <summary>Clamps main-grid reel heights for columns covered by the top reel to at most 7 (top reel is the 8th row for those columns).</summary>
    private static IReadOnlyList<int> ClampReelHeightsForTopReel(
        IReadOnlyList<int> heights,
        IReadOnlyList<int>? topReelCoversReels,
        int maxMainGridForCoveredReels = 7)
    {
        if (topReelCoversReels == null || topReelCoversReels.Count == 0) return heights;
        var list = new List<int>(heights);
        foreach (var col in topReelCoversReels)
        {
            if (col >= 0 && col < list.Count && list[col] > maxMainGridForCoveredReels)
                list[col] = maxMainGridForCoveredReels;
        }
        return list;
    }

    private static IReadOnlyList<int> ExtractIntegers(PoolsResponse response, string poolId, int expectedCount)
    {
        var pool = response.Pools.FirstOrDefault(p => string.Equals(p.PoolId, poolId, StringComparison.OrdinalIgnoreCase));
        if (pool == null)
        {
            return Enumerable.Repeat(0, expectedCount).ToArray();
        }

        var results = new List<int>(expectedCount);
        foreach (var result in pool.Results.Take(expectedCount))
        {
            if (int.TryParse(result, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
            {
                results.Add(value);
            }
        }

        while (results.Count < expectedCount)
        {
            results.Add(results.Count);
        }

        return results;
    }

    private decimal AssignMultiplierValue(
        SymbolDefinition definition,
        GameConfiguration configuration,
        BetMode betMode,
        SpinMode spinMode,
        FreeSpinState? freeSpinState,
        RandomContext randomContext)
    {
        // Handle MULTIPLIER symbols (existing behavior)
        if (definition.Type == SymbolType.Multiplier)
        {
            IReadOnlyList<MultiplierWeight> profile = configuration.MultiplierProfiles.Standard;

            if (spinMode == SpinMode.FreeSpins && freeSpinState is not null)
            {
                profile = freeSpinState.TotalMultiplier >= configuration.MultiplierProfiles.FreeSpinsSwitchThreshold
                    ? configuration.MultiplierProfiles.FreeSpinsLow
                    : configuration.MultiplierProfiles.FreeSpinsHigh;
            }
            else if (betMode == BetMode.Ante)
            {
                profile = configuration.MultiplierProfiles.Ante;
            }

            var seed = randomContext.TryDequeueMultiplierSeed(out var rngSeed)
                ? rngSeed
                : _fortunaPrng.NextInt32(0, int.MaxValue);

            return RollMultiplier(profile, seed);
        }
        
        // Handle WILD symbols during free spins (Buffalo King Megaways)
        if (definition.Type == SymbolType.Wild && spinMode == SpinMode.FreeSpins)
        {
            // Wild multipliers during free spins: 2x, 3x, or 5x
            // Use equal weights for simplicity (can be adjusted)
            var wildMultiplierValues = new[] { 2m, 3m, 5m };
            var seed = randomContext.TryDequeueMultiplierSeed(out var rngSeed)
                ? rngSeed
                : _fortunaPrng.NextInt32(0, int.MaxValue);
            var index = Math.Abs(seed) % wildMultiplierValues.Length;
            return wildMultiplierValues[index];
        }

        return 0m;
    }

    private List<decimal> CollectWildMultipliersFromWinningSymbols(
        ReelBoardBase board,
        IReadOnlyList<SymbolWin> symbolWins,
        GameConfiguration configuration)
    {
        var wildMultipliers = new List<decimal>();
        
        // Get all winning symbol codes (excluding Scatter, as Wilds can't substitute for Scatter)
        var winningCodes = symbolWins
            .Where(w => configuration.SymbolMap.TryGetValue(w.SymbolCode, out var def) && def.Type != SymbolType.Scatter)
            .Select(w => w.SymbolCode)
            .ToHashSet(StringComparer.Ordinal);
        
        // If no winning symbols (or only Scatter wins), no Wild multipliers to collect
        if (winningCodes.Count == 0)
        {
            return wildMultipliers;
        }
        
        // Collect Wild multipliers from reels 2-5 (indices 1-4) that could have substituted for winning symbols
        for (int reelIndex = 0; reelIndex < board.Columns.Count; reelIndex++)
        {
            // Wilds only appear on reels 2-5 (indices 1-4)
            if (reelIndex >= 1 && reelIndex <= 4)
            {
                var column = board.Columns[reelIndex];
                foreach (var symbolInstance in column.Symbols)
                {
                    // Check if this is a Wild symbol with a multiplier
                    if (symbolInstance.Definition.Type == SymbolType.Wild && symbolInstance.MultiplierValue > 0m)
                    {
                        // This Wild could have substituted for any of the winning symbols
                        wildMultipliers.Add(symbolInstance.MultiplierValue);
                    }
                }
            }
        }
        
        return wildMultipliers;
    }

    private decimal RollMultiplier(IReadOnlyList<MultiplierWeight> weights, int seed)
    {
        var total = weights.Sum(w => Math.Max(0, w.Weight));
        if (total <= 0)
        {
            return weights.Count > 0 ? weights[^1].Value : 0m;
        }

        var roll = Math.Abs(seed) % total;
        var cumulative = 0;
        foreach (var weight in weights)
        {
            cumulative += Math.Max(0, weight.Weight);
            if (roll < cumulative)
            {
                return weight.Value;
            }
        }

        return weights[^1].Value;
    }

    private static ScatterOutcome? ResolveScatterOutcome(ReelBoardBase board, GameConfiguration configuration, Money bet)
    {
        var scatterCount = board.CountSymbols(symbol => symbol.Type == SymbolType.Scatter);
        if (scatterCount == 0)
        {
            return null;
        }

        var reward = configuration.Scatter.Rewards
            .Where(r => scatterCount >= r.Count)
            .OrderByDescending(r => r.Count)
            .FirstOrDefault();

        if (reward is null)
        {
            return null;
        }

        var win = Money.FromBet(bet.Amount, reward.PayoutMultiplier);
        return new ScatterOutcome(scatterCount, win, reward.FreeSpinsAwarded);
    }

    private static void InitializeFreeSpins(GameConfiguration configuration, EngineSessionState state, int freeSpinsAwarded)
    {
        state.FreeSpins = new FreeSpinState
        {
            SpinsRemaining = freeSpinsAwarded,
            TotalSpinsAwarded = freeSpinsAwarded,
            TotalMultiplier = 0,
            FeatureWin = Money.Zero,
            JustTriggered = true
        };
    }

    private string CreateRoundId()
    {
        var randomSuffix = _fortunaPrng.NextInt32(0, int.MaxValue);
        return $"{_timeService.UnixMilliseconds:X}-{randomSuffix:X}";
    }

    private abstract class ReelBoardBase
    {
        protected readonly List<ReelColumn> _columns;

        protected ReelBoardBase(List<ReelColumn> columns)
        {
            _columns = columns;
        }

        public abstract bool NeedsRefill { get; }
        public abstract void Refill();
        public abstract List<string?> FlattenCodes();
        public abstract int CalculateWaysToWin();
        
        /// <summary>
        /// Gets reel symbols as a jagged array (columns x rows)
        /// </summary>
        public IReadOnlyList<IReadOnlyList<string>> GetReelSymbols()
        {
            return _columns.Select(column => 
                column.Symbols.Select(s => s.Definition.Code).ToList()
            ).ToList();
        }

        public decimal SumMultipliers() =>
            _columns.SelectMany(column => column.Symbols)
                .Where(instance => instance.Definition.Type == SymbolType.Multiplier)
                .Sum(instance => instance.MultiplierValue);

        public int CountSymbols(Func<SymbolDefinition, bool> predicate) =>
            _columns.SelectMany(column => column.Symbols)
                .Count(instance => predicate(instance.Definition));

        public void RemoveSymbols(ISet<string> targets)
        {
            foreach (var column in _columns)
            {
                column.RemoveWhere(symbol => targets.Contains(symbol.Definition.Code));
            }
        }

        /// <summary>Removes symbols only at the given (reel, row) positions. Position -1 = top reel (handled by MegawaysReelBoard if needed).</summary>
        public virtual void RemovePositions(IEnumerable<(int Reel, int Position)> positions)
        {
            var mainReelPositions = positions.Where(p => p.Position >= 0 && p.Reel >= 0 && p.Reel < _columns.Count);
            var byReel = mainReelPositions.GroupBy(p => p.Reel);
            foreach (var g in byReel)
            {
                var reelIndex = g.Key;
                var column = _columns[reelIndex];
                var rowsToRemove = g.Select(x => x.Position).Distinct().Where(r => r >= 0 && r < column.Symbols.Count).OrderByDescending(r => r).ToList();
                foreach (var row in rowsToRemove)
                {
                    column.Symbols.RemoveAt(row);
                }
            }
        }

        public void RemoveMultipliers()
        {
            foreach (var column in _columns)
            {
                column.RemoveWhere(symbol => symbol.Definition.Type == SymbolType.Multiplier);
            }
        }

        public IReadOnlyList<ReelColumn> Columns => _columns;
    }

    private sealed class ReelBoard : ReelBoardBase
    {
        private readonly int _rows;

        private ReelBoard(List<ReelColumn> columns, int rows) : base(columns)
        {
            _rows = rows;
        }

        public static ReelBoard Create(
            IReadOnlyList<IReadOnlyList<string>> reelStrips,
            IReadOnlyDictionary<string, SymbolDefinition> symbolMap,
            int rows,
            Func<SymbolDefinition, decimal> multiplierFactory,
            IReadOnlyList<int> reelStartSeeds,
            FortunaPrng prng)
        {
            if (reelStrips.Count == 0)
            {
                throw new InvalidOperationException("Reel strips are not configured.");
            }

            var columns = new List<ReelColumn>(reelStrips.Count);
            for (var columnIndex = 0; columnIndex < reelStrips.Count; columnIndex++)
            {
                var strip = reelStrips[columnIndex];
                if (strip.Count == 0)
                {
                    throw new InvalidOperationException($"Reel {columnIndex} is empty.");
                }

                var startIndex = reelStartSeeds is not null && columnIndex < reelStartSeeds.Count
                    ? Math.Abs(reelStartSeeds[columnIndex]) % strip.Count
                    : prng.NextInt32(0, strip.Count);
                columns.Add(new ReelColumn(strip, startIndex, rows, symbolMap, multiplierFactory));
            }

            return new ReelBoard(columns, rows);
        }

        public override bool NeedsRefill => _columns.Any(column => column.Count < _rows);

        public override void Refill()
        {
            foreach (var column in _columns)
            {
                column.Refill(_rows);
            }
        }

        public override List<string?> FlattenCodes()
        {
            var snapshot = new List<string?>(_columns.Count * _rows);

            for (var row = _rows - 1; row >= 0; row--)
            {
                foreach (var column in _columns)
                {
                    snapshot.Add(row < column.Count ? column[row].Definition.Code : null);
                }
            }

            return snapshot;
        }

        public override int CalculateWaysToWin()
        {
            // For non-Megaways, ways = columns (fixed height)
            return _columns.Count;
        }
    }

    private sealed class MegawaysReelBoard : ReelBoardBase
    {
        private readonly IReadOnlyList<int> _reelHeights;
        private readonly TopReel? _topReel;
        private readonly IReadOnlyList<int>? _topReelCoversReels;

        private MegawaysReelBoard(
            List<ReelColumn> columns,
            IReadOnlyList<int> reelHeights,
            TopReel? topReel,
            IReadOnlyList<int>? topReelCoversReels) : base(columns)
        {
            _reelHeights = reelHeights;
            _topReel = topReel;
            _topReelCoversReels = topReelCoversReels;
        }

        public IReadOnlyList<int> ReelHeights => _reelHeights;
        public TopReel? TopReel => _topReel;

        public static MegawaysReelBoard Create(
            IReadOnlyList<IReadOnlyList<string>> reelStrips,
            IReadOnlyDictionary<string, SymbolDefinition> symbolMap,
            IReadOnlyList<int> reelHeights,
            Func<SymbolDefinition, decimal> multiplierFactory,
            IReadOnlyList<int> reelStartSeeds,
            TopReel? topReel,
            IReadOnlyList<int>? topReelCoversReels,
            FortunaPrng prng)
        {
            if (reelStrips.Count == 0)
            {
                throw new InvalidOperationException("Reel strips are not configured.");
            }

            if (reelHeights.Count != reelStrips.Count)
            {
                throw new InvalidOperationException("Reel heights count must match reel strips count.");
            }

            var columns = new List<ReelColumn>(reelStrips.Count);
            for (var columnIndex = 0; columnIndex < reelStrips.Count; columnIndex++)
            {
                var strip = reelStrips[columnIndex];
                if (strip.Count == 0)
                {
                    throw new InvalidOperationException($"Reel {columnIndex} is empty.");
                }

                var height = reelHeights[columnIndex];
                var startIndex = reelStartSeeds is not null && columnIndex < reelStartSeeds.Count
                    ? Math.Abs(reelStartSeeds[columnIndex]) % strip.Count
                    : prng.NextInt32(0, strip.Count);
                columns.Add(new ReelColumn(strip, startIndex, height, symbolMap, multiplierFactory));
            }

            return new MegawaysReelBoard(columns, reelHeights, topReel, topReelCoversReels);
        }

        public override bool NeedsRefill
        {
            get
            {
                for (var i = 0; i < _columns.Count; i++)
                {
                    if (_columns[i].Count < _reelHeights[i])
                    {
                        return true;
                    }
                }
                return false;
            }
        }

        public override void Refill()
        {
            for (var i = 0; i < _columns.Count; i++)
            {
                _columns[i].Refill(_reelHeights[i]);
            }
        }

        public override List<string?> FlattenCodes()
        {
            var maxHeight = _reelHeights.Max();
            var snapshot = new List<string?>();

            // Row-major order: iterate from top to bottom (maxHeight to 0)
            // Top reel is at row maxHeight, then main reels below
            for (var row = maxHeight; row >= 0; row--)
            {
                for (var col = 0; col < _columns.Count; col++)
                {
                    var reelHeight = _reelHeights[col];
                    var hasTopReel = _topReel is not null && _topReelCoversReels is not null && _topReelCoversReels.Contains(col);

                    if (row == maxHeight && hasTopReel)
                    {
                        // Top reel symbol at topmost row
                        var topReelSymbol = _topReel!.GetSymbolForReel(col);
                        snapshot.Add(topReelSymbol);
                    }
                    else if (row < maxHeight)
                    {
                        // Main reel symbols
                        // For reels with top reel, row 0 is the top reel, so main symbols start at row 1
                        // For reels without top reel, main symbols start at row 0
                        var mainRow = hasTopReel ? row : row;
                        
                        if (mainRow < reelHeight && mainRow < _columns[col].Count)
                        {
                            snapshot.Add(_columns[col][mainRow].Definition.Code);
                        }
                        else
                        {
                            snapshot.Add(null);
                        }
                    }
                    else
                    {
                        snapshot.Add(null);
                    }
                }
            }

            return snapshot;
        }

        public override int CalculateWaysToWin()
        {
            var ways = 1;
            for (var i = 0; i < _columns.Count; i++)
            {
                var height = _reelHeights[i];
                if (_topReel is not null && _topReelCoversReels is not null && _topReelCoversReels.Contains(i))
                {
                    height++; // Include top reel symbol
                }
                ways *= height;
            }
            return ways;
        }

        public void RemoveTopReelSymbols(ISet<string> targets)
        {
            if (_topReel is not null)
            {
                _topReel.RemoveSymbols(targets);
            }
        }

        /// <summary>Replaces top reel symbols at the given reel indices with new symbols from the strip (for winning top-reel positions).</summary>
        public void ReplaceTopReelSymbolsAtReels(IReadOnlyList<int> reelIndices, IReadOnlyList<string> strip, FortunaPrng prng)
        {
            if (_topReel is not null && reelIndices.Count > 0)
            {
                _topReel.ReplaceSymbolsForReels(reelIndices, strip, prng);
            }
        }
    }

    private sealed class TopReel
    {
        private readonly List<string> _symbols;
        private int _position;
        private readonly IReadOnlyList<int> _coversReels;

        private TopReel(List<string> symbols, int position, IReadOnlyList<int> coversReels)
        {
            _symbols = symbols;
            _position = position;
            _coversReels = coversReels;
        }

        public IReadOnlyList<string> Symbols => _symbols;
        public int Position => _position;

        private int GetSymbolIndexForReel(int reelIndex)
        {
            var maxIndex = _coversReels.Max();
            var reelOffset = maxIndex - reelIndex;
            return (_position + reelOffset) % _symbols.Count;
        }

        public static TopReel Create(
            IReadOnlyList<IReadOnlyList<string>> reelStrips,
            IReadOnlyList<int> coversReels,
            int symbolCount,
            int position,
            IReadOnlyList<int>? symbolSeeds,
            FortunaPrng prng)
        {
            // Use first covered reel's strip for top reel symbols
            var strip = reelStrips[coversReels[0]];
            var symbols = new List<string>(symbolCount);

            for (var i = 0; i < symbolCount; i++)
            {
                var seed = symbolSeeds is not null && i < symbolSeeds.Count
                    ? symbolSeeds[i]
                    : prng.NextInt32(0, int.MaxValue);
                var index = Math.Abs(seed) % strip.Count;
                symbols.Add(strip[index]);
            }

            return new TopReel(symbols, position, coversReels);
        }

        public string GetSymbolForReel(int reelIndex)
        {
            if (!_coversReels.Contains(reelIndex))
            {
                throw new ArgumentException($"Reel {reelIndex} is not covered by top reel.", nameof(reelIndex));
            }

            // Right-to-left spin: position 0 is rightmost, increasing moves left
            // For reel at index i, we need symbol at position (position + (maxIndex - i)) % symbolCount
            var maxIndex = _coversReels.Max();
            var reelOffset = maxIndex - reelIndex;
            var symbolIndex = (_position + reelOffset) % _symbols.Count;
            return _symbols[symbolIndex];
        }

        public void Spin(int newPosition)
        {
            _position = newPosition;
        }

        /// <summary>Replaces top reel symbols at the given reel indices with new symbols drawn from the strip (used when those positions are winning and removed).</summary>
        public void ReplaceSymbolsForReels(IReadOnlyList<int> reelIndices, IReadOnlyList<string> strip, FortunaPrng prng)
        {
            if (strip.Count == 0) return;
            foreach (var reelIndex in reelIndices)
            {
                if (!_coversReels.Contains(reelIndex)) continue;
                var symbolIndex = GetSymbolIndexForReel(reelIndex);
                var oldSymbol = _symbols[symbolIndex];
                var newIndex = prng.NextInt32(0, strip.Count);
                var newSymbol = strip[newIndex];
                _symbols[symbolIndex] = newSymbol;
                Console.WriteLine($"[SpinHandler] TopReel replace reel={reelIndex} old={oldSymbol} new={newSymbol}");
            }
        }

        public void RemoveSymbols(ISet<string> targets)
        {
            // Top reel symbols are removed by ReplaceSymbolsForReels during cascade
        }
    }

    private sealed class ReelColumn
    {
        private readonly IReadOnlyList<string> _strip;
        private readonly IReadOnlyDictionary<string, SymbolDefinition> _symbolMap;
        private readonly Func<SymbolDefinition, decimal> _multiplierFactory;
        private int _nextIndex;

        public List<SymbolInstance> Symbols { get; }

        public ReelColumn(
            IReadOnlyList<string> strip,
            int startIndex,
            int rows,
            IReadOnlyDictionary<string, SymbolDefinition> symbolMap,
            Func<SymbolDefinition, decimal> multiplierFactory)
        {
            _strip = strip;
            _symbolMap = symbolMap;
            _multiplierFactory = multiplierFactory;
            _nextIndex = startIndex;
            Symbols = new List<SymbolInstance>(rows);

            for (var i = 0; i < rows; i++)
            {
                Symbols.Add(CreateInstance());
            }
        }

        public int Count => Symbols.Count;

        public SymbolInstance this[int index] => Symbols[index];

        public void Refill(int desiredRows)
        {
            while (Symbols.Count < desiredRows)
            {
                Symbols.Add(CreateInstance());
            }
        }

        public void RemoveWhere(Func<SymbolInstance, bool> predicate) =>
            Symbols.RemoveAll(instance => predicate(instance));

        private SymbolInstance CreateInstance()
        {
            var definition = ResolveSymbol(_strip[_nextIndex]);
            _nextIndex = (_nextIndex + 1) % _strip.Count;
            var multiplier = _multiplierFactory(definition);
            return new SymbolInstance(definition, multiplier);
        }

        private SymbolDefinition ResolveSymbol(string symCode)
        {
            if (!_symbolMap.TryGetValue(symCode, out var definition))
            {
                throw new InvalidOperationException($"Unknown symbol `{symCode}` on reel.");
            }

            return definition;
        }
    }

    private sealed record SymbolInstance(SymbolDefinition Definition, decimal MultiplierValue);

    private sealed class RandomContext
    {
        private readonly IReadOnlyList<int> _reelSeeds;
        private readonly Queue<int> _multiplierSeeds;
        private readonly IReadOnlyList<int>? _reelHeights;
        private readonly int? _topReelPosition;
        private readonly IReadOnlyList<int>? _topReelSymbolSeeds;

        private RandomContext(
            IReadOnlyList<int> reelSeeds, 
            Queue<int> multiplierSeeds,
            IReadOnlyList<int>? reelHeights = null,
            int? topReelPosition = null,
            IReadOnlyList<int>? topReelSymbolSeeds = null)
        {
            _reelSeeds = reelSeeds;
            _multiplierSeeds = multiplierSeeds;
            _reelHeights = reelHeights;
            _topReelPosition = topReelPosition;
            _topReelSymbolSeeds = topReelSymbolSeeds;
        }

        public IReadOnlyList<int> ReelStartSeeds => _reelSeeds;
        public IReadOnlyList<int>? ReelHeights => _reelHeights;
        public int? TopReelPosition => _topReelPosition;
        public IReadOnlyList<int>? TopReelSymbolSeeds => _topReelSymbolSeeds;

        public bool TryDequeueMultiplierSeed(out int seed)
        {
            if (_multiplierSeeds.Count > 0)
            {
                seed = _multiplierSeeds.Dequeue();
                return true;
            }

            seed = 0;
            return false;
        }

        public static RandomContext FromSeeds(
            IReadOnlyList<int> reelSeeds, 
            IReadOnlyList<int> multiplierSeeds,
            IReadOnlyList<int>? reelHeights = null,
            int? topReelPosition = null,
            IReadOnlyList<int>? topReelSymbolSeeds = null) =>
            new(reelSeeds, new Queue<int>(multiplierSeeds), reelHeights, topReelPosition, topReelSymbolSeeds);

        public static RandomContext CreateFallback(int reelCount, int multiplierSeedCount, FortunaPrng prng, GameConfiguration? configuration = null)
        {
            var reelSeeds = Enumerable.Range(0, reelCount)
                .Select(_ => prng.NextInt32(0, int.MaxValue))
                .ToArray();
            var multiplierSeeds = Enumerable.Range(0, multiplierSeedCount)
                .Select(_ => prng.NextInt32(0, int.MaxValue))
                .ToArray();

            IReadOnlyList<int>? reelHeights = null;
            int? topReelPosition = null;
            IReadOnlyList<int>? topReelSymbolSeeds = null;

            if (configuration?.Board.Megaways == true && configuration.Megaways is not null)
            {
                var heightSeeds = Enumerable.Range(0, configuration.Board.Columns)
                    .Select(_ => prng.NextInt32(0, int.MaxValue))
                    .ToArray();
                var rawHeights = GenerateReelHeights(configuration.Megaways.ReelHeights, heightSeeds, prng);
                reelHeights = configuration.Megaways.TopReel.Enabled
                    ? ClampReelHeightsForTopReel(rawHeights, configuration.Megaways.TopReel.CoversReels)
                    : rawHeights;

                if (configuration.Megaways.TopReel.Enabled)
                {
                    topReelPosition = prng.NextInt32(0, configuration.Megaways.TopReel.SymbolCount);
                    topReelSymbolSeeds = Enumerable.Range(0, configuration.Megaways.TopReel.SymbolCount)
                        .Select(_ => prng.NextInt32(0, int.MaxValue))
                        .ToArray();
                }
            }

            return FromSeeds(reelSeeds, multiplierSeeds, reelHeights, topReelPosition, topReelSymbolSeeds);
        }
    }
}

