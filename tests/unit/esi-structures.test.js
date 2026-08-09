/**
 * Unit tests for the in-memory player-structure name resolver.
 *  - resolves a structure name via esiFetch and caches it (one call per id)
 *  - concurrent callers dedupe onto a single in-flight fetch
 *  - failures/inaccessible are cached as null (no retry within the session)
 *  - clearStructureCache resets so a rename would be re-fetched next session
 */

const CHARACTER_ID = 42;
const STRUCT_ID = 1035000000001;

jest.mock('../../src/main/esi-fetch', () => ({ esiFetch: jest.fn() }));
jest.mock('../../src/main/settings-manager', () => ({
  getCharacters: jest.fn(),
  getCharacter: jest.fn(),
}));

// The persistent layer needs a real database; these tests cover the IN-MEMORY
// session cache in isolation, so it is stubbed to a permanent miss. Its own
// behaviour (24h names, 7-day denials) is covered in structure-cache.test.js.
jest.mock('../../src/main/structure-cache', () => ({
  get: jest.fn(() => null),
  getRaw: jest.fn(() => null),
  putResolved: jest.fn(),
  putDenied: jest.fn(),
  clearBackoffs: jest.fn(() => 0),
  getLastKnownName: jest.fn(() => null),
  getStats: jest.fn(() => ({ total: 0, fresh: 0, denied: 0 })),
  isCacheable: jest.fn((id) => Number(id) >= 1000000000000),
}));

const STRUCT_SCOPE = 'esi-universe.read_structures.v1';
const charWithScope = { characterId: CHARACTER_ID, scopes: [STRUCT_SCOPE] };

let esiStructures, esiFetch, getCharacter, getCharacters;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  ({ esiFetch } = require('../../src/main/esi-fetch'));
  ({ getCharacter, getCharacters } = require('../../src/main/settings-manager'));
  esiStructures = require('../../src/main/esi-structures');

  getCharacter.mockReturnValue({ ...charWithScope });
  getCharacters.mockReturnValue([{ ...charWithScope }]);
});

describe('resolveStructureName', () => {
  test('resolves and caches (one ESI call per id)', async () => {
    esiFetch.mockResolvedValue({ data: { name: 'Test Citadel', solar_system_id: 30000142, type_id: 35832 } });

    const n1 = await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);
    const n2 = await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);

    expect(n1).toBe('Test Citadel');
    expect(n2).toBe('Test Citadel');
    expect(esiFetch).toHaveBeenCalledTimes(1); // cached after first
  });

  test('concurrent callers dedupe onto one fetch', async () => {
    let resolveFetch;
    esiFetch.mockReturnValue(new Promise(r => { resolveFetch = r; }));

    const p1 = esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);
    const p2 = esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);
    resolveFetch({ data: { name: 'Shared Structure', solar_system_id: 1, type_id: 1 } });

    expect(await p1).toBe('Shared Structure');
    expect(await p2).toBe('Shared Structure');
    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('returns null and does not retry when no character has the scope', async () => {
    getCharacter.mockReturnValue({ characterId: CHARACTER_ID, scopes: [] });
    getCharacters.mockReturnValue([{ characterId: CHARACTER_ID, scopes: [] }]);

    const n = await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);
    expect(n).toBeNull();
    expect(esiFetch).not.toHaveBeenCalled();

    // Cached null — a second call still doesn't fetch.
    await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);
    expect(esiFetch).not.toHaveBeenCalled();
  });

  test('role-forbidden (no docking access) caches null, no retry', async () => {
    esiFetch.mockResolvedValue({ roleForbidden: true, data: [] });

    expect(await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID)).toBeNull();
    expect(await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID)).toBeNull();
    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('a thrown error caches null and does not retry this session', async () => {
    esiFetch.mockRejectedValue(Object.assign(new Error('403'), { code: 'ESI_SCOPE_ERROR' }));

    expect(await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID)).toBeNull();
    expect(await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID)).toBeNull();
    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('clearStructureCache forces a fresh fetch (rename picked up next session)', async () => {
    esiFetch.mockResolvedValue({ data: { name: 'Old Name', solar_system_id: 1, type_id: 1 } });
    expect(await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID)).toBe('Old Name');

    esiStructures.clearStructureCache();
    esiFetch.mockResolvedValue({ data: { name: 'New Name', solar_system_id: 1, type_id: 1 } });
    expect(await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID)).toBe('New Name');
    expect(esiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('what earns a persistent 7-day backoff', () => {
  // The distinction matters: a denial persists for a WEEK, so anything recorded
  // as one had better be a real access fact from ESI.
  let persistent;

  beforeEach(() => {
    persistent = require('../../src/main/structure-cache');
  });

  test('a role-403 IS persisted - ESI told us this character has no access', () => {
    esiFetch.mockResolvedValue({ roleForbidden: true, data: [] });

    return esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID).then(() => {
      expect(persistent.putDenied).toHaveBeenCalledWith(STRUCT_ID);
    });
  });

  test('a budget/gate refusal is NOT persisted - we never asked ESI', () => {
    // Persisting this would suppress, for a week, a lookup that might have
    // succeeded. It is a local decision, not an access fact.
    esiFetch.mockResolvedValue({ skipped: true, reason: 'error-budget-reserved' });

    return esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID).then(() => {
      expect(persistent.putDenied).not.toHaveBeenCalled();
    });
  });

  test('a thrown error is NOT persisted - network faults say nothing about access', () => {
    esiFetch.mockRejectedValue(new Error('network unreachable'));

    return esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID).then(() => {
      expect(persistent.putDenied).not.toHaveBeenCalled();
    });
  });

  test('missing scope is NOT persisted - it is a local capability gap', () => {
    getCharacter.mockReturnValue(null);
    getCharacters.mockReturnValue([]);

    return esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID).then(() => {
      expect(persistent.putDenied).not.toHaveBeenCalled();
      expect(esiFetch).not.toHaveBeenCalled();
    });
  });

  test('a successful resolve is persisted with the authenticating character', async () => {
    esiFetch.mockResolvedValue({ data: { name: 'Persisted', solar_system_id: 30000142, type_id: 35832 } });

    await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);

    expect(persistent.putResolved).toHaveBeenCalledWith(
      STRUCT_ID,
      expect.objectContaining({ name: 'Persisted', solarSystemId: 30000142 }),
      CHARACTER_ID
    );
  });
});

