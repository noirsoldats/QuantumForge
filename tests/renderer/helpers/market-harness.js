/**
 * Shared harness for the Market Manager UI suites.
 *
 * The Market tests were one 2,663-line file. Jest cannot split a single file
 * across workers, so that file set the floor for the whole run's wall clock.
 * The tests now live in several files grouped by feature area, all pulling
 * their fake backend, mount and DOM helpers from here.
 *
 * The renderer is an IIFE that exposes nothing, so these tests drive it the way
 * a user does - mount it into a container, click things, and assert on the DOM.
 * That also means they verify the binding rules from CLAUDE.md, which are about
 * observable DOM state:
 *
 *   rule 1 - row highlights are box-shadow only, never a toggled background
 *   rule 2 - the combobox highlight index starts at -1 (no row hot on first paint)
 *   rule 3 - conditional styles are symmetric, so a state change fully resets
 *
 * USAGE
 *
 *   const h = require('./helpers/market-harness');
 *   h.installHooks();
 *   const { mount, flush, state } = h;
 *
 * FIXTURE STATE is reached through `state`, which is a live view onto this
 * module's bindings - `state.overrides = [...]` inside a test really does
 * change what the fake IPC returns. It has to be a facade rather than a plain
 * exported object: the fakes below close over the bare `let` bindings, and an
 * assignment made in another module could never rebind those.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../../public/market.view.html'),
  'utf8'
);

/** Watchlist rows the fake backend returns. */
let watchlists;
/** Items keyed by watchlist id. */
let items;
/** typeId -> price, used by the fake pricing IPC. */
let prices;
/** Market sets. Note inputMaterials/outputProducts are pricing CONFIG objects. */
let sets;
/** Price override rows, as getAllPriceOverrides returns them (no name field). */
let overrides;
/** Characters, in the shape settings-manager.getCharacters() returns. */
let characters;
/** typeId -> raw market_orders rows, for the drawer's order book. */
let orderBook;
/** typeId -> cached history rows ({date, average, volume}). */
let priceHistory;
/** typeId -> history ESI would return when nothing is cached. */
let fetchableHistory;
/** When set, getCachedHistory awaits this before resolving (slow-fetch tests). */
let historyGate;
/** typeId -> plans returned by getPlansUsingType. */
let plansByType;
/** What relockPlanMaterial resolves to. */
let relockResult;
/** Records calls so tests can assert what the renderer sent. */
let calls;
/** console.error output captured during a test; see the afterEach guard. */
let consoleErrors = [];
/** Patterns a test has declared as expected via allowErrors(). */
let expectedErrorPatterns = [];

