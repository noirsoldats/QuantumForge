/**
 * @jest-environment jsdom
 *
 * Blueprint Manager shell view.
 *
 * Two behaviours carry the most risk and get the most weight here:
 *
 *   GROUPING - identical blueprints collapse into one card, keyed on typeId +
 *   BPO/BPC + runs + EFFECTIVE ME/TE. The effective values matter: two copies
 *   that differ only by an override must NOT group, or the card's single ME/TE
 *   editor would misrepresent one of them.
 *
 *   FAN-OUT - overrides are stored per blueprint (per itemId) but the editor
 *   sits on the group, so one edit must write to every copy in it. Setting a
 *   value back to the blueprint's real value CLEARS the override rather than
 *   storing a redundant one.
 *
 * Fixtures use REAL shapes:
 *   - blueprints.getAll -> [{ itemId (TEXT), typeId, isCopy, runs,
 *     materialEfficiency, timeEfficiency, overrides: {}, manuallyAdded,
 *     isCorporation, locationFlag, source }]
 *   - sde.getBlueprintNames -> { [typeId]: name }
 *   - sde.searchBlueprints  -> [{ typeID, typeName, groupName }]  (typeID caps)
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/blueprints.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/blueprints-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let character;
let blueprints;
let blueprintNames;
let locations;
let searchResults;
let cacheStatus;
let setOverrideResult;
let removeResult;
let addManualResult;
let fetchResult;
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

/** One blueprint row, in the shape getBlueprints() returns. */
function bp(fields = {}) {
  return {
    typeId: 22545,
    characterId: 91316135,
    corporationId: null,
    locationId: 60003760,
    locationFlag: 'Hangar',
    quantity: 1,
    materialEfficiency: 10,
    timeEfficiency: 20,
    runs: -1,
    isCopy: false,
    isCorporation: false,
    source: 'esi',
    manuallyAdded: false,
    overrides: {},
    ...fields,
    // Applied LAST and always stringified: item_id is TEXT in the database, and
    // a numeric fixture here would let an id-comparison bug pass unnoticed.
    itemId: String(fields.itemId || '1001'),
  };
}

