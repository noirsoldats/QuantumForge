/**
 * @jest-environment jsdom
 *
 * Manufacturing Summary shell view.
 *
 * Unlike the per-character screens this one mounts IN PLACE in the main
 * window's content pane, so there is no window plumbing to test - but there is
 * a lot of filter state, and the calculation now lives in main behind
 * `summary.calculate`.
 *
 * What carries the most risk here:
 *
 *   TECH LEVEL LABELS - the chips compare strings against what the engine's
 *   determineTechLevel emits. The real labels are 'Storyline', 'Navy' and
 *   'Pirate'; 'Faction'/'Officer'/'Deadspace' were invented during the port and
 *   would have made those chips silently match nothing.
 *
 *   PROGRESS SUBSCRIPTION - progress arrives on its own IPC channel because a
 *   callback cannot cross the boundary. It must be disposed after each run or
 *   a second calculation doubles the handlers.
 *
 *   PERSISTENCE - chips, columns, thresholds and selections all live in
 *   quantum_config.json. Chips and columns used to sit in localStorage on the
 *   un-ported screen and are lifted across once, so an upgrading user must
 *   never lose their setup.
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

// Sets window.QFUI, the same way index.html loads it before every view
// renderer. The renderer loads its template through QFUI.loadViewTemplate,
// so without this the mount throws ReferenceError.
require('../../public/shared/ui-helpers.js');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/manufacturing-summary.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/manufacturing-summary-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let marketSets;
let facilities;
let characters;
let plans;
let summaryRows;
let summaryError;
let lastFetchTime;
let toolMarketSet;
let specSettings;
let thresholdSettings;
let selectionSettings;
let chipSettings;
let columnSettings;
let columnOrderSettings;
/** Held promise that keeps a calculation "in flight" so cancel can be tested. */
let summaryGate;
let summaryCancelled;
let calls;
let progressSubscribers;
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

/** One result row, in the shape the engine returns. */
function row(overrides = {}) {
  return {
    blueprintTypeId: 22545,
    // Name and category describe the PRODUCT - the engine emits the product's
    // name and group, not the blueprint's.
    category: 'Mining Barge',
    itemName: 'Hulk',
    blueprintName: 'Hulk Blueprint',
    productTypeId: 22544,
    productName: 'Hulk',
    isOwned: true,
    techLevel: 'T2',
    bpType: 'BPO',
    isSpeculative: false,
    inventionStatus: null,
    ownerCharacterId: 91316135,
    ownerName: 'Buckwalter',
    locationId: 60003760,
    location: 'Jita IV-4 Moon 4',
    meLevel: 10,
    teLevel: 20,
    profit: 550250,
    iskPerHour: 80919,
    svr: 1.4,
    totalCost: 949750,
    roi: 57.94,
    productionTimeHours: 6.8,
    jobCosts: 47000,
    materialPurchaseFees: 24000,
    productSellingFees: 78750,
    tradingFeesTotal: 102750,
    productMarketPrice: 1500000,
    profitPercentage: 36.68,
    manufacturingSteps: 1,
    m3Inputs: 10000,
    m3Outputs: 3750,
    currentSellOrders: 5000,
    profitVelocity: 1200000,
    marketSaturation: 4.2,
    priceMomentum: 0.03,
    profitStability: 0.88,
    demandGrowth: 0.12,
    materialCostVolatility: 0.05,
    marketHealthScore: 0.64,
    ...overrides,
  };
}

function makeApi() {
  return {
    esi: {
      getCharacters: async () => characters,
      getDefaultCharacter: async () => characters[0] || null,
    },
    facilities: {
      getFacilities: async () => facilities,
    },
    market: {
      getMarketSets: async () => marketSets,
      getMarketSetForTool: async (tool) => {
        calls.push({ fn: 'market.getMarketSetForTool', tool });
        return toolMarketSet;
      },
      setMarketSetForTool: async (tool, id) => {
        calls.push({ fn: 'market.setMarketSetForTool', tool, id });
        return true;
      },
      getLastFetchTime: async () => lastFetchTime,
    },
    settings: {
      get: async (category, key) => {
        calls.push({ fn: 'settings.get', category, key });
        if (category !== 'manufacturingSummary') return null;
        if (key === 'speculativeInvention') return specSettings;
        if (key === 'marketThresholds') return thresholdSettings;
        if (key === 'selections') return selectionSettings;
        if (key === 'blueprintChips') return chipSettings;
        if (key === 'visibleColumns') return columnSettings;
        if (key === 'columnOrder') return columnOrderSettings;
        return null;
      },
      update: async (category, updates) => {
        calls.push({ fn: 'settings.update', category, updates });
        return true;
      },
    },
    summary: {
      calculate: async (options) => {
        calls.push({ fn: 'summary.calculate', options });
        // Drive the progress channel the way main does.
        (progressSubscribers || []).forEach((cb) => cb({ done: 5, total: 10, label: 'Pricing' }));
        if (summaryError) throw new Error(summaryError);
        // Main resolves a { cancelled, rows } envelope: a user-requested stop
        // is reported, not thrown, so it never reads as a failure.
        if (summaryGate) await summaryGate;
        if (summaryCancelled) return { cancelled: true, rows: [] };
        return { cancelled: false, rows: summaryRows };
      },
      cancel: async () => {
        calls.push({ fn: 'summary.cancel' });
        summaryCancelled = true;
        return true;
      },
      onProgress: (cb) => {
        progressSubscribers.push(cb);
        calls.push({ fn: 'summary.onProgress' });
        return () => {
          calls.push({ fn: 'summary.onProgress.dispose' });
          progressSubscribers = progressSubscribers.filter((c) => c !== cb);
        };
      },
    },
    plans: {
      // Real signatures, not convenient ones: getAll FILTERS on characterId,
      // and create takes THREE POSITIONAL args. A mock that accepted an
      // object is what let the renderer's wrong call pass for so long.
      getAll: async (characterId) => {
        calls.push({ fn: 'plans.getAll', characterId });
        return plans;
      },
      create: async (characterId, planName, description) => {
        calls.push({ fn: 'plans.create', characterId, planName, description });
        return { planId: 'new-plan' };
      },
      addBlueprint: async (planId, data) => {
        calls.push({ fn: 'plans.addBlueprint', planId, data });
        return true;
      },
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onMarketChanged: (cb) => subscribe('market:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/manufacturing-summary-view-renderer.js');
  });
}

function makeCtx() {
  const tracked = [];
  return {
    tracked,
    ctx: {
      on: (target, type, handler) => target && target.addEventListener(type, handler),
      track: (fn) => { tracked.push(fn); return fn; },
      setInterval: () => 0,
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

/** Run a calculation and wait for it to land. */
async function calculate(container) {
  container.querySelector('#ms-calculate').click();
  await settle();
}

function resultRows(container) {
  return [...container.querySelectorAll('#ms-tbody tr.ms-row')];
}

function headerLabels(container) {
  return [...container.querySelectorAll('#ms-thead-row .ms-th')]
    .map((th) => th.textContent.replace(/[↑↓↕]/g, '').trim())
    .filter(Boolean);
}

beforeEach(() => {
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
  progressSubscribers = [];

  marketSets = [
    { id: 'set-1', name: 'Jita 4-4', isDefault: true },
    { id: 'set-2', name: 'UALX', isDefault: false },
  ];
  // Shaped like the real config: ids and structureTypeId are STRINGS, the
  // default is marked by `usage: 'default'`, and there is no isDefault flag.
  facilities = [
    { id: 'fac-1', name: 'Sotiyo', usage: 'default', structureTypeId: '35827' },
    { id: 'fac-2', name: 'Azbel', usage: 'components', structureTypeId: '35826' },
    { id: 'fac-3', name: 'DT Reactions', usage: 'reactions', structureTypeId: '35825' },
    { id: 'fac-4', name: 'Athanor', usage: 'components', structureTypeId: '35835' },
  ];
  characters = [{ characterId: 91316135, characterName: 'Buckwalter' }];
  plans = [{ id: 'plan-1', name: 'T2 Cruisers' }];
  summaryRows = [row()];
  summaryError = null;
  lastFetchTime = Date.now();
  toolMarketSet = null;
  specSettings = { enabled: false, decryptorStrategy: 'total-per-item' };
  // Null means "nothing stored yet", so the screen falls back to its defaults.
  thresholdSettings = null;
  selectionSettings = null;
  // Mirrors the SHIPPED default: the key exists with null values, because
  // getSetting() merges defaults in. A bare null here would let a "presence
  // means configured" bug pass.
  chipSettings = { tech: null, category: null };
  columnSettings = null;
  columnOrderSettings = null;
  summaryGate = null;
  summaryCancelled = false;

  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: (id, p) => calls.push({ fn: 'router.show', id, params: p }),
    },
  };
  window.electronAPI = makeApi();
  // The REAL QFToast API: show(message, type). No per-type methods.
  window.QFToast = {
    show: (m, type = 'info') => calls.push({ fn: `toast.${type}`, m }),
    setDefaultPosition: () => {},
    dismissAll: () => {},
  };

  localStorage.clear();
  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  document.body.innerHTML = '';
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => e.includes(p))
  );
  expect(unexpected).toEqual([]);
  jest.restoreAllMocks();
  delete global.fetch;
});

