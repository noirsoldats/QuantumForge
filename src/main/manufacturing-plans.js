const { getCharacterDatabase } = require('./character-database');
const { calculateBlueprintMaterials, getBlueprintProduct, getBlueprintForProduct, getOwnedBlueprintME } = require('./blueprint-calculator');
const { calculateReactionMaterials, getReactionProduct, getReactionForProduct, getReactionMaterials, calculateReactionMaterialQuantity } = require('./reaction-calculator');
const { calculateRealisticPrice } = require('./market-pricing');
const { getInputLocation, getOutputLocation } = require('./blueprint-pricing');
const { getAssets } = require('./esi-assets');
const { getMarketSettings } = require('./settings-manager');
const { getSdePath } = require('./sde-manager');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

// ============================================================================
// HELPER FUNCTIONS - Shared logic for intermediate blueprint processing
// ============================================================================

/**
 * Enrich a facility snapshot with securityStatus from SDE.
 * The rig bonus calculator uses `facility.securityStatus ?? 0.5` — if securityStatus
 * is missing the wrong rig bonus is applied. This matches what the reactions:calculateMaterials
 * IPC handler does before calling calculateReactionMaterials.
 */
async function enrichFacilityWithSecurityStatus(facility) {
  if (!facility || !facility.systemId || facility.securityStatus != null) {
    return facility;
  }
  const { getSystemSecurityStatus } = require('./sde-database');
  facility.securityStatus = await getSystemSecurityStatus(facility.systemId);
  return facility;
}

/**
 * Classify materials into intermediates, reactions, and raw materials
 * @param {object} materials - Materials object from calculateBlueprintMaterials or calculateReactionMaterials
 * @returns {object} { intermediates: [{typeId, quantity, blueprintTypeId, product}], reactions: [{typeId, quantity, reactionTypeId, product}], rawMaterials: [{typeId, quantity}] }
 */
async function classifyMaterials(materials) {
  const intermediates = [];
  const reactions = [];
  const rawMaterials = [];

  for (const [materialTypeId, materialQuantity] of Object.entries(materials)) {
    const typeIdInt = parseInt(materialTypeId);
    const blueprintTypeId = getBlueprintForProduct(typeIdInt);
    const reactionTypeId = await getReactionForProduct(typeIdInt);

    if (blueprintTypeId) {
      const product = getBlueprintProduct(blueprintTypeId);
      intermediates.push({
        typeId: typeIdInt,
        quantity: materialQuantity,
        blueprintTypeId: blueprintTypeId,
        product: product
      });
    } else if (reactionTypeId) {
      const product = await getReactionProduct(reactionTypeId);
      reactions.push({
        typeId: typeIdInt,
        quantity: materialQuantity,
        reactionTypeId: reactionTypeId,
        product: product
      });
    } else {
      rawMaterials.push({
        typeId: typeIdInt,
        quantity: materialQuantity
      });
    }
  }

  return { intermediates, reactions, rawMaterials };
}

/**
 * Calculate runs needed for an intermediate blueprint
 * @param {number} materialQuantity - Units of product needed
 * @param {number} blueprintTypeId - Blueprint type ID
 * @returns {number} Runs needed
 */
function calculateIntermediateRuns(materialQuantity, blueprintTypeId) {
  const product = getBlueprintProduct(blueprintTypeId);
  const productsPerRun = product ? product.quantity : 1;
  return Math.ceil(materialQuantity / productsPerRun);
}

/**
 * Calculate runs needed for a reaction
 * @param {number} materialQuantity - Units of product needed
 * @param {number} reactionTypeId - Reaction formula type ID
 * @returns {Promise<number>} Runs needed
 */
async function calculateReactionRuns(materialQuantity, reactionTypeId) {
  const product = await getReactionProduct(reactionTypeId);
  const productsPerRun = product ? product.quantity : 1;
  return Math.ceil(materialQuantity / productsPerRun);
}

/**
 * Check recursion depth limit
 * @param {number} depth - Current depth
 * @param {number} maxDepth - Maximum allowed depth (default 10)
 * @param {string} context - Context for warning message
 * @returns {boolean} True if depth exceeded
 */
function isMaxDepthExceeded(depth, maxDepth = 10, context = 'intermediate expansion') {
  if (depth >= maxDepth) {
    console.warn(`[Plans] Max depth ${maxDepth} reached for ${context}`);
    return true;
  }
  return false;
}

// ============================================================================
// MANUFACTURING PLANS CRUD OPERATIONS
// ============================================================================

/**
 * Create a new manufacturing plan
 * @param {number} characterId - Character ID
 * @param {string} planName - Plan name (default: "Plan - [DateTime]")
 * @param {string} description - Plan description
 * @returns {Object} Created plan with planId
 */
