// Manufacturing Summary Renderer

let allBlueprints = [];
let calculatedData = [];
let currentFilter = 'owned';
let currentCharacterFilter = 'default';
let selectedCharacterId = null;
let currentSort = { column: 'profit', direction: 'desc' };

// Market filter state
let marketFilters = {
  svrThreshold: null,
  iphThresholdEnabled: false,
  iphThreshold: null,
  profitThresholdEnabled: false,
  profitThreshold: null
};

// Speculative Invention settings
let speculativeInventionSettings = {
  enabled: false,
  decryptorStrategy: 'total-per-item',
  customVolume: 1
};

// Filter configuration
let blueprintFilters = loadFilterConfig();

function loadFilterConfig() {
  try {
    const saved = localStorage.getItem('manufacturing-summary-filters');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (error) {
    console.error('Error loading filter config:', error);
  }
  // Default: all filters enabled
  return {
    tech: ['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'],
    category: ['Ships', 'Drones', 'Modules', 'Ammo/Charges', 'Components', 'Rigs', 'Deployables', 'Subsystems', 'Structures', 'Structure Rigs', 'Structure Modules', 'Boosters', 'Celestials', 'Reactions']
  };
}

function saveFilterConfig() {
  try {
    localStorage.setItem('manufacturing-summary-filters', JSON.stringify(blueprintFilters));
  } catch (error) {
    console.error('Error saving filter config:', error);
  }
}

// Load/Save Speculative Invention Settings (from backend settings)
async function loadSpeculativeInventionSettings() {
  try {
    const settings = await window.electronAPI.settings.get('market', 'speculativeInvention');
    if (settings) {
      speculativeInventionSettings = {
        enabled: settings.enabled || false,
        decryptorStrategy: settings.decryptorStrategy || 'total-per-item',
        customVolume: settings.customVolume || 1
      };
    }
  } catch (error) {
    console.error('Error loading speculative invention settings:', error);
  }
}

async function saveSpeculativeInventionSettings() {
  try {
    await window.electronAPI.settings.update('market', {
      speculativeInvention: speculativeInventionSettings
    });
  } catch (error) {
    console.error('Error saving speculative invention settings:', error);
  }
}

// Sync Speculative Invention UI with loaded settings
function syncSpeculativeInventionUI() {
  const enabledCheckbox = document.getElementById('speculative-invention-enabled');
  const settingsDiv = document.getElementById('speculative-invention-settings');
  const strategySelect = document.getElementById('decryptor-strategy');
  const customVolumeRow = document.getElementById('custom-volume-row');
  const customVolumeInput = document.getElementById('custom-volume');

  if (enabledCheckbox) {
    enabledCheckbox.checked = speculativeInventionSettings.enabled;
    if (settingsDiv) {
      settingsDiv.style.display = speculativeInventionSettings.enabled ? 'block' : 'none';
    }
  }

  if (strategySelect) {
    strategySelect.value = speculativeInventionSettings.decryptorStrategy;
    // Show/hide custom volume based on strategy
    if (customVolumeRow) {
      customVolumeRow.style.display =
        speculativeInventionSettings.decryptorStrategy === 'custom-volume' ? 'flex' : 'none';
    }
  }

  if (customVolumeInput) {
    customVolumeInput.value = speculativeInventionSettings.customVolume;
  }
}

// Column configuration
const ALL_COLUMNS = [
  // Default columns
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

  // Optional columns
  { id: 'owner', label: 'Owner', default: false, sortable: true, align: 'left' },
  { id: 'location', label: 'Location', default: false, sortable: true, align: 'left' },
  { id: 'job-costs', label: 'Job Costs', default: false, sortable: true, align: 'right' },
  { id: 'material-purchase-fees', label: 'Material Purchase Fees', default: false, sortable: true, align: 'right' },
  { id: 'product-selling-fees', label: 'Product Selling Fees', default: false, sortable: true, align: 'right' },
  { id: 'trading-fees-total', label: 'Trading Fees Total', default: false, sortable: true, align: 'right' },
  { id: 'product-market-price', label: 'Product Market Price', default: false, sortable: true, align: 'right' },
  { id: 'profit-percentage', label: 'Profit %', default: false, sortable: true, align: 'right' },
  { id: 'manufacturing-steps', label: 'Manufacturing Steps', default: false, sortable: true, align: 'center' },
  { id: 'm3-inputs', label: 'M³ Inputs', default: false, sortable: true, align: 'right' },
  { id: 'm3-outputs', label: 'M³ Outputs', default: false, sortable: true, align: 'right' },
  { id: 'current-sell-orders', label: 'Current Sell Orders', default: false, sortable: true, align: 'right' },

  // New Market Trend Columns
  { id: 'profit-velocity', label: 'Profit Velocity (ISK/Day)', default: false, sortable: true, align: 'right' },
  { id: 'market-saturation', label: 'Market Saturation Index', default: false, sortable: true, align: 'right' },
  { id: 'price-momentum', label: 'Price Momentum', default: false, sortable: true, align: 'right' },
  { id: 'profit-stability', label: 'Profit Stability Index', default: false, sortable: true, align: 'right' },
  { id: 'demand-growth', label: 'Demand Growth Rate', default: false, sortable: true, align: 'right' },
  { id: 'material-cost-volatility', label: 'Material Cost Volatility', default: false, sortable: true, align: 'right' },
  { id: 'market-health-score', label: 'Market Health Score', default: false, sortable: true, align: 'right' },

  // Speculative Invention Columns
  { id: 'invention-status', label: 'Invention Status', default: false, sortable: true, align: 'center' },
  { id: 'optimal-decryptor', label: 'Optimal Decryptor', default: false, sortable: true, align: 'left' },
  { id: 'invention-probability', label: 'Invention Probability', default: false, sortable: true, align: 'right' },
  { id: 'invention-cost-attempt', label: 'Invention Cost/Attempt', default: false, sortable: true, align: 'right' },
  { id: 'total-cost-with-invention', label: 'Total Cost w/ Invention', default: false, sortable: true, align: 'right' },
];

let visibleColumns = loadColumnConfig();

// Load column configuration from localStorage
function loadColumnConfig() {
  try {
    const saved = localStorage.getItem('manufacturing-summary-columns');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Validate that all column IDs exist
      const validColumns = parsed.filter(id => ALL_COLUMNS.find(col => col.id === id));
      if (validColumns.length > 0) {
        return validColumns;
      }
    }
  } catch (error) {
    console.error('Error loading column config:', error);
  }
  // Default columns if no saved config or error
  return ALL_COLUMNS.filter(col => col.default).map(col => col.id);
}

// Save column configuration to localStorage
function saveColumnConfig() {
  try {
    localStorage.setItem('manufacturing-summary-columns', JSON.stringify(visibleColumns));
  } catch (error) {
    console.error('Error saving column config:', error);
  }
}

// Initialize the page
document.addEventListener('DOMContentLoaded', async () => {
  await loadFacilities();
  await loadCharacters();
  await loadSpeculativeInventionSettings();
  setupEventListeners();
  renderTableHeaders(); // Initialize table headers with saved/default columns
  syncFiltersWithUI(); // Sync saved filters with main UI checkboxes
  syncSpeculativeInventionUI(); // Sync speculative invention settings with UI
  await checkMarketDataAge(); // Check market data age on page load
});

// Store characters globally for owner lookup
let allCharacters = [];

