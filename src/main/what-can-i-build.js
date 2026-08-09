/**
 * What Can I Build? — the calculation, moved out of the renderer.
 *
 * The un-ported screen priced every blueprint from the renderer, one IPC call
 * at a time, exactly as Manufacturing Summary used to. This runs the whole
 * pass in main instead: one call in, rows out, progress streamed on its own
 * channel.
 *
 * Blueprint SELECTION and CLASSIFICATION are shared with the Summary via
 * industry-shared.js. Costing is NOT shared, and deliberately so - the Summary
 * computes eight market-health metrics per product that this screen never
 * displays, and this screen filters on materials already in your hangar, which
 * the Summary knows nothing about. Sharing the row builder would mean a mode
 * flag through the hottest function on both screens.
 */

const { calculateBlueprintMaterials } = require('./blueprint-calculator');
const { getMarketSetById, getDefaultMarketSet, getDefaultCharacter } = require('./settings-manager');
const { fetchMarketHistory } = require('./esi-market');
const { aggregateAssets } = require('./cleanup-tool');
const { resolveLocationInfoMany } = require('./location-resolver');
const { getCharacters } = require('./settings-manager');

const {
  calculateProductionTime,
  determineTechLevel,
  determineCategory,
  loadFacility,
  selectBlueprints,
} = require('./industry-shared');

/** How many blueprints are priced concurrently. Carried over from the renderer. */
const BATCH_SIZE = 6;

/** The Forge, used when a market set does not name a region. */
const DEFAULT_REGION_ID = 10000002;

/** SVR lookback, fixed at 30 days on this screen. */
const SVR_PERIOD_DAYS = 30;


/**
 * How many runs the on-hand materials support, and how close to one run you are.
 *
 * `percentOnHand` is the MINIMUM across materials, not an average. That
 * distinction is the whole point of the screen: holding 100% of one material
 * and 0% of another means you can build nothing, and an average would report
 * that as 50% buildable. (`cleanup-tool.js` carried a never-wired
 * `calculateBuildableRuns` that averaged; it has been deleted rather than left
 * as a second, wrong implementation.)
 *
 * @param {Object} materials - { typeId: quantityPerRun }
 * @param {Object} assets    - { typeId: quantityOnHand }
 */
function calculateBuildable(materials, assets) {
  if (!materials || Object.keys(materials).length === 0) {
    return { buildableRuns: 0, percentOnHand: 0, materialBreakdown: [] };
  }

  let minRuns = Infinity;
  const materialBreakdown = [];

  for (const [typeId, quantityPerRun] of Object.entries(materials)) {
    const typeIdNum = parseInt(typeId, 10);
    const perRun = Number(quantityPerRun);

    // A malformed entry must not silently become "0 required", which would
    // read as infinitely buildable.
    if (Number.isNaN(typeIdNum) || Number.isNaN(perRun) || perRun <= 0) continue;

    const available = assets[typeIdNum] || 0;
    const runsFromMaterial = Math.floor(available / perRun);
    minRuns = Math.min(minRuns, runsFromMaterial);

    materialBreakdown.push({
      typeId: typeIdNum,
      required: perRun,
      available,
      runsSupported: runsFromMaterial,
      // How much of ONE run this material covers, capped so a stockpile of
      // one material cannot mask a shortage of another.
      percentForOneRun: Math.min(100, (available / perRun) * 100),
    });
  }

  if (materialBreakdown.length === 0) {
    return { buildableRuns: 0, percentOnHand: 0, materialBreakdown: [] };
  }

  const percentOnHand = materialBreakdown.reduce(
    (lowest, mat) => Math.min(lowest, mat.percentForOneRun),
    100
  );

  return {
    buildableRuns: minRuns === Infinity ? 0 : minRuns,
    percentOnHand,
    materialBreakdown,
  };
}

/**
 * Sales Velocity Ratio: units sold in the period vs units you could produce.
 *
 * Same formula as the Summary's, but this screen fixes the period at 30 days
 * and needs no other history-derived metric, so it reads history directly
 * rather than pulling in collectProductMetrics.
 */