function makeApi() {
  return {
    esi: {
      getCharacter: async (id) => {
        calls.push({ fn: 'esi.getCharacter', id });
        return character;
      },
      getDefaultCharacter: async () => character,
    },
    blueprints: {
      getAll: async (id) => {
        calls.push({ fn: 'blueprints.getAll', id });
        return blueprints;
      },
      fetch: async (id) => {
        calls.push({ fn: 'blueprints.fetch', id });
        return fetchResult;
      },
      setOverride: async (characterId, itemId, field, value) => {
        calls.push({ fn: 'blueprints.setOverride', characterId, itemId, field, value });
        return setOverrideResult;
      },
      remove: async (characterId, itemId) => {
        calls.push({ fn: 'blueprints.remove', characterId, itemId });
        return removeResult;
      },
      addManual: async (data) => {
        calls.push({ fn: 'blueprints.addManual', data });
        return addManualResult;
      },
      getCacheStatus: async (id) => {
        calls.push({ fn: 'blueprints.getCacheStatus', id });
        return cacheStatus;
      },
      openInCalculator: async (typeId, me) => {
        calls.push({ fn: 'blueprints.openInCalculator', typeId, me });
        return true;
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
    sde: {
      getBlueprintNames: async (ids) => {
        calls.push({ fn: 'sde.getBlueprintNames', count: ids.length });
        return blueprintNames;
      },
      searchBlueprints: async (term) => {
        calls.push({ fn: 'sde.searchBlueprints', term });
        return searchResults;
      },
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/blueprints-view-renderer.js');
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

function groupCards(container) {
  return [...container.querySelectorAll('.bp-group')];
}

function cardFor(container, name) {
  return groupCards(container).find(
    (g) => g.querySelector('.bp-group-name').textContent === name
  );
}

function meInput(card) {
  return card.querySelectorAll('.bp-eff-input')[0];
}

function teInput(card) {
  return card.querySelectorAll('.bp-eff-input')[1];
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

  character = {
    characterId: 91316135,
    characterName: 'Buckwalter',
    portrait: 'https://images.evetech.net/characters/91316135/portrait',
  };

  blueprints = [
    bp({ itemId: '1001', typeId: 22545 }),
    bp({ itemId: '1002', typeId: 17716, isCopy: true, runs: 3, materialEfficiency: 2, timeEfficiency: 4 }),
  ];

  blueprintNames = {
    22545: 'Hulk Blueprint',
    17716: 'Gila Blueprint',
    16241: 'Ferox Blueprint',
  };

  searchResults = [
    { typeID: 638, typeName: 'Raven Blueprint', groupName: 'Ship Blueprint' },
    { typeID: 11279, typeName: 'Cerberus Blueprint', groupName: 'Ship Blueprint' },
  ];

  locations = {
    60003760: {
      fullPath: 'Jita IV-4 - CNAP', systemName: 'Jita', stationName: 'Jita IV-4 - CNAP',
      containerNames: [], containerPath: [], locationType: 'npc-station',
    },
  };

  cacheStatus = { isCached: false, expiresAt: null, remainingSeconds: 0 };
  setOverrideResult = true;
  removeResult = true;
  addManualResult = true;
  fetchResult = { success: true };

  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: (id, params) => calls.push({ fn: 'router.show', id, params }),
    },
  };
  window.electronAPI = makeApi();
  // The REAL QFToast API: a single show(message, type). No per-type methods.
  window.QFToast = {
    show: (m, type = 'info') => calls.push({ fn: `toast.${type}`, m }),
    setDefaultPosition: () => {},
    dismissAll: () => {},
  };
  window.QFCacheCountdown = {
    attach: () => () => {},
    formatRemaining: () => '',
    setLabel: () => {},
  };

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
  test('registers itself as the "blueprints" view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('blueprints');
    expect(typeof registered.def.mount).toBe('function');
  });
});

describe('loading', () => {
  test('resolves every name in ONE batched call', async () => {
    await mountView({ characterId: 91316135 });

    const lookups = calls.filter((c) => c.fn === 'sde.getBlueprintNames');
    expect(lookups).toHaveLength(1);
    // Deduped by type: two blueprints, two distinct types.
    expect(lookups[0].count).toBe(2);
  });

  test('renders a card per blueprint with its badge and runs', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const hulk = cardFor(container, 'Hulk Blueprint');
    expect(hulk.textContent).toContain('BPO');
    // A BPO has unlimited runs; ESI reports that as -1.
    expect(hulk.textContent).toContain('Infinite');

    const gila = cardFor(container, 'Gila Blueprint');
    expect(gila.textContent).toContain('BPC');
    expect(gila.textContent).toContain('3');
  });

  test('a blueprint missing from the SDE still renders', async () => {
    blueprintNames = {};
    const { container } = await mountView({ characterId: 91316135 });

    expect(groupCards(container)).toHaveLength(2);
    expect(container.textContent).toContain('Blueprint 22545');
  });

  test('no blueprints shows the "not loaded" empty state', async () => {
    blueprints = [];
    const { container } = await mountView({ characterId: 91316135 });

    expect(container.querySelector('#bp-empty').hidden).toBe(false);
    expect(container.querySelector('#bp-empty-title').textContent).toBe('No blueprints loaded');
  });
});

