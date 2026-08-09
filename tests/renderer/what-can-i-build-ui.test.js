/**
 * @jest-environment jsdom
 *
 * What Can I Build? shell view.
 *
 * What carries the most risk here:
 *
 *   ASSET SOURCE TREE - three levels (character -> personal/corp ->
 *   divisions) collapsing into the {personal, corporation} shape
 *   aggregateAssets expects. A wrong shape means the calculation silently
 *   costs against no assets at all.
 *
 *   IPC CONTRACTS - plans.create takes POSITIONAL args, plans.getAll FILTERS
 *   on characterId, and addBlueprint destructures `lines`/`meLevel`. Mocks
 *   below mirror the real signatures; a permissive mock is what let three of
 *   these ship elsewhere in the app.
 *
 *   PERSISTENCE - nine `cleanup-tool-*` localStorage keys become one settings
 *   block, migrated once. They are a MIX of JSON and bare strings.
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/what-can-i-build.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/what-can-i-build-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let assetSources;
let marketSets;
let facilities;
let characters;
let plans;
let wcibResult;
let wcibError;
let wcibGate;
let wcibCancelled;
let refreshResult;
let settings;
let calls;
let progressSubscribers;
let busSubscribers;
let dashboard;
let registered;
let consoleErrors;
let expectedErrorPatterns;

/** A row as the engine returns it. */
function row(overrides = {}) {
  return {
    blueprintTypeId: 22545,
    itemName: 'Hulk',
    blueprintName: 'Hulk Blueprint',
    category: 'Mining Barge',
    productTypeId: 22544,
    tech: 'T2',
    techLevel: 'T2',
    isOwned: true,
    bpType: 'BPO',
    meLevel: 10,
    teLevel: 20,
    percentOnHand: 100,
    buildableRuns: 4,
    profit: 550250,
    iskPerHour: 80919,
    svr: 1.4,
    totalCost: 949750,
    roi: 57.94,
    productMarketPrice: 1500000,
    productionTimeHours: 6.8,
    ownerCharacterId: 91316135,
    ownerName: 'Buckwalter',
    locationId: 60003760,
    location: 'Jita IV-4',
    isCorporationBlueprint: false,
    ...overrides,
  };
}

