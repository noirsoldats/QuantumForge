/**
 * Settings Manager Mock Utilities for Testing
 *
 * Provides mock implementations of settings-manager functions
 * for testing without requiring actual file system access
 */

const facilitiesFixtures = require('../fixtures/facilities');
const blueprintFixtures = require('../fixtures/blueprints');
const skillsFixtures = require('../fixtures/skills');

/**
 * Create a mock settings manager with default data
 * @param {Object} overrides - Override default settings
 * @returns {Object} Mock settings manager
 */
function createMockSettingsManager(overrides = {}) {
  const defaultSettings = {
    general: {
      theme: 'dark',
      desktopNotifications: true,
      updatesNotification: true,
      autoUpdateCharacterData: true
    },
    accounts: {
      characters: overrides.characters || [],
      defaultCharacterId: overrides.defaultCharacterId || null
    },
    market: {
      locationType: 'hub',
      locationId: 60003760,
      regionId: 10000002,
      systemId: 30000142,
      inputMaterials: {
        priceType: 'sell',
        priceMethod: 'hybrid',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      },
      outputProducts: {
        priceType: 'sell',
        priceMethod: 'hybrid',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      }
    },
    owned_blueprints: overrides.owned_blueprints || [],
    manufacturing_facilities: overrides.manufacturing_facilities || [facilitiesFixtures.raitaruNoRigs]
  };

  const settings = { ...defaultSettings, ...overrides };

  return {
    loadSettings: jest.fn(() => settings),
    saveSettings: jest.fn(() => true),
    updateSettings: jest.fn((category, updates) => {
      settings[category] = { ...settings[category], ...updates };
      return true;
    }),
    getSetting: jest.fn((category, key) => settings[category]?.[key]),

    // Character management
    getCharacters: jest.fn(() => settings.accounts.characters),
    getCharacter: jest.fn((characterId) =>
      settings.accounts.characters.find(c => c.characterId === characterId) || null
    ),
    getDefaultCharacter: jest.fn(() => {
      if (!settings.accounts.defaultCharacterId) return null;
      return settings.accounts.characters.find(
        c => c.characterId === settings.accounts.defaultCharacterId
      ) || null;
    }),

    // Skills
    getEffectiveSkillLevel: jest.fn((characterId, skillId) => {
      const character = settings.accounts.characters.find(c => c.characterId === characterId);
      if (!character) return 0;

      // Check overrides first
      if (character.skillOverrides && character.skillOverrides[skillId] !== undefined) {
        return character.skillOverrides[skillId];
      }

      // Return actual skill level
      if (character.skills && character.skills[skillId]) {
        return character.skills[skillId].trainedSkillLevel;
      }

      return 0;
    }),

    // Blueprints
    getBlueprints: jest.fn((characterId = null) => {
      if (characterId) {
        return settings.owned_blueprints.filter(bp => bp.characterId === characterId);
      }
      return settings.owned_blueprints;
    }),
    getEffectiveBlueprintValues: jest.fn((itemId) => {
      const blueprint = settings.owned_blueprints.find(bp => bp.itemId === itemId);
      if (!blueprint) return null;

      return {
        materialEfficiency: blueprint.overrides?.materialEfficiency ?? blueprint.materialEfficiency,
        timeEfficiency: blueprint.overrides?.timeEfficiency ?? blueprint.timeEfficiency,
        hasMEOverride: blueprint.overrides?.materialEfficiency !== undefined,
        hasTEOverride: blueprint.overrides?.timeEfficiency !== undefined
      };
    }),

    // Facilities
    getManufacturingFacilities: jest.fn(() => settings.manufacturing_facilities),
    getManufacturingFacility: jest.fn((id) =>
      settings.manufacturing_facilities.find(f => f.id === id) || null
    ),

    // Market settings
    getMarketSettings: jest.fn(() => settings.market)
  };
}

/**
 * Create mock with specific character data
 * @param {Object} characterData - Character fixture data
 * @returns {Object} Mock settings manager
 */
function createMockWithCharacter(characterData) {
  return createMockSettingsManager({
    characters: [characterData],
    defaultCharacterId: characterData.characterId
  });
}

/**
 * Create mock with specific blueprints
 * @param {Array} blueprints - Blueprint fixture data
 * @returns {Object} Mock settings manager
 */
function createMockWithBlueprints(blueprints) {
  return createMockSettingsManager({
    owned_blueprints: blueprints
  });
}

/**
 * Create mock with specific facility
 * @param {Object} facility - Facility fixture data
 * @returns {Object} Mock settings manager
 */
function createMockWithFacility(facility) {
  return createMockSettingsManager({
    manufacturing_facilities: [facility]
  });
}

/**
 * Create mock with full test data (character, blueprints, facility)
 * @returns {Object} Mock settings manager
 */
function createFullTestMock() {
  return createMockSettingsManager({
    characters: [skillsFixtures.basicManufacturingSkills],
    defaultCharacterId: skillsFixtures.basicManufacturingSkills.characterId,
    owned_blueprints: blueprintFixtures.characterBlueprints,
    manufacturing_facilities: [
      facilitiesFixtures.raitaruNoRigs,
      facilitiesFixtures.raitaruT1MERig
    ]
  });
}

/**
 * Mock the settings-manager module
 * @param {Object} mockImplementation - Mock settings manager instance
 */
function mockSettingsManagerModule(mockImplementation) {
  jest.mock('../../../src/main/settings-manager', () => mockImplementation);
}

/**
 * Reset settings manager mock
 */
function resetSettingsManagerMock() {
  jest.unmock('../../../src/main/settings-manager');
}

module.exports = {
  createMockSettingsManager,
  createMockWithCharacter,
  createMockWithBlueprints,
  createMockWithFacility,
  createFullTestMock,
  mockSettingsManagerModule,
  resetSettingsManagerMock
};
