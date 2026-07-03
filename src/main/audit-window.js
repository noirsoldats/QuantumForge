const { BrowserWindow, app } = require('electron');
const path = require('path');
const { getWindowBounds, trackWindowState } = require('./window-state-manager');
const { setAuditWindow } = require('./audit-recorder');

let auditWindow = null;

function createAuditWindow() {
  if (auditWindow) {
    auditWindow.focus();
    return;
  }

  const windowBounds = getWindowBounds('audit-log', { width: 1100, height: 700 });
  const version = app.getVersion();

  auditWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
    backgroundColor: '#1e1e2e',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableWebSQL: false,
    },
    title: `Audit Log - Quantum Forge v${version}`,
    parent: null,
    modal: false,
  });

  trackWindowState(auditWindow, 'audit-log');

  auditWindow.once('ready-to-show', () => {
    auditWindow.show();
  });

  auditWindow.loadFile(path.join(__dirname, '../../public/audit-log.html'));

  if (process.env.NODE_ENV === 'development') {
    auditWindow.webContents.openDevTools();
  }

  setAuditWindow(auditWindow.webContents);

  auditWindow.on('closed', () => {
    setAuditWindow(null);
    auditWindow = null;
  });
}

function getAuditWindow() {
  return auditWindow;
}

module.exports = {
  createAuditWindow,
  getAuditWindow,
};
