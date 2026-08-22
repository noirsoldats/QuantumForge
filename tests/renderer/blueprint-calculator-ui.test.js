/**
 * @jest-environment jsdom
 *
 * Blueprint Calculator shell view.
 *
 * The renderer is an IIFE that registers itself with the shell router and
 * exposes nothing, so these tests drive it the way a user does: mount it, click
 * and type, then assert on the DOM.
 *
 * Two things these tests exist to prevent, both of which have bitten before:
 *
 *   1. Silent breakage. The renderer catches its own failures and logs them, so
 *      a broken call site leaves every assertion passing while the view is
 *      blank. console.error is captured and any unexpected entry FAILS the
 *      test - see the afterEach guard.
 *   2. Duplicate subscriptions. This view can be mounted, unmounted and mounted
 *      again in a persistent document. The legacy page discarded its
 *      subscription disposers, which only looked safe because navigation
 *      destroyed the document.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/blueprint-calculator.view.html'),
  'utf8'
);

// Sets window.QFUI, the same way index.html loads it before every view
// renderer. The renderer loads its template through QFUI.loadViewFragment,
// so without this the mount throws ReferenceError.
require('../../public/shared/ui-helpers.js');
require('../../public/shared/qf-search-select.js');

/* --------------------------------------------------------------- fixtures */

let blueprints;
let facilities;
let marketSets;
let plans;
let calcResult;
let inventionData;
let decryptorResult;
let calls;
/** What resolveOwnedBlueprint returns; null means "no enabled source owns it". */
let ownedBlueprint;
let consoleErrors = [];
let expectedErrorPatterns = [];
/** Disposer-call counts, keyed by channel, to prove unmount tears down. */
let disposed;
/** Live subscription callbacks, keyed by channel. */
let subscribers;

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function subscribe(channel, cb) {
  if (!subscribers[channel]) subscribers[channel] = [];
  subscribers[channel].push(cb);
  return () => {
    disposed[channel] = (disposed[channel] || 0) + 1;
    subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
  };
}

function makeApi() {
  return {
    esi: {
      getDefaultCharacter: async () => ({ characterId: 91316135, characterName: 'Test Pilot' }),
      onDefaultCharacterChanged: (cb) => subscribe('default-character-changed', cb),
    },
    blueprints: {
      onOpenInCalculator: (cb) => subscribe('calculator:openBlueprint', cb),
    },
    market: {
      getMarketSets: async () => marketSets,
      getMarketSetForTool: async () => ({ marketSet: marketSets[0] }),
      setMarketSetForTool: async (key, id) => {
        calls.push({ fn: 'setMarketSetForTool', key, id });
        return { success: true };
      },
      calculatePrice: async (typeId) => ({ price: 100 + typeId }),
    },
    facilities: {
      getFacilities: async () => facilities,
      getFacility: async (id) => facilities.find((f) => String(f.id) === String(id)) || null,
    },
    calculator: {
      searchBlueprints: async (q) => {
        calls.push({ fn: 'searchBlueprints', q });
        return blueprints.filter((b) => b.typeName.toLowerCase().includes(q.toLowerCase()));
      },
      getBlueprintProduct: async (typeId) => {
        const bp = blueprints.find((b) => b.typeID === typeId);
        return bp ? { typeID: bp.productTypeID, quantity: bp.productQuantity } : null;
      },
      getTypeName: async (typeId) => {
        const bp = blueprints.find((b) => b.typeID === typeId);
        if (bp) return bp.typeName;
        const names = {
          34: 'Tritanium',
          35: 'Pyerite',
          587: 'Rifter',
          588: 'Rifter II',
          11399: 'Morphite',
          20410: 'Datacore - Mechanical Engineering',
        };
        return names[typeId] || `Type ${typeId}`;
      },
      // Resolves against the ENABLED blueprint sources rather than a character.
      // Returns provenance alongside ME/TE so the view can show where a number
      // came from. (getOwnedBlueprintME is deliberately absent: the view no
      // longer calls it, and a stub for it would imply otherwise.)
      resolveOwnedBlueprint: async () => ownedBlueprint,
      clearCaches: async () => {},
      calculateMaterials: async (...args) => {
        calls.push({ fn: 'calculateMaterials', args });
        return calcResult;
      },
      getInventionData: async () => inventionData,
      getAllDecryptors: async () => [{ typeID: 34201, typeName: 'Accelerant Decryptor' }],
      findBestDecryptor: async (...args) => {
        calls.push({ fn: 'findBestDecryptor', args });
        return decryptorResult;
      },
      getRigBonuses: async () => ({ materialBonus: 2 }),
    },
    skills: { getEffectiveLevel: async () => 5 },
    sde: { getSystemSecurityStatus: async () => 0.9 },
    plans: {
      getAll: async () => plans,
      create: async (characterId, name) => {
        calls.push({ fn: 'plans.create', characterId, name });
        return { planId: 'plan-new' };
      },
      addBlueprint: async (planId, config) => {
        calls.push({ fn: 'plans.addBlueprint', planId, config });
        return { success: true };
      },
    },
  };
}

