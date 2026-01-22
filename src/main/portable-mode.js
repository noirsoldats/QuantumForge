/**
 * Portable mode detection and data path management for Windows
 *
 * When running as a portable executable on Windows, electron-builder sets
 * the PORTABLE_EXECUTABLE_DIR environment variable. This module detects
 * that and redirects data storage to a folder next to the executable.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let isPortableMode = null;
let portableDataPath = null;

/**
 * Detect if running in portable mode (Windows only)
 * electron-builder sets PORTABLE_EXECUTABLE_DIR for portable builds
 * @returns {boolean} True if running in portable mode
 */
function detectPortableMode() {
  if (isPortableMode !== null) {
    return isPortableMode;
  }

  // Only check on Windows
  if (process.platform !== 'win32') {
    isPortableMode = false;
    return false;
  }

  // Check for PORTABLE_EXECUTABLE_DIR environment variable
  // This is set by electron-builder for portable Windows builds
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;

  if (portableDir) {
    isPortableMode = true;
    portableDataPath = path.join(portableDir, 'QuantumForgeData');
    console.log('[Portable] Running in PORTABLE mode');
    console.log('[Portable] Data directory:', portableDataPath);
    return true;
  }

  isPortableMode = false;
  return false;
}

/**
 * Get the appropriate user data path
 * In portable mode, returns a path next to the executable
 * Otherwise, returns the standard app.getPath('userData')
 * @returns {string} User data path
 */
function getDataPath() {
  if (detectPortableMode()) {
    // Ensure portable data directory exists
    if (!fs.existsSync(portableDataPath)) {
      try {
        fs.mkdirSync(portableDataPath, { recursive: true });
        console.log('[Portable] Created data directory:', portableDataPath);
      } catch (error) {
        console.error('[Portable] Failed to create data directory:', error);
        // Fall back to standard path if we can't create portable directory
        return app.getPath('userData');
      }
    }
    return portableDataPath;
  }

  return app.getPath('userData');
}

/**
 * Check if running in portable mode
 * @returns {boolean} True if running in portable mode
 */
function isPortable() {
  return detectPortableMode();
}

/**
 * Get the portable executable directory (if in portable mode)
 * @returns {string|null} Portable directory or null if not in portable mode
 */
function getPortableDir() {
  if (detectPortableMode()) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return null;
}

module.exports = {
  detectPortableMode,
  getDataPath,
  isPortable,
  getPortableDir,
};
