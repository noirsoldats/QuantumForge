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

  // ── Ledger overhaul migrations (019-022) ──────────────────────────────────
  const byId = (id) => migrations.find((m) => m.id.startsWith(id));

  describe('Migration 019: plan_material_ledger source/cost rebuild', () => {
    const migration = byId('019');

    function makeLegacyLedger() {
      db.exec(`
        CREATE TABLE manufacturing_plans (plan_id TEXT PRIMARY KEY);
        INSERT INTO manufacturing_plans (plan_id) VALUES ('P1');
        CREATE TABLE plan_material_ledger (
          ledger_id   TEXT    PRIMARY KEY,
          plan_id     TEXT    NOT NULL,
          type_id     INTEGER NOT NULL,
          event_type  TEXT    NOT NULL CHECK(event_type IN ('acquired','deducted','adjusted')),
          quantity    REAL    NOT NULL,
          method      TEXT    NOT NULL CHECK(method IN ('manual','purchased','manufactured','allocated')),
          unit_price  REAL,
          note        TEXT,
          source_ref  TEXT,
          created_at  INTEGER NOT NULL
        );
      `);
    }

    it('skips when the table does not exist', () => {
      expect(() => migration.up(db)).not.toThrow();
    });

    it('adds source/cost columns, widens event_type, and preserves rows', () => {
      makeLegacyLedger();
      db.prepare(`INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, created_at)
        VALUES ('L1','P1',34,'acquired',100,'purchased',5.5,1000)`).run();

      migration.up(db);

      const cols = db.prepare('PRAGMA table_info(plan_material_ledger)').all().map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(
        ['source_type', 'source_id', 'character_id', 'corporation_id', 'cost_category']
      ));

      // Existing row preserved.
      const row = db.prepare('SELECT * FROM plan_material_ledger WHERE ledger_id = ?').get('L1');
      expect(row.quantity).toBe(100);
      expect(row.unit_price).toBe(5.5);

      // event_type='cost' now permitted.
      expect(() => db.prepare(`INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, cost_category, created_at)
        VALUES ('C1','P1',0,'cost',0,'cost',12345,'broker_fee',2000)`).run()).not.toThrow();

      // Unique source index prevents duplicate source rows.
      db.prepare(`INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, source_type, source_id, created_at)
        VALUES ('S1','P1',34,'acquired',1,'purchased','wallet_transaction',999,3000)`).run();
      expect(() => db.prepare(`INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, source_type, source_id, created_at)
        VALUES ('S2','P1',34,'acquired',1,'purchased','wallet_transaction',999,3001)`).run())
        .toThrow();
    });

    it('is idempotent (skips when already migrated)', () => {
      makeLegacyLedger();
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      const costCat = db.prepare('PRAGMA table_info(plan_material_ledger)').all()
        .filter(c => c.name === 'cost_category');
      expect(costCat).toHaveLength(1);
    });
  });

  describe('Migration 020: esi_industry_jobs cost/product_type_id', () => {
    const migration = byId('020');

    it('skips when the table does not exist', () => {
      expect(() => migration.up(db)).not.toThrow();
    });

    it('adds cost and product_type_id columns', () => {
      db.exec(`CREATE TABLE esi_industry_jobs (job_id INTEGER PRIMARY KEY, status TEXT NOT NULL, last_updated INTEGER NOT NULL)`);
      migration.up(db);
      const cols = db.prepare('PRAGMA table_info(esi_industry_jobs)').all().map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(['cost', 'product_type_id']));
    });

    it('is idempotent', () => {
      db.exec(`CREATE TABLE esi_industry_jobs (job_id INTEGER PRIMARY KEY, status TEXT NOT NULL, last_updated INTEGER NOT NULL)`);
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      const cost = db.prepare('PRAGMA table_info(esi_industry_jobs)').all().filter(c => c.name === 'cost');
      expect(cost).toHaveLength(1);
    });
  });

  describe('Migration 021: esi_wallet_transactions corp support', () => {
    const migration = byId('021');

    function makeLegacyTx() {
      db.exec(`
        CREATE TABLE esi_wallet_transactions (
          transaction_id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL,
          date INTEGER NOT NULL,
          type_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          unit_price REAL NOT NULL,
          location_id INTEGER NOT NULL,
          is_buy INTEGER NOT NULL,
          is_personal INTEGER NOT NULL,
          last_updated INTEGER NOT NULL,
          cache_expires_at INTEGER
        );
      `);
    }

    it('skips when the table does not exist', () => {
      expect(() => migration.up(db)).not.toThrow();
    });

    it('rebuilds to composite PK, adds corp + client_id/journal_ref_id, preserves rows', () => {
      makeLegacyTx();
      db.prepare(`INSERT INTO esi_wallet_transactions
        (transaction_id, character_id, date, type_id, quantity, unit_price, location_id, is_buy, is_personal, last_updated)
        VALUES (5001, 42, 1700000000000, 34, 10, 5.0, 60003760, 1, 1, 1700000001000)`).run();

      migration.up(db);

      const info = db.prepare('PRAGMA table_info(esi_wallet_transactions)').all();
      const pk = info.filter(c => c.pk > 0).map(c => c.name).sort();
      expect(pk).toEqual(['character_id', 'is_corporation', 'transaction_id']);
      const cols = info.map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(
        ['is_corporation', 'corporation_id', 'division', 'client_id', 'journal_ref_id']
      ));

      const row = db.prepare('SELECT * FROM esi_wallet_transactions WHERE transaction_id = ?').get(5001);
      expect(row.character_id).toBe(42);
      expect(row.is_corporation).toBe(0);
      expect(row.unit_price).toBe(5.0);
    });

    it('is idempotent', () => {
      makeLegacyTx();
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
    });
  });

  describe('Migration 022: esi_wallet_journal table', () => {
    const migration = byId('022');

    it('creates the esi_wallet_journal table with composite PK and indexes', () => {
      migration.up(db);
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='esi_wallet_journal'`).get();
      expect(table).toBeDefined();
      const pk = db.prepare('PRAGMA table_info(esi_wallet_journal)').all()
        .filter(c => c.pk > 0).map(c => c.name).sort();
      expect(pk).toEqual(['character_id', 'id', 'is_corporation']);
      const cols = db.prepare('PRAGMA table_info(esi_wallet_journal)').all().map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(['ref_type', 'context_id', 'context_id_type', 'amount', 'balance']));
    });

    it('is idempotent (skips when table exists)', () => {
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
    });
  });

  describe('Migration 023: plan_transaction_matches is_corporation', () => {
    const migration = byId('023');

    it('skips when the table does not exist', () => {
      expect(() => migration.up(db)).not.toThrow();
    });

    it('adds is_corporation with default 0', () => {
      db.exec(`CREATE TABLE plan_transaction_matches (
        match_id TEXT PRIMARY KEY, plan_id TEXT, transaction_id INTEGER, type_id INTEGER,
        match_type TEXT, quantity INTEGER, match_confidence REAL, match_reason TEXT,
        status TEXT DEFAULT 'pending', confirmed_at INTEGER, confirmed_by_user INTEGER DEFAULT 0
      )`);
      db.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence)
        VALUES ('m1','P1',500,34,'material_buy',10,0.9)`).run();

      migration.up(db);

      const cols = db.prepare('PRAGMA table_info(plan_transaction_matches)').all().map(c => c.name);
      expect(cols).toContain('is_corporation');
      // Existing row defaults to 0 (personal).
      expect(db.prepare('SELECT is_corporation FROM plan_transaction_matches WHERE match_id = ?').get('m1').is_corporation).toBe(0);
    });

    it('is idempotent', () => {
      db.exec(`CREATE TABLE plan_transaction_matches (match_id TEXT PRIMARY KEY, transaction_id INTEGER)`);
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      const cnt = db.prepare('PRAGMA table_info(plan_transaction_matches)').all().filter(c => c.name === 'is_corporation');
      expect(cnt).toHaveLength(1);
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
