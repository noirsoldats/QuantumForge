const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

let lootAnalyzerWindow = null;

/**
 * Create or focus the Loot Analyzer window.
 */
function createLootAnalyzerWindow() {
  if (lootAnalyzerWindow && !lootAnalyzerWindow.isDestroyed()) {
    lootAnalyzerWindow.focus();
    return;
  }

  const windowBounds = getWindowBounds('loot-analyzer', { width: 1600, height: 900 });
  const version = app.getVersion();

  lootAnalyzerWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Loot Analyzer - Quantum Forge v${version}`,
  });

  trackWindowState(lootAnalyzerWindow, 'loot-analyzer');

  lootAnalyzerWindow.once('ready-to-show', () => {
    lootAnalyzerWindow.show();
  });

  lootAnalyzerWindow.loadFile(path.join(__dirname, '../../public/loot-analyzer.html'));

  if (process.env.NODE_ENV === 'development') {
    lootAnalyzerWindow.webContents.openDevTools();
  }

  lootAnalyzerWindow.on('closed', () => {
    lootAnalyzerWindow = null;
  });
}

module.exports = { createLootAnalyzerWindow };
