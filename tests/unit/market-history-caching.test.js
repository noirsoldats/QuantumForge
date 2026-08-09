/**
 * Market-history fetching: skipHistory, and caching the "no history" answer.
 *
 * Two costs made the Assets screen take minutes to price a hangar:
 *
 *   1. History is fetched ONE TYPE AT A TIME and expires daily at 11:05 UTC.
 *      A ~1,300-type hangar therefore meant up to 1,300 sequential ESI calls
 *      before a single row rendered - every day, however warm the cache was
 *      yesterday. Measured on the reporting machine: 1,308/1,308 types needed a
 *      live fetch in one region, 577/1,308 in the other, against a 330 MB cache.
 *
 *   2. An item with NO history left no rows behind, and isHistoryStale() derives
 *      freshness from those rows - so it read as permanently stale and was
 *      re-fetched forever. Measured: 6,981 history metadata keys against only
 *      5,113 types with rows, i.e. ~1,900 types re-asked on every pass.
 */

// `jest.mock` factories are hoisted above every declaration in the file, so
// they cannot close over an ordinary local. Jest permits a `mock`-prefixed name
// as the documented exception.
const mockEsiFetch = jest.fn();
jest.mock('../../src/main/esi-fetch', () => ({ esiFetch: mockEsiFetch }));

let mockMarketDb;
jest.mock('../../src/main/market-database', () => ({
  getMarketDatabase: () => mockMarketDb,
  clearPriceCache: jest.fn(),
}));

jest.mock('../../src/main/user-agent', () => ({ getUserAgent: () => 'test' }));
// Fuzzwork is a fallback path these tests never exercise; stubbing it keeps a
// real HTTP client out of the suite.
jest.mock('../../src/main/fuzzwork-market', () => ({
  fetchFuzzworkHistory: jest.fn(async () => []),
}));

const Database = require('better-sqlite3');

const REGION = 10000002;
const TYPE = 34;
const DAY = 24 * 60 * 60 * 1000;

/** Most recent 11:05 UTC, the point history regenerates. */
function lastCutoff(now = new Date()) {
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 5, 0
  ));
  return now >= today ? today : new Date(today.getTime() - DAY);
}

beforeEach(() => {
  jest.resetModules();
  mockEsiFetch.mockReset();

  mockMarketDb = new Database(':memory:');
  mockMarketDb.exec(`
    CREATE TABLE market_history (
      type_id INTEGER, region_id INTEGER, date TEXT,
      average REAL, highest REAL, lowest REAL,
      order_count INTEGER, volume INTEGER, fetched_at INTEGER,
      PRIMARY KEY (type_id, region_id, date)
    );
    CREATE TABLE fetch_metadata (
      key TEXT PRIMARY KEY, last_fetch INTEGER NOT NULL, expires_at INTEGER
    );
    CREATE TABLE market_orders (
      order_id INTEGER PRIMARY KEY, type_id INTEGER, region_id INTEGER,
      location_id INTEGER, is_buy_order INTEGER, price REAL,
      volume_remain INTEGER, fetched_at INTEGER
    );
    -- getPriceOverride() reads this on every pricing call, so it must exist
    -- even for the tests that set no override.
    CREATE TABLE price_overrides (
      type_id INTEGER PRIMARY KEY, price REAL, notes TEXT, updated_at INTEGER
    );
    -- calculateRealisticPrice() writes its result here at the end of every
    -- call. Copied verbatim from market-database.js, UNIQUE constraint
    -- included: cachePriceCalculation uses INSERT OR REPLACE, which needs it
    -- to do anything other than append.
    CREATE TABLE market_price_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      price_type TEXT NOT NULL,
      price REAL NOT NULL,
      vwap REAL,
      percentile_price REAL,
      historical_7d REAL,
      historical_30d REAL,
      confidence TEXT,
      warning TEXT,
      quantity INTEGER,
      calculated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(type_id, location_id, price_type, quantity)
    );
  `);
});

afterEach(() => {
  mockMarketDb.close();
});

