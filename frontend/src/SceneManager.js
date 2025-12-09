/**
 * SceneManager.js - Scene Orchestration and Visual Management
 * 
 * Manages the visual presentation of the game, coordinates layers, handles free spin
 * transitions, and processes game results from the backend.
 * 
 * Key Responsibilities:
 * - Manage PixiJS layers (background, scene, transition)
 * - Initialize animated backgrounds (Background1 and Background2)
 * - Handle free spin video transitions
 * - Process game results and trigger appropriate animations
 * - Coordinate between GridRenderer and AnimationManager
 * - Manage audio playback
 * 
 * Layer System:
 * - backgroundLayer: Animated backgrounds (always visible, bottom layer)
 * - sceneLayer: Main game grid (scaled and positioned, middle layer)
 * - transitionLayer: Free spin video transitions (top layer, shown on trigger)
 * 
 * Dependencies:
 * - GridRenderer: Renders the slot grid
 * - AnimationManager: Handles cascade animations
 * - BackgroundAnimation: Animated background sequences
 * - FreeSpinTransition: Video transition for free spins
 * - AudioManager: Sound effects and music
 */

import * as PIXI from 'pixi.js';
import GridRenderer from './GridRenderer.js';
import TopReelRenderer from './TopReelRenderer.js';
import UIRenderer from './UIRenderer.js';
import AnimationManager from './AnimationManager.js';
import BackgroundAnimation from './BackgroundAnimation.js';
import FreeSpinTransition from './FreeSpinTransition.js';
import AudioManager from './AudioManager.js';

/** Symbol alias used as fallback when texture is not found */
const PLACEHOLDER_SYMBOL = 'PLACEHOLDER';

/**
 * SceneManager - Orchestrates the visual presentation of the game
 * 
 * Manages all visual layers, coordinates animations, and processes game results.
 */
export default class SceneManager {
  /**
   * Creates a new SceneManager instance
   * 
   * @param {Object} options - Configuration options
   * @param {PIXI.Application} options.app - PixiJS application instance
   * @param {PIXI.Assets} options.assets - PixiJS Assets API for loading textures
   */
  constructor({ app, assets }) {
    this.app = app; // PixiJS application
    this.assets = assets; // PixiJS Assets API
    
    // Create managers
    this.animationManager = new AnimationManager(); // Handles cascade animations
    this.gridRenderer = null; // Will be created in initialize()
    this.topReelRenderer = null; // Will be created in initialize()
    this.uiRenderer = new UIRenderer({ app }); // UI overlay renderer
    this.audioManager = new AudioManager(); // Sound manager
    
    // Create layer containers (rendering order: background -> scene -> transition)
    this.backgroundLayer = new PIXI.Container(); // Background animations (bottom)
    this.backgroundLayer.visible = true;
    this.backgroundLayer.alpha = 1;
    this.sceneLayer = new PIXI.Container(); // Main game grid (middle)
    this.sceneLayer.visible = true;
    this.sceneLayer.alpha = 1;
    this.transitionLayer = new PIXI.Container(); // Free spin video (top)
    this.transitionLayer.visible = false;
    
    // Background animations
    this.backgroundSprite = null; // Legacy static background (if used)
    this.backgroundAnimation = null; // Background1 (base game, 105 frames)
    this.background2Animation = null; // Background2 (free spins, 151 frames)
    this.freeSpinTransition = null; // Video transition for free spins
    
    // Grid configuration
    this.gridSize = null; // Grid dimensions (width, height)
    this.columns = 0; // Number of columns (from theme manifest)
    this.rows = 0; // Number of rows (from theme manifest)
    this.availableSymbols = []; // List of symbol aliases available
    
    // Resize handler (bound to this instance)
    this.handleResize = () => this.resizeStage();
    
    // Game state
    this.isTurboMode = false; // Turbo mode flag (speeds up animations)
  }

