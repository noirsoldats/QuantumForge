const { contextBridge, ipcRenderer } = require('electron');

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

  // ESI API
  esi: {
    authenticate: () => ipcRenderer.invoke('esi:authenticate'),
    getCharacters: () => ipcRenderer.invoke('esi:getCharacters'),
    removeCharacter: (characterId) => ipcRenderer.invoke('esi:removeCharacter', characterId),
    refreshToken: (characterId) => ipcRenderer.invoke('esi:refreshToken', characterId),
    getCharacter: (characterId) => ipcRenderer.invoke('esi:getCharacter', characterId),
    setDefaultCharacter: (characterId) => ipcRenderer.invoke('esi:setDefaultCharacter', characterId),
    getDefaultCharacter: () => ipcRenderer.invoke('esi:getDefaultCharacter'),
    clearDefaultCharacter: () => ipcRenderer.invoke('esi:clearDefaultCharacter'),
    onDefaultCharacterChanged: (callback) => ipcRenderer.on('default-character-changed', callback),
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
    onProgress: (callback) => ipcRenderer.on('sde:progress', (event, progress) => callback(progress)),
    removeProgressListener: () => ipcRenderer.removeAllListeners('sde:progress'),
    onUpdateAvailable: (callback) => ipcRenderer.on('sde:update-available', (event, updateInfo) => callback(updateInfo)),
    removeUpdateListener: () => ipcRenderer.removeAllListeners('sde:update-available'),
    // Skill lookups
    getSkillName: (skillId) => ipcRenderer.invoke('sde:getSkillName', skillId),
    getSkillNames: (skillIds) => ipcRenderer.invoke('sde:getSkillNames', skillIds),
    getAllSkills: () => ipcRenderer.invoke('sde:getAllSkills'),
    getSkillGroup: (skillId) => ipcRenderer.invoke('sde:getSkillGroup', skillId),
    searchSkills: (searchTerm) => ipcRenderer.invoke('sde:searchSkills', searchTerm),
    // Blueprint lookups
    getBlueprintName: (typeId) => ipcRenderer.invoke('sde:getBlueprintName', typeId),
    getBlueprintNames: (typeIds) => ipcRenderer.invoke('sde:getBlueprintNames', typeIds),
    getAllBlueprints: () => ipcRenderer.invoke('sde:getAllBlueprints'),
    searchBlueprints: (searchTerm) => ipcRenderer.invoke('sde:searchBlueprints', searchTerm),
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
  },

  // Skills API
  skills: {
    fetch: (characterId) => ipcRenderer.invoke('skills:fetch', characterId),
    setOverride: (characterId, skillId, level) => ipcRenderer.invoke('skills:setOverride', characterId, skillId, level),
    getEffectiveLevel: (characterId, skillId) => ipcRenderer.invoke('skills:getEffectiveLevel', characterId, skillId),
    clearOverrides: (characterId) => ipcRenderer.invoke('skills:clearOverrides', characterId),
    getCacheStatus: (characterId) => ipcRenderer.invoke('skills:getCacheStatus', characterId),
    openWindow: (characterId) => ipcRenderer.invoke('skills:openWindow', characterId),
    onCharacterId: (callback) => ipcRenderer.on('skills:set-character-id', (event, id) => callback(id)),
  },

  // Blueprints API
  blueprints: {
    fetch: (characterId) => ipcRenderer.invoke('blueprints:fetch', characterId),
    getAll: (characterId) => ipcRenderer.invoke('blueprints:getAll', characterId),
    addManual: (blueprintData) => ipcRenderer.invoke('blueprints:addManual', blueprintData),
    remove: (itemId) => ipcRenderer.invoke('blueprints:remove', itemId),
    setOverride: (itemId, field, value) => ipcRenderer.invoke('blueprints:setOverride', itemId, field, value),
    getEffectiveValues: (itemId) => ipcRenderer.invoke('blueprints:getEffectiveValues', itemId),
    getCacheStatus: (characterId) => ipcRenderer.invoke('blueprints:getCacheStatus', characterId),
    openWindow: (characterId) => ipcRenderer.invoke('blueprints:openWindow', characterId),
    openInCalculator: (blueprintTypeId, meLevel) => ipcRenderer.invoke('blueprints:openInCalculator', blueprintTypeId, meLevel),
    onCharacterId: (callback) => ipcRenderer.on('blueprints:set-character-id', (event, id) => callback(id)),
    onOpenInCalculator: (callback) => ipcRenderer.on('calculator:openBlueprint', (event, data) => callback(data)),
  },

  // Market API
  market: {
    getSettings: () => ipcRenderer.invoke('market:getSettings'),
    updateSettings: (updates) => ipcRenderer.invoke('market:updateSettings', updates),
    fetchOrders: (regionId, typeId, locationFilter) => ipcRenderer.invoke('market:fetchOrders', regionId, typeId, locationFilter),
    fetchHistory: (regionId, typeId) => ipcRenderer.invoke('market:fetchHistory', regionId, typeId),
    fetchData: (regionId, typeId) => ipcRenderer.invoke('market:fetchData', regionId, typeId),
    fetchFuzzwork: (typeId, regionId) => ipcRenderer.invoke('market:fetchFuzzwork', typeId, regionId),
    fetchJitaPrice: (typeId) => ipcRenderer.invoke('market:fetchJitaPrice', typeId),
    fetchBulkPrices: (typeIds, regionId) => ipcRenderer.invoke('market:fetchBulkPrices', typeIds, regionId),
    calculatePrice: (typeId, regionId, locationId, priceType, quantity) =>
      ipcRenderer.invoke('market:calculatePrice', typeId, regionId, locationId, priceType, quantity),
    getPriceOverride: (typeId) => ipcRenderer.invoke('market:getPriceOverride', typeId),
    setPriceOverride: (typeId, price, notes) => ipcRenderer.invoke('market:setPriceOverride', typeId, price, notes),
    removePriceOverride: (typeId) => ipcRenderer.invoke('market:removePriceOverride', typeId),
    getAllPriceOverrides: () => ipcRenderer.invoke('market:getAllPriceOverrides'),
    getLastFetchTime: () => ipcRenderer.invoke('market:getLastFetchTime'),
    manualRefresh: (regionId) => ipcRenderer.invoke('market:manualRefresh', regionId),
    getLastHistoryFetchTime: () => ipcRenderer.invoke('market:getLastHistoryFetchTime'),
    getHistoryDataStatus: (regionId) => ipcRenderer.invoke('market:getHistoryDataStatus', regionId),
    manualRefreshHistory: (regionId) => ipcRenderer.invoke('market:manualRefreshHistory', regionId),
    refreshAdjustedPrices: () => ipcRenderer.invoke('market:refreshAdjustedPrices'),
    onFetchProgress: (callback) => ipcRenderer.on('market:fetchProgress', (event, progress) => callback(progress)),
    removeFetchProgressListener: () => ipcRenderer.removeAllListeners('market:fetchProgress'),
    onHistoryProgress: (callback) => ipcRenderer.on('market:historyProgress', (event, progress) => callback(progress)),
    removeHistoryProgressListener: () => ipcRenderer.removeAllListeners('market:historyProgress'),
    onCheckUnsavedChanges: (callback) => ipcRenderer.on('market:checkUnsavedChanges', callback),
    sendUnsavedChangesResponse: (hasChanges) => ipcRenderer.send('market:unsavedChangesResponse', hasChanges),
  },

  // Blueprint Calculator API
  calculator: {
    searchBlueprints: (searchTerm, limit) => ipcRenderer.invoke('calculator:searchBlueprints', searchTerm, limit),
    calculateMaterials: (blueprintTypeId, runs, meLevel, characterId, facilityId) =>
      ipcRenderer.invoke('calculator:calculateMaterials', blueprintTypeId, runs, meLevel, characterId, facilityId),
    getBlueprintProduct: (blueprintTypeId) => ipcRenderer.invoke('calculator:getBlueprintProduct', blueprintTypeId),
    getTypeName: (typeId) => ipcRenderer.invoke('calculator:getTypeName', typeId),
    getOwnedBlueprintME: (characterId, blueprintTypeId) => ipcRenderer.invoke('calculator:getOwnedBlueprintME', characterId, blueprintTypeId),
    getRigBonuses: (rigTypeId) => ipcRenderer.invoke('calculator:getRigBonuses', rigTypeId),
    getAllBlueprints: (limit) => ipcRenderer.invoke('calculator:getAllBlueprints', limit),
    // Invention API
    getInventionData: (blueprintTypeId) => ipcRenderer.invoke('calculator:getInventionData', blueprintTypeId),
    getAllDecryptors: () => ipcRenderer.invoke('calculator:getAllDecryptors'),
    getBlueprintMaterials: (blueprintTypeId) => ipcRenderer.invoke('calculator:getBlueprintMaterials', blueprintTypeId),
    calculateInventionProbability: (baseProbability, skills, decryptorMultiplier) =>
      ipcRenderer.invoke('calculator:calculateInventionProbability', baseProbability, skills, decryptorMultiplier),
    findBestDecryptor: (inventionData, materialPrices, productPrice, skills, facility, optimizationStrategy, customVolume) =>
      ipcRenderer.invoke('calculator:findBestDecryptor', inventionData, materialPrices, productPrice, skills, facility, optimizationStrategy, customVolume),
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
    getStructureRigs: () => ipcRenderer.invoke('facilities:getStructureRigs'),
    getStructureBonuses: (typeId) => ipcRenderer.invoke('facilities:getStructureBonuses', typeId),
    getRigEffects: (typeId) => ipcRenderer.invoke('facilities:getRigEffects', typeId),
  },

  // Manufacturing Summary API
  manufacturingSummary: {
    openWindow: () => ipcRenderer.invoke('manufacturingSummary:openWindow'),
  },

  // App API (updates, version, etc.)
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, info) => callback(info)),
    onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', () => callback()),
    onUpdateDownloadProgress: (callback) => ipcRenderer.on('update-download-progress', (event, progress) => callback(progress)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, info) => callback(info)),
    onUpdateError: (callback) => ipcRenderer.on('update-error', (event, error) => callback(error)),
  },

  // Startup API (for splash screen)
  startup: {
    onProgress: (callback) => ipcRenderer.on('startup:progress', (event, progress) => callback(progress)),
    onRequireAction: (callback) => ipcRenderer.on('startup:requireAction', (event, action) => callback(action)),
    onError: (callback) => ipcRenderer.on('startup:error', (event, error) => callback(error)),
    onComplete: (callback) => ipcRenderer.on('startup:complete', () => callback()),
    updateApp: () => ipcRenderer.send('startup:updateApp'),
    skipAppUpdate: () => ipcRenderer.send('startup:skipAppUpdate'),
    downloadSDE: () => ipcRenderer.send('startup:downloadSDE'),
    skipSDEUpdate: () => ipcRenderer.send('startup:skipSDEUpdate'),
    retry: () => ipcRenderer.send('startup:retry'),
  },
});
