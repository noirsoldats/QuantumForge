/**
 * Migration parity + safety tests for the character database.
 *
 * Purpose (see plan "Migration System Cleanup"): the character DB historically
 * had TWO migration systems — untracked ad-hoc ALTER blocks inside
 * initializeCharacterDatabase() and the numbered/tracked system in
 * database-schema-migrations.js. We are folding the ad-hoc blocks into the
 * numbered system. These tests are the safety net that proves the fold does
 * not change the resulting schema and does not break already-migrated DBs.
 *
 * Strategy:
 *  1. A golden schema snapshot is captured from the CURRENT code the first time
 *     this test runs (written to migration-parity.golden.json and committed).
 *     After the refactor, the test asserts the produced schema is byte-for-byte
 *     identical to that golden baseline.
 *  2. A "legacy DB" (original base tables, empty schema_migrations, no ad-hoc
 *     columns) is run through the full startup path and must converge to the
 *     same golden schema AND record every numbered migration id.
 *  3. A data-normalization test for use_intermediates (INTEGER -> TEXT).
 *
 * NOTE: If you intentionally change the schema, delete the golden file and
 * re-run to regenerate it (and review the diff in code review).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

// The committed baseline. Override with MIGRATION_GOLDEN_PATH to write/compare a
// candidate file without clobbering the committed golden (used when intentionally
// regenerating the baseline after a reviewed schema change).
const GOLDEN_PATH =
  process.env.MIGRATION_GOLDEN_PATH ||
  path.join(__dirname, 'migration-parity.golden.json');

/**
 * Capture a normalized, deterministic schema snapshot of a better-sqlite3 DB.
 * Includes every user table's columns (name, type, notnull, dflt, pk) and its
 * indexes (name + indexed columns). Ordered so the JSON is stable across runs.
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
      // table_info is already cid-ordered; sort by name for order-independence
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
      // Ignore auto-indexes created for UNIQUE/PK (names start with sqlite_autoindex)
      .filter((idx) => !idx.name.startsWith('sqlite_autoindex'))
      .sort((a, b) => a.name.localeCompare(b.name));

    schema[table] = { columns, indexes };
  }
  return schema;
}

/**
 * Build a character DB through the real startup path (init + numbered
 * migrations), pointing the config dir at a temp directory. Returns the schema
 * snapshot and the list of applied migration ids, then closes the DB.
 */
