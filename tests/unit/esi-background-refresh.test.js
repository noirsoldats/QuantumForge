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
  getCharacterDivisionSettings: jest.fn(() => ({ enabledDivisions: [] })),
}));

jest.mock('../../src/main/esi-industry-jobs', () => ({
  fetchCharacterIndustryJobs: jest.fn(),
  fetchCorporationIndustryJobs: jest.fn(),
  saveIndustryJobs: jest.fn(),
}));

jest.mock('../../src/main/esi-wallet', () => ({
  fetchCharacterWalletTransactions: jest.fn(),
  fetchCorporationWalletTransactions: jest.fn(),
  fetchCharacterWalletJournal: jest.fn(),
  fetchCorporationWalletJournal: jest.fn(),
  saveWalletTransactions: jest.fn(),
  saveWalletJournal: jest.fn(),
}));

jest.mock('../../src/main/esi-server-status', () => ({
  fetchServerStatus: jest.fn(),
}));

// The scheduler asks the gate when its endpoints are next due. Mocked so the
// tests exercise the real scheduling path rather than its DB-error fallback.
jest.mock('../../src/main/esi-status-tracker', () => ({
  getNextEligibleAt: jest.fn(() => null),
}));

let refresh;
let getCharacters;
let fetchCharacterIndustryJobs, fetchCorporationIndustryJobs, saveIndustryJobs;
let fetchCharacterWalletTransactions, saveWalletTransactions;
let fetchCorporationWalletTransactions, fetchCharacterWalletJournal, fetchCorporationWalletJournal, saveWalletJournal;
let fetchServerStatus;
let getNextEligibleAt;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  ({ getCharacters } = require('../../src/main/settings-manager'));
  ({ fetchCharacterIndustryJobs, fetchCorporationIndustryJobs, saveIndustryJobs } =
    require('../../src/main/esi-industry-jobs'));
  ({ fetchCharacterWalletTransactions, saveWalletTransactions,
     fetchCorporationWalletTransactions, fetchCharacterWalletJournal,
     fetchCorporationWalletJournal, saveWalletJournal } = require('../../src/main/esi-wallet'));
  ({ fetchServerStatus } = require('../../src/main/esi-server-status'));
  ({ getNextEligibleAt } = require('../../src/main/esi-status-tracker'));
  refresh = require('../../src/main/esi-background-refresh');

  // Sensible default happy-path fetcher responses.
  fetchCharacterIndustryJobs.mockResolvedValue({ jobs: [], lastUpdated: 1, cacheExpiresAt: null });
  fetchCorporationIndustryJobs.mockResolvedValue({ jobs: [], lastUpdated: 1, cacheExpiresAt: null });
  fetchCharacterWalletTransactions.mockResolvedValue({ transactions: [], lastUpdated: 1 });
  fetchCharacterWalletJournal.mockResolvedValue({ entries: [], lastUpdated: 1 });
  fetchCorporationWalletTransactions.mockResolvedValue({ transactions: [], lastUpdated: 1 });
  fetchCorporationWalletJournal.mockResolvedValue({ entries: [], lastUpdated: 1 });
  fetchServerStatus.mockResolvedValue({ success: true, players: 30000 });
  // clearAllMocks wipes the factory's default, so restate it: "nothing
  // tracked yet", which sends the scheduler to its heartbeat fallback.
  getNextEligibleAt.mockReturnValue(null);
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
  test('skips per-character work when there are no authenticated characters', async () => {
    getCharacters.mockReturnValue([]);
    const summary = await refresh.runRefreshCycle();
    expect(summary.characterCount).toBe(0);
    expect(fetchCharacterIndustryJobs).not.toHaveBeenCalled();
  });

  describe('global (unauthenticated) tasks', () => {
    test('server status is fetched by the cycle, not by any window', async () => {
      // It used to be driven by a per-window footer timer, so N windows meant
      // N fetch cycles and closing the last window stopped it entirely.
      getCharacters.mockReturnValue([{ characterId: 1, corporationId: 100 }]);

      const summary = await refresh.runRefreshCycle();

      expect(fetchServerStatus).toHaveBeenCalledTimes(1);
      expect(summary.global).toEqual([
        { task: 'server_status', result: '30000 players' },
      ]);
    });

    test('runs even with NO characters connected', async () => {
      // Server status needs no auth, and a fresh install still has a footer.
      getCharacters.mockReturnValue([]);

      const summary = await refresh.runRefreshCycle();

      expect(fetchServerStatus).toHaveBeenCalledTimes(1);
      expect(summary.global).toHaveLength(1);
    });

    test('a rate-limited fetch reports cached rather than failing', async () => {
      fetchServerStatus.mockResolvedValue({ success: true, cached: true, data: {} });
      getCharacters.mockReturnValue([]);

      const summary = await refresh.runRefreshCycle();

      expect(summary.global[0].result).toBe('cached');
      expect(summary.errors).toHaveLength(0);
    });

    test('a failed fetch is recorded as an error, not thrown', async () => {
      fetchServerStatus.mockResolvedValue({ success: false, error: 'ESI down' });
      getCharacters.mockReturnValue([{ characterId: 1, corporationId: 100 }]);

      const summary = await refresh.runRefreshCycle();

      expect(summary.errors).toContainEqual(
        expect.objectContaining({ task: 'server_status', error: 'ESI down' })
      );
      // ...and the rest of the cycle still ran.
      expect(fetchCharacterIndustryJobs).toHaveBeenCalled();
    });

    test('a throwing global task does not abort the cycle', async () => {
      fetchServerStatus.mockRejectedValue(new Error('network'));
      getCharacters.mockReturnValue([{ characterId: 1, corporationId: 100 }]);

      const summary = await refresh.runRefreshCycle();

      expect(summary.errors).toContainEqual(
        expect.objectContaining({ task: 'server_status' })
      );
      expect(fetchCharacterIndustryJobs).toHaveBeenCalled();
    });
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

  test('fetches character journal for each character', async () => {
    getCharacters.mockReturnValue([{ characterId: 1, corporationId: null }]);
    fetchCharacterWalletJournal.mockResolvedValue({ entries: [{ id: 1 }], lastUpdated: 1 });

    await refresh.runRefreshCycle();

    expect(fetchCharacterWalletJournal).toHaveBeenCalledWith(1);
    expect(saveWalletJournal).toHaveBeenCalled();
  });

  test('fetches corp wallet transactions + journal per enabled division (deduped)', async () => {
    const { getCharacterDivisionSettings } = require('../../src/main/settings-manager');
    getCharacterDivisionSettings.mockReturnValue({ enabledDivisions: [1, 3] });
    getCharacters.mockReturnValue([
      { characterId: 1, corporationId: 100 },
      { characterId: 2, corporationId: 100 },
    ]);

    await refresh.runRefreshCycle();

    // Deduped to one auth char (1) per corp, iterated over 2 divisions.
    expect(fetchCorporationWalletTransactions).toHaveBeenCalledTimes(2);
    expect(fetchCorporationWalletTransactions).toHaveBeenCalledWith(1, 100, 1);
    expect(fetchCorporationWalletTransactions).toHaveBeenCalledWith(1, 100, 3);
    expect(fetchCorporationWalletJournal).toHaveBeenCalledTimes(2);
  });

  test('defaults to division 1 when no divisions configured', async () => {
    const { getCharacterDivisionSettings } = require('../../src/main/settings-manager');
    getCharacterDivisionSettings.mockReturnValue({ enabledDivisions: [] });
    getCharacters.mockReturnValue([{ characterId: 1, corporationId: 100 }]);

    await refresh.runRefreshCycle();

    expect(fetchCorporationWalletTransactions).toHaveBeenCalledTimes(1);
    expect(fetchCorporationWalletTransactions).toHaveBeenCalledWith(1, 100, 1);
  });
});

