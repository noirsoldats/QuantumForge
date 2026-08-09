/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans shell view - SLICE 1 (sidebar, header, tabs, Overview,
 * Materials).
 *
 * The rule this screen exists to respect is binding rule 7: a plan's prices are
 * LOCKED. Everything drift-related here is a read-only comparison, and the
 * tests below treat "the locked number did not move" as the primary assertion
 * rather than an afterthought.
 *
 * console.error is captured and any unexpected entry FAILS the test - the
 * renderer swallows its own failures into logs, so without that guard a broken
 * panel leaves the suite green while the view is blank.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/manufacturing-plans.view.html'),
  'utf8'
);

require('../../public/shared/qf-search-select.js');

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
  require('../../src/renderer/manufacturing-plans-view-renderer.js');
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
      runs: 2,
      lines: 1,
      runsEditable: true,
      topLevelPlanBlueprintId: 'pbp-2',
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

describe('registration', () => {
  test('registers as a native shell view, not a separate window', () => {
    expect(registered.id).toBe('manufacturing-plans');
    expect(typeof registered.def.mount).toBe('function');
  });
});

describe('mount', () => {
  test('renders the view and starts with no plan selected', async () => {
    const { container } = await mountView();
    await settle();

    expect(container.querySelector('#mp-view')).not.toBeNull();
    expect(document.getElementById('no-plan-selected').hidden).toBe(false);
    expect(document.getElementById('plan-detail').hidden).toBe(true);
  });

  test('every element toggled by `hidden` is hideable by CSS (rule 6a)', () => {
    // jsdom applies no stylesheets, so el.hidden proves nothing about what the
    // user sees. Assert against the real CSS instead.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );
    expect(css).toMatch(/#mp-view\s*\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('materials are a real <table>, not divs pretending to be one', async () => {
    // This is tabular data, and the browser's table layout sizes every
    // column across ALL rows at once - the one thing per-row grids cannot
    // do, and the reason column alignment kept fighting us here.
    await openTab('materials');

    const table = document.getElementById('mp-materials-table');
    expect(table.tagName).toBe('TABLE');
    expect(table.querySelector('thead')).not.toBeNull();
    expect(table.querySelector('tbody')).not.toBeNull();
    expect(table.querySelector('tfoot')).not.toBeNull();
  });

  test('header cells are <th scope="col">', async () => {
    await openTab('materials');

    const ths = document.querySelectorAll('#mp-materials-header th');
    expect(ths.length).toBe(10);
    expect(ths[0].getAttribute('scope')).toBe('col');
    expect(ths[0].textContent).toBe('Material');
  });

  test('rows are <tr> of <td>, one cell per column', async () => {
    await openTab('materials');

    const row = document.querySelector('#mp-materials-body tr.mp-materials-row');
    expect(row.tagName).toBe('TR');
    expect(row.querySelectorAll('td')).toHaveLength(10);
  });

  test('a group heading spans every column', async () => {
    // colspan, natively - not a grid-column hack.
    await openTab('materials');

    const cell = document.querySelector('#mp-materials-body .mp-mat-group-row td');
    expect(cell.colSpan).toBe(10);
    expect(cell.querySelector('.mp-mat-group')).not.toBeNull();
  });

  test('the column count follows Show Owned', async () => {
    await openTab('materials');
    const toggle = document.getElementById('mp-show-owned');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await settle(30);

    expect(document.querySelectorAll('#mp-materials-header th')).toHaveLength(12);
    expect(
      document.querySelector('#mp-materials-body tr.mp-materials-row').querySelectorAll('td')
    ).toHaveLength(12);
    expect(document.querySelector('#mp-materials-body .mp-mat-group-row td').colSpan).toBe(12);
  });

  test('a table wider than the pane scrolls instead of being clipped', () => {
    // The frame carried `overflow: hidden`, so anything past the pane edge
    // was cut off with no way to reach it. The scroller is the element
    // OUTSIDE the frame; the frame must grow to the table, and the scroller
    // needs min-width:0 or it stretches rather than scrolling.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );

    const frame = css.match(/#mp-view\s+\.mp-materials-frame\s*\{[^}]*\}/)[0];
    expect(frame).not.toMatch(/overflow/);
    expect(frame).toMatch(/width:\s*max-content/);

    const scroll = css.match(/#mp-view\s+\.mp-materials-scroll\s*\{[^}]*\}/)[0];
    expect(scroll).toMatch(/overflow:\s*auto/);
    expect(scroll).toMatch(/min-width:\s*0/);

    const table = css.match(/#mp-view\s+\.mp-materials-table\s*\{[^}]*\}/)[0];
    expect(table).toMatch(/min-width:\s*max-content/);
  });

  test('the table sets no explicit column widths', () => {
    // The browser sizes columns from content. Only the name column is
    // capped, so a long name ellipses rather than crowding the figures.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );
    const rule = css.match(/#mp-view\s+\.mp-materials-table\s*\{[^}]*\}/g).join('');
    // No FIXED floor - a 1200px min-width added empty space and pushed the
    // far columns off screen. `min-width: max-content` is different: it is
    // the content's own width, and is what lets the table overflow into its
    // scroller rather than being squeezed.
    expect(rule).not.toMatch(/min-width:\s*\d/);
    expect(rule).toMatch(/table-layout:\s*auto/);
    expect(css).toMatch(/\.mp-col-name\s*\{[^}]*max-width:\s*320px/);
  });

  test('the material name is a shrinkable flex, not inline-flex', () => {
    // An inline-flex sizes to its content and refused to shrink, so the icon
    // plus a long name overflowed the cell and printed over the next column.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );
    const rule = css.match(/#mp-view\s+\.mp-mat-name\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).not.toMatch(/inline-flex/);
    expect(rule).toMatch(/min-width:\s*0/);
  });

  test('a truncated material name is recoverable on hover', async () => {
    // Capping the column means long names ellipsis - the full name has to
    // stay reachable.
    await openTab('materials');

    const cell = document.querySelector('#mp-materials-body .mp-mat-name span[title]');
    expect(cell.title).toBe('Tritanium');
  });

  test('the character picker is a QFSearchSelect (rule 5)', async () => {
    // Searchable: a user can have many characters.
    await mountView();
    await settle();

    expect(document.querySelector('#mp-character-host .qf-ss-trigger')).not.toBeNull();
  });

  test('the market picker is a plain select', async () => {
    // A short list of the user's own market sets - searching a handful of
    // names is friction rather than help.
    await mountView();
    await settle();

    expect(document.querySelector('#mp-market-host select')).not.toBeNull();
    expect(document.querySelector('#mp-market-host .qf-ss-trigger')).toBeNull();
  });

  test('lists the plans for the default character only', async () => {
    plans.push({
      planId: 'plan-other',
      characterId: 96061222,
      planName: 'Alt Plan',
      status: 'active',
      createdAt: 1,
    });
    await mountView();
    await settle();

    const cards = document.querySelectorAll('.mp-plan-card');
    expect(cards).toHaveLength(2);
    expect(document.getElementById('plans-list').textContent).not.toContain('Alt Plan');
  });
});

describe('plan list filtering', () => {
  test('search narrows the list', async () => {
    await mountView();
    await settle();

    const search = document.getElementById('plan-search');
    search.value = 'Hulk';
    search.dispatchEvent(new window.Event('input'));

    const cards = document.querySelectorAll('.mp-plan-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Q4 Hulk Batch');
  });

  test('status filter narrows the list', async () => {
    await mountView();
    await settle();

    document
      .querySelector('.mp-status-filter[data-mp-status="completed"]')
      .dispatchEvent(new window.MouseEvent('click'));

    const cards = document.querySelectorAll('.mp-plan-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Old Frigates');
  });

  test('the active filter is marked exclusively', async () => {
    await mountView();
    await settle();

    document
      .querySelector('.mp-status-filter[data-mp-status="active"]')
      .dispatchEvent(new window.MouseEvent('click'));

    const active = document.querySelectorAll('.mp-status-filter.is-active');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-mp-status')).toBe('active');
  });
});

describe('plan selection', () => {
  test('selecting a plan reveals the detail pane', async () => {
    await mountWithPlan();

    expect(document.getElementById('no-plan-selected').hidden).toBe(true);
    expect(document.getElementById('plan-detail').hidden).toBe(false);
    expect(document.getElementById('plan-name').textContent).toBe('Q4 Hulk Batch');
  });

  test('the selected card is marked', async () => {
    await mountWithPlan();

    const selected = document.querySelectorAll('.mp-plan-card.is-selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-plan-id')).toBe('plan-1');
  });

  test('opens on Overview', async () => {
    await mountWithPlan();

    expect(document.getElementById('overview-tab').classList.contains('active')).toBe(true);
    expect(
      document.querySelector('.tab-button[data-tab="overview"]').classList.contains('active')
    ).toBe(true);
  });
});

describe('overview', () => {
  test('renders the locked cost basis', async () => {
    await mountWithPlan();

    expect(document.getElementById('mp-stat-material-cost').textContent).toContain('100,000');
    expect(document.getElementById('mp-stat-product-value').textContent).toContain('150,000');
    expect(document.getElementById('mp-stat-profit').textContent).toContain('45,000');
  });

  test('shows the drift banner when a material has moved past the threshold', async () => {
    await mountWithPlan();

    const banner = document.getElementById('mp-drift-banner');
    expect(banner.hidden).toBe(false);
    expect(document.getElementById('mp-drift-banner-head').textContent).toContain('1 material');
  });

  test('hides the drift banner when nothing has moved', async () => {
    drift = {
      34: { livePrice: 5.0, lockedPrice: 5.0, driftPercent: 0, driftAbsolute: 0 },
      35: { livePrice: 10.0, lockedPrice: 10.0, driftPercent: 0, driftAbsolute: 0 },
    };
    await mountWithPlan();

    expect(document.getElementById('mp-drift-banner').hidden).toBe(true);
  });

  test('the live-cost comparison is a number, never NaN', async () => {
    // liveMaterialCost multiplied by the wrong field name, so this rendered
    // "NaN% if re-priced live".
    await mountWithPlan();

    const drift = document.getElementById('mp-stat-cost-drift');
    expect(drift.hidden).toBe(false);
    expect(drift.textContent).not.toContain('NaN');
    expect(drift.textContent).toMatch(/[+-]?\d+\.\d%/);
  });

  test('live-cost profit shows a figure, not a dash', async () => {
    await mountWithPlan();

    const profitLive = document.getElementById('mp-stat-profit-live');
    expect(profitLive.hidden).toBe(false);
    expect(profitLive.textContent).not.toContain('—');
    expect(profitLive.textContent).toMatch(/[\d,]+\.\d{2}/);
  });

  test('a partially-priced plan shows no live comparison at all', async () => {
    // A partial total understates the comparison; better to show nothing than
    // "-40%" computed from half the materials.
    drift = { 34: { livePrice: 6, lockedPrice: 5, driftPercent: 20, driftAbsolute: 1 } };
    await mountWithPlan();

    expect(document.getElementById('mp-stat-cost-drift').hidden).toBe(true);
    expect(document.getElementById('mp-stat-profit-live').hidden).toBe(true);
  });

  test('drift NEVER changes the displayed locked cost', async () => {
    // The core guarantee: a 20% market move leaves the plan's cost basis alone.
    await mountWithPlan();

    expect(document.getElementById('mp-stat-material-cost').textContent).toContain('100,000');
    // ...and the live comparison is shown SEPARATELY.
    expect(document.getElementById('mp-stat-cost-drift').hidden).toBe(false);
  });
});

describe('materials', () => {
  test('renders a row per material, grouped by category', async () => {
    await openTab('materials');

    expect(document.querySelectorAll('#mp-materials-body .mp-mat-group')).toHaveLength(2);
    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row')).toHaveLength(3);
  });

  test('groups by EVE sourcing category, not the raw SDE category name', async () => {
    // The SDE calls Tritanium's category "Material", which lumps minerals,
    // ice, moon goo and salvage into one meaningless bucket. The groupID is
    // what separates them.
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings[0]).toContain('Minerals');
    expect(headings[1]).toContain('Ice Products');
    expect(headings.join(' ')).not.toContain('Material ');
  });

  test('categories appear in sourcing order, not insertion order', async () => {
    // Minerals before Ice Products regardless of which material came first.
    materials.reverse();
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings[0]).toContain('Minerals');
    expect(headings[1]).toContain('Ice Products');
  });

  test('an unclassifiable material falls into Other', async () => {
    categories[16275] = { categoryID: 9999, groupID: 9999 };
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings.some((h) => h.includes('Other'))).toBe(true);
  });

  test('empty categories are not rendered', async () => {
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings.some((h) => h.includes('Planetary Materials'))).toBe(false);
  });

  describe('acquisition pills', () => {
    test('distinguishes a manual ledger entry from a confirmed ESI match', async () => {
      // These are DIFFERENT sources and both can be true at once. Styled
      // alike they read as one thing duplicated.
      materials[0].acquisitionMethod = 'purchased';
      materials[0].purchaseMatchCount = 3;
      materials[0].purchasedQuantity = 750;
      await openTab('materials');

      const row = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0];
      expect(row.querySelectorAll('.mp-acq-manual')).toHaveLength(1);
      expect(row.querySelectorAll('.mp-acq-esi')).toHaveLength(1);
    });

    test('each pill says where it came from', async () => {
      materials[0].acquisitionMethod = 'purchased';
      materials[0].purchaseMatchCount = 3;
      materials[0].purchasedQuantity = 750;
      await openTab('materials');

      const row = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0];
      expect(row.querySelector('.mp-acq-manual').title).toContain("ledger");
      expect(row.querySelector('.mp-acq-esi').title).toContain('wallet transaction');
      expect(row.querySelector('.mp-acq-esi').title).toContain('750');
    });

    test('a built match reads as an industry job, not a purchase', async () => {
      materials[0].acquisitionMethod = null;
      materials[0].purchaseMatchCount = 0;
      materials[0].manufacturingMatchCount = 1;
      materials[0].manufacturedQuantity = 200;
      await openTab('materials');

      const pill = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0]
        .querySelector('.mp-acq-esi');
      expect(pill.textContent).toBe('1 built');
      // Singular, because there is exactly one.
      expect(pill.title).toContain('1 confirmed industry job matched');
    });

    test('pills stack vertically so two do not widen the column', () => {
      // Side by side - even wrapping - the column sizes to the widest LINE,
      // so a second pill doubled the column width for every row in the
      // table. Stacked, it only has to fit the widest single pill.
      const css = fs.readFileSync(
        path.join(__dirname, '../../public/manufacturing-plans-view.css'),
        'utf8'
      );
      const rule = css.match(/#mp-view\s+\.mp-acq-cell\s*\{[^}]*\}/)[0];
      expect(rule).toMatch(/flex-direction:\s*column/);
      expect(rule).not.toMatch(/flex-wrap/);
      // Without this the pills stretch to the full column width.
      expect(rule).toMatch(/align-items:\s*center/);
    });

    test('a material with nothing recorded reads "Not Acquired"', async () => {
      materials[0].acquisitionMethod = null;
      materials[0].purchaseMatchCount = 0;
      await openTab('materials');

      const row = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0];
      expect(row.querySelector('.mp-acq-none').textContent).toBe('Not Acquired');
      expect(row.querySelector('.mp-acq-pill')).toBeNull();
    });
  });

  test('renders real names, never "Type ######"', async () => {
    // No plan IPC resolves names; a missing ensureNames() call showed raw ids
    // across five tabs.
    await openTab('materials');

    const text = document.getElementById('mp-materials-body').textContent;
    expect(text).toContain('Tritanium');
    expect(text).not.toMatch(/Type \d+/);
  });

  test('quantity and locked price come from the REAL field names', async () => {
    // quantity (not quantityNeeded) and basePrice (not priceEach). Reading the
    // wrong names produced blank columns and NaN totals.
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    expect(row.textContent).toContain('1,000');   // quantity
    expect(row.textContent).toContain('5.00');    // basePrice
    expect(row.textContent).not.toContain('NaN');
  });

  test('still-needed subtracts ALL acquisition sources', async () => {
    // Manual + purchased + manufactured. Counting one over-reports what is
    // left to buy.
    materials[0].manuallyAcquiredQuantity = 100;
    materials[0].purchasedQuantity = 250;
    materials[0].manufacturedQuantity = 50;
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    // 1000 - (100 + 250 + 50) = 600
    expect(row.textContent).toContain('600');
  });

  describe('inline price override editing', () => {
    async function startEdit() {
      await openTab('materials');
      document
        .querySelector('[data-mp-price-type="34"]')
        .dispatchEvent(new window.MouseEvent('click'));
      return document.querySelector('[data-mp-price-type="34"] .mp-price-input');
    }

    test('clicking the locked price opens an editor seeded with it', async () => {
      const input = await startEdit();
      expect(input).not.toBeNull();
      expect(parseFloat(input.value)).toBe(5);
    });

    test('an UNCHANGED value writes nothing', async () => {
      // Pinning an override equal to the locked price would survive future
      // re-locks for no reason.
      const input = await startEdit();
      input.value = '5';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(20);

      expect(calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
    });

    test('a changed value writes the override', async () => {
      const input = await startEdit();
      input.value = '9.75';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(30);

      const call = calls.find((c) => c.fn === 'plans.setPriceOverride');
      expect(call.typeId).toBe(34);
      expect(call.price).toBe(9.75);
    });

    test('Escape abandons the edit without writing', async () => {
      const input = await startEdit();
      input.value = '999';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      await settle(20);

      expect(calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
      // ...and the original value is back on screen.
      expect(document.querySelector('[data-mp-price-type="34"]').textContent).toContain('5.00');
    });

    test('clearing the field removes an EXISTING override', async () => {
      materials[0].planOverridePrice = 9.75;
      const input = await startEdit();
      input.value = '';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(30);

      expect(calls.find((c) => c.fn === 'plans.removePriceOverride').typeId).toBe(34);
    });

    test('clearing a field with no override is a no-op', async () => {
      const input = await startEdit();
      input.value = '';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(20);

      expect(calls.some((c) => c.fn === 'plans.removePriceOverride')).toBe(false);
      expect(calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
    });

    test('a zero or negative price is rejected', async () => {
      const input = await startEdit();
      input.value = '0';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(20);

      expect(calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
      expect(calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
    });
  });

  test('a plan price override REPLACES the locked market price', async () => {
    // Showing basePrice for an overridden material misreports the plan's own
    // cost basis - the one number this screen exists to protect.
    materials[0].planOverridePrice = 9.75;
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    expect(row.textContent).toContain('9.75');
    expect(row.querySelector('.mp-overridden')).not.toBeNull();
    // 1000 x 9.75, not 1000 x 5.00
    expect(row.textContent).toContain('9,750');
  });

  test('shows locked and live prices in separate columns', async () => {
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    const cells = row.querySelectorAll('span');
    const text = row.textContent;

    expect(text).toContain('Tritanium');
    // Locked 5.00 and live 6.00 both present, and distinct.
    expect(text).toContain('5.00');
    expect(text).toContain('6.00');
    expect(cells.length).toBeGreaterThan(0);
  });

  test('drift is shown as a percentage with direction', async () => {
    await openTab('materials');

    const drifts = document.querySelectorAll('#mp-materials-body .mp-drift');
    expect(drifts[0].textContent).toBe('+20.0%');
    // Up is bad for something you still have to buy.
    expect(drifts[0].classList.contains('is-up')).toBe(true);
    expect(drifts[1].classList.contains('is-flat')).toBe(true);
  });

  test('a material with no drift data shows an em dash, not 0%', async () => {
    // "Could not price" and "has not moved" are different answers.
    drift = {};
    await openTab('materials');

    const drifts = document.querySelectorAll('#mp-materials-body .mp-drift');
    expect(drifts[0].textContent).toBe('—');
  });

  test('totals the locked cost, live cost and volume', async () => {
    await openTab('materials');

    // locked: 1000*5 + 500*10 + 400*800 = 330,000
    expect(document.getElementById('mp-total-locked').textContent).toContain('330,000');
    // live:   1000*6 + 500*10 + 400*800 = 331,000
    expect(document.getElementById('mp-total-live').textContent).toContain('331,000');
    expect(document.getElementById('mp-total-m3').textContent).toContain('m³');
  });

  test('collapsing a category hides its rows but keeps the header', async () => {
    await openTab('materials');

    // Collapse the first group only; the second stays open, which is what
    // proves collapse is per-category rather than global.
    document
      .querySelector('#mp-materials-body .mp-mat-group')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(document.querySelectorAll('#mp-materials-body .mp-mat-group')).toHaveLength(2);
    const rows = document.querySelectorAll('#mp-materials-body .mp-materials-row');
    // Minerals' two rows are gone; Ice Products' single row remains.
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Strontium Clathrates');
  });

  test('"Show Owned" re-reads materials with the flag set', async () => {
    await openTab('materials');
    calls.length = 0;

    const toggle = document.getElementById('mp-show-owned');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.getMaterials');
    expect(call.includeAssets).toBe(true);
  });

  describe('Show Owned columns', () => {
    async function showOwned() {
      await openTab('materials');
      const toggle = document.getElementById('mp-show-owned');
      toggle.checked = true;
      toggle.dispatchEvent(new window.Event('change'));
      await settle(30);
    }

    test('adds the two Owned columns to the header', async () => {
      // Re-reading with the flag set is not enough - the data has to land in
      // columns, which is what was missing.
      const header = () => document.getElementById('mp-materials-header').textContent;
      await openTab('materials');
      expect(header()).not.toContain('Owned');

      await showOwned();
      expect(header()).toContain('Owned (Personal)');
      expect(header()).toContain('Owned (Corp)');
    });

    test('shows the personal and corp quantities per row', async () => {
      await showOwned();

      const cells = document.querySelectorAll(
        '#mp-materials-body .mp-materials-row .mp-owned-cell'
      );
      // Three rows x two owned columns.
      expect(cells).toHaveLength(6);
      const texts = Array.from(cells).map((c) => c.textContent);
      expect(texts).toContain('150');
      expect(texts).toContain('900');
    });

    test('breaks the holdings down by holder on hover', async () => {
      // The total does not say WHERE the stock is, which is what decides
      // whether it can actually be used.
      await showOwned();

      const withTip = Array.from(
        document.querySelectorAll('#mp-materials-body .mp-owned-cell')
      ).filter((c) => c.classList.contains('mp-has-tooltip'));

      expect(withTip).toHaveLength(2);
      expect(withTip[0].title).toContain('Valen Kor: 150');
      expect(withTip[1].title).toContain('Forge Dynamics - Component Stock: 900');
    });

    test('a row holding nothing gets no hover breakdown', async () => {
      await showOwned();

      const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
      const owned = row.querySelectorAll('.mp-owned-cell');
      expect(owned[0].textContent).toBe('0');
      expect(owned[0].classList.contains('mp-has-tooltip')).toBe(false);
    });

    test('the header, rows and totals keep the same column count', async () => {
      // A mismatch shifts every figure into the wrong column.
      await showOwned();

      expect(document.querySelectorAll('#mp-materials-header th')).toHaveLength(12);
      expect(document.querySelectorAll('#mp-materials-total td')).toHaveLength(12);
      expect(
        document.querySelector('#mp-materials-body tr.mp-materials-row')
          .querySelectorAll('td')
      ).toHaveLength(12);
    });

    test('turning it off removes the columns again', async () => {
      await showOwned();

      const toggle = document.getElementById('mp-show-owned');
      toggle.checked = false;
      toggle.dispatchEvent(new window.Event('change'));
      await settle(30);

      expect(document.getElementById('mp-materials-header').textContent)
        .not.toContain('Owned');
      expect(document.querySelectorAll('#mp-materials-body .mp-owned-cell'))
        .toHaveLength(0);
    });
  });

  test('changing the market set re-reads DRIFT only', async () => {
    await openTab('materials');
    calls.length = 0;

    // Picking a different comparison market must not re-read or rewrite the
    // plan's own materials - only the live side changes.
    const sel = document.querySelector('#mp-market-host select');
    sel.value = 'set-amarr';
    sel.dispatchEvent(new window.Event('change'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.getMaterialDrift')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.getMaterials')).toBe(false);
  });
});

describe('tabs', () => {
  test('switching tabs moves the active panel', async () => {
    await mountWithPlan();

    document
      .querySelector('.tab-button[data-tab="materials"]')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(document.getElementById('materials-tab').classList.contains('active')).toBe(true);
    expect(document.getElementById('overview-tab').classList.contains('active')).toBe(false);
  });

  test('exactly one panel is active at a time', async () => {
    await mountWithPlan();

    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(document.querySelectorAll('#mp-view .tab-panel.active')).toHaveLength(1);
    expect(document.querySelectorAll('#mp-view .tab-button.active')).toHaveLength(1);
  });

  test('later-slice panels exist so the strip is complete', async () => {
    // These are placeholders, but the tabs must switch to them without error -
    // a missing panel would throw on click.
    await mountWithPlan();

    ['blueprints', 'build-list', 'products', 'jobs', 'transactions', 'analytics', 'ledger', 'settings']
      .forEach((tab) => {
        expect(document.getElementById(`${tab}-tab`)).not.toBeNull();
      });
  });
});

describe('build list', () => {
  test('groups rows by role', async () => {
    await openTab('build-list');

    const titles = Array.from(document.querySelectorAll('#build-list-container .mp-section-title'))
      .map((n) => n.textContent);
    expect(titles).toEqual(['Blueprints', 'Intermediates', 'Reactions']);
  });

  test('renders a row per build item', async () => {
    await openTab('build-list');
    expect(document.querySelectorAll('#build-list-container .mp-build-row[data-mp-build-type]'))
      .toHaveLength(3);
  });

  test('resolves the facility name rather than showing its id', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Jita Raitaru');
    expect(row.textContent).not.toContain('fac-1');
  });

  test('a row with no facility reads "No Facility"', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="11399"]');
    expect(row.textContent).toContain('No Facility');
  });

  test('reactions show no ME/TE rather than 0', async () => {
    // Reactions have no ME/TE at all; rendering 0 would imply they do.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="46186"]');
    expect(row.textContent).not.toMatch(/\bME\b/);
    expect(row.textContent).toContain('Fullerene Reaction');
  });

  test('derived rows show an em dash for runs, not a number', async () => {
    // An intermediate's runs come from its parent - showing a figure would
    // imply it is editable.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="11399"]');
    const statics = Array.from(row.querySelectorAll('.mp-build-static')).map((n) => n.textContent);
    expect(statics).toContain('—');
  });

  test('is read-only until Edit is clicked', async () => {
    await openTab('build-list');

    expect(document.querySelectorAll('#build-list-container .mp-build-input')).toHaveLength(0);
    expect(document.querySelectorAll('#build-list-container .mp-link-action').length)
      .toBeGreaterThan(0);
  });

  test('Edit makes exactly that row editable', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    row.querySelector('.mp-link-action').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(
      document.querySelector('[data-mp-build-type="22546"] .mp-build-input')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-mp-build-type="11399"] .mp-build-input')
    ).toBeNull();
  });

  test('saving a row sends only that row\'s changes', async () => {
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('[data-mp-build-type="22546"] .mp-build-input');
    input.value = '8';
    input.dispatchEvent(new window.Event('change'));

    const actions = document.querySelectorAll('[data-mp-build-type="22546"] .mp-link-action');
    actions[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    // Type-scoped: main resolves the plan blueprints from the TYPE, because
    // one Build List row can stand for several of them.
    const call = calls.find((c) => c.fn === 'plans.updateBuildItemsByType');
    expect(call.planId).toBe('plan-1');
    expect(call.blueprintTypeId).toBe(22546);
    expect(call.itemType).toBe('manufacturing');
    expect(call.updates.runs).toBe(8);
    expect(calls.some((c) => c.fn === 'plans.bulkUpdateBlueprints')).toBe(false);
  });

  test('cancelling a row discards the edit without writing', async () => {
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('[data-mp-build-type="22546"] .mp-build-input');
    input.value = '99';
    input.dispatchEvent(new window.Event('change'));

    const actions = document.querySelectorAll('[data-mp-build-type="22546"] .mp-link-action');
    actions[1].dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(calls.some((c) => c.fn === 'plans.updateBuildItemsByType')).toBe(false);
    // ...and the original value is back on screen.
    expect(document.querySelector('[data-mp-build-type="22546"]').textContent).toContain('4');
  });

  test('bulk edit makes every row editable at once', async () => {
    await openTab('build-list');

    document.getElementById('mp-bulk-edit').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(document.getElementById('mp-bulk-banner').hidden).toBe(false);
    expect(document.getElementById('mp-bulk-save').hidden).toBe(false);
    // Every row that HAS an editable field shows one.
    expect(document.querySelectorAll('#build-list-container .mp-build-input').length)
      .toBeGreaterThan(3);
  });

  test('bulk save sends every changed row in one call', async () => {
    await openTab('build-list');
    document.getElementById('mp-bulk-edit').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const rows = ['22546', '11399'];
    rows.forEach((typeId) => {
      const input = document.querySelector(`[data-mp-build-type="${typeId}"] .mp-build-input`);
      input.value = '7';
      input.dispatchEvent(new window.Event('change'));
    });

    document.getElementById('mp-bulk-save').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    // One call per edited type, not one batched call.
    const saves = calls.filter((c) => c.fn === 'plans.updateBuildItemsByType');
    expect(saves).toHaveLength(2);
    expect(saves.map((c) => c.blueprintTypeId).sort()).toEqual([11399, 22546]);
  });

  test('bulk cancel discards everything without writing', async () => {
    await openTab('build-list');
    document.getElementById('mp-bulk-edit').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('#build-list-container .mp-build-input');
    input.value = '42';
    input.dispatchEvent(new window.Event('change'));

    document.getElementById('mp-bulk-cancel').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(calls.some((c) => c.fn === 'plans.updateBuildItemsByType')).toBe(false);
    expect(document.getElementById('mp-bulk-banner').hidden).toBe(true);
  });

  test('switching plans discards unsaved edits', async () => {
    // Edits are keyed by blueprintTypeId, so leaking them across a plan switch
    // would silently write them to the WRONG plan.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('[data-mp-build-type="22546"] .mp-build-input');
    input.value = '99';
    input.dispatchEvent(new window.Event('change'));

    document.querySelectorAll('.mp-plan-card')[1].dispatchEvent(new window.MouseEvent('click'));
    await settle(40);
    document
      .querySelector('.tab-button[data-tab="build-list"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    document.getElementById('mp-bulk-save').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(calls.some((c) => c.fn === 'plans.updateBuildItemsByType')).toBe(false);
  });

  test('the build-plan selector offers exactly the three implemented modes', async () => {
    // build_buy is stored and displayable but UNIMPLEMENTED ("coming in a
    // future update") and has never been selectable. Offering it would let a
    // user choose a mode that does nothing.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const selects = document.querySelectorAll('[data-mp-build-type="22546"] .mp-row-select');
    // Second select in the row is Build Plan (first is Facility).
    const values = Array.from(selects[1].options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(values).toEqual(['raw_materials', 'components', 'buy']);
    expect(values).not.toContain('build_buy');
  });

  test('carries no role pill and no product subtext', async () => {
    // Rows are already grouped under a Blueprints/Intermediates/Reactions
    // heading, and the blueprint name says what it makes. Both only cost
    // width on a table that cannot spare it.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.querySelector('.mp-role')).toBeNull();
    expect(row.textContent).not.toContain('Product:');
  });

  test('a reaction row saves with itemType "reaction"', async () => {
    // itemType selects the blueprint_type column in main; sending the wrong
    // one silently updates nothing.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="46186"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const select = document.querySelector('[data-mp-build-type="46186"] .mp-row-select');
    select.value = 'fac-1';
    select.dispatchEvent(new window.Event('change'));

    document
      .querySelectorAll('[data-mp-build-type="46186"] .mp-link-action')[0]
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.updateBuildItemsByType');
    expect(call.itemType).toBe('reaction');
    expect(call.blueprintTypeId).toBe(46186);
  });

  test('editable cells use plain selects, not searchable comboboxes', async () => {
    // Short fixed lists, and the popover rendered its value unreadably in a
    // table cell. A native dropdown is drawn by the OS, so it can extend
    // past the column instead of being squeezed into it.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.querySelectorAll('select.mp-row-select')).toHaveLength(2);
    expect(row.querySelector('.qf-ss-trigger')).toBeNull();
  });

  test('a row already storing build_buy still shows its real value', async () => {
    // Not selectable is not the same as not displayable - a row set to
    // build_buy by earlier data must not render blank.
    buildItems[0].useIntermediates = 'build_buy';
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Build/Buy');
  });
});

describe('build list - mixed values', () => {
  // getPlanBuildItems returns the literal object { mixed: true } when a type's
  // instances disagree. Rendering it as a value produces "[object Object]" and
  // would save it as one.
  test('a mixed build plan reads "Mixed", not [object Object]', async () => {
    buildItems[0].useIntermediates = { mixed: true };
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Mixed');
    expect(row.textContent).not.toContain('[object Object]');
  });

  test('a mixed facility reads "Mixed", not [object Object]', async () => {
    buildItems[0].facilityId = { mixed: true };
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Mixed');
    expect(row.textContent).not.toContain('[object Object]');
  });

  test('a mixed ME shows an em dash rather than an object', async () => {
    buildItems[0].meLevel = { mixed: true };
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).not.toContain('[object Object]');
    expect(row.textContent).not.toContain('mixed');
  });

  test('editing a mixed numeric field starts empty, not with an object', async () => {
    buildItems[0].meLevel = { mixed: true };
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const inputs = document.querySelectorAll('[data-mp-build-type="22546"] .mp-build-input');
    const mixedInput = Array.from(inputs).find((i) => i.placeholder === 'Mixed');
    expect(mixedInput).toBeDefined();
    expect(mixedInput.value).toBe('');
  });

  test('a mixed field is not saved unless the user sets a value', async () => {
    // Opening a row with mixed values and saving must not write { mixed: true }
    // to every instance.
    buildItems[0].useIntermediates = { mixed: true };
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const actions = document.querySelectorAll('[data-mp-build-type="22546"] .mp-link-action');
    actions[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.updateBuildItemsByType');
    // Nothing was edited, so nothing is written.
    expect(call).toBeUndefined();
  });
});

describe('blueprints, reactions and tree tabs', () => {
  test('the reactions tab is hidden when the plan has none', async () => {
    planReactions = [];
    await mountWithPlan();

    expect(document.getElementById('reactions-tab-button').hidden).toBe(true);
  });

  test('the reactions tab appears when the plan has reactions', async () => {
    await mountWithPlan();

    expect(document.getElementById('reactions-tab-button').hidden).toBe(false);
  });

  test('the blueprints tab lists the plan blueprints with full detail', async () => {
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.textContent).toContain('Hulk Blueprint');
    expect(row.textContent).toContain('10');            // ME
    expect(row.textContent).toContain('20');            // TE
    expect(row.textContent).toContain('Jita Raitaru');  // facility snapshot
    expect(row.textContent).not.toMatch(/Type \d+/);
  });

  test('excludes reactions - they have their own tab', async () => {
    // Listed here they rendered as blueprint rows with empty ME/TE, which
    // reactions do not have at all.
    planBlueprints.push({
      ...planBlueprints[0],
      planBlueprintId: 'pbp-rx',
      parentBlueprintId: null,
      blueprintTypeId: 46186,
      blueprintType: 'reaction',
    });
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-rx"]')).toBeNull();
  });

  test('drops a reaction\'s children with it, rather than orphaning them', async () => {
    // flattenBlueprintTree promotes parentless rows to roots, so a plain
    // filter would make a reaction's inputs reappear detached at top level.
    planBlueprints.push(
      {
        ...planBlueprints[0],
        planBlueprintId: 'pbp-rx',
        parentBlueprintId: null,
        blueprintTypeId: 46186,
        blueprintType: 'reaction',
      },
      {
        ...planBlueprints[1],
        planBlueprintId: 'pbp-rx-child',
        parentBlueprintId: 'pbp-rx',
        blueprintType: 'manufacturing',
      }
    );
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-rx-child"]')).toBeNull();
    // The real blueprints are untouched.
    expect(document.querySelectorAll('#blueprints-container .mp-bp-row[data-mp-blueprint-id]'))
      .toHaveLength(2);
  });

  test('has no Product column - the blueprint name already says what', async () => {
    // It only cost width on a table that cannot spare it.
    await openTab('blueprints');

    const header = document.querySelector('#blueprints-container .mp-build-header');
    expect(header.textContent).not.toContain('Product');
    expect(header.textContent).toContain('Blueprint');
  });

  test('reports how many units a row produces, as name subtext', async () => {
    // runs x output-per-run: 4 runs of a blueprint making 1 each.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.querySelector('.mp-bp-produces').textContent).toBe('Produces 4x');
  });

  test('multiplies runs by the per-run output', async () => {
    // 12 runs producing 100 each is 1,200 units - the number that matters,
    // and the one the run count alone never showed.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-child"]');
    expect(row.querySelector('.mp-bp-produces').textContent).toBe('Produces 1,200x');
  });

  test('omits the subtext when the SDE gave no per-run output', async () => {
    // "Produces 4x" for a blueprint that makes 100 per run is worse than
    // saying nothing.
    planBlueprints[0].productQuantityPerRun = null;
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.querySelector('.mp-bp-produces')).toBeNull();
  });

  test('the blueprints tab shows the WHOLE tree, intermediates included', async () => {
    // Intermediates are what Mark Built applies to, so hiding them put the
    // progress affordance somewhere the user could not reach it.
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-child"]')).not.toBeNull();
    expect(document.querySelectorAll('#blueprints-container .mp-bp-row[data-mp-blueprint-id]'))
      .toHaveLength(2);
  });

  test('a child renders after its parent, indented', async () => {
    await openTab('blueprints');

    const rows = Array.from(
      document.querySelectorAll('#blueprints-container .mp-bp-row[data-mp-blueprint-id]')
    );
    expect(rows.map((r) => r.getAttribute('data-mp-blueprint-id')))
      .toEqual(['pbp-1', 'pbp-child']);

    // Depth drives the indent; the parent sets no depth at all.
    expect(rows[0].style.getPropertyValue('--mp-depth')).toBe('');
    expect(rows[1].style.getPropertyValue('--mp-depth')).toBe('1');
  });

  test('a row without a facility snapshot resolves the live facility', async () => {
    // Same bug as the reactions card: facilities loaded only on the Build
    // List, so an un-snapshotted row read "Unknown facility" before then.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-child"]');
    expect(row.textContent).toContain('Amarr Azbel');
    expect(row.textContent).not.toContain('Unknown facility');
  });

  test('an intermediate whose parent is missing still renders', async () => {
    // A broken parent link must not swallow the row and everything under it.
    planBlueprints[1].parentBlueprintId = 'pbp-does-not-exist';
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-child"]')).not.toBeNull();
  });

  test('reactions render from reactionTypeId, not blueprintTypeId', async () => {
    // Reactions use a DIFFERENT id field; reading blueprintTypeId gave
    // undefined and rendered "Type undefined".
    await openTab('reactions');

    const card = document.querySelector('[data-mp-reaction-id="pbp-2"]');
    expect(card.textContent).toContain('Fullerene');
    expect(card.textContent).not.toMatch(/Type (\d+|undefined)/);
  });

  test('the tree renders nested children indented, with full columns', async () => {
    await openTab('blueprint-tree');

    const rows = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-grid[data-mp-tree-type]'
    );
    const names = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-name-line'
    );
    expect(rows).toHaveLength(2);
    expect(names).toHaveLength(2);
    expect(names[0].textContent).toContain('Hulk');
    expect(names[1].textContent).toContain('Tritanium');

    // The tree uses quantityNeeded and priceEach - the opposite of the
    // materials list - so a wrong field name shows up as a blank column.
    expect(rows[1].textContent).toContain('1,000');   // quantityNeeded
    expect(rows[1].textContent).toContain('5.00');    // priceEach

    // The child's NAME is indented further than its parent's.
    const indent = (line) => parseInt(line.style.paddingLeft, 10);
    expect(indent(names[1])).toBeGreaterThan(indent(names[0]));
  });

  test('the name is decoupled from its data row', async () => {
    // Indentation used to come out of the Item column's own width, so the
    // deeper a node the more of its name was cut off - unusable on a
    // capital-ship tree. The name now has its own full-width line, and the
    // figures below it start at a fixed offset regardless of depth.
    await openTab('blueprint-tree');

    const rows = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-grid[data-mp-tree-type]'
    );
    // No name in the data row at all...
    expect(rows[1].textContent).not.toContain('Tritanium');
    // ...and depth does not shift the figures.
    expect(rows[0].style.paddingLeft).toBe('');
    expect(rows[1].style.paddingLeft).toBe('');
  });

  test('each name line pairs with the row beneath it', async () => {
    await openTab('blueprint-tree');

    const body = document.querySelector('#blueprint-tree-container .mp-tree-body');
    const kids = Array.from(body.children).filter(
      (n) => n.classList.contains('mp-tree-name-line')
        || n.classList.contains('mp-tree-grid')
    );
    // header, then name/row for each of the two nodes.
    expect(kids[0].classList.contains('mp-build-header')).toBe(true);
    expect(kids[1].getAttribute('data-mp-tree-name')).toBe(kids[2].getAttribute('data-mp-tree-key'));
    expect(kids[3].getAttribute('data-mp-tree-name')).toBe(kids[4].getAttribute('data-mp-tree-key'));
  });

  test('tabs load their data only when opened', async () => {
    await mountWithPlan();
    expect(calls.some((c) => c.fn === 'plans.getBuildItems')).toBe(false);

    document
      .querySelector('.tab-button[data-tab="build-list"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.getBuildItems')).toBe(true);
  });
});