  /**
   * Sets turbo mode on/off
   * 
   * Turbo mode speeds up all animations by 60% (40% of normal duration).
   * Propagates to GridRenderer and AnimationManager.
   * 
   * @param {boolean} enabled - True to enable turbo mode, false to disable
   */
  setTurboMode(enabled) {
    this.isTurboMode = enabled;
    if (this.gridRenderer) {
      this.gridRenderer.setTurboMode(enabled);
    }
    if (this.topReelRenderer) {
      this.topReelRenderer.setTurboMode(enabled);
    }
    if (this.animationManager) {
      this.animationManager.setTurboMode(enabled);
    }
  }

  /**
   * Initializes the game scene
   * 
   * Sets up all layers, loads backgrounds, creates grid renderer, and prepares
   * the scene for gameplay.
   * 
   * Flow:
   * 1. Extract grid dimensions from theme manifest
   * 2. Extract available symbols
   * 3. Add layers to stage in correct order
   * 4. Initialize Background1 animation (base game)
   * 5. Initialize free spin transition video
   * 6. Initialize Background2 animation (free spins, hidden initially)
   * 7. Create GridRenderer with proper dimensions
   * 8. Set up resize handler
   * 9. Load and start audio
   * 
   * @param {Object} themeManifest - Theme configuration from ThemeManager
   * @param {Object} themeManifest.grid - Grid configuration
   * @param {number} themeManifest.grid.columns - Number of columns
   * @param {number} themeManifest.grid.rows - Number of rows
   * @param {number} [themeManifest.grid.maxRows] - Maximum rows for Megaways
   * @param {Array} themeManifest.assets - Asset definitions
   * @returns {Promise<void>}
   */
  async initialize(themeManifest) {
    // Extract grid dimensions
    this.columns = themeManifest.grid.columns;
    this.rows = themeManifest.grid.rows;
    // For Megaways, use maxRows if available, otherwise use rows
    this.maxRows = themeManifest.grid.maxRows || themeManifest.grid.rows || this.rows;
    
    // Extract available symbols (exclude textures and placeholder)
    this.availableSymbols = themeManifest.assets
      .map((asset) => asset.alias)
      .filter((alias) => !alias.includes('TEXTURE') && alias !== PLACEHOLDER_SYMBOL);

    // Add layers to stage in rendering order (bottom to top)
    this.app.stage.addChild(this.backgroundLayer); // Bottom: backgrounds
    this.app.stage.addChild(this.sceneLayer); // Middle: game grid
    this.app.stage.addChild(this.transitionLayer); // Top: free spin video
    
    // Ensure layers are in correct visibility state
    this.backgroundLayer.visible = true;
    this.sceneLayer.visible = true;
    this.transitionLayer.visible = false; // Hidden until free spins trigger
    
    // Initialize Background1 animation (base game background)
    // Uses 105 WebP frames (background1_1.webp to background1_105.webp)
    this.backgroundAnimation = new BackgroundAnimation({
      app: this.app,
      basePath: '/animations/Background1',
      frameCount: 105,
      framePrefix: 'background1_',
      frameExtension: '.webp'
    });
    await this.backgroundAnimation.load();
    this.backgroundLayer.addChild(this.backgroundAnimation.container);
    this.backgroundAnimation.container.visible = true;
    // Resize background to fill screen
    this.backgroundAnimation.resize(this.app.renderer.width, this.app.renderer.height);
    this.backgroundAnimation.play(); // Start animation loop
    
    // Initialize free spin transition video
    // Plays full-screen MP4 video when free spins are triggered
    this.freeSpinTransition = new FreeSpinTransition({
      app: this.app,
      videoPath: '/animations/free spin transistions/PixVerse_V5_Transition_360P.mp4'
    });
    await this.freeSpinTransition.load();
    this.transitionLayer.addChild(this.freeSpinTransition.container);
    
    // Initialize Background2 animation (free spins background)
    // Uses 151 WebP frames (background2_1.webp to background2_151.webp)
    // Hidden until free spins trigger, then shown after transition video
    this.background2Animation = new BackgroundAnimation({
      app: this.app,
      basePath: '/animations/Background2',
      frameCount: 151,
      framePrefix: 'background2_',
      frameExtension: '.webp'
    });
    await this.background2Animation.load();
    this.background2Animation.container.visible = false; // Hidden until free spins
    this.backgroundLayer.addChild(this.background2Animation.container);

    this.gridRenderer = new GridRenderer({
      app: this.app,
      columns: this.columns,
      rows: this.maxRows, // Use maxRows for Megaways support
      textureBehindSymbols: this.assets.get('STONE_TEXTURE')
    });
    this.gridRenderer.initialize(this.sceneLayer);
    this.gridRenderer.setAvailableSymbols(this.availableSymbols);
    // Set default reel heights for initial display (will be updated on first spin)
    // For Megaways, use default heights matching the original 6x5 grid initially
    const defaultHeights = Array(this.columns).fill(this.rows);
    this.gridRenderer.setReelHeights(defaultHeights);
    this.gridSize = this.gridRenderer.getSize();
    // Initialize reels with random symbols for initial display
    this.gridRenderer.initializeReels(this.assets);
    
    // Position megaways display initially
    this.gridRenderer.positionMegawaysDisplay();
    
    // Initialize TopReelRenderer for horizontal top reel above reels 2-5
    const reelWidth = this.gridRenderer.reelWidth || 140;
    const symbolSize = this.gridRenderer.symbolSize || 140;
    this.topReelRenderer = new TopReelRenderer({
      app: this.app,
      reelWidth: reelWidth,
      symbolSize: symbolSize,
      coversReels: [1, 2, 3, 4], // Reels 2-5 (indices 1-4)
      symbolCount: 4
    });
    this.topReelRenderer.initialize(this.sceneLayer, -symbolSize); // Position above main grid
    this.topReelRenderer.setAvailableSymbols(this.availableSymbols);
    
    this.animationManager.attachGrid(this.gridRenderer, this.assets);
    this.resizeStage();

    window.addEventListener('resize', this.handleResize);
    this.uiRenderer.initialize(this.app.stage);
    
    // Force initial resize to position everything
    this.resizeStage();
    
    console.log('SceneManager initialized:', {
      columns: this.columns,
      rows: this.rows,
      maxRows: this.maxRows,
      gridSize: this.gridSize,
      backgroundVisible: this.backgroundLayer.visible,
      sceneVisible: this.sceneLayer.visible,
      reelsCount: this.gridRenderer?.reels?.length || 0
    });
    
    // Load and start audio
    await this.audioManager.load();
    this.audioManager.playBackgroundMusic();
  }

