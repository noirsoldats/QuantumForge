#!/usr/bin/env node
'use strict';

/**
 * Renderer-side benchmark: mounts the real Asset Manager view in jsdom and
 * times interaction.
 *
 * RUNS INSIDE ELECTRON, like every other benchmark here. jsdom supplies the
 * DOM; the Electron runtime supplies working better-sqlite3 bindings. That
 * means --real can call the SAME main-process functions the IPC handlers call
 * (getAssets, the SDE lookups, calculateRealisticPrice) instead of replaying a
 * snapshot - no fixture file, no ABI swap, no second copy of the data path to
 * drift out of sync.
 *
 * WHY THIS IS SEPARATE FROM scripts/bench.js
 * ------------------------------------------
 * The main-process benchmark measures calculation. The Asset Manager's
 * per-interaction cost is not calculation - the main process only runs
 * `SELECT * FROM assets` and hands back rows (esi-assets.js:203). The lag lives
 * in the renderer, so it has to be measured where that work happens.
 *
 * TWO MODES, DELIBERATELY BOTH KEPT
 * ---------------------------------
 *   synthetic (default)  Generated rows at any size, uniform cardinality.
 *                        Isolates how the renderer's own work grows with row
 *                        count, and scales past what the real data contains.
 *                        Best for proving a computeRows()/render() fix.
 *
 *   --real               The character's real assets, real names/categories/
 *                        volumes, real prices, real locations, fetched through
 *                        the real functions. One fixed size, but real
 *                        cardinality and a real ISK distribution - catches
 *                        costs that only appear with messy data, and measures
 *                        a realistic mount including valuation.
 *
 * Neither measures layout or paint: jsdom has no compositor. For that, use
 * `npm run profile:trace` against the running app and look for long RunTasks
 * on a Renderer process.
 *
 *   npm run bench:renderer                  # synthetic, 500/2000/5000
 *   npm run bench:renderer -- --real        # real assets and prices
 *   npm run bench:renderer -- --assets 8000 # one synthetic size
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { percentile, fmtMs } = require('./lib/bench-common');

/**
 * Electron gives a real `app` object only when launched as an app (not under
 * ELECTRON_RUN_AS_NODE), and app.setPath is the only way to redirect the data
 * path on macOS/Linux - portable-mode.js is Windows-only. So --real needs the
 * app lifecycle; synthetic mode does not care either way.
 */
let electronApp = null;
try {
  electronApp = require('electron').app || null;
} catch (_) {
  electronApp = null;
}

function parseArgs(argv) {
  const args = { assets: null, repeat: 3, real: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--assets') args.assets = Number(argv[++i]);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--real') args.real = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`
Renderer benchmark - Asset Manager interaction cost (jsdom)

  node scripts/bench-renderer.js [--assets N] [--repeat N]   synthetic
  node scripts/bench-renderer.js --real [--repeat N]          real data

  --real       replay the real character's assets, names, categories and
               prices, exported by "npm run bench:build"
  --assets N   synthetic asset count (default: 500, 2000, 5000)
  --repeat N   samples per measurement (default 3)

TWO MODES, TWO QUESTIONS:

  synthetic  scales to any row count with uniform cardinality, so it isolates
             how the renderer's own work grows with row count. Best for
             proving a computeRows() or render() fix.

  --real     one fixed size, but real type/category/location cardinality and a
             real ISK distribution - catches costs that only appear with messy
             data (facet counts, group-by spread, sort comparators on real
             values) and a realistic mount, including price data.

Neither measures layout or paint - jsdom has no compositor. Use
"npm run profile:trace" against the running app for that.
`);
}

/**
 * Synthetic assets. Deliberately generated rather than read from the benchmark
 * dataset: the question here is how cost scales with ROW COUNT, and a
 * generator can produce sizes the real data does not contain.
 */
function makeAssets(count) {
  const assets = [];
  const locations = [60003760, 60008494, 60011866, 1022734985679];
  for (let i = 0; i < count; i++) {
    assets.push({
      itemId: 1000000 + i,
      typeId: 34 + (i % 400),           // 400 distinct types -> aggregation work
      locationId: locations[i % locations.length],
      locationFlag: 'Hangar',
      quantity: 1 + (i % 997),
      isBlueprintCopy: i % 50 === 0,
      isSingleton: i % 7 === 0,
    });
  }
  return assets;
}

