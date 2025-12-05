# Frontend Game Architecture - Complete Guide

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Component Breakdown](#component-breakdown)
4. [Data Flow](#data-flow)
5. [Key Methods Reference](#key-methods-reference)
6. [Animation System](#animation-system)
7. [State Management](#state-management)
8. [Common Patterns](#common-patterns)

---

## Overview

The frontend of Jungle Relics is a **cascading slot game** built with modern web technologies. It uses **PixiJS** for WebGL rendering, **GSAP** for animations, and vanilla JavaScript (ES6 modules) for the application logic.

### Key Technologies
- **PixiJS 8.1.0** - WebGL rendering engine for hardware-accelerated graphics
- **GSAP 3.12.5** - Professional animation library for smooth transitions
- **Vite 7.2.4** - Fast build tool and development server
- **Vanilla JavaScript** - No framework, pure ES6 modules

### Game Features
- 6x5 grid slot game (supports Megaways with variable reel heights)
- Cascading mechanics (winning symbols disappear, new ones fall)
- Free spins with multipliers
- Animated backgrounds
- Video transitions for free spin triggers
- Sound effects and background music
- Turbo mode for faster animations

---

## Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────┐
│                    index.html                           │
│              (UI Elements, Modals, HUD)                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                      main.js                            │
│  Entry Point: Initializes app, coordinates managers      │
└──────┬───────────────┬───────────────┬──────────────────┘
       │               │               │
       ▼               ▼               ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Network    │  │   Theme     │  │   Scene     │
│  Manager    │  │   Manager   │  │   Manager   │
└─────────────┘  └─────────────┘  └─────┬───────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
            ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
            │    Grid     │    │  Animation    │    │    Audio     │
            │  Renderer   │    │   Manager     │    │   Manager    │
            └──────────────┘    └──────────────┘    └──────────────┘
```

### Layer System (PixiJS)

The game uses a **layered rendering approach** with three main layers:

1. **Background Layer** (`backgroundLayer`)
   - Animated background sequences (Background1, Background2)
   - Always visible, behind everything

2. **Scene Layer** (`sceneLayer`)
   - Main game grid and symbols
   - Positioned and scaled to center on screen

3. **Transition Layer** (`transitionLayer`)
   - Free spin video transitions
   - Appears on top when free spins trigger

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| `main.js` | Entry point, UI event handling, game state coordination |
| `SceneManager.js` | Scene orchestration, layer management, result processing |
| `GridRenderer.js` | Grid rendering, spin animations, cascade mechanics |
| `AnimationManager.js` | Cascade sequence animations, win highlighting |
| `NetworkManager.js` | Backend API communication (RGS service) |
| `ThemeManager.js` | Asset loading, theme manifest management |
| `AudioManager.js` | Sound effects, background music, volume control |
| `BackgroundAnimation.js` | Animated background frame sequences |
| `FreeSpinTransition.js` | Video transition for free spin triggers |
| `SymbolRenderer.js` | Symbol sprite creation utilities |
| `UIRenderer.js` | UI overlay rendering (currently minimal) |
| `AssetLoader.js` | PixiJS asset bundle loading |

---

## Component Breakdown

### 1. main.js - Entry Point

**Purpose**: Initializes the game, sets up UI, coordinates all managers, handles user interactions.

**Key Responsibilities**:
- Initialize PixiJS application
- Create and coordinate managers (Network, Theme, Scene)
- Handle UI events (spin button, bet adjustment, modals)
- Manage game state (bet amount, bet mode, turbo mode)
- Start game session with backend
- Process spin results and update UI

**Main Flow**:
```
1. Initialize PixiJS app
2. Create managers (Network, Theme, Scene)
3. Start session with backend
4. Load theme assets
5. Initialize scene
6. Set up event listeners
7. Ready for gameplay
```

**Key Variables**:
- `sessionInfo` - Current game session data from backend
- `activeBetMode` - 'standard' or 'ante'
- `currentBaseBet` - Current bet amount (default 0.2)
- `isTurboMode` - Animation speed toggle

**Key Functions**:
- `main()` - Entry point, async initialization
- `startSpin()` - Handles spin button click, calls backend, renders results
- `buyFreeSpins()` - Handles buy feature, calls backend
- `setControlsDisabled()` - Enables/disables UI controls during spins
- `updateControlStates()` - Updates button states based on bet mode

---

### 2. SceneManager.js - Scene Orchestration

**Purpose**: Manages the visual presentation, coordinates layers, handles free spin transitions, processes game results.

**Key Responsibilities**:
- Manage PixiJS layers (background, scene, transition)
- Initialize animated backgrounds
- Handle free spin video transitions
- Process game results and trigger animations
- Coordinate between GridRenderer and AnimationManager
- Manage audio playback

**Layer Management**:
- `backgroundLayer` - Background animations (always visible)
- `sceneLayer` - Main game grid (scaled and positioned)
- `transitionLayer` - Free spin video (top layer, shown on trigger)

**Key Methods**:

#### `initialize(themeManifest)`
- Sets up grid dimensions from theme manifest
- Creates and positions layers
- Initializes Background1 animation (105 frames)
- Initializes Background2 animation (151 frames, hidden until free spins)
- Initializes free spin transition video
- Creates GridRenderer with proper dimensions
- Sets up resize handler
- Loads and starts audio

#### `renderResults(results, playResponse)`
- Checks if free spins were triggered
- If triggered, plays free spin transition video
- Otherwise, continues with normal result rendering
- Calls `continueRenderResults()` after transition

#### `continueRenderResults(results, playResponse)`
- Extracts Megaways data (reel heights, top reel symbols, ways to win)
- Updates grid with new reel heights if variable
- Updates top reel symbols if present
- Handles cascades or final grid display
- Preloads result textures during spin
- Transitions from spin to grid mode
- Triggers cascade animations if cascades exist
- Plays win sounds based on win amount

#### `startSpinAnimation()`
- Starts grid spinning animation
- Plays spin sound effect

#### `stopSpinAnimation()`
- Stops grid spinning
- Used for error recovery

#### `playFreeSpinTransition(onComplete)`
- Hides game elements
- Shows transition layer
- Plays free spin video
- Switches to Background2 after video
- Shows game elements again
- Calls completion callback

#### `resizeStage()`
- Resizes all layers on window resize
- Repositions scene layer
- Maintains aspect ratios

#### `positionSceneLayer()`
- Calculates grid position and scale
- Centers grid on screen
- Applies manual offsets (SLOT_SCALE, SLOT_Y_OFFSET)

**State Variables**:
- `columns`, `rows`, `maxRows` - Grid dimensions
- `availableSymbols` - List of symbol aliases
- `isTurboMode` - Animation speed flag
- `backgroundAnimation`, `background2Animation` - Background animators
- `freeSpinTransition` - Video transition handler

---

### 3. GridRenderer.js - Grid Rendering

**Purpose**: Renders the slot grid, handles spin animations, manages cascading mechanics, supports Megaways.

**Key Responsibilities**:
- Render 6-column grid with variable row heights (Megaways)
- Manage dual-layer system (spin layer vs grid layer)
- Handle reel spinning animations with blur effects
- Transition between spin and grid modes
- Animate cascading symbols (fade out, drop down)
- Support top reel (horizontal scrolling above reels 2-5)
- Preload result textures during spin

**Dual-Layer System**:

1. **Spin Layer** (`spinLayer`)
   - Visible during reel spinning
   - Shows animated symbols with blur effect
   - Uses continuous scrolling with wrapping
   - Random symbols while spinning

2. **Grid Layer** (`gridLayer`)
   - Visible during cascades
   - Shows static symbols for win evaluation
   - Used for cascade animations

**Key Methods**:

#### `initialize(sceneLayer)`
- Adds container to scene
- Draws background table texture
- Sets up ticker callback for animations

#### `buildReels(assets)`
- Creates reel containers for each column
- Builds top reel (horizontal, above reels 2-5)
- Creates masks to clip symbols to visible area
- Sets up blur filters for motion blur
- Creates symbol sprites for each reel
- Handles variable reel heights (Megaways)

#### `startSpin(assets)`
- Enters spin mode (shows spin layer, hides grid layer)
- Starts each reel spinning with staggered timing
- Uses GSAP for smooth animations
- Applies blur effect based on speed
- Starts top reel horizontal scrolling
- Supports turbo mode (60% faster)

#### `stopSpin()`
- Stops all animations immediately
- Removes blur effects
- Notifies completion callback

#### `reelsComplete()`
- Called when all reels finish spinning
- Snaps reels to exact target positions
- Ensures no sub-pixel misalignment
- Applies final textures to top reel

#### `transitionSpinToGrid(symbolMatrix, assets)`
- Preloads result textures
- Creates grid sprites with final symbols
- Instantly switches from spin layer to grid layer
- Ensures smooth visual transition
- Updates top reel with final symbols

#### `preloadSpinResult(symbolMatrix, assets)`
- Applies final textures to spinning reels
- Updates symbols during spin (before stop)
- Prevents texture flicker
- Updates top reel symbols

#### `playCascadeStep(nextMatrix, assets, options)`
- Fades out winning symbols
- Drops remaining symbols down
- Spawns new symbols from top
- Animates with GSAP tweens
- Handles variable reel heights

#### `highlightWinningCells(cells, options)`
- Scales up winning symbols
- Uses GSAP timeline for smooth animation
- Bounce effect (scale up, then back down)
- Supports custom scale and duration

#### `renderGridFromMatrix(symbolMatrix, assets)`
- Renders grid from flat symbol array
- Handles Megaways variable structure
- Maps matrix indices to reel positions
- Updates top reel symbols
- Creates/updates grid sprites

**Important Constants** (adjustable):
- `SPIN_BASE_TIME` (1200ms) - Base spin duration
- `SPIN_STAGGER_TIME` (200ms) - Additional time per reel
- `CASCADE_DROP_DURATION` (0.35s) - Symbol drop time
- `CASCADE_FADE_DURATION` (0.15s) - Win fade time
- `SLOT_SCALE` (1.15) - Grid size multiplier
- `SLOT_Y_OFFSET` (0) - Vertical position offset

**Top Reel System**:
- Horizontal scrolling reel above columns 2-5 (indices 1-4)
- 4 visible symbols, 6 buffer symbols for smooth scrolling
- Scrolls right-to-left during spin
- Shows final symbols from backend after spin
- Uses same animation system as vertical reels

**Megaways Support**:
- Variable reel heights per column
- `reelHeights` array stores height for each column
- `maxRows` tracks maximum possible rows
- Grid size adjusts dynamically
- Matrix mapping handles variable structure

---

### 4. AnimationManager.js - Cascade Animations

**Purpose**: Manages cascade sequence animations, win highlighting, timing coordination.

**Key Responsibilities**:
- Play cascade sequences step-by-step
- Highlight winning symbols
- Coordinate timing between cascade steps
- Play win sounds
- Support turbo mode (40% faster)

**Animation Timeline** (per cascade step):

1. **Hold** (0.25s) - Show grid with current state
2. **Highlight** (0.60s) - Scale up winning symbols
3. **Post-Delay** (0.50s) - Pause before cascade
4. **Fade** (0.50s) - Fade out winning symbols
5. **Drop** (0.55s) - Drop remaining/new symbols

**Key Methods**:

#### `playCascadeSequence(cascades, options)`
- Main entry point for cascade animations
- Processes cascade array step-by-step
- For each cascade:
  - Renders grid before state
  - Waits (hold duration)
  - Highlights wins
  - Plays win sound
  - Waits (post-delay)
  - Fades out winners
  - Drops new symbols
- Supports turbo mode (multiplies durations by 0.4)

#### `highlightWins(step)`
- Extracts winning cell positions from cascade step
- Calls `gridRenderer.highlightWinningCells()`
- Handles both explicit indices and symbol matching
- Returns promise for timing coordination

**Turbo Mode**:
- All durations multiplied by `TURBO_MULTIPLIER` (0.4)
- 60% faster animations
- Applied to: hold, highlight, post-delay, fade, drop

---

### 5. NetworkManager.js - Backend Communication

**Purpose**: Handles all HTTP communication with the RGS (Remote Game Server) backend.

**Key Responsibilities**:
- Start game sessions
- Send spin requests
- Send buy free spins requests
- Handle errors and responses

**Base URL**: `http://localhost:5100` (configurable via `VITE_RGS_BASE_URL` env var)

**Key Methods**:

#### `startSession(operatorId, gameId, payload)`
- POST to `/{operatorId}/{gameId}/start`
- Returns session info (sessionId, gameId, balance, etc.)
- Used once at game initialization

#### `play(gameId, requestBody)`
- POST to `/{gameId}/play`
- Sends: sessionId, baseBet, betMode, bets[]
- Returns: results, win, balance, cascades, etc.
- Called on every spin

#### `buyFreeSpins(gameId, requestBody)`
- POST to `/{gameId}/buy-free-spins`
- Sends: sessionId, baseBet, betMode
- Returns: same as play, but with freeSpinsAwarded
- Called when user clicks "Buy Free Spins"

**Request/Response Format**:
```javascript
// Request
{
  sessionId: "session-123",
  baseBet: 0.2,
  betMode: "standard",
  bets: [{ betType: "BASE", amount: 0.2 }]
}

// Response
{
  results: {
    cascades: [...],
    finalGridSymbols: [...],
    reelHeights: [5, 5, 5, 5, 5, 5],
    topReelSymbols: [...],
    waysToWin: 117649
  },
  win: 50.00,
  balance: 950.00,
  roundId: "round-456",
  freeSpinsAwarded: 0,
  freeSpins: { spinsRemaining: 0, ... }
}
```

---

### 6. ThemeManager.js - Asset Loading

**Purpose**: Loads game assets (symbols, textures, animations) from theme manifests.

**Key Responsibilities**:
- Fetch theme manifest JSON
- Load asset bundles via PixiJS Assets API
- Cache manifests
- Resolve asset paths

**Key Methods**:

#### `loadTheme(gameId, assetLoader)`
- Fetches manifest from `/themes/{gameId}/manifest.json`
- Creates asset bundle with all symbols/textures
- Loads bundle via PixiJS Assets
- Returns manifest for grid configuration

**Manifest Structure**:
```json
{
  "grid": { "columns": 6, "rows": 5 },
  "assets": [
    { "alias": "BIRD", "path": "/images/symbols/Bird.webp" },
    { "alias": "SCARAB", "path": "/images/symbols/Scarab.webp" },
    ...
  ]
}
```

**Asset Aliases**:
- Symbol codes: `BIRD`, `SCARAB`, `GREEN`, `RED`, etc.
- Special: `STONE_TEXTURE` (table background), `PLACEHOLDER` (fallback)

---

### 7. AudioManager.js - Sound Management

**Purpose**: Manages all audio playback (music and sound effects).

**Key Responsibilities**:
- Load audio files
- Play background music (looping)
- Play free spin music (different track)
- Play sound effects (spin, stop, win, big win, click)
- Control volumes (music and SFX separate)
- Handle mute/unmute

**Audio Files**:
- `/sounds/background-music.mp3` - Base game music
- `/sounds/free-spins-music.mp3` - Free spin music
- `/sounds/spin.mp3` - Reel spinning sound
- `/sounds/stop.mp3` - Reel stop sound
- `/sounds/win.wav` - Regular win sound
- `/sounds/big-win.wav` - Big win sound (10x+ bet)
- `/sounds/click.wav` - UI click sound

**Key Methods**:

#### `load()`
- Creates Audio objects for all sounds
- Sets loop property for music
- Sets volumes
- Preloads all audio

#### `playBackgroundMusic()`
- Stops current music if playing
- Starts background music loop
- Handles autoplay restrictions

#### `playFreeSpinMusic()`
- Switches to free spin music track
- Used during free spin feature

#### `playSound(soundName)`
- Plays sound effect (spin, stop, win, bigWin, click)
- Resets to start before playing
- Respects mute state

#### `setMuted(muted)`
- Mutes/unmutes all audio
- Stops music when muted
- Resumes music when unmuted

#### `setMusicVolume(volume)` / `setSfxVolume(volume)`
- Sets volume (0.0 to 1.0)
- Updates all relevant audio objects

**Volume Control**:
- Music volume: 0.5 (50%) default
- SFX volume: 0.7 (70%) default
- Controlled via UI sliders in sound modal

---

### 8. BackgroundAnimation.js - Animated Backgrounds

**Purpose**: Manages animated background sequences using frame-by-frame WebP images.

**Key Responsibilities**:
- Load frame sequences (WebP images)
- Play animation at 30fps
- Resize to fill screen
- Switch between Background1 and Background2

**Frame Sequences**:
- **Background1**: 105 frames (`background1_1.webp` to `background1_105.webp`)
  - Used during base game
- **Background2**: 151 frames (`background2_1.webp` to `background2_151.webp`)
  - Used during free spins

**Key Methods**:

#### `load()`
- Loads all frame textures via PixiJS Assets
- Creates sprite with first frame
- Stores all textures in array

#### `play()`
- Starts animation loop
- Adds ticker callback
- Updates frame at 30fps

#### `update()`
- Called every frame by PixiJS ticker
- Advances to next frame based on elapsed time
- Swaps sprite texture

#### `resize(width, height)`
- Scales sprite to fill screen
- Maintains aspect ratio
- Centers sprite
- Supports zoom adjustment (BACKGROUND_SCALE constant)

**Animation Speed**: 30fps (33.33ms per frame)

---

### 9. FreeSpinTransition.js - Video Transitions

**Purpose**: Plays video transition when free spins are triggered.

**Key Responsibilities**:
- Load MP4 video file
- Create PixiJS sprite from video
- Play video on trigger
- Handle completion callback
- Resize to fill screen

**Video File**: `/animations/free spin transistions/PixVerse_V5_Transition_360P.mp4`

**Key Methods**:

#### `load()`
- Creates HTML5 video element
- Loads MP4 file
- Creates PixiJS texture from video
- Sets up completion handler

#### `play(onComplete)`
- Shows container
- Resets video to start
- Plays video
- Updates texture each frame
- Calls `onComplete` when video ends

#### `resize(width, height)`
- Scales video sprite to fill screen
- Maintains aspect ratio
- Centers sprite

**Usage**: Called by `SceneManager` when free spins trigger, plays before switching to Background2.

---

### 10. SymbolRenderer.js - Symbol Utilities

**Purpose**: Utility class for creating symbol sprites.

**Key Responsibilities**:
- Create symbol sprites with proper scaling
- Handle placeholder fallback

**Key Methods**:

#### `createSymbolSprite(symbolCode, assets)`
- Gets texture from assets by symbol code
- Falls back to PLACEHOLDER if not found
- Creates PixiJS sprite
- Sets anchor to center (0.5, 0.5)
- Returns sprite

**Note**: Currently minimal, but can be extended for symbol-specific rendering logic.

---

### 11. UIRenderer.js - UI Overlay

**Purpose**: Renders UI overlays on PixiJS stage (currently minimal).

**Key Responsibilities**:
- Create UI buttons on PixiJS stage
- Manage button containers

**Key Methods**:

#### `initialize(stage)`
- Adds container to stage
- Currently no buttons (UI handled by HTML)

**Note**: Most UI is handled via HTML/CSS in `index.html`. This class is available for future PixiJS-based UI elements.

---

### 12. AssetLoader.js - Asset Bundle Loading

**Purpose**: Wraps PixiJS Assets API for loading asset bundles.

**Key Responsibilities**:
- Add bundle definitions
- Load bundles via PixiJS Assets
- Handle errors

**Key Methods**:

#### `loadBundle(bundleId, manifestEntries, assetLoader)`
- Adds bundle to PixiJS Assets
- Loads bundle
- Returns promise
- Handles errors with detailed logging

**Usage**: Called by `ThemeManager` to load theme assets.

---

## Data Flow

### Spin Request Flow

```
User clicks SPIN button
    ↓
main.js: startSpin()
    ↓
SceneManager: startSpinAnimation()
    ↓ (starts visual spin)
    ↓
NetworkManager: play(gameId, payload)
    ↓ (HTTP POST to backend)
    ↓
Backend processes spin, returns results
    ↓
main.js: receives playResponse
    ↓
SceneManager: renderResults(results, playResponse)
    ↓
[If free spins triggered]
    ↓
FreeSpinTransition: play()
    ↓ (video plays)
    ↓
SceneManager: continueRenderResults()
    ↓
[If cascades exist]
    ↓
AnimationManager: playCascadeSequence()
    ↓ (animates each cascade step)
    ↓
GridRenderer: playCascadeStep()
    ↓ (fades winners, drops new symbols)
    ↓
[Repeat until no more cascades]
    ↓
Update UI (balance, win amount, round ID)
```

### Cascade Animation Flow

```
AnimationManager: playCascadeSequence()
    ↓
For each cascade step:
    ↓
1. GridRenderer: renderGridFromMatrix(gridBefore)
    ↓
2. Wait (hold duration)
    ↓
3. GridRenderer: highlightWinningCells()
    ↓ (scale up winners)
    ↓
4. AudioManager: playWin() or playBigWin()
    ↓
5. Wait (post-delay)
    ↓
6. GridRenderer: playCascadeStep(gridAfter)
    ↓
   a. Fade out winning symbols
    ↓
   b. Drop remaining symbols down
    ↓
   c. Spawn new symbols from top
    ↓
7. Repeat for next cascade
```

### Free Spin Trigger Flow

```
Backend returns: freeSpinsAwarded > 0
    ↓
SceneManager: renderResults() detects trigger
    ↓
SceneManager: playFreeSpinTransition()
    ↓
FreeSpinTransition: play()
    ↓ (video plays full screen)
    ↓
Video ends → callback
    ↓
SceneManager: switches to Background2
    ↓
SceneManager: continueRenderResults()
    ↓ (normal result rendering)
```

---

## Key Methods Reference

### main.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `main()` | Entry point, initializes game | None | Promise |
| `startSpin()` | Handles spin button click | None | Promise |
| `buyFreeSpins()` | Handles buy feature | None | Promise |
| `setControlsDisabled(disabled)` | Enables/disables UI | `disabled: boolean` | void |
| `updateControlStates()` | Updates button states | None | void |
| `getMoneyAmount(value)` | Extracts money value | `value: any` | number |

### SceneManager.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `initialize(themeManifest)` | Sets up scene | `themeManifest: object` | Promise |
| `renderResults(results, playResponse)` | Processes game results | `results: object`, `playResponse: object` | void |
| `continueRenderResults(results, playResponse)` | Renders results after transition | `results: object`, `playResponse: object` | void |
| `startSpinAnimation()` | Starts reel spinning | None | void |
| `stopSpinAnimation()` | Stops spinning | None | void |
| `playFreeSpinTransition(onComplete)` | Plays free spin video | `onComplete: function` | Promise |
| `resizeStage()` | Handles window resize | None | void |
| `positionSceneLayer()` | Positions grid on screen | None | void |
| `setTurboMode(enabled)` | Sets turbo mode | `enabled: boolean` | void |

### GridRenderer.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `initialize(sceneLayer)` | Sets up grid | `sceneLayer: Container` | void |
| `buildReels(assets)` | Creates reel containers | `assets: Assets` | void |
| `startSpin(assets)` | Starts spinning | `assets: Assets` | void |
| `stopSpin()` | Stops spinning | None | void |
| `transitionSpinToGrid(symbolMatrix, assets)` | Switches to grid mode | `symbolMatrix: array`, `assets: Assets` | Promise |
| `preloadSpinResult(symbolMatrix, assets)` | Applies final textures | `symbolMatrix: array`, `assets: Assets` | void |
| `playCascadeStep(nextMatrix, assets, options)` | Animates cascade step | `nextMatrix: array`, `assets: Assets`, `options: object` | Promise |
| `highlightWinningCells(cells, options)` | Highlights winners | `cells: array`, `options: object` | Promise |
| `renderGridFromMatrix(symbolMatrix, assets)` | Renders grid | `symbolMatrix: array`, `assets: Assets` | void |
| `setReelHeights(reelHeights)` | Updates Megaways heights | `reelHeights: array` | void |
| `setTopReel(topReelSymbols)` | Updates top reel | `topReelSymbols: array` | void |
| `setTurboMode(enabled)` | Sets turbo mode | `enabled: boolean` | void |
| `isRunning()` | Checks if spinning | None | boolean |

### AnimationManager.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `playCascadeSequence(cascades, options)` | Plays cascade animations | `cascades: array`, `options: object` | void |
| `highlightWins(step)` | Highlights winning cells | `step: object` | Promise |
| `attachGrid(gridRenderer, assets)` | Attaches grid reference | `gridRenderer: GridRenderer`, `assets: Assets` | void |
| `setTurboMode(enabled)` | Sets turbo mode | `enabled: boolean` | void |

### NetworkManager.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `startSession(operatorId, gameId, payload)` | Starts game session | `operatorId: string`, `gameId: string`, `payload: object` | Promise<object> |
| `play(gameId, requestBody)` | Sends spin request | `gameId: string`, `requestBody: object` | Promise<object> |
| `buyFreeSpins(gameId, requestBody)` | Buys free spins | `gameId: string`, `requestBody: object` | Promise<object> |

### ThemeManager.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `loadTheme(gameId, assetLoader)` | Loads theme assets | `gameId: string`, `assetLoader: Assets` | Promise<object> |

### AudioManager.js

| Method | Purpose | Parameters | Returns |
|--------|---------|------------|---------|
| `load()` | Loads audio files | None | Promise |
| `playBackgroundMusic()` | Plays base game music | None | void |
| `playFreeSpinMusic()` | Plays free spin music | None | void |
| `playSpin()` | Plays spin sound | None | void |
| `playStop()` | Plays stop sound | None | void |
| `playWin()` | Plays win sound | None | void |
| `playBigWin()` | Plays big win sound | None | void |
| `playClick()` | Plays click sound | None | void |
| `setMuted(muted)` | Mutes/unmutes | `muted: boolean` | void |
| `setMusicVolume(volume)` | Sets music volume | `volume: number` | void |
| `setSfxVolume(volume)` | Sets SFX volume | `volume: number` | void |

---

## Animation System

### Spin Animation

**Process**:
1. Enter spin mode (show spin layer, hide grid layer)
2. Start each reel with staggered timing (left to right)
3. Apply blur filter based on speed
4. Random symbols while spinning
5. Preload final textures at 90% completion
6. Ease to stop position
7. Snap to exact position

**Timing**:
- Base time: 1200ms per reel
- Stagger: +200ms per reel
- Extra random: 0-3 positions
- Turbo mode: 40% of base time

**Blur Effect**:
- Blur amount = `speed * SPIN_BLUR_MULTIPLIER` (8)
- Applied vertically for reels, horizontally for top reel
- Removed when stopped

### Cascade Animation

**Process** (per step):
1. **Hold** (0.25s) - Show current grid state
2. **Highlight** (0.60s) - Scale winning symbols up 18%
3. **Post-Delay** (0.50s) - Pause
4. **Fade** (0.50s) - Fade winning symbols to alpha 0
5. **Drop** (0.55s) - Drop remaining symbols down, spawn new from top

**Symbol Drop**:
- Remaining symbols fall to fill gaps
- New symbols spawn above visible area
- Drop with bounce easing (backout 0.8)
- All symbols animate simultaneously

**Turbo Mode**:
- All durations multiplied by 0.4
- 60% faster animations

### Free Spin Transition

**Process**:
1. Hide game elements (scene layer)
2. Hide Background1
3. Show transition layer (video)
4. Play MP4 video full screen
5. Video ends → callback
6. Show Background2
7. Show game elements
8. Continue with normal rendering

---

## State Management

### Game State Flow

```
main.js State:
├── sessionInfo (from backend)
│   ├── sessionId
│   ├── gameId
│   └── balance
├── activeBetMode ('standard' | 'ante')
├── currentBaseBet (number)
└── isTurboMode (boolean)

SceneManager State:
├── columns, rows, maxRows
├── availableSymbols (array)
├── isTurboMode (boolean)
└── gridRenderer, animationManager, audioManager

GridRenderer State:
├── reels[] (array of reel objects)
├── isSpinning (boolean)
├── isCascading (boolean)
├── resultMatrix (array of symbols)
├── reelHeights[] (Megaways)
└── topReel (array of symbols)
```

### State Updates

**On Spin**:
1. `main.js`: Disables controls
2. `GridRenderer`: Sets `isSpinning = true`
3. Backend returns results
4. `GridRenderer`: Sets `isSpinning = false`, `isCascading = true`
5. Animations play
6. `GridRenderer`: Sets `isCascading = false`
7. `main.js`: Enables controls, updates UI

**On Free Spin Trigger**:
1. Backend returns `freeSpinsAwarded > 0`
2. `SceneManager`: Plays transition
3. Switches to Background2
4. Continues with normal flow

---

## Common Patterns

### Promise-Based Async Flow

```javascript
async function doSomething() {
  try {
    await step1();
    await step2();
    return result;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}
```

### Event-Driven UI

```javascript
button.addEventListener('click', () => {
  audioManager.playClick();
  handleAction();
});
```

### Ticker-Based Animation

```javascript
this.tickerCallback = () => {
  // Update every frame
  updatePositions();
  updateBlur();
};
this.app.ticker.add(this.tickerCallback);
```

### GSAP Timeline

```javascript
const tl = gsap.timeline({
  onComplete: () => resolve()
});
tl.to(sprite.scale, { x: 1.2, duration: 0.6 });
tl.to(sprite.scale, { x: 1.0, duration: 0.6 });
```

### Error Handling

```javascript
try {
  const result = await network.play(gameId, payload);
  // Process result
} catch (err) {
  console.error('Spin failed', err);
  // Show error, stop animation
  sceneManager.stopSpinAnimation();
}
```

### Asset Loading

```javascript
const texture = assets.get(symbolCode) ?? assets.get('PLACEHOLDER');
if (!texture) {
  console.warn('Texture not found:', symbolCode);
  return;
}
```

---

## Summary

The frontend is a **well-structured, modular slot game** with:

- **Clear separation of concerns**: Each component has a single responsibility
- **Layered rendering**: Background, scene, and transition layers
- **Dual-layer grid**: Spin layer for animations, grid layer for cascades
- **Promise-based async**: Clean async/await patterns
- **Event-driven UI**: HTML events with PixiJS rendering
- **Turbo mode support**: Faster animations when enabled
- **Megaways support**: Variable reel heights
- **Comprehensive audio**: Music and sound effects with volume control
- **Smooth animations**: GSAP for professional transitions

The codebase is **easy to understand and modify**, with clear patterns and comprehensive error handling.

