Complete flow: what happens when you press the spin button
Step 1: Button click → Backend request (main.js)
When you click the spin button:
Location: frontend/src/main.js → startSpin() function (line 459)
Action: Sends a request to the backend API (network.play())
Backend response includes:
reelHeights: Array like [5, 3, 4, 5, 6, 2] (how many symbols per reel)
reelSymbols: Jagged array [[BIRD, GREEN], [PURPLE, FACE, BLUE], ...] (actual symbols)
topReelSymbols: Array like [BLUE, RED, POT, ORANGE] (top reel symbols)
waysToWin: Number (e.g., 5400)
Step 2: Preload backend data (SceneManager.js)
Before the visual spin starts:
Location: frontend/src/SceneManager.js → preloadSpinResult() (line 656)
Actions:
Sets reelHeights so the grid knows how many symbols each reel will have
Calls gridRenderer.setReelHeights() to update symbol sizes
Calls gridRenderer.preloadSpinResult() to apply final textures
Step 3: Apply textures to spinning reels (GridRenderer.js)
Location: frontend/src/GridRenderer.js → preloadSpinResult() (line 1668)
Action: Applies the final backend textures to the spinning sprites
Result: Reels spin with the correct symbols already applied, so they stop on the right images
Step 4: Start visual spin animation (GridRenderer.js)
Location: frontend/src/GridRenderer.js → startSpin() (line 813)
Actions:
Builds reels if needed (creates sprite containers)
Starts GSAP tweens to animate each reel downward
Each reel stops sequentially (100ms delay between reels)
Step 5: Where do images come from during spinning?
A. Initial build (buildReels)
Location: frontend/src/GridRenderer.js → buildReels() (line 354)
Creates a pool of sprites (e.g., 7-8 per reel) with random textures from available symbols
These are the sprites that scroll during the spin
B. During spin (setupTicker)
Location: frontend/src/GridRenderer.js → setupTicker() (line 565)
The ticker runs every frame (~60fps)
Updates positions: moves sprites down based on reel.position
Updates textures: randomly changes textures as symbols enter the visible area (lines 696-726)
But: if resultMatrix exists (backend data loaded), it stops applying random textures and uses the preloaded final textures
Step 6: When do reels change to fit different arrays?
Dynamic sizing happens in two places:
Before spin starts (preloadSpinResult):
Location: frontend/src/GridRenderer.js → preloadSpinResult() (line 1687)
Calls _updateReelScalingForHeights() to resize all symbols based on reelHeights
Example: If reel 0 has 2 symbols, each symbol is stretched to fill half the column height
During spin (ticker):
Location: frontend/src/GridRenderer.js → setupTicker() (line 660)
Continuously uses _getDynamicSymbolHeight(i) to calculate correct size per reel
Ensures symbols always fill the reel space with no gaps
Step 7: When do images change to backend results?
The images change at two points:
During spin (invisible transition):
Location: frontend/src/GridRenderer.js → preloadSpinResult() → _applyResultToReelSpinLayer() (line 1816)
When: Immediately after backend response arrives (before spin starts)
How: Calculates which sprites will be visible when the reel stops, then applies the correct textures
Result: Reels spin with correct symbols already applied, so you don't see a change at stop
After spin stops (grid layer):
Location: frontend/src/GridRenderer.js → transitionSpinToGrid() (line 1595)
When: After all reels stop spinning
How: Hides the spin layer, shows the grid layer with final symbols
Result: Final static display
Step 8: Reel strips — predefined arrays
Reel strips are predefined lists of symbols:
Backend: configs/JungleRelicsReelsets.json contains arrays like:
  {
    "reelSetId": "base",
    "reels": [
      ["BIRD", "GREEN", "BLUE", "RED", "PURPLE", ...],  // Reel 0 strip
      ["SCARAB", "ORANGE", "BIRD", "GREEN", ...],       // Reel 1 strip
      ...
    ]
  }

  Each reel is a long array (e.g., 100+ symbols)
The backend picks a random starting position on each strip
The frontend doesn't load these strips directly; it receives the final result (reelSymbols) from the backend
Visual summary
1. [USER CLICKS SPIN]   ↓2. [BACKEND REQUEST] → Gets reelHeights, reelSymbols, topReelSymbols   ↓3. [PRELOAD DATA] → Sets sizes, applies textures to spinning sprites   ↓4. [START VISUAL SPIN] → Reels start moving (with correct symbols already applied)   ↓5. [TICKER UPDATES] → Moves sprites, maintains correct sizes (no random textures if resultMatrix exists)   ↓6. [REELS STOP] → One by one, stopping on pre-applied correct symbols   ↓7. [TRANSITION TO GRID] → Hide spin layer, show grid layer with final symbols
Key points
Images come from: PIXI.Assets loaded by ThemeManager (symbol textures like "BIRD.png", "GREEN.png", etc.)
Reel strips: Backend uses predefined strips, but the frontend receives the final result array
Dynamic sizing: Happens before spin starts and continuously during spin
Texture changes: Applied during preloadSpinResult (before spin starts), so reels stop on correct symbols
No rerendering: Textures are pre-applied, so you don't see symbols change after stopping
The system knows the dimensions and symbols before the spin starts, so everything is pre-sized and pre-textured for a smooth stop.