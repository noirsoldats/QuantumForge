/**
 * Shared Electron harness for UI verification runs.
 *
 * Exists because the same two failures kept recurring in every ad-hoc harness:
 *
 *   1. **Blocking dialogs.** The renderers contain ~110 `alert()` / `confirm()`
 *      calls. Several sit on error paths that fire when an IPC handler is
 *      missing. A native dialog is MODAL - with nobody to click OK, the renderer
 *      halts and the run hangs forever with no output. Under the application
 *      shell this is worse: a framed view's alert freezes the whole window.
 *
 *   2. **Missing IPC handlers.** Each harness hand-listed the channels it
 *      thought a screen needed, guessed a name wrong, and triggered (1).
 *
 * This module neutralises dialogs before any page script runs, auto-answers
 * unregistered channels instead of throwing, and always terminates.
 *
 * Usage:
 *   const { launch } = require('./tests/harness/electron-harness');
 *   launch({
 *     file: 'index.html',
 *     query: { role: 'main' },
 *     handlers: { 'market:getLastFetchTime': () => Date.now() },
 *     run: async ({ win, check, emit }) => { ... },
 *   });
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const REPO = path.join(__dirname, '../..');

/**
 * Channels every screen touches, with harmless defaults. A harness only needs
 * to declare what it actually asserts on; everything else resolves rather than
 * throwing into an alert().
 */
const DEFAULT_HANDLERS = {
  'settings:load': () => ({ general: {}, industry: {}, market: {} }),
  'settings:update': () => true,
  'settings:get': () => null,
  'app:getVersion': () => '0.0.0-test',
  'app:getElectronVersion': () => '41.0.0',
  'esi:getCharacters': () => [],
  'esi:getDefaultCharacter': () => null,
  'esi:setDefaultCharacter': () => true,
  'esi:refreshGlobalNow': () => ({ ok: true }),
  'esi:getGlobalRefreshStatus': () => ({ running: false }),
  'market:getLastFetchTime': () => null,
  'market:getRegionDashboard': () => [],
  'market:getMarketSets': () => [],
  'market:updateAllMarketData': () => ({ success: true, errors: [] }),
  'esiStatus:getAggregated': () => ({ overall: 'green', successCount: 0, warningCount: 0, errorCount: 0 }),
  // Still a channel, but it now opens the generic standalone view window
  // rather than a bespoke page.
  'esiStatus:openWindow': () => true,
  'esiStatus:initializeUniverse': () => true,
  'esiStatus:initializeCharacter': () => true,
  'esiStatus:getCharacterCalls': () => [],
  'esiStatus:getUniverseCalls': () => [],
  'esiStatus:getCallDetails': () => ({ status: null, history: [] }),
  'plans:getAll': () => [],
  'status:fetch': () => ({ success: true, data: { players: 0 } }),
  'status:getCached': () => ({ players: 0, vip: false, lastUpdated: Date.now() }),
  'status:getLastFetchTime': () => Date.now(),
  'facilities:getFacilities': () => [],
  'facilities:getAllRegions': () => [],
  'facilities:getSystemsByRegion': () => [],
  'facilities:getStructureTypes': () => [],
  'facilities:getStructureRigs': () => [],
  'facilities:getCostIndices': () => ({}),
  'blueprints:getAll': () => [],
  // Opening a screen in its own window is generic - no per-screen channel.
  'window:openView': () => true,
  'window:closeView': () => true,
  'window:listViewWindows': () => [],
  'handoff:create': () => 'test-token',
  'handoff:claim': () => null,
  'window:isViewOpen': () => false,
  'window:focusView': () => false,
  'assets:get': () => [],
  'assets:getCacheStatus': () => ({ isCached: false, remainingSeconds: 0 }),
  'sde:getTypeCategoryInfo': () => ({}),
  'sde:getItemVolumes': () => ({}),
  'location:resolveMany': () => ({}),
  'market:calculatePrices': () => ({}),
  'structures:getStats': () => ({ total: 0, fresh: 0, denied: 0 }),
  'sde:checkUpdate': () => ({ needsUpdate: false }),
  'sde:hasBackup': () => false,
  'sde:getBackupVersion': () => null,
  'sde:getAllSystems': () => [],
  'sde:getAllRegions': () => [],
  'costIndices:getSystemCount': () => 0,
  'costIndices:getLastFetchTime': () => null,
  'divisions:getSettings': () => ({ enabledDivisions: [], divisionNames: {}, hasCustomNames: false }),
  'industry:getDefaultManufacturingCharacters': () => [],
  // Still a channel, but it opens the generic standalone view window now.
  'audit:openWindow': () => true,
  'audit:getRecords': () => [],
  'audit:clearRecords': () => true,
  'audit:getSummary': () => ({ total: 0, byType: {}, enabled: false }),
  // No manufacturingSummary:openWindow - it is a native shell view now.
  'summary:calculate': () => [],
  // No lootAnalyzer:openWindow or cleanupTool:openWindow either - both are
  // native shell views now. The cleanupTool DATA channels survive: What Can I
  // Build? still runs on them.
  'cleanupTool:getAssetSources': () => [],
  'cleanupTool:refreshAssets': () => ({ success: true, refreshed: [], errors: [] }),
  'cleanupTool:aggregateAssets': () => ({}),
  'wcib:calculate': () => ({ cancelled: false, rows: [], assetTypeCount: 0 }),
  'wcib:cancel': () => true,
};

