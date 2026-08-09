/**
 * Numbered schema migrations for the MARKET database (market-data.db).
 *
 * Why this exists
 * ---------------
 * market-data.db historically had no migration system at all - every table was
 * created by an idempotent `CREATE TABLE IF NOT EXISTS` inside
 * market-database.js `createTables()`. That works for adding whole new tables,
 * but it silently does nothing when an EXISTING table needs a new column or
 * index, because the table already exists. There was no way to evolve market
 * schema safely.
 *
 * This module gives market-data.db the same numbered/tracked migration system
 * the character database already has (see database-schema-migrations.js), and
 * follows its conventions deliberately so the two read the same way:
 *
 *   - migrations are an ordered array of { id, description, up(db) }
 *   - applied ids are tracked in a `schema_migrations` table
 *   - every `up` is idempotent and guards on existence, so re-running is safe
 *   - `runMarketSchemaMigrations()` runs only what is pending, in order
 *
 * IMPORTANT: the baseline tables (market_orders, market_history, price_overrides,
 * ...) remain in market-database.js `createTables()`. This system layers ON TOP
 * of that baseline. New tables MAY be added here; changes to existing tables
 * MUST be added here (a CREATE TABLE IF NOT EXISTS in createTables() cannot
 * alter a table that already exists).
 *
 * NUMBERING: this sequence is INDEPENDENT and starts at 001. It does not
 * continue the character DB's numbering (which is at 025+). The two systems
 * write to different database files, each with its own `schema_migrations`
 * table, and nothing reads ids across both - so the numbers cannot collide.
 * To add a market migration, take the next number in THIS file only; there is
 * no need to consult database-schema-migrations.js.
 *
 * ============================================================================
 * TRANSACTIONS: this runner wraps each `up()` in db.transaction() FOR you.
 * ============================================================================
 *
 * Do NOT write BEGIN/COMMIT/ROLLBACK inside a migration here - SQLite does not
 * nest transactions and it would throw.
 *
 * This is the OPPOSITE of database-schema-migrations.js, where every migration
 * must open its own because that runner does not. The two contracts differ, so
 * do not copy a migration body between the files without adjusting it.
 */

const { getMarketDatabase } = require('./market-database');

const migrations = [
  {
    id: '001_market_watchlists',
    description: 'Add market watchlists, watchlist items, and item favourites',
    up: (db) => {
      // Saved lists of items the user is tracking. market_set_id is a soft
      // reference to the configured market set (settings-managed, not a table
      // in this DB), so it intentionally has no FK constraint.
      //
      // TEXT, not INTEGER: market set ids are opaque strings such as
      // "1776014362091kqqn0afmh". SQLite's affinity would preserve the value
      // either way, but declaring INTEGER misrepresents it and invites callers
      // to coerce with Number(), which yields NaN.
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_watchlists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          market_set_id TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      // Items within a watchlist. ON DELETE CASCADE so removing a watchlist
      // cannot orphan its items.
      //
      // BASELINE ("anchored drift"): base_buy/base_sell are captured ONCE when
      // the item is added, and only move when the user explicitly re-baselines.
      // Drift is measured from them, so it answers "how far has this moved
      // since I started watching?" rather than "since the last check" - a
      // rolling baseline would make a slow multi-day move invisible, because
      // each comparison would only ever see the delta since the previous
      // evaluation.
      //
      // Buy and sell carry INDEPENDENT rules: when buying materials you care
      // about the sell price rising, when selling product you care about the
      // buy price falling, and an item can legitimately want both.
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_watchlist_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          watchlist_id INTEGER NOT NULL REFERENCES market_watchlists(id) ON DELETE CASCADE,
          type_id INTEGER NOT NULL,

          -- Anchored baseline, and when it was taken.
          base_buy REAL,
          base_sell REAL,
          baseline_at INTEGER,

          -- Independent rules per side.
          -- type: 'none' | 'percent' | 'isk'   direction: 'above' | 'below'
          buy_alert_type TEXT NOT NULL DEFAULT 'none',
          buy_alert_direction TEXT NOT NULL DEFAULT 'above',
          buy_alert_value REAL,
          last_buy_alert_at INTEGER,

          sell_alert_type TEXT NOT NULL DEFAULT 'none',
          sell_alert_direction TEXT NOT NULL DEFAULT 'above',
          sell_alert_value REAL,
          last_sell_alert_at INTEGER,

          created_at INTEGER NOT NULL,
          UNIQUE(watchlist_id, type_id)
        )
      `);

      // Per-item favourites, surfaced as the gold star in the Pricing tab.
      // Flat and global (not per-watchlist) to match the mockup.
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_favorites (
          type_id INTEGER PRIMARY KEY,
          created_at INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist
          ON market_watchlist_items(watchlist_id)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_watchlist_items_type
          ON market_watchlist_items(type_id)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_watchlists_sort
          ON market_watchlists(sort_order)
      `);
    },
  },
  // Add future market migrations here
];

