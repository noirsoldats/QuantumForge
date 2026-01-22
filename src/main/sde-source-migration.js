const fs = require('fs');
const path = require('path');
const { getDataPath } = require('./portable-mode');
const {
  getSdeSource,
  setSdeSource,
  getCurrentVersion,
  fetchGitHubRelease,
  extractVersionFromRelease,
  getDownloadInfoFromRelease,
  downloadAndValidateSDE,
  sdeExists,
} = require('./sde-manager');

// Migration state file (portable-aware)
const userDataPath = getDataPath();
const migrationStateFile = path.join(userDataPath, 'sde', 'migration-state.json');

/**
 * Get migration state
 * @returns {Object} Migration state
 */
function getMigrationState() {
  try {
    if (fs.existsSync(migrationStateFile)) {
      const data = fs.readFileSync(migrationStateFile, 'utf8');
      return JSON.parse(data);
    }
    return {
      migrationAttempts: 0,
      lastAttemptDate: null,
      migrationComplete: false,
      migrationError: null,
    };
  } catch (error) {
    console.error('Error reading migration state:', error);
    return {
      migrationAttempts: 0,
      lastAttemptDate: null,
      migrationComplete: false,
      migrationError: null,
    };
  }
}

/**
 * Save migration state
 * @param {Object} state - Migration state to save
 */
function saveMigrationState(state) {
  try {
    const sdeDirectory = path.dirname(migrationStateFile);
    if (!fs.existsSync(sdeDirectory)) {
      fs.mkdirSync(sdeDirectory, { recursive: true });
    }
    fs.writeFileSync(migrationStateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving migration state:', error);
  }
}

/**
 * Check if migration is needed
 * @returns {boolean} True if migration is needed
 */
function needsMigration() {
  const source = getSdeSource();
  const state = getMigrationState();

  console.log('[Migration] Checking migration status:', { source, state });

  // Migration already complete
  if (state.migrationComplete) {
    console.log('[Migration] Migration already completed');
    return false;
  }

  // Already on GitHub source
  if (source === 'github') {
    // Mark as complete if not already
    console.log('[Migration] Already on GitHub source, marking complete');
    if (!state.migrationComplete) {
      saveMigrationState({ ...state, migrationComplete: true });
    }
    return false;
  }

  // Max 3 attempts - but reset if user manually downloaded or if source changed
  if (state.migrationAttempts >= 3) {
    console.log('[Migration] Max attempts reached, checking if reset needed');
    // If source is now github, reset the migration state
    if (source === 'github') {
      console.log('[Migration] Source is GitHub, resetting migration state');
      resetMigrationState();
      saveMigrationState({ migrationComplete: true, migrationAttempts: 0 });
      return false;
    }
    console.log('[Migration] Skipped: max attempts reached without success');
    return false;
  }

  // Legacy Fuzzwork or no source set but SDE exists
  if (source === 'fuzzwork' || (source === null && sdeExists())) {
    console.log('[Migration] Migration needed - legacy SDE detected');
    return true;
  }

  console.log('[Migration] No migration needed');
  return false;
}

/**
 * Perform migration from Fuzzwork to GitHub
 * @param {Function} progressCallback - Optional progress callback
 * @returns {Promise<Object>} Migration result
 */
async function migrateToGitHub(progressCallback = null) {
  const state = getMigrationState();

  console.log('Starting SDE migration from Fuzzwork to GitHub...');

  try {
    // Increment attempt counter
    state.migrationAttempts += 1;
    state.lastAttemptDate = new Date().toISOString();
    saveMigrationState(state);

    // Get current version
    const currentVersion = getCurrentVersion();
    console.log(`Current SDE version: ${currentVersion || 'unknown'}`);

    // Fetch latest GitHub release
    if (progressCallback) {
      progressCallback({ stage: 'checking', percent: 10, message: 'Checking for GitHub SDE updates...' });
    }

    let release, version, downloadInfo;
    try {
      release = await fetchGitHubRelease();
      version = extractVersionFromRelease(release);
      downloadInfo = getDownloadInfoFromRelease(release);

      console.log(`Latest GitHub SDE version: ${version}`);
    } catch (error) {
      // GitHub unavailable - skip migration, try again next time
      console.error('Cannot fetch GitHub release:', error.message);
      state.migrationError = `GitHub unavailable: ${error.message}`;
      saveMigrationState(state);

      return {
        success: false,
        skipped: true,
        reason: 'github_unavailable',
        error: error.message,
      };
    }

    // Compare versions - only download if GitHub version is different or we have no current version
    const shouldDownload = !currentVersion || currentVersion !== version;

    if (!shouldDownload) {
      console.log('Current SDE version matches GitHub version, updating source metadata only');

      // Just update the source to GitHub
      setSdeSource('github');
      state.migrationComplete = true;
      state.migrationError = null;
      saveMigrationState(state);

      return {
        success: true,
        downloaded: false,
        version: currentVersion,
        message: 'Migration complete (no download needed)',
      };
    }

    // Download new version from GitHub
    console.log(`Downloading newer SDE version ${version} from GitHub...`);

    if (progressCallback) {
      progressCallback({ stage: 'downloading', percent: 20, message: `Downloading SDE ${version}...` });
    }

    const result = await downloadAndValidateSDE((progress) => {
      if (progressCallback) {
        // Map download progress to 20-100%
        const mappedPercent = 20 + (progress.percent || 0) * 0.8;
        progressCallback({ ...progress, percent: mappedPercent });
      }
    });

    if (!result.success) {
      console.error('Migration download failed:', result.error);
      state.migrationError = result.error;
      saveMigrationState(state);

      return {
        success: false,
        downloaded: true,
        error: result.error,
        validationResults: result.validationResults,
      };
    }

    // Migration successful
    console.log('Migration to GitHub SDE complete');
    state.migrationComplete = true;
    state.migrationError = null;
    saveMigrationState(state);

    return {
      success: true,
      downloaded: true,
      version: result.version,
      validationResults: result.validationResults,
      message: 'Migration complete',
    };
  } catch (error) {
    console.error('Migration error:', error);
    state.migrationError = error.message;
    saveMigrationState(state);

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Reset migration state (for testing or manual reset)
 */
function resetMigrationState() {
  const state = {
    migrationAttempts: 0,
    lastAttemptDate: null,
    migrationComplete: false,
    migrationError: null,
  };
  saveMigrationState(state);
  console.log('[Migration] Migration state reset');
  return state;
}

/**
 * Force mark migration as complete (useful after manual SDE download)
 */
function markMigrationComplete() {
  const state = getMigrationState();
  state.migrationComplete = true;
  state.migrationError = null;
  saveMigrationState(state);
  console.log('[Migration] Migration marked as complete');
  return state;
}

module.exports = {
  needsMigration,
  migrateToGitHub,
  getMigrationState,
  resetMigrationState,
  markMigrationComplete,
};
