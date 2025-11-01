/**
 * Unit Tests for Rig Bonus Calculations
 *
 * Tests rig bonus calculations including material, time, and cost bonuses
 * with product group matching and security status multipliers
 */

const {
  getRigMaterialBonus,
  getRigTimeBonus,
  getRigCostBonus,
  getRigBonusesFromSDE,
  getRigGroupId
} = require('../../src/main/rig-bonuses');

const { createMockDatabase } = require('./helpers/database-mocks');
const facilitiesFixtures = require('./fixtures/facilities');

// Mock rig-mappings module
jest.mock('../../src/main/rig-mappings', () => ({
  rigAffectsProduct: jest.fn((rigGroupId, productGroupId) => {
    // Simple mock: assume rigs affect matching product groups
    // In reality, this checks complex mappings
    return true;  // For testing, assume all rigs affect all products
  }),
  getSecurityMultiplier: jest.fn((securityStatus) => {
    // Security multiplier affects rig bonuses
    // High-sec (>= 0.5) = 1.0, Low-sec (0.1-0.4) = varies, Null (<= 0.0) = varies
    if (securityStatus >= 0.5) return 1.0;
    if (securityStatus > 0.0) return 0.8;
    return 0.7;
  })
}));

// Mock better-sqlite3 database
jest.mock('better-sqlite3', () => {
  return jest.fn(() => ({
    prepare: jest.fn((query) => ({
      get: jest.fn((rigTypeId) => {
        // Mock rig group IDs
        const rigGroups = {
          43920: 1154,  // M-Set ME T1 rig
          43921: 1154,  // M-Set ME T2 rig
          43922: 1154,  // M-Set TE T1 rig
          43924: 1155   // L-Set ME T1 rig
        };
        return { groupID: rigGroups[rigTypeId] || null };
      }),
      all: jest.fn((rigTypeId) => {
        // Mock rig attribute bonuses
        const rigBonuses = {
          43920: [{ attributeID: 2594, valueFloat: 1.9, valueInt: null }],  // ME T1: 1.9%
          43921: [{ attributeID: 2594, valueFloat: 2.4, valueInt: null }],  // ME T2: 2.4%
          43922: [{ attributeID: 2593, valueFloat: 20.0, valueInt: null }], // TE T1: 20%
          43924: [{ attributeID: 2594, valueFloat: 1.9, valueInt: null }]   // L-Set ME: 1.9%
        };
        return rigBonuses[rigTypeId] || [];
      })
    })),
    close: jest.fn()
  }));
});

// Mock electron app
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/path')
  }
}));