  /**
   * Processes game results and triggers appropriate animations
   * 
   * Main entry point for rendering spin results. Checks if free spins were
   * triggered and plays transition video if needed, otherwise proceeds with
   * normal result rendering.
   * 
   * Free spin triggers:
   * 1. Buy free spins feature (freeSpinsAwarded > 0)
   * 2. Scatter win (freeSpins.JustTriggered === true)
   * 
   * @param {Object} results - Game results from backend
   * @param {Object} [playResponse] - Full play response (includes win, balance, etc.)
   */
  renderResults(results, playResponse = null) {
    if (!results || !this.gridRenderer) {
      return;
    }

    // Check if free spins were triggered
    // Free spins can be triggered by:
    // 1. Buy free spins feature (freeSpinsAwarded > 0 in response)
    // 2. Scatter win that triggers free spins (results.freeSpins?.JustTriggered === true)
    const freeSpinsAwarded = playResponse?.freeSpinsAwarded ?? 0;
    const freeSpinsJustTriggered = results.freeSpins?.JustTriggered ?? results.freeSpins?.triggeredThisSpin ?? false;
    const isFreeSpinTriggered = freeSpinsAwarded > 0 || freeSpinsJustTriggered;

    console.log('Free spin check:', { freeSpinsAwarded, freeSpinsJustTriggered, isFreeSpinTriggered, hasTransition: !!this.freeSpinTransition });

    // Play free spin transition if triggered
    if (isFreeSpinTriggered && this.freeSpinTransition) {
      console.log('Playing free spin transition');
      // Switch to free spin music
      this.audioManager.playFreeSpinMusic();
      // Play transition video, then continue with results
      return this.playFreeSpinTransition(() => {
        this.continueRenderResults(results, playResponse);
      });
    }

    // No free spins triggered, proceed with normal rendering
    this.continueRenderResults(results, playResponse);
  }