async function calculateSVR(productTypeId, regionId, productionTimeHours) {
  if (!productTypeId || !productionTimeHours || productionTimeHours <= 0) return 0;

  try {
    const history = await fetchMarketHistory(regionId, productTypeId);
    if (!Array.isArray(history) || history.length === 0) return 0;

    const cutoff = Date.now() - (SVR_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const recent = history.filter((day) => new Date(day.date).getTime() >= cutoff);
    if (recent.length === 0) return 0;

    const totalSold = recent.reduce((sum, day) => sum + (day.volume || 0), 0);
    const periodHours = SVR_PERIOD_DAYS * 24;
    const unitsProducible = periodHours / productionTimeHours;

    return unitsProducible > 0 ? totalSold / unitsProducible : 0;
  } catch (error) {
    console.error(`[wcib] SVR failed for ${productTypeId}:`, error);
    return 0;
  }
}

/**
 * Cost one blueprint and decide whether it clears the on-hand threshold.
 *
 * Returns null for a blueprint that should not appear - below threshold,
 * unpriceable, or missing materials. The threshold check runs BEFORE pricing
 * work that is not already done, so a hangar with nothing in it costs little.
 */
async function calculateRow(blueprint, context) {
  const { facility, marketSet, characterId, threshold, assets, regionId } = context;

  const blueprintTypeId = blueprint.typeID;
  const owned = blueprint._owned || null;
  const meLevel = owned ? (owned.materialEfficiency || 0) : 0;
  const teLevel = owned ? (owned.timeEfficiency || 0) : 0;

  const result = await calculateBlueprintMaterials(
    blueprintTypeId, 1, meLevel, characterId, facility, true, 0, null, marketSet
  );

  if (!result || !result.materials) return null;

  // Cheapest meaningful filter, so it runs first.
  const buildable = calculateBuildable(result.materials, assets);
  if (buildable.percentOnHand < threshold) return null;

  if (!result.pricing) return null;
  const pricing = result.pricing;

  const productionTimeSeconds = calculateProductionTime(blueprint.baseTime, teLevel, facility);
  const productionTimeHours = productionTimeSeconds / 3600;
  const iskPerHour = productionTimeHours > 0 ? pricing.profit / productionTimeHours : 0;
  const roi = pricing.totalCosts > 0 ? (pricing.profit / pricing.totalCosts) * 100 : 0;

  const svr = await calculateSVR(blueprint.productTypeID, regionId, productionTimeHours);

  const outputValue = pricing.outputValue || {};

  return {
    blueprintTypeId,
    // Name and category describe the PRODUCT - this screen answers "what can I
    // build", so the thing being built is what belongs in the column.
    itemName: blueprint.productName || blueprint.typeName,
    blueprintName: blueprint.typeName,
    category: blueprint.productGroupName || 'Unknown',
    productTypeId: blueprint.productTypeID,
    productQuantity: (result.product && result.product.quantity) || 1,

    tech: determineTechLevel(blueprint),
    techLevel: determineTechLevel(blueprint),
    isOwned: !!owned,
    bpType: owned ? (owned.isCopy ? 'BPC' : 'BPO') : 'N/A',
    isBpc: owned ? owned.isCopy === true : false,
    meLevel,
    teLevel,

    percentOnHand: buildable.percentOnHand,
    buildableRuns: buildable.buildableRuns,
    materialBreakdown: buildable.materialBreakdown,

    profit: pricing.profit,
    iskPerHour,
    svr,
    totalCost: pricing.totalCosts,
    roi,
    productMarketPrice: outputValue.totalValue || 0,
    productionTimeHours,

    // Filled in by the batch pass in calculate().
    ownerCharacterId: owned ? (owned.characterId ?? null) : null,
    ownerName: null,
    locationId: owned ? (owned.locationId ?? null) : null,
    location: null,
    isCorporationBlueprint: owned ? owned.isCorporation === true : false,
  };
}

/**
 * Run the whole screen.
 *
 * @param {Object}   options      - filters, sources, facility, threshold
 * @param {Function} [onProgress] - streamed to the caller's frame
 * @param {Function} [isCancelled] - polled between batches; true aborts
 */
async function calculate(options = {}, onProgress = null, isCancelled = null) {
  const {
    facilityId = null,
    marketSetId = null,
    assetSources = null,
    threshold = 90,
  } = options;

  const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
  const facility = await loadFacility(facilityId);

  const defaultCharacter = getDefaultCharacter();
  const characterId = options.characterId || (defaultCharacter ? defaultCharacter.characterId : null);

  const msInput = (marketSet && marketSet.inputMaterials) || {};
  const regionId = msInput.regionId || DEFAULT_REGION_ID;

  if (onProgress) onProgress({ done: 0, total: 0, label: 'Aggregating assets…' });
  const assets = aggregateAssets(assetSources || { personal: [], corporation: [] });

  if (onProgress) onProgress({ done: 0, total: 0, label: 'Loading blueprints…' });
  // isCancelled goes in too: with "All Blueprints" plus T2 invention the
  // selection sweep is long enough that a Cancel pressed during it would
  // otherwise wait for the whole SDE before taking effect.
  const blueprints = await selectBlueprints({ ...options, isCancelled });
  const total = blueprints.length;

  if (total === 0) return { cancelled: false, rows: [], assetTypeCount: Object.keys(assets).length };

  const context = { facility, marketSet, characterId, threshold, assets, regionId };
  const rows = [];
  let done = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    /*
     * Hand the event loop a turn before checking.
     *
     * calculateBlueprintMaterials recurses up to ten levels using
     * better-sqlite3, which is SYNCHRONOUS - so awaiting it yields nothing
     * and the loop is held for the whole batch. An `ipcMain.handle` callback
     * runs on that same loop, so a `wcib:cancel` sent mid-run just queues:
     * in a measured 9.6s run the request was not serviced until 22ms AFTER
     * the final batch, by which point there was nothing left to cancel.
     *
     * setImmediate resolves in the check phase, which is enough to let any
     * pending IPC land before the flag is read.
     */
    await new Promise((resolve) => setImmediate(resolve));

    // Between batches, matching the existing screen. Mid-batch would abandon
    // pricing whose ESI calls have already been spent.
    if (isCancelled && isCancelled()) {
      const error = new Error('Calculation cancelled');
      error.cancelled = true;
      throw error;
    }

    const batch = blueprints.slice(i, Math.min(i + BATCH_SIZE, total));

    const settled = await Promise.allSettled(
      batch.map((bp) => calculateRow(bp, context))
    );

    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled' && outcome.value) {
        rows.push(outcome.value);
      } else if (outcome.status === 'rejected') {
        // One unpriceable blueprint must not lose the other hundred.
        console.error(
          `[wcib] Could not price ${batch[index] && batch[index].typeName}:`,
          outcome.reason
        );
      }
    });

    done += batch.length;
    if (onProgress) {
      onProgress({ done, total, label: `Costing blueprints (${done}/${total})` });
    }
  }

  if (onProgress && rows.length > 0) {
    onProgress({ done: total, total, label: 'Resolving owners and locations…' });
  }
  await attachOwnerAndLocation(rows);

  return { cancelled: false, rows, assetTypeCount: Object.keys(assets).length };
}

