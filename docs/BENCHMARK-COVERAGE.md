# Benchmark Coverage

What the benchmark suite currently measures, and what it does not. Companion to
[PROFILING.md](PROFILING.md), which covers how to run everything.

Baseline figures below are p50 of 3 runs on the `gmsqjxahg` dataset (2 characters,
8 plans / 606 nodes, 2,390 assets / 904 distinct types, 1,859 history types).
They are session-local — see PROFILING.md on comparability.

---

## Covered today

### Main process — `npm run bench`

| Scenario | Path under test | Baseline | Why it is here |
|---|---|---|---|
| `recalc` | `recalculatePlanMaterials` across 8 plans, 8→186 nodes | 4.9ms → 139ms | The heaviest single function in the app: ~1,520 lines holding one SQLite transaction, calling the recursive engine per blueprint, then pricing every node with sequential awaits. Fires on **every blueprint edit**. |
| `invention` | `findBestDecryptor`, with and without the price-cache session | 1.24s / 1.83s | ~198 `calculateRealisticPrice` calls for ~11 distinct items. Quantifies what `withPriceCache` actually buys. |
| `materials` | `calculateBlueprintMaterials`, cold vs warm | 114ms / 0.2ms | Isolates the recursive tree walk from the `materialTreeCache` hit. The gap is the true cost of a full walk. |
| `summary` | Manufacturing Summary full sweep | 2.61s | 244 rows of heavily-overlapping material lists. |
| `wcib` | What Can I Build? full sweep | 2.05s | Asset aggregation + pricing + SVR over 904 asset types. |
| `assets` | Asset Manager **mount**, main-process half | 3.5ms / 9.3ms / 789ms | `getAssets`, three batched SDE lookups, and the sequential `calculatePrices` loop. |
| `planopen` | The read path: `getSummary`+`getMaterials`, `getMaterialDrift`, `getAnalytics` | 1.2ms / 40ms / 1.8ms | `recalc` covers the write path; this covers the far more frequent read path. Built to test finding 5 — and disproved it. |

### Renderer — `npm run bench:renderer`

| Mode | Path under test | Baseline |
|---|---|---|
| synthetic | Asset Manager interactions at 500 / 2000 / 5000 rows | checkbox 222ms → 2.17s |
| `--real` | Same, against real assets/prices/categories | mount 7.09s, checkbox 776ms |

### Diagnostics (not benchmarks)

| Tool | Answers |
|---|---|
| `npm run profile:cpu` | Where CPU time goes (self-time table + `.cpuprofile`) |
| `npm run profile:trace` + `analyze-trace.js` | Which process stalls, and for how long — the beachball detector |

---

## Confirmed findings so far

Recorded because they are measured, not suspected.

1. **Summary sweep was 89% network, not calculation.** 22s → 2.5s once history
   was pre-cached. 16s of a 25s window was idle waiting on 286 sequential ESI
   history fetches; 4.5s of CPU was `storeMarketHistory` writing them back.
2. **Main-thread stutter is real but is not a beachball.** During a cold sweep:
   126 dropped frames, 4.7s cumulative blocking, worst single stall 305ms, zero
   stalls over 1s. One `storeMarketHistory` call blocks 4–20ms — synchronous
   better-sqlite3, ~375 row inserts, statement re-prepared **inside** every call
   (`esi-market.js:560`).
3. **Asset Manager: ticking one checkbox costs the same as a full re-sort.**
   2.17s at 5,000 rows. `computeRows()` is unmemoised and runs 4–5× per
   `render()` (`assets-view-renderer.js:534, 708, 847, 859, 1002`), from a
   `render()` called at 29 sites. Scaling is linear (~0.43ms/row), so this is a
   constant-factor problem — memoisation should collapse it.
4. **`recalculatePlanMaterials` scales linearly**, 0.55–0.85ms/node from 8 to
   186 nodes. That argues *against* the O(n²) reverse-scan theory
   (`manufacturing-plans.js:3495,3682`) at these sizes — worth re-testing if a
   plan ever reaches thousands of nodes.
5. **Asset valuation reaches ESI despite `skipHistory: true`.** 96 of 904 held
   types have no Jita orders, so `calculateRealisticPrice` falls back to the
   historical average and fetches it (`market-pricing.js:373`).
