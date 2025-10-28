const { getSDEDatabase } = require('./sde-database');
const path = require('path');
const Database = require('better-sqlite3');
const { app } = require('electron');

/**
 * Get the path to the SDE database
 * @returns {string} Path to SDE database
 */
function getSDEPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'sde', 'sqlite-latest.sqlite');
}

/**
 * Get blueprint manufacturing materials from SDE
 * @param {number} blueprintTypeId - Blueprint type ID
 * @returns {Array} Array of materials with {typeID, quantity}
 */
function getBlueprintMaterials(blueprintTypeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    // Activity ID 1 is manufacturing
    const materials = db.prepare(`
      SELECT materialTypeID as typeID, quantity
      FROM industryActivityMaterials
      WHERE typeID = ? AND activityID = 1
      ORDER BY quantity DESC
    `).all(blueprintTypeId);

    db.close();
    return materials;
  } catch (error) {
    console.error('Error getting blueprint materials:', error);
    return [];
  }
}

/**
 * Get blueprint product information
 * @param {number} blueprintTypeId - Blueprint type ID
 * @returns {Object} Product info with {typeID, quantity}
 */
function getBlueprintProduct(blueprintTypeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    // Activity ID 1 is manufacturing
    const product = db.prepare(`
      SELECT productTypeID as typeID, quantity
      FROM industryActivityProducts
      WHERE typeID = ? AND activityID = 1
      LIMIT 1
    `).get(blueprintTypeId);

    db.close();
    return product || null;
  } catch (error) {
    console.error('Error getting blueprint product:', error);
    return null;
  }
}

/**
 * Get type name from invTypes
 * @param {number} typeId - Type ID
 * @returns {string} Type name
 */
function getTypeName(typeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    const result = db.prepare(`
      SELECT typeName
      FROM invTypes
      WHERE typeID = ?
    `).get(typeId);

    db.close();
    return result ? result.typeName : `Type ${typeId}`;
  } catch (error) {
    console.error('Error getting type name:', error);
    return `Type ${typeId}`;
  }
}

/**
 * Get the default manufacturing facility and its bonuses
 * @returns {Object|null} Default facility with bonuses or null
 */
function getDefaultFacility() {
  try {
    const { getManufacturingFacilities } = require('./settings-manager');
    const facilities = getManufacturingFacilities();

    // Find the facility marked as default
    const defaultFacility = facilities.find(f => f.usage === 'default');

    if (!defaultFacility) {
      return null;
    }

    // Return facility with its structure bonus
    // Structure ME bonus is typically 1% for all Upwell structures
    return {
      ...defaultFacility,
      structureMEBonus: 1.0 // 1% material reduction from structure
    };
  } catch (error) {
    console.error('Error getting default facility:', error);
    return null;
  }
}

/**
 * Calculate material quantity with ME (Material Efficiency) bonus, structure bonus, and rig bonuses
 * @param {number} baseQuantity - Base material quantity
 * @param {number} meLevel - ME level (0-10)
 * @param {number} runs - Number of production runs
 * @param {Object} facility - Facility object with rigs and security status (optional)
 * @param {number} productGroupId - Product group ID for rig bonus matching
 * @returns {number} Adjusted quantity
 */
function calculateMaterialQuantity(baseQuantity, meLevel, runs, facility = null, productGroupId = null) {
  // Step 1: Apply ME bonus from blueprint
  // ME formula: quantity = runs * baseQuantity * (1 - ME/100)
  const meReduction = meLevel / 100;
  const afterME = runs * baseQuantity * (1 - meReduction);

  // Step 2: Apply structure bonus (1% for all Upwell structures)
  let afterStructure = afterME;
  if (facility && facility.structureTypeId) {
    // All Upwell structures provide 1% material reduction
    const structureReduction = 0.01; // 1%
    afterStructure = afterME * (1 - structureReduction);
  }

  // Step 3: Apply rig bonuses (if facility has rigs and product matches)
  let finalQuantity = afterStructure;
  if (facility && facility.rigs && facility.rigs.length > 0 && productGroupId) {
    const { getRigMaterialBonus } = require('./rig-bonuses');
    const rigBonus = getRigMaterialBonus(facility.rigs, productGroupId, facility.securityStatus);

    if (rigBonus !== 0) {
      // Rig bonus is negative (e.g., -2.0 for 2% reduction)
      // Apply as: quantity * (1 + bonus/100)
      finalQuantity = afterStructure * (1 + rigBonus / 100);
    }
  }

  // Final calculation: max(runs, ceil(finalQuantity))
  // The result cannot be less than the number of runs
  const adjustedQuantity = Math.max(runs, Math.ceil(finalQuantity));

  return adjustedQuantity;
}

