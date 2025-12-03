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
    
    // PRESENTATION MODE: Preset spin sequence (loops 0-19)
    private static int _presetSpinIndex = 0;
    private static readonly object _presetSpinLock = new object();

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
            
            // Evaluate wins using jagged array structure, including top reel symbols
            var evaluation = _winEvaluator.EvaluateMegaways(reelSymbolsBefore, topReelSymbolsForEval, configuration, request.TotalBet);

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

            var multiplierSum = board.SumMultipliers();
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
                if (multiplierSum > 0m)
                {
                    nextState.FreeSpins.TotalMultiplier += multiplierSum;
                }

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

            var winningCodes = evaluation.SymbolWins
                .Select(win => win.SymbolCode)
                .ToHashSet(StringComparer.Ordinal);

            board.RemoveSymbols(winningCodes);
            if (board is MegawaysReelBoard megawaysBoard)
            {
                megawaysBoard.RemoveTopReelSymbols(winningCodes);
            }
            board.RemoveMultipliers();

            if (board.NeedsRefill)
            {
                board.Refill();
            }

            var reelSymbolsAfter = board.GetReelSymbols();

            cascades.Add(new CascadeStep(
                Index: cascadeIndex++,
                ReelSymbolsBefore: reelSymbolsBefore,
                ReelSymbolsAfter: reelSymbolsAfter,
                WinsAfterCascade: evaluation.SymbolWins,
                BaseWin: cascadeBaseWin,
                AppliedMultiplier: appliedMultiplier,
                TotalWin: cascadeFinalWin));
        }

        var scatterOutcome = ResolveScatterOutcome(board, configuration, request.TotalBet);
        if (scatterOutcome is not null)
        {
            scatterWin = scatterOutcome.Win;
            totalWin += scatterWin;

            if ((spinMode == SpinMode.BaseGame || spinMode == SpinMode.BuyEntry) && scatterOutcome.FreeSpinsAwarded > 0)
            {
                InitializeFreeSpins(configuration, nextState);
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

    // PRESENTATION MODE: Get preset random context (loops through 20 predefined spins)
    private RandomContext GetPresetRandomContext(GameConfiguration configuration, int reelCount, int multiplierSeedCount)
    {
        // 20 predefined spin results for demo presentation
        // Format: (ReelHeights, ReelStartSeeds, TopReelPosition, TopReelSymbolSeeds, ExpectedCascades)
        var presets = new[]
        {
            // Spin 0: No win
            (ReelHeights: new[] { 5, 3, 4, 5, 6, 2 }, ReelSeeds: new[] { 12345, 23456, 34567, 45678, 56789, 67890 }, TopReelPos: 0, TopReelSeeds: new[] { 111, 222, 333, 444 }),
            // Spin 1: Single win, 1 cascade
            (ReelHeights: new[] { 7, 3, 3, 7, 5, 3 }, ReelSeeds: new[] { 11234, 22345, 33456, 44567, 55678, 66789 }, TopReelPos: 1, TopReelSeeds: new[] { 555, 666, 777, 888 }),
            // Spin 2: Multiple wins, 3 cascades
            (ReelHeights: new[] { 4, 5, 5, 6, 3, 2 }, ReelSeeds: new[] { 10000, 20000, 30000, 40000, 50000, 60000 }, TopReelPos: 2, TopReelSeeds: new[] { 100, 200, 300, 400 }),
            // Spin 3: No win
            (ReelHeights: new[] { 6, 4, 4, 5, 4, 3 }, ReelSeeds: new[] { 15000, 25000, 35000, 45000, 55000, 65000 }, TopReelPos: 0, TopReelSeeds: new[] { 150, 250, 350, 450 }),
            // Spin 4: Single win, 1 cascade
            (ReelHeights: new[] { 3, 6, 5, 4, 5, 4 }, ReelSeeds: new[] { 17000, 27000, 37000, 47000, 57000, 67000 }, TopReelPos: 1, TopReelSeeds: new[] { 170, 270, 370, 470 }),
            // Spin 5: Multiple wins, 4 cascades
            (ReelHeights: new[] { 5, 5, 6, 4, 6, 3 }, ReelSeeds: new[] { 18000, 28000, 38000, 48000, 58000, 68000 }, TopReelPos: 2, TopReelSeeds: new[] { 180, 280, 380, 480 }),
            // Spin 6: No win
            (ReelHeights: new[] { 4, 4, 4, 4, 4, 4 }, ReelSeeds: new[] { 19000, 29000, 39000, 49000, 59000, 69000 }, TopReelPos: 3, TopReelSeeds: new[] { 190, 290, 390, 490 }),
            // Spin 7: Single win, 1 cascade
            (ReelHeights: new[] { 6, 3, 5, 5, 3, 5 }, ReelSeeds: new[] { 20000, 30000, 40000, 50000, 60000, 70000 }, TopReelPos: 0, TopReelSeeds: new[] { 200, 300, 400, 500 }),
            // Spin 8: Multiple wins, 3 cascades
            (ReelHeights: new[] { 5, 6, 4, 6, 5, 4 }, ReelSeeds: new[] { 21000, 31000, 41000, 51000, 61000, 71000 }, TopReelPos: 1, TopReelSeeds: new[] { 210, 310, 410, 510 }),
            // Spin 9: No win
            (ReelHeights: new[] { 3, 5, 6, 3, 6, 5 }, ReelSeeds: new[] { 22000, 32000, 42000, 52000, 62000, 72000 }, TopReelPos: 2, TopReelSeeds: new[] { 220, 320, 420, 520 }),
            // Spin 10: Single win, 1 cascade
            (ReelHeights: new[] { 7, 4, 3, 7, 4, 3 }, ReelSeeds: new[] { 23000, 33000, 43000, 53000, 63000, 73000 }, TopReelPos: 0, TopReelSeeds: new[] { 230, 330, 430, 530 }),
            // Spin 11: Multiple wins, 4 cascades
            (ReelHeights: new[] { 4, 7, 5, 4, 7, 2 }, ReelSeeds: new[] { 24000, 34000, 44000, 54000, 64000, 74000 }, TopReelPos: 1, TopReelSeeds: new[] { 240, 340, 440, 540 }),
            // Spin 12: No win
            (ReelHeights: new[] { 6, 5, 4, 5, 4, 6 }, ReelSeeds: new[] { 25000, 35000, 45000, 55000, 65000, 75000 }, TopReelPos: 2, TopReelSeeds: new[] { 250, 350, 450, 550 }),
            // Spin 13: Single win, 1 cascade
            (ReelHeights: new[] { 5, 4, 6, 3, 5, 4 }, ReelSeeds: new[] { 26000, 36000, 46000, 56000, 66000, 76000 }, TopReelPos: 3, TopReelSeeds: new[] { 260, 360, 460, 560 }),
            // Spin 14: Multiple wins, 3 cascades
            (ReelHeights: new[] { 3, 6, 6, 4, 6, 3 }, ReelSeeds: new[] { 27000, 37000, 47000, 57000, 67000, 77000 }, TopReelPos: 0, TopReelSeeds: new[] { 270, 370, 470, 570 }),
            // Spin 15: No win
            (ReelHeights: new[] { 7, 3, 5, 6, 3, 5 }, ReelSeeds: new[] { 28000, 38000, 48000, 58000, 68000, 78000 }, TopReelPos: 1, TopReelSeeds: new[] { 280, 380, 480, 580 }),
            // Spin 16: Single win, 1 cascade
            (ReelHeights: new[] { 4, 5, 4, 7, 5, 4 }, ReelSeeds: new[] { 29000, 39000, 49000, 59000, 69000, 79000 }, TopReelPos: 2, TopReelSeeds: new[] { 290, 390, 490, 590 }),
            // Spin 17: Multiple wins, 4 cascades
            (ReelHeights: new[] { 6, 4, 7, 3, 6, 2 }, ReelSeeds: new[] { 30000, 40000, 50000, 60000, 70000, 80000 }, TopReelPos: 0, TopReelSeeds: new[] { 300, 400, 500, 600 }),
            // Spin 18: No win
            (ReelHeights: new[] { 5, 6, 3, 5, 4, 6 }, ReelSeeds: new[] { 31000, 41000, 51000, 61000, 71000, 81000 }, TopReelPos: 1, TopReelSeeds: new[] { 310, 410, 510, 610 }),
            // Spin 19: Single win, 1 cascade
            (ReelHeights: new[] { 4, 4, 6, 4, 5, 3 }, ReelSeeds: new[] { 32000, 42000, 52000, 62000, 72000, 82000 }, TopReelPos: 2, TopReelSeeds: new[] { 320, 420, 520, 620 })
        };

        int currentIndex;
        lock (_presetSpinLock)
        {
            currentIndex = _presetSpinIndex;
            _presetSpinIndex = (_presetSpinIndex + 1) % presets.Length; // Loop 0-19
        }

        var preset = presets[currentIndex];
        Console.WriteLine($"[SpinHandler] PRESENTATION MODE: Using preset spin #{currentIndex}");

        // Generate multiplier seeds
        var multiplierSeeds = Enumerable.Range(0, multiplierSeedCount)
            .Select(i => preset.ReelSeeds[i % preset.ReelSeeds.Length] + i * 1000)
            .ToArray();

        IReadOnlyList<int>? reelHeights = null;
        int? topReelPosition = null;
        IReadOnlyList<int>? topReelSymbolSeeds = null;

        if (configuration.Board.Megaways == true && configuration.Megaways is not null)
        {
            reelHeights = preset.ReelHeights;
            
            if (configuration.Megaways.TopReel.Enabled)
            {
                topReelPosition = preset.TopReelPos;
                topReelSymbolSeeds = preset.TopReelSeeds;
            }
        }

        return RandomContext.FromSeeds(
            preset.ReelSeeds,
            multiplierSeeds,
            reelHeights,
            topReelPosition,
            topReelSymbolSeeds);
    }

    private Task<RandomContext> FetchRandomContext(
        GameConfiguration configuration,
        IReadOnlyList<IReadOnlyList<string>> reelStrips,
        PlayRequest request,
        string roundId,
        SpinMode spinMode,
        CancellationToken cancellationToken)
    {
        // PRESENTATION MODE: Use preset sequence instead of RNG
        var maxRows = configuration.Board.MaxRows ?? configuration.Board.Rows;
        var multiplierSeedCount = configuration.Board.Megaways 
            ? configuration.Board.Columns * maxRows 
            : configuration.Board.Columns * configuration.Board.Rows;
        
        return Task.FromResult(GetPresetRandomContext(configuration, reelStrips.Count, multiplierSeedCount));
        
        /* ORIGINAL RNG CODE - COMMENTED OUT FOR PRESENTATION MODE
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

            // Add Megaways-specific pools
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
                reelHeights = GenerateReelHeights(configuration.Megaways.ReelHeights, heightSeeds, _fortunaPrng);

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
        */
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
        if (definition.Type != SymbolType.Multiplier)
        {
            return 0m;
        }

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

    private static void InitializeFreeSpins(GameConfiguration configuration, EngineSessionState state)
    {
        state.FreeSpins = new FreeSpinState
        {
            SpinsRemaining = configuration.FreeSpins.InitialSpins,
            TotalSpinsAwarded = configuration.FreeSpins.InitialSpins,
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
    }

    private sealed class TopReel
    {
        private readonly IReadOnlyList<string> _symbols;
        private int _position;
        private readonly IReadOnlyList<int> _coversReels;

        private TopReel(IReadOnlyList<string> symbols, int position, IReadOnlyList<int> coversReels)
        {
            _symbols = symbols;
            _position = position;
            _coversReels = coversReels;
        }

        public IReadOnlyList<string> Symbols => _symbols;
        public int Position => _position;

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

        public void RemoveSymbols(ISet<string> targets)
        {
            // Top reel symbols are removed by replacing them
            // This will be handled during cascade refill
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
                reelHeights = GenerateReelHeights(configuration.Megaways.ReelHeights, heightSeeds, prng);

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

