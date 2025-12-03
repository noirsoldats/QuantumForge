const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let manufacturingPlansWindow = null;

/**
 * Create or focus manufacturing plans window
 */
function createManufacturingPlansWindow() {
  // If window already exists, focus it
  if (manufacturingPlansWindow && !manufacturingPlansWindow.isDestroyed()) {
    manufacturingPlansWindow.focus();
    return;
  }

  const windowName = 'manufacturing-plans';
  const windowBounds = getWindowBounds(windowName, { width: 1600, height: 1000 });
  const version = app.getVersion();

  manufacturingPlansWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Manufacturing Plans - Quantum Forge v${version}`,
  });

  // Track window state changes
  trackWindowState(manufacturingPlansWindow, windowName);

  // Show window when ready to prevent white screen
  manufacturingPlansWindow.once('ready-to-show', () => {
    manufacturingPlansWindow.show();
  });

  // Load the manufacturing-plans.html
  manufacturingPlansWindow.loadFile(path.join(__dirname, '../../public/manufacturing-plans.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    manufacturingPlansWindow.webContents.openDevTools();
  }

  manufacturingPlansWindow.on('closed', () => {
    manufacturingPlansWindow = null;
  });
}

module.exports = {
  createManufacturingPlansWindow,
};