function makeTypeNames(assets) {
  const names = {};
  for (const a of assets) names[a.typeId] = `Test Item ${a.typeId}`;
  return names;
}

function makeCategoryInfo(assets) {
  const info = {};
  for (const a of assets) {
    info[a.typeId] = {
      categoryID: 6 + (a.typeId % 4),
      categoryName: `Category ${6 + (a.typeId % 4)}`,
      groupID: 25 + (a.typeId % 20),
      groupName: `Group ${25 + (a.typeId % 20)}`,
    };
  }
  return info;
}

/** Build the electronAPI surface the Asset Manager reads. */
function makeApi(assets) {
  const typeIds = [...new Set(assets.map((a) => a.typeId))];
  const prices = {};
  for (const id of typeIds) prices[id] = { price: 1000 + id, confidence: 'high' };
  const volumes = {};
  for (const id of typeIds) volumes[id] = 1 + (id % 100);

  // Shapes mirror tests/renderer/assets-ui.test.js makeApi() - notably
  // assets.get takes (characterId, isCorporation), and the renderer resolves
  // its character through esi.getCharacter.
  const character = { characterId: 1, name: 'Bench', corporationId: 99, corporationName: 'Bench Corp' };

  return {
    esi: {
      getCharacter: async () => character,
      getDefaultCharacter: async () => character,
      getCharacters: async () => [character],
    },
    assets: {
      get: async (id, isCorporation) => (isCorporation ? [] : assets),
      getCacheStatus: async () => ({
        isCached: true,
        expiresAt: Date.now() + 3600000,
        remainingSeconds: 3600,
      }),
      fetch: async () => ({ success: true }),
    },
    sde: {
      getTypeNames: async () => makeTypeNames(assets),
      getTypeCategoryInfo: async () => makeCategoryInfo(assets),
      getItemVolumes: async () => volumes,
    },
    location: {
      resolveMany: async (ids) => {
        const out = {};
        for (const id of ids || []) {
          out[id] = { fullPath: `Region - System - Station ${id}`, name: `Station ${id}`, systemName: 'System' };
        }
        return out;
      },
    },
    market: {
      calculatePrices: async () => prices,
      getMarketSets: async () => [
        { id: 'bench', name: 'Bench', isDefault: true, inputMaterials: {}, outputProducts: {} },
      ],
    },
    settings: {
      load: async () => ({ general: {}, accounts: { characters: [character], defaultCharacterId: 1 } }),
      // (category, key) - the view reads 'assets'/'savedViews' through this.
      get: async () => null,
      update: async () => true,
    },
    divisions: { getEnabled: async () => [] },
  };
}

/**
 * Build an electronAPI backed by the REAL main-process functions.
 *
 * Each method here calls exactly what the corresponding ipcMain handler calls,
 * so the renderer exercises the true data path: real assets, real SDE lookups,
 * real pricing, real location resolution. Only the IPC transport is skipped -
 * which is what makes this measure the renderer rather than the wire.
 */