// Load characters into dropdown
async function loadCharacters() {
  try {
    const characters = await window.electronAPI.esi.getCharacters();
    allCharacters = characters || []; // Store for later lookup
    const characterSelect = document.getElementById('character-select');

    if (characters && characters.length > 0) {
      // Clear existing options except the first placeholder
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

// Helper to get character name by ID
function getCharacterName(characterId) {
  if (!characterId) return null;
  const character = allCharacters.find(c => c.characterId === characterId);
  return character ? character.characterName : 'Unknown Character';
}

// Sync saved filter config with main UI checkboxes
function syncFiltersWithUI() {
  // Tech level filters
  document.querySelectorAll('#tech-filter input[type="checkbox"]').forEach(checkbox => {
    checkbox.checked = blueprintFilters.tech.includes(checkbox.value);
  });

  // Category filters
  document.querySelectorAll('#category-filter input[type="checkbox"]').forEach(checkbox => {
    checkbox.checked = blueprintFilters.category.includes(checkbox.value);
  });
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

// Get current filter selections from main UI
function getCurrentFilters() {
  const filters = {
    tech: [],
    category: []
  };

  // Tech level filters
  document.querySelectorAll('#tech-filter input[type="checkbox"]:checked').forEach(checkbox => {
    filters.tech.push(checkbox.value);
  });

  // Category filters
  document.querySelectorAll('#category-filter input[type="checkbox"]:checked').forEach(checkbox => {
    filters.category.push(checkbox.value);
  });

  return filters;
}

// Setup event listeners
function setupEventListeners() {
  // Back button - close window
  document.getElementById('back-btn').addEventListener('click', () => {
    window.close();
  });

  // Blueprint filter radios
  document.querySelectorAll('input[name="blueprint-filter"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentFilter = e.target.value;
    });
  });

  // Character filter radios
  document.querySelectorAll('input[name="character-filter"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentCharacterFilter = e.target.value;
      const characterSelect = document.getElementById('character-select');

      // Enable/disable character dropdown based on selection
      if (e.target.value === 'specific') {
        characterSelect.disabled = false;
      } else {
        characterSelect.disabled = true;
        characterSelect.value = '';
      }
    });
  });

  // Character select dropdown
  document.getElementById('character-select')?.addEventListener('change', (e) => {
    selectedCharacterId = e.target.value ? parseInt(e.target.value) : null;
  });

  // Market filter event listeners
  document.getElementById('svr-threshold')?.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    marketFilters.svrThreshold = value > 0 ? value : null;
  });

  document.getElementById('iph-threshold-enabled')?.addEventListener('change', (e) => {
    marketFilters.iphThresholdEnabled = e.target.checked;
    const iphInput = document.getElementById('iph-threshold');
    if (iphInput) {
      iphInput.disabled = !e.target.checked;
      iphInput.value = e.target.checked ? 0 : '';
      // Manually update the filter value to match the input
      marketFilters.iphThreshold = e.target.checked ? 0 : null;
    }
  });

  document.getElementById('iph-threshold')?.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    // Allow any valid number including 0 and negatives, only reject NaN (empty/invalid input)
    marketFilters.iphThreshold = !isNaN(value) ? value : null;
  });

  document.getElementById('profit-threshold-enabled')?.addEventListener('change', (e) => {
    marketFilters.profitThresholdEnabled = e.target.checked;
    const profitInput = document.getElementById('profit-threshold');
    if (profitInput) {
      profitInput.disabled = !e.target.checked;
      profitInput.value = e.target.checked ? 0 : '';
      // Manually update the filter value to match the input
      marketFilters.profitThreshold = e.target.checked ? 0 : null;
    }
  });

  document.getElementById('profit-threshold')?.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    // Allow any valid number including 0 and negatives, only reject NaN (empty/invalid input)
    marketFilters.profitThreshold = !isNaN(value) ? value : null;
  });

  // Calculate button
  document.getElementById('calculate-btn').addEventListener('click', calculateSummary);

  // Search box
  document.getElementById('search-box').addEventListener('input', (e) => {
    filterAndDisplayResults(e.target.value);
  });

  // Configure columns button
  document.getElementById('configure-columns-btn')?.addEventListener('click', openColumnConfigModal);

  // Close column modal
  document.getElementById('close-column-modal-btn')?.addEventListener('click', closeColumnConfigModal);

  // Reset columns button
  document.getElementById('reset-columns-btn')?.addEventListener('click', resetColumns);

  // Apply columns button
  document.getElementById('apply-columns-btn')?.addEventListener('click', applyColumns);

  // Filter chip event listeners (main UI)
  document.querySelectorAll('#tech-filter input[type="checkbox"], #category-filter input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      // Update blueprintFilters when checkboxes change
      blueprintFilters = getCurrentFilters();
      saveFilterConfig();
    });
  });

  // Modal backdrop click
  document.getElementById('column-config-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'column-config-modal') {
      closeColumnConfigModal();
    }
  });

  // Speculative Invention event listeners
  const speculativeEnabledCheckbox = document.getElementById('speculative-invention-enabled');
  const speculativeSettingsDiv = document.getElementById('speculative-invention-settings');
  const decryptorStrategySelect = document.getElementById('decryptor-strategy');
  const customVolumeRow = document.getElementById('custom-volume-row');
  const customVolumeInput = document.getElementById('custom-volume');

  // Toggle speculative invention
  speculativeEnabledCheckbox?.addEventListener('change', async (e) => {
    speculativeInventionSettings.enabled = e.target.checked;
    if (speculativeSettingsDiv) {
      speculativeSettingsDiv.style.display = e.target.checked ? 'block' : 'none';
    }
    await saveSpeculativeInventionSettings();
  });

  // Decryptor strategy change
  decryptorStrategySelect?.addEventListener('change', async (e) => {
    speculativeInventionSettings.decryptorStrategy = e.target.value;
    // Show/hide custom volume input
    if (customVolumeRow) {
      customVolumeRow.style.display = e.target.value === 'custom-volume' ? 'flex' : 'none';
    }
    await saveSpeculativeInventionSettings();
  });

  // Custom volume input
  customVolumeInput?.addEventListener('change', async (e) => {
    const value = parseInt(e.target.value);
    if (!isNaN(value) && value > 0) {
      speculativeInventionSettings.customVolume = value;
      await saveSpeculativeInventionSettings();
    }
  });
}

// Main calculation function
async function calculateSummary() {
  const facilityId = document.getElementById('facility-select').value;
  if (!facilityId) {
    alert('Please select a facility');
    return;
  }

  // Debug: Log speculative invention settings
  console.log('[DEBUG] Speculative Invention Settings:', speculativeInventionSettings);

  // Show loading
  showLoading('Loading blueprints...');
  hideEmptyState();
  hideResults();

  try {
    // Get blueprints based on filter
    const blueprints = await getBlueprintsByFilter();

    if (!blueprints || blueprints.length === 0) {
      showEmptyState();
      hideLoading();
      return;
    }

    // Get current filters from main UI
    const currentFilters = getCurrentFilters();

    // Filter blueprints BEFORE starting calculations
    const filteredBlueprints = blueprints.filter(blueprint => {
      const techLevel = determineTechLevel(blueprint);
      const category = determineCategory(blueprint);
      return currentFilters.tech.includes(techLevel) && currentFilters.category.includes(category);
    });

    if (filteredBlueprints.length === 0) {
      showEmptyState();
      hideLoading();
      return;
    }

    allBlueprints = filteredBlueprints;
    calculatedData = [];

    // Calculate data for each blueprint
    showLoading(`Calculating profitability for ${filteredBlueprints.length} blueprints...`);

    const facility = await window.electronAPI.facilities.getFacility(facilityId);
    const svrPeriod = parseInt(document.getElementById('svr-period').value);
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();

    // Get owned blueprints list based on current filter and character selection
    let ownedBlueprintsList = null;
    if (currentFilter === 'owned' || currentFilter === 'corp') {
      // Determine which character(s) to use for blueprint ME/TE data
      let characterIds = [];

      if (currentCharacterFilter === 'all') {
        const allCharacters = await window.electronAPI.esi.getCharacters();
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

      // Collect blueprints from selected characters
      const allOwnedBlueprints = [];
      for (const charId of characterIds) {
        try {
          const charBlueprints = await window.electronAPI.blueprints.getAll(charId);
          allOwnedBlueprints.push(...charBlueprints);
        } catch (error) {
          console.error(`Error fetching blueprints for character ${charId}:`, error);
        }
      }

      // Filter based on current filter setting
      if (currentFilter === 'owned') {
        // Character blueprints only
        ownedBlueprintsList = allOwnedBlueprints.filter(bp => {
          const isCorp = bp.isCorporation || (
            bp.locationFlag && (
              bp.locationFlag.startsWith('CorpSAG') ||
              bp.locationFlag.startsWith('CorpDeliveries')
            )
          );
          return !isCorp;
        });
      } else if (currentFilter === 'corp') {
        // Corporation blueprints only
        ownedBlueprintsList = allOwnedBlueprints.filter(bp => {
          return bp.isCorporation || (
            bp.locationFlag && (
              bp.locationFlag.startsWith('CorpSAG') ||
              bp.locationFlag.startsWith('CorpDeliveries')
            )
          );
        });
      }
    }

    // Start timing for all calculations
    const calculationStartTime = performance.now();

    // Invention tracking counters
    let t1BlueprintsFound = 0;
    let inventionDataCalculated = 0;
    let inventionErrors = 0;

    // Parallel batch processing configuration
    const BATCH_SIZE = 6; // Process 6 blueprints concurrently
    const totalBlueprints = filteredBlueprints.length;
    let processedCount = 0;

    // Process blueprints in batches
    for (let i = 0; i < totalBlueprints; i += BATCH_SIZE) {
      const batch = filteredBlueprints.slice(i, Math.min(i + BATCH_SIZE, totalBlueprints));

      // Update loading message
      showLoading(`Calculating... ${processedCount}/${totalBlueprints}`);

      // Calculate batch in parallel using Promise.allSettled
      const batchPromises = batch.map(blueprint =>
        calculateBlueprintData(blueprint, facility, svrPeriod, defaultCharacter, ownedBlueprintsList)
          .catch(error => {
            console.error(`Error calculating blueprint ${blueprint.typeName}:`, error);
            return null; // Return null on error
          })
      );

      const batchResults = await Promise.allSettled(batchPromises);

      // Process results
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          calculatedData.push(result.value);
          processedCount++;
        } else if (result.status === 'rejected') {
          console.error('Blueprint calculation rejected:', result.reason);
        }
      });

      // Small delay to allow UI to update
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Calculate and log total elapsed time
    const totalElapsedTime = performance.now() - calculationStartTime;
    const avgTimePerBlueprint = processedCount > 0 ? totalElapsedTime / processedCount : 0;
    console.log(`[Manufacturing Summary] Calculated ${processedCount} blueprints in ${totalElapsedTime.toFixed(2)}ms (${(totalElapsedTime / 1000).toFixed(2)}s)`);
    console.log(`[Manufacturing Summary] Average time per blueprint: ${avgTimePerBlueprint.toFixed(2)}ms`);

    // Count invention results
    const inventionResults = calculatedData.filter(d => d.inventionStatus).length;
    console.log(`[INVENTION SUMMARY] Speculative Invention enabled: ${speculativeInventionSettings.enabled}`);
    console.log(`[INVENTION SUMMARY] Blueprints with invention data: ${inventionResults}/${processedCount}`);

    // Apply market filters
    applyMarketFilters();

    hideLoading();
    sortTable(currentSort.column, currentSort.direction);
    displayResults();

    // Check market data age and show warning if needed
    await checkMarketDataAge();

  } catch (error) {
    console.error('Error calculating summary:', error);
    alert('Error calculating summary: ' + error.message);
    hideLoading();
    showEmptyState();
  }
}

