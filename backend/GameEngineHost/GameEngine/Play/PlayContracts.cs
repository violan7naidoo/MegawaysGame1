using System.Collections.Generic;
using System.Text.Json;
using GameEngine.Configuration;

namespace GameEngine.Play;

public sealed record PlayRequest(
    string GameId,
    string PlayerToken,
    IReadOnlyList<BetRequest> Bets,
    Money BaseBet,
    Money TotalBet,
    BetMode BetMode,
    bool IsFeatureBuy,
    EngineSessionState EngineState,
    JsonElement? UserPayload,
    JsonElement? LastResponse,
    int? RtpLevel = null,
    int? Mode = null,
    JsonElement? Currency = null);

public sealed record BetRequest(string BetType, Money Amount);

public sealed record PlayResponse(
    int StatusCode,
    Money Win,
    Money ScatterWin,
    Money FeatureWin,
    Money BuyCost,
    int FreeSpinsAwarded,
    string RoundId,
    DateTimeOffset Timestamp,
    EngineSessionState NextState,
    ResultsEnvelope Results);

public sealed record ResultsEnvelope(
    IReadOnlyList<CascadeStep> Cascades,
    IReadOnlyList<SymbolWin> Wins,
    ScatterOutcome? Scatter,
    FeatureSummary? FreeSpins,
    string RngTransactionId,
    IReadOnlyList<IReadOnlyList<string>>? ReelSymbols,
    IReadOnlyList<int>? ReelHeights = null,
    IReadOnlyList<string>? TopReelSymbols = null,
    int? WaysToWin = null);

public sealed record CascadeStep(
    int Index,
    IReadOnlyList<IReadOnlyList<string>> ReelSymbolsBefore,
    IReadOnlyList<IReadOnlyList<string>> ReelSymbolsAfter,
    IReadOnlyList<SymbolWin> WinsAfterCascade,
    Money BaseWin,
    decimal AppliedMultiplier,
    Money TotalWin,
    IReadOnlyList<string>? TopReelSymbolsBefore = null,
    IReadOnlyList<string>? TopReelSymbolsAfter = null);

/// <summary>Position of a winning symbol: Reel = column index (0-based), Position = row index (0 = bottom). Use -1 for top reel.</summary>
public sealed record WinningPosition(int Reel, int Position);

public sealed record SymbolWin(
    string SymbolCode,
    int Count,
    decimal Multiplier,
    Money Payout,
    IReadOnlyList<int>? Indices = null,
    int? WaysToWin = null,
    IReadOnlyList<WinningPosition>? WinningPositions = null);

public sealed record ScatterOutcome(int SymbolCount, Money Win, int FreeSpinsAwarded);

public sealed record FeatureSummary(int SpinsRemaining, decimal TotalMultiplier, Money FeatureWin, bool TriggeredThisSpin);

public enum BetMode
{
    Standard,
    Ante
}

