/**
 * Blueprint source bootstrap - the paths that must never leave a user with
 * NO blueprint sources.
 *
 * Migration 026 seeds existing installs, but it cannot help anyone whose state
 * is created afterwards, and it only UPDATEs rows that already exist. Several
 * routes therefore end with "characters exist, nothing is enabled", where every
 * blueprint resolves ME 0 with nothing on screen explaining why:
 *
 *   1. brand-new user      - migration runs before any character exists
 *   2. existing user with a default character but no character_settings row
 *      (those rows were historically created lazily, only when someone edited
 *      division settings)
 *   3. new manufacturing plan - inserted without blueprint source columns
 *   4. the default character is deleted, or its default status cleared
 *
 * These tests pin each route. They are deliberately about STATE, not UI.
 */

const Database = require('better-sqlite3');

let db;

// settings-manager destructures getCharacterDatabase at module load, so the
// mock has to be in place before it is required - each test requires it
// lazily, after beforeEach has installed the database.
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: () => global.__bootstrapDb,
}));

/** Schema after migration 026. */
function makeDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE characters (
      character_id INTEGER PRIMARY KEY,
      character_name TEXT,
      added_at INTEGER
    );
    CREATE TABLE character_settings (
      character_id INTEGER PRIMARY KEY,
      enabled_divisions TEXT NOT NULL DEFAULT '[]',
      division_names TEXT,
      division_names_fetched_at INTEGER,
      division_names_cache_expires_at INTEGER,
      use_blueprints_from INTEGER NOT NULL DEFAULT 0,
      blueprint_enabled_divisions TEXT NOT NULL DEFAULT '[]'
    );
  `);
  return database;
}

beforeEach(() => {
  db = makeDatabase();
  global.__bootstrapDb = db;

  // The public setters refuse to write for a character that does not exist, so
  // seed the ones these tests use. Character 999 is deliberately NOT seeded -
  // the guard tests need an id that is absent.
  const insert = db.prepare('INSERT INTO characters VALUES (?, ?, ?)');
  insert.run(111, 'Pilot One', 1000);
  insert.run(222, 'Pilot Two', 2000);
});

afterEach(() => {
  db.close();
  delete global.__bootstrapDb;
  jest.resetModules();
});

describe('ensureCharacterSettingsRow', () => {
  test('creates a row that did not exist', () => {
    const { ensureCharacterSettingsRow } = require('../../src/main/settings-manager');

    ensureCharacterSettingsRow(111);

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row).toBeDefined();
    expect(row.use_blueprints_from).toBe(0);
    expect(row.blueprint_enabled_divisions).toBe('[]');
  });

  test('opts the row in when asked', () => {
    const { ensureCharacterSettingsRow } = require('../../src/main/settings-manager');

    ensureCharacterSettingsRow(111, { useBlueprintsFrom: true });

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row.use_blueprints_from).toBe(1);
    // Corp divisions are ALWAYS opt-in, even for the first character.
    expect(row.blueprint_enabled_divisions).toBe('[]');
  });

  test('never overwrites an existing row', () => {
    // A user who deliberately turned their default character OFF must not have
    // it silently turned back on by a later call.
    const { ensureCharacterSettingsRow } = require('../../src/main/settings-manager');
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions, use_blueprints_from, blueprint_enabled_divisions)
      VALUES (?, '[]', 0, '[3]')
    `).run(111);

    ensureCharacterSettingsRow(111, { useBlueprintsFrom: true });

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row.use_blueprints_from).toBe(0);
    expect(row.blueprint_enabled_divisions).toBe('[3]');
  });
});

