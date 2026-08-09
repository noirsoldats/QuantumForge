/**
 * Manufacturing Summary calculation engine.
 *
 * Extracted from manufacturing-summary-renderer.js during the UI port. The
 * renderer had ~1,200 lines of orchestration wedged between the DOM code: it
 * selected blueprints, priced them, ran the invention analysis and assembled
 * result rows, all while holding element references.
 *
 * Moving it here buys three things:
 *
 *   1. Every helper it calls (calculateBlueprintMaterials, getAllBlueprints,
 *      getInventionData, fetchMarketHistory) already lives in main. The
 *      renderer was reaching them through IPC one call at a time; now they are
 *      direct calls.
 *   2. The six-per-blueprint history refetch is gone. Product metrics come from
 *      `collectProductMetrics`, fed by ONE history read per product.
 *   3. It is testable without jsdom.
 *
 * The maths is carried over unchanged - this is a move, not a rewrite. Where a
 * formula appears here it matches the renderer line-for-line, and
 * tests/unit/manufacturing-summary-engine.test.js pins the ones that are easy
 * to transcribe wrong.
 */

const { calculateBlueprintMaterials, getAllReactions } = require('./blueprint-calculator');

const { getMarketSetById, getDefaultMarketSet } = require('./settings-manager');
const { getCharacters, getDefaultCharacter } = require('./settings-manager');
const { getItemVolumes } = require('./sde-database');
const { fetchMarketHistory, fetchMarketOrders } = require('./esi-market');
const { collectProductMetrics, calculateMaterialCostVolatility } = require('./manufacturing-metrics');
const { resolveLocationInfoMany } = require('./location-resolver');

/*
 * Blueprint selection and classification are shared with What Can I Build?.
 * Both screens pick and label blueprints identically; they diverge only in how
 * they COST them, which is why each keeps its own row builder.
 */
const {
  calculateProductionTime,
  determineTechLevel,
  determineCategory,
  isCorporationBlueprint,
  loadFacility,
  selectBlueprints,
  applyChipFilters,
} = require('./industry-shared');

/** How many blueprints are priced concurrently. Carried over from the renderer. */
const BATCH_SIZE = 6;

/** The Forge, used when a market set does not name a region. */
const DEFAULT_REGION_ID = 10000002;


/**
 * Price one blueprint and assemble its result row.
 *
 * @param {Object} blueprint - SDE row, possibly carrying `_owned`
 * @param {Object} context   - facility, market set, character, periods
 */