function makeApi() {
  // Channel-aware: the progress channel and the data bus are separate, and
  // conflating them would let a progress handler satisfy a bus assertion.
  const subscribe = (channel, cb) => {
    busSubscribers[channel] = busSubscribers[channel] || [];
    busSubscribers[channel].push(cb);
    return () => {
      busSubscribers[channel] = busSubscribers[channel].filter((c) => c !== cb);
    };
  };

  return {
    settings: {
      get: async (category, key) => {
        calls.push({ fn: 'settings.get', category, key });
        if (category !== 'whatCanIBuild') return null;
        return settings[key] === undefined ? null : settings[key];
      },
      update: async (category, updates) => {
        calls.push({ fn: 'settings.update', category, updates });
        return true;
      },
    },
    cleanupTool: {
      getAssetSources: async () => {
        calls.push({ fn: 'cleanupTool.getAssetSources' });
        return assetSources;
      },
      refreshAssets: async (characterIds) => {
        calls.push({ fn: 'cleanupTool.refreshAssets', characterIds });
        return refreshResult;
      },
      aggregateAssets: async (sources) => {
        calls.push({ fn: 'cleanupTool.aggregateAssets', sources });
        return {};
      },
    },
    wcib: {
      calculate: async (options) => {
        calls.push({ fn: 'wcib.calculate', options });
        progressSubscribers.forEach((cb) => cb({ done: 3, total: 6, label: 'Costing' }));
        if (wcibError) throw new Error(wcibError);
        if (wcibGate) await wcibGate;
        if (wcibCancelled) return { cancelled: true, rows: [], assetTypeCount: 0 };
        return wcibResult;
      },
      cancel: async () => {
        calls.push({ fn: 'wcib.cancel' });
        wcibCancelled = true;
        return true;
      },
      onProgress: (cb) => {
        calls.push({ fn: 'wcib.onProgress' });
        progressSubscribers.push(cb);
        return () => {
          progressSubscribers = progressSubscribers.filter((c) => c !== cb);
        };
      },
    },
    market: {
      getMarketSets: async () => marketSets,
      getRegionDashboard: async () => {
        calls.push({ fn: 'market.getRegionDashboard' });
        return dashboard;
      },
      getMarketSetForTool: async (toolKey) => {
        calls.push({ fn: 'market.getMarketSetForTool', toolKey });
        // Real shape: { setId, marketSet }.
        return { setId: null, marketSet: null };
      },
      setMarketSetForTool: async (toolKey, id) => {
        calls.push({ fn: 'market.setMarketSetForTool', toolKey, id });
        return true;
      },
    },
    facilities: {
      getFacilities: async () => facilities,
    },
    esi: {
      getCharacters: async () => characters,
      getDefaultCharacter: async () => characters[0] || null,
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onMarketChanged: (cb) => subscribe('market:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
    },
    plans: {
      // Real signatures: getAll FILTERS on characterId, create takes THREE
      // POSITIONAL args. A permissive mock hides a wrong call.
      getAll: async (characterId) => {
        calls.push({ fn: 'plans.getAll', characterId });
        return plans;
      },
      create: async (characterId, planName, description) => {
        calls.push({ fn: 'plans.create', characterId, planName, description });
        return { planId: 'new-plan' };
      },
      addBlueprint: async (planId, config) => {
        calls.push({ fn: 'plans.addBlueprint', planId, config });
        return true;
      },
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/what-can-i-build-view-renderer.js');
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
  return [...container.querySelectorAll('#wcib-tbody tr')];
}

function headerLabels(container) {
  return [...container.querySelectorAll('#wcib-thead-row .wcib-th')]
    .map((th) => th.textContent.replace(/[↑↓↕]/g, '').trim())
    .filter(Boolean);
}

async function calculate(container) {
  container.querySelector('#wcib-calculate').click();
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';

  assetSources = [
    {
      characterId: 91316135,
      characterName: 'Buckwalter',
      portrait: 'https://images.evetech.net/characters/91316135/portrait',
      hasCorpAssets: true,
      corporationName: 'Brave Newbies',
      divisions: [
        { id: 1, name: 'Master Wallet', enabled: true },
        { id: 2, name: 'Hangar 2', enabled: false },
      ],
    },
    {
      characterId: 91316136,
      characterName: 'Alt',
      portrait: null,
      hasCorpAssets: false,
      divisions: [],
    },
  ];
  // Ids are opaque STRINGS, and the default is marked by usage, not isDefault.
  // A market set holds pricing CONFIG, not an item list; the region lives at
  // inputMaterials.regionId, never at the top level.
  marketSets = [
    {
      id: '1776014362091kqqn0afmh',
      name: 'UALX',
      isDefault: true,
      inputMaterials: { regionId: 10000061 },
    },
    {
      id: '1776014523802zao90sgpr',
      name: 'Jita 4-4',
      isDefault: false,
      inputMaterials: { regionId: 10000002 },
    },
  ];
  facilities = [
    { id: '1760590457981gr160dv11', name: 'Sotiyo', usage: 'default', structureTypeId: '35827' },
    { id: '1760590825122x7i6ex1qs', name: 'Azbel', usage: 'components', structureTypeId: '35826' },
  ];
  characters = [{ characterId: 91316135, characterName: 'Buckwalter' }];
  plans = [{ planId: 'plan-1', name: 'T2 Cruisers' }];
  wcibResult = { cancelled: false, rows: [row()], assetTypeCount: 12 };
  wcibError = null;
  wcibGate = null;
  wcibCancelled = false;
  refreshResult = { success: true, refreshed: [91316135], errors: [] };
  settings = {};
  calls = [];
  progressSubscribers = [];
  busSubscribers = {};
  // The market set's inputMaterials.regionId is what freshness resolves.
  dashboard = [{ regionId: 10000061, regionName: 'Aridia', lastFetch: Date.now() }];
  registered = null;

  // The real freshness module - this screen's badge is its contract.
  jest.isolateModules(() => {
    require('../../public/shared/freshness.js');
  });

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
  test('registers under the new view id', () => {
    // Renamed from `cleanup-tool` - the rail, TOOLS and setToolStat all key
    // off this, so a mismatch leaves the tool unreachable.
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('what-can-i-build');
    expect(registered.def.title).toBe('What Can I Build?');
  });

  test('offers the blueprint filters selectBlueprints implements', async () => {
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#wcib-bp-filters .wcib-chip')]
      .map((c) => c.textContent);
    expect(labels).toEqual(['All Blueprints', 'Owned BPs', 'Corp BPs']);
  });

  test('offers thirteen categories - NOT the Summary fourteen', async () => {
    // Reactions are not manufactured from blueprints, so this screen has
    // never offered that chip.
    const { container } = await mountView();

    const labels = [...container.querySelectorAll('#wcib-cat-chips .wcib-chip')]
      .map((c) => c.textContent);

    expect(labels).toHaveLength(13);
    expect(labels).not.toContain('Reactions');
    expect(labels).toContain('Ships');
  });

  test('the facility picker prefers usage:default, not isDefault', async () => {
    const { container } = await mountView();
    expect(container.querySelector('#wcib-facility').value)
      .toBe('1760590457981gr160dv11');
  });

  test('opaque string ids survive into the calculate payload', async () => {
    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'wcib.calculate').options;
    expect(sent.facilityId).toBe('1760590457981gr160dv11');
    expect(typeof sent.facilityId).toBe('string');
  });
});

/* ------------------------------------------------------------ asset tree */

describe('asset source tree', () => {
  test('lists every character, personal on by default', async () => {
    const { container } = await mountView();

    const names = [...container.querySelectorAll('.wcib-asset-char-head')]
      .map((h) => h.textContent.trim());
    expect(names).toEqual(['Buckwalter', 'Alt']);

    const rows = [...container.querySelectorAll('.wcib-asset-row')];
    const personal = rows.filter((r) => r.textContent.includes('Personal Assets'));
    expect(personal).toHaveLength(2);
    expect(personal.every((r) => r.querySelector('input').checked)).toBe(true);
  });

  test('a character without corp assets shows no corp row', async () => {
    const { container } = await mountView();

    const corpRows = [...container.querySelectorAll('.wcib-asset-row')]
      .filter((r) => r.textContent.includes('Corporation Assets'));
    // Only Buckwalter has them.
    expect(corpRows).toHaveLength(1);
    expect(corpRows[0].textContent).toContain('Brave Newbies');
  });

  test('divisions are visible WITHOUT expanding anything', async () => {
    // They default to open, as the mockup shows them - collapsed hides which
    // of the seven divisions are actually selected, which is the whole point
    // of the corp row.
    const { container } = await mountView();

    const divisionRows = [...container.querySelectorAll('.wcib-asset-divisions .wcib-asset-row')];
    expect(divisionRows).toHaveLength(2);
  });

  test('every division the character has is listed', async () => {
    // getAssetSources always returns all seven; showing fewer means a
    // division silently cannot be selected.
    assetSources = [{
      characterId: 91316135,
      characterName: 'Buckwalter',
      hasCorpAssets: true,
      corporationName: 'Brave Newbies',
      divisions: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1, name: `Division ${i + 1}`, enabled: i === 0,
      })),
    }];

    const { container } = await mountView();

    expect(container.querySelectorAll('.wcib-asset-divisions .wcib-asset-row'))
      .toHaveLength(7);
  });

  test('the corp row has NO checkbox - divisions are the only control', async () => {
    // Corp assets live in divisions, and isInEnabledDivision reads nothing
    // for an empty list, so a corp-level tick either duplicated the
    // divisions or looked enabled while contributing zero assets.
    const { container } = await mountView();

    const corpRow = [...container.querySelectorAll('.wcib-asset-row')]
      .find((r) => r.textContent.includes('Corporation Assets'));

    expect(corpRow.querySelector('input')).toBeNull();
  });

  test('toggling a division does NOT rebuild the row that was clicked', async () => {
    // Rule 2a: rebuilding the tree from a click handler destroys the element
    // the click landed on, which is how the columns modal and the combobox
    // both broke. Assert element IDENTITY, not just that the state changed.
    const { container } = await mountView();
    const divisions = () =>
      [...container.querySelectorAll('.wcib-asset-divisions .wcib-asset-row')];

    const before = divisions();
    before[1].click();
    await settle();

    expect(divisions()[1]).toBe(before[1]);
    expect(before[1].querySelector('input').checked).toBe(true);
  });

  test('a corp with no divisions ticked contributes nothing', async () => {
    const { container } = await mountView();

    // Untick the one enabled division.
    const divisions = [...container.querySelectorAll('.wcib-asset-divisions .wcib-asset-row')];
    divisions[0].click();
    await settle();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'wcib.calculate').options;
    expect(sent.assetSources.corporation).toEqual([]);
  });

  test('divisions seed from their own enabled flag', async () => {
    const { container } = await mountView();

    const divisionRows = [...container.querySelectorAll('.wcib-asset-divisions .wcib-asset-row')];
    // Master Wallet is enabled in Settings, Hangar 2 is not.
    expect(divisionRows[0].querySelector('input').checked).toBe(true);
    expect(divisionRows[1].querySelector('input').checked).toBe(false);
  });

  test('the corp row can still be collapsed', async () => {
    const { container } = await mountView();

    const corpRow = [...container.querySelectorAll('.wcib-asset-row')]
      .find((r) => r.textContent.includes('Corporation Assets'));
    corpRow.querySelector('.wcib-expand').click();
    await settle();

    expect(container.querySelectorAll('.wcib-asset-divisions .wcib-asset-row'))
      .toHaveLength(0);
  });

  test('collapses into the shape aggregateAssets expects', async () => {
    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'wcib.calculate').options;
    expect(sent.assetSources.personal).toEqual([
      { characterId: 91316135 },
      { characterId: 91316136 },
    ]);
    // Only the ENABLED division is included.
    expect(sent.assetSources.corporation).toEqual([
      { characterId: 91316135, divisions: [1] },
    ]);
  });

  test('Deselect All empties the payload', async () => {
    const { container } = await mountView();
    container.querySelector('#wcib-assets-none').click();
    await settle();

    // With nothing selected the run is refused rather than costing against
    // an empty hangar.
    container.querySelector('#wcib-calculate').click();
    await settle();

    expect(calls.some((c) => c.fn === 'wcib.calculate')).toBe(false);
    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/asset source/i), 'warning'
    );
  });

  test('Select All re-enables everything', async () => {
    const { container } = await mountView();
    container.querySelector('#wcib-assets-none').click();
    container.querySelector('#wcib-assets-all').click();
    await settle();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'wcib.calculate').options;
    expect(sent.assetSources.personal).toHaveLength(2);
    expect(sent.assetSources.corporation[0].divisions).toEqual([1, 2]);
  });

  test('the selection persists', async () => {
    const { container } = await mountView();

    const personal = [...container.querySelectorAll('.wcib-asset-row')]
      .find((r) => r.textContent.includes('Personal Assets'));
    personal.click();
    await settle();

    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.assetSources.personal)
      .not.toContainEqual({ characterId: 91316135 });
  });

  test('mounting NEVER writes an empty assetSources over a stored one', async () => {
    /*
     * The regression: loadSettings() ended with saveSettings(), which derives
     * assetSources from state.selection - still empty at that point, because
     * loadAssetSources() had not run. Every launch therefore clobbered the
     * stored selection with empties.
     *
     * It hid because the UI restored correctly (savedAssetSources was captured
     * first) and the next click re-saved the real value. Only a hard kill,
     * with no interaction in between, left the empty write as final state.
     */
    settings = {
      assetSources: {
        personal: [{ characterId: 91316135 }],
        corporation: [{ characterId: 91316135, divisions: [1] }],
      },
    };

    await mountView();

    // With nothing to migrate, mounting must not write AT ALL - the strongest
    // form of "cannot clobber the stored selection".
    expect(calls.filter((c) => c.fn === 'settings.update')).toHaveLength(0);
  });

  test('a migrating mount writes the RESTORED selection, not an empty one', async () => {
    // When a migration does occur the write happens after the selection has
    // been seeded, so it carries real values.
    localStorage.setItem('cleanup-tool-threshold', '45');
    settings = {
      assetSources: {
        personal: [{ characterId: 91316135 }],
        corporation: [{ characterId: 91316135, divisions: [1] }],
      },
    };

    await mountView();

    const writes = calls.filter((c) => c.fn === 'settings.update');
    expect(writes).toHaveLength(1);
    expect(writes[0].updates.assetSources.personal).toEqual([{ characterId: 91316135 }]);
    expect(writes[0].updates.assetSources.corporation).toEqual([
      { characterId: 91316135, divisions: [1] },
    ]);
  });

  test('the migration runs ONCE - a second mount writes nothing', async () => {
    // readLegacy() deletes the keys as it reads them, so the second mount
    // finds nothing to migrate and must skip the write entirely.
    localStorage.setItem('cleanup-tool-threshold', '45');

    await mountView();
    expect(calls.filter((c) => c.fn === 'settings.update')).toHaveLength(1);
    expect(localStorage.getItem('cleanup-tool-threshold')).toBeNull();

    calls.length = 0;
    await mountView();
    expect(calls.filter((c) => c.fn === 'settings.update')).toHaveLength(0);
  });

  test('a saved selection is restored', async () => {
    settings = {
      assetSources: {
        personal: [{ characterId: 91316136 }],
        corporation: [{ characterId: 91316135, divisions: [2] }],
      },
    };

    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'wcib.calculate').options;
    expect(sent.assetSources.personal).toEqual([{ characterId: 91316136 }]);
    expect(sent.assetSources.corporation).toEqual([
      { characterId: 91316135, divisions: [2] },
    ]);
  });
});

