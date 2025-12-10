const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {isTokenExpired, refreshAccessToken} = require("./esi-auth");
const { getConfigPath } = require('./config-migration');
const { getCharacterDatabase } = require('./character-database');

// Get the settings file path (from config/ subdirectory)
const settingsFilePath = getConfigPath();

// Default settings
const defaultSettings = {
  general: {
    theme: 'dark',
    desktopNotifications: true,
    updatesNotification: true,
    autoUpdateCharacterData: true,
    firstLaunchCompleted: false,
    wizardVersion: null,
    wizardCompletedAt: null,
  },
  accounts: {
    characters: [],
  },
  market: {
    locationType: 'hub', // 'hub', 'station', 'system', 'region'
    locationId: 60003760, // Jita IV - Moon 4
    regionId: 10000002, // The Forge
    systemId: 30000142, // Jita
    inputMaterials: {
      priceType: 'sell', // 'buy' or 'sell'
      priceMethod: 'hybrid', // 'vwap', 'percentile', 'historical', 'hybrid'
      priceModifier: 1.0, // Multiplier (1.0 = 100%)
      percentile: 0.2, // For percentile method
      minVolume: 1000, // Minimum volume threshold
    },
    outputProducts: {
      priceType: 'sell',
      priceMethod: 'hybrid',
      priceModifier: 1.0, // 100% (no adjustment by default)
      percentile: 0.2,
      minVolume: 1000,
    },
    warningThreshold: 0.3, // Warn if price deviates >30% from historical
    speculativeInvention: {
      enabled: false, // Default OFF for performance
      decryptorStrategy: 'total-per-item', // Recommended default
      customVolume: 1,
      showOnlyProfitable: true,
      minProfitThreshold: 0,
    },
  },
  owned_blueprints: [],
  sde: {
    validationStatus: null, // { passed: true/false, date: ISO date string, summary: string, totalChecks: number }
    lastUpdateCheck: null, // ISO date string
    updateAvailable: false,
    latestAvailableVersion: null,
  },
  industry: {
    enabledDivisions: [],  // Array of division IDs (1-7) - empty by default, user selects which divisions to use
    calculateReactionsAsIntermediates: false,  // Global toggle for reaction intermediate calculation
    defaultManufacturingCharacters: [],  // Array of character IDs for manufacturing defaults
  },
};

/**
 * Load settings from file
 * @returns {Object} Settings object
 */
function loadSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, 'utf8');
      const loadedSettings = JSON.parse(data);

      // Merge with defaults to ensure all keys exist
      return mergeWithDefaults(loadedSettings, defaultSettings);
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }

  // Return default settings if file doesn't exist or error occurs
  return { ...defaultSettings };
}

/**
 * Save settings to file
 * @param {Object} settings - Settings object to save
 * @returns {boolean} Success status
 */
