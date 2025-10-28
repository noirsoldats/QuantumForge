const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const https = require('https');
const { pipeline } = require('stream/promises');
const { createWriteStream, createReadStream } = require('fs');
const unbzip2Stream = require('unbzip2-stream');

// Fuzzwork SDE SQLite URLs
const FUZZWORK_BASE_URL = 'https://www.fuzzwork.co.uk/dump';
const FUZZWORK_LATEST_URL = `${FUZZWORK_BASE_URL}/sqlite-latest.sqlite.bz2`;
const FUZZWORK_VERSION_CHECK_URL = 'https://www.fuzzwork.co.uk/dump/latest/';

// Minimum required SDE version (format: YYYYMMDD)
const MINIMUM_SDE_VERSION = '20250101'; // Update this as needed

// Get the user data directory
const userDataPath = app.getPath('userData');
const sdeDirectory = path.join(userDataPath, 'sde');
const sdeFilePath = path.join(sdeDirectory, 'sqlite-latest.sqlite');
const sdeVersionFile = path.join(sdeDirectory, 'version.txt');
const sdeBackupPath = path.join(sdeDirectory, 'sqlite-latest.sqlite.backup');
const sdeBackupVersionFile = path.join(sdeDirectory, 'version-backup.txt');
const sdeTempPath = path.join(sdeDirectory, 'sqlite-temp.sqlite');

/**
 * Ensure SDE directory exists
 */
function ensureSdeDirectory() {
  if (!fs.existsSync(sdeDirectory)) {
    fs.mkdirSync(sdeDirectory, { recursive: true });
  }
}

/**
 * Get current installed SDE version
 * @returns {string|null} Version string or null if not installed
 */
function getCurrentVersion() {
  try {
    if (fs.existsSync(sdeVersionFile)) {
      return fs.readFileSync(sdeVersionFile, 'utf8').trim();
    }
    return null;
  } catch (error) {
    console.error('Error reading SDE version:', error);
    return null;
  }
}

/**
 * Get latest available SDE version from Fuzzwork
 * @returns {Promise<string>} Latest version string
 */
async function getLatestVersion() {
  return new Promise((resolve, reject) => {
    https.get(FUZZWORK_VERSION_CHECK_URL, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          // Parse HTML to find version
          // Fuzzwork page contains links like: sqlite-latest-TRANQUILITY.sqlite.bz2
          const match = data.match(/sqlite-latest-TRANQUILITY\.sqlite\.bz2.*?(\d{8})/);
          if (match && match[1]) {
            resolve(match[1]);
          } else {
            // Fallback: try to extract any 8-digit date
            const dateMatch = data.match(/(\d{8})/);
            if (dateMatch && dateMatch[1]) {
              resolve(dateMatch[1]);
            } else {
              resolve(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
            }
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Check if SDE update is required
 * @returns {Promise<Object>} Update status
 */
async function checkUpdateRequired() {
  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion();

    const needsUpdate = !currentVersion ||
                       currentVersion < MINIMUM_SDE_VERSION ||
                       currentVersion < latestVersion;

    const isCritical = !currentVersion || currentVersion < MINIMUM_SDE_VERSION;

    return {
      currentVersion,
      latestVersion,
      minimumVersion: MINIMUM_SDE_VERSION,
      needsUpdate,
      isCritical,
      hasDatabase: fs.existsSync(sdeFilePath),
    };
  } catch (error) {
    console.error('Error checking SDE update:', error);
    throw error;
  }
}

/**
 * Download and extract SDE database
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<boolean>} Success status
 */
async function downloadSDE(progressCallback = null) {
  ensureSdeDirectory();

  const tempBz2Path = path.join(sdeDirectory, 'temp.bz2');

  try {
    // Download the .bz2 file
    await downloadFile(FUZZWORK_LATEST_URL, tempBz2Path, progressCallback);

    // Decompress the file
    if (progressCallback) {
      progressCallback({ stage: 'decompressing', percent: 0 });
    }

    await decompressBz2(tempBz2Path, sdeFilePath);

    // Get version and save it
    const latestVersion = await getLatestVersion();
    fs.writeFileSync(sdeVersionFile, latestVersion, 'utf8');

    // Clean up temp file
    if (fs.existsSync(tempBz2Path)) {
      fs.unlinkSync(tempBz2Path);
    }

    if (progressCallback) {
      progressCallback({ stage: 'complete', percent: 100 });
    }

    console.log('SDE download and extraction complete');
    return true;
  } catch (error) {
    console.error('Error downloading SDE:', error);

    // Clean up on error
    if (fs.existsSync(tempBz2Path)) {
      fs.unlinkSync(tempBz2Path);
    }

    throw error;
  }
}

/**
 * Download a file from URL
 * @param {string} url - URL to download from
 * @param {string} dest - Destination file path
 * @param {Function} progressCallback - Callback for progress updates
 */
function downloadFile(url, dest, progressCallback = null) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    const options = {
      headers: {
        'User-Agent': 'Quantum-Forge/1.0 (EVE Online Industry Tool)',
      },
    };

    https.get(url, options, (response) => {
      // Check for HTTP errors
      if (response.statusCode === 403) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error('Access forbidden (403). The SDE download URL may have changed or requires authentication.'));
        return;
      }

      if (response.statusCode === 404) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error('SDE file not found (404). The download URL may be incorrect.'));
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status code: ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (progressCallback && totalSize) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          progressCallback({
            stage: 'downloading',
            percent,
            downloadedMB: (downloadedSize / 1024 / 1024).toFixed(2),
            totalMB: (totalSize / 1024 / 1024).toFixed(2),
          });
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        reject(err);
      });
    }).on('error', (err) => {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      reject(err);
    });
  });
}

