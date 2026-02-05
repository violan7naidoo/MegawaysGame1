using System;
using System.Collections.Generic;
using System.Linq;
using GameEngine.Configuration;

namespace GameEngine.Play;

public sealed class WinEvaluator
{
    public WinEvaluationResult Evaluate(IReadOnlyList<string> grid, GameConfiguration configuration, Money bet)
    {
        // Convert flat array to jagged array for Megaways
        if (configuration.Board.Megaways && configuration.Megaways is not null)
        {
            var columns = configuration.Board.Columns;
            var maxRows = configuration.Board.MaxRows ?? configuration.Board.Rows;
            var reelSymbols = new List<List<string>>();
            
            // Reconstruct jagged array from flat array (temporary - will be removed when SpinHandler passes jagged array)
            for (var col = 0; col < columns; col++)
            {
                var reel = new List<string>();
                for (var row = 0; row < maxRows; row++)
                {
                    var index = row * columns + col;
                    if (index < grid.Count && grid[index] != null)
                    {
                        reel.Add(grid[index]);
                    }
                }
                reelSymbols.Add(reel);
            }
            
            return EvaluateMegaways(reelSymbols, null, configuration, bet);
        }

        return EvaluateTraditional(grid, configuration, bet);
    }
    
    /// <summary>
    /// Evaluates wins for Megaways games using jagged array structure
    /// </summary>
    public WinEvaluationResult EvaluateMegaways(IReadOnlyList<IReadOnlyList<string>> reelSymbols, IReadOnlyList<string>? topReelSymbols, GameConfiguration configuration, Money bet)
    {
        return EvaluateMegawaysInternal(reelSymbols, topReelSymbols, configuration, bet);
    }

    private WinEvaluationResult EvaluateTraditional(IReadOnlyList<string> grid, GameConfiguration configuration, Money bet)
    {
        var wins = new List<SymbolWin>();
        var totalWin = 0m;

        foreach (var entry in configuration.Paytable)
        {
            var indices = new List<int>();
            for (var i = 0; i < grid.Count; i++)
            {
                if (grid[i] == entry.SymbolCode)
                {
                    indices.Add(i);
                }
            }

            var symbolCount = indices.Count;
            if (symbolCount < 8)
            {
                continue;
            }

            var bestMatch = entry.Multipliers
                .Where(mult => symbolCount >= mult.Count)
                .OrderByDescending(mult => mult.Count)
                .FirstOrDefault();

            if (bestMatch is null)
            {
                continue;
            }

            var payout = Money.FromBet(bet.Amount, bestMatch.Multiplier);
            wins.Add(new SymbolWin(entry.SymbolCode, symbolCount, bestMatch.Multiplier, payout, indices));
            totalWin += payout.Amount;
        }

        return new WinEvaluationResult(new Money(totalWin), wins);
    }

