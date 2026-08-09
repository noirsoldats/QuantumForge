/**
 * Migration 026 - blueprint source columns and their backfill.
 *
 * The backfill must reproduce TODAY's behaviour exactly - no wider, no
 * narrower:
 *
 *   global characters -> ONLY accounts.defaultCharacterId. The calculator
 *       resolves ME through esi.getDefaultCharacter(); there is exactly one.
 *   plan characters   -> ONLY that plan's own character_id. Plan intermediates
 *       resolve against the plan's owning character.
 *   divisions         -> EMPTY everywhere, making corp blueprints opt-in.
 *
 * Two wrong sources were specifically rejected and are asserted against here,
 * because both would silently WIDEN blueprint sources beyond today:
 *
 *   - industry.defaultManufacturingCharacters (governs ASSETS, never
 *     blueprints)
 *   - a plan's default_characters_json (also assets)
 */

const Database = require('better-sqlite3');

const MIGRATION_ID = '026_blueprint_sources';

// Jest keeps its own module registry, so poking require.cache does NOT change
// what the migration's lazy `require('./settings-manager')` resolves to - it
// silently got the real module, whose loadSettings returns nothing useful in a
// test process. The migration swallows that (by design: a config read must not
// fail the schema change), so the seeding simply did nothing and the failure
// looked like a migration bug rather than a test-harness bug.
//
// jest.mock is hoisted and replaces the module in Jest's registry, which is
// what the migration actually sees.
let mockSettings = { accounts: {}, industry: {} };
jest.mock('../../src/main/settings-manager', () => ({
  loadSettings: () => {
    if (mockSettings === 'throw') throw new Error('config unreadable');
    return mockSettings;
  },
}));

