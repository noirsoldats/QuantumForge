const { ipcMain } = require('electron');
const { initializeMarketDatabase } = require('./market-database');
const { checkUpdateRequired, sdeExists, downloadAndValidateSDE, getSdePath } = require('./sde-manager');
const { loadSettings, updateSettings } = require('./settings-manager');
const { needsMigration, migrateToGitHub } = require('./sde-source-migration');

/**
 * Orchestrates all startup checks and initialization
 * @param {BrowserWindow} splashWindow - The splash screen window
 * @returns {Promise<boolean>} - True if startup completed successfully
 */
async function runStartupChecks(splashWindow) {
  console.log('[Startup] Beginning startup checks...');

  try {
    // Step 1: Initialize Market Database
    await runDatabaseInit(splashWindow);

    // Step 2: Check for Application Updates
    await runAppUpdateCheck(splashWindow);

    // Step 2.5: Migrate SDE source if needed (silent migration)
    await runSDEMigration(splashWindow);

    // Step 3: Check SDE Status
    await runSDECheck(splashWindow);

    // Step 4: Validate SDE (if needed)
    await runSDEValidation(splashWindow);

    // Step 5: Refresh Character Data (if cache expired)
    await runCharacterDataRefresh(splashWindow);

    // All checks complete
    console.log('[Startup] All checks completed successfully');
    splashWindow.webContents.send('startup:complete');
    return true;

  } catch (error) {
    console.error('[Startup] Error during startup checks:', error);
    splashWindow.webContents.send('startup:error', {
      task: 'startup',
      message: error.message || 'An unexpected error occurred',
      retryable: true,
    });
    return false;
  }
}

/**
 * Step 1: Initialize Market Database
 */
async function runDatabaseInit(splashWindow) {
  console.log('[Startup] Initializing market database...');

  splashWindow.webContents.send('startup:progress', {
    task: 'database',
    status: 'Initializing market database...',
    complete: null,
  });

  try {
    initializeMarketDatabase();

    splashWindow.webContents.send('startup:progress', {
      task: 'database',
      status: 'Database ready',
      complete: true,
    });

    console.log('[Startup] Market database initialized');
  } catch (error) {
    console.error('[Startup] Database initialization failed:', error);
    splashWindow.webContents.send('startup:progress', {
      task: 'database',
      status: 'Database initialization failed',
      complete: false,
    });
    throw new Error('Failed to initialize database: ' + error.message);
  }
}

/**
 * Step 2: Check for Application Updates
 */
