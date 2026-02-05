/**
 * GridRenderer.js - Grid Rendering and Animation System
 * 
 * Renders the slot grid, handles spin animations, manages cascading mechanics,
 * and supports Megaways (variable reel heights).
 * 
 * Dual-Layer System:
 * - Spin Layer: Visible during reel spinning, shows animated symbols with blur
 * - Grid Layer: Visible during cascades, shows static symbols for win evaluation
 * 
 * Key Features:
 * - Reel spinning with staggered timing and blur effects
 * - Smooth transition from spin to grid mode
 * - Cascade animations (fade out winners, drop new symbols)
 * - Top reel support (horizontal scrolling above reels 2-5)
 * - Megaways support (variable reel heights per column)
 * - Turbo mode (60% faster animations)
 * 
 * Dependencies:
 * - PixiJS: WebGL rendering
 * - GSAP: Animation library
 */

import * as PIXI from 'pixi.js';
import { gsap } from 'gsap';
import SymbolRenderer from './SymbolRenderer.js';

/**
 * Debug logging utility
 */
class SpinDebugLogger {
  constructor() {
    this.logs = [];
    this.startTime = null;
    this.backendSummary = null;
  }

  start() {
    this.logs = [];
    this.backendSummary = null;
    this.startTime = Date.now();
  }

  setBackendSummary(text) {
    this.backendSummary = text;
  }

  log(message, data = null) {
    const timestamp = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(3) : '0.000';
    const logEntry = {
      time: timestamp,
      message,
      data: data ? JSON.parse(JSON.stringify(data, (key, value) => {
        // Remove circular references and large objects
        if (value && typeof value === 'object') {
          if (value instanceof PIXI.Sprite || value instanceof PIXI.Texture) {
            return value.toString();
          }
          if (Array.isArray(value) && value.length > 10) {
            return `[Array(${value.length})]`;
          }
        }
        return value;
      })) : null
    };
    this.logs.push(logEntry);
    console.log(`[${timestamp}s] ${message}`, data || '');
  }

  getVisibleSymbols(reel, resultMatrix) {
    if (!reel || !reel.symbols) return [];
    
    const visibleRows = resultMatrix && resultMatrix[reel.index] 
      ? resultMatrix[reel.index].length 
      : (reel.height || 6);
    const maskStart = 120; // symbolSize
    const dynamicHeight = 120; // Simplified
    const visibleStart = maskStart;
    const visibleEnd = visibleStart + (dynamicHeight * visibleRows);
    
    // Track symbols by row to avoid duplicates
    const rowSymbols = new Map();
    
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (!symbol || symbol.destroyed) continue;
      
      if (symbol.y >= visibleStart && symbol.y < visibleEnd) {
        const relativeY = symbol.y - visibleStart;
        const row = Math.floor(relativeY / dynamicHeight);
        
        // Only keep the symbol closest to the row center (avoid duplicates)
        if (row >= 0 && row < visibleRows) {
          const rowCenterY = visibleStart + (row * dynamicHeight) + (dynamicHeight / 2);
          const distanceToCenter = Math.abs(symbol.y - rowCenterY);
          
          if (!rowSymbols.has(row) || distanceToCenter < rowSymbols.get(row).distance) {
            let symbolCode = 'UNKNOWN';
            
            // First try to get from stored symbolCode (most reliable)
            if (symbol.symbolCode) {
              symbolCode = symbol.symbolCode;
            } else if (symbol.iconID !== undefined && reel.gridRenderer && reel.gridRenderer.availableSymbols) {
              // Fallback to iconID -> availableSymbols mapping
              const iconID = symbol.iconID;
              if (iconID >= 0 && iconID < reel.gridRenderer.availableSymbols.length) {
                symbolCode = reel.gridRenderer.availableSymbols[iconID];
              }
            } else if (symbol.texture && reel.gridRenderer && reel.gridRenderer.currentAssets) {
              // Last resort: texture comparison
              for (const alias of reel.gridRenderer.availableSymbols) {
                const tex = reel.gridRenderer.currentAssets.get(alias);
                if (tex && tex === symbol.texture) {
                  symbolCode = alias;
                  break;
                }
              }
            }
            
            rowSymbols.set(row, {
              index: i,
              y: symbol.y.toFixed(1),
              symbol: symbolCode,
              row: row,
              distance: distanceToCenter
            });
          }
        }
      }
    }
    
