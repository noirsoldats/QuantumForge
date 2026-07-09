/**
 * Unit tests for the durable-log saves in esi-wallet.js:
 *  - saveWalletTransactions: composite-key upsert, corp columns, client_id/journal_ref_id,
 *    durable (a smaller later window retains prior rows), char/corp coexist on same id.
 *  - saveWalletJournal: composite-key upsert, all journal columns, durable, char/corp coexist.
 *  - getWalletJournal filters by ref_type / context_id.
 */

const RealDatabase = require('better-sqlite3');

let mockDb;

jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));
jest.mock('../../src/main/esi-fetch', () => ({ esiFetch: jest.fn() }));
jest.mock('../../src/main/settings-manager', () => ({ getCharacter: jest.fn() }));

function makeWalletDb() {
  const db = new RealDatabase(':memory:');
  db.exec(`
    CREATE TABLE esi_wallet_transactions (
      transaction_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      is_corporation INTEGER NOT NULL DEFAULT 0,
      corporation_id INTEGER,
      division INTEGER,
      date INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      location_id INTEGER NOT NULL,
      is_buy INTEGER NOT NULL,
      is_personal INTEGER,
      client_id INTEGER,
      journal_ref_id INTEGER,
      last_updated INTEGER NOT NULL,
      cache_expires_at INTEGER,
      PRIMARY KEY (transaction_id, character_id, is_corporation)
    );
    CREATE TABLE esi_wallet_journal (
      id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      is_corporation INTEGER NOT NULL DEFAULT 0,
      corporation_id INTEGER,
      division INTEGER,
      date INTEGER NOT NULL,
      ref_type TEXT NOT NULL,
      amount REAL,
      balance REAL,
      context_id INTEGER,
      context_id_type TEXT,
      first_party_id INTEGER,
      second_party_id INTEGER,
      reason TEXT,
      tax REAL,
      tax_receiver_id INTEGER,
      last_updated INTEGER NOT NULL,
      cache_expires_at INTEGER,
      PRIMARY KEY (id, character_id, is_corporation)
    );
  `);
  return db;
}

function tx(overrides = {}) {
  return {
    transaction_id: 1, date: '2026-01-01T00:00:00Z', type_id: 34, quantity: 10,
    unit_price: 5.0, location_id: 60003760, is_buy: true, is_personal: true,
    client_id: 999, journal_ref_id: 7001, ...overrides,
  };
}

function jrnl(overrides = {}) {
  return {
    id: 1, date: '2026-01-01T00:00:00Z', ref_type: 'brokers_fee', amount: -12.5,
    balance: 1000, context_id: 5001, context_id_type: 'market_transaction_id',
    first_party_id: 1, second_party_id: 2, reason: '', tax: null, tax_receiver_id: null,
    ...overrides,
  };
}

describe('esi-wallet durable saves', () => {
  let saveWalletTransactions, saveWalletJournal, getWalletJournal, getWalletTransactions;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDb = makeWalletDb();
    ({ saveWalletTransactions, saveWalletJournal, getWalletJournal, getWalletTransactions } =
      require('../../src/main/esi-wallet'));
  });

  afterEach(() => {
    if (mockDb) mockDb.close();
    mockDb = null;
  });

  const txCount = () => mockDb.prepare('SELECT COUNT(*) c FROM esi_wallet_transactions').get().c;
  const jCount = () => mockDb.prepare('SELECT COUNT(*) c FROM esi_wallet_journal').get().c;

  describe('saveWalletTransactions', () => {
    it('persists corp columns + client_id/journal_ref_id, date in ms', () => {
      saveWalletTransactions({
        characterId: 42, isCorporation: true, corporationId: 555, division: 2, lastUpdated: 1000,
        transactions: [tx({ transaction_id: 100, is_personal: undefined })],
      });
      const row = mockDb.prepare('SELECT * FROM esi_wallet_transactions WHERE transaction_id = 100').get();
      expect(row.is_corporation).toBe(1);
      expect(row.corporation_id).toBe(555);
      expect(row.division).toBe(2);
      expect(row.client_id).toBe(999);
      expect(row.journal_ref_id).toBe(7001);
      expect(row.is_personal).toBeNull(); // corp tx has no is_personal
      expect(row.date).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    });

    it('is durable: a later smaller window retains prior rows', () => {
      saveWalletTransactions({
        characterId: 42, lastUpdated: 1000,
        transactions: [tx({ transaction_id: 1 }), tx({ transaction_id: 2 })],
      });
      expect(txCount()).toBe(2);
      saveWalletTransactions({
        characterId: 42, lastUpdated: 2000,
        transactions: [tx({ transaction_id: 1 })],
      });
      expect(txCount()).toBe(2); // no blind delete
    });

    it('char and corp rows with the same transaction_id coexist', () => {
      saveWalletTransactions({ characterId: 42, lastUpdated: 1, transactions: [tx({ transaction_id: 500 })] });
      saveWalletTransactions({
        characterId: 42, isCorporation: true, corporationId: 555, division: 1, lastUpdated: 1,
        transactions: [tx({ transaction_id: 500, is_personal: undefined })],
      });
      expect(txCount()).toBe(2);
    });
  });

  describe('saveWalletJournal', () => {
    it('persists all journal columns, date in ms', () => {
      saveWalletJournal({ characterId: 42, lastUpdated: 1000, entries: [jrnl({ id: 10 })] });
      const row = mockDb.prepare('SELECT * FROM esi_wallet_journal WHERE id = 10').get();
      expect(row.ref_type).toBe('brokers_fee');
      expect(row.amount).toBe(-12.5);
      expect(row.context_id).toBe(5001);
      expect(row.context_id_type).toBe('market_transaction_id');
      expect(row.date).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    });

    it('is durable: re-saving a smaller window retains prior journal rows', () => {
      saveWalletJournal({ characterId: 42, lastUpdated: 1, entries: [jrnl({ id: 1 }), jrnl({ id: 2 })] });
      expect(jCount()).toBe(2);
      saveWalletJournal({ characterId: 42, lastUpdated: 2, entries: [jrnl({ id: 1 })] });
      expect(jCount()).toBe(2);
    });

    it('char and corp journal with the same id coexist', () => {
      saveWalletJournal({ characterId: 42, lastUpdated: 1, entries: [jrnl({ id: 77 })] });
      saveWalletJournal({
        characterId: 42, isCorporation: true, corporationId: 555, division: 1, lastUpdated: 1,
        entries: [jrnl({ id: 77 })],
      });
      expect(jCount()).toBe(2);
    });
  });

  describe('getWalletJournal', () => {
    it('filters by ref_type and context_id', () => {
      saveWalletJournal({
        characterId: 42, lastUpdated: 1,
        entries: [
          jrnl({ id: 1, ref_type: 'brokers_fee', context_id: 100 }),
          jrnl({ id: 2, ref_type: 'transaction_tax', context_id: 100 }),
          jrnl({ id: 3, ref_type: 'brokers_fee', context_id: 200 }),
        ],
      });
      expect(getWalletJournal(42, { refType: 'brokers_fee' })).toHaveLength(2);
      expect(getWalletJournal(42, { contextId: 100 })).toHaveLength(2);
      expect(getWalletJournal(42, { refType: 'brokers_fee', contextId: 200 })).toHaveLength(1);
    });
  });
});
