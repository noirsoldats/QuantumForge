// Wizard State
const wizardState = {
  currentStep: 1,
  totalSteps: 8,
  sdeDownloaded: false,
  sdeVersion: null,
  characterAdded: false,
  characterId: null,
  characterName: null,
  characterPortrait: null,
  skillsFetched: false,
  blueprintsFetched: false,
  marketDataFetched: false,
  marketPricesFetched: false,
  marketHistoryFetched: false,
  costIndicesFetched: false,
  marketSettings: {
    locationType: 'hub',
    locationId: 60003760, // Jita 4-4
    regionId: 10000002, // The Forge
    systemId: 30000142, // Jita
    hubName: 'Jita 4-4',
    inputPriceType: 'sell',
    inputPricingMethod: 'hybrid',
    inputPriceModifier: 100,
    inputPercentile: 20,
    inputMinVolume: 1000,
    outputPriceType: 'sell',
    outputPricingMethod: 'hybrid',
    outputPriceModifier: 100,
    outputPercentile: 20,
    outputMinVolume: 1000,
    warningThreshold: 30,
  },
  facilityChoice: 'jita', // Always 'jita' - custom facility option removed
};

// DOM Elements
const elements = {
  // Navigation
  backBtn: document.getElementById('back-btn'),
  nextBtn: document.getElementById('next-btn'),
  skipBtn: document.getElementById('skip-btn'),

  // Steps
  steps: {
    1: document.getElementById('step-1'),
    2: document.getElementById('step-2'),
    3: document.getElementById('step-3'),
    4: document.getElementById('step-4'),
    5: document.getElementById('step-5'),
    6: document.getElementById('step-6'),
    7: document.getElementById('step-7'),
    8: document.getElementById('step-8'),
  },

  // Progress indicators
  progressSteps: document.querySelectorAll('.progress-step'),

  // Step 2: SDE
  sdeStatus: document.getElementById('sde-status'),
  sdeProgressContainer: document.getElementById('sde-progress-container'),
  sdeProgressFill: document.getElementById('sde-progress-fill'),
  sdeProgressPercent: document.getElementById('sde-progress-percent'),
  sdeProgressSize: document.getElementById('sde-progress-size'),
  sdeError: document.getElementById('sde-error'),

  // Step 3: Character
  addCharacterBtn: document.getElementById('add-character-btn'),
  noCharacterState: document.getElementById('no-character-state'),
  characterAddedState: document.getElementById('character-added-state'),
  characterPortrait: document.getElementById('character-portrait'),
  characterName: document.getElementById('character-name'),

  // Step 4: Data Fetch
  fetchSkills: document.getElementById('fetch-skills'),
  fetchBlueprints: document.getElementById('fetch-blueprints'),

  // Step 6: Market Data Fetch
  fetchMarketPrices: document.getElementById('fetch-market-prices'),
  fetchMarketHistory: document.getElementById('fetch-market-history'),
  fetchCostIndices: document.getElementById('fetch-cost-indices'),

  // Step 5: Market Settings - Location
  locationTypeRadios: document.getElementsByName('location-type'),
  hubContent: document.getElementById('hub-content'),
  stationContent: document.getElementById('station-content'),
  systemContent: document.getElementById('system-content'),
  regionContent: document.getElementById('region-content'),
  hubSelect: document.getElementById('hub-select'),
  systemSearchStation: document.getElementById('system-search-station'),
  systemResultsStation: document.getElementById('system-results-station'),
  stationSelect: document.getElementById('station-select'),
  systemSearchSystem: document.getElementById('system-search-system'),
  systemResultsSystem: document.getElementById('system-results-system'),
  regionSelect: document.getElementById('region-select'),

  // Step 5: Market Settings - Input Materials
  inputPriceTypeRadios: document.getElementsByName('input-price-type'),
  inputPricingMethod: document.getElementById('input-pricing-method'),
  inputPriceModifier: document.getElementById('input-price-modifier'),
  inputAdvancedToggle: document.getElementById('input-advanced-toggle'),
  inputAdvancedSection: document.getElementById('input-advanced-section'),
  inputPercentile: document.getElementById('input-percentile'),
  inputMinVolume: document.getElementById('input-min-volume'),

  // Step 5: Market Settings - Output Products
  outputPriceTypeRadios: document.getElementsByName('output-price-type'),
  outputPricingMethod: document.getElementById('output-pricing-method'),
  outputPriceModifier: document.getElementById('output-price-modifier'),
  outputAdvancedToggle: document.getElementById('output-advanced-toggle'),
  outputAdvancedSection: document.getElementById('output-advanced-section'),
  outputPercentile: document.getElementById('output-percentile'),
  outputMinVolume: document.getElementById('output-min-volume'),

  // Step 5: Market Settings - Warning
  warningThreshold: document.getElementById('warning-threshold'),

  // Step 7: Facility (simplified - no custom facility form)

  // Step 8: Summary
  summarySDE: document.getElementById('summary-sde'),
  summaryCharacter: document.getElementById('summary-character'),
  summaryMarket: document.getElementById('summary-market'),
  summaryFacility: document.getElementById('summary-facility'),
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  updateUI();
});

