const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const https = require('https');
const { pipeline } = require('stream/promises');
const { createWriteStream, createReadStream } = require('fs');
const unbzip2Stream = require('unbzip2-stream');
const { getUserAgent } = require('./user-agent');

// GitHub SDE Repository
const GITHUB_REPO_OWNER = 'noirsoldats';
const GITHUB_REPO_NAME = 'eve-sde-converter';
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RELEASES_URL = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;

// SDE Database filename (we'll use the stripped version for smaller download)
const SDE_DATABASE_NAME = 'eve-stripped.db';

// Legacy Fuzzwork URLs (kept for potential fallback/migration)
const FUZZWORK_BASE_URL = 'https://www.fuzzwork.co.uk/dump';
const FUZZWORK_LATEST_URL = `${FUZZWORK_BASE_URL}/sqlite-latest.sqlite.bz2`;
const FUZZWORK_VERSION_CHECK_URL = 'https://www.fuzzwork.co.uk/dump/latest/';

// Minimum required SDE version (format: numeric version from tag)
const MINIMUM_SDE_VERSION = '3118350'; // Update this as needed

// Get the user data directory
const userDataPath = app.getPath('userData');
const sdeDirectory = path.join(userDataPath, 'sde');
const sdeFilePath = path.join(sdeDirectory, 'eve-sde.db');
const sdeVersionFile = path.join(sdeDirectory, 'version.txt');
const sdeSourceFile = path.join(sdeDirectory, 'source.txt'); // Track source: 'github' or 'fuzzwork'
const sdeBackupPath = path.join(sdeDirectory, 'eve-sde.db.backup');
const sdeBackupVersionFile = path.join(sdeDirectory, 'version-backup.txt');
const sdeTempPath = path.join(sdeDirectory, 'eve-sde-temp.db');

/**
 * Ensure SDE directory exists
 */
function ensureSdeDirectory() {
  if (!fs.existsSync(sdeDirectory)) {
    fs.mkdirSync(sdeDirectory, { recursive: true });
  }
}

/**
 * Get current SDE source (github, fuzzwork, or null)
 * @returns {string|null} Source string or null if not set
 */
function getSdeSource() {
  try {
    if (fs.existsSync(sdeSourceFile)) {
      return fs.readFileSync(sdeSourceFile, 'utf8').trim();
    }
    // Legacy detection: if version file exists but no source file, assume fuzzwork
    if (fs.existsSync(sdeVersionFile)) {
      return 'fuzzwork';
    }
    return null;
  } catch (error) {
    console.error('Error reading SDE source:', error);
    return null;
  }
}

/**
 * Set SDE source
 * @param {string} source - Source identifier ('github' or 'fuzzwork')
 */
function setSdeSource(source) {
  try {
    ensureSdeDirectory();
    fs.writeFileSync(sdeSourceFile, source, 'utf8');
  } catch (error) {
    console.error('Error writing SDE source:', error);
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
 * Fetch latest release information from GitHub
 * @returns {Promise<Object>} Release metadata object
 */
async function fetchGitHubRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': getUserAgent(),
        'Accept': 'application/vnd.github.v3+json',
      },
      timeout: 10000, // 10 second timeout
    };

    https.get(GITHUB_RELEASES_URL, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 404) {
            reject(new Error('GitHub repository or releases not found'));
            return;
          }

          if (res.statusCode === 403) {
            reject(new Error('GitHub API rate limit exceeded. Please try again later.'));
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned status code: ${res.statusCode}`));
            return;
          }

          const release = JSON.parse(data);
          resolve(release);
        } catch (error) {
          reject(new Error(`Failed to parse GitHub API response: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(new Error(`Failed to connect to GitHub: ${error.message}`));
    });
  });
}

/**
 * Extract version from GitHub release tag
 * @param {Object} release - GitHub release object
 * @returns {string} Version string (e.g., "3118350" or "3123381.01")
 */
function extractVersionFromRelease(release) {
  // Tag format: "sde-3118350" or "sde-3123381.01" -> extract version with optional patch
  const tagName = release.tag_name;
  const match = tagName.match(/sde-(\d+(?:\.\d{2})?)/);
  if (match && match[1]) {
    return match[1];
  }
  throw new Error(`Invalid release tag format: ${tagName}`);
}

/**
 * Get download URL for SDE database from release
 * @param {Object} release - GitHub release object
 * @returns {Object} Object with url and size
 */
function getDownloadInfoFromRelease(release) {
  const asset = release.assets.find(a => a.name === SDE_DATABASE_NAME);
  if (!asset) {
    throw new Error(`SDE database file "${SDE_DATABASE_NAME}" not found in release`);
  }
  return {
    url: asset.browser_download_url,
    size: asset.size,
    name: asset.name,
  };
}

