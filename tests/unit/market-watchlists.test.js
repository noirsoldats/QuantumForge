/**
 * Unit tests for market watchlists: CRUD, cascade delete, and favourites.
 *
 * Uses a real in-memory SQLite DB with the market migration schema applied, so the
 * tests exercise the actual SQL rather than a mock that could drift from it.
 *
 * There are no alert-engine tests because there is no alert engine. One existed
 * and was unreachable - nothing subscribed it to `market:data-changed` and its
 * preload method had no callers - so 33 tests here guarded a function the app
 * could not invoke. Whether a rule is hit is derived in the renderer from the
 * live price against its baseline, and IS tested, in
 * `tests/renderer/market-watchlist-ui.test.js`.
 */

const Database = require('better-sqlite3');

// Named with the `mock` prefix because jest.mock() factories are hoisted above
// this declaration; Jest only permits a factory to close over out-of-scope
// variables whose names start with "mock".
let mockDb;

// market-watchlists.js resolves its DB through getMarketDatabase(); point that
// at the in-memory instance.
jest.mock('../../src/main/market-database', () => ({
  getMarketDatabase: () => mockDb,
}));

const watchlists = require('../../src/main/market-watchlists');
const { migrations } = require('../../src/main/market-schema-migrations');

beforeEach(() => {
  mockDb = new Database(':memory:');
  // Apply the real migration rather than a hand-copied schema, so a schema
  // change that breaks this module is caught here.
  for (const migration of migrations) {
    migration.up(mockDb);
  }
});

afterEach(() => {
  mockDb.close();
});