async function calculateBlueprintRow(blueprint, context) {
  const {
    facility, marketSet, characterId, svrPeriod, regionId, locationFilter,
  } = context;

  const owned = blueprint._owned || null;
  const isOwned = !!owned;
  const meLevel = owned ? (owned.materialEfficiency || 0) : 0;
  const teLevel = owned ? (owned.timeEfficiency || 0) : 0;

  const result = await calculateBlueprintMaterials(
    blueprint.typeID, 1, meLevel, characterId, facility, true, 0, null, marketSet
  );

  if (!result || !result.pricing) return null;

  const pricing = result.pricing;

  const productionTimeSeconds = calculateProductionTime(blueprint.baseTime, teLevel, facility);
  const productionTimeHours = productionTimeSeconds / 3600;
  const iskPerHour = productionTimeHours > 0 ? pricing.profit / productionTimeHours : 0;
  const roi = pricing.totalCosts > 0 ? (pricing.profit / pricing.totalCosts) * 100 : 0;

  // Fee breakdowns, read from the exact structures the pricing layer returns.
  const jcb = pricing.jobCostBreakdown || {};
  const jobCostsTotal = (jcb.jobBaseCost || 0) + (jcb.facilityTax || 0) + (jcb.sccSurcharge || 0);

  const tb = pricing.taxesBreakdown || {};
  const materialBrokerFee = tb.materialBrokerFee || 0;
  const productSellingFees = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0);
  const tradingFeesTotal = productSellingFees + materialBrokerFee;

  const outputValue = pricing.outputValue || {};

  // Volumes, batched for the whole material list.
  const materialTypeIds = Object.keys(result.materials).map((id) => parseInt(id, 10));
  const materialVolumes = await getItemVolumes(materialTypeIds).catch(() => ({}));
  let totalInputVolume = 0;
  Object.entries(result.materials).forEach(([typeId, quantity]) => {
    totalInputVolume += (materialVolumes[typeId] || 0) * quantity;
  });

  const productVolumes = await getItemVolumes([blueprint.productTypeID]).catch(() => ({}));
  const productVolume = productVolumes[blueprint.productTypeID] || 0;
  const totalOutputVolume = productVolume * (result.product ? result.product.quantity : 0);

  // ONE history read and ONE order read, shared by every product metric. The
  // renderer called six functions that each fetched this separately.
  const [history, orders] = await Promise.all([
    fetchMarketHistory(regionId, blueprint.productTypeID, false).catch(() => []),
    fetchMarketOrders(regionId, blueprint.productTypeID, locationFilter).catch(() => []),
  ]);

  const metrics = collectProductMetrics({
    history,
    orders,
    svrPeriod,
    productionTimeHours,
    profitPerUnit: pricing.profit,
  });

  // Material volatility reads the MATERIALS' histories, not the product's.
  const materialEntries = await Promise.all(
    Object.entries(result.materials).map(async ([typeId, quantity]) => {
      const parsed = parseInt(typeId, 10);
      if (!parsed) return null;
      const h = await fetchMarketHistory(regionId, parsed, false).catch(() => []);
      return { quantity, history: h };
    })
  );
  const materialCostVolatility = calculateMaterialCostVolatility(
    materialEntries.filter(Boolean), 30
  );

  const intermediateComponents = (result.breakdown && result.breakdown[0]
    && result.breakdown[0].intermediateComponents) || [];

  return {
    blueprintTypeId: blueprint.typeID,
    // Both describe the PRODUCT, not the blueprint. The summary is about what
    // you can build, so "Hulk" / "Mining Barge" is the useful pair; the old
    // values were "Hulk Blueprint" / "Mining Barge Blueprint", which repeated
    // the word Blueprint on every row and told the user nothing.
    category: blueprint.productGroupName || blueprint.category || 'Unknown',
    itemName: blueprint.productName || blueprint.typeName,
    blueprintName: blueprint.typeName,
    productTypeId: blueprint.productTypeID,
    productName: blueprint.productName,
    isOwned,
    techLevel: determineTechLevel(blueprint),
    // A speculative row is a T2 BPC you would invent, not one you hold - so it
    // is neither owned nor 'N/A'. Saying 'N/A' hid the entire point of the
    // speculative feature.
    bpType: blueprint.isSpeculativeInvention
      ? 'BPC (Invented)'
      : (isOwned ? (owned.isCopy ? 'BPC' : 'BPO') : 'N/A'),
    isSpeculative: blueprint.isSpeculativeInvention === true,
    inventionStatus: blueprint.isSpeculativeInvention ? 'Speculative' : null,
    // Owner and location come from the OWNED row. Speculative blueprints have
    // no owned row by definition, so both stay null there.
    ownerCharacterId: isOwned ? (owned.characterId ?? null) : null,
    ownerName: null,   // filled in by the batch resolve pass in calculateSummary
    locationId: isOwned ? (owned.locationId ?? null) : null,
    location: null,    // ditto
    isCorporationBlueprint: isOwned ? owned.isCorporation === true : false,
    meLevel,
    teLevel,
    profit: pricing.profit,
    iskPerHour,
    svr: metrics.svr,
    totalCost: pricing.totalCosts,
    roi,
    productionTimeHours,

    jobCosts: jobCostsTotal,
    materialPurchaseFees: materialBrokerFee,
    productSellingFees,
    tradingFeesTotal,
    blueprintType: isOwned ? (owned.isCopy ? 'BPC' : 'BPO') : 'N/A',
    productMarketPrice: outputValue.totalValue || 0,
    profitPercentage: pricing.profitMargin || 0,
    manufacturingSteps: 1 + intermediateComponents.length,
    m3Inputs: totalInputVolume,
    m3Outputs: totalOutputVolume,
    currentSellOrders: metrics.totalSellVolume,

    profitVelocity: metrics.profitVelocity,
    marketSaturation: metrics.marketSaturation,
    priceMomentum: metrics.priceMomentum,
    profitStability: metrics.profitStability,
    demandGrowth: metrics.demandGrowth,
    materialCostVolatility,
    marketHealthScore: metrics.marketHealthScore,

    ownerCharacterId: owned ? owned.characterId : null,
    locationId: owned ? owned.locationId : null,
    isCorporation: owned ? isCorporationBlueprint(owned) : false,
  };
}

/**
 * Run the whole summary.
 *
 * @param {Object} options
 * @param {Function} [onProgress] - called with { done, total, label }
 * @returns {Promise<Array>} result rows
 */
/**
 * @param {Function} [isCancelled] - polled between batches; return true to
 *        abort. Aborting throws an Error carrying `cancelled: true`.
 */
