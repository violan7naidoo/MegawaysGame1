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
        // TODO: Add explicit Wild symbol type support when available
        // For now, no Wild symbols are defined in the configuration

        foreach (var entry in configuration.Paytable)
        {
            var targetSymbol = entry.SymbolCode;
            
            // Check if symbol appears on Reel 0 (leftmost) - REQUIRED for win
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
                    
                    // Wilds on reels 2-5 (indices 2, 3, 4, 5) substitute for any symbol
                    if (reelIndex >= 2 && reelIndex <= 5)
                    {
                        // For now, we'll check if symbol is in wildSymbolCodes
                        // In a real implementation, you'd check symbolMap[symbol].Type == SymbolType.Wild
                        // For now, we'll skip wild logic since no Wild type exists
                        // isWild = symbolMap.ContainsKey(symbol) && symbolMap[symbol].Type == SymbolType.Wild;
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
                        
                        // Wilds on top reel (reels 2-5) substitute for any symbol
                        if (reelIndex >= 2 && reelIndex <= 5)
                        {
                            // TODO: Add wild check when Wild type is available
                            // topWild = symbolMap.ContainsKey(topSym) && symbolMap[topSym].Type == SymbolType.Wild;
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
            
            // Must have at least 2 contiguous reels starting from Reel 0
            if (contiguousReels < 2)
            {
                continue;
            }
            
            // Calculate ways: product of symbol counts on contiguous reels
            var ways = 1;
            for (var i = 0; i < contiguousReels; i++)
            {
                ways *= symbolsPerReel[i];
            }
            
            if (ways == 0)
            {
                continue;
            }
            
            // Total symbol count for paytable lookup
            var totalSymbolCount = symbolsPerReel.Take(contiguousReels).Sum();
            if (totalSymbolCount < 2)
            {
                continue;
            }
            
            // Find best matching paytable entry
            var bestMatch = entry.Multipliers
                .Where(mult => totalSymbolCount >= mult.Count)
                .OrderByDescending(mult => mult.Count)
                .FirstOrDefault();
            
            if (bestMatch is null)
            {
                continue;
            }
            
            // Payout calculation: base multiplier × ways
            // For Megaways, payout = bet × base_multiplier × ways
            var basePayout = Money.FromBet(bet.Amount, bestMatch.Multiplier);
            var payoutAmount = basePayout.Amount * ways;
            
            // Round and clamp to valid range
            payoutAmount = Math.Round(payoutAmount, 2, MidpointRounding.ToZero);
            if (payoutAmount > maxMoneyValue)
            {
                payoutAmount = maxMoneyValue;
            }
            var payout = new Money(payoutAmount);
            
            // Convert win positions to flat indices for compatibility (temporary)
            var allIndices = new List<int>();
            // Note: This is a simplified conversion - in reality, we'd need reel heights
            // For now, we'll leave indices empty or calculate based on reel structure
            // The frontend should use ReelSymbols structure instead
            
            wins.Add(new SymbolWin(
                entry.SymbolCode, 
                totalSymbolCount, 
                bestMatch.Multiplier, 
                payout, 
                allIndices.Count > 0 ? allIndices : null, 
                ways));
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

