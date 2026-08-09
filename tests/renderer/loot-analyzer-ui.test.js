/**
 * @jest-environment jsdom
 *
 * Loot Analyzer shell view.
 *
 * What carries the most risk on this screen:
 *
 *   ROW HIGHLIGHTS - each row is washed in the colour of its recommended
 *   action, and the Item Name column is position:sticky with its OWN
 *   background. A row-level wash is painted over by that cell unless it is
 *   layered with a gradient, so the first column silently goes un-tinted.
 *   jsdom applies no stylesheets, so those assertions are against the
 *   stylesheet TEXT.
 *
 *   BEST-ACTION RULE - reprocess must beat BOTH sell markets outright, and
 *   the sell choice is gated by Minimum SVR. If neither market clears the
 *   gate the answer is 'unknown'; it must NOT fall back to reprocess.
 *
 *   FRESHNESS - the un-ported screen cached the region dashboard once at
 *   load, so its staleness warning could never clear after a refresh. The
 *   badge must RE-READ the dashboard on each evaluation.
 *
 *   PERSISTENCE - settings move from localStorage into quantum_config.json
 *   and are lifted across once, so an upgrading user keeps their setup.
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/loot-analyzer.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/loot-analyzer-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let dashboard;
let parseResult;
let priceResult;
let characters;
let characterSkills;
let settings;
let calls;
let subscribers;
let registered;
let consoleErrors;
let expectedErrorPatterns;

/** A parsed item as loot:parseAndEnrich returns it. */
function item(overrides = {}) {
  return {
    typeId: 34,
    typeName: 'Tritanium',
    quantity: 1000,
    canReprocess: false,
    portionSize: null,
    materials: [],
    typeSpecificSkillId: null,
    ...overrides,
  };
}

/** A price entry as loot:fetchPrices returns it, keyed by typeId. */
function price(overrides = {}) {
  return {
    m1Sell: 6,
    m1Buy: 5,
    m1Svr: 500,
    m1Spread: 16.7,
    ...overrides,
  };
}

function makeApi() {
  const subscribe = (channel, cb) => {
    subscribers[channel] = subscribers[channel] || [];
    subscribers[channel].push(cb);
    return () => {
      subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
    };
  };

  return {
    settings: {
      get: async (category, key) => {
        calls.push({ fn: 'settings.get', category, key });
        if (category !== 'lootAnalyzer') return null;
        return settings[key] === undefined ? null : settings[key];
      },
      update: async (category, updates) => {
        calls.push({ fn: 'settings.update', category, updates });
        return true;
      },
    },
    market: {
      getRegionDashboard: async () => {
        calls.push({ fn: 'market.getRegionDashboard' });
        return dashboard;
      },
    },
    esi: {
      getCharacters: async () => {
        calls.push({ fn: 'esi.getCharacters' });
        return characters;
      },
    },
    loot: {
      parseAndEnrich: async (raw) => {
        calls.push({ fn: 'loot.parseAndEnrich', raw });
        return parseResult;
      },
      fetchPrices: async (params) => {
        calls.push({ fn: 'loot.fetchPrices', params });
        return priceResult;
      },
      getCharacterSkills: async (characterId) => {
        calls.push({ fn: 'loot.getCharacterSkills', characterId });
        return characterSkills;
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
    require('../../src/renderer/loot-analyzer-view-renderer.js');
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

function resultRows(container) {
  return [...container.querySelectorAll('#results-tbody tr')];
}

/** Paste text, pick a market, and run an analysis. */
async function analyze(container, text = 'Tritanium 1000') {
  container.querySelector('#loot-input').value = text;
  const region = container.querySelector('#market1-region');
  if (!region.value) {
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();
  }
  container.querySelector('#analyze-btn').click();
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';

  dashboard = [
    { regionId: 10000002, regionName: 'The Forge', lastFetch: Date.now() },
    { regionId: 10000043, regionName: 'Domain', lastFetch: Date.now() },
  ];
  parseResult = { items: [item()], unresolvedNames: [], parseErrors: [] };
  priceResult = {
    items: { 34: price() },
    materialPrices: {},
    baseYieldRate: 0.542,
  };
  characters = [{ characterId: 91316135, characterName: 'Buckwalter' }];
  // The real envelope shape - NOT a bare skill map.
  characterSkills = { found: true, skills: {} };
  settings = {};
  calls = [];
  subscribers = {};
  registered = null;

  consoleErrors = [];
  expectedErrorPatterns = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.join(' '));
  });

  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  window.QFToast = { show: jest.fn() };
  window.electronAPI = makeApi();
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: jest.fn(),
    },
  };

  // The real freshness module - this screen's badge is its contract.
  jest.isolateModules(() => {
    require('../../public/shared/freshness.js');
  });

  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => p.test(e))
  );
  expect(unexpected).toEqual([]);
  console.error.mockRestore();
});

