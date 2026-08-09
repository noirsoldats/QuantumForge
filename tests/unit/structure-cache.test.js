/**
 * Persistent player-structure cache.
 *
 * WHY IT EXISTS: structure names were cached in memory only, so every launch
 * re-attempted every structure. Ones the character cannot dock at answer 403,
 * and 4xx responses spend ESI's APPLICATION-WIDE error budget (100 non-2xx/3xx
 * per minute, then 420 on every route). That per-launch 403 burst is what took
 * the background refresh cycle down.
 *
 * The two TTLs are the design, so they are what these tests pin:
 *   names   24h - a name can change; showing a stale one as fact is worse
 *   denials  7d - an ACCESS fact, unchanged by a rename. Giving denials the
 *                 24h TTL would restore the daily burst this cache prevents.
 */

const Database = require('better-sqlite3');

// jest.mock factories are hoisted above every declaration in this file, so the
// factory cannot close over an ordinary local. Jest permits a `mock`-prefixed
// name as the documented exception - preferred over hanging the handle off
// `global`, which leaks between suites if a teardown is ever missed.
let mockDb;
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: () => mockDb,
}));

const cache = require('../../src/main/structure-cache');

const STRUCTURE_ID = 1035466617946;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  mockDb = new Database(':memory:');
  mockDb.exec(`
    CREATE TABLE resolved_structures (
      structure_id    INTEGER PRIMARY KEY,
      name            TEXT,
      solar_system_id INTEGER,
      type_id         INTEGER,
      resolved_at     INTEGER,
      denied_at       INTEGER,
      resolved_by     INTEGER,
      updated_at      INTEGER NOT NULL
    );
  `);
});

afterEach(() => {
  mockDb.close();
});

describe('what may be cached', () => {
  test('player structures (>= 1 trillion) are cacheable', () => {
    expect(cache.isCacheable(STRUCTURE_ID)).toBe(true);
  });

  test('NPC stations are NOT - they come from the SDE and never call ESI', () => {
    // Caching them would add rows and save zero ESI calls.
    expect(cache.isCacheable(60003760)).toBe(false);
  });

  test('writing an NPC station is a no-op', () => {
    cache.putResolved(60003760, { name: 'Jita 4-4' });
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM resolved_structures').get().n).toBe(0);
  });
});

describe('name TTL (24h)', () => {
  test('a fresh name is served without calling ESI', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'A Citadel', solarSystemId: 30000142, typeId: 35832 }, 99, now);

    const hit = cache.get(STRUCTURE_ID, now + HOUR);

    expect(hit).toMatchObject({ status: 'resolved', name: 'A Citadel', solarSystemId: 30000142 });
  });

  test('a name older than 24h is a miss, so it gets re-resolved', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Renamed Since' }, 99, now);

    expect(cache.get(STRUCTURE_ID, now + DAY + 1000)).toBeNull();
  });

  test('the boundary sits exactly at 24h', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Edge' }, 99, now);

    expect(cache.get(STRUCTURE_ID, now + DAY - 1000)).not.toBeNull();
    expect(cache.get(STRUCTURE_ID, now + DAY)).toBeNull();
  });
});