  /**
   * Continues rendering results after free spin transition (if any)
   * 
   * Handles the actual result rendering:
   * - Updates Megaways reel heights if variable
   * - Updates top reel symbols if present
   * - Displays ways-to-win count
   * - Handles cascades or final grid display
   * - Triggers cascade animations
   * - Plays win sounds
   * 
   * @param {Object} results - Game results from backend
   * @param {Object} [playResponse] - Full play response
   */
  continueRenderResults(results, playResponse = null) {
    if (!results || !this.gridRenderer) {
      return;
    }

    // Extract Megaways data (for variable reel heights)
    const reelHeights = results.reelHeights; // Array of heights per column
    const topReelSymbols = results.topReelSymbols; // Symbols for horizontal top reel
    const waysToWin = results.waysToWin; // Total ways to win (Megaways calculation)

    // Update reel heights if variable (Megaways support)
    if (reelHeights && reelHeights.length > 0) {
      console.log('[SceneManager] continueRenderResults: Setting reel heights', reelHeights);
      this.gridRenderer.setReelHeights(reelHeights);
    }

    // Update top reel symbols on BOTH renderers
    if (topReelSymbols && topReelSymbols.length > 0) {
      // Set on TopReelRenderer (separate component)
      if (this.topReelRenderer) {
        this.topReelRenderer.setSymbols(topReelSymbols);
      }
      // CRITICAL: Also set on GridRenderer (used for grid layer rendering)
      this.gridRenderer.setTopReel(topReelSymbols);
    }

    // Update ways-to-win display in UI (Megaways feature)
    // Note: Progressive update happens in GridRenderer as each reel stops
    // This is just for initial setup/reset
    if (waysToWin !== null && waysToWin !== undefined) {
      const waysBox = document.getElementById('ways-to-win-box');
      if (waysBox) {
        waysBox.style.display = 'block'; // Always visible
        // Position it above reel 6
        if (this.gridRenderer) {
          this.gridRenderer.positionMegawaysDisplay();
        }
      }
      // Number will be updated progressively as reels stop
      // Don't set initial value here - it starts blank and counts up
    }

    // Extract cascade data
    const cascades = results.cascades ?? []; // Array of cascade steps
    const finalReelSymbols = results.reelSymbols; // Final grid state as jagged array (if no cascades)

    // No cascades - just show final grid
    if (!cascades.length) {
      if (Array.isArray(finalReelSymbols) && finalReelSymbols.length > 0) {
        console.log('[SceneManager] continueRenderResults: No cascades, final reel symbols received', {
          columns: finalReelSymbols.length,
          reelLengths: finalReelSymbols.map(reel => reel.length),
          isSpinning: this.gridRenderer?.isSpinning,
          isRunning: this.gridRenderer?.isRunning()
        });
        
        // CRITICAL: Preload result IMMEDIATELY when backend response arrives
        // This applies final textures to spinning reels DURING the spin animation
        // so they stop on the correct symbols, not random ones
        // NOTE: Only call if resultMatrix doesn't exist yet (to avoid overwriting already-applied textures)
        if (!this.gridRenderer.resultMatrix || !this.gridRenderer.isRunning()) {
          console.log('[SceneManager] continueRenderResults: Calling preloadSpinResult IMMEDIATELY');
          this.gridRenderer.preloadSpinResult(finalReelSymbols, this.assets);
          if (this.topReelRenderer && topReelSymbols && topReelSymbols.length > 0) {
            this.topReelRenderer.preloadSpinResult(topReelSymbols, this.assets);
          }
          console.log('[SceneManager] continueRenderResults: preloadSpinResult completed');
        } else {
          console.log('[SceneManager] continueRenderResults: Skipping preloadSpinResult - resultMatrix already exists and spin is running');
        }

        /**
         * Shows final grid after spin completes
         * Called either immediately (if spin already stopped) or as callback when spin completes
         * Note: Textures are already applied by preloadSpinResult above, so transition is smooth
         */
        const showFinalGrid = async () => {
          this.audioManager.playStop(); // Play reel stop sound
          // Transition from spinning reels to static grid
          // Textures are already applied, so this is just a layer switch
          await this.gridRenderer.transitionSpinToGrid(finalReelSymbols, this.assets);
          if (this.topReelRenderer && topReelSymbols && topReelSymbols.length > 0) {
            await this.topReelRenderer.transitionSpinToGrid(topReelSymbols, this.assets);
          }
          
          // Play win sound if there's a win
          if (playResponse && playResponse.win) {
            const winAmount = typeof playResponse.win === 'number' ? playResponse.win : (playResponse.win?.amount ?? 0);
            if (winAmount > 0) {
              // Consider it a big win if win is 10x or more of base bet
              const baseBet = playResponse.baseBet ?? 0.2;
              if (winAmount >= baseBet * 10) {
                this.audioManager.playBigWin();
              } else {
                this.audioManager.playWin();
              }
            }
          }
        };

        // If reels are still spinning, wait for them to complete
        if (this.gridRenderer.isRunning()) {
          this.gridRenderer.onSpinComplete = showFinalGrid;
        } else {
          // Reels already stopped, show grid immediately
          showFinalGrid();
        }
      }
      return;
    }

    // Cascades exist - animate them step by step
    const firstCascade = cascades[0];

    // Preload first cascade result immediately so textures are applied during spin
    // This prevents texture flicker when reels stop
    if (Array.isArray(firstCascade.reelSymbolsBefore)) {
      this.gridRenderer.preloadSpinResult(firstCascade.reelSymbolsBefore, this.assets);
    }
    // Top reel symbols are handled separately in cascade steps

    /**
     * Starts cascade animation sequence
     * Called after reels stop spinning
     */
    const startCascades = async () => {
      this.audioManager.playStop(); // Play reel stop sound
      
      // Transition from spinning reels to first cascade grid state
      if (Array.isArray(firstCascade.reelSymbolsBefore)) {
        await this.gridRenderer.transitionSpinToGrid(firstCascade.reelSymbolsBefore, this.assets);
      }
      // Top reel transition is handled in cascade steps

      // Play cascade sequence (highlights wins, fades symbols, drops new ones)
      this.animationManager.playCascadeSequence(cascades, {
        gridRenderer: this.gridRenderer,
        assets: this.assets,
        audioManager: this.audioManager,
        playResponse: playResponse,
        isTurboMode: this.isTurboMode
      });
      
      // Play win sound if there's a win (check final cascade or playResponse)
      // This plays after all cascades complete
      if (playResponse && playResponse.win) {
        const winAmount = typeof playResponse.win === 'number' ? playResponse.win : (playResponse.win?.amount ?? 0);
        if (winAmount > 0) {
          // Consider it a big win if win is 10x or more of base bet
          const baseBet = playResponse.baseBet ?? 0.2;
          if (winAmount >= baseBet * 10) {
            this.audioManager.playBigWin();
          } else {
            this.audioManager.playWin();
          }
        }
      }
    };

    // If reels are still spinning, wait for them to complete
    if (this.gridRenderer.isRunning()) {
      this.gridRenderer.onSpinComplete = startCascades;
    } else {
      // Reels already stopped, start cascades immediately
      startCascades();
    }
  }

