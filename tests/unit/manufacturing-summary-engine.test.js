/**
 * Manufacturing Summary calculation engine.
 *
 * This code was MOVED out of manufacturing-summary-renderer.js, not rewritten,
 * which makes transcription error the dominant risk. Three formulas were in
 * fact transcribed wrong during this port before being caught by re-reading the
 * source:
 *
 *   - calculateMarketHealthScore  (wrong caps, weights AND output range)
 *   - calculateMaterialCostVolatility  (per-material mean vs weighted basket)
 *   - determineTechLevel  (invented labels; the real ones are 'Storyline',
 *     'Navy', 'Pirate', and structure meta groups 52/53/54 were missing)
 *
 * That last one is the nastiest kind: the Tech Level filter chips compare these
 * strings, so a wrong label silently makes a filter match nothing. So the first
 * block re-implements each original independently and asserts equality.
 *
 * Fixtures use the REAL shapes, verified against blueprint-pricing.js:
 *   pricing.jobCostBreakdown -> { jobBaseCost, facilityTax, sccSurcharge, totalJobCost }
 *   pricing.taxesBreakdown   -> { materialBrokerFee, productSalesTax, productBrokerFee, totalTaxes }
 *   pricing.outputValue      -> { totalValue }   (an OBJECT, not a number)
 *   pricing                  -> { totalCosts, profit, profitMargin, ... }
 */

/* --------------------------------------------------------------- mocks --- */

const mockCalculateBlueprintMaterials = jest.fn();
const mockGetAllBlueprints = jest.fn();
const mockGetInventionData = jest.fn();
const mockFetchMarketHistory = jest.fn();
const mockFetchMarketOrders = jest.fn();
const mockGetItemVolumes = jest.fn();
const mockGetBlueprints = jest.fn();
const mockGetCharacters = jest.fn();
const mockGetDefaultCharacter = jest.fn();
const mockGetManufacturingFacility = jest.fn();
const mockResolveLocationInfoMany = jest.fn(async () => ({}));

jest.mock('../../src/main/blueprint-calculator', () => ({
  calculateBlueprintMaterials: mockCalculateBlueprintMaterials,
  getAllBlueprints: mockGetAllBlueprints,
  getAllReactions: jest.fn(async () => []),
  getInventionData: mockGetInventionData,
}));

jest.mock('../../src/main/settings-manager', () => ({
  getMarketSetById: jest.fn(() => ({ id: 'set-1', name: 'Jita', inputMaterials: { regionId: 10000002 } })),
  getDefaultMarketSet: jest.fn(() => ({ id: 'set-1', name: 'Jita', inputMaterials: { regionId: 10000002 } })),
  getManufacturingFacility: mockGetManufacturingFacility,
  getCharacters: mockGetCharacters,
  getDefaultCharacter: mockGetDefaultCharacter,
  getBlueprints: mockGetBlueprints,
}));

jest.mock('../../src/main/sde-database', () => ({
  getSystemSecurityStatus: jest.fn(async () => 0.9),
  getStructureBonuses: jest.fn(async () => ({ timeEfficiency: 15, materialEfficiency: 1 })),
  getItemVolumes: mockGetItemVolumes,
}));

jest.mock('../../src/main/esi-market', () => ({
  fetchMarketHistory: mockFetchMarketHistory,
  fetchMarketOrders: mockFetchMarketOrders,
}));

jest.mock('../../src/main/location-resolver', () => ({
  resolveLocationInfoMany: mockResolveLocationInfoMany,
}));

const engine = require('../../src/main/manufacturing-summary');

/* ------------------------------------------------------------ fixtures --- */

function makeHistory(days, volumeFor, averageFor) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({
      date: d.toISOString().slice(0, 10),
      volume: volumeFor(i),
      average: averageFor(i),
    });
  }
  return out;
}

const HISTORY = makeHistory(40, () => 1000, () => 100);

/** A pricing result in the exact shape blueprint-pricing.js returns. */
function makePricing(overrides = {}) {
  return {
    inputCosts: { totalCost: 800000 },
    outputValue: { totalValue: 1500000 },
    jobCostBreakdown: {
      jobBaseCost: 40000, facilityTax: 5000, sccSurcharge: 2000, totalJobCost: 47000,
    },
    taxesBreakdown: {
      materialBrokerFee: 24000,
      productSalesTax: 33750,
      productBrokerFee: 45000,
      totalTaxes: 102750,
    },
    salesTax: 102750,
    totalCosts: 949750,
    profit: 550250,
    profitMargin: 36.68,
    jobCost: 47000,
    ...overrides,
  };
}

function makeBlueprint(overrides = {}) {
  return {
    typeID: 22545,
    typeName: 'Hulk Blueprint',
    productTypeID: 22544,
    productName: 'Hulk',
    productMetaGroupID: 2,
    baseTime: 36000,
    category: 'Ships',
    ...overrides,
  };
}

