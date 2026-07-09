/**
 * Integration-style tests (in-memory better-sqlite3) for Layer 3:
 *  - matchTransactionsToPlan honors corporationIds
 *  - the ms/seconds fix: a tx/job just outside maxDaysAgo is excluded, inside included
 *  - confirmTransactionMatch writes an idempotent purchased ledger row; reject/unlink removes it
 *  - confirmJobMatch writes a job_install cost row from the real ESI cost
 *  - attributeJournalFeesToPlan links fees via context_id to confirmed tx/jobs (idempotent),
 *    ignores unattributed fees, and dependents are removed when the parent is unlinked
 */

const RealDatabase = require('better-sqlite3');

let mockDb;
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));

const DAY = 24 * 60 * 60 * 1000;

function buildSchema(db) {
  db.exec(`
    CREATE TABLE manufacturing_plans (plan_id TEXT PRIMARY KEY, character_id INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE plan_blueprints (
      plan_blueprint_id TEXT PRIMARY KEY, plan_id TEXT, blueprint_type_id INTEGER,
      runs INTEGER, me_level INTEGER, te_level INTEGER, facility_id TEXT, added_at INTEGER
    );
    CREATE TABLE plan_material_nodes (
      node_id TEXT PRIMARY KEY, plan_id TEXT, type_id INTEGER, node_type TEXT,
      depth INTEGER, quantity_needed REAL, price_each REAL
    );
    CREATE TABLE esi_industry_jobs (
      job_id INTEGER PRIMARY KEY, character_id INTEGER, installer_id INTEGER, facility_id INTEGER,
      activity_id INTEGER, blueprint_type_id INTEGER, runs INTEGER, status TEXT,
      start_date INTEGER, end_date INTEGER, completed_date INTEGER, last_updated INTEGER,
      cache_expires_at INTEGER, is_corporation INTEGER DEFAULT 0, corporation_id INTEGER,
      cost REAL, product_type_id INTEGER
    );
    CREATE TABLE esi_wallet_transactions (
      transaction_id INTEGER NOT NULL, character_id INTEGER NOT NULL, is_corporation INTEGER NOT NULL DEFAULT 0,
      corporation_id INTEGER, division INTEGER, date INTEGER NOT NULL, type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL, unit_price REAL NOT NULL, location_id INTEGER NOT NULL,
      is_buy INTEGER NOT NULL, is_personal INTEGER, client_id INTEGER, journal_ref_id INTEGER,
      last_updated INTEGER NOT NULL, cache_expires_at INTEGER,
      PRIMARY KEY (transaction_id, character_id, is_corporation)
    );
    CREATE TABLE esi_wallet_journal (
      id INTEGER NOT NULL, character_id INTEGER NOT NULL, is_corporation INTEGER NOT NULL DEFAULT 0,
      corporation_id INTEGER, division INTEGER, date INTEGER NOT NULL, ref_type TEXT NOT NULL,
      amount REAL, balance REAL, context_id INTEGER, context_id_type TEXT,
      first_party_id INTEGER, second_party_id INTEGER, reason TEXT, tax REAL, tax_receiver_id INTEGER,
      last_updated INTEGER NOT NULL, cache_expires_at INTEGER,
      PRIMARY KEY (id, character_id, is_corporation)
    );
    CREATE TABLE plan_job_matches (
      match_id TEXT PRIMARY KEY, plan_id TEXT, plan_blueprint_id TEXT, job_id INTEGER,
      match_confidence REAL, match_reason TEXT, status TEXT DEFAULT 'pending',
      confirmed_at INTEGER, confirmed_by_user INTEGER DEFAULT 0
    );
    CREATE TABLE plan_transaction_matches (
      match_id TEXT PRIMARY KEY, plan_id TEXT, transaction_id INTEGER, type_id INTEGER,
      match_type TEXT, quantity INTEGER, match_confidence REAL, match_reason TEXT,
      status TEXT DEFAULT 'pending', confirmed_at INTEGER, confirmed_by_user INTEGER DEFAULT 0,
      is_corporation INTEGER DEFAULT 0
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
}

let pm;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockDb = new RealDatabase(':memory:');
  buildSchema(mockDb);
  pm = require('../../src/main/plan-matching');
});
afterEach(() => { if (mockDb) mockDb.close(); mockDb = null; });

const ledgerRows = () => mockDb.prepare('SELECT * FROM plan_material_ledger').all();

function addMaterialNode(typeId, qty, price) {
  mockDb.prepare(`INSERT INTO plan_material_nodes (node_id, plan_id, type_id, node_type, depth, quantity_needed, price_each)
    VALUES (?, 'P1', ?, 'material', 1, ?, ?)`).run(`n-${typeId}`, typeId, qty, price);
}
function addTx(o) {
  mockDb.prepare(`INSERT INTO esi_wallet_transactions
    (transaction_id, character_id, is_corporation, corporation_id, date, type_id, quantity, unit_price, location_id, is_buy, is_personal, last_updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.transaction_id, o.character_id ?? 1, o.is_corporation ?? 0, o.corporation_id ?? null,
    o.date, o.type_id, o.quantity, o.unit_price, o.location_id ?? 60003760, o.is_buy ?? 1, o.is_personal ?? 1, 1
  );
}

describe('matchTransactionsToPlan — corp + ms/seconds', () => {
  test('matches corporation transactions when corporationIds provided', () => {
    addMaterialNode(34, 100, 5.0);
    addTx({ transaction_id: 900, is_corporation: 1, corporation_id: 555, date: Date.now(), type_id: 34, quantity: 100, unit_price: 5.0 });

    const matches = pm.matchTransactionsToPlan('P1', { characterIds: [1], corporationIds: [555], minConfidence: 0.3 });
    expect(matches.length).toBe(1);
    expect(matches[0].transaction.transaction_id).toBe(900);
  });

  test('ms/seconds fix: excludes a tx just outside maxDaysAgo, includes one inside', () => {
    addMaterialNode(34, 100, 5.0);
    const now = Date.now();
    addTx({ transaction_id: 1, date: now - 5 * DAY, type_id: 34, quantity: 100, unit_price: 5.0 });   // inside 30d
    addTx({ transaction_id: 2, date: now - 40 * DAY, type_id: 34, quantity: 100, unit_price: 5.0 });  // outside 30d

    const matches = pm.matchTransactionsToPlan('P1', { characterIds: [1], maxDaysAgo: 30, minConfidence: 0.3 });
    const ids = matches.map(m => m.transaction.transaction_id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });
});

describe('transaction ledger write-through', () => {
  function seedConfirmableTxMatch() {
    addTx({ transaction_id: 500, date: Date.now(), type_id: 34, quantity: 100, unit_price: 5.0, is_buy: 1 });
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status)
      VALUES ('M1','P1',500,34,'material_buy',100,0.9,'pending')`).run();
  }

  test('confirm writes an idempotent purchased ledger row', () => {
    seedConfirmableTxMatch();
    pm.confirmTransactionMatch('M1');
    let rows = ledgerRows().filter(r => r.source_type === 'wallet_transaction');
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('purchased');
    expect(rows[0].quantity).toBe(100);
    expect(rows[0].unit_price).toBe(5.0);

    // Re-confirm → still one row (idempotent via unique source index).
    pm.confirmTransactionMatch('M1');
    rows = ledgerRows().filter(r => r.source_type === 'wallet_transaction');
    expect(rows).toHaveLength(1);
  });

  test('reject removes the ledger row', () => {
    seedConfirmableTxMatch();
    pm.confirmTransactionMatch('M1');
    expect(ledgerRows()).toHaveLength(1);
    pm.rejectTransactionMatch('M1');
    expect(ledgerRows()).toHaveLength(0);
  });

  test('unlink removes the ledger row', () => {
    seedConfirmableTxMatch();
    pm.confirmTransactionMatch('M1');
    pm.unlinkTransactionMatch('M1');
    expect(ledgerRows()).toHaveLength(0);
  });

  test('confirm disambiguates char vs corp tx sharing a transaction_id', () => {
    // Same transaction_id 500 in both the personal and corp wallet, different qty.
    addTx({ transaction_id: 500, is_corporation: 0, date: Date.now(), type_id: 34, quantity: 10, unit_price: 5.0, is_buy: 1 });
    addTx({ transaction_id: 500, is_corporation: 1, corporation_id: 555, date: Date.now(), type_id: 34, quantity: 99, unit_price: 7.0, is_buy: 1 });
    // A match against the CORP row.
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status, is_corporation)
      VALUES ('MC','P1',500,34,'material_buy',99,0.9,'pending',1)`).run();

    pm.confirmTransactionMatch('MC');
    const row = ledgerRows().find(r => r.source_type === 'wallet_transaction');
    // Must reflect the CORP transaction (qty 99 @ 7), not the personal one.
    expect(row.quantity).toBe(99);
    expect(row.unit_price).toBe(7.0);
    expect(row.corporation_id).toBe(555);
  });
});