/* ------------------------------------------------------------------ mount */

describe('mounting', () => {
  test('registers itself as a native shell view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('loot-analyzer');
    expect(registered.def.title).toBe('Loot Analyzer');
  });

  test('populates both market region pickers', async () => {
    const { container } = await mountView();

    const labels = (sel) => [...container.querySelectorAll(`${sel} option`)]
      .map((o) => o.textContent);

    expect(labels('#market1-region')).toEqual(['— Select Region —', 'Domain', 'The Forge']);
    expect(labels('#market2-region')).toEqual(['— None —', 'Domain', 'The Forge']);
  });

  test('says so when no regions are configured', async () => {
    dashboard = [];
    const { container } = await mountView();

    expect(container.querySelector('#no-regions-state').hidden).toBe(false);
  });

  test('the second rig slot is Tatara-only', async () => {
    const { container } = await mountView();
    const group = container.querySelector('#rig-2-group');
    const station = container.querySelector('#station-type');

    expect(group.hidden).toBe(true);

    station.value = 'tatara';
    station.dispatchEvent(new Event('change'));
    expect(group.hidden).toBe(false);

    station.value = 'athanor';
    station.dispatchEvent(new Event('change'));
    expect(group.hidden).toBe(true);
  });

  test('leaving Tatara clears the second rig', async () => {
    // Otherwise a hidden rig stays in the saved config and keeps inflating
    // the yield with no visible control explaining why.
    const { container } = await mountView();
    const station = container.querySelector('#station-type');
    const rig2 = container.querySelector('#rig-2');

    station.value = 'tatara';
    station.dispatchEvent(new Event('change'));
    rig2.value = 't2';
    rig2.dispatchEvent(new Event('change'));

    station.value = 'npc';
    station.dispatchEvent(new Event('change'));

    expect(rig2.value).toBe('none');
    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.reprocessing.rig2).toBe('none');
  });

  test('both Tatara rig slots reach the price call', async () => {
    const { container } = await mountView();
    const station = container.querySelector('#station-type');
    station.value = 'tatara';
    station.dispatchEvent(new Event('change'));
    container.querySelector('#rig-1').value = 't2';
    container.querySelector('#rig-2').value = 't1';

    await analyze(container);

    const sent = calls.find((c) => c.fn === 'loot.fetchPrices').params;
    expect(sent.reprocessingConfig.stationConfig).toMatchObject({
      stationType: 'tatara', rig: 't2', rig2: 't1',
    });
  });
});

describe('effective yield readout', () => {
  test('shows a yield before any analysis has run', async () => {
    // The un-ported screen only filled this in after an analysis, leaving the
    // panel blank while the user tuned the inputs that drive it.
    const { container } = await mountView();

    expect(container.querySelector('#yield-value').textContent).toMatch(/^\d+\.\d%$/);
  });

  test('tracks edits to the config', async () => {
    const { container } = await mountView();
    const readout = () => container.querySelector('#yield-value').textContent;

    const before = readout();

    const skill = container.querySelector('#skill-reprocessing');
    skill.value = '5';
    skill.dispatchEvent(new Event('input'));

    expect(readout()).not.toBe(before);
  });

  test('a Tatara second rig raises it', async () => {
    const { container } = await mountView();
    const station = container.querySelector('#station-type');
    station.value = 'tatara';
    station.dispatchEvent(new Event('change'));

    const rig1 = container.querySelector('#rig-1');
    rig1.value = 't2';
    rig1.dispatchEvent(new Event('change'));
    const oneRig = parseFloat(container.querySelector('#yield-value').textContent);

    const rig2 = container.querySelector('#rig-2');
    rig2.value = 't2';
    rig2.dispatchEvent(new Event('change'));
    const twoRigs = parseFloat(container.querySelector('#yield-value').textContent);

    expect(twoRigs).toBeGreaterThan(oneRig);
  });

  test('an analysis adopts the rate from main in the SAME format', async () => {
    const { container } = await mountView();
    await analyze(container);

    // Not "54.2% base" - the readout must not flip formats depending on
    // whether an analysis has run.
    expect(container.querySelector('#yield-value').textContent).toBe('54.2%');
  });

  test('BOTH yield readouts stay in step', async () => {
    // It appears in the config header and again in the results summary bar;
    // writing only one leaves the other stale.
    const { container } = await mountView();
    const config = () => container.querySelector('#yield-value').textContent;
    const results = () => container.querySelector('#yield-value-results').textContent;

    expect(results()).toBe(config());

    const skill = container.querySelector('#skill-reprocessing');
    skill.value = '5';
    skill.dispatchEvent(new Event('input'));
    expect(results()).toBe(config());

    await analyze(container);
    expect(results()).toBe('54.2%');
    expect(config()).toBe('54.2%');
  });
});