// Event Listeners
function setupEventListeners() {
  // Navigation
  elements.backBtn.addEventListener('click', () => navigateStep(-1));
  elements.nextBtn.addEventListener('click', () => handleNext());
  elements.skipBtn.addEventListener('click', () => handleSkip());

  // Step 2: SDE
  // Auto-start when entering step 2

  // Step 3: Character
  elements.addCharacterBtn.addEventListener('click', () => handleAddCharacter());

  // Step 5: Market Settings - Location Type
  elements.locationTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      handleLocationTypeChange(e.target.value);
    });
  });

  // Step 5: Market Settings - Input Materials
  elements.inputPriceTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      wizardState.marketSettings.inputPriceType = e.target.value;
    });
  });

  elements.inputPricingMethod.addEventListener('change', (e) => {
    wizardState.marketSettings.inputPricingMethod = e.target.value;
  });

  elements.inputPriceModifier.addEventListener('input', (e) => {
    wizardState.marketSettings.inputPriceModifier = parseFloat(e.target.value) || 100;
  });

  elements.inputAdvancedToggle.addEventListener('click', () => {
    toggleAdvancedSection('input');
  });

  elements.inputPercentile.addEventListener('input', (e) => {
    wizardState.marketSettings.inputPercentile = parseFloat(e.target.value) || 20;
  });

  elements.inputMinVolume.addEventListener('input', (e) => {
    wizardState.marketSettings.inputMinVolume = parseInt(e.target.value) || 1000;
  });

  // Step 5: Market Settings - Output Products
  elements.outputPriceTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      wizardState.marketSettings.outputPriceType = e.target.value;
    });
  });

  elements.outputPricingMethod.addEventListener('change', (e) => {
    wizardState.marketSettings.outputPricingMethod = e.target.value;
  });

  elements.outputPriceModifier.addEventListener('input', (e) => {
    wizardState.marketSettings.outputPriceModifier = parseFloat(e.target.value) || 100;
  });

  elements.outputAdvancedToggle.addEventListener('click', () => {
    toggleAdvancedSection('output');
  });

  elements.outputPercentile.addEventListener('input', (e) => {
    wizardState.marketSettings.outputPercentile = parseFloat(e.target.value) || 20;
  });

  elements.outputMinVolume.addEventListener('input', (e) => {
    wizardState.marketSettings.outputMinVolume = parseInt(e.target.value) || 1000;
  });

  // Step 5: Market Settings - Warning Threshold
  elements.warningThreshold.addEventListener('input', (e) => {
    wizardState.marketSettings.warningThreshold = parseFloat(e.target.value) || 30;
  });

  // Step 5: Market Settings - Location Selection
  elements.hubSelect.addEventListener('change', (e) => {
    handleHubSelection(e.target.value);
  });

  elements.systemSearchStation.addEventListener('input', (e) => {
    handleSystemSearch(e.target.value, 'station');
  });

  elements.stationSelect.addEventListener('change', (e) => {
    handleStationSelection(e.target.value);
  });

  elements.systemSearchSystem.addEventListener('input', (e) => {
    handleSystemSearch(e.target.value, 'system');
  });

  elements.regionSelect.addEventListener('change', (e) => {
    handleRegionSelection(e.target.value);
  });

  // Close autocomplete results when clicking outside
  document.addEventListener('click', (e) => {
    // Check if click is outside station search container
    if (!e.target.closest('#station-content .search-container')) {
      hideSystemResults('station');
    }
    // Check if click is outside system search container
    if (!e.target.closest('#system-content .search-container')) {
      hideSystemResults('system');
    }
  });

  // Step 7: No event listeners needed - Jita 4-4 is always used
}

// Navigation
function navigateStep(direction) {
  const newStep = wizardState.currentStep + direction;
  if (newStep < 1 || newStep > wizardState.totalSteps) return;

  // Special case: Skip step 4 if no character added
  if (newStep === 4 && !wizardState.characterAdded) {
    if (direction > 0) {
      wizardState.currentStep = 5;
    } else {
      wizardState.currentStep = 3;
    }
  } else {
    wizardState.currentStep = newStep;
  }

  updateUI();
  onStepEnter(wizardState.currentStep);
}

