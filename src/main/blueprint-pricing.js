const { calculateRealisticPrice, getPriceOverride } = require('./market-pricing');
const { getCostIndices } = require('./esi-cost-indices');
const { getMarketSettings } = require('./settings-manager');

/**
 * Manufacturing activity type for cost indices
 */
const MANUFACTURING_ACTIVITY = 'manufacturing';

/**
 * Get the location settings for input materials (buying)
 * @param {Object} marketSettings - Market settings object
 * @returns {Object} Location object with regionId, locationId, systemId, locationType
 */
function getInputLocation(marketSettings) {
  const input = marketSettings.inputMaterials;
  return {
    regionId: input.regionId ?? marketSettings.regionId,
    locationId: input.locationId ?? marketSettings.locationId,
    systemId: input.systemId ?? marketSettings.systemId,
    locationType: input.locationType ?? marketSettings.locationType,
  };
}

/**
 * Get the location settings for output products (selling)
 * Falls back to input location if useSameLocation is true
 * @param {Object} marketSettings - Market settings object
 * @returns {Object} Location object with regionId, locationId, systemId, locationType
 */
function getOutputLocation(marketSettings) {
  const output = marketSettings.outputProducts;
  if (output.useSameLocation) {
    return getInputLocation(marketSettings);
  }
  return {
    regionId: output.regionId ?? marketSettings.regionId,
    locationId: output.locationId ?? marketSettings.locationId,
    systemId: output.systemId ?? marketSettings.systemId,
    locationType: output.locationType ?? marketSettings.locationType,
  };
}

/**
 * Get unique region IDs from both input and output locations
 * Used for determining which regions need to be refreshed
 * @param {Object} marketSettings - Market settings object
 * @returns {Array<number>} Array of unique region IDs
 */
function getUniqueRegions(marketSettings) {
  const input = getInputLocation(marketSettings);
  const output = getOutputLocation(marketSettings);
  const regions = new Set([input.regionId]);
  if (output.regionId !== input.regionId) {
    regions.add(output.regionId);
  }
  return Array.from(regions);
}

/**
 * Calculate the price for input materials
 * @param {Object} materials - Object with typeId keys and quantity values
 * @param {Object} marketSettings - Market settings object
 * @returns {Promise<Object>} Material pricing details
 */
async function calculateInputMaterialsCost(materials, marketSettings) {
  const inputSettings = marketSettings.inputMaterials;
  const inputLocation = getInputLocation(marketSettings);
  const regionId = inputLocation.regionId;
  const locationId = inputLocation.locationId;

  const materialPrices = {};
  let totalCost = 0;
  let itemsWithPrices = 0;
  let itemsWithoutPrices = 0;

  for (const [typeId, quantity] of Object.entries(materials)) {
    const typeIdNum = parseInt(typeId);

    try {
      // Check for price override first
      const override = getPriceOverride(typeIdNum);
      let price = 0;

      if (override && override.price) {
        price = override.price;
      } else {
        // Calculate realistic price based on user settings
        const priceResult = await calculateRealisticPrice(
          typeIdNum,
          regionId,
          locationId,
          inputSettings.priceType || 'sell',
          quantity,
          inputSettings
        );
        price = priceResult.price || 0;
      }

      // Apply price modifier
      const modifier = inputSettings.priceModifier || 1;
      const finalPrice = price * modifier;

      materialPrices[typeId] = {
        quantity,
        unitPrice: finalPrice,
        totalPrice: finalPrice * quantity,
        hasPrice: price > 0
      };

      if (price > 0) {
        totalCost += finalPrice * quantity;
        itemsWithPrices++;
      } else {
        itemsWithoutPrices++;
      }
    } catch (error) {
      console.error(`Error calculating price for material ${typeId}:`, error);
      materialPrices[typeId] = {
        quantity,
        unitPrice: 0,
        totalPrice: 0,
        hasPrice: false,
        error: error.message
      };
      itemsWithoutPrices++;
    }
  }

  return {
    materialPrices,
    totalCost,
    itemsWithPrices,
    itemsWithoutPrices,
    allPricesAvailable: itemsWithoutPrices === 0
  };
}