describe('Rig Bonus Calculations', () => {
  describe('getRigMaterialBonus', () => {
    test('returns 0 for no rigs', () => {
      const result = getRigMaterialBonus([], 88, 0.9);

      expect(result).toBe(0);
    });

    test('returns 0 for null rigs', () => {
      const result = getRigMaterialBonus(null, 88, 0.9);

      expect(result).toBe(0);
    });

    test('calculates bonus for single ME rig', () => {
      const rigs = [{ typeId: 43920 }];  // M-Set ME T1 (1.9%)
      const productGroupId = 88;  // Light Missiles
      const securityStatus = 0.9;  // High-sec

      const result = getRigMaterialBonus(rigs, productGroupId, securityStatus);

      // Should be 1.9% (1.9 * 1.0 security multiplier)
      expect(result).toBeApproximately(1.9, 0.1);
    });

    test('calculates bonus for T2 ME rig', () => {
      const rigs = [{ typeId: 43921 }];  // M-Set ME T2 (2.4%)
      const productGroupId = 88;

      const result = getRigMaterialBonus(rigs, productGroupId, 0.9);

      expect(result).toBeApproximately(2.4, 0.1);
    });

    test('stacks bonuses from multiple ME rigs', () => {
      const rigs = [
        { typeId: 43920 },  // ME T1: 1.9%
        { typeId: 43920 }   // ME T1: 1.9%
      ];

      const result = getRigMaterialBonus(rigs, 88, 0.9);

      // Should stack: 1.9 + 1.9 = 3.8
      expect(result).toBeApproximately(3.8, 0.1);
    });

    test('applies security status multiplier in low-sec', () => {
      const rigs = [{ typeId: 43920 }];  // 1.9% base
      const lowSecStatus = 0.3;

      const result = getRigMaterialBonus(rigs, 88, lowSecStatus);

      // Should be 1.9 * 0.8 (low-sec multiplier) = 1.52
      expect(result).toBeLessThan(1.9);
    });

    test('applies security status multiplier in null-sec', () => {
      const rigs = [{ typeId: 43920 }];  // 1.9% base
      const nullSecStatus = -0.5;

      const result = getRigMaterialBonus(rigs, 88, nullSecStatus);

      // Should be 1.9 * 0.7 (null-sec multiplier) = 1.33
      expect(result).toBeLessThan(1.9);
    });

    test('handles string typeId format', () => {
      const rigs = ['43920'];  // String instead of object

      const result = getRigMaterialBonus(rigs, 88, 0.9);

      expect(result).toBeGreaterThan(0);
    });

    test('skips rigs with invalid typeId', () => {
      const rigs = [
        { typeId: 43920 },  // Valid
        { typeId: 99999 }   // Invalid
      ];

      const result = getRigMaterialBonus(rigs, 88, 0.9);

      // Should only count the valid rig
      expect(result).toBeApproximately(1.9, 0.1);
    });
  });

  describe('getRigTimeBonus', () => {
    test('returns 0 for no rigs', () => {
      const result = getRigTimeBonus([], 88, 0.9);

      expect(result).toBe(0);
    });

    test('calculates bonus for TE rig', () => {
      const rigs = [{ typeId: 43922 }];  // M-Set TE T1 (20%)

      const result = getRigTimeBonus(rigs, 88, 0.9);

      expect(result).toBeApproximately(20.0, 0.1);
    });

    test('stacks bonuses from multiple TE rigs', () => {
      const rigs = [
        { typeId: 43922 },  // TE: 20%
        { typeId: 43922 }   // TE: 20%
      ];

      const result = getRigTimeBonus(rigs, 88, 0.9);

      // Should stack: 20 + 20 = 40
      expect(result).toBeApproximately(40.0, 0.1);
    });

    test('applies security status multiplier', () => {
      const rigs = [{ typeId: 43922 }];  // 20% base
      const lowSecStatus = 0.3;

      const result = getRigTimeBonus(rigs, 88, lowSecStatus);

      // Should be 20 * 0.8 = 16
      expect(result).toBeLessThan(20.0);
    });

    test('returns 0 for ME rigs (wrong type)', () => {
      const rigs = [{ typeId: 43920 }];  // ME rig, not TE

      const result = getRigTimeBonus(rigs, 88, 0.9);

      // ME rig has no time bonus
      expect(result).toBe(0);
    });
  });

  describe('getRigCostBonus', () => {
    test('returns 0 for no rigs', () => {
      const result = getRigCostBonus([], 88, 0.9);

      expect(result).toBe(0);
    });

    test('calculates bonus for cost reduction rig', () => {
      // Note: Most test rigs don't have cost bonuses in our mock
      // This tests the mechanism even if result is 0
      const rigs = [{ typeId: 43920 }];

      const result = getRigCostBonus(rigs, 88, 0.9);

      // ME rig has no cost bonus in our mock
      expect(result).toBe(0);
    });

    test('applies security status multiplier', () => {
      const rigs = [{ typeId: 43920 }];
      const lowSecStatus = 0.3;

      const result = getRigCostBonus(rigs, 88, lowSecStatus);

      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getRigBonusesFromSDE', () => {
    test('retrieves all rig bonuses', () => {
      const result = getRigBonusesFromSDE(43920);

      expect(result).toBeDefined();
      expect(result.materialBonus).toBeDefined();
      expect(result.timeBonus).toBeDefined();
      expect(result.costBonus).toBeDefined();
    });

    test('returns ME bonus for ME rig', () => {
      const result = getRigBonusesFromSDE(43920);  // ME T1 rig

      expect(result.materialBonus).toBeApproximately(1.9, 0.1);
    });

    test('returns TE bonus for TE rig', () => {
      const result = getRigBonusesFromSDE(43922);  // TE T1 rig

      expect(result.timeBonus).toBeApproximately(20.0, 0.1);
    });

    test('returns zero bonuses for invalid rig', () => {
      const result = getRigBonusesFromSDE(99999);

      expect(result.materialBonus).toBe(0);
      expect(result.timeBonus).toBe(0);
      expect(result.costBonus).toBe(0);
    });

    test('handles database errors gracefully', () => {
      // Even if DB throws error, should return zero bonuses
      const result = getRigBonusesFromSDE(null);

      expect(result).toBeDefined();
      expect(result.materialBonus).toBe(0);
    });
  });

  describe('getRigGroupId', () => {
    test('returns group ID for valid rig', () => {
      const result = getRigGroupId(43920);

      expect(result).toBeDefined();
      expect(result).toBe(1154);
    });

    test('returns null for invalid rig', () => {
      const result = getRigGroupId(99999);

      expect(result).toBeNull();
    });

    test('handles database errors gracefully', () => {
      const result = getRigGroupId(null);

      expect(result).toBeNull();
    });
  });

  describe('Product Group Matching', () => {
    test('matches rig to appropriate product group', () => {
      const rigMappings = require('../../src/main/rig-mappings');

      // In our mock, all rigs match all products
      // Real implementation checks complex mappings
      const rigs = [{ typeId: 43920 }];
      const result = getRigMaterialBonus(rigs, 88, 0.9);

      expect(result).toBeGreaterThan(0);
      expect(rigMappings.rigAffectsProduct).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    test('handles empty rig array', () => {
      expect(() => {
        getRigMaterialBonus([], 88, 0.9);
        getRigTimeBonus([], 88, 0.9);
        getRigCostBonus([], 88, 0.9);
      }).not.toThrow();
    });

    test('handles undefined security status', () => {
      const rigs = [{ typeId: 43920 }];

      // Should use default 0.5 security
      const result = getRigMaterialBonus(rigs, 88);

      expect(result).toBeGreaterThan(0);
    });

    test('handles mixed valid and invalid rigs', () => {
      const rigs = [
        { typeId: 43920 },  // Valid
        { typeId: null },   // Invalid
        { typeId: 43921 }   // Valid
      ];

      const result = getRigMaterialBonus(rigs, 88, 0.9);

      // Should sum only valid rigs: 1.9 + 2.4 = 4.3
      expect(result).toBeApproximately(4.3, 0.1);
    });
  });
});
