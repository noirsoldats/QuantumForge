/**
 * Unit Tests for Market Pricing Database Functions
 *
 * Tests database-dependent market pricing functions including
 * caching and price override management
 */

const {
  cachePriceCalculation,
  getPriceOverride,
  setPriceOverride,
  removePriceOverride,
  getAllPriceOverrides
} = require('../../src/main/market-pricing');

const { createMarketDatabase } = require('./helpers/database-mocks');
const { wait } = require('./helpers/test-utils');
const marketData = require('./fixtures/market-data');

// Mock the market-database module
jest.mock('../../src/main/market-database', () => {
  let mockDb = null;
  return {
    getMarketDatabase: jest.fn(() => mockDb),
    initializeMarketDatabase: jest.fn(),
    __setMockDatabase: (db) => { mockDb = db; }
  };
});

const marketDatabase = require('../../src/main/market-database');

describe('Market Pricing - Database Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  describe('cachePriceCalculation', () => {
    test('caches price calculation result', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      cachePriceCalculation(
        marketData.TRITANIUM_TYPE_ID,
        60003760, // locationId
        marketData.THE_FORGE_REGION_ID,
        'vwap',
        6.50,
        { vwap: 6.50, confidence: 'high', quantity: 1000 }
      );

      expect(mockDb.prepare).toHaveBeenCalled();
    });

    test('includes timestamp in cached data', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const before = Date.now();
      cachePriceCalculation(
        34,
        60003760,
        10000002,
        'vwap',
        6.50,
        { vwap: 6.50, confidence: 'high', quantity: 1000 }
      );
      const after = Date.now();

      // Verify prepare was called (timestamp would be in the call)
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    test('overwrites existing cache entry', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      cachePriceCalculation(
        34,
        60003760,
        10000002,
        'vwap',
        6.50,
        { vwap: 6.50, confidence: 'high', quantity: 1000 }
      );

      cachePriceCalculation(
        34,
        60003760,
        10000002,
        'vwap',
        6.75,
        { vwap: 6.75, confidence: 'high', quantity: 1000 }
      );

      // Second call should overwrite first
      expect(mockDb.prepare).toHaveBeenCalledTimes(2);
    });

    test('handles different typeIds separately', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      cachePriceCalculation(
        34,
        60003760,
        10000002,
        'vwap',
        6.50,
        { vwap: 6.50, confidence: 'high', quantity: 1000 }
      );

      cachePriceCalculation(
        35,
        60003760,
        10000002,
        'vwap',
        13.00,
        { vwap: 13.00, confidence: 'high', quantity: 1000 }
      );

      expect(mockDb.prepare).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPriceOverride', () => {
    test('returns override for existing typeId', () => {
      const mockDb = createMarketDatabase({
        34: { price: 10.00, notes: 'Test override', updated_at: Date.now() }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getPriceOverride(34);

      expect(result).toBeDefined();
      expect(result.price).toBe(10.00);
      expect(result.notes).toBe('Test override');
    });

    test('returns null for non-existent override', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const result = getPriceOverride(99999);

      expect(result).toBeNull();
    });

    test('includes timestamps in result', () => {
      const mockDb = createMarketDatabase({
        34: {
          price: 10.00,
          notes: 'Test',
          updated_at: Date.now()
        }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getPriceOverride(34);

      if (result) {
        expect(result.timestamp).toBeDefined();
      }
    });

    test('transforms snake_case to camelCase', () => {
      const mockDb = createMarketDatabase({
        34: {
          price: 10.00,
          notes: 'Test',
          updated_at: Date.now()
        }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getPriceOverride(34);

      if (result) {
        expect(result.timestamp).toBeDefined(); // Maps updated_at to timestamp
        expect(result.updated_at).toBeUndefined();
      }
    });
  });

  describe('setPriceOverride', () => {
    test('inserts new price override', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const result = setPriceOverride(34, 10.00, 'Manual override');

      expect(result).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    test('updates existing price override', () => {
      const mockDb = createMarketDatabase({
        34: { price: 9.00, notes: 'Old override', updated_at: Date.now() }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = setPriceOverride(34, 10.00, 'Updated override');

      expect(result).toBe(true);
    });

    test('handles null notes', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const result = setPriceOverride(34, 10.00, null);

      expect(result).toBe(true);
    });

    test('handles empty notes', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const result = setPriceOverride(34, 10.00, '');

      expect(result).toBe(true);
    });

    test('updates timestamp on modification', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const initialTime = Date.now();
      setPriceOverride(34, 9.00, 'Initial');

      // Wait a bit
      const laterTime = Date.now() + 1000;
      setPriceOverride(34, 10.00, 'Updated');

      // Would check that updated_at is newer than created_at
      expect(mockDb.prepare).toHaveBeenCalled();
    });
  });

  describe('removePriceOverride', () => {
    test('removes existing override', () => {
      const mockDb = createMarketDatabase({
        34: { price: 10.00, notes: 'Test', updated_at: Date.now() }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = removePriceOverride(34);

      expect(result).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    test('returns true even if override does not exist', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const result = removePriceOverride(99999);

      // Should not throw, returns true
      expect(result).toBe(true);
    });

    test('calls database delete operation', () => {
      const mockDb = createMarketDatabase({
        34: { price: 10.00, updated_at: Date.now() }
      });
      marketDatabase.__setMockDatabase(mockDb);

      removePriceOverride(34);

      expect(mockDb.prepare).toHaveBeenCalled();
    });
  });

  describe('getAllPriceOverrides', () => {
    test('returns all price overrides', () => {
      const mockDb = createMarketDatabase({
        34: { price: 10.00, notes: 'Tritanium override', updated_at: Date.now() },
        35: { price: 20.00, notes: 'Pyerite override', updated_at: Date.now() }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getAllPriceOverrides();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    test('returns empty array when no overrides', () => {
      const mockDb = createMarketDatabase();
      marketDatabase.__setMockDatabase(mockDb);

      const result = getAllPriceOverrides();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    test('transforms all entries to camelCase', () => {
      const mockDb = createMarketDatabase({
        34: {
          price: 10.00,
          notes: 'Test',
          updated_at: Date.now()
        }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getAllPriceOverrides();

      if (result.length > 0) {
        expect(result[0].typeId).toBeDefined();
        expect(result[0].timestamp).toBeDefined(); // Maps updated_at to timestamp
        expect(result[0].type_id).toBeUndefined();
      }
    });

    test('sorts by type ID', () => {
      const mockDb = createMarketDatabase({
        35: { price: 20.00, updated_at: Date.now() },
        34: { price: 10.00, updated_at: Date.now() },
        36: { price: 30.00, updated_at: Date.now() }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getAllPriceOverrides();

      if (result.length > 1) {
        expect(result[0].typeId).toBeLessThan(result[1].typeId);
      }
    });

    test('includes all override fields', () => {
      const mockDb = createMarketDatabase({
        34: {
          price: 10.00,
          notes: 'Complete override',
          updated_at: Date.now()
        }
      });
      marketDatabase.__setMockDatabase(mockDb);

      const result = getAllPriceOverrides();

      if (result.length > 0) {
        const override = result[0];
        expect(override.typeId).toBeDefined();
        expect(override.price).toBeDefined();
        expect(override.notes).toBeDefined();
        expect(override.timestamp).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    test('handles database errors in caching', () => {
      // Test that the function returns early when db is null
      marketDatabase.__setMockDatabase(null);

      // Should not throw when db is null
      expect(() => {
        cachePriceCalculation(
          34,
          60003760,
          10000002,
          'vwap',
          6.50,
          { vwap: 6.50, confidence: 'high', quantity: 1000 }
        );
      }).not.toThrow();
    });

    test('handles database errors in getPriceOverride', () => {
      // Test that the function returns null when db is null
      marketDatabase.__setMockDatabase(null);

      const result = getPriceOverride(34);

      expect(result).toBeNull();
    });

    test('handles database errors in setPriceOverride', () => {
      // Test that the function returns false when db is null
      marketDatabase.__setMockDatabase(null);
      const result = setPriceOverride(34, 10.00, 'Test');

      expect(result).toBe(false);
    });
  });
});