describe('getBlueprintSources', () => {
  test('returns only characters that are enabled', () => {
    const { getBlueprintSources, setUseBlueprintsFrom } = require('../../src/main/settings-manager');
    setUseBlueprintsFrom(111, true);
    setUseBlueprintsFrom(222, false);

    const sources = getBlueprintSources();
    expect(sources.characterIds).toEqual([111]);
  });

  test('carries each character\'s own divisions', () => {
    const {
      getBlueprintSources,
      setUseBlueprintsFrom,
      setBlueprintEnabledDivisions,
    } = require('../../src/main/settings-manager');

    setUseBlueprintsFrom(111, true);
    setBlueprintEnabledDivisions(111, [2, 5]);

    const sources = getBlueprintSources();
    expect(sources.divisionsByCharacter[111]).toEqual([2, 5]);
  });

  test('drops invalid division ids', () => {
    const {
      getBlueprintSources,
      setUseBlueprintsFrom,
      setBlueprintEnabledDivisions,
    } = require('../../src/main/settings-manager');

    setUseBlueprintsFrom(111, true);
    setBlueprintEnabledDivisions(111, [0, 3, 8, 99, -1]);

    // EVE has exactly seven corp hangar divisions.
    expect(getBlueprintSources().divisionsByCharacter[111]).toEqual([3]);
  });

  test('survives an unparseable divisions column', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { getBlueprintSources } = require('../../src/main/settings-manager');
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions, use_blueprints_from, blueprint_enabled_divisions)
      VALUES (?, '[]', 1, 'not json')
    `).run(111);

    const sources = getBlueprintSources();

    // The character still counts as a source (personal blueprints work); only
    // its corp divisions are treated as none.
    expect(sources.characterIds).toEqual([111]);
    expect(sources.divisionsByCharacter[111]).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  test('an empty result is distinguishable from an error', () => {
    const { getBlueprintSources } = require('../../src/main/settings-manager');
    expect(getBlueprintSources()).toEqual({ characterIds: [], divisionsByCharacter: {} });
  });
});

describe('setUseBlueprintsFrom', () => {
  test('creates the row when one does not exist yet', () => {
    // Route 2: characters whose settings row was never created lazily.
    const { setUseBlueprintsFrom } = require('../../src/main/settings-manager');

    setUseBlueprintsFrom(111, true);

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row.use_blueprints_from).toBe(1);
  });

  test('toggles an existing row without disturbing its divisions', () => {
    const {
      setUseBlueprintsFrom,
      setBlueprintEnabledDivisions,
    } = require('../../src/main/settings-manager');

    setBlueprintEnabledDivisions(111, [4]);
    setUseBlueprintsFrom(111, true);
    setUseBlueprintsFrom(111, false);

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row.use_blueprints_from).toBe(0);
    expect(row.blueprint_enabled_divisions).toBe('[4]');
  });
});

describe('guarded vs _Unsafe setters', () => {
  // Writing settings for a character that does not exist leaves an orphan row
  // no UI shows and nothing cleans up, and usually means a wrong id was passed.
  // The public setters refuse; the _Unsafe variants stay available for
  // bootstrap paths that legitimately write outside the normal lifecycle.

  const GUARDED = [
    ['setUseBlueprintsFrom', (m) => m.setUseBlueprintsFrom(999, true)],
    ['setBlueprintEnabledDivisions', (m) => m.setBlueprintEnabledDivisions(999, [1])],
    ['updateCharacterEnabledDivisions', (m) => m.updateCharacterEnabledDivisions(999, [1])],
  ];

  test.each(GUARDED)('%s refuses when the character does not exist', (_name, call) => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const manager = require('../../src/main/settings-manager');

    expect(call(manager)).toBe(false);
    expect(
      db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(999)
    ).toBeUndefined();
    expect(errors).toHaveBeenCalled();

    errors.mockRestore();
  });

  test.each(GUARDED)('%s succeeds once the character exists', (_name, call) => {
    const manager = require('../../src/main/settings-manager');
    db.prepare('INSERT INTO characters VALUES (?, ?, ?)').run(999, 'Real Pilot', Date.now());

    expect(call(manager)).toBe(true);
  });

  const UNSAFE = [
    ['setUseBlueprintsFrom_Unsafe', (m) => m.setUseBlueprintsFrom_Unsafe(999, true)],
    ['setBlueprintEnabledDivisions_Unsafe', (m) => m.setBlueprintEnabledDivisions_Unsafe(999, [1])],
    ['updateCharacterEnabledDivisions_Unsafe', (m) => m.updateCharacterEnabledDivisions_Unsafe(999, [1])],
  ];

  test.each(UNSAFE)('%s writes without the existence check', (_name, call) => {
    const manager = require('../../src/main/settings-manager');

    expect(call(manager)).toBe(true);
    expect(
      db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(999)
    ).toBeDefined();
  });

  test('the guard delegates to the unsafe implementation', () => {
    // Same write, one just checks first - so behaviour cannot drift between
    // the two variants.
    const manager = require('../../src/main/settings-manager');

    manager.setBlueprintEnabledDivisions(111, [2, 4]);
    const viaGuarded = db
      .prepare('SELECT blueprint_enabled_divisions FROM character_settings WHERE character_id = ?')
      .get(111).blueprint_enabled_divisions;

    manager.setBlueprintEnabledDivisions_Unsafe(222, [2, 4]);
    const viaUnsafe = db
      .prepare('SELECT blueprint_enabled_divisions FROM character_settings WHERE character_id = ?')
      .get(222).blueprint_enabled_divisions;

    expect(viaGuarded).toBe(viaUnsafe);
  });

  test('characterExists reports accurately', () => {
    const { characterExists } = require('../../src/main/settings-manager');

    expect(characterExists(111)).toBe(true);
    expect(characterExists(999)).toBe(false);
  });
});

describe('getCharacterBlueprintSettings', () => {
  test('reports a character with no row as opted out', () => {
    // The Settings UI renders a row for EVERY character, including ones with
    // no stored settings - it cannot use getBlueprintSources, which returns
    // only the enabled ones.
    const { getCharacterBlueprintSettings } = require('../../src/main/settings-manager');

    expect(getCharacterBlueprintSettings(111)).toEqual({
      useBlueprintsFrom: false,
      enabledDivisions: [],
    });
  });

  test('reports the stored values', () => {
    const {
      getCharacterBlueprintSettings,
      setUseBlueprintsFrom,
      setBlueprintEnabledDivisions,
    } = require('../../src/main/settings-manager');

    setUseBlueprintsFrom(111, true);
    setBlueprintEnabledDivisions(111, [2, 6]);

    expect(getCharacterBlueprintSettings(111)).toEqual({
      useBlueprintsFrom: true,
      enabledDivisions: [2, 6],
    });
  });

  test('survives an unparseable divisions column', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { getCharacterBlueprintSettings } = require('../../src/main/settings-manager');
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions, use_blueprints_from, blueprint_enabled_divisions)
      VALUES (?, '[]', 1, '{oops')
    `).run(111);

    const settings = getCharacterBlueprintSettings(111);
    expect(settings.useBlueprintsFrom).toBe(true);
    expect(settings.enabledDivisions).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('the two axes are independent', () => {
  // The core invariant of this feature: a corp may keep BPOs in a library
  // division while materials live in a production division, so neither axis
  // may ever write the other's column.

  test('changing blueprint divisions never touches the asset divisions', () => {
    const {
      setBlueprintEnabledDivisions,
      updateCharacterEnabledDivisions,
    } = require('../../src/main/settings-manager');

    expect(updateCharacterEnabledDivisions(111, [1, 2])).toBe(true);
    setBlueprintEnabledDivisions(111, [5]);

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row.enabled_divisions).toBe('[1,2]');
    expect(row.blueprint_enabled_divisions).toBe('[5]');
  });

  test('changing asset divisions never touches the blueprint divisions', () => {
    const {
      setBlueprintEnabledDivisions,
      updateCharacterEnabledDivisions,
    } = require('../../src/main/settings-manager');


    setBlueprintEnabledDivisions(111, [5]);
    expect(updateCharacterEnabledDivisions(111, [1, 2])).toBe(true);

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    expect(row.enabled_divisions).toBe('[1,2]');
    expect(row.blueprint_enabled_divisions).toBe('[5]');
  });

  test('turning the character off leaves its divisions intact', () => {
    // Re-enabling should restore the previous selection rather than starting
    // from nothing.
    const {
      setUseBlueprintsFrom,
      setBlueprintEnabledDivisions,
      getCharacterBlueprintSettings,
    } = require('../../src/main/settings-manager');

    setBlueprintEnabledDivisions(111, [3, 4]);
    setUseBlueprintsFrom(111, true);
    setUseBlueprintsFrom(111, false);

    expect(getCharacterBlueprintSettings(111).enabledDivisions).toEqual([3, 4]);

    setUseBlueprintsFrom(111, true);
    expect(getCharacterBlueprintSettings(111)).toEqual({
      useBlueprintsFrom: true,
      enabledDivisions: [3, 4],
    });
  });
});

describe('setBlueprintEnabledDivisions', () => {
  test('does not implicitly enable the character', () => {
    // Ticking a division for a character who is not a blueprint source must
    // not silently opt them in - the two axes are independent.
    const {
      setBlueprintEnabledDivisions,
      getBlueprintSources,
    } = require('../../src/main/settings-manager');

    setBlueprintEnabledDivisions(111, [1]);

    expect(getBlueprintSources().characterIds).toEqual([]);
  });

  test('is independent of the ASSET divisions column', () => {
    const { setBlueprintEnabledDivisions } = require('../../src/main/settings-manager');
    db.prepare(`
      INSERT INTO character_settings (character_id, enabled_divisions) VALUES (?, '[1,2]')
    `).run(111);

    setBlueprintEnabledDivisions(111, [7]);

    const row = db.prepare('SELECT * FROM character_settings WHERE character_id = ?').get(111);
    // Enabling a division for blueprints must not touch the asset config.
    expect(row.enabled_divisions).toBe('[1,2]');
    expect(row.blueprint_enabled_divisions).toBe('[7]');
  });
});
