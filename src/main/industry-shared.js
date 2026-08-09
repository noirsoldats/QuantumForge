/**
 * Industry helpers shared by Manufacturing Summary and What Can I Build?.
 *
 * Both screens answer "what should I make", so they select and classify
 * blueprints identically - but they COST them differently. The Summary
 * computes eight market-health metrics per product; What Can I Build? wants
 * none of them and instead filters on materials already in your hangar.
 *
 * So the split is deliberate: everything here is a pure function or a thin
 * lookup with NO mode flags, and each screen keeps its own row builder. A fix
 * to determineTechLevel or determineCategory lands on both screens at once,
 * without either screen's costing path being able to break the other's.
 *
 * Nothing in this file reads the on-hand state or the metric tables.
 */

const {
  getAllBlueprints,
  getInventionData,
} = require('./blueprint-calculator');

const {
  getCharacters,
  getDefaultCharacter,
  getBlueprints,
  getManufacturingFacility,
} = require('./settings-manager');

const { getSystemSecurityStatus, getStructureBonuses } = require('./sde-database');

/**
 * Production time after TE and structure bonuses.
 *
 * Verbatim from the renderer: TE is 1% per level, then the structure's own
 * time-efficiency bonus. Rig time bonuses were a TODO there and remain one.
 */
function calculateProductionTime(baseTime, teLevel, facility) {
  if (!baseTime) return 0;

  let time = baseTime * (1 - (teLevel / 100));

  if (facility && facility.structureBonuses && facility.structureBonuses.timeEfficiency) {
    time = time * (1 - (facility.structureBonuses.timeEfficiency / 100));
  }

  return time;
}

/**
 * Tech level from the product's meta group.
 *
 * Verbatim from the renderer. The invMetaGroups mapping is NOT the obvious one
 * and must not be "tidied": 3 is Storyline (not T3), 4/52 collapse to 'Navy',
 * 5/6 collapse to 'Pirate', and the structure meta groups (52/53/54) map onto
 * the same labels as their ship equivalents. These strings are what the Tech
 * Level filter chips match on, so a wrong label silently empties a filter.
 */
function determineTechLevel(blueprint) {
  switch (blueprint.productMetaGroupID) {
    case 2:   // Tech II
    case 53:  // Structure Tech II
      return 'T2';
    case 14:  // Tech III
      return 'T3';
    case 3:   // Storyline
      return 'Storyline';
    case 4:   // Faction (Navy)
    case 52:  // Structure Faction
      return 'Navy';
    case 5:   // Officer
    case 6:   // Deadspace
      return 'Pirate';
    case 1:   // Tech I
    case 54:  // Structure Tech I
    default:
      return 'T1';
  }
}

/**
 * Map a blueprint's product onto one of the 14 filter categories.
 *
 * Order matters and is not alphabetical: the Rig check must run BEFORE the
 * Module check, because rigs live in the Module category but carry 'Rig' in
 * their group name - testing Module first would swallow every rig. Likewise
 * Structure Rigs are detected from either the category or the group name.
 *
 * Anything unrecognised falls through to 'Components' so it stays visible
 * rather than silently vanishing from every result set.
 */
function determineCategory(blueprint) {
  const category = blueprint.productCategoryName || '';
  const group = blueprint.productGroupName || '';

  if (category === 'Ship') return 'Ships';
  if (category === 'Drone' || category === 'Fighter') return 'Drones';

  if (group.includes('Rig')) {
    if (category === 'Structure' || group.includes('Structure')) return 'Structure Rigs';
    return 'Rigs';
  }

  if (category === 'Module') return 'Modules';
  if (category === 'Charge') return 'Ammo/Charges';
  if (category === 'Subsystem') return 'Subsystems';
  if (category === 'Deployable') return 'Deployables';
  if (category === 'Structure Module') return 'Structure Modules';
  if (category === 'Structure') return 'Structures';
  if (category === 'Implant' && group.includes('Booster')) return 'Boosters';
  if (category === 'Reaction') return 'Reactions';
  if (category === 'Celestial' || category === 'Starbase' || category === 'Station') return 'Celestials';

  return 'Components';
}

