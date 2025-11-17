const { BrowserWindow } = require('electron');
const path = require('path');

let wizardWindow = null;

/**
 * Create and show the setup wizard window
 * @returns {BrowserWindow} The wizard window instance
 */
function createWizardWindow() {
  if (wizardWindow) {
    wizardWindow.focus();
    return wizardWindow;
  }

  wizardWindow = new BrowserWindow({
    width: 800,
    height: 800,
    frame: false,
    resizable: false,
    center: true,
    modal: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#1e1e2e',
    title: 'Quantum Forge Setup Wizard',
  });

  wizardWindow.loadFile(path.join(__dirname, '../../public/wizard.html'));

  // Show window when ready
  wizardWindow.once('ready-to-show', () => {
    wizardWindow.show();
  });

  // Clean up reference when window is closed
  wizardWindow.on('closed', () => {
    wizardWindow = null;
  });

  return wizardWindow;
}

/**
 * Close the wizard window
 */
function closeWizardWindow() {
  if (wizardWindow) {
    wizardWindow.close();
    wizardWindow = null;
  }
}

/**
 * Get the current wizard window instance
 * @returns {BrowserWindow|null}
 */
function getWizardWindow() {
  return wizardWindow;
}

module.exports = {
  createWizardWindow,
  closeWizardWindow,
  getWizardWindow,
};