function saveSettings(settings) {
  try {
    // Ensure the directory exists
    const dir = path.dirname(settingsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write settings to file with pretty formatting
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('Settings saved successfully to:', settingsFilePath);
    return true;
  } catch (error) {
    console.error('Error saving settings:', error);
    return false;
  }
}

/**
 * Update specific settings without overwriting entire file
 * @param {string} category - Settings category (general, accounts, market)
 * @param {Object} updates - Object with settings to update
 * @returns {boolean} Success status
 */
function updateSettings(category, updates) {
  try {
    const currentSettings = loadSettings();

    if (currentSettings[category]) {
      currentSettings[category] = {
        ...currentSettings[category],
        ...updates,
      };
      return saveSettings(currentSettings);
    }

    console.error('Invalid settings category:', category);
    return false;
  } catch (error) {
    console.error('Error updating settings:', error);
    return false;
  }
}

/**
 * Get a specific setting value
 * @param {string} category - Settings category
 * @param {string} key - Setting key
 * @returns {*} Setting value
 */
function getSetting(category, key) {
  const settings = loadSettings();
  return settings[category]?.[key];
}

/**
 * Merge loaded settings with defaults to ensure all keys exist
 * @param {Object} loaded - Loaded settings
 * @param {Object} defaults - Default settings
 * @returns {Object} Merged settings
 */
function mergeWithDefaults(loaded, defaults) {
  const merged = { ...defaults };

  for (const key in loaded) {
    if (typeof loaded[key] === 'object' && !Array.isArray(loaded[key])) {
      merged[key] = { ...defaults[key], ...loaded[key] };
    } else {
      merged[key] = loaded[key];
    }
  }

  return merged;
}

/**
 * Reset settings to defaults
 * @returns {boolean} Success status
 */
function resetSettings() {
  return saveSettings({ ...defaultSettings });
}

/**
 * Get the settings file path
 * @returns {string} Path to settings file
 */
function getSettingsFilePath() {
  return settingsFilePath;
}

/**
 * Add a character to the accounts
 * @param {Object} characterData - Character data including tokens
 * @returns {boolean} Success status
 */
function addCharacter(characterData) {
  try {
    const db = getCharacterDatabase();
    const settings = loadSettings();

    // Check if character already exists BEFORE any destructive operations
    const existing = db.prepare('SELECT character_id, added_at FROM characters WHERE character_id = ?').get(characterData.character.characterId);

    const now = Date.now();

    if (existing) {
      // ✅ SAFE: UPDATE only authentication fields for existing characters
      // This does NOT trigger CASCADE DELETE
      console.log('[Settings] Re-authenticating existing character:', characterData.character.characterName);

      db.prepare(`
        UPDATE characters SET
          character_name = ?,
          corporation_id = ?,
          alliance_id = ?,
          portrait = ?,
          access_token = ?,
          refresh_token = ?,
          expires_at = ?,
          token_type = ?,
          scopes = ?,
          updated_at = ?
        WHERE character_id = ?
      `).run(
        characterData.character.characterName,
        characterData.character.corporationId || null,
        characterData.character.allianceId || null,
        characterData.character.portrait || null,
        characterData.access_token,
        characterData.refresh_token,
        characterData.expires_at,
        characterData.token_type || 'Bearer',
        JSON.stringify(characterData.character.scopes || []),
        now,
        characterData.character.characterId
      );

      console.log('[Settings] Character tokens updated successfully. All existing data preserved.');

    } else {
      // ✅ SAFE: INSERT only for genuinely new characters
      console.log('[Settings] Adding new character:', characterData.character.characterName);

      db.prepare(`
        INSERT INTO characters (
          character_id, character_name, corporation_id, alliance_id,
          portrait, access_token, refresh_token, expires_at,
          token_type, scopes, added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        characterData.character.characterId,
        characterData.character.characterName,
        characterData.character.corporationId || null,
        characterData.character.allianceId || null,
        characterData.character.portrait || null,
        characterData.access_token,
        characterData.refresh_token,
        characterData.expires_at,
        characterData.token_type || 'Bearer',
        JSON.stringify(characterData.character.scopes || []),
        now,
        now
      );

      // Automatically set as default if this is the first character
      const characterCount = db.prepare('SELECT COUNT(*) as count FROM characters').get().count;
      if (characterCount === 1) {
        settings.accounts.defaultCharacterId = characterData.character.characterId;
        saveSettings(settings);
        console.log('[Settings] Automatically set first character as default:', characterData.character.characterName);
      }

      console.log('[Settings] New character added successfully.');
    }

    return true;
  } catch (error) {
    console.error('Error adding character:', error);
    return false;
  }
}

/**
 * Remove a character from accounts
 * @param {number} characterId - Character ID to remove
 * @returns {boolean} Success status
 */
function removeCharacter(characterId) {
  try {
    const db = getCharacterDatabase();
    const settings = loadSettings();

    // Clear default character if this was it
    if (settings.accounts.defaultCharacterId === characterId) {
      delete settings.accounts.defaultCharacterId;
      saveSettings(settings);
      console.log('Cleared default character as it was removed');
    }

    // Delete character (CASCADE will handle related skills, blueprints, etc.)
    const result = db.prepare('DELETE FROM characters WHERE character_id = ?').run(characterId);

    console.log('Removed character:', characterId);
    console.log(`Cascade deleted all related data (skills, blueprints, etc.) for character ${characterId}`);

    return result.changes > 0;
  } catch (error) {
    console.error('Error removing character:', error);
    return false;
  }
}

/**
 * Update character tokens
 * @param {number} characterId - Character ID
 * @param {Object} tokenData - New token data
 * @returns {boolean} Success status
 */
function updateCharacterTokens(characterId, tokenData) {
  try {
    const db = getCharacterDatabase();

    const result = db.prepare(`
      UPDATE characters
      SET access_token = ?, refresh_token = ?, expires_at = ?, token_type = ?, updated_at = ?
      WHERE character_id = ?
    `).run(
      tokenData.access_token,
      tokenData.refresh_token,
      tokenData.expires_at,
      tokenData.token_type || 'Bearer',
      Date.now(),
      characterId
    );

    if (result.changes > 0) {
      console.log('Updated tokens for character:', characterId);
      return true;
    }

    console.error('Character not found:', characterId);
    return false;
  } catch (error) {
    console.error('Error updating character tokens:', error);
    return false;
  }
}

/**
 * Get all characters
 * @returns {Array} Array of characters
 */
function getCharacters() {
  try {
    const db = getCharacterDatabase();
    const rows = db.prepare('SELECT * FROM characters ORDER BY character_name').all();

    return rows.map(row => ({
      characterId: row.character_id,
      characterName: row.character_name,
      corporationId: row.corporation_id,
      allianceId: row.alliance_id,
      portrait: row.portrait,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      tokenType: row.token_type,
      scopes: JSON.parse(row.scopes),
      addedAt: row.added_at,
    }));
  } catch (error) {
    console.error('Error getting characters from database:', error);
    return [];
  }
}

/**
 * Get a specific character
 * @param {number} characterId - Character ID
 * @returns {Object|null} Character data or null
 */
function getCharacter(characterId) {
  try {
    const db = getCharacterDatabase();
    const row = db.prepare('SELECT * FROM characters WHERE character_id = ?').get(characterId);

    if (!row) return null;

    // Get skills data
    const skillsMetadata = db.prepare('SELECT * FROM skills_metadata WHERE character_id = ?').get(characterId);
    const skillRows = db.prepare('SELECT * FROM skills WHERE character_id = ?').all(characterId);
    const skillOverrideRows = db.prepare('SELECT skill_id, override_level FROM skill_overrides WHERE character_id = ?').all(characterId);

    // Build skills object
    let skills = null;
    if (skillsMetadata) {
      const skillsMap = {};
      for (const skill of skillRows) {
        skillsMap[skill.skill_id] = {
          skillId: skill.skill_id,
          activeSkillLevel: skill.active_skill_level,
          trainedSkillLevel: skill.trained_skill_level,
          skillpointsInSkill: skill.skillpoints_in_skill,
        };
      }

      skills = {
        totalSp: skillsMetadata.total_sp,
        unallocatedSp: skillsMetadata.unallocated_sp,
        skills: skillsMap,
        lastUpdated: skillsMetadata.last_updated,
        cacheExpiresAt: skillsMetadata.cache_expires_at,
      };
    }

    // Build skill overrides object
    const skillOverrides = {};
    for (const override of skillOverrideRows) {
      skillOverrides[override.skill_id] = override.override_level;
    }

    return {
      characterId: row.character_id,
      characterName: row.character_name,
      corporationId: row.corporation_id,
      allianceId: row.alliance_id,
      portrait: row.portrait,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      tokenType: row.token_type,
      scopes: JSON.parse(row.scopes),
      addedAt: row.added_at,
      skills: skills,
      skillOverrides: skillOverrides,
    };
  } catch (error) {
    console.error('Error getting character from database:', error);
    return null;
  }
}

/**
 * Update character skills
 * @param {number} characterId - Character ID
 * @param {Object} skillsData - Skills data from ESI
 * @returns {boolean} Success status
 */
function updateCharacterSkills(characterId, skillsData) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      console.error('Character not found:', characterId);
      return false;
    }

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    try {
      // Update skills metadata
      db.prepare(`
        INSERT OR REPLACE INTO skills_metadata (
          character_id, total_sp, unallocated_sp, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        characterId,
        skillsData.totalSp || 0,
        skillsData.unallocatedSp || 0,
        skillsData.lastUpdated || Date.now(),
        skillsData.cacheExpiresAt || null
      );

      // Delete existing skills for this character
      db.prepare('DELETE FROM skills WHERE character_id = ?').run(characterId);

      // Insert all skills
      const insertSkill = db.prepare(`
        INSERT INTO skills (
          character_id, skill_id, active_skill_level,
          trained_skill_level, skillpoints_in_skill
        ) VALUES (?, ?, ?, ?, ?)
      `);

      if (skillsData.skills) {
        for (const [skillId, skillData] of Object.entries(skillsData.skills)) {
          insertSkill.run(
            characterId,
            parseInt(skillId),
            skillData.activeSkillLevel,
            skillData.trainedSkillLevel,
            skillData.skillpointsInSkill
          );
        }
      }

      db.exec('COMMIT');
      console.log('Updated skills for character:', characterId);
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error updating character skills:', error);
    return false;
  }
}

/**
 * Check if skills cache is still valid
 * @param {number} characterId - Character ID
 * @returns {Object} Cache status { isCached, expiresAt, remainingSeconds }
 */
function getSkillsCacheStatus(characterId) {
  try {
    const db = getCharacterDatabase();
    const metadata = db.prepare('SELECT cache_expires_at FROM skills_metadata WHERE character_id = ?').get(characterId);

    if (!metadata || !metadata.cache_expires_at) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = metadata.cache_expires_at;
    const remainingMs = expiresAt - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    return {
      isCached: remainingMs > 0,
      expiresAt: expiresAt,
      remainingSeconds: remainingSeconds,
    };
  } catch (error) {
    console.error('Error getting skills cache status:', error);
    return { isCached: false, expiresAt: null, remainingSeconds: 0 };
  }
}

/**
 * Get blueprints cache status for a character
 * @param {number} characterId - Character ID
 * @returns {Object} Cache status with isCached, expiresAt, and remainingSeconds
 */
function getBlueprintsCacheStatus(characterId) {
  try {
    const db = getCharacterDatabase();

    // Find any blueprint for this character to get cache info
    const blueprint = db.prepare(`
      SELECT cache_expires_at
      FROM blueprints
      WHERE character_id = ? AND source = 'esi' AND cache_expires_at IS NOT NULL
      LIMIT 1
    `).get(characterId);

    if (!blueprint || !blueprint.cache_expires_at) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = blueprint.cache_expires_at;
    const remainingMs = expiresAt - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    return {
      isCached: remainingMs > 0,
      expiresAt: expiresAt,
      remainingSeconds: remainingSeconds,
    };
  } catch (error) {
    console.error('Error getting blueprints cache status:', error);
    return { isCached: false, expiresAt: null, remainingSeconds: 0 };
  }
}

/**
 * Set skill override for a character
 * @param {number} characterId - Character ID
 * @param {number} skillId - Skill ID
 * @param {number} level - Override level (0-5)
 * @returns {boolean} Success status
 */
function setSkillOverride(characterId, skillId, level) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      console.error('Character not found:', characterId);
      return false;
    }

    if (level === null || level === undefined) {
      // Remove override
      db.prepare('DELETE FROM skill_overrides WHERE character_id = ? AND skill_id = ?').run(characterId, skillId);
      console.log(`Removed skill override for character ${characterId}, skill ${skillId}`);
    } else {
      // Set override
      db.prepare(`
        INSERT OR REPLACE INTO skill_overrides (character_id, skill_id, override_level)
        VALUES (?, ?, ?)
      `).run(characterId, skillId, level);
      console.log(`Set skill override for character ${characterId}, skill ${skillId}: ${level}`);
    }

    return true;
  } catch (error) {
    console.error('Error setting skill override:', error);
    return false;
  }
}

