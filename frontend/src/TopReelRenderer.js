/**
 * TopReelRenderer.js - Horizontal Top Reel Renderer
 * 
 * Renders and animates the horizontal top reel that appears above reels 2-5 (indices 1-4).
 * This is a separate component from the main grid renderer because it has different physics:
 * - Horizontal scrolling (X-axis) instead of vertical (Y-axis)
 * - Symbols slide LEFT when gaps appear
 * - New symbols enter from RIGHT edge
 * - No vertical movement
 * 
 * Key Features:
 * - Horizontal spin animation (right-to-left scrolling)
 * - Cascade animations with horizontal slide
 * - Smooth symbol transitions
 * - Turbo mode support
 * 
 * Dependencies:
 * - PixiJS: WebGL rendering
 * - GSAP: Animation library
 */

import * as PIXI from 'pixi.js';
import { gsap } from 'gsap';

/** Base spin duration in milliseconds */
const SPIN_BASE_TIME = 1200;
/** Additional time per reel for stagger effect (milliseconds) */
const SPIN_STAGGER_TIME = 200;
/** Base number of positions to spin (higher = more rotations) */
const SPIN_BASE_TARGET = 15;
/** Additional positions per reel for stagger */
const SPIN_STAGGER_TARGET = 1;
/** Blur effect multiplier (higher = more blur at speed) */
const SPIN_BLUR_MULTIPLIER = 8;
/** Easing curve amount (0-1, affects deceleration) */
const SPIN_EASING_AMOUNT = 0.2;
/** Cascade slide duration in seconds (horizontal) */
const CASCADE_SLIDE_DURATION = 0.3;
/** Cascade fade duration in seconds */
const CASCADE_FADE_DURATION = 0.15;

/**
 * TopReelRenderer - Renders horizontal top reel above reels 2-5
 */
export default class TopReelRenderer {
  /**
   * Creates a new TopReelRenderer instance
   * 
   * @param {Object} options - Configuration options
   * @param {PIXI.Application} options.app - PixiJS application
   * @param {number} options.reelWidth - Width of each reel column in pixels
   * @param {number} options.symbolSize - Size of symbols in pixels
   * @param {Array<number>} options.coversReels - Array of reel indices covered by top reel (e.g., [1, 2, 3, 4])
   * @param {number} options.symbolCount - Number of visible symbols (default: 4)
   */
  constructor({
    app,
    reelWidth,
    symbolSize,
    coversReels = [1, 2, 3, 4],
    symbolCount = 4
  }) {
    this.app = app;
    this.reelWidth = reelWidth;
    this.symbolSize = symbolSize;
    this.coversReels = coversReels;
    this.symbolCount = symbolCount;
    
    // Container and layers
    this.container = new PIXI.Container();
    this.spinLayer = new PIXI.Container();
    this.gridLayer = new PIXI.Container();
    
    // Symbol management
    this.symbols = []; // Array of symbol sprites for spinning
    this.gridSprites = []; // Array of grid sprites for static display
    
    // Animation state
    this.position = 0; // Current horizontal position (negative = scrolled left)
    this.previousPosition = 0; // Previous position for blur calculation
    this.targetPosition = 0; // Target position for spin animation
    this.isSpinning = false;
    this.isCascading = false;
    this.isTurboMode = false;
    
    // Animation tweens
    this.spinTween = null;
    this.blur = null;
    
    // Data
    this.currentSymbols = null; // Current symbol codes array
    this.currentAssets = null;
    this.availableSymbols = [];
    
    // Setup
    this.container.addChild(this.spinLayer);
    this.gridLayer.visible = false;
    this.container.addChild(this.gridLayer);
    
    // Create blur filter
    this.blur = new PIXI.BlurFilter();
    this.blur.blurX = 0;
    this.blur.blurY = 0;
    this.container.filters = [this.blur];
    
    // Create mask to show only visible symbols
    this._createMask();
    
    // Setup ticker for position updates
    this.tickerCallback = null;
    this.setupTicker();
  }

