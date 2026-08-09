/**
 * Migration parity + safety tests for the MARKET database (market-data.db).
 *
 * Purpose: market-data.db previously had no migration system - every table came
 * from an idempotent CREATE TABLE IF NOT EXISTS in market-database.js. That is
 * fine for adding tables but silently does nothing when an existing table needs
 * a new column or index. market-schema-migrations.js adds the same numbered,
 * tracked system the character DB uses; these tests are its safety net.
 *
 * Strategy mirrors tests/integration/migration-parity.test.js:
 *  1. A golden schema snapshot is captured the first time this runs (written to
 *     market-migration-parity.golden.json and committed). Afterwards the test
 *     asserts the produced schema matches that baseline exactly.
 *  2. A "legacy DB" (baseline tables only, no schema_migrations at all -
 *     exactly what shipped before this system existed) is run through the real
 *     startup path and must converge to the same golden schema AND record every
 *     numbered migration id.
 *  3. Migrations must be idempotent: running them twice changes nothing and
 *     does not double-record.
 *
 * NOTE: If you intentionally change market schema, regenerate the golden with
 * the manager script rather than hand-editing or deleting it:
 *
 *   bin/migration-golden.sh regenerate market
 *   bin/migration-golden.sh promote market
 *
 * It captures a candidate into a temp file, shows the diff for review, and only
 * then overwrites the committed golden. Pass `market` — the default is the
 * character database, which has a separate golden and separate numbering.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const GOLDEN_PATH =
  process.env.MARKET_MIGRATION_GOLDEN_PATH ||
  path.join(__dirname, 'market-migration-parity.golden.json');

/**
 * Capture a normalized, deterministic schema snapshot. Identical shape to the
 * character DB parity test so the two snapshots are comparable by eye.
 */
function snapshotSchema(db) {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((r) => r.name);

  const schema = {};
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        dflt_value: c.dflt_value,
        pk: c.pk,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const indexes = db
      .prepare(`PRAGMA index_list(${table})`)
      .all()
      .map((idx) => {
        const cols = db
          .prepare(`PRAGMA index_info(${idx.name})`)
          .all()
          .sort((a, b) => a.seqno - b.seqno)
          .map((ic) => ic.name);
        return { name: idx.name, unique: idx.unique, columns: cols };
      })
      .filter((idx) => !idx.name.startsWith('sqlite_autoindex'))
      .sort((a, b) => a.name.localeCompare(b.name));

    schema[table] = { columns, indexes };
  }
  return schema;
}

/**
 * Build a market DB through the real startup path (initializeMarketDatabase +
 * numbered migrations), with the config dir pointed at a temp directory.
 */