/**
 * Decompress bz2 file
 * @param {string} source - Source .bz2 file
 * @param {string} dest - Destination file
 */
async function decompressBz2(source, dest) {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(source);
    const writeStream = createWriteStream(dest);
    const bz2Decompress = unbzip2Stream();

    readStream
      .pipe(bz2Decompress)
      .pipe(writeStream)
      .on('finish', () => {
        console.log('Decompression complete');
        resolve();
      })
      .on('error', (err) => {
        console.error('Decompression error:', err);
        // Clean up partial file
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        reject(err);
      });

    readStream.on('error', (err) => {
      console.error('Read error:', err);
      reject(err);
    });
  });
}

/**
 * Get SDE database file path
 * @returns {string} Path to SDE database
 */
function getSdePath() {
  return sdeFilePath;
}

/**
 * Check if SDE database exists
 * @returns {boolean} True if database exists
 */
function sdeExists() {
  return fs.existsSync(sdeFilePath);
}

/**
 * Delete SDE database and version file
 * @returns {boolean} Success status
 */
function deleteSDE() {
  try {
    if (fs.existsSync(sdeFilePath)) {
      fs.unlinkSync(sdeFilePath);
    }
    if (fs.existsSync(sdeVersionFile)) {
      fs.unlinkSync(sdeVersionFile);
    }
    return true;
  } catch (error) {
    console.error('Error deleting SDE:', error);
    return false;
  }
}

/**
 * Backup current SDE database and version
 * @returns {boolean} Success status
 */
function backupCurrentSDE() {
  try {
    if (!fs.existsSync(sdeFilePath)) {
      console.log('No current SDE to backup');
      return false;
    }

    // Copy database to backup
    fs.copyFileSync(sdeFilePath, sdeBackupPath);

    // Copy version file if it exists
    if (fs.existsSync(sdeVersionFile)) {
      fs.copyFileSync(sdeVersionFile, sdeBackupVersionFile);
    }

    console.log('SDE backup created successfully');
    return true;
  } catch (error) {
    console.error('Error backing up SDE:', error);
    return false;
  }
}

/**
 * Restore SDE from backup
 * @returns {boolean} Success status
 */
function restorePreviousSDE() {
  try {
    if (!fs.existsSync(sdeBackupPath)) {
      console.error('No backup SDE found');
      return false;
    }

    // Delete current SDE if it exists
    if (fs.existsSync(sdeFilePath)) {
      fs.unlinkSync(sdeFilePath);
    }
    if (fs.existsSync(sdeVersionFile)) {
      fs.unlinkSync(sdeVersionFile);
    }

    // Restore from backup
    fs.copyFileSync(sdeBackupPath, sdeFilePath);

    if (fs.existsSync(sdeBackupVersionFile)) {
      fs.copyFileSync(sdeBackupVersionFile, sdeVersionFile);
    }

    console.log('SDE restored from backup successfully');
    return true;
  } catch (error) {
    console.error('Error restoring SDE:', error);
    return false;
  }
}

/**
 * Check if backup SDE exists
 * @returns {boolean} True if backup exists
 */
function hasBackup() {
  return fs.existsSync(sdeBackupPath);
}

/**
 * Get backup version
 * @returns {string|null} Backup version or null if no backup
 */
