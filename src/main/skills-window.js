const { BrowserWindow } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');

const skillsWindows = new Map();

function createSkillsWindow(characterId) {
  // If skills window already exists for this character, focus it
  if (skillsWindows.has(characterId)) {
    const existingWindow = skillsWindows.get(characterId);
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus();
      return;
    }
  }

  // Use character-specific window state
  const windowName = `skills-${characterId}`;
  const windowBounds = getWindowBounds(windowName, { width: 1000, height: 700 });

  const skillsWindow = new BrowserWindow({
    ...windowBounds,
    show: false, // Don't show until ready
    backgroundColor: '#1e1e2e', // Prevents white flash on Windows
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
      additionalArguments: [`--character-id=${characterId}`],
    },
    title: 'Skills Manager - Quantum Forge',
    modal: false,
  });

  // Track window state changes with character-specific name
  trackWindowState(skillsWindow, windowName);

  // Show window when ready to prevent white screen
  skillsWindow.once('ready-to-show', () => {
    skillsWindow.show();
  });

  skillsWindow.loadFile(path.join(__dirname, '../../public/skills.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    skillsWindow.webContents.openDevTools();
  }

  // Pass character ID to the window once it's loaded
  skillsWindow.webContents.on('did-finish-load', () => {
    skillsWindow.webContents.send('skills:set-character-id', characterId);
  });

  skillsWindow.on('closed', () => {
    skillsWindows.delete(characterId);
  });

  skillsWindows.set(characterId, skillsWindow);
}

function getSkillsWindow(characterId) {
  return skillsWindows.get(characterId);
}

module.exports = {
  createSkillsWindow,
  getSkillsWindow,
};