async function runAppUpdateCheck(splashWindow) {
  console.log('[Startup] Checking for application updates...');

  // Skip in development mode
  if (process.env.NODE_ENV === 'development') {
    console.log('[Startup] Skipping update check in development mode');
    splashWindow.webContents.send('startup:progress', {
      task: 'appUpdate',
      status: 'Development mode',
      complete: true,
    });
    return;
  }

  splashWindow.webContents.send('startup:progress', {
    task: 'appUpdate',
    status: 'Checking for application updates...',
    complete: null,
  });

  try {
    const { autoUpdater } = require('electron-updater');
    const log = require('electron-log');
    const { app } = require('electron');

    // Check if app is packed - if not, skip update check immediately
    if (!app.isPackaged) {
      console.log('[Startup] Skipping update check - application not packaged');
      splashWindow.webContents.send('startup:progress', {
        task: 'appUpdate',
        status: 'Development mode',
        complete: true,
      });
      return;
    }

    // Configure auto-updater for startup check
    autoUpdater.autoDownload = false;
    autoUpdater.logger = log;

    const updateCheckResult = await new Promise((resolve) => {
      let resolved = false;

      // Set up one-time event listeners
      const cleanup = () => {
        autoUpdater.removeAllListeners('update-available');
        autoUpdater.removeAllListeners('update-not-available');
        autoUpdater.removeAllListeners('error');
      };

      autoUpdater.once('update-available', (info) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ available: true, info });
        }
      });

      autoUpdater.once('update-not-available', (info) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ available: false, info });
        }
      });

      autoUpdater.once('error', (err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          log.error('[Startup] Update check error:', err);
          resolve({ error: true, message: err.message });
        }
      });

      // Start the check with a timeout
      autoUpdater.checkForUpdates().catch(err => {
        if (!resolved) {
          resolved = true;
          cleanup();
          log.error('[Startup] Update check failed:', err);
          resolve({ error: true, message: err.message });
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ timeout: true });
        }
      }, 10000);
    });

    if (updateCheckResult.error) {
      splashWindow.webContents.send('startup:progress', {
        task: 'appUpdate',
        status: 'Check failed (continuing)',
        complete: true,
      });
      console.log('[Startup] Update check failed, continuing anyway');
    } else if (updateCheckResult.timeout) {
      splashWindow.webContents.send('startup:progress', {
        task: 'appUpdate',
        status: 'Check timed out (continuing)',
        complete: true,
      });
      console.log('[Startup] Update check timed out, continuing anyway');
    } else if (updateCheckResult.available) {
      console.log('[Startup] Update available:', updateCheckResult.info.version);

      splashWindow.webContents.send('startup:progress', {
        task: 'appUpdate',
        status: `Update available: v${updateCheckResult.info.version}`,
        complete: true,
      });

      // Show update dialog immediately
      const { dialog } = require('electron');
      const userWantsUpdate = await new Promise((resolve) => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Update Available',
          message: `A new version (${updateCheckResult.info.version}) is available!`,
          detail: 'Would you like to download it now? The update will be installed when you close the application.',
          buttons: ['Download Now', 'Later'],
          defaultId: 0,
          cancelId: 1,
        }).then(result => {
          resolve(result.response === 0);
        });
      });

      if (userWantsUpdate) {
        console.log('[Startup] User chose to download update');
        splashWindow.webContents.send('startup:progress', {
          task: 'appUpdate',
          status: 'Downloading update...',
          complete: null,
        });

        try {
          // Download the update
          await downloadUpdate(splashWindow, autoUpdater);

          splashWindow.webContents.send('startup:progress', {
            task: 'appUpdate',
            status: 'Update downloaded (will install on quit)',
            complete: true,
          });
        } catch (downloadError) {
          console.error('[Startup] Update download failed:', downloadError);
          splashWindow.webContents.send('startup:progress', {
            task: 'appUpdate',
            status: 'Download failed (continuing)',
            complete: true,
          });
        }
      } else {
        console.log('[Startup] User chose to skip update');
      }
    } else {
      splashWindow.webContents.send('startup:progress', {
        task: 'appUpdate',
        status: 'Up to date',
        complete: true,
      });
      console.log('[Startup] Application is up to date');
    }
  } catch (error) {
    console.error('[Startup] Unexpected error during update check:', error);
    splashWindow.webContents.send('startup:progress', {
      task: 'appUpdate',
      status: 'Check failed (continuing)',
      complete: true,
    });
  }
}

/**
 * Download application update with progress
 */
async function downloadUpdate(splashWindow, autoUpdater) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Listen for download progress
    const progressHandler = (progressObj) => {
      splashWindow.webContents.send('startup:progress', {
        task: 'appUpdate',
        status: `Downloading update... ${Math.round(progressObj.percent)}%`,
        percentage: progressObj.percent,
        complete: null,
      });
    };

    autoUpdater.on('download-progress', progressHandler);

    // Listen for download complete
    autoUpdater.once('update-downloaded', (info) => {
      if (!resolved) {
        resolved = true;
        autoUpdater.removeListener('download-progress', progressHandler);
        console.log('[Startup] Update downloaded:', info.version);

        // Store that update is ready to install
        global.updateReadyToInstall = true;

        resolve();
      }
    });

    // Listen for download error
    autoUpdater.once('error', (err) => {
      if (!resolved) {
        resolved = true;
        autoUpdater.removeListener('download-progress', progressHandler);
        console.error('[Startup] Update download error:', err);
        reject(err);
      }
    });

    // Start download
    autoUpdater.downloadUpdate().catch(err => {
      if (!resolved) {
        resolved = true;
        autoUpdater.removeListener('download-progress', progressHandler);
        reject(err);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        autoUpdater.removeListener('download-progress', progressHandler);
        reject(new Error('Download timeout'));
      }
    }, 300000);
  });
}