const FACILITY = {
  id: 'fac-1',
  name: 'Sotiyo',
  systemId: 30000142,
  structureTypeId: 35827,
  structureBonuses: { timeEfficiency: 15 },
};

beforeEach(() => {
  jest.clearAllMocks();

  mockGetManufacturingFacility.mockReturnValue({ ...FACILITY });
  mockGetDefaultCharacter.mockReturnValue({ characterId: 91316135 });
  mockGetCharacters.mockReturnValue([{ characterId: 91316135 }]);
  mockGetBlueprints.mockReturnValue([]);
  mockGetAllBlueprints.mockResolvedValue([makeBlueprint()]);
  mockGetInventionData.mockResolvedValue(null);
  mockFetchMarketHistory.mockResolvedValue(HISTORY);
  mockFetchMarketOrders.mockResolvedValue([
    { is_buy_order: false, volume_remain: 5000 },
    { is_buy_order: true, volume_remain: 9999 },
  ]);
  mockGetItemVolumes.mockResolvedValue({ 34: 0.01, 22544: 3750 });
  // clearAllMocks wipes implementations, so the default has to be re-applied
  // here or the second test onward gets `undefined` back and throws.
  mockResolveLocationInfoMany.mockResolvedValue({});
  mockCalculateBlueprintMaterials.mockResolvedValue({
    materials: { 34: 1000000 },
    product: { quantity: 1 },
    pricing: makePricing(),
    breakdown: [{ intermediateComponents: [] }],
  });
});

/* ---------------------------------------------------- parity with source --- */

describe('parity with the original renderer formulas', () => {
  // Independent re-implementations, transcribed from the renderer source.

  function originalProductionTime(baseTime, teLevel, facility) {
    if (!baseTime) return 0;
    let time = baseTime * (1 - (teLevel / 100));
    if (facility && facility.structureBonuses && facility.structureBonuses.timeEfficiency) {
      time = time * (1 - (facility.structureBonuses.timeEfficiency / 100));
    }
    return time;
  }

  function originalTechLevel(blueprint) {
    switch (blueprint.productMetaGroupID) {
      case 2:
      case 53:
        return 'T2';
      case 14:
        return 'T3';
      case 3:
        return 'Storyline';
      case 4:
      case 52:
        return 'Navy';
      case 5:
      case 6:
        return 'Pirate';
      case 1:
      case 54:
      default:
        return 'T1';
    }
  }

  test.each([
    [36000, 0, null],
    [36000, 20, null],
    [36000, 20, FACILITY],
    [36000, 0, FACILITY],
    [0, 20, FACILITY],
    [null, 20, FACILITY],
  ])('production time (base=%p te=%p)', (baseTime, teLevel, facility) => {
    expect(engine.calculateProductionTime(baseTime, teLevel, facility))
      .toBe(originalProductionTime(baseTime, teLevel, facility));
  });

  test.each([1, 2, 3, 4, 5, 6, 14, 52, 53, 54, 99, undefined])(
    'tech level for meta group %p',
    (metaGroupID) => {
      const bp = makeBlueprint({ productMetaGroupID: metaGroupID });
      expect(engine.determineTechLevel(bp)).toBe(originalTechLevel(bp));
    }
  );

  test('meta group 3 is Storyline, NOT T3', () => {
    // The exact mistake made during the port. T3 is meta group 14.
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 3 }))).toBe('Storyline');
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 14 }))).toBe('T3');
  });

  test('faction and officer collapse to Navy and Pirate', () => {
    // 'Faction'/'Officer'/'Deadspace' were invented; the filter chips compare
    // these strings, so a wrong label makes a chip match nothing.
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 4 }))).toBe('Navy');
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 52 }))).toBe('Navy');
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 5 }))).toBe('Pirate');
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 6 }))).toBe('Pirate');
  });

  test('structure meta groups are handled, not defaulted', () => {
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 53 }))).toBe('T2');
    expect(engine.determineTechLevel(makeBlueprint({ productMetaGroupID: 54 }))).toBe('T1');
  });

  /* --------------------------------------------------- category parity --- */

  // Independent transcription of the renderer's determineCategory. Its branch
  // ORDER is the load-bearing part, so this is written as the original chain
  // rather than a lookup table.
  function originalCategory(blueprint) {
    const sdeCategory = blueprint.productCategoryName || '';
    const sdeGroup = blueprint.productGroupName || '';

    if (sdeCategory === 'Ship') return 'Ships';
    if (sdeCategory === 'Drone') return 'Drones';
    if (sdeCategory === 'Fighter') return 'Drones';
    if (sdeGroup && sdeGroup.includes('Rig')) {
      if (sdeCategory === 'Structure' || (sdeGroup && sdeGroup.includes('Structure'))) {
        return 'Structure Rigs';
      }
      return 'Rigs';
    }
    if (sdeCategory === 'Module') return 'Modules';
    if (sdeCategory === 'Charge') return 'Ammo/Charges';
    if (sdeCategory === 'Subsystem') return 'Subsystems';
    if (sdeCategory === 'Deployable') return 'Deployables';
    if (sdeCategory === 'Structure Module') return 'Structure Modules';
    if (sdeCategory === 'Structure') return 'Structures';
    if (sdeCategory === 'Implant' && sdeGroup && sdeGroup.includes('Booster')) return 'Boosters';
    if (sdeCategory === 'Reaction') return 'Reactions';
    if (sdeCategory === 'Celestial' || sdeCategory === 'Starbase' || sdeCategory === 'Station') {
      return 'Celestials';
    }
    if (sdeCategory === 'Material' || sdeCategory === 'Commodity') return 'Components';
    return 'Components';
  }

  test.each([
    ['Ship', 'Battleship'],
    ['Drone', 'Combat Drone'],
    ['Fighter', 'Light Fighter'],
    ['Module', 'Shield Rig'],          // rig check must beat the Module check
    ['Structure', 'Structure Rig'],
    ['Module', 'Structure Rig'],       // group alone is enough for Structure Rigs
    ['Module', 'Afterburner'],
    ['Charge', 'Hybrid Charge'],
    ['Subsystem', 'Offensive'],
    ['Deployable', 'Mobile Depot'],
    ['Structure Module', 'Service'],
    ['Structure', 'Citadel'],
    ['Implant', 'Booster'],
    ['Implant', 'Cyber Learning'],     // Implant WITHOUT Booster is not a Booster
    ['Reaction', 'Composite'],
    ['Celestial', 'Wormhole'],
    ['Starbase', 'Control Tower'],
    ['Station', 'Station'],
    ['Material', 'Mineral'],
    ['Commodity', 'Trade Good'],
    ['', ''],
    ['Nonsense', 'Nonsense'],
  ])('category for %p / %p', (productCategoryName, productGroupName) => {
    const bp = makeBlueprint({ productCategoryName, productGroupName });
    expect(engine.determineCategory(bp)).toBe(originalCategory(bp));
  });

  test('rigs are detected before modules, not after', () => {
    // Rigs live in the Module category, so testing Module first would swallow
    // every rig and the Rigs chip would match nothing.
    expect(engine.determineCategory(makeBlueprint({
      productCategoryName: 'Module', productGroupName: 'Projectile Weapon Rig',
    }))).toBe('Rigs');
  });

  test('unrecognised products fall back to Components rather than vanishing', () => {
    // A blueprint that matched no chip would be invisible in every result set
    // with no way for the user to tell why.
    expect(engine.determineCategory(makeBlueprint({
      productCategoryName: 'Something New', productGroupName: '',
    }))).toBe('Components');
  });
});