6. ~~Types with no history rows re-fetch forever.~~ **Withdrawn on
   re-verification** — the app already handles this via `recordEmptyHistory` +
   `hasFreshEmptyHistory` (157 such entries in the current dataset). The 6 types
   observed re-fetching were a `bench:build` seeding gap, now fixed by the
   invention warm step. See the corrections section in
   [PERFORMANCE-FINDINGS.md](PERFORMANCE-FINDINGS.md).

---

## Not covered — candidates, ranked

### ~~1. Plan open~~ — COVERED (`npm run bench -- --only planopen`)

Built, and it changed the answer. Plan open is cheap: 1.2ms for the parallel
`getSummary`+`getMaterials`, 1.8ms for `getAnalytics`, 40ms for drift. The
suspected `withPriceCache` gap turned out to yield nothing — the drift query
already dedupes with `GROUP BY type_id`, so the cache has nothing to do. See
finding 5 in [PERFORMANCE-FINDINGS.md](PERFORMANCE-FINDINGS.md).

The original reasoning, kept for context:

The strongest gap. Opening a plan fires four handlers, and
`getPlanMaterialDrift` (`manufacturing-plans.js:3914`) prices **every material
live** for the drift display — a sequential `await calculateRealisticPrice` per
material. `getPlanAnalytics` (`:4685`) additionally awaits `getPlanSummary` and
`getPlanLedger`. On the 186-node plan that is a lot of work behind a click users
make constantly.

**Verified while writing this:** the `plans:getMaterialDrift` handler
(`main.js:1468`) is **not** wrapped in `withPriceCache` — the same gap that made
`recalculatePlanMaterials` slower than it needed to be. The invention scenario
already measured what that session is worth: 1.24s vs 1.83s, ~30%. This is a
one-line change with a benchmark ready to prove it, but it should be *measured
first* — the whole point of the harness.

*Why it matters:* `recalc` measures the write path; nothing measures the read
path, and the read path runs far more often.

### 2. Plan matching (`matchJobsToPlan` / `matchTransactionsToPlan`)

`plan-matching.js` is 1,298 lines and runs on plan open **and** on the 5-minute
auto-refresh cycle. Heuristic scoring across every job/transaction × every plan
blueprint. Cost scales with ESI job and wallet history, which grows without
bound.

### 3. Reactions calculator (`reactions:calculateMaterials`)

`reaction-calculator.js` is 974 lines with its own recursive expansion, and is
entirely unmeasured. Structurally similar to `calculateBlueprintMaterials`,
which is the app's hottest function — so the same N+1 patterns are plausible.

### 4. App boot → first view painted

Listed in the original plan and never built. Every window — **including every
pop-out** — parses 26 blocking scripts (~28.5k lines) and 16 stylesheets to show
one view. Needs `profile:trace` rather than a bench scenario, since it is a
paint-inclusive measurement.

### 5. Other renderer screens

Only Assets has a renderer benchmark. The harness generalises, but the others
look lower-risk on inspection:

- **Market** (4,240 lines) — lists are capped at 40–50 rows, so unlikely to be
  row-count-bound.
- **WCIB / Summary** — `applyFilters()` is a single-pass filter+sort over a few
  hundred rows, not the 4–5× recompute Assets has.
- **Manufacturing Plans** (4,976 lines) — ~26 discrete render functions, no
  single `render()`; the Build List and Materials tabs are the ones to watch.

### 6. ESI background refresh cycle

`runRefreshCycle` is three nested sequential loops:
`characters × tasks + corps × tasks`, fully serial. Already logs its own cycle
duration (`esi-background-refresh.js:331`). Deliberately excluded from the
default suite — it needs live tokens and spends error budget — but a
`--with-esi` scenario was planned and never built.

### Deliberately out of scope

- **SDE download / validation** — one-time setup, network-bound.
- **Loot parser** — already batches through `searchItemsByExactName`; small
  inputs.
- **Market watchlists** — no bulk pricing path; alerts are derived in the
  renderer.

---

## Suggested order

If the goal is user-visible responsiveness:

1. **Fix what is already measured** — `computeRows()` memoisation and the
   `esi-market.js:560` write path have numbers and a baseline waiting.
2. **Add plan-open coverage** (gap 1) — highest-frequency uncovered path.
3. **Add plan matching** (gap 2) — grows silently with account history.
4. **Boot timing via trace** (gap 4) — affects every window and every pop-out.
