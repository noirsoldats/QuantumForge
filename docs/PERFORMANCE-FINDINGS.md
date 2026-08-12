# Performance Findings

Measured findings from the profiling and benchmarking work, with enough detail
to turn each into an implementation plan.

**Every finding below was re-verified against current `src/` at the time of
writing.** All of them are live-app issues that still need fixes — none is a
benchmark artifact, and none has been fixed yet. Verification commands are given
per finding so the claims can be re-checked cheaply later.

Companions: [PROFILING.md](PROFILING.md) (how to run the tools),
[BENCHMARK-COVERAGE.md](BENCHMARK-COVERAGE.md) (what is and is not measured).

> **Nothing here has been changed in `src/`.** The benchmark work was
> measurement-only. Each fix below has a baseline waiting
> (`profiles/baseline-*.json`) so its effect can be proven rather than assumed.

---

## Start here (cold session)

Everything below is reproducible. Before planning against these numbers,
re-establish a baseline — the figures here are from one machine on one dataset,
and the dataset expires daily (see below).

```bash
npm run bench:build -- --force     # ~6 min. Reuses saved characters; no login.
npm run bench -- --repeat 3        # all 7 scenarios, offline, ~1 min
npm run bench:renderer             # Asset Manager, synthetic
npm run bench:renderer -- --real   # Asset Manager, real assets + prices
```

**The dataset expires every day at 11:05 UTC**, when ESI republishes market
history. `bench` refuses to run against an expired one and tells you to rebuild
— this is expected, not a failure. Rebuilding reuses the stored characters, so
no ESI login is needed unless you pass `--fresh-login`.

Baseline figures below came from dataset `gmsqjxahg`: 2 characters, 8 plans /
606 nodes, 2,390 assets / 904 distinct types, 1,859 history types. A saved
result is at `profiles/baseline-gmsqjxahg.json`, though it will not match a
freshly built dataset exactly — rebuild and take your own before/after pair.

Read [PROFILING.md](PROFILING.md) for how the tools work and what they do and
do not measure. The short version: `bench` measures main-process calculation,
`bench:renderer` measures renderer JavaScript (jsdom — **no layout or paint**),
and `profile:trace` + `analyze-trace.js` is the only thing that sees real paint
cost and main-thread stalls.

## Summary

| # | Finding | Where | Impact | Effort |
|---|---|---|---|---|
| 1 | `computeRows()` recomputed 4–5× per render | `assets-view-renderer.js:427` | 2.17s per checkbox tick at 5k assets | Low |
| 2 | `storeMarketHistory` re-prepares its statement per call | `esi-market.js:560` | 126 dropped frames, 4.7s blocking per cold sweep | Low |
| 3 | History refresh is fully sequential | `esi-market.js:864` | 16s of a 25s sweep spent idle on I/O | Medium |
| 4 | Asset valuation reaches ESI despite `skipHistory` | `market-pricing.js:373` | 96 unexpected ESI calls on a cold Assets open | Medium |
| ~~5~~ | ~~`getMaterialDrift` has no price-cache session~~ | — | **Withdrawn — measured, no gain** | — |
| 6 | Failing history fetches get no backoff (gate bypassed) | `esi-market.js:470, 509` | Retry storm on a failing type, unbounded | Medium |

Ordered by value-for-effort: **1 and 2** are small, self-contained, and have
numbers waiting. **3, 4 and 6** all concern ESI traffic from the history-fetch
path and are worth designing together. **5 was withdrawn** after the benchmark
built to prove it showed no gain — kept below as a worked example.

---

## 1. Asset Manager: `computeRows()` is recomputed 4–5× per render

**Live-app issue — confirmed unfixed.**

```bash
grep -n "computeRows()" src/renderer/assets-view-renderer.js
# 427 (definition), then 534, 708, 847, 859, 1002 — five call sites, no memo
```

### Measured

```
   assets   checkbox       sort     search
      500    221.9ms    218.9ms     79.3ms
     2000    857.4ms    877.2ms    286.5ms
     5000      2.17s      2.21s    707.8ms
```