/* ------------------------------------------------ pre-calculation filters --- */

describe('chip filters narrow what gets costed', () => {
  const bps = [
    makeBlueprint({ typeID: 1, productMetaGroupID: 1, productCategoryName: 'Ship' }),
    makeBlueprint({ typeID: 2, productMetaGroupID: 2, productCategoryName: 'Ship' }),
    makeBlueprint({ typeID: 3, productMetaGroupID: 1, productCategoryName: 'Reaction' }),
  ];

  test('keeps only the selected tech levels', () => {
    const out = engine.applyChipFilters(bps, ['T2'], null);
    expect(out.map((b) => b.typeID)).toEqual([2]);
  });

  test('keeps only the selected categories', () => {
    const out = engine.applyChipFilters(bps, null, ['Reactions']);
    expect(out.map((b) => b.typeID)).toEqual([3]);
  });

  test('applies both together', () => {
    const out = engine.applyChipFilters(bps, ['T1'], ['Ships']);
    expect(out.map((b) => b.typeID)).toEqual([1]);
  });

  test('omitting the lists means no filtering, not nothing selected', () => {
    // Older payloads and tests do not send these; defaulting to "nothing
    // matches" would silently return an empty summary.
    expect(engine.applyChipFilters(bps, null, null)).toHaveLength(3);
    expect(engine.applyChipFilters(bps, [], [])).toHaveLength(3);
  });
});

describe('market thresholds drop rows after costing', () => {
  const rows = [
    { svr: 5, iskPerHour: 900000, profit: 50000 },
    { svr: 0.2, iskPerHour: 1000, profit: -200 },
  ];

  test('the SVR threshold needs no enable flag', () => {
    expect(engine.applyMarketThresholds(rows, { svrThreshold: 1 })).toHaveLength(1);
  });

  test('IPH and profit thresholds are ignored while their toggle is off', () => {
    // Their values persist in the UI when unticked, so honouring them without
    // the flag would filter by a threshold the user had switched off.
    expect(engine.applyMarketThresholds(rows, { iphThreshold: 100000 })).toHaveLength(2);
    expect(engine.applyMarketThresholds(rows, {
      iphEnabled: true, iphThreshold: 100000,
    })).toHaveLength(1);
  });

  test('a zero threshold is honoured, not treated as unset', () => {
    // 0 is a real choice ("anything not loss-making"); a truthiness check here
    // would silently ignore it.
    expect(engine.applyMarketThresholds(rows, {
      profitEnabled: true, profitThreshold: 0,
    })).toHaveLength(1);
  });

  test('no thresholds means every row survives', () => {
    expect(engine.applyMarketThresholds(rows, {})).toHaveLength(2);
  });
});

