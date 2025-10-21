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
 * Calculate material quantity with ME (Material Efficiency) bonus and structure bonus
 * @param {number} baseQuantity - Base material quantity
 * @param {number} meLevel - ME level (0-10)
 * @param {number} runs - Number of production runs
 * @returns {number} Adjusted quantity
 */
function calculateMaterialQuantity(baseQuantity, meLevel, runs) {
  // Step 1: Apply ME bonus from blueprint
  // ME formula: quantity = max(runs, runs * baseQuantity * (1 - ME/100))
  const meReduction = meLevel / 100;
  const afterME = runs * baseQuantity * (1 - meReduction);

  // Step 2: Apply structure bonus (in series after ME)
  const defaultFacility = getDefaultFacility();
  let finalQuantity = afterME;

  if (defaultFacility && defaultFacility.facilityType === 'structure') {
    // Structure provides 1% material reduction (applied after ME)
    const structureReduction = defaultFacility.structureMEBonus / 100;
    finalQuantity = afterME * (1 - structureReduction);
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
 * Calculate total materials needed for a blueprint with recursive sub-component calculation
 * @param {number} blueprintTypeId - Blueprint type ID
 * @param {number} runs - Number of production runs
 * @param {number} meLevel - ME level (0-10)
 * @param {number} characterId - Character ID for owned blueprints (optional)
 * @param {number} depth - Current recursion depth (for internal use)
 * @returns {Object} Calculation result with materials and breakdown
 */
function calculateBlueprintMaterials(blueprintTypeId, runs = 1, meLevel = 0, characterId = null, depth = 0) {
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

  // Calculate adjusted quantities with ME bonus
  const adjustedMaterials = {};
  const intermediateComponents = [];
  const rawMaterials = [];

  for (const material of baseMaterials) {
    const adjustedQty = calculateMaterialQuantity(material.quantity, meLevel, runs);

    // Check if this material can be manufactured
    const subBlueprintId = getBlueprintForProduct(material.typeID);

    if (subBlueprintId) {
      // This is an intermediate component - get its ME if owned
      const subME = characterId ? getOwnedBlueprintME(characterId, subBlueprintId) : 0;

      // Recursively calculate materials for this component
      const subCalculation = calculateBlueprintMaterials(
        subBlueprintId,
        adjustedQty,
        subME,
        characterId,
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

  return {
    materials: adjustedMaterials,
    breakdown: breakdown,
    product: {
      typeID: product.typeID,
      typeName: getTypeName(product.typeID),
      quantity: product.quantity * runs
    }
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

module.exports = {
  getBlueprintMaterials,
  getBlueprintProduct,
  getTypeName,
  calculateMaterialQuantity,
  getBlueprintForProduct,
  getOwnedBlueprintME,
  calculateBlueprintMaterials,
  searchBlueprints,
  getDefaultFacility
};
