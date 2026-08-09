/**
 * What Can I Build? engine.
 *
 * The riskiest part of this screen is `calculateBuildable`, and specifically
 * that `percentOnHand` is the MINIMUM across materials rather than an average.
 * `cleanup-tool.js` carried a never-wired implementation that averaged: with
 * 100% of one material and 0% of another it reported 50% buildable when
 * nothing could be built. That function is now deleted, and these tests pin
 * the surviving behaviour so it cannot come back.
 *
 * Selection and classification are NOT retested here - they live in
 * industry-shared.js and are covered by the Manufacturing Summary suite.
 */

const mockCalculateBlueprintMaterials = jest.fn();
const mockGetAllBlueprints = jest.fn();
const mockGetInventionData = jest.fn();
const mockGetBlueprints = jest.fn();
const mockGetCharacters = jest.fn();
const mockGetDefaultCharacter = jest.fn();
const mockGetManufacturingFacility = jest.fn();
const mockFetchMarketHistory = jest.fn();
const mockAggregateAssets = jest.fn();
const mockResolveLocationInfoMany = jest.fn(async () => ({}));

jest.mock('../../src/main/blueprint-calculator', () => ({
  calculateBlueprintMaterials: mockCalculateBlueprintMaterials,
  getAllBlueprints: mockGetAllBlueprints,
  getInventionData: mockGetInventionData,
}));

jest.mock('../../src/main/settings-manager', () => ({
  getMarketSetById: jest.fn(() => ({ id: 'set-1', inputMaterials: { regionId: 10000002 } })),
  getDefaultMarketSet: jest.fn(() => ({ id: 'set-1', inputMaterials: { regionId: 10000002 } })),
  getManufacturingFacility: mockGetManufacturingFacility,
  getCharacters: mockGetCharacters,
  getDefaultCharacter: mockGetDefaultCharacter,
  getBlueprints: mockGetBlueprints,
}));

jest.mock('../../src/main/sde-database', () => ({
  getSystemSecurityStatus: jest.fn(async () => 0.9),
  getStructureBonuses: jest.fn(async () => ({ timeEfficiency: 15, materialEfficiency: 1 })),
}));

jest.mock('../../src/main/esi-market', () => ({
  fetchMarketHistory: mockFetchMarketHistory,
}));

jest.mock('../../src/main/cleanup-tool', () => ({
  aggregateAssets: mockAggregateAssets,
}));

jest.mock('../../src/main/location-resolver', () => ({
  resolveLocationInfoMany: mockResolveLocationInfoMany,
}));

const engine = require('../../src/main/what-can-i-build');

/* ------------------------------------------------------------- fixtures */

/**
 * A facility AS calculateRow RECEIVES IT - i.e. already enriched.
 *
 * `structureBonuses` is attached by loadFacility(), not present on the raw
 * settings row, and calculateProductionTime reads it directly. Omitting it
 * here made the fixture quietly disagree with production.
 */
const FACILITY = {
  id: 'fac-1',
  name: 'Sotiyo',
  systemId: 30000142,
  structureTypeId: 35827,
  usage: 'default',
  structureBonuses: { timeEfficiency: 15 },
};

function makeBlueprint(overrides = {}) {
  return {
    typeID: 22545,
    typeName: 'Hulk Blueprint',
    productTypeID: 22544,
    productName: 'Hulk',
    productGroupName: 'Mining Barge',
    productCategoryName: 'Ship',
    productMetaGroupID: 2,
    baseTime: 36000,
    ...overrides,
  };
}

function makePricing(overrides = {}) {
  return {
    profit: 550250,
    totalCosts: 949750,
    outputValue: { totalValue: 1500000 },
    ...overrides,
  };
}

