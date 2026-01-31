const { getCharacterDatabase } = require('./character-database');
const { calculateBlueprintMaterials, getBlueprintProduct, getBlueprintForProduct, getOwnedBlueprintME } = require('./blueprint-calculator');
const { calculateReactionMaterials, getReactionProduct, getReactionForProduct, getReactionMaterials } = require('./reaction-calculator');
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
 * @returns {number} Number of materials cleared
 */
function clearManufacturedAcquisitions(planId) {
  const db = getCharacterDatabase();

  // Get count for logging (check both old and new tables)
  const oldCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM plan_materials
    WHERE plan_id = ? AND acquisition_method = 'manufactured'
  `).get(planId).count;

  const newCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM plan_material_manual_acquisitions
    WHERE plan_id = ? AND acquisition_method = 'manufactured'
  `).get(planId).count;

  if (oldCount === 0 && newCount === 0) {
    console.log(`[Plans] No 'manufactured' acquisitions to clear for plan ${planId}`);
    return 0;
  }

  console.log(`[Plans] Clearing 'manufactured' acquisitions for ${oldCount} material(s) in old table, ${newCount} in new table`);

  // Log to acquisition log BEFORE deleting
  if (newCount > 0) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO plan_material_acquisition_log
        (plan_id, type_id, timestamp, action, quantity_before, quantity_after, performed_by)
      SELECT plan_id, type_id, ?, 'remove', quantity, 0, 'system'
      FROM plan_material_manual_acquisitions
      WHERE plan_id = ? AND acquisition_method = 'manufactured'
    `).run(now, planId);
  }

  // Clear 'manufactured' acquisition data from old plan_materials columns
  db.prepare(`
    UPDATE plan_materials
    SET manually_acquired_quantity = 0,
        manually_acquired = 0,
        acquisition_method = NULL,
        acquisition_note = NULL
    WHERE plan_id = ? AND acquisition_method = 'manufactured'
  `).run(planId);

  // Delete 'manufactured' acquisitions from new table
  db.prepare(`
    DELETE FROM plan_material_manual_acquisitions
    WHERE plan_id = ? AND acquisition_method = 'manufactured'
  `).run(planId);

  return oldCount + newCount;
}

/**
 * Recalculate manufactured material acquisitions from all built intermediates and reactions
 * This function accumulates materials from ALL intermediates and reactions with built_runs > 0
 * @param {string} planId - Plan ID
 * @param {number} characterId - Character ID for skill/blueprint calculations
 */
async function recalculateManufacturedMaterials(planId, characterId) {
  const db = getCharacterDatabase();

  // Get all intermediate blueprints with built_runs > 0
  const builtIntermediates = db.prepare(`
    SELECT plan_blueprint_id, blueprint_type_id, runs, built_runs, me_level, facility_snapshot, use_intermediates
    FROM plan_blueprints
    WHERE plan_id = ? AND is_intermediate = 1 AND built_runs > 0
    ORDER BY plan_blueprint_id
  `).all(planId);

  // Get all built reactions with built_runs > 0
  const builtReactions = db.prepare(`
    SELECT plan_blueprint_id, reaction_type_id, runs, built_runs, facility_snapshot
    FROM plan_blueprints
    WHERE plan_id = ? AND blueprint_type = 'reaction' AND built_runs > 0
    ORDER BY plan_blueprint_id
  `).all(planId);

  if (builtIntermediates.length === 0 && builtReactions.length === 0) {
    console.log(`[Plans] No built intermediates or reactions for plan ${planId}`);
    return;
  }

  console.log(`[Plans] Recalculating manufactured materials for ${builtIntermediates.length} built intermediate(s) and ${builtReactions.length} built reaction(s)`);

  // Accumulator for all manufactured materials across ALL intermediates and reactions
  const totalManufacturedMaterials = {};

  // Calculate materials for each built intermediate
  for (const intermediate of builtIntermediates) {
    const facilitySnapshot = intermediate.facility_snapshot ?
      JSON.parse(intermediate.facility_snapshot) : null;

    // Determine how to expand materials based on blueprint's use_intermediates setting
    // This ensures that if an intermediate is configured to expand to raw materials,
    // and it has sub-intermediates, those sub-materials are also marked as acquired
    const useIntermediates = intermediate.use_intermediates || 'raw_materials';
    const shouldExpandToRaw = (useIntermediates === 'raw_materials' || useIntermediates === 'build_buy');

    // Calculate materials for the FULL built_runs quantity
    // Important: Must calculate for full runs, not multiply single-run materials,
    // because ME reductions and rounding happen per-run in Eve Online
    const calculation = await calculateBlueprintMaterials(
      intermediate.blueprint_type_id,
      intermediate.built_runs, // Calculate for actual built runs
      intermediate.me_level || 0,
      characterId,
      facilitySnapshot,
      shouldExpandToRaw // Expand based on blueprint's configuration
    );

    console.log(`  - Intermediate ${intermediate.blueprint_type_id}: ${intermediate.built_runs}/${intermediate.runs} runs built (mode: ${useIntermediates}, expand: ${shouldExpandToRaw})`);

    // Extract materials from the calculation result
    const materials = calculation.materials || {};

    // Accumulate materials across all built intermediates
    for (const [typeId, quantity] of Object.entries(materials)) {
      const typeIdInt = parseInt(typeId);

      if (isNaN(typeIdInt)) {
        console.warn(`    WARNING: Invalid material typeId '${typeId}' in blueprint ${intermediate.blueprint_type_id} - skipping`);
        continue;
      }

      totalManufacturedMaterials[typeIdInt] =
        (totalManufacturedMaterials[typeIdInt] || 0) + quantity;

      console.log(`    - Material ${typeIdInt}: ${quantity} total for ${intermediate.built_runs} runs`);
    }
  }

  // Calculate materials for each built reaction
  const { calculateReactionMaterials } = require('./reaction-calculator');

  for (const reaction of builtReactions) {
    const facilitySnapshot = reaction.facility_snapshot ?
      JSON.parse(reaction.facility_snapshot) : null;

    // Calculate materials for the FULL built_runs quantity
    const calculation = await calculateReactionMaterials(
      reaction.reaction_type_id,
      reaction.built_runs, // Calculate for actual built runs
      characterId,
      facilitySnapshot
    );

    console.log(`  - Reaction ${reaction.reaction_type_id}: ${reaction.built_runs}/${reaction.runs} runs built`);

    // Extract materials from the calculation result
    const materials = calculation.materials || {};

    // Accumulate materials across all built reactions
    for (const [typeId, quantity] of Object.entries(materials)) {
      const typeIdInt = parseInt(typeId);

      if (isNaN(typeIdInt)) {
        console.warn(`    WARNING: Invalid material typeId '${typeId}' in reaction ${reaction.reaction_type_id} - skipping`);
        continue;
      }

      totalManufacturedMaterials[typeIdInt] =
        (totalManufacturedMaterials[typeIdInt] || 0) + quantity;

      console.log(`    - Material ${typeIdInt}: ${quantity} total for ${reaction.built_runs} runs`);
    }
  }

  console.log(`[Plans] Updating ${Object.keys(totalManufacturedMaterials).length} material(s) as manufactured`);

  // Update plan_materials with accumulated manufactured quantities
  for (const [typeId, manufacturedQty] of Object.entries(totalManufacturedMaterials)) {
    // Convert typeId to integer (Object.entries returns string keys)
    const typeIdInt = parseInt(typeId);

    if (isNaN(typeIdInt)) {
      console.warn(`  - Invalid typeId ${typeId} - skipping`);
      continue;
    }

    // Get current material record
    const existing = db.prepare(`
      SELECT manually_acquired_quantity, acquisition_method
      FROM plan_materials
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeIdInt);

    if (!existing) {
      // Material doesn't exist - shouldn't happen after recalculatePlanMaterials
      console.warn(`  - Material ${typeIdInt} not found in plan_materials - skipping`);
      continue;
    }

    // Get quantity from non-manufactured sources
    // (should be 0 since we just cleared manufactured, but handle edge cases)
    const nonManufacturedQty = existing.acquisition_method === 'manufactured' ?
      0 : (existing.manually_acquired_quantity || 0);

    const totalAcquired = nonManufacturedQty + manufacturedQty;

    // Determine final acquisition method
    let finalMethod;
    let finalNote;

    if (nonManufacturedQty > 0 && manufacturedQty > 0) {
      // Mixed sources
      finalMethod = 'mixed';
      finalNote = `Manufactured: ${manufacturedQty}, ${existing.acquisition_method}: ${nonManufacturedQty}`;
    } else if (manufacturedQty > 0) {
      // Only manufactured
      finalMethod = 'manufactured';
      finalNote = 'Auto-acquired from built components (intermediates/reactions)';
    } else {
      // Only other source (preserve existing)
      finalMethod = existing.acquisition_method;
      finalNote = existing.acquisition_note;
    }

    // Update material with manufactured acquisition (old table for backward compat)
    db.prepare(`
      UPDATE plan_materials
      SET manually_acquired = ?,
          manually_acquired_quantity = ?,
          acquisition_method = ?,
          acquisition_note = ?
      WHERE plan_id = ? AND type_id = ?
    `).run(
      totalAcquired > 0 ? 1 : 0,
      totalAcquired,
      finalMethod,
      finalNote,
      planId,
      typeIdInt
    );

    // Insert/update in new plan_material_manual_acquisitions table
    const now = Date.now();
    db.prepare(`
      INSERT INTO plan_material_manual_acquisitions
        (plan_id, type_id, quantity, acquisition_method, custom_price, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(plan_id, type_id) DO UPDATE SET
        quantity = excluded.quantity,
        acquisition_method = excluded.acquisition_method,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run(planId, typeIdInt, manufacturedQty, 'manufactured', finalNote, now, now);

    // Log the acquisition
    db.prepare(`
      INSERT INTO plan_material_acquisition_log
        (plan_id, type_id, timestamp, action, quantity_before, quantity_after,
         acquisition_method, custom_price, note, performed_by)
      VALUES (?, ?, ?, 'set', 0, ?, 'manufactured', NULL, ?, 'system')
    `).run(planId, typeIdInt, now, manufacturedQty, finalNote);

    console.log(`  - Material ${typeIdInt}: manufactured=${manufacturedQty}, other=${nonManufacturedQty}, total=${totalAcquired}`);
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

    // CRITICAL CHANGE: Clear ALL 'manufactured' acquisitions for the entire plan
    // This ensures we recalculate from scratch based on current blueprint configs
    clearManufacturedAcquisitions(intermediate.plan_id);

    // Recalculate ALL manufactured materials from ALL built intermediates
    // This handles multiple intermediates producing the same material correctly
    await recalculateManufacturedMaterials(intermediate.plan_id, intermediate.character_id);

    // Recalculate plan materials to ensure overall consistency
    // This will preserve non-'manufactured' acquisitions (manual, purchased, etc.)
    await recalculatePlanMaterials(intermediate.plan_id, false);

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
 * Mark all materials needed for a built intermediate as acquired (manufactured)
 * @param {string} intermediateBlueprintId - Intermediate blueprint ID
 * @param {string} planId - Plan ID
 * @param {number} characterId - Character ID
 */
async function markIntermediateMaterialsAsAcquired(intermediateBlueprintId, planId, characterId) {
  try {
    const db = getCharacterDatabase();

    // Get the intermediate blueprint details
    const intermediate = db.prepare('SELECT * FROM plan_blueprints WHERE plan_blueprint_id = ?').get(intermediateBlueprintId);
    if (!intermediate || intermediate.is_intermediate !== 1) {
      throw new Error('Intermediate blueprint not found');
    }

    // Calculate raw materials for this built intermediate
    const facilitySnapshot = intermediate.facility_snapshot ? JSON.parse(intermediate.facility_snapshot) : null;

    const calculation = await calculateBlueprintMaterials(
      intermediate.blueprint_type_id,
      intermediate.runs,
      intermediate.me_level,
      characterId,
      facilitySnapshot,
      false  // Don't break down further - we want raw materials
    );

    console.log(`[Plans] Marking ${Object.keys(calculation.materials).length} materials as acquired (manufactured) for intermediate ${intermediate.blueprint_type_id}`);

    // Mark each material as acquired with method 'manufactured'
    for (const [typeId, quantity] of Object.entries(calculation.materials)) {
      const typeIdInt = parseInt(typeId);

      // Check if this material already exists in plan_materials
      const existingMaterial = db.prepare(`
        SELECT manually_acquired_quantity FROM plan_materials
        WHERE plan_id = ? AND type_id = ?
      `).get(planId, typeIdInt);

      if (existingMaterial) {
        // Material exists - add to existing acquisition quantity
        const currentAcquired = existingMaterial.manually_acquired_quantity || 0;
        const newTotal = currentAcquired + quantity;

        db.prepare(`
          UPDATE plan_materials
          SET manually_acquired = 1,
              manually_acquired_quantity = ?,
              acquisition_method = 'manufactured'
          WHERE plan_id = ? AND type_id = ?
        `).run(newTotal, planId, typeIdInt);

        console.log(`  - Material ${typeId}: added ${quantity} to existing ${currentAcquired} (total: ${newTotal})`);
      } else {
        // Material doesn't exist yet - this shouldn't normally happen since
        // recalculatePlanMaterials should have already created the entry,
        // but we'll handle it gracefully
        console.warn(`  - Material ${typeId} not found in plan_materials - this is unexpected`);
      }
    }

    // Recursively mark materials for child intermediates
    const childIntermediates = db.prepare(`
      SELECT plan_blueprint_id FROM plan_blueprints
      WHERE parent_blueprint_id = ? AND is_intermediate = 1
    `).all(intermediateBlueprintId);

    for (const child of childIntermediates) {
      await markIntermediateMaterialsAsAcquired(child.plan_blueprint_id, planId, characterId);
    }

  } catch (error) {
    console.error('Error marking intermediate materials as acquired:', error);
    throw error;
  }
}

/**
 * Unmark materials that were acquired through a built intermediate
 * @param {string} intermediateBlueprintId - Intermediate blueprint ID
 * @param {string} planId - Plan ID
 */
async function unmarkIntermediateMaterialsAsAcquired(intermediateBlueprintId, planId) {
  try {
    const db = getCharacterDatabase();

    // Get the intermediate blueprint details
    const intermediate = db.prepare('SELECT * FROM plan_blueprints WHERE plan_blueprint_id = ?').get(intermediateBlueprintId);
    if (!intermediate || intermediate.is_intermediate !== 1) {
      throw new Error('Intermediate blueprint not found');
    }

    // Calculate raw materials for this intermediate (same as when marking)
    const facilitySnapshot = intermediate.facility_snapshot ? JSON.parse(intermediate.facility_snapshot) : null;

    // We need character_id but it's not in the intermediate record, get from plan
    const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);

    const calculation = await calculateBlueprintMaterials(
      intermediate.blueprint_type_id,
      intermediate.runs,
      intermediate.me_level,
      plan.character_id,
      facilitySnapshot,
      false
    );

    console.log(`[Plans] Unmarking ${Object.keys(calculation.materials).length} materials from intermediate ${intermediate.blueprint_type_id}`);

    // Unmark each material
    for (const [typeId, quantity] of Object.entries(calculation.materials)) {
      const typeIdInt = parseInt(typeId);

      const existingMaterial = db.prepare(`
        SELECT manually_acquired_quantity FROM plan_materials
        WHERE plan_id = ? AND type_id = ?
      `).get(planId, typeIdInt);

      if (existingMaterial && existingMaterial.manually_acquired_quantity > 0) {
        const currentAcquired = existingMaterial.manually_acquired_quantity;
        const newTotal = Math.max(0, currentAcquired - quantity);

        if (newTotal === 0) {
          // No more manual acquisitions - clear the flags
          db.prepare(`
            UPDATE plan_materials
            SET manually_acquired = 0,
                manually_acquired_quantity = 0,
                acquisition_method = NULL
            WHERE plan_id = ? AND type_id = ?
          `).run(planId, typeIdInt);
        } else {
          // Still have some manual acquisitions remaining
          db.prepare(`
            UPDATE plan_materials
            SET manually_acquired_quantity = ?
            WHERE plan_id = ? AND type_id = ?
          `).run(newTotal, planId, typeIdInt);
        }

        console.log(`  - Material ${typeId}: removed ${quantity} from ${currentAcquired} (remaining: ${newTotal})`);
      }
    }

    // Recursively unmark materials for child intermediates
    const childIntermediates = db.prepare(`
      SELECT plan_blueprint_id FROM plan_blueprints
      WHERE parent_blueprint_id = ? AND is_intermediate = 1
    `).all(intermediateBlueprintId);

    for (const child of childIntermediates) {
      await unmarkIntermediateMaterialsAsAcquired(child.plan_blueprint_id, planId);
    }

  } catch (error) {
    console.error('Error unmarking intermediate materials:', error);
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
    const { intermediates, rawMaterials } = await classifyMaterials(calculation.materials);

    // Process each sub-intermediate
    for (const intermediate of intermediates) {
      const subBlueprintId = intermediate.blueprintTypeId;
      const materialTypeId = intermediate.typeId;
      const materialQuantity = intermediate.quantity;
      const subProduct = intermediate.product;

      // Calculate runs needed using helper function (no production lines for intermediates)
      const subRunsNeeded = calculateIntermediateRuns(materialQuantity, subBlueprintId, 1);
      const unitsPerRun = subProduct ? subProduct.quantity : 1;

      console.log(`[Plans] Sub-intermediate ${subBlueprintId}: need ${materialQuantity} units @ ${unitsPerRun} per run = ${subRunsNeeded} runs (depth ${depth + 1})`);

      // Look up config in plan_blueprints for this sub-intermediate
      // Filter by parent_blueprint_id to get the correct child intermediate instance
      const db = getCharacterDatabase();
      const subConfig = db.prepare(`
        SELECT plan_blueprint_id, me_level, te_level, facility_snapshot, use_intermediates, runs
        FROM plan_blueprints
        WHERE plan_id = ? AND blueprint_type_id = ? AND parent_blueprint_id = ? AND is_intermediate = 1
        LIMIT 1
      `).get(planId, subBlueprintId, parentBlueprintId);

      // Recursively expand with RUNS, not units
      const subExpansion = await expandIntermediate(
        subBlueprintId,
        subRunsNeeded,  // Pass calculated runs, not raw material quantity
        subConfig ? {
          meLevel: subConfig.me_level,
          teLevel: subConfig.te_level,
          facilitySnapshot: JSON.parse(subConfig.facility_snapshot),
          useIntermediates: subConfig.use_intermediates
        } : null,
        facility,  // Pass our facility as fallback
        characterId,
        planId,  // Pass planId for nested lookups
        subConfig ? subConfig.plan_blueprint_id : null,  // Parent blueprint ID for nested child lookups
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
      // No blueprints, clear materials and products
      db.prepare('DELETE FROM plan_materials WHERE plan_id = ?').run(planId);
      db.prepare('DELETE FROM plan_products WHERE plan_id = ?').run(planId);
      console.log(`Cleared materials for empty plan: ${planId}`);
      return true;
    }

    // Aggregate materials and products across all blueprints
    const aggregatedMaterials = {};
    const aggregatedProducts = {};
    const aggregatedIntermediateProducts = []; // Array of {typeId, quantity, depth}
    const blueprintCalculations = new Map(); // Store calculations to identify final products later

    // NOTE: Built intermediate exclusion logic has been removed.
    // Instead, materials for built intermediates are marked as acquired
    // via the acquisition tracking system (see markIntermediateMaterialsAsAcquired)

    // Get market settings for pricing
    const marketSettings = getMarketSettings();

    // Filter out intermediate blueprints - only process top-level blueprints
    // Intermediate blueprints are auto-created entries that should not be processed separately
    // Their products are already captured via intermediateComponents from parent blueprints
    const topLevelBlueprints = blueprints.filter(bp => !bp.isIntermediate);

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

          // Expand this intermediate recursively
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
        }

        // Process reactions - DON'T expand yet, just add products to aggregated materials
        // Reactions will be detected and expanded in PHASE 2.5 after all materials are aggregated
        for (const reaction of reactions) {
          const materialTypeId = reaction.typeId;
          const materialQuantity = reaction.quantity;
          const totalQty = materialQuantity * blueprint.lines;
          aggregatedMaterials[materialTypeId] = (aggregatedMaterials[materialTypeId] || 0) + totalQty;
        }

        // Process raw materials - add them directly
        for (const rawMaterial of rawMaterials) {
          const totalQty = rawMaterial.quantity * blueprint.lines;
          aggregatedMaterials[rawMaterial.typeId] = (aggregatedMaterials[rawMaterial.typeId] || 0) + totalQty;
        }
      } else if (blueprint.useIntermediates === 'components') {
        // use_intermediates === 'components'
        // Don't expand - just add components as materials
        for (const [typeId, quantity] of Object.entries(calculation.materials)) {
          const totalQty = quantity * blueprint.lines;
          aggregatedMaterials[typeId] = (aggregatedMaterials[typeId] || 0) + totalQty;
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

    // Get plan-level reactions setting
    const planSettings = getPlanIndustrySettings(planId);
    const planReactionsEnabled = planSettings.reactionsAsIntermediates;

    // Reactions are only processed if:
    // 1. Plan-level "Calculate Reactions as Intermediates" is enabled, AND
    // 2. At least one blueprint has useIntermediates set to expand reactions
    const hasReactionsEnabled = planReactionsEnabled && topLevelBlueprints.some(bp =>
      bp.useIntermediates === 'raw_materials' || bp.useIntermediates === 'build_buy'
    );

    if (hasReactionsEnabled) {
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

                // Verify facility has necessary fields for bonus calculation
                if (facility) {
                  console.log(`[Plans] Restored facility for reaction ${reactionTypeId}:`, {
                    id: facility.id,
                    name: facility.name,
                    hasRigs: !!facility.rigs,
                    rigCount: facility.rigs?.length || 0,
                    structureTypeId: facility.structureTypeId
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
              facilityId = facility ? facility.id : null;
              console.log(`[Plans] Using default facility for new reaction ${reactionTypeId}:`, {
                name: facility?.name || 'none',
                hasRigs: !!facility?.rigs,
                rigCount: facility?.rigs?.length || 0
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
      const existingMaterialAcquisition = {};
      const existingProductPrices = {};

      if (!refreshPrices) {
        const existingMaterials = db.prepare('SELECT type_id, base_price, price_frozen_at FROM plan_materials WHERE plan_id = ?').all(planId);
        for (const mat of existingMaterials) {
          existingMaterialPrices[mat.type_id] = {
            price: mat.base_price,
            frozenAt: mat.price_frozen_at
          };
        }

        const existingProducts = db.prepare('SELECT type_id, base_price, price_frozen_at FROM plan_products WHERE plan_id = ?').all(planId);
        for (const prod of existingProducts) {
          existingProductPrices[prod.type_id] = {
            price: prod.base_price,
            frozenAt: prod.price_frozen_at
          };
        }
      }

      // Track which materials existed before recalculation (for tracking removed acquisitions)
      const oldMaterials = db.prepare(`
        SELECT type_id FROM plan_materials WHERE plan_id = ?
      `).all(planId);
      const oldMaterialTypeIds = new Set(oldMaterials.map(m => m.type_id));

      // Get all manual acquisitions (for deletion/warning tracking)
      const existingManualAcquisitions = db.prepare(`
        SELECT type_id, quantity, acquisition_method
        FROM plan_material_manual_acquisitions
        WHERE plan_id = ?
      `).all(planId);

      // Clear existing materials and products
      db.prepare('DELETE FROM plan_materials WHERE plan_id = ?').run(planId);
      db.prepare('DELETE FROM plan_products WHERE plan_id = ?').run(planId);

      const now = Date.now();

      // Insert materials with prices
      const insertMaterial = db.prepare(`
        INSERT INTO plan_materials (
          plan_id, type_id, quantity, base_price, price_frozen_at
        )
        VALUES (?, ?, ?, ?, ?)
      `);

      // Get location settings for input materials
      const inputLocation = getInputLocation(marketSettings);

      for (const [typeId, quantity] of Object.entries(aggregatedMaterials)) {
        let price = null;
        let priceFrozenAt = null;

        if (refreshPrices) {
          try {
            const priceResult = await calculateRealisticPrice(
              parseInt(typeId),
              inputLocation.regionId,
              inputLocation.locationId,
              marketSettings.inputMaterials.priceType,
              quantity
            );
            price = priceResult.price;
            priceFrozenAt = now;
          } catch (error) {
            console.warn(`Could not fetch price for type ${typeId}:`, error.message);
          }
        } else {
          // Preserve existing price
          const existing = existingMaterialPrices[typeId];
          if (existing) {
            price = existing.price;
            priceFrozenAt = existing.frozenAt;
          }
        }

        // No longer inserting acquisition data into plan_materials
        // (acquisition data lives in separate plan_material_manual_acquisitions table)
        insertMaterial.run(
          planId,
          parseInt(typeId),
          quantity,
          price,
          priceFrozenAt
        );
      }

      // Determine what is TRULY a final product
      // Final product = product of a top-level blueprint
      const finalProductTypeIds = new Set();
      for (const blueprint of topLevelBlueprints) {
        const calculation = blueprintCalculations.get(blueprint.planBlueprintId);
        if (calculation?.product?.typeID) {
          finalProductTypeIds.add(calculation.product.typeID);
        }
      }

      // Insert products with prices
      const insertProduct = db.prepare(`
        INSERT INTO plan_products (plan_id, type_id, quantity, base_price, price_frozen_at, is_intermediate, intermediate_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      // Get location settings for output products
      const outputLocation = getOutputLocation(marketSettings);

      // Insert final products (is_intermediate = 0, depth = 0)
      for (const [typeId, quantity] of Object.entries(aggregatedProducts)) {
        // Skip if this is not a final product
        if (!finalProductTypeIds.has(parseInt(typeId))) {
          continue;
        }
        let price = null;
        let priceFrozenAt = null;

        if (refreshPrices) {
          try {
            const priceResult = await calculateRealisticPrice(
              parseInt(typeId),
              outputLocation.regionId,
              outputLocation.locationId,
              marketSettings.outputProducts.priceType,
              quantity
            );
            price = priceResult.price;
            priceFrozenAt = now;
          } catch (error) {
            console.warn(`Could not fetch price for type ${typeId}:`, error.message);
          }
        } else {
          // Preserve existing price
          const existing = existingProductPrices[typeId];
          if (existing) {
            price = existing.price;
            priceFrozenAt = existing.frozenAt;
          }
        }

        insertProduct.run(planId, parseInt(typeId), quantity, price, priceFrozenAt, 0, 0);
      }

      // Insert intermediate products (is_intermediate = 1, depth > 0)
      // First, deduplicate by typeId (sum quantities, keep minimum depth)
      const intermediateProductMap = new Map();
      for (const item of aggregatedIntermediateProducts) {
        const existing = intermediateProductMap.get(item.typeId);
        if (!existing || item.depth < existing.depth) {
          intermediateProductMap.set(item.typeId, {
            quantity: (existing?.quantity || 0) + item.quantity,
            depth: item.depth
          });
        } else {
          existing.quantity += item.quantity;
        }
      }

      // Insert intermediate products (skip if also a final product)
      for (const [typeId, data] of intermediateProductMap) {
        // Skip if this type_id is a final product
        if (finalProductTypeIds.has(typeId)) {
          console.log(`[Plans] Skipping intermediate product ${typeId} - it's a final product`);
          continue;
        }

        let price = null;
        let priceFrozenAt = null;

        if (refreshPrices) {
          try {
            const priceResult = await calculateRealisticPrice(
              typeId,
              outputLocation.regionId,
              outputLocation.locationId,
              marketSettings.outputProducts.priceType,
              data.quantity
            );
            price = priceResult.price;
            priceFrozenAt = now;
          } catch (error) {
            console.warn(`Could not fetch price for type ${typeId}:`, error.message);
          }
        } else {
          // Preserve existing price
          const existing = existingProductPrices[typeId];
          if (existing) {
            price = existing.price;
            priceFrozenAt = existing.frozenAt;
          }
        }

        insertProduct.run(planId, typeId, data.quantity, price, priceFrozenAt, 1, data.depth);
      }

      // Clean up orphaned intermediates before committing
      await cleanupOrphanedIntermediates(planId);

      db.exec('COMMIT');
      console.log(`Recalculated materials and products for plan ${planId} (${Object.keys(aggregatedMaterials).length} materials, ${Object.keys(aggregatedProducts).length} products)`);

      // Recalculate manufactured materials from built intermediates
      // This is done AFTER the transaction commits to ensure materials table is updated
      // Note: We only recalculate if there are built intermediates (otherwise this is a no-op)
      await recalculateManufacturedMaterials(planId, plan.character_id);

      // After inserting new materials, check for acquisition issues
      const newMaterials = db.prepare(`
        SELECT type_id, quantity FROM plan_materials WHERE plan_id = ?
      `).all(planId);
      const newMaterialTypeIds = new Set(newMaterials.map(m => m.type_id));
      const warnings = [];

      // Find materials that were removed (had manual acquisition but no longer in plan)
      const removedAcquisitions = [];
      for (const acq of existingManualAcquisitions) {
        if (!newMaterialTypeIds.has(acq.type_id)) {
          removedAcquisitions.push({
            typeId: acq.type_id,
            typeName: getTypeName(acq.type_id),
            acquiredQuantity: acq.quantity,
            method: acq.acquisition_method
          });
        }
      }

      // Delete manual acquisitions for removed materials
      if (removedAcquisitions.length > 0) {
        const removedTypeIds = removedAcquisitions.map(r => r.typeId);
        const placeholders = removedTypeIds.map(() => '?').join(',');

        db.prepare(`
          DELETE FROM plan_material_manual_acquisitions
          WHERE plan_id = ? AND type_id IN (${placeholders})
        `).run(planId, ...removedTypeIds);

        // Log the removals
        const logStmt = db.prepare(`
          INSERT INTO plan_material_acquisition_log
            (plan_id, type_id, timestamp, action, quantity_before, quantity_after, performed_by)
          VALUES (?, ?, ?, 'remove', ?, 0, 'system')
        `);

        removedAcquisitions.forEach(acq => {
          logStmt.run(planId, acq.typeId, now, acq.acquiredQuantity);
        });

        warnings.push({
          type: 'removed_acquisitions',
          materials: removedAcquisitions
        });

        console.log(`[Plans] Removed ${removedAcquisitions.length} manual acquisition(s) for materials no longer in plan ${planId}`);
      }

      // Check for materials with excess acquisitions (acquired > needed)
      const excessMaterials = db.prepare(`
        SELECT pm.type_id, pm.quantity, ma.quantity as acquired_quantity
        FROM plan_materials pm
        JOIN plan_material_manual_acquisitions ma
          ON pm.plan_id = ma.plan_id AND pm.type_id = ma.type_id
        WHERE pm.plan_id = ?
          AND ma.quantity > pm.quantity
      `).all(planId);

      if (excessMaterials.length > 0) {
        warnings.push({
          type: 'excess_acquisitions',
          materials: excessMaterials.map(m => ({
            typeId: m.type_id,
            typeName: getTypeName(m.type_id),
            needed: m.quantity,
            acquired: m.acquired_quantity,
            excess: m.acquired_quantity - m.quantity
          }))
        });

        console.log(`[Plans] Found ${excessMaterials.length} material(s) with excess acquisitions in plan ${planId}`);
      }

      // Return success with warnings
      return { success: true, warnings };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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

    const materials = db.prepare(`
      SELECT
        pm.*,
        ma.quantity as manually_acquired_quantity,
        ma.acquisition_method,
        ma.custom_price,
        ma.note as acquisition_note,
        ma.updated_at as acquisition_updated_at
      FROM plan_materials pm
      LEFT JOIN plan_material_manual_acquisitions ma
        ON pm.plan_id = ma.plan_id AND pm.type_id = ma.type_id
      WHERE pm.plan_id = ?
      ORDER BY pm.quantity DESC
    `).all(planId);

    // Query confirmed transaction matches (material purchases)
    const confirmedPurchases = {};
    if (materials.length > 0) {
      try {
        const typeIds = materials.map(m => m.type_id);
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
        // Continue with empty confirmedPurchases
      }
    }

    // Query confirmed industry job matches (manufactured materials)
    const confirmedManufacturing = {};
    if (materials.length > 0) {
      try {
        const typeIds = materials.map(m => m.type_id);

        // Get confirmed jobs with their blueprint types
        const confirmedJobs = db.prepare(`
          SELECT jm.job_id, ij.blueprint_type_id, ij.runs
          FROM plan_job_matches jm
          JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
          WHERE jm.plan_id = ?
            AND jm.status = 'confirmed'
        `).all(planId);

        if (confirmedJobs.length > 0) {
          // Open SDE database synchronously
          let sdeDb = null;
          try {
            sdeDb = new Database(getSdePath(), { readonly: true });

            const blueprintTypeIds = confirmedJobs.map(j => j.blueprint_type_id);
            const placeholders = blueprintTypeIds.map(() => '?').join(',');

            // Get products for these blueprints
            const products = sdeDb.prepare(`
              SELECT typeID, productTypeID, quantity
              FROM industryActivityProducts
              WHERE activityID = 1
                AND typeID IN (${placeholders})
            `).all(...blueprintTypeIds);

            // Map jobs to their products
            for (const job of confirmedJobs) {
              const jobProducts = products.filter(p => p.typeID === job.blueprint_type_id);
              for (const product of jobProducts) {
                // Only count if this product is in our materials list
                if (typeIds.includes(product.productTypeID)) {
                  const totalQuantity = job.runs * product.quantity;
                  if (!confirmedManufacturing[product.productTypeID]) {
                    confirmedManufacturing[product.productTypeID] = {
                      quantity: 0,
                      count: 0
                    };
                  }
                  confirmedManufacturing[product.productTypeID].quantity += totalQuantity;
                  confirmedManufacturing[product.productTypeID].count += 1;
                }
              }
            }
          } catch (error) {
            console.error('Error accessing SDE database for manufacturing matches:', error);
          } finally {
            if (sdeDb) {
              sdeDb.close();
            }
          }
        }
      } catch (error) {
        console.error('Error querying confirmed manufacturing jobs:', error);
        // Continue with empty confirmedManufacturing
      }
    }

    const result = materials.map(m => ({
      typeId: m.type_id,
      quantity: m.quantity,
      basePrice: m.base_price,
      priceFrozenAt: m.price_frozen_at,
      manuallyAcquired: m.manually_acquired_quantity ? 1 : 0, // For backward compatibility
      manuallyAcquiredQuantity: m.manually_acquired_quantity || 0,
      acquisitionMethod: m.acquisition_method || null,
      customPrice: m.custom_price || null,
      acquisitionNote: m.acquisition_note || null,
      acquisitionUpdatedAt: m.acquisition_updated_at || null,
      purchasedQuantity: confirmedPurchases[m.type_id]?.quantity || 0,
      purchaseMatchCount: confirmedPurchases[m.type_id]?.count || 0,
      manufacturedQuantity: confirmedManufacturing[m.type_id]?.quantity || 0,
      manufacturingMatchCount: confirmedManufacturing[m.type_id]?.count || 0,
      ownedPersonal: 0,
      ownedCorp: 0,
    }));

    if (includeAssets) {
      // Get plan to find character ID
      const plan = db.prepare('SELECT character_id FROM manufacturing_plans WHERE plan_id = ?').get(planId);
      if (!plan) {
        return result; // No plan found, skip assets
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
      const personalAssetMap = {};  // typeId -> quantity
      const corpAssetMap = {};      // typeId -> quantity
      const personalAssetDetails = {}; // typeId -> array of { characterId, characterName, quantity }
      const corpAssetDetails = {};     // typeId -> array of { corporationId, corporationName, divisionId, divisionName, quantity }
      const processedCorps = new Set(); // Track corporations to avoid double-counting

      for (const characterId of characterIds) {
        // Get character info to find corporation
        const { getCharacter } = require('./settings-manager');
        const character = getCharacter(characterId);

        if (!character) {
          console.warn(`[Plans] Character ${characterId} not found, skipping assets`);
          continue;
        }

        // Fetch personal assets for this character
        const personalAssets = getAssets(characterId, false);
        for (const asset of personalAssets) {
          // Aggregate totals (existing logic)
          personalAssetMap[asset.typeId] = (personalAssetMap[asset.typeId] || 0) + asset.quantity;

          // NEW: Preserve per-character details
          if (!personalAssetDetails[asset.typeId]) {
            personalAssetDetails[asset.typeId] = [];
          }

          // Find existing entry for this character, or create new one
          let charEntry = personalAssetDetails[asset.typeId].find(e => e.characterId === characterId);
          if (!charEntry) {
            charEntry = {
              characterId: characterId,
              characterName: character.characterName,
              quantity: 0
            };
            personalAssetDetails[asset.typeId].push(charEntry);
          }
          charEntry.quantity += asset.quantity;
        }

        // Fetch corporation assets (with division filtering and deduplication)
        const corpId = character.corporationId;
        if (corpId && !processedCorps.has(corpId)) {
          processedCorps.add(corpId);  // Mark corporation as processed

          // Get enabled divisions for this character
          const charEnabledDivisions = enabledDivisions[characterId] || [];

          // Fetch all corp assets for this character
          const corpAssets = getAssets(characterId, true);

          // Filter by enabled divisions
          for (const asset of corpAssets) {
            // Check if asset is in an enabled division
            if (isAssetInEnabledDivision(asset, charEnabledDivisions)) {
              // Aggregate totals (existing logic)
              corpAssetMap[asset.typeId] = (corpAssetMap[asset.typeId] || 0) + asset.quantity;

              // NEW: Preserve per-division details
              if (!corpAssetDetails[asset.typeId]) {
                corpAssetDetails[asset.typeId] = [];
              }

              // Extract division ID from location_flag (e.g., "CorpSAG2" -> division 2)
              const divisionId = extractDivisionId(asset.locationFlag);

              // Find existing entry for this corp/division, or create new one
              let corpEntry = corpAssetDetails[asset.typeId].find(
                e => e.corporationId === corpId && e.divisionId === divisionId
              );
              if (!corpEntry) {
                corpEntry = {
                  corporationId: corpId,
                  corporationName: character.corporationName || `Corporation ${corpId}`,
                  divisionId: divisionId,
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

      // Apply aggregated assets to materials
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
  // If no divisions are enabled, include all corp assets (backward compatibility)
  if (!enabledDivisions || enabledDivisions.length === 0) {
    return true;
  }

  // Parse location_flag to extract division number
  // Format: "CorpSAG1", "CorpSAG2", etc.
  const locationFlag = asset.locationFlag;
  if (!locationFlag || !locationFlag.startsWith('CorpSAG')) {
    // Asset is not in a corporation hangar division
    // (might be in a station hangar, container, etc.)
    // Include it to be safe
    return true;
  }

  // Extract division number (1-7)
  const divisionMatch = locationFlag.match(/^CorpSAG(\d+)$/);
  if (!divisionMatch) {
    return true; // Can't parse, include to be safe
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
      SELECT * FROM plan_products WHERE plan_id = ? ORDER BY is_intermediate DESC, quantity DESC
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
 * Refresh ESI data for active plans for a character
 * @param {number} characterId - Character ID
 * @returns {Promise<Object>} Refresh status
 */
/**
 * Refresh ESI data for all characters associated with a plan
 * @param {string} planId - Plan ID to refresh
 * @returns {Promise<Object>} Refresh summary
 */
async function refreshPlanESIData(planId) {
  try {
    const { fetchCharacterIndustryJobs, saveIndustryJobs } = require('./esi-industry-jobs');
    const { fetchCharacterWalletTransactions, saveWalletTransactions } = require('./esi-wallet');
    const { matchJobsToPlan, matchTransactionsToPlan } = require('./plan-matching');
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

    // Fetch jobs and transactions for ALL characters
    const results = {
      success: true,
      charactersRefreshed: [],
      errors: []
    };

    for (const characterId of characterIds) {
      try {
        // Fetch industry jobs
        const jobsData = await fetchCharacterIndustryJobs(characterId, true);
        if (jobsData.jobs) {
          saveIndustryJobs({ characterId, jobs: jobsData.jobs, lastUpdated: jobsData.lastUpdated });
        }

        // Fetch wallet transactions
        const txData = await fetchCharacterWalletTransactions(characterId);
        if (txData.transactions) {
          saveWalletTransactions({ characterId, transactions: txData.transactions, lastUpdated: txData.lastUpdated });
        }

        results.charactersRefreshed.push(characterId);
      } catch (error) {
        console.error(`[Plans] Error refreshing character ${characterId}:`, error);
        results.errors.push({ characterId, error: error.message });
      }
    }

    // Run matching after fetching all data
    try {
      matchJobsToPlan(planId, { characterIds: results.charactersRefreshed });
      matchTransactionsToPlan(planId, { characterIds: results.charactersRefreshed });
    } catch (error) {
      console.error('[Plans] Error running matches:', error);
    }

    return {
      success: results.errors.length === 0,
      message: `Refreshed ${results.charactersRefreshed.length} character(s)`,
      charactersRefreshed: results.charactersRefreshed,
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

    // Calculate material purchase progress - total quantity of materials
    const materials = db.prepare('SELECT quantity FROM plan_materials WHERE plan_id = ?').all(planId);
    const totalMaterialQuantity = materials.reduce((sum, mat) => sum + mat.quantity, 0);

    // Sum quantity of confirmed material purchases from transactions
    const materialsPurchasedResult = db.prepare(`
      SELECT SUM(quantity) as total_quantity
      FROM plan_transaction_matches
      WHERE plan_id = ? AND match_type = 'material_buy' AND status = 'confirmed'
    `).get(planId);

    const materialQuantityFromTransactions = materialsPurchasedResult?.total_quantity || 0;

    // Sum manually acquired materials
    const manualsAcquiredResult = db.prepare(`
      SELECT SUM(manually_acquired_quantity) as total_quantity
      FROM plan_materials
      WHERE plan_id = ? AND manually_acquired = 1
    `).get(planId);

    const materialQuantityManuallyAcquired = manualsAcquiredResult?.total_quantity || 0;

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
    const products = db.prepare('SELECT quantity FROM plan_products WHERE plan_id = ? AND is_intermediate = 0').all(planId);
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
function markMaterialAcquired(planId, typeId, options = {}) {
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
    // Get current material info
    const currentMaterial = db.prepare(`
      SELECT quantity FROM plan_materials
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeId);

    if (!currentMaterial) {
      throw new Error('Material not found in plan');
    }

    // Get current manual acquisition if exists
    const currentAcquisition = db.prepare(`
      SELECT quantity FROM plan_material_manual_acquisitions
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeId);

    const currentAcquiredQty = currentAcquisition?.quantity || 0;

    // Calculate new total based on mode
    let newTotal;
    if (mode === 'add') {
      newTotal = currentAcquiredQty + quantity;
    } else { // 'set'
      newTotal = quantity;
    }

    if (newTotal < 0) {
      throw new Error('Quantity cannot be negative');
    }

    const hasExcess = newTotal > currentMaterial.quantity;

    // Asset validation (if requested and method is 'owned')
    let assetWarning = null;
    if (acquisitionMethod === 'owned' && validateAssets) {
      const materials = getPlanMaterials(planId, true);
      const material = materials.find(m => m.typeId === typeId);
      if (material) {
        const totalOwned = (material.ownedPersonal || 0) + (material.ownedCorp || 0);
        if (newTotal > totalOwned) {
          assetWarning = {
            requested: newTotal,
            available: totalOwned,
            shortfall: newTotal - totalOwned
          };
        }
      }
    }

    const now = Date.now();

    // Insert or update manual acquisition record
    db.prepare(`
      INSERT INTO plan_material_manual_acquisitions
        (plan_id, type_id, quantity, acquisition_method, custom_price, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id, type_id) DO UPDATE SET
        quantity = excluded.quantity,
        acquisition_method = excluded.acquisition_method,
        custom_price = excluded.custom_price,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run(planId, typeId, newTotal, acquisitionMethod, customPrice, acquisitionNote, now, now);

    // Log the acquisition
    db.prepare(`
      INSERT INTO plan_material_acquisition_log
        (plan_id, type_id, timestamp, action, quantity_before, quantity_after,
         acquisition_method, custom_price, note, performed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')
    `).run(planId, typeId, now, mode, currentAcquiredQty, newTotal,
           acquisitionMethod, customPrice, acquisitionNote);

    console.log(`[Plans] Marked ${newTotal} units of material ${typeId} as acquired for plan ${planId} (mode: ${mode})`);

    return {
      success: true,
      newTotal,
      hasExcess,
      excessAmount: hasExcess ? newTotal - currentMaterial.quantity : 0,
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
    // Get current quantity before deletion for logging
    const currentAcq = db.prepare(`
      SELECT quantity FROM plan_material_manual_acquisitions
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeId);

    if (!currentAcq) {
      return { success: true, message: 'No manual acquisition to remove' };
    }

    // Delete the manual acquisition
    db.prepare(`
      DELETE FROM plan_material_manual_acquisitions
      WHERE plan_id = ? AND type_id = ?
    `).run(planId, typeId);

    // Log the removal
    db.prepare(`
      INSERT INTO plan_material_acquisition_log
        (plan_id, type_id, timestamp, action, quantity_before, quantity_after, performed_by)
      VALUES (?, ?, ?, 'remove', ?, 0, 'user')
    `).run(planId, typeId, Date.now(), currentAcq.quantity);

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
    // Build dynamic update
    const setClauses = [];
    const params = [];

    if (quantity !== null) {
      setClauses.push('manually_acquired_quantity = ?');
      params.push(quantity);
    }

    if (customPrice !== null) {
      setClauses.push('custom_price = ?');
      params.push(customPrice);
    }

    if (setClauses.length === 0) {
      throw new Error('No updates provided');
    }

    params.push(planId, typeId);

    const result = db.prepare(`
      UPDATE plan_materials
      SET ${setClauses.join(', ')}
      WHERE plan_id = ? AND type_id = ?
    `).run(...params);

    if (result.changes === 0) {
      throw new Error('Material not found in plan');
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
      UPDATE plan_materials
      SET custom_price = ?
      WHERE plan_id = ? AND type_id = ?
    `).run(customPrice, planId, typeId);

    if (result.changes === 0) {
      throw new Error('Material not found in plan');
    }

    console.log(`[Plans] Updated custom price for material ${typeId} in plan ${planId}`);
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
    // Find acquisitions that exceed needed quantity
    let query = `
      SELECT pm.type_id, pm.quantity as needed, ma.quantity as acquired
      FROM plan_materials pm
      JOIN plan_material_manual_acquisitions ma
        ON pm.plan_id = ma.plan_id AND pm.type_id = ma.type_id
      WHERE pm.plan_id = ?
        AND ma.quantity > pm.quantity
    `;

    const params = [planId];
    if (typeId) {
      query += ' AND pm.type_id = ?';
      params.push(typeId);
    }

    const excessMaterials = db.prepare(query).all(...params);

    if (excessMaterials.length === 0) {
      return { adjusted: 0 };
    }

    const now = Date.now();
    const updateStmt = db.prepare(`
      UPDATE plan_material_manual_acquisitions
      SET quantity = ?, updated_at = ?
      WHERE plan_id = ? AND type_id = ?
    `);

    const logStmt = db.prepare(`
      INSERT INTO plan_material_acquisition_log
        (plan_id, type_id, timestamp, action, quantity_before, quantity_after, performed_by)
      VALUES (?, ?, ?, 'cleanup', ?, ?, 'user')
    `);

    excessMaterials.forEach(m => {
      // Update acquisition to match needed quantity
      updateStmt.run(m.needed, now, planId, m.type_id);

      // Log the adjustment
      logStmt.run(planId, m.type_id, now, m.acquired, m.needed);
    });

    console.log(`[Plans] Cleaned up ${excessMaterials.length} excess acquisitions for plan ${planId}`);
    return { adjusted: excessMaterials.length };
  } catch (error) {
    console.error('[Plans] Error cleaning up excess acquisitions:', error);
    throw error;
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
        timestamp,
        action,
        quantity_before,
        quantity_after,
        acquisition_method,
        custom_price,
        note,
        performed_by
      FROM plan_material_acquisition_log
      WHERE plan_id = ?
    `;

    const params = [planId];
    if (typeId) {
      query += ' AND type_id = ?';
      params.push(typeId);
    }

    query += ' ORDER BY timestamp DESC LIMIT 100'; // Most recent 100 entries

    const logEntries = db.prepare(query).all(...params);

    return logEntries.map(entry => ({
      typeId: entry.type_id,
      typeName: getTypeName(entry.type_id),
      timestamp: entry.timestamp,
      timestampFormatted: new Date(entry.timestamp).toLocaleString(),
      action: entry.action,
      quantityBefore: entry.quantity_before,
      quantityAfter: entry.quantity_after,
      quantityChange: entry.quantity_after - (entry.quantity_before || 0),
      acquisitionMethod: entry.acquisition_method,
      customPrice: entry.custom_price,
      note: entry.note,
      performedBy: entry.performed_by
    }));
  } catch (error) {
    console.error('[Plans] Error getting acquisition log:', error);
    throw error;
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
    await recalculateManufacturedMaterials(reaction.plan_id, reaction.character_id);

    return true;
  } catch (error) {
    console.error('Error marking reaction built:', error);
    throw error;
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
};
