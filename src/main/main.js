const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { createSettingsWindow } = require('./settings-window');
const { initAutoUpdater, checkForUpdates } = require('./auto-updater');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');
const { runStartupChecks } = require('./startup-manager');
const { createWizardWindow } = require('./wizard-window');

// Global error handlers for main process
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception in main process:', error);
  // In production, you might want to log to a file
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection in main process:', reason);
  // In production, you might want to log to a file
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
  getMarketSettings,
  updateMarketSettings,
  getManufacturingFacilities,
  addManufacturingFacility,
  updateManufacturingFacility,
  removeManufacturingFacility,
  getManufacturingFacility,
} = require('./settings-manager');
const { authenticateWithESI, refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { fetchCharacterSkills } = require('./esi-skills');
const { fetchCharacterBlueprints } = require('./esi-blueprints');
const {
  getCurrentVersion,
  getLatestVersion,
  checkUpdateRequired,
  downloadSDE,
  getSdePath,
  sdeExists,
  deleteSDE,
  MINIMUM_SDE_VERSION,
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
} = require('./sde-database');
const { initializeMarketDatabase, getMarketDatabase } = require('./market-database');
const { fetchMarketOrders, fetchMarketHistory, fetchMarketData, getLastMarketFetchTime, getLastHistoryFetchTime, getHistoryDataStatus, manualRefreshMarketData, manualRefreshHistoryData } = require('./esi-market');
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
function createSplashWindow() {
  const splashWindow = new BrowserWindow({
    width: 700,
    height: 650,
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

  splashWindow.loadFile(path.join(__dirname, '../../public/splash.html'));

  return splashWindow;
}

function createWindow() {
  const windowBounds = getWindowBounds('main', { width: 1200, height: 800 });
  const version = app.getVersion();

  mainWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
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

  // Show window when ready to prevent white screen
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the index.html
  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'));

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

  // Prevent close if there are unsaved changes
  mainWindow.on('close', async (e) => {
    // Check if we're on the market page by checking the URL
    const currentUrl = mainWindow.webContents.getURL();

    if (currentUrl.includes('market.html')) {
      e.preventDefault();

      // Ask the renderer if there are unsaved changes
      mainWindow.webContents.send('market:checkUnsavedChanges');

      // Wait for response
      const hasUnsaved = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(false);
        }, 1000);

        ipcMain.once('market:unsavedChangesResponse', (event, hasChanges) => {
          clearTimeout(timeout);
          resolve(hasChanges);
        });
      });

      if (hasUnsaved) {
        const response = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Cancel', 'Close Without Saving'],
          defaultId: 0,
          cancelId: 0,
          title: 'Unsaved Changes',
          message: 'You have unsaved changes in Market Settings.',
          detail: 'Are you sure you want to close without saving?',
        });

        if (response.response === 1) {
          // User chose to close without saving
          mainWindow.destroy();
        }
        // If response is 0 (Cancel), the window stays open
      } else {
        // No unsaved changes, allow close
        mainWindow.destroy();
      }
    }
    // If not on market page, allow normal close
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Quit the app when main window is closed on all platforms
    app.quit();
  });

  // Initialize auto-updater after window is created
  initAutoUpdater(mainWindow);
}

