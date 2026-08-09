const { contextBridge, ipcRenderer } = require('electron');

/**
 * Subscribe to a main-process channel and return an unsubscribe function.
 *
 * EVERY `on*` method below must use this. The application shell mounts and
 * unmounts views repeatedly within one document, so a subscription without a
 * disposer accumulates: mounting a view twice means its handler fires twice per
 * event. This leak used to be masked because every navigation destroyed the
 * document and took its listeners with it - that is no longer true.
 *
 * Note this removes only the handler it created, unlike `removeAllListeners`,
 * which would also tear down other views' handlers on the same channel.
 *
 * @param {string} channel
 * @param {Function} callback  Receives the payload (not the IpcRendererEvent).
 * @returns {() => void} unsubscribe
 */
function subscribe(channel, callback) {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  openSettings: () => ipcRenderer.send('open-settings'),

  // Settings API
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    update: (category, updates) => ipcRenderer.invoke('settings:update', category, updates),
    get: (category, key) => ipcRenderer.invoke('settings:get', category, key),
    reset: () => ipcRenderer.invoke('settings:reset'),
    getPath: () => ipcRenderer.invoke('settings:getPath'),
  },

  // Audit Mode API
  audit: {
    openWindow: () => ipcRenderer.invoke('audit:openWindow'),
    getRecords: (filters) => ipcRenderer.invoke('audit:getRecords', filters),
    clearRecords: () => ipcRenderer.invoke('audit:clearRecords'),
    getSummary: () => ipcRenderer.invoke('audit:getSummary'),
    onRecordAdded: (callback) => {
      const listener = (event, record) => callback(record);
      ipcRenderer.on('audit:recordAdded', listener);
      return () => ipcRenderer.removeListener('audit:recordAdded', listener);
    },
  },

  // ESI API
  esi: {
    authenticate: () => ipcRenderer.invoke('esi:authenticate'),
    getCharacters: () => ipcRenderer.invoke('esi:getCharacters'),
    removeCharacter: (characterId) => ipcRenderer.invoke('esi:removeCharacter', characterId),
    refreshToken: (characterId) => ipcRenderer.invoke('esi:refreshToken', characterId),
    getCharacter: (characterId) => ipcRenderer.invoke('esi:getCharacter', characterId),
    // id -> name for the ids that resolve; unresolvable ones are omitted.
    resolveCorporationNames: (corporationIds) =>
      ipcRenderer.invoke('esi:resolveCorporationNames', corporationIds),
    setDefaultCharacter: (characterId) => ipcRenderer.invoke('esi:setDefaultCharacter', characterId),
    getDefaultCharacter: () => ipcRenderer.invoke('esi:getDefaultCharacter'),
    clearDefaultCharacter: () => ipcRenderer.invoke('esi:clearDefaultCharacter'),
    onDefaultCharacterChanged: (callback) => subscribe('default-character-changed', callback),
    checkMissingScopes: (characterId) => ipcRenderer.invoke('esi:checkMissingScopes', characterId),
    openAuthErrorWindow: (errorInfo) => ipcRenderer.invoke('esi:openAuthErrorWindow', errorInfo),
    refreshGlobalNow: () => ipcRenderer.invoke('esi:refreshGlobalNow'),
    getGlobalRefreshStatus: () => ipcRenderer.invoke('esi:getGlobalRefreshStatus'),
  },

  // SDE API
  sde: {
    checkUpdate: () => ipcRenderer.invoke('sde:checkUpdate'),
    download: () => ipcRenderer.invoke('sde:download'),
    downloadAndValidate: () => ipcRenderer.invoke('sde:downloadAndValidate'),
    validateCurrent: () => ipcRenderer.invoke('sde:validateCurrent'),
    restoreBackup: () => ipcRenderer.invoke('sde:restoreBackup'),
    hasBackup: () => ipcRenderer.invoke('sde:hasBackup'),
    getBackupVersion: () => ipcRenderer.invoke('sde:getBackupVersion'),
    getCurrentVersion: () => ipcRenderer.invoke('sde:getCurrentVersion'),
    getLatestVersion: () => ipcRenderer.invoke('sde:getLatestVersion'),
    getMinimumVersion: () => ipcRenderer.invoke('sde:getMinimumVersion'),
    exists: () => ipcRenderer.invoke('sde:exists'),
    delete: () => ipcRenderer.invoke('sde:delete'),
    getPath: () => ipcRenderer.invoke('sde:getPath'),
    onProgress: (callback) => subscribe('sde:progress', callback),
    // No `onUpdateAvailable` here: the app does not push SDE update
    // notifications. Updates are found at startup (startup-manager.js) or on
    // demand via `checkUpdate` below - there is no background polling, so
    // there is nothing to subscribe to. `app.onUpdateAvailable` is a different
    // channel entirely: that one is the APPLICATION updater, and it is live.
    // Skill lookups
    getSkillName: (skillId) => ipcRenderer.invoke('sde:getSkillName', skillId),
    getSkillNames: (skillIds) => ipcRenderer.invoke('sde:getSkillNames', skillIds),
    // Name + group + training rank in one query; prefer this when grouping.
    getSkillInfo: (skillIds) => ipcRenderer.invoke('sde:getSkillInfo', skillIds),
    getAllSkills: () => ipcRenderer.invoke('sde:getAllSkills'),
    getSkillGroup: (skillId) => ipcRenderer.invoke('sde:getSkillGroup', skillId),
    searchSkills: (searchTerm) => ipcRenderer.invoke('sde:searchSkills', searchTerm),
    // Blueprint lookups
    getBlueprintName: (typeId) => ipcRenderer.invoke('sde:getBlueprintName', typeId),
    getBlueprintNames: (typeIds) => ipcRenderer.invoke('sde:getBlueprintNames', typeIds),
    getAllBlueprints: () => ipcRenderer.invoke('sde:getAllBlueprints'),
    searchBlueprints: (searchTerm) => ipcRenderer.invoke('sde:searchBlueprints', searchTerm),
    // Type lookups
    getTypeName: (typeId) => ipcRenderer.invoke('sde:getTypeName', typeId),
    getTypeNames: (typeIds) => ipcRenderer.invoke('sde:getTypeNames', typeIds),
    // Market location lookups
    getAllRegions: () => ipcRenderer.invoke('sde:getAllRegions'),
    getAllSystems: () => ipcRenderer.invoke('sde:getAllSystems'),
    searchSystems: (searchTerm) => ipcRenderer.invoke('sde:searchSystems', searchTerm),
    getStationsInSystem: (systemId) => ipcRenderer.invoke('sde:getStationsInSystem', systemId),
    getTradeHubs: () => ipcRenderer.invoke('sde:getTradeHubs'),
    searchMarketItems: (searchTerm) => ipcRenderer.invoke('sde:searchMarketItems', searchTerm),
    getItemDetails: (typeID) => ipcRenderer.invoke('sde:getItemDetails', typeID),
    getSystemSecurityStatus: (systemId) => ipcRenderer.invoke('sde:getSystemSecurityStatus', systemId),
    getItemVolume: (typeId) => ipcRenderer.invoke('sde:getItemVolume', typeId),
    getItemVolumes: (typeIds) => ipcRenderer.invoke('sde:getItemVolumes', typeIds),
    getTypeCategoryInfo: (typeIds) => ipcRenderer.invoke('sde:getTypeCategoryInfo', typeIds),
    getLocationName: (locationId) => ipcRenderer.invoke('sde:getLocationName', locationId),
  },

  // Skills API
  skills: {
    fetch: (characterId) => ipcRenderer.invoke('skills:fetch', characterId),
    setOverride: (characterId, skillId, level) => ipcRenderer.invoke('skills:setOverride', characterId, skillId, level),
    getEffectiveLevel: (characterId, skillId) => ipcRenderer.invoke('skills:getEffectiveLevel', characterId, skillId),
    clearOverrides: (characterId) => ipcRenderer.invoke('skills:clearOverrides', characterId),
    getCacheStatus: (characterId) => ipcRenderer.invoke('skills:getCacheStatus', characterId),
    // No openWindow/onCharacterId: the Skills Manager is a native shell view
    // opened via window.openView('skills', { characterId }), which hands the
    // character id in as a mount param instead of racing an IPC message.
  },

  // Manufacturing Summary API
  summary: {
    /**
     * Run the summary. Progress arrives on the separate onProgress channel -
     * a callback cannot cross the IPC boundary, so the two are split.
     */
    calculate: (options) => ipcRenderer.invoke('summary:calculate', options),
    // Asks the in-flight run for THIS frame to stop at the next batch
    // boundary. calculate() then resolves with { cancelled: true }.
    cancel: () => ipcRenderer.invoke('summary:cancel'),
    onProgress: (callback) => subscribe('summary:progress', callback),
  },

  // Blueprints API
  blueprints: {
    fetch: (characterId) => ipcRenderer.invoke('blueprints:fetch', characterId),
    getAll: (characterId) => ipcRenderer.invoke('blueprints:getAll', characterId),
    addManual: (blueprintData) => ipcRenderer.invoke('blueprints:addManual', blueprintData),
    remove: (characterId, itemId) => ipcRenderer.invoke('blueprints:remove', characterId, itemId),
    setOverride: (characterId, itemId, field, value) => ipcRenderer.invoke('blueprints:setOverride', characterId, itemId, field, value),
    getEffectiveValues: (itemId) => ipcRenderer.invoke('blueprints:getEffectiveValues', itemId),
    getCacheStatus: (characterId) => ipcRenderer.invoke('blueprints:getCacheStatus', characterId),
    openInCalculator: (blueprintTypeId, meLevel) => ipcRenderer.invoke('blueprints:openInCalculator', blueprintTypeId, meLevel),
    // No openWindow/onCharacterId: the Blueprint Manager is a native shell view
    // and takes its character id as a mount param.
    onOpenInCalculator: (callback) => subscribe('calculator:openBlueprint', callback),
  },

  // Assets API
  assets: {
    fetch: (characterId) => ipcRenderer.invoke('assets:fetch', characterId),
    get: (characterId, isCorporation) => ipcRenderer.invoke('assets:get', characterId, isCorporation),
    getCacheStatus: (characterId, isCorporation) => ipcRenderer.invoke('assets:getCacheStatus', characterId, isCorporation),
    // No openWindow here: opening a screen in its own window is generic, via
    // window.openView('assets', { characterId }). A per-screen opener is the
    // legacy pattern being replaced.
  },

  // Division Settings API
  divisions: {
    getSettings: (characterId) => ipcRenderer.invoke('divisions:getSettings', characterId),
    updateEnabled: (characterId, enabledDivisions) => ipcRenderer.invoke('divisions:updateEnabled', characterId, enabledDivisions),
    fetchNames: (characterId) => ipcRenderer.invoke('divisions:fetchNames', characterId),
    getCacheStatus: (characterId) => ipcRenderer.invoke('divisions:getCacheStatus', characterId),
    getGenericName: (divisionId) => ipcRenderer.invoke('divisions:getGenericName', divisionId),
    // Blueprint sources - a SEPARATE axis from the asset divisions above.
    // A corp may keep BPOs in a library division while materials live in a
    // production division, so these never write each other's columns.
    getBlueprintSettings: (characterId) =>
      ipcRenderer.invoke('divisions:getBlueprintSettings', characterId),
    updateBlueprintDivisions: (characterId, divisions) =>
      ipcRenderer.invoke('divisions:updateBlueprintDivisions', characterId, divisions),
    setUseBlueprintsFrom: (characterId, enabled) =>
      ipcRenderer.invoke('divisions:setUseBlueprintsFrom', characterId, enabled),
  },

  // Industry Settings API
  industry: {
    getDefaultManufacturingCharacters: () => ipcRenderer.invoke('industry:getDefaultManufacturingCharacters'),
    setDefaultManufacturingCharacters: (characterIds) => ipcRenderer.invoke('industry:setDefaultManufacturingCharacters', characterIds),
  },

  // Industry Jobs API
  industryJobs: {
    fetch: (characterId, includeCompleted) => ipcRenderer.invoke('industryJobs:fetch', characterId, includeCompleted),
    fetchCorporation: (characterId, corporationId, includeCompleted) => ipcRenderer.invoke('industryJobs:fetchCorporation', characterId, corporationId, includeCompleted),
    get: (characterId, filters) => ipcRenderer.invoke('industryJobs:get', characterId, filters),
    getCacheStatus: (characterId) => ipcRenderer.invoke('industryJobs:getCacheStatus', characterId),
  },

  // Wallet API
  wallet: {
    fetchTransactions: (characterId, fromId) => ipcRenderer.invoke('wallet:fetchTransactions', characterId, fromId),
    getTransactions: (characterId, filters) => ipcRenderer.invoke('wallet:getTransactions', characterId, filters),
    getCacheStatus: (characterId) => ipcRenderer.invoke('wallet:getCacheStatus', characterId),
  },

  // Manufacturing Plans API
  plans: {
    create: (characterId, planName, description) => ipcRenderer.invoke('plans:create', characterId, planName, description),
    get: (planId) => ipcRenderer.invoke('plans:get', planId),
    getAll: (characterId, filters) => ipcRenderer.invoke('plans:getAll', characterId, filters),
    update: (planId, updates) => ipcRenderer.invoke('plans:update', planId, updates),
    delete: (planId) => ipcRenderer.invoke('plans:delete', planId),
    // Industry settings
    getIndustrySettings: (planId) => ipcRenderer.invoke('plans:getIndustrySettings', planId),
    updateIndustrySettings: (planId, settings) => ipcRenderer.invoke('plans:updateIndustrySettings', planId, settings),
    updateCharacterDivisions: (planId, characterId, divisions) => ipcRenderer.invoke('plans:updateCharacterDivisions', planId, characterId, divisions),
    // Blueprint sources for this plan - separate axis from the asset divisions.
    updateCharacterBlueprintDivisions: (planId, characterId, divisions) => ipcRenderer.invoke('plans:updateCharacterBlueprintDivisions', planId, characterId, divisions),
    addBlueprint: (planId, blueprintConfig) => ipcRenderer.invoke('plans:addBlueprint', planId, blueprintConfig),
    updateBlueprint: (planBlueprintId, updates) => ipcRenderer.invoke('plans:updateBlueprint', planBlueprintId, updates),
    bulkUpdateBlueprints: (planId, bulkUpdates) => ipcRenderer.invoke('plans:bulkUpdateBlueprints', planId, bulkUpdates),
    removeBlueprint: (planBlueprintId) => ipcRenderer.invoke('plans:removeBlueprint', planBlueprintId),
    getBlueprints: (planId) => ipcRenderer.invoke('plans:getBlueprints', planId),
    getIntermediateBlueprints: (planBlueprintId) => ipcRenderer.invoke('plans:getIntermediateBlueprints', planBlueprintId),
    getAllIntermediates: (planId) => ipcRenderer.invoke('plans:getAllIntermediates', planId),
    updateIntermediateBlueprint: (intermediateBlueprintId, updates) => ipcRenderer.invoke('plans:updateIntermediateBlueprint', intermediateBlueprintId, updates),
    markIntermediateBuilt: (intermediateBlueprintId, builtRuns) => ipcRenderer.invoke('plans:markIntermediateBuilt', intermediateBlueprintId, builtRuns),
    // Reaction functions
    getReactions: (planId) => ipcRenderer.invoke('plans:getReactions', planId),
    setReactionChildBuildPlan: (planId, reactionTypeId, childTypeId, buildPlan) => ipcRenderer.invoke('plans:setReactionChildBuildPlan', planId, reactionTypeId, childTypeId, buildPlan),
    calculateReactionTree: (reactionBlueprintId, runs, characterId, facilityId, marketSetId) => ipcRenderer.invoke('plans:calculateReactionTree', reactionBlueprintId, runs, characterId, facilityId, marketSetId),
    getBuildItems: (planId) => ipcRenderer.invoke('plans:getBuildItems', planId),
    updateBuildItemsByType: (planId, itemType, blueprintTypeId, updates) => ipcRenderer.invoke('plans:updateBuildItemsByType', planId, itemType, blueprintTypeId, updates),
    markReactionBuilt: (planBlueprintId, builtRuns) => ipcRenderer.invoke('plans:markReactionBuilt', planBlueprintId, builtRuns),
    getMaterials: (planId, includeAssets) => ipcRenderer.invoke('plans:getMaterials', planId, includeAssets),
    // Live prices for drift display. Read-only: the plan's locked cost basis is
    // unaffected until an explicit re-lock.
    getMaterialDrift: (planId, marketSetId) => ipcRenderer.invoke('plans:getMaterialDrift', planId, marketSetId),
    getProducts: (planId) => ipcRenderer.invoke('plans:getProducts', planId),
    getProductOwnedAssets: (planId, typeId) => ipcRenderer.invoke('plans:getProductOwnedAssets', planId, typeId),
    getSummary: (planId) => ipcRenderer.invoke('plans:getSummary', planId),
    recalculateMaterials: (planId, refreshPrices, marketSetId) => ipcRenderer.invoke('plans:recalculateMaterials', planId, refreshPrices, marketSetId),
    refreshESIData: (characterId) => ipcRenderer.invoke('plans:refreshESIData', characterId),
    refreshPlanESIData: (planId) => ipcRenderer.invoke('plans:refreshPlanESIData', planId),
    // Matching functions
    matchJobs: (planId, options) => ipcRenderer.invoke('plans:matchJobs', planId, options),
    saveJobMatches: (matches) => ipcRenderer.invoke('plans:saveJobMatches', matches),
    matchTransactions: (planId, options) => ipcRenderer.invoke('plans:matchTransactions', planId, options),
    saveTransactionMatches: (planId, matches) => ipcRenderer.invoke('plans:saveTransactionMatches', planId, matches),
    confirmJobMatch: (matchId) => ipcRenderer.invoke('plans:confirmJobMatch', matchId),
    rejectJobMatch: (matchId) => ipcRenderer.invoke('plans:rejectJobMatch', matchId),
    confirmTransactionMatch: (matchId) => ipcRenderer.invoke('plans:confirmTransactionMatch', matchId),
    rejectTransactionMatch: (matchId) => ipcRenderer.invoke('plans:rejectTransactionMatch', matchId),
    getPendingMatches: (planId) => ipcRenderer.invoke('plans:getPendingMatches', planId),
    getConfirmedJobMatches: (planId) => ipcRenderer.invoke('plans:getConfirmedJobMatches', planId),
    unlinkJobMatch: (matchId) => ipcRenderer.invoke('plans:unlinkJobMatch', matchId),
    getConfirmedTransactionMatches: (planId) => ipcRenderer.invoke('plans:getConfirmedTransactionMatches', planId),
    unlinkTransactionMatch: (matchId) => ipcRenderer.invoke('plans:unlinkTransactionMatch', matchId),
    getActuals: (planId) => ipcRenderer.invoke('plans:getActuals', planId),
    getAnalytics: (planId) => ipcRenderer.invoke('plans:getAnalytics', planId),
    refreshESIData: (characterId) => ipcRenderer.invoke('plans:refreshESIData', characterId),
    // Material acquisition functions
    markMaterialAcquired: (planId, typeId, options) => ipcRenderer.invoke('plans:markMaterialAcquired', planId, typeId, options),
    unmarkMaterialAcquired: (planId, typeId) => ipcRenderer.invoke('plans:unmarkMaterialAcquired', planId, typeId),
    updateMaterialAcquisition: (planId, typeId, updates) => ipcRenderer.invoke('plans:updateMaterialAcquisition', planId, typeId, updates),
    updateMaterialCustomPrice: (planId, typeId, customPrice) => ipcRenderer.invoke('plans:updateMaterialCustomPrice', planId, typeId, customPrice),
    setPriceOverride: (planId, typeId, price) => ipcRenderer.invoke('plans:setPriceOverride', planId, typeId, price),
    removePriceOverride: (planId, typeId) => ipcRenderer.invoke('plans:removePriceOverride', planId, typeId),
    getPriceOverrides: (planId) => ipcRenderer.invoke('plans:getPriceOverrides', planId),
    cleanupExcessAcquisitions: (planId, typeId) => ipcRenderer.invoke('plans:cleanupExcessAcquisitions', planId, typeId),
    getAcquisitionLog: (planId, typeId) => ipcRenderer.invoke('plans:getAcquisitionLog', planId, typeId),
    getMaterialTree: (planId, planBlueprintId) => ipcRenderer.invoke('plans:getMaterialTree', planId, planBlueprintId),
    getMaterialTreeNodeDetail: (planBlueprintId) => ipcRenderer.invoke('plans:getMaterialTreeNodeDetail', planBlueprintId),
    // Ledger
    getLedger: (planId) => ipcRenderer.invoke('plans:getLedger', planId),
    addLedgerCost: (planId, options) => ipcRenderer.invoke('plans:addLedgerCost', planId, options),
    addItemAcquisition: (planId, typeId, options) => ipcRenderer.invoke('plans:addItemAcquisition', planId, typeId, options),
    updateLedgerEntry: (ledgerId, updates) => ipcRenderer.invoke('plans:updateLedgerEntry', ledgerId, updates),
    deleteLedgerEntry: (ledgerId) => ipcRenderer.invoke('plans:deleteLedgerEntry', ledgerId),
    unlinkLedgerEntry: (planId, ledgerId) => ipcRenderer.invoke('plans:unlinkLedgerEntry', planId, ledgerId),
    getTransactionDetail: (transactionId, isCorp) => ipcRenderer.invoke('plans:getTransactionDetail', transactionId, isCorp),
    getJournalDetail: (journalId, isCorp) => ipcRenderer.invoke('plans:getJournalDetail', journalId, isCorp),
  },

  // Location API
  location: {
    resolve: (locationId, characterId, isCorporation) =>
      ipcRenderer.invoke('location:resolve', locationId, characterId, isCorporation),
    // Prefer this for lists: one call, deduped by location id.
    resolveMany: (locationIds, characterId, isCorporation) =>
      ipcRenderer.invoke('location:resolveMany', locationIds, characterId, isCorporation),
  },

  // Player-structure name cache
  structures: {
    // Force a re-resolve, overriding BOTH the 24h name TTL and the 7-day
    // access-denied backoff. Stops early (reporting partial progress) if the
    // ESI error budget runs low, since forcing many previously denied lookups
    // is exactly the 403 burst the backoff exists to prevent.
    manualRefresh: (options) => ipcRenderer.invoke('structures:manualRefresh', options),
    getStats: () => ipcRenderer.invoke('structures:getStats'),
  },

  // Market API
  market: {
    // Market Sets CRUD
    getMarketSets: () => ipcRenderer.invoke('market:getMarketSets'),
    addMarketSet: (setData) => ipcRenderer.invoke('market:addMarketSet', setData),
    updateMarketSet: (id, updates) => ipcRenderer.invoke('market:updateMarketSet', id, updates),
    deleteMarketSet: (id) => ipcRenderer.invoke('market:deleteMarketSet', id),
    setDefaultMarketSet: (id) => ipcRenderer.invoke('market:setDefaultMarketSet', id),
    getMarketSetForTool: (toolKey) => ipcRenderer.invoke('market:getMarketSetForTool', toolKey),
    setMarketSetForTool: (toolKey, id) => ipcRenderer.invoke('market:setMarketSetForTool', toolKey, id),
    getRegionDashboard: () => ipcRenderer.invoke('market:getRegionDashboard'),
    updateRegion: (regionId) => ipcRenderer.invoke('market:updateRegion', regionId),
    // Market data
    fetchOrders: (regionId, typeId, locationFilter) => ipcRenderer.invoke('market:fetchOrders', regionId, typeId, locationFilter),
    fetchHistory: (regionId, typeId) => ipcRenderer.invoke('market:fetchHistory', regionId, typeId),
    fetchData: (regionId, typeId) => ipcRenderer.invoke('market:fetchData', regionId, typeId),
    // Every profitability metric for one product from ONE history read. Prefer
    // this over calling the individual metrics: six separate calls per
    // blueprint each re-fetched the same history.
    metricsForProduct: (options) => ipcRenderer.invoke('metrics:forProduct', options),
    materialVolatility: (options) => ipcRenderer.invoke('metrics:materialVolatility', options),
    fetchFuzzwork: (typeId, regionId) => ipcRenderer.invoke('market:fetchFuzzwork', typeId, regionId),
    fetchJitaPrice: (typeId) => ipcRenderer.invoke('market:fetchJitaPrice', typeId),
    fetchBulkPrices: (typeIds, regionId) => ipcRenderer.invoke('market:fetchBulkPrices', typeIds, regionId),
    calculatePrice: (typeId, regionId, locationId, priceType, quantity, marketSetId, settingsScope) =>
      ipcRenderer.invoke('market:calculatePrice', typeId, regionId, locationId, priceType, quantity, marketSetId, settingsScope),
    // Prefer this for lists: one call, deduped by typeId. Same pricing rules as
    // calculatePrice - a per-item loop over a large list is what made the
    // Assets screen hammer ESI.
    calculatePrices: (typeIds, options) =>
      ipcRenderer.invoke('market:calculatePrices', typeIds, options),
    getPriceOverride: (typeId) => ipcRenderer.invoke('market:getPriceOverride', typeId),
    setPriceOverride: (typeId, price, notes) => ipcRenderer.invoke('market:setPriceOverride', typeId, price, notes),
    removePriceOverride: (typeId) => ipcRenderer.invoke('market:removePriceOverride', typeId),
    getAllPriceOverrides: () => ipcRenderer.invoke('market:getAllPriceOverrides'),
    getLastFetchTime: () => ipcRenderer.invoke('market:getLastFetchTime'),

    // Seeded trade hubs, for the set editor's location picker.
    getMarketLocations: () => ipcRenderer.invoke('market:getMarketLocations'),

    // Inspector: plans referencing a type, and a single-material re-lock.
    getPlansUsingType: (typeId) => ipcRenderer.invoke('market:getPlansUsingType', typeId),
    relockPlanMaterial: (planId, typeId, price) =>
      ipcRenderer.invoke('market:relockPlanMaterial', planId, typeId, price),
    getCachedHistory: (regionId, typeId, days) =>
      ipcRenderer.invoke('market:getCachedHistory', regionId, typeId, days),

    // Items actually traded in a region (SDE names ∩ cached orders).
    searchTradedItems: (regionId, searchTerm, limit) =>
      ipcRenderer.invoke('market:searchTradedItems', regionId, searchTerm, limit),
    getOrderBookSummary: (regionId, typeIds) =>
      ipcRenderer.invoke('market:getOrderBookSummary', regionId, typeIds),

    // Watchlists, watchlist items, favourites, and alert evaluation.
    watchlists: {
      getAll: () => ipcRenderer.invoke('market:getWatchlists'),
      get: (watchlistId) => ipcRenderer.invoke('market:getWatchlist', watchlistId),
      create: (data) => ipcRenderer.invoke('market:createWatchlist', data),
      update: (watchlistId, updates) => ipcRenderer.invoke('market:updateWatchlist', watchlistId, updates),
      remove: (watchlistId) => ipcRenderer.invoke('market:deleteWatchlist', watchlistId),
      addItem: (watchlistId, typeId, alert) => ipcRenderer.invoke('market:addWatchlistItem', watchlistId, typeId, alert),
      updateItem: (itemId, updates) => ipcRenderer.invoke('market:updateWatchlistItem', itemId, updates),
      removeItem: (itemId) => ipcRenderer.invoke('market:removeWatchlistItem', itemId),
      rebaseline: (itemId, prices) =>
        ipcRenderer.invoke('market:rebaselineWatchlistItem', itemId, prices),
      // No `evaluateAlerts`: alert state is derived in the renderer from the
      // live price against the stored baseline, not evaluated in main.
    },
    favorites: {
      getAll: () => ipcRenderer.invoke('market:getFavorites'),
      toggle: (typeId) => ipcRenderer.invoke('market:toggleFavorite', typeId),
      set: (typeId, isFavorite) => ipcRenderer.invoke('market:setFavorite', typeId, isFavorite),
    },
    manualRefresh: (regionId) => ipcRenderer.invoke('market:manualRefresh', regionId),
    getLastHistoryFetchTime: () => ipcRenderer.invoke('market:getLastHistoryFetchTime'),
    getHistoryDataStatus: (regionId) => ipcRenderer.invoke('market:getHistoryDataStatus', regionId),
    manualRefreshHistory: (regionId) => ipcRenderer.invoke('market:manualRefreshHistory', regionId),
    refreshAdjustedPrices: () => ipcRenderer.invoke('market:refreshAdjustedPrices'),
    refreshMultipleRegions: (regionIds) => ipcRenderer.invoke('market:refreshMultipleRegions', regionIds),
    updateAllMarketData: () => ipcRenderer.invoke('market:updateAllMarketData'),
    searchStructures: (characterId, searchTerm) =>
      ipcRenderer.invoke('market:searchStructures', characterId, searchTerm),
    refreshStructureMarket: (structureId, regionId, characterId) =>
      ipcRenderer.invoke('market:refreshStructureMarket', structureId, regionId, characterId),
    onFetchProgress: (callback) => subscribe('market:fetchProgress', callback),

    /**
     * Which stage of a full market refresh is running.
     *
     * Payload: `{ phase, current, total, regionId?, structureId?, label?, at }`.
     * Phases run `starting` -> `regions` -> `structures` -> `adjusted-prices`
     * -> `cost-indices` -> `done`. Only main knows the plan, so this is what
     * lets the UI show "region 3 of 12" rather than an anonymous spinner.
     */
    onRefreshStage: (callback) => subscribe('market:refreshStage', callback),
    onHistoryProgress: (callback) => subscribe('market:historyProgress', callback),
  },

  // Blueprint Calculator API
  calculator: {
    searchBlueprints: (searchTerm, limit) => ipcRenderer.invoke('calculator:searchBlueprints', searchTerm, limit),
    calculateMaterials: (blueprintTypeId, runs, meLevel, characterId, facilityId, marketSetId) =>
      ipcRenderer.invoke('calculator:calculateMaterials', blueprintTypeId, runs, meLevel, characterId, facilityId, marketSetId),
    getBlueprintProduct: (blueprintTypeId) => ipcRenderer.invoke('calculator:getBlueprintProduct', blueprintTypeId),
    getTypeName: (typeId) => ipcRenderer.invoke('calculator:getTypeName', typeId),
    // Resolves against the ENABLED blueprint sources (Settings > Industry) and
    // returns which copy won - ME, TE, personal/corp, BPO/BPC.
    resolveOwnedBlueprint: (blueprintTypeId) => ipcRenderer.invoke('calculator:resolveOwnedBlueprint', blueprintTypeId),
    getRigBonuses: (rigTypeId) => ipcRenderer.invoke('calculator:getRigBonuses', rigTypeId),
    getAllBlueprints: (limit) => ipcRenderer.invoke('calculator:getAllBlueprints', limit),
    getAllReactions: (limit) => ipcRenderer.invoke('calculator:getAllReactions', limit),
    // Invention API
    getInventionData: (blueprintTypeId) => ipcRenderer.invoke('calculator:getInventionData', blueprintTypeId),
    getAllDecryptors: () => ipcRenderer.invoke('calculator:getAllDecryptors'),
    getBlueprintMaterials: (blueprintTypeId) => ipcRenderer.invoke('calculator:getBlueprintMaterials', blueprintTypeId),
    calculateInventionProbability: (baseProbability, skills, decryptorMultiplier) =>
      ipcRenderer.invoke('calculator:calculateInventionProbability', baseProbability, skills, decryptorMultiplier),
    findBestDecryptor: (inventionData, materialPrices, productPrice, skills, facility, optimizationStrategy, marketSetId) =>
      ipcRenderer.invoke('calculator:findBestDecryptor', inventionData, materialPrices, productPrice, skills, facility, optimizationStrategy, marketSetId),
    clearCaches: () => ipcRenderer.invoke('calculator:clearCaches'),
  },

  // Reactions Calculator API
  reactions: {
    searchReactions: (searchTerm, limit) => ipcRenderer.invoke('reactions:searchReactions', searchTerm, limit),
    calculateMaterials: (reactionTypeId, runs, characterId, facilityId, marketSetId) =>
      ipcRenderer.invoke('reactions:calculateMaterials', reactionTypeId, runs, characterId, facilityId, marketSetId),
    getReactionProduct: (reactionTypeId) => ipcRenderer.invoke('reactions:getReactionProduct', reactionTypeId),
    getTypeName: (typeId) => ipcRenderer.invoke('reactions:getTypeName', typeId),
    getReactionTime: (reactionTypeId) => ipcRenderer.invoke('reactions:getReactionTime', reactionTypeId),
    clearCaches: () => ipcRenderer.invoke('reactions:clearCaches'),
  },

  // Cost Indices API
  costIndices: {
    fetch: () => ipcRenderer.invoke('costIndices:fetch'),
    getCostIndices: (solarSystemId) => ipcRenderer.invoke('costIndices:getCostIndices', solarSystemId),
    getAll: () => ipcRenderer.invoke('costIndices:getAll'),
    getLastFetchTime: () => ipcRenderer.invoke('costIndices:getLastFetchTime'),
    getSystemCount: () => ipcRenderer.invoke('costIndices:getSystemCount'),
  },

  // Facilities API
  facilities: {
    getFacilities: () => ipcRenderer.invoke('facilities:getFacilities'),
    addFacility: (facility) => ipcRenderer.invoke('facilities:addFacility', facility),
    updateFacility: (id, updates) => ipcRenderer.invoke('facilities:updateFacility', id, updates),
    removeFacility: (id) => ipcRenderer.invoke('facilities:removeFacility', id),
    getFacility: (id) => ipcRenderer.invoke('facilities:getFacility', id),
    getAllRegions: () => ipcRenderer.invoke('facilities:getAllRegions'),
    getSystemsByRegion: (regionId) => ipcRenderer.invoke('facilities:getSystemsByRegion', regionId),
    getCostIndices: (systemId) => ipcRenderer.invoke('facilities:getCostIndices', systemId),
    getStructureTypes: () => ipcRenderer.invoke('facilities:getStructureTypes'),
    getStructureRigs: (structureType = null) => ipcRenderer.invoke('facilities:getStructureRigs', structureType),
    getStructureBonuses: (typeId) => ipcRenderer.invoke('facilities:getStructureBonuses', typeId),
    getRigEffects: (typeId) => ipcRenderer.invoke('facilities:getRigEffects', typeId),
  },

  // No manufacturingSummary namespace: the screen is a native shell view, and
  // its calculation lives under `summary` above.

  // Loot Analyzer data API. There is no `lootAnalyzer.openWindow` any more -
  // the screen is a native shell view and mounts in the main window.
  loot: {
    parseAndEnrich: (rawText) => ipcRenderer.invoke('loot:parseAndEnrich', rawText),
    fetchPrices: (params) => ipcRenderer.invoke('loot:fetchPrices', params),
    getCharacterSkills: (characterId) => ipcRenderer.invoke('loot:getCharacterSkills', characterId),
  },

  // Cleanup Tool API
  // What Can I Build? — asset plumbing kept under its original `cleanupTool`
  // name so the existing handlers are untouched; the calculation lives under
  // `wcib` below. There is no openWindow: it is a native shell view now.
  cleanupTool: {
    getAssetSources: () => ipcRenderer.invoke('cleanupTool:getAssetSources'),
    refreshAssets: (characterIds) => ipcRenderer.invoke('cleanupTool:refreshAssets', characterIds),
    aggregateAssets: (sources) => ipcRenderer.invoke('cleanupTool:aggregateAssets', sources),
  },

  // What Can I Build? calculation. Mirrors `summary` above: one call in, rows
  // out, progress on its own channel because a callback cannot cross IPC.
  wcib: {
    calculate: (options) => ipcRenderer.invoke('wcib:calculate', options),
    // Asks the in-flight run for THIS frame to stop at the next batch
    // boundary. calculate() then resolves with { cancelled: true }.
    cancel: () => ipcRenderer.invoke('wcib:cancel'),
    onProgress: (callback) => subscribe('wcib:progress', callback),
  },

  // App API (updates, version, etc.)
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getElectronVersion: () => ipcRenderer.invoke('app:getElectronVersion'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    onUpdateAvailable: (callback) => subscribe('update-available', callback),
    onUpdateNotAvailable: (callback) => subscribe('update-not-available', callback),
    onUpdateDownloadProgress: (callback) => subscribe('update-download-progress', callback),
    onUpdateDownloaded: (callback) => subscribe('update-downloaded', callback),
    onUpdateError: (callback) => subscribe('update-error', callback),
  },

  // Startup API (for splash screen)
  startup: {
    onProgress: (callback) => subscribe('startup:progress', callback),
    onRequireAction: (callback) => subscribe('startup:requireAction', callback),
    onWarning: (callback) => subscribe('startup:warning', callback),
    onError: (callback) => subscribe('startup:error', callback),
    onComplete: (callback) => subscribe('startup:complete', callback),
    // Fit the splash window to its card. The content changes shape as startup
    // progresses (the SDE row appears only when there is a download; the action
    // and error panels replace the task list), so this is called on every
    // change rather than once at load.
    fitToContent: (height) => ipcRenderer.invoke('startup:fitToContent', height),
    updateApp: () => ipcRenderer.send('startup:updateApp'),
    skipAppUpdate: () => ipcRenderer.send('startup:skipAppUpdate'),
    downloadSDE: () => ipcRenderer.send('startup:downloadSDE'),
    skipSDEUpdate: () => ipcRenderer.send('startup:skipSDEUpdate'),
    retry: () => ipcRenderer.send('startup:retry'),
  },

  // Wizard API (for first launch wizard)
  wizard: {
    skipSetup: () => ipcRenderer.invoke('wizard:skipSetup'),
    saveProgress: (step, data) => ipcRenderer.invoke('wizard:saveProgress', step, data),
    getProgress: () => ipcRenderer.invoke('wizard:getProgress'),
    complete: () => ipcRenderer.invoke('wizard:complete'),
  },

  // Server Status API
  status: {
    fetch: () => ipcRenderer.invoke('status:fetch'),
    // Read-only; does NOT trigger an ESI call. The background cycle fetches.
    getCached: () => ipcRenderer.invoke('status:getCached'),
    getLastFetchTime: () => ipcRenderer.invoke('status:getLastFetchTime'),
  },

  // ESI Status Monitoring API
  esiStatus: {
    openWindow: () => ipcRenderer.invoke('esiStatus:openWindow'),
    getAggregated: () => ipcRenderer.invoke('esiStatus:getAggregated'),
    // Error-budget state + the endpoints responsible, for diagnostics.
    getErrorBudget: () => ipcRenderer.invoke('esiStatus:getErrorBudget'),
    initializeCharacter: (characterId, characterName) => ipcRenderer.invoke('esiStatus:initializeCharacter', characterId, characterName),
    initializeUniverse: () => ipcRenderer.invoke('esiStatus:initializeUniverse'),
    getCharacterCalls: (characterId) => ipcRenderer.invoke('esiStatus:getCharacterCalls', characterId),
    getUniverseCalls: () => ipcRenderer.invoke('esiStatus:getUniverseCalls'),
    getCallDetails: (callKey) => ipcRenderer.invoke('esiStatus:getCallDetails', callKey),
    cleanup: () => ipcRenderer.invoke('esiStatus:cleanup'),
  },

  // Window Controls API (custom frameless title bar)
  //
  // NOTE: `onMaximizeChanged` returns an unsubscribe function. New `on*` methods
  // MUST follow this pattern - the persistent shell mounts and unmounts views
  // repeatedly, and listeners without a disposer accumulate into duplicate
  // handlers. (Historically this leak was masked because every navigation
  // destroyed the document.)
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    getPlatformChrome: () => ipcRenderer.invoke('window:getPlatformChrome'),

    /**
     * Open any registered shell view in its own window.
     *
     * The single, universal way a screen gets its own window - this is what the
     * pop-out feature uses, and it works for any view without a per-screen main
     * module or IPC channel. Windows are identified by (viewId, params), so
     * asking twice for the same pair focuses the existing window.
     *
     *   window.openView('assets', { characterId: 123 })
     */
    openView: (viewId, params, options) =>
      ipcRenderer.invoke('window:openView', viewId, params, options),
    isViewOpen: (viewId, params) => ipcRenderer.invoke('window:isViewOpen', viewId, params),
    focusView: (viewId, params) => ipcRenderer.invoke('window:focusView', viewId, params),
    closeView: (viewId, params) => ipcRenderer.invoke('window:closeView', viewId, params),

    /** Every open view window, as `{ key, viewId, params }`. */
    listViewWindows: () => ipcRenderer.invoke('window:listViewWindows'),

    /**
     * Park a payload for a window that is about to open, and get a token to
     * pass in its mount params.
     *
     * Used by pop-out so an expensive result set (a Manufacturing Summary
     * sweep, a What Can I Build? run) moves to the new window instead of being
     * recomputed there. The payload does NOT travel in params - that would put
     * it in the window key and break saved bounds.
     */
    createHandoff: (viewId, payload) => ipcRenderer.invoke('handoff:create', viewId, payload),

    /** Claim a parked payload. One shot: the slot is consumed on read. */
    claimHandoff: (token, viewId) => ipcRenderer.invoke('handoff:claim', token, viewId),

    /**
     * A view window opened or closed, in ANY window. Payload is
     * `{ open: [{ key, viewId, params }] }` - the full current set, not a
     * delta, so a late subscriber cannot miss an event and desync.
     */
    onViewWindowsChanged: (callback) => subscribe('window:viewWindowsChanged', callback),

    // Main process asking the shell to mount a view (e.g. Settings, requested
    // from a framed tool or another window).
    onShowView: (callback) => subscribe('shell:showView', callback),
    onMaximizeChanged: (callback) => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on('window:maximize-changed', handler);
      return () => ipcRenderer.removeListener('window:maximize-changed', handler);
    },
  },

  // Data-change events (see src/main/data-events.js).
  //
  // Screens subscribe to these instead of polling, so a staleness warning or a
  // table can update itself the moment fresh data lands. Every method returns an
  // unsubscribe function - the shell mounts views repeatedly, so an untracked
  // listener would accumulate.
  data: {
    onChanged: (callback) => subscribe('esi:data-changed', callback),
    onCycleComplete: (callback) => subscribe('esi:cycle-complete', callback),
    onMarketChanged: (callback) => subscribe('market:data-changed', callback),
    // A settings category was written, in ANY window. Payload is
    // { category, keys, updates, at } - check `category`/`keys` before acting,
    // since this fires for every settings write in the app.
    onSettingsChanged: (callback) => subscribe('settings:changed', callback),
    // ESI's error budget is running low / is spent. Payload names the
    // offending endpoints so the user can report them.
    onBudgetLow: (callback) => subscribe('esi:budget-low', callback),
    onBudgetBlocked: (callback) => subscribe('esi:budget-blocked', callback),
  },

  // Shell API (for opening external links)
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // Error Log API (for accessing log files and diagnostics)
  errorLog: {
    getPath: () => ipcRenderer.invoke('errorLog:getPath'),
    getDirectory: () => ipcRenderer.invoke('errorLog:getDirectory'),
    openFolder: () => ipcRenderer.invoke('errorLog:openFolder'),
    getDiagnostics: () => ipcRenderer.invoke('errorLog:getDiagnostics'),
  },

  // Auth Error Modal API (used only by auth-error-modal.html)
  authErrorModal: {
    getErrorInfo: () => ipcRenderer.invoke('authErrorModal:getErrorInfo'),
    dismiss: () => ipcRenderer.invoke('authErrorModal:dismiss'),
    reauthenticate: () => ipcRenderer.invoke('authErrorModal:reauthenticate'),
    resize: (height) => ipcRenderer.invoke('authErrorModal:resize', height),
  },
});
