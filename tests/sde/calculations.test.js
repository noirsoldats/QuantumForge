/**
 * SDE Integration and Calculation Tests
 *
 * These tests verify that actual application functions work correctly
 * with the SDE database. This tests the integration between SDE and app logic.
 */

const {
  getBlueprintMaterials,
  getBlueprintProduct,
  getTypeName,
  getBlueprintForProduct,
  getProductGroupId,
  getAllBlueprints
} = require('../../src/main/blueprint-calculator');

const {
  getItemVolume,
  getItemVolumes,
  getSkillName,
  searchBlueprints,
  getSystemSecurityStatus
} = require('../../src/main/sde-database');

const { materials, ammunition, ships, blueprints, locations } = require('./fixtures/known-items');

describe('SDE Integration Tests', () => {
  describe('Type Name Lookups', () => {
    test('getTypeName should return correct name for Tritanium', () => {
      const name = getTypeName(materials.tritanium.typeID);
      expect(name).toBe(materials.tritanium.typeName);
    });

    test('getTypeName should return fallback for invalid ID', () => {
      const name = getTypeName(999999999);
      expect(name).toMatch(/Type 999999999/);
    });

    test('getSkillName should return skill names', async () => {
      // Industry skill ID
      const name = await getSkillName(3380);
      expect(name).toBeTruthy();
      expect(typeof name).toBe('string');
    });
  });

  describe('Blueprint Product Queries', () => {
    test('getBlueprintProduct should return product for Scourge Missile Blueprint', () => {
      const product = getBlueprintProduct(blueprints.scourgeHeavyMissileBlueprint.blueprintTypeID);

      expect(product).toBeDefined();
      expect(product.typeID).toBe(ammunition.scourgeHeavyMissile.typeID);
      expect(product.quantity).toBeGreaterThan(0);
    });

    test('getBlueprintProduct should return null for invalid blueprint', () => {
      const product = getBlueprintProduct(999999999);
      expect(product).toBeNull();
    });
  });

  describe('Blueprint Materials Queries', () => {
    test('getBlueprintMaterials should return materials for a blueprint', () => {
      const materials = getBlueprintMaterials(blueprints.scourgeHeavyMissileBlueprint.blueprintTypeID);

      expect(materials).toBeDefined();
      expect(Array.isArray(materials)).toBe(true);
      expect(materials.length).toBeGreaterThan(0);

      materials.forEach(material => {
        expect(material.typeID).toBeGreaterThan(0);
        expect(material.quantity).toBeGreaterThan(0);
      });
    });

    test('getBlueprintMaterials should return empty array for invalid blueprint', () => {
      const materials = getBlueprintMaterials(999999999);
      expect(materials).toEqual([]);
    });
  });

  describe('Reverse Blueprint Lookup', () => {
    test('getBlueprintForProduct should find blueprint for a product', () => {
      const blueprintTypeID = getBlueprintForProduct(ammunition.scourgeHeavyMissile.typeID);

      expect(blueprintTypeID).toBeDefined();
      expect(blueprintTypeID).toBeGreaterThan(0);
    });

    test('getBlueprintForProduct should return null for non-manufactured item', () => {
      // Tritanium is not manufactured
      const blueprintTypeID = getBlueprintForProduct(materials.tritanium.typeID);
      expect(blueprintTypeID).toBeNull();
    });
  });

  describe('Product Group ID', () => {
    test('getProductGroupId should return groupID for a product', () => {
      const groupID = getProductGroupId(ammunition.scourgeHeavyMissile.typeID);

      expect(groupID).toBeDefined();
      expect(groupID).toBeGreaterThan(0);
    });

    test('getProductGroupId should return null for invalid typeID', () => {
      const groupID = getProductGroupId(999999999);
      expect(groupID).toBeNull();
    });
  });

  describe('Blueprint Listing', () => {
    test('getAllBlueprints should return array of blueprints', () => {
      const blueprints = getAllBlueprints(10);

      expect(blueprints).toBeDefined();
      expect(Array.isArray(blueprints)).toBe(true);
      expect(blueprints.length).toBeGreaterThan(0);
      expect(blueprints.length).toBeLessThanOrEqual(10);

      blueprints.forEach(bp => {
        expect(bp.typeID).toBeGreaterThan(0);
        expect(bp.typeName).toBeTruthy();
        expect(bp.productTypeID).toBeGreaterThan(0);
        expect(bp.productName).toBeTruthy();
        expect(bp.productCategoryName).toBeTruthy();
        expect(bp.productMetaGroupID).toBeGreaterThanOrEqual(1);
      });
    });

    test('getAllBlueprints should include meta group info', () => {
      const blueprints = getAllBlueprints(100);

      // Should have at least some T1 blueprints
      const t1Blueprints = blueprints.filter(bp => bp.productMetaGroupID === 1);
      expect(t1Blueprints.length).toBeGreaterThan(0);

      // Might have T2 blueprints
      const t2Blueprints = blueprints.filter(bp => bp.productMetaGroupID === 2);
      // Don't assert on T2 count as it depends on dataset
    });
  });

  describe('Blueprint Search', () => {
    test('searchBlueprints should find blueprints by name', async () => {
      const results = await searchBlueprints('Scourge');

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      results.forEach(bp => {
        expect(bp.typeName.toLowerCase()).toContain('scourge');
      });
    });

    test('searchBlueprints should limit results to 100', async () => {
      const results = await searchBlueprints('Missile');

      expect(results).toBeDefined();
      // searchBlueprints has a hardcoded LIMIT 100 in sde-database.js
      expect(results.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Volume Calculations', () => {
    test('getItemVolume should return volume for Tritanium', async () => {
      const volume = await getItemVolume(materials.tritanium.typeID);

      expect(volume).toBeDefined();
      expect(volume).toBeGreaterThan(0);
    });

    test('getItemVolume should return volume for ships (packaged)', async () => {
      const volume = await getItemVolume(ships.raven.typeID);

      expect(volume).toBeDefined();
      expect(volume).toBeGreaterThan(0);
    });

    test('getItemVolumes should return volumes for multiple items', async () => {
      const typeIDs = [
        materials.tritanium.typeID,
        materials.isogen.typeID,
        materials.mexallon.typeID
      ];

      const volumes = await getItemVolumes(typeIDs);

      expect(volumes).toBeDefined();
      expect(Object.keys(volumes).length).toBe(3);

      typeIDs.forEach(typeID => {
        expect(volumes[typeID]).toBeGreaterThan(0);
      });
    });

    test('getItemVolumes should not include invalid items in result', async () => {
      const volumes = await getItemVolumes([999999999]);

      expect(volumes).toBeDefined();
      // Invalid items are not included in the result map (undefined, not 0)
      expect(volumes[999999999]).toBeUndefined();
    });
  });

  describe('System Security Status', () => {
    test('getSystemSecurityStatus should return security for Jita', async () => {
      const security = await getSystemSecurityStatus(locations.jita.systemID);

      expect(security).toBeDefined();
      expect(typeof security).toBe('number');
      expect(security).toBeGreaterThanOrEqual(0);
      expect(security).toBeLessThanOrEqual(1);
    });

    test('getSystemSecurityStatus should return default for invalid system', async () => {
      const security = await getSystemSecurityStatus(999999999);

      // Function returns 0.5 (high-sec default) for invalid/not found systems
      expect(security).toBe(0.5);
    });
  });

  describe('Meta Group Detection (Regression Tests)', () => {
    test('getAllBlueprints should correctly identify T2 items without "II" in name', () => {
      const blueprints = getAllBlueprints(1000);

      // Find Scourge Fury Heavy Missile Blueprint
      const furyBlueprint = blueprints.find(bp =>
        bp.productTypeID === ammunition.scourgeFuryHeavyMissile.typeID
      );

      if (furyBlueprint) {
        expect(furyBlueprint.productMetaGroupID).toBe(2); // Should be T2
      }
    });

    test('getAllBlueprints should correctly identify T1 items', () => {
      const blueprints = getAllBlueprints(1000);

      // Find Scourge Heavy Missile Blueprint (T1)
      const t1Blueprint = blueprints.find(bp =>
        bp.productTypeID === ammunition.scourgeHeavyMissile.typeID
      );

      if (t1Blueprint) {
        expect(t1Blueprint.productMetaGroupID).toBe(1); // Should be T1
      }
    });
  });

  describe('Category Classification (Regression Tests)', () => {
    test('Ship blueprints should have correct category', () => {
      const blueprints = getAllBlueprints(1000);

      const shipBlueprints = blueprints.filter(bp => bp.productCategoryName === 'Ship');
      expect(shipBlueprints.length).toBeGreaterThan(0);

      // Verify a known ship is in Ship category
      const ravenBp = blueprints.find(bp => bp.productTypeID === ships.raven.typeID);
      if (ravenBp) {
        expect(ravenBp.productCategoryName).toBe('Ship');
      }
    });

    test('Ammunition blueprints should have correct category', () => {
      const blueprints = getAllBlueprints(1000);

      const ammoBp = blueprints.find(bp => bp.productTypeID === ammunition.scourgeHeavyMissile.typeID);
      if (ammoBp) {
        expect(ammoBp.productCategoryName).toBe('Charge');
      }
    });
  });
});