  /**
   * Handles window resize events
   * 
   * Resizes all layers and backgrounds to match new window size.
   * Called automatically when window is resized.
   */
  resizeStage() {
    const rendererWidth = this.app.renderer.width;
    const rendererHeight = this.app.renderer.height;

    // Resize animated backgrounds to fill screen
    if (this.backgroundAnimation) {
      this.backgroundAnimation.resize(rendererWidth, rendererHeight);
    }
    if (this.background2Animation) {
      this.background2Animation.resize(rendererWidth, rendererHeight);
    }

    // Resize free spin transition video to fill screen
    if (this.freeSpinTransition) {
      this.freeSpinTransition.resize(rendererWidth, rendererHeight);
    }

    // Legacy static background (if still exists)
    if (this.backgroundSprite) {
      this.backgroundSprite.width = rendererWidth;
      this.backgroundSprite.height = rendererHeight;
      this.backgroundSprite.x = 0;
      this.backgroundSprite.y = 0;
    }

    // Reposition scene layer (grid) to center on screen
    this.positionSceneLayer();
  }

  /**
   * Plays free spin transition video
   * 
   * When free spins are triggered, this plays a full-screen video transition,
   * then switches to Background2 animation and shows game elements again.
   * 
   * Flow:
   * 1. Stop any running spin
   * 2. Hide game elements and Background1
   * 3. Show transition layer
   * 4. Play video
   * 5. When video ends: show Background2, show game elements, hide transition
   * 6. Call completion callback
   * 
   * @param {Function} onComplete - Callback called when transition completes
   * @returns {Promise<void>}
   */
  async playFreeSpinTransition(onComplete) {
    console.log('playFreeSpinTransition called', { hasTransition: !!this.freeSpinTransition });
    if (!this.freeSpinTransition) {
      console.warn('No free spin transition available');
      if (onComplete) onComplete();
      return Promise.resolve();
    }

    // Stop any running spin during transition
    if (this.gridRenderer && this.gridRenderer.isRunning()) {
      this.gridRenderer.stopSpin();
    }

    // Hide game elements during transition (but keep background visible)
    this.sceneLayer.visible = false;
    // Hide background1, will show background2 after transition
    if (this.backgroundAnimation) {
      this.backgroundAnimation.container.visible = false;
    }
    this.backgroundLayer.visible = true;
    
    // Ensure transition layer is visible and on top
    this.transitionLayer.visible = true;
    this.transitionLayer.zIndex = 9999; // Ensure it's on top

    // Play transition animation
    return new Promise((resolve) => {
      this.freeSpinTransition.play(() => {
        console.log('Free spin transition completed');
        
        // Switch to Background2 after transition
        if (this.background2Animation) {
          this.background2Animation.container.visible = true;
          this.background2Animation.play();
        }
        
        // Show game elements after transition
        this.sceneLayer.visible = true;
        this.backgroundLayer.visible = true;
        this.transitionLayer.visible = false;
        
        if (onComplete) {
          onComplete();
        }
        resolve();
      });
    });
  }

