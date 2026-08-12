# Profiling and Benchmarking

Quantum Forge is profiled with **external tools only**. Nothing in this document
adds a single line of instrumentation to the shipped application: the app is
launched with standard Electron/V8 debug flags and sampled from outside.

That is deliberate. Building a profiler into the app would ship instrumentation
to users, need a dev-only gate to keep it out of their way, and — the real
limitation — could only ever measure what someone thought to instrument in
advance. A sampling profiler sees everything, including the code nobody
suspected.

There are two separate activities here, and they answer different questions:

| | Question | Tool |
|---|---|---|
| **Profiling** | *Why* is this slow? Where does the time go? | `npm run profile:cpu` / `profile:trace` |
| **Benchmarking** | Did my change actually make it faster? | `npm run bench` |

---

## Part 1 — Profiling

### Finding a beachball (start here)

If a screen freezes and macOS shows the spinning wait cursor, that is the main
thread blocked. Capture a trace while it happens:

```bash
npm run profile:trace -- --duration 20
# reproduce the freeze while it records
node scripts/analyze-trace.js profiles/trace-<timestamp>.json
```

Output looks like:

```
=== Browser ===
    2314ms  tid=17813370  <-- BEACHBALL
     418ms  tid=17813370

=== summary ===
  tasks over 100ms: 6
  tasks over 1000ms (beachballs): 1

  1 beachball(s) on the BROWSER (main) process.
```

**Reading it.** A `RunTask` is one turn of a thread's message loop. While it
runs, that thread does nothing else — no IPC, no input, no paint. So:

- **>100ms** — a dropped frame; a visible hitch.
- **>1s** — long enough for the OS to show a wait cursor.

**Which process it lands on tells you what kind of bug it is:**

- **Browser (main process)** — almost always synchronous database work. *Every*
  `better-sqlite3` call in this app is synchronous and runs on the main thread,
  so a slow query blocks window paint and every IPC reply until it returns.
- **Renderer** — full table rebuilds, unmemoised recomputation on every state
  change, layout thrash. Not database work.

The raw `trace.json` also loads directly into Chrome DevTools → Performance →
Load profile, which is worth doing when you want the visual timeline.

### CPU profile — where the time goes

```bash
npm run profile:cpu -- --duration 15
```

Prints a self-time table (the function actually burning CPU, not its callers)
and writes a `.cpuprofile` for DevTools → Performance.

```
=== top self-time ===
   5592.4ms  burn @ blueprint-calculator.js:461
     63.4ms  resolveOwnedBlueprint @ blueprint-calculator.js:357
```

> **If the table is almost entirely `(idle)`**, the recording window missed the
> work. The tool warns about this. Either trigger the slow operation *while* it
> records, or use `--attach` (below).

**Important caveat.** A CPU profile only shows CPU. Several suspected
bottlenecks are latency-bound, not CPU-bound — a loop of sequential
`await calculateRealisticPrice` calls appears as **idle** in a flame chart even
though it dominates wall-clock. Use `npm run bench` for those; it measures
wall-clock and reports the price-cache hit/miss counters.

### Attaching to an already-running app

The most useful mode when a freeze is intermittent: start the app yourself, use
it normally, and attach the moment things go wrong.

```bash
# main process (for --cpu)
npx electron --inspect=9229 .
node scripts/profile.js --cpu --attach 9229 --duration 10

# all processes (for --trace)
npx electron --remote-debugging-port=9222 .
node scripts/profile.js --trace --attach 9222 --duration 20
```

### Interactive DevTools

No scripts needed:

```bash
npx electron --inspect=9229 .     # then open chrome://inspect
```

`chrome://inspect` → *inspect* gives the full DevTools: flame charts, call
trees, heap snapshots, allocation timelines. For renderer windows, launch with
`--remote-debugging-port=9222` and open `http://localhost:9222` to pick a page.

### Heap snapshots

```bash
node scripts/profile.js --heap
```

