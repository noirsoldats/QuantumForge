/**
 * Generic host for any shell view opened in its own window.
 *
 * ONE module for every poppable screen. There is deliberately no
 * `assets-window.js` / `skills-window.js` / `blueprints-window.js` equivalent
 * here: a per-screen module is the legacy pattern this migration replaces, and
 * ten of them had already accumulated, each hand-rolling the same BrowserWindow
 * boilerplate and each loading a bespoke page.
 *
 * Every window created here loads the SAME document (the shell host) with
 * `?role=standalone&view=<id>&params=<json>`. The renderer mounts that view into
 * the shell's view host, so:
 *
 *   - the window shows identical chrome to every other window (minus the rail)
 *   - the view code is the SAME code that runs mounted in the main window;
 *     nothing is duplicated per window, and a view need not know where it lives
 *   - adding a poppable screen requires no new main-process module at all -
 *     register the view with the router and it is instantly poppable
 *
 * IDENTITY: windows are keyed on `(viewId, params)`, so "Assets for character A"
 * and "Assets for character B" are two windows, while asking twice for the same
 * pair focuses the existing one. This is the identity rule the pop-out feature
 * needs, established once here rather than reinvented per screen.
 */

const { createAppWindow } = require('./window-factory');
const { app } = require('electron');

/** key -> BrowserWindow */
const openWindows = new Map();

/** key -> { viewId, params }. Kept so a window can be described without
 *  reverse-engineering its key, which is a one-way encoding. */
const windowIdentities = new Map();

/**
 * Stable identity for a (viewId, params) pair.
 *
 * Keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` are the same window - without
 * that, property order would silently spawn duplicates.
 */
function windowKey(viewId, params) {
  const keys = Object.keys(params || {}).sort();
  if (keys.length === 0) return viewId;
  const canonical = keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join('&');
  return `${viewId}?${canonical}`;
}

/**
 * Open (or focus) a view in its own window.
 *
 * @param {string} viewId - the id the view registered with the shell router
 * @param {Object} [params] - mount params handed to the view (e.g. characterId)
 * @param {Object} [options]
 * @param {string} [options.title] - window title; defaults to the view id
 * @param {Object} [options.defaults] - default bounds for a first-time open
 * @returns {BrowserWindow}
 */
function openViewWindow(viewId, params = {}, options = {}) {
  if (!viewId) throw new Error('openViewWindow requires a viewId');

  const key = windowKey(viewId, params);

  const existing = openWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  const { title, defaults = { width: 1400, height: 900 } } = options;

  const win = createAppWindow({
    // Bounds are remembered per (view, params) pair, so each character's window
    // keeps its own size and position.
    name: `view-${key}`,
    title: `${title || viewId} - Quantum Forge v${app.getVersion()}`,
    defaults,
    file: 'index.html',
    shell: true,
    query: {
      role: 'standalone',
      view: viewId,
      params: JSON.stringify(params || {}),
    },
  });

  openWindows.set(key, win);
  windowIdentities.set(key, { viewId, params: params || {} });

  // Tell every window which views are popped out, so each rail can mark the
  // tool and route a click to the existing window instead of mounting a second
  // copy. Broadcast, not a reply to the opener: any window's rail can be
  // showing the marker.
  announceViewWindows();

  win.on('closed', () => {
    // Only forget it if this exact window is still the registered one; a
    // re-open racing a close must not delete the newer window's entry.
    if (openWindows.get(key) === win) {
      openWindows.delete(key);
      windowIdentities.delete(key);
    }
    // The marker must clear, or the tool stays unmountable in main forever.
    announceViewWindows();
  });

  return win;
}

/** Broadcast the current set of open view windows to every renderer. */
function announceViewWindows() {
  try {
    const { broadcast } = require('./broadcast');
    broadcast('window:viewWindowsChanged', { open: listViewWindows() });
  } catch (error) {
    // Broadcast is unavailable in some test harnesses; the windows themselves
    // still work, only the rail marker goes stale.
    console.error('[view-window] could not announce open windows:', error);
  }
}

/** True when a window for this (viewId, params) pair is currently open. */
function isViewWindowOpen(viewId, params = {}) {
  const win = openWindows.get(windowKey(viewId, params));
  return !!(win && !win.isDestroyed());
}

/** Focus an already-open view window; returns false when there isn't one. */
function focusViewWindow(viewId, params = {}) {
  const win = openWindows.get(windowKey(viewId, params));
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.focus();
  return true;
}

/**
 * Every currently open view window, as `{ key, viewId, params }`.
 *
 * The identity is stored when the window opens rather than parsed back out of
 * the key: `windowKey` is a one-way encoding (values go through
 * `JSON.stringify`), so reversing it would be guesswork.
 */
function listViewWindows() {
  const out = [];
  openWindows.forEach((win, key) => {
    if (!win || win.isDestroyed()) return;
    const identity = windowIdentities.get(key);
    out.push({
      key,
      viewId: identity ? identity.viewId : key,
      params: identity ? identity.params : {},
    });
  });
  return out;
}

/**
 * Close the window for a (viewId, params) pair.
 * @returns {boolean} false when there was no such window open
 */
function closeViewWindow(viewId, params = {}) {
  const win = openWindows.get(windowKey(viewId, params));
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
}

/** Close every view window (app shutdown). */
function closeAllViewWindows() {
  openWindows.forEach((win) => {
    if (win && !win.isDestroyed()) win.close();
  });
  openWindows.clear();
  windowIdentities.clear();
}

module.exports = {
  openViewWindow,
  closeViewWindow,
  isViewWindowOpen,
  focusViewWindow,
  listViewWindows,
  closeAllViewWindows,
  windowKey,
};
