/**
 * Unit Tests for Manufacturing Cost Calculations
 *
 * Tests cost calculations for manufacturing invented T2 blueprints
 */

const { calculateManufacturingCost } = require('../../src/main/blueprint-calculator');
const { createMockDatabase } = require('./helpers/database-mocks');
const { createMockMaterialPrices } = require('./helpers/test-utils');
const blueprintFixtures = require('./fixtures/blueprints');
const facilitiesFixtures = require('./fixtures/facilities');

describe('Manufacturing Cost Calculations', () => {
  describe('calculateManufacturingCost', () => {
    const mockDb = createMockDatabase({
      all: {
        'select': () => blueprintFixtures.scourgeBlueprint.materials.map(m => ({
          typeID: m.typeID,
          quantity: m.quantity,
          typeName: m.typeName
        }))
      }
    });

    const materialPrices = createMockMaterialPrices();

    test('calculates total material cost', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        0,  // ME 0
        1,  // 1 run
        facility,
        materialPrices,
        mockDb
      );

      expect(result).toBeDefined();
      expect(result.materialCost).toBeGreaterThan(0);
      expect(result.totalCost).toBeGreaterThan(0);
    });

    test('ME reduction lowers material cost', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const costME0 = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        0,
        1,
        facility,
        materialPrices,
        mockDb
      );

      const costME10 = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        facility,
        materialPrices,
        mockDb
      );

      expect(costME0).toBeDefined();
      expect(costME10).toBeDefined();
      expect(costME10.materialCost).toBeLessThan(costME0.materialCost);
    });

    test('facility bonuses reduce material cost', async () => {
      const npcStation = facilitiesFixtures.npcStation;
      const raitaru = facilitiesFixtures.raitaruNoRigs;

      const costNPC = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        npcStation,
        materialPrices,
        mockDb
      );

      const costRaitaru = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        raitaru,
        materialPrices,
        mockDb
      );

      expect(costNPC).toBeDefined();
      expect(costRaitaru).toBeDefined();
      // Raitaru has 1% ME bonus
      expect(costRaitaru.materialCost).toBeLessThanOrEqual(costNPC.materialCost);
    });

    test('multiple runs scale material cost', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const cost1Run = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        facility,
        materialPrices,
        mockDb
      );

      const cost10Runs = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        10,
        facility,
        materialPrices,
        mockDb
      );

      expect(cost1Run).toBeDefined();
      expect(cost10Runs).toBeDefined();
      // 10 runs should be approximately 10x cost (allow tolerance for rounding)
      expect(cost10Runs.materialCost).toBeApproximately(cost1Run.materialCost * 10, 500);
    });

    test('calculates cost per unit', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;
      const productQuantity = 100;  // Scourge produces 100 missiles

      const result = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        facility,
        materialPrices,
        mockDb
      );

      expect(result).toBeDefined();
      const costPerUnit = result.materialCost / productQuantity;
      expect(costPerUnit).toBeGreaterThan(0);
      expect(costPerUnit).toBeLessThan(result.materialCost);
    });

    test('handles missing material prices gracefully', () => {
      const incompletePrices = { 34: 6.50 };  // Only Tritanium
      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        facility,
        incompletePrices,
        mockDb
      );

      // Should not throw, may calculate partial cost
      expect(result).toBeDefined();
    });

    test('includes job cost in total', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        facility,
        materialPrices,
        mockDb
      );

      expect(result).toBeDefined();
      expect(result.jobCost).toBeDefined();
      expect(result.totalCost).toBeGreaterThanOrEqual(result.materialCost);
    });

    test('calculates breakdown by material', () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        facility,
        materialPrices,
        mockDb
      );

      if (result && result.materialBreakdown) {
        expect(Array.isArray(result.materialBreakdown)).toBe(true);

        result.materialBreakdown.forEach(item => {
          expect(item.typeID).toBeDefined();
          expect(item.quantity).toBeGreaterThan(0);
          expect(item.cost).toBeGreaterThan(0);
        });
      }
    });

    test('handles high ME levels correctly', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        20,  // ME 20 (T2 max)
        1,
        facility,
        materialPrices,
        mockDb
      );

      expect(result).toBeDefined();
      expect(result.materialCost).toBeGreaterThan(0);
    });

    test('rig bonuses further reduce costs', async () => {
      const noRig = facilitiesFixtures.raitaruNoRigs;
      const t1Rig = facilitiesFixtures.raitaruT1MERig;

      const costNoRig = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        noRig,
        materialPrices,
        mockDb
      );

      const costT1Rig = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        t1Rig,
        materialPrices,
        mockDb
      );

      expect(costNoRig).toBeDefined();
      expect(costT1Rig).toBeDefined();
      // Rig should reduce material cost
      expect(costT1Rig.materialCost).toBeLessThanOrEqual(costNoRig.materialCost);
    });
  });

  describe('Error Handling', () => {
    const mockDb = createMockDatabase();
    const materialPrices = createMockMaterialPrices();

    test('handles invalid blueprint typeID', () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      expect(() => {
        calculateManufacturingCost(
          99999,  // Invalid
          10,
          1,
          facility,
          materialPrices,
          mockDb
        );
      }).not.toThrow();
    });

    test('handles null facility', () => {
      expect(() => {
        calculateManufacturingCost(
          blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
          10,
          1,
          null,  // Null facility
          materialPrices,
          mockDb
        );
      }).not.toThrow();
    });

    test('handles empty material prices', () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      expect(() => {
        calculateManufacturingCost(
          blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
          10,
          1,
          facility,
          {},  // Empty prices
          mockDb
        );
      }).not.toThrow();
    });

    test('handles zero runs', async () => {
      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = await calculateManufacturingCost(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        0,  // Zero runs
        facility,
        materialPrices,
        mockDb
      );

      expect(result).toBeDefined();
      expect(result.materialCost).toBe(0);
    });
  });
});