describe('grouping identical blueprints', () => {
  test('identical copies collapse into one card showing the quantity', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 2047, isCopy: true, runs: 10, materialEfficiency: 2, timeEfficiency: 4 }),
      bp({ itemId: '2', typeId: 2047, isCopy: true, runs: 10, materialEfficiency: 2, timeEfficiency: 4 }),
      bp({ itemId: '3', typeId: 2047, isCopy: true, runs: 10, materialEfficiency: 2, timeEfficiency: 4 }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });

    expect(groupCards(container)).toHaveLength(1);
    expect(groupCards(container)[0].textContent).toContain('Qty: 3');
  });

  test('different runs do NOT group', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 2047, isCopy: true, runs: 10 }),
      bp({ itemId: '2', typeId: 2047, isCopy: true, runs: 5 }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });
    expect(groupCards(container)).toHaveLength(2);
  });

  test('grouping uses EFFECTIVE ME, so an override splits the group', async () => {
    // Two otherwise-identical copies where one is overridden. If they grouped,
    // the card's single ME editor would misrepresent one of them.
    blueprints = [
      bp({ itemId: '1', typeId: 2047, materialEfficiency: 5 }),
      bp({ itemId: '2', typeId: 2047, materialEfficiency: 5, overrides: { materialEfficiency: 9 } }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });

    const cards = groupCards(container);
    expect(cards).toHaveLength(2);
    const values = cards.map((c) => meInput(c).value).sort();
    expect(values).toEqual(['5', '9']);
  });

  test('expanding a group lists its individual copies', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 2047 }),
      bp({ itemId: '2', typeId: 2047 }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });
    expect(container.querySelectorAll('.bp-copy')).toHaveLength(0);

    const expand = groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1];
    expand.click();

    const copies = [...container.querySelectorAll('.bp-copy')];
    expect(copies).toHaveLength(2);
    // A copy row shows its RESOLVED location - the raw item id it used to lead
    // with ("#1050504970154 · Cargo") told the user nothing.
    expect(copies[0].textContent).toContain('Jita IV-4 - CNAP');
    // Each copy still gets its own remove button, which is why a single-copy
    // group is expandable at all.
    expect(container.querySelectorAll('.bp-copy-delete')).toHaveLength(2);
  });
});

describe('copy locations', () => {
  // THE BUG: copy rows showed "#1050504970154 · Cargo" - a raw item id and a
  // bare flag, neither of which says where the blueprint actually is.
  test('resolves locations in ONE batched call per ownership scope', async () => {
    await mountView({ characterId: 91316135 });

    const many = calls.filter((c) => c.fn === 'location.resolveMany');
    const single = calls.filter((c) => c.fn === 'location.resolve');

    // Personal scope only here - no corp blueprints in the default fixture.
    expect(many).toHaveLength(1);
    expect(single).toHaveLength(0);
  });

  test('a copy row shows the RESOLVED place, not a raw id', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1].click();

    const copy = container.querySelector('.bp-copy');
    expect(copy.textContent).toContain('Jita IV-4 - CNAP');
    expect(copy.textContent).not.toContain('#1001');
  });

  test('a nested blueprint gets the full chain in its tooltip', async () => {
    locations = {
      60003760: {
        fullPath: 'Sotiyo', systemName: 'Perimeter', stationName: 'Sotiyo',
        containerNames: ['Golem'],
        containerPath: [{ itemId: 999, typeId: 28710, locationFlag: 'Hangar' }],
        locationType: 'structure',
      },
    };
    blueprints = [bp({ itemId: '1001', locationFlag: 'Cargo' })];

    const { container } = await mountView({ characterId: 91316135 });
    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1].click();

    const location = container.querySelector('.bp-copy-location');
    expect(location.title).toBe('Cargo \u2192 Golem \u2192 Sotiyo');
    expect(location.classList.contains('bp-has-chain')).toBe(true);
  });

  test('a top-level blueprint gets no chain marker', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1].click();

    expect(container.querySelector('.bp-has-chain')).toBeNull();
  });

  test('corp blueprints resolve against the CORPORATION asset scope', async () => {
    // They live in a different asset tree than personal ones.
    blueprints = [
      bp({ itemId: '1', typeId: 22545 }),
      bp({ itemId: '2', typeId: 16241, isCorporation: true }),
    ];

    await mountView({ characterId: 91316135 });

    const scopes = calls.filter((c) => c.fn === 'location.resolveMany')
      .map((c) => c.isCorporation).sort();
    expect(scopes).toEqual([false, true]);
  });

  test('an unresolvable location degrades to a label, not a blank', async () => {
    locations = {};

    const { container } = await mountView({ characterId: 91316135 });
    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1].click();

    expect(container.querySelector('.bp-copy-location').textContent).toBe('Unknown location');
  });
});