/**
 * Initialize the migrations tracking table.
 * @param {Database} db - better-sqlite3 database instance
 */
function initializeMarketMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

/**
 * Get the list of already-applied migration ids.
 * @param {Database} db - better-sqlite3 database instance
 * @returns {string[]}
 */
function getAppliedMarketMigrations(db) {
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY applied_at').all();
  return rows.map((row) => row.id);
}

/**
 * Record a migration as applied.
 * @param {Database} db - better-sqlite3 database instance
 * @param {string} id
 * @param {string} description
 */
function markMarketMigrationApplied(db, id, description) {
  db.prepare(`
    INSERT INTO schema_migrations (id, description, applied_at)
    VALUES (?, ?, ?)
  `).run(id, description, Date.now());
}

/**
 * Check whether any market migrations are pending.
 * @returns {boolean}
 */
function needsMarketSchemaMigrations() {
  try {
    const db = getMarketDatabase();
    initializeMarketMigrationsTable(db);

    const applied = getAppliedMarketMigrations(db);
    const pending = migrations.filter((m) => !applied.includes(m.id));

    if (pending.length > 0) {
      console.log(
        `[Market Migrations] ${pending.length} pending migration(s):`,
        pending.map((m) => m.id)
      );
      return true;
    }

    console.log('[Market Migrations] No pending migrations');
    return false;
  } catch (error) {
    console.error('[Market Migrations] Error checking migrations:', error);
    return false;
  }
}

/**
 * Run all pending market schema migrations, in order.
 * Each migration runs inside a transaction so a failure cannot leave the
 * database half-migrated or record a migration that did not fully apply.
 * @returns {Promise<void>}
 */
async function runMarketSchemaMigrations() {
  console.log('[Market Migrations] Starting market schema migrations...');

  const db = getMarketDatabase();

  try {
    initializeMarketMigrationsTable(db);

    const applied = getAppliedMarketMigrations(db);
    console.log('[Market Migrations] Applied migrations:', applied);

    const pending = migrations.filter((m) => !applied.includes(m.id));

    if (pending.length === 0) {
      console.log('[Market Migrations] No pending migrations');
      return;
    }

    console.log(`[Market Migrations] Running ${pending.length} pending migration(s)...`);

    for (const migration of pending) {
      console.log(
        `[Market Migrations] Running migration: ${migration.id} - ${migration.description}`
      );

      try {
        const applyMigration = db.transaction(() => {
          migration.up(db);
          markMarketMigrationApplied(db, migration.id, migration.description);
        });
        applyMigration();

        console.log(`[Market Migrations] Completed migration: ${migration.id}`);
      } catch (error) {
        console.error(`[Market Migrations] Migration ${migration.id} failed:`, error);
        throw error;
      }
    }

    console.log('[Market Migrations] All migrations completed successfully');
  } catch (error) {
    console.error('[Market Migrations] Error running migrations:', error);
    throw error;
  }
}

/**
 * Report which migrations are applied vs pending (for diagnostics UI).
 * @returns {{applied: string[], pending: string[], total: number}}
 */
function getMarketMigrationStatus() {
  try {
    const db = getMarketDatabase();
    initializeMarketMigrationsTable(db);

    const applied = getAppliedMarketMigrations(db);
    const pending = migrations.filter((m) => !applied.includes(m.id)).map((m) => m.id);

    return { applied, pending, total: migrations.length };
  } catch (error) {
    console.error('[Market Migrations] Error getting status:', error);
    return { applied: [], pending: [], total: migrations.length };
  }
}

module.exports = {
  needsMarketSchemaMigrations,
  runMarketSchemaMigrations,
  getMarketMigrationStatus,
  // Export for testing
  migrations,
};