/**
 * Fill in owner name and location on owned rows, in place.
 *
 * Batched for the same reason as the Summary's equivalent: resolving locations
 * can reach ESI for structures, and resolveLocationInfoMany dedupes to DISTINCT
 * locations rather than doing the work once per row.
 */
async function attachOwnerAndLocation(rows) {
  const owned = rows.filter((row) => row.ownerCharacterId);
  if (owned.length === 0) return;

  try {
    const namesById = new Map(
      (getCharacters() || []).map((c) => [String(c.characterId), c.characterName])
    );
    owned.forEach((row) => {
      row.ownerName = namesById.get(String(row.ownerCharacterId)) || null;
    });

    const groups = new Map();
    owned.forEach((row) => {
      if (row.locationId == null) return;
      const key = `${row.ownerCharacterId}:${row.isCorporationBlueprint ? 1 : 0}`;
      if (!groups.has(key)) {
        groups.set(key, {
          characterId: row.ownerCharacterId,
          isCorporation: row.isCorporationBlueprint,
          rows: [],
        });
      }
      groups.get(key).rows.push(row);
    });

    for (const group of groups.values()) {
      const resolved = await resolveLocationInfoMany(
        group.rows.map((row) => row.locationId),
        group.characterId,
        group.isCorporation
      );
      group.rows.forEach((row) => {
        const info = resolved[row.locationId];
        if (info) row.location = info.stationName || info.systemName || null;
      });
    }
  } catch (error) {
    console.error('[wcib] Could not resolve owners/locations:', error);
  }
}

module.exports = {
  calculate,
  calculateRow,
  calculateBuildable,
  calculateSVR,
  BATCH_SIZE,
};
