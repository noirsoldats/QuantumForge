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
const { fetchServerStatus } = require('./esi-server-status');

// Corp wallets are per-division. When a character has no divisions configured,
// fall back to the master wallet (division 1) so the cycle still fetches something.
function enabledDivisionsFor(characterId) {
  const { enabledDivisions } = getCharacterDivisionSettings(characterId) || {};
  return (enabledDivisions && enabledDivisions.length > 0) ? enabledDivisions : [1];
}

// The cycle is SELF-SCHEDULING: after each pass it asks the gate when the
// soonest endpoint next comes due and sleeps until then. These only clamp it.
//
//   MIN — never busier than this, even if something reports overdue. Also the
//         floor for the fastest endpoints (server_status is 1 min).
//   MAX — a heartbeat, so a newly-added character is picked up even when
//         nothing is tracked yet.
const MIN_TICK_MS = 30 * 1000;      // 30 seconds
const MAX_TICK_MS = 5 * 60 * 1000;  // 5 minutes

/**
 * The endpoint_type values this cycle actually fetches.
 *
 * Used to ask the gate "when is the next of MY endpoints due?". Most tracked
 * endpoints (assets, blueprints, skills, market orders...) are fetched on
 * demand by their own screens - waking the cycle for those would just burn a
 * pass that fetches nothing. Keep in step with the task lists below.
 */
const CYCLE_ENDPOINT_TYPES = [
  'server_status',
  'industry_jobs',
  'corporation_industry_jobs',
  'wallet_transactions',
  'corporation_wallet_transactions',
  'wallet_journal',
  'corporation_wallet_journal',
];

let timerHandle = null;
let nextTickAt = null;
let stopped = false;
let lastCycleAt = null;
let cycleRunning = false;

/**
 * Endpoints that belong to nobody - no character, no corporation, no auth.
 *
 * These run FIRST and outside the "any characters?" guard, because they are
 * still meaningful on a fresh install with no character connected.
 *
 * Server status lives here rather than in the footer: it used to be fetched by
 * a per-window footer timer, so N open windows meant N independent fetch
 * cycles, and closing the last window stopped it entirely. Now main fetches it
 * once and every footer just listens for the resulting esi:data-changed.
 */
const GLOBAL_TASKS = [
  {
    name: 'server_status',
    run: async () => {
      // Three shapes: a fresh fetch returns the status object directly, a
      // rate-limited one returns { success, data, cached }, and a failure
      // returns { success: false, error }.
      const result = await fetchServerStatus();
      if (!result || result.success === false) {
        throw new Error(result?.error || 'server status fetch failed');
      }
      if (result.cached) return 'cached';
      return result.players != null ? `${result.players} players` : 'ok';
    },
  },
];

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
    global: [],
    characters: [],
    corporations: [],
    errors: [],
  };

  try {
    // Unauthenticated endpoints first, and BEFORE the no-characters guard:
    // they are still meaningful on a fresh install with nothing connected.
    for (const task of GLOBAL_TASKS) {
      try {
        const result = await task.run();
        summary.global.push({ task: task.name, result });
      } catch (error) {
        if (error.code === 'ESI_RATE_LIMITED') {
          console.log(`[ESI Refresh] ${task.name} rate-limited, will retry next tick`);
        } else {
          console.error(`[ESI Refresh] ${task.name} failed:`, error.message);
        }
        summary.errors.push({ task: task.name, error: error.message, code: error.code });
      }
    }

    const characters = getCharacters();
    if (!characters || characters.length === 0) {
      console.log('[ESI Refresh] No authenticated characters — global tasks only');
      lastCycleAt = Date.now();
      summary.finishedAt = lastCycleAt;
      // Still emit: the footer and any freshness badge are driven by this,
      // and they must update on a fresh install too.
      try {
        const { emitCycleComplete } = require('./data-events');
        emitCycleComplete(summary);
      } catch (_) { /* never let a listener break the cycle */ }
      return { ...summary, characterCount: 0 };
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

    // This summary used to be returned to callers that only had a .catch(), so
    // it was built and then thrown away. Emit it: it is the app's only signal
    // that a whole refresh pass landed.
    try {
      const { emitCycleComplete } = require('./data-events');
      emitCycleComplete(summary);
    } catch (_) {
      // Never let a listener break the cycle.
    }

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
  stopBackgroundRefresh();
  stopped = false;
  console.log('[ESI Refresh] Starting global background refresh (self-scheduling)');

  // Kick off an immediate cycle; it schedules the next one when it finishes.
  runCycleThenReschedule();
}

/**
 * Run a cycle and schedule the next one for when something is actually due.
 *
 * A fixed period was wrong in both directions: it delayed fast endpoints (a
 * 1-minute floor polled every 5 minutes) and beat against slow ones (a 5-minute
 * floor polled every 5 minutes wasted every other tick, halving the real rate).
 * Asking the gate when the soonest endpoint comes due removes both problems -
 * the policy table becomes the only thing deciding cadence, which is what it
 * was always supposed to be.
 */
async function runCycleThenReschedule() {
  try {
    await runRefreshCycle();
  } catch (error) {
    console.error('[ESI Refresh] Cycle error:', error);
  }

  if (stopped) return;

  const delay = computeNextDelayMs();
  nextTickAt = Date.now() + delay;
  console.log(`[ESI Refresh] Next cycle in ${Math.round(delay / 1000)}s`);

  timerHandle = setTimeout(runCycleThenReschedule, delay);
  // Don't let the timer keep the process/event loop alive on quit.
  if (timerHandle.unref) timerHandle.unref();
}

/**
 * How long to wait before the next cycle.
 *
 * Clamped at both ends: MIN stops a burst of back-to-back cycles when several
 * endpoints are perpetually due (or the DB reports something already overdue),
 * and MAX keeps a heartbeat so a newly-added character or a cleared table is
 * picked up even when nothing is tracked yet.
 */
function computeNextDelayMs() {
  let nextEligibleAt = null;
  try {
    const { getNextEligibleAt } = require('./esi-status-tracker');
    nextEligibleAt = getNextEligibleAt(CYCLE_ENDPOINT_TYPES);
  } catch (error) {
    console.error('[ESI Refresh] Could not read next eligible time:', error);
  }

  // Nothing tracked yet (fresh install, or the status table was cleared).
  if (nextEligibleAt == null) return MAX_TICK_MS;

  const delay = nextEligibleAt - Date.now();
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, delay));
}

/**
 * Stop the background refresh cycle.
 */
function stopBackgroundRefresh() {
  stopped = true;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
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
    nextTickAt: timerHandle ? nextTickAt : null,
    minTickMs: MIN_TICK_MS,
    maxTickMs: MAX_TICK_MS,
    active: timerHandle != null,
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