/* ------------------------------------------------------------ hub picking */

describe('trade hubs', () => {
  test('a hub region offers its hub and preselects it', async () => {
    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    const hub = container.querySelector('#market1-hub');

    expect(hub.hidden).toBe(true);

    region.value = '10000002';       // The Forge
    region.dispatchEvent(new Event('change'));
    await settle();

    expect(hub.hidden).toBe(false);
    expect([...hub.options].map((o) => o.textContent))
      .toEqual(['Entire Region', 'Jita IV - Moon 4']);
    expect(hub.value).toBe('60003760');
  });

  test('the hub selection reaches the price call as locationId', async () => {
    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    await analyze(container);

    const sent = calls.find((c) => c.fn === 'loot.fetchPrices').params;
    expect(sent.market1).toEqual({ regionId: 10000002, locationId: 60003760 });
  });

  test('Entire Region clears the locationId', async () => {
    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    const hub = container.querySelector('#market1-hub');
    hub.value = '';
    hub.dispatchEvent(new Event('change'));
    await settle();

    await analyze(container);

    const sent = calls.find((c) => c.fn === 'loot.fetchPrices').params;
    expect(sent.market1).toEqual({ regionId: 10000002, locationId: null });
  });

  test('a non-hub region hides the hub picker entirely', async () => {
    dashboard = [{ regionId: 10000067, regionName: 'Genesis', lastFetch: Date.now() }];
    const { container } = await mountView();

    const region = container.querySelector('#market1-region');
    region.value = '10000067';
    region.dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#market1-hub').hidden).toBe(true);
  });
});

/* ------------------------------------------------------- the best action */

