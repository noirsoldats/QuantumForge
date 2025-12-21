/**
 * Reaction Calculator Module
 * Handles Eve Online reaction calculations (activityID = 11)
 * Recursively expands reaction chains to raw moon materials
 */

const { getDatabase } = require('./sde-database');
const { getSdePath } = require('./sde-manager');
const Database = require('better-sqlite3');

// In-memory caches
const typeNameCache = new Map();
const reactionTreeCache = new Map();
const MAX_CACHE_SIZE = 100;
const MAX_RECURSION_DEPTH = 10;

/**
 * Search for reaction formulas by name
 * @param {string} searchTerm - Search term
 * @param {number} limit - Max results (default 20)
 * @returns {Promise<Array>} Matching reaction formulas with products
 */
async function searchReactions(searchTerm, limit = 20) {
  return new Promise((resolve, reject) => {
    getDatabase().then(db => {
      const query = `
        SELECT DISTINCT
          it.typeID,
          it.typeName,
          iap.productTypeID,
          pt.typeName as productName,
          iap.quantity as productQuantity
        FROM invTypes it
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 11
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        WHERE it.typeName LIKE ?
          AND it.published = 1
        ORDER BY it.typeName
        LIMIT ?
      `;

      db.all(query, [`%${searchTerm}%`, limit], (err, rows) => {
        if (err) {
          console.error('Error searching reactions:', err);
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    }).catch(reject);
  });
}

/**
 * Get reaction input materials (activityID=11)
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {object} db - Optional database connection
 * @returns {Promise<Array>} Materials [{typeID, quantity, typeName}]
 */
async function getReactionMaterials(reactionTypeId, db = null) {
  const ownConnection = !db;

  if (!db) {
    db = await getDatabase();
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        iam.materialTypeID as typeID,
        iam.quantity,
        it.typeName
      FROM industryActivityMaterials iam
      JOIN invTypes it ON iam.materialTypeID = it.typeID
      WHERE iam.typeID = ? AND iam.activityID = 11
      ORDER BY iam.quantity DESC
    `;

    db.all(query, [reactionTypeId], (err, rows) => {
      if (err) {
        console.error('Error getting reaction materials:', err);
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
}

/**
 * Get reaction output product (activityID=11)
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {object} db - Optional database connection
 * @returns {Promise<Object|null>} Product {typeID, quantity, typeName}
 */
async function getReactionProduct(reactionTypeId, db = null) {
  const ownConnection = !db;

  if (!db) {
    db = await getDatabase();
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        iap.productTypeID as typeID,
        iap.quantity,
        pt.typeName
      FROM industryActivityProducts iap
      JOIN invTypes pt ON iap.productTypeID = pt.typeID
      WHERE iap.typeID = ? AND iap.activityID = 11
      LIMIT 1
    `;

    db.get(query, [reactionTypeId], (err, row) => {
      if (err) {
        console.error('Error getting reaction product:', err);
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
}

/**
 * Get reaction time in seconds
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {object} db - Optional database connection
 * @returns {Promise<number>} Reaction time in seconds
 */
async function getReactionTime(reactionTypeId, db = null) {
  const ownConnection = !db;

  if (!db) {
    db = await getDatabase();
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT time
      FROM industryActivity
      WHERE typeID = ? AND activityID = 11
    `;

    db.get(query, [reactionTypeId], (err, row) => {
      if (err) {
        console.error('Error getting reaction time:', err);
        reject(err);
      } else {
        resolve(row ? row.time : 3600);
      }
    });
  });
}

/**
 * Find reaction formula that produces a given typeId
 * @param {number} typeId - Product type ID
 * @param {object} db - Optional database connection
 * @returns {Promise<number|null>} Reaction formula typeID if exists, null otherwise
 */
async function getReactionForProduct(typeId, db = null) {
  const ownConnection = !db;

  if (!db) {
    db = await getDatabase();
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT typeID as reactionTypeID
      FROM industryActivityProducts
      WHERE productTypeID = ? AND activityID = 11
      LIMIT 1
    `;

    db.get(query, [typeId], (err, row) => {
      if (err) {
        console.error('Error finding reaction for product:', err);
        reject(err);
      } else {
        resolve(row ? row.reactionTypeID : null);
      }
    });
  });
}

/**
 * Get type name from cache or database
 * @param {number} typeId - Type ID
 * @param {object} db - Optional database connection
 * @returns {Promise<string>} Type name
 */
async function getTypeName(typeId, db = null) {
  // Check cache first
  if (typeNameCache.has(typeId)) {
    return typeNameCache.get(typeId);
  }

  const ownConnection = !db;

  if (!db) {
    db = await getDatabase();
  }

  return new Promise((resolve, reject) => {
    const query = `SELECT typeName FROM invTypes WHERE typeID = ?`;

    db.get(query, [typeId], (err, row) => {
      if (err) {
        console.error('Error getting type name:', err);
        reject(err);
      } else {
        const typeName = row ? row.typeName : `Unknown Type ${typeId}`;

        // Cache the result
        typeNameCache.set(typeId, typeName);

        // Limit cache size
        if (typeNameCache.size > MAX_CACHE_SIZE) {
          const firstKey = typeNameCache.keys().next().value;
          typeNameCache.delete(firstKey);
        }

        resolve(typeName);
      }
    });
  });
}

/**
 * Get reaction rig bonuses from SDE
 * Reactions use different attribute IDs than manufacturing
 * @param {number} rigTypeId - Rig type ID
 * @returns {Object} {materialBonus, timeBonus}
 */
function getReactionRigBonuses(rigTypeId) {
  try {
    const dbPath = getSdePath();
    const db = new Database(dbPath, { readonly: true });

    // Reaction-specific attributes:
    // attributeID 2714 = Material Reduction Bonus (for reactions)
    // attributeID 2713 = Time Bonus (for reactions)
    const attributes = db.prepare(`
      SELECT attributeID, valueFloat, valueInt
      FROM dgmTypeAttributes
      WHERE typeID = ? AND attributeID IN (2713, 2714)
    `).all(rigTypeId);

    db.close();

    const bonuses = {
      materialBonus: 0,
      timeBonus: 0
    };

    attributes.forEach(attr => {
      const value = attr.valueFloat !== null ? attr.valueFloat : attr.valueInt;

      // Reaction rigs store bonuses as negative values (e.g., -2.0 for 2% reduction)
      if (attr.attributeID === 2714) {
        bonuses.materialBonus = value || 0;
      } else if (attr.attributeID === 2713) {
        bonuses.timeBonus = value || 0;
      }
    });

    return bonuses;
  } catch (error) {
    console.error('Error getting reaction rig bonuses from SDE:', error);
    return { materialBonus: 0, timeBonus: 0 };
  }
}

/**
 * Calculate total material bonus from reaction rigs
 * @param {Array} rigs - Array of rig objects
 * @param {number} securityStatus - System security status
 * @returns {number} Total material bonus (negative = reduction)
 */
function getReactionRigMaterialBonus(rigs, securityStatus = 0.5) {
  if (!rigs || rigs.length === 0) {
    return 0;
  }

  // Security multipliers for reaction rigs
  let securityMultiplier = 1.0;
  if (securityStatus >= 0.5) {
    securityMultiplier = 1.0; // Highsec
  } else if (securityStatus > 0.0) {
    securityMultiplier = 1.0; // Lowsec (same as highsec for reaction rigs)
  } else {
    securityMultiplier = 1.1; // Nullsec/WH (10% better)
  }

  let totalBonus = 0;

  for (const rig of rigs) {
    const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
    const rigBonuses = getReactionRigBonuses(rigTypeId);

    if (rigBonuses.materialBonus !== 0) {
      // Apply security multiplier to the bonus
      totalBonus += rigBonuses.materialBonus * securityMultiplier;
    }
  }

  return totalBonus;
}

/**
 * Calculate total time bonus from reaction rigs
 * @param {Array} rigs - Array of rig objects
 * @param {number} securityStatus - System security status
 * @returns {number} Total time bonus (negative = reduction)
 */
function getReactionRigTimeBonus(rigs, securityStatus = 0.5) {
  if (!rigs || rigs.length === 0) {
    return 0;
  }

  // Security multipliers for reaction rigs
  let securityMultiplier = 1.0;
  if (securityStatus >= 0.5) {
    securityMultiplier = 1.0; // Highsec
  } else if (securityStatus > 0.0) {
    securityMultiplier = 1.0; // Lowsec
  } else {
    securityMultiplier = 1.1; // Nullsec/WH (10% better)
  }

  let totalBonus = 0;

  for (const rig of rigs) {
    const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
    const rigBonuses = getReactionRigBonuses(rigTypeId);

    if (rigBonuses.timeBonus !== 0) {
      // Apply security multiplier to the bonus
      totalBonus += rigBonuses.timeBonus * securityMultiplier;
    }
  }

  return totalBonus;
}

/**
 * Calculate material quantity with facility bonuses
 * Reactions do NOT use ME levels - only facility/rig bonuses
 * @param {number} baseQuantity - Base material quantity
 * @param {number} runs - Number of runs
 * @param {Object} facility - Facility with bonuses
 * @param {number} productTypeId - Product type ID (for rig matching)
 * @returns {number} Adjusted quantity
 */
function calculateReactionMaterialQuantity(baseQuantity, runs, facility = null, productTypeId = null) {
  let quantity = runs * baseQuantity;

  // Apply structure bonus (Athanor/Tatara: 2% ME reduction)
  if (facility && facility.structureTypeId) {
    // Athanor (35835) or Tatara (35836) both have 2% ME
    if (facility.structureTypeId === 35835 || facility.structureTypeId === 35836) {
      quantity = quantity * 0.98; // 2% reduction
    }
  }

  // Apply rig bonuses (if facility has rigs)
  if (facility && facility.rigs && facility.rigs.length > 0) {
    const securityStatus = facility.securityStatus ?? 0.5;
    const rigBonus = getReactionRigMaterialBonus(facility.rigs, securityStatus);

    if (rigBonus !== 0) {
      // Rig bonus is negative (e.g., -2.0 for 2% reduction)
      // Apply as: quantity * (1 + bonus/100)
      // Example: -2.0 → (1 + (-2.0)/100) = 0.98 (2% reduction)
      quantity = quantity * (1 + rigBonus / 100);
    }
  }

  // Eve Online rule: quantity cannot be less than runs
  return Math.max(runs, Math.ceil(quantity));
}

/**
 * Calculate reaction job cost and taxes
 * Reactions use the same formula as manufacturing:
 * Job Base Cost = EIV × 2%
 * Job Gross Cost = Job Base Cost × System Cost Index × (1 - Structure Cost Bonus)
 * Facility Tax = Job Base Cost × Facility Tax Rate
 * SCC Surcharge = Job Base Cost × 4%
 * Total Job Cost = Job Gross Cost + Facility Tax + SCC Surcharge
 *
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {number} runs - Number of runs
 * @param {Object} materials - Materials object with typeID keys
 * @param {Object} facility - Facility configuration
 * @returns {Object} Job cost breakdown
 */
async function calculateReactionJobCost(reactionTypeId, runs, materials, facility = null) {
  const jobCostObj = {
    estimatedItemValue: 0,
    systemCostIndex: 0,
    jobGrossCost: 0,
    structureCostBonus: 0,
    jobBaseCost: 0,
    facilityTax: 0,
    facilityTaxRate: 0,
    sccSurcharge: 0,
    totalJobCost: 0
  };

  if (!facility || !facility.systemId) {
    return jobCostObj;
  }

  // Get system cost index for reactions
  const { getCostIndices } = require('./esi-cost-indices');
  const costIndices = getCostIndices(facility.systemId);
  const reactionIndex = costIndices.find(idx => idx.activity === 'reaction');

  if (!reactionIndex || reactionIndex.costIndex === 0) {
    console.log(`No reaction cost index for system ${facility.systemId}, returning 0 job cost`);
    return jobCostObj;
  }
  jobCostObj.systemCostIndex = reactionIndex.costIndex;

  // Calculate EIV (Estimated Item Value) from materials using adjusted prices
  let estimatedItemValue = 0;
  try {
    const { getAdjustedPrice } = require('./market-database');

    for (const [typeId, quantity] of Object.entries(materials)) {
      const typeIdNum = parseInt(typeId);
      const adjustedPriceData = getAdjustedPrice(typeIdNum);

      if (adjustedPriceData && adjustedPriceData.adjusted_price) {
        const materialValue = adjustedPriceData.adjusted_price * quantity;
        estimatedItemValue += materialValue;
      }
    }

    console.log(`[Reaction Job Cost] EIV for reaction ${reactionTypeId} (${runs} runs): ${estimatedItemValue} ISK`);
  } catch (error) {
    console.error(`Error calculating EIV for reaction ${reactionTypeId}:`, error);
  }
  jobCostObj.estimatedItemValue = estimatedItemValue;

  // Job Base Cost = EIV × 2%
  const jobBaseCost = estimatedItemValue * 0.02;

  // Structure cost bonus (Athanor: 0%, Tatara: 0% - refineries don't have cost bonuses)
  let structureCostBonus = 0;
  jobCostObj.structureCostBonus = structureCostBonus;

  // Job Gross Cost = Job Base Cost × System Cost Index × (1 - Structure Bonus)
  const jobGrossCost = jobBaseCost * reactionIndex.costIndex * (1 - structureCostBonus / 100);
  jobCostObj.jobGrossCost = jobGrossCost;
  jobCostObj.jobBaseCost = jobBaseCost;

  // Facility tax rate
  let facilityTaxRate = 0.25; // Default for NPC stations

  if (facility) {
    if (facility.facilityTax !== undefined) {
      facilityTaxRate = facility.facilityTax;
    } else if (facility.structureTypeId) {
      // Player structure without explicit tax - default to 0%
      facilityTaxRate = 0;
    }
  }
  jobCostObj.facilityTaxRate = facilityTaxRate;

  // Facility Tax = Job Base Cost × Facility Tax Rate
  const facilityTax = jobBaseCost * (facilityTaxRate / 100);
  jobCostObj.facilityTax = facilityTax;

  // SCC Surcharge = Job Base Cost × 4%
  const sccSurcharge = jobBaseCost * 0.04;
  jobCostObj.sccSurcharge = sccSurcharge;

  // Total Job Cost
  jobCostObj.totalJobCost = jobGrossCost + facilityTax + sccSurcharge;

  console.log(`[Reaction Job Cost] Total job cost: ${jobCostObj.totalJobCost} ISK`);

  return jobCostObj;
}

/**
 * Calculate reaction time with facility bonuses
 * @param {number} baseTime - Base reaction time in seconds
 * @param {number} runs - Number of runs
 * @param {Object} facility - Facility with bonuses
 * @returns {number} Total time in seconds
 */
function calculateReactionTime(baseTime, runs, facility = null) {
  let timePerRun = baseTime;

  // Apply structure bonus (Tatara has 25% TE reduction, Athanor has no TE bonus)
  if (facility && facility.structureTypeId) {
    // Tatara (35836) has 25% TE reduction
    if (facility.structureTypeId === 35836) {
      timePerRun = timePerRun * 0.75; // 25% reduction
    }
    // Athanor (35835) has no TE bonus for reactions
  }

  // Apply rig bonuses (if facility has rigs)
  if (facility && facility.rigs && facility.rigs.length > 0) {
    const securityStatus = facility.securityStatus ?? 0.5;
    const rigBonus = getReactionRigTimeBonus(facility.rigs, securityStatus);

    if (rigBonus !== 0) {
      // Rig bonus is negative (e.g., -20.0 for 20% reduction)
      // Apply as: time * (1 + bonus/100)
      // Example: -20.0 → (1 + (-20.0)/100) = 0.80 (20% reduction)
      timePerRun = timePerRun * (1 + rigBonus / 100);
    }
  }

  return Math.ceil(timePerRun * runs);
}

/**
 * Calculate reaction materials with recursive tree expansion
 * ALWAYS expands to raw materials - no toggle
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {number} runs - Number of reaction runs
 * @param {number} characterId - Character ID (for future skill bonuses)
 * @param {Object} facility - Refinery facility configuration
 * @param {number} depth - Recursion depth (internal)
 * @param {object} db - Optional database connection
 * @returns {Promise<Object>} {materials: {typeId: qty}, tree: [...], product: {...}, pricing: {...}}
 */
async function calculateReactionMaterials(reactionTypeId, runs = 1, characterId = null, facility = null, depth = 0, db = null) {
  // Prevent infinite recursion
  if (depth > MAX_RECURSION_DEPTH) {
    console.warn(`Max recursion depth ${MAX_RECURSION_DEPTH} reached for reaction ${reactionTypeId}`);
    return {
      materials: {},
      tree: [],
      product: null,
      error: `Max recursion depth ${MAX_RECURSION_DEPTH} exceeded`
    };
  }

  // Check cache at depth 0 only
  if (depth === 0) {
    const cacheKey = getReactionCacheKey(reactionTypeId, runs, facility, characterId);
    if (reactionTreeCache.has(cacheKey)) {
      return structuredClone(reactionTreeCache.get(cacheKey));
    }
  }

  const ownConnection = !db;

  if (!db) {
    db = await getDatabase();
  }

  try {
    // Get reaction product
    const product = await getReactionProduct(reactionTypeId, db);

    if (!product) {
      return {
        materials: {},
        tree: [],
        product: null,
        error: 'Reaction formula not found'
      };
    }

    // Get base materials for this reaction
    const baseMaterials = await getReactionMaterials(reactionTypeId, db);

    // Initialize result containers
    const aggregatedMaterials = {};
    const treeNodes = [];

    // Process each material
    for (const material of baseMaterials) {
      // Apply facility bonuses to calculate adjusted quantity
      const adjustedQty = calculateReactionMaterialQuantity(
        material.quantity,
        runs,
        facility,
        product.typeID
      );

      // Check if this material is itself a reaction product
      const subReactionId = await getReactionForProduct(material.typeID, db);

      if (subReactionId) {
        // ALWAYS EXPAND - this is an intermediate reaction product
        console.log(`[Reaction Tree] Expanding intermediate: ${material.typeName} (depth ${depth + 1})`);

        // Get the product info for the sub-reaction to know how much it produces per run
        const subReactionProduct = await getReactionProduct(subReactionId, db);
        const subReactionOutputPerRun = subReactionProduct ? subReactionProduct.quantity : 1;

        // Calculate how many runs of the sub-reaction we need
        // If we need 100 units and each run produces 200, we need 100/200 = 0.5 runs (rounds up to 1)
        const subReactionRuns = Math.ceil(adjustedQty / subReactionOutputPerRun);

        console.log(`[Reaction Tree] Need ${adjustedQty} ${material.typeName}, produces ${subReactionOutputPerRun} per run, requires ${subReactionRuns} runs`);

        const subCalc = await calculateReactionMaterials(
          subReactionId,
          subReactionRuns,
          characterId,
          facility,
          depth + 1,
          db
        );

        // Aggregate raw materials from sub-reaction
        for (const [typeId, qty] of Object.entries(subCalc.materials)) {
          aggregatedMaterials[typeId] = (aggregatedMaterials[typeId] || 0) + qty;
        }

        // Add to tree as intermediate node with children
        const reactionName = await getTypeName(subReactionId, db);
        treeNodes.push({
          typeID: material.typeID,
          typeName: material.typeName,
          quantity: adjustedQty,
          producedQuantity: subReactionRuns * subReactionOutputPerRun, // Actual amount produced
          runsNeeded: subReactionRuns,
          reactionTypeID: subReactionId,
          reactionName: reactionName,
          depth: depth,
          isIntermediate: true,
          children: subCalc.tree
        });
      } else {
        // Raw material (moon material) - leaf node
        aggregatedMaterials[material.typeID] = (aggregatedMaterials[material.typeID] || 0) + adjustedQty;

        treeNodes.push({
          typeID: material.typeID,
          typeName: material.typeName,
          quantity: adjustedQty,
          depth: depth,
          isIntermediate: false,
          children: []
        });
      }
    }

    // Get reaction time and calculate total production time with bonuses
    const baseReactionTime = await getReactionTime(reactionTypeId, db);
    const totalProductionTime = calculateReactionTime(baseReactionTime, runs, facility);

    // Calculate pricing (always at depth 0 for material prices)
    let pricing = null;
    if (depth === 0) {
      try {
        const { calculateRealisticPrice } = require('./market-pricing');
        const { getMarketSettings } = require('./settings-manager');
        const marketSettings = getMarketSettings();

        // Calculate input material costs with individual prices
        let inputCost = 0;
        const materialPrices = {};
        let itemsWithPrices = 0;
        let itemsWithoutPrices = 0;

        for (const [typeId, quantity] of Object.entries(aggregatedMaterials)) {
          const typeIdNum = parseInt(typeId);
          try {
            const priceResult = await calculateRealisticPrice(
              typeIdNum,
              marketSettings.regionId,
              marketSettings.locationId,
              marketSettings.inputMaterials?.priceType || 'sell',
              quantity,
              marketSettings.inputMaterials || {}
            );
            const unitPrice = priceResult.price || 0;
            const totalPrice = unitPrice * quantity;

            materialPrices[typeId] = {
              quantity,
              unitPrice,
              totalPrice,
              hasPrice: unitPrice > 0
            };

            if (unitPrice > 0) {
              inputCost += totalPrice;
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

        // Calculate output product value
        let outputValue = 0;
        try {
          const priceResult = await calculateRealisticPrice(
            product.typeID,
            marketSettings.regionId,
            marketSettings.locationId,
            marketSettings.outputProducts?.priceType || 'sell',
            product.quantity * runs,
            marketSettings.outputProducts || {}
          );
          outputValue = (priceResult.price || 0) * (product.quantity * runs);
        } catch (error) {
          console.error(`Error calculating price for product ${product.typeID}:`, error);
        }

        // Calculate job costs (only if facility with systemId is provided)
        let jobCostBreakdown = null;
        if (facility && facility.systemId) {
          jobCostBreakdown = await calculateReactionJobCost(reactionTypeId, runs, aggregatedMaterials, facility);
        }

        // Total costs (include job costs only if available)
        const jobCost = jobCostBreakdown ? jobCostBreakdown.totalJobCost : 0;
        const totalCost = inputCost + jobCost;
        const profit = outputValue - totalCost;
        const profitMargin = outputValue > 0 ? (profit / outputValue) * 100 : 0;

        pricing = {
          inputCosts: {
            totalCost: inputCost,
            materialPrices,
            itemsWithPrices,
            itemsWithoutPrices,
            allPricesAvailable: itemsWithoutPrices === 0
          },
          outputValue: {
            totalValue: outputValue
          },
          jobCostBreakdown,  // Will be null if no facility selected
          totalCost,
          profit,
          profitMargin
        };
      } catch (error) {
        console.error('Error calculating reaction pricing:', error);
        pricing = null;
      }
    }

    // Build result
    const result = {
      materials: aggregatedMaterials,
      tree: treeNodes,
      product: {
        typeID: product.typeID,
        typeName: product.typeName,
        quantity: product.quantity * runs,
        baseQuantity: product.quantity
      },
      time: {
        baseTime: baseReactionTime,
        totalTime: totalProductionTime,
        runs: runs
      },
      pricing: pricing
    };

    // Cache at depth 0
    if (depth === 0) {
      const cacheKey = getReactionCacheKey(reactionTypeId, runs, facility, characterId);
      reactionTreeCache.set(cacheKey, structuredClone(result));

      // Limit cache size
      if (reactionTreeCache.size > MAX_CACHE_SIZE) {
        const firstKey = reactionTreeCache.keys().next().value;
        reactionTreeCache.delete(firstKey);
      }
    }

    return result;

  } catch (error) {
    console.error('Error calculating reaction materials:', error);
    return {
      materials: {},
      tree: [],
      product: null,
      error: error.message
    };
  }
}

/**
 * Generate cache key for reaction tree
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {number} runs - Number of runs
 * @param {Object} facility - Facility configuration
 * @param {number} characterId - Character ID
 * @returns {string} Cache key
 */
function getReactionCacheKey(reactionTypeId, runs, facility, characterId) {
  const facilityKey = facility ? `${facility.id}_${facility.structureTypeId}` : 'none';
  const charKey = characterId || 'none';
  return `${reactionTypeId}_${runs}_${facilityKey}_${charKey}`;
}

/**
 * Clear all caches
 */
function clearReactionCache() {
  reactionTreeCache.clear();
  typeNameCache.clear();
  console.log('[Reaction Cache] All caches cleared');
}

module.exports = {
  searchReactions,
  getReactionMaterials,
  getReactionProduct,
  getReactionTime,
  getReactionForProduct,
  calculateReactionMaterials,
  calculateReactionMaterialQuantity,
  getTypeName,
  clearReactionCache
};
