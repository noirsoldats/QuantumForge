/**
 * Window Controls
 *
 * IPC handlers backing the custom (frameless) title bar. The app previously
 * relied entirely on the native OS frame, so none of this existed.
 *
 * Platform split (see `getFramelessOptions`):
 *   - macOS: `titleBarStyle: 'hiddenInset'` keeps the native traffic lights, so
 *     the renderer draws NO window buttons. The window is still frameless enough
 *     for a custom title bar, and users keep the standard macOS controls.
 *   - Windows / Linux: `frame: false` and the renderer draws minimise / maximise
 *     / close itself.
 *
 * Renderers must mark the title bar `-webkit-app-region: drag` and every
 * interactive child `-webkit-app-region: no-drag`, or the controls swallow clicks.
 */

const { BrowserWindow, ipcMain } = require('electron');

const isMac = process.platform === 'darwin';

/**
 * BrowserWindow options that make a window frameless in a platform-appropriate way.
 * Spread into the window config by `createAppWindow`.
 * @returns {Object}
 */
/**
 * Left inset (CSS px) the title bar must reserve on macOS for the native
 * traffic lights.
 *
 * The three buttons are 14px wide with 6px gaps, starting at
 * TRAFFIC_LIGHT_X. That is 14*3 + 6*2 = 54px of buttons, so the content must
 * start at TRAFFIC_LIGHT_X + 54 + a small breathing gap.
 */
const TRAFFIC_LIGHT_X = 12;

/**
 * Vertical offset centring the 14px buttons in the 42px title bar
 * (see --qf-titlebar-height in shared/shell.css): (42 - 14) / 2 = 14.
 */
const TRAFFIC_LIGHT_Y = 14;

function getFramelessOptions() {
  if (isMac) {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y },
    };
  }
  return { frame: false };
}

/**
 * Resolve the BrowserWindow that owns an IPC event.
 *
 * `BrowserWindow.fromWebContents` is used rather than `fromId`, so the call
 * resolves to whichever window actually sent it.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {BrowserWindow|null}
 */
function windowFromEvent(event) {
  if (!event || !event.sender) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Notify a window's renderers that its maximised state changed, so the title bar
 * can swap the maximise/restore glyph.
 *
 * Sends per-frame: a plain `webContents.send` only reaches the main frame, and
 * the shell may be hosting a framed view that also renders chrome.
 * @param {BrowserWindow} win
 */
function emitMaximizeChanged(win) {
  if (!win || win.isDestroyed()) return;
  const payload = { maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
  try {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try {
        frame.send('window:maximize-changed', payload);
      } catch (_) {
        /* frame went away mid-iterate */
      }
    }
  } catch (_) {
    /* webContents torn down */
  }
}

/**
 * Wire the maximise/unmaximise/fullscreen listeners for a window.
 * Called by `createAppWindow` for every shell window.
 * @param {BrowserWindow} win
 */
function trackWindowChrome(win) {
  if (!win) return;
  const notify = () => emitMaximizeChanged(win);
  win.on('maximize', notify);
  win.on('unmaximize', notify);
  win.on('enter-full-screen', notify);
  win.on('leave-full-screen', notify);
}

/**
 * Register the window-control IPC handlers. Call once during app startup.
 */
function registerWindowControlHandlers() {
  ipcMain.handle('window:minimize', (event) => {
    const win = windowFromEvent(event);
    if (win && win.minimizable !== false) win.minimize();
    return true;
  });

  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = windowFromEvent(event);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  ipcMain.handle('window:close', (event) => {
    const win = windowFromEvent(event);
    // close() (not destroy()) so 'close' handlers - unsaved-changes guards,
    // window-state persistence - still run.
    if (win) win.close();
    return true;
  });

  ipcMain.handle('window:isMaximized', (event) => {
    const win = windowFromEvent(event);
    return win ? win.isMaximized() : false;
  });

  ipcMain.handle('window:getPlatformChrome', () => ({
    // The renderer draws its own buttons only where the OS does not.
    platform: process.platform,
    isMac,
    drawsOwnControls: !isMac,
  }));

  /**
   * Open any registered shell view in its own window.
   *
   * ONE handler for every poppable screen - there is deliberately no
   * per-screen `<x>:openWindow`. Windows are keyed on (viewId, params), so a
   * repeat request focuses the existing window instead of duplicating it.
   */
  ipcMain.handle('window:openView', (event, viewId, params, options) => {
    const { openViewWindow } = require('./view-window');
    openViewWindow(viewId, params || {}, options || {});
    return true;
  });

  ipcMain.handle('window:isViewOpen', (event, viewId, params) => {
    const { isViewWindowOpen } = require('./view-window');
    return isViewWindowOpen(viewId, params || {});
  });

  ipcMain.handle('window:focusView', (event, viewId, params) => {
    const { focusViewWindow } = require('./view-window');
    return focusViewWindow(viewId, params || {});
  });

  /**
   * Every open view window, as `{ key, viewId, params }`.
   *
   * A window that opens mid-session is announced over
   * `window:viewWindowsChanged`; this is for a rail that is being built now and
   * needs the current state.
   */
  ipcMain.handle('window:listViewWindows', () => {
    const { listViewWindows } = require('./view-window');
    return listViewWindows();
  });

  // Payload slots for popping a view out with its results intact.
  require('./view-handoff').registerHandoffHandlers();

  /**
   * Close the view window for a (viewId, params) pair.
   *
   * Used by "put it back": the popped-out window closes and the tool becomes
   * mountable in the main window again.
   */
  ipcMain.handle('window:closeView', (event, viewId, params) => {
    const { closeViewWindow } = require('./view-window');
    return closeViewWindow(viewId, params || {});
  });
}

module.exports = {
  isMac,
  getFramelessOptions,
  windowFromEvent,
  emitMaximizeChanged,
  trackWindowChrome,
  registerWindowControlHandlers,
};