async function buildViaStartupPath(tempDir, { preSeed, runTwice = false } = {}) {
  let result;
  await new Promise((resolve, reject) => {
    jest.isolateModules(async () => {
      try {
        const configMigration = require('../../src/main/config-migration');
        configMigration.getConfigDir = jest.fn(() => tempDir);
        configMigration.getMarketDbPath = jest.fn(() =>
          path.join(tempDir, 'market-data.db')
        );

        const {
          initializeMarketDatabase,
          getMarketDatabase,
          closeMarketDatabase,
        } = require('../../src/main/market-database');

        if (preSeed) {
          const seedDb = new Database(path.join(tempDir, 'market-data.db'));
          preSeed(seedDb);
          seedDb.close();
        }

        initializeMarketDatabase();

        const {
          runMarketSchemaMigrations,
        } = require('../../src/main/market-schema-migrations');
        await runMarketSchemaMigrations();
        if (runTwice) {
          await runMarketSchemaMigrations();
        }

        const db = getMarketDatabase();
        const schema = snapshotSchema(db);
        const applied = db
          .prepare('SELECT id FROM schema_migrations ORDER BY id')
          .all()
          .map((r) => r.id);
        const appliedRowCount = db
          .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
          .get().n;

        result = { schema, applied, appliedRowCount };
        closeMarketDatabase();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
  return result;
}

describe('Market DB migration parity', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantum-mktparity-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    jest.resetModules();
  });

  test('fresh startup path matches the golden schema snapshot', async () => {
    const { schema } = await buildViaStartupPath(tempDir);

    if (!fs.existsSync(GOLDEN_PATH)) {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(schema, null, 2) + '\n');
      console.warn(
        `[market-migration-parity] Golden schema captured at ${GOLDEN_PATH}. ` +
          'Commit this file. Re-run to assert against it.'
      );
    }

    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    expect(schema).toEqual(golden);
  });

  test('legacy DB with no schema_migrations table converges to golden schema', async () => {
    // Exactly what shipped before this system existed: baseline tables created
    // by createTables(), and NO schema_migrations table whatsoever.
    const preSeed = (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS price_overrides (
          type_id INTEGER PRIMARY KEY,
          price REAL NOT NULL,
          notes TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
    };

    const { schema, applied } = await buildViaStartupPath(tempDir, { preSeed });

    // Matches the character parity test: if the golden has not been captured
    // yet, fall back to self-comparison so this reports the real problem
    // instead of throwing ENOENT.
    const golden = fs.existsSync(GOLDEN_PATH)
      ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'))
      : schema;
    expect(schema).toEqual(golden);

    // Every declared migration must be recorded.
    const {
      migrations,
    } = require('../../src/main/market-schema-migrations');
    expect(applied.sort()).toEqual(migrations.map((m) => m.id).sort());
  });

  test('pre-existing market data survives migration', async () => {
    const preSeed = (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS price_overrides (
          type_id INTEGER PRIMARY KEY,
          price REAL NOT NULL,
          notes TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      db.prepare(
        'INSERT INTO price_overrides (type_id, price, notes, updated_at) VALUES (?, ?, ?, ?)'
      ).run(34, 5.5, 'seeded', 1700000000000);
    };

    await buildViaStartupPath(tempDir, { preSeed });

    const db = new Database(path.join(tempDir, 'market-data.db'));
    const row = db.prepare('SELECT * FROM price_overrides WHERE type_id = 34').get();
    db.close();

    expect(row).toMatchObject({ type_id: 34, price: 5.5, notes: 'seeded' });
  });

  test('migrations are idempotent - running twice does not double-record', async () => {
    const { applied, appliedRowCount } = await buildViaStartupPath(tempDir, {
      runTwice: true,
    });

    const {
      migrations,
    } = require('../../src/main/market-schema-migrations');
    expect(applied.sort()).toEqual(migrations.map((m) => m.id).sort());
    expect(appliedRowCount).toBe(migrations.length);
  });

  test('migration 001 creates the watchlist tables with expected structure', async () => {
    const { schema } = await buildViaStartupPath(tempDir);

    expect(schema).toHaveProperty('market_watchlists');
    expect(schema).toHaveProperty('market_watchlist_items');
    expect(schema).toHaveProperty('market_favorites');

    const itemCols = schema.market_watchlist_items.columns.map((c) => c.name);

    // Anchored baseline: captured once when the item is added, moved only by
    // an explicit re-baseline. Drift is measured from it.
    expect(itemCols).toEqual(
      expect.arrayContaining(['watchlist_id', 'type_id', 'base_buy', 'base_sell', 'baseline_at'])
    );

    // Buy and sell carry INDEPENDENT rules and independent debounce stamps.
    ['buy', 'sell'].forEach((side) => {
      expect(itemCols).toEqual(
        expect.arrayContaining([
          `${side}_alert_type`,
          `${side}_alert_direction`,
          `${side}_alert_value`,
          `last_${side}_alert_at`,
        ])
      );
    });

    // The single-rule columns are gone, not merely supplemented.
    expect(itemCols).not.toContain('alert_type');
    expect(itemCols).not.toContain('last_price');

    // Market set ids are opaque strings, so this must not be INTEGER.
    const setIdCol = schema.market_watchlists.columns.find((c) => c.name === 'market_set_id');
    expect(setIdCol.type).toBe('TEXT');
  });

  test('migration ids are unique and ordered', () => {
    const {
      migrations,
    } = require('../../src/main/market-schema-migrations');

    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);

    for (const migration of migrations) {
      expect(typeof migration.description).toBe('string');
      expect(migration.description.length).toBeGreaterThan(0);
      expect(typeof migration.up).toBe('function');
    }
  });
});
