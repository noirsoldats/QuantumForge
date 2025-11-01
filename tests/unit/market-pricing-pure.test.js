/**
 * Unit Tests for Pure Market Pricing Functions
 *
 * Tests calculation functions that have no external dependencies
 * and produce deterministic results from input data
 */

const {
  calculateVWAP,
  calculatePercentilePrice,
  calculateHistoricalAverage,
  calculateStdDev,
  calculateMedian,
  removeOutliers,
  getBestPriceWithMinVolume
} = require('../../src/main/market-pricing');

const marketData = require('./fixtures/market-data');
const { calculateExpectedVWAP, calculateExpectedPercentile } = require('./helpers/test-utils');

describe('Market Pricing - Pure Functions', () => {
  describe('calculateVWAP', () => {
    test('calculates VWAP for sell orders with sufficient depth', () => {
      const result = calculateVWAP(marketData.tritaniumOrders.sell, 1000000, false);

      expect(result.price).toBeGreaterThan(0);
      expect(result.incomplete).toBe(false);
      expect(result.quantityFilled).toBe(1000000);
      expect(result.quantityRequested).toBe(1000000);
      expect(result.ordersUsed).toBeGreaterThan(0);
    });

    test('calculates VWAP for buy orders', () => {
      const result = calculateVWAP(marketData.tritaniumOrders.buy, 1000000, true);

      expect(result.price).toBeGreaterThan(0);
      expect(result.incomplete).toBe(false);
      expect(result.quantityFilled).toBe(1000000);
    });

    test('handles insufficient market depth', () => {
      const result = calculateVWAP(marketData.lowDepthOrders, 1000, false);

      expect(result.incomplete).toBe(true);
      expect(result.quantityFilled).toBeLessThan(result.quantityRequested);
      expect(result.quantityFilled).toBe(150);  // 100 + 50 available
    });

    test('returns zero price for empty orders', () => {
      const result = calculateVWAP(marketData.emptyOrders, 1000, false);

      expect(result.price).toBe(0);
      expect(result.incomplete).toBe(true);
      expect(result.quantityFilled).toBe(0);
      expect(result.ordersUsed).toBe(0);
    });

    test('uses only orders matching buy/sell direction', () => {
      const mixedOrders = [
        ...marketData.tritaniumOrders.sell,
        ...marketData.tritaniumOrders.buy
      ];

      const sellResult = calculateVWAP(mixedOrders, 1000000, false);
      const pureResult = calculateVWAP(marketData.tritaniumOrders.sell, 1000000, false);

      expect(sellResult.price).toBeApproximately(pureResult.price, 0.01);
    });

    test('correctly weights prices by volume', () => {
      const orders = [
        { price: 100, volume_remain: 1000, is_buy_order: false },
        { price: 200, volume_remain: 1000, is_buy_order: false }
      ];

      const result = calculateVWAP(orders, 2000, false);

      // Expected VWAP: (100*1000 + 200*1000) / 2000 = 150
      expect(result.price).toBeApproximately(150, 0.01);
    });

    test('handles exact quantity match', () => {
      const orders = [
        { price: 100, volume_remain: 1000, is_buy_order: false }
      ];

      const result = calculateVWAP(orders, 1000, false);

      expect(result.incomplete).toBe(false);
      expect(result.quantityFilled).toBe(1000);
      expect(result.price).toBe(100);
    });
  });

  describe('calculatePercentilePrice', () => {
    test('calculates 20th percentile for sell orders', () => {
      const result = calculatePercentilePrice(marketData.tritaniumOrders.sell, false, 0.2);

      expect(result).toBeGreaterThan(0);
      // Should be close to lowest price in sell orders
      expect(result).toBeApproximately(6.52, 0.1);
    });

    test('calculates 50th percentile (median)', () => {
      const result = calculatePercentilePrice(marketData.tritaniumOrders.sell, false, 0.5);

      expect(result).toBeGreaterThan(6.52);
      expect(result).toBeLessThan(6.75);
    });

    test('calculates 80th percentile', () => {
      const result = calculatePercentilePrice(marketData.tritaniumOrders.sell, false, 0.8);

      expect(result).toBeGreaterThanOrEqual(6.55);
      // Should be closer to higher prices
    });

    test('handles buy orders correctly', () => {
      const result = calculatePercentilePrice(marketData.tritaniumOrders.buy, true, 0.2);

      expect(result).toBeGreaterThan(0);
    });

    test('returns 0 for empty orders', () => {
      const result = calculatePercentilePrice(marketData.emptyOrders, false, 0.2);

      expect(result).toBe(0);
    });

    test('handles single order', () => {
      const result = calculatePercentilePrice(marketData.singleOrder, false, 0.5);

      expect(result).toBe(100);
    });

    test('filters orders by buy/sell direction', () => {
      const mixedOrders = [
        ...marketData.tritaniumOrders.sell,
        ...marketData.tritaniumOrders.buy
      ];

      const sellResult = calculatePercentilePrice(mixedOrders, false, 0.2);
      const pureResult = calculatePercentilePrice(marketData.tritaniumOrders.sell, false, 0.2);

      expect(sellResult).toBeApproximately(pureResult, 0.01);
    });
  });

  describe('getBestPriceWithMinVolume', () => {
    test('returns best price meeting minimum volume', () => {
      const result = getBestPriceWithMinVolume(marketData.highVolumeOrders, false, 1000);

      expect(result).toBeGreaterThan(0);
      // Should return price from orders meeting threshold (5000 or 8000 volume)
      expect(result).toBeApproximately(1020, 5);
    });

    test('falls back to average of top 5 when no large orders', () => {
      const result = getBestPriceWithMinVolume(marketData.tritaniumOrders.sell, false, 50000000);

      expect(result).toBeGreaterThan(0);
      // Should be average of top 5 sell orders
      const expected = (6.52 + 6.53 + 6.55 + 6.60 + 6.75) / 5;
      expect(result).toBeApproximately(expected, 0.01);
    });

    test('handles buy orders', () => {
      const result = getBestPriceWithMinVolume(marketData.tritaniumOrders.buy, true, 1000);

      expect(result).toBeGreaterThan(0);
    });

    test('returns 0 for empty orders', () => {
      const result = getBestPriceWithMinVolume(marketData.emptyOrders, false, 1000);

      expect(result).toBe(0);
    });

    test('handles orders with fewer than 5 entries', () => {
      const result = getBestPriceWithMinVolume(marketData.lowDepthOrders, false, 10000);

      expect(result).toBeGreaterThan(0);
      // Should average available orders
      expect(result).toBeApproximately(51, 1);
    });
  });

  describe('removeOutliers', () => {
    test('removes extreme high and low prices using IQR method', () => {
      const result = removeOutliers(marketData.ordersWithOutliers, false);

      // Should remove the 500 (high) and 10 (low) outliers
      expect(result.length).toBeLessThan(marketData.ordersWithOutliers.length);
      expect(result.every(o => o.price < 500)).toBe(true);
      expect(result.every(o => o.price > 10)).toBe(true);
    });

    test('returns all orders when no outliers present', () => {
      const result = removeOutliers(marketData.tritaniumOrders.sell, false);

      // Normal distribution, no outliers expected
      expect(result.length).toBeGreaterThan(0);
    });

    test('returns all orders when insufficient data (< 4 orders)', () => {
      const fewOrders = marketData.ordersWithOutliers.slice(0, 3);
      const result = removeOutliers(fewOrders, false);

      expect(result.length).toBe(3);
    });

    test('filters by buy/sell direction', () => {
      const mixedOrders = [
        ...marketData.ordersWithOutliers,
        { price: 50, volume_remain: 1000, is_buy_order: true }
      ];

      const result = removeOutliers(mixedOrders, false);

      expect(result.every(o => o.is_buy_order === false)).toBe(true);
    });

    test('returns empty array for empty input', () => {
      const result = removeOutliers(marketData.emptyOrders, false);

      expect(result).toEqual([]);
    });
  });

  describe('calculateHistoricalAverage', () => {
    test('calculates average for all days when days is null', () => {
      const result = calculateHistoricalAverage(marketData.tritaniumHistory, 'average', null);

      expect(result).toBeGreaterThan(0);
      expect(result).toBeApproximately(6.52, 0.1);
    });

    test('calculates average for last 7 days', () => {
      const result = calculateHistoricalAverage(marketData.tritaniumHistory, 'average', 7);

      expect(result).toBeGreaterThan(0);
    });

    test('calculates average for last 30 days', () => {
      const result = calculateHistoricalAverage(marketData.tritaniumHistory, 'average', 30);

      expect(result).toBeGreaterThan(0);
    });

    test('calculates highest price average', () => {
      const result = calculateHistoricalAverage(marketData.tritaniumHistory, 'highest', null);

      expect(result).toBeGreaterThan(6.52);
      expect(result).toBeApproximately(6.91, 0.1);
    });

    test('calculates lowest price average', () => {
      const result = calculateHistoricalAverage(marketData.tritaniumHistory, 'lowest', null);

      expect(result).toBeLessThan(6.52);
      expect(result).toBeApproximately(6.31, 0.1);
    });

    test('returns 0 for empty history', () => {
      const result = calculateHistoricalAverage(marketData.emptyHistory, 'average', null);

      expect(result).toBe(0);
    });

    test('handles single history entry', () => {
      const result = calculateHistoricalAverage(marketData.singleHistoryEntry, 'average', null);

      expect(result).toBe(6.50);
    });

    test('limits to specified number of days', () => {
      const last3Days = marketData.tritaniumHistory.slice(-3);
      const expected = last3Days.reduce((sum, d) => sum + d.average, 0) / 3;

      const result = calculateHistoricalAverage(marketData.tritaniumHistory, 'average', 3);

      expect(result).toBeApproximately(expected, 0.01);
    });
  });

  describe('calculateStdDev', () => {
    test('calculates standard deviation for average prices', () => {
      const result = calculateStdDev(marketData.tritaniumHistory, 'average');

      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);  // Low volatility expected
    });

    test('calculates higher std dev for volatile data', () => {
      const volatileStdDev = calculateStdDev(marketData.volatileHistory, 'average');
      const stableStdDev = calculateStdDev(marketData.tritaniumHistory, 'average');

      expect(volatileStdDev).toBeGreaterThan(stableStdDev);
    });

    test('returns 0 for empty history', () => {
      const result = calculateStdDev(marketData.emptyHistory, 'average');

      expect(result).toBe(0);
    });

    test('returns 0 for single data point', () => {
      const result = calculateStdDev(marketData.singleHistoryEntry, 'average');

      expect(result).toBe(0);
    });

    test('calculates for highest prices', () => {
      const result = calculateStdDev(marketData.tritaniumHistory, 'highest');

      expect(result).toBeGreaterThan(0);
    });

    test('calculates for lowest prices', () => {
      const result = calculateStdDev(marketData.tritaniumHistory, 'lowest');

      expect(result).toBeGreaterThan(0);
    });
  });

  describe('calculateMedian', () => {
    test('calculates median for odd number of values', () => {
      const values = [1, 2, 3, 4, 5];
      const result = calculateMedian(values);

      expect(result).toBe(3);
    });

    test('calculates median for even number of values', () => {
      const values = [1, 2, 3, 4];
      const result = calculateMedian(values);

      expect(result).toBe(2.5);  // Average of 2 and 3
    });

    test('handles unsorted input', () => {
      const values = [5, 1, 4, 2, 3];
      const result = calculateMedian(values);

      expect(result).toBe(3);
    });

    test('returns 0 for empty array', () => {
      const result = calculateMedian([]);

      expect(result).toBe(0);
    });

    test('returns single value for single element', () => {
      const result = calculateMedian([42]);

      expect(result).toBe(42);
    });

    test('handles duplicate values', () => {
      const values = [1, 2, 2, 2, 3];
      const result = calculateMedian(values);

      expect(result).toBe(2);
    });

    test('handles negative values', () => {
      const values = [-5, -2, 0, 2, 5];
      const result = calculateMedian(values);

      expect(result).toBe(0);
    });
  });

  describe('Edge Cases and Integration', () => {
    test('handles orders with zero volume', () => {
      const orders = [
        { price: 100, volume_remain: 0, is_buy_order: false },
        { price: 105, volume_remain: 1000, is_buy_order: false }
      ];

      const result = calculateVWAP(orders, 500, false);

      expect(result.price).toBe(105);
      expect(result.quantityFilled).toBe(500);
    });

    test('handles very large quantities', () => {
      const result = calculateVWAP(marketData.tritaniumOrders.sell, 1000000000, false);

      expect(result.incomplete).toBe(true);
      expect(result.quantityFilled).toBeLessThan(1000000000);
    });

    test('handles very small quantities', () => {
      const result = calculateVWAP(marketData.tritaniumOrders.sell, 1, false);

      expect(result.incomplete).toBe(false);
      expect(result.quantityFilled).toBe(1);
      expect(result.price).toBe(6.52);  // Best sell price
    });
  });
});