async function handleNext() {
  const currentStep = wizardState.currentStep;

  // Step-specific validation/actions
  if (currentStep === 1) {
    // Welcome -> SDE: Start SDE download
    navigateStep(1);
  } else if (currentStep === 2) {
    // SDE -> Character
    if (!wizardState.sdeDownloaded) {
      return; // Can't proceed without SDE
    }
    navigateStep(1);
  } else if (currentStep === 3) {
    // Character -> Data or Market
    navigateStep(1);
  } else if (currentStep === 4) {
    // Data -> Market (after fetching)
    navigateStep(1);
  } else if (currentStep === 5) {
    // Market -> Market Data (save market settings)
    await saveMarketSettings();
    navigateStep(1);
  } else if (currentStep === 6) {
    // Market Data -> Facility (after fetching complete)
    if (!wizardState.marketDataFetched) {
      return; // Can't proceed without market data
    }
    navigateStep(1);
  } else if (currentStep === 7) {
    // Facility -> Complete (create facility before advancing)
    const success = await createDefaultFacility();
    if (success) {
      navigateStep(1);
    }
    // If validation failed, stay on current step
  } else if (currentStep === 8) {
    // Complete -> Launch app
    await handleComplete();
  }
}

async function handleSkip() {
  const confirmed = confirm('Skip setup and use default settings?\n\nThis will:\n- Use Jita 4-4 for market data\n- Set up a default facility\n- Skip character authentication\n\nYou can configure these later in Settings.');

  if (confirmed) {
    try {
      // Apply defaults and mark wizard complete
      await window.electronAPI.wizard.skipSetup();
      await window.electronAPI.wizard.complete();
      // Close wizard window and launch app
      window.close();
    } catch (error) {
      console.error('Error skipping setup:', error);
      alert('Failed to skip setup. Please try again.');
    }
  }
}

async function handleComplete() {
  try {
    elements.nextBtn.disabled = true;
    elements.nextBtn.textContent = 'Launching...';

    // Mark wizard as complete
    await window.electronAPI.wizard.complete();

    // Close wizard window
    window.close();
  } catch (error) {
    console.error('Error completing wizard:', error);
    elements.nextBtn.disabled = false;
    elements.nextBtn.textContent = 'Launch Quantum Forge';
    alert('Failed to complete setup. Please try again.');
  }
}

// Step Enter Handlers
async function onStepEnter(step) {
  if (step === 2) {
    // Check if SDE already exists
    if (!wizardState.sdeDownloaded) {
      await checkAndHandleSDE();
    }
  } else if (step === 4) {
    // Auto-start character data fetch
    if (wizardState.characterAdded && !wizardState.skillsFetched) {
      await fetchCharacterData();
    }
  } else if (step === 5) {
    // Initialize market settings UI
    initializeMarketSettings();
  } else if (step === 6) {
    // Auto-start market data fetch
    if (!wizardState.marketDataFetched) {
      await fetchMarketData();
    }
  } else if (step === 8) {
    // Update summary
    updateSummary();
  }
}

// Initialize market settings when entering Step 5
function initializeMarketSettings() {
  // Load trade hubs (default location type)
  loadTradeHubs();

  // Show hub content by default
  elements.hubContent.classList.add('active');
}

// Step 2: Check for existing SDE and handle accordingly
async function checkAndHandleSDE() {
  try {
    // Check if SDE already exists
    const sdeExists = await window.electronAPI.sde.exists();

    if (sdeExists) {
      // SDE already exists, mark as downloaded and show ready state
      wizardState.sdeDownloaded = true;
      elements.sdeProgressContainer.style.display = 'none';
      elements.sdeError.style.display = 'none';
      elements.nextBtn.disabled = false;
      updateNavigationButtons();

      // Get version info if available
      let versionText = '';
      try {
        const version = await window.electronAPI.sde.getCurrentVersion();
        if (version) {
          wizardState.sdeVersion = version;
          versionText = ` (Version: ${version})`;
        }
      } catch (error) {
        // Version info not critical, ignore error
        console.log('Could not get SDE version:', error);
      }

      // Display success badge with checkmark icon
      elements.sdeStatus.innerHTML = `
        <div class="success-badge" style="margin: 20px auto; width: fit-content;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          SDE already downloaded and ready!${versionText}
        </div>
      `;
    } else {
      // SDE doesn't exist, start download
      await startSDEDownload();
    }
  } catch (error) {
    console.error('Error checking SDE:', error);
    // If check fails, proceed with download attempt
    await startSDEDownload();
  }
}

