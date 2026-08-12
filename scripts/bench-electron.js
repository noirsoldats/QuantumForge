'use strict';

/**
 * Electron-side benchmark scenarios. Spawned by scripts/bench.js.
 *
 * ORDERING RULE - see scripts/lib/sandbox.js. app.setPath('userData') MUST run
 * before any src/main require, or the app's databases open against the real
 * config while app.getPath() reports the sandbox.
 *
 * WHY WALL-CLOCK AND NOT JUST CPU
 * -------------------------------
 * A sampling CPU profile shows where CPU time goes, but several of the
 * suspected bottlenecks are latency-bound rather than CPU-bound - the
 * sequential `await calculateRealisticPrice` loop inside
 * recalculatePlanMaterials shows up as *idle* in a flame chart. So each
 * scenario reports wall-clock, and the pricing scenarios also surface
 * market-read-cache's own hit/miss counters rather than duplicating that
 * accounting.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const sandbox = require('./lib/sandbox');
const { PATHS, loadRecipe, readGeneration } = require('./lib/bench-common');

const SANDBOX = process.env.QF_BENCH_SANDBOX;
const OUT = process.env.QF_BENCH_OUT;
const OPTIONS = JSON.parse(process.env.QF_BENCH_OPTIONS || '{}');

// ---- must happen before any src/main require ----
sandbox.redirectUserData(app, SANDBOX);
// -------------------------------------------------

const REPEAT = Math.max(1, OPTIONS.repeat || 1);

function info(msg) {
  console.log(`[bench] ${msg}`);
}

/** Time one async call, in milliseconds. */
async function timeIt(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

/**
 * Run `fn` once and throw the timing away.
 *
 * Absorbs LOCAL first-call costs the later samples never see: lazy module
 * loads, the SDE connection opening, a cold OS page cache. Without it the first
 * sample lands as a misleading p95.
 *
 * NOT a fix for stale ESI history. A warm-up cannot help there: `bench` runs in
 * a DISPOSABLE sandbox copy, so anything re-fetched is discarded when the run
 * ends and the next run pays it again - measured at 424 ESI calls per run,
 * every run. Expired history is refreshed once in `bench:build` instead, and
 * `bench` refuses to run against a dataset whose history has aged out.
 */
async function warmup(fn) {
  try {
    await fn();
  } catch (_) {
    // A failing warm-up is not fatal; the measured runs will surface it.
  }
}

/** Plans in the sandbox, largest first - the size ladder. */
function sandboxPlans() {
  const { getCharacterDatabase } = require('../src/main/character-database');
  const db = getCharacterDatabase();
  return db
    .prepare(
      `SELECT p.plan_id AS planId, p.plan_name AS name,
              (SELECT COUNT(*) FROM plan_material_nodes n WHERE n.plan_id = p.plan_id) AS nodes
         FROM manufacturing_plans p
        ORDER BY nodes DESC`
    )
    .all();
}

/**
 * Scenario 1 - recalculatePlanMaterials across the size ladder.
 *
 * The heaviest path in the app: one ~1,520-line function holding a single
 * SQLite transaction, calling the recursive material engine per blueprint and
 * then pricing every node with sequential awaits. Run across plan sizes because
 * the SHAPE of the scaling is the diagnosis - linear against node count points
 * at a constant factor, super-linear points at an algorithm (the reverse linear
 * scans at manufacturing-plans.js:3495,3682 are the live suspect).
 */
async function scenarioRecalc() {
  const { recalculatePlanMaterials } = require('../src/main/manufacturing-plans');
  const plans = sandboxPlans();
  if (plans.length === 0) throw new Error('no plans in the dataset');

  const { clearMaterialCache } = require('../src/main/blueprint-calculator');

  const cases = [];
  for (const plan of plans) {
    const samples = [];
    for (let i = 0; i < REPEAT; i++) {
      // Clear the module-level materialTreeCache before EVERY sample. Plans in
      // the ladder share sub-trees (every capital wants the same components),
      // so without this a plan measured after a larger one is scored on the
      // larger one's cache and the ladder stops being comparable.
      clearMaterialCache();

      // refreshPrices=false: prices are already locked in the dataset, and this
      // keeps the scenario measuring calculation rather than price refresh.
      const { ms } = await timeIt(() => recalculatePlanMaterials(plan.planId, false));
      samples.push(ms);
    }
    cases.push({
      label: plan.name,
      samples,
      notes: `${plan.nodes} nodes`,
      nodes: plan.nodes,
    });
    info(`  ${plan.name}: ${samples[0].toFixed(0)}ms (${plan.nodes} nodes)`);
  }

  // Cost per node makes the scaling shape readable at a glance.
  for (const c of cases) {
    if (c.nodes > 0) {
      const perNode = c.samples.reduce((a, b) => a + b, 0) / c.samples.length / c.nodes;
      c.notes += `, ${perNode.toFixed(2)}ms/node`;
    }
  }

  return { name: 'recalculatePlanMaterials', detail: 'size ladder', cases };
}

/**
 * Scenario 2 - the invention decryptor sweep.
 *
 * market-read-cache.js documents this as ~198 calculateRealisticPrice calls for
 * ~11 distinct items. Measured both with and without the price-cache session so
 * the cache's real contribution is visible rather than assumed.
 */
async function scenarioInvention() {
  const recipe = loadRecipe();
  const blueprintTypeId = recipe.invention.blueprintTypeId;

  const {
    getInventionData,
    findBestDecryptor,
    getDefaultFacility,
    clearMaterialCache,
  } = require('../src/main/blueprint-calculator');
  const { withPriceCache, getStats } = require('../src/main/market-read-cache');
  const { getDefaultMarketSet } = require('../src/main/settings-manager');

  const inventionData = getInventionData(blueprintTypeId);
  if (!inventionData) throw new Error(`no invention data for blueprint ${blueprintTypeId}`);

  const facility = getDefaultFacility();
  const marketSet = getDefaultMarketSet();
  const cases = [];

  /*
   * BOTH CASES MUST START FROM A CLEARED materialTreeCache.
   *
   * findBestDecryptor -> calculateManufacturingCost -> calculateBlueprintMaterials,
   * which is memoised in a MODULE-LEVEL Map. Without clearing it between the
   * two cases, the first run populates it and the second measures cache hits -
   * which produced a nonsensical "no price cache is 700x faster than with it"
   * on the first real run of this benchmark. The two caches are independent and
   * only one of them is under test here.
   */

  // Discarded warm-up: absorbs the SDE connection opening and lazy module
  // loads, which showed as a 6.1s first sample against a 1.33s p50. With a
  // fresh dataset this touches no network - and `bench` refuses to run against
  // a dataset whose history has expired, so it cannot become an ESI sweep.
  clearMaterialCache();
  await warmup(() =>
    withPriceCache(
      () => findBestDecryptor(inventionData, {}, 0, {}, facility, 'total-per-item', marketSet),
      'bench invention warmup'
    )
  );

  // With the price-cache session - how the app actually calls it (main.js:1891).
  const cached = [];
  let stats = null;
  for (let i = 0; i < REPEAT; i++) {
    clearMaterialCache();
    const { ms } = await timeIt(() =>
      withPriceCache(async () => {
        const r = await findBestDecryptor(
          inventionData, {}, 0, {}, facility, 'total-per-item', marketSet
        );
        stats = getStats();
        return r;
      }, 'bench invention sweep')
    );
    cached.push(ms);
  }
  const hits = stats ? stats.orderHits + stats.historyHits : 0;
  const misses = stats ? stats.orderMisses + stats.historyMisses : 0;
  cases.push({
    label: 'with price cache',
    samples: cached,
    notes: stats ? `${hits} hits / ${misses} reads` : '',
  });

  // Without the session - the DB reads the price cache is avoiding.
  const uncached = [];
  for (let i = 0; i < REPEAT; i++) {
    clearMaterialCache();
    const { ms } = await timeIt(() =>
      findBestDecryptor(inventionData, {}, 0, {}, facility, 'total-per-item', marketSet)
    );
    uncached.push(ms);
  }
  cases.push({ label: 'no price cache', samples: uncached, notes: 'price cache bypassed' });

  return { name: 'findBestDecryptor', detail: recipe.invention.blueprintName, cases };
}

/**
 * Scenario 3 - calculateBlueprintMaterials, cold vs warm.
 *
 * Exercises materialTreeCache both ways. The cache is only consulted at
 * depth 0, so the warm number is a pure cache hit and the gap between them is
 * the true cost of a full recursive tree walk.
 */
async function scenarioMaterials() {
  const recipe = loadRecipe();
  const {
    calculateBlueprintMaterials,
    clearMaterialCache,
  } = require('../src/main/blueprint-calculator');

  // Largest blueprint in the recipe - the deepest tree.
  const specs = recipe.plans.flatMap((p) => p.blueprints);
  const target = specs[specs.length - 1];

  const cold = [];
  const warm = [];

  for (let i = 0; i < REPEAT; i++) {
    clearMaterialCache();
    const c = await timeIt(() =>
      calculateBlueprintMaterials(target.typeId, target.runs, target.me, null, null, true)
    );
    cold.push(c.ms);

    const w = await timeIt(() =>
      calculateBlueprintMaterials(target.typeId, target.runs, target.me, null, null, true)
    );
    warm.push(w.ms);
  }

  return {
    name: 'calculateBlueprintMaterials',
    detail: target.name,
    cases: [
      { label: 'cold (cache cleared)', samples: cold, notes: 'full recursive walk' },
      { label: 'warm (cached)', samples: warm, notes: 'materialTreeCache hit' },
    ],
  };
}

/**
 * Scenario 4 - Manufacturing Summary sweep.
 *
 * Prices hundreds of blueprints with heavily overlapping material lists, which
 * is why the app wraps it in a price-cache session (main.js:2161).
 */
async function scenarioSummary() {
  const { calculateSummary } = require('../src/main/manufacturing-summary');
  const { withPriceCache } = require('../src/main/market-read-cache');

  const samples = [];
  let rows = 0;
  for (let i = 0; i < REPEAT; i++) {
    const { ms, value } = await timeIt(() =>
      withPriceCache(() => calculateSummary({}, () => {}), 'bench summary')
    );
    samples.push(ms);
    rows = Array.isArray(value) ? value.length : 0; // calculateSummary returns an array
  }

  return {
    name: 'manufacturingSummary',
    cases: [{ label: 'full sweep', samples, notes: `${rows} rows` }],
  };
}

/**
 * Scenario 5 - What Can I Build? sweep.
 *
 * Same shape as the summary (many blueprints, overlapping material lists, one
 * price-cache session - main.js:1705), but it additionally computes SVR per
 * product, which reads market history. Worth measuring separately because the
 * asset aggregation step is unique to it: it walks the character's whole asset
 * list before any pricing happens.
 */
async function scenarioWcib() {
  const { calculate } = require('../src/main/what-can-i-build');
  const { withPriceCache } = require('../src/main/market-read-cache');
  const { getDefaultCharacter } = require('../src/main/settings-manager');

  const character = getDefaultCharacter();
  const characterId = character && character.characterId;

  /*
   * assetSources are SOURCE DESCRIPTORS, not assets.
   *
   * aggregateAssets (cleanup-tool.js:159) reads each source's assets from the
   * database itself - `personal` is [{ characterId }] and `corporation` is
   * [{ characterId, divisions }]. Passing the actual asset arrays (as a first
   * pass here did) makes it treat every one of ~2,390 asset objects as a
   * source and call getAssets() for each, which showed up in the profile as
   * 5.5s of SQLite inside getAssets alone.
   */
  const assetSources = {
    personal: characterId ? [{ characterId }] : [],
    corporation: characterId ? [{ characterId, divisions: [] }] : [],
  };

  const samples = [];
  let rows = 0;
  let assetTypes = 0;
  for (let i = 0; i < REPEAT; i++) {
    const { ms, value } = await timeIt(() =>
      withPriceCache(() => calculate({ assetSources, characterId }, () => {}), 'bench wcib')
    );
    samples.push(ms);
    // calculate() returns an ENVELOPE - { cancelled, rows, assetTypeCount } -
    // not a bare array like calculateSummary does.
    rows = (value && value.rows && value.rows.length) || 0;
    assetTypes = (value && value.assetTypeCount) || 0;
  }

  return {
    name: 'whatCanIBuild',
    cases: [
      {
        label: 'full sweep',
        samples,
        notes: `${rows} buildable rows from ${assetTypes} asset types`,
      },
    ],
  };
}

/**
 * Scenario 6 - Asset Manager mount cost, main-process half.
 *
 * The Asset Manager's per-interaction cost is renderer-side and is measured by
 * scripts/bench-renderer.js. But its MOUNT does real main-process work, and
 * that work is invisible to a jsdom benchmark because the harness stubs it:
 *
 *   getAssets           one query, then a row-mapper over every asset
 *   sde.getTypeNames    batched SDE lookup
 *   getTypeCategoryInfo batched SDE lookup
 *   getItemVolumes      batched SDE lookup
 *   calculatePrices     SEQUENTIAL calculateRealisticPrice per distinct type
 *
 * calculatePrices is the interesting one: main.js:2282 loops the deduped type
 * list one at a time, so its cost scales with how many DISTINCT types the
 * character holds - the number this scenario reports.
 */
async function scenarioAssetsMount() {
  const { getAssets } = require('../src/main/esi-assets');
  const { getDefaultCharacter } = require('../src/main/settings-manager');
  const { calculateRealisticPrice } = require('../src/main/market-pricing');
  const { getDefaultMarketSet } = require('../src/main/settings-manager');
  const { withPriceCache } = require('../src/main/market-read-cache');
  const sde = require('../src/main/sde-database');

  const character = getDefaultCharacter();
  if (!character) throw new Error('no default character in the dataset');
  const characterId = character.characterId;

  const cases = [];

  // 1. Load + map every asset row.
  const loadSamples = [];
  let assets = [];
  for (let i = 0; i < REPEAT; i++) {
    const { ms, value } = await timeIt(async () => getAssets(characterId, false) || []);
    loadSamples.push(ms);
    assets = value;
  }
  const typeIds = [...new Set(assets.map((a) => a.typeId))];
  cases.push({
    label: 'getAssets',
    samples: loadSamples,
    notes: `${assets.length} assets, ${typeIds.length} distinct types`,
  });

  // 2. The three batched SDE lookups the view makes on mount.
  //    Warmed: the first call opens the SDE connection and pays its page-cache
  //    miss, which is startup cost rather than query cost.
  await warmup(async () => {
    await sde.getTypeNames(typeIds);
    await sde.getTypeCategoryInfo(typeIds);
    await sde.getItemVolumes(typeIds);
  });

  const sdeSamples = [];
  for (let i = 0; i < REPEAT; i++) {
    const { ms } = await timeIt(async () => {
      await sde.getTypeNames(typeIds);
      await sde.getTypeCategoryInfo(typeIds);
      await sde.getItemVolumes(typeIds);
    });
    sdeSamples.push(ms);
  }
  cases.push({
    label: 'SDE lookups (3 batched)',
    samples: sdeSamples,
    notes: `${typeIds.length} types`,
  });

  // 3. Valuation. This is the sequential loop, and the reason a full hangar is
  //    slow to price. skipHistory mirrors what the Assets screen passes.
  const marketSet = getDefaultMarketSet();
  const settings = (marketSet && marketSet.inputMaterials) || {};

  const priceSamples = [];
  for (let i = 0; i < REPEAT; i++) {
    const { ms } = await timeIt(() =>
      withPriceCache(async () => {
        for (const typeId of typeIds) {
          await calculateRealisticPrice(
            typeId,
            settings.regionId,
            settings.locationId,
            'sell',
            1,
            settings,
            { skipHistory: true }
          );
        }
      }, 'bench assets valuation')
    );
    priceSamples.push(ms);
  }
  cases.push({
    label: 'calculatePrices',
    samples: priceSamples,
    notes: `${typeIds.length} types, sequential`,
  });

  return { name: 'assetManagerMount', detail: 'main-process half', cases };
}

/**
 * Scenario 7 - opening a plan.
 *
 * `recalc` measures the WRITE path, which runs on a blueprint edit. This is the
 * READ path, which runs every time a plan is opened - far more often.
 *
 * Mirrors what the renderer actually does (manufacturing-plans-view-renderer.js):
 *   on open      getSummary + getMaterials, in parallel  (:829)
 *   then         getMaterialDrift                        (:877)
 *   Analytics tab getAnalytics                           (:3445)
 *
 * getMaterialDrift is the one to watch: it prices every material in the plan
 * with a sequential `await calculateRealisticPrice`, and its IPC handler
 * (main.js:1468) opens NO withPriceCache session - unlike the summary and
 * invention handlers. Materials within a plan overlap heavily, so this scenario
 * exists to measure that gap before it is closed.
 */
async function scenarioPlanOpen() {
  const {
    getPlanSummary,
    getPlanMaterials,
    getPlanMaterialDrift,
    getPlanAnalytics,
  } = require('../src/main/manufacturing-plans');
  const { getDefaultMarketSet } = require('../src/main/settings-manager');
  const { withPriceCache, getStats } = require('../src/main/market-read-cache');

  const plans = sandboxPlans();
  if (plans.length === 0) throw new Error('no plans in the dataset');

  // The largest plan - the read path's worst case.
  const plan = plans[0];
  const marketSet = getDefaultMarketSet();
  const cases = [];

  // 1. The parallel pair the view issues on open.
  const openSamples = [];
  for (let i = 0; i < REPEAT; i++) {
    const { ms } = await timeIt(() =>
      Promise.all([
        getPlanSummary(plan.planId),
        getPlanMaterials(plan.planId, false),
      ])
    );
    openSamples.push(ms);
  }
  cases.push({
    label: 'getSummary + getMaterials',
    samples: openSamples,
    notes: `${plan.nodes} nodes, parallel`,
  });

  // 2. Drift, exactly as the app calls it: no price-cache session.
  const driftSamples = [];
  for (let i = 0; i < REPEAT; i++) {
    const { ms } = await timeIt(() => getPlanMaterialDrift(plan.planId, marketSet));
    driftSamples.push(ms);
  }
  cases.push({
    label: 'getMaterialDrift (as shipped)',
    samples: driftSamples,
    notes: 'no withPriceCache session',
  });

  // 3. The same call INSIDE a session - what finding 5 proposes. Measured here
  //    so the fix can be judged against a number rather than an assumption.
  const driftCached = [];
  let stats = null;
  for (let i = 0; i < REPEAT; i++) {
    const { ms } = await timeIt(() =>
      withPriceCache(async () => {
        const r = await getPlanMaterialDrift(plan.planId, marketSet);
        stats = getStats();
        return r;
      }, 'bench plan drift')
    );
    driftCached.push(ms);
  }
  const hits = stats ? stats.orderHits + stats.historyHits : 0;
  const misses = stats ? stats.orderMisses + stats.historyMisses : 0;
  cases.push({
    label: 'getMaterialDrift (with cache)',
    samples: driftCached,
    notes: stats ? `${hits} hits / ${misses} reads` : '',
  });

  // 4. Analytics tab.
  const analyticsSamples = [];
  for (let i = 0; i < REPEAT; i++) {
    const { ms } = await timeIt(() => getPlanAnalytics(plan.planId));
    analyticsSamples.push(ms);
  }
  cases.push({
    label: 'getAnalytics',
    samples: analyticsSamples,
    notes: 'summary + ledger',
  });

  return { name: 'planOpen', detail: plan.name, cases };
}

const SCENARIOS = {
  recalc: scenarioRecalc,
  invention: scenarioInvention,
  materials: scenarioMaterials,
  summary: scenarioSummary,
  wcib: scenarioWcib,
  assets: scenarioAssetsMount,
  planopen: scenarioPlanOpen,
};

async function main() {
  const paths = sandbox.assertSandboxed(app, SANDBOX);
  info(`sandbox: ${paths.configDir}`);

  // Databases must be opened the same way the app opens them.
  const { initializeCharacterDatabase } = require('../src/main/character-database');
  initializeCharacterDatabase();
  const { initializeMarketDatabase } = require('../src/main/market-database');
  initializeMarketDatabase();

  const chosen = OPTIONS.only
    ? { [OPTIONS.only]: SCENARIOS[OPTIONS.only] }
    : SCENARIOS;

  if (OPTIONS.only && !SCENARIOS[OPTIONS.only]) {
    throw new Error(`unknown scenario "${OPTIONS.only}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
  }

  // Hold before doing any work so an external profiler has time to attach and
  // start recording. Without this a scenario can finish before the attach
  // lands, and the profile is all (idle).
  if (OPTIONS.waitBeforeRun) {
    info(`waiting ${OPTIONS.waitBeforeRun}ms for a profiler to attach...`);
    await new Promise((resolve) => setTimeout(resolve, OPTIONS.waitBeforeRun));
    info('starting scenarios');
  }

  const scenarios = [];
  for (const [key, fn] of Object.entries(chosen)) {
    info(`running scenario: ${key}`);
    try {
      scenarios.push(await fn());
    } catch (err) {
      // One failing scenario must not lose the others' results.
      console.error(`[bench] scenario ${key} failed: ${err.message}`);
      scenarios.push({ name: key, error: err.message, cases: [] });
    }
  }

  const result = {
    generation: readGeneration(),
    ranAt: Date.now(),
    repeat: REPEAT,
    host: {
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      electron: process.versions.electron,
      cpus: require('os').cpus().length,
    },
    scenarios,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  info(`wrote ${path.relative(PATHS.root, OUT)}`);

  app.exit(0);
}

app.on('ready', () => {
  main().catch((err) => {
    console.error(`\n[bench] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    app.exit(1);
  });
});

app.on('window-all-closed', () => { /* no windows; keep running */ });
