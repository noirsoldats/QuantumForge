/**
 * Unit Tests for Blueprint Pricing Calculations
 *
 * Tests complete blueprint pricing including input material costs,
 * output product values, manufacturing job costs, and trading taxes
 */

const {
  calculateInputMaterialsCost,
  calculateOutputProductValue,
  calculateManufacturingJobCost,
  calculateManufacturingTaxes,
  calculateBlueprintPricing
} = require('../../src/main/blueprint-pricing');

const marketData = require('./fixtures/market-data');
const blueprintFixtures = require('./fixtures/blueprints');
const facilitiesFixtures = require('./fixtures/facilities');

// Mock market-pricing module
jest.mock('../../src/main/market-pricing', () => ({
  calculateRealisticPrice: jest.fn((typeId, regionId, locationId, priceType, quantity, settings) => {
    // Return fixture prices for common materials
    const prices = {
      34: 6.50,    // Tritanium
      35: 13.00,   // Pyerite
      36: 42.00,   // Mexallon
      37: 210.00,  // Isogen
      38: 1200.00, // Nocxium
      39: 9500.00, // Zydrine
      40: 18000.00, // Megacyte
      810: 50000.00 // Scourge Missile
    };
    return Promise.resolve({
      price: prices[typeId] || 1000,
      method: 'vwap',
      confidence: 'high'
    });
  }),
  getPriceOverride: jest.fn(() => null)
}));

// Mock esi-cost-indices module
jest.mock('../../src/main/esi-cost-indices', () => ({
  getCostIndices: jest.fn((systemId) => {
    return [{
      activity: 'manufacturing',
      costIndex: 0.025 // 2.5% system cost index
    }];
  })
}));

// Mock settings-manager module
jest.mock('../../src/main/settings-manager', () => ({
  getMarketSettings: jest.fn(() => ({
    regionId: 10000002,  // The Forge
    locationId: 60003760,  // Jita IV - Moon 4
    inputMaterials: {
      priceType: 'sell',
      priceModifier: 1.0,
      priceMethod: 'vwap',
      percentile: 0.2,
      minVolume: 1000
    },
    outputProducts: {
      priceType: 'sell',
      priceModifier: 1.0,
      priceMethod: 'vwap',
      percentile: 0.2,
      minVolume: 1000
    }
  }))
}));

// Mock blueprint-calculator module
jest.mock('../../src/main/blueprint-calculator', () => ({
  getBlueprintMaterials: jest.fn((blueprintTypeId) => {
    // Return mock materials for Scourge blueprint
    if (blueprintTypeId === 810) {
      return [
        { typeID: 34, quantity: 1000 },  // Tritanium
        { typeID: 35, quantity: 500 },   // Pyerite
        { typeID: 36, quantity: 100 }    // Mexallon
      ];
    }
    return [];
  })
}));

// Mock market-database module
jest.mock('../../src/main/market-database', () => ({
  getAdjustedPrice: jest.fn((typeId) => {
    // Return adjusted prices (CCP's pricing used for job costs)
    const adjustedPrices = {
      34: 6.00,    // Tritanium
      35: 12.00,   // Pyerite
      36: 40.00    // Mexallon
    };
    return adjustedPrices[typeId] ? { adjusted_price: adjustedPrices[typeId] } : null;
  })
}));

