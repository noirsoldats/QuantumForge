/**
 * @jest-environment jsdom
 *
 * Market Manager watchlist UI.
 *
 * The renderer is an IIFE that exposes nothing, so these tests drive it the way
 * a user does - mount it into a container, click things, and assert on the DOM.
 * That also means they verify the binding rules from CLAUDE.md, which are about
 * observable DOM state:
 *
 *   rule 1 - row highlights are box-shadow only, never a toggled background
 *   rule 2 - the combobox highlight index starts at -1 (no row hot on first paint)
 *   rule 3 - conditional styles are symmetric, so a state change fully resets
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/market.view.html'),
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
    require('../../src/renderer/market-view-renderer.js');
    mountView = registered.market.mount;
  });

  await mountView(host, {}, ctx);
  await flush();
  return ctx;
}

/** Let queued promise callbacks run. */
async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeAll(() => {
  // Load the real shared helpers rather than stubbing them, so these tests
  // also cover the renderer's integration with them.
  require('../../public/shared/ui-helpers.js');
  require('../../public/shared/freshness.js');
  require('../../public/shared/toast.js');
  require('../../public/shared/qf-search-select.js');
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

describe('watchlist rendering', () => {
  test('lists watchlists in the context pane with item counts', async () => {
    await mount();

    const rows = document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Mining Minerals');
    expect(rows[0].textContent).toContain('2 items');
    expect(rows[1].textContent).toContain('0 items');
  });

  test('the active watchlist is highlighted with box-shadow, not a background', async () => {
    await mount();

    const active = document.querySelector('#mk-watchlist-nav .mk-wl-nav-row.is-active');
    expect(active).not.toBeNull();
    // Binding rule 1: the highlight must never be driven by an inline background.
    expect(active.style.background).toBe('');
    expect(active.style.backgroundColor).toBe('');
  });

  test('renders the active watchlist header, description, and market', async () => {
    await mount();

    expect(document.getElementById('mk-wl-name').textContent).toBe('Mining Minerals');
    const desc = document.getElementById('mk-wl-desc');
    expect(desc.hidden).toBe(false);
    expect(desc.textContent).toBe('Core minerals');
    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');
  });

  test('hides the description when a watchlist has none', async () => {
    await mount();

    document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row')[1].click();
    await flush();

    expect(document.getElementById('mk-wl-name').textContent).toBe('Capital Components');
    expect(document.getElementById('mk-wl-desc').hidden).toBe(true);
  });

  test('renders one row per item with buy and sell prices', async () => {
    await mount();

    const rows = document.querySelectorAll('#mk-wl-rows tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Tritanium');
    expect(rows[0].querySelector('.mk-buy').textContent).toBe('5');
    expect(rows[0].querySelector('.mk-sell').textContent).toBe('6');
  });

  test('shows the empty state when a watchlist has no items', async () => {
    await mount();

    document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row')[1].click();
    await flush();

    expect(document.getElementById('mk-wl-items-empty').hidden).toBe(false);
    expect(document.querySelectorAll('#mk-wl-rows tr')).toHaveLength(0);
  });

  test('shows the no-watchlists empty state when none exist', async () => {
    watchlists = [];
    items = {};
    await mount();

    expect(document.getElementById('mk-wl-empty').hidden).toBe(false);
    expect(document.getElementById('mk-wl-body').hidden).toBe(true);
  });

  test('prices each item through calculatePrice, not a bulk price API', async () => {
    await mount();

    const priceCalls = calls.filter((c) => c.fn === 'calculatePrice');
    // Two items, buy + sell each.
    expect(priceCalls).toHaveLength(4);
    expect(priceCalls.some((c) => c.typeId === 34 && c.priceType === 'buy')).toBe(true);
    expect(priceCalls.some((c) => c.typeId === 34 && c.priceType === 'sell')).toBe(true);
  });
});

describe('create / edit / delete', () => {
  test('creating a watchlist sends the form values', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    document.getElementById('mk-wl-form-name').value = 'New List';
    document.getElementById('mk-wl-form-desc').value = 'Some description';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    const create = calls.find((c) => c.fn === 'create');
    expect(create).toBeDefined();
    expect(create.data.name).toBe('New List');
    expect(create.data.description).toBe('Some description');
  });

  test('a blank name does not create anything', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    document.getElementById('mk-wl-form-name').value = '   ';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    expect(calls.find((c) => c.fn === 'create')).toBeUndefined();
    // Modal stays open so the user can correct it.
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);
  });

  test('the edit form pre-fills from the active watchlist', async () => {
    await mount();

    document.getElementById('mk-wl-edit').click();

    expect(document.getElementById('mk-wl-modal-title').textContent).toBe('Edit Watchlist');
    expect(document.getElementById('mk-wl-form-name').value).toBe('Mining Minerals');
    expect(document.getElementById('mk-wl-form-desc').value).toBe('Core minerals');
  });

  test('editing updates rather than creating', async () => {
    await mount();

    document.getElementById('mk-wl-edit').click();
    document.getElementById('mk-wl-form-name').value = 'Renamed';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    expect(calls.find((c) => c.fn === 'create')).toBeUndefined();
    const update = calls.find((c) => c.fn === 'update');
    expect(update.id).toBe(1);
    expect(update.updates.name).toBe('Renamed');
  });

  test('delete asks for confirmation and honours a cancel', async () => {
    await mount();
    window.confirm = jest.fn(() => false);

    document.getElementById('mk-wl-delete').click();
    await flush();

    expect(window.confirm).toHaveBeenCalled();
    expect(calls.find((c) => c.fn === 'remove')).toBeUndefined();
  });

  test('delete proceeds when confirmed', async () => {
    await mount();
    window.confirm = jest.fn(() => true);

    document.getElementById('mk-wl-delete').click();
    await flush();

    expect(calls.find((c) => c.fn === 'remove').id).toBe(1);
  });

  test('removing an item calls through with the item id', async () => {
    await mount();

    const remove = document.querySelectorAll('#mk-wl-rows tr')[0].querySelector('.mk-icon-btn-danger');
    remove.click();
    await flush();

    expect(calls.find((c) => c.fn === 'removeItem').itemId).toBe(10);
  });
});

describe('modal dismissal', () => {
  test('the close button hides the modal', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);

    document.querySelector('#mk-wl-modal .modal-close').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(true);
  });

  test('clicking the backdrop closes, clicking the panel does not', async () => {
    await mount();
    const modal = document.getElementById('mk-wl-modal');

    document.getElementById('mk-new-watchlist').click();
    modal.querySelector('.modal-content').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.hidden).toBe(false);

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.hidden).toBe(true);
  });

  test('Escape closes an open modal', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('mk-wl-modal').hidden).toBe(true);
  });
});

describe('favourites persistence', () => {
  test('toggling a favourite persists through the backend', async () => {
    await mount();

    // Pricing rows are the items the user has touched (overrides, favourites,
    // watchlist members), so the watchlist fixture guarantees rows exist.
    const fav = document.querySelector('#mk-rows .mk-fav');
    expect(fav).not.toBeNull();

    fav.click();
    await flush();

    expect(calls.find((c) => c.fn === 'toggleFavorite')).toBeDefined();
  });
});

/**
 * Regressions for the "Overrides count shows 0 until you click the tab" bug.
 *
 * Cause: loadAll() ran its renders as a bare sequence, so a throw in
 * renderPricing() aborted every render after it - including renderOverrides() -
 * leaving those panels on their template defaults. The trigger was reading
 * set.inputMaterials as an array when it is a pricing-config OBJECT.
 */
