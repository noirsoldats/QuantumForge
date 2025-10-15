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

module.exports = {
  getCurrentVersion,
  getLatestVersion,
  checkUpdateRequired,
  downloadSDE,
  getSdePath,
  sdeExists,
  deleteSDE,
  MINIMUM_SDE_VERSION,
};
