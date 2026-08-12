#!/usr/bin/env node
'use strict';

/**
 * Beachball finder - triage for a Chrome trace captured by scripts/profile.js.
 *
 * A trace is tens of thousands of events and several megabytes, so reading one
 * by hand is impractical. This pulls out the only thing that matters for a
 * frozen UI: long tasks.
 *
 * WHY LONG TASKS ARE THE RIGHT SIGNAL
 * -----------------------------------
 * A `RunTask` event is one turn of a thread's message loop. While it runs, that
 * thread does nothing else - no IPC, no input, no paint. So on the Browser
 * (main) process a long RunTask is exactly a stall: every synchronous
 * better-sqlite3 call in Quantum Forge runs on that thread, and a slow one
 * blocks window paint and every IPC reply until it returns. Past ~1s macOS
 * shows the spinning wait cursor.
 *
 * The process split matters because the fixes differ:
 *   Browser  -> synchronous DB work / heavy compute on the main thread
 *   Renderer -> full table rebuilds, unmemoised recomputation, layout thrash
 *
 * Durations in a trace are MICROSECONDS.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Anything past this is a dropped frame at 60fps and a visible hitch. */
const DEFAULT_THRESHOLD_MS = 100;
/** Past this the OS starts showing a wait cursor. */
const BEACHBALL_MS = 1000;