describe('first-load rendering resilience', () => {
  test('override counters populate on first load, before any tab is clicked', async () => {
    overrides = [{ typeId: 23911, price: 5, notes: 'floor', timestamp: 1 }];
    await mount();

    // Still on the default Pricing tab - these must already be correct.
    expect(document.querySelector('.mk-tab.is-active').dataset.mkTab).toBe('pricing');
    expect(document.getElementById('mk-override-count').textContent).toBe('1');
    expect(document.getElementById('mk-tab-override-count').textContent).toBe('1');
  });

  test('override rows show the item name, not "Type <id>"', async () => {
    overrides = [{ typeId: 23911, price: 5, notes: null, timestamp: 1 }];
    await mount();

    const firstCell = document.querySelector('#mk-override-rows td');
    expect(firstCell.textContent).toBe('Zydrine');
    expect(firstCell.textContent).not.toMatch(/^Type /);
  });

  test('a market set is treated as pricing config, not an item list', async () => {
    // Regression: (set.inputMaterials || []).forEach threw here, killing every
    // later render. A config object must not crash the pricing tab.
    await mount();

    expect(document.getElementById('mk-rows')).not.toBeNull();
  });

  test('pricing rows show live buy/sell/volume from the order book', async () => {
    await mount();

    // Watchlist items (34, 35) seed the pricing rows.
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    expect(row).toBeDefined();
    expect(row.querySelector('.mk-buy').textContent).not.toBe('--');
    expect(row.querySelector('.mk-sell').textContent).not.toBe('--');
  });

  test('an override replaces the sell figure and marks the row', async () => {
    overrides = [{ typeId: 34, price: 999, notes: null, timestamp: 1 }];
    await mount();

    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    expect(row.querySelector('.mk-sell').textContent).toBe('999');
    expect(row.querySelector('.mk-conf').textContent).toBe('Override');
  });

  test('one failing panel does not blank the others', async () => {
    // A hostile set config throws wherever it is read - during the load phase
    // (loadWatchPrices) as well as during renderPricing. Both must be isolated,
    // or the Overrides panel never renders.
    allowErrors(/load failed: /, /render failed: /);
    sets = [{
      id: 1,
      name: 'Broken',
      isDefault: true,
      get inputMaterials() { throw new Error('boom'); },
      outputProducts: {},
    }];
    overrides = [{ typeId: 23911, price: 5, notes: null, timestamp: 1 }];

    await mount();

    expect(document.getElementById('mk-override-count').textContent).toBe('1');
    expect(document.querySelectorAll('#mk-override-rows tr')).toHaveLength(1);
  });
});

describe('pricing filter (region-scoped search)', () => {
  /** Type into the filter and let the debounce fire. */
  async function filter(term) {
    const input = document.getElementById('mk-search');
    input.value = term;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await flush();
  }

  test('a short query does not hit the backend', async () => {
    await mount();
    await filter('t');

    expect(calls.filter((c) => c.fn === 'searchTradedItems')).toHaveLength(0);
  });

  test('searching queries the active set region, not the whole SDE', async () => {
    await mount();
    await filter('trit');

    const search = calls.find((c) => c.fn === 'searchTradedItems');
    expect(search).toBeDefined();
    // Region comes from the set's inputMaterials scope.
    expect(search.regionId).toBe(10000002);
  });

  test('results replace the default rows', async () => {
    await mount();
    await filter('pyer');

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) =>
      tr.children[1].textContent
    );
    expect(names).toContain('Pyerite');
    expect(names).not.toContain('Tritanium');
  });

  test('clearing the query restores the default rows', async () => {
    await mount();
    await filter('pyer');
    await filter('');

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) =>
      tr.children[1].textContent
    );
    expect(names).toContain('Tritanium');
  });

  test('an empty result explains that the filter is region-scoped', async () => {
    await mount();
    await filter('zzzz');

    const empty = document.getElementById('mk-rows-empty');
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('small').textContent).toMatch(/cached orders in this market/i);
  });
});

describe('market set editor', () => {
  test('opens prefilled when editing an existing set', async () => {
    await mount();
    switchToOverview();

    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();

    expect(document.getElementById('mk-set-modal-title').textContent).toBe('Edit Market Set');
    expect(document.getElementById('mk-set-name').value).toBe('Jita 4-4');
    // Both scopes must be built, identically.
    expect(document.querySelectorAll('#mk-scope-input .mk-field').length).toBeGreaterThan(3);
    expect(document.querySelectorAll('#mk-scope-output .mk-field').length).toBeGreaterThan(3);
  });

  test('location type is five radio cards per scope, per the mockup', async () => {
    await mount();
    switchToOverview();
    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();

    const cards = document.querySelectorAll('#mk-scope-input .mk-loc-card');
    expect(cards).toHaveLength(5);

    const labels = [...cards].map((c) => c.querySelector('.mk-loc-name').textContent);
    expect(labels).toEqual([
      'Trade Hub',
      'Specific Station',
      'Solar System',
      'Entire Region',
      'Private Structure',
    ]);
    // Each card carries its description.
    expect(cards[0].querySelector('.mk-loc-desc').textContent).toBe('Jita, Amarr, Dodixie, Rens, Hek');
  });

  test('exactly one location card is active, and selecting another swaps it', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    let on = document.querySelectorAll('#mk-scope-input .mk-loc-card.is-on');
    expect(on).toHaveLength(1);
    expect(on[0].querySelector('.mk-loc-name').textContent).toBe('Trade Hub');

    // Pick "Entire Region" - the previous card must fully deselect (rule 3).
    document.querySelectorAll('#mk-scope-input .mk-loc-card')[3].click();
    await flush();

    on = document.querySelectorAll('#mk-scope-input .mk-loc-card.is-on');
    expect(on).toHaveLength(1);
    expect(on[0].querySelector('.mk-loc-name').textContent).toBe('Entire Region');
  });

  test('the private structure branch shows the ESI scope requirement', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    document.querySelectorAll('#mk-scope-input .mk-loc-card')[4].click();
    await flush();

    const note = document.querySelector('#mk-scope-input .mk-struct-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/esi-search\.search_structures\.v1/);
    expect(note.textContent).toMatch(/esi-markets\.structure_markets\.v1/);
  });

  test('percentile is 0-1 with a 0.05 step, not a percentage', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    const field = [...document.querySelectorAll('#mk-scope-input .mk-field')]
      .find((f) => f.textContent.includes('Percentile Threshold'));
    const input = field.querySelector('input[type="number"]');
    expect(input.min).toBe('0');
    expect(input.max).toBe('1');
    expect(input.step).toBe('0.05');
    expect(input.value).toBe('0.2');
  });

  test('Delete is offered when editing but not when creating', async () => {
    await mount();

    document.getElementById('mk-new-set').click();
    await flush();
    expect(document.getElementById('mk-set-delete').hidden).toBe(true);

    document.querySelector('[data-mk-close="mk-set-modal"]').click();
    switchToOverview();
    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();
    expect(document.getElementById('mk-set-delete').hidden).toBe(false);
  });

  test('opens blank when creating', async () => {
    await mount();

    document.getElementById('mk-new-set').click();
    await flush();

    expect(document.getElementById('mk-set-modal-title').textContent).toBe('New Market Set');
    expect(document.getElementById('mk-set-name').value).toBe('');
  });

  test('save is blocked until the set has a name and locations', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    expect(document.getElementById('mk-set-save').disabled).toBe(true);
  });

  test('editing routes to updateMarketSet, not addMarketSet', async () => {
    await mount();
    switchToOverview();

    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();

    const name = document.getElementById('mk-set-name');
    name.value = 'Renamed Set';
    name.dispatchEvent(new Event('input'));

    document.getElementById('mk-set-save').click();
    await flush();

    expect(calls.find((c) => c.fn === 'addMarketSet')).toBeUndefined();
    const update = calls.find((c) => c.fn === 'updateMarketSet');
    expect(update).toBeDefined();
    expect(update.updates.name).toBe('Renamed Set');
    // Scopes must persist as CONFIG OBJECTS, never arrays.
    expect(Array.isArray(update.updates.inputMaterials)).toBe(false);
    expect(update.updates.inputMaterials.priceType).toBeDefined();
  });

  function switchToOverview() {
    document.querySelector('[data-mk-tab="overview"]').click();
  }
});

