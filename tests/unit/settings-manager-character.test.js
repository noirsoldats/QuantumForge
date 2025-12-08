/**
 * Tests for character management in settings-manager
 */

const fs = require('fs');
const path = require('path');

// Mock electron app module
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/tmp/quantum-forge-test-' + Date.now()),
  },
}));

// Mock ESI auth module
jest.mock('../../src/main/esi-auth', () => ({
  isTokenExpired: jest.fn(() => false),
  refreshAccessToken: jest.fn(),
}));

// Mock config-migration module
jest.mock('../../src/main/config-migration', () => ({
  getConfigDir: jest.fn(),
  getConfigPath: jest.fn(),
  getMarketDbPath: jest.fn(),
}));

describe('Settings Manager - Character Management', () => {
  let settingsManager;
  let tempDir;
  let settingsFilePath;

  beforeEach(() => {
    // Create a unique temp directory for each test
    tempDir = '/tmp/quantum-forge-test-' + Date.now() + '-' + Math.random();
    const configDir = path.join(tempDir, 'config');

    // Clear module cache first
    jest.resetModules();

    // Mock electron app
    const { app } = require('electron');
    app.getPath.mockReturnValue(tempDir);

    // Mock config-migration BEFORE requiring any modules that use it
    const configMigration = require('../../src/main/config-migration');
    configMigration.getConfigDir.mockReturnValue(configDir);

    settingsFilePath = path.join(configDir, 'quantum_config.json');
    configMigration.getConfigPath.mockReturnValue(settingsFilePath);

    // Initialize character database with schema
    const { initializeCharacterDatabase } = require('../../src/main/character-database');
    initializeCharacterDatabase();

    // Now load settings manager
    settingsManager = require('../../src/main/settings-manager');

    // Ensure directories exist
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Close database connection
    const { closeCharacterDatabase } = require('../../src/main/character-database');
    closeCharacterDatabase();

    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Auto-set first character as default', () => {
    test('should automatically set first character as default', () => {
      const characterData = {
        character: {
          characterId: 123456,
          characterName: 'Test Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/123456/portrait',
        },
        access_token: 'test_access_token',
        refresh_token: 'test_refresh_token',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      // Add first character
      const success = settingsManager.addCharacter(characterData);
      expect(success).toBe(true);

      // Verify character was set as default
      const defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).not.toBeNull();
      expect(defaultCharacter.characterId).toBe(123456);
      expect(defaultCharacter.characterName).toBe('Test Character');
    });

    test('should not change default when adding second character', () => {
      const firstCharacter = {
        character: {
          characterId: 111111,
          characterName: 'First Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/111111/portrait',
        },
        access_token: 'first_token',
        refresh_token: 'first_refresh',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      const secondCharacter = {
        character: {
          characterId: 222222,
          characterName: 'Second Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/222222/portrait',
        },
        access_token: 'second_token',
        refresh_token: 'second_refresh',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      // Add first character
      settingsManager.addCharacter(firstCharacter);

      // Add second character
      settingsManager.addCharacter(secondCharacter);

      // Verify first character is still default
      const defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).not.toBeNull();
      expect(defaultCharacter.characterId).toBe(111111);
      expect(defaultCharacter.characterName).toBe('First Character');
    });

    test('should preserve default when updating existing character', () => {
      const characterData = {
        character: {
          characterId: 123456,
          characterName: 'Test Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/123456/portrait',
        },
        access_token: 'test_access_token',
        refresh_token: 'test_refresh_token',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      // Add character first time (it will be the only character, so set as default)
      settingsManager.addCharacter(characterData);

      // Verify it was set as default
      let defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).not.toBeNull();
      expect(defaultCharacter.characterId).toBe(123456);

      // Update the character with new token
      const updatedData = {
        ...characterData,
        access_token: 'new_token',
      };
      settingsManager.addCharacter(updatedData);

      // Default should still be set to the same character
      defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).not.toBeNull();
      expect(defaultCharacter.characterId).toBe(123456);
      expect(defaultCharacter.accessToken).toBe('new_token');
    });
  });

  describe('Clear default when removing default character', () => {
    test('should clear default when removing the default character', () => {
      const characterData = {
        character: {
          characterId: 123456,
          characterName: 'Test Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/123456/portrait',
        },
        access_token: 'test_access_token',
        refresh_token: 'test_refresh_token',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      // Add character (will be set as default)
      settingsManager.addCharacter(characterData);

      // Verify it's the default
      let defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).not.toBeNull();
      expect(defaultCharacter.characterId).toBe(123456);

      // Remove the character
      const success = settingsManager.removeCharacter(123456);
      expect(success).toBe(true);

      // Default should now be null
      defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).toBeNull();
    });

    test('should not clear default when removing non-default character', () => {
      const firstCharacter = {
        character: {
          characterId: 111111,
          characterName: 'First Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/111111/portrait',
        },
        access_token: 'first_token',
        refresh_token: 'first_refresh',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      const secondCharacter = {
        character: {
          characterId: 222222,
          characterName: 'Second Character',
          corporationId: 789,
          allianceId: null,
          scopes: ['esi-skills.read_skills.v1'],
          portrait: 'https://images.evetech.net/characters/222222/portrait',
        },
        access_token: 'second_token',
        refresh_token: 'second_refresh',
        expires_at: Date.now() + 1200000,
        token_type: 'Bearer',
      };

      // Add both characters (first will be default)
      settingsManager.addCharacter(firstCharacter);
      settingsManager.addCharacter(secondCharacter);

      // Verify first is default
      let defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter.characterId).toBe(111111);

      // Remove second character (non-default)
      settingsManager.removeCharacter(222222);

      // Default should still be first character
      defaultCharacter = settingsManager.getDefaultCharacter();
      expect(defaultCharacter).not.toBeNull();
      expect(defaultCharacter.characterId).toBe(111111);
    });
  });
});