/** Minimal stand-in for the shell's ViewContext. */
function makeCtx() {
  const disposers = [];
  return {
    track: (d) => {
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    on: (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      disposers.push(() => target.removeEventListener(type, handler, options));
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    dispose: () => disposers.forEach((d) => d()),
    _disposers: disposers,
  };
}

let registered;

function loadRenderer() {
  jest.resetModules();
  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => {
        registered = { id, def };
      },
      show: () => {},
    },
  };
  require('../../src/renderer/blueprint-calculator-view-renderer.js');
}

async function mountView(params) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = makeCtx();
  const instance = await registered.def.mount(container, params || {}, ctx);
  return { container, ctx, instance };
}

/** Let queued promises settle. The view awaits several IPC calls in sequence. */
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map(String).join(' '));
  });

  calls = [];
  disposed = {};
  subscribers = {};

  // An owned ME 7 BPO, matching the old getOwnedBlueprintME fixture.
  ownedBlueprint = {
    me: 7,
    te: 14,
    itemId: 'item-rifter-bpo',
    characterId: 91316135,
    isCopy: false,
    isCorporation: false,
  };

  blueprints = [
    {
      typeID: 1001,
      typeName: 'Rifter Blueprint',
      productTypeID: 587,
      productName: 'Rifter',
      productQuantity: 1,
    },
    {
      typeID: 1002,
      typeName: 'Rifter II Blueprint',
      productTypeID: 588,
      productName: 'Rifter II',
      productQuantity: 1,
    },
  ];

  facilities = [
    { id: 'fac-1', name: 'Jita Raitaru', usage: 'default', systemId: 30000142, structureTypeId: 35825, rigs: [] },
    { id: 'fac-2', name: 'Amarr Azbel', systemId: 30002187, structureTypeId: 35826, rigs: ['37158'] },
  ];

  // Market set ids are opaque STRINGS - a numeric fixture previously hid a
  // Number() coercion bug that nulled every binding.
  marketSets = [
    {
      id: 'set-jita',
      name: 'Jita 4-4',
      isDefault: true,
      inputMaterials: { regionId: 10000002, locationId: 60003760, priceType: 'sell' },
      outputProducts: { regionId: 10000002, locationId: 60003760, priceType: 'buy' },
    },
    { id: 'set-amarr', name: 'Amarr', inputMaterials: {}, outputProducts: {} },
  ];

  plans = [
    { planId: 'plan-1', planName: 'Q3 Frigates', status: 'active' },
    { planId: 'plan-2', planName: 'Old Batch', status: 'completed' },
  ];

  calcResult = {
    materials: { 34: 5000, 35: 1200 },
    breakdown: [
      {
        blueprintName: 'Rifter Blueprint',
        meLevel: 7,
        runs: 1,
        productName: 'Rifter',
        productQuantity: 1,
        rawMaterials: [
          { typeID: 34, typeName: 'Tritanium', quantity: 5000 },
          { typeID: 35, typeName: 'Pyerite', quantity: 1200 },
        ],
        intermediateComponents: [],
      },
    ],
    pricing: {
      inputCosts: {
        totalCost: 50000,
        itemsWithoutPrices: 0,
        materialPrices: {
          34: { typeName: 'Tritanium', quantity: 5000, unitPrice: 6, totalPrice: 30000 },
          35: { typeName: 'Pyerite', quantity: 1200, unitPrice: 16.67, totalPrice: 20000 },
        },
      },
      jobCostBreakdown: {
        estimatedItemValue: 100000,
        systemCostIndex: 0.045,
        jobGrossCost: 4500,
        structureRollBonus: 3,
        jobBaseCost: 4365,
        facilityTaxRate: 1,
        facilityTax: 43.65,
        sccSurcharge: 174.6,
        totalJobCost: 4583.25,
      },
      taxesBreakdown: {
        materialsCost: 50000,
        materialBrokerFeeRate: 1.5,
        materialBrokerFee: 750,
        brokerRelationsSkillLevel: 4,
        outputValue: 90000,
        effectiveSalesTaxRate: 3.6,
        accountingSkillLevel: 4,
        productSalesTax: 3240,
        productBrokerFeeRate: 1.5,
        productBrokerFee: 1350,
        totalProductFees: 4590,
      },
      totalCosts: 59923.25,
      outputValue: { quantity: 1, totalValue: 90000, hasPrice: true },
      profit: 30076.75,
      profitMargin: 33.42,
    },
  };

  inventionData = {
    products: [
      {
        typeID: 1002,
        typeName: 'Rifter II Blueprint',
        baseProbability: 0.34,
        manufacturedProduct: { typeID: 588, typeName: 'Rifter II' },
      },
    ],
    materials: [
      { typeID: 20410, typeName: 'Datacore - Mechanical Engineering', quantity: 2 },
    ],
    skills: [
      { skillID: 11444, skillName: 'Mechanical Engineering' },
      { skillID: 11454, skillName: 'Gallentean Starship Engineering' },
    ],
    time: 3600,
  };

  // Mirrors calculateOptionMetrics in src/main/blueprint-calculator.js EXACTLY.
  // An earlier fixture invented `decryptor.typeName`, `runs`, `me`, `te` and
  // `attemptsNeeded` - none of which the backend returns - so the whole suite
  // passed while every decryptor row read "No Decryptor" with wrong numbers.
  // If this shape and that function ever disagree, this fixture is the bug.
  const accelerant = {
    name: 'Accelerant Decryptor',
    typeID: 34201,
    probability: 0.408,
    costPerSuccess: 1225000,
    costPerRun: 111363,
    runsPerBPC: 11,
    materialCost: 400000,
    decryptorCost: 100000,
    jobCost: 20000,
    totalCostPerAttempt: 520000,
    meModifier: 2,
    finalME: 4,
    teModifier: 2,
    finalTE: 6,
    runsModifier: 1,
    probabilityMultiplier: 1.2,
    manufacturingCostPerItem: 800000,
    manufacturingCostFullBPC: 8800000,
    manufacturingTimePerItem: 3600,
    totalCostPerItem: 911363,
    totalCostFullBPC: 10024993,
  };

  const noDecryptorOption = {
    name: 'No Decryptor',
    typeID: null,
    probability: 0.34,
    costPerSuccess: 1200000,
    costPerRun: 120000,
    runsPerBPC: 10,
    materialCost: 400000,
    decryptorCost: 0,
    jobCost: 20000,
    totalCostPerAttempt: 420000,
    meModifier: 0,
    finalME: 2,
    teModifier: 0,
    finalTE: 4,
    runsModifier: 0,
    probabilityMultiplier: 1,
    manufacturingCostPerItem: 820000,
    manufacturingCostFullBPC: 8200000,
    manufacturingTimePerItem: 3600,
    totalCostPerItem: 940000,
    totalCostFullBPC: 9400000,
  };

  decryptorResult = {
    best: accelerant,
    // `noDecryptor` is a REDUCED projection, not a full option - only these
    // five fields exist on it.
    noDecryptor: {
      probability: noDecryptorOption.probability,
      costPerSuccess: noDecryptorOption.costPerSuccess,
      totalCost: noDecryptorOption.totalCostPerAttempt,
      totalCostPerItem: noDecryptorOption.totalCostPerItem,
      manufacturingCostPerItem: noDecryptorOption.manufacturingCostPerItem,
    },
    allOptions: [noDecryptorOption, accelerant],
    optimizationStrategy: 'total-per-item',
  };

  window.electronAPI = makeApi();
  window.QFToast = { show: (message, type) => calls.push({ fn: 'toast', message, type }) };

  // The view fetches its template; serve the real file.
  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  document.body.innerHTML = '';
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter((e) => !expectedErrorPatterns.some((p) => p.test(e)));
  expectedErrorPatterns = [];
  console.error.mockRestore();
  document.body.innerHTML = '';

  if (unexpected.length > 0) {
    throw new Error(
      `Renderer logged ${unexpected.length} unexpected error(s):\n  ` + unexpected.join('\n  ')
    );
  }
});