/** True when a blueprint row belongs to a corporation rather than a character. */
function isCorporationBlueprint(bp) {
  if (bp.isCorporation) return true;
  const flag = bp.locationFlag || '';
  return flag.startsWith('CorpSAG') || flag.startsWith('CorpDeliveries');
}

/**
 * Load a facility with the bonuses the calculator needs.
 * Mirrors what the calculator:calculateMaterials handler does per call, but
 * once per run instead of once per blueprint.
 */
async function loadFacility(facilityId) {
  if (!facilityId) return null;

  const facility = getManufacturingFacility(facilityId);
  if (!facility) return null;

  if (facility.systemId) {
    facility.securityStatus = await getSystemSecurityStatus(facility.systemId).catch(() => null);
  }
  if (facility.structureTypeId) {
    facility.structureBonuses = await getStructureBonuses(facility.structureTypeId).catch(() => null);
  }

  return facility;
}

/**
 * Every blueprint the current filter selects.
 *
 * Returns SDE blueprint rows, with owned ones carrying an `_owned` reference so
 * the caller does not have to look them up again.
 */
async function selectBlueprints(options) {
  const {
    blueprintFilter = 'owned',
    characterFilter = 'all',
    characterId = null,
    speculativeInvention = false,
    techLevels = null,
    categories = null,
    // Polled during the speculative-invention sweep, which can be long enough
    // that a Cancel pressed there would otherwise seem to do nothing.
    isCancelled = null,
  } = options;

  const allBlueprints = await getAllBlueprints(null);

  if (blueprintFilter === 'all') {
    return filterAndAddSpeculative(allBlueprints, allBlueprints, {
      speculativeInvention, techLevels, categories, isCancelled,
    });
  }

  // Which characters' blueprints count.
  let characterIds = [];
  if (characterFilter === 'all') {
    characterIds = (getCharacters() || []).map((c) => c.characterId);
  } else if (characterFilter === 'default') {
    const def = getDefaultCharacter();
    if (!def) throw new Error('No default character is set. Choose one in Settings.');
    characterIds = [def.characterId];
  } else if (characterFilter === 'specific') {
    if (!characterId) throw new Error('Select a character first.');
    characterIds = [characterId];
  }

  const owned = [];
  characterIds.forEach((id) => {
    try {
      owned.push(...(getBlueprints(id) || []));
    } catch (error) {
      console.error(`[summary] Could not read blueprints for character ${id}:`, error);
    }
  });

  const wantCorp = blueprintFilter === 'corp';
  const matching = owned.filter((bp) => (wantCorp ? isCorporationBlueprint(bp) : !isCorporationBlueprint(bp)));

  if (matching.length === 0) {
    return [];
  }

  /*
   * Join the owned rows onto the SDE definitions. Keeping the owned row on the
   * blueprint avoids a second lookup per blueprint during pricing.
   *
   * When several copies of the same blueprint are owned, take the HIGHEST ME.
   * That is the one a sane industrialist would actually use, and it is what
   * What Can I Build? has always done; the Summary previously took whichever
   * copy came first, so owning a ME 0 and a ME 10 Hulk BPO could cost the job
   * against the ME 0 copy purely by list order.
   */
  const bestByType = new Map();
  matching.forEach((row) => {
    const existing = bestByType.get(row.typeId);
    if (!existing || (row.materialEfficiency || 0) > (existing.materialEfficiency || 0)) {
      bestByType.set(row.typeId, row);
    }
  });

  const selected = allBlueprints
    .filter((bp) => bestByType.has(bp.typeID))
    .map((bp) => ({ ...bp, _owned: bestByType.get(bp.typeID) || null }));

  return filterAndAddSpeculative(selected, allBlueprints, {
    speculativeInvention, techLevels, categories, isCancelled,
  });
}