/**
 * Get effective skill level (considering overrides)
 * @param {number} characterId - Character ID
 * @param {number} skillId - Skill ID
 * @returns {number|null} Effective skill level or null
 */
function getEffectiveSkillLevel(characterId, skillId) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      return null;
    }

    // Check for override first
    const override = db.prepare('SELECT override_level FROM skill_overrides WHERE character_id = ? AND skill_id = ?').get(characterId, skillId);
    if (override) {
      return override.override_level;
    }

    // Return actual skill level
    const skill = db.prepare('SELECT trained_skill_level FROM skills WHERE character_id = ? AND skill_id = ?').get(characterId, skillId);
    if (skill) {
      return skill.trained_skill_level;
    }

    return 0; // Skill not trained
  } catch (error) {
    console.error('Error getting effective skill level:', error);
    return null;
  }
}

/**
 * Clear all skill overrides for a character
 * @param {number} characterId - Character ID
 * @returns {boolean} Success status
 */
function clearSkillOverrides(characterId) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      console.error('Character not found:', characterId);
      return false;
    }

    db.prepare('DELETE FROM skill_overrides WHERE character_id = ?').run(characterId);
    console.log('Cleared skill overrides for character:', characterId);
    return true;
  } catch (error) {
    console.error('Error clearing skill overrides:', error);
    return false;
  }
}

