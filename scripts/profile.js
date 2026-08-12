#!/usr/bin/env node
'use strict';

/**
 * External profiler for Quantum Forge.
 *
 * Attaches to a running (or freshly launched) Electron instance over the Chrome
 * DevTools Protocol and records a profile. Nothing is added to the shipped
 * application: the app is launched with standard Electron/V8 debug flags and
 * sampled from outside, so this can profile code nobody thought to instrument.
 *
 * Modes
 * -----
 *   --cpu     V8 sampling CPU profile of the MAIN process. Writes a
 *             .cpuprofile (loadable in DevTools) plus a self-time table.
 *   --trace   Chrome Tracing across EVERY process on one correlated timeline.
 *             This is the beachball diagnostic: a synchronous better-sqlite3
 *             call blocking the main thread shows up as a long RunTask, and
 *             the renderer frames it stalls are visible beside it.
 *   --heap    V8 heap snapshot, for retention questions.
 *   --attach  Attach to an already-running instance instead of launching one,
 *             so a beachball can be captured live while it is happening.
 *
 * Usage
 * -----
 *   npm run profile:cpu
 *   npm run profile:trace -- --duration 20
 *   node scripts/profile.js --cpu --attach 9229
 *   node scripts/profile.js --trace --duration 30 --out profiles/beachball.json
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { connectBrowser, connectTarget, getJSON, sleep } = require('./lib/cdp');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'profiles');

/** Trace categories, verified to produce RunTask + frame timing events. */
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'toplevel',
  'latencyInfo',
  'blink.user_timing',
  'v8.execute',
];

function parseArgs(argv) {
  const args = {
    mode: null,
    duration: 10,
    attach: null,
    out: null,
    port: null,
    interval: 100,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cpu' || a === '--trace' || a === '--heap') args.mode = a.slice(2);
    else if (a === '--duration') args.duration = Number(argv[++i]);
    else if (a === '--attach') args.attach = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.mode = 'help';
  }
  return args;
}

function usage() {
  console.log(`
Quantum Forge external profiler

  node scripts/profile.js --cpu    [--duration N] [--attach PORT] [--out FILE]
  node scripts/profile.js --trace  [--duration N] [--attach PORT] [--out FILE]
  node scripts/profile.js --heap   [--attach PORT] [--out FILE]

  --duration N   seconds to record (default 10)
  --attach PORT  attach to a running instance on PORT instead of launching
  --interval N   CPU sampling interval in microseconds (default 100)
  --out FILE     output path (default profiles/<mode>-<timestamp>.<ext>)

Launch the app yourself for --attach:
  npx electron --inspect=9229 .                  # main process (--cpu)
  npx electron --remote-debugging-port=9222 .    # all processes (--trace)
`);
}

/** Resolve the project's own Electron binary. */
function electronBinary() {
  return require(path.join(ROOT, 'node_modules', 'electron'));
}

/**
 * Launch the app with the debug flag this mode needs.
 *
 * --cpu uses --inspect (Node inspector on the main process). --trace and --heap
 * use --remote-debugging-port, which exposes the browser-level endpoint that
 * the Tracing domain requires.
 */