// Step 2: SDE Download
async function startSDEDownload() {
  try {
    elements.sdeStatus.textContent = 'Starting download...';
    elements.sdeProgressContainer.style.display = 'block';
    elements.sdeError.style.display = 'none';
    elements.nextBtn.disabled = true;

    // Listen for progress updates
    window.electronAPI.sde.onProgress((progress) => {
      updateSDEProgress(progress);
    });

    // Start download
    const result = await window.electronAPI.sde.downloadAndValidate();

    if (result.success) {
      wizardState.sdeDownloaded = true;
      wizardState.sdeVersion = result.version;

      // Display success message with version info
      const versionText = result.version ? ` (Version: ${result.version})` : '';
      elements.sdeStatus.innerHTML = `
        <div class="success-badge" style="margin: 20px auto; width: fit-content;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Download complete!${versionText}
        </div>
      `;

      elements.sdeProgressFill.style.width = '100%';
      elements.sdeProgressPercent.textContent = '100%';
      elements.nextBtn.disabled = false;
      // Update button text to "Next"
      updateNavigationButtons();
    } else {
      throw new Error(result.error || 'Download failed');
    }
  } catch (error) {
    console.error('SDE download error:', error);
    elements.sdeError.textContent = `Error: ${error.message}. Please try again.`;
    elements.sdeError.style.display = 'block';
    elements.sdeStatus.textContent = 'Download failed';

    // Show retry in next button
    elements.nextBtn.textContent = 'Retry Download';
    elements.nextBtn.disabled = false;
    elements.nextBtn.onclick = () => {
      elements.nextBtn.textContent = 'Next';
      elements.nextBtn.onclick = null;
      startSDEDownload();
    };
  }
}

function updateSDEProgress(progress) {
  const percent = Math.round(progress.percent || 0);
  elements.sdeProgressFill.style.width = `${percent}%`;
  elements.sdeProgressPercent.textContent = `${percent}%`;

  if (progress.downloadedMB && progress.totalMB) {
    elements.sdeProgressSize.textContent = `${progress.downloadedMB} MB / ${progress.totalMB} MB`;
  }

  if (progress.message) {
    elements.sdeStatus.textContent = progress.message;
  }
}

// Step 3: Add Character
async function handleAddCharacter() {
  try {
    elements.addCharacterBtn.disabled = true;
    elements.addCharacterBtn.textContent = 'Opening browser...';

    const result = await window.electronAPI.esi.authenticate();

    if (result.success && result.character) {
      wizardState.characterAdded = true;
      wizardState.characterId = result.character.characterId;
      wizardState.characterName = result.character.characterName;
      wizardState.characterPortrait = result.character.portrait;

      // Update UI
      elements.noCharacterState.style.display = 'none';
      elements.characterAddedState.style.display = 'flex';
      elements.characterPortrait.style.backgroundImage = `url(${result.character.portrait})`;
      elements.characterName.textContent = result.character.characterName;

      elements.nextBtn.disabled = false;
      // Update button text to "Next"
      updateNavigationButtons();
    } else {
      throw new Error(result.error || 'Authentication failed');
    }
  } catch (error) {
    console.error('Character authentication error:', error);
    alert(`Failed to add character: ${error.message}\n\nYou can skip this step and add a character later.`);
    elements.addCharacterBtn.disabled = false;
    elements.addCharacterBtn.textContent = 'Add Character';
  }
}

// Step 4: Fetch Character Data
async function fetchCharacterData() {
  let skillsFailed = false;
  let blueprintsFailed = false;

  // Fetch skills
  try {
    updateFetchStatus('skills', 'in-progress', 'Fetching...');
    const skillsResult = await window.electronAPI.skills.fetch(wizardState.characterId);

    if (skillsResult.success) {
      wizardState.skillsFetched = true;
      updateFetchStatus('skills', 'completed', 'Complete');
    } else {
      throw new Error(skillsResult.error || 'Skills fetch failed');
    }
  } catch (error) {
    console.error('Skills fetch error:', error);
    skillsFailed = true;
    updateFetchStatus('skills', 'error', 'Failed (can retry later)');
  }

  // Fetch blueprints
  try {
    updateFetchStatus('blueprints', 'in-progress', 'Fetching...');
    const blueprintsResult = await window.electronAPI.blueprints.fetch(wizardState.characterId);

    if (blueprintsResult.success) {
      wizardState.blueprintsFetched = true;
      updateFetchStatus('blueprints', 'completed', 'Complete');
    } else {
      throw new Error(blueprintsResult.error || 'Blueprints fetch failed');
    }
  } catch (error) {
    console.error('Blueprints fetch error:', error);
    blueprintsFailed = true;
    updateFetchStatus('blueprints', 'error', 'Failed (can retry later)');
  }

  // Enable next button (allow proceeding even if fetches failed)
  elements.nextBtn.disabled = false;

  // Show summary message if any failed
  if (skillsFailed || blueprintsFailed) {
    const failedItems = [];
    if (skillsFailed) failedItems.push('skills');
    if (blueprintsFailed) failedItems.push('blueprints');

    alert(`Unable to fetch ${failedItems.join(' and ')} from Eve Online ESI.\n\nThis is likely a temporary server issue. You can continue setup and refresh this data later in the app.`);
  }
}

