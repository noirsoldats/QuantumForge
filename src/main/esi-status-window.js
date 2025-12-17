const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let esiStatusWindow = null;

/**
 * Create ESI Status window
 */
function createESIStatusWindow() {
  // If window already exists, focus it
  if (esiStatusWindow && !esiStatusWindow.isDestroyed()) {
    esiStatusWindow.focus();
    return;
  }

  const windowName = 'esi-status';
  const windowBounds = getWindowBounds(windowName, { width: 1200, height: 750 });
  const version = app.getVersion();

  esiStatusWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
    backgroundColor: '#1e1e2e',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `ESI Status - Quantum Forge v${version}`,
    modal: false,
  });

  trackWindowState(esiStatusWindow, windowName);

  esiStatusWindow.once('ready-to-show', () => {
    esiStatusWindow.show();
  });

  esiStatusWindow.loadFile(path.join(__dirname, '../../public/esi-status.html'));

  if (process.env.NODE_ENV === 'development') {
    esiStatusWindow.webContents.openDevTools();
  }

  esiStatusWindow.on('closed', () => {
    esiStatusWindow = null;
  });
}

/**
 * Get ESI Status window reference
 */
function getESIStatusWindow() {
  return esiStatusWindow;
}

module.exports = {
  createESIStatusWindow,
  getESIStatusWindow,
};