/**
 * Step 2.5: Migrate SDE Source (Silent Migration)
 */
async function runSDEMigration(splashWindow) {
  // Check if migration is needed
  if (!needsMigration()) {
    console.log('[Startup] No SDE migration needed');
    return;
  }

  console.log('[Startup] SDE migration required (Fuzzwork → GitHub)');

  splashWindow.webContents.send('startup:progress', {
    task: 'sdeMigration',
    status: 'Migrating SDE source...',
    complete: null,
  });

  try {
    const result = await migrateToGitHub((progress) => {
      // Forward migration progress
      splashWindow.webContents.send('startup:progress', {
        task: 'sdeMigration',
        status: progress.message || `Migrating SDE... ${progress.percent || 0}%`,
        percentage: progress.percent,
        complete: null,
      });
    });

    if (result.success) {
      console.log('[Startup] SDE migration completed successfully');
      splashWindow.webContents.send('startup:progress', {
        task: 'sdeMigration',
        status: result.message || 'Migration complete',
        complete: true,
      });
    } else if (result.skipped) {
      // Migration skipped (e.g., GitHub unavailable) - continue with existing SDE
      console.log('[Startup] SDE migration skipped:', result.reason);
      splashWindow.webContents.send('startup:progress', {
        task: 'sdeMigration',
        status: 'Migration skipped (will retry later)',
        complete: true,
      });
    } else {
      // Migration failed but not critical - continue with existing SDE
      console.error('[Startup] SDE migration failed:', result.error);
      splashWindow.webContents.send('startup:progress', {
        task: 'sdeMigration',
        status: 'Migration failed (using current SDE)',
        complete: true,
      });
    }
  } catch (error) {
    // Migration error - not critical, continue with existing SDE
    console.error('[Startup] SDE migration error:', error);
    splashWindow.webContents.send('startup:progress', {
      task: 'sdeMigration',
      status: 'Migration error (using current SDE)',
      complete: true,
    });
  }
}

/**
 * Step 3: Check SDE Status
 */