/**
 * Check if a material type ID is itself a manufactured item (has a blueprint)
 * @param {number} typeId - Type ID to check
 * @returns {number|null} Blueprint type ID if exists, null otherwise
 */
function getBlueprintForProduct(typeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    // Find blueprint that produces this product
    const blueprint = db.prepare(`
      SELECT typeID as blueprintTypeID
      FROM industryActivityProducts
      WHERE productTypeID = ? AND activityID = 1
      LIMIT 1
    `).get(typeId);

    db.close();
    return blueprint ? blueprint.blueprintTypeID : null;
  } catch (error) {
    console.error('Error checking for blueprint:', error);
    return null;
  }
}

/**
 * Get owned blueprint ME level from character blueprints
 * @param {number} characterId - Character ID
 * @param {number} blueprintTypeId - Blueprint type ID
 * @returns {number} ME level (0-10), defaults to 0 if not owned
 */
function getOwnedBlueprintME(characterId, blueprintTypeId) {
  try {
    // Import settings-manager functions
    const { getBlueprints, getEffectiveBlueprintValues } = require('./settings-manager');

    if (!characterId) {
      return 0;
    }

    // Get blueprints for this character
    const blueprints = getBlueprints(characterId);

    if (!blueprints || blueprints.length === 0) {
      return 0;
    }

    // Find blueprint by typeId
    // Note: ESI stores as typeId, but check both typeId and type_id for compatibility
    const blueprint = blueprints.find(bp => bp.typeId === blueprintTypeId || bp.type_id === blueprintTypeId);

    if (!blueprint) {
      return 0;
    }

    // Get effective values (includes overrides)
    const effectiveValues = getEffectiveBlueprintValues(blueprint.itemId);

    if (effectiveValues && effectiveValues.materialEfficiency !== undefined) {
      return effectiveValues.materialEfficiency;
    }

    // Fallback to base ME value
    // materialEfficiency comes from ESI, material_efficiency might be from manual entry
    return blueprint.materialEfficiency !== undefined ? blueprint.materialEfficiency : (blueprint.material_efficiency || 0);
  } catch (error) {
    console.error('Error getting owned blueprint ME:', error);
    console.error('Stack trace:', error.stack);
    return 0;
  }
}

/**
 * Get product group ID from SDE
 * @param {number} productTypeId - Product type ID
 * @returns {number|null} Group ID
 */
function getProductGroupId(productTypeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    const result = db.prepare(`
      SELECT groupID
      FROM invTypes
      WHERE typeID = ?
    `).get(productTypeId);

    db.close();
    return result ? result.groupID : null;
  } catch (error) {
    console.error('Error getting product group ID:', error);
    return null;
  }
}

/**
 * Calculate total materials needed for a blueprint with recursive sub-component calculation
 * @param {number} blueprintTypeId - Blueprint type ID
 * @param {number} runs - Number of production runs
 * @param {number} meLevel - ME level (0-10)
 * @param {number} characterId - Character ID for owned blueprints (optional)
 * @param {Object} facility - Facility object with rigs and security status (optional)
 * @param {number} depth - Current recursion depth (for internal use)
 * @returns {Object} Calculation result with materials and breakdown
 */
