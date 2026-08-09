const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');

// Initialize portable mode detection FIRST (needed by error-logger)
const { detectPortableMode, isPortable, getDataPath } = require('./portable-mode');
detectPortableMode();

// Initialize error logging SECOND, before any other code runs
const { initializeLogging, logError, logInfo, setStartupPhase, getLogFilePath, getLogDirectory, collectDiagnostics } = require('./error-logger');
initializeLogging();

// Log portable mode status
logInfo('App', `Running in ${isPortable() ? 'PORTABLE' : 'INSTALLED'} mode`);
if (isPortable()) {
  logInfo('App', `Data directory: ${getDataPath()}`);
}

const { registerWindowControlHandlers, getFramelessOptions, trackWindowChrome } = require('./window-controls');
const { initAutoUpdater, checkForUpdates } = require('./auto-updater');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');
const { runStartupChecks } = require('./startup-manager');
const { createWizardWindow } = require('./wizard-window');
const { fetchServerStatus, getLastServerStatusFetchTime } = require('./esi-server-status');

/**
 * Show a native error dialog for fatal errors that occur before any window is displayed
 * @param {Error} error - The error that occurred
 * @param {string} context - Where the error occurred
 */
function showFatalErrorDialog(error, context) {
  const logPath = getLogFilePath();
  const logDir = getLogDirectory();

  const result = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Quantum Forge - Startup Error',
    message: 'The application encountered a fatal error during startup.',
    detail: `Error: ${error.message}\n\nA log file has been created at:\n${logPath}\n\nTo report this issue:\n1. Click "Open Log Folder" below\n2. Visit github.com/NoirSoldats/QuantumForge/issues\n3. Create a new issue and attach the log file`,
    buttons: ['Open Log Folder', 'Exit'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result === 0) {
    // Open the log folder
    shell.openPath(logDir);
  }

  app.exit(1);
}