/**
 * Calculate the value of output products
 * @param {Object} product - Product object with typeID and quantity
 * @param {Object} marketSettings - Market settings object
 * @returns {Promise<Object>} Product value details
 */
async function calculateOutputProductValue(product, marketSettings) {
  const outputSettings = marketSettings.outputProducts;
  const outputLocation = getOutputLocation(marketSettings);
  const regionId = outputLocation.regionId;
  const locationId = outputLocation.locationId;

  try {
    // Check for price override first
    const override = getPriceOverride(product.typeID);
    let price = 0;

    if (override && override.price) {
      price = override.price;
    } else {
      // Calculate realistic price based on user settings
      const priceResult = await calculateRealisticPrice(
        product.typeID,
        regionId,
        locationId,
        outputSettings.priceType || 'sell',
        product.quantity,
        outputSettings
      );
      price = priceResult.price || 0;
    }

    // Apply price modifier
    const modifier = outputSettings.priceModifier || 1;
    const finalPrice = price * modifier;

    return {
      typeID: product.typeID,
      quantity: product.quantity,
      unitPrice: finalPrice,
      totalValue: finalPrice * product.quantity,
      hasPrice: price > 0
    };
  } catch (error) {
    console.error(`Error calculating price for product ${product.typeID}:`, error);
    return {
      typeID: product.typeID,
      quantity: product.quantity,
      unitPrice: 0,
      totalValue: 0,
      hasPrice: false,
      error: error.message
    };
  }
}

/**
 * Calculate manufacturing job cost breakdown
 * Job costs in EVE are calculated as:
 * Job Gross Cost = EIV × System Cost Index
 * Job Base Cost = Job Gross Cost × (1 - Structure Bonus)
 * Facility Tax = EIV × Facility Tax Rate
 * SCC Surcharge = EIV × 0.04 (4% of estimated item value)
 * Total Job Cost = Job Base Cost + Facility Tax + SCC Surcharge
 *
 * where EIV (Estimated Item Value) is calculated from base materials at ME 0 using adjusted prices
 *
 * @param {number} blueprintTypeId - Blueprint type ID
 * @param {number} runs - Number of production runs
 * @param {number} systemId - Solar system ID
 * @param {Object} facility - Facility info (optional, for structure bonuses and tax rate)
 * @returns {Promise<Object>} Job cost breakdown
 */
