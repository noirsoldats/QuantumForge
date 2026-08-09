/**
 * Corporation name resolver.
 *
 * The value of this module is its CACHING, not its fetching: corporation
 * names are needed once per character card, several characters usually share
 * a corp, and the Hub re-renders on every background refresh cycle. Without
 * the session cache and in-flight dedupe that would be a request storm.
 *
 * Mirrors esi-structures.js, so these tests mirror its guarantees.
 */

jest.mock('../../src/main/esi-fetch', () => ({
  esiFetch: jest.fn(),
}));

let esiFetch;
let corporations;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  ({ esiFetch } = require('../../src/main/esi-fetch'));
  corporations = require('../../src/main/esi-corporations');
  corporations.clearCorporationCache();

  esiFetch.mockResolvedValue({
    data: { name: 'Forge Dynamics', ticker: 'FRGE' },
  });
});

describe('resolveCorporation', () => {
  test('returns the name and ticker', async () => {
    const info = await corporations.resolveCorporation(98000001);

    expect(info).toEqual({
      corporationId: 98000001,
      name: 'Forge Dynamics',
      ticker: 'FRGE',
    });
  });

  test('calls the PUBLIC endpoint with no auth', async () => {
    // /corporations/{id}/ needs no token and no scope, so this resolves even
    // before a character is connected.
    await corporations.resolveCorporation(98000001);

    const [endpointType, callKey, url, opts] = esiFetch.mock.calls[0];
    expect(endpointType).toBe('corporation_info');
    expect(callKey).toBe('corporation_98000001');
    expect(url).toContain('/corporations/98000001/');
    expect(opts.requiresAuth).toBe(false);
  });

  test('bypasses the per-endpoint gate', async () => {
    // The in-memory cache governs cadence here; the gate would otherwise
    // suppress a first-time lookup for a corp seen in another session.
    await corporations.resolveCorporation(98000001);

    expect(esiFetch.mock.calls[0][3].skipGate).toBe(true);
  });

  test('null for a falsy id, without calling ESI', async () => {
    expect(await corporations.resolveCorporation(0)).toBeNull();
    expect(await corporations.resolveCorporation(null)).toBeNull();
    expect(esiFetch).not.toHaveBeenCalled();
  });
});

describe('session cache', () => {
  test('fetches once, then serves from cache', async () => {
    await corporations.resolveCorporation(98000001);
    await corporations.resolveCorporation(98000001);
    await corporations.resolveCorporation(98000001);

    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('dedupes concurrent callers onto one in-flight fetch', async () => {
    // The Hub resolves every character at once, so several cards can ask for
    // the same corp in the same tick.
    let release;
    esiFetch.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ data: { name: 'Forge Dynamics', ticker: 'FRGE' } });
    }));

    const all = Promise.all([
      corporations.resolveCorporation(98000001),
      corporations.resolveCorporation(98000001),
      corporations.resolveCorporation(98000001),
    ]);
    release();
    const results = await all;

    expect(esiFetch).toHaveBeenCalledTimes(1);
    results.forEach((r) => expect(r.name).toBe('Forge Dynamics'));
  });

  test('a failure is cached as unresolvable for the session', async () => {
    // Otherwise every re-render retries a corp that will not resolve.
    esiFetch.mockRejectedValue(new Error('rate limited'));

    expect(await corporations.resolveCorporation(98000001)).toBeNull();
    expect(await corporations.resolveCorporation(98000001)).toBeNull();

    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('a gated response is cached as unresolvable', async () => {
    esiFetch.mockResolvedValue({ skipped: true, reason: 'gated' });

    expect(await corporations.resolveCorporation(98000001)).toBeNull();
    expect(await corporations.resolveCorporation(98000001)).toBeNull();
    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('a nameless response is treated as unresolvable', async () => {
    esiFetch.mockResolvedValue({ data: {} });

    expect(await corporations.resolveCorporation(98000001)).toBeNull();
  });

  test('clearing the cache allows a refetch', async () => {
    await corporations.resolveCorporation(98000001);
    corporations.clearCorporationCache();
    await corporations.resolveCorporation(98000001);

    expect(esiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('resolveCorporationNames', () => {
  test('returns an id -> name map', async () => {
    esiFetch.mockImplementation((type, key) => Promise.resolve({
      data: { name: `Corp ${key.split('_')[1]}`, ticker: 'X' },
    }));

    const names = await corporations.resolveCorporationNames([98000001, 98000002]);

    expect(names).toEqual({
      98000001: 'Corp 98000001',
      98000002: 'Corp 98000002',
    });
  });

  test('dedupes repeated ids', async () => {
    // Several characters in the same corporation is the common case.
    await corporations.resolveCorporationNames([98000001, 98000001, 98000001]);

    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('drops falsy ids without calling ESI for them', async () => {
    await corporations.resolveCorporationNames([98000001, null, 0, undefined]);

    expect(esiFetch).toHaveBeenCalledTimes(1);
  });

  test('omits ids that could not be resolved rather than inventing a name', async () => {
    // The caller falls back to "Corporation <id>", which is honest; a made-up
    // name would not be.
    esiFetch.mockImplementation((type, key) => (
      key === 'corporation_98000002'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve({ data: { name: 'Forge Dynamics', ticker: 'FRGE' } })
    ));

    const names = await corporations.resolveCorporationNames([98000001, 98000002]);

    expect(names).toEqual({ 98000001: 'Forge Dynamics' });
  });

  test('an empty or missing list resolves to an empty map', async () => {
    expect(await corporations.resolveCorporationNames([])).toEqual({});
    expect(await corporations.resolveCorporationNames()).toEqual({});
    expect(esiFetch).not.toHaveBeenCalled();
  });
});