/* -------------------------------------------------------- refresh assets */

describe('refreshing assets', () => {
  test('per-character failures are surfaced, not swallowed', async () => {
    // refreshAssets reports them in errors[] and leaves success TRUE, so
    // checking success alone reports a failed refresh as a success.
    refreshResult = {
      success: true,
      refreshed: [],
      errors: [{ characterId: 91316135, error: 'Token expired' }],
    };

    const { container } = await mountView();
    container.querySelector('#wcib-assets-refresh').click();
    await settle();

    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/Token expired/), 'error'
    );
  });

  test('a partial failure says how many', async () => {
    refreshResult = {
      success: true,
      refreshed: [91316135],
      errors: [{ characterId: 91316136, error: 'nope' }],
    };

    const { container } = await mountView();
    container.querySelector('#wcib-assets-refresh').click();
    await settle();

    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/1 failed/), 'warning'
    );
  });

  test('a clean refresh reloads the tree', async () => {
    const { container } = await mountView();
    calls.length = 0;
    container.querySelector('#wcib-assets-refresh').click();
    await settle();

    expect(window.QFToast.show).toHaveBeenCalledWith('Assets refreshed', 'success');
    expect(calls.filter((c) => c.fn === 'cleanupTool.getAssetSources')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- freshness */

describe('market data freshness', () => {
  test('fresh data shows no warning', async () => {
    const { container } = await mountView();
    expect(container.querySelector('#wcib-market-warning').hidden).toBe(true);
  });

  test('stale data warns, naming the region', async () => {
    dashboard = [{
      regionId: 10000061,
      regionName: 'Aridia',
      lastFetch: Date.now() - (5 * 60 * 60 * 1000),
    }];

    const { container } = await mountView();

    const warning = container.querySelector('#wcib-market-warning');
    expect(warning.hidden).toBe(false);
    expect(warning.classList.contains('is-stale')).toBe(true);
    expect(container.querySelector('#wcib-market-warning-text').textContent)
      .toContain('Aridia');
  });

  test('a region with no data at all says so', async () => {
    dashboard = [{ regionId: 10000061, regionName: 'Aridia', lastFetch: null }];

    const { container } = await mountView();

    expect(container.querySelector('#wcib-market-warning-text').textContent)
      .toMatch(/No market data/);
  });

  test('the warning CLEARS on a market refresh - the dashboard is re-read', async () => {
    // A cached dashboard is why the un-ported Loot Analyzer's warning could
    // never clear after a refresh landed.
    dashboard = [{
      regionId: 10000061,
      regionName: 'Aridia',
      lastFetch: Date.now() - (5 * 60 * 60 * 1000),
    }];

    const { container } = await mountView();
    expect(container.querySelector('#wcib-market-warning').hidden).toBe(false);

    dashboard = [{ regionId: 10000061, regionName: 'Aridia', lastFetch: Date.now() }];
    busSubscribers['market:data-changed'].forEach((cb) => cb());
    await settle();

    expect(container.querySelector('#wcib-market-warning').hidden).toBe(true);
  });

  test('switching market set re-evaluates against the NEW region', async () => {
    dashboard = [
      { regionId: 10000061, regionName: 'Aridia', lastFetch: Date.now() },
      {
        regionId: 10000002,
        regionName: 'The Forge',
        lastFetch: Date.now() - (5 * 60 * 60 * 1000),
      },
    ];

    const { container } = await mountView();
    expect(container.querySelector('#wcib-market-warning').hidden).toBe(true);

    const select = container.querySelector('#wcib-market-set');
    select.value = '1776014523802zao90sgpr';   // points at The Forge
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#wcib-market-warning').hidden).toBe(false);
    expect(container.querySelector('#wcib-market-warning-text').textContent)
      .toContain('The Forge');
  });

  test('destroy releases the freshness subscription', async () => {
    const { instance } = await mountView();
    expect((busSubscribers['market:data-changed'] || []).length).toBeGreaterThan(0);

    instance.destroy();

    expect((busSubscribers['market:data-changed'] || []).length).toBe(0);
  });
});

/* -------------------------------------------------------------- threshold */

describe('on-hand threshold', () => {
  test('the slider and the number box stay in step', async () => {
    const { container } = await mountView();
    const range = container.querySelector('#wcib-threshold-range');
    const num = container.querySelector('#wcib-threshold');

    range.value = '50';
    range.dispatchEvent(new Event('input'));
    expect(num.value).toBe('50');

    num.value = '25';
    num.dispatchEvent(new Event('input'));
    expect(range.value).toBe('25');
  });

  test('it is clamped to 0-100', async () => {
    const { container } = await mountView();
    const num = container.querySelector('#wcib-threshold');

    num.value = '250';
    num.dispatchEvent(new Event('input'));
    expect(num.value).toBe('100');

    num.value = '-10';
    num.dispatchEvent(new Event('input'));
    expect(num.value).toBe('0');
  });

  test('it reaches the engine', async () => {
    const { container } = await mountView();
    const num = container.querySelector('#wcib-threshold');
    num.value = '60';
    num.dispatchEvent(new Event('input'));

    await calculate(container);

    expect(calls.find((c) => c.fn === 'wcib.calculate').options.threshold).toBe(60);
  });
});

/* -------------------------------------------------------------- calculate */

describe('calculating', () => {
  test('refuses to run without a facility', async () => {
    facilities = [];
    const { container } = await mountView();

    container.querySelector('#wcib-calculate').click();
    await settle();

    expect(calls.some((c) => c.fn === 'wcib.calculate')).toBe(false);
    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/facility/i), 'warning'
    );
  });

  test('sends every filter to the engine', async () => {
    const { container } = await mountView();
    await calculate(container);

    const sent = calls.find((c) => c.fn === 'wcib.calculate').options;
    expect(sent).toMatchObject({
      blueprintFilter: 'owned',
      characterFilter: 'all',
      threshold: 90,
    });
    expect(sent.techLevels).toEqual(
      expect.arrayContaining(['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'])
    );
    expect(sent.categories).toHaveLength(13);
  });

  test('the T2 invention toggle maps to speculativeInvention', async () => {
    const { container } = await mountView();
    container.querySelector('#wcib-include-t2').click();
    await calculate(container);

    expect(calls.find((c) => c.fn === 'wcib.calculate').options.speculativeInvention)
      .toBe(true);
  });

  test('the button becomes Cancel while a run is in flight', async () => {
    let release;
    wcibGate = new Promise((resolve) => { release = resolve; });

    const { container } = await mountView();
    const button = container.querySelector('#wcib-calculate');
    const label = container.querySelector('#wcib-calculate-label');

    button.click();
    await settle();

    expect(label.textContent).toBe('Cancel');
    expect(button.classList.contains('is-cancel')).toBe(true);
    // MUST stay clickable - a disabled button swallows the click.
    expect(button.disabled).toBe(false);

    release();
    await settle();
    expect(label.textContent).toBe('Calculate Buildable Items');
  });

  test('clicking Cancel mid-run asks main to stop', async () => {
    let release;
    wcibGate = new Promise((resolve) => { release = resolve; });

    const { container } = await mountView();
    const button = container.querySelector('#wcib-calculate');

    button.click();
    await settle();
    button.click();
    await settle();

    expect(calls.some((c) => c.fn === 'wcib.cancel')).toBe(true);

    release();
    await settle();

    // A cancellation is not a failure.
    expect(container.querySelector('#wcib-empty-title').textContent)
      .toBe('Calculation cancelled');
  });

  test('progress is subscribed and disposed per run', async () => {
    const { container } = await mountView();
    await calculate(container);
    await calculate(container);

    // Two runs, two subscriptions - and none left attached.
    expect(calls.filter((c) => c.fn === 'wcib.onProgress')).toHaveLength(2);
    expect(progressSubscribers).toHaveLength(0);
  });

  test('an empty result explains itself', async () => {
    wcibResult = { cancelled: false, rows: [], assetTypeCount: 5 };

    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#wcib-empty').hidden).toBe(false);
    expect(container.querySelector('#wcib-empty-title').textContent).toBe('Nothing buildable');
    expect(container.querySelector('#wcib-empty-text').textContent).toMatch(/90%/);
  });

  test('a failure toasts rather than leaving a dead spinner', async () => {
    expectedErrorPatterns = [/calculation failed/i];
    wcibError = 'SDE missing';

    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('#wcib-progress').hidden).toBe(true);
    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringMatching(/SDE missing/), 'error'
    );
  });
});