async function calculateManufacturingJobCost(blueprintTypeId, runs, systemId, facility = null) {
  // Get system cost index for manufacturing
  const costIndices = getCostIndices(systemId);
  const manufacturingIndex = costIndices.find(idx => idx.activity === MANUFACTURING_ACTIVITY);
  const jobCostObj = {
      estimatedItemValue: 0,
      systemCostIndex: 0,
      jobGrossCost: 0,
      structureRollBonus: 0,
      jobBaseCost: 0,
      facilityTax: 0,
      facilityTaxRate: 0,
      sccSurcharge: 0,
      totalJobCost: 0
  };

  if (!manufacturingIndex || manufacturingIndex.costIndex === 0) {
    console.log(`No manufacturing cost index for system ${systemId}, returning 0 job cost`);
    return jobCostObj;
  }
  jobCostObj.systemCostIndex = manufacturingIndex.costIndex;

  // Calculate EIV (Estimated Item Value) from base materials at ME 0
  // EIV = sum of (adjusted_price × quantity) for each base material
  let estimatedItemValue = 0;
  try {
    const { getBlueprintMaterials } = require('./blueprint-calculator');
    const { getAdjustedPrice } = require('./market-database');

    // Get base materials at ME 0 (no reductions)
    const baseMaterials = getBlueprintMaterials(blueprintTypeId);

    if (!baseMaterials || baseMaterials.length === 0) {
      console.warn(`No materials found for blueprint ${blueprintTypeId}`);
      return jobCostObj;
    }

    // Calculate EIV from base materials × runs × adjusted prices
    for (const material of baseMaterials) {
      const adjustedPriceData = getAdjustedPrice(material.typeID);

      if (adjustedPriceData && adjustedPriceData.adjusted_price) {
        const materialValue = adjustedPriceData.adjusted_price * material.quantity * runs;
        estimatedItemValue += materialValue;
        console.log(`Material ${material.typeID}: ${material.quantity} × ${runs} runs × ${adjustedPriceData.adjusted_price} ISK = ${materialValue} ISK`);
      } else {
        console.warn(`No adjusted price found for material ${material.typeID}, excluding from EIV`);
        // CCP's EIV calculation excludes items without adjusted prices
      }
    }

    console.log(`Total EIV for blueprint ${blueprintTypeId} (${runs} runs): ${estimatedItemValue} ISK`);
  } catch (error) {
    console.error(`Error calculating EIV for blueprint ${blueprintTypeId}:`, error);
  }
  jobCostObj.estimatedItemValue = estimatedItemValue;

  // Job Gross Cost = EIV × System Cost Index
  const jobGrossCost = estimatedItemValue * manufacturingIndex.costIndex;
  jobCostObj.jobGrossCost = jobGrossCost;

  // Structure cost bonus (cost reduction from structure type)
  // NPC stations = 0%, Player structures vary by type (Raitaru: 3%, Azbel: 4%, Sotiyo: 5%)
  let structureCostBonus = 0; // Percentage reduction
  if (facility && facility.structureTypeId && facility.structureBonuses) {
    // Use the cost reduction from the facility's structure bonuses
    structureCostBonus = facility.structureBonuses.costReduction || 0;
    console.log(`Using structure cost bonus: ${structureCostBonus}% for ${facility.structureBonuses.structureName}`);
  }
  jobCostObj.structureRollBonus = structureCostBonus;

  // Job Base Cost = Job Gross Cost × (1 - Structure Bonus%)
  const jobBaseCost = jobGrossCost * (1 - structureCostBonus / 100);
  jobCostObj.jobBaseCost = jobBaseCost;

  // Facility tax rate (set by structure owner in player structures)
  // NPC stations: 0.25%, Player structures: variable (typically 0-10%)
  let facilityTaxRate = 0.25; // Default for NPC stations

  if (facility) {
    if (facility.facilityTax !== undefined) {
      // Use explicit facility tax if set
      facilityTaxRate = facility.facilityTax;
    } else if (facility.structureTypeId) {
      // Player structure without explicit tax - default to 0%
      facilityTaxRate = 0;
    }
  }
  jobCostObj.facilityTaxRate = facilityTaxRate;

  // Facility Tax = EIV × Facility Tax Rate
  const facilityTax = estimatedItemValue * (facilityTaxRate / 100);
  jobCostObj.facilityTax = facilityTax;

  // SCC Surcharge = 4% of Estimated Item Value
  const sccSurcharge = estimatedItemValue * 0.04;
  jobCostObj.sccSurcharge = sccSurcharge;

  // Total Job Cost
  jobCostObj.totalJobCost = jobBaseCost + facilityTax + sccSurcharge;

  return jobCostObj;
}

/**
 * Calculate trading fees for manufacturing
 * Material Purchase Fees: Broker's fee on buying materials (3% base, -0.3% per Broker Relations level)
 * Product Selling Fees: Sales tax (7.5% base, -11% per Accounting level) + Broker's fee (3% base, -0.3% per Broker Relations level)
 * @param {number} materialsCost - Total cost of materials
 * @param {number} outputValue - Total value of output product
 * @param {number} accountingSkillLevel - Accounting skill level (0-5)
 * @param {number} brokerRelationsSkillLevel - Broker Relations skill level (0-5)
 * @returns {Object} Tax breakdown with all fees
 */