Writes a `.heapsnapshot` for DevTools → Memory → Load.

---

## Part 2 — Benchmarking

### The two commands, and why they are separate

```bash
npm run bench:build     # rarely. Requires ESI login. THE ONLY NETWORKED STEP.
npm run bench           # constantly. No network, no login.
```

`bench:build` creates the dataset. `bench` measures against it and never
re-fetches, so **the data cannot shift underneath your measurements**. Across
many runs and many code changes, a timing delta is a *code* delta.

### What `bench:build` needs from you

1. **An SDE.** Run Quantum Forge normally once and let it download the Static
   Data Export. The builder **copies** your existing `sde/eve-sde.db` (~55MB)
   into the sandbox rather than re-downloading it — it is static, read-only
   reference data, not something a benchmark should rebuild. It is copied and
   not symlinked on purpose: the SDE updater deletes and replaces that path, and
   a sandbox that can reach your real file at all is a sandbox that can be wrong
   about it.
2. **An ESI login**, when prompted — **only on the first build.**

   Rebuilds carry the previous dataset's characters across, along with their
   refresh tokens, so you are not asked to log in again. An expired *access*
   token is fine; the app refreshes it on first use. Their skills, blueprints
   and assets come across too, so a rebuild skips the ESI re-fetch entirely.

   ```bash
   npm run bench:build -- --force                      # reuse characters (default)
   npm run bench:build -- --force --refresh-characters  # reuse, but re-pull ESI data
   npm run bench:build -- --force --fresh-login         # start over, pick new characters
   ```

   If a rebuild fails, the previous dataset is **restored** — one bad run never
   costs you the login. Plan data is deliberately *not* carried: plans are
   rebuilt from the recipe by current application code, which is the point.
3. **A few minutes for the market fetch.** The builder pulls the region's order
   book in one bulk call, then market history for **only the types the built
   plans reference** (~165, roughly 20 seconds).

   It deliberately does *not* use the app's region-wide history refresh: history
   is one throttled ESI call per type, and The Forge has **19,137** types with
   orders — over half an hour of sequential requests, and a serious dent in an
   app-wide error budget, to fetch ~100× more than the benchmark reads.

   History cannot be skipped and left for `bench` to fetch lazily. The default
   pricing method is `hybrid`, which reads history, and `calculateRealisticPrice`
   *is* permitted to fetch history from ESI when it is missing
   (`market-pricing.js:346`). That would put network cost in the first run and
   not in later ones — precisely the run-to-run variance the offline design
   exists to eliminate. So it is fetched once, here, and warm before any
   measurement.

Everything else the sandbox needs it creates itself, including a default Market
Set pointing at Jita 4-4 / The Forge. (`recalculatePlanMaterials` throws without
one — pricing has no location to price against. On a normal install the
first-launch wizard supplies it; the benchmark does not run that wizard.)

The builder fails loudly rather than stamping a dataset that benchmarks nothing:

- **A plan with 0 material nodes** stops the build. The app logs the underlying
  cause (missing SDE, no Market Set) and *carries on*, so without an explicit
  check the failure is invisible until the numbers make no sense.
- **An empty market database** after the refresh stops the build, for the same
  reason — all-zero prices would look like a successful run.

It also reports **history coverage** at the end. Types with no history rows are
normally items that simply never trade (ESI returns an empty series), which is a
legitimate empty result rather than a gap; the count is recorded in
`generation.json` so a dataset's completeness stays inspectable.

Because history is seeded *after* the plans exist — the plans are what define
which types matter — the builder then re-locks every plan's prices so the frozen
values reflect the history-based methods rather than order-book-only
approximations.

### One at a time

`bench:build` and `bench` share the dataset directory — the builder writes it,
the runner copies it — so they are mutually exclusive. Starting one while the
other runs fails immediately:

```
[bench:build] another benchmark process is running: bench (pid 35182, 4s ago).
  Running both at once makes the runner copy a half-built dataset,
  which reports numbers that do not correspond to any real state.
```

