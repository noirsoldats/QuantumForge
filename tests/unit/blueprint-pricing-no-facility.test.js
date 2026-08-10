/**
 * "No Facility (No Bonuses)" must still produce Cost / Fee / Profit.
 *
 * The Blueprint Calculator's facility dropdown offers "No Facility (No Bonuses)",
 * which sends facilityId = null. Material quantities calculated correctly, but
 * Cost, Fee and Profit came back EMPTY: calculateBlueprintMaterials gated its
 * whole pricing block on `facility && facility.systemId`, so `pricing` stayed
 * null and the UI had nothing to render.
 *
 * Only the JOB COST half of pricing needs a system - it looks up that system's
 * manufacturing cost index. Material cost, output value and taxes need nothing
 * from a facility. So a facility-less estimate is perfectly meaningful: real
 * material cost and profit, with the installation fee 0 because no system was
 * chosen to levy it.
 *
 * These mock market-pricing (where blueprint-pricing actually imports
 * calculateRealisticPrice/getPriceOverride from - NOT market-database) so the
 * numbers are deterministic and no market data is required.
 */

jest.mock('../../src/main/market-pricing', () => ({
  // Product prices at 100, every material at 10.
  calculateRealisticPrice: jest.fn(async (typeId) => ({
    price: typeId === 12779 ? 100.0 : 10.0,
    method: 'immediate',
    confidence: 'high',
    metadata: {},
  })),
  getPriceOverride: jest.fn(() => null),
}));

// No cost indices: exactly what getCostIndices(null) returns for "no system".
jest.mock('../../src/main/esi-cost-indices', () => ({
  getCostIndices: jest.fn(() => []),
}));

jest.mock('../../src/main/audit-recorder', () => ({ recordPricing: jest.fn() }));

const MARKET_SET = {
  id: 'ms-1',
  name: 'Test Set',
  inputMaterials: {
    priceType: 'sell', priceMethod: 'immediate', locationType: 'region', regionId: 10000002,
  },
  outputProducts: {
    priceType: 'sell', priceMethod: 'immediate', locationType: 'region', regionId: 10000002,
  },
};

const MATERIALS = { 34: 1000, 35: 500 };          // 1500 units @ 10 = 15,000
const PRODUCT = { typeID: 12779, quantity: 5000 }; // 5000 @ 100 = 500,000
const BLUEPRINT_TYPE_ID = 12780;
const RUNS = 10;

describe('calculateBlueprintPricing without a facility', () => {
  test('returns a populated result rather than nothing', async () => {
    const { calculateBlueprintPricing } = require('../../src/main/blueprint-pricing');

    const pricing = await calculateBlueprintPricing(
      MATERIALS, PRODUCT,
      null,  // systemId - no facility means no system
      null,  // facility
      0, BLUEPRINT_TYPE_ID, RUNS, 0, MARKET_SET
    );

    expect(pricing).toBeTruthy();
    // The three the bug left blank.
    expect(pricing.inputCosts.totalCost).toBe(15000);
    expect(pricing.outputValue.totalValue).toBe(500000);
    expect(pricing.profit).toBeGreaterThan(0);
  });

  test('job cost is zero - honest, since no system levies a fee', async () => {
    const { calculateBlueprintPricing } = require('../../src/main/blueprint-pricing');

    const pricing = await calculateBlueprintPricing(
      MATERIALS, PRODUCT, null, null, 0, BLUEPRINT_TYPE_ID, RUNS, 0, MARKET_SET
    );

    // Zero because there is no cost index to apply, NOT because pricing failed.
    expect(pricing.jobCostBreakdown.totalJobCost).toBe(0);
    // ...and the surrounding numbers are still real, which is the distinction.
    expect(pricing.totalCosts).toBeGreaterThan(0);
  });

  test('taxes still apply without a facility', async () => {
    // Sales tax and broker fees are trading costs - they do not depend on where
    // the job is installed, so omitting them would understate cost.
    const { calculateBlueprintPricing } = require('../../src/main/blueprint-pricing');

    const pricing = await calculateBlueprintPricing(
      MATERIALS, PRODUCT, null, null, 0, BLUEPRINT_TYPE_ID, RUNS, 0, MARKET_SET
    );

    expect(pricing.taxesBreakdown.totalTaxes).toBeGreaterThan(0);
  });

  test('profit reconciles: output - (materials + job + taxes)', async () => {
    const { calculateBlueprintPricing } = require('../../src/main/blueprint-pricing');

    const pricing = await calculateBlueprintPricing(
      MATERIALS, PRODUCT, null, null, 0, BLUEPRINT_TYPE_ID, RUNS, 0, MARKET_SET
    );

    const expectedCosts = pricing.inputCosts.totalCost
      + pricing.jobCostBreakdown.totalJobCost
      + pricing.taxesBreakdown.totalTaxes;

    expect(pricing.totalCosts).toBeCloseTo(expectedCosts, 6);
    expect(pricing.profit).toBeCloseTo(pricing.outputValue.totalValue - expectedCosts, 6);
  });
});