/**
 * Set default character
 * @param {number} characterId - Character ID to set as default
 * @returns {boolean} Success status
 */
function setDefaultCharacter(characterId) {
  try {
    const db = getCharacterDatabase();
    const settings = loadSettings();

    // Verify character exists in SQLite
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);

    if (!character) {
      console.error('Character not found:', characterId);
      return false;
    }

    if (!settings.accounts) {
      settings.accounts = {};
    }

    settings.accounts.defaultCharacterId = characterId;
    console.log('Set default character:', characterId);
    return saveSettings(settings);
  } catch (error) {
    console.error('Error setting default character:', error);
    return false;
  }
}

/**
 * Get default character
 * @returns {Object|null} Default character or null
 */
function getDefaultCharacter() {
  try {
    const settings = loadSettings();

    if (!settings.accounts || !settings.accounts.defaultCharacterId) {
      return null;
    }

    return getCharacter(settings.accounts.defaultCharacterId);
  } catch (error) {
    console.error('Error getting default character:', error);
    return null;
  }
}

/**
 * Clear default character
 * @returns {boolean} Success status
 */
function clearDefaultCharacter() {
  try {
    const settings = loadSettings();

    if (settings.accounts) {
      delete settings.accounts.defaultCharacterId;
      console.log('Cleared default character');
      return saveSettings(settings);
    }

    return true;
  } catch (error) {
    console.error('Error clearing default character:', error);
    return false;
  }
}

/**
 * Update blueprints for a character from ESI
 * @param {number} characterId - Character ID
 * @param {Object} blueprintsData - Blueprints data from ESI
 * @returns {boolean} Success status
 */
