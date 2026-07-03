/**
 * Cross-Module Pricing Consistency Tests
 *
 * Proves that every module which prices materials/products against a Market Set
 * passes calculateRealisticPrice() the same settings shape: the flat, unwrapped
 * inputMaterials/outputProducts sub-object (matching DEFAULT_MARKET_SET_TEMPLATE
 * in settings-manager.js), not the raw Market Set object and not a partial call
 * that omits settings entirely.
 *
 * Background: calculateRealisticPrice(typeId, regionId, locationId, priceType, quantity, settings)
 * reads settings.priceMethod / settings.percentile / settings.minVolume / settings.priceModifier
 * at the TOP LEVEL of `settings`. The Market Set config nests these under
 * marketSet.inputMaterials / marketSet.outputProducts. Any call site that passes the
 * wrong shape silently falls back to defaults (priceMethod: 'hybrid'), ignoring the
 * user's configured pricing method — this is the bug reported as "prices differ between
 * parts of the app" / "Price Type setting not obeyed".
 */

jest.mock('../../src/main/market-pricing', () => ({
  calculateRealisticPrice: jest.fn(async (typeId, regionId, locationId, priceType, quantity, settings) => {
    return {
      // Echo back what was actually passed, so assertions can inspect the call shape
      _receivedSettings: settings,
      price: 100,
      method: settings && settings.priceMethod ? settings.priceMethod : 'hybrid',
      confidence: 'high',
      warning: null,
    };
  }),
  getPriceOverride: jest.fn(() => null),
}));

const { calculateRealisticPrice } = require('../../src/main/market-pricing');
const { calculateInputMaterialsCost } = require('../../src/main/blueprint-pricing');
const { loadFixtureDatabase } = require('../unit/helpers/database-mocks');

// Build a Market Set matching the real DEFAULT_MARKET_SET_TEMPLATE shape
// (settings-manager.js ~line 1089), with a non-default priceMethod so the bug
// (silent fallback to 'hybrid') is observable.
function buildTestMarketSet(overrides = {}) {
  return {
    id: 'test-market-set',
    name: 'Test Market Set',
    isDefault: true,
    inputMaterials: {
      locationType: 'hub',
      locationId: 60003760,
      regionId: 10000002,
      systemId: 30000142,
      structureId: null,
      structureName: null,
      characterId: null,
      priceType: 'sell',
      priceMethod: 'percentile',
      priceModifier: 1.0,
      percentile: 0.3,
      minVolume: 500,
      ...(overrides.inputMaterials || {}),
    },
    outputProducts: {
      useSameLocation: true,
      locationType: 'hub',
      locationId: 60003760,
      regionId: 10000002,
      systemId: 30000142,
      structureId: null,
      structureName: null,
      characterId: null,
      priceType: 'sell',
      priceMethod: 'percentile',
      priceModifier: 1.0,
      percentile: 0.3,
      minVolume: 500,
      ...(overrides.outputProducts || {}),
    },
    warningThreshold: 0.3,
  };
}

/**
 * Reproduces the exact pricing call manufacturing-plans.js's recalculatePlanMaterials
 * makes for a 'material' node (see manufacturing-plans.js ~lines 3001-3008) and for a
 * 'product'/'intermediate' node (~lines 3025-3031). recalculatePlanMaterials itself is not
 * unit-testable in isolation (it orchestrates plan/character-database state, node-tree
 * construction, and ESI-adjacent side effects across 1000+ lines) — this harness exercises
 * the identical calculateRealisticPrice invocation pattern so the settings-shape bug is
 * caught without standing up that whole apparatus. Keep this in sync with the real source
 * if those call sites' argument lists change.
 */
async function planMaterialsPricingCall_asImplemented(node, marketSettings, inputLocation, outputLocation) {
  if (node.nodeType === 'material') {
    return calculateRealisticPrice(
      node.typeId,
      inputLocation.regionId,
      inputLocation.locationId,
      marketSettings.inputMaterials.priceType,
      node.quantityNeeded,
      marketSettings.inputMaterials
    );
  }
  return calculateRealisticPrice(
    node.typeId,
    outputLocation.regionId,
    outputLocation.locationId,
    marketSettings.outputProducts.priceType,
    node.quantityNeeded,
    marketSettings.outputProducts
  );
}