describe('best action', () => {
  /** One reprocessable item with controllable material prices. */
  function reprocessable(overrides = {}) {
    return item({
      typeId: 1234,
      typeName: '10MN Afterburner II',
      quantity: 10,
      canReprocess: true,
      portionSize: 1,
      materials: [{ materialTypeId: 34, quantity: 100 }],
      ...overrides,
    });
  }

  test('reprocess wins only when it beats BOTH sell markets', async () => {
    parseResult = { items: [reprocessable()], unresolvedNames: [], parseErrors: [] };
    priceResult = {
      items: { 1234: price({ m1Sell: 1, m1Buy: 1, m1Svr: 500, m2Sell: 1, m2Buy: 1, m2Svr: 500 }) },
      // 10 items x 100 tritanium x 100% yield x 50 ISK = a big number
      materialPrices: { 34: { m1Sell: 50, m1Buy: 40 } },
      baseYieldRate: 1,
    };

    const { container } = await mountView();
    // A 100% yield keeps the arithmetic legible.
    container.querySelector('#skill-reprocessing').value = '0';
    container.querySelector('#station-type').value = 'npc';

    await analyze(container);

    const row = resultRows(container)[0];
    expect(row.classList.contains('la-row-reprocess')).toBe(true);
    expect(row.querySelector('.la-action').textContent).toBe('Reprocess');
  });

  test('a market below the Minimum SVR gate is disqualified', async () => {
    priceResult = {
      items: { 34: price({ m1Sell: 6, m1Buy: 5, m1Svr: 3 }) },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    const gate = container.querySelector('#min-svr');
    gate.value = '100';
    gate.dispatchEvent(new Event('input'));

    await analyze(container);

    const row = resultRows(container)[0];
    // Not reprocessable and the only market fails the gate -> unknown, NOT a
    // silent fall-back to reprocess.
    expect(row.classList.contains('la-row-sell-m1')).toBe(false);
    expect(row.classList.contains('la-row-reprocess')).toBe(false);
    expect(row.querySelector('.la-action').textContent).toBe('—');
  });

  test('the richer qualifying market wins', async () => {
    priceResult = {
      items: {
        34: price({ m1Sell: 6, m1Buy: 5, m1Svr: 500, m2Sell: 9, m2Buy: 8, m2Svr: 500 }),
      },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    const row = resultRows(container)[0];
    expect(row.classList.contains('la-row-sell-m2')).toBe(true);
    expect(row.querySelector('.la-action').textContent).toBe('Sell M2');
  });

  test('market 1 wins ties', async () => {
    priceResult = {
      items: {
        34: price({ m1Sell: 6, m1Buy: 5, m1Svr: 500, m2Sell: 6, m2Buy: 5, m2Svr: 500 }),
      },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    expect(resultRows(container)[0].classList.contains('la-row-sell-m1')).toBe(true);
  });

  test('an unknown row is left unstyled', async () => {
    priceResult = {
      items: { 34: price({ m1Sell: 0, m1Buy: 0, m1Svr: 0 }) },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    const row = resultRows(container)[0];
    expect(row.className).toBe('');
  });
});

/* ------------------------------------------------------------- the table */

describe('results table', () => {
  test('every column is sortable', async () => {
    // The mockup only marks 6 sortable; the live screen sorts all 15, and the
    // live behaviour wins.
    const { container } = await mountView();
    await analyze(container);

    const sortable = [...container.querySelectorAll('#la-thead-row .la-th.sortable')];
    expect(sortable).toHaveLength(15);
    sortable.forEach((th) => expect(th.dataset.sort).toBeTruthy());
  });

  test('clicking a header sorts and toggles direction', async () => {
    parseResult = {
      items: [
        item({ typeId: 34, typeName: 'Tritanium', quantity: 10 }),
        item({ typeId: 35, typeName: 'Pyerite', quantity: 90 }),
      ],
      unresolvedNames: [],
      parseErrors: [],
    };
    priceResult = {
      items: { 34: price(), 35: price() },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    const qtyTh = [...container.querySelectorAll('.la-th')]
      .find((th) => th.dataset.sort === 'quantity');

    qtyTh.click();
    const desc = resultRows(container).map((r) => r.children[0].textContent);
    expect(desc).toEqual(['Pyerite', 'Tritanium']);

    qtyTh.click();
    const asc = resultRows(container).map((r) => r.children[0].textContent);
    expect(asc).toEqual(['Tritanium', 'Pyerite']);
  });

  test('SVR renders as a per-market PAIR when market 2 is set', async () => {
    // The mockup carries a single SVR value; the live screen shows both.
    priceResult = {
      items: { 34: price({ m1Svr: 500, m2Sell: 7, m2Buy: 6, m2Svr: 12 }) },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    const badges = [...resultRows(container)[0].querySelectorAll('.la-svr')];
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toContain('M1:');
    expect(badges[1].textContent).toContain('M2:');
    // Tiers: >=100 high, >=10 medium, below that low.
    expect(badges[0].className).toContain('is-high');
    expect(badges[1].className).toContain('is-medium');
  });

  test('a single market shows one unlabelled SVR badge', async () => {
    const { container } = await mountView();
    await analyze(container);

    const badges = [...resultRows(container)[0].querySelectorAll('.la-svr')];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).not.toContain('M1:');
  });

  test('ISK cells abbreviate with the full value on hover', async () => {
    priceResult = {
      items: { 34: price({ m1Sell: 1500, m1Buy: 1400, m1Svr: 500 }) },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    // 1000 x 1500 = 1.5M
    const cell = resultRows(container)[0].children[4].querySelector('span');
    expect(cell.textContent).toBe('1.50M');
    expect(cell.title).toBe('1,500,000 ISK');
  });

  test('the grand total sums the best action per row', async () => {
    parseResult = {
      items: [
        item({ typeId: 34, quantity: 1000 }),
        item({ typeId: 35, typeName: 'Pyerite', quantity: 1000 }),
      ],
      unresolvedNames: [],
      parseErrors: [],
    };
    priceResult = {
      items: { 34: price({ m1Sell: 6 }), 35: price({ m1Sell: 4 }) },
      materialPrices: {},
      baseYieldRate: 0.5,
    };

    const { container } = await mountView();
    await analyze(container);

    // (1000 x 6) + (1000 x 4) = 10,000
    expect(container.querySelector('#la-grand-total').title).toBe('10,000 ISK');
    expect(container.querySelector('#la-result-count').textContent).toBe('2 items · best-total');
  });

  test('a non-reprocessable item shows a dash, not a zero', async () => {
    const { container } = await mountView();
    await analyze(container);

    const row = resultRows(container)[0];
    expect(row.children[2].textContent).toBe('—');
    expect(row.children[3].textContent).toBe('—');
  });
});

/* -------------------------------------------------------------- analysing */

describe('analysing', () => {
  test('refuses to run without a market', async () => {
    const { container } = await mountView();
    container.querySelector('#loot-input').value = 'Tritanium 1000';
    container.querySelector('#analyze-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'loot.parseAndEnrich')).toBe(false);
    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/Market 1/), 'warning'
    );
  });

  test('refuses to run with an empty box', async () => {
    const { container } = await mountView();
    container.querySelector('#analyze-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'loot.parseAndEnrich')).toBe(false);
  });

  test('surfaces unresolved lines', async () => {
    parseResult = {
      items: [item()],
      unresolvedNames: ['Wibble Thruster'],
      parseErrors: ['??? 12'],
    };

    const { container } = await mountView();
    await analyze(container);

    const banner = container.querySelector('#unresolved-banner');
    expect(banner.hidden).toBe(false);
    expect(container.querySelector('#unresolved-list').textContent)
      .toBe('Wibble Thruster, ??? 12');
  });

  test('a failure toasts rather than leaving a dead spinner', async () => {
    // The un-ported screen swallowed this into console.error.
    expectedErrorPatterns = [/analysis failed/i];
    window.electronAPI.loot.fetchPrices = async () => { throw new Error('ESI down'); };

    const { container } = await mountView();
    await analyze(container);

    expect(container.querySelector('#loading-overlay').hidden).toBe(true);
    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/ESI down/), 'error'
    );
  });

  test('shows the base yield returned by main', async () => {
    const { container } = await mountView();
    await analyze(container);

    // No " base" suffix: the readout is live before an analysis too, and the
    // format must not change depending on whether one has run. The dedicated
    // assertion lives in the "effective yield readout" block.
    expect(container.querySelector('#yield-value').textContent).toBe('54.2%');
  });

  test('the reprocessing config reaches the price call', async () => {
    const { container } = await mountView();
    container.querySelector('#station-type').value = 'tatara';
    container.querySelector('#station-type').dispatchEvent(new Event('change'));
    container.querySelector('#rig-1').value = 't2';
    container.querySelector('#skill-reprocessing').value = '5';
    container.querySelector('#skill-reprocessing-eff').value = '4';
    container.querySelector('#implant-bonus').value = '0.04';

    await analyze(container);

    const sent = calls.find((c) => c.fn === 'loot.fetchPrices').params;
    expect(sent.reprocessingConfig.stationConfig)
      .toMatchObject({ stationType: 'tatara', rig: 't2' });
    expect(sent.reprocessingConfig.baseSkills)
      .toEqual({ reprocessing: 5, reprocessingEfficiency: 4 });
    expect(sent.reprocessingConfig.implantBonus).toBe(0.04);
  });
});

/* --------------------------------------------------------- ore skills */

describe('ore processing skills', () => {
  test('every input maps to a real SDE skill id', async () => {
    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();

    container.querySelector('#ore-skills-set-all-btn').click();
    await analyze(container);

    const sent = calls.find((c) => c.fn === 'loot.fetchPrices').params;
    const levels = sent.reprocessingConfig.oreSkillLevels;

    // 14 skills, all at 5, keyed by SDE typeId - not by element id.
    expect(Object.keys(levels)).toHaveLength(14);
    expect(levels[60377]).toBe(5);   // Simple Ore Processing
    expect(levels[12196]).toBe(5);   // Scrapmetal Processing
    expect(levels[46156]).toBe(5);   // Exceptional Moon Ore Processing
  });

  test('Clear All zeroes every skill', async () => {
    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();

    container.querySelector('#ore-skills-set-all-btn').click();
    container.querySelector('#ore-skills-clear-btn').click();

    expect(container.querySelector('#skill-simple-ore').value).toBe('0');
    expect(container.querySelector('#skill-moon-rare').value).toBe('0');
  });

  test('loading from a character reads the { found, skills } ENVELOPE', async () => {
    // The handler returns an envelope, not the map. Treating the response as
    // the map itself made every lookup miss, so a character with skills was
    // reported as having none.
    characterSkills = { found: true, skills: { 60377: 5, 12196: 3 } };

    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();

    container.querySelector('#ore-skills-character-select').value = '91316135';
    container.querySelector('#ore-skills-load-char-btn').click();
    await settle();

    expect(container.querySelector('#skill-simple-ore').value).toBe('5');
    expect(container.querySelector('#skill-scrapmetal').value).toBe('3');
    // Absent from the payload, so it lands at 0 rather than being skipped.
    expect(container.querySelector('#skill-moon-rare').value).toBe('0');
    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/loaded/i), 'success'
    );
  });

  test('string keys work too - IPC serialises integer keys', async () => {
    characterSkills = { found: true, skills: { '60377': 4 } };

    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();
    container.querySelector('#ore-skills-character-select').value = '91316135';
    container.querySelector('#ore-skills-load-char-btn').click();
    await settle();

    expect(container.querySelector('#skill-simple-ore').value).toBe('4');
  });

  test('the two BASE reprocessing skills land on the config panel', async () => {
    // 3385/3389 are not in this modal - they drive the main panel inputs, and
    // missing them leaves the yield stuck on the old values.
    characterSkills = { found: true, skills: { 3385: 5, 3389: 4, 60377: 3 } };

    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();
    container.querySelector('#ore-skills-character-select').value = '91316135';
    container.querySelector('#ore-skills-load-char-btn').click();
    await settle();

    expect(container.querySelector('#skill-reprocessing').value).toBe('5');
    expect(container.querySelector('#skill-reprocessing-eff').value).toBe('4');
    // ...and the yield readout reflects them immediately.
    expect(container.querySelector('#yield-value').textContent).toMatch(/^\d+\.\d%$/);
  });

  test('a character with no fetched skills says so', async () => {
    characterSkills = { found: false };

    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();
    container.querySelector('#ore-skills-character-select').value = '91316135';
    container.querySelector('#ore-skills-load-char-btn').click();
    await settle();

    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/No skill data/i), 'warning'
    );
    expect(container.querySelector('#skill-simple-ore').value).toBe('0');
  });

  test('levels are clamped to 0-5', async () => {
    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();

    container.querySelector('#skill-simple-ore').value = '99';
    await analyze(container);

    const sent = calls.find((c) => c.fn === 'loot.fetchPrices').params;
    expect(sent.reprocessingConfig.oreSkillLevels[60377]).toBe(5);
  });

  test('Escape closes the modal', async () => {
    const { container } = await mountView();
    container.querySelector('#ore-skills-btn').click();
    await settle();
    expect(container.querySelector('#ore-skills-modal').hidden).toBe(false);

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(container.querySelector('#ore-skills-modal').hidden).toBe(true);
  });
});

