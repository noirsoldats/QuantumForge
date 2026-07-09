const { getCharacterDatabase } = require('./character-database');

/**
 * Database schema migration system
 *
 * Each migration is an object with:
 * - id: Unique identifier (e.g., "001_assets_item_id_to_text")
 * - description: Human-readable description
 * - up: Function to apply the migration
 * - down: Function to rollback the migration (optional)
 */

// Define all migrations here
const migrations = [
  {
    id: '001_assets_item_id_to_text',
    description: 'Convert assets table item_id from INTEGER to TEXT',
    up: (db) => {
      console.log('[Migration 001] Starting assets item_id migration...');

      // Check if assets table exists
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='assets'
      `).get();

      if (!tableExists) {
        console.log('[Migration 001] Assets table does not exist, skipping');
        return;
      }

      // Check current column type
      const pragma = db.pragma('table_info(assets)');
      const itemIdColumn = pragma.find(col => col.name === 'item_id');

      if (!itemIdColumn) {
        console.log('[Migration 001] item_id column does not exist, skipping');
        return;
      }

      if (itemIdColumn.type === 'TEXT') {
        console.log('[Migration 001] item_id is already TEXT, skipping');
        return;
      }

      console.log('[Migration 001] Converting item_id from INTEGER to TEXT...');

      // SQLite doesn't support ALTER COLUMN, so we need to:
      // 1. Create a new table with the correct schema
      // 2. Copy data from old table to new table
      // 3. Drop old table
      // 4. Rename new table to old name
      // 5. Recreate indexes

      db.exec('BEGIN TRANSACTION');

      try {
        // Get existing columns to build dynamic INSERT
        const existingColumns = pragma.map(col => col.name);

        // Create new table with TEXT item_id
        db.exec(`
          CREATE TABLE assets_new (
            item_id TEXT PRIMARY KEY,
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

        // Build column list for INSERT, only including columns that exist in old table
        const targetColumns = [
          'item_id',
          'character_id',
          'type_id',
          'location_id',
          'location_flag',
          'location_type_id',
          'quantity',
          'is_singleton',
          'is_blueprint_copy',
          'is_corporation',
          'last_updated',
          'cache_expires_at'
        ];

        const columnsToInsert = targetColumns.filter(col => existingColumns.includes(col));
        const selectClauses = columnsToInsert.map(col =>
          col === 'item_id' ? 'CAST(item_id AS TEXT)' : col
        );

        // Copy data (convert INTEGER to TEXT)
        db.exec(`
          INSERT INTO assets_new (${columnsToInsert.join(', ')})
          SELECT ${selectClauses.join(', ')}
          FROM assets
        `);

        // Drop old table
        db.exec('DROP TABLE assets');

        // Rename new table
        db.exec('ALTER TABLE assets_new RENAME TO assets');

        // Recreate indexes
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_assets_character ON assets(character_id);
          CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type_id);
          CREATE INDEX IF NOT EXISTS idx_assets_location ON assets(location_id);
        `);

        db.exec('COMMIT');
        console.log('[Migration 001] Successfully converted item_id to TEXT');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 001] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      // Rollback migration (optional - not recommended for production)
      console.log('[Migration 001] Rollback not implemented (data loss possible)');
    }
  },

  {
    // LEGACY / INERT ON FRESH DBs: operates on plan_materials, a table that
    // migration 008 later drops. No-op on any DB created after 008. Retained
    // (not removed) so its id stays recorded on DBs that predate 008.
    id: '002_plan_materials_manual_acquisition',
    description: 'Add columns for manual material acquisition and custom pricing',
    up: (db) => {
      console.log('[Migration 002] Adding manual acquisition columns to plan_materials...');

      // Check if plan_materials table exists
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='plan_materials'
      `).get();

      if (!tableExists) {
        console.log('[Migration 002] plan_materials table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');

      try {
        // Check if columns already exist
        const pragma = db.pragma('table_info(plan_materials)');
        const hasManuallyAcquired = pragma.some(col => col.name === 'manually_acquired');
        const hasAcquisitionMethod = pragma.some(col => col.name === 'acquisition_method');
        const hasCustomPrice = pragma.some(col => col.name === 'custom_price');
        const hasAcquisitionNote = pragma.some(col => col.name === 'acquisition_note');

        if (hasManuallyAcquired && hasAcquisitionMethod && hasCustomPrice && hasAcquisitionNote) {
          console.log('[Migration 002] Columns already exist, skipping');
          db.exec('COMMIT');
          return;
        }

        // Add new columns if they don't exist
        if (!hasManuallyAcquired) {
          db.exec('ALTER TABLE plan_materials ADD COLUMN manually_acquired INTEGER DEFAULT 0');
        }
        if (!hasAcquisitionMethod) {
          db.exec('ALTER TABLE plan_materials ADD COLUMN acquisition_method TEXT');
        }
        if (!hasCustomPrice) {
          db.exec('ALTER TABLE plan_materials ADD COLUMN custom_price REAL');
        }
        if (!hasAcquisitionNote) {
          db.exec('ALTER TABLE plan_materials ADD COLUMN acquisition_note TEXT');
        }

        db.exec('COMMIT');
        console.log('[Migration 002] Successfully added manual acquisition columns');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 002] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 002] Rollback not implemented (would require table recreation)');
    }
  },

  {
    id: '003_plan_blueprints_use_intermediates',
    description: 'Add use_intermediates column to plan_blueprints table',
    up: (db) => {
      console.log('[Migration 003] Adding use_intermediates column to plan_blueprints...');

      // Check if plan_blueprints table exists
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='plan_blueprints'
      `).get();

      if (!tableExists) {
        console.log('[Migration 003] plan_blueprints table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');

      try {
        // Check if column already exists
        const pragma = db.pragma('table_info(plan_blueprints)');
        const hasUseIntermediates = pragma.some(col => col.name === 'use_intermediates');

        if (hasUseIntermediates) {
          console.log('[Migration 003] Column already exists, skipping');
          db.exec('COMMIT');
          return;
        }

        // Add new column as TEXT with the canonical default 'raw_materials'.
        // NOTE: this migration originally created the column as `INTEGER DEFAULT 1`.
        // The canonical type is TEXT ('raw_materials' | 'components' | 'buy') — the UI
        // and calculation code use the string form. Historically the untracked ad-hoc
        // block in character-database.js created the column as TEXT *before* this
        // migration ran, so this INTEGER add was a no-op on real DBs. Now that the
        // ad-hoc block is folded into migration 010, this migration must itself create
        // the correct TEXT column on fresh DBs. Live DBs already have this migration
        // recorded (it never re-runs); any legacy INTEGER *values* are normalized to
        // canonical TEXT by migration 010.
        db.exec(`ALTER TABLE plan_blueprints ADD COLUMN use_intermediates TEXT DEFAULT 'raw_materials'`);

        db.exec('COMMIT');
        console.log('[Migration 003] Successfully added use_intermediates column');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 003] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 003] Rollback not implemented (would require table recreation)');
    }
  },

  {
    // LEGACY / INERT ON FRESH DBs: operates on plan_materials, dropped by
    // migration 008. See note on migration 002.
    id: '004_plan_materials_partial_acquisition',
    description: 'Add manually_acquired_quantity column to support partial acquisitions',
    up: (db) => {
      console.log('[Migration 004] Adding manually_acquired_quantity column...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='plan_materials'
      `).get();

      if (!tableExists) {
        console.log('[Migration 004] plan_materials table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');

      try {
        const pragma = db.pragma('table_info(plan_materials)');
        const hasColumn = pragma.some(col => col.name === 'manually_acquired_quantity');

        if (hasColumn) {
          console.log('[Migration 004] Column already exists, skipping');
          db.exec('COMMIT');
          return;
        }

        // Add new column
        db.exec('ALTER TABLE plan_materials ADD COLUMN manually_acquired_quantity INTEGER DEFAULT 0');

        // Migrate existing data: if manually_acquired=1, set manually_acquired_quantity to quantity
        db.exec(`
          UPDATE plan_materials
          SET manually_acquired_quantity = quantity
          WHERE manually_acquired = 1
        `);

        db.exec('COMMIT');
        console.log('[Migration 004] Successfully added manually_acquired_quantity column');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 004] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 004] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '005_fix_asset_table_primary_key',
    description: 'Fix Assets table primary key constraint',
    up: (db) => {
      console.log('[Migration 005] Fixing Assets table primary key constraint...');
      try {
        // Check if migration needed (test if composite key exists)
        const tableInfo = db.prepare("PRAGMA table_info(assets)").all();
        const pkColumns = tableInfo.filter(col => col.pk > 0).map(col => col.name);

        // If already composite key (character_id, item_id), skip migration
        if (pkColumns.length === 2 && pkColumns.includes('character_id') && pkColumns.includes('item_id')) {
          console.log('[Character Database] Assets table already migrated to v2');
          return;
        }

        console.log('[Character Database] Migrating assets table to composite primary key...');

        // Disable foreign keys BEFORE transaction
        db.pragma('foreign_keys = OFF');

        db.exec('BEGIN TRANSACTION;');
        // Step 1: Create new assets_dg_tmp table with composite PK
        db.exec(`create table assets_dg_tmp
        (
            item_id           TEXT,
            character_id      INTEGER not null
                references characters
                    on delete cascade,
            type_id           INTEGER not null,
            location_id       INTEGER not null,
            location_flag     TEXT,
            location_type_id  INTEGER,
            quantity          INTEGER not null,
            is_singleton      INTEGER default 0,
            is_blueprint_copy INTEGER,
            is_corporation    INTEGER default 0,
            last_updated      INTEGER not null,
            cache_expires_at  INTEGER,
            primary key (item_id, character_id)
        );`);

        // Step 2: Copy data from old assets table to new assets_new table
        db.exec(`insert into assets_dg_tmp(item_id, character_id, type_id, location_id, location_flag, location_type_id, quantity,
                                           is_singleton, is_blueprint_copy, is_corporation, last_updated, cache_expires_at)
                 select item_id,
                        character_id,
                        type_id,
                        location_id,
                        location_flag,
                        location_type_id,
                        quantity,
                        is_singleton,
                        is_blueprint_copy,
                        is_corporation,
                        last_updated,
                        cache_expires_at
                 from assets;`);
        // Step 3: Drop old assets table
        db.exec(`drop table assets;`);
        // Step 4: Rename new assets_new table to assets
        db.exec(`alter table assets_dg_tmp rename to assets;`);
        // Step 5: Recreate indexes
        db.exec(`create index idx_assets_character on assets (character_id);`);
        db.exec(`create index idx_assets_location on assets (location_id);`);
        db.exec(`create index idx_assets_type on assets (type_id);`);

        // Re-enable foreign keys AFTER transaction
        db.pragma('foreign_keys = ON');

        console.log('[Character Database] Assets table migration complete');
        db.exec('COMMIT');
        console.log('[Migration 005] Successfully migrated Assets table to composite primary key');
      } catch (error) {
        console.error('[Character Database] Migration failed:', error);
        db.exec('ROLLBACK');
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 005] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '006_plan_blueprints_built_runs',
    description: 'Add built_runs column to plan_blueprints for partial quantity tracking',
    up: (db) => {
      console.log('[Migration 006] Adding built_runs column to plan_blueprints...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='plan_blueprints'
      `).get();

      if (!tableExists) {
        console.log('[Migration 006] plan_blueprints table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');

      try {
        const pragma = db.pragma('table_info(plan_blueprints)');
        const hasColumn = pragma.some(col => col.name === 'built_runs');

        if (hasColumn) {
          console.log('[Migration 006] Column already exists, skipping');
          db.exec('COMMIT');
          return;
        }

        // Add new column
        db.exec('ALTER TABLE plan_blueprints ADD COLUMN built_runs INTEGER DEFAULT 0');

        // Migrate existing data: if is_built=1, set built_runs to runs (fully built).
        // The is_built / is_intermediate columns are added by migration 011, which runs
        // AFTER this one. Historically these columns existed by the time 006 ran (the
        // untracked ad-hoc block created them during initializeCharacterDatabase before
        // the numbered system ran). Now that those blocks are folded into numbered
        // migrations 011/012, guard the backfill on column existence; the authoritative
        // backfill (once all columns exist) lives at the end of migration 012.
        const hasBuiltFlags =
          pragma.some(col => col.name === 'is_built') &&
          pragma.some(col => col.name === 'is_intermediate');
        if (hasBuiltFlags) {
          db.exec(`
            UPDATE plan_blueprints
            SET built_runs = runs
            WHERE is_built = 1 AND is_intermediate = 1
          `);
        }

        db.exec('COMMIT');
        console.log('[Migration 006] Successfully added built_runs column');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 006] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 006] Rollback not implemented (would require table recreation)');
    }
  },
  {
    // LEGACY / INERT ON FRESH DBs: creates plan_material_manual_acquisitions /
    // plan_material_acquisition_log, both dropped by migration 008. Retained so
    // its id stays recorded on DBs that predate 008.
    id: '007_separate_manual_acquisitions_table',
    description: 'Create separate tables for manual acquisitions and acquisition log',
    up: (db) => {
      console.log('[Migration 007] Creating separate manual acquisitions tables...');

      db.exec('BEGIN TRANSACTION');

      try {
        // Create plan_material_manual_acquisitions table
        const manualAcqTableExists = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name='plan_material_manual_acquisitions'
        `).get();

        if (!manualAcqTableExists) {
          console.log('[Migration 007] Creating plan_material_manual_acquisitions table...');
          db.exec(`
            CREATE TABLE plan_material_manual_acquisitions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              plan_id TEXT NOT NULL,
              type_id INTEGER NOT NULL,
              quantity INTEGER NOT NULL,
              acquisition_method TEXT NOT NULL,
              custom_price REAL,
              note TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE,
              UNIQUE(plan_id, type_id)
            )
          `);

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_manual_acq_plan
            ON plan_material_manual_acquisitions(plan_id)
          `);

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_manual_acq_type
            ON plan_material_manual_acquisitions(type_id)
          `);

          console.log('[Migration 007] plan_material_manual_acquisitions table created');
        } else {
          console.log('[Migration 007] plan_material_manual_acquisitions table already exists');
        }

        // Create plan_material_acquisition_log table
        const logTableExists = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name='plan_material_acquisition_log'
        `).get();

        if (!logTableExists) {
          console.log('[Migration 007] Creating plan_material_acquisition_log table...');
          db.exec(`
            CREATE TABLE plan_material_acquisition_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              plan_id TEXT NOT NULL,
              type_id INTEGER NOT NULL,
              timestamp INTEGER NOT NULL,
              action TEXT NOT NULL,
              quantity_before INTEGER,
              quantity_after INTEGER NOT NULL,
              acquisition_method TEXT,
              custom_price REAL,
              note TEXT,
              performed_by TEXT,
              FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
            )
          `);

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_acquisition_log_plan_type
            ON plan_material_acquisition_log(plan_id, type_id)
          `);

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_acquisition_log_timestamp
            ON plan_material_acquisition_log(timestamp)
          `);

          console.log('[Migration 007] plan_material_acquisition_log table created');
        } else {
          console.log('[Migration 007] plan_material_acquisition_log table already exists');
        }

        // Migrate existing data from plan_materials columns to new table
        const planMaterialsExists = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name='plan_materials'
        `).get();

        if (planMaterialsExists) {
          console.log('[Migration 007] Migrating existing acquisition data...');

          // Count how many records need migration
          const countStmt = db.prepare(`
            SELECT COUNT(*) as count FROM plan_materials
            WHERE manually_acquired = 1
              AND manually_acquired_quantity > 0
              AND acquisition_method IS NOT NULL
              AND acquisition_method != 'manufactured'
          `);
          const { count } = countStmt.get();

          if (count > 0) {
            console.log(`[Migration 007] Found ${count} acquisition records to migrate`);

            db.exec(`
              INSERT INTO plan_material_manual_acquisitions
                (plan_id, type_id, quantity, acquisition_method, custom_price, note, created_at, updated_at)
              SELECT
                plan_id,
                type_id,
                manually_acquired_quantity,
                COALESCE(acquisition_method, 'other'),
                custom_price,
                acquisition_note,
                COALESCE(price_frozen_at, strftime('%s', 'now') * 1000),
                COALESCE(price_frozen_at, strftime('%s', 'now') * 1000)
              FROM plan_materials
              WHERE manually_acquired = 1
                AND manually_acquired_quantity > 0
                AND acquisition_method IS NOT NULL
                AND acquisition_method != 'manufactured'
            `);

            console.log(`[Migration 007] Successfully migrated ${count} acquisition records`);
          } else {
            console.log('[Migration 007] No acquisition data to migrate');
          }
        }

        db.exec('COMMIT');
        console.log('[Migration 007] Migration completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 007] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 007] Rollback not implemented');
    }
  },
  {
    id: '008_material_tree_and_ledger',
    description: 'Create plan_material_nodes and plan_material_ledger tables, migrate acquisitions, drop old tables',
    up: (db) => {
      console.log('[Migration 008] Creating material tree and ledger tables...');

      db.exec('BEGIN TRANSACTION');

      try {
        // Step 1: Create plan_material_nodes table
        db.exec(`
          CREATE TABLE IF NOT EXISTS plan_material_nodes (
            node_id                    TEXT    PRIMARY KEY,
            plan_id                    TEXT    NOT NULL,
            plan_blueprint_id          TEXT    NOT NULL,
            source_plan_blueprint_id   TEXT,
            parent_node_id             TEXT,
            type_id                    INTEGER NOT NULL,
            node_type                  TEXT    NOT NULL CHECK(node_type IN ('product','material','intermediate')),
            depth                      INTEGER NOT NULL DEFAULT 0,
            quantity_needed            REAL    NOT NULL,
            quantity_per_run           REAL,
            runs_needed                INTEGER,
            me_level                   INTEGER,
            is_reaction                INTEGER NOT NULL DEFAULT 0,
            build_plan                 TEXT    NOT NULL DEFAULT 'raw_materials'
                                         CHECK(build_plan IN ('raw_materials','components','buy')),
            price_each                 REAL,
            price_frozen_at            INTEGER,
            created_at                 INTEGER NOT NULL,
            updated_at                 INTEGER NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE,
            FOREIGN KEY (plan_blueprint_id) REFERENCES plan_blueprints(plan_blueprint_id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pmn_plan          ON plan_material_nodes(plan_id);
          CREATE INDEX IF NOT EXISTS idx_pmn_blueprint     ON plan_material_nodes(plan_blueprint_id);
          CREATE INDEX IF NOT EXISTS idx_pmn_parent        ON plan_material_nodes(parent_node_id);
          CREATE INDEX IF NOT EXISTS idx_pmn_type          ON plan_material_nodes(type_id);
          CREATE INDEX IF NOT EXISTS idx_pmn_plan_type     ON plan_material_nodes(plan_id, type_id);
          CREATE INDEX IF NOT EXISTS idx_pmn_plan_nodetype ON plan_material_nodes(plan_id, node_type);
        `);

        // Step 2: Create plan_material_ledger table
        db.exec(`
          CREATE TABLE IF NOT EXISTS plan_material_ledger (
            ledger_id   TEXT    PRIMARY KEY,
            plan_id     TEXT    NOT NULL,
            type_id     INTEGER NOT NULL,
            event_type  TEXT    NOT NULL CHECK(event_type IN ('acquired','deducted','adjusted')),
            quantity    REAL    NOT NULL,
            method      TEXT    NOT NULL CHECK(method IN ('manual','purchased','manufactured','allocated')),
            unit_price  REAL,
            note        TEXT,
            source_ref  TEXT,
            created_at  INTEGER NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pml_plan    ON plan_material_ledger(plan_id);
          CREATE INDEX IF NOT EXISTS idx_pml_type    ON plan_material_ledger(plan_id, type_id);
          CREATE INDEX IF NOT EXISTS idx_pml_created ON plan_material_ledger(created_at);
        `);

        // Step 3: Check if old tables exist before migrating
        const manualAcqExists = db.prepare(`
          SELECT name FROM sqlite_master WHERE type='table' AND name='plan_material_manual_acquisitions'
        `).get();

        if (manualAcqExists) {
          // Step 3: Migrate acquisitions to ledger
          const acquisitions = db.prepare(`
            SELECT plan_id, type_id, quantity, acquisition_method, custom_price, note, created_at
            FROM plan_material_manual_acquisitions
          `).all();

          const { randomUUID } = require('crypto');
          const now = Date.now();

          const insertLedger = db.prepare(`
            INSERT INTO plan_material_ledger
              (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
            VALUES (?, ?, ?, 'acquired', ?, ?, ?, ?, NULL, ?)
          `);

          for (const acq of acquisitions) {
            const method = acq.acquisition_method && ['manual','purchased','manufactured','allocated'].includes(acq.acquisition_method)
              ? acq.acquisition_method
              : 'manual';
            insertLedger.run(
              randomUUID(),
              acq.plan_id,
              acq.type_id,
              acq.quantity,
              method,
              acq.custom_price,
              acq.note,
              acq.created_at || now
            );
          }

          console.log(`[Migration 008] Migrated ${acquisitions.length} acquisition record(s) to ledger`);
        }

        // Step 4: Check if plan_materials table exists before migrating
        const planMaterialsExists = db.prepare(`
          SELECT name FROM sqlite_master WHERE type='table' AND name='plan_materials'
        `).get();

        if (planMaterialsExists) {
          // Migrate plan_materials to plan_material_nodes
          // Get top-level blueprints for each plan to use as plan_blueprint_id
          const planBlueprints = db.prepare(`
            SELECT plan_blueprint_id, plan_id FROM plan_blueprints WHERE is_intermediate = 0 OR is_intermediate IS NULL
          `).all();

          // Build plan -> first top-level blueprint map
          const planToBlueprintMap = new Map();
          for (const bp of planBlueprints) {
            if (!planToBlueprintMap.has(bp.plan_id)) {
              planToBlueprintMap.set(bp.plan_id, bp.plan_blueprint_id);
            }
          }

          const materials = db.prepare('SELECT * FROM plan_materials').all();
          const { randomUUID } = require('crypto');
          const now = Date.now();

          const insertNode = db.prepare(`
            INSERT INTO plan_material_nodes
              (node_id, plan_id, plan_blueprint_id, source_plan_blueprint_id, parent_node_id,
               type_id, node_type, depth, quantity_needed, quantity_per_run, runs_needed, me_level,
               is_reaction, build_plan, price_each, price_frozen_at, created_at, updated_at)
            VALUES (?, ?, ?, NULL, NULL, ?, 'material', 1, ?, NULL, NULL, NULL, 0, 'raw_materials', ?, ?, ?, ?)
          `);

          let migratedMaterials = 0;
          for (const mat of materials) {
            const planBlueprintId = planToBlueprintMap.get(mat.plan_id);
            if (!planBlueprintId) continue; // Skip if no blueprint found

            insertNode.run(
              randomUUID(),
              mat.plan_id,
              planBlueprintId,
              mat.type_id,
              mat.quantity,
              mat.base_price,
              mat.price_frozen_at,
              now,
              now
            );
            migratedMaterials++;
          }
          console.log(`[Migration 008] Migrated ${migratedMaterials} material row(s) to plan_material_nodes`);

          // Check if plan_products table exists
          const planProductsExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='plan_products'
          `).get();

          if (planProductsExists) {
            // Migrate plan_products to plan_material_nodes
            const products = db.prepare('SELECT * FROM plan_products').all();

            const insertProductNode = db.prepare(`
              INSERT INTO plan_material_nodes
                (node_id, plan_id, plan_blueprint_id, source_plan_blueprint_id, parent_node_id,
                 type_id, node_type, depth, quantity_needed, quantity_per_run, runs_needed, me_level,
                 is_reaction, build_plan, price_each, price_frozen_at, created_at, updated_at)
              VALUES (?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, NULL, 0, 'raw_materials', ?, ?, ?, ?)
            `);

            let migratedProducts = 0;
            for (const prod of products) {
              const planBlueprintId = planToBlueprintMap.get(prod.plan_id);
              if (!planBlueprintId) continue;

              const nodeType = prod.is_intermediate ? 'intermediate' : 'product';
              insertProductNode.run(
                randomUUID(),
                prod.plan_id,
                planBlueprintId,
                prod.type_id,
                nodeType,
                prod.quantity,
                prod.base_price,
                prod.price_frozen_at,
                now,
                now
              );
              migratedProducts++;
            }
            console.log(`[Migration 008] Migrated ${migratedProducts} product row(s) to plan_material_nodes`);

            // Drop plan_products
            db.exec('DROP TABLE plan_products');
            console.log('[Migration 008] Dropped plan_products table');
          }

          // Drop plan_materials
          db.exec('DROP TABLE plan_materials');
          console.log('[Migration 008] Dropped plan_materials table');
        }

        // Drop old acquisition tables if they exist
        if (manualAcqExists) {
          db.exec('DROP TABLE plan_material_manual_acquisitions');
          console.log('[Migration 008] Dropped plan_material_manual_acquisitions table');
        }

        const acqLogExists = db.prepare(`
          SELECT name FROM sqlite_master WHERE type='table' AND name='plan_material_acquisition_log'
        `).get();
        if (acqLogExists) {
          db.exec('DROP TABLE plan_material_acquisition_log');
          console.log('[Migration 008] Dropped plan_material_acquisition_log table');
        }

        db.exec('COMMIT');
        console.log('[Migration 008] Migration completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 008] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 008] Rollback not implemented');
    }
  },
  {
    id: '009_recalculate_plans_nested_reactions',
    description: 'One-time recalculation of all manufacturing plans to backfill nested-reaction sourcing rows',
    up: async (db) => {
      try {
        const { getMarketSets } = require('./settings-manager');
        if (getMarketSets().length === 0) {
          console.log('[Migration 009] No market sets configured yet, skipping (nothing to recalculate meaningfully)');
          return;
        }

        const { sdeExists } = require('./sde-manager');
        if (!sdeExists()) {
          console.log('[Migration 009] SDE not present yet, skipping - will not retry automatically');
          return;
        }

        const planIds = db.prepare('SELECT plan_id FROM manufacturing_plans').all().map(r => r.plan_id);
        console.log(`[Migration 009] Recalculating ${planIds.length} plan(s)...`);

        const { recalculatePlanMaterials } = require('./manufacturing-plans');
        let succeeded = 0, failed = 0;
        for (const planId of planIds) {
          try {
            await recalculatePlanMaterials(planId, false);
            succeeded++;
          } catch (error) {
            failed++;
            console.error(`[Migration 009] Failed to recalculate plan ${planId}:`, error);
          }
        }
        console.log(`[Migration 009] Done: ${succeeded} succeeded, ${failed} failed`);
      } catch (error) {
        // Never let this migration throw - a crashed migration blocks app startup entirely.
        console.error('[Migration 009] Unexpected error, skipping this migration run:', error);
      }
    },
    down: (db) => {
      console.log('[Migration 009] Rollback not implemented (recalculation is not reversible)');
    }
  },
  // ---------------------------------------------------------------------------
  // Migrations 010-018: folded from the previously-untracked ad-hoc "// Migration:"
  // blocks in character-database.js initializeCharacterDatabase(). Each preserves
  // its original pragma/sqlite_master guard so it is a safe no-op on live DBs that
  // already applied the ad-hoc version. See plan "Migration System Cleanup".
  // ---------------------------------------------------------------------------
  {
    id: '010_plan_blueprints_use_intermediates_text',
    description: 'Add use_intermediates (TEXT) column to plan_blueprints and normalize legacy INTEGER values',
    up: (db) => {
      console.log('[Migration 010] Ensuring use_intermediates column on plan_blueprints...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_blueprints'
      `).get();
      if (!tableExists) {
        console.log('[Migration 010] plan_blueprints table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        const columns = db.pragma('table_info(plan_blueprints)');
        const hasUseIntermediates = columns.some(col => col.name === 'use_intermediates');

        if (!hasUseIntermediates) {
          console.log('[Migration 010] Adding use_intermediates column (TEXT DEFAULT raw_materials)');
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN use_intermediates TEXT DEFAULT 'raw_materials'`);
        }

        // Normalize legacy INTEGER values (from the retired numbered migration 003,
        // which added this column as INTEGER DEFAULT 1) to canonical TEXT.
        //   1 / '1'  -> 'raw_materials'  (expand intermediates)
        //   0 / '0'  -> 'components'     (don't expand; buy the components)
        //   NULL and existing canonical TEXT values are left untouched.
        const rawResult = db.prepare(
          `UPDATE plan_blueprints SET use_intermediates = 'raw_materials'
           WHERE use_intermediates IN ('1', 1)`
        ).run();
        const compResult = db.prepare(
          `UPDATE plan_blueprints SET use_intermediates = 'components'
           WHERE use_intermediates IN ('0', 0)`
        ).run();
        if (rawResult.changes || compResult.changes) {
          console.log(`[Migration 010] Normalized use_intermediates: ${rawResult.changes} -> raw_materials, ${compResult.changes} -> components`);
        }

        db.exec('COMMIT');
        console.log('[Migration 010] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 010] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 010] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '011_plan_blueprints_intermediate_support',
    description: 'Add intermediate blueprint columns (parent_blueprint_id, is_intermediate, is_built, intermediate_product_type_id) to plan_blueprints',
    up: (db) => {
      console.log('[Migration 011] Ensuring intermediate blueprint columns on plan_blueprints...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_blueprints'
      `).get();
      if (!tableExists) {
        console.log('[Migration 011] plan_blueprints table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        const columns = db.pragma('table_info(plan_blueprints)');
        const hasParentBlueprintId = columns.some(col => col.name === 'parent_blueprint_id');
        const hasIsIntermediate = columns.some(col => col.name === 'is_intermediate');
        const hasIsBuilt = columns.some(col => col.name === 'is_built');
        const hasIntermediateProductTypeId = columns.some(col => col.name === 'intermediate_product_type_id');

        if (!hasParentBlueprintId) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN parent_blueprint_id TEXT`);
        }
        if (!hasIsIntermediate) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN is_intermediate INTEGER DEFAULT 0`);
        }
        if (!hasIsBuilt) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN is_built INTEGER DEFAULT 0`);
        }
        if (!hasIntermediateProductTypeId) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN intermediate_product_type_id INTEGER`);
        }

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_plan_blueprints_parent ON plan_blueprints(parent_blueprint_id);
          CREATE INDEX IF NOT EXISTS idx_plan_blueprints_intermediate ON plan_blueprints(is_intermediate);
        `);

        db.exec('COMMIT');
        console.log('[Migration 011] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 011] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 011] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '012_plan_blueprints_reaction_support',
    description: 'Add reaction columns (blueprint_type, reaction_type_id, built_runs) to plan_blueprints',
    up: (db) => {
      console.log('[Migration 012] Ensuring reaction columns on plan_blueprints...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_blueprints'
      `).get();
      if (!tableExists) {
        console.log('[Migration 012] plan_blueprints table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        const columns = db.pragma('table_info(plan_blueprints)');
        const hasBlueprintType = columns.some(col => col.name === 'blueprint_type');
        const hasReactionTypeId = columns.some(col => col.name === 'reaction_type_id');
        const hasBuiltRuns = columns.some(col => col.name === 'built_runs');

        if (!hasBlueprintType) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN blueprint_type TEXT NOT NULL DEFAULT 'manufacturing'`);
        }
        if (!hasReactionTypeId) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN reaction_type_id INTEGER`);
        }
        if (!hasBuiltRuns) {
          db.exec(`ALTER TABLE plan_blueprints ADD COLUMN built_runs INTEGER DEFAULT 0`);
        }

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_plan_blueprints_type ON plan_blueprints(blueprint_type);
        `);

        // Authoritative built_runs backfill: now that built_runs (this migration /
        // migration 006) and is_built / is_intermediate (migration 011) are all
        // guaranteed present, apply the "fully built => built_runs = runs" backfill
        // that migration 006 had to skip due to column-ordering. Idempotent: only
        // touches rows flagged fully built. On a fresh DB there are no rows, so no-op.
        const afterCols = db.pragma('table_info(plan_blueprints)');
        const canBackfill =
          afterCols.some(col => col.name === 'built_runs') &&
          afterCols.some(col => col.name === 'is_built') &&
          afterCols.some(col => col.name === 'is_intermediate');
        if (canBackfill) {
          db.exec(`
            UPDATE plan_blueprints
            SET built_runs = runs
            WHERE is_built = 1 AND is_intermediate = 1 AND (built_runs IS NULL OR built_runs = 0)
          `);
        }

        db.exec('COMMIT');
        console.log('[Migration 012] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 012] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 012] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '013_character_settings_table',
    description: 'Create character_settings table for per-character settings',
    up: (db) => {
      console.log('[Migration 013] Ensuring character_settings table...');

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS character_settings (
            character_id INTEGER PRIMARY KEY,
            enabled_divisions TEXT NOT NULL DEFAULT '[]',
            division_names TEXT,
            division_names_fetched_at INTEGER,
            division_names_cache_expires_at INTEGER,
            FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_character_settings_character
            ON character_settings(character_id)
        `);
        db.exec('COMMIT');
        console.log('[Migration 013] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 013] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 013] Rollback not implemented');
    }
  },
  {
    id: '014_plan_industry_settings_table',
    description: 'Create plan_industry_settings table for per-plan industry overrides',
    up: (db) => {
      console.log('[Migration 014] Ensuring plan_industry_settings table...');

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS plan_industry_settings (
            plan_id TEXT PRIMARY KEY,
            enabled_divisions_json TEXT NOT NULL DEFAULT '{}',
            default_characters_json TEXT NOT NULL DEFAULT '[]',
            reactions_as_intermediates INTEGER DEFAULT 0,
            last_updated INTEGER NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_plan_industry_settings_plan
            ON plan_industry_settings(plan_id)
        `);
        db.exec('COMMIT');
        console.log('[Migration 014] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 014] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 014] Rollback not implemented');
    }
  },
  {
    id: '015_plan_price_overrides_table',
    description: 'Create plan_price_overrides table for plan-scoped price overrides',
    up: (db) => {
      console.log('[Migration 015] Ensuring plan_price_overrides table...');

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS plan_price_overrides (
            plan_id TEXT NOT NULL,
            type_id INTEGER NOT NULL,
            price REAL NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (plan_id, type_id),
            FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_plan_price_overrides_plan
            ON plan_price_overrides(plan_id)
        `);
        db.exec('COMMIT');
        console.log('[Migration 015] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 015] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 015] Rollback not implemented');
    }
  },
  {
    id: '016_plan_price_overrides_last_market_price',
    description: 'Add last_market_price snapshot column to plan_price_overrides',
    up: (db) => {
      console.log('[Migration 016] Ensuring last_market_price column on plan_price_overrides...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_price_overrides'
      `).get();
      if (!tableExists) {
        console.log('[Migration 016] plan_price_overrides table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        const columns = db.pragma('table_info(plan_price_overrides)');
        const hasLastMarketPrice = columns.some(col => col.name === 'last_market_price');
        if (!hasLastMarketPrice) {
          db.exec(`ALTER TABLE plan_price_overrides ADD COLUMN last_market_price REAL`);
        }
        db.exec('COMMIT');
        console.log('[Migration 016] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 016] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 016] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '017_industry_jobs_corporation_support',
    description: 'Add corporation columns (is_corporation, corporation_id) to esi_industry_jobs',
    up: (db) => {
      console.log('[Migration 017] Ensuring corporation columns on esi_industry_jobs...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='esi_industry_jobs'
      `).get();
      if (!tableExists) {
        console.log('[Migration 017] esi_industry_jobs table does not exist, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        const columns = db.pragma('table_info(esi_industry_jobs)');
        const hasIsCorporation = columns.some(col => col.name === 'is_corporation');
        const hasCorporationId = columns.some(col => col.name === 'corporation_id');

        if (!hasIsCorporation) {
          db.exec(`ALTER TABLE esi_industry_jobs ADD COLUMN is_corporation INTEGER DEFAULT 0`);
        }
        if (!hasCorporationId) {
          db.exec(`ALTER TABLE esi_industry_jobs ADD COLUMN corporation_id INTEGER`);
        }

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_industry_jobs_corporation ON esi_industry_jobs(corporation_id);
          CREATE INDEX IF NOT EXISTS idx_industry_jobs_is_corp ON esi_industry_jobs(is_corporation);
        `);

        db.exec('COMMIT');
        console.log('[Migration 017] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 017] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 017] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '018_blueprints_composite_primary_key',
    description: 'Migrate blueprints and blueprint_overrides to composite primary key (character_id, item_id)',
    up: (db) => {
      // Self-guarded: no-op if the composite PK already exists. Manages its own
      // foreign_keys pragma and transaction (table rebuild pattern). Folded from
      // migrateBlueprints_v2() in character-database.js.
      console.log('[Migration 018] Ensuring blueprints composite primary key...');

      const blueprintsExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='blueprints'
      `).get();
      if (!blueprintsExists) {
        console.log('[Migration 018] blueprints table does not exist, skipping');
        return;
      }

      const tableInfo = db.prepare('PRAGMA table_info(blueprints)').all();
      const pkColumns = tableInfo.filter(col => col.pk > 0).map(col => col.name);
      if (pkColumns.length === 2 && pkColumns.includes('character_id') && pkColumns.includes('item_id')) {
        console.log('[Migration 018] Blueprints table already has composite primary key, skipping');
        return;
      }

      // Disable foreign keys BEFORE transaction (SQLite requirement for table swap).
      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN TRANSACTION;

          CREATE TEMP TABLE temp_overrides_backup AS
          SELECT b.character_id, bo.item_id, bo.field, bo.value
          FROM blueprint_overrides bo
          JOIN blueprints b ON b.item_id = bo.item_id;

          DROP TABLE blueprint_overrides;

          CREATE TABLE blueprints_new (
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
          );

          INSERT INTO blueprints_new
          SELECT * FROM blueprints;

          DROP TABLE blueprints;
          ALTER TABLE blueprints_new RENAME TO blueprints;

          CREATE INDEX idx_blueprints_character ON blueprints(character_id);
          CREATE INDEX idx_blueprints_type ON blueprints(type_id);
          CREATE INDEX idx_blueprints_source ON blueprints(character_id, source);

          CREATE TABLE blueprint_overrides (
            character_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (character_id, item_id, field),
            FOREIGN KEY (character_id, item_id) REFERENCES blueprints(character_id, item_id) ON DELETE CASCADE
          );

          INSERT INTO blueprint_overrides (character_id, item_id, field, value)
          SELECT character_id, item_id, field, value
          FROM temp_overrides_backup;

          DROP TABLE temp_overrides_backup;

          COMMIT;
        `);
        db.pragma('foreign_keys = ON');
        console.log('[Migration 018] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        db.pragma('foreign_keys = ON');
        console.error('[Migration 018] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 018] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '019_ledger_source_and_cost_columns',
    description: 'Rebuild plan_material_ledger: add source-link + cost columns, widen event_type CHECK to include \'cost\', add unique source index',
    up: (db) => {
      // Table rebuild (SQLite can't ALTER a CHECK constraint). Adds:
      //   source_type, source_id, character_id, corporation_id, cost_category
      // and widens event_type to include 'cost' (a pure spend row: quantity=0,
      // unit_price = ISK amount). Idempotent: skips if event_type already allows 'cost'.
      console.log('[Migration 019] Ensuring plan_material_ledger source/cost columns...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_material_ledger'
      `).get();
      if (!tableExists) {
        console.log('[Migration 019] plan_material_ledger table does not exist, skipping');
        return;
      }

      // Guard: if the table already has the new cost_category column, assume migrated.
      const cols = db.prepare('PRAGMA table_info(plan_material_ledger)').all();
      if (cols.some(c => c.name === 'cost_category')) {
        console.log('[Migration 019] plan_material_ledger already migrated, skipping');
        return;
      }

      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN TRANSACTION;

          CREATE TABLE plan_material_ledger_new (
            ledger_id      TEXT    PRIMARY KEY,
            plan_id        TEXT    NOT NULL,
            type_id        INTEGER NOT NULL,
            event_type     TEXT    NOT NULL CHECK(event_type IN ('acquired','deducted','adjusted','cost')),
            quantity       REAL    NOT NULL,
            method         TEXT    NOT NULL CHECK(method IN ('manual','purchased','manufactured','allocated','cost')),
            unit_price     REAL,
            note           TEXT,
            source_ref     TEXT,
            source_type    TEXT,
            source_id      INTEGER,
            character_id   INTEGER,
            corporation_id INTEGER,
            cost_category  TEXT,
            created_at     INTEGER NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
          );

          INSERT INTO plan_material_ledger_new
            (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
          SELECT ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at
          FROM plan_material_ledger;

          DROP TABLE plan_material_ledger;
          ALTER TABLE plan_material_ledger_new RENAME TO plan_material_ledger;

          CREATE INDEX idx_pml_plan    ON plan_material_ledger(plan_id);
          CREATE INDEX idx_pml_type    ON plan_material_ledger(plan_id, type_id);
          CREATE INDEX idx_pml_created ON plan_material_ledger(created_at);
          CREATE UNIQUE INDEX idx_pml_source
            ON plan_material_ledger(plan_id, source_type, source_id)
            WHERE source_id IS NOT NULL;

          COMMIT;
        `);
        db.pragma('foreign_keys = ON');
        console.log('[Migration 019] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        db.pragma('foreign_keys = ON');
        console.error('[Migration 019] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 019] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '020_industry_jobs_cost_and_product',
    description: 'Add cost REAL and product_type_id INTEGER to esi_industry_jobs',
    up: (db) => {
      console.log('[Migration 020] Ensuring cost/product_type_id columns on esi_industry_jobs...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='esi_industry_jobs'
      `).get();
      if (!tableExists) {
        console.log('[Migration 020] esi_industry_jobs table does not exist, skipping');
        return;
      }

      const cols = db.prepare('PRAGMA table_info(esi_industry_jobs)').all().map(c => c.name);
      db.exec('BEGIN TRANSACTION');
      try {
        if (!cols.includes('cost')) {
          db.exec('ALTER TABLE esi_industry_jobs ADD COLUMN cost REAL');
          console.log('[Migration 020] Added esi_industry_jobs.cost');
        }
        if (!cols.includes('product_type_id')) {
          db.exec('ALTER TABLE esi_industry_jobs ADD COLUMN product_type_id INTEGER');
          console.log('[Migration 020] Added esi_industry_jobs.product_type_id');
        }
        db.exec('COMMIT');
        console.log('[Migration 020] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 020] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 020] Rollback not implemented (ALTER DROP COLUMN unsupported on older SQLite)');
    }
  },
  {
    id: '021_wallet_corporation_support',
    description: 'Rebuild esi_wallet_transactions with composite PK + corp/division + client_id/journal_ref_id columns',
    up: (db) => {
      // Rebuild to a composite PK (transaction_id, character_id, is_corporation) —
      // corp and character transaction_ids can collide, so the bare PK is unsafe as
      // the durable-log upsert conflict target. Also add corp columns + the two
      // previously-dropped ESI fields (client_id, journal_ref_id).
      console.log('[Migration 021] Ensuring esi_wallet_transactions corp support...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='esi_wallet_transactions'
      `).get();
      if (!tableExists) {
        console.log('[Migration 021] esi_wallet_transactions table does not exist, skipping');
        return;
      }

      // Guard: composite PK present AND new columns present → already migrated.
      const info = db.prepare('PRAGMA table_info(esi_wallet_transactions)').all();
      const pkCols = info.filter(c => c.pk > 0).map(c => c.name);
      const colNames = info.map(c => c.name);
      const alreadyMigrated = pkCols.length === 3
        && pkCols.includes('transaction_id') && pkCols.includes('character_id') && pkCols.includes('is_corporation')
        && colNames.includes('client_id') && colNames.includes('journal_ref_id');
      if (alreadyMigrated) {
        console.log('[Migration 021] esi_wallet_transactions already migrated, skipping');
        return;
      }

      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN TRANSACTION;

          CREATE TABLE esi_wallet_transactions_new (
            transaction_id INTEGER NOT NULL,
            character_id INTEGER NOT NULL,
            is_corporation INTEGER NOT NULL DEFAULT 0,
            corporation_id INTEGER,
            division INTEGER,
            date INTEGER NOT NULL,
            type_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            location_id INTEGER NOT NULL,
            is_buy INTEGER NOT NULL,
            is_personal INTEGER,
            client_id INTEGER,
            journal_ref_id INTEGER,
            last_updated INTEGER NOT NULL,
            cache_expires_at INTEGER,
            PRIMARY KEY (transaction_id, character_id, is_corporation)
          );

          INSERT INTO esi_wallet_transactions_new
            (transaction_id, character_id, is_corporation, date, type_id, quantity,
             unit_price, location_id, is_buy, is_personal, last_updated, cache_expires_at)
          SELECT transaction_id, character_id, 0, date, type_id, quantity,
                 unit_price, location_id, is_buy, is_personal, last_updated, cache_expires_at
          FROM esi_wallet_transactions;

          DROP TABLE esi_wallet_transactions;
          ALTER TABLE esi_wallet_transactions_new RENAME TO esi_wallet_transactions;

          CREATE INDEX idx_wallet_transactions_character ON esi_wallet_transactions(character_id);
          CREATE INDEX idx_wallet_transactions_type ON esi_wallet_transactions(type_id);
          CREATE INDEX idx_wallet_transactions_corp ON esi_wallet_transactions(corporation_id, is_corporation);
          CREATE INDEX idx_wallet_transactions_journal_ref ON esi_wallet_transactions(journal_ref_id);

          COMMIT;
        `);
        db.pragma('foreign_keys = ON');
        console.log('[Migration 021] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        db.pragma('foreign_keys = ON');
        console.error('[Migration 021] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 021] Rollback not implemented (would require table recreation)');
    }
  },
  {
    id: '022_wallet_journal_table',
    description: 'Create esi_wallet_journal table (character + corp ISK-movement log, source of truth for fees)',
    up: (db) => {
      console.log('[Migration 022] Ensuring esi_wallet_journal table...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='esi_wallet_journal'
      `).get();
      if (tableExists) {
        console.log('[Migration 022] esi_wallet_journal already exists, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE esi_wallet_journal (
            id INTEGER NOT NULL,
            character_id INTEGER NOT NULL,
            is_corporation INTEGER NOT NULL DEFAULT 0,
            corporation_id INTEGER,
            division INTEGER,
            date INTEGER NOT NULL,
            ref_type TEXT NOT NULL,
            amount REAL,
            balance REAL,
            context_id INTEGER,
            context_id_type TEXT,
            first_party_id INTEGER,
            second_party_id INTEGER,
            reason TEXT,
            tax REAL,
            tax_receiver_id INTEGER,
            last_updated INTEGER NOT NULL,
            cache_expires_at INTEGER,
            PRIMARY KEY (id, character_id, is_corporation)
          );

          CREATE INDEX idx_wallet_journal_ref_type ON esi_wallet_journal(ref_type);
          CREATE INDEX idx_wallet_journal_context ON esi_wallet_journal(context_id);
          CREATE INDEX idx_wallet_journal_owner ON esi_wallet_journal(character_id, is_corporation, corporation_id);
        `);
        db.exec('COMMIT');
        console.log('[Migration 022] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 022] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 022] Rollback: DROP TABLE esi_wallet_journal');
      db.exec('DROP TABLE IF EXISTS esi_wallet_journal');
    }
  },
  {
    id: '023_transaction_matches_is_corporation',
    description: 'Add is_corporation to plan_transaction_matches so matches disambiguate char vs corp wallet rows (composite wallet PK)',
    up: (db) => {
      console.log('[Migration 023] Ensuring is_corporation on plan_transaction_matches...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_transaction_matches'
      `).get();
      if (!tableExists) {
        console.log('[Migration 023] plan_transaction_matches table does not exist, skipping');
        return;
      }

      const cols = db.prepare('PRAGMA table_info(plan_transaction_matches)').all().map(c => c.name);
      if (cols.includes('is_corporation')) {
        console.log('[Migration 023] is_corporation already present, skipping');
        return;
      }

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec('ALTER TABLE plan_transaction_matches ADD COLUMN is_corporation INTEGER DEFAULT 0');
        db.exec('COMMIT');
        console.log('[Migration 023] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 023] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 023] Rollback not implemented (ALTER DROP COLUMN unsupported on older SQLite)');
    }
  },
  {
    id: '024_ledger_sold_event_type',
    description: 'Rebuild plan_material_ledger: widen event_type/method CHECK to include \'sold\' (product-sale rows so they can be viewed/unlinked from the Ledger)',
    up: (db) => {
      // Table rebuild (SQLite can't ALTER a CHECK constraint). Adds 'sold' to
      // both the event_type and method CHECK sets. Columns are unchanged.
      console.log('[Migration 024] Ensuring plan_material_ledger allows \'sold\'...');

      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='plan_material_ledger'
      `).get();
      if (!tableExists) {
        console.log('[Migration 024] plan_material_ledger table does not exist, skipping');
        return;
      }

      // Guard: if the current table definition already allows 'sold', skip.
      const ddl = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_material_ledger'
      `).get();
      if (ddl && ddl.sql && ddl.sql.includes("'sold'")) {
        console.log('[Migration 024] plan_material_ledger already allows \'sold\', skipping');
        return;
      }

      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN TRANSACTION;

          CREATE TABLE plan_material_ledger_new (
            ledger_id      TEXT    PRIMARY KEY,
            plan_id        TEXT    NOT NULL,
            type_id        INTEGER NOT NULL,
            event_type     TEXT    NOT NULL CHECK(event_type IN ('acquired','deducted','adjusted','cost','sold')),
            quantity       REAL    NOT NULL,
            method         TEXT    NOT NULL CHECK(method IN ('manual','purchased','manufactured','allocated','cost','sold')),
            unit_price     REAL,
            note           TEXT,
            source_ref     TEXT,
            source_type    TEXT,
            source_id      INTEGER,
            character_id   INTEGER,
            corporation_id INTEGER,
            cost_category  TEXT,
            created_at     INTEGER NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
          );

          INSERT INTO plan_material_ledger_new
            (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note,
             source_ref, source_type, source_id, character_id, corporation_id, cost_category, created_at)
          SELECT ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note,
             source_ref, source_type, source_id, character_id, corporation_id, cost_category, created_at
          FROM plan_material_ledger;

          DROP TABLE plan_material_ledger;
          ALTER TABLE plan_material_ledger_new RENAME TO plan_material_ledger;

          CREATE INDEX idx_pml_plan    ON plan_material_ledger(plan_id);
          CREATE INDEX idx_pml_type    ON plan_material_ledger(plan_id, type_id);
          CREATE INDEX idx_pml_created ON plan_material_ledger(created_at);
          CREATE UNIQUE INDEX idx_pml_source
            ON plan_material_ledger(plan_id, source_type, source_id)
            WHERE source_id IS NOT NULL;

          COMMIT;
        `);
        db.pragma('foreign_keys = ON');
        console.log('[Migration 024] Completed successfully');
      } catch (error) {
        db.exec('ROLLBACK');
        db.pragma('foreign_keys = ON');
        console.error('[Migration 024] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      console.log('[Migration 024] Rollback not implemented (would require table recreation)');
    }
  }
  // Add future migrations here
];

/**
 * Initialize the migrations table to track applied migrations
 * @param {Database} db - Database instance
 */
function initializeMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

/**
 * Get list of applied migrations
 * @param {Database} db - Database instance
 * @returns {string[]} Array of applied migration IDs
 */
function getAppliedMigrations(db) {
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY applied_at').all();
  return rows.map(row => row.id);
}

/**
 * Mark a migration as applied
 * @param {Database} db - Database instance
 * @param {string} id - Migration ID
 * @param {string} description - Migration description
 */
function markMigrationApplied(db, id, description) {
  db.prepare(`
    INSERT INTO schema_migrations (id, description, applied_at)
    VALUES (?, ?, ?)
  `).run(id, description, Date.now());
}

/**
 * Check if migrations are needed
 * @returns {boolean} True if migrations are needed
 */
function needsSchemaMigrations() {
  try {
    const db = getCharacterDatabase();
    initializeMigrationsTable(db);

    const appliedMigrations = getAppliedMigrations(db);
    const pendingMigrations = migrations.filter(m => !appliedMigrations.includes(m.id));

    if (pendingMigrations.length > 0) {
      console.log(`[Schema Migrations] ${pendingMigrations.length} pending migration(s):`,
        pendingMigrations.map(m => m.id));
      return true;
    }

    console.log('[Schema Migrations] No pending migrations');
    return false;
  } catch (error) {
    console.error('[Schema Migrations] Error checking migrations:', error);
    return false;
  }
}

/**
 * Run all pending database migrations
 * @returns {Promise<void>}
 */
async function runSchemaMigrations() {
  console.log('[Schema Migrations] Starting schema migrations...');

  const db = getCharacterDatabase();

  try {
    // Ensure migrations table exists
    initializeMigrationsTable(db);

    // Get applied migrations
    const appliedMigrations = getAppliedMigrations(db);
    console.log('[Schema Migrations] Applied migrations:', appliedMigrations);

    // Filter pending migrations
    const pendingMigrations = migrations.filter(m => !appliedMigrations.includes(m.id));

    if (pendingMigrations.length === 0) {
      console.log('[Schema Migrations] No pending migrations');
      return;
    }

    console.log(`[Schema Migrations] Running ${pendingMigrations.length} pending migration(s)...`);

    // Run each pending migration
    for (const migration of pendingMigrations) {
      console.log(`[Schema Migrations] Running migration: ${migration.id} - ${migration.description}`);

      try {
        // Run the migration
        await migration.up(db);

        // Mark as applied
        markMigrationApplied(db, migration.id, migration.description);

        console.log(`[Schema Migrations] Migration ${migration.id} completed successfully`);
      } catch (error) {
        console.error(`[Schema Migrations] Migration ${migration.id} failed:`, error);
        throw new Error(`Migration ${migration.id} failed: ${error.message}`);
      }
    }

    console.log('[Schema Migrations] All migrations completed successfully');
  } catch (error) {
    console.error('[Schema Migrations] Migration process failed:', error);
    throw error;
  }
}

/**
 * Get migration status information
 * @returns {Object} Migration status
 */
function getMigrationStatus() {
  try {
    const db = getCharacterDatabase();
    initializeMigrationsTable(db);

    const appliedMigrations = getAppliedMigrations(db);
    const pendingMigrations = migrations.filter(m => !appliedMigrations.includes(m.id));

    return {
      total: migrations.length,
      applied: appliedMigrations.length,
      pending: pendingMigrations.length,
      appliedList: appliedMigrations,
      pendingList: pendingMigrations.map(m => ({ id: m.id, description: m.description }))
    };
  } catch (error) {
    console.error('[Schema Migrations] Error getting status:', error);
    return {
      total: 0,
      applied: 0,
      pending: 0,
      appliedList: [],
      pendingList: [],
      error: error.message
    };
  }
}

module.exports = {
  needsSchemaMigrations,
  runSchemaMigrations,
  getMigrationStatus,
  // Export for testing
  migrations,
};
