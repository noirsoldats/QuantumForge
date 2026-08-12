'use strict';

/**
 * Electron-side benchmark dataset builder. Spawned by scripts/bench-build.js.
 *
 * THE ORDERING RULE - DO NOT REORDER THE TOP OF THIS FILE.
 * -------------------------------------------------------
 * `app.setPath('userData', ...)` MUST run before any `src/main` module is
 * required. config-migration.js resolves the data path at MODULE LOAD TIME and
 * caches it, and every database path in the app derives from that one value. If
 * a src/main module is required first, `app.getPath('userData')` reports the
 * sandbox while the databases quietly open in the developer's REAL config
 * directory. assertSandboxed() below turns that into a loud abort, but the
 * ordering here is what prevents it in the first place.
 */

const { app, shell, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const sandbox = require('./lib/sandbox');
const {
  PATHS,
  loadRecipe,
  recipeHash,
  latestSchemaMigrationId,
  lastHistoryCutoff,
  writeGeneration,
} = require('./lib/bench-common');

const DATASET = process.env.QF_BENCH_DATASET || PATHS.dataset;
/** Stashed copy of the previous dataset, for carrying characters across. */
const PREVIOUS = process.env.QF_BENCH_PREVIOUS || null;

// ---- must happen before any src/main require ----
sandbox.redirectUserData(app, DATASET);
// -------------------------------------------------

/** Console helper that stands out amid the app's own logging. */
function step(msg) {
  console.log(`\n[build] === ${msg} ===`);
}

function info(msg) {
  console.log(`[build] ${msg}`);
}

/**
 * Copy the SDE into the sandbox.
 *
 * The sandbox starts empty, but the SDE is not something the benchmark should
 * build: it is a static 55MB read-only database that the app downloads from
 * Fuzzwork. Re-downloading it on every rebuild would be slow and pointless, so
 * the developer's existing copy is reused.
 *
 * COPIED rather than symlinked. A symlink would read fine, but the SDE updater
 * deletes and replaces this path, and a sandbox that can reach the real file at
 * all is a sandbox that can be wrong about it. 55MB on a rarely-run command is
 * a fair price for that being unambiguous.
 */
function seedSDE() {
  const liveSde = path.join(sandbox.getLiveUserDataPath(), 'sde', 'eve-sde.db');
  const sandboxSdeDir = path.join(DATASET, 'sde');
  const sandboxSde = path.join(sandboxSdeDir, 'eve-sde.db');

  if (fs.existsSync(sandboxSde)) {
    info('SDE already present in the sandbox');
    return;
  }

  if (!fs.existsSync(liveSde)) {
    throw new Error(
      'no SDE found to copy from.\n' +
      `  looked for: ${liveSde}\n` +
      '  Run Quantum Forge normally once and let it download the SDE, then retry.'
    );
  }

  fs.mkdirSync(sandboxSdeDir, { recursive: true });
  const sizeMb = (fs.statSync(liveSde).size / 1024 / 1024).toFixed(0);
  info(`copying SDE (${sizeMb}MB) into the sandbox...`);
  fs.copyFileSync(liveSde, sandboxSde);

  // version.txt/source.txt travel with it so the app does not think the SDE is
  // missing or of unknown provenance.
  for (const name of ['version.txt', 'source.txt']) {
    const from = path.join(sandbox.getLiveUserDataPath(), 'sde', name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(sandboxSdeDir, name));
  }
  info('SDE ready');
}

/**
 * Ensure a default Market Set exists.
 *
 * recalculatePlanMaterials THROWS without one ("no Market Set configured") -
 * pricing has no location to price against. A normal install gets this from the
 * first-launch wizard, which the benchmark deliberately does not run, so the
 * builder creates the same default the template describes: Jita 4-4 / The Forge.
 */
function ensureMarketSet() {
  const { getMarketSets, addMarketSet } = require('../src/main/settings-manager');

  const existing = getMarketSets() || [];
  if (existing.length > 0) {
    info(`market set already configured: ${existing[0].name}`);
    return existing[0];
  }

  // addMarketSet merges over DEFAULT_MARKET_SET_TEMPLATE, which already points
  // at Jita 4-4 (60003760) in The Forge (10000002) - the same reference market
  // the recipe names.
  const set = addMarketSet({ name: 'Benchmark (Jita)', isDefault: true });
  info(`created default market set: ${set && set.name}`);
  return set;
}

/**
 * ESI-sourced, character-scoped tables that can be carried across a rebuild.
 *
 * Deliberately excludes every plan_* table and manufacturing_plans: those are
 * built FROM the recipe by today's application code, and carrying them would
 * defeat the point of rebuilding. Only data that came from ESI - and would
 * otherwise cost a fresh login plus a re-fetch - travels.
 */
const CARRY_TABLES = [
  'characters',
  'skills',
  'skills_metadata',
  'blueprints',
  'blueprint_overrides',
  'skill_overrides',
  'assets',
  'character_settings',
];

/**
 * Copy character data out of the previous dataset into the new sandbox.
 *
 * Rebuilding is normally a full re-onboard: log in, re-fetch skills,
 * blueprints and assets. That is slow and, more to the point, needless when
 * the previous dataset's refresh tokens are still valid - the app refreshes an
 * expired access token automatically on first use.
 *
 * Returns the carried characters, or null when there is nothing usable.
 */
function carryCharacterData(previousDir) {
  const previousDb = path.join(previousDir, 'config', 'character-data.db');
  if (!fs.existsSync(previousDb)) {
    info('no previous dataset to carry characters from');
    return null;
  }

  const { getCharacterDatabase } = require('../src/main/character-database');
  const db = getCharacterDatabase();

  // ATTACH is the cleanest way to move rows between two SQLite files without
  // hand-rolling a row-by-row copy that would drift as columns are added.
  db.exec(`ATTACH DATABASE '${previousDb.replace(/'/g, "''")}' AS prev`);

  let characters = [];
  try {
    const prevChars = db.prepare('SELECT * FROM prev.characters').all();
    if (prevChars.length === 0) {
      info('previous dataset has no characters');
      return null;
    }

    // Refuse to carry a character whose refresh token is gone - it cannot be
    // revived, and carrying it would produce confusing auth failures later.
    const usable = prevChars.filter((c) => c.refresh_token);
    if (usable.length === 0) {
      info('previous characters have no refresh tokens; a fresh login is needed');
      return null;
    }

    const copied = [];
    for (const table of CARRY_TABLES) {
      // A table may not exist in an older dataset; skip rather than abort.
      const exists = db
        .prepare("SELECT name FROM prev.sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      if (!exists) continue;

      // Column intersection, so a schema change between builds cannot break
      // the copy - carried columns are the ones both schemas agree on.
      const newCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const oldCols = db.prepare(`PRAGMA prev.table_info(${table})`).all().map((c) => c.name);
      const shared = newCols.filter((c) => oldCols.includes(c));
      if (shared.length === 0) continue;

      const cols = shared.map((c) => `"${c}"`).join(', ');
      const result = db
        .prepare(`INSERT OR REPLACE INTO ${table} (${cols}) SELECT ${cols} FROM prev.${table}`)
        .run();
      if (result.changes > 0) copied.push(`${table}:${result.changes}`);
    }

    info(`carried ${copied.join(' ')}`);

    const { getCharacters } = require('../src/main/settings-manager');
    characters = getCharacters() || [];

    for (const c of characters) {
      const expired = c.expiresAt && c.expiresAt < Date.now();
      info(`  ${c.characterName} (token ${expired ? 'expired - will refresh on use' : 'valid'})`);
    }
  } finally {
    db.exec('DETACH DATABASE prev');
  }

  return characters.length > 0 ? characters : null;
}

/**
 * Ask the user to log in, once per character, until they say they are done.
 * Uses the app's real OAuth flow so the dataset is populated exactly as a
 * normal install would be.
 */
async function onboardCharacters() {
  const { authenticateWithESI } = require('../src/main/esi-auth');
  const { addCharacter, getCharacters } = require('../src/main/settings-manager');

  for (;;) {
    // getCharacters() returns rows mapped to characterName (NOT `name`).
    const existing = getCharacters() || [];
    const names = existing.map((c) => c.characterName || c.characterId).join(', ') || '(none yet)';

    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Benchmark dataset',
      message: existing.length === 0 ? 'Log in a character' : 'Add another character?',
      detail:
        `The benchmark needs at least one real character so blueprint and skill ` +
        `volumes are representative.\n\nLogged in so far: ${names}\n\n` +
        `Your real Quantum Forge config is NOT being used or modified.`,
      buttons: existing.length === 0 ? ['Log in', 'Cancel'] : ['Add another', 'Done'],
      defaultId: 0,
      cancelId: existing.length === 0 ? 1 : 1,
    });

    if (response === 1) {
      if (existing.length === 0) throw new Error('cancelled before any character was added');
      return existing;
    }

    info('opening the EVE SSO login in your browser...');
    // authenticateWithESI resolves {...tokenResponse, character}; addCharacter
    // takes that whole envelope and reads .character.characterId off it.
    const result = await authenticateWithESI();
    const ok = addCharacter(result);
    if (!ok) throw new Error('failed to save the authenticated character');
    info(`added character: ${result.character && result.character.characterName}`);
  }
}