/* ------------------------------------------------------- corp detection --- */

describe('corporation blueprint detection', () => {
  test('the isCorporation flag wins', () => {
    expect(engine.isCorporationBlueprint({ isCorporation: true })).toBe(true);
  });

  test.each(['CorpSAG1', 'CorpSAG7', 'CorpDeliveries'])(
    'the %s location flag implies corp ownership',
    (locationFlag) => {
      // ESI does not always set isCorporation, so the flag is the fallback.
      expect(engine.isCorporationBlueprint({ isCorporation: false, locationFlag })).toBe(true);
    }
  );

  test('a personal hangar is not corp', () => {
    expect(engine.isCorporationBlueprint({ locationFlag: 'Hangar' })).toBe(false);
    expect(engine.isCorporationBlueprint({})).toBe(false);
  });
});

/* ------------------------------------------------------------ row build --- */

describe('calculateBlueprintRow', () => {
  const context = {
    facility: FACILITY,
    marketSet: { id: 'set-1', inputMaterials: { regionId: 10000002 } },
    characterId: 91316135,
    svrPeriod: 30,
    regionId: 10000002,
    locationFilter: null,
  };

  test('reads each fee from the RIGHT breakdown structure', async () => {
    // These come from two different objects, and mixing them up would produce
    // plausible-looking but wrong fee columns.
    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);

    expect(row.jobCosts).toBe(40000 + 5000 + 2000);
    expect(row.materialPurchaseFees).toBe(24000);
    expect(row.productSellingFees).toBe(33750 + 45000);
    expect(row.tradingFeesTotal).toBe(33750 + 45000 + 24000);
  });

  test('outputValue is an OBJECT - the price comes from .totalValue', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);
    expect(row.productMarketPrice).toBe(1500000);
  });

  test('name and category describe the PRODUCT, not the blueprint', async () => {
    // The summary answers "what can I build", so the row has to name the
    // thing being built. Using the blueprint's own typeName/groupName put
    // "Hulk Blueprint" / "Mining Barge Blueprint" on every row - the word
    // Blueprint repeated for no information.
    const row = await engine.calculateBlueprintRow(makeBlueprint({
      typeName: 'Hulk Blueprint',
      productName: 'Hulk',
      category: 'Mining Barge Blueprint',
      productGroupName: 'Mining Barge',
    }), context);

    expect(row.itemName).toBe('Hulk');
    expect(row.category).toBe('Mining Barge');
    // The blueprint's own name stays available for anything that needs it.
    expect(row.blueprintName).toBe('Hulk Blueprint');
  });

  test('a speculative row is BPC (Invented), not N/A', async () => {
    // 'N/A' is what an UNOWNED blueprint reports. A speculative T2 is one you
    // would invent - saying N/A hid the entire point of the feature.
    const row = await engine.calculateBlueprintRow(
      makeBlueprint({ isSpeculativeInvention: true, _owned: null }), context
    );

    expect(row.bpType).toBe('BPC (Invented)');
    expect(row.isSpeculative).toBe(true);
    expect(row.inventionStatus).toBe('Speculative');
  });

  test('a normal unowned row is still N/A', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint({ _owned: null }), context);

    expect(row.bpType).toBe('N/A');
    expect(row.isSpeculative).toBe(false);
    expect(row.inventionStatus).toBeNull();
  });

  test('owner and location ids come from the owned row', async () => {
    // These were never emitted at all, so both columns rendered blank for
    // every row regardless of what the user owned.
    const row = await engine.calculateBlueprintRow(makeBlueprint({
      _owned: {
        typeId: 22545, characterId: 91316135, locationId: 60003760,
        isCorporation: false, isCopy: true,
      },
    }), context);

    expect(row.ownerCharacterId).toBe(91316135);
    expect(row.locationId).toBe(60003760);
  });

  test('a speculative row has no owner or location', async () => {
    const row = await engine.calculateBlueprintRow(
      makeBlueprint({ isSpeculativeInvention: true, _owned: null }), context
    );

    expect(row.ownerCharacterId).toBeNull();
    expect(row.locationId).toBeNull();
  });

  test('falls back to the blueprint name when the product has none', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint({
      typeName: 'Mystery Blueprint',
      productName: undefined,
      productGroupName: undefined,
      category: 'Some Group',
    }), context);

    expect(row.itemName).toBe('Mystery Blueprint');
    expect(row.category).toBe('Some Group');
  });

  test('ISK/hour uses the TE- and structure-adjusted production time', async () => {
    const owned = { typeId: 22545, materialEfficiency: 10, timeEfficiency: 20 };
    const row = await engine.calculateBlueprintRow(
      makeBlueprint({ _owned: owned }), context
    );

    // 36000s, -20% TE, -15% structure = 24480s = 6.8h
    const expectedHours = (36000 * 0.8 * 0.85) / 3600;
    expect(row.productionTimeHours).toBeCloseTo(expectedHours, 6);
    expect(row.iskPerHour).toBeCloseTo(550250 / expectedHours, 6);
  });

  test('ROI is profit over total cost as a percentage', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);
    expect(row.roi).toBeCloseTo((550250 / 949750) * 100, 6);
  });

  test('an unowned blueprint reports ME/TE 0 and BP type N/A', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);
    expect(row.isOwned).toBe(false);
    expect(row.meLevel).toBe(0);
    expect(row.teLevel).toBe(0);
    expect(row.bpType).toBe('N/A');
  });

  test('an owned blueprint carries its ME/TE and copy status', async () => {
    const owned = { typeId: 22545, materialEfficiency: 10, timeEfficiency: 20, isCopy: true };
    const row = await engine.calculateBlueprintRow(makeBlueprint({ _owned: owned }), context);

    expect(row.isOwned).toBe(true);
    expect(row.meLevel).toBe(10);
    expect(row.teLevel).toBe(20);
    expect(row.bpType).toBe('BPC');
  });

  test('manufacturing steps counts the blueprint plus its intermediates', async () => {
    mockCalculateBlueprintMaterials.mockResolvedValue({
      materials: { 34: 1000 },
      product: { quantity: 1 },
      pricing: makePricing(),
      breakdown: [{ intermediateComponents: [{ typeId: 1 }, { typeId: 2 }] }],
    });

    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);
    expect(row.manufacturingSteps).toBe(3);
  });

  test('input volume is quantity-weighted across the material list', async () => {
    mockCalculateBlueprintMaterials.mockResolvedValue({
      materials: { 34: 1000000 },
      product: { quantity: 1 },
      pricing: makePricing(),
      breakdown: [],
    });
    mockGetItemVolumes.mockResolvedValue({ 34: 0.01, 22544: 3750 });

    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);
    expect(row.m3Inputs).toBeCloseTo(1000000 * 0.01, 6);
    expect(row.m3Outputs).toBeCloseTo(3750 * 1, 6);
  });

  test('returns null when the blueprint cannot be priced', async () => {
    mockCalculateBlueprintMaterials.mockResolvedValue({ materials: {}, pricing: null });
    expect(await engine.calculateBlueprintRow(makeBlueprint(), context)).toBeNull();
  });
});