describe('clearing the search', () => {
  test('the clear button appears only once there is text', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    expect(container.querySelector('#bp-search-clear').hidden).toBe(true);

    const search = container.querySelector('#bp-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));

    expect(container.querySelector('#bp-search-clear').hidden).toBe(false);
  });

  test('clicking it clears the query and restores every card', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const all = groupCards(container).length;

    const search = container.querySelector('#bp-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));
    expect(groupCards(container).length).toBeLessThan(all);

    container.querySelector('#bp-search-clear').click();

    expect(search.value).toBe('');
    expect(groupCards(container)).toHaveLength(all);
    expect(container.querySelector('#bp-search-clear').hidden).toBe(true);
  });

  test('Escape in the search box clears it', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const all = groupCards(container).length;

    const search = container.querySelector('#bp-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(search.value).toBe('');
    expect(groupCards(container)).toHaveLength(all);
  });

  test('Escape with an empty box does not swallow the modal close', async () => {
    // The search handler must only act when there is something to clear, or it
    // would stop Escape from closing an open modal.
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#bp-add-btn').click();
    expect(container.querySelector('#bp-add-modal').hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(container.querySelector('#bp-add-modal').hidden).toBe(true);
  });
});

describe('ME/TE overrides', () => {
  test('editing ME writes an override for that blueprint', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const input = meInput(cardFor(container, 'Hulk Blueprint'));
    input.value = '7';
    input.dispatchEvent(new Event('change'));
    await settle();

    const call = calls.find((c) => c.fn === 'blueprints.setOverride');
    expect(call).toMatchObject({ itemId: '1001', field: 'materialEfficiency', value: 7 });
  });

  test('setting ME back to the real value CLEARS the override', async () => {
    // The only way back to "no override" from the UI.
    blueprints = [bp({ itemId: '1001', materialEfficiency: 10, overrides: { materialEfficiency: 4 } })];

    const { container } = await mountView({ characterId: 91316135 });

    const input = meInput(groupCards(container)[0]);
    input.value = '10';
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(calls.find((c) => c.fn === 'blueprints.setOverride').value).toBeNull();
  });

  test('an edit FANS OUT to every copy in the group', async () => {
    // Overrides are per itemId but the editor is on the group; without the
    // fan-out the group would immediately split and the number would apply to
    // only one copy.
    blueprints = [
      bp({ itemId: '1', typeId: 2047 }),
      bp({ itemId: '2', typeId: 2047 }),
      bp({ itemId: '3', typeId: 2047 }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });

    const input = meInput(groupCards(container)[0]);
    input.value = '8';
    input.dispatchEvent(new Event('change'));
    await settle();

    const writes = calls.filter((c) => c.fn === 'blueprints.setOverride');
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => w.itemId).sort()).toEqual(['1', '2', '3']);
  });

  test('ME is clamped to 0-10 and TE to 0-20', async () => {
    // The blueprint's REAL values are below the caps here on purpose. With a
    // blueprint already at ME 10 / TE 20, clamping 99 lands exactly on the real
    // value and the override is cleared to null - correct behaviour, but it
    // would hide whether the clamp ran at all.
    blueprints = [bp({ itemId: '1001', materialEfficiency: 0, timeEfficiency: 0 })];

    const { container } = await mountView({ characterId: 91316135 });
    const card = groupCards(container)[0];

    const me = meInput(card);
    me.value = '99';
    me.dispatchEvent(new Event('change'));
    await settle();
    expect(calls.find((c) => c.field === 'materialEfficiency').value).toBe(10);

    calls.length = 0;
    const te = teInput(card);
    te.value = '99';
    te.dispatchEvent(new Event('change'));
    await settle();
    expect(calls.find((c) => c.field === 'timeEfficiency').value).toBe(20);
  });

  test('a negative value clamps to 0', async () => {
    blueprints = [bp({ itemId: '1001', materialEfficiency: 5 })];

    const { container } = await mountView({ characterId: 91316135 });

    const me = meInput(groupCards(container)[0]);
    me.value = '-3';
    me.dispatchEvent(new Event('change'));
    await settle();

    expect(calls.find((c) => c.field === 'materialEfficiency').value).toBe(0);
  });

  test('clamping ONTO the real value still clears the override', async () => {
    // The interaction the previous version of the clamp test tripped over:
    // a blueprint already at the cap, where clamping produces the real value.
    blueprints = [bp({
      itemId: '1001', materialEfficiency: 10, overrides: { materialEfficiency: 3 },
    })];

    const { container } = await mountView({ characterId: 91316135 });

    const me = meInput(groupCards(container)[0]);
    me.value = '99';
    me.dispatchEvent(new Event('change'));
    await settle();

    expect(calls.find((c) => c.field === 'materialEfficiency').value).toBeNull();
  });

  test('an overridden card is marked and offers Reset', async () => {
    blueprints = [bp({ itemId: '1001', overrides: { materialEfficiency: 4 } })];

    const { container } = await mountView({ characterId: 91316135 });
    const card = groupCards(container)[0];

    expect(card.classList.contains('is-overridden')).toBe(true);
    expect(card.textContent).toContain('Overridden');
    expect(meInput(card).classList.contains('is-override')).toBe(true);
    expect(card.querySelector('.bp-eff-reset')).not.toBeNull();
  });

  test('a card with no override offers no Reset', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    expect(cardFor(container, 'Hulk Blueprint').querySelector('.bp-eff-reset')).toBeNull();
  });

  test('Reset removes the override on every copy', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 2047, overrides: { materialEfficiency: 4 } }),
      bp({ itemId: '2', typeId: 2047, overrides: { materialEfficiency: 4 } }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });
    groupCards(container)[0].querySelector('.bp-eff-reset').click();
    await settle();

    const writes = calls.filter((c) => c.fn === 'blueprints.setOverride');
    expect(writes).toHaveLength(2);
    expect(writes.every((w) => w.value === null)).toBe(true);
  });

  test('an override of 0 is honoured, not treated as absent', async () => {
    // 0 is falsy; a truthiness check would silently drop the override.
    blueprints = [bp({ itemId: '1001', materialEfficiency: 10, overrides: { materialEfficiency: 0 } })];

    const { container } = await mountView({ characterId: 91316135 });
    const card = groupCards(container)[0];

    expect(meInput(card).value).toBe('0');
    expect(card.textContent).toContain('Overridden');
  });
});

