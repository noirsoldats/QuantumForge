const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {isTokenExpired, refreshAccessToken} = require("./esi-auth");

// Get the user data directory
const userDataPath = app.getPath('userData');
const settingsFilePath = path.join(userDataPath, 'quantum_config.json');

// Default settings
const defaultSettings = {
  general: {
    launchOnStartup: false,
    minimizeToTray: false,
    theme: 'dark',
    desktopNotifications: true,
    updatesNotification: true,
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
  },
  owned_blueprints: [],
  sde: {
    validationStatus: null, // { passed: true/false, date: ISO date string, summary: string, totalChecks: number }
    lastUpdateCheck: null, // ISO date string
    updateAvailable: false,
    latestAvailableVersion: null,
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
    const settings = loadSettings();

    // Check if character already exists
    const existingIndex = settings.accounts.characters.findIndex(
      (char) => char.characterId === characterData.character.characterId
    );

    const characterEntry = {
      characterId: characterData.character.characterId,
      characterName: characterData.character.characterName,
      corporationId: characterData.character.corporationId,
      allianceId: characterData.character.allianceId,
      scopes: characterData.character.scopes,
      portrait: characterData.character.portrait,
      accessToken: characterData.access_token,
      refreshToken: characterData.refresh_token,
      expiresAt: characterData.expires_at,
      tokenType: characterData.token_type,
      addedAt: Date.now(),
      skills: null,
      skillOverrides: {},
    };

    if (existingIndex >= 0) {
      // Update existing character
      settings.accounts.characters[existingIndex] = characterEntry;
      console.log('Updated existing character:', characterData.character.characterName);
    } else {
      // Add new character
      settings.accounts.characters.push(characterEntry);
      console.log('Added new character:', characterData.character.characterName);
    }

    return saveSettings(settings);
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
    const settings = loadSettings();

    settings.accounts.characters = settings.accounts.characters.filter(
      (char) => char.characterId !== characterId
    );

    // Remove all blueprints for this character
    if (settings.owned_blueprints) {
      const blueprintsBefore = settings.owned_blueprints.length;
      settings.owned_blueprints = settings.owned_blueprints.filter(
        (bp) => bp.characterId !== characterId
      );
      const blueprintsRemoved = blueprintsBefore - settings.owned_blueprints.length;
      console.log(`Removed ${blueprintsRemoved} blueprints for character ${characterId}`);
    }

    console.log('Removed character:', characterId);
    return saveSettings(settings);
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
    const settings = loadSettings();

    const character = settings.accounts.characters.find(
      (char) => char.characterId === characterId
    );

    if (character) {
      character.accessToken = tokenData.access_token;
      character.refreshToken = tokenData.refresh_token;
      character.expiresAt = tokenData.expires_at;
      character.tokenType = tokenData.token_type;

      console.log('Updated tokens for character:', characterId);
      return saveSettings(settings);
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
  const settings = loadSettings();
  return settings.accounts.characters || [];
}

/**
 * Get a specific character
 * @param {number} characterId - Character ID
 * @returns {Object|null} Character data or null
 */
function getCharacter(characterId) {
  const settings = loadSettings();
  return settings.accounts.characters.find((char) => char.characterId === characterId) || null;
}

/**
 * Update character skills
 * @param {number} characterId - Character ID
 * @param {Object} skillsData - Skills data from ESI
 * @returns {boolean} Success status
 */
function updateCharacterSkills(characterId, skillsData) {
  try {
    const settings = loadSettings();
    const character = settings.accounts.characters.find(
      (char) => char.characterId === characterId
    );

    if (character) {
      character.skills = skillsData;
      console.log('Updated skills for character:', characterId);
      return saveSettings(settings);
    }

    console.error('Character not found:', characterId);
    return false;
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
    const character = getCharacter(characterId);

    if (!character || !character.skills || !character.skills.cacheExpiresAt) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = character.skills.cacheExpiresAt;
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
    const settings = loadSettings();

    // Find any blueprint for this character to get cache info
    const characterBlueprint = settings.owned_blueprints.find(
      bp => bp.characterId === characterId && bp.source === 'esi' && bp.cacheExpiresAt
    );

    if (!characterBlueprint || !characterBlueprint.cacheExpiresAt) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = characterBlueprint.cacheExpiresAt;
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
    const settings = loadSettings();
    const character = settings.accounts.characters.find(
      (char) => char.characterId === characterId
    );

    if (character) {
      if (!character.skillOverrides) {
        character.skillOverrides = {};
      }

      if (level === null || level === undefined) {
        // Remove override
        delete character.skillOverrides[skillId];
      } else {
        // Set override
        character.skillOverrides[skillId] = level;
      }

      console.log(`Set skill override for character ${characterId}, skill ${skillId}: ${level}`);
      return saveSettings(settings);
    }

    console.error('Character not found:', characterId);
    return false;
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
    const character = getCharacter(characterId);

    if (!character) {
      return null;
    }

    // Check for override first
    if (character.skillOverrides && character.skillOverrides[skillId] !== undefined) {
      return character.skillOverrides[skillId];
    }

    // Return actual skill level
    if (character.skills && character.skills.skills && character.skills.skills[skillId]) {
      return character.skills.skills[skillId].trainedSkillLevel;
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
    const settings = loadSettings();
    const character = settings.accounts.characters.find(
      (char) => char.characterId === characterId
    );

    if (character) {
      character.skillOverrides = {};
      console.log('Cleared skill overrides for character:', characterId);
      return saveSettings(settings);
    }

    console.error('Character not found:', characterId);
    return false;
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
    const settings = loadSettings();

    // Verify character exists
    const character = settings.accounts.characters.find(
      (char) => char.characterId === characterId
    );

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

    return settings.accounts.characters.find(
      (char) => char.characterId === settings.accounts.defaultCharacterId
    ) || null;
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
    const settings = loadSettings();

    if (!settings.owned_blueprints) {
      settings.owned_blueprints = [];
    }

    // Remove existing ESI blueprints for this character
    settings.owned_blueprints = settings.owned_blueprints.filter(
      bp => !(bp.characterId === characterId && bp.source === 'esi')
    );

    // Add new blueprints with metadata
    blueprintsData.blueprints.forEach(bp => {
      settings.owned_blueprints.push({
        ...bp,
        overrides: {}, // For ME/TE overrides
        manuallyAdded: false,
        lastUpdated: blueprintsData.lastUpdated,
        cacheExpiresAt: blueprintsData.cacheExpiresAt,
      });
    });

    console.log(`Updated ${blueprintsData.blueprints.length} blueprints for character:`, characterId);
    return saveSettings(settings);
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
    const settings = loadSettings();

    if (!settings.owned_blueprints) {
      settings.owned_blueprints = [];
    }

    const newBlueprint = {
      itemId: `manual-${Date.now()}`,
      typeId: blueprint.typeId,
      locationId: blueprint.locationId || 0,
      locationFlag: blueprint.locationFlag || 'Hangar',
      quantity: blueprint.isCopy ? -2 : -1,
      timeEfficiency: blueprint.timeEfficiency || 0,
      materialEfficiency: blueprint.materialEfficiency || 0,
      runs: blueprint.runs || (blueprint.isCopy ? 1 : -1),
      isCopy: blueprint.isCopy || false,
      source: 'manual',
      characterId: blueprint.characterId,
      manuallyAdded: true,
      overrides: {},
      fetchedAt: Date.now(),
      lastUpdated: Date.now(),
    };

    settings.owned_blueprints.push(newBlueprint);
    console.log('Added manual blueprint:', newBlueprint.typeId);
    return saveSettings(settings);
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
    const settings = loadSettings();

    if (!settings.owned_blueprints) {
      return true;
    }

    settings.owned_blueprints = settings.owned_blueprints.filter(
      bp => bp.itemId !== itemId
    );

    console.log('Removed blueprint:', itemId);
    return saveSettings(settings);
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
    const settings = loadSettings();

    if (!settings.owned_blueprints) {
      return false;
    }

    const blueprint = settings.owned_blueprints.find(bp => bp.itemId === itemId);

    if (!blueprint) {
      console.error('Blueprint not found:', itemId);
      return false;
    }

    if (!blueprint.overrides) {
      blueprint.overrides = {};
    }

    if (value === null || value === undefined) {
      // Remove override
      delete blueprint.overrides[field];
    } else {
      // Set override
      blueprint.overrides[field] = value;
    }

    console.log(`Set blueprint override for ${itemId}, ${field}: ${value}`);
    return saveSettings(settings);
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
    const settings = loadSettings();

    if (!settings.owned_blueprints) {
      return [];
    }

    if (characterId) {
      return settings.owned_blueprints.filter(bp => bp.characterId === characterId);
    }

    return settings.owned_blueprints;
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
    const settings = loadSettings();

    if (!settings.owned_blueprints) {
      return null;
    }

    const blueprint = settings.owned_blueprints.find(bp => bp.itemId === itemId);

    if (!blueprint) {
      return null;
    }

    return {
      materialEfficiency: blueprint.overrides?.materialEfficiency ?? blueprint.materialEfficiency,
      timeEfficiency: blueprint.overrides?.timeEfficiency ?? blueprint.timeEfficiency,
      hasMEOverride: blueprint.overrides?.materialEfficiency !== undefined,
      hasTEOverride: blueprint.overrides?.timeEfficiency !== undefined,
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
};
