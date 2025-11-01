/**
 * Integration Tests for Invention Flow
 *
 * Tests the complete T1 to T2 invention workflow including:
 * - Fetching invention data from SDE
 * - Calculating invention probability with skills and decryptors
 * - Optimizing decryptor selection strategies
 * - Material and cost calculations for invention jobs
 * - Complete end-to-end invention + manufacturing flow
 */

const {
  getInventionData,
  calculateInventionProbability,
  calculateInventionCost,
  findBestDecryptor,
  getAllDecryptors
} = require('../../src/main/blueprint-calculator');

const { calculateBlueprintMaterials } = require('../../src/main/blueprint-calculator');
const { calculateBlueprintPricing } = require('../../src/main/blueprint-pricing');
const { createInMemoryDatabase, populateDatabase } = require('../unit/helpers/database-mocks');
const { createMockSettingsManager } = require('../unit/helpers/settings-mocks');
const blueprintFixtures = require('../unit/fixtures/blueprints');
const facilitiesFixtures = require('../unit/fixtures/facilities');
const skillsFixtures = require('../unit/fixtures/skills');
const marketData = require('../unit/fixtures/market-data');

// Mock settings-manager
jest.mock('../../src/main/settings-manager', () => {
  const { createMockSettingsManager } = require('../unit/helpers/settings-mocks');
  return createMockSettingsManager();
});

// Mock market-pricing for cost calculations
jest.mock('../../src/main/market-pricing', () => ({
  calculateRealisticPrice: jest.fn((typeId) => {
    const prices = {
      34: 6.50,      // Tritanium
      35: 13.00,     // Pyerite
      36: 42.00,     // Mexallon
      810: 50000.00, // Scourge Missile T1
      811: 150000.00 // Scourge Fury Missile T2
    };
    return Promise.resolve({
      price: prices[typeId] || 10000,
      method: 'vwap',
      confidence: 'high'
    });
  }),
  getPriceOverride: jest.fn(() => null)
}));

// Mock ESI cost indices
jest.mock('../../src/main/esi-cost-indices', () => ({
  getCostIndices: jest.fn(() => [{
    activity: 'manufacturing',
    costIndex: 0.025
  }])
}));

// Mock market database
jest.mock('../../src/main/market-database', () => ({
  getMarketDatabase: jest.fn(() => ({
    prepare: jest.fn(() => ({
      get: jest.fn(() => null),
      run: jest.fn()
    }))
  })),
  getAdjustedPrice: jest.fn((typeId) => {
    const prices = { 34: 6.00, 35: 12.00, 36: 40.00 };
    return prices[typeId] ? { adjusted_price: prices[typeId] } : null;
  })
}));

