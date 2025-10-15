const { screen } = require('electron');
const { loadSettings, saveSettings } = require('./settings-manager');

/**
 * Get saved window state for a specific window
 * @param {string} windowName - Name of the window (main, settings, skills)
 * @returns {Object|null} Window state or null
 */
function getWindowState(windowName) {
  try {
    const settings = loadSettings();

    if (!settings.windowStates) {
      return null;
    }

    return settings.windowStates[windowName] || null;
  } catch (error) {
    console.error('Error getting window state:', error);
    return null;
  }
}

/**
 * Save window state for a specific window
 * @param {string} windowName - Name of the window
 * @param {Object} state - Window state { x, y, width, height }
 * @returns {boolean} Success status
 */
function saveWindowState(windowName, state) {
  try {
    const settings = loadSettings();

    if (!settings.windowStates) {
      settings.windowStates = {};
    }

    settings.windowStates[windowName] = {
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
      timestamp: Date.now(),
    };

    return saveSettings(settings);
  } catch (error) {
    console.error('Error saving window state:', error);
    return false;
  }
}

/**
 * Validate window state is within screen bounds
 * @param {Object} state - Window state
 * @returns {Object} Validated state
 */
function validateWindowState(state) {
  if (!state) {
    return null;
  }

  // Get all displays
  const displays = screen.getAllDisplays();

  // Check if the window position is on any display
  let isVisible = false;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;

    // Check if at least part of the window is visible on this display
    if (
      state.x + state.width > x &&
      state.x < x + width &&
      state.y + state.height > y &&
      state.y < y + height
    ) {
      isVisible = true;
      break;
    }
  }

  if (!isVisible) {
    // Window is off-screen, return null to use defaults
    console.log('Window state is off-screen, using defaults');
    return null;
  }

  return state;
}

/**
 * Get window bounds options for BrowserWindow
 * @param {string} windowName - Name of the window
 * @param {Object} defaults - Default dimensions { width, height, x?, y? }
 * @returns {Object} Window bounds
 */
function getWindowBounds(windowName, defaults) {
  const savedState = getWindowState(windowName);
  const validState = validateWindowState(savedState);

  if (validState) {
    console.log(`Restoring ${windowName} window state:`, validState);
    return {
      x: validState.x,
      y: validState.y,
      width: validState.width,
      height: validState.height,
    };
  }

  // Use defaults
  console.log(`Using default bounds for ${windowName} window`);
  return {
    width: defaults.width,
    height: defaults.height,
    ...(defaults.x !== undefined && { x: defaults.x }),
    ...(defaults.y !== undefined && { y: defaults.y }),
  };
}

/**
 * Track window state changes
 * @param {BrowserWindow} window - The window to track
 * @param {string} windowName - Name of the window
 */
function trackWindowState(window, windowName) {
  let saveTimer = null;

  const saveState = () => {
    // Clear any pending save
    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    // Debounce saves to avoid excessive writes
    saveTimer = setTimeout(() => {
      if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) {
        return;
      }

      const bounds = window.getBounds();
      saveWindowState(windowName, bounds);
    }, 500);
  };

  // Track move and resize events
  window.on('move', saveState);
  window.on('resize', saveState);

  // Save final state when closing
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    if (!window.isDestroyed() && !window.isMinimized() && !window.isMaximized()) {
      const bounds = window.getBounds();
      saveWindowState(windowName, bounds);
    }
  });
}

module.exports = {
  getWindowState,
  saveWindowState,
  validateWindowState,
  getWindowBounds,
  trackWindowState,
};
