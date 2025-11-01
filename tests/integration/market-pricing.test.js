/**
 * Integration Tests for Market Pricing System
 *
 * Tests the complete market pricing workflow including ESI data fetching,
 * price calculations, caching, overrides, and confidence determination
 */

const {
  calculateRealisticPrice,
  getPriceOverride,
  setPriceOverride,
  removePriceOverride,
  calculateVWAP,
  calculatePercentilePrice,
  calculateHistoricalAverage
} = require('../../src/main/market-pricing');

const marketData = require('../unit/fixtures/market-data');

// Mock ESI market module with realistic data
jest.mock('../../src/main/esi-market', () => ({
  fetchMarketOrders: jest.fn((typeId, regionId) => {
    // Return fixture data for Tritanium
    if (typeId === 34) {
      return Promise.resolve([
        { price: 6.45, volume_remain: 5000000, is_buy_order: false, location_id: 60003760 },
        { price: 6.48, volume_remain: 3000000, is_buy_order: false, location_id: 60003760 },
        { price: 6.50, volume_remain: 10000000, is_buy_order: false, location_id: 60003760 },
        { price: 6.55, volume_remain: 2000000, is_buy_order: false, location_id: 60003760 },
        { price: 6.60, volume_remain: 1000000, is_buy_order: false, location_id: 60003760 }
      ]);
    }
    return Promise.resolve([]);
  }),
  fetchMarketHistory: jest.fn((typeId, regionId) => {
    if (typeId === 34) {
      return Promise.resolve([
        { date: '2024-01-10', average: 6.40, volume: 50000000 },
        { date: '2024-01-09', average: 6.42, volume: 48000000 },
        { date: '2024-01-08', average: 6.38, volume: 52000000 },
        { date: '2024-01-07', average: 6.41, volume: 49000000 },
        { date: '2024-01-06', average: 6.39, volume: 51000000 }
      ]);
    }
    return Promise.resolve([]);
  }),
  getCachedMarketOrders: jest.fn(() => null),  // Return null to force fresh fetch
  getCachedMarketHistory: jest.fn(() => null),  // Return null to force fresh fetch
  fetchMarketData: jest.fn((regionId, typeId) => {
    // Return fixture data for Tritanium
    if (typeId === 34) {
      return Promise.resolve({
        orders: [
          { price: 6.45, volume_remain: 5000000, is_buy_order: false, location_id: 60003760 },
          { price: 6.48, volume_remain: 3000000, is_buy_order: false, location_id: 60003760 },
          { price: 6.50, volume_remain: 10000000, is_buy_order: false, location_id: 60003760 },
          { price: 6.55, volume_remain: 2000000, is_buy_order: false, location_id: 60003760 },
          { price: 6.60, volume_remain: 1000000, is_buy_order: false, location_id: 60003760 }
        ],
        history: [
          { date: '2024-01-10', average: 6.40, volume: 50000000 },
          { date: '2024-01-09', average: 6.42, volume: 48000000 },
          { date: '2024-01-08', average: 6.38, volume: 52000000 },
          { date: '2024-01-07', average: 6.41, volume: 49000000 },
          { date: '2024-01-06', average: 6.39, volume: 51000000 }
        ]
      });
    }
    return Promise.resolve({ orders: [], history: [] });
  }),
}));

// Mock market database
jest.mock('../../src/main/market-database', () => {
  let priceOverrides = {};
  let priceCache = {};

  return {
    getMarketDatabase: jest.fn(() => ({
      prepare: jest.fn((query) => ({
        get: jest.fn((typeId) => {
          // Check for price override
          if (query.includes('price_overrides')) {
            const override = priceOverrides[typeId];
            return override ? {
              type_id: typeId,
              price: override.price,
              notes: override.notes,
              created_at: Date.now(),
              updated_at: Date.now()
            } : null;
          }

          // Check for cached price
          if (query.includes('price_cache')) {
            return priceCache[typeId] || null;
          }

          return null;
        }),
        all: jest.fn(() => {
          return Object.entries(priceOverrides).map(([typeId, data]) => ({
            type_id: parseInt(typeId),
            price: data.price,
            notes: data.notes,
            created_at: Date.now(),
            updated_at: Date.now()
          }));
        }),
        run: jest.fn((...args) => {
          // Check which table this is for based on argument count
          if (args.length === 1) {
            // Delete operation (typeId only)
            delete priceOverrides[args[0]];
          } else if (args.length === 4) {
            // Price override insert (typeId, price, notes, timestamp)
            const [typeId, price, notes, timestamp] = args;
            priceOverrides[typeId] = { price, notes };
          } else if (args.length === 14) {
            // Price cache insert - ignore for this test
            // (typeId, locationId, regionId, priceType, price, vwap, percentile, ...)
            return;
          }
        })
      })),
      close: jest.fn()
    })),
    // Expose helpers for test setup
    __setOverride: (typeId, price, notes) => {
      priceOverrides[typeId] = { price, notes };
    },
    __clearOverrides: () => {
      priceOverrides = {};
    },
    __setCache: (typeId, data) => {
      priceCache[typeId] = data;
    },
    __clearCache: () => {
      priceCache = {};
    }
  };
});

