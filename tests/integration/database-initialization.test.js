/**
 * Integration tests for database initialization
 * Tests that databases can be initialized even when config directory doesn't exist
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Database Initialization', () => {
  let tempDir;
  let originalGetConfigDir;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantum-test-'));

    // Mock the config-migration module to return our temp directory
    jest.isolateModules(() => {
      const configMigration = require('../../src/main/config-migration');
      originalGetConfigDir = configMigration.getConfigDir;

      // Override getConfigDir to return our temp directory
      configMigration.getConfigDir = jest.fn(() => tempDir);
    });
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Restore original function
    if (originalGetConfigDir) {
      const configMigration = require('../../src/main/config-migration');
      configMigration.getConfigDir = originalGetConfigDir;
    }

    // Clear module cache
    jest.resetModules();
  });

  describe('Character Database', () => {
    test('creates config directory if it does not exist', () => {
      // Ensure temp directory is empty
      expect(fs.existsSync(tempDir)).toBe(true);
      expect(fs.readdirSync(tempDir).length).toBe(0);

      // Mock getConfigDir to return non-existent subdirectory
      const nonExistentDir = path.join(tempDir, 'config');
      jest.isolateModules(() => {
        const configMigration = require('../../src/main/config-migration');
        configMigration.getConfigDir = jest.fn(() => nonExistentDir);

        // Try to get character database
        const { getCharacterDatabase } = require('../../src/main/character-database');
        const db = getCharacterDatabase();

        // Verify directory was created
        expect(fs.existsSync(nonExistentDir)).toBe(true);

        // Verify database was created
        expect(db).toBeDefined();

        // Close the database
        db.close();
      });
    });

    test('uses existing config directory if it already exists', () => {
      // Verify temp directory exists
      expect(fs.existsSync(tempDir)).toBe(true);

      // Get character database
      jest.isolateModules(() => {
        const configMigration = require('../../src/main/config-migration');
        configMigration.getConfigDir = jest.fn(() => tempDir);

        const { getCharacterDatabase } = require('../../src/main/character-database');
        const db = getCharacterDatabase();

        // Verify database was created
        expect(db).toBeDefined();
        expect(fs.existsSync(path.join(tempDir, 'character-data.db'))).toBe(true);

        // Close the database
        db.close();
      });
    });
  });

  describe('Market Database', () => {
    test('creates config directory if it does not exist', () => {
      // Mock getConfigDir to return non-existent subdirectory
      const nonExistentDir = path.join(tempDir, 'config');

      jest.isolateModules(() => {
        const configMigration = require('../../src/main/config-migration');
        configMigration.getConfigDir = jest.fn(() => nonExistentDir);
        configMigration.getMarketDbPath = jest.fn(() => path.join(nonExistentDir, 'market-data.db'));

        // Try to initialize market database
        const { initializeMarketDatabase } = require('../../src/main/market-database');
        const result = initializeMarketDatabase();

        // Verify directory was created
        expect(fs.existsSync(nonExistentDir)).toBe(true);

        // Verify initialization succeeded
        expect(result).toBe(true);

        // Verify database file was created
        expect(fs.existsSync(path.join(nonExistentDir, 'market-data.db'))).toBe(true);
      });
    });

    test('uses existing config directory if it already exists', () => {
      jest.isolateModules(() => {
        const configMigration = require('../../src/main/config-migration');
        configMigration.getConfigDir = jest.fn(() => tempDir);
        configMigration.getMarketDbPath = jest.fn(() => path.join(tempDir, 'market-data.db'));

        const { initializeMarketDatabase } = require('../../src/main/market-database');
        const result = initializeMarketDatabase();

        // Verify initialization succeeded
        expect(result).toBe(true);

        // Verify database file was created
        expect(fs.existsSync(path.join(tempDir, 'market-data.db'))).toBe(true);
      });
    });
  });
});