describe('blueprint tree', () => {
  const rows = () => document.querySelectorAll(
    '#blueprint-tree-container .mp-tree-grid[data-mp-tree-type]'
  );

  test('has the full column set', async () => {
    await openTab('blueprint-tree');

    const header = document.querySelector('#blueprint-tree-container .mp-build-header');
    ['Quantity', 'Runs', 'ME', 'Source', 'Price/ea', 'Total', 'Type']
      .forEach((label) => expect(header.textContent).toContain(label));
    // No Item column - the name is its own line above each row.
    expect(header.textContent).not.toContain('Item');
  });

  test('shows runs needed and the source of each node', async () => {
    await openTab('blueprint-tree');

    expect(rows()[0].textContent).toContain('4');              // runsNeeded
    expect(rows()[0].querySelector('.mp-plan-badge')).not.toBeNull();
    // A node with no build plan is bought, not built.
    expect(rows()[1].textContent).toContain('Market');
  });

  test('classifies each node by type', async () => {
    await openTab('blueprint-tree');

    expect(rows()[0].querySelector('.mp-node-badge').textContent).toBe('Built');
    expect(rows()[1].querySelector('.mp-node-badge').textContent).toBe('Raw');
  });

  test('extends the line total, not just the unit price', async () => {
    await openTab('blueprint-tree');

    // 1,000 Tritanium at 5.00 each.
    expect(rows()[1].textContent).toContain('5,000.00');
  });

  test('a node with children can be collapsed, hiding them', async () => {
    await openTab('blueprint-tree');
    expect(rows()).toHaveLength(2);

    document
      .querySelector('[data-mp-tree-toggle]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(rows()).toHaveLength(1);
    // The child's NAME goes with it - the two are separate elements now, so
    // hiding only one would leave an orphan.
    expect(document.querySelectorAll('#blueprint-tree-container .mp-tree-name-line'))
      .toHaveLength(1);
    expect(document.querySelector('[data-mp-tree-toggle]').getAttribute('aria-expanded'))
      .toBe('false');
  });

  test('a leaf offers no collapse control', async () => {
    await openTab('blueprint-tree');

    // The caret lives on the name line, alongside the name it expands.
    const names = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-name-line'
    );
    expect(names[0].querySelector('[data-mp-tree-toggle]')).not.toBeNull();
    expect(names[1].querySelector('[data-mp-tree-toggle]')).toBeNull();
  });

  test('Collapse all then Expand all round-trips', async () => {
    await openTab('blueprint-tree');

    document
      .querySelector('[data-mp-tree-collapse-all]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    expect(rows()).toHaveLength(1);

    document
      .querySelector('[data-mp-tree-expand-all]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    expect(rows()).toHaveLength(2);
  });

  test('a "buy" node does not list itself as its own input', async () => {
    // Setting a node to Buy pushes a material leaf of the SAME type beneath
    // it, because getPlanMaterials only reads node_type 'material' rows and
    // the item would otherwise vanish from the shopping list. That echo is a
    // storage detail - on the tree it reads as the item being its own input.
    materialTree[0].buildPlan = 'buy';
    materialTree[0].children = [
      {
        nodeId: 'n-echo',
        typeId: 22544,               // same type as its parent
        typeName: 'Hulk',
        nodeType: 'material',
        depth: 1,
        quantityNeeded: 4,
        runsNeeded: null,
        meLevel: null,
        isReaction: false,
        buildPlan: 'buy',
        priceEach: 250_000_000,
        acquiredQuantity: 0,
        sourcePlanBlueprintId: null,
        children: [],
      },
    ];
    await openTab('blueprint-tree');

    expect(rows()).toHaveLength(1);
    expect(document.querySelectorAll('#blueprint-tree-container .mp-tree-name-line'))
      .toHaveLength(1);
  });

  test('a "buy" node with the echo hidden offers no expand control', async () => {
    materialTree[0].buildPlan = 'buy';
    materialTree[0].children = [
      {
        nodeId: 'n-echo',
        typeId: 22544,
        typeName: 'Hulk',
        nodeType: 'material',
        depth: 1,
        quantityNeeded: 4,
        isReaction: false,
        buildPlan: 'buy',
        priceEach: 0,
        sourcePlanBlueprintId: null,
        children: [],
      },
    ];
    await openTab('blueprint-tree');

    // Nothing left to expand once its only child is its own echo.
    expect(document.querySelector('[data-mp-tree-toggle]')).toBeNull();
  });

  test('a "buy" node keeps children of a DIFFERENT type', async () => {
    // Only the same-type echo is hidden; real inputs still belong.
    materialTree[0].buildPlan = 'buy';
    await openTab('blueprint-tree');

    expect(rows()).toHaveLength(2);
    expect(document.querySelectorAll('#blueprint-tree-container .mp-tree-name-line')[1]
      .textContent).toContain('Tritanium');
  });

  test('only a node with a producer offers Details', async () => {
    // A raw material bought from the market has nothing behind it to expand.
    await openTab('blueprint-tree');

    expect(rows()[0].querySelector('[data-mp-tree-detail]')).not.toBeNull();
    expect(rows()[1].querySelector('[data-mp-tree-detail]')).toBeNull();
  });

  test('Details fetches against the node\'s own producer', async () => {
    await openTab('blueprint-tree');
    document
      .querySelector('[data-mp-tree-detail]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.getMaterialTreeNodeDetail');
    expect(call.planBlueprintId).toBe('pbp-1');
  });

  test('the detail panel shows stats and direct inputs', async () => {
    await openTab('blueprint-tree');
    document
      .querySelector('[data-mp-tree-detail]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const panel = document.querySelector('[data-mp-tree-detail-panel]');
    expect(panel.textContent).toContain('10');           // ME
    expect(panel.textContent).toContain('20');           // TE
    expect(panel.textContent).toContain('2h 2m');        // time, from seconds
    expect(panel.textContent).toContain('1,500,000.00'); // job cost
    expect(panel.textContent).toContain('Direct Material Inputs');
    expect(panel.querySelectorAll('[data-mp-detail-material]')).toHaveLength(2);
  });

  test('a reaction node shows no ME/TE rather than 0', async () => {
    // Reactions have no ME/TE at all; rendering 0 would imply they do.
    treeNodeDetail = { ...treeNodeDetail, blueprintType: 'reaction' };
    await openTab('blueprint-tree');
    document
      .querySelector('[data-mp-tree-detail]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const labels = Array.from(
      document.querySelectorAll('[data-mp-tree-detail-panel] .mp-reaction-stat-label')
    ).map((n) => n.textContent);
    expect(labels).not.toContain('ME');
    expect(labels).not.toContain('TE');
    expect(labels).toContain('Runs');
  });

  test('Details toggles closed again', async () => {
    await openTab('blueprint-tree');
    const btn = () => document.querySelector('[data-mp-tree-detail]');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
    expect(btn().textContent).toBe('Hide');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    expect(document.querySelector('[data-mp-tree-detail-panel]')).toBeNull();
  });

  test('the detail is fetched once, then reused', async () => {
    await openTab('blueprint-tree');
    const btn = () => document.querySelector('[data-mp-tree-detail]');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.filter((c) => c.fn === 'plans.getMaterialTreeNodeDetail'))
      .toHaveLength(1);
  });

  test('a node with no detail says so rather than spinning', async () => {
    treeNodeDetail = null;
    await openTab('blueprint-tree');
    const btn = () => document.querySelector('[data-mp-tree-detail]');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(document.querySelector('[data-mp-tree-detail-panel]').textContent)
      .toContain('No details available');

    // "Fetched, nothing there" is a RESULT, not a miss - reopening must not
    // re-run the calculation.
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.filter((c) => c.fn === 'plans.getMaterialTreeNodeDetail'))
      .toHaveLength(1);
  });
});

describe('reactions tab', () => {
  test('shows only PRIMARY reactions, not sub-reactions', async () => {
    // A sub-reaction already appears inside its parent's input tree, so a
    // card of its own would list the same chain twice.
    planReactions.push({
      ...planReactions[0],
      planBlueprintId: 'pbp-sub',
      reactionTypeId: 46184,
      intermediateProductTypeId: 46183,
      isTopLevel: false,
    });
    await openTab('reactions');

    expect(document.querySelectorAll('#reactions-container .mp-reaction-card'))
      .toHaveLength(1);
    expect(document.querySelector('[data-mp-reaction-id="pbp-sub"]')).toBeNull();
  });

  test('a reaction with no isTopLevel flag is treated as primary', async () => {
    // Better a duplicate card than a silently missing one on absent data.
    delete planReactions[0].isTopLevel;
    await openTab('reactions');

    expect(document.querySelectorAll('#reactions-container .mp-reaction-card'))
      .toHaveLength(1);
  });

  test('renders a card per reaction, not table rows', async () => {
    // Each reaction is a CHAIN with its own inputs; a flat table could not
    // show what feeds what.
    await openTab('reactions');

    expect(document.querySelectorAll('#reactions-container .mp-reaction-card'))
      .toHaveLength(1);
  });

  test('the card titles the PRODUCT, not the reaction blueprint', async () => {
    await openTab('reactions');

    const title = document.querySelector('.mp-reaction-title').textContent;
    expect(title).toContain('Fullerene');
    expect(title).not.toContain('Fullerene Reaction');
  });

  test('shows runs, per-run output and total produced', async () => {
    // Total produced is what the plan is really sized by.
    await openTab('reactions');

    const stats = Array.from(document.querySelectorAll('.mp-reaction-stat'))
      .map((s) => s.textContent);
    expect(stats[0]).toContain('Runs');
    expect(stats[0]).toContain('2');
    expect(stats[1]).toContain('200');   // product.baseQuantity
    expect(stats[2]).toContain('400');   // product.quantity
  });

  test('reports facility and build plan as read-only', async () => {
    // They are EDITED on the Build List; saying so stops these reading as
    // broken controls.
    await openTab('reactions');

    const card = document.querySelector('.mp-reaction-card');
    expect(card.textContent).toContain('Amarr Azbel');
    expect(card.querySelector('.mp-plan-badge')).not.toBeNull();
    expect(document.getElementById('reactions-container').textContent)
      .toContain('edited on the Build List');
  });

  test('resolves the facility without visiting the Build List first', async () => {
    // Facilities used to load ONLY on the Build List tab, so every other tab
    // read "Unknown facility" until that tab happened to be opened.
    await openTab('reactions');

    expect(document.querySelector('.mp-reaction-card').textContent)
      .not.toContain('Unknown facility');
  });

  test('renders the input tree nested, deepest indented furthest', async () => {
    await openTab('reactions');

    const nodes = Array.from(document.querySelectorAll('.mp-reaction-node'));
    expect(nodes).toHaveLength(3);

    // A child follows its parent, one level deeper - the nesting comes from
    // `children`, not from a flat depth field.
    expect(nodes[0].textContent).toContain('Fulleroferrocene');
    expect(nodes[0].style.getPropertyValue('--mp-depth')).toBe('0');
    expect(nodes[1].textContent).toContain('Ceramic Powder');
    expect(nodes[1].style.getPropertyValue('--mp-depth')).toBe('1');
    expect(nodes[2].textContent).toContain('Vanadium');
    expect(nodes[2].style.getPropertyValue('--mp-depth')).toBe('0');
  });

  test('classifies each node by role', async () => {
    await openTab('reactions');

    const role = (i) => document.querySelectorAll('.mp-reaction-node')[i]
      .getAttribute('data-mp-node-role');
    expect(role(0)).toBe('intermediate');   // isIntermediate
    expect(role(1)).toBe('raw');            // neither flag
    expect(role(2)).toBe('manufactured');   // isManufactured
  });

  test('shows runs needed only for nodes that are produced', async () => {
    await openTab('reactions');

    const nodes = document.querySelectorAll('.mp-reaction-node');
    expect(nodes[0].textContent).toContain('9 runs');
    expect(nodes[1].textContent).not.toMatch(/\d+ runs?/);
  });

  test('flags only non-default sourcing', async () => {
    // "raw_materials" is what every node does unless told otherwise, so
    // chipping it everywhere would be noise.
    await openTab('reactions');

    const nodes = document.querySelectorAll('.mp-reaction-node');
    expect(nodes[0].querySelector('.mp-node-sourcing .mp-plan-badge')).toBeNull();
    expect(nodes[2].querySelector('.mp-node-sourcing .mp-plan-badge')).not.toBeNull();
  });

  test('shows the quantity each node contributes', async () => {
    await openTab('reactions');

    expect(document.querySelectorAll('.mp-reaction-node')[1].textContent)
      .toContain('12,000');
  });

  test('the tree is fetched only when the tab is opened', async () => {
    // It is one full material calculation per reaction, and the reaction rows
    // themselves load on every plan open just to decide tab visibility.
    await mountWithPlan();
    expect(calls.some((c) => c.fn === 'plans.calculateReactionTree')).toBe(false);

    document
      .querySelector('.tab-button[data-tab="reactions"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.calculateReactionTree')).toBe(true);
  });

  test('the tree is calculated against the reaction\'s own runs and facility', async () => {
    await openTab('reactions');

    const call = calls.find((c) => c.fn === 'plans.calculateReactionTree');
    expect(call.planBlueprintId).toBe('pbp-2');
    expect(call.runs).toBe(2);
    expect(call.facility).toBe('fac-2');
  });

  test('a failed tree calculation still renders the card', async () => {
    // The header is real plan data; losing the inputs must not take it out.
    window.electronAPI.plans.calculateReactionTree = async () => {
      throw new Error('SDE unavailable');
    };
    allowErrors(/reaction tree/);
    await openTab('reactions');

    const card = document.querySelector('.mp-reaction-card');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Fullerene');
    expect(card.querySelectorAll('.mp-reaction-node')).toHaveLength(0);
  });

  test('reactions offer Mark Built and route to markReactionBuilt', async () => {
    await openTab('reactions');
    document
      .querySelector('[data-mp-mark-built="pbp-2"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    document.getElementById('mp-built-runs').value = '1';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(calls.some((c) => c.fn === 'plans.markReactionBuilt')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.markIntermediateBuilt')).toBe(false);
  });

  test('a partially built reaction is badged on its card', async () => {
    planReactions[0].builtRuns = 1;
    await openTab('reactions');

    const badge = document.querySelector('[data-mp-built-badge="pbp-2"]');
    expect(badge.textContent).toBe('1/2 Built (50%)');
  });
});

