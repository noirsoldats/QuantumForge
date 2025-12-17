// Market Manager renderer script

console.log('Market Manager initialized');

let currentSettings = null;
let allSystems = [];
let tradeHubs = [];
let allRegions = [];
let hasUnsavedChanges = false;
let currentDefaultCharacterId = null;

// Store event listeners so they can be removed
let itemSearchClickOutsideListener = null;
let overrideSearchClickOutsideListener = null;
let characterMenuClickOutsideListener = null;

// Global error handlers
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Renderer error:', { message, source, lineno, colno, error });
  return false;
};

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// Clean up event listeners on page unload
window.addEventListener('beforeunload', () => {
  if (itemSearchClickOutsideListener) {
    document.removeEventListener('click', itemSearchClickOutsideListener);
  }
  if (overrideSearchClickOutsideListener) {
    document.removeEventListener('click', overrideSearchClickOutsideListener);
  }
  if (characterMenuClickOutsideListener) {
    document.removeEventListener('click', characterMenuClickOutsideListener);
  }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing Market Manager');
  initializeMarketManager();
});

// Listen for unsaved changes check from main process
if (window.electronAPI?.market?.onCheckUnsavedChanges) {
  window.electronAPI.market.onCheckUnsavedChanges(() => {
    // Send response back to main process
    window.electronAPI.market.sendUnsavedChangesResponse(hasUnsavedChanges);
  });
}

// Initialize the market manager
async function initializeMarketManager() {
  try {
    // Load location data
    await loadLocationData();

    // Load current settings
    await loadSettings();

    // Update last fetch time displays
    await updateLastFetchTime();
    await updateHistoryDataStatus();

    // Setup event listeners
    setupEventListeners();

    // Initialize category tree
    initializeCategoryTree();

    // Load default character avatar
    await loadDefaultCharacterAvatar();

    // Listen for default character changes
    window.electronAPI.esi.onDefaultCharacterChanged(() => {
      console.log('Default character changed, refreshing avatar...');
      loadDefaultCharacterAvatar();
      // Also update character count in footer when default character changes
      window.footerUtils.updateCharacterCount();
    });

    // Initialize status footer
    await window.footerUtils.initializeFooter();

    console.log('Market Manager initialized successfully');
  } catch (error) {
    console.error('Error initializing market manager:', error);
  }
}

// Initialize category tree expand/collapse and checkbox logic
function initializeCategoryTree() {
  // Handle expand/collapse buttons
  const expandButtons = document.querySelectorAll('.expand-btn');
  expandButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const section = btn.closest('.category-section');
      const groupList = section.querySelector('.group-list');

      btn.classList.toggle('collapsed');
      groupList.classList.toggle('collapsed');
    });
  });

  // Handle category header click (toggle expand/collapse)
  const categoryHeaders = document.querySelectorAll('.category-header');
  categoryHeaders.forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle if clicking on checkbox or expand button
      if (e.target.closest('.category-checkbox') || e.target.closest('.expand-btn')) {
        return;
      }

      const expandBtn = header.querySelector('.expand-btn');
      const groupList = header.closest('.category-section').querySelector('.group-list');

      expandBtn.classList.toggle('collapsed');
      groupList.classList.toggle('collapsed');
    });
  });

  // Handle category checkbox changes (select/deselect all groups)
  const categoryCheckboxes = document.querySelectorAll('.category-checkbox');
  categoryCheckboxes.forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const section = checkbox.closest('.category-section');
      const groupCheckboxes = section.querySelectorAll('.group-checkbox');

      groupCheckboxes.forEach(groupCheckbox => {
        groupCheckbox.checked = checkbox.checked;
      });
    });
  });

  // Handle group checkbox changes (update parent if all/none selected)
  const groupCheckboxes = document.querySelectorAll('.group-checkbox');
  groupCheckboxes.forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const section = checkbox.closest('.category-section');
      const categoryCheckbox = section.querySelector('.category-checkbox');
      const allGroupCheckboxes = section.querySelectorAll('.group-checkbox');

      const allChecked = Array.from(allGroupCheckboxes).every(cb => cb.checked);
      const noneChecked = Array.from(allGroupCheckboxes).every(cb => !cb.checked);

      if (allChecked) {
        categoryCheckbox.checked = true;
        categoryCheckbox.indeterminate = false;
      } else if (noneChecked) {
        categoryCheckbox.checked = false;
        categoryCheckbox.indeterminate = false;
      } else {
        categoryCheckbox.checked = false;
        categoryCheckbox.indeterminate = true;
      }
    });
  });
}

// Load location data from SDE
async function loadLocationData() {
  try {
    // Load trade hubs
    tradeHubs = await window.electronAPI.sde.getTradeHubs();
    populateTradeHubs();

    // Load regions
    allRegions = await window.electronAPI.sde.getAllRegions();
    populateRegions();

    // Systems will be loaded on demand via search
    console.log(`Loaded ${tradeHubs.length} trade hubs and ${allRegions.length} regions`);
  } catch (error) {
    console.error('Error loading location data:', error);
  }
}

// Populate trade hubs dropdown
function populateTradeHubs() {
  const hubSelect = document.getElementById('hub-select');
  hubSelect.innerHTML = '';

  tradeHubs.forEach(hub => {
    const option = document.createElement('option');
    option.value = hub.stationID;
    option.textContent = hub.stationName;
    hubSelect.appendChild(option);
  });
}

// Update selection status indicator
function updateSelectionStatus(statusId, textId, text) {
  const status = document.getElementById(statusId);
  const textElement = document.getElementById(textId);

  if (text) {
    textElement.textContent = text;
    status.classList.remove('hidden');
  } else {
    status.classList.add('hidden');
  }
}

// Mark as having unsaved changes
function markAsUnsaved() {
  hasUnsavedChanges = true;
  const marketApp = document.getElementById('market-app');
  if (marketApp) {
    marketApp.classList.add('has-unsaved-changes');
  }
}

// Clear unsaved changes indicator
function clearUnsavedIndicator() {
  hasUnsavedChanges = false;
  const marketApp = document.getElementById('market-app');
  if (marketApp) {
    marketApp.classList.remove('has-unsaved-changes');
  }
}

// Populate regions dropdown
function populateRegions() {
  const regionSelect = document.getElementById('region-select');
  regionSelect.innerHTML = '';

  allRegions.forEach(region => {
    const option = document.createElement('option');
    option.value = region.regionID;
    option.textContent = region.regionName;
    regionSelect.appendChild(option);
  });
}

