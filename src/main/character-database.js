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

  database.exec(`
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
  // NOTE: source/cost columns + widened event_type CHECK + unique source index are
  // added by migration 019 (table rebuild). Base stays at the original shape;
  // migrations run on fresh DBs too and converge both paths (see 017's precedent).

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
  // NOTE: is_corporation/corporation_id added by migration 017; cost/product_type_id
  // by migration 020. Base stays original; migrations converge fresh + legacy paths.

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
    CREATE INDEX IF NOT EXISTS idx_pmn_plan          ON plan_material_nodes(plan_id);
    CREATE INDEX IF NOT EXISTS idx_pmn_blueprint     ON plan_material_nodes(plan_blueprint_id);
    CREATE INDEX IF NOT EXISTS idx_pmn_parent        ON plan_material_nodes(parent_node_id);
    CREATE INDEX IF NOT EXISTS idx_pmn_type          ON plan_material_nodes(type_id);
    CREATE INDEX IF NOT EXISTS idx_pmn_plan_type     ON plan_material_nodes(plan_id, type_id);
    CREATE INDEX IF NOT EXISTS idx_pmn_plan_nodetype ON plan_material_nodes(plan_id, node_type);
    CREATE INDEX IF NOT EXISTS idx_pml_plan          ON plan_material_ledger(plan_id);
    CREATE INDEX IF NOT EXISTS idx_pml_type          ON plan_material_ledger(plan_id, type_id);
    CREATE INDEX IF NOT EXISTS idx_pml_created       ON plan_material_ledger(created_at);
  `);

  // NOTE: Schema evolution (column/table additions beyond the base CREATEs above)
  // is handled exclusively by the numbered, tracked migration system in
  // database-schema-migrations.js (migrations 010-018 fold what used to be a set of
  // untracked ad-hoc ALTER blocks that lived here). Do NOT add inline ALTER/CREATE
  // "migration" blocks to this function — add a numbered migration instead. This
  // function is now responsible only for the base CREATE TABLE IF NOT EXISTS shapes.
  // Migrations run immediately after this function during app startup (see main.js).

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