function parseArgs(argv) {
  const args = { file: null, thresholdMs: DEFAULT_THRESHOLD_MS, limit: 20, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') args.thresholdMs = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

function usage() {
  console.log(`
Beachball finder - analyse a trace from scripts/profile.js --trace

  node scripts/analyze-trace.js <trace.json> [--threshold MS] [--limit N] [--json]

  --threshold MS  report tasks longer than this (default ${DEFAULT_THRESHOLD_MS})
  --limit N       max rows per process (default 20)
  --json          emit JSON instead of a table
`);
}

/**
 * Map pid -> human process name using the trace's own metadata events.
 * Without this every row is an opaque number.
 */
function processNames(events) {
  const names = new Map();
  for (const e of events) {
    if (e.name === 'process_name' && e.args && e.args.name) {
      names.set(e.pid, e.args.name);
    }
  }
  return names;
}

/**
 * Collect completed tasks over the threshold.
 *
 * `RunTask` and `ThreadControllerImpl::RunTask` are emitted for the same work,
 * so counting both would double-report; RunTask is preferred and the other is
 * only used when RunTask is absent for that exact (pid,tid,ts).
 */
function longTasks(events, thresholdUs) {
  const seen = new Set();
  const primary = [];
  const fallback = [];

  for (const e of events) {
    if (!e.dur || e.dur < thresholdUs) continue;
    if (e.ph !== 'X') continue; // complete events only

    if (e.name === 'RunTask') {
      seen.add(`${e.pid}:${e.tid}:${e.ts}`);
      primary.push(e);
    } else if (e.name === 'ThreadControllerImpl::RunTask') {
      fallback.push(e);
    }
  }

  for (const e of fallback) {
    if (!seen.has(`${e.pid}:${e.tid}:${e.ts}`)) primary.push(e);
  }

  return primary.sort((a, b) => b.dur - a.dur);
}

/**
 * Index events by thread, sorted by start time.
 *
 * Built once and reused for every task. Scanning the whole event array per task
 * would be O(tasks x events) - on a real multi-megabyte trace that is tens of
 * millions of comparisons, which is slow enough to be annoying.
 */
function indexByThread(events) {
  const byThread = new Map();
  for (const e of events) {
    if (!e.dur || e.ph !== 'X') continue;
    if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') continue;
    const key = `${e.pid}:${e.tid}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(e);
  }
  for (const list of byThread.values()) list.sort((a, b) => a.ts - b.ts);
  return byThread;
}

/** Index of the first element with ts >= target (binary search). */
function lowerBound(list, ts) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Nested events contained by a task, to hint at what it was doing.
 *
 * Only events taking a meaningful share of the task are worth showing - a task
 * contains thousands of sub-microsecond V8 bookkeeping events that say nothing
 * about why it was slow.
 */
function attributeTask(task, byThread) {
  const list = byThread.get(`${task.pid}:${task.tid}`);
  if (!list) return [];

  const end = task.ts + task.dur;
  const floor = task.dur * 0.2;
  const inner = [];

  for (let i = lowerBound(list, task.ts); i < list.length; i++) {
    const e = list[i];
    if (e.ts > end) break; // sorted by ts, so nothing later can be contained
    if (e.dur > floor && e.ts + e.dur <= end) {
      inner.push({ name: e.name, ms: e.dur / 1000 });
    }
  }

  return inner.sort((a, b) => b.ms - a.ms).slice(0, 3);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.file) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const file = path.resolve(ROOT, args.file);
  if (!fs.existsSync(file)) {
    console.error(`[analyze] no such trace: ${file}`);
    process.exit(1);
  }

  let events;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Accept both our bare array and Chrome's {traceEvents: [...]} wrapper.
    events = Array.isArray(raw) ? raw : raw.traceEvents;
  } catch (err) {
    console.error(`[analyze] could not parse trace: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(events)) {
    console.error('[analyze] trace contains no event array');
    process.exit(1);
  }

  const names = processNames(events);
  const tasks = longTasks(events, args.thresholdMs * 1000);

  if (args.json) {
    console.log(JSON.stringify(
      tasks.map((t) => ({
        ms: t.dur / 1000,
        pid: t.pid,
        tid: t.tid,
        process: names.get(t.pid) || `pid ${t.pid}`,
        beachball: t.dur / 1000 >= BEACHBALL_MS,
      })),
      null,
      2
    ));
    return;
  }

  console.log(`\nTrace: ${path.relative(ROOT, file)}`);
  console.log(`Events: ${events.length}   Long tasks (>${args.thresholdMs}ms): ${tasks.length}`);

  if (tasks.length === 0) {
    console.log('\nNo long tasks found. Either the UI was responsive during the capture,');
    console.log('or the slow operation happened outside the tracing window.');
    return;
  }

  // Group by process so main-thread stalls and renderer stalls read separately -
  // they have different causes and different fixes.
  const byProcess = new Map();
  for (const t of tasks) {
    const label = names.get(t.pid) || `pid ${t.pid}`;
    if (!byProcess.has(label)) byProcess.set(label, []);
    byProcess.get(label).push(t);
  }

  const order = [...byProcess.keys()].sort((a, b) => {
    const worst = (k) => byProcess.get(k)[0].dur;
    return worst(b) - worst(a);
  });

  // Built once; attributeTask binary-searches it per task.
  const byThread = indexByThread(events);

  for (const label of order) {
    const rows = byProcess.get(label);
    console.log(`\n=== ${label} ===`);
    for (const t of rows.slice(0, args.limit)) {
      const ms = t.dur / 1000;
      const flag = ms >= BEACHBALL_MS ? '  <-- BEACHBALL' : '';
      console.log(`  ${ms.toFixed(0).padStart(6)}ms  tid=${t.tid}${flag}`);
      for (const inner of attributeTask(t, byThread)) {
        console.log(`           ${inner.ms.toFixed(0).padStart(5)}ms  ${inner.name}`);
      }
    }
    if (rows.length > args.limit) {
      console.log(`  ... and ${rows.length - args.limit} more`);
    }
  }

  const beachballs = tasks.filter((t) => t.dur / 1000 >= BEACHBALL_MS);
  const browser = beachballs.filter((t) => (names.get(t.pid) || '') === 'Browser');

  console.log('\n=== summary ===');
  console.log(`  tasks over ${args.thresholdMs}ms: ${tasks.length}`);
  console.log(`  tasks over ${BEACHBALL_MS}ms (beachballs): ${beachballs.length}`);

  if (browser.length > 0) {
    console.log(
      `\n  ${browser.length} beachball(s) on the BROWSER (main) process.\n` +
      '  Every better-sqlite3 call in the app is synchronous and runs on that\n' +
      '  thread, so main-thread stalls of this size point at database work -\n' +
      '  check the pricing loop and plan recalculation first.'
    );
  }

  const renderer = beachballs.filter((t) => (names.get(t.pid) || '').includes('Renderer'));
  if (renderer.length > 0) {
    console.log(
      `\n  ${renderer.length} beachball(s) on a RENDERER process.\n` +
      '  Look for full table rebuilds and unmemoised recomputation on every\n' +
      '  state change rather than for database work.'
    );
  }
}

main();