async function runSDECheck(splashWindow) {
  console.log('[Startup] Checking SDE status...');

  splashWindow.webContents.send('startup:progress', {
    task: 'sdeCheck',
    status: 'Checking Static Data Export...',
    complete: null,
  });

  // Check if SDE exists
  if (!sdeExists()) {
    console.log('[Startup] SDE not found - user must download');

    splashWindow.webContents.send('startup:progress', {
      task: 'sdeCheck',
      status: 'SDE not found',
      complete: false,
    });

    // Require user to download
    await requireSDEDownload(splashWindow, { isMissing: true });
    return;
  }

  // Check for updates with timeout handling
  let updateStatus;
  try {
    updateStatus = await checkUpdateRequired();
    console.log('[Startup] SDE update status:', updateStatus);
  } catch (error) {
    // Check if it's a network timeout or connection error
    const isNetworkError = error.message?.includes('timeout') ||
                          error.message?.includes('ETIMEDOUT') ||
                          error.message?.includes('Failed to connect') ||
                          error.message?.includes('fetch failed') ||
                          error.message?.includes('rate limit');

    if (isNetworkError) {
      console.warn('[Startup] Network error checking SDE updates, continuing with current SDE:', error.message);
      splashWindow.webContents.send('startup:warning', {
        task: 'sdeCheck',
        message: 'Network timeout - unable to check for SDE updates. You can check manually in settings.',
      });
      splashWindow.webContents.send('startup:progress', {
        task: 'sdeCheck',
        status: 'Update check timed out (continuing)',
        complete: true,
      });
      return;
    } else {
      // Other error, re-throw
      throw error;
    }
  }

  if (updateStatus.needsUpdate) {
    if (updateStatus.isCritical) {
      // Critical update required
      console.log('[Startup] Critical SDE update required');

      splashWindow.webContents.send('startup:progress', {
        task: 'sdeCheck',
        status: 'Critical update required',
        complete: false,
      });

      await requireSDEDownload(splashWindow, {
        isCritical: true,
        currentVersion: updateStatus.currentVersion,
        latestVersion: updateStatus.latestVersion,
      });
    } else {
      // Optional update available
      console.log('[Startup] Optional SDE update available');

      splashWindow.webContents.send('startup:progress', {
        task: 'sdeCheck',
        status: 'Update available',
        complete: null,
      });

      const userWantsUpdate = await offerSDEUpdate(splashWindow, {
        currentVersion: updateStatus.currentVersion,
        latestVersion: updateStatus.latestVersion,
      });

      if (!userWantsUpdate) {
        // User skipped - mark as complete
        splashWindow.webContents.send('startup:progress', {
          task: 'sdeCheck',
          status: 'Update skipped',
          complete: true,
        });
        return;
      }
    }
  } else {
    // SDE is up to date
    splashWindow.webContents.send('startup:progress', {
      task: 'sdeCheck',
      status: 'Up to date',
      complete: true,
    });
    console.log('[Startup] SDE is up to date');
  }
}

/**
 * Require SDE download (blocking - no skip option)
 */
async function requireSDEDownload(splashWindow, data) {
  console.log('[Startup] Requiring SDE download:', data);

  return new Promise((resolve) => {
    // Send action required event
    if (data.isMissing) {
      splashWindow.webContents.send('startup:requireAction', {
        action: 'sdeDownload',
        data: {
          size: 50 * 1024 * 1024, // Approximate 50MB (GitHub stripped version)
        },
      });
    } else if (data.isCritical) {
      splashWindow.webContents.send('startup:requireAction', {
        action: 'sdeCritical',
        data: {
          currentVersion: data.currentVersion,
          latestVersion: data.latestVersion,
        },
      });
    }

    // Wait for user to click download
    ipcMain.once('startup:downloadSDE', async () => {
      console.log('[Startup] User initiated SDE download');
      await performSDEDownload(splashWindow);
      resolve();
    });
  });
}

/**
 * Offer SDE update (non-blocking - can skip)
 */
async function offerSDEUpdate(splashWindow, data) {
  console.log('[Startup] Offering SDE update:', data);

  return new Promise((resolve) => {
    // Send action required event
    splashWindow.webContents.send('startup:requireAction', {
      action: 'sdeOptional',
      data: {
        currentVersion: data.currentVersion,
        latestVersion: data.latestVersion,
      },
    });

    // Wait for user decision
    ipcMain.once('startup:downloadSDE', async () => {
      console.log('[Startup] User chose to update SDE');
      await performSDEDownload(splashWindow);
      resolve(true);
    });

    ipcMain.once('startup:skipSDEUpdate', () => {
      console.log('[Startup] User skipped SDE update');
      resolve(false);
    });
  });
}

/**
 * Perform SDE download with progress updates
 */