describe('watchlist CRUD', () => {
  test('creates a watchlist and reads it back', () => {
    const created = watchlists.createWatchlist({
      name: 'Capital Components',
      description: 'Tracking build inputs',
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe('Capital Components');
    expect(created.items).toEqual([]);

    const all = watchlists.getWatchlists();
    expect(all).toHaveLength(1);
    expect(all[0].item_count).toBe(0);
  });

  test('trims the name and rejects an empty one', () => {
    expect(watchlists.createWatchlist({ name: '  Spaced  ' }).name).toBe('Spaced');
    expect(() => watchlists.createWatchlist({ name: '   ' })).toThrow(/name is required/i);
    expect(() => watchlists.createWatchlist({})).toThrow(/name is required/i);
  });

  test('updates only the provided fields', () => {
    const created = watchlists.createWatchlist({
      name: 'Original',
      description: 'Keep me',
    });

    const updated = watchlists.updateWatchlist(created.id, { name: 'Renamed' });

    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBe('Keep me');
  });

  test('rejects renaming to an empty string', () => {
    const created = watchlists.createWatchlist({ name: 'Original' });
    expect(() => watchlists.updateWatchlist(created.id, { name: '  ' })).toThrow(
      /cannot be empty/i
    );
  });

  test('returns null when updating a watchlist that does not exist', () => {
    expect(watchlists.updateWatchlist(9999, { name: 'Nope' })).toBeNull();
  });

  test('deleting a watchlist cascades to its items', () => {
    const list = watchlists.createWatchlist({ name: 'Doomed' });
    watchlists.addWatchlistItem(list.id, 34);
    watchlists.addWatchlistItem(list.id, 35);

    expect(watchlists.getWatchlistItems(list.id)).toHaveLength(2);

    expect(watchlists.deleteWatchlist(list.id)).toBe(true);
    expect(watchlists.getWatchlist(list.id)).toBeNull();

    const orphans = mockDb
      .prepare('SELECT COUNT(*) AS n FROM market_watchlist_items WHERE watchlist_id = ?')
      .get(list.id).n;
    expect(orphans).toBe(0);
  });

  test('deleting a nonexistent watchlist reports false', () => {
    expect(watchlists.deleteWatchlist(9999)).toBe(false);
  });
});

describe('watchlist items', () => {
  let listId;

  beforeEach(() => {
    listId = watchlists.createWatchlist({ name: 'Items' }).id;
  });

  test('adds an item with a baseline and both rule sides', () => {
    const item = watchlists.addWatchlistItem(listId, 34, {
      baseBuy: 5, baseSell: 6,
      sell: { type: 'percent', direction: 'above', value: 10 },
    });

    expect(item.type_id).toBe(34);
    expect(item.base_buy).toBe(5);
    expect(item.base_sell).toBe(6);
    expect(item.baseline_at).toBeGreaterThan(0);
    expect(item.sell_alert_type).toBe('percent');
    expect(item.buy_alert_type).toBe('none');
  });

  test('re-adding updates the rules but KEEPS the original baseline', () => {
    // Re-adding is not re-baselining: silently resetting the anchor would
    // erase whatever drift the user was tracking.
    watchlists.addWatchlistItem(listId, 34, { baseBuy: 5, baseSell: 6 });
    const readded = watchlists.addWatchlistItem(listId, 34, {
      baseBuy: 999, baseSell: 999,
      buy: { type: 'isk', direction: 'below', value: 2 },
    });

    expect(watchlists.getWatchlistItems(listId)).toHaveLength(1);
    expect(readded.base_buy).toBe(5);
    expect(readded.base_sell).toBe(6);
    expect(readded.buy_alert_type).toBe('isk');
  });

  test('rejects an invalid rule', () => {
    expect(() => watchlists.addWatchlistItem(listId, 34, {
      sell: { type: 'bogus', value: 1 },
    })).toThrow(/invalid sell alert type/i);

    expect(() => watchlists.addWatchlistItem(listId, 34, {
      buy: { type: 'percent', direction: 'sideways', value: 1 },
    })).toThrow(/invalid buy alert direction/i);

    expect(() => watchlists.addWatchlistItem(listId, 34, {
      sell: { type: 'percent' },
    })).toThrow(/sell alert value is required/i);
  });

  test('updates one side without disturbing the other', () => {
    const item = watchlists.addWatchlistItem(listId, 34, {
      baseBuy: 5, baseSell: 6,
      sell: { type: 'percent', direction: 'above', value: 10 },
    });

    const updated = watchlists.updateWatchlistItem(item.id, {
      buy: { type: 'isk', direction: 'below', value: 1 },
    });

    expect(updated.buy_alert_type).toBe('isk');
    expect(updated.sell_alert_type).toBe('percent');
    expect(updated.sell_alert_value).toBe(10);
  });

  test('rebaseline is the only thing that moves the anchor', () => {
    const item = watchlists.addWatchlistItem(listId, 34, { baseBuy: 5, baseSell: 6 });

    const rebased = watchlists.rebaselineWatchlistItem(item.id, { buy: 9, sell: 11 });

    expect(rebased.base_buy).toBe(9);
    expect(rebased.base_sell).toBe(11);
  });

  test('rebaseline clears the debounce stamps', () => {
    // Vestigial columns from the removed alert engine, but rebaseline still
    // clears them: leaving stale values in a row the UI reads would be worse
    // than clearing columns nothing writes.
    const item = watchlists.addWatchlistItem(listId, 34, {
      baseBuy: 5, baseSell: 6,
      sell: { type: 'percent', direction: 'above', value: 10 },
    });
    mockDb.prepare('UPDATE market_watchlist_items SET last_sell_alert_at = ? WHERE id = ?')
      .run(Date.now(), item.id);

    const rebased = watchlists.rebaselineWatchlistItem(item.id, { buy: 9, sell: 11 });

    expect(rebased.last_sell_alert_at).toBeNull();
  });

  test('removes an item', () => {
    const item = watchlists.addWatchlistItem(listId, 34, {});
    expect(watchlists.removeWatchlistItem(item.id)).toBe(true);
    expect(watchlists.getWatchlistItems(listId)).toHaveLength(0);
  });
});

describe('favourites', () => {
  test('toggle flips state and persists', () => {
    expect(watchlists.getFavorites()).toEqual([]);

    expect(watchlists.toggleFavorite(34)).toBe(true);
    expect(watchlists.getFavorites()).toEqual([34]);

    expect(watchlists.toggleFavorite(34)).toBe(false);
    expect(watchlists.getFavorites()).toEqual([]);
  });

  test('setFavorite is idempotent in both directions', () => {
    watchlists.setFavorite(34, true);
    watchlists.setFavorite(34, true);
    expect(watchlists.getFavorites()).toEqual([34]);

    watchlists.setFavorite(34, false);
    watchlists.setFavorite(34, false);
    expect(watchlists.getFavorites()).toEqual([]);
  });

  test('rejects a missing typeId', () => {
    expect(() => watchlists.toggleFavorite(null)).toThrow(/typeId is required/i);
    expect(() => watchlists.setFavorite(undefined, true)).toThrow(/typeId is required/i);
  });
});