describe('mark built', () => {
  async function openBuiltModal(id = 'pbp-child') {
    await openTab('blueprints');
    document
      .querySelector(`[data-mp-mark-built="${id}"]`)
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
  }

  test('only intermediates offer Mark Built', async () => {
    // A top-level entry is the plan's own output, tracked through industry
    // jobs rather than hand-entered.
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-mark-built="pbp-child"]')).not.toBeNull();
    expect(document.querySelector('[data-mp-mark-built="pbp-1"]')).toBeNull();
  });

  test('top-level entries remain removable', async () => {
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.querySelector('.mp-link-danger')).not.toBeNull();
  });

  test('the action reads Edit Built Qty once something is built', async () => {
    await openTab('blueprints');
    expect(document.querySelector('[data-mp-mark-built="pbp-child"]').textContent)
      .toBe('Edit Built Qty');
  });

  test('the action reads Mark Built when nothing is built yet', async () => {
    planBlueprints[1].builtRuns = 0;
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-mark-built="pbp-child"]').textContent)
      .toBe('Mark Built');
  });

  test('a partially built intermediate shows an amber progress badge', async () => {
    await openTab('blueprints');

    const badge = document.querySelector('[data-mp-built-badge="pbp-child"]');
    expect(badge.textContent).toBe('3/12 Built (25%)');
    expect(badge.classList.contains('mp-built-full')).toBe(false);
  });

  test('the built badge sits on the sub-line, not beside the name', async () => {
    // A pill next to a long blueprint name ate the width the name needed
    // and truncated it.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-child"]');
    const badge = row.querySelector('[data-mp-built-badge]');
    expect(badge.closest('.mp-bp-subline')).not.toBeNull();
    expect(badge.closest('.mp-mat-name')).toBeNull();
  });

  test('a fully built intermediate is badged green', async () => {
    planBlueprints[1].builtRuns = 12;
    await openTab('blueprints');

    const badge = document.querySelector('[data-mp-built-badge="pbp-child"]');
    expect(badge.textContent).toBe('12/12 Built (100%)');
    expect(badge.classList.contains('mp-built-full')).toBe(true);
  });

  test('nothing built draws no badge at all', async () => {
    // A 0/12 badge on every unstarted row is noise.
    planBlueprints[1].builtRuns = 0;
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-built-badge="pbp-child"]')).toBeNull();
  });

  test('the modal opens seeded with the current built runs', async () => {
    await openBuiltModal();

    expect(document.getElementById('mp-built-modal').hidden).toBe(false);
    expect(document.getElementById('mp-built-runs').value).toBe('3');
    expect(document.getElementById('mp-built-runs').max).toBe('12');
  });

  test('the modal names the PRODUCT, not the blueprint', async () => {
    // The user holds the product in a hangar; the blueprint is only how it
    // is made.
    await openBuiltModal();

    const text = document.getElementById('mp-built-item').textContent;
    expect(text).toContain('Morphite');            // the product
    expect(text).not.toContain('Morphite Blueprint');
    expect(text).toContain('12');                  // total runs needed
  });

  test('quick actions are percentages of the total', async () => {
    // The same five buttons have to work for a 4-run job and a 4,000-run one.
    await openBuiltModal();

    const quick = Array.from(document.querySelectorAll('[data-mp-built-quick]'));
    expect(quick.map((b) => b.textContent)).toEqual(['0%', '25%', '50%', '75%', '100%']);

    quick[2].dispatchEvent(new window.MouseEvent('click'));
    expect(document.getElementById('mp-built-runs').value).toBe('6');
    expect(document.getElementById('mp-built-pct').textContent).toBe('50%');
  });

  test('typing updates the progress bar', async () => {
    await openBuiltModal();

    const input = document.getElementById('mp-built-runs');
    input.value = '9';
    input.dispatchEvent(new window.Event('input'));

    expect(document.getElementById('mp-built-pct').textContent).toBe('75%');
    expect(document.getElementById('mp-built-bar-fill').style.width).toBe('75%');
  });

  test('owned assets are listed per hangar', async () => {
    // "How many do I already have?" is the question that decides what to
    // enter, so the answer belongs in this modal.
    await openBuiltModal();

    const text = document.getElementById('mp-built-assets').textContent;
    expect(text).toContain('700');                       // personal + corp
    expect(text).toContain('Valen Kor');
    expect(text).toContain('Forge Dynamics – Component Stock');
  });

  test('assets are looked up for the product, scoped to the plan', async () => {
    await openBuiltModal();

    const call = calls.find((c) => c.fn === 'plans.getProductOwnedAssets');
    expect(call.planId).toBe('plan-1');
    expect(call.typeId).toBe(11399);
  });

  test('says so plainly when no assets are held', async () => {
    productOwnedAssets = {
      ownedPersonal: 0, ownedCorp: 0, personalDetails: [], corpDetails: [],
    };
    await openBuiltModal();

    expect(document.getElementById('mp-built-assets').textContent)
      .toContain('No assets found');
  });

  test('saving routes a manufacturing intermediate to markIntermediateBuilt', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '7';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    const call = calls.find((c) => c.fn === 'plans.markIntermediateBuilt');
    expect(call).toMatchObject({ planBlueprintId: 'pbp-child', builtRuns: 7 });
    expect(calls.some((c) => c.fn === 'plans.markReactionBuilt')).toBe(false);
  });

  // Reaction routing is covered from the Reactions tab ("reactions offer Mark
  // Built and route to markReactionBuilt") - reactions no longer appear on the
  // Blueprints tab at all, so there is no reaction row to open a modal from
  // here.

  test('saving refreshes the materials, which the built runs credit', async () => {
    await openBuiltModal();
    calls.length = 0;
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(calls.some((c) => c.fn === 'plans.getMaterials')).toBe(true);
    expect(document.getElementById('mp-built-modal').hidden).toBe(true);
  });

  test('runs beyond the total are refused before they reach main', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '99';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.markIntermediateBuilt')).toBe(false);
    expect(document.getElementById('mp-built-modal').hidden).toBe(false);
  });

  test('a negative value is refused', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '-1';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.markIntermediateBuilt')).toBe(false);
  });

  test('zero is allowed - it un-marks a mistake', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '0';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    const call = calls.find((c) => c.fn === 'plans.markIntermediateBuilt');
    expect(call.builtRuns).toBe(0);
  });

  test('closing abandons an in-flight asset lookup', async () => {
    // A late response must not paint into whatever is open next.
    await openTab('blueprints');
    document
      .querySelector('[data-mp-mark-built="pbp-child"]')
      .dispatchEvent(new window.MouseEvent('click'));

    document
      .querySelector('[data-mp-close="mp-built-modal"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('mp-built-assets').textContent).toBe('');
  });
});

