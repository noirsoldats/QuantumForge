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