/* ------------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers as the "manufacturing-summary" view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('manufacturing-summary');
    expect(typeof registered.def.mount).toBe('function');
  });
});

describe('initial state', () => {
  test('starts on the empty state, not a results table', async () => {
    const { container } = await mountView();

    expect(container.querySelector('#ms-empty').hidden).toBe(false);
    expect(container.querySelector('#ms-results').hidden).toBe(true);
    expect(container.querySelector('#ms-results-head').hidden).toBe(true);
  });

  test('does NOT calculate on mount - that is an explicit action', async () => {
    // A summary pass prices every blueprint; doing it on navigation would be a
    // long, unrequested job.
    await mountView();
    expect(calls.some((c) => c.fn === 'summary.calculate')).toBe(false);
  });

  test('offers the blueprint filters selectBlueprints actually implements', async () => {
    // 'character' was invented during the port - the engine never had a branch
    // for it, so it silently behaved as "owned". 'corp' is a real option that
    // the ported UI dropped entirely, making corp blueprints unreachable.
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-bp-filters .ms-chip')]
      .map((c) => c.textContent);

    expect(labels).toEqual(['All Blueprints', 'Owned BPs', 'Corp BPs']);
  });

  test('offers all three character scopes, always visible', async () => {
    // The mockup and the existing screen both show these unconditionally; a
    // port that hid them behind a blueprint filter stranded the selection.
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-char-filters .ms-chip')]
      .map((c) => c.textContent);

    expect(labels).toEqual(['All Characters', 'Default Character', 'Specific Character']);
  });

  test('the character picker appears only for Specific Character', async () => {
    const { container } = await mountView();
    const wrap = () => container.querySelector('#ms-char-select-wrap');

    expect(wrap().hidden).toBe(true);

    [...container.querySelectorAll('#ms-char-filters .ms-chip')]
      .find((c) => c.textContent === 'Specific Character').click();
    expect(wrap().hidden).toBe(false);

    [...container.querySelectorAll('#ms-char-filters .ms-chip')]
      .find((c) => c.textContent === 'Default Character').click();
    expect(wrap().hidden).toBe(true);
  });

  test('SVR periods match the mockup', async () => {
    const { container } = await mountView();

    const values = [...container.querySelectorAll('#ms-svr-period option')]
      .map((o) => o.value);
    expect(values).toEqual(['7', '14', '30']);
  });

  test('populates the market set, facility and reaction facility pickers', async () => {
    const { container } = await mountView();

    const labels = (sel) => [...container.querySelector(sel).options].map((o) => o.textContent);

    expect(labels('#ms-market-set')).toEqual(['Jita 4-4', 'UALX']);
    // Manufacturing takes EVERY facility...
    expect(labels('#ms-facility')).toEqual(['Sotiyo', 'Azbel', 'DT Reactions', 'Athanor']);
    // ...while reactions take only refineries or usage-tagged ones, behind an
    // explicit "No Facility" placeholder.
    expect(labels('#ms-reaction-facility')).toEqual(['No Facility', 'DT Reactions', 'Athanor']);
  });

  test('preselects the default market set and facility', async () => {
    const { container } = await mountView();

    expect(container.querySelector('#ms-market-set').value).toBe('set-1');
    expect(container.querySelector('#ms-facility').value).toBe('fac-1');
  });

  test('restores the saved speculative invention settings', async () => {
    specSettings = { enabled: true, decryptorStrategy: 'time-optimized' };

    const { container } = await mountView();

    expect(container.querySelector('#ms-spec-enabled').checked).toBe(true);
    expect(container.querySelector('#ms-dec-strategy').value).toBe('time-optimized');
  });

  test('offers exactly the strategies findBestDecryptor implements', async () => {
    // Any other value falls through that function's default branch and
    // silently optimises for something the user did not pick. Four invented
    // values shipped in this dropdown before this test existed.
    const { container } = await mountView();

    const values = [...container.querySelectorAll('#ms-dec-strategy option')]
      .map((o) => o.value);

    expect(values).toEqual([
      'invention-only',
      'total-per-item',
      'total-full-bpc',
      'time-optimized',
    ]);
    // 'custom-volume' was removed: its metric was total-per-item scaled by a
    // constant, which cannot change the ranking, so it could never pick a
    // different decryptor.
    expect(values).not.toContain('custom-volume');
  });
});

describe('tech level chips', () => {
  // The labels MUST match what the engine's determineTechLevel emits. During
  // the port these were written as 'Faction'/'Officer'/'Deadspace', which the
  // engine never produces - those chips would have matched nothing.
  test('use the labels the engine actually emits', async () => {
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-tech-chips .ms-chip')]
      .map((c) => c.textContent);

    expect(labels).toEqual(['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate']);
  });

  test('does NOT re-filter the results already on screen', async () => {
    // Tech chips choose which blueprints go INTO the calculation. They are not
    // a view onto the output, so toggling one must leave the current rows
    // alone - re-filtering here would imply the results can be narrowed
    // without recosting, and would double-filter what the engine already did.
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'A', techLevel: 'T2' }),
      row({ blueprintTypeId: 2, itemName: 'B', techLevel: 'Navy' }),
    ];

    const { container } = await mountView();
    await calculate(container);
    expect(resultRows(container)).toHaveLength(2);

    [...container.querySelectorAll('#ms-tech-chips .ms-chip')]
      .find((c) => c.textContent === 'Navy').click();

    expect(resultRows(container)).toHaveLength(2);
  });

  test('the chip repaints its own selected state', async () => {
    const { container } = await mountView();
    await calculate(container);

    const navy = () => [...container.querySelectorAll('#ms-tech-chips .ms-chip')]
      .find((c) => c.textContent === 'Navy');

    const before = navy().classList.contains('is-on');
    navy().click();
    expect(navy().classList.contains('is-on')).toBe(!before);
  });

  test('toggling a chip shows the recalculate hint', async () => {
    const { container } = await mountView();
    await calculate(container);
    expect(container.querySelector('#ms-stale-notice').hidden).toBe(true);

    [...container.querySelectorAll('#ms-tech-chips .ms-chip')]
      .find((c) => c.textContent === 'Navy').click();

    expect(container.querySelector('#ms-stale-notice').hidden).toBe(false);

    // ...and clears once the rows match the chips again.
    await calculate(container);
    expect(container.querySelector('#ms-stale-notice').hidden).toBe(true);
  });

  test('no hint before anything has been calculated', async () => {
    // With no results on screen the chips are just settings for the first run.
    const { container } = await mountView();

    [...container.querySelectorAll('#ms-tech-chips .ms-chip')]
      .find((c) => c.textContent === 'Navy').click();

    expect(container.querySelector('#ms-stale-notice').hidden).toBe(true);
  });
});

describe('category chips', () => {
  test('are the fixed 14, available before any calculation', async () => {
    // They must NOT be derived from the results: they select what gets loaded
    // and costed, so they have to be usable on a cold screen. 'Reactions' is
    // load-bearing - the engine keys loading reactions at all off it.
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-cat-chips .ms-chip')]
      .map((c) => c.textContent);

    expect(labels).toEqual([
      'Ships', 'Drones', 'Modules', 'Ammo/Charges', 'Components', 'Rigs',
      'Deployables', 'Subsystems', 'Structures', 'Structure Rigs',
      'Structure Modules', 'Boosters', 'Celestials', 'Reactions',
    ]);
  });

  test('repaint their own state without touching the rows', async () => {
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'A', category: 'Ships' }),
      row({ blueprintTypeId: 2, itemName: 'B', category: 'Modules' }),
    ];

    const { container } = await mountView();
    await calculate(container);

    const ships = () => [...container.querySelectorAll('#ms-cat-chips .ms-chip')]
      .find((c) => c.textContent === 'Ships');

    const before = ships().classList.contains('is-on');
    ships().click();

    expect(ships().classList.contains('is-on')).toBe(!before);
    expect(resultRows(container)).toHaveLength(2);
  });
});

describe('calculating', () => {
  test('sends every filter to the engine', async () => {
    const { container } = await mountView();

    container.querySelector('#ms-svr-period').value = '14';
    container.querySelector('#ms-svr-period').dispatchEvent(new Event('change'));
    await calculate(container);

    const call = calls.find((c) => c.fn === 'summary.calculate');
    expect(call.options).toMatchObject({
      blueprintFilter: 'owned',
      marketSetId: 'set-1',
      facilityId: 'fac-1',
      svrPeriod: 14,
      speculativeInvention: false,
    });
  });

  test('sends the chip selections, so the engine can narrow what it costs', async () => {
    // The whole point of the chips: without these on the payload the engine
    // costs every blueprint and the selection silently does nothing.
    const { container } = await mountView();

    const sent = () => calls.find((c) => c.fn === 'summary.calculate').options;

    await calculate(container);
    // Everything is selected by default, matching the live screen.
    expect(sent().techLevels).toEqual(
      expect.arrayContaining(['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'])
    );
    expect(sent().categories).toEqual(expect.arrayContaining(['Ships', 'Reactions']));

    [...container.querySelectorAll('#ms-cat-chips .ms-chip')]
      .find((c) => c.textContent === 'Reactions').click();

    calls.length = 0;
    await calculate(container);
    expect(sent().categories).not.toContain('Reactions');
    expect(sent().categories).toContain('Ships');
  });

  test('the button becomes Cancel while a run is in flight', async () => {
    let release;
    summaryGate = new Promise((resolve) => { release = resolve; });

    const { container } = await mountView();
    const button = container.querySelector('#ms-calculate');
    const label = container.querySelector('#ms-calculate-label');

    button.click();
    await settle();

    expect(label.textContent).toBe('Cancel');
    expect(button.classList.contains('is-cancel')).toBe(true);
    // MUST stay clickable - a disabled button swallows the click, which is
    // how the Assets refresh button ended up looking dead.
    expect(button.disabled).toBe(false);

    release();
    await settle();

    expect(label.textContent).toBe('Calculate Summary');
    expect(button.classList.contains('is-cancel')).toBe(false);
  });

  test('clicking Cancel mid-run asks main to stop', async () => {
    let release;
    summaryGate = new Promise((resolve) => { release = resolve; });

    const { container } = await mountView();
    const button = container.querySelector('#ms-calculate');

    button.click();
    await settle();
    button.click();          // second click = cancel
    await settle();

    expect(calls.some((c) => c.fn === 'summary.cancel')).toBe(true);

    release();
    await settle();

    // A cancellation is not a failure: no error state, and the empty panel
    // explains what happened.
    expect(container.querySelector('#ms-empty').hidden).toBe(false);
    expect(container.querySelector('#ms-empty-title').textContent)
      .toBe('Calculation cancelled');
    expect(resultRows(container)).toHaveLength(0);
  });

  test('a second Calculate click does not start a parallel run', async () => {
    let release;
    summaryGate = new Promise((resolve) => { release = resolve; });

    const { container } = await mountView();
    const button = container.querySelector('#ms-calculate');

    button.click();
    await settle();
    button.click();
    await settle();

    expect(calls.filter((c) => c.fn === 'summary.calculate')).toHaveLength(1);

    release();
    await settle();
  });

  test('shows the results table once rows come back', async () => {
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#ms-results').hidden).toBe(false);
    expect(container.querySelector('#ms-results-head').hidden).toBe(false);
    expect(resultRows(container)).toHaveLength(1);
  });

  test('refuses to run without a facility', async () => {
    facilities = [];
    const { container } = await mountView();

    await calculate(container);

    expect(calls.some((c) => c.fn === 'summary.calculate')).toBe(false);
    expect(calls.some((c) => c.fn === 'toast.warning')).toBe(true);
  });

  test('a failure is a toast, not a blocking alert', async () => {
    // alert() under the shell freezes the whole window.
    allowErrors('Calculation failed');
    summaryError = 'SDE unavailable';
    const alertSpy = jest.fn();
    window.alert = alertSpy;

    const { container } = await mountView();
    await calculate(container);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'toast.error')).toBe(true);
    expect(container.querySelector('#ms-empty').hidden).toBe(false);
  });

  test('the button is re-enabled after a failure', async () => {
    allowErrors('Calculation failed');
    summaryError = 'boom';

    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#ms-calculate').disabled).toBe(false);
    expect(container.querySelector('#ms-calculate-label').textContent).toBe('Calculate Summary');
  });

  test('an empty result explains itself rather than showing a blank table', async () => {
    summaryRows = [];
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#ms-empty').hidden).toBe(false);
    expect(container.querySelector('#ms-empty-title').textContent).toBe('No blueprints match');
  });
});

describe('progress', () => {
  test('subscribes for the run and DISPOSES afterwards', async () => {
    // Progress cannot ride on the invoke() return, so it has its own channel.
    // Leaving it subscribed would double the handlers on the next run.
    const { container } = await mountView();
    await calculate(container);

    expect(calls.some((c) => c.fn === 'summary.onProgress')).toBe(true);
    expect(calls.some((c) => c.fn === 'summary.onProgress.dispose')).toBe(true);
    expect(progressSubscribers).toHaveLength(0);
  });

  test('a second run does not accumulate handlers', async () => {
    const { container } = await mountView();
    await calculate(container);
    await calculate(container);

    expect(progressSubscribers).toHaveLength(0);
  });

  test('disposes even when the calculation throws', async () => {
    allowErrors('Calculation failed');
    summaryError = 'boom';

    const { container } = await mountView();
    await calculate(container);

    expect(progressSubscribers).toHaveLength(0);
  });

  test('the bar is hidden again when the run ends', async () => {
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#ms-progress').hidden).toBe(true);
  });
});

describe('results table', () => {
  test('renders the default columns', async () => {
    const { container } = await mountView();
    await calculate(container);

    const labels = headerLabels(container);
    expect(labels).toContain('Item Name');
    expect(labels).toContain('Profit');
    expect(labels).toContain('ISK/Hour');
    expect(labels).toContain('ROI %');
    // An optional column must NOT be shown by default.
    expect(labels).not.toContain('Market Health Score');
  });

  test('name and category carry a full-text tooltip', async () => {
    // Both truncate, so the untruncated value has to be reachable somehow.
    summaryRows = [row({
      itemName: 'Republic Fleet Nova Heavy Assault Missile Blueprint',
      category: 'Ammunition & Charges',
    })];
    const { container } = await mountView();
    await calculate(container);

    const name = container.querySelector('.ms-item-name');
    const category = container.querySelector('.ms-category');

    expect(name.title).toBe('Republic Fleet Nova Heavy Assault Missile Blueprint');
    expect(category.title).toBe('Ammunition & Charges');
  });

  test('a speculative row is tinted and its BP Type is an amber pill', async () => {
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'Hulk', isSpeculative: false, bpType: 'BPO' }),
      row({
        blueprintTypeId: 2, itemName: 'Vagabond', isOwned: false,
        isSpeculative: true, bpType: 'BPC (Invented)', inventionStatus: 'Speculative',
      }),
    ];
    const { container } = await mountView();
    await calculate(container);

    const rows = resultRows(container);
    expect(rows[0].classList.contains('is-speculative')).toBe(false);
    expect(rows[1].classList.contains('is-speculative')).toBe(true);

    const pill = rows[1].querySelector('.ms-pill.is-speculative');
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe('BPC (Invented)');
    // The non-speculative row gets plain text, not a pill.
    expect(rows[0].querySelector('.ms-pill.is-speculative')).toBeNull();
  });

  test('owner and location render from the row', async () => {
    // Both columns were structurally empty: the engine never emitted the
    // fields the renderer reads.
    summaryRows = [row({ ownerName: 'Buckwalter', location: 'Jita IV-4 Moon 4' })];
    const { container } = await mountView();
    await calculate(container);

    // Both are off by default, so switch them on first. Match on the LABEL
    // element: each row also holds a drag grip, so its textContent is
    // "⋮⋮Owner" and an equality check against the bare label finds nothing.
    container.querySelector('#ms-columns-btn').click();
    ['Owner', 'Location'].forEach((label) => {
      const rowEl = [...container.querySelectorAll('.ms-column-row')]
        .find((r) => r.querySelector('.ms-column-label').textContent === label);
      expect(rowEl).toBeDefined();
      const box = rowEl.querySelector('input');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
    });
    container.querySelector('#ms-columns-apply').click();

    const text = resultRows(container)[0].textContent;
    expect(text).toContain('Buckwalter');
    expect(text).toContain('Jita IV-4 Moon 4');
  });

  test('no Owned badge on the name - the Owned? column already says it', async () => {
    summaryRows = [row({ isOwned: true })];
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('.ms-badge')).toBeNull();
    expect(container.querySelector('.ms-item-name').textContent).not.toMatch(/Owned/);
    // ...and the dedicated column still reports it.
    expect(headerLabels(container)).toContain('Owned?');
  });

  test('a negative profit is marked', async () => {
    summaryRows = [row({ profit: -50000 })];
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('.ms-profit.is-negative')).not.toBeNull();
  });

  test('sorting by a column reorders the rows', async () => {
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'Low', profit: 100 }),
      row({ blueprintTypeId: 2, itemName: 'High', profit: 900 }),
    ];

    const { container } = await mountView();
    await calculate(container);

    // Default sort is profit descending.
    expect(resultRows(container)[0].textContent).toContain('High');

    const profitHeader = [...container.querySelectorAll('.ms-th')]
      .find((th) => th.textContent.includes('Profit'));
    profitHeader.click();

    expect(resultRows(container)[0].textContent).toContain('Low');
  });

  test('search filters by item name', async () => {
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'Hulk Blueprint' }),
      row({ blueprintTypeId: 2, itemName: 'Retriever Blueprint' }),
    ];

    const { container } = await mountView();
    await calculate(container);

    const search = container.querySelector('#ms-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));

    expect(resultRows(container)).toHaveLength(1);
  });

  test('a filter matching nothing CLEARS the table, not just hides it', async () => {
    // The container is hidden when there are no matches, but the rows stay in
    // the DOM unless explicitly cleared - so stale results reappeared the
    // moment the container was shown again.
    const { container } = await mountView();
    await calculate(container);
    expect(resultRows(container)).toHaveLength(1);

    const search = container.querySelector('#ms-search');
    search.value = 'matches-nothing';
    search.dispatchEvent(new Event('input'));

    expect(resultRows(container)).toHaveLength(0);
    expect(container.querySelector('#ms-results').hidden).toBe(true);
    expect(container.querySelector('#ms-empty').hidden).toBe(false);
  });

  test('Escape clears the search', async () => {
    const { container } = await mountView();
    await calculate(container);

    const search = container.querySelector('#ms-search');
    search.value = 'nothing';
    search.dispatchEvent(new Event('input'));
    expect(resultRows(container)).toHaveLength(0);

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(search.value).toBe('');
    expect(resultRows(container)).toHaveLength(1);
  });
});

describe('thresholds', () => {
  test('do NOT filter the results on screen', async () => {
    // The engine applies these while costing - SVR/IPH/profit are outputs of
    // the pricing pass, so a row that survived is already above the threshold
    // that was in force. Re-filtering here would double-apply them, and would
    // wrongly suggest raising a threshold needs no recalculation.
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'Liquid', svr: 5 }),
      row({ blueprintTypeId: 2, itemName: 'Thin', svr: 0.2 }),
    ];

    const { container } = await mountView();
    await calculate(container);
    calls.length = 0;

    const input = container.querySelector('#ms-svr-threshold');
    input.value = '1';
    input.dispatchEvent(new Event('input'));

    expect(resultRows(container)).toHaveLength(2);
    // ...and it must not silently recalculate either.
    expect(calls.some((c) => c.fn === 'summary.calculate')).toBe(false);
    expect(container.querySelector('#ms-stale-notice').hidden).toBe(false);
  });

  test('the IPH input is disabled until its toggle is ticked', async () => {
    const { container } = await mountView();
    const input = container.querySelector('#ms-iph-threshold');

    expect(input.disabled).toBe(true);
    container.querySelector('#ms-iph-enabled').click();
    expect(input.disabled).toBe(false);
  });

  test('thresholds reach the engine on the next calculation', async () => {
    const { container } = await mountView();

    container.querySelector('#ms-iph-enabled').click();
    const iph = container.querySelector('#ms-iph-threshold');
    iph.value = '100000';
    iph.dispatchEvent(new Event('input'));

    const svr = container.querySelector('#ms-svr-threshold');
    svr.value = '1.5';
    svr.dispatchEvent(new Event('input'));

    calls.length = 0;
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.iphEnabled).toBe(true);
    expect(sent.iphThreshold).toBe(100000);
    expect(sent.svrThreshold).toBe(1.5);
  });

  test('enabling a threshold seeds it at 0 rather than leaving it unset', async () => {
    // Matches the live screen: a blank box would read as "no threshold", which
    // is indistinguishable from the toggle being off.
    const { container } = await mountView();

    container.querySelector('#ms-iph-enabled').click();
    calls.length = 0;
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.iphThreshold).toBe(0);
    expect(container.querySelector('#ms-iph-threshold').value).toBe('0');
  });

  test('unticking a threshold empties its input', async () => {
    // A greyed-out field showing a stale number implies the calculation is
    // still using it.
    const { container } = await mountView();
    const toggle = container.querySelector('#ms-iph-enabled');
    const input = container.querySelector('#ms-iph-threshold');

    toggle.click();
    input.value = '250000';
    input.dispatchEvent(new Event('input'));
    expect(input.value).toBe('250000');

    toggle.click();
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);

    calls.length = 0;
    await calculate(container);
    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.iphEnabled).toBe(false);
    expect(sent.iphThreshold).toBeNull();
  });

  test('the profit threshold clears the same way', async () => {
    const { container } = await mountView();
    const toggle = container.querySelector('#ms-profit-enabled');
    const input = container.querySelector('#ms-profit-threshold');

    toggle.click();
    input.value = '5000';
    input.dispatchEvent(new Event('input'));

    toggle.click();
    expect(input.value).toBe('');
  });
});

describe('speculative invention', () => {
  test('the strategy select is disabled until it is enabled', async () => {
    const { container } = await mountView();

    expect(container.querySelector('#ms-dec-strategy').disabled).toBe(true);

    container.querySelector('#ms-spec-enabled').click();
    await settle();

    expect(container.querySelector('#ms-dec-strategy').disabled).toBe(false);
  });

  test('enabling it persists to settings', async () => {
    const { container } = await mountView();

    container.querySelector('#ms-spec-enabled').click();
    await settle();

    const saved = calls.find((c) => c.fn === 'settings.update');
    expect(saved.category).toBe('manufacturingSummary');
    expect(saved.updates.speculativeInvention).toMatchObject({ enabled: true });
  });

  test('no volume input is rendered at all', async () => {
    // The 'custom-volume' strategy is gone, so the field that fed it must be
    // gone too - a stray input with no strategy to use it is dead UI.
    const { container } = await mountView();

    container.querySelector('#ms-spec-enabled').click();
    await settle();

    expect(container.querySelector('#ms-custom-volume-wrap')).toBeNull();
    expect(container.querySelector('#ms-custom-volume')).toBeNull();
  });
});

describe('market set selection', () => {
  test('changing it persists per tool', async () => {
    const { container } = await mountView();

    const select = container.querySelector('#ms-market-set');
    select.value = 'set-2';
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(calls.find((c) => c.fn === 'market.setMarketSetForTool'))
      .toMatchObject({ tool: 'manufacturingSummary', id: 'set-2' });
  });

  test('the saved per-tool set wins over the default', async () => {
    toolMarketSet = { marketSet: { id: 'set-2', name: 'UALX' } };

    const { container } = await mountView();

    expect(container.querySelector('#ms-market-set').value).toBe('set-2');
  });
});

describe('market data staleness', () => {
  test('warns when the data is more than two hours old', async () => {
    lastFetchTime = Date.now() - (3 * 3600000) - (12 * 60000);

    const { container } = await mountView();

    expect(container.querySelector('#ms-staleness').hidden).toBe(false);
    expect(container.querySelector('#ms-staleness-text').textContent).toContain('3h 12m');
  });

  test('stays quiet when the data is fresh', async () => {
    lastFetchTime = Date.now() - (10 * 60000);

    const { container } = await mountView();

    expect(container.querySelector('#ms-staleness').hidden).toBe(true);
  });

  test('re-checks when a market refresh lands elsewhere', async () => {
    const { container } = await mountView();
    expect(container.querySelector('#ms-staleness').hidden).toBe(true);

    lastFetchTime = Date.now() - (5 * 3600000);
    subscribers['market:data-changed'].forEach((cb) => cb({}));
    await settle();

    expect(container.querySelector('#ms-staleness').hidden).toBe(false);
  });
});

describe('columns', () => {
  test('the modal lists every column', async () => {
    const { container } = await mountView();
    await calculate(container);

    container.querySelector('#ms-columns-btn').click();

    expect(container.querySelector('#ms-columns-modal').hidden).toBe(false);
    expect(container.querySelectorAll('.ms-column-row').length).toBeGreaterThan(30);
  });

  test('enabling an optional column adds it to the table', async () => {
    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)).not.toContain('Market Health Score');

    container.querySelector('#ms-columns-btn').click();
    const health = [...container.querySelectorAll('.ms-column-row')]
      .find((r) => r.textContent.includes('Market Health Score'));
    const box = health.querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    container.querySelector('#ms-columns-apply').click();

    expect(headerLabels(container)).toContain('Market Health Score');
  });

  test('the choice persists to the config file, not localStorage', async () => {
    const { container } = await mountView();
    await calculate(container);

    container.querySelector('#ms-columns-btn').click();
    const health = [...container.querySelectorAll('.ms-column-row')]
      .find((r) => r.textContent.includes('Market Health Score'));
    const box = health.querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    container.querySelector('#ms-columns-apply').click();
    await settle();

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.visibleColumns
    ).pop();
    expect(saved.updates.visibleColumns).toContain('market-health-score');
    // localStorage must no longer be written at all.
    expect(localStorage.getItem('manufacturing-summary-columns')).toBeNull();
  });

  test('a saved config is restored on mount', async () => {
    columnSettings = ['name', 'profit', 'market-health-score'];

    const { container } = await mountView();
    await calculate(container);

    const labels = headerLabels(container);
    expect(labels).toEqual(['Item Name', 'Profit', 'Market Health Score']);
  });

  test('an unknown column id in storage is ignored, not rendered blank', async () => {
    columnSettings = ['name', 'a-column-that-was-removed', 'profit'];

    const { container } = await mountView();
    await calculate(container);

    expect(headerLabels(container)).toEqual(['Item Name', 'Profit']);
  });

  test('the default facility comes from usage, not an isDefault flag', async () => {
    // Facilities have no isDefault field. Looking for one fell through to
    // facilities[0], which is right only by luck of ordering.
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#ms-facility').value).toBe('fac-1');
    expect(calls.find((c) => c.fn === 'summary.calculate').options.facilityId).toBe('fac-1');
  });

  test('reaction facilities are refineries or usage-tagged, not everything', async () => {
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-reaction-facility option')]
      .map((o) => o.textContent);

    // 'No Facility' + the reactions-tagged one + the Athanor.
    expect(labels).toEqual(['No Facility', 'DT Reactions', 'Athanor']);
    expect(labels).not.toContain('Sotiyo');
  });

  test('refineries are matched with a STRING structureTypeId', async () => {
    // structureTypeId is stored as a string ("35835"); comparing it to the
    // numeric id matched nothing, so refineries were only picked up when they
    // also happened to carry a reactions usage tag.
    facilities = [{ id: 'r-1', name: 'Tatara', usage: 'components', structureTypeId: '35836' }];

    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-reaction-facility option')]
      .map((o) => o.textContent);
    expect(labels).toContain('Tatara');
  });

  test('no reaction facility is preselected', async () => {
    // Reactions are optional; the live screen leads with "No Facility".
    const { container } = await mountView();
    expect(container.querySelector('#ms-reaction-facility').value).toBe('');

    await calculate(container);
    expect(calls.find((c) => c.fn === 'summary.calculate').options.reactionFacilityId).toBeNull();
  });

  test('every speculative invention selection is persisted', async () => {
    // settings:update merges only ONE level deep, so this object REPLACES the
    // stored one - every field the screen owns must be written every time.
    const { container } = await mountView();

    container.querySelector('#ms-spec-enabled').click();
    const strategy = container.querySelector('#ms-dec-strategy');
    strategy.value = 'time-optimized';
    strategy.dispatchEvent(new Event('change'));
    await settle();

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.speculativeInvention
    ).pop();
    expect(saved.updates.speculativeInvention).toEqual({
      enabled: true,
      decryptorStrategy: 'time-optimized',
    });
  });

  test('source and facility selections are persisted', async () => {
    const { container } = await mountView();

    [...container.querySelectorAll('#ms-bp-filters .ms-chip')]
      .find((c) => c.textContent === 'Corp BPs').click();
    [...container.querySelectorAll('#ms-char-filters .ms-chip')]
      .find((c) => c.textContent === 'Specific Character').click();

    const facility = container.querySelector('#ms-facility');
    facility.value = 'fac-2';
    facility.dispatchEvent(new Event('change'));

    const reaction = container.querySelector('#ms-reaction-facility');
    reaction.value = 'fac-3';
    reaction.dispatchEvent(new Event('change'));
    await settle();

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.selections
    ).pop();
    expect(saved.updates.selections).toMatchObject({
      blueprintFilter: 'corp',
      characterFilter: 'specific',
      facilityId: 'fac-2',
      reactionFacilityId: 'fac-3',
    });
  });

  test('the specific character is stored only when it applies', async () => {
    // A stale id must not resurface if the user switches back to 'specific'
    // after having picked someone else under a different filter.
    const { container } = await mountView();

    [...container.querySelectorAll('#ms-char-filters .ms-chip')]
      .find((c) => c.textContent === 'Specific Character').click();
    [...container.querySelectorAll('#ms-char-filters .ms-chip')]
      .find((c) => c.textContent === 'All Characters').click();
    await settle();

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.selections
    ).pop();
    expect(saved.updates.selections.characterId).toBeNull();
  });

  test('saved selections are restored on mount', async () => {
    selectionSettings = {
      blueprintFilter: 'character',
      characterFilter: 'specific',
      characterId: 91316135,
      facilityId: 'fac-2',
      reactionFacilityId: 'fac-3',
    };

    const { container } = await mountView();

    expect(container.querySelector('#ms-facility').value).toBe('fac-2');
    expect(container.querySelector('#ms-reaction-facility').value).toBe('fac-3');
    expect(container.querySelector('#ms-char-select').value).toBe('91316135');

    await calculate(container);
    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent).toMatchObject({
      blueprintFilter: 'character',
      characterFilter: 'specific',
      characterId: 91316135,
      facilityId: 'fac-2',
      reactionFacilityId: 'fac-3',
    });
  });

  test('a deleted facility falls back instead of selecting nothing', async () => {
    // Facilities can be removed between sessions; a dangling id would leave
    // the dropdown blank and calculate against the wrong place.
    selectionSettings = {
      blueprintFilter: 'owned', characterFilter: 'all', characterId: null,
      facilityId: 'fac-deleted', reactionFacilityId: 'fac-also-gone',
    };

    const { container } = await mountView();

    expect(container.querySelector('#ms-facility').value).toBe('fac-1');
    expect(container.querySelector('#ms-reaction-facility').value).toBe('');
  });

  test('a deleted character resets the filter rather than calculating on a ghost', async () => {
    selectionSettings = {
      blueprintFilter: 'character', characterFilter: 'specific',
      characterId: 999999, facilityId: null, reactionFacilityId: null,
    };

    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.characterFilter).toBe('all');
    expect(sent.characterId).toBeNull();
  });

  test('market thresholds are persisted, not lost on relaunch', async () => {
    // These were in-memory only on the old screen and reset every launch.
    const { container } = await mountView();

    container.querySelector('#ms-iph-enabled').click();
    const iph = container.querySelector('#ms-iph-threshold');
    iph.value = '250000';
    iph.dispatchEvent(new Event('input'));

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.marketThresholds
    ).pop();
    expect(saved.updates.marketThresholds).toMatchObject({
      iphEnabled: true,
      iphThreshold: 250000,
    });
  });

  test('saved thresholds are restored and reach the engine', async () => {
    thresholdSettings = {
      // Must be one of the offered periods (7/14/30) - a value with no
      // matching <option> leaves the select showing '', so this doubles as a
      // check that the stored value is actually selectable.
      svrPeriod: 14,
      svrThreshold: 1.5,
      iphEnabled: true,
      iphThreshold: 250000,
      profitEnabled: false,
      profitThreshold: null,
    };

    const { container } = await mountView();

    expect(container.querySelector('#ms-svr-period').value).toBe('14');
    expect(container.querySelector('#ms-svr-threshold').value).toBe('1.5');
    expect(container.querySelector('#ms-iph-enabled').checked).toBe(true);
    expect(container.querySelector('#ms-iph-threshold').disabled).toBe(false);

    await calculate(container);
    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.svrPeriod).toBe(14);
    expect(sent.svrThreshold).toBe(1.5);
    expect(sent.iphThreshold).toBe(250000);
  });

  test('a persisted threshold of 0 is restored, not treated as unset', async () => {
    // 0 is a real choice ("anything not loss-making"); a truthiness check on
    // load would silently discard it.
    thresholdSettings = {
      svrPeriod: 30, svrThreshold: null,
      iphEnabled: false, iphThreshold: null,
      profitEnabled: true, profitThreshold: 0,
    };

    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.profitEnabled).toBe(true);
    expect(sent.profitThreshold).toBe(0);
  });

  test('filter chips persist to the config file as arrays of selected names', async () => {
    const { container } = await mountView();

    [...container.querySelectorAll('#ms-cat-chips .ms-chip')]
      .find((c) => c.textContent === 'Reactions').click();
    await settle();

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.blueprintChips
    ).pop();
    expect(Array.isArray(saved.updates.blueprintChips.tech)).toBe(true);
    expect(saved.updates.blueprintChips.tech).toEqual(
      expect.arrayContaining(['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'])
    );
    expect(saved.updates.blueprintChips.category).not.toContain('Reactions');
    expect(saved.updates.blueprintChips.category).toContain('Ships');
    expect(localStorage.getItem('manufacturing-summary-filters')).toBeNull();
  });

  test('a saved chip config is restored on mount', async () => {
    chipSettings = { tech: ['T2'], category: ['Ships', 'Reactions'] };

    const { container } = await mountView();

    const on = (sel) => [...container.querySelectorAll(sel)]
      .filter((c) => c.classList.contains('is-on'))
      .map((c) => c.textContent);

    expect(on('#ms-tech-chips .ms-chip')).toEqual(['T2']);
    expect(on('#ms-cat-chips .ms-chip')).toEqual(['Ships', 'Reactions']);
  });

  test('a saved filter set reaches the engine on the next calculation', async () => {
    chipSettings = { tech: ['T2'], category: ['Ships'] };

    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.techLevels).toEqual(['T2']);
    expect(sent.categories).toEqual(['Ships']);
  });

  test('an explicitly empty saved selection is honoured, not reset to all', async () => {
    // The user really did deselect everything; silently re-enabling every chip
    // would fight them on every launch. An empty ARRAY is a real choice - only
    // null/absent means "never configured".
    chipSettings = { tech: [], category: [] };

    const { container } = await mountView();

    expect(container.querySelectorAll('#ms-tech-chips .ms-chip.is-on')).toHaveLength(0);
    expect(container.querySelectorAll('#ms-cat-chips .ms-chip.is-on')).toHaveLength(0);
  });

  test('an unknown chip name in storage is dropped, not rendered', async () => {
    chipSettings = {
      tech: ['T2', 'Faction'],       // 'Faction' was never a real tech level
      category: ['Ships', 'Gone'],
    };

    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#ms-tech-chips .ms-chip')]
      .map((c) => c.textContent);
    expect(labels).not.toContain('Faction');

    await calculate(container);
    const sent = calls.find((c) => c.fn === 'summary.calculate').options;
    expect(sent.techLevels).toEqual(['T2']);
    expect(sent.categories).toEqual(['Ships']);
  });

  /* ------------------------------------------------ localStorage migration */

  test('an upgrading user keeps their chips, lifted out of localStorage', async () => {
    // The un-ported screen stored these in localStorage. Nobody should lose
    // their setup just because the storage location moved.
    localStorage.setItem('manufacturing-summary-filters', JSON.stringify({
      tech: ['T2'], category: ['Ships'],
    }));

    const { container } = await mountView();

    const on = (sel) => [...container.querySelectorAll(sel)]
      .filter((c) => c.classList.contains('is-on'))
      .map((c) => c.textContent);
    expect(on('#ms-tech-chips .ms-chip')).toEqual(['T2']);
    expect(on('#ms-cat-chips .ms-chip')).toEqual(['Ships']);

    // Written through to the config, and the legacy key cleared so the
    // migration cannot run a second time.
    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.blueprintChips
    ).pop();
    expect(saved.updates.blueprintChips).toEqual({ tech: ['T2'], category: ['Ships'] });
    expect(localStorage.getItem('manufacturing-summary-filters')).toBeNull();
  });

  test('an upgrading user keeps their columns', async () => {
    localStorage.setItem(
      'manufacturing-summary-columns',
      JSON.stringify(['name', 'profit', 'market-health-score'])
    );

    const { container } = await mountView();
    await calculate(container);

    expect(headerLabels(container)).toEqual(['Item Name', 'Profit', 'Market Health Score']);

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.visibleColumns
    ).pop();
    expect(saved.updates.visibleColumns).toEqual(['name', 'profit', 'market-health-score']);
    expect(localStorage.getItem('manufacturing-summary-columns')).toBeNull();
  });

  test('a config already in settings wins over a stale localStorage value', async () => {
    // Once migrated, the config file is the only source of truth - a leftover
    // legacy key must never resurrect an old selection.
    chipSettings = { tech: ['T3'], category: ['Rigs'] };
    localStorage.setItem('manufacturing-summary-filters', JSON.stringify({
      tech: ['T2'], category: ['Ships'],
    }));

    const { container } = await mountView();

    const on = (sel) => [...container.querySelectorAll(sel)]
      .filter((c) => c.classList.contains('is-on'))
      .map((c) => c.textContent);
    expect(on('#ms-tech-chips .ms-chip')).toEqual(['T3']);
    expect(on('#ms-cat-chips .ms-chip')).toEqual(['Rigs']);
  });

  test('a deselect-everything config is not overwritten by a legacy value', async () => {
    // The shipped default is {tech: null, category: null}, so the KEY always
    // exists. Testing presence rather than array-ness would treat a genuine
    // empty selection as "unconfigured" and clobber it from localStorage.
    chipSettings = { tech: [], category: [] };
    localStorage.setItem('manufacturing-summary-filters', JSON.stringify({
      tech: ['T2'], category: ['Ships'],
    }));

    const { container } = await mountView();

    expect(container.querySelectorAll('#ms-tech-chips .ms-chip.is-on')).toHaveLength(0);
  });

  test('nothing stored anywhere means every chip on', async () => {
    const { container } = await mountView();

    expect(container.querySelectorAll('#ms-tech-chips .ms-chip.is-on')).toHaveLength(6);
    expect(container.querySelectorAll('#ms-cat-chips .ms-chip.is-on')).toHaveLength(14);
  });

  test('Reset to Default restores the default set', async () => {
    localStorage.setItem('manufacturing-summary-columns', JSON.stringify(['name']));

    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)).toEqual(['Item Name']);

    container.querySelector('#ms-columns-btn').click();
    container.querySelector('#ms-columns-reset').click();
    container.querySelector('#ms-columns-apply').click();

    expect(headerLabels(container)).toContain('ROI %');
  });

  /* ------------------------------------------------- drag reordering --- */

  /** Drive a full HTML5 drag from one column row onto another. */
  function dragColumnOnto(container, fromLabel, toLabel) {
    const rowFor = (label) => [...container.querySelectorAll('.ms-column-row')]
      .find((r) => r.querySelector('.ms-column-label').textContent === label);

    const from = rowFor(fromLabel);
    const to = rowFor(toLabel);

    // jsdom has no DataTransfer, so supply the minimum the handlers touch.
    const data = new Map();
    const dataTransfer = {
      effectAllowed: '', dropEffect: '',
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) || '',
    };
    const fire = (node, type) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      event.dataTransfer = dataTransfer;
      node.dispatchEvent(event);
      return event;
    };

    fire(from, 'dragstart');
    fire(to, 'dragover');
    fire(to, 'drop');
    fire(from, 'dragend');
  }

  const columnOrderLabels = (container) =>
    [...container.querySelectorAll('.ms-column-row')]
      .map((r) => r.querySelector('.ms-column-label').textContent);

  test('ticking a column updates the table immediately, without Apply', async () => {
    // The existing screen applies column changes live; requiring Apply was a
    // regression introduced by the port.
    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)).not.toContain('Owner');

    container.querySelector('#ms-columns-btn').click();
    const target = [...container.querySelectorAll('.ms-column-row')]
      .find((r) => r.querySelector('.ms-column-label').textContent === 'Owner');
    const box = target.querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));

    // No Apply click.
    expect(headerLabels(container)).toContain('Owner');
  });

  test('unticking removes the column immediately', async () => {
    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)).toContain('ROI %');

    container.querySelector('#ms-columns-btn').click();
    const target = [...container.querySelectorAll('.ms-column-row')]
      .find((r) => r.querySelector('.ms-column-label').textContent === 'ROI %');
    const box = target.querySelector('input');
    box.checked = false;
    box.dispatchEvent(new Event('change'));

    expect(headerLabels(container)).not.toContain('ROI %');
  });

  test('dragging reorders the table immediately', async () => {
    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)[0]).toBe('Category');

    container.querySelector('#ms-columns-btn').click();
    dragColumnOnto(container, 'Profit', 'Category');

    expect(headerLabels(container)[0]).toBe('Profit');
  });

  test('Reset to Default updates the table immediately', async () => {
    columnOrderSettings = ['profit', 'name', 'category'];

    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)[0]).toBe('Profit');

    container.querySelector('#ms-columns-btn').click();
    container.querySelector('#ms-columns-reset').click();

    expect(headerLabels(container)[0]).toBe('Category');
  });

  test('dragging a column reorders it', async () => {
    const { container } = await mountView();
    await calculate(container);
    container.querySelector('#ms-columns-btn').click();

    const before = columnOrderLabels(container);
    expect(before[0]).toBe('Category');

    dragColumnOnto(container, 'Profit', 'Category');

    const after = columnOrderLabels(container);
    expect(after[0]).toBe('Profit');
    expect(after).toHaveLength(before.length);
  });

  test('the drop handler survives the dragover repaint', async () => {
    // Binding rule 2a: re-rendering during a drag destroys the element the
    // drag started on, so `drop` is never delivered and the row snaps back.
    // Assert element IDENTITY across the drag - re-querying after a rebuild
    // would pass while the bug is present.
    const { container } = await mountView();
    await calculate(container);
    container.querySelector('#ms-columns-btn').click();

    const rowsBefore = [...container.querySelectorAll('.ms-column-row')];
    dragColumnOnto(container, 'Profit', 'Category');
    const rowsAfter = [...container.querySelectorAll('.ms-column-row')];

    // Same node objects, merely re-sequenced.
    expect(rowsAfter).toHaveLength(rowsBefore.length);
    rowsBefore.forEach((node) => expect(rowsAfter).toContain(node));
  });

  test('ticking a checkbox does NOT rebuild the list', async () => {
    // Rebuilding resets scrollTop, which threw the user back to the top on
    // every click. jsdom does no layout, so scrollTop cannot be asserted -
    // element identity is the observable proxy for "was not rebuilt".
    const { container } = await mountView();
    await calculate(container);
    container.querySelector('#ms-columns-btn').click();

    const rowsBefore = [...container.querySelectorAll('.ms-column-row')];
    const target = rowsBefore.find(
      (r) => r.querySelector('.ms-column-label').textContent === 'Owner'
    );
    const box = target.querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));

    const rowsAfter = [...container.querySelectorAll('.ms-column-row')];
    expect(rowsAfter[0]).toBe(rowsBefore[0]);
    expect(rowsAfter).toHaveLength(rowsBefore.length);
  });

  test('a drag-reordered sequence is persisted and restored', async () => {
    const { container } = await mountView();
    await calculate(container);
    container.querySelector('#ms-columns-btn').click();
    dragColumnOnto(container, 'Profit', 'Category');

    const saved = calls.filter(
      (c) => c.fn === 'settings.update' && c.updates.columnOrder
    ).pop();
    expect(saved.updates.columnOrder[0]).toBe('profit');

    // A stored order must come back on the next mount.
    columnOrderSettings = saved.updates.columnOrder;
    const remounted = await mountView();
    await calculate(remounted.container);
    expect(headerLabels(remounted.container)[0]).toBe('Profit');
  });

  test('a saved order missing a NEW column still includes it', async () => {
    // A release that adds a column must not make it unreachable for anyone
    // with a stored order predating it.
    columnOrderSettings = ['profit', 'name'];

    const { container } = await mountView();
    await calculate(container);
    container.querySelector('#ms-columns-btn').click();

    const labels = columnOrderLabels(container);
    expect(labels[0]).toBe('Profit');
    expect(labels[1]).toBe('Item Name');
    expect(labels).toContain('Category');
    expect(labels.length).toBeGreaterThan(30);
  });

  test('Reset to Default restores the default ORDER, not just the set', async () => {
    columnOrderSettings = ['profit', 'name', 'category'];

    const { container } = await mountView();
    await calculate(container);
    container.querySelector('#ms-columns-btn').click();
    expect(columnOrderLabels(container)[0]).toBe('Profit');

    container.querySelector('#ms-columns-reset').click();

    expect(columnOrderLabels(container)[0]).toBe('Category');
    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.columnOrder).toBeNull();
  });

  test('Escape closes the modal', async () => {
    const { container } = await mountView();
    await calculate(container);

    container.querySelector('#ms-columns-btn').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(container.querySelector('#ms-columns-modal').hidden).toBe(true);
  });
});

