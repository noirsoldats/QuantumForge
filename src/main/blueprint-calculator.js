const {getSDEDatabase} = require('./sde-database');
const path             = require('path');
const Database         = require('better-sqlite3');
const {app}            = require('electron');
const {getCostIndices} = require('./esi-cost-indices');
const {getSdePath}     = require('./sde-manager');

// In-memory caches for performance optimization
const typeNameCache     = new Map();
const materialTreeCache = new Map();
const MAX_CACHE_SIZE    = 100;

/**
 * Get the path to the SDE database (handles both old and new filenames)
 * @returns {string} Path to SDE database
 */
function getSDEPath() {
    // Use sde-manager's getSdePath which handles both old and new filenames
    return getSdePath();
}

/**
 * Generate cache key for material tree calculations
 * @param {number} blueprintTypeId - Blueprint type ID
 * @param {number} runs - Number of runs
 * @param {number} meLevel - ME level
 * @param {Object} facility - Facility configuration
 * @param {number} characterId - Character ID (affects owned blueprint ME lookups)
 * @returns {string} Cache key
 */
function getMaterialCacheKey(blueprintTypeId, runs, meLevel, facility, characterId, useIntermediates = true) {
    const facilityKey = facility ?
                        `${facility.systemId}_${facility.structureTypeId}_${(facility.rigs || []).map(r => r.typeId).sort().join(',')}` :
                        'none';
    const charKey     = characterId || 'none';
    return `${blueprintTypeId}_${runs}_${meLevel}_${facilityKey}_${charKey}_${useIntermediates ? '1' : '0'}`;
}

/**
 * Get blueprint manufacturing materials from SDE
 * @param {number} blueprintTypeId - Blueprint type ID
 * @param {number} activityId - Activity ID (default: 1 for manufacturing)
 * @param {Database} db - Optional database connection to reuse
 * @returns {Object} Array of materials with {typeID, quantity}
 */
function getBlueprintMaterials(blueprintTypeId, activityId = 1, db = null) {
    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        // Activity ID 1 is manufacturing
        const materials = db.prepare(`
            SELECT materialTypeID as typeID, quantity
            FROM industryActivityMaterials
            WHERE typeID = ?
              AND activityID = ?
            ORDER BY quantity DESC
        `).all(blueprintTypeId, activityId);

        if (ownConnection) db.close();
        return materials;
    } catch (error) {
        console.error('Error getting blueprint materials:', error);
        return [];
    }
}

/**
 * Get blueprint product information
 * @param {number} blueprintTypeId - Blueprint type ID
 * @param {Database} db - Optional database connection to reuse
 * @returns {Object} Product info with {typeID, quantity}
 */
function getBlueprintProduct(blueprintTypeId, db = null) {
    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        // Activity ID 1 is manufacturing
        const product = db.prepare(`
            SELECT productTypeID as typeID, quantity
            FROM industryActivityProducts
            WHERE typeID = ?
              AND activityID = 1 LIMIT 1
        `).get(blueprintTypeId);

        if (ownConnection) db.close();
        return product || null;
    } catch (error) {
        console.error('Error getting blueprint product:', error);
        return null;
    }
}

/**
 * Get type name from invTypes (with in-memory caching)
 * @param {number} typeId - Type ID
 * @param {Database} db - Optional database connection to reuse
 * @returns {string} Type name
 */
function getTypeName(typeId, db = null) {
    // Check in-memory cache first
    if (typeNameCache.has(typeId)) {
        return typeNameCache.get(typeId);
    }

    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        const result = db.prepare(`
            SELECT typeName
            FROM invTypes
            WHERE typeID = ?
        `).get(typeId);

        if (ownConnection) db.close();

        const typeName = result ? result.typeName : `Type ${typeId}`;

        // Cache the result
        typeNameCache.set(typeId, typeName);

        return typeName;
    } catch (error) {
        console.error('Error getting type name:', error);
        const fallback = `Type ${typeId}`;
        typeNameCache.set(typeId, fallback);
        return fallback;
    }
}

/**
 * Get the default manufacturing facility and its bonuses
 * @returns {Object|null} Default facility with bonuses or null
 */