describe('304 Not Modified', () => {
  test('re-stamps the stored name instead of blanking it', async () => {
    // A 304 carries NO BODY. Reading that as "no name" would wipe a perfectly
    // good cache entry every time the 24h TTL rolled over.
    const persistent = require('../../src/main/structure-cache');
    persistent.getRaw.mockReturnValue({
      name: 'Unchanged Citadel', solarSystemId: 30000142, typeId: 35832,
    });
    esiFetch.mockResolvedValue({ data: null, notModified: true, status: 304 });

    const name = await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);

    expect(name).toBe('Unchanged Citadel');
    expect(persistent.putResolved).toHaveBeenCalledWith(
      STRUCT_ID,
      expect.objectContaining({ name: 'Unchanged Citadel' }),
      CHARACTER_ID
    );
  });

  test('conditional requests are requested for structures', async () => {
    esiFetch.mockResolvedValue({ data: { name: 'X', solar_system_id: 1, type_id: 1 } });

    await esiStructures.resolveStructureName(STRUCT_ID, CHARACTER_ID);

    expect(esiFetch).toHaveBeenCalledWith(
      'structure',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ useETag: true })
    );
  });
});

describe('manual refresh', () => {
  test('clears both backoffs before re-resolving', async () => {
    const persistent = require('../../src/main/structure-cache');
    esiFetch.mockResolvedValue({ data: { name: 'Refreshed', solar_system_id: 1, type_id: 1 } });

    const summary = await esiStructures.refreshStructures([STRUCT_ID], CHARACTER_ID);

    expect(persistent.clearBackoffs).toHaveBeenCalledWith([STRUCT_ID]);
    expect(summary).toMatchObject({ requested: 1, resolved: 1, stopped: false });
  });

  test('stops early when the error budget runs low, reporting partial progress', async () => {
    // Forcing a re-resolve of many previously denied structures is EXACTLY the
    // 403 burst that caused the original 420, so this must not grind on.
    const budget = require('../../src/main/esi-error-budget');
    const spy = jest.spyOn(budget, 'canSpend')
      .mockReturnValueOnce({ allowed: true, reason: null, remaining: 40 })
      .mockReturnValue({ allowed: false, reason: 'critical', remaining: 8 });
    esiFetch.mockResolvedValue({ data: { name: 'One', solar_system_id: 1, type_id: 1 } });

    const summary = await esiStructures.refreshStructures(
      [STRUCT_ID, STRUCT_ID + 1, STRUCT_ID + 2],
      CHARACTER_ID
    );

    expect(summary.stopped).toBe(true);
    expect(summary.requested).toBe(3);
    expect(summary.stoppedAfter).toBe(1);
    expect(esiFetch).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('spends into the reserve, because the user asked for it', async () => {
    const budget = require('../../src/main/esi-error-budget');
    const spy = jest.spyOn(budget, 'canSpend');
    esiFetch.mockResolvedValue({ data: { name: 'X', solar_system_id: 1, type_id: 1 } });

    await esiStructures.refreshStructures([STRUCT_ID], CHARACTER_ID);

    expect(spy).toHaveBeenCalledWith({ userInitiated: true });
    spy.mockRestore();
  });

  test('ignores non-structure ids', async () => {
    // NPC stations resolve from the SDE; refreshing them would be meaningless.
    const summary = await esiStructures.refreshStructures([60003760], CHARACTER_ID);

    expect(summary.requested).toBe(0);
    expect(esiFetch).not.toHaveBeenCalled();
  });
});
