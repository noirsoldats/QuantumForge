const { BrowserWindow } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let blueprintsWindows = {};

/**
 * Create or focus blueprints window for a character
 * @param {number} characterId - Character ID
 */
function createBlueprintsWindow(characterId) {
  // If window already exists for this character, focus it
  if (blueprintsWindows[characterId] && !blueprintsWindows[characterId].isDestroyed()) {
    blueprintsWindows[characterId].focus();
    return;
  }

  const windowName = `blueprints-${characterId}`;
  const windowBounds = getWindowBounds(windowName, { width: 1200, height: 800 });

  const blueprintsWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: 'Blueprint Manager',
  });

  // Track window state changes
  trackWindowState(blueprintsWindow, windowName);

  // Show window when ready to prevent white screen
  blueprintsWindow.once('ready-to-show', () => {
    blueprintsWindow.show();
  });

  // Load the blueprints.html
  blueprintsWindow.loadFile(path.join(__dirname, '../../public/blueprints.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    blueprintsWindow.webContents.openDevTools();
  }

  // Send character ID to the renderer process after page loads
  blueprintsWindow.webContents.on('did-finish-load', () => {
    blueprintsWindow.webContents.send('blueprints:set-character-id', characterId);
  });

  blueprintsWindow.on('closed', () => {
    delete blueprintsWindows[characterId];
  });

  blueprintsWindows[characterId] = blueprintsWindow;
}

module.exports = {
  createBlueprintsWindow,
};