describe('start/stop lifecycle', () => {
  // The cycle is self-scheduling: the next timer is set AFTER the current pass
  // resolves, so the tests have to let that pass settle before asserting.
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    getCharacters.mockReturnValue([]); // keep cycles cheap
  });

  afterEach(() => {
    refresh.stopBackgroundRefresh();
  });

  test('start schedules the next cycle once the first one finishes', async () => {
    refresh.startBackgroundRefresh();
    await settle();

    const status = refresh.getGlobalRefreshStatus();
    expect(status.active).toBe(true);
    expect(status.nextTickAt).toBeGreaterThan(Date.now());
  });

  test('start is idempotent - one live timer', async () => {
    refresh.startBackgroundRefresh();
    await settle();
    const first = refresh.getGlobalRefreshStatus().nextTickAt;

    refresh.startBackgroundRefresh();
    await settle();

    // Still exactly one scheduled tick, not two stacked.
    expect(refresh.getGlobalRefreshStatus().active).toBe(true);
    expect(refresh.getGlobalRefreshStatus().nextTickAt).toBeGreaterThanOrEqual(first);
  });

  test('stop clears the timer', async () => {
    refresh.startBackgroundRefresh();
    await settle();
    refresh.stopBackgroundRefresh();

    expect(refresh.getGlobalRefreshStatus().active).toBe(false);
  });

  test('stopping mid-cycle does not schedule another tick', async () => {
    // Otherwise a cycle in flight when the app quits would resurrect the timer.
    refresh.startBackgroundRefresh();
    refresh.stopBackgroundRefresh();
    await settle();

    expect(refresh.getGlobalRefreshStatus().active).toBe(false);
  });

  test('the delay is clamped to the configured bounds', async () => {
    refresh.startBackgroundRefresh();
    await settle();

    const { nextTickAt, minTickMs, maxTickMs } = refresh.getGlobalRefreshStatus();
    const delay = nextTickAt - Date.now();
    // Nothing is tracked in this suite, so it falls back to the heartbeat.
    expect(delay).toBeGreaterThan(minTickMs - 1000);
    expect(delay).toBeLessThanOrEqual(maxTickMs);
  });

  describe('dynamic scheduling', () => {
    const settleAsync = () => new Promise((resolve) => setImmediate(resolve));

    test('sleeps until the soonest endpoint is actually due', async () => {
      // A fixed period delayed 1-minute endpoints to 5 and wasted every other
      // tick on 5-minute ones. The gate decides now.
      getNextEligibleAt.mockReturnValue(Date.now() + 63 * 1000);

      refresh.startBackgroundRefresh();
      await settleAsync();

      const delay = refresh.getGlobalRefreshStatus().nextTickAt - Date.now();
      expect(delay).toBeGreaterThan(55 * 1000);
      expect(delay).toBeLessThan(70 * 1000);
    });

    test('asks only about endpoints THIS cycle fetches', async () => {
      // Most tracked endpoints are fetched on demand by their own screens;
      // waking for those would burn a pass that fetches nothing.
      refresh.startBackgroundRefresh();
      await settleAsync();

      const types = getNextEligibleAt.mock.calls[0][0];
      expect(types).toContain('server_status');
      expect(types).toContain('industry_jobs');
      expect(types).not.toContain('market_orders');
      expect(types).not.toContain('assets');
    });

    test('an overdue deadline still waits the minimum', async () => {
      // getNextEligibleAt filters these out, but the clamp is the backstop:
      // a perpetually-due endpoint must not spin the cycle back to back.
      getNextEligibleAt.mockReturnValue(Date.now() - 60 * 60 * 1000);

      refresh.startBackgroundRefresh();
      await settleAsync();

      const { nextTickAt, minTickMs } = refresh.getGlobalRefreshStatus();
      expect(nextTickAt - Date.now()).toBeGreaterThan(minTickMs - 1000);
    });

    test('a far-future deadline is capped by the heartbeat', async () => {
      // A newly-added character must be picked up without waiting 30 minutes.
      getNextEligibleAt.mockReturnValue(Date.now() + 30 * 60 * 1000);

      refresh.startBackgroundRefresh();
      await settleAsync();

      const { nextTickAt, maxTickMs } = refresh.getGlobalRefreshStatus();
      expect(nextTickAt - Date.now()).toBeLessThanOrEqual(maxTickMs);
    });

    test('nothing tracked yet falls back to the heartbeat', async () => {
      getNextEligibleAt.mockReturnValue(null);

      refresh.startBackgroundRefresh();
      await settleAsync();

      const { nextTickAt, maxTickMs } = refresh.getGlobalRefreshStatus();
      expect(nextTickAt - Date.now()).toBeGreaterThan(maxTickMs - 2000);
    });

    test('a gate failure does not stop the loop', async () => {
      getNextEligibleAt.mockImplementation(() => { throw new Error('db gone'); });

      refresh.startBackgroundRefresh();
      await settleAsync();

      // Still scheduled, on the fallback cadence.
      expect(refresh.getGlobalRefreshStatus().active).toBe(true);
    });
  });
});