describe('Blueprint Pricing Calculations', () => {
  describe('calculateInputMaterialsCost', () => {
    const mockMaterials = {
      34: 1000,  // Tritanium
      35: 500,   // Pyerite
      36: 100    // Mexallon
    };

    const mockMarketSettings = {
      regionId: marketData.THE_FORGE_REGION_ID,
      locationId: marketData.JITA_STATION_ID,
      inputMaterials: {
        priceType: 'sell',
        priceModifier: 1.0,
        priceMethod: 'vwap'
      }
    };

    test('calculates total material cost', async () => {
      const result = await calculateInputMaterialsCost(mockMaterials, mockMarketSettings);

      expect(result).toBeDefined();
      expect(result.totalCost).toBeGreaterThan(0);
      expect(result.materialPrices).toBeDefined();
    });

    test('returns pricing details for each material', async () => {
      const result = await calculateInputMaterialsCost(mockMaterials, mockMarketSettings);

      expect(result.materialPrices['34']).toBeDefined();
      expect(result.materialPrices['34'].quantity).toBe(1000);
      expect(result.materialPrices['34'].unitPrice).toBeGreaterThan(0);
      expect(result.materialPrices['34'].totalPrice).toBeGreaterThan(0);
      expect(result.materialPrices['34'].hasPrice).toBe(true);
    });

    test('applies price modifier to materials', async () => {
      const settingsNoModifier = { ...mockMarketSettings };
      const settingsWithModifier = {
        ...mockMarketSettings,
        inputMaterials: { ...mockMarketSettings.inputMaterials, priceModifier: 1.1 }
      };

      const result1x = await calculateInputMaterialsCost(mockMaterials, settingsNoModifier);
      const result1_1x = await calculateInputMaterialsCost(mockMaterials, settingsWithModifier);

      expect(result1_1x.totalCost).toBeApproximately(result1x.totalCost * 1.1, 0.01);
    });

    test('tracks items with and without prices', async () => {
      const result = await calculateInputMaterialsCost(mockMaterials, mockMarketSettings);

      expect(result.itemsWithPrices).toBeGreaterThan(0);
      expect(result.itemsWithoutPrices).toBe(0);
      expect(result.allPricesAvailable).toBe(true);
    });

    test('uses price override when available', async () => {
      const marketPricing = require('../../src/main/market-pricing');
      marketPricing.getPriceOverride.mockReturnValueOnce({ price: 10.00 });

      const result = await calculateInputMaterialsCost({ 34: 1000 }, mockMarketSettings);

      expect(result.materialPrices['34'].unitPrice).toBe(10.00);
      expect(result.materialPrices['34'].totalPrice).toBe(10000);
    });

    test('handles errors gracefully', async () => {
      const marketPricing = require('../../src/main/market-pricing');
      marketPricing.calculateRealisticPrice.mockRejectedValueOnce(new Error('API error'));

      const result = await calculateInputMaterialsCost({ 34: 1000 }, mockMarketSettings);

      expect(result.materialPrices['34'].hasPrice).toBe(false);
      expect(result.materialPrices['34'].error).toBeDefined();
      expect(result.itemsWithoutPrices).toBe(1);
    });
  });

  describe('calculateOutputProductValue', () => {
    const mockProduct = {
      typeID: 810,  // Scourge Missile
      quantity: 100
    };

    const mockMarketSettings = {
      regionId: marketData.THE_FORGE_REGION_ID,
      locationId: marketData.JITA_STATION_ID,
      outputProducts: {
        priceType: 'sell',
        priceModifier: 1.0,
        priceMethod: 'vwap'
      }
    };

    test('calculates product value', async () => {
      const result = await calculateOutputProductValue(mockProduct, mockMarketSettings);

      expect(result).toBeDefined();
      expect(result.typeID).toBe(810);
      expect(result.quantity).toBe(100);
      expect(result.unitPrice).toBeGreaterThan(0);
      expect(result.totalValue).toBeGreaterThan(0);
      expect(result.hasPrice).toBe(true);
    });

    test('applies price modifier to product', async () => {
      const settingsNoModifier = { ...mockMarketSettings };
      const settingsWithModifier = {
        ...mockMarketSettings,
        outputProducts: { ...mockMarketSettings.outputProducts, priceModifier: 0.95 }
      };

      const result1x = await calculateOutputProductValue(mockProduct, settingsNoModifier);
      const result0_95x = await calculateOutputProductValue(mockProduct, settingsWithModifier);

      expect(result0_95x.totalValue).toBeApproximately(result1x.totalValue * 0.95, 0.01);
    });

    test('uses price override when available', async () => {
      const marketPricing = require('../../src/main/market-pricing');
      marketPricing.getPriceOverride.mockReturnValueOnce({ price: 60000.00 });

      const result = await calculateOutputProductValue(mockProduct, mockMarketSettings);

      expect(result.unitPrice).toBe(60000.00);
    });

    test('handles errors gracefully', async () => {
      const marketPricing = require('../../src/main/market-pricing');
      marketPricing.calculateRealisticPrice.mockRejectedValueOnce(new Error('API error'));

      const result = await calculateOutputProductValue(mockProduct, mockMarketSettings);

      expect(result.hasPrice).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.totalValue).toBe(0);
    });
  });

  describe('calculateManufacturingJobCost', () => {
    test('calculates job cost with system index', async () => {
      const result = await calculateManufacturingJobCost(810, 1, 30000142, null);

      expect(result).toBeDefined();
      expect(result.estimatedItemValue).toBeGreaterThan(0);
      expect(result.systemCostIndex).toBe(0.025);
      expect(result.jobGrossCost).toBeGreaterThan(0);
      expect(result.sccSurcharge).toBeGreaterThan(0);
      expect(result.totalJobCost).toBeGreaterThan(0);
    });

    test('applies structure cost bonus', async () => {
      const facility = {
        structureTypeId: 35825, // Raitaru
        structureBonuses: {
          structureName: 'Raitaru',
          costReduction: 3.0  // 3% cost reduction
        }
      };

      const resultNoBonus = await calculateManufacturingJobCost(810, 1, 30000142, null);
      const resultWithBonus = await calculateManufacturingJobCost(810, 1, 30000142, facility);

      expect(resultWithBonus.structureCostBonus).toBe(3.0);
      expect(resultWithBonus.jobBaseCost).toBeLessThan(resultNoBonus.jobBaseCost);
    });

    test('calculates facility tax', async () => {
      const facility = {
        structureTypeId: 35825,
        structureBonuses: { structureName: 'Raitaru', costReduction: 3.0 },
        facilityTax: 2.5  // 2.5% facility tax
      };

      const result = await calculateManufacturingJobCost(810, 1, 30000142, facility);

      expect(result.facilityTaxRate).toBe(2.5);
      expect(result.facilityTax).toBeGreaterThan(0);
    });

    test('calculates SCC surcharge (4% of EIV)', async () => {
      const result = await calculateManufacturingJobCost(810, 1, 30000142, null);

      // SCC surcharge should be 4% of EIV
      expect(result.sccSurcharge).toBeApproximately(result.estimatedItemValue * 0.04, 0.01);
    });

    test('scales job cost with multiple runs', async () => {
      const result1Run = await calculateManufacturingJobCost(810, 1, 30000142, null);
      const result10Runs = await calculateManufacturingJobCost(810, 10, 30000142, null);

      // EIV should scale linearly with runs
      expect(result10Runs.estimatedItemValue).toBeApproximately(result1Run.estimatedItemValue * 10, 1);
      expect(result10Runs.totalJobCost).toBeApproximately(result1Run.totalJobCost * 10, 1);
    });

    test('returns zero cost when no system index', async () => {
      const costIndices = require('../../src/main/esi-cost-indices');
      costIndices.getCostIndices.mockReturnValueOnce([]);

      const result = await calculateManufacturingJobCost(810, 1, 30000142, null);

      expect(result.totalJobCost).toBe(0);
      expect(result.systemCostIndex).toBe(0);
    });

    test('handles missing blueprint materials', async () => {
      const blueprintCalc = require('../../src/main/blueprint-calculator');
      blueprintCalc.getBlueprintMaterials.mockReturnValueOnce([]);

      const result = await calculateManufacturingJobCost(99999, 1, 30000142, null);

      expect(result.estimatedItemValue).toBe(0);
      expect(result.totalJobCost).toBe(0);
    });
  });

  describe('calculateManufacturingTaxes', () => {
    test('calculates taxes with no skills', () => {
      const result = calculateManufacturingTaxes(10000, 20000, 0, 0);

      expect(result).toBeDefined();
      expect(result.materialBrokerFeeRate).toBe(3.0);  // 3% base
      expect(result.materialBrokerFee).toBe(300);  // 10000 * 3%
      expect(result.effectiveSalesTaxRate).toBe(7.5);  // 7.5% base
      expect(result.productSalesTax).toBe(1500);  // 20000 * 7.5%
      expect(result.productBrokerFee).toBe(600);  // 20000 * 3%
      expect(result.totalTaxes).toBe(2400);  // 300 + 1500 + 600
    });

    test('applies Broker Relations skill reduction', () => {
      const result0 = calculateManufacturingTaxes(10000, 20000, 0, 0);
      const result5 = calculateManufacturingTaxes(10000, 20000, 0, 5);

      // Broker Relations 5 = 3% - (5 * 0.3%) = 1.5%
      expect(result5.materialBrokerFeeRate).toBeApproximately(1.5, 0.01);
      expect(result5.materialBrokerFee).toBeLessThan(result0.materialBrokerFee);
      expect(result5.productBrokerFee).toBeLessThan(result0.productBrokerFee);
    });

    test('applies Accounting skill reduction to sales tax', () => {
      const result0 = calculateManufacturingTaxes(10000, 20000, 0, 0);
      const result5 = calculateManufacturingTaxes(10000, 20000, 5, 0);

      // Accounting 5 = 7.5% * (1 - 55%) = 3.375%
      expect(result5.effectiveSalesTaxRate).toBeApproximately(3.375, 0.01);
      expect(result5.productSalesTax).toBeLessThan(result0.productSalesTax);
    });

    test('applies both skills for maximum reduction', () => {
      const result = calculateManufacturingTaxes(10000, 20000, 5, 5);

      // Accounting 5: 7.5% * (1 - 55%) = 3.375%
      // Broker Relations 5: 3% - (5 * 0.3%) = 1.5%
      expect(result.effectiveSalesTaxRate).toBeApproximately(3.375, 0.01);
      expect(result.materialBrokerFeeRate).toBeApproximately(1.5, 0.01);
      expect(result.productBrokerFeeRate).toBeApproximately(1.5, 0.01);

      // Total fees should be reduced
      expect(result.totalTaxes).toBeLessThan(2400);  // Less than no-skill baseline
    });

    test('returns complete tax breakdown', () => {
      const result = calculateManufacturingTaxes(10000, 20000, 3, 2);

      expect(result.materialsCost).toBe(10000);
      expect(result.outputValue).toBe(20000);
      expect(result.materialBrokerFee).toBeDefined();
      expect(result.productSalesTax).toBeDefined();
      expect(result.productBrokerFee).toBeDefined();
      expect(result.totalMaterialFees).toBe(result.materialBrokerFee);
      expect(result.totalProductFees).toBe(result.productSalesTax + result.productBrokerFee);
      expect(result.totalTaxes).toBe(result.materialBrokerFee + result.productSalesTax + result.productBrokerFee);
    });
  });

  describe('calculateBlueprintPricing', () => {
    const mockMaterials = {
      34: 1000,  // Tritanium
      35: 500,   // Pyerite
      36: 100    // Mexallon
    };

    const mockProduct = {
      typeID: 810,  // Scourge Missile
      quantity: 100
    };

    test('returns complete pricing breakdown', async () => {
      const result = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,  // Jita
        null,
        0,  // Accounting
        810,  // Blueprint type ID
        1,  // Runs
        0   // Broker Relations
      );

      expect(result).toBeDefined();
      expect(result.inputCosts).toBeDefined();
      expect(result.outputValue).toBeDefined();
      expect(result.jobCostBreakdown).toBeDefined();
      expect(result.taxesBreakdown).toBeDefined();
      expect(result.totalCosts).toBeGreaterThan(0);
      expect(result.profit).toBeDefined();
      expect(result.profitMargin).toBeDefined();
    });

    test('calculates profit and margin correctly', async () => {
      const result = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        null,
        0,
        810,
        1,
        0
      );

      // Profit = Output Value - Total Costs
      const expectedProfit = result.outputValue.totalValue - result.totalCosts;
      expect(result.profit).toBeApproximately(expectedProfit, 0.01);

      // Profit Margin = (Profit / Output Value) * 100
      const expectedMargin = (expectedProfit / result.outputValue.totalValue) * 100;
      expect(result.profitMargin).toBeApproximately(expectedMargin, 0.01);
    });

    test('total costs include materials, job cost, and taxes', async () => {
      const result = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        null,
        0,
        810,
        1,
        0
      );

      const expectedTotal = result.inputCosts.totalCost +
                          result.jobCostBreakdown.totalJobCost +
                          result.taxesBreakdown.totalTaxes;

      expect(result.totalCosts).toBeApproximately(expectedTotal, 0.01);
    });

    test('skills reduce total costs', async () => {
      const resultNoSkills = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        null,
        0,  // No Accounting
        810,
        1,
        0   // No Broker Relations
      );

      const resultWithSkills = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        null,
        5,  // Accounting 5
        810,
        1,
        5   // Broker Relations 5
      );

      expect(resultWithSkills.taxesBreakdown.totalTaxes).toBeLessThan(resultNoSkills.taxesBreakdown.totalTaxes);
      expect(resultWithSkills.totalCosts).toBeLessThan(resultNoSkills.totalCosts);
      expect(resultWithSkills.profit).toBeGreaterThan(resultNoSkills.profit);
    });

    test('facility reduces job costs', async () => {
      const facility = {
        structureTypeId: 35825,
        structureBonuses: {
          structureName: 'Raitaru',
          costReduction: 3.0
        },
        facilityTax: 0
      };

      const resultNoFacility = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        null,
        0,
        810,
        1,
        0
      );

      const resultWithFacility = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        facility,
        0,
        810,
        1,
        0
      );

      expect(resultWithFacility.jobCostBreakdown.jobBaseCost).toBeLessThan(resultNoFacility.jobCostBreakdown.jobBaseCost);
      expect(resultWithFacility.totalCosts).toBeLessThan(resultNoFacility.totalCosts);
    });

    test('includes legacy compatibility fields', async () => {
      const result = await calculateBlueprintPricing(
        mockMaterials,
        mockProduct,
        30000142,
        null,
        0,
        810,
        1,
        0
      );

      // Legacy fields for backwards compatibility
      expect(result.salesTax).toBe(result.taxesBreakdown.totalTaxes);
      expect(result.jobCost).toBe(result.jobCostBreakdown.totalJobCost);
    });
  });

  describe('Edge Cases', () => {
    test('handles zero material cost', async () => {
      const result = calculateManufacturingTaxes(0, 20000, 0, 0);

      expect(result.materialBrokerFee).toBe(0);
      expect(result.totalTaxes).toBeGreaterThan(0);  // Still has product fees
    });

    test('handles zero output value', async () => {
      const result = calculateManufacturingTaxes(10000, 0, 0, 0);

      expect(result.productSalesTax).toBe(0);
      expect(result.productBrokerFee).toBe(0);
      expect(result.totalTaxes).toBeGreaterThan(0);  // Still has material fees
    });

    test('handles negative profit scenario', async () => {
      const marketPricing = require('../../src/main/market-pricing');

      // Mock very low product price
      marketPricing.calculateRealisticPrice.mockImplementation((typeId) => {
        if (typeId === 810) {
          return Promise.resolve({ price: 10, method: 'vwap', confidence: 'high' });
        }
        return Promise.resolve({ price: 1000, method: 'vwap', confidence: 'high' });
      });

      const result = await calculateBlueprintPricing(
        { 34: 10000 },
        { typeID: 810, quantity: 1 },
        30000142,
        null,
        0,
        810,
        1,
        0
      );

      expect(result.profit).toBeLessThan(0);
      expect(result.profitMargin).toBeLessThan(0);
    });
  });
});