async function makeRealApi(sandboxDir) {
  const M = path.join(ROOT, 'src', 'main');
  const { getAssets } = require(path.join(M, 'esi-assets'));
  const { getCharacters, getDefaultCharacter, getDefaultMarketSet, getMarketSets } =
    require(path.join(M, 'settings-manager'));
  const { calculateRealisticPrice } = require(path.join(M, 'market-pricing'));
  const { withPriceCache } = require(path.join(M, 'market-read-cache'));
  const { resolveLocationInfoMany } = require(path.join(M, 'location-resolver'));
  const sde = require(path.join(M, 'sde-database'));

  const character = getDefaultCharacter();
  if (!character) {
    throw new Error('no default character in the dataset - run `npm run bench:build`');
  }

  const assets = getAssets(character.characterId, false) || [];
  if (assets.length === 0) {
    throw new Error('the dataset character holds no assets');
  }

  const marketSet = getDefaultMarketSet();
  const settings = (marketSet && marketSet.inputMaterials) || {};

  return {
    meta: { assets: assets.length, character },
    api: {
      esi: {
        getCharacter: async () => character,
        getDefaultCharacter: async () => character,
        getCharacters: async () => getCharacters() || [],
      },
      assets: {
        // Mirrors ipcMain 'assets:get'.
        get: async (id, isCorporation) => getAssets(id, isCorporation) || [],
        getCacheStatus: async () => ({
          isCached: true,
          expiresAt: Date.now() + 3600000,
          remainingSeconds: 3600,
        }),
        fetch: async () => ({ success: true }),
      },
      sde: {
        getTypeNames: async (ids) => sde.getTypeNames(ids),
        getTypeCategoryInfo: async (ids) => sde.getTypeCategoryInfo(ids),
        getItemVolumes: async (ids) => sde.getItemVolumes(ids),
      },
      location: {
        // 'location.resolveMany' is the preload name for this (main.js:3381).
        resolveMany: async (ids, characterId, isCorporation) =>
          resolveLocationInfoMany(ids, characterId || character.characterId, !!isCorporation),
      },
      market: {
        // Mirrors ipcMain 'market:calculatePrices': dedupe, one session, then
        // a sequential calculateRealisticPrice per distinct type.
        calculatePrices: async (typeIds, options = {}) => {
          const unique = [...new Set(typeIds || [])];
          const out = {};
          await withPriceCache(async () => {
            for (const typeId of unique) {
              try {
                const r = await calculateRealisticPrice(
                  typeId,
                  settings.regionId,
                  settings.locationId,
                  options.priceType || 'sell',
                  1,
                  settings,
                  { skipHistory: options.skipHistory !== false }
                );
                out[typeId] = { price: r.price, confidence: r.confidence };
              } catch (_) {
                out[typeId] = { price: 0, confidence: 'none' };
              }
            }
          }, 'bench:renderer valuation');
          return out;
        },
        getMarketSets: async () => getMarketSets() || [],
      },
      settings: {
        load: async () => require(path.join(M, 'settings-manager')).loadSettings(),
        get: async () => null,
        update: async () => true,
      },
      divisions: { getEnabled: async () => [] },
    },
  };
}

/**
 * Drain pending work before measuring.
 *
 * Microtask draining alone is NOT enough in --real mode: pricing awaits real
 * SQLite reads, so the continuation lands on a macrotask turn. A mount that
 * returned while priceAssets() was still in flight tore the jsdom window down
 * underneath it, and the renderer's next render() threw
 * "Cannot read properties of undefined (reading 'createElement')".
 */
async function settle(times = 60) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  // Yield to the event loop so I/O continuations can run.
  await new Promise((resolve) => setImmediate(resolve));
}

/** Wait until the view has stopped mutating, or the deadline passes. */
async function settleUntilQuiet(container, { quietMs = 250, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastHtmlLength = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await settle(20);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const len = container.innerHTML.length;
    if (len !== lastHtmlLength) {
      lastHtmlLength = len;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
  }
}

/** Mount the real Asset Manager renderer inside jsdom. */
async function mountAssets(assetsOrApi, characterId = 1) {
  const { JSDOM } = require('jsdom');
  const api = Array.isArray(assetsOrApi) ? makeApi(assetsOrApi) : assetsOrApi;

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'dangerously', // required to execute the injected renderer
  });

  // No globals are copied onto the Node side. The renderer is evaluated INSIDE
  // the jsdom window (dom.window.eval below), so it resolves window, document
  // and friends from there. Assigning them here is both unnecessary and, for
  // `navigator`, impossible - it is a getter-only global in modern Node.

  const viewHtml = fs.readFileSync(path.join(ROOT, 'public', 'assets.view.html'), 'utf8');

  // The renderer registers itself against QFShell.router on load.
  let registered = null;
  dom.window.QFShell = {
    router: { register: (id, def) => { registered = { id, def }; } },
    setBreadcrumb: () => {},
  };
  dom.window.electronAPI = api;
  dom.window.QFToast = { show: () => {}, setDefaultPosition: () => {}, dismissAll: () => {} };
  // Real API surface: { attach, formatRemaining, setLabel }, and attach()
  // returns a disposer. Stubbing a constructor instead (as a first pass here
  // did) throws inside the renderer and aborts the mount.
  dom.window.QFCacheCountdown = {
    attach: () => () => {},
    formatRemaining: () => '',
    setLabel: () => {},
  };
  dom.window.fetch = async () => ({ ok: true, text: async () => viewHtml });

  // Inject the renderer as a <script>, the way a browser loads it. dom.window.eval
  // does NOT bind `window` inside the evaluated scope, so the renderer's own
  // `window.QFShell` reference throws; runScripts:'dangerously' plus a script
  // element executes it in the proper global scope.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets-view-renderer.js'), 'utf8');
  const script = dom.window.document.createElement('script');
  script.textContent = src;
  dom.window.document.body.appendChild(script);

  if (!registered) throw new Error('assets view did not register with QFShell.router');

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);

  const ctx = {
    on: (t, type, h) => t && t.addEventListener(type, h),
    track: (fn) => fn,
    setInterval: () => 0,
    setTimeout: () => 0,
    dispose: () => {},
  };

  // The view expects a characterId param, exactly as the shell passes one.
  // Real mode must pass the REAL id or getAssets returns nothing.
  // Mount is measured to QUIESCENCE, not to the promise resolving: the view
  // kicks off pricing and location resolution and re-renders when they land,
  // so returning at mount() would both under-report the cost and tear the
  // window down mid-flight.
  const t0 = performance.now();
  const instance = await registered.def.mount(container, { characterId }, ctx);
  await settleUntilQuiet(container);
  const mountMs = performance.now() - t0;

  return { dom, container, instance, mountMs };
}

