'use strict';

/**
 * Shared paths, generation stamping and staleness rules for the benchmark.
 *
 * THE GENERATION CONCEPT
 * ----------------------
 * The benchmark dataset is built rarely (`bench:build`) and measured against
 * constantly (`bench`). Because `bench` never re-fetches, the dataset does not
 * shift underneath the numbers: across many runs and many code changes, a
 * timing delta is a CODE delta. That window - one build, many runs - is called
 * a *generation*, and it is the scope within which results are comparable.
 *
 * Every result records the generation it was produced under, so two results can
 * always be checked for whether comparing them is legitimate. Comparing across
 * generations is not an error, but it is warned about: a rebuild changes the
 * data, so the delta is no longer purely a code delta.
 *
 * Numbers are NOT comparable across developers - different characters own
 * different blueprints and have different skills. That is an accepted tradeoff,
 * and the reason the repo commits a recipe rather than a database.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The dataset location is overridable so the builder and the runner can be
 * pointed at a scratch directory for testing. It defaults to .bench-data.
 *
 * This must be honoured EVERYWHERE the dataset is touched: an earlier version
 * hardcoded the generation path, so a build run against an override wrote its
 * stamp into the default directory (or nowhere at all) and the dataset silently
 * read as "never built".
 */
const DATASET_DIR = process.env.QF_BENCH_DATASET
  ? path.resolve(process.env.QF_BENCH_DATASET)
  : path.join(ROOT, '.bench-data');

const PATHS = {
  root: ROOT,
  /** Committed description of what to build. */
  recipe: path.join(ROOT, 'tests', 'fixtures', 'bench', 'recipe.json'),
  /** The built dataset - real character data + tokens. Gitignored. */
  dataset: DATASET_DIR,
  /** Disposable per-run copy of the dataset. Gitignored. */
  sandbox: process.env.QF_BENCH_SANDBOX
    ? path.resolve(process.env.QF_BENCH_SANDBOX)
    : path.join(ROOT, '.bench-sandbox'),
  /** Result JSON and captured profiles. Gitignored. */
  profiles: path.join(ROOT, 'profiles'),
};

PATHS.generation = path.join(PATHS.dataset, 'generation.json');

/** Read and parse the committed recipe. */
function loadRecipe() {
  if (!fs.existsSync(PATHS.recipe)) {
    throw new Error(`[bench] recipe not found: ${PATHS.recipe}`);
  }
  return JSON.parse(fs.readFileSync(PATHS.recipe, 'utf8'));
}

/**
 * Hash the recipe's MEANINGFUL content.
 *
 * `$comment` keys are stripped so that editing documentation does not
 * invalidate a perfectly good dataset - only a change to what gets built
 * should force a rebuild.
 */
function recipeHash(recipe) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        if (key === '$comment') continue;
        out[key] = strip(value[key]);
      }
      return out;
    }
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(strip(recipe))).digest('hex').slice(0, 16);
}

/**
 * The app's latest schema migration id.
 *
 * Compared against what the dataset actually has applied, this detects the case
 * where a schema change has landed since the dataset was built - the dataset is
 * then structurally behind the code and must be rebuilt.
 *
 * Read by PARSING the migration source rather than requiring it. The module
 * transitively requires `electron` (config-migration -> portable-mode ->
 * app.getPath), so `require`ing it from plain node throws - and swallowing that
 * in a try/catch would silently disable staleness detection entirely, which is
 * exactly the kind of quiet degradation this check exists to prevent.
 */
function latestSchemaMigrationId() {
  const file = path.join(ROOT, 'src', 'main', 'database-schema-migrations.js');
  if (!fs.existsSync(file)) return null;

  const source = fs.readFileSync(file, 'utf8');
  const ids = [...source.matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1]);
  if (ids.length === 0) return null;

  // Numbered NNN_name ids sort lexicographically into apply order.
  return ids.sort().at(-1);
}