// Apply market filters to calculated data
function applyMarketFilters() {
  const originalCount = calculatedData.length;

  calculatedData = calculatedData.filter(item => {
    // SVR Threshold filter
    if (marketFilters.svrThreshold !== null && item.svr < marketFilters.svrThreshold) {
      return false;
    }

    // IPH Threshold filter
    if (marketFilters.iphThresholdEnabled && marketFilters.iphThreshold !== null) {
      if (item.iskPerHour < marketFilters.iphThreshold) {
        return false;
      }
    }

    // Profit Threshold filter
    if (marketFilters.profitThresholdEnabled && marketFilters.profitThreshold !== null) {
      if (item.profit < marketFilters.profitThreshold) {
        return false;
      }
    }

    return true;
  });

  const filteredCount = originalCount - calculatedData.length;
  if (filteredCount > 0) {
    console.log(`[Market Filters] Filtered out ${filteredCount} blueprints based on market thresholds`);
  }
}

// Get blueprints based on current filter
async function getBlueprintsByFilter() {
  let blueprints = [];

  switch (currentFilter) {
    case 'all':
      blueprints = await window.electronAPI.calculator.getAllBlueprints(null);
      break;

    case 'owned':
    case 'corp':
      // Determine which character(s) to use
      let characterIds = [];

      if (currentCharacterFilter === 'all') {
        // Get all characters
        const allCharacters = await window.electronAPI.esi.getCharacters();
        characterIds = allCharacters.map(c => c.characterId);
      } else if (currentCharacterFilter === 'default') {
        // Get default character only
        const defaultChar = await window.electronAPI.esi.getDefaultCharacter();
        if (!defaultChar) {
          alert('No default character set. Please set a default character in settings.');
          return [];
        }
        characterIds = [defaultChar.characterId];
      } else if (currentCharacterFilter === 'specific') {
        // Get specific selected character
        if (!selectedCharacterId) {
          alert('Please select a character from the dropdown.');
          return [];
        }
        characterIds = [selectedCharacterId];
      }

      // Collect blueprints from all selected characters
      const allOwnedBlueprints = [];
      for (const charId of characterIds) {
        try {
          const charBlueprints = await window.electronAPI.blueprints.getAll(charId);
          allOwnedBlueprints.push(...charBlueprints);
        } catch (error) {
          console.error(`Error fetching blueprints for character ${charId}:`, error);
        }
      }

      // Filter based on owned vs corp
      let filteredBlueprints;
      if (currentFilter === 'owned') {
        // Character blueprints only (not corporation)
        filteredBlueprints = allOwnedBlueprints.filter(bp => {
          const isCorp = bp.isCorporation || (
            bp.locationFlag && (
              bp.locationFlag.startsWith('CorpSAG') ||
              bp.locationFlag.startsWith('CorpDeliveries')
            )
          );
          return !isCorp;
        });
      } else {
        // Corporation blueprints only
        filteredBlueprints = allOwnedBlueprints.filter(bp => {
          return bp.isCorporation || (
            bp.locationFlag && (
              bp.locationFlag.startsWith('CorpSAG') ||
              bp.locationFlag.startsWith('CorpDeliveries')
            )
          );
        });

        if (filteredBlueprints.length === 0) {
          alert('No corporation blueprints found for the selected character(s).');
          return [];
        }
      }

      // Get full blueprint data from SDE
      const allBPs = await window.electronAPI.calculator.getAllBlueprints(null);
      blueprints = allBPs.filter(bp => filteredBlueprints.some(owned => owned.typeId === bp.typeID));
      break;

    default:
      return [];
  }

  // Add speculative invention T2 blueprints if enabled
  if (speculativeInventionSettings.enabled) {
    console.log('[SPECULATIVE] Adding T2 blueprints for invention analysis...');
    const allBPs = await window.electronAPI.calculator.getAllBlueprints(null);
    const speculativeBlueprints = [];

    // Find all T1 blueprints in the list
    for (const blueprint of blueprints) {
      if (blueprint.productMetaGroupID === 1) {
        try {
          const inventionInfo = await window.electronAPI.calculator.getInventionData(blueprint.typeID);

          if (inventionInfo && inventionInfo.t2BlueprintTypeID) {
            // Check if we already have this T2 blueprint in the list
            const alreadyExists = blueprints.some(bp => bp.typeID === inventionInfo.t2BlueprintTypeID);

            if (!alreadyExists) {
              // Find the T2 blueprint in the SDE and add it
              const t2Blueprint = allBPs.find(bp => bp.typeID === inventionInfo.t2BlueprintTypeID);
              if (t2Blueprint) {
                // Mark it as a speculative invention blueprint
                speculativeBlueprints.push({
                  ...t2Blueprint,
                  isSpeculativeInvention: true,
                  parentT1BlueprintTypeID: blueprint.typeID
                });
                console.log(`[SPECULATIVE] Added T2 blueprint ${t2Blueprint.typeName} from T1 ${blueprint.typeName}`);
              }
            }
          }
        } catch (error) {
          console.error(`Error fetching invention data for ${blueprint.typeName}:`, error);
        }
      }
    }

    if (speculativeBlueprints.length > 0) {
      console.log(`[SPECULATIVE] Added ${speculativeBlueprints.length} speculative T2 blueprints`);
      blueprints = [...blueprints, ...speculativeBlueprints];
    }
  }

  return blueprints;
}