describe('add to plan', () => {
  test('the button only appears once rows are selected', async () => {
    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#ms-add-to-plan').hidden).toBe(true);

    resultRows(container)[0].querySelector('.is-check').click();

    expect(container.querySelector('#ms-add-to-plan').hidden).toBe(false);
    expect(container.querySelector('#ms-add-to-plan-label').textContent).toBe('Add to Plan (1)');
  });

  test('adds each selected blueprint to the chosen plan', async () => {
    summaryRows = [
      row({ blueprintTypeId: 1, itemName: 'A' }),
      row({ blueprintTypeId: 2, itemName: 'B' }),
    ];

    const { container } = await mountView();
    await calculate(container);

    resultRows(container).forEach((r) => r.querySelector('.is-check').click());
    container.querySelector('#ms-add-to-plan').click();
    await settle();

    container.querySelector('#ms-plan-select').value = 'plan-1';
    container.querySelector('#ms-plan-runs').value = '5';
    container.querySelector('#ms-plan-confirm').click();
    await settle();

    const added = calls.filter((c) => c.fn === 'plans.addBlueprint');
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ planId: 'plan-1' });
    expect(added[0].data).toMatchObject({ runs: 5, blueprintTypeId: 1 });
  });

  test('creating a new plan requires a name', async () => {
    const { container } = await mountView();
    await calculate(container);

    resultRows(container)[0].querySelector('.is-check').click();
    container.querySelector('#ms-add-to-plan').click();
    await settle();

    // '__new__' is preselected, and the name field is blank.
    container.querySelector('#ms-plan-confirm').click();
    await settle();

    expect(calls.some((c) => c.fn === 'plans.create')).toBe(false);
    expect(calls.some((c) => c.fn === 'toast.warning')).toBe(true);
  });

  test('a named new plan is created, then filled', async () => {
    const { container } = await mountView();
    await calculate(container);

    resultRows(container)[0].querySelector('.is-check').click();
    container.querySelector('#ms-add-to-plan').click();
    await settle();

    container.querySelector('#ms-plan-name').value = 'Fresh Plan';
    container.querySelector('#ms-plan-confirm').click();
    await settle();

    // Positional: (characterId, planName, description). The name must land in
    // the SECOND slot - an object in the first drops it entirely and creates
    // the plan against a bogus owner.
    const created = calls.find((c) => c.fn === 'plans.create');
    expect(created.planName).toBe('Fresh Plan');
    expect(created.characterId).toBe(91316135);

    const added = calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(added.planId).toBe('new-plan');
    // The handler destructures meLevel/teLevel; materialEfficiency and
    // timeEfficiency were never read.
    expect(added.data).toMatchObject({ meLevel: 10, teLevel: 20 });
    expect(added.data.materialEfficiency).toBeUndefined();
  });

  test('plans are fetched for a character, not globally', async () => {
    const { container } = await mountView();
    await calculate(container);

    resultRows(container)[0].querySelector('.is-check').click();
    container.querySelector('#ms-add-to-plan').click();
    await settle();

    // getAll() with no id filters on undefined and returns nothing, so the
    // dropdown was always just "Create a new plan…".
    expect(calls.find((c) => c.fn === 'plans.getAll').characterId).toBe(91316135);
  });

  test('the selection clears after a successful add', async () => {
    const { container } = await mountView();
    await calculate(container);

    resultRows(container)[0].querySelector('.is-check').click();
    container.querySelector('#ms-add-to-plan').click();
    await settle();

    container.querySelector('#ms-plan-select').value = 'plan-1';
    container.querySelector('#ms-plan-confirm').click();
    await settle();

    expect(container.querySelector('#ms-add-to-plan').hidden).toBe(true);
  });
});