app.whenReady().then(async () => {
  console.log('[App] Application ready');

  // Setup IPC handlers first (needed by both wizard and normal app)
  setupIPCHandlers();

  // Check if this is the first launch
  const settings = loadSettings();
  const isFirstLaunch = !settings.general.firstLaunchCompleted;

  if (isFirstLaunch) {
    console.log('[App] First launch detected, showing wizard...');

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
    await startNormalApplication();
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
  // Handle IPC for opening settings
  ipcMain.on('open-settings', () => {
    createSettingsWindow();
  });

  // Handle IPC for settings operations
  ipcMain.handle('settings:load', () => {
    return loadSettings();
  });

  ipcMain.handle('settings:save', (event, settings) => {
    return saveSettings(settings);
  });

  ipcMain.handle('settings:update', (event, category, updates) => {
    return updateSettings(category, updates);
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

  // Handle IPC for SDE management
  ipcMain.handle('sde:checkUpdate', async () => {
    try {
      return await checkUpdateRequired();
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
        updateSettings('sde', {
          validationStatus: {
            passed: result.validationResults.passed,
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
      updateSettings('sde', {
        validationStatus: {
          passed: result.passed,
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
      const success = updateCharacterSkills(characterId, skillsData);
      if (success) {
        return { success: true, skills: skillsData };
      } else {
        throw new Error('Failed to save skills');
      }
    } catch (error) {
      console.error('Skills fetch error:', error);
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

  ipcMain.handle('skills:openWindow', (event, characterId) => {
    const { createSkillsWindow } = require('./skills-window');
    createSkillsWindow(characterId);
  });

  // Handle IPC for blueprint management
  ipcMain.handle('blueprints:fetch', async (event, characterId) => {
    try {
      const blueprintsData = await fetchCharacterBlueprints(characterId);
      const success = updateCharacterBlueprints(characterId, blueprintsData);
      if (success) {
        return { success: true, blueprints: blueprintsData };
      } else {
        throw new Error('Failed to save blueprints');
      }
    } catch (error) {
      console.error('Blueprints fetch error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('blueprints:getAll', (event, characterId) => {
    return getBlueprints(characterId);
  });

  ipcMain.handle('blueprints:addManual', (event, blueprintData) => {
    return addManualBlueprint(blueprintData);
  });

  ipcMain.handle('blueprints:remove', (event, itemId) => {
    return removeBlueprint(itemId);
  });

  ipcMain.handle('blueprints:setOverride', (event, itemId, field, value) => {
    return setBlueprintOverride(itemId, field, value);
  });

  ipcMain.handle('blueprints:getEffectiveValues', (event, itemId) => {
    return getEffectiveBlueprintValues(itemId);
  });

  ipcMain.handle('blueprints:getCacheStatus', (event, characterId) => {
    return getBlueprintsCacheStatus(characterId);
  });

  ipcMain.handle('blueprints:openWindow', (event, characterId) => {
    const { createBlueprintsWindow } = require('./blueprints-window');
    createBlueprintsWindow(characterId);
  });

  // Manufacturing Summary Window
  ipcMain.handle('manufacturingSummary:openWindow', () => {
    const { createManufacturingSummaryWindow } = require('./manufacturing-summary-window');
    createManufacturingSummaryWindow();
  });

  ipcMain.handle('blueprints:openInCalculator', (event, blueprintTypeId, meLevel) => {
    // Focus or create main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      // Navigate to calculator page and send blueprint data
      mainWindow.loadFile(path.join(__dirname, '../../public/blueprint-calculator.html')).then(() => {
        // Wait for the DOM to be ready and listeners to be set up
        // Use a longer timeout to ensure initialization is complete
        setTimeout(() => {
          mainWindow.webContents.send('calculator:openBlueprint', { blueprintTypeId, meLevel });
        }, 500);
      });
    }
  });

  // Handle IPC for blueprint calculator
  const {
    searchBlueprints,
    calculateBlueprintMaterials,
    getBlueprintProduct,
    getTypeName,
    getOwnedBlueprintME
  } = require('./blueprint-calculator');

  ipcMain.handle('calculator:searchBlueprints', (event, searchTerm, limit) => {
    return searchBlueprints(searchTerm, limit);
  });

  ipcMain.handle('calculator:calculateMaterials', async (event, blueprintTypeId, runs, meLevel, characterId, facilityId) => {
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

    return await calculateBlueprintMaterials(blueprintTypeId, runs, meLevel, characterId, facility);
  });

  ipcMain.handle('calculator:getBlueprintProduct', (event, blueprintTypeId) => {
    return getBlueprintProduct(blueprintTypeId);
  });

  ipcMain.handle('calculator:getTypeName', (event, typeId) => {
    return getTypeName(typeId);
  });

  ipcMain.handle('calculator:getOwnedBlueprintME', (event, characterId, blueprintTypeId) => {
    return getOwnedBlueprintME(characterId, blueprintTypeId);
  });

  ipcMain.handle('calculator:getRigBonuses', (event, rigTypeId) => {
    const { getRigBonusesFromSDE } = require('./rig-bonuses');
    return getRigBonusesFromSDE(rigTypeId);
  });

  ipcMain.handle('calculator:getAllBlueprints', (event, limit) => {
    const { getAllBlueprints } = require('./blueprint-calculator');
    return getAllBlueprints(limit);
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

  ipcMain.handle('calculator:findBestDecryptor', async (event, inventionData, materialPrices, productPrice, skills, facility, optimizationStrategy, customVolume) => {
    console.log('[IPC Handler] Received optimizationStrategy:', optimizationStrategy, 'customVolume:', customVolume);

    const { findBestDecryptor, getDefaultFacility } = require('./blueprint-calculator');

    // Use provided facility or fall back to default facility
    const facilityToUse = facility || getDefaultFacility();

    // Default optimization strategy if not provided
    const strategy = optimizationStrategy || 'total-per-item';
    const volume = customVolume || 1;

    console.log('[IPC Handler] Using strategy:', strategy, 'volume:', volume);

    return await findBestDecryptor(inventionData, materialPrices, productPrice, skills, facilityToUse, strategy, volume);
  });

  // Handle IPC for market data operations
  ipcMain.handle('market:getSettings', () => {
    return getMarketSettings();
  });

  ipcMain.handle('market:updateSettings', (event, updates) => {
    return updateMarketSettings(updates);
  });

  ipcMain.handle('market:fetchOrders', async (event, regionId, typeId, locationFilter) => {
    try {
      return await fetchMarketOrders(regionId, typeId, locationFilter);
    } catch (error) {
      console.error('Error fetching market orders:', error);
      return [];
    }
  });

  ipcMain.handle('market:fetchHistory', async (event, regionId, typeId) => {
    try {
      return await fetchMarketHistory(regionId, typeId);
    } catch (error) {
      console.error('Error fetching market history:', error);
      return [];
    }
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

  ipcMain.handle('market:calculatePrice', async (event, typeId, regionId, locationId, priceType, quantity) => {
    try {
      const settings = getMarketSettings();
      return await calculateRealisticPrice(typeId, regionId, locationId, priceType, quantity, settings);
    } catch (error) {
      console.error('Error calculating realistic price:', error);
      return { price: 0, confidence: 'none', warning: 'Error calculating price' };
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

  ipcMain.handle('facilities:getStructureRigs', async () => {
    return await getStructureRigs();
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

  // Wizard IPC handlers
  ipcMain.handle('wizard:skipSetup', async () => {
    try {
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

  // Auto-updater IPC handler
  ipcMain.handle('app:checkForUpdates', async () => {
    checkForUpdates();
  });

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
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