function updateFetchStatus(type, state, statusText) {
  let element;
  if (type === 'skills') element = elements.fetchSkills;
  else if (type === 'blueprints') element = elements.fetchBlueprints;
  else if (type === 'market-prices') element = elements.fetchMarketPrices;
  else if (type === 'market-history') element = elements.fetchMarketHistory;
  else if (type === 'cost-indices') element = elements.fetchCostIndices;

  const statusElement = element.querySelector('.fetch-status');

  element.className = 'fetch-item';
  if (state === 'in-progress' || state === 'completed' || state === 'error') {
    element.classList.add(state);
  }

  statusElement.textContent = statusText;
}

// Step 6: Fetch Market Data
async function fetchMarketData() {
  const { regionId } = wizardState.marketSettings;

  elements.nextBtn.disabled = true;

  // Fetch Market Prices FIRST (required for adjusted market prices data)
  try {
    updateFetchStatus('market-prices', 'in-progress', 'Fetching market orders...');

    // Listen for progress updates
    window.electronAPI.market.onFetchProgress((progress) => {
      updateFetchStatus('market-prices', 'in-progress',
        `Fetching page ${progress.currentPage}/${progress.totalPages}...`);
    });

    const result = await window.electronAPI.market.manualRefresh(regionId);
    window.electronAPI.market.removeFetchProgressListener();

    if (result.success) {
      wizardState.marketPricesFetched = true;
      updateFetchStatus('market-prices', 'completed', 'Complete');
    } else {
      throw new Error(result.error || 'Failed to fetch market prices');
    }
  } catch (error) {
    console.error('Market prices fetch error:', error);
    window.electronAPI.market.removeFetchProgressListener();
    updateFetchStatus('market-prices', 'error', 'Failed (can retry later)');
    wizardState.marketPricesFetched = false;
  }

  // Fetch Market Adjusted Prices (independent of market prices)
  try {
    updateFetchStatus('market-history', 'in-progress', 'Fetching adjusted prices...');

    const result = await window.electronAPI.market.refreshAdjustedPrices();

    if (result.success) {
      wizardState.marketHistoryFetched = true;
      updateFetchStatus('market-history', 'completed',
        `Complete (${result.itemsUpdated} items)`);
    } else {
      throw new Error(result.error || 'Failed to fetch adjusted prices');
    }
  } catch (error) {
    console.error('Adjusted prices fetch error:', error);
    updateFetchStatus('market-history', 'error', 'Failed (can retry later)');
  }

  // Fetch Cost Indices
  try {
    updateFetchStatus('cost-indices', 'in-progress', 'Fetching cost indices...');
    const result = await window.electronAPI.costIndices.fetch();

    if (result.success) {
      wizardState.costIndicesFetched = true;
      updateFetchStatus('cost-indices', 'completed',
        `Complete (${result.systemCount} systems)`);
    } else {
      throw new Error(result.error || 'Failed to fetch cost indices');
    }
  } catch (error) {
    console.error('Cost indices fetch error:', error);
    updateFetchStatus('cost-indices', 'error', 'Failed (can retry later)');
  }

  // Enable next button (allow proceeding even if some fetches failed)
  wizardState.marketDataFetched = true;
  elements.nextBtn.disabled = false;
  updateNavigationButtons();

  // Show summary message if any failed
  const failedItems = [];
  if (!wizardState.marketPricesFetched) failedItems.push('market prices');
  if (!wizardState.marketHistoryFetched) failedItems.push('adjusted prices');
  if (!wizardState.costIndicesFetched) failedItems.push('cost indices');

  if (failedItems.length > 0) {
    alert(`Unable to fetch ${failedItems.join(', ')}.\n\nThis may be due to ESI server issues. You can continue setup and refresh this data later in the Market Manager.`);
  }
}

// Step 5: Market Settings Handlers