async function calculateBlueprintMaterials(blueprintTypeId, runs = 1, meLevel = 0, characterId = null, facility = null, depth = 0) {
  const MAX_DEPTH = 10; // Prevent infinite recursion

  if (depth > MAX_DEPTH) {
    console.warn('Max recursion depth reached in blueprint calculation');
    return {
      materials: {},
      breakdown: [],
      product: null
    };
  }

  // Get blueprint product info
  const product = getBlueprintProduct(blueprintTypeId);
  if (!product) {
    return {
      materials: {},
      breakdown: [],
      product: null,
      error: 'Blueprint not found or has no product'
    };
  }

  // Get base materials
  const baseMaterials = getBlueprintMaterials(blueprintTypeId);

  // Get product group ID for rig bonus matching
  const productGroupId = getProductGroupId(product.typeID);

  // Calculate adjusted quantities with ME bonus and facility bonuses
  const adjustedMaterials = {};
  const intermediateComponents = [];
  const rawMaterials = [];

  for (const material of baseMaterials) {
    const adjustedQty = calculateMaterialQuantity(material.quantity, meLevel, runs, facility, productGroupId);

    // Check if this material can be manufactured
    const subBlueprintId = getBlueprintForProduct(material.typeID);

    if (subBlueprintId) {
      // This is an intermediate component - get its ME if owned
      const subME = characterId ? getOwnedBlueprintME(characterId, subBlueprintId) : 0;

      // Recursively calculate materials for this component
      const subCalculation = await calculateBlueprintMaterials(
        subBlueprintId,
        adjustedQty,
        subME,
        characterId,
        facility,  // Pass facility through recursion
        depth + 1
      );

      // Add sub-materials to our total
      for (const [typeId, qty] of Object.entries(subCalculation.materials)) {
        adjustedMaterials[typeId] = (adjustedMaterials[typeId] || 0) + qty;
      }

      // Track this as an intermediate component
      intermediateComponents.push({
        typeID: material.typeID,
        typeName: getTypeName(material.typeID),
        quantity: adjustedQty,
        blueprintTypeID: subBlueprintId,
        blueprintName: getTypeName(subBlueprintId),
        meLevel: subME,
        subMaterials: subCalculation.materials
      });
    } else {
      // This is a raw material
      adjustedMaterials[material.typeID] = (adjustedMaterials[material.typeID] || 0) + adjustedQty;

      rawMaterials.push({
        typeID: material.typeID,
        typeName: getTypeName(material.typeID),
        quantity: adjustedQty
      });
    }
  }

  // Create breakdown
  const breakdown = [
    {
      blueprintTypeID: blueprintTypeId,
      blueprintName: getTypeName(blueprintTypeId),
      productTypeID: product.typeID,
      productName: getTypeName(product.typeID),
      productQuantity: product.quantity * runs,
      runs: runs,
      meLevel: meLevel,
      rawMaterials: rawMaterials,
      intermediateComponents: intermediateComponents
    }
  ];

  // Add breakdowns from sub-components
  for (const component of intermediateComponents) {
    if (component.subMaterials) {
      // The sub-calculation already has its breakdown, we just track it
    }
  }

  // Calculate pricing if facility is provided (has systemId for cost calculation)
  let pricing = null;
  if (facility && facility.systemId) {
    try {
      // Get skill levels from default character (if available)
      const { getDefaultCharacter, getEffectiveSkillLevel } = require('./settings-manager');
      const defaultCharacter = getDefaultCharacter();

      // EVE Online skill IDs
      const ACCOUNTING_SKILL_ID = 16622;
      const BROKER_RELATIONS_SKILL_ID = 3446;

      let accountingSkillLevel = 0;
      let brokerRelationsSkillLevel = 0;

      if (defaultCharacter) {
        accountingSkillLevel = getEffectiveSkillLevel(defaultCharacter.characterId, ACCOUNTING_SKILL_ID) || 0;
        brokerRelationsSkillLevel = getEffectiveSkillLevel(defaultCharacter.characterId, BROKER_RELATIONS_SKILL_ID) || 0;
      }

      const { calculateBlueprintPricing } = require('./blueprint-pricing');
      pricing = await calculateBlueprintPricing(
        adjustedMaterials,
        {
          typeID: product.typeID,
          quantity: product.quantity * runs
        },
        facility.systemId,
        facility,
        accountingSkillLevel,
        blueprintTypeId, // Pass blueprint type ID for EIV calculation
        runs, // Pass runs for EIV calculation
        brokerRelationsSkillLevel
      );
    } catch (error) {
      console.error('Error calculating blueprint pricing:', error);
      pricing = null;
    }
  }

  return {
    materials: adjustedMaterials,
    breakdown: breakdown,
    product: {
      typeID: product.typeID,
      typeName: getTypeName(product.typeID),
      quantity: product.quantity * runs
    },
    pricing: pricing
  };
}

