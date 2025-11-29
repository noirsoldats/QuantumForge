const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const userDataPath = app.getPath('userData');
const configDir = path.join(userDataPath, 'config');
const migrationFlagFile = path.join(configDir, '.migration-complete');

// Old paths
const oldConfigPath = path.join(userDataPath, 'quantum_config.json');
const oldMarketDbPath = path.join(userDataPath, 'market_data.sqlite');

// New paths
const newConfigPath = path.join(configDir, 'quantum_config.json');
const newMarketDbPath = path.join(configDir, 'market_data.sqlite');

/**
 * Check if config migration is needed
 * @returns {boolean} True if migration is needed
 */
function needsConfigMigration() {
  // Check if migration already done
  if (fs.existsSync(migrationFlagFile)) {
    console.log('[Config Migration] Migration already completed');
    return false;
  }

  // Check if old files exist
  const needsMigration = fs.existsSync(oldConfigPath) || fs.existsSync(oldMarketDbPath);

  if (needsMigration) {
    console.log('[Config Migration] Migration needed - old config files detected');
  } else {
    console.log('[Config Migration] No migration needed - fresh install or already in config folder');
  }

  return needsMigration;
}

/**
 * Migrate config files to config/ subdirectory
 * @returns {Promise<void>}
 */
async function migrateConfigFiles() {
  console.log('[Config Migration] Starting config folder migration...');

  try {
    // Create config directory
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      console.log('[Config Migration] Created config directory:', configDir);
    }

    // Move quantum_config.json
    if (fs.existsSync(oldConfigPath)) {
      if (fs.existsSync(newConfigPath)) {
        console.log('[Config Migration] New config file already exists, skipping move');
      } else {
        fs.renameSync(oldConfigPath, newConfigPath);
        console.log('[Config Migration] Moved quantum_config.json to config/');
      }
    } else {
      console.log('[Config Migration] No quantum_config.json to migrate');
    }

    // Move market_data.sqlite
    if (fs.existsSync(oldMarketDbPath)) {
      if (fs.existsSync(newMarketDbPath)) {
        console.log('[Config Migration] New market database already exists, skipping move');
      } else {
        fs.renameSync(oldMarketDbPath, newMarketDbPath);
        console.log('[Config Migration] Moved market_data.sqlite to config/');
      }
    } else {
      console.log('[Config Migration] No market_data.sqlite to migrate');
    }

    // Create migration flag
    fs.writeFileSync(migrationFlagFile, new Date().toISOString());
    console.log('[Config Migration] Migration complete - flag created');
  } catch (error) {
    console.error('[Config Migration] Error during migration:', error);
    throw error;
  }
}

/**
 * Get the config directory path
 * @returns {string} Config directory path
 */
function getConfigDir() {
  return configDir;
}

/**
 * Get the quantum_config.json path
 * @returns {string} Config file path
 */
function getConfigPath() {
  return newConfigPath;
}

/**
 * Get the market_data.sqlite path
 * @returns {string} Market database path
 */
function getMarketDbPath() {
  return newMarketDbPath;
}

module.exports = {
  needsConfigMigration,
  migrateConfigFiles,
  getConfigDir,
  getConfigPath,
  getMarketDbPath,
};