function updateCharacterBlueprints(characterId, blueprintsData) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      console.error('Character not found:', characterId);
      return false;
    }

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    try {
      // Remove existing ESI blueprints for this character
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND source = ?').run(characterId, 'esi');

      // Insert new blueprints
      const insertBlueprint = db.prepare(`
        INSERT INTO blueprints (
          item_id, type_id, character_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const bp of blueprintsData.blueprints) {
        insertBlueprint.run(
          bp.itemId,
          bp.typeId,
          characterId,
          bp.corporationId || null,
          bp.locationId || null,
          bp.locationFlag || null,
          bp.quantity,
          bp.timeEfficiency || 0,
          bp.materialEfficiency || 0,
          bp.runs || -1,
          bp.isCopy ? 1 : 0,
          bp.isCorporation ? 1 : 0,
          'esi',
          0,
          bp.fetchedAt || Date.now(),
          blueprintsData.lastUpdated,
          blueprintsData.cacheExpiresAt || null
        );
      }

      db.exec('COMMIT');
      console.log(`Updated ${blueprintsData.blueprints.length} blueprints for character:`, characterId);
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error updating character blueprints:', error);
    return false;
  }
}

/**
 * Add a manual blueprint
 * @param {Object} blueprint - Blueprint data
 * @returns {boolean} Success status
 */
function addManualBlueprint(blueprint) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(blueprint.characterId);
    if (!character) {
      console.error('Character not found:', blueprint.characterId);
      return false;
    }

    const itemId = `manual-${Date.now()}`;
    const now = Date.now();

    db.prepare(`
      INSERT INTO blueprints (
        item_id, type_id, character_id, corporation_id, location_id,
        location_flag, quantity, time_efficiency, material_efficiency,
        runs, is_copy, is_corporation, source, manually_added,
        fetched_at, last_updated, cache_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemId,
      blueprint.typeId,
      blueprint.characterId,
      null,
      blueprint.locationId || 0,
      blueprint.locationFlag || 'Hangar',
      blueprint.isCopy ? -2 : -1,
      blueprint.timeEfficiency || 0,
      blueprint.materialEfficiency || 0,
      blueprint.runs || (blueprint.isCopy ? 1 : -1),
      blueprint.isCopy ? 1 : 0,
      0,
      'manual',
      1,
      now,
      now,
      null
    );

    console.log('Added manual blueprint:', blueprint.typeId);
    return true;
  } catch (error) {
    console.error('Error adding manual blueprint:', error);
    return false;
  }
}

/**
 * Remove a blueprint
 * @param {string} itemId - Blueprint item ID
 * @returns {boolean} Success status
 */
function removeBlueprint(itemId) {
  try {
    const db = getCharacterDatabase();

    const result = db.prepare('DELETE FROM blueprints WHERE item_id = ?').run(itemId);

    console.log('Removed blueprint:', itemId);
    return result.changes > 0;
  } catch (error) {
    console.error('Error removing blueprint:', error);
    return false;
  }
}

/**
 * Set blueprint override (ME or TE)
 * @param {string} itemId - Blueprint item ID
 * @param {string} field - Field to override ('materialEfficiency' or 'timeEfficiency')
 * @param {number} value - Override value
 * @returns {boolean} Success status
 */
function setBlueprintOverride(itemId, field, value) {
  try {
    const db = getCharacterDatabase();

    // Verify blueprint exists
    const blueprint = db.prepare('SELECT item_id FROM blueprints WHERE item_id = ?').get(itemId);
    if (!blueprint) {
      console.error('Blueprint not found:', itemId);
      return false;
    }

    if (value === null || value === undefined) {
      // Remove override
      db.prepare('DELETE FROM blueprint_overrides WHERE item_id = ? AND field = ?').run(itemId, field);
      console.log(`Removed blueprint override for ${itemId}, ${field}`);
    } else {
      // Set override
      db.prepare(`
        INSERT OR REPLACE INTO blueprint_overrides (item_id, field, value)
        VALUES (?, ?, ?)
      `).run(itemId, field, String(value));
      console.log(`Set blueprint override for ${itemId}, ${field}: ${value}`);
    }

    return true;
  } catch (error) {
    console.error('Error setting blueprint override:', error);
    return false;
  }
}

/**
 * Get all blueprints
 * @param {number} characterId - Optional character ID filter
 * @returns {Array} Blueprints
 */
function getBlueprints(characterId = null) {
  try {
    const db = getCharacterDatabase();

    let query = 'SELECT * FROM blueprints';
    let params = [];

    if (characterId) {
      query += ' WHERE character_id = ?';
      params.push(characterId);
    }

    const rows = db.prepare(query).all(...params);

    // Map database rows to expected format with overrides
    return rows.map(row => {
      // Get overrides for this blueprint
      const overrideRows = db.prepare('SELECT field, value FROM blueprint_overrides WHERE item_id = ?').all(row.item_id);
      const overrides = {};
      for (const override of overrideRows) {
        overrides[override.field] = parseFloat(override.value);
      }

      return {
        itemId: row.item_id,
        typeId: row.type_id,
        characterId: row.character_id,
        corporationId: row.corporation_id,
        locationId: row.location_id,
        locationFlag: row.location_flag,
        quantity: row.quantity,
        timeEfficiency: row.time_efficiency,
        materialEfficiency: row.material_efficiency,
        runs: row.runs,
        isCopy: row.is_copy === 1,
        isCorporation: row.is_corporation === 1,
        source: row.source,
        manuallyAdded: row.manually_added === 1,
        fetchedAt: row.fetched_at,
        lastUpdated: row.last_updated,
        cacheExpiresAt: row.cache_expires_at,
        overrides: overrides,
      };
    });
  } catch (error) {
    console.error('Error getting blueprints:', error);
    return [];
  }
}