// Load trade hubs dropdown
async function loadTradeHubs() {
  try {
    const hubs = await window.electronAPI.sde.getTradeHubs();
    elements.hubSelect.innerHTML = '<option value="">Select a trade hub...</option>';

    let jitaHub = null;

    hubs.forEach(hub => {
      const option = document.createElement('option');
      option.value = hub.stationID;  // Fixed: capital ID
      option.textContent = hub.stationName;
      option.setAttribute('data-region-id', hub.regionID);  // Fixed: capital ID
      option.setAttribute('data-system-id', hub.systemID);  // Fixed: capital ID

      // Select Jita 4-4 by default
      if (hub.stationID === 60003760) {  // Fixed: capital ID
        option.selected = true;
        jitaHub = hub;
      }

      elements.hubSelect.appendChild(option);
    });

    // If Jita was found and selected, update state immediately
    if (jitaHub) {
      wizardState.marketSettings.locationType = 'hub';
      wizardState.marketSettings.locationId = jitaHub.stationID;  // Fixed: capital ID
      wizardState.marketSettings.regionId = jitaHub.regionID;  // Fixed: capital ID
      wizardState.marketSettings.systemId = jitaHub.systemID;  // Fixed: capital ID
      wizardState.marketSettings.hubName = jitaHub.stationName;
    }
  } catch (error) {
    console.error('Error loading trade hubs:', error);
  }
}

// Load regions dropdown
async function loadRegions() {
  try {
    const regions = await window.electronAPI.sde.getAllRegions();
    elements.regionSelect.innerHTML = '<option value="">Select a region...</option>';

    regions.forEach(region => {
      const option = document.createElement('option');
      option.value = region.regionId;
      option.textContent = region.regionName;
      elements.regionSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading regions:', error);
  }
}

// Debounce timer for system search
let systemSearchTimer = null;

// Handle system search with 300ms debounce (autocomplete style)
function handleSystemSearch(searchTerm, context) {
  console.log('handleSystemSearch called:', searchTerm, context);

  // Clear previous timer
  if (systemSearchTimer) {
    clearTimeout(systemSearchTimer);
  }

  const resultsContainer = context === 'station' ? elements.systemResultsStation : elements.systemResultsSystem;

  // Don't search if less than 2 characters
  if (searchTerm.length < 2) {
    hideSystemResults(context);
    return;
  }

  // Debounce search
  systemSearchTimer = setTimeout(async () => {
    try {
      console.log('Searching for systems:', searchTerm);
      const systems = await window.electronAPI.sde.searchSystems(searchTerm);
      console.log('Found systems:', systems.length);

      displaySystemResults(systems, context);
    } catch (error) {
      console.error('Error searching systems:', error);
      resultsContainer.innerHTML = '<div class="search-result-item no-results">Error searching systems</div>';
      resultsContainer.classList.remove('hidden');
    }
  }, 300);
}

// Display system search autocomplete results
function displaySystemResults(systems, context) {
  const resultsContainer = context === 'station' ? elements.systemResultsStation : elements.systemResultsSystem;

  if (!systems || systems.length === 0) {
    resultsContainer.innerHTML = '<div class="search-result-item no-results">No systems found</div>';
    resultsContainer.classList.remove('hidden');
    return;
  }

  // Limit to 20 results
  const limitedSystems = systems.slice(0, 20);

  resultsContainer.innerHTML = limitedSystems.map(system => `
    <div class="search-result-item" data-system-id="${system.solarSystemID}" data-region-id="${system.regionID}" data-system-name="${system.solarSystemName}">
      <div class="search-result-name">${system.solarSystemName}</div>
      <div class="search-result-details">Security: ${system.security ? system.security.toFixed(1) : '?'}</div>
    </div>
  `).join('');

  // Add click handlers
  resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
    if (!item.classList.contains('no-results')) {
      item.addEventListener('click', () => {
        const systemId = parseInt(item.getAttribute('data-system-id'));
        const regionId = parseInt(item.getAttribute('data-region-id'));
        const systemName = item.getAttribute('data-system-name');
        selectSystem(systemId, regionId, systemName, context);
      });
    }
  });

  resultsContainer.classList.remove('hidden');
}

// Hide system search results
function hideSystemResults(context) {
  const resultsContainer = context === 'station' ? elements.systemResultsStation : elements.systemResultsSystem;
  resultsContainer.classList.add('hidden');
}

// Select a system from autocomplete
async function selectSystem(systemId, regionId, systemName, context) {
  console.log('System selected:', systemId, systemName, context);

  // Update state
  wizardState.marketSettings.systemId = systemId;
  wizardState.marketSettings.regionId = regionId;

  // Update search input with selected system name
  const searchInput = context === 'station' ? elements.systemSearchStation : elements.systemSearchSystem;
  searchInput.value = systemName;

  // Hide results
  hideSystemResults(context);

  // If context is station, load stations for this system
  if (context === 'station') {
    await loadStationsForSystem(systemId);
  }
}