describe('product-sale ledger write-through', () => {
  function seedConfirmableSellMatch() {
    addTx({ transaction_id: 800, date: Date.now(), type_id: 34, quantity: 20, unit_price: 100, is_buy: 0 });
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status)
      VALUES ('MS','P1',800,34,'product_sell',20,0.9,'pending')`).run();
  }

  test('confirming a sell writes an event_type=sold row (not acquired/purchased)', () => {
    seedConfirmableSellMatch();
    pm.confirmTransactionMatch('MS');
    const rows = ledgerRows().filter(r => r.source_type === 'wallet_transaction');
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('sold');
    expect(rows[0].method).toBe('sold');
    expect(rows[0].quantity).toBe(20);
    expect(rows[0].unit_price).toBe(100);
  });

  test('a confirmed sell is unlinkable and reverts the match', () => {
    seedConfirmableSellMatch();
    pm.confirmTransactionMatch('MS');
    pm.unlinkTransactionMatch('MS');
    expect(ledgerRows().filter(r => r.source_type === 'wallet_transaction')).toHaveLength(0);
    expect(mockDb.prepare(`SELECT COUNT(*) c FROM plan_transaction_matches WHERE match_id='MS'`).get().c).toBe(0);
  });
});

describe('job ledger write-through', () => {
  function seedConfirmableJobMatch(cost) {
    mockDb.prepare(`INSERT INTO esi_industry_jobs
      (job_id, character_id, installer_id, facility_id, activity_id, blueprint_type_id, runs, status, last_updated, cost)
      VALUES (700, 1, 1, 1, 1, 100, 5, 'active', 1, ?)`).run(cost);
    mockDb.prepare(`INSERT INTO plan_job_matches (match_id, plan_id, plan_blueprint_id, job_id, match_confidence, status)
      VALUES ('J1','P1','pb1',700,0.9,'pending')`).run();
  }

  test('confirm writes a job_install cost row from the real ESI cost', () => {
    seedConfirmableJobMatch(123456.78);
    pm.confirmJobMatch('J1');
    const rows = ledgerRows().filter(r => r.source_type === 'industry_job');
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('cost');
    expect(rows[0].cost_category).toBe('job_install');
    expect(rows[0].unit_price).toBeCloseTo(123456.78);
    expect(rows[0].quantity).toBe(0);
  });

  test('no ledger row when ESI cost is absent', () => {
    seedConfirmableJobMatch(null);
    pm.confirmJobMatch('J1');
    expect(ledgerRows().filter(r => r.source_type === 'industry_job')).toHaveLength(0);
  });

  test('reject/unlink removes the job cost row', () => {
    seedConfirmableJobMatch(500);
    pm.confirmJobMatch('J1');
    expect(ledgerRows()).toHaveLength(1);
    pm.rejectJobMatch('J1');
    expect(ledgerRows()).toHaveLength(0);
  });
});

describe('journal-fee attribution', () => {
  function addJournal(o) {
    mockDb.prepare(`INSERT INTO esi_wallet_journal
      (id, character_id, is_corporation, date, ref_type, amount, context_id, context_id_type, last_updated)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      o.id, o.character_id ?? 1, o.is_corporation ?? 0, o.date ?? Date.now(),
      o.ref_type, o.amount, o.context_id, o.context_id_type ?? 'market_transaction_id', 1
    );
  }
  function confirmTx(txId) {
    addTx({ transaction_id: txId, date: Date.now(), type_id: 34, quantity: 100, unit_price: 5.0, is_buy: 1 });
    mockDb.prepare(`INSERT INTO plan_transaction_matches (match_id, plan_id, transaction_id, type_id, match_type, quantity, match_confidence, status)
      VALUES (?,?,?,34,'material_buy',100,0.9,'pending')`).run(`MT${txId}`, 'P1', txId);
    pm.confirmTransactionMatch(`MT${txId}`);
    return `MT${txId}`;
  }

  test('attributes broker_fee/transaction_tax to a confirmed transaction (idempotent)', () => {
    confirmTx(500);
    addJournal({ id: 10, ref_type: 'brokers_fee', amount: -12.5, context_id: 500 });
    addJournal({ id: 11, ref_type: 'transaction_tax', amount: -3.0, context_id: 500 });
    // Unattributed fee (no matching confirmed tx).
    addJournal({ id: 12, ref_type: 'brokers_fee', amount: -99, context_id: 999 });

    const n = pm.attributeJournalFeesToPlan('P1');
    expect(n).toBe(2);
    const fees = ledgerRows().filter(r => r.source_type === 'wallet_journal');
    expect(fees).toHaveLength(2);
    expect(fees.map(f => f.cost_category).sort()).toEqual(['broker_fee', 'sales_tax']);
    expect(fees.find(f => f.cost_category === 'broker_fee').unit_price).toBeCloseTo(12.5);

    // Idempotent re-run.
    pm.attributeJournalFeesToPlan('P1');
    expect(ledgerRows().filter(r => r.source_type === 'wallet_journal')).toHaveLength(2);
  });

  test('industry_job_tax attaches to a confirmed job', () => {
    mockDb.prepare(`INSERT INTO esi_industry_jobs
      (job_id, character_id, installer_id, facility_id, activity_id, blueprint_type_id, runs, status, last_updated, cost)
      VALUES (700, 1, 1, 1, 1, 100, 5, 'active', 1, 500)`).run();
    mockDb.prepare(`INSERT INTO plan_job_matches (match_id, plan_id, plan_blueprint_id, job_id, match_confidence, status)
      VALUES ('J1','P1','pb1',700,0.9,'pending')`).run();
    pm.confirmJobMatch('J1');

    addJournal({ id: 20, ref_type: 'industry_job_tax', amount: -50, context_id: 700, context_id_type: 'industry_job_id' });

    pm.attributeJournalFeesToPlan('P1');
    const fee = ledgerRows().find(r => r.source_type === 'wallet_journal');
    expect(fee).toBeDefined();
    expect(fee.cost_category).toBe('job_tax');
  });

  test('unlinking the parent transaction removes dependent fee rows', () => {
    const matchId = confirmTx(500);
    addJournal({ id: 10, ref_type: 'brokers_fee', amount: -12.5, context_id: 500 });
    pm.attributeJournalFeesToPlan('P1');
    expect(ledgerRows().filter(r => r.source_type === 'wallet_journal')).toHaveLength(1);

    pm.unlinkTransactionMatch(matchId);
    // Parent purchase row AND dependent fee row both gone.
    expect(ledgerRows()).toHaveLength(0);
  });
});