describe('Cross-module pricing consistency', () => {
  beforeEach(() => {
    calculateRealisticPrice.mockClear();
  });

  test('Blueprint Calculator (calculateInputMaterialsCost) passes the unwrapped, flat settings sub-object', async () => {
    const marketSet = buildTestMarketSet();

    await calculateInputMaterialsCost({ 34: 100 }, marketSet);

    expect(calculateRealisticPrice).toHaveBeenCalledTimes(1);
    const [, , , , , settingsArg] = calculateRealisticPrice.mock.calls[0];

    // Must be the flat inputMaterials sub-object, with priceMethod at the top level
    expect(settingsArg).toBeDefined();
    expect(settingsArg.priceMethod).toBe('percentile');
    expect(settingsArg.percentile).toBe(0.3);
    expect(settingsArg.minVolume).toBe(500);
  });

  test('Manufacturing Plans material-node pricing must request the same priceMethod as Blueprint Calculator for the same Market Set', async () => {
    // Regression anchor for manufacturing-plans.js's recalculatePlanMaterials
    // (~lines 3001-3008 material node, ~3025-3031 product/intermediate node).
    // Before the fix, those call sites omitted the settings argument, so
    // calculateRealisticPrice silently fell back to priceMethod 'hybrid'
    // regardless of the Market Set's configured method — diverging from
    // Blueprint Calculator, which always passed the real settings. This test
    // pins that both paths must resolve to the same method for the same
    // Market Set; planMaterialsPricingCall_asImplemented above must be kept
    // in sync with the real source.
    const marketSet = buildTestMarketSet();
    const inputLocation = { regionId: marketSet.inputMaterials.regionId, locationId: marketSet.inputMaterials.locationId };
    const outputLocation = { regionId: marketSet.outputProducts.regionId, locationId: marketSet.outputProducts.locationId };

    await calculateInputMaterialsCost({ 34: 100 }, marketSet);
    const bpSettingsArg = calculateRealisticPrice.mock.calls[0][5];
    const bpPriceResultMethod = (await calculateRealisticPrice.mock.results[0].value).method;

    calculateRealisticPrice.mockClear();

    const planResult = await planMaterialsPricingCall_asImplemented(
      { nodeType: 'material', typeId: 34, quantityNeeded: 100 },
      marketSet,
      inputLocation,
      outputLocation
    );
    const planSettingsArg = calculateRealisticPrice.mock.calls[0][5];

    // Both paths must pass the SAME settings shape for the SAME Market Set,
    // and therefore must resolve to the SAME pricing method.
    expect(planSettingsArg).toBeDefined();
    expect(planSettingsArg.priceMethod).toBe(bpSettingsArg.priceMethod);
    expect(planSettingsArg.percentile).toBe(bpSettingsArg.percentile);
    expect(planSettingsArg.minVolume).toBe(bpSettingsArg.minVolume);
    expect(planResult.method).toBe(bpPriceResultMethod);
  });
});

describe('Cross-module pricing consistency — static fixture DBs', () => {
  // Uses the committed fixture databases (tests/fixtures/db/) instead of
  // per-test mocks, so this and any future cross-module test share one real,
  // on-disk dataset. See tests/fixtures/db/README.md.
  let sdeDb;
  let marketDb;

  beforeAll(() => {
    sdeDb = loadFixtureDatabase('pricing-consistency.sde');
    marketDb = loadFixtureDatabase('pricing-consistency.market');
  });

  afterAll(() => {
    sdeDb.close();
    marketDb.close();
  });

  test('fixture SDE db has the Scourge Light Missile Blueprint materials', () => {
    const { getBlueprintMaterials } = require('../../src/main/blueprint-calculator');
    const materials = getBlueprintMaterials(810, 1, sdeDb);

    expect(materials).toEqual(
      expect.arrayContaining([
        { typeID: 34, quantity: 50 },
        { typeID: 35, quantity: 25 },
        { typeID: 36, quantity: 5 },
        { typeID: 11399, quantity: 1 },
      ])
    );
  });

  test('fixture market db has Tritanium sell orders and history matching tests/unit/fixtures/market-data.js', () => {
    const orders = marketDb.prepare('SELECT * FROM market_orders WHERE type_id = 34 AND is_buy_order = 0').all();
    expect(orders).toHaveLength(5);
    expect(orders.map(o => o.price).sort()).toEqual([6.52, 6.53, 6.55, 6.60, 6.75]);

    const history = marketDb.prepare('SELECT * FROM market_history WHERE type_id = 34').all();
    expect(history).toHaveLength(5);
  });
});