/* ------------------------------------------------- the batching guarantee --- */

describe('history is read ONCE per product', () => {
  // The reason the engine was extracted. The renderer called six functions per
  // blueprint that each re-fetched the same product history - ~1,200 calls on a
  // 200-blueprint run instead of ~200.

  const context = {
    facility: FACILITY,
    marketSet: { id: 'set-1', inputMaterials: { regionId: 10000002 } },
    characterId: 91316135,
    svrPeriod: 30,
    regionId: 10000002,
    locationFilter: null,
  };

  test('one product history fetch, not six', async () => {
    mockCalculateBlueprintMaterials.mockResolvedValue({
      materials: {},           // no materials, so no material-volatility reads
      product: { quantity: 1 },
      pricing: makePricing(),
      breakdown: [],
    });

    await engine.calculateBlueprintRow(makeBlueprint(), context);

    const productFetches = mockFetchMarketHistory.mock.calls
      .filter(([, typeId]) => typeId === 22544);
    expect(productFetches).toHaveLength(1);
  });

  test('every product metric is present from that single read', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);

    ['svr', 'profitVelocity', 'marketSaturation', 'priceMomentum',
      'profitStability', 'demandGrowth', 'marketHealthScore', 'currentSellOrders']
      .forEach((field) => {
        expect(row[field]).toBeDefined();
      });
  });

  test('sell volume ignores buy orders', async () => {
    const row = await engine.calculateBlueprintRow(makeBlueprint(), context);
    expect(row.currentSellOrders).toBe(5000);
  });

  test('material volatility reads the MATERIALS, not the product', async () => {
    mockCalculateBlueprintMaterials.mockResolvedValue({
      materials: { 34: 1000, 35: 500 },
      product: { quantity: 1 },
      pricing: makePricing(),
      breakdown: [],
    });

    await engine.calculateBlueprintRow(makeBlueprint(), context);

    const fetched = mockFetchMarketHistory.mock.calls.map(([, typeId]) => typeId);
    expect(fetched).toContain(34);
    expect(fetched).toContain(35);
  });
});

/* ----------------------------------------------------------- selection --- */