/** 30 days of history, 1000 units sold per day. */
function makeHistory(volumePerDay = 1000) {
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (i * 86400000)).toISOString().slice(0, 10),
    volume: volumePerDay,
    average: 100,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();

  // The RAW settings row - no structureBonuses. loadFacility() is what
  // attaches those, so handing back the enriched shape here would mask a
  // regression in that enrichment.
  mockGetManufacturingFacility.mockReturnValue({
    id: FACILITY.id,
    name: FACILITY.name,
    systemId: FACILITY.systemId,
    structureTypeId: FACILITY.structureTypeId,
    usage: FACILITY.usage,
  });
  mockGetDefaultCharacter.mockReturnValue({ characterId: 91316135 });
  mockGetCharacters.mockReturnValue([{ characterId: 91316135 }]);
  mockGetBlueprints.mockReturnValue([]);
  mockGetAllBlueprints.mockResolvedValue([makeBlueprint()]);
  mockGetInventionData.mockResolvedValue(null);
  mockFetchMarketHistory.mockResolvedValue(makeHistory());
  mockAggregateAssets.mockReturnValue({});
  // clearAllMocks wipes implementations, so re-apply the default.
  mockResolveLocationInfoMany.mockResolvedValue({});
  mockCalculateBlueprintMaterials.mockResolvedValue({
    materials: { 34: 100 },
    product: { quantity: 1 },
    pricing: makePricing(),
    time: 36000,
  });
});

/* ------------------------------------------------- calculateBuildable --- */

describe('calculateBuildable', () => {
  test('percentOnHand is the MINIMUM across materials, never an average', () => {
    // The single most important behaviour on this screen. The deleted
    // averaging version reported 50% here, implying half-buildable when
    // nothing can be built at all.
    const result = engine.calculateBuildable(
      { 34: 100, 35: 100 },
      { 34: 100, 35: 0 }
    );

    expect(result.percentOnHand).toBe(0);
    expect(result.buildableRuns).toBe(0);
  });

  test('buildable runs are limited by the scarcest material', () => {
    const result = engine.calculateBuildable(
      { 34: 100, 35: 10 },
      { 34: 1000, 35: 25 }   // 10 runs of one, 2 of the other
    );

    expect(result.buildableRuns).toBe(2);
  });

  test('a surplus of one material cannot mask a shortage of another', () => {
    // 1000% of tritanium, 25% of pyerite -> still only 25% of a run.
    const result = engine.calculateBuildable(
      { 34: 100, 35: 100 },
      { 34: 1000, 35: 25 }
    );

    expect(result.percentOnHand).toBe(25);
  });

  test('full coverage reports 100% and the run count', () => {
    const result = engine.calculateBuildable(
      { 34: 100, 35: 50 },
      { 34: 500, 35: 500 }   // 5 runs / 10 runs
    );

    expect(result.percentOnHand).toBe(100);
    expect(result.buildableRuns).toBe(5);
  });

  test('no materials means nothing buildable, not everything', () => {
    expect(engine.calculateBuildable({}, { 34: 999 }))
      .toMatchObject({ buildableRuns: 0, percentOnHand: 0 });
    expect(engine.calculateBuildable(null, {}))
      .toMatchObject({ buildableRuns: 0, percentOnHand: 0 });
  });

  test('a malformed material is skipped, not treated as free', () => {
    // A zero or NaN requirement would divide to Infinity and read as
    // infinitely buildable.
    const result = engine.calculateBuildable(
      { 34: 100, 35: 0, 36: 'nonsense' },
      { 34: 100 }
    );

    expect(result.materialBreakdown).toHaveLength(1);
    expect(result.buildableRuns).toBe(1);
  });

  test('the breakdown reports per-material detail', () => {
    const result = engine.calculateBuildable({ 34: 100 }, { 34: 250 });

    expect(result.materialBreakdown).toEqual([{
      typeId: 34,
      required: 100,
      available: 250,
      runsSupported: 2,
      percentForOneRun: 100,
    }]);
  });
});

/* -------------------------------------------------------- calculateSVR --- */

describe('calculateSVR', () => {
  test('units sold over units producible in the period', async () => {
    // 30 days x 1000/day = 30,000 sold. At 1h per unit, 720 producible.
    mockFetchMarketHistory.mockResolvedValue(makeHistory(1000));

    const svr = await engine.calculateSVR(22544, 10000002, 1);

    expect(svr).toBeCloseTo(30000 / 720, 4);
  });

  test('no history means no velocity, not a divide-by-zero', async () => {
    mockFetchMarketHistory.mockResolvedValue([]);
    expect(await engine.calculateSVR(22544, 10000002, 1)).toBe(0);
  });

  test('a zero production time cannot divide', async () => {
    expect(await engine.calculateSVR(22544, 10000002, 0)).toBe(0);
  });

  test('a history failure degrades to 0 rather than losing the row', async () => {
    mockFetchMarketHistory.mockRejectedValue(new Error('ESI down'));
    expect(await engine.calculateSVR(22544, 10000002, 1)).toBe(0);
  });
});

/* ----------------------------------------------------------- the row --- */