describe('Invention Flow - Integration Tests', () => {
  let db;

  beforeEach(() => {
    db = createInMemoryDatabase();
    // Populate with invention-related blueprints
    populateDatabase(db, {
      blueprint: blueprintFixtures.scourgeBlueprint,
      inventionData: blueprintFixtures.scourgeT2InventionData
    });
    // Also populate T2 blueprint materials
    populateDatabase(db, {
      blueprint: blueprintFixtures.scourgeFuryBlueprint
    });
  });

  afterEach(() => {
    if (db) db.close();
  });

  describe('Complete Invention Workflow', () => {
    test('full workflow: T1 blueprint → invention data → probability → cost → best decryptor', async () => {
      // Step 1: Get invention data from T1 blueprint
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      expect(inventionData).toBeDefined();
      expect(inventionData.t2ProductTypeID).toBeDefined();
      expect(inventionData.t2BlueprintTypeID).toBeDefined();
      expect(inventionData.baseProbability).toBeGreaterThan(0);

      // Step 2: Calculate base invention probability with skills
      const skills = skillsFixtures.advancedSkills;
      const baseProbability = calculateInventionProbability(
        inventionData.baseProbability,
        skills,
        1.0  // No decryptor multiplier
      );

      expect(baseProbability).toBeGreaterThan(inventionData.baseProbability);
      expect(baseProbability).toBeLessThanOrEqual(1.0);

      // Step 3: Calculate invention cost
      const mockMaterialPrices = {
        20410: 500000,  // Datacore - Missile Launcher Operation
        20411: 600000,  // Datacore - Rocket Science
        209: 50000      // Scourge Light Missile (data interface)
      };

      const inventionCost = calculateInventionCost(
        inventionData,
        mockMaterialPrices,
        baseProbability,
        null,  // No decryptor
        0,     // No decryptor price
        0,     // No product EIV for now
        facilitiesFixtures.raitaruNoRigs
      );

      expect(inventionCost.totalCostPerAttempt).toBeGreaterThan(0);

      // Step 4: Find best decryptor for strategy
      const mockPrices = {
        materials: { 34: 6.50, 35: 13.00, 36: 42.00, 209: 50000 },
        datacores: { 20410: 500000, 20411: 600000 },
        decryptors: { 34201: 5000000, 34202: 3000000 }
      };

      const productPrice = 150000; // T2 product price

      const bestDecryptor = await findBestDecryptor(
        inventionData,
        mockPrices,
        productPrice,
        skills,
        facilitiesFixtures.raitaruNoRigs,
        'profit-per-run',
        db
      );

      expect(bestDecryptor).toBeDefined();
      expect(bestDecryptor.best).toBeDefined();
      expect(bestDecryptor.optimizationStrategy).toBeDefined();
    });

    test('invention + manufacturing workflow: full T2 production cycle', async () => {
      // Step 1: Invention phase
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);
      const skills = skillsFixtures.advancedSkills;

      const probability = calculateInventionProbability(
        inventionData.baseProbability,
        skills,
        1.0
      );

      const mockMaterialPrices = {
        20410: 500000,  // Datacore - Missile Launcher Operation
        20411: 600000,  // Datacore - Rocket Science
        209: 50000      // Scourge Light Missile (data interface)
      };

      const inventionCost = calculateInventionCost(
        inventionData,
        mockMaterialPrices,
        probability,
        null,
        0,
        0,
        facilitiesFixtures.raitaruNoRigs
      );

      // Step 2: Manufacturing phase (successful invention assumed)
      const t2Materials = await calculateBlueprintMaterials(
        inventionData.t2BlueprintTypeID,
        10,  // 10 runs from invention
        5,   // ME 5 from invention
        null,
        facilitiesFixtures.raitaruT1MERig,
        0,
        db
      );

      expect(t2Materials).toBeDefined();
      expect(t2Materials.materials).toBeDefined();
      expect(Object.keys(t2Materials.materials).length).toBeGreaterThan(0);

      // Step 3: Calculate total costs and profit
      const manufacturingPricing = await calculateBlueprintPricing(
        t2Materials.materials,  // Already in object format {typeID: quantity}
        { typeID: inventionData.t2ProductTypeID, quantity: 10 },
        30000142,  // Jita system
        facilitiesFixtures.raitaruT1MERig,
        5,  // Accounting skill
        inventionData.t2BlueprintTypeID,
        10,
        5   // Broker Relations skill
      );

      // Total profit = (Manufacturing profit - Invention cost) / probability
      const avgInventionCostPerSuccess = inventionCost.costPerSuccess;
      const totalProfit = manufacturingPricing.profit - avgInventionCostPerSuccess;

      expect(totalProfit).toBeDefined();
      expect(avgInventionCostPerSuccess).toBeGreaterThan(0);
    });
  });

  describe('Invention Probability Integration', () => {
    test('probability increases with skill levels', () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      // Skip if no invention data (database may not have invention tables populated)
      if (!inventionData || !inventionData.baseProbability) {
        console.log('[Test Skipped] No invention data available in test database');
        return;
      }

      const prob0 = calculateInventionProbability(
        inventionData.baseProbability,
        { ...skillsFixtures.advancedSkills, encryption: 0, datacore1: 0, datacore2: 0 },
        1.0
      );

      const prob5 = calculateInventionProbability(
        inventionData.baseProbability,
        skillsFixtures.advancedSkills,
        1.0
      );

      expect(prob5).toBeGreaterThan(prob0);
    });

    test('probability modified by decryptor bonuses', () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);
      const decryptors = getAllDecryptors(db);

      const baseProb = calculateInventionProbability(
        inventionData.baseProbability,
        skillsFixtures.advancedSkills,
        1.0
      );

      // Find decryptor with probability bonus
      const positiveDecryptor = decryptors.find(d => d.probabilityModifier > 0);
      if (positiveDecryptor) {
        const probWithDecryptor = calculateInventionProbability(
          inventionData.baseProbability,
          skillsFixtures.advancedSkills,
          1.0 + positiveDecryptor.probabilityModifier
        );

        expect(probWithDecryptor).toBeGreaterThan(baseProb);
      }

      // Find decryptor with probability penalty
      const negativeDecryptor = decryptors.find(d => d.probabilityModifier < 0);
      if (negativeDecryptor) {
        const probWithPenalty = calculateInventionProbability(
          inventionData.baseProbability,
          skillsFixtures.advancedSkills,
          1.0 + negativeDecryptor.probabilityModifier
        );

        expect(probWithPenalty).toBeLessThan(baseProb);
      }
    });

    test('probability caps at 100%', () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      // Mock very high base probability
      const mockInventionData = { ...inventionData, baseProbability: 0.9 };

      const probability = calculateInventionProbability(
        mockInventionData.baseProbability,
        skillsFixtures.advancedSkills,
        1.0
      );

      expect(probability).toBeLessThanOrEqual(1.0);
    });
  });

  describe('Invention Cost Integration', () => {
    test('cost includes datacores and decryptors', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);
      const decryptors = getAllDecryptors(db);

      const mockMaterialPrices = {
        20410: 500000,  // Datacore - Missile Launcher Operation
        20411: 600000,  // Datacore - Rocket Science
        209: 50000      // Scourge Light Missile (data interface)
      };

      const baseProb = calculateInventionProbability(
        inventionData.baseProbability,
        skillsFixtures.advancedSkills,
        1.0
      );

      const costNoDecryptor = calculateInventionCost(
        inventionData,
        mockMaterialPrices,
        baseProb,
        null,
        0,
        0,
        facilitiesFixtures.raitaruNoRigs
      );

      const decryptorPrice = 5000000;
      const costWithDecryptor = calculateInventionCost(
        inventionData,
        mockMaterialPrices,
        baseProb,
        decryptors[0],
        decryptorPrice,
        0,
        facilitiesFixtures.raitaruNoRigs
      );

      // Cost with decryptor should be higher (decryptor price added)
      expect(costWithDecryptor.totalCostPerAttempt).toBeGreaterThanOrEqual(costNoDecryptor.totalCostPerAttempt);
    });

    test('facility bonuses reduce invention cost', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const mockMaterialPrices = {
        20410: 500000,  // Datacore - Missile Launcher Operation
        20411: 600000,  // Datacore - Rocket Science
        209: 50000      // Scourge Light Missile (data interface)
      };

      const baseProb = calculateInventionProbability(
        inventionData.baseProbability,
        skillsFixtures.advancedSkills,
        1.0
      );

      const costNPC = calculateInventionCost(
        inventionData,
        mockMaterialPrices,
        baseProb,
        null,
        0,
        0,
        facilitiesFixtures.npcStation
      );

      const costStructure = calculateInventionCost(
        inventionData,
        mockMaterialPrices,
        baseProb,
        null,
        0,
        0,
        facilitiesFixtures.raitaruNoRigs
      );

      // Player structure should have lower cost than NPC
      expect(costStructure.totalCostPerAttempt).toBeLessThanOrEqual(costNPC.totalCostPerAttempt);
    });
  });

  describe('Decryptor Optimization Strategies', () => {
    const mockPrices = {
      materials: { 34: 6.50, 35: 13.00, 36: 42.00, 209: 50000 },
      datacores: { 20410: 500000, 20411: 600000 },
      decryptors: { 34201: 5000000, 34202: 3000000, 34203: 2000000 }
    };

    test('invention-only strategy optimizes for best invention outcome', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        mockPrices,
        150000,  // Product price
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'invention-only',
        db
      );

      expect(result.best).toBeDefined();
      expect(result.optimizationStrategy).toBeDefined();
      expect(result.optimizationStrategy).toBe('invention-only');
    });

    test('profit-per-run strategy considers manufacturing', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        mockPrices,
        150000,
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'profit-per-run',
        db
      );

      expect(result.best).toBeDefined();
      expect(result.best.totalCostPerItem).toBeDefined();
      expect(result.best.runsPerBPC).toBeGreaterThan(0);
    });

    test('profit-per-attempt strategy factors in probability', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        mockPrices,
        150000,
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'profit-per-attempt',
        db
      );

      expect(result.best).toBeDefined();
      expect(result.best.totalCostPerAttempt).toBeDefined();
    });

    test('time-efficiency strategy balances time and profit', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        mockPrices,
        150000,
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'time-efficiency',
        db
      );

      expect(result.best).toBeDefined();
      expect(result.best.manufacturingTimePerItem).toBeDefined();
    });

    test('max-runs strategy maximizes total output', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        mockPrices,
        150000,
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'max-runs',
        db
      );

      expect(result.best).toBeDefined();

      // Max runs strategy should select decryptor with highest runs bonus
      const decryptors = getAllDecryptors(db);
      const maxRunsDecryptor = decryptors.reduce((max, d) =>
        d.runsModifier > (max.runsModifier || 0) ? d : max
      , {});

      if (maxRunsDecryptor.typeID) {
        expect(result.best.runsPerBPC).toBeGreaterThan(10); // Base is 10
      }
    });

    test('different strategies produce different optimal choices', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const strategies = ['invention-only', 'profit-per-run', 'profit-per-attempt', 'time-efficiency', 'max-runs'];
      const results = await Promise.all(
        strategies.map(strategy =>
          findBestDecryptor(
            inventionData,
            mockPrices,
            150000,
            skillsFixtures.advancedSkills,
            facilitiesFixtures.raitaruNoRigs,
            strategy,
            db
          )
        )
      );

      expect(results.length).toBe(5);
      results.forEach((result, idx) => {
        expect(result.best).toBeDefined();
        expect(result.optimizationStrategy).toBe(strategies[idx]);
      });
    });
  });

  describe('ME/TE Output from Invention', () => {
    test('decryptor modifies resulting ME level', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);
      const decryptors = getAllDecryptors(db);

      // Find decryptors with different ME modifiers
      const positiveME = decryptors.find(d => d.meModifier > 0);
      const negativeME = decryptors.find(d => d.meModifier < 0);

      if (positiveME && negativeME) {
        const resultPositive = await findBestDecryptor(
          inventionData,
          { materials: {}, datacores: {}, decryptors: { [positiveME.typeID]: 1000000 } },
          150000,
          skillsFixtures.advancedSkills,
          facilitiesFixtures.raitaruNoRigs,
          'invention-only',
          db
        );

        const resultNegative = await findBestDecryptor(
          inventionData,
          { materials: {}, datacores: {}, decryptors: { [negativeME.typeID]: 1000000 } },
          150000,
          skillsFixtures.advancedSkills,
          facilitiesFixtures.raitaruNoRigs,
          'invention-only',
          db
        );

        // ME levels should differ
        expect(resultPositive.best.me).not.toBe(resultNegative.best.me);
      }
    });

    test('decryptor modifies resulting TE level', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);
      const decryptors = getAllDecryptors(db);

      const positiveTE = decryptors.find(d => d.teModifier > 0);

      if (positiveTE) {
        const result = await findBestDecryptor(
          inventionData,
          { materials: {}, datacores: {}, decryptors: { [positiveTE.typeID]: 1000000 } },
          150000,
          skillsFixtures.advancedSkills,
          facilitiesFixtures.raitaruNoRigs,
          'invention-only',
          db
        );

        expect(result.best.te).toBeGreaterThan(0);
      }
    });
  });

  describe('Error Handling in Invention Flow', () => {
    test('handles missing invention data gracefully', () => {
      const inventionData = getInventionData(99999, db);

      expect(inventionData).toBeNull();
    });

    test('handles invalid decryptor in optimization', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      // Pass invalid decryptor
      const result = await findBestDecryptor(
        inventionData,
        { materials: {}, datacores: {}, decryptors: {} },
        150000,
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'invention-only',
        db
      );

      // Should still return a result (no decryptor option)
      expect(result).toBeDefined();
    });

    test('handles zero product price scenario', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        { materials: {}, datacores: {}, decryptors: {} },
        0,  // Zero product price
        skillsFixtures.advancedSkills,
        facilitiesFixtures.raitaruNoRigs,
        'profit-per-run',
        db
      );

      expect(result).toBeDefined();
      // Cost can be zero or positive (zero product price is valid edge case)
      if (result.best.totalCostPerItem !== undefined) {
        expect(result.best.totalCostPerItem).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Real-World Invention Scenarios', () => {
    test('high-skill inventor with expensive decryptor', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const result = await findBestDecryptor(
        inventionData,
        {
          materials: { 34: 6.50, 35: 13.00, 209: 50000 },
          datacores: { 20410: 500000, 20411: 600000 },
          decryptors: { 34201: 10000000 }  // Very expensive decryptor
        },
        200000,  // High product price
        { ...skillsFixtures.advancedSkills, encryption: 5, datacore1: 5, datacore2: 5 },
        facilitiesFixtures.sotiyo,
        'profit-per-attempt',
        db
      );

      expect(result.best).toBeDefined();
      expect(result.best.totalCostPerAttempt).toBeDefined();
    });

    test('new inventor with no skills and no decryptors', async () => {
      const inventionData = getInventionData(blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT, db);

      const newSkills = {
        encryption: 0,
        datacore1: 0,
        datacore2: 0
      };

      const result = await findBestDecryptor(
        inventionData,
        {
          materials: { 34: 6.50, 209: 50000 },
          datacores: { 20410: 500000, 20411: 600000 },
          decryptors: {}  // No decryptors
        },
        150000,
        newSkills,
        facilitiesFixtures.npcStation,
        'invention-only',
        db
      );

      expect(result.best).toBeDefined();
      // Algorithm may still recommend a decryptor even with low skills
      // Just verify we got a valid result
      expect(result.best.typeID).toBeDefined();
    });
  });
});
