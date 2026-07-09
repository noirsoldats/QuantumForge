/**
 * Global background ESI refresh cycle.
 *
 * The app's first main-process periodic task. On a ~5-minute tick it enumerates
 * all authenticated characters (and their corporations, deduped) and calls the
 * ESI fetchers for them. It is FETCH-ONLY — no plan matching (that stays in the
 * plan/ledger layer). It contains NO cadence logic: every fetcher self-gates via
 * the central layer's per-endpoint policy (`canFetchEndpoint`), so the 5-min
 * industry cache vs 1-hr wallet cache "just works" off one cycle.
 *
 * The cycle iterates a LIST of endpoint fetchers (ENDPOINT_TASKS) so Plan B can
 * add wallet-journal / corp-wallet entries by appending to the list — no new
 * cycle logic.
 */

const { getCharacters, getCharacter, getCharacterDivisionSettings } = require('./settings-manager');
const {
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
  saveIndustryJobs,
} = require('./esi-industry-jobs');
const {
  fetchCharacterWalletTransactions,
  fetchCorporationWalletTransactions,
  fetchCharacterWalletJournal,
  fetchCorporationWalletJournal,
  saveWalletTransactions,
  saveWalletJournal,
} = require('./esi-wallet');

// Corp wallets are per-division. When a character has no divisions configured,
// fall back to the master wallet (division 1) so the cycle still fetches something.
function enabledDivisionsFor(characterId) {
  const { enabledDivisions } = getCharacterDivisionSettings(characterId) || {};
  return (enabledDivisions && enabledDivisions.length > 0) ? enabledDivisions : [1];
}

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let intervalHandle = null;
let lastCycleAt = null;
let cycleRunning = false;

/**
 * Per-character endpoint tasks. Each returns a short result tag for logging.
 * `include_completed=true` for industry jobs keeps the durable job log complete
 * app-wide (not just currently-active jobs).
 *
 * Plan B appends corp-wallet / wallet-journal tasks here.
 */
const CHARACTER_TASKS = [
  {
    name: 'industry_jobs',
    run: async (characterId) => {
      const jobsData = await fetchCharacterIndustryJobs(characterId, true);
      if (jobsData.skipped) return 'gated';
      if (jobsData.jobs) {
        saveIndustryJobs({
          characterId,
          jobs: jobsData.jobs,
          lastUpdated: jobsData.lastUpdated,
          cacheExpiresAt: jobsData.cacheExpiresAt,
          isCorporation: false,
        });
      }
      return `${jobsData.jobs ? jobsData.jobs.length : 0} jobs`;
    },
  },
  {
    name: 'wallet_transactions',
    run: async (characterId) => {
      const txData = await fetchCharacterWalletTransactions(characterId);
      if (txData.skipped) return 'gated';
      if (txData.transactions) {
        saveWalletTransactions({
          characterId,
          transactions: txData.transactions,
          lastUpdated: txData.lastUpdated,
        });
      }
      return `${txData.transactions ? txData.transactions.length : 0} tx`;
    },
  },
  {
    name: 'wallet_journal',
    run: async (characterId) => {
      const jData = await fetchCharacterWalletJournal(characterId);
      if (jData.skipped) return 'gated';
      if (jData.entries) {
        saveWalletJournal({
          characterId,
          entries: jData.entries,
          lastUpdated: jData.lastUpdated,
        });
      }
      return `${jData.entries ? jData.entries.length : 0} journal`;
    },
  },
];

/**
 * Per-corporation endpoint tasks (deduped: first authed char per corp).
 */
const CORPORATION_TASKS = [
  {
    name: 'corporation_industry_jobs',
    run: async (authCharacterId, corporationId) => {
      const corpJobsData = await fetchCorporationIndustryJobs(authCharacterId, corporationId, true);
      if (corpJobsData.skipped) return 'gated';
      if (corpJobsData.jobs && corpJobsData.jobs.length > 0) {
        saveIndustryJobs({
          characterId: authCharacterId,
          corporationId,
          jobs: corpJobsData.jobs,
          lastUpdated: corpJobsData.lastUpdated,
          cacheExpiresAt: corpJobsData.cacheExpiresAt,
          isCorporation: true,
        });
      }
      return `${corpJobsData.jobs ? corpJobsData.jobs.length : 0} corp jobs`;
    },
  },
  {
    name: 'corporation_wallet_transactions',
    run: async (authCharacterId, corporationId) => {
      let total = 0;
      for (const division of enabledDivisionsFor(authCharacterId)) {
        const txData = await fetchCorporationWalletTransactions(authCharacterId, corporationId, division);
        if (txData.skipped) continue;
        if (txData.transactions && txData.transactions.length > 0) {
          saveWalletTransactions({
            characterId: authCharacterId,
            corporationId,
            division,
            isCorporation: true,
            transactions: txData.transactions,
            lastUpdated: txData.lastUpdated,
            cacheExpiresAt: txData.cacheExpiresAt,
          });
          total += txData.transactions.length;
        }
      }
      return `${total} corp tx`;
    },
  },
  {
    name: 'corporation_wallet_journal',
    run: async (authCharacterId, corporationId) => {
      let total = 0;
      for (const division of enabledDivisionsFor(authCharacterId)) {
        const jData = await fetchCorporationWalletJournal(authCharacterId, corporationId, division);
        if (jData.skipped) continue;
        if (jData.entries && jData.entries.length > 0) {
          saveWalletJournal({
            characterId: authCharacterId,
            corporationId,
            division,
            isCorporation: true,
            entries: jData.entries,
            lastUpdated: jData.lastUpdated,
            cacheExpiresAt: jData.cacheExpiresAt,
          });
          total += jData.entries.length;
        }
      }
      return `${total} corp journal`;
    },
  },
];