**Ticking one checkbox costs the same as a full re-sort.** Selecting a row
changes no data — it should be nearly free.

### Cause

`computeRows()` (`assets-view-renderer.js:427`) filters, aggregates and sorts the
entire asset list. It is called from `renderSummary` (534), `renderTable` (708),
`renderSelectionBar` (847, 859) and `renderStatusLine` (1002) — so a single
`render()` runs the whole pipeline **four to five times**. `render()` itself is
called from 29 sites, including every checkbox handler.

Scaling is linear at ~0.43ms/row, so this is a **constant-factor** problem, not
an algorithmic one.

### Fix sketch

Memoise `computeRows()` against the state it actually depends on — the asset
list, active filters, aggregate flag, and sort column/direction. Selection state
must **not** be in the key, since that is precisely what changes on a checkbox
tick.

A dirty flag invalidated by the mutators is enough; no library needed. The
larger structural fix — not rebuilding the table for a selection change at all —
is worth considering but is a bigger change.

### Verify

`npm run bench:renderer` before and after. The `checkbox` column should collapse
toward the `search` figure; `sort` should be unchanged (it legitimately needs a
recompute).

---

## 2. `storeMarketHistory` re-prepares its statement on every call

**Live-app issue — confirmed unfixed.** `db.prepare(...)` is still inside the
function body (`esi-market.js:564`), with one transaction per type.

### Measured

Isolated, against the real market DB:

```
single storeMarketHistory call (375 rows), main thread BLOCKED:
  p50 4.3ms   p95 18.2ms   max 19.7ms   mean 6.4ms
```

Event-loop lag during a real 22.1s cold Manufacturing Summary sweep:

```
stalls: p50 1.0ms   p95 26.5ms   p99 46.0ms   max 305ms
>16ms (dropped frame): 126     >100ms: 4     >1000ms (beachball): 0
total time blocked >16ms: 4.7s
```

### Interpretation

**No beachball — persistent stutter.** The UI does not freeze; it drops 126
frames across ~22 seconds. The worst single stall was 305ms, which is
perceptible. Every `better-sqlite3` call is synchronous on the main thread, so
each write blocks IPC and paint until it returns.

This is a real user cost: anyone opening Manufacturing Summary on a cold cache
pays it. Measured on a fast local disk — a larger market DB or slower storage
would be worse.

### Cause

`storeMarketHistory` (`esi-market.js:560`) calls `db.prepare()` inside the
function, then runs one transaction per type over ~375–400 daily rows. Called
304 times in one sweep.

### Fix sketch

1. **Hoist the prepared statement** to module scope, lazily initialised on first
   use (the DB handle does not exist at module load). This is the cheap win.
2. **Batch across types.** One transaction per type is 304 transactions per
   sweep; a single transaction around a batch would cut commit overhead
   sharply.
3. Consider `clearPriceCache` too — it is called per type inside the same loop.

Statement churn is not unique to this function: `.prepare()` is re-run per call
throughout the codebase, and `sde-database.js` uses none at all across ~35
functions. This is the highest-traffic instance and a good place to establish
the pattern.

### Verify

`npm run bench -- --only summary` for wall-clock. For the stutter itself,
`npm run profile:trace` during a cold sweep, then `analyze-trace.js` — the
Browser-process long-task count should fall.

---

## 3. Market history refresh is fully sequential

**Live-app issue — confirmed unfixed.** `manualRefreshHistoryData`
(`esi-market.js:864`) still loops `await fetchMarketHistory(...)` one type at a
time with a fixed 100ms sleep.

### Measured

CPU profile of a cold Manufacturing Summary sweep:

```
total 25.0s | idle 16.0s (waiting on I/O) | busy CPU 9.0s
  better-sqlite3  7.1s   79% of busy CPU
    └ storeMarketHistory  4.5s   63% of all SQLite time
  network/undici  0.3s
```

**16 of 25 seconds was idle**, waiting on 286 sequential HTTP requests.