function makeApi() {
  return {
    market: {
      getMarketSets: async () => sets,
      getRegionDashboard: async () => [],
      getLastFetchTime: async () => Date.now(),
      // Subscribed at mount for refresh progress. Both return a disposer, like
      // the real preload - `ctx.track` calls whatever comes back, so a bare
      // `() => {}` would throw on unmount instead.
      onFetchProgress: () => () => {},
      onRefreshStage: () => () => {},
      getAllPriceOverrides: async () => overrides,
      setPriceOverride: async (typeId, price, notes) => {
        calls.push({ fn: 'setPriceOverride', typeId, price, notes });
        return { success: true };
      },
      addMarketSet: async (data) => {
        calls.push({ fn: 'addMarketSet', data });
        return { success: true };
      },
      updateMarketSet: async (id, updates) => {
        calls.push({ fn: 'updateMarketSet', id, updates });
        return { success: true };
      },
      deleteMarketSet: async (id) => {
        calls.push({ fn: 'deleteMarketSet', id });
        return { success: true };
      },
      getMarketLocations: async () => ({
        success: true,
        locations: [
          { locationId: 60003760, locationName: 'Jita IV-4', locationType: 'station', regionId: 10000002, systemId: 30000142, isFavorite: 1 },
          { locationId: 60008494, locationName: 'Amarr VIII', locationType: 'station', regionId: 10000043, systemId: 30002187, isFavorite: 1 },
        ],
      }),
      searchTradedItems: async (regionId, term) => {
        calls.push({ fn: 'searchTradedItems', regionId, term });
        return {
          success: true,
          items: [
            { typeId: 34, typeName: 'Tritanium', volume: 48200000000, orderCount: 900 },
            { typeId: 35, typeName: 'Pyerite', volume: 19700000000, orderCount: 700 },
          ].filter((r) => r.typeName.toLowerCase().includes(term.toLowerCase())),
        };
      },
      getOrderBookSummary: async (regionId, typeIds) => {
        calls.push({ fn: 'getOrderBookSummary', regionId });
        const summary = {};
        (typeIds || []).forEach((id) => {
          if (!prices[id]) return;
          // Region-dependent, so switching market sets changes the numbers -
          // that is what makes a stale table visible in tests.
          const scale = regionId === 10000043 ? 10 : 1;
          summary[id] = {
            buy: prices[id].buy * scale,
            sell: prices[id].sell * scale,
            volume: 1000,
          };
        });
        return { success: true, summary };
      },
      searchStructures: async () => [],
      fetchOrders: async (regionId, typeId) => {
        calls.push({ fn: 'fetchOrders', regionId, typeId });
        return orderBook[typeId] || [];
      },
      getCachedHistory: async (regionId, typeId) => {
        calls.push({ fn: 'getCachedHistory', regionId, typeId });
        // A test can stall the response here to model a slow ESI round trip.
        if (historyGate) await historyGate;
        // Mirrors main: an uncached item is fetched on demand, and `fetched`
        // reports that a network round trip happened.
        const cached = priceHistory[typeId];
        if (cached && cached.length > 0) {
          return { success: true, history: cached, fetched: false };
        }
        const fetchedRows = fetchableHistory[typeId] || [];
        if (fetchedRows.length > 0) priceHistory[typeId] = fetchedRows;
        return { success: true, history: fetchedRows, fetched: true };
      },
      getPlansUsingType: async (typeId) => {
        calls.push({ fn: 'getPlansUsingType', typeId });
        return { success: true, plans: plansByType[typeId] || [] };
      },
      relockPlanMaterial: async (planId, typeId, price) => {
        calls.push({ fn: 'relockPlanMaterial', planId, typeId, price });
        return relockResult;
      },
      removePriceOverride: async () => ({}),
      setDefaultMarketSet: async () => ({}),
      updateAllMarketData: async () => ({}),
      calculatePrice: async (typeId, _r, _l, priceType, _q, marketSetId) => {
        calls.push({ fn: 'calculatePrice', typeId, priceType, marketSetId });
        const p = prices[typeId];
        if (!p) return { price: 0 };
        return { price: priceType === 'buy' ? p.buy : p.sell };
      },
      favorites: {
        getAll: async () => ({ success: true, favorites: [] }),
        toggle: async (typeId) => {
          calls.push({ fn: 'toggleFavorite', typeId });
          return { success: true, isFavorite: true };
        },
      },
      watchlists: {
        getAll: async () => ({ success: true, watchlists }),
        get: async (id) => ({
          success: true,
          watchlist: { ...watchlists.find((w) => w.id === id), items: items[id] || [] },
        }),
        create: async (data) => {
          calls.push({ fn: 'create', data });
          const wl = { id: 99, name: data.name, description: data.description, market_set_id: data.marketSetId, item_count: 0 };
          watchlists.push(wl);
          items[99] = [];
          return { success: true, watchlist: wl };
        },
        update: async (id, updates) => {
          calls.push({ fn: 'update', id, updates });
          Object.assign(watchlists.find((w) => w.id === id), {
            name: updates.name,
            description: updates.description,
            market_set_id: updates.marketSetId,
          });
          return { success: true, watchlist: watchlists.find((w) => w.id === id) };
        },
        remove: async (id) => {
          calls.push({ fn: 'remove', id });
          watchlists = watchlists.filter((w) => w.id !== id);
          return { success: true };
        },
        addItem: async (wlId, typeId, payload) => {
          calls.push({ fn: 'addItem', wlId, typeId, payload });
          return { success: true, item: { id: 500, type_id: typeId, ...payload } };
        },
        rebaseline: async (itemId, prices) => {
          calls.push({ fn: 'rebaseline', itemId, prices });
          return { success: true };
        },
        removeItem: async (itemId) => {
          calls.push({ fn: 'removeItem', itemId });
          Object.keys(items).forEach((k) => {
            items[k] = items[k].filter((i) => i.id !== itemId);
          });
          return { success: true };
        },
      },
    },
    esi: {
      // Mirrors settings-manager.getCharacters(): the field is characterName,
      // NOT name. An empty fixture here previously hid a real bug where the
      // ESI character dropdown rendered blank options.
      getCharacters: async () => characters,
      getDefaultCharacter: async () => null,
      onDefaultCharacterChanged: () => () => {},
    },
    sde: {
      getAllRegions: async () => [
        { regionID: 10000002, regionName: 'The Forge' },
        { regionID: 10000043, regionName: 'Domain' },
      ],
      // Behind the set editor's Solar System and Specific Station pickers. No
      // test opens those yet, so these were missing until the mock-contract
      // test named them - exactly the latent gap it exists to surface.
      //
      // Columns are the SDE's, verified against the real queries in
      // sde-database.js: mapSolarSystems yields solarSystemID/solarSystemName/
      // security/regionID, staStations yields stationID/stationName/
      // stationTypeID. The renderer reads those names FIRST and only then falls
      // back to camelCase aliases, so a mock using the aliases would exercise
      // the fallback branch and leave the real path untested.
      // Values are the real rows, read out of the SDE rather than invented -
      // security is the unrounded float the column actually stores.
      searchSystems: async () => [
        { solarSystemID: 30000142, solarSystemName: 'Jita', security: 0.945913, regionID: 10000002 },
        { solarSystemID: 30002187, solarSystemName: 'Amarr', security: 0.949, regionID: 10000043 },
      ],
      getStationsInSystem: async () => [
        {
          stationID: 60003760,
          stationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
          stationTypeID: 52678,
        },
      ],
      getTypeNames: async (ids) => {
        const known = { 34: 'Tritanium', 35: 'Pyerite', 36: 'Mexallon', 23911: 'Zydrine' };
        const map = {};
        ids.forEach((id) => {
          map[id] = known[id] || `Type ${id}`;
        });
        return map;
      },
      searchMarketItems: async (q) => {
        calls.push({ fn: 'search', q });
        return [
          { typeID: 34, typeName: 'Tritanium' },
          { typeID: 35, typeName: 'Pyerite' },
          { typeID: 36, typeName: 'Mexallon' },
        ].filter((r) => r.typeName.toLowerCase().includes(q.toLowerCase()));
      },
    },
    // The inspector links a character through to their Assets in a new window.
    // `window:openView` returns true; the caller ignores it, but the mock
    // matches the handler rather than inventing a shape.
    //
    // There is deliberately no `assets.openWindow` here: that method was
    // removed from preload with the pop-out work (opening a screen in its own
    // window is generic now), and a mock for a method nothing can call is
    // exactly the kind of stale fixture that outlives what it described.
    window: { openView: () => Promise.resolve(true) },
    data: null,
  };
}