describe('blueprint selection', () => {
  test('"all" returns every SDE blueprint', async () => {
    mockGetAllBlueprints.mockResolvedValue([
      makeBlueprint({ typeID: 1 }), makeBlueprint({ typeID: 2 }),
    ]);

    const selected = await engine.selectBlueprints({ blueprintFilter: 'all' });
    expect(selected).toHaveLength(2);
  });

  test('"owned" keeps only blueprints the character holds', async () => {
    mockGetAllBlueprints.mockResolvedValue([
      makeBlueprint({ typeID: 22545 }), makeBlueprint({ typeID: 99999 }),
    ]);
    mockGetBlueprints.mockReturnValue([
      { typeId: 22545, materialEfficiency: 10, locationFlag: 'Hangar' },
    ]);

    const selected = await engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'all',
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].typeID).toBe(22545);
  });

  test('the owned row is attached, so pricing need not look it up again', async () => {
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint({ typeID: 22545 })]);
    mockGetBlueprints.mockReturnValue([
      { typeId: 22545, materialEfficiency: 7, timeEfficiency: 14, locationFlag: 'Hangar' },
    ]);

    const [selected] = await engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'all',
    });

    expect(selected._owned).toMatchObject({ materialEfficiency: 7, timeEfficiency: 14 });
  });

  test('"corp" and "owned" are complements', async () => {
    mockGetAllBlueprints.mockResolvedValue([
      makeBlueprint({ typeID: 1 }), makeBlueprint({ typeID: 2 }),
    ]);
    mockGetBlueprints.mockReturnValue([
      { typeId: 1, locationFlag: 'Hangar' },
      { typeId: 2, locationFlag: 'CorpSAG2' },
    ]);

    const owned = await engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'all',
    });
    const corp = await engine.selectBlueprints({
      blueprintFilter: 'corp', characterFilter: 'all',
    });

    expect(owned.map((b) => b.typeID)).toEqual([1]);
    expect(corp.map((b) => b.typeID)).toEqual([2]);
  });

  test('a specific character with no id selected is an error, not silent empty', async () => {
    await expect(engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'specific', characterId: null,
    })).rejects.toThrow(/[Ss]elect a character/);
  });

  test('no default character is an error, not silent empty', async () => {
    mockGetDefaultCharacter.mockReturnValue(null);
    await expect(engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'default',
    })).rejects.toThrow(/default character/);
  });
});

