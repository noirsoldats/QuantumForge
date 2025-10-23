const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const fs = require('fs');

let db = null;

/**
 * Get the path to the market database
 */
function getMarketDatabasePath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'market_data.sqlite');
}

/**
 * Initialize the market database
 */
function initializeMarketDatabase() {
  try {
    const dbPath = getMarketDatabasePath();
    console.log('Opening market database:', dbPath);

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Create tables
    createTables();

    console.log('Market database initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing market database:', error);
    return false;
  }
}

/**
 * Create database tables
 */
function createTables() {
  // Market orders table (current buy/sell orders)
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_orders (
      order_id INTEGER PRIMARY KEY,
      type_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      system_id INTEGER,
      is_buy_order INTEGER NOT NULL,
      price REAL NOT NULL,
      volume_remain INTEGER NOT NULL,
      volume_total INTEGER NOT NULL,
      min_volume INTEGER,
      duration INTEGER,
      issued TEXT,
      fetched_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_type_location ON market_orders(type_id, location_id, is_buy_order);
    CREATE INDEX IF NOT EXISTS idx_orders_type_region ON market_orders(type_id, region_id, is_buy_order);
    CREATE INDEX IF NOT EXISTS idx_orders_fetched ON market_orders(fetched_at);
  `);

  // Market history table (daily aggregated data from ESI)
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      average REAL NOT NULL,
      highest REAL NOT NULL,
      lowest REAL NOT NULL,
      order_count INTEGER NOT NULL,
      volume INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      UNIQUE(type_id, region_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_history_type_region ON market_history(type_id, region_id);
    CREATE INDEX IF NOT EXISTS idx_history_date ON market_history(date);
  `);

  // Adjusted prices table (CCP's adjusted prices for industry calculations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS adjusted_prices (
      type_id INTEGER PRIMARY KEY,
      adjusted_price REAL,
      average_price REAL,
      fetched_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_adjusted_prices_fetched ON adjusted_prices(fetched_at);
  `);

  // Market price cache (calculated prices with metadata)
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_price_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      price_type TEXT NOT NULL,
      price REAL NOT NULL,
      vwap REAL,
      percentile_price REAL,
      historical_7d REAL,
      historical_30d REAL,
      confidence TEXT,
      warning TEXT,
      quantity INTEGER,
      calculated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(type_id, location_id, price_type, quantity)
    );

    CREATE INDEX IF NOT EXISTS idx_price_cache_type_location ON market_price_cache(type_id, location_id, price_type);
    CREATE INDEX IF NOT EXISTS idx_price_cache_expires ON market_price_cache(expires_at);
  `);

  // Price overrides (user-defined prices)
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_overrides (
      type_id INTEGER PRIMARY KEY,
      price REAL NOT NULL,
      notes TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  // Fetch metadata (track last fetch times for rate limiting)
  db.exec(`
    CREATE TABLE IF NOT EXISTS fetch_metadata (
      key TEXT PRIMARY KEY,
      last_fetch INTEGER NOT NULL,
      expires_at INTEGER
    );
  `);

  // Market locations (trade hubs, stations, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_locations (
      location_id INTEGER PRIMARY KEY,
      location_name TEXT NOT NULL,
      location_type TEXT NOT NULL,
      region_id INTEGER NOT NULL,
      system_id INTEGER,
      is_favorite INTEGER DEFAULT 0
    );
  `);

  // Industry cost indices (solar system industry cost modifiers)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_indices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      solar_system_id INTEGER NOT NULL,
      activity TEXT NOT NULL,
      cost_index REAL NOT NULL,
      fetched_at INTEGER NOT NULL,
      UNIQUE(solar_system_id, activity)
    );

    CREATE INDEX IF NOT EXISTS idx_cost_indices_system ON cost_indices(solar_system_id);
    CREATE INDEX IF NOT EXISTS idx_cost_indices_fetched ON cost_indices(fetched_at);
  `);

  // Seed default trade hubs
  seedDefaultLocations();
}

/**
 * Seed default trade hub locations
 */
function seedDefaultLocations() {
  const defaultHubs = [
    { location_id: 60003760, location_name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', location_type: 'station', region_id: 10000002, system_id: 30000142, is_favorite: 1 },
    { location_id: 60008494, location_name: 'Amarr VIII (Oris) - Emperor Family Academy', location_type: 'station', region_id: 10000043, system_id: 30002187, is_favorite: 1 },
    { location_id: 60011866, location_name: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant', location_type: 'station', region_id: 10000032, system_id: 30002659, is_favorite: 1 },
    { location_id: 60004588, location_name: 'Rens VI - Moon 8 - Brutor Tribe Treasury', location_type: 'station', region_id: 10000030, system_id: 30002510, is_favorite: 1 },
    { location_id: 60005686, location_name: 'Hek VIII - Moon 12 - Boundless Creation Factory', location_type: 'station', region_id: 10000042, system_id: 30002053, is_favorite: 0 },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO market_locations (location_id, location_name, location_type, region_id, system_id, is_favorite)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const hub of defaultHubs) {
    insert.run(hub.location_id, hub.location_name, hub.location_type, hub.region_id, hub.system_id, hub.is_favorite);
  }
}

/**
 * Close the database
 */
function closeMarketDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get the database instance
 */
function getMarketDatabase() {
  if (!db) {
    initializeMarketDatabase();
  }
  return db;
}

/**
 * Save adjusted prices from ESI /markets/prices/
 * @param {Array} pricesData - Array of price objects from ESI
 */
function saveAdjustedPrices(pricesData) {
  const db = getMarketDatabase();
  const fetchedAt = Date.now();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO adjusted_prices (type_id, adjusted_price, average_price, fetched_at)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((prices) => {
    for (const price of prices) {
      insert.run(
        price.type_id,
        price.adjusted_price || null,
        price.average_price || null,
        fetchedAt
      );
    }
  });

  insertMany(pricesData);
  console.log(`Saved ${pricesData.length} adjusted prices to database`);
}

/**
 * Get adjusted price for a specific type
 * @param {number} typeId - Type ID
 * @returns {Object|null} Price object with adjusted_price and average_price
 */
function getAdjustedPrice(typeId) {
  const db = getMarketDatabase();
  return db.prepare(`
    SELECT adjusted_price, average_price, fetched_at
    FROM adjusted_prices
    WHERE type_id = ?
  `).get(typeId);
}

/**
 * Clear all adjusted prices (used before refresh)
 */
function clearAdjustedPrices() {
  const db = getMarketDatabase();
  db.prepare('DELETE FROM adjusted_prices').run();
  console.log('Cleared all adjusted prices from database');
}

/**
 * Clean up old data
 */
function cleanupOldData(daysToKeep = 90) {
  const db = getMarketDatabase();
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  // Clean old market orders
  db.prepare('DELETE FROM market_orders WHERE fetched_at < ?').run(cutoffTime);

  // Clean old price cache
  db.prepare('DELETE FROM market_price_cache WHERE expires_at < ?').run(Date.now());

  // Clean old adjusted prices (older than 7 days)
  const adjustedPricesCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM adjusted_prices WHERE fetched_at < ?').run(adjustedPricesCutoff);

  console.log(`Cleaned up market data older than ${daysToKeep} days`);
}

module.exports = {
  initializeMarketDatabase,
  closeMarketDatabase,
  getMarketDatabase,
  getMarketDatabasePath,
  saveAdjustedPrices,
  getAdjustedPrice,
  clearAdjustedPrices,
  cleanupOldData,
};