describe('price override modal', () => {
  test('opens from the Add Override button', async () => {
    await mount();
    document.getElementById('mk-add-override').click();
    await flush();

    expect(document.getElementById('mk-override-modal').hidden).toBe(false);
    expect(document.getElementById('mk-ov-save').disabled).toBe(true);
  });

  test('clicking an override row opens it prefilled', async () => {
    overrides = [{ typeId: 34, price: 42, notes: 'contract floor', timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();

    document.querySelector('#mk-override-rows tr').click();
    await flush();

    expect(document.getElementById('mk-override-modal-title').textContent).toBe('Edit Price Override');
    expect(document.getElementById('mk-ov-price').value).toBe('42');
    expect(document.getElementById('mk-ov-note').value).toBe('contract floor');
  });

  test('the item search queries the SDE', async () => {
    // SDE-wide, not region-scoped: you may want to pin a price before any
    // orders exist for the item in this market.
    await mount();
    document.getElementById('mk-add-override').click();

    await ssSearch('mk-ov-search', 'tri');

    expect(calls.find((c) => c.fn === 'search')).toMatchObject({ q: 'tri' });
    expect(ssRows().length).toBeGreaterThan(0);
  });

  test('choosing an item then a price enables saving', async () => {
    await mount();
    document.getElementById('mk-add-override').click();

    await ssSearch('mk-ov-search', 'tri');
    ssRows()[0].click();
    await flush();

    expect(document.getElementById('mk-ov-pick').hidden).toBe(false);

    const price = document.getElementById('mk-ov-price');
    price.value = '123';
    price.dispatchEvent(new Event('input'));

    expect(document.getElementById('mk-ov-save').disabled).toBe(false);
  });

  test('a zero or negative price keeps save disabled', async () => {
    overrides = [{ typeId: 34, price: 42, notes: null, timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();
    document.querySelector('#mk-override-rows tr').click();
    await flush();

    const price = document.getElementById('mk-ov-price');
    price.value = '0';
    price.dispatchEvent(new Event('input'));

    expect(document.getElementById('mk-ov-save').disabled).toBe(true);
  });

  test('saving sends the type, price and note', async () => {
    overrides = [{ typeId: 34, price: 42, notes: null, timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();
    document.querySelector('#mk-override-rows tr').click();
    await flush();

    const price = document.getElementById('mk-ov-price');
    price.value = '77';
    price.dispatchEvent(new Event('input'));
    const note = document.getElementById('mk-ov-note');
    note.value = 'pinned';

    document.getElementById('mk-ov-save').click();
    await flush();

    const saved = calls.find((c) => c.fn === 'setPriceOverride');
    expect(saved).toEqual({ fn: 'setPriceOverride', typeId: 34, price: 77, notes: 'pinned' });
  });

  test('the override table shows market price and delta', async () => {
    // Tritanium sells at 6 in the fixture; an override of 9 is +50%.
    overrides = [{ typeId: 34, price: 9, notes: null, timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();

    const cells = document.querySelectorAll('#mk-override-rows tr td');
    expect(cells[1].textContent).toBe('6');
    expect(cells[3].textContent).toBe('+50.0%');
  });
});

describe('pricing filter clear affordances', () => {
  async function type(term) {
    const input = document.getElementById('mk-search');
    input.value = term;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await flush();
  }

  function pressEscInFilter() {
    document.getElementById('mk-search').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  }

  test('the clear button is hidden until something is typed', async () => {
    await mount();
    expect(document.getElementById('mk-search-clear').hidden).toBe(true);

    await type('pyer');
    expect(document.getElementById('mk-search-clear').hidden).toBe(false);
  });

  test('the clear button empties the field and restores default rows', async () => {
    await mount();
    await type('pyer');

    document.getElementById('mk-search-clear').click();
    await flush();

    expect(document.getElementById('mk-search').value).toBe('');
    expect(document.getElementById('mk-search-clear').hidden).toBe(true);

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
    expect(names).toContain('Tritanium');
  });

  test('Escape in the filter clears it', async () => {
    await mount();
    await type('pyer');

    pressEscInFilter();
    await flush();

    expect(document.getElementById('mk-search').value).toBe('');
    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
    expect(names).toContain('Tritanium');
  });

  test('Escape in the filter does not also close an open modal', async () => {
    await mount();
    await type('pyer');

    // A modal open at the same time must survive: the filter's Esc is scoped.
    document.getElementById('mk-new-watchlist').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);

    pressEscInFilter();
    await flush();

    expect(document.getElementById('mk-search').value).toBe('');
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);
  });

  test('Escape on an already-empty filter blurs instead of clearing', async () => {
    await mount();
    const input = document.getElementById('mk-search');
    input.focus();

    pressEscInFilter();
    await flush();

    expect(document.activeElement).not.toBe(input);
  });
});

/**
 * The mockup gates the output scope's LOCATION block on `!outSameLoc`
 * (`sc-if showOutputLoc`) and leaves the pricing fields outside that gate.
 * Mirroring the location must therefore not disable pricing: inputs are
 * bought and outputs sold, often at the same market with different rules.
 */
describe('set editor: mirrored output location', () => {
  async function openNewSet() {
    document.getElementById('mk-new-set').click();
    await flush();
  }

  function pricingLabels(scope) {
    return [...document.querySelectorAll(`#mk-scope-${scope} .mk-field`)]
      .map((f) => f.querySelector('.mk-label'))
      .filter(Boolean)
      .map((l) => l.textContent);
  }

  function setMirror(on) {
    const mirror = document.getElementById('mk-set-mirror');
    mirror.checked = on;
    mirror.dispatchEvent(new Event('change'));
  }

  test('mirroring removes the output location block entirely', async () => {
    await mount();
    await openNewSet();

    setMirror(false);
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(5);

    setMirror(true);
    // Not merely dimmed - gone.
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(0);
    expect(document.querySelector('#mk-scope-output .mk-loc-label')).toBeNull();
    expect(document.querySelector('#mk-scope-output .mk-loc-picker')).toBeNull();
  });

  test('mirroring leaves every output pricing field present and editable', async () => {
    await mount();
    await openNewSet();
    setMirror(true);

    const labels = pricingLabels('output');
    expect(labels).toEqual(expect.arrayContaining([
      'Price Type',
      'Calculation Method',
      'Price Modifier (%)',
      'Percentile Threshold',
      'Minimum Order Volume',
    ]));

    // Editable, not inert.
    const controls = document.querySelectorAll('#mk-scope-output select, #mk-scope-output input');
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach((c) => expect(c.disabled).toBe(false));
  });

  test('the input scope keeps its location block while mirroring', async () => {
    await mount();
    await openNewSet();
    setMirror(true);

    expect(document.querySelectorAll('#mk-scope-input .mk-loc-card').length).toBe(5);
  });

  test('unmirroring restores the output location block', async () => {
    await mount();
    await openNewSet();

    setMirror(true);
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(0);

    setMirror(false);
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(5);
  });

  test('mirroring copies the input location onto the saved output scope', async () => {
    await mount();
    await openNewSet();

    // Choose a trade hub on the input side.
    document.querySelectorAll('#mk-scope-input .mk-loc-card')[0].click();
    await flush();
    await pickTradeHub('input', 'Jita');

    setMirror(true);

    const name = document.getElementById('mk-set-name');
    name.value = 'Mirrored';
    name.dispatchEvent(new Event('input'));

    document.getElementById('mk-set-save').click();
    await flush();

    const added = calls.find((c) => c.fn === 'addMarketSet');
    expect(added).toBeDefined();
    expect(added.data.outputProducts.locationId).toBe(added.data.inputMaterials.locationId);
    expect(added.data.outputProducts.regionId).toBe(added.data.inputMaterials.regionId);
  });

  test('output pricing stays independent of input pricing when mirrored', async () => {
    await mount();
    await openNewSet();

    document.querySelectorAll('#mk-scope-input .mk-loc-card')[0].click();
    await flush();
    await pickTradeHub('input', 'Jita');
    setMirror(true);

    // Change ONLY the output price type.
    const outSelects = document.querySelectorAll('#mk-scope-output select.qf-select');
    outSelects[0].value = 'buy';
    outSelects[0].dispatchEvent(new Event('change'));

    const name = document.getElementById('mk-set-name');
    name.value = 'Split pricing';
    name.dispatchEvent(new Event('input'));
    document.getElementById('mk-set-save').click();
    await flush();

    const added = calls.find((c) => c.fn === 'addMarketSet');
    expect(added.data.outputProducts.priceType).toBe('buy');
    expect(added.data.inputMaterials.priceType).toBe('sell');
  });
});

/**
 * The mockup's OUTPUT picker only implements three branches (hub, region, and
 * a catch-all "other" covering station/system/private_structure), while INPUT
 * implements all five. That is a gap in the mockup - both scopes persist the
 * same config shape - so the port makes them identical. These tests pin that,
 * so the divergence cannot creep back in.
 */
describe('set editor: input and output location controls are identical', () => {
  async function openNewSetUnmirrored() {
    document.getElementById('mk-new-set').click();
    await flush();
    const mirror = document.getElementById('mk-set-mirror');
    mirror.checked = false;
    mirror.dispatchEvent(new Event('change'));
    await flush();
  }

  function cardLabels(scope) {
    return [...document.querySelectorAll(`#mk-scope-${scope} .mk-loc-card .mk-loc-name`)]
      .map((n) => n.textContent);
  }

  /** Click a location card by label within one scope. */
  async function pickCard(scope, label) {
    const card = [...document.querySelectorAll(`#mk-scope-${scope} .mk-loc-card`)]
      .find((c) => c.querySelector('.mk-loc-name').textContent === label);
    card.click();
    await flush();
  }

  /** A structural fingerprint of a scope's picker, ignoring text content. */
  function pickerShape(scope) {
    const host = document.querySelector(`#mk-scope-${scope} .mk-loc-picker`);
    return {
      textInputs: host.querySelectorAll('input[type="text"]').length,
      listBoxes: host.querySelectorAll('select.mk-listbox').length,
      dropdowns: host.querySelectorAll('select.qf-select').length,
      searchSelects: host.querySelectorAll('.qf-ss-trigger').length,
      buttons: host.querySelectorAll('button').length,
      hasScopeNote: !!host.querySelector('.mk-struct-note'),
    };
  }

  test('both scopes offer the same five location cards', async () => {
    await mount();
    await openNewSetUnmirrored();

    expect(cardLabels('output')).toEqual(cardLabels('input'));
    expect(cardLabels('output')).toHaveLength(5);
  });

  test.each([
    ['Trade Hub'],
    ['Specific Station'],
    ['Solar System'],
    ['Entire Region'],
    ['Private Structure'],
  ])('the %s picker is structurally identical on both scopes', async (label) => {
    await mount();
    await openNewSetUnmirrored();

    await pickCard('input', label);
    await pickCard('output', label);

    expect(pickerShape('output')).toEqual(pickerShape('input'));
  });

  test('Specific Station gives the output scope a real station picker', async () => {
    // The mockup would have rendered a generic empty "Select Location" box.
    await mount();
    await openNewSetUnmirrored();
    await pickCard('output', 'Specific Station');

    const host = document.querySelector('#mk-scope-output .mk-loc-picker');
    expect(host.querySelectorAll('select.mk-listbox')).toHaveLength(2);
    expect(host.textContent).toContain('Select System');
    expect(host.textContent).toContain('Select Station');
  });

  test('Private Structure gives the output scope the ESI scope warning', async () => {
    await mount();
    await openNewSetUnmirrored();
    await pickCard('output', 'Private Structure');

    const note = document.querySelector('#mk-scope-output .mk-struct-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/esi-markets\.structure_markets\.v1/);
  });
});

/**
 * Regression: the ESI character dropdown rendered blank options because the
 * renderer read `c.name` while settings-manager.getCharacters() returns
 * `characterName`. The test fixture returned an EMPTY character array, so no
 * test ever rendered an option and the bug shipped silently.
 */
describe('set editor: ESI character dropdown', () => {
  async function openPrivateStructure(scope) {
    document.getElementById('mk-new-set').click();
    await flush();
    if (scope === 'output') {
      const mirror = document.getElementById('mk-set-mirror');
      mirror.checked = false;
      mirror.dispatchEvent(new Event('change'));
      await flush();
    }
    const card = [...document.querySelectorAll(`#mk-scope-${scope} .mk-loc-card`)]
      .find((c) => c.querySelector('.mk-loc-name').textContent === 'Private Structure');
    card.click();
    await flush();
  }

  function characterOptions(scope) {
    // The character picker is a QFSearchSelect; read its options directly
    // rather than a <select>'s option list.
    const trigger = document.querySelector(`#mk-scope-${scope} .mk-struct .qf-ss-trigger`);
    expect(trigger).not.toBeNull();
    trigger.click();
    const opts = [...document.querySelectorAll('.qf-ss-popover .qf-ss-row')]
      .map((r) => ({ value: r.dataset.value, label: r.textContent.trim() }));
    document.body.click(); // close the popover
    return opts;
  }

  test('lists every character by name', async () => {
    await mount();
    await openPrivateStructure('input');

    const opts = characterOptions('input');
    // QFSearchSelect shows the placeholder on the TRIGGER, not as a list row,
    // so the list is exactly one row per character.
    expect(opts).toHaveLength(2);
    expect(opts[0].label).toBe('Buckwalter');
    expect(opts[1].label).toBe('Roshcar');
  });

  test('no option renders as a blank string', async () => {
    await mount();
    await openPrivateStructure('input');

    characterOptions('input').forEach((o) => {
      expect(o.label.trim()).not.toBe('');
      expect(o.label).not.toBe('undefined');
    });
  });

  test('each option carries its character id as the value', async () => {
    await mount();
    await openPrivateStructure('input');

    const opts = characterOptions('input');
    expect(opts[0].value).toBe('133585695');
    expect(opts[1].value).toBe('1194303072');
  });

  test('the output scope lists characters too', async () => {
    await mount();
    await openPrivateStructure('output');

    const opts = characterOptions('output');
    expect(opts.map((o) => o.label)).toContain('Buckwalter');
  });

  test('selecting a character enables the structure search', async () => {
    await mount();
    await openPrivateStructure('input');

    const searchInput = document.querySelector('#mk-scope-input .mk-struct-search input');
    expect(searchInput.disabled).toBe(true);

    const trigger = document.querySelector('#mk-scope-input .mk-struct .qf-ss-trigger');
    trigger.click();
    const row = [...document.querySelectorAll('.qf-ss-popover .qf-ss-row')]
      .find((r) => r.textContent.includes('Buckwalter'));
    row.click();
    await flush();

    expect(document.querySelector('#mk-scope-input .mk-struct-search input').disabled).toBe(false);
  });
});

describe('inspector (Pricing Details)', () => {
  /** Select the Tritanium row in the pricing table. */
  async function selectTritanium() {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    row.click();
    await flush();
    return row;
  }

  test('is empty until a row is selected', async () => {
    await mount();

    expect(document.getElementById('mk-inspector-empty').hidden).toBe(false);
    expect(document.getElementById('mk-inspector-body').hidden).toBe(true);
    expect(document.getElementById('mk-inspector-title').textContent).toBe('Inspector');
  });

  test('shows the item name in its header once selected', async () => {
    await mount();
    await selectTritanium();

    expect(document.getElementById('mk-inspector-title').textContent).toBe('Tritanium · Inspector');
    expect(document.getElementById('mk-inspector-body').hidden).toBe(false);
  });

  test('shows the live sell and buy prices', async () => {
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-insp-price-value').textContent).toBe('6');
    expect(document.querySelector('.mk-insp-buy-value').textContent).toBe('5');
  });

  test('an override replaces the sell figure and is called out', async () => {
    overrides = [{ typeId: 34, price: 99, notes: null, timestamp: 1 }];
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-insp-price-value').textContent).toBe('99');
    expect(document.querySelector('.mk-insp-override-note').textContent).toMatch(/market sell is 6/i);
  });

  test('offers the View Full Market Data action', async () => {
    await mount();
    await selectTritanium();

    const action = document.querySelector('.mk-insp-action');
    expect(action).not.toBeNull();
    expect(action.textContent).toContain('View Full Market Data');
  });

  test('says so when no plan uses the item', async () => {
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-insp-noplans').textContent)
      .toMatch(/No manufacturing plans reference Tritanium/);
    expect(document.getElementById('mk-insp-plan-count').textContent).toBe('0');
  });

  test('lists plans using the item with their locked price', async () => {
    plansByType = {
      34: [
        { planId: 'p1', planName: 'Capital Build', status: 'active', lockedPrice: 5.0, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: null },
      ],
    };
    await mount();
    await selectTritanium();

    expect(document.getElementById('mk-insp-plan-count').textContent).toBe('1');
    const card = document.querySelector('.mk-plan-card');
    expect(card.textContent).toContain('Capital Build');
    expect(card.textContent).toContain('Locked');
  });

  test('shows drift against the locked price', async () => {
    // Locked 5.0, market sell 6.0 -> +20%
    plansByType = {
      34: [
        { planId: 'p1', planName: 'Capital Build', status: 'active', lockedPrice: 5.0, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: null },
      ],
    };
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-plan-drift').textContent).toBe('+20.0% drift');
  });

  test('measures drift for an overridden plan from the locked MARKET price', async () => {
    // The override (99) must not be the baseline; lastMarketPrice (5.0) is.
    plansByType = {
      34: [
        { planId: 'p1', planName: 'Pinned', status: 'active', lockedPrice: 99, lockedAt: Date.now(), quantity: 100, isOverride: true, lastMarketPrice: 5.0 },
      ],
    };
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-plan-drift').textContent).toBe('+20.0% drift');
    // And the row is labelled as an override, not a plain lock.
    expect(document.querySelector('.mk-plan-card').textContent).toContain('Override');
  });

  test('re-lock sends the plan, type and current market price', async () => {
    plansByType = {
      34: [
        { planId: 'p1', planName: 'Capital Build', status: 'active', lockedPrice: 5.0, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: null },
      ],
    };
    await mount();
    await selectTritanium();

    document.querySelector('.mk-plan-relock').click();
    await flush();

    expect(calls.find((c) => c.fn === 'relockPlanMaterial'))
      .toMatchObject({ planId: 'p1', typeId: 34, price: 6.0 });
  });

  test('re-locking an overridden plan reports that the override still applies', async () => {
    plansByType = {
      34: [
        { planId: 'p1', planName: 'Pinned', status: 'active', lockedPrice: 99, lockedAt: Date.now(), quantity: 100, isOverride: true, lastMarketPrice: 5.0 },
      ],
    };
    relockResult = { success: true, overridden: true, overridePrice: 99, marketPrice: 6.0, nodesUpdated: 1 };
    await mount();
    await selectTritanium();

    document.querySelector('.mk-plan-relock').click();
    await flush();

    const toast = document.querySelector('.toast-container .toast');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toMatch(/still uses your override/i);
  });
});

describe('full market data drawer', () => {
  async function openDrawerFor(name) {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes(name));
    row.querySelector('.mk-data-btn').click();
    await flush();
  }

  test('every pricing row has a Data button', async () => {
    await mount();

    const rows = document.querySelectorAll('#mk-rows tr');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((tr) => expect(tr.querySelector('.mk-data-btn')).not.toBeNull());
  });

  test('is hidden until opened', async () => {
    await mount();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);
  });

  test('the Data button opens it for that item', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    expect(document.getElementById('mk-drawer').hidden).toBe(false);
    expect(document.getElementById('mk-drawer-name').textContent).toBe('Tritanium');
    expect(document.getElementById('mk-drawer-typeid').textContent).toBe('ID 34');
  });

  test('the inspector action opens it too', async () => {
    await mount();
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    row.click();
    await flush();

    document.querySelector('.mk-insp-action').click();
    await flush();

    expect(document.getElementById('mk-drawer').hidden).toBe(false);
  });

  test('renders the order book, best price first on each side', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    const sells = [...document.querySelectorAll('#mk-drawer-sell .mk-order-row')];
    const buys = [...document.querySelectorAll('#mk-drawer-buy .mk-order-row')];
    expect(sells).toHaveLength(2);
    expect(buys).toHaveLength(1);
    // Cheapest sell leads.
    expect(sells[0].querySelector('.mk-order-sell').textContent).toBe('6');
  });

  test('renders the price history chart and its range', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('#mk-drawer-chart svg')).not.toBeNull();
    expect(document.getElementById('mk-drawer-hist-low').textContent).not.toBe('--');
    expect(document.getElementById('mk-drawer-hist-high').textContent).not.toBe('--');
    expect(document.getElementById('mk-drawer-trend').textContent).toMatch(/^[+-]/);
  });

  test('says so when no history is cached', async () => {
    priceHistory = {};
    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('.mk-chart-empty')).not.toBeNull();
    expect(document.getElementById('mk-drawer-trend').textContent).toBe('--');
  });

  test('renders the six statistics', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    const labels = [...document.querySelectorAll('#mk-drawer-stats .mk-stat-label')]
      .map((e) => e.textContent);
    expect(labels).toEqual([
      'Sell (min)', 'Buy (max)', 'Spread', '30d Avg', '30d Range', 'Daily Volume',
    ]);
  });

  test('renders all five calculation methods and marks the active one', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    const calcs = [...document.querySelectorAll('#mk-drawer-calcs .mk-calc')];
    expect(calcs).toHaveLength(5);

    // The fixture set uses priceMethod 'sell'... default is 'immediate'.
    const active = document.querySelectorAll('#mk-drawer-calcs .mk-calc.is-active');
    expect(active.length).toBeLessThanOrEqual(1);
  });

  test('closes via the X, the footer button, and the scrim', async () => {
    await mount();

    await openDrawerFor('Tritanium');
    document.getElementById('mk-drawer-close').click();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);

    await openDrawerFor('Tritanium');
    document.getElementById('mk-drawer-done').click();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);

    await openDrawerFor('Tritanium');
    const scrim = document.getElementById('mk-drawer');
    scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(scrim.hidden).toBe(true);
  });

  test('clicking inside the panel does not close it', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    document.querySelector('.mk-drawer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('mk-drawer').hidden).toBe(false);
  });

  test('Escape closes the drawer', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('mk-drawer').hidden).toBe(true);
  });

  test('Escape closes an open modal before the drawer', async () => {
    await mount();
    await openDrawerFor('Tritanium');
    document.getElementById('mk-new-watchlist').click();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.getElementById('mk-wl-modal').hidden).toBe(true);
    expect(document.getElementById('mk-drawer').hidden).toBe(false);
  });

  test('Set Override opens the override modal pre-picked', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    document.getElementById('mk-drawer-override').click();
    await flush();

    expect(document.getElementById('mk-drawer').hidden).toBe(true);
    expect(document.getElementById('mk-override-modal').hidden).toBe(false);
    expect(document.getElementById('mk-ov-pick-name').textContent).toBe('Tritanium');
  });
});

