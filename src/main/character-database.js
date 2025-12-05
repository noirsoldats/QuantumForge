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
      item_id TEXT PRIMARY KEY,
      type_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
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
      FOREIGN KEY (character_id) REFERENCES characters(character_id) ON DELETE CASCADE
    )
  `);

  // Blueprint overrides
  database.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_overrides (
      item_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (item_id, field),
      FOREIGN KEY (item_id) REFERENCES blueprints(item_id) ON DELETE CASCADE
    )
  `);

  // Assets table (for Phase 4)
  database.exec(`
    CREATE TABLE IF NOT EXISTS assets (
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

  console.log('[Character Database] Schema initialized successfully');
  return database;
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

module.exports = {
  getCharacterDatabase,
  initializeCharacterDatabase,
  closeCharacterDatabase,
};