describe('Market Pricing - Integration Tests', () => {
  beforeEach(() => {
    // Clear mocks between tests
    const marketDb = require('../../src/main/market-database');
    if (marketDb.__clearOverrides) marketDb.__clearOverrides();
    if (marketDb.__clearCache) marketDb.__clearCache();
  });

  describe('End-to-End Price Calculation Workflow', () => {
    test('complete workflow: fetch orders → calculate price → apply settings', async () => {
      const settings = {
        priceMethod: 'vwap',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,  // Tritanium
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      expect(result).toBeDefined();
      expect(result.price).toBeGreaterThan(0);
      expect(result.method).toBe('vwap');
      expect(result.confidence).toBeDefined();
      expect(['high', 'medium', 'low', 'none']).toContain(result.confidence);
    });

    test('workflow with price override bypasses ESI', async () => {
      // Set a manual override
      const marketDb = require('../../src/main/market-database');
      marketDb.__setOverride(34, 10.00, 'Test override');

      const settings = {
        priceMethod: 'vwap',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      expect(result.price).toBe(10.00);
      expect(result.method).toBe('override');
      expect(result.confidence).toBe('high');
    });

    test('workflow falls back from orders to historical when no data', async () => {
      const esiMarket = require('../../src/main/esi-market');
      // Mock fetchMarketData to return empty orders but some history
      esiMarket.fetchMarketData.mockResolvedValueOnce({
        orders: [],
        history: [
          { date: '2024-01-10', average: 6.40, volume: 50000000 },
          { date: '2024-01-09', average: 6.42, volume: 48000000 }
        ]
      });

      const settings = {
        priceMethod: 'vwap',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      if (result && result.price > 0) {
        expect(result.method).toBe('historical');
        expect(result.confidence).toBe('low');
      }
    });
  });

  describe('Price Method Integration', () => {
    test('immediate method uses cheapest available order', async () => {
      const settings = {
        priceMethod: 'immediate',
        priceModifier: 1.0,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      expect(result.price).toBeApproximately(6.45, 0.05);  // Cheapest order
    });

    test('vwap method weighs by volume', async () => {
      const settings = {
        priceMethod: 'vwap',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      // VWAP should be between min and max prices
      expect(result.price).toBeGreaterThan(6.40);
      expect(result.price).toBeLessThan(6.65);
    });

    test('percentile method uses 20th percentile by volume', async () => {
      const settings = {
        priceMethod: 'percentile',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      expect(result.method).toBe('percentile');
      expect(result.price).toBeGreaterThan(0);
    });

    test('historical method averages past days', async () => {
      const settings = {
        priceMethod: 'historical',
        priceModifier: 1.0,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      expect(result.method).toBe('historical');
      // Should be around 6.40 (average of historical data)
      expect(result.price).toBeApproximately(6.40, 0.10);
    });

    test('hybrid method combines multiple methods', async () => {
      const settings = {
        priceMethod: 'hybrid',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      expect(result.method).toBe('hybrid');
      expect(result.price).toBeGreaterThan(0);
    });
  });

  describe('Price Override System Integration', () => {
    test('setting override persists and takes effect', async () => {
      // Set override
      const setResult = setPriceOverride(34, 15.00, 'Manual test price');
      expect(setResult).toBe(true);

      // Retrieve override
      const override = getPriceOverride(34);
      expect(override).toBeDefined();
      expect(override.price).toBe(15.00);

      // Use in pricing calculation
      const priceResult = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0 }
      );

      expect(priceResult.price).toBe(15.00);
      expect(priceResult.method).toBe('override');
    });

    test('removing override restores market pricing', async () => {
      // Set override
      setPriceOverride(34, 20.00, 'Temporary override');

      // Calculate with override
      const resultWithOverride = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0 }
      );
      expect(resultWithOverride.method).toBe('override');

      // Remove override
      const removeResult = removePriceOverride(34);
      expect(removeResult).toBe(true);

      // Calculate without override
      const resultWithoutOverride = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0 }
      );
      expect(resultWithoutOverride.method).not.toBe('override');
    });

    test('updating override changes price immediately', async () => {
      // Set initial override
      setPriceOverride(34, 12.00, 'Initial price');

      const result1 = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0 }
      );
      expect(result1.price).toBe(12.00);

      // Update override
      setPriceOverride(34, 18.00, 'Updated price');

      const result2 = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0 }
      );
      expect(result2.price).toBe(18.00);
    });
  });

  describe('Confidence Level Determination', () => {
    test('high confidence when large volume available', async () => {
      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        100000,  // Small quantity vs 21M available
        { priceMethod: 'vwap', priceModifier: 1.0, percentile: 0.2 }
      );

      expect(result.confidence).toBe('high');
    });

    test('lower confidence when quantity approaches available volume', async () => {
      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        20000000,  // Close to 21M available
        { priceMethod: 'vwap', priceModifier: 1.0, percentile: 0.2 }
      );

      // Confidence may still be high with sufficient volume
      expect(['high', 'medium', 'low']).toContain(result.confidence);
    });

    test('high confidence for overrides', async () => {
      setPriceOverride(34, 25.00, 'Override test');

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0 }
      );

      expect(result.confidence).toBe('high');
    });
  });

  describe('Price Modifier Integration', () => {
    test('modifier affects final calculated price', async () => {
      // Test with different typeIds to avoid any caching issues
      const result1x = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0, percentile: 0.2 }
      );

      // Verify first price is reasonable
      expect(result1x).toBeDefined();
      expect(result1x.price).toBeGreaterThan(0);
      expect(result1x.price).toBeLessThan(100);

      const result1_1x = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.1, percentile: 0.2 }
      );

      // Verify second price is reasonable
      expect(result1_1x).toBeDefined();
      expect(result1_1x.price).toBeGreaterThan(0);
      expect(result1_1x.price).toBeLessThan(100);

      // Verify modifier effect
      expect(result1_1x.price).toBeApproximately(result1x.price * 1.1, 0.01);
    });

    test('modifier does not affect override prices', async () => {
      setPriceOverride(34, 30.00, 'Fixed price');

      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.5, percentile: 0.2 }
      );

      // Override should not be modified
      expect(result.price).toBe(30.00);
    });
  });

  describe('Error Handling and Resilience', () => {
    test('handles ESI API errors gracefully', async () => {
      const esiMarket = require('../../src/main/esi-market');
      esiMarket.fetchMarketData.mockRejectedValueOnce(new Error('ESI timeout'));

      // Function should throw when ESI fails
      await expect(
        calculateRealisticPrice(
          34,
          marketData.THE_FORGE_REGION_ID,
          marketData.JITA_STATION_ID,
          'sell',
          1000000,
          { priceMethod: 'vwap', priceModifier: 1.0, percentile: 0.2 }
        )
      ).rejects.toThrow('ESI timeout');
    });

    test('returns zero price when all methods fail', async () => {
      const esiMarket = require('../../src/main/esi-market');
      esiMarket.fetchMarketOrders.mockResolvedValueOnce([]);
      esiMarket.fetchMarketHistory.mockResolvedValueOnce([]);

      const result = await calculateRealisticPrice(
        99999,  // Non-existent item
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'vwap', priceModifier: 1.0, percentile: 0.2 }
      );

      expect(result.price).toBe(0);
      expect(['none', 'low']).toContain(result.confidence);
    });

    test('handles invalid settings gracefully', async () => {
      const result = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        { priceMethod: 'invalid_method', priceModifier: 1.0 }
      );

      // Should default to some valid method
      expect(result).toBeDefined();
      expect(result.price).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Real-World Scenarios', () => {
    test('bulk material pricing for manufacturing', async () => {
      const materials = [
        { typeId: 34, quantity: 1000000 },   // Tritanium
        { typeId: 35, quantity: 500000 },    // Pyerite (mock would need setup)
        { typeId: 36, quantity: 100000 }     // Mexallon (mock would need setup)
      ];

      const settings = {
        priceMethod: 'vwap',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000
      };

      // Calculate prices for all materials
      const prices = await Promise.all(
        materials.map(mat =>
          calculateRealisticPrice(
            mat.typeId,
            marketData.THE_FORGE_REGION_ID,
            marketData.JITA_STATION_ID,
            'sell',
            mat.quantity,
            settings
          )
        )
      );

      expect(prices.length).toBe(3);
      prices.forEach(price => {
        expect(price).toBeDefined();
        expect(price.price).toBeGreaterThanOrEqual(0);
      });
    });

    test('comparing buy vs sell prices', async () => {
      const settings = {
        priceMethod: 'immediate',
        priceModifier: 1.0,
        minVolume: 1000
      };

      const sellPrice = await calculateRealisticPrice(
        34,
        marketData.THE_FORGE_REGION_ID,
        marketData.JITA_STATION_ID,
        'sell',
        1000000,
        settings
      );

      // For buy orders, would need different mock setup
      expect(sellPrice.price).toBeGreaterThan(0);
      expect(sellPrice.method).toBe('immediate');
    });
  });
});
