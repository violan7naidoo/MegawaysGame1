/**
 * AnimationManager.js - Cascade Sequence Animations
 * 
 * Manages cascade sequence animations including win highlighting, symbol fading,
 * and symbol dropping. Coordinates timing between cascade steps.
 * 
 * Animation Timeline (per cascade step):
 * 1. Hold (0.25s) - Show grid with current state
 * 2. Highlight (0.60s) - Scale up winning symbols
 * 3. Post-Delay (0.50s) - Pause before cascade
 * 4. Fade (0.50s) - Fade out winning symbols
 * 5. Drop (0.55s) - Drop remaining/new symbols
 * 
 * Turbo Mode: All durations multiplied by 0.4 (60% faster)
 * 
 * Dependencies:
 * - GSAP: Animation library for smooth transitions
 */

import { gsap } from 'gsap';

/** Duration to hold grid state before highlighting (seconds) */
const STATIC_HOLD_DURATION = 0.25;
/** Duration for win highlight animation (seconds) */
const HIGHLIGHT_DURATION = 0.60;
/** Delay after highlight before cascade starts (seconds) */
const POST_HIGHLIGHT_DELAY = 0.50;
/** Duration for fading out winning symbols (seconds) */
const CASCADE_FADE_DURATION = 0.50;
/** Duration for dropping symbols (seconds) */
const CASCADE_DROP_DURATION = 0.55;

/** Turbo mode multiplier - speeds up animations by 60% (40% of normal duration) */
const TURBO_MULTIPLIER = 0.4;

/**
 * AnimationManager - Manages cascade sequence animations
 */
export default class AnimationManager {
  /**
   * Creates a new AnimationManager instance
   */
  constructor() {
    this.grid = null; // GridRenderer reference
    this.assets = null; // PixiJS Assets reference
    this.activeSequence = null; // Currently running cascade sequence promise
    this.isTurboMode = false; // Turbo mode flag
  }

  /**
   * Sets turbo mode on/off
   * 
   * @param {boolean} enabled - True to enable turbo mode
   * @returns {void}
   */
  setTurboMode(enabled) {
    this.isTurboMode = enabled;
  }

  /**
   * Attaches grid renderer and assets
   * 
   * @param {GridRenderer} gridRenderer - Grid renderer instance
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  attachGrid(gridRenderer, assets) {
    this.grid = gridRenderer;
    this.assets = assets;
  }

  /**
   * Plays cascade sequence animations
   * 
   * Main entry point for cascade animations. Processes cascade array step-by-step:
   * For each cascade:
   * 1. Renders grid before state
   * 2. Waits (hold duration)
   * 3. Highlights wins
   * 4. Plays win sound
   * 5. Waits (post-delay)
   * 6. Fades out winners
   * 7. Drops new symbols
   * 
   * Supports turbo mode (multiplies durations by 0.4).
   * 
   * @param {Array} cascades - Array of cascade step objects
   * @param {Object} [options] - Animation options
   * @param {GridRenderer} [options.gridRenderer] - Grid renderer (overrides attached)
   * @param {PIXI.Assets} [options.assets] - Assets (overrides attached)
   * @param {AudioManager} [options.audioManager] - Audio manager for win sounds
   * @param {Object} [options.playResponse] - Full play response (for win amount calculation)
   * @param {boolean} [options.isTurboMode] - Turbo mode flag (overrides instance flag)
   * @returns {void}
   */
  playCascadeSequence(cascades, { gridRenderer, assets, audioManager, playResponse, isTurboMode = false } = {}) {
    if (gridRenderer) {
      this.grid = gridRenderer;
    }
    if (assets) {
      this.assets = assets;
    }
    this.audioManager = audioManager;
    this.playResponse = playResponse;
    this.isTurboMode = isTurboMode;

    if (!this.grid || !this.assets || !cascades || cascades.length === 0) {
      return;
    }

    const sequence = async () => {
      if (this.grid) {
        if (typeof this.grid.enterGridMode === 'function') {
          this.grid.enterGridMode();
        } else {
          this.grid.isCascading = true;
        }
      }
      for (let i = 0; i < cascades.length; i += 1) {
        const step = cascades[i];

        if (Array.isArray(step.reelSymbolsBefore)) {
          this.grid.renderGridFromMatrix(step.reelSymbolsBefore, this.assets);
        }

        const holdDuration = this.isTurboMode ? STATIC_HOLD_DURATION * TURBO_MULTIPLIER : STATIC_HOLD_DURATION;
        await this._delay(holdDuration);
        await this.highlightWins(step);
        
        // Play win sound for tumble wins
        if (this.audioManager && step.winsAfterCascade && step.winsAfterCascade.length > 0) {
          // Calculate total win amount for this cascade step
          let stepWinAmount = 0;
          step.winsAfterCascade.forEach(win => {
            if (win && typeof win.amount === 'number') {
              stepWinAmount += win.amount;
            } else if (win && win.amount && typeof win.amount.amount === 'number') {
              stepWinAmount += win.amount.amount;
            }
          });
          
          if (stepWinAmount > 0) {
            // Consider it a big win if win is 10x or more of base bet
            const baseBet = this.playResponse?.baseBet ?? 0.2;
            if (stepWinAmount >= baseBet * 10) {
              this.audioManager.playBigWin();
            } else {
              this.audioManager.playWin();
            }
          }
        }
        
        const postDelay = this.isTurboMode ? POST_HIGHLIGHT_DELAY * TURBO_MULTIPLIER : POST_HIGHLIGHT_DELAY;
        await this._delay(postDelay);

        const winningIndices = [];
        (step.winsAfterCascade ?? []).forEach((win) => {
          if (Array.isArray(win?.indices)) {
            win.indices.forEach((idx) => {
              if (Number.isFinite(idx)) {
                winningIndices.push(idx);
              }
            });
          }
        });
        this.grid.pendingWinningIndices = winningIndices;

        if (Array.isArray(step.reelSymbolsAfter)) {
          const fadeDuration = this.isTurboMode ? CASCADE_FADE_DURATION * TURBO_MULTIPLIER : CASCADE_FADE_DURATION;
          const dropDuration = this.isTurboMode ? CASCADE_DROP_DURATION * TURBO_MULTIPLIER : CASCADE_DROP_DURATION;
          await this.grid.playCascadeStep(step.reelSymbolsAfter, this.assets, {
            fadeDuration: fadeDuration,
            dropDuration: dropDuration
          });
        }
      }
      if (this.grid) {
        this.grid.isCascading = false;
        this.grid.pendingWinningIndices = null;
      }
    };

    const runPromise = this.activeSequence ? this.activeSequence.then(sequence) : sequence();
    this.activeSequence = runPromise.finally(() => {
      if (this.activeSequence === runPromise) {
        this.activeSequence = null;
      }
    });
  }

