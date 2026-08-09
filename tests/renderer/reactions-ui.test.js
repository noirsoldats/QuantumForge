/**
 * @jest-environment jsdom
 *
 * Reactions Calculator shell view.
 *
 * The renderer is an IIFE that registers itself with the shell router and
 * exposes nothing, so these tests drive it the way a user does.
 *
 * Fixtures use the REAL shapes each IPC returns:
 *   - searchReactions -> { typeID, typeName, productName, productQuantity }
 *     (capital ID, product already included)
 *   - calculateMaterials -> { materials, tree, product, time, pricing }
 *     where `materials` is an OBJECT keyed by typeId, not an array
 *   - per-material prices live at pricing.inputCosts.materialPrices[typeId]
 *     as { quantity, unitPrice, totalPrice, hasPrice }
 *   - structure bonuses are materialEfficiency / timeEfficiency /
 *     costReduction
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/reactions.view.html'),
  'utf8'
);

require('../../public/shared/qf-search-select.js');

/* --------------------------------------------------------------- fixtures */

let searchResults;
let calcResult;
let facilities;
let marketSets;
let toolMarketSet;
let structureBonuses;
let typeNames;
let calls;
let consoleErrors = [];
let expectedErrorPatterns = [];
let registered;

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function makeApi() {
  return {
    esi: {
      getDefaultCharacter: async () => ({ characterId: 91316135, characterName: 'Buckwalter' }),
    },
    reactions: {
      searchReactions: async (query) => {
        calls.push({ fn: 'searchReactions', query });
        return searchResults;
      },
      calculateMaterials: async (typeId, runs, characterId, facilityId, marketSetId) => {
        calls.push({
          fn: 'calculateMaterials', typeId, runs, characterId, facilityId, marketSetId,
        });
        return calcResult;
      },
      getTypeName: async (typeId) => {
        calls.push({ fn: 'getTypeName', typeId });
        return typeNames[typeId] || null;
      },
      getReactionProduct: async () => null,
      getReactionTime: async () => null,
      clearCaches: async () => true,
    },
    facilities: {
      getFacilities: async () => facilities,
      getFacility: async (id) => facilities.find((f) => String(f.id) === String(id)),
      getStructureBonuses: async (typeId) => {
        calls.push({ fn: 'getStructureBonuses', typeId });
        return structureBonuses;
      },
    },
    market: {
      getMarketSets: async () => marketSets,
      getMarketSetForTool: async (key) => {
        calls.push({ fn: 'getMarketSetForTool', key });
        return { marketSet: toolMarketSet };
      },
      setMarketSetForTool: async (key, id) => {
        calls.push({ fn: 'setMarketSetForTool', key, id });
        return true;
      },
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/reactions-view-renderer.js');
  });
}

function makeCtx() {
  const listeners = [];
  const tracked = [];
  return {
    ctx: {
      on: (target, type, handler) => {
        if (!target) return;
        target.addEventListener(type, handler);
        listeners.push([target, type, handler]);
      },
      track: (fn) => tracked.push(fn),
      dispose: () => {
        listeners.forEach(([t, ty, h]) => t.removeEventListener(ty, h));
        tracked.forEach((fn) => fn());
      },
    },
  };
}

async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function mountView(params) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { ctx } = makeCtx();
  const instance = await registered.def.mount(container, params || {}, ctx);
  await settle(30);
  return { container, ctx, instance };
}

/** Type into the inline search and pick the first result. */
async function searchAndPick(query = 'Fullerene') {
  const input = document.querySelector('#rx-search-host .qf-ss-inline-input');
  input.value = query;
  input.dispatchEvent(new window.Event('input'));
  // The inline search debounces at 300ms.
  await new Promise((r) => setTimeout(r, 340));
  await settle(30);

  // Inline mode renders its list inside the host, not in a body popover.
  const row = document.querySelector('#rx-search-host .qf-ss-row');
  if (!row) throw new Error('No search results rendered');
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(40);
}

