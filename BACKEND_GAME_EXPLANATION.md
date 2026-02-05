# Backend Game Architecture - Complete Guide

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Where Reels Are Configured](#where-reels-are-configured)
4. [How the Frontend Reads Backend Data](#how-the-frontend-reads-backend-data)
5. [What the Backend Sends](#what-the-backend-sends)
6. [Backend Flow: How It Starts and What Gets Triggered](#backend-flow-how-it-starts-and-what-gets-triggered)
7. [How Wins Are Calculated](#how-wins-are-calculated)
8. [RGS API Endpoints and Contracts](#rgs-api-endpoints-and-contracts)
9. [Game Engine Internals](#game-engine-internals)
10. [RNG and Randomness](#rng-and-randomness)
11. [Key Files Reference](#key-files-reference)

---

## Overview

The backend for Jungle Relics (Buffalo King Megaways–style) is a **microservices-style** stack:

- **RGS (Regulatory Game Server)** – HTTP API the frontend talks to; handles sessions, balance, and game config; forwards play to the Game Engine.
- **Game Engine Host** – HTTP service that runs the **game logic** (spins, cascades, wins, free spins); uses config and (optionally) RNG.
- **RNG Host** – Optional HTTP service that provides jurisdiction-friendly random numbers (currently **not used** for spins; see [RNG and Randomness](#rng-and-randomness)).

### Key Technologies

- **ASP.NET Core** – RGS and Game Engine Host (Minimal API + Controllers)
- **C# / .NET** – Game math, configuration, contracts
- **JSON** – Config files (`JungleRelics.json`, `JungleRelicsReelsets.json`) and API payloads (camelCase)

### Game Features (Backend Side)

- Megaways: variable reel heights (2–7 or 2–8 per column), ways-to-win
- Top reel: horizontal reel above columns 1–4
- Cascading reels: winning symbols removed, board refills, re-evaluate until no win
- Free spins: scatter triggers, retriggers, wild multipliers (2x, 3x, 5x)
- Bet modes: Standard (20× base), Ante (25×, different reel weights)
- Buy feature: pay to enter free spins (standard mode only)
- Max win cap: total win capped by config (`maxWinMultiplier` × bet)

---

## Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (PixiJS / Vite)                         │
│              POST /start, POST /play, POST /buy-free-spins               │
└────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    RGS (port 5100) – Regulatory Game Server               │
│  • Sessions (SessionManager)                                              │
│  • Balance (BalanceService)                                               │
│  • Game config for client (GameConfigService → JungleRelics.json)        │
│  • POST /{operatorId}/{gameId}/start | /play | /buy-free-spins           │
│  • POST /{operatorId}/player/balance                                     │
└────────────────────────────────┬────────────────────────────────────────┘
                                  │
                    HTTP POST /play (Game Engine Host base URL)
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              GAME ENGINE HOST (port 5101) – Game Logic                  │
│  • PlayController → LocalEngineClient → SpinHandler                      │
│  • GameConfigurationLoader (loads JungleRelics.json + reels)             │
│  • WinEvaluator, MegawaysReelBoard, cascades, scatter, free spins        │
└────────────────────────────────┬────────────────────────────────────────┘
                                  │
              (Optional: POST /pools with gameId, roundId)
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    RNG HOST (port 5102) – Random Numbers                 │
│  • POST /pools → returns pools of integers                                │
│  • Currently NOT used for spins (presentation mode uses preset sequence) │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **RGS** | Expose client API; validate session/bet; debit/credit balance; call Game Engine; return normalized response (player, game.results, freeSpins, etc.). |
| **Game Engine Host** | Load game config and reel strips; run spin (board build, RNG/preset, evaluate wins, cascade loop, scatter/free spins); return `PlayResponse` with `Results`. |
| **GameConfigurationLoader** | Load and cache `JungleRelics.json`; load reel strips from `JungleRelicsReelsets.json`; build `SymbolMap`, `ReelLibrary`, `MultiplierProfiles`. |
| **SpinHandler** | Orchestrate single play: select reels, fetch random context, build board, cascade loop, scatter/free spins, max win cap, build `PlayResponse`. |
| **WinEvaluator** | Evaluate Megaways (and traditional) wins: contiguous reels left-to-right, wild substitution, ways-to-win, paytable lookup. |
| **RNG Host** | Provide pools of random integers for jurisdiction compliance; currently unused (see [RNG and Randomness](#rng-and-randomness)). |

---

## Where Reels Are Configured

### 1. Game configuration: `backend/RGS/RGS/configs/JungleRelics.json`

This file defines:

- **Board**: `columns` (6), `rows` (5), `maxRows` (8), `megaways: true`
- **Megaways**: `reelHeights` per reel index (min/max symbols per column), `topReel` (enabled, covers reels [1,2,3,4], symbol count 4)
- **Symbol catalog**: Each symbol has `sym` (e.g. `Sym1`), `code` (e.g. `BONUS`, `BUFFALO`, `WILD`), `displayName`, `type` (Low, High, Scatter, Multiplier, Wild)
- **Reels**: `reels.sourceFile` = `"configs/JungleRelicsReelsets.json"`, `reels.keys` = `high`, `low`, `buy`, `freeSpins` (reel set names)
- **Paytable**: Per-symbol `multipliers` (count = number of contiguous reels, multiplier = bet multiplier)
- **Scatter**: Rewards by scatter count (e.g. 4 → 5× payout + 12 free spins, 5 → 20× + 17, 6 → 100× + 22)
- **Free spins**: `initialSpins`, `retriggerSpins`, `retriggerScatterCount`
- **Bet ledger**: `baseBetMultiplier` (20), `anteBetMultiplier` (25), `buyFreeSpinsCostMultiplier` (100)
- **Bet modes**: `standard` / `ante` with `reelWeights` (low/high) for choosing High vs Low reel set
- **Multiplier**: Values and weights per mode (standard, ante, freeSpinsHigh, freeSpinsLow)
- **maxWinMultiplier**: 5000 (total win cap = bet × 5000)

The **Game Engine Host** resolves config path via `GameEngine:ConfigurationDirectory` (default points to RGS `configs` when run from solution). So in practice **reels and game rules are defined in RGS configs**, and the engine loads them from there.

### 2. Reel strips: `backend/RGS/RGS/configs/JungleRelicsReelsets.json`

- **Structure**: One key per reel set, e.g. `reelsetHigh`, `reelsetLow`, `reelsetBB`, `reelsetFreeSpins`.
- **Value**: Array of **columns**; each column is an array of **symbol IDs** (e.g. `Sym1`, `Sym2`, …), repeated along the strip (hundreds of entries per column).
- **Usage**: `GameConfigurationLoader.LoadReelDataAsync` reads this file and maps keys to `ReelLibrary`: High, Low, Buy, FreeSpins. Each entry is `IReadOnlyList<IReadOnlyList<string>>` (columns × strip positions).
- **Symbol IDs**: Strips use internal IDs (`Sym1` …). The engine and config map these to **codes** (e.g. `BONUS`, `WILD`) via `SymbolCatalog` / `SymbolMap`. The backend sends **codes** to the frontend in `ReelSymbols` and `TopReelSymbols`.

So: **reels are configured** in `JungleRelics.json` (which file, which keys) and **reel content** (symbol order per column) in `JungleRelicsReelsets.json`.

---

## How the Frontend Reads Backend Data

- The frontend **only talks to the RGS** (e.g. `http://localhost:5100`).
- It does **not** load `JungleRelics.json` or reel files directly from disk; it gets:
  - **Session and game config** from `POST /{operatorId}/{gameId}/start` (e.g. bet levels, RTP, max win cap, settings, free spin state).
  - **Round result** from `POST /{operatorId}/{gameId}/play` (and buy feature) in `game.results`.

The **results** object is the Game Engine’s `PlayResponse.Results` (wrapped by RGS in `game.results`). So the frontend “reads” backend data from:

1. **Start response**: `player`, `game` (bet, config, freeSpins, etc.), `currency`, `client`
2. **Play response**: `player` (balance, roundId, bet, win), `game.results` (see [What the Backend Sends](#what-the-backend-sends)), `freeSpins`, `feature`

The frontend uses `game.results` to drive what to display: final (and per-cascade) reel symbols, reel heights, top reel, ways to win, wins, scatter, free spin state.

---

## What the Backend Sends

### From RGS to client (Play response)

RGS returns a wrapper with `statusCode`, `message`, and `data`. The **data** is the play payload; key parts:

- **player**: `sessionId`, `roundId`, `prevBalance`, `balance`, `bet`, `win`, `currencyId`, `transaction.withdraw/deposit`
- **game**: `results` (engine result), `mode` (0=normal, 1=free spin), `maxWinCap` (achieved, value, realWin)
- **freeSpins**: `amount`, `left`, `betValue`, `roundWin`, `totalWin`, `totalBet`, `won`
- **feature**: `name`, `type`, `isClosure`

### Engine result: `game.results` (ResultsEnvelope)

This is what the frontend uses to render the grid and cascades:

| Field | Type | Description |
|-------|------|-------------|
| **cascades** | Array | Each step: `index`, `reelSymbolsBefore`, `reelSymbolsAfter`, `winsAfterCascade`, `baseWin`, `appliedMultiplier`, `totalWin` |
| **wins** | Array | All symbol wins: `symbolCode`, `count`, `multiplier`, `payout`, `waysToWin`, **`winningPositions`** (array of `{ reel, position }` for contiguous reels only) |
| **scatter** | Object or null | `symbolCount`, `win`, `freeSpinsAwarded` |
| **freeSpins** | Object or null | `spinsRemaining`, `totalMultiplier`, `featureWin`, `triggeredThisSpin` |
| **rngTransactionId** | string | Round id (e.g. for audit) |
| **reelSymbols** | Jagged array | **Final** grid: `reelSymbols[column][row]` = symbol **code** (e.g. `BUFFALO`, `WILD`). Row 0 = bottom. |
| **reelHeights** | Array of int | Per-column visible height (main reel only; top reel is extra). |
| **topReelSymbols** | Array of string | Symbol **codes** for the top reel (one per covered column, same order as `coversReels`). |
| **waysToWin** | int | Megaways ways for the final board. |

- **Symbol format**: All symbol identifiers sent to the frontend are **codes** (e.g. `BONUS`, `WILD`, `10`), not internal IDs (`Sym1`, `Sym12`). The frontend maps these to assets (e.g. via `manifest.json` and theme config).
- **Cascades**: First cascade step is the initial board and its wins; then “after” state; then next step’s “before” = previous “after”, etc. Frontend can animate step-by-step (remove winners, drop, show next symbols).

---

## Backend Flow: How It Starts and What Gets Triggered

### 1. Start (session and config)

1. Frontend calls `POST /{operatorId}/{gameId}/start` with body (e.g. `languageId`, `client`, `funMode`, `token` if real money).
2. RGS validates (e.g. `playerToken` when `funMode=0`), creates session via `SessionManager`, gets balance (`BalanceService`), currency (`CurrencyService`), and game config (`GameConfigService` → `GameConfigurationLoader` for that `gameId`).
3. RGS returns `RgsApiResponse<StartGameResponse>`: player (sessionId, id, balance), client, currency, game (RTP, bet levels, max win cap, config, free spin state if any), etc.

No spin runs; the engine is not called. Config is loaded in RGS only for the **start** response (bet levels, RTP, max win cap, settings).

### 2. Play (normal spin or free spin)

1. Frontend calls `POST /{operatorId}/{gameId}/play` with `sessionId`, `bets`, `baseBet`, `betMode` (and optional `userPayload`, `lastResponse`).
2. RGS validates session, gameId, betMode, bets; computes total bet (standard vs ante); gets prev balance; builds `PlayRequest` (gameId, playerToken, bets, baseBet, totalBet, betMode, isFeatureBuy: false, engineState from session, currency, etc.).
3. RGS calls **Game Engine Host** `POST /play` with `PlayRequest`.
4. **Game Engine Host**:
   - `PlayController` receives request, calls `IEngineClient.PlayAsync` (implemented by `LocalEngineClient`).
   - `LocalEngineClient` calls `SpinHandler.PlayAsync`.
5. **SpinHandler.PlayAsync** (see [Game Engine Internals](#game-engine-internals)):
   - Validates request; loads config; creates roundId; clones engine state (or creates new).
   - Determines **spin mode**: BaseGame, FreeSpins, or BuyEntry.
   - Selects **reel strips** (High/Low by bet mode for base; FreeSpins or Buy reelset for free/buy).
   - **Fetches random context**: Currently **presentation mode** – 20 preset (reel heights, reel start seeds, top reel position/symbol seeds) in a loop. Optional RNG Host path is commented out.
   - Builds **board**: Megaways (variable heights + top reel) or fixed grid; fills reels from strips using random seeds.
   - **Cascade loop**:
     - Get current reel symbols (with top reel codes for eval).
     - **WinEvaluator.EvaluateMegaways** (or traditional) → wins.
     - If no wins: break; final grid = last board state.
     - Else: add wins to lists; apply multipliers; add to totalWin/featureWin; **remove only symbols at winning positions** (`RemovePositions` from each win’s `WinningPositions`); remove multiplier symbols; refill; record cascade step; repeat.
   - After loop: **scatter evaluation** on final board (count scatter symbols); if enough, add scatter win and/or award/retrigger free spins (initialize or add spins to state).
   - Free spin state update: decrement spins remaining; clear state when 0.
   - **Max win cap**: If totalWin > bet × maxWinMultiplier, cap totalWin and (in free spins) end feature immediately.
   - Build **ResultsEnvelope** (cascades, wins, scatter, freeSpins summary, reelSymbols, reelHeights, topReelSymbols, waysToWin); build `PlayResponse`; return.
6. RGS receives `PlayResponse`; debits/credits balance (`BalanceService`); updates session state (`EngineSessionState`); builds **PlayGameResponse** (player, game.results = engine result, freeSpins, feature, maxWinCap, etc.); returns to frontend.

So: **what gets triggered** on play is (1) one spin (one board + possibly many cascades), (2) scatter check and possible free spin award/retrigger, (3) free spin counter decrement if in free spins, (4) balance and session state update.

### 3. Buy Free Spins

1. Frontend calls `POST /{operatorId}/{gameId}/buy-free-spins` with sessionId, baseBet, betMode (must be standard), optional bets.
2. RGS validates session, gameId, betMode (ante not allowed for buy); computes buy cost; builds `PlayRequest` with **isFeatureBuy: true**; calls Game Engine Host `POST /play`.
3. Engine runs same **SpinHandler.PlayAsync** with `SpinMode.BuyEntry`: uses **Buy** reel set, charges buy cost, and typically starts free spins (scatter outcome or direct entry from buy reels). Response includes engine result and next state.
4. RGS deducts buy cost (and adds any immediate win); updates session state; returns same shape as play (player, game.results, freeSpins, feature).

---

## How Wins Are Calculated

### WinEvaluator (Megaways)

- **File**: `backend/GameEngineHost/GameEngine/Play/WinEvaluator.cs`
- **Entry**: `EvaluateMegaways(reelSymbols, topReelSymbols, configuration, bet)` with jagged `reelSymbols[column][row]` and optional top reel symbols.

Logic (simplified):

1. **Per paytable symbol** (e.g. BUFFALO, EAGLE, …):
   - **Reel 0**: Win requires at least one instance of that symbol (or wild) on reel 0. Wilds do not appear on reel 0 in config, so the pay symbol must appear there.
   - **Left-to-right**: For reels 0..N, count how many symbols (or wilds) match on each reel. Wilds on reels 2–5 (indices 1–4) substitute for any non-scatter symbol (from `SymbolMap` and `SymbolType.Wild`).
   - **Top reel**: If enabled, for covered columns (1–4), top reel symbol is treated as an extra “row” (match or wild).
   - **Contiguous reels**: Count only up to the first reel that has zero matches; that gives “contiguous reels” and per-reel counts.
2. **Minimum reels**: At least 2 contiguous reels required for any pay (configurable; currently 2).
3. **Ways to win**: Product of symbol counts on contiguous reels (e.g. 1×2×1 = 2 ways).
4. **Paytable lookup**: Paytable entries are by **number of contiguous reels** (e.g. 3, 4, 5, 6), not total symbols. Best match = highest reel count ≤ contiguous reels.
5. **Payout**: `Bet × paytableMultiplier × ways`. Each line win is a `SymbolWin` (symbolCode, count, multiplier, payout, waysToWin). Total win is sum of all symbol wins.

Scatter is **not** evaluated in WinEvaluator; it’s done in SpinHandler after the cascade loop (count scatter symbols on final board, then apply scatter rewards and free spin awards).

### Cascading and removal

- After evaluating wins, SpinHandler collects all **winning symbol codes** from `SymbolWin` entries.
- It calls `board.RemoveSymbols(winningCodes)` and, for Megaways, `RemoveTopReelSymbols(winningCodes)`. **Current implementation removes every instance of those codes** from the board (not only the positions that formed the winning way). So cascades can remove more symbols than the “way” positions; this is a known limitation.
- Then multiplier symbols are removed, board refills, and the next cascade step is evaluated until no wins.

---

## RGS API Endpoints and Contracts

### Endpoints

| Method | URL | Purpose |
|--------|-----|---------|
| POST | `/{operatorId}/{gameId}/start` | Start session; return player, game config, currency, client. |
| POST | `/{operatorId}/{gameId}/play` | Play one round (base or free spin); return balance, roundId, game.results, freeSpins, feature. |
| POST | `/{operatorId}/{gameId}/buy-free-spins` | Buy feature; same response shape as play. |
| POST | `/{operatorId}/player/balance` | Get current balance for `playerId`. |

All return JSON with `statusCode`, `message`, and (except errors) `data` containing the response model.

### Important request/response types (RGS)

- **Start**: Body includes `languageId`, `client`, `funMode`, `token` (if real money). Response: `StartGameResponse` (player, client, currency, game, etc.).
- **Play**: Body `ClientPlayRequest`: `sessionId`, `bets`, `baseBet`, `betMode`, optional `userPayload`, `lastResponse`. Response: `PlayGameResponse` (player, game with results, freeSpins, feature).
- **Buy feature**: Body `BuyFeatureRequest`: same as play but no lastResponse needed; `betMode` must be standard. Response: same as play.
- **Balance**: Body `{ "playerId": "..." }`. Response `{ "balance": number }`.

Contracts live under `backend/RGS/RGS/Contracts/` (e.g. `StartContracts.cs`, `PlayContracts.cs`, `RgsResponseModels.cs`, `BalanceRequest.cs`).

---

## Game Engine Internals

### Play request (engine)

`PlayRequest`: GameId, PlayerToken, Bets, BaseBet, TotalBet, BetMode, IsFeatureBuy, **EngineState** (session state from RGS), UserPayload, LastResponse, RtpLevel, Mode, Currency.

The engine **does not** persist state; RGS holds the last `EngineSessionState` and sends it every time so the engine can continue free spins, etc.

### SpinHandler sequence (summary)

1. Validate request; load `GameConfiguration`; create roundId; clone engine state.
2. Spin mode: BaseGame | FreeSpins | BuyEntry.
3. Buy cost: if IsFeatureBuy, cost = baseBet × buyFreeSpinsCostMultiplier.
4. Select reel strips: FreeSpins → ReelLibrary.FreeSpins; BuyEntry → ReelLibrary.Buy; BaseGame → High or Low by bet mode weights (FortunaPrng).
5. Fetch random context: **presentation mode** → `GetPresetRandomContext` (20 presets, round-robin). (Optional RNG Host call is commented out.)
6. Build board: MegawaysReelBoard with reel heights, top reel, reel start seeds, multiplier factory; or fixed ReelBoard.
7. Cascade loop: evaluate wins → apply multipliers → accumulate wins → remove winning codes + multiplier symbols → refill → repeat until no wins.
8. Scatter: count scatter symbols on final board; apply scatter pay and free spin award/retrigger from config.
9. Decrement free spins if in free spins; clear state if 0.
10. Max win cap; build ResultsEnvelope and PlayResponse.

### Reel strip selection (base game)

- From `JungleRelics.json`, `betModes.standard` and `betModes.ante` define `reelWeights.low` and `reelWeights.high`.
- `SelectBaseReels` rolls a single random number against low+high; chooses `ReelLibrary.Low` or `ReelLibrary.High`. So ante vs standard only changes the **probability** of high vs low reel set (e.g. ante = more high).

---

## RNG and Randomness

- **RNG Host** (port 5102): Exposes `POST /pools`. Request: list of pools (poolId, drawCount, metadata). Response: transactionId and one result array per pool (integer strings). Used for jurisdiction-compliant random numbers.
- **Engine configuration**: RGS and Game Engine Host both register an `IRngClient` with base URL `http://localhost:5102/pools` (or from config/env).
- **Current behavior**: In `SpinHandler.FetchRandomContext`, the code that calls `_rngClient.RequestPoolsAsync(...)` is **commented out**. Instead, the engine uses **presentation mode**: `GetPresetRandomContext` cycles through 20 fixed presets (reel heights, reel start seeds, top reel position/symbol seeds). So **the game does not use the RNG Host for spins** today.
- **Fallback**: When RNG was used, on failure the engine would use `RandomContext.CreateFallback(..., _fortunaPrng, ...)` (in-process `FortunaPrng`). Other places (e.g. reel strip choice, multiplier assignment) use `_fortunaPrng` (C# `RandomNumberGenerator`).

To use RNG Host for spins: uncomment the block in `FetchRandomContext` that builds the pools request and calls `_rngClient.RequestPoolsAsync`, and remove or bypass the presentation-mode branch that returns `GetPresetRandomContext(...)`.

---

## Key Files Reference

| Path | Purpose |
|------|---------|
| **RGS** | |
| `backend/RGS/RGS/Program.cs` | RGS app; endpoints for start, play, buy-free-spins, balance; registration of SessionManager, BalanceService, GameConfigService, Engine HTTP client, RNG client. |
| `backend/RGS/RGS/configs/JungleRelics.json` | Game and reel config: board, symbols, paytable, scatter, free spins, bet modes, reels file and keys, max win. |
| `backend/RGS/RGS/configs/JungleRelicsReelsets.json` | Reel strips: reelsetHigh, reelsetLow, reelsetBB, reelsetFreeSpins (columns of symbol IDs). |
| `backend/RGS/RGS/Contracts/*.cs` | RGS request/response DTOs and API response wrapper. |
| `backend/RGS/RGS/Services/EngineHttpClient.cs` | HTTP client that POSTs `PlayRequest` to Game Engine Host `/play`. |
| `backend/RGS/RGS/Services/GameConfigService.cs` | Uses GameConfigurationLoader to expose bet levels, RTP, max win cap, settings for start response. |
| **Game Engine** | |
| `backend/GameEngineHost/Program.cs` | Engine host; config path; registration of GameEngine (config loader, SpinHandler, etc.), LocalEngineClient, RNG client. |
| `backend/GameEngineHost/Controllers/PlayController.cs` | Receives POST /play, calls IEngineClient.PlayAsync (LocalEngineClient → SpinHandler), returns PlayResponse. |
| `backend/GameEngineHost/Services/RgsCompatibleEngineClient.cs` | LocalEngineClient: implements IEngineClient by calling SpinHandler.PlayAsync. |
| `backend/GameEngineHost/GameEngine/GameConfigurationLoader.cs` | Loads JungleRelics.json, validates, loads reel file into ReelLibrary, builds SymbolMap and MultiplierProfiles. |
| `backend/GameEngineHost/GameEngine/Play/SpinHandler.cs` | Full play flow: config, state, reel selection, random context, board build, cascade loop, scatter, free spins, max win, response. |
| `backend/GameEngineHost/GameEngine/Play/WinEvaluator.cs` | Megaways (and traditional) win evaluation: contiguous reels, wilds, ways, paytable. |
| `backend/GameEngineHost/GameEngine/Play/PlayContracts.cs` | PlayRequest, PlayResponse, ResultsEnvelope, CascadeStep, SymbolWin, ScatterOutcome, FeatureSummary, BetMode. |
| `backend/GameEngineHost/GameEngine/Play/EngineState.cs` | EngineSessionState, FreeSpinState, SpinMode. |
| **RNG** | |
| `backend/RngHost/Program.cs` | Minimal app; POST /pools returns random integer pools. |
| `backend/GameEngineHost/RngClient.cs` | IRngClient implementation; POST to RNG base URL (currently unused for spins). |

---

This document should give you a complete picture of where reels are configured, how the frontend gets its data, what the backend sends, how the backend flow starts and what gets triggered, and how wins are calculated. For frontend-specific flow (e.g. how results drive the grid and cascades), see `FRONTEND_GAME_EXPLANATION.md`.