async function calculateSummary(options = {}, onProgress = null, isCancelled = null) {
  const {
    marketSetId = null,
    facilityId = null,
    svrPeriod = 30,
  } = options;

  const marketSet = marketSetId ? getMarketSetById(marketSetId) : getDefaultMarketSet();
  const facility = await loadFacility(facilityId);

  const defaultCharacter = getDefaultCharacter();
  const characterId = options.characterId || (defaultCharacter ? defaultCharacter.characterId : null);

  const msInput = (marketSet && marketSet.inputMaterials) || {};
  const regionId = msInput.regionId || DEFAULT_REGION_ID;

  // Location filter for order lookups, matching the renderer's rules.
  let locationFilter = null;
  if (msInput.locationType === 'system' && msInput.systemId) {
    locationFilter = { type: 'system', id: msInput.systemId };
  } else if (msInput.locationType === 'station' && msInput.locationId) {
    locationFilter = { type: 'station', id: msInput.locationId };
  }

  // isCancelled goes in too - see the note in what-can-i-build.js. The
  // speculative-invention sweep runs before any pricing, so without this a
  // Cancel pressed during it appears to do nothing.
  const blueprints = await selectBlueprints({ ...options, isCancelled });
  const total = blueprints.length;

  if (total === 0) return [];

  const context = { facility, marketSet, characterId, svrPeriod, regionId, locationFilter };
  const rows = [];
  let done = 0;

  // Batched rather than fully parallel: the renderer used 6 at a time, and the
  // limit matters because each blueprint fans out into material pricing.
  for (let i = 0; i < total; i += BATCH_SIZE) {
    // Give the event loop a turn so a queued summary:cancel can be serviced
    // before the flag is read - see the fuller note in what-can-i-build.js.
    // This screen's cancel usually landed anyway because its rows await more
    // often, but that was luck rather than design.
    await new Promise((resolve) => setImmediate(resolve));

    // Cancellation is checked BETWEEN batches, matching the existing screen.
    // Mid-batch would mean abandoning in-flight pricing work whose ESI calls
    // have already been spent.
    if (isCancelled && isCancelled()) {
      // Thrown rather than returned so the success path keeps returning a
      // bare array - every caller already treats the result as rows.
      const error = new Error('Calculation cancelled');
      error.cancelled = true;
      throw error;
    }

    const batch = blueprints.slice(i, Math.min(i + BATCH_SIZE, total));

    const settled = await Promise.allSettled(
      batch.map((bp) => calculateBlueprintRow(bp, context))
    );

    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled' && outcome.value) {
        rows.push(outcome.value);
      } else if (outcome.status === 'rejected') {
        // One unpriceable blueprint must not lose the other hundred.
        console.error(
          `[summary] Could not price ${batch[index] && batch[index].typeName}:`,
          outcome.reason
        );
      }
    });

    done += batch.length;
    if (onProgress) {
      onProgress({ done, total, label: `Pricing blueprints (${done}/${total})` });
    }
  }

  // Thresholds first: no point resolving locations for rows about to be
  // dropped, and location resolution can reach ESI for structures.
  const kept = applyMarketThresholds(rows, options);

  if (onProgress && kept.length > 0) {
    onProgress({ done: total, total, label: 'Resolving owners and locations…' });
  }
  await attachOwnerAndLocation(kept);

  return kept;
}

/**
 * Fill in the owner name and location label on owned rows, in place.
 *
 * Deliberately a batch pass rather than per-row work inside
 * calculateBlueprintRow: resolveLocationInfoMany dedupes to DISTINCT locations
 * and builds the asset index once, so a thousand blueprints sitting in a dozen
 * stations costs a dozen lookups rather than a thousand. Character names come
 * from settings, so they need no lookup at all.
 *
 * Failures are non-fatal - an unresolvable location leaves the column blank
 * rather than losing the whole summary.
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

    // Group by (character, corp flag): the asset index differs for each, and
    // resolveLocationInfoMany builds one index per call.
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
    console.error('[summary] Could not resolve owners/locations:', error);
  }
}

/**
 * Drop rows that fall below the market thresholds.
 *
 * These can only be applied after costing, because SVR / ISK-per-hour / profit
 * are outputs of the pricing pass. Like the chips they are calculation inputs,
 * not a live view filter: the rows are discarded here, so widening a threshold
 * requires a recalculation.
 *
 * The IPH and profit thresholds are gated on their own enable flags because 0
 * and negative values are meaningful for them - a plain null check would treat
 * "show me everything down to 0 ISK/h" as "no threshold set".
 */
function applyMarketThresholds(rows, options) {
  const {
    svrThreshold = null,
    iphEnabled = false,
    iphThreshold = null,
    profitEnabled = false,
    profitThreshold = null,
  } = options;

  return rows.filter((row) => {
    if (svrThreshold != null && (row.svr || 0) < svrThreshold) return false;
    if (iphEnabled && iphThreshold != null && (row.iskPerHour || 0) < iphThreshold) return false;
    if (profitEnabled && profitThreshold != null && (row.profit || 0) < profitThreshold) return false;
    return true;
  });
}

module.exports = {
  calculateSummary,
  selectBlueprints,
  calculateBlueprintRow,
  calculateProductionTime,
  determineTechLevel,
  determineCategory,
  applyChipFilters,
  applyMarketThresholds,
  isCorporationBlueprint,
  loadFacility,
  BATCH_SIZE,
};