async function buildViaStartupPath(tempDir, { preSeed } = {}) {
  let result;
  await new Promise((resolve, reject) => {
    jest.isolateModules(async () => {
      try {
        const configMigration = require('../../src/main/config-migration');
        configMigration.getConfigDir = jest.fn(() => tempDir);

        const {
          getCharacterDatabase,
          initializeCharacterDatabase,
          closeCharacterDatabase,
        } = require('../../src/main/character-database');

        // Optional: seed a pre-existing DB state (legacy simulation) before init.
        if (preSeed) {
          const seedDb = getCharacterDatabase();
          preSeed(seedDb);
        }

        initializeCharacterDatabase();

        const {
          runSchemaMigrations,
        } = require('../../src/main/database-schema-migrations');
        await runSchemaMigrations();

        const db = getCharacterDatabase();
        const schema = snapshotSchema(db);
        const applied = db
          .prepare('SELECT id FROM schema_migrations ORDER BY id')
          .all()
          .map((r) => r.id);

        result = { schema, applied };
        closeCharacterDatabase();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
  return result;
}

describe('Character DB migration parity', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantum-migparity-'));
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
      // First run (on current, pre-refactor code): capture the baseline.
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(schema, null, 2) + '\n');
      console.warn(
        `[migration-parity] Golden schema captured at ${GOLDEN_PATH}. ` +
          'Commit this file. Re-run to assert against it.'
      );
    }

    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    expect(schema).toEqual(golden);
  });

  test('legacy DB (original base tables, empty schema_migrations) converges to golden schema and records all migrations', async () => {
    // Simulate a DB that predates the numbered system: create only the ORIGINAL
    // base tables (no ad-hoc columns), with an empty schema_migrations table.
    // The startup path must upgrade it to the identical final schema.
    const preSeed = (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS manufacturing_plans (
          plan_id TEXT PRIMARY KEY,
          character_id INTEGER NOT NULL,
          plan_name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS plan_blueprints (
          plan_blueprint_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          blueprint_type_id INTEGER NOT NULL,
          runs INTEGER NOT NULL,
          lines INTEGER NOT NULL DEFAULT 1,
          me_level INTEGER NOT NULL,
          te_level INTEGER,
          facility_id TEXT,
          facility_snapshot TEXT,
          added_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
      `);
    };

    const { schema, applied } = await buildViaStartupPath(tempDir, { preSeed });

    const golden = fs.existsSync(GOLDEN_PATH)
      ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'))
      : schema; // if golden not yet captured, at least assert internal consistency below

    expect(schema).toEqual(golden);

    // Every numbered migration defined in the module must have been recorded.
    const {
      migrations,
    } = require('../../src/main/database-schema-migrations');
    const definedIds = migrations.map((m) => m.id).sort();
    expect(applied.sort()).toEqual(expect.arrayContaining(definedIds));
  });

  test('re-running the startup path applies no further migrations (idempotent)', async () => {
    // First pass creates + migrates.
    await buildViaStartupPath(tempDir);
    // Second pass against the SAME temp dir (same on-disk DB) must be a no-op
    // for tracked migrations: applied set unchanged, schema unchanged.
    const first = await buildViaStartupPath(tempDir);
    const second = await buildViaStartupPath(tempDir);
    expect(second.schema).toEqual(first.schema);
    expect(second.applied.sort()).toEqual(first.applied.sort());
  });
});

describe('use_intermediates normalization', () => {
  // These assert the intended data mapping for the normalization migration.
  // Mapping (confirmed with user): 1/truthy -> 'raw_materials', 0 -> 'components',
  // canonical TEXT values left untouched.
  function applyNormalization(db) {
    // Mirror of the migration's UPDATE logic; kept here so the data mapping is
    // asserted independently of migration wiring. The real migration lives in
    // database-schema-migrations.js and must produce the same result.
    db.exec(`
      UPDATE plan_blueprints
      SET use_intermediates = 'raw_materials'
      WHERE use_intermediates IN ('1', 1)
    `);
    db.exec(`
      UPDATE plan_blueprints
      SET use_intermediates = 'components'
      WHERE use_intermediates IN ('0', 0)
    `);
  }

  test('maps INTEGER values to canonical TEXT and leaves TEXT untouched', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE plan_blueprints (
        plan_blueprint_id TEXT PRIMARY KEY,
        use_intermediates
      );
    `);
    const insert = db.prepare(
      'INSERT INTO plan_blueprints (plan_blueprint_id, use_intermediates) VALUES (?, ?)'
    );
    insert.run('int-one', 1);
    insert.run('int-zero', 0);
    insert.run('txt-raw', 'raw_materials');
    insert.run('txt-components', 'components');
    insert.run('txt-buy', 'buy');
    insert.run('null-row', null);

    applyNormalization(db);

    const rows = Object.fromEntries(
      db
        .prepare('SELECT plan_blueprint_id, use_intermediates FROM plan_blueprints')
        .all()
        .map((r) => [r.plan_blueprint_id, r.use_intermediates])
    );

    expect(rows['int-one']).toBe('raw_materials');
    expect(rows['int-zero']).toBe('components');
    expect(rows['txt-raw']).toBe('raw_materials');
    expect(rows['txt-components']).toBe('components');
    expect(rows['txt-buy']).toBe('buy');
    // NULL means "default expand" per the reading code; leave it null.
    expect(rows['null-row']).toBeNull();

    db.close();
  });
});
