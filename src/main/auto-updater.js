const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');
const log = require('electron-log');

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Configure auto-updater
autoUpdater.autoDownload = false; // Don't auto-download, ask user first
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow = null;

/**
 * Initialize auto-updater with the main window reference
 * @param {BrowserWindow} window - Main window instance
 */
function initAutoUpdater(window) {
  mainWindow = window;

  // Set up auto-updater event listeners
  setupAutoUpdaterEvents();

  // Check if update was downloaded during startup
  if (global.updateReadyToInstall) {
    log.info('Update was downloaded during startup and is ready to install');

    // Show notification after a short delay
    setTimeout(() => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'An update has been downloaded and will be installed when you close the application.',
        detail: 'You can continue working - the update will be applied automatically on next restart.',
        buttons: ['OK', 'Restart Now'],
        defaultId: 0,
        cancelId: 0
      }).then(result => {
        if (result.response === 1) {
          // User wants to restart now
          const { autoUpdater } = require('electron-updater');
          autoUpdater.quitAndInstall(false, true);
        }
      });

      delete global.updateReadyToInstall; // Clear the flag
    }, 2000);
  }
}

/**
 * Manually check for updates
 */
function checkForUpdates() {
  if (process.env.NODE_ENV === 'development') {
    log.info('Skipping update check in development mode');
    return;
  }

  autoUpdater.checkForUpdates().catch(err => {
    log.error('Error checking for updates:', err);
  });
}

/**
 * Show update dialog to user
 * @param {Object} info - Update info
 */
function showUpdateDialog(info) {
  if (mainWindow) {
    mainWindow.webContents.send('update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    });
  }

  // Show dialog asking user if they want to download
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `A new version (${info.version}) is available!`,
    detail: 'Would you like to download it now? The update will be installed when you close the application.',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });
}

/**
 * Set up auto-updater event listeners
 */
function setupAutoUpdaterEvents() {
  // When update is available
  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info);
    showUpdateDialog(info);
  });

  // When no update is available
  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available:', info);

    if (mainWindow) {
      mainWindow.webContents.send('update-not-available');
    }
  });

  // Download progress
  autoUpdater.on('download-progress', (progressObj) => {
    log.info('Download progress:', progressObj);

    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', {
        percent: progressObj.percent,
        bytesPerSecond: progressObj.bytesPerSecond,
        transferred: progressObj.transferred,
        total: progressObj.total
      });
    }
  });

  // When update is downloaded
  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info);

    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', {
        version: info.version
      });
    }

    // Show dialog that update is ready to install
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you close the application. You can continue working - the update will be applied automatically on next restart.',
      buttons: ['OK', 'Restart Now'],
      defaultId: 0,
      cancelId: 0
    }).then(result => {
      if (result.response === 1) {
        // User wants to restart now
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  // Error handling
  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err);

    if (mainWindow) {
      mainWindow.webContents.send('update-error', {
        message: err.message
      });
    }
  });
}

module.exports = {
  initAutoUpdater,
  checkForUpdates
};