describe('speculative invention', () => {
  test('adds the T2 blueprint invented from a selected T1', async () => {
    const t1 = makeBlueprint({ typeID: 100, productMetaGroupID: 1, typeName: 'Ferox Blueprint' });
    const t2 = makeBlueprint({ typeID: 200, productMetaGroupID: 2, typeName: 'Ferox Navy Blueprint' });

    mockGetAllBlueprints.mockResolvedValue([t1, t2]);
    mockGetBlueprints.mockReturnValue([{ typeId: 100, locationFlag: 'Hangar' }]);
    mockGetInventionData.mockResolvedValue({ t2BlueprintTypeID: 200 });

    const selected = await engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'all', speculativeInvention: true,
    });

    const added = selected.find((bp) => bp.typeID === 200);
    expect(added).toBeDefined();
    expect(added.isSpeculativeInvention).toBe(true);
    expect(added.parentT1BlueprintTypeID).toBe(100);
  });

  test('does not duplicate a T2 already in the list', async () => {
    const t1 = makeBlueprint({ typeID: 100, productMetaGroupID: 1 });
    const t2 = makeBlueprint({ typeID: 200, productMetaGroupID: 2 });

    mockGetAllBlueprints.mockResolvedValue([t1, t2]);
    mockGetBlueprints.mockReturnValue([
      { typeId: 100, locationFlag: 'Hangar' },
      { typeId: 200, locationFlag: 'Hangar' },
    ]);
    mockGetInventionData.mockResolvedValue({ t2BlueprintTypeID: 200 });

    const selected = await engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'all', speculativeInvention: true,
    });

    expect(selected.filter((bp) => bp.typeID === 200)).toHaveLength(1);
  });

  test('only T1 blueprints are considered for invention', async () => {
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint({ typeID: 200, productMetaGroupID: 2 })]);
    mockGetBlueprints.mockReturnValue([{ typeId: 200, locationFlag: 'Hangar' }]);

    await engine.selectBlueprints({
      blueprintFilter: 'owned', characterFilter: 'all', speculativeInvention: true,
    });

    expect(mockGetInventionData).not.toHaveBeenCalled();
  });

  test('is off unless asked for', async () => {
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint({ typeID: 100, productMetaGroupID: 1 })]);
    mockGetBlueprints.mockReturnValue([{ typeId: 100, locationFlag: 'Hangar' }]);

    await engine.selectBlueprints({ blueprintFilter: 'owned', characterFilter: 'all' });

    expect(mockGetInventionData).not.toHaveBeenCalled();
  });

  test('a speculative T2 must still pass the TECH chips', async () => {
    // The tech filter has to run AFTER the T2s are added - that is the whole
    // point of adding them. Filtering first would leave speculative T2s in the
    // results with T2 deselected.
    const t1 = makeBlueprint({ typeID: 100, productMetaGroupID: 1, productCategoryName: 'Ship' });
    const t2 = makeBlueprint({ typeID: 200, productMetaGroupID: 2, productCategoryName: 'Ship' });

    mockGetAllBlueprints.mockResolvedValue([t1, t2]);
    mockGetBlueprints.mockReturnValue([{ typeId: 100, locationFlag: 'Hangar' }]);
    mockGetInventionData.mockResolvedValue({ t2BlueprintTypeID: 200 });

    const selected = await engine.selectBlueprints({
      blueprintFilter: 'owned',
      characterFilter: 'all',
      speculativeInvention: true,
      techLevels: ['T1'],
    });

    expect(selected.map((bp) => bp.typeID)).toEqual([100]);
  });

  test('a T1 whose CATEGORY is deselected is never looked up', async () => {
    // getInventionData is a synchronous SDE read that opens its own DB
    // connection, so looking up T1s that can never reach the results is pure
    // waste. Category is safe to pre-filter because the T2 shares the T1's
    // product category.
    const t1 = makeBlueprint({ typeID: 100, productMetaGroupID: 1, productCategoryName: 'Ship' });

    mockGetAllBlueprints.mockResolvedValue([t1]);
    mockGetBlueprints.mockReturnValue([{ typeId: 100, locationFlag: 'Hangar' }]);

    await engine.selectBlueprints({
      blueprintFilter: 'owned',
      characterFilter: 'all',
      speculativeInvention: true,
      categories: ['Modules'],
    });

    expect(mockGetInventionData).not.toHaveBeenCalled();
  });

  test('tech level is NOT pre-filtered, or invention could never run', async () => {
    // Pre-filtering tech would drop every T1 whenever the user wants only T2s,
    // leaving nothing to invent FROM - the speculative feature would silently
    // produce nothing in exactly the configuration it is meant for.
    const t1 = makeBlueprint({ typeID: 100, productMetaGroupID: 1, productCategoryName: 'Ship' });
    const t2 = makeBlueprint({ typeID: 200, productMetaGroupID: 2, productCategoryName: 'Ship' });

    mockGetAllBlueprints.mockResolvedValue([t1, t2]);
    mockGetBlueprints.mockReturnValue([{ typeId: 100, locationFlag: 'Hangar' }]);
    mockGetInventionData.mockResolvedValue({ t2BlueprintTypeID: 200 });

    const selected = await engine.selectBlueprints({
      blueprintFilter: 'owned',
      characterFilter: 'all',
      speculativeInvention: true,
      techLevels: ['T2'],
    });

    expect(mockGetInventionData).toHaveBeenCalled();
    expect(selected.map((bp) => bp.typeID)).toEqual([200]);
    expect(selected[0].isSpeculativeInvention).toBe(true);
  });
});

/* -------------------------------------------------------------- the run --- */