function createManufacturingPlan(characterId, planName = null, description = null) {
  try {
    const db = getCharacterDatabase();
    const planId = randomUUID();
    const now = Date.now();

    // Generate default name if not provided
    if (!planName) {
      const date = new Date(now);
      planName = `Plan - ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    db.prepare(`
      INSERT INTO manufacturing_plans (plan_id, character_id, plan_name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(planId, characterId, planName, description, 'active', now, now);

    console.log(`Created manufacturing plan: ${planId} for character ${characterId}`);

    return {
      planId,
      characterId,
      planName,
      description,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    console.error('Error creating manufacturing plan:', error);
    throw error;
  }
}

/**
 * Get a manufacturing plan by ID
 * @param {string} planId - Plan ID
 * @returns {Object|null} Plan details or null if not found
 */
function getManufacturingPlan(planId) {
  try {
    const db = getCharacterDatabase();

    const plan = db.prepare(`
      SELECT * FROM manufacturing_plans WHERE plan_id = ?
    `).get(planId);

    if (!plan) {
      return null;
    }

    return {
      planId: plan.plan_id,
      characterId: plan.character_id,
      planName: plan.plan_name,
      description: plan.description,
      status: plan.status,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      completedAt: plan.completed_at,
    };
  } catch (error) {
    console.error('Error getting manufacturing plan:', error);
    return null;
  }
}

/**
 * Get all manufacturing plans for a character
 * @param {number} characterId - Character ID
 * @param {Object} filters - Optional filters (status)
 * @returns {Array} Array of plans
 */
function getManufacturingPlans(characterId, filters = {}) {
  try {
    const db = getCharacterDatabase();

    let query = 'SELECT * FROM manufacturing_plans WHERE character_id = ?';
    const params = [characterId];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    query += ' ORDER BY created_at DESC';

    const plans = db.prepare(query).all(...params);

    return plans.map(plan => ({
      planId: plan.plan_id,
      characterId: plan.character_id,
      planName: plan.plan_name,
      description: plan.description,
      status: plan.status,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      completedAt: plan.completed_at,
    }));
  } catch (error) {
    console.error('Error getting manufacturing plans:', error);
    return [];
  }
}

/**
 * Update a manufacturing plan
 * @param {string} planId - Plan ID
 * @param {Object} updates - Fields to update (planName, description, status, completedAt)
 * @returns {boolean} Success status
 */
function updateManufacturingPlan(planId, updates) {
  try {
    const db = getCharacterDatabase();
    const now = Date.now();

    const allowedFields = ['plan_name', 'description', 'status', 'completed_at'];
    const fields = [];
    const values = [];

    // Map camelCase to snake_case and build UPDATE statement
    const fieldMap = {
      planName: 'plan_name',
      description: 'description',
      status: 'status',
      completedAt: 'completed_at',
    };

    for (const [key, value] of Object.entries(updates)) {
      const dbField = fieldMap[key];
      if (dbField && allowedFields.includes(dbField)) {
        fields.push(`${dbField} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) {
      return false;
    }

    // Always update updated_at
    fields.push('updated_at = ?');
    values.push(now);
    values.push(planId);

    const query = `UPDATE manufacturing_plans SET ${fields.join(', ')} WHERE plan_id = ?`;
    const result = db.prepare(query).run(...values);

    console.log(`Updated manufacturing plan: ${planId}`);
    return result.changes > 0;
  } catch (error) {
    console.error('Error updating manufacturing plan:', error);
    return false;
  }
}

/**
 * Delete a manufacturing plan (cascades to all related data)
 * @param {string} planId - Plan ID
 * @returns {boolean} Success status
 */
function deleteManufacturingPlan(planId) {
  try {
    const db = getCharacterDatabase();

    const result = db.prepare('DELETE FROM manufacturing_plans WHERE plan_id = ?').run(planId);

    console.log(`Deleted manufacturing plan: ${planId}`);
    return result.changes > 0;
  } catch (error) {
    console.error('Error deleting manufacturing plan:', error);
    return false;
  }
}

/**
 * Get plan industry settings
 * @param {string} planId - Plan ID
 * @returns {Object} Settings object
 */
function getPlanIndustrySettings(planId) {
  const db = getCharacterDatabase();
  const { loadSettings } = require('./settings-manager');

  let settings = db.prepare(`
    SELECT enabled_divisions_json, default_characters_json,
           reactions_as_intermediates, last_updated
    FROM plan_industry_settings
    WHERE plan_id = ?
  `).get(planId);

  if (!settings) {
    // No settings exist yet, return defaults from global settings
    const globalSettings = loadSettings();
    return {
      enabledDivisions: {}, // Empty per-character divisions
      defaultCharacters: globalSettings.industry?.defaultManufacturingCharacters || [],
      reactionsAsIntermediates: globalSettings.industry?.calculateReactionsAsIntermediates || false,
      lastUpdated: null
    };
  }

  return {
    enabledDivisions: JSON.parse(settings.enabled_divisions_json || '{}'),
    defaultCharacters: JSON.parse(settings.default_characters_json || '[]'),
    reactionsAsIntermediates: Boolean(settings.reactions_as_intermediates),
    lastUpdated: settings.last_updated
  };
}

/**
 * Update plan industry settings
 * @param {string} planId - Plan ID
 * @param {Object} settings - Settings to update
 * @returns {boolean} Success status
 */
function updatePlanIndustrySettings(planId, settings) {
  try {
    const db = getCharacterDatabase();
    const now = Date.now();

    // Validate plan exists
    const plan = db.prepare('SELECT plan_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      console.error('[Plans] Plan not found:', planId);
      return false;
    }

    // Check if settings record exists
    const existing = db.prepare('SELECT plan_id FROM plan_industry_settings WHERE plan_id = ?').get(planId);

    if (existing) {
      // Update existing settings
      db.prepare(`
        UPDATE plan_industry_settings SET
          enabled_divisions_json = ?,
          default_characters_json = ?,
          reactions_as_intermediates = ?,
          last_updated = ?
        WHERE plan_id = ?
      `).run(
        JSON.stringify(settings.enabledDivisions || {}),
        JSON.stringify(settings.defaultCharacters || []),
        settings.reactionsAsIntermediates ? 1 : 0,
        now,
        planId
      );
    } else {
      // Insert new settings
      db.prepare(`
        INSERT INTO plan_industry_settings (
          plan_id, enabled_divisions_json, default_characters_json,
          reactions_as_intermediates, last_updated
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        planId,
        JSON.stringify(settings.enabledDivisions || {}),
        JSON.stringify(settings.defaultCharacters || []),
        settings.reactionsAsIntermediates ? 1 : 0,
        now
      );
    }

    console.log('[Plans] Updated industry settings for plan:', planId);
    return true;
  } catch (error) {
    console.error('[Plans] Error updating plan industry settings:', error);
    return false;
  }
}

/**
 * Update enabled divisions for a specific character in a plan
 * @param {string} planId - Plan ID
 * @param {number} characterId - Character ID
 * @param {number[]} enabledDivisions - Array of division IDs
 * @returns {boolean} Success status
 */
function updatePlanCharacterDivisions(planId, characterId, enabledDivisions) {
  try {
    const currentSettings = getPlanIndustrySettings(planId);
    currentSettings.enabledDivisions[characterId] = enabledDivisions;
    return updatePlanIndustrySettings(planId, currentSettings);
  } catch (error) {
    console.error('[Plans] Error updating plan character divisions:', error);
    return false;
  }
}

/**
 * Add a blueprint to a manufacturing plan
 * @param {string} planId - Plan ID
 * @param {Object} blueprintConfig - Blueprint configuration
 * @param {number} blueprintConfig.blueprintTypeId - Blueprint type ID
 * @param {number} blueprintConfig.runs - Number of runs
 * @param {number} blueprintConfig.lines - Number of concurrent production lines (default: 1)
 * @param {number} blueprintConfig.meLevel - ME level
 * @param {number} blueprintConfig.teLevel - TE level (optional)
 * @param {string} blueprintConfig.facilityId - Facility ID (optional)
 * @param {Object} blueprintConfig.facilitySnapshot - Facility snapshot JSON (optional)
 * @returns {Promise<Object>} Added blueprint with planBlueprintId
 */
async function addBlueprintToPlan(planId, blueprintConfig) {
  try {
    const db = getCharacterDatabase();
    const planBlueprintId = randomUUID();
    const now = Date.now();

    // Get plan to find character ID
    const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    const {
      blueprintTypeId,
      runs,
      lines = 1,
      meLevel,
      teLevel = null,
      facilityId = null,
      facilitySnapshot = null,
    } = blueprintConfig;

    // Insert top-level blueprint into plan
    db.prepare(`
      INSERT INTO plan_blueprints (
        plan_blueprint_id, plan_id, blueprint_type_id, runs, lines,
        me_level, te_level, facility_id, facility_snapshot,
        is_intermediate, added_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      planBlueprintId,
      planId,
      blueprintTypeId,
      runs,
      lines,
      meLevel,
      teLevel,
      facilityId,
      facilitySnapshot ? JSON.stringify(facilitySnapshot) : null,
      now
    );

    console.log(`Added blueprint ${blueprintTypeId} to plan ${planId}`);

    // Detect and create intermediate blueprints
    await detectAndCreateIntermediates(planBlueprintId, planId, plan.character_id);

    // Trigger material and product recalculation
    await recalculatePlanMaterials(planId, true);

    // Update plan's updated_at timestamp
    db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?').run(now, planId);

    return {
      planBlueprintId,
      planId,
      blueprintTypeId,
      runs,
      lines,
      meLevel,
      teLevel,
      facilityId,
      facilitySnapshot,
      addedAt: now,
    };
  } catch (error) {
    console.error('Error adding blueprint to plan:', error);
    throw error;
  }
}

/**
 * Detect and create intermediate blueprint database entries for a parent blueprint
 *
 * This function is part of the STRUCTURE CREATION phase - it manages the database
 * entries for intermediates but does NOT calculate final materials.
 *
 * This function can be called:
 * - Directly when adding a new blueprint to a plan (via addBlueprintToPlan)
 * - Automatically by recalculatePlanMaterials() to ensure structure is up-to-date
 * - Recursively for nested intermediates (depth controlled, max 10)
 *
 * The created intermediates will have default configurations:
 * - ME level: From character's owned blueprints, or 0 if not owned
 * - TE level: 0
 * - use_intermediates: 'raw_materials' (always expand by default)
 * - facility: inherited from parent
 * - runs: calculated based on parent's material requirements
 *
 * Users can customize these after creation via updateIntermediateBlueprint(),
 * and recalculatePlanMaterials() will respect those customizations.
 *
 * This function is idempotent:
 * - Checks for existing intermediates before creating
 * - Updates runs if changed
 * - Safe to call multiple times
 *
 * @param {string} parentBlueprintId - Plan blueprint ID of parent
 * @param {string} planId - Manufacturing plan ID
 * @param {string} characterId - Character ID for skill/blueprint lookups
 * @param {number} depth - Current recursion depth (internal, default 0)
 * @returns {Promise<string[]>} Array of created/updated intermediate plan_blueprint_ids
 */
async function detectAndCreateIntermediates(parentBlueprintId, planId, characterId, depth = 0) {
  // Check depth limit using helper
  if (isMaxDepthExceeded(depth, 10, `detectAndCreateIntermediates for ${parentBlueprintId}`)) {
    return [];
  }

  try {
    const db = getCharacterDatabase();

    // Get parent blueprint details
    const parent = db.prepare('SELECT * FROM plan_blueprints WHERE plan_blueprint_id = ?').get(parentBlueprintId);
    if (!parent) {
      return [];
    }

    // Only detect intermediates if using raw_materials mode
    const useIntermediates = parent.use_intermediates === 'raw_materials' ||
                             parent.use_intermediates === null ||
                             parent.use_intermediates === 1 ||
                             parent.use_intermediates === true;

    if (!useIntermediates) {
      return [];
    }

    // Parse facility snapshot
    const facilitySnapshot = parent.facility_snapshot ? JSON.parse(parent.facility_snapshot) : null;

    // Calculate runs per line for parent - ME floor applies per job
    const parentRunsPerLine = Math.ceil(parent.runs / parent.lines);

    // CRITICAL: Call calculateBlueprintMaterials with useIntermediates=FALSE
    // Calculate materials for runs PER LINE (ME floor applies per job)
    const calculation = await calculateBlueprintMaterials(
      parent.blueprint_type_id,
      parentRunsPerLine,  // Runs per line - ME floor applies here
      parent.me_level,
      characterId,
      facilitySnapshot,
      false  // CRITICAL: Always false - we manually expand intermediates below
    );

    const createdIntermediateIds = [];
    const now = Date.now();

    // Classify materials using helper function
    // Note: calculation.materials contains per-line quantities
    const { intermediates, rawMaterials } = await classifyMaterials(calculation.materials);

    // Process each intermediate
    for (const intermediate of intermediates) {
      const intermediateBlueprintTypeId = intermediate.blueprintTypeId;
      const materialTypeId = intermediate.typeId;
      // materialQuantity is per-line, multiply by lines for total needed
      const materialQuantityPerLine = intermediate.quantity;
      const totalMaterialsNeeded = materialQuantityPerLine * parent.lines;
      const product = intermediate.product;

      // Calculate runs needed using helper function with total materials needed
      const runsNeeded = calculateIntermediateRuns(totalMaterialsNeeded, intermediateBlueprintTypeId);
      const productsPerRun = product ? product.quantity : 1;

      console.log(`[Plans] Intermediate detected: ${intermediateBlueprintTypeId} - need ${totalMaterialsNeeded} units @ ${productsPerRun}/run = ${runsNeeded} runs (depth ${depth})`);

      // Check if this intermediate already exists for this parent
      const existing = db.prepare(`
        SELECT plan_blueprint_id, runs FROM plan_blueprints
        WHERE parent_blueprint_id = ?
          AND blueprint_type_id = ?
          AND intermediate_product_type_id = ?
      `).get(parentBlueprintId, intermediateBlueprintTypeId, materialTypeId);

      let intermediateBlueprintId;
      if (existing) {
        // Update runs if it changed
        if (existing.runs !== runsNeeded) {
          db.prepare(`
            UPDATE plan_blueprints
            SET runs = ?
            WHERE plan_blueprint_id = ?
          `).run(runsNeeded, existing.plan_blueprint_id);
          console.log(`[Plans] Updated intermediate ${intermediateBlueprintTypeId} runs: ${existing.runs} → ${runsNeeded}`);
        }
        intermediateBlueprintId = existing.plan_blueprint_id;
        createdIntermediateIds.push(existing.plan_blueprint_id);
      } else {
        // Create new intermediate blueprint entry
        intermediateBlueprintId = randomUUID();

        // Use parent's facility by default
        const intermediateFacilityId = parent.facility_id;

        // Get ME level from owned blueprints
        let intermediateME = getOwnedBlueprintME(characterId, intermediateBlueprintTypeId) || 0;

        db.prepare(`
          INSERT INTO plan_blueprints (
            plan_blueprint_id, plan_id, parent_blueprint_id,
            blueprint_type_id, runs, lines,
            me_level, te_level, facility_id, facility_snapshot,
            is_intermediate, is_built, intermediate_product_type_id,
            use_intermediates,
            added_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
        `).run(
          intermediateBlueprintId,
          planId,
          parentBlueprintId,
          intermediateBlueprintTypeId,
          runsNeeded,
          1,  // lines always 1 for intermediates
          intermediateME,
          0,  // te_level
          intermediateFacilityId,
          facilitySnapshot ? JSON.stringify(facilitySnapshot) : null,
          materialTypeId,
          'raw_materials',  // CRITICAL: Always expand intermediates by default
          now
        );

        console.log(`[Plans] Created intermediate ${intermediateBlueprintTypeId} (${runsNeeded} runs for ${totalMaterialsNeeded} ${product ? product.typeName : 'units'})`);
        createdIntermediateIds.push(intermediateBlueprintId);
      }

      // Recursively detect and create nested intermediates
      const nestedIds = await detectAndCreateIntermediates(
        intermediateBlueprintId,  // This intermediate becomes the parent
        planId,
        characterId,
        depth + 1
      );
      createdIntermediateIds.push(...nestedIds);

      // NOTE: Reactions are no longer detected per-parent
      // They are now detected and created globally in PHASE 2.5 after all materials are aggregated
    }

    return createdIntermediateIds;
  } catch (error) {
    console.error('Error detecting and creating intermediates:', error);
    return [];
  }
}

/**
 * Detect and create reaction records for a parent blueprint's materials
 * Similar to detectAndCreateIntermediates but for reactions (activityID=11)
 * @param {string} parentBlueprintId - Parent blueprint ID
 * @param {string} planId - Manufacturing plan ID
 * @param {number} characterId - Character ID
 * @param {number} depth - Recursion depth (max 10)
 * @returns {Promise<Array>} Array of created reaction blueprint IDs
 */
async function detectAndCreateReactions(parentBlueprintId, planId, characterId, depth = 0) {
  // Check depth limit using helper
  if (isMaxDepthExceeded(depth, 10, `detectAndCreateReactions for ${parentBlueprintId}`)) {
    return [];
  }

  try {
    const db = getCharacterDatabase();

    // Get parent blueprint details
    const parent = db.prepare('SELECT * FROM plan_blueprints WHERE plan_blueprint_id = ?').get(parentBlueprintId);
    if (!parent) {
      return [];
    }

    // Only detect reactions if using raw_materials mode
    const useIntermediates = parent.use_intermediates === 'raw_materials' ||
                             parent.use_intermediates === null ||
                             parent.use_intermediates === 1 ||
                             parent.use_intermediates === true;

    if (!useIntermediates) {
      return [];
    }

    // Parse facility snapshot
    const facilitySnapshot = parent.facility_snapshot ? JSON.parse(parent.facility_snapshot) : null;

    // Calculate runs per line for parent - ME floor applies per job
    const parentRunsPerLine = Math.ceil(parent.runs / parent.lines);

    // Determine parent type and calculate materials accordingly
    let materials;
    if (parent.blueprint_type === 'reaction') {
      // Parent is a reaction - get its inputs (reactions always have lines=1)
      const reactionCalculation = await calculateReactionMaterials(
        parent.blueprint_type_id,  // This is the reactionTypeId for reactions
        parent.runs,
        characterId,
        facilitySnapshot
      );
      materials = reactionCalculation.materials;
    } else {
      // Parent is a manufacturing blueprint - calculate per-line materials
      const calculation = await calculateBlueprintMaterials(
        parent.blueprint_type_id,
        parentRunsPerLine,  // Runs per line - ME floor applies here
        parent.me_level,
        characterId,
        facilitySnapshot,
        false  // Always false - we manually expand
      );
      materials = calculation.materials;
    }

    const createdReactionIds = [];
    const now = Date.now();

    // Classify materials using helper function
    // Note: materials contain per-line quantities for manufacturing blueprints
    const { reactions } = await classifyMaterials(materials);

    // Process each reaction
    for (const reaction of reactions) {
      const reactionTypeId = reaction.reactionTypeId;
      const materialTypeId = reaction.typeId;
      // For manufacturing blueprints, multiply by lines for total; for reactions, lines=1
      const materialQuantityPerLine = reaction.quantity;
      const totalMaterialsNeeded = materialQuantityPerLine * parent.lines;
      const product = reaction.product;

      // Calculate runs needed using helper function with total materials needed
      const runsNeeded = await calculateReactionRuns(totalMaterialsNeeded, reactionTypeId);
      const productsPerRun = product ? product.quantity : 1;

      console.log(`[Plans] Reaction detected: ${reactionTypeId} - need ${totalMaterialsNeeded} units @ ${productsPerRun}/run = ${runsNeeded} runs (depth ${depth})`);

      // Check if this reaction already exists for this parent
      const existing = db.prepare(`
        SELECT plan_blueprint_id, runs FROM plan_blueprints
        WHERE parent_blueprint_id = ?
          AND blueprint_type_id = ?
          AND blueprint_type = 'reaction'
          AND intermediate_product_type_id = ?
      `).get(parentBlueprintId, reactionTypeId, materialTypeId);

      let reactionBlueprintId;
      if (existing) {
        // Update runs if it changed
        if (existing.runs !== runsNeeded) {
          db.prepare(`
            UPDATE plan_blueprints
            SET runs = ?
            WHERE plan_blueprint_id = ?
          `).run(runsNeeded, existing.plan_blueprint_id);
          console.log(`[Plans] Updated reaction ${reactionTypeId} runs: ${existing.runs} → ${runsNeeded}`);
        }
        reactionBlueprintId = existing.plan_blueprint_id;
        createdReactionIds.push(existing.plan_blueprint_id);
      } else {
        // Create new reaction entry
        reactionBlueprintId = randomUUID();

        // Use parent's facility by default (should be refinery for reactions)
        const reactionFacilityId = parent.facility_id;

        db.prepare(`
          INSERT INTO plan_blueprints (
            plan_blueprint_id, plan_id, parent_blueprint_id,
            blueprint_type_id, runs, lines,
            me_level, te_level, facility_id, facility_snapshot,
            is_intermediate, is_built, intermediate_product_type_id,
            use_intermediates, blueprint_type, reaction_type_id,
            added_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'reaction', ?, ?)
        `).run(
          reactionBlueprintId,
          planId,
          parentBlueprintId,
          reactionTypeId,  // blueprint_type_id stores reactionTypeId for reactions
          runsNeeded,
          1,  // lines always 1 for reactions
          0,  // me_level (not applicable for reactions)
          0,  // te_level (not applicable for reactions)
          reactionFacilityId,
          facilitySnapshot ? JSON.stringify(facilitySnapshot) : null,
          materialTypeId,
          'raw_materials',  // Always expand reactions by default
          reactionTypeId,  // Also store in reaction_type_id for clarity
          now
        );

        console.log(`[Plans] Created reaction ${reactionTypeId} (${runsNeeded} runs for ${materialQuantity * parent.lines} ${product ? product.typeName : 'units'})`);
        createdReactionIds.push(reactionBlueprintId);
      }

      // Recursively detect nested reactions (reactions that produce inputs for this reaction)
      const nestedReactionIds = await detectAndCreateReactions(
        reactionBlueprintId,  // This reaction becomes the parent
        planId,
        characterId,
        depth + 1
      );
      createdReactionIds.push(...nestedReactionIds);

      // CRITICAL: Also check this reaction for intermediates
      const nestedIntermediateIds = await detectAndCreateIntermediates(
        reactionBlueprintId,  // This reaction becomes the parent
        planId,
        characterId,
        depth + 1
      );
      createdReactionIds.push(...nestedIntermediateIds);
    }

    return createdReactionIds;
  } catch (error) {
    console.error('Error detecting and creating reactions:', error);
    return [];
  }
}

/**
 * Update a plan blueprint
 * @param {string} planBlueprintId - Plan blueprint ID
 * @param {Object} updates - Fields to update (runs, lines, meLevel, teLevel, facilityId, facilitySnapshot)
 * @returns {Promise<boolean>} Success status
 */
async function updatePlanBlueprint(planBlueprintId, updates) {
  try {
    const db = getCharacterDatabase();

    // Get the blueprint details including plan_id and is_intermediate
    const blueprint = db.prepare(`
      SELECT pb.plan_id, pb.is_intermediate, mp.character_id
      FROM plan_blueprints pb
      JOIN manufacturing_plans mp ON pb.plan_id = mp.plan_id
      WHERE pb.plan_blueprint_id = ?
    `).get(planBlueprintId);
    if (!blueprint) {
      return false;
    }

    const allowedFields = ['runs', 'lines', 'me_level', 'te_level', 'facility_id', 'facility_snapshot', 'use_intermediates'];
    const fields = [];
    const values = [];

    const fieldMap = {
      runs: 'runs',
      lines: 'lines',
      meLevel: 'me_level',
      teLevel: 'te_level',
      facilityId: 'facility_id',
      facilitySnapshot: 'facility_snapshot',
      useIntermediates: 'use_intermediates',
    };

    for (const [key, value] of Object.entries(updates)) {
      const dbField = fieldMap[key];
      if (dbField && allowedFields.includes(dbField)) {
        fields.push(`${dbField} = ?`);
        // Stringify facilitySnapshot if it's an object
        if (key === 'facilitySnapshot' && value !== null) {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
      }
    }

    if (fields.length === 0) {
      return false;
    }

    values.push(planBlueprintId);

    const query = `UPDATE plan_blueprints SET ${fields.join(', ')} WHERE plan_blueprint_id = ?`;
    const result = db.prepare(query).run(...values);

    if (result.changes > 0) {
      console.log(`Updated plan blueprint: ${planBlueprintId}`);

      // Trigger material recalculation
      // Note: recalculatePlanMaterials() now handles intermediate structure sync internally,
      // so we no longer need to call detectAndCreateIntermediates() here
      await recalculatePlanMaterials(blueprint.plan_id, false);

      // Update plan's updated_at
      const now = Date.now();
      db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?').run(now, blueprint.plan_id);
    }

    return result.changes > 0;
  } catch (error) {
    console.error('Error updating plan blueprint:', error);
    return false;
  }
}

/**
 * Bulk update multiple blueprints in a plan
 * More efficient than individual updates - recalculates materials once at the end
 * @param {string} planId - Plan ID
 * @param {Array} bulkUpdates - Array of {planBlueprintId, updates}
 * @returns {Promise<boolean>} Success status
 */
async function bulkUpdateBlueprints(planId, bulkUpdates) {
  if (!bulkUpdates || bulkUpdates.length === 0) {
    return true; // Nothing to update
  }

  try {
    const db = getCharacterDatabase();

    // Get plan to find character ID
    const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    // Begin transaction for atomic updates
    db.exec('BEGIN TRANSACTION');

    try {
      const allowedFields = ['runs', 'lines', 'me_level', 'te_level', 'facility_id', 'facility_snapshot', 'use_intermediates'];
      const fieldMap = {
        runs: 'runs',
        lines: 'lines',
        meLevel: 'me_level',
        teLevel: 'te_level',
        facilityId: 'facility_id',
        facilitySnapshot: 'facility_snapshot',
        useIntermediates: 'use_intermediates',
      };

      for (const { planBlueprintId, updates } of bulkUpdates) {
        // Validate blueprint belongs to this plan
        const blueprint = db.prepare(`
          SELECT plan_id FROM plan_blueprints WHERE plan_blueprint_id = ?
        `).get(planBlueprintId);

        if (!blueprint || blueprint.plan_id !== planId) {
          throw new Error(`Blueprint ${planBlueprintId} not found in plan ${planId}`);
        }

        // Build update query
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
          const dbField = fieldMap[key];
          if (dbField && allowedFields.includes(dbField)) {
            fields.push(`${dbField} = ?`);
            // Stringify facilitySnapshot if it's an object
            if (key === 'facilitySnapshot' && value !== null) {
              values.push(JSON.stringify(value));
            } else {
              values.push(value);
            }
          }
        }

        if (fields.length > 0) {
          values.push(planBlueprintId);
          const query = `UPDATE plan_blueprints SET ${fields.join(', ')} WHERE plan_blueprint_id = ?`;
          db.prepare(query).run(...values);
          console.log(`[Plans] Bulk updated blueprint ${planBlueprintId}`);
        }
      }

      // Commit all updates
      db.exec('COMMIT');
      console.log(`[Plans] Bulk updated ${bulkUpdates.length} blueprint(s) in plan ${planId}`);

      // Update plan's updated_at timestamp
      const now = Date.now();
      db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?').run(now, planId);

      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error bulk updating blueprints:', error);
    throw error;
  }
}

/**
 * Remove a blueprint from a plan
 * @param {string} planBlueprintId - Plan blueprint ID
 * @returns {Promise<boolean>} Success status
 */
async function removeBlueprintFromPlan(planBlueprintId) {
  try {
    const db = getCharacterDatabase();

    // Get the plan ID for this blueprint
    const blueprint = db.prepare('SELECT plan_id, is_intermediate FROM plan_blueprints WHERE plan_blueprint_id = ?').get(planBlueprintId);
    if (!blueprint) {
      return false;
    }

    // If this is a top-level blueprint, delete all intermediates first
    if (blueprint.is_intermediate === 0) {
      deleteOrphanedIntermediates(planBlueprintId);
    }

    // Delete the blueprint
    const result = db.prepare('DELETE FROM plan_blueprints WHERE plan_blueprint_id = ?').run(planBlueprintId);

    if (result.changes > 0) {
      console.log(`Removed blueprint from plan: ${planBlueprintId}`);

      // Trigger material recalculation
      await recalculatePlanMaterials(blueprint.plan_id, false);

      // Update plan's updated_at
      const now = Date.now();
      db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?').run(now, blueprint.plan_id);
    }

    return result.changes > 0;
  } catch (error) {
    console.error('Error removing blueprint from plan:', error);
    return false;
  }
}

/**
 * Get all blueprints in a plan
 * @param {string} planId - Plan ID
 * @returns {Array} Array of blueprints
 */
function getPlanBlueprints(planId) {
  try {
    const db = getCharacterDatabase();

    const blueprints = db.prepare(`
      SELECT * FROM plan_blueprints WHERE plan_id = ? ORDER BY added_at
    `).all(planId);

    return blueprints.map(bp => ({
      planBlueprintId: bp.plan_blueprint_id,
      planId: bp.plan_id,
      parentBlueprintId: bp.parent_blueprint_id,
      blueprintTypeId: bp.blueprint_type_id,
      runs: bp.runs,
      lines: bp.lines,
      meLevel: bp.me_level,
      teLevel: bp.te_level,
      facilityId: bp.facility_id,
      facilitySnapshot: bp.facility_snapshot ? JSON.parse(bp.facility_snapshot) : null,
      useIntermediates: bp.use_intermediates !== undefined && bp.use_intermediates !== null
        ? (typeof bp.use_intermediates === 'number'
            ? (bp.use_intermediates === 1 ? 'raw_materials' : 'components')
            : bp.use_intermediates)
        : 'raw_materials',
      isIntermediate: bp.is_intermediate === 1,
      isBuilt: bp.is_built === 1,
      builtRuns: bp.built_runs || 0,
      intermediateProductTypeId: bp.intermediate_product_type_id,
      addedAt: bp.added_at,
    }));
  } catch (error) {
    console.error('Error getting plan blueprints:', error);
    return [];
  }
}

/**
 * Get intermediate blueprints for a plan blueprint
 * @param {string} planBlueprintId - Parent plan blueprint ID
 * @returns {Array} Array of intermediate blueprints
 */
function getIntermediateBlueprints(planBlueprintId) {
  try {
    const db = getCharacterDatabase();

    const intermediates = db.prepare(`
      SELECT * FROM plan_blueprints
      WHERE parent_blueprint_id = ?
      ORDER BY added_at
    `).all(planBlueprintId);

    return intermediates.map(bp => ({
      planBlueprintId: bp.plan_blueprint_id,
      planId: bp.plan_id,
      parentBlueprintId: bp.parent_blueprint_id,
      blueprintTypeId: bp.blueprint_type_id,
      runs: bp.runs,
      lines: bp.lines,
      meLevel: bp.me_level,
      teLevel: bp.te_level,
      facilityId: bp.facility_id,
      facilitySnapshot: bp.facility_snapshot ? JSON.parse(bp.facility_snapshot) : null,
      useIntermediates: bp.use_intermediates || 'raw_materials',
      isIntermediate: bp.is_intermediate === 1,
      isBuilt: bp.is_built === 1,
      builtRuns: bp.built_runs || 0,
      intermediateProductTypeId: bp.intermediate_product_type_id,
      addedAt: bp.added_at,
    }));
  } catch (error) {
    console.error('Error getting intermediate blueprints:', error);
    return [];
  }
}

/**
 * Get all intermediate blueprints for a plan (across all top-level blueprints)
 * @param {string} planId - Plan ID
 * @returns {Array} Array of intermediate blueprints with parent info
 */
function getAllPlanIntermediates(planId) {
  try {
    const db = getCharacterDatabase();

    const intermediates = db.prepare(`
      SELECT
        ib.*,
        pb.blueprint_type_id as parent_blueprint_type_id
      FROM plan_blueprints ib
      LEFT JOIN plan_blueprints pb ON ib.parent_blueprint_id = pb.plan_blueprint_id
      WHERE ib.plan_id = ? AND ib.is_intermediate = 1
      ORDER BY ib.added_at
    `).all(planId);

    // Open SDE database to get products-per-run for each intermediate
    const sdePath = getSdePath();
    const sdeDb = new Database(sdePath, { readonly: true });

    try {
      return intermediates.map(bp => {
        // Get products-per-run from SDE
        const product = getBlueprintProduct(bp.blueprint_type_id, sdeDb);
        const productQuantityPerRun = product ? product.quantity : 1;

        return {
          planBlueprintId: bp.plan_blueprint_id,
          planId: bp.plan_id,
          parentBlueprintId: bp.parent_blueprint_id,
          parentBlueprintTypeId: bp.parent_blueprint_type_id,
          blueprintTypeId: bp.blueprint_type_id,
          runs: bp.runs,
          lines: bp.lines,
          meLevel: bp.me_level,
          teLevel: bp.te_level,
          facilityId: bp.facility_id,
          facilitySnapshot: bp.facility_snapshot ? JSON.parse(bp.facility_snapshot) : null,
          useIntermediates: bp.use_intermediates || 'raw_materials',
          isIntermediate: bp.is_intermediate === 1,
          isBuilt: bp.is_built === 1,
          builtRuns: bp.built_runs || 0,
          intermediateProductTypeId: bp.intermediate_product_type_id,
          productQuantityPerRun: productQuantityPerRun,  // Products per run from SDE
          addedAt: bp.added_at,
        };
      });
    } finally {
      sdeDb.close();
    }
  } catch (error) {
    console.error('Error getting all plan intermediates:', error);
    return [];
  }
}

/**
 * Update an intermediate blueprint
 * @param {string} intermediateBlueprintId - Intermediate blueprint ID
 * @param {Object} updates - Fields to update (meLevel, teLevel, facilityId, facilitySnapshot)
 * @returns {Promise<boolean>} Success status
 */
async function updateIntermediateBlueprint(intermediateBlueprintId, updates) {
  try {
    const db = getCharacterDatabase();

    // Get the intermediate blueprint to find plan ID
    const intermediate = db.prepare('SELECT plan_id FROM plan_blueprints WHERE plan_blueprint_id = ?').get(intermediateBlueprintId);
    if (!intermediate) {
      return false;
    }

    const allowedFields = ['me_level', 'te_level', 'facility_id', 'facility_snapshot', 'use_intermediates'];
    const fields = [];
    const values = [];

    const fieldMap = {
      meLevel: 'me_level',
      teLevel: 'te_level',
      facilityId: 'facility_id',
      facilitySnapshot: 'facility_snapshot',
      useIntermediates: 'use_intermediates'
    };

    for (const [key, value] of Object.entries(updates)) {
      const dbField = fieldMap[key];
      if (dbField && allowedFields.includes(dbField)) {
        fields.push(`${dbField} = ?`);
        if (key === 'facilitySnapshot' && value !== null) {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
      }
    }

    if (fields.length === 0) {
      return false;
    }

    values.push(intermediateBlueprintId);

    const query = `UPDATE plan_blueprints SET ${fields.join(', ')} WHERE plan_blueprint_id = ?`;
    const result = db.prepare(query).run(...values);

    if (result.changes > 0) {
      console.log(`Updated intermediate blueprint: ${intermediateBlueprintId}`);

      // Trigger material recalculation
      await recalculatePlanMaterials(intermediate.plan_id, false);

      // Update plan's updated_at
      const now = Date.now();
      db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?').run(now, intermediate.plan_id);
    }

    return result.changes > 0;
  } catch (error) {
    console.error('Error updating intermediate blueprint:', error);
    return false;
  }
}

/**
 * Mark an intermediate blueprint as built or unbuilt (internal recursive function)
 * @param {string} intermediateBlueprintId - Intermediate blueprint ID
 * @param {boolean} isBuilt - Built status
 * @param {Database} db - Database instance
 * @param {boolean} isTopLevel - Whether this is the top-level call
 * @returns {Promise<string>} Plan ID
 */
async function markIntermediateBuiltRecursive(intermediateBlueprintId, isBuilt, db, isTopLevel = false) {
  // Get the intermediate blueprint
  const intermediate = db.prepare('SELECT * FROM plan_blueprints WHERE plan_blueprint_id = ?').get(intermediateBlueprintId);
  if (!intermediate || intermediate.is_intermediate !== 1) {
    throw new Error('Intermediate blueprint not found');
  }

  // Update built status for this intermediate
  db.prepare('UPDATE plan_blueprints SET is_built = ? WHERE plan_blueprint_id = ?').run(isBuilt ? 1 : 0, intermediateBlueprintId);

  console.log(`${isTopLevel ? '' : '  '}Marked intermediate blueprint ${intermediateBlueprintId} as ${isBuilt ? 'built' : 'unbuilt'}`);

  // Recursively mark all child intermediates (sub-intermediates) with the same status
  const childIntermediates = db.prepare(`
    SELECT plan_blueprint_id FROM plan_blueprints
    WHERE parent_blueprint_id = ? AND is_intermediate = 1
  `).all(intermediateBlueprintId);

  if (childIntermediates.length > 0) {
    console.log(`  Cascading built status to ${childIntermediates.length} child intermediate(s)`);
    for (const child of childIntermediates) {
      // Recursively mark children (this will cascade down all levels)
      await markIntermediateBuiltRecursive(child.plan_blueprint_id, isBuilt, db, false);
    }
  }

  return intermediate.plan_id;
}

/**
 * Clear all 'manufactured' acquisition data for a plan
 * Preserves acquisitions from other sources (manual, purchased, etc.)
 * @param {string} planId - Plan ID
 * @returns {number} Number of ledger entries cleared
 */
function clearManufacturedAcquisitions(planId) {
  const db = getCharacterDatabase();

  const count = db.prepare(`
    SELECT COUNT(*) as count FROM plan_material_ledger
    WHERE plan_id = ? AND method = 'manufactured'
  `).get(planId).count;

  if (count === 0) {
    console.log(`[Plans] No 'manufactured' ledger entries to clear for plan ${planId}`);
    return 0;
  }

  console.log(`[Plans] Clearing ${count} 'manufactured' ledger entry(ies) for plan ${planId}`);

  db.prepare(`
    DELETE FROM plan_material_ledger
    WHERE plan_id = ? AND method = 'manufactured'
  `).run(planId);

  return count;
}

/**
 * Recalculate manufactured material acquisitions from all built intermediates and reactions.
 *
 * For each built intermediate/reaction, re-runs the exact same blueprint/reaction expansion
 * that recalculatePlanMaterials uses, but substituting built_runs for the total planned runs.
 * This gives the precise raw material quantities actually consumed by those built jobs.
 *
 * Results are accumulated across all built intermediates/reactions, then capped at each
 * material's total plan quantity_needed, and written as 'manufactured' ledger entries.
 *
 * @param {string} planId - Plan ID
 */
async function recalculateManufacturedMaterials(planId) {
  const db = getCharacterDatabase();

  const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
  if (!plan) return;

  // Get built intermediates that are direct children of top-level blueprints only.
  // Sub-intermediates (children of other intermediates) are expanded recursively inside
  // expandIntermediate, so processing them here separately would double-count their materials.
  const builtIntermediates = db.prepare(`
    SELECT pb.plan_blueprint_id, pb.blueprint_type_id, pb.runs, pb.built_runs,
           pb.me_level, pb.te_level, pb.facility_snapshot, pb.use_intermediates,
           pb.parent_blueprint_id
    FROM plan_blueprints pb
    WHERE pb.plan_id = ? AND pb.is_intermediate = 1 AND pb.blueprint_type != 'reaction'
      AND pb.built_runs > 0
      AND pb.parent_blueprint_id IN (
        SELECT plan_blueprint_id FROM plan_blueprints
        WHERE plan_id = ? AND is_intermediate = 0
      )
    ORDER BY pb.plan_blueprint_id
  `).all(planId, planId);

  // Get all built reactions (built_runs > 0)
  const builtReactions = db.prepare(`
    SELECT pb.plan_blueprint_id, pb.reaction_type_id, pb.runs, pb.built_runs,
           pb.facility_snapshot, pb.use_intermediates
    FROM plan_blueprints pb
    WHERE pb.plan_id = ? AND pb.blueprint_type = 'reaction' AND pb.built_runs > 0
    ORDER BY pb.plan_blueprint_id
  `).all(planId);

  if (builtIntermediates.length === 0 && builtReactions.length === 0) {
    console.log(`[Plans] No built intermediates or reactions for plan ${planId}`);
    return;
  }

  console.log(`[Plans] Recalculating manufactured materials for ${builtIntermediates.length} built intermediate(s) and ${builtReactions.length} built reaction(s)`);

  // Get the plan's total quantity_needed per leaf material type for capping
  const planMaterialNodes = db.prepare(`
    SELECT type_id, SUM(quantity_needed) as total_quantity
    FROM plan_material_nodes
    WHERE plan_id = ? AND node_type = 'material'
    GROUP BY type_id
  `).all(planId);
  const planMaterialTotals = new Map(planMaterialNodes.map(n => [n.type_id, n.total_quantity]));

  // Accumulate exact raw material quantities consumed by all built intermediates/reactions
  const manufacturedMaterials = new Map(); // typeId -> total manufactured quantity

  function accumulateMaterials(materials) {
    for (const [typeId, qty] of Object.entries(materials)) {
      const tid = parseInt(typeId);
      manufacturedMaterials.set(tid, (manufacturedMaterials.get(tid) || 0) + qty);
    }
  }

  // Process each built intermediate: expand exactly built_runs to get consumed materials
  for (const intermediate of builtIntermediates) {
    if (intermediate.built_runs <= 0) continue;

    let facility = null;
    try {
      facility = intermediate.facility_snapshot ? JSON.parse(intermediate.facility_snapshot) : null;
    } catch (e) {
      console.warn(`[Plans] Could not parse facility snapshot for intermediate ${intermediate.plan_blueprint_id}`);
    }

    const config = {
      meLevel: intermediate.me_level ?? 0,
      teLevel: intermediate.te_level ?? 0,
      facilitySnapshot: facility,
      useIntermediates: intermediate.use_intermediates ?? 'raw_materials'
    };

    console.log(`  - Intermediate ${intermediate.blueprint_type_id}: expanding ${intermediate.built_runs} built run(s)`);

    try {
      // Calculate the product quantity this blueprint yields per run, so we can
      // pass the correct unitsNeeded to expandIntermediate (which converts back to runs).
      // We pass built_runs * productsPerRun as unitsNeeded so the expansion uses
      // exactly built_runs runs without rounding up.
      const bpProduct = getBlueprintProduct(intermediate.blueprint_type_id);
      const productsPerRun = bpProduct ? bpProduct.quantity : 1;
      const unitsProduced = intermediate.built_runs * productsPerRun;

      const expansion = await expandIntermediate(
        intermediate.blueprint_type_id,
        unitsProduced,
        config,
        facility,
        plan.character_id,
        planId,
        intermediate.plan_blueprint_id,  // own ID so sub-intermediate lookups use correct parent
        1
      );

      accumulateMaterials(expansion.materials);
    } catch (err) {
      console.error(`[Plans] Error expanding intermediate ${intermediate.blueprint_type_id}:`, err);
    }
  }

  // Process each built reaction: expand exactly built_runs to get consumed materials
  for (const reaction of builtReactions) {
    if (reaction.built_runs <= 0) continue;

    let facility = null;
    try {
      facility = reaction.facility_snapshot ? JSON.parse(reaction.facility_snapshot) : null;
    } catch (e) {
      console.warn(`[Plans] Could not parse facility snapshot for reaction ${reaction.plan_blueprint_id}`);
    }

    const config = {
      facilitySnapshot: facility,
      useIntermediates: reaction.use_intermediates ?? 'raw_materials'
    };

    console.log(`  - Reaction ${reaction.reaction_type_id}: expanding ${reaction.built_runs} built run(s)`);

    try {
      const expansion = await expandReaction(
        reaction.reaction_type_id,
        reaction.built_runs,
        config,
        facility,
        plan.character_id,
        planId,
        reaction.plan_blueprint_id,
        0
      );

      accumulateMaterials(expansion.materials);
    } catch (err) {
      console.error(`[Plans] Error expanding reaction ${reaction.reaction_type_id}:`, err);
    }
  }

  // Expand any reaction products that were passed through by expandIntermediate.
  // expandIntermediate leaves reaction product type IDs in its returned materials (as quantities
  // of the reaction product, not the reaction inputs). We need to replace each such entry
  // with the reaction's actual raw input materials.
  //
  // Get the plan's reaction settings to know which facility to use.
  const planReactions = db.prepare(`
    SELECT reaction_type_id, facility_snapshot, use_intermediates
    FROM plan_blueprints
    WHERE plan_id = ? AND blueprint_type = 'reaction'
  `).all(planId);
  const reactionFacilityMap = new Map();
  for (const r of planReactions) {
    let facility = null;
    try { facility = r.facility_snapshot ? JSON.parse(r.facility_snapshot) : null; } catch (e) { /* ignore */ }
    reactionFacilityMap.set(r.reaction_type_id, { facility, useIntermediates: r.use_intermediates });
  }

  // Iteratively expand reaction products until none remain (handles nested reactions)
  let expansionPasses = 0;
  const maxPasses = 10;
  let foundReaction = true;

  while (foundReaction && expansionPasses < maxPasses) {
    expansionPasses++;
    foundReaction = false;

    // Snapshot current keys to iterate (we'll modify the map during iteration)
    const currentEntries = [...manufacturedMaterials.entries()];

    for (const [typeId, qty] of currentEntries) {
      if (qty <= 0) continue;

      const reactionTypeId = await getReactionForProduct(typeId);
      if (!reactionTypeId) continue;

      foundReaction = true;

      // Find this reaction's configured facility from plan_blueprints
      const reactionEntry = reactionFacilityMap.get(reactionTypeId);
      const facility = reactionEntry?.facility ?? null;
      const useIntermediates = reactionEntry?.useIntermediates ?? 'raw_materials';

      // Determine runs needed: qty units ÷ product quantity per run
      const runsNeeded = await calculateReactionRuns(qty, reactionTypeId);

      console.log(`  - Expanding reaction product ${typeId} (reactionTypeId=${reactionTypeId}): ${qty} units = ${runsNeeded} run(s)`);

      try {
        const expansion = await expandReaction(
          reactionTypeId,
          runsNeeded,
          { facilitySnapshot: facility, useIntermediates },
          facility,
          plan.character_id,
          planId,
          null,
          0
        );

        // Replace the reaction product entry with the reaction's raw inputs
        manufacturedMaterials.delete(typeId);
        accumulateMaterials(expansion.materials);
      } catch (err) {
        console.error(`[Plans] Error expanding reaction product ${typeId}:`, err);
        // Leave as-is — it will be filtered out below if not in planMaterialTotals
      }
    }
  }

  // Cap each material at the plan's total quantity_needed and write ledger entries
  const now = Date.now();
  const insertLedger = db.prepare(`
    INSERT INTO plan_material_ledger
      (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
    VALUES (?, ?, ?, 'acquired', ?, 'manufactured', NULL, 'Auto-acquired from built components', NULL, ?)
  `);

  console.log(`[Plans] Writing manufactured ledger entries for ${manufacturedMaterials.size} material type(s)`);

  for (const [typeId, qty] of manufacturedMaterials) {
    if (qty <= 0) continue;
    const planTotal = planMaterialTotals.get(typeId);
    // Only record if this material is actually in the plan's leaf nodes
    if (!planTotal) continue;
    const cappedQty = Math.min(qty, planTotal);
    insertLedger.run(randomUUID(), planId, typeId, cappedQty, now);
    console.log(`    - Material ${typeId}: ${cappedQty} manufactured (raw calc: ${qty}, plan total: ${planTotal})`);
  }
}

async function markIntermediateBuilt(intermediateBlueprintId, builtRuns) {
  try {
    const db = getCharacterDatabase();

    // Get intermediate details (total runs, plan_id, character_id)
    const intermediate = db.prepare(`
      SELECT pb.*, mp.character_id
      FROM plan_blueprints pb
      JOIN manufacturing_plans mp ON pb.plan_id = mp.plan_id
      WHERE pb.plan_blueprint_id = ?
    `).get(intermediateBlueprintId);

    if (!intermediate) {
      throw new Error('Intermediate blueprint not found');
    }

    // Validate builtRuns (0 <= builtRuns <= runs)
    if (builtRuns < 0 || builtRuns > intermediate.runs) {
      throw new Error(`Invalid built runs: ${builtRuns}. Must be between 0 and ${intermediate.runs}`);
    }

    // Store previous for logging
    const previousBuiltRuns = intermediate.built_runs || 0;

    console.log(`[Plans] Updating intermediate ${intermediateBlueprintId} built_runs: ${previousBuiltRuns} → ${builtRuns}`);

    // Update built_runs in database
    db.prepare(`
      UPDATE plan_blueprints
      SET built_runs = ?,
          is_built = CASE WHEN ? >= runs THEN 1 ELSE 0 END
      WHERE plan_blueprint_id = ?
    `).run(builtRuns, builtRuns, intermediateBlueprintId);

    // Refresh manufactured ledger entries from all currently-built intermediates/reactions.
    // Plan material nodes do not change when built status changes, so a full
    // recalculatePlanMaterials is not needed — only the ledger needs updating.
    clearManufacturedAcquisitions(intermediate.plan_id);
    await recalculateManufacturedMaterials(intermediate.plan_id);

    // Update plan's updated_at timestamp
    const now = Date.now();
    db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?')
      .run(now, intermediate.plan_id);

    console.log(`[Plans] Successfully updated built quantity for intermediate ${intermediateBlueprintId}`);

    return {
      success: true,
      warnings: []
    };
  } catch (error) {
    console.error('[Plans] Error marking intermediate built:', error);
    throw error;
  }
}

/**
 * Delete orphaned intermediate blueprints (when parent is removed)
 * @param {string} parentBlueprintId - Parent blueprint ID
 * @returns {number} Number of intermediates deleted
 */
function deleteOrphanedIntermediates(parentBlueprintId) {
  try {
    const db = getCharacterDatabase();

    const result = db.prepare('DELETE FROM plan_blueprints WHERE parent_blueprint_id = ?').run(parentBlueprintId);

    if (result.changes > 0) {
      console.log(`Deleted ${result.changes} orphaned intermediate blueprint(s) for parent ${parentBlueprintId}`);
    }

    return result.changes;
  } catch (error) {
    console.error('Error deleting orphaned intermediates:', error);
    return 0;
  }
}

/**
 * Flatten nested intermediate components with depth tracking
 * @param {Array} intermediateComponents - Array of intermediate components
 * @param {number} currentDepth - Starting depth level (default 1)
 * @returns {Map} Map of typeId -> {quantity, depth}
 */
function flattenIntermediates(intermediateComponents, currentDepth = 1) {
  const flattened = new Map(); // Map<typeId, {quantity, depth}>

  function collect(components, depth) {
    for (const component of components) {
      const typeId = component.typeID;
      const existing = flattened.get(typeId);

      // Track the MINIMUM depth (closest to final product)
      if (!existing || depth < existing.depth) {
        flattened.set(typeId, {
          quantity: (existing?.quantity || 0) + component.quantity,
          depth: depth
        });
      } else {
        existing.quantity += component.quantity;
      }

      // Recursively collect nested intermediates
      if (component.nestedIntermediates?.length > 0) {
        collect(component.nestedIntermediates, depth + 1);
      }
    }
  }

  collect(intermediateComponents, currentDepth);
  return flattened;
}

/**
 * Recursively expand an intermediate blueprint into its materials
 * @param {number} intermediateBlueprintTypeId - Blueprint type ID of the intermediate
 * @param {number} unitsNeeded - Total units of product needed (will be converted to runs)
 * @param {object} intermediateConfig - Config from plan_blueprints (if exists)
 * @param {object} parentFacility - Parent blueprint's facility (fallback)
 * @param {string} characterId - Character ID for owned blueprint lookup
 * @param {string} planId - Plan ID for looking up nested intermediate configs
 * @param {string} parentBlueprintId - Parent blueprint ID for looking up child intermediates
 * @param {number} depth - Current recursion depth (prevent infinite loops)
 * @returns {object} { materials: {typeId: quantity}, intermediateProducts: [{typeId, quantity, depth}] }
 */
async function expandIntermediate(
  intermediateBlueprintTypeId,
  unitsNeeded,
  intermediateConfig,
  parentFacility,
  characterId,
  planId,
  parentBlueprintId,
  depth = 1
) {
  // Check depth limit using helper
  if (isMaxDepthExceeded(depth, 10, `expandIntermediate for ${intermediateBlueprintTypeId}`)) {
    return { materials: {}, intermediateProducts: [] };
  }

  // Determine configuration for this intermediate
  let meLevel = intermediateConfig?.meLevel ?? 0;
  let teLevel = intermediateConfig?.teLevel ?? 0;
  let facility = intermediateConfig?.facilitySnapshot ?? parentFacility;
  let useIntermediates = intermediateConfig?.useIntermediates ?? 'raw_materials';

  // Fallback: check owned blueprints for ME if not in config
  if (!intermediateConfig && characterId) {
    const ownedME = getOwnedBlueprintME(characterId, intermediateBlueprintTypeId);
    if (ownedME !== null) {
      meLevel = ownedME;
    }
  }

  // Convert units needed to runs needed
  const runsNeeded = calculateIntermediateRuns(unitsNeeded, intermediateBlueprintTypeId);

  // Convert use_intermediates to boolean for calculateBlueprintMaterials
  const shouldExpandSubIntermediates = (useIntermediates === 'raw_materials' || useIntermediates === 'build_buy');

  // Calculate this intermediate's materials with useIntermediates=false
  // (we'll manually expand sub-intermediates if needed)
  const calculation = await calculateBlueprintMaterials(
    intermediateBlueprintTypeId,
    runsNeeded,
    meLevel,
    characterId,
    facility,
    false  // Always false - we manually expand below
  );

  const aggregatedMaterials = { ...calculation.materials };
  const intermediateProducts = [];

  // Track this intermediate as a product (for plan_products)
  // The actual quantity produced = runs * baseQuantity (may be more than unitsNeeded due to rounding)
  const product = calculation.product;
  if (product) {
    const baseQty = product.baseQuantity || 1;
    const totalProductQty = baseQty * runsNeeded;
    intermediateProducts.push({
      typeId: product.typeID,
      quantity: totalProductQty,
      depth: depth
    });
  }

  // If this intermediate is set to 'buy', treat its product as a purchasable material
  // Don't expand sub-components - just return the product as a material
  if (useIntermediates === 'buy') {
    // The intermediate's product should become a material (we're buying it, not building it)
    if (product && product.typeID) {
      const baseQty = product.baseQuantity || 1;
      // runsNeeded already represents the total quantity needed (includes baseQuantity from parent calculation)
      const totalProductQty = runsNeeded;

      console.log(`[Plans] Intermediate ${intermediateBlueprintTypeId} set to 'buy' - adding ${totalProductQty} of product ${product.typeID} to materials`);

      // Return the product as the only material (clear out all sub-components)
      return {
        materials: {
          [product.typeID]: totalProductQty
        },
        intermediateProducts: intermediateProducts  // Still track as intermediate product
      };
    } else {
      // No product found, return empty (shouldn't happen normally)
      console.warn(`[Plans] Intermediate ${intermediateBlueprintTypeId} set to 'buy' but has no product`);
      return {
        materials: {},
        intermediateProducts: []
      };
    }
  }

  // If this intermediate should expand to raw materials, manually expand sub-intermediates
  if (shouldExpandSubIntermediates) {
    // Classify materials using helper function
    const { intermediates, reactions, rawMaterials } = await classifyMaterials(calculation.materials);

    // Pass reaction products through as-is — they remain in aggregatedMaterials so that
    // Phase 2.5 (in recalculatePlanMaterials) or the caller (in recalculateManufacturedMaterials)
    // can expand them. Nothing to delete: they're already in aggregatedMaterials from the spread above.

    // Process each sub-intermediate
    for (const intermediate of intermediates) {
      const subBlueprintId = intermediate.blueprintTypeId;
      const materialTypeId = intermediate.typeId;
      const materialQuantity = intermediate.quantity;

      // Look up config in plan_blueprints for this sub-intermediate.
      // parentBlueprintId here is the plan_blueprint_id of the current intermediate
      // (the one whose materials we just calculated), not its parent.
      const db = getCharacterDatabase();
      const subConfig = db.prepare(`
        SELECT plan_blueprint_id, me_level, te_level, facility_snapshot, use_intermediates, runs
        FROM plan_blueprints
        WHERE plan_id = ? AND blueprint_type_id = ? AND parent_blueprint_id = ? AND is_intermediate = 1
        LIMIT 1
      `).get(planId, subBlueprintId, parentBlueprintId);

      // Recursively expand — pass materialQuantity (units needed) directly;
      // expandIntermediate converts to runs internally via calculateIntermediateRuns.
      const subExpansion = await expandIntermediate(
        subBlueprintId,
        materialQuantity,
        subConfig ? {
          meLevel: subConfig.me_level,
          teLevel: subConfig.te_level,
          facilitySnapshot: JSON.parse(subConfig.facility_snapshot),
          useIntermediates: subConfig.use_intermediates
        } : null,
        facility,
        characterId,
        planId,
        subConfig ? subConfig.plan_blueprint_id : null,
        depth + 1
      );

      // Remove this material from our list (it's been expanded)
      delete aggregatedMaterials[materialTypeId];

      // Add the sub-intermediate's materials to ours
      for (const [subMatTypeId, subMatQty] of Object.entries(subExpansion.materials)) {
        aggregatedMaterials[subMatTypeId] = (aggregatedMaterials[subMatTypeId] || 0) + subMatQty;
      }

      // Collect sub-intermediate products
      intermediateProducts.push(...subExpansion.intermediateProducts);
    }
  }

  return {
    materials: aggregatedMaterials,
    intermediateProducts: intermediateProducts
  };
}

/**
 * Expand a reaction to its base materials, recursively expanding nested reactions
 * Similar to expandIntermediate but for reactions (activityID=11)
 * @param {number} reactionTypeId - Reaction formula type ID
 * @param {number} runsNeeded - Number of runs needed
 * @param {object} reactionConfig - Configuration (facilitySnapshot, useIntermediates)
 * @param {object} parentFacility - Parent facility as fallback
 * @param {number} characterId - Character ID
 * @param {string} planId - Plan ID
 * @param {string} parentBlueprintId - Parent blueprint ID (for looking up nested reactions)
 * @param {number} depth - Recursion depth (default 1)
 * @returns {Promise<object>} { materials: {typeId: quantity}, intermediateProducts: [{typeId, quantity, depth}] }
 */
async function expandReaction(
  reactionTypeId,
  runsNeeded,
  reactionConfig,
  parentFacility,
  characterId,
  planId,
  parentBlueprintId,
  depth = 1
) {
  // Check depth limit using helper
  if (isMaxDepthExceeded(depth, 10, `expandReaction for ${reactionTypeId}`)) {
    return { materials: {}, intermediateProducts: [] };
  }

  // Determine configuration for this reaction
  let facility = reactionConfig?.facilitySnapshot ?? parentFacility;
  let useIntermediates = reactionConfig?.useIntermediates ?? 'raw_materials';

  // Convert use_intermediates to boolean
  const shouldExpandSubReactions = (useIntermediates === 'raw_materials' || useIntermediates === 'build_buy');

  // Calculate this reaction's materials
  const calculation = await calculateReactionMaterials(
    reactionTypeId,
    runsNeeded,
    characterId,
    facility
  );

  const aggregatedMaterials = { ...calculation.materials };
  const intermediateProducts = [];

  // Track this reaction's product (for plan_products)
  const product = calculation.product;
  if (product) {
    const baseQty = product.baseQuantity || product.quantity || 1;
    const totalProductQty = baseQty * runsNeeded;
    intermediateProducts.push({
      typeId: product.typeID,
      quantity: totalProductQty,
      depth: depth
    });
  }

  // DON'T expand nested reactions here - they'll be handled in PHASE 2.5
  // Just leave reaction products in the materials list
  // This allows all reactions to be aggregated globally before expansion

  return {
    materials: aggregatedMaterials,
    intermediateProducts: intermediateProducts
  };
}

/**
 * Clean up orphaned intermediate blueprints and reactions from plan_blueprints table
 * An intermediate/reaction is orphaned if:
 * - Its parent no longer exists, OR
 * - Its parent exists but has use_intermediates='components' or 'buy'
 *   (these modes don't expand intermediates, so child intermediates become orphaned)
 *
 * @param {string} planId - Plan ID
 */
async function cleanupOrphanedIntermediates(planId) {
  const db = getCharacterDatabase();

  // Get all intermediate blueprints and reactions in this plan
  const intermediates = db.prepare(`
    SELECT plan_blueprint_id, parent_blueprint_id, blueprint_type
    FROM plan_blueprints
    WHERE plan_id = ? AND is_intermediate = 1
  `).all(planId);

  if (intermediates.length === 0) {
    return; // No intermediates to clean
  }

  // Get all valid parent blueprints with their use_intermediates setting
  const allBlueprints = db.prepare(`
    SELECT plan_blueprint_id, use_intermediates
    FROM plan_blueprints
    WHERE plan_id = ?
  `).all(planId);

  const blueprintMap = new Map(
    allBlueprints.map(bp => [bp.plan_blueprint_id, bp.use_intermediates])
  );

  // Delete intermediates whose parent is missing or set to 'components'
  const deleteStmt = db.prepare(`
    DELETE FROM plan_blueprints
    WHERE plan_blueprint_id = ?
  `);

  let deletedCount = 0;
  for (const intermediate of intermediates) {
    // Skip aggregated reactions (parent_blueprint_id = NULL)
    // These are created in PHASE 2.5 and are intentionally not tied to a specific parent
    if (intermediate.parent_blueprint_id === null && intermediate.blueprint_type === 'reaction') {
      continue;
    }

    const parentUseIntermediates = blueprintMap.get(intermediate.parent_blueprint_id);

    // Orphaned if parent doesn't exist OR parent uses 'components' or 'buy' mode
    // (these modes don't expand intermediates, so child intermediates are orphaned)
    if (!parentUseIntermediates || parentUseIntermediates === 'components' || parentUseIntermediates === 'buy') {
      deleteStmt.run(intermediate.plan_blueprint_id);
      deletedCount++;
      let reason = !parentUseIntermediates ? 'missing parent' : `parent uses ${parentUseIntermediates} mode`;
      console.log(`[Plans] Deleted orphaned intermediate (${reason}): ${intermediate.plan_blueprint_id}`);
    }
  }

  if (deletedCount > 0) {
    console.log(`[Plans] Cleaned up ${deletedCount} orphaned intermediate(s) from plan ${planId}`);
  }
}

/**
 * Recalculate and persist all materials and products for a manufacturing plan
 *
 * This function performs two phases:
 * 1. STRUCTURE SYNC: Ensures intermediate blueprint structure is up-to-date for all top-level blueprints
 * 2. MATERIAL CALCULATION: Computes aggregated materials and applies pricing
 *
 * The structure sync phase calls detectAndCreateIntermediates() for each top-level blueprint
 * that uses intermediates (raw_materials or build_buy mode). This ensures that:
 * - Missing intermediates are created
 * - Existing intermediates have correct runs based on current material requirements
 * - User customizations (ME, TE, facility) are preserved
 * - The plan is self-healing in case of database inconsistencies
 *
 * Call this when:
 * - After any blueprint changes (add, update, remove)
 * - After marking intermediate as built/unbuilt
 * - When refreshing market prices
 * - Anytime intermediate structure or materials might be out of sync
 *
 * @param {string} planId - Plan ID
 * @param {boolean} refreshPrices - Whether to refresh prices from market (default false)
 * @returns {Promise<boolean>} Success status
 */
async function recalculatePlanMaterials(planId, refreshPrices = false) {
  try {
    const db = getCharacterDatabase();

    // Get plan to find character ID
    const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    // Get all blueprints in this plan
    const blueprints = getPlanBlueprints(planId);

    if (blueprints.length === 0) {
      // No blueprints, clear material nodes
      db.prepare('DELETE FROM plan_material_nodes WHERE plan_id = ?').run(planId);
      console.log(`Cleared materials for empty plan: ${planId}`);
      return true;
    }

    // Aggregate materials and products across all blueprints (used for pricing + reaction detection)
    const aggregatedMaterials = {};
    const aggregatedProducts = {};
    const aggregatedIntermediateProducts = []; // Array of {typeId, quantity, depth}
    const blueprintCalculations = new Map(); // Store calculations to identify final products later

    // Node collection: built in parallel to aggregation, with parent linkage for tree view.
    // Each entry is a node descriptor object with full tree linkage (nodeId, parentNodeId, etc.).
    const collectedNodes = []; // Array of node descriptor objects

    // NOTE: Built intermediate exclusion logic has been removed.
    // Instead, materials for built intermediates are marked as acquired
    // via the acquisition tracking system (see markIntermediateMaterialsAsAcquired)

    // Get market settings for pricing
    const marketSettings = getMarketSettings();

    // Filter out intermediate blueprints - only process top-level blueprints
    // Intermediate blueprints are auto-created entries that should not be processed separately
    // Their products are already captured via intermediateComponents from parent blueprints
    const topLevelBlueprints = blueprints.filter(bp => !bp.isIntermediate);

    // -------------------------------------------------------------------------
    // LOCAL TREE-BUILDING HELPERS
    // These walk the intermediate/reaction hierarchy and push nodes into
    // collectedNodes with proper parentNodeId linkage.
    // -------------------------------------------------------------------------

    /**
     * Recursively walk an intermediate blueprint and push tree nodes.
     * @param {number} intermediateBlueprintTypeId
     * @param {number} unitsNeeded
     * @param {object|null} intermediateConfig  - { meLevel, facilitySnapshot, useIntermediates }
     * @param {object|null} parentFacility       - fallback facility
     * @param {string}      rootBlueprintId      - planBlueprintId of the top-level blueprint
     * @param {string|null} sourcePlanBlueprintId- plan_blueprint_id of the row in plan_blueprints that owns this node
     * @param {string|null} parentNodeId         - nodeId of parent node
     * @param {number}      depth
     * @returns {Promise<string>} nodeId of the intermediate node that was created
     */
    async function walkIntermediateNodes(
      intermediateBlueprintTypeId,
      unitsNeeded,
      intermediateConfig,
      parentFacility,
      rootBlueprintId,
      sourcePlanBlueprintId,
      parentNodeId,
      depth
    ) {
      if (isMaxDepthExceeded(depth, 10, `walkIntermediateNodes for ${intermediateBlueprintTypeId}`)) {
        return null;
      }

      const meLevel = intermediateConfig?.meLevel ?? 0;
      const facility = intermediateConfig?.facilitySnapshot ?? parentFacility;
      const useIntermediates = intermediateConfig?.useIntermediates ?? 'raw_materials';

      const runsNeeded = calculateIntermediateRuns(unitsNeeded, intermediateBlueprintTypeId);
      const bpProduct = getBlueprintProduct(intermediateBlueprintTypeId);
      const productsPerRun = bpProduct?.quantity ?? 1;

      const intermediateNodeId = randomUUID();
      collectedNodes.push({
        nodeId: intermediateNodeId,
        planBlueprintId: rootBlueprintId,
        sourcePlanBlueprintId: sourcePlanBlueprintId,
        parentNodeId: parentNodeId,
        typeId: bpProduct?.typeID ?? intermediateBlueprintTypeId,
        nodeType: 'intermediate',
        depth: depth,
        quantityNeeded: runsNeeded * productsPerRun,
        quantityPerRun: productsPerRun,
        runsNeeded: runsNeeded,
        meLevel: meLevel,
        isReaction: 0,
        buildPlan: useIntermediates === 'buy' ? 'buy'
          : useIntermediates === 'components' ? 'components'
          : 'raw_materials',
        price: null,
        priceFrozenAt: null
      });

      // If buy or components mode: don't expand children
      if (useIntermediates === 'buy' || useIntermediates === 'components') {
        return intermediateNodeId;
      }

      // Expand this intermediate to get its direct materials
      const calculation = await calculateBlueprintMaterials(
        intermediateBlueprintTypeId,
        runsNeeded,
        meLevel,
        plan.character_id,
        facility,
        false
      );

      const { intermediates, reactions, rawMaterials } = await classifyMaterials(calculation.materials);

      // Recurse into sub-intermediates
      for (const sub of intermediates) {
        const subConfig = db.prepare(`
          SELECT plan_blueprint_id, me_level, facility_snapshot, use_intermediates
          FROM plan_blueprints
          WHERE plan_id = ? AND blueprint_type_id = ? AND parent_blueprint_id = ? AND is_intermediate = 1
          LIMIT 1
        `).get(planId, sub.blueprintTypeId, sourcePlanBlueprintId);

        await walkIntermediateNodes(
          sub.blueprintTypeId,
          sub.quantity,
          subConfig ? {
            meLevel: subConfig.me_level,
            facilitySnapshot: JSON.parse(subConfig.facility_snapshot),
            useIntermediates: subConfig.use_intermediates
          } : null,
          facility,
          rootBlueprintId,
          subConfig?.plan_blueprint_id ?? null,
          intermediateNodeId,
          depth + 1
        );
      }

      // Reaction children: expand reactions if plan has reactions enabled
      if (planReactionsEnabled) {
        for (const reaction of reactions) {
          const reactionRunsNeeded = await calculateReactionRuns(reaction.quantity, reaction.reactionTypeId);
          const reactionProduct = await getReactionProduct(reaction.reactionTypeId);
          const reactionProductsPerRun = reactionProduct?.quantity ?? 1;
          const reactionNodeId = randomUUID();
          collectedNodes.push({
            nodeId: reactionNodeId,
            planBlueprintId: rootBlueprintId,
            sourcePlanBlueprintId: null, // Phase 2.5 fills this in
            parentNodeId: intermediateNodeId,
            typeId: reaction.typeId,
            nodeType: 'intermediate',
            depth: depth + 1,
            quantityNeeded: reactionRunsNeeded * reactionProductsPerRun,
            quantityPerRun: reactionProductsPerRun,
            runsNeeded: reactionRunsNeeded,
            meLevel: null,
            isReaction: 1,
            buildPlan: 'raw_materials',
            price: null,
            priceFrozenAt: null,
            _reactionTypeId: reaction.reactionTypeId  // keep for Phase 2.5 sourcePlanBlueprintId wiring
          });
          // Do NOT call walkReactionNodes here — the reaction's own facility (Athanor/Tatara)
          // is only known in Phase 2.5 after aggregation. Phase 2.5 will walk child nodes once
          // with the correct facility. Walking here would use the wrong parent facility AND
          // create duplicate leaf nodes when Phase 2.5 also walks.
        }
      } else {
        // Reactions disabled: add reaction products as raw material leaf nodes
        for (const reaction of reactions) {
          collectedNodes.push({
            nodeId: randomUUID(),
            planBlueprintId: rootBlueprintId,
            sourcePlanBlueprintId: null,
            parentNodeId: intermediateNodeId,
            typeId: reaction.typeId,
            nodeType: 'material',
            depth: depth + 1,
            quantityNeeded: reaction.quantity,
            quantityPerRun: null,
            runsNeeded: null,
            meLevel: null,
            isReaction: 0,
            buildPlan: 'raw_materials',
            price: null,
            priceFrozenAt: null
          });
        }
      }

      // Raw material leaf nodes
      for (const raw of rawMaterials) {
        collectedNodes.push({
          nodeId: randomUUID(),
          planBlueprintId: rootBlueprintId,
          sourcePlanBlueprintId: null,
          parentNodeId: intermediateNodeId,
          typeId: raw.typeId,
          nodeType: 'material',
          depth: depth + 1,
          quantityNeeded: raw.quantity,
          quantityPerRun: null,
          runsNeeded: null,
          meLevel: null,
          isReaction: 0,
          buildPlan: 'raw_materials',
          price: null,
          priceFrozenAt: null
        });
      }

      return intermediateNodeId;
    }

    /**
     * Recursively walk a reaction and push tree nodes for its inputs.
     * @param {number} reactionTypeId
     * @param {number} runsNeeded
     * @param {object|null} facility
     * @param {string}      rootBlueprintId
     * @param {string|null} reactionPlanBlueprintId - plan_blueprint_id of the reaction row
     * @param {string|null} reactionParentNodeId    - nodeId of the reaction's intermediate node
     * @param {number}      depth
     */
    async function walkReactionNodes(
      reactionTypeId,
      runsNeeded,
      facility,
      rootBlueprintId,
      reactionPlanBlueprintId,
      reactionParentNodeId,
      depth
    ) {
      if (isMaxDepthExceeded(depth, 10, `walkReactionNodes for ${reactionTypeId}`)) {
        return;
      }

      // Use raw SDE inputs (not calculateReactionMaterials which auto-expands sub-reactions)
      // so we can build the full intermediate hierarchy in the tree.
      const reactionProduct = await getReactionProduct(reactionTypeId);
      const directInputs = await getReactionMaterials(reactionTypeId);

      for (const input of directInputs) {
        const adjustedQty = calculateReactionMaterialQuantity(
          input.quantity,
          runsNeeded,
          facility,
          reactionProduct?.typeID ?? null
        );

        const subReactionTypeId = await getReactionForProduct(input.typeID);

        if (subReactionTypeId) {
          // This input is itself a reaction product — create intermediate node and recurse
          const subRunsNeeded = await calculateReactionRuns(adjustedQty, subReactionTypeId);
          const subReactionProductInfo = await getReactionProduct(subReactionTypeId);
          const subProductsPerRun = subReactionProductInfo?.quantity ?? 1;
          const subNodeId = randomUUID();
          collectedNodes.push({
            nodeId: subNodeId,
            planBlueprintId: rootBlueprintId,
            sourcePlanBlueprintId: null,
            parentNodeId: reactionParentNodeId,
            typeId: input.typeID,
            nodeType: 'intermediate',
            depth: depth + 1,
            quantityNeeded: subRunsNeeded * subProductsPerRun,
            quantityPerRun: subProductsPerRun,
            runsNeeded: subRunsNeeded,
            meLevel: null,
            isReaction: 1,
            buildPlan: 'raw_materials',
            price: null,
            priceFrozenAt: null
          });
          await walkReactionNodes(
            subReactionTypeId,
            subRunsNeeded,
            facility,
            rootBlueprintId,
            null,
            subNodeId,
            depth + 1
          );
        } else {
          // Raw material leaf
          collectedNodes.push({
            nodeId: randomUUID(),
            planBlueprintId: rootBlueprintId,
            sourcePlanBlueprintId: reactionPlanBlueprintId,
            parentNodeId: reactionParentNodeId,
            typeId: input.typeID,
            nodeType: 'material',
            depth: depth + 1,
            quantityNeeded: adjustedQty,
            quantityPerRun: null,
            runsNeeded: null,
            meLevel: null,
            isReaction: 0,
            buildPlan: 'raw_materials',
            price: null,
            priceFrozenAt: null
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // END LOCAL HELPERS
    // -------------------------------------------------------------------------

    // Fetch plan-level reactions setting early so walkIntermediateNodes can use it
    const earlyPlanSettings = getPlanIndustrySettings(planId);
    const planReactionsEnabled = earlyPlanSettings.reactionsAsIntermediates &&
      topLevelBlueprints.some(bp => bp.useIntermediates === 'raw_materials' || bp.useIntermediates === 'build_buy');

    // PHASE 1: Ensure intermediate structure is complete for all top-level blueprints
    // NOTE: Reactions are now detected AFTER aggregation (see PHASE 2.5 below)
    // Intermediates remain per-parent to preserve ME/TE/facility settings
    console.log(`[Plans] Syncing intermediate structure for ${topLevelBlueprints.length} top-level blueprint(s) in plan ${planId}`);
    for (const blueprint of topLevelBlueprints) {
      // Only sync intermediates if blueprint uses raw_materials or build_buy mode
      if (blueprint.useIntermediates === 'raw_materials' || blueprint.useIntermediates === 'build_buy') {
        const createdIntermediateIds = await detectAndCreateIntermediates(
          blueprint.planBlueprintId,
          planId,
          plan.character_id,
          0  // Start at depth 0
        );
        if (createdIntermediateIds.length > 0) {
          console.log(`[Plans] Created/updated ${createdIntermediateIds.length} intermediate(s) for blueprint ${blueprint.planBlueprintId}`);
        }
      }
    }

    // Save existing reaction facility assignments before deleting
    // This preserves user-selected facilities during recalculation
    const existingReactionFacilities = db.prepare(`
      SELECT reaction_type_id, facility_id, facility_snapshot
      FROM plan_blueprints
      WHERE plan_id = ? AND blueprint_type = 'reaction' AND parent_blueprint_id IS NULL
    `).all(planId);

    const reactionFacilityMap = new Map();
    existingReactionFacilities.forEach(r => {
      reactionFacilityMap.set(r.reaction_type_id, {
        facilityId: r.facility_id,
        facilitySnapshot: r.facility_snapshot
      });
    });
    console.log(`[Plans] Saved ${reactionFacilityMap.size} existing reaction facility assignment(s)`);

    // Delete ALL existing reactions (will be recreated in PHASE 2.5)
    // This includes both old per-parent reactions and aggregated reactions
    db.prepare(`
      DELETE FROM plan_blueprints
      WHERE plan_id = ? AND blueprint_type = 'reaction'
    `).run(planId);
    console.log(`[Plans] Cleared all reactions for plan ${planId}`);

    // PHASE 2: Process each top-level blueprint with manual intermediate and reaction expansion
    for (const blueprint of topLevelBlueprints) {
      const facility = blueprint.facilitySnapshot;

      // Calculate runs per line - this is how many runs each production line will do
      // ME floor applies per-line (per job), so we need to calculate materials this way
      const runsPerLine = Math.ceil(blueprint.runs / blueprint.lines);

      // ALWAYS call calculateBlueprintMaterials with useIntermediates=false
      // Calculate materials for runs PER LINE (ME floor applies per job)
      const calculation = await calculateBlueprintMaterials(
        blueprint.blueprintTypeId,
        runsPerLine,  // Runs per line - ME floor applies here
        blueprint.meLevel,
        plan.character_id,
        facility,
        false  // CRITICAL: Always false - we manually expand intermediates below
      );

      // Store calculation for later use (to identify final products)
      blueprintCalculations.set(blueprint.planBlueprintId, calculation);

      // ---- Tree: create the product root node for this blueprint ----
      const bpCalcProduct = calculation.product;
      const productNodeId = randomUUID();
      if (bpCalcProduct) {
        const baseQty = bpCalcProduct.baseQuantity || 1;
        collectedNodes.push({
          nodeId: productNodeId,
          planBlueprintId: blueprint.planBlueprintId,
          sourcePlanBlueprintId: blueprint.planBlueprintId,
          parentNodeId: null,
          typeId: bpCalcProduct.typeID,
          nodeType: 'product',
          depth: 0,
          quantityNeeded: baseQty * blueprint.runs,
          quantityPerRun: baseQty,
          runsNeeded: blueprint.runs,
          meLevel: blueprint.meLevel,
          isReaction: 0,
          buildPlan: blueprint.useIntermediates,
          price: null,
          priceFrozenAt: null
        });
      }
      // ---- End product root node ----

      // Check if we need to expand intermediates and reactions to raw materials
      if (blueprint.useIntermediates === 'raw_materials' || blueprint.useIntermediates === 'build_buy') {
        // Classify materials using helper function
        const { intermediates, reactions, rawMaterials } = await classifyMaterials(calculation.materials);

        // Process intermediates - expand them recursively
        for (const intermediate of intermediates) {
          const intermediateBlueprintId = intermediate.blueprintTypeId;
          const materialTypeId = intermediate.typeId;
          // materialQuantity is per-line, multiply by lines for total needed
          const materialQuantityPerLine = intermediate.quantity;
          const totalMaterialsNeeded = materialQuantityPerLine * blueprint.lines;

          // Look up config in plan_blueprints for this intermediate
          // Filter by parent_blueprint_id to get the correct intermediate instance
          const intermediateConfig = db.prepare(`
            SELECT plan_blueprint_id, me_level, te_level, facility_snapshot, use_intermediates, runs
            FROM plan_blueprints
            WHERE plan_id = ? AND blueprint_type_id = ? AND parent_blueprint_id = ? AND is_intermediate = 1
            LIMIT 1
          `).get(planId, intermediateBlueprintId, blueprint.planBlueprintId);

          // Calculate correct runs based on total material requirements
          const correctRunsNeeded = calculateIntermediateRuns(totalMaterialsNeeded, intermediateBlueprintId);

          // Update intermediate runs if they've changed
          if (intermediateConfig && intermediateConfig.runs !== correctRunsNeeded) {
            db.prepare(`
              UPDATE plan_blueprints
              SET runs = ?
              WHERE plan_blueprint_id = ?
            `).run(correctRunsNeeded, intermediateConfig.plan_blueprint_id);
            console.log(`[Plans] Updated intermediate ${intermediateBlueprintId} runs: ${intermediateConfig.runs} → ${correctRunsNeeded} (parent settings changed)`);
          }

          // Expand this intermediate recursively (aggregation path — unchanged)
          const expansion = await expandIntermediate(
            intermediateBlueprintId,
            totalMaterialsNeeded,  // Total materials needed across all lines
            intermediateConfig ? {
              meLevel: intermediateConfig.me_level,
              teLevel: intermediateConfig.te_level,
              facilitySnapshot: JSON.parse(intermediateConfig.facility_snapshot),
              useIntermediates: intermediateConfig.use_intermediates
            } : null,
            facility,  // Parent facility as fallback
            plan.character_id,
            planId,  // Pass planId for nested intermediate lookups
            intermediateConfig ? intermediateConfig.plan_blueprint_id : null,  // Parent blueprint ID for child lookups
            1  // Start at depth 1
          );

          // Aggregate the expanded materials
          for (const [matTypeId, matQty] of Object.entries(expansion.materials)) {
            aggregatedMaterials[matTypeId] = (aggregatedMaterials[matTypeId] || 0) + matQty;
          }

          // Collect intermediate products
          aggregatedIntermediateProducts.push(...expansion.intermediateProducts);

          // ---- Tree: walk the same intermediate to build node tree ----
          await walkIntermediateNodes(
            intermediateBlueprintId,
            totalMaterialsNeeded,
            intermediateConfig ? {
              meLevel: intermediateConfig.me_level,
              facilitySnapshot: JSON.parse(intermediateConfig.facility_snapshot),
              useIntermediates: intermediateConfig.use_intermediates
            } : null,
            facility,
            blueprint.planBlueprintId,
            intermediateConfig?.plan_blueprint_id ?? null,
            productNodeId,
            1
          );
          // ---- End tree walk ----
        }

        // Process reactions - aggregate quantities for Phase 2.5, and build tree nodes if reactions enabled
        for (const reaction of reactions) {
          const materialTypeId = reaction.typeId;
          const materialQuantity = reaction.quantity;
          const totalQty = materialQuantity * blueprint.lines;
          aggregatedMaterials[materialTypeId] = (aggregatedMaterials[materialTypeId] || 0) + totalQty;

          if (planReactionsEnabled) {
            // ---- Tree: create placeholder reaction node ----
            // Do NOT call walkReactionNodes here — the reaction's own facility (Athanor/Tatara)
            // is only known in PHASE 2.5 after aggregation. Walking here would use the
            // manufacturing blueprint's facility (Sotiyo/Azbel), producing wrong quantities.
            // PHASE 2.5 will wire sourcePlanBlueprintId and walk with the correct facility.
            const reactionRunsNeeded = await calculateReactionRuns(totalQty, reaction.reactionTypeId);
            const reactionProduct = await getReactionProduct(reaction.reactionTypeId);
            const reactionProductsPerRun = reactionProduct?.quantity ?? 1;
            const reactionNodeId = randomUUID();
            collectedNodes.push({
              nodeId: reactionNodeId,
              planBlueprintId: blueprint.planBlueprintId,
              sourcePlanBlueprintId: null, // Phase 2.5 fills this in
              parentNodeId: productNodeId,
              typeId: reaction.typeId,
              nodeType: 'intermediate',
              depth: 1,
              quantityNeeded: reactionRunsNeeded * reactionProductsPerRun,
              quantityPerRun: reactionProductsPerRun,
              runsNeeded: reactionRunsNeeded,
              meLevel: null,
              isReaction: 1,
              buildPlan: 'raw_materials',
              price: null,
              priceFrozenAt: null,
              _reactionTypeId: reaction.reactionTypeId
            });
            // ---- End placeholder reaction node ----
          } else {
            // Reactions disabled: add reaction product as a raw material leaf
            collectedNodes.push({
              nodeId: randomUUID(),
              planBlueprintId: blueprint.planBlueprintId,
              sourcePlanBlueprintId: null,
              parentNodeId: productNodeId,
              typeId: reaction.typeId,
              nodeType: 'material',
              depth: 1,
              quantityNeeded: totalQty,
              quantityPerRun: null,
              runsNeeded: null,
              meLevel: null,
              isReaction: 0,
              buildPlan: 'raw_materials',
              price: null,
              priceFrozenAt: null
            });
          }
        }

        // Process raw materials - add them directly
        for (const rawMaterial of rawMaterials) {
          const totalQty = rawMaterial.quantity * blueprint.lines;
          aggregatedMaterials[rawMaterial.typeId] = (aggregatedMaterials[rawMaterial.typeId] || 0) + totalQty;

          // ---- Tree: raw material leaf node as child of productNodeId ----
          collectedNodes.push({
            nodeId: randomUUID(),
            planBlueprintId: blueprint.planBlueprintId,
            sourcePlanBlueprintId: null,
            parentNodeId: productNodeId,
            typeId: rawMaterial.typeId,
            nodeType: 'material',
            depth: 1,
            quantityNeeded: totalQty,
            quantityPerRun: null,
            runsNeeded: null,
            meLevel: null,
            isReaction: 0,
            buildPlan: 'raw_materials',
            price: null,
            priceFrozenAt: null
          });
          // ---- End raw material leaf node ----
        }
      } else if (blueprint.useIntermediates === 'components') {
        // use_intermediates === 'components'
        // Don't expand - just add components as materials
        for (const [typeId, quantity] of Object.entries(calculation.materials)) {
          const totalQty = quantity * blueprint.lines;
          aggregatedMaterials[typeId] = (aggregatedMaterials[typeId] || 0) + totalQty;

          // ---- Tree: component material leaf as child of productNodeId ----
          collectedNodes.push({
            nodeId: randomUUID(),
            planBlueprintId: blueprint.planBlueprintId,
            sourcePlanBlueprintId: null,
            parentNodeId: productNodeId,
            typeId: parseInt(typeId),
            nodeType: 'material',
            depth: 1,
            quantityNeeded: totalQty,
            quantityPerRun: null,
            runsNeeded: null,
            meLevel: null,
            isReaction: 0,
            buildPlan: 'components',
            price: null,
            priceFrozenAt: null
          });
          // ---- End component material leaf ----
        }
      } else if (blueprint.useIntermediates === 'buy') {
        // use_intermediates === 'buy'
        // Add blueprint's final product as a purchasable material instead of building it
        const product = calculation.product;
        if (product && product.typeID) {
          const baseQty = product.baseQuantity || 1;
          // Total products = baseQuantity * total runs (runs = total to manufacture)
          const totalProductQty = baseQty * blueprint.runs;

          aggregatedMaterials[product.typeID] =
            (aggregatedMaterials[product.typeID] || 0) + totalProductQty;

          console.log(`[Plans] Blueprint ${blueprint.blueprintTypeId} set to 'buy' - adding ${totalProductQty} of product ${product.typeID} to materials`);
        }

        // Skip adding to aggregatedProducts (we're buying it, not producing it)
        continue; // Skip the product aggregation step below
      }

      // Get final product for this blueprint
      const product = calculation.product;
      if (product) {
        // Total products = baseQuantity * total runs
        // runs = total manufacturing runs, lines = parallel production lines to split across
        const baseQty = product.baseQuantity || 1;
        const totalProductQty = baseQty * blueprint.runs;
        aggregatedProducts[product.typeID] = (aggregatedProducts[product.typeID] || 0) + totalProductQty;
      }
    }

    // PHASE 2.5: Detect and expand reactions from aggregated materials
    // This happens AFTER all materials are aggregated across all blueprints
    // Reactions are created with parent_blueprint_id = NULL (aggregated, not per-parent)
    console.log(`[Plans] Detecting reactions from aggregated materials for plan ${planId}`);

    // planReactionsEnabled already computed above (using earlyPlanSettings)
    if (planReactionsEnabled) {
      // Iteratively process reactions until no more are found (handles nested reactions)
      // This loop ensures that if a reaction's inputs are themselves reaction products,
      // they will be detected and expanded in subsequent iterations
      let iterationCount = 0;
      const maxIterations = 20; // Safety limit to prevent infinite loops
      let foundReactions = true;

      while (foundReactions && iterationCount < maxIterations) {
        iterationCount++;

        // Classify aggregated materials to find reaction products
        const { reactions: aggregatedReactions } = await classifyMaterials(aggregatedMaterials);

        if (aggregatedReactions.length > 0) {
          console.log(`[Plans] Iteration ${iterationCount}: Found ${aggregatedReactions.length} reaction product(s) in aggregated materials`);

          for (const reaction of aggregatedReactions) {
            const reactionTypeId = reaction.reactionTypeId;
            const materialTypeId = reaction.typeId;
            const totalUnitsNeeded = reaction.quantity; // Already aggregated across all parents
            const product = reaction.product;

            // Calculate runs needed for this total quantity
            const runsNeeded = await calculateReactionRuns(totalUnitsNeeded, reactionTypeId);
            const productsPerRun = product ? product.quantity : 1;

            console.log(`[Plans] Aggregated reaction: ${reactionTypeId} - need ${totalUnitsNeeded} units @ ${productsPerRun}/run = ${runsNeeded} runs`);

            // Check if we have a saved facility assignment for this reaction type
            let facility = null;
            let facilityId = null;
            const savedFacility = reactionFacilityMap.get(reactionTypeId);

            if (savedFacility && savedFacility.facilityId) {
              // Use the previously saved facility assignment
              facilityId = savedFacility.facilityId;
              try {
                facility = savedFacility.facilitySnapshot ? JSON.parse(savedFacility.facilitySnapshot) : null;
                facility = await enrichFacilityWithSecurityStatus(facility);

                // Verify facility has necessary fields for bonus calculation
                if (facility) {
                  console.log(`[Plans] Restored facility for reaction ${reactionTypeId}:`, {
                    id: facility.id,
                    name: facility.name,
                    hasRigs: !!facility.rigs,
                    rigCount: facility.rigs?.length || 0,
                    structureTypeId: facility.structureTypeId,
                    securityStatus: facility.securityStatus
                  });

                  // Ensure rigs array exists
                  if (!facility.rigs) {
                    facility.rigs = [];
                    console.warn(`[Plans] Facility snapshot missing rigs array for reaction ${reactionTypeId}, defaulting to empty`);
                  }
                } else {
                  console.log(`[Plans] Restored facility for reaction ${reactionTypeId}: null snapshot`);
                }
              } catch (error) {
                console.error(`[Plans] Failed to parse facility snapshot for reaction ${reactionTypeId}:`, error);
                facility = null;
                facilityId = null;
              }
            } else {
              // Use first parent's facility (default for new reactions)
              const firstParent = topLevelBlueprints.find(bp =>
                bp.useIntermediates === 'raw_materials' || bp.useIntermediates === 'build_buy'
              );
              facility = firstParent ? firstParent.facilitySnapshot : null;
              facility = await enrichFacilityWithSecurityStatus(facility);
              facilityId = facility ? facility.id : null;
              console.log(`[Plans] Using default facility for new reaction ${reactionTypeId}:`, {
                name: facility?.name || 'none',
                hasRigs: !!facility?.rigs,
                rigCount: facility?.rigs?.length || 0,
                securityStatus: facility?.securityStatus
              });
            }

            // Create aggregated reaction record (parent_blueprint_id = NULL)
            const reactionBlueprintId = randomUUID();
            const now = Date.now();

            db.prepare(`
              INSERT INTO plan_blueprints (
                plan_blueprint_id, plan_id, parent_blueprint_id,
                blueprint_type_id, runs, lines,
                me_level, te_level, facility_id, facility_snapshot,
                is_intermediate, is_built, intermediate_product_type_id,
                use_intermediates, blueprint_type, reaction_type_id,
                added_at, built_runs
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'reaction', ?, ?, 0)
            `).run(
              reactionBlueprintId,
              planId,
              null,  // CRITICAL: NULL means aggregated (not tied to specific parent)
              reactionTypeId,
              runsNeeded,
              1,  // lines always 1 for reactions
              0,  // me_level (not applicable)
              0,  // te_level (not applicable)
              facilityId,
              facility ? JSON.stringify(facility) : null,
              materialTypeId,  // intermediate_product_type_id
              'raw_materials',  // Always expand reactions
              reactionTypeId,  // Also store in reaction_type_id
              now
            );

            // Expand this reaction to get its input materials
            const expansion = await expandReaction(
              reactionTypeId,
              runsNeeded,
              {
                facilitySnapshot: facility,
                useIntermediates: 'raw_materials'
              },
              facility,
              plan.character_id,
              planId,
              reactionBlueprintId,  // This reaction is now the parent for nested reactions
              0  // Start at depth 0 for aggregated reactions
            );

            // Remove the reaction product from aggregatedMaterials
            delete aggregatedMaterials[materialTypeId];
            console.log(`[Plans] Removed reaction product ${materialTypeId} from materials`);

            // Add the reaction's input materials to aggregatedMaterials
            for (const [inputTypeId, inputQty] of Object.entries(expansion.materials)) {
              aggregatedMaterials[inputTypeId] = (aggregatedMaterials[inputTypeId] || 0) + inputQty;
            }

            // Track reaction products as intermediate products
            aggregatedIntermediateProducts.push(...expansion.intermediateProducts);

            // ---- Tree: wire sourcePlanBlueprintId into pre-expanded reaction nodes ----
            // Reaction nodes were already created and their inputs expanded during Phase 2 /
            // walkIntermediateNodes. We just need to back-fill sourcePlanBlueprintId now that
            // we have the plan_blueprints row ID for this reaction.
            const rootBlueprintId = topLevelBlueprints[0]?.planBlueprintId ?? null;
            const pendingReactionNodes = collectedNodes.filter(
              n => n._reactionTypeId === reactionTypeId && n.sourcePlanBlueprintId === null
            );

            if (pendingReactionNodes.length > 0) {
              // Wire ALL placeholder nodes with the aggregated reaction's plan_blueprint_id
              // and update their quantities to the aggregated total.
              for (const n of pendingReactionNodes) {
                n.sourcePlanBlueprintId = reactionBlueprintId;
                n.runsNeeded = runsNeeded;
                n.quantityNeeded = runsNeeded * (n.quantityPerRun ?? 1);
              }
              // Walk reaction inputs ONCE using the correct reaction facility.
              // Use the first pending node as the parent for leaf nodes so the tree
              // is rooted correctly. Multiple pending nodes represent the same reaction
              // appearing under different parents — one set of leaf nodes covers all.
              await walkReactionNodes(
                reactionTypeId,
                runsNeeded,
                facility,
                pendingReactionNodes[0].planBlueprintId,
                reactionBlueprintId,
                pendingReactionNodes[0].nodeId,
                1
              );
            } else {
              // No pre-expanded node found: this reaction only appeared in aggregatedMaterials
              // via paths we didn't tree-walk (shouldn't normally happen, but handle gracefully).
              const newReactionNodeId = randomUUID();
              collectedNodes.push({
                nodeId: newReactionNodeId,
                planBlueprintId: rootBlueprintId,
                sourcePlanBlueprintId: reactionBlueprintId,
                parentNodeId: null,
                typeId: materialTypeId,
                nodeType: 'intermediate',
                depth: 1,
                quantityNeeded: totalUnitsNeeded,
                quantityPerRun: null,
                runsNeeded: runsNeeded,
                meLevel: null,
                isReaction: 1,
                buildPlan: 'raw_materials',
                price: null,
                priceFrozenAt: null
              });
              await walkReactionNodes(
                reactionTypeId,
                runsNeeded,
                facility,
                rootBlueprintId,
                reactionBlueprintId,
                newReactionNodeId,
                0
              );
            }
            // ---- End reaction tree wiring ----
          }
        } else {
          // No more reactions found, exit loop
          console.log(`[Plans] Iteration ${iterationCount}: No more reactions found, processing complete`);
          foundReactions = false;
        }
      }

      if (iterationCount >= maxIterations) {
        console.warn(`[Plans] WARNING: Reached maximum iteration limit (${maxIterations}). Possible circular dependency in reactions.`);
      }
    }

    // Begin transaction for atomic update
    db.exec('BEGIN TRANSACTION');

    try {
      // Get existing prices before clearing (to preserve them when not refreshing)
      const existingMaterialPrices = {};
      const existingProductPrices = {};

      if (!refreshPrices) {
        const existingMaterials = db.prepare(`
          SELECT type_id, MAX(price_frozen_at) as price_frozen_at, price_each as base_price
          FROM plan_material_nodes
          WHERE plan_id = ? AND node_type = 'material'
          GROUP BY type_id
        `).all(planId);
        for (const mat of existingMaterials) {
          existingMaterialPrices[mat.type_id] = {
            price: mat.base_price,
            frozenAt: mat.price_frozen_at
          };
        }

        const existingProducts = db.prepare(`
          SELECT type_id, MAX(price_frozen_at) as price_frozen_at, price_each as base_price
          FROM plan_material_nodes
          WHERE plan_id = ? AND node_type IN ('product', 'intermediate')
          GROUP BY type_id
        `).all(planId);
        for (const prod of existingProducts) {
          existingProductPrices[prod.type_id] = {
            price: prod.base_price,
            frozenAt: prod.price_frozen_at
          };
        }
      }

      // Clear existing material nodes
      db.prepare('DELETE FROM plan_material_nodes WHERE plan_id = ?').run(planId);

      const insertNode = db.prepare(`
        INSERT INTO plan_material_nodes
          (node_id, plan_id, plan_blueprint_id, source_plan_blueprint_id, parent_node_id,
           type_id, node_type, depth, quantity_needed, quantity_per_run, runs_needed, me_level,
           is_reaction, build_plan, price_each, price_frozen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Get location settings for input materials
      const inputLocation = getInputLocation(marketSettings);

      // Determine what is TRULY a final product
      const finalProductTypeIds = new Set();
      for (const blueprint of topLevelBlueprints) {
        const calculation = blueprintCalculations.get(blueprint.planBlueprintId);
        if (calculation?.product?.typeID) {
          finalProductTypeIds.add(calculation.product.typeID);
        }
      }

      // Get location settings for output products
      const outputLocation = getOutputLocation(marketSettings);

      // ---- Phase 2.5 cleanup: remove stale pending reaction nodes ----
      // Any node that still has _reactionTypeId but no sourcePlanBlueprintId was never matched
      // to a real reaction row (e.g. it was aggregated away), so remove it to avoid duplication.
      for (let i = collectedNodes.length - 1; i >= 0; i--) {
        const n = collectedNodes[i];
        if (n._reactionTypeId !== undefined && n.sourcePlanBlueprintId === null) {
          collectedNodes.splice(i, 1);
        }
      }
      // ---- End stale node cleanup ----

      // PHASE 3: Price each collected node and insert in one pass
      // (Replaces the three separate INSERT loops for materials, products, intermediates)

      for (const node of collectedNodes) {
        let price = null;
        let priceFrozenAt = null;

        if (node.nodeType === 'material') {
          if (refreshPrices) {
            try {
              const priceResult = await calculateRealisticPrice(
                node.typeId,
                inputLocation.regionId,
                inputLocation.locationId,
                marketSettings.inputMaterials.priceType,
                node.quantityNeeded
              );
              price = priceResult.price;
              priceFrozenAt = now;
            } catch (error) {
              console.warn(`Could not fetch price for type ${node.typeId}:`, error.message);
            }
          } else {
            const existing = existingMaterialPrices[node.typeId];
            if (existing) {
              price = existing.price;
              priceFrozenAt = existing.frozenAt;
            }
          }
        } else {
          // 'product' or 'intermediate'
          if (refreshPrices) {
            try {
              const priceResult = await calculateRealisticPrice(
                node.typeId,
                outputLocation.regionId,
                outputLocation.locationId,
                marketSettings.outputProducts.priceType,
                node.quantityNeeded
              );
              price = priceResult.price;
              priceFrozenAt = now;
            } catch (error) {
              console.warn(`Could not fetch price for type ${node.typeId}:`, error.message);
            }
          } else {
            const existing = existingProductPrices[node.typeId];
            if (existing) {
              price = existing.price;
              priceFrozenAt = existing.frozenAt;
            }
          }
        }

        // Strip the internal helper field before inserting
        const { _reactionTypeId, ...insertData } = node;

        insertNode.run(
          insertData.nodeId,
          planId,
          insertData.planBlueprintId,
          insertData.sourcePlanBlueprintId,
          insertData.parentNodeId,
          insertData.typeId,
          insertData.nodeType,
          insertData.depth,
          insertData.quantityNeeded,
          insertData.quantityPerRun,
          insertData.runsNeeded,
          insertData.meLevel,
          insertData.isReaction,
          insertData.buildPlan,
          price,
          priceFrozenAt,
          now,
          now
        );
      }

      // Clean up orphaned intermediates before committing
      await cleanupOrphanedIntermediates(planId);

      db.exec('COMMIT');
      console.log(`Recalculated materials and products for plan ${planId} (${Object.keys(aggregatedMaterials).length} materials, ${Object.keys(aggregatedProducts).length} products)`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // Post-commit: recalculate manufactured acquisitions from any built intermediates/reactions.
    clearManufacturedAcquisitions(planId);
    await recalculateManufacturedMaterials(planId);

    const warnings = [];

    // Check for materials with excess acquisitions (ledger net > needed)
    const newMaterials = db.prepare(`
      SELECT type_id, SUM(quantity_needed) as quantity_needed
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type = 'material'
      GROUP BY type_id
    `).all(planId);

    const ledgerTotals = db.prepare(`
      SELECT type_id, SUM(quantity) as net_acquired
      FROM plan_material_ledger
      WHERE plan_id = ?
      GROUP BY type_id
    `).all(planId);

    const ledgerMap = new Map(ledgerTotals.map(l => [l.type_id, l.net_acquired]));
    const nodeTypeIds = new Set(newMaterials.map(m => m.type_id));

    for (const ledgerEntry of ledgerTotals) {
      if (!nodeTypeIds.has(ledgerEntry.type_id) && ledgerEntry.net_acquired > 0) {
        warnings.push({
          type: 'orphaned_ledger',
          typeId: ledgerEntry.type_id,
          netAcquired: ledgerEntry.net_acquired
        });
      }
    }

    for (const mat of newMaterials) {
      const netAcquired = ledgerMap.get(mat.type_id) || 0;
      if (netAcquired > mat.quantity_needed) {
        warnings.push({
          type: 'excess_acquisitions',
          typeId: mat.type_id,
          needed: mat.quantity_needed,
          acquired: netAcquired,
          excess: netAcquired - mat.quantity_needed
        });
      }
    }

    return { success: true, warnings };
  } catch (error) {
    console.error('Error recalculating plan materials:', error);
    return false;
  }
}

/**
 * Get plan materials with optional asset matching
 * @param {string} planId - Plan ID
 * @param {boolean} includeAssets - Whether to include owned asset quantities
 * @returns {Promise<Array>} Array of materials with quantities
 */
async function getPlanMaterials(planId, includeAssets = false) {
  try {
    const db = getCharacterDatabase();

    // Get aggregated materials from plan_material_nodes
    const materialNodes = db.prepare(`
      SELECT type_id, SUM(quantity_needed) as quantity_needed,
             price_each, MAX(price_frozen_at) as price_frozen_at
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type = 'material'
      GROUP BY type_id
      ORDER BY SUM(quantity_needed) DESC
    `).all(planId);

    // Get ledger net acquired per type
    const ledgerEntries = db.prepare(`
      SELECT type_id, SUM(quantity) as net_acquired,
             MAX(CASE WHEN unit_price IS NOT NULL THEN unit_price END) as custom_price,
             MAX(CASE WHEN method != 'manufactured' THEN method END) as acquisition_method,
             MAX(note) as acquisition_note,
             MAX(created_at) as acquisition_updated_at
      FROM plan_material_ledger
      WHERE plan_id = ?
      GROUP BY type_id
    `).all(planId);

    const ledgerMap = new Map(ledgerEntries.map(l => [l.type_id, l]));

    // Query confirmed transaction matches (material purchases)
    const confirmedPurchases = {};
    if (materialNodes.length > 0) {
      try {
        const typeIds = materialNodes.map(m => m.type_id);
        const placeholders = typeIds.map(() => '?').join(',');
        const purchases = db.prepare(`
          SELECT type_id,
                 SUM(quantity) as total_quantity,
                 COUNT(*) as match_count
          FROM plan_transaction_matches
          WHERE plan_id = ?
            AND type_id IN (${placeholders})
            AND status = 'confirmed'
            AND match_type = 'material_buy'
          GROUP BY type_id
        `).all(planId, ...typeIds);

        for (const p of purchases) {
          confirmedPurchases[p.type_id] = {
            quantity: p.total_quantity,
            count: p.match_count
          };
        }
      } catch (error) {
        console.error('Error querying confirmed purchases:', error);
      }
    }

    // Query confirmed industry job matches (manufactured materials)
    const confirmedManufacturing = {};
    if (materialNodes.length > 0) {
      try {
        const typeIds = materialNodes.map(m => m.type_id);

        const confirmedJobs = db.prepare(`
          SELECT jm.job_id, ij.blueprint_type_id, ij.runs
          FROM plan_job_matches jm
          JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
          WHERE jm.plan_id = ?
            AND jm.status = 'confirmed'
        `).all(planId);

        if (confirmedJobs.length > 0) {
          let sdeDb = null;
          try {
            sdeDb = new Database(getSdePath(), { readonly: true });
            const blueprintTypeIds = confirmedJobs.map(j => j.blueprint_type_id);
            const placeholders = blueprintTypeIds.map(() => '?').join(',');
            const products = sdeDb.prepare(`
              SELECT typeID, productTypeID, quantity
              FROM industryActivityProducts
              WHERE activityID = 1
                AND typeID IN (${placeholders})
            `).all(...blueprintTypeIds);

            for (const job of confirmedJobs) {
              const jobProducts = products.filter(p => p.typeID === job.blueprint_type_id);
              for (const product of jobProducts) {
                if (typeIds.includes(product.productTypeID)) {
                  const totalQuantity = job.runs * product.quantity;
                  if (!confirmedManufacturing[product.productTypeID]) {
                    confirmedManufacturing[product.productTypeID] = { quantity: 0, count: 0 };
                  }
                  confirmedManufacturing[product.productTypeID].quantity += totalQuantity;
                  confirmedManufacturing[product.productTypeID].count += 1;
                }
              }
            }
          } catch (error) {
            console.error('Error accessing SDE database for manufacturing matches:', error);
          } finally {
            if (sdeDb) sdeDb.close();
          }
        }
      } catch (error) {
        console.error('Error querying confirmed manufacturing jobs:', error);
      }
    }

    const result = materialNodes.map(m => {
      const ledger = ledgerMap.get(m.type_id);
      const netAcquired = ledger?.net_acquired || 0;
      return {
        typeId: m.type_id,
        quantity: m.quantity_needed,
        basePrice: m.price_each,
        priceFrozenAt: m.price_frozen_at,
        manuallyAcquired: netAcquired > 0 ? 1 : 0,
        manuallyAcquiredQuantity: netAcquired,
        acquisitionMethod: ledger?.acquisition_method || null,
        customPrice: ledger?.custom_price || null,
        acquisitionNote: ledger?.acquisition_note || null,
        acquisitionUpdatedAt: ledger?.acquisition_updated_at || null,
        purchasedQuantity: confirmedPurchases[m.type_id]?.quantity || 0,
        purchaseMatchCount: confirmedPurchases[m.type_id]?.count || 0,
        manufacturedQuantity: confirmedManufacturing[m.type_id]?.quantity || 0,
        manufacturingMatchCount: confirmedManufacturing[m.type_id]?.count || 0,
        ownedPersonal: 0,
        ownedCorp: 0,
      };
    });

    if (includeAssets) {
      // Get plan to find character ID
      const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
      if (!plan) return result;

      const planSettings = getPlanIndustrySettings(planId);
      let characterIds = planSettings.defaultCharacters || [];
      if (characterIds.length === 0) characterIds = [plan.character_id];
      const enabledDivisions = planSettings.enabledDivisions || {};

      const personalAssetMap = {};
      const corpAssetMap = {};
      const personalAssetDetails = {};
      const corpAssetDetails = {};
      const processedCorps = new Set();

      for (const characterId of characterIds) {
        const { getCharacter } = require('./settings-manager');
        const character = getCharacter(characterId);
        if (!character) continue;

        const personalAssets = getAssets(characterId, false);
        for (const asset of personalAssets) {
          personalAssetMap[asset.typeId] = (personalAssetMap[asset.typeId] || 0) + asset.quantity;
          if (!personalAssetDetails[asset.typeId]) personalAssetDetails[asset.typeId] = [];
          let charEntry = personalAssetDetails[asset.typeId].find(e => e.characterId === characterId);
          if (!charEntry) {
            charEntry = { characterId, characterName: character.characterName, quantity: 0 };
            personalAssetDetails[asset.typeId].push(charEntry);
          }
          charEntry.quantity += asset.quantity;
        }

        const corpId = character.corporationId;
        if (corpId && !processedCorps.has(corpId)) {
          processedCorps.add(corpId);
          const charEnabledDivisions = enabledDivisions[characterId] || [];
          const corpAssets = getAssets(characterId, true);
          for (const asset of corpAssets) {
            if (isAssetInEnabledDivision(asset, charEnabledDivisions)) {
              corpAssetMap[asset.typeId] = (corpAssetMap[asset.typeId] || 0) + asset.quantity;
              if (!corpAssetDetails[asset.typeId]) corpAssetDetails[asset.typeId] = [];
              const divisionId = extractDivisionId(asset.locationFlag);
              let corpEntry = corpAssetDetails[asset.typeId].find(
                e => e.corporationId === corpId && e.divisionId === divisionId
              );
              if (!corpEntry) {
                corpEntry = {
                  corporationId: corpId,
                  corporationName: character.corporationName || `Corporation ${corpId}`,
                  divisionId,
                  divisionName: getDivisionName(characterId, divisionId),
                  quantity: 0
                };
                corpAssetDetails[asset.typeId].push(corpEntry);
              }
              corpEntry.quantity += asset.quantity;
            }
          }
        }
      }

      for (const material of result) {
        material.ownedPersonal = personalAssetMap[material.typeId] || 0;
        material.ownedCorp = corpAssetMap[material.typeId] || 0;
        material.ownedPersonalDetails = personalAssetDetails[material.typeId] || [];
        material.ownedCorpDetails = corpAssetDetails[material.typeId] || [];
      }
    }

    return result;
  } catch (error) {
    console.error('Error getting plan materials:', error);
    return [];
  }
}

/**
 * Check if an asset is in an enabled corporation division
 * @param {Object} asset - Asset object with locationFlag
 * @param {number[]} enabledDivisions - Array of enabled division IDs (1-7)
 * @returns {boolean} True if asset is in an enabled division
 */
function isAssetInEnabledDivision(asset, enabledDivisions) {
  // If no divisions are enabled, no corp assets should be included
  if (!enabledDivisions || enabledDivisions.length === 0) {
    return false;
  }

  // Parse location_flag to extract division number
  // Format: "CorpSAG1", "CorpSAG2", etc.
  const locationFlag = asset.locationFlag;
  if (!locationFlag || !locationFlag.startsWith('CorpSAG')) {
    // Asset is not in a corporation hangar division
    // (might be in a station hangar, container, etc.)
    // Exclude it since we can't determine its division
    return false;
  }

  // Extract division number (1-7)
  const divisionMatch = locationFlag.match(/^CorpSAG(\d+)$/);
  if (!divisionMatch) {
    return false; // Can't parse, exclude
  }

  const divisionId = parseInt(divisionMatch[1], 10);

  // Check if this division is enabled
  return enabledDivisions.includes(divisionId);
}

/**
 * Extract division ID from location flag
 * @param {string} locationFlag - Location flag (e.g., "CorpSAG2")
 * @returns {number|null} Division ID (1-7) or null
 */
function extractDivisionId(locationFlag) {
  if (!locationFlag) return null;

  const match = locationFlag.match(/CorpSAG(\d)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }

  return null;
}

/**
 * Get division name for a character
 * @param {number} characterId - Character ID
 * @param {number} divisionId - Division ID (1-7)
 * @returns {string} Division name
 */
function getDivisionName(characterId, divisionId) {
  const { getCharacterDivisionSettings } = require('./settings-manager');
  const settings = getCharacterDivisionSettings(characterId);

  if (settings && settings.divisionNames && settings.divisionNames[divisionId]) {
    return settings.divisionNames[divisionId];
  }

  return `Division ${divisionId}`;
}

/**
 * Get plan products
 * @param {string} planId - Plan ID
 * @returns {Array} Array of products
 */
function getPlanProducts(planId) {
  try {
    const db = getCharacterDatabase();

    const products = db.prepare(`
      SELECT type_id, SUM(quantity_needed) as quantity, price_each as base_price,
             MAX(price_frozen_at) as price_frozen_at,
             CASE WHEN node_type = 'intermediate' THEN 1 ELSE 0 END as is_intermediate,
             depth as intermediate_depth
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type IN ('product', 'intermediate')
      GROUP BY type_id, node_type, depth
      ORDER BY is_intermediate DESC, quantity DESC
    `).all(planId);

    return products.map(p => ({
      typeId: p.type_id,
      quantity: p.quantity,
      basePrice: p.base_price,
      priceFrozenAt: p.price_frozen_at,
      isIntermediate: p.is_intermediate === 1,
      intermediateDepth: p.intermediate_depth || 0,
    }));
  } catch (error) {
    console.error('Error getting plan products:', error);
    return [];
  }
}

/**
 * Get plan summary with cost and profit estimates
 * @param {string} planId - Plan ID
 * @returns {Promise<Object>} Summary with materialCost, productValue, estimatedProfit
 */
async function getPlanSummary(planId) {
  try {
    const materials = await getPlanMaterials(planId, false);
    const products = getPlanProducts(planId);

    let materialCost = 0;
    let materialsWithPrice = 0;

    for (const material of materials) {
      // Calculate cost based on acquisition sources (pro-rata pricing)
      const manualQty = material.manuallyAcquiredQuantity || 0;
      const autoQty = Math.max(0, material.quantity - manualQty);

      let itemCost = 0;

      // Manual portion: use custom price if set, otherwise base price
      if (manualQty > 0 && material.customPrice !== null) {
        itemCost += material.customPrice * manualQty;
      } else if (manualQty > 0 && material.basePrice !== null) {
        itemCost += material.basePrice * manualQty;
      }

      // Auto portion: always use base (market) price
      if (autoQty > 0 && material.basePrice !== null) {
        itemCost += material.basePrice * autoQty;
      }

      if (itemCost > 0) {
        materialCost += itemCost;
        materialsWithPrice++;
      }
    }

    let productValue = 0;
    let productsWithPrice = 0;

    // Only count final products (not intermediates) in product value
    for (const product of products) {
      if (!product.isIntermediate && product.basePrice !== null) {
        productValue += product.basePrice * product.quantity;
        productsWithPrice++;
      }
    }

    const estimatedProfit = productValue - materialCost;
    const roi = materialCost > 0 ? (estimatedProfit / materialCost) * 100 : 0;

    return {
      materialCost,
      materialsWithPrice,
      totalMaterials: materials.length,
      productValue,
      productsWithPrice,
      totalProducts: products.length,
      estimatedProfit,
      roi,
    };
  } catch (error) {
    console.error('Error getting plan summary:', error);
    return {
      materialCost: 0,
      materialsWithPrice: 0,
      totalMaterials: 0,
      productValue: 0,
      productsWithPrice: 0,
      totalProducts: 0,
      estimatedProfit: 0,
      roi: 0,
    };
  }
}

/**
 * Refresh ESI data for all characters associated with a plan
 * Fetches personal jobs for each character and corporate jobs (deduplicated by corporation)
 * @param {string} planId - Plan ID to refresh
 * @returns {Promise<Object>} Refresh summary
 */
async function refreshPlanESIData(planId) {
  try {
    const { fetchCharacterIndustryJobs, fetchCorporationIndustryJobs, saveIndustryJobs } = require('./esi-industry-jobs');
    const { fetchCharacterWalletTransactions, saveWalletTransactions } = require('./esi-wallet');
    const { matchJobsToPlan, matchTransactionsToPlan } = require('./plan-matching');
    const { getCharacter } = require('./settings-manager');
    const db = getCharacterDatabase();

    // Get plan industry settings to find all characters
    const planSettings = getPlanIndustrySettings(planId);
    const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);

    if (!plan) {
      return { success: false, message: 'Plan not found' };
    }

    // Determine which characters to refresh
    let characterIds = planSettings.defaultCharacters || [];
    if (characterIds.length === 0) {
      // Fallback: use plan's default character
      characterIds = [plan.character_id];
    }

    // Build a map of corporation ID -> first character with access (for deduplication)
    // This ensures we only fetch each corporation's jobs once, even if multiple characters share the same corp
    const corporationCharacterMap = new Map(); // corporationId -> characterId (auth character)

    for (const characterId of characterIds) {
      const character = getCharacter(characterId);
      if (character && character.corporationId) {
        // First character with this corp becomes the auth character
        if (!corporationCharacterMap.has(character.corporationId)) {
          corporationCharacterMap.set(character.corporationId, characterId);
        }
      }
    }

    // Fetch jobs and transactions for ALL characters
    const results = {
      success: true,
      charactersRefreshed: [],
      corporationsFetched: [],
      errors: []
    };

    // First pass: Fetch personal jobs and wallet transactions for each character
    for (const characterId of characterIds) {
      try {
        // Fetch personal industry jobs
        const jobsData = await fetchCharacterIndustryJobs(characterId, true);
        if (jobsData.jobs) {
          saveIndustryJobs({
            characterId,
            jobs: jobsData.jobs,
            lastUpdated: jobsData.lastUpdated,
            cacheExpiresAt: jobsData.cacheExpiresAt,
            isCorporation: false
          });
        }

        // Fetch wallet transactions
        const txData = await fetchCharacterWalletTransactions(characterId);
        if (txData.transactions) {
          saveWalletTransactions({ characterId, transactions: txData.transactions, lastUpdated: txData.lastUpdated });
        }

        results.charactersRefreshed.push(characterId);
      } catch (error) {
        console.error(`[Plans] Error refreshing personal data for character ${characterId}:`, error);
        results.errors.push({ characterId, error: error.message, type: 'personal' });
      }
    }

    // Second pass: Fetch corporate jobs (deduplicated by corporation)
    const corporationsFetched = new Set();

    for (const [corporationId, authCharacterId] of corporationCharacterMap) {
      // Skip if we've already fetched this corporation's jobs
      if (corporationsFetched.has(corporationId)) {
        continue;
      }

      try {
        console.log(`[Plans] Fetching corporation ${corporationId} jobs using character ${authCharacterId}`);
        const corpJobsData = await fetchCorporationIndustryJobs(authCharacterId, corporationId, true);

        if (corpJobsData.jobs && corpJobsData.jobs.length > 0) {
          saveIndustryJobs({
            characterId: authCharacterId,
            corporationId: corporationId,
            jobs: corpJobsData.jobs,
            lastUpdated: corpJobsData.lastUpdated,
            cacheExpiresAt: corpJobsData.cacheExpiresAt,
            isCorporation: true
          });
          console.log(`[Plans] Saved ${corpJobsData.jobs.length} corporation jobs for corp ${corporationId}`);
        }

        corporationsFetched.add(corporationId);
        results.corporationsFetched.push(corporationId);
      } catch (error) {
        console.error(`[Plans] Error fetching corporation ${corporationId} jobs:`, error);
        results.errors.push({ corporationId, error: error.message, type: 'corporation' });
      }
    }

    // Run matching after fetching all data (include corporation IDs for job matching)
    try {
      matchJobsToPlan(planId, {
        characterIds: results.charactersRefreshed,
        corporationIds: results.corporationsFetched
      });
      matchTransactionsToPlan(planId, { characterIds: results.charactersRefreshed });
    } catch (error) {
      console.error('[Plans] Error running matches:', error);
    }

    const corpMsg = results.corporationsFetched.length > 0
      ? `, ${results.corporationsFetched.length} corporation(s)`
      : '';

    return {
      success: results.errors.length === 0,
      message: `Refreshed ${results.charactersRefreshed.length} character(s)${corpMsg}`,
      charactersRefreshed: results.charactersRefreshed,
      corporationsFetched: results.corporationsFetched,
      errors: results.errors
    };
  } catch (error) {
    console.error('[Plans] Error refreshing plan ESI data:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Legacy function - refreshes active plans for a single character
 * @deprecated Use refreshPlanESIData(planId) instead
 */
async function refreshActivePlansESIData(characterId) {
  try {
    const db = getCharacterDatabase();

    // Get active plans for this character
    const activePlans = getManufacturingPlans(characterId, { status: 'active' });

    if (activePlans.length === 0) {
      return { success: true, message: 'No active plans to refresh', plansRefreshed: 0 };
    }

    // Refresh each active plan
    for (const plan of activePlans) {
      await refreshPlanESIData(plan.plan_id);
    }

    return {
      success: true,
      message: `Refreshed ${activePlans.length} active plan(s)`,
      plansRefreshed: activePlans.length,
    };
  } catch (error) {
    console.error('Error refreshing active plans ESI data:', error);
    return { success: false, message: error.message, plansRefreshed: 0 };
  }
}

/**
 * Get analytics for a plan - planned vs actual comparison
 * @param {string} planId - Plan ID
 * @returns {Object} Analytics data
 */
async function getPlanAnalytics(planId) {
  try {
    const db = getCharacterDatabase();
    const { getPlanActuals } = require('./plan-matching');

    // Get the plan
    const plan = db.prepare('SELECT * FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    // Get planned costs from summary
    const summary = await getPlanSummary(planId);

    // Get actuals from confirmed matches (includes time-based job progress)
    const actuals = getPlanActuals(planId);

    // Get total manufacturing lines for display
    const blueprints = db.prepare('SELECT lines FROM plan_blueprints WHERE plan_id = ?').all(planId);
    const totalJobs = blueprints.reduce((sum, bp) => sum + bp.lines, 0);

    // Use the time-based completion percentage from actuals
    const jobCompletionPercent = actuals.completionPercentage || 0;

    // For display purposes, show confirmed jobs count (actuals already has this)
    const jobsConfirmed = actuals.confirmedJobsCount || 0;

    // Calculate material purchase progress - total quantity of materials from nodes
    const materialsAgg = db.prepare(`
      SELECT SUM(quantity_needed) as total_quantity
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type = 'material'
    `).get(planId);
    const totalMaterialQuantity = materialsAgg?.total_quantity || 0;

    // Sum quantity of confirmed material purchases from transactions
    const materialsPurchasedResult = db.prepare(`
      SELECT SUM(quantity) as total_quantity
      FROM plan_transaction_matches
      WHERE plan_id = ? AND match_type = 'material_buy' AND status = 'confirmed'
    `).get(planId);

    const materialQuantityFromTransactions = materialsPurchasedResult?.total_quantity || 0;

    // Sum manually acquired materials from ledger
    const manualsAcquiredResult = db.prepare(`
      SELECT SUM(quantity) as total_quantity
      FROM plan_material_ledger
      WHERE plan_id = ?
    `).get(planId);

    const materialQuantityManuallyAcquired = Math.max(0, manualsAcquiredResult?.total_quantity || 0);

    // Total acquired = transactions + manually acquired
    const materialQuantityPurchased = materialQuantityFromTransactions + materialQuantityManuallyAcquired;
    const materialPurchasePercent = totalMaterialQuantity > 0 ? (materialQuantityPurchased / totalMaterialQuantity) * 100 : 0;

    console.log(`[Analytics] Material progress for plan ${planId}:`);
    console.log(`[Analytics]   From transactions: ${materialQuantityFromTransactions}`);
    console.log(`[Analytics]   Manually acquired: ${materialQuantityManuallyAcquired}`);
    console.log(`[Analytics]   Total acquired: ${materialQuantityPurchased}`);
    console.log(`[Analytics]   Total needed: ${totalMaterialQuantity}`);
    console.log(`[Analytics]   Progress: ${materialPurchasePercent.toFixed(2)}%`);

    // Calculate product sales progress - total quantity of FINAL products only (not intermediates)
    const products = db.prepare(`
      SELECT SUM(quantity_needed) as quantity
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type = 'product'
      GROUP BY type_id
    `).all(planId);
    const totalProductQuantity = products.reduce((sum, prod) => sum + prod.quantity, 0);

    // Sum quantity of confirmed product sales
    const productsSoldResult = db.prepare(`
      SELECT SUM(quantity) as total_quantity
      FROM plan_transaction_matches
      WHERE plan_id = ? AND match_type = 'product_sell' AND status = 'confirmed'
    `).get(planId);

    const productQuantitySold = productsSoldResult?.total_quantity || 0;
    const productSalesPercent = totalProductQuantity > 0 ? (productQuantitySold / totalProductQuantity) * 100 : 0;

    // Calculate cost/profit comparisons
    const plannedMaterialCost = summary.materialCost;
    const actualMaterialCost = actuals.actualMaterialCost;
    const materialCostDelta = actualMaterialCost - plannedMaterialCost;
    const materialCostDeltaPercent = plannedMaterialCost > 0 ? (materialCostDelta / plannedMaterialCost) * 100 : 0;

    const plannedProductValue = summary.productValue;
    const actualProductValue = actuals.actualProductSales;
    const productValueDelta = actualProductValue - plannedProductValue;
    const productValueDeltaPercent = plannedProductValue > 0 ? (productValueDelta / plannedProductValue) * 100 : 0;

    const plannedProfit = summary.estimatedProfit;
    const actualProfit = actualProductValue - actualMaterialCost;
    const profitDelta = actualProfit - plannedProfit;
    const profitDeltaPercent = plannedProfit !== 0 ? (profitDelta / Math.abs(plannedProfit)) * 100 : 0;

    return {
      // Progress metrics
      progress: {
        jobs: {
          completed: jobsConfirmed,
          total: totalJobs,
          percent: jobCompletionPercent,
        },
        materials: {
          purchased: materialQuantityPurchased,
          total: totalMaterialQuantity,
          percent: materialPurchasePercent,
        },
        products: {
          sold: productQuantitySold,
          total: totalProductQuantity,
          percent: productSalesPercent,
        },
        overall: actuals.completionPercentage || 0,
      },

      // Planned vs Actual - Material Costs
      materialCosts: {
        planned: plannedMaterialCost,
        actual: actualMaterialCost,
        delta: materialCostDelta,
        deltaPercent: materialCostDeltaPercent,
      },

      // Planned vs Actual - Product Value
      productValue: {
        planned: plannedProductValue,
        actual: actualProductValue,
        delta: productValueDelta,
        deltaPercent: productValueDeltaPercent,
      },

      // Planned vs Actual - Profit
      profit: {
        planned: plannedProfit,
        actual: actualProfit,
        delta: profitDelta,
        deltaPercent: profitDeltaPercent,
      },

      // Summary metrics
      summary: {
        plannedROI: summary.roi,
        actualROI: actualMaterialCost > 0 ? (actualProfit / actualMaterialCost) * 100 : 0,
      },
    };
  } catch (error) {
    console.error('Error getting plan analytics:', error);
    throw error;
  }
}

/**
 * Mark a material as manually acquired with optional custom price
 * @param {string} planId - Plan ID
 * @param {number} typeId - Material type ID
 * @param {object} options - Acquisition options
 * @param {number} options.quantity - Quantity to mark as acquired
 * @param {string} options.acquisitionMethod - Method of acquisition (e.g., 'owned', 'manufactured', 'gift', 'contract', 'other')
 * @param {number|null} options.customPrice - Custom price per unit (null to use base_price)
 * @param {string|null} options.acquisitionNote - Optional note about acquisition
 * @param {string} options.mode - Mode: 'add' (increment) or 'set' (replace total) - default 'set'
 * @param {boolean} options.validateAssets - Whether to validate against owned assets (default false)
 * @returns {object} Result with success, newTotal, hasExcess, excessAmount, and assetWarning
 */
async function markMaterialAcquired(planId, typeId, options = {}) {
  const {
    quantity,
    acquisitionMethod = 'other',
    customPrice = null,
    acquisitionNote = null,
    mode = 'set',
    validateAssets = false
  } = options;

  if (!quantity || quantity <= 0) {
    throw new Error('Quantity is required and must be greater than 0');
  }

  const db = getCharacterDatabase();

  try {
    // Check material exists in plan nodes
    const currentMaterial = db.prepare(`
      SELECT SUM(quantity_needed) as quantity_needed
      FROM plan_material_nodes
      WHERE plan_id = ? AND type_id = ? AND node_type = 'material'
    `).get(planId, typeId);

    if (!currentMaterial || currentMaterial.quantity_needed === null) {
      throw new Error('Material not found in plan');
    }

    // Get current ledger net for this type
    const currentLedger = db.prepare(`
      SELECT SUM(quantity) as net_acquired
      FROM plan_material_ledger
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeId);

    const currentAcquiredQty = currentLedger?.net_acquired || 0;

    // Calculate new total based on mode
    let newTotal;
    if (mode === 'add') {
      newTotal = currentAcquiredQty + quantity;
    } else {
      newTotal = quantity;
    }

    if (newTotal < 0) {
      throw new Error('Quantity cannot be negative');
    }

    const hasExcess = newTotal > currentMaterial.quantity_needed;

    // Asset validation
    let assetWarning = null;
    if (acquisitionMethod === 'owned' && validateAssets) {
      const materials = await getPlanMaterials(planId, true);
      const material = materials.find(m => m.typeId === typeId);
      if (material) {
        const totalOwned = (material.ownedPersonal || 0) + (material.ownedCorp || 0);
        if (newTotal > totalOwned) {
          assetWarning = { requested: newTotal, available: totalOwned, shortfall: newTotal - totalOwned };
        }
      }
    }

    const now = Date.now();
    const method = ['manual','purchased','manufactured','allocated'].includes(acquisitionMethod)
      ? acquisitionMethod : 'manual';

    // Insert ledger entry
    // If mode='set', first insert a deduct entry to zero out current, then acquire
    if (mode === 'set' && currentAcquiredQty !== 0) {
      db.prepare(`
        INSERT INTO plan_material_ledger
          (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
        VALUES (?, ?, ?, 'adjusted', ?, ?, ?, ?, NULL, ?)
      `).run(randomUUID(), planId, typeId, -currentAcquiredQty, method, customPrice, acquisitionNote, now);
    }

    db.prepare(`
      INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
      VALUES (?, ?, ?, 'acquired', ?, ?, ?, ?, NULL, ?)
    `).run(randomUUID(), planId, typeId, newTotal, method, customPrice, acquisitionNote, now);

    console.log(`[Plans] Marked ${newTotal} units of material ${typeId} as acquired for plan ${planId} (mode: ${mode})`);

    return {
      success: true,
      newTotal,
      hasExcess,
      excessAmount: hasExcess ? newTotal - currentMaterial.quantity_needed : 0,
      assetWarning
    };
  } catch (error) {
    console.error('[Plans] Error marking material as acquired:', error);
    throw error;
  }
}

/**
 * Unmark a material as manually acquired (remove manual acquisition record)
 * @param {string} planId - Plan ID
 * @param {number} typeId - Material type ID
 * @returns {object} Result with success message
 */
function unmarkMaterialAcquired(planId, typeId) {
  const db = getCharacterDatabase();

  try {
    // Get current net from ledger
    const currentLedger = db.prepare(`
      SELECT SUM(quantity) as net_acquired
      FROM plan_material_ledger
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeId);

    const netAcquired = currentLedger?.net_acquired || 0;

    if (netAcquired === 0) {
      return { success: true, message: 'No acquisition to remove' };
    }

    // Insert deducted entry to zero out
    db.prepare(`
      INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
      VALUES (?, ?, ?, 'deducted', ?, 'manual', NULL, 'User unmarked acquisition', NULL, ?)
    `).run(randomUUID(), planId, typeId, -netAcquired, Date.now());

    console.log(`[Plans] Unmarked material ${typeId} as acquired for plan ${planId}`);
    return { success: true };
  } catch (error) {
    console.error('[Plans] Error unmarking material as acquired:', error);
    throw error;
  }
}

/**
 * Update material acquisition details (quantity and/or custom price)
 * @param {string} planId - Plan ID
 * @param {number} typeId - Material type ID
 * @param {object} updates - Updates to apply
 * @param {number|null} updates.quantity - Updated quantity (optional)
 * @param {number|null} updates.customPrice - Updated custom price (optional)
 */
function updateMaterialAcquisition(planId, typeId, updates = {}) {
  const { quantity = null, customPrice = null } = updates;
  const db = getCharacterDatabase();

  try {
    if (quantity !== null) {
      markMaterialAcquired(planId, typeId, {
        quantity,
        customPrice,
        mode: 'set'
      });
    } else if (customPrice !== null) {
      // Update the most recent non-manufactured ledger entry's unit_price
      db.prepare(`
        UPDATE plan_material_ledger
        SET unit_price = ?
        WHERE ledger_id = (
          SELECT ledger_id FROM plan_material_ledger
          WHERE plan_id = ? AND type_id = ? AND method != 'manufactured'
          ORDER BY created_at DESC LIMIT 1
        )
      `).run(customPrice, planId, typeId);
    }

    console.log(`[Plans] Updated acquisition for material ${typeId} in plan ${planId}`);
  } catch (error) {
    console.error('[Plans] Error updating material acquisition:', error);
    throw error;
  }
}

/**
 * Update custom price for a material
 * @param {string} planId - Plan ID
 * @param {number} typeId - Material type ID
 * @param {number|null} customPrice - Custom price (null to use base_price)
 */
function updateMaterialCustomPrice(planId, typeId, customPrice) {
  const db = getCharacterDatabase();

  try {
    const result = db.prepare(`
      UPDATE plan_material_ledger
      SET unit_price = ?
      WHERE ledger_id = (
        SELECT ledger_id FROM plan_material_ledger
        WHERE plan_id = ? AND type_id = ? AND method != 'manufactured'
        ORDER BY created_at DESC LIMIT 1
      )
    `).run(customPrice, planId, typeId);

    if (result.changes === 0) {
      console.log(`[Plans] No ledger entry found to update custom price for material ${typeId}`);
    } else {
      console.log(`[Plans] Updated custom price for material ${typeId} in plan ${planId}`);
    }
  } catch (error) {
    console.error('[Plans] Error updating material custom price:', error);
    throw error;
  }
}

/**
 * Cleanup excess acquisitions (reduce to match needed quantity)
 * @param {string} planId - Plan ID
 * @param {number|null} typeId - Material type ID (null for all materials)
 * @returns {object} Result with number of adjustments made
 */
function cleanupExcessAcquisitions(planId, typeId = null) {
  const db = getCharacterDatabase();

  try {
    // Find types where ledger net > node quantity_needed
    let query = `
      SELECT pmn.type_id,
             SUM(pmn.quantity_needed) as needed,
             SUM(pml.quantity) as net_acquired
      FROM plan_material_nodes pmn
      LEFT JOIN plan_material_ledger pml
        ON pmn.plan_id = pml.plan_id AND pmn.type_id = pml.type_id
      WHERE pmn.plan_id = ? AND pmn.node_type = 'material'
      GROUP BY pmn.type_id
      HAVING net_acquired > needed
    `;

    const params = [planId];
    if (typeId) {
      query = query.replace('WHERE pmn.plan_id = ?', 'WHERE pmn.plan_id = ? AND pmn.type_id = ?');
      params.push(typeId);
    }

    const excessMaterials = db.prepare(query).all(...params);

    if (excessMaterials.length === 0) {
      return { success: true, adjusted: 0 };
    }

    const now = Date.now();
    const insertLedger = db.prepare(`
      INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note, source_ref, created_at)
      VALUES (?, ?, ?, 'deducted', ?, 'manual', NULL, 'Excess cleanup', NULL, ?)
    `);

    for (const m of excessMaterials) {
      const excess = m.net_acquired - m.needed;
      insertLedger.run(randomUUID(), planId, m.type_id, -excess, now);
    }

    console.log(`[Plans] Cleaned up ${excessMaterials.length} excess acquisitions for plan ${planId}`);
    return { success: true, adjusted: excessMaterials.length };
  } catch (error) {
    console.error('[Plans] Error cleaning up excess acquisitions:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get acquisition log for a material or plan
 * @param {string} planId - Plan ID
 * @param {number|null} typeId - Material type ID (null for all materials in plan)
 * @returns {Array} Array of log entries
 */
function getAcquisitionLog(planId, typeId = null) {
  const db = getCharacterDatabase();

  try {
    let query = `
      SELECT
        type_id,
        created_at as timestamp,
        event_type as action,
        quantity,
        method as acquisition_method,
        unit_price as custom_price,
        note
      FROM plan_material_ledger
      WHERE plan_id = ?
    `;

    const params = [planId];
    if (typeId) {
      query += ' AND type_id = ?';
      params.push(typeId);
    }

    query += ' ORDER BY created_at DESC LIMIT 100';

    const logEntries = db.prepare(query).all(...params);

    return logEntries.map(entry => ({
      typeId: entry.type_id,
      typeName: getTypeName(entry.type_id),
      timestamp: entry.timestamp,
      timestampFormatted: new Date(entry.timestamp).toLocaleString(),
      action: entry.action,
      quantityBefore: null,
      quantityAfter: null,
      quantityChange: entry.quantity,
      acquisitionMethod: entry.acquisition_method,
      customPrice: entry.custom_price,
      note: entry.note,
      performedBy: 'user'
    }));
  } catch (error) {
    console.error('[Plans] Error getting acquisition log:', error);
    throw error;
  }
}

/**
 * Get the material tree for a plan, optionally filtered by blueprint
 * @param {string} planId - Plan ID
 * @param {string|null} planBlueprintId - Optional: filter to specific blueprint subtree
 * @returns {Array} Array of root nodes with children recursively attached
 */
async function getMaterialTree(planId, planBlueprintId = null) {
  try {
    const db = getCharacterDatabase();

    // Query nodes
    let query = 'SELECT * FROM plan_material_nodes WHERE plan_id = ?';
    const params = [planId];
    if (planBlueprintId) {
      query += ' AND plan_blueprint_id = ?';
      params.push(planBlueprintId);
    }
    query += ' ORDER BY depth, node_id';

    const nodes = db.prepare(query).all(...params);

    if (nodes.length === 0) {
      return [];
    }

    // Batch fetch type names from SDE
    const typeIds = [...new Set(nodes.map(n => n.type_id))];
    const typeNames = {};

    try {
      const sdePath = getSdePath();
      const sdeDb = new Database(sdePath, { readonly: true });
      try {
        const placeholders = typeIds.map(() => '?').join(',');
        const types = sdeDb.prepare(`
          SELECT typeID, typeName FROM invTypes WHERE typeID IN (${placeholders})
        `).all(...typeIds);
        for (const t of types) {
          typeNames[t.typeID] = t.typeName;
        }
      } finally {
        sdeDb.close();
      }
    } catch (error) {
      console.error('[Plans] Error fetching type names for material tree:', error);
    }

    // Get ledger net acquired per type
    const ledgerEntries = db.prepare(`
      SELECT type_id, SUM(quantity) as net_acquired
      FROM plan_material_ledger
      WHERE plan_id = ?
      GROUP BY type_id
    `).all(planId);
    const ledgerMap = new Map(ledgerEntries.map(l => [l.type_id, l.net_acquired]));

    // Build node map and tree structure
    const nodeMap = new Map();
    for (const node of nodes) {
      nodeMap.set(node.node_id, {
        nodeId: node.node_id,
        typeId: node.type_id,
        typeName: typeNames[node.type_id] || `Type ${node.type_id}`,
        nodeType: node.node_type,
        depth: node.depth,
        quantityNeeded: node.quantity_needed,
        quantityPerRun: node.quantity_per_run,
        runsNeeded: node.runs_needed,
        meLevel: node.me_level,
        isReaction: node.is_reaction === 1,
        buildPlan: node.build_plan,
        priceEach: node.price_each,
        sourcePlanBlueprintId: node.source_plan_blueprint_id,
        acquiredQuantity: ledgerMap.get(node.type_id) || 0,
        children: []
      });
    }

    // Attach children to parents
    const roots = [];
    for (const node of nodes) {
      const nodeObj = nodeMap.get(node.node_id);
      if (node.parent_node_id && nodeMap.has(node.parent_node_id)) {
        nodeMap.get(node.parent_node_id).children.push(nodeObj);
      } else {
        roots.push(nodeObj);
      }
    }

    return roots;
  } catch (error) {
    console.error('[Plans] Error getting material tree:', error);
    return [];
  }
}

// ============================================================================
// REACTION CRUD OPERATIONS
// ============================================================================

/**
 * Get all reactions for a manufacturing plan
 * @param {string} planId - Plan ID
 * @returns {Array} Array of reactions with details
 */
function getReactions(planId) {
  try {
    const db = getCharacterDatabase();

    const reactions = db.prepare(`
      SELECT
        plan_blueprint_id as planBlueprintId,
        plan_id as planId,
        parent_blueprint_id as parentBlueprintId,
        blueprint_type_id as reactionTypeId,
        reaction_type_id,
        runs,
        lines,
        facility_id as facilityId,
        facility_snapshot as facilitySnapshot,
        is_intermediate as isIntermediate,
        is_built as isBuilt,
        built_runs as builtRuns,
        intermediate_product_type_id as intermediateProductTypeId,
        use_intermediates as useIntermediates,
        added_at as addedAt
      FROM plan_blueprints
      WHERE plan_id = ? AND blueprint_type = 'reaction'
      ORDER BY runs DESC, added_at ASC
    `).all(planId);

    return reactions.map(r => ({
      ...r,
      facilitySnapshot: r.facilitySnapshot ? JSON.parse(r.facilitySnapshot) : null,
      isIntermediate: Boolean(r.isIntermediate),
      isBuilt: Boolean(r.isBuilt)
    }));
  } catch (error) {
    console.error('Error getting reactions:', error);
    throw error;
  }
}

/**
 * Mark a reaction as built/acquired
 * @param {string} planBlueprintId - Plan blueprint ID (reaction)
 * @param {number} builtRuns - Number of runs completed (0 to unmark)
 * @returns {Promise<boolean>} Success status
 */
async function markReactionBuilt(planBlueprintId, builtRuns) {
  try {
    const db = getCharacterDatabase();

    // Get reaction details
    const reaction = db.prepare(`
      SELECT pb.*, mp.character_id
      FROM plan_blueprints pb
      JOIN manufacturing_plans mp ON pb.plan_id = mp.plan_id
      WHERE pb.plan_blueprint_id = ?
    `).get(planBlueprintId);

    if (!reaction) {
      throw new Error('Reaction not found');
    }

    if (reaction.blueprint_type !== 'reaction') {
      throw new Error('This blueprint is not a reaction');
    }

    // Update built status
    const isBuilt = builtRuns > 0;
    db.prepare(`
      UPDATE plan_blueprints
      SET is_built = ?, built_runs = ?
      WHERE plan_blueprint_id = ?
    `).run(isBuilt ? 1 : 0, builtRuns, planBlueprintId);

    console.log(`[Plans] Marked reaction ${planBlueprintId} as ${isBuilt ? 'built' : 'not built'} (${builtRuns} runs)`);

    // Recalculate manufactured materials
    // This will mark reaction base materials as acquired based on built runs
    await recalculateManufacturedMaterials(reaction.plan_id);

    return true;
  } catch (error) {
    console.error('Error marking reaction built:', error);
    throw error;
  }
}

/**
 * Get owned assets for a specific product type across all plan characters
 * Used by the Mark Built modal to show how many of an item the user has
 * @param {string} planId - Plan ID
 * @param {number} typeId - Type ID of the product to check
 * @returns {Object} Object with ownedPersonal, ownedCorp, and detail arrays
 */
function getProductOwnedAssets(planId, typeId) {
  try {
    const db = getCharacterDatabase();

    // Get plan to find character ID
    const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      return { ownedPersonal: 0, ownedCorp: 0, personalDetails: [], corpDetails: [] };
    }

    // Get plan industry settings for character selection
    const planSettings = getPlanIndustrySettings(planId);

    // Determine which characters to use
    let characterIds = planSettings.defaultCharacters || [];
    if (characterIds.length === 0) {
      // Fallback: use plan's default character only
      characterIds = [plan.character_id];
    }

    // Get enabled divisions per character
    const enabledDivisions = planSettings.enabledDivisions || {};

    // Aggregate assets across all selected characters
    let totalPersonal = 0;
    let totalCorp = 0;
    const personalDetails = [];
    const corpDetails = [];
    const processedCorps = new Set();

    for (const characterId of characterIds) {
      // Get character info
      const { getCharacter } = require('./settings-manager');
      const character = getCharacter(characterId);

      if (!character) {
        console.warn(`[Plans] Character ${characterId} not found, skipping assets`);
        continue;
      }

      // Fetch personal assets for this character, filter by typeId
      const personalAssets = getAssets(characterId, false).filter(a => a.typeId === typeId);
      let charTotal = 0;
      for (const asset of personalAssets) {
        charTotal += asset.quantity;
      }
      if (charTotal > 0) {
        totalPersonal += charTotal;
        personalDetails.push({
          characterId: characterId,
          characterName: character.characterName,
          quantity: charTotal
        });
      }

      // Fetch corporation assets (with division filtering and deduplication)
      const corpId = character.corporationId;
      if (corpId && !processedCorps.has(corpId)) {
        processedCorps.add(corpId);

        // Get enabled divisions for this character
        const charEnabledDivisions = enabledDivisions[characterId] || [];

        // Fetch all corp assets for this character, filter by typeId
        const corpAssets = getAssets(characterId, true).filter(a => a.typeId === typeId);

        // Group by division - only include assets in enabled divisions
        const divisionTotals = {};
        for (const asset of corpAssets) {
          if (isAssetInEnabledDivision(asset, charEnabledDivisions)) {
            const divisionId = extractDivisionId(asset.locationFlag);
            if (divisionId) {
              if (!divisionTotals[divisionId]) {
                divisionTotals[divisionId] = 0;
              }
              divisionTotals[divisionId] += asset.quantity;
            }
          }
        }

        // Add to details
        for (const [divKey, qty] of Object.entries(divisionTotals)) {
          if (qty > 0) {
            totalCorp += qty;
            const divisionId = parseInt(divKey, 10);
            corpDetails.push({
              corporationId: corpId,
              corporationName: character.corporationName || `Corporation ${corpId}`,
              divisionId: divisionId,
              divisionName: getDivisionName(characterId, divisionId),
              quantity: qty
            });
          }
        }
      }
    }

    return {
      ownedPersonal: totalPersonal,
      ownedCorp: totalCorp,
      personalDetails: personalDetails,
      corpDetails: corpDetails
    };
  } catch (error) {
    console.error('Error getting product owned assets:', error);
    return { ownedPersonal: 0, ownedCorp: 0, personalDetails: [], corpDetails: [] };
  }
}

module.exports = {
  createManufacturingPlan,
  getManufacturingPlan,
  getManufacturingPlans,
  updateManufacturingPlan,
  deleteManufacturingPlan,
  getPlanIndustrySettings,
  updatePlanIndustrySettings,
  updatePlanCharacterDivisions,
  addBlueprintToPlan,
  updatePlanBlueprint,
  bulkUpdateBlueprints,
  removeBlueprintFromPlan,
  getPlanBlueprints,
  getIntermediateBlueprints,
  getAllPlanIntermediates,
  updateIntermediateBlueprint,
  markIntermediateBuilt,
  deleteOrphanedIntermediates,
  recalculatePlanMaterials,
  getPlanMaterials,
  getPlanProducts,
  getPlanSummary,
  refreshActivePlansESIData,
  refreshPlanESIData,
  getPlanAnalytics,
  markMaterialAcquired,
  unmarkMaterialAcquired,
  updateMaterialAcquisition,
  updateMaterialCustomPrice,
  cleanupExcessAcquisitions,
  getAcquisitionLog,
  getReactions,
  markReactionBuilt,
  getProductOwnedAssets,
  getMaterialTree,
};