/** Fetch the per-character data the calculation paths read. */
async function populateCharacters(characters) {
  const { fetchCharacterSkills } = require('../src/main/esi-skills');
  const { fetchCharacterBlueprints } = require('../src/main/esi-blueprints');
  const { fetchCharacterAssets, saveAssets } = require('../src/main/esi-assets');
  const { updateCharacterSkills, updateCharacterBlueprints } = require('../src/main/settings-manager');

  for (const character of characters) {
    const id = character.characterId;
    info(`fetching data for ${character.characterName || id}`);

    // Each fetch mirrors the app's own handler: fetch, respect a gated result,
    // then persist through the same function the app uses.
    // `skills.skills` is a MAP keyed by skill id, not an array.
    const skills = await fetchCharacterSkills(id);
    if (!skills.skipped) {
      updateCharacterSkills(id, skills);
      info(`  skills: ${Object.keys(skills.skills || {}).length}`);
    }

    const blueprints = await fetchCharacterBlueprints(id);
    if (!blueprints.skipped) {
      updateCharacterBlueprints(id, blueprints);
      info(`  blueprints: ${(blueprints.blueprints || []).length}`);
    }

    try {
      // saveAssets takes the WHOLE envelope from fetchCharacterAssets - it
      // reads .characterId / .isCorporation off it and refuses a gated fetch
      // itself (a gated result is an empty list, and the save is a
      // delete-then-insert). Passing just the array would wipe the table.
      const assets = await fetchCharacterAssets(id);
      if (assets && !assets.skipped) {
        saveAssets(assets);
        info(`  assets: ${assets.assets.length}`);
      }
    } catch (err) {
      // Assets feed some scenarios but are not required to build plans.
      info(`  assets: skipped (${err.message})`);
    }
  }
}