describe('products', () => {
  test('separates final products from intermediates', async () => {
    // Only a FINAL product is sold; an intermediate is a cascading input the
    // plan consumes. Listing them together would imply both are revenue.
    await openTab('products');

    const titles = Array.from(document.querySelectorAll('#products-container .mp-section-title'))
      .map((n) => n.textContent);
    expect(titles).toEqual(['Final Products', 'Intermediate Components']);
  });

  test('marks intermediates as consumed, not sold', async () => {
    await openTab('products');
    expect(document.getElementById('products-container').textContent)
      .toContain('Consumed by this plan, not sold');
  });

  test('renders quantity and locked price per product', async () => {
    await openTab('products');

    const rows = document.querySelectorAll('#products-container .mp-product-row');
    // Header + 1 final, header + 1 intermediate.
    const hulkRow = Array.from(rows).find((r) => r.textContent.includes('Hulk'));
    expect(hulkRow.textContent).toContain('4');
    expect(hulkRow.textContent).toContain('250,000,000');
  });

  test('renders Total m³ per product and per section', async () => {
    // The mockup's third column. Volumes are fetched for MATERIALS elsewhere,
    // so products need their own lookup - without it this column is blank.
    volumes[22544] = 50_000;
    await openTab('products');

    const rows = document.querySelectorAll('#products-container .mp-product-row');
    const hulkRow = Array.from(rows).find((r) => r.textContent.includes('Hulk'));
    // 4 x 50,000
    expect(hulkRow.textContent).toContain('200,000.00 m³');

    const totalRow = document.querySelector('#products-container .mp-materials-total');
    expect(totalRow.textContent).toContain('m³');
  });
});

