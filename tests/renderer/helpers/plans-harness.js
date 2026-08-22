/**
 * Shared harness for the Manufacturing Plans UI suites.
 *
 * The Plans tests were one 4,669-line file. Jest cannot split a single file
 * across workers, so that file set the floor for the whole run's wall clock.
 * The tests now live in several files grouped by feature area, all pulling
 * their fake backend, mount and DOM helpers from here.
 *
 * The rule this screen exists to respect is binding rule 7: a plan's prices are
 * LOCKED. Everything drift-related is a read-only comparison, and the tests
 * treat "the locked number did not move" as the primary assertion rather than
 * an afterthought.
 *
 * console.error is captured and any unexpected entry FAILS the test - the
 * renderer swallows its own failures into logs, so without that guard a broken
 * panel leaves the suite green while the view is blank.
 *
 * USAGE
 *
 *   const h = require('./helpers/plans-harness');
 *   h.installHooks();
 *   const { mountView, state } = h;
 *
 * FIXTURE STATE is reached through `state`, which is a live view onto this
 * module's bindings - `state.plans = [...]` inside a test really does change
 * what the fake IPC returns. It has to be a facade rather than a plain
 * exported object: the fakes close over the bare `let` bindings, and an
 * assignment made in another module could never rebind those.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../../public/manufacturing-plans.view.html'),
  'utf8'
);

require('../../../public/shared/qf-search-select.js');
// Sets window.QFUI, the same way index.html loads it before every view
// renderer. The renderers call QFUI.withButtonBusy on each action button, so
// without this every click handler throws ReferenceError.
require('../../../public/shared/ui-helpers.js');

let characters;
let plans;
let summary;
let materials;
let drift;
let names;
let volumes;
let categories;
let marketSets;
let buildItems;
let facilities;
let planBlueprints;
let planIntermediates;
let planReactions;
let materialTree;
let planProducts;
let pendingMatches;
let confirmedJobs;
let confirmedTransactions;
let analytics;
let ledger;
let planIndustrySettings;
let priceOverrides;
let locationNames;
let divisionSettings;
let ownedBlueprint;
let productOwnedAssets;
let reactionTree;
let treeNodeDetail;
let calls;
let consoleErrors = [];
let expectedErrorPatterns = [];
let disposed;
let subscribers;

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function subscribe(channel, cb) {
  if (!subscribers[channel]) subscribers[channel] = [];
  subscribers[channel].push(cb);
  return () => {
    disposed[channel] = (disposed[channel] || 0) + 1;
    subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
  };
}

function makeApi() {
  return {
    esi: {
      getCharacters: async () => characters,
      getDefaultCharacter: async () => characters[0] || null,
      onDefaultCharacterChanged: (cb) => subscribe('default-character-changed', cb),
    },
    market: {
      getMarketSets: async () => marketSets,
      getMarketSetForTool: async () => ({ marketSet: marketSets[0] }),
      setMarketSetForTool: async (key, id) => {
        calls.push({ fn: 'setMarketSetForTool', key, id });
        return { success: true };
      },
      // Mirrors relockPlanMaterialPrice's real return shape: an envelope with
      // `overridden` telling the caller a manual override still wins.
      relockPlanMaterial: async (planId, typeId, price) => {
        calls.push({ fn: 'market.relockPlanMaterial', planId, typeId, price });
        return { success: true, overridden: false, nodesUpdated: 1 };
      },
    },
    plans: {
      getAll: async (characterId) => {
        calls.push({ fn: 'plans.getAll', characterId });
        return plans.filter((p) => String(p.characterId) === String(characterId));
      },
      getSummary: async () => summary,
      getMaterials: async (planId, includeAssets) => {
        calls.push({ fn: 'plans.getMaterials', planId, includeAssets });
        return materials;
      },
      getMaterialDrift: async (planId, marketSetId) => {
        calls.push({ fn: 'plans.getMaterialDrift', planId, marketSetId });
        return drift;
      },
      getBuildItems: async (planId) => {
        calls.push({ fn: 'plans.getBuildItems', planId });
        return buildItems;
      },
      getBlueprints: async () => planBlueprints,
      getAllIntermediates: async () => planIntermediates,
      getReactions: async () => planReactions,
      calculateReactionTree: async (planBlueprintId, runs, characterId, facility, marketSetId) => {
        calls.push({
          fn: 'plans.calculateReactionTree',
          planBlueprintId, runs, characterId, facility, marketSetId,
        });
        return reactionTree;
      },
      getMaterialTree: async () => materialTree,
      getMaterialTreeNodeDetail: async (planBlueprintId) => {
        calls.push({ fn: 'plans.getMaterialTreeNodeDetail', planBlueprintId });
        return treeNodeDetail;
      },
      removeBlueprint: async (planBlueprintId) => {
        calls.push({ fn: 'plans.removeBlueprint', planBlueprintId });
        return true;
      },
      // These two reject each other's blueprint type in main, so the view has
      // to dispatch on blueprintType - tracked separately to prove it does.
      markIntermediateBuilt: async (planBlueprintId, builtRuns) => {
        calls.push({ fn: 'plans.markIntermediateBuilt', planBlueprintId, builtRuns });
        return true;
      },
      markReactionBuilt: async (planBlueprintId, builtRuns) => {
        calls.push({ fn: 'plans.markReactionBuilt', planBlueprintId, builtRuns });
        return true;
      },
      getProductOwnedAssets: async (planId, typeId) => {
        calls.push({ fn: 'plans.getProductOwnedAssets', planId, typeId });
        return productOwnedAssets;
      },
      // The Build List edits BY TYPE, so it saves through this - NOT through
      // bulkUpdateBlueprints, which keys on planBlueprintId and rejects
      // anything else with "Blueprint undefined not found in plan".
      updateBuildItemsByType: async (planId, itemType, blueprintTypeId, updates) => {
        calls.push({
          fn: 'plans.updateBuildItemsByType', planId, itemType, blueprintTypeId, updates,
        });
        return true;
      },
      bulkUpdateBlueprints: async (planId, updates) => {
        calls.push({ fn: 'plans.bulkUpdateBlueprints', planId, updates });
        return true;
      },
      // Mirrors repairAndRecalculatePlan: reports failure in the ENVELOPE
      // (`success: false` + `error`) rather than throwing, so a mock that just
      // returned `true` would let a renderer that ignores the envelope pass.
      repairAndRecalculate: async (planId, refreshPrices) => {
        calls.push({ fn: 'plans.repairAndRecalculate', planId, refreshPrices });
        return {
          success: true,
          facilitiesRepaired: 2,
          facilitiesCleared: 0,
          sourcingNormalized: 0,
          missingFacilities: [],
        };
      },
      getProducts: async () => planProducts,
      getPendingMatches: async () => pendingMatches,
      getConfirmedJobMatches: async () => confirmedJobs,
      getConfirmedTransactionMatches: async () => confirmedTransactions,
      getAnalytics: async () => analytics,
      matchJobs: async (planId) => {
        calls.push({ fn: 'plans.matchJobs', planId });
        return [{ matchId: 'new-1' }];
      },
      matchTransactions: async (planId) => {
        calls.push({ fn: 'plans.matchTransactions', planId });
        return [{ matchId: 'new-2' }];
      },
      saveJobMatches: async (matches) => {
        calls.push({ fn: 'plans.saveJobMatches', matches });
        return true;
      },
      saveTransactionMatches: async (matches) => {
        calls.push({ fn: 'plans.saveTransactionMatches', matches });
        return true;
      },
      confirmJobMatch: async (matchId) => {
        calls.push({ fn: 'plans.confirmJobMatch', matchId });
        return true;
      },
      rejectJobMatch: async (matchId) => {
        calls.push({ fn: 'plans.rejectJobMatch', matchId });
        return true;
      },
      unlinkJobMatch: async (matchId) => {
        calls.push({ fn: 'plans.unlinkJobMatch', matchId });
        return true;
      },
      confirmTransactionMatch: async (matchId) => {
        calls.push({ fn: 'plans.confirmTransactionMatch', matchId });
        return true;
      },
      rejectTransactionMatch: async (matchId) => {
        calls.push({ fn: 'plans.rejectTransactionMatch', matchId });
        return true;
      },
      unlinkTransactionMatch: async (matchId) => {
        calls.push({ fn: 'plans.unlinkTransactionMatch', matchId });
        return true;
      },
      getLedger: async () => ledger,
      unlinkLedgerEntry: async (ledgerId) => {
        calls.push({ fn: 'plans.unlinkLedgerEntry', ledgerId });
        return true;
      },
      getIndustrySettings: async () => planIndustrySettings,
      updateIndustrySettings: async (planId, settings) => {
        calls.push({ fn: 'plans.updateIndustrySettings', planId, settings });
        return true;
      },
      updateCharacterDivisions: async (planId, characterId, divisions) => {
        calls.push({ fn: 'plans.updateCharacterDivisions', planId, characterId, divisions });
        return true;
      },
      updateCharacterBlueprintDivisions: async (planId, characterId, divisions) => {
        calls.push({
          fn: 'plans.updateCharacterBlueprintDivisions', planId, characterId, divisions,
        });
        return true;
      },
      get: async (planId) => {
        calls.push({ fn: 'plans.get', planId });
        return plans.find((p) => String(p.planId) === String(planId)) || null;
      },
      // Both mirror the real functions, which report failure by returning FALSE
      // rather than throwing - a mock hardcoded to `true` would hide a renderer
      // that never checks.
      update: async (planId, updates) => {
        calls.push({ fn: 'plans.update', planId, updates });
        return true;
      },
      delete: async (planId) => {
        calls.push({ fn: 'plans.delete', planId });
        return true;
      },
      create: async (characterId, name, description) => {
        calls.push({ fn: 'plans.create', characterId, name, description });
        // Mirrors the real flow: the plan exists immediately, and the sidebar
        // list catches up on its next read.
        const created = {
          planId: 'plan-new',
          characterId,
          planName: name || 'Auto Name',
          status: 'active',
          description,
          createdAt: Date.now(),
        };
        plans.push(created);
        return created;
      },
      addLedgerCost: async (planId, options) => {
        calls.push({ fn: 'plans.addLedgerCost', planId, options });
        return true;
      },
      addItemAcquisition: async (planId, typeId, options) => {
        calls.push({ fn: 'plans.addItemAcquisition', planId, typeId, options });
        if (options.quantity > 100000) throw new Error('Exceeds still needed');
        return true;
      },
      addBlueprint: async (planId, config) => {
        calls.push({ fn: 'plans.addBlueprint', planId, config });
        return { planBlueprintId: 'pbp-new' };
      },
      getPriceOverrides: async () => priceOverrides,
      setPriceOverride: async (planId, typeId, price) => {
        calls.push({ fn: 'plans.setPriceOverride', planId, typeId, price });
        return true;
      },
      removePriceOverride: async (planId, typeId) => {
        calls.push({ fn: 'plans.removePriceOverride', planId, typeId });
        return true;
      },
    },
    facilities: {
      getFacilities: async () => facilities,
    },
    sde: {
      // Returns ONLY the ids asked for, like the real IPC. A stub that
      // returned everything would hide a missing ensureNames() call - the
      // exact bug that produced "Type ######" across five tabs.
      getTypeNames: async (typeIds) => {
        calls.push({ fn: 'sde.getTypeNames', typeIds });
        const out = {};
        (typeIds || []).forEach((id) => {
          if (names[id]) out[id] = names[id];
        });
        return out;
      },
      getItemVolumes: async () => volumes,
      getTypeCategoryInfo: async () => categories,
    },
    calculator: {
      searchBlueprints: async (query) => {
        calls.push({ fn: 'calculator.searchBlueprints', query });
        return [{ typeID: 22546, typeName: 'Hulk Blueprint' }];
      },
      // Same resolver the Blueprint Calculator uses: BPO before BPC, then
      // highest ME, across every enabled blueprint source.
      resolveOwnedBlueprint: async (typeId) => {
        calls.push({ fn: 'calculator.resolveOwnedBlueprint', typeId });
        return ownedBlueprint;
      },
    },
    divisions: {
      getSettings: async (characterId) => {
        calls.push({ fn: 'divisions.getSettings', characterId });
        return divisionSettings[characterId]
          || { enabledDivisions: [], divisionNames: {}, hasCustomNames: false };
      },
      fetchNames: async (characterId) => {
        calls.push({ fn: 'divisions.fetchNames', characterId });
        return { success: true };
      },
    },
    location: {
      // Mirrors the shared resolver: NPC stations from the SDE, player
      // structures via ESI, both cached in main.
      resolve: async (locationId, characterId, isCorporation) => {
        calls.push({ fn: 'location.resolve', locationId, characterId, isCorporation });
        return locationNames[locationId] || { stationName: 'Unknown' };
      },
    },
  };
}

function makeCtx() {
  const disposers = [];
  return {
    track: (d) => {
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    on: (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      disposers.push(() => target.removeEventListener(type, handler, options));
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    dispose: () => disposers.forEach((d) => d()),
  };
}

let registered;

function loadRenderer() {
  jest.resetModules();
  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: () => {},
    },
  };
  require('../../../src/renderer/manufacturing-plans-view-renderer.js');
}

async function mountView(params) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = makeCtx();
  const instance = await registered.def.mount(container, params || {}, ctx);
  return { container, ctx, instance };
}

async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Mount and open the seeded plan. */
async function mountWithPlan() {
  const mounted = await mountView();
  await settle();
  document.querySelector('.mp-plan-card').dispatchEvent(new window.MouseEvent('click'));
  await settle(40);
  return mounted;
}