// Calculate data for a speculative invention blueprint (T2 that isn't owned)
async function calculateSpeculativeInventionData(blueprint, facility, svrPeriod, defaultCharacter, ownedBlueprintsList) {
  try {
    console.log(`[SPECULATIVE] Calculating invention data for T2 blueprint: ${blueprint.typeName}`);

    const characterId = defaultCharacter ? defaultCharacter.characterId : null;
    const parentT1BlueprintTypeID = blueprint.parentT1BlueprintTypeID;

    // Get invention info for the parent T1 blueprint
    const inventionInfo = await window.electronAPI.calculator.getInventionData(parentT1BlueprintTypeID);

    if (!inventionInfo || !inventionInfo.t2BlueprintTypeID) {
      console.error(`[SPECULATIVE] No invention data for T1 blueprint ${parentT1BlueprintTypeID}`);
      return null;
    }

    // Get market settings for pricing
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;
    const locationId = marketSettings.locationId || null;

    // Fetch real market prices for invention materials (datacores, etc.)
    const inventionMaterialPrices = {};
    if (inventionInfo.materials) {
      for (const [typeId, quantity] of Object.entries(inventionInfo.materials)) {
        try {
          const parsedTypeId = parseInt(typeId);
          // Validate typeId before fetching price
          if (!parsedTypeId || parsedTypeId === 0 || isNaN(parsedTypeId)) {
            console.warn(`[SPECULATIVE] Skipping invalid invention material typeId: ${typeId}`);
            continue;
          }

          const priceData = await window.electronAPI.market.calculatePrice(
            parsedTypeId,
            regionId,
            locationId,
            marketSettings.inputMaterials?.priceType || 'sell',
            1
          );
          inventionMaterialPrices[typeId] = priceData.price;
        } catch (error) {
          console.error(`[SPECULATIVE ERROR] Error fetching price for material ${typeId}:`, error);
          alert(`Error fetching market price for invention material (typeId: ${typeId}).\n\nError: ${error.message}`);
          throw error;
        }
      }
    }

    // Calculate T2 manufacturing costs (ME=0, TE=0 for invented BPC)
    const t2Result = await window.electronAPI.calculator.calculateMaterials(
      blueprint.typeID,
      1,
      0, // ME level = 0 for invented BPCs
      characterId,
      facility.id
    );

    if (!t2Result || !t2Result.pricing) {
      console.error(`[SPECULATIVE] Failed to calculate T2 manufacturing costs`);
      return null;
    }

    const t2Pricing = t2Result.pricing;
    const t2ProductPrice = t2Pricing.outputValue?.totalValue || 0;

    // Extract T2 manufacturing costs and fees from pricing breakdown
    const jcb = t2Pricing.jobCostBreakdown || {};
    const jobCostsTotal = (jcb.jobBaseCost || 0) + (jcb.facilityTax || 0) + (jcb.sccSurcharge || 0);

    const tb = t2Pricing.taxesBreakdown || {};
    const materialBrokerFee = tb.materialBrokerFee || 0;
    const productSellingFees = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0);
    const tradingFeesTotal = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0) + (tb.materialBrokerFee || 0);

    // Get character skills dynamically based on blueprint's actual requirements
    const characterSkills = { encryption: 0, datacore1: 0, datacore2: 0 };

    if (defaultCharacter?.characterId && inventionInfo?.skills?.length >= 3) {
      try {
        // Encryption skill IDs (all races including advanced/specialized)
        const ENCRYPTION_SKILL_IDS = [3408, 21790, 21791, 23087, 23121, 52308, 55025];

        // Separate encryption skill from datacore skills
        const encryptionSkill = inventionInfo.skills.find(s =>
          ENCRYPTION_SKILL_IDS.includes(s.skillID)
        );

        const datacoreSkills = inventionInfo.skills.filter(s =>
          !ENCRYPTION_SKILL_IDS.includes(s.skillID)
        );

        // Get encryption skill level from character
        if (encryptionSkill) {
          characterSkills.encryption = await window.electronAPI.skills.getEffectiveLevel(
            defaultCharacter.characterId,
            encryptionSkill.skillID
          ) || 0;
        }

        // Get datacore skill levels from character
        if (datacoreSkills.length >= 2) {
          characterSkills.datacore1 = await window.electronAPI.skills.getEffectiveLevel(
            defaultCharacter.characterId,
            datacoreSkills[0].skillID
          ) || 0;

          characterSkills.datacore2 = await window.electronAPI.skills.getEffectiveLevel(
            defaultCharacter.characterId,
            datacoreSkills[1].skillID
          ) || 0;
        }
      } catch (error) {
        console.error('[SPECULATIVE] Error getting character skills:', error);
        // Falls back to defaults (0, 0, 0)
      }
    }

    // Find best decryptor
    const decryptorResult = await window.electronAPI.calculator.findBestDecryptor(
      inventionInfo,
      inventionMaterialPrices,
      t2ProductPrice,
      characterSkills,
      facility,
      speculativeInventionSettings.decryptorStrategy,
      speculativeInventionSettings.customVolume
    );

    if (!decryptorResult || !decryptorResult.best) {
      console.error(`[SPECULATIVE] No best decryptor found`);
      return null;
    }

    const best = decryptorResult.best;

    // Calculate total cost including invention
    const totalCostWithInvention = best.totalCostPerItem || 0;
    const inventionCostPerItem = best.inventionCostPerItem || 0;
    const profit = t2ProductPrice - totalCostWithInvention;

    // Calculate other metrics
    const productionTimeSeconds = calculateProductionTime(blueprint.baseTime, 0, facility);
    const productionTimeHours = productionTimeSeconds / 3600;
    const iskPerHour = productionTimeHours > 0 ? profit / productionTimeHours : 0;
    const svr = await calculateSVR(blueprint.productTypeID, svrPeriod, productionTimeHours);
    const roi = totalCostWithInvention > 0 ? (profit / totalCostWithInvention) * 100 : 0;
    const techLevel = determineTechLevel(blueprint);
    const profitPercentage = totalCostWithInvention > 0 ? (profit / totalCostWithInvention) * 100 : 0;

    // Calculate manufacturing steps (1 for main blueprint + intermediate components)
    const intermediateComponents = best.breakdown?.[0]?.intermediateComponents || [];
    const manufacturingSteps = 1 + intermediateComponents.length;

    // Calculate M³ for inputs
    const materialTypeIds = Object.keys(best.blueprintResult.materials).map(id => parseInt(id));
    const materialVolumes = await window.electronAPI.sde.getItemVolumes(materialTypeIds);
    let totalInputVolume = 0;
    for (const [typeId, quantity] of Object.entries(best.blueprintResult.materials)) {
        const volume = materialVolumes[typeId] || 0;
        totalInputVolume += volume * quantity;
    }

    // Get M³ for output product
    const productVolume = await window.electronAPI.sde.getItemVolume(blueprint.productTypeID);
    const totalOutputVolume = productVolume * best.blueprintResult.product.quantity;

      // Market metrics
    const currentSellOrders = await calculateTotalSellVolume(blueprint.productTypeID);
    const profitVelocity = await calculateProfitVelocity(blueprint.productTypeID, profit, 30);
    const marketSaturation = await calculateMarketSaturation(blueprint.productTypeID, currentSellOrders, 30);
    const priceMomentum = await calculatePriceMomentum(blueprint.productTypeID);
    const profitStability = await calculateProfitStability(blueprint.productTypeID, profit, 28);
    const demandGrowth = await calculateDemandGrowth(blueprint.productTypeID);
    const materialCostVolatility = await calculateMaterialCostVolatility(t2Result.materials, 30);
    const marketHealthScore = calculateMarketHealthScore(svr, marketSaturation, priceMomentum, profitStability);

    console.log(`[SPECULATIVE] Successfully calculated: ${blueprint.typeName}, decryptor: ${best.name}, profit: ${profit.toLocaleString()} ISK`);

    return {
      blueprintTypeId: blueprint.typeID,
      category: blueprint.category || 'Unknown',
      itemName: blueprint.typeName,
      productTypeId: blueprint.productTypeID,
      productName: blueprint.productTypeName,
      isOwned: false,
      techLevel: techLevel,
      bpType: 'BPC (Invented)',
      meLevel: best.finalME,
      teLevel: best.finalTE,
      profit: profit,
      iskPerHour: iskPerHour,
      svr: svr,
      totalCost: totalCostWithInvention,
      roi: roi,
      productionTimeHours,
      jobCosts: jobCostsTotal,
      materialPurchaseFees: materialBrokerFee,
      productSellingFees: productSellingFees,
      tradingFeesTotal: tradingFeesTotal,
      blueprintType: 'BPC',
      productMarketPrice: t2ProductPrice,
      profitPercentage: profitPercentage,
      manufacturingSteps: manufacturingSteps,
      m3Inputs: totalInputVolume,
      m3Outputs: totalOutputVolume,
      currentSellOrders,
      profitVelocity,
      marketSaturation,
      priceMomentum,
      profitStability,
      demandGrowth,
      materialCostVolatility,
      marketHealthScore,
      // Speculative Invention data
      inventionStatus: 'Speculative',
      optimalDecryptor: best.name || 'No Decryptor',
      inventionProbability: best.probability || 0,
      inventionCostAttempt: best.totalCostPerAttempt || 0,
      totalCostWithInvention: totalCostWithInvention,
      // Owner and Location data (null for speculative blueprints)
      ownerCharacterId: null,
      locationId: null,
      locationName: null,
    };
  } catch (error) {
    console.error(`[SPECULATIVE ERROR] Error calculating speculative invention for ${blueprint.typeName}:`, error);
    return null;
  }
}