describe('jobs and transactions', () => {
  test('pending counts appear as tab badges before the tab is opened', async () => {
    // The badge is the only cue that something is waiting for a decision, so
    // it cannot wait until the tab is visited.
    await mountWithPlan();

    expect(document.getElementById('mp-jobs-badge').hidden).toBe(false);
    expect(document.getElementById('mp-jobs-badge').textContent).toBe('1');
    expect(document.getElementById('mp-transactions-badge').textContent).toBe('1');
  });

  test('badges are hidden when nothing is pending', async () => {
    pendingMatches = { jobMatches: [], transactionMatches: [] };
    await mountWithPlan();

    expect(document.getElementById('mp-jobs-badge').hidden).toBe(true);
    expect(document.getElementById('mp-transactions-badge').hidden).toBe(true);
  });

  test('pending and linked jobs are listed separately', async () => {
    await openTab('jobs');

    const titles = Array.from(document.querySelectorAll('#jobs-container .mp-section-title'))
      .map((n) => n.textContent);
    expect(titles).toEqual(['Pending Job Matches', 'Linked Jobs']);
  });

  test('job rows read the NESTED job object', async () => {
    // Job identity lives under match.job - jobId, runs and characterName are
    // not top-level. Reading them flat rendered blanks.
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    expect(row.textContent).toContain('Hulk Blueprint');  // job.blueprintTypeId -> name
    expect(row.textContent).toContain('555001');          // job.jobId
    expect(row.textContent).toContain('Buckwalter');      // job.characterName
    expect(row.textContent).toContain('4');               // job.runs
    expect(row.textContent).not.toMatch(/Type \d+/);
  });

  test('job rows carry every mockup column', async () => {
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    // Status, Facility and Started were missing entirely.
    expect(row.querySelector('.mp-job-status').textContent).toBe('active');
    expect(row.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);   // started
  });

  test('facilities resolve to names via the shared location resolver', async () => {
    // NPC stations from the SDE, player structures via ESI - both handled by
    // location.resolve, which caches in main.
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    expect(row.textContent).toContain('Jita IV');
    expect(row.textContent).not.toContain('Facility 60003760');

    // Resolution needs the character that can SEE the structure.
    const call = calls.find((c) => c.fn === 'location.resolve');
    expect(call.locationId).toBe(60003760);
    expect(call.characterId).toBe(91316135);
  });

  test('an unresolvable facility falls back to its id, not "Unknown"', async () => {
    // 'Unknown' is the resolver's failure string; storing it would be worse
    // than showing the id the user can look up.
    locationNames = {};
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    expect(row.textContent).toContain('Facility 60003760');
  });

  test('each facility is resolved once, not per row', async () => {
    // Two matches at the same facility must not mean two ESI lookups.
    confirmedJobs[0].job.facilityId = 60003760;
    await openTab('jobs');

    const resolveCalls = calls.filter((c) => c.fn === 'location.resolve');
    expect(resolveCalls).toHaveLength(1);
  });

  test('the jobs table has column headers', async () => {
    await openTab('jobs');

    const header = document.querySelector('#jobs-container .mp-build-header');
    ['Blueprint', 'Character', 'Job ID', 'Runs', 'Status', 'Facility', 'Started']
      .forEach((label) => expect(header.textContent).toContain(label));
  });

  test('transaction rows read the NESTED transaction object', async () => {
    await openTab('transactions');

    const row = document.querySelector('[data-mp-match-id="tm-1"]');
    expect(row.textContent).toContain('Tritanium');
    expect(row.textContent).toContain('777001');
    expect(row.textContent).toContain('Buckwalter');
  });

  test('transaction rows show date, price, total and direction', async () => {
    // The financial columns are the point of this tab and were all missing.
    await openTab('transactions');

    const row = document.querySelector('[data-mp-match-id="tm-1"]');
    expect(row.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);  // date
    expect(row.textContent).toContain('5.50');                    // unit price
    expect(row.textContent).toContain('5,500.00');                // 1000 x 5.50
    expect(row.querySelector('.mp-tx-type').textContent).toBe('Buy');
  });

  test('a buy is coloured as money out', async () => {
    await openTab('transactions');

    const badge = document.querySelector('[data-mp-match-id="tm-1"] .mp-tx-type');
    expect(badge.getAttribute('data-tx-type')).toBe('buy');
  });

  test('the confidence badge exposes its reasoning on hover', async () => {
    // A score with no explanation asks the user to trust the heuristic.
    await openTab('jobs');

    const conf = document.querySelector('[data-mp-match-id="jm-1"] .mp-center');
    expect(conf.title).toContain('blueprint');
  });

  test('a pending match shows its confidence as a number', async () => {
    // A colour alone asks the user to trust the heuristic; the number lets
    // them judge.
    await openTab('jobs');

    const badge = document.querySelector('#jobs-container .confidence-badge');
    expect(badge.textContent).toBe('92%');
    expect(badge.classList.contains('high')).toBe(true);
  });

  test('a weak match is badged low, not high', async () => {
    await openTab('transactions');

    const badge = document.querySelector('#transactions-container .confidence-badge');
    expect(badge.textContent).toBe('45%');
    expect(badge.classList.contains('low')).toBe(true);
  });

  test('confirming a job match sends its id', async () => {
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    row.querySelectorAll('.mp-link-action')[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.find((c) => c.fn === 'plans.confirmJobMatch').matchId).toBe('jm-1');
  });

  test('rejecting a job match sends its id', async () => {
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    row.querySelectorAll('.mp-link-action')[1].dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.find((c) => c.fn === 'plans.rejectJobMatch').matchId).toBe('jm-1');
  });

  test('a linked job offers Unlink, not Confirm', async () => {
    await openTab('jobs');

    const linkedSection = document.querySelectorAll('#jobs-container .mp-section')[1];
    const actions = Array.from(linkedSection.querySelectorAll('.mp-link-action'))
      .map((b) => b.textContent);
    expect(actions).toEqual(['Unlink']);
  });

  test('confirming a transaction sends its id', async () => {
    await openTab('transactions');

    const row = document.querySelector('[data-mp-match-id="tm-1"]');
    row.querySelectorAll('.mp-link-action')[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.find((c) => c.fn === 'plans.confirmTransactionMatch').matchId).toBe('tm-1');
  });

  test('Match Jobs scans and saves the results', async () => {
    await openTab('jobs');
    calls.length = 0;

    document.getElementById('mp-match-jobs').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.matchJobs')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.saveJobMatches')).toBe(true);
  });

  test('Match Transactions scans and saves the results', async () => {
    await openTab('transactions');
    calls.length = 0;

    document.getElementById('mp-match-transactions').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'plans.matchTransactions')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.saveTransactionMatches')).toBe(true);
  });

  test('an empty pending list shows guidance rather than a bare table', async () => {
    pendingMatches = { jobMatches: [], transactionMatches: [] };
    await openTab('jobs');

    expect(document.getElementById('jobs-container').textContent)
      .toContain('No pending job matches');
  });
});