/**
 * Get effective blueprint values (considering overrides)
 * @param {string} itemId - Blueprint item ID
 * @returns {Object} Effective ME and TE values
 */
function getEffectiveBlueprintValues(itemId) {
  try {
    const db = getCharacterDatabase();

    const blueprint = db.prepare('SELECT material_efficiency, time_efficiency FROM blueprints WHERE item_id = ?').get(itemId);

    if (!blueprint) {
      return null;
    }

    // Get overrides
    const meOverride = db.prepare('SELECT value FROM blueprint_overrides WHERE item_id = ? AND field = ?').get(itemId, 'materialEfficiency');
    const teOverride = db.prepare('SELECT value FROM blueprint_overrides WHERE item_id = ? AND field = ?').get(itemId, 'timeEfficiency');

    return {
      materialEfficiency: meOverride ? parseFloat(meOverride.value) : blueprint.material_efficiency,
      timeEfficiency: teOverride ? parseFloat(teOverride.value) : blueprint.time_efficiency,
      hasMEOverride: meOverride !== undefined,
      hasTEOverride: teOverride !== undefined,
    };
  } catch (error) {
    console.error('Error getting effective blueprint values:', error);
    return null;
  }
}

/**
 * Get market settings
 * @returns {Object} Market settings
 */
function getMarketSettings() {
  try {
    const settings = loadSettings();
    return settings.market || defaultSettings.market;
  } catch (error) {
    console.error('Error getting market settings:', error);
    return defaultSettings.market;
  }
}

/**
 * Update market settings
 * @param {Object} updates - Market settings to update
 * @returns {boolean} Success status
 */
function updateMarketSettings(updates) {
  return updateSettings('market', updates);
}

// Manufacturing Facilities Management
function getManufacturingFacilities() {
  const settings = loadSettings();
  return settings.manufacturing_facilities || [];
}

function addManufacturingFacility(facility) {
  const settings = loadSettings();
  if (!settings.manufacturing_facilities) {
    settings.manufacturing_facilities = [];
  }

  // Validate required fields
  if (!facility.name || !facility.name.trim()) {
    throw new Error('Facility name is required.');
  }

  if (!facility.usage) {
    throw new Error('Facility usage is required.');
  }

  if (!facility.facilityType) {
    throw new Error('Facility type is required.');
  }

  if (!facility.regionId) {
    throw new Error('Region is required.');
  }

  if (!facility.systemId) {
    throw new Error('Solar System is required.');
  }

  // Validate structure-specific fields
  if (facility.facilityType === 'structure' && !facility.structureTypeId) {
    throw new Error('Structure type is required for player structures.');
  }

  // Check for duplicate facility name (case-insensitive)
  const trimmedName = facility.name.trim();
  const existingFacility = settings.manufacturing_facilities.find(
    f => f.name.toLowerCase() === trimmedName.toLowerCase()
  );
  if (existingFacility) {
    throw new Error(`A facility with the name "${trimmedName}" already exists. Please choose a different name.`);
  }

  // Check if trying to add a Default facility when one already exists
  if (facility.usage === 'default') {
    const existingDefault = settings.manufacturing_facilities.find(f => f.usage === 'default');
    if (existingDefault) {
      throw new Error(`Only one Default facility is allowed. "${existingDefault.name}" is already set as the Default facility.`);
    }
  }

  // Generate unique ID
  const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  const newFacility = {
    id,
    ...facility,
    name: trimmedName, // Use trimmed name
    createdAt: Date.now()
  };

  settings.manufacturing_facilities.push(newFacility);
  saveSettings(settings);
  return newFacility;
}

function updateManufacturingFacility(id, updates) {
  const settings = loadSettings();
  if (!settings.manufacturing_facilities) {
    return false;
  }

  const index = settings.manufacturing_facilities.findIndex(f => f.id === id);
  if (index === -1) {
    return false;
  }

  // Check for duplicate facility name if name is being updated (case-insensitive)
  if (updates.name) {
    const trimmedName = updates.name.trim();
    if (!trimmedName) {
      throw new Error('Facility name cannot be empty.');
    }
    const existingFacility = settings.manufacturing_facilities.find(
      f => f.name.toLowerCase() === trimmedName.toLowerCase() && f.id !== id
    );
    if (existingFacility) {
      throw new Error(`A facility with the name "${trimmedName}" already exists. Please choose a different name.`);
    }
    updates.name = trimmedName; // Use trimmed name
  }

  // Validate structure-specific fields if facilityType is being updated
  if (updates.facilityType === 'structure' && !updates.structureTypeId && !settings.manufacturing_facilities[index].structureTypeId) {
    throw new Error('Structure type is required for player structures.');
  }

  // Check if trying to set usage to Default when another facility is already Default
  if (updates.usage === 'default') {
    const existingDefault = settings.manufacturing_facilities.find(f => f.usage === 'default' && f.id !== id);
    if (existingDefault) {
      throw new Error(`Only one Default facility is allowed. "${existingDefault.name}" is already set as the Default facility.`);
    }
  }

  settings.manufacturing_facilities[index] = {
    ...settings.manufacturing_facilities[index],
    ...updates,
    updatedAt: Date.now()
  };

  saveSettings(settings);
  return settings.manufacturing_facilities[index];
}