/* -------------------------------------------------------------- freshness */

describe('market data freshness', () => {
  test('fresh data shows no warning', async () => {
    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#market-data-warning').hidden).toBe(true);
  });

  test('stale data warns', async () => {
    dashboard = [{
      regionId: 10000002,
      regionName: 'The Forge',
      lastFetch: Date.now() - (5 * 60 * 60 * 1000),
    }];

    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    const warning = container.querySelector('#market-data-warning');
    expect(warning.hidden).toBe(false);
    expect(warning.classList.contains('is-stale')).toBe(true);
    expect(container.querySelector('#market-data-warning-text').textContent)
      .toContain('The Forge');
  });

  test('a region with no data at all says so', async () => {
    dashboard = [{ regionId: 10000002, regionName: 'The Forge', lastFetch: null }];

    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#market-data-warning-text').textContent)
      .toMatch(/No market data/);
  });

  test('the warning CLEARS on a market refresh - the dashboard is re-read', async () => {
    // The regression this replaces: the un-ported screen read a dashboard
    // cached once at load, so a refresh could never clear its warning.
    dashboard = [{
      regionId: 10000002,
      regionName: 'The Forge',
      lastFetch: Date.now() - (5 * 60 * 60 * 1000),
    }];

    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();
    expect(container.querySelector('#market-data-warning').hidden).toBe(false);

    // Data refreshes in main, then the bus fires.
    dashboard = [{ regionId: 10000002, regionName: 'The Forge', lastFetch: Date.now() }];
    subscribers['market:data-changed'].forEach((cb) => cb());
    await settle();

    expect(container.querySelector('#market-data-warning').hidden).toBe(true);
  });

  test('no market selected means no warning', async () => {
    // Distinct from "region exists but was never fetched" below, even though
    // getFreshness() reports level:'none' for BOTH. Conflating them made the
    // badge claim there was no market data before the user had picked one.
    dashboard = [{ regionId: 10000002, regionName: 'The Forge', lastFetch: null }];
    const { container } = await mountView();

    expect(container.querySelector('#market1-region').value).toBe('');
    expect(container.querySelector('#market-data-warning').hidden).toBe(true);
  });

  test('...but selecting that same never-fetched region DOES warn', async () => {
    dashboard = [{ regionId: 10000002, regionName: 'The Forge', lastFetch: null }];
    const { container } = await mountView();

    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#market-data-warning').hidden).toBe(false);
    expect(container.querySelector('#market-data-warning-text').textContent)
      .toMatch(/No market data/);
  });

  test('clearing the market back to none hides the warning again', async () => {
    dashboard = [{
      regionId: 10000002,
      regionName: 'The Forge',
      lastFetch: Date.now() - (5 * 60 * 60 * 1000),
    }];
    const { container } = await mountView();

    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();
    expect(container.querySelector('#market-data-warning').hidden).toBe(false);

    region.value = '';
    region.dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#market-data-warning').hidden).toBe(true);
  });

  test('destroy releases the freshness subscription', async () => {
    const { instance } = await mountView();
    const before = (subscribers['market:data-changed'] || []).length;
    expect(before).toBeGreaterThan(0);

    instance.destroy();

    expect((subscribers['market:data-changed'] || []).length).toBe(0);
  });
});