    // Convert map to array and sort by row
    return Array.from(rowSymbols.values()).sort((a, b) => a.row - b.row);
  }

  download() {
    const content = this.backendSummary != null
      ? this.backendSummary
      : this.logs.map(log => {
          let line = `[${log.time}s] ${log.message}`;
          if (log.data) {
            line += '\n' + JSON.stringify(log.data, null, 2);
          }
          return line;
        }).join('\n\n');
    if (this.backendSummary) {
      this.backendSummary = null;
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spin-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/** Default cell size in pixels */
const DEFAULT_CELL_SIZE = 120; // Adjusted for proper viewport fitting (Pragmatic uses ~100-120px)
/** Default padding around symbols in pixels */
const DEFAULT_SYMBOL_PADDING = 0;
/** Default gap between cells in pixels */
const DEFAULT_CELL_GAP = 4; // Very tight gaps for Pragmatic Play look

// Spin animation speed controls
/** Base spin duration in milliseconds (lower = faster) */
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
/** Cascade drop duration in seconds */
const CASCADE_DROP_DURATION = 0.35;
/** Cascade fade duration in seconds */
const CASCADE_FADE_DURATION = 0.15;
/** Cascade hold duration in seconds */
const CASCADE_HOLD_DURATION = 0.4;
/** Smooth transition from spin to grid in seconds */
const SPIN_TO_GRID_TRANSITION_DURATION = 0.3;
/** Apply final textures in last 10% of spin tween to prevent flicker */
const FINAL_TEXTURE_PRELOAD_PHASE = 0.9;

/**
 * GridRenderer - Renders slot grid with spin and cascade animations
 */
export default class GridRenderer {
  /**
   * Creates a new GridRenderer instance
   * 
   * @param {Object} options - Configuration options
   * @param {PIXI.Application} options.app - PixiJS application
   * @param {number} options.columns - Number of columns (reels)
   * @param {number} options.rows - Number of rows (default, may vary for Megaways)
   * @param {PIXI.Texture} [options.textureBehindSymbols] - Background texture for grid
   * @param {number} [options.cellSize] - Cell size in pixels (default: 140)
   * @param {number} [options.symbolPadding] - Symbol padding in pixels (default: 0)
   * @param {number} [options.cellGap] - Gap between cells in pixels (default: 5)
   * @param {number} [options.tablePadding] - Table padding multiplier (default: 0.24)
   */
  constructor({
    app,
    columns,
    rows,
    textureBehindSymbols,
    cellSize = DEFAULT_CELL_SIZE,
    symbolPadding = DEFAULT_SYMBOL_PADDING,
    cellGap = DEFAULT_CELL_GAP,
    tablePadding = 0.24
  }) {
    this.app = app;
    this.columns = columns;
    this.rows = rows; // Keep for backward compatibility, but use maxRows for Megaways
    this.maxRows = rows; // Maximum possible rows for Megaways
    this.textureBehindSymbols = textureBehindSymbols;
    this.cellSize = cellSize;
    this.symbolSize = cellSize - symbolPadding * 2;
    this.reelWidth = cellSize;
    this.container = new PIXI.Container();
    this.container.visible = true;
    this.container.alpha = 1;
    this.symbolRenderer = new SymbolRenderer();
    this.reels = [];
    this.tweening = [];
    this.running = false;
    this.availableSymbols = [];
    this.currentAssets = null;
    this.tickerCallback = null;
    
    // Debug logging system
    this.debugLogger = new SpinDebugLogger();
    this.onSpinComplete = null;
    this.lastSymbolMatrix = null;
    this.resultMatrix = null;
    this.pendingWinningIndices = null;
    this.isSpinning = false;
    this.isCascading = false;
    this.isTurboMode = false;
    /** When false, reelsComplete will switch to grid and render resultMatrix so display matches backend (no cascades). */
    this.hasCascadesThisRound = false;
    this.reelHeights = null; // Array of heights per reel for Megaways
    this.topReel = null; // Top reel data (final symbols from backend)
    this.topReelContainer = null; // Container for top reel
    this.topReelSpinning = false; // Boolean flag for spin state
    this.topReelPosition = 0; // Current horizontal position (for scrolling)
    this.topReelPreviousPosition = 0; // Previous position for blur calculation
    this.topReelSymbols = []; // Array of symbol sprites for the spinning reel
    this.topReelSpinLayer = null; // Container for spinning symbols
    this.topReelTargetPosition = 0; // Target position for spin animation
    this.topReelBlur = null; // Blur filter for top reel
    this.topReelTween = null; // GSAP tween for top reel animation
    // Grid size includes main reels only (top reel is positioned separately above)
    this.size = {
      width: this.reelWidth * this.columns,
      height: this.symbolSize * this.maxRows
    };
    // Total height including top reel (top reel is always 1 symbol height above)
    // Top reel covers columns 1-4, so it adds 1 symbol height to total
    this.totalHeight = this.symbolSize * this.maxRows + this.symbolSize;
    this.tableSprite = null;
    this.tablePadding = tablePadding;
    
    // Symbol mapping from backend format (Sym1, Sym2, etc.) to frontend codes (FACE, BIRD, etc.)
    this.symbolMap = null; // Will be set when loading reel strips
    this.reelStrips = null; // Will store loaded reel strips
  }

  /**
   * Builds a backend-style text summary from the play response for the spin-debug download.
   * Supports both camelCase and PascalCase from API.
   * @param {Object} playResponse - Full play response from backend
   * @returns {string} Multi-line debug text (backend console style)
   */
  formatBackendStyleSummary(playResponse) {
    if (!playResponse) return '';
    const r = playResponse.results ?? playResponse;
    const roundId = playResponse.roundId ?? playResponse.RoundId ?? '(none)';
    const win = playResponse.win != null ? playResponse.win : playResponse.Win;
    const winAmount = typeof win === 'number' ? win : (win?.amount ?? win?.Amount ?? 0);
    const lines = [];
    lines.push('=== BACKEND SPIN DEBUG (from play response) ===');
    lines.push(`[SpinHandler] RoundId: ${roundId}`);
    lines.push(`[SpinHandler] TotalWin: ${winAmount}`);
    const cascades = r?.cascades ?? r?.Cascades ?? [];
    lines.push(`[SpinHandler] Cascades: ${cascades.length}`);
    const wins = r?.wins ?? r?.Wins ?? [];
    lines.push(`[SpinHandler] Wins count: ${wins.length}`);
    const topReelSymbols = r?.topReelSymbols ?? r?.TopReelSymbols;
    if (Array.isArray(topReelSymbols) && topReelSymbols.length > 0) {
      lines.push(`[SpinHandler] TopReelSymbols (final): [${topReelSymbols.join(', ')}]`);
    }
    const reelHeights = r?.reelHeights ?? r?.ReelHeights;
    if (Array.isArray(reelHeights) && reelHeights.length > 0) {
      lines.push(`[SpinHandler] ReelHeights: [${reelHeights.join(', ')}]`);
    }
    const waysToWin = r?.waysToWin ?? r?.WaysToWin;
    if (waysToWin != null) {
      lines.push(`[SpinHandler] WaysToWin: ${waysToWin}`);
    }
    const finalReels = r?.reelSymbols ?? r?.ReelSymbols;
    if (Array.isArray(finalReels) && finalReels.length > 0) {
      lines.push('[SpinHandler] Final reel symbols (main grid):');
      finalReels.forEach((reel, col) => {
        const syms = Array.isArray(reel) ? reel : [];
        lines.push(`  Reel ${col}: [${syms.join(', ')}]`);
      });
    }
    cascades.forEach((step, idx) => {
      lines.push('');
      lines.push(`--- CASCADE STEP ${idx} ---`);
      const before = step.reelSymbolsBefore ?? step.ReelSymbolsBefore;
      if (Array.isArray(before) && before.length > 0) {
        lines.push('Main reels before:');
        before.forEach((reel, col) => {
          const syms = Array.isArray(reel) ? reel : [];
          lines.push(`  Reel ${col}: [${syms.join(', ')}]`);
        });
      }
      const topBefore = step.topReelSymbolsBefore ?? step.TopReelSymbolsBefore;
      if (Array.isArray(topBefore) && topBefore.length > 0) {
        lines.push(`TopReelSymbolsBefore: [${topBefore.join(', ')}]`);
      }
      const topAfter = step.topReelSymbolsAfter ?? step.TopReelSymbolsAfter;
      if (Array.isArray(topAfter) && topAfter.length > 0) {
        lines.push(`TopReelSymbolsAfter: [${topAfter.join(', ')}]`);
      }
      const stepWins = step.winsAfterCascade ?? step.WinsAfterCascade ?? [];
      stepWins.forEach(sw => {
        const code = sw.symbolCode ?? sw.SymbolCode ?? '?';
        const payout = sw.payout ?? sw.Payout;
        const amt = typeof payout === 'number' ? payout : (payout?.amount ?? payout?.Amount ?? 0);
        const positions = sw.winningPositions ?? sw.WinningPositions ?? [];
        const posStr = positions.map(p => {
          const rl = p.reel ?? p.Reel;
          const pos = p.position ?? p.Position;
          return pos === -1 ? `(${rl},top)` : `(${rl},${pos})`;
        }).join(', ');
        lines.push(`[SpinHandler] Win: Symbol=${code}, Payout=${amt}, Positions: [${posStr}]`);
      });
    });
    if (wins.length > 0) {
      lines.push('');
      lines.push('--- Aggregate wins ---');
      wins.forEach(sw => {
        const code = sw.symbolCode ?? sw.SymbolCode ?? '?';
        const payout = sw.payout ?? sw.Payout;
        const amt = typeof payout === 'number' ? payout : (payout?.amount ?? payout?.Amount ?? 0);
        lines.push(`[SpinHandler] Win: Symbol=${code}, Payout=${amt}`);
      });
    }
    lines.push('');
    lines.push('[SpinHandler] Spin completed.');
    return lines.join('\n');
  }

  /**
   * Sets the last play response so the spin-debug download uses backend-style summary.
   * Call this when results are received (e.g. from SceneManager.continueRenderResults).
   * @param {Object} playResponse - Full play response from backend
   */
  setLastPlayResponseForDebug(playResponse) {
    if (!playResponse || !this.debugLogger) return;
    const text = this.formatBackendStyleSummary(playResponse);
    if (text) this.debugLogger.setBackendSummary(text);
  }

  /**
   * Seeded random number generator for creating deterministic reel strips
   * 
   * @param {number} seed - Seed value
   * @returns {Function} Random function that returns values between 0 and 1
   */
  seededRandom(seed) {
    let value = seed;
    return function() {
      value = (value * 9301 + 49297) % 233280;
      return value / 233280;
    };
  }

  /**
   * Loads reel strips from backend JSON file
   * 
   * Converts backend symbol codes (Sym1, Sym2, etc.) to frontend codes (FACE, BIRD, etc.)
   * using the symbol catalog mapping.
   * 
   * @param {string} gameId - Game identifier (e.g., 'JungleRelics')
   * @returns {Promise<void>}
   */
  async loadReelStrips(gameId) {
    try {
      // Load symbol catalog to create mapping
      const configResponse = await fetch(`/configs/${gameId}.json`);
      if (!configResponse.ok) {
        throw new Error(`Failed to load game config: ${configResponse.statusText}`);
      }
      const config = await configResponse.json();
      
      // Create symbol mapping: Sym1 -> FACE, Sym2 -> BIRD, etc.
      this.symbolMap = {};
      if (config.symbolCatalog && Array.isArray(config.symbolCatalog)) {
        for (const symbol of config.symbolCatalog) {
          if (symbol.sym && symbol.code) {
            this.symbolMap[symbol.sym] = symbol.code;
          }
        }
      }
      
      console.log('[GridRenderer] loadReelStrips: Symbol mapping created', this.symbolMap);
      
      // Load reel strips file
      // Try public/configs first (copied from backend), then try backend path
      const reelFile = config.reels?.sourceFile || `configs/${gameId}Reelsets.json`;
      let stripsResponse = await fetch(`/configs/${gameId}Reelsets.json`);
      if (!stripsResponse.ok) {
        // Fallback: try the path from config
        stripsResponse = await fetch(`/${reelFile}`);
        if (!stripsResponse.ok) {
          throw new Error(`Failed to load reel strips: ${stripsResponse.statusText}`);
        }
      }
      const stripsData = await stripsResponse.json();
      
      // Convert strips from backend format to frontend format
      // Backend uses "reelsetLow" or "reelsetHigh" based on bet mode
      // We'll use "reelsetLow" as default (can be changed based on bet mode later)
      const reelSetKey = 'reelsetLow'; // Default to low strips
      if (!stripsData[reelSetKey]) {
        console.warn(`[GridRenderer] loadReelStrips: ${reelSetKey} not found, trying reelsetHigh`);
        // Try high strips as fallback
        if (stripsData.reelsetHigh) {
          this.reelStrips = this.convertReelStrips(stripsData.reelsetHigh);
        } else {
          throw new Error(`No reel strips found in ${reelFile}`);
        }
      } else {
        this.reelStrips = this.convertReelStrips(stripsData[reelSetKey]);
      }
      
      console.log(`[GridRenderer] loadReelStrips: Loaded ${this.reelStrips.length} reel strips`);
    } catch (error) {
      console.error('[GridRenderer] loadReelStrips: Failed to load reel strips', error);
      // Fallback: will use random strips (existing behavior)
      this.reelStrips = null;
    }
  }

  /**
   * Converts backend reel strips from Sym1/Sym2 format to symbol indices
   * 
   * @param {Array<Array<string>>} backendStrips - Strips with Sym1, Sym2, etc.
   * @returns {Array<Array<number>>} Strips with symbol indices matching availableSymbols
   */
  convertReelStrips(backendStrips) {
    if (!backendStrips || !Array.isArray(backendStrips)) {
      return null;
    }
    
    if (!this.availableSymbols || this.availableSymbols.length === 0) {
      console.error('[GridRenderer] convertReelStrips: availableSymbols not set yet!');
      return null;
    }
    
    const convertedStrips = [];
    
    for (let reelIndex = 0; reelIndex < backendStrips.length; reelIndex++) {
      const backendStrip = backendStrips[reelIndex];
      if (!Array.isArray(backendStrip)) continue;
      
      const convertedStrip = [];
      for (const symCode of backendStrip) {
        // Convert Sym1 -> FACE, Sym2 -> BIRD, etc. using symbolMap
        const frontendCode = this.symbolMap[symCode];
        if (frontendCode) {
          // Find index in availableSymbols
          const index = this.availableSymbols.indexOf(frontendCode);
          if (index >= 0) {
            convertedStrip.push(index);
          } else {
            console.warn(`[GridRenderer] convertReelStrips: Symbol ${frontendCode} (from ${symCode}) not in availableSymbols, using 0`);
            convertedStrip.push(0);
          }
        } else {
          console.warn(`[GridRenderer] convertReelStrips: Unknown symbol code ${symCode}, using 0`);
          convertedStrip.push(0);
        }
      }
      
      convertedStrips.push(convertedStrip);
      console.log(`[GridRenderer] convertReelStrips: Reel ${reelIndex} - Converted ${backendStrip.length} symbols to ${convertedStrip.length} indices`);
    }
    
    return convertedStrips;
  }

  /**
   * Sets reel heights for Megaways support
   * 
   * Updates variable reel heights per column. Used for Megaways games where
   * each column can have a different number of rows.
   * 
   * @param {Array<number>} reelHeights - Array of heights per column
   * @returns {void}
   */
  setReelHeights(reelHeights) {
    this.reelHeights = reelHeights;
    if (reelHeights && reelHeights.length > 0) {
      this.maxRows = Math.max(...reelHeights); // Update max rows
      this.size.height = this.symbolSize * this.maxRows; // Update grid height
      
      console.log('[GridRenderer] setReelHeights: Updated reel heights', reelHeights);
      
      // CRITICAL: Immediately update symbol scaling for all reels if they're already built
      // This ensures the grid shows the correct layout immediately, not after spin stops
      if (this.reels && this.reels.length > 0) {
        this._updateReelScalingForHeights();
      }
    }
  }
  
  /**
   * Updates symbol scaling for all reels based on current reelHeights
   * Called immediately when reelHeights are set to update the visual layout
   */
  _updateReelScalingForHeights() {
    if (!this.reelHeights || this.reelHeights.length === 0) {
      return;
    }
    
    const topReelCovers = [1, 2, 3, 4];
    const maskStart = this.symbolSize;
    const totalColumnHeight = this.rows * this.symbolSize;
    
    for (let col = 0; col < this.columns && col < this.reels.length; col++) {
      const reel = this.reels[col];
      if (!reel || !reel.symbols || reel.symbols.length === 0) continue;
      
      // Calculate symbol count for this reel (excluding top reel if covered)
      let reelSymbolCount = this.reelHeights[col] || this.rows;
      if (topReelCovers.includes(col)) {
        reelSymbolCount = reelSymbolCount - 1; // Exclude top reel
      }
      
      // Calculate dynamic height for this reel
      const dynamicHeight = reelSymbolCount > 0 ? totalColumnHeight / reelSymbolCount : this.symbolSize;
      
      // Update all symbols in this reel to use dynamic height
      for (let j = 0; j < reel.symbols.length; j++) {
        const symbol = reel.symbols[j];
        if (!symbol || symbol.destroyed) continue;
        
        // Update scale to match dynamic height
        const scaleY = dynamicHeight / symbol.texture.height;
        const scaleX = this.symbolSize / symbol.texture.width;
        symbol.scale.set(scaleX, scaleY);
      }
      
      console.log(`[GridRenderer] _updateReelScalingForHeights: Reel ${col} - symbolCount=${reelSymbolCount}, dynamicHeight=${dynamicHeight.toFixed(1)}`);
    }
  }

  /**
   * Sets top reel symbols
   * 
   * Top reel is a horizontal scrolling reel above columns 2-5 (indices 1-4).
   * Used for special game features.
   * 
   * @param {Array<string>} topReelSymbols - Array of symbol codes for top reel
   * @returns {void}
   */
  setTopReel(topReelSymbols) {
    this.topReel = topReelSymbols;
  }

  /**
   * Sets turbo mode on/off
   * 
   * Turbo mode speeds up animations by 60% (40% of normal duration).
   * 
   * @param {boolean} enabled - True to enable turbo mode
   * @returns {void}
   */
  setTurboMode(enabled) {
    this.isTurboMode = enabled;
  }

  /**
   * Initializes the grid renderer
   * 
   * Adds container to scene, draws background, and sets up ticker callback.
   * 
   * @param {PIXI.Container} sceneLayer - Scene layer container
   * @returns {void}
   */
  initialize(sceneLayer) {
    sceneLayer.addChild(this.container);
    this.drawBackground();
    this.setupTicker();
  }

  setTablePadding(padding) {
    if (Number.isFinite(padding) && padding >= 0) {
      this.tablePadding = padding;
      this._applyTableScale();
    }
  }

  /**
   * Enters spin mode
   * 
   * Shows spin layer (animated symbols) and hides grid layer (static symbols).
   * Used when reels are spinning.
   * 
   * @returns {void}
   */
  enterSpinMode() {
    this.isSpinning = true;
    this.isCascading = false;

    // Show spin layer, hide grid layer for all reels
    this.reels.forEach((reel) => {
      if (!reel) {
        return;
      }
      if (reel.spinLayer) {
        reel.spinLayer.visible = true;
      }
      if (Array.isArray(reel.symbols)) {
        reel.symbols.forEach((symbol) => {
          if (symbol) {
            symbol.visible = true;
            symbol.alpha = 1;
          }
        });
      }
      if (reel.gridLayer) {
        reel.gridLayer.visible = false;
      }
      if (Array.isArray(reel.gridSprites)) {
        reel.gridSprites.forEach((sprite) => {
          if (sprite) {
            sprite.visible = false;
          }
        });
      }
    });
    
    // Show top reel if it exists
    if (this.topReelContainer) {
      this.topReelContainer.visible = true;
    }
    if (this.topReelSpinLayer) {
      this.topReelSpinLayer.visible = true;
    }
  }

  /**
   * Enters grid mode
   * 
   * Shows grid layer (static symbols) and hides spin layer (animated symbols).
   * Used during cascades when symbols need to be evaluated for wins.
   * 
   * @returns {void}
   */
  enterGridMode() {
    this.isSpinning = false;
    this.isCascading = true;

    this.reels.forEach((reel) => {
      if (!reel) {
        return;
      }
      if (reel.spinLayer) {
        reel.spinLayer.visible = false;
      }
      if (Array.isArray(reel.symbols)) {
        reel.symbols.forEach((symbol) => {
          if (symbol) {
            symbol.visible = false;
          }
        });
      }
      if (reel.gridLayer) {
        reel.gridLayer.visible = true;
      }
      if (Array.isArray(reel.gridSprites)) {
        reel.gridSprites.forEach((sprite) => {
          if (sprite) {
            sprite.visible = true;
          }
        });
      }
    });
    
    // Keep top reel visible in grid mode to show final symbols
    // Hide spin layer but show the container with final symbols
    if (this.topReelContainer) {
      this.topReelContainer.visible = true;
    }
    if (this.topReelSpinLayer) {
      // Keep spin layer visible so we can show final symbols in it
      this.topReelSpinLayer.visible = true;
    }
  }

  drawBackground() {
    const texture = this.textureBehindSymbols ?? PIXI.Texture.WHITE;
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    this.tableSprite = sprite;
    this._applyTableScale();
    // Add table sprite first so it's behind the reels
    this.container.addChildAt(sprite, 0);
  }

  /**
   * Creates a cylindrical reel (Unity-style)
   * 
   * Sets up symbols in a circular arrangement around a cylinder axis.
   * Symbols are positioned using cylindrical geometry calculations.
   * 
   * @param {Object} reel - Reel object to set up
   * @param {Array<PIXI.Texture>} slotTextures - Available symbol textures
   * @param {number} reelIndex - Index of the reel (column)
   * @param {PIXI.Assets} assets - Assets API
   * @returns {void}
   */
  createSlotCylinder(reel, slotTextures, reelIndex, assets) {
    // Calculate number of symbols needed for cylinder
    // Use maxRows + buffer for smooth spinning
    const visibleRows = this.reelHeights && this.reelHeights[reelIndex] 
      ? this.reelHeights[reelIndex] 
      : this.rows;
    
    // For cylindrical reel, we need enough symbols to form a complete circle
    // Unity uses typically 20-30 symbols for a 3-row visible window
    const tileCount = Math.max(20, visibleRows * 6); // At least 20, or 6x visible rows
    reel.tileCount = tileCount;
    
    // Calculate cylindrical geometry (from Unity SlotGroupBehavior.cs)
    const tileSizeY = this.symbolSize; // Symbol height
    const gapY = 0; // No gap between symbols (they touch)
    const distTileY = tileSizeY + gapY;
    
    // Calculate angle per symbol
    reel.anglePerTileDeg = 360.0 / tileCount;
    reel.anglePerTileRad = reel.anglePerTileDeg * (Math.PI / 180);
    
    // Calculate cylinder radius
    // Unity formula: radius = (distTileY / 2f) / Mathf.Tan(anglePerTileRad / 2.0f)
    reel.radius = (distTileY / 2) / Math.tan(reel.anglePerTileRad / 2);
    
    // Create tiles group container (like Unity's TilesGroup)
    // This container will be rotated around X-axis
    reel.tilesGroup = new PIXI.Container();
    reel.tilesGroup.x = this.reelWidth / 2; // Center horizontally
    reel.tilesGroup.y = this.symbolSize + (visibleRows * this.symbolSize) / 2; // Center vertically in visible area
    reel.spinLayer.addChild(reel.tilesGroup);
    
    // Calculate window size (number of visible symbols)
    const windowSize = visibleRows;
    reel.topSector = windowSize - 1;
    
    // Calculate additional angle offset for centering
    // Unity uses even/odd raycaster count logic
    const isEvenRayCastersCount = (windowSize % 2 === 0);
    const dCount = isEvenRayCastersCount ? windowSize / 2 - 1 : Math.floor(windowSize / 2);
    let addAnglePerTileDeg = isEvenRayCastersCount 
      ? -reel.anglePerTileDeg * dCount - reel.anglePerTileDeg / 2 
      : -reel.anglePerTileDeg;
    let addAnglePerTileRad = addAnglePerTileDeg * (Math.PI / 180);
    
    // Position tilesGroup by radius (like Unity: TilesGroup.localPosition.z = radius)
    // In 2D, we simulate this by adjusting the pivot point
    reel.tilesGroup.pivot.y = reel.radius;
    
    // CRITICAL: Initialize FIXED reel strip (like Unity's symbOrder)
    // This strip should NOT change between spins - it's the permanent reel configuration
    // If symbOrder already exists (from previous spin), keep it - don't recreate
    if (!reel.symbOrder || reel.symbOrder.length === 0) {
      // Use backend reel strips if loaded, otherwise fallback to random
      if (this.reelStrips && this.reelStrips[reelIndex] && this.reelStrips[reelIndex].length > 0) {
        // Use backend reel strip - repeat it to fill tileCount
        const backendStrip = this.reelStrips[reelIndex];
        reel.symbOrder = [];
        for (let i = 0; i < tileCount; i++) {
          reel.symbOrder.push(backendStrip[i % backendStrip.length]);
        }
        console.log(`[GridRenderer] createSlotCylinder: Using BACKEND reel strip for reel ${reelIndex} (${backendStrip.length} symbols, repeated to ${reel.symbOrder.length})`);
      } else {
        // Fallback: Create random but fixed strip (same seed per reel for consistency)
        reel.symbOrder = [];
        const seed = reelIndex * 12345; // Deterministic seed per reel
        const rng = this.seededRandom(seed);
        for (let i = 0; i < tileCount; i++) {
          reel.symbOrder.push(Math.floor(rng() * slotTextures.length));
        }
        console.warn(`[GridRenderer] createSlotCylinder: Backend strips not loaded, using RANDOM strip for reel ${reelIndex} with ${reel.symbOrder.length} symbols`);
      }
    } else {
      console.log(`[GridRenderer] createSlotCylinder: Reusing existing FIXED reel strip for reel ${reelIndex} with ${reel.symbOrder.length} symbols`);
    }
    
    // CRITICAL: Don't reset nextSymbIndex - it should continue from where it left off
    // This matches Unity's behavior where the counter keeps incrementing
    if (reel.nextSymbIndex === undefined || reel.nextSymbIndex === null) {
      reel.nextSymbIndex = 0;
    }
    
    // Initialize currOrderPosition if not set
    if (reel.currOrderPosition === undefined || reel.currOrderPosition === null) {
      reel.currOrderPosition = 0;
    }
    
    reel.lastChanged = tileCount - 1;
    
    // Create symbols and position them in a circle
    reel.symbols = [];
    for (let i = 0; i < tileCount; i++) {
      const n = i;
      const tileAngleRad = n * reel.anglePerTileRad + addAnglePerTileRad;
      const tileAngleDeg = n * reel.anglePerTileDeg + addAnglePerTileDeg;
      
      // Get symbol from order array
      const symNumber = reel.symbOrder[this.getNextSymb(reel)];
      const texture = slotTextures[symNumber] || slotTextures[0];
      const symbol = new PIXI.Sprite(texture);
      
      // Scale symbol
      const scale = Math.min(
        this.symbolSize / symbol.texture.width,
        this.symbolSize / symbol.texture.height
      );
      symbol.scale.set(scale);
      
      // Position symbol on cylinder (2D projection of 3D cylinder)
      // Unity: new Vector3(0, radius * Mathf.Sin(tileAngleRad), -radius * Math.Cos(tileAngleRad))
      // In 2D, we project this to Y position
      const yPos = reel.radius * Math.sin(tileAngleRad);
      const zPos = -reel.radius * Math.cos(tileAngleRad);
      
      // In 2D, we use Y position directly (Z is depth, affects scale in 3D)
      // For 2D projection, we position symbols vertically based on angle
      symbol.x = (this.reelWidth - symbol.width) / 2;
      symbol.y = yPos; // Vertical position from cylinder projection
      symbol.anchor.set(0.5, 0.5); // Center anchor for rotation
      
      // Store symbol data
      symbol.symbolIndex = i;
      symbol.iconID = symNumber;
      
      // Store symbol code for identification
      symbol.symbolCode = this.availableSymbols[symNumber] || this.availableSymbols[0];
      
      reel.symbols.push(symbol);
      reel.tilesGroup.addChild(symbol);
    }
    
    // Set initial rotation to 0
    reel.rotationX = 0;
    reel.tilesGroup.rotation = 0;
    
    console.log(`[GridRenderer] createSlotCylinder: Reel ${reelIndex} - tileCount=${tileCount}, radius=${reel.radius.toFixed(1)}, anglePerTile=${reel.anglePerTileDeg.toFixed(2)}deg`);
  }

  /**
   * Gets next symbol index from order array (Unity GetNextSymb pattern)
   * 
   * CRITICAL: This counter cycles through symbOrder continuously and NEVER resets
   * during wrapping. This matches Unity's behavior where the counter keeps incrementing.
   * 
   * @param {Object} reel - Reel object
   * @returns {number} Symbol index in order array
   */
  getNextSymb(reel) {
    if (!reel || !reel.symbOrder || reel.symbOrder.length === 0) return 0;
    
    // Unity pattern: cycles through symbOrder continuously
    // Uses a counter that increments and wraps around
    // CRITICAL: Don't reset this counter - it should continue from where it left off
    const result = reel.nextSymbIndex % reel.symbOrder.length;
    reel.nextSymbIndex = (reel.nextSymbIndex + 1) % reel.symbOrder.length;
    return result;
  }

  /**
   * Wraps symbol tape during rotation (Unity WrapSymbolTape pattern)
   * 
   * CRITICAL: Uses the FIXED symbOrder strip (like Unity).
   * The symbOrder never changes - it's the permanent reel configuration.
   * During wrapping, we cycle through symbOrder using GetNextSymb() which keeps incrementing.
   * 
   * @param {Object} reel - Reel object
   * @param {number} deltaAngle - Change in rotation angle (degrees)
   * @param {PIXI.Assets} assets - Assets API for textures
   * @returns {void}
   */
  wrapSymbolTape(reel, deltaAngle, assets) {
    if (!reel || !reel.symbols || reel.symbols.length === 0 || !assets) return;
    
    const sectors = Math.abs(Math.round(deltaAngle / reel.anglePerTileDeg));
    let found = false;
    
    if (!reel.symbOrder || reel.symbOrder.length === 0) return;
    
    // Find symbols that need wrapping
    for (let i = reel.topSector + reel.tempSectors; i < reel.topSector + sectors + 3; i++) {
      const ip = ((i % reel.tileCount) + reel.tileCount) % reel.tileCount; // Mathf.Repeat equivalent
      reel.tempSectors = i - reel.topSector;
      
      if (!found) {
        found = (ip === reel.lastChanged);
      } else {
        // Wrap tape at last changed - update symbol
        // CRITICAL: Always use FIXED symbOrder array (Unity approach)
        // The symbOrder is fixed and never changes - we just cycle through it
        const orderIndex = this.getNextSymb(reel);
        const symbIndex = reel.symbOrder[orderIndex % reel.symbOrder.length];
        const symbolCode = this.availableSymbols[symbIndex] || this.availableSymbols[0];
        
        // Get texture from assets using symbol code
        const texture = assets.get(symbolCode) || assets.get('PLACEHOLDER');
        
        const symbol = reel.symbols[ip];
        
        if (symbol && !symbol.destroyed && texture) {
          symbol.texture = texture;
          symbol.iconID = symbIndex;
          
          // CRITICAL: Store symbol code for identification
          symbol.symbolCode = symbolCode;
          
          // Update scale
          const scale = Math.min(
            this.symbolSize / symbol.texture.width,
            this.symbolSize / symbol.texture.height
          );
          symbol.scale.set(scale);
          symbol.x = (this.reelWidth - symbol.width) / 2;
        }
        
        reel.lastChanged = ip;
      }
    }
  }

  /**
   * Applies backend symbols directly to visible positions after spin completes
   * 
   * This ensures the correct symbols are visible without any jumping.
   * 
   * @param {Object} reel - Reel object
   * @param {Array<string>} backendSymbols - Expected symbols from backend (bottom to top)
   * @param {PIXI.Assets} assets - Assets API
   * @returns {void}
   */
  applyBackendSymbolsToVisiblePositions(reel, backendSymbols, assets) {
    if (!reel || !reel.symbols || !backendSymbols || backendSymbols.length === 0 || !assets) return;
    
    // CRITICAL: Store ALL current positions BEFORE doing anything
    // This prevents any position changes
    const originalPositions = [];
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (symbol && !symbol.destroyed) {
        originalPositions[i] = { x: symbol.x, y: symbol.y };
      }
    }
    
    // Calculate visible area
    const visibleRows = backendSymbols.length;
    const maskStart = this.symbolSize;
    const dynamicHeight = this._getDynamicSymbolHeight(reel.index);
    const visibleStart = maskStart;
    const visibleEnd = visibleStart + (dynamicHeight * visibleRows);
    
    // Find symbols in visible area and sort by Y position (bottom to top)
    const visibleSymbolData = [];
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (!symbol || symbol.destroyed) continue;
      
      if (symbol.y >= visibleStart && symbol.y < visibleEnd) {
        const relativeY = symbol.y - visibleStart;
        const row = Math.floor(relativeY / dynamicHeight);
        if (row >= 0 && row < visibleRows) {
          const rowCenterY = visibleStart + (row * dynamicHeight) + (dynamicHeight / 2);
          visibleSymbolData.push({ 
            symbol, 
            row, 
            y: symbol.y, 
            distance: Math.abs(symbol.y - rowCenterY),
            index: i
          });
        }
      }
    }
    
    // Group by row and keep only the closest symbol to each row center
    const rowMap = new Map();
    for (const data of visibleSymbolData) {
      if (!rowMap.has(data.row) || data.distance < rowMap.get(data.row).distance) {
        rowMap.set(data.row, data);
      }
    }
    
    // Sort by row (bottom to top)
    const sortedSymbols = Array.from(rowMap.values()).sort((a, b) => a.row - b.row);
    
    // Apply backend symbols to visible positions
    // Backend symbols are ordered bottom to top (row 0 = bottom, row N-1 = top)
    for (let row = 0; row < backendSymbols.length && row < sortedSymbols.length; row++) {
      const symbolCode = backendSymbols[row];
      const symbolData = sortedSymbols[row];
      
      if (!symbolCode || !symbolData) continue;
      
      const texture = assets.get(symbolCode) || assets.get('PLACEHOLDER');
      if (!texture) continue;
      
      const symbol = symbolData.symbol;
      const symbolIndex = symbolData.index;
      
      // Only update texture, NEVER position
      if (symbol.symbolCode !== symbolCode) {
        symbol.texture = texture;
        const symbIdx = this.availableSymbols.indexOf(symbolCode);
        if (symbIdx >= 0) {
          symbol.iconID = symbIdx;
        }
        symbol.symbolCode = symbolCode;
        
        const scale = Math.min(
          this.symbolSize / symbol.texture.width,
          this.symbolSize / symbol.texture.height
        );
        symbol.scale.set(scale);
        
        // CRITICAL: Restore original position - DO NOT change it
        if (originalPositions[symbolIndex]) {
          symbol.x = originalPositions[symbolIndex].x;
          symbol.y = originalPositions[symbolIndex].y;
        } else {
          symbol.x = (this.reelWidth - symbol.width) / 2;
        }
      }
    }
    
    // CRITICAL: Restore ALL positions to prevent any jumps
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (symbol && !symbol.destroyed && originalPositions[i]) {
        symbol.x = originalPositions[i].x;
        symbol.y = originalPositions[i].y;
      }
    }
  }

  /**
   * Aligns visible symbols with backend result after spin completes
   * 
   * Finds symbols at visible positions and ensures they have correct textures
   * from the backend result. This prevents texture reload issues.
   * 
   * @param {Object} reel - Reel object
   * @param {Array<string>} backendSymbols - Expected symbols from backend (bottom to top)
   * @param {PIXI.Assets} assets - Assets API
   * @returns {void}
   */
  alignVisibleSymbolsWithBackend(reel, backendSymbols, assets) {
    if (!reel || !reel.symbols || !backendSymbols || backendSymbols.length === 0 || !assets) return;
    
    // Calculate visible area
    const visibleRows = backendSymbols.length;
    const maskStart = this.symbolSize;
    const dynamicHeight = this._getDynamicSymbolHeight(reel.index);
    const visibleStart = maskStart;
    const visibleEnd = visibleStart + (dynamicHeight * visibleRows);
    
    // Find symbols in visible area and sort by Y position (bottom to top)
    const visibleSymbolData = [];
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (!symbol || symbol.destroyed) continue;
      
      if (symbol.y >= visibleStart && symbol.y < visibleEnd) {
        const relativeY = symbol.y - visibleStart;
        const row = Math.floor(relativeY / dynamicHeight);
        if (row >= 0 && row < visibleRows) {
          visibleSymbolData.push({ symbol, row, y: symbol.y });
        }
      }
    }
    
    // Sort by Y position (bottom to top) - ensure we have exactly visibleRows symbols
    visibleSymbolData.sort((a, b) => a.y - b.y);
    
    // If we have more symbols than expected, take the ones closest to row centers
    if (visibleSymbolData.length > visibleRows) {
      // Keep symbols that are closest to their row centers
      const filtered = [];
      for (let row = 0; row < visibleRows; row++) {
        const rowCenterY = visibleStart + (row * dynamicHeight) + (dynamicHeight / 2);
        let closest = visibleSymbolData[0];
        let closestDist = Math.abs(visibleSymbolData[0].y - rowCenterY);
        
        for (let j = 1; j < visibleSymbolData.length; j++) {
          const dist = Math.abs(visibleSymbolData[j].y - rowCenterY);
          if (dist < closestDist) {
            closest = visibleSymbolData[j];
            closestDist = dist;
          }
        }
        
        filtered.push(closest);
        // Remove from array to avoid duplicates
        const index = visibleSymbolData.indexOf(closest);
        if (index >= 0) visibleSymbolData.splice(index, 1);
      }
      visibleSymbolData.length = 0;
      visibleSymbolData.push(...filtered);
      visibleSymbolData.sort((a, b) => a.y - b.y);
    }
    
    // Apply backend symbols to visible positions
    // Backend symbols are ordered bottom to top (row 0 = bottom, row N-1 = top)
    for (let row = 0; row < backendSymbols.length && row < visibleSymbolData.length; row++) {
      const symbolCode = backendSymbols[row];
      const symbolData = visibleSymbolData[row];
      
      if (!symbolCode || !symbolData) continue;
      
      // Ensure symbolCode is a string and matches availableSymbols
      const normalizedCode = String(symbolCode).trim();
      let finalCode = normalizedCode;
      
      // Check if the code exists in availableSymbols
      if (!this.availableSymbols.includes(normalizedCode)) {
        console.warn(`[GridRenderer] alignVisibleSymbolsWithBackend: Symbol code "${normalizedCode}" not in availableSymbols. Available:`, this.availableSymbols);
        // Try to find it (case-insensitive)
        const found = this.availableSymbols.find(s => s.toUpperCase() === normalizedCode.toUpperCase());
        if (found) {
          finalCode = found;
          console.log(`[GridRenderer] alignVisibleSymbolsWithBackend: Found case-insensitive match: "${normalizedCode}" -> "${found}"`);
        } else {
          finalCode = 'PLACEHOLDER';
          console.error(`[GridRenderer] alignVisibleSymbolsWithBackend: Using PLACEHOLDER for unknown symbol "${normalizedCode}"`);
        }
      }
      
      const texture = assets.get(finalCode) || assets.get('PLACEHOLDER');
      if (!texture) {
        console.error(`[GridRenderer] alignVisibleSymbolsWithBackend: No texture found for symbol "${finalCode}"`);
        continue;
      }
      
      const symbol = symbolData.symbol;
      
      // Only update if texture is different (avoid unnecessary updates)
      let currentSymbolCode = null;
      if (symbol.texture && this.currentAssets) {
        for (const alias of this.availableSymbols) {
          const tex = this.currentAssets.get(alias);
          if (tex && tex === symbol.texture) {
            currentSymbolCode = alias;
            break;
          }
        }
      }
      
      if (currentSymbolCode !== symbolCode) {
        symbol.texture = texture;
        symbol.symbolCode = finalCode; // Store the actual symbol code used
        const symbolIndex = this.availableSymbols.indexOf(finalCode);
        if (symbolIndex >= 0) {
          symbol.iconID = symbolIndex;
        }
        
        const scale = Math.min(
          this.symbolSize / symbol.texture.width,
          this.symbolSize / symbol.texture.height
        );
        symbol.scale.set(scale);
        symbol.x = (this.reelWidth - symbol.width) / 2;
        
        console.log(`[GridRenderer] alignVisibleSymbolsWithBackend: Reel ${reel.index}, Row ${row}: Updated ${currentSymbolCode || 'UNKNOWN'} → ${finalCode} (backend sent: ${symbolCode})`);
      }
    }
    
    console.log(`[GridRenderer] alignVisibleSymbolsWithBackend: Reel ${reel.index} - Aligned ${Math.min(visibleSymbolData.length, visibleRows)} visible symbols with backend`);
  }

  /**
   * Applies initial textures to all symbols from symbol order
   * 
   * Sets up all symbols with correct textures from symbOrder before spin starts.
   * This ensures correct symbols are visible from the start, and wrapping will
   * update them correctly during spin.
   * 
   * @param {Object} reel - Reel object
   * @param {PIXI.Assets} assets - Assets API
   * @returns {void}
   */
  applyInitialTexturesToVisibleSymbols(reel, assets) {
    if (!reel || !reel.symbols || reel.symbOrder.length === 0 || !assets) return;
    
    // CRITICAL: Apply textures to symbols based on symbOrder
    // This ensures all symbols have correct textures before spin starts
    // Unity approach: all symbols get textures from symbOrder initially
    // The symbOrder array already contains backend symbols at positions 0, 1, 2, ...
    // after updateSymbolOrderFromBackend was called
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (!symbol || symbol.destroyed) continue;
      
      // Get symbol from order array
      // Use modulo to cycle through order
      const orderIndex = i % reel.symbOrder.length;
      const symbIndex = reel.symbOrder[orderIndex];
      const symbolCode = this.availableSymbols[symbIndex] || this.availableSymbols[0];
      const texture = assets.get(symbolCode) || assets.get('PLACEHOLDER');
      
      if (texture) {
        symbol.texture = texture;
        symbol.iconID = symbIndex;
        
        // Store symbol code for identification
        symbol.symbolCode = symbolCode;
        
        const scale = Math.min(
          this.symbolSize / symbol.texture.width,
          this.symbolSize / symbol.texture.height
        );
        symbol.scale.set(scale);
        symbol.x = (this.reelWidth - symbol.width) / 2;
      }
    }
    
    // CRITICAL: Don't reset nextSymbIndex - it should continue from where it left off
    // This matches Unity's behavior where the counter keeps incrementing
    if (reel.nextSymbIndex === undefined || reel.nextSymbIndex === null) {
      reel.nextSymbIndex = 0;
    }
    
    console.log(`[GridRenderer] applyInitialTexturesToVisibleSymbols: Applied textures to all ${reel.symbols.length} symbols for reel ${reel.index} from order length ${reel.symbOrder.length}`);
  }

  /**
   * Gets angle to next symbol position (Unity GetAngleToNextSymb pattern)
   * 
   * @param {Object} reel - Reel object
   * @param {number} nextOrderPosition - Target position in symbol order
   * @returns {number} Angle in degrees to target position
   */
  getAngleToNextSymb(reel, nextOrderPosition) {
    // If already at target position, return 0 (no rotation needed)
    if (reel.currOrderPosition === nextOrderPosition) {
      return 0;
    }
    if (reel.currOrderPosition < nextOrderPosition) {
      return (nextOrderPosition - reel.currOrderPosition) * reel.anglePerTileDeg;
    }
    return (reel.symbOrder.length - reel.currOrderPosition + nextOrderPosition) * reel.anglePerTileDeg;
  }

  /**
   * Finds where backend symbols appear in the fixed reel strip
   * 
   * CRITICAL: We DON'T modify symbOrder - it's fixed like Unity.
   * Instead, we find where the backend symbols appear in the existing strip
   * and return that position as the stop position.
   * 
   * @param {Object} reel - Reel object
   * @param {Array<string>} backendSymbols - Symbol codes from backend (jagged array column)
   * @param {PIXI.Assets} assets - Assets API
   * @returns {number} Position in symbOrder where backend symbols start, or -1 if not found
   */
  findBackendSymbolsInStrip(reel, backendSymbols, assets) {
    if (!reel || !backendSymbols || backendSymbols.length === 0 || !reel.symbOrder || reel.symbOrder.length === 0) {
      console.error(`[GridRenderer] findBackendSymbolsInStrip: Reel ${reel?.index} - Invalid input`, {
        hasReel: !!reel,
        backendSymbolsLength: backendSymbols?.length || 0,
        symbOrderLength: reel?.symbOrder?.length || 0
      });
      return -1;
    }
    
    // CRITICAL: Map backend symbol codes to frontend symbol codes
    // Backend sends symbol codes like "BONUS", "BUFFALO", etc.
    // Use reverse symbol map: if we have FACE -> SCATTER mapping, use it
    const reverseSymbolMap = {};
    if (this.symbolMap) {
      // Create reverse map: frontend code -> backend code
      // But we need backend code -> frontend code, so invert symbolMap
      for (const [backendCode, frontendCode] of Object.entries(this.symbolMap)) {
        reverseSymbolMap[frontendCode] = backendCode; // Not needed, but keep for reference
      }
    }
    
    // Get symbol indices from backend symbols
      // CRITICAL: Backend sends codes like "BONUS", "BUFFALO", etc. which should match availableSymbols
    const symbolIndices = [];
    const symbolCodes = [];
    for (const backendSymbolCode of backendSymbols) {
      // First, try direct match (backend might already send frontend codes)
      let frontendCode = backendSymbolCode;
      let index = this.availableSymbols.indexOf(frontendCode);
      
      // If not found, try to find it in symbolMap values (reverse lookup)
      if (index < 0 && this.symbolMap) {
        // Check if backendSymbolCode is a frontend code that exists in symbolMap values
        const symbolMapValues = Object.values(this.symbolMap);
        if (symbolMapValues.includes(backendSymbolCode)) {
          frontendCode = backendSymbolCode;
          index = this.availableSymbols.indexOf(frontendCode);
        } else {
          // Backend sends symbol codes directly (e.g., "BONUS" from backend config)
          // Try to find if any symbolMap entry has this as the value
          for (const [symKey, symValue] of Object.entries(this.symbolMap)) {
            if (symValue === backendSymbolCode) {
              frontendCode = symValue;
              index = this.availableSymbols.indexOf(frontendCode);
              break;
            }
          }
        }
      }
      
      // If still not found, try special mappings
      if (index < 0) {
        // Special case: Backend sends "BONUS" (scatter symbol)
        if (backendSymbolCode === 'BONUS') {
          frontendCode = 'BONUS';
          index = this.availableSymbols.indexOf('BONUS');
          if (index >= 0) {
            console.log(`[GridRenderer] findBackendSymbolsInStrip: Found "BONUS" symbol`);
          }
        }
      }
      
      // If still not found, backend symbol doesn't exist in frontend
      if (index < 0) {
        console.error(`[GridRenderer] findBackendSymbolsInStrip: Backend symbol "${backendSymbolCode}" not found in availableSymbols. Available:`, this.availableSymbols);
        console.error(`[GridRenderer] findBackendSymbolsInStrip: Symbol map:`, this.symbolMap);
        // Try to use PLACEHOLDER instead of first symbol to avoid showing wrong symbols
        const placeholderIndex = this.availableSymbols.indexOf('PLACEHOLDER');
        index = placeholderIndex >= 0 ? placeholderIndex : 0;
        frontendCode = this.availableSymbols[index] || 'PLACEHOLDER';
        console.warn(`[GridRenderer] findBackendSymbolsInStrip: Using fallback symbol "${frontendCode}" for backend code "${backendSymbolCode}"`);
      }
      
      symbolIndices.push(index);
      symbolCodes.push(frontendCode);
    }
    
    console.log(`[GridRenderer] findBackendSymbolsInStrip: Reel ${reel.index} - Searching for backend symbols:`, {
      backendSymbols: backendSymbols,
      mappedSymbols: symbolCodes,
      symbolIndices: symbolIndices,
      symbOrderLength: reel.symbOrder.length,
      symbOrderSample: reel.symbOrder.slice(0, 20) // First 20 symbols for debugging
    });
    
    // Search for the sequence of backend symbols in the fixed symbOrder
    // This is like Unity finding where the backend result appears in the reel strip
    for (let startPos = 0; startPos < reel.symbOrder.length; startPos++) {
      let matches = true;
      for (let i = 0; i < symbolIndices.length; i++) {
        const orderIndex = (startPos + i) % reel.symbOrder.length;
        if (reel.symbOrder[orderIndex] !== symbolIndices[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        console.log(`[GridRenderer] findBackendSymbolsInStrip: Reel ${reel.index} - ✅ FOUND at position ${startPos} in fixed strip`);
        return startPos;
      }
    }
    
    // If not found, backend symbols don't exist in the fixed strip
    // This means the frontend strips don't match the backend strips!
    console.error(`[GridRenderer] findBackendSymbolsInStrip: Reel ${reel.index} - ❌ NOT FOUND in fixed strip!`, {
      backendSymbols: symbolCodes,
      symbolIndices: symbolIndices,
      symbOrderLength: reel.symbOrder.length,
      symbOrderFirst50: reel.symbOrder.slice(0, 50),
      availableSymbols: this.availableSymbols
    });
    return -1;
  }

  /**
   * Maps backend result to symbol order position (Unity approach)
   * 
   * CRITICAL: Backend sends symbols, but we need to find where they appear in the FIXED reel strip.
   * The fixed strip (symbOrder) never changes - it's like Unity's permanent reel configuration.
   * We search for the backend symbols in the fixed strip and return that position.
   * 
   * @param {Object} reel - Reel object
   * @param {Array<string>} backendSymbols - Symbol codes from backend
   * @param {PIXI.Assets} assets - Assets API
   * @returns {number} Target position in symbol order array (where backend symbols appear in fixed strip)
   */
  mapBackendResultToOrderPosition(reel, backendSymbols, assets) {
    if (!reel || !backendSymbols || backendSymbols.length === 0) {
      return 0;
    }
    
    // Store backend symbols for reference
    reel.backendSymbols = [...backendSymbols];
    
    // CRITICAL: Find where backend symbols appear in the FIXED reel strip
    // This is like Unity where backend tells us which position in symbOrder to stop at
    const stopPosition = this.findBackendSymbolsInStrip(reel, backendSymbols, assets);
    
    if (stopPosition === -1) {
      // Backend symbols not found in fixed strip - this shouldn't happen
      // Fallback: return 0 (start of strip)
      console.error(`[GridRenderer] mapBackendResultToOrderPosition: Reel ${reel.index} - Backend symbols not in fixed strip! Using position 0`);
      return 0;
    }
    
    console.log(`[GridRenderer] mapBackendResultToOrderPosition: Reel ${reel.index} - Backend symbols found at position ${stopPosition} in fixed strip`);
    return stopPosition;
  }

  buildReels(assets) {
    // Clear existing reels
    this.reels.forEach(reel => {
      if (reel.container && !reel.container.destroyed) {
        reel.container.destroy({ children: true });
      }
      if (reel.mask && !reel.mask.destroyed) {
        reel.mask.destroy();
      }
    });
    this.reels = [];

    // Clear top reel container if it exists
    if (this.topReelContainer) {
      this.topReelContainer.destroy({ children: true });
      this.topReelContainer = null;
    }

    // Get available symbol textures
    const slotTextures = this.availableSymbols
      .map(alias => assets.get(alias))
      .filter(texture => texture != null);

    if (slotTextures.length === 0) {
      console.warn('No symbol textures available for reels');
      return;
    }

    // Set default reel heights if not set (for initial display)
    if (!this.reelHeights || this.reelHeights.length !== this.columns) {
      // Default to fixed height (rows) for each reel
      this.reelHeights = Array(this.columns).fill(this.rows);
    }

    // Build top reel if needed (above reels 2-5, which are indices 1-4)
    // Top reel covers reels 2-5 (indices 1-4) - 4 symbols total
    const topReelCovers = [1, 2, 3, 4];
    const topReelSymbolCount = 4; // Number of visible symbols
    
    if (topReelCovers.length > 0) {
      // Clear existing top reel
      if (this.topReelContainer) {
        this.topReelContainer.destroy({ children: true });
      }
      
      this.topReelContainer = new PIXI.Container();
      this.topReelContainer.y = 0; // Positioned directly above main grid (no gap)
      this.topReelContainer.x = 0;
      this.topReelContainer.visible = true; // Ensure visible
      
      // Create spin layer for top reel
      this.topReelSpinLayer = new PIXI.Container();
      this.topReelSpinLayer.visible = true; // Ensure visible
      this.topReelContainer.addChild(this.topReelSpinLayer);
      
      // Create blur filter for top reel (same as vertical reels)
      this.topReelBlur = new PIXI.BlurFilter();
      this.topReelBlur.blurX = 0;
      this.topReelBlur.blurY = 0;
      this.topReelContainer.filters = [this.topReelBlur];
      
      // Create many symbol instances for smooth horizontal scrolling with visible passing symbols
      // Need enough symbols to create the visual effect of many symbols passing through
      const topReelBufferSymbols = 20; // Many extra symbols for visible scrolling effect
      const totalTopReelSymbols = topReelSymbolCount + topReelBufferSymbols; // Total: 24 symbols
      this.topReelSymbols = [];
      
      for (let i = 0; i < totalTopReelSymbols; i++) {
        // Use random texture initially, will be updated during spin
        const texture = slotTextures[Math.floor(Math.random() * slotTextures.length)];
        const symbol = new PIXI.Sprite(texture);
        
        symbol.scale.x = symbol.scale.y = Math.min(
          this.symbolSize / symbol.texture.width,
          this.symbolSize / symbol.texture.height
        );
        
        // Position symbols horizontally (right to left scrolling)
        // Symbols are positioned from right to left, so we start from the right
        // Initial positions: symbols should fill the visible area (4 symbols above reels 2-5)
        // The visible area is above reels 2-5 (indices 1-4), so symbols should be positioned
        // starting from the right edge of reel 5 (index 4)
        const rightmostX = topReelCovers[topReelCovers.length - 1] * this.reelWidth + this.reelWidth;
        // Position symbols in a continuous strip, starting from the right
        // Symbol 0 is at the rightmost position, symbol 1 is to its left, etc.
        // Initially, first 4 symbols should be visible above reels 2-5
        symbol.x = rightmostX - (i * this.reelWidth);
        symbol.y = Math.round((this.symbolSize - symbol.height) / 2);
        symbol.visible = true; // Ensure symbols are visible
        symbol.alpha = 1;
        
        // Ensure symbols are within the visible mask area initially
        // The mask covers reels 1-4 (indices 1-4), so symbols should be positioned there
        
        this.topReelSymbols.push(symbol);
        this.topReelSpinLayer.addChild(symbol);
      }
      
      // Create mask to show only the 4 visible symbols (one per covered reel)
      // Mask must be positioned at the same Y as the container for proper alignment
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff);
      const maskStartX = topReelCovers[0] * this.reelWidth;
      const maskWidth = topReelSymbolCount * this.reelWidth;
      mask.drawRect(maskStartX, 0, maskWidth, this.symbolSize);
      mask.endFill();
      mask.x = 0;
      mask.y = 0; // Align with topReelContainer Y position (now at 0)
      this.topReelContainer.mask = mask;
      this.container.addChild(mask);
      
      // Reset position
      this.topReelPosition = 0;
      this.topReelPreviousPosition = 0;
      this.topReelTargetPosition = 0;
      
      // Ensure container is visible and added to scene
      this.topReelContainer.visible = true;
      this.container.addChild(this.topReelContainer);
    }

    // --- FIX: Use FIXED height for reels based on rows (visible area) ---
    // This ensures the mask and spinning strip match the visible game window
    // CRITICAL: Use this.rows (fixed visible area) for the mask
    const fixedReelHeight = this.rows;

    // Build reels (one per column) with masking
    for (let i = 0; i < this.columns; i++) {
      const reelContainer = new PIXI.Container();
      // Round positions to prevent sub-pixel jitter
      reelContainer.x = Math.round(i * this.reelWidth);
      reelContainer.y = 0; // Fixed Y position - never changes

      const hasTopReel = this.topReel && [1, 2, 3, 4].includes(i);

      // --- FIX: MASK HEIGHT IS NOW CONSTANT ---
      // Always size the mask to maxRows, regardless of current spin result.
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff);
      const maskY = this.symbolSize; // Always start at symbolSize to hide the top buffer row
      const maskHeight = this.symbolSize * fixedReelHeight; // Fixed height
      mask.drawRect(0, maskY, this.reelWidth, maskHeight);
      mask.endFill();
      
      mask.x = 0;
      mask.y = 0;
      reelContainer.addChildAt(mask, 0);
      reelContainer.mask = mask;

      // Ensure reel containers are added after table sprite so they render on top
      this.container.addChild(reelContainer);

      const spinLayer = new PIXI.Container();
      const gridLayer = new PIXI.Container();
      gridLayer.visible = false;
      reelContainer.addChild(spinLayer);
      reelContainer.addChild(gridLayer);

      const blur = new PIXI.BlurFilter();
      blur.blurX = 0;
      blur.blurY = 0;
      reelContainer.filters = [blur];

      const reel = {
        container: reelContainer,
        symbols: [],
        gridSprites: [], // Will be populated dynamically based on result
        spinLayer,
        gridLayer,
        position: 0, // Legacy position tracking (kept for compatibility)
        previousPosition: 0,
        blur: blur,
        mask: mask,
        targetPosition: 0, // Legacy target position
        index: i, 
        finalTexturesApplied: false, 
        height: fixedReelHeight, // Fixed visual height
        // Cylindrical properties (Unity-style)
        tilesGroup: null, // Container for rotating symbols (like Unity's TilesGroup)
        rotationX: 0, // Current X-axis rotation in degrees
        anglePerTileDeg: 0, // Angle per symbol in degrees
        anglePerTileRad: 0, // Angle per symbol in radians
        radius: 0, // Cylinder radius
        tileCount: 0, // Number of symbols in cylinder
        topSector: 0, // Current top symbol index
        tempSectors: 0, // Temporary sector counter for wrapping
        lastChanged: -1, // Last changed symbol index
        symbOrder: [], // Symbol order array (like Unity)
        nextSymbIndex: 0, // Next symbol index in order
        currOrderPosition: 0, // Current position in symbol order
        nextOrderPosition: -1, // Target position in symbol order (-1 = continuous)
        spinTweenSeq: null, // Tween sequence for three-phase spin
        isFastSpin: false // Fast spin mode flag
      };

      // Create cylindrical reel (Unity-style)
      this.createSlotCylinder(reel, slotTextures, i, assets);
      
      // Store tilesGroup reference in spinLayer for easy access
      reel.spinLayer.tilesGroup = reel.tilesGroup;

      this.reels.push(reel);
    }
  }

  setupTicker() {
    // Remove existing ticker if any
    if (this.tickerCallback) {
      this.app.ticker.remove(this.tickerCallback);
    }

    // Create new ticker callback
    this.tickerCallback = () => {
      // Only update if we have reels
      if (this.reels.length === 0) return;

      // CRITICAL: Never allow random texture updates if resultMatrix exists
      // Once resultMatrix is set, we should preserve final textures, not overwrite with random ones
      // This ensures correct symbols are shown from the start, not random ones that get replaced
      const allowSpinLayout = this.isSpinning && !this.resultMatrix;
      
      // Update top reel position (horizontal scrolling)
      if (this.topReelSpinning && this.topReelSpinLayer && this.topReelSymbols.length > 0) {
        // CRITICAL FIX: When top reel is very close to target position, snap it early
        // This prevents visible symbol jumps when the reel stops
        if (Number.isFinite(this.topReelTargetPosition)) {
          const distanceToTarget = Math.abs(this.topReelPosition - this.topReelTargetPosition);
          const snapThreshold = this.reelWidth * 0.5; // Snap when within 0.5 reel widths
          
          if (distanceToTarget < snapThreshold && this.topReelPosition !== this.topReelTargetPosition) {
            // Force snap to target position off-screen before stopping
            this.topReelPosition = this.topReelTargetPosition;
            this.topReelPreviousPosition = this.topReelTargetPosition;
          }
        }
        
        const positionDelta = this.topReelPosition - this.topReelPreviousPosition;
        if (this.topReelBlur) {
          this.topReelBlur.blurX = allowSpinLayout ? Math.abs(positionDelta) * SPIN_BLUR_MULTIPLIER : 0;
        }
        this.topReelPreviousPosition = this.topReelPosition;
        
        // Update symbol positions horizontally (right to left)
        // Use EXACT same simple modulo formula as vertical reels for maximum smoothness
        // Vertical reels: symbol.y = ((reel.position + j) % reel.symbols.length) * symbolSize
        // Horizontal: Convert position from reelWidth units to symbol index units, then use same formula
        const topReelCovers = [1, 2, 3, 4];
        const rightmostX = topReelCovers[topReelCovers.length - 1] * this.reelWidth + this.reelWidth;
        const symbolCount = this.topReelSymbols.length;
        
        // Convert topReelPosition from reelWidth units (pixels) to symbol index units
        // This matches how vertical reels work: position is in symbol index units (0, 1, 2, ...)
        // For smooth scrolling, we need position in symbol indices, not pixels
        const positionInSymbolUnits = this.topReelPosition / this.reelWidth;
        
        for (let i = 0; i < symbolCount; i++) {
          const symbol = this.topReelSymbols[i];
          if (!symbol || symbol.destroyed) continue;
          
          // Use EXACT same simple modulo as vertical reels - this ensures same smoothness
          // Vertical: symbol.y = ((reel.position + j) % reel.symbols.length) * symbolSize
          // Horizontal: symbol.x = rightmostX - ((positionInSymbolUnits + i) % symbolCount) * reelWidth
          const wrappedIndex = ((positionInSymbolUnits + i) % symbolCount + symbolCount) % symbolCount;
          const symbolX = rightmostX - (wrappedIndex * this.reelWidth);
          
          symbol.x = symbolX;
          
          // Update textures during spin (random symbols while spinning)
          // BUT: Don't overwrite if final textures have been applied OR if resultMatrix exists
          // CRITICAL: Never apply random textures if resultMatrix exists - this ensures correct symbols from the start
          // Increase frequency to 30% so more symbols are visible passing through
          if (allowSpinLayout && this.currentAssets && this.availableSymbols.length > 0 && Math.random() < 0.3 && !this.resultMatrix) {
            const slotTextures = this.availableSymbols
              .map(alias => this.currentAssets.get(alias))
              .filter(texture => texture != null);
            
            if (slotTextures.length > 0) {
              const randomTexture = slotTextures[Math.floor(Math.random() * slotTextures.length)];
              if (randomTexture) {
                symbol.texture = randomTexture;
                const scale = Math.min(
                  this.symbolSize / symbol.texture.width,
                  this.symbolSize / symbol.texture.height
                );
                symbol.scale.set(scale);
              }
            }
          } else if (this.resultMatrix && allowSpinLayout) {
            // DEBUG: Log if we're trying to update textures when resultMatrix exists
            console.warn('[GridRenderer] TICKER: Attempted to update top reel texture but resultMatrix exists!', {
              hasResultMatrix: !!this.resultMatrix,
              allowSpinLayout,
              isSpinning: this.isSpinning
            });
          }
        }
      }

      // Update the reels (rotation-based, Unity-style)
      // Symbol positioning is now handled by updateReelRotation() during GSAP animations
      // Ticker only handles blur effects and other non-position updates
      for (let i = 0; i < this.reels.length; i++) {
        const reel = this.reels[i];
        if (!reel || !reel.container || reel.container.destroyed) continue;

        // Update blur based on rotation speed (if rotation is being animated)
        // Blur is primarily updated in updateReelRotation, but we can also update it here
        // for cases where rotation changes outside of animation callbacks
        if (reel.previousRotationX !== undefined && reel.rotationX !== undefined) {
          const rotationDelta = Math.abs(reel.rotationX - reel.previousRotationX);
          if (reel.blur) {
            reel.blur.blurY = allowSpinLayout && rotationDelta > 0.1 
              ? rotationDelta * SPIN_BLUR_MULTIPLIER 
              : 0;
          }
          reel.previousRotationX = reel.rotationX;
        }
      }

      // Update tweening
      if (this.tweening.length > 0) {
        const now = Date.now();
        const remove = [];

        for (let i = 0; i < this.tweening.length; i++) {
          const t = this.tweening[i];
          const phase = Math.min(1, (now - t.start) / t.time);

          t.object[t.property] = this.lerp(
            t.propertyBeginValue,
            t.target,
            t.easing(phase)
          );

          if (t.change) t.change(t);

          if (phase === 1) {
            t.object[t.property] = t.target;
            if (t.complete) t.complete(t);
            remove.push(t);
          }
        }

        // Remove completed tweens
        for (let i = remove.length - 1; i >= 0; i--) {
          const index = this.tweening.indexOf(remove[i]);
          if (index !== -1) {
            this.tweening.splice(index, 1);
          }
        }
      }
    };

    this.app.ticker.add(this.tickerCallback);
  }

  /**
   * Simplified single-phase downward spin
   * 
   * Spins continuously downward and stops on backend result.
   * Backend symbols are preloaded during spin via symbol wrapping.
   * 
   * @param {Object} reel - Reel object
   * @param {number} nextOrderPosition - Target position in symbol order (-1 for continuous)
   * @param {Function} onComplete - Callback when spin completes
   * @returns {void}
   */
  nextRotateCylinderEase(reel, nextOrderPosition, onComplete) {
    if (!reel || !reel.tilesGroup) {
      console.warn('[GridRenderer] nextRotateCylinderEase: Reel not properly initialized');
      if (onComplete) onComplete();
      return;
    }

    reel.nextOrderPosition = nextOrderPosition !== undefined ? nextOrderPosition : -1;
    
    // Spin parameters
    const spinSpeedMultiplier = 4; // Full rotations before stop
    const baseSpinTime = 1.2 + (reel.index * 0.2); // Base time + stagger per reel
    const spinTime = reel.isFastSpin ? baseSpinTime * 0.6 : baseSpinTime; // Turbo mode is 60% faster
    
    // Calculate target angle (always downward/negative)
    // CRITICAL: Use Unity's exact approach
    // Unity: angleX = GetAngleToNextSymb(NextOrderPosition) + anglePerTileDeg * symbOrder.Count * spinSpeedMultiplier
    // Since backend symbols are at positions 0, 1, 2, ... in symbOrder (after updateSymbolOrderFromBackend)
    // NextOrderPosition is 0 (where backend symbols start)
    // CurrOrderPosition is 0 (reset at start)
    // So GetAngleToNextSymb(0) when curr=0 returns 0
    // But we still need full rotations for visual effect
    let targetAngle = 0;
    if (reel.nextOrderPosition !== -1 && this.resultMatrix && this.resultMatrix[reel.index]) {
      // Unity approach: GetAngleToNextSymb calculates angle from current to target position
      const angleToNextSymb = this.getAngleToNextSymb(reel, reel.nextOrderPosition);
      const fullRotations = reel.anglePerTileDeg * reel.symbOrder.length * spinSpeedMultiplier;
      
      // Total angle = angle to next symbol + full rotations
      // We use negative to spin downward
      targetAngle = -(angleToNextSymb + fullRotations);
      
    } else {
      // Continuous spin - use large negative angle
      targetAngle = -reel.anglePerTileDeg * reel.symbOrder.length * spinSpeedMultiplier;
    }
    
    // Reset temp sectors
    reel.tempSectors = 0;
    
    // Kill any existing animation
    if (reel.spinTweenSeq) {
      reel.spinTweenSeq.kill();
    }
    
    let previousRotation = reel.rotationX;
    
    // Single smooth downward spin with ease-out
    let updateCount = 0;
    reel.spinTweenSeq = gsap.to(reel, {
      duration: spinTime,
      ease: 'power2.out', // Smooth deceleration
      rotationX: reel.rotationX + targetAngle, // Always negative (downward)
      onUpdate: () => {
        const delta = reel.rotationX - previousRotation;
        previousRotation = reel.rotationX;
        this.updateReelRotation(reel, delta);
        // Wrap symbols during spin (uses backend symbols from resultMatrix)
        this.wrapSymbolTape(reel, delta, this.currentAssets);
        
        // CRITICAL: DO NOT apply backend symbols during spin - they should already be correct
        // from applyInitialTexturesToVisibleSymbols, and wrapping will maintain them
        
        updateCount++;
      },
      onComplete: () => {
        // Final wrap to ensure all symbols are correct
        // CRITICAL: Do one final wrap with the full target angle to ensure all visible symbols are correct
        this.wrapSymbolTape(reel, targetAngle, this.currentAssets);
        reel.currOrderPosition = reel.nextOrderPosition !== -1 ? reel.nextOrderPosition : reel.currOrderPosition;
        reel.topSector = ((reel.topSector + Math.abs(Math.round(targetAngle / reel.anglePerTileDeg))) % reel.tileCount + reel.tileCount) % reel.tileCount;
        reel.tempSectors = 0;
        if (onComplete) onComplete();
      }
    });
  }

  /**
   * Continuous rotation (Unity RecurRotation pattern)
   * 
   * Rotates one full cycle continuously until nextOrderPosition is set.
   * 
   * @param {Object} reel - Reel object
   * @param {number} rotTime - Time for one full rotation
   * @param {Function} completeCallback - Callback when rotation completes
   * @returns {void}
   */
  recurRotation(reel, rotTime, completeCallback) {
    if (!reel || reel.nextOrderPosition !== -1) {
      if (completeCallback) completeCallback();
      return;
    }
    
    const newAngle = -reel.anglePerTileDeg * reel.symbOrder.length;
    reel.tempSectors = 0;
    let oldVal = 0;
    
    gsap.to(reel, {
      duration: rotTime,
      ease: 'linear',
      rotationX: `+=${newAngle}`,
      onUpdate: () => {
        const delta = reel.rotationX - (reel.previousRotationX || 0);
        reel.previousRotationX = reel.rotationX;
        this.updateReelRotation(reel, delta);
        this.wrapSymbolTape(reel, delta, this.currentAssets);
      },
      onComplete: () => {
        this.wrapSymbolTape(reel, newAngle, this.currentAssets);
        reel.tempSectors = 0;
        reel.topSector = ((reel.topSector + reel.symbOrder.length) % reel.tileCount + reel.tileCount) % reel.tileCount;
        
        if (reel.nextOrderPosition === -1) {
          // Continue rotating
          this.recurRotation(reel, rotTime, completeCallback);
        } else {
          // Stop and continue to next phase
          if (completeCallback) completeCallback();
        }
      }
    });
  }

  /**
   * Updates reel rotation and symbol positions
   * 
   * Converts rotation angle to vertical position offset and updates symbol positions.
   * In 2D, we simulate cylindrical rotation with vertical positioning.
   * 
   * @param {Object} reel - Reel object
   * @param {number} deltaAngle - Change in rotation angle (degrees)
   * @returns {void}
   */
  updateReelRotation(reel, deltaAngle) {
    if (!reel || !reel.tilesGroup || !reel.symbols) return;
    
    // CRITICAL: Don't update positions if spin is complete and reel animation is done
    // This prevents position jumps after the spin stops
    if (!this.isSpinning && reel.spinTweenSeq && !reel.spinTweenSeq.isActive()) {
      return; // Spin is complete, don't recalculate positions
    }
    
    // In 2D, rotation around X-axis translates to vertical movement
    // Convert rotation angle to vertical offset
    const angleRad = reel.rotationX * (Math.PI / 180);
    
    // Calculate visible area center (where symbols should be centered)
    // CRITICAL: Use a consistent visibleRows calculation to prevent position shifts
    const visibleRows = this.reelHeights && this.reelHeights[reel.index] 
      ? this.reelHeights[reel.index] 
      : this.rows;
    const maskStart = this.symbolSize;
    const visibleCenter = maskStart + (visibleRows * this.symbolSize) / 2;
    
    // Track if any symbols jump
    let hasJump = false;
    const jumps = [];
    
    // Update symbol positions based on rotation
    // Each symbol's Y position is calculated from its angle on the cylinder
    for (let i = 0; i < reel.symbols.length; i++) {
      const symbol = reel.symbols[i];
      if (!symbol || symbol.destroyed) continue;
      
      const prevY = symbol._lastY !== undefined ? symbol._lastY : symbol.y;
      
      // Calculate symbol's angle on cylinder (including rotation)
      // Symbols are arranged in a circle, so each has a base angle
      const baseAngle = i * reel.anglePerTileRad;
      const currentAngle = baseAngle + angleRad;
      
      // Project cylinder to 2D (Y position)
      // Unity: y = radius * sin(angle), z = -radius * cos(angle)
      // In 2D, we use Y position directly
      // INVERT the Y offset so negative rotationX moves symbols DOWN (correct direction)
      const yOffset = -reel.radius * Math.sin(currentAngle);
      
      // Position symbol relative to visible center
      const newY = visibleCenter + yOffset;
      const yDelta = Math.abs(newY - prevY);
      
      // Detect jumps (position changes > 10 pixels that aren't from normal rotation)
      if (symbol._lastY !== undefined && yDelta > 10 && Math.abs(deltaAngle) < 1) {
        hasJump = true;
        jumps.push({ index: i, prevY: prevY.toFixed(1), newY: newY.toFixed(1), delta: yDelta.toFixed(1) });
      }
      
      symbol.y = newY;
      symbol.x = (this.reelWidth - symbol.width) / 2;
      symbol._lastY = newY;
      
      // Update blur based on rotation speed
      if (reel.blur && Math.abs(deltaAngle) > 0.1) {
        reel.blur.blurY = Math.abs(deltaAngle) * SPIN_BLUR_MULTIPLIER;
      } else if (reel.blur) {
        reel.blur.blurY = 0;
      }
    }
    
  }

  /**
   * Starts the spin animation
   * 
   * Begins visual reel spinning with staggered timing using Unity-style three-phase spin.
   * Each reel starts slightly after the previous one for a cascading effect.
   * 
   * Flow:
   * 1. Validate not already spinning
   * 2. Build reels if needed
   * 3. Enter spin mode
   * 4. Reset texture flags
   * 5. Start each reel with three-phase spin
   * 6. Start top reel (horizontal scrolling)
   * 
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  startSpin(assets) {
    if (this.running) {
      console.warn('Spin already running');
      return;
    }
    
    this.debugLogger.start();

    this.running = true;
    this.currentAssets = assets;
    this.onSpinComplete = null;
    
    // CRITICAL: Don't reset resultMatrix if it's already been set by preloadSpinResult
    // This ensures the spin starts with correct textures already applied
    // Only reset if it hasn't been preloaded (for backward compatibility)
    if (this.resultMatrix) {
      console.log('[GridRenderer] startSpin: resultMatrix already set by preloadSpinResult, keeping it');
    } else {
      this.resultMatrix = null;
    }
    
    // Reset megaways display to blank at start of spin
    const waysDisplay = document.getElementById('ways-to-win');
    if (waysDisplay) {
      waysDisplay.textContent = '';
    }

    // CRITICAL: Reels should already be built during initialization (in initializeReels)
    // Only build if they don't exist (shouldn't happen, but safety check)
    if (this.reels.length === 0) {
      console.warn('[GridRenderer] startSpin: Reels not built! Building now (should have been built during init)');
      this.buildReels(assets);
    }
    
    // CRITICAL: Ensure all reels are visible and in spin mode BEFORE starting animation
    // This prevents any visual glitches or disappearing reels
    this.enterSpinMode();
    
    // Ensure all reel containers are visible and ready for animation
    for (let i = 0; i < this.reels.length; i++) {
      const reel = this.reels[i];
      if (reel) {
        if (reel.container) {
          reel.container.visible = true;
          reel.container.alpha = 1;
        }
        if (reel.spinLayer) {
          reel.spinLayer.visible = true;
        }
        if (reel.gridLayer) {
          reel.gridLayer.visible = false;
        }
        // Ensure all symbols in the reel are visible
        if (Array.isArray(reel.symbols)) {
          reel.symbols.forEach(symbol => {
            if (symbol) {
              symbol.visible = true;
              symbol.alpha = 1;
            }
          });
        }
      }
    }
    
    // CRITICAL: Ensure masks are still properly set (they should never change)
    // Verify all reels have masks and they're the correct size
    for (let i = 0; i < this.reels.length; i++) {
      const reel = this.reels[i];
      if (reel && reel.container && reel.mask) {
        // Ensure mask is still set on container
        if (reel.container.mask !== reel.mask) {
          reel.container.mask = reel.mask;
        }
        // Verify mask height is correct (should always be rows * symbolSize)
        const expectedMaskHeight = this.rows * this.symbolSize;
        const currentMaskHeight = reel.mask.height || 0;
        if (Math.abs(currentMaskHeight - expectedMaskHeight) > 1) {
          console.warn(`[GridRenderer] startSpin: Reel ${i} mask height mismatch. Expected: ${expectedMaskHeight}, Got: ${currentMaskHeight}`);
        }
      }
    }

    // CRITICAL: Reset final texture flags BEFORE entering spin mode
    // This ensures flags are reset before isSpinning is set to true (which enables ticker)
    // Reset final texture flags for all reels
    // These flags track if final textures have been applied during spin
    for (let i = 0; i < this.reels.length; i++) {
      const reel = this.reels[i];
      if (reel) {
        reel.finalTexturesApplied = false;
      }
    }

    this.enterSpinMode(); // Show spin layer, hide grid layer (sets isSpinning = true)

    // Start each reel spinning with Unity-style three-phase spin
    // Reels start left to right with increasing delay
    for (let i = 0; i < this.reels.length; i++) {
      const reel = this.reels[i];
      if (!reel || !reel.tilesGroup) {
        console.warn(`[GridRenderer] startSpin: Reel ${i} not properly initialized`);
        continue;
      }

      // CRITICAL: Reset rotation state to 0 FIRST, before any calculations
      // This ensures reels start from the correct position
      reel.rotationX = 0;
      reel.previousRotationX = 0;
      reel.tempSectors = 0;
      reel.currOrderPosition = 0; // Reset current order position
      reel.backendSymbolsApplied = false; // Reset flag so symbols can be applied during spin
      
      // CRITICAL: Find stop position in FIXED reel strip (like Unity)
      // Backend sends symbols, we find where they appear in the fixed symbOrder strip
      // DO NOT modify symbOrder - it's fixed like Unity's permanent reel configuration
      let nextOrderPosition = -1; // -1 = continuous rotation
      if (this.resultMatrix && this.resultMatrix[i] && this.resultMatrix[i].length > 0) {
        // Map backend symbols to position in fixed reel strip
        nextOrderPosition = this.mapBackendResultToOrderPosition(reel, this.resultMatrix[i], assets);
      }
      
      // Set fast spin mode if turbo
      reel.isFastSpin = this.isTurboMode;
      
      // CRITICAL: Apply initial textures to visible symbols BEFORE spin starts
      // This ensures correct symbols are visible from the start
      // Unity does this by setting up symbols with textures from symbOrder initially
      this.applyInitialTexturesToVisibleSymbols(reel, assets);
      
      // Callback for when reel completes
      const onReelComplete = () => {
        // Update megaways display as each reel stops
        this.updateMegawaysProgressive(i);
        
        // Last reel calls completion
        if (i === this.reels.length - 1) {
          this.reelsComplete();
        }
      };
      
      // Start three-phase spin
      this.nextRotateCylinderEase(reel, nextOrderPosition, onReelComplete);
    }
    
    // Start top reel spinning (horizontal, right to left)
    if (this.topReelContainer && this.topReelSpinLayer && this.topReelSymbols.length > 0) {
      this.topReelSpinning = true;
      // Ensure all strip symbols are visible for the next spin (reelsComplete may have hidden indices 4+)
      for (let i = 0; i < this.topReelSymbols.length; i++) {
        const s = this.topReelSymbols[i];
        if (s && !s.destroyed) s.visible = true;
      }
      
      // CRITICAL: Normalize current position to prevent accumulation of large negative values
      // This ensures smooth spinning on subsequent spins
      const symbolCount = this.topReelSymbols.length;
      const totalSymbolWidth = symbolCount * this.reelWidth;
      if (this.topReelPosition < -totalSymbolWidth || this.topReelPosition > totalSymbolWidth) {
        // Normalize position to prevent overflow
        this.topReelPosition = ((this.topReelPosition % totalSymbolWidth) + totalSymbolWidth) % totalSymbolWidth;
      }
      
      this.topReelPreviousPosition = this.topReelPosition;
      
      // Calculate target position for horizontal spin (right to left = negative movement)
      // Top reel should spin faster and stop before the main grid for visual appeal
      const extra = Math.floor(Math.random() * 3);
      const baseTime = this.isTurboMode ? SPIN_BASE_TIME * 0.4 : SPIN_BASE_TIME;
      const staggerTime = this.isTurboMode ? SPIN_STAGGER_TIME * 0.4 : SPIN_STAGGER_TIME;
      
      // Top reel spins with enough time to see many symbols pass through
      // But still stops before the main grid for visual appeal
      const firstReelTime = baseTime + extra * staggerTime;
      // Use 85% of first reel time - enough to see symbols pass, but still faster
      const topReelTime = firstReelTime * 0.85;
      
      // Add slight delay (50ms) so top reel starts slightly after main grid for visual sync
      const startDelay = 0.05; // 50ms delay in seconds
      
      // Calculate spin distance - spin MANY symbols through the visible positions
      // topReelPosition is in pixels (reelWidth units), so we multiply by reelWidth
      // We want to see many symbols pass through, so spin through many symbol widths
      // Spin through 50-60 symbols to create the visual effect of many symbols passing
      const symbolsToSpin = SPIN_BASE_TARGET * 4 + extra * 3; // Spin through many symbols (60+ symbols)
      const spinDistancePixels = symbolsToSpin * this.reelWidth; // Convert to pixels
      this.topReelTargetPosition = this.topReelPosition - spinDistancePixels;
      
      // Create GSAP tween for top reel (horizontal animation)
      if (this.topReelTween) {
        this.topReelTween.kill();
      }
      
      // Use smoother easing for more fluid motion
      // Power2.out provides smooth deceleration that looks more natural
      this.topReelTween = gsap.to(this, {
        topReelPosition: this.topReelTargetPosition,
        duration: (topReelTime / 1000), // Convert ms to seconds
        delay: startDelay, // Start slightly after main grid
        ease: 'power2.out', // Smoother easing for more fluid motion
        // GSAP will update topReelPosition smoothly, ticker will read it each frame
        onComplete: () => {
          this.topReelSpinning = false;
          this.topReelPosition = this.topReelTargetPosition;
          this.topReelPreviousPosition = this.topReelTargetPosition;
          if (this.topReelBlur) {
            this.topReelBlur.blurX = 0;
          }
        }
      });
    }
  }

  /**
   * Stops the spin animation immediately
   * 
   * Used for error recovery or when spin needs to be stopped.
   * Removes all blur effects and notifies completion.
   * 
   * @returns {void}
   */
  stopSpin() {
    if (!this.running && !this.onSpinComplete) {
      return;
    }

    // Stop all tweens immediately
    this.tweening = [];
    this.running = false;
    this.isSpinning = false;
    this.isCascading = false;

    // Remove blur from all reels
    for (let i = 0; i < this.reels.length; i++) {
      const reel = this.reels[i];
      if (reel) {
          reel.blur.blurY = 0;
      }
    }
    
    // Stop top reel animation
    if (this.topReelTween) {
      this.topReelTween.kill();
      this.topReelTween = null;
    }
    this.topReelSpinning = false;
    if (this.topReelBlur) {
      this.topReelBlur.blurX = 0;
    }

    this._notifySpinComplete();
  }

  reelsComplete() {
    // CRITICAL: Set isSpinning to false FIRST to prevent updateReelRotation from running
    this.running = false;
    this.isSpinning = false;

    for (let i = 0; i < this.reels.length; i++) {
      const reel = this.reels[i];
      if (reel) {
        if (reel.blur) {
          reel.blur.blurY = 0;
        }
        if (this.resultMatrix && this.resultMatrix[i] && this.currentAssets) {
          reel.finalTexturesApplied = true;
        }
      }
    }

    setTimeout(() => {
      this.debugLogger.download();
    }, 500);
    
    // Ensure top reel is at exact target position and apply final textures
    if (this.topReelSpinLayer && this.topReelSymbols.length > 0) {
      this.topReelSpinning = false;
      if (Number.isFinite(this.topReelTargetPosition)) {
        this.topReelPosition = this.topReelTargetPosition;
        this.topReelPreviousPosition = this.topReelTargetPosition;
      }
      if (this.topReelBlur) {
        this.topReelBlur.blurX = 0;
      }
      
      // Update top reel symbols to final positions
      // Textures should already be applied by _applyResultToTopReelSpinLayer in preloadSpinResult
      // Just ensure positions are correct
      const topReelCovers = [1, 2, 3, 4];
      const symbolSpacing = this.reelWidth;
      const totalSymbolWidth = this.topReelSymbols.length * symbolSpacing;
      
      // Base X position: rightmost edge of the visible area (end of reel 5)
      const rightmostX = topReelCovers[topReelCovers.length - 1] * this.reelWidth + this.reelWidth;
      
      // Normalize position for wrapping
      let normalizedPos = this.topReelPosition;
      if (normalizedPos < 0) {
        normalizedPos = (normalizedPos % totalSymbolWidth + totalSymbolWidth) % totalSymbolWidth;
      } else {
        normalizedPos = normalizedPos % totalSymbolWidth;
      }
      
      for (let i = 0; i < this.topReelSymbols.length; i++) {
        const symbol = this.topReelSymbols[i];
        if (!symbol || symbol.destroyed) continue;
        
        // Position symbols horizontally with wrapping (same logic as ticker)
        const wrappedPos = ((normalizedPos + (i * symbolSpacing)) % totalSymbolWidth);
        let symbolX = rightmostX - wrappedPos;
        
        // Wrap symbols around for continuous scrolling
        if (symbolX < topReelCovers[0] * this.reelWidth - totalSymbolWidth) {
          symbolX += totalSymbolWidth;
        } else if (symbolX > rightmostX + symbolSpacing) {
          symbolX -= totalSymbolWidth;
        }
        
        symbol.x = symbolX;
      }
      
      // CRITICAL: Apply backend top reel symbols when spin completes
      // this.topReel is set from results.topReelSymbols (e.g. [A, A, MOOSE, J])
      // The 4 visible slots above columns 1-4 must show exactly these symbols
      const assets = this.currentAssets;
      if (this.topReel && Array.isArray(this.topReel) && this.topReel.length >= 4 && assets) {
        for (let i = 0; i < this.topReelSymbols.length; i++) {
          const symbol = this.topReelSymbols[i];
          if (!symbol || symbol.destroyed) continue;
          if (i < topReelCovers.length) {
            const symbolCode = this.topReel[i];
            const texture = symbolCode ? assets.get(symbolCode) : null;
            if (texture) {
              symbol.texture = texture;
              const scale = Math.min(
                this.symbolSize / texture.width,
                this.symbolSize / texture.height
              );
              symbol.scale.set(scale);
            }
            const col = topReelCovers[i];
            symbol.x = col * this.reelWidth + (this.reelWidth / 2) - (symbol.width / 2);
            symbol.y = Math.round((this.symbolSize - symbol.height) / 2);
            symbol.visible = true;
          } else {
            symbol.visible = false;
          }
        }
      } else {
        for (let i = 0; i < topReelCovers.length && i < this.topReelSymbols.length; i++) {
          const symbol = this.topReelSymbols[i];
          if (symbol && !symbol.destroyed) {
            const col = topReelCovers[i];
            symbol.x = col * this.reelWidth + (this.reelWidth / 2) - (symbol.width / 2);
            symbol.y = Math.round((this.symbolSize - symbol.height) / 2);
          }
        }
      }
    }

    // Option A: When there are no cascades, strip search may have failed so reels stopped at wrong position.
    // Switch to grid mode and render backend result so final display always matches backend.
    if (!this.hasCascadesThisRound && this.resultMatrix && this.currentAssets && Array.isArray(this.resultMatrix) && this.resultMatrix.length >= this.columns) {
      this.enterGridMode();
      this.renderGridFromMatrix(this.resultMatrix, this.currentAssets);
    }

    this._notifySpinComplete();
  }

  /**
   * Updates megaways display progressively as each reel stops
   * Calculates ways: reelHeights[0] × reelHeights[1] × ... × reelHeights[reelIndex]
   * Shows exactly 6 discrete number changes (one per reel stop)
   * 
   * Example with reelHeights [6, 5, 5, 6, 3, 2]:
   * - Reel 0 stops: 6
   * - Reel 1 stops: 6 × 5 = 30
   * - Reel 2 stops: 6 × 5 × 5 = 150
   * - Reel 3 stops: 6 × 5 × 5 × 6 = 900
   * - Reel 4 stops: 6 × 5 × 5 × 6 × 3 = 2700
   * - Reel 5 stops: 6 × 5 × 5 × 6 × 3 × 2 = 5400
   * 
   * @param {number} reelIndex - Index of the reel that just stopped (0-5)
   */
  updateMegawaysProgressive(reelIndex) {
    if (!this.reelHeights || !Array.isArray(this.reelHeights) || this.reelHeights.length === 0) {
      return; // No reel heights available yet
    }

    // Calculate progressive ways: multiply reel heights up to the current reel
    // This creates exactly 6 discrete number changes (one per reel stop)
    let ways = 1;
    const calculation = [];
    for (let i = 0; i <= reelIndex && i < this.reelHeights.length; i++) {
      ways *= this.reelHeights[i];
      calculation.push(this.reelHeights[i]);
    }

    console.log(`[GridRenderer] updateMegawaysProgressive: Reel ${reelIndex} stopped - Calculation: ${calculation.join(' × ')} = ${ways}`);

    // Animate from current displayed value to new calculated value
    // This creates 6 discrete number changes (one per reel stop)
    this.animateMegawaysCount(ways);
  }

  /**
   * Animates the megaways number from current value to target value
   * Creates discrete number changes - one per reel stop (6 total changes)
   * Animation starts when first reel stops and finishes when last reel stops
   * 
   * @param {number} targetValue - Target value to animate to
   */
  animateMegawaysCount(targetValue) {
    const waysDisplay = document.getElementById('ways-to-win');
    const waysBox = document.getElementById('ways-to-win-box');
    
    if (!waysDisplay || !waysBox) {
      return;
    }

    // Ensure box is visible (always visible, but number starts blank)
    waysBox.style.display = 'block';

    // Get current displayed value (if blank, start from 0)
    const currentText = waysDisplay.textContent.replace(/,/g, '').trim();
    const currentValue = currentText === '' ? 0 : parseInt(currentText, 10) || 0;

    // If already at target, no need to animate
    if (currentValue === targetValue) {
      waysDisplay.textContent = targetValue.toLocaleString();
      return;
    }

    // Animate from current value to target value
    // Duration: 0.4s per reel stop - creates smooth discrete transitions
    // This ensures animation completes before next reel stops
    gsap.to({ value: currentValue }, {
      value: targetValue,
      duration: 0.4, // Animation duration per reel stop
      ease: 'power2.out', // Smooth deceleration
      onUpdate: function() {
        waysDisplay.textContent = Math.round(this.targets()[0].value).toLocaleString();
      }
    });
  }

  /**
   * Positions the megaways div above reel 6 (column 5), offset 100px to the right
   * Called when grid is positioned or resized
   */
  positionMegawaysDisplay() {
    const waysBox = document.getElementById('ways-to-win-box');
    if (!waysBox || !this.container) {
      return;
    }

    // Get grid container position (from SceneManager's sceneLayer)
    // The grid container is inside sceneLayer which is positioned by SceneManager
    // We need to get the sceneLayer's position and scale
    const sceneLayer = this.container.parent;
    if (!sceneLayer) {
      return;
    }

    // Calculate position of reel 6 (column 5) in screen coordinates
    // Reel 6 is at column index 5
    const reel6ColumnIndex = 5;
    const reel6X = reel6ColumnIndex * this.reelWidth;
    
    // Position above the grid (at the top, same level as top reel)
    const reel6Y = 0; // Top of grid container

    // Apply scene layer transform (position and scale)
    const sceneX = sceneLayer.x || 0;
    const sceneY = sceneLayer.y || 0;
    const sceneScale = sceneLayer.scale?.x || 1;

    // Calculate final screen position
    // Center of reel 6, then offset 100px to the right
    const screenX = sceneX + (reel6X * sceneScale) + (this.reelWidth * sceneScale / 2) + 100;
    const screenY = sceneY + (reel6Y * sceneScale);

    // Position the div (subtract half width to center it)
    const boxWidth = waysBox.offsetWidth || 150;
    waysBox.style.left = `${screenX - boxWidth / 2}px`;
    waysBox.style.top = `${screenY}px`;
  }

  tweenTo(object, property, target, time, easing, onchange, oncomplete) {
    const tween = {
      object,
      property,
      propertyBeginValue: object[property],
      target,
      easing,
      time,
      change: onchange,
      complete: oncomplete,
      start: Date.now()
    };

    this.tweening.push(tween);
    return tween;
  }

  lerp(a1, a2, t) {
    return a1 * (1 - t) + a2 * t;
  }

  backout(amount) {
    return (t) => --t * t * ((amount + 1) * t + amount) + 1;
  }

  setAvailableSymbols(symbols) {
    this.availableSymbols = symbols;
    console.log('[GridRenderer] setAvailableSymbols: Available symbols set to:', this.availableSymbols);
  }

  renderSymbols(symbolMatrix, assets) {
    this.renderGridFromMatrix(symbolMatrix, assets);
  }

  renderGridFromMatrix(reelSymbols, assets) {
    // reelSymbols is now a jagged array: reelSymbols[column][row]
    // Each column is an array of symbol codes for that reel (row 0 = bottom, row N = top)
    if (!reelSymbols || !Array.isArray(reelSymbols) || reelSymbols.length < this.columns) {
      console.warn('[GridRenderer] renderGridFromMatrix: Invalid reel symbols structure', reelSymbols);
      return;
    }

    this.currentAssets = assets;

    if (this.reels.length === 0) {
      this.buildReels(assets);
    }

    // ===== DEBUG: Log all critical state =====
    console.log(`[GridRenderer] renderGridFromMatrix: ===== START RENDER =====`);
    console.log(`[GridRenderer] renderGridFromMatrix: this.reelHeights =`, this.reelHeights);
    console.log(`[GridRenderer] renderGridFromMatrix: this.maxRows = ${this.maxRows}`);
    console.log(`[GridRenderer] renderGridFromMatrix: this.topReel =`, this.topReel);
    console.log(`[GridRenderer] renderGridFromMatrix: reelSymbols lengths = [${reelSymbols.map(r => r?.length || 0).join(', ')}]`);

    // Render each reel column
    for (let col = 0; col < this.columns && col < reelSymbols.length; col++) {
      const reel = this.reels[col];
      if (!reel) continue;

      const reelSymbolsForColumn = reelSymbols[col];
      if (!Array.isArray(reelSymbolsForColumn)) {
        console.warn(`[GridRenderer] renderGridFromMatrix: Reel ${col} is not an array`, reelSymbolsForColumn);
        continue;
      }

      // CRITICAL: Use ReelHeights to determine symbol count (source of truth from backend)
      // Backend sends ReelHeights that include top reel for columns 1-4
      const topReelCovers = [1, 2, 3, 4]; // Columns covered by top reel
      let reelSymbolCount;
      
      if (this.reelHeights && Array.isArray(this.reelHeights) && this.reelHeights.length > col && typeof this.reelHeights[col] === 'number' && this.reelHeights[col] > 0) {
        // ReelHeights includes top reel for columns 1-4, but arrays don't
        reelSymbolCount = this.reelHeights[col];
        if (topReelCovers.includes(col)) {
          reelSymbolCount = reelSymbolCount - 1; // Exclude top reel symbol
        }
        // Ensure we don't exceed array length (safety check)
        if (reelSymbolCount > reelSymbolsForColumn.length) {
          console.warn(`[GridRenderer] renderGridFromMatrix: Reel ${col} - reelSymbolCount (${reelSymbolCount}) > array.length (${reelSymbolsForColumn.length}), using array.length`);
          reelSymbolCount = reelSymbolsForColumn.length;
        }
        console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} - ReelHeights[${col}]=${this.reelHeights[col]}, topReelCovers=${topReelCovers.includes(col)}, calculated count=${reelSymbolCount}, array.length=${reelSymbolsForColumn.length}`);
      } else {
        // Fallback to array length if ReelHeights not available
        reelSymbolCount = reelSymbolsForColumn.length;
        console.warn(`[GridRenderer] renderGridFromMatrix: Reel ${col} - ReelHeights not available, using array.length: ${reelSymbolCount}`);
      }

      // ===== MEGAWAYS DYNAMIC SCALING =====
      // All columns have the SAME visual height, but symbols STRETCH to fill it
      // If reel has 2 symbols → each symbol is BIG (half the column)
      // If reel has 7 symbols → each symbol is SMALL (1/7th of the column)
      // CRITICAL: Use this.rows (fixed visible area, e.g. 5) NOT this.maxRows (variable)
      // The mask is built with this.rows, so symbols must fit within that space
      const maskStart = this.symbolSize; // Mask starts after 1 buffer row
      const totalColumnHeight = this.rows * this.symbolSize; // Visible column height (mask size)
      const dynamicSymbolHeight = reelSymbolCount > 0 ? totalColumnHeight / reelSymbolCount : this.symbolSize;
      
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} FINAL - reelSymbolCount=${reelSymbolCount}, dynamicHeight=${dynamicSymbolHeight.toFixed(1)}, totalColumnHeight=${totalColumnHeight}`);
      const bottomLimit = maskStart + totalColumnHeight;

      // ===== CRITICAL: Clean up ALL old sprites first =====
      // Destroy and remove ALL existing sprites in gridLayer to ensure clean state
      if (reel.gridLayer) {
        while (reel.gridLayer.children.length > 0) {
          const child = reel.gridLayer.children[0];
          reel.gridLayer.removeChild(child);
          if (child && !child.destroyed) {
            child.destroy();
          }
        }
      }
      
      // Reset gridSprites array to exact size needed
      reel.gridSprites = new Array(reelSymbolCount).fill(null);
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} - gridSprites array reset to length ${reelSymbolCount}`);

      // Render each symbol in this reel
      // Debug: Log all symbols for this reel
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} (height ${reelSymbolCount}):`, reelSymbolsForColumn);
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} - Backend array (row 0=bottom, row ${reelSymbolCount-1}=top):`, reelSymbolsForColumn.map((sym, idx) => `[${idx}]=${sym}`).join(', '));
      
      // Process symbols: backend row 0 is bottom, we need to display them bottom to top
      for (let row = 0; row < reelSymbolCount; row++) {
        const symbolCode = reelSymbolsForColumn[row];

        if (symbolCode == null || symbolCode === '' || symbolCode === 'NULL') {
          if (reel.gridSprites[row]) {
            reel.gridSprites[row].visible = false;
            reel.gridSprites[row] = null;
          }
          continue;
        }

        let sprite = reel.gridSprites[row];
        if (!sprite || sprite.destroyed) {
          sprite = new PIXI.Sprite();
          reel.gridSprites[row] = sprite;
          if (reel.gridLayer) {
            reel.gridLayer.addChild(sprite);
          } else {
            reel.container.addChild(sprite);
          }
        }

        const texture = assets.get(symbolCode) ?? assets.get('PLACEHOLDER');
        if (!texture) {
          console.warn(`[GridRenderer] renderGridFromMatrix: Missing texture for symbol ${symbolCode}`);
          continue;
        }

        sprite.texture = texture;

        // ===== MEGAWAYS DYNAMIC SCALING =====
        // Scale symbols to fill their allocated space in the column
        // Width: fill the reel width
        // Height: stretch to fit (dynamicSymbolHeight based on reel height)
        const scaleX = this.reelWidth / texture.width;
        const scaleY = dynamicSymbolHeight / texture.height;
        sprite.scale.set(scaleX, scaleY);
        sprite.x = Math.round((this.reelWidth - sprite.width) / 2);

        // Backend Row 0 = bottom, Pixi y=0 = top
        // Position symbols from bottom to top, filling the entire column
        // Row 0 is at the BOTTOM, Row (count-1) is at the TOP
        const visualRowIndex = (reelSymbolCount - 1) - row;
        sprite.y = maskStart + (visualRowIndex * dynamicSymbolHeight);
        
        // Verify sprite is within viewable bounds
        const spriteBottom = sprite.y + sprite.height;
        if (sprite.y < maskStart - 1 || spriteBottom > bottomLimit + 1) {
          console.warn(`[GridRenderer] renderGridFromMatrix: Reel ${col}, Row ${row} sprite OUTSIDE viewable bounds! y=${sprite.y.toFixed(1)}, bottom=${spriteBottom.toFixed(1)}, maskStart=${maskStart.toFixed(1)}, bottomLimit=${bottomLimit.toFixed(1)}, dynamicHeight=${dynamicSymbolHeight.toFixed(1)}`);
        }
        
        sprite.visible = true;
        sprite.alpha = 1;
      }
      
      // Hide unused sprites
      for (let r = reelSymbolCount; r < reel.gridSprites.length; r++) {
        if (reel.gridSprites[r]) {
          reel.gridSprites[r].visible = false;
        }
      }
      
      // Log final display order for verification
      // Create array of [row, symbolCode, yPosition] and sort by y position (top to bottom)
      const displayedSymbols = [];
      for (let r = 0; r < reelSymbolCount; r++) {
        const sprite = reel.gridSprites[r];
        if (sprite && sprite.visible && sprite.texture) {
          // Find which symbol code this texture corresponds to
          const textureUrl = sprite.texture.baseTexture?.resource?.url || '';
          const symbolCode = this.availableSymbols.find(alias => {
            const tex = assets.get(alias);
            return tex?.baseTexture?.resource?.url === textureUrl;
          }) || reelSymbolsForColumn[r] || 'UNKNOWN';
          displayedSymbols.push({
            row: r,
            symbol: symbolCode,
            y: sprite.y,
            expectedSymbol: reelSymbolsForColumn[r]
          });
        }
      }
      // Sort by y position (top to bottom - lower y = higher on screen)
      displayedSymbols.sort((a, b) => a.y - b.y);
      const topToBottom = displayedSymbols.map(s => s.symbol).join(', ');
      const bottomToTop = displayedSymbols.reverse().map(s => s.symbol).join(', ');
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} VISUAL DISPLAY (top to bottom):`, topToBottom);
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} VISUAL DISPLAY (bottom to top):`, bottomToTop);
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} EXPECTED (backend, bottom to top):`, reelSymbolsForColumn.join(', '));
      
      // Check if order matches
      const expectedTopToBottom = [...reelSymbolsForColumn].reverse().join(', ');
      if (topToBottom !== expectedTopToBottom) {
        console.error(`[GridRenderer] renderGridFromMatrix: Reel ${col} ORDER MISMATCH! Expected top-to-bottom: ${expectedTopToBottom}, Got: ${topToBottom}`);
      }
    }

    // Update top reel if present - use topReelSymbols from backend
    if (this.topReelContainer && this.topReelSpinLayer && this.topReelSymbols && this.topReelSymbols.length > 0) {
      const topReelCovers = [1, 2, 3, 4];
      
      // Ensure top reel is visible
      this.topReelContainer.visible = true;
      this.topReelSpinLayer.visible = true;
      
      // Update the 4 visible symbols in the top reel
      // topReelSymbols is a flat array of 4 symbols for reels 1-4
      for (let i = 0; i < topReelCovers.length && i < this.topReelSymbols.length; i++) {
        const col = topReelCovers[i];
        if (col >= this.columns) continue;
        
        const symbolCode = this.topReel[i]; // Use topReel array (set by setTopReel)
        if (!symbolCode) continue;
        
        const texture = assets.get(symbolCode);
        
        if (texture && i < this.topReelSymbols.length) {
          const symbol = this.topReelSymbols[i];
          if (symbol && !symbol.destroyed) {
            symbol.texture = texture;
            const scale = Math.min(
              this.symbolSize / texture.width,
              this.symbolSize / texture.height
            );
            symbol.scale.set(scale);
            // Position symbol correctly above the reel (centered in reel column)
            symbol.x = col * this.reelWidth + (this.reelWidth / 2) - (symbol.width / 2);
            symbol.y = Math.round((this.symbolSize - symbol.height) / 2);
            symbol.visible = true;
            symbol.alpha = 1;
          }
        }
      }
    }

    // ===== DEBUG: Summary of what was rendered =====
    console.log(`[GridRenderer] renderGridFromMatrix: ===== RENDER SUMMARY =====`);
    console.log(`[GridRenderer] renderGridFromMatrix: Using this.rows=${this.rows} for visible height`);
    for (let col = 0; col < this.columns; col++) {
      const reel = this.reels[col];
      const visibleCount = reel?.gridSprites?.filter(s => s && s.visible)?.length || 0;
      const totalCount = reel?.gridSprites?.length || 0;
      const gridLayerChildren = reel?.gridLayer?.children?.length || 0;
      const expectedHeight = this.reelHeights?.[col] || this.rows;
      console.log(`[GridRenderer] renderGridFromMatrix: Reel ${col} - ${visibleCount}/${totalCount} sprites visible (gridLayer has ${gridLayerChildren} children), expected from reelHeights: ${expectedHeight}`);
    }
    console.log(`[GridRenderer] renderGridFromMatrix: ===== END RENDER =====`);

    // Store reel symbols for reference (flattened for compatibility with existing code)
    const flattened = [];
    for (let col = 0; col < reelSymbols.length; col++) {
      const reel = reelSymbols[col];
      if (Array.isArray(reel)) {
        for (let row = 0; row < reel.length; row++) {
          flattened.push(reel[row] || null);
        }
      }
    }
    this.setLogicalMatrix(flattened);
    this.resultMatrix = reelSymbols; // Store jagged array
  }

  /**
   * Transitions from spin mode to grid mode
   * 
   * Smoothly switches from spinning reels to static grid showing final symbols.
   * Preloads textures during spin to prevent flicker.
   * 
   * Flow:
   * 1. Preload result textures
   * 2. Stop position updates
   * 3. Hide grid layer
   * 4. Create grid sprites with final symbols
   * 5. Update top reel
   * 6. Switch layers (hide spin, show grid)
   * 
   * @param {Array<string>} symbolMatrix - Flat array of symbol codes
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {Promise<void>} Resolves when transition completes
   */
  transitionSpinToGrid(reelSymbols, assets) {
    if (!reelSymbols || !Array.isArray(reelSymbols) || reelSymbols.length < this.columns) {
      console.warn('[GridRenderer] transitionSpinToGrid: Invalid reel symbols', { length: reelSymbols?.length, columns: this.columns });
      return Promise.resolve();
    }

    console.log('[GridRenderer] transitionSpinToGrid: Starting transition', {
      columns: reelSymbols.length,
      reelLengths: reelSymbols.map(r => r?.length || 0),
      isSpinning: this.isSpinning,
      isRunning: this.running
    });

    this.isSpinning = false;

    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        // CRITICAL: Hide spin layer FIRST before building grid to prevent visual swap
        // The spin layer already has the correct symbols, so we hide it immediately
        this.reels.forEach((reel) => {
          if (!reel) return;
          if (reel.spinLayer) {
            reel.spinLayer.visible = false;
          }
          if (Array.isArray(reel.symbols)) {
            reel.symbols.forEach((symbol) => {
              if (symbol) {
                symbol.visible = false;
              }
            });
          }
        });

        // Now build the grid layer (this happens off-screen since spin layer is hidden)
        this.renderGridFromMatrix(reelSymbols, assets);

        // Show grid layer
        this.enterGridMode();
        
        // Store jagged array structure for cascades
        this.resultMatrix = reelSymbols.map(reel => [...reel]);
        
        resolve();
      });
    });
  }

  setLogicalMatrix(matrix) {
    if (Array.isArray(matrix) && matrix.length === this.columns * this.rows) {
      this.lastSymbolMatrix = [...matrix];
    }
  }

  applyResultDuringSpin(symbolMatrix, assets) {
    if (!symbolMatrix || symbolMatrix.length !== this.columns * this.rows) {
      console.warn('applyResultDuringSpin: invalid symbol matrix');
      return;
    }

    this.preloadSpinResult(symbolMatrix, assets);
  }

  initializeReels(assets) {
    this.currentAssets = assets;
    if (this.reels.length === 0) {
      this.buildReels(assets);
      // Show the spin layer initially so reels are visible
      this.enterSpinMode();
    }
  }

  /**
   * Preloads spin result textures
   * 
   * Applies final textures to spinning reels before they stop. This prevents
   * texture flicker and ensures smooth visual transition.
   * 
   * Called during spin (before reels stop) to apply final symbols.
   * 
   * @param {Array<string>} symbolMatrix - Flat array of symbol codes
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @returns {void}
   */
  preloadSpinResult(reelSymbols, assets) {
    if (!reelSymbols || !Array.isArray(reelSymbols) || reelSymbols.length < this.columns) {
      console.warn('[GridRenderer] preloadSpinResult: Invalid reel symbols', { length: reelSymbols?.length, columns: this.columns });
      return;
    }

    this.currentAssets = assets;

    if (!this.reels || this.reels.length === 0) {
      this.buildReels(assets);
    }

    // Store jagged array structure so the ticker stops applying random textures
    // CRITICAL: Only update resultMatrix if it's not already set, or if this is a new spin
    // This prevents the second call (from continueRenderResults) from overwriting with wrong data
    const isNewSpin = !this.resultMatrix || !this.running;
    if (isNewSpin) {
    this.resultMatrix = reelSymbols.map(reel => [...reel]);
      console.log('[GridRenderer] preloadSpinResult: Stored result matrix for new spin');
    } else {
      console.log('[GridRenderer] preloadSpinResult: Skipping - resultMatrix already set and spin is running');
      return; // Don't overwrite resultMatrix during an active spin
    }
    
    // CRITICAL: First, update symbol scaling based on reelHeights if available
    // This ensures symbols are the correct size BEFORE applying textures
    if (this.reelHeights && this.reelHeights.length > 0) {
      this._updateReelScalingForHeights();
    }
    
    // CRITICAL: Don't apply textures here - wait until startSpin sets targetPosition
    // The problem: targetPosition is calculated with random 'extra' value, which will be different
    // between preloadSpinResult and startSpin, causing textures to be applied to wrong sprites
    // Solution: Just mark that we have the result matrix, and apply textures in startSpin after targetPosition is set
    for (let col = 0; col < this.columns && col < this.reels.length; col++) {
      const reel = this.reels[col];
      if (reel) {
        // Don't apply textures yet - wait for startSpin to set targetPosition
        // Just mark that we're ready to apply textures
        reel.finalTexturesApplied = false;
      }
    }
    
    console.log('[GridRenderer] preloadSpinResult: Result matrix stored, textures will be applied in startSpin after targetPosition is calculated');

    // Update top reel textures so the topper stops on the correct symbols
    this._applyResultToTopReelSpinLayer(reelSymbols, assets);
    
    console.log('[GridRenderer] preloadSpinResult: All textures and scaling applied immediately - reels will stop on correct symbols');
  }
  
  _applyResultToTopReelSpinLayer(reelSymbols, assets) {
    if (!this.topReelSpinLayer || !this.topReelSymbols || this.topReelSymbols.length === 0) {
      console.log('[GridRenderer] _applyResultToTopReelSpinLayer: Top reel not available');
      return;
    }
    
    if (!reelSymbols || !Array.isArray(reelSymbols)) {
      console.warn('[GridRenderer] _applyResultToTopReelSpinLayer: Invalid reel symbols');
      return;
    }
    
    // Top reel symbols come from this.topReel (set by setTopReel)
    // This is a separate array of 4 symbols for reels 1-4
    const topReelCovers = [1, 2, 3, 4];
    
    // CRITICAL FIX: Apply textures to symbols that will be visible when reel stops
    // The problem: topReelSymbols is a scrolling strip, so indices 0-3 may not be visible
    // Solution: For each strip symbol, calculate if it will be visible when stopped, and update it
    
    if (!this.topReel || !Array.isArray(this.topReel) || this.topReel.length < 4) {
      console.warn('[GridRenderer] _applyResultToTopReelSpinLayer: this.topReel not set', this.topReel);
      return;
    }
    
    const symbolCount = this.topReelSymbols.length; // Total symbols in strip (10)
    const rightmostX = topReelCovers[topReelCovers.length - 1] * this.reelWidth + this.reelWidth;
    const maskStartX = topReelCovers[0] * this.reelWidth;
    const visibleSymbolCount = 4; // Number of visible symbols (columns 1-4)
    
    // Use target position to calculate which symbols will be visible (same formula as ticker)
    const targetPositionInSymbolUnits = this.topReelTargetPosition / this.reelWidth;
    
    // Track which columns we've updated (to avoid duplicates)
    const columnsUpdated = new Set();
    const appliedTopReelSymbols = new Array(visibleSymbolCount).fill(null);
    
    // Iterate through ALL strip symbols and update those that will be visible
    for (let i = 0; i < symbolCount; i++) {
      const symbol = this.topReelSymbols[i];
      if (!symbol || symbol.destroyed) continue;
      
      // EXACT same formula as ticker (line 554-555)
      const wrappedIndex = ((targetPositionInSymbolUnits + i) % symbolCount + symbolCount) % symbolCount;
      const symbolXWhenStopped = rightmostX - (wrappedIndex * this.reelWidth);
      
      // Check if this symbol will be visible (within mask: columns 1-4)
      // Use center of symbol for more accurate column matching
      const symbolCenterX = symbolXWhenStopped; // Symbol X is already at center (anchor 0.5)
      if (symbolCenterX >= maskStartX && symbolCenterX < rightmostX) {
        // Calculate which column this symbol will be in (0-3 for columns 1-4)
        // Column 1 (leftmost) should show this.topReel[0], Column 4 (rightmost) should show this.topReel[3]
        // Use center of each column for matching
        const columnIndex = Math.round((symbolCenterX - maskStartX) / this.reelWidth);
        const clampedColumnIndex = Math.max(0, Math.min(3, columnIndex));
        
        // Only update if we haven't already updated this column (first match wins)
        if (!columnsUpdated.has(clampedColumnIndex)) {
          const symbolCode = this.topReel[clampedColumnIndex];
          
          if (symbolCode) {
            const texture = assets.get(symbolCode);
            if (texture) {
              const oldTexture = symbol.texture?.baseTexture?.resource?.url || 'unknown';
              symbol.texture = texture;
              const scale = Math.min(
                this.symbolSize / texture.width,
                this.symbolSize / texture.height
              );
              symbol.scale.set(scale);
              columnsUpdated.add(clampedColumnIndex);
              appliedTopReelSymbols[clampedColumnIndex] = symbolCode;
              
              if (oldTexture !== texture.baseTexture?.resource?.url) {
                console.log(`[GridRenderer] _applyResultToTopReelSpinLayer: Strip symbol ${i} → Column ${clampedColumnIndex + 1}: ${symbolCode} (X=${symbolXWhenStopped.toFixed(1)})`);
              }
            } else {
              console.warn(`[GridRenderer] _applyResultToTopReelSpinLayer: Missing texture for ${symbolCode}`);
            }
          }
        }
      }
    }
    
    // Check if all columns were updated
    const missingColumns = [];
    for (let col = 0; col < visibleSymbolCount; col++) {
      if (!columnsUpdated.has(col)) {
        missingColumns.push(col + 1);
      }
    }
    if (missingColumns.length > 0) {
      console.warn(`[GridRenderer] _applyResultToTopReelSpinLayer: Failed to update columns: ${missingColumns.join(', ')}. Target position: ${this.topReelTargetPosition}, Position in units: ${targetPositionInSymbolUnits.toFixed(2)}`);
    }
    
    console.log('[GridRenderer] _applyResultToTopReelSpinLayer: Top reel symbols applied.');
    console.log('  Expected:', this.topReel);
    console.log('  Applied:', appliedTopReelSymbols);
    console.log('  Columns updated:', Array.from(columnsUpdated).map(c => c + 1).join(', '));
    console.log('  Target position:', this.topReelTargetPosition, 'Position in units:', targetPositionInSymbolUnits.toFixed(2));
  }

  _applyResultToReelSpinLayer(reel) {
    if (!reel || !Array.isArray(reel.symbols) || reel.symbols.length === 0) {
      return;
    }

    // resultMatrix is now a jagged array: resultMatrix[column][row]
    if (!this.resultMatrix || !Array.isArray(this.resultMatrix) || this.resultMatrix.length < this.columns) {
      console.warn('[GridRenderer] _applyResultToReelSpinLayer: No resultMatrix available');
      return;
    }

    const assets = this.currentAssets;
    if (!assets) {
      console.warn('[GridRenderer] _applyResultToReelSpinLayer: No assets available');
      return;
    }

    const symbolCount = reel.symbols.length;
    const col = reel.index; // Column index from reel object

    // CRITICAL: Validate column index and resultMatrix structure
    if (!Number.isFinite(col) || col < 0 || col >= this.columns) {
      console.error(`[GridRenderer] _applyResultToReelSpinLayer: Invalid column index ${col} for reel`, reel);
      return;
    }
    
    if (!this.resultMatrix || !Array.isArray(this.resultMatrix) || col >= this.resultMatrix.length) {
      console.error(`[GridRenderer] _applyResultToReelSpinLayer: Invalid resultMatrix for column ${col}`, {
        hasResultMatrix: !!this.resultMatrix,
        isArray: Array.isArray(this.resultMatrix),
        length: this.resultMatrix?.length,
        columns: this.columns
      });
      return;
    }

    // Get reel symbols for this column (jagged array structure)
    const reelSymbolsForColumn = this.resultMatrix[col];
    if (!Array.isArray(reelSymbolsForColumn)) {
      console.error(`[GridRenderer] _applyResultToReelSpinLayer: Reel ${col} is not an array`, {
        type: typeof reelSymbolsForColumn,
        value: reelSymbolsForColumn,
        resultMatrix: this.resultMatrix
      });
      return;
    }
    
    console.log(`[GridRenderer] _applyResultToReelSpinLayer: Applying textures to reel ${col}, symbols:`, reelSymbolsForColumn);

    const reelHeight = reelSymbolsForColumn.length;

    // For rotation-based system, find visible symbols by Y position
    // Calculate visible area
    const visibleRows = this.reelHeights && this.reelHeights[col] 
      ? this.reelHeights[col] 
      : this.rows;
    const maskStart = this.symbolSize;
    const dynamicHeight = this._getDynamicSymbolHeight(col);
    const visibleStart = maskStart;
    const visibleEnd = visibleStart + (dynamicHeight * visibleRows);

    const appliedSymbols = []; // Track what we're applying for logging

    // Apply textures for each row in this reel
    // reelSymbolsForColumn[row] is the symbol code for that row (row 0 = bottom, row N-1 = top)
    for (let row = 0; row < reelHeight; row += 1) {
      const symbolCode = reelSymbolsForColumn[row];

      if (symbolCode == null || symbolCode === '') {
        appliedSymbols.push(null);
        continue;
      }

      const texture = assets.get(symbolCode) ?? assets.get('PLACEHOLDER');

      if (!texture) {
        console.warn(`[GridRenderer] _applyResultToReelSpinLayer: Texture not found for symbol ${symbolCode} in reel ${col}, row ${row}`);
        appliedSymbols.push('MISSING');
        continue;
      }
      
      // Log if we're using a fallback texture (PLACEHOLDER) instead of the requested symbol
      if (symbolCode !== 'PLACEHOLDER' && !assets.get(symbolCode)) {
        console.warn(`[GridRenderer] _applyResultToReelSpinLayer: Symbol ${symbolCode} not found in assets, using PLACEHOLDER fallback for reel ${col}, row ${row}`);
      }

      // Find sprite at this row position (rotation-based)
      // Calculate expected Y position for this row
      const expectedY = visibleStart + (row * dynamicHeight);
      
      // Find closest sprite to this Y position
      let closestSprite = null;
      let closestDistance = Infinity;
      let closestIndex = -1;
      
      for (let i = 0; i < reel.symbols.length; i++) {
        const sprite = reel.symbols[i];
        if (!sprite || sprite.destroyed) continue;
        
        const distance = Math.abs(sprite.y - expectedY);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestSprite = sprite;
          closestIndex = i;
        }
      }

      if (!closestSprite || closestIndex < 0) {
        console.warn(`[GridRenderer] _applyResultToReelSpinLayer: No sprite found for reel ${col}, row ${row} at Y=${expectedY.toFixed(1)}`);
        appliedSymbols.push('NO_SPRITE');
        continue;
      }

      const scale = Math.min(
        this.symbolSize / texture.width,
        this.symbolSize / texture.height
      );

      // CRITICAL: Only update texture and scale, don't change visibility or position
      // This ensures the animation continues smoothly without any visual disruption
      // The sprite is already visible and positioned correctly from rotation
      const oldTexture = closestSprite.texture?.baseTexture?.resource?.url || 'unknown';
      closestSprite.texture = texture;
      closestSprite.scale.set(scale);
      closestSprite.x = Math.round((this.reelWidth - closestSprite.width) / 2);
      
      // Update symbol data
      if (closestSprite.iconID !== undefined) {
        const symbolIndex = this.availableSymbols.indexOf(symbolCode);
        closestSprite.iconID = symbolIndex >= 0 ? symbolIndex : 0;
      }
      
      // CRITICAL: Ensure sprite remains visible and at full opacity
      // This prevents any visual glitches during texture swap
      closestSprite.visible = true;
      closestSprite.alpha = 1;
      
      appliedSymbols.push(symbolCode);
      
      // Log if texture changed (only first few to reduce console noise)
      const newTexture = closestSprite.texture?.baseTexture?.resource?.url || 'unknown';
      if (oldTexture !== newTexture && oldTexture !== 'unknown' && appliedSymbols.length <= 3) {
        console.log(`[GridRenderer] _applyResultToReelSpinLayer: Reel ${col}, Row ${row}, Sprite ${closestIndex}: Applied texture ${symbolCode}`);
      }
    }
    
    console.log(`[GridRenderer] _applyResultToReelSpinLayer: Reel ${col} (height ${reelHeight}) applied symbols:`, appliedSymbols);
  }

  getSize() {
    // Return size including top reel height if present
    return { 
      width: this.size.width, 
      height: this.totalHeight || this.size.height 
    };
  }

  destroy() {
    // Clean up ticker
    if (this.tickerCallback) {
      this.app.ticker.remove(this.tickerCallback);
      this.tickerCallback = null;
    }
    
    // Clean up reels
    this.reels.forEach(reel => {
      if (reel.mask && !reel.mask.destroyed) {
        reel.mask.destroy();
      }
      if (reel.container && !reel.container.destroyed) {
        reel.container.destroy({ children: true });
      }
    });
    this.reels = [];
    this.tweening = [];
  }

  setVisible(isVisible) {
    this.container.visible = !!isVisible;
  }

  fadeOut(duration = 150) {
    this.container.visible = true;
    return this._fadeTo(0, duration);
  }

  fadeIn(duration = 150) {
    this.container.visible = true;
    return this._fadeTo(1, duration);
  }

  _fadeTo(targetAlpha, duration) {
    if (this.container.alpha === targetAlpha) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.tweenTo(
        this.container,
        'alpha',
        targetAlpha,
        duration,
        (t) => t,
        null,
        resolve
      );
    });
  }

  /**
   * Checks if spin is currently running
   * 
   * @returns {boolean} True if spin is running, false otherwise
   */
  isRunning() {
    return this.running;
  }

  /**
   * Plays a single cascade step animation
   * 
   * Animates the cascade process:
   * 1. Fades out winning symbols
   * 2. Drops remaining symbols down to fill gaps
   * 3. Spawns new symbols from top
   * 
   * Handles variable reel heights for Megaways support.
   * 
   * @param {Array<string>} nextMatrix - Next grid state after cascade
   * @param {PIXI.Assets} assets - PixiJS Assets API
   * @param {Object} [options] - Animation options
   * @param {number} [options.fadeDuration] - Fade duration in seconds
   * @param {number} [options.dropDuration] - Drop duration in seconds
   * @returns {Promise<void>} Resolves when cascade step completes
   */
  playCascadeStep(
    nextReelSymbols,
    assets,
    { fadeDuration = CASCADE_FADE_DURATION, dropDuration = CASCADE_DROP_DURATION, topReelSymbolsAfter = null } = {}
  ) {
    // nextReelSymbols is now a jagged array: nextReelSymbols[column][row]
    if (!nextReelSymbols || !Array.isArray(nextReelSymbols) || nextReelSymbols.length < this.columns) {
      console.warn('[GridRenderer] playCascadeStep: Invalid next reel symbols');
      return Promise.resolve();
    }

    // Check if we have previous state
    if (!this.resultMatrix || !Array.isArray(this.resultMatrix) || this.resultMatrix.length < this.columns) {
      this.renderGridFromMatrix(nextReelSymbols, assets);
      return Promise.resolve();
    }

    this.enterGridMode();
    this.currentAssets = assets;

    const prevReelSymbols = this.resultMatrix; // Already jagged array
    const removedPositions = new Set(); // Store as "col,row" strings
    
    // Track top reel cols to remove (row === -1) separately for fade + refill
    const topReelRemovedCols = new Set();

    // CRITICAL: Use pendingWinningPositions if available (from highlightWins)
    // This tells us exactly which symbols are winning and should be removed
    if (this.pendingWinningPositions && Array.isArray(this.pendingWinningPositions) && this.pendingWinningPositions.length > 0) {
      // Use the winning positions directly (already in col,row format)
      this.pendingWinningPositions.forEach((pos) => {
        if (pos && Number.isFinite(pos.col) && Number.isFinite(pos.row)) {
          const col = pos.col;
          const row = pos.row;
          if (row === -1) {
            topReelRemovedCols.add(col);
            return;
          }
          // Verify this position exists in the jagged array
          if (col >= 0 && col < prevReelSymbols.length) {
            const reel = prevReelSymbols[col];
            if (Array.isArray(reel) && row >= 0 && row < reel.length) {
              removedPositions.add(`${col},${row}`);
            }
          }
        }
      });
      console.log(`[GridRenderer] playCascadeStep: Using pendingWinningPositions - ${this.pendingWinningPositions.length} positions, topReel cols:`, Array.from(topReelRemovedCols));
    } else if (this.pendingWinningIndices && Array.isArray(this.pendingWinningIndices) && this.pendingWinningIndices.length > 0) {
      // Fallback: Convert flat indices to jagged array positions
      this.pendingWinningIndices.forEach((flatIdx) => {
        if (!Number.isFinite(flatIdx)) return;
        // Try standard conversion: row = floor(idx / columns), col = idx % columns
        let row = Math.floor(flatIdx / this.columns);
        let col = flatIdx % this.columns;
        // Verify this position exists in the jagged array
        if (col >= 0 && col < prevReelSymbols.length) {
          const reel = prevReelSymbols[col];
          if (Array.isArray(reel) && row >= 0 && row < reel.length) {
            removedPositions.add(`${col},${row}`);
          }
        }
      });
      console.log(`[GridRenderer] playCascadeStep: Using pendingWinningIndices - ${this.pendingWinningIndices.length} indices`);
    }
    
    // Fallback: Find removed symbols by comparing prev and next (if no pending positions)
    if (removedPositions.size === 0) {
      for (let col = 0; col < this.columns && col < prevReelSymbols.length && col < nextReelSymbols.length; col++) {
        const prevReel = prevReelSymbols[col];
        const nextReel = nextReelSymbols[col];
        if (!Array.isArray(prevReel) || !Array.isArray(nextReel)) continue;
        
        const maxRows = Math.max(prevReel.length, nextReel.length);
        for (let row = 0; row < maxRows; row++) {
          const prevSymbol = row < prevReel.length ? prevReel[row] : null;
          const nextSymbol = row < nextReel.length ? nextReel[row] : null;
          
          // If symbol was removed (was present, now null or different)
          if (prevSymbol && prevSymbol !== nextSymbol) {
            removedPositions.add(`${col},${row}`);
          }
        }
      }
    }
    
    console.log(`[GridRenderer] playCascadeStep: Found ${removedPositions.size} symbols to remove:`, Array.from(removedPositions));

    const fadePromises = [];

    // Fade top reel winning slots (row === -1)
    const topReelCoversList = [1, 2, 3, 4];
    topReelRemovedCols.forEach((col) => {
      const sprite = this.getSpriteAt(-1, col);
      if (!sprite || sprite.destroyed) return;
      fadePromises.push(
        new Promise((resolve) => {
          const originalScale = sprite.scale.x;
          gsap.to(sprite.scale, {
            x: originalScale * 1.15,
            y: originalScale * 1.15,
            duration: 0.1,
            ease: 'power2.out',
            onComplete: () => {
              gsap.to(sprite, {
                alpha: 0,
                duration: (typeof fadeDuration === 'number' ? fadeDuration : 0.5) * 0.4,
                ease: 'power2.in',
                onComplete: () => {
                  sprite.visible = false;
                  sprite.alpha = 0;
                  sprite.scale.set(originalScale, originalScale);
                  resolve();
                }
              });
            }
          });
        })
      );
    });

    removedPositions.forEach((pos) => {
      const [colStr, rowStr] = pos.split(',');
      const col = parseInt(colStr, 10);
      const row = parseInt(rowStr, 10);
      
      if (!Number.isFinite(col) || !Number.isFinite(row)) return;
      
      const sprite = this._getGridSpriteAt(row, col);
      if (!sprite) {
        return;
      }

      const reel = this.reels[col];
      if (reel && reel.gridSprites) {
        reel.gridSprites[row] = null;
      }

      fadePromises.push(
        new Promise((resolve) => {
          // Scale up (pop) before fade-out for "Pragmatic Play" feel
          const originalScale = sprite.scale.x;
          gsap.to(sprite.scale, {
            x: originalScale * 1.15,
            y: originalScale * 1.15,
            duration: 0.1,
            ease: 'power2.out',
            onComplete: () => {
              // Rapid fade-out (0.2s instead of slow fade)
              gsap.to(sprite, {
                alpha: 0,
                duration: 0.2,
                ease: 'power2.in',
                onComplete: () => {
                  sprite.visible = false;
                  sprite.alpha = 0;
                  sprite.scale.x = originalScale;
                  sprite.scale.y = originalScale;
                  resolve();
                }
              });
            }
          });
        })
      );
    });

    return Promise.all(fadePromises)
      .catch((err) => {
        console.error('Cascade fade error', err);
      })
      .then(() => {
        const dropPromises = [];

        for (let col = 0; col < this.columns && col < prevReelSymbols.length && col < nextReelSymbols.length; col++) {
          const reel = this.reels[col];
          if (!reel) {
            continue;
          }
          
          const prevReel = prevReelSymbols[col];
          const nextReel = nextReelSymbols[col];
          if (!Array.isArray(prevReel) || !Array.isArray(nextReel)) {
            continue;
          }
          
          // Get actual reel height for this column (variable for Megaways)
          // Use ReelHeights if available, otherwise use array length
          const topReelCovers = [1, 2, 3, 4];
          let reelHeight;
          if (this.reelHeights && Array.isArray(this.reelHeights) && this.reelHeights.length > col && typeof this.reelHeights[col] === 'number' && this.reelHeights[col] > 0) {
            reelHeight = this.reelHeights[col];
            if (topReelCovers.includes(col)) {
              reelHeight = reelHeight - 1; // Exclude top reel symbol
            }
            reelHeight = Math.min(reelHeight, Math.max(prevReel.length, nextReel.length));
          } else {
            reelHeight = Math.max(prevReel.length, nextReel.length);
          }
          
          // ===== MEGAWAYS DYNAMIC SCALING FOR CASCADES =====
          // CRITICAL: Use this.rows (fixed visible area) NOT this.maxRows
          const maskStart = this.symbolSize;
          const totalColumnHeight = this.rows * this.symbolSize; // Visible column height (mask size)
          const dynamicSymbolHeight = reelHeight > 0 ? totalColumnHeight / reelHeight : this.symbolSize;
          const getDynamicY = (row) => {
            const visualRowIndex = (reelHeight - 1) - row;
            return maskStart + (visualRowIndex * dynamicSymbolHeight);
          };
          
          if (!reel.gridSprites) {
            reel.gridSprites = new Array(reelHeight).fill(null);
          } else if (reel.gridSprites.length < reelHeight) {
            reel.gridSprites = [...reel.gridSprites, ...new Array(reelHeight - reel.gridSprites.length).fill(null)];
          }

          const prevCol = [];
          const nextCol = [];

          // Build column data from jagged arrays
          for (let row = 0; row < reelHeight; row++) {
            const prevSymbol = row < prevReel.length ? prevReel[row] : null;
            const nextSymbol = row < nextReel.length ? nextReel[row] : null;
            const posKey = `${col},${row}`;
            
            prevCol.push({
              row,
              symbolCode: prevSymbol,
              sprite: reel.gridSprites[row],
              isRemoved: removedPositions.has(posKey)
            });
            nextCol.push({
              row,
              symbolCode: nextSymbol
            });
          }

          // CRITICAL: Gravity DOWN - Collect survivors from BOTTOM to TOP (row 0 to reelHeight-1)
          // When symbol at index 0 (bottom) is removed, symbol at index 1 should drop DOWN to index 0
          const survivors = [];
          for (let row = 0; row < reelHeight; row++) {
            const cell = prevCol[row];
            if (!cell || !cell.sprite || cell.isRemoved) {
              continue;
            }
            survivors.push(cell); // Add in order from bottom (row 0) to top (row N-1)
          }

          // Get target rows that need symbols (from bottom to top)
          const targetRows = nextCol.filter((c) => c.symbolCode != null).map((c) => c.row);
          const survivorTargets = [];

          // CRITICAL: Assign survivors to BOTTOM-MOST target rows first (gravity down)
          // This ensures symbols drop DOWN from higher positions to fill lower positions
          for (let i = 0; i < survivors.length && i < targetRows.length; i++) {
            const targetRow = targetRows[i]; // Start from bottom (row 0)
            survivorTargets.push({ cell: survivors[i], targetRow });
          }

          const occupiedRows = new Set();

          survivorTargets.forEach(({ cell, targetRow }) => {
            const sprite = cell.sprite;
            if (!sprite) {
              return;
            }

            const targetY = getDynamicY(targetRow);
            occupiedRows.add(targetRow);
            reel.gridSprites[targetRow] = sprite;
            if (cell.row !== targetRow) {
              reel.gridSprites[cell.row] = null;
            }

            // CRITICAL: Stagger drops by target row for realistic physics
            // Lower rows (higher Y, bottom of screen) should drop first
            // This creates the downward cascade effect
            const staggerDelay = targetRow * 0.05; // 50ms delay per row (bottom rows drop first)
            
            dropPromises.push(
              new Promise((resolve) => {
                // Use GSAP directly for bounce.out easing and stagger
                gsap.to(sprite, {
                  y: targetY,
                  duration: dropDuration,
                  delay: staggerDelay,
                  ease: 'bounce.out', // Bounce on landing for realistic physics
                  onComplete: () => {
                    // Small bounce effect on landing (scale animation)
                    gsap.to(sprite.scale, {
                      x: sprite.scale.x * 1.05,
                      y: sprite.scale.y * 1.05,
                      duration: 0.1,
                      yoyo: true,
                      repeat: 1,
                      ease: 'power2.out',
                      onComplete: resolve
                    });
                  }
                });
              })
            );
          });

          const rowsNeedingNew = targetRows.filter((row) => !occupiedRows.has(row) && row < reelHeight);

          rowsNeedingNew.forEach((row) => {
            // Get symbol from jagged array
            if (row >= nextReel.length) {
              return; // Skip if out of bounds
            }
            
            const symbolCode = nextReel[row];
            if (!symbolCode || symbolCode === 'NULL' || symbolCode === '') {
              return;
            }

            // Ensure gridSprites array is large enough
            if (!reel.gridSprites) {
              reel.gridSprites = new Array(reelHeight).fill(null);
            }
            while (reel.gridSprites.length <= row) {
              reel.gridSprites.push(null);
            }

            let sprite = reel.gridSprites[row];
            if (!sprite || sprite.destroyed) {
              sprite = new PIXI.Sprite();
              reel.gridSprites[row] = sprite;
              if (reel.gridLayer) {
                reel.gridLayer.addChild(sprite);
              } else {
                reel.container.addChild(sprite);
              }
            }

            const texture = assets.get(symbolCode) ?? assets.get('PLACEHOLDER');
            if (!texture) {
              return;
            }

            // ===== MEGAWAYS DYNAMIC SCALING FOR NEW SYMBOLS =====
            const scaleX = this.reelWidth / texture.width;
            const scaleY = dynamicSymbolHeight / texture.height;
            sprite.texture = texture;
            sprite.scale.set(scaleX, scaleY);
            sprite.x = Math.round((this.reelWidth - sprite.width) / 2);
            const targetY = getDynamicY(row);
            // CRITICAL: Start new symbols from ABOVE (negative offset) so they drop DOWNWARD
            // Row 0 (bottom) should start higher up, row N-1 (top) should start even higher
            // This creates the downward drop effect
            sprite.y = targetY - dynamicSymbolHeight * 1.1;
            sprite.alpha = 1;
            sprite.visible = true;

            // CRITICAL: Stagger drops by row for realistic physics
            // Lower rows (higher Y, bottom of screen) should drop first
            // This creates the downward cascade effect
            const staggerDelay = row * 0.05; // 50ms delay per row (bottom rows drop first)
            
            dropPromises.push(
              new Promise((resolve) => {
                // Use GSAP directly for bounce.out easing and stagger
                gsap.to(sprite, {
                  y: targetY,
                  duration: dropDuration,
                  delay: staggerDelay,
                  ease: 'bounce.out', // Bounce on landing for realistic physics
                  onComplete: () => {
                    // Small bounce effect on landing (scale animation)
                    gsap.to(sprite.scale, {
                      x: sprite.scale.x * 1.05,
                      y: sprite.scale.y * 1.05,
                      duration: 0.1,
                      yoyo: true,
                      repeat: 1,
                      ease: 'power2.out',
                      onComplete: resolve
                    });
                  }
                });
              })
            );
          });

          // Clean up sprites that are no longer needed
          for (let row = 0; row < reelHeight; row++) {
            if ((row >= nextReel.length || !nextReel[row] || nextReel[row] === 'NULL') && reel.gridSprites[row]) {
              reel.gridSprites[row].visible = false;
              reel.gridSprites[row] = null;
            }
          }
        }

        return Promise.all(dropPromises).then(() => {
            // Store jagged array structure
            this.resultMatrix = nextReelSymbols.map(reel => [...reel]);
          // Also store flattened for compatibility (temporary)
          const flattened = [];
          for (let col = 0; col < nextReelSymbols.length; col++) {
            const reel = nextReelSymbols[col];
            if (Array.isArray(reel)) {
              for (let row = 0; row < reel.length; row++) {
                flattened.push(reel[row] || null);
              }
            }
          }
          this.lastSymbolMatrix = flattened;

          // Apply new top reel symbols after cascade (winning top reel slots were faded and refilled)
          if (Array.isArray(topReelSymbolsAfter) && topReelSymbolsAfter.length >= 4 && this.topReelSymbols && this.topReelSymbols.length >= 4 && assets) {
            this.setTopReel(topReelSymbolsAfter);
            const topReelCoversApply = [1, 2, 3, 4];
            for (let i = 0; i < topReelCoversApply.length && i < this.topReelSymbols.length; i++) {
              const symbolCode = topReelSymbolsAfter[i];
              const texture = assets.get(symbolCode) ?? assets.get('PLACEHOLDER');
              const symbol = this.topReelSymbols[i];
              if (texture && symbol && !symbol.destroyed) {
                symbol.texture = texture;
                const scale = Math.min(this.symbolSize / texture.width, this.symbolSize / texture.height);
                symbol.scale.set(scale);
                symbol.visible = true;
                symbol.alpha = 1;
              }
            }
          }

          this.pendingWinningIndices = null;
          this.pendingWinningPositions = null;
        });
      });
  }

  _rowToY(row, col = -1) {
    // Offset by symbolSize to account for mask starting at y=symbolSize
    // This hides the top buffer row and aligns visible rows correctly
    // For reels with top reel (cols 1-4), add extra offset
    const hasTopReel = col >= 0 && this.topReel && [1, 2, 3, 4].includes(col);
    const topReelOffset = hasTopReel ? this.symbolSize : 0;
    
    // Use fixed spacing to match spinning symbols
    // The mask already clips to the correct height for each reel
    // This ensures grid sprites align with spinning symbols
    return (row + 1) * this.symbolSize + topReelOffset;
  }

  _applyTableScale() {
    if (!this.tableSprite || !this.tableSprite.texture || !this.tableSprite.texture.width || !this.tableSprite.texture.height) {
      return;
    }

    const textureWidth = this.tableSprite.texture.width;
    const textureHeight = this.tableSprite.texture.height;
    const baseScaleX = this.size.width / textureWidth;
    const baseScaleY = this.size.height / textureHeight;
    
    // ===== TABLE SCALE ADJUSTMENT =====
    // Increase this value to make the table bigger (e.g., 1.5 = 50% bigger, 2.0 = 100% bigger)
    const TABLE_SCALE_MULTIPLIER = 1.0;
    
    // ===== TABLE POSITION ADJUSTMENT =====
    // Y position offset - positive values move down, negative values move up
    const TABLE_Y_OFFSET = 0;
    
    const uniformScale = Math.max(baseScaleX, baseScaleY) * (1 + (Number.isFinite(this.tablePadding) ? this.tablePadding : 0)) * TABLE_SCALE_MULTIPLIER;

    this.tableSprite.scale.set(uniformScale);
    this.tableSprite.x = this.size.width / 2.0;  // Horizontal center
    this.tableSprite.y = (this.size.height / 1.35) + TABLE_Y_OFFSET; // Vertical position with offset
  }

  _notifySpinComplete() {
    if (typeof this.onSpinComplete === 'function') {
      const cb = this.onSpinComplete;
      this.onSpinComplete = null;
      // Handle both sync and async callbacks
      const result = cb();
      if (result && typeof result.then === 'function') {
        // Async callback - errors are handled by the caller
        result.catch((err) => {
          console.error('Spin complete callback error:', err);
        });
      }
    }
  }

  _getVisibleSprite(column, row) {
    const reel = this.reels[column];
    if (!reel || !reel.symbols.length) {
      return null;
    }

    const index = this._getVisibleSpriteIndex(reel, row);
    if (index < 0 || index >= reel.symbols.length) {
      return null;
    }
    return reel.symbols[index];
  }

  _getVisibleSpriteIndex(reel, row) {
    const symbolCount = reel.symbols.length;
    if (symbolCount === 0) {
      return -1;
    }
    const startIndex = symbolCount - this.rows;
    return (startIndex + row) % symbolCount;
  }

  /**
   * Gets the dynamic symbol height for a given column based on reelHeights
   * 
   * @param {number} colIndex - Column index (0-based)
   * @returns {number} Dynamic height in pixels
   */
  _getDynamicSymbolHeight(colIndex) {
    if (!this.reelHeights || !Array.isArray(this.reelHeights) || colIndex >= this.reelHeights.length) {
      return this.symbolSize; // Default to fixed size if reelHeights not available
    }
    
    const topReelCovers = [1, 2, 3, 4];
    const totalColumnHeight = this.rows * this.symbolSize;
    
    // Calculate symbol count for this reel (excluding top reel if covered)
    let reelSymbolCount = this.reelHeights[colIndex] || this.rows;
    if (topReelCovers.includes(colIndex)) {
      reelSymbolCount = reelSymbolCount - 1; // Exclude top reel
    }
    
    // Calculate dynamic height: total height divided by symbol count
    return reelSymbolCount > 0 ? totalColumnHeight / reelSymbolCount : this.symbolSize;
  }

  _getSpriteIndexForRowAtPosition(reel, row, position) {
    const symbolCount = reel.symbols.length;
    if (symbolCount === 0) {
      return -1;
    }
    // Normalize position to [0, symbolCount) range
    const normalized = ((Math.round(position) % symbolCount) + symbolCount) % symbolCount;
    
    // CRITICAL: The ticker positions symbols as:
    //   symbolIndex = (reel.position + j) % symbolCount
    //   y = maskStart + symbolIndex * dynamicHeight
    // where maskStart = symbolSize
    // 
    // For row 0 (bottom visible), we want symbolIndex = 0, so y = maskStart
    // For row 1, we want symbolIndex = 1, so y = maskStart + dynamicHeight
    // etc.
    //
    // So we need: (position + j) % symbolCount = row
    // Solving: j = (row - position) mod symbolCount
    return (row - normalized + symbolCount) % symbolCount;
  }

  getSpriteAt(row, col) {
    if (typeof row !== 'number' || typeof col !== 'number' || col < 0 || col >= this.columns) {
      return null;
    }

    // Top reel: row === -1 means top reel slot at this column (cols 1–4)
    const topReelCovers = [1, 2, 3, 4];
    if (row === -1 && topReelCovers.includes(col) && this.topReelSymbols && this.topReelSymbols.length >= 4) {
      const idx = topReelCovers.indexOf(col);
      const sprite = this.topReelSymbols[idx];
      return sprite && !sprite.destroyed ? sprite : null;
    }

    if (row < 0) {
      return null;
    }
    
    // For Megaways, check against actual reel height for this column
    let maxRowForCol = this.maxRows;
    if (this.reelHeights && this.reelHeights[col]) {
      maxRowForCol = this.reelHeights[col];
      if (topReelCovers.includes(col)) {
        maxRowForCol = maxRowForCol - 1; // Exclude top reel
      }
    }
    if (row >= maxRowForCol) {
      return null;
    }

    const reel = this.reels[col];
    if (!reel) {
      return null;
    }

    if (!this.isSpinning || this.isCascading || (reel.gridLayer && reel.gridLayer.visible)) {
      const gridSprite = this._getGridSpriteAt(row, col);
      if (gridSprite) {
        return gridSprite;
      }
    }

    if (!reel.symbols.length) {
      return null;
    }

    const symbolIndex = this._getVisibleSpriteIndex(reel, row);
    if (symbolIndex < 0 || symbolIndex >= reel.symbols.length) {
      return null;
    }

    const sprite = reel.symbols[symbolIndex];
    if (!sprite || sprite.destroyed) {
      return null;
    }

    return sprite;
  }

  _getGridSpriteAt(row, col) {
    const reel = this.reels[col];
    if (!reel || !reel.gridSprites) {
      return null;
    }
    const sprite = reel.gridSprites[row];
    if (!sprite || sprite.destroyed) {
      return null;
    }
    return sprite;
  }

  getChangedCells(nextMatrix) {
    if (
      !this.lastSymbolMatrix ||
      !nextMatrix ||
      nextMatrix.length !== this.lastSymbolMatrix.length
    ) {
      return [];
    }

    const cells = [];
    for (let idx = 0; idx < nextMatrix.length; idx += 1) {
      if (this.lastSymbolMatrix[idx] === nextMatrix[idx]) {
        continue;
      }
      const row = Math.floor(idx / this.columns);
      const col = idx % this.columns;
      cells.push({ row, col });
    }
    return cells;
  }

  /**
   * Highlights winning cells with scale animation
   * 
   * Scales up winning symbols, then scales back down with bounce effect.
   * Uses GSAP timeline for smooth animation.
   * 
   * @param {Array<Object>} cells - Array of {row, col} positions
   * @param {Object} [options] - Animation options
   * @param {number} [options.scaleAmount] - Scale multiplier (default: 1.18 = 18% larger)
   * @param {number} [options.duration] - Animation duration in seconds (default: 0.22)
   * @returns {Promise<void>} Resolves when highlight animation completes
   */
  highlightWinningCells(cells, { scaleAmount = 1.18, duration = 0.22 } = {}) {
    if (!cells || cells.length === 0) {
      return Promise.resolve();
    }

    const deduped = [];
    const seen = new Set();
    cells.forEach((cell) => {
      if (!cell) {
        return;
      }
      const row = Number(cell.row);
      const col = Number(cell.col);
      if (!Number.isFinite(row) || !Number.isFinite(col)) {
        return;
      }
      const key = `${row}-${col}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push({ row, col });
      }
    });

    if (deduped.length === 0) {
      return Promise.resolve();
    }

    const sprites = deduped
      .map((cell) => this.getSpriteAt(cell.row, cell.col))
      .filter((sprite) => sprite && !sprite.destroyed);

    if (sprites.length === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const baseScales = sprites.map((sprite) => ({ x: sprite.scale.x, y: sprite.scale.y }));
      const tl = gsap.timeline({
        onComplete: () => {
          sprites.forEach((sprite, index) => {
            const base = baseScales[index];
            sprite.scale.set(base.x, base.y);
            sprite.alpha = 1;
          });
          resolve();
        }
      });

      sprites.forEach((sprite, index) => {
        const base = baseScales[index];
        tl.to(
          sprite.scale,
          {
            x: base.x * scaleAmount,
            y: base.y * scaleAmount,
            duration,
            ease: 'back.out(2)'
          },
          0
        );
        tl.to(
          sprite.scale,
          {
            x: base.x,
            y: base.y,
            duration,
            ease: 'back.in(1.2)'
          },
          duration
        );
      });
    });
  }
}
