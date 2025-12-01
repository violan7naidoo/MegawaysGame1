/**
 * main.js - Game Entry Point
 * 
 * This is the main entry point for the Jungle Relics slot game frontend.
 * It initializes the PixiJS application, sets up all managers, handles UI events,
 * and coordinates the game flow between user interactions and backend communication.
 * 
 * Key Responsibilities:
 * - Initialize PixiJS WebGL application
 * - Create and coordinate managers (Network, Theme, Scene)
 * - Handle all UI events (spin, bet adjustment, modals)
 * - Manage game state (bet amount, bet mode, turbo mode)
 * - Start game session with backend
 * - Process spin results and update UI
 * 
 * Dependencies:
 * - PixiJS: WebGL rendering engine
 * - NetworkManager: Backend API communication
 * - ThemeManager: Asset loading
 * - SceneManager: Visual scene orchestration
 */

import * as PIXI from 'pixi.js';
import NetworkManager from './NetworkManager.js';
import ThemeManager from './ThemeManager.js';
import SceneManager from './SceneManager.js';

/**
 * Main entry point - initializes the game application
 * 
 * Flow:
 * 1. Initialize PixiJS app and attach to DOM
 * 2. Create managers (Network, Theme, Scene)
 * 3. Set up UI event listeners
 * 4. Start session with backend
 * 5. Load theme assets
 * 6. Initialize scene
 * 7. Ready for gameplay
 * 
 * @async
 * @returns {Promise<void>}
 */