describe('analytics', () => {
  test('renders a progress CARD per tracked dimension', async () => {
    // The redesign uses cards, not stacked bars: jobs, materials, products,
    // overall.
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-analytics-grid')[0]
      .querySelectorAll('.mp-card');
    expect(cards).toHaveLength(4);
    expect(document.getElementById('mp-analytics').textContent).toContain('Jobs completed');
    expect(document.getElementById('mp-analytics').textContent).toContain('Overall');
  });

  test('progress fill is clamped to 100%', async () => {
    // Over-acquiring materials produces a percentage above 100, which must not
    // overflow the track.
    analytics.progress.materials.percent = 180;
    await openTab('analytics');

    const fills = document.querySelectorAll('#mp-analytics .mp-progress-fill');
    const widths = Array.from(fills).map((f) => parseFloat(f.style.width));
    expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  });

  test('includes the ROI card', async () => {
    // ROI arrives as two top-level numbers under `summary`, not as a
    // {planned, actual, delta} group like the others.
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const roi = Array.from(cards).find((c) => c.textContent.includes('ROI'));
    expect(roi).toBeDefined();
    // Formatted as a percentage, not ISK.
    expect(roi.textContent).toContain('42.8%');
    expect(roi.textContent).toContain('55.0%');
  });

  test('renders Cost by Category from the ledger', async () => {
    // The Analytics payload carries no category breakdown, so this comes from
    // the ledger - which Analytics must load itself rather than depending on
    // the user having opened the Ledger tab first.
    await openTab('analytics');

    const text = document.getElementById('mp-analytics').textContent;
    expect(text).toContain('Cost by Category');
    expect(text).toContain('Materials');
    expect(text).toContain('Job installation');
  });

  test('Cost by Category percentages sum sensibly', async () => {
    await openTab('analytics');

    const values = Array.from(document.querySelectorAll('#mp-analytics .mp-cost-cat-value'))
      .map((n) => parseFloat((n.textContent.match(/([\d.]+)%/) || [])[1]));
    const total = values.reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  test('spending LESS than planned is good', async () => {
    // Material cost delta is negative here - under budget.
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const costCard = Array.from(cards).find((c) => c.textContent.includes('Material Cost'));
    const delta = costCard.querySelector('.mp-compare-delta .mp-mono');
    expect(delta.classList.contains('mp-positive')).toBe(true);
  });

  test('earning MORE than planned is good', async () => {
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const valueCard = Array.from(cards).find((c) => c.textContent.includes('Product Value'));
    const delta = valueCard.querySelector('.mp-compare-delta .mp-mono');
    expect(delta.classList.contains('mp-positive')).toBe(true);
  });

  test('overspending is marked negative', async () => {
    analytics.materialCosts = {
      planned: 100_000, actual: 130_000, delta: 30_000, deltaPercent: 30,
    };
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const costCard = Array.from(cards).find((c) => c.textContent.includes('Material Cost'));
    const delta = costCard.querySelector('.mp-compare-delta .mp-mono');
    expect(delta.classList.contains('mp-negative')).toBe(true);
  });

  test('missing analytics renders a message, not a blank tab', async () => {
    analytics = null;
    await openTab('analytics');

    expect(document.getElementById('mp-analytics').textContent)
      .toContain('No analytics available');
  });
});

describe('ledger', () => {
  test('renders summary cards and section rows', async () => {
    await openTab('ledger');

    const text = document.getElementById('ledger-container').textContent;
    expect(text).toContain('Material Purchases');
    expect(text).toContain('Job Installation');
    expect(text).toContain('Tritanium');
  });

  test('marks an ESTIMATED job cost as estimated', async () => {
    // An estimate presented as a figure would misrepresent the plan's actuals.
    await openTab('ledger');
    expect(document.querySelector('#ledger-container .mp-ledger-tag').textContent).toBe('est.');
  });

  test('does not mark a real job cost as estimated', async () => {
    ledger.categories.jobInstallation.estimated = false;
    await openTab('ledger');
    expect(document.querySelector('#ledger-container .mp-ledger-tag')).toBeNull();
  });

  test('overspending shows a negative delta', async () => {
    // Spending MORE than planned is bad. Target .mp-recon-delta specifically:
    // the bar also holds planned and actual figures, which carry no verdict.
    await openTab('ledger');

    const delta = document.querySelector('#ledger-container .mp-recon-delta');
    expect(delta.textContent).toContain('Delta');
    expect(delta.textContent).toContain('1,200');
    expect(delta.classList.contains('mp-negative')).toBe(true);
    expect(delta.classList.contains('mp-positive')).toBe(false);
  });

  test('under budget shows a positive delta', async () => {
    ledger.reconciliation = { plannedCost: 8000, actualSpend: 6200, delta: -1800 };
    await openTab('ledger');

    const delta = document.querySelector('#ledger-container .mp-recon-delta');
    expect(delta.classList.contains('mp-positive')).toBe(true);
    expect(delta.classList.contains('mp-negative')).toBe(false);
  });

  test('the planned and actual figures carry no verdict colouring', async () => {
    // Only the delta means "good" or "bad" - colouring the raw figures would
    // imply a judgement about the numbers themselves.
    await openTab('ledger');

    const bar = document.querySelector('#ledger-container .mp-recon');
    const plain = bar.querySelectorAll('.mp-mono:not(.mp-recon-delta)');
    expect(plain.length).toBe(2);
    plain.forEach((span) => {
      expect(span.classList.contains('mp-positive')).toBe(false);
      expect(span.classList.contains('mp-negative')).toBe(false);
    });
  });

  test('an ESI-sourced row offers Unlink, a manual row offers Remove', async () => {
    // A manual row is yours to delete; an ESI row is a record of what happened.
    await openTab('ledger');

    const esiRow = document.querySelector('[data-mp-ledger-id="led-1"]');
    const manualRow = document.querySelector('[data-mp-ledger-id="led-2"]');
    expect(esiRow.querySelector('.mp-link-action').textContent).toBe('Unlink');
    expect(manualRow.querySelector('.mp-link-action').textContent).toBe('Remove');
  });

  test('the source label agrees with the action button', async () => {
    // Reported bug: a row read "manual" but offered Unlink, because the label
    // used sourceType while the button used `editable`. A null source is
    // editable, so it must READ as manual too.
    await openTab('ledger');

    document.querySelectorAll('#ledger-container [data-mp-ledger-id]').forEach((row) => {
      const action = row.querySelector('.mp-link-action');
      if (!action) return; // derived rows offer no action - covered separately
      const saysManual = row.textContent.includes('manual');
      expect(saysManual).toBe(action.textContent === 'Remove');
    });
  });

  test('a derived estimate offers no action at all', async () => {
    // The job-install estimate is computed, not stored (ledgerId null), so
    // "Remove" and "Unlink" would both fail.
    ledger.categories.jobInstallation.items = [{
      ledgerId: null,
      typeId: null,
      category: 'job_install',
      amount: 1200,
      estimated: true,
      editable: false,
      note: 'Estimated (2 jobs)',
    }];
    await openTab('ledger');

    const rows = document.querySelectorAll('#ledger-container .mp-ledger-row');
    const derived = Array.from(rows).find((r) => r.textContent.includes('estimated'));
    expect(derived).toBeDefined();
    expect(derived.querySelector('.mp-link-action')).toBeNull();
  });

  test('a cost row with no item is labelled by its category', async () => {
    // Cost rows carry type_id 0, so the Item cell was blank.
    await openTab('ledger');

    const costRow = document.querySelector('[data-mp-ledger-id="led-2"]');
    expect(costRow.textContent).toContain('Job installation');
    // ...and its Detail cell shows an em dash rather than "0 x -".
    expect(costRow.textContent).not.toContain('0 ×');
  });

  test('an item row shows its resolved name and quantity breakdown', async () => {
    await openTab('ledger');

    const itemRow = document.querySelector('[data-mp-ledger-id="led-1"]');
    expect(itemRow.textContent).toContain('Tritanium');
    expect(itemRow.textContent).toContain('1,000 ×');
    expect(itemRow.textContent).not.toMatch(/Type \d+/);
  });

  test('removing an entry sends its ledger id', async () => {
    await openTab('ledger');

    document
      .querySelector('[data-mp-ledger-id="led-2"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.find((c) => c.fn === 'plans.unlinkLedgerEntry').ledgerId).toBe('led-2');
  });

  test('an empty ledger explains what to do', async () => {
    ledger.categories = {
      materialPurchases: { items: [], total: 0 },
      jobInstallation: { items: [], total: 0 },
      marketFees: { items: [], total: 0 },
      other: { items: [], total: 0 },
      productSales: { items: [], total: 0 },
    };
    await openTab('ledger');

    expect(document.getElementById('ledger-container').textContent)
      .toContain('No spend recorded yet');
  });
});

describe('settings - the two-axis source grids', () => {
  // These grids are the plan-scoped half of the blueprint-source work. They
  // MUST survive this port: dropping them silently reverts every plan to the
  // global sources.
  test('characters have separate Assets and Blueprints checkboxes', async () => {
    await openTab('settings');

    const row = document.querySelector('#plan-default-characters-container [data-mp-character]');
    expect(row.querySelector('.mp-axis-assets')).not.toBeNull();
    expect(row.querySelector('.mp-axis-blueprints')).not.toBeNull();
  });

  test('divisions have separate Assets and Blueprints checkboxes', async () => {
    await openTab('settings');

    const row = document.querySelector('#plan-character-divisions-container [data-mp-division]');
    expect(row.querySelector('.mp-axis-assets')).not.toBeNull();
    expect(row.querySelector('.mp-axis-blueprints')).not.toBeNull();
  });

  test('reflects the stored state of each axis independently', async () => {
    // Division 1 is an ASSET source; division 3 is a BLUEPRINT source. Neither
    // implies the other.
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div1 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '1');
    const div3 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '3');

    expect(div1.querySelector('.mp-axis-assets').checked).toBe(true);
    expect(div1.querySelector('.mp-axis-blueprints').checked).toBe(false);
    expect(div3.querySelector('.mp-axis-assets').checked).toBe(false);
    expect(div3.querySelector('.mp-axis-blueprints').checked).toBe(true);
  });

  test('toggling a BLUEPRINT division writes only the blueprint field', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div5 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '5');
    const checkbox = div5.querySelector('.mp-axis-blueprints');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'plans.updateCharacterBlueprintDivisions')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.updateCharacterDivisions')).toBe(false);
  });

  test('toggling an ASSET division writes only the asset field', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div5 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '5');
    const checkbox = div5.querySelector('.mp-axis-assets');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'plans.updateCharacterDivisions')).toBe(true);
    expect(calls.some((c) => c.fn === 'plans.updateCharacterBlueprintDivisions')).toBe(false);
  });

  test('toggling a character blueprint source does not touch the asset list', async () => {
    await openTab('settings');

    const row = document.querySelector(
      '#plan-default-characters-container [data-mp-character="96061222"]'
    );
    const checkbox = row.querySelector('.mp-axis-blueprints');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change'));
    await settle(20);

    const call = calls.find((c) => c.fn === 'plans.updateIndustrySettings');
    expect(call.settings.blueprintCharacters).toContain(96061222);
    expect(call.settings.defaultCharacters).not.toContain(96061222);
  });

  test('shows real corporation division names, not "Division N"', async () => {
    // Names come from divisions.getSettings, the same source Settings >
    // Industry uses. Without fetching them the grid showed generic labels
    // even when the real names were stored.
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div1 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '1');
    expect(div1.textContent).toContain('Production');
    expect(div1.textContent).not.toContain('Division 1');
  });

  test('a division with no fetched name falls back to the generic label', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div5 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '5');
    expect(div5.textContent).toContain('Division 5');
    expect(div5.querySelector('.mp-custom-badge')).toBeNull();
  });

  test('a fetched name is badged as custom', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div1 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '1');
    expect(div1.querySelector('.mp-custom-badge')).not.toBeNull();
  });

  test('Refresh Names re-fetches for that character only', async () => {
    await openTab('settings');
    calls.length = 0;

    document
      .querySelector('[data-mp-refresh-names="91316135"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'divisions.fetchNames');
    expect(call.characterId).toBe(91316135);
  });

  test('the reactions toggle is a switch, not a checkbox', async () => {
    // An on/off MODE, per the redesign - the shared .toggle control.
    await openTab('settings');

    const toggle = document.getElementById('mp-reactions-as-intermediates');
    expect(toggle.closest('.toggle')).not.toBeNull();
    expect(toggle.parentElement.querySelector('.toggle-slider')).not.toBeNull();
  });

  test('the reactions toggle reflects and saves plan state', async () => {
    await openTab('settings');

    const toggle = document.getElementById('mp-reactions-as-intermediates');
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.updateIndustrySettings');
    expect(call.settings.reactionsAsIntermediates).toBe(true);
  });
});