describe('filtering', () => {
  test('search matches on blueprint name', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const search = container.querySelector('#bp-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));

    expect(groupCards(container)).toHaveLength(1);
    expect(groupCards(container)[0].textContent).toContain('Hulk');
  });

  test('search also matches on type ID', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const search = container.querySelector('#bp-search');
    search.value = '17716';
    search.dispatchEvent(new Event('input'));

    expect(groupCards(container)).toHaveLength(1);
    expect(groupCards(container)[0].textContent).toContain('Gila');
  });

  test('unchecking Originals hides the BPOs', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#bp-type-filters .bp-facet')]
      .find((f) => f.textContent.includes('Originals')).click();

    expect(groupCards(container)).toHaveLength(1);
    expect(groupCards(container)[0].textContent).toContain('BPC');
  });

  test('the Overridden filter is exclusive', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 22545 }),
      bp({ itemId: '2', typeId: 17716, overrides: { materialEfficiency: 4 } }),
    ];

    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#bp-type-filters .bp-facet')]
      .find((f) => f.textContent.includes('Overridden')).click();

    expect(groupCards(container)).toHaveLength(1);
    expect(groupCards(container)[0].textContent).toContain('Gila');
  });

  test('corp blueprints are hidden by default and shown by the corp filter', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 22545 }),
      bp({ itemId: '2', typeId: 16241, isCorporation: true }),
    ];

    const { container } = await mountView({ characterId: 91316135 });
    expect(groupCards(container)).toHaveLength(1);

    [...container.querySelectorAll('#bp-own-filters .bp-facet')]
      .find((f) => f.textContent.includes('Corporation')).click();

    expect(groupCards(container)).toHaveLength(1);
    expect(groupCards(container)[0].textContent).toContain('Ferox');
  });

  test('corp ownership is inferred from a CorpSAG location flag', async () => {
    // ESI does not always set isCorporation, so the flag is the fallback.
    blueprints = [
      bp({ itemId: '1', typeId: 16241, isCorporation: false, locationFlag: 'CorpSAG2' }),
    ];

    const { container } = await mountView({ characterId: 91316135 });
    // Character filter is on by default, so a corp blueprint must be hidden.
    expect(groupCards(container)).toHaveLength(0);

    [...container.querySelectorAll('#bp-own-filters .bp-facet')]
      .find((f) => f.textContent.includes('Corporation')).click();

    expect(groupCards(container)).toHaveLength(1);
  });

  test('Character and Corporation are mutually exclusive', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const owners = () => [...container.querySelectorAll('#bp-own-filters .bp-facet')];
    owners().find((f) => f.textContent.includes('Corporation')).click();

    const after = owners();
    expect(after.find((f) => f.textContent.includes('Corporation')).classList.contains('is-on')).toBe(true);
    expect(after.find((f) => f.textContent.includes('Character')).classList.contains('is-on')).toBe(false);
  });

  test('ownership is applied BEFORE the status filters', async () => {
    // A corp blueprint with an override must stay hidden while the character
    // filter is on, even with Overridden selected.
    blueprints = [
      bp({ itemId: '1', typeId: 16241, isCorporation: true, overrides: { materialEfficiency: 4 } }),
    ];

    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#bp-type-filters .bp-facet')]
      .find((f) => f.textContent.includes('Overridden')).click();

    expect(groupCards(container)).toHaveLength(0);
  });
});

