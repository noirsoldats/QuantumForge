/**
 * Unit tests for the rate-limit extensions to esi-status-tracker.
 *
 * Covers:
 *  - the guarded ALTER adds the 5 ratelimit columns idempotently to a
 *    pre-existing esi-status.db (simulated with an in-memory better-sqlite3 DB)
 *  - recordESICallSuccess now persists next_allowed_at
 *  - recordRateLimit writes the ratelimit_* columns
 *  - canFetchEndpoint is true/false around the next_allowed_at boundary
 *
 * The tracker keeps a module-scope singleton `db`; we inject an in-memory DB by
 * mocking better-sqlite3's constructor to return our shared instance.
 */

// The real constructor — mocking 'better-sqlite3' below would otherwise replace it.
const RealDatabase = jest.requireActual('better-sqlite3');

// A single shared in-memory DB the tracker will "open".
let mockDb;

jest.mock('better-sqlite3', () => {
  return jest.fn(() => mockDb);
});

jest.mock('../../src/main/portable-mode', () => ({
  getDataPath: jest.fn(() => '/tmp/qf-test'),
}));

/** Create a fresh in-memory DB with ONLY the legacy (pre-ratelimit) schema. */
function makeLegacyDb() {
  const db = new RealDatabase(':memory:');
  db.exec(`
    CREATE TABLE esi_call_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_key TEXT NOT NULL UNIQUE,
      call_category TEXT NOT NULL,
      character_id INTEGER,
      endpoint_type TEXT NOT NULL,
      endpoint_label TEXT NOT NULL,
      status TEXT NOT NULL,
      last_query_at INTEGER,
      cache_expires_at INTEGER,
      next_allowed_at INTEGER,
      error_message TEXT,
      error_code TEXT,
      request_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE esi_call_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_key TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      error_message TEXT,
      error_code TEXT,
      response_size INTEGER
    );
  `);
  return db;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

describe('esi-status-tracker rate-limit extensions', () => {
  let tracker;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDb = makeLegacyDb();
    tracker = require('../../src/main/esi-status-tracker');
    tracker.initializeESIStatusDatabase();
  });

  afterEach(() => {
    if (mockDb) mockDb.close();
    mockDb = null;
  });

  test('guarded ALTER adds the 5 ratelimit columns to a pre-existing DB', () => {
    const cols = columnNames(mockDb, 'esi_call_status');
    expect(cols).toEqual(expect.arrayContaining([
      'ratelimit_remaining',
      'ratelimit_limit',
      'ratelimit_group',
      'ratelimit_reset_at',
      'retry_after_at',
    ]));
  });

  test('re-initialization is idempotent (no duplicate-column error)', () => {
    // Running init again should not throw even though columns already exist.
    expect(() => tracker.initializeESIStatusDatabase()).not.toThrow();
    const cols = columnNames(mockDb, 'esi_call_status');
    // Still exactly one of each ratelimit column.
    expect(cols.filter(c => c === 'ratelimit_remaining')).toHaveLength(1);
  });

  test('recordESICallSuccess persists next_allowed_at', () => {
    tracker.recordESICallStart('character_1_skills', {
      category: 'character', characterId: 1, endpointType: 'skills', endpointLabel: 'Skills',
    });
    const nextAllowed = Date.now() + 5 * 60 * 1000;
    tracker.recordESICallSuccess('character_1_skills', Date.now() + 1000, nextAllowed, 100, Date.now());

    const row = mockDb.prepare('SELECT next_allowed_at FROM esi_call_status WHERE call_key = ?')
      .get('character_1_skills');
    expect(row.next_allowed_at).toBe(nextAllowed);
  });

  test('recordRateLimit writes the ratelimit_* columns', () => {
    tracker.recordESICallStart('character_1_skills', {
      category: 'character', characterId: 1, endpointType: 'skills', endpointLabel: 'Skills',
    });
    const resetAt = Date.now() + 900000;
    tracker.recordRateLimit('character_1_skills', {
      remaining: 42, limit: '150/15m', group: 'character', resetAt, retryAfterAt: null,
    });

    const row = mockDb.prepare(`
      SELECT ratelimit_remaining, ratelimit_limit, ratelimit_group, ratelimit_reset_at
      FROM esi_call_status WHERE call_key = ?
    `).get('character_1_skills');
    expect(row.ratelimit_remaining).toBe(42);
    expect(row.ratelimit_limit).toBe('150/15m');
    expect(row.ratelimit_group).toBe('character');
    expect(row.ratelimit_reset_at).toBe(resetAt);
  });

  describe('canFetchEndpoint', () => {
    test('true when no row exists', () => {
      expect(tracker.canFetchEndpoint('never_seen')).toBe(true);
    });

    test('true when next_allowed_at is null', () => {
      tracker.recordESICallStart('character_1_skills', {
        category: 'character', characterId: 1, endpointType: 'skills', endpointLabel: 'Skills',
      });
      expect(tracker.canFetchEndpoint('character_1_skills')).toBe(true);
    });

    test('false when next_allowed_at is in the future', () => {
      tracker.recordESICallStart('character_1_skills', {
        category: 'character', characterId: 1, endpointType: 'skills', endpointLabel: 'Skills',
      });
      tracker.recordESICallSuccess('character_1_skills', null, Date.now() + 60000, 0, Date.now());
      expect(tracker.canFetchEndpoint('character_1_skills')).toBe(false);
    });

    test('true when next_allowed_at is in the past', () => {
      tracker.recordESICallStart('character_1_skills', {
        category: 'character', characterId: 1, endpointType: 'skills', endpointLabel: 'Skills',
      });
      tracker.recordESICallSuccess('character_1_skills', null, Date.now() - 1000, 0, Date.now());
      expect(tracker.canFetchEndpoint('character_1_skills')).toBe(true);
    });
  });

  test('getEndpointFreshness reports eligibility + ratelimit info', () => {
    tracker.recordESICallStart('character_1_skills', {
      category: 'character', characterId: 1, endpointType: 'skills', endpointLabel: 'Skills',
    });
    tracker.recordESICallSuccess('character_1_skills', null, Date.now() + 60000, 0, Date.now());
    tracker.recordRateLimit('character_1_skills', { remaining: 10, group: 'character' });

    const fresh = tracker.getEndpointFreshness('character_1_skills');
    expect(fresh.callKey).toBe('character_1_skills');
    expect(fresh.eligible).toBe(false);
    expect(fresh.ratelimitRemaining).toBe(10);
  });
});