/** Minimal ViewContext matching the shell's contract. */
function makeCtx() {
  const disposers = [];
  return {
    track: (d) => disposers.push(d),
    setInterval: () => 0,
    setTimeout: () => 0,
    on: (target, type, handler) => {
      target.addEventListener(type, handler);
      disposers.push(() => target.removeEventListener(type, handler));
    },
    dispose: () => disposers.forEach((d) => d && d()),
  };
}

/**
 * Mount the view and wait for its async load to settle.
 *
 * The renderer is a singleton IIFE holding module-level `state`, so it must be
 * re-required per test - otherwise the previously selected watchlist (and any
 * other state) leaks into the next test.
 */
/** Live ViewContext from the previous mount, disposed before the next one. */
let activeCtx = null;
/** The registered view definition, for its whenSettled(). See flush(). */
let activeView = null;

async function mount() {
  // The real ShellRouter calls destroy()/dispose() before mounting the next
  // view. Without that here, every mount leaves its document-level keydown
  // handler attached - after ~100 tests that is ~100 live Escape handlers, and
  // one Escape cascades through all of them.
  if (activeCtx) activeCtx.dispose();

  document.body.innerHTML = `<div id="host">${VIEW_HTML}</div>`;
  const host = document.getElementById('host');
  const ctx = makeCtx();
  activeCtx = ctx;

  let mountView;
  jest.isolateModules(() => {
    const registered = {};
    window.QFShell = { router: { register: (id, def) => { registered[id] = def; } } };
    require('../../../src/renderer/market-view-renderer.js');
    activeView = registered.market;
    mountView = registered.market.mount;
  });

  await mountView(host, {}, ctx);
  await flush();
  return ctx;
}

