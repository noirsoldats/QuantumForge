/**
 * @jest-environment jsdom
 *
 * Asset Manager shell view.
 *
 * This screen was the trigger for the ESI error-budget work: it awaited a
 * location lookup PER ASSET, so a 1,200-item hangar meant 1,200 sequential IPC
 * round-trips, each able to fire a structure lookup whose 403s spent ESI's
 * application-wide error budget and returned 420 for everything - including the
 * unrelated background refresh cycle.
 *
 * The batching tests below are therefore not stylistic. They pin the property
 * that keeps this screen from taking the whole app's ESI access down.
 *
 * Fixtures use REAL shapes:
 *   - assets.get           -> [{ itemId, typeId, locationId, locationFlag,
 *                               quantity, isBlueprintCopy, isSingleton }]
 *   - sde.getTypeNames     -> { [typeId]: name }
 *   - sde.getTypeCategoryInfo -> { [typeId]: { categoryID, groupID, ... } }
 *   - sde.getItemVolumes   -> { [typeId]: volume }
 *   - location.resolveMany -> { [locationId]: { fullPath, ... } }
 *   - market.calculatePrices -> { [typeId]: { price, confidence } }
 *
 * console.error is captured and any unexpected entry FAILS the test - the
 * renderer swallows failures into logs, so a green suite otherwise proves
 * nothing about whether the view actually rendered.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/assets.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/assets-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let characterAssets;
let corporationAssets;
let character;
let typeNames;
let categoryInfo;
let volumes;
let locations;
let prices;
let marketSets;
/** (isCorporation) -> cache status. A fn, since the two caches differ. */
let cacheStatusFor;
let savedViews;
let calls;
let consoleErrors = [];
let expectedErrorPatterns = [];
let registered;
let subscribers;

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function subscribe(channel, cb) {
  if (!subscribers[channel]) subscribers[channel] = [];
  subscribers[channel].push(cb);
  return () => {
    subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
  };
}

/** SDE category ids used by the classifier. */
const CAT = { SHIP: 6, MODULE: 7, CHARGE: 8, BLUEPRINT: 9, MATERIAL: 4 };
const MINERAL_GROUP = 18;

function makeApi() {
  return {
    esi: {
      getCharacter: async (id) => {
        calls.push({ fn: 'esi.getCharacter', id });
        return character;
      },
      getDefaultCharacter: async () => character,
    },
    assets: {
      get: async (id, isCorporation) => {
        calls.push({ fn: 'assets.get', id, isCorporation });
        return isCorporation ? corporationAssets : characterAssets;
      },
      fetch: async (id) => {
        calls.push({ fn: 'assets.fetch', id });
        return { success: true };
      },
      // Real signature: the handler takes (characterId, isCorporation) and the
      // two caches expire independently, so the stub must be able to answer
      // differently per flag.
      getCacheStatus: async (id, isCorporation) => {
        calls.push({ fn: 'assets.getCacheStatus', id, isCorporation });
        return cacheStatusFor(isCorporation);
      },
    },
    sde: {
      getTypeNames: async (ids) => {
        calls.push({ fn: 'sde.getTypeNames', count: ids.length });
        return typeNames;
      },
      getTypeCategoryInfo: async (ids) => {
        calls.push({ fn: 'sde.getTypeCategoryInfo', count: ids.length });
        return categoryInfo;
      },
      getItemVolumes: async (ids) => {
        calls.push({ fn: 'sde.getItemVolumes', count: ids.length });
        return volumes;
      },
    },
    location: {
      resolveMany: async (ids, characterId, isCorporation) => {
        calls.push({ fn: 'location.resolveMany', count: ids.length, isCorporation });
        return locations;
      },
      // Present so a stray per-item call would be observable rather than throwing.
      resolve: async (id) => {
        calls.push({ fn: 'location.resolve', id });
        return locations[id];
      },
    },
    market: {
      getMarketSets: async () => marketSets,
      calculatePrices: async (ids, options) => {
        calls.push({ fn: 'market.calculatePrices', count: ids.length, options });
        return prices;
      },
      calculatePrice: async (typeId) => {
        calls.push({ fn: 'market.calculatePrice', typeId });
        return prices[typeId];
      },
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
    },
    // Saved views live in the config file under a top-level `assets` category.
    settings: {
      get: async (category, key) => {
        calls.push({ fn: 'settings.get', category, key });
        return category === 'assets' && key === 'savedViews' ? savedViews : null;
      },
      update: async (category, updates) => {
        calls.push({ fn: 'settings.update', category, updates });
        if (category === 'assets' && updates.savedViews) savedViews = updates.savedViews;
        return true;
      },
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/assets-view-renderer.js');
  });
}

/**
 * Install the REAL shared countdown, not a stub.
 *
 * It is what renders #as-cache-status now, so stubbing it would leave these
 * tests asserting against a label nothing writes. Loading the actual file also
 * pins the contract between the two: the renderer hands over `expiresAt` and
 * the component formats it.
 */
function loadCacheCountdown() {
  delete window.QFCacheCountdown;
  jest.isolateModules(() => {
    require('../../public/shared/cache-countdown.js');
  });
}

function makeCtx() {
  const tracked = [];
  const intervals = [];
  return {
    tracked,
    intervals,
    ctx: {
      on: (target, type, handler) => target && target.addEventListener(type, handler),
      track: (fn) => { tracked.push(fn); return fn; },
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      setTimeout: () => 0,
      dispose: () => tracked.forEach((fn) => fn()),
    },
  };
}

async function settle(times = 40) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function mountView(params) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const made = makeCtx();
  const instance = await registered.def.mount(container, params || {}, made.ctx);
  await settle();
  return { container, ctx: made.ctx, made, instance };
}

/** Every rendered item row (group headers excluded). */
function itemRows(container) {
  return [...container.querySelectorAll('#as-tbody tr.as-row')];
}

function groupRows(container) {
  return [...container.querySelectorAll('#as-tbody .as-group')];
}

function textOf(container, selector) {
  const node = container.querySelector(selector);
  return node ? node.textContent.trim() : null;
}

