const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { getCharacter } = require('./settings-manager');

let authErrorWindow = null;
let pendingErrorInfo = null;
let errorQueue = []; // errorInfo objects waiting to be shown, in case a window is already open

function openAuthErrorWindow(errorInfo) {
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
    if (errorQueue.length > 0) {
      openAuthErrorWindow(errorQueue.shift());
    }
  });
}

/**
 * Show errorInfo now if no auth-error window is open, otherwise queue it
 * (deduped by characterId) so it's shown once the current window closes.
 * Multiple characters can hit an auth error in the same startup pass —
 * this ensures none of them are silently dropped.
 */
function enqueueOrShow(errorInfo) {
  if (authErrorWindow && !authErrorWindow.isDestroyed()) {
    const isCurrent = pendingErrorInfo && pendingErrorInfo.characterId === errorInfo.characterId;
    const alreadyQueued = errorQueue.some(e => e.characterId === errorInfo.characterId);
    if (!isCurrent && !alreadyQueued) {
      errorQueue.push(errorInfo);
    }
    authErrorWindow.focus();
    return;
  }

  openAuthErrorWindow(errorInfo);
}

function createAuthErrorWindow(errorInfo) {
  enqueueOrShow(errorInfo);
}

/**
 * Open the dedicated auth-error pop-out window for the given error
 * (queuing it if one is already open — see enqueueOrShow).
 */
function broadcastAuthError(errorInfo) {
  console.warn('[Auth] Auth error for character', errorInfo.characterId, '-', errorInfo.type);
  enqueueOrShow(errorInfo);
}

/**
 * Build an auth error info object from a tagged ESI error.
 * Computes the missing scope list for ESI_SCOPE_ERROR by comparing
 * the character's granted scopes against the required ESI_CONFIG.scopes.
 */
function buildAuthErrorInfo(error, characterId) {
  const character = getCharacter(characterId);
  const characterName = character ? character.characterName : `Character ${characterId}`;

  if (error.code === 'ESI_TOKEN_REFRESH_FAILED') {
    return { type: 'token_refresh_failed', characterId, characterName };
  }

  // ESI_SCOPE_ERROR — compute missing scopes from local comparison
  const { ESI_CONFIG } = require('./esi-auth');
  const granted = character ? (character.scopes || []) : [];
  const missingScopes = ESI_CONFIG.scopes.filter(s => !granted.includes(s));
  return {
    type: 'missing_scopes',
    characterId,
    characterName,
    missingScopes: missingScopes.length > 0 ? missingScopes : ['Unknown scope — re-authentication required'],
  };
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

module.exports = {
  createAuthErrorWindow,
  setupAuthErrorWindowHandlers,
  broadcastAuthError,
  buildAuthErrorInfo,
};
