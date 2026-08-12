#!/usr/bin/env node
'use strict';

/**
 * Run the benchmark scenarios. NEVER touches the network.
 *
 * Measures against the dataset produced by `npm run bench:build`, which is left
 * strictly read-only: each run copies it into a disposable sandbox, measures
 * there, and deletes the copy. That is what makes repeated runs comparable -
 * every run starts from byte-identical state, and nothing drifts between them.
 *
 *   npm run bench                          all offline scenarios
 *   npm run bench -- --only recalc         one scenario
 *   npm run bench -- --repeat 3            repeat for a noise estimate
 *   npm run bench -- --compare <file>      diff against an earlier result
 *   npm run bench -- --with-esi            add the networked ESI scenarios
 *
 * Comparability: results are comparable within one build generation. A rebuild
 * changes the data, so --compare warns when generations differ. Numbers are not
 * comparable across developers - see docs/PROFILING.md.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  PATHS,
  checkDataset,
  generationLabel,
  historyFreshness,
  acquireLock,
  percentile,
  fmtMs,
} = require('./lib/bench-common');
const { getLiveUserDataPath, censusTree, diffCensus } = require('./lib/sandbox');

function parseArgs(argv) {
  const args = {
    only: null,
    repeat: 1,
    compare: null,
    withEsi: false,
    allowStale: false,
    keepSandbox: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = argv[++i];
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--compare') args.compare = argv[++i];
    else if (a === '--with-esi') args.withEsi = true;
    else if (a === '--allow-stale') args.allowStale = true;
    else if (a === '--keep-sandbox') args.keepSandbox = true;
    else if (a === '--inspect') args.inspect = Number(argv[i + 1]) || 9229;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`
Run the Quantum Forge benchmark scenarios (offline)

  npm run bench [-- options]

  --only NAME       run one scenario (recalc, invention, summary, materials, boot)
  --repeat N        run each scenario N times and report p50/p95 (default 1)
  --compare FILE    diff against an earlier result JSON
  --with-esi        also run the networked ESI scenarios (needs live tokens)
  --allow-stale     measure even though the dataset is out of date
  --keep-sandbox    do not delete the working sandbox (for debugging)

Requires a dataset: npm run bench:build
`);
}

function electronBinary() {
  return require(path.join(PATHS.root, 'node_modules', 'electron'));
}

/**
 * Copy the built dataset into a fresh working sandbox.
 *
 * The dataset itself is never opened by a scenario, so a run cannot corrupt it
 * however badly it fails - and repeated runs are therefore identical.
 */
function prepareSandbox() {
  if (fs.existsSync(PATHS.sandbox)) {
    fs.rmSync(PATHS.sandbox, { recursive: true, force: true });
  }
  fs.cpSync(PATHS.dataset, PATHS.sandbox, { recursive: true });
  // The generation stamp is metadata, not app data; keep the sandbox clean.
  const stamp = path.join(PATHS.sandbox, 'generation.json');
  if (fs.existsSync(stamp)) fs.rmSync(stamp);
  return PATHS.sandbox;
}

/** Print one result set as a table. */
function report(result) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`Quantum Forge benchmark`);
  console.log(`  generation: ${generationLabel(result.generation)}`);
  console.log(`  host:       ${result.host.platform} node ${result.host.node} electron ${result.host.electron}`);
  console.log(`  scope:      comparable within this generation on this machine only`);
  console.log('='.repeat(74));

  for (const scenario of result.scenarios) {
    if (scenario.error) {
      console.log(`\n${scenario.name}  --  FAILED: ${scenario.error}`);
      continue;
    }

    console.log(`\n${scenario.name}${scenario.detail ? '  (' + scenario.detail + ')' : ''}`);

    const width = Math.max(...scenario.cases.map((c) => c.label.length), 10);
    console.log(`  ${'case'.padEnd(width)}  ${'p50'.padStart(9)}  ${'p95'.padStart(9)}  ${'runs'.padStart(4)}   notes`);

    for (const c of scenario.cases) {
      const p50 = fmtMs(percentile(c.samples, 0.5));
      const p95 = fmtMs(percentile(c.samples, 0.95));
      console.log(
        `  ${c.label.padEnd(width)}  ${p50.padStart(9)}  ${p95.padStart(9)}  ` +
        `${String(c.samples.length).padStart(4)}   ${c.notes || ''}`
      );
    }

    if (scenario.phases && scenario.phases.length) {
      console.log('\n    phase breakdown (slowest case):');
      for (const p of scenario.phases) {
        console.log(`      ${p.name.padEnd(28)} ${fmtMs(p.ms).padStart(9)}`);
      }
    }
  }
  console.log('');
}