beforeEach(() => {
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(
      args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter(Boolean)
        .join(' ')
    );
  });

  calls = [];

  searchResults = [
    {
      typeID: 46186,
      typeName: 'Fullerene Reaction Formula',
      productName: 'Fullerene',
      productQuantity: 200,
    },
    {
      typeID: 46187,
      typeName: 'Fulleroferrocene Reaction Formula',
      productName: 'Fulleroferrocene',
      productQuantity: 100,
    },
  ];

  typeNames = {
    16644: 'Ceramic Powder',
    16647: 'Vanadium',
  };

  calcResult = {
    // An OBJECT keyed by typeId, not an array.
    materials: { 16644: 12000, 16647: 6000 },
    product: { typeID: 46185, typeName: 'Fullerene', quantity: 400 },
    time: { baseTime: 10800, runs: 2, totalTime: 21600 },
    tree: [
      {
        typeID: 46184,
        typeName: 'Fulleroferrocene',
        quantity: 9000,
        isIntermediate: true,
        reactionName: 'Fulleroferrocene Reaction Formula',
        children: [
          {
            typeID: 16644,
            typeName: 'Ceramic Powder',
            quantity: 12000,
            isIntermediate: false,
            children: [],
          },
        ],
      },
      {
        typeID: 16647,
        typeName: 'Vanadium',
        quantity: 6000,
        isIntermediate: false,
        children: [],
      },
    ],
    pricing: {
      totalCost: 5_000_000,
      // An OBJECT, not a number - reading pricing.outputValue directly
      // rendered a dash where the value should be. It also carries how the
      // total was reached, so the card can show its working.
      outputValue: {
        totalValue: 7_500_000,
        unitPrice: 18_750,
        quantity: 400,
        typeId: 46185,
        priceType: 'sell',
        hasPrice: true,
      },
      profit: 2_500_000,
      profitMargin: 33.33,
      inputCosts: {
        // Nested TWO levels deep; each entry is an object.
        materialPrices: {
          16644: { quantity: 12000, unitPrice: 250, totalPrice: 3_000_000, hasPrice: true },
          16647: { quantity: 6000, unitPrice: 0, totalPrice: 0, hasPrice: false },
        },
      },
      jobCostBreakdown: {
        estimatedItemValue: 4_000_000,
        systemCostIndex: 2.8,
        jobGrossCost: 112_000,
        jobBaseCost: 112_000,
        facilityTaxRate: 0.25,
        facilityTax: 10_000,
        sccSurcharge: 160_000,
        totalJobCost: 282_000,
      },
    },
  };

  facilities = [
    { id: 'fac-1', name: 'Athanor - Reaction Array', structureTypeId: 35835 },
    { id: 'fac-2', name: 'Jita IV-4 CNAP', structureTypeId: null },
  ];

  structureBonuses = {
    structureName: 'Athanor',
    structureType: 'refinery',
    rigSize: 2,
    materialEfficiency: 2.0,
    timeEfficiency: 20.0,
    costReduction: 3.0,
  };

  marketSets = [
    { id: 'set-jita', name: 'Jita 4-4', isDefault: true },
    { id: 'set-amarr', name: 'Amarr' },
  ];
  toolMarketSet = marketSets[0];

  registered = null;
  window.QFShell = { router: { register: (id, def) => { registered = { id, def }; } } };
  window.QFToast = { show: jest.fn() };
  window.electronAPI = makeApi();

  document.body.innerHTML = VIEW_HTML;
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => p.test(e))
  );
  expectedErrorPatterns = [];
  console.error.mockRestore();
  document.body.innerHTML = '';

  if (unexpected.length > 0) {
    throw new Error(
      `Renderer logged ${unexpected.length} unexpected error(s):\n  ` + unexpected.join('\n  ')
    );
  }
});

