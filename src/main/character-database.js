const Database = require('better-sqlite3');
const path = require('path');
const { getConfigDir } = require('./config-migration');

let db = null;

/**
 * Get the character database connection
 * @returns {Database} Database instance
 */
function getCharacterDatabase() {
  if (db) return db;

  const dbPath = path.join(getConfigDir(), 'character-data.db');
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

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_skills_character ON skills(character_id);
    CREATE INDEX IF NOT EXISTS idx_blueprints_character ON blueprints(character_id);
    CREATE INDEX IF NOT EXISTS idx_blueprints_type ON blueprints(type_id);
    CREATE INDEX IF NOT EXISTS idx_assets_character ON assets(character_id);
    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type_id);
    CREATE INDEX IF NOT EXISTS idx_assets_location ON assets(location_id);
  `);

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
