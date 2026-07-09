/**
 * Tests for manual item acquisition + unlink-anything (Ledger tab refinement).
 *
 *  - addManualItemAcquisition writes an acquired/manual row with resolved unit_price;
 *    total-value input derives the per-unit price.
 *  - Hard cap: request > still-needed clamps to remaining (clamped:true); a fully
 *    acquired item is rejected; the cap accounts for ledger net + confirmed
 *    purchased quantity.
 *  - The new manual row reduces getMaterialStillNeeded / getPlanMaterials.
 *  - unlinkLedgerEntry: manual row deletes; wallet_transaction routes through the
 *    match unlink; a fee row removes just itself.
 *  - updateLedgerEntry quantity edit on a manual acquired row respects the cap.
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
           INSERT INTO invTypes (typeID, typeName) VALUES (34, 'Tritanium');`);
  db.close();
  return dir;
}

function buildSchema(db) {
  db.exec(`
    CREATE TABLE manufacturing_plans (plan_id TEXT PRIMARY KEY, character_id INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE plan_material_nodes (
      node_id TEXT PRIMARY KEY, plan_id TEXT, plan_blueprint_id TEXT, parent_node_id TEXT,
      type_id INTEGER, node_type TEXT, depth INTEGER, quantity_needed REAL,
      price_each REAL, price_frozen_at INTEGER
    );
    CREATE TABLE plan_price_overrides (plan_id TEXT, type_id INTEGER, price REAL);
    CREATE TABLE esi_industry_jobs (
      job_id INTEGER PRIMARY KEY, character_id INTEGER, blueprint_type_id INTEGER, runs INTEGER,
      status TEXT, is_corporation INTEGER DEFAULT 0, corporation_id INTEGER, cost REAL, product_type_id INTEGER
    );
    CREATE TABLE esi_wallet_transactions (
      transaction_id INTEGER NOT NULL, character_id INTEGER NOT NULL, is_corporation INTEGER NOT NULL DEFAULT 0,
      corporation_id INTEGER, type_id INTEGER, quantity INTEGER, unit_price REAL, is_buy INTEGER, date INTEGER,
      PRIMARY KEY (transaction_id, character_id, is_corporation)
    );
    CREATE TABLE esi_wallet_journal (
      id INTEGER NOT NULL, character_id INTEGER NOT NULL, is_corporation INTEGER NOT NULL DEFAULT 0,
      context_id INTEGER, ref_type TEXT, amount REAL, date INTEGER,
      PRIMARY KEY (id, character_id, is_corporation)
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
  // Material node: 1000 Tritanium needed.
  db.prepare(`INSERT INTO plan_material_nodes (node_id, plan_id, type_id, node_type, depth, quantity_needed, price_each)
    VALUES ('n1','P1',34,'material',1,1000,5)`).run();
}

let mp;
let sdeDir;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  sdeDir = buildSde();
  mockDb = new RealDatabase(':memory:');
  buildSchema(mockDb);
  mp = require('../../src/main/manufacturing-plans');
});
afterEach(() => {
  if (mockDb) mockDb.close();
  mockDb = null;
  if (sdeDir) fs.rmSync(sdeDir, { recursive: true, force: true });
});

const ledgerRows = () => mockDb.prepare('SELECT * FROM plan_material_ledger').all();
const netAcquired = (typeId) =>
  mockDb.prepare('SELECT COALESCE(SUM(quantity),0) n FROM plan_material_ledger WHERE plan_id=? AND type_id=?').get('P1', typeId).n;

describe('addManualItemAcquisition', () => {
  test('writes an acquired/manual row with a unit price', async () => {
    const res = await mp.addManualItemAcquisition('P1', 34, { quantity: 100, unitPrice: 6.5, note: 'stockpile' });
    expect(res.success).toBe(true);
    expect(res.actual).toBe(100);
    expect(res.clamped).toBe(false);

    const row = ledgerRows()[0];
    expect(row.event_type).toBe('acquired');
    expect(row.method).toBe('manual');
    expect(row.quantity).toBe(100);
    expect(row.unit_price).toBeCloseTo(6.5);
    expect(row.note).toBe('stockpile');
  });

  test('derives unit price from total value', async () => {
    await mp.addManualItemAcquisition('P1', 34, { quantity: 50, totalValue: 500 });
    const row = ledgerRows()[0];
    expect(row.unit_price).toBeCloseTo(10); // 500 / 50
  });

  test('hard cap: clamps a request above still-needed', async () => {
    // Need 1000; already 900 in ledger → still needed 100.
    mockDb.prepare(`INSERT INTO plan_material_ledger (ledger_id, plan_id, type_id, event_type, quantity, method, created_at)
      VALUES ('L0','P1',34,'acquired',900,'manual',1)`).run();

    const res = await mp.addManualItemAcquisition('P1', 34, { quantity: 500, unitPrice: 5 });
    expect(res.clamped).toBe(true);
    expect(res.requested).toBe(500);
    expect(res.actual).toBe(100); // clamped to remaining
    expect(netAcquired(34)).toBe(1000);
  });

  test('cap accounts for confirmed purchased quantity (not just ledger)', async () => {
    // 700 confirmed purchased via matches → still needed 300.
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status)
      VALUES ('m1','P1',5001,34,'material_buy',700,0.9,'confirmed')`).run();

    const res = await mp.addManualItemAcquisition('P1', 34, { quantity: 999, unitPrice: 5 });
    expect(res.actual).toBe(300);
    expect(res.clamped).toBe(true);
  });

  test('rejects when the item is already fully acquired', async () => {
    mockDb.prepare(`INSERT INTO plan_material_ledger (ledger_id, plan_id, type_id, event_type, quantity, method, created_at)
      VALUES ('L0','P1',34,'acquired',1000,'manual',1)`).run();

    const res = await mp.addManualItemAcquisition('P1', 34, { quantity: 10, unitPrice: 5 });
    expect(res.success).toBe(false);
    expect(res.clamped).toBe(true);
    expect(ledgerRows()).toHaveLength(1); // no new row
  });

  test('throws for a type not in the plan', async () => {
    await expect(mp.addManualItemAcquisition('P1', 999, { quantity: 1 })).rejects.toThrow(/not found/i);
  });
});

describe('getMaterialStillNeeded', () => {
  test('reflects the new manual acquisition', async () => {
    let sn = await mp.getMaterialStillNeeded('P1', 34);
    expect(sn.stillNeeded).toBe(1000);
    await mp.addManualItemAcquisition('P1', 34, { quantity: 250, unitPrice: 5 });
    sn = await mp.getMaterialStillNeeded('P1', 34);
    expect(sn.stillNeeded).toBe(750);
  });
});

describe('ledger unit price = quantity-weighted average', () => {
  test('averages multiple acquisitions by quantity', async () => {
    // 100 @ 5  and  300 @ 9  →  (100*5 + 300*9) / 400 = 3200/400 = 8
    await mp.addManualItemAcquisition('P1', 34, { quantity: 100, unitPrice: 5 });
    await mp.addManualItemAcquisition('P1', 34, { quantity: 300, unitPrice: 9 });

    const materials = await mp.getPlanMaterials('P1');
    const trit = materials.find(m => m.typeId === 34);
    expect(trit.customPrice).toBeCloseTo(8);
  });

  test('ignores price-less rows and cost rows (quantity=0)', async () => {
    // A priced acquisition + a manual cost row (quantity 0) must not skew the avg.
    await mp.addManualItemAcquisition('P1', 34, { quantity: 100, unitPrice: 6 });
    mockDb.prepare(`INSERT INTO plan_material_ledger (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, cost_category, created_at)
      VALUES ('C0','P1',34,'cost',0,'cost',9999,'shipping',2)`).run();

    const materials = await mp.getPlanMaterials('P1');
    const trit = materials.find(m => m.typeId === 34);
    expect(trit.customPrice).toBeCloseTo(6); // cost row's 9999 excluded
  });

  test('is null when no priced acquisitions exist', async () => {
    await mp.addManualItemAcquisition('P1', 34, { quantity: 50 }); // no price
    const materials = await mp.getPlanMaterials('P1');
    const trit = materials.find(m => m.typeId === 34);
    expect(trit.customPrice).toBeNull();
  });
});

describe('unlinkLedgerEntry', () => {
  test('deletes a manual row', async () => {
    const { ledgerId } = await mp.addManualItemAcquisition('P1', 34, { quantity: 10, unitPrice: 5 });
    const res = mp.unlinkLedgerEntry('P1', ledgerId);
    expect(res.action).toBe('deleted');
    expect(ledgerRows()).toHaveLength(0);
  });

  test('wallet_transaction row routes through the transaction match unlink', async () => {
    // A confirmed purchase: match + its ledger row (as plan-matching writes them).
    mockDb.prepare(`INSERT INTO esi_wallet_transactions (transaction_id, character_id, is_corporation, type_id, quantity, unit_price, is_buy, date)
      VALUES (5001,1,0,34,100,5,1,1)`).run();
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status, is_corporation)
      VALUES ('mt','P1',5001,34,'material_buy',100,0.9,'confirmed',0)`).run();
    mockDb.prepare(`INSERT INTO plan_material_ledger (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, source_type, source_id, created_at)
      VALUES ('Lesi','P1',34,'acquired',100,'purchased',5,'wallet_transaction',5001,1)`).run();

    const res = mp.unlinkLedgerEntry('P1', 'Lesi');
    expect(res.action).toBe('unlinked_transaction');
    // Ledger row gone AND the match no longer confirmed (unlinkTransactionMatch deletes the match row).
    expect(ledgerRows().filter(r => r.source_type === 'wallet_transaction')).toHaveLength(0);
    expect(mockDb.prepare(`SELECT COUNT(*) c FROM plan_transaction_matches WHERE match_id='mt'`).get().c).toBe(0);
  });

  test('disambiguates by is_corporation when a tx_id collides across personal/corp wallets', async () => {
    // Same transaction_id 5001 in both wallets, each with its own confirmed match.
    mockDb.prepare(`INSERT INTO esi_wallet_transactions (transaction_id, character_id, is_corporation, corporation_id, type_id, quantity, unit_price, is_buy, date)
      VALUES (5001,1,0,NULL,34,100,5,1,1)`).run();
    mockDb.prepare(`INSERT INTO esi_wallet_transactions (transaction_id, character_id, is_corporation, corporation_id, type_id, quantity, unit_price, is_buy, date)
      VALUES (5001,1,1,555,34,200,7,1,1)`).run();
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status, is_corporation)
      VALUES ('mPers','P1',5001,34,'material_buy',100,0.9,'confirmed',0)`).run();
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status, is_corporation)
      VALUES ('mCorp','P1',5001,34,'material_buy',200,0.9,'confirmed',1)`).run();
    // A CORP-sourced ledger row (corporation_id set → is_corporation=1).
    mockDb.prepare(`INSERT INTO plan_material_ledger (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, source_type, source_id, corporation_id, created_at)
      VALUES ('Lcorp','P1',34,'acquired',200,'purchased',7,'wallet_transaction',5001,555,1)`).run();

    mp.unlinkLedgerEntry('P1', 'Lcorp');

    // Only the CORP match is cleared; the personal match survives.
    expect(mockDb.prepare(`SELECT COUNT(*) c FROM plan_transaction_matches WHERE match_id='mCorp'`).get().c).toBe(0);
    expect(mockDb.prepare(`SELECT COUNT(*) c FROM plan_transaction_matches WHERE match_id='mPers'`).get().c).toBe(1);
  });

  test('a fee row removes just itself', async () => {
    mockDb.prepare(`INSERT INTO plan_material_ledger (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, source_type, source_id, cost_category, created_at)
      VALUES ('Lfee','P1',0,'cost',0,'cost',12.5,'wallet_journal',10,'broker_fee',1)`).run();
    const res = mp.unlinkLedgerEntry('P1', 'Lfee');
    expect(res.action).toBe('removed_fee');
    expect(ledgerRows()).toHaveLength(0);
  });
});

describe('updateLedgerEntry quantity cap', () => {
  test('clamps a quantity edit on a manual acquired row to still-needed', async () => {
    const { ledgerId } = await mp.addManualItemAcquisition('P1', 34, { quantity: 100, unitPrice: 5 });
    // Need 1000, this row is 100 → max target = stillNeeded(900) + own(100) = 1000.
    const res = await mp.updateLedgerEntry(ledgerId, { quantity: 5000 });
    expect(res.clamped).toBe(true);
    expect(netAcquired(34)).toBe(1000);
  });

  test('allows a quantity edit within the cap', async () => {
    const { ledgerId } = await mp.addManualItemAcquisition('P1', 34, { quantity: 100, unitPrice: 5 });
    const res = await mp.updateLedgerEntry(ledgerId, { quantity: 400 });
    expect(res.clamped).toBe(false);
    expect(netAcquired(34)).toBe(400);
  });

  test('edits the row IN PLACE (no adjustment row appended)', async () => {
    const { ledgerId } = await mp.addManualItemAcquisition('P1', 34, { quantity: 100, unitPrice: 5 });
    expect(ledgerRows()).toHaveLength(1);

    await mp.updateLedgerEntry(ledgerId, { quantity: 250, unitPrice: 7, note: 'edited' });

    const rows = ledgerRows();
    expect(rows).toHaveLength(1); // same row mutated, not a new adjustment row
    const row = rows[0];
    expect(row.ledger_id).toBe(ledgerId);
    expect(row.quantity).toBe(250);
    expect(row.unit_price).toBeCloseTo(7);
    expect(row.note).toBe('edited');
    expect(row.event_type).toBe('acquired'); // still an acquisition, not 'adjusted'
  });
});