/* ------------------------------------------------------------ persistence */

describe('persistence', () => {
  test('selections are saved to the config file, not localStorage', async () => {
    const { container } = await mountView();
    const region = container.querySelector('#market1-region');
    region.value = '10000002';
    region.dispatchEvent(new Event('change'));
    await settle();

    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.category).toBe('lootAnalyzer');
    expect(saved.updates.market1).toEqual({ regionId: 10000002, locationId: 60003760 });
    expect(localStorage.getItem('lootAnalyzer_m1')).toBeNull();
  });

  test('a saved market is restored on mount', async () => {
    settings = { market1: { regionId: 10000043, locationId: 60008494 } };

    const { container } = await mountView();

    expect(container.querySelector('#market1-region').value).toBe('10000043');
    expect(container.querySelector('#market1-hub').value).toBe('60008494');
  });

  test('an upgrading user keeps their localStorage setup', async () => {
    localStorage.setItem('lootAnalyzer_m1', JSON.stringify({ regionId: 10000002, locationId: 60003760 }));
    localStorage.setItem('lootAnalyzer_minSvr', '25');
    localStorage.setItem('lootAnalyzer_oreSkills', JSON.stringify({ 'skill-simple-ore': 4 }));

    const { container } = await mountView();

    expect(container.querySelector('#market1-region').value).toBe('10000002');
    expect(container.querySelector('#min-svr').value).toBe('25');
    expect(container.querySelector('#skill-simple-ore').value).toBe('4');

    // Written through, and the legacy keys cleared so it cannot run twice.
    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.market1).toEqual({ regionId: 10000002, locationId: 60003760 });
    expect(localStorage.getItem('lootAnalyzer_m1')).toBeNull();
    expect(localStorage.getItem('lootAnalyzer_oreSkills')).toBeNull();
  });

  test('a stored config beats a stale localStorage value', async () => {
    settings = { market1: { regionId: 10000043, locationId: null } };
    localStorage.setItem('lootAnalyzer_m1', JSON.stringify({ regionId: 10000002 }));

    const { container } = await mountView();

    expect(container.querySelector('#market1-region').value).toBe('10000043');
  });

  test('ore skills keyed by SDE id do not kill the mount', async () => {
    // THE bug this suite missed: the un-ported screen keyed ore skills by SDE
    // skill id, and restoring that did querySelector('#12189'). A CSS
    // identifier may not start with a digit, so it THREW - aborting mount()
    // before any listener was attached and leaving every control dead.
    settings = { oreSkills: { 60377: 3, 12196: 4, 46156: 2 } };

    const { container } = await mountView();

    // Restored by element id...
    expect(container.querySelector('#skill-simple-ore').value).toBe('3');
    expect(container.querySelector('#skill-scrapmetal').value).toBe('4');
    expect(container.querySelector('#skill-moon-exceptional').value).toBe('2');

    // ...and mount got far enough to wire the listeners up.
    container.querySelector('#ore-skills-btn').click();
    await settle();
    expect(container.querySelector('#ore-skills-modal').hidden).toBe(false);
  });

  test('skill-id keys are rewritten to element ids on save', async () => {
    settings = { oreSkills: { 60377: 3 } };

    await mountView();

    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.oreSkills['skill-simple-ore']).toBe(3);
    expect(saved.updates.oreSkills['60377']).toBeUndefined();
  });

  test('a legacy reprocessing block is understood', async () => {
    // The un-ported screen wrote rig1/skillReprocessing/skillReprocessingEff,
    // the last two as STRINGS.
    settings = {
      reprocessing: {
        stationType: 'athanor',
        rig1: 't2',
        rig2: 'none',
        skillReprocessing: '5',
        skillReprocessingEff: '4',
        implantBonus: '0.02',
      },
    };

    const { container } = await mountView();

    expect(container.querySelector('#rig-1').value).toBe('t2');
    expect(container.querySelector('#skill-reprocessing').value).toBe('5');
    expect(container.querySelector('#skill-reprocessing-eff').value).toBe('4');
    expect(container.querySelector('#implant-bonus').value).toBe('0.02');
  });

  test('a HYBRID block keeps the real values, not the defaults', async () => {
    // An early version of this migration wrote new-shape defaults alongside
    // the legacy keys it copied through, so both keyings coexist. Taking the
    // new key first would discard real 5/5 skills in favour of zeros.
    settings = {
      reprocessing: {
        stationType: 'npc',
        rig: 'none', rig2: 'none',
        reprocessing: 0, reprocessingEfficiency: 0, implantBonus: 0,
        rig1: 't2', skillReprocessing: '5', skillReprocessingEff: '5',
      },
    };

    const { container } = await mountView();

    expect(container.querySelector('#rig-1').value).toBe('t2');
    expect(container.querySelector('#skill-reprocessing').value).toBe('5');
    expect(container.querySelector('#skill-reprocessing-eff').value).toBe('5');
  });

  test('the reprocessing config round-trips', async () => {
    settings = {
      reprocessing: {
        stationType: 'tatara',
        rig: 't2',
        rig2: 't1',
        reprocessing: 5,
        reprocessingEfficiency: 4,
        implantBonus: 0.04,
      },
    };

    const { container } = await mountView();

    expect(container.querySelector('#station-type').value).toBe('tatara');
    expect(container.querySelector('#rig-1').value).toBe('t2');
    expect(container.querySelector('#rig-2').value).toBe('t1');
    expect(container.querySelector('#rig-2-group').hidden).toBe(false);
    expect(container.querySelector('#skill-reprocessing').value).toBe('5');
    expect(container.querySelector('#implant-bonus').value).toBe('0.04');
  });
});