### Cause

History is one ESI call per type. The region-wide refresh iterates every type
with an order in the region — **19,137** in The Forge — at 100ms spacing. That
is over half an hour of wall-clock for a full refresh, and a large slice of an
app-wide error budget.

### Fix sketch

Bounded concurrency, e.g. 4–6 in flight (the Manufacturing Summary sweep already
uses `BATCH_SIZE = 6` for exactly this reason). Requires care:

- ESI's error budget is **application-wide**; the existing `esi-error-budget.js`
  governor must still see and respect headers.
- The 100ms spacing is a crude rate limit; concurrency should replace it
  deliberately, not by deletion.
- Progress reporting (`market:historyProgress`) must stay monotonic.

A narrower alternative: keep it sequential but stop fetching types the caller
does not need. The whole-region sweep is what makes the count enormous.

### Verify

Wall-clock of `manualRefreshHistoryData` on a fixed type list, plus
`esi-status-tracker` counts to confirm the error budget is unharmed.

---

## 4. Asset valuation reaches ESI despite `skipHistory: true`

**Live-app issue — confirmed unfixed.** The fallback at
`market-pricing.js:373-377` still fetches history when the order book is empty
after location filtering.

### Measured

Asset Manager mount, main-process half, over 2,390 real assets / 904 distinct
types:

```
getAssets                 4.4ms
SDE lookups (3 batched)  10.4ms
calculatePrices         475.9ms warm   [20.6s cold]
```

The cold figure was **96 ESI calls**. `"No orders for type"` appears exactly 96
times — one per call.

### Cause

The Assets screen prices a whole hangar with `skipHistory: true`, which reads as
"never touch ESI". It is not: when a type has no orders *after the location
filter*, `calculateRealisticPrice` falls back to the historical average and
fetches it (`market-pricing.js:373`).