/**
 * Get latest available SDE version from GitHub
 * @returns {Promise<string>} Latest version string
 */
async function getLatestVersion() {
  try {
    const release = await fetchGitHubRelease();
    return extractVersionFromRelease(release);
  } catch (error) {
    console.error('Error fetching latest version from GitHub:', error);
    throw error;
  }
}

/**
 * Detect version format
 * @param {string} version - Version string
 * @returns {string} 'date' for YYYYMMDD format, 'numeric' for GitHub format, 'numeric-patch' for version with patch, 'unknown' otherwise
 */
function detectVersionFormat(version) {
  if (!version) return 'unknown';

  // Check if it's a date format (YYYYMMDD - 8 digits starting with 20)
  if (/^20\d{6}$/.test(version)) {
    return 'date';
  }

  // Check if it's numeric with patch (e.g., 3123381.01)
  if (/^\d+\.\d{2}$/.test(version)) {
    return 'numeric-patch';
  }

  // Check if it's numeric (GitHub format - typically 7 digits)
  if (/^\d+$/.test(version)) {
    return 'numeric';
  }

  return 'unknown';
}

/**
 * Compare two version strings (handles mixed date/numeric/numeric-patch formats)
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
  const format1 = detectVersionFormat(v1);
  const format2 = detectVersionFormat(v2);

  // If comparing different formats (old date vs new GitHub),
  // always consider the date format as older
  if (format1 === 'date' && (format2 === 'numeric' || format2 === 'numeric-patch')) {
    return -1; // date format is older, needs update
  }
  if ((format1 === 'numeric' || format1 === 'numeric-patch') && format2 === 'date') {
    return 1; // numeric is newer
  }

  // Parse versions with optional patch component
  // Split on '.' to get [base, patch] or [base]
  const parts1 = v1.split('.');
  const parts2 = v2.split('.');

  const base1 = parseInt(parts1[0], 10);
  const base2 = parseInt(parts2[0], 10);
  const patch1 = parts1[1] ? parseInt(parts1[1], 10) : null;
  const patch2 = parts2[1] ? parseInt(parts2[1], 10) : null;

  // Validate parsing
  if (isNaN(base1) || isNaN(base2)) {
    // Fall back to string comparison if parsing fails
    return v1 === v2 ? 0 : (v1 < v2 ? -1 : 1);
  }

  // Compare base versions first
  if (base1 < base2) return -1;
  if (base1 > base2) return 1;

  // Base versions equal - compare patches
  // null (no patch) is considered older than any patch version
  if (patch1 === null && patch2 === null) return 0;
  if (patch1 === null) return -1; // no patch < with patch
  if (patch2 === null) return 1;  // with patch > no patch

  // Both have patches - compare numerically
  if (patch1 < patch2) return -1;
  if (patch1 > patch2) return 1;
  return 0;
}

/**
 * Check if SDE update is required
 * @returns {Promise<Object>} Update status
 */
async function checkUpdateRequired() {
  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion();

    // Use numeric comparison for version strings
    const needsUpdate = !currentVersion ||
                       compareVersions(currentVersion, MINIMUM_SDE_VERSION) < 0 ||
                       compareVersions(currentVersion, latestVersion) < 0;

    const isCritical = !currentVersion ||
                      compareVersions(currentVersion, MINIMUM_SDE_VERSION) < 0;

    return {
      currentVersion,
      latestVersion,
      minimumVersion: MINIMUM_SDE_VERSION,
      needsUpdate,
      isCritical,
      hasDatabase: sdeExists(),
    };
  } catch (error) {
    console.error('Error checking SDE update:', error);
    throw error;
  }
}

/**
 * Download SDE database from GitHub
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<boolean>} Success status
 */
async function downloadSDE(progressCallback = null) {
  ensureSdeDirectory();

  try {
    // Fetch release info to get download URL
    const release = await fetchGitHubRelease();
    const downloadInfo = getDownloadInfoFromRelease(release);
    const version = extractVersionFromRelease(release);

    console.log(`Downloading SDE ${version} from GitHub (${(downloadInfo.size / 1024 / 1024).toFixed(2)} MB)`);

    // Download the database file directly (no compression)
    await downloadFile(downloadInfo.url, sdeFilePath, progressCallback);

    // Save version and source
    fs.writeFileSync(sdeVersionFile, version, 'utf8');
    setSdeSource('github');

    if (progressCallback) {
      progressCallback({ stage: 'complete', percent: 100 });
    }

    console.log('SDE download complete');
    return true;
  } catch (error) {
    console.error('Error downloading SDE:', error);
    throw error;
  }
}

/**
 * Download a file from URL (with redirect support)
 * @param {string} url - URL to download from
 * @param {string} dest - Destination file path
 * @param {Function} progressCallback - Callback for progress updates
 * @param {number} redirectCount - Internal redirect counter (max 5)
 */