beforeEach(() => {
  // The real cache countdown owns a 1s interval. Fake timers keep it from
  // ticking through the suite, and let the polling test advance the clock
  // without waiting. `doNotFake: ['queueMicrotask']` keeps settle()'s promise
  // draining on the real microtask queue.
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });

  consoleErrors = [];
  expectedErrorPatterns = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(
      args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter(Boolean)
        .join(' ')
    );
  });

  calls = [];
  subscribers = {};

  character = {
    characterId: 91316135,
    characterName: 'Buckwalter',
    corporationId: 98000001,
    portrait: 'https://images.evetech.net/characters/91316135/portrait',
  };

  // Two locations, one of them a player structure; a blueprint original and a
  // copy; a mineral and a ship, so every facet has something to bite on.
  characterAssets = [
    { itemId: 1, typeId: 34, locationId: 60003760, locationFlag: 'Hangar', quantity: 42000000, isBlueprintCopy: false },
    { itemId: 2, typeId: 22544, locationId: 60003760, locationFlag: 'Hangar', quantity: 2, isBlueprintCopy: false },
    { itemId: 3, typeId: 22545, locationId: 1035466617946, locationFlag: 'Hangar', quantity: 1, isBlueprintCopy: false },
    { itemId: 4, typeId: 17716, locationId: 1035466617946, locationFlag: 'Hangar', quantity: 1, isBlueprintCopy: true },
    { itemId: 5, typeId: 2048, locationId: 1035466617946, locationFlag: 'Hangar', quantity: 18, isBlueprintCopy: false },
  ];

  corporationAssets = [
    { itemId: 10, typeId: 34, locationId: 1035466617946, locationFlag: 'CorpSAG2', quantity: 180000000, isBlueprintCopy: false },
  ];

  typeNames = {
    34: 'Tritanium',
    22544: 'Hulk',
    22545: 'Hulk Blueprint',
    17716: 'Gila Blueprint',
    2048: 'Damage Control II',
  };

  categoryInfo = {
    34: { categoryID: CAT.MATERIAL, groupID: MINERAL_GROUP, categoryName: 'Material', groupName: 'Mineral' },
    22544: { categoryID: CAT.SHIP, groupID: 463, categoryName: 'Ship' },
    22545: { categoryID: CAT.BLUEPRINT, groupID: 105, categoryName: 'Blueprint' },
    17716: { categoryID: CAT.BLUEPRINT, groupID: 105, categoryName: 'Blueprint' },
    2048: { categoryID: CAT.MODULE, groupID: 60, categoryName: 'Module' },
  };

  volumes = { 34: 0.01, 22544: 3750, 22545: 0.01, 17716: 0.01, 2048: 5 };

  locations = {
    60003760: { fullPath: 'Jita IV-4 - CNAP', systemName: 'Jita', stationName: 'Jita IV-4', containerNames: [], locationType: 'npc-station' },
    1035466617946: { fullPath: 'Sotiyo - Forge Dynamics HQ', systemName: 'Perimeter', stationName: 'Sotiyo', containerNames: [], locationType: 'structure' },
  };

  prices = {
    34: { price: 5.8, confidence: 'high' },
    22544: { price: 265000000, confidence: 'high' },
    22545: { price: 210000000, confidence: 'medium' },
    17716: { price: 8400000, confidence: 'medium' },
    2048: { price: 685000, confidence: 'high' },
  };

  marketSets = [{ id: 'set-1', name: 'Jita 4-4', isDefault: true }];
  savedViews = [];

  // 42m out. The countdown ticks off the absolute expiresAt, so that is the
  // field that matters; remainingSeconds is carried because the real handler
  // returns it.
  cacheStatusFor = () => ({
    isCached: true,
    remainingSeconds: 2520,
    expiresAt: Date.now() + 2520_000,
  });

  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: (id, params) => calls.push({ fn: 'router.show', id, params }),
    },
  };
  window.electronAPI = makeApi();
  // The REAL QFToast API: a single show(message, type). There are no per-type
  // methods - inventing them here let a silent TypeError in the renderer
  // (QFToast.info(...)) pass every test while no toast ever appeared.
  window.QFToast = {
    show: (m, type = 'info') => calls.push({ fn: `toast.${type}`, m }),
    setDefaultPosition: () => {},
    dismissAll: () => {},
  };

  loadCacheCountdown();

  // The renderer fetches its own template.
  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  document.body.innerHTML = '';
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => e.includes(p))
  );
  expect(unexpected).toEqual([]);
  // Dispose any countdown still attached before dropping fake timers, so a
  // stray 1s interval cannot tick into the next test.
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete global.fetch;
});

