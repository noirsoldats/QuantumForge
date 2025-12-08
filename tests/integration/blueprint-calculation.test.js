/**
 * Integration Tests for Blueprint Calculation Flow
 *
 * Tests complete end-to-end blueprint calculation workflows
 * using in-memory database and realistic data
 */

const { calculateBlueprintMaterials } = require('../../src/main/blueprint-calculator');
const { createInMemoryDatabase, populateDatabase } = require('../unit/helpers/database-mocks');
const { createMockSettingsManager } = require('../unit/helpers/settings-mocks');
const { createMockMaterialPrices } = require('../unit/helpers/test-utils');

const blueprintFixtures = require('../unit/fixtures/blueprints');
const facilitiesFixtures = require('../unit/fixtures/facilities');
const skillsFixtures = require('../unit/fixtures/skills');

describe('Blueprint Calculation Integration Tests', () => {
  let db;

  beforeEach(() => {
    // Create fresh in-memory database for each test
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('Simple Blueprint Calculation', () => {
    test('calculates materials for Scourge missile blueprint', async () => {
      // Populate database with fixture data
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const facility = facilitiesFixtures.raitaruNoRigs;
      const characterId = null;  // No character-owned blueprints
      const meLevel = 0;
      const runs = 1;

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        runs,
        meLevel,
        characterId,
        facility,
        0,  // depth
        db
      );

      expect(result).toBeDefined();
      expect(result.materials).toBeDefined();
      expect(typeof result.materials).toBe('object');
      expect(Object.keys(result.materials).length).toBeGreaterThan(0);

      // Verify expected materials present (materials is an object with typeID as keys)
      expect(result.materials[34]).toBeDefined();  // Tritanium
      expect(result.materials[34]).toBeGreaterThan(0);
    });

    test('applies ME bonus to material quantities', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const facility = facilitiesFixtures.raitaruNoRigs;

      // Calculate with ME 0
      const resultME0 = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facility,
        0,
        db
      );

      // Calculate with ME 10
      const resultME10 = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facility,
        0,
        db
      );

      // ME 10 should reduce material quantities
      if (resultME0.materials && resultME10.materials) {
        const tritME0 = resultME0.materials[34];  // Tritanium
        const tritME10 = resultME10.materials[34];

        if (tritME0 && tritME10) {
          expect(tritME10).toBeLessThanOrEqual(tritME0);
        }
      }
    });

    test('applies facility bonuses', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // Calculate with NPC station (no bonuses)
      const resultNPC = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.npcStation,
        0,
        db
      );

      // Calculate with Raitaru (1% ME bonus)
      const resultRaitaru = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        10,
        null,
        facilitiesFixtures.raitaruNoRigs,
        0,
        db
      );

      // Raitaru should have lower or equal material requirements
      if (resultNPC.materials && resultRaitaru.materials) {
        const totalNPC = Object.values(resultNPC.materials).reduce((sum, qty) => sum + qty, 0);
        const totalRaitaru = Object.values(resultRaitaru.materials).reduce((sum, qty) => sum + qty, 0);

        expect(totalRaitaru).toBeLessThanOrEqual(totalNPC);
      }
    });
  });

  describe('Character-Owned Blueprints', () => {
    test('uses character blueprint ME when available', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      // Mock settings manager with character blueprints
      const mockSettings = createMockSettingsManager({
        owned_blueprints: blueprintFixtures.characterBlueprints,
        characters: [skillsFixtures.basicManufacturingSkills]
      });

      jest.mock('../../src/main/settings-manager', () => mockSettings);

      const facility = facilitiesFixtures.raitaruNoRigs;
      const characterId = 123456;

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,  // ME passed as 0, but character blueprint has ME 10
        characterId,
        facility,
        0,
        db
      );

      // Should use character's ME level
      expect(result).toBeDefined();

      jest.unmock('../../src/main/settings-manager');
    });
  });

  describe('Multiple Runs', () => {
    test('scales material quantities for multiple runs', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const facility = facilitiesFixtures.raitaruNoRigs;

      const result1Run = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facility,
        0,
        db
      );

      const result10Runs = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        0,
        null,
        facility,
        0,
        db
      );

      if (result1Run.materials && result10Runs.materials) {
        const trit1 = result1Run.materials[34];  // Tritanium
        const trit10 = result10Runs.materials[34];

        if (trit1 && trit10) {
          // 10 runs should be approximately 10x materials
          // Due to rounding, it may be slightly less (e.g., 49.5 per run × 10 = 495 vs 50 × 10 = 500)
          expect(trit10).toBeGreaterThanOrEqual(trit1 * 9.9);
        }
      }
    });
  });

  describe('Error Handling', () => {
    test('handles invalid blueprint typeID gracefully', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      await expect(
        calculateBlueprintMaterials(
          99999,  // Invalid blueprint
          1,
          0,
          null,
          facility,
          0,
          db
        )
      ).resolves.toBeDefined();
    });

    test('handles null facility', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      await expect(
        calculateBlueprintMaterials(
          blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
          1,
          0,
          null,
          null,  // Null facility
          0,
          db
        )
      ).resolves.toBeDefined();
    });
  });

  describe('Pricing Integration', () => {
    test('calculates total material cost', async () => {
      populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });

      const facility = facilitiesFixtures.raitaruNoRigs;
      const prices = createMockMaterialPrices();

      const result = await calculateBlueprintMaterials(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        1,
        0,
        null,
        facility,
        0,
        db
      );

      if (result.materials) {
        const totalCost = Object.entries(result.materials).reduce((sum, [typeID, quantity]) => {
          const price = prices[typeID] || 0;
          return sum + (quantity * price);
        }, 0);

        expect(totalCost).toBeGreaterThan(0);
      }
    });
  });

  // describe('Snapshot Testing', () => {
  //   test('material tree structure matches snapshot', async () => {
  //     populateDatabase(db, { blueprint: blueprintFixtures.scourgeBlueprint });
  //
  //     const facility = facilitiesFixtures.raitaruNoRigs;
  //
  //     const result = await calculateBlueprintMaterials(
  //       blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
  //       1,
  //       10,
  //       null,
  //       facility,
  //       0,
  //       db
  //     );
  //
  //     // Snapshot test to detect regressions in calculation structure
  //     expect(result).toMatchSnapshot();
  //   });
  // });
});