/* --------------------------------------------------------- CSS contracts */

describe('CSS contracts (jsdom applies no stylesheets - assert on the text)', () => {
  test('binding rule 6a: hidden beats any explicit display', () => {
    expect(VIEW_CSS).toMatch(/#la-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  test('all three action rows are washed', () => {
    ['la-row-reprocess', 'la-row-sell-m1', 'la-row-sell-m2'].forEach((cls) => {
      // \s+ not a literal space: these rules are column-aligned in the file.
      const rule = VIEW_CSS.match(new RegExp(`\\.${cls}\\s+\\.la-td\\s*\\{[^}]*\\}`));
      expect(rule).not.toBeNull();
      expect(rule[0]).toContain('background');
    });
  });

  test('the sticky name cell re-layers the wash for EVERY action', () => {
    // This is the whole reason the highlights are fragile: .la-td.col-name
    // paints its own opaque background, so a row-level wash is covered up
    // unless each action restates it as a gradient over that background.
    ['la-row-reprocess', 'la-row-sell-m1', 'la-row-sell-m2'].forEach((cls) => {
      const rule = VIEW_CSS.match(
        new RegExp(`\\.${cls}\\s+\\.la-td\\.col-name\\s*\\{[^}]*background:\\s*linear-gradient[^}]*\\}`)
      );
      expect(rule).not.toBeNull();
      expect(rule[0]).toContain('var(--qf-bg-base)');
    });
  });

  test('the name column is sticky and opaque', () => {
    const rule = VIEW_CSS.match(/\.la-td\.col-name \{[^}]*\}/)[0];
    expect(rule).toContain('position: sticky');
    expect(rule).toContain('background');
  });

  test('each action keeps a distinct left accent bar', () => {
    const bars = ['la-row-reprocess', 'la-row-sell-m1', 'la-row-sell-m2'].map((cls) => {
      const rule = VIEW_CSS.match(
        new RegExp(`\\.${cls}\\s+\\.la-td\\.col-name\\s*\\{[^}]*border-left:[^;]*;`)
      );
      expect(rule).not.toBeNull();
      return rule[0].match(/border-left:\s*4px solid ([^;]+);/)[1];
    });
    expect(new Set(bars).size).toBe(3);
  });

  test('the summary bar is a card, and is spaced off the table', () => {
    // It shipped as a bare heading row sitting almost flush against the
    // table; the mockup has it bordered with the view's normal rhythm below.
    const bar = VIEW_CSS.match(/\.la-results-head \{[^}]*\}/)[0];
    expect(bar).toContain('border:');
    expect(bar).toContain('background:');
    expect(bar).toMatch(/padding:\s*12px 18px/);

    const section = VIEW_CSS.match(/#results-section \{[^}]*\}/)[0];
    expect(section).toContain('flex-direction: column');
    expect(section).toMatch(/gap:\s*16px/);
  });

  test('the table scrolls horizontally ONLY', () => {
    // Vertical scrolling belongs to the view host, so the table grows to full
    // height instead of trapping a second scrollbar inside the card.
    const rule = VIEW_CSS.match(/\.la-table-scroll \{[^}]*\}/)[0];
    expect(rule).toContain('overflow-x: auto');
    expect(rule).not.toMatch(/overflow-y|max-height/);
  });

  test('the header is not sticky, but the name column still is', () => {
    // A sticky header would pin to the VIEW HOST now that the table has no
    // vertical scrollbar, floating it over the panel above.
    const th = VIEW_CSS.match(/^\.la-th \{[^}]*\}/m)[0];
    expect(th).not.toContain('position: sticky');

    // Horizontal stickiness is unaffected - it pins against the container's
    // own overflow-x, which is still there.
    expect(VIEW_CSS.match(/^\.la-th\.col-name \{[^}]*\}/m)[0]).toContain('position: sticky');
    expect(VIEW_CSS.match(/^\.la-td\.col-name \{[^}]*\}/m)[0]).toContain('position: sticky');
  });

  test('hover is restated per action so it cannot wash the colour away', () => {
    ['la-row-reprocess', 'la-row-sell-m1', 'la-row-sell-m2'].forEach((cls) => {
      expect(VIEW_CSS).toContain(`.${cls}:hover .la-td`);
      expect(VIEW_CSS).toContain(`.${cls}:hover .la-td.col-name`);
    });
  });
});
