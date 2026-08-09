/**
 * A gated ESI fetch must NEVER destroy stored data.
 *
 * THE BUG (user-reported 2026-08-06, real data loss):
 * Clicking "Refresh from API" twice inside the 5-minute skills cache window
 * wiped every skill for the character, and the wipe persisted across restarts.
 *
 * The chain:
 *   1. esiFetch declines to call - the per-endpoint gate, the error-budget
 *      reserve, or a 420 - and returns `{ skipped: true }`.
 *   2. fetchCharacterSkills turns that into a NORMAL-LOOKING payload:
 *      `{ totalSp: 0, skills: {}, skipped: true }`.
 *   3. updateCharacterSkills is a DELETE-then-INSERT. Handed an empty payload
 *      it deletes every skill and stamps total_sp = 0.
 *   4. The handler ignored `.skipped` and reported success, so the UI said
 *      "refreshed" over data it had just destroyed.
 *
 * The background refresh cycle checked `.skipped`; the direct fetch handlers
 * did not. These tests pin the guard at the WRITER, where it protects every
 * caller rather than just the ones that remember.
 *
 * Assets and blueprints share the same delete-then-insert shape, so they are
 * covered too - but guarded on `skipped` ONLY, because an empty hangar or zero
 * blueprints is a legitimate state that must stay reachable.
 */

const Database = require('better-sqlite3');

let mockDb;
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: () => mockDb,
}));

const CHARACTER_ID = 1194303072;

/** A populated character, as it looks before a bad refresh. */
function seed() {
  mockDb.exec(`
    CREATE TABLE characters (character_id INTEGER PRIMARY KEY, character_name TEXT);
    CREATE TABLE skills (
      character_id INTEGER NOT NULL,
      skill_id INTEGER NOT NULL,
      active_skill_level INTEGER NOT NULL,
      trained_skill_level INTEGER NOT NULL,
      skillpoints_in_skill INTEGER NOT NULL,
      PRIMARY KEY (character_id, skill_id)
    );
    CREATE TABLE skills_metadata (
      character_id INTEGER PRIMARY KEY,
      total_sp INTEGER, unallocated_sp INTEGER,
      last_updated INTEGER, cache_expires_at INTEGER
    );
    -- Copied VERBATIM from the live schema. An abbreviated fixture silently
    -- broke this suite: the insert binds 18 columns, so a 12-column table threw
    -- inside the transaction and the ROLLBACK restored the seeded row - which
    -- looked exactly like the guard refusing the write.
    -- NOTE item_id is TEXT, not INTEGER.
    CREATE TABLE blueprints (
      character_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      corporation_id INTEGER,
      location_id INTEGER,
      location_flag TEXT,
      quantity INTEGER NOT NULL,
      time_efficiency INTEGER,
      material_efficiency INTEGER,
      runs INTEGER,
      is_copy INTEGER DEFAULT 0,
      is_corporation INTEGER DEFAULT 0,
      source TEXT NOT NULL,
      manually_added INTEGER DEFAULT 0,
      fetched_at INTEGER,
      last_updated INTEGER NOT NULL,
      cache_expires_at INTEGER,
      PRIMARY KEY (character_id, item_id)
    );
  `);

  mockDb.prepare('INSERT INTO characters VALUES (?, ?)').run(CHARACTER_ID, 'Buckwalter');

  const insert = mockDb.prepare('INSERT INTO skills VALUES (?, ?, ?, ?, ?)');
  [[3380, 5, 256000], [3388, 4, 452000], [3402, 5, 256000]].forEach(([id, lvl, sp]) => {
    insert.run(CHARACTER_ID, id, lvl, lvl, sp);
  });

  mockDb.prepare('INSERT INTO skills_metadata VALUES (?, ?, ?, ?, ?)')
    .run(CHARACTER_ID, 84200000, 0, Date.now(), null);

  // item_id as TEXT, matching how the live table stores it.
  mockDb.prepare(`
    INSERT INTO blueprints
      (character_id, item_id, type_id, quantity, source, last_updated)
    VALUES (?, ?, ?, ?, 'esi', ?)
  `).run(CHARACTER_ID, '1001', 22545, 1, Date.now());
}

function skillCount() {
  return mockDb.prepare('SELECT COUNT(*) AS n FROM skills WHERE character_id = ?')
    .get(CHARACTER_ID).n;
}

function totalSp() {
  return mockDb.prepare('SELECT total_sp AS sp FROM skills_metadata WHERE character_id = ?')
    .get(CHARACTER_ID).sp;
}

