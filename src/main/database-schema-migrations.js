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

        // Add new column - default to 1 (TRUE) for existing blueprints to maintain current behavior
        db.exec('ALTER TABLE plan_blueprints ADD COLUMN use_intermediates INTEGER DEFAULT 1');

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
      console.log('[Migration 004] Rollback not implemented (would require table recreation)');
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

        // Migrate existing data: if is_built=1, set built_runs to runs (fully built)
        db.exec(`
          UPDATE plan_blueprints
          SET built_runs = runs
          WHERE is_built = 1 AND is_intermediate = 1
        `);

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
