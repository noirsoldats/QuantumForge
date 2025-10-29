const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let manufacturingSummaryWindow = null;

/**
 * Create or focus manufacturing summary window
 */
function createManufacturingSummaryWindow() {
  // If window already exists, focus it
  if (manufacturingSummaryWindow && !manufacturingSummaryWindow.isDestroyed()) {
    manufacturingSummaryWindow.focus();
    return;
  }

  const windowName = 'manufacturing-summary';
  const windowBounds = getWindowBounds(windowName, { width: 1400, height: 900 });
  const version = app.getVersion();

  manufacturingSummaryWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Manufacturing Summary - Quantum Forge v${version}`,
  });

  // Track window state changes
  trackWindowState(manufacturingSummaryWindow, windowName);

  // Show window when ready to prevent white screen
  manufacturingSummaryWindow.once('ready-to-show', () => {
    manufacturingSummaryWindow.show();
  });

  // Load the manufacturing-summary.html
  manufacturingSummaryWindow.loadFile(path.join(__dirname, '../../public/manufacturing-summary.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    manufacturingSummaryWindow.webContents.openDevTools();
  }

  manufacturingSummaryWindow.on('closed', () => {
    manufacturingSummaryWindow = null;
  });
}

module.exports = {
  createManufacturingSummaryWindow,
};
