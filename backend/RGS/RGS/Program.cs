using System.Globalization;
using System.Linq;
using System.Text.Json;
using GameEngine.Configuration;
using GameEngine.Play;
using GameEngine.Services;
using Microsoft.AspNetCore.Http.Json;
using RGS.Contracts;
using RGS.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        policy
            .SetIsOriginAllowed(_ => true)
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

builder.Services.AddSingleton<SessionManager>();
builder.Services.AddSingleton<ITimeService, TimeService>();
builder.Services.Configure<JsonOptions>(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.Converters.Add(new MoneyJsonConverter());
});

var engineBaseUrl = builder.Configuration["Engine:BaseUrl"] ?? "http://localhost:5101";
builder.Services.AddHttpClient<IEngineClient, EngineHttpClient>(client =>
{
    client.BaseAddress = new Uri(engineBaseUrl);
});

var app = builder.Build();
var logger = app.Logger;

app.UseExceptionHandler();
app.UseHttpsRedirection();
app.UseSwagger();
app.UseSwaggerUI();

app.UseCors("AllowFrontend");

app.MapPost("/{operatorId}/{gameId}/start",
        (string operatorId,
            string gameId,
            StartRequest request,
            SessionManager sessions,
            ITimeService timeService) =>
        {
            if (request is null)
            {
                return Results.BadRequest("Request payload is required.");
            }

            var funMode = request.FunMode == 1;
            if (!funMode && string.IsNullOrWhiteSpace(request.PlayerToken))
            {
                return Results.BadRequest("playerToken is required when funMode=0.");
            }

            var session = sessions.CreateSession(operatorId, gameId, request.PlayerToken ?? string.Empty, funMode);
            var timestamp = timeService.UtcNow;

            var response = new StartResponse(
                SessionId: session.SessionId,
                GameId: gameId,
                OperatorId: operatorId,
                FunMode: request.FunMode,
                CreatedAt: timestamp,
                TimeSignature: timeService.UnixMilliseconds.ToString(CultureInfo.InvariantCulture),
                ThemeId: gameId);

            return Results.Ok(response);
        })
    .WithName("StartGame");

app.MapPost("/{gameId}/play",
        async (string gameId,
            ClientPlayRequest request,
            SessionManager sessions,
            IEngineClient engineClient,
            CancellationToken cancellationToken) =>
        {
            if (request is null)
            {
                return Results.BadRequest("Request payload is required.");
            }

            if (!sessions.TryGetSession(request.SessionId, out var session))
            {
                return Results.Unauthorized();
            }

            if (!string.Equals(session.GameId, gameId, StringComparison.OrdinalIgnoreCase))
            {
                return Results.BadRequest("Session does not match game.");
            }

            if (!TryParseBetMode(request.BetMode, out var betMode))
            {
                return Results.BadRequest("Unknown betMode.");
            }

            if (request.Bets is null || request.Bets.Count == 0)
            {
                return Results.BadRequest("bets array is required.");
            }

            Money baseBet;
            try
            {
                baseBet = new Money(request.BaseBet);
            }
            catch (Exception ex)
            {
                return Results.BadRequest($"Invalid baseBet value: {ex.Message}");
            }

            var totalBet = CalculateTotalBet(baseBet, betMode);

            if (totalBet.Amount <= 0)
            {
                return Results.BadRequest("Total bet must be positive.");
            }

            List<BetRequest> betRequests;
            try
            {
                betRequests = ConvertBetRequests(request.Bets);
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(ex.Message);
            }

            var engineRequest = new PlayRequest(
                GameId: gameId,
                PlayerToken: session.PlayerToken,
                Bets: betRequests,
                BaseBet: baseBet,
                TotalBet: totalBet,
                BetMode: betMode,
                IsFeatureBuy: false,
                EngineState: session.State ?? EngineSessionState.Create(),
                UserPayload: request.UserPayload,
                LastResponse: request.LastResponse);

            Console.WriteLine($"[RGS] ===== PLAY REQUEST RECEIVED =====");
            Console.WriteLine($"[RGS] GameId: {gameId}, SessionId: {request.SessionId}");
            Console.WriteLine($"[RGS] BaseBet: {baseBet.Amount}, TotalBet: {totalBet.Amount}, BetMode: {betMode}");
            Console.WriteLine($"[RGS] Sending request to Game Engine...");

            var engineResponse = await engineClient.PlayAsync(engineRequest, cancellationToken);
            
            Console.WriteLine($"[RGS] ===== PLAY RESPONSE RECEIVED FROM ENGINE =====");
            Console.WriteLine($"[RGS] RoundId: {engineResponse.RoundId}");
            Console.WriteLine($"[RGS] Win: {engineResponse.Win.Amount}, ScatterWin: {engineResponse.ScatterWin.Amount}, FeatureWin: {engineResponse.FeatureWin.Amount}");
            Console.WriteLine($"[RGS] FreeSpinsAwarded: {engineResponse.FreeSpinsAwarded}");
            Console.WriteLine($"[RGS] WaysToWin: {engineResponse.Results.WaysToWin ?? 0}");
            Console.WriteLine($"[RGS] ReelHeights: [{string.Join(", ", engineResponse.Results.ReelHeights ?? Array.Empty<int>())}]");
            
            // Log reel symbols being sent to frontend (jagged array structure)
            if (engineResponse.Results.ReelSymbols != null && engineResponse.Results.ReelSymbols.Count > 0)
            {
                Console.WriteLine($"[RGS] ReelSymbols count: {engineResponse.Results.ReelSymbols.Count} columns");
                
                if (engineResponse.Results.ReelHeights != null && engineResponse.Results.ReelHeights.Count > 0)
                {
                    int columns = engineResponse.Results.ReelHeights.Count;
                    Console.WriteLine($"[RGS] Expected frontend display (what should be visible):");
                    
                    // Top reel is separate - use TopReelSymbols array
                    if (engineResponse.Results.TopReelSymbols != null)
                    {
                        Console.WriteLine($"[RGS]   TOP REEL (columns 1-4): [{string.Join(", ", engineResponse.Results.TopReelSymbols)}]");
                        Console.WriteLine($"[RGS]     Note: Frontend should use TopReelSymbols array for top reel");
                    }
                    
                    // Main reels use ReelSymbols jagged array
                    for (int col = 0; col < columns && col < engineResponse.Results.ReelSymbols.Count; col++)
                    {
                        var reelSymbols = engineResponse.Results.ReelSymbols[col];
                        int reelHeight = engineResponse.Results.ReelHeights[col];
                        
                        if (reelSymbols != null)
                        {
                            var symbolList = reelSymbols.Take(reelHeight).ToList();
                            Console.WriteLine($"[RGS]   Reel {col} (height {reelHeight}): [{string.Join(", ", symbolList)}] (row 0=bottom, row {reelHeight-1}=top)");
                        }
                        else
                        {
                            Console.WriteLine($"[RGS]   Reel {col} (height {reelHeight}): NULL");
                        }
                    }
                }
                else
                {
                    // Non-Megaways: log all columns
                    for (int col = 0; col < engineResponse.Results.ReelSymbols.Count; col++)
                    {
                        var reelSymbols = engineResponse.Results.ReelSymbols[col];
                        if (reelSymbols != null)
                        {
                            Console.WriteLine($"[RGS]   Reel {col}: [{string.Join(", ", reelSymbols)}]");
                        }
                    }
                }
            }
            
            Console.WriteLine($"[RGS] ================================================");

            sessions.UpdateState(session.SessionId, engineResponse.NextState);
            return Results.Ok(engineResponse);
        })
    .WithName("Play");