describe('remount hygiene', () => {
  test('a remount does not inherit the previous run', async () => {
    // `state` is module-level and survives unmount.
    const first = await mountView();
    await calculate(first.container);
    expect(resultRows(first.container)).toHaveLength(1);

    first.ctx.dispose();
    if (registered.def.destroy) registered.def.destroy();

    const second = await mountView();

    expect(second.container.querySelector('#ms-results').hidden).toBe(true);
    expect(second.container.querySelector('#ms-empty').hidden).toBe(false);
    expect(second.container.querySelector('#ms-search').value).toBe('');
  });
});

describe('CSS contracts (jsdom applies no stylesheets - assert on the text)', () => {
  test('binding rule 6a: hidden beats any explicit display', () => {
    expect(VIEW_CSS).toMatch(/#summary-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  test('binding rule 1: chip highlights use box-shadow, not a toggled background', () => {
    const base = VIEW_CSS.match(/\.ms-chip\s*\{[^}]*\}/)[0];
    const on = VIEW_CSS.match(/\.ms-chip\.is-on\s*\{[^}]*\}/)[0];

    expect(base).toContain('background-color');
    expect(on).toContain('box-shadow');
    expect(on).not.toMatch(/background-color:\s*var/);
  });

  test('the two text columns are capped and truncate, Name wider than Category', () => {
    // jsdom computes no layout, so a rendered-width assertion is impossible -
    // the stylesheet text is the only place this can be checked.
    const name = VIEW_CSS.match(/^\.ms-item-name\s*\{[^}]*\}/m)[0];
    const category = VIEW_CSS.match(/^\.ms-category\s*\{[^}]*\}/m)[0];

    [name, category].forEach((rule) => {
      expect(rule).toContain('overflow: hidden');
      expect(rule).toContain('text-overflow: ellipsis');
      expect(rule).toContain('white-space: nowrap');
    });

    const px = (rule) => parseInt(rule.match(/max-width:\s*(\d+)px/)[1], 10);
    expect(px(category)).toBeLessThan(px(name));
  });

  test('the speculative tint is box-shadow, and selection still wins', () => {
    // A row that is amber on its FIRST paint is exactly the case binding
    // rule 1 exists for - a toggled background would not clear.
    const spec = VIEW_CSS.match(/^\.ms-row\.is-speculative\s*\{[^}]*\}/m)[0];
    expect(spec).toContain('box-shadow');
    expect(spec).not.toMatch(/^\s*background(-color)?:/m);

    // A ticked speculative row must read as selected, so the combined rule
    // has to exist and come after the single-class ones.
    const combined = VIEW_CSS.indexOf('.ms-row.is-speculative.is-selected');
    expect(combined).toBeGreaterThan(VIEW_CSS.indexOf('.ms-row.is-selected {'));
    expect(VIEW_CSS.slice(combined, combined + 200)).toContain('--qf-accent-dim');
  });

  test('binding rule 1 applies to result rows too', () => {
    const base = VIEW_CSS.match(/\.ms-row\s*\{[^}]*\}/)[0];
    const on = VIEW_CSS.match(/\.ms-row\.is-selected\s*\{[^}]*\}/)[0];

    expect(base).toContain('background-color: transparent');
    expect(on).toContain('box-shadow');
  });

  test('binding rule 4: inputs use --qf-surface-sunken', () => {
    const rule = VIEW_CSS.match(/\.ms-input\s*\{[^}]*\}/)[0];
    expect(rule).toContain('var(--qf-surface-sunken)');
  });
});