// Load stations for selected system
async function loadStationsForSystem(systemId) {
  try {
    elements.stationSelect.innerHTML = '<option value="">Loading stations...</option>';
    elements.stationSelect.disabled = true;

    const stations = await window.electronAPI.sde.getStationsInSystem(systemId);

    elements.stationSelect.innerHTML = '<option value="">Select a station...</option>';

    if (stations.length === 0) {
      const option = document.createElement('option');
      option.textContent = 'No stations in this system';
      option.disabled = true;
      elements.stationSelect.appendChild(option);
    } else {
      stations.forEach(station => {
        const option = document.createElement('option');
        option.value = station.stationId;
        option.textContent = station.stationName;
        elements.stationSelect.appendChild(option);
      });
      elements.stationSelect.disabled = false;
    }
  } catch (error) {
    console.error('Error loading stations:', error);
    elements.stationSelect.innerHTML = '<option value="">Error loading stations</option>';
  }
}

// Handle hub selection
function handleHubSelection(stationId) {
  if (!stationId) return;

  const selectedOption = elements.hubSelect.options[elements.hubSelect.selectedIndex];
  const regionId = selectedOption.getAttribute('data-region-id');
  const systemId = selectedOption.getAttribute('data-system-id');

  wizardState.marketSettings.locationType = 'hub';
  wizardState.marketSettings.locationId = parseInt(stationId);
  wizardState.marketSettings.regionId = parseInt(regionId);
  wizardState.marketSettings.systemId = parseInt(systemId);
  wizardState.marketSettings.hubName = selectedOption.textContent;
}

// Handle station selection
function handleStationSelection(stationId) {
  if (!stationId) return;

  wizardState.marketSettings.locationType = 'station';
  wizardState.marketSettings.locationId = parseInt(stationId);
}

// Handle region selection
function handleRegionSelection(regionId) {
  if (!regionId) return;

  wizardState.marketSettings.locationType = 'region';
  wizardState.marketSettings.regionId = parseInt(regionId);
  wizardState.marketSettings.locationId = null; // No specific location for region
}

// Handle location type change (hub/station/system/region)
function handleLocationTypeChange(locationType) {
  wizardState.marketSettings.locationType = locationType;

  // Hide all location content areas
  elements.hubContent.classList.remove('active');
  elements.stationContent.classList.remove('active');
  elements.systemContent.classList.remove('active');
  elements.regionContent.classList.remove('active');

  // Show the selected location content area
  switch (locationType) {
    case 'hub':
      elements.hubContent.classList.add('active');
      if (elements.hubSelect.options.length <= 1) {
        loadTradeHubs();
      }
      break;
    case 'station':
      elements.stationContent.classList.add('active');
      break;
    case 'system':
      elements.systemContent.classList.add('active');
      break;
    case 'region':
      elements.regionContent.classList.add('active');
      if (elements.regionSelect.options.length <= 1) {
        loadRegions();
      }
      break;
  }
}

// Toggle advanced options sections
function toggleAdvancedSection(section) {
  if (section === 'input') {
    const isOpen = elements.inputAdvancedSection.classList.toggle('open');
    elements.inputAdvancedToggle.classList.toggle('open', isOpen);
  } else if (section === 'output') {
    const isOpen = elements.outputAdvancedSection.classList.toggle('open');
    elements.outputAdvancedToggle.classList.toggle('open', isOpen);
  }
}

// Step 5: Save Market Settings
async function saveMarketSettings() {
  try {
    const marketSettings = {
      // Location settings
      locationType: wizardState.marketSettings.locationType,
      locationId: wizardState.marketSettings.locationId,
      regionId: wizardState.marketSettings.regionId,
      systemId: wizardState.marketSettings.systemId,

      // Input materials settings
      inputMaterials: {
        priceType: wizardState.marketSettings.inputPriceType,
        priceMethod: wizardState.marketSettings.inputPricingMethod,
        priceModifier: wizardState.marketSettings.inputPriceModifier / 100, // Convert from percentage
        percentile: wizardState.marketSettings.inputPercentile / 100, // Convert from percentage
        minVolume: wizardState.marketSettings.inputMinVolume,
      },

      // Output products settings
      outputProducts: {
        priceType: wizardState.marketSettings.outputPriceType,
        priceMethod: wizardState.marketSettings.outputPricingMethod,
        priceModifier: wizardState.marketSettings.outputPriceModifier / 100, // Convert from percentage
        percentile: wizardState.marketSettings.outputPercentile / 100, // Convert from percentage
        minVolume: wizardState.marketSettings.outputMinVolume,
      },

      warningThreshold: wizardState.marketSettings.warningThreshold / 100, // Convert from percentage
    };

    const result = await window.electronAPI.market.updateSettings(marketSettings);

    if (!result) {
      console.warn('Failed to save market settings');
    }
  } catch (error) {
    console.error('Error saving market settings:', error);
    // Non-critical - settings will use defaults
  }
}

