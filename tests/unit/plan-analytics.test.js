/**
 * Tests for getPlanAnalytics "Planned vs Actual" — the ACTUAL side is driven by
 * the consolidated ledger (getPlanLedger), so it includes manual acquisitions,
 * job install, and fees, and never double-counts.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const RealDatabase = require('better-sqlite3');

let mockDb;
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));

let mockSdePath;
jest.mock('../../src/main/sde-manager', () => ({ getSdePath: jest.fn(() => mockSdePath) }));

function buildSde() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-sde-'));
  mockSdePath = path.join(dir, 'sde.db');
  const db = new RealDatabase(mockSdePath);
  db.exec(`CREATE TABLE invTypes (typeID INTEGER PRIMARY KEY, typeName TEXT);
           CREATE TABLE industryActivityProducts (typeID INTEGER, activityID INTEGER, productTypeID INTEGER, quantity INTEGER);
           INSERT INTO invTypes (typeID, typeName) VALUES (34,'Tritanium'),(35,'Pyerite');`);
  db.close();
  return dir;
}

function buildSchema(db) {
  db.exec(`
    CREATE TABLE manufacturing_plans (plan_id TEXT PRIMARY KEY, character_id INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE plan_blueprints (
      plan_blueprint_id TEXT PRIMARY KEY, plan_id TEXT, blueprint_type TEXT, blueprint_type_id INTEGER,
      runs INTEGER, lines INTEGER DEFAULT 1, intermediate_product_type_id INTEGER,
      use_intermediates TEXT, facility_snapshot TEXT, added_at INTEGER
    );
    CREATE TABLE plan_material_nodes (
      node_id TEXT PRIMARY KEY, plan_id TEXT, plan_blueprint_id TEXT, parent_node_id TEXT,
      type_id INTEGER, node_type TEXT, depth INTEGER, quantity_needed REAL, price_each REAL, price_frozen_at INTEGER
    );
    CREATE TABLE plan_price_overrides (plan_id TEXT, type_id INTEGER, price REAL);
    CREATE TABLE characters (character_id INTEGER PRIMARY KEY, character_name TEXT);
    CREATE TABLE esi_industry_jobs (
      job_id INTEGER PRIMARY KEY, character_id INTEGER, blueprint_type_id INTEGER, runs INTEGER,
      status TEXT, start_date INTEGER, end_date INTEGER, completed_date INTEGER,
      is_corporation INTEGER DEFAULT 0, corporation_id INTEGER, cost REAL, product_type_id INTEGER
    );
    CREATE TABLE esi_wallet_transactions (
      transaction_id INTEGER NOT NULL, character_id INTEGER NOT NULL, is_corporation INTEGER NOT NULL DEFAULT 0,
      corporation_id INTEGER, type_id INTEGER, quantity INTEGER, unit_price REAL, is_buy INTEGER, date INTEGER,
      PRIMARY KEY (transaction_id, character_id, is_corporation)
    );
    CREATE TABLE esi_wallet_journal (
      id INTEGER NOT NULL, character_id INTEGER NOT NULL, is_corporation INTEGER NOT NULL DEFAULT 0,
      context_id INTEGER, ref_type TEXT, amount REAL, date INTEGER, PRIMARY KEY (id, character_id, is_corporation)
    );
    CREATE TABLE plan_job_matches (
      match_id TEXT PRIMARY KEY, plan_id TEXT, plan_blueprint_id TEXT, job_id INTEGER,
      match_confidence REAL, status TEXT DEFAULT 'pending', confirmed_at INTEGER
    );
    CREATE TABLE plan_transaction_matches (
      match_id TEXT PRIMARY KEY, plan_id TEXT, transaction_id INTEGER, type_id INTEGER, match_type TEXT,
      quantity INTEGER, match_confidence REAL, status TEXT DEFAULT 'pending', confirmed_at INTEGER, is_corporation INTEGER DEFAULT 0
    );
    CREATE TABLE plan_material_ledger (
      ledger_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, type_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('acquired','deducted','adjusted','cost','sold')),
      quantity REAL NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('manual','purchased','manufactured','allocated','cost','sold')),
      unit_price REAL, note TEXT, source_ref TEXT, source_type TEXT, source_id INTEGER,
      character_id INTEGER, corporation_id INTEGER, cost_category TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_pml_source ON plan_material_ledger(plan_id, source_type, source_id) WHERE source_id IS NOT NULL;
  `);
  db.prepare('INSERT INTO manufacturing_plans (plan_id, character_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('P1', 1, 0, Date.now());
  // Plan needs 1000 Tritanium @ 5 (planned material cost 5000).
  db.prepare(`INSERT INTO plan_material_nodes (node_id, plan_id, type_id, node_type, depth, quantity_needed, price_each)
    VALUES ('n1','P1',34,'material',1,1000,5)`).run();
}

let mp, seq = 0, sdeDir, errSpy;
function insLedger(o) {
  mockDb.prepare(`INSERT INTO plan_material_ledger
    (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_type, source_id, cost_category, created_at)
    VALUES (?, 'P1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `L${++seq}`, o.type_id ?? 0, o.event_type, o.quantity ?? 0, o.method,
    o.unit_price ?? null, o.note ?? null, o.source_type ?? null, o.source_id ?? null, o.cost_category ?? null, o.created_at ?? seq
  );
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  seq = 0;
  sdeDir = buildSde();
  mockDb = new RealDatabase(':memory:');
  buildSchema(mockDb);
  mp = require('../../src/main/manufacturing-plans');
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  if (mockDb) mockDb.close();
  mockDb = null;
  if (sdeDir) fs.rmSync(sdeDir, { recursive: true, force: true });
});

describe('getPlanAnalytics — actuals from ledger', () => {
  test('actual material cost includes manual acquisitions (no double-count)', async () => {
    // Confirmed ESI purchase: 400 @ 5 = 2000
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status, is_corporation)
      VALUES ('mt','P1',500,34,'material_buy',400,0.9,'confirmed',0)`).run();
    insLedger({ type_id: 34, event_type: 'acquired', quantity: 400, method: 'purchased', unit_price: 5, source_type: 'wallet_transaction', source_id: 500 });
    // Manual acquisition (stockpile): 100 @ 3 = 300
    insLedger({ type_id: 34, event_type: 'acquired', quantity: 100, method: 'manual', unit_price: 3 });

    const a = await mp.getPlanAnalytics('P1');

    // Actual material cost = 2000 + 300 = 2300 (purchase + manual).
    expect(a.materialCosts.actual).toBeCloseTo(2300);
    // Material progress = 500 acquired / 1000 needed = 50% (NOT 900 from double-count).
    expect(a.progress.materials.purchased).toBe(500);
    expect(a.progress.materials.percent).toBeCloseTo(50);
  });

  test('sold rows do not inflate material progress and are revenue not spend', async () => {
    insLedger({ type_id: 34, event_type: 'acquired', quantity: 200, method: 'purchased', unit_price: 5, source_type: 'wallet_transaction', source_id: 1 });
    // A product sale of 50 @ 100 = 5000 revenue.
    insLedger({ type_id: 35, event_type: 'sold', quantity: 50, method: 'sold', unit_price: 100, source_type: 'wallet_transaction', source_id: 2 });

    const a = await mp.getPlanAnalytics('P1');

    // Material progress unaffected by the sold row (still 200).
    expect(a.progress.materials.purchased).toBe(200);
    // Actual product value = 5000; actual material cost = 1000.
    expect(a.productValue.actual).toBeCloseTo(5000);
    expect(a.materialCosts.actual).toBeCloseTo(1000);
  });

  test('actual profit = sales − FULL spend (materials + job install + fees)', async () => {
    // Material purchase 1000, job install 400, broker fee 100, product sale 3000.
    insLedger({ type_id: 34, event_type: 'acquired', quantity: 200, method: 'purchased', unit_price: 5, source_type: 'wallet_transaction', source_id: 1 });
    insLedger({ type_id: 0, event_type: 'cost', quantity: 0, method: 'cost', unit_price: 400, source_type: 'industry_job', source_id: 700, cost_category: 'job_install' });
    insLedger({ type_id: 0, event_type: 'cost', quantity: 0, method: 'cost', unit_price: 100, source_type: 'wallet_journal', source_id: 10, cost_category: 'broker_fee' });
    insLedger({ type_id: 35, event_type: 'sold', quantity: 30, method: 'sold', unit_price: 100, source_type: 'wallet_transaction', source_id: 2 });

    const a = await mp.getPlanAnalytics('P1');

    // Full spend = 1000 + 400 + 100 = 1500; profit = 3000 − 1500 = 1500.
    expect(a.profit.actual).toBeCloseTo(1500);
  });
});