async function performSDEDownload(splashWindow) {
  console.log('[Startup] Starting SDE download...');

  // Show download task
  splashWindow.webContents.send('startup:progress', {
    task: 'sdeDownload',
    status: 'Preparing download...',
    percentage: 0,
    complete: null,
  });

  // Mark sdeCheck as complete since we're now downloading
  splashWindow.webContents.send('startup:progress', {
    task: 'sdeCheck',
    status: 'Update initiated',
    complete: true,
  });

  try {
    // Download and validate with progress callback
    await downloadAndValidateSDE((progress) => {
      // Map the progress from downloadAndValidateSDE to splash screen format
      let status = 'Downloading...';
      let percentage = progress.percent || 0;

      switch (progress.stage) {
        case 'downloading':
          status = progress.message || 'Downloading SDE...';
          break;
        case 'decompressing':
          status = 'Decompressing database...';
          break;
        case 'validating':
          status = 'Validating database...';
          break;
        case 'backing up':
          status = 'Backing up current SDE...';
          break;
        case 'installing':
          status = 'Installing new SDE...';
          break;
        case 'complete':
          status = 'SDE update complete';
          percentage = 100;
          break;
      }

      splashWindow.webContents.send('startup:progress', {
        task: 'sdeDownload',
        status: status,
        percentage: percentage,
        complete: null,
      });
    });

    // Mark as complete
    splashWindow.webContents.send('startup:progress', {
      task: 'sdeDownload',
      status: 'Download complete',
      percentage: 100,
      complete: true,
    });

    console.log('[Startup] SDE download completed');

  } catch (error) {
    console.error('[Startup] SDE download failed:', error);

    splashWindow.webContents.send('startup:progress', {
      task: 'sdeDownload',
      status: 'Download failed',
      complete: false,
    });

    throw new Error('SDE download failed: ' + error.message);
  }
}

/**
 * Step 4: Validate SDE (if needed)
 */
async function runSDEValidation(splashWindow) {
  const settings = loadSettings();

  // Skip validation if already validated
  if (settings.sde?.validationStatus?.passed) {
    console.log('[Startup] SDE already validated, skipping');
    splashWindow.webContents.send('startup:progress', {
      task: 'sdeValidate',
      status: 'Previously validated',
      complete: true,
    });
    return;
  }

  console.log('[Startup] Running SDE validation...');

  splashWindow.webContents.send('startup:progress', {
    task: 'sdeValidate',
    status: 'Validating SDE...',
    complete: null,
  });

  try {
    const { quickValidate } = require('./sde-validator');
    const { getSdePath } = require('./sde-manager');

    const result = await quickValidate(getSdePath());

    if (result.passed) {
      // Save validation status
      updateSettings('sde', {
        validationStatus: {
          passed: true,
          date: new Date().toISOString(),
          summary: 'Quick validation passed',
          totalChecks: 1,
        },
      });

      splashWindow.webContents.send('startup:progress', {
        task: 'sdeValidate',
        status: 'Validation passed',
        complete: true,
      });

      console.log('[Startup] SDE validation passed');
    } else {
      // Validation failed but don't block - user can fix in settings
      console.warn('[Startup] SDE validation failed, but allowing to continue');

      splashWindow.webContents.send('startup:progress', {
        task: 'sdeValidate',
        status: 'Validation warning (check settings)',
        complete: true,
      });
    }
  } catch (error) {
    console.error('[Startup] Validation error:', error);
    // Don't block on validation errors
    splashWindow.webContents.send('startup:progress', {
      task: 'sdeValidate',
      status: 'Validation skipped',
      complete: true,
    });
  }
}

/**
 * Step 5: Refresh Character Data (Skills and Blueprints)
 */