// Calculate all data for a single blueprint
async function calculateBlueprintData(blueprint, facility, svrPeriod, defaultCharacter, ownedBlueprintsList = null) {
  try {
    // Handle speculative invention blueprints differently
    if (blueprint.isSpeculativeInvention) {
      return await calculateSpeculativeInventionData(blueprint, facility, svrPeriod, defaultCharacter, ownedBlueprintsList);
    }

    const characterId = defaultCharacter ? defaultCharacter.characterId : null;

    // Get owned blueprint info from the provided list
    const ownedBP = ownedBlueprintsList ?
      ownedBlueprintsList.find(bp => bp.typeId === blueprint.typeID) : null;

    const isOwned = !!ownedBP;
    const meLevel = ownedBP ? (ownedBP.materialEfficiency || 0) : 0;
    const teLevel = ownedBP ? (ownedBP.timeEfficiency || 0) : 0;

    // Resolve location information if owned
    let locationInfo = null;
    if (ownedBP && ownedBP.locationId) {
      try {
        // Determine if this is a corporation blueprint
        const isCorporation = ownedBP.isCorporation || false;

        // Use new enhanced location resolver
        locationInfo = await window.electronAPI.location.resolve(
          ownedBP.locationId,
          characterId,
          isCorporation
        );
      } catch (error) {
        console.error(`Error resolving location ${ownedBP.locationId}:`, error);
        locationInfo = {
          systemName: 'Unknown',
          stationName: 'Unknown',
          containerNames: [],
          fullPath: 'Unknown',
          locationType: 'error',
        };
      }
    }

    // Calculate materials and pricing
    const result = await window.electronAPI.calculator.calculateMaterials(
      blueprint.typeID,
      1, // 1 run
      meLevel,
      characterId,
      facility.id
    );

    if (!result || !result.pricing) {
      return null;
    }

    const pricing = result.pricing;

    // Calculate ISK per Hour
    const productionTimeSeconds = calculateProductionTime(blueprint.baseTime, teLevel, facility);
    const productionTimeHours = productionTimeSeconds / 3600;
    const iskPerHour = productionTimeHours > 0 ? pricing.profit / productionTimeHours : 0;

    // Calculate SVR
    const svr = await calculateSVR(blueprint.productTypeID, svrPeriod, productionTimeHours);

    // Calculate ROI
    const roi = pricing.totalCosts > 0 ? (pricing.profit / pricing.totalCosts) * 100 : 0;

    // Determine tech level
    const techLevel = determineTechLevel(blueprint);

    // Blueprint type
    const blueprintType = ownedBP?.isCopy ? 'BPC' : 'BPO';

    // Profit percentage - use pricing.profitMargin which is already calculated correctly
    const profitPercentage = pricing.profitMargin || 0;

    // Extract fee data from the correct pricing structure
    // Job costs are in pricing.jobCostBreakdown
    const jcb = pricing.jobCostBreakdown || {};
    const jobCostsTotal = (jcb.jobBaseCost || 0) + (jcb.facilityTax || 0) + (jcb.sccSurcharge || 0);

    // Trading taxes are in pricing.taxesBreakdown
    const tb = pricing.taxesBreakdown || {};
    const materialBrokerFee = tb.materialBrokerFee || 0;
    const productSellingFees = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0);
    const tradingFeesTotal = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0) + (tb.materialBrokerFee || 0);

    // Extract input and output costs
    const inputCosts = pricing.inputCosts || {};
    const outputValue = pricing.outputValue || {};

    // Calculate M³ for inputs
    const materialTypeIds = Object.keys(result.materials).map(id => parseInt(id));
    const materialVolumes = await window.electronAPI.sde.getItemVolumes(materialTypeIds);
    let totalInputVolume = 0;
    for (const [typeId, quantity] of Object.entries(result.materials)) {
      const volume = materialVolumes[typeId] || 0;
      totalInputVolume += volume * quantity;
    }

    // Get M³ for output product
    const productVolume = await window.electronAPI.sde.getItemVolume(blueprint.productTypeID);
    const totalOutputVolume = productVolume * result.product.quantity;

    // Get current sell orders volume
    const currentSellOrders = await calculateTotalSellVolume(blueprint.productTypeID);

    // Calculate manufacturing steps (1 for main blueprint + intermediate components)
    const intermediateComponents = result.breakdown?.[0]?.intermediateComponents || [];
    const manufacturingSteps = 1 + intermediateComponents.length;

    // Calculate new market trend metrics
    const profitVelocity = await calculateProfitVelocity(blueprint.productTypeID, pricing.profit, 30);
    const marketSaturation = await calculateMarketSaturation(blueprint.productTypeID, currentSellOrders, 30);
    const priceMomentum = await calculatePriceMomentum(blueprint.productTypeID);
    const profitStability = await calculateProfitStability(blueprint.productTypeID, pricing.profit, 28);
    const demandGrowth = await calculateDemandGrowth(blueprint.productTypeID);
    const materialCostVolatility = await calculateMaterialCostVolatility(result.materials, 30);
    const marketHealthScore = calculateMarketHealthScore(svr, marketSaturation, priceMomentum, profitStability);

    // Initialize inventionData for normal blueprints (not used but referenced in return)
    const inventionData = null;

    return {
      blueprintTypeId: blueprint.typeID,
      category: blueprint.category || 'Unknown',
      itemName: blueprint.typeName,
      productTypeId: blueprint.productTypeID,
      productName: blueprint.productName,
      isOwned,
      techLevel,
      bpType: isOwned ? blueprintType : 'N/A',
      meLevel,
      teLevel,
      profit: pricing.profit,
      iskPerHour,
      svr,
      totalCost: pricing.totalCosts,
      roi,
      productionTimeHours,
      // New optional columns
      jobCosts: jobCostsTotal,
      materialPurchaseFees: materialBrokerFee,
      productSellingFees: productSellingFees,
      tradingFeesTotal: tradingFeesTotal,
      blueprintType: isOwned ? blueprintType : 'N/A',
      productMarketPrice: outputValue.totalValue || 0,
      profitPercentage,
      manufacturingSteps,
      m3Inputs: totalInputVolume,
      m3Outputs: totalOutputVolume,
      currentSellOrders,
      // New market trend metrics
      profitVelocity,
      marketSaturation,
      priceMomentum,
      profitStability,
      demandGrowth,
      materialCostVolatility,
      marketHealthScore,
      // Speculative Invention data
      inventionStatus: inventionData?.status || null,
      optimalDecryptor: inventionData?.decryptor || null,
      inventionProbability: inventionData?.probability || null,
      inventionCostAttempt: inventionData?.costPerAttempt || null,
      totalCostWithInvention: inventionData?.totalCostWithInvention || null,
      // Owner and Location data
      ownerCharacterId: ownedBP ? ownedBP.characterId : null,
      locationId: ownedBP ? ownedBP.locationId : null,
      locationInfo: locationInfo, // Store full location info object
      // Keep backward compatibility
      locationName: locationInfo ? locationInfo.stationName : null,
    };
  } catch (error) {
    console.error(`Error calculating data for ${blueprint.typeName}:`, error);
    return null;
  }
}

// Calculate production time with bonuses
function calculateProductionTime(baseTime, teLevel, facility) {
  if (!baseTime) return 0;

  // Apply TE reduction (1% per level)
  let time = baseTime * (1 - (teLevel / 100));

  // Apply facility bonuses
  if (facility && facility.structureBonuses && facility.structureBonuses.timeEfficiency) {
    time = time * (1 - (facility.structureBonuses.timeEfficiency / 100));
  }

  // Apply rig bonuses (if applicable)
  // TODO: Add rig time bonuses when implemented

  return time;
}

// Calculate SVR (Sales to Volume Ratio)
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

// Calculate total sell volume from market orders
async function calculateTotalSellVolume(productTypeId) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculateTotalSellVolume] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002; // Default to The Forge

    // Get location filter based on market settings
    let locationFilter = null;
    if (marketSettings.locationType === 'system' && marketSettings.systemId) {
      locationFilter = { type: 'system', id: marketSettings.systemId };
    } else if (marketSettings.locationType === 'station' && marketSettings.locationId) {
      locationFilter = { type: 'station', id: marketSettings.locationId };
    }

    // Fetch market orders
    const orders = await window.electronAPI.market.fetchOrders(regionId, productTypeId, locationFilter);

    if (!orders || orders.length === 0) {
      return 0;
    }

    // Filter to sell orders only and sum volume_remain
    const sellOrders = orders.filter(o => !o.is_buy_order);
    const totalSellVolume = sellOrders.reduce((sum, o) => sum + (o.volume_remain || 0), 0);

    return totalSellVolume;
  } catch (error) {
    console.error('Error calculating total sell volume:', error);
    return 0;
  }
}

// Calculate Profit Velocity (ISK/Day)
// Formula: (Average profit per unit) × (Average units sold per day)
async function calculateProfitVelocity(productTypeId, profitPerUnit, period = 30) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculateProfitVelocity] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length === 0) return 0;

    // Filter to recent period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => new Date(day.date) >= cutoffDate);
    if (recentHistory.length === 0) return 0;

    // Calculate average daily sales volume
    const totalSold = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
    const avgDailySales = totalSold / recentHistory.length;

    // Profit Velocity = profit per unit × average daily sales
    return profitPerUnit * avgDailySales;
  } catch (error) {
    console.error('Error calculating profit velocity:', error);
    return 0;
  }
}