app.MapPost("/{gameId}/buy-free-spins",
        async (string gameId,
            BuyFeatureRequest request,
            SessionManager sessions,
            IEngineClient engineClient,
            CancellationToken cancellationToken) =>
        {
            if (request is null)
            {
                return Results.BadRequest("Request payload is required.");
            }

            if (!sessions.TryGetSession(request.SessionId, out var session))
            {
                return Results.Unauthorized();
            }

            if (!string.Equals(session.GameId, gameId, StringComparison.OrdinalIgnoreCase))
            {
                return Results.BadRequest("Session does not match game.");
            }

            if (!TryParseBetMode(request.BetMode, out var betMode))
            {
                return Results.BadRequest("Unknown betMode.");
            }

            if (betMode != BetMode.Standard)
            {
                return Results.BadRequest("ANTE_MODE_BUY_NOT_ALLOWED");
            }

            Money baseBet;
            try
            {
                baseBet = new Money(request.BaseBet);
            }
            catch (Exception ex)
            {
                return Results.BadRequest($"Invalid baseBet value: {ex.Message}");
            }

            var totalBet = CalculateTotalBet(baseBet, betMode);
            if (totalBet.Amount <= 0)
            {
                return Results.BadRequest("Total bet must be positive.");
            }

            List<BetRequest> betRequests;
            try
            {
                betRequests = request.Bets is { Count: > 0 }
                    ? ConvertBetRequests(request.Bets)
                    : new List<BetRequest> { new("BASE", baseBet) };
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(ex.Message);
            }

            var engineRequest = new PlayRequest(
                GameId: gameId,
                PlayerToken: session.PlayerToken,
                Bets: betRequests,
                BaseBet: baseBet,
                TotalBet: totalBet,
                BetMode: betMode,
                IsFeatureBuy: true,
                EngineState: session.State ?? EngineSessionState.Create(),
                UserPayload: request.UserPayload,
                LastResponse: null);

            var engineResponse = await engineClient.PlayAsync(engineRequest, cancellationToken);
            sessions.UpdateState(session.SessionId, engineResponse.NextState);
            if (engineResponse.BuyCost.Amount > 0)
            {
                logger.LogInformation("Buy feature charged {Amount}", engineResponse.BuyCost.Amount);
            }
            return Results.Ok(engineResponse);
        })
    .WithName("BuyFreeSpins");

app.Run();

static bool TryParseBetMode(string? value, out BetMode mode)
{
    if (string.Equals(value, "ante", StringComparison.OrdinalIgnoreCase))
    {
        mode = BetMode.Ante;
        return true;
    }

    if (string.Equals(value, "standard", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(value))
    {
        mode = BetMode.Standard;
        return true;
    }

    mode = BetMode.Standard;
    return false;
}

static Money CalculateTotalBet(Money baseBet, BetMode mode)
{
    var multiplier = mode == BetMode.Ante ? 1.25m : 1m;
    return new Money(baseBet.Amount * multiplier);
}

static List<BetRequest> ConvertBetRequests(IReadOnlyList<ClientBetRequest> bets)
{
    var betRequests = new List<BetRequest>(bets.Count);
    foreach (var bet in bets)
    {
        try
        {
            betRequests.Add(new BetRequest(bet.BetType, new Money(bet.Amount)));
        }
        catch (Exception ex)
        {
            throw new ArgumentException($"Invalid bet entry: {ex.Message}");
        }
    }

    return betRequests;
}
