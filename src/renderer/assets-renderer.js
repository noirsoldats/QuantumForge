// Assets window renderer script

console.log('Assets window initialized');

let currentCharacterId = null;
let characterData = null;
let characterAssets = [];
let corporationAssets = [];
let filteredAssets = [];
let assetNamesCache = {};
let currentTab = 'character'; // 'character' or 'corporation'
let cacheCheckInterval = null;

// Listen for character ID from IPC
window.electronAPI.assets.onCharacterId((characterId) => {
  console.log('Received character ID via IPC:', characterId);
  currentCharacterId = characterId;
  initializeAssetsWindow();
});

// Initialize the assets window
async function initializeAssetsWindow() {
  if (!currentCharacterId) {
    console.error('No character ID provided');
    return;
  }

  try {
    // Load character data
    characterData = await window.electronAPI.esi.getCharacter(currentCharacterId);
    console.log('Loaded character data:', characterData);

    if (!characterData) {
      console.error('Character not found');
      return;
    }

    // Update header with character info
    updateCharacterHeader();

    // Load assets for both tabs
    await loadAssets();

    // Setup event listeners
    setupEventListeners();

    // Check cache status and start monitoring
    await updateRefreshButtonState();
    startCacheMonitoring();
  } catch (error) {
    console.error('Error initializing assets window:', error);
  }
}

// Update character header
function updateCharacterHeader() {
  const portraitEl = document.getElementById('character-portrait');
  const nameEl = document.getElementById('character-name');

  if (portraitEl) {
    portraitEl.src = `${characterData.portrait}?size=128`;
    portraitEl.alt = characterData.characterName;
  }

  if (nameEl) {
    nameEl.textContent = characterData.characterName;
  }
}

// Load assets
async function loadAssets() {
  try {
    // Load character assets
    characterAssets = await window.electronAPI.assets.get(currentCharacterId, false);
    console.log('Loaded character assets:', characterAssets.length);

    // Load corporation assets if character is in a corp
    if (characterData.corporationId) {
      corporationAssets = await window.electronAPI.assets.get(currentCharacterId, true);
      console.log('Loaded corporation assets:', corporationAssets.length);
    }

    // Fetch asset names from SDE
    const allAssets = [...characterAssets, ...corporationAssets];
    const typeIds = [...new Set(allAssets.map(asset => asset.typeId))];
    assetNamesCache = await window.electronAPI.sde.getTypeNames(typeIds);
    console.log('Loaded asset names:', Object.keys(assetNamesCache).length);

    // Add asset names and resolve locations for character assets
    for (const asset of characterAssets) {
      asset.name = assetNamesCache[asset.typeId] || `Unknown Type ${asset.typeId}`;

      // Resolve location
      try {
        asset.locationInfo = await window.electronAPI.location.resolve(
          asset.locationId,
          currentCharacterId,
          false
        );
      } catch (error) {
        console.error(`Error resolving location for asset ${asset.itemId}:`, error);
        asset.locationInfo = {
          systemName: 'Unknown',
          stationName: 'Unknown',
          containerNames: [],
          fullPath: 'Unknown',
          locationType: 'error',
        };
      }
    }

    // Add asset names and resolve locations for corporation assets
    for (const asset of corporationAssets) {
      asset.name = assetNamesCache[asset.typeId] || `Unknown Type ${asset.typeId}`;

      // Resolve location
      try {
        asset.locationInfo = await window.electronAPI.location.resolve(
          asset.locationId,
          currentCharacterId,
          true
        );
      } catch (error) {
        console.error(`Error resolving location for corp asset ${asset.itemId}:`, error);
        asset.locationInfo = {
          systemName: 'Unknown',
          stationName: 'Unknown',
          containerNames: [],
          fullPath: 'Unknown',
          locationType: 'error',
        };
      }
    }

    console.log('Resolved locations for all assets');

    // Display current tab
    displayAssets();
  } catch (error) {
    console.error('Error loading assets:', error);
  }
}

// Display assets for current tab
function displayAssets() {
  const assets = currentTab === 'character' ? characterAssets : corporationAssets;
  const listId = currentTab === 'character' ? 'character-assets-list' : 'corporation-assets-list';
  const assetsList = document.getElementById(listId);

  if (!assetsList) return;

  // Apply filters
  filteredAssets = applyFilters(assets);

  // Update count
  updateAssetCount(filteredAssets.length);
  updateStats(filteredAssets);

  if (filteredAssets.length === 0) {
    assetsList.innerHTML = `
      <div class="empty-state">
        <p>No assets found.</p>
        <p style="font-size: 0.875rem; margin-top: 0.5rem;">Click "Refresh from API" to fetch ${currentTab} assets from Eve Online.</p>
      </div>
    `;
    return;
  }

  // Render asset cards
  assetsList.innerHTML = filteredAssets.map(asset => createAssetCard(asset)).join('');
}