/* ---------------------------------------------------------- results table */

describe('results table', () => {
  test('renders the default columns', async () => {
    const { container } = await mountView();
    await calculate(container);

    const labels = headerLabels(container);
    expect(labels).toContain('% On-Hand');
    expect(labels).toContain('Buildable Qty');
    expect(labels).toContain('Item Name');
    // Off by default.
    expect(labels).not.toContain('Owner');
  });

  test('the on-hand percentage is banded by value', async () => {
    wcibResult = {
      cancelled: false,
      rows: [
        row({ blueprintTypeId: 1, percentOnHand: 100 }),
        row({ blueprintTypeId: 2, percentOnHand: 80 }),
        row({ blueprintTypeId: 3, percentOnHand: 60 }),
        row({ blueprintTypeId: 4, percentOnHand: 20 }),
      ],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);

    const classes = resultRows(container)
      .map((r) => r.querySelector('.wcib-percent').className);
    expect(classes[0]).toContain('is-full');
    expect(classes[1]).toContain('is-high');
    expect(classes[2]).toContain('is-partial');
    expect(classes[3]).toContain('is-low');
  });

  test('search filters the rows live', async () => {
    wcibResult = {
      cancelled: false,
      rows: [
        row({ blueprintTypeId: 1, itemName: 'Hulk' }),
        row({ blueprintTypeId: 2, itemName: 'Retriever' }),
      ],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);
    expect(resultRows(container)).toHaveLength(2);

    const search = container.querySelector('#wcib-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));

    expect(resultRows(container)).toHaveLength(1);
  });

  test('a search matching nothing CLEARS the table', async () => {
    const { container } = await mountView();
    await calculate(container);

    const search = container.querySelector('#wcib-search');
    search.value = 'nothing-matches';
    search.dispatchEvent(new Event('input'));

    expect(resultRows(container)).toHaveLength(0);
    expect(container.querySelector('#wcib-results').hidden).toBe(true);
  });

  test('Escape clears the search', async () => {
    const { container } = await mountView();
    await calculate(container);

    const search = container.querySelector('#wcib-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

    expect(search.value).toBe('');
    expect(resultRows(container)).toHaveLength(1);
  });

  test('the table opens sorted by profit, highest first', async () => {
    wcibResult = {
      cancelled: false,
      rows: [
        row({ blueprintTypeId: 1, itemName: 'Hulk', profit: 100 }),
        row({ blueprintTypeId: 2, itemName: 'Retriever', profit: 900 }),
      ],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);

    // No click yet - the default sort is already profit/desc.
    expect(resultRows(container)[0].textContent).toContain('Retriever');
  });

  test('clicking the active column toggles direction', async () => {
    wcibResult = {
      cancelled: false,
      rows: [
        row({ blueprintTypeId: 1, itemName: 'Hulk', profit: 100 }),
        row({ blueprintTypeId: 2, itemName: 'Retriever', profit: 900 }),
      ],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);

    const profitTh = [...container.querySelectorAll('.wcib-th')]
      .find((th) => th.textContent.includes('Profit'));

    // Profit is ALREADY the sort column, so the first click flips to asc.
    profitTh.click();
    expect(resultRows(container)[0].textContent).toContain('Hulk');

    profitTh.click();
    expect(resultRows(container)[0].textContent).toContain('Retriever');
  });

  test('sorting on a new column starts descending, and persists', async () => {
    wcibResult = {
      cancelled: false,
      rows: [
        row({ blueprintTypeId: 1, itemName: 'Hulk', buildableRuns: 2 }),
        row({ blueprintTypeId: 2, itemName: 'Retriever', buildableRuns: 40 }),
      ],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);

    const qtyTh = [...container.querySelectorAll('.wcib-th')]
      .find((th) => th.textContent.includes('Buildable Qty'));

    qtyTh.click();
    expect(resultRows(container)[0].textContent).toContain('Retriever');

    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.sort).toEqual({ column: 'buildable-qty', direction: 'desc' });
  });

  test('a saved sort is restored', async () => {
    settings = { sort: { column: 'roi', direction: 'asc' } };
    wcibResult = {
      cancelled: false,
      rows: [
        row({ blueprintTypeId: 1, itemName: 'Hulk', roi: 90 }),
        row({ blueprintTypeId: 2, itemName: 'Retriever', roi: 10 }),
      ],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);

    expect(resultRows(container)[0].textContent).toContain('Retriever');
  });

  test('name and category truncate with a full-text tooltip', async () => {
    wcibResult = {
      cancelled: false,
      rows: [row({ itemName: 'Republic Fleet Nova Heavy Missile', category: 'Ammunition' })],
      assetTypeCount: 1,
    };

    const { container } = await mountView();
    await calculate(container);

    expect(container.querySelector('.wcib-item-name').title)
      .toBe('Republic Fleet Nova Heavy Missile');
    expect(container.querySelector('.wcib-category').title).toBe('Ammunition');
  });
});

/* ------------------------------------------------------------ add to plan */

describe('add to plan', () => {
  async function selectFirstRow(container) {
    await calculate(container);
    resultRows(container)[0].querySelector('td').click();
    await settle();
  }

  test('the button appears only with a selection', async () => {
    const { container } = await mountView();
    await calculate(container);
    expect(container.querySelector('#wcib-add-to-plan').hidden).toBe(true);

    await selectFirstRow(container);
    expect(container.querySelector('#wcib-add-to-plan').hidden).toBe(false);
    expect(container.querySelector('#wcib-add-to-plan-label').textContent)
      .toBe('Add to Plan (1)');
  });

  test('plans are fetched FOR a character', async () => {
    // getAll(characterId) filters on it; calling with nothing returns an
    // empty list and the dropdown reads as "no plans exist".
    const { container } = await mountView();
    await selectFirstRow(container);
    container.querySelector('#wcib-add-to-plan').click();
    await settle();

    expect(calls.find((c) => c.fn === 'plans.getAll').characterId).toBe(91316135);
  });

  test('creating a plan uses POSITIONAL args', async () => {
    const { container } = await mountView();
    await selectFirstRow(container);
    container.querySelector('#wcib-add-to-plan').click();
    await settle();

    container.querySelector('#wcib-plan-select').value = '__new__';
    container.querySelector('#wcib-plan-name').value = 'Salvage Run';
    container.querySelector('#wcib-plan-confirm').click();
    await settle();

    const created = calls.find((c) => c.fn === 'plans.create');
    expect(created.characterId).toBe(91316135);
    expect(created.planName).toBe('Salvage Run');
  });

  test('the blueprint payload matches the handler destructure', async () => {
    const { container } = await mountView();
    await selectFirstRow(container);
    container.querySelector('#wcib-add-to-plan').click();
    await settle();

    container.querySelector('#wcib-plan-select').value = 'plan-1';
    container.querySelector('#wcib-plan-runs').value = '5';
    container.querySelector('#wcib-plan-confirm').click();
    await settle();

    const added = calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(added.planId).toBe('plan-1');
    expect(added.config).toMatchObject({
      blueprintTypeId: 22545,
      runs: 5,
      meLevel: 10,
      teLevel: 20,
    });
    // Keys the handler does NOT read.
    expect(added.config.materialEfficiency).toBeUndefined();
    expect(added.config.productionLines).toBeUndefined();
  });

  test('the new-plan name box shows only for a new plan', async () => {
    const { container } = await mountView();
    await selectFirstRow(container);
    container.querySelector('#wcib-add-to-plan').click();
    await settle();

    const wrap = container.querySelector('#wcib-plan-new-wrap');
    const select = container.querySelector('#wcib-plan-select');

    select.value = 'plan-1';
    select.dispatchEvent(new Event('change'));
    expect(wrap.hidden).toBe(true);

    select.value = '__new__';
    select.dispatchEvent(new Event('change'));
    expect(wrap.hidden).toBe(false);
  });
});

/* ------------------------------------------------------------ persistence */

describe('persistence', () => {
  test('an upgrading user keeps their localStorage setup', async () => {
    // The nine keys are a MIX of JSON and bare strings.
    localStorage.setItem('cleanup-tool-blueprint-filter', 'corp');
    localStorage.setItem('cleanup-tool-character-filter', 'default');
    localStorage.setItem('cleanup-tool-threshold', '45');
    localStorage.setItem('cleanup-tool-include-t2-invention', 'true');
    localStorage.setItem('cleanup-tool-filters', JSON.stringify({
      tech: ['T2'], category: ['Ships'],
    }));
    localStorage.setItem('cleanup-tool-columns', JSON.stringify(['name', 'profit']));

    const { container } = await mountView();

    expect(container.querySelector('#wcib-threshold').value).toBe('45');
    expect(container.querySelector('#wcib-include-t2').checked).toBe(true);

    const on = (sel) => [...container.querySelectorAll(sel)]
      .filter((c) => c.classList.contains('is-on')).map((c) => c.textContent);
    expect(on('#wcib-bp-filters .wcib-chip')).toEqual(['Corp BPs']);
    expect(on('#wcib-tech-chips .wcib-chip')).toEqual(['T2']);

    // ...and the legacy keys are cleared so it cannot run twice.
    expect(localStorage.getItem('cleanup-tool-threshold')).toBeNull();
    expect(localStorage.getItem('cleanup-tool-filters')).toBeNull();
  });

  test('a stored config beats a stale localStorage value', async () => {
    settings = { blueprintFilter: 'all', threshold: 10 };
    localStorage.setItem('cleanup-tool-blueprint-filter', 'corp');
    localStorage.setItem('cleanup-tool-threshold', '99');

    const { container } = await mountView();

    expect(container.querySelector('#wcib-threshold').value).toBe('10');
    const on = [...container.querySelectorAll('#wcib-bp-filters .wcib-chip')]
      .filter((c) => c.classList.contains('is-on')).map((c) => c.textContent);
    expect(on).toEqual(['All Blueprints']);
  });

  test('the string "true" from localStorage becomes a real boolean', async () => {
    // The un-ported screen stored this as a STRING, so a truthiness check
    // would also accept 'false'.
    localStorage.setItem('cleanup-tool-include-t2-invention', 'false');

    const { container } = await mountView();
    expect(container.querySelector('#wcib-include-t2').checked).toBe(false);
  });

  test('an opaque facility id is not mangled into a number', async () => {
    // JSON.parse would turn an all-digit id into a Number and lose precision
    // past 2^53; these ids must stay strings.
    localStorage.setItem('cleanup-tool-facility', '1760590825122x7i6ex1qs');

    const { container } = await mountView();
    expect(container.querySelector('#wcib-facility').value)
      .toBe('1760590825122x7i6ex1qs');
  });

  test('an explicitly empty chip selection is honoured', async () => {
    settings = { blueprintChips: { tech: [], category: [] } };

    const { container } = await mountView();

    expect(container.querySelectorAll('#wcib-tech-chips .wcib-chip.is-on')).toHaveLength(0);
    expect(container.querySelectorAll('#wcib-cat-chips .wcib-chip.is-on')).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- columns */

describe('columns', () => {
  function openColumns(container) {
    container.querySelector('#wcib-columns-btn').click();
  }

  function columnRow(container, label) {
    return [...container.querySelectorAll('.wcib-column-row')]
      .find((r) => r.querySelector('.wcib-column-label').textContent === label);
  }

  test('ticking a column updates the table immediately', async () => {
    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)).not.toContain('Owner');

    openColumns(container);
    const box = columnRow(container, 'Owner').querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));

    // No Apply click.
    expect(headerLabels(container)).toContain('Owner');
  });

  test('ticking does NOT rebuild the list', async () => {
    // Rebuilding resets scrollTop, throwing the user to the top on every
    // click. Element identity is the observable proxy in jsdom.
    const { container } = await mountView();
    await calculate(container);
    openColumns(container);

    const before = [...container.querySelectorAll('.wcib-column-row')];
    const box = columnRow(container, 'Owner').querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));

    const after = [...container.querySelectorAll('.wcib-column-row')];
    expect(after[0]).toBe(before[0]);
  });

  test('Reset restores the default ORDER, not just the set', async () => {
    settings = { columnOrder: ['profit', 'name', 'percent-on-hand'] };

    const { container } = await mountView();
    await calculate(container);
    expect(headerLabels(container)[0]).toBe('Profit');

    openColumns(container);
    container.querySelector('#wcib-columns-reset').click();

    expect(headerLabels(container)[0]).toBe('% On-Hand');
    const saved = calls.filter((c) => c.fn === 'settings.update').pop();
    expect(saved.updates.columnOrder).toBeNull();
  });

  test('a saved order missing a NEW column still includes it', async () => {
    settings = { columnOrder: ['profit', 'name'] };

    const { container } = await mountView();
    await calculate(container);
    openColumns(container);

    const labels = [...container.querySelectorAll('.wcib-column-label')]
      .map((l) => l.textContent);
    expect(labels[0]).toBe('Profit');
    expect(labels).toContain('% On-Hand');
    expect(labels).toHaveLength(17);
  });
});