describe('caching the "no history" answer', () => {
  test('an empty result is recorded so the next call does not re-fetch', async () => {
    const { fetchMarketHistory } = require('../../src/main/esi-market');
    mockEsiFetch.mockResolvedValue({ empty: true, cacheExpiresAt: Date.now() + DAY });

    const first = await fetchMarketHistory(REGION, TYPE);
    const second = await fetchMarketHistory(REGION, TYPE);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // The whole point: ONE call, not one per pricing pass forever.
    expect(mockEsiFetch).toHaveBeenCalledTimes(1);
  });

  test('a 200 carrying zero days is cached too', async () => {
    // Same failure mode as `empty`: no rows written, so nothing to date-stamp.
    const { fetchMarketHistory } = require('../../src/main/esi-market');
    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: Date.now() + DAY });

    await fetchMarketHistory(REGION, TYPE);
    await fetchMarketHistory(REGION, TYPE);

    expect(mockEsiFetch).toHaveBeenCalledTimes(1);
  });

  test('the miss is stored in fetch_metadata, NOT as a history row', async () => {
    // A sentinel row would pollute every average and volume calculation.
    const { fetchMarketHistory } = require('../../src/main/esi-market');
    mockEsiFetch.mockResolvedValue({ empty: true, cacheExpiresAt: Date.now() + DAY });

    await fetchMarketHistory(REGION, TYPE);

    const rows = mockMarketDb.prepare('SELECT COUNT(*) AS n FROM market_history').get().n;
    const meta = mockMarketDb.prepare(
      "SELECT COUNT(*) AS n FROM fetch_metadata WHERE key LIKE 'market_history_empty_%'"
    ).get().n;

    expect(rows).toBe(0);
    expect(meta).toBe(1);
  });

  test('an expired empty-marker is retried', async () => {
    const { fetchMarketHistory } = require('../../src/main/esi-market');

    mockMarketDb.prepare(
      'INSERT INTO fetch_metadata (key, last_fetch, expires_at) VALUES (?, ?, ?)'
    ).run(`market_history_empty_${REGION}_${TYPE}`, Date.now() - 2 * DAY, Date.now() - DAY);

    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: Date.now() + DAY });
    await fetchMarketHistory(REGION, TYPE);

    expect(mockEsiFetch).toHaveBeenCalledTimes(1);
  });

  test('an empty-marker with no explicit expiry ages out on the daily cutoff', async () => {
    const { fetchMarketHistory } = require('../../src/main/esi-market');

    // Recorded just before the last 11:05 UTC regeneration => stale.
    mockMarketDb.prepare(
      'INSERT INTO fetch_metadata (key, last_fetch, expires_at) VALUES (?, ?, NULL)'
    ).run(`market_history_empty_${REGION}_${TYPE}`, lastCutoff().getTime() - 60000);

    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: null });
    await fetchMarketHistory(REGION, TYPE);

    expect(mockEsiFetch).toHaveBeenCalledTimes(1);
  });

  test('an empty-marker recorded after the cutoff is still trusted', async () => {
    const { fetchMarketHistory } = require('../../src/main/esi-market');

    mockMarketDb.prepare(
      'INSERT INTO fetch_metadata (key, last_fetch, expires_at) VALUES (?, ?, NULL)'
    ).run(`market_history_empty_${REGION}_${TYPE}`, lastCutoff().getTime() + 60000);

    const result = await fetchMarketHistory(REGION, TYPE);

    expect(result).toEqual([]);
    expect(mockEsiFetch).not.toHaveBeenCalled();
  });

  test('a forced refresh ignores the empty-marker', async () => {
    const { fetchMarketHistory } = require('../../src/main/esi-market');

    mockMarketDb.prepare(
      'INSERT INTO fetch_metadata (key, last_fetch, expires_at) VALUES (?, ?, ?)'
    ).run(`market_history_empty_${REGION}_${TYPE}`, Date.now(), Date.now() + DAY);

    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: null });
    await fetchMarketHistory(REGION, TYPE, true);

    expect(mockEsiFetch).toHaveBeenCalledTimes(1);
  });

  test('a real history result is unaffected by the empty path', async () => {
    const { fetchMarketHistory } = require('../../src/main/esi-market');
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-01', average: 5.8, highest: 6, lowest: 5.5, order_count: 10, volume: 1000 }],
      cacheExpiresAt: Date.now() + DAY,
    });

    const history = await fetchMarketHistory(REGION, TYPE);

    expect(history).toHaveLength(1);
    const meta = mockMarketDb.prepare(
      "SELECT COUNT(*) AS n FROM fetch_metadata WHERE key LIKE 'market_history_empty_%'"
    ).get().n;
    expect(meta).toBe(0);
  });
});