/** Read the current dataset's generation stamp, or null when unbuilt. */
function readGeneration() {
  if (!fs.existsSync(PATHS.generation)) return null;
  try {
    return JSON.parse(fs.readFileSync(PATHS.generation, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Write the generation stamp that marks a dataset as built. */
function writeGeneration(stamp) {
  fs.mkdirSync(PATHS.dataset, { recursive: true });
  fs.writeFileSync(PATHS.generation, JSON.stringify(stamp, null, 2));
  return stamp;
}

/**
 * Decide whether the built dataset can be measured against.
 *
 * @returns {{ok: boolean, reason?: string, hint?: string, generation?: object}}
 */
function checkDataset() {
  const generation = readGeneration();

  if (!generation) {
    return {
      ok: false,
      reason: 'no benchmark dataset has been built',
      hint: 'run: npm run bench:build',
    };
  }

  const currentHash = recipeHash(loadRecipe());
  if (generation.recipeHash !== currentHash) {
    return {
      ok: false,
      generation,
      reason: 'the recipe changed since this dataset was built',
      hint: 'run: npm run bench:build   (or pass --allow-stale to measure anyway)',
    };
  }

  const latest = latestSchemaMigrationId();
  if (latest && generation.schemaMigrationId && generation.schemaMigrationId !== latest) {
    return {
      ok: false,
      generation,
      reason:
        `the database schema moved on since this dataset was built ` +
        `(dataset: ${generation.schemaMigrationId}, code: ${latest})`,
      hint: 'run: npm run bench:build   (or pass --allow-stale to measure anyway)',
    };
  }

  return { ok: true, generation };
}

/** Short human label for a generation, used in reports and comparisons. */
function generationLabel(generation) {
  if (!generation) return '(none)';
  return `${generation.id} built ${new Date(generation.builtAt).toLocaleString()}`;
}

/**
 * The moment ESI last regenerated market history.
 *
 * ESI publishes it once a day at 11:05 UTC. Mirrors
 * `isPastDailyHistoryCutoff` in esi-market.js - the rule the app itself uses to
 * decide whether cached history is stale.
 */
function lastHistoryCutoff(now = new Date()) {
  const todayUpdate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 5, 0
  ));
  return now >= todayUpdate ? todayUpdate : new Date(todayUpdate.getTime() - 86400000);
}

/**
 * Has the dataset's cached market history aged out?
 *
 * This is NOT a coverage problem and cannot be fixed by warming more types: the
 * app invalidates ALL history fetched before the last 11:05 UTC publication, so
 * a dataset built yesterday has entirely stale history today. The first run of
 * any history-touching scenario then re-fetches from ESI and is ~10x slower
 * than the runs after it - which shows up as a p50/p95 split, not as an error.
 *
 * Reported rather than enforced: the dataset is otherwise perfectly usable, and
 * one warm-up run restores offline behaviour for the rest of the session.
 *
 * @returns {{expired: boolean, cutoff: Date, builtAt: Date|null}}
 */
function historyFreshness(generation, now = new Date()) {
  const cutoff = lastHistoryCutoff(now);
  const builtAt = generation && generation.builtAt ? new Date(generation.builtAt) : null;
  return { expired: !!builtAt && builtAt < cutoff, cutoff, builtAt };
}

/**
 * Mutual exclusion between `bench:build` and `bench`.
 *
 * They share one dataset directory: the builder writes it, the runner copies it
 * into a sandbox. Running both at once means the runner copies a HALF-BUILT
 * dataset - which produced a genuinely baffling session: a suite reporting
 * 1,505 history types against a generation stamp claiming 1,859, and six types
 * reading zero rows that were plainly present on disk afterwards. Nothing was
 * wrong with either script; they simply overlapped.
 *
 * The lock is advisory and self-healing. It records the PID, and a lock whose
 * owner is gone is treated as stale and taken over - a crashed build must never
 * leave the benchmark permanently unusable.
 */
// Deliberately NOT inside the dataset directory: bench:build renames and
// deletes that directory wholesale, which would destroy the very lock it is
// holding. It sits beside it instead.
const LOCK_PATH = `${PATHS.dataset}.lock`;

/** True when a process with this pid is alive. */
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user - still alive.
    return err.code === 'EPERM';
  }
}

/**
 * Take the benchmark lock.
 *
 * @param {string} owner  what is running, e.g. 'bench:build'
 * @returns {{release: Function}}
 * @throws when another live process holds it
 */
function acquireLock(owner) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

  if (fs.existsSync(LOCK_PATH)) {
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    } catch (_) {
      held = null; // unreadable lock is treated as stale
    }

    if (held && pidAlive(held.pid)) {
      const age = Math.round((Date.now() - held.startedAt) / 1000);
      const err = new Error(
        `another benchmark process is running: ${held.owner} (pid ${held.pid}, ${age}s ago).\n` +
        '  Running both at once makes the runner copy a half-built dataset,\n' +
        '  which reports numbers that do not correspond to any real state.\n' +
        '  Wait for it to finish, or stop it and retry.'
      );
      err.code = 'BENCH_LOCKED';
      throw err;
    }

    if (held) {
      console.log(`[bench] clearing stale lock from ${held.owner} (pid ${held.pid} is gone)`);
    }
    fs.rmSync(LOCK_PATH, { force: true });
  }

  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify({ owner, pid: process.pid, startedAt: Date.now() }, null, 2)
  );

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only remove OUR lock - a stale-takeover race must not delete the
      // lock a different process has since written.
      const current = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (current.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
    } catch (_) {
      /* already gone */
    }
  };

  // Release on every exit path, including Ctrl-C and an uncaught throw.
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });

  return { release };
}

/** Percentile over a numeric array (linear interpolation). */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Format milliseconds compactly for a report column. */
function fmtMs(ms) {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

module.exports = {
  PATHS,
  loadRecipe,
  recipeHash,
  latestSchemaMigrationId,
  readGeneration,
  writeGeneration,
  checkDataset,
  generationLabel,
  lastHistoryCutoff,
  historyFreshness,
  acquireLock,
  LOCK_PATH,
  percentile,
  fmtMs,
};
