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
    // Exactly the card in wizard.css: 820x720. It was 800x800 - NARROWER than
    // the 820px card, which `max-width: 100%` then squeezed, and 80px taller
    // than it, which left a margin below.
    //
    // Deliberately NOT sized to content like the splash: the eight steps differ
    // enormously in height (step 5 is roughly ten times step 1), so a
    // content-sized window would resize and re-centre on every Next click. The
    // card is a fixed frame and `.wizard-content` scrolls inside it, which is
    // what the mockup specifies.
    width: 820,
    height: 720,
    useContentSize: true, // dimensions are CONTENT, ignoring any frame
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
