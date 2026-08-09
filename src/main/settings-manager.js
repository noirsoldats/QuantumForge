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
    autoUpdateCharacterData: {
      skills: true,
      blueprints: true,
      assets: true
    },
    firstLaunchCompleted: false,
    wizardVersion: null,
    wizardCompletedAt: null,
    skippedUpdateVersion: null,  // Version string that user chose to skip
    // Last app version that completed startup. Read and written directly by
    // startup-backup.js (NOT through this module - it runs before settings
    // load, because loadSettings() migrates and persists as a side effect).
    // Declared here so mergeWithDefaults keeps the key rather than dropping it.
    lastRunVersion: null,
    auditModeEnabled: false,
  },
  accounts: {
    characters: [],
  },
  marketSets: [],
  toolPreferences: {
    manufacturingSummaryMarketSetId: null,
    manufacturingPlansMarketSetId: null,
    cleanupToolMarketSetId: null,
    blueprintCalculatorMarketSetId: null,
    reactionsCalculatorMarketSetId: null,
  },
  manufacturingSummary: {
    speculativeInvention: {
      enabled: false,
      decryptorStrategy: 'total-per-item',
    },
    // Pre-calculation market filters. The engine applies these while costing,
    // so they are configuration of what to build rather than a view filter.
    marketThresholds: {
      svrPeriod: 30,
      svrThreshold: null,
      iphEnabled: false,
      iphThreshold: null,
      profitEnabled: false,
      profitThreshold: null,
    },
    // Source and facility selections. characterId only applies when
    // characterFilter is 'specific'. The market set is NOT here - it uses the
    // shared per-tool toolPreferences.manufacturingSummaryMarketSetId.
    selections: {
      blueprintFilter: 'owned',
      characterFilter: 'all',
      characterId: null,
      facilityId: null,
      reactionFacilityId: null,
    },
    // Which tech levels and product categories go into the calculation.
    // null means "not configured yet" and resolves to everything selected -
    // distinct from an empty array, which is a deliberate "select nothing".
    blueprintChips: {
      tech: null,
      category: null,
    },
    // Which result columns are shown. null = the default set.
    visibleColumns: null,
    // Drag-reordered column sequence, covering every column. null = default.
    columnOrder: null,
  },
  // What Can I Build? UI state. Same rule as the categories around it: this
  // MUST be declared or updateSettings() silently drops the save.
  //
  // Migrated once out of the nine `cleanup-tool-*` localStorage keys the
  // un-ported screen used. The market set is NOT here - it uses the shared
  // per-tool toolPreferences.cleanupToolMarketSetId.
  whatCanIBuild: {
    blueprintFilter: 'owned',
    characterFilter: 'all',
    characterId: null,
    facilityId: null,
    includeT2Invention: false,
    // Percentage of a run's materials that must be on hand to list an item.
    threshold: 90,
    // { personal: [{characterId}], corporation: [{characterId, divisions}] }
    assetSources: null,
    // Arrays of the SELECTED names; null means "never configured".
    blueprintChips: { tech: null, category: null },
    visibleColumns: null,
    columnOrder: null,
    sort: null,
  },
  // Loot Analyzer UI state. Same rule as manufacturingSummary above: this
  // category MUST be declared or updateSettings() silently drops the save.
  //
  // These lived in localStorage on the un-ported screen and are migrated once
  // on first load - localStorage is per-origin, invisible to the user, and
  // does not travel with quantum_config.json.
  lootAnalyzer: {
    // { regionId, locationId } per market slot. null = nothing chosen.
    market1: null,
    market2: null,
    minSvr: 0,
    reprocessing: {
      stationType: 'npc',
      rig: 'none',
      rig2: 'none',
      reprocessing: 0,
      reprocessingEfficiency: 0,
      implantBonus: 0,
    },
    // element id -> level (0-5), for the 15 ore processing skills.
    oreSkills: {},
  },
  // Asset Manager UI state. A top-level per-tool category, matching
  // manufacturingSummary above - NOT a key in toolPreferences, which holds one
  // scalar market-set id per tool and is read that way by
  // getToolMarketSet/setToolMarketSet.
  //
  // MUST be declared here: updateSettings() silently no-ops for a category that
  // does not already exist, so without this the first save would vanish with
  // only a console error.
  assets: {
    // [{ id, name, config: { cats, locs, bp, groupBy, aggregate } }]
    savedViews: [],
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

      // Run old sub-migration first if market key still present (handles partial state)
      if (loadedSettings.market && !Array.isArray(loadedSettings.marketSets)) {
        loadedSettings.market = migrateMarketLocationSettings(loadedSettings.market);
      }
      // Migrate settings.market → settings.marketSets (idempotent)
      migrateMarketToMarketSets(loadedSettings);

      // Legacy window-state keys → the generic view host's names. Persisted
      // immediately so it does not re-run; the old keys are gone afterwards,
      // so the next load finds nothing to do.
      if (migrateWindowStateKeys(loadedSettings)) {
        saveSettings(loadedSettings);
      }

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
 * Handles deep merging for nested objects like market.inputMaterials
 * @param {Object} loaded - Loaded settings
 * @param {Object} defaults - Default settings
 * @returns {Object} Merged settings
 */
function mergeWithDefaults(loaded, defaults) {
  const merged = { ...defaults };

  for (const key in loaded) {
    if (typeof loaded[key] === 'object' && !Array.isArray(loaded[key]) && loaded[key] !== null) {
      // Deep merge for nested objects
      merged[key] = deepMergeWithDefaults(loaded[key], defaults[key] || {});
    } else {
      merged[key] = loaded[key];
    }
  }

  return merged;
}

/**
 * Deep merge helper for nested settings objects
 * @param {Object} loaded - Loaded settings object
 * @param {Object} defaults - Default settings object
 * @returns {Object} Merged object
 */
function deepMergeWithDefaults(loaded, defaults) {
  const merged = { ...defaults };

  for (const key in loaded) {
    if (typeof loaded[key] === 'object' && !Array.isArray(loaded[key]) && loaded[key] !== null) {
      merged[key] = deepMergeWithDefaults(loaded[key], defaults[key] || {});
    } else {
      merged[key] = loaded[key];
    }
  }

  return merged;
}

/**
 * Migrate market location settings from legacy shared location to per-section locations
 * @param {Object} marketSettings - Market settings object
 * @returns {Object} Migrated market settings
 */
function migrateMarketLocationSettings(marketSettings) {
  // Skip if already migrated (inputMaterials has regionId)
  if (marketSettings.inputMaterials?.regionId !== undefined) {
    return marketSettings;
  }

  console.log('[Settings Migration] Migrating market location settings to new structure');

  const migrated = { ...marketSettings };

  // Copy shared location to inputMaterials
  migrated.inputMaterials = {
    ...migrated.inputMaterials,
    locationType: marketSettings.locationType || 'hub',
    locationId: marketSettings.locationId || 60003760,
    regionId: marketSettings.regionId || 10000002,
    systemId: marketSettings.systemId || 30000142,
  };

  // Set outputProducts to use same location by default
  migrated.outputProducts = {
    ...migrated.outputProducts,
    useSameLocation: true,
    locationType: marketSettings.locationType || 'hub',
    locationId: marketSettings.locationId || 60003760,
    regionId: marketSettings.regionId || 10000002,
    systemId: marketSettings.systemId || 30000142,
  };

  console.log('[Settings Migration] Market location migration complete');
  return migrated;
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
      const isFirstCharacter = characterCount === 1;
      if (isFirstCharacter) {
        settings.accounts.defaultCharacterId = characterData.character.characterId;
        saveSettings(settings);
        console.log('[Settings] Automatically set first character as default:', characterData.character.characterName);
      }

      // Every character gets a settings row so nothing has to cope with an
      // absent one. The FIRST character is also enrolled as a blueprint source:
      // without it a brand-new user gets ME 0 everywhere with nothing on screen
      // explaining why (migration 026 cannot help them - it runs before any
      // character exists). Later characters stay opt-in, which is the whole
      // point of the feature.
      //
      // Corp divisions are NOT enabled here - corp blueprints are always
      // opt-in, for the first character too.
      ensureCharacterSettingsRow(characterData.character.characterId, {
        useBlueprintsFrom: isFirstCharacter,
      });

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

    const wasDefault = settings.accounts.defaultCharacterId === characterId;

    // Delete character (CASCADE will handle related skills, blueprints, etc.)
    const result = db.prepare('DELETE FROM characters WHERE character_id = ?').run(characterId);

    // Promote a successor rather than leaving "characters but no default" -
    // a state where skills, blueprints and pricing all silently degrade.
    if (wasDefault) {
      const successor = db
        .prepare('SELECT character_id FROM characters ORDER BY added_at LIMIT 1')
        .get();

      if (successor) {
        settings.accounts.defaultCharacterId = successor.character_id;
        saveSettings(settings);
        console.log(`Promoted character ${successor.character_id} to default after removal`);

        // The successor may never have been enrolled as a blueprint source
        // (only the FIRST character is auto-enrolled), which would leave the
        // user with a default character and no blueprint sources at all.
        const sources = getBlueprintSources();
        if (sources.characterIds.length === 0) {
          setUseBlueprintsFrom(successor.character_id, true);
          console.log(
            `Enrolled ${successor.character_id} as a blueprint source ` +
            '(no other character was enabled)'
          );
        }
      } else {
        delete settings.accounts.defaultCharacterId;
        saveSettings(settings);
        console.log('Cleared default character - no characters remain');
      }
    }

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

    // REFUSE to write a result that carries no skills.
    //
    // This is a delete-then-insert, so an empty payload does not "update
    // nothing" - it DESTROYS every skill the character has, and stamps
    // total_sp = 0 over the real figure.
    //
    // A fetch returns exactly that shape whenever esiFetch declines to call:
    // the per-endpoint gate (called again inside the 5-minute window), the
    // error-budget reserve, or a 420 all yield `{ skipped: true, skills: {},
    // totalSp: 0 }`. The background cycle checks `.skipped`; the direct
    // skills:fetch handler did not, so one extra Refresh click inside the
    // cache window wiped the character's skills - and, because the wipe was
    // persisted, they stayed gone across restarts.
    //
    // Guarding on the DATA rather than only on the `skipped` flag also covers
    // an ESI 200 that legitimately carries nothing, and any future caller that
    // forgets the flag. A character with genuinely zero skills does not exist
    // in EVE - every capsuleer starts with some.
    if (skillsData && skillsData.skipped) {
      console.log(
        `[Skills] Skipped update for character ${characterId}: the fetch was gated, ` +
        'so there is nothing to write (existing skills kept).'
      );
      return false;
    }

    const incomingSkills = (skillsData && skillsData.skills) || {};
    if (Object.keys(incomingSkills).length === 0) {
      console.warn(
        `[Skills] Refusing to write an EMPTY skill set for character ${characterId} - ` +
        'this would delete every stored skill. Existing skills kept.'
      );
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

    // "Characters exist, but none is default" is not a state worth supporting:
    // every tool that resolves skills, blueprints or pricing has to invent a
    // fallback for it, and the user gets silently degraded results. If any
    // character remains, refuse and keep the current default.
    const db = getCharacterDatabase();
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM characters').get().n;
    if (remaining > 0) {
      console.warn(
        `[Settings] Refusing to clear the default character while ${remaining} ` +
        'character(s) exist; pick a different default instead.'
      );
      return false;
    }

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

    // A gated fetch returns an empty list, and this is a delete-then-insert, so
    // writing it would delete every stored blueprint. See the fuller note in
    // updateCharacterSkills.
    //
    // Guarded on `skipped` ONLY, not on emptiness: unlike skills, having zero
    // blueprints is a legitimate state (a new character, or one who sold them
    // all), and refusing an empty write would make that state impossible to
    // reach.
    if (blueprintsData && blueprintsData.skipped) {
      console.log(
        `[Blueprints] Skipped update for character ${characterId}: the fetch was gated, ` +
        'so there is nothing to write (existing blueprints kept).'
      );
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
      console.error('[Settings Manager] Error saving blueprints:', error);
      console.error('[Settings Manager] Failed blueprint count:', blueprintsData.blueprints.length);
      console.error('[Settings Manager] Character ID:', characterId);

      // Log specific constraint violations
      if (error.message && error.message.includes('PRIMARY KEY')) {
        console.error('[Settings Manager] PRIMARY KEY constraint violation detected');
        console.error('[Settings Manager] This may indicate duplicate item_ids for different characters');
      }

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
 * @param {number} characterId - Character ID
 * @param {string} itemId - Blueprint item ID
 * @returns {boolean} Success status
 */
function removeBlueprint(characterId, itemId) {
  try {
    const db = getCharacterDatabase();

    const result = db.prepare('DELETE FROM blueprints WHERE character_id = ? AND item_id = ?')
      .run(characterId, itemId);

    console.log('Removed blueprint:', characterId, itemId);
    return result.changes > 0;
  } catch (error) {
    console.error('Error removing blueprint:', error);
    return false;
  }
}

/**
 * Set blueprint override (ME or TE)
 * @param {number} characterId - Character ID
 * @param {string} itemId - Blueprint item ID
 * @param {string} field - Field to override ('materialEfficiency' or 'timeEfficiency')
 * @param {number} value - Override value
 * @returns {boolean} Success status
 */
function setBlueprintOverride(characterId, itemId, field, value) {
  try {
    const db = getCharacterDatabase();

    // Verify blueprint exists
    const blueprint = db.prepare('SELECT item_id FROM blueprints WHERE character_id = ? AND item_id = ?')
      .get(characterId, itemId);
    if (!blueprint) {
      console.error('Blueprint not found:', characterId, itemId);
      return false;
    }

    if (value === null || value === undefined) {
      // Remove override
      db.prepare('DELETE FROM blueprint_overrides WHERE character_id = ? AND item_id = ? AND field = ?')
        .run(characterId, itemId, field);
      console.log(`Removed blueprint override for ${characterId}, ${itemId}, ${field}`);
    } else {
      // Set override
      db.prepare(`
        INSERT OR REPLACE INTO blueprint_overrides (character_id, item_id, field, value)
        VALUES (?, ?, ?, ?)
      `).run(characterId, itemId, field, String(value));
      console.log(`Set blueprint override for ${characterId}, ${itemId}, ${field}: ${value}`);
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

// ============================================================
// Market Sets Management
// ============================================================

/** Default Market Set shape used when building the migration set */
const DEFAULT_MARKET_SET_TEMPLATE = {
  inputMaterials: {
    locationType: 'hub',
    locationId: 60003760,
    regionId: 10000002,
    systemId: 30000142,
    structureId: null,
    structureName: null,
    characterId: null,
    priceType: 'sell',
    priceMethod: 'hybrid',
    priceModifier: 1.0,
    percentile: 0.2,
    minVolume: 1000,
  },
  outputProducts: {
    useSameLocation: true,
    locationType: 'hub',
    locationId: 60003760,
    regionId: 10000002,
    systemId: 30000142,
    structureId: null,
    structureName: null,
    characterId: null,
    priceType: 'sell',
    priceMethod: 'hybrid',
    priceModifier: 1.0,
    percentile: 0.2,
    minVolume: 1000,
  },
  warningThreshold: 0.3,
};

/**
 * Legacy window-state keys → the generic view host's `view-<key>` names.
 *
 * Every screen used to own a bespoke window module that stored its bounds under
 * its own name. They are all served by `view-window.js` now, which keys bounds
 * as `view-${windowKey(viewId, params)}`. Without this rename every user's
 * remembered size and position is silently abandoned the first time a screen is
 * popped out.
 *
 * THREE SHAPES - a blind `view-` prefix is wrong for the per-character ones:
 *
 *   cleanup-tool          -> view-what-can-i-build        (id also renamed)
 *   loot-analyzer         -> view-loot-analyzer           (prefix only)
 *   skills-133585695      -> view-skills?characterId=133585695   (id + params)
 *
 * The params form must match `windowKey` EXACTLY. That function runs values
 * through `JSON.stringify`, which quotes strings - so `characterId` must be
 * emitted as a bare number (`characterId=133585695`). Emitting
 * `characterId="133585695"` produces a key nothing ever reads, losing the
 * placement this migration exists to preserve.
 */
const LEGACY_WINDOW_KEYS = {
  'cleanup-tool': 'view-what-can-i-build',
  'loot-analyzer': 'view-loot-analyzer',
  'manufacturing-summary': 'view-manufacturing-summary',
  'manufacturing-plans': 'view-manufacturing-plans',
  'esi-status': 'view-esi-status',
  'audit-log': 'view-audit-log',
  settings: 'view-settings',
};

/** Per-character prefixes: `<prefix>-<characterId>` -> `view-<viewId>?characterId=<id>`. */
const LEGACY_CHARACTER_WINDOWS = {
  skills: 'skills',
  blueprints: 'blueprints',
  assets: 'assets',
};

/**
 * Rename legacy window-state keys in place (idempotent).
 * @param {Object} settings - Settings object (mutated in-place)
 * @returns {boolean} true when anything was renamed
 */
function migrateWindowStateKeys(settings) {
  const states = settings.windowStates;
  if (!states || typeof states !== 'object') return false;

  let changed = false;

  const rename = (oldKey, newKey) => {
    if (!Object.prototype.hasOwnProperty.call(states, oldKey)) return;
    // Unconditional: a config holding BOTH keys only exists on a machine that
    // already ran a newer build, which is not the upgrade path this migration
    // serves. Guarding for it would complicate the common case for nobody.
    states[newKey] = states[oldKey];
    delete states[oldKey];
    changed = true;
    console.log(`[Settings Migration] Window state "${oldKey}" → "${newKey}"`);
  };

  Object.entries(LEGACY_WINDOW_KEYS).forEach(([oldKey, newKey]) => rename(oldKey, newKey));

  // Snapshot the keys first: `rename` adds and deletes as it goes, and
  // iterating a live object while mutating it is how entries get skipped.
  Object.keys(states).slice().forEach((key) => {
    const match = /^([a-z]+)-(\d+)$/.exec(key);
    if (!match) return;
    const viewId = LEGACY_CHARACTER_WINDOWS[match[1]];
    if (!viewId) return;
    // Bare number, matching windowKey's JSON.stringify of a numeric id.
    rename(key, `view-${viewId}?characterId=${match[2]}`);
  });

  return changed;
}

/**
 * Migrate settings.market → settings.marketSets (idempotent, mutates the passed object).
 * Also moves speculativeInvention from market → manufacturingSummary.
 * @param {Object} settings - Settings object (mutated in-place)
 */
function migrateMarketToMarketSets(settings) {
  if (Array.isArray(settings.marketSets)) {
    return; // Already migrated
  }

  console.log('[Settings Migration] Migrating settings.market → settings.marketSets');

  const oldMarket = settings.market || {};

  // Move speculativeInvention to manufacturingSummary if present
  if (oldMarket.speculativeInvention) {
    settings.manufacturingSummary = settings.manufacturingSummary || {};
    settings.manufacturingSummary.speculativeInvention = { ...oldMarket.speculativeInvention };
    console.log('[Settings Migration] Moved speculativeInvention → manufacturingSummary');
  }

  // Build the Default Market Set from old market settings
  const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  const now = Date.now();

  const inputMaterials = {
    ...DEFAULT_MARKET_SET_TEMPLATE.inputMaterials,
    ...(oldMarket.inputMaterials || {}),
  };
  const outputProducts = {
    ...DEFAULT_MARKET_SET_TEMPLATE.outputProducts,
    ...(oldMarket.outputProducts || {}),
  };

  // Ensure private structure fields are present
  for (const section of [inputMaterials, outputProducts]) {
    if (!('structureId' in section)) section.structureId = null;
    if (!('structureName' in section)) section.structureName = null;
    if (!('characterId' in section)) section.characterId = null;
  }

  settings.marketSets = [{
    id,
    name: 'Default',
    isDefault: true,
    createdAt: now,
    updatedAt: now,
    inputMaterials,
    outputProducts,
    warningThreshold: oldMarket.warningThreshold ?? 0.3,
  }];

  delete settings.market;

  // Persist so this migration does not re-run on the next loadSettings() call
  saveSettings(settings);

  console.log('[Settings Migration] Migration complete — created "Default" Market Set');
}

/**
 * Validate a Market Set name.
 * @param {string} name
 * @param {string|null} excludeId - Set ID to exclude from duplicate check (for edits)
 * @returns {string} Trimmed, validated name
 * @throws {Error} If invalid
 */
function validateMarketSetName(name, excludeId = null) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Market Set name is required.');
  if (!/^[a-zA-Z0-9 _\-()+]+$/.test(trimmed)) {
    throw new Error('Name may only contain letters, numbers, spaces, and the characters _ - ( ) +');
  }
  if (trimmed.length > 50) throw new Error('Name must be 50 characters or less.');
  const settings = loadSettings();
  const duplicate = (settings.marketSets || []).find(
    s => s.name.toLowerCase() === trimmed.toLowerCase() && s.id !== excludeId
  );
  if (duplicate) throw new Error(`A Market Set named "${trimmed}" already exists.`);
  return trimmed;
}

/**
 * Get all Market Sets.
 * @returns {Array} Array of Market Set objects
 */
function getMarketSets() {
  const settings = loadSettings();
  return settings.marketSets || [];
}

/**
 * Get the default Market Set (isDefault === true, or first set, or null).
 * @returns {Object|null}
 */
function getDefaultMarketSet() {
  const sets = getMarketSets();
  return sets.find(s => s.isDefault) || sets[0] || null;
}

/**
 * Get a Market Set by ID.
 * @param {string} id
 * @returns {Object|null}
 */
function getMarketSetById(id) {
  return getMarketSets().find(s => s.id === id) || null;
}

/**
 * Add a new Market Set.
 * @param {Object} setData - Market Set data (name, isDefault, inputMaterials, outputProducts, warningThreshold)
 * @returns {Object} The created Market Set
 */
function addMarketSet(setData) {
  const settings = loadSettings();
  if (!settings.marketSets) settings.marketSets = [];

  const trimmedName = validateMarketSetName(setData.name);

  // If this set is default, clear isDefault on all others
  if (setData.isDefault) {
    settings.marketSets.forEach(s => { s.isDefault = false; });
  }

  const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  const now = Date.now();

  const newSet = {
    id,
    name: trimmedName,
    isDefault: setData.isDefault || false,
    createdAt: now,
    updatedAt: now,
    inputMaterials: { ...DEFAULT_MARKET_SET_TEMPLATE.inputMaterials, ...(setData.inputMaterials || {}) },
    outputProducts: { ...DEFAULT_MARKET_SET_TEMPLATE.outputProducts, ...(setData.outputProducts || {}) },
    warningThreshold: setData.warningThreshold ?? 0.3,
  };

  // Ensure private structure fields are present
  for (const section of [newSet.inputMaterials, newSet.outputProducts]) {
    if (!('structureId' in section)) section.structureId = null;
    if (!('structureName' in section)) section.structureName = null;
    if (!('characterId' in section)) section.characterId = null;
  }

  settings.marketSets.push(newSet);
  saveSettings(settings);
  return newSet;
}

/**
 * Update an existing Market Set.
 * @param {string} id - Market Set ID
 * @param {Object} updates - Fields to update
 * @returns {Object} The updated Market Set
 */
function updateMarketSet(id, updates) {
  const settings = loadSettings();
  if (!settings.marketSets) throw new Error('No Market Sets configured.');

  const index = settings.marketSets.findIndex(s => s.id === id);
  if (index === -1) throw new Error(`Market Set "${id}" not found.`);

  if (updates.name !== undefined) {
    updates.name = validateMarketSetName(updates.name, id);
  }

  // If setting this as default, clear isDefault on all others
  if (updates.isDefault === true) {
    settings.marketSets.forEach(s => { s.isDefault = false; });
  }

  settings.marketSets[index] = {
    ...settings.marketSets[index],
    ...updates,
    updatedAt: Date.now(),
  };

  // Ensure private structure fields are present in inputMaterials/outputProducts
  for (const sectionKey of ['inputMaterials', 'outputProducts']) {
    if (settings.marketSets[index][sectionKey]) {
      const section = settings.marketSets[index][sectionKey];
      if (!('structureId' in section)) section.structureId = null;
      if (!('structureName' in section)) section.structureName = null;
      if (!('characterId' in section)) section.characterId = null;
    }
  }

  saveSettings(settings);
  return settings.marketSets[index];
}

/**
 * Delete a Market Set by ID.
 * @param {string} id
 * @returns {boolean}
 */
function deleteMarketSet(id) {
  const settings = loadSettings();
  if (!settings.marketSets) throw new Error('No Market Sets configured.');

  const index = settings.marketSets.findIndex(s => s.id === id);
  if (index === -1) throw new Error(`Market Set "${id}" not found.`);

  if (settings.marketSets.length === 1) {
    throw new Error('Cannot delete the only Market Set.');
  }

  const wasDefault = settings.marketSets[index].isDefault;
  settings.marketSets.splice(index, 1);

  // Promote the first remaining set to default if we deleted the default
  if (wasDefault && settings.marketSets.length > 0) {
    settings.marketSets[0].isDefault = true;
  }

  saveSettings(settings);
  return true;
}

/**
 * Set a Market Set as the default.
 * @param {string} id
 * @returns {Object} Updated Market Set
 */
function setDefaultMarketSet(id) {
  return updateMarketSet(id, { isDefault: true });
}

/**
 * Get the tool-specific Market Set ID preference.
 * @param {string} toolKey - One of the toolPreferences keys
 * @returns {string|null}
 */
function getToolMarketSetId(toolKey) {
  const settings = loadSettings();
  return settings.toolPreferences?.[toolKey] || null;
}

/**
 * Save the tool-specific Market Set ID preference.
 * @param {string} toolKey
 * @param {string|null} id
 * @returns {boolean}
 */
function setToolMarketSetId(toolKey, id) {
  const settings = loadSettings();
  if (!settings.toolPreferences) settings.toolPreferences = {};
  settings.toolPreferences[toolKey] = id;
  return saveSettings(settings);
}

/**
 * Resolve the Market Set for a given tool. Returns the saved preference if it
 * still exists, otherwise falls back to the default Market Set.
 * Always returns the full Market Set object — callers must use set.inputMaterials,
 * set.outputProducts etc. directly.
 * @param {string} toolKey
 * @returns {Object|null} Full Market Set object
 */
function resolveMarketSetForTool(toolKey) {
  const savedId = getToolMarketSetId(toolKey);
  if (savedId) {
    const set = getMarketSetById(savedId);
    if (set) return set;
  }
  return getDefaultMarketSet();
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

  // Validate usage type
  const validUsageTypes = [
    'default', 'components', 'subsystems', 't3-ships',
    'capitals', 'super-capitals', 't2-invention', 't3-invention',
    'copy', 'boosters', 'reactions',
    'reactions-basic', 'reactions-advanced', 'reactions-composite',
    'reprocessing', 'reprocessing-moon'
  ];
  if (!validUsageTypes.includes(facility.usage)) {
    throw new Error(`Invalid facility usage: ${facility.usage}`);
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

    // Whether the cache is FRESH is a different question from whether custom
    // names EXIST. Conflating them made the "using generic division names"
    // warning reappear once the TTL lapsed, even though the real names were
    // still stored and still being displayed.
    const now = Date.now();
    const cacheValid = !!settings.division_names_cache_expires_at &&
                      settings.division_names_cache_expires_at > now;

    return {
      enabledDivisions: enabledDivisions,
      divisionNames: divisionNames,
      // Do we have names at all? Drives the warning.
      hasCustomNames: Object.keys(divisionNames).length > 0,
      // Are they still fresh? Drives whether a refresh is worth offering.
      namesCacheValid: cacheValid,
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
 * Update character-specific enabled ASSET divisions. UNGUARDED.
 *
 * Does not check that the character exists. Prefer the guarded
 * `updateCharacterEnabledDivisions`; this variant exists for bootstrap paths
 * that legitimately write outside the normal lifecycle.
 *
 * @param {number} characterId - Character ID
 * @param {Array<number>} enabledDivisions - Array of enabled division IDs (1-7)
 * @returns {boolean} Success status
 */
function updateCharacterEnabledDivisions_Unsafe(characterId, enabledDivisions) {
  try {
    const db = getCharacterDatabase();

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
 * Update character-specific enabled ASSET divisions.
 *
 * Refuses to write for a character that does not exist. This preserves the
 * behaviour this function has always had; the check simply moved into the
 * shared guard so the asset and blueprint setters cannot drift apart.
 *
 * @param {number} characterId
 * @param {Array<number>} enabledDivisions division ids (1-7)
 * @returns {boolean} success
 */
const updateCharacterEnabledDivisions = guardCharacterExists(
  'Division Settings',
  updateCharacterEnabledDivisions_Unsafe
);

/**
 * Does this character exist?
 *
 * Shared by the guarded source-setting wrappers below so the check reads the
 * same everywhere.
 *
 * @param {number} characterId
 * @returns {boolean}
 */
function characterExists(characterId) {
  try {
    const db = getCharacterDatabase();
    return !!db
      .prepare('SELECT 1 FROM characters WHERE character_id = ?')
      .get(characterId);
  } catch (error) {
    console.error('[Settings] Error checking character existence:', error);
    return false;
  }
}

/**
 * Guard wrapper: refuse to write settings for a character that does not exist.
 *
 * Writing settings for a non-existent character leaves an orphan row that no
 * UI shows and nothing cleans up, and it usually means the caller passed the
 * wrong id. Every public setter goes through this; the `_Unsafe` variants
 * remain available for bootstrap paths that legitimately write before or
 * outside the normal lifecycle.
 *
 * @param {string} label for the log line
 * @param {Function} unsafeFn the raw setter
 * @returns {Function} the guarded setter
 */
function guardCharacterExists(label, unsafeFn) {
  return function guarded(characterId, ...rest) {
    if (!characterExists(characterId)) {
      console.error(`[${label}] Character not found: ${characterId}`);
      return false;
    }
    return unsafeFn(characterId, ...rest);
  };
}

/**
 * Ensure a character_settings row exists.
 *
 * These rows were historically created lazily - only when a user edited
 * division settings - so most characters had no row at all. That was harmless
 * while every setting in the table defaulted to "off and irrelevant", but
 * `use_blueprints_from` is neither: an absent row means blueprint ME silently
 * resolves to 0 with nothing on screen to explain why.
 *
 * Callers that create or first touch a character should call this so the row
 * is always there to be read and updated.
 *
 * @param {number} characterId
 * @param {Object} [defaults]
 * @param {boolean} [defaults.useBlueprintsFrom=false]
 * @returns {boolean} success
 */
function ensureCharacterSettingsRow(characterId, defaults = {}) {
  try {
    const db = getCharacterDatabase();
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions, use_blueprints_from)
      VALUES (?, '[]', ?)
      ON CONFLICT(character_id) DO NOTHING
    `).run(characterId, defaults.useBlueprintsFrom ? 1 : 0);
    return true;
  } catch (error) {
    console.error('[Blueprint Sources] Error ensuring character_settings row:', error);
    return false;
  }
}

/**
 * Characters and corp divisions enabled as BLUEPRINT sources.
 *
 * Separate from the asset sources on purpose: a corp may keep BPOs in a
 * library division while materials live in a production division, so enabling
 * one must not implicitly enable the other.
 *
 * @returns {{characterIds: number[], divisionsByCharacter: Object}}
 */
function getBlueprintSources() {
  try {
    const db = getCharacterDatabase();
    const rows = db.prepare(`
      SELECT character_id, use_blueprints_from, blueprint_enabled_divisions
        FROM character_settings
       WHERE use_blueprints_from = 1
    `).all();

    const characterIds = [];
    const divisionsByCharacter = {};

    for (const row of rows) {
      characterIds.push(row.character_id);
      try {
        divisionsByCharacter[row.character_id] = JSON.parse(row.blueprint_enabled_divisions || '[]');
      } catch (error) {
        console.error(
          `[Blueprint Sources] Unparseable blueprint_enabled_divisions for ${row.character_id}; treating as none:`,
          error
        );
        divisionsByCharacter[row.character_id] = [];
      }
    }

    return { characterIds, divisionsByCharacter };
  } catch (error) {
    console.error('[Blueprint Sources] Error reading blueprint sources:', error);
    return { characterIds: [], divisionsByCharacter: {} };
  }
}

/**
 * One character's blueprint-source settings.
 *
 * Separate from getBlueprintSources (which returns only ENABLED characters,
 * for resolution) - the Settings UI needs to render a row for every character,
 * including the ones that are turned off.
 *
 * @param {number} characterId
 * @returns {{useBlueprintsFrom: boolean, enabledDivisions: number[]}}
 */
function getCharacterBlueprintSettings(characterId) {
  try {
    const db = getCharacterDatabase();
    const row = db.prepare(`
      SELECT use_blueprints_from, blueprint_enabled_divisions
        FROM character_settings
       WHERE character_id = ?
    `).get(characterId);

    if (!row) {
      // No row yet: absent means opted out, which is the correct default.
      return { useBlueprintsFrom: false, enabledDivisions: [] };
    }

    let enabledDivisions = [];
    try {
      enabledDivisions = JSON.parse(row.blueprint_enabled_divisions || '[]');
    } catch (error) {
      console.error(
        `[Blueprint Sources] Unparseable divisions for ${characterId}; treating as none:`,
        error
      );
    }

    return {
      useBlueprintsFrom: !!row.use_blueprints_from,
      enabledDivisions,
    };
  } catch (error) {
    console.error('[Blueprint Sources] Error reading character blueprint settings:', error);
    return { useBlueprintsFrom: false, enabledDivisions: [] };
  }
}

/**
 * Turn a character on or off as a blueprint source. UNGUARDED.
 *
 * Writes without checking that the character exists. Use the guarded
 * `setUseBlueprintsFrom` unless you are a bootstrap path that must write
 * before or outside the normal character lifecycle.
 *
 * @param {number} characterId
 * @param {boolean} enabled
 * @returns {boolean} success
 */
function setUseBlueprintsFrom_Unsafe(characterId, enabled) {
  try {
    const db = getCharacterDatabase();
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions, use_blueprints_from)
      VALUES (?, '[]', ?)
      ON CONFLICT(character_id) DO UPDATE SET
        use_blueprints_from = excluded.use_blueprints_from
    `).run(characterId, enabled ? 1 : 0);
    return true;
  } catch (error) {
    console.error('[Blueprint Sources] Error setting use_blueprints_from:', error);
    return false;
  }
}

/**
 * Set which corp divisions supply BLUEPRINTS for a character. UNGUARDED.
 *
 * See setUseBlueprintsFrom_Unsafe - prefer the guarded
 * `setBlueprintEnabledDivisions`.
 *
 * @param {number} characterId
 * @param {number[]} divisions division ids (1-7); invalid ids are dropped
 * @returns {boolean} success
 */
function setBlueprintEnabledDivisions_Unsafe(characterId, divisions) {
  try {
    const db = getCharacterDatabase();
    const valid = (divisions || [])
      .filter((id) => Number.isInteger(id) && id >= 1 && id <= 7)
      .sort((a, b) => a - b);

    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions, blueprint_enabled_divisions)
      VALUES (?, '[]', ?)
      ON CONFLICT(character_id) DO UPDATE SET
        blueprint_enabled_divisions = excluded.blueprint_enabled_divisions
    `).run(characterId, JSON.stringify(valid));
    return true;
  } catch (error) {
    console.error('[Blueprint Sources] Error setting blueprint divisions:', error);
    return false;
  }
}

/**
 * Turn a character on or off as a blueprint source.
 *
 * Refuses to write for a character that does not exist, matching the asset
 * setters. Use setUseBlueprintsFrom_Unsafe if you need to bypass that.
 *
 * @param {number} characterId
 * @param {boolean} enabled
 * @returns {boolean} success
 */
const setUseBlueprintsFrom = guardCharacterExists(
  'Blueprint Sources',
  setUseBlueprintsFrom_Unsafe
);

/**
 * Set which corp divisions supply BLUEPRINTS for a character.
 *
 * Guarded; see setBlueprintEnabledDivisions_Unsafe for the raw variant.
 *
 * @param {number} characterId
 * @param {number[]} divisions division ids (1-7)
 * @returns {boolean} success
 */
const setBlueprintEnabledDivisions = guardCharacterExists(
  'Blueprint Sources',
  setBlueprintEnabledDivisions_Unsafe
);

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
 * Migrate autoUpdateCharacterData from boolean to object
 * One-time migration on app startup
 * @returns {boolean} Success status
 */
function migrateAutoUpdateCharacterDataSetting() {
  try {
    const settings = loadSettings();

    // Check if migration needed
    const currentValue = settings.general?.autoUpdateCharacterData;

    // Already migrated (is an object)
    if (typeof currentValue === 'object' && currentValue !== null) {
      console.log('[Settings Migration] autoUpdateCharacterData already migrated');
      return true;
    }

    // Migrate boolean to object
    if (typeof currentValue === 'boolean') {
      console.log('[Settings Migration] Migrating autoUpdateCharacterData from boolean to object');

      settings.general = settings.general || {};
      settings.general.autoUpdateCharacterData = {
        skills: currentValue,
        blueprints: currentValue,
        assets: currentValue  // Default to same as skills/blueprints
      };

      saveSettings(settings);
      console.log('[Settings Migration] Migration complete:', settings.general.autoUpdateCharacterData);
      return true;
    }

    // No migration needed (undefined or null - will use defaults)
    console.log('[Settings Migration] No migration needed for autoUpdateCharacterData');
    return true;
  } catch (error) {
    console.error('[Settings Migration] Error migrating autoUpdateCharacterData:', error);
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
  getMarketSets,
  getDefaultMarketSet,
  getMarketSetById,
  addMarketSet,
  updateMarketSet,
  deleteMarketSet,
  setDefaultMarketSet,
  getToolMarketSetId,
  setToolMarketSetId,
  resolveMarketSetForTool,
  validateMarketSetName,
  getManufacturingFacilities,
  addManufacturingFacility,
  updateManufacturingFacility,
  removeManufacturingFacility,
  getManufacturingFacility,
  getCharacterDivisionSettings,
  updateCharacterEnabledDivisions,
  // Blueprint sources - separate axis from the asset sources above.
  ensureCharacterSettingsRow,
  getBlueprintSources,
  getCharacterBlueprintSettings,
  setUseBlueprintsFrom,
  setBlueprintEnabledDivisions,
  // Unguarded variants: skip the "character exists" check. For bootstrap paths
  // that legitimately write before or outside the normal lifecycle - prefer the
  // guarded names above.
  updateCharacterEnabledDivisions_Unsafe,
  setUseBlueprintsFrom_Unsafe,
  setBlueprintEnabledDivisions_Unsafe,
  characterExists,
  updateCharacterDivisionNames,
  getDivisionNamesCacheStatus,
  migrateGlobalDivisionsToCharacters,
  migrateAutoUpdateCharacterDataSetting,
  getDefaultManufacturingCharacters,
  setDefaultManufacturingCharacters,
};