function removeManufacturingFacility(id) {
  const settings = loadSettings();
  if (!settings.manufacturing_facilities) {
    return false;
  }

  const initialLength = settings.manufacturing_facilities.length;
  settings.manufacturing_facilities = settings.manufacturing_facilities.filter(f => f.id !== id);

  if (settings.manufacturing_facilities.length === initialLength) {
    return false;
  }

  saveSettings(settings);
  return true;
}

function getManufacturingFacility(id) {
  const settings = loadSettings();
  if (!settings.manufacturing_facilities) {
    return null;
  }

  return settings.manufacturing_facilities.find(f => f.id === id) || null;
}

/**
 * Get character-specific division settings
 * @param {number} characterId - Character ID
 * @returns {Object} Division settings { enabledDivisions: [], divisionNames: {}, hasCustomNames: boolean }
 */
function getCharacterDivisionSettings(characterId) {
  try {
    const db = getCharacterDatabase();

    // Get character to verify it exists and get corporation ID
    const character = getCharacter(characterId);
    if (!character) {
      console.error('[Division Settings] Character not found:', characterId);
      return {
        enabledDivisions: [],
        divisionNames: {},
        hasCustomNames: false,
      };
    }

    // Get settings from character_settings table
    const settings = db.prepare(`
      SELECT enabled_divisions, division_names, division_names_cache_expires_at
      FROM character_settings
      WHERE character_id = ?
    `).get(characterId);

    if (!settings) {
      // No settings yet, return defaults
      return {
        enabledDivisions: [],
        divisionNames: {},
        hasCustomNames: false,
      };
    }

    const enabledDivisions = JSON.parse(settings.enabled_divisions || '[]');
    const divisionNames = settings.division_names ? JSON.parse(settings.division_names) : {};

    // Check if cache is still valid
    const now = Date.now();
    const cacheValid = settings.division_names_cache_expires_at &&
                      settings.division_names_cache_expires_at > now;

    return {
      enabledDivisions: enabledDivisions,
      divisionNames: divisionNames,
      hasCustomNames: Object.keys(divisionNames).length > 0 && cacheValid,
    };
  } catch (error) {
    console.error('[Division Settings] Error getting character division settings:', error);
    return {
      enabledDivisions: [],
      divisionNames: {},
      hasCustomNames: false,
    };
  }
}

/**
 * Update character-specific enabled divisions
 * @param {number} characterId - Character ID
 * @param {Array<number>} enabledDivisions - Array of enabled division IDs (1-7)
 * @returns {boolean} Success status
 */