// Handle system search
async function handleSystemSearch(searchTerm, targetSelectId) {
  if (searchTerm.length < 2) {
    return;
  }

  try {
    const systems = await window.electronAPI.sde.searchSystems(searchTerm);
    const select = document.getElementById(targetSelectId);
    select.innerHTML = '';

    if (systems.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No systems found';
      select.appendChild(option);
      return;
    }

    systems.forEach(system => {
      const option = document.createElement('option');
      option.value = system.solarSystemID;
      option.textContent = `${system.solarSystemName} (${system.security.toFixed(1)})`;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Error searching systems:', error);
  }
}

// Handle station loading for selected system
async function loadStationsForSystem(systemId) {
  const stationSelect = document.getElementById('station-select');
  stationSelect.innerHTML = '<option value="">Loading...</option>';

  try {
    const stations = await window.electronAPI.sde.getStationsInSystem(systemId);
    stationSelect.innerHTML = '';

    if (stations.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No stations in this system';
      stationSelect.appendChild(option);
      return;
    }

    stations.forEach(station => {
      const option = document.createElement('option');
      option.value = station.stationID;
      option.textContent = station.stationName;
      stationSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading stations:', error);
    stationSelect.innerHTML = '<option value="">Error loading stations</option>';
  }
}

// Handle location type switching
function handleLocationTypeChange() {
  const locationTypes = document.querySelectorAll('input[name="location-type"]');
  const selectedType = Array.from(locationTypes).find(radio => radio.checked)?.value;

  // Hide all location option contents
  document.querySelectorAll('.location-option-content').forEach(content => {
    content.style.display = 'none';
  });

  // Show the selected one
  const contentId = `${selectedType}-selection`;
  const content = document.getElementById(contentId);
  if (content) {
    content.style.display = 'block';
  }
}

// Load market settings
async function loadSettings() {
  try {
    currentSettings = await window.electronAPI.market.getSettings();
    console.log('Loaded market settings:', currentSettings);

    // Populate form with current settings
    populateSettingsForm(currentSettings);
  } catch (error) {
    console.error('Error loading market settings:', error);
  }
}

// Populate settings form with current values
function populateSettingsForm(settings) {
  // Location type and selection
  const locationType = settings.locationType || 'hub';
  const locationRadio = document.querySelector(`input[name="location-type"][value="${locationType}"]`);
  if (locationRadio) {
    locationRadio.checked = true;
  }

  // Trigger location type change to show correct section
  handleLocationTypeChange();

  // Set the appropriate location value based on type
  if (locationType === 'hub') {
    const hubSelect = document.getElementById('hub-select');
    if (hubSelect && settings.locationId) {
      hubSelect.value = settings.locationId;
      // Update status indicator
      const selectedHub = tradeHubs.find(h => h.stationID === settings.locationId);
      if (selectedHub) {
        updateSelectionStatus('hub-status', 'hub-status-text', `Selected: ${selectedHub.stationName}`);
      }
    }
  } else if (locationType === 'station') {
    // For station, we need to load the system first, then select the station
    if (settings.systemId) {
      handleSystemSearch('', 'station-system-select').then(() => {
        const stationSystemSelect = document.getElementById('station-system-select');
        if (stationSystemSelect) {
          stationSystemSelect.value = settings.systemId;
        }
        if (settings.locationId) {
          loadStationsForSystem(settings.systemId).then(() => {
            const stationSelect = document.getElementById('station-select');
            if (stationSelect) {
              stationSelect.value = settings.locationId;
              // Update status indicator
              const selectedOption = stationSelect.options[stationSelect.selectedIndex];
              if (selectedOption) {
                updateSelectionStatus('station-status', 'station-status-text', `Selected: ${selectedOption.textContent}`);
              }
            }
          });
        }
      });
    }
  } else if (locationType === 'system') {
    if (settings.systemId) {
      handleSystemSearch('', 'system-select').then(() => {
        const systemSelect = document.getElementById('system-select');
        if (systemSelect) {
          systemSelect.value = settings.systemId;
          // Update status indicator
          const selectedOption = systemSelect.options[systemSelect.selectedIndex];
          if (selectedOption) {
            updateSelectionStatus('system-status', 'system-status-text', `Selected: ${selectedOption.textContent}`);
          }
        }
      });
    }
  } else if (locationType === 'region') {
    const regionSelect = document.getElementById('region-select');
    if (regionSelect && settings.regionId) {
      regionSelect.value = settings.regionId;
      // Update status indicator
      const selectedOption = regionSelect.options[regionSelect.selectedIndex];
      if (selectedOption) {
        updateSelectionStatus('region-status', 'region-status-text', `Selected: ${selectedOption.textContent}`);
      }
    }
  }

  // Input materials
  document.getElementById('input-price-type').value = settings.inputMaterials?.priceType || 'sell';
  document.getElementById('input-price-method').value = settings.inputMaterials?.priceMethod || 'hybrid';
  document.getElementById('input-price-modifier').value = (settings.inputMaterials?.priceModifier || 1.0) * 100;
  document.getElementById('input-percentile').value = settings.inputMaterials?.percentile || 0.2;
  document.getElementById('input-min-volume').value = settings.inputMaterials?.minVolume || 1000;

  // Output products
  document.getElementById('output-price-type').value = settings.outputProducts?.priceType || 'sell';
  document.getElementById('output-price-method').value = settings.outputProducts?.priceMethod || 'hybrid';
  document.getElementById('output-price-modifier').value = (settings.outputProducts?.priceModifier || 1.0) * 100;
  document.getElementById('output-percentile').value = settings.outputProducts?.percentile || 0.2;
  document.getElementById('output-min-volume').value = settings.outputProducts?.minVolume || 1000;

  // General settings
  document.getElementById('warning-threshold').value = (settings.warningThreshold || 0.3) * 100;
}

// Get settings from form
async function getSettingsFromForm() {
  // Get selected location type
  const locationType = Array.from(document.querySelectorAll('input[name="location-type"]'))
    .find(radio => radio.checked)?.value || 'hub';

  const settings = {
    locationType,
    inputMaterials: {
      priceType: document.getElementById('input-price-type').value,
      priceMethod: document.getElementById('input-price-method').value,
      priceModifier: parseFloat(document.getElementById('input-price-modifier').value) / 100,
      percentile: parseFloat(document.getElementById('input-percentile').value),
      minVolume: parseInt(document.getElementById('input-min-volume').value),
    },
    outputProducts: {
      priceType: document.getElementById('output-price-type').value,
      priceMethod: document.getElementById('output-price-method').value,
      priceModifier: parseFloat(document.getElementById('output-price-modifier').value) / 100,
      percentile: parseFloat(document.getElementById('output-percentile').value),
      minVolume: parseInt(document.getElementById('output-min-volume').value),
    },
    warningThreshold: parseFloat(document.getElementById('warning-threshold').value) / 100,
  };

  // Get location-specific values based on type
  if (locationType === 'hub') {
    const hubSelect = document.getElementById('hub-select');
    settings.locationId = parseInt(hubSelect.value);
    // Find the selected hub to get its region and system
    const selectedHub = tradeHubs.find(h => h.stationID === settings.locationId);
    if (selectedHub) {
      settings.regionId = selectedHub.regionID;
      settings.systemId = selectedHub.systemID;
    }
  } else if (locationType === 'station') {
    const stationSystemSelect = document.getElementById('station-system-select');
    const stationSelect = document.getElementById('station-select');
    settings.systemId = parseInt(stationSystemSelect.value);
    settings.locationId = parseInt(stationSelect.value);
    // We need to look up the region for this system
    const systems = await window.electronAPI.sde.getAllSystems();
    const selectedSystem = systems.find(s => s.solarSystemID === settings.systemId);
    if (selectedSystem) {
      settings.regionId = selectedSystem.regionID;
    }
  } else if (locationType === 'system') {
    const systemSelect = document.getElementById('system-select');
    settings.systemId = parseInt(systemSelect.value);
    settings.locationId = settings.systemId;
    // Look up region for this system
    const systems = await window.electronAPI.sde.getAllSystems();
    const selectedSystem = systems.find(s => s.solarSystemID === settings.systemId);
    if (selectedSystem) {
      settings.regionId = selectedSystem.regionID;
    }
  } else if (locationType === 'region') {
    const regionSelect = document.getElementById('region-select');
    settings.regionId = parseInt(regionSelect.value);
    settings.locationId = settings.regionId;
  }

  return settings;
}

// Save settings
async function saveSettings() {
  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
      <polyline points="17 21 17 13 7 13 7 21"></polyline>
      <polyline points="7 3 7 8 15 8"></polyline>
    </svg>
    Saving...
  `;

  try {
    const settings = await getSettingsFromForm();
    console.log('Saving settings:', settings);

    const success = await window.electronAPI.market.updateSettings(settings);

    if (success) {
      console.log('Settings saved successfully');
      currentSettings = settings;

      // Clear unsaved indicator
      clearUnsavedIndicator();

      // Show success feedback
      saveBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Saved!
      `;

      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          Save Settings
        `;
      }, 2000);
    } else {
      throw new Error('Failed to save settings');
    }
  } catch (error) {
    console.error('Error saving settings:', error);
    alert('Failed to save settings: ' + error.message);

    saveBtn.disabled = false;
    saveBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
        <polyline points="17 21 17 13 7 13 7 21"></polyline>
        <polyline points="7 3 7 8 15 8"></polyline>
      </svg>
      Save Settings
    `;
  }
}

// Reset settings to defaults
async function resetSettings() {
  if (!confirm('Are you sure you want to reset all market settings to their default values?')) {
    return;
  }

  try {
    // Load default settings from main process
    const defaultSettings = {
      locationType: 'hub',
      locationId: 60003760,  // Jita 4-4
      regionId: 10000002,    // The Forge
      systemId: 30000142,    // Jita
      inputMaterials: {
        priceType: 'sell',
        priceMethod: 'hybrid',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000,
      },
      outputProducts: {
        priceType: 'sell',
        priceMethod: 'hybrid',
        priceModifier: 1.0,
        percentile: 0.2,
        minVolume: 1000,
      },
      warningThreshold: 0.3,
    };

    const success = await window.electronAPI.market.updateSettings(defaultSettings);

    if (success) {
      console.log('Settings reset to defaults');
      currentSettings = defaultSettings;
      populateSettingsForm(defaultSettings);
    } else {
      throw new Error('Failed to reset settings');
    }
  } catch (error) {
    console.error('Error resetting settings:', error);
    alert('Failed to reset settings: ' + error.message);
  }
}

// Update last fetch time display
async function updateLastFetchTime() {
  try {
    const lastFetch = await window.electronAPI.market.getLastFetchTime();
    const timeElement = document.getElementById('last-fetch-time');

    if (lastFetch) {
      const date = new Date(lastFetch);
      timeElement.textContent = date.toLocaleString();
    } else {
      timeElement.textContent = 'Never';
    }
  } catch (error) {
    console.error('Error updating last fetch time:', error);
  }
}

// Update history data status display
async function updateHistoryDataStatus() {
  try {
    const settings = await window.electronAPI.market.getSettings();
    const regionId = settings.regionId || 10000002;

    const status = await window.electronAPI.market.getHistoryDataStatus(regionId);
    const statusElement = document.getElementById('history-data-status');

    if (statusElement) {
      statusElement.textContent = `${status.upToDate}/${status.total} fully updated historical entries`;
    }
  } catch (error) {
    console.error('Error updating history data status:', error);
  }
}

// Show progress bar
function showProgressBar() {
  const progressContainer = document.getElementById('fetch-progress-container');
  progressContainer.classList.remove('hidden');
  updateProgressBar(0, 0, 0);
}

// Hide progress bar
function hideProgressBar() {
  const progressContainer = document.getElementById('fetch-progress-container');
  progressContainer.classList.add('hidden');
}

// Update progress bar
function updateProgressBar(currentPage, totalPages, progress) {
  const progressFill = document.getElementById('progress-bar-fill');
  const progressPercentage = document.getElementById('progress-percentage');
  const progressDetails = document.getElementById('progress-details-text');

  progressFill.style.width = `${progress}%`;
  progressPercentage.textContent = `${Math.round(progress)}%`;
  progressDetails.textContent = `Page ${currentPage} of ${totalPages}`;
}

// Show history progress bar
function showHistoryProgressBar() {
  const progressContainer = document.getElementById('history-progress-container');
  progressContainer.classList.remove('hidden');
  updateHistoryProgressBar(0, 0, 0);
}

// Hide history progress bar
function hideHistoryProgressBar() {
  const progressContainer = document.getElementById('history-progress-container');
  progressContainer.classList.add('hidden');
}

// Update history progress bar
function updateHistoryProgressBar(currentItem, totalItems, progress) {
  const progressFill = document.getElementById('history-progress-bar-fill');
  const progressPercentage = document.getElementById('history-progress-percentage');
  const progressDetails = document.getElementById('history-progress-details-text');

  progressFill.style.width = `${progress}%`;
  progressPercentage.textContent = `${Math.round(progress)}%`;
  progressDetails.textContent = `Item ${currentItem} of ${totalItems}`;
}

// Show error dialog with retry option
async function showErrorWithRetry(message, retryCallback) {
  return new Promise((resolve) => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    // Create modal
    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #2d2d44;
      border: 1px solid #3d3d54;
      border-radius: 8px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;

    modal.innerHTML = `
      <div style="margin-bottom: 16px;">
        <h3 style="color: #ff6b6b; margin: 0 0 12px 0; font-size: 18px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 8px;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          Update Failed
        </h3>
        <p style="color: #e0e0e0; margin: 0; line-height: 1.5;">${message}</p>
        <p style="color: #a0a0b0; margin: 12px 0 0 0; font-size: 13px;">
          The API request failed after multiple retry attempts. This could be due to network issues or ESI being temporarily unavailable.
        </p>
      </div>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="error-cancel-btn" style="
          background: transparent;
          border: 1px solid #5d5d74;
          color: #e0e0e0;
          padding: 8px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        ">Cancel</button>
        <button id="error-retry-btn" style="
          background: #4a9eff;
          border: none;
          color: white;
          padding: 8px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        ">Retry Now</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Add button styles on hover
    const retryBtn = modal.querySelector('#error-retry-btn');
    const cancelBtn = modal.querySelector('#error-cancel-btn');

    retryBtn.addEventListener('mouseenter', () => {
      retryBtn.style.background = '#3a8eef';
    });
    retryBtn.addEventListener('mouseleave', () => {
      retryBtn.style.background = '#4a9eff';
    });

    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = 'rgba(255, 255, 255, 0.05)';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'transparent';
    });

    // Handle button clicks
    retryBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve('retry');
      if (retryCallback) retryCallback();
    });

    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve('cancel');
    });

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve('cancel');
      }
    });
  });
}

// Handle manual market data refresh
async function handleMarketDataRefresh(isRetry = false) {
  const refreshBtn = document.getElementById('refresh-market-data-btn');
  refreshBtn.disabled = true;
  refreshBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
    </svg>
    ${isRetry ? 'Retrying...' : 'Updating...'}
  `;

  // Show progress bar
  showProgressBar();

  // Setup progress listener
  window.electronAPI.market.onFetchProgress((progress) => {
    updateProgressBar(progress.currentPage, progress.totalPages, progress.progress);
  });

  try {
    const settings = await window.electronAPI.market.getSettings();
    const regionId = settings.regionId || 10000002;

    // Step 1: Update market data
    const progressLabel = document.getElementById('progress-label');
    if (progressLabel) progressLabel.textContent = 'Fetching market orders...';

    const result = await window.electronAPI.market.manualRefresh(regionId);

    // Remove progress listener
    window.electronAPI.market.removeFetchProgressListener();

    if (result.success) {
      // Step 2: Update adjusted prices
      if (progressLabel) progressLabel.textContent = 'Fetching adjusted prices...';
      updateProgressBar(1, 3, 33);

      await window.electronAPI.market.refreshAdjustedPrices();

      // Step 3: Update cost indices
      if (progressLabel) progressLabel.textContent = 'Fetching system cost indices...';
      updateProgressBar(2, 3, 66);

      await window.electronAPI.costIndices.fetch();

      // Show complete state
      if (progressLabel) progressLabel.textContent = 'Update complete!';
      updateProgressBar(3, 3, 100);

      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Updated!
      `;

      await updateLastFetchTime();

      setTimeout(() => {
        hideProgressBar();
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          Update All Market Data
        `;
      }, 2000);
    } else {
      hideProgressBar();

      // Check if it's a network/timeout error and offer retry
      if (result.error && (result.error.includes('fetch failed') || result.error.includes('timeout') || result.error.includes('Failed after'))) {
        await showErrorWithRetry(result.error, () => handleMarketDataRefresh(true));
      } else {
        alert(result.error || 'Failed to update market data');
      }

      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        Update All Market Data
      `;
    }
  } catch (error) {
    console.error('Error refreshing market data:', error);
    hideProgressBar();
    window.electronAPI.market.removeFetchProgressListener();

    // Offer retry for network-related errors
    await showErrorWithRetry(
      error.message || 'An unexpected error occurred while updating market data.',
      () => handleMarketDataRefresh(true)
    );

    refreshBtn.disabled = false;
    refreshBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"></polyline>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
      </svg>
      Update All Market Data
    `;
  }
}

// Handle manual history data refresh
async function handleHistoryDataRefresh(isRetry = false) {
  const refreshBtn = document.getElementById('refresh-history-data-btn');
  refreshBtn.disabled = true;
  refreshBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
    </svg>
    ${isRetry ? 'Retrying...' : 'Updating...'}
  `;

  // Show progress bar
  showHistoryProgressBar();

  // Setup progress listener
  window.electronAPI.market.onHistoryProgress((progress) => {
    updateHistoryProgressBar(progress.currentItem, progress.totalItems, progress.progress);
  });

  try {
    const settings = await window.electronAPI.market.getSettings();
    const regionId = settings.regionId || 10000002;

    const result = await window.electronAPI.market.manualRefreshHistory(regionId);

    // Remove progress listener
    window.electronAPI.market.removeHistoryProgressListener();

    if (result.success) {
      // Show complete state
      updateHistoryProgressBar(result.itemsUpdated || 1, result.itemsUpdated || 1, 100);

      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Updated!
      `;

      await updateHistoryDataStatus();

      setTimeout(() => {
        hideHistoryProgressBar();
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3v5h5M3.05 13A9 9 0 1 0 3 12M3 4.51V8h3.49"/>
          </svg>
          Update All History Data
        `;
      }, 2000);
    } else {
      hideHistoryProgressBar();

      // Check if it's a network/timeout error and offer retry
      if (result.error && (result.error.includes('fetch failed') || result.error.includes('timeout') || result.error.includes('Failed after'))) {
        await showErrorWithRetry(result.error, () => handleHistoryDataRefresh(true));
      } else {
        alert(result.error || 'Failed to update history data');
      }

      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 3v5h5M3.05 13A9 9 0 1 0 3 12M3 4.51V8h3.49"/>
        </svg>
        Update All History Data
      `;
    }
  } catch (error) {
    console.error('Error refreshing history data:', error);
    hideHistoryProgressBar();
    window.electronAPI.market.removeHistoryProgressListener();

    // Offer retry for network-related errors
    await showErrorWithRetry(
      error.message || 'An unexpected error occurred while updating history data.',
      () => handleHistoryDataRefresh(true)
    );

    refreshBtn.disabled = false;
    refreshBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 3v5h5M3.05 13A9 9 0 1 0 3 12M3 4.51V8h3.49"/>
      </svg>
      Update All History Data
    `;
  }
}

// Setup event listeners
function setupEventListeners() {
  // Settings button
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      window.electronAPI.openSettings();
    });
  }

  // Refresh market data button
  const refreshMarketDataBtn = document.getElementById('refresh-market-data-btn');
  if (refreshMarketDataBtn) {
    refreshMarketDataBtn.addEventListener('click', handleMarketDataRefresh);
  }

  // Refresh history data button
  const refreshHistoryDataBtn = document.getElementById('refresh-history-data-btn');
  if (refreshHistoryDataBtn) {
    refreshHistoryDataBtn.addEventListener('click', handleHistoryDataRefresh);
  }

  // Tab switching
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      const currentTab = document.querySelector('.tab-content.active')?.id;

      // Only warn if switching away from settings tab with unsaved changes
      if (currentTab === 'settings-tab' && hasUnsavedChanges) {
        if (confirm('You have unsaved changes. Are you sure you want to switch tabs without saving?')) {
          switchTab(tabName);
        }
      } else {
        switchTab(tabName);
      }
    });
  });

  // Back button
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (hasUnsavedChanges) {
        if (confirm('You have unsaved changes. Are you sure you want to leave without saving?')) {
          clearUnsavedIndicator();
          window.location.href = 'index.html';
        }
      } else {
        window.location.href = 'index.html';
      }
    });
  }

  // Save button
  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveSettings);
  }

  // Reset button
  const resetBtn = document.getElementById('reset-settings-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetSettings);
  }

  // Location type radio buttons
  const locationRadios = document.querySelectorAll('input[name="location-type"]');
  locationRadios.forEach(radio => {
    radio.addEventListener('change', handleLocationTypeChange);
  });

  // System search for station selection
  const stationSystemSearch = document.getElementById('station-system-search');
  if (stationSystemSearch) {
    let searchTimeout;
    stationSystemSearch.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        handleSystemSearch(e.target.value, 'station-system-select');
      }, 300);
    });
  }

  // System search for system selection
  const systemSearch = document.getElementById('system-search');
  if (systemSearch) {
    let searchTimeout;
    systemSearch.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        handleSystemSearch(e.target.value, 'system-select');
      }, 300);
    });
  }

  // Station system selection change - load stations
  const stationSystemSelect = document.getElementById('station-system-select');
  if (stationSystemSelect) {
    stationSystemSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        loadStationsForSystem(parseInt(e.target.value));
      }
    });
  }

  // Hub selection change
  const hubSelect = document.getElementById('hub-select');
  if (hubSelect) {
    hubSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        const selectedHub = tradeHubs.find(h => h.stationID === parseInt(e.target.value));
        if (selectedHub) {
          updateSelectionStatus('hub-status', 'hub-status-text', `Selected: ${selectedHub.stationName}`);
        }
      } else {
        updateSelectionStatus('hub-status', 'hub-status-text', null);
      }
    });
  }

  // Station selection change
  const stationSelect = document.getElementById('station-select');
  if (stationSelect) {
    stationSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        const selectedOption = e.target.options[e.target.selectedIndex];
        updateSelectionStatus('station-status', 'station-status-text', `Selected: ${selectedOption.textContent}`);
      } else {
        updateSelectionStatus('station-status', 'station-status-text', null);
      }
    });
  }

  // System selection change
  const systemSelect = document.getElementById('system-select');
  if (systemSelect) {
    systemSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        const selectedOption = e.target.options[e.target.selectedIndex];
        updateSelectionStatus('system-status', 'system-status-text', `Selected: ${selectedOption.textContent}`);
      } else {
        updateSelectionStatus('system-status', 'system-status-text', null);
      }
    });
  }

  // Region selection change
  const regionSelect = document.getElementById('region-select');
  if (regionSelect) {
    regionSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        const selectedOption = e.target.options[e.target.selectedIndex];
        updateSelectionStatus('region-status', 'region-status-text', `Selected: ${selectedOption.textContent}`);
      } else {
        updateSelectionStatus('region-status', 'region-status-text', null);
      }
    });
  }

  // Track changes on all form inputs to show unsaved indicator
  // Exclude override form inputs (they're in a different section)
  const formInputs = document.querySelectorAll('#settings-tab .form-control, input[name="location-type"]');
  formInputs.forEach(input => {
    input.addEventListener('change', () => {
      markAsUnsaved();
    });
  });

  // Warn before closing window with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = ''; // Required for Chrome
      return ''; // Some browsers show this message
    }
  });
}

// Switch tabs
function switchTab(tabName) {
  // Update tab buttons
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update tab content
  const tabContents = document.querySelectorAll('.tab-content');
  tabContents.forEach(content => {
    if (content.id === `${tabName}-tab`) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });

  // Reload data when switching to Update Market Data tab
  if (tabName === 'update') {
    updateLastFetchTime();
    updateHistoryDataStatus();
  }
}

// ===== MARKET DATA VIEWER =====

let currentItem = null;
let priceChart = null;
let searchTimeout = null;

// Initialize Market Data Viewer
function initializeMarketViewer() {
  const itemSearch = document.getElementById('item-search');
  if (itemSearch) {
    itemSearch.addEventListener('input', handleItemSearch);

    // Close search results when clicking outside
    // Remove old listener first to prevent accumulation
    if (itemSearchClickOutsideListener) {
      document.removeEventListener('click', itemSearchClickOutsideListener);
    }

    itemSearchClickOutsideListener = (e) => {
      if (!e.target.closest('.search-container')) {
        hideSearchResults();
      }
    };

    document.addEventListener('click', itemSearchClickOutsideListener);
  }
}

// Handle item search input
function handleItemSearch(e) {
  clearTimeout(searchTimeout);
  const searchTerm = e.target.value.trim();

  if (searchTerm.length < 2) {
    hideSearchResults();
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const items = await window.electronAPI.sde.searchMarketItems(searchTerm);
      displaySearchResults(items);
    } catch (error) {
      console.error('Error searching items:', error);
    }
  }, 300);
}

// Display search results
function displaySearchResults(items) {
  const resultsContainer = document.getElementById('search-results');
  
  if (!items || items.length === 0) {
    resultsContainer.innerHTML = '<div class="search-result-item">No items found</div>';
    resultsContainer.classList.remove('hidden');
    return;
  }

  resultsContainer.innerHTML = items.map(item => `
    <div class="search-result-item" data-typeid="${item.typeID}">
      <div class="search-result-name">${item.typeName}</div>
      <div class="search-result-details">Type ID: ${item.typeID} | Volume: ${item.volume ? item.volume.toFixed(2) : 'N/A'} m³</div>
    </div>
  `).join('');

  // Add click handlers
  resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const typeID = parseInt(item.getAttribute('data-typeid'));
      selectItem(typeID);
    });
  });

  resultsContainer.classList.remove('hidden');
}

// Hide search results
function hideSearchResults() {
  const resultsContainer = document.getElementById('search-results');
  resultsContainer.classList.add('hidden');
}

// Select an item
async function selectItem(typeID) {
  try {
    hideSearchResults();
    
    // Get item details
    const itemDetails = await window.electronAPI.sde.getItemDetails(typeID);
    if (!itemDetails) {
      console.error('Item not found');
      return;
    }

    currentItem = itemDetails;

    // Update item display
    document.getElementById('item-name').textContent = itemDetails.typeName;

    // Process description: remove <a> tags but keep other formatting
    let description = itemDetails.description || 'No description available';
    if (description) {
      // Remove <a> tags but keep their text content
      description = description.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
      // Set as HTML to preserve other formatting like <br>, <b>, etc.
      document.getElementById('item-description').innerHTML = description;
    } else {
      document.getElementById('item-description').textContent = 'No description available';
    }

    // Show item display
    document.getElementById('item-display').classList.remove('hidden');
    
    // Load market data
    await loadMarketData(typeID);
  } catch (error) {
    console.error('Error selecting item:', error);
  }
}

// Update viewer's last fetch time display
async function updateViewerLastFetchTime() {
  try {
    const lastFetch = await window.electronAPI.market.getLastFetchTime();
    const timeElement = document.getElementById('viewer-last-fetch-time');

    if (lastFetch) {
      const date = new Date(lastFetch);
      timeElement.textContent = date.toLocaleString();
    } else {
      timeElement.textContent = 'Never';
    }
  } catch (error) {
    console.error('Error updating viewer last fetch time:', error);
  }
}

// Load market data for an item
async function loadMarketData(typeID) {
  try {
    showLoading();

    // Update last fetch time display
    await updateViewerLastFetchTime();

    // Get market settings for region and location
    const settings = await window.electronAPI.market.getSettings();
    const regionId = settings.regionId || 10000002; // Default to The Forge

    // Build location filter based on location type
    let locationFilter = null;
    if (settings.locationType === 'hub' || settings.locationType === 'station') {
      // For hub or station, filter by specific station ID
      locationFilter = { stationId: settings.locationId };
    } else if (settings.locationType === 'system') {
      // For system, filter by system ID
      locationFilter = { systemId: settings.systemId };
    }
    // For region, no additional filter needed (already filtering by regionId)

    // Fetch market data (will return cached data only)
    const [orders, history] = await Promise.all([
      window.electronAPI.market.fetchOrders(regionId, typeID, locationFilter),
      window.electronAPI.market.fetchHistory(regionId, typeID)
    ]);

    // Check if we have any data
    if ((!orders || orders.length === 0) && (!history || history.length === 0)) {
      hideLoading();
      showNoDataMessage();
      return;
    }

    // Display data
    displayOrderBook(orders);
    displayPriceChart(history);
    displayStatistics(orders, history);
    await displayPriceCalculations(orders, history, settings);

    hideLoading();
  } catch (error) {
    console.error('Error loading market data:', error);
    hideLoading();
    alert('Failed to load market data: ' + error.message);
  }
}

// Show no data message
function showNoDataMessage() {
  const buyOrdersContainer = document.getElementById('buy-orders');
  const sellOrdersContainer = document.getElementById('sell-orders');
  const statsContainer = document.getElementById('market-stats');
  const calculationsContainer = document.getElementById('price-calculations');

  const noDataHTML = '<div style="padding: 40px; text-align: center; color: #a0a0b0;"><p style="font-size: 1.1em; margin-bottom: 10px;">No market data available</p><p style="font-size: 0.9em;">Click "Update Market Data" in Market Settings to fetch data</p></div>';

  buyOrdersContainer.innerHTML = noDataHTML;
  sellOrdersContainer.innerHTML = '';
  statsContainer.innerHTML = noDataHTML;
  calculationsContainer.innerHTML = noDataHTML;

  // Clear chart
  const canvas = document.getElementById('price-chart');
  const ctx = canvas.getContext('2d');
  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#a0a0b0';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No historical data available', canvas.width / 2, canvas.height / 2);
}

// Display order book
function displayOrderBook(orders) {
  const buyOrders = orders.filter(o => o.is_buy_order).sort((a, b) => b.price - a.price).slice(0, 10);
  const sellOrders = orders.filter(o => !o.is_buy_order).sort((a, b) => a.price - b.price).slice(0, 10);
  
  const buyOrdersContainer = document.getElementById('buy-orders');
  const sellOrdersContainer = document.getElementById('sell-orders');
  
  buyOrdersContainer.innerHTML = buyOrders.length > 0 
    ? buyOrders.map(order => `
        <div class="order-item buy-order">
          <div class="order-price">${formatISK(order.price)}</div>
          <div class="order-volume">${formatNumber(order.volume_remain)} units</div>
        </div>
      `).join('')
    : '<div style="padding: 20px; text-align: center; color: #a0a0b0;">No buy orders</div>';
  
  sellOrdersContainer.innerHTML = sellOrders.length > 0
    ? sellOrders.map(order => `
        <div class="order-item sell-order">
          <div class="order-price">${formatISK(order.price)}</div>
          <div class="order-volume">${formatNumber(order.volume_remain)} units</div>
        </div>
      `).join('')
    : '<div style="padding: 20px; text-align: center; color: #a0a0b0;">No sell orders</div>';
}

// Display price chart
function displayPriceChart(history) {
  const canvas = document.getElementById('price-chart');
  const ctx = canvas.getContext('2d');
  
  // Destroy existing chart
  if (priceChart) {
    priceChart.destroy();
  }
  
  if (!history || history.length === 0) {
    ctx.fillStyle = '#a0a0b0';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No historical data available', canvas.width / 2, canvas.height / 2);
    return;
  }
  
  // Sort by date
  const sortedHistory = history.sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-90); // Last 90 days
  
  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: sortedHistory.map(h => new Date(h.date).toLocaleDateString()),
      datasets: [
        {
          label: 'Average Price',
          data: sortedHistory.map(h => h.average),
          borderColor: '#64b4ff',
          backgroundColor: 'rgba(100, 180, 255, 0.1)',
          fill: true,
          tension: 0.4
        },
        {
          label: 'Highest Price',
          data: sortedHistory.map(h => h.highest),
          borderColor: '#f44336',
          backgroundColor: 'transparent',
          borderDash: [5, 5],
          fill: false,
          tension: 0.4
        },
        {
          label: 'Lowest Price',
          data: sortedHistory.map(h => h.lowest),
          borderColor: '#4caf50',
          backgroundColor: 'transparent',
          borderDash: [5, 5],
          fill: false,
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          labels: {
            color: '#e0e0e0'
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function(context) {
              return context.dataset.label + ': ' + formatISK(context.parsed.y);
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#a0a0b0',
            maxTicksLimit: 10
          },
          grid: {
            color: 'rgba(100, 180, 255, 0.1)'
          }
        },
        y: {
          ticks: {
            color: '#a0a0b0',
            callback: function(value) {
              return formatISK(value);
            }
          },
          grid: {
            color: 'rgba(100, 180, 255, 0.1)'
          }
        }
      }
    }
  });
}

// Display statistics
function displayStatistics(orders, history) {
  const statsContainer = document.getElementById('market-stats');
  
  if (!orders || orders.length === 0) {
    statsContainer.innerHTML = '<p style="color: #a0a0b0;">No market data available</p>';
    return;
  }
  
  const sellOrders = orders.filter(o => !o.is_buy_order);
  const buyOrders = orders.filter(o => o.is_buy_order);
  
  const lowestSell = sellOrders.length > 0 ? Math.min(...sellOrders.map(o => o.price)) : 0;
  const highestBuy = buyOrders.length > 0 ? Math.max(...buyOrders.map(o => o.price)) : 0;
  
  const totalSellVolume = sellOrders.reduce((sum, o) => sum + o.volume_remain, 0);
  const totalBuyVolume = buyOrders.reduce((sum, o) => sum + o.volume_remain, 0);
  
  // Calculate trend from history
  let trend = null;
  if (history && history.length >= 2) {
    const recent = history.slice(-7); // Last 7 days
    const avgRecent = recent.reduce((sum, h) => sum + h.average, 0) / recent.length;
    const previous = history.slice(-14, -7); // Previous 7 days
    if (previous.length > 0) {
      const avgPrevious = previous.reduce((sum, h) => sum + h.average, 0) / previous.length;
      const change = ((avgRecent - avgPrevious) / avgPrevious) * 100;
      trend = {
        change: change,
        positive: change > 0
      };
    }
  }
  
  statsContainer.innerHTML = `
    <div class="stat-item">
      <div class="stat-label">Lowest Sell</div>
      <div class="stat-value">${formatISK(lowestSell)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Highest Buy</div>
      <div class="stat-value">${formatISK(highestBuy)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Spread</div>
      <div class="stat-value">${formatISK(lowestSell - highestBuy)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Total Sell Volume</div>
      <div class="stat-value">${formatNumber(totalSellVolume)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Total Buy Volume</div>
      <div class="stat-value">${formatNumber(totalBuyVolume)}</div>
    </div>
    ${trend ? `
      <div class="stat-item">
        <div class="stat-label">7-Day Trend</div>
        <div class="stat-value">${trend.positive ? '+' : ''}${trend.change.toFixed(2)}%</div>
        <div class="stat-change ${trend.positive ? 'positive' : 'negative'}">
          ${trend.positive ? '↑' : '↓'} ${Math.abs(trend.change).toFixed(2)}%
        </div>
      </div>
    ` : ''}
  `;
}

// Display price calculations for all methods
async function displayPriceCalculations(orders, history, settings) {
  const calculationsContainer = document.getElementById('price-calculations');

  if (!orders || orders.length === 0) {
    calculationsContainer.innerHTML = '<p style="color: #a0a0b0; text-align: center;">No market data available for calculations</p>';
    return;
  }

  const buyOrders = orders.filter(o => o.is_buy_order).sort((a, b) => b.price - a.price);
  const sellOrders = orders.filter(o => !o.is_buy_order).sort((a, b) => a.price - b.price);

  // Calculate default quantity (10,000 units for calculations)
  const defaultQuantity = 10000;

  // Method 1: Immediate (Lowest Sell / Highest Buy)
  const immediateBuy = sellOrders.length > 0 ? sellOrders[0].price : 0;
  const immediateSell = buyOrders.length > 0 ? buyOrders[0].price : 0;

  // Method 2: VWAP (Volume-Weighted Average Price)
  const vwapBuy = calculateVWAPPrice(sellOrders, defaultQuantity);
  const vwapSell = calculateVWAPPrice(buyOrders, defaultQuantity);

  // Method 3: Percentile (20th percentile by volume)
  // For buying from sell orders: use 20th percentile (lower prices, sorted low to high)
  // For selling to buy orders: invert to 20th percentile since buy orders are sorted high to low
  const percentileBuy = calculatePercentileMethod(sellOrders, 0.2);
  const percentileSell = calculatePercentileMethod(buyOrders, 0.2); // 20th percentile of high-to-low = high prices

  // Method 4: Historical Average
  let historicalAvg = 0;
  if (history && history.length > 0) {
    const recent = history.slice(-30); // Last 30 days
    historicalAvg = recent.reduce((sum, h) => sum + h.average, 0) / recent.length;
  }

  // Method 5: Hybrid (combination)
  const hybridBuy = vwapBuy > 0 && historicalAvg > 0 ? (vwapBuy * 0.7 + historicalAvg * 0.3) : (vwapBuy || historicalAvg);
  const hybridSell = vwapSell > 0 && historicalAvg > 0 ? (vwapSell * 0.7 + historicalAvg * 0.3) : (vwapSell || historicalAvg);

  const methods = [
    {
      name: 'Immediate',
      description: 'Instant buy/sell prices (highest buy / lowest sell)',
      buyPrice: immediateBuy,
      sellPrice: immediateSell,
      details: 'Best for instant transactions. Highest cost for buying, lowest return for selling.',
      recommended: false
    },
    {
      name: 'VWAP',
      description: 'Volume-Weighted Average Price for ' + formatNumber(defaultQuantity) + ' units',
      buyPrice: vwapBuy,
      sellPrice: vwapSell,
      details: 'Calculates actual cost by walking the order book. Good for bulk purchases.',
      recommended: false
    },
    {
      name: 'Percentile',
      description: '20th percentile by order volume (outliers filtered)',
      buyPrice: percentileBuy,
      sellPrice: percentileSell,
      details: 'Uses 20th percentile by cumulative volume after filtering extreme outliers (>95% price deviation). Provides stable pricing resistant to market manipulation.',
      recommended: false
    },
    {
      name: 'Historical Average',
      description: '30-day average from ESI history',
      buyPrice: historicalAvg,
      sellPrice: historicalAvg,
      details: 'Based on past market trends. Not affected by current market manipulation.',
      recommended: false
    },
    {
      name: 'Hybrid',
      description: 'Combination of VWAP (70%) and Historical (30%)',
      buyPrice: hybridBuy,
      sellPrice: hybridSell,
      details: 'Balanced approach using both current orders and historical data.',
      recommended: true
    }
  ];

  calculationsContainer.innerHTML = methods.map(method => `
    <div class="calculation-method${method.recommended ? ' recommended' : ''}">
      <div class="calculation-header">
        <div class="calculation-name">${method.name}</div>
        ${method.recommended ? '<span class="recommended-badge">Recommended</span>' : ''}
      </div>
      <div class="calculation-type">${method.description}</div>
      <div class="calculation-prices">
        <div class="price-row">
          <span class="price-label">Buy from Sell Orders:</span>
          <span class="price-value sell">${formatISK(method.buyPrice)}</span>
        </div>
        <div class="price-row">
          <span class="price-label">Sell to Buy Orders:</span>
          <span class="price-value buy">${formatISK(method.sellPrice)}</span>
        </div>
      </div>
      <div class="calculation-details">
        <div class="calculation-note">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          ${method.details}
        </div>
      </div>
    </div>
  `).join('');
}

// Calculate VWAP for display
function calculateVWAPPrice(orders, quantity) {
  if (!orders || orders.length === 0) return 0;

  let remainingQuantity = quantity;
  let totalCost = 0;

  for (const order of orders) {
    const volumeToUse = Math.min(remainingQuantity, order.volume_remain);
    totalCost += volumeToUse * order.price;
    remainingQuantity -= volumeToUse;

    if (remainingQuantity <= 0) break;
  }

  const filledQuantity = quantity - remainingQuantity;
  return filledQuantity > 0 ? totalCost / filledQuantity : 0;
}

// Calculate percentile-based price for display
function calculatePercentileMethod(orders, percentile) {
  if (!orders || orders.length === 0) return 0;

  // Filter out extreme outliers before calculation
  // Remove orders that are more than 95% away from the best price
  const bestPrice = orders[0]?.price || 0;
  const filteredOrders = orders.filter(order => {
    const deviation = Math.abs(order.price - bestPrice) / bestPrice;
    return deviation <= 0.95; // Keep orders within 95% of best price
  });

  // If filtering removed all orders, fall back to using just the best order
  if (filteredOrders.length === 0) {
    return bestPrice;
  }

  // Calculate cumulative volume
  let totalVolume = 0;
  const ordersWithCumulative = filteredOrders.map(order => {
    totalVolume += order.volume_remain;
    return {
      ...order,
      cumulativeVolume: totalVolume
    };
  });

  // Find price at percentile
  const targetVolume = totalVolume * percentile;
  const targetOrder = ordersWithCumulative.find(o => o.cumulativeVolume >= targetVolume);

  return targetOrder ? targetOrder.price : (filteredOrders[0]?.price || 0);
}

// Show loading indicator
function showLoading() {
  document.getElementById('loading-indicator').classList.remove('hidden');
  document.getElementById('buy-orders').innerHTML = '';
  document.getElementById('sell-orders').innerHTML = '';
  document.getElementById('market-stats').innerHTML = '';
}

// Hide loading indicator
function hideLoading() {
  document.getElementById('loading-indicator').classList.add('hidden');
}

// Format ISK currency
function formatISK(value) {
  if (!value) return '0.00 ISK';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + ' ISK';
}

// Format number
function formatNumber(value) {
  if (!value) return '0';
  return value.toLocaleString('en-US');
}

// Initialize viewer when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeMarketViewer);
} else {
  initializeMarketViewer();
}

// ===== PRICE OVERRIDES =====

let overrideSearchTimeout = null;
let selectedOverrideItem = null;
let editingOverrideTypeId = null;

// Initialize Price Overrides
function initializePriceOverrides() {
  const overrideSearch = document.getElementById('override-item-search');
  if (overrideSearch) {
    overrideSearch.addEventListener('input', handleOverrideItemSearch);

    // Close search results when clicking outside
    // Remove old listener first to prevent accumulation
    if (overrideSearchClickOutsideListener) {
      document.removeEventListener('click', overrideSearchClickOutsideListener);
    }

    overrideSearchClickOutsideListener = (e) => {
      if (!e.target.closest('.override-search-group')) {
        hideOverrideSearchResults();
      }
    };

    document.addEventListener('click', overrideSearchClickOutsideListener);
  }

  const addOverrideBtn = document.getElementById('add-override-btn');
  if (addOverrideBtn) {
    addOverrideBtn.addEventListener('click', handleAddOverride);
  }

  const cancelOverrideBtn = document.getElementById('cancel-override-btn');
  if (cancelOverrideBtn) {
    cancelOverrideBtn.addEventListener('click', resetOverrideForm);
  }

  // Load existing overrides when the tab becomes active
  const overridesTabBtn = document.querySelector('[data-tab="overrides"]');
  if (overridesTabBtn) {
    overridesTabBtn.addEventListener('click', () => {
      loadPriceOverrides();
    });
  }
}

// Handle override item search
function handleOverrideItemSearch(e) {
  clearTimeout(overrideSearchTimeout);
  const searchTerm = e.target.value.trim();

  if (searchTerm.length < 2) {
    hideOverrideSearchResults();
    return;
  }

  overrideSearchTimeout = setTimeout(async () => {
    try {
      const items = await window.electronAPI.sde.searchMarketItems(searchTerm);
      displayOverrideSearchResults(items);
    } catch (error) {
      console.error('Error searching items:', error);
    }
  }, 300);
}

// Display override search results
function displayOverrideSearchResults(items) {
  const resultsContainer = document.getElementById('override-search-results');

  if (!items || items.length === 0) {
    resultsContainer.innerHTML = '<div class="search-result-item">No items found</div>';
    resultsContainer.classList.remove('hidden');
    return;
  }

  resultsContainer.innerHTML = items.map(item => `
    <div class="search-result-item" data-typeid="${item.typeID}">
      <div class="search-result-name">${item.typeName}</div>
      <div class="search-result-details">Type ID: ${item.typeID}</div>
    </div>
  `).join('');

  // Add click handlers
  resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const typeID = parseInt(item.getAttribute('data-typeid'));
      selectOverrideItem(typeID);
    });
  });

  resultsContainer.classList.remove('hidden');
}

// Hide override search results
function hideOverrideSearchResults() {
  const resultsContainer = document.getElementById('override-search-results');
  resultsContainer.classList.add('hidden');
}

// Select an override item
async function selectOverrideItem(typeID) {
  try {
    hideOverrideSearchResults();

    // Get item details
    const itemDetails = await window.electronAPI.sde.getItemDetails(typeID);
    if (!itemDetails) {
      console.error('Item not found');
      return;
    }

    selectedOverrideItem = itemDetails;

    // Update item display
    document.getElementById('override-item-name').textContent = itemDetails.typeName;
    document.getElementById('override-item-id').textContent = `Type ID: ${itemDetails.typeID}`;

    // Fetch current market price
    try {
      const settings = await window.electronAPI.market.getSettings();
      const regionId = settings.regionId || 10000002;

      // Build location filter
      let locationFilter = null;
      if (settings.locationType === 'hub' || settings.locationType === 'station') {
        locationFilter = { stationId: settings.locationId };
      } else if (settings.locationType === 'system') {
        locationFilter = { systemId: settings.systemId };
      }

      const orders = await window.electronAPI.market.fetchOrders(regionId, typeID, locationFilter);
      const sellOrders = orders.filter(o => !o.is_buy_order).sort((a, b) => a.price - b.price);

      if (sellOrders.length > 0) {
        document.getElementById('override-current-price-value').textContent = formatISK(sellOrders[0].price);
      } else {
        document.getElementById('override-current-price-value').textContent = 'No data (refresh market data)';
      }
    } catch (error) {
      console.error('Error fetching market price:', error);
      document.getElementById('override-current-price-value').textContent = 'No data (refresh market data)';
    }

    // Check if override already exists
    const existingOverride = await window.electronAPI.market.getPriceOverride(typeID);
    if (existingOverride) {
      document.getElementById('override-price').value = existingOverride.price;
      document.getElementById('override-notes').value = existingOverride.notes || '';
    } else {
      document.getElementById('override-price').value = '';
      document.getElementById('override-notes').value = '';
    }

    // Show item details
    document.getElementById('override-item-details').classList.remove('hidden');
  } catch (error) {
    console.error('Error selecting override item:', error);
  }
}

// Handle add/update override
async function handleAddOverride() {
  if (!selectedOverrideItem) {
    alert('Please select an item first');
    return;
  }

  const price = parseFloat(document.getElementById('override-price').value);
  const notes = document.getElementById('override-notes').value.trim();

  if (!price || price <= 0) {
    alert('Please enter a valid price');
    return;
  }

  const addBtn = document.getElementById('add-override-btn');
  addBtn.disabled = true;
  addBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
    </svg>
    Saving...
  `;

  try {
    const success = await window.electronAPI.market.setPriceOverride(
      selectedOverrideItem.typeID,
      price,
      notes || null
    );

    if (success) {
      addBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Saved!
      `;

      // Reset form after short delay
      setTimeout(() => {
        resetOverrideForm();
        loadPriceOverrides();
      }, 1000);
    } else {
      throw new Error('Failed to save override');
    }
  } catch (error) {
    console.error('Error saving override:', error);
    alert('Failed to save price override: ' + error.message);

    addBtn.disabled = false;
    addBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      Add Override
    `;
  }
}

// Reset override form
function resetOverrideForm() {
  selectedOverrideItem = null;
  document.getElementById('override-item-search').value = '';
  document.getElementById('override-price').value = '';
  document.getElementById('override-notes').value = '';
  document.getElementById('override-item-details').classList.add('hidden');

  const addBtn = document.getElementById('add-override-btn');
  addBtn.disabled = false;
  addBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    Add Override
  `;
}

// Load all price overrides
async function loadPriceOverrides() {
  try {
    const overrides = await window.electronAPI.market.getAllPriceOverrides();
    displayPriceOverrides(overrides);
  } catch (error) {
    console.error('Error loading price overrides:', error);
  }
}

// Display price overrides
async function displayPriceOverrides(overrides) {
  const overridesContainer = document.getElementById('overrides-list');

  if (!overrides || overrides.length === 0) {
    overridesContainer.innerHTML = `
      <div class="overrides-empty">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="1" x2="12" y2="23"></line>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
        </svg>
        <p>No price overrides set</p>
        <span>Add an override above to get started</span>
      </div>
    `;
    return;
  }

  // Get item names for all overrides
  const typeIds = overrides.map(o => o.typeId);
  const settings = await window.electronAPI.market.getSettings();
  const regionId = settings.regionId || 10000002;

  // Fetch market prices for comparison
  const overridesWithData = await Promise.all(overrides.map(async override => {
    try {
      // Get item details
      const itemDetails = await window.electronAPI.sde.getItemDetails(override.typeId);

      // Build location filter
      let locationFilter = null;
      if (settings.locationType === 'hub' || settings.locationType === 'station') {
        locationFilter = { stationId: settings.locationId };
      } else if (settings.locationType === 'system') {
        locationFilter = { systemId: settings.systemId };
      }

      // Fetch current market price (from cache only)
      try {
        const orders = await window.electronAPI.market.fetchOrders(regionId, override.typeId, locationFilter);
        const sellOrders = orders.filter(o => !o.is_buy_order).sort((a, b) => a.price - b.price);
        const marketPrice = sellOrders.length > 0 ? sellOrders[0].price : null;

        return {
          ...override,
          itemName: itemDetails ? itemDetails.typeName : `Type ID ${override.typeId}`,
          marketPrice: marketPrice
        };
      } catch (error) {
        return {
          ...override,
          itemName: itemDetails ? itemDetails.typeName : `Type ID ${override.typeId}`,
          marketPrice: null
        };
      }
    } catch (error) {
      console.error(`Error fetching data for type ${override.typeId}:`, error);
      return {
        ...override,
        itemName: `Type ID ${override.typeId}`,
        marketPrice: null
      };
    }
  }));

  overridesContainer.innerHTML = overridesWithData.map(override => {
    const priceDiff = override.marketPrice ? ((override.price - override.marketPrice) / override.marketPrice) * 100 : null;
    const diffClass = priceDiff ? (priceDiff > 0 ? 'higher' : 'lower') : '';
    const diffText = priceDiff ? `${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(1)}%` : '';

    return `
      <div class="override-item" data-typeid="${override.typeId}">
        <div class="override-item-row">
          <div class="override-item-left">
            <div class="override-item-title">${override.itemName}</div>
            <div class="override-item-meta">
              <span>Type ID: ${override.typeId}</span>
              <span>Set: ${new Date(override.timestamp).toLocaleString()}</span>
            </div>
            ${override.notes ? `<div class="override-item-notes">${override.notes}</div>` : ''}
          </div>
          <div class="override-item-center">
            <div class="override-price-info">
              <div class="override-price-label">Override Price</div>
              <div class="override-price-value">${formatISK(override.price)}</div>
            </div>
            ${override.marketPrice ? `
              <div class="override-price-info">
                <div class="override-price-label">Market Price</div>
                <div class="override-market-value">${formatISK(override.marketPrice)}</div>
                ${priceDiff ? `<div class="override-price-diff ${diffClass}">${diffText}</div>` : ''}
              </div>
            ` : `
              <div class="override-price-info">
                <div class="override-price-label">Market Price</div>
                <div class="override-market-value" style="color: #a0a0b0; font-size: 0.85em;">No data</div>
              </div>
            `}
          </div>
          <div class="override-item-actions">
            <button class="icon-button edit-btn" title="Edit Override" data-typeid="${override.typeId}">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
            <button class="icon-button delete-btn" title="Delete Override" data-typeid="${override.typeId}">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add event listeners
  overridesContainer.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const typeId = parseInt(e.currentTarget.getAttribute('data-typeid'));
      editPriceOverride(typeId);
    });
  });

  overridesContainer.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const typeId = parseInt(e.currentTarget.getAttribute('data-typeid'));
      deletePriceOverride(typeId);
    });
  });
}

// Edit price override
async function editPriceOverride(typeId) {
  try {
    // Switch to the add override form and populate it
    const override = await window.electronAPI.market.getPriceOverride(typeId);
    if (!override) {
      alert('Override not found');
      return;
    }

    // Select the item
    await selectOverrideItem(typeId);

    // Scroll to the form
    document.querySelector('.override-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error('Error editing override:', error);
    alert('Failed to load override for editing');
  }
}

// Delete price override
async function deletePriceOverride(typeId) {
  try {
    const itemDetails = await window.electronAPI.sde.getItemDetails(typeId);
    const itemName = itemDetails ? itemDetails.typeName : `Type ID ${typeId}`;

    if (!confirm(`Are you sure you want to delete the price override for ${itemName}?`)) {
      return;
    }

    const success = await window.electronAPI.market.removePriceOverride(typeId);
    if (success) {
      loadPriceOverrides();
    } else {
      throw new Error('Failed to delete override');
    }
  } catch (error) {
    console.error('Error deleting override:', error);
    alert('Failed to delete price override: ' + error.message);
  }
}

// Initialize price overrides when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePriceOverrides);
} else {
  initializePriceOverrides();
}

// Load and display default character avatar
async function loadDefaultCharacterAvatar() {
  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();

    const avatarContainer = document.getElementById('character-avatar-container');
    const avatarBtn = document.getElementById('character-avatar-btn');
    const avatarImg = document.getElementById('character-avatar-img');
    const menuNameEl = document.getElementById('character-menu-name');

    if (!avatarContainer || !avatarBtn || !avatarImg || !menuNameEl) {
      console.error('Avatar elements not found in DOM');
      return;
    }

    if (defaultCharacter) {
      // Only update if the character has changed
      if (currentDefaultCharacterId !== defaultCharacter.characterId) {
        currentDefaultCharacterId = defaultCharacter.characterId;

        // Set avatar image
        avatarImg.src = `${defaultCharacter.portrait}?size=128`;
        avatarImg.alt = defaultCharacter.characterName;

        // Update menu header
        menuNameEl.textContent = defaultCharacter.characterName;

        // Show the avatar container
        avatarContainer.style.display = 'block';

        // Setup menu toggle
        setupCharacterMenu(defaultCharacter);

        console.log('Loaded default character avatar:', defaultCharacter.characterName);
      } else {
        console.log('Default character unchanged, skipping update');
      }
    } else {
      // No default character, hide the container
      currentDefaultCharacterId = null;
      avatarContainer.style.display = 'none';
      console.log('No default character set');
    }
  } catch (error) {
    console.error('Error loading default character avatar:', error);
  }
}