function getDefaultFacility() {
    try {
        const {getManufacturingFacilities} = require('./settings-manager');
        const facilities                   = getManufacturingFacilities();

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
    const afterME     = runs * baseQuantity * (1 - meReduction);

    // Step 2: Apply structure bonus (1% for all Upwell structures)
    let afterStructure = afterME;
    if (facility && facility.structureTypeId) {
        // All Upwell structures provide 1% material reduction
        const structureReduction = 0.01; // 1%
        afterStructure           = afterME * (1 - structureReduction);
    }

    // Step 3: Apply rig bonuses (if facility has rigs and product matches)
    let finalQuantity = afterStructure;
    if (facility && facility.rigs && facility.rigs.length > 0 && productGroupId) {
        const {getRigMaterialBonus} = require('./rig-bonuses');
        // Use facility.securityStatus if available, otherwise default to 0.5 (lowsec)
        const securityStatus = facility.securityStatus ?? 0.5;
        const rigBonus = getRigMaterialBonus(facility.rigs, productGroupId, securityStatus);

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
 * @param {Database} db - Optional database connection to reuse
 * @returns {number|null} Blueprint type ID if exists, null otherwise
 */
function getBlueprintForProduct(typeId, db = null) {
    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        // Find blueprint that produces this product
        const blueprint = db.prepare(`
            SELECT typeID as blueprintTypeID
            FROM industryActivityProducts
            WHERE productTypeID = ?
              AND activityID = 1 LIMIT 1
        `).get(typeId);

        if (ownConnection) db.close();
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
        const {getBlueprints, getEffectiveBlueprintValues} = require('./settings-manager');

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
 * @param {Database} db - Optional database connection to reuse
 * @returns {number|null} Group ID
 */
function getProductGroupId(productTypeId, db = null) {
    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        const result = db.prepare(`
            SELECT groupID
            FROM invTypes
            WHERE typeID = ?
        `).get(productTypeId);

        if (ownConnection) db.close();
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
 * @param useIntermediates
 * @param {number} depth - Current recursion depth (for internal use)
 * @param db
 * @returns {Object} Calculation result with materials and breakdown
 */
async function calculateBlueprintMaterials(blueprintTypeId, runs = 1, meLevel = 0, characterId = null, facility = null, useIntermediates = true, depth = 0, db = null) {
    const MAX_DEPTH = 10; // Prevent infinite recursion

    if (depth > MAX_DEPTH) {
        console.warn('Max recursion depth reached in blueprint calculation');
        return {
            materials: {},
            breakdown: [],
            product:   null
        };
    }

    // Check cache (only for top-level calls, depth 0)
    if (depth === 0) {
        const cacheKey     = getMaterialCacheKey(blueprintTypeId, runs, meLevel, facility, characterId, useIntermediates);
        const cachedResult = materialTreeCache.get(cacheKey);

        if (cachedResult) {
            console.log(`[Material Cache HIT] Blueprint ${blueprintTypeId}, ME ${meLevel}, runs ${runs}, char ${characterId || 'none'}`);
            return structuredClone(cachedResult);
        }

        console.log(`[Material Cache MISS] Blueprint ${blueprintTypeId}, ME ${meLevel}, runs ${runs}, char ${characterId || 'none'}`);
    }

    // Get blueprint product info
    const product = getBlueprintProduct(blueprintTypeId, db);
    if (!product) {
        return {
            materials: {},
            breakdown: [],
            product:   null,
            error:     'Blueprint not found or has no product'
        };
    }

    // Get base materials
    const baseMaterials = getBlueprintMaterials(blueprintTypeId, 1, db);

    // Get product group ID for rig bonus matching
    const productGroupId = getProductGroupId(product.typeID, db);

    // Calculate adjusted quantities with ME bonus and facility bonuses
    const adjustedMaterials      = {};
    const intermediateComponents = [];
    const rawMaterials           = [];

    for (const material of baseMaterials) {
        const adjustedQty = calculateMaterialQuantity(material.quantity, meLevel, runs, facility, productGroupId);

        // Check if this material can be manufactured
        const subBlueprintId = getBlueprintForProduct(material.typeID, db);

        if (subBlueprintId && useIntermediates) {
            // This is an intermediate component - get its ME if owned
            const subME = characterId ? getOwnedBlueprintME(characterId, subBlueprintId) : 0;

            // Recursively calculate materials for this component
            const subCalculation = await calculateBlueprintMaterials(
                subBlueprintId,
                adjustedQty,
                subME,
                characterId,
                facility,  // Pass facility through recursion
                useIntermediates,  // Pass useIntermediates flag through recursion
                depth + 1,
                db  // Pass db connection through recursion
            );

            // Add sub-materials to our total
            for (const [typeId, qty] of Object.entries(subCalculation.materials)) {
                adjustedMaterials[typeId] = (adjustedMaterials[typeId] || 0) + qty;
            }

            // Get product info to determine products-per-run
            const subProduct = getBlueprintProduct(subBlueprintId, db);
            const productQuantityPerRun = subProduct ? subProduct.quantity : 1;

            // Track this as an intermediate component
            intermediateComponents.push({
                typeID:          material.typeID,
                typeName:        getTypeName(material.typeID, db),
                quantity:        adjustedQty,
                productQuantityPerRun: productQuantityPerRun,  // Products per run from SDE
                blueprintTypeID: subBlueprintId,
                blueprintName:   getTypeName(subBlueprintId, db),
                meLevel:         subME,
                depth:           depth,  // Current recursion depth for this intermediate
                subMaterials:    subCalculation.materials,
                nestedIntermediates: subCalculation.breakdown?.[0]?.intermediateComponents || []  // Nested intermediates from recursive call
            });
        } else {
            // This is a raw material (or intermediates are disabled)
            adjustedMaterials[material.typeID] = (adjustedMaterials[material.typeID] || 0) + adjustedQty;

            rawMaterials.push({
                typeID:   material.typeID,
                typeName: getTypeName(material.typeID, db),
                quantity: adjustedQty
            });
        }
    }

    // Create breakdown
    const breakdown = [
        {
            blueprintTypeID:        blueprintTypeId,
            blueprintName:          getTypeName(blueprintTypeId, db),
            productTypeID:          product.typeID,
            productName:            getTypeName(product.typeID, db),
            productQuantity:        product.quantity * runs,
            runs:                   runs,
            meLevel:                meLevel,
            rawMaterials:           rawMaterials,
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
            const {getDefaultCharacter, getEffectiveSkillLevel} = require('./settings-manager');
            const defaultCharacter                              = getDefaultCharacter();

            // EVE Online skill IDs
            const ACCOUNTING_SKILL_ID       = 16622;
            const BROKER_RELATIONS_SKILL_ID = 3446;

            let accountingSkillLevel      = 0;
            let brokerRelationsSkillLevel = 0;

            if (defaultCharacter) {
                accountingSkillLevel      = getEffectiveSkillLevel(defaultCharacter.characterId, ACCOUNTING_SKILL_ID) || 0;
                brokerRelationsSkillLevel = getEffectiveSkillLevel(defaultCharacter.characterId, BROKER_RELATIONS_SKILL_ID) || 0;
            }

            const {calculateBlueprintPricing} = require('./blueprint-pricing');
            pricing                           = await calculateBlueprintPricing(
                adjustedMaterials,
                {
                    typeID:   product.typeID,
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

    const result = {
        materials: adjustedMaterials,
        breakdown: breakdown,
        product:   {
            typeID:   product.typeID,
            typeName: getTypeName(product.typeID, db),
            quantity: product.quantity * runs,
            baseQuantity: product.quantity  // Quantity per run from SDE
        },
        pricing:   pricing
    };

    // Cache result (only for top-level calls, depth 0)
    if (depth === 0) {
        const cacheKey = getMaterialCacheKey(blueprintTypeId, runs, meLevel, facility, characterId, useIntermediates);
        materialTreeCache.set(cacheKey, structuredClone(result));

        // Limit cache size to prevent memory issues
        if (materialTreeCache.size > MAX_CACHE_SIZE) {
            const firstKey = materialTreeCache.keys().next().value;
            materialTreeCache.delete(firstKey);
            console.log(`[Material Cache] Cache size limit reached, removed oldest entry`);
        }
    }

    return result;
}

/**
 * Search for blueprints by name
 * @param {string} searchTerm - Search term
 * @param {number} limit - Maximum results to return
 * @returns {Array} Array of matching blueprints
 */
function searchBlueprints(searchTerm, limit = 100) {
    try {
        const dbPath = getSDEPath();
        const db     = new Database(dbPath, {readonly: true});

        const blueprints = db.prepare(`
            SELECT DISTINCT it.typeID,
                            it.typeName,
                            iap.productTypeID,
                            pt.typeName  as productName,
                            iap.quantity as productQuantity
            FROM invTypes it
                     JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
                     JOIN invTypes pt ON iap.productTypeID = pt.typeID
            WHERE it.typeName LIKE ?
              AND it.published = 1
            ORDER BY it.typeName LIMIT ?
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
        const db     = new Database(dbPath, {readonly: true});

        let query = `
            SELECT DISTINCT it.typeID,
                            it.typeName,
                            ig.groupName                as category,
                            iap.productTypeID,
                            pt.typeName                 as productName,
                            pt.groupID                  as productGroupID,
                            iap.quantity                as productQuantity,
                            ia.time                     as baseTime,
                            pg.groupName                as productGroupName,
                            pc.categoryName             as productCategoryName,
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
 * @param {Database} db - Optional database connection to reuse
 * @returns {Object|null} Invention data including materials, product, probability, and skills
 */
function getInventionData(blueprintTypeId, db = null) {
    console.log('[Invention] getInventionData called for blueprintTypeId:', blueprintTypeId);
    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        // Check if this blueprint can be used for invention (activityID = 8)
        const hasInvention = db.prepare(`
            SELECT 1
            FROM industryActivity
            WHERE typeID = ?
              AND activityID = 8
        `).get(blueprintTypeId);

        console.log('[Invention] hasInvention check result:', hasInvention);

        if (!hasInvention) {
            if (ownConnection) {
                db.close();
            }
            console.log('[Invention] No invention activity found, returning null');
            return null;
        }

        // Get invention materials (datacores, data interfaces, optional items)
        const materials = db.prepare(`
            SELECT iam.materialTypeID as typeID, iam.quantity, it.typeName
            FROM industryActivityMaterials iam
                     LEFT JOIN invTypes it ON iam.materialTypeID = it.typeID
            WHERE iam.typeID = ?
              AND iam.activityID = 8
            ORDER BY iam.quantity DESC
        `).all(blueprintTypeId);

        // Get ALL invention products (some blueprints have multiple T2 variants)
        const products = db.prepare(`
            SELECT iap.productTypeID as typeID, iap.quantity, it.typeName
            FROM industryActivityProducts iap
                     LEFT JOIN invTypes it ON iap.productTypeID = it.typeID
            WHERE iap.typeID = ?
              AND iap.activityID = 8
            ORDER BY it.typeName
        `).all(blueprintTypeId);

        // Get the manufactured products for each invention product
        // This is needed for market pricing
        const productsWithManufactured = products.map(product => {
            const manufacturedProduct = db.prepare(`
                SELECT iap.productTypeID as typeID, it.typeName
                FROM industryActivityProducts iap
                         LEFT JOIN invTypes it ON iap.productTypeID = it.typeID
                WHERE iap.typeID = ?
                  AND iap.activityID = 1 LIMIT 1
            `).get(product.typeID);

            // Get base invention probability for this specific product
            const probability = db.prepare(`
                SELECT probability
                FROM industryActivityProbabilities
                WHERE typeID = ?
                  AND activityID = 8
                  AND productTypeID = ? LIMIT 1
            `).get(blueprintTypeId, product.typeID);

            return {
                ...product,
                manufacturedProduct: manufacturedProduct || null,
                baseProbability:     probability ? probability.probability : 0
            };
        });

        // Get required skills with names
        const skills = db.prepare(`
            SELECT ias.skillID, ias.level, it.typeName as skillName
            FROM industryActivitySkills ias
                     LEFT JOIN invTypes it ON ias.skillID = it.typeID
            WHERE ias.typeID = ?
              AND ias.activityID = 8
            ORDER BY ias.level DESC
        `).all(blueprintTypeId);

        // Get invention time
        const time = db.prepare(`
            SELECT time
            FROM industryActivity
            WHERE typeID = ? AND activityID = 8
        `).get(blueprintTypeId);

        if (ownConnection) {
            db.close();
        }

        const result = {
            materials: materials || [],
            products:  productsWithManufactured || [],
            skills:    skills || [],
            time:      time ? time.time : 0
        };

        // Add convenience properties for first product (backward compatibility)
        if (productsWithManufactured && productsWithManufactured.length > 0) {
            result.t2BlueprintTypeID = productsWithManufactured[0].typeID;
            result.baseProbability   = productsWithManufactured[0].baseProbability;
            result.product           = productsWithManufactured[0];
            if (productsWithManufactured[0].manufacturedProduct) {
                result.t2ProductTypeID = productsWithManufactured[0].manufacturedProduct.typeID;
                result.t2ProductName   = productsWithManufactured[0].manufacturedProduct.typeName;
            }
        }

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
 * @param {Database} db - Optional database connection to reuse
 * @returns {Array} Array of decryptors with their modifiers
 */
function getAllDecryptors(db = null) {
    try {
        const ownConnection = !db;
        if (!db) {
            const dbPath = getSDEPath();
            db           = new Database(dbPath, {readonly: true});
        }

        // Decryptors are in groupID 1304
        const decryptors = db.prepare(`
            SELECT t.typeID,
                   t.typeName,
                   MAX(CASE
                           WHEN tattr.attributeID = 1112
                               THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as probabilityMultiplier,
                   MAX(CASE
                           WHEN tattr.attributeID = 1113
                               THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as meModifier,
                   MAX(CASE
                           WHEN tattr.attributeID = 1114
                               THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as teModifier,
                   MAX(CASE
                           WHEN tattr.attributeID = 1124
                               THEN COALESCE(tattr.valueFloat, tattr.valueInt) END) as runsModifier
            FROM invTypes t
                     LEFT JOIN dgmTypeAttributes tattr
                               ON tattr.typeID = t.typeID AND tattr.attributeID IN (1112, 1113, 1114, 1124)
            WHERE t.groupID = 1304
            GROUP BY t.typeID, t.typeName
            ORDER BY t.typeName
        `).all();

        if (ownConnection) db.close();
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
    const datacore1Level  = skills.datacore1 || 0;
    const datacore2Level  = skills.datacore2 || 0;

    const encryptionBonus = 1 + (encryptionLevel / 40);
    const datacoreBonus   = 1 + ((datacore1Level + datacore2Level) / 30);

    const finalProbability = baseProbability * encryptionBonus * datacoreBonus * decryptorMultiplier;

    return Math.min(finalProbability, 1.0); // Cap at 100%
}

/**
 * Get system invention cost index from ESI data
 * @param {number} solarSystemId - Solar system ID
 * @returns {number} Cost index as decimal (e.g., 0.02 for 2%)
 */
function getSystemInventionCostIndex(solarSystemId) {
    if (!solarSystemId) {
        return 0;
    }

    try {
        const indices        = getCostIndices(solarSystemId);
        const inventionIndex = indices.find(idx => idx.activity === 'invention');
        return inventionIndex ? inventionIndex.costIndex : 0;
    } catch (error) {
        console.error('Error getting system invention cost index:', error);
        return 0;
    }
}

/**
 * Get invention facility bonuses from structure and rigs
 * @param {Object} facility - Facility configuration object
 * @returns {Object} { costReductionPercent, facilityTaxPercent }
 */
function getInventionFacilityBonuses(facility) {
    const bonuses = {
        costReductionPercent: 0,
        facilityTaxPercent:   0  // Default 0% for player-owned structures
    };

    if (!facility || !facility.structureTypeId) {
        return bonuses;
    }

    try {
        const db = new Database(getSDEPath(), {readonly: true});

        // Query structure base invention cost bonus (attribute ID 2783)
        const structureBonus = db.prepare(`
            SELECT COALESCE(valueFloat, valueInt) as value
            FROM dgmTypeAttributes
            WHERE typeID = ? AND attributeID = 2783
        `).get(facility.structureTypeId);

        if (structureBonus && structureBonus.value) {
            // Convert from percentage to decimal (e.g., -1 becomes 0.01 for 1% reduction)
            bonuses.costReductionPercent = Math.abs(structureBonus.value) / 100;
        }

        // Apply rig bonuses if present
        if (facility.rigs && Array.isArray(facility.rigs)) {
            for (const rig of facility.rigs) {
                if (!rig.typeId) continue;

                // Query rig invention cost bonus (same attribute ID 2783)
                const rigBonus = db.prepare(`
                    SELECT COALESCE(valueFloat, valueInt) as value
                    FROM dgmTypeAttributes
                    WHERE typeID = ? AND attributeID = 2783
                `).get(rig.typeId);

                if (rigBonus && rigBonus.value) {
                    // Rig bonuses are additive
                    bonuses.costReductionPercent += Math.abs(rigBonus.value) / 100;
                }
            }
        }

        db.close();
    } catch (error) {
        console.error('Error getting invention facility bonuses:', error);
    }

    return bonuses;
}

/**
 * Calculate invention cost per successful run
 * @param {Object} inventionData - Invention data from getInventionData
 * @param {Object} materialPrices - Map of typeID -> price
 * @param {number} probability - Success probability (0-1)
 * @param {Object} decryptor - Optional decryptor object with typeID and runsModifier
 * @param {number} decryptorPrice - Price of decryptor (if used)
 * @param {number} manufacturedProductEIV - EIV of the manufactured product (for job cost calculation)
 * @param {Object} facility - Facility configuration (for cost bonuses and system cost index)
 * @returns {Object} Cost breakdown
 */
function calculateInventionCost(inventionData, materialPrices, probability, decryptor = null, decryptorPrice = 0, manufacturedProductEIV = 0, facility = null) {
    // Calculate material costs (datacores, data interfaces, etc - NOT including decryptor)
    let materialCost = 0;
    inventionData.materials.forEach(mat => {
        const price = materialPrices[mat.typeID] || 0;
        materialCost += price * mat.quantity;
    });

    // Job cost calculation using correct Eve Online formula:
    // Job Base Cost (JBC) = 2% of EIV of Manufactured Product
    // Job Gross Cost = JBC × System Invention Cost Index% - JBC × Structure Cost Reduction%
    // Taxes Total = JBC × Facility Tax% + JBC × 4% (SCC surcharge)
    // Job Total Cost = Job Gross Cost + Taxes Total

    let jobCost = 0;

    if (manufacturedProductEIV > 0) {
        // Step 1: Job Base Cost = 2% of manufactured product EIV
        const jobBaseCost = manufacturedProductEIV * 0.02;

        // Step 2: Get facility bonuses
        const facilityBonuses = getInventionFacilityBonuses(facility);

        // Step 3: Get system cost index
        const systemCostIndex = facility ? getSystemInventionCostIndex(facility.systemId) : 0;

        // Step 4: Calculate Job Gross Cost
        // Apply system cost index multiplier, then subtract structure cost reduction
        const jobGrossCost = (jobBaseCost * systemCostIndex) * (1 - facilityBonuses.costReductionPercent);

        // Step 5: Calculate Taxes
        const sccSurcharge = jobBaseCost * 0.04; // 4% SCC surcharge
        const facilityTax  = jobBaseCost * facilityBonuses.facilityTaxPercent;
        const taxesTotal   = sccSurcharge + facilityTax;

        // Step 6: Total Job Cost
        jobCost = jobGrossCost + taxesTotal;
    }

    // Total cost per attempt = materials + decryptor + job cost
    const totalCostPerAttempt = materialCost + decryptorPrice + jobCost;

    // Cost per successful invention = cost per attempt / probability
    const costPerSuccess = probability > 0 ? totalCostPerAttempt / probability : 0;

    // Calculate runs per invented blueprint
    // Base runs comes from the invention product quantity (e.g., 1 for ships, 10 for ammo)
    const baseRuns     = inventionData.product?.quantity || 1;
    const runsModifier = decryptor ? (decryptor.runsModifier || 0) : 0;
    const totalRuns    = baseRuns + runsModifier;

    // Cost per run = cost per successful invention / number of runs on that blueprint
    const costPerRun = totalRuns > 0 ? costPerSuccess / totalRuns : costPerSuccess;

    return {
        materialCost,
        decryptorCost: decryptorPrice,
        jobCost,
        totalCostPerAttempt,
        probability,
        costPerSuccess,
        runsPerBPC:    totalRuns,
        costPerRun
    };
}

/**
 * Calculate manufacturing cost for invented blueprint at specific ME level
 * @param {number} inventedBlueprintTypeId - TypeID of the invented T2 blueprint
 * @param {number} meLevel - Material Efficiency level (base ME + decryptor modifier)
 * @param {number} runs - Number of runs to manufacture
 * @param {Object} facility - Facility configuration
 * @param {Object} materialPrices - Map of typeID -> price
 * @param {Database} db - Optional database connection to reuse
 * @returns {Object} Manufacturing cost breakdown
 */
async function calculateManufacturingCost(inventedBlueprintTypeId, meLevel, runs, facility, materialPrices, db = null) {
    let returnObject = {
        materialCost: 0,
        jobCost:      0,
        totalCost:    0,
        costPerRun:   0,
        blueprintResult: {},
    }
    try {
        console.log('[Manufacturing Cost] Starting calculation:');
        console.log(`  - Invented Blueprint TypeID: ${inventedBlueprintTypeId}`);
        console.log(`  - ME Level: ${meLevel}`);
        console.log(`  - Runs: ${runs}`);
        console.log(`  - Material Prices keys count: ${materialPrices ? Object.keys(materialPrices).length : 0}`);


        // Use the existing calculateBlueprintMaterials function
        const materialCalc = await calculateBlueprintMaterials(
            inventedBlueprintTypeId,
            runs,
            meLevel,
            null,  // characterId - not needed for this calculation
            facility,
            0,     // depth
            db     // Pass db connection
        );

        console.log('[Manufacturing Cost] Material calculation result:', materialCalc);

        // Validate material calculation result
        if (!materialCalc) {
            console.error('[Manufacturing Cost] materialCalc is null or undefined');
            return returnObject;
        }

        if (!materialCalc.materials) {
            console.error('[Manufacturing Cost] materialCalc.materials is null or undefined. Full object:', JSON.stringify(materialCalc));
            return returnObject;
        }

        if (typeof materialCalc.materials !== 'object') {
            console.error('[Manufacturing Cost] materialCalc.materials is not an object, it is:', typeof materialCalc.materials);
            return returnObject;
        }

        console.log(`  - Materials count: ${Object.keys(materialCalc.materials).length}`);

        // Calculate total material cost
        let totalMaterialCost      = 0;
        let materialsWithPrices    = 0;
        let materialsWithoutPrices = [];

        // materialCalc.materials is an object with typeID as keys and quantities as values
        for (const [typeId, quantity] of Object.entries(materialCalc.materials)) {
            const price = materialPrices[typeId] || 0;

            if (price > 0) {
                materialsWithPrices++;
                console.log(`  - Material ${typeId}: quantity=${quantity}, price=${price}, cost=${price * quantity}`);
            } else {
                materialsWithoutPrices.push(typeId);
            }

            totalMaterialCost += price * quantity;
        }

        console.log(`[Manufacturing Cost] Materials with prices: ${materialsWithPrices}/${Object.keys(materialCalc.materials).length}`);
        if (materialsWithoutPrices.length > 0) {
            console.log(`[Manufacturing Cost] Materials WITHOUT prices: ${materialsWithoutPrices.join(', ')}`);
        }

        console.log(`[Manufacturing Cost] Total Material Cost: ${totalMaterialCost} ISK`);

        // Get manufacturing job cost
        // For T2 manufacturing, job cost is typically based on blueprint value
        // For now, use a simplified 1% of material cost estimate
        // TODO: Implement proper manufacturing job cost calculation
        const jobCost = totalMaterialCost * 0.01;

        console.log(`[Manufacturing Cost] Job Cost: ${jobCost} ISK`);

        returnObject.materialCost = materialCalc?.pricing?.inputCosts?.totalCost;
        returnObject.jobCost = materialCalc?.pricing?.jobCostBreakdown?.totalJobCost;
        returnObject.totalCost = returnObject.materialCost + returnObject.jobCost;
        returnObject.costPerRun = runs > 0 ? (returnObject.totalCost) / runs : 0
        returnObject.blueprintResult = materialCalc;

        return returnObject;
    } catch (error) {
        console.error('Error calculating manufacturing cost:', error);
        return returnObject;
    }
}

/**
 * Calculate manufacturing time for invented blueprint at specific TE level
 * @param {number} inventedBlueprintTypeId - TypeID of the invented T2 blueprint
 * @param {number} teLevel - Time Efficiency level (base TE + decryptor modifier)
 * @param {number} runs - Number of runs to manufacture
 * @param {Object} facility - Facility configuration
 * @param {Database} db - Optional database connection to reuse
 * @returns {Object} Manufacturing time breakdown
 */
function calculateManufacturingTime(inventedBlueprintTypeId, teLevel, runs, facility, db = null) {
    try {
        const ownConnection = !db;
        if (!db) {
            db = new Database(getSDEPath(), {readonly: true});
        }

        // Get base manufacturing time from SDE (activityID = 1 is manufacturing)
        const timeData = db.prepare(`
            SELECT time
            FROM industryActivity
            WHERE typeID = ? AND activityID = 1
        `).get(inventedBlueprintTypeId);

        if (ownConnection) db.close();

        if (!timeData || !timeData.time) {
            return {
                baseTime:     0,
                adjustedTime: 0,
                timePerRun:   0
            };
        }

        const baseTime = timeData.time;

        // Apply TE modifier
        // Each level of TE reduces time by 1% (formula: time * (1 - TE/100))
        const teModifier = 1 - (teLevel / 100);
        let adjustedTime = baseTime * teModifier;

        // Apply facility time bonuses if provided
        if (facility && facility.bonuses && facility.bonuses.timeEfficiency) {
            const facilityTEModifier = 1 - (facility.bonuses.timeEfficiency / 100);
            adjustedTime             = adjustedTime * facilityTEModifier;
        }

        // Multiply by runs
        adjustedTime = adjustedTime * runs;

        return {
            baseTime:     baseTime * runs,
            adjustedTime: adjustedTime,
            timePerRun:   runs > 0 ? adjustedTime / runs : 0
        };
    } catch (error) {
        console.error('Error calculating manufacturing time:', error);
        return {
            baseTime:     0,
            adjustedTime: 0,
            timePerRun:   0
        };
    }
}

/**
 * Find the most profitable decryptor for invention
 * @param {Object} inventionData - Invention data from getInventionData
 * @param {Object} materialPrices - Map of typeID -> price (includes materials and decryptors)
 * @param {number} productPrice - Price of the manufactured product (for EIV calculation)
 * @param {Object} skills - Character skills for invention
 * @param {Object} facility - Facility configuration for cost bonuses and system cost index
 * @param {string} optimizationStrategy - Strategy for selecting best decryptor ('invention-only', 'total-per-item', 'total-full-bpc', 'time-optimized', 'custom-volume')
 * @param {number} customVolume - Number of items to manufacture (used with 'custom-volume' strategy)
 * @returns {Promise<Object>} Best decryptor analysis with comparison
 */
async function findBestDecryptor(inventionData, materialPrices, productPrice, skills = {}, facility = null, optimizationStrategy = 'total-per-item', customVolume = 1) {
    console.log(`[findBestDecryptor] Called with optimizationStrategy: ${optimizationStrategy}, customVolume: ${customVolume}`);

    // Create single database connection for all calculations
    const sdeDb = new Database(getSDEPath(), {readonly: true});

    try {
        const decryptors      = getAllDecryptors(sdeDb);
        const baseProbability         = inventionData.baseProbability;
        const inventedBlueprintTypeId = inventionData.product?.typeID || inventionData.products?.[0]?.typeID;

        // Helper function to calculate option metrics with manufacturing costs
        const calculateOptionMetrics = async (decryptor, decryptorPrice) => {
            const meModifier     = decryptor ? (decryptor.meModifier || 0) : 0;
            const teModifier     = decryptor ? (decryptor.teModifier || 0) : 0;
            const runsModifier   = decryptor ? (decryptor.runsModifier || 0) : 0;
            const probMultiplier = decryptor ? (decryptor.probabilityMultiplier || 1.0) : 1.0;

            // Calculate invention costs
            const prob = calculateInventionProbability(baseProbability, skills, probMultiplier);
            const invCost = calculateInventionCost(inventionData, materialPrices, prob, decryptor, decryptorPrice, productPrice, facility);

            // Calculate manufacturing costs at this ME level (base ME + decryptor modifier)
            const baseME  = 2; // Invented T2 blueprints start at ME 2
            const finalME = baseME + meModifier;
            const baseTE  = 4; // Invented T2 blueprints start at TE 4
            const finalTE = baseTE + teModifier;

            let mfgCostPerItem = 0;
            let mfgCostFullBPC = 0;
            let mfgTimePerItem = 0;
            let mfgCost1 = null; // Declare at function scope to avoid ReferenceError

            if (inventedBlueprintTypeId) {
                console.log(`[Decryptor Option] Calculating for: ${decryptor ? decryptor.typeName : 'No Decryptor'}`);
                console.log(`  - Final ME: ${finalME}, Final TE: ${finalTE}, Runs per BPC: ${invCost.runsPerBPC}`);

                // Manufacturing cost for 1 item
                mfgCost1 = await calculateManufacturingCost(inventedBlueprintTypeId, finalME, 1, facility, materialPrices, sdeDb);
                mfgCostPerItem = mfgCost1.costPerRun;
                console.log(`  - Manufacturing cost per item: ${mfgCostPerItem} ISK`);

                // Manufacturing cost for all runs on BPC
                const mfgCostAll = await calculateManufacturingCost(inventedBlueprintTypeId, finalME, invCost.runsPerBPC, facility, materialPrices, sdeDb);
                mfgCostFullBPC   = mfgCostAll.totalCost;
                console.log(`  - Manufacturing cost full BPC: ${mfgCostFullBPC} ISK`);

                // Manufacturing time
                const mfgTime  = calculateManufacturingTime(inventedBlueprintTypeId, finalTE, 1, facility, sdeDb);
                mfgTimePerItem = mfgTime.timePerRun;
            } else {
                console.log('[Decryptor Option] No inventedBlueprintTypeId found!');
            }

            // Calculate optimization metric based on strategy
            let optimizationMetric;
            switch (optimizationStrategy) {
                case 'invention-only':
                    optimizationMetric = invCost.costPerRun;
                    break;
                case 'total-per-item':
                    optimizationMetric = invCost.costPerRun + mfgCostPerItem;
                    break;
                case 'total-full-bpc':
                    optimizationMetric = (invCost.costPerRun * invCost.runsPerBPC) + mfgCostFullBPC;
                    break;
                case 'time-optimized':
                    optimizationMetric = mfgTimePerItem; // Lower is better
                    break;
                case 'custom-volume':
                    optimizationMetric = (invCost.costPerRun * customVolume) + (mfgCostPerItem * customVolume);
                    break;
                default:
                    optimizationMetric = invCost.costPerRun + mfgCostPerItem;
            }

            console.log(`[Decryptor: ${decryptor ? decryptor.typeName : 'None'}] Strategy: ${optimizationStrategy}, Metric: ${optimizationMetric}, costPerRun: ${invCost.costPerRun}, mfgCostPerItem: ${mfgCostPerItem}, mfgTime: ${mfgTimePerItem}`);

            return {
                name:                  decryptor ? decryptor.typeName : 'No Decryptor',
                typeID:                decryptor ? decryptor.typeID : null,
                blueprintResult:       mfgCost1?.blueprintResult || {},
                probability:           prob,
                costPerSuccess:        invCost.costPerSuccess,
                costPerRun:            invCost.costPerRun,
                runsPerBPC:            invCost.runsPerBPC,
                materialCost:          invCost.materialCost,
                decryptorCost:         invCost.decryptorCost,
                jobCost:               invCost.jobCost,
                totalCostPerAttempt:   invCost.totalCostPerAttempt,
                meModifier,
                finalME,
                teModifier,
                finalTE,
                runsModifier,
                probabilityMultiplier: probMultiplier,
                // New manufacturing metrics
                manufacturingCostPerItem: mfgCostPerItem,
                manufacturingCostFullBPC: mfgCostFullBPC,
                manufacturingTimePerItem: mfgTimePerItem,
                totalCostPerItem:         invCost.costPerRun + mfgCostPerItem,
                totalCostFullBPC:         (invCost.costPerRun * invCost.runsPerBPC) + mfgCostFullBPC,
                optimizationMetric,
                optimizationStrategy
            };
        };

        // Calculate all decryptor options in parallel
        console.log(`[findBestDecryptor] Calculating ${decryptors.length + 1} decryptor options in parallel...`);
        const startTime = Date.now();

        const optionPromises = [
            calculateOptionMetrics(null, 0) // No decryptor option
        ];

        for (const dec of decryptors) {
            const decPrice = materialPrices[dec.typeID] || 0;
            optionPromises.push(calculateOptionMetrics(dec, decPrice));
        }

        // Wait for all calculations to complete in parallel
        const allOptions = await Promise.all(optionPromises);

        const elapsedTime = Date.now() - startTime;
        console.log(`[findBestDecryptor] Completed ${allOptions.length} calculations in ${elapsedTime}ms (${Math.round(elapsedTime / allOptions.length)}ms per option)`);

        // Find best option from results
        let bestOption = allOptions[0];
        for (const option of allOptions) {
            if (option.optimizationMetric < bestOption.optimizationMetric) {
                console.log(`[findBestDecryptor] New best: ${option.name} with metric ${option.optimizationMetric} (was: ${bestOption.name} with ${bestOption.optimizationMetric})`);
                bestOption = option;
            }
        }

        console.log(`[findBestDecryptor] Final best decryptor: ${bestOption.name} with metric ${bestOption.optimizationMetric}`);

        // Get no decryptor option for comparison
        const noDecryptorOption = allOptions[0];

        return {
            best:                 bestOption,
            noDecryptor:          {
                probability:              noDecryptorOption.probability,
                costPerSuccess:           noDecryptorOption.costPerSuccess,
                totalCost:                noDecryptorOption.totalCostPerAttempt,
                totalCostPerItem:         noDecryptorOption.totalCostPerItem,
                manufacturingCostPerItem: noDecryptorOption.manufacturingCostPerItem
            },
            allOptions:           allOptions,
            optimizationStrategy: optimizationStrategy
        };
    } finally {
        // Always close the database connection
        sdeDb.close();
    }
}

/**
 * Clear all calculation caches (material tree and type names)
 * Call this when switching to a different blueprint
 */
function clearMaterialCache() {
    materialTreeCache.clear();
    typeNameCache.clear();
    console.log('[Cache] Cleared material tree and type name caches');
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
    findBestDecryptor,
    // Manufacturing calculations
    calculateManufacturingTime,
    calculateManufacturingCost,
    // Cache management
    clearMaterialCache
};
