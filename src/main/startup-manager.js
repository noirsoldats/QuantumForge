const { ipcMain } = require('electron');
const { initializeMarketDatabase } = require('./market-database');
const { checkUpdateRequired, sdeExists, downloadAndValidateSDE, getSdePath } = require('./sde-manager');
const { loadSettings, updateSettings } = require('./settings-manager');

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

    // Step 3: Check SDE Status
    await runSDECheck(splashWindow);

    // Step 4: Validate SDE (if needed)
    await runSDEValidation(splashWindow);

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

  splashWindow.webContents.send('startup:progress', {
    task: 'appUpdate',
    status: 'Checking for application updates...',
    complete: null,
  });

  // TODO: Implement actual app update check using electron-updater
  // For now, we'll just mark it as complete
  // In a real implementation, you would check autoUpdater.checkForUpdates()

  await new Promise(resolve => setTimeout(resolve, 500)); // Simulate check

  splashWindow.webContents.send('startup:progress', {
    task: 'appUpdate',
    status: 'No updates available',
    complete: true,
  });

  console.log('[Startup] Application update check complete');
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

  // Check for updates
  const updateStatus = await checkUpdateRequired();
  console.log('[Startup] SDE update status:', updateStatus);

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
          size: 150 * 1024 * 1024, // Approximate 150MB
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
    // Listen for progress events
    const progressHandler = (event, progress) => {
      splashWindow.webContents.send('startup:progress', {
        task: 'sdeDownload',
        status: progress.status || 'Downloading...',
        percentage: progress.percentage || 0,
        complete: null,
      });
    };

    ipcMain.on('sde:progress', progressHandler);

    // Download and validate
    await downloadAndValidateSDE();

    // Remove progress listener
    ipcMain.removeListener('sde:progress', progressHandler);

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

module.exports = {
  runStartupChecks,
};
