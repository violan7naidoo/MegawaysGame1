using System.Linq;
using GameEngine.Play;
using GameEngineHost.Services;
using Microsoft.AspNetCore.Mvc;

namespace GameEngineHost.Controllers;

[ApiController]
[Route("play")]
public sealed class PlayController : ControllerBase
{
    private readonly IEngineClient _engineClient;

    public PlayController(IEngineClient engineClient)
    {
        _engineClient = engineClient;
    }

    [HttpPost]
    public async Task<ActionResult<PlayResponse>> Play([FromBody] PlayRequest request, CancellationToken cancellationToken)
    {
        Console.WriteLine($"[GameEngine] ===== PLAY REQUEST RECEIVED =====");
        Console.WriteLine($"[GameEngine] GameId: {request.GameId}");
        Console.WriteLine($"[GameEngine] BaseBet: {request.BaseBet.Amount}, TotalBet: {request.TotalBet.Amount}, BetMode: {request.BetMode}");
        Console.WriteLine($"[GameEngine] IsFeatureBuy: {request.IsFeatureBuy}");

        var response = await _engineClient.PlayAsync(request, cancellationToken);
        
        Console.WriteLine($"[GameEngine] ===== PLAY RESPONSE GENERATED =====");
        Console.WriteLine($"[GameEngine] RoundId: {response.RoundId}");
        Console.WriteLine($"[GameEngine] Win: {response.Win.Amount}, ScatterWin: {response.ScatterWin.Amount}, FeatureWin: {response.FeatureWin.Amount}");
        Console.WriteLine($"[GameEngine] FreeSpinsAwarded: {response.FreeSpinsAwarded}");
        Console.WriteLine($"[GameEngine] WaysToWin: {response.Results.WaysToWin ?? 0}");
        Console.WriteLine($"[GameEngine] ReelHeights: [{string.Join(", ", response.Results.ReelHeights ?? Array.Empty<int>())}]");
        
        // Log reel symbols being sent to frontend (jagged array structure)
        if (response.Results.ReelSymbols != null && response.Results.ReelSymbols.Count > 0)
        {
            Console.WriteLine($"[GameEngine] ReelSymbols count: {response.Results.ReelSymbols.Count} columns");
            
            if (response.Results.ReelHeights != null && response.Results.ReelHeights.Count > 0)
            {
                int columns = response.Results.ReelHeights.Count;
                Console.WriteLine($"[GameEngine] Expected frontend display:");
                
                // Top reel is separate - use TopReelSymbols array
                if (response.Results.TopReelSymbols != null)
                {
                    Console.WriteLine($"[GameEngine]   TOP REEL (columns 1-4): [{string.Join(", ", response.Results.TopReelSymbols)}]");
                    Console.WriteLine($"[GameEngine]     Note: Frontend should use TopReelSymbols array for top reel");
                }
                
                // Main reels use ReelSymbols jagged array
                for (int col = 0; col < columns && col < response.Results.ReelSymbols.Count; col++)
                {
                    var reelSymbols = response.Results.ReelSymbols[col];
                    int reelHeight = response.Results.ReelHeights[col];
                    
                    if (reelSymbols != null)
                    {
                        var symbolList = reelSymbols.Take(reelHeight).ToList();
                        Console.WriteLine($"[GameEngine]   Reel {col} (height {reelHeight}): [{string.Join(", ", symbolList)}] (row 0=bottom, row {reelHeight-1}=top)");
                    }
                    else
                    {
                        Console.WriteLine($"[GameEngine]   Reel {col} (height {reelHeight}): NULL");
                    }
                }
            }
            else
            {
                // Non-Megaways: log all columns
                for (int col = 0; col < response.Results.ReelSymbols.Count; col++)
                {
                    var reelSymbols = response.Results.ReelSymbols[col];
                    if (reelSymbols != null)
                    {
                        Console.WriteLine($"[GameEngine]   Reel {col}: [{string.Join(", ", reelSymbols)}]");
                    }
                }
            }
        }
        
        Console.WriteLine($"[GameEngine] ====================================");

        return Ok(response);
    }
}