/** Time a synchronous interaction, in milliseconds. */
function timeSync(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

async function benchSize(count, repeat, realApi = null) {
  const { dom, container, instance, mountMs } = realApi
    ? await mountAssets(realApi.api, realApi.meta.character.characterId)
    : await mountAssets(makeAssets(count));

  const rows = container.querySelectorAll('#as-tbody tr').length;
  const results = {};
  // Mount includes the full data path in --real mode (assets, SDE lookups,
  // valuation), so it is worth reporting on its own rather than folding into
  // the interaction numbers.
  results.mount = [mountMs];

  // 1. Tick one row checkbox. This is the interaction that should be nearly
  //    free and is the reason this benchmark exists: render() fires from every
  //    checkbox handler, and computeRows() runs 4-5 times per render().
  //    NOTE: the element must be re-queried each iteration. render() rebuilds
  //    the tbody, so the node clicked in sample 1 is detached by sample 2 and
  //    clicking it again would measure nothing.
  if (container.querySelector('#as-tbody input[type="checkbox"]')) {
    const samples = [];
    for (let i = 0; i < repeat; i++) {
      const box = container.querySelector('#as-tbody input[type="checkbox"]');
      if (!box) break;
      samples.push(timeSync(() => box.click()));
    }
    if (samples.length) results.checkbox = samples;
  }

  // 2. Click a sort header - a full table rebuild is expected here. Sort
  //    headers are th.as-th; .is-check is the select-all column, not a sort.
  if (container.querySelector('th.as-th:not(.is-check)')) {
    const samples = [];
    for (let i = 0; i < repeat; i++) {
      const header = container.querySelector('th.as-th:not(.is-check)');
      if (!header) break;
      samples.push(timeSync(() => header.click()));
    }
    if (samples.length) results.sort = samples;
  }

  // 3. Type in the search box - rebuilds against a filtered set.
  const search = container.querySelector('#as-search');
  if (search) {
    // The term must actually MATCH, or the benchmark measures filtering down
    // to an empty table - which looked 32x "faster" in real mode purely
    // because "Test Item 1" matches nothing in real item names. Derive it from
    // a name that is actually on screen.
    const firstName = (() => {
      const cell = container.querySelector('#as-tbody tr.as-row td');
      const text = cell ? cell.textContent.trim() : '';
      return text.slice(0, Math.max(3, Math.min(6, text.length))) || 'a';
    })();

    const samples = [];
    for (let i = 0; i < repeat; i++) {
      samples.push(timeSync(() => {
        search.value = i % 2 === 0 ? firstName : '';
        search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }));
    }
    results.search = samples;
  }

  if (instance && instance.destroy) instance.destroy();
  dom.window.close();

  return { count, rows, results };
}

/**
 * Prepare --real mode: point the app at a disposable copy of the built
 * dataset, open its databases, and hand back a real-backed electronAPI.
 *
 * Same isolation rule as every other benchmark - the built dataset is treated
 * as read-only and a run works on a copy, so repeated runs start from
 * byte-identical state.
 */
async function setupReal() {
  const { PATHS, checkDataset, generationLabel, acquireLock } = require('./lib/bench-common');

  // --real copies the dataset like `bench` does, so it needs the same lock.
  acquireLock('bench:renderer --real');

  const status = checkDataset();
  if (!status.ok) {
    throw new Error(`${status.reason}.\n  ${status.hint}`);
  }

  // Copy the dataset, minus the stamp, into the working sandbox.
  if (fs.existsSync(PATHS.sandbox)) fs.rmSync(PATHS.sandbox, { recursive: true, force: true });
  fs.cpSync(PATHS.dataset, PATHS.sandbox, { recursive: true });
  const stamp = path.join(PATHS.sandbox, 'generation.json');
  if (fs.existsSync(stamp)) fs.rmSync(stamp);

  // ORDERING RULE (scripts/lib/sandbox.js): redirect before requiring any
  // src/main module, or the databases open against the real config.
  if (!electronApp) {
    throw new Error(
      '--real must run inside Electron (it needs app.setPath and the Electron\n' +
      '  better-sqlite3 ABI). Use: npm run bench:renderer -- --real'
    );
  }
  const sandbox = require('./lib/sandbox');
  sandbox.redirectUserData(electronApp, PATHS.sandbox);
  sandbox.assertSandboxed(electronApp, PATHS.sandbox);

  require(path.join(ROOT, 'src', 'main', 'character-database')).initializeCharacterDatabase();
  require(path.join(ROOT, 'src', 'main', 'market-database')).initializeMarketDatabase();

  console.log(`  dataset: ${generationLabel(status.generation)}`);
  return makeRealApi(PATHS.sandbox);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  try {
    require.resolve('jsdom');
  } catch (_) {
    console.error('[bench-renderer] jsdom is required (it ships with jest-environment-jsdom).');
    process.exit(1);
  }

  // 10k+ in one process exhausts the jsdom heap (it retains every node ever
  // created across mounts). That is a jsdom limit, not an app one - measure
  // larger sizes one at a time with --assets.
  console.log('\n' + '='.repeat(70));
  console.log(
    args.real
      ? 'Asset Manager renderer benchmark - REAL data (jsdom, no paint)'
      : 'Asset Manager renderer benchmark - synthetic (jsdom, no paint)'
  );
  console.log('='.repeat(70));

  const all = [];

  if (args.real) {
    const realApi = await setupReal();
    process.stdout.write(`\n${realApi.meta.assets} real assets ... `);
    const result = await benchSize(realApi.meta.assets, args.repeat, realApi);
    result.count = realApi.meta.assets;
    all.push(result);
    console.log(`${result.rows} rows rendered`);
    for (const [name, samples] of Object.entries(result.results)) {
      console.log(
        `    ${name.padEnd(10)} p50 ${fmtMs(percentile(samples, 0.5)).padStart(9)}   (${samples.length} samples)`
      );
    }
  } else {
    const sizes = args.assets ? [args.assets] : [500, 2000, 5000];
    for (const size of sizes) {
      process.stdout.write(`\n${size} assets ... `);
      const result = await benchSize(size, args.repeat);
      all.push(result);
      console.log(`${result.rows} rows rendered`);

      for (const [name, samples] of Object.entries(result.results)) {
        const p50 = percentile(samples, 0.5);
        console.log(`    ${name.padEnd(10)} p50 ${fmtMs(p50).padStart(9)}   (${samples.length} samples)`);
      }
    }
  }

  // Scaling is the diagnosis: linear means a constant factor, super-linear
  // means an algorithm.
  console.log('\n' + '='.repeat(70));
  console.log('Scaling (per interaction, p50)');
  console.log('='.repeat(70));
  const names = [...new Set(all.flatMap((r) => Object.keys(r.results)))];
  const header = ['assets', ...names].map((h) => h.padStart(11)).join('');
  console.log(header);
  for (const r of all) {
    const cells = [String(r.count).padStart(11)];
    for (const n of names) {
      cells.push((r.results[n] ? fmtMs(percentile(r.results[n], 0.5)) : '-').padStart(11));
    }
    console.log(cells.join(''));
  }
  console.log('');
}

function finish(code) {
  if (electronApp) electronApp.exit(code);
  else process.exit(code);
}

function run() {
  main()
    .then(() => finish(0))
    .catch((err) => {
      console.error(`[bench-renderer] ${err.message || err}`);
      if (err.stack) console.error(err.stack);
      finish(1);
    });
}

if (electronApp) {
  // Launched as an Electron app: nothing (including app.setPath's effect on
  // getPath) is reliable until ready. No window is ever created.
  electronApp.on('window-all-closed', () => { /* keep running */ });
  if (electronApp.isReady()) run();
  else electronApp.on('ready', run);
} else {
  run();
}