/** Diff two result files, warning when the generations differ. */
function compare(current, previousFile) {
  const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));

  console.log(`\n${'='.repeat(74)}`);
  console.log('Comparison');
  console.log(`  baseline: ${generationLabel(previous.generation)}`);
  console.log(`  current:  ${generationLabel(current.generation)}`);

  const sameGeneration =
    previous.generation && current.generation && previous.generation.id === current.generation.id;

  if (!sameGeneration) {
    console.log('\n  *** WARNING: different build generations. ***');
    console.log('  The dataset changed between these runs, so a delta here is NOT');
    console.log('  purely a code change. Rebuild-and-rebaseline before trusting it.');
  }
  console.log('='.repeat(74));

  const prevCases = new Map();
  for (const s of previous.scenarios || []) {
    for (const c of s.cases || []) prevCases.set(`${s.name}/${c.label}`, c);
  }

  for (const s of current.scenarios || []) {
    if (s.error) continue;
    console.log(`\n${s.name}`);
    for (const c of s.cases || []) {
      const prev = prevCases.get(`${s.name}/${c.label}`);
      const now = percentile(c.samples, 0.5);
      if (!prev) {
        console.log(`  ${c.label.padEnd(22)} ${fmtMs(now).padStart(9)}   (new)`);
        continue;
      }
      const before = percentile(prev.samples, 0.5);
      const delta = now - before;
      const pct = before > 0 ? (delta / before) * 100 : 0;
      const sign = delta >= 0 ? '+' : '';
      const marker = Math.abs(pct) < 3 ? '' : delta < 0 ? '  FASTER' : '  SLOWER';
      console.log(
        `  ${c.label.padEnd(22)} ${fmtMs(before).padStart(9)} -> ${fmtMs(now).padStart(9)}` +
        `  ${(sign + pct.toFixed(1) + '%').padStart(8)}${marker}`
      );
    }
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  // Lock before READING anything about the dataset: a build in flight would
  // otherwise be observed half-written - a generation stamp describing content
  // that is not on disk yet.
  acquireLock('bench');

  const status = checkDataset();
  if (!status.ok) {
    console.error(`\n[bench] ${status.reason}.`);
    if (!args.allowStale) {
      console.error(`[bench] ${status.hint}\n`);
      process.exit(1);
    }
    console.error('[bench] --allow-stale given; measuring anyway.\n');
  }

  fs.mkdirSync(PATHS.profiles, { recursive: true });

  const liveRoot = getLiveUserDataPath();
  const censusBefore = censusTree(liveRoot);

  console.log(`[bench] dataset:  ${generationLabel(status.generation)}`);

  // ESI republishes market history daily at 11:05 UTC and the app invalidates
  // everything older, so a dataset built before the last cutoff has entirely
  // stale history - however completely it was warmed at build time.
  //
  // This STOPS the run rather than warning, because the alternative is far
  // worse than a confusing number: `bench` works on a DISPOSABLE copy, so every
  // run would re-fetch the same ~374 histories and throw them away. Measured at
  // 424 ESI calls per run, every run, against an app-wide error budget. One
  // rebuild refreshes it once instead.
  const freshness = historyFreshness(status.generation);
  if (freshness.expired && !args.allowStale) {
    console.error('\n[bench] this dataset\'s market history has EXPIRED.');
    console.error(`[bench]   ESI republished history at ${freshness.cutoff.toISOString()}`);
    console.error(`[bench]   and this dataset was built ${freshness.builtAt.toISOString()}.`);
    console.error('');
    console.error('[bench] Running anyway would re-fetch several hundred histories from ESI');
    console.error('[bench] on EVERY run - the sandbox is disposable, so nothing is kept.');
    console.error('');
    console.error('[bench]   npm run bench:build -- --force     refresh it once (no login needed)');
    console.error('[bench]   npm run bench -- --allow-stale     measure anyway, spending ESI calls');
    console.error('');
    process.exit(1);
  }
  if (freshness.expired) {
    console.log('[bench] WARNING: history expired; --allow-stale given, this run WILL hit ESI.');
  }

  console.log('[bench] preparing disposable sandbox (dataset stays read-only)');
  const sandboxDir = prepareSandbox();

  // Decide the output path here so the parent reads back exactly the file the
  // child wrote, rather than guessing at "the newest one".
  const outFile = path.join(PATHS.profiles, `bench-${Date.now()}.json`);

  // --inspect opens a debugger port on the scenario process so scripts/profile.js
  // can attach and sample it. Pairs with --wait-for-profiler, which holds the
  // run at the start so the profiler is recording before any work happens -
  // otherwise a fast scenario finishes before the attach lands.
  const electronArgs = [];
  if (args.inspect) electronArgs.push(`--inspect=${args.inspect}`);
  electronArgs.push(path.join(__dirname, 'bench-electron.js'));

  const child = spawn(
    electronBinary(),
    electronArgs,
    {
      cwd: PATHS.root,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        QF_BENCH_SANDBOX: sandboxDir,
        QF_BENCH_OPTIONS: JSON.stringify({
          only: args.only,
          repeat: args.repeat,
          withEsi: args.withEsi,
          waitBeforeRun: args.inspect ? 8000 : 0,
        }),
        QF_BENCH_OUT: outFile,
      },
    }
  );

  const code = await new Promise((resolve) => child.on('exit', resolve));

  // Isolation proof - runs even on failure.
  const diff = diffCensus(censusBefore, censusTree(liveRoot));
  if (!diff.clean) {
    console.error('\n[bench] *** LIVE CONFIG WAS MODIFIED - THIS IS A BUG ***');
    for (const f of [...diff.changed, ...diff.added, ...diff.removed].slice(0, 20)) {
      console.error(`    ${f}`);
    }
    process.exit(1);
  }

  // The dataset must be untouched too - that is what makes runs repeatable.
  const datasetCheck = checkDataset();
  if (status.ok && !datasetCheck.ok) {
    console.error('\n[bench] *** THE BUILT DATASET WAS MODIFIED - THIS IS A BUG ***');
    process.exit(1);
  }

  if (!args.keepSandbox && fs.existsSync(PATHS.sandbox)) {
    fs.rmSync(PATHS.sandbox, { recursive: true, force: true });
  }

  if (code !== 0) {
    console.error(`[bench] scenarios exited with code ${code}`);
    process.exit(code || 1);
  }

  if (!fs.existsSync(outFile)) {
    console.error('[bench] no result file was produced');
    process.exit(1);
  }

  const resultPath = outFile;
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

  report(result);
  console.log(`[bench] result: ${path.relative(PATHS.root, resultPath)}`);
  console.log('[bench] verified: live config and built dataset both untouched');

  if (args.compare) {
    compare(result, path.resolve(PATHS.root, args.compare));
  }
}

main().catch((err) => {
  console.error(`\n[bench] ${err.message || err}`);
  // A lock conflict is an expected condition, not a crash - no stack trace.
  process.exit(err.code === 'BENCH_LOCKED' ? 2 : 1);
});
