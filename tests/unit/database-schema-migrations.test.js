const Database = require('better-sqlite3');
const { migrations } = require('../../src/main/database-schema-migrations');

describe('Database Schema Migrations', () => {
  let db;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('Migration 001: assets item_id to TEXT', () => {
    const migration = migrations[0];

    it('should create schema_migrations table', () => {
      // Create the migrations tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);

      const table = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'
      `).get();

      expect(table).toBeDefined();
      expect(table.name).toBe('schema_migrations');
    });

    it('should skip migration if assets table does not exist', () => {
      // Run migration without creating assets table
      expect(() => migration.up(db)).not.toThrow();

      // Verify assets table was not created
      const table = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='assets'
      `).get();

      expect(table).toBeUndefined();
    });

    it('should skip migration if item_id is already TEXT', () => {
      // Create assets table with TEXT item_id
      db.exec(`
        CREATE TABLE assets (
          item_id TEXT PRIMARY KEY,
          character_id INTEGER NOT NULL,
          type_id INTEGER NOT NULL,
          location_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          last_updated INTEGER NOT NULL
        )
      `);

      // Run migration
      migration.up(db);

      // Verify table structure unchanged
      const pragma = db.pragma('table_info(assets)');
      const itemIdColumn = pragma.find(col => col.name === 'item_id');

      expect(itemIdColumn.type).toBe('TEXT');
    });

    it('should convert item_id from INTEGER to TEXT', () => {
      // Create assets table with INTEGER item_id
      db.exec(`
        CREATE TABLE characters (
          character_id INTEGER PRIMARY KEY,
          character_name TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE assets (
          item_id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL,
          type_id INTEGER NOT NULL,
          location_id INTEGER NOT NULL,
          location_flag TEXT,
          location_type_id INTEGER,
          quantity INTEGER NOT NULL,
          is_singleton INTEGER DEFAULT 0,
          is_blueprint_copy INTEGER,
          is_corporation INTEGER DEFAULT 0,
          last_updated INTEGER NOT NULL,
          cache_expires_at INTEGER,
          FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
        )
      `);

      // Insert test character
      db.prepare('INSERT INTO characters (character_id, character_name) VALUES (?, ?)').run(123456, 'Test Character');

      // Insert test data with INTEGER item_id
      db.prepare(`
        INSERT INTO assets (item_id, character_id, type_id, location_id, quantity, last_updated)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1000000001, 123456, 34, 60003760, 100, Date.now());

      db.prepare(`
        INSERT INTO assets (item_id, character_id, type_id, location_id, quantity, last_updated)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1000000002, 123456, 35, 60003760, 50, Date.now());

      // Verify original column type
      let pragma = db.pragma('table_info(assets)');
      let itemIdColumn = pragma.find(col => col.name === 'item_id');
      expect(itemIdColumn.type).toBe('INTEGER');

      // Run migration
      migration.up(db);

      // Verify column type changed to TEXT
      pragma = db.pragma('table_info(assets)');
      itemIdColumn = pragma.find(col => col.name === 'item_id');
      expect(itemIdColumn.type).toBe('TEXT');

      // Verify data was preserved
      const assets = db.prepare('SELECT * FROM assets ORDER BY item_id').all();
      expect(assets).toHaveLength(2);
      expect(assets[0].item_id).toBe('1000000001');
      expect(assets[0].character_id).toBe(123456);
      expect(assets[0].type_id).toBe(34);
      expect(assets[0].quantity).toBe(100);
      expect(assets[1].item_id).toBe('1000000002');
      expect(assets[1].character_id).toBe(123456);
      expect(assets[1].type_id).toBe(35);
      expect(assets[1].quantity).toBe(50);
    });

    it('should preserve all columns and indexes after migration', () => {
      // Create full schema
      db.exec(`
        CREATE TABLE characters (
          character_id INTEGER PRIMARY KEY,
          character_name TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE assets (
          item_id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL,
          type_id INTEGER NOT NULL,
          location_id INTEGER NOT NULL,
          location_flag TEXT,
          location_type_id INTEGER,
          quantity INTEGER NOT NULL,
          is_singleton INTEGER DEFAULT 0,
          is_blueprint_copy INTEGER,
          is_corporation INTEGER DEFAULT 0,
          last_updated INTEGER NOT NULL,
          cache_expires_at INTEGER,
          FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assets_character ON assets(character_id);
        CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type_id);
        CREATE INDEX IF NOT EXISTS idx_assets_location ON assets(location_id);
      `);

      // Insert test data with all columns
      db.prepare('INSERT INTO characters (character_id, character_name) VALUES (?, ?)').run(123456, 'Test Character');

      db.prepare(`
        INSERT INTO assets (
          item_id, character_id, type_id, location_id, location_flag,
          location_type_id, quantity, is_singleton, is_blueprint_copy,
          is_corporation, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        1000000001,
        123456,
        34,
        60003760,
        'Hangar',
        52678,
        100,
        0,
        null,
        0,
        Date.now(),
        Date.now() + 3600000
      );

      // Run migration
      migration.up(db);

      // Verify all columns exist
      const pragma = db.pragma('table_info(assets)');
      const columnNames = pragma.map(col => col.name);

      expect(columnNames).toContain('item_id');
      expect(columnNames).toContain('character_id');
      expect(columnNames).toContain('type_id');
      expect(columnNames).toContain('location_id');
      expect(columnNames).toContain('location_flag');
      expect(columnNames).toContain('location_type_id');
      expect(columnNames).toContain('quantity');
      expect(columnNames).toContain('is_singleton');
      expect(columnNames).toContain('is_blueprint_copy');
      expect(columnNames).toContain('is_corporation');
      expect(columnNames).toContain('last_updated');
      expect(columnNames).toContain('cache_expires_at');

      // Verify indexes were recreated
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='assets'
      `).all();

      const indexNames = indexes.map(idx => idx.name);
      expect(indexNames).toContain('idx_assets_character');
      expect(indexNames).toContain('idx_assets_type');
      expect(indexNames).toContain('idx_assets_location');

      // Verify all data preserved
      const asset = db.prepare('SELECT * FROM assets WHERE item_id = ?').get('1000000001');
      expect(asset.character_id).toBe(123456);
      expect(asset.type_id).toBe(34);
      expect(asset.location_id).toBe(60003760);
      expect(asset.location_flag).toBe('Hangar');
      expect(asset.location_type_id).toBe(52678);
      expect(asset.quantity).toBe(100);
      expect(asset.is_singleton).toBe(0);
      expect(asset.is_blueprint_copy).toBeNull();
      expect(asset.is_corporation).toBe(0);
    });

    it('should handle large INTEGER values correctly', () => {
      // ESI item_ids can be very large (> 32-bit integer)
      db.exec(`
        CREATE TABLE characters (
          character_id INTEGER PRIMARY KEY,
          character_name TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE assets (
          item_id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL,
          type_id INTEGER NOT NULL,
          location_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          last_updated INTEGER NOT NULL
        )
      `);

      db.prepare('INSERT INTO characters (character_id, character_name) VALUES (?, ?)').run(123456, 'Test Character');

      // Insert with large item_id (typical ESI value)
      const largeItemId = 1234567890123456;
      db.prepare(`
        INSERT INTO assets (item_id, character_id, type_id, location_id, quantity, last_updated)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(largeItemId, 123456, 34, 60003760, 100, Date.now());

      // Run migration
      migration.up(db);

      // Verify large value preserved as string
      const asset = db.prepare('SELECT item_id FROM assets').get();
      expect(asset.item_id).toBe(largeItemId.toString());
    });

    it('should rollback on error', () => {
      // Create assets table with INTEGER item_id
      db.exec(`
        CREATE TABLE characters (
          character_id INTEGER PRIMARY KEY,
          character_name TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE assets (
          item_id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL,
          type_id INTEGER NOT NULL,
          location_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          last_updated INTEGER NOT NULL
        )
      `);

      db.prepare('INSERT INTO characters (character_id, character_name) VALUES (?, ?)').run(123456, 'Test Character');

      db.prepare(`
        INSERT INTO assets (item_id, character_id, type_id, location_id, quantity, last_updated)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1000000001, 123456, 34, 60003760, 100, Date.now());

      // Mock the migration to fail midway
      const failingMigration = {
        ...migration,
        up: (database) => {
          database.exec('BEGIN TRANSACTION');
          try {
            database.exec(`
              CREATE TABLE assets_new (
                item_id TEXT PRIMARY KEY,
                character_id INTEGER NOT NULL,
                type_id INTEGER NOT NULL,
                location_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                last_updated INTEGER NOT NULL
              )
            `);

            // Intentionally cause an error
            throw new Error('Simulated migration failure');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        }
      };

      // Attempt migration
      expect(() => failingMigration.up(db)).toThrow('Simulated migration failure');

      // Verify original table still exists and data intact
      const pragma = db.pragma('table_info(assets)');
      const itemIdColumn = pragma.find(col => col.name === 'item_id');
      expect(itemIdColumn.type).toBe('INTEGER');

      const asset = db.prepare('SELECT * FROM assets').get();
      expect(asset.item_id).toBe(1000000001);

      // Verify new table was rolled back
      const newTable = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='assets_new'
      `).get();
      expect(newTable).toBeUndefined();
    });
  });

  describe('Migration system', () => {
    it('should have valid migration structure', () => {
      expect(migrations).toBeInstanceOf(Array);
      expect(migrations.length).toBeGreaterThan(0);

      migrations.forEach(migration => {
        expect(migration).toHaveProperty('id');
        expect(migration).toHaveProperty('description');
        expect(migration).toHaveProperty('up');
        expect(typeof migration.id).toBe('string');
        expect(typeof migration.description).toBe('string');
        expect(typeof migration.up).toBe('function');
      });
    });

    it('should have unique migration IDs', () => {
      const ids = migrations.map(m => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });
});