/* ------------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers as a native shell view, not a framed page', () => {
    expect(registered.id).toBe('reactions');
    expect(typeof registered.def.mount).toBe('function');
    // The framed fallback is gone from the router entirely.
    expect(registered.def.file).toBeUndefined();
  });
});

describe('mount', () => {
  test('renders the view with an empty state', async () => {
    await mountView();

    expect(document.getElementById('rx-view')).not.toBeNull();
    expect(document.getElementById('rx-empty').hidden).toBe(false);
    expect(document.getElementById('rx-results').hidden).toBe(true);
  });

  test('every element toggled by `hidden` is hideable by CSS (rule 6a)', () => {
    // jsdom applies no stylesheets, so el.hidden proves nothing.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/reactions-view.css'),
      'utf8'
    );
    expect(css).toMatch(/#rx-view\s*\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('every block sits in one gapped column, so margins match', () => {
    // The pricing card looked misaligned because it was a sibling of the
    // scroll container rather than of the cards above it. One flex column
    // with a single gap is the mockup's own layout.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/reactions-view.css'),
      'utf8'
    );
    const inner = css.match(/#rx-view \.rx-inner\s*\{[^}]*\}/)[0];
    expect(inner).toMatch(/max-width:\s*1180px/);
    expect(inner).toMatch(/margin:\s*0 auto/);
    expect(inner).toMatch(/gap:\s*16px/);
  });

  test('the pricing card is a sibling of the cards above it', async () => {
    await mountView();
    await searchAndPick();

    const output = document.getElementById('rx-output');
    const pricing = document.getElementById('rx-pricing-card');
    const twoCol = output.querySelector('.rx-two-col');
    // Same parent means the column gap applies to both equally.
    expect(pricing.parentElement).toBe(output);
    expect(twoCol.parentElement).toBe(output);
  });

  test('resets the global bare-`header` chrome', () => {
    // styles.css paints every <header> with a dark fill and 2px border.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/reactions-view.css'),
      'utf8'
    );
    const rule = css.match(/#rx-view header\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/background:\s*none/);
    expect(rule).toMatch(/border-bottom:\s*none/);
  });
});

describe('search', () => {
  test('the search host is NOT inside a card', async () => {
    // A card sets overflow:hidden, which clipped the absolutely positioned
    // results panel so the dropdown appeared to fall behind the container.
    await mountView();

    const host = document.getElementById('rx-search-host');
    expect(host.closest('.rx-card')).toBeNull();
  });

  test('the search host carries its own stacking context', () => {
    // The results panel is position:absolute, so the host needs
    // position:relative AND a z-index above the cards below it.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/reactions-view.css'),
      'utf8'
    );
    const rule = css.match(/#rx-view \.rx-search-host\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/position:\s*relative/);
    expect(rule).toMatch(/z-index:\s*\d/);
  });

  test('is an inline QFSearchSelect, not a hand-rolled combobox', async () => {
    // Binding rule 5: one shared searchable dropdown.
    await mountView();
    expect(document.querySelector('#rx-search-host .qf-ss-inline-input')).not.toBeNull();
  });

  test('search rows say what the reaction produces', async () => {
    // searchReactions already returns productName and productQuantity, so no
    // second lookup is needed to show it.
    await mountView();
    const input = document.querySelector('#rx-search-host .qf-ss-inline-input');
    input.value = 'Fullerene';
    input.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 340));
    await settle(30);

    const row = document.querySelector('#rx-search-host .qf-ss-row');
    expect(row.textContent).toContain('Fullerene Reaction Formula');
    expect(row.textContent).toContain('Produces 200x Fullerene');
  });

  test('picking a reaction reveals the results panel', async () => {
    await mountView();
    await searchAndPick();

    expect(document.getElementById('rx-empty').hidden).toBe(true);
    expect(document.getElementById('rx-results').hidden).toBe(false);
    expect(document.getElementById('rx-reaction-name').textContent)
      .toBe('Fullerene Reaction Formula');
  });

  test('picking a reaction calculates immediately', async () => {
    await mountView();
    await searchAndPick();

    const call = calls.find((c) => c.fn === 'calculateMaterials');
    expect(call.typeId).toBe(46186);
    expect(call.runs).toBe(1);
  });
});

describe('calculation', () => {
  test('passes runs, character, facility and market set', async () => {
    await mountView();
    await searchAndPick();
    calls.length = 0;

    document.getElementById('rx-runs').value = '5';
    document.getElementById('rx-calculate').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    const call = calls.find((c) => c.fn === 'calculateMaterials');
    expect(call.runs).toBe(5);
    expect(call.characterId).toBe(91316135);
    expect(call.marketSetId).toBe('set-jita');
  });

  test('refuses runs below 1 before any IPC', async () => {
    await mountView();
    await searchAndPick();
    calls.length = 0;

    document.getElementById('rx-runs').value = '0';
    document.getElementById('rx-calculate').dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'calculateMaterials')).toBe(false);
    expect(window.QFToast.show).toHaveBeenCalled();
  });

  test('an in-band error is surfaced, not rendered as a result', async () => {
    // calculateMaterials reports domain failures in the result rather than
    // throwing, so a naive renderer would show an empty panel.
    calcResult = { error: 'No reaction formula found' };
    await mountView();
    await searchAndPick();

    expect(window.QFToast.show).toHaveBeenCalledWith(
      'No reaction formula found',
      'error'
    );
    expect(document.getElementById('rx-output').hidden).toBe(true);
  });
});

describe('results', () => {
  test('shows per-run, runs and total time', async () => {
    await mountView();
    await searchAndPick();

    const text = document.getElementById('rx-time').textContent;
    expect(text).toContain('3h');     // baseTime 10800s
    expect(text).toContain('6h');     // totalTime 21600s
  });

  test('renders the chain with the product at the root', async () => {
    await mountView();
    await searchAndPick();

    const root = document.querySelector('#rx-tree .rx-tree-root');
    expect(root.textContent).toContain('Fullerene');
    expect(root.textContent).toContain('400');
  });

  test('nests children under their parent', async () => {
    await mountView();
    await searchAndPick();

    const rows = document.querySelectorAll('#rx-tree .rx-tree-row[data-rx-node]');
    expect(rows[0].textContent).toContain('Fulleroferrocene');
    expect(rows[0].style.getPropertyValue('--rx-depth')).toBe('1');
    expect(rows[1].textContent).toContain('Ceramic Powder');
    expect(rows[1].style.getPropertyValue('--rx-depth')).toBe('2');
  });

  test('names the reaction that makes an intermediate', async () => {
    await mountView();
    await searchAndPick();

    // The mockup prints the formula name bare beneath the item, with no
    // "via" prefix - it is a caption, not a sentence.
    const row = document.querySelector('#rx-tree .rx-tree-row[data-rx-node="46184"]');
    expect(row.querySelector('.rx-tree-formula').textContent)
      .toBe('Fulleroferrocene Reaction Formula');
  });

  test('a raw material has no formula caption', async () => {
    // Nothing produces it, so there is no formula to name.
    await mountView();
    await searchAndPick();

    const raw = document.querySelector('#rx-tree .rx-tree-row[data-rx-node="16647"]');
    expect(raw.querySelector('.rx-tree-formula')).toBeNull();
  });

  test('the root names the formula that produces it', async () => {
    // The mockup captions the product row with the reaction's own name.
    await mountView();
    await searchAndPick();

    expect(document.querySelector('#rx-tree .rx-tree-root .rx-tree-formula').textContent)
      .toBe('Fullerene Reaction Formula');
  });

  test('the reaction header shows product, per-run and cycle time', async () => {
    await mountView();
    await searchAndPick();

    expect(document.getElementById('rx-reaction-product').textContent)
      .toContain('Produces Fullerene × 200 / run');
    expect(document.getElementById('rx-reaction-cycle').textContent)
      .toContain('Cycle Time');
  });

  test('the reaction icon uses the blueprint variant', async () => {
    // A reaction FORMULA is a blueprint-like item; /icon would 404.
    await mountView();
    await searchAndPick();

    expect(document.getElementById('rx-reaction-icon').src).toContain('/46186/bp');
  });

  test('tree rows carry an icon and a role badge', async () => {
    await mountView();
    await searchAndPick();

    const row = document.querySelector('#rx-tree .rx-tree-row[data-rx-node="46184"]');
    expect(row.querySelector('.rx-tree-icon')).not.toBeNull();
    expect(row.querySelector('.rx-tree-badge').textContent).toBe('INTERMEDIATE');

    const raw = document.querySelector('#rx-tree .rx-tree-row[data-rx-node="16647"]');
    expect(raw.querySelector('.rx-tree-badge').textContent).toBe('RAW');
  });

  test('a sub-reaction is badged INTERMEDIATE in green, not accent', async () => {
    // It is itself produced by a reaction, so it reads as an intermediate
    // step rather than as "a reaction".
    await mountView();
    await searchAndPick();

    const badge = document.querySelector(
      '#rx-tree .rx-tree-row[data-rx-node="46184"] .rx-tree-badge'
    );
    expect(badge.classList.contains('is-intermediate')).toBe(true);

    const css = fs.readFileSync(
      path.join(__dirname, '../../public/reactions-view.css'),
      'utf8'
    );
    const rule = css.match(/#rx-view \.rx-tree-badge\.is-intermediate\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/color:\s*var\(--qf-success\)/);
  });

  test('role glyphs are SVG shapes, not text characters', async () => {
    // The mockup uses an open circle for the product, a crosshair for an
    // intermediate and a filled square for a raw material.
    await mountView();
    await searchAndPick();

    expect(document.querySelector('#rx-tree .rx-tree-root .rx-tree-glyph svg'))
      .not.toBeNull();
    expect(document.querySelector(
      '#rx-tree .rx-tree-row[data-rx-node="46184"] .rx-tree-glyph svg'
    )).not.toBeNull();
    // Raw materials use a styled span rather than an SVG.
    expect(document.querySelector(
      '#rx-tree .rx-tree-row[data-rx-node="16647"] .rx-tree-dot'
    )).not.toBeNull();
  });

  test('lists raw materials from the materials OBJECT', async () => {
    // `materials` is keyed by typeId - iterating it as an array yields none.
    await mountView();
    await searchAndPick();

    const rows = document.querySelectorAll('#rx-materials .rx-material-row');
    expect(rows).toHaveLength(2);
    expect(document.getElementById('rx-materials-count').textContent).toBe('2');
  });

  test('resolves material names rather than showing type ids', async () => {
    await mountView();
    await searchAndPick();

    const text = document.getElementById('rx-materials').textContent;
    expect(text).toContain('Ceramic Powder');
    expect(text).toContain('Vanadium');
    expect(text).not.toMatch(/Type \d+/);
  });

  test('reads prices from pricing.inputCosts.materialPrices', async () => {
    // Nested two levels deep, and each entry is an object with totalPrice.
    await mountView();
    await searchAndPick();

    const row = document.querySelector('[data-rx-material="16644"]');
    expect(row.textContent).toContain('3,000,000.00');
  });

  test('an unpriced material shows a dash, not zero', async () => {
    // hasPrice distinguishes "free" from "could not be priced"; rendering
    // 0.00 would understate the total.
    await mountView();
    await searchAndPick();

    const cell = document.querySelector('[data-rx-material="16647"] .rx-material-total');
    expect(cell.textContent).toBe('—');
    expect(cell.title).toContain('No market price');
  });

  test('shows quantity x unit price as the row detail', async () => {
    await mountView();
    await searchAndPick();

    const detail = document.querySelector('[data-rx-material="16644"] .rx-material-detail');
    expect(detail.textContent).toContain('12,000');
    expect(detail.textContent).toContain('250.00');
  });

  test('totals only what could actually be priced', async () => {
    // Vanadium has no price, so the total is Ceramic Powder alone.
    await mountView();
    await searchAndPick();

    expect(document.getElementById('rx-materials-total').hidden).toBe(false);
    expect(document.getElementById('rx-materials-total-value').textContent)
      .toContain('3,000,000.00');
  });

  test('hides the materials total when nothing could be priced', async () => {
    calcResult.pricing.inputCosts.materialPrices = {};
    await mountView();
    await searchAndPick();

    expect(document.getElementById('rx-materials-total').hidden).toBe(true);
  });
});

describe('pricing', () => {
  test('shows cost, output value and profit', async () => {
    await mountView();
    await searchAndPick();

    const text = document.getElementById('rx-pricing-cards').textContent;
    expect(text).toContain('5,000,000.00');
    expect(text).toContain('7,500,000.00');
    expect(text).toContain('2,500,000.00');
    expect(text).toContain('33.33% margin');
  });

  test('reads the output value from its nested totalValue', async () => {
    // pricing.outputValue is { totalValue }, so reading it directly showed
    // a dash. Main computes it as price-each x quantity x runs.
    await mountView();
    await searchAndPick();

    const value = document.querySelector('[data-rx-price="output-value"] .rx-price-value');
    expect(value.textContent).toContain('7,500,000.00');
    expect(value.textContent).not.toBe('—');
  });

  test('shows how the output value was reached', async () => {
    // Quantity and price-each, so the figure can be checked at a glance.
    await mountView();
    await searchAndPick();

    const sub = document.querySelector('[data-rx-price="output-value"] .rx-price-sub');
    expect(sub.textContent).toContain('400');
    expect(sub.textContent).toContain('18,750.00');
    expect(sub.textContent).toContain('sell');
  });

  test('an unpriced product says so rather than claiming 0.00 each', async () => {
    calcResult.pricing.outputValue = {
      totalValue: 0, unitPrice: 0, quantity: 400, typeId: 46185,
      priceType: 'sell', hasPrice: false,
    };
    await mountView();
    await searchAndPick();

    const sub = document.querySelector('[data-rx-price="output-value"] .rx-price-sub');
    expect(sub.textContent).toContain('no market price');
    expect(sub.textContent).not.toContain('0.00 ×');
  });

  test('a loss is toned differently from a profit', async () => {
    calcResult.pricing.profit = -1_000_000;
    calcResult.pricing.profitMargin = -20;
    await mountView();
    await searchAndPick();

    const value = document.querySelector('[data-rx-price="profit"] .rx-price-value');
    expect(value.classList.contains('is-negative')).toBe(true);
    expect(value.classList.contains('is-positive')).toBe(false);
  });

  test('the job cost breakdown uses the real percentages', async () => {
    // The system index varies per system and the tax per structure owner, so
    // neither may be hardcoded.
    await mountView();
    await searchAndPick();

    const text = document.getElementById('rx-jobcost-rows').textContent;
    expect(text).toContain('System Cost Index (2.80%)');
    expect(text).toContain('Facility Tax (0.25%)');
    expect(text).toContain('282,000.00');   // totalJobCost
  });

  test('the pricing card is hidden when nothing could be priced', async () => {
    // Showing zeroes would read as "this reaction is worthless".
    delete calcResult.pricing;
    await mountView();
    await searchAndPick();

    expect(document.getElementById('rx-pricing-card').hidden).toBe(true);
  });
});

describe('facility', () => {
  test('choosing a structure shows its bonuses', async () => {
    await mountView();
    await searchAndPick();

    const select = document.querySelector('#rx-facility-host select');
    select.value = 'fac-1';
    select.dispatchEvent(new window.Event('change'));
    await settle(40);

    const text = document.getElementById('rx-bonus-list').textContent;
    expect(text).toContain('-2.0%');    // materialEfficiency
    expect(text).toContain('-20.0%');   // timeEfficiency
    expect(text).toContain('-3.0%');    // costReduction
  });

  test('the facility name carries the structure mark', async () => {
    await mountView();
    await searchAndPick();

    const select = document.querySelector('#rx-facility-host select');
    select.value = 'fac-1';
    select.dispatchEvent(new window.Event('change'));
    await settle(40);

    const label = document.getElementById('rx-bonuses-facility');
    expect(label.querySelector('svg')).not.toBeNull();
    expect(label.textContent).toContain('Athanor');
  });

  test('an NPC station shows no bonus panel', async () => {
    await mountView();
    await searchAndPick();

    const select = document.querySelector('#rx-facility-host select');
    select.value = 'fac-2';
    select.dispatchEvent(new window.Event('change'));
    await settle(40);

    expect(document.getElementById('rx-bonuses').hidden).toBe(true);
    expect(calls.some((c) => c.fn === 'getStructureBonuses')).toBe(false);
  });

  test('changing the facility recalculates', async () => {
    // The facility changes ME/TE and job cost, so the old result is stale.
    await mountView();
    await searchAndPick();
    calls.length = 0;

    const select = document.querySelector('#rx-facility-host select');
    select.value = 'fac-1';
    select.dispatchEvent(new window.Event('change'));
    await settle(40);

    const call = calls.find((c) => c.fn === 'calculateMaterials');
    expect(call.facilityId).toBe('fac-1');
  });
});

describe('market set', () => {
  test('is a plain select, not a searchable combobox', async () => {
    await mountView();
    expect(document.querySelector('#rx-market-host select')).not.toBeNull();
    expect(document.querySelector('#rx-market-host .qf-ss-trigger')).toBeNull();
  });

  test('changing it re-prices the current reaction', async () => {
    await mountView();
    await searchAndPick();
    calls.length = 0;

    const select = document.querySelector('#rx-market-host select');
    select.value = 'set-amarr';
    select.dispatchEvent(new window.Event('change'));
    await settle(40);

    expect(calls.find((c) => c.fn === 'setMarketSetForTool').id).toBe('set-amarr');
    expect(calls.some((c) => c.fn === 'calculateMaterials')).toBe(true);
  });

  test('market set ids stay strings', async () => {
    // They are opaque - coercing to Number yields NaN and loses the binding.
    await mountView();
    await searchAndPick();

    const call = calls.find((c) => c.fn === 'calculateMaterials');
    expect(typeof call.marketSetId).toBe('string');
  });
});

describe('lifecycle', () => {
  test('unmount destroys the dropdowns', async () => {
    const { instance } = await mountView();
    instance.destroy();

    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('remounting leaves one search field', async () => {
    const first = await mountView();
    first.instance.destroy();
    first.container.remove();

    await mountView();

    expect(document.querySelectorAll('#rx-search-host .qf-ss-inline-input')).toHaveLength(1);
  });
});

describe('resilience', () => {
  test('a failed facility load still renders the view', async () => {
    window.electronAPI.facilities.getFacilities = async () => { throw new Error('nope'); };
    allowErrors(/facilities/);

    await mountView();

    expect(document.getElementById('rx-view')).not.toBeNull();
    expect(document.getElementById('rx-empty').hidden).toBe(false);
  });

  test('a failed calculation leaves the previous output alone', async () => {
    await mountView();
    await searchAndPick();
    expect(document.getElementById('rx-output').hidden).toBe(false);

    window.electronAPI.reactions.calculateMaterials = async () => {
      throw new Error('sde gone');
    };
    allowErrors(/calculate reaction/);

    document.getElementById('rx-calculate').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringContaining('Failed to calculate'),
      'error'
    );
  });
});