function downloadFile(url, dest, progressCallback = null, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    // Prevent infinite redirect loops
    if (redirectCount > 5) {
      reject(new Error('Too many redirects (max 5)'));
      return;
    }

    const file = createWriteStream(dest);

    const options = {
      headers: {
        'User-Agent': getUserAgent(),
      },
    };

    https.get(url, options, (response) => {
      // Handle redirects (301, 302, 307, 308)
      if (response.statusCode === 301 || response.statusCode === 302 ||
          response.statusCode === 307 || response.statusCode === 308) {
        file.close();
        fs.unlinkSync(dest);

        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error(`Redirect (${response.statusCode}) without location header`));
          return;
        }

        console.log(`Following redirect (${response.statusCode}) to: ${redirectUrl}`);

        // Follow the redirect
        downloadFile(redirectUrl, dest, progressCallback, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

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
 * Get SDE database file path (handles both old and new filenames)
 * @returns {string} Path to SDE database
 */
function getSdePath() {
  // Check for new filename first
  if (fs.existsSync(sdeFilePath)) {
    return sdeFilePath;
  }

  // Check for legacy Fuzzwork filename
  const legacyPath = path.join(sdeDirectory, 'sqlite-latest.sqlite');
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  // Return new path as default
  return sdeFilePath;
}

/**
 * Check if SDE database exists (handles both old and new filenames)
 * @returns {boolean} True if database exists
 */
function sdeExists() {
  // Check new filename
  if (fs.existsSync(sdeFilePath)) {
    return true;
  }

  // Check legacy Fuzzwork filename
  const legacyPath = path.join(sdeDirectory, 'sqlite-latest.sqlite');
  return fs.existsSync(legacyPath);
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
    // Step 1: Fetch release information
    if (progressCallback) {
      progressCallback({ stage: 'fetching', percent: 0, message: 'Fetching release information...' });
    }

    const release = await fetchGitHubRelease();
    const downloadInfo = getDownloadInfoFromRelease(release);
    const version = extractVersionFromRelease(release);

    console.log(`Downloading SDE ${version} (${(downloadInfo.size / 1024 / 1024).toFixed(2)} MB)`);

    // Step 2: Download to temp location
    if (progressCallback) {
      progressCallback({ stage: 'downloading', percent: 5, message: 'Starting download...' });
    }

    await downloadFile(downloadInfo.url, sdeTempPath, (progress) => {
      if (progressCallback) {
        progressCallback({
          stage: 'downloading',
          percent: 5 + Math.min(progress.percent || 0, 85) * 0.85, // 5-90%
          message: `Downloading: ${progress.downloadedMB || 0}MB / ${progress.totalMB || 0}MB`,
        });
      }
    });

    // Step 3: Verify file size matches expected
    if (progressCallback) {
      progressCallback({ stage: 'verifying', percent: 91, message: 'Verifying download...' });
    }

    const downloadedSize = fs.statSync(sdeTempPath).size;
    if (downloadedSize !== downloadInfo.size) {
      if (fs.existsSync(sdeTempPath)) {
        fs.unlinkSync(sdeTempPath);
      }
      return {
        success: false,
        error: `Download size mismatch. Expected ${downloadInfo.size} bytes, got ${downloadedSize} bytes`,
      };
    }

    // Step 4: Validate temp database
    if (progressCallback) {
      progressCallback({ stage: 'validating', percent: 93, message: 'Validating database...' });
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

    // Step 5: Backup current SDE (if exists)
    if (fs.existsSync(sdeFilePath)) {
      if (progressCallback) {
        progressCallback({ stage: 'backing up', percent: 96, message: 'Backing up current SDE...' });
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

    // Step 6: Replace current with temp
    if (progressCallback) {
      progressCallback({ stage: 'installing', percent: 98, message: 'Installing new SDE...' });
    }

    // Delete current SDE if exists
    if (fs.existsSync(sdeFilePath)) {
      fs.unlinkSync(sdeFilePath);
    }

    // Move temp to current
    fs.renameSync(sdeTempPath, sdeFilePath);

    // Update version and source files
    fs.writeFileSync(sdeVersionFile, version, 'utf8');
    setSdeSource('github');

    if (progressCallback) {
      progressCallback({ stage: 'complete', percent: 100, message: 'SDE update complete' });
    }

    console.log('SDE download, validation, and installation complete');

    return {
      success: true,
      version: version,
      validationResults,
    };
  } catch (error) {
    console.error('Error downloading and validating SDE:', error);

    // Clean up temp files on error
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
  getSdeSource,
  setSdeSource,
  fetchGitHubRelease,
  extractVersionFromRelease,
  getDownloadInfoFromRelease,
  MINIMUM_SDE_VERSION,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
};