async function runCharacterDataRefresh(splashWindow) {
  console.log('[Startup] Checking character data cache status...');

  splashWindow.webContents.send('startup:progress', {
    task: 'characterData',
    status: 'Checking character data...',
    complete: null,
  });

  try {
    const { getCharacters, getSkillsCacheStatus, getBlueprintsCacheStatus, getSetting, updateCharacterSkills, updateCharacterBlueprints } = require('./settings-manager');
    const { fetchCharacterSkills } = require('./esi-skills');
    const { fetchCharacterBlueprints } = require('./esi-blueprints');
    const { fetchCharacterAssets, fetchCorporationAssets, saveAssets, getAssetsCacheStatus } = require('./esi-assets');

    // Check if auto-update is enabled (handle both old boolean and new object format)
    const autoUpdateSetting = getSetting('general', 'autoUpdateCharacterData');
    let autoUpdateEnabled = {
      skills: false,
      blueprints: false,
      assets: false
    };

    // Handle legacy boolean format
    if (typeof autoUpdateSetting === 'boolean') {
      autoUpdateEnabled.skills = autoUpdateSetting;
      autoUpdateEnabled.blueprints = autoUpdateSetting;
      autoUpdateEnabled.assets = autoUpdateSetting;
    } else if (typeof autoUpdateSetting === 'object' && autoUpdateSetting !== null) {
      // New object format
      autoUpdateEnabled = {
        skills: autoUpdateSetting.skills !== false,
        blueprints: autoUpdateSetting.blueprints !== false,
        assets: autoUpdateSetting.assets !== false
      };
    }

    if (!autoUpdateEnabled.skills && !autoUpdateEnabled.blueprints && !autoUpdateEnabled.assets) {
      console.log('[Startup] All auto-update options disabled, skipping');
      splashWindow.webContents.send('startup:progress', {
        task: 'characterData',
        status: 'Auto-update disabled',
        complete: true,
      });
      return;
    }

    const characters = getCharacters();

    if (!characters || characters.length === 0) {
      console.log('[Startup] No characters found, skipping data refresh');
      splashWindow.webContents.send('startup:progress', {
        task: 'characterData',
        status: 'No characters',
        complete: true,
      });
      return;
    }

    // Check which characters need refresh
    const charactersNeedingRefresh = [];

    for (const character of characters) {
      const skillsCache = getSkillsCacheStatus(character.characterId);
      const blueprintsCache = getBlueprintsCacheStatus(character.characterId);
      const characterAssetsCache = getAssetsCacheStatus(character.characterId, false);
      const corpAssetsCache = character.corporationId
        ? getAssetsCacheStatus(character.characterId, true)
        : { isCached: true };

      const needsSkillsRefresh = autoUpdateEnabled.skills && !skillsCache.isCached;
      const needsBlueprintsRefresh = autoUpdateEnabled.blueprints && !blueprintsCache.isCached;
      const needsCharacterAssetsRefresh = autoUpdateEnabled.assets && !characterAssetsCache.isCached;
      const needsCorpAssetsRefresh = autoUpdateEnabled.assets && character.corporationId && !corpAssetsCache.isCached;

      if (needsSkillsRefresh || needsBlueprintsRefresh || needsCharacterAssetsRefresh || needsCorpAssetsRefresh) {
        charactersNeedingRefresh.push({
          character,
          needsSkillsRefresh,
          needsBlueprintsRefresh,
          needsCharacterAssetsRefresh,
          needsCorpAssetsRefresh,
        });
      }
    }

    if (charactersNeedingRefresh.length === 0) {
      console.log('[Startup] All character data is up to date');
      splashWindow.webContents.send('startup:progress', {
        task: 'characterData',
        status: 'Data up to date',
        complete: true,
      });
      return;
    }

    console.log(`[Startup] Refreshing data for ${charactersNeedingRefresh.length} character(s)`);

    let completed = 0;
    let failed = 0;
    const total = charactersNeedingRefresh.length;

    for (const { character, needsSkillsRefresh, needsBlueprintsRefresh, needsCharacterAssetsRefresh, needsCorpAssetsRefresh } of charactersNeedingRefresh) {
      const charName = character.characterName || character.name || `Character ${character.characterId}`;

      try {
        // Calculate total steps for this character for progress tracking
        let totalSteps = 0;
        if (needsSkillsRefresh) totalSteps++;
        if (needsBlueprintsRefresh) totalSteps++;
        if (needsCharacterAssetsRefresh) totalSteps++;
        if (needsCorpAssetsRefresh) totalSteps++;

        let currentStep = 0;

        // Refresh skills if needed
        if (needsSkillsRefresh) {
          console.log(`[Startup] Refreshing skills for ${charName}`);
          splashWindow.webContents.send('startup:progress', {
            task: 'characterData',
            status: `Fetching skills for ${charName}...`,
            percentage: Math.round(((completed + (currentStep / totalSteps)) / total) * 100),
            complete: null,
          });

          const skillsData = await fetchCharacterSkills(character.characterId);
          updateCharacterSkills(character.characterId, skillsData);
          currentStep++;
        }

        // Refresh blueprints if needed
        if (needsBlueprintsRefresh) {
          console.log(`[Startup] Refreshing blueprints for ${charName}`);
          splashWindow.webContents.send('startup:progress', {
            task: 'characterData',
            status: `Fetching blueprints for ${charName}...`,
            percentage: Math.round(((completed + (currentStep / totalSteps)) / total) * 100),
            complete: null,
          });

          const blueprintsData = await fetchCharacterBlueprints(character.characterId);
          updateCharacterBlueprints(character.characterId, blueprintsData);
          currentStep++;
        }

        // Refresh character assets if needed
        if (needsCharacterAssetsRefresh) {
          console.log(`[Startup] Refreshing assets for ${charName}`);
          splashWindow.webContents.send('startup:progress', {
            task: 'characterData',
            status: `Fetching assets for ${charName}...`,
            percentage: Math.round(((completed + (currentStep / totalSteps)) / total) * 100),
            complete: null,
          });

          const characterAssetsData = await fetchCharacterAssets(character.characterId);
          saveAssets(characterAssetsData);
          currentStep++;
        }

        // Refresh corporation assets if needed
        if (needsCorpAssetsRefresh) {
          console.log(`[Startup] Refreshing corporation assets for ${charName}`);
          splashWindow.webContents.send('startup:progress', {
            task: 'characterData',
            status: `Fetching corporation assets for ${charName}...`,
            percentage: Math.round(((completed + (currentStep / totalSteps)) / total) * 100),
            complete: null,
          });

          const corpAssetsData = await fetchCorporationAssets(character.characterId, character.corporationId);
          saveAssets(corpAssetsData);
          currentStep++;
        }

        completed++;

        splashWindow.webContents.send('startup:progress', {
          task: 'characterData',
          status: `Updated ${charName}`,
          percentage: Math.round((completed / total) * 100),
          complete: null,
        });

      } catch (error) {
        console.error(`[Startup] Failed to refresh data for ${charName}:`, error);

        // Check if it's a network timeout error
        const isTimeoutError = error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                               error.message?.includes('timeout') ||
                               error.message?.includes('ETIMEDOUT') ||
                               error.message?.includes('fetch failed');

        if (isTimeoutError) {
          console.warn(`[Startup] Network timeout for ${charName}, skipping to continue startup`);
          splashWindow.webContents.send('startup:warning', {
            task: 'characterData',
            character: charName,
            message: 'Network timeout - unable to refresh character data. You can retry later from the character menu.',
          });
          failed++;
        } else {
          // Other error, increment failed count
          failed++;
        }

        // Continue with other characters even if one fails
      }
    }

    // Send final status
    const statusMessage = failed > 0
      ? `Refreshed ${completed} character(s), ${failed} failed due to network issues`
      : `Refreshed ${completed} character(s)`;

    splashWindow.webContents.send('startup:progress', {
      task: 'characterData',
      status: statusMessage,
      complete: true,
      hasWarnings: failed > 0,
    });

    console.log('[Startup] Character data refresh completed');

  } catch (error) {
    console.error('[Startup] Error during character data refresh:', error);
    // Don't block startup on data refresh errors
    splashWindow.webContents.send('startup:progress', {
      task: 'characterData',
      status: 'Refresh skipped',
      complete: true,
    });
  }
}

module.exports = {
  runStartupChecks,
};
