/**
 * Market watchlists, watchlist items, and favourites.
 *
 * Schema lives in market-schema-migrations.js (migration 001_market_watchlists)
 * against market-data.db - the same database as price_overrides and the price
 * cache. That file has its own migration numbering, independent of the
 * character DB's.
 *
 * Alerts
 * ------
 * This module stores alert RULES and the anchored baselines they measure
 * against. It does not evaluate them: whether a rule is currently hit is
 * derived in the renderer from the live price versus the baseline, which is
 * what drives the per-watchlist bell badge and the tab count.
 *
 * A background engine used to live here and was unreachable - see the note
 * further down, above the item helpers.
 */

const { getMarketDatabase } = require('./market-database');

// 'percent' = move of N% from the baseline; 'isk' = move of N ISK from it.
const VALID_ALERT_TYPES = ['none', 'percent', 'isk'];
const VALID_ALERT_DIRECTIONS = ['above', 'below'];
const SIDES = ['buy', 'sell'];

// ---------------------------------------------------------------------------
// Watchlist CRUD
// ---------------------------------------------------------------------------

/**
 * List all watchlists with their item counts.
 * @returns {Array<object>}
 */
function getWatchlists() {
  const db = getMarketDatabase();
  return db
    .prepare(
      `SELECT w.*, COUNT(i.id) AS item_count
       FROM market_watchlists w
       LEFT JOIN market_watchlist_items i ON i.watchlist_id = w.id
       GROUP BY w.id
       ORDER BY w.sort_order, w.name`
    )
    .all();
}

/**
 * Get a single watchlist with its items.
 * @param {number} watchlistId
 * @returns {object|null}
 */
function getWatchlist(watchlistId) {
  const db = getMarketDatabase();
  const watchlist = db
    .prepare('SELECT * FROM market_watchlists WHERE id = ?')
    .get(watchlistId);
  if (!watchlist) return null;

  watchlist.items = getWatchlistItems(watchlistId);
  return watchlist;
}

/**
 * Create a watchlist.
 * @param {{name: string, description?: string, marketSetId?: number, sortOrder?: number}} data
 * @returns {object} The created watchlist
 */
