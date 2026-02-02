const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let cleanupToolWindow = null;

/**
 * Create or focus cleanup tool window
 */
function createCleanupToolWindow() {
  // If window already exists, focus it
  if (cleanupToolWindow && !cleanupToolWindow.isDestroyed()) {
    cleanupToolWindow.focus();
    return;
  }

  const windowName = 'cleanup-tool';
  const windowBounds = getWindowBounds(windowName, { width: 1400, height: 900 });
  const version = app.getVersion();

  cleanupToolWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `What Can I Build? - Quantum Forge v${version}`,
  });

  // Track window state changes
  trackWindowState(cleanupToolWindow, windowName);

  // Show window when ready to prevent white screen
  cleanupToolWindow.once('ready-to-show', () => {
    cleanupToolWindow.show();
  });

  // Load the cleanup-tool.html
  cleanupToolWindow.loadFile(path.join(__dirname, '../../public/cleanup-tool.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    cleanupToolWindow.webContents.openDevTools();
  }

  cleanupToolWindow.on('closed', () => {
    cleanupToolWindow = null;
  });
}

module.exports = {
  createCleanupToolWindow,
};