  /**
   * Positions the scene layer (grid) on screen
   * 
   * Centers the grid on screen and applies scale/offset adjustments.
   * Can be customized via SLOT_SCALE and SLOT_Y_OFFSET constants.
   */
  positionSceneLayer() {
    if (!this.gridSize) {
      return;
    }

    const rendererWidth = this.app.renderer.width;
    const rendererHeight = this.app.renderer.height;
    
    // Use actual grid size from GridRenderer (includes all reels and top reel)
    const actualGridWidth = this.gridSize.width;
    const actualGridHeight = this.gridSize.height;
    
    // Reserve space for UI elements
    // Top reel sits directly above grid (no margin) at -symbolSize
    // Game info bar: ~35px height
    // Bottom panel: ~50px height
    // Bottom controls: ~35px height
    // Total: ~120px for bottom safety margin
    const bottomUIHeight = 120; // Reserve 120px for bottom UI (game info bar, bet, spin, total win, controls)
    const sidePadding = 20; // Small padding on sides
    
    // Calculate available space for grid (including space for top reel which is part of grid)
    const availableWidth = rendererWidth - (sidePadding * 2);
    // Reserve space for top reel (symbolSize) - will calculate scaled size after scale is determined
    const tempAvailableHeight = rendererHeight - bottomUIHeight;
    
    // Calculate scale to fit grid in available space
    // Allow grid to scale larger to fill more of the screen (75-80% target)
    const scaleX = availableWidth / actualGridWidth;
    const scaleY = tempAvailableHeight / (actualGridHeight + (this.gridRenderer?.symbolSize || 140));
    const scale = Math.min(scaleX, scaleY); // Allow scaling beyond 100% if needed
    
    this.sceneLayer.scale.set(scale);
    
    // Calculate scaled symbol size for top reel space
    const symbolSize = this.gridRenderer?.symbolSize || 140;
    const scaledSymbolSize = symbolSize * scale;
    const topUIHeight = scaledSymbolSize; // Reserve space for top reel (one symbol height)
    
    // Recalculate available height with top space reserved
    const availableHeight = rendererHeight - topUIHeight - bottomUIHeight;
    
    // Center the container
    const scaledWidth = actualGridWidth * scale;
    const scaledHeight = actualGridHeight * scale;
    
    // Center X with side padding
    this.sceneLayer.x = (rendererWidth - scaledWidth) / 2;
    
    // Position Y: start from top space reserved for top reel
    // Top reel sits directly above grid with no gap (top reel at y=0, main grid visible area starts at y=symbolSize)
    // Move grid up by 50px
    const remainingHeight = rendererHeight - topUIHeight - bottomUIHeight;
    this.sceneLayer.y = topUIHeight + (remainingHeight - scaledHeight) / 2 - 50;
    
    // Update megaways display position
    if (this.gridRenderer) {
      this.gridRenderer.positionMegawaysDisplay();
    }
  }