function createWatchlist({ name, description = null, marketSetId = null, sortOrder = 0 } = {}) {
  if (!name || !String(name).trim()) {
    throw new Error('Watchlist name is required');
  }

  const db = getMarketDatabase();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO market_watchlists (name, description, market_set_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(String(name).trim(), description, marketSetId, sortOrder, now, now);

  return getWatchlist(result.lastInsertRowid);
}

/**
 * Update a watchlist's editable fields. Only provided fields are changed.
 * @param {number} watchlistId
 * @param {{name?: string, description?: string, marketSetId?: number, sortOrder?: number}} updates
 * @returns {object|null} The updated watchlist
 */
function updateWatchlist(watchlistId, updates = {}) {
  const db = getMarketDatabase();
  const existing = db
    .prepare('SELECT * FROM market_watchlists WHERE id = ?')
    .get(watchlistId);
  if (!existing) return null;

  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    if (!String(updates.name).trim()) throw new Error('Watchlist name cannot be empty');
    fields.push('name = ?');
    values.push(String(updates.name).trim());
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.marketSetId !== undefined) {
    fields.push('market_set_id = ?');
    values.push(updates.marketSetId);
  }
  if (updates.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sortOrder);
  }

  if (fields.length === 0) return getWatchlist(watchlistId);

  fields.push('updated_at = ?');
  values.push(Date.now(), watchlistId);

  db.prepare(`UPDATE market_watchlists SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getWatchlist(watchlistId);
}

/**
 * Delete a watchlist. Items cascade via the FK.
 * @param {number} watchlistId
 * @returns {boolean} True if a row was deleted
 */
function deleteWatchlist(watchlistId) {
  const db = getMarketDatabase();
  // better-sqlite3 does not enable foreign keys by default; the explicit item
  // delete makes the cascade unconditional rather than pragma-dependent.
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM market_watchlist_items WHERE watchlist_id = ?').run(watchlistId);
    return db.prepare('DELETE FROM market_watchlists WHERE id = ?').run(watchlistId);
  });
  return remove().changes > 0;
}

// ---------------------------------------------------------------------------
// Watchlist items
// ---------------------------------------------------------------------------

/**
 * Get every item in a watchlist.
 * @param {number} watchlistId
 * @returns {Array<object>}
 */
function getWatchlistItems(watchlistId) {
  const db = getMarketDatabase();
  return db
    .prepare(
      'SELECT * FROM market_watchlist_items WHERE watchlist_id = ? ORDER BY created_at'
    )
    .all(watchlistId);
}

/**
 * Add an item to a watchlist, capturing its anchored price baseline.
 *
 * Re-adding an existing item updates its rules but KEEPS the original
 * baseline - re-adding is not a re-baseline, and silently resetting it would
 * erase whatever drift the user was tracking.
 *
 * @param {number} watchlistId
 * @param {number} typeId
 * @param {object} [opts]
 * @param {number} [opts.baseBuy]  - Baseline buy price at add time
 * @param {number} [opts.baseSell] - Baseline sell price at add time
 * @param {object} [opts.buy]      - {type, direction, value}
 * @param {object} [opts.sell]     - {type, direction, value}
 * @returns {object} The created or updated item
 */
function addWatchlistItem(watchlistId, typeId, opts = {}) {
  if (!typeId) throw new Error('typeId is required');

  const buy = normalizeRule(opts.buy, 'buy');
  const sell = normalizeRule(opts.sell, 'sell');

  const db = getMarketDatabase();
  const watchlist = db
    .prepare('SELECT id FROM market_watchlists WHERE id = ?')
    .get(watchlistId);
  if (!watchlist) throw new Error(`Watchlist ${watchlistId} not found`);

  const now = Date.now();
  const baseBuy = Number.isFinite(opts.baseBuy) ? opts.baseBuy : null;
  const baseSell = Number.isFinite(opts.baseSell) ? opts.baseSell : null;

  // ON CONFLICT deliberately leaves base_buy/base_sell/baseline_at and the
  // last_*_alert_at debounce stamps alone.
  db.prepare(`
    INSERT INTO market_watchlist_items
      (watchlist_id, type_id, base_buy, base_sell, baseline_at,
       buy_alert_type, buy_alert_direction, buy_alert_value,
       sell_alert_type, sell_alert_direction, sell_alert_value,
       created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(watchlist_id, type_id) DO UPDATE SET
      buy_alert_type = excluded.buy_alert_type,
      buy_alert_direction = excluded.buy_alert_direction,
      buy_alert_value = excluded.buy_alert_value,
      sell_alert_type = excluded.sell_alert_type,
      sell_alert_direction = excluded.sell_alert_direction,
      sell_alert_value = excluded.sell_alert_value
  `).run(
    watchlistId, typeId, baseBuy, baseSell, (baseBuy !== null || baseSell !== null) ? now : null,
    buy.type, buy.direction, buy.value,
    sell.type, sell.direction, sell.value,
    now
  );

  touchWatchlist(watchlistId);

  return db
    .prepare('SELECT * FROM market_watchlist_items WHERE watchlist_id = ? AND type_id = ?')
    .get(watchlistId, typeId);
}

/**
 * Re-anchor an item's baseline to the supplied prices.
 *
 * The ONLY way base_buy/base_sell move after the item is added. Explicit by
 * design: drift is measured from the point the user chose, so nothing should
 * quietly reset it.
 *
 * @param {number} itemId
 * @param {{buy?: number, sell?: number}} prices
 * @returns {object|null} The updated item
 */
function rebaselineWatchlistItem(itemId, prices = {}) {
  const db = getMarketDatabase();
  const existing = db
    .prepare('SELECT * FROM market_watchlist_items WHERE id = ?')
    .get(itemId);
  if (!existing) return null;

  const buy = Number.isFinite(prices.buy) ? prices.buy : existing.base_buy;
  const sell = Number.isFinite(prices.sell) ? prices.sell : existing.base_sell;

  db.prepare(`
    UPDATE market_watchlist_items
    SET base_buy = ?, base_sell = ?, baseline_at = ?,
        last_buy_alert_at = NULL, last_sell_alert_at = NULL
    WHERE id = ?
  `).run(buy, sell, Date.now(), itemId);

  // Debounce stamps are cleared with the baseline: an alert that fired against
  // the OLD baseline must not suppress one against the new one.
  return db.prepare('SELECT * FROM market_watchlist_items WHERE id = ?').get(itemId);
}

/** Validate and default one side's rule. */
function normalizeRule(rule, side) {
  const { type = 'none', direction = 'above', value = null } = rule || {};

  if (!VALID_ALERT_TYPES.includes(type)) {
    throw new Error(`Invalid ${side} alert type: ${type}`);
  }
  if (!VALID_ALERT_DIRECTIONS.includes(direction)) {
    throw new Error(`Invalid ${side} alert direction: ${direction}`);
  }
  if (type !== 'none' && (value === null || value === undefined || !Number.isFinite(Number(value)))) {
    throw new Error(`A ${side} alert value is required when an alert type is set`);
  }

  return {
    type,
    direction,
    value: type === 'none' ? null : Number(value),
  };
}

/**
 * Update an item's alert rules. Sides are independent; omitting one leaves it.
 *
 * @param {number} itemId
 * @param {{buy?: object, sell?: object}} updates
 * @returns {object|null} The updated item
 */
function updateWatchlistItem(itemId, updates = {}) {
  const db = getMarketDatabase();
  const existing = db
    .prepare('SELECT * FROM market_watchlist_items WHERE id = ?')
    .get(itemId);
  if (!existing) return null;

  const fields = [];
  const values = [];

  SIDES.forEach((side) => {
    if (updates[side] === undefined) return;
    const rule = normalizeRule(updates[side], side);
    fields.push(`${side}_alert_type = ?`, `${side}_alert_direction = ?`, `${side}_alert_value = ?`);
    values.push(rule.type, rule.direction, rule.value);
  });

  if (fields.length === 0) return existing;

  values.push(itemId);
  db.prepare(`UPDATE market_watchlist_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  touchWatchlist(existing.watchlist_id);
  return db.prepare('SELECT * FROM market_watchlist_items WHERE id = ?').get(itemId);
}

/**
 * Remove an item from a watchlist.
 * @param {number} itemId
 * @returns {boolean} True if a row was deleted
 */
function removeWatchlistItem(itemId) {
  const db = getMarketDatabase();
  const existing = db
    .prepare('SELECT watchlist_id FROM market_watchlist_items WHERE id = ?')
    .get(itemId);
  if (!existing) return false;

  const result = db.prepare('DELETE FROM market_watchlist_items WHERE id = ?').run(itemId);
  touchWatchlist(existing.watchlist_id);
  return result.changes > 0;
}

/**
 * Bump a watchlist's updated_at timestamp.
 * @param {number} watchlistId
 */
function touchWatchlist(watchlistId) {
  const db = getMarketDatabase();
  db.prepare('UPDATE market_watchlists SET updated_at = ? WHERE id = ?').run(
    Date.now(),
    watchlistId
  );
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/**
 * Get every favourited type id.
 * @returns {number[]}
 */
function getFavorites() {
  const db = getMarketDatabase();
  return db
    .prepare('SELECT type_id FROM market_favorites ORDER BY created_at')
    .all()
    .map((row) => row.type_id);
}

/**
 * Toggle an item's favourite state.
 * @param {number} typeId
 * @returns {boolean} The new favourite state
 */
function toggleFavorite(typeId) {
  if (!typeId) throw new Error('typeId is required');

  const db = getMarketDatabase();
  const existing = db
    .prepare('SELECT type_id FROM market_favorites WHERE type_id = ?')
    .get(typeId);

  if (existing) {
    db.prepare('DELETE FROM market_favorites WHERE type_id = ?').run(typeId);
    return false;
  }

  db.prepare('INSERT INTO market_favorites (type_id, created_at) VALUES (?, ?)').run(
    typeId,
    Date.now()
  );
  return true;
}

/**
 * Explicitly set an item's favourite state.
 * @param {number} typeId
 * @param {boolean} isFavorite
 * @returns {boolean} The new favourite state
 */
function setFavorite(typeId, isFavorite) {
  if (!typeId) throw new Error('typeId is required');

  const db = getMarketDatabase();
  if (isFavorite) {
    db.prepare(
      'INSERT OR IGNORE INTO market_favorites (type_id, created_at) VALUES (?, ?)'
    ).run(typeId, Date.now());
    return true;
  }

  db.prepare('DELETE FROM market_favorites WHERE type_id = ?').run(typeId);
  return false;
}

/*
 * There is deliberately no alert ENGINE here.
 *
 * One existed - `evaluateAlerts()` plus `isSideTriggered()` and a 6h
 * `last_alert_at` debounce - and it was never reachable: nothing subscribed it
 * to `market:data-changed` (this file's own header claimed otherwise), and its
 * preload method had no callers. 33 unit tests guarded a function the app
 * could not invoke.
 *
 * Alert STATE is computed in the renderer instead, from the live price against
 * the stored baseline (`sideAlertState` in market-view-renderer.js). That is
 * what drives the per-watchlist bell badge and the tab count, and it is all
 * the feature needs: the alert is visible on the screen where you act on it.
 *
 * The debounce columns `last_buy_alert_at` / `last_sell_alert_at` remain in
 * migration 001 - they are unshipped-schema history, and dropping columns to
 * chase dead code is not worth a migration.
 */

module.exports = {
  // Watchlists
  getWatchlists,
  getWatchlist,
  createWatchlist,
  updateWatchlist,
  deleteWatchlist,
  // Items
  getWatchlistItems,
  addWatchlistItem,
  updateWatchlistItem,
  removeWatchlistItem,
  // Favourites
  getFavorites,
  toggleFavorite,
  setFavorite,
  rebaselineWatchlistItem,
};