describe('calculateRow', () => {
  const context = {
    facility: FACILITY,
    marketSet: { id: 'set-1', inputMaterials: { regionId: 10000002 } },
    characterId: 91316135,
    threshold: 0,
    assets: { 34: 1000 },
    regionId: 10000002,
  };

  test('drops a blueprint below the on-hand threshold', async () => {
    // 100 required, 10 on hand -> 10%, under a 90% threshold.
    const row = await engine.calculateRow(
      makeBlueprint(),
      { ...context, threshold: 90, assets: { 34: 10 } }
    );

    expect(row).toBeNull();
  });

  test('keeps a blueprint that clears the threshold', async () => {
    const row = await engine.calculateRow(
      makeBlueprint(),
      { ...context, threshold: 90, assets: { 34: 100 } }
    );

    expect(row).not.toBeNull();
    expect(row.percentOnHand).toBe(100);
  });

  test('the threshold check runs BEFORE the history lookup', async () => {
    // SVR reaches ESI; spending that on rows about to be discarded is the
    // waste this ordering avoids.
    await engine.calculateRow(
      makeBlueprint(),
      { ...context, threshold: 90, assets: {} }
    );

    expect(mockFetchMarketHistory).not.toHaveBeenCalled();
  });

  test('name and category describe the PRODUCT, not the blueprint', async () => {
    const row = await engine.calculateRow(makeBlueprint(), context);

    expect(row.itemName).toBe('Hulk');
    expect(row.category).toBe('Mining Barge');
    expect(row.blueprintName).toBe('Hulk Blueprint');
  });

  test('ME and TE come from the owned row when there is one', async () => {
    const row = await engine.calculateRow(
      makeBlueprint({
        _owned: { typeId: 22545, materialEfficiency: 10, timeEfficiency: 20, isCopy: true },
      }),
      context
    );

    expect(row.meLevel).toBe(10);
    expect(row.teLevel).toBe(20);
    expect(row.isOwned).toBe(true);
    expect(row.bpType).toBe('BPC');
  });

  test('an unowned blueprint reports ME/TE 0 and no BP type', async () => {
    const row = await engine.calculateRow(makeBlueprint(), context);

    expect(row.meLevel).toBe(0);
    expect(row.isOwned).toBe(false);
    expect(row.bpType).toBe('N/A');
  });

  test('ISK/hour uses the TE- and structure-adjusted production time', async () => {
    const row = await engine.calculateRow(
      makeBlueprint({
        _owned: { typeId: 22545, materialEfficiency: 0, timeEfficiency: 20 },
      }),
      context
    );

    // 36000s, -20% TE, -15% structure = 24480s = 6.8h
    expect(row.productionTimeHours).toBeCloseTo(6.8, 5);
    expect(row.iskPerHour).toBeCloseTo(550250 / 6.8, 2);
  });

  test('ROI is profit over total cost as a percentage', async () => {
    const row = await engine.calculateRow(makeBlueprint(), context);
    expect(row.roi).toBeCloseTo((550250 / 949750) * 100, 6);
  });

  test('an unpriceable blueprint is dropped, not returned half-built', async () => {
    mockCalculateBlueprintMaterials.mockResolvedValue({ materials: { 34: 1 } });
    expect(await engine.calculateRow(makeBlueprint(), context)).toBeNull();
  });
});

/* -------------------------------------------------------- the whole run --- */

