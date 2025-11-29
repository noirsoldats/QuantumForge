const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let assetsWindows = {};

/**
 * Create or focus assets window for a character
 * @param {number} characterId - Character ID
 */
function createAssetsWindow(characterId) {
  // If window already exists for this character, focus it
  if (assetsWindows[characterId] && !assetsWindows[characterId].isDestroyed()) {
    assetsWindows[characterId].focus();
    return;
  }

  const windowName = `assets-${characterId}`;
  const windowBounds = getWindowBounds(windowName, { width: 1200, height: 800 });
  const version = app.getVersion();

  const assetsWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Asset Manager - Quantum Forge v${version}`,
  });

  // Track window state changes
  trackWindowState(assetsWindow, windowName);

  // Show window when ready to prevent white screen
  assetsWindow.once('ready-to-show', () => {
    assetsWindow.show();
  });

  // Load the assets.html
  assetsWindow.loadFile(path.join(__dirname, '../../public/assets.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    assetsWindow.webContents.openDevTools();
  }

  // Send character ID to the renderer process after page loads
  assetsWindow.webContents.on('did-finish-load', () => {
    assetsWindow.webContents.send('assets:set-character-id', characterId);
  });

  assetsWindow.on('closed', () => {
    delete assetsWindows[characterId];
  });

  assetsWindows[characterId] = assetsWindow;
}

module.exports = {
  createAssetsWindow,
};