  /**
   * Highlights winning symbols
   * 
   * Extracts winning cell positions from cascade step and highlights them
   * with a scale animation. Handles both explicit indices and symbol matching.
   * 
   * @param {Object} step - Cascade step object
   * @param {Array} [step.winsAfterCascade] - Array of win objects
   * @param {Array} [step.reelSymbolsBefore] - Reel symbols before cascade (jagged array)
   * @returns {Promise<void>} Resolves when highlight animation completes
   */
  highlightWins(step) {
    if (!this.grid || !step) {
      return Promise.resolve();
    }

    const winCells = []; // Array of {row, col} positions to highlight
    const wins = Array.isArray(step.winsAfterCascade) ? step.winsAfterCascade : [];

    // Extract win cells from explicit indices
    wins.forEach((win) => {
      if (!win) {
        return;
      }

      if (Array.isArray(win.indices)) {
        win.indices.forEach((idx) => {
          if (!Number.isFinite(idx)) {
            return;
          }
          // Convert flat index to row/col
          const row = Math.floor(idx / this.grid.columns);
          const col = idx % this.grid.columns;
          winCells.push({ row, col });
        });
      }
    });

    // If no explicit indices, try to match by symbol code in jagged array
    if (winCells.length === 0 && Array.isArray(step.reelSymbolsBefore)) {
      const reelSymbols = step.reelSymbolsBefore;
      wins.forEach((win) => {
        if (!win?.symbolCode) {
          return;
        }
        const targetSymbol = win.symbolCode;
        const targetCount = Number.isFinite(win.count) ? win.count : null;
        const matches = [];
        // Find all matching symbols in jagged array structure
        for (let col = 0; col < reelSymbols.length; col += 1) {
          const reel = reelSymbols[col];
          if (Array.isArray(reel)) {
            for (let row = 0; row < reel.length; row += 1) {
              if (reel[row] === targetSymbol) {
                matches.push({ row, col });
              }
            }
          }
        }
        // Use first N matches if count is specified
        const indicesToUse =
          targetCount && matches.length > targetCount ? matches.slice(0, targetCount) : matches;
        winCells.push(...indicesToUse);
      });
    }

    if (winCells.length === 0) {
      return Promise.resolve();
    }

    // Highlight winning cells with scale animation
    return this.grid.highlightWinningCells(winCells, {
      scaleAmount: 1.18, // Scale up 18%
      duration: HIGHLIGHT_DURATION
    });
  }

  /**
   * Creates a delay promise using GSAP
   * 
   * @private
   * @param {number} seconds - Delay duration in seconds
   * @returns {Promise<void>} Resolves after delay
   */
  _delay(seconds) {
    return new Promise((resolve) => {
      gsap.delayedCall(seconds, resolve);
    });
  }
}

