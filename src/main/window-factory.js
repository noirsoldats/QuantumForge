/**
 * Window Factory
 *
 * The app has ~13 near-identical BrowserWindow creation sites, all repeating the
 * same boilerplate: saved bounds, `show: false` + `ready-to-show`, background
 * colour, preload, and window-state tracking. This centralises that so shell
 * options (frameless chrome, subframe preload) are set in exactly ONE place.
 *
 * `wizard-window.js` and `auth-error-window.js` deliberately do not use this -
 * they are pre-main-window / bespoke popups with different option sets.
 */

const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');
const { getFramelessOptions, trackWindowChrome } = require('./window-controls');

const PRELOAD = path.join(__dirname, '../preload/preload.js');

/**
 * Create an application window with the project's standard configuration.
 *
 * @param {Object} config
 * @param {string} config.name              Window-state key (e.g. 'settings').
 * @param {string} config.title             OS window title (used by screen readers
 *                                          and the taskbar even when frameless).
 * @param {Object} config.defaults          Default bounds `{ width, height }`.
 * @param {string} [config.file]            HTML file to load, relative to /public.
 * @param {Object} [config.query]           Query params appended to the loaded file.
 * @param {boolean} [config.shell=false]    Use the frameless shell chrome.
 * @param {boolean} [config.resizable=true]
 * @param {boolean} [config.trackState=true]
 * @param {Object} [config.webPreferences]  Extra webPreferences overrides.
 * @param {Object} [config.windowOptions]   Extra BrowserWindow overrides.
 * @returns {BrowserWindow}
 */
function createAppWindow(config) {
  const {
    name,
    title,
    defaults = { width: 1200, height: 800 },
    file,
    query,
    shell = false,
    resizable = true,
    trackState = true,
    webPreferences = {},
    windowOptions = {},
  } = config;

  const bounds = getWindowBounds(name, defaults);

  const win = new BrowserWindow({
    ...bounds,
    show: false, // shown on ready-to-show, prevents a white flash
    backgroundColor: '#1e1e2e',
    resizable,
    title: title || `Quantum Forge v${app.getVersion()}`,
    ...(shell ? getFramelessOptions() : {}),
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
      // nodeIntegrationInSubFrames used to be set for shell windows, so the
      // preload reached pages hosted in same-origin iframes. Every view is
      // native now, so the flag is gone: it only widened preload injection.
      ...webPreferences,
    },
    ...windowOptions,
  });

  if (trackState) trackWindowState(win, name);
  if (shell) trackWindowChrome(win);

  win.once('ready-to-show', () => win.show());

  if (file) {
    const filePath = path.join(__dirname, '../../public', file);
    win.loadFile(filePath, query ? { query } : undefined);
  }

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }

  return win;
}

/**
 * Create (or focus) a singleton window.
 *
 * Collapses the `if (existing) { focus(); return; }` guard repeated across every
 * `*-window.js` module.
 *
 * @param {Object} state    Holder object; the window is stored on `state[key]`.
 * @param {string} key      Property name on the holder.
 * @param {Object} config   Passed to `createAppWindow`.
 * @returns {BrowserWindow}
 */
function createOrFocusWindow(state, key, config) {
  const existing = state[key];
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  const win = createAppWindow(config);
  state[key] = win;
  win.on('closed', () => {
    state[key] = null;
  });
  return win;
}

module.exports = {
  createAppWindow,
  createOrFocusWindow,
  PRELOAD,
};