async function main() {
  // Get the container element for the game canvas
  const canvasParent = document.getElementById('game-root');
  if (!canvasParent) {
    console.error('game-root element not found');
    return;
  }
  
  // Initialize PixiJS WebGL application
  // Use window size for canvas, scaling will be handled by SceneManager
  const app = new PIXI.Application();
  await app.init({
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    background: 0x030604, // Dark background color as fallback
    backgroundAlpha: 1,
    resizeTo: window, // Automatically resize canvas to window size (handles responsive scaling)
    antialias: true // Enable anti-aliasing for smoother graphics
  });
  canvasParent.appendChild(app.canvas);
  
  console.log('PixiJS app initialized, canvas size:', app.renderer.width, 'x', app.renderer.height);

  // Create managers - these handle different aspects of the game
  const network = new NetworkManager(); // Handles backend API communication
  const themeManager = new ThemeManager(); // Loads game assets (symbols, textures)
  const sceneManager = new SceneManager({ app, assets: PIXI.Assets }); // Manages visual scene

  // Game state variables
  let sessionInfo = null; // Session data from backend (sessionId, gameId, balance, etc.)
  let activeBetMode = 'standard'; // Bet mode: 'standard' or 'ante'
  let currentBaseBet = 0.2; // Current bet amount in currency units
  let isTurboMode = false; // Turbo mode flag (speeds up animations)

  // Get references to UI elements from index.html
  const spinButton = document.getElementById('btn-spin');
  const buyButton = document.getElementById('btn-buy');
  const betModeInputs = document.querySelectorAll('input[name="bet-mode"]');
  const turboButton = document.getElementById('btn-turbo');
  const roundLabel = document.getElementById('round-label');
  const roundWinLabel = document.getElementById('round-win');
  const betAmountLabel = document.getElementById('bet-amount');
  const totalWinLabel = document.getElementById('win-amount');
  const balanceLabel = document.getElementById('balance-amount');
  const timestampBox = document.getElementById('timestamp-box');
  const infoButton = document.getElementById('btn-info');
  const soundButton = document.getElementById('btn-sound');
  // Audio is now handled by AudioManager in SceneManager

  /**
   * Extracts money amount from various value formats
   * 
   * Handles different backend response formats:
   * - Number: returns as-is
   * - String: parses to number
   * - Object with .amount: recursively extracts
   * - Null/undefined: returns 0
   * 
   * @param {any} value - Money value in various formats
   * @returns {number} - Extracted money amount (0 if invalid)
   */
  const getMoneyAmount = (value) => {
    if (value == null) {
      return 0;
    }

    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    if (typeof value === 'object' && value.amount != null) {
      return getMoneyAmount(value.amount);
    }

    return 0;
  };

  // Set up bet mode radio button listeners
  // Bet mode can be 'standard' or 'ante' (ante has higher volatility)
  betModeInputs.forEach((input) => {
    input.addEventListener('change', (event) => {
      if (event.target.checked) {
        activeBetMode = event.target.value;
        updateControlStates(); // Update button states (buy button disabled in ante mode)
      }
    });
  });

  /**
   * Starts background music on first user interaction
   * 
   * Browsers block autoplay of audio, so we need to wait for user interaction.
   * This function is called once on first click/touch, then removes itself.
   */
  const startMusicOnInteraction = () => {
    if (sceneManager.audioManager && sceneManager.audioManager.currentMusic === null) {
      sceneManager.audioManager.playBackgroundMusic();
    }
    document.removeEventListener('click', startMusicOnInteraction);
    document.removeEventListener('touchstart', startMusicOnInteraction);
  };
  document.addEventListener('click', startMusicOnInteraction, { once: true });
  document.addEventListener('touchstart', startMusicOnInteraction, { once: true });

  // Spin button - main game action
  spinButton.addEventListener('click', () => {
    console.log('Spin button clicked, sessionInfo:', sessionInfo);
    sceneManager.audioManager?.playClick(); // Play click sound
    startMusicOnInteraction(); // Ensure music starts (if not already)
    startSpin(); // Start the spin process
  });
  
  // Buy Free Spins button - purchases free spin feature
  buyButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    startMusicOnInteraction(); // Ensure music starts
    buyFreeSpins(); // Purchase and trigger free spins
  });
  
  // Initialize UI with default values
  betAmountLabel.textContent = currentBaseBet.toFixed(2);
  updateControlStates(); // Set initial button states

  // Bet adjustment buttons (up/down arrows)
  const betUpButton = document.getElementById('bet-up');
  const betDownButton = document.getElementById('bet-down');
  const betIncrement = 0.10; // Standard bet increment/decrement amount

  // Increase bet amount
  betUpButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    currentBaseBet += betIncrement;
    currentBaseBet = Math.round(currentBaseBet * 100) / 100; // Round to 2 decimals to prevent floating point errors
    betAmountLabel.textContent = currentBaseBet.toFixed(2);
  });

  // Decrease bet amount (minimum 0.10)
  betDownButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    currentBaseBet = Math.max(0.10, currentBaseBet - betIncrement); // Don't go below minimum
    currentBaseBet = Math.round(currentBaseBet * 100) / 100; // Round to 2 decimals
    betAmountLabel.textContent = currentBaseBet.toFixed(2);
  });

  // Turbo mode button - speeds up all animations by 60%
  if (turboButton) {
    turboButton.disabled = false;
    turboButton.addEventListener('click', () => {
      sceneManager.audioManager?.playClick();
      isTurboMode = !isTurboMode;
      turboButton.textContent = isTurboMode ? 'Turbo ON' : 'Turbo';
      turboButton.style.background = isTurboMode 
        ? 'rgba(255, 215, 0, 0.4)' 
        : 'rgba(0, 0, 0, 0.6)';
      
      // Apply turbo mode to scene manager (speeds up all animations)
      sceneManager.setTurboMode(isTurboMode);
    });
  }

  /**
   * Updates the timestamp display in the top-right HUD
   * Called every second to show current time
   */
  function updateTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    timestampBox.textContent = `${hours}:${minutes}:${seconds}`;
  }
  updateTimestamp(); // Initial update
  setInterval(updateTimestamp, 1000); // Update every second

  // Bet adjustment modal - allows precise bet amount entry
  const betModal = document.getElementById('bet-modal');
  const betInput = document.getElementById('bet-input');
  const applyBetButton = document.getElementById('apply-bet');
  const closeBetModal = document.getElementById('close-bet-modal');
  const betQuickButtons = document.querySelectorAll('.bet-quick-button');

  // Clicking bet amount label opens modal
  betAmountLabel.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    betInput.value = currentBaseBet.toFixed(2); // Pre-fill with current bet
    updateBetQuickButtons(); // Highlight matching quick button
    betModal.classList.add('active'); // Show modal
  });

  // Close modal button
  closeBetModal.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    betModal.classList.remove('active');
  });

  // Quick bet buttons (0.10, 0.20, 0.50, etc.) - set bet to preset value
  betQuickButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      sceneManager.audioManager?.playClick();
      const betValue = parseFloat(btn.dataset.bet);
      betInput.value = betValue.toFixed(2);
      updateBetQuickButtons(); // Update active state
    });
  });

  /**
   * Updates which quick bet button is highlighted based on current input value
   * Highlights button if its value matches current bet (within 0.01 tolerance)
   */
  function updateBetQuickButtons() {
    const currentBet = parseFloat(betInput.value) || 0;
    betQuickButtons.forEach(btn => {
      const btnBet = parseFloat(btn.dataset.bet);
      btn.classList.toggle('active', Math.abs(btnBet - currentBet) < 0.01);
    });
  }

  // Apply button - sets new bet amount and closes modal
  applyBetButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    const newBet = parseFloat(betInput.value);
    if (newBet && newBet > 0) {
      currentBaseBet = newBet;
      betAmountLabel.textContent = currentBaseBet.toFixed(2);
      betModal.classList.remove('active');
    }
  });

  // Update quick buttons as user types
  betInput.addEventListener('input', updateBetQuickButtons);

  // Info modal - displays game rules and paytable
  const infoModal = document.getElementById('info-modal');
  const closeInfoModal = document.getElementById('close-info-modal');

  infoButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    infoModal.classList.add('active');
  });

  closeInfoModal.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    infoModal.classList.remove('active');
  });

  // Sound settings modal - controls music and SFX volumes
  const soundModal = document.getElementById('sound-modal');
  const closeSoundModal = document.getElementById('close-sound-modal');
  const musicVolumeSlider = document.getElementById('music-volume');
  const sfxVolumeSlider = document.getElementById('sfx-volume');
  const musicVolumeValue = document.getElementById('music-volume-value');
  const sfxVolumeValue = document.getElementById('sfx-volume-value');
  const muteAllButton = document.getElementById('mute-all');

  soundButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    soundModal.classList.add('active');
  });

  closeSoundModal.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    soundModal.classList.remove('active');
  });

  // Music volume slider - controls background music volume (0-100%)
  musicVolumeSlider.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value) / 100; // Convert 0-100 to 0.0-1.0
    sceneManager.audioManager?.setMusicVolume(volume);
    musicVolumeValue.textContent = `${e.target.value}%`; // Update display
  });

  // SFX volume slider - controls sound effects volume (0-100%)
  sfxVolumeSlider.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value) / 100; // Convert 0-100 to 0.0-1.0
    sceneManager.audioManager?.setSfxVolume(volume);
    sfxVolumeValue.textContent = `${e.target.value}%`; // Update display
  });

  // Mute/Unmute all button - toggles all audio on/off
  muteAllButton.addEventListener('click', () => {
    sceneManager.audioManager?.playClick();
    const isMuted = sceneManager.audioManager?.isMuted || false;
    sceneManager.audioManager?.setMuted(!isMuted);
    muteAllButton.textContent = !isMuted ? 'Unmute All' : 'Mute All';
  });

  // Close modals when clicking outside the modal content
  [betModal, infoModal, soundModal].forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { // Clicked on backdrop, not content
        modal.classList.remove('active');
      }
    });
  });

  // Initialize game - connect to backend, load assets, set up scene
  try {
    console.log('Attempting to start session with backend at:', network.baseUrl);
    
    // Step 1: Start game session with backend (RGS service)
    // This creates a new session and returns session info (sessionId, gameId, balance, etc.)
    const startResponse = await network.startSession('operatorX', 'JungleRelics', {
      lang: 'en',
      funMode: 1 // Fun mode (demo mode, no real money)
    });

    sessionInfo = startResponse; // Store session info for subsequent API calls
    console.log('Session started, gameId:', startResponse.gameId);
    
    // Step 2: Load theme assets (symbols, textures, animations)
    console.log('Loading theme...');
    const themeManifest = await themeManager.loadTheme(startResponse.gameId, PIXI.Assets);
    console.log('Theme loaded, manifest:', themeManifest);
    
    // Step 3: Initialize scene (grid, backgrounds, animations)
    console.log('Initializing scene...');
    await sceneManager.initialize(themeManifest);
    console.log('Game initialized successfully');
    
    // Step 4: Initialize UI with balance from session
    const initialBalance = getMoneyAmount(startResponse.balance ?? startResponse.initialBalance);
    if (initialBalance > 0) {
      balanceLabel.textContent = initialBalance.toFixed(2);
    }
  } catch (error) {
    console.error('Failed to initialize game:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      baseUrl: network.baseUrl
    });
    
    // Fallback: Try to initialize with demo mode (no backend connection)
    // This allows the game to load visually even if backend is down
    try {
      console.log('Attempting to initialize in demo mode...');
      
      // Create a mock sessionInfo for demo mode
      // Game will load but spins won't work without backend
      sessionInfo = {
        sessionId: 'demo-session',
        gameId: 'JungleRelics',
        balance: 1000,
        initialBalance: 1000
      };
      
      // Still load theme and initialize scene (visual only)
      const demoThemeManifest = await themeManager.loadTheme('JungleRelics', PIXI.Assets);
      await sceneManager.initialize(demoThemeManifest);
      
      // Show warning that backend is not connected
      const warningDiv = document.createElement('div');
      warningDiv.style.cssText = 'position: fixed; top: 10px; left: 50%; transform: translateX(-50%); background: rgba(255, 0, 0, 0.8); color: white; padding: 15px 20px; border-radius: 8px; z-index: 10000; text-align: center; max-width: 600px;';
      warningDiv.innerHTML = `
        <strong>⚠️ Backend Not Connected</strong><br>
        <small>Game is running in demo mode. Backend service at ${network.baseUrl} is not available.</small><br>
        <small>Please start the backend services (RGS on port 5100) to enable gameplay.</small>
      `;
      document.body.appendChild(warningDiv);
      
      // Remove warning after 10 seconds
      setTimeout(() => {
        if (warningDiv.parentNode) {
          warningDiv.parentNode.removeChild(warningDiv);
        }
      }, 10000);
      
      console.log('Game initialized in demo mode (backend not available)');
    } catch (demoError) {
      console.error('Failed to initialize even in demo mode:', demoError);
      console.error('Demo error stack:', demoError?.stack);
      // Show error to user
      const gameRoot = document.getElementById('game-root');
      if (gameRoot) {
        const errorMessage = error?.message || demoError?.message || 'Unknown error';
        gameRoot.innerHTML = `<div style="color: white; padding: 40px; text-align: center; background: rgba(0,0,0,0.9); height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;">
          <h2 style="color: #ff6b6b; margin-bottom: 20px;">Initialization Error</h2>
          <p style="margin: 10px 0;"><strong>Backend Connection Failed:</strong></p>
          <p style="margin: 10px 0; color: #ffd93d;">${errorMessage}</p>
          <p style="margin: 20px 0; font-size: 14px;">Please ensure the backend services are running:</p>
          <ul style="text-align: left; display: inline-block; margin: 20px 0;">
            <li>RGS service on port 5100</li>
            <li>Game Engine on port 5101</li>
            <li>RNG Host on port 5102</li>
          </ul>
          <p style="margin-top: 20px; font-size: 12px; color: #888;">Check the browser console (F12) for more details.</p>
        </div>`;
      }
    }
  }
  roundLabel.textContent = 'Round --';
  roundWinLabel.textContent = '0.00';
  
  // Balance will be initialized from sessionInfo after successful initialization

  /**
   * Handles spin button click - main game action
   * 
   * Flow:
   * 1. Validate session exists
   * 2. Disable UI controls
   * 3. Start visual spin animation
   * 4. Send spin request to backend
   * 5. Render results (cascades, wins, etc.)
   * 6. Update UI (balance, win amount, round ID)
   * 7. Re-enable UI controls
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function startSpin() {
    // Validate session exists
    if (!sessionInfo) {
      console.error('Cannot spin: sessionInfo is not set. Initialization may have failed.');
      console.log('sessionInfo:', sessionInfo);
      return;
    }
    console.log('Starting spin with sessionInfo:', sessionInfo);
    
    // Disable all controls during spin
    setControlsDisabled(true);
    
    // Spin sound is played by AudioManager in startSpinAnimation
    try {
      // Step 1: Start visual spin animation (reels start spinning)
      sceneManager.startSpinAnimation();
      
      // Step 2: Prepare payload for backend API
      const playPayload = {
        sessionId: sessionInfo.sessionId,
        baseBet: currentBaseBet,
        betMode: activeBetMode, // 'standard' or 'ante'
        bets: [{ betType: 'BASE', amount: currentBaseBet }],
        userPayload: { lang: 'en' }
      };
      
      // Step 3: Send spin request to backend and wait for results
      console.log('[main] startSpin: Sending play request to backend...');
      const playResponse = await network.play(sessionInfo.gameId, playPayload);
      console.log('[main] startSpin: Backend response received', {
        hasResults: !!playResponse.results,
        hasReelSymbols: !!playResponse.results?.reelSymbols,
        hasCascades: !!playResponse.results?.cascades,
        cascadesCount: playResponse.results?.cascades?.length || 0,
        win: playResponse.win,
        balance: playResponse.balance
      });
      
      if (playResponse.results?.reelSymbols) {
        console.log('[main] startSpin: Reel symbols from backend:', playResponse.results.reelSymbols.map(r => r?.length || 0));
      }
      
      // Step 4: Render results (handles cascades, free spins, etc.)
      console.log('[main] startSpin: Calling renderResults...');
      sceneManager.renderResults(playResponse.results, playResponse);
      console.log('[main] startSpin: renderResults completed');
      
      // Step 5: Update UI with results
      const winAmount = getMoneyAmount(playResponse.win);
      const balance = getMoneyAmount(playResponse.balance ?? playResponse.balanceAfter);
      roundLabel.textContent = playResponse.roundId ?? 'Round --';
      roundWinLabel.textContent = winAmount.toFixed(2);
      totalWinLabel.textContent = winAmount.toFixed(2);
      if (balance > 0) {
        balanceLabel.textContent = balance.toFixed(2);
      }
    } catch (err) {
      // Error handling - stop animation and show error
      console.error('Spin failed', err);
      sceneManager.stopSpinAnimation();
      roundWinLabel.textContent = 'Error';
    } finally {
      // Always re-enable controls, even on error
      setControlsDisabled(false);
    }
  }

  /**
   * Handles buy free spins feature
   * 
   * Purchases free spins directly (costs 100x base bet).
   * Only available in 'standard' bet mode, not 'ante'.
   * 
   * Flow is similar to startSpin() but uses buyFreeSpins API endpoint.
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function buyFreeSpins() {
    // Validate: session exists and bet mode is standard
    if (!sessionInfo || activeBetMode !== 'standard') {
      return;
    }

    setControlsDisabled(true);
    try {
      // Start visual spin animation
      sceneManager.startSpinAnimation();
      
      // Prepare buy payload
      const buyPayload = {
        sessionId: sessionInfo.sessionId,
        baseBet: currentBaseBet,
        betMode: 'standard' // Buy feature only works in standard mode
      };
      
      // Send buy request to backend
      const response = await network.buyFreeSpins(sessionInfo.gameId, buyPayload);
      
      // Render results (will trigger free spin transition if successful)
      sceneManager.renderResults(response.results, response);
      
      // Update UI
      const winAmount = getMoneyAmount(response.win);
      const costAmount = getMoneyAmount(response.buyCost);
      const balance = getMoneyAmount(response.balance ?? response.balanceAfter);
      roundLabel.textContent = response.roundId ?? 'Feature Buy';
      roundWinLabel.textContent = winAmount.toFixed(2);
      totalWinLabel.textContent = winAmount.toFixed(2);
      if (balance > 0) {
        balanceLabel.textContent = balance.toFixed(2);
      }
    } catch (err) {
      console.error('Buy failed', err);
      sceneManager.stopSpinAnimation();
      roundWinLabel.textContent = 'Buy Failed';
    } finally {
      setControlsDisabled(false);
    }
  }

  /**
   * Enables or disables UI controls
   * 
   * Used during spins to prevent multiple simultaneous actions.
   * Buy button is also disabled in 'ante' mode.
   * 
   * @param {boolean} disabled - True to disable, false to enable
   */
  function setControlsDisabled(disabled) {
    spinButton.disabled = disabled;
    buyButton.disabled = disabled || activeBetMode === 'ante'; // Also disabled in ante mode
    if (turboButton) {
      turboButton.disabled = true; // Always disabled during spin
    }
    betModeInputs.forEach((input) => {
      input.disabled = disabled;
    });
  }

  /**
   * Updates control states based on current game state
   * 
   * Called when bet mode changes or after spin completes.
   * Ensures buy button is disabled in ante mode.
   */
  function updateControlStates() {
    setControlsDisabled(false);
    buyButton.disabled = activeBetMode === 'ante'; // Buy not available in ante mode
  }
}

// Start the game - catch any initialization errors
main().catch((err) => {
  // Log detailed error information
  console.error('Bootstrap failed', err);
  console.error('Bootstrap error details:', {
    message: err?.message,
    stack: err?.stack,
    name: err?.name
  });
  
  // Show error message to user
  const gameRoot = document.getElementById('game-root');
  if (gameRoot && !gameRoot.querySelector('div[style*="Initialization Error"]')) {
    gameRoot.innerHTML = `<div style="color: white; padding: 40px; text-align: center; background: rgba(0,0,0,0.9); height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;">
      <h2 style="color: #ff6b6b; margin-bottom: 20px;">Bootstrap Error</h2>
      <p style="margin: 10px 0; color: #ffd93d;">${err?.message || 'Unknown error'}</p>
      <p style="margin-top: 20px; font-size: 12px; color: #888;">Check the browser console (F12) for more details.</p>
    </div>`;
  }
  
  // Update round label to show error
  if (roundLabel) {
    roundLabel.textContent = 'Error';
  }
});

