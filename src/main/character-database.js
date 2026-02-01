const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getConfigDir } = require('./config-migration');

let db = null;

/**
 * Get the character database connection
 * @returns {Database} Database instance
 */
function getCharacterDatabase() {
  if (db) return db;

  const configDir = getConfigDir();

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log('[Character Database] Created config directory:', configDir);
  }

  const dbPath = path.join(configDir, 'character-data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * Initialize the character database with all tables
 * @returns {Database} Initialized database instance
 */
function initializeCharacterDatabase() {
  const database = getCharacterDatabase();

  console.log('[Character Database] Initializing schema...');

  // Characters table (auth + metadata)
  database.exec(`
    CREATE TABLE IF NOT EXISTS characters (
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

  // Skills table
  database.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      character_id INTEGER NOT NULL,
      skill_id INTEGER NOT NULL,
      active_skill_level INTEGER NOT NULL,
      trained_skill_level INTEGER NOT NULL,
      skillpoints_in_skill INTEGER NOT NULL,
      PRIMARY KEY (character_id, skill_id),
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  // Skills metadata (per character)
  database.exec(`
    CREATE TABLE IF NOT EXISTS skills_metadata (
      character_id INTEGER PRIMARY KEY,
      total_sp INTEGER NOT NULL,
      unallocated_sp INTEGER NOT NULL,
      last_updated INTEGER NOT NULL,
      cache_expires_at INTEGER,
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  // Skill overrides
  database.exec(`
    CREATE TABLE IF NOT EXISTS skill_overrides (
      character_id INTEGER NOT NULL,
      skill_id INTEGER NOT NULL,
      override_level INTEGER NOT NULL,
      PRIMARY KEY (character_id, skill_id),
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  // Blueprints table
  database.exec(`
    CREATE TABLE IF NOT EXISTS blueprints (
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

  // Blueprint overrides
  database.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_overrides (
      character_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (character_id, item_id, field),
      FOREIGN KEY (character_id, item_id) REFERENCES blueprints(character_id, item_id) ON DELETE CASCADE
    )
  `);

  // Assets table (for Phase 4)
  database.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      item_id TEXT,
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
      PRIMARY KEY (character_id, item_id),
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  // Manufacturing Plans tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS manufacturing_plans (
      plan_id TEXT PRIMARY KEY,
      character_id INTEGER NOT NULL,
      plan_name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
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
      added_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_materials (
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      base_price REAL,
      price_frozen_at INTEGER,
      PRIMARY KEY (plan_id, type_id),
      FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_products (
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      base_price REAL,
      price_frozen_at INTEGER,
      PRIMARY KEY (plan_id, type_id),
      FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_asset_allocations (
      allocation_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      is_corporation INTEGER DEFAULT 0,
      allocated_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS esi_industry_jobs (
      job_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      installer_id INTEGER NOT NULL,
      facility_id INTEGER NOT NULL,
      activity_id INTEGER NOT NULL,
      blueprint_type_id INTEGER NOT NULL,
      runs INTEGER NOT NULL,
      status TEXT NOT NULL,
      start_date INTEGER,
      end_date INTEGER,
      completed_date INTEGER,
      last_updated INTEGER NOT NULL,
      cache_expires_at INTEGER,
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS esi_wallet_transactions (
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
      cache_expires_at INTEGER,
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_job_matches (
      match_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_blueprint_id TEXT NOT NULL,
      job_id INTEGER NOT NULL,
      match_confidence REAL NOT NULL,
      match_reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      confirmed_at INTEGER,
      confirmed_by_user INTEGER DEFAULT 0,
      FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_transaction_matches (
      match_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      transaction_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      match_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      match_confidence REAL NOT NULL,
      match_reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      confirmed_at INTEGER,
      confirmed_by_user INTEGER DEFAULT 0,
      FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
    )
  `);

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_skills_character ON skills(character_id);
    CREATE INDEX IF NOT EXISTS idx_blueprints_character ON blueprints(character_id);
    CREATE INDEX IF NOT EXISTS idx_blueprints_type ON blueprints(type_id);
    CREATE INDEX IF NOT EXISTS idx_blueprints_source ON blueprints(character_id, source);
    CREATE INDEX IF NOT EXISTS idx_assets_character ON assets(character_id);
    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type_id);
    CREATE INDEX IF NOT EXISTS idx_assets_location ON assets(location_id);
    CREATE INDEX IF NOT EXISTS idx_plans_character ON manufacturing_plans(character_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status ON manufacturing_plans(status);
    CREATE INDEX IF NOT EXISTS idx_plan_blueprints_plan ON plan_blueprints(plan_id);
    CREATE INDEX IF NOT EXISTS idx_industry_jobs_character ON esi_industry_jobs(character_id);
    CREATE INDEX IF NOT EXISTS idx_industry_jobs_blueprint ON esi_industry_jobs(blueprint_type_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_character ON esi_wallet_transactions(character_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_type ON esi_wallet_transactions(type_id);
    CREATE INDEX IF NOT EXISTS idx_job_matches_plan ON plan_job_matches(plan_id);
    CREATE INDEX IF NOT EXISTS idx_job_matches_status ON plan_job_matches(status);
    CREATE INDEX IF NOT EXISTS idx_transaction_matches_plan ON plan_transaction_matches(plan_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_matches_status ON plan_transaction_matches(status);
  `);

  // Migration: Add use_intermediates column to plan_blueprints if it doesn't exist
  // This column stores the build plan strategy: 'raw_materials', 'components', or 'build_buy'
  try {
    const columns = database.pragma('table_info(plan_blueprints)');
    const hasUseIntermediates = columns.some(col => col.name === 'use_intermediates');

    if (!hasUseIntermediates) {
      console.log('[Character Database] Adding use_intermediates column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN use_intermediates TEXT DEFAULT 'raw_materials'`);
    }
  } catch (error) {
    console.error('[Character Database] Migration error:', error);
  }

  // Migration: Add is_intermediate column to plan_products if it doesn't exist
  // This column tracks whether a product is an intermediate component or final product
  try {
    const columns = database.pragma('table_info(plan_products)');
    const hasIsIntermediate = columns.some(col => col.name === 'is_intermediate');

    if (!hasIsIntermediate) {
      console.log('[Character Database] Adding is_intermediate column to plan_products table');
      database.exec(`ALTER TABLE plan_products ADD COLUMN is_intermediate INTEGER DEFAULT 0`);
    }
  } catch (error) {
    console.error('[Character Database] Migration error:', error);
  }

  // Migration: Add intermediate blueprint support to plan_blueprints
  try {
    const columns = database.pragma('table_info(plan_blueprints)');
    const hasParentBlueprintId = columns.some(col => col.name === 'parent_blueprint_id');
    const hasIsIntermediate = columns.some(col => col.name === 'is_intermediate');
    const hasIsBuilt = columns.some(col => col.name === 'is_built');
    const hasIntermediateProductTypeId = columns.some(col => col.name === 'intermediate_product_type_id');

    if (!hasParentBlueprintId) {
      console.log('[Character Database] Adding parent_blueprint_id column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN parent_blueprint_id TEXT`);
    }

    if (!hasIsIntermediate) {
      console.log('[Character Database] Adding is_intermediate column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN is_intermediate INTEGER DEFAULT 0`);
    }

    if (!hasIsBuilt) {
      console.log('[Character Database] Adding is_built column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN is_built INTEGER DEFAULT 0`);
    }

    if (!hasIntermediateProductTypeId) {
      console.log('[Character Database] Adding intermediate_product_type_id column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN intermediate_product_type_id INTEGER`);
    }

    // Create indexes for intermediate blueprint columns (only if columns exist)
    if (hasParentBlueprintId || hasIsIntermediate) {
      console.log('[Character Database] Creating indexes for intermediate blueprint columns');
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_plan_blueprints_parent ON plan_blueprints(parent_blueprint_id);
        CREATE INDEX IF NOT EXISTS idx_plan_blueprints_intermediate ON plan_blueprints(is_intermediate);
      `);
    }
  } catch (error) {
    console.error('[Character Database] Intermediate blueprint migration error:', error);
  }

  // Migration: Add intermediate_depth column to plan_products
  // This column tracks the depth level of intermediates (0=final, 1=level 1 intermediate, 2=level 2, etc.)
  try {
    const columns = database.pragma('table_info(plan_products)');
    const hasIntermediateDepth = columns.some(col => col.name === 'intermediate_depth');

    if (!hasIntermediateDepth) {
      console.log('[Character Database] Adding intermediate_depth column to plan_products table');
      database.exec(`ALTER TABLE plan_products ADD COLUMN intermediate_depth INTEGER DEFAULT 0`);
    }
  } catch (error) {
    console.error('[Character Database] Migration error:', error);
  }

  // Migration: Add reaction support to plan_blueprints
  // blueprint_type column differentiates 'manufacturing' from 'reaction'
  // reaction_type_id stores the reactionTypeId for reactions (NULL for manufacturing)
  try {
    const columns = database.pragma('table_info(plan_blueprints)');
    const hasBlueprintType = columns.some(col => col.name === 'blueprint_type');
    const hasReactionTypeId = columns.some(col => col.name === 'reaction_type_id');
    const hasBuiltRuns = columns.some(col => col.name === 'built_runs');

    if (!hasBlueprintType) {
      console.log('[Character Database] Adding blueprint_type column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN blueprint_type TEXT NOT NULL DEFAULT 'manufacturing'`);
    }

    if (!hasReactionTypeId) {
      console.log('[Character Database] Adding reaction_type_id column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN reaction_type_id INTEGER`);
    }

    if (!hasBuiltRuns) {
      console.log('[Character Database] Adding built_runs column to plan_blueprints table');
      database.exec(`ALTER TABLE plan_blueprints ADD COLUMN built_runs INTEGER DEFAULT 0`);
    }

    // Create index for blueprint_type to efficiently filter reactions vs manufacturing
    if (hasBlueprintType) {
      console.log('[Character Database] Creating index for blueprint_type column');
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_plan_blueprints_type ON plan_blueprints(blueprint_type);
      `);
    }
  } catch (error) {
    console.error('[Character Database] Reaction support migration error:', error);
  }

  // Migration: Create character_settings table for per-character settings
  try {
    const tableExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='character_settings'").all();

    if (!tableExists || tableExists.length === 0) {
      console.log('[Character Database] Creating character_settings table');

      // Create table
      database.exec(`
        CREATE TABLE IF NOT EXISTS character_settings (
          character_id INTEGER PRIMARY KEY,
          enabled_divisions TEXT NOT NULL DEFAULT '[]',
          division_names TEXT,
          division_names_fetched_at INTEGER,
          division_names_cache_expires_at INTEGER,
          FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
        )
      `);

      // Create index
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_character_settings_character
          ON character_settings(character_id)
      `);

      console.log('[Character Database] Character settings table created successfully');
    }
  } catch (error) {
    console.error('[Character Database] Character settings migration error:', error);
  }

  // Migration: Create plan_industry_settings table for per-plan industry overrides
  try {
    const tableExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_industry_settings'").all();

    if (!tableExists || tableExists.length === 0) {
      console.log('[Character Database] Creating plan_industry_settings table');

      // Create table
      database.exec(`
        CREATE TABLE IF NOT EXISTS plan_industry_settings (
          plan_id TEXT PRIMARY KEY,
          enabled_divisions_json TEXT NOT NULL DEFAULT '{}',
          default_characters_json TEXT NOT NULL DEFAULT '[]',
          reactions_as_intermediates INTEGER DEFAULT 0,
          last_updated INTEGER NOT NULL,
          FOREIGN KEY (plan_id) REFERENCES manufacturing_plans(plan_id) ON DELETE CASCADE
        )
      `);

      // Create index
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_plan_industry_settings_plan
          ON plan_industry_settings(plan_id)
      `);

      console.log('[Character Database] Plan industry settings table created successfully');
    }
  } catch (error) {
    console.error('[Character Database] Plan industry settings migration error:', error);
  }

  // Migration: Add corporation industry jobs support to esi_industry_jobs table
  try {
    const columns = database.pragma('table_info(esi_industry_jobs)');
    const hasIsCorporation = columns.some(col => col.name === 'is_corporation');
    const hasCorporationId = columns.some(col => col.name === 'corporation_id');

    if (!hasIsCorporation) {
      console.log('[Character Database] Adding is_corporation column to esi_industry_jobs table');
      database.exec(`ALTER TABLE esi_industry_jobs ADD COLUMN is_corporation INTEGER DEFAULT 0`);
    }

    if (!hasCorporationId) {
      console.log('[Character Database] Adding corporation_id column to esi_industry_jobs table');
      database.exec(`ALTER TABLE esi_industry_jobs ADD COLUMN corporation_id INTEGER`);
    }

    // Create indexes for corporation job queries
    if (!hasIsCorporation || !hasCorporationId) {
      console.log('[Character Database] Creating indexes for corporation industry job columns');
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_industry_jobs_corporation ON esi_industry_jobs(corporation_id);
        CREATE INDEX IF NOT EXISTS idx_industry_jobs_is_corp ON esi_industry_jobs(is_corporation);
      `);
    }
  } catch (error) {
    console.error('[Character Database] Corporation industry jobs migration error:', error);
  }

  // Migration: Migrate blueprints and blueprint_overrides to composite primary key
  migrateBlueprints_v2();

  console.log('[Character Database] Schema initialized successfully');
  return database;
}

/**
 * Migrate blueprints table to use composite primary key (character_id, item_id)
 * This fixes the issue where multiple characters in same corp can't sync blueprints
 * due to shared ESI item_ids for corporation blueprints
 */
function migrateBlueprints_v2() {
  try {
    const database = getCharacterDatabase();

    // Check if migration needed (test if composite key exists)
    const tableInfo = database.prepare("PRAGMA table_info(blueprints)").all();
    const pkColumns = tableInfo.filter(col => col.pk > 0).map(col => col.name);

    // If already composite key (character_id, item_id), skip migration
    if (pkColumns.length === 2 && pkColumns.includes('character_id') && pkColumns.includes('item_id')) {
      console.log('[Character Database] Blueprints table already migrated to v2');
      return;
    }

    console.log('[Character Database] Migrating blueprints table to composite primary key...');

    // Disable foreign keys BEFORE transaction
    database.pragma('foreign_keys = OFF');

    database.exec(`
      BEGIN TRANSACTION;

      -- STEP 1: Backup existing overrides data with character_id from blueprints
      CREATE TEMP TABLE temp_overrides_backup AS
      SELECT b.character_id, bo.item_id, bo.field, bo.value
      FROM blueprint_overrides bo
      JOIN blueprints b ON b.item_id = bo.item_id;

      -- STEP 2: Drop old blueprint_overrides table (has FK to old blueprints)
      DROP TABLE blueprint_overrides;

      -- STEP 3: Migrate blueprints table
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

      -- Copy existing blueprints data
      INSERT INTO blueprints_new
      SELECT * FROM blueprints;

      -- Drop old blueprints table
      DROP TABLE blueprints;

      -- Rename new table
      ALTER TABLE blueprints_new RENAME TO blueprints;

      -- Recreate blueprints indexes
      CREATE INDEX idx_blueprints_character ON blueprints(character_id);
      CREATE INDEX idx_blueprints_type ON blueprints(type_id);
      CREATE INDEX idx_blueprints_source ON blueprints(character_id, source);

      -- STEP 4: Create new blueprint_overrides table with composite FK
      CREATE TABLE blueprint_overrides (
        character_id INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (character_id, item_id, field),
        FOREIGN KEY (character_id, item_id) REFERENCES blueprints(character_id, item_id) ON DELETE CASCADE
      );

      -- STEP 5: Restore overrides data from backup
      INSERT INTO blueprint_overrides (character_id, item_id, field, value)
      SELECT character_id, item_id, field, value
      FROM temp_overrides_backup;

      -- Clean up temp table
      DROP TABLE temp_overrides_backup;

      COMMIT;
    `);

    // Re-enable foreign keys AFTER transaction
    database.pragma('foreign_keys = ON');

    console.log('[Character Database] Blueprints table migration complete');
  } catch (error) {
    console.error('[Character Database] Migration failed:', error);
    const database = getCharacterDatabase();
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Close the character database connection
 */
function closeCharacterDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[Character Database] Connection closed');
  }
}

/**
 * Migrate existing manufacturing_plans to have settings
 * Copy from global industry settings
 */
function migrateExistingPlansToSettings() {
  try {
    const database = getCharacterDatabase();
    const { loadSettings } = require('./settings-manager');
    const settings = loadSettings();

    // Get all existing plans that don't have settings yet
    const plansWithoutSettings = database.prepare(`
      SELECT mp.plan_id, mp.character_id
      FROM manufacturing_plans mp
      LEFT JOIN plan_industry_settings pis ON mp.plan_id = pis.plan_id
      WHERE pis.plan_id IS NULL
    `).all();

    if (plansWithoutSettings.length === 0) {
      console.log('[Migration] No plans to migrate for industry settings');
      return;
    }

    console.log(`[Migration] Migrating ${plansWithoutSettings.length} plans to have industry settings`);

    // Get global industry defaults
    const defaultCharacters = settings.industry?.defaultManufacturingCharacters || [];
    const reactionsAsIntermediates = settings.industry?.calculateReactionsAsIntermediates ? 1 : 0;

    // For divisions, get per-character settings
    const insertStmt = database.prepare(`
      INSERT INTO plan_industry_settings (
        plan_id, enabled_divisions_json, default_characters_json,
        reactions_as_intermediates, last_updated
      ) VALUES (?, ?, ?, ?, ?)
    `);

    for (const plan of plansWithoutSettings) {
      // Get character division settings
      const charSettings = database.prepare('SELECT enabled_divisions FROM character_settings WHERE character_id = ?')
        .get(plan.character_id);

      const divisionsJson = {};
      if (charSettings && charSettings.enabled_divisions) {
        const enabledDivisions = JSON.parse(charSettings.enabled_divisions);
        divisionsJson[plan.character_id] = enabledDivisions;
      }

      insertStmt.run(
        plan.plan_id,
        JSON.stringify(divisionsJson),
        JSON.stringify(defaultCharacters),
        reactionsAsIntermediates,
        Date.now()
      );
    }

    console.log('[Migration] Successfully migrated plans to have industry settings');
  } catch (error) {
    console.error('[Migration] Error migrating plans to industry settings:', error);
  }
}

module.exports = {
  getCharacterDatabase,
  initializeCharacterDatabase,
  closeCharacterDatabase,
  migrateExistingPlansToSettings,
};
