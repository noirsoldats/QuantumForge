const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let authErrorWindow = null;
let pendingErrorInfo = null;

function createAuthErrorWindow(errorInfo) {
  // Only one window at a time
  if (authErrorWindow && !authErrorWindow.isDestroyed()) {
    authErrorWindow.focus();
    return;
  }

  pendingErrorInfo = errorInfo;

  authErrorWindow = new BrowserWindow({
    width: 480,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: 'Authentication Required — Quantum Forge',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  authErrorWindow.setMenu(null);
  authErrorWindow.loadFile(path.join(__dirname, '../../public/auth-error-modal.html'));

  authErrorWindow.on('closed', () => {
    authErrorWindow = null;
    pendingErrorInfo = null;
  });
}

function setupAuthErrorWindowHandlers() {
  ipcMain.handle('authErrorModal:getErrorInfo', () => {
    return pendingErrorInfo;
  });

  ipcMain.handle('authErrorModal:resize', (event, contentHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      const [currentWidth] = win.getSize();
      win.setSize(currentWidth, contentHeight);
    }
  });

  ipcMain.handle('authErrorModal:dismiss', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle('authErrorModal:reauthenticate', async (event) => {
    const { authenticateWithESI } = require('./esi-auth');
    const { addCharacter } = require('./settings-manager');

    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      const authResult = await authenticateWithESI();
      addCharacter(authResult);
      if (win && !win.isDestroyed()) win.close();
      return { success: true };
    } catch (err) {
      // Re-throw so the renderer can re-enable the button
      throw err;
    }
  });
}

module.exports = { createAuthErrorWindow, setupAuthErrorWindowHandlers };