That is not a theoretical hazard. An overlap produced a suite reporting 1,505
history types against a generation stamp claiming 1,859, and six types reading
zero rows that were plainly on disk afterwards — nothing was wrong with either
script; they simply ran at the same time.

The lock is advisory and self-healing: it records the owning PID, and a lock
whose process is gone is reported and taken over, so a crashed build never
leaves the benchmark permanently blocked. It is also released on Ctrl-C.

### What is committed, and what is not

Committed: **`tests/fixtures/bench/recipe.json`** — a small description of what
to build, naming blueprints by SDE typeID. No character data, no market data, no
databases.

Not committed (gitignored): `.bench-data/` (the built dataset — it holds real
character data and live ESI tokens), `.bench-sandbox/`, and `profiles/`.

This is why any developer can clone the repo, run `bench:build`, log in *their*
characters, and benchmark the same code paths.

> A developer who owns **none** of the recipe's blueprints still gets a valid
> run: `resolveOwnedBlueprint()` returns `null` for an unowned blueprint and the
> app falls back to ME 0 + built. Different numbers, same code paths.

### Comparability — read this before trusting a number

Benchmark results are comparable **within one build generation, on one machine**.

- ✅ Run, change code, run again, compare. This is the normal workflow and the
  numbers are trustworthy throughout it.
- ✅ Compare *relative* cost — which scenario dominates, how timings scale
  across the plan size ladder.
- ❌ Compare against another developer's numbers. Different characters own
  different blueprints and have different skills.
- ❌ Compare across a rebuild. `--compare` warns loudly when the two results
  carry different generation stamps.

Chasing cross-machine comparability would mean committing a full database
snapshot, which this design deliberately avoids.

### Typical session

```bash
npm run bench                                   # baseline
# ... make a performance change ...
npm run bench -- --compare profiles/bench-<timestamp>.json
```

```
recalculatePlanMaterials
  bench-xl-jumpfreighter    2.41s ->    890ms    -63.1%  FASTER
  bench-l-dread             740ms ->    301ms    -59.3%  FASTER
```

### Establish the noise floor first

Before believing any improvement, find out how much your machine varies. Run the
benchmark twice with **no** code changes and compare the two:

```bash
npm run bench -- --only recalc
npm run bench -- --only recalc --compare profiles/bench-<timestamp>.json
```

A measured example (same generation, no code change between runs):

```
bench-l-dread            187.2ms ->   186.7ms     -0.3%
bench-xl-jumpfreighter   105.3ms ->   100.5ms     -4.5%
bench-s-ammo               8.7ms ->     7.1ms    -18.4%
```

**Noise scales inversely with the size of the case.** The large plans are stable
to within a few percent; the small ones swing ±20% on nothing at all. So:

- Trust deltas on the **large** cases (`bench-l-*`, `bench-xl-*`).
- Treat a double-digit change on `bench-xs-caracal` or `bench-s-ammo` as noise
  unless `--repeat 5` reproduces it.
- Use `--repeat N` for anything you intend to act on. A single run also pays
  first-call warmup: the invention scenario measured 2.65s on run 1 and a p50 of
  1.32s over three.

### Scenarios

| Name | What it measures |
|---|---|
| `recalc` | `recalculatePlanMaterials` across the plan size ladder |
| `invention` | `findBestDecryptor` sweep, with and without the price cache |
| `materials` | `calculateBlueprintMaterials` cold vs warm (`materialTreeCache`) |
| `summary` | Manufacturing Summary full sweep |
| `wcib` | What Can I Build? full sweep (asset aggregation + pricing + SVR) |
| `assets` | Asset Manager **mount** cost: getAssets, SDE lookups, valuation |

Run one with `npm run bench -- --only recalc`.