describe('summary strip', () => {
  test('counts totals, originals, copies and overrides', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 22545 }),
      bp({ itemId: '2', typeId: 17716, isCopy: true }),
      bp({ itemId: '3', typeId: 16241, overrides: { timeEfficiency: 8 } }),
    ];

    const { container } = await mountView({ characterId: 91316135 });

    const values = [...container.querySelectorAll('.bp-stat')].map((s) => ({
      label: s.querySelector('.bp-stat-label').textContent,
      value: s.querySelector('.bp-stat-value').textContent,
    }));

    expect(values).toEqual([
      { label: 'Total Blueprints', value: '3' },
      { label: 'Originals', value: '2' },
      { label: 'Copies', value: '1' },
      { label: 'Overrides', value: '1' },
    ]);
  });
});

describe('adding a blueprint manually', () => {
  test('the modal only searches from 2 characters', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#bp-add-btn').click();
    expect(container.querySelector('#bp-add-modal').hidden).toBe(false);

    const search = container.querySelector('#bp-add-search');
    search.value = 'r';
    search.dispatchEvent(new Event('input'));
    await settle();

    expect(calls.some((c) => c.fn === 'sde.searchBlueprints')).toBe(false);
    expect(container.querySelector('#bp-add-results').textContent).toContain('at least 2');
  });

  test('adding one sends the manual payload and reloads', async () => {
    jest.useFakeTimers();
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#bp-add-btn').click();
    const search = container.querySelector('#bp-add-search');
    search.value = 'raven';
    search.dispatchEvent(new Event('input'));

    jest.advanceTimersByTime(250);
    jest.useRealTimers();
    await settle();

    container.querySelector('.bp-add-result').click();
    await settle();

    const added = calls.find((c) => c.fn === 'blueprints.addManual');
    expect(added.data).toMatchObject({
      typeId: 638, characterId: 91316135, isCopy: false, runs: -1,
    });
    expect(container.querySelector('#bp-add-modal').hidden).toBe(true);
  });

  test('Escape closes the add modal', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#bp-add-btn').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(container.querySelector('#bp-add-modal').hidden).toBe(true);
  });
});

describe('removing a blueprint', () => {
  test('it confirms first, and cancelling does nothing', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1].click();
    container.querySelector('.bp-copy-delete').click();
    expect(container.querySelector('#bp-delete-modal').hidden).toBe(false);

    container.querySelector('#bp-delete-cancel').click();
    await settle();

    expect(calls.some((c) => c.fn === 'blueprints.remove')).toBe(false);
  });

  test('confirming removes that specific copy', async () => {
    blueprints = [
      bp({ itemId: '1', typeId: 2047 }),
      bp({ itemId: '2', typeId: 2047 }),
    ];
    blueprintNames = { 2047: 'Damage Control II Blueprint' };

    const { container } = await mountView({ characterId: 91316135 });

    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[1].click();
    container.querySelectorAll('.bp-copy-delete')[1].click();
    container.querySelector('#bp-delete-ok').click();
    await settle();

    expect(calls.find((c) => c.fn === 'blueprints.remove').itemId).toBe('2');
  });
});

describe('the calculator hand-off', () => {
  test('carries the EFFECTIVE ME, not the stored one', async () => {
    // Opening with the raw value would contradict the number on screen.
    blueprints = [bp({ itemId: '1001', materialEfficiency: 10, overrides: { materialEfficiency: 4 } })];

    const { container } = await mountView({ characterId: 91316135 });
    groupCards(container)[0].querySelectorAll('.bp-icon-btn')[0].click();
    await settle();

    expect(calls.find((c) => c.fn === 'blueprints.openInCalculator'))
      .toMatchObject({ typeId: 22545, me: 4 });
  });
});