/**
 * Wait for the work a test just triggered.
 *
 * A DOM event handler cannot be awaited - the browser throws away an event
 * listener's return value - so clicking a button leaves an `async` handler
 * running with nothing to wait on. This used to be papered over by draining
 * the macrotask queue 12 times: slow (~1.4ms per hop in jsdom, ~230 calls a
 * run) and only probabilistically correct, since 12 was a guess.
 *
 * The renderer now registers those handler promises and exposes
 * `whenSettled()`, so this awaits the ACTUAL work rather than a number of
 * rounds. `activeView.whenSettled` is optional so this helper keeps working if
 * a mount fails before registration.
 *
 * The trailing microtask yield lets any synchronous re-render queued by the
 * settled handlers land before assertions run.
 */
async function flush() {
  if (activeView && typeof activeView.whenSettled === 'function') {
    await activeView.whenSettled();
  }
  await Promise.resolve();
}

/**
 * Register the suite-wide hooks.
 *
 * Called from each test file rather than run on require, so importing the
 * harness for a single helper does not silently install hooks a file did not
 * ask for.
 */
function installHooks() {
beforeAll(() => {
  // Load the real shared helpers rather than stubbing them, so these tests
  // also cover the renderer's integration with them.
  require('../../../public/shared/ui-helpers.js');
  require('../../../public/shared/freshness.js');
  require('../../../public/shared/toast.js');
  require('../../../public/shared/qf-search-select.js');
});

beforeEach(() => {
  // The renderer catches its own failures and logs them, so a missing IPC stub
  // or a broken call site produces console noise while every assertion still
  // passes. Capture console.error and fail the test on anything unexpected -
  // otherwise these tests are green without proving the view actually works.
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map(String).join(' '));
  });

  calls = [];
  prices = {
    34: { buy: 5, sell: 6 },
    35: { buy: 10, sell: 12 },
    36: { buy: 80, sell: 90 },
  };
  // Mirrors the real persisted shape: inputMaterials/outputProducts are pricing
  // CONFIG objects (location + method), NOT arrays of items. Getting this wrong
  // is what crashed renderPricing and blanked every panel after it.
  sets = [
    {
      // Real market set ids are opaque STRINGS, not numbers - a numeric
      // fixture hid a Number() coercion bug that nulled every binding.
      id: 'set-jita',
      name: 'Jita 4-4',
      isDefault: true,
      inputMaterials: { regionId: 10000002, locationId: 60003760, priceType: 'sell' },
      outputProducts: { regionId: 10000002, locationId: 60003760, priceType: 'buy' },
    },
    {
      id: 'set-amarr',
      name: 'Amarr',
      inputMaterials: { regionId: 10000043, locationId: 60008494, priceType: 'sell' },
      outputProducts: { regionId: 10000043, locationId: 60008494, priceType: 'buy' },
    },
  ];
  overrides = [];
  orderBook = {
    34: [
      { is_buy_order: 0, price: 6.0, volume_remain: 500 },
      { is_buy_order: 0, price: 6.2, volume_remain: 300 },
      { is_buy_order: 1, price: 5.0, volume_remain: 900 },
    ],
  };
  priceHistory = {
    34: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      average: 5 + i * 0.05,
      volume: 1000 + i,
    })),
  };
  fetchableHistory = {};
  historyGate = null;
  plansByType = {};
  relockResult = { success: true, overridden: false, marketPrice: 6.0, nodesUpdated: 1 };
  characters = [
    { characterId: 133585695, characterName: 'Buckwalter', portrait: null },
    { characterId: 1194303072, characterName: 'Roshcar', portrait: null },
  ];

  watchlists = [
    { id: 1, name: 'Mining Minerals', description: 'Core minerals', market_set_id: 'set-jita', item_count: 2 },
    { id: 2, name: 'Capital Components', description: null, market_set_id: 'set-amarr', item_count: 0 },
  ];
  items = {
    1: [
      // Two-sided anchored shape. Tritanium is baselined at its current
      // prices (no drift); Pyerite is baselined lower, so it has drifted up.
      {
        id: 10, type_id: 34,
        base_buy: 5, base_sell: 6, baseline_at: 1700000000000,
        buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, last_buy_alert_at: null,
        sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null, last_sell_alert_at: null,
      },
      {
        id: 11, type_id: 35,
        base_buy: 8, base_sell: 10, baseline_at: 1700000000000,
        buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, last_buy_alert_at: null,
        sell_alert_type: 'percent', sell_alert_direction: 'above', sell_alert_value: 50, last_sell_alert_at: null,
      },
    ],
    2: [],
  };
  window.electronAPI = makeApi();
});