describe('settings - price overrides', () => {
  test('lists the plan overrides', async () => {
    await openTab('settings');
    // Header + 2 rows.
    expect(document.querySelectorAll('#mp-price-overrides .mp-override-row')).toHaveLength(3);
  });

  test('has column headers', async () => {
    await openTab('settings');

    const header = document.querySelector('#mp-price-overrides .mp-build-header');
    ['Item', 'Override', 'Market Lock', 'Drift', 'Updated']
      .forEach((label) => expect(header.textContent).toContain(label));
  });

  test('shows drift between the override and the lock it replaced', async () => {
    await openTab('settings');

    // 7.50 vs 5.25 = +42.9%
    const row = document.querySelector('[data-mp-override-type="34"]');
    expect(row.querySelector('.mp-drift').textContent).toBe('+42.9%');
  });

  test('an override with no market lock shows no drift, not 0%', async () => {
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="35"]');
    expect(row.querySelector('.mp-drift')).toBeNull();
  });

  test('delete is an icon button, not the word "Remove"', async () => {
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="34"]');
    const button = row.querySelector('.mp-icon-btn');
    expect(button).not.toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent.trim()).toBe('');
    expect(button.getAttribute('aria-label')).toContain('Tritanium');
  });

  test('shows the market snapshot the override replaced', async () => {
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="34"]');
    expect(row.textContent).toContain('7.50');
    expect(row.textContent).toContain('5.25');
  });

  test('an override with no snapshot shows an em dash', async () => {
    // Never locked, so there is nothing truthful to revert to.
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="35"]');
    expect(row.textContent).toContain('—');
  });

  test('removing an override sends its type id', async () => {
    await openTab('settings');

    // The delete control is an icon button now, not a text link.
    document
      .querySelector('[data-mp-override-type="34"] .mp-icon-btn')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.find((c) => c.fn === 'plans.removePriceOverride').typeId).toBe(34);
  });

  test('no overrides renders a message', async () => {
    priceOverrides = [];
    await openTab('settings');

    expect(document.getElementById('mp-price-overrides').textContent)
      .toContain('No price overrides');
  });
});