describe('refresh', () => {
  test('fetches from ESI then reloads', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    calls.length = 0;

    container.querySelector('#bp-refresh-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'blueprints.fetch')).toBe(true);
    expect(calls.some((c) => c.fn === 'blueprints.getAll')).toBe(true);
  });

  test('a gated refresh is reported, not silently ignored', async () => {
    fetchResult = { success: true, skipped: true, reason: 'Nothing newer yet.' };

    const { container } = await mountView({ characterId: 91316135 });
    container.querySelector('#bp-refresh-btn').click();
    await settle();

    expect(calls.find((c) => c.fn === 'toast.info').m).toBe('Nothing newer yet.');
  });

  test('failure is a toast, never a blocking alert', async () => {
    allowErrors('Refresh failed');
    fetchResult = { success: false, error: 'ESI down' };
    const alertSpy = jest.fn();
    window.alert = alertSpy;

    const { container } = await mountView({ characterId: 91316135 });
    container.querySelector('#bp-refresh-btn').click();
    await settle();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'toast.error')).toBe(true);
  });
});

describe('live updates', () => {
  test('reloads when new blueprint data lands', async () => {
    await mountView({ characterId: 91316135 });
    calls.length = 0;

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'blueprints' }));
    await settle();

    expect(calls.some((c) => c.fn === 'blueprints.getAll')).toBe(true);
  });

  test('ignores endpoints this screen does not display', async () => {
    await mountView({ characterId: 91316135 });
    calls.length = 0;

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'skills' }));
    await settle();

    expect(calls.some((c) => c.fn === 'blueprints.getAll')).toBe(false);
  });
});

describe('remount hygiene', () => {
  test('a remount does not inherit the previous filters', async () => {
    const first = await mountView({ characterId: 91316135 });

    const search = first.container.querySelector('#bp-search');
    search.value = 'hulk';
    search.dispatchEvent(new Event('input'));
    expect(groupCards(first.container)).toHaveLength(1);

    first.ctx.dispose();
    if (registered.def.destroy) registered.def.destroy();

    const second = await mountView({ characterId: 91316135 });

    expect(second.container.querySelector('#bp-search').value).toBe('');
    expect(groupCards(second.container)).toHaveLength(2);
  });
});

describe('CSS contracts (jsdom applies no stylesheets - assert on the text)', () => {
  test('binding rule 6a: hidden beats any explicit display', () => {
    expect(VIEW_CSS).toMatch(/#blueprints-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  test('binding rule 1: facet highlights use box-shadow, not a toggled background', () => {
    const base = VIEW_CSS.match(/\.bp-facet\s*\{[^}]*\}/)[0];
    const on = VIEW_CSS.match(/\.bp-facet\.is-on\s*\{[^}]*\}/)[0];
    expect(base).toContain('background-color: transparent');
    expect(on).toContain('box-shadow');
    expect(on).not.toMatch(/background-color:\s*var/);
  });

  test('binding rule 3: both efficiency-input states set the same properties', () => {
    // Otherwise the override styling never clears when the override is removed.
    const base = VIEW_CSS.match(/\.bp-eff-input\s*\{[^}]*\}/)[0];
    const override = VIEW_CSS.match(/\.bp-eff-input\.is-override\s*\{[^}]*\}/)[0];

    ['border', 'background-color', 'color'].forEach((prop) => {
      expect(base).toMatch(new RegExp(`${prop}(-color)?:`));
    });
    expect(override).toMatch(/border-color:/);
    expect(override).toMatch(/background-color:/);
    expect(override).toMatch(/color:/);
  });

  test('binding rule 4: inputs use --qf-surface-sunken, not --qf-surface', () => {
    const rule = VIEW_CSS.match(/\.bp-input\s*\{[^}]*\}/)[0];
    expect(rule).toContain('var(--qf-surface-sunken)');
  });

  test('a gated refresh button is dimmed but never pointer-events: none', () => {
    const rule = VIEW_CSS.match(/\.btn\.is-gated\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/opacity:/);
    expect(rule).not.toMatch(/pointer-events:\s*none/);
  });
});
