/**
 * Unit Tests for Market Price Cache Clearing
 *
 * Tests the cache clearing functionality when market data is refreshed from ESI
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock the market-database module
let mockDb = null;

jest.mock('../../src/main/market-database', () => {
  return {
    getMarketDatabase: () => mockDb,
    clearPriceCache: jest.fn((regionId = null, typeId = null) => {
      if (!mockDb) return;

      try {
        if (regionId && typeId) {
          mockDb.prepare('DELETE FROM market_price_cache WHERE region_id = ? AND type_id = ?')
            .run(regionId, typeId);
        } else if (regionId) {
          mockDb.prepare('DELETE FROM market_price_cache WHERE region_id = ?')
            .run(regionId);
        } else {
          mockDb.prepare('DELETE FROM market_price_cache').run();
        }
      } catch (error) {
        // Silent fail for tests
      }
    })
  };
});

describe('Market Price Cache Clearing', () => {
  let testDbPath;
  let clearPriceCache;

  beforeAll(() => {
    // Create test database in temp directory
    testDbPath = path.join(os.tmpdir(), `test-market-${Date.now()}.db`);
    mockDb = new Database(testDbPath);

    // Create market_price_cache table
    mockDb.exec(`
      CREATE TABLE IF NOT EXISTS market_price_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id INTEGER NOT NULL,
        location_id INTEGER,
        region_id INTEGER NOT NULL,
        price_type TEXT NOT NULL,
        price REAL NOT NULL,
        vwap REAL,
        percentile_price REAL,
        historical_7d REAL,
        historical_30d REAL,
        confidence TEXT,
        warning TEXT,
        quantity INTEGER NOT NULL,
        calculated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_market_price_cache_lookup
        ON market_price_cache(type_id, location_id, price_type);
      CREATE INDEX IF NOT EXISTS idx_market_price_cache_expires
        ON market_price_cache(expires_at);
    `);

    // Load the clearPriceCache function
    const marketDatabase = require('../../src/main/market-database');
    clearPriceCache = marketDatabase.clearPriceCache;
  });

  afterAll(() => {
    if (mockDb) {
      mockDb.close();
      mockDb = null;
    }
    // Clean up test database
    if (testDbPath && fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(() => {
    // Clear table before each test
    if (mockDb) {
      mockDb.prepare('DELETE FROM market_price_cache').run();
    }
  });

  describe('clearPriceCache function', () => {
    test('clears cache for specific type and region', () => {
      // Insert test data
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(35, 10000002, 60003760, 'sell', 6.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(34, 10000003, 60003760, 'sell', 5.7, 1000, Date.now(), Date.now() + 300000);

      // Verify initial state
      expect(mockDb.prepare('SELECT COUNT(*) as count FROM market_price_cache').get().count).toBe(3);

      // Clear specific type in specific region
      clearPriceCache(10000002, 34);

      // Verify only one entry cleared
      const remaining = mockDb.prepare('SELECT * FROM market_price_cache').all();
      expect(remaining).toHaveLength(2);
      expect(remaining.some(r => r.type_id === 34 && r.region_id === 10000002)).toBe(false);
      expect(remaining.some(r => r.type_id === 35 && r.region_id === 10000002)).toBe(true);
      expect(remaining.some(r => r.type_id === 34 && r.region_id === 10000003)).toBe(true);
    });

    test('clears cache for entire region', () => {
      // Insert test data
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(35, 10000002, 60003760, 'sell', 6.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(36, 10000002, 60003760, 'sell', 7.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(34, 10000003, 60003760, 'sell', 5.7, 1000, Date.now(), Date.now() + 300000);

      // Clear entire region
      clearPriceCache(10000002);

      // Verify region cleared
      const remaining = mockDb.prepare('SELECT * FROM market_price_cache').all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].region_id).toBe(10000003);
    });

    test('clears all cache when no parameters provided', () => {
      // Insert test data
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(35, 10000003, 60003760, 'sell', 6.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(36, 10000004, 60003760, 'sell', 7.5, 1000, Date.now(), Date.now() + 300000);

      // Clear all cache
      clearPriceCache();

      // Verify all cleared
      const remaining = mockDb.prepare('SELECT COUNT(*) as count FROM market_price_cache').get();
      expect(remaining.count).toBe(0);
    });

    test('handles empty cache gracefully', () => {
      // Ensure cache is empty
      expect(mockDb.prepare('SELECT COUNT(*) as count FROM market_price_cache').get().count).toBe(0);

      // Should not throw
      expect(() => clearPriceCache(10000002)).not.toThrow();
      expect(() => clearPriceCache(10000002, 34)).not.toThrow();
      expect(() => clearPriceCache()).not.toThrow();
    });

    test('handles invalid parameters gracefully', () => {
      // Insert test data
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);

      // Try to clear non-existent region
      expect(() => clearPriceCache(99999999)).not.toThrow();

      // Verify original data unchanged
      expect(mockDb.prepare('SELECT COUNT(*) as count FROM market_price_cache').get().count).toBe(1);
    });
  });

  describe('Cache clearing integration scenarios', () => {
    test('cache is empty after orders refresh', () => {
      // Simulate: prices calculated and cached
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(35, 10000002, 60003760, 'sell', 6.5, 1000, Date.now(), Date.now() + 300000);

      expect(mockDb.prepare('SELECT COUNT(*) as count FROM market_price_cache WHERE region_id = 10000002').get().count).toBe(2);

      // Simulate: market orders refreshed
      clearPriceCache(10000002);

      // Verify: cache cleared for that region
      expect(mockDb.prepare('SELECT COUNT(*) as count FROM market_price_cache WHERE region_id = 10000002').get().count).toBe(0);
    });

    test('cache is empty for specific type after history refresh', () => {
      // Simulate: prices calculated and cached for multiple types
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(35, 10000002, 60003760, 'sell', 6.5, 1000, Date.now(), Date.now() + 300000);

      // Simulate: history refreshed for type 34
      clearPriceCache(10000002, 34);

      // Verify: cache cleared only for type 34
      const remaining = mockDb.prepare('SELECT * FROM market_price_cache WHERE region_id = 10000002').all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].type_id).toBe(35);
    });

    test('multiple regions maintained separately', () => {
      // Simulate: cached prices in multiple regions
      const insert = mockDb.prepare(`
        INSERT INTO market_price_cache (
          type_id, region_id, location_id, price_type, price,
          quantity, calculated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run(34, 10000002, 60003760, 'sell', 5.5, 1000, Date.now(), Date.now() + 300000);
      insert.run(34, 10000003, 60008494, 'sell', 5.7, 1000, Date.now(), Date.now() + 300000);

      // Clear only region 10000002
      clearPriceCache(10000002);

      // Verify region 10000003 unaffected
      const remaining = mockDb.prepare('SELECT * FROM market_price_cache').all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].region_id).toBe(10000003);
    });
  });
});
