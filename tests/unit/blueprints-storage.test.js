/**
 * Unit Tests for Blueprint Storage with Composite Primary Key
 *
 * Tests the composite key functionality that allows multiple characters
 * in the same corporation to sync blueprints without PRIMARY KEY violations
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('Blueprint Storage with Composite Primary Key', () => {
  let testDbPath;
  let db;

  beforeAll(() => {
    // Create test database in temp directory
    testDbPath = path.join(os.tmpdir(), `test-blueprints-${Date.now()}.db`);
    db = new Database(testDbPath);

    // Create characters table
    db.exec(`
      CREATE TABLE characters (
        character_id INTEGER PRIMARY KEY,
        character_name TEXT NOT NULL,
        corporation_id INTEGER,
        alliance_id INTEGER,
        portrait TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        token_type TEXT DEFAULT 'Bearer',
        scopes TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create blueprints table with composite primary key
    db.exec(`
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
        PRIMARY KEY (character_id, item_id),
        FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
      )
    `);

    // Create blueprint_overrides table
    db.exec(`
      CREATE TABLE blueprint_overrides (
        character_id INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (character_id, item_id, field),
        FOREIGN KEY (character_id, item_id) REFERENCES blueprints(character_id, item_id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    db.exec(`
      CREATE INDEX idx_blueprints_character ON blueprints(character_id);
      CREATE INDEX idx_blueprints_type ON blueprints(type_id);
      CREATE INDEX idx_blueprints_source ON blueprints(character_id, source);
    `);

    // Insert test characters
    const insertChar = db.prepare(`
      INSERT INTO characters (
        character_id, character_name, corporation_id, access_token,
        refresh_token, expires_at, scopes, added_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    insertChar.run(1001, 'Character A', 2001, 'token1', 'refresh1', now + 3600000, 'scope1', now, now);
    insertChar.run(1002, 'Character B', 2001, 'token2', 'refresh2', now + 3600000, 'scope2', now, now); // Same corp
    insertChar.run(1003, 'Character C', 2002, 'token3', 'refresh3', now + 3600000, 'scope3', now, now); // Different corp
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
    if (testDbPath && fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(() => {
    // Clear blueprints before each test
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM blueprint_overrides').run();
  });

  describe('Composite Primary Key Functionality', () => {
    test('saves blueprints for single character', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Insert personal blueprint
      insert.run(
        1001, '1000001', 34, null, 60003760, 'Hangar', 1,
        0, 10, -1, 0, 0, 'esi', 0, Date.now(), Date.now(), null
      );

      const blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1001').all();
      expect(blueprints).toHaveLength(1);
      expect(blueprints[0].item_id).toBe('1000001');
      expect(blueprints[0].type_id).toBe(34);
    });

    test('saves blueprints for multiple characters with SAME item_ids (corp blueprints)', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const corpItemId = '2000001'; // Same corp blueprint item_id
      const now = Date.now();

      // Character A's corp blueprint
      insert.run(
        1001, corpItemId, 34, 2001, 60003760, 'CorpHangar', 1,
        0, 10, -1, 0, 1, 'esi', 0, now, now, null
      );

      // Character B's corp blueprint (SAME item_id, different character)
      insert.run(
        1002, corpItemId, 34, 2001, 60003760, 'CorpHangar', 1,
        0, 10, -1, 0, 1, 'esi', 0, now, now, null
      );

      // Verify both blueprints exist
      const allBlueprints = db.prepare('SELECT * FROM blueprints').all();
      expect(allBlueprints).toHaveLength(2);

      const char1Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1001').all();
      const char2Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1002').all();

      expect(char1Blueprints).toHaveLength(1);
      expect(char2Blueprints).toHaveLength(1);

      // Both have same item_id but different character_ids
      expect(char1Blueprints[0].item_id).toBe(corpItemId);
      expect(char2Blueprints[0].item_id).toBe(corpItemId);
      expect(char1Blueprints[0].character_id).toBe(1001);
      expect(char2Blueprints[0].character_id).toBe(1002);
    });

    test('DELETE with character_id only removes that character\'s blueprints', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const corpItemId = '2000001';
      const now = Date.now();

      // Both characters have the same corp blueprint
      insert.run(1001, corpItemId, 34, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null);
      insert.run(1002, corpItemId, 34, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null);

      // Delete Character A's ESI blueprints
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND source = ?').run(1001, 'esi');

      // Verify Character A's blueprints removed, Character B's intact
      const char1Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1001').all();
      const char2Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1002').all();

      expect(char1Blueprints).toHaveLength(0);
      expect(char2Blueprints).toHaveLength(1);
      expect(char2Blueprints[0].item_id).toBe(corpItemId);
    });

    test('UPDATE with character_id only affects that character\'s blueprints', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const corpItemId = '2000001';
      const now = Date.now();

      insert.run(1001, corpItemId, 34, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null);
      insert.run(1002, corpItemId, 34, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null);

      // Update Character A's blueprint ME
      db.prepare('UPDATE blueprints SET material_efficiency = ? WHERE character_id = ? AND item_id = ?')
        .run(5, 1001, corpItemId);

      const char1Blueprint = db.prepare('SELECT material_efficiency FROM blueprints WHERE character_id = 1001 AND item_id = ?')
        .get(corpItemId);
      const char2Blueprint = db.prepare('SELECT material_efficiency FROM blueprints WHERE character_id = 1002 AND item_id = ?')
        .get(corpItemId);

      expect(char1Blueprint.material_efficiency).toBe(5);
      expect(char2Blueprint.material_efficiency).toBe(10); // Unchanged
    });
  });

  describe('Blueprint Overrides with Composite Foreign Key', () => {
    beforeEach(() => {
      // Insert test blueprints
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      insert.run(1001, '1000001', 34, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'esi', 0, now, now, null);
      insert.run(1002, '1000001', 34, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'esi', 0, now, now, null);
    });

    test('sets override for specific character and blueprint', () => {
      db.prepare('INSERT INTO blueprint_overrides (character_id, item_id, field, value) VALUES (?, ?, ?, ?)')
        .run(1001, '1000001', 'materialEfficiency', '5');

      const override = db.prepare('SELECT * FROM blueprint_overrides WHERE character_id = 1001 AND item_id = ?')
        .get('1000001');

      expect(override).toBeDefined();
      expect(override.field).toBe('materialEfficiency');
      expect(override.value).toBe('5');
    });

    test('overrides for one character don\'t affect another character\'s same item_id', () => {
      // Set override for Character A
      db.prepare('INSERT INTO blueprint_overrides (character_id, item_id, field, value) VALUES (?, ?, ?, ?)')
        .run(1001, '1000001', 'materialEfficiency', '5');

      // Character A has override
      const char1Override = db.prepare('SELECT * FROM blueprint_overrides WHERE character_id = 1001 AND item_id = ?')
        .get('1000001');
      expect(char1Override).toBeDefined();

      // Character B does not have override
      const char2Override = db.prepare('SELECT * FROM blueprint_overrides WHERE character_id = 1002 AND item_id = ?')
        .get('1000001');
      expect(char2Override).toBeUndefined();
    });

    test('CASCADE DELETE removes overrides when blueprint deleted', () => {
      db.prepare('INSERT INTO blueprint_overrides (character_id, item_id, field, value) VALUES (?, ?, ?, ?)')
        .run(1001, '1000001', 'materialEfficiency', '5');

      // Delete blueprint
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND item_id = ?').run(1001, '1000001');

      // Override should be cascade deleted
      const override = db.prepare('SELECT * FROM blueprint_overrides WHERE character_id = 1001 AND item_id = ?')
        .get('1000001');
      expect(override).toBeUndefined();
    });
  });

  describe('Realistic Sync Scenarios', () => {
    test('Scenario: Two characters in same corp sync blueprints successfully', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Character A syncs: personal + corp blueprints
      db.exec('BEGIN TRANSACTION');
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND source = ?').run(1001, 'esi');

      insert.run(1001, '1000001', 34, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'esi', 0, now, now, null); // Personal
      insert.run(1001, '2000001', 35, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null); // Corp

      db.exec('COMMIT');

      // Character B syncs: personal + corp blueprints (same corp item_id)
      db.exec('BEGIN TRANSACTION');
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND source = ?').run(1002, 'esi');

      insert.run(1002, '1000002', 34, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'esi', 0, now, now, null); // Personal
      insert.run(1002, '2000001', 35, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null); // Corp (SAME item_id)

      db.exec('COMMIT');

      // Verify both characters have their blueprints
      const char1Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1001').all();
      const char2Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1002').all();

      expect(char1Blueprints).toHaveLength(2);
      expect(char2Blueprints).toHaveLength(2);

      // Verify corp blueprint exists for both
      const char1CorpBp = char1Blueprints.find(bp => bp.item_id === '2000001');
      const char2CorpBp = char2Blueprints.find(bp => bp.item_id === '2000001');

      expect(char1CorpBp).toBeDefined();
      expect(char2CorpBp).toBeDefined();
      expect(char1CorpBp.is_corporation).toBe(1);
      expect(char2CorpBp.is_corporation).toBe(1);
    });

    test('Scenario: Character re-sync replaces their blueprints without affecting other characters', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Initial sync for both characters
      insert.run(1001, '2000001', 35, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null);
      insert.run(1002, '2000001', 35, 2001, 60003760, 'CorpHangar', 1, 0, 10, -1, 0, 1, 'esi', 0, now, now, null);

      // Character A re-syncs (blueprint removed from ESI)
      db.exec('BEGIN TRANSACTION');
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND source = ?').run(1001, 'esi');
      // No blueprints inserted
      db.exec('COMMIT');

      // Verify Character A has no blueprints, Character B still has theirs
      const char1Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1001').all();
      const char2Blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1002').all();

      expect(char1Blueprints).toHaveLength(0);
      expect(char2Blueprints).toHaveLength(1);
    });
  });

  describe('Edge Cases', () => {
    test('handles character with no corp blueprints', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Character in different corp with no overlapping blueprints
      insert.run(1003, '3000001', 34, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'esi', 0, now, now, null);

      const blueprints = db.prepare('SELECT * FROM blueprints WHERE character_id = 1003').all();
      expect(blueprints).toHaveLength(1);
      expect(blueprints[0].corporation_id).toBeNull();
    });

    test('handles manual blueprints alongside ESI blueprints', () => {
      const insert = db.prepare(`
        INSERT INTO blueprints (
          character_id, item_id, type_id, corporation_id, location_id,
          location_flag, quantity, time_efficiency, material_efficiency,
          runs, is_copy, is_corporation, source, manually_added,
          fetched_at, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      insert.run(1001, '1000001', 34, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'esi', 0, now, now, null);
      insert.run(1001, '9000001', 35, null, 60003760, 'Hangar', 1, 0, 10, -1, 0, 0, 'manual', 1, now, now, null);

      // Sync should only delete ESI blueprints
      db.exec('BEGIN TRANSACTION');
      db.prepare('DELETE FROM blueprints WHERE character_id = ? AND source = ?').run(1001, 'esi');
      db.exec('COMMIT');

      const remaining = db.prepare('SELECT * FROM blueprints WHERE character_id = 1001').all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].source).toBe('manual');
      expect(remaining[0].item_id).toBe('9000001');
    });
  });
});
