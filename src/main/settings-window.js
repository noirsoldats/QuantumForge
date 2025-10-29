const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let settingsWindow = null;

function createSettingsWindow() {
  // If settings window already exists, focus it
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  const windowBounds = getWindowBounds('settings', { width: 800, height: 600 });
  const version = app.getVersion();

  settingsWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Settings - Quantum Forge v${version}`,
    parent: null, // Can be set to main window if you want modal behavior
    modal: false,
  });

  // Track window state changes
  trackWindowState(settingsWindow, 'settings');

  // Show window when ready to prevent white screen
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.loadFile(path.join(__dirname, '../../public/settings.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    settingsWindow.webContents.openDevTools();
  }

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function getSettingsWindow() {
  return settingsWindow;
}

module.exports = {
  createSettingsWindow,
  getSettingsWindow,
};