// Step 7: Create Default Jita 4-4 Facility
async function createDefaultFacility() {
  try {
    const facility = {
      name: 'Jita 4-4 NPC Station',
      usage: 'default',
      facilityType: 'station',
      regionId: 10000002,
      systemId: 30000142,
      structureTypeId: null,
      rigs: []
    };

    const result = await window.electronAPI.facilities.addFacility(facility);

    // If addFacility returns a facility object with an id, it succeeded
    // The API returns the created facility object, not { success: true }
    if (!result || !result.id) {
      console.warn('Failed to create facility: Invalid response');
      alert(`Failed to create facility.\n\nYou can add a facility later in the Facilities section.`);
      // Non-critical - allow proceeding
    }

    return true; // Allow proceeding to next step
  } catch (error) {
    console.error('Error creating facility:', error);
    alert(`Error creating facility: ${error.message}\n\nYou can add a facility later in the Facilities section.`);
    // Non-critical - allow proceeding
    return true; // Allow proceeding even if facility creation failed
  }
}

// Step 7: Update Summary
function updateSummary() {
  // SDE
  if (wizardState.sdeDownloaded) {
    elements.summarySDE.textContent = wizardState.sdeVersion ?
      `Downloaded (${wizardState.sdeVersion})` :
      'Downloaded';
  }

  // Character
  if (wizardState.characterAdded) {
    elements.summaryCharacter.textContent = wizardState.characterName;
  } else {
    elements.summaryCharacter.textContent = 'Not added (can add later)';
    elements.summaryCharacter.style.color = '#b0b0c0';
  }

  // Market - show the location the user selected
  if (wizardState.marketSettings) {
    if (wizardState.marketSettings.hubName) {
      // Trade hub selected
      elements.summaryMarket.textContent = wizardState.marketSettings.hubName;
    } else if (wizardState.marketSettings.locationType) {
      // Other location type selected
      const locationTypeLabels = {
        'station': 'Specific Station',
        'system': 'Solar System',
        'region': 'Entire Region'
      };
      elements.summaryMarket.textContent = locationTypeLabels[wizardState.marketSettings.locationType] || 'Configured';
    } else {
      elements.summaryMarket.textContent = 'Not configured';
    }
  } else {
    elements.summaryMarket.textContent = 'Not configured';
  }

  // Facility - always Jita 4-4
  elements.summaryFacility.textContent = 'Jita 4-4 NPC Station';
}

// UI Updates
function updateUI() {
  const step = wizardState.currentStep;

  // Update step visibility
  Object.keys(elements.steps).forEach(stepNum => {
    const stepEl = elements.steps[stepNum];
    if (parseInt(stepNum) === step) {
      stepEl.classList.add('active');
    } else {
      stepEl.classList.remove('active');
    }
  });

  // Update progress indicator
  elements.progressSteps.forEach((progressStep, index) => {
    const stepNum = index + 1;
    progressStep.classList.remove('active', 'completed');

    if (stepNum === step) {
      progressStep.classList.add('active');
    } else if (stepNum < step) {
      progressStep.classList.add('completed');
    }
  });

  // Update navigation buttons
  updateNavigationButtons();
}

function updateNavigationButtons() {
  const step = wizardState.currentStep;

  // Back button
  if (step === 1 || step === 2) {
    elements.backBtn.style.display = 'none';
  } else {
    elements.backBtn.style.display = 'inline-block';
  }

  // Next button text
  if (step === 8) {
    elements.nextBtn.textContent = 'Launch Quantum Forge';
  } else if (step === 3) {
    elements.nextBtn.textContent = wizardState.characterAdded ? 'Next' : 'Skip Character';
  } else if (step === 2) {
    elements.nextBtn.textContent = wizardState.sdeDownloaded ? 'Next' : 'Downloading...';
    elements.nextBtn.disabled = !wizardState.sdeDownloaded;
  } else if (step === 6) {
    elements.nextBtn.textContent = wizardState.marketDataFetched ? 'Next' : 'Fetching...';
    elements.nextBtn.disabled = !wizardState.marketDataFetched;
  } else {
    elements.nextBtn.textContent = 'Next';
    elements.nextBtn.disabled = false;
  }

  // Skip button
  if (step === 8) {
    elements.skipBtn.style.display = 'none';
  } else {
    elements.skipBtn.style.display = 'inline-block';
  }
}

// Error handling for unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});