// Calculate Market Saturation Index (MSI)
// Formula: Total Sell Volume Listed / Average Daily Sales Volume
async function calculateMarketSaturation(productTypeId, totalSellVolume, period = 30) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculateMarketSaturation] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length === 0) return 0;

    // Filter to recent period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => new Date(day.date) >= cutoffDate);
    if (recentHistory.length === 0) return 0;

    // Calculate average daily sales volume
    const totalSold = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
    const avgDailySales = totalSold / recentHistory.length;

    if (avgDailySales === 0) return 0;

    // MSI = sell orders volume / daily sales volume
    // Higher MSI = oversupply, Lower MSI = healthy demand
    return totalSellVolume / avgDailySales;
  } catch (error) {
    console.error('Error calculating market saturation:', error);
    return 0;
  }
}

// Calculate Price Momentum
// Formula: (MA_7d - MA_30d) / MA_30d
async function calculatePriceMomentum(productTypeId) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculatePriceMomentum] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length < 30) return 0; // Need at least 30 days

    // Sort by date descending (most recent first)
    const sortedHistory = [...allHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate 7-day moving average
    const last7Days = sortedHistory.slice(0, 7);
    const ma7 = last7Days.reduce((sum, day) => sum + (day.average || 0), 0) / last7Days.length;

    // Calculate 30-day moving average
    const last30Days = sortedHistory.slice(0, 30);
    const ma30 = last30Days.reduce((sum, day) => sum + (day.average || 0), 0) / last30Days.length;

    if (ma30 === 0) return 0;

    // Momentum = (MA_7d - MA_30d) / MA_30d
    // Positive = price rising, Negative = price falling
    return (ma7 - ma30) / ma30;
  } catch (error) {
    console.error('Error calculating price momentum:', error);
    return 0;
  }
}

// Calculate Profit Stability Index (PSI)
// Formula: 1 - (Standard Deviation of Weekly Margin / Average Weekly Margin)
async function calculateProfitStability(productTypeId, currentProfit, period = 28) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculateProfitStability] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length < period) return 0;

    // Get recent period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => new Date(day.date) >= cutoffDate);
    if (recentHistory.length === 0) return 0;

    // Calculate daily profit margins (approximation using price changes)
    const dailyMargins = recentHistory.map(day => day.average || 0);

    // Calculate mean and standard deviation
    const mean = dailyMargins.reduce((sum, val) => sum + val, 0) / dailyMargins.length;
    const variance = dailyMargins.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / dailyMargins.length;
    const stdDev = Math.sqrt(variance);

    if (mean === 0) return 0;

    // PSI = 1 - (StdDev / Mean)
    // Higher PSI = more stable profits
    const psi = 1 - (stdDev / mean);
    return Math.max(0, Math.min(1, psi)); // Clamp between 0 and 1
  } catch (error) {
    console.error('Error calculating profit stability:', error);
    return 0;
  }
}

// Calculate Demand Growth Rate (DGR)
// Formula: (Avg daily sales last 7 days - Avg daily sales previous 7 days) / Avg daily sales previous 7 days
async function calculateDemandGrowth(productTypeId) {
  try {
    // Validate productTypeId
    if (!productTypeId || productTypeId === 0 || isNaN(productTypeId)) {
      console.warn(`[calculateDemandGrowth] Invalid productTypeId: ${productTypeId}`);
      return 0;
    }

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length < 14) return 0; // Need at least 14 days

    // Sort by date descending (most recent first)
    const sortedHistory = [...allHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Last 7 days
    const last7Days = sortedHistory.slice(0, 7);
    const avgLast7 = last7Days.reduce((sum, day) => sum + (day.volume || 0), 0) / last7Days.length;

    // Previous 7 days (days 8-14)
    const previous7Days = sortedHistory.slice(7, 14);
    const avgPrevious7 = previous7Days.reduce((sum, day) => sum + (day.volume || 0), 0) / previous7Days.length;

    if (avgPrevious7 === 0) return 0;

    // DGR = (recent - previous) / previous
    // Positive = demand growing, Negative = demand shrinking
    return (avgLast7 - avgPrevious7) / avgPrevious7;
  } catch (error) {
    console.error('Error calculating demand growth:', error);
    return 0;
  }
}

// Calculate Material Cost Volatility (MCV)
// Formula: σ(material adjusted prices) / mean(material adjusted prices)
async function calculateMaterialCostVolatility(materials, period = 30) {
  try {
    if (!materials || Object.keys(materials).length === 0) return 0;

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    // Collect price history for all materials
    const materialPriceHistories = [];
    for (const [typeId, quantity] of Object.entries(materials)) {
      try {
        const parsedTypeId = parseInt(typeId);
        // Validate typeId before fetching
        if (!parsedTypeId || parsedTypeId === 0 || isNaN(parsedTypeId)) {
          console.warn(`[calculateMaterialCostVolatility] Invalid material typeId: ${typeId}`);
          continue;
        }

        const history = await window.electronAPI.market.fetchHistory(regionId, parsedTypeId);
        if (history && history.length > 0) {
          materialPriceHistories.push({ typeId: parsedTypeId, quantity, history });
        }
      } catch (error) {
        console.error(`Error fetching history for material ${typeId}:`, error);
      }
    }

    if (materialPriceHistories.length === 0) return 0;

    // Calculate daily total material costs
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);

    // Get all unique dates
    const allDates = new Set();
    materialPriceHistories.forEach(mph => {
      mph.history.forEach(day => {
        const dayDate = new Date(day.date);
        if (dayDate >= cutoffDate) {
          allDates.add(day.date);
        }
      });
    });

    const sortedDates = Array.from(allDates).sort();
    if (sortedDates.length < 2) return 0;

    // Calculate total material cost for each date
    const dailyCosts = sortedDates.map(date => {
      let totalCost = 0;
      materialPriceHistories.forEach(mph => {
        const dayData = mph.history.find(d => d.date === date);
        if (dayData) {
          totalCost += (dayData.average || 0) * mph.quantity;
        }
      });
      return totalCost;
    }).filter(cost => cost > 0);

    if (dailyCosts.length < 2) return 0;

    // Calculate mean and standard deviation
    const mean = dailyCosts.reduce((sum, val) => sum + val, 0) / dailyCosts.length;
    const variance = dailyCosts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / dailyCosts.length;
    const stdDev = Math.sqrt(variance);

    if (mean === 0) return 0;

    // MCV = StdDev / Mean (coefficient of variation)
    // Higher MCV = more volatile material costs
    return stdDev / mean;
  } catch (error) {
    console.error('Error calculating material cost volatility:', error);
    return 0;
  }
}

// Calculate Market Health Score (Composite Score)
// Formula: 0.3 × SVR + 0.3 × (1 - MSI) + 0.2 × Momentum + 0.2 × PSI
function calculateMarketHealthScore(svr, msi, momentum, psi) {
  try {
    // Normalize SVR to 0-1 range (cap at 2.0 for very high SVR)
    const normalizedSVR = Math.min(svr / 2.0, 1.0);

    // Normalize MSI to 0-1 range (inverse - lower is better, cap at 10 days)
    const normalizedMSI = Math.max(0, 1 - (msi / 10));

    // Normalize Momentum to 0-1 range (assuming -50% to +50% range)
    const normalizedMomentum = Math.max(0, Math.min(1, (momentum + 0.5) / 1.0));

    // PSI is already 0-1

    // Weighted composite score
    const healthScore = (0.3 * normalizedSVR) +
                       (0.3 * normalizedMSI) +
                       (0.2 * normalizedMomentum) +
                       (0.2 * psi);

    return healthScore;
  } catch (error) {
    console.error('Error calculating market health score:', error);
    return 0;
  }
}

// Determine tech level from blueprint data using metaGroupID
function determineTechLevel(blueprint) {
  const metaGroupID = blueprint.productMetaGroupID;

  // Map metaGroupID to tech level
  // Reference from invMetaGroups table:
  // 1 = Tech I, 2 = Tech II, 3 = Storyline, 4 = Faction, 14 = Tech III
  // 5 = Officer, 6 = Deadspace, 52 = Structure Faction, 53 = Structure Tech II

  switch (metaGroupID) {
    case 2:  // Tech II
    case 53: // Structure Tech II
      return 'T2';
    case 14: // Tech III
      return 'T3';
    case 3:  // Storyline
      return 'Storyline';
    case 4:  // Faction (Navy)
    case 52: // Structure Faction
      return 'Navy';
    case 5:  // Officer (Pirate)
    case 6:  // Deadspace (Pirate)
      return 'Pirate';
    case 1:  // Tech I
    case 54: // Structure Tech I
    default:
      return 'T1';
  }
}

// Map SDE categories/groups to our filter categories
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
  // This handles rigs that are in Module category but have Rig in their group name
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

  // Default to Components for anything else (covers materials, intermediate products, etc.)
  return 'Components';
}