/* ------------------------------------------------------------ registration */

describe('registration', () => {
  test('registers itself as a native shell view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('blueprint-calculator');
    expect(typeof registered.def.mount).toBe('function');
  });
});

/* ------------------------------------------------------------------ mount */

describe('mount', () => {
  test('renders the view and starts on the empty state', async () => {
    const { container } = await mountView();
    await settle();

    expect(container.querySelector('#bpc-view')).not.toBeNull();
    expect(document.getElementById('bpc-empty').hidden).toBe(false);
    expect(document.getElementById('bpc-bp-card').hidden).toBe(true);
  });

  test('mounts the market set and facility pickers as QFSearchSelect', async () => {
    await mountView();
    await settle();

    // Binding rule 5: these are the shared component, not hand-rolled selects.
    expect(document.querySelector('#bpc-market-host .qf-ss-trigger')).not.toBeNull();
    expect(document.querySelector('#bpc-facility-host .qf-ss-trigger')).not.toBeNull();
  });

  test('the blueprint search is the shared component in inline mode', async () => {
    await mountView();
    await settle();

    expect(document.querySelector('#bpc-search-host .qf-ss-inline-input')).not.toBeNull();
    // Inline mode means no trigger button for this one.
    expect(document.querySelector('#bpc-search-host .qf-ss-trigger')).toBeNull();
  });

  test('selects the default facility on load', async () => {
    await mountView();
    await settle();

    const trigger = document.querySelector('#bpc-facility-host .qf-ss-value');
    expect(trigger.textContent).toBe('Jita Raitaru');
  });

  test('the Add to Plan modal is closed on mount', async () => {
    // Regression: the view opened straight into the modal. `hidden` was set in
    // the markup, but `.modal { display: flex }` overrides the browser default
    // `[hidden] { display: none }`, so it rendered open.
    await mountView();
    await settle();

    expect(document.getElementById('bpc-plan-modal').hidden).toBe(true);
  });

  test('every element toggled by `hidden` is actually hideable by CSS', () => {
    // jsdom does not apply stylesheets, so `el.hidden === true` proves nothing
    // about what the user sees. Assert against the real CSS instead: any class
    // that sets an explicit `display` defeats the `hidden` attribute unless a
    // `[hidden]` rule wins it back.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/blueprint-calculator-view.css'),
      'utf8'
    );
    const shared = fs.readFileSync(
      path.join(__dirname, '../../public/shared/components.css'),
      'utf8'
    );

    // The view-wide override, and the shared one for .modal.
    expect(css).toMatch(/#bpc-view\s*\[hidden\]\s*\{[^}]*display:\s*none/);
    expect(shared).toMatch(/\.modal\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('invention selects are plain selects, not comboboxes (rule 5)', async () => {
    await mountView();
    await settle();

    // Few fixed options -> plain <select>, per the binding rules.
    expect(document.getElementById('bpc-inv-strategy').tagName).toBe('SELECT');
    expect(document.getElementById('bpc-inv-decryptor').tagName).toBe('SELECT');
  });
});

/* ----------------------------------------------------------------- search */

describe('blueprint search', () => {
  async function search(text) {
    const input = document.querySelector('#bpc-search-host .qf-ss-inline-input');
    input.value = text;
    input.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 320)); // past the 300ms debounce
    await settle();
    return input;
  }

  test('typing queries the backend and renders rich rows', async () => {
    await mountView();
    await settle();

    await search('Rifter');

    expect(calls.some((c) => c.fn === 'searchBlueprints' && c.q === 'Rifter')).toBe(true);
    const rows = document.querySelectorAll('#bpc-search-host .qf-ss-row');
    expect(rows.length).toBe(2);
    // Rich row: name plus what it produces.
    expect(rows[0].querySelector('.bpc-sr-name').textContent).toBe('Rifter Blueprint');
    expect(rows[0].querySelector('.bpc-sr-cat').textContent).toContain('Produces: Rifter');
  });

  test('no row is highlighted on first paint (binding rule 2)', async () => {
    await mountView();
    await settle();
    await search('Rifter');

    expect(document.querySelectorAll('#bpc-search-host .qf-ss-hi')).toHaveLength(0);
  });

  test('a T2 blueprint gets a tech badge', async () => {
    await mountView();
    await settle();
    await search('Rifter');

    const rows = document.querySelectorAll('#bpc-search-host .qf-ss-row');
    // "Rifter II Blueprint" -> T2; the T1 row has no badge.
    expect(rows[1].querySelector('.bpc-tech').textContent).toBe('T2');
    expect(rows[0].querySelector('.bpc-tech')).toBeNull();
  });

  test('search rows use the blueprint icon variant, not the item one', async () => {
    // Regression: every search row rendered as a broken image. EVE serves
    // blueprints from `/bp`; `/icon` 404s for a blueprint typeID.
    await mountView();
    await settle();
    await search('Rifter');

    const icon = document.querySelector('#bpc-search-host .bpc-sr-icon');
    expect(icon.src).toContain('/types/1001/bp');
    expect(icon.src).not.toContain('/types/1001/icon');
  });

  test('material icons still use the plain item variant', async () => {
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);

    // Materials are ordinary types - `/icon` is correct for these.
    const icon = document.querySelector('#bpc-total-materials .bpc-mat-icon');
    expect(icon.src).toContain('/icon');
    expect(icon.src).not.toContain('/bp');
  });

  test('clicking a result loads the blueprint', async () => {
    await mountView();
    await settle();
    await search('Rifter');

    document
      .querySelectorAll('#bpc-search-host .qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.getElementById('bpc-bp-name').textContent).toBe('Rifter Blueprint');
    expect(document.getElementById('bpc-bp-card').hidden).toBe(false);
    expect(document.getElementById('bpc-empty').hidden).toBe(true);
  });

  test('selecting clears the query so no stale text is left behind', async () => {
    await mountView();
    await settle();
    const input = await search('Rifter');

    document
      .querySelectorAll('#bpc-search-host .qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(input.value).toBe('');
  });
});

/* ------------------------------------------------------------- blueprint */

describe('blueprint selection', () => {
  async function selectRifter() {
    const { container, ctx, instance } = await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);
    return { container, ctx, instance };
  }

  test('defaults ME to the best owned blueprint across enabled sources', async () => {
    await selectRifter();
    // Resolved from the ENABLED blueprint sources (Settings > Industry), not
    // from whoever happens to be the default character.
    expect(document.getElementById('bpc-me').value).toBe('7');
  });

  test('defaults ME to 0 when no enabled source owns the blueprint', async () => {
    ownedBlueprint = null;
    await selectRifter();

    expect(document.getElementById('bpc-me').value).toBe('0');
  });

  test('an owned ME 0 blueprint is not treated as "not owned"', async () => {
    // These were collapsed by a `|| 0`; the distinction matters because one
    // means "you own a bad blueprint" and the other "you own none".
    ownedBlueprint = { ...ownedBlueprint, me: 0 };
    await selectRifter();

    expect(document.getElementById('bpc-me').value).toBe('0');
  });

  test('an explicit ME overrides the owned value', async () => {
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001, meLevel: 3 });
    await settle(30);

    expect(document.getElementById('bpc-me').value).toBe('3');
  });

  test('renders total materials sorted by quantity', async () => {
    await selectRifter();

    const rows = document.querySelectorAll('#bpc-total-materials .bpc-mat-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.bpc-mat-name').textContent).toBe('Tritanium');
    expect(rows[0].querySelector('.bpc-mat-qty').textContent).toBe('5,000');
    expect(document.getElementById('bpc-total-mat-count').textContent).toBe('2');
  });

  test('product total tracks the runs input', async () => {
    await selectRifter();
    expect(document.getElementById('bpc-bp-total').textContent).toBe('1');

    const runs = document.getElementById('bpc-runs');
    runs.value = '25';
    runs.dispatchEvent(new window.Event('change'));
    await settle(30);

    expect(document.getElementById('bpc-bp-total').textContent).toBe('25');
  });

  test('passes the selected market set to the calculation', async () => {
    await selectRifter();

    const call = calls.filter((c) => c.fn === 'calculateMaterials').pop();
    // args: (typeId, runs, me, characterId, facilityId, marketSetId)
    expect(call.args[5]).toBe('set-jita');
    expect(call.args[4]).toBe('fac-1');
  });
});