/* ------------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers itself as the "assets" view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('assets');
    expect(typeof registered.def.mount).toBe('function');
  });
});

describe('ESI batching (the reason this screen was rewritten)', () => {
  test('resolves locations in ONE call per scope, never per asset', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const many = calls.filter((c) => c.fn === 'location.resolveMany');
    const single = calls.filter((c) => c.fn === 'location.resolve');

    // Character scope + corporation scope = 2, regardless of asset count.
    expect(many).toHaveLength(2);
    expect(single).toHaveLength(0);
    expect(itemRows(container).length).toBeGreaterThan(0);
  });

  test('prices every distinct type in ONE call, never per asset', async () => {
    await mountView({ characterId: 91316135 });

    const bulk = calls.filter((c) => c.fn === 'market.calculatePrices');
    const single = calls.filter((c) => c.fn === 'market.calculatePrice');

    expect(bulk).toHaveLength(1);
    expect(single).toHaveLength(0);
  });

  test('SDE lookups are batched too - one call each for names, categories, volumes', async () => {
    await mountView({ characterId: 91316135 });

    expect(calls.filter((c) => c.fn === 'sde.getTypeNames')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'sde.getTypeCategoryInfo')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'sde.getItemVolumes')).toHaveLength(1);
  });

  test('call count does not grow with the number of assets', async () => {
    // The regression this guards: work proportional to assets rather than to
    // distinct locations/types.
    characterAssets = new Array(500).fill(null).map((_, i) => ({
      itemId: 1000 + i, typeId: 34, locationId: 60003760,
      locationFlag: 'Hangar', quantity: 1, isBlueprintCopy: false,
    }));

    await mountView({ characterId: 91316135 });

    const ipcCalls = calls.filter((c) => c.fn.startsWith('location.') || c.fn.startsWith('market.'));
    expect(ipcCalls.length).toBeLessThan(10);
  });
});

describe('items nested in ships and containers', () => {
  // THE BUG: fullPath used to include the container names, so items in the same
  // hangar but different ships produced different values ("Sotiyo - Golem" vs
  // "Sotiyo - Revelation"). The view groups and facets on fullPath, so ONE
  // station split into a separate row and facet per container.
  //
  // fullPath is now the terminal place only; the chain lives in the tooltip.
  const STRUCTURE = 1035466617946;

  beforeEach(() => {
    // Two ships in the same structure, each holding an item.
    characterAssets = [
      { itemId: 100, typeId: 34, locationId: STRUCTURE, locationFlag: 'Hangar', quantity: 10, isBlueprintCopy: false },
      { itemId: 101, typeId: 2048, locationId: STRUCTURE, locationFlag: 'Cargo', quantity: 1, isBlueprintCopy: false },
      { itemId: 102, typeId: 22544, locationId: STRUCTURE, locationFlag: 'HiSlot5', quantity: 1, isBlueprintCopy: false },
    ];
    corporationAssets = [];

    // Every item resolves to the SAME station, each with its own chain.
    locations = {
      [STRUCTURE]: {
        fullPath: 'UALX-3 Mothership Bellicose',
        systemName: 'UALX-3',
        stationName: 'UALX-3 Mothership Bellicose',
        containerNames: ['Golem'],
        containerPath: [{ itemId: 1040208179061, typeId: 28710, locationFlag: 'Hangar' }],
        locationType: 'structure',
      },
    };
  });

  test('one station produces ONE location facet', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const facets = [...container.querySelectorAll('#as-loc-facets .as-facet-label')]
      .map((n) => n.textContent);

    expect(facets).toEqual(['UALX-3 Mothership Bellicose']);
  });

  test('one station produces ONE group header', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const groups = groupRows(container).map((g) =>
      g.querySelector('.as-group-label').textContent);

    expect(groups).toEqual(['UALX-3 Mothership Bellicose']);
  });

  test('the location cell shows the station alone', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const cells = itemRows(container).map((r) => r.children[4].textContent);
    cells.forEach((c) => expect(c).toBe('UALX-3 Mothership Bellicose'));
  });

  test('the tooltip carries the full chain, innermost first', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const titles = itemRows(container).map((r) => r.children[4].querySelector('span').title);

    expect(titles).toContain('Hangar → Golem → UALX-3 Mothership Bellicose');
    expect(titles).toContain('Cargo → Golem → UALX-3 Mothership Bellicose');
    expect(titles).toContain('HiSlot5 → Golem → UALX-3 Mothership Bellicose');
  });

  test('a nested location is marked so the tooltip is discoverable', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const marked = container.querySelectorAll('.as-has-chain');
    expect(marked.length).toBe(itemRows(container).length);
    // Reachable by keyboard and announced, not mouse-only.
    expect(marked[0].tabIndex).toBe(0);
    expect(marked[0].getAttribute('aria-label')).toContain('→');
  });

  test('an item directly in a station gets no chain and no marker', async () => {
    characterAssets = [
      { itemId: 200, typeId: 34, locationId: 60003760, locationFlag: 'Hangar', quantity: 5, isBlueprintCopy: false },
    ];
    locations = {
      60003760: {
        fullPath: 'Jita IV-4 - CNAP', systemName: 'Jita', stationName: 'Jita IV-4 - CNAP',
        containerNames: [], containerPath: [], locationType: 'npc-station',
      },
    };

    const { container } = await mountView({ characterId: 91316135 });

    // No misleading "Hangar → " prefix when there is nothing to traverse.
    const cell = itemRows(container)[0].children[4];
    expect(cell.querySelector('span').title).toBe('Jita IV-4 - CNAP');
    expect(container.querySelector('.as-has-chain')).toBeNull();
  });

  test('CSV exports the full chain, since a spreadsheet has no tooltip', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    let csv = '';
    const originalBlob = global.Blob;
    global.Blob = function (parts) { csv = parts.join(''); return { type: 'text/csv' }; };
    global.URL.createObjectURL = () => 'blob:x';
    global.URL.revokeObjectURL = () => {};

    container.querySelector('#as-export-btn').click();
    global.Blob = originalBlob;

    expect(csv).toContain('Cargo → Golem → UALX-3 Mothership Bellicose');
  });
});

describe('rendering assets', () => {
  test('shows one row per asset with its resolved name and location', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const text = container.querySelector('#as-tbody').textContent;
    expect(text).toContain('Tritanium');
    expect(text).toContain('Hulk');
    expect(text).toContain('Jita IV-4 - CNAP');
    expect(text).toContain('Sotiyo - Forge Dynamics HQ');
  });

  test('shows the character name and portrait', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    expect(textOf(container, '#as-character-name')).toBe('Buckwalter');
    expect(container.querySelector('#as-portrait').src).toContain('91316135');
  });

  test('marks blueprint originals and copies differently', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const badges = [...container.querySelectorAll('.as-bp-badge')].map((b) => b.textContent);
    expect(badges).toContain('BPO');
    expect(badges).toContain('BPC');
  });

  test('a non-blueprint never gets a BPO/BPC badge', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const tritaniumRow = itemRows(container).find(
      (r) => r.textContent.includes('Tritanium')
    );
    expect(tritaniumRow.querySelector('.as-bp-badge')).toBeNull();
  });

  test('empty state appears when there are no assets', async () => {
    characterAssets = [];
    corporationAssets = [];

    const { container } = await mountView({ characterId: 91316135 });

    expect(container.querySelector('#as-empty').hidden).toBe(false);
    expect(container.querySelector('#as-table').hidden).toBe(true);
  });
});

describe('categories come from SDE ids, not names', () => {
  test('classifies by categoryID/groupID', async () => {
    // The SDE reports categoryName "Material" for a great many unrelated
    // things, so a name-based classifier lumps everything together. These
    // fixtures share that name and must still separate.
    const { container } = await mountView({ characterId: 91316135 });

    const facetLabels = [...container.querySelectorAll('#as-cat-facets .as-facet-label')]
      .map((n) => n.textContent);

    expect(facetLabels).toContain('Minerals');
    expect(facetLabels).toContain('Ships');
    expect(facetLabels).toContain('Blueprints');
    expect(facetLabels).toContain('Modules');
  });

  test('an unknown type falls back to Other rather than vanishing', async () => {
    characterAssets = [
      { itemId: 1, typeId: 99999, locationId: 60003760, locationFlag: 'Hangar', quantity: 1, isBlueprintCopy: false },
    ];
    corporationAssets = [];
    typeNames = { 99999: 'Mystery Item' };
    categoryInfo = {};
    volumes = {};

    const { container } = await mountView({ characterId: 91316135 });

    expect(container.querySelector('#as-tbody').textContent).toContain('Mystery Item');
    const labels = [...container.querySelectorAll('#as-cat-facets .as-facet-label')]
      .map((n) => n.textContent);
    expect(labels).toContain('Other');
  });
});

describe('filtering', () => {
  test('search narrows by item name', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const before = itemRows(container).length;

    const search = container.querySelector('#as-search');
    search.value = 'trit';
    search.dispatchEvent(new Event('input'));

    const after = itemRows(container);
    expect(after.length).toBeLessThan(before);
    expect(after.every((r) => r.textContent.includes('Tritanium'))).toBe(true);
  });

  test('a category facet filters to that bucket', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const shipFacet = [...container.querySelectorAll('#as-cat-facets .as-facet')]
      .find((f) => f.textContent.includes('Ships'));
    shipFacet.click();

    const rows = itemRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Hulk');
    expect(rows[0].textContent).not.toContain('Blueprint');
  });

  test('a location facet filters to that location', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const jita = [...container.querySelectorAll('#as-loc-facets .as-facet')]
      .find((f) => f.textContent.includes('Jita'));
    jita.click();

    const rows = itemRows(container);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textContent.includes('Jita'))).toBe(true);
  });

  test('the BPC facet excludes originals', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const bpc = [...container.querySelectorAll('#as-bp-facets .as-facet')]
      .find((f) => f.textContent.includes('Copies'));
    bpc.click();

    const rows = itemRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Gila Blueprint');
  });

  test('Clear removes an active category filter', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const all = itemRows(container).length;

    [...container.querySelectorAll('#as-cat-facets .as-facet')]
      .find((f) => f.textContent.includes('Ships')).click();
    expect(itemRows(container).length).toBeLessThan(all);

    container.querySelector('#as-clear-cats').click();
    expect(itemRows(container)).toHaveLength(all);
  });

  test('the reset badge only appears once a filter is active', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    expect(container.querySelector('#as-reset-badge').hidden).toBe(true);

    const search = container.querySelector('#as-search');
    search.value = 'trit';
    search.dispatchEvent(new Event('input'));

    expect(container.querySelector('#as-reset-badge').hidden).toBe(false);
  });

  test('reset restores every row', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const all = itemRows(container).length;

    const search = container.querySelector('#as-search');
    search.value = 'trit';
    search.dispatchEvent(new Event('input'));
    expect(itemRows(container).length).toBeLessThan(all);

    container.querySelector('#as-reset-view').click();
    expect(itemRows(container)).toHaveLength(all);
  });
});

describe('tabs', () => {
  test('offers a corporation tab when the character has a corporation', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const tabs = [...container.querySelectorAll('.as-tab')].map((t) => t.textContent);
    expect(tabs.some((t) => t.includes('Character Assets'))).toBe(true);
    expect(tabs.some((t) => t.includes('Corporation Assets'))).toBe(true);
  });

  test('hides the corporation tab when there is no corporation', async () => {
    character = { ...character, corporationId: null };
    corporationAssets = [];

    const { container } = await mountView({ characterId: 91316135 });

    const tabs = [...container.querySelectorAll('.as-tab')].map((t) => t.textContent);
    expect(tabs.some((t) => t.includes('Corporation'))).toBe(false);
  });

  test('switching to corporation shows corp assets', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const corpTab = [...container.querySelectorAll('.as-tab')]
      .find((t) => t.textContent.includes('Corporation'));
    corpTab.click();

    const rows = itemRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('CorpSAG2');
  });

  test('switching tabs clears location facets', async () => {
    // Locations are per-tab; carrying them over filters everything out and the
    // screen looks broken.
    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#as-loc-facets .as-facet')]
      .find((f) => f.textContent.includes('Jita')).click();

    [...container.querySelectorAll('.as-tab')]
      .find((t) => t.textContent.includes('Corporation')).click();

    expect(itemRows(container).length).toBeGreaterThan(0);
  });
});

describe('sorting', () => {
  test('clicking a header sorts by that column', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    // Ungroup first. With the default location grouping, rows are sorted WITHIN
    // each group, so a flat global ordering is not what the screen produces -
    // asserting one would be testing the wrong contract.
    const groupBy = container.querySelector('#as-group-by');
    groupBy.value = 'none';
    groupBy.dispatchEvent(new Event('change'));

    const nameHeader = [...container.querySelectorAll('.as-th')]
      .find((th) => th.textContent.includes('Item'));
    nameHeader.click();

    // Compare on the item NAME, not the rendered cell text - the cell also
    // carries the BPO/BPC badge, so "Hulk BlueprintBPO" would compare
    // differently from the "Hulk Blueprint" the renderer keys on.
    const names = itemRows(container).map(
      (r) => r.querySelector('.as-item-name span:not([class])').textContent
    );
    const sorted = [...names].sort((a, b) => b.localeCompare(a));
    expect(names).toEqual(sorted);
  });

  test('rows sort WITHIN each group, not across groups', async () => {
    // Grouping is the default, so this is the ordering users actually see.
    const { container } = await mountView({ characterId: 91316135 });

    const nameHeader = [...container.querySelectorAll('.as-th')]
      .find((th) => th.textContent.includes('Item'));
    nameHeader.click();

    const groups = groupRows(container);
    expect(groups.length).toBeGreaterThan(1);

    // Every row still belongs to the group header above it.
    const bodyRows = [...container.querySelectorAll('#as-tbody tr')];
    let currentGroup = null;
    const seen = {};
    bodyRows.forEach((tr) => {
      const head = tr.querySelector('.as-group-label');
      if (head) {
        currentGroup = head.textContent;
        seen[currentGroup] = [];
        return;
      }
      const loc = tr.children[4] ? tr.children[4].textContent : null;
      if (loc) expect(loc).toBe(currentGroup);
    });
  });

  test('clicking the same header twice flips the direction', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const nameHeader = () => [...container.querySelectorAll('.as-th')]
      .find((th) => th.textContent.includes('Item'));

    nameHeader().click();
    const desc = itemRows(container).map((r) => r.textContent);
    nameHeader().click();
    const asc = itemRows(container).map((r) => r.textContent);

    expect(asc).toEqual([...desc].reverse());
  });

  test('the sorted column is marked for assistive tech', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const sorted = [...container.querySelectorAll('.as-th')]
      .filter((th) => th.getAttribute('aria-sort') !== 'none' && th.getAttribute('aria-sort'));
    expect(sorted).toHaveLength(1);
  });
});

describe('grouping', () => {
  test('groups by location by default', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const labels = groupRows(container).map((g) =>
      g.querySelector('.as-group-label').textContent);
    expect(labels).toContain('Jita IV-4 - CNAP');
    expect(labels).toContain('Sotiyo - Forge Dynamics HQ');
  });

  test('a group collapses and expands', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const before = itemRows(container).length;

    groupRows(container)[0].click();
    const collapsed = itemRows(container).length;
    expect(collapsed).toBeLessThan(before);

    groupRows(container)[0].click();
    expect(itemRows(container)).toHaveLength(before);
  });

  test('group by none removes the group headers', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const select = container.querySelector('#as-group-by');
    select.value = 'none';
    select.dispatchEvent(new Event('change'));

    expect(groupRows(container)).toHaveLength(0);
    expect(itemRows(container).length).toBeGreaterThan(0);
  });
});

describe('aggregate duplicates', () => {
  test('merges the same type across locations and sums the quantity', async () => {
    // Tritanium is in both Jita and the Sotiyo in the corp tab; within the
    // character tab, add a second stack so there is something to merge.
    characterAssets.push({
      itemId: 6, typeId: 34, locationId: 1035466617946,
      locationFlag: 'Hangar', quantity: 6800000, isBlueprintCopy: false,
    });

    const { container } = await mountView({ characterId: 91316135 });

    const aggregate = container.querySelector('#as-aggregate');
    aggregate.checked = true;
    aggregate.dispatchEvent(new Event('change'));

    const tritRows = itemRows(container).filter((r) => r.textContent.includes('Tritanium'));
    expect(tritRows).toHaveLength(1);
    expect(tritRows[0].textContent).toContain('48,800,000');
    expect(tritRows[0].textContent).toContain('2 locations');
  });

  test('aggregating flattens location grouping, which would be meaningless', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const aggregate = container.querySelector('#as-aggregate');
    aggregate.checked = true;
    aggregate.dispatchEvent(new Event('change'));

    expect(groupRows(container)).toHaveLength(0);
  });
});

describe('selection', () => {
  test('selecting a row reveals the selection bar', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    expect(container.querySelector('#as-selection-bar').hidden).toBe(true);

    itemRows(container)[0].querySelector('.is-check').click();

    expect(container.querySelector('#as-selection-bar').hidden).toBe(false);
    expect(textOf(container, '#as-selected-count')).toContain('1 selected');
  });

  test('clear empties the selection', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    itemRows(container)[0].querySelector('.is-check').click();
    container.querySelector('#as-clear-selection').click();

    expect(container.querySelector('#as-selection-bar').hidden).toBe(true);
  });

  test('select-all toggles every visible row', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const selectAll = container.querySelector('.as-th.is-check input');
    selectAll.checked = true;
    selectAll.dispatchEvent(new Event('change'));

    const count = itemRows(container).length;
    expect(textOf(container, '#as-selected-count')).toContain(`${count} selected`);
  });
});

describe('refresh', () => {
  // A live ESI cache now GATES the button, so a refresh that is meant to reach
  // ESI has to start from an expired one. Mounting on the default (42m) fixture
  // would only ever exercise the gated path.
  beforeEach(() => {
    cacheStatusFor = () => ({ isCached: false, expiresAt: null });
  });

  test('fetches from ESI then reloads', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    calls.length = 0;

    container.querySelector('#as-refresh-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'assets.fetch')).toBe(true);
    expect(calls.some((c) => c.fn === 'assets.get')).toBe(true);
  });

  test('reports failure as a toast, never a blocking alert', async () => {
    // alert() under the shell freezes the whole window behind a modal dialog.
    allowErrors('Refresh failed');
    window.electronAPI.assets.fetch = async () => { throw new Error('ESI down'); };
    const alertSpy = jest.fn();
    window.alert = alertSpy;

    const { container } = await mountView({ characterId: 91316135 });
    container.querySelector('#as-refresh-btn').click();
    await settle();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'toast.error')).toBe(true);
  });

  test('re-enables the button after a failure', async () => {
    allowErrors('Refresh failed');
    window.electronAPI.assets.fetch = async () => { throw new Error('ESI down'); };

    const { container } = await mountView({ characterId: 91316135 });
    const btn = container.querySelector('#as-refresh-btn');
    btn.click();
    await settle();

    expect(btn.disabled).toBe(false);
    // The in-flight label must be cleared too, or render() - which refuses to
    // overwrite "Refreshing…" - would freeze the button's text forever.
    expect(btn.querySelector('#as-refresh-label').textContent).not.toBe('Refreshing…');
  });
});

describe('cache gating', () => {
  test('a live cache gates the button but leaves it CLICKABLE', async () => {
    // A disabled <button> swallows the click outright: no handler, no toast,
    // no cursor feedback. It read as a dead button.
    const { container } = await mountView({ characterId: 91316135 });
    const btn = container.querySelector('#as-refresh-btn');

    expect(btn.classList.contains('is-gated')).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector('#as-refresh-label').textContent).toContain('Cached');
  });

  test('a gated click explains itself instead of calling ESI', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    calls.length = 0;

    container.querySelector('#as-refresh-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'assets.fetch')).toBe(false);
    const info = calls.find((c) => c.fn === 'toast.info');
    expect(info).toBeDefined();
    expect(info.m).toContain('42m');
  });

  test('an expired cache leaves the button ungated', async () => {
    cacheStatusFor = () => ({ isCached: false, expiresAt: null });

    const { container } = await mountView({ characterId: 91316135 });
    const btn = container.querySelector('#as-refresh-btn');

    expect(btn.classList.contains('is-gated')).toBe(false);
    expect(btn.querySelector('#as-refresh-label').textContent).toBe('Refresh from API');
  });

  test('is-gated is styled as unavailable-but-clickable (jsdom applies no CSS)', () => {
    // jsdom never applies stylesheets, so a renderer assertion cannot catch a
    // missing rule - assert against the real CSS text.
    const rule = VIEW_CSS.match(/\.btn\.is-gated\s*\{[^}]*\}/)[0];

    expect(rule).toMatch(/opacity/);
    expect(rule).toMatch(/cursor:\s*help/);
    expect(rule).not.toMatch(/pointer-events:\s*none/);
  });
});

describe('cache status', () => {
  test('shows the remaining cache time', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    expect(textOf(container, '#as-cache-status')).toContain('42m');
  });

  test('reports the LATER of the two cache windows', async () => {
    // Personal and corp assets cache independently. While either is still
    // fresh, part of the table is ESI-current, so the later expiry is the
    // honest one - taking the earlier would say "Cache expired" over fresh
    // corp data.
    cacheStatusFor = (isCorporation) => ({
      isCached: true,
      expiresAt: Date.now() + (isCorporation ? 2520_000 : 60_000),
    });

    const { container } = await mountView({ characterId: 91316135 });

    expect(textOf(container, '#as-cache-status')).toContain('42m');
  });

  test('expired when NEITHER window is live', async () => {
    cacheStatusFor = () => ({ isCached: false, expiresAt: null });

    const { container } = await mountView({ characterId: 91316135 });

    expect(textOf(container, '#as-cache-status')).toContain('Cache expired');
  });

  test('does not poll IPC to tick the clock', async () => {
    // The point of the conversion. The old screen re-read BOTH statuses over
    // IPC every 30s (~240 round-trips an hour) purely to redraw a label; the
    // handler returns an absolute expiresAt, so the clock ticks locally and
    // re-syncs only when asset data changes.
    await mountView({ characterId: 91316135 });

    const before = calls.filter((c) => c.fn === 'assets.getCacheStatus').length;
    jest.advanceTimersByTime(120_000);
    await settle();

    expect(calls.filter((c) => c.fn === 'assets.getCacheStatus').length).toBe(before);
  });

  test('the countdown is disposed on unmount, so it cannot leak', async () => {
    // The old screen used a raw setInterval that leaked on every remount.
    const { ctx, instance } = await mountView({ characterId: 91316135 });
    const live = jest.getTimerCount();

    ctx.dispose();
    if (instance && instance.destroy) instance.destroy();

    expect(jest.getTimerCount()).toBeLessThan(live);
  });
});

describe('live updates', () => {
  test('reloads when the background cycle lands new asset data', async () => {
    await mountView({ characterId: 91316135 });
    calls.length = 0;

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'assets' }));
    await settle();

    expect(calls.some((c) => c.fn === 'assets.get')).toBe(true);
  });

  test('ignores endpoints this screen does not display', async () => {
    await mountView({ characterId: 91316135 });
    calls.length = 0;

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'market_orders' }));
    await settle();

    expect(calls.some((c) => c.fn === 'assets.get')).toBe(false);
  });

  test('the subscription is tracked so a remount cannot duplicate it', async () => {
    const { made } = await mountView({ characterId: 91316135 });
    expect(made.tracked.length).toBeGreaterThan(0);
  });
});

describe('remount hygiene', () => {
  test('a remount for a different character does not inherit the previous state', async () => {
    // `state` is module-level and survives unmount.
    const first = await mountView({ characterId: 91316135 });

    const search = first.container.querySelector('#as-search');
    search.value = 'trit';
    search.dispatchEvent(new Event('input'));
    expect(itemRows(first.container).length).toBeLessThan(5);

    first.ctx.dispose();
    if (registered.def.destroy) registered.def.destroy();

    const second = await mountView({ characterId: 91316135 });

    expect(second.container.querySelector('#as-search').value).toBe('');
    expect(itemRows(second.container)).toHaveLength(5);
  });
});

describe('saved views', () => {
  // Stored in the config file under a top-level `assets` category, matching
  // manufacturingSummary - NOT in toolPreferences, which holds one scalar
  // market-set id per tool and is read that way by getToolMarketSet.
  async function openSaveDialog(container) {
    container.querySelector('#as-save-view').click();
    await settle();
  }

  test('saving captures the current filters, grouping and aggregation', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#as-cat-facets .as-facet')]
      .find((f) => f.textContent.includes('Ships')).click();
    const groupBy = container.querySelector('#as-group-by');
    groupBy.value = 'category';
    groupBy.dispatchEvent(new Event('change'));

    await openSaveDialog(container);
    container.querySelector('#as-save-name').value = 'My Ships';
    container.querySelector('#as-save-confirm').click();
    await settle();

    const saved = calls.find((c) => c.fn === 'settings.update');
    expect(saved.category).toBe('assets');
    const view = saved.updates.savedViews[0];
    expect(view.name).toBe('My Ships');
    expect(view.config).toMatchObject({ cats: { ship: true }, groupBy: 'category' });
  });

  test('the search text is NOT saved - it is a transient find, not a view', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const search = container.querySelector('#as-search');
    search.value = 'trit';
    search.dispatchEvent(new Event('input'));

    await openSaveDialog(container);
    container.querySelector('#as-save-name').value = 'X';
    container.querySelector('#as-save-confirm').click();
    await settle();

    const view = calls.find((c) => c.fn === 'settings.update').updates.savedViews[0];
    expect(view.config).not.toHaveProperty('query');
  });

  test('exactly one row is highlighted at a time', async () => {
    // "All Assets (default)" used to be permanently highlighted - the base
    // .as-preset rule WAS the active styling, so it could never look inactive
    // and two rows appeared selected at once.
    savedViews = [{
      id: 'v1', name: 'Only Ships',
      config: { cats: { ship: true }, locs: {}, bp: {}, groupBy: 'location', aggregate: false },
    }];

    const { container } = await mountView({ characterId: 91316135 });

    const active = () => [...container.querySelectorAll('.as-preset.is-active')];

    // Default state: the reset row is the active one.
    expect(active()).toHaveLength(1);
    expect(active()[0].id).toBe('as-reset-view');

    container.querySelector('#as-saved-views .as-saved-view').click();

    expect(active()).toHaveLength(1);
    expect(active()[0].classList.contains('as-saved-view')).toBe(true);
    expect(container.querySelector('#as-reset-view').classList.contains('is-active')).toBe(false);
  });

  test('clicking "All Assets (default)" clears everything and re-highlights', async () => {
    savedViews = [{
      id: 'v1', name: 'Only Ships',
      config: { cats: { ship: true }, locs: {}, bp: {}, groupBy: 'none', aggregate: true },
    }];

    const { container } = await mountView({ characterId: 91316135 });
    const all = itemRows(container).length;

    container.querySelector('#as-saved-views .as-saved-view').click();
    expect(itemRows(container).length).toBeLessThan(all);

    container.querySelector('#as-reset-view').click();

    expect(itemRows(container)).toHaveLength(all);
    expect(container.querySelector('#as-group-by').value).toBe('location');
    expect(container.querySelector('#as-aggregate').checked).toBe(false);
    expect(container.querySelector('#as-reset-view').classList.contains('is-active')).toBe(true);
    expect(container.querySelector('.as-saved-view.is-active')).toBeNull();
  });

  test('changing Group By or Aggregate also deactivates the saved view', async () => {
    // Both are part of a view's saved config, so editing either means you are
    // no longer on that view.
    savedViews = [{
      id: 'v1', name: 'Only Ships',
      config: { cats: { ship: true }, locs: {}, bp: {}, groupBy: 'location', aggregate: false },
    }];

    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#as-saved-views .as-saved-view').click();
    const groupBy = container.querySelector('#as-group-by');
    groupBy.value = 'category';
    groupBy.dispatchEvent(new Event('change'));
    expect(container.querySelector('.as-saved-view.is-active')).toBeNull();

    container.querySelector('#as-saved-views .as-saved-view').click();
    const aggregate = container.querySelector('#as-aggregate');
    aggregate.checked = true;
    aggregate.dispatchEvent(new Event('change'));
    expect(container.querySelector('.as-saved-view.is-active')).toBeNull();
  });

  test('a saved view is listed and re-applies its filters', async () => {
    savedViews = [{
      id: 'v1',
      name: 'Only Ships',
      config: { cats: { ship: true }, locs: {}, bp: {}, groupBy: 'none', aggregate: false },
    }];

    const { container } = await mountView({ characterId: 91316135 });
    const all = itemRows(container).length;

    const row = container.querySelector('#as-saved-views .as-saved-view');
    expect(row.textContent).toContain('Only Ships');

    row.click();

    const rows = itemRows(container);
    expect(rows.length).toBeLessThan(all);
    expect(rows[0].textContent).toContain('Hulk');
    expect(groupRows(container)).toHaveLength(0);
  });

  test('applying a view marks it active; editing a facet clears that', async () => {
    savedViews = [{
      id: 'v1', name: 'Only Ships',
      config: { cats: { ship: true }, locs: {}, bp: {}, groupBy: 'location', aggregate: false },
    }];

    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#as-saved-views .as-saved-view').click();
    expect(container.querySelector('.as-saved-view.is-active')).not.toBeNull();

    // Changing a filter means you are no longer on the saved view.
    [...container.querySelectorAll('#as-cat-facets .as-facet')]
      .find((f) => f.textContent.includes('Minerals')).click();
    expect(container.querySelector('.as-saved-view.is-active')).toBeNull();
  });

  test('saving over an existing name overwrites instead of duplicating', async () => {
    savedViews = [{
      id: 'v1', name: 'Ships', config: { cats: { ship: true }, groupBy: 'location' },
    }];

    const { container } = await mountView({ characterId: 91316135 });

    await openSaveDialog(container);
    container.querySelector('#as-save-name').value = 'ships'; // case-insensitive
    container.querySelector('#as-save-confirm').click();
    await settle();

    const written = calls.find((c) => c.fn === 'settings.update').updates.savedViews;
    expect(written).toHaveLength(1);
  });

  test('deleting removes it without applying it', async () => {
    savedViews = [{ id: 'v1', name: 'Ships', config: { cats: { ship: true } } }];

    const { container } = await mountView({ characterId: 91316135 });
    const before = itemRows(container).length;

    container.querySelector('.as-view-delete').click();
    await settle();

    const written = calls.find((c) => c.fn === 'settings.update').updates.savedViews;
    expect(written).toHaveLength(0);
    // The click must not fall through to the row and apply the view.
    expect(itemRows(container)).toHaveLength(before);
  });

  test('an unnamed view is refused rather than saved blank', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    await openSaveDialog(container);
    container.querySelector('#as-save-confirm').click();
    await settle();

    expect(calls.some((c) => c.fn === 'settings.update')).toBe(false);
    expect(calls.some((c) => c.fn === 'toast.warning')).toBe(true);
  });

  test('Escape closes the save dialog', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    await openSaveDialog(container);
    expect(container.querySelector('#as-save-modal').hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(container.querySelector('#as-save-modal').hidden).toBe(true);
  });
});

describe('market set picker', () => {
  test('is a plain select, not the searchable component', async () => {
    // Binding rule 5 keeps short fixed lists out of QFSearchSelect; a user
    // typically has two or three market sets.
    const { container } = await mountView({ characterId: 91316135 });

    const picker = container.querySelector('#as-market-set');
    expect(picker.tagName).toBe('SELECT');
  });

  test('lists every market set and preselects the default', async () => {
    marketSets = [
      { id: 'set-1', name: 'UALX', isDefault: false },
      { id: 'set-2', name: 'Jita 4-4', isDefault: true },
    ];

    const { container } = await mountView({ characterId: 91316135 });

    const picker = container.querySelector('#as-market-set');
    expect([...picker.options].map((o) => o.textContent)).toEqual(['UALX', 'Jita 4-4']);
    expect(picker.value).toBe('set-2');
  });

  test('changing it re-prices against the new set', async () => {
    marketSets = [
      { id: 'set-1', name: 'UALX', isDefault: true },
      { id: 'set-2', name: 'Jita 4-4', isDefault: false },
    ];

    const { container } = await mountView({ characterId: 91316135 });
    calls.length = 0;

    const picker = container.querySelector('#as-market-set');
    picker.value = 'set-2';
    picker.dispatchEvent(new Event('change'));
    await settle();

    const repriced = calls.find((c) => c.fn === 'market.calculatePrices');
    expect(repriced.options.marketSetId).toBe('set-2');
  });
});

describe('aggregate duplicates: seeing where things are', () => {
  test('a multi-location row lists every chain with its quantity', async () => {
    // "3 locations" hides exactly what the user needs; the tooltip restores it.
    characterAssets = [
      { itemId: 1, typeId: 34, locationId: 60003760, locationFlag: 'Hangar', quantity: 100, isBlueprintCopy: false },
      { itemId: 2, typeId: 34, locationId: 1035466617946, locationFlag: 'Cargo', quantity: 900, isBlueprintCopy: false },
    ];
    corporationAssets = [];
    locations = {
      60003760: {
        fullPath: 'Jita IV-4 - CNAP', systemName: 'Jita', stationName: 'Jita IV-4 - CNAP',
        containerNames: [], containerPath: [], locationType: 'npc-station',
      },
      1035466617946: {
        fullPath: 'Sotiyo', systemName: 'Perimeter', stationName: 'Sotiyo',
        containerNames: ['Golem'],
        containerPath: [{ itemId: 999, typeId: 28710, locationFlag: 'Hangar' }],
        locationType: 'structure',
      },
    };

    const { container } = await mountView({ characterId: 91316135 });

    const aggregate = container.querySelector('#as-aggregate');
    aggregate.checked = true;
    aggregate.dispatchEvent(new Event('change'));

    const cell = itemRows(container)[0].children[4];
    expect(cell.textContent).toBe('2 locations');

    const tip = cell.querySelector('span').title;
    expect(tip).toContain('900 × Cargo → Golem → Sotiyo');
    expect(tip).toContain('100 × Jita IV-4 - CNAP');
    // Largest stack first - that is the one worth knowing about.
    expect(tip.indexOf('900 ×')).toBeLessThan(tip.indexOf('100 ×'));
  });

  test('the aggregated row is marked hoverable', async () => {
    characterAssets = [
      { itemId: 1, typeId: 34, locationId: 60003760, locationFlag: 'Hangar', quantity: 100, isBlueprintCopy: false },
      { itemId: 2, typeId: 34, locationId: 1035466617946, locationFlag: 'Hangar', quantity: 900, isBlueprintCopy: false },
    ];
    corporationAssets = [];

    const { container } = await mountView({ characterId: 91316135 });
    const aggregate = container.querySelector('#as-aggregate');
    aggregate.checked = true;
    aggregate.dispatchEvent(new Event('change'));

    expect(container.querySelector('.as-has-chain')).not.toBeNull();
  });
});

describe('columns', () => {
  test('the modal opens and lists every column', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#as-columns-btn').click();

    expect(container.querySelector('#as-columns-modal').hidden).toBe(false);
    expect(container.querySelectorAll('.as-column-row')).toHaveLength(7);
  });

  test('unchecking a column removes it from the table', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const before = container.querySelectorAll('#as-thead-row .as-th').length;

    container.querySelector('#as-columns-btn').click();
    const flagRow = [...container.querySelectorAll('.as-column-row')]
      .find((r) => r.textContent.includes('Flag'));
    const box = flagRow.querySelector('input');
    box.checked = false;
    box.dispatchEvent(new Event('change'));

    expect(container.querySelectorAll('#as-thead-row .as-th').length).toBe(before - 1);
    expect(container.querySelector('#as-thead-row').textContent).not.toContain('Flag');
  });

  test('Escape closes the modal', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#as-columns-btn').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(container.querySelector('#as-columns-modal').hidden).toBe(true);
  });
});

describe('CSS contracts (jsdom applies no stylesheets - assert on the text)', () => {
  test('binding rule 6a: hidden beats any explicit display', () => {
    // This view toggles the table, empty state, loading state, selection bar
    // and modal via `hidden`, and all of them set a display. Without this rule
    // they all render on top of each other. A DOM assertion cannot catch it:
    // `expect(el.hidden).toBe(true)` passes while the user sees the element.
    expect(VIEW_CSS).toMatch(/#assets-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  test('binding rule 1: row highlights use box-shadow, never a toggled background', () => {
    const rowRule = VIEW_CSS.match(/\.as-row\s*\{[^}]*\}/)[0];
    const selectedRule = VIEW_CSS.match(/\.as-row\.is-selected\s*\{[^}]*\}/)[0];

    expect(rowRule).toContain('background-color: transparent');
    expect(selectedRule).toContain('box-shadow');
    expect(selectedRule).not.toMatch(/background-color:\s*var/);
  });

  test('binding rule 1 applies to facet rows too', () => {
    const facetRule = VIEW_CSS.match(/\.as-facet\s*\{[^}]*\}/)[0];
    const onRule = VIEW_CSS.match(/\.as-facet\.is-on\s*\{[^}]*\}/)[0];

    expect(facetRule).toContain('background-color: transparent');
    expect(onRule).toContain('box-shadow');
  });

  test('binding rule 4: inputs use --qf-surface-sunken, not --qf-surface', () => {
    const inputRule = VIEW_CSS.match(/\.as-input\s*\{[^}]*\}/)[0];
    expect(inputRule).toContain('var(--qf-surface-sunken)');
  });

  test('binding rule 3: the preset base is INACTIVE, active is a modifier', () => {
    // The base rule used to carry the accent styling, so "All Assets (default)"
    // could never look unselected and two rows appeared active at once.
    const base = VIEW_CSS.match(/\.as-preset\s*\{[^}]*\}/)[0];
    const active = VIEW_CSS.match(/\.as-preset\.is-active\s*\{[^}]*\}/)[0];

    expect(base).not.toContain('var(--qf-accent-dim)');
    expect(active).toContain('var(--qf-accent-dim)');
    // Symmetric: every property the active branch sets is also set in the base,
    // so deselecting always restores it.
    ['color', 'background-color', 'border'].forEach((prop) => {
      expect(base).toMatch(new RegExp(`${prop}(-color)?:`));
    });
  });
});
