/**
 * One-off generator for tests/fixtures/db/pricing-consistency.sde.db and
 * pricing-consistency.market.db.
 *
 * These are tiny, committed, deterministic SQLite fixtures used by
 * cross-module pricing consistency tests so multiple modules (Blueprint
 * Calculator, Manufacturing Plans, Reactions Calculator) can run their real
 * DB-querying code against one shared dataset, instead of each test
 * re-mocking DB responses independently (which risks fixtures silently
 * drifting apart).
 *
 * Not a test itself — run manually whenever the fixture data needs to
 * change, then commit the regenerated .db files:
 *   node tests/fixtures/db/generate-pricing-consistency-db.js
 *
 * Schema mirrors:
 *  - SDE tables: tests/unit/helpers/database-mocks.js's createInMemoryDatabase()
 *  - Market tables: src/main/market-database.js's initializeMarketDatabase()
 *
 * Data values match tests/unit/fixtures/blueprints.js (scourgeBlueprint) and
 * tests/unit/fixtures/market-data.js (tritaniumOrders) so expectations
 * cross-check against existing unit test fixtures.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = __dirname;
const SDE_DB_PATH = path.join(DB_DIR, 'pricing-consistency.sde.db');
const MARKET_DB_PATH = path.join(DB_DIR, 'pricing-consistency.market.db');

function generateSdeDb() {
  if (fs.existsSync(SDE_DB_PATH)) fs.unlinkSync(SDE_DB_PATH);
  const db = new Database(SDE_DB_PATH);

  db.exec(`
    CREATE TABLE invTypes (
      typeID INTEGER PRIMARY KEY,
      groupID INTEGER,
      typeName TEXT,
      volume REAL,
      categoryID INTEGER
    );

    CREATE TABLE invGroups (
      groupID INTEGER PRIMARY KEY,
      categoryID INTEGER,
      groupName TEXT
    );

    CREATE TABLE industryBlueprints (
      typeID INTEGER PRIMARY KEY,
      productTypeID INTEGER,
      maxProductionLimit INTEGER
    );

    CREATE TABLE industryActivityMaterials (
      typeID INTEGER,
      activityID INTEGER,
      materialTypeID INTEGER,
      quantity INTEGER,
      PRIMARY KEY (typeID, activityID, materialTypeID)
    );

    CREATE TABLE industryActivityProducts (
      typeID INTEGER,
      activityID INTEGER,
      productTypeID INTEGER,
      quantity INTEGER,
      PRIMARY KEY (typeID, activityID)
    );

    CREATE TABLE industryActivity (
      typeID INTEGER,
      activityID INTEGER,
      time INTEGER,
      PRIMARY KEY (typeID, activityID)
    );
  `);

  // Raw materials (Tritanium, Pyerite, Mexallon, Morphite) — matches
  // tests/unit/fixtures/blueprints.js's scourgeBlueprint.materials
  const insertType = db.prepare('INSERT INTO invTypes (typeID, groupID, typeName, categoryID) VALUES (?, ?, ?, ?)');
  insertType.run(34, 18, 'Tritanium', 4);
  insertType.run(35, 18, 'Pyerite', 4);
  insertType.run(36, 18, 'Mexallon', 4);
  insertType.run(11399, 18, 'Morphite', 4);
  insertType.run(209, 88, 'Scourge Light Missile', 8);
  insertType.run(810, 9, 'Scourge Light Missile Blueprint', 9);

  // Scourge Light Missile Blueprint (typeID 810) — activityID 1 = manufacturing
  db.prepare('INSERT INTO industryBlueprints (typeID, productTypeID, maxProductionLimit) VALUES (?, ?, ?)')
    .run(810, 209, 100);
  db.prepare('INSERT INTO industryActivityProducts (typeID, activityID, productTypeID, quantity) VALUES (?, 1, ?, ?)')
    .run(810, 209, 100);
  db.prepare('INSERT INTO industryActivity (typeID, activityID, time) VALUES (?, 1, ?)')
    .run(810, 40);

  const insertMaterial = db.prepare(
    'INSERT INTO industryActivityMaterials (typeID, activityID, materialTypeID, quantity) VALUES (?, 1, ?, ?)'
  );
  insertMaterial.run(810, 34, 50);
  insertMaterial.run(810, 35, 25);
  insertMaterial.run(810, 36, 5);
  insertMaterial.run(810, 11399, 1);

  db.close();
  console.log(`Wrote ${SDE_DB_PATH}`);
}

function generateMarketDb() {
  if (fs.existsSync(MARKET_DB_PATH)) fs.unlinkSync(MARKET_DB_PATH);
  const db = new Database(MARKET_DB_PATH);

  db.exec(`
    CREATE TABLE market_orders (
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

    CREATE TABLE market_history (
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
  `);

  // Tritanium (typeID 34) sell orders in The Forge (region 10000002) at Jita 4-4
  // (station 60003760) — values match tests/unit/fixtures/market-data.js's tritaniumOrders.sell
  const now = Date.now();
  const insertOrder = db.prepare(`
    INSERT INTO market_orders
      (order_id, type_id, location_id, region_id, is_buy_order, price, volume_remain, volume_total, fetched_at)
    VALUES (?, 34, 60003760, 10000002, 0, ?, ?, ?, ?)
  `);
  const sellOrders = [
    { id: 6, price: 6.52, volume: 15000000 },
    { id: 7, price: 6.53, volume: 12000000 },
    { id: 8, price: 6.55, volume: 8000000 },
    { id: 9, price: 6.60, volume: 5000000 },
    { id: 10, price: 6.75, volume: 3000000 },
  ];
  for (const o of sellOrders) {
    insertOrder.run(o.id, o.price, o.volume, o.volume, now);
  }

  // 5 days of history for Tritanium
  const insertHistory = db.prepare(`
    INSERT INTO market_history (type_id, region_id, date, average, highest, lowest, order_count, volume, fetched_at)
    VALUES (34, 10000002, ?, ?, ?, ?, ?, ?, ?)
  `);
  const history = [
    { date: '2026-06-28', average: 6.40, high: 6.55, low: 6.30, volume: 50000000 },
    { date: '2026-06-29', average: 6.42, high: 6.58, low: 6.32, volume: 48000000 },
    { date: '2026-06-30', average: 6.38, high: 6.50, low: 6.28, volume: 52000000 },
    { date: '2026-07-01', average: 6.41, high: 6.54, low: 6.31, volume: 49000000 },
    { date: '2026-07-02', average: 6.39, high: 6.52, low: 6.29, volume: 51000000 },
  ];
  for (const h of history) {
    insertHistory.run(h.date, h.average, h.high, h.low, 120, h.volume, now);
  }

  db.close();
  console.log(`Wrote ${MARKET_DB_PATH}`);
}

generateSdeDb();
generateMarketDb();