describe('modals', () => {
  test('all modals are closed on mount (rule 6a)', async () => {
    await mountView();
    await settle();

    document.querySelectorAll('#mp-view .modal').forEach((modal) => {
      expect(modal.hidden).toBe(true);
    });
  });

  test('New Plan opens the create modal with empty fields', async () => {
    await mountView();
    await settle();

    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    expect(document.getElementById('mp-create-modal').hidden).toBe(false);
    expect(document.getElementById('mp-create-name').value).toBe('');
  });

  test('creating a plan sends the name and selects it', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    document.getElementById('mp-create-name').value = 'New Batch';
    document.getElementById('mp-create-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.create');
    expect(call.name).toBe('New Batch');
    expect(document.getElementById('mp-create-modal').hidden).toBe(true);
  });

  test('an empty plan name is sent as null for auto-generation', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-create-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.find((c) => c.fn === 'plans.create').name).toBeNull();
  });

  test('a plan missing from the list is fetched directly', async () => {
    // Regression: selecting an id absent from the sidebar list left
    // state.plan null while planId was set, and renderOverview dereferenced
    // it. Reachable in the app when a plan is opened by id, or right after
    // creating one.
    //
    // The plan must be fetchable by id but ABSENT from the list - it belongs
    // to another character here, so getAll filters it out while get() still
    // returns it.
    const elsewhere = {
      planId: 'plan-elsewhere',
      characterId: 96061222,
      planName: 'Made Elsewhere',
      status: 'active',
      description: 'From another character',
      createdAt: 1,
    };
    plans.push(elsewhere);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await registered.def.mount(container, { planId: 'plan-elsewhere' }, makeCtx());
    await settle(40);

    expect(calls.some((c) => c.fn === 'plans.get' && c.planId === 'plan-elsewhere')).toBe(true);
    // ...and it renders rather than showing an empty pane.
    expect(container.querySelector('#plan-detail').hidden).toBe(false);
    expect(container.querySelector('#plan-name').textContent).toBe('Made Elsewhere');
  });

  test('a plan that no longer exists clears the selection instead of half-rendering', async () => {
    // The renderer warns rather than errors here - a deleted plan is a normal
    // state, not a fault - so no allowErrors is needed.
    const container = document.createElement('div');
    document.body.appendChild(container);
    await registered.def.mount(container, { planId: 'plan-deleted' }, makeCtx());
    await settle(40);

    // No detail pane, no crash.
    expect(container.querySelector('#plan-detail').hidden).toBe(true);
    expect(container.querySelector('#no-plan-selected').hidden).toBe(false);
  });

  test('Escape closes an open modal', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('mp-create-modal').hidden).toBe(true);
  });

  test('clicking the backdrop closes the modal', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    const modal = document.getElementById('mp-create-modal');
    modal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(modal.hidden).toBe(true);
  });

  test('clicking INSIDE the modal does not close it', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    document
      .querySelector('#mp-create-modal .modal-content')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(document.getElementById('mp-create-modal').hidden).toBe(false);
  });

  test('Add Cost rejects a zero amount rather than writing it', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-add-cost').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-cost-amount').value = '0';
    document.getElementById('mp-cost-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'plans.addLedgerCost')).toBe(false);
    expect(calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
  });

  test('Add Cost sends category, amount and note', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-add-cost').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-cost-category').value = 'shipping';
    document.getElementById('mp-cost-amount').value = '1500';
    document.getElementById('mp-cost-note').value = 'courier';
    document.getElementById('mp-cost-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.addLedgerCost');
    expect(call.options).toEqual({ category: 'shipping', amount: 1500, note: 'courier' });
  });

  test('the cost category list matches what the backend buckets', async () => {
    // 'shipping' is not in the backend's explicit list but IS bucketed into
    // "other" - dropping it would remove a working category.
    await mountView();
    await settle();

    const values = Array.from(document.getElementById('mp-cost-category').options)
      .map((o) => o.value);
    expect(values).toEqual(['other', 'shipping', 'broker_fee', 'sales_tax']);
  });

  test('Acquire Item lists only THIS plan\'s materials', async () => {
    // Acquiring something the plan does not need is meaningless, so the list
    // is the plan's materials rather than a global item search.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document
      .querySelector('#mp-acquire-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const labels = Array.from(document.querySelectorAll('.qf-ss-row')).map((r) => r.textContent);
    expect(labels.some((l) => l.includes('Tritanium'))).toBe(true);
    expect(labels.some((l) => l.includes('Pyerite'))).toBe(true);
  });

  test('Acquire requires a material selection', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-acquire-quantity').value = '10';
    document.getElementById('mp-acquire-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'plans.addItemAcquisition')).toBe(false);
  });

  test('an omitted unit price is sent as null, not 0', async () => {
    // 0 would mean "acquired for free"; null means "use the locked price".
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document
      .querySelector('#mp-acquire-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-acquire-quantity').value = '100';
    document.getElementById('mp-acquire-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.addItemAcquisition');
    expect(call.options.unitPrice).toBeNull();
    expect(call.options.quantity).toBe(100);
  });

  test('a backend rejection is surfaced verbatim', async () => {
    // The backend caps acquisition at what is still needed; that message is
    // more useful than a generic failure.
    allowErrors(/acquire failed/);
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document
      .querySelector('#mp-acquire-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-acquire-quantity').value = '999999';
    document.getElementById('mp-acquire-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const errorToast = calls.find((c) => c.fn === 'toast' && c.type === 'error');
    expect(errorToast.message).toContain('Exceeds still needed');
  });

  test('Add Blueprint searches asynchronously and sends the config', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="blueprints"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('add-blueprint-btn').dispatchEvent(new window.MouseEvent('click'));

    const input = document.querySelector('#mp-blueprint-host .qf-ss-trigger');
    input.dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const search = document.querySelector('.qf-ss-input');
    search.value = 'Hulk';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 320));
    await settle();

    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-blueprint-runs').value = '5';
    document.getElementById('mp-blueprint-me').value = '10';
    document.getElementById('mp-blueprint-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(call.config.blueprintTypeId).toBe(22546);
    expect(call.config.runs).toBe(5);
    expect(call.config.meLevel).toBe(10);
  });

  test('the Production Lines input reaches the handler as `lines`', async () => {
    // It was sent as `productionLines`, which addBlueprintToPlan does not
    // destructure - so the input silently did nothing and every blueprint
    // went in on a single line.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="blueprints"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('add-blueprint-btn').dispatchEvent(new window.MouseEvent('click'));

    const trigger = document.querySelector('#mp-blueprint-host .qf-ss-trigger');
    trigger.dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const search = document.querySelector('.qf-ss-input');
    search.value = 'Hulk';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 320));
    await settle();

    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-blueprint-runs').value = '5';
    document.getElementById('mp-blueprint-lines').value = '3';
    document.getElementById('mp-blueprint-confirm')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(call.config.lines).toBe(3);
    expect(call.config.productionLines).toBeUndefined();
  });

  describe('Add Blueprint defaults', () => {
    async function pickBlueprint() {
      await mountWithPlan();
      document
        .querySelector('.tab-button[data-tab="blueprints"]')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle(20);

      document.getElementById('add-blueprint-btn').dispatchEvent(new window.MouseEvent('click'));
      document
        .querySelector('#mp-blueprint-host .qf-ss-trigger')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle();

      const search = document.querySelector('.qf-ss-input');
      search.value = 'Hulk';
      search.dispatchEvent(new window.Event('input'));
      await new Promise((r) => setTimeout(r, 320));
      await settle();

      document
        .querySelectorAll('.qf-ss-row')[0]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await settle(30);
    }

    test('seeds ME/TE from the best OWNED blueprint', async () => {
      // Defaulting to 0 when the user owns an ME 10 copy would overstate the
      // plan's material cost from the moment it is created.
      await pickBlueprint();

      expect(document.getElementById('mp-blueprint-me').value).toBe('10');
      expect(document.getElementById('mp-blueprint-te').value).toBe('20');
    });

    test('says where the seeded values came from', async () => {
      await pickBlueprint();

      const note = document.getElementById('mp-blueprint-owned-note');
      expect(note.hidden).toBe(false);
      expect(note.textContent).toContain('BPO');
    });

    test('distinguishes a BPC from a BPO', async () => {
      ownedBlueprint = { me: 4, te: 8, isCopy: true, isCorporation: false };
      await pickBlueprint();

      expect(document.getElementById('mp-blueprint-owned-note').textContent).toContain('BPC');
    });

    test('an unowned blueprint defaults to 0 and says so', async () => {
      ownedBlueprint = null;
      await pickBlueprint();

      expect(document.getElementById('mp-blueprint-me').value).toBe('0');
      expect(document.getElementById('mp-blueprint-owned-note').textContent)
        .toContain('do not own');
    });

    test('shows runs per line when the job is split', async () => {
      // 30 runs over 3 lines is 10 each - that is what governs the schedule.
      await pickBlueprint();

      document.getElementById('mp-blueprint-runs').value = '30';
      document.getElementById('mp-blueprint-lines').value = '3';
      document.getElementById('mp-blueprint-lines').dispatchEvent(new window.Event('input'));

      const note = document.getElementById('mp-blueprint-runs-note');
      expect(note.hidden).toBe(false);
      expect(note.textContent).toContain('10 runs per line');
    });

    test('hides runs-per-line for a single line', async () => {
      await pickBlueprint();

      document.getElementById('mp-blueprint-runs').value = '30';
      document.getElementById('mp-blueprint-lines').value = '1';
      document.getElementById('mp-blueprint-lines').dispatchEvent(new window.Event('input'));

      expect(document.getElementById('mp-blueprint-runs-note').hidden).toBe(true);
    });
  });

  test('closing a modal destroys its dropdown', async () => {
    // A QFSearchSelect owns a document listener and a body-mounted popover, so
    // hiding the modal is not enough.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const spy = jest.spyOn(document, 'removeEventListener');
    document
      .querySelector('#mp-acquire-modal [data-mp-close]')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    spy.mockRestore();
  });

  test('switching plans closes any open modal', async () => {
    // A modal left open would submit against the NEW plan while showing the
    // old one's data.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    document.getElementById('mp-add-cost').dispatchEvent(new window.MouseEvent('click'));
    expect(document.getElementById('mp-cost-modal').hidden).toBe(false);

    document.querySelectorAll('.mp-plan-card')[1].dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('mp-cost-modal').hidden).toBe(true);
  });
});

describe('lifecycle', () => {
  test('mount subscribes exactly once', async () => {
    await mountView();
    await settle();

    expect(subscribers['default-character-changed']).toHaveLength(1);
  });

  test('unmount disposes subscriptions', async () => {
    const { ctx } = await mountView();
    await settle();

    ctx.dispose();

    expect(disposed['default-character-changed']).toBe(1);
    expect(subscribers['default-character-changed']).toHaveLength(0);
  });

  test('changing the default character closes the open plan', async () => {
    // The open plan belongs to the OLD character and may not exist for the
    // new one - leaving it up showed one character's plan while the rest of
    // the view described another.
    await mountWithPlan();
    expect(document.getElementById('plan-detail').hidden).toBe(false);

    subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(document.getElementById('plan-detail').hidden).toBe(true);
    expect(document.getElementById('no-plan-selected').hidden).toBe(false);
  });

  test('the cleared plan leaves no tab data behind', async () => {
    // Clearing only planId left every tab holding the old plan's materials,
    // jobs and ledger behind an empty detail pane.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="materials"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row').length)
      .toBeGreaterThan(0);

    subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row'))
      .toHaveLength(0);
  });

  test('picking a character in the view also closes the open plan', async () => {
    await mountWithPlan();

    const trigger = document.querySelector('#mp-character-host .qf-ss-trigger');
    trigger.dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document
      .querySelectorAll('.qf-ss-row')[1]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(40);

    expect(document.getElementById('plan-detail').hidden).toBe(true);
  });

  test('changing the default character leaves ONE character dropdown', async () => {
    // initCharacters re-runs on that event, and a bare `new QFSearchSelect`
    // APPENDS - so the user got a second dropdown stacked on the first, with
    // the old instance still holding a document listener and a popover.
    await mountView();
    await settle(30);
    expect(document.querySelectorAll('#mp-character-host .qf-ss-trigger')).toHaveLength(1);

    subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(document.querySelectorAll('#mp-character-host .qf-ss-trigger')).toHaveLength(1);
  });

  test('the replaced dropdown is destroyed, not just detached', async () => {
    // A leaked instance keeps listening on document and can leave an
    // orphaned popover attached to <body>.
    const { ctx } = await mountView();
    await settle(30);

    subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    ctx.dispose();
    // Nothing of the component survives the view.
    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('remounting leaves exactly one live subscription', async () => {
    const first = await mountView();
    await settle();
    first.ctx.dispose();

    document.body.innerHTML = '';
    const second = await mountView();
    await settle();

    expect(subscribers['default-character-changed']).toHaveLength(1);
    second.ctx.dispose();
  });

  test('destroy tears down the QFSearchSelect instances', async () => {
    const { instance } = await mountView();
    await settle();

    const spy = jest.spyOn(document, 'removeEventListener');
    instance.destroy();

    expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    spy.mockRestore();
  });
});

describe('resilience', () => {
  test('a failing drift load still renders the plan', async () => {
    allowErrors(/load failed: material drift/);
    window.electronAPI.plans.getMaterialDrift = async () => {
      throw new Error('market exploded');
    };

    await mountWithPlan();

    // Locked data is what matters; drift is a bonus.
    expect(document.getElementById('mp-stat-material-cost').textContent).toContain('100,000');
    expect(document.getElementById('mp-drift-banner').hidden).toBe(true);
  });

  test('a failing summary does not blank the materials tab', async () => {
    allowErrors(/load failed: summary/);
    window.electronAPI.plans.getSummary = async () => {
      throw new Error('summary exploded');
    };

    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="materials"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row')).toHaveLength(3);
  });

  test('a plan with no materials renders an empty state', async () => {
    materials = [];
    await mountWithPlan();

    expect(document.getElementById('mp-total-locked').textContent).toBe('—');
  });
});