    private WinEvaluationResult EvaluateMegawaysInternal(IReadOnlyList<IReadOnlyList<string>> reelSymbols, IReadOnlyList<string>? topReelSymbols, GameConfiguration configuration, Money bet)
    {
        var wins = new List<SymbolWin>();
        var totalWin = 0m;
        var columns = reelSymbols.Count;
        // Maximum value for Money type (decimal(20,2))
        const decimal maxMoneyValue = 999999999999999999.99m;
        
        // Build symbol map for quick lookup
        var symbolMap = configuration.SymbolMap;

        foreach (var entry in configuration.Paytable)
        {
            var targetSymbol = entry.SymbolCode;
            
            // Check if symbol appears on Reel 0 (leftmost) - REQUIRED for win
            // Wilds don't appear on reel 0 (reel 1), so the target symbol must appear directly
            if (reelSymbols[0].Count == 0 || !reelSymbols[0].Contains(targetSymbol))
            {
                continue; // Must start from Reel 0
            }
            
            // Count symbols per reel, checking adjacent reels left-to-right
            var symbolsPerReel = new List<int>(columns);
            var allWinPositions = new List<(int Reel, int Position)>();
            var contiguousReels = 0;
            
            for (var reelIndex = 0; reelIndex < columns; reelIndex++)
            {
                var reel = reelSymbols[reelIndex];
                var symbolCount = 0;
                var reelPositions = new List<int>();
                
                // A. Count matching symbols in Main Reel
                for (var pos = 0; pos < reel.Count; pos++)
                {
                    var symbol = reel[pos];
                    
                    // Check if symbol matches target, or if it's a wild (on reels 2-5)
                    bool isMatch = symbol == targetSymbol;
                    bool isWild = false;
                    
                    // Wilds on reels 2-5 (indices 1-4, which are reels 2-5) substitute for any symbol except Scatter
                    if (reelIndex >= 1 && reelIndex <= 4)
                    {
                        // Check if symbol is a Wild type (wilds substitute for all except Scatter)
                        if (symbolMap.ContainsKey(symbol))
                        {
                            var symbolDef = symbolMap[symbol];
                            if (symbolDef.Type == SymbolType.Wild)
                            {
                                // Wilds substitute for all symbols except Scatter
                                if (symbolMap.ContainsKey(targetSymbol) && symbolMap[targetSymbol].Type != SymbolType.Scatter)
                                {
                                    isWild = true;
                                }
                            }
                        }
                    }
                    
                    if (isMatch || isWild)
                    {
                        symbolCount++;
                        reelPositions.Add(pos);
                        allWinPositions.Add((reelIndex, pos));
                    }
                }
                
                // B. Count in Top Reel (if enabled and this column is covered)
                if (configuration.Megaways?.TopReel?.Enabled == true && 
                    topReelSymbols != null && 
                    topReelSymbols.Count > 0 &&
                    configuration.Megaways.TopReel.CoversReels.Contains(reelIndex))
                {
                    // Map column index to top reel index
                    // Top reel typically covers cols 1, 2, 3, 4 (0-indexed: 1, 2, 3, 4)
                    // topReelSymbols array is 0-3 corresponding to cols 1-4
                    var coversReels = configuration.Megaways.TopReel.CoversReels;
                    int topIndex = -1;
                    for (int i = 0; i < coversReels.Count; i++)
                    {
                        if (coversReels[i] == reelIndex)
                        {
                            topIndex = i;
                            break;
                        }
                    }
                    
                    if (topIndex >= 0 && topIndex < topReelSymbols.Count)
                    {
                        var topSym = topReelSymbols[topIndex];
                        // Check if top reel symbol matches target or is wild
                        bool topMatch = topSym == targetSymbol;
                        bool topWild = false;
                        
                        // Wilds on top reel (reels 2-5, indices 1-4) substitute for any symbol except Scatter
                        if (reelIndex >= 1 && reelIndex <= 4)
                        {
                            if (symbolMap.ContainsKey(topSym))
                            {
                                var symbolDef = symbolMap[topSym];
                                if (symbolDef.Type == SymbolType.Wild)
                                {
                                    // Wilds substitute for all symbols except Scatter
                                    if (symbolMap.ContainsKey(targetSymbol) && symbolMap[targetSymbol].Type != SymbolType.Scatter)
                                    {
                                        topWild = true;
                                    }
                                }
                            }
                        }
                        
                        if (topMatch || topWild)
                        {
                            symbolCount++;
                            // Top reel position is considered at the "top" of the reel
                            allWinPositions.Add((reelIndex, -1)); // Use -1 to indicate top reel position
                        }
                    }
                }
                
                symbolsPerReel.Add(symbolCount);
                
                // Check if this reel has symbols (required for contiguous win)
                if (symbolCount > 0)
                {
                    contiguousReels++;
                }
                else
                {
                    // If we hit a reel with no symbols, stop checking (must be contiguous)
                    break;
                }
            }
            
            // CRITICAL: Ways to Win (Buffalo King Megaways style)
            // Minimum requirements: All symbols require at least 2 contiguous reels (left to right adjacent)
            var minContiguousReels = 2;
            if (contiguousReels < minContiguousReels)
            {
                continue;
            }
            
            // Calculate ways: product of symbol counts on contiguous reels
            // Example: Reel0(1) × Reel1(2) × Reel2(1) = 2 Ways
            var ways = 1;
            for (var i = 0; i < contiguousReels; i++)
            {
                ways *= symbolsPerReel[i];
            }
            
            if (ways == 0)
            {
                continue;
            }
            
            // CRITICAL: Paytable lookup now uses number of consecutive reels, not total symbols
            // entry.Multipliers.Count now represents "Number of Reels" (e.g., Count 3 = 3 reels)
            // Find best matching paytable entry based on contiguous reels
            var bestMatch = entry.Multipliers
                .Where(mult => contiguousReels >= mult.Count)
                .OrderByDescending(mult => mult.Count)
                .FirstOrDefault();
            
            if (bestMatch is null)
            {
                continue;
            }
            
            // Payout calculation: Bet × SymbolValue(for N reels) × Ways
            // Formula: Total Win = Bet * SymbolValue(for N reels) * Ways
            var basePayout = Money.FromBet(bet.Amount, bestMatch.Multiplier);
            var payoutAmount = basePayout.Amount * ways;
            
            // Round and clamp to valid range
            payoutAmount = Math.Round(payoutAmount, 2, MidpointRounding.ToZero);
            if (payoutAmount > maxMoneyValue)
            {
                payoutAmount = maxMoneyValue;
            }
            var payout = new Money(payoutAmount);
            
            // Only positions on contiguous reels (allWinPositions is built until first empty reel, so already correct)
            var winningPositionsList = allWinPositions
                .Select(p => new WinningPosition(p.Reel, p.Position))
                .ToList();
            
            var totalSymbolCount = symbolsPerReel.Take(contiguousReels).Sum();
            
            wins.Add(new SymbolWin(
                entry.SymbolCode, 
                totalSymbolCount, 
                bestMatch.Multiplier, 
                payout, 
                Indices: null, 
                ways,
                winningPositionsList.Count > 0 ? winningPositionsList : null));
            totalWin += payout.Amount;
        }
        
        // Ensure totalWin doesn't exceed Money's limits
        totalWin = Math.Round(totalWin, 2, MidpointRounding.ToZero);
        if (totalWin > maxMoneyValue)
        {
            totalWin = maxMoneyValue;
        }
        
        return new WinEvaluationResult(new Money(totalWin), wins);
    }
}

public sealed record WinEvaluationResult(Money TotalWin, IReadOnlyList<SymbolWin> SymbolWins);

