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
    JsonElement? LastResponse);

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
    Money TotalWin);

public sealed record SymbolWin(
    string SymbolCode,
    int Count,
    decimal Multiplier,
    Money Payout,
    IReadOnlyList<int>? Indices = null,
    int? WaysToWin = null);

public sealed record ScatterOutcome(int SymbolCount, Money Win, int FreeSpinsAwarded);

public sealed record FeatureSummary(int SpinsRemaining, decimal TotalMultiplier, Money FeatureWin, bool TriggeredThisSpin);

public enum BetMode
{
    Standard,
    Ante
}