// Sort table
function sortTable(column, direction = null) {
  if (direction === null) {
    // Toggle direction if same column
    if (currentSort.column === column) {
      direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      direction = 'desc'; // Default to descending for new column
    }
  }

  currentSort = { column, direction };

  // Update header indicators
  document.querySelectorAll('.summary-table th[data-sort]').forEach(header => {
    header.removeAttribute('data-sort-direction');
  });
  const activeHeader = document.querySelector(`.summary-table th[data-sort="${column}"]`);
  if (activeHeader) {
    activeHeader.setAttribute('data-sort-direction', direction);
  }

  // Sort the data
  calculatedData.sort((a, b) => {
    let aVal, bVal;

    switch (column) {
      case 'category':
        aVal = a.category;
        bVal = b.category;
        break;
      case 'name':
        aVal = a.itemName;
        bVal = b.itemName;
        break;
      case 'owned':
        aVal = a.isOwned ? 1 : 0;
        bVal = b.isOwned ? 1 : 0;
        break;
      case 'tech':
        aVal = a.techLevel;
        bVal = b.techLevel;
        break;
      case 'bp-type':
        aVal = a.bpType || 'N/A';
        bVal = b.bpType || 'N/A';
        break;
      case 'me':
        aVal = a.meLevel;
        bVal = b.meLevel;
        break;
      case 'te':
        aVal = a.teLevel;
        bVal = b.teLevel;
        break;
      case 'profit':
        aVal = a.profit;
        bVal = b.profit;
        break;
      case 'isk-per-hour':
        aVal = a.iskPerHour;
        bVal = b.iskPerHour;
        break;
      case 'svr':
        aVal = a.svr;
        bVal = b.svr;
        break;
      case 'total-cost':
        aVal = a.totalCost;
        bVal = b.totalCost;
        break;
      case 'roi':
        aVal = a.roi;
        bVal = b.roi;
        break;
      case 'owner':
        aVal = getCharacterName(a.ownerCharacterId) || 'N/A';
        bVal = getCharacterName(b.ownerCharacterId) || 'N/A';
        break;
      case 'location':
        aVal = a.locationName || 'N/A';
        bVal = b.locationName || 'N/A';
        break;
      case 'profit-velocity':
        aVal = a.profitVelocity || 0;
        bVal = b.profitVelocity || 0;
        break;
      case 'market-saturation':
        aVal = a.marketSaturation || 0;
        bVal = b.marketSaturation || 0;
        break;
      case 'price-momentum':
        aVal = a.priceMomentum || 0;
        bVal = b.priceMomentum || 0;
        break;
      case 'profit-stability':
        aVal = a.profitStability || 0;
        bVal = b.profitStability || 0;
        break;
      case 'demand-growth':
        aVal = a.demandGrowth || 0;
        bVal = b.demandGrowth || 0;
        break;
      case 'material-cost-volatility':
        aVal = a.materialCostVolatility || 0;
        bVal = b.materialCostVolatility || 0;
        break;
      case 'market-health-score':
        aVal = a.marketHealthScore || 0;
        bVal = b.marketHealthScore || 0;
        break;
      default:
        return 0;
    }

    if (typeof aVal === 'string') {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }

    if (direction === 'asc') {
      return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
    } else {
      return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
    }
  });

  displayResults();
}

// Display results in table
function displayResults(searchTerm = '') {
  const tbody = document.getElementById('summary-table-body');
  tbody.innerHTML = '';

  let filteredData = calculatedData;
  if (searchTerm) {
    const search = searchTerm.toLowerCase();
    filteredData = calculatedData.filter(item =>
      item.itemName.toLowerCase().includes(search) ||
      item.category.toLowerCase().includes(search) ||
      item.productName.toLowerCase().includes(search)
    );
  }

  document.getElementById('results-count').textContent = `${filteredData.length} blueprints`;

  filteredData.forEach(item => {
    const row = document.createElement('tr');

    // Add speculative-row class if this is a speculative invention
    if (item.inventionStatus === 'Speculative') {
      row.classList.add('speculative-row');
    }

    // Build row with visible columns in correct order
    row.innerHTML = visibleColumns.map(colId => getCellContent(colId, item)).join('');

    tbody.appendChild(row);
  });

  showResults();
}

// Filter and display results based on search
function filterAndDisplayResults(searchTerm) {
  displayResults(searchTerm);
}

// UI State Management
function showLoading(message) {
  const indicator = document.getElementById('loading-indicator');
  const messageEl = document.getElementById('loading-message');
  messageEl.textContent = message;
  indicator.classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-indicator').classList.add('hidden');
}

function showResults() {
  document.getElementById('results-section').classList.remove('hidden');
}

function hideResults() {
  document.getElementById('results-section').classList.add('hidden');
}

function showEmptyState() {
  document.getElementById('empty-state').classList.remove('hidden');
}

function hideEmptyState() {
  document.getElementById('empty-state').classList.add('hidden');
}

// Utility Functions
function formatISK(value) {
  if (!value || value === 0) return '0.00';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(text) {
  if (text === null || text === undefined) {
    return '';
  }
  // Convert to string if not already
  const str = String(text);
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

// Column Configuration Functions
function openColumnConfigModal() {
  const modal = document.getElementById('column-config-modal');
  const columnList = document.getElementById('column-list');

  // Build ordered column list: visible columns first (in saved order), then hidden columns
  const visibleColumnObjs = visibleColumns.map(id => ALL_COLUMNS.find(col => col.id === id)).filter(Boolean);
  const hiddenColumnObjs = ALL_COLUMNS.filter(col => !visibleColumns.includes(col.id));
  const orderedColumns = [...visibleColumnObjs, ...hiddenColumnObjs];

  // Build column list
  columnList.innerHTML = orderedColumns.map((col, index) => {
    const isVisible = visibleColumns.includes(col.id);
    const badge = col.default ? '<span class="column-badge">Default</span>' : '';

    return `
      <div class="column-item" draggable="true" data-column-id="${col.id}" data-index="${index}">
        <span class="drag-handle">☰</span>
        <input type="checkbox" class="column-checkbox" id="col-check-${col.id}" ${isVisible ? 'checked' : ''}>
        <label class="column-label" for="col-check-${col.id}">${col.label}</label>
        ${badge}
      </div>
    `;
  }).join('');

  // Setup drag and drop
  setupColumnDragAndDrop();

  modal.style.display = 'flex';
}

function closeColumnConfigModal() {
  const modal = document.getElementById('column-config-modal');
  modal.style.display = 'none';
}

function resetColumns() {
  visibleColumns = ALL_COLUMNS.filter(col => col.default).map(col => col.id);

  // Save configuration
  saveColumnConfig();

  // Update checkboxes
  ALL_COLUMNS.forEach(col => {
    const checkbox = document.getElementById(`col-check-${col.id}`);
    if (checkbox) {
      checkbox.checked = col.default;
    }
  });

  // Re-render the column list in default order
  const columnList = document.getElementById('column-list');
  columnList.innerHTML = ALL_COLUMNS.map((col, index) => {
    const isVisible = visibleColumns.includes(col.id);
    const badge = col.default ? '<span class="column-badge">Default</span>' : '';

    return `
      <div class="column-item" draggable="true" data-column-id="${col.id}" data-index="${index}">
        <span class="drag-handle">☰</span>
        <input type="checkbox" class="column-checkbox" id="col-check-${col.id}" ${isVisible ? 'checked' : ''}>
        <label class="column-label" for="col-check-${col.id}">${col.label}</label>
        ${badge}
      </div>
    `;
  }).join('');

  // Re-setup drag and drop
  setupColumnDragAndDrop();
}

function applyColumns() {
  // Get checked columns in current order
  const columnItems = document.querySelectorAll('.column-item');
  const newVisibleColumns = [];

  columnItems.forEach(item => {
    const columnId = item.getAttribute('data-column-id');
    const checkbox = item.querySelector('.column-checkbox');
    if (checkbox && checkbox.checked) {
      newVisibleColumns.push(columnId);
    }
  });

  if (newVisibleColumns.length === 0) {
    alert('You must have at least one column visible');
    return;
  }

  visibleColumns = newVisibleColumns;

  // Save configuration
  saveColumnConfig();

  // Re-render table
  renderTableHeaders();
  displayResults();

  closeColumnConfigModal();
}

function setupColumnDragAndDrop() {
  const columnItems = document.querySelectorAll('.column-item');
  let draggedItem = null;

  columnItems.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      const afterElement = getDragAfterElement(item.parentElement, e.clientY);
      if (afterElement == null) {
        item.parentElement.appendChild(draggedItem);
      } else {
        item.parentElement.insertBefore(draggedItem, afterElement);
      }
    });
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

function renderTableHeaders() {
  const thead = document.querySelector('.summary-table thead tr');
  if (!thead) return;

  thead.innerHTML = visibleColumns.map(colId => {
    const col = ALL_COLUMNS.find(c => c.id === colId);
    if (!col) return '';

    const sortAttr = col.sortable ? `data-sort="${col.id}"` : '';
    return `<th ${sortAttr}>${col.label}</th>`;
  }).join('');

  // Re-attach sorting handlers
  document.querySelectorAll('.summary-table th[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      const column = header.getAttribute('data-sort');
      sortTable(column);
    });
  });
}

