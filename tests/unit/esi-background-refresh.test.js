/**
 * Unit tests for the global background refresh cycle.
 *
 * Covers: runRefreshCycle enumerates characters + corp dedup; a throwing /
 * rate-limited / scope-error character doesn't abort the others; start/stop
 * set/clear the interval (fake timers); start is idempotent.
 */

jest.mock('../../src/main/settings-manager', () => ({
  getCharacters: jest.fn(),
  getCharacter: jest.fn(),
}));

jest.mock('../../src/main/esi-industry-jobs', () => ({
  fetchCharacterIndustryJobs: jest.fn(),
  fetchCorporationIndustryJobs: jest.fn(),
  saveIndustryJobs: jest.fn(),
}));

jest.mock('../../src/main/esi-wallet', () => ({
  fetchCharacterWalletTransactions: jest.fn(),
  saveWalletTransactions: jest.fn(),
}));

let refresh;
let getCharacters;
let fetchCharacterIndustryJobs, fetchCorporationIndustryJobs, saveIndustryJobs;
let fetchCharacterWalletTransactions, saveWalletTransactions;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  ({ getCharacters } = require('../../src/main/settings-manager'));
  ({ fetchCharacterIndustryJobs, fetchCorporationIndustryJobs, saveIndustryJobs } =
    require('../../src/main/esi-industry-jobs'));
  ({ fetchCharacterWalletTransactions, saveWalletTransactions } = require('../../src/main/esi-wallet'));
  refresh = require('../../src/main/esi-background-refresh');

  // Sensible default happy-path fetcher responses.
  fetchCharacterIndustryJobs.mockResolvedValue({ jobs: [], lastUpdated: 1, cacheExpiresAt: null });
  fetchCorporationIndustryJobs.mockResolvedValue({ jobs: [], lastUpdated: 1, cacheExpiresAt: null });
  fetchCharacterWalletTransactions.mockResolvedValue({ transactions: [], lastUpdated: 1 });
});

describe('buildCorporationCharacterMap', () => {
  test('dedupes to the first authed character per corporation', () => {
    const map = refresh.buildCorporationCharacterMap([
      { characterId: 1, corporationId: 100 },
      { characterId: 2, corporationId: 100 }, // same corp — ignored
      { characterId: 3, corporationId: 200 },
      { characterId: 4, corporationId: null }, // no corp — ignored
    ]);
    expect(map.get(100)).toBe(1);
    expect(map.get(200)).toBe(3);
    expect(map.size).toBe(2);
  });
});

describe('runRefreshCycle', () => {
  test('no-op when there are no authenticated characters', async () => {
    getCharacters.mockReturnValue([]);
    const summary = await refresh.runRefreshCycle();
    expect(summary.characterCount).toBe(0);
    expect(fetchCharacterIndustryJobs).not.toHaveBeenCalled();
  });

  test('fetches personal + corp endpoints for each character (deduped corp)', async () => {
    getCharacters.mockReturnValue([
      { characterId: 1, corporationId: 100 },
      { characterId: 2, corporationId: 100 },
    ]);

    await refresh.runRefreshCycle();

    // Personal industry + wallet for both characters.
    expect(fetchCharacterIndustryJobs).toHaveBeenCalledTimes(2);
    expect(fetchCharacterWalletTransactions).toHaveBeenCalledTimes(2);
    // Corp jobs only once (deduped by corp 100).
    expect(fetchCorporationIndustryJobs).toHaveBeenCalledTimes(1);
    expect(fetchCorporationIndustryJobs).toHaveBeenCalledWith(1, 100, true);
  });

  test('saves fetched jobs and transactions', async () => {
    getCharacters.mockReturnValue([{ characterId: 1, corporationId: null }]);
    fetchCharacterIndustryJobs.mockResolvedValue({ jobs: [{ job_id: 1 }], lastUpdated: 1, cacheExpiresAt: null });
    fetchCharacterWalletTransactions.mockResolvedValue({ transactions: [{ transaction_id: 9 }], lastUpdated: 1 });

    await refresh.runRefreshCycle();

    expect(saveIndustryJobs).toHaveBeenCalledWith(expect.objectContaining({ isCorporation: false }));
    expect(saveWalletTransactions).toHaveBeenCalled();
  });

  test('a gated fetcher is skipped without saving', async () => {
    getCharacters.mockReturnValue([{ characterId: 1, corporationId: null }]);
    fetchCharacterIndustryJobs.mockResolvedValue({ skipped: true });

    await refresh.runRefreshCycle();
    expect(saveIndustryJobs).not.toHaveBeenCalled();
  });

  test('one throwing character does not abort the others', async () => {
    getCharacters.mockReturnValue([
      { characterId: 1, corporationId: null },
      { characterId: 2, corporationId: null },
    ]);
    fetchCharacterIndustryJobs
      .mockRejectedValueOnce(new Error('boom')) // char 1 industry fails
      .mockResolvedValueOnce({ jobs: [], lastUpdated: 1, cacheExpiresAt: null }); // char 2 ok

    const summary = await refresh.runRefreshCycle();

    // char 2 still processed; error recorded, not thrown.
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(fetchCharacterWalletTransactions).toHaveBeenCalledTimes(2);
  });

  test('a rate-limited endpoint is recorded and does not abort', async () => {
    getCharacters.mockReturnValue([{ characterId: 1, corporationId: null }]);
    const rl = Object.assign(new Error('rate limited'), { code: 'ESI_RATE_LIMITED' });
    fetchCharacterIndustryJobs.mockRejectedValue(rl);

    const summary = await refresh.runRefreshCycle();
    expect(summary.errors.some(e => e.code === 'ESI_RATE_LIMITED')).toBe(true);
    // Wallet still attempted for the same character.
    expect(fetchCharacterWalletTransactions).toHaveBeenCalledTimes(1);
  });

  test('a scope-error character does not abort the others', async () => {
    getCharacters.mockReturnValue([
      { characterId: 1, corporationId: 100 },
      { characterId: 2, corporationId: null },
    ]);
    const scopeErr = Object.assign(new Error('scope'), { code: 'ESI_SCOPE_ERROR' });
    fetchCorporationIndustryJobs.mockRejectedValue(scopeErr);

    const summary = await refresh.runRefreshCycle();
    expect(summary.errors.some(e => e.code === 'ESI_SCOPE_ERROR')).toBe(true);
    expect(summary.characterCount).toBe(2);
  });
});

describe('start/stop lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    getCharacters.mockReturnValue([]); // keep cycles cheap
  });

  afterEach(() => {
    refresh.stopBackgroundRefresh();
    jest.useRealTimers();
  });

  test('start schedules an interval; getGlobalRefreshStatus reflects active', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    refresh.startBackgroundRefresh();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(refresh.getGlobalRefreshStatus().active).toBe(true);
  });

  test('start is idempotent (clear-then-set, one live interval)', () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    refresh.startBackgroundRefresh();
    refresh.startBackgroundRefresh();
    // Second start clears the first interval before setting a new one.
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(refresh.getGlobalRefreshStatus().active).toBe(true);
  });

  test('stop clears the interval', () => {
    refresh.startBackgroundRefresh();
    refresh.stopBackgroundRefresh();
    expect(refresh.getGlobalRefreshStatus().active).toBe(false);
  });
});