describe('skipHistory', () => {
  /** Seed one sell order so the order book can produce a price. */
  function seedOrders(price = 100) {
    mockMarketDb.prepare(`
      INSERT INTO market_orders
        (order_id, type_id, region_id, location_id, is_buy_order, price, volume_remain, fetched_at)
      VALUES (1, ?, ?, 60003760, 0, ?, 1000, ?)
    `).run(TYPE, REGION, price, Date.now());
  }

  test('prices from the order book without fetching history', async () => {
    seedOrders();
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'immediate' }, { skipHistory: true }
    );

    expect(result.price).toBeGreaterThan(0);
    // The saving that makes a 1,300-type hangar viable.
    expect(mockEsiFetch).not.toHaveBeenCalled();
  });

  test('a history-USING method still fetches without the flag', async () => {
    // 'hybrid' validates its candidates against the 7-day average, so it reads
    // history even though it prices from the order book. ('immediate' would
    // NOT fetch here - see the method-derived suite below.)
    seedOrders();
    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: null });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'hybrid' }, {}
    );

    expect(mockEsiFetch).toHaveBeenCalled();
  });

  test('the "historical" method ignores skipHistory - history IS its price', async () => {
    // Honouring the flag here would return 0 instead of a price. The caller
    // asked for a historical price; give them one.
    seedOrders();
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-01', average: 42, highest: 43, lowest: 41, order_count: 5, volume: 100 }],
      cacheExpiresAt: Date.now() + DAY,
    });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'historical' }, { skipHistory: true }
    );

    expect(mockEsiFetch).toHaveBeenCalled();
    expect(result.price).toBeGreaterThan(0);
  });

  test('an override still short-circuits before any market read', async () => {
    mockMarketDb.prepare(
      'INSERT INTO price_overrides (type_id, price, notes, updated_at) VALUES (?, ?, ?, ?)'
    ).run(TYPE, 999, 'manual', Date.now());

    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, {}, { skipHistory: true }
    );

    expect(result.price).toBe(999);
    expect(result.method).toBe('override');
    expect(mockEsiFetch).not.toHaveBeenCalled();
  });

  test('defaults to OFF, so existing callers keep the sanity check', async () => {
    // No priceMethod -> 'hybrid', which reads history.
    seedOrders();
    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: null });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    await calculateRealisticPrice(TYPE, REGION, null, 'sell', 1, {});

    expect(mockEsiFetch).toHaveBeenCalled();
  });
});