/**
 * Fetch the region's ORDER BOOK.
 *
 * Without this the sandbox market database is empty, every price resolves to
 * zero, and the pricing paths - among the main things being measured - do
 * almost no work. calculateVWAP, calculatePercentilePrice, removeOutliers and
 * getBestPriceWithMinVolume all branch on order-book shape, so a benchmark
 * against an empty book exercises the wrong branches.
 *
 * One bulk call per region (the same one the Market screen's refresh button
 * makes), so this is cheap in ESI terms however many types it covers.
 */
async function seedMarketOrders(recipe) {
  const { manualRefreshMarketData } = require('../src/main/esi-market');

  const regionId = (recipe.market && recipe.market.regionId) || 10000002;
  const regionName = (recipe.market && recipe.market.regionName) || String(regionId);

  info(`fetching market orders for ${regionName} (${regionId})...`);
  const orders = await manualRefreshMarketData(regionId);
  if (orders.success) {
    info('  orders: fetched');
  } else if (orders.rateLimited) {
    // Cached data is fine; the point is that the book is populated.
    info(`  orders: ${orders.message}`);
  } else {
    throw new Error(`market order fetch failed: ${orders.error || 'unknown error'}`);
  }

  const { getMarketDatabase } = require('../src/main/market-database');
  const db = getMarketDatabase();
  const count = db.prepare('SELECT COUNT(*) AS n FROM market_orders').get();
  info(`market database: ${count ? count.n : 0} orders`);

  if (!count || count.n === 0) {
    throw new Error(
      'the market database is empty after the refresh.\n' +
      '  Prices would all resolve to zero and the pricing scenarios would\n' +
      '  measure nothing, so the build is stopping here.'
    );
  }
}

