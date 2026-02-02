// Cleanup Tool Renderer
// Provides UI logic for the On-Hand Asset Cleanup Tool

let allBlueprints = [];
let calculatedData = [];
let currentFilter = loadSetting('cleanup-tool-blueprint-filter', 'owned');
let currentCharacterFilter = loadSetting('cleanup-tool-character-filter', 'default');
let selectedCharacterId = loadSetting('cleanup-tool-selected-character', null, true);
let currentSort = loadSetting('cleanup-tool-sort', { column: 'profit', direction: 'desc' }, true);
let selectedBlueprints = new Set();
let calculationAbortController = null;
let aggregatedAssets = {};
let assetSources = [];
let allCharacters = [];

// Generic setting load/save helpers
function loadSetting(key, defaultValue, isJson = false) {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      return isJson ? JSON.parse(saved) : saved;
    }
  } catch (error) {
    console.error(`Error loading setting ${key}:`, error);
  }
  return defaultValue;
}

function saveSetting(key, value, isJson = false) {
  try {
    localStorage.setItem(key, isJson ? JSON.stringify(value) : value);
  } catch (error) {
    console.error(`Error saving setting ${key}:`, error);
  }
}

// Filter configuration
let blueprintFilters = loadFilterConfig();

function loadFilterConfig() {
  try {
    const saved = localStorage.getItem('cleanup-tool-filters');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (error) {
    console.error('Error loading filter config:', error);
  }
  return {
    tech: ['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'],
    category: ['Ships', 'Drones', 'Modules', 'Ammo/Charges', 'Components', 'Rigs', 'Deployables', 'Subsystems', 'Structures', 'Structure Rigs', 'Structure Modules', 'Boosters', 'Celestials']
  };
}

function saveFilterConfig() {
  try {
    localStorage.setItem('cleanup-tool-filters', JSON.stringify(blueprintFilters));
  } catch (error) {
    console.error('Error saving filter config:', error);
  }
}

// Column configuration
const ALL_COLUMNS = [
  { id: 'select', label: '<input type="checkbox" id="select-all-checkbox" title="Select All">', default: true, sortable: false, align: 'center' },
  { id: 'percent-on-hand', label: '% On-Hand', default: true, sortable: true, align: 'center' },
  { id: 'buildable-qty', label: 'Buildable Qty', default: true, sortable: true, align: 'right' },
  { id: 'category', label: 'Category', default: true, sortable: true, align: 'left' },
  { id: 'name', label: 'Item Name', default: true, sortable: true, align: 'left' },
  { id: 'owned', label: 'Owned?', default: true, sortable: true, align: 'center' },
  { id: 'tech', label: 'Tech', default: true, sortable: true, align: 'center' },
  { id: 'bp-type', label: 'BP Type', default: true, sortable: true, align: 'center' },
  { id: 'me', label: 'ME', default: true, sortable: true, align: 'center' },
  { id: 'te', label: 'TE', default: true, sortable: true, align: 'center' },
  { id: 'profit', label: 'Profit', default: true, sortable: true, align: 'right' },
  { id: 'isk-per-hour', label: 'ISK/Hour', default: true, sortable: true, align: 'right' },
  { id: 'svr', label: 'SVR', default: true, sortable: true, align: 'right' },
  { id: 'total-cost', label: 'Total Cost', default: true, sortable: true, align: 'right' },
  { id: 'roi', label: 'ROI %', default: true, sortable: true, align: 'right' },
  { id: 'owner', label: 'Owner', default: false, sortable: true, align: 'left' },
  { id: 'location', label: 'Location', default: false, sortable: true, align: 'left' },
  { id: 'product-market-price', label: 'Product Market Price', default: false, sortable: true, align: 'right' },
];

let visibleColumns = loadColumnConfig();

function loadColumnConfig() {
  try {
    const saved = localStorage.getItem('cleanup-tool-columns');
    if (saved) {
      const parsed = JSON.parse(saved);
      const validColumns = parsed.filter(id => ALL_COLUMNS.find(col => col.id === id));
      if (validColumns.length > 0) {
        return validColumns;
      }
    }
  } catch (error) {
    console.error('Error loading column config:', error);
  }
  return ALL_COLUMNS.filter(col => col.default).map(col => col.id);
}

function saveColumnConfig() {
  try {
    localStorage.setItem('cleanup-tool-columns', JSON.stringify(visibleColumns));
  } catch (error) {
    console.error('Error saving column config:', error);
  }
}

// Initialize the page
document.addEventListener('DOMContentLoaded', async () => {
  await loadFacilities();
  await loadCharacters();
  await loadAssetSources();
  setupEventListeners();
  renderTableHeaders();
  syncFiltersWithUI();
});

// Load characters into dropdown
async function loadCharacters() {
  try {
    const characters = await window.electronAPI.esi.getCharacters();
    allCharacters = characters || [];
    const characterSelect = document.getElementById('character-select');

    if (characters && characters.length > 0) {
      characterSelect.innerHTML = '<option value="">Select Character...</option>';

      characters.forEach(character => {
        const option = document.createElement('option');
        option.value = character.characterId;
        option.textContent = character.characterName;
        characterSelect.appendChild(option);
      });
    }
  } catch (error) {
    console.error('Error loading characters:', error);
  }
}

function getCharacterName(characterId) {
  if (!characterId) return null;
  const character = allCharacters.find(c => c.characterId === characterId);
  return character ? character.characterName : 'Unknown Character';
}

// Load asset sources
async function loadAssetSources() {
  try {
    assetSources = await window.electronAPI.cleanupTool.getAssetSources();
    renderAssetSources();
    // Restore saved asset source selections after rendering
    syncAssetSourcesWithUI();
  } catch (error) {
    console.error('Error loading asset sources:', error);
    showToast('Failed to load asset sources', 'error');
  }
}

// Render asset sources checkboxes
function renderAssetSources() {
  const container = document.getElementById('asset-sources-list');

  if (!assetSources || assetSources.length === 0) {
    container.innerHTML = '<div class="loading-placeholder">No characters found. Add characters in Settings.</div>';
    return;
  }

  container.innerHTML = assetSources.map(source => `
    <div class="character-source" data-character-id="${source.characterId}">
      <div class="character-source-header">
        <img src="${source.portrait}?size=64" alt="${source.characterName}" class="character-avatar">
        <span class="character-source-name">${source.characterName}</span>
      </div>
      <div class="asset-type-checkboxes">
        <label class="asset-type-checkbox">
          <input type="checkbox"
                 data-type="personal"
                 data-character-id="${source.characterId}"
                 checked>
          <span>Personal Assets</span>
        </label>
        ${source.hasCorpAssets ? `
          <label class="asset-type-checkbox">
            <input type="checkbox"
                   data-type="corporation"
                   data-character-id="${source.characterId}"
                   checked>
            <span>Corporation Assets (${source.corporationName})</span>
          </label>
          <div class="division-checkboxes" data-character-id="${source.characterId}">
            ${source.divisions.map(div => `
              <label class="division-checkbox">
                <input type="checkbox"
                       data-type="division"
                       data-character-id="${source.characterId}"
                       data-division-id="${div.id}"
                       ${div.enabled ? 'checked' : ''}>
                <span>${div.name}</span>
              </label>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');

  // Add change listeners to save selections when checkboxes are toggled
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      // Save the updated selections
      getSelectedAssetSources();
    });
  });
}

// Get selected asset sources from UI
function getSelectedAssetSources() {
  const sources = {
    personal: [],
    corporation: [],
  };

  const container = document.getElementById('asset-sources-list');
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');

  const corpSelections = {}; // { characterId: { selected: bool, divisions: [] } }

  checkboxes.forEach(checkbox => {
    const characterId = parseInt(checkbox.dataset.characterId, 10);
    const type = checkbox.dataset.type;

    if (type === 'personal' && checkbox.checked) {
      sources.personal.push({ characterId });
    } else if (type === 'corporation') {
      if (!corpSelections[characterId]) {
        corpSelections[characterId] = { selected: false, divisions: [] };
      }
      corpSelections[characterId].selected = checkbox.checked;
    } else if (type === 'division' && checkbox.checked) {
      if (!corpSelections[characterId]) {
        corpSelections[characterId] = { selected: false, divisions: [] };
      }
      corpSelections[characterId].divisions.push(parseInt(checkbox.dataset.divisionId, 10));
    }
  });

  // Build corporation sources
  for (const [characterId, data] of Object.entries(corpSelections)) {
    if (data.selected) {
      sources.corporation.push({
        characterId: parseInt(characterId, 10),
        divisions: data.divisions,
      });
    }
  }

  // Save the selections for next time
  saveSetting('cleanup-tool-asset-sources', sources, true);

  return sources;
}

// Load facilities into dropdown
async function loadFacilities() {
  try {
    const facilities = await window.electronAPI.facilities.getFacilities();
    const facilitySelect = document.getElementById('facility-select');

    if (facilities && facilities.length > 0) {
      facilities.forEach(facility => {
        const option = document.createElement('option');
        option.value = facility.id;
        option.textContent = facility.name;
        if (facility.usage === 'default') {
          option.selected = true;
        }
        facilitySelect.appendChild(option);
      });
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No facilities configured';
      facilitySelect.appendChild(option);
    }
  } catch (error) {
    console.error('Error loading facilities:', error);
  }
}

// Sync saved filter config with main UI checkboxes
function syncFiltersWithUI() {
  // Sync tech filters
  document.querySelectorAll('#tech-filter input[type="checkbox"]').forEach(checkbox => {
    checkbox.checked = blueprintFilters.tech.includes(checkbox.value);
  });

  // Sync category filters
  document.querySelectorAll('#category-filter input[type="checkbox"]').forEach(checkbox => {
    checkbox.checked = blueprintFilters.category.includes(checkbox.value);
  });

  // Sync threshold
  const savedThreshold = localStorage.getItem('cleanup-tool-threshold');
  if (savedThreshold) {
    document.getElementById('threshold-slider').value = savedThreshold;
    document.getElementById('threshold-input').value = savedThreshold;
  }

  // Sync blueprint filter radio buttons
  const blueprintFilterRadio = document.querySelector(`input[name="blueprint-filter"][value="${currentFilter}"]`);
  if (blueprintFilterRadio) {
    blueprintFilterRadio.checked = true;
  }

  // Sync character filter radio buttons
  const characterFilterRadio = document.querySelector(`input[name="character-filter"][value="${currentCharacterFilter}"]`);
  if (characterFilterRadio) {
    characterFilterRadio.checked = true;
  }

  // Sync character select dropdown
  const characterSelect = document.getElementById('character-select');
  if (characterSelect && selectedCharacterId) {
    characterSelect.value = selectedCharacterId;
  }
  // Enable/disable based on character filter
  characterSelect.disabled = currentCharacterFilter !== 'specific';

  // Sync facility select
  const savedFacility = loadSetting('cleanup-tool-facility', null);
  if (savedFacility) {
    const facilitySelect = document.getElementById('facility-select');
    if (facilitySelect) {
      // Check if the saved facility exists in the options
      const optionExists = Array.from(facilitySelect.options).some(opt => opt.value === savedFacility);
      if (optionExists) {
        facilitySelect.value = savedFacility;
      }
    }
  }

  // Sync T2 invention checkbox
  const savedIncludeT2 = loadSetting('cleanup-tool-include-t2-invention', 'false');
  const includeT2Checkbox = document.getElementById('include-t2-invention');
  if (includeT2Checkbox) {
    includeT2Checkbox.checked = savedIncludeT2 === 'true';
  }
}

// Sync saved asset source selections with UI after sources are loaded
function syncAssetSourcesWithUI() {
  const savedSources = loadSetting('cleanup-tool-asset-sources', null, true);
  if (!savedSources) return;

  const container = document.getElementById('asset-sources-list');
  if (!container) return;

  // Restore personal asset selections
  if (savedSources.personal) {
    savedSources.personal.forEach(source => {
      const checkbox = container.querySelector(
        `input[data-type="personal"][data-character-id="${source.characterId}"]`
      );
      if (checkbox) {
        checkbox.checked = true;
      }
    });
  }

  // Restore corporation asset selections
  if (savedSources.corporation) {
    savedSources.corporation.forEach(source => {
      const corpCheckbox = container.querySelector(
        `input[data-type="corporation"][data-character-id="${source.characterId}"]`
      );
      if (corpCheckbox) {
        corpCheckbox.checked = true;
      }

      // Restore division selections
      if (source.divisions) {
        source.divisions.forEach(divId => {
          const divCheckbox = container.querySelector(
            `input[data-type="division"][data-character-id="${source.characterId}"][data-division-id="${divId}"]`
          );
          if (divCheckbox) {
            divCheckbox.checked = true;
          }
        });
      }
    });
  }

  // Uncheck any that weren't in saved sources
  const allPersonalCheckboxes = container.querySelectorAll('input[data-type="personal"]');
  allPersonalCheckboxes.forEach(cb => {
    const charId = parseInt(cb.dataset.characterId, 10);
    const isInSaved = savedSources.personal?.some(s => s.characterId === charId);
    if (!isInSaved) {
      cb.checked = false;
    }
  });

  const allCorpCheckboxes = container.querySelectorAll('input[data-type="corporation"]');
  allCorpCheckboxes.forEach(cb => {
    const charId = parseInt(cb.dataset.characterId, 10);
    const isInSaved = savedSources.corporation?.some(s => s.characterId === charId);
    if (!isInSaved) {
      cb.checked = false;
    }
  });

  const allDivCheckboxes = container.querySelectorAll('input[data-type="division"]');
  allDivCheckboxes.forEach(cb => {
    const charId = parseInt(cb.dataset.characterId, 10);
    const divId = parseInt(cb.dataset.divisionId, 10);
    const corpSource = savedSources.corporation?.find(s => s.characterId === charId);
    const isInSaved = corpSource?.divisions?.includes(divId);
    if (!isInSaved) {
      cb.checked = false;
    }
  });
}

// Get current filters from UI
function getCurrentFilters() {
  const tech = [];
  document.querySelectorAll('#tech-filter input[type="checkbox"]:checked').forEach(cb => {
    tech.push(cb.value);
  });

  const category = [];
  document.querySelectorAll('#category-filter input[type="checkbox"]:checked').forEach(cb => {
    category.push(cb.value);
  });

  blueprintFilters = { tech, category };
  saveFilterConfig();

  return blueprintFilters;
}

// Setup event listeners
function setupEventListeners() {
  // Close button
  document.getElementById('back-btn').addEventListener('click', () => {
    window.close();
  });

  // Calculate button
  document.getElementById('calculate-btn').addEventListener('click', calculateBuildable);

  // Cancel button
  document.getElementById('cancel-calculation-btn').addEventListener('click', () => {
    if (calculationAbortController) {
      calculationAbortController.abort();
    }
  });

  // Asset source buttons
  document.getElementById('select-all-assets-btn').addEventListener('click', () => {
    document.querySelectorAll('#asset-sources-list input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
    });
    // Save the updated selections
    getSelectedAssetSources();
  });

  document.getElementById('deselect-all-assets-btn').addEventListener('click', () => {
    document.querySelectorAll('#asset-sources-list input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
    // Save the updated selections
    getSelectedAssetSources();
  });

  document.getElementById('refresh-assets-btn').addEventListener('click', refreshAssets);

  // Threshold slider sync
  const thresholdSlider = document.getElementById('threshold-slider');
  const thresholdInput = document.getElementById('threshold-input');

  thresholdSlider.addEventListener('input', (e) => {
    thresholdInput.value = e.target.value;
    localStorage.setItem('cleanup-tool-threshold', e.target.value);
  });

  thresholdInput.addEventListener('change', (e) => {
    const value = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
    thresholdSlider.value = value;
    thresholdInput.value = value;
    localStorage.setItem('cleanup-tool-threshold', value);
  });

  // Blueprint filter radio buttons
  document.querySelectorAll('input[name="blueprint-filter"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentFilter = e.target.value;
      saveSetting('cleanup-tool-blueprint-filter', currentFilter);
    });
  });

  // Character filter radio buttons
  document.querySelectorAll('input[name="character-filter"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentCharacterFilter = e.target.value;
      saveSetting('cleanup-tool-character-filter', currentCharacterFilter);
      document.getElementById('character-select').disabled = e.target.value !== 'specific';
    });
  });

  // Character select
  document.getElementById('character-select').addEventListener('change', (e) => {
    selectedCharacterId = e.target.value ? parseInt(e.target.value, 10) : null;
    saveSetting('cleanup-tool-selected-character', selectedCharacterId, true);
  });

  // Facility select - save when changed
  document.getElementById('facility-select').addEventListener('change', (e) => {
    saveSetting('cleanup-tool-facility', e.target.value);
  });

  // T2 invention checkbox - save when changed
  document.getElementById('include-t2-invention')?.addEventListener('change', (e) => {
    saveSetting('cleanup-tool-include-t2-invention', e.target.checked ? 'true' : 'false');
  });

  // Search box
  document.getElementById('search-box')?.addEventListener('input', debounce(() => {
    displayResults();
  }, 300));

  // Column configuration
  document.getElementById('configure-columns-btn')?.addEventListener('click', showColumnConfigModal);
  document.getElementById('close-column-modal-btn')?.addEventListener('click', hideColumnConfigModal);
  document.getElementById('reset-columns-btn')?.addEventListener('click', resetColumnConfig);
  document.getElementById('apply-columns-btn')?.addEventListener('click', applyColumnConfig);

  // Plan selection modal
  document.getElementById('close-plan-selection-modal-btn')?.addEventListener('click', hidePlanSelectionModal);
  document.getElementById('cancel-plan-selection-btn')?.addEventListener('click', hidePlanSelectionModal);
  document.getElementById('confirm-plan-selection-btn')?.addEventListener('click', confirmAddToPlan);

  // Add to plan button
  document.getElementById('add-selected-to-plan-btn')?.addEventListener('click', handleBulkAddToPlan);
}

// Refresh assets from ESI
async function refreshAssets() {
  const btn = document.getElementById('refresh-assets-btn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-small"></span> Refreshing...';

  try {
    const characterIds = assetSources.map(s => s.characterId);
    const result = await window.electronAPI.cleanupTool.refreshAssets(characterIds);

    if (result.success) {
      showToast(`Refreshed assets for ${result.refreshed.length} source(s)`, 'success');
    } else {
      showToast(`Refresh completed with ${result.errors.length} error(s)`, 'warning');
    }
  } catch (error) {
    console.error('Error refreshing assets:', error);
    showToast('Failed to refresh assets', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// Determine tech level from blueprint data
function determineTechLevel(blueprint) {
  const metaGroupId = blueprint.metaGroupId || blueprint.metaGroupID;

  switch (metaGroupId) {
    case 1: return 'T1';
    case 2: return 'T2';
    case 14: return 'T3';
    case 3: return 'Storyline';
    case 4: return 'Navy';
    case 5: case 6: return 'Pirate';
    default: return 'T1';
  }
}

// Determine category from blueprint data (matches manufacturing-summary-renderer.js)
function determineCategory(blueprint) {
  const sdeCategory = blueprint.productCategoryName || '';
  const sdeGroup = blueprint.productGroupName || '';

  // Ships - all products in Ship category
  if (sdeCategory === 'Ship') {
    return 'Ships';
  }

  // Drones - all products in Drone category
  if (sdeCategory === 'Drone') {
    return 'Drones';
  }

  // Fighters - group with Drones
  if (sdeCategory === 'Fighter') {
    return 'Drones';
  }

  // Rigs - check for rig groups BEFORE checking Module category
  if (sdeGroup && sdeGroup.includes('Rig')) {
    // Structure rigs - check both category and group name
    if (sdeCategory === 'Structure' || (sdeGroup && sdeGroup.includes('Structure'))) {
      return 'Structure Rigs';
    }
    // Regular rigs (may be in Module category)
    return 'Rigs';
  }

  // Modules - all products in Module category (after rig check)
  if (sdeCategory === 'Module') {
    return 'Modules';
  }

  // Ammo/Charges - all products in Charge category
  if (sdeCategory === 'Charge') {
    return 'Ammo/Charges';
  }

  // Subsystems - all products in Subsystem category
  if (sdeCategory === 'Subsystem') {
    return 'Subsystems';
  }

  // Deployables - all products in Deployable category
  if (sdeCategory === 'Deployable') {
    return 'Deployables';
  }

  // Structure Modules - all products in Structure Module category
  if (sdeCategory === 'Structure Module') {
    return 'Structure Modules';
  }

  // Structures - all products in Structure category
  if (sdeCategory === 'Structure') {
    return 'Structures';
  }

  // Boosters - products in Implant category with Booster groups
  if (sdeCategory === 'Implant' && sdeGroup && sdeGroup.includes('Booster')) {
    return 'Boosters';
  }

  // Reactions - all products in Reaction category
  if (sdeCategory === 'Reaction') {
    return 'Reactions';
  }

  // Celestials - all products in Celestial or Starbase categories
  if (sdeCategory === 'Celestial' || sdeCategory === 'Starbase' || sdeCategory === 'Station') {
    return 'Celestials';
  }

  // Components - check Material category or component-related groups
  if (sdeCategory === 'Material' || sdeCategory === 'Commodity') {
    return 'Components';
  }

  // Default to Components for anything else
  return 'Components';
}

// Get blueprints by filter
async function getBlueprintsByFilter() {
  try {
    // Get all blueprint details from SDE first
    const allSdeBlueprints = await window.electronAPI.calculator.getAllBlueprints(null);

    if (currentFilter === 'all') {
      // Return SDE blueprints with default values
      return allSdeBlueprints.map(bp => ({
        ...bp,
        blueprintTypeId: bp.typeID,
        typeId: bp.typeID,
        typeName: bp.typeName,
        itemName: bp.productName || bp.typeName,
        productTypeId: bp.productTypeID,
        categoryId: bp.productCategoryID,
        categoryName: bp.productCategoryName,
        groupId: bp.productGroupID,
        groupName: bp.productGroupName,
        metaGroupId: bp.productMetaGroupID,
        meLevel: 0,
        teLevel: 0,
        isBpc: false,
        isOwned: false,
        ownedBy: null,
        locationFlag: null,
      }));
    }

    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    let characterIds = [];

    if (currentCharacterFilter === 'all') {
      characterIds = allCharacters.map(c => c.characterId);
    } else if (currentCharacterFilter === 'default') {
      if (defaultCharacter) {
        characterIds = [defaultCharacter.characterId];
      }
    } else if (currentCharacterFilter === 'specific') {
      if (selectedCharacterId) {
        characterIds = [selectedCharacterId];
      }
    }

    if (characterIds.length === 0) {
      console.log('[Cleanup Tool] No characters selected');
      return [];
    }

    const allOwnedBlueprints = [];
    for (const charId of characterIds) {
      try {
        const charBlueprints = await window.electronAPI.blueprints.getAll(charId);
        console.log(`[Cleanup Tool] Character ${charId} has ${charBlueprints?.length || 0} blueprints`);
        allOwnedBlueprints.push(...(charBlueprints || []));
      } catch (error) {
        console.error(`Error fetching blueprints for character ${charId}:`, error);
      }
    }

    console.log(`[Cleanup Tool] Total owned blueprints: ${allOwnedBlueprints.length}`);

    // Filter based on owned/corp
    let filteredOwnedBlueprints;
    if (currentFilter === 'owned') {
      filteredOwnedBlueprints = allOwnedBlueprints.filter(bp => {
        const isCorp = bp.isCorporation || (
          bp.locationFlag && (
            bp.locationFlag.startsWith('CorpSAG') ||
            bp.locationFlag.startsWith('CorpDeliveries')
          )
        );
        return !isCorp;
      });
    } else if (currentFilter === 'corp') {
      filteredOwnedBlueprints = allOwnedBlueprints.filter(bp => {
        return bp.isCorporation || (
          bp.locationFlag && (
            bp.locationFlag.startsWith('CorpSAG') ||
            bp.locationFlag.startsWith('CorpDeliveries')
          )
        );
      });
    } else {
      filteredOwnedBlueprints = allOwnedBlueprints;
    }

    console.log(`[Cleanup Tool] Filtered to ${filteredOwnedBlueprints.length} ${currentFilter} blueprints`);

    // Match owned blueprints with SDE data
    // SDE uses typeID, owned uses typeId - both refer to the blueprint type ID
    const blueprints = allSdeBlueprints.filter(sdeBp =>
      filteredOwnedBlueprints.some(owned => owned.typeId === sdeBp.typeID)
    );

    console.log(`[Cleanup Tool] Matched ${blueprints.length} blueprints with SDE data`);

    // Create a map of owned blueprints for ME/TE lookup
    const ownedMap = new Map();
    for (const owned of filteredOwnedBlueprints) {
      // Keep the one with highest ME if duplicates exist
      const existing = ownedMap.get(owned.typeId);
      if (!existing || (owned.materialEfficiency || 0) > (existing.materialEfficiency || 0)) {
        ownedMap.set(owned.typeId, owned);
      }
    }

    // Merge SDE data with owned blueprint data
    return blueprints.map(sdeBp => {
      const owned = ownedMap.get(sdeBp.typeID);
      return {
        ...sdeBp,
        blueprintTypeId: sdeBp.typeID,
        typeId: sdeBp.typeID,
        typeName: sdeBp.typeName,
        itemName: sdeBp.productName || sdeBp.typeName,
        productTypeId: sdeBp.productTypeID,
        categoryId: sdeBp.productCategoryID,
        categoryName: sdeBp.productCategoryName,
        groupId: sdeBp.productGroupID,
        groupName: sdeBp.productGroupName,
        metaGroupId: sdeBp.productMetaGroupID,
        meLevel: owned?.materialEfficiency || 0,
        teLevel: owned?.timeEfficiency || 0,
        isBpc: owned?.quantity === -2 || owned?.isCopy,
        isOwned: true,
        ownedBy: owned?.characterId,
        locationFlag: owned?.locationFlag,
      };
    });
  } catch (error) {
    console.error('Error getting blueprints by filter:', error);
    return [];
  }
}

// Main calculation function
async function calculateBuildable() {
  const facilityId = document.getElementById('facility-select').value;
  if (!facilityId) {
    showToast('Please select a facility', 'warning');
    return;
  }

  const selectedSources = getSelectedAssetSources();
  if (selectedSources.personal.length === 0 && selectedSources.corporation.length === 0) {
    showToast('Please select at least one asset source', 'warning');
    return;
  }

  calculationAbortController = new AbortController();

  showLoading('Aggregating assets...');
  hideEmptyState();
  hideResults();
  document.getElementById('calculate-btn').style.display = 'none';
  document.getElementById('cancel-calculation-btn').style.display = 'inline-flex';

  try {
    // Aggregate assets from selected sources
    aggregatedAssets = await window.electronAPI.cleanupTool.aggregateAssets(selectedSources);
    const assetCount = Object.keys(aggregatedAssets).length;
    console.log(`[Cleanup Tool] Aggregated ${assetCount} unique asset types`);

    // Get filter settings
    const currentFilters = getCurrentFilters();
    const threshold = parseInt(document.getElementById('threshold-input').value) || 90;

    // Get blueprints
    showLoading('Loading blueprints...');
    const blueprints = await getBlueprintsByFilter();

    if (!blueprints || blueprints.length === 0) {
      showEmptyState();
      hideLoading();
      return;
    }

    // Filter blueprints
    const filteredBlueprints = blueprints.filter(blueprint => {
      const techLevel = determineTechLevel(blueprint);
      const category = determineCategory(blueprint);
      return currentFilters.tech.includes(techLevel) && currentFilters.category.includes(category);
    });

    console.log(`[Cleanup Tool] Processing ${filteredBlueprints.length} blueprints`);

    if (filteredBlueprints.length === 0) {
      showEmptyState();
      hideLoading();
      return;
    }

    allBlueprints = filteredBlueprints;
    calculatedData = [];

    const facility = await window.electronAPI.facilities.getFacility(facilityId);
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    const characterId = defaultCharacter?.characterId;

    // Get market settings for pricing
    const marketSettings = await window.electronAPI.market.getSettings();
    console.log(`[Cleanup Tool] Using market region: ${marketSettings?.regionId || 10000002}`);

    // Batch processing
    const BATCH_SIZE = 6;
    let processedCount = 0;
    const totalBlueprints = filteredBlueprints.length;

    for (let i = 0; i < totalBlueprints; i += BATCH_SIZE) {
      if (calculationAbortController.signal.aborted) {
        console.log('[Cleanup Tool] Calculation cancelled');
        showLoading('Calculation cancelled');
        await new Promise(resolve => setTimeout(resolve, 1000));
        hideLoading();
        document.getElementById('calculate-btn').style.display = 'inline-flex';
        document.getElementById('cancel-calculation-btn').style.display = 'none';
        return;
      }

      const batch = filteredBlueprints.slice(i, Math.min(i + BATCH_SIZE, totalBlueprints));
      showLoading(`Calculating... ${processedCount}/${totalBlueprints}`);

      const batchPromises = batch.map(blueprint =>
        calculateBlueprintData(blueprint, facility, characterId, threshold, marketSettings)
          .catch(error => {
            console.error(`Error calculating ${blueprint.typeName}:`, error);
            return null;
          })
      );

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          calculatedData.push(result.value);
          processedCount++;
        }
      });

      await new Promise(resolve => setTimeout(resolve, 0));
    }

    hideLoading();
    sortTable(currentSort.column, currentSort.direction);
    displayResults();

  } catch (error) {
    console.error('Error calculating buildable items:', error);
    showToast('Error: ' + error.message, 'error');
    hideLoading();
    showEmptyState();
  } finally {
    document.getElementById('calculate-btn').style.display = 'inline-flex';
    document.getElementById('cancel-calculation-btn').style.display = 'none';
    calculationAbortController = null;
  }
}

// Calculate data for a single blueprint
async function calculateBlueprintData(blueprint, facility, characterId, threshold, marketSettings) {
  try {
    const blueprintTypeId = blueprint.blueprintTypeId || blueprint.typeId;
    const meLevel = blueprint.meLevel || 0;
    const teLevel = blueprint.teLevel || 0;

    // Calculate materials for 1 run (same as Manufacturing Summary)
    // This returns a result with pricing object containing per-run values
    const materialResult = await window.electronAPI.calculator.calculateMaterials(
      blueprintTypeId,
      1, // Always 1 run for per-run calculations
      meLevel,
      characterId,
      facility?.id
    );

    if (!materialResult || !materialResult.materials) {
      return null;
    }

    // Calculate buildable runs and percent on-hand
    const buildableInfo = calculateBuildableFromAssets(materialResult.materials);

    // Filter by threshold
    if (buildableInfo.percentOnHand < threshold) {
      return null;
    }

    // Check if we have pricing data (same pattern as Manufacturing Summary)
    if (!materialResult.pricing) {
      console.warn(`[Cleanup Tool] No pricing data for ${blueprint.typeName || blueprint.itemName}`);
      return null;
    }

    const pricing = materialResult.pricing;

    // Get product info
    const product = materialResult.product || await window.electronAPI.calculator.getBlueprintProduct(blueprintTypeId);
    const productTypeId = product?.typeID || product?.productTypeId;

    // Calculate ISK/hour using production time (same as Manufacturing Summary)
    // Use result.time if available, otherwise calculate from blueprint baseTime
    const productionTimeSeconds = materialResult.time || blueprint.baseTime || 3600;
    const productionTimeHours = productionTimeSeconds / 3600;
    const iskPerHour = productionTimeHours > 0 ? pricing.profit / productionTimeHours : 0;

    // Calculate ROI (same as Manufacturing Summary)
    const roi = pricing.totalCosts > 0 ? (pricing.profit / pricing.totalCosts) * 100 : 0;

    // Calculate SVR (Sales Velocity Ratio) - use 30 day period like Manufacturing Summary default
    const svrPeriod = 30;
    const svr = await calculateSVR(productTypeId, svrPeriod, productionTimeHours);

    // Debug: Log items with high percent but 0 buildable
    if (buildableInfo.percentOnHand >= 90 && buildableInfo.buildableRuns === 0) {
      console.warn(`[Cleanup Tool] High % but 0 runs: ${blueprint.typeName || blueprint.itemName}`, {
        percentOnHand: buildableInfo.percentOnHand,
        buildableRuns: buildableInfo.buildableRuns,
        materialCount: Object.keys(materialResult.materials).length,
        materials: materialResult.materials,
        breakdown: buildableInfo.materialBreakdown
      });
    }

    // Extract output value for product market price (per unit)
    const outputValue = pricing.outputValue || {};
    const productMarketPrice = outputValue.totalValue || 0;

    return {
      blueprintTypeId,
      itemName: blueprint.typeName || blueprint.itemName,
      typeName: blueprint.typeName || blueprint.itemName,
      productTypeId: productTypeId,
      productQuantity: product?.quantity || 1,
      category: determineCategory(blueprint),
      tech: determineTechLevel(blueprint),
      meLevel: meLevel,
      teLevel: teLevel,
      isBpc: blueprint.isBpc || false,
      isOwned: blueprint.isOwned || currentFilter !== 'all',
      ownedBy: blueprint.ownedBy,
      locationFlag: blueprint.locationFlag,

      // Cleanup tool specific
      percentOnHand: buildableInfo.percentOnHand,
      buildableRuns: buildableInfo.buildableRuns,
      materialBreakdown: buildableInfo.materialBreakdown,

      // Profitability - all per-run values from pricing object (like Manufacturing Summary)
      totalCost: pricing.totalCosts,
      productPrice: productMarketPrice,
      productValue: productMarketPrice, // Same as productPrice for 1 run
      profit: pricing.profit,
      roi,
      iskPerHour,
      svr,
    };
  } catch (error) {
    console.error('Error in calculateBlueprintData:', error);
    return null;
  }
}

// Calculate SVR (Sales to Volume Ratio) - same as Manufacturing Summary
async function calculateSVR(productTypeId, period, productionTimeHours) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculateSVR] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    // Get market history for the product
    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);

    if (!allHistory || allHistory.length === 0) {
      return 0;
    }

    // Filter to only the specified period (most recent N days)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => {
      const dayDate = new Date(day.date);
      return dayDate >= cutoffDate;
    });

    if (recentHistory.length === 0) {
      return 0;
    }

    // Calculate total units sold in the period
    const totalSold = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);

    // Calculate how many units we could produce in the same period
    const periodHours = period * 24;
    const unitsProducible = productionTimeHours > 0 ? periodHours / productionTimeHours : 0;

    // SVR = units sold / units producible
    const svr = unitsProducible > 0 ? totalSold / unitsProducible : 0;

    return svr;
  } catch (error) {
    console.error('Error calculating SVR:', error);
    return 0;
  }
}

// Calculate buildable runs from aggregated assets
function calculateBuildableFromAssets(materials) {
  if (!materials || Object.keys(materials).length === 0) {
    return { buildableRuns: 0, percentOnHand: 0, materialBreakdown: [] };
  }

  let minRuns = Infinity;
  const materialBreakdown = [];

  for (const [typeId, quantityPerRun] of Object.entries(materials)) {
    const typeIdNum = parseInt(typeId, 10);
    const qty = Number(quantityPerRun);

    // Skip invalid entries
    if (isNaN(typeIdNum) || isNaN(qty) || qty <= 0) {
      console.warn(`[Cleanup Tool] Skipping invalid material: typeId=${typeId}, qty=${quantityPerRun}`);
      continue;
    }

    const available = aggregatedAssets[typeIdNum] || 0;
    const runsFromMaterial = Math.floor(available / qty);

    minRuns = Math.min(minRuns, runsFromMaterial);

    materialBreakdown.push({
      typeId: typeIdNum,
      required: qty,
      available: available,
      runsSupported: runsFromMaterial,
      // Percent of this material available for 1 run (capped at 100%)
      percentForOneRun: Math.min(100, (available / qty) * 100),
    });
  }

  const buildableRuns = minRuns === Infinity ? 0 : minRuns;

  // Calculate percentOnHand as the MINIMUM percent across all materials
  // This reflects the limiting factor - if you have 0% of one material,
  // you can't build anything regardless of having 1000% of others
  let percentOnHand = 100;
  for (const mat of materialBreakdown) {
    percentOnHand = Math.min(percentOnHand, mat.percentForOneRun);
  }

  // If no materials, percent is 0
  if (materialBreakdown.length === 0) {
    percentOnHand = 0;
  }

  return {
    buildableRuns,
    percentOnHand,
    materialBreakdown,
  };
}

// Render table headers
function renderTableHeaders() {
  const headerRow = document.querySelector('#summary-table thead tr');
  headerRow.innerHTML = '';

  visibleColumns.forEach(colId => {
    const col = ALL_COLUMNS.find(c => c.id === colId);
    if (!col) return;

    const th = document.createElement('th');
    th.innerHTML = col.label;
    th.className = `col-${colId}`;

    if (col.sortable) {
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        const newDirection = currentSort.column === colId && currentSort.direction === 'desc' ? 'asc' : 'desc';
        sortTable(colId, newDirection);
        displayResults();
      });
    }

    headerRow.appendChild(th);
  });

  // Setup select-all checkbox
  const selectAllCheckbox = document.getElementById('select-all-checkbox');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', (e) => {
      const checkboxes = document.querySelectorAll('#summary-table-body input[type="checkbox"]');
      checkboxes.forEach(cb => {
        cb.checked = e.target.checked;
        const typeId = parseInt(cb.dataset.blueprintTypeId, 10);
        if (e.target.checked) {
          selectedBlueprints.add(typeId);
        } else {
          selectedBlueprints.delete(typeId);
        }
      });
      updateSelectionCount();
    });
  }
}

// Sort table
function sortTable(column, direction) {
  currentSort = { column, direction };
  saveSetting('cleanup-tool-sort', currentSort, true);

  calculatedData.sort((a, b) => {
    let aVal, bVal;

    switch (column) {
      case 'percent-on-hand':
        aVal = a.percentOnHand || 0;
        bVal = b.percentOnHand || 0;
        break;
      case 'buildable-qty':
        aVal = a.buildableRuns || 0;
        bVal = b.buildableRuns || 0;
        break;
      case 'name':
        aVal = (a.itemName || '').toLowerCase();
        bVal = (b.itemName || '').toLowerCase();
        break;
      case 'category':
        aVal = (a.category || '').toLowerCase();
        bVal = (b.category || '').toLowerCase();
        break;
      case 'profit':
        aVal = a.profit || 0;
        bVal = b.profit || 0;
        break;
      case 'isk-per-hour':
        aVal = a.iskPerHour || 0;
        bVal = b.iskPerHour || 0;
        break;
      case 'total-cost':
        aVal = a.totalCost || 0;
        bVal = b.totalCost || 0;
        break;
      case 'roi':
        aVal = a.roi || 0;
        bVal = b.roi || 0;
        break;
      default:
        aVal = a[column] || '';
        bVal = b[column] || '';
    }

    if (typeof aVal === 'string') {
      return direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }

    return direction === 'asc' ? aVal - bVal : bVal - aVal;
  });
}

// Display results in table
function displayResults() {
  const tbody = document.getElementById('summary-table-body');
  const searchTerm = document.getElementById('search-box')?.value.toLowerCase() || '';

  // Filter by search term
  let filteredData = calculatedData;
  if (searchTerm) {
    filteredData = calculatedData.filter(item =>
      (item.itemName || '').toLowerCase().includes(searchTerm) ||
      (item.category || '').toLowerCase().includes(searchTerm)
    );
  }

  // Update results count
  document.getElementById('results-count').textContent = `${filteredData.length} items`;

  if (filteredData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="100%" class="no-results">No matching items found</td></tr>';
    showResults();
    return;
  }

  tbody.innerHTML = filteredData.map(item => {
    const isSelected = selectedBlueprints.has(item.blueprintTypeId);

    return `<tr data-blueprint-type-id="${item.blueprintTypeId}">
      ${visibleColumns.map(colId => {
        switch (colId) {
          case 'select':
            return `<td class="col-select">
              <input type="checkbox"
                     data-blueprint-type-id="${item.blueprintTypeId}"
                     ${isSelected ? 'checked' : ''}>
            </td>`;
          case 'percent-on-hand':
            return `<td class="col-percent-on-hand">
              <div class="percent-bar-container">
                <div class="percent-bar">
                  <div class="percent-bar-fill ${getPercentClass(item.percentOnHand)}"
                       style="width: ${item.percentOnHand}%"></div>
                </div>
                <span class="percent-value">${item.percentOnHand.toFixed(0)}%</span>
              </div>
            </td>`;
          case 'buildable-qty':
            return `<td class="col-buildable-qty">
              <span class="buildable-qty-value ${item.buildableRuns === 0 ? 'zero' : ''}">
                ${item.buildableRuns.toLocaleString()}
              </span>
            </td>`;
          case 'category':
            return `<td>${item.category}</td>`;
          case 'name':
            return `<td class="item-name">${item.itemName}</td>`;
          case 'owned':
            return `<td class="col-owned">${item.isOwned ? 'Yes' : 'No'}</td>`;
          case 'tech':
            return `<td class="col-tech">${item.tech}</td>`;
          case 'bp-type':
            return `<td class="col-bp-type">${item.isBpc ? 'BPC' : 'BPO'}</td>`;
          case 'me':
            return `<td class="col-me">${item.meLevel}</td>`;
          case 'te':
            return `<td class="col-te">${item.teLevel}</td>`;
          case 'profit':
            return `<td class="col-profit ${item.profit >= 0 ? 'positive' : 'negative'}">
              ${formatISK(item.profit)}
            </td>`;
          case 'isk-per-hour':
            return `<td class="col-isk-per-hour">${formatISK(item.iskPerHour)}</td>`;
          case 'svr':
            return `<td class="col-svr">${item.svr?.toFixed(2) || '-'}</td>`;
          case 'total-cost':
            return `<td class="col-total-cost">${formatISK(item.totalCost)}</td>`;
          case 'roi':
            return `<td class="col-roi ${item.roi >= 0 ? 'positive' : 'negative'}">
              ${item.roi?.toFixed(1) || 0}%
            </td>`;
          case 'owner':
            return `<td class="col-owner">${getCharacterName(item.ownedBy) || '-'}</td>`;
          case 'product-market-price':
            return `<td class="col-product-market-price">${formatISK(item.productPrice)}</td>`;
          default:
            return `<td>-</td>`;
        }
      }).join('')}
    </tr>`;
  }).join('');

  // Add checkbox event listeners
  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const typeId = parseInt(e.target.dataset.blueprintTypeId, 10);
      if (e.target.checked) {
        selectedBlueprints.add(typeId);
      } else {
        selectedBlueprints.delete(typeId);
      }
      updateSelectionCount();
    });
  });

  showResults();
}

function getPercentClass(percent) {
  if (percent >= 100) return 'full';
  if (percent >= 90) return 'high';
  if (percent >= 50) return 'medium';
  return 'low';
}

function updateSelectionCount() {
  const countSpan = document.getElementById('selected-count');
  const addBtn = document.getElementById('add-selected-to-plan-btn');

  if (countSpan) {
    countSpan.textContent = selectedBlueprints.size;
  }

  if (addBtn) {
    addBtn.style.display = selectedBlueprints.size > 0 ? 'inline-flex' : 'none';
  }
}

// Format ISK values
function formatISK(value) {
  if (value === null || value === undefined || isNaN(value)) return '-';

  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1e12) {
    return sign + (absValue / 1e12).toFixed(2) + 'T';
  } else if (absValue >= 1e9) {
    return sign + (absValue / 1e9).toFixed(2) + 'B';
  } else if (absValue >= 1e6) {
    return sign + (absValue / 1e6).toFixed(2) + 'M';
  } else if (absValue >= 1e3) {
    return sign + (absValue / 1e3).toFixed(2) + 'K';
  }

  return sign + absValue.toFixed(2);
}

// UI helper functions
function showLoading(message) {
  const indicator = document.getElementById('loading-indicator');
  const messageEl = document.getElementById('loading-message');
  indicator.classList.remove('hidden');
  messageEl.textContent = message;
}

function hideLoading() {
  document.getElementById('loading-indicator').classList.add('hidden');
}

function showResults() {
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('empty-state').classList.add('hidden');
}

function hideResults() {
  document.getElementById('results-section').classList.add('hidden');
}

function showEmptyState() {
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('results-section').classList.add('hidden');
}

function hideEmptyState() {
  document.getElementById('empty-state').classList.add('hidden');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast-notification ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Column configuration modal
function showColumnConfigModal() {
  const modal = document.getElementById('column-config-modal');
  const columnList = document.getElementById('column-list');

  columnList.innerHTML = ALL_COLUMNS.map((col, index) => {
    const isVisible = visibleColumns.includes(col.id);
    return `
      <div class="column-item" draggable="true" data-column-id="${col.id}">
        <input type="checkbox" ${isVisible ? 'checked' : ''} ${col.id === 'select' ? 'disabled' : ''}>
        <span class="drag-handle">&#9776;</span>
        <span class="column-name">${col.id === 'select' ? 'Select' : col.label}</span>
      </div>
    `;
  }).join('');

  // Setup drag and drop
  setupColumnDragDrop();

  modal.style.display = 'flex';
}

function hideColumnConfigModal() {
  document.getElementById('column-config-modal').style.display = 'none';
}

function resetColumnConfig() {
  visibleColumns = ALL_COLUMNS.filter(col => col.default).map(col => col.id);
  saveColumnConfig();
  showColumnConfigModal(); // Refresh modal
}

function applyColumnConfig() {
  const columnList = document.getElementById('column-list');
  const items = columnList.querySelectorAll('.column-item');

  visibleColumns = [];
  items.forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox.checked) {
      visibleColumns.push(item.dataset.columnId);
    }
  });

  saveColumnConfig();
  renderTableHeaders();
  displayResults();
  hideColumnConfigModal();
}

function setupColumnDragDrop() {
  const columnList = document.getElementById('column-list');
  let draggedItem = null;

  columnList.addEventListener('dragstart', (e) => {
    draggedItem = e.target.closest('.column-item');
    e.dataTransfer.effectAllowed = 'move';
    draggedItem.classList.add('dragging');
  });

  columnList.addEventListener('dragend', () => {
    if (draggedItem) {
      draggedItem.classList.remove('dragging');
      draggedItem = null;
    }
  });

  columnList.addEventListener('dragover', (e) => {
    e.preventDefault();
    const afterElement = getDragAfterElement(columnList, e.clientY);
    if (afterElement && draggedItem) {
      columnList.insertBefore(draggedItem, afterElement);
    } else if (draggedItem) {
      columnList.appendChild(draggedItem);
    }
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.column-item:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Plan selection modal
let selectedPlanId = null;
let createNewPlan = false;

async function handleBulkAddToPlan() {
  if (selectedBlueprints.size === 0) {
    showToast('No items selected', 'warning');
    return;
  }

  // Load existing plans
  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    if (!defaultCharacter) {
      showToast('No default character set', 'error');
      return;
    }

    const plans = await window.electronAPI.plans.getAll(defaultCharacter.characterId);
    renderPlanSelectionOptions(plans || []);
    document.getElementById('plan-selection-modal').style.display = 'flex';
  } catch (error) {
    console.error('Error loading plans:', error);
    showToast('Failed to load plans', 'error');
  }
}

function renderPlanSelectionOptions(plans) {
  const container = document.getElementById('plan-selection-options');

  container.innerHTML = `
    <label class="plan-option">
      <input type="radio" name="plan-selection" value="new" checked>
      <span>Create New Plan</span>
    </label>
    ${plans.map(plan => `
      <label class="plan-option">
        <input type="radio" name="plan-selection" value="${plan.planId}">
        <span>${plan.planName}</span>
      </label>
    `).join('')}
  `;

  // Add event listeners
  container.querySelectorAll('input[name="plan-selection"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isNew = e.target.value === 'new';
      document.getElementById('new-plan-section').style.display = isNew ? 'block' : 'none';
      selectedPlanId = isNew ? null : e.target.value;
      createNewPlan = isNew;
    });
  });

  // Reset state
  selectedPlanId = null;
  createNewPlan = true;
  document.getElementById('new-plan-section').style.display = 'block';
  document.getElementById('new-plan-name-input').value = '';
}

function hidePlanSelectionModal() {
  document.getElementById('plan-selection-modal').style.display = 'none';
}

async function confirmAddToPlan() {
  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    if (!defaultCharacter) {
      showToast('No default character set', 'error');
      return;
    }

    let planId = selectedPlanId;

    // Create new plan if needed
    if (createNewPlan) {
      const planName = document.getElementById('new-plan-name-input').value.trim() || null;
      const result = await window.electronAPI.plans.create(
        defaultCharacter.characterId,
        planName,
        'Created from Cleanup Tool'
      );
      planId = result.planId;
    }

    // Get selected items from calculatedData
    const selectedItems = calculatedData.filter(item =>
      selectedBlueprints.has(item.blueprintTypeId)
    );

    // Get facility
    const facilityId = document.getElementById('facility-select').value;
    const facility = facilityId ? await window.electronAPI.facilities.getFacility(facilityId) : null;

    // Add blueprints to plan
    let successCount = 0;
    for (const item of selectedItems) {
      try {
        await window.electronAPI.plans.addBlueprint(planId, {
          blueprintTypeId: item.blueprintTypeId,
          runs: item.buildableRuns || 1,
          productionLines: 1,
          meLevel: item.meLevel || 0,
          teLevel: item.teLevel || 0,
          facilitySnapshot: facility,
        });
        successCount++;
      } catch (error) {
        console.error(`Failed to add ${item.itemName} to plan:`, error);
      }
    }

    hidePlanSelectionModal();
    showToast(`Added ${successCount} items to plan`, 'success');

    // Clear selection
    selectedBlueprints.clear();
    updateSelectionCount();
    displayResults();

  } catch (error) {
    console.error('Error adding to plan:', error);
    showToast('Failed to add items to plan', 'error');
  }
}