/**
 * Mount, open the seeded plan, and switch to `tab`.
 *
 * Every tab suite needs this, so it lives here rather than being redeclared
 * per describe block. The settle count is deliberately uniform: draining more
 * already-resolved microtasks than a tab needs is harmless, and a per-tab
 * number is a tuning knob nobody can reason about.
 */
async function openTab(tab) {
  await mountWithPlan();
  document
    .querySelector(`.tab-button[data-tab="${tab}"]`)
    .dispatchEvent(new window.MouseEvent('click'));
  await settle(30);
}

/**
 * Register the suite-wide hooks.
 *
 * Called from each test file rather than run on require, so importing the
 * harness for a single helper does not silently install hooks a file did not
 * ask for.
 */
function installHooks() {
beforeEach(() => {
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map(String).join(' '));
  });

  calls = [];
  disposed = {};
  subscribers = {};

  characters = [
    { characterId: 91316135, characterName: 'Buckwalter', portrait: 'https://example/p' },
    { characterId: 96061222, characterName: 'Alt Pilot', portrait: 'https://example/p2' },
  ];

  plans = [
    {
      planId: 'plan-1',
      characterId: 91316135,
      planName: 'Q4 Hulk Batch',
      status: 'active',
      description: 'Four exhumers.',
      createdAt: 1_700_000_000_000,
      productName: 'Hulk',
    },
    {
      planId: 'plan-2',
      characterId: 91316135,
      planName: 'Old Frigates',
      status: 'completed',
      createdAt: 1_600_000_000_000,
    },
  ];

  summary = {
    materialCost: 100_000,
    materialsWithPrice: 2,
    totalMaterials: 2,
    jobInstallationCost: 5_000,
    jobCount: 1,
    productValue: 150_000,
    productsWithPrice: 1,
    totalProducts: 1,
    estimatedProfit: 45_000,
    roi: 42.8,
  };

  // Shape verified against docs/plan-ipc-shapes.md - `quantity` not
  // `quantityNeeded`, `basePrice` not `priceEach`, and acquisition arrives
  // from three independent counters.
  materials = [
    {
      typeId: 34,
      quantity: 1000,
      basePrice: 5.0,
      planOverridePrice: null,
      priceFrozenAt: Date.now() - 3 * 24 * 3600 * 1000,
      manuallyAcquired: 1,
      manuallyAcquiredQuantity: 200,
      acquisitionMethod: 'bought',
      customPrice: null,
      purchasedQuantity: 0,
      purchaseMatchCount: 0,
      manufacturedQuantity: 0,
      manufacturingMatchCount: 0,
      ownedPersonal: 0,
      ownedCorp: 0,
    },
    {
      typeId: 35,
      quantity: 500,
      basePrice: 10.0,
      planOverridePrice: null,
      priceFrozenAt: Date.now() - 3 * 24 * 3600 * 1000,
      manuallyAcquired: 0,
      manuallyAcquiredQuantity: 0,
      acquisitionMethod: null,
      customPrice: null,
      purchasedQuantity: 0,
      purchaseMatchCount: 0,
      manufacturedQuantity: 0,
      manufacturingMatchCount: 0,
      ownedPersonal: 0,
      ownedCorp: 0,
    },
    {
      // A DIFFERENT sourcing category, so grouping is actually exercised -
      // and the only row holding stock, for the Owned columns.
      typeId: 16275,
      quantity: 400,
      basePrice: 800.0,
      planOverridePrice: null,
      priceFrozenAt: Date.now() - 3 * 24 * 3600 * 1000,
      manuallyAcquired: 0,
      manuallyAcquiredQuantity: 0,
      acquisitionMethod: null,
      customPrice: null,
      purchasedQuantity: 0,
      purchaseMatchCount: 0,
      manufacturedQuantity: 0,
      manufacturingMatchCount: 0,
      ownedPersonal: 150,
      ownedCorp: 900,
      ownedPersonalDetails: [{ characterName: 'Valen Kor', quantity: 150 }],
      ownedCorpDetails: [
        { corporationName: 'Forge Dynamics', divisionName: 'Component Stock', quantity: 900 },
      ],
    },
  ];

  // Tritanium up 20% (past the threshold), the rest flat. EVERY material
  // needs an entry: the live comparison is suppressed entirely unless the
  // whole plan is priced, so a gap here reads as "partially priced".
  drift = {
    34: { livePrice: 6.0, lockedPrice: 5.0, driftPercent: 20, driftAbsolute: 1.0 },
    35: { livePrice: 10.0, lockedPrice: 10.0, driftPercent: 0, driftAbsolute: 0 },
    16275: { livePrice: 800.0, lockedPrice: 800.0, driftPercent: 0, driftAbsolute: 0 },
  };

  // Every type the view resolves. ensureNames() asks for specific ids, so a
  // gap here surfaces as "Type ######" - exactly the reported symptom.
  names = {
    34: 'Tritanium',
    35: 'Pyerite',
    16275: 'Strontium Clathrates',
    22544: 'Hulk',
    22546: 'Hulk Blueprint',
    11399: 'Morphite',
    11400: 'Morphite Blueprint',
    46185: 'Fullerene',
    46186: 'Fullerene Reaction',
  };
  volumes = { 34: 0.01, 35: 0.01, 16275: 0.4 };
  // getTypeCategoryInfo returns SDE IDs. The SDE's own categoryName for all
  // of these is "Material" - it is the groupID that separates minerals from
  // ice from moon goo, which is why the app classifies them itself.
  categories = {
    34: { categoryID: 4, groupID: 18, categoryName: 'Material', groupName: 'Mineral' },
    35: { categoryID: 4, groupID: 18, categoryName: 'Material', groupName: 'Mineral' },
    16275: { categoryID: 4, groupID: 423, categoryName: 'Material', groupName: 'Ice Product' },
    16670: { categoryID: 4, groupID: 428, categoryName: 'Material', groupName: 'Intermediate' },
    2393: { categoryID: 43, groupID: 1032, categoryName: 'Planetary Commodities' },
  };

  marketSets = [
    { id: 'set-jita', name: 'Jita 4-4', isDefault: true },
    { id: 'set-amarr', name: 'Amarr' },
  ];

  // Mirrors getPlanBuildItems: runs/lines are only editable on a top-level
  // instance, and reactions carry null ME/TE.
  buildItems = [
    {
      // itemType is ONLY 'manufacturing' or 'reaction' - it selects the
      // blueprint_type column. `role` is what distinguishes a top-level
      // blueprint from an intermediate.
      itemType: 'manufacturing',
      blueprintTypeId: 22546,
      typeName: 'Hulk Blueprint',
      productTypeId: 22544,
      productName: 'Hulk',
      role: 'blueprint',
      instanceCount: 1,
      totalRuns: 4,
      runs: 4,
      lines: 1,
      runsEditable: true,
      topLevelPlanBlueprintId: 'pbp-1',
      meLevel: 10,
      teLevel: 20,
      useIntermediates: 'raw_materials',
      facilityId: 'fac-1',
    },
    {
      itemType: 'manufacturing',
      blueprintTypeId: 11399,
      typeName: 'Morphite Blueprint',
      productTypeId: 11399,
      productName: 'Morphite',
      role: 'intermediate',
      instanceCount: 3,
      totalRuns: 12,
      runs: null,
      lines: null,
      runsEditable: false,
      topLevelPlanBlueprintId: null,
      meLevel: 5,
      teLevel: 10,
      useIntermediates: 'components',
      facilityId: null,
    },
    {
      itemType: 'reaction',
      blueprintTypeId: 46186,
      typeName: 'Fullerene Reaction',
      productTypeId: 46185,
      productName: 'Fullerene',
      role: 'reaction',
      instanceCount: 1,
      totalRuns: 2,
      // getPlanBuildItems computes `runsEditable = !isReaction && ...`, so a
      // reaction is NEVER editable and always carries runs/lines null. The
      // fixture previously said `true`/2/1, which no real plan can produce -
      // and that is why the blank Runs column on reactions went unnoticed.
      runs: null,
      lines: null,
      runsEditable: false,
      topLevelPlanBlueprintId: null,
      meLevel: null,
      teLevel: null,
      useIntermediates: 'buy',
      facilityId: 'fac-2',
    },
  ];

  facilities = [
    { id: 'fac-1', name: 'Jita Raitaru' },
    { id: 'fac-2', name: 'Amarr Azbel' },
  ];

  // getBlueprints returns raw plan rows: no typeName, and INCLUDING
  // intermediates, which the Blueprints tab nests under their parent via
  // parentBlueprintId rather than dropping.
  planBlueprints = [
    {
      planBlueprintId: 'pbp-1',
      planId: 'plan-1',
      parentBlueprintId: null,
      blueprintTypeId: 22546,
      runs: 4,
      lines: 1,
      meLevel: 10,
      teLevel: 20,
      facilityId: 'fac-1',
      facilitySnapshot: { name: 'Jita Raitaru' },
      useIntermediates: 'raw_materials',
      isIntermediate: false,
      isBuilt: false,
      builtRuns: 0,
      blueprintType: 'manufacturing',
      // Output per run, resolved from the SDE. A ship blueprint makes one.
      productQuantityPerRun: 1,
      intermediateProductTypeId: 22544,
      addedAt: 1,
    },
    {
      planBlueprintId: 'pbp-child',
      planId: 'plan-1',
      parentBlueprintId: 'pbp-1',
      blueprintTypeId: 11400,
      runs: 12,
      lines: 1,
      meLevel: 5,
      teLevel: 10,
      // No snapshot: this row resolves its facility through the live list,
      // which is the path that used to need the Build List tab first.
      facilityId: 'fac-2',
      facilitySnapshot: null,
      useIntermediates: 'components',
      isIntermediate: true,
      isBuilt: false,
      // Partially built: 3 of 12 runs, so the badge is amber, not green.
      builtRuns: 3,
      blueprintType: 'manufacturing',
      // A component blueprint yields many per run - which is exactly why the
      // run count alone was not enough.
      productQuantityPerRun: 100,
      intermediateProductTypeId: 11399,
      addedAt: 2,
    },
  ];

  planIntermediates = [{ planBlueprintId: 'pbp-child' }];

  productOwnedAssets = {
    ownedPersonal: 500,
    ownedCorp: 200,
    personalDetails: [{ characterName: 'Valen Kor', quantity: 500 }],
    corpDetails: [
      { corporationName: 'Forge Dynamics', divisionName: 'Component Stock', quantity: 200 },
    ],
  };

  // Reactions key on reactionTypeId, NOT blueprintTypeId.
  planReactions = [
    {
      planBlueprintId: 'pbp-2',
      planId: 'plan-1',
      parentBlueprintId: null,
      reactionTypeId: 46186,
      runs: 2,
      lines: 1,
      facilityId: 'fac-2',
      facilitySnapshot: null,
      isIntermediate: false,
      isBuilt: false,
      builtRuns: 0,
      intermediateProductTypeId: 46185,
      useIntermediates: 'raw_materials',
      // main's own classification: false when this reaction's product is
      // consumed by ANOTHER reaction, i.e. it is a sub-reaction.
      isTopLevel: true,
      addedAt: 1,
    },
  ];

  // calculateReactionTree resolves its OWN names (typeName on each node) and
  // returns a NESTED tree via children, not a flat depth list.
  reactionTree = {
    materials: {},
    product: { typeID: 46185, typeName: 'Fullerene', quantity: 400, baseQuantity: 200 },
    tree: [
      {
        typeID: 46184,
        typeName: 'Fulleroferrocene',
        quantity: 9000,
        depth: 0,
        isIntermediate: true,
        hasProducer: true,
        runsNeeded: 9,
        buildPlan: 'raw_materials',
        children: [
          {
            typeID: 16644,
            typeName: 'Ceramic Powder',
            quantity: 12000,
            depth: 1,
            isIntermediate: false,
            isManufactured: false,
            hasProducer: false,
            buildPlan: 'raw_materials',
            children: [],
          },
        ],
      },
      {
        typeID: 16647,
        typeName: 'Vanadium',
        quantity: 6000,
        depth: 0,
        isIntermediate: false,
        isManufactured: true,
        hasProducer: true,
        buildPlan: 'buy',
        children: [],
      },
    ],
  };

  // getMaterialTree is the ONE plan IPC that resolves its own names - and it
  // uses quantityNeeded where the materials list uses quantity.
  materialTree = [
    {
      nodeId: 'n-1',
      typeId: 22544,
      typeName: 'Hulk',
      nodeType: 'product',
      depth: 0,
      quantityNeeded: 4,
      quantityPerRun: 1,
      runsNeeded: 4,
      meLevel: 10,
      isReaction: false,
      buildPlan: 'raw_materials',
      priceEach: 250_000_000,
      acquiredQuantity: 0,
      // Only a node with a producer has stats to expand; a raw material
      // bought from the market has nothing behind it.
      sourcePlanBlueprintId: 'pbp-1',
      children: [
        {
          nodeId: 'n-2',
          typeId: 34,
          typeName: 'Tritanium',
          nodeType: 'material',
          depth: 1,
          quantityNeeded: 1000,
          quantityPerRun: 250,
          runsNeeded: null,
          meLevel: null,
          isReaction: false,
          buildPlan: null,
          priceEach: 5,
          acquiredQuantity: 200,
          sourcePlanBlueprintId: null,
          children: [],
        },
      ],
    },
  ];

  // getMaterialTreeNodeDetail resolves its own material names, and reports
  // time in SECONDS.
  treeNodeDetail = {
    meLevel: 10,
    teLevel: 20,
    runs: 4,
    blueprintType: 'manufacturing',
    materials: [
      { typeId: 34, typeName: 'Tritanium', quantity: 1000 },
      { typeId: 35, typeName: 'Pyerite', quantity: 250 },
    ],
    time: 7320,          // 2h 2m
    jobCost: 1_500_000,
  };

  // getProducts returns type IDs only - no typeName. Names come from
  // sde.getTypeNames, which is why a missing lookup shows "Type ######".
  planProducts = [
    {
      typeId: 22544,
      quantity: 4,
      basePrice: 250_000_000,
      planOverridePrice: null,
      priceFrozenAt: 1,
      isIntermediate: false,
      intermediateDepth: 0,
    },
    {
      typeId: 11399,
      quantity: 120,
      basePrice: 12_000,
      planOverridePrice: null,
      priceFrozenAt: 1,
      isIntermediate: true,
      intermediateDepth: 1,
    },
  ];

  // Matches NEST their source object - job identity under `job`, the plan side
  // under `planBlueprint`. Nothing is flattened, and no names are resolved.
  pendingMatches = {
    jobMatches: [
      {
        matchId: 'jm-1',
        planId: 'plan-1',
        planBlueprintId: 'pbp-1',
        confidence: 0.92,
        matchReason: 'blueprint + runs + facility',
        status: 'pending',
        job: {
          jobId: 555001,
          installerId: 91316135,
          facilityId: 60003760,
          activityId: 1,
          blueprintTypeId: 22546,
          runs: 4,
          status: 'active',
          startDate: 1_700_000_000_000,
          characterId: 91316135,
          characterName: 'Buckwalter',
          isCorporation: false,
        },
        planBlueprint: { blueprintTypeId: 22546, runs: 4, meLevel: 10, teLevel: 20 },
      },
    ],
    transactionMatches: [
      {
        matchId: 'tm-1',
        planId: 'plan-1',
        transactionId: 777001,
        typeId: 34,
        matchType: 'material_buy',
        quantity: 1000,
        confidence: 0.45,
        matchReason: 'type + direction',
        status: 'pending',
        transaction: {
          transactionId: 777001,
          characterId: 91316135,
          characterName: 'Buckwalter',
          date: 1_700_000_000_000,
          typeId: 34,
          quantity: 1000,
          unitPrice: 5.5,
          isBuy: true,
        },
      },
    ],
  };

  confirmedJobs = [
    {
      matchId: 'jm-9',
      planId: 'plan-1',
      planBlueprintId: 'pbp-1',
      confidence: 1,
      status: 'confirmed',
      job: {
        jobId: 555099,
        blueprintTypeId: 22546,
        runs: 2,
        status: 'delivered',
        characterId: 91316135,
        characterName: 'Buckwalter',
      },
      planBlueprint: { blueprintTypeId: 22546, runs: 4, meLevel: 10, teLevel: 20 },
    },
  ];

  confirmedTransactions = [
    {
      matchId: 'tm-9',
      planId: 'plan-1',
      transactionId: 777099,
      typeId: 35,
      matchType: 'material_buy',
      quantity: 500,
      confidence: 1,
      status: 'confirmed',
      transaction: {
        transactionId: 777099,
        characterId: 91316135,
        characterName: 'Buckwalter',
        date: 1_700_000_000_000,
        typeId: 35,
      },
    },
  ];

  analytics = {
    progress: {
      jobs: { completed: 2, total: 4, percent: 50 },
      materials: { purchased: 750, total: 1500, percent: 50 },
      products: { sold: 1, total: 4, percent: 25 },
      overall: 42,
    },
    materialCosts: { planned: 100_000, actual: 90_000, delta: -10_000, deltaPercent: -10 },
    productValue: { planned: 150_000, actual: 160_000, delta: 10_000, deltaPercent: 6.7 },
    profit: { planned: 45_000, actual: 65_000, delta: 20_000, deltaPercent: 44.4 },
    // ROI is NOT a {planned, actual, delta} group - it is two numbers here.
    summary: { plannedROI: 42.8, actualROI: 55.0 },
  };

  ledger = {
    planId: 'plan-1',
    categories: {
      materialPurchases: {
        items: [
          {
            ledgerId: 'led-1',
            typeId: 34,
            typeName: 'Tritanium',
            quantity: 1000,
            unitPrice: 5,
            amount: 5000,
            note: 'Jita buy',
            sourceType: 'transaction',
            editable: false,
          },
        ],
        total: 5000,
      },
      // Estimated because no real job rows exist yet - the tag must say so.
      // A cost row: type_id 0 (no item), so it is named by its category. Its
      // source_type is null, which means `editable` - the case that produced
      // the "manual but Unlink" contradiction.
      jobInstallation: { items: [
        {
          ledgerId: 'led-2',
          typeId: 0,
          category: 'job_install',
          amount: 1200,
          note: null,
          sourceType: null,
          editable: true,
        },
      ], total: 1200, estimated: true },
      marketFees: { items: [], total: 0 },
      other: { items: [], total: 0 },
      productSales: { items: [], total: 0 },
    },
    totals: {
      materialPurchases: 5000,
      productSales: 0,
      jobInstallation: 1200,
      marketFees: 0,
      other: 0,
      totalSpend: 6200,
    },
    reconciliation: { plannedCost: 5000, actualSpend: 6200, delta: 1200 },
  };

  planIndustrySettings = {
    enabledDivisions: { 91316135: [1, 2] },
    defaultCharacters: [91316135],
    blueprintCharacters: [91316135],
    blueprintDivisions: { 91316135: [3] },
    reactionsAsIntermediates: false,
    lastUpdated: 1,
  };

  priceOverrides = [
    { typeId: 34, price: 7.5, lastMarketPrice: 5.25, createdAt: 1, updatedAt: 2 },
    { typeId: 35, price: 12, lastMarketPrice: null, createdAt: 1, updatedAt: 1 },
  ];

  // The resolver returns fullPath for player structures and stationName for
  // NPC stations; the view prefers fullPath.
  locationNames = {
    60003760: { stationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
  };

  // Real corp division names, as Settings > Industry stores them.
  divisionSettings = {
    91316135: {
      enabledDivisions: [1, 2],
      divisionNames: { 1: 'Production', 2: 'Minerals' },
      hasCustomNames: true,
    },
  };

  ownedBlueprint = { me: 10, te: 20, isCopy: false, isCorporation: false };

  window.electronAPI = makeApi();
  window.QFToast = { show: (message, type) => calls.push({ fn: 'toast', message, type }) };
  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  // jsdom's window.confirm throws "not implemented", and destructive actions
  // (delete plan, re-lock prices) gate on it. Reset per test so one test's
  // stub cannot leak into another and silently auto-confirm.
  window.confirm = () => false;

  document.body.innerHTML = '';
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter((e) => !expectedErrorPatterns.some((p) => p.test(e)));
  expectedErrorPatterns = [];
  console.error.mockRestore();
  document.body.innerHTML = '';

  if (unexpected.length > 0) {
    throw new Error(
      `Renderer logged ${unexpected.length} unexpected error(s):\n  ` + unexpected.join('\n  ')
    );
  }
});
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

