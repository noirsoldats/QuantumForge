const { getCharacterDatabase } = require('./character-database');
const { calculateBlueprintMaterials, getBlueprintProduct } = require('./blueprint-calculator');
const { calculateRealisticPrice } = require('./market-pricing');
const { getAssets } = require('./esi-assets');
const { getMarketSettings } = require('./settings-manager');
const { getSdePath } = require('./sde-manager');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

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
 * Detect and create intermediate blueprints for a parent blueprint
 * @param {string} parentBlueprintId - Parent blueprint ID
 * @param {string} planId - Plan ID
 * @param {number} characterId - Character ID
 * @returns {Promise<Array>} Array of created intermediate blueprint IDs
 */
async function detectAndCreateIntermediates(parentBlueprintId, planId, characterId) {
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

    // Calculate materials to get intermediate components
    const facilitySnapshot = parent.facility_snapshot ? JSON.parse(parent.facility_snapshot) : null;

    const calculation = await calculateBlueprintMaterials(
      parent.blueprint_type_id,
      parent.runs,
      parent.me_level,
      characterId,
      facilitySnapshot,
      true  // useIntermediates = true
    );

    const createdIntermediateIds = [];

    // Check if breakdown has intermediate components
    if (calculation.breakdown && calculation.breakdown.length > 0) {
      const mainBreakdown = calculation.breakdown[0];

      if (mainBreakdown.intermediateComponents && mainBreakdown.intermediateComponents.length > 0) {
        const now = Date.now();

        for (const intermediate of mainBreakdown.intermediateComponents) {
          // Calculate actual runs needed based on products-per-run
          // Example: 369 products needed ÷ 3 per run = 123 runs
          const productsPerRun = intermediate.productQuantityPerRun || 1;
          const runsNeeded = Math.ceil(intermediate.quantity / productsPerRun);

          // Check if this intermediate already exists for this parent
          const existing = db.prepare(`
            SELECT plan_blueprint_id FROM plan_blueprints
            WHERE parent_blueprint_id = ?
              AND blueprint_type_id = ?
              AND intermediate_product_type_id = ?
          `).get(parentBlueprintId, intermediate.blueprintTypeID, intermediate.typeID);

          let intermediateBlueprintId;
          if (existing) {
            // Update runs if it changed
            db.prepare(`
              UPDATE plan_blueprints
              SET runs = ?
              WHERE plan_blueprint_id = ?
            `).run(runsNeeded, existing.plan_blueprint_id);

            console.log(`Updated intermediate blueprint ${intermediate.blueprintTypeID} runs to ${runsNeeded} (${intermediate.quantity} products ÷ ${productsPerRun} per run)`);
            intermediateBlueprintId = existing.plan_blueprint_id;
            createdIntermediateIds.push(existing.plan_blueprint_id);
          } else {
            // Create new intermediate blueprint entry
            intermediateBlueprintId = randomUUID();

            // Use parent's facility by default
            const intermediateFacilityId = parent.facility_id;
            const intermediateFacilitySnapshot = facilitySnapshot;

            // Use the ME from the calculation breakdown
            let intermediateME = intermediate.meLevel || 0;
            let intermediateTE = 0;

            db.prepare(`
              INSERT INTO plan_blueprints (
                plan_blueprint_id, plan_id, parent_blueprint_id,
                blueprint_type_id, runs, lines,
                me_level, te_level, facility_id, facility_snapshot,
                is_intermediate, is_built, intermediate_product_type_id,
                added_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            `).run(
              intermediateBlueprintId,
              planId,
              parentBlueprintId,
              intermediate.blueprintTypeID,
              runsNeeded,  // Actual runs calculated from quantity ÷ products-per-run
              1,  // lines always 1 for intermediates
              intermediateME,
              intermediateTE,
              intermediateFacilityId,
              intermediateFacilitySnapshot ? JSON.stringify(intermediateFacilitySnapshot) : null,
              intermediate.typeID,
              now
            );

            console.log(`Created intermediate blueprint ${intermediate.blueprintTypeID} (${runsNeeded} runs to produce ${intermediate.quantity} ${intermediate.typeName})`);
            createdIntermediateIds.push(intermediateBlueprintId);
          }

          // Recursively detect and create nested intermediates
          if (intermediate.nestedIntermediates && intermediate.nestedIntermediates.length > 0) {
            console.log(`Recursively creating ${intermediate.nestedIntermediates.length} nested intermediates for ${intermediate.typeName}`);
            const nestedIds = await detectAndCreateIntermediates(
              intermediateBlueprintId,  // This intermediate becomes the parent
              planId,
              characterId
            );
            createdIntermediateIds.push(...nestedIds);
          }
        }
      }
    }

    return createdIntermediateIds;
  } catch (error) {
    console.error('Error detecting and creating intermediates:', error);
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

      // If this is a top-level blueprint (not an intermediate), recalculate its intermediates
      // This is needed when runs, lines, ME, or facility change
      if (!blueprint.is_intermediate) {
        await detectAndCreateIntermediates(planBlueprintId, blueprint.plan_id, blueprint.character_id);
        console.log(`Recalculated intermediates for blueprint: ${planBlueprintId}`);
      }

      // Trigger material recalculation
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
      isIntermediate: bp.is_intermediate === 1,
      isBuilt: bp.is_built === 1,
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
          isIntermediate: bp.is_intermediate === 1,
          isBuilt: bp.is_built === 1,
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

    const allowedFields = ['me_level', 'te_level', 'facility_id', 'facility_snapshot'];
    const fields = [];
    const values = [];

    const fieldMap = {
      meLevel: 'me_level',
      teLevel: 'te_level',
      facilityId: 'facility_id',
      facilitySnapshot: 'facility_snapshot',
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
 * Mark an intermediate blueprint as built or unbuilt
 * @param {string} intermediateBlueprintId - Intermediate blueprint ID
 * @param {boolean} isBuilt - Built status
 * @returns {Promise<Object>} Result with warnings if any
 */
async function markIntermediateBuilt(intermediateBlueprintId, isBuilt) {
  try {
    const db = getCharacterDatabase();

    // Get plan and character info before marking
    const blueprintInfo = db.prepare(`
      SELECT pb.plan_id, mp.character_id
      FROM plan_blueprints pb
      JOIN manufacturing_plans mp ON pb.plan_id = mp.plan_id
      WHERE pb.plan_blueprint_id = ?
    `).get(intermediateBlueprintId);

    if (!blueprintInfo) {
      throw new Error('Intermediate blueprint not found');
    }

    // Recursively mark this intermediate and all children
    const planId = await markIntermediateBuiltRecursive(intermediateBlueprintId, isBuilt, db, true);

    // Instead of excluding materials, mark them as acquired/unacquired
    if (isBuilt) {
      await markIntermediateMaterialsAsAcquired(intermediateBlueprintId, planId, blueprintInfo.character_id);
    } else {
      await unmarkIntermediateMaterialsAsAcquired(intermediateBlueprintId, planId);
    }

    // NOTE: We still call recalculatePlanMaterials to ensure consistency,
    // but the exclusion logic has been removed (materials remain in the list)
    await recalculatePlanMaterials(planId, false);

    // Update plan's updated_at
    const now = Date.now();
    db.prepare('UPDATE manufacturing_plans SET updated_at = ? WHERE plan_id = ?').run(now, planId);

    return {
      success: true,
      warnings: [],
    };
  } catch (error) {
    console.error('Error marking intermediate as built:', error);
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
 * Recalculate plan materials and products
 * @param {string} planId - Plan ID
 * @param {boolean} refreshPrices - Whether to refresh prices from market
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
    const aggregatedIntermediateProducts = new Map(); // Map<typeId, {quantity, depth}>
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

    for (const blueprint of topLevelBlueprints) {
      // Parse facility snapshot
      const facility = blueprint.facilitySnapshot;

      // Get use_intermediates flag and convert to boolean
      // 'raw_materials' = true (build intermediates), 'components' = false (buy from market)
      // For backwards compatibility: 1/true = raw_materials, 0/false = components
      let useIntermediates;
      if (blueprint.useIntermediates === 'raw_materials') {
        useIntermediates = true;
      } else if (blueprint.useIntermediates === 'components') {
        useIntermediates = false;
      } else if (blueprint.useIntermediates === 'build_buy') {
        // For now, treat build_buy as raw_materials until optimization is implemented
        useIntermediates = true;
      } else {
        // Backwards compatibility: treat numeric/boolean values
        useIntermediates = blueprint.useIntermediates !== 0 && blueprint.useIntermediates !== false;
      }

      // Calculate materials for this blueprint (respecting max runs per calculation)
      const calculation = await calculateBlueprintMaterials(
        blueprint.blueprintTypeId,
        blueprint.runs,
        blueprint.meLevel,
        plan.character_id,
        facility,
        useIntermediates
      );

      // Store calculation for later use (to identify final products)
      blueprintCalculations.set(blueprint.planBlueprintId, calculation);

      // Aggregate materials (multiply by lines if > 1)
      // NOTE: Materials are aggregated regardless of built status
      // Built intermediates have their materials marked as acquired via the acquisition system
      for (const [typeId, quantity] of Object.entries(calculation.materials)) {
        const totalQty = quantity * blueprint.lines;
        aggregatedMaterials[typeId] = (aggregatedMaterials[typeId] || 0) + totalQty;
      }

      // Extract intermediate products from breakdown using flattening (if building from raw materials)
      if (useIntermediates && calculation.breakdown && calculation.breakdown.length > 0) {
        const mainBreakdown = calculation.breakdown[0];
        if (mainBreakdown.intermediateComponents) {
          // Flatten ALL intermediates at ALL depths
          const flattenedIntermediates = flattenIntermediates(
            mainBreakdown.intermediateComponents,
            1  // Start at depth 1
          );

          // Merge into aggregatedIntermediateProducts
          for (const [typeId, data] of flattenedIntermediates) {
            const totalQty = data.quantity * blueprint.lines;
            const existingData = aggregatedIntermediateProducts.get(typeId);

            // Track the MINIMUM depth (closest to final product)
            if (!existingData || data.depth < existingData.depth) {
              aggregatedIntermediateProducts.set(typeId, {
                quantity: (existingData?.quantity || 0) + totalQty,
                depth: data.depth
              });
            } else {
              existingData.quantity += totalQty;
            }
          }
        }
      }

      // Get product for this blueprint
      const product = calculation.product;
      if (product) {
        // Use baseQuantity (per run) from SDE and multiply by actual runs and lines
        const baseQty = product.baseQuantity || 1;
        const totalProductQty = baseQty * blueprint.runs * blueprint.lines;
        aggregatedProducts[product.typeID] = (aggregatedProducts[product.typeID] || 0) + totalProductQty;
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

      // Always capture acquisition data (regardless of refreshPrices)
      const acquisitionRecords = db.prepare(`
        SELECT type_id, manually_acquired, manually_acquired_quantity, acquisition_method, acquisition_note
        FROM plan_materials
        WHERE plan_id = ?
      `).all(planId);

      for (const rec of acquisitionRecords) {
        if (rec.manually_acquired) {  // Only preserve if actually acquired
          existingMaterialAcquisition[rec.type_id] = {
            manually_acquired: rec.manually_acquired,
            manually_acquired_quantity: rec.manually_acquired_quantity,
            acquisition_method: rec.acquisition_method,
            acquisition_note: rec.acquisition_note
          };
        }
      }

      // Clear existing materials and products
      db.prepare('DELETE FROM plan_materials WHERE plan_id = ?').run(planId);
      db.prepare('DELETE FROM plan_products WHERE plan_id = ?').run(planId);

      const now = Date.now();

      // Insert materials with prices
      const insertMaterial = db.prepare(`
        INSERT INTO plan_materials (
          plan_id, type_id, quantity, base_price, price_frozen_at,
          manually_acquired, manually_acquired_quantity, acquisition_method, acquisition_note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [typeId, quantity] of Object.entries(aggregatedMaterials)) {
        let price = null;
        let priceFrozenAt = null;

        if (refreshPrices) {
          try {
            const priceResult = await calculateRealisticPrice(
              parseInt(typeId),
              marketSettings.regionId,
              marketSettings.locationId,
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

        // Apply preserved acquisition data (if any)
        const acqData = existingMaterialAcquisition[parseInt(typeId)] || {};

        insertMaterial.run(
          planId,
          parseInt(typeId),
          quantity,
          price,
          priceFrozenAt,
          acqData.manually_acquired || 0,
          acqData.manually_acquired_quantity || 0,
          acqData.acquisition_method || null,
          acqData.acquisition_note || null
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
              marketSettings.regionId,
              marketSettings.locationId,
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
      // Skip any intermediate products that are final products
      for (const [typeId, data] of aggregatedIntermediateProducts) {
        // Skip if this type_id is a final product
        if (finalProductTypeIds.has(parseInt(typeId))) {
          console.log(`[Plans] Skipping intermediate product ${typeId} - it's a final product`);
          continue;
        }

        let price = null;
        let priceFrozenAt = null;

        if (refreshPrices) {
          try {
            const priceResult = await calculateRealisticPrice(
              parseInt(typeId),
              marketSettings.regionId,
              marketSettings.locationId,
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

        insertProduct.run(planId, parseInt(typeId), data.quantity, price, priceFrozenAt, 1, data.depth);
      }

      db.exec('COMMIT');
      console.log(`Recalculated materials and products for plan ${planId} (${Object.keys(aggregatedMaterials).length} materials, ${Object.keys(aggregatedProducts).length} products)`);

      return true;
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
      SELECT * FROM plan_materials WHERE plan_id = ? ORDER BY quantity DESC
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
      manuallyAcquired: m.manually_acquired || 0,
      manuallyAcquiredQuantity: m.manually_acquired_quantity || 0,
      acquisitionMethod: m.acquisition_method || null,
      customPrice: m.custom_price || null,
      acquisitionNote: m.acquisition_note || null,
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
      if (plan) {
        // Get character assets
        const personalAssets = getAssets(plan.character_id, false);
        const corpAssets = getAssets(plan.character_id, true);

        // Create lookup maps
        const personalMap = {};
        const corpMap = {};

        for (const asset of personalAssets) {
          personalMap[asset.typeId] = (personalMap[asset.typeId] || 0) + asset.quantity;
        }

        for (const asset of corpAssets) {
          corpMap[asset.typeId] = (corpMap[asset.typeId] || 0) + asset.quantity;
        }

        // Add asset quantities to materials
        for (const material of result) {
          material.ownedPersonal = personalMap[material.typeId] || 0;
          material.ownedCorp = corpMap[material.typeId] || 0;
        }
      }
    }

    return result;
  } catch (error) {
    console.error('Error getting plan materials:', error);
    return [];
  }
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
async function refreshActivePlansESIData(characterId) {
  try {
    const { fetchCharacterIndustryJobs, saveIndustryJobs } = require('./esi-industry-jobs');
    const { fetchCharacterWalletTransactions, saveWalletTransactions } = require('./esi-wallet');

    // Get active plans for this character
    const activePlans = getManufacturingPlans(characterId, { status: 'active' });

    if (activePlans.length === 0) {
      return { success: true, message: 'No active plans to refresh' };
    }

    // Fetch industry jobs
    try {
      const jobsData = await fetchCharacterIndustryJobs(characterId, true);
      saveIndustryJobs(jobsData);
    } catch (error) {
      console.warn('Could not refresh industry jobs:', error.message);
    }

    // Fetch wallet transactions
    try {
      const txData = await fetchCharacterWalletTransactions(characterId);
      saveWalletTransactions(txData);
    } catch (error) {
      console.warn('Could not refresh wallet transactions:', error.message);
    }

    return {
      success: true,
      message: `Refreshed ESI data for ${activePlans.length} active plan(s)`,
      plansRefreshed: activePlans.length,
    };
  } catch (error) {
    console.error('Error refreshing active plans ESI data:', error);
    return { success: false, error: error.message };
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
 * @param {string} options.acquisitionMethod - Method of acquisition (e.g., 'owned', 'manufactured', 'gift', 'other')
 * @param {number|null} options.customPrice - Custom price per unit (null to use base_price)
 * @param {string|null} options.acquisitionNote - Optional note about acquisition
 */
function markMaterialAcquired(planId, typeId, options = {}) {
  const { quantity, acquisitionMethod = 'other', customPrice = null, acquisitionNote = null } = options;

  if (!quantity || quantity <= 0) {
    throw new Error('Quantity is required and must be greater than 0');
  }

  const db = getCharacterDatabase();

  try {
    // Get the current material to validate quantity
    const material = db.prepare(`
      SELECT quantity, manually_acquired_quantity
      FROM plan_materials
      WHERE plan_id = ? AND type_id = ?
    `).get(planId, typeId);

    if (!material) {
      throw new Error('Material not found in plan');
    }

    // Validate: new quantity can't exceed what's needed
    if (quantity > material.quantity) {
      throw new Error(`Quantity ${quantity} exceeds plan requirement of ${material.quantity}`);
    }

    const result = db.prepare(`
      UPDATE plan_materials
      SET manually_acquired = 1,
          manually_acquired_quantity = ?,
          acquisition_method = ?,
          custom_price = ?,
          acquisition_note = ?
      WHERE plan_id = ? AND type_id = ?
    `).run(quantity, acquisitionMethod, customPrice, acquisitionNote, planId, typeId);

    if (result.changes === 0) {
      throw new Error('Material not found in plan');
    }

    console.log(`[Plans] Marked ${quantity} units of material ${typeId} as acquired for plan ${planId}`);
  } catch (error) {
    console.error('[Plans] Error marking material as acquired:', error);
    throw error;
  }
}

/**
 * Unmark a material as manually acquired (reset to default)
 * @param {string} planId - Plan ID
 * @param {number} typeId - Material type ID
 */
function unmarkMaterialAcquired(planId, typeId) {
  const db = getCharacterDatabase();

  try {
    const result = db.prepare(`
      UPDATE plan_materials
      SET manually_acquired = 0,
          manually_acquired_quantity = 0,
          acquisition_method = NULL,
          custom_price = NULL,
          acquisition_note = NULL
      WHERE plan_id = ? AND type_id = ?
    `).run(planId, typeId);

    if (result.changes === 0) {
      throw new Error('Material not found in plan');
    }

    console.log(`[Plans] Unmarked material ${typeId} as acquired for plan ${planId}`);
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

module.exports = {
  createManufacturingPlan,
  getManufacturingPlan,
  getManufacturingPlans,
  updateManufacturingPlan,
  deleteManufacturingPlan,
  addBlueprintToPlan,
  updatePlanBlueprint,
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
  getPlanAnalytics,
  markMaterialAcquired,
  unmarkMaterialAcquired,
  updateMaterialAcquisition,
  updateMaterialCustomPrice,
};