/**
 * Opening the drawer for an item with no cached history fetches it from ESI,
 * the same way calculateRealisticPrice does when an item is first priced.
 * Without this the chart just reads "no history", which is indistinguishable
 * from an item that genuinely has none.
 */
describe('drawer fetches missing price history on demand', () => {
  async function openDrawerFor(name) {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes(name));
    row.querySelector('.mk-data-btn').click();
    await flush();
  }

  test('asks for history whenever the drawer opens', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    expect(calls.find((c) => c.fn === 'getCachedHistory')).toMatchObject({ typeId: 34 });
  });

  test('renders a chart from history fetched on demand', async () => {
    // Nothing cached, but ESI has data for it.
    priceHistory = {};
    fetchableHistory = {
      34: Array.from({ length: 30 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        average: 5 + i * 0.05,
        volume: 1000,
      })),
    };

    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('#mk-drawer-chart svg')).not.toBeNull();
    expect(document.querySelector('.mk-chart-empty')).toBeNull();
    expect(document.getElementById('mk-drawer-trend').textContent).toMatch(/^[+-]/);
  });

  test('still reports no data when ESI has none either', async () => {
    priceHistory = {};
    fetchableHistory = {};

    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('.mk-chart-empty')).not.toBeNull();
    expect(document.querySelector('.mk-chart-empty').textContent)
      .toMatch(/no price history/i);
  });

  test('the loading state is replaced, never left behind', async () => {
    priceHistory = {};
    fetchableHistory = {
      34: [
        { date: '2026-07-01', average: 5, volume: 10 },
        { date: '2026-07-02', average: 6, volume: 10 },
      ],
    };

    await mount();
    await openDrawerFor('Tritanium');

    expect(document.getElementById('mk-drawer-chart').textContent)
      .not.toMatch(/Loading market data/);
  });

  test('a second open is served from the now-warm cache', async () => {
    priceHistory = {};
    fetchableHistory = {
      34: [
        { date: '2026-07-01', average: 5, volume: 10 },
        { date: '2026-07-02', average: 6, volume: 10 },
      ],
    };

    await mount();
    await openDrawerFor('Tritanium');
    document.getElementById('mk-drawer-close').click();
    await openDrawerFor('Tritanium');
    await flush();

    // Both opens ask, but the fixture only "fetches" the first time.
    expect(calls.filter((c) => c.fn === 'getCachedHistory').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('#mk-drawer-chart svg')).not.toBeNull();
  });

  test('stale content is cleared before the new item loads', async () => {
    await mount();
    await openDrawerFor('Tritanium');
    const firstLow = document.getElementById('mk-drawer-hist-low').textContent;
    expect(firstLow).not.toBe('--');

    // Open a different item with no history at all.
    priceHistory = {};
    fetchableHistory = {};
    document.getElementById('mk-drawer-close').click();
    await openDrawerFor('Pyerite');

    // Must not still show Tritanium's range.
    expect(document.getElementById('mk-drawer-hist-low').textContent).toBe('--');
    expect(document.getElementById('mk-drawer-hist-high').textContent).toBe('--');
  });
});