/**
 * Live view onto the fixture bindings above.
 *
 * Accessors, not a plain object: the fakes close over the bare `let`s, so a
 * test file assigning to a copied reference could mutate but never REPLACE a
 * fixture. Going through accessors makes `state.plans = []` in a test file
 * rebind the very variable the fake reads.
 */
const state = {
  get characters() { return characters; },
  set characters(v) { characters = v; },
  get plans() { return plans; },
  set plans(v) { plans = v; },
  get summary() { return summary; },
  set summary(v) { summary = v; },
  get materials() { return materials; },
  set materials(v) { materials = v; },
  get drift() { return drift; },
  set drift(v) { drift = v; },
  get names() { return names; },
  set names(v) { names = v; },
  get volumes() { return volumes; },
  set volumes(v) { volumes = v; },
  get categories() { return categories; },
  set categories(v) { categories = v; },
  get marketSets() { return marketSets; },
  set marketSets(v) { marketSets = v; },
  get buildItems() { return buildItems; },
  set buildItems(v) { buildItems = v; },
  get facilities() { return facilities; },
  set facilities(v) { facilities = v; },
  get planBlueprints() { return planBlueprints; },
  set planBlueprints(v) { planBlueprints = v; },
  get planIntermediates() { return planIntermediates; },
  set planIntermediates(v) { planIntermediates = v; },
  get planReactions() { return planReactions; },
  set planReactions(v) { planReactions = v; },
  get materialTree() { return materialTree; },
  set materialTree(v) { materialTree = v; },
  get planProducts() { return planProducts; },
  set planProducts(v) { planProducts = v; },
  get pendingMatches() { return pendingMatches; },
  set pendingMatches(v) { pendingMatches = v; },
  get confirmedJobs() { return confirmedJobs; },
  set confirmedJobs(v) { confirmedJobs = v; },
  get confirmedTransactions() { return confirmedTransactions; },
  set confirmedTransactions(v) { confirmedTransactions = v; },
  get analytics() { return analytics; },
  set analytics(v) { analytics = v; },
  get ledger() { return ledger; },
  set ledger(v) { ledger = v; },
  get planIndustrySettings() { return planIndustrySettings; },
  set planIndustrySettings(v) { planIndustrySettings = v; },
  get priceOverrides() { return priceOverrides; },
  set priceOverrides(v) { priceOverrides = v; },
  get locationNames() { return locationNames; },
  set locationNames(v) { locationNames = v; },
  get divisionSettings() { return divisionSettings; },
  set divisionSettings(v) { divisionSettings = v; },
  get ownedBlueprint() { return ownedBlueprint; },
  set ownedBlueprint(v) { ownedBlueprint = v; },
  get productOwnedAssets() { return productOwnedAssets; },
  set productOwnedAssets(v) { productOwnedAssets = v; },
  get reactionTree() { return reactionTree; },
  set reactionTree(v) { reactionTree = v; },
  get treeNodeDetail() { return treeNodeDetail; },
  set treeNodeDetail(v) { treeNodeDetail = v; },
  get calls() { return calls; },
  set calls(v) { calls = v; },
  get disposed() { return disposed; },
  set disposed(v) { disposed = v; },
  get subscribers() { return subscribers; },
  set subscribers(v) { subscribers = v; },
  /** The view definition the renderer registered, set by loadRenderer(). */
  get registered() { return registered; },
  set registered(v) { registered = v; },
};

module.exports = {
  installHooks,
  state,
  VIEW_HTML,
  mountView,
  mountWithPlan,
  openTab,
  settle,
  allowErrors,
  subscribe,
  makeApi,
  makeCtx,
  loadRenderer,
};
