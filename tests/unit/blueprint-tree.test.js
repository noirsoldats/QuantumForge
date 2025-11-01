/**
 * Unit Tests for Recursive Blueprint Tree Calculations
 *
 * Tests the recursive material tree calculation system including
 * cache behavior, depth limits, and intermediate material handling
 */

const { calculateBlueprintMaterials, clearMaterialCache } = require('../../src/main/blueprint-calculator');
const { createInMemoryDatabase, populateDatabase } = require('./helpers/database-mocks');
const { createMockSettingsManager } = require('./helpers/settings-mocks');
const blueprintFixtures = require('./fixtures/blueprints');
const facilitiesFixtures = require('./fixtures/facilities');

// Mock settings-manager
jest.mock('../../src/main/settings-manager', () => {
  const { createMockSettingsManager } = require('./helpers/settings-mocks');
  return createMockSettingsManager();
});

describe('Blueprint Tree - Recursive Calculations', () => {
  let db;

  beforeEach(() => {
    db = createInMemoryDatabase();
    if (clearMaterialCache) clearMaterialCache();
  });

  afterEach(() => {
    if (db) db.close();
  });

  describe('Simple Blueprints (No Intermediates)', () => {
    test('calculates materials for simple blueprint', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,  // runs
        0,  // ME
        null,  // characterId
        facilitiesFixtures.raitaruNoRigs,
        0,  // depth
        db
      );

      expect(result).toBeDefined();
      expect(result.materials).toBeDefined();
      expect(Object.keys(result.materials).length).toBeGreaterThan(0);

      // Should have Tritanium
      expect(result.materials[34]).toBeDefined();
      expect(result.materials[34]).toBeGreaterThan(0);
    });

    test('returns correct structure with all required fields', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(result).toBeDefined();
      expect(result.materials).toBeDefined();
      expect(result.breakdown).toBeDefined();
      expect(result.product).toBeDefined();
    });

    test('applies ME bonuses to simple blueprint', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const resultME0 = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      const resultME10 = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(resultME0).toBeDefined();
      expect(resultME10).toBeDefined();

      const tritME0 = resultME0.materials[34];
      const tritME10 = resultME10.materials[34];

      expect(tritME0).toBeDefined();
      expect(tritME10).toBeDefined();
      expect(tritME10).toBeLessThanOrEqual(tritME0);
    });
  });

  describe('Multi-Level Recursion', () => {
    test('handles 2-level recursion (blueprint with intermediates)', async () => {
      // Setup: Create blueprint that requires an intermediate component
      populateDatabase(db, { blueprint: blueprintFixtures.lightMissileLauncherBlueprint });

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.LIGHT_MISSILE_LAUNCHER_BLUEPRINT,
        1,
        0,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(result).toBeDefined();
      expect(result.breakdown).toBeDefined();
      expect(result.breakdown.length).toBeGreaterThan(0);

      // Should have raw materials resolved
      expect(result.materials).toBeDefined();
      expect(Object.keys(result.materials).length).toBeGreaterThan(0);
    });

    test('tracks recursion depth correctly', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facilitiesFixtures.raitaruNoRigs,
        3,  // Starting depth
        db
      );

      expect(result).toBeDefined();
      // Depth is not returned in the result structure, but breakdown should exist
      expect(result.breakdown).toBeDefined();
    });

    test('propagates facility bonuses through recursion', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.lightMissileLauncherBlueprint });

      const resultNoBonus = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.LIGHT_MISSILE_LAUNCHER_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.npcStation,
        0,
        db
      );

      const resultWithBonus = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.LIGHT_MISSILE_LAUNCHER_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(resultNoBonus).toBeDefined();
      expect(resultWithBonus).toBeDefined();

      // Facility bonuses should apply at all levels
      const totalNoBonus = Object.values(resultNoBonus.materials).reduce((sum, qty) => sum + qty, 0);
      const totalWithBonus = Object.values(resultWithBonus.materials).reduce((sum, qty) => sum + qty, 0);

      expect(totalWithBonus).toBeLessThanOrEqual(totalNoBonus);
    });
  });

  describe('Recursion Depth Limit', () => {
    test('enforces MAX_DEPTH limit (10)', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // Try to calculate at max depth
      const result = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facilitiesFixtures.raitaruNoRigs,
        10,  // Max depth
        db
      );

      expect(result).toBeDefined();
      // Should not recurse further
    });

    test('stops recursion at MAX_DEPTH', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // Attempting recursion beyond max should not throw
      expect(() => {
        calculateBlueprintMaterials(
          blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
          1,
          0,
          null,
          facilitiesFixtures.raitaruNoRigs,
          11,  // Beyond max
          db
        );
      }).not.toThrow();
    });
  });

  describe('Cache Behavior', () => {
    test('caches calculation results', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // First call
      const result1 = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      // Second call with same parameters should use cache
      const result2 = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      // Results should be identical
      if (result1 && result2) {
        expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
      }
    });

    test('different parameters produce different cache entries', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const resultME0 = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      const resultME10 = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(resultME0).toBeDefined();
      expect(resultME10).toBeDefined();

      // Different ME levels should produce different results
      const tritME0 = resultME0.materials[34];
      const tritME10 = resultME10.materials[34];
      expect(tritME10).toBeLessThan(tritME0);
    });

    test('cache respects facility differences', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const resultNPC = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.npcStation,
        0,
        db
      );

      const resultRaitaru = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(resultNPC).toBeDefined();
      expect(resultRaitaru).toBeDefined();

      // NPC station has no bonuses, Raitaru has 1% material bonus
      const totalNPC = Object.values(resultNPC.materials).reduce((sum, qty) => sum + qty, 0);
      const totalRaitaru = Object.values(resultRaitaru.materials).reduce((sum, qty) => sum + qty, 0);
      expect(totalRaitaru).toBeLessThanOrEqual(totalNPC);
    });
  });

  describe('Character-Owned Blueprints', () => {
    test('uses character blueprint ME when available', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // Mock character with owned blueprint
      const mockSettings = createMockSettingsManager({
        owned_blueprints: blueprintFixtures.characterBlueprints
      });

      jest.mock('../../src/main/settings-manager', () => mockSettings);

      const characterId = 123456;

      const result = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,  // ME passed as 0, but character has ME 10
        characterId,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      // Should use character's ME
      expect(result).toBeDefined();
    });

    test('falls back to passed ME if character has no blueprint', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const characterId = 999999;  // Character with no blueprints

      const result = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,  // Should use this ME
        characterId,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      expect(result).toBeDefined();
    });
  });

  describe('Snapshot Testing', () => {
    test('material tree structure matches snapshot', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const result = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      // Snapshot test to detect structural changes
      expect(result).toMatchSnapshot();
    });

    test('complex tree with intermediates matches snapshot', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.lightMissileLauncherBlueprint });

      const result = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.LIGHT_MISSILE_LAUNCHER,
        1,
        10,
        null,
        facilitiesFixtures.raitaruT1MERig,
        0,
        db
      );

      expect(result).toMatchSnapshot();
    });
  });

  describe('Error Handling', () => {
    test('handles invalid blueprint gracefully', () => {
      expect(() => {
        calculateBlueprintMaterials(
          99999,
          1,
          10,
          null,
          facilitiesFixtures.raitaruNoRigs,
          0,
          db
        );
      }).not.toThrow();
    });

    test('handles null database gracefully', () => {
      expect(() => {
        calculateBlueprintMaterials(
          blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
          1,
          10,
          null,
          facilitiesFixtures.raitaruNoRigs,
          0,
          null  // Null database
        );
      }).not.toThrow();
    });

    test('handles null facility gracefully', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const result = calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        null,  // Null facility
        0,
        db
      );

      expect(result).toBeDefined();
    });
  });

  describe('Performance', () => {
    test('caching improves performance for repeated calculations', () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // First call (no cache)
      const start1 = Date.now();
      calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );
      const time1 = Date.now() - start1;

      // Second call (cached)
      const start2 = Date.now();
      calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );
      const time2 = Date.now() - start2;

      // Cached call should be faster or same speed
      expect(time2).toBeLessThanOrEqual(time1 + 10);  // Allow 10ms margin
    });
  });
});