function getCellContent(columnId, item) {
  const profitClass = item.profit > 0 ? 'positive' : item.profit < 0 ? 'negative' : 'neutral';
  const svrClass = item.svr >= 1 ? 'positive' : item.svr >= 0.5 ? 'neutral' : 'negative';
  const roiClass = item.roi > 0 ? 'positive' : item.roi < 0 ? 'negative' : 'neutral';

  switch (columnId) {
    case 'category':
      return `<td>${escapeHtml(item.category)}</td>`;
    case 'name':
      return `<td>${escapeHtml(item.itemName)}</td>`;
    case 'owned':
      return `<td class="text-center ${item.isOwned ? 'owned-yes' : 'owned-no'}">${item.isOwned ? 'Yes' : 'No'}</td>`;
    case 'tech':
      return `<td class="text-center">${item.techLevel}</td>`;
    case 'bp-type':
      return `<td class="text-center">${item.bpType || 'N/A'}</td>`;
    case 'me':
      return `<td class="text-center">${item.meLevel}</td>`;
    case 'te':
      return `<td class="text-center">${item.teLevel}</td>`;
    case 'profit':
      return `<td class="text-right ${profitClass}">${formatISK(item.profit)}</td>`;
    case 'isk-per-hour':
      return `<td class="text-right">${formatISK(item.iskPerHour)}</td>`;
    case 'svr':
      return `<td class="text-right ${svrClass}">${item.svr.toFixed(2)}</td>`;
    case 'total-cost':
      return `<td class="text-right">${formatISK(item.totalCost)}</td>`;
    case 'roi':
      return `<td class="text-right ${roiClass}">${item.roi.toFixed(2)}%</td>`;
    case 'owner': {
      if (!item.ownerCharacterId) {
        return '<td>N/A</td>';
      }
      const ownerName = getCharacterName(item.ownerCharacterId);
      return `<td>${escapeHtml(ownerName)}</td>`;
    }
    case 'location': {
      if (!item.locationInfo) {
        return '<td class="text-center">-</td>';
      }

      const systemName = escapeHtml(item.locationInfo.systemName);
      const fullPath = escapeHtml(item.locationInfo.fullPath);

      // Display system name with tooltip showing full path
      return `<td title="${fullPath}">${systemName}</td>`;
    }
    case 'job-costs':
      return `<td class="text-right">${formatISK(item.jobCosts || 0)}</td>`;
    case 'material-purchase-fees':
      return `<td class="text-right">${formatISK(item.materialPurchaseFees || 0)}</td>`;
    case 'product-selling-fees':
      return `<td class="text-right">${formatISK(item.productSellingFees || 0)}</td>`;
    case 'trading-fees-total':
      return `<td class="text-right">${formatISK(item.tradingFeesTotal || 0)}</td>`;
    case 'blueprint-type':
      return `<td class="text-center">${item.blueprintType || 'N/A'}</td>`;
    case 'product-market-price':
      return `<td class="text-right">${formatISK(item.productMarketPrice || 0)}</td>`;
    case 'profit-percentage':
      return `<td class="text-right ${profitClass}">${item.profitPercentage?.toFixed(2) || '0.00'}%</td>`;
    case 'manufacturing-steps':
      return `<td class="text-center">${item.manufacturingSteps || 0}</td>`;
    case 'm3-inputs':
      return `<td class="text-right">${item.m3Inputs?.toFixed(2) || '0.00'}</td>`;
    case 'm3-outputs':
      return `<td class="text-right">${item.m3Outputs?.toFixed(2) || '0.00'}</td>`;
    case 'current-sell-orders':
      return `<td class="text-right">${item.currentSellOrders?.toLocaleString() || '0'}</td>`;

    // New Market Trend Columns
    case 'profit-velocity': {
      const pvClass = (item.profitVelocity || 0) > 0 ? 'positive' : 'neutral';
      return `<td class="text-right ${pvClass}">${formatISK(item.profitVelocity || 0)}</td>`;
    }
    case 'market-saturation': {
      // Lower MSI is better (less saturated)
      const msi = item.marketSaturation || 0;
      const msiClass = msi < 3 ? 'positive' : msi < 7 ? 'neutral' : 'negative';
      return `<td class="text-right ${msiClass}">${msi.toFixed(2)}</td>`;
    }
    case 'price-momentum': {
      const momentum = item.priceMomentum || 0;
      const momentumClass = momentum > 0.05 ? 'positive' : momentum < -0.05 ? 'negative' : 'neutral';
      const momentumPct = (momentum * 100).toFixed(2);
      return `<td class="text-right ${momentumClass}">${momentumPct}%</td>`;
    }
    case 'profit-stability': {
      const psi = item.profitStability || 0;
      const psiClass = psi > 0.7 ? 'positive' : psi > 0.4 ? 'neutral' : 'negative';
      return `<td class="text-right ${psiClass}">${psi.toFixed(3)}</td>`;
    }
    case 'demand-growth': {
      const dgr = item.demandGrowth || 0;
      const dgrClass = dgr > 0.1 ? 'positive' : dgr < -0.1 ? 'negative' : 'neutral';
      const dgrPct = (dgr * 100).toFixed(2);
      return `<td class="text-right ${dgrClass}">${dgrPct}%</td>`;
    }
    case 'material-cost-volatility': {
      const mcv = item.materialCostVolatility || 0;
      const mcvClass = mcv < 0.15 ? 'positive' : mcv < 0.3 ? 'neutral' : 'negative';
      return `<td class="text-right ${mcvClass}">${mcv.toFixed(3)}</td>`;
    }
    case 'market-health-score': {
      const mhs = item.marketHealthScore || 0;
      const mhsClass = mhs > 0.7 ? 'positive' : mhs > 0.4 ? 'neutral' : 'negative';
      return `<td class="text-right ${mhsClass}">${mhs.toFixed(3)}</td>`;
    }

    // Speculative Invention Columns
    case 'invention-status': {
      if (!item.inventionStatus) return '<td class="text-center">N/A</td>';
      if (item.inventionStatus === 'Speculative') {
        return '<td class="text-center"><span class="speculative-badge">Speculative</span></td>';
      } else if (item.inventionStatus === 'Owned T2 BPC') {
        return '<td class="text-center"><span class="owned-t2-badge">Owned T2 BPC</span></td>';
      }
      return `<td class="text-center">${escapeHtml(item.inventionStatus)}</td>`;
    }
    case 'optimal-decryptor':
      return `<td>${escapeHtml(item.optimalDecryptor || 'N/A')}</td>`;
    case 'invention-probability': {
      if (!item.inventionProbability) return '<td class="text-right">N/A</td>';
      return `<td class="text-right">${(item.inventionProbability * 100).toFixed(2)}%</td>`;
    }
    case 'invention-cost-attempt':
      return `<td class="text-right">${formatISK(item.inventionCostAttempt || 0)}</td>`;
    case 'total-cost-with-invention':
      return `<td class="text-right">${formatISK(item.totalCostWithInvention || 0)}</td>`;

    default:
      return '<td>N/A</td>';
  }
}

/**
 * Check market data age and show warning if needed
 */
async function checkMarketDataAge() {
  try {
    const lastFetch = await window.electronAPI.market.getLastFetchTime();
    const warningElement = document.getElementById('market-data-warning');
    const warningText = document.getElementById('market-data-warning-text');

    if (!lastFetch) {
      // No market data fetched yet
      warningElement.classList.remove('hidden');
      warningElement.classList.add('critical');
      warningText.textContent = 'No market data available - results may be inaccurate';
      return;
    }

    const now = Date.now();
    const ageInMilliseconds = now - lastFetch;
    const ageInHours = ageInMilliseconds / (1000 * 60 * 60);
    const TWO_HOURS = 2;
    const SIX_HOURS = 6;

    if (ageInHours > SIX_HOURS) {
      // Critical warning: over 6 hours old
      warningElement.classList.remove('hidden');
      warningElement.classList.add('critical');
      const hours = Math.floor(ageInHours);
      warningText.textContent = `Market data is ${hours} hours old - prices may be significantly outdated`;
    } else if (ageInHours > TWO_HOURS) {
      // Warning: over 2 hours old
      warningElement.classList.remove('hidden');
      warningElement.classList.remove('critical');
      const hours = Math.floor(ageInHours);
      const minutes = Math.floor((ageInHours - hours) * 60);
      warningText.textContent = `Market data is ${hours}h ${minutes}m old`;
    } else {
      // Fresh data, hide warning
      warningElement.classList.add('hidden');
    }
  } catch (error) {
    console.error('Error checking market data age:', error);
  }
}