// Global error handlers for main process
process.on('uncaughtException', (error) => {
  logError('uncaughtException', error);

  // If no windows exist, show native dialog
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    showFatalErrorDialog(error, 'uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError('unhandledRejection', error);

  // If no windows exist, show native dialog
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    showFatalErrorDialog(error, 'unhandledRejection');
  }
});
const {
  loadSettings,
  saveSettings,
  updateSettings,
  getSetting,
  resetSettings,
  getSettingsFilePath,
  addCharacter,
  removeCharacter,
  updateCharacterTokens,
  getCharacters,
  getCharacter,
  updateCharacterSkills,
  getSkillsCacheStatus,
  setSkillOverride,
  getEffectiveSkillLevel,
  clearSkillOverrides,
  setDefaultCharacter,
  getDefaultCharacter,
  clearDefaultCharacter,
  updateCharacterBlueprints,
  addManualBlueprint,
  removeBlueprint,
  setBlueprintOverride,
  getBlueprints,
  getEffectiveBlueprintValues,
  getBlueprintsCacheStatus,
  getMarketSets,
  getDefaultMarketSet,
  getMarketSetById,
  addMarketSet,
  updateMarketSet,
  deleteMarketSet,
  setDefaultMarketSet,
  getToolMarketSetId,
  setToolMarketSetId,
  resolveMarketSetForTool,
  getManufacturingFacilities,
  addManufacturingFacility,
  updateManufacturingFacility,
  removeManufacturingFacility,
  getManufacturingFacility,
  getCharacterDivisionSettings,
  updateCharacterEnabledDivisions,
  updateCharacterDivisionNames,
  getDivisionNamesCacheStatus,
  getDefaultManufacturingCharacters,
  setDefaultManufacturingCharacters,
} = require('./settings-manager');
const { authenticateWithESI, refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { fetchCorporationDivisions, getGenericDivisionName } = require('./esi-divisions');
const { fetchCharacterSkills } = require('./esi-skills');
const { fetchCharacterBlueprints } = require('./esi-blueprints');
const { fetchCharacterAssets, fetchCorporationAssets, saveAssets, getAssets, getAssetsCacheStatus } = require('./esi-assets');
const { fetchCharacterIndustryJobs, fetchCorporationIndustryJobs, saveIndustryJobs, getIndustryJobs, getIndustryJobsCacheStatus } = require('./esi-industry-jobs');
const { fetchCharacterWalletTransactions, saveWalletTransactions, getWalletTransactions, getWalletTransactionsCacheStatus } = require('./esi-wallet');
const {
  createManufacturingPlan,
  getManufacturingPlan,
  getManufacturingPlans,
  updateManufacturingPlan,
  deleteManufacturingPlan,
  getPlanIndustrySettings,
  updatePlanIndustrySettings,
  updatePlanCharacterDivisions,
  addBlueprintToPlan,
  updatePlanBlueprint,
  bulkUpdateBlueprints,
  removeBlueprintFromPlan,
  getPlanBlueprints,
  getIntermediateBlueprints,
  getAllPlanIntermediates,
  updateIntermediateBlueprint,
  markIntermediateBuilt,
  recalculatePlanMaterials,
  getPlanMaterials,
  getPlanProducts,
  getPlanSummary,
  refreshActivePlansESIData,
  getPlanAnalytics,
  markMaterialAcquired,
  unmarkMaterialAcquired,
  updateMaterialAcquisition,
  updateMaterialCustomPrice,
  setPlanPriceOverride,
  removePlanPriceOverride,
  getPlanPriceOverrides,
  cleanupExcessAcquisitions,
  getAcquisitionLog,
  getMaterialTree,
} = require('./manufacturing-plans');
const {
  matchJobsToPlan,
  saveJobMatches,
  matchTransactionsToPlan,
  saveTransactionMatches,
  confirmJobMatch,
  rejectJobMatch,
  confirmTransactionMatch,
  rejectTransactionMatch,
  getPendingMatches,
  getPlanActuals,
  getConfirmedJobMatches,
  unlinkJobMatch,
  getConfirmedTransactionMatches,
  unlinkTransactionMatch,
} = require('./plan-matching');
const {
  getCurrentVersion,
  getLatestVersion,
  checkUpdateRequired,
  downloadSDE,
  getSdePath,
  sdeExists,
  deleteSDE,
  getSdeSource,
  setSdeSource,
  MINIMUM_SDE_VERSION,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
} = require('./sde-manager');
const {
  getSkillName,
  getSkillNames,
  getAllSkills,
  getSkillGroup,
  searchSkills,
  getBlueprintName,
  getBlueprintNames,
  getAllBlueprints,
  searchBlueprints,
  getAllRegions,
  getAllSystems,
  searchSystems,
  getStationsInSystem,
  getTradeHubs,
  getStructureTypes,
  getStructureRigs,
  getStructureBonuses,
  getRigEffects,
  searchItemsByExactName,
  getReprocessingMaterials,
} = require('./sde-database');
const { initializeMarketDatabase, getMarketDatabase } = require('./market-database');
const marketWatchlists = require('./market-watchlists');
const { createAuthErrorWindow, setupAuthErrorWindowHandlers, broadcastAuthError, buildAuthErrorInfo } = require('./auth-error-window');
const { initializeESIStatusDatabase } = require('./esi-status-tracker');
const { startBackgroundRefresh, stopBackgroundRefresh, runRefreshCycle, getGlobalRefreshStatus } = require('./esi-background-refresh');
const { fetchMarketOrders, fetchMarketHistory, fetchMarketData, getLastMarketFetchTime, getLastHistoryFetchTime, getHistoryDataStatus, manualRefreshMarketData, manualRefreshHistoryData, getCachedMarketHistory } = require('./esi-market');
const { parseLootText, getTypeSpecificSkillId, calculateReprocessingYield, calculateReprocessingValue } = require('./reprocessing-calculator');
const { fetchCostIndices, getCostIndices, getAllCostIndices, getLastCostIndicesFetchTime, getCostIndicesSystemCount } = require('./esi-cost-indices');
const { fetchFuzzworkHistory, fetchJitaPrice, fetchBulkPrices } = require('./fuzzwork-market');
const {
  calculateRealisticPrice,
  getPriceOverride,
  setPriceOverride,
  removePriceOverride,
  getAllPriceOverrides,
} = require('./market-pricing');

let mainWindow;

/**
 * Create splash screen window
 */
/**
 * Splash width. The card fills the window edge to edge, so this IS the card
 * width - there is no page padding around it.
 */
const SPLASH_WIDTH = 460;

/**
 * Starting height, in CONTENT pixels.
 *
 * The renderer measures the card and calls `startup:fitToContent` as soon as it
 * has laid out, so this only governs the first frame. It is set to the card's
 * measured height in its OPENING state - five task rows, since the SDE download
 * row appears only when there is a download - so the window does not visibly
 * jump the moment it becomes visible.
 */
const SPLASH_INITIAL_HEIGHT = 534;

function createSplashWindow() {
  const splashWindow = new BrowserWindow({
    // The window is sized to its CONTENT, not the other way round: the card's
    // height changes as startup progresses (the SDE row appears only when there
    // is a download; the action and error panels replace the task list), and a
    // fixed window left a visible margin around the smaller states.
    //
    // Deliberately NOT tracked in windowStates: it is unresizable and always
    // centred, so there is no user choice to remember - and a remembered size
    // would fight the next redesign exactly as the old 700x650 did.
    width: SPLASH_WIDTH,
    height: SPLASH_INITIAL_HEIGHT,
    useContentSize: true, // heights below are CONTENT, ignoring any frame
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: 'Loading Quantum Forge',
    backgroundColor: '#1e1e2e',
  });

  // Registered before the page loads, so the renderer's first fit call - which
  // fires as soon as it has laid out - can never arrive before the handler.
  registerSplashResizeHandler();

  splashWindow.loadFile(path.join(__dirname, '../../public/splash.html'));

  return splashWindow;
}

/**
 * Resize the splash to fit its content, keeping it centred.
 *
 * Registered once, not per-window: the splash is a singleton and the sender is
 * resolved from the event, so a stale handler can never target the wrong
 * window.
 *
 * Growing a centred window only moves its bottom edge, so it drifts upward off
 * centre as content is added. Re-centring after each resize keeps it put.
 */
let splashResizeHandlerRegistered = false;

function registerSplashResizeHandler() {
  // `ipcMain.handle` THROWS on a duplicate channel, and the splash can be
  // created more than once in a session (first-launch wizard, then normal
  // startup).
  if (splashResizeHandlerRegistered) return;
  splashResizeHandlerRegistered = true;

  ipcMain.handle('startup:fitToContent', (event, contentHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;

    const height = Math.round(Number(contentHeight));
    if (!Number.isFinite(height) || height <= 0) return false;

    // Never grow past the work area of the display it is on - a tall error
    // state on a small screen must stay reachable rather than run off it.
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(win.getBounds());
    const maxHeight = display.workArea.height - 40;
    const clamped = Math.min(height, maxHeight);

    const [, currentHeight] = win.getContentSize();
    // A 1px jitter between measurements would otherwise cause an endless
    // resize/re-measure loop.
    if (Math.abs(currentHeight - clamped) <= 2) return true;

    win.setContentSize(SPLASH_WIDTH, clamped);
    win.center();
    return true;
  });
}

function createWindow() {
  const windowBounds = getWindowBounds('main', { width: 1300, height: 800 });
  const version = app.getVersion();

  mainWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    ...getFramelessOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Quantum Forge v${version}`,
  });

  // Track window state changes
  trackWindowState(mainWindow, 'main');
  // Push maximize/restore state so the custom title bar can swap its glyph.
  trackWindowChrome(mainWindow);

  // Show window when ready to prevent white screen
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the index.html
  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'), {
    query: { role: 'main' },
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Add keyboard shortcut to open DevTools in production (for debugging)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Monitor renderer process crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer process gone:', details);
    dialog.showErrorBox(
      'Application Error',
      `The renderer process has crashed.\nReason: ${details.reason}\n\nThe application will attempt to reload.`
    );
    mainWindow.reload();
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.error('Renderer process is unresponsive');
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Application Not Responding',
      message: 'The application is not responding. Would you like to wait or reload?',
      buttons: ['Wait', 'Reload'],
      defaultId: 0,
      cancelId: 0
    }).then(result => {
      if (result.response === 1) {
        mainWindow.reload();
      }
    });
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('Renderer process is responsive again');
  });

  // No close guard: every Market edit (overrides, favourites, watchlists,
  // market sets) commits immediately via IPC, so there is no in-memory state a
  // close could discard. The old guard sniffed for a `market.html` frame; that
  // page no longer exists, so the guard could never fire and was removed.

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Quit the app when main window is closed on all platforms
    app.quit();
  });

  // Initialize auto-updater after window is created
  initAutoUpdater(mainWindow);
}

app.whenReady().then(async () => {
  try {
    setStartupPhase('app-ready');
    logInfo('App', 'Application ready');
    console.log('[App] Application ready');

    // Run config migration BEFORE anything else
    setStartupPhase('config-migration');
    const { needsConfigMigration, migrateConfigFiles } = require('./config-migration');
    if (needsConfigMigration()) {
      console.log('[App] Running config migration...');
      await migrateConfigFiles();
      console.log('[App] Config migration complete');
    }

    // Initialize character database
    setStartupPhase('database-init');
    const { initializeCharacterDatabase } = require('./character-database');
    initializeCharacterDatabase();

    // Initialize ESI status database
    initializeESIStatusDatabase();

    // Run database schema migrations (must run AFTER database initialization)
    setStartupPhase('schema-migration');
    const { needsSchemaMigrations, runSchemaMigrations } = require('./database-schema-migrations');
    if (needsSchemaMigrations()) {
      console.log('[App] Running database schema migrations...');
      try {
        await runSchemaMigrations();
        console.log('[App] Database schema migrations complete');
      } catch (error) {
        // A failed migration leaves the schema in a state the app's queries do
        // not expect. Continuing risks writing bad data on top of it, so this
        // is unconditionally fatal - unlike the generic startup handler, which
        // only surfaces a dialog when no window exists (a splash window is up
        // by this point, so that check would silently swallow this).
        logError('schema-migration', error);
        showFatalErrorDialog(error, 'schema-migration');
        return; // showFatalErrorDialog calls app.exit(1)
      }
    }

    // Run character data migration (JSON to SQLite)
    setStartupPhase('character-data-migration');
    const { needsCharacterDataMigration, migrateCharacterDataToSqlite } = require('./character-data-migration');
    if (needsCharacterDataMigration()) {
      console.log('[App] Running character data migration...');
      await migrateCharacterDataToSqlite();
      console.log('[App] Character data migration complete');
    }

    // Migrate global division settings to per-character settings
    setStartupPhase('division-settings-migration');
    const { migrateGlobalDivisionsToCharacters, migrateAutoUpdateCharacterDataSetting } = require('./settings-manager');
    console.log('[App] Running division settings migration...');
    migrateGlobalDivisionsToCharacters();

    // Migrate auto-update character data setting from boolean to object
    console.log('[App] Running auto-update setting migration...');
    migrateAutoUpdateCharacterDataSetting();

    // Migrate existing plans to have industry settings
    setStartupPhase('plan-settings-migration');
    const { migrateExistingPlansToSettings } = require('./character-database');
    console.log('[App] Running plan industry settings migration...');
    migrateExistingPlansToSettings();

    // Setup IPC handlers first (needed by both wizard and normal app)
    setStartupPhase('ipc-handlers');
    setupIPCHandlers();
    setupAuthErrorWindowHandlers();

    // Check if this is the first launch
    setStartupPhase('first-launch-check');
    const fs = require('fs');
    const settingsFilePath = getSettingsFilePath();
    const configFileExists = fs.existsSync(settingsFilePath);

    const settings = loadSettings();
    const isFirstLaunch = !settings.general.firstLaunchCompleted;

    const { setAuditEnabled } = require('./audit-recorder');
    setAuditEnabled(settings.general.auditModeEnabled);

    // If config file exists but doesn't have firstLaunchCompleted flag, this is an existing installation
    // Skip wizard and mark as completed
    if (configFileExists && isFirstLaunch) {
      console.log('[App] Existing config detected without firstLaunchCompleted flag, migrating...');
      updateSettings('general', {
          "firstLaunchCompleted": true,
          "wizardVersion": "1.0",
          "wizardCompletedAt": new Date().toISOString()
      })
      console.log('[App] Migration complete, proceeding with normal startup');
      setStartupPhase('normal-startup');
      await startNormalApplication();
      return;
    }

    if (isFirstLaunch) {
      console.log('[App] First launch detected, showing wizard...');
      setStartupPhase('wizard');

      // Create wizard window
      const wizardWindow = createWizardWindow();

      // Wait for wizard to complete
      return new Promise((resolve) => {
        // Listen for wizard completion or window close
        wizardWindow.once('closed', async () => {
          console.log('[App] Wizard closed, continuing with normal startup...');

          // Check if wizard was completed
          const updatedSettings = loadSettings();
          if (updatedSettings.general.firstLaunchCompleted) {
            // Wizard completed successfully, proceed with normal startup
            setStartupPhase('normal-startup');
            await startNormalApplication();
          } else {
            // Wizard was closed without completing - exit app
            console.log('[App] Wizard incomplete, exiting application');
            app.quit();
          }
          resolve();
        });
      });
    } else {
      // Normal startup (not first launch)
      console.log('[App] Normal startup, creating splash screen...');
      setStartupPhase('normal-startup');
      await startNormalApplication();
    }
  } catch (error) {
    logError('app.whenReady', error);

    // If no windows exist, show native dialog
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      showFatalErrorDialog(error, 'app.whenReady');
    }
  }
});

// Normal application startup with splash screen
async function startNormalApplication() {
  // Create splash window first
  const splashWindow = createSplashWindow();

  // Wait for splash window to load before running checks
  splashWindow.webContents.once('did-finish-load', async () => {
    console.log('[App] Splash window loaded, running startup checks...');

    // Run all startup checks
    const success = await runStartupChecks(splashWindow);

    if (success) {
      // Startup completed successfully, create main window
      console.log('[App] Startup checks complete, creating main window...');

      // Small delay to show completion message
      await new Promise(resolve => setTimeout(resolve, 500));

      // Create main window
      createWindow();

      // Start the global ESI background refresh cycle now that the DB and
      // characters are initialized. Fetch-only; per-endpoint gating decides
      // what actually hits the network each tick.
      try {
        startBackgroundRefresh();
      } catch (err) {
        console.error('[App] Failed to start background ESI refresh:', err);
      }

      // Close splash window after main window is visible
      mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        splashWindow.close();
      });
    } else {
      console.error('[App] Startup checks failed');
      // Splash window will show error UI, user can retry or exit
    }
  });
}

// Setup all IPC handlers
function setupIPCHandlers() {
  // Window controls for the custom frameless title bar
  registerWindowControlHandlers();

  // Forward data-change events to every renderer frame, so screens can react to
  // fresh data instead of only reading it at load time.
  const { registerDataEventBroadcast } = require('./data-events');
  registerDataEventBroadcast();

  // Handle IPC for opening settings
  // Settings mounts in the MAIN window's view pane rather than opening its own
  // window. Callers can be anywhere - a framed legacy tool, or a separate
  // window like the Audit Log - so route the main window and focus it.
  // Settings is a view in the main window - there is no Settings window. The
  // request may originate from a framed tool or another window, so route it to
  // the main window's shell router.
  ipcMain.on('open-settings', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // Per-frame: only the top frame hosts the router.
    const { sendToWindow } = require('./broadcast');
    sendToWindow(mainWindow, 'shell:showView', { view: 'settings' });
  });

  // Audit Mode
  ipcMain.handle('audit:openWindow', () => {
    // Standalone shell view: the generic host every own-window screen uses.
    const { openViewWindow } = require('./view-window');
    openViewWindow('audit-log', {}, {
      title: 'Audit Log',
      defaults: { width: 1100, height: 700 },
    });
  });

  ipcMain.handle('audit:getRecords', async (event, filters) => {
    // Records hold type IDs only; names are resolved here in one batched SDE
    // query rather than at each of the recorder's hot call sites.
    const { getRecords, withTypeNames } = require('./audit-recorder');
    return withTypeNames(getRecords(filters));
  });

  ipcMain.handle('audit:clearRecords', () => {
    const { clearRecords } = require('./audit-recorder');
    clearRecords();
  });

  ipcMain.handle('audit:getSummary', () => {
    const { getSummary } = require('./audit-recorder');
    return getSummary();
  });

  // Handle IPC for settings operations
  ipcMain.handle('settings:load', () => {
    return loadSettings();
  });

  ipcMain.handle('settings:save', (event, settings) => {
    return saveSettings(settings);
  });

  ipcMain.handle('settings:update', (event, category, updates) => {
    const result = updateSettings(category, updates);
    if (category === 'general' && Object.prototype.hasOwnProperty.call(updates, 'auditModeEnabled')) {
      const { setAuditEnabled } = require('./audit-recorder');
      setAuditEnabled(updates.auditModeEnabled);
    }
    // Every settings write funnels through here, so one emit covers the app.
    // Without it a screen showing a setting's state can only poll for it.
    const { emitSettingsChanged } = require('./data-events');
    emitSettingsChanged({ category, updates });
    return result;
  });

  ipcMain.handle('settings:get', (event, category, key) => {
    return getSetting(category, key);
  });

  ipcMain.handle('settings:reset', () => {
    return resetSettings();
  });

  ipcMain.handle('settings:getPath', () => {
    return getSettingsFilePath();
  });

  // Handle IPC for ESI authentication
  ipcMain.handle('esi:authenticate', async () => {
    try {
      const authResult = await authenticateWithESI();
      const success = addCharacter(authResult);
      if (success) {
        return { success: true, character: authResult.character };
      } else {
        throw new Error('Failed to save character');
      }
    } catch (error) {
      console.error('ESI authentication error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('esi:getCharacters', () => {
    return getCharacters();
  });

  ipcMain.handle('esi:removeCharacter', (event, characterId) => {
    return removeCharacter(characterId);
  });

  ipcMain.handle('esi:refreshToken', async (event, characterId) => {
    try {
      const character = getCharacter(characterId);
      if (!character) {
        throw new Error('Character not found');
      }

      const newTokens = await refreshAccessToken(character.refreshToken);
      const success = updateCharacterTokens(characterId, newTokens);

      if (success) {
        return { success: true, tokens: newTokens };
      } else {
        throw new Error('Failed to update tokens');
      }
    } catch (error) {
      console.error('Token refresh error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('esi:getCharacter', (event, characterId) => {
    return getCharacter(characterId);
  });

  // Corporation names are not stored anywhere, so every screen that wanted
  // one fell back to "Corporation <id>". Session-cached; at most one ESI call
  // per corporation.
  ipcMain.handle('esi:resolveCorporationNames', async (event, corporationIds) => {
    const { resolveCorporationNames } = require('./esi-corporations');
    return await resolveCorporationNames(corporationIds);
  });

  ipcMain.handle('esi:setDefaultCharacter', (event, characterId) => {
    const result = setDefaultCharacter(characterId);
    if (result && mainWindow && !mainWindow.isDestroyed()) {
      // Notify main window to refresh avatar
      mainWindow.webContents.send('default-character-changed');
    }
    return result;
  });

  ipcMain.handle('esi:getDefaultCharacter', () => {
    return getDefaultCharacter();
  });

  ipcMain.handle('esi:clearDefaultCharacter', () => {
    const result = clearDefaultCharacter();
    if (result && mainWindow && !mainWindow.isDestroyed()) {
      // Notify main window to refresh avatar
      mainWindow.webContents.send('default-character-changed');
    }
    return result;
  });

  ipcMain.handle('esi:checkMissingScopes', (event, characterId) => {
    const { ESI_CONFIG } = require('./esi-auth');
    const character = getCharacter(characterId);
    if (!character) return { missing: [], characterName: '' };
    const granted = character.scopes || [];
    const missing = ESI_CONFIG.scopes.filter(s => !granted.includes(s));
    return { missing, characterName: character.characterName };
  });

  ipcMain.handle('esi:openAuthErrorWindow', (event, errorInfo) => {
    broadcastAuthError(errorInfo);
  });

  // Server Status IPC Handlers
  ipcMain.handle('status:fetch', async () => {
    return await fetchServerStatus();
  });

  // Read-only: never triggers an ESI call. Footers use this so opening a
  // window does not cost a fetch - the background cycle owns fetching.
  ipcMain.handle('status:getCached', () => {
    const { getCachedServerStatus } = require('./esi-server-status');
    return getCachedServerStatus();
  });

  ipcMain.handle('status:getLastFetchTime', () => {
    return getLastServerStatusFetchTime();
  });

  // ESI Status Monitoring IPC Handlers
  ipcMain.handle('esiStatus:openWindow', () => {
    // Standalone shell view: same generic host every other own-window screen
    // uses, so there is no per-screen window module to keep in step.
    const { openViewWindow } = require('./view-window');
    openViewWindow('esi-status', {}, {
      title: 'ESI Status',
      defaults: { width: 1200, height: 750 },
    });
  });

  ipcMain.handle('esiStatus:getAggregated', () => {
    const { getAggregatedStatus } = require('./esi-status-tracker');
    return getAggregatedStatus();
  });

  ipcMain.handle('esiStatus:initializeCharacter', (event, characterId, characterName) => {
    const { initializeCharacterEndpoints } = require('./esi-status-tracker');
    return initializeCharacterEndpoints(characterId, characterName);
  });

  ipcMain.handle('esiStatus:initializeUniverse', () => {
    const { initializeUniverseEndpoints } = require('./esi-status-tracker');
    return initializeUniverseEndpoints();
  });

  ipcMain.handle('esiStatus:getCharacterCalls', (event, characterId) => {
    const { getAllCharacterCallStatuses } = require('./esi-status-tracker');
    return getAllCharacterCallStatuses(characterId);
  });

  ipcMain.handle('esiStatus:getUniverseCalls', () => {
    const { getAllUniverseCallStatuses } = require('./esi-status-tracker');
    return getAllUniverseCallStatuses();
  });

  ipcMain.handle('esiStatus:getCallDetails', (event, callKey) => {
    const { getESICallStatus, getCallHistory } = require('./esi-status-tracker');
    return {
      status: getESICallStatus(callKey),
      history: getCallHistory(callKey, 10)
    };
  });

  ipcMain.handle('esiStatus:cleanup', () => {
    const { cleanupOldHistory } = require('./esi-status-tracker');
    return cleanupOldHistory(7);
  });

  // Blueprint source settings - a SEPARATE axis from the asset divisions.
  // These never write the asset columns and vice versa.
  ipcMain.handle('divisions:getBlueprintSettings', (event, characterId) => {
    const { getCharacterBlueprintSettings } = require('./settings-manager');
    return getCharacterBlueprintSettings(characterId);
  });

  ipcMain.handle('divisions:updateBlueprintDivisions', (event, characterId, divisions) => {
    const { setBlueprintEnabledDivisions } = require('./settings-manager');
    return setBlueprintEnabledDivisions(characterId, divisions);
  });

  ipcMain.handle('divisions:setUseBlueprintsFrom', (event, characterId, enabled) => {
    const { setUseBlueprintsFrom } = require('./settings-manager');
    return setUseBlueprintsFrom(characterId, enabled);
  });

  // Character Division Settings IPC Handlers
  ipcMain.handle('divisions:getSettings', async (event, characterId) => {
    try {
      return getCharacterDivisionSettings(characterId);
    } catch (error) {
      console.error('Error getting character division settings:', error);
      return { enabledDivisions: [], divisionNames: {}, hasCustomNames: false };
    }
  });

  ipcMain.handle('divisions:updateEnabled', async (event, characterId, enabledDivisions) => {
    try {
      return updateCharacterEnabledDivisions(characterId, enabledDivisions);
    } catch (error) {
      console.error('Error updating character enabled divisions:', error);
      return false;
    }
  });

  ipcMain.handle('divisions:fetchNames', async (event, characterId) => {
    try {
      const character = getCharacter(characterId);
      if (!character || !character.corporationId) {
        return {
          success: false,
          error: 'Character not found or not in corporation'
        };
      }

      const divisionData = await fetchCorporationDivisions(characterId, character.corporationId);

      if (divisionData.error) {
        return {
          success: false,
          error: divisionData.error,
          hasScope: divisionData.hasScope
        };
      }

      // Save to database
      const saved = updateCharacterDivisionNames(characterId, divisionData);

      return {
        success: saved,
        hasScope: divisionData.hasScope,
        divisions: divisionData.divisions,
      };
    } catch (error) {
      console.error('Error fetching division names:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      return { success: false, error: error.message, hasScope: false };
    }
  });

  ipcMain.handle('divisions:getCacheStatus', async (event, characterId) => {
    try {
      return getDivisionNamesCacheStatus(characterId);
    } catch (error) {
      console.error('Error getting division names cache status:', error);
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }
  });

  ipcMain.handle('divisions:getGenericName', async (event, divisionId) => {
    return getGenericDivisionName(divisionId);
  });

  // Default manufacturing characters
  ipcMain.handle('industry:getDefaultManufacturingCharacters', async () => {
    return getDefaultManufacturingCharacters();
  });

  ipcMain.handle('industry:setDefaultManufacturingCharacters', async (event, characterIds) => {
    return setDefaultManufacturingCharacters(characterIds);
  });

  // Handle IPC for SDE management
  ipcMain.handle('sde:checkUpdate', async () => {
    try {
      const status = await checkUpdateRequired();
      const source = getSdeSource();
      return { ...status, source };
    } catch (error) {
      console.error('SDE check update error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('sde:download', async (event) => {
    try {
      await downloadSDE((progress) => {
        event.sender.send('sde:progress', progress);
      });
      return { success: true };
    } catch (error) {
      console.error('SDE download error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('sde:downloadAndValidate', async (event) => {
    try {
      const { downloadAndValidateSDE } = require('./sde-manager');
      const result = await downloadAndValidateSDE((progress) => {
        event.sender.send('sde:progress', progress);
      });

      // If successful, save validation status to settings
      if (result.success) {
        const { updateSettings } = require('./settings-manager');
        const { getCurrentVersion } = require('./sde-manager');
        updateSettings('sde', {
          validationStatus: {
            passed: result.validationResults.passed,
            sdeVersion: getCurrentVersion(),
            date: new Date().toISOString(),
            summary: result.validationResults.summary,
            totalChecks: result.validationResults.totalChecks,
          },
        });
      }

      return result;
    } catch (error) {
      console.error('SDE download and validate error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('sde:validateCurrent', async () => {
    try {
      const { validateCurrentSDE } = require('./sde-manager');
      const result = await validateCurrentSDE();

      // Save validation status to settings
      const { updateSettings } = require('./settings-manager');
      const { getCurrentVersion } = require('./sde-manager');
      updateSettings('sde', {
        validationStatus: {
          passed: result.passed,
          sdeVersion: getCurrentVersion(),
          date: new Date().toISOString(),
          summary: result.summary || result.error || 'Validation completed',
          totalChecks: result.totalChecks || 0,
        },
      });

      return result;
    } catch (error) {
      console.error('SDE validation error:', error);
      return { passed: false, error: error.message };
    }
  });

  ipcMain.handle('sde:restoreBackup', () => {
    try {
      const { restorePreviousSDE } = require('./sde-manager');
      const success = restorePreviousSDE();

      if (success) {
        // Clear validation status after restore
        const { updateSettings } = require('./settings-manager');
        updateSettings('sde', {
          validationStatus: null,
        });
      }

      return { success };
    } catch (error) {
      console.error('SDE restore error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('sde:hasBackup', () => {
    try {
      const { hasBackup } = require('./sde-manager');
      return hasBackup();
    } catch (error) {
      console.error('SDE hasBackup error:', error);
      return false;
    }
  });

  ipcMain.handle('sde:getBackupVersion', () => {
    try {
      const { getBackupVersion } = require('./sde-manager');
      return getBackupVersion();
    } catch (error) {
      console.error('SDE getBackupVersion error:', error);
      return null;
    }
  });

  ipcMain.handle('sde:getCurrentVersion', () => {
    return getCurrentVersion();
  });

  ipcMain.handle('sde:getLatestVersion', async () => {
    try {
      return await getLatestVersion();
    } catch (error) {
      console.error('Error getting latest SDE version:', error);
      return null;
    }
  });

  ipcMain.handle('sde:getMinimumVersion', () => {
    return MINIMUM_SDE_VERSION;
  });

  ipcMain.handle('sde:exists', () => {
    return sdeExists();
  });

  ipcMain.handle('sde:delete', () => {
    return deleteSDE();
  });

  ipcMain.handle('sde:getPath', () => {
    return getSdePath();
  });

  // Handle IPC for skills management
  ipcMain.handle('skills:fetch', async (event, characterId) => {
    try {
      const skillsData = await fetchCharacterSkills(characterId);

      // A gated fetch is not a failure and not a success - ESI was never
      // asked, so the stored skills are still the best data we have. Saying so
      // is what stops the caller reporting "refreshed" over unchanged data.
      if (skillsData.skipped) {
        return {
          success: true,
          skipped: true,
          reason: 'Skills were refreshed recently; ESI has nothing newer yet.',
        };
      }

      const success = updateCharacterSkills(characterId, skillsData);
      if (success) {
        return { success: true, skills: skillsData };
      } else {
        throw new Error('Failed to save skills');
      }
    } catch (error) {
      console.error('Skills fetch error:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('skills:setOverride', (event, characterId, skillId, level) => {
    return setSkillOverride(characterId, skillId, level);
  });

  ipcMain.handle('skills:getEffectiveLevel', (event, characterId, skillId) => {
    return getEffectiveSkillLevel(characterId, skillId);
  });

  ipcMain.handle('skills:clearOverrides', (event, characterId) => {
    return clearSkillOverrides(characterId);
  });

  ipcMain.handle('skills:getCacheStatus', (event, characterId) => {
    return getSkillsCacheStatus(characterId);
  });

  // No skills:openWindow handler: the Skills Manager is a native shell view,
  // opened via the generic window.openView('skills', { characterId }).

  // Handle IPC for blueprint management
  ipcMain.handle('blueprints:fetch', async (event, characterId) => {
    try {
      const blueprintsData = await fetchCharacterBlueprints(characterId);

      // Gated: ESI was never asked, so the stored blueprints are unchanged and
      // still correct. Reporting a plain success would claim a refresh that
      // did not happen. See the note in updateCharacterSkills.
      if (blueprintsData.skipped) {
        return {
          success: true,
          skipped: true,
          reason: 'Blueprints were refreshed recently; ESI has nothing newer yet.',
        };
      }

      const success = updateCharacterBlueprints(characterId, blueprintsData);
      if (success) {
        return { success: true, blueprints: blueprintsData };
      } else {
        throw new Error('Failed to save blueprints');
      }
    } catch (error) {
      console.error('Blueprints fetch error:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('blueprints:getAll', (event, characterId) => {
    return getBlueprints(characterId);
  });

  ipcMain.handle('blueprints:addManual', (event, blueprintData) => {
    return addManualBlueprint(blueprintData);
  });

  ipcMain.handle('blueprints:remove', (event, characterId, itemId) => {
    return removeBlueprint(characterId, itemId);
  });

  ipcMain.handle('blueprints:setOverride', (event, characterId, itemId, field, value) => {
    return setBlueprintOverride(characterId, itemId, field, value);
  });

  ipcMain.handle('blueprints:getEffectiveValues', (event, itemId) => {
    return getEffectiveBlueprintValues(itemId);
  });

  ipcMain.handle('blueprints:getCacheStatus', (event, characterId) => {
    return getBlueprintsCacheStatus(characterId);
  });

  // No blueprints:openWindow handler: the Blueprint Manager is a native shell
  // view, opened via the generic window.openView('blueprints', { characterId }).

  // Assets IPC Handlers
  ipcMain.handle('assets:fetch', async (event, characterId) => {
    try {
      // Fetch character assets. saveAssets refuses a gated payload, so a skip
      // cannot delete the stored assets - see the note in updateCharacterSkills.
      const characterAssetsData = await fetchCharacterAssets(characterId);
      saveAssets(characterAssetsData);

      // Fetch corporation assets if character is in a corp
      const character = getCharacter(characterId);
      let corporationAssetsData = null;
      if (character && character.corporationId) {
        corporationAssetsData = await fetchCorporationAssets(characterId, character.corporationId);
        saveAssets(corporationAssetsData);
      }

      // Only a refresh where NOTHING was fetched counts as skipped; a partial
      // one still updated something worth reloading for.
      const allSkipped = characterAssetsData.skipped
        && (!corporationAssetsData || corporationAssetsData.skipped);

      if (allSkipped) {
        return {
          success: true,
          skipped: true,
          reason: 'Assets were refreshed recently; ESI has nothing newer yet.',
        };
      }

      return { success: true };
    } catch (error) {
      console.error('Error fetching assets:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      throw error;
    }
  });

  ipcMain.handle('assets:get', (event, characterId, isCorporation) => {
    return getAssets(characterId, isCorporation);
  });

  ipcMain.handle('assets:getCacheStatus', (event, characterId, isCorporation) => {
    return getAssetsCacheStatus(characterId, isCorporation);
  });

  // Industry Jobs IPC Handlers
  ipcMain.handle('industryJobs:fetch', async (event, characterId, includeCompleted) => {
    try {
      const jobsData = await fetchCharacterIndustryJobs(characterId, includeCompleted);
      saveIndustryJobs(jobsData);
      return { success: true, count: jobsData.jobs.length };
    } catch (error) {
      console.error('Error fetching industry jobs:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      throw error;
    }
  });

  ipcMain.handle('industryJobs:get', (event, characterId, filters) => {
    return getIndustryJobs(characterId, filters);
  });

  ipcMain.handle('industryJobs:getCacheStatus', (event, characterId) => {
    return getIndustryJobsCacheStatus(characterId);
  });

  ipcMain.handle('industryJobs:fetchCorporation', async (event, characterId, corporationId, includeCompleted) => {
    try {
      const jobsData = await fetchCorporationIndustryJobs(characterId, corporationId, includeCompleted);
      if (jobsData.jobs && jobsData.jobs.length > 0) {
        saveIndustryJobs(jobsData);
      }
      return { success: true, count: jobsData.jobs.length };
    } catch (error) {
      console.error('Error fetching corporation industry jobs:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      throw error;
    }
  });

  // Wallet Transactions IPC Handlers
  ipcMain.handle('wallet:fetchTransactions', async (event, characterId, fromId) => {
    try {
      const transactionsData = await fetchCharacterWalletTransactions(characterId, fromId);
      saveWalletTransactions(transactionsData);
      return { success: true, count: transactionsData.transactions.length };
    } catch (error) {
      console.error('Error fetching wallet transactions:', error);
      if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
        broadcastAuthError(buildAuthErrorInfo(error, characterId));
      }
      throw error;
    }
  });

  ipcMain.handle('wallet:getTransactions', (event, characterId, filters) => {
    return getWalletTransactions(characterId, filters);
  });

  ipcMain.handle('wallet:getCacheStatus', (event, characterId) => {
    return getWalletTransactionsCacheStatus(characterId);
  });

  // Manufacturing Plans IPC Handlers
  ipcMain.handle('plans:create', (event, characterId, planName, description) => {
    return createManufacturingPlan(characterId, planName, description);
  });

  ipcMain.handle('plans:get', (event, planId) => {
    return getManufacturingPlan(planId);
  });

  ipcMain.handle('plans:getAll', (event, characterId, filters) => {
    return getManufacturingPlans(characterId, filters);
  });

  ipcMain.handle('plans:update', (event, planId, updates) => {
    return updateManufacturingPlan(planId, updates);
  });

  ipcMain.handle('plans:delete', (event, planId) => {
    return deleteManufacturingPlan(planId);
  });

  // Plan industry settings
  ipcMain.handle('plans:getIndustrySettings', async (event, planId) => {
    return getPlanIndustrySettings(planId);
  });

  ipcMain.handle('plans:updateIndustrySettings', async (event, planId, settings) => {
    return updatePlanIndustrySettings(planId, settings);
  });

  ipcMain.handle('plans:updateCharacterDivisions', async (event, planId, characterId, divisions) => {
    return updatePlanCharacterDivisions(planId, characterId, divisions);
  });

  ipcMain.handle('plans:updateCharacterBlueprintDivisions', (event, planId, characterId, divisions) => {
    const { updatePlanCharacterBlueprintDivisions } = require('./manufacturing-plans');
    return updatePlanCharacterBlueprintDivisions(planId, characterId, divisions);
  });

  ipcMain.handle('plans:addBlueprint', async (event, planId, blueprintConfig) => {
    return await addBlueprintToPlan(planId, blueprintConfig);
  });

  ipcMain.handle('plans:updateBlueprint', async (event, planBlueprintId, updates) => {
    return await updatePlanBlueprint(planBlueprintId, updates);
  });

  ipcMain.handle('plans:bulkUpdateBlueprints', async (event, planId, bulkUpdates) => {
    return await bulkUpdateBlueprints(planId, bulkUpdates);
  });

  ipcMain.handle('plans:removeBlueprint', async (event, planBlueprintId) => {
    return await removeBlueprintFromPlan(planBlueprintId);
  });

  ipcMain.handle('plans:getBlueprints', (event, planId) => {
    return getPlanBlueprints(planId);
  });

  // Intermediate blueprints handlers
  ipcMain.handle('plans:getIntermediateBlueprints', (event, planBlueprintId) => {
    return getIntermediateBlueprints(planBlueprintId);
  });

  ipcMain.handle('plans:getAllIntermediates', (event, planId) => {
    return getAllPlanIntermediates(planId);
  });

  ipcMain.handle('plans:updateIntermediateBlueprint', async (event, intermediateBlueprintId, updates) => {
    return await updateIntermediateBlueprint(intermediateBlueprintId, updates);
  });

  ipcMain.handle('plans:markIntermediateBuilt', async (event, intermediateBlueprintId, builtRuns) => {
    return await markIntermediateBuilt(intermediateBlueprintId, builtRuns);
  });

  // Reaction management in plans
  ipcMain.handle('plans:getReactions', async (event, planId) => {
    const { getReactions } = require('./manufacturing-plans');
    return await getReactions(planId);
  });

  ipcMain.handle('plans:setReactionChildBuildPlan', async (event, planId, reactionTypeId, childTypeId, buildPlan) => {
    const { setReactionChildBuildPlan } = require('./manufacturing-plans');
    return await setReactionChildBuildPlan(planId, reactionTypeId, childTypeId, buildPlan);
  });

  ipcMain.handle('plans:getBuildItems', async (event, planId) => {
    const { getPlanBuildItems } = require('./manufacturing-plans');
    return await getPlanBuildItems(planId);
  });

  ipcMain.handle('plans:updateBuildItemsByType', async (event, planId, itemType, blueprintTypeId, updates) => {
    const { updateBuildItemsByType } = require('./manufacturing-plans');
    return await updateBuildItemsByType(planId, itemType, blueprintTypeId, updates);
  });

  ipcMain.handle('plans:markReactionBuilt', async (event, planBlueprintId, builtRuns) => {
    const { markReactionBuilt } = require('./manufacturing-plans');
    return await markReactionBuilt(planBlueprintId, builtRuns);
  });

  ipcMain.handle('plans:calculateReactionTree', async (event, reactionBlueprintId, runs, characterId, facilityOrId, marketSetId) => {
    const { getReactionTreeForPlan } = require('./manufacturing-plans');

    // Accept either a facility snapshot object or a facilityId string/number, same as
    // reactions:calculateMaterials above
    let facility = null;
    if (facilityOrId) {
      if (typeof facilityOrId === 'object') {
        facility = facilityOrId;
      } else {
        const { getManufacturingFacility } = require('./settings-manager');
        facility = getManufacturingFacility(facilityOrId);
      }

      if (facility && facility.systemId) {
        const { getSystemSecurityStatus } = require('./sde-database');
        facility.securityStatus = await getSystemSecurityStatus(facility.systemId);
      }

      if (facility && facility.structureTypeId) {
        const { getStructureBonuses } = require('./sde-database');
        const bonuses = await getStructureBonuses(facility.structureTypeId);
        facility.structureBonuses = bonuses;
      }
    }

    const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
    return await getReactionTreeForPlan(reactionBlueprintId, runs, characterId, facility, marketSet);
  });

  ipcMain.handle('plans:getMaterials', async (event, planId, includeAssets) => {
    return await getPlanMaterials(planId, includeAssets);
  });

  // Live prices for drift DISPLAY only - never writes. The plan's cost basis
  // stays locked until an explicit "Re-lock Prices" (binding rule 7).
  ipcMain.handle('plans:getMaterialDrift', async (event, planId, marketSetId) => {
    const { getPlanMaterialDrift } = require('./manufacturing-plans');
    let marketSet = null;
    if (marketSetId) {
      const { getMarketSets } = require('./settings-manager');
      marketSet = (getMarketSets() || []).find(s => String(s.id) === String(marketSetId)) || null;
    }
    return await getPlanMaterialDrift(planId, marketSet);
  });

  ipcMain.handle('plans:getProducts', (event, planId) => {
    return getPlanProducts(planId);
  });

  ipcMain.handle('plans:getProductOwnedAssets', async (event, planId, typeId) => {
    const { getProductOwnedAssets } = require('./manufacturing-plans');
    return await getProductOwnedAssets(planId, typeId);
  });

  ipcMain.handle('plans:getSummary', async (event, planId) => {
    return await getPlanSummary(planId);
  });

  ipcMain.handle('plans:recalculateMaterials', async (event, planId, refreshPrices, marketSetId) => {
    const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
    if (!marketSet) throw new Error(`Market Set not found: ${marketSetId}`);
    return await recalculatePlanMaterials(planId, refreshPrices, marketSet);
  });

  // Legacy: character-based ESI refresh
  ipcMain.handle('plans:refreshESIData', async (event, characterId) => {
    return await refreshActivePlansESIData(characterId);
  });

  // New: plan-based ESI refresh
  ipcMain.handle('plans:refreshPlanESIData', async (event, planId) => {
    const { refreshPlanESIData } = require('./manufacturing-plans');
    const result = await refreshPlanESIData(planId);
    // Surface any token refresh failures that were caught internally
    if (result && result.errors && result.errors.length > 0) {
      for (const errEntry of result.errors) {
        if (errEntry && errEntry.error && errEntry.error.includes('Token refresh failed:')) {
          const charId = errEntry.characterId;
          if (charId) {
            const character = getCharacter(charId);
            broadcastAuthError({
              type: 'token_refresh_failed',
              characterId: charId,
              characterName: character ? character.characterName : `Character ${charId}`,
            });
          }
        }
      }
    }
    return result;
  });

  // Plan Matching Handlers
  ipcMain.handle('plans:matchJobs', (event, planId, options) => {
    return matchJobsToPlan(planId, options);
  });

  ipcMain.handle('plans:saveJobMatches', (event, matches) => {
    return saveJobMatches(matches);
  });

  ipcMain.handle('plans:matchTransactions', (event, planId, options) => {
    return matchTransactionsToPlan(planId, options);
  });

  ipcMain.handle('plans:saveTransactionMatches', (event, planId, matches) => {
    return saveTransactionMatches(planId, matches);
  });

  ipcMain.handle('plans:confirmJobMatch', (event, matchId) => {
    return confirmJobMatch(matchId);
  });

  ipcMain.handle('plans:rejectJobMatch', (event, matchId) => {
    return rejectJobMatch(matchId);
  });

  ipcMain.handle('plans:confirmTransactionMatch', (event, matchId) => {
    return confirmTransactionMatch(matchId);
  });

  ipcMain.handle('plans:rejectTransactionMatch', (event, matchId) => {
    return rejectTransactionMatch(matchId);
  });

  ipcMain.handle('plans:getPendingMatches', (event, planId) => {
    return getPendingMatches(planId);
  });

  ipcMain.handle('plans:getConfirmedJobMatches', (event, planId) => {
    return getConfirmedJobMatches(planId);
  });

  ipcMain.handle('plans:unlinkJobMatch', (event, matchId) => {
    return unlinkJobMatch(matchId);
  });

  ipcMain.handle('plans:getConfirmedTransactionMatches', (event, planId) => {
    return getConfirmedTransactionMatches(planId);
  });

  ipcMain.handle('plans:unlinkTransactionMatch', (event, matchId) => {
    return unlinkTransactionMatch(matchId);
  });

  ipcMain.handle('plans:getActuals', (event, planId) => {
    return getPlanActuals(planId);
  });

  ipcMain.handle('plans:getAnalytics', async (event, planId) => {
    return await getPlanAnalytics(planId);
  });

  // Material Acquisition Handlers
  ipcMain.handle('plans:markMaterialAcquired', (event, planId, typeId, options) => {
    return markMaterialAcquired(planId, typeId, options);
  });

  ipcMain.handle('plans:unmarkMaterialAcquired', (event, planId, typeId) => {
    return unmarkMaterialAcquired(planId, typeId);
  });

  ipcMain.handle('plans:updateMaterialAcquisition', (event, planId, typeId, updates) => {
    return updateMaterialAcquisition(planId, typeId, updates);
  });

  ipcMain.handle('plans:updateMaterialCustomPrice', (event, planId, typeId, customPrice) => {
    return updateMaterialCustomPrice(planId, typeId, customPrice);
  });

  ipcMain.handle('plans:setPriceOverride', (event, planId, typeId, price) => {
    return setPlanPriceOverride(planId, typeId, price);
  });

  ipcMain.handle('plans:removePriceOverride', (event, planId, typeId) => {
    return removePlanPriceOverride(planId, typeId);
  });

  ipcMain.handle('plans:getPriceOverrides', (event, planId) => {
    return getPlanPriceOverrides(planId);
  });

  ipcMain.handle('plans:cleanupExcessAcquisitions', (event, planId, typeId) => {
    return cleanupExcessAcquisitions(planId, typeId);
  });

  ipcMain.handle('plans:getAcquisitionLog', (event, planId, typeId) => {
    return getAcquisitionLog(planId, typeId);
  });

  ipcMain.handle('plans:getMaterialTree', async (event, planId, planBlueprintId) => {
    return getMaterialTree(planId, planBlueprintId || null);
  });

  ipcMain.handle('plans:getMaterialTreeNodeDetail', async (event, planBlueprintId) => {
    const { getMaterialTreeNodeDetail } = require('./manufacturing-plans');
    return getMaterialTreeNodeDetail(planBlueprintId);
  });

  // ── Ledger ──────────────────────────────────────────────────────────────────
  ipcMain.handle('plans:getLedger', async (event, planId) => {
    const { getPlanLedger } = require('./manufacturing-plans');
    return getPlanLedger(planId);
  });

  ipcMain.handle('plans:addLedgerCost', (event, planId, options) => {
    const { addManualLedgerCost } = require('./manufacturing-plans');
    return addManualLedgerCost(planId, options);
  });

  ipcMain.handle('plans:addItemAcquisition', async (event, planId, typeId, options) => {
    const { addManualItemAcquisition } = require('./manufacturing-plans');
    return addManualItemAcquisition(planId, typeId, options);
  });

  ipcMain.handle('plans:updateLedgerEntry', async (event, ledgerId, updates) => {
    const { updateLedgerEntry } = require('./manufacturing-plans');
    return updateLedgerEntry(ledgerId, updates);
  });

  ipcMain.handle('plans:deleteLedgerEntry', (event, ledgerId) => {
    const { deleteLedgerEntry } = require('./manufacturing-plans');
    return deleteLedgerEntry(ledgerId);
  });

  ipcMain.handle('plans:unlinkLedgerEntry', (event, planId, ledgerId) => {
    const { unlinkLedgerEntry } = require('./manufacturing-plans');
    return unlinkLedgerEntry(planId, ledgerId);
  });

  ipcMain.handle('plans:getTransactionDetail', (event, transactionId, isCorp) => {
    const { getTransactionDetail } = require('./manufacturing-plans');
    return getTransactionDetail(transactionId, isCorp);
  });

  ipcMain.handle('plans:getJournalDetail', (event, journalId, isCorp) => {
    const { getJournalDetail } = require('./manufacturing-plans');
    return getJournalDetail(journalId, isCorp);
  });

  // No manufacturingSummary:openWindow handler: the Manufacturing Summary is a
  // native shell view and mounts in the main window's content pane.

  // No cleanupTool:openWindow - What Can I Build? is a native shell view and
  // mounts in the main window's content pane.

  /**
   * Frames that have asked to stop their in-flight What Can I Build? run.
   * Keyed by webContents id so two windows cannot cancel each other.
   */
  const wcibCancellations = new Set();

  ipcMain.handle('wcib:calculate', async (event, options = {}) => {
    const runKey = event.sender.id;
    wcibCancellations.delete(runKey);

    try {
      const { calculate } = require('./what-can-i-build');
      const { withPriceCache } = require('./market-read-cache');

      // Same shape as the summary sweep: many blueprints, heavily overlapping
      // material lists, one session for the run.
      return await withPriceCache(() => calculate(
        options,
        (progress) => {
          // Sent to the CALLING frame only - two windows could each be
          // running, and a broadcast would cross their progress bars.
          try {
            if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send('wcib:progress', progress);
            }
          } catch (_) {
            /* the frame went away mid-run */
          }
        },
        () => wcibCancellations.has(runKey)
      ), 'what can i build');
    } catch (error) {
      // A user-requested stop is not a failure.
      if (error && error.cancelled) {
        return { cancelled: true, rows: [], assetTypeCount: 0 };
      }
      console.error('Error calculating buildable items:', error);
      throw new Error(error.message || 'Failed to calculate buildable items');
    } finally {
      wcibCancellations.delete(runKey);
    }
  });

  ipcMain.handle('wcib:cancel', (event) => {
    wcibCancellations.add(event.sender.id);
    return true;
  });

  ipcMain.handle('cleanupTool:getAssetSources', async () => {
    const { getAssetSources } = require('./cleanup-tool');
    return getAssetSources();
  });

  ipcMain.handle('cleanupTool:refreshAssets', async (event, characterIds) => {
    const { refreshAssets } = require('./cleanup-tool');
    return refreshAssets(characterIds);
  });

  ipcMain.handle('cleanupTool:aggregateAssets', (event, sources) => {
    const { aggregateAssets } = require('./cleanup-tool');
    return aggregateAssets(sources);
  });

  ipcMain.handle('blueprints:openInCalculator', (event, blueprintTypeId, meLevel) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.focus();

    // Ask the shell to show the calculator with the blueprint as a mount
    // parameter. The view reads it during mount, so there is no window in which
    // the event can arrive before a listener exists.
    //
    // This replaces a loadFile() + setTimeout(500) handoff: the old page had no
    // way to signal readiness, so the delay was a guess. On a slow start the
    // event landed before the renderer subscribed and the blueprint silently
    // never opened.
    mainWindow.webContents.send('shell:showView', {
      view: 'blueprint-calculator',
      params: { blueprintTypeId, meLevel },
    });
  });

  // Handle IPC for blueprint calculator
  const {
    searchBlueprints,
    calculateBlueprintMaterials,
    getBlueprintProduct,
    getTypeName
  } = require('./blueprint-calculator');

  ipcMain.handle('calculator:searchBlueprints', (event, searchTerm, limit) => {
    return searchBlueprints(searchTerm, limit);
  });

  ipcMain.handle('calculator:calculateMaterials', async (event, blueprintTypeId, runs, meLevel, characterId, facilityId, marketSetId) => {
    // Get facility if facilityId is provided
    let facility = null;
    if (facilityId) {
      const { getManufacturingFacility } = require('./settings-manager');
      facility = getManufacturingFacility(facilityId);

      // Get system security status from SDE if we have a systemId
      if (facility && facility.systemId) {
        const { getSystemSecurityStatus } = require('./sde-database');
        facility.securityStatus = await getSystemSecurityStatus(facility.systemId);
      }

      // Get structure bonuses if this is a player structure
      if (facility && facility.structureTypeId) {
        const { getStructureBonuses } = require('./sde-database');
        const bonuses = await getStructureBonuses(facility.structureTypeId);
        facility.structureBonuses = bonuses;
      }
    }

    const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
    return await calculateBlueprintMaterials(blueprintTypeId, runs, meLevel, characterId, facility, true, 0, null, marketSet);
  });

  ipcMain.handle('calculator:getBlueprintProduct', (event, blueprintTypeId) => {
    return getBlueprintProduct(blueprintTypeId);
  });

  ipcMain.handle('calculator:getTypeName', (event, typeId) => {
    return getTypeName(typeId);
  });

  // NOTE: `calculator:getOwnedBlueprintME` and the getOwnedBlueprintME helper
  // it wrapped are both gone. resolveOwnedBlueprint supersedes them: it returns
  // ME *and* TE plus which copy won, and distinguishes "owns an ME 0 blueprint"
  // from "owns nothing" - which the old number-only return could not.
  ipcMain.handle('calculator:resolveOwnedBlueprint', (event, blueprintTypeId) => {
    const { resolveOwnedBlueprint } = require('./blueprint-calculator');
    // Returns ME *and* TE plus which copy won, so the calculator can show
    // where a value came from instead of an unexplained number.
    return resolveOwnedBlueprint(blueprintTypeId);
  });

  ipcMain.handle('calculator:getRigBonuses', (event, rigTypeId) => {
    const { getRigBonusesFromSDE } = require('./rig-bonuses');
    return getRigBonusesFromSDE(rigTypeId);
  });

  ipcMain.handle('calculator:getAllBlueprints', (event, limit) => {
    const { getAllBlueprints } = require('./blueprint-calculator');
    return getAllBlueprints(limit);
  });

  ipcMain.handle('calculator:getAllReactions', (event, limit) => {
    const { getAllReactions } = require('./blueprint-calculator');
    return getAllReactions(limit);
  });

  // Invention IPC handlers
  ipcMain.handle('calculator:getInventionData', (event, blueprintTypeId) => {
    const { getInventionData } = require('./blueprint-calculator');
    return getInventionData(blueprintTypeId);
  });

  ipcMain.handle('calculator:getAllDecryptors', () => {
    const { getAllDecryptors } = require('./blueprint-calculator');
    return getAllDecryptors();
  });

  ipcMain.handle('calculator:getBlueprintMaterials', (event, blueprintTypeId) => {
    const { getBlueprintMaterials } = require('./blueprint-calculator');
    return getBlueprintMaterials(blueprintTypeId);
  });

  ipcMain.handle('calculator:calculateInventionProbability', (event, baseProbability, skills, decryptorMultiplier) => {
    const { calculateInventionProbability } = require('./blueprint-calculator');
    return calculateInventionProbability(baseProbability, skills, decryptorMultiplier);
  });

  ipcMain.handle('calculator:clearCaches', () => {
    const { clearMaterialCache } = require('./blueprint-calculator');
    clearMaterialCache();
    return { success: true };
  });

  ipcMain.handle('calculator:findBestDecryptor', async (event, inventionData, materialPrices, productPrice, skills, facility, optimizationStrategy, marketSetId) => {
    console.log('[IPC Handler] Received optimizationStrategy:', optimizationStrategy);

    const { findBestDecryptor, getDefaultFacility } = require('./blueprint-calculator');
    const { getMarketSetById, getDefaultMarketSet } = require('./settings-manager');

    // Use provided facility or fall back to default facility
    const facilityToUse = facility || getDefaultFacility();

    // Default optimization strategy if not provided
    const strategy = optimizationStrategy || 'total-per-item';

    // Resolve market set
    const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();

    console.log('[IPC Handler] Using strategy:', strategy);

    // One session for the whole sweep. The 9 decryptor options each price the
    // same material set twice (1 run and a full BPC - both genuinely needed,
    // since ME rounding is applied per run-batch and a 5-run batch is not 5x a
    // 1-run batch), so ~198 price calls read the same handful of order books.
    // The cache dies with this handler; it can never serve a later calculation.
    const { withPriceCache } = require('./market-read-cache');
    return await withPriceCache(
      () => findBestDecryptor(inventionData, materialPrices, productPrice, skills, facilityToUse, strategy, marketSet),
      'invention decryptor sweep'
    );
  });

  // ============================================================================
  // Reactions Calculator IPC Handlers
  // ============================================================================

  const {
    searchReactions,
    calculateReactionMaterials,
    getReactionProduct,
    getTypeName: getReactionTypeName,
    getReactionTime,
    clearReactionCache
  } = require('./reaction-calculator');

  ipcMain.handle('reactions:searchReactions', (event, searchTerm, limit) => {
    return searchReactions(searchTerm, limit);
  });

  ipcMain.handle('reactions:calculateMaterials', async (event, reactionTypeId, runs, characterId, facilityOrId, marketSetId) => {
    // Accept either a facility snapshot object or a facilityId string/number
    let facility = null;
    if (facilityOrId) {
      if (typeof facilityOrId === 'object') {
        // Caller passed a snapshot directly — use it as-is
        facility = facilityOrId;
      } else {
        // Caller passed an ID — look up current facility from settings
        const { getManufacturingFacility } = require('./settings-manager');
        facility = getManufacturingFacility(facilityOrId);
      }

      // Get system security status from SDE if we have a systemId
      if (facility && facility.systemId) {
        const { getSystemSecurityStatus } = require('./sde-database');
        facility.securityStatus = await getSystemSecurityStatus(facility.systemId);
      }

      // Get structure bonuses if this is a player structure (Refinery)
      if (facility && facility.structureTypeId) {
        const { getStructureBonuses } = require('./sde-database');
        const bonuses = await getStructureBonuses(facility.structureTypeId);
        facility.structureBonuses = bonuses;
      }
    }

    const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
    return await calculateReactionMaterials(reactionTypeId, runs, characterId, facility, 0, null, marketSet);
  });

  ipcMain.handle('reactions:getReactionProduct', (event, reactionTypeId) => {
    return getReactionProduct(reactionTypeId);
  });

  ipcMain.handle('reactions:getTypeName', (event, typeId) => {
    return getReactionTypeName(typeId);
  });

  ipcMain.handle('reactions:getReactionTime', (event, reactionTypeId) => {
    return getReactionTime(reactionTypeId);
  });

  ipcMain.handle('reactions:clearCaches', () => {
    clearReactionCache();
    return { success: true };
  });

  // Handle IPC for market data operations

  // --- Market Sets CRUD ---
  ipcMain.handle('market:getMarketSets', () => getMarketSets());

  ipcMain.handle('market:addMarketSet', (event, setData) => addMarketSet(setData));

  ipcMain.handle('market:updateMarketSet', (event, id, updates) => updateMarketSet(id, updates));

  ipcMain.handle('market:deleteMarketSet', (event, id) => deleteMarketSet(id));

  ipcMain.handle('market:setDefaultMarketSet', (event, id) => setDefaultMarketSet(id));

  ipcMain.handle('market:getMarketSetForTool', (event, toolKey) => ({
    setId: getToolMarketSetId(toolKey),
    marketSet: resolveMarketSetForTool(toolKey),
  }));

  ipcMain.handle('market:setMarketSetForTool', (event, toolKey, id) => setToolMarketSetId(toolKey, id));

  ipcMain.handle('market:getRegionDashboard', async () => {
    const { getUniqueRegions, getInputLocation, getOutputLocation } = require('./blueprint-pricing');
    const { getLastMarketFetchTimeForRegion, getLastStructureMarketFetchTime } = require('./esi-market');
    const { getAllRegions } = require('./sde-database');
    const sets = getMarketSets();
    const regionMap = new Map(); // regionId → { regionId, setNames: [], structures: Map<structureId, {structureId, structureName}> }
    for (const set of sets) {
      const regions = getUniqueRegions(set);
      for (const regionId of regions) {
        if (!regionMap.has(regionId)) regionMap.set(regionId, { regionId, setNames: [], structures: new Map() });
        regionMap.get(regionId).setNames.push(set.name);
      }
      [getInputLocation(set), getOutputLocation(set)].forEach(loc => {
        if (loc.locationType === 'private_structure' && loc.structureId && loc.regionId) {
          if (!regionMap.has(loc.regionId)) regionMap.set(loc.regionId, { regionId: loc.regionId, setNames: [], structures: new Map() });
          regionMap.get(loc.regionId).structures.set(loc.structureId, { structureId: loc.structureId, structureName: loc.structureName });
        }
      });
    }
    // Build regionId → regionName lookup from SDE
    const regionNameMap = new Map();
    try {
      const allRegions = await getAllRegions();
      for (const r of allRegions) regionNameMap.set(r.regionID, r.regionName);
    } catch (e) {
      console.warn('[Market Dashboard] Could not load region names from SDE:', e.message);
    }
    const dashboard = [];
    for (const [regionId, info] of regionMap) {
      const lastFetch = getLastMarketFetchTimeForRegion(regionId);
      const regionName = regionNameMap.get(regionId) || `Region ${regionId}`;
      const structures = [...info.structures.values()].map(s => ({
        ...s,
        lastFetch: getLastStructureMarketFetchTime(s.structureId),
      }));
      dashboard.push({ regionId, regionName, setNames: info.setNames, lastFetch, structures });
    }
    return dashboard;
  });

  ipcMain.handle('market:updateRegion', async (event, regionId) => {
    const { manualRefreshMarketData, refreshStructuresInRegion } = require('./esi-market');
    const marketResult = await manualRefreshMarketData(regionId);
    const structureResult = await refreshStructuresInRegion(regionId);
    return {
      ...marketResult,
      structureErrors: structureResult.errors,
      structuresRefreshed: structureResult.refreshed,
    };
  });

  ipcMain.handle('market:fetchOrders', async (event, regionId, typeId, locationFilter) => {
    try {
      // Always use cached data (forceRefresh=false) - only manual refresh triggers ESI fetch
      return await fetchMarketOrders(regionId, typeId, locationFilter, false);
    } catch (error) {
      console.error('Error fetching market orders:', error);
      return [];
    }
  });

  ipcMain.handle('market:fetchHistory', async (event, regionId, typeId) => {
    try {
      // Auto-refresh: forceRefresh=false allows automatic staleness check (11:05 UTC cutoff)
      return await fetchMarketHistory(regionId, typeId, false);
    } catch (error) {
      console.error('Error fetching market history:', error);
      return [];
    }
  });

  /**
   * Every profitability metric for one product, from ONE history read.
   *
   * The Manufacturing Summary used to call six separate renderer functions per
   * blueprint - SVR, velocity, saturation, momentum, stability, demand growth -
   * and each fetched the SAME product history itself. A 200-blueprint run made
   * ~1,200 history calls where ~200 would do. History is fetched one type at a
   * time and expires daily, so that was the dominant cost on the screen.
   *
   * Fetching here, once, and handing the rows to the pure metric functions
   * collapses that to a single call per product.
   */
  ipcMain.handle('metrics:forProduct', async (event, options = {}) => {
    try {
      const {
        regionId,
        productTypeId,
        svrPeriod = 30,
        productionTimeHours = 0,
        profitPerUnit = 0,
        locationFilter = null,
      } = options;

      if (!productTypeId || Number.isNaN(Number(productTypeId))) {
        return null;
      }

      const { collectProductMetrics } = require('./manufacturing-metrics');

      // One history read and one order read, shared by every metric.
      const [history, orders] = await Promise.all([
        fetchMarketHistory(regionId, productTypeId, false).catch(() => []),
        fetchMarketOrders(regionId, productTypeId, locationFilter).catch(() => []),
      ]);

      return collectProductMetrics({
        history,
        orders,
        svrPeriod,
        productionTimeHours,
        profitPerUnit,
      });
    } catch (error) {
      console.error('Error collecting product metrics:', error);
      return null;
    }
  });

  /**
   * Material cost volatility for one blueprint's material list.
   *
   * Kept separate from metrics:forProduct because it reads a DIFFERENT set of
   * histories (the materials, not the product) and is the one metric whose
   * cost scales with recipe size rather than with blueprint count.
   */
  ipcMain.handle('metrics:materialVolatility', async (event, options = {}) => {
    try {
      const { regionId, materials = {}, period = 30 } = options;
      const entries = Object.entries(materials);
      if (entries.length === 0) return 0;

      const { calculateMaterialCostVolatility } = require('./manufacturing-metrics');

      const withHistory = await Promise.all(entries.map(async ([typeId, quantity]) => {
        const parsed = parseInt(typeId, 10);
        if (!parsed || Number.isNaN(parsed)) return null;
        const history = await fetchMarketHistory(regionId, parsed, false).catch(() => []);
        return { quantity, history };
      }));

      return calculateMaterialCostVolatility(withHistory.filter(Boolean), period);
    } catch (error) {
      console.error('Error calculating material cost volatility:', error);
      return 0;
    }
  });

  /**
   * Frames that have asked to stop their in-flight summary.
   *
   * Keyed by webContents id rather than a single flag: two windows can each be
   * calculating, and cancelling one must not abort the other. Entries are
   * cleared when the run starts and again when it settles.
   */
  const summaryCancellations = new Set();

  /**
   * Run the whole Manufacturing Summary.
   *
   * The orchestration used to live in the renderer, reaching every helper it
   * needed one IPC call at a time. It now runs here, next to those helpers,
   * and streams progress back over `summary:progress` so the caller can show a
   * bar without polling.
   */
  ipcMain.handle('summary:calculate', async (event, options = {}) => {
    // Keyed per frame: two windows can each run their own summary, and one
    // cancelling must not abort the other.
    const runKey = event.sender.id;
    summaryCancellations.delete(runKey);

    try {
      const { calculateSummary } = require('./manufacturing-summary');
      const { withPriceCache } = require('./market-read-cache');

      // A summary sweep prices hundreds of blueprints whose material lists
      // overlap heavily (every T2 ship wants the same moon goo), so the same
      // order books are read over and over. The session ends when this handler
      // returns - including on cancel - so a later run always re-reads.
      const rows = await withPriceCache(() => calculateSummary(
        options,
        (progress) => {
          // Sent to the CALLING frame only: two windows could be running their
          // own summary, and a broadcast would cross the progress bars.
          try {
            if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send('summary:progress', progress);
            }
          } catch (_) {
            /* the frame went away mid-run */
          }
        },
        () => summaryCancellations.has(runKey)
      ), 'manufacturing summary');

      return { cancelled: false, rows };
    } catch (error) {
      // A user-requested stop is not a failure - reported so the renderer can
      // restore its button without showing an error toast.
      if (error && error.cancelled) {
        return { cancelled: true, rows: [] };
      }
      console.error('Error calculating manufacturing summary:', error);
      throw new Error(error.message || 'Failed to calculate the manufacturing summary');
    } finally {
      summaryCancellations.delete(runKey);
    }
  });

  ipcMain.handle('summary:cancel', (event) => {
    summaryCancellations.add(event.sender.id);
    return true;
  });

  ipcMain.handle('market:fetchData', async (event, regionId, typeId) => {
    try {
      return await fetchMarketData(regionId, typeId);
    } catch (error) {
      console.error('Error fetching market data:', error);
      return { orders: [], history: [] };
    }
  });

  ipcMain.handle('market:fetchFuzzwork', async (event, typeId, regionId) => {
    try {
      return await fetchFuzzworkHistory(typeId, regionId);
    } catch (error) {
      console.error('Error fetching Fuzzwork data:', error);
      return null;
    }
  });

  ipcMain.handle('market:fetchJitaPrice', async (event, typeId) => {
    try {
      return await fetchJitaPrice(typeId);
    } catch (error) {
      console.error('Error fetching Jita price:', error);
      return null;
    }
  });

  ipcMain.handle('market:fetchBulkPrices', async (event, typeIds, regionId) => {
    try {
      return await fetchBulkPrices(typeIds, regionId);
    } catch (error) {
      console.error('Error fetching bulk prices:', error);
      return {};
    }
  });

  ipcMain.handle('market:calculatePrice', async (event, typeId, regionId, locationId, priceType, quantity, marketSetId, settingsScope = 'input') => {
    try {
      const set = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
      if (!set) throw new Error(`Market Set not found: ${marketSetId}`);
      const settings = settingsScope === 'output' ? set.outputProducts : set.inputMaterials;
      const priceResult = await calculateRealisticPrice(typeId, regionId, locationId, priceType, quantity, settings);
      const { recordPricing } = require('./audit-recorder');
      recordPricing({ typeId, quantity, priceType, marketSetId: set.id, marketSetName: set.name, source: 'market:calculatePrice' }, priceResult);
      return priceResult;
    } catch (error) {
      console.error('Error calculating realistic price:', error);
      return { price: 0, confidence: 'none', warning: 'Error calculating price' };
    }
  });

  // Batched pricing for list views.
  //
  // The per-item handler above is right for one lookup, but a view pricing a
  // thousand assets would make a thousand IPC round-trips - the exact pattern
  // that made the Assets screen hammer ESI. Dedupe by typeId here and price
  // each distinct type once.
  //
  // Uses calculateRealisticPrice (never fetchBulkPrices/Fuzzwork directly), so
  // overrides, pricing method, modifiers and confidence all behave as they do
  // everywhere else.
  ipcMain.handle('market:calculatePrices', async (event, typeIds, options = {}) => {
    try {
      const {
        regionId = null,
        locationId = null,
        priceType = 'sell',
        marketSetId = null,
        settingsScope = 'input',
        // Order-book only. History is a sanity check on the order book, and it
        // costs one ESI call per type that expires daily - prohibitive when
        // valuing a whole hangar. See calculateRealisticPrice.
        skipHistory = false,
      } = options || {};

      const set = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
      if (!set) throw new Error(`Market Set not found: ${marketSetId}`);
      const settings = settingsScope === 'output' ? set.outputProducts : set.inputMaterials;

      // Location lives per scope on a market set; there is no top-level
      // set.regionId, so fall back to the scope's own configuration.
      const effectiveRegionId = regionId || (settings && settings.regionId) || null;
      const effectiveLocationId = locationId || (settings && settings.locationId) || null;

      const unique = [...new Set((typeIds || []).filter((id) => id != null))];
      const out = {};

      for (const typeId of unique) {
        try {
          const result = await calculateRealisticPrice(
            typeId, effectiveRegionId, effectiveLocationId, priceType, 1, settings,
            { skipHistory }
          );
          out[typeId] = result;
        } catch (error) {
          // One unpriceable item must not lose the rest of the list.
          out[typeId] = { price: 0, confidence: 'none', warning: error.message };
        }
      }

      return out;
    } catch (error) {
      console.error('Error calculating bulk prices:', error);
      return {};
    }
  });

  ipcMain.handle('market:getPriceOverride', (event, typeId) => {
    return getPriceOverride(typeId);
  });

  ipcMain.handle('market:setPriceOverride', (event, typeId, price, notes) => {
    return setPriceOverride(typeId, price, notes);
  });

  ipcMain.handle('market:removePriceOverride', (event, typeId) => {
    return removePriceOverride(typeId);
  });

  ipcMain.handle('market:getAllPriceOverrides', () => {
    return getAllPriceOverrides();
  });

  ipcMain.handle('market:getLastFetchTime', () => {
    return getLastMarketFetchTime();
  });

  /**
   * Search items that are actually traded in a region.
   *
   * Names live in the SDE and orders live in market-data.db, so this searches
   * the SDE by name first, then intersects with the region's cached orders.
   * Returns [] when the region has no market data yet - by design: the caller
   * is asking what is tradeable HERE, not what exists in the game.
   */
  ipcMain.handle('market:searchTradedItems', async (event, regionId, searchTerm, limit = 50) => {
    try {
      if (!regionId) return { success: true, items: [] };

      const { searchMarketItems } = require('./sde-database');
      const { getTradedTypeIds } = require('./market-database');

      const term = (searchTerm || '').trim();
      if (term.length < 2) return { success: true, items: [] };

      const sdeMatches = await searchMarketItems(term);
      if (!sdeMatches || sdeMatches.length === 0) return { success: true, items: [] };

      const byId = new Map(sdeMatches.map((r) => [r.typeID, r.typeName]));
      const traded = getTradedTypeIds(regionId, [...byId.keys()], limit);

      return {
        success: true,
        items: traded.map((t) => ({
          typeId: t.typeId,
          typeName: byId.get(t.typeId) || `Type ${t.typeId}`,
          volume: t.volume,
          orderCount: t.orderCount,
        })),
      };
    } catch (error) {
      console.error('Error searching traded items:', error);
      return { success: false, error: error.message, items: [] };
    }
  });

  /** Plans referencing a type, with their locked prices (inspector). */
  ipcMain.handle('market:getPlansUsingType', (event, typeId) => {
    try {
      const { getPlansUsingType } = require('./manufacturing-plans');
      return { success: true, plans: getPlansUsingType(typeId) };
    } catch (error) {
      console.error('Error getting plans using type:', error);
      return { success: false, error: error.message, plans: [] };
    }
  });

  /**
   * Re-lock one material in one plan at the current market price.
   * Explicit user action - see relockPlanMaterialPrice for why this does not
   * conflict with "plan prices never auto-update".
   */
  ipcMain.handle('market:relockPlanMaterial', (event, planId, typeId, price) => {
    try {
      const { relockPlanMaterialPrice } = require('./manufacturing-plans');
      return relockPlanMaterialPrice(planId, typeId, price);
    } catch (error) {
      console.error('Error re-locking plan material:', error);
      return { success: false, error: error.message };
    }
  });

  /** Cached price history for the market data drawer. */
  ipcMain.handle('market:getCachedHistory', async (event, regionId, typeId, days) => {
    try {
      const cached = getCachedMarketHistory(regionId, typeId, days);
      if (cached && cached.length > 0) {
        return { success: true, history: cached, fetched: false };
      }

      // Nothing cached: fetch on demand, the same way calculateRealisticPrice
      // does when an item is first priced. fetchMarketHistory owns the
      // cache/staleness decision (11:05 UTC cutoff) and writes through, so a
      // second open of the drawer is served from cache.
      console.log(`[Market] No cached history for type ${typeId} in region ${regionId}; fetching on demand`);
      await fetchMarketHistory(regionId, typeId);

      return {
        success: true,
        history: getCachedMarketHistory(regionId, typeId, days),
        fetched: true,
      };
    } catch (error) {
      console.error('Error getting market history:', error);
      return { success: false, error: error.message, history: [] };
    }
  });

  /** Seeded trade hubs, for the market set editor's location picker. */
  ipcMain.handle('market:getMarketLocations', () => {
    try {
      const { getMarketLocations } = require('./market-database');
      return { success: true, locations: getMarketLocations() };
    } catch (error) {
      console.error('Error getting market locations:', error);
      return { success: false, error: error.message, locations: [] };
    }
  });

  /** Best buy/sell and traded volume per type, straight from the order book. */
  ipcMain.handle('market:getOrderBookSummary', (event, regionId, typeIds) => {
    try {
      const { getOrderBookSummary } = require('./market-database');
      const summary = getOrderBookSummary(regionId, typeIds || []);
      // Maps do not survive IPC structured cloning as Maps in all cases; send
      // a plain object keyed by typeId.
      const out = {};
      summary.forEach((v, k) => { out[k] = v; });
      return { success: true, summary: out };
    } catch (error) {
      console.error('Error getting order book summary:', error);
      return { success: false, error: error.message, summary: {} };
    }
  });

  // ---- Market watchlists, items, favourites, alerts ----
  // Handlers return {success, ...} so renderers can surface validation errors
  // (empty name, bad alert rule) as toasts rather than unhandled rejections.
  ipcMain.handle('market:getWatchlists', () => {
    try {
      return { success: true, watchlists: marketWatchlists.getWatchlists() };
    } catch (error) {
      console.error('Error getting watchlists:', error);
      return { success: false, error: error.message, watchlists: [] };
    }
  });

  ipcMain.handle('market:getWatchlist', (event, watchlistId) => {
    try {
      return { success: true, watchlist: marketWatchlists.getWatchlist(watchlistId) };
    } catch (error) {
      console.error('Error getting watchlist:', error);
      return { success: false, error: error.message, watchlist: null };
    }
  });

  ipcMain.handle('market:createWatchlist', (event, data) => {
    try {
      return { success: true, watchlist: marketWatchlists.createWatchlist(data) };
    } catch (error) {
      console.error('Error creating watchlist:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:updateWatchlist', (event, watchlistId, updates) => {
    try {
      return { success: true, watchlist: marketWatchlists.updateWatchlist(watchlistId, updates) };
    } catch (error) {
      console.error('Error updating watchlist:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:deleteWatchlist', (event, watchlistId) => {
    try {
      return { success: marketWatchlists.deleteWatchlist(watchlistId) };
    } catch (error) {
      console.error('Error deleting watchlist:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:addWatchlistItem', (event, watchlistId, typeId, alert) => {
    try {
      return { success: true, item: marketWatchlists.addWatchlistItem(watchlistId, typeId, alert) };
    } catch (error) {
      console.error('Error adding watchlist item:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:updateWatchlistItem', (event, itemId, updates) => {
    try {
      return { success: true, item: marketWatchlists.updateWatchlistItem(itemId, updates) };
    } catch (error) {
      console.error('Error updating watchlist item:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:rebaselineWatchlistItem', (event, itemId, prices) => {
    try {
      return { success: true, item: marketWatchlists.rebaselineWatchlistItem(itemId, prices) };
    } catch (error) {
      console.error('Error re-baselining watchlist item:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:removeWatchlistItem', (event, itemId) => {
    try {
      return { success: marketWatchlists.removeWatchlistItem(itemId) };
    } catch (error) {
      console.error('Error removing watchlist item:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:getFavorites', () => {
    try {
      return { success: true, favorites: marketWatchlists.getFavorites() };
    } catch (error) {
      console.error('Error getting favorites:', error);
      return { success: false, error: error.message, favorites: [] };
    }
  });

  ipcMain.handle('market:toggleFavorite', (event, typeId) => {
    try {
      return { success: true, isFavorite: marketWatchlists.toggleFavorite(typeId) };
    } catch (error) {
      console.error('Error toggling favorite:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('market:setFavorite', (event, typeId, isFavorite) => {
    try {
      return { success: true, isFavorite: marketWatchlists.setFavorite(typeId, isFavorite) };
    } catch (error) {
      console.error('Error setting favorite:', error);
      return { success: false, error: error.message };
    }
  });

  // No `market:evaluateWatchlistAlerts`: there is no background alert engine.
  // Whether a rule is currently hit is derived in the renderer from the live
  // price against its baseline - see market-watchlists.js.

  // Global ESI background refresh — manual "refresh now" + status.
  ipcMain.handle('esi:refreshGlobalNow', async () => {
    return await runRefreshCycle();
  });

  ipcMain.handle('esi:getGlobalRefreshStatus', () => {
    return getGlobalRefreshStatus();
  });

  ipcMain.handle('market:manualRefresh', async (event, regionId) => {
    return await manualRefreshMarketData(regionId);
  });

  ipcMain.handle('market:getLastHistoryFetchTime', () => {
    return getLastHistoryFetchTime();
  });

  ipcMain.handle('market:getHistoryDataStatus', (event, regionId) => {
    return getHistoryDataStatus(regionId);
  });

  ipcMain.handle('market:manualRefreshHistory', async (event, regionId) => {
    return await manualRefreshHistoryData(regionId);
  });

  ipcMain.handle('market:refreshAdjustedPrices', async () => {
    const { manualRefreshAdjustedPrices } = require('./esi-market');
    return await manualRefreshAdjustedPrices();
  });

  ipcMain.handle('market:refreshMultipleRegions', async (event, regionIds) => {
    const { refreshMultipleRegions } = require('./esi-market');
    const result = await refreshMultipleRegions(regionIds);

    // Prices moved, so the material-tree cache is stale - its entries carry
    // their own `pricing` object and the key has no price component. Same
    // reasoning as in market:updateAllMarketData below.
    try {
      const { clearMaterialCache } = require('./blueprint-calculator');
      clearMaterialCache();
    } catch (error) {
      console.error('Could not clear the material cache after a region refresh:', error);
    }

    return result;
  });

  // Unified market data update - refreshes all configured regions, adjusted prices, and cost indices
  ipcMain.handle('market:updateAllMarketData', async (event) => {
    const { getUniqueRegions } = require('./blueprint-pricing');
    const {
      refreshMultipleRegions,
      manualRefreshAdjustedPrices,
      refreshStructuresInRegion,
      emitRefreshStage,
      setRefreshProgressTarget,
    } = require('./esi-market');

    // Progress goes back to the frame that asked for it, and nowhere else. A
    // Market view open in another window must not pop a dialog for a refresh
    // someone else started.
    setRefreshProgressTarget(event.sender);

    const results = {
      marketData: null,
      adjustedPrices: null,
      costIndices: null,
      success: false,
      errors: [],
    };

    try {
      // Step 1: Collect all unique regions from ALL market sets
      const allSets = getMarketSets();
      const allRegionIds = new Set();
      for (const set of allSets) {
        getUniqueRegions(set).forEach(id => allRegionIds.add(id));
      }
      const regionIds = [...allRegionIds];
      console.log(`[UpdateAllMarketData] Refreshing ${regionIds.length} region(s) across all Market Sets:`, regionIds);

      // Announce the shape of the work before any of it starts, so the UI can
      // show a real total rather than an anonymous spinner.
      emitRefreshStage({ phase: 'starting', current: 0, total: regionIds.length });

      // Step 2: Refresh market data for all regions (public orders only)
      results.marketData = await refreshMultipleRegions(regionIds);
      if (!results.marketData.success) {
        results.errors.push('Some regions failed to refresh');
      }

      // Step 3: Refresh private structure orders AFTER public region refresh
      const structureResult = await refreshStructuresInRegion(null, allSets);
      for (const err of structureResult.errors) {
        results.errors.push(`Structure market refresh failed: ${err.message}`);
      }

      // How much of the request was actually served, versus already-cached.
      // Reported because a refresh that legitimately skips everything looks
      // identical to one that worked - it just returns fast and says nothing.
      results.skipped = {
        regions: (results.marketData && results.marketData.rateLimitedCount) || 0,
        structures: (structureResult.rateLimited || []).length,
      };
      results.refreshed = {
        regions: (results.marketData && results.marketData.refreshedCount) || 0,
        structures: (structureResult.refreshed || []).length,
      };

      // Step 4: Refresh adjusted prices
      emitRefreshStage({ phase: 'adjusted-prices', current: 1, total: 1 });
      results.adjustedPrices = await manualRefreshAdjustedPrices();
      if (!results.adjustedPrices.success) {
        results.errors.push('Failed to refresh adjusted prices');
      }

      // Step 5: Refresh cost indices
      emitRefreshStage({ phase: 'cost-indices', current: 1, total: 1 });
      results.costIndices = await fetchCostIndices();

      results.success = results.errors.length === 0;

      /*
       * Drop the material-tree cache BEFORE announcing the refresh.
       *
       * Cached entries carry their `pricing` object, and the cache key has no
       * price component - only blueprint/ME/facility/character/market set. So
       * without this, up to MAX_CACHE_SIZE blueprints keep serving the OLD
       * profit and ROI after a refresh, until FIFO eviction happens to push
       * them out. Cleared first so any listener reacting to the event
       * recomputes against fresh prices rather than racing the clear.
       */
      try {
        const { clearMaterialCache } = require('./blueprint-calculator');
        clearMaterialCache();
      } catch (error) {
        console.error('Could not clear the material cache after a market refresh:', error);
      }

      // Tell every window market data changed, so staleness indicators can
      // clear themselves instead of waiting for a reload.
      try {
        const { emitMarketChanged } = require('./data-events');
        emitMarketChanged({ regionIds, scope: 'all' });
      } catch (_) { /* never break the refresh */ }
      results.message = results.success
        ? `Updated market data for ${regionIds.length} region(s), adjusted prices, and cost indices`
        : `Update completed with errors: ${results.errors.join(', ')}`;

      return results;
    } catch (error) {
      console.error('[UpdateAllMarketData] Error:', error);
      results.errors.push(error.message);
      results.message = `Update failed: ${error.message}`;
      return results;
    } finally {
      // `finally`, not the success path: a refresh that throws must still tell
      // the UI it is over, or the progress dialog stays up forever.
      emitRefreshStage({ phase: 'done', current: 1, total: 1 });
      // Released so a later refresh cannot send progress to a stale frame.
      setRefreshProgressTarget(null);
    }
  });

  // Search for player-owned structures by name (requires structure search scope)
  ipcMain.handle('market:searchStructures', async (event, characterId, searchTerm) => {
    const { searchStructures } = require('./esi-market');

    let character = getCharacter(characterId);
    if (!character) throw new Error('Character not found');
    if (isTokenExpired(character.expiresAt)) {
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }
    return await searchStructures(character.characterId, character.accessToken, searchTerm);
  });

  // Refresh market orders for a specific private structure
  ipcMain.handle('market:refreshStructureMarket', async (event, structureId, regionId, characterId) => {
    const { fetchStructureMarketOrders } = require('./esi-market');

    let character = getCharacter(characterId);
    if (!character) throw new Error('Character not found');
    if (isTokenExpired(character.expiresAt)) {
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }
    return await fetchStructureMarketOrders(structureId, regionId, character.accessToken, true);
  });

  // ============================================================
  // Loot Analyzer IPC handlers
  // ============================================================

  ipcMain.handle('loot:getCharacterSkills', (event, characterId) => {
    try {
      const character = getCharacter(characterId);
      if (!character || !character.skills) {
        return { found: false };
      }
      const skillsMap = character.skills.skills || {};

      // All reprocessing-relevant skill IDs (SDE-verified)
      const REPROCESSING_SKILL_IDS = [
        3385,  // Reprocessing
        3389,  // Reprocessing Efficiency
        60377, // Simple Ore Processing
        60378, // Coherent Ore Processing
        60379, // Variegated Ore Processing
        60380, // Complex Ore Processing
        60381, // Abyssal Ore Processing
        90040, // Erratic Ore Processing
        12189, // Mercoxit Ore Processing
        18025, // Ice Processing
        12196, // Scrapmetal Processing
        46152, // Ubiquitous Moon Ore Processing
        46153, // Common Moon Ore Processing
        46154, // Uncommon Moon Ore Processing
        46155, // Rare Moon Ore Processing
        46156, // Exceptional Moon Ore Processing
      ];

      const overrides = character.skillOverrides || {};
      const result = {};
      for (const skillId of REPROCESSING_SKILL_IDS) {
        const skill = skillsMap[skillId];
        const activeLevel = skill ? (skill.activeSkillLevel || 0) : 0;
        // Skill overrides take precedence — keys may be numeric or string after serialization
        const override = overrides[skillId] ?? overrides[String(skillId)];
        result[skillId] = (override != null) ? override : activeLevel;
      }

      return { found: true, skills: result };
    } catch (error) {
      console.error('[loot:getCharacterSkills] Error:', error);
      return { found: false, error: error.message };
    }
  });

  ipcMain.handle('loot:parseAndEnrich', async (event, rawText) => {
    try {
      const { items, parseErrors } = parseLootText(rawText);

      if (items.length === 0) {
        return { items: [], unresolvedNames: [], parseErrors };
      }

      // Exact name lookup in SDE
      const uniqueNames = [...new Set(items.map(i => i.rawName))];
      const nameMap = await searchItemsByExactName(uniqueNames);

      const resolvedItems = [];
      const unresolvedNames = [];

      for (const item of items) {
        const match = nameMap[item.rawName];
        if (!match) {
          unresolvedNames.push(item.rawName);
          continue;
        }
        resolvedItems.push({ ...item, typeId: match.typeId, typeName: match.typeName });
      }

      if (resolvedItems.length === 0) {
        return { items: [], unresolvedNames, parseErrors };
      }

      const typeIds = resolvedItems.map(i => i.typeId);

      // Fetch category info and reprocessing materials in parallel
      const { getTypeCategoryInfo } = require('./sde-database');
      const [categoryInfo, reprocessingData] = await Promise.all([
        getTypeCategoryInfo(typeIds),
        getReprocessingMaterials(typeIds),
      ]);

      const enrichedItems = resolvedItems.map(item => {
        const catInfo = categoryInfo[item.typeId] || {};
        const reprData = reprocessingData[item.typeId] || null;
        const typeSkill = getTypeSpecificSkillId(catInfo.categoryID, catInfo.groupID);

        return {
          rawName: item.rawName,
          typeId: item.typeId,
          typeName: item.typeName,
          quantity: item.quantity,
          categoryId: catInfo.categoryID || null,
          groupId: catInfo.groupID || null,
          categoryName: catInfo.categoryName || null,
          groupName: catInfo.groupName || null,
          canReprocess: reprData !== null,
          portionSize: reprData ? reprData.portionSize : null,
          materials: reprData ? reprData.materials : [],
          typeSpecificSkillId: typeSkill ? typeSkill.skillId : null,
          typeSpecificSkillName: typeSkill ? typeSkill.skillName : null,
        };
      });

      return { items: enrichedItems, unresolvedNames, parseErrors };
    } catch (error) {
      console.error('[loot:parseAndEnrich] Error:', error);
      return { items: [], unresolvedNames: [], parseErrors: [], error: error.message };
    }
  });

  ipcMain.handle('loot:fetchPrices', async (event, params) => {
    try {
      const {
        typeIds = [],
        materialTypeIds = [],
        market1,
        market2,
        reprocessingConfig,
        itemReprocessingData,
        minSvr = 0,
      } = params;

      // Intentionally bypasses the active Market Set's configured priceMethod: loot
      // appraisal always wants live "what could I get right now" sell/buy prices,
      // not the user's manufacturing pricing method. Do not "fix" this to read from
      // a Market Set — it's a deliberate exception, not the settings-shape bug
      // fixed elsewhere in this file (see market:calculatePrice).
      const priceSettings = { priceMethod: 'immediate' };

      // Deduplicate all typeIds needed (items + their reprocessing materials)
      const allTypeIds = [...new Set([...typeIds, ...materialTypeIds])];

      // Fetch prices for all typeIds in parallel across both markets
      const priceMap = {};
      await Promise.all(allTypeIds.map(async typeId => {
        const [m1Sell, m1Buy, m2Sell, m2Buy] = await Promise.all([
          calculateRealisticPrice(typeId, market1.regionId, market1.locationId || null, 'sell', 1, priceSettings),
          calculateRealisticPrice(typeId, market1.regionId, market1.locationId || null, 'buy', 1, priceSettings),
          market2 ? calculateRealisticPrice(typeId, market2.regionId, market2.locationId || null, 'sell', 1, priceSettings) : Promise.resolve(null),
          market2 ? calculateRealisticPrice(typeId, market2.regionId, market2.locationId || null, 'buy', 1, priceSettings) : Promise.resolve(null),
        ]);
        priceMap[typeId] = {
          m1Sell: m1Sell ? m1Sell.price : 0,
          m1Buy: m1Buy ? m1Buy.price : 0,
          m2Sell: m2Sell ? m2Sell.price : null,
          m2Buy: m2Buy ? m2Buy.price : null,
        };
      }));

      // Calculate base yield (no type-specific skill) for display reference
      const { stationConfig, baseSkills, implantBonus, oreSkillLevels } = reprocessingConfig;
      const baseYieldRate = calculateReprocessingYield(
        stationConfig,
        { reprocessing: baseSkills.reprocessing, reprocessingEfficiency: baseSkills.reprocessingEfficiency, typeSpecific: 0 },
        implantBonus
      );

      // itemTypeSkills: { [typeId]: skillId | null } — passed from renderer
      const { itemTypeSkills = {} } = params;

      // Build material price map for reprocessing value calculations
      const materialPrices = {};
      for (const matTypeId of materialTypeIds) {
        const prices = priceMap[matTypeId];
        if (prices) {
          materialPrices[matTypeId] = { sell: prices.m1Sell, buy: prices.m1Buy };
        }
      }


      // Compute per-item results
      const itemResults = {};
      for (const typeId of typeIds) {
        const prices = priceMap[typeId] || { m1Sell: 0, m1Buy: 0, m2Sell: null, m2Buy: null };
        // itemReprocessingData and itemTypeSkills come from the renderer as serialized objects
        // whose keys are strings (IPC JSON serialization converts numeric keys to strings)
        const reprData = itemReprocessingData[typeId] || itemReprocessingData[String(typeId)] || null;

        // Look up the type-specific skill level for this item
        const typeSkillId = itemTypeSkills[typeId] || itemTypeSkills[String(typeId)] || null;
        const typeSkillLevel = (typeSkillId && oreSkillLevels) ? (oreSkillLevels[typeSkillId] || oreSkillLevels[String(typeSkillId)] || 0) : 0;
        const itemYieldRate = calculateReprocessingYield(
          stationConfig,
          { reprocessing: baseSkills.reprocessing, reprocessingEfficiency: baseSkills.reprocessingEfficiency, typeSpecific: typeSkillLevel },
          implantBonus
        );

        const reprValue = calculateReprocessingValue(1, itemYieldRate, reprData, materialPrices);

        // SVR: 7-day average daily volume from cached market history, per market
        let m1Svr = null;
        try {
          const history = getCachedMarketHistory(market1.regionId, typeId, 7);
          if (history && history.length > 0) {
            const totalVolume = history.reduce((sum, day) => sum + (day.volume || 0), 0);
            m1Svr = Math.round(totalVolume / history.length);
          }
        } catch (e) {
          // SVR is optional — no-op on error
        }

        let m2Svr = null;
        if (market2) {
          try {
            const history2 = getCachedMarketHistory(market2.regionId, typeId, 7);
            if (history2 && history2.length > 0) {
              const totalVolume2 = history2.reduce((sum, day) => sum + (day.volume || 0), 0);
              m2Svr = Math.round(totalVolume2 / history2.length);
            }
          } catch (e) {
            // SVR is optional — no-op on error
          }
        }

        // Derived metrics (per-unit prices; renderer multiplies by qty for totals)
        const m1Sell = prices.m1Sell || 0;
        const m1Buy = prices.m1Buy || 0;
        const m2Sell = prices.m2Sell;
        const m2Buy = prices.m2Buy;

        const m1SellVsM2SellPct = (m2Sell && m2Sell > 0)
          ? ((m1Sell - m2Sell) / m2Sell) * 100
          : null;
        const m1BuyVsM2BuyPct = (m2Buy && m2Buy > 0)
          ? ((m1Buy - m2Buy) / m2Buy) * 100
          : null;
        const m1Spread = (m1Sell > 0)
          ? ((m1Sell - m1Buy) / m1Sell) * 100
          : null;
        const m2Spread = (m2Sell && m2Sell > 0)
          ? ((m2Sell - m2Buy) / m2Sell) * 100
          : null;

        // Best action: compare per-unit values. Reprocess wins outright if it beats
        // both sell markets; otherwise the sell-market choice is gated by minSvr —
        // if both markets fail the liquidity bar, the result is 'unknown' rather
        // than falling through to reprocess.
        const reprocessValue = reprValue.canReprocess ? reprValue.sellValue : -Infinity;
        let bestAction = 'unknown';
        let bestValue = 0;

        if (reprocessValue > m1Sell && reprocessValue > (m2Sell ?? -Infinity) && reprocessValue > 0) {
          bestAction = 'reprocess';
          bestValue = reprocessValue;
        } else {
          const m1Ok = m1Sell > 0 && (m1Svr ?? 0) >= minSvr;
          const m2Ok = m2Sell !== null && m2Sell > 0 && (m2Svr ?? 0) >= minSvr;

          if (!m1Ok && !m2Ok) {
            bestAction = 'unknown';
            bestValue = 0;
          } else if (m1Ok && (!m2Ok || m1Sell >= m2Sell)) {
            bestAction = 'sell-m1';
            bestValue = m1Sell;
          } else if (m2Ok) {
            bestAction = 'sell-m2';
            bestValue = m2Sell;
          }
        }

        itemResults[typeId] = {
          m1Sell,
          m1Buy,
          m2Sell,
          m2Buy,
          reprocessSell: reprValue.sellValue,
          reprocessBuy: reprValue.buyValue,
          canReprocess: reprValue.canReprocess,
          m1Svr,
          m2Svr,
          m1SellVsM2SellPct,
          m1BuyVsM2BuyPct,
          m1Spread,
          m2Spread,
          bestAction,
        };
      }

      // Build material price map to return to renderer for reprocessing value calculations
      const materialPriceMap = {};
      for (const matTypeId of materialTypeIds) {
        if (priceMap[matTypeId]) {
          materialPriceMap[matTypeId] = {
            m1Sell: priceMap[matTypeId].m1Sell,
            m1Buy: priceMap[matTypeId].m1Buy,
          };
        }
      }

      return { baseYieldRate, items: itemResults, materialPrices: materialPriceMap };
    } catch (error) {
      console.error('[loot:fetchPrices] Error:', error);
      return { baseYieldRate: 0, items: {}, materialPrices: {}, error: error.message };
    }
  });

  // Handle IPC for cost indices
  ipcMain.handle('costIndices:fetch', async () => {
    return await fetchCostIndices();
  });

  ipcMain.handle('costIndices:getCostIndices', (event, solarSystemId) => {
    return getCostIndices(solarSystemId);
  });

  ipcMain.handle('costIndices:getAll', () => {
    return getAllCostIndices();
  });

  ipcMain.handle('costIndices:getLastFetchTime', () => {
    return getLastCostIndicesFetchTime();
  });

  ipcMain.handle('costIndices:getSystemCount', () => {
    return getCostIndicesSystemCount();
  });

  // Handle IPC for Facilities Manager
  ipcMain.handle('facilities:getFacilities', () => {
    return getManufacturingFacilities();
  });

  ipcMain.handle('facilities:addFacility', (event, facility) => {
    return addManufacturingFacility(facility);
  });

  ipcMain.handle('facilities:updateFacility', (event, id, updates) => {
    return updateManufacturingFacility(id, updates);
  });

  ipcMain.handle('facilities:removeFacility', (event, id) => {
    return removeManufacturingFacility(id);
  });

  ipcMain.handle('facilities:getFacility', (event, id) => {
    return getManufacturingFacility(id);
  });

  ipcMain.handle('facilities:getAllRegions', async () => {
    const regions = await getAllRegions();
    // Note: SDE returns regionID (uppercase), convert to camelCase for consistency
    return regions.map(region => ({
      regionId: region.regionID,
      regionName: region.regionName
    }));
  });

  ipcMain.handle('facilities:getSystemsByRegion', async (event, regionId) => {
    // Get all systems and filter by region
    const allSystems = await getAllSystems();
    // Note: SDE returns regionID (uppercase), convert to camelCase for consistency
    return allSystems
      .filter(system => system.regionID === parseInt(regionId))
      .map(system => ({
        systemId: system.solarSystemID,
        systemName: system.solarSystemName,
        security: system.security,
        regionId: system.regionID
      }));
  });

  ipcMain.handle('facilities:getCostIndices', async (event, systemId) => {
    return getCostIndices(parseInt(systemId));
  });

  ipcMain.handle('facilities:getStructureTypes', async () => {
    return await getStructureTypes();
  });

  ipcMain.handle('facilities:getStructureRigs', async (event, structureType = null) => {
    return await getStructureRigs(structureType);
  });

  ipcMain.handle('facilities:getStructureBonuses', async (event, typeId) => {
    return await getStructureBonuses(parseInt(typeId));
  });

  ipcMain.handle('facilities:getRigEffects', async (event, typeId) => {
    return await getRigEffects(parseInt(typeId));
  });

  // Handle IPC for SDE skill lookups
  ipcMain.handle('sde:getSkillName', async (event, skillId) => {
    try {
      return await getSkillName(skillId);
    } catch (error) {
      console.error('Error getting skill name:', error);
      return `Skill ${skillId}`;
    }
  });

  ipcMain.handle('sde:getSkillNames', async (event, skillIds) => {
    try {
      return await getSkillNames(skillIds);
    } catch (error) {
      console.error('Error getting skill names:', error);
      // Return error object that can be serialized
      throw new Error(error.message || 'Failed to get skill names from SDE');
    }
  });

  // Name + group + training rank for many skills in one query. Prefer this over
  // getSkillNames when the caller needs grouping: a character has 300-500
  // skills, so a per-skill lookup is the pattern to avoid.
  ipcMain.handle('sde:getSkillInfo', async (event, skillIds) => {
    try {
      const { getSkillInfo } = require('./sde-database');
      return await getSkillInfo(skillIds);
    } catch (error) {
      console.error('Error getting skill info:', error);
      throw new Error(error.message || 'Failed to get skill info from SDE');
    }
  });

  ipcMain.handle('sde:getAllSkills', async () => {
    try {
      return await getAllSkills();
    } catch (error) {
      console.error('Error getting all skills:', error);
      return [];
    }
  });

  ipcMain.handle('sde:getSkillGroup', async (event, skillId) => {
    try {
      return await getSkillGroup(skillId);
    } catch (error) {
      console.error('Error getting skill group:', error);
      return null;
    }
  });

  ipcMain.handle('sde:searchSkills', async (event, searchTerm) => {
    try {
      return await searchSkills(searchTerm);
    } catch (error) {
      console.error('Error searching skills:', error);
      return [];
    }
  });

  // Handle IPC for SDE blueprint lookups
  ipcMain.handle('sde:getBlueprintName', async (event, typeId) => {
    try {
      return await getBlueprintName(typeId);
    } catch (error) {
      console.error('Error getting blueprint name:', error);
      return `Blueprint ${typeId}`;
    }
  });

  ipcMain.handle('sde:getBlueprintNames', async (event, typeIds) => {
    try {
      return await getBlueprintNames(typeIds);
    } catch (error) {
      console.error('Error getting blueprint names:', error);
      throw new Error(error.message || 'Failed to get blueprint names from SDE');
    }
  });

  ipcMain.handle('sde:getTypeName', async (event, typeId) => {
    try {
      const { getTypeName } = require('./sde-database');
      return await getTypeName(typeId);
    } catch (error) {
      console.error('Error getting type name:', error);
      throw new Error(error.message || 'Failed to get type name from SDE');
    }
  });

  ipcMain.handle('sde:getTypeNames', async (event, typeIds) => {
    try {
      const { getTypeNames } = require('./sde-database');
      return await getTypeNames(typeIds);
    } catch (error) {
      console.error('Error getting type names:', error);
      throw new Error(error.message || 'Failed to get type names from SDE');
    }
  });

  ipcMain.handle('sde:getAllBlueprints', async () => {
    try {
      return await getAllBlueprints();
    } catch (error) {
      console.error('Error getting all blueprints:', error);
      return [];
    }
  });

  ipcMain.handle('sde:searchBlueprints', async (event, searchTerm) => {
    try {
      return await searchBlueprints(searchTerm);
    } catch (error) {
      console.error('Error searching blueprints:', error);
      return [];
    }
  });

  // Handle IPC for SDE market location lookups
  ipcMain.handle('sde:getAllRegions', async () => {
    try {
      return await getAllRegions();
    } catch (error) {
      console.error('Error getting regions:', error);
      return [];
    }
  });

  ipcMain.handle('sde:getAllSystems', async () => {
    try {
      return await getAllSystems();
    } catch (error) {
      console.error('Error getting systems:', error);
      return [];
    }
  });

  ipcMain.handle('sde:searchSystems', async (event, searchTerm) => {
    try {
      return await searchSystems(searchTerm);
    } catch (error) {
      console.error('Error searching systems:', error);
      return [];
    }
  });

  ipcMain.handle('sde:getStationsInSystem', async (event, systemId) => {
    try {
      return await getStationsInSystem(systemId);
    } catch (error) {
      console.error('Error getting stations in system:', error);
      return [];
    }
  });

  ipcMain.handle('sde:getTradeHubs', async () => {
    try {
      return await getTradeHubs();
    } catch (error) {
      console.error('Error getting trade hubs:', error);
      return [];
    }
  });

  // Market item search handlers
  ipcMain.handle('sde:searchMarketItems', async (event, searchTerm) => {
    try {
      const { searchMarketItems } = require('./sde-database');
      return await searchMarketItems(searchTerm);
    } catch (error) {
      console.error('Error searching market items:', error);
      return [];
    }
  });

  ipcMain.handle('sde:getItemDetails', async (event, typeID) => {
    try {
      const { getItemDetails } = require('./sde-database');
      return await getItemDetails(typeID);
    } catch (error) {
      console.error('Error getting item details:', error);
      return null;
    }
  });

  ipcMain.handle('sde:getSystemSecurityStatus', async (event, systemId) => {
    try {
      const { getSystemSecurityStatus } = require('./sde-database');
      return await getSystemSecurityStatus(systemId);
    } catch (error) {
      console.error('Error getting system security status:', error);
      return 0.5; // Default to high-sec on error
    }
  });

  // Item Volume Handlers
  ipcMain.handle('sde:getItemVolume', async (event, typeId) => {
    try {
      const { getItemVolume } = require('./sde-database');
      return await getItemVolume(typeId);
    } catch (error) {
      console.error('Error getting item volume:', error);
      return 0;
    }
  });

  ipcMain.handle('sde:getItemVolumes', async (event, typeIds) => {
    try {
      const { getItemVolumes } = require('./sde-database');
      return await getItemVolumes(typeIds);
    } catch (error) {
      console.error('Error getting item volumes:', error);
      return {};
    }
  });

  ipcMain.handle('sde:getTypeCategoryInfo', async (event, typeIds) => {
    try {
      const { getTypeCategoryInfo } = require('./sde-database');
      return await getTypeCategoryInfo(typeIds);
    } catch (error) {
      console.error('Error getting type category info:', error);
      return {};
    }
  });

  ipcMain.handle('sde:getLocationName', async (event, locationId) => {
    try {
      const { getLocationName } = require('./sde-database');
      return await getLocationName(locationId);
    } catch (error) {
      console.error('Error getting location name:', error);
      return null;
    }
  });

  // ESI error-budget state, so the user can see WHAT is erroring and report
  // it rather than just experiencing the app going quiet.
  ipcMain.handle('esiStatus:getErrorBudget', () => {
    const { getStatus } = require('./esi-error-budget');
    return getStatus();
  });

  // Batched location resolution. One call for a whole asset list, deduped by
  // location - the per-asset version meant a thousand round-trips on load.
  ipcMain.handle('location:resolveMany', async (event, locationIds, characterId, isCorporation) => {
    try {
      const { resolveLocationInfoMany } = require('./location-resolver');
      return await resolveLocationInfoMany(locationIds, characterId, isCorporation);
    } catch (error) {
      console.error('Error resolving locations:', error);
      return {};
    }
  });

  // Location resolution IPC handler
  ipcMain.handle('location:resolve', async (event, locationId, characterId, isCorporation) => {
    try {
      const { resolveLocationInfo } = require('./location-resolver');
      return await resolveLocationInfo(locationId, characterId, isCorporation);
    } catch (error) {
      console.error('Error resolving location:', error);
      return {
        systemName: 'Error',
        stationName: 'Error',
        containerNames: [],
        fullPath: 'Error',
        locationType: 'error',
      };
    }
  });

  // Structure cache IPC handlers
  //
  // Player-structure names are cached persistently (24h) and access denials are
  // backed off far longer (7 days) because re-asking ESI for a structure the
  // character cannot dock at returns 403, and 4xx responses spend the
  // application-wide error budget. This handler is the escape hatch that makes
  // that long backoff acceptable: it clears BOTH timers and re-resolves.
  ipcMain.handle('structures:manualRefresh', async (event, options = {}) => {
    try {
      const { characterId = null, structureIds = null } = options || {};
      const { refreshStructures } = require('./esi-structures');
      const { getStats } = require('./structure-cache');

      // Default target: the structures actually referenced by stored assets,
      // not every structure ever seen. Bounded by what the user can look at.
      let ids = structureIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        const { getCharacterDatabase } = require('./character-database');
        const { SPAWNED_ITEM_MIN } = require('./location-classifier');
        const db = getCharacterDatabase();
        const rows = db.prepare(`
          SELECT DISTINCT location_id FROM assets WHERE location_id >= ?
        `).all(SPAWNED_ITEM_MIN);

        // An asset's own item_id is a container, not a structure. Exclude them
        // so we only re-resolve things that could actually BE structures.
        const ownItemIds = new Set(
          db.prepare('SELECT item_id FROM assets').all().map((r) => r.item_id)
        );
        ids = rows
          .map((r) => r.location_id)
          .filter((id) => !ownItemIds.has(id));
      }

      const summary = await refreshStructures(ids, characterId);

      // Names may have changed, so previously formatted paths are stale.
      const { clearAllLocationCache } = require('./location-resolver');
      clearAllLocationCache();

      return { success: true, ...summary, stats: getStats() };
    } catch (error) {
      console.error('Error refreshing structures:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('structures:getStats', () => {
    try {
      const { getStats } = require('./structure-cache');
      return getStats();
    } catch (error) {
      console.error('Error reading structure cache stats:', error);
      return { total: 0, fresh: 0, denied: 0 };
    }
  });

  // Wizard IPC handlers
  ipcMain.handle('wizard:skipSetup', async () => {
    try {
      // Ensure a default Market Set exists (Jita 4-4 defaults)
      const existingSets = getMarketSets();
      if (!existingSets || existingSets.length === 0) {
        addMarketSet({
          name: 'Jita 4-4',
          isDefault: true,
          inputMaterials: {
            locationType: 'hub',
            locationId: 60003760,
            regionId: 10000002,
            systemId: 30000142,
            structureId: null,
            structureName: null,
            characterId: null,
            priceType: 'sell',
            priceMethod: 'hybrid',
            priceModifier: 1.0,
            percentile: 0.2,
            minVolume: 1000,
          },
          outputProducts: {
            useSameLocation: true,
            locationType: 'hub',
            locationId: 60003760,
            regionId: 10000002,
            systemId: 30000142,
            structureId: null,
            structureName: null,
            characterId: null,
            priceType: 'sell',
            priceMethod: 'hybrid',
            priceModifier: 1.0,
            percentile: 0.2,
            minVolume: 1000,
          },
          warningThreshold: 0.3,
        });
      }
      // Apply default settings and mark wizard as complete
      await updateSettings('general', {
        firstLaunchCompleted: true,
        wizardVersion: '1.0',
        wizardCompletedAt: Date.now(),
      });
      return { success: true };
    } catch (error) {
      console.error('Error skipping wizard setup:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('wizard:saveProgress', async (event, step, data) => {
    try {
      await updateSettings('general', {
        wizardProgress: { step, data, savedAt: Date.now() }
      });
      return { success: true };
    } catch (error) {
      console.error('Error saving wizard progress:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('wizard:getProgress', async () => {
    try {
      const settings = loadSettings();
      return { success: true, progress: settings.general.wizardProgress || null };
    } catch (error) {
      console.error('Error getting wizard progress:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('wizard:complete', async () => {
    try {
      // Ensure at least one Market Set exists (safety net if step 5 was skipped)
      const existingSets = getMarketSets();
      if (!existingSets || existingSets.length === 0) {
        addMarketSet({
          name: 'Jita 4-4',
          isDefault: true,
          inputMaterials: {
            locationType: 'hub',
            locationId: 60003760,
            regionId: 10000002,
            systemId: 30000142,
            structureId: null,
            structureName: null,
            characterId: null,
            priceType: 'sell',
            priceMethod: 'hybrid',
            priceModifier: 1.0,
            percentile: 0.2,
            minVolume: 1000,
          },
          outputProducts: {
            useSameLocation: true,
            locationType: 'hub',
            locationId: 60003760,
            regionId: 10000002,
            systemId: 30000142,
            structureId: null,
            structureName: null,
            characterId: null,
            priceType: 'sell',
            priceMethod: 'hybrid',
            priceModifier: 1.0,
            percentile: 0.2,
            minVolume: 1000,
          },
          warningThreshold: 0.3,
        });
      }
      await updateSettings('general', {
        firstLaunchCompleted: true,
        wizardVersion: '1.0',
        wizardCompletedAt: Date.now(),
        wizardProgress: null, // Clear progress
      });
      return { success: true };
    } catch (error) {
      console.error('Error completing wizard:', error);
      return { success: false, error: error.message };
    }
  });

  // Shell IPC handler (for opening external links)
  ipcMain.handle('shell:openExternal', async (event, url) => {
    try {
      // Validate URL to prevent security issues
      if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL');
      }

      // Only allow http and https protocols
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new Error('Invalid URL protocol');
      }

      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Error opening external URL:', error);
      return { success: false, error: error.message };
    }
  });

  // Auto-updater IPC handler
  ipcMain.handle('app:checkForUpdates', async () => {
    checkForUpdates();
  });

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getElectronVersion', () => {
    return process.versions.electron;
  });

  // Error Log IPC handlers
  ipcMain.handle('errorLog:getPath', () => {
    return getLogFilePath();
  });

  ipcMain.handle('errorLog:getDirectory', () => {
    return getLogDirectory();
  });

  ipcMain.handle('errorLog:openFolder', async () => {
    const logDir = getLogDirectory();
    await shell.openPath(logDir);
    return { success: true };
  });

  ipcMain.handle('errorLog:getDiagnostics', () => {
    return collectDiagnostics();
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  // Quit the app on all platforms when all windows are closed
  app.quit();
});

app.on('before-quit', () => {
  // Tear down the global ESI background refresh timer so no fetch fires post-quit.
  try {
    stopBackgroundRefresh();
  } catch (err) {
    console.error('[App] Error stopping background ESI refresh:', err);
  }
});