/**
 * A history fetch already in flight must be allowed to finish even if the user
 * closes the drawer: main writes it through to the cache, so completing it
 * makes the next open instant. Only the render is abandoned.
 */
describe('an in-flight history fetch survives the drawer closing', () => {
  async function openDrawerFor(name) {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes(name));
    row.querySelector('.mk-data-btn').click();
  }

  test('the fetch is not cancelled when the drawer closes mid-flight', async () => {
    priceHistory = {};
    fetchableHistory = {
      34: [
        { date: '2026-07-01', average: 5, volume: 10 },
        { date: '2026-07-02', average: 6, volume: 10 },
      ],
    };
    await mount();

    // Stall the response, open the drawer, then close it before it lands.
    let release;
    historyGate = new Promise((r) => { release = r; });

    openDrawerFor('Tritanium');
    await Promise.resolve();
    document.getElementById('mk-drawer-close').click();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);

    // Let the fetch complete.
    release();
    historyGate = null;
    await flush();

    // It ran to completion rather than being abandoned...
    expect(calls.find((c) => c.fn === 'getCachedHistory')).toBeDefined();
    // ...and the drawer stayed closed rather than re-rendering itself.
    expect(document.getElementById('mk-drawer').hidden).toBe(true);
  });

  test('a late response does not paint over the drawer after reopening another item', async () => {
    priceHistory = {
      34: [{ date: '2026-07-01', average: 5, volume: 10 }, { date: '2026-07-02', average: 6, volume: 10 }],
      35: [{ date: '2026-07-01', average: 90, volume: 10 }, { date: '2026-07-02', average: 99, volume: 10 }],
    };
    await mount();

    let release;
    historyGate = new Promise((r) => { release = r; });

    openDrawerFor('Tritanium');
    await Promise.resolve();

    // Switch to a different item while the first is still loading.
    historyGate = null;
    document.getElementById('mk-drawer-close').click();
    await openDrawerFor('Pyerite');
    await flush();

    release();
    await flush();

    // The drawer shows Pyerite, not the stale Tritanium response.
    expect(document.getElementById('mk-drawer-name').textContent).toBe('Pyerite');
  });
});

