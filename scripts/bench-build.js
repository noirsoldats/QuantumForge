#!/usr/bin/env node
'use strict';

/**
 * Build the benchmark dataset. THE ONLY SCRIPT THAT TOUCHES THE NETWORK.
 *
 * Run this rarely. `npm run bench` then measures against what this produced,
 * over and over, with no fetching - which is what keeps benchmark numbers
 * comparable across a working session (see scripts/lib/bench-common.js).
 *
 * What it does:
 *   1. Creates an EMPTY sandbox data directory. Your live Quantum Forge config
 *      is never read or written - see scripts/lib/sandbox.js.
 *   2. Pauses for you to log in one or more characters through the normal ESI
 *      flow. A real character is what makes the data volume representative:
 *      resolveOwnedBlueprint() linearly scans every owned blueprint per
 *      material, per node, per recursion level.
 *   3. Fetches skills, blueprints and assets through the real ESI code paths.
 *   4. Builds the recipe's plans through the real APIs
 *      (createManufacturingPlan / addBlueprintToPlan) rather than raw INSERTs,
 *      so the dataset keeps reflecting how the app actually works as it changes.
 *   5. Fetches market data for the types those plans touch.
 *   6. Stamps generation.json and exits. No scenarios are run.
 *
 * This file is the plain-node parent; it spawns Electron to do the work,
 * because the app's modules require electron at load time.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  PATHS,
  loadRecipe,
  recipeHash,
  latestSchemaMigrationId,
  readGeneration,
  generationLabel,
  acquireLock,
} = require('./lib/bench-common');
const { getLiveUserDataPath, censusTree, diffCensus } = require('./lib/sandbox');

function parseArgs(argv) {
  const args = {
    force: false,
    keepSandbox: false,
    help: false,
    timeoutMin: 15,
    freshLogin: false,
    refreshChars: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') args.force = true;
    else if (a === '--timeout') args.timeoutMin = Number(argv[++i]);
    else if (a === '--fresh-login') args.freshLogin = true;
    else if (a === '--refresh-characters') args.refreshChars = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`
Build the benchmark dataset (requires an ESI login; the only networked step)

  npm run bench:build [-- --force]

  --force                rebuild even though a dataset already exists
  --fresh-login          do NOT reuse the previous dataset's characters
  --refresh-characters   re-fetch skills/blueprints/assets for reused characters
  --timeout MIN          minutes to wait for login before giving up (default 15)

Rebuilds reuse the previous dataset's characters and their refresh tokens, so
you only log in once. Pass --fresh-login to start over (e.g. to change which
characters the dataset uses), or --refresh-characters to keep the characters
but pull their ESI data again.

The dataset lands in .bench-data/ (gitignored - it holds real character data
and live ESI tokens). What is committed is tests/fixtures/bench/recipe.json,
which holds neither. Afterwards, run \`npm run bench\` as often as you like.
`);
}

function electronBinary() {
  return require(path.join(PATHS.root, 'node_modules', 'electron'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const recipe = loadRecipe();
  const existing = readGeneration();

  if (existing && !args.force) {
    console.log(`\n[bench:build] a dataset already exists: ${generationLabel(existing)}`);
    console.log('[bench:build] rebuilding discards it and requires a fresh ESI login.');
    console.log('[bench:build] pass --force to rebuild, or just run `npm run bench`.\n');
    process.exit(1);
  }

  // Take the lock BEFORE touching the dataset - the destructive work starts a
  // few lines below, and a concurrent `bench` must not copy it mid-write.
  acquireLock('bench:build');

  // Prove isolation by absence: nothing under the live config may change.
  const liveRoot = getLiveUserDataPath();
  console.log(`[bench:build] live config (must stay untouched): ${liveRoot}`);
  const censusBefore = censusTree(liveRoot);
  console.log(`[bench:build] censused ${censusBefore.size} live files`);

  // Stash the previous dataset before clearing, so the builder can carry its
  // characters (and their still-valid refresh tokens) into the new one. This
  // is what turns a rebuild from "log in again and re-fetch everything" into a
  // single command. --fresh-login skips it.
  let stash = null;
  if (fs.existsSync(PATHS.dataset)) {
    if (args.freshLogin) {
      console.log('[bench:build] --fresh-login: discarding previous characters');
    } else {
      stash = `${PATHS.dataset}.previous`;
      fs.rmSync(stash, { recursive: true, force: true });
      fs.renameSync(PATHS.dataset, stash);
      console.log('[bench:build] stashed previous dataset for character reuse');
    }
    fs.rmSync(PATHS.dataset, { recursive: true, force: true });
  }
  fs.mkdirSync(PATHS.dataset, { recursive: true });

  console.log('\n[bench:build] launching Quantum Forge against the sandbox.');
  console.log('[bench:build] LOG IN your character(s) in the app window, then close it.');
  console.log('[bench:build] (the app is running on throwaway data - nothing you do affects your real config)\n');

  const child = spawn(
    electronBinary(),
    [path.join(__dirname, 'bench-build-electron.js'), '--bench-dataset', PATHS.dataset],
    {
      cwd: PATHS.root,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        QF_BENCH_DATASET: PATHS.dataset,
        QF_BENCH_RECIPE: PATHS.recipe,
        ...(stash ? { QF_BENCH_PREVIOUS: stash } : {}),
        ...(args.refreshChars ? { QF_BENCH_REFRESH_CHARS: '1' } : {}),
      },
    }
  );

  const timeoutMs = args.timeoutMin * 60 * 1000;
  const timer = setTimeout(() => {
    console.error(`\n[bench:build] timed out after ${args.timeoutMin} minutes - killing the app.`);
    child.kill();
  }, timeoutMs);

  const code = await new Promise((resolve) => {
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  // Isolation check runs whether the build succeeded or not - a failed build
  // that touched real data is the worst outcome and must not go unreported.
  const diff = diffCensus(censusBefore, censusTree(liveRoot));
  if (!diff.clean) {
    console.error('\n[bench:build] *** LIVE CONFIG WAS MODIFIED - THIS IS A BUG ***');
    console.error(`  changed: ${diff.changed.length}  added: ${diff.added.length}  removed: ${diff.removed.length}`);
    for (const f of [...diff.changed, ...diff.added, ...diff.removed].slice(0, 20)) {
      console.error(`    ${f}`);
    }
    process.exit(1);
  }
  console.log('\n[bench:build] verified: live config untouched');

  const generation = code === 0 ? readGeneration() : null;

  if (!generation) {
    // A failed rebuild must not also cost the previous dataset - that would
    // turn one bad run into a mandatory re-login. Put it back.
    if (stash && fs.existsSync(stash)) {
      fs.rmSync(PATHS.dataset, { recursive: true, force: true });
      fs.renameSync(stash, PATHS.dataset);
      console.error('[bench:build] build failed; restored the previous dataset.');
    }
    console.error(
      code === 0
        ? '[bench:build] builder finished but wrote no generation stamp.'
        : `[bench:build] builder exited with code ${code}; dataset not stamped.`
    );
    process.exit(code || 1);
  }

  // Build succeeded - the stash has served its purpose.
  if (stash && fs.existsSync(stash)) {
    fs.rmSync(stash, { recursive: true, force: true });
  }

  console.log(`[bench:build] dataset ready: ${generationLabel(generation)}`);
  console.log(`[bench:build]   plans: ${generation.planCount}   nodes: ${generation.totalNodes}`);
  console.log(`[bench:build]   recipe: ${generation.recipeHash}   schema: ${generation.schemaMigrationId}`);
  console.log('\n[bench:build] now run: npm run bench\n');
}

main().catch((err) => {
  console.error(`\n[bench:build] ${err.message || err}`);
  // A lock conflict is an expected condition, not a crash - no stack trace.
  process.exit(err.code === 'BENCH_LOCKED' ? 2 : 1);
});