/**
 * Build a map of corporationId -> first authenticated characterId that can act
 * for it. Mirrors the dedup in manufacturing-plans.js refreshPlanESIData.
 */
function buildCorporationCharacterMap(characters) {
  const map = new Map();
  for (const character of characters) {
    if (character && character.corporationId && !map.has(character.corporationId)) {
      map.set(character.corporationId, character.characterId);
    }
  }
  return map;
}

/**
 * Run one full refresh cycle. Fetch-only; per-endpoint gating decides what
 * actually hits the network. One failing character/endpoint never aborts the
 * rest. Safe to call directly (manual "refresh now").
 * @returns {Promise<Object>} Summary of the cycle
 */
async function runRefreshCycle() {
  if (cycleRunning) {
    console.log('[ESI Refresh] Cycle already running, skipping this tick');
    return { skipped: true, reason: 'already_running' };
  }
  cycleRunning = true;
  const startedAt = Date.now();

  const summary = {
    startedAt,
    characters: [],
    corporations: [],
    errors: [],
  };

  try {
    const characters = getCharacters();
    if (!characters || characters.length === 0) {
      console.log('[ESI Refresh] No authenticated characters — nothing to do');
      lastCycleAt = Date.now();
      return { ...summary, finishedAt: lastCycleAt, characterCount: 0 };
    }

    // Personal endpoints for every character.
    for (const character of characters) {
      const characterId = character.characterId;
      for (const task of CHARACTER_TASKS) {
        try {
          const result = await task.run(characterId);
          summary.characters.push({ characterId, task: task.name, result });
        } catch (error) {
          // ESI_SCOPE_ERROR is surfaced; role-403 already returns empty; a
          // rate-limited endpoint (ESI_RATE_LIMITED) just retries next tick.
          if (error.code === 'ESI_RATE_LIMITED') {
            console.log(`[ESI Refresh] ${task.name} rate-limited for char ${characterId}, will retry next tick`);
          } else {
            console.error(`[ESI Refresh] ${task.name} failed for char ${characterId}:`, error.message);
          }
          summary.errors.push({ characterId, task: task.name, error: error.message, code: error.code });
        }
      }
    }

    // Corporation endpoints (deduped by corp).
    const corpMap = buildCorporationCharacterMap(characters);
    for (const [corporationId, authCharacterId] of corpMap) {
      for (const task of CORPORATION_TASKS) {
        try {
          const result = await task.run(authCharacterId, corporationId);
          summary.corporations.push({ corporationId, authCharacterId, task: task.name, result });
        } catch (error) {
          if (error.code === 'ESI_RATE_LIMITED') {
            console.log(`[ESI Refresh] ${task.name} rate-limited for corp ${corporationId}, will retry next tick`);
          } else {
            console.error(`[ESI Refresh] ${task.name} failed for corp ${corporationId}:`, error.message);
          }
          summary.errors.push({ corporationId, task: task.name, error: error.message, code: error.code });
        }
      }
    }

    lastCycleAt = Date.now();
    summary.finishedAt = lastCycleAt;
    summary.characterCount = characters.length;
    summary.corporationCount = corpMap.size;
    console.log(`[ESI Refresh] Cycle complete in ${lastCycleAt - startedAt}ms — ${characters.length} char(s), ${corpMap.size} corp(s), ${summary.errors.length} error(s)`);
    return summary;
  } finally {
    cycleRunning = false;
  }
}

/**
 * Start the background refresh cycle. Idempotent (clear-then-set). Runs one
 * immediate cycle, then on the interval.
 */
function startBackgroundRefresh() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  console.log(`[ESI Refresh] Starting global background refresh (every ${TICK_INTERVAL_MS / 60000} min)`);

  // Kick off an immediate cycle (don't await — let it run in the background).
  runRefreshCycle().catch(err => console.error('[ESI Refresh] Initial cycle error:', err));

  intervalHandle = setInterval(() => {
    runRefreshCycle().catch(err => console.error('[ESI Refresh] Cycle error:', err));
  }, TICK_INTERVAL_MS);

  // Don't let the timer keep the process/event loop alive on quit.
  if (intervalHandle.unref) intervalHandle.unref();
}

/**
 * Stop the background refresh cycle.
 */
function stopBackgroundRefresh() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[ESI Refresh] Stopped global background refresh');
  }
}

/**
 * Status for the IPC getter: last cycle time + whether a cycle is running.
 */
function getGlobalRefreshStatus() {
  return {
    running: cycleRunning,
    lastCycleAt,
    intervalMs: TICK_INTERVAL_MS,
    active: intervalHandle != null,
  };
}

module.exports = {
  startBackgroundRefresh,
  stopBackgroundRefresh,
  runRefreshCycle,
  getGlobalRefreshStatus,
  // exported for tests
  buildCorporationCharacterMap,
  CHARACTER_TASKS,
  CORPORATION_TASKS,
};