/** JS injected into every frame to make modal dialogs non-blocking. */
const DIALOG_SHIM =
  'window.alert = (m) => console.log("[harness] alert suppressed: " + m);' +
  'window.confirm = () => true;' +
  'window.prompt = () => null;';

/**
 * Launch a window, run assertions, print a verdict, exit.
 *
 * @param {Object} config
 * @param {string} config.file                 HTML file under /public.
 * @param {Object} [config.query]              Query params for loadFile.
 * @param {Object} [config.handlers]           Extra/overriding IPC handlers.
 * @param {Object} [config.windowOptions]      BrowserWindow overrides.
 * @param {number} [config.settleMs=1600]      Wait after load before running.
 * @param {number} [config.timeoutMs=60000]    Hard watchdog.
 * @param {Function} config.run                async ({ win, check, js, emit, sleep }) => void
 */
function launch(config) {
  const {
    file,
    query = {},
    handlers = {},
    windowOptions = {},
    settleMs = 1600,
    timeoutMs = 60000,
    run,
  } = config;

  const merged = { ...DEFAULT_HANDLERS, ...handlers };
  Object.entries(merged).forEach(([channel, fn]) => {
    try {
      ipcMain.handle(channel, (...args) => fn(...args.slice(1)));
    } catch (_) {
      /* already registered */
    }
  });
  ipcMain.on('open-settings', () => {});

  // Anything not declared resolves null rather than throwing into an alert().
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.on('__never__', () => {});

  app.whenReady().then(async () => {
    const { registerWindowControlHandlers, getFramelessOptions } =
      require(path.join(REPO, 'src/main/window-controls.js'));
    registerWindowControlHandlers();

    const { registerDataEventBroadcast } = require(path.join(REPO, 'src/main/data-events.js'));
    registerDataEventBroadcast();

    const win = new BrowserWindow({
      width: 1400,
      height: 950,
      show: false,
      backgroundColor: '#1e1e2e',
      ...getFramelessOptions(),
      webPreferences: {
        preload: path.join(REPO, 'src/preload/preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        enableWebSQL: false,
        nodeIntegrationInSubFrames: true,
      },
      ...windowOptions,
    });

    // Suppress dialogs in the top frame AND in every subframe as it loads, so a
    // framed legacy view can never block the run.
    const killDialogs = () => {
      win.webContents.executeJavaScript(DIALOG_SHIM).catch(() => {});
    };
    win.webContents.on('did-frame-finish-load', () => killDialogs());
    win.webContents.on('dom-ready', killDialogs);

    // Belt and braces: refuse OS-level dialogs too.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const errors = [];
    win.webContents.on('console-message', (...a) => {
      const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : null;
      const level = d ? d.level : a[0];
      const msg = String(d ? d.message : a[2] || '');
      if ((level === 'error' || level === 3) && !/Autofill|devtools|ERR_/i.test(msg)) {
        errors.push(msg);
      }
    });

    // The run must always terminate, even if the page wedges.
    const watchdog = setTimeout(() => {
      console.log('[RESULT] ❌ TIMED OUT');
      app.exit(1);
    }, timeoutMs);

    const results = [];
    const check = (name, pass, extra) => results.push({ name, pass: !!pass, extra: extra || '' });
    const js = (code) => win.webContents.executeJavaScript(code);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const emit = (fn) => fn(require(path.join(REPO, 'src/main/data-events.js')));

    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(settleMs);
        await run({ win, check, js, sleep, emit, results });
      } catch (error) {
        console.log('  ❌ harness run threw: ' + error.message);
        check('harness completed', false, error.message);
      }

      clearTimeout(watchdog);

      let pass = 0;
      let fail = 0;
      results.forEach((r) => {
        console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
        r.pass ? pass++ : fail++;
      });
      if (errors.length) {
        console.log('\n  Console errors:');
        [...new Set(errors)].slice(0, 8).forEach((e) => console.log('    ! ' + e.slice(0, 150)));
      }
      const clean = fail === 0 && errors.length === 0;
      console.log(`\n[RESULT] ${clean ? '✅ ALL PASS' : '❌ ISSUES'} — ${pass} passed, ${fail} failed, ${errors.length} console errors`);
      app.exit(clean ? 0 : 1);
    });

    win.loadFile(path.join(REPO, 'public', file), { query });
  });

  app.on('window-all-closed', () => app.quit());
}

module.exports = { launch, DEFAULT_HANDLERS, DIALOG_SHIM };