describe('calculate', () => {
  beforeEach(() => {
    mockAggregateAssets.mockReturnValue({ 34: 1000 });
  });

  test('aggregates the selected asset sources exactly once', async () => {
    const assetSources = {
      personal: [{ characterId: 91316135 }],
      corporation: [{ characterId: 91316135, divisions: [1, 2] }],
    };

    await engine.calculate({ blueprintFilter: 'all', facilityId: 'fac-1', assetSources });

    expect(mockAggregateAssets).toHaveBeenCalledTimes(1);
    expect(mockAggregateAssets).toHaveBeenCalledWith(assetSources);
  });

  test('reports progress through the pass', async () => {
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => makeBlueprint({ typeID: i + 1 }))
    );

    const seen = [];
    await engine.calculate(
      { blueprintFilter: 'all', facilityId: 'fac-1' },
      (p) => seen.push(p)
    );

    const costing = seen.filter((p) => /Costing/.test(p.label));
    expect(costing[costing.length - 1]).toMatchObject({ done: 13, total: 13 });
  });

  test('returns a { cancelled, rows } envelope', async () => {
    const result = await engine.calculate({ blueprintFilter: 'all', facilityId: 'fac-1' });

    expect(result.cancelled).toBe(false);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.assetTypeCount).toBe(1);
  });

  test('cancellation stops between batches and throws a tagged error', async () => {
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => makeBlueprint({ typeID: i + 1 }))
    );

    let batches = 0;
    const isCancelled = () => (batches += 1) > 1;

    await expect(
      engine.calculate({ blueprintFilter: 'all', facilityId: 'fac-1' }, null, isCancelled)
    ).rejects.toMatchObject({ cancelled: true });

    expect(mockCalculateBlueprintMaterials.mock.calls.length).toBeLessThan(30);
  });

  test('cancellation is honoured during the SELECTION sweep, before pricing', async () => {
    // With "All Blueprints" + T2 invention, selectBlueprints does one SDE
    // read per T1 in the whole database - a long stretch that runs BEFORE
    // any pricing. Without a check there, Cancel appeared to do nothing
    // until the entire sweep finished.
    mockGetAllBlueprints.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => makeBlueprint({
        typeID: i + 1, productMetaGroupID: 1,
      }))
    );
    mockGetInventionData.mockResolvedValue({ t2BlueprintTypeID: 9999 });

    // Cancel immediately - the pricing loop is never reached.
    const isCancelled = () => true;

    await expect(
      engine.calculate(
        { blueprintFilter: 'all', facilityId: 'fac-1', speculativeInvention: true },
        null,
        isCancelled
      )
    ).rejects.toMatchObject({ cancelled: true });

    // Stopped inside the sweep rather than running all 40 lookups.
    expect(mockGetInventionData.mock.calls.length).toBeLessThan(40);
    // ...and no pricing happened at all.
    expect(mockCalculateBlueprintMaterials).not.toHaveBeenCalled();
  });

  test('an uncancelled selection sweep completes normally', async () => {
    mockGetAllBlueprints.mockResolvedValue([
      makeBlueprint({ typeID: 1, productMetaGroupID: 1 }),
    ]);
    mockGetInventionData.mockResolvedValue(null);

    const result = await engine.calculate(
      { blueprintFilter: 'all', facilityId: 'fac-1', speculativeInvention: true },
      null,
      () => false
    );

    expect(result.cancelled).toBe(false);
    expect(mockGetInventionData).toHaveBeenCalled();
  });

  test('one unpriceable blueprint does not lose the others', async () => {
    mockGetAllBlueprints.mockResolvedValue([
      makeBlueprint({ typeID: 1 }),
      makeBlueprint({ typeID: 2 }),
    ]);
    mockCalculateBlueprintMaterials
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({
        materials: { 34: 100 },
        product: { quantity: 1 },
        pricing: makePricing(),
        time: 36000,
      });

    const result = await engine.calculate({ blueprintFilter: 'all', facilityId: 'fac-1' });

    expect(result.rows).toHaveLength(1);
  });

  test('resolves owners and locations once per character, not per row', async () => {
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

    const result = await engine.calculate({
      blueprintFilter: 'owned', characterFilter: 'all', facilityId: 'fac-1',
    });

    expect(mockResolveLocationInfoMany).toHaveBeenCalledTimes(1);
    expect(result.rows.every((r) => r.ownerName === 'Buckwalter')).toBe(true);
    expect(result.rows.every((r) => r.location === 'Jita IV-4')).toBe(true);
  });

  test('the facility is enriched before costing', async () => {
    // getManufacturingFacility returns the raw settings row; loadFacility
    // attaches securityStatus and structureBonuses. Without that the
    // structure's time bonus silently stops applying.
    await engine.calculate({ blueprintFilter: 'all', facilityId: 'fac-1' });

    const facilityArg = mockCalculateBlueprintMaterials.mock.calls[0][4];
    expect(facilityArg.structureBonuses).toEqual({ timeEfficiency: 15, materialEfficiency: 1 });
    expect(facilityArg.securityStatus).toBe(0.9);
  });

  test('an empty blueprint set returns cleanly', async () => {
    mockGetAllBlueprints.mockResolvedValue([]);

    const result = await engine.calculate({ blueprintFilter: 'all', facilityId: 'fac-1' });

    expect(result.rows).toEqual([]);
    expect(result.cancelled).toBe(false);
  });
});