/* --------------------------------------------------------- CSS contracts */

describe('CSS contracts (jsdom applies no stylesheets - assert on the text)', () => {
  test('binding rule 6a: hidden beats any explicit display', () => {
    expect(VIEW_CSS).toMatch(/#wcib-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  test('binding rule 1: chip highlights use box-shadow, not a background', () => {
    const base = VIEW_CSS.match(/^\.wcib-chip \{[^}]*\}/m)[0];
    const on = VIEW_CSS.match(/^\.wcib-chip\.is-on \{[^}]*\}/m)[0];

    expect(base).toContain('background-color: transparent');
    expect(on).toContain('box-shadow');
    expect(on).not.toMatch(/background-color:\s*var/);
  });

  test('the table scrolls horizontally ONLY', () => {
    const rule = VIEW_CSS.match(/\.wcib-table-scroll \{[^}]*\}/)[0];
    expect(rule).toContain('overflow-x: auto');
    expect(rule).not.toMatch(/overflow-y|max-height/);
  });

  test('all four on-hand bands are distinct', () => {
    const bands = ['is-full', 'is-high', 'is-partial', 'is-low'].map((cls) => {
      const rule = VIEW_CSS.match(new RegExp(`\\.wcib-percent\\.${cls}\\s*\\{[^}]*\\}`));
      expect(rule).not.toBeNull();
      return rule[0].match(/color:\s*([^;]+);/)[1];
    });
    expect(new Set(bands).size).toBe(4);
  });
});