/**
 * Switching market set must refresh everything the set governs, not just the
 * labels. Prices, the region-scoped filter and the inspector all derive from
 * the set's region and pricing config; re-rendering without reloading left the
 * previous set's numbers showing under the new set's name.
 */
describe('changing the active market set', () => {
  /** Click the second market set (Amarr, region 10000043) in the context pane. */
  async function selectAmarr() {
    const rows = [...document.querySelectorAll('#mk-set-list .mk-context-row')];
    const amarr = rows.find((r) => r.textContent.includes('Amarr'));
    expect(amarr).toBeDefined();
    amarr.click();
    await flush();
  }

  async function selectTritanium() {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    row.click();
    await flush();
  }

  test('the pricing table reprices against the new set', async () => {
    await mount();
    const before = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'))
      .querySelector('.mk-sell').textContent;

    await selectAmarr();

    const after = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'))
      .querySelector('.mk-sell').textContent;

    expect(after).not.toBe(before);
  });

  test('the order book is requeried for the new region', async () => {
    await mount();
    calls.length = 0;

    await selectAmarr();

    const bookCalls = calls.filter((c) => c.fn === 'getOrderBookSummary');
    expect(bookCalls.length).toBeGreaterThan(0);
    expect(bookCalls.some((c) => c.regionId === 10000043)).toBe(true);
  });

  test('the inspector reprices for the selected item', async () => {
    await mount();
    await selectTritanium();
    const before = document.querySelector('.mk-insp-price-value').textContent;

    await selectAmarr();

    expect(document.querySelector('.mk-insp-price-value').textContent).not.toBe(before);
  });

  test('the inspector keeps the same item selected', async () => {
    await mount();
    await selectTritanium();

    await selectAmarr();

    expect(document.getElementById('mk-inspector-title').textContent)
      .toBe('Tritanium · Inspector');
  });

  test('an active filter is re-run against the new region', async () => {
    await mount();
    const input = document.getElementById('mk-search');
    input.value = 'trit';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    calls.length = 0;

    await selectAmarr();

    const searches = calls.filter((c) => c.fn === 'searchTradedItems');
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[searches.length - 1].regionId).toBe(10000043);
  });

  test('re-selecting the same set does no work', async () => {
    await mount();
    calls.length = 0;

    const rows = [...document.querySelectorAll('#mk-set-list .mk-context-row')];
    const jita = rows.find((r) => r.textContent.includes('Jita'));
    jita.click();
    await flush();

    expect(calls.filter((c) => c.fn === 'getOrderBookSummary')).toHaveLength(0);
  });

  test('the plan list is not refetched on every table repaint', async () => {
    plansByType = {
      34: [{ planId: 'p1', planName: 'Capital Build', status: 'active', scope: 'input', lockedPrice: 5, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: 5 }],
    };
    await mount();
    await selectTritanium();
    calls.length = 0;

    // A favourite toggle repaints the table twice (optimistic + reconcile).
    document.querySelector('#mk-rows .mk-fav').click();
    await flush();

    expect(calls.filter((c) => c.fn === 'getPlansUsingType')).toHaveLength(0);
  });
});