/**
 * Search for blueprints by name
 * @param {string} searchTerm - Search term
 * @param {number} limit - Maximum results to return
 * @returns {Array} Array of matching blueprints
 */
function searchBlueprints(searchTerm, limit = 20) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    const blueprints = db.prepare(`
      SELECT DISTINCT it.typeID, it.typeName, iap.productTypeID, pt.typeName as productName, iap.quantity as productQuantity
      FROM invTypes it
      JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
      JOIN invTypes pt ON iap.productTypeID = pt.typeID
      WHERE it.typeName LIKE ? AND it.published = 1
      ORDER BY it.typeName
      LIMIT ?
    `).all(`%${searchTerm}%`, limit);

    db.close();
    return blueprints;
  } catch (error) {
    console.error('Error searching blueprints:', error);
    return [];
  }
}

/**
 * Get all manufacturing blueprints from SDE
 * @param {number} limit - Maximum number of blueprints to return (default: all)
 * @returns {Array} Array of blueprint objects
 */
function getAllBlueprints(limit = null) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    let query = `
      SELECT DISTINCT
        it.typeID,
        it.typeName,
        ig.groupName as category,
        iap.productTypeID,
        pt.typeName as productName,
        pt.groupID as productGroupID,
        iap.quantity as productQuantity,
        ia.time as baseTime,
        pg.groupName as productGroupName,
        pc.categoryName as productCategoryName,
        COALESCE(mt.metaGroupID, 1) as productMetaGroupID
      FROM invTypes it
      JOIN invGroups ig ON it.groupID = ig.groupID
      JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
      JOIN invTypes pt ON iap.productTypeID = pt.typeID
      JOIN invGroups pg ON pt.groupID = pg.groupID
      JOIN invCategories pc ON pg.categoryID = pc.categoryID
      LEFT JOIN invMetaTypes mt ON pt.typeID = mt.typeID
      LEFT JOIN industryActivity ia ON it.typeID = ia.typeID AND ia.activityID = 1
      WHERE it.published = 1
      ORDER BY ig.groupName, it.typeName
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    const blueprints = db.prepare(query).all();

    db.close();
    return blueprints;
  } catch (error) {
    console.error('Error getting all blueprints:', error);
    return [];
  }
}

/**
 * Get invention data for a blueprint
 * @param {number} blueprintTypeId - T1 Blueprint type ID
 * @returns {Object|null} Invention data including materials, product, probability, and skills
 */
function getInventionData(blueprintTypeId) {
  console.log('[Invention] getInventionData called for blueprintTypeId:', blueprintTypeId);
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    // Check if this blueprint can be used for invention (activityID = 8)
    const hasInvention = db.prepare(`
      SELECT 1
      FROM industryActivity
      WHERE typeID = ? AND activityID = 8
    `).get(blueprintTypeId);

    console.log('[Invention] hasInvention check result:', hasInvention);

    if (!hasInvention) {
      db.close();
      console.log('[Invention] No invention activity found, returning null');
      return null;
    }

    // Get invention materials (datacores, data interfaces, optional items)
    const materials = db.prepare(`
      SELECT iam.materialTypeID as typeID, iam.quantity, it.typeName
      FROM industryActivityMaterials iam
      LEFT JOIN invTypes it ON iam.materialTypeID = it.typeID
      WHERE iam.typeID = ? AND iam.activityID = 8
      ORDER BY iam.quantity DESC
    `).all(blueprintTypeId);

    // Get ALL invention products (some blueprints have multiple T2 variants)
    const products = db.prepare(`
      SELECT iap.productTypeID as typeID, iap.quantity, it.typeName
      FROM industryActivityProducts iap
      LEFT JOIN invTypes it ON iap.productTypeID = it.typeID
      WHERE iap.typeID = ? AND iap.activityID = 8
      ORDER BY it.typeName
    `).all(blueprintTypeId);

    // Get the manufactured products for each invention product
    // This is needed for market pricing since blueprints themselves aren't tradeable
    const productsWithManufactured = products.map(product => {
      const manufacturedProduct = db.prepare(`
        SELECT iap.productTypeID as typeID, it.typeName
        FROM industryActivityProducts iap
        LEFT JOIN invTypes it ON iap.productTypeID = it.typeID
        WHERE iap.typeID = ? AND iap.activityID = 1
        LIMIT 1
      `).get(product.typeID);

      // Get base invention probability for this specific product
      const probability = db.prepare(`
        SELECT probability
        FROM industryActivityProbabilities
        WHERE typeID = ? AND activityID = 8 AND productTypeID = ?
        LIMIT 1
      `).get(blueprintTypeId, product.typeID);

      return {
        ...product,
        manufacturedProduct: manufacturedProduct || null,
        baseProbability: probability ? probability.probability : 0
      };
    });

    // Get required skills with names
    const skills = db.prepare(`
      SELECT ias.skillID, ias.level, it.typeName as skillName
      FROM industryActivitySkills ias
      LEFT JOIN invTypes it ON ias.skillID = it.typeID
      WHERE ias.typeID = ? AND ias.activityID = 8
      ORDER BY ias.level DESC
    `).all(blueprintTypeId);

    // Get invention time
    const time = db.prepare(`
      SELECT time
      FROM industryActivity
      WHERE typeID = ? AND activityID = 8
    `).get(blueprintTypeId);

    db.close();

    const result = {
      materials: materials || [],
      products: productsWithManufactured || [],
      skills: skills || [],
      time: time ? time.time : 0
    };

    console.log('[Invention] Returning invention data - materials count:', result.materials.length, 'products count:', result.products.length);
    if (result.products.length > 0) {
      console.log('[Invention] First product:', result.products[0].typeName, 'manufactures:', result.products[0].manufacturedProduct?.typeName);
    }
    return result;
  } catch (error) {
    console.error('[Invention] Error getting invention data:', error);
    return null;
  }
}

/**
 * Get all decryptors with their modifiers
 * @returns {Array} Array of decryptors with their modifiers
 */
function getAllDecryptors() {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    // Decryptors are in groupID 1304
    const decryptors = db.prepare(`
      SELECT
        t.typeID,
        t.typeName,
        MAX(CASE WHEN tattr.attributeID = 1112 THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as probabilityMultiplier,
        MAX(CASE WHEN tattr.attributeID = 1113 THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as meModifier,
        MAX(CASE WHEN tattr.attributeID = 1114 THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as teModifier,
        MAX(CASE WHEN tattr.attributeID = 1124 THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as runsModifier
      FROM invTypes t
      LEFT JOIN dgmTypeAttributes tattr ON tattr.typeID = t.typeID AND tattr.attributeID IN (1112, 1113, 1114, 1124)
      WHERE t.groupID = 1304
      GROUP BY t.typeID, t.typeName
      ORDER BY t.typeName
    `).all();

    db.close();
    return decryptors;
  } catch (error) {
    console.error('Error getting decryptors:', error);
    return [];
  }
}

/**
 * Calculate invention probability based on skills and decryptor
 * Formula: Base × (1 + EncryptionSkill/40) × (1 + (Datacore1 + Datacore2)/30) × DecryptorMultiplier
 * @param {number} baseProbability - Base probability from SDE
 * @param {Object} skills - Character skills { encryption: level, datacore1: level, datacore2: level }
 * @param {number} decryptorMultiplier - Decryptor probability multiplier (default 1.0 for no decryptor)
 * @returns {number} Final probability (0-1)
 */
function calculateInventionProbability(baseProbability, skills = {}, decryptorMultiplier = 1.0) {
  const encryptionLevel = skills.encryption || 0;
  const datacore1Level = skills.datacore1 || 0;
  const datacore2Level = skills.datacore2 || 0;

  const encryptionBonus = 1 + (encryptionLevel / 40);
  const datacoreBonus = 1 + ((datacore1Level + datacore2Level) / 30);

  const finalProbability = baseProbability * encryptionBonus * datacoreBonus * decryptorMultiplier;

  return Math.min(finalProbability, 1.0); // Cap at 100%
}

/**
 * Calculate invention cost per successful run
 * @param {Object} inventionData - Invention data from getInventionData
 * @param {Object} materialPrices - Map of typeID -> price
 * @param {number} probability - Success probability (0-1)
 * @param {Object} decryptor - Optional decryptor object with typeID and runsModifier
 * @param {number} decryptorPrice - Price of decryptor (if used)
 * @returns {Object} Cost breakdown
 */
function calculateInventionCost(inventionData, materialPrices, probability, decryptor = null, decryptorPrice = 0) {
  // Calculate material costs (datacores, data interfaces, etc - NOT including decryptor)
  let materialCost = 0;
  inventionData.materials.forEach(mat => {
    const price = materialPrices[mat.typeID] || 0;
    materialCost += price * mat.quantity;
  });

  // Job cost for invention - approximately 2% of material costs as a simplified estimate
  // In reality this uses EIV and system cost index, but for now we'll use a simple approximation
  const jobCostPercentage = 0.02; // 2% of material costs
  const jobCost = materialCost * jobCostPercentage;

  // Total cost per attempt = materials + decryptor + job cost
  const totalCostPerAttempt = materialCost + decryptorPrice + jobCost;

  // Cost per successful invention = cost per attempt / probability
  const costPerSuccess = probability > 0 ? totalCostPerAttempt / probability : 0;

  // Calculate runs per invented blueprint
  // Base runs comes from the invention product quantity (e.g., 1 for ships, 10 for ammo)
  const baseRuns = inventionData.product?.quantity || 1;
  const runsModifier = decryptor ? (decryptor.runsModifier || 0) : 0;
  const totalRuns = baseRuns + runsModifier;

  // Cost per run = cost per successful invention / number of runs on that blueprint
  const costPerRun = totalRuns > 0 ? costPerSuccess / totalRuns : costPerSuccess;

  return {
    materialCost,
    decryptorCost: decryptorPrice,
    jobCost,
    totalCostPerAttempt,
    probability,
    costPerSuccess,
    runsPerBPC: totalRuns,
    costPerRun
  };
}

/**
 * Find the most profitable decryptor for invention
 * @param {Object} inventionData - Invention data from getInventionData
 * @param {Object} materialPrices - Map of typeID -> price (includes materials and decryptors)
 * @param {Object} productPrice - Price of the invented blueprint product
 * @param {Object} skills - Character skills for invention
 * @returns {Object} Best decryptor analysis with comparison
 */
function findBestDecryptor(inventionData, materialPrices, productPrice, skills = {}) {
  const decryptors = getAllDecryptors();
  const baseProbability = inventionData.baseProbability;

  // Calculate for no decryptor
  const noDecryptorProb = calculateInventionProbability(baseProbability, skills, 1.0);
  const noDecryptorCost = calculateInventionCost(inventionData, materialPrices, noDecryptorProb, null, 0);

  let bestOption = {
    name: 'No Decryptor',
    typeID: null,
    probability: noDecryptorProb,
    costPerSuccess: noDecryptorCost.costPerSuccess,
    costPerRun: noDecryptorCost.costPerRun,
    runsPerBPC: noDecryptorCost.runsPerBPC,
    materialCost: noDecryptorCost.materialCost,
    decryptorCost: noDecryptorCost.decryptorCost,
    jobCost: noDecryptorCost.jobCost,
    totalCostPerAttempt: noDecryptorCost.totalCostPerAttempt,
    meModifier: 0,
    teModifier: 0,
    runsModifier: 0
  };

  // Compare with each decryptor (use costPerRun for comparison)
  decryptors.forEach(dec => {
    const decPrice = materialPrices[dec.typeID] || 0;
    const decProb = calculateInventionProbability(baseProbability, skills, dec.probabilityMultiplier || 1.0);
    const decCost = calculateInventionCost(inventionData, materialPrices, decProb, dec, decPrice);

    if (decCost.costPerRun < bestOption.costPerRun) {
      bestOption = {
        name: dec.typeName,
        typeID: dec.typeID,
        probability: decProb,
        costPerSuccess: decCost.costPerSuccess,
        costPerRun: decCost.costPerRun,
        runsPerBPC: decCost.runsPerBPC,
        materialCost: decCost.materialCost,
        decryptorCost: decCost.decryptorCost,
        jobCost: decCost.jobCost,
        totalCostPerAttempt: decCost.totalCostPerAttempt,
        meModifier: dec.meModifier || 0,
        teModifier: dec.teModifier || 0,
        runsModifier: dec.runsModifier || 0,
        probabilityMultiplier: dec.probabilityMultiplier || 1.0
      };
    }
  });

  return {
    best: bestOption,
    noDecryptor: {
      probability: noDecryptorProb,
      costPerSuccess: noDecryptorCost.costPerSuccess,
      totalCost: noDecryptorCost.totalCostPerAttempt
    },
    allOptions: [
      {
        name: 'No Decryptor',
        typeID: null,
        probability: noDecryptorProb,
        costPerSuccess: noDecryptorCost.costPerSuccess,
        costPerRun: noDecryptorCost.costPerRun,
        runsPerBPC: noDecryptorCost.runsPerBPC,
        materialCost: noDecryptorCost.materialCost,
        decryptorCost: noDecryptorCost.decryptorCost,
        jobCost: noDecryptorCost.jobCost,
        totalCostPerAttempt: noDecryptorCost.totalCostPerAttempt,
        meModifier: 0,
        teModifier: 0,
        runsModifier: 0
      },
      ...decryptors.map(dec => {
        const decPrice = materialPrices[dec.typeID] || 0;
        const decProb = calculateInventionProbability(baseProbability, skills, dec.probabilityMultiplier || 1.0);
        const decCost = calculateInventionCost(inventionData, materialPrices, decProb, dec, decPrice);
        return {
          name: dec.typeName,
          typeID: dec.typeID,
          probability: decProb,
          costPerSuccess: decCost.costPerSuccess,
          costPerRun: decCost.costPerRun,
          runsPerBPC: decCost.runsPerBPC,
          materialCost: decCost.materialCost,
          decryptorCost: decCost.decryptorCost,
          jobCost: decCost.jobCost,
          totalCostPerAttempt: decCost.totalCostPerAttempt,
          meModifier: dec.meModifier || 0,
          teModifier: dec.teModifier || 0,
          runsModifier: dec.runsModifier || 0,
          probabilityMultiplier: dec.probabilityMultiplier || 1.0
        };
      })
    ]
  };
}

module.exports = {
  getBlueprintMaterials,
  getBlueprintProduct,
  getTypeName,
  calculateMaterialQuantity,
  getBlueprintForProduct,
  getOwnedBlueprintME,
  calculateBlueprintMaterials,
  searchBlueprints,
  getAllBlueprints,
  getDefaultFacility,
  getProductGroupId,
  // Invention functions
  getInventionData,
  getAllDecryptors,
  calculateInventionProbability,
  calculateInventionCost,
  findBestDecryptor
};