function getBackupVersion() {
  try {
    if (fs.existsSync(sdeBackupVersionFile)) {
      return fs.readFileSync(sdeBackupVersionFile, 'utf8').trim();
    }
    return null;
  } catch (error) {
    console.error('Error reading backup version:', error);
    return null;
  }
}

/**
 * Download and validate SDE before applying
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object>} Result with success status and validation results
 */
async function downloadAndValidateSDE(progressCallback = null) {
  const { validateSDE } = require('./sde-validator');

  ensureSdeDirectory();

  try {
    // Step 1: Download to temp location
    if (progressCallback) {
      progressCallback({ stage: 'downloading', percent: 0, message: 'Starting download...' });
    }

    const tempBz2Path = path.join(sdeDirectory, 'temp.bz2');
    await downloadFile(FUZZWORK_LATEST_URL, tempBz2Path, (progress) => {
      if (progressCallback) {
        progressCallback({
          stage: 'downloading',
          percent: Math.min(progress.percent || 0, 90), // Reserve 10% for other steps
          message: `Downloading: ${progress.downloadedMB || 0}MB / ${progress.totalMB || 0}MB`,
        });
      }
    });

    // Step 2: Decompress to temp database
    if (progressCallback) {
      progressCallback({ stage: 'decompressing', percent: 90, message: 'Decompressing database...' });
    }

    await decompressBz2(tempBz2Path, sdeTempPath);

    // Clean up compressed file
    if (fs.existsSync(tempBz2Path)) {
      fs.unlinkSync(tempBz2Path);
    }

    // Step 3: Validate temp database
    if (progressCallback) {
      progressCallback({ stage: 'validating', percent: 95, message: 'Validating database...' });
    }

    const validationResults = await validateSDE(sdeTempPath);

    if (!validationResults.passed) {
      // Validation failed - delete temp file and return error
      if (fs.existsSync(sdeTempPath)) {
        fs.unlinkSync(sdeTempPath);
      }

      return {
        success: false,
        error: 'SDE validation failed',
        validationResults,
      };
    }

    // Step 4: Backup current SDE (if exists)
    if (fs.existsSync(sdeFilePath)) {
      if (progressCallback) {
        progressCallback({ stage: 'backing up', percent: 97, message: 'Backing up current SDE...' });
      }

      if (!backupCurrentSDE()) {
        // Backup failed - delete temp and return error
        if (fs.existsSync(sdeTempPath)) {
          fs.unlinkSync(sdeTempPath);
        }

        return {
          success: false,
          error: 'Failed to backup current SDE',
        };
      }
    }

    // Step 5: Replace current with temp
    if (progressCallback) {
      progressCallback({ stage: 'installing', percent: 98, message: 'Installing new SDE...' });
    }

    // Delete current SDE if exists
    if (fs.existsSync(sdeFilePath)) {
      fs.unlinkSync(sdeFilePath);
    }

    // Move temp to current
    fs.renameSync(sdeTempPath, sdeFilePath);

    // Update version file
    const latestVersion = await getLatestVersion();
    fs.writeFileSync(sdeVersionFile, latestVersion, 'utf8');

    if (progressCallback) {
      progressCallback({ stage: 'complete', percent: 100, message: 'SDE update complete' });
    }

    console.log('SDE download, validation, and installation complete');

    return {
      success: true,
      version: latestVersion,
      validationResults,
    };
  } catch (error) {
    console.error('Error downloading and validating SDE:', error);

    // Clean up temp files on error
    const tempBz2Path = path.join(sdeDirectory, 'temp.bz2');
    if (fs.existsSync(tempBz2Path)) {
      fs.unlinkSync(tempBz2Path);
    }
    if (fs.existsSync(sdeTempPath)) {
      fs.unlinkSync(sdeTempPath);
    }

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Validate current SDE database
 * @returns {Promise<Object>} Validation results
 */
async function validateCurrentSDE() {
  const { validateSDE } = require('./sde-validator');

  if (!fs.existsSync(sdeFilePath)) {
    return {
      passed: false,
      error: 'No SDE database found',
    };
  }

  return await validateSDE(sdeFilePath);
}

module.exports = {
  getCurrentVersion,
  getLatestVersion,
  checkUpdateRequired,
  downloadSDE,
  downloadAndValidateSDE,
  validateCurrentSDE,
  getSdePath,
  sdeExists,
  deleteSDE,
  backupCurrentSDE,
  restorePreviousSDE,
  hasBackup,
  getBackupVersion,
  MINIMUM_SDE_VERSION,
};