afterEach(() => {
  // Tests that deliberately exercise an error path opt out via allowErrors().
  const unexpected = consoleErrors.filter((e) => !expectedErrorPatterns.some((p) => p.test(e)));
  expectedErrorPatterns = [];
  console.error.mockRestore();

  if (unexpected.length > 0) {
    throw new Error(
      `Renderer logged ${unexpected.length} unexpected error(s):\n  ` +
        unexpected.join('\n  ')
    );
  }
});
}

/** Declare that this test expects specific renderer errors. */
function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}


/* ------------------------------------------------------------------ *
 * QFSearchSelect helpers.
 *
 * The item searches are the shared component now, so tests drive its DOM
 * (.qf-ss-*) rather than the old hand-written .mk-combo markup. Keyboard,
 * hover and highlight behaviour is covered once in qf-search-select.test.js;
 * these only exercise the market-specific wiring.
 * ------------------------------------------------------------------ */

/** The QFSearchSelect trigger inside a mount host. */
function ssTrigger(hostId) {
  return document.querySelector(`#${hostId} .qf-ss-trigger`);
}

/** Open a mounted search select and type a query, letting the debounce fire. */
async function ssSearch(hostId, query) {
  const trigger = ssTrigger(hostId);
  expect(trigger).not.toBeNull();
  trigger.click();

  const input = document.querySelector('.qf-ss-popover .qf-ss-input');
  expect(input).not.toBeNull();
  input.value = query;
  input.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 250));
  await flush();
  return input;
}

/** Rows currently rendered in the open popover. */
function ssRows() {
  return [...document.querySelectorAll('.qf-ss-popover .qf-ss-row')];
}


/**
 * Choose a trade hub in a scope's QFSearchSelect (the picker is the shared
 * component now, so it is driven through its popover rather than a <select>).
 *
 * @param {'input'|'output'} scope
 * @param {string} labelFragment - Part of the hub's label, e.g. 'Jita'
 */
async function pickTradeHub(scope, labelFragment) {
  const trigger = document.querySelector(`#mk-scope-${scope} .qf-ss-trigger`);
  expect(trigger).not.toBeNull();
  trigger.click();

  const row = [...document.querySelectorAll('.qf-ss-popover .qf-ss-row')]
    .find((r) => r.textContent.includes(labelFragment));
  expect(row).not.toBeNull();
  row.click();
  await flush();
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

/**
 * Live view onto the fixture bindings above.
 *
 * Accessors, not a plain object: the fakes close over the bare `let`s, so a
 * test file assigning to a copied reference could mutate but never REPLACE a
 * fixture. Going through accessors makes `state.prices = {}` in a test file
 * rebind the very variable the fake reads.
 */
const state = {
  get watchlists() { return watchlists; },
  set watchlists(v) { watchlists = v; },
  get items() { return items; },
  set items(v) { items = v; },
  get prices() { return prices; },
  set prices(v) { prices = v; },
  get sets() { return sets; },
  set sets(v) { sets = v; },
  get overrides() { return overrides; },
  set overrides(v) { overrides = v; },
  get characters() { return characters; },
  set characters(v) { characters = v; },
  get orderBook() { return orderBook; },
  set orderBook(v) { orderBook = v; },
  get priceHistory() { return priceHistory; },
  set priceHistory(v) { priceHistory = v; },
  get fetchableHistory() { return fetchableHistory; },
  set fetchableHistory(v) { fetchableHistory = v; },
  get historyGate() { return historyGate; },
  set historyGate(v) { historyGate = v; },
  get plansByType() { return plansByType; },
  set plansByType(v) { plansByType = v; },
  get relockResult() { return relockResult; },
  set relockResult(v) { relockResult = v; },
  get calls() { return calls; },
  set calls(v) { calls = v; },
};

module.exports = {
  installHooks,
  state,
  VIEW_HTML,
  mount,
  flush,
  allowErrors,
  makeApi,
  makeCtx,
  ssTrigger,
  ssSearch,
  ssRows,
  pickTradeHub,
};
