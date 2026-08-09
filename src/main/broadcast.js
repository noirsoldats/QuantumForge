/**
 * Broadcast
 *
 * Sends an IPC message to every renderer in every window.
 *
 * Two things this gets right that ad-hoc sends did not:
 *
 *   1. **Every window, not `getAllWindows()[0]`.** Several call sites used to
 *      grab "whatever window happens to be first" and send there, which is the
 *      wrong target as soon as more than one window is open.
 *
 *   2. **Every frame, not just the main frame.** `webContents.send()` reaches
 *      only the top-level document. The application shell hosts not-yet-ported
 *      tools in same-origin iframes, so a plain send never reaches them - and
 *      fails silently, with no error to debug.
 */

const { BrowserWindow } = require('electron');

/**
 * Send `payload` on `channel` to every frame of every live window.
 * @param {string} channel
 * @param {*} [payload]
 */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      // framesInSubtree includes the main frame, so there is no separate
      // top-level send.
      for (const frame of win.webContents.mainFrame.framesInSubtree) {
        try {
          frame.send(channel, payload);
        } catch (_) {
          // The frame went away mid-iterate; skip it.
        }
      }
    } catch (_) {
      // webContents torn down between the isDestroyed check and here.
    }
  }
}

/**
 * Send to a single window, still covering all of its frames.
 * @param {Electron.BrowserWindow} win
 * @param {string} channel
 * @param {*} [payload]
 */
function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try {
        frame.send(channel, payload);
      } catch (_) { /* frame went away */ }
    }
  } catch (_) { /* webContents torn down */ }
}

module.exports = { broadcast, sendToWindow };