function updateCharacterEnabledDivisions(characterId, enabledDivisions) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      console.error('[Division Settings] Character not found:', characterId);
      return false;
    }

    // Validate divisions array
    if (!Array.isArray(enabledDivisions)) {
      console.error('[Division Settings] enabledDivisions must be an array');
      return false;
    }

    // Validate division IDs are 1-7
    const validDivisions = enabledDivisions.filter(id => id >= 1 && id <= 7);
    if (validDivisions.length !== enabledDivisions.length) {
      console.warn('[Division Settings] Some invalid division IDs were filtered out');
    }

    // Sort for consistency
    validDivisions.sort((a, b) => a - b);

    // Insert or update
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions)
      VALUES (?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        enabled_divisions = excluded.enabled_divisions
    `).run(characterId, JSON.stringify(validDivisions));

    console.log(`[Division Settings] Updated enabled divisions for character ${characterId}:`, validDivisions);
    return true;
  } catch (error) {
    console.error('[Division Settings] Error updating character enabled divisions:', error);
    return false;
  }
}

/**
 * Update character division names from ESI
 * @param {number} characterId - Character ID
 * @param {Object} divisionData - Division data from ESI
 * @returns {boolean} Success status
 */
function updateCharacterDivisionNames(characterId, divisionData) {
  try {
    const db = getCharacterDatabase();

    // Verify character exists
    const character = db.prepare('SELECT character_id FROM characters WHERE character_id = ?').get(characterId);
    if (!character) {
      console.error('[Division Settings] Character not found:', characterId);
      return false;
    }

    const now = Date.now();

    // Insert or update
    db.prepare(`
      INSERT INTO character_settings (
        character_id, division_names, division_names_fetched_at,
        division_names_cache_expires_at, enabled_divisions
      )
      VALUES (?, ?, ?, ?, '[]')
      ON CONFLICT(character_id) DO UPDATE SET
        division_names = excluded.division_names,
        division_names_fetched_at = excluded.division_names_fetched_at,
        division_names_cache_expires_at = excluded.division_names_cache_expires_at
    `).run(
      characterId,
      JSON.stringify(divisionData.divisions),
      divisionData.lastUpdated,
      divisionData.cacheExpiresAt
    );

    console.log(`[Division Settings] Updated division names for character ${characterId}`);
    return true;
  } catch (error) {
    console.error('[Division Settings] Error updating character division names:', error);
    return false;
  }
}

/**
 * Get division names cache status
 * @param {number} characterId - Character ID
 * @returns {Object} Cache status { isCached, expiresAt, remainingSeconds }
 */
function getDivisionNamesCacheStatus(characterId) {
  try {
    const db = getCharacterDatabase();
    const settings = db.prepare(`
      SELECT division_names_cache_expires_at
      FROM character_settings
      WHERE character_id = ?
    `).get(characterId);

    if (!settings || !settings.division_names_cache_expires_at) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = settings.division_names_cache_expires_at;
    const remainingMs = expiresAt - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    return {
      isCached: remainingMs > 0,
      expiresAt: expiresAt,
      remainingSeconds: remainingSeconds,
    };
  } catch (error) {
    console.error('[Division Settings] Error getting division names cache status:', error);
    return { isCached: false, expiresAt: null, remainingSeconds: 0 };
  }
}

/**
 * Migrate global industry.enabledDivisions to per-character settings
 * This is a one-time migration that runs on app startup
 * @returns {boolean} Success status
 */
function migrateGlobalDivisionsToCharacters() {
  try {
    const db = getCharacterDatabase();
    const settings = loadSettings();

    // Check if migration is needed
    const globalDivisions = settings.industry?.enabledDivisions || [];

    if (globalDivisions.length === 0) {
      console.log('[Settings Migration] No global divisions to migrate');
      return true;
    }

    // Get all characters
    const characters = db.prepare('SELECT character_id FROM characters').all();

    if (characters.length === 0) {
      console.log('[Settings Migration] No characters to migrate divisions to');
      return true;
    }

    // Migrate global divisions to each character
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO character_settings (character_id, enabled_divisions)
      VALUES (?, ?)
    `);

    for (const char of characters) {
      insertStmt.run(char.character_id, JSON.stringify(globalDivisions));
      console.log(`[Settings Migration] Migrated divisions to character ${char.character_id}`);
    }

    // Clear global divisions (mark as migrated by setting to empty array)
    settings.industry.enabledDivisions = [];
    saveSettings(settings);

    console.log('[Settings Migration] Global divisions migration complete');
    return true;
  } catch (error) {
    console.error('[Settings Migration] Error migrating global divisions:', error);
    return false;
  }
}

/**
 * Get default manufacturing characters
 * @returns {number[]} Array of character IDs
 */
function getDefaultManufacturingCharacters() {
  const settings = loadSettings();
  return settings.industry?.defaultManufacturingCharacters || [];
}

/**
 * Set default manufacturing characters
 * @param {number[]} characterIds - Array of character IDs
 * @returns {boolean} Success status
 */
function setDefaultManufacturingCharacters(characterIds) {
  try {
    const settings = loadSettings();

    // Validate that all character IDs exist
    const db = getCharacterDatabase();
    const validIds = [];

    for (const characterId of characterIds) {
      const exists = db.prepare('SELECT character_id FROM characters WHERE character_id = ?')
        .get(characterId);
      if (exists) {
        validIds.push(characterId);
      }
    }

    // Update settings
    settings.industry = settings.industry || {};
    settings.industry.defaultManufacturingCharacters = validIds;

    saveSettings(settings);
    console.log('[Settings] Updated default manufacturing characters:', validIds);
    return true;
  } catch (error) {
    console.error('[Settings] Error setting default manufacturing characters:', error);
    return false;
  }
}

module.exports = {
  loadSettings,
  saveSettings,
  updateSettings,
  getSetting,
  resetSettings,
  getSettingsFilePath,
  defaultSettings,
  addCharacter,
  removeCharacter,
  updateCharacterTokens,
  getCharacters,
  getCharacter,
  updateCharacterSkills,
  getSkillsCacheStatus,
  setSkillOverride,
  getEffectiveSkillLevel,
  clearSkillOverrides,
  setDefaultCharacter,
  getDefaultCharacter,
  clearDefaultCharacter,
  updateCharacterBlueprints,
  addManualBlueprint,
  removeBlueprint,
  setBlueprintOverride,
  getBlueprints,
  getEffectiveBlueprintValues,
  getBlueprintsCacheStatus,
  getMarketSettings,
  updateMarketSettings,
  getManufacturingFacilities,
  addManufacturingFacility,
  updateManufacturingFacility,
  removeManufacturingFacility,
  getManufacturingFacility,
  getCharacterDivisionSettings,
  updateCharacterEnabledDivisions,
  updateCharacterDivisionNames,
  getDivisionNamesCacheStatus,
  migrateGlobalDivisionsToCharacters,
  getDefaultManufacturingCharacters,
  setDefaultManufacturingCharacters,
};