/**
 * Fetch market HISTORY for only the types the dataset actually touches.
 *
 * WHY NOT manualRefreshHistoryData(regionId)
 * ------------------------------------------
 * History is one ESI call PER TYPE, throttled 100ms apart. The region-wide
 * refresh loops over every type with an order in the region - 19,137 in The
 * Forge - which is over half an hour of sequential requests and a serious dent
 * in an app-wide error budget, to fetch ~100x more data than the benchmark
 * reads.
 *
 * WHY NOT LET bench FETCH IT LAZILY
 * ---------------------------------
 * Because that would break the guarantee the whole two-command split exists to
 * provide. If `bench` fetched history on demand, the first run would pay
 * network cost that later runs would not, and a run-to-run delta would stop
 * being a code delta. Pricing methods 'hybrid' and 'historical' read history
 * inline, so it has to be present and warm BEFORE measurement starts.
 *
 * So: fetch exactly the types the built plans reference, once, here.
 */
async function seedMarketHistory(recipe) {
  const { fetchMarketHistory } = require('../src/main/esi-market');
  const { getCharacterDatabase } = require('../src/main/character-database');
  const { getMarketDatabase } = require('../src/main/market-database');

  const regionId = (recipe.market && recipe.market.regionId) || 10000002;

  // Every type any plan references: materials, intermediates and products.
  const charDb = getCharacterDatabase();
  const rows = charDb.prepare('SELECT DISTINCT type_id AS typeId FROM plan_material_nodes').all();
  const typeIds = rows.map((r) => r.typeId).filter(Boolean);

  if (typeIds.length === 0) {
    throw new Error('no types found in the built plans - cannot seed history');
  }

  info(`fetching history for ${typeIds.length} types (~${Math.ceil(typeIds.length / 6)}s)...`);

  let fetched = 0;
  let failed = 0;
  for (const typeId of typeIds) {
    try {
      // forceRefresh: false. fetchMarketHistory does its own staleness check
      // (isHistoryStale -> the 11:05 UTC rule) and returns cached rows when
      // they are still current, so a refresh pass only spends ESI calls on
      // types that genuinely expired. Forcing here would re-download every
      // type on every rebuild.
      await fetchMarketHistory(regionId, typeId, false);
      fetched++;
    } catch (err) {
      // One dead type must not lose the whole build.
      failed++;
    }
    // Same 100ms spacing the app's own sweep uses.
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (fetched % 25 === 0 && fetched > 0) {
      info(`  ${fetched}/${typeIds.length}`);
    }
  }

  // Refresh anything ELSE in the database that has aged past the 11:05 UTC
  // cutoff. A rebuild carries the previous dataset's market data forward, so
  // without this the summary/asset types stay stale and `bench` refuses to run
  // even on a freshly rebuilt dataset.
  const marketDb = getMarketDatabase();
  const cutoff = lastHistoryCutoff();
  const staleTypes = marketDb
    .prepare(
      `SELECT type_id AS t FROM market_history
        WHERE region_id = ?
        GROUP BY type_id
       HAVING MAX(fetched_at) < ?`
    )
    .all(regionId, cutoff.getTime())
    .map((r) => r.t)
    .filter((t) => !typeIds.includes(t));

  if (staleTypes.length > 0) {
    info(`refreshing ${staleTypes.length} expired types (~${Math.ceil(staleTypes.length / 6)}s)...`);
    let refreshed = 0;
    for (const typeId of staleTypes) {
      try {
        await fetchMarketHistory(regionId, typeId, false);
        refreshed++;
      } catch (_) {
        /* keep going */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (refreshed % 100 === 0 && refreshed > 0) info(`  ${refreshed}/${staleTypes.length}`);
    }
    info(`refreshed ${refreshed} expired types`);
  }

  const count = marketDb.prepare('SELECT COUNT(*) AS n FROM market_history').get();
  info(`history: ${fetched} types fetched${failed ? `, ${failed} failed` : ''}, ${count ? count.n : 0} rows`);

  // Coverage check. calculateRealisticPrice MAY fetch history from ESI when it
  // is missing (market-pricing.js:346 - "HISTORY is the exception and may be
  // fetched"), and 'hybrid' - the market-set default - reads it. A type left
  // uncovered would therefore make a network call during the FIRST bench run
  // and not on later ones, which is exactly the run-to-run variance the
  // offline design exists to eliminate. Report it rather than let it hide.
  const covered = new Set(
    marketDb
      .prepare('SELECT DISTINCT type_id AS typeId FROM market_history WHERE region_id = ?')
      .all(regionId)
      .map((r) => r.typeId)
  );
  const uncovered = typeIds.filter((id) => !covered.has(id));

  if (uncovered.length > 0) {
    info(
      `NOTE: ${uncovered.length}/${typeIds.length} types have no history rows. ` +
      'These are usually items that simply never trade (ESI returns an empty ' +
      'series), which is a legitimate empty result rather than a gap.'
    );
  } else {
    info('history coverage: complete for the plan types');
  }
  // NB: this covers the PLAN types only. The summary sweep prices a much wider
  // blueprint set - warmSummaryHistory() below caches that separately.

  return { fetched, failed, types: typeIds.length, uncovered: uncovered.length };
}

/**
 * Build the recipe's plans through the REAL APIs.
 *
 * Deliberately not raw INSERTs: going through createManufacturingPlan and
 * addBlueprintToPlan means intermediates, materials and node trees are produced
 * by today's application code. That is what lets the dataset keep adapting as
 * the app changes, instead of freezing a shape that slowly drifts from reality.
 */
async function buildPlans(recipe, characterId) {
  const {
    createManufacturingPlan,
    addBlueprintToPlan,
    updatePlanBlueprint,
    recalculatePlanMaterials,
  } = require('../src/main/manufacturing-plans');

  const built = [];

  for (const planSpec of recipe.plans) {
    info(`building plan: ${planSpec.name}`);
    const created = createManufacturingPlan(characterId, planSpec.name, planSpec.description || null);
    const planId = created && created.planId;
    if (!planId) throw new Error(`could not create plan ${planSpec.name}`);

    for (const bp of planSpec.blueprints) {
      // Keys must match addBlueprintToPlan's destructure EXACTLY - it silently
      // drops anything else (see CLAUDE.md on the IPC/param contract). Verified
      // against the destructure at manufacturing-plans.js:536.
      const added = await addBlueprintToPlan(planId, {
        blueprintTypeId: bp.typeId,
        runs: bp.runs,
        lines: bp.lines,
        meLevel: bp.me,
        teLevel: bp.te,
      });

      // use_intermediates is NOT part of addBlueprintToPlan's destructure - it
      // defaults to 'raw_materials' and is changed through updatePlanBlueprint,
      // whose allowedFields list is snake_case. Passing `useIntermediates` to
      // the add call would be silently discarded.
      if (bp.useIntermediates && bp.useIntermediates !== 'raw_materials' && added) {
        await updatePlanBlueprint(added.planBlueprintId, {
          use_intermediates: bp.useIntermediates,
        });
      }
    }

    // Force a full recalculation so the node tree exists in the dataset.
    await recalculatePlanMaterials(planId, true);

    const nodes = countNodes(planId);

    // A plan with no material nodes is a broken plan, and a dataset full of
    // them would benchmark nothing while looking like a success. The app logs
    // the underlying cause (missing SDE, no market set) and CARRIES ON, so
    // without this check the failure is invisible until the numbers make no
    // sense. Fail here instead.
    if (nodes === 0) {
      throw new Error(
        `plan "${planSpec.name}" built 0 material nodes.\n` +
        '  Something upstream failed - check the log above for "Cannot open database"\n' +
        '  (missing SDE) or "no Market Set configured". The dataset is unusable\n' +
        '  without material nodes, so the build is stopping here rather than\n' +
        '  stamping a generation that benchmarks nothing.'
      );
    }

    info(`  ${planSpec.name}: ${nodes} material nodes`);
    built.push({ name: planSpec.name, planId, nodes });
  }

  return built;
}

/**
 * Run the Manufacturing Summary once so its history lands in the dataset.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT JUST "SEED MORE TYPES"
 * -----------------------------------------------------------
 * The summary prices every buildable blueprint - a far wider set than the
 * plans' ~117 types. Profiling the first working benchmark showed the sweep
 * fetching history for 286 DISTINCT types from ESI mid-run: 16s of the 25s
 * window was idle waiting on those sequential requests, and 4.5s of CPU went
 * to storeMarketHistory WRITING the results. The scenario was measuring ESI
 * latency, not code.
 *
 * Its blueprint selection depends on facilities, skills and filters, so
 * predicting the type list in the seeder would duplicate that logic and drift
 * from it. Running the real sweep once is exact by construction: whatever it
 * touches gets cached, and the measured runs then read from the database.
 *
 * This is the same reasoning as seedMarketHistory - fetch once at build time so
 * that measurement is offline and repeatable - applied to a set that can only
 * be discovered by running the thing.
 */
async function warmSummaryHistory() {
  const { calculateSummary } = require('../src/main/manufacturing-summary');
  const { withPriceCache } = require('../src/main/market-read-cache');
  const { getMarketDatabase } = require('../src/main/market-database');

  const db = getMarketDatabase();
  const before = db.prepare('SELECT COUNT(DISTINCT type_id) AS n FROM market_history').get().n;

  info('running the summary sweep once to cache its history (slow, one time)...');
  const started = Date.now();
  const rows = await withPriceCache(() => calculateSummary({}, () => {}), 'bench warm summary');

  const after = db.prepare('SELECT COUNT(DISTINCT type_id) AS n FROM market_history').get().n;
  info(
    `summary warmed: ${Array.isArray(rows) ? rows.length : 0} rows in ` +
    `${((Date.now() - started) / 1000).toFixed(0)}s, history types ${before} -> ${after}`
  );

  return { rows: Array.isArray(rows) ? rows.length : 0, historyTypes: after };
}

/**
 * Cache history for the character's asset types.
 *
 * The Asset Manager values a whole hangar through market:calculatePrices with
 * skipHistory: true, which sounds like it cannot reach ESI. It can: when a type
 * has NO orders after the location filter, calculateRealisticPrice falls back
 * to the historical average and fetches it (market-pricing.js:373 - "DEFERRED,
 * not abandoned"). Measured here, 96 of 904 held types hit that path - illiquid
 * items that simply are not on the Jita market.
 *
 * That is a genuine cold-cache cost for the user, and it is also 96 unseeded
 * ESI calls in the FIRST bench run and none in later ones - the run-to-run
 * variance this design exists to remove. Warm it once, at build time.
 */
async function warmAssetValuation(recipe) {
  const { getAssets } = require('../src/main/esi-assets');
  const { getCharacters } = require('../src/main/settings-manager');
  const { fetchMarketHistory } = require('../src/main/esi-market');
  const { getMarketDatabase } = require('../src/main/market-database');

  const regionId = (recipe.market && recipe.market.regionId) || 10000002;
  const characters = getCharacters() || [];

  // Every type any character holds, personal and corp.
  const held = new Set();
  for (const c of characters) {
    for (const isCorp of [false, true]) {
      for (const a of getAssets(c.characterId, isCorp) || []) {
        if (a.typeId) held.add(a.typeId);
      }
    }
  }

  const db = getMarketDatabase();
  const covered = new Set(
    db.prepare('SELECT DISTINCT type_id AS t FROM market_history WHERE region_id = ?')
      .all(regionId)
      .map((r) => r.t)
  );
  const missing = [...held].filter((t) => !covered.has(t));

  if (missing.length === 0) {
    info(`asset types already covered (${held.size} held)`);
    return { held: held.size, fetched: 0 };
  }

  info(`fetching history for ${missing.length} uncovered asset types (~${Math.ceil(missing.length / 6)}s)...`);
  let fetched = 0;
  for (const typeId of missing) {
    try {
      // forceRefresh: false - see the note in seedMarketHistory. These types
      // have no rows at all, so the staleness check fetches them anyway.
      await fetchMarketHistory(regionId, typeId, false);
      fetched++;
    } catch (_) {
      /* a dead type must not lose the build */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  info(`asset valuation warmed: ${fetched}/${missing.length} fetched, ${held.size} types held`);
  return { held: held.size, fetched };
}

/**
 * Run the invention sweep once so its history lands in the dataset.
 *
 * findBestDecryptor prices the T2 PRODUCT and its T2 components - types that
 * are neither plan material nodes nor held assets, so none of the other warm
 * steps reach them. Measured: 6 types (Cerberus and its capital components)
 * were re-fetched on every single bench run, ~50 ESI calls a run, because
 * isHistoryStale() sees no rows and reports stale forever.
 *
 * Same trick as warmSummaryHistory: rather than predict the type list, run the
 * real thing once and let whatever it touches get cached.
 */
async function warmInventionSweep(recipe) {
  const inventionSpec = recipe.invention;
  if (!inventionSpec || !inventionSpec.blueprintTypeId) {
    info('no invention blueprint in the recipe; skipping');
    return null;
  }

  const {
    getInventionData,
    findBestDecryptor,
    getDefaultFacility,
  } = require('../src/main/blueprint-calculator');
  const { withPriceCache } = require('../src/main/market-read-cache');
  const { getDefaultMarketSet } = require('../src/main/settings-manager');
  const { getMarketDatabase } = require('../src/main/market-database');

  const inventionData = getInventionData(inventionSpec.blueprintTypeId);
  if (!inventionData) {
    info(`no invention data for blueprint ${inventionSpec.blueprintTypeId}; skipping`);
    return null;
  }

  const db = getMarketDatabase();
  const before = db.prepare('SELECT COUNT(DISTINCT type_id) AS n FROM market_history').get().n;

  info(`running the invention sweep once (${inventionSpec.blueprintName || inventionSpec.blueprintTypeId})...`);
  await withPriceCache(
    () => findBestDecryptor(
      inventionData, {}, 0, {},
      getDefaultFacility(), 'total-per-item', getDefaultMarketSet()
    ),
    'bench warm invention'
  );

  const after = db.prepare('SELECT COUNT(DISTINCT type_id) AS n FROM market_history').get().n;
  info(`invention warmed: history types ${before} -> ${after}`);
  return { before, after };
}

/**
 * Recalculate every plan with refreshPrices, now that history is present.
 *
 * The first build pass locks prices before history exists, so any node priced
 * with a history-dependent method ('hybrid' is the market-set default,
 * 'historical' likewise) got an order-book-only value. Re-locking here makes
 * the dataset's frozen prices the ones the app would really produce.
 */
async function relockPlanPrices(plans) {
  const { recalculatePlanMaterials } = require('../src/main/manufacturing-plans');

  for (const plan of plans) {
    await recalculatePlanMaterials(plan.planId, true);
  }
  info(`re-locked prices for ${plans.length} plans`);
}

/** Node count for a plan, read straight from the character database. */
function countNodes(planId) {
  const { getCharacterDatabase } = require('../src/main/character-database');
  const db = getCharacterDatabase();
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM plan_material_nodes WHERE plan_id = ?')
    .get(planId);
  return row ? row.n : 0;
}

async function main() {
  step('sandbox');
  const paths = sandbox.assertSandboxed(app, DATASET);
  info(`userData:  ${paths.userData}`);
  info(`configDir: ${paths.configDir}`);

  step('database init');
  // Same ordering the app uses at startup: create, then migrate.
  const { initializeCharacterDatabase } = require('../src/main/character-database');
  initializeCharacterDatabase();

  const { needsSchemaMigrations, runSchemaMigrations } = require('../src/main/database-schema-migrations');
  if (needsSchemaMigrations()) {
    info('running schema migrations...');
    await runSchemaMigrations();
  }

  const { initializeMarketDatabase } = require('../src/main/market-database');
  initializeMarketDatabase();
  info('databases ready');

  // Both of these exist on a normal install courtesy of the SDE downloader and
  // the first-launch wizard. An empty sandbox has neither, and without them
  // every plan builds zero material nodes.
  step('static data');
  seedSDE();

  step('market set');
  ensureMarketSet();

  step('characters');
  // A stashed copy of the previous dataset, if bench-build.js kept one.
  const carried = PREVIOUS ? carryCharacterData(PREVIOUS) : null;

  let characters;
  let refetch = true;
  if (carried) {
    characters = carried;
    // The carried skills/blueprints/assets are already in place; re-fetching
    // them is the slow part a reuse is meant to avoid. --refresh-characters
    // forces it when the data has gone stale.
    refetch = process.env.QF_BENCH_REFRESH_CHARS === '1';
    info(`reusing ${characters.length} character(s) from the previous dataset`);
  } else {
    characters = await onboardCharacters();
  }

  // A default character is a SETTING, not a consequence of having characters -
  // getDefaultCharacter() returns null without it. Anything resolving "the
  // current character" then silently degrades: What Can I Build? read zero
  // assets and produced zero rows before this was set.
  const { setDefaultCharacter, getDefaultCharacter } = require('../src/main/settings-manager');
  if (!getDefaultCharacter()) {
    setDefaultCharacter(characters[0].characterId);
    info(`default character: ${characters[0].characterName}`);
  }

  if (refetch) {
    step('fetching character data from ESI');
    await populateCharacters(characters);
  } else {
    step('skipping character re-fetch (carried data reused)');
    info('pass --refresh-characters to re-fetch skills/blueprints/assets');
  }

  const recipe = loadRecipe();

  // Orders first: addBlueprintToPlan and recalculatePlanMaterials lock prices
  // as they go, and prices locked against an empty book are all zero.
  step('fetching market orders from ESI');
  await seedMarketOrders(recipe);

  step('building plans');
  const primary = characters[0].characterId;
  const plans = await buildPlans(recipe, primary);

  // History can only be fetched once the plans exist, because the plans are
  // what define which types matter. Then the prices are re-locked so the
  // dataset's locked values include the history-based methods ('hybrid' is the
  // market-set default) rather than order-book-only approximations.
  step('fetching market history for the dataset types');
  const history = await seedMarketHistory(recipe);

  step('re-locking prices with history present');
  await relockPlanPrices(plans);

  step('warming the summary sweep');
  await warmSummaryHistory();

  step('warming asset valuation');
  await warmAssetValuation(recipe);

  step('warming the invention sweep');
  await warmInventionSweep(recipe);

  step('stamping generation');
  const generation = writeGeneration({
    id: `g${Date.now().toString(36)}`,
    builtAt: Date.now(),
    recipeHash: recipeHash(recipe),
    recipeVersion: recipe.version,
    schemaMigrationId: latestSchemaMigrationId(),
    characterIds: characters.map((c) => c.characterId),
    characterCount: characters.length,
    planCount: plans.length,
    totalNodes: plans.reduce((a, p) => a + p.nodes, 0),
    marketHistory: {
      regionId: (recipe.market && recipe.market.regionId) || 10000002,
      typesSeeded: history.types,
      typesWithoutHistory: history.uncovered,
    },
    plans: plans.map((p) => ({ name: p.name, planId: p.planId, nodes: p.nodes })),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
  });

  info(`generation ${generation.id}: ${generation.planCount} plans, ${generation.totalNodes} nodes`);
  app.exit(0);
}

app.on('ready', () => {
  main().catch((err) => {
    console.error(`\n[build] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    app.exit(1);
  });
});

// A window is never shown; without this the app would quit when the auth
// browser window closes.
app.on('window-all-closed', () => { /* keep running */ });