function calculateManufacturingTaxes(materialsCost, outputValue, accountingSkillLevel = 0, brokerRelationsSkillLevel = 0) {
  // Broker Relations skill affects both buying and selling
  const baseBrokerFeeRate = 3.0; // 3%
  const brokerFeeReduction = brokerRelationsSkillLevel * 0.3; // 0.3% per level
  const effectiveBrokerFeeRate = baseBrokerFeeRate - brokerFeeReduction;

  // Material Purchase Fees: Broker's fee on buying materials
  const materialBrokerFee = materialsCost * (effectiveBrokerFeeRate / 100);

  // Product Selling Fees: Sales tax + Broker's fee on selling products
  const baseSalesTaxRate = 7.5; // 7.5%
  const salesTaxReduction = accountingSkillLevel * 11.0; // 11% per level
  const effectiveSalesTaxRate = baseSalesTaxRate * (1 - salesTaxReduction / 100);
  const productSalesTax = outputValue * (effectiveSalesTaxRate / 100);
  const productBrokerFee = outputValue * (effectiveBrokerFeeRate / 100);

  return {
    // Material Purchase Fees (broker's fee on buying)
    materialsCost,
    materialBrokerFeeRate: effectiveBrokerFeeRate,
    materialBrokerFee,

    // Product Selling Fees (sales tax + broker's fee on selling)
    outputValue,
    baseSalesTaxRate,
    accountingSkillLevel,
    effectiveSalesTaxRate,
    productSalesTax,
    productBrokerFeeRate: effectiveBrokerFeeRate,
    productBrokerFee,
    brokerRelationsSkillLevel,

    // Totals
    totalMaterialFees: materialBrokerFee,
    totalProductFees: productSalesTax + productBrokerFee,
    totalTaxes: materialBrokerFee + productSalesTax + productBrokerFee
  };
}

/**
 * Calculate complete pricing breakdown for a blueprint
 * @param {Object} materials - Object with material typeIds and quantities
 * @param {Object} product - Product object with typeID and quantity
 * @param {number} systemId - Solar system ID for job cost calculation
 * @param {Object} facility - Facility info (optional)
 * @param {number} accountingSkillLevel - Accounting skill level (0-5)
 * @param {number} blueprintTypeId - Blueprint type ID (for EIV calculation)
 * @param {number} runs - Number of production runs (for EIV calculation)
 * @param {number} brokerRelationsSkillLevel - Broker Relations skill level (0-5)
 * @returns {Promise<Object>} Complete pricing breakdown
 */
async function calculateBlueprintPricing(materials, product, systemId, facility = null, accountingSkillLevel = 0, blueprintTypeId = null, runs = 1, brokerRelationsSkillLevel = 0) {
  const marketSettings = getMarketSettings();

  // Calculate input material costs
  const inputCosts = await calculateInputMaterialsCost(materials, marketSettings);

  // Calculate output product value
  const outputValue = await calculateOutputProductValue(product, marketSettings);

  // Calculate job cost breakdown (installation fees)
  const jobCostBreakdown = await calculateManufacturingJobCost(blueprintTypeId, runs, systemId, facility);

  // Calculate taxes (sales tax on materials and broker's fee on products)
  const taxesBreakdown = calculateManufacturingTaxes(
    inputCosts.totalCost,
    outputValue.totalValue,
    accountingSkillLevel,
    brokerRelationsSkillLevel
  );

  // Calculate totals
  const totalCosts = inputCosts.totalCost + jobCostBreakdown.totalJobCost + taxesBreakdown.totalTaxes;
  const profit = outputValue.totalValue - totalCosts;
  const profitMargin = outputValue.totalValue > 0 ? (profit / outputValue.totalValue) * 100 : 0;

  return {
    inputCosts,
    outputValue,
    jobCostBreakdown,
    taxesBreakdown,
    // Legacy fields for backwards compatibility
    salesTax: taxesBreakdown.totalTaxes, // Total of all trading fees
    totalCosts,
    profit,
    profitMargin,
    // Legacy field for backwards compatibility
    jobCost: jobCostBreakdown.totalJobCost
  };
}

module.exports = {
  calculateInputMaterialsCost,
  calculateOutputProductValue,
  calculateManufacturingJobCost,
  calculateManufacturingTaxes,
  calculateBlueprintPricing,
  getInputLocation,
  getOutputLocation,
  getUniqueRegions,
};