/**
 * Apply the chip filters around the speculative-invention step.
 *
 * Order matches the live screen: speculative T2s are added to the selection
 * and THEN filtered, so deselecting T2 also removes the speculative ones.
 *
 * The pre-filter is an optimisation on top of that, not a change to it. Each
 * T1 costs a getInventionData() call - a synchronous SDE read that opens its
 * own connection - so looking up T1s whose CATEGORY the user deselected is
 * pure waste. Category is safe to pre-filter because a T2 shares its parent
 * T1's product category; tech level is NOT, since the whole point is turning
 * a T1 into a T2, so that filter can only run afterwards.
 */
async function filterAndAddSpeculative(selected, allBlueprints, options) {
  const { speculativeInvention, techLevels, categories, isCancelled = null } = options;

  if (!speculativeInvention) {
    return applyChipFilters(selected, techLevels, categories);
  }

  const candidates = applyChipFilters(selected, null, categories);
  const withSpec = await maybeAddSpeculative(candidates, allBlueprints, true, isCancelled);
  return applyChipFilters(withSpec, techLevels, categories);
}

/**
 * Narrow the blueprint list to the selected tech levels and categories.
 *
 * Runs AFTER speculative invention so an invented T2 still has to pass the
 * tech chips - otherwise deselecting T2 would silently keep the speculative
 * ones. A null/absent list means "no chip filtering" rather than "nothing
 * selected", so callers that omit them (tests, older payloads) are unaffected.
 */
function applyChipFilters(blueprints, techLevels, categories) {
  const techSet = Array.isArray(techLevels) && techLevels.length > 0 ? new Set(techLevels) : null;
  const catSet = Array.isArray(categories) && categories.length > 0 ? new Set(categories) : null;
  if (!techSet && !catSet) return blueprints;

  return blueprints.filter((bp) => {
    if (techSet && !techSet.has(determineTechLevel(bp))) return false;
    if (catSet && !catSet.has(determineCategory(bp))) return false;
    return true;
  });
}

/**
 * Add the T2 blueprints invented from the selected T1s.
 *
 * Verbatim behaviour: only T1 blueprints (meta group 1) are considered, the T2
 * is skipped when it is already in the list, and each addition is marked so the
 * pricing path knows to run the invention analysis.
 */
async function maybeAddSpeculative(selected, allBlueprints, enabled, isCancelled = null) {
  if (!enabled) return selected;

  const speculative = [];

  for (const blueprint of selected) {
    if (blueprint.productMetaGroupID !== 1) continue;

    /*
     * Cancellation is checked HERE as well as in the caller's pricing loop.
     * With "All Blueprints" this runs one getInventionData() SDE read per T1
     * in the whole database - a long stretch that happens BEFORE any pricing
     * begins, so a Cancel pressed during it appeared to do nothing at all.
     */
    // getInventionData is a synchronous SDE read, so this loop holds the
    // event loop exactly as the pricing batches do. Yield first, or a queued
    // cancel cannot be serviced until the whole sweep finishes.
    await new Promise((resolve) => setImmediate(resolve));

    if (isCancelled && isCancelled()) {
      const error = new Error('Calculation cancelled');
      error.cancelled = true;
      throw error;
    }

    try {
      const invention = await getInventionData(blueprint.typeID);
      if (!invention || !invention.t2BlueprintTypeID) continue;

      const already = selected.some((bp) => bp.typeID === invention.t2BlueprintTypeID);
      if (already) continue;

      const t2 = allBlueprints.find((bp) => bp.typeID === invention.t2BlueprintTypeID);
      if (t2) {
        speculative.push({
          ...t2,
          isSpeculativeInvention: true,
          parentT1BlueprintTypeID: blueprint.typeID,
        });
      }
    } catch (error) {
      console.error(`[summary] Invention lookup failed for ${blueprint.typeName}:`, error);
    }
  }

  return speculative.length > 0 ? [...selected, ...speculative] : selected;
}

module.exports = {
  calculateProductionTime,
  determineTechLevel,
  determineCategory,
  isCorporationBlueprint,
  loadFacility,
  selectBlueprints,
  applyChipFilters,
};