/* -------------------------------------------------------------- pricing */

describe('pricing', () => {
  async function selectRifter() {
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);
  }

  test('renders cost, sell value and profit', async () => {
    await selectRifter();

    expect(document.getElementById('bpc-total-cost').textContent).toContain('59,923.25');
    expect(document.getElementById('bpc-sell-value').textContent).toContain('90,000.00');
    expect(document.getElementById('bpc-profit-value').textContent).toContain('30,076.75');
    expect(document.getElementById('bpc-profit-margin').textContent).toBe('33.42%');
  });

  test('a profit shows the profit styling, not the loss styling', async () => {
    await selectRifter();

    const box = document.getElementById('bpc-profit');
    expect(box.classList.contains('is-loss')).toBe(false);
    expect(document.getElementById('bpc-profit-label').textContent).toBe('Profit');
  });

  test('a loss flips the label and the modifier class (binding rule 3)', async () => {
    calcResult.pricing.profit = -5000;
    calcResult.pricing.profitMargin = -8.3;
    await selectRifter();

    const box = document.getElementById('bpc-profit');
    expect(box.classList.contains('is-loss')).toBe(true);
    expect(document.getElementById('bpc-profit-label').textContent).toBe('Loss');
    // Absolute value: the sign is carried by the label, not a minus sign.
    expect(document.getElementById('bpc-profit-value').textContent).toContain('5,000.00');
  });

  test('renders the fee breakdown from the job cost and taxes payloads', async () => {
    await selectRifter();

    const text = document.getElementById('bpc-fee-rows').textContent;
    expect(text).toContain('System Cost Index');
    expect(text).toContain('4.50%');
    expect(text).toContain('SCC Surcharge (4%)');
    expect(text).toContain('Broker Relations 4');
    expect(text).toContain('Accounting 4');
  });

  test('warns rather than silently dropping items without prices', async () => {
    calcResult.pricing.inputCosts.itemsWithoutPrices = 3;
    await selectRifter();

    const warning = calls.find((c) => c.fn === 'toast' && /missing price data/.test(c.message));
    expect(warning).toBeDefined();
    expect(warning.type).toBe('warning');
  });

  test('missing pricing renders placeholders instead of throwing', async () => {
    calcResult.pricing = null;
    await selectRifter();

    expect(document.getElementById('bpc-total-cost').textContent).toBe('—');
    expect(document.getElementById('bpc-profit-value').textContent).toBe('—');
  });

  /*
   * "No Facility (No Bonuses)" prices materials, taxes and sell value fine, but
   * the job installation fee comes from the SYSTEM cost index - with no
   * facility there is no system, so job cost is 0 and profit is optimistic.
   *
   * (Pricing used to be skipped entirely without a facility, leaving Cost/Fee/
   * Profit blank. That is fixed; this note is what keeps the now-populated
   * numbers honest.)
   */
  describe('no-facility incomplete-estimate note', () => {
    test('is hidden when a facility is selected', async () => {
      await selectRifter();

      expect(document.getElementById('bpc-no-facility-note').hidden).toBe(true);
    });

    test('is shown when no facility is selected', async () => {
      // No facilities configured -> nothing to default to -> facilityId null,
      // which is the same state the "No Facility (No Bonuses)" option produces.
      facilities = [];
      await selectRifter();

      expect(document.getElementById('bpc-no-facility-note').hidden).toBe(false);
    });

    test('says job cost is the missing piece and profit is overstated', async () => {
      facilities = [];
      await selectRifter();

      const text = document.getElementById('bpc-no-facility-note').textContent;
      // The specific reason, not a vague "results may be inaccurate".
      expect(text).toMatch(/job installation fee/i);
      expect(text).toMatch(/incomplete/i);
      // Direction of the error matters: real profit is LOWER.
      expect(text).toMatch(/lower/i);
    });

    test('the view CSS makes [hidden] win, so the note really is hidden', async () => {
      // jsdom does not apply stylesheets, so `el.hidden === true` passing proves
      // nothing about what the user sees - a stray `display` rule would leave it
      // on screen. Assert against the stylesheet text instead (CLAUDE.md 6a).
      const fs = require('fs');
      const path = require('path');
      const css = fs.readFileSync(
        path.join(__dirname, '../../public/blueprint-calculator-view.css'), 'utf8'
      );

      expect(css).toMatch(/#bpc-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    });

    test('stays hidden when pricing is unavailable entirely', async () => {
      // Nothing to qualify - the note would be noise on top of em-dashes.
      facilities = [];
      calcResult.pricing = null;
      await selectRifter();

      expect(document.getElementById('bpc-no-facility-note').hidden).toBe(true);
    });
  });
});

/* ------------------------------------------------------------- invention */

describe('invention', () => {
  async function openInvention() {
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);
    document.getElementById('bpc-tab-invention').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);
  }

  test('the invention tab is hidden when the blueprint cannot be invented', async () => {
    inventionData = { products: [] };
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);

    expect(document.getElementById('bpc-tab-invention').hidden).toBe(true);
  });

  test('shows a spinner instead of an empty skeleton while loading', async () => {
    // Regression: the panel was revealed immediately and filled in seconds
    // later, so opening the tab showed a fully drawn but empty screen.
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);

    // Hold the FIRST await in the invention path open, so the loading window is
    // observable. Gating on findBestDecryptor instead would not work: ~15
    // awaits run before it, so the test would have to guess a settle count -
    // and guessing low silently skips the whole assertion.
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const realGetInventionData = window.electronAPI.calculator.getInventionData;
    window.electronAPI.calculator.getInventionData = async (...args) => {
      await gate;
      return realGetInventionData(...args);
    };

    document.getElementById('bpc-tab-invention').dispatchEvent(new window.MouseEvent('click'));
    await settle(10);

    expect(document.getElementById('bpc-loading').hidden).toBe(false);
    expect(document.getElementById('bpc-panel-invention').hidden).toBe(true);

    release();
    await settle(40);

    expect(document.getElementById('bpc-loading').hidden).toBe(true);
    expect(document.getElementById('bpc-panel-invention').hidden).toBe(false);
  });

  test('a failed invention load still clears the spinner', async () => {
    allowErrors(/invention load failed/);
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);

    window.electronAPI.calculator.findBestDecryptor = async () => {
      throw new Error('decryptor exploded');
    };

    document.getElementById('bpc-tab-invention').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    // Without the `finally` this spins forever with nothing behind it.
    expect(document.getElementById('bpc-loading').hidden).toBe(true);
  });

  test('material prices are fetched in parallel, not one at a time', async () => {
    // The serial awaits were most of why this tab took seconds to fill in.
    let inFlight = 0;
    let maxInFlight = 0;
    window.electronAPI.market.calculatePrice = async (typeId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { price: 100 + typeId };
    };

    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);
    document.getElementById('bpc-tab-invention').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('renders the decryptor comparison with the best row badged', async () => {
    await openInvention();

    const rows = document.querySelectorAll('#bpc-decryptor-rows .bpc-dec-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].classList.contains('is-best')).toBe(true);
    expect(rows[1].querySelector('.bpc-dec-best-badge').textContent).toBe('BEST');
    expect(rows[0].querySelector('.bpc-dec-best-badge')).toBeNull();

    // Regression: every row rendered "No Decryptor" because the renderer read
    // `opt.decryptor.typeName`, which does not exist - the option carries
    // `name` directly. Counting rows passed the whole time; reading them did
    // not.
    expect(rows[0].querySelector('.bpc-dec-name').textContent).toContain('No Decryptor');
    expect(rows[1].querySelector('.bpc-dec-name').textContent).toContain('Accelerant Decryptor');
  });

  test('decryptor rows show the real stats, not undefined', async () => {
    await openInvention();

    const cells = document.querySelectorAll(
      '#bpc-decryptor-rows .bpc-dec-row:nth-child(2) .bpc-dec-cell'
    );
    // probability / runsPerBPC / finalME / finalTE - all previously read from
    // field names the backend never returns, rendering "NaN%" and "undefined".
    expect(cells[0].textContent).toBe('40.8%');
    expect(cells[1].textContent).toBe('11');
    expect(cells[2].textContent).toBe('4');
    expect(cells[3].textContent).toBe('6');

    const cost = document.querySelector(
      '#bpc-decryptor-rows .bpc-dec-row:nth-child(2) .bpc-dec-cost'
    );
    expect(cost.textContent).toContain('111,363');
  });

  test('the optimal panel reads the real best-option fields', async () => {
    await openInvention();

    const text = document.getElementById('bpc-inv-optimal-rows').textContent;
    expect(text).toContain('Accelerant Decryptor');
    expect(text).toContain('40.80%');
    expect(text).toContain('11');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  test('invention cost rows contain no undefined or NaN values', async () => {
    await openInvention();

    const costs = document.getElementById('bpc-inv-cost-rows').textContent;
    const output = document.getElementById('bpc-inv-output-rows').textContent;

    expect(costs).not.toMatch(/undefined|NaN/);
    expect(output).not.toMatch(/undefined|NaN/);
    // Attempts per success is derived as 1/p; the backend returns no such field.
    expect(costs).toContain('2.45');
    expect(costs).toContain('520,000.00');
  });

  test('the decryptor benefit block compares on fields noDecryptor actually has', async () => {
    await openInvention();

    // `noDecryptor` carries no costPerRun and no runs, so comparing on those
    // silently rendered nothing.
    const savings = document.getElementById('bpc-inv-savings');
    expect(savings.hidden).toBe(false);
    expect(savings.textContent).toContain('Saving / Item');
    expect(savings.textContent).not.toMatch(/undefined|NaN/);
  });

  test('clicking a decryptor row pins it, clicking again unpins', async () => {
    await openInvention();

    let rows = document.querySelectorAll('#bpc-decryptor-rows .bpc-dec-row');
    rows[0].dispatchEvent(new window.MouseEvent('click'));
    await settle();

    rows = document.querySelectorAll('#bpc-decryptor-rows .bpc-dec-row');
    expect(rows[0].classList.contains('is-selected')).toBe(true);

    rows[0].dispatchEvent(new window.MouseEvent('click'));
    await settle();

    rows = document.querySelectorAll('#bpc-decryptor-rows .bpc-dec-row');
    expect(rows[0].classList.contains('is-selected')).toBe(false);
  });

  test('the decryptor select stays in sync with the table', async () => {
    await openInvention();

    const select = document.getElementById('bpc-inv-decryptor');
    // Auto entry plus one per option.
    expect(select.options).toHaveLength(3);
    expect(select.options[0].textContent).toContain('Optimal Decryptor');
    expect(select.value).toBe('');

    document
      .querySelectorAll('#bpc-decryptor-rows .bpc-dec-row')[0]
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(document.getElementById('bpc-inv-decryptor').value).toBe('0');
  });

  test('changing strategy recalculates', async () => {
    await openInvention();
    const before = calls.filter((c) => c.fn === 'findBestDecryptor').length;

    const select = document.getElementById('bpc-inv-strategy');
    select.value = 'invention-only';
    select.dispatchEvent(new window.Event('change'));
    await settle(40);

    const after = calls.filter((c) => c.fn === 'findBestDecryptor');
    expect(after.length).toBeGreaterThan(before);
    // Strategy is the 6th argument, market set the 7th. These are positional
    // all the way down to the engine, so an extra argument here silently
    // shifts the market set into a parameter that no longer exists - which is
    // exactly what the removed customVolume slot used to occupy.
    const sent = after[after.length - 1].args;
    expect(sent).toHaveLength(7);
    expect(sent[5]).toBe('invention-only');
  });

  test('renders skills and datacore costs', async () => {
    await openInvention();

    const skills = document.getElementById('bpc-inv-skill-rows').textContent;
    expect(skills).toContain('Encryption Methods');
    expect(skills).toContain('Mechanical Engineering');

    // 2 datacores at the stubbed unit price (100 + typeId = 20510).
    expect(document.getElementById('bpc-inv-datacore-total').textContent).toContain('41,020.00');
  });
});

/* ----------------------------------------------------------- add to plan */

describe('add to plan', () => {
  async function openModal() {
    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);
    document.getElementById('bpc-add-to-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle();
  }

  test('lists existing plans plus a create-new option', async () => {
    await openModal();

    const options = document.querySelectorAll('#bpc-plan-options .bpc-plan-option');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain('Q3 Frigates');
    expect(options[2].textContent).toContain('Create New Plan');
  });

  test('selecting an existing plan adds the blueprint with the current config', async () => {
    await openModal();

    document.querySelectorAll('#bpc-plan-options .bpc-plan-option')[0].dispatchEvent(
      new window.MouseEvent('click')
    );
    document.getElementById('bpc-plan-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const call = calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(call.planId).toBe('plan-1');
    expect(call.config.blueprintTypeId).toBe(1001);
    expect(call.config.meLevel).toBe(7);
    expect(call.config.facilityId).toBe('fac-1');
    expect(call.config.facilitySnapshot.name).toBe('Jita Raitaru');

    // The handler destructures `lines`; `productionLines` was never read.
    expect(call.config.lines).toBe(1);
    expect(call.config.productionLines).toBeUndefined();
  });

  test('choosing "new" reveals the name field and creates a plan', async () => {
    await openModal();

    const newOption = document.querySelectorAll('#bpc-plan-options .bpc-plan-option')[2];
    expect(document.getElementById('bpc-new-plan-section').hidden).toBe(true);

    newOption.dispatchEvent(new window.MouseEvent('click'));
    expect(document.getElementById('bpc-new-plan-section').hidden).toBe(false);

    document.getElementById('bpc-new-plan-name').value = 'Fresh Batch';
    document.getElementById('bpc-plan-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(calls.find((c) => c.fn === 'plans.create').name).toBe('Fresh Batch');
    expect(calls.find((c) => c.fn === 'plans.addBlueprint').planId).toBe('plan-new');
  });

  test('confirming without a selection warns instead of throwing', async () => {
    await openModal();

    document.getElementById('bpc-plan-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.addBlueprint')).toBe(false);
  });

  test('Escape closes the modal', async () => {
    await openModal();
    expect(document.getElementById('bpc-plan-modal').hidden).toBe(false);

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('bpc-plan-modal').hidden).toBe(true);
  });

  test('reopening rebuilds options so a stale closure cannot target the wrong plan', async () => {
    await openModal();
    document.querySelectorAll('#bpc-plan-options .bpc-plan-option')[0].dispatchEvent(
      new window.MouseEvent('click')
    );
    document.getElementById('bpc-plan-cancel').dispatchEvent(new window.MouseEvent('click'));

    // Second open, different plan picked.
    document.getElementById('bpc-add-to-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document.querySelectorAll('#bpc-plan-options .bpc-plan-option')[1].dispatchEvent(
      new window.MouseEvent('click')
    );
    document.getElementById('bpc-plan-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const addCalls = calls.filter((c) => c.fn === 'plans.addBlueprint');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].planId).toBe('plan-2');
  });
});

/* -------------------------------------------------------------- lifecycle */

describe('lifecycle', () => {
  test('mount subscribes exactly once per channel', async () => {
    await mountView();
    await settle();

    expect(subscribers['calculator:openBlueprint']).toHaveLength(1);
    expect(subscribers['default-character-changed']).toHaveLength(1);
  });

  test('unmount disposes every subscription', async () => {
    const { ctx } = await mountView();
    await settle();

    ctx.dispose();

    expect(disposed['calculator:openBlueprint']).toBe(1);
    expect(disposed['default-character-changed']).toBe(1);
    expect(subscribers['calculator:openBlueprint']).toHaveLength(0);
  });

  test('remounting leaves exactly one live subscription, not two', async () => {
    // The regression this whole lifecycle block exists for: the legacy page
    // discarded its disposers, so a second mount would have fired every handler
    // twice - loading the blueprint twice on a single event.
    const first = await mountView();
    await settle();
    first.ctx.dispose();

    document.body.innerHTML = '';
    const second = await mountView();
    await settle();

    expect(subscribers['calculator:openBlueprint']).toHaveLength(1);
    expect(subscribers['default-character-changed']).toHaveLength(1);
    second.ctx.dispose();
  });

  test('destroy tears down the QFSearchSelect instances', async () => {
    const { instance } = await mountView();
    await settle();

    // Each instance owns a document listener and can attach a popover to
    // <body>, so dropping the container is not enough.
    const spy = jest.spyOn(document, 'removeEventListener');
    instance.destroy();

    expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    spy.mockRestore();
  });

  test('opening a blueprint via mount params needs no follow-up event', async () => {
    // This is what replaced the 500ms race: the router passes the blueprint as
    // a mount parameter, so there is no window where the event can arrive
    // before a listener exists.
    await mountView({ blueprintTypeId: 1001, meLevel: 4 });
    await settle(30);

    expect(document.getElementById('bpc-bp-name').textContent).toBe('Rifter Blueprint');
    expect(document.getElementById('bpc-me').value).toBe('4');
  });
});

/* ------------------------------------------------------------- resilience */

describe('resilience', () => {
  test('a failing facility load does not prevent the view from mounting', async () => {
    allowErrors(/load failed: facilities/);
    window.electronAPI.facilities.getFacilities = async () => {
      throw new Error('facilities exploded');
    };

    const { container } = await mountView();
    await settle();

    expect(container.querySelector('#bpc-view')).not.toBeNull();
    expect(document.querySelector('#bpc-market-host .qf-ss-trigger')).not.toBeNull();
  });

  test('a calculation failure surfaces a toast rather than a blank view', async () => {
    allowErrors(/calculate failed/);
    window.electronAPI.calculator.calculateMaterials = async () => {
      throw new Error('calc exploded');
    };

    await mountView();
    await settle();
    subscribers['calculator:openBlueprint'][0]({ blueprintTypeId: 1001 });
    await settle(30);

    expect(calls.some((c) => c.fn === 'toast' && c.type === 'error')).toBe(true);
    expect(document.getElementById('bpc-loading').hidden).toBe(true);
  });
});