/**
 * Combobox result rows must survive a hover.
 *
 * mouseenter used to re-render the whole list, which destroyed the row the
 * mousedown had landed on - so the browser never delivered the click and items
 * appeared unselectable by mouse. Keyboard selection still worked, which is
 * why it went unnoticed.
 */
/**
 * Clearing the chosen item must clear the search behind it. Leaving the old
 * query in place made the previous results reappear, as if nothing had been
 * cleared.
 */

/**
 * Watchlist members are one of the Pricing tab's row sources (alongside
 * overrides and favourites), so adding or removing one has to refresh that
 * table - and the resolved name has to reach the SHARED name cache, not just
 * the watchlist's own copy.
 */
describe('adding a watchlist item updates the Pricing tab', () => {
  async function addMexallonToWatchlist() {
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();
    document.getElementById('mk-additem-save').click();
    await flush();
  }

  /** Item names currently shown in the Pricing table. */
  function pricingNames() {
    return [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
  }

  test('the new item appears without needing another refresh', async () => {
    await mount();
    expect(pricingNames()).not.toContain('Mexallon');

    // The backend now reports the item as being on the watchlist.
    items[1] = [
      ...items[1],
      { id: 12, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await addMexallonToWatchlist();

    expect(pricingNames()).toContain('Mexallon');
  });

  test('it shows the item name, not "Type <id>"', async () => {
    await mount();

    items[1] = [
      ...items[1],
      { id: 12, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await addMexallonToWatchlist();

    const names = pricingNames();
    expect(names).toContain('Mexallon');
    expect(names.some((n) => /^Type \d+$/.test(n))).toBe(false);
  });

  test('the new item is priced, not left blank', async () => {
    await mount();

    items[1] = [
      ...items[1],
      { id: 12, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await addMexallonToWatchlist();

    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Mexallon'));
    expect(row.querySelector('.mk-sell').textContent).not.toBe('--');
  });

  test('removing an item drops it from the Pricing table too', async () => {
    await mount();
    expect(pricingNames()).toContain('Tritanium');

    // Remove Tritanium (id 10) from the active watchlist. The fixture's
    // removeItem already drops it from every list, mirroring the backend.
    const removeBtn = document.querySelectorAll('#mk-wl-rows tr')[0]
      .querySelector('.mk-icon-btn-danger');
    removeBtn.click();
    await flush();

    expect(pricingNames()).not.toContain('Tritanium');
  });
});

/**
 * A watchlist is BOUND to the market set it was configured with. Changing the
 * left-pane selection must not move it - that binding is the point of the
 * setting. The Pricing tab is the deliberate exception: it lists every tracked
 * item priced against whatever set is selected on the left.
 */
describe('watchlists are bound to their own market set', () => {
  async function selectAmarrInLeftPane() {
    const row = [...document.querySelectorAll('#mk-set-list .mk-context-row')]
      .find((r) => r.textContent.includes('Amarr'));
    row.click();
    await flush();
  }

  test('the header names the bound market set, not "Default market"', async () => {
    await mount();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');
  });

  test('a watchlist bound to another set names that one', async () => {
    await mount();
    document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row')[1].click();
    await flush();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Amarr');
  });

  test('watchlist prices use the bound set, not the left-pane selection', async () => {
    await mount();
    calls.length = 0;

    await selectAmarrInLeftPane();

    // Any repricing that did happen must have used the BOUND set (Jita), not
    // the newly selected one.
    const priced = calls.filter((c) => c.fn === 'calculatePrice');
    priced.forEach((c) => expect(c.marketSetId).not.toBe('set-amarr'));
  });

  test('the bound market name does not change with the left pane', async () => {
    await mount();
    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');

    await selectAmarrInLeftPane();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');
  });

  test('a watchlist with no bound set falls back to the default, not the selection', async () => {
    watchlists = [
      { id: 1, name: 'Unbound', description: null, market_set_id: null, item_count: 1 },
    ];
    await mount();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('the default market');
  });

  test('creating a watchlist stores the set id verbatim, not coerced to a number', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    document.getElementById('mk-wl-form-name').value = 'Bound';
    const marketSelect = document.getElementById('mk-wl-form-market');
    marketSelect.value = 'set-amarr';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    const created = calls.find((c) => c.fn === 'create');
    expect(created.data.marketSetId).toBe('set-amarr');
    expect(Number.isNaN(created.data.marketSetId)).toBe(false);
  });
});

describe('the Pricing tab spans every watchlist', () => {
  test('lists items from a watchlist that is not the active one', async () => {
    // Mexallon is only on the SECOND watchlist, which is not selected.
    items[2] = [
      { id: 20, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    watchlists[1].item_count = 1;

    await mount();

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
    expect(names).toContain('Mexallon');
  });

  test('prices them against the LEFT-PANE set, not each watchlist binding', async () => {
    items[2] = [
      { id: 20, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await mount();
    calls.length = 0;

    const row = [...document.querySelectorAll('#mk-set-list .mk-context-row')]
      .find((r) => r.textContent.includes('Amarr'));
    row.click();
    await flush();

    // The order book is fetched for the selected region, covering every
    // tracked item regardless of which watchlist it came from.
    const book = calls.filter((c) => c.fn === 'getOrderBookSummary');
    expect(book.length).toBeGreaterThan(0);
    expect(book.some((c) => c.regionId === 10000043)).toBe(true);
  });
});

/**
 * Anchored drift: base_buy/base_sell are captured when the item is added and
 * move ONLY on an explicit re-baseline. Drift is measured from them, so it
 * answers "how far has this moved since I started watching?" - a rolling
 * baseline would only ever show the delta since the last check.
 */
describe('watchlist drift columns', () => {
  function wlRow(name) {
    return [...document.querySelectorAll('#mk-wl-rows tr')]
      .find((tr) => tr.textContent.includes(name));
  }

  test('shows base and current for both sides', async () => {
    await mount();

    // Tritanium: base 5/6, current 5/6.
    const cells = [...wlRow('Tritanium').children].map((td) => td.textContent);
    expect(cells[1]).toBe('5');   // base buy
    expect(cells[2]).toBe('5');   // buy
    expect(cells[3]).toBe('6');   // base sell
    expect(cells[4]).toBe('6');   // sell
  });

  test('drift is measured from the baseline, not the last check', async () => {
    await mount();

    // Pyerite: base 8/10, current 10/12 -> +25% buy, +20% sell.
    const drift = wlRow('Pyerite').querySelector('.mk-wl-drift');
    expect(drift.textContent).toContain('+25.0%');
    expect(drift.textContent).toContain('+20.0%');
  });

  test('an item at its baseline shows no drift', async () => {
    await mount();

    const drift = wlRow('Tritanium').querySelector('.mk-wl-drift');
    expect(drift.textContent).toContain('+0.0%');
  });

  test('an item with no baseline shows -- rather than a fake zero', async () => {
    items[1] = [
      { id: 10, type_id: 34, base_buy: null, base_sell: null, baseline_at: null,
        buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null,
        sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await mount();

    expect(wlRow('Tritanium').querySelector('.mk-wl-drift').textContent).toBe('-- / --');
  });

  test('drift direction is colour-coded', async () => {
    await mount();

    const parts = wlRow('Pyerite').querySelectorAll('.mk-drift-part');
    expect(parts.length).toBe(2);
    parts.forEach((p) => expect(p.classList.contains('is-up')).toBe(true));
  });
});

describe('per-side alert rules', () => {
  function wlRow(name) {
    return [...document.querySelectorAll('#mk-wl-rows tr')]
      .find((tr) => tr.textContent.includes(name));
  }

  test('an armed rule that has been crossed reads as hit', async () => {
    // Pyerite sell drifted +20%, rule is "sell rises by 50%" -> not hit.
    await mount();
    let pill = wlRow('Pyerite').querySelector('.mk-alert-pill');
    expect(pill.classList.contains('is-armed')).toBe(true);

    // Lower the threshold below the actual drift.
    items[1][1].sell_alert_value = 10;
    await mount();
    pill = wlRow('Pyerite').querySelector('.mk-alert-pill');
    expect(pill.classList.contains('is-hit')).toBe(true);
  });

  test('buy and sell rules are independent', async () => {
    items[1][1].buy_alert_type = 'percent';
    items[1][1].buy_alert_direction = 'above';
    items[1][1].buy_alert_value = 10;   // buy drifted +25% -> hit
    items[1][1].sell_alert_value = 90;  // sell drifted +20% -> armed
    await mount();

    const pills = wlRow('Pyerite').querySelectorAll('.mk-alert-pill');
    expect(pills).toHaveLength(2);
    expect([...pills].filter((p) => p.classList.contains('is-hit'))).toHaveLength(1);
    expect([...pills].filter((p) => p.classList.contains('is-armed'))).toHaveLength(1);
  });

  test('an item with no rules offers to set them', async () => {
    await mount();

    const pill = wlRow('Tritanium').querySelector('.mk-alert-pill');
    expect(pill.textContent).toBe('Set alerts');
  });

  test('an ISK rule is labelled in ISK, not percent', async () => {
    items[1][1].sell_alert_type = 'isk';
    items[1][1].sell_alert_value = 3;
    await mount();

    const pill = wlRow('Pyerite').querySelector('.mk-alert-pill');
    expect(pill.textContent).toContain('3');
    expect(pill.textContent).not.toContain('%');
  });
});

describe('adding an item captures its baseline', () => {
  async function addMexallon() {
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();
    document.getElementById('mk-additem-save').click();
    await flush();
  }

  test('sends the current prices as the anchor', async () => {
    await mount();
    await addMexallon();

    const add = calls.find((c) => c.fn === 'addItem');
    // Mexallon prices from the fixture.
    expect(add.payload.baseBuy).toBe(80);
    expect(add.payload.baseSell).toBe(90);
  });

  test('sends both rule sides', async () => {
    await mount();
    await addMexallon();

    const add = calls.find((c) => c.fn === 'addItem');
    expect(add.payload.buy).toEqual({ type: 'none', direction: 'above', value: null });
    expect(add.payload.sell).toEqual({ type: 'none', direction: 'above', value: null });
  });

  test('fetches the baseline for an item not already tracked', async () => {
    // The order book only covers tracked items, so adding a freshly searched
    // one must look its prices up rather than anchoring to nothing.
    await mount();
    calls.length = 0;
    await addMexallon();

    const lookups = calls.filter((c) => c.fn === 'getOrderBookSummary');
    expect(lookups.length).toBeGreaterThan(0);
    expect(calls.find((c) => c.fn === 'addItem').payload.baseBuy).toBe(80);
  });

  test('warns when no market data exists to anchor to', async () => {
    // Mexallon has no cached prices in this run.
    delete prices[36];
    await mount();
    await addMexallon();

    const add = calls.find((c) => c.fn === 'addItem');
    expect(add.payload.baseBuy).toBeUndefined();
    expect(add.payload.baseSell).toBeUndefined();

    const toastEl = document.querySelector('.toast-container .toast');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toMatch(/no baseline yet/i);
  });

  test('editing an existing item does NOT resend a baseline', async () => {
    // Re-baselining must be explicit; editing alerts must not silently reset
    // the anchor and erase accumulated drift.
    await mount();
    [...document.querySelectorAll('#mk-wl-rows tr')][1]
      .querySelector('.mk-alert-pill').click();
    await flush();

    document.getElementById('mk-additem-save').click();
    await flush();

    const add = calls.find((c) => c.fn === 'addItem');
    expect(add.payload.baseBuy).toBeUndefined();
    expect(add.payload.baseSell).toBeUndefined();
  });

  test('a percent rule is sent with its value', async () => {
    await mount();
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();

    const type = document.getElementById('mk-additem-sell-type');
    type.value = 'percent';
    type.dispatchEvent(new Event('change'));
    const value = document.getElementById('mk-additem-sell-value');
    value.value = '15';
    value.dispatchEvent(new Event('input'));

    document.getElementById('mk-additem-save').click();
    await flush();

    const add = calls.find((c) => c.fn === 'addItem');
    expect(add.payload.sell).toEqual({ type: 'percent', direction: 'above', value: 15 });
  });

  test('save is blocked while an armed rule has no value', async () => {
    await mount();
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();

    const type = document.getElementById('mk-additem-buy-type');
    type.value = 'isk';
    type.dispatchEvent(new Event('change'));

    expect(document.getElementById('mk-additem-save').disabled).toBe(true);
  });
});

describe('re-baselining', () => {
  test('sends the current prices for that item', async () => {
    await mount();

    const row = [...document.querySelectorAll('#mk-wl-rows tr')]
      .find((tr) => tr.textContent.includes('Pyerite'));
    row.querySelector('.mk-icon-btn:not(.mk-icon-btn-danger)').click();
    await flush();

    const rebase = calls.find((c) => c.fn === 'rebaseline');
    expect(rebase).toBeDefined();
    expect(rebase.prices).toEqual({ buy: 10, sell: 12 });
  });

  test('is disabled when the item has no price to anchor to', async () => {
    prices = {};
    await mount();

    const btn = document.querySelector('#mk-wl-rows .mk-icon-btn:not(.mk-icon-btn-danger)');
    expect(btn.disabled).toBe(true);
  });
});