describe('history is skipped for methods that never read it', () => {
  // A market set on 'immediate' (the common configuration) should make ZERO
  // history calls, without every caller having to pass skipHistory. History is
  // fetched one type at a time and expires daily, so on a whole-screen
  // valuation this is the difference between instant and minutes.

  function seedOrders(price = 100) {
    mockMarketDb.prepare(`
      INSERT INTO market_orders
        (order_id, type_id, region_id, location_id, is_buy_order, price, volume_remain, fetched_at)
      VALUES (1, ?, ?, 60003760, 0, ?, 1000, ?)
    `).run(TYPE, REGION, price, Date.now());
  }

  test.each(['immediate', 'vwap', 'percentile'])(
    "'%s' prices from the order book and never fetches history",
    async (priceMethod) => {
      seedOrders();
      const { calculateRealisticPrice } = require('../../src/main/market-pricing');

      const result = await calculateRealisticPrice(
        TYPE, REGION, null, 'sell', 1, { priceMethod }
      );

      expect(result.price).toBeGreaterThan(0);
      expect(mockEsiFetch).not.toHaveBeenCalled();
    }
  );

  test("'hybrid' still fetches - it validates candidates against the average", async () => {
    // Excluded deliberately: dropping history here would change the price it
    // picks, not just the confidence attached to it.
    seedOrders();
    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: null });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    await calculateRealisticPrice(TYPE, REGION, null, 'sell', 1, { priceMethod: 'hybrid' });

    expect(mockEsiFetch).toHaveBeenCalled();
  });

  test("'historical' still fetches - history IS its price", async () => {
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-01', average: 42, highest: 43, lowest: 41, order_count: 5, volume: 100 }],
      cacheExpiresAt: Date.now() + DAY,
    });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'historical' }
    );

    expect(mockEsiFetch).toHaveBeenCalled();
    expect(result.price).toBeGreaterThan(0);
  });

  test('the no-orders fallback FETCHES history rather than using a stale cache', async () => {
    // The skip is DEFERRAL, not abandonment. Relying on whatever was cached
    // would return 0 with an empty cache, or a stale price forever - the
    // fallback would silently rot instead of updating.
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-06', average: 55, highest: 60, lowest: 50, order_count: 10, volume: 1000 }],
      cacheExpiresAt: Date.now() + DAY,
    });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    // No orders seeded, so 'immediate' must fall back.
    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'immediate' }
    );

    expect(mockEsiFetch).toHaveBeenCalled();
    expect(result.price).toBe(55);
    expect(result.method).toBe('historical');
  });

  test('an empty cache no longer means a 0 price', async () => {
    // The regression this guards: with nothing cached and no fetch, the
    // fallback returned 0 and the item silently valued at nothing.
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-06', average: 42, highest: 45, lowest: 40, order_count: 3, volume: 50 }],
      cacheExpiresAt: Date.now() + DAY,
    });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'immediate' }
    );

    expect(result.price).toBe(42);
  });

  test('the fallback fetch triggers on a LOCATION-filtered empty book', async () => {
    // A global order book can be non-empty while the chosen station has
    // nothing, so the check must come after the location filter.
    seedOrders(); // at station 60003760
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-06', average: 77, highest: 80, lowest: 70, order_count: 4, volume: 60 }],
      cacheExpiresAt: Date.now() + DAY,
    });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, 60008494 /* a different station */, 'sell', 1, { priceMethod: 'immediate' }
    );

    expect(mockEsiFetch).toHaveBeenCalled();
    expect(result.price).toBe(77);
  });

  test('metadata distinguishes "not consulted" from "no data"', async () => {
    // historicalDays: 0 is ambiguous on its own.
    seedOrders();
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const skipped = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'immediate' }
    );
    expect(skipped.metadata.historySkipped).toBe(true);

    mockEsiFetch.mockResolvedValue({ data: [], cacheExpiresAt: null });
    const consulted = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'hybrid' }
    );
    expect(consulted.metadata.historySkipped).toBe(false);
  });

  test('historySkipped reports what HAPPENED, not what was intended', async () => {
    // Deferred, then actually fetched for the fallback - so it is false.
    mockEsiFetch.mockResolvedValue({
      data: [{ date: '2026-08-06', average: 30, highest: 32, lowest: 28, order_count: 2, volume: 20 }],
      cacheExpiresAt: Date.now() + DAY,
    });
    const { calculateRealisticPrice } = require('../../src/main/market-pricing');

    const result = await calculateRealisticPrice(
      TYPE, REGION, null, 'sell', 1, { priceMethod: 'immediate' }
    );

    expect(result.metadata.historySkipped).toBe(false);
    expect(result.metadata.historicalDays).toBeGreaterThan(0);
  });
});