describe('calculateSummary', () => {
  beforeEach(() => {
    mockGetBlueprints.mockReturnValue([{ typeId: 22545, locationFlag: 'Hangar' }]);
  });

  test('reports progress as it goes', async () => {
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => makeBlueprint({ typeID: i + 1 }))
    );

    const seen = [];
    await engine.calculateSummary({ blueprintFilter: 'all', facilityId: 'fac-1' },
      (p) => seen.push(p));

    expect(seen.length).toBeGreaterThan(0);
    // Pricing progress runs to completion; a later location-resolve event may
    // follow it, so assert on the pricing events specifically.
    const pricing = seen.filter((p) => /Pricing/.test(p.label));
    expect(pricing[pricing.length - 1]).toMatchObject({ done: 13, total: 13 });
  });

  test('cancellation stops between batches and throws a tagged error', async () => {
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => makeBlueprint({ typeID: i + 1 }))
    );

    // Cancel after the first batch has been priced.
    let batches = 0;
    const isCancelled = () => (batches += 1) > 1;

    await expect(
      engine.calculateSummary({ blueprintFilter: 'all', facilityId: 'fac-1' }, null, isCancelled)
    ).rejects.toMatchObject({ cancelled: true });

    // Stopped early rather than pricing all 30.
    expect(mockCalculateBlueprintMaterials.mock.calls.length).toBeLessThan(30);
  });

  test('cancellation is honoured during the SELECTION sweep too', async () => {
    // The speculative-invention sweep runs BEFORE any pricing and does one
    // SDE read per T1, so a Cancel pressed during it must take effect there
    // rather than waiting for the whole sweep to finish.
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => makeBlueprint({
        typeID: i + 1, productMetaGroupID: 1,
      }))
    );
    mockGetInventionData.mockResolvedValue({ t2BlueprintTypeID: 9999 });

    await expect(
      engine.calculateSummary(
        { blueprintFilter: 'all', facilityId: 'fac-1', speculativeInvention: true },
        null,
        () => true
      )
    ).rejects.toMatchObject({ cancelled: true });

    expect(mockGetInventionData.mock.calls.length).toBeLessThan(40);
    expect(mockCalculateBlueprintMaterials).not.toHaveBeenCalled();
  });

  test('an uncancelled run is unaffected by the extra parameter', async () => {
    // The success path must still resolve to a bare array - every existing
    // caller treats the result as rows.
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint()]);

    const rows = await engine.calculateSummary(
      { blueprintFilter: 'all', facilityId: 'fac-1' }, null, () => false
    );

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  test('resolves locations ONCE per character, not once per row', async () => {
    // resolveLocationInfoMany dedupes and builds the asset index once, so
    // batching is what keeps a thousand blueprints in a dozen stations from
    // becoming a thousand lookups - several of which can reach ESI.
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => makeBlueprint({ typeID: i + 1 }))
    );
    mockGetBlueprints.mockReturnValue(
      Array.from({ length: 8 }, (_, i) => ({
        typeId: i + 1, characterId: 91316135, locationId: 60003760, locationFlag: 'Hangar',
      }))
    );
    mockGetCharacters.mockReturnValue([
      { characterId: 91316135, characterName: 'Buckwalter' },
    ]);
    mockResolveLocationInfoMany.mockResolvedValue({ 60003760: { stationName: 'Jita IV-4' } });

    const rows = await engine.calculateSummary({
      blueprintFilter: 'owned', characterFilter: 'all', facilityId: 'fac-1',
    });

    expect(mockResolveLocationInfoMany).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => r.ownerName === 'Buckwalter')).toBe(true);
    expect(rows.every((r) => r.location === 'Jita IV-4')).toBe(true);
  });

  test('an unresolvable location leaves the column blank, not the summary empty', async () => {
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint()]);
    mockGetBlueprints.mockReturnValue([
      { typeId: 22545, characterId: 91316135, locationId: 60003760, locationFlag: 'Hangar' },
    ]);
    mockGetCharacters.mockReturnValue([
      { characterId: 91316135, characterName: 'Buckwalter' },
    ]);
    mockResolveLocationInfoMany.mockRejectedValue(new Error('ESI down'));

    const rows = await engine.calculateSummary({
      blueprintFilter: 'owned', characterFilter: 'all', facilityId: 'fac-1',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].location).toBeNull();
  });

  test('rows dropped by a threshold are never location-resolved', async () => {
    // Resolution can hit ESI, so doing it for rows about to be discarded
    // spends the error budget for output nobody sees.
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint()]);
    mockGetBlueprints.mockReturnValue([
      { typeId: 22545, characterId: 91316135, locationId: 60003760, locationFlag: 'Hangar' },
    ]);

    const rows = await engine.calculateSummary({
      blueprintFilter: 'owned',
      characterFilter: 'all',
      facilityId: 'fac-1',
      profitEnabled: true,
      profitThreshold: Number.MAX_SAFE_INTEGER,
    });

    expect(rows).toHaveLength(0);
    expect(mockResolveLocationInfoMany).not.toHaveBeenCalled();
  });

  test('one unpriceable blueprint does not lose the rest', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockGetAllBlueprints.mockResolvedValue([
      makeBlueprint({ typeID: 1 }), makeBlueprint({ typeID: 2 }),
    ]);
    mockCalculateBlueprintMaterials
      .mockRejectedValueOnce(new Error('no such blueprint'))
      .mockResolvedValue({
        materials: {}, product: { quantity: 1 }, pricing: makePricing(), breakdown: [],
      });

    const rows = await engine.calculateSummary({
      blueprintFilter: 'all', facilityId: 'fac-1',
    });

    expect(rows).toHaveLength(1);
    spy.mockRestore();
  });

  test('an empty selection returns an empty array, not an error', async () => {
    mockGetAllBlueprints.mockResolvedValue([]);
    expect(await engine.calculateSummary({ blueprintFilter: 'all', facilityId: 'fac-1' }))
      .toEqual([]);
  });

  test('the facility is loaded ONCE, not per blueprint', async () => {
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => makeBlueprint({ typeID: i + 1 }))
    );

    await engine.calculateSummary({ blueprintFilter: 'all', facilityId: 'fac-1' });

    expect(mockGetManufacturingFacility).toHaveBeenCalledTimes(1);
  });

  test('the location filter follows the market set scope', async () => {
    const { getMarketSetById } = require('../../src/main/settings-manager');
    getMarketSetById.mockReturnValue({
      id: 'set-1',
      inputMaterials: { regionId: 10000002, locationType: 'station', locationId: 60003760 },
    });
    mockGetAllBlueprints.mockResolvedValue([makeBlueprint()]);

    await engine.calculateSummary({
      blueprintFilter: 'all', facilityId: 'fac-1', marketSetId: 'set-1',
    });

    const orderCall = mockFetchMarketOrders.mock.calls[0];
    expect(orderCall[2]).toEqual({ type: 'station', id: 60003760 });
  });
});