let settingsManager;

beforeEach(() => {
  jest.resetModules();
  mockDb = new Database(':memory:');
  seed();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  settingsManager = require('../../src/main/settings-manager');
});

afterEach(() => {
  mockDb.close();
  jest.restoreAllMocks();
});

describe('skills: a gated fetch must not wipe stored skills', () => {
  /** Exactly what fetchCharacterSkills returns when esiFetch declines. */
  const GATED = {
    totalSp: 0,
    unallocatedSp: 0,
    skills: {},
    lastUpdated: Date.now(),
    cacheExpiresAt: null,
    skipped: true,
  };

  test('the reported bug: a gated refresh leaves the skills intact', async () => {
    expect(skillCount()).toBe(3);

    settingsManager.updateCharacterSkills(CHARACTER_ID, GATED);

    expect(skillCount()).toBe(3);
    expect(totalSp()).toBe(84200000);
  });

  test('it reports failure so the caller cannot claim a refresh', () => {
    expect(settingsManager.updateCharacterSkills(CHARACTER_ID, GATED)).toBe(false);
  });

  test('total_sp is not stamped to 0', () => {
    // The visible symptom: the header read "Total SP: 0".
    settingsManager.updateCharacterSkills(CHARACTER_ID, GATED);
    expect(totalSp()).toBe(84200000);
  });

  test('an empty payload WITHOUT the skipped flag is also refused', () => {
    // Guarding on the data, not just the flag, covers an ESI 200 that carries
    // nothing and any caller that forgets to propagate `skipped`. No capsuleer
    // has zero skills, so an empty set is always wrong.
    const empty = { totalSp: 0, skills: {}, lastUpdated: Date.now() };

    expect(settingsManager.updateCharacterSkills(CHARACTER_ID, empty)).toBe(false);
    expect(skillCount()).toBe(3);
  });

  test('a REAL payload still writes normally', () => {
    // The guard must not block the thing it is protecting.
    const real = {
      totalSp: 90000000,
      unallocatedSp: 0,
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
      skills: {
        3380: { skillId: 3380, activeSkillLevel: 5, trainedSkillLevel: 5, skillpointsInSkill: 256000 },
        3388: { skillId: 3388, activeSkillLevel: 5, trainedSkillLevel: 5, skillpointsInSkill: 512000 },
      },
    };

    expect(settingsManager.updateCharacterSkills(CHARACTER_ID, real)).toBe(true);
    expect(skillCount()).toBe(2);
    expect(totalSp()).toBe(90000000);
  });

  test('a real payload REPLACES the old set rather than merging', () => {
    // The delete-then-insert is deliberate: a skill can never be untrained, but
    // the write must still reflect exactly what ESI returned.
    const real = {
      totalSp: 1000,
      skills: {
        9999: { skillId: 9999, activeSkillLevel: 1, trainedSkillLevel: 1, skillpointsInSkill: 500 },
      },
    };

    settingsManager.updateCharacterSkills(CHARACTER_ID, real);

    expect(skillCount()).toBe(1);
    expect(
      mockDb.prepare('SELECT skill_id FROM skills WHERE character_id = ?').get(CHARACTER_ID).skill_id
    ).toBe(9999);
  });
});

describe('blueprints: gated fetches are refused, empty ones are not', () => {
  test('a gated fetch leaves stored blueprints intact', () => {
    const before = mockDb.prepare('SELECT COUNT(*) AS n FROM blueprints').get().n;

    const result = settingsManager.updateCharacterBlueprints(CHARACTER_ID, {
      blueprints: [], skipped: true,
    });

    expect(result).toBe(false);
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM blueprints').get().n).toBe(before);
  });

  test('a genuinely empty result IS written - zero blueprints is legitimate', () => {
    // Unlike skills, a character can really own none (new, or sold them all).
    // Refusing every empty write would make that state unreachable.
    const result = settingsManager.updateCharacterBlueprints(CHARACTER_ID, {
      blueprints: [], lastUpdated: Date.now(),
    });

    // Assert the write REPORTED success, not just that rows are gone - a
    // throw-and-rollback also leaves a plausible-looking table, which is what
    // masked a broken fixture here.
    expect(result).toBe(true);
    expect(
      mockDb.prepare("SELECT COUNT(*) AS n FROM blueprints WHERE source = 'esi'").get().n
    ).toBe(0);
  });
});