96 of 904 held types hit that path — illiquid items with no Jita orders. The
comment there is explicit that the fetch is deliberate ("DEFERRED, not
abandoned"), so the fallback is intentional. What is not intentional is a
hangar-wide valuation quietly becoming ~100 sequential ESI calls.

**Same class as finding 3**: a batched call degrading into per-item ESI traffic.

### Fix sketch

Options, in rough order of preference:

1. **Batch the fallback.** Collect the types that need history during the sweep,
   fetch them together at the end, then finish pricing. Keeps the fallback's
   correctness and removes the per-item serialisation.
2. **Make it opt-out.** A `noHistoryFallback` flag for whole-hangar valuation,
   accepting a lower-confidence price for items that do not trade. Cheapest, but
   changes displayed values.
3. **Negative-cache the "no orders at this location" case** so repeat opens do
   not repeat the work.

Whichever is chosen, the count of fallback fetches should be surfaced rather
than silent.

### Verify

`npm run bench -- --only assets` against a dataset where those types are absent,
counting `esi.evetech.net` lines in the output.

---

## 5. `plans:getMaterialDrift` has no price-cache session — WITHDRAWN

**Do not implement.** The reasoning was sound and the conclusion was wrong. The
benchmark built to prove it disproved it instead — which is the system working.

### What was claimed

`getPlanMaterialDrift` (`manufacturing-plans.js:3914`) prices every material
sequentially, and its handler (`main.js:1468`) opens no `withPriceCache`
session — unlike the summary and invention handlers. Materials within a plan
overlap heavily, so the same order books looked like they must be re-read.
Expected gain was ~30%, by analogy with the invention sweep.

### What the measurement showed

`npm run bench -- --only planopen`, on the 186-node plan:

```
  getMaterialDrift (as shipped)     40.0ms    no withPriceCache session
  getMaterialDrift (with cache)     41.4ms    0 hits / 90 reads
```

**Zero cache hits.** No gain — the cached version is marginally slower, which is
session setup overhead.

### Why

The plan has 186 material nodes but only **72 distinct type IDs**, so the
overlap is real. But the drift query already `GROUP BY type_id`
(`manufacturing-plans.js:3931`) and prices each distinct type exactly once.
There is nothing left for the read cache to deduplicate.

The invention sweep is different in kind: it prices the *same* materials
repeatedly at different quantities across 9 decryptor options, which is
precisely the pattern `market-read-cache.js` was built for. Drift does not have
that shape.

### What this leaves

Plan open is genuinely cheap: **1.2ms** for the parallel
`getSummary` + `getMaterials` the view issues, **1.8ms** for `getAnalytics`,
**40ms** for drift. Nothing here is a user-visible problem, and the read path is
no longer an uncovered gap — the scenario stays in the suite as a regression
guard.

**Kept as a worked example** of why "measure first" is in the plan. Missing an
obvious-looking optimisation costs nothing; shipping one that does not work
costs a change to `src/` and the confidence that it helped.

---

## 6. Failing market-history fetches get no backoff

**Live-app issue — partially fixed elsewhere, still open for this path.**

### Background: the general case WAS fixed

A note from the UI/UX redesign flagged that `recordESICallError` did not advance
`next_allowed_at`, so a persistently-failing endpoint retried every pass with no
backoff. **That has since been fixed**, and thoroughly:

- `recordESICallError` (`esi-status-tracker.js:385`) now computes
  `nextAllowedAt` and writes it, with a comment naming the exact problem.
- `errorBackoffMs` (`:327`) is exponential and capped — 5 min base / 6 h ceiling
  for client errors, 30 s / 15 min otherwise, with 420/429 excluded because
  `esi-fetch` already honours `Retry-After`.
- The streak is derived from history rather than the cumulative `error_count`,
  so a recovered endpoint is not punished for months-old failures.
- `esiFetch` gates every call through `canFetchEndpoint` (`esi-fetch.js:296`),
  so the fix reaches every fetcher — which was the original concern.

**No action needed for the general case.**

### What is still open

Five call sites pass `skipGate: true`, deliberately bypassing that gate because
they own their own cache cadence — and one of them is market history
(`esi-market.js:470`).

Its own gates are `isHistoryStale` (row-based) and `hasFreshEmptyHistory`
(empty-response). **Neither records a failure.** And `fetchHistoryFromESI`
swallows errors:

```js
} catch (error) {
  console.error('Error fetching market history:', error);
  return getCachedMarketHistory(regionId, typeId);   // esi-market.js:509
}
```

So for a type whose history request fails repeatedly — a 500, a timeout, a
transient network fault — nothing is written: no rows, no negative-cache entry,
no `next_allowed_at`. The next pricing pass tries again immediately, and
`skipGate: true` means `esiFetch`'s backoff cannot stop it either.

### Why it matters here

This is the same population as findings 3 and 4. A whole-hangar valuation or a
Manufacturing Summary sweep already issues hundreds of history calls; if some of
those types are failing rather than merely empty, every sweep re-attempts every
one of them, forever, against an app-wide error budget.

Not observed in the benchmark runs — the failures there were all legitimate
empties, which *are* cached correctly. This is a reasoned gap from reading the
code, not a measured one, and it should be confirmed with a fault injection test
before being treated as urgent.

### Fix sketch

The narrow fix: record the failure in `fetchHistoryFromESI`'s catch, using the
same negative-cache mechanism that already handles empties — a
`recordHistoryFailure(regionId, typeId, backoffMs)` alongside
`recordEmptyHistory`, checked by the same guard.

The broader question is whether `skipGate: true` should imply "no error backoff
either". It probably should not: the reason each of those five sites bypasses
the gate is *cache cadence*, not error handling. A `skipGate: 'cadence-only'`
variant that still honours error backoff would fix all five at once and is the
more principled change.

### Verify

Fault injection: point a type's history fetch at a failing endpoint and confirm
the second pricing pass does not re-attempt it immediately.

---

## Corrections to earlier notes

Two claims made during the session did not survive re-verification. Recorded so
they are not carried into a plan.

### "Types with no history rows re-fetch forever" — WRONG as stated

The reasoning was: `isHistoryStale()` derives freshness from stored rows
(`esi-market.js:409`), so a type with none is permanently stale.

That branch is real, but the app **already handles it**. `recordEmptyHistory`
fires both when ESI reports empty (`:489`) and when a 200 carries zero days
(`:501`), and `hasFreshEmptyHistory` (`:143`) short-circuits before the
staleness test. The dataset currently holds **157** such negative-cache entries,
doing exactly their job.

The 6 types observed re-fetching (Cerberus and five capital components) were
simply **never seeded by `bench:build`** — they are invention products, reached
only by `findBestDecryptor`, and no warm step covered them. Confirmed: all six
now hold 407 rows each. That was a benchmark coverage gap, fixed by adding an
invention warm step. **No app fix needed.**

### "304 sequential history fetches" — counted from one sweep, not a separate bug

The 304 figure is the same phenomenon as finding 3, observed from the
Manufacturing Summary side rather than the region-refresh side. Folded into
finding 3 rather than tracked separately.

---

## Suggested sequence

1. **Finding 1** (`computeRows` memoisation) — biggest user-visible win,
   smallest blast radius, benchmark ready.
2. **Finding 2** (statement hoisting) — small, mechanical, measurable via both
   wall-clock and trace.
3. **Findings 3, 4 and 6** — all three are about ESI traffic from the same
   history-fetch path: batched work degrading into per-item calls (3, 4) and
   failing calls never backing off (6). Worth designing together, since they
   touch the same code and the same shared error budget. Confirm 6 with a fault
   injection test first — it is reasoned from the code, not measured.

~~Add the plan-open benchmark, then finding 5~~ — done, and it withdrew the
finding. The scenario remains in the suite as a regression guard.

---

## Constraints any fix must respect

Learned during the measurement work. Worth knowing before designing changes.

**The ESI error budget is application-wide.** It is shared by every fetcher and
governed by `esi-error-budget.js`. Findings 3, 4 and 6 all involve changing how
many ESI calls are made and when; none of them may be designed without
accounting for that governor. A change that speeds up one screen by hammering
ESI harms every other screen.

**Every `better-sqlite3` call is synchronous on the main thread.** There is no
worker, no async variant. So any DB work added to a hot path blocks IPC and
paint directly — this is the mechanism behind finding 2's dropped frames. It
also means "just batch more" has a ceiling: a bigger transaction blocks longer
in one go.

**Market history is published once daily at 11:05 UTC.** `isPastDailyHistoryCutoff`
is the app's rule, and it invalidates everything older wholesale. Any caching
scheme for history has to live inside that cadence rather than invent its own.

**Plan prices are locked by design** (CLAUDE.md binding rule 7). `getMaterialDrift`
reads live prices for *display* only and must never write them. Do not "fix" the
drift path by making it write.

**The renderer benchmark cannot see paint.** jsdom has no compositor, so a
finding-1 fix will show in `bench:renderer` numbers but its real-world effect
needs `profile:trace` against the running app. Both are worth checking.

---

## What was deliberately not done

So a fresh session does not re-litigate these.

- **No `src/` changes.** All of this work was measurement-only, by design, so
  each fix can be proven against a baseline instead of assumed.
- **No in-app profiler.** Rejected early: it would ship instrumentation to
  users, need a dev-only gate, and could only ever measure what someone thought
  to instrument. External sampling sees everything.
- **No cross-machine or cross-developer comparability.** Numbers are valid
  within one build generation on one machine. Chasing more would mean committing
  a database snapshot; the repo ships a recipe instead.
- **ESI scenarios are opt-in** (`--with-esi`) and still unbuilt. They need live
  tokens, vary run to run, and spend error budget.
- **Boot → first paint is unmeasured.** Listed in the original plan, never
  built; it needs `profile:trace`, not a bench scenario. Still the most likely
  remaining unknown — every window, including every pop-out, parses 26 blocking
  scripts (~28.5k lines) and 16 stylesheets to show one view.