function launchApp(mode, port) {
  const flag = mode === 'cpu' ? `--inspect=${port}` : `--remote-debugging-port=${port}`;
  console.log(`[profile] launching app with ${flag}`);

  const child = spawn(electronBinary(), [flag, ROOT], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  return child;
}

function outPath(args, mode, ext) {
  if (args.out) return path.resolve(ROOT, args.out);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(OUT_DIR, `${mode}-${stamp}.${ext}`);
}

/**
 * Attribute self-time per function from a .cpuprofile sample stream.
 *
 * `samples[i]` is the node that was on top of the stack for `timeDeltas[i]`
 * microseconds, so summing deltas per node gives self time - the metric that
 * points at the function actually burning CPU rather than its callers.
 */
function selfTimeTable(profile, limit = 25) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const hits = new Map();

  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const f = node.callFrame;
    const file = f.url ? f.url.replace(/^.*\//, '') : 'native';
    const key = `${f.functionName || '(anonymous)'} @ ${file}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
    hits.set(key, (hits.get(key) || 0) + 1);
  }

  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, us]) => ({ key, ms: us / 1000, samples: hits.get(key) }));
}

async function runCpu(args, port) {
  const { session, target } = await connectTarget(port, (t) => t.type === 'node');
  console.log(`[profile] attached to: ${target.title}`);

  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: args.interval });
  await session.send('Profiler.start');

  console.log(`[profile] recording CPU for ${args.duration}s - exercise the app now`);
  await sleep(args.duration * 1000);

  const { profile } = await session.send('Profiler.stop');
  session.close();

  const file = outPath(args, 'cpu', 'cpuprofile');
  fs.writeFileSync(file, JSON.stringify(profile));

  const rows = selfTimeTable(profile);
  const total = rows.reduce((a, r) => a + r.ms, 0);

  console.log('\n=== top self-time ===');
  for (const r of rows) {
    console.log(`  ${r.ms.toFixed(1).padStart(9)}ms  ${r.key}`);
  }

  // A profile that is almost entirely (idle) means the recording window missed
  // the work. Worth saying out loud - it is an easy and confusing mistake.
  const idle = rows.find((r) => r.key.startsWith('(idle)'));
  if (idle && total > 0 && idle.ms / total > 0.9) {
    console.log(
      '\n[profile] WARNING: >90% idle. The app was not busy during the window - ' +
      'trigger the slow operation while recording, or use --attach.'
    );
  }

  console.log(`\n[profile] wrote ${path.relative(ROOT, file)}`);
  console.log('[profile] open it in Chrome DevTools > Performance > Load profile');
}

async function runTrace(args, port) {
  const session = await connectBrowser(port);
  console.log('[profile] attached to browser endpoint (all processes)');

  const events = [];
  session.on('Tracing.dataCollected', (params) => {
    if (params && params.value) events.push(...params.value);
  });
  const complete = session.once('Tracing.tracingComplete', { timeoutMs: 120000 });

  await session.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: TRACE_CATEGORIES },
  });

  console.log(`[profile] tracing ${args.duration}s - reproduce the slow/beachball behaviour now`);
  await sleep(args.duration * 1000);

  await session.send('Tracing.end');
  await complete;
  session.close();

  const file = outPath(args, 'trace', 'json');
  fs.writeFileSync(file, JSON.stringify(events));

  console.log(`\n[profile] captured ${events.length} events -> ${path.relative(ROOT, file)}`);
  console.log(`[profile] analyse: node scripts/analyze-trace.js ${path.relative(ROOT, file)}`);
  console.log('[profile] or load it in Chrome DevTools > Performance');
}

async function runHeap(args, port) {
  const { session, target } = await connectTarget(port);
  console.log(`[profile] attached to: ${target.title}`);

  const chunks = [];
  session.on('HeapProfiler.addHeapSnapshotChunk', (p) => chunks.push(p.chunk));

  await session.send('HeapProfiler.enable');
  console.log('[profile] taking heap snapshot...');
  await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  session.close();

  const file = outPath(args, 'heap', 'heapsnapshot');
  fs.writeFileSync(file, chunks.join(''));
  console.log(`[profile] wrote ${path.relative(ROOT, file)}`);
  console.log('[profile] open it in Chrome DevTools > Memory > Load');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.mode || args.mode === 'help') {
    usage();
    process.exit(args.mode ? 0 : 1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const attaching = args.attach !== null;
  const port = args.port || args.attach || (args.mode === 'cpu' ? 9229 : 9222);

  let child = null;
  if (attaching) {
    console.log(`[profile] attaching to running instance on port ${port}`);
    // Fail early and clearly if nothing is listening.
    await getJSON(port, '/json/list', { timeoutMs: 3000 }).catch(() => {
      throw new Error(
        `[profile] nothing is listening on port ${port}.\n` +
        `  Launch the app first, e.g. npx electron --inspect=${port} .`
      );
    });
  } else {
    child = launchApp(args.mode, port);
    // Give the process time to boot before the inspector endpoint is polled;
    // getJSON retries, so this only needs to be non-zero.
    await sleep(2000);
  }

  const cleanup = () => {
    if (child && !child.killed) {
      console.log('[profile] closing the app');
      child.kill();
    }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    if (args.mode === 'cpu') await runCpu(args, port);
    else if (args.mode === 'trace') await runTrace(args, port);
    else if (args.mode === 'heap') await runHeap(args, port);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
