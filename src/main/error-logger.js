/**
 * Centralized error logging module for Quantum Forge
 * Uses electron-log for persistent logging with rotation
 */

const log = require('electron-log');
const { app } = require('electron');
const path = require('path');
const os = require('os');
const { getDataPath, isPortable } = require('./portable-mode');

// Track initialization state
let isInitialized = false;
let startupPhase = 'pre-init';

/**
 * Initialize the logging system
 * Should be called at the very start of the application
 */
function initializeLogging() {
  if (isInitialized) {
    return;
  }

  // Configure log file location (portable-aware)
  const userDataPath = getDataPath();
  const logDir = path.join(userDataPath, 'logs');

  // Configure electron-log
  log.transports.file.resolvePathFn = () => path.join(logDir, 'quantum-forge.log');

  // Log rotation settings: 5MB max, keep 5 files
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB

  // Log format
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

  // Also log to console in development
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn';

  // Enable file logging
  log.transports.file.level = 'info';

  isInitialized = true;

  // Log startup
  log.info('='.repeat(60));
  log.info('Quantum Forge starting up');
  log.info(`Version: ${app.getVersion()}`);
  log.info(`Electron: ${process.versions.electron}`);
  log.info(`Node: ${process.versions.node}`);
  log.info(`Platform: ${os.platform()} ${os.release()} (${os.arch()})`);
  log.info('='.repeat(60));
}

/**
 * Set the current startup phase for context in error logs
 * @param {string} phase - Description of current startup phase
 */
function setStartupPhase(phase) {
  startupPhase = phase;
  log.info(`[Startup] Entering phase: ${phase}`);
}

/**
 * Log an error with full diagnostics
 * @param {string} context - Where the error occurred
 * @param {Error} error - The error object
 * @param {object} additionalInfo - Optional additional context
 */
function logError(context, error, additionalInfo = {}) {
  const diagnostics = collectDiagnostics();
  const sanitizedDiagnostics = sanitizeObject(diagnostics);
  const sanitizedStack = sanitizePath(error.stack || 'No stack trace available');

  log.error('='.repeat(60));
  log.error(`ERROR in ${context}`);
  log.error(`Startup Phase: ${startupPhase}`);
  log.error(`Message: ${error.message}`);
  log.error(`Stack: ${sanitizedStack}`);

  if (Object.keys(additionalInfo).length > 0) {
    const sanitizedInfo = sanitizeObject(additionalInfo);
    log.error(`Additional Info: ${JSON.stringify(sanitizedInfo, null, 2)}`);
  }

  log.error('Diagnostics:');
  log.error(JSON.stringify(sanitizedDiagnostics, null, 2));
  log.error('='.repeat(60));

  return sanitizedDiagnostics;
}

/**
 * Log a warning
 * @param {string} context - Where the warning occurred
 * @param {string} message - Warning message
 */
function logWarning(context, message) {
  log.warn(`[${context}] ${message}`);
}

/**
 * Log info
 * @param {string} context - Where the info originated
 * @param {string} message - Info message
 */
function logInfo(context, message) {
  log.info(`[${context}] ${message}`);
}

/**
 * Collect diagnostic information about the current environment
 * Paths are sanitized to remove username
 * @returns {object} Diagnostic information
 */
function collectDiagnostics() {
  const userDataPath = app.isReady() ? getDataPath() : 'Not available (app not ready)';

  const diagnostics = {
    app: {
      version: app.getVersion(),
      name: app.getName(),
      isPackaged: app.isPackaged,
      isPortableMode: isPortable(),
    },
    electron: {
      version: process.versions.electron,
      chrome: process.versions.chrome,
    },
    node: {
      version: process.versions.node,
    },
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      type: os.type(),
      totalMemory: formatBytes(os.totalmem()),
      freeMemory: formatBytes(os.freemem()),
    },
    paths: {
      userData: typeof userDataPath === 'string' ? sanitizePath(userDataPath) : userDataPath,
      configFile: typeof userDataPath === 'string' ? sanitizePath(path.join(userDataPath, 'quantum_config.json')) : 'Not available',
      sdeDatabase: typeof userDataPath === 'string' ? sanitizePath(path.join(userDataPath, 'sde', 'eve-sde.db')) : 'Not available',
      marketDatabase: typeof userDataPath === 'string' ? sanitizePath(path.join(userDataPath, 'market-data.db')) : 'Not available',
      logFile: typeof userDataPath === 'string' ? sanitizePath(path.join(userDataPath, 'logs', 'quantum-forge.log')) : 'Not available',
    },
    startup: {
      phase: startupPhase,
      timestamp: new Date().toISOString(),
    },
  };

  return diagnostics;
}

/**
 * Get the path to the log file
 * @returns {string} Full path to the log file
 */
function getLogFilePath() {
  const userDataPath = getDataPath();
  return path.join(userDataPath, 'logs', 'quantum-forge.log');
}

/**
 * Get the path to the logs directory
 * @returns {string} Full path to the logs directory
 */
function getLogDirectory() {
  const userDataPath = getDataPath();
  return path.join(userDataPath, 'logs');
}

/**
 * Format bytes to human readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Sanitize a path by replacing the user's home directory with ~
 * This prevents leaking the username in log files
 * @param {string} filePath - The path to sanitize
 * @returns {string} Sanitized path
 */
function sanitizePath(filePath) {
  if (typeof filePath !== 'string') {
    return filePath;
  }
  const homedir = os.homedir();
  if (filePath.startsWith(homedir)) {
    return filePath.replace(homedir, '~');
  }
  return filePath;
}

/**
 * Recursively sanitize all paths in an object
 * @param {any} obj - Object to sanitize
 * @returns {any} Sanitized object
 */
function sanitizeObject(obj) {
  if (typeof obj === 'string') {
    return sanitizePath(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeObject(value);
    }
    return result;
  }
  return obj;
}

module.exports = {
  initializeLogging,
  setStartupPhase,
  logError,
  logWarning,
  logInfo,
  collectDiagnostics,
  getLogFilePath,
  getLogDirectory,
};