// Create asset card HTML
function createAssetCard(asset) {
  const badges = [];

  if (asset.isBlueprintCopy || asset.typeId.toString().includes('blueprint')) {
    badges.push('<span class="asset-badge blueprint">Blueprint</span>');
  }

  // Build location display
  let locationDisplay = 'Unknown';
  if (asset.locationInfo) {
    // Show full path (Station - Container Names)
    locationDisplay = escapeHtml(asset.locationInfo.fullPath);
  }

  return `
    <div class="asset-card" data-item-id="${asset.itemId}">
      <div class="asset-header">
        <div>
          <div class="asset-name">${escapeHtml(asset.name)}</div>
          ${badges.join(' ')}
        </div>
        <div class="asset-quantity">x${formatNumber(asset.quantity)}</div>
      </div>
      <div class="asset-details">
        <div class="asset-detail"><strong>Location:</strong> ${locationDisplay}</div>
        ${asset.locationFlag ? `<div class="asset-detail"><strong>Flag:</strong> ${asset.locationFlag}</div>` : ''}
        ${asset.isSingleton ? '<div class="asset-detail"><strong>Type:</strong> Singleton</div>' : ''}
        ${asset.isBlueprintCopy ? '<div class="asset-detail"><strong>Type:</strong> Blueprint Copy</div>' : ''}
      </div>
    </div>
  `;
}

// Apply filters
function applyFilters(assets) {
  const searchTerm = document.getElementById('asset-search').value.toLowerCase();
  const showBlueprints = document.getElementById('show-blueprints').checked;
  const showShips = document.getElementById('show-ships').checked;
  const showModules = document.getElementById('show-modules').checked;

  return assets.filter(asset => {
    // Search filter
    if (searchTerm && !asset.name.toLowerCase().includes(searchTerm)) {
      return false;
    }

    // Type filters (if any are checked)
    if (showBlueprints || showShips || showModules) {
      if (showBlueprints && asset.isBlueprintCopy) return true;
      // Note: Would need category info from SDE to properly filter ships/modules
      if (showShips || showModules) return true; // Placeholder
      return false;
    }

    return true;
  });
}

// Update asset count
function updateAssetCount(count) {
  const countEl = document.getElementById('asset-count');
  if (countEl) {
    countEl.textContent = `Assets: ${formatNumber(count)}`;
  }
}

// Update statistics
function updateStats(assets) {
  const totalEl = document.getElementById('stat-total');
  const uniqueEl = document.getElementById('stat-unique');

  if (totalEl) {
    totalEl.textContent = formatNumber(assets.length);
  }

  if (uniqueEl) {
    const uniqueTypes = new Set(assets.map(a => a.typeId));
    uniqueEl.textContent = formatNumber(uniqueTypes.size);
  }
}

// Setup event listeners
function setupEventListeners() {
  // Tab switching
  const tabButtons = document.querySelectorAll('.tab-button');
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab;
      switchTab(tab);
    });
  });

  // Search and filters
  const searchInput = document.getElementById('asset-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      displayAssets();
    });
  }

  const filterCheckboxes = document.querySelectorAll('.filter-section input[type="checkbox"]');
  filterCheckboxes.forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      displayAssets();
    });
  });

  // Refresh button
  const refreshBtn = document.getElementById('refresh-assets-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', handleRefreshAssets);
  }
}

// Switch tab
function switchTab(tab) {
  currentTab = tab;

  // Update tab buttons
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `${tab}-tab-content`);
  });

  // Display assets for new tab
  displayAssets();
}

// Handle refresh assets
async function handleRefreshAssets() {
  const refreshBtn = document.getElementById('refresh-assets-btn');
  if (!refreshBtn) return;

  refreshBtn.disabled = true;
  refreshBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
    Refreshing...
  `;

  try {
    // Fetch both character and corporation assets
    await window.electronAPI.assets.fetch(currentCharacterId);

    // Reload assets
    await loadAssets();

    console.log('Assets refreshed successfully');
  } catch (error) {
    console.error('Error refreshing assets:', error);
    alert(`Failed to refresh assets: ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      Refresh from API
    `;
  }
}

// Update refresh button state based on cache
async function updateRefreshButtonState() {
  try {
    const charCacheStatus = await window.electronAPI.assets.getCacheStatus(currentCharacterId, false);
    const corpCacheStatus = await window.electronAPI.assets.getCacheStatus(currentCharacterId, true);

    const refreshBtn = document.getElementById('refresh-assets-btn');
    if (!refreshBtn) return;

    if (charCacheStatus.isCached || corpCacheStatus.isCached) {
      const earliestExpiry = Math.min(
        charCacheStatus.expiresAt || Infinity,
        corpCacheStatus.expiresAt || Infinity
      );
      const remainingSeconds = Math.max(
        charCacheStatus.remainingSeconds || 0,
        corpCacheStatus.remainingSeconds || 0
      );

      if (remainingSeconds > 0) {
        refreshBtn.title = `Cache expires in ${formatDuration(remainingSeconds)}`;
      }
    }
  } catch (error) {
    console.error('Error checking cache status:', error);
  }
}

// Start cache monitoring
function startCacheMonitoring() {
  // Update cache status every 30 seconds
  cacheCheckInterval = setInterval(updateRefreshButtonState, 30000);
}

// Utility functions
function formatNumber(num) {
  return num.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Cleanup on window close
window.addEventListener('beforeunload', () => {
  if (cacheCheckInterval) {
    clearInterval(cacheCheckInterval);
  }
});