**The size ladder is itself a measurement.** The recipe builds plans from ~8 to
~735 material nodes. If timings scale *linearly* with node count you have a
constant-factor problem; if they scale *super-linearly* you have an algorithmic
one. Those need completely different fixes, and the `ms/node` column in the
report tells you which you are looking at.

### Changing the dataset

Edit `tests/fixtures/bench/recipe.json`, then rebuild:

```bash
npm run bench:build -- --force
```

`bench` hashes the recipe and refuses to run against a stale dataset. It also
refuses when the database schema has moved on since the dataset was built
(comparing the applied migration id against the code's latest). Override with
`--allow-stale` when you know better.

Editing only `$comment` fields does **not** invalidate a dataset — documentation
changes should not force a rebuild.

---

## Part 3 — Renderer benchmarking (Asset Manager)

```bash
npm run bench:renderer                    # synthetic: 500 / 2000 / 5000 assets
npm run bench:renderer -- --real          # your real assets, real prices
npm run bench:renderer -- --assets 8000   # one synthetic size
```

**Two modes, because they find different bugs.** Both mount the *real* Asset
Manager view in jsdom and drive real interactions; they differ only in where
the data comes from.

| | synthetic (default) | `--real` |
|---|---|---|
| Assets | generated, any count | the dataset character's actual assets |
| Names / categories / volumes | fabricated | real SDE lookups |
| Prices | canned constant | real `calculateRealisticPrice` |
| Locations | fabricated | real resolution |
| Good for | scaling — how cost grows with row count, at sizes the real data doesn't reach | realism — messy cardinality, real ISK distribution, true mount cost |

`--real` runs inside Electron so it can use the app's own better-sqlite3
bindings and call the same main-process functions the IPC handlers call. Nothing
is snapshotted or replayed — it is the real data path, minus the IPC wire. It
uses the built dataset (`npm run bench:build`) on a disposable copy, so runs
stay repeatable.

Measured at the same row count (~2,390):

```
              synthetic     --real
  mount           1.90s      7.09s     real pricing + SDE + locations
  checkbox      689.8ms    775.9ms
  sort          688.8ms    795.2ms
  search        226.8ms    632.3ms
```

Interactions cost roughly the same either way — which is the point: the
renderer's per-click work is driven by row count, so synthetic is a valid and
much more scalable way to prove a `computeRows()` fix. **Mount** is where they
diverge, because that is where the real data path lives.

**Why this is a separate tool.** The main-process benchmark measures
calculation. The Asset Manager does almost none: the main process runs
`SELECT * FROM assets` and hands back rows (`esi-assets.js:203`). Its cost is in
the renderer — so it is measured there, by mounting the **real view** in jsdom
with a mocked IPC surface and timing actual interactions.

**What neither mode measures: layout and paint.** jsdom has no compositor, so
these numbers are the JavaScript half only — filtering, aggregating, sorting,
building DOM nodes. For real paint cost, use `npm run profile:trace` against the
running app and look for long RunTasks on a Renderer process.

In synthetic mode every IPC call is additionally stubbed, so pricing, SDE
lookups and location resolution appear free. Those costs are real; measure them
with `--real`, or main-process side with `npm run bench -- --only assets`.

Measured today:

```
   assets   checkbox       sort     search
      500    221.9ms    218.9ms     79.3ms
     2000    857.4ms    877.2ms    286.5ms
     5000      2.17s      2.21s    707.8ms
```

**Ticking one checkbox costs the same as a full re-sort.** That is the finding:
selection state should be nearly free, but `render()` rebuilds everything, and
`computeRows()` — an unmemoised filter + aggregate + sort — runs **4–5 times per
render** (`assets-view-renderer.js:534, 708, 847, 859, 1002`), from a `render()`
that fires at 29 call sites. Cost is linear in row count at ~0.43ms/row, so a
character with a full hangar pays seconds per click.

> jsdom retains every node it creates, so testing several sizes in one process
> can exhaust the heap. Sizes above ~5000 should be run one at a time with
> `--assets`.

## Worked example: the Manufacturing Summary sweep

The first real use of this tooling, kept here because the method generalises.

**Symptom:** the summary scenario took 22s for 244 rows (91ms/row), with the
price cache already avoiding 89% of DB reads. Wall-clock said "slow
calculation."

**CPU profile** (`npm run profile:cpu`) said otherwise:

```
total 25.0s | idle 16.0s (waiting on I/O) | busy CPU 9.0s
  better-sqlite3  7.1s   79% of busy CPU
  network/undici  0.3s
```

Attributing that SQLite time back to the calling code:

```
  4522ms  storeMarketHistory @ esi-market.js:560   <-- 63% of all SQLite time
   644ms  (anon) @ settings-manager.js:1219
   547ms  cachePriceCalculation @ market-pricing.js:573
```

`storeMarketHistory` is a **write** path — the sweep was fetching history for
**286 distinct types** from ESI mid-run and writing each one back. The 16s idle
was waiting on sequential HTTP; the 4.5s CPU was the writes.

**Is it a beachball?** Measured with an event-loop lag monitor during a real
sweep:

```
stalls: p50 1.0ms   p95 26.5ms   p99 46.0ms   max 305ms
>16ms (dropped frame): 126     >100ms: 4     >1000ms (beachball): 0
total time blocked >16ms: 4.7s
```

No freeze, but **persistent stutter**: one `storeMarketHistory` call blocks
4–20ms (synchronous better-sqlite3, ~375 row inserts, statement re-prepared per
call), and 304 of them add up to 126 dropped frames. This cost is **real in the
live app** — any user opening Manufacturing Summary on a cold cache pays it.

**Method worth reusing:** wall-clock told us *that* it was slow; the CPU profile
told us it was I/O plus write amplification, not calculation; the lag monitor
told us how it actually feels to a user. Three different questions, three
different tools.

## Safety: your live config is never touched

Benchmarks run the real application code, so isolation matters. The mechanism is
**prevention, not undo**:

`app.setPath('userData', <sandbox>)` redirects the entire app — settings,
`character-data.db`, `market_data.sqlite` — into a throwaway directory. This
mirrors how a Windows portable install keeps its config beside the executable.
There is deliberately **no backup/restore step**: a restore has to `rm -rf` the
real config first, so it introduces a way to destroy data that was never at risk.

Three guards make this airtight, because it can fail silently otherwise:

1. **`setPath` runs before any `src/main` require.** `config-migration.js`
   resolves the data path at *module load time* and caches it, and every
   database path derives from that one value. Require first and
   `app.getPath('userData')` reports the sandbox while the databases quietly
   open in your real config.
2. **A positive assertion after boot.** The harness calls `getConfigDir()` and
   **aborts** unless the resolved path is inside the sandbox.
3. **Proof by absence.** Every run censuses your live config's file mtimes
   before and after, and fails loudly if anything changed — even when the run
   itself failed.

If you ever see `*** LIVE CONFIG WAS MODIFIED - THIS IS A BUG ***`, stop and
report it; that message means guard 3 caught something guards 1 and 2 missed.

---

## Reference

| Path | What |
|---|---|
| `scripts/profile.js` | CDP driver — `--cpu`, `--trace`, `--heap`, `--attach` |
| `scripts/analyze-trace.js` | Beachball finder — long-task triage for a trace |
| `scripts/bench-build.js` | Dataset builder (networked) |
| `scripts/bench.js` | Scenario runner (offline) |
| `scripts/bench-renderer.js` | Renderer benchmark — mounts a view in jsdom |
| `scripts/lib/sandbox.js` | Data-path isolation + the ordering rule |
| `scripts/lib/cdp.js` | Minimal dependency-free CDP client |
| `scripts/lib/bench-common.js` | Paths, generation stamping, staleness rules |
| `tests/fixtures/bench/recipe.json` | The committed dataset recipe |

No new dependencies were added for any of this.