  /**
   * Creates mask to show only visible symbols above covered reels
   * 
   * @private
   * @returns {void}
   */
  _createMask() {
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff);
    const maskStartX = this.coversReels[0] * this.reelWidth;
    const maskWidth = this.symbolCount * this.reelWidth;
    mask.drawRect(maskStartX, 0, maskWidth, this.symbolSize);
    mask.endFill();
    mask.x = 0;
    mask.y = 0;
    this.container.mask = mask;
    this.container.parent?.addChild(mask);
    this.mask = mask;
  }

  /**
   * Sets up ticker callback for position updates during spin
   * 
   * @returns {void}
   */
  setupTicker() {
    if (this.tickerCallback) {
      this.app.ticker.remove(this.tickerCallback);
    }

    this.tickerCallback = () => {
      if (!this.isSpinning || !this.spinLayer) {
        return;
      }

      // Calculate blur based on position change
      const deltaX = this.position - this.previousPosition;
      this.blur.blurX = Math.abs(deltaX) * SPIN_BLUR_MULTIPLIER;
      this.previousPosition = this.position;

      // Update symbol positions with wrapping
      const symbolSpacing = this.reelWidth;
      const totalSymbolWidth = this.symbols.length * symbolSpacing;
      const rightmostX = this.coversReels[this.coversReels.length - 1] * this.reelWidth + this.reelWidth;

      // Normalize position for wrapping
      let normalizedPos = this.position;
      if (normalizedPos < 0) {
        normalizedPos = (normalizedPos % totalSymbolWidth + totalSymbolWidth) % totalSymbolWidth;
      } else {
        normalizedPos = normalizedPos % totalSymbolWidth;
      }

      for (let i = 0; i < this.symbols.length; i++) {
        const symbol = this.symbols[i];
        if (!symbol || symbol.destroyed) continue;

        // Position symbols horizontally with wrapping
        const wrappedPos = ((normalizedPos + (i * symbolSpacing)) % totalSymbolWidth);
        let symbolX = rightmostX - wrappedPos;

        // Wrap symbols around for continuous scrolling
        if (symbolX < this.coversReels[0] * this.reelWidth - totalSymbolWidth) {
          symbolX += totalSymbolWidth;
        } else if (symbolX > rightmostX + symbolSpacing) {
          symbolX -= totalSymbolWidth;
        }

        symbol.x = symbolX;
      }
    };

    this.app.ticker.add(this.tickerCallback);
  }

  /**
   * Initializes the top reel renderer
   * 
   * @param {PIXI.Container} parentContainer - Parent container to add to
   * @param {number} yOffset - Y offset from parent (negative = above main grid)
   * @returns {void}
   */
  initialize(parentContainer, yOffset = 0) {
    this.container.y = yOffset;
    this.container.visible = true;
    parentContainer.addChild(this.container);
    if (this.mask && !this.mask.parent) {
      parentContainer.addChild(this.mask);
    }
  }

  /**
   * Sets available symbols for rendering
   * 
   * @param {Array<string>} symbols - Array of symbol codes
   * @returns {void}
   */
  setAvailableSymbols(symbols) {
    this.availableSymbols = symbols || [];
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
   * Builds symbol sprites for spinning
   * 
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  buildSymbols(assets) {
    // Clear existing symbols
    this.symbols.forEach(symbol => {
      if (symbol && !symbol.destroyed) {
        symbol.destroy();
      }
    });
    this.symbols = [];

    // Get available textures
    const slotTextures = this.availableSymbols
      .map(alias => assets.get(alias))
      .filter(texture => texture != null);

    if (slotTextures.length === 0) {
      console.warn('[TopReelRenderer] buildSymbols: No textures available');
      return;
    }

    // Create multiple symbol instances for smooth horizontal scrolling
    const bufferSymbols = 6; // Extra symbols for smooth scrolling
    const totalSymbols = this.symbolCount + bufferSymbols;

    for (let i = 0; i < totalSymbols; i++) {
      const texture = slotTextures[Math.floor(Math.random() * slotTextures.length)];
      const symbol = new PIXI.Sprite(texture);

      symbol.scale.x = symbol.scale.y = Math.min(
        this.symbolSize / texture.width,
        this.symbolSize / texture.height
      );

      // Position symbols horizontally (right to left)
      const rightmostX = this.coversReels[this.coversReels.length - 1] * this.reelWidth + this.reelWidth;
      symbol.x = rightmostX - (i * this.reelWidth);
      symbol.y = Math.round((this.symbolSize - symbol.height) / 2);
      symbol.visible = true;
      symbol.alpha = 1;

      this.symbols.push(symbol);
      this.spinLayer.addChild(symbol);
    }

    // Reset position
    this.position = 0;
    this.previousPosition = 0;
    this.targetPosition = 0;
  }

  /**
   * Starts the spin animation
   * 
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  startSpin(assets) {
    if (this.isSpinning) {
      console.warn('[TopReelRenderer] startSpin: Already spinning');
      return;
    }

    this.currentAssets = assets;
    this.isSpinning = true;
    this.previousPosition = this.position;

    // Build symbols if needed
    if (this.symbols.length === 0) {
      this.buildSymbols(assets);
    }

    // Calculate target position for horizontal spin (right to left = negative movement)
    const extra = Math.floor(Math.random() * 3);
    const baseTime = this.isTurboMode ? SPIN_BASE_TIME * 0.4 : SPIN_BASE_TIME;
    const time = baseTime + extra * (this.isTurboMode ? SPIN_STAGGER_TIME * 0.4 : SPIN_STAGGER_TIME);
    const spinDistance = SPIN_BASE_TARGET + extra;
    this.targetPosition = this.position - spinDistance;

    // Create GSAP tween for horizontal animation
    if (this.spinTween) {
      this.spinTween.kill();
    }

    this.spinTween = gsap.to(this, {
      position: this.targetPosition,
      duration: time / 1000, // Convert ms to seconds
      ease: this._backout(SPIN_EASING_AMOUNT),
      onComplete: () => {
        this.isSpinning = false;
        this.position = this.targetPosition;
        this.previousPosition = this.targetPosition;
        if (this.blur) {
          this.blur.blurX = 0;
        }
      }
    });
  }

  /**
   * Stops the spin animation immediately
   * 
   * @returns {void}
   */
  stopSpin() {
    if (this.spinTween) {
      this.spinTween.kill();
      this.spinTween = null;
    }
    this.isSpinning = false;
    if (this.blur) {
      this.blur.blurX = 0;
    }
  }

  /**
   * Sets the final symbols for the top reel
   * 
   * @param {Array<string>} symbols - Array of symbol codes (length should match symbolCount)
   * @returns {void}
   */
  setSymbols(symbols) {
    this.currentSymbols = symbols || [];
  }

  /**
   * Preloads final textures during spin
   * 
   * Applies final textures to spinning symbols so they stop on correct symbols.
   * 
   * @param {Array<string>} symbols - Final symbol codes
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  preloadSpinResult(symbols, assets) {
    if (!symbols || !Array.isArray(symbols) || symbols.length !== this.symbolCount) {
      console.warn('[TopReelRenderer] preloadSpinResult: Invalid symbols', symbols);
      return;
    }

    this.currentAssets = assets;
    this.currentSymbols = symbols;

    // Apply textures to visible symbols (first symbolCount symbols)
    for (let i = 0; i < this.symbolCount && i < symbols.length && i < this.symbols.length; i++) {
      const symbolCode = symbols[i];
      const texture = assets.get(symbolCode);
      const symbol = this.symbols[i];

      if (texture && symbol && !symbol.destroyed) {
        symbol.texture = texture;
        const scale = Math.min(
          this.symbolSize / texture.width,
          this.symbolSize / texture.height
        );
        symbol.scale.set(scale);
      }
    }
  }

  /**
   * Transitions from spin mode to grid mode
   * 
   * @param {Array<string>} symbols - Final symbol codes
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {Promise<void>} Resolves when transition completes
   */
  transitionSpinToGrid(symbols, assets) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        this.currentAssets = assets;
        this.currentSymbols = symbols || [];

        // Hide spin layer
        this.spinLayer.visible = false;
        this.isSpinning = false;

        // Show grid layer with final symbols
        this.gridLayer.visible = true;
        this._renderGridSymbols(symbols, assets);

        resolve();
      });
    });
  }

  /**
   * Renders grid symbols (static display)
   * 
   * @private
   * @param {Array<string>} symbols - Symbol codes
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  _renderGridSymbols(symbols, assets) {
    // Clear existing grid sprites
    this.gridSprites.forEach(sprite => {
      if (sprite && !sprite.destroyed) {
        sprite.destroy();
      }
    });
    this.gridSprites = [];

    if (!symbols || !Array.isArray(symbols)) {
      return;
    }

    // Create grid sprites for each symbol
    for (let i = 0; i < this.symbolCount && i < symbols.length; i++) {
      const symbolCode = symbols[i];
      if (!symbolCode || symbolCode === 'NULL') {
        continue;
      }

      const texture = assets.get(symbolCode) ?? assets.get('PLACEHOLDER');
      if (!texture) {
        continue;
      }

      const sprite = new PIXI.Sprite(texture);
      const scale = Math.min(
        this.symbolSize / texture.width,
        this.symbolSize / texture.height
      );
      sprite.scale.set(scale);

      // Position symbol above the corresponding reel
      const col = this.coversReels[i];
      sprite.x = col * this.reelWidth + (this.reelWidth / 2) - (sprite.width / 2);
      sprite.y = Math.round((this.symbolSize - sprite.height) / 2);
      sprite.visible = true;
      sprite.alpha = 1;

      this.gridSprites.push(sprite);
      this.gridLayer.addChild(sprite);
    }
  }

  /**
   * Plays cascade step animation (horizontal slide)
   * 
   * When symbols win and are removed, remaining symbols slide LEFT to fill gaps.
   * New symbols enter from RIGHT edge.
   * 
   * @param {Array<string>} nextSymbols - Next symbol codes after cascade
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @param {Object} [options] - Animation options
   * @param {number} [options.fadeDuration] - Fade duration in seconds
   * @param {number} [options.slideDuration] - Slide duration in seconds
   * @returns {Promise<void>} Resolves when cascade step completes
   */
  playCascadeStep(nextSymbols, assets, { fadeDuration = CASCADE_FADE_DURATION, slideDuration = CASCADE_SLIDE_DURATION } = {}) {
    if (!nextSymbols || !Array.isArray(nextSymbols) || nextSymbols.length !== this.symbolCount) {
      console.warn('[TopReelRenderer] playCascadeStep: Invalid next symbols', nextSymbols);
      return Promise.resolve();
    }

    const prevSymbols = this.currentSymbols || [];
    const removedIndices = [];

    // Find removed symbols
    for (let i = 0; i < this.symbolCount; i++) {
      const prevSymbol = i < prevSymbols.length ? prevSymbols[i] : null;
      const nextSymbol = i < nextSymbols.length ? nextSymbols[i] : null;
      if (prevSymbol && prevSymbol !== nextSymbol) {
        removedIndices.push(i);
      }
    }

    // Fade out removed symbols
    const fadePromises = removedIndices.map(index => {
      const sprite = this.gridSprites[index];
      if (!sprite) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        gsap.to(sprite, {
          alpha: 0,
          duration: fadeDuration,
          ease: 'power2.out',
          onComplete: () => {
            sprite.visible = false;
            resolve();
          }
        });
      });
    });

    return Promise.all(fadePromises).then(() => {
      // Slide remaining symbols LEFT to fill gaps
      const slidePromises = [];
      const occupiedPositions = new Set();

      // Calculate new positions (slide left)
      for (let i = 0; i < this.symbolCount; i++) {
        const nextSymbol = i < nextSymbols.length ? nextSymbols[i] : null;
        if (!nextSymbol || nextSymbol === 'NULL') {
          continue;
        }

        // Find which sprite should move to this position
        let sourceIndex = -1;
        for (let j = i; j < this.symbolCount; j++) {
          if (!removedIndices.includes(j) && this.gridSprites[j] && !occupiedPositions.has(j)) {
            sourceIndex = j;
            break;
          }
        }

        if (sourceIndex >= 0 && sourceIndex !== i) {
          const sprite = this.gridSprites[sourceIndex];
          if (sprite && !sprite.destroyed) {
            const targetX = this.coversReels[i] * this.reelWidth + (this.reelWidth / 2) - (sprite.width / 2);
            occupiedPositions.add(sourceIndex);

            slidePromises.push(
              new Promise((resolve) => {
                gsap.to(sprite, {
                  x: targetX,
                  duration: slideDuration,
                  ease: 'power2.inOut', // Smooth slide, no bounce
                  onComplete: resolve
                });
              })
            );

            // Update grid sprites array
            this.gridSprites[i] = sprite;
            if (sourceIndex !== i) {
              this.gridSprites[sourceIndex] = null;
            }
          }
        }
      }

      // Spawn new symbols from RIGHT
      for (let i = 0; i < this.symbolCount; i++) {
        const nextSymbol = i < nextSymbols.length ? nextSymbols[i] : null;
        if (!nextSymbol || nextSymbol === 'NULL') {
          continue;
        }

        // Check if position is already occupied
        if (this.gridSprites[i] && !this.gridSprites[i].destroyed) {
          continue; // Already has a sprite (moved from elsewhere)
        }

        const texture = assets.get(nextSymbol) ?? assets.get('PLACEHOLDER');
        if (!texture) {
          continue;
        }

        const sprite = new PIXI.Sprite(texture);
        const scale = Math.min(
          this.symbolSize / texture.width,
          this.symbolSize / texture.height
        );
        sprite.scale.set(scale);

        // Start from RIGHT edge
        const rightmostX = this.coversReels[this.coversReels.length - 1] * this.reelWidth + this.reelWidth;
        sprite.x = rightmostX;
        sprite.y = Math.round((this.symbolSize - sprite.height) / 2);
        sprite.alpha = 1;
        sprite.visible = true;

        this.gridSprites[i] = sprite;
        this.gridLayer.addChild(sprite);

        // Slide to target position
        const targetX = this.coversReels[i] * this.reelWidth + (this.reelWidth / 2) - (sprite.width / 2);
        slidePromises.push(
          new Promise((resolve) => {
            gsap.to(sprite, {
              x: targetX,
              duration: slideDuration,
              ease: 'power2.inOut', // Smooth slide, no bounce
              onComplete: resolve
            });
          })
        );
      }

      this.currentSymbols = nextSymbols;
      return Promise.all(slidePromises);
    });
  }

  /**
   * Highlights winning symbols
   * 
   * @param {Array<{col: number}>} winCells - Array of winning cell positions (col only for top reel)
   * @param {Object} [options] - Highlight options
   * @param {number} [options.scaleAmount] - Scale multiplier (default: 1.18)
   * @param {number} [options.duration] - Animation duration in seconds (default: 0.6)
   * @returns {Promise<void>} Resolves when highlight completes
   */
  highlightWinningCells(winCells, { scaleAmount = 1.18, duration = 0.6 } = {}) {
    const promises = [];

    winCells.forEach(({ col }) => {
      // Find sprite at this column
      const index = this.coversReels.indexOf(col);
      if (index < 0 || index >= this.gridSprites.length) {
        return;
      }

      const sprite = this.gridSprites[index];
      if (!sprite || sprite.destroyed) {
        return;
      }

      const originalScale = sprite.scale.x;
      promises.push(
        new Promise((resolve) => {
          gsap.to(sprite.scale, {
            x: originalScale * scaleAmount,
            y: originalScale * scaleAmount,
            duration: duration,
            ease: 'power2.out',
            onComplete: () => {
              gsap.to(sprite.scale, {
                x: originalScale,
                y: originalScale,
                duration: duration * 0.5,
                ease: 'power2.in',
                onComplete: resolve
              });
            }
          });
        })
      );
    });

    return Promise.all(promises);
  }

  /**
   * Easing function for smooth deceleration
   * 
   * @private
   * @param {number} amount - Easing amount (0-1)
   * @returns {Function} Easing function
   */
  _backout(amount) {
    return (t) => {
      if (t < 1 / 2.75) {
        return 7.5625 * t * t;
      } else if (t < 2 / 2.75) {
        return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
      } else if (t < 2.5 / 2.75) {
        return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
      } else {
        return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
      }
    };
  }

  /**
   * Destroys the renderer and cleans up resources
   * 
   * @returns {void}
   */
  destroy() {
    if (this.tickerCallback) {
      this.app.ticker.remove(this.tickerCallback);
      this.tickerCallback = null;
    }

    if (this.spinTween) {
      this.spinTween.kill();
      this.spinTween = null;
    }

    this.symbols.forEach(symbol => {
      if (symbol && !symbol.destroyed) {
        symbol.destroy();
      }
    });
    this.symbols = [];

    this.gridSprites.forEach(sprite => {
      if (sprite && !sprite.destroyed) {
        sprite.destroy();
      }
    });
    this.gridSprites = [];

    if (this.container && !this.container.destroyed) {
      this.container.destroy({ children: true });
    }

    if (this.mask && !this.mask.destroyed) {
      this.mask.destroy();
    }
  }
}

