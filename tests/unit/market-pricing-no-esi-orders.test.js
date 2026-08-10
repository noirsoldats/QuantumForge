/**
 * INVARIANT: a price calculation never fetches MARKET ORDERS from ESI.
 *
 * The only sanctioned way order-book data updates is an explicit user action -
 * the Market Manager refresh buttons and the Dashboard refresh - which reach
 * ESI through manualRefreshMarketData (the sole caller passing
 * `forceRefresh: true` to fetchMarketOrders).
 *
 * This is easy to break silently: fetchMarketOrders looks like a fetching
 * function, and it IS one - but only when its 4th argument is true. Passing
 * `true` from market-pricing.js, or swapping in a helper that force-refreshes,
 * would turn every price calculation in the app into ESI traffic against an
 * app-wide error limit. Nothing about that failure is visible locally: prices
 * still come out correct.
 *
 * MARKET HISTORY is deliberately exempt. It is per-type, expires daily, and the
 * order-book-only fallback needs it fresh - so history calls are expected here
 * and are asserted only to prove the probe can see traffic at all.
 *
 * The cache is mocked COLD so every fetch path is maximally tempted to fire.
 */

const REGION_ID = 10000002;
const TYPE_ID = 34;

jest.mock('../../src/main/market-database', () => ({
  getCachedMarketOrders: jest.fn(() => []),   // cold
  getCachedMarketHistory: jest.fn(() => []),  // cold
  getPriceOverride: jest.fn(() => null),
  cachePrice: jest.fn(),
  getCachedPrice: jest.fn(() => null),
  getMarketDatabase: jest.fn(() => ({
    prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }),
  })),
  storeMarketOrders: jest.fn(),
  storeMarketHistory: jest.fn(),
  clearPriceCache: jest.fn(),
}));

/** Every pricing method, so no branch escapes the check. */
const PRICE_METHODS = ['immediate', 'vwap', 'percentile', 'hybrid', 'historical'];

const isOrderBookUrl = (url) => /\/markets\/\d+\/orders/.test(String(url));
const isHistoryUrl = (url) => /\/markets\/\d+\/history/.test(String(url));

let fetchedUrls;

beforeEach(() => {
  jest.resetModules();
  fetchedUrls = [];
  // global.fetch is the only route to the network, so recording it catches any
  // path regardless of which helper was used.
  global.fetch = jest.fn(async (url) => {
    fetchedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '[]',
      headers: { get: () => null },
    };
  });
});

afterEach(() => {
  delete global.fetch;
});

describe('calculateRealisticPrice never fetches market orders from ESI', () => {
  test.each(PRICE_METHODS)(
    'priceMethod "%s" makes zero market-order calls on a cold cache',
    async (priceMethod) => {
      const { calculateRealisticPrice } = require('../../src/main/market-pricing');

      await calculateRealisticPrice(TYPE_ID, REGION_ID, null, 'sell', 100, { priceMethod });

      const orderCalls = fetchedUrls.filter(isOrderBookUrl);
      expect(orderCalls).toEqual([]);
    }
  );

  test('history IS allowed to fetch - proves the probe can see traffic', async () => {
    // Without this, all five assertions above would also pass if the probe were
    // simply blind to every request.
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    await calculateRealisticPrice(TYPE_ID, REGION_ID, null, 'sell', 100, {
      priceMethod: 'historical',
    });

    expect(fetchedUrls.filter(isHistoryUrl).length).toBeGreaterThan(0);
  });

  test('a location filter that empties the order book still fetches no orders', async () => {
    // The riskiest branch: after the location filter leaves zero orders, the
    // code goes looking for a fallback. That fallback must be HISTORY, never a
    // re-fetch of the order book.
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    await calculateRealisticPrice(TYPE_ID, REGION_ID, 60003760, 'sell', 100, {
      priceMethod: 'vwap',
    });

    expect(fetchedUrls.filter(isOrderBookUrl)).toEqual([]);
  });
});