/** Pre-026 schema, matching migrations 013/014. */
function makeDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      character_id INTEGER PRIMARY KEY,
      character_name TEXT
    );
    CREATE TABLE character_settings (
      character_id INTEGER PRIMARY KEY,
      enabled_divisions TEXT NOT NULL DEFAULT '[]',
      division_names TEXT,
      division_names_fetched_at INTEGER,
      division_names_cache_expires_at INTEGER
    );
    CREATE TABLE manufacturing_plans (
      plan_id TEXT PRIMARY KEY,
      character_id INTEGER
    );
    CREATE TABLE plan_industry_settings (
      plan_id TEXT PRIMARY KEY,
      enabled_divisions_json TEXT NOT NULL DEFAULT '{}',
      default_characters_json TEXT NOT NULL DEFAULT '[]',
      reactions_as_intermediates INTEGER DEFAULT 0,
      last_updated INTEGER NOT NULL
    );
  `);
  return db;
}

function seedFixture(db) {
  const char = db.prepare('INSERT INTO characters VALUES (?, ?)');
  char.run(111, 'Buckwalter');
  char.run(222, 'Alt Pilot');
  char.run(333, 'Never Configured');

  const settings = db.prepare(
    'INSERT INTO character_settings (character_id, enabled_divisions) VALUES (?, ?)'
  );
  // 111 uses corp divisions 1 and 2 for ASSETS.
  settings.run(111, '[1,2]');
  settings.run(222, '[3]');
  // 333 deliberately has NO character_settings row - the table is created on
  // demand, so this is the common real-world state.

  // plan-a is OWNED by 111 but lists 111 AND 222 as asset characters - the
  // case that catches seeding blueprints from the asset list.
  db.prepare('INSERT INTO manufacturing_plans VALUES (?, ?)').run('plan-a', 111);
  db.prepare('INSERT INTO plan_industry_settings VALUES (?, ?, ?, ?, ?)').run(
    'plan-a',
    '{"111":[1,2]}',
    '[111,222]',
    0,
    Date.now()
  );
  // plan-b is owned by 222 and has NO asset characters, so seeding from the
  // asset list would leave it empty when it should hold its owner.
  db.prepare('INSERT INTO manufacturing_plans VALUES (?, ?)').run('plan-b', 222);
  db.prepare('INSERT INTO plan_industry_settings VALUES (?, ?, ?, ?, ?)').run(
    'plan-b',
    '{}',
    '[]',
    0,
    Date.now()
  );
}

/**
 * Run migration 026.
 *
 * `defaultCharacterId` may be a character id, null, or the string 'throw' to
 * simulate an unreadable config. The mocked settings also expose an ASSET
 * character list that deliberately DIFFERS from the default character, so a
 * regression back to that source fails loudly instead of coincidentally
 * matching.
 */
function runMigration(db, defaultCharacterId) {
  mockSettings =
    defaultCharacterId === 'throw'
      ? 'throw'
      : {
          accounts: { defaultCharacterId },
          industry: { defaultManufacturingCharacters: [111, 222] },
        };

  const { migrations } = require('../../src/main/database-schema-migrations');
  const migration = migrations.find((m) => m.id === MIGRATION_ID);
  if (!migration) throw new Error(`${MIGRATION_ID} not found`);
  migration.up(db);
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe('migration 026 - blueprint sources', () => {
  let db;

  beforeEach(() => {
    db = makeDatabase();
    seedFixture(db);
  });

  afterEach(() => db.close());

  test('adds the four blueprint source columns', () => {
    runMigration(db, 111);

    const charCols = columns(db, 'character_settings');
    expect(charCols).toContain('use_blueprints_from');
    expect(charCols).toContain('blueprint_enabled_divisions');

    const planCols = columns(db, 'plan_industry_settings');
    expect(planCols).toContain('blueprint_characters_json');
    expect(planCols).toContain('blueprint_enabled_divisions_json');
  });

  test('leaves the existing asset columns untouched', () => {
    runMigration(db, 111);

    // The two axes are independent; the migration must not rewrite the asset
    // side while seeding from it.
    const rows = db
      .prepare('SELECT character_id, enabled_divisions FROM character_settings ORDER BY character_id')
      .all();
    expect(rows).toEqual([
      { character_id: 111, enabled_divisions: '[1,2]' },
      { character_id: 222, enabled_divisions: '[3]' },
    ]);

    const plan = db
      .prepare('SELECT default_characters_json, enabled_divisions_json FROM plan_industry_settings WHERE plan_id = ?')
      .get('plan-a');
    expect(plan.default_characters_json).toBe('[111,222]');
    expect(plan.enabled_divisions_json).toBe('{"111":[1,2]}');
  });

  test('seeds ONLY the app-level default character', () => {
    // Today the calculator resolves ME through esi.getDefaultCharacter(), so
    // exactly one character is a blueprint source after migrating.
    runMigration(db, 111);

    const enabled = db
      .prepare('SELECT use_blueprints_from FROM character_settings WHERE character_id = ?')
      .get(111);
    expect(enabled.use_blueprints_from).toBe(1);
  });

  test('does NOT seed from the asset character list', () => {
    // 222 is in defaultManufacturingCharacters but is NOT the default
    // character. That list governs assets and has never affected blueprint ME;
    // seeding from it would silently widen blueprint sources.
    runMigration(db, 111);

    const notSeeded = db
      .prepare('SELECT use_blueprints_from FROM character_settings WHERE character_id = ?')
      .get(222);
    expect(notSeeded.use_blueprints_from).toBe(0);
  });

  test('seeds nothing when there is no default character', () => {
    runMigration(db, null);

    const rows = db.prepare('SELECT use_blueprints_from FROM character_settings').all();
    for (const row of rows) {
      expect(row.use_blueprints_from).toBe(0);
    }
  });

  test('corp divisions start EMPTY for every character', () => {
    // The load-bearing assertion. Seeding these from enabled_divisions would
    // silently re-enable corp blueprints the user never opted into.
    runMigration(db, 111);

    const rows = db
      .prepare('SELECT character_id, blueprint_enabled_divisions FROM character_settings')
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.blueprint_enabled_divisions).toBe('[]');
    }
  });

  test('plan blueprint divisions start empty too', () => {
    runMigration(db, 111);

    const rows = db
      .prepare('SELECT plan_id, blueprint_enabled_divisions_json FROM plan_industry_settings')
      .all();
    for (const row of rows) {
      expect(row.blueprint_enabled_divisions_json).toBe('{}');
    }
  });

  test("seeds each plan's blueprint characters from its OWNING character", () => {
    // Plan intermediates resolve against plan.character_id, so that is what
    // the plan's blueprint source list must contain.
    runMigration(db, 111);

    const planA = db
      .prepare('SELECT blueprint_characters_json FROM plan_industry_settings WHERE plan_id = ?')
      .get('plan-a');
    // NOT [111,222] - that is plan-a's ASSET list, which includes an extra
    // character that never contributed blueprints.
    expect(JSON.parse(planA.blueprint_characters_json)).toEqual([111]);

    const planB = db
      .prepare('SELECT blueprint_characters_json FROM plan_industry_settings WHERE plan_id = ?')
      .get('plan-b');
    // plan-b has an EMPTY asset list but is owned by 222, so seeding from the
    // asset list would wrongly leave this empty.
    expect(JSON.parse(planB.blueprint_characters_json)).toEqual([222]);
  });

  test('a plan is seeded from itself, not from the global default character', () => {
    // The global default is 111; plan-b is owned by 222 and must not inherit
    // the global value.
    runMigration(db, 111);

    const planB = db
      .prepare('SELECT blueprint_characters_json FROM plan_industry_settings WHERE plan_id = ?')
      .get('plan-b');
    expect(JSON.parse(planB.blueprint_characters_json)).toEqual([222]);
  });

  test('a character with no settings row is not created by the migration', () => {
    // 333 has no character_settings row. Absent means "off", which is the
    // correct default - inventing a row here would be a silent opt-in.
    runMigration(db, 333);

    const row = db
      .prepare('SELECT * FROM character_settings WHERE character_id = ?')
      .get(333);
    expect(row).toBeUndefined();
  });

  test('is idempotent - running twice changes nothing', () => {
    runMigration(db, 111);
    const before = {
      characters: db.prepare('SELECT * FROM character_settings ORDER BY character_id').all(),
      plans: db.prepare('SELECT * FROM plan_industry_settings ORDER BY plan_id').all(),
    };

    expect(() => runMigration(db, 111)).not.toThrow();

    expect(db.prepare('SELECT * FROM character_settings ORDER BY character_id').all())
      .toEqual(before.characters);
    expect(db.prepare('SELECT * FROM plan_industry_settings ORDER BY plan_id').all())
      .toEqual(before.plans);
  });

  test('an unreadable config does not fail the migration', () => {
    // The columns matter more than the seeding: if the config cannot be read,
    // every character defaults to opted-out and the user ticks the boxes.
    // Losing the schema change over a config read would be worse.
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => runMigration(db, 'throw')).not.toThrow();

    expect(columns(db, 'character_settings')).toContain('use_blueprints_from');
    const row = db
      .prepare('SELECT use_blueprints_from FROM character_settings WHERE character_id = ?')
      .get(111);
    expect(row.use_blueprints_from).toBe(0);
    expect(errors).toHaveBeenCalled();

    errors.mockRestore();
  });

  test('a plan with no owning character is left empty', () => {
    db.prepare('INSERT INTO manufacturing_plans VALUES (?, ?)').run('plan-orphan', null);
    db.prepare('INSERT INTO plan_industry_settings VALUES (?, ?, ?, ?, ?)').run(
      'plan-orphan', '{}', '[]', 0, Date.now()
    );

    runMigration(db, 111);

    const orphan = db
      .prepare('SELECT blueprint_characters_json FROM plan_industry_settings WHERE plan_id = ?')
      .get('plan-orphan');
    expect(JSON.parse(orphan.blueprint_characters_json)).toEqual([]);
  });
});