describe('denial backoff (7 days)', () => {
  test('a fresh denial suppresses the ESI call', () => {
    // The entire point: do not re-ask for a structure we cannot dock at.
    const now = Date.now();
    cache.putDenied(STRUCTURE_ID, now);

    expect(cache.get(STRUCTURE_ID, now + DAY)).toMatchObject({ status: 'denied' });
  });

  test('denials outlive names - a denial is still held at 24h', () => {
    // If this ever equals the name TTL, the daily 403 burst comes back.
    const now = Date.now();
    cache.putDenied(STRUCTURE_ID, now);

    expect(cache.get(STRUCTURE_ID, now + DAY + HOUR).status).toBe('denied');
    expect(cache.DENIED_TTL_MS).toBeGreaterThan(cache.NAME_TTL_MS);
  });

  test('after 7 days it is retried', () => {
    const now = Date.now();
    cache.putDenied(STRUCTURE_ID, now);

    expect(cache.get(STRUCTURE_ID, now + 7 * DAY + 1000)).toBeNull();
  });

  test('a later success clears the denial - access was regained', () => {
    const now = Date.now();
    cache.putDenied(STRUCTURE_ID, now);
    cache.putResolved(STRUCTURE_ID, { name: 'Now Visible' }, 99, now + HOUR);

    const hit = cache.get(STRUCTURE_ID, now + 2 * HOUR);
    expect(hit).toMatchObject({ status: 'resolved', name: 'Now Visible' });
    expect(mockDb.prepare('SELECT denied_at FROM resolved_structures WHERE structure_id = ?')
      .get(STRUCTURE_ID).denied_at).toBeNull();
  });

  test('a denial KEEPS the last known name', () => {
    // Losing access should not blank a name we already showed the user.
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Was Visible' }, 99, now);
    cache.putDenied(STRUCTURE_ID, now + HOUR);

    expect(cache.getLastKnownName(STRUCTURE_ID)).toBe('Was Visible');
  });

  test('a fresh name wins over an older denial', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Visible' }, 99, now);
    // Denial arrives, but the name is still inside its own TTL.
    mockDb.prepare('UPDATE resolved_structures SET denied_at = ? WHERE structure_id = ?')
      .run(now + HOUR, STRUCTURE_ID);

    expect(cache.get(STRUCTURE_ID, now + 2 * HOUR).status).toBe('resolved');
  });
});

describe('manual refresh override', () => {
  // This is what makes a 7-day backoff defensible: the user is never stuck
  // waiting it out after being granted docking access.
  test('clears BOTH timers, not just one', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Old' }, 99, now);
    cache.putDenied(STRUCTURE_ID + 1, now);

    cache.clearBackoffs();

    expect(cache.get(STRUCTURE_ID, now + 1000)).toBeNull();
    expect(cache.get(STRUCTURE_ID + 1, now + 1000)).toBeNull();
  });

  test('keeps the stored names so display does not regress to bare IDs', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Keep Me' }, 99, now);

    cache.clearBackoffs();

    expect(cache.getLastKnownName(STRUCTURE_ID)).toBe('Keep Me');
  });

  test('can target specific structures only', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Target' }, 99, now);
    cache.putResolved(STRUCTURE_ID + 1, { name: 'Leave Alone' }, 99, now);

    cache.clearBackoffs([STRUCTURE_ID]);

    expect(cache.get(STRUCTURE_ID, now + 1000)).toBeNull();
    expect(cache.get(STRUCTURE_ID + 1, now + 1000)).not.toBeNull();
  });
});

describe('getRaw (used by the 304 path)', () => {
  test('returns the row ignoring both TTLs', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Stale', solarSystemId: 30000142, typeId: 35832 }, 99, now);

    // Well past the name TTL - get() would miss, getRaw must not.
    const raw = cache.getRaw(STRUCTURE_ID);

    expect(cache.get(STRUCTURE_ID, now + 2 * DAY)).toBeNull();
    expect(raw).toMatchObject({ name: 'Stale', solarSystemId: 30000142, typeId: 35832 });
  });

  test('null for an unknown structure', () => {
    expect(cache.getRaw(STRUCTURE_ID)).toBeNull();
  });
});

describe('resilience', () => {
  test('a broken database degrades to a miss rather than throwing', () => {
    // A cache is an optimisation; it must never break resolution.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.exec('DROP TABLE resolved_structures');

    expect(() => cache.get(STRUCTURE_ID)).not.toThrow();
    expect(cache.get(STRUCTURE_ID)).toBeNull();
    expect(() => cache.putResolved(STRUCTURE_ID, { name: 'x' })).not.toThrow();

    spy.mockRestore();
  });

  test('stats report both TTLs and the counts behind them', () => {
    const now = Date.now();
    cache.putResolved(STRUCTURE_ID, { name: 'Fresh' }, 99, now);
    cache.putDenied(STRUCTURE_ID + 1, now);

    const stats = cache.getStats(now);

    expect(stats).toMatchObject({ total: 2, fresh: 1, denied: 1 });
    expect(stats.deniedTtlMs).toBeGreaterThan(stats.nameTtlMs);
  });
});