// Setup character menu toggle and handlers
function setupCharacterMenu(defaultCharacter) {
  const avatarBtn = document.getElementById('character-avatar-btn');
  const menu = document.getElementById('character-menu');
  const menuSkills = document.getElementById('menu-skills');
  const menuBlueprints = document.getElementById('menu-blueprints');
  const menuAssets = document.getElementById('menu-assets');

  if (!avatarBtn || !menu || !menuSkills || !menuBlueprints || !menuAssets) {
    console.error('Menu elements not found');
    return;
  }

  // Toggle menu on avatar click
  avatarBtn.onclick = (e) => {
    e.stopPropagation();
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
  };

  // Skills Manager handler
  menuSkills.onclick = () => {
    console.log('Opening skills window for character:', defaultCharacter.characterId);
    window.electronAPI.skills.openWindow(defaultCharacter.characterId);
    menu.style.display = 'none';
  };

  // Blueprint Manager handler
  menuBlueprints.onclick = () => {
    console.log('Opening blueprints window for character:', defaultCharacter.characterId);
    window.electronAPI.blueprints.openWindow(defaultCharacter.characterId);
    menu.style.display = 'none';
  };

  // Asset Manager handler
  menuAssets.onclick = () => {
    console.log('Opening assets window for character:', defaultCharacter.characterId);
    window.electronAPI.assets.openWindow(defaultCharacter.characterId);
    menu.style.display = 'none';
  };

  // Close menu when clicking outside
  // Remove old listener first to prevent accumulation
  if (characterMenuClickOutsideListener) {
    document.removeEventListener('click', characterMenuClickOutsideListener);
  }

  characterMenuClickOutsideListener = (e) => {
    if (!avatarBtn.contains(e.target) && !menu.contains(e.target)) {
      menu.style.display = 'none';
    }
  };

  document.addEventListener('click', characterMenuClickOutsideListener);
}