  // Removed renderPlaceholderBoard - reels are initialized with random symbols

  /**
   * Preloads spin result data before starting visual spin
   * 
   * This sets reel heights and ensures reels are built with correct sizes
   * BEFORE the spin starts, preventing gaps and rerendering.
   * 
   * @param {Object} results - Game results from backend
   */
  preloadSpinResult(results) {
    if (!results || !this.gridRenderer) {
      return;
    }

    // Extract Megaways data (for variable reel heights)
    const reelHeights = results.reelHeights; // Array of heights per column
    const topReelSymbols = results.topReelSymbols; // Symbols for horizontal top reel
    const finalReelSymbols = results.reelSymbols; // Final grid state as jagged array

    // CRITICAL: Set reel heights FIRST before building/starting spin
    // This ensures symbols are built with correct sizes from the start
    if (reelHeights && reelHeights.length > 0) {
      console.log('[SceneManager] preloadSpinResult: Setting reel heights BEFORE spin', reelHeights);
      this.gridRenderer.setReelHeights(reelHeights);
    }

    // Update top reel symbols
    if (topReelSymbols && topReelSymbols.length > 0) {
      if (this.topReelRenderer) {
        this.topReelRenderer.setSymbols(topReelSymbols);
      }
      this.gridRenderer.setTopReel(topReelSymbols);
    }

    // CRITICAL: Build reels with correct sizes if they don't exist yet
    // This ensures reels are created with the right symbol sizes from the start
    if (this.gridRenderer.reels.length === 0) {
      console.log('[SceneManager] preloadSpinResult: Building reels with correct sizes');
      this.gridRenderer.buildReels(this.assets);
    }

    // CRITICAL: Preload textures BEFORE spin starts
    // This applies final textures so reels spin with correct symbols and sizes
    if (Array.isArray(finalReelSymbols) && finalReelSymbols.length > 0) {
      console.log('[SceneManager] preloadSpinResult: Preloading textures BEFORE spin');
      this.gridRenderer.preloadSpinResult(finalReelSymbols, this.assets);
      if (this.topReelRenderer && topReelSymbols && topReelSymbols.length > 0) {
        this.topReelRenderer.preloadSpinResult(topReelSymbols, this.assets);
      }
    }
  }

  /**
   * Starts the spin animation
   * 
   * Called when user clicks spin button. Starts visual reel spinning
   * and plays spin sound effect.
   * 
   * NOTE: preloadSpinResult() should be called FIRST to set correct sizes
   */
  startSpinAnimation() {
    if (!this.gridRenderer || this.availableSymbols.length === 0) {
      return;
    }
    this.gridRenderer.startSpin(this.assets); // Start visual spin
    if (this.topReelRenderer) {
      this.topReelRenderer.startSpin(this.assets); // Start top reel horizontal spin
    }
    this.audioManager.playSpin(); // Play spin sound
  }

  /**
   * Stops the spin animation
   * 
   * Called on error or when spin needs to be stopped immediately.
   * Used for error recovery.
   */
  stopSpinAnimation() {
    if (!this.gridRenderer) {
      return;
    }
    this.gridRenderer.stopSpin();
    if (this.topReelRenderer) {
      this.topReelRenderer.stopSpin();
    }
  }
}
