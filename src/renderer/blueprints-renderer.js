// Blueprints window renderer script

console.log('Blueprints window initialized');

let currentCharacterId = null;
let characterData = null;
let allBlueprints = [];
let filteredBlueprints = [];
let blueprintNamesCache = {};
let cacheCheckInterval = null;

// Listen for character ID from IPC
window.electronAPI.blueprints.onCharacterId((characterId) => {
  console.log('Received character ID via IPC:', characterId);
  currentCharacterId = characterId;
  initializeBlueprintsWindow();
});

// Initialize the blueprints window
async function initializeBlueprintsWindow() {
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

    // Load blueprints
    await loadBlueprints();

    // Setup event listeners
    setupEventListeners();

    // Check cache status and start monitoring
    await updateRefreshButtonState();
    startCacheMonitoring();
  } catch (error) {
    console.error('Error initializing blueprints window:', error);
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

// Load blueprints
async function loadBlueprints() {
  const blueprintsList = document.getElementById('blueprints-list');

  // Show loading state
  blueprintsList.innerHTML = `
    <div class="loading-state">
      <p>Loading blueprints...</p>
    </div>
  `;

  try {
    // Get all blueprints for this character
    allBlueprints = await window.electronAPI.blueprints.getAll(currentCharacterId);
    console.log('Loaded blueprints:', allBlueprints.length);

    if (!allBlueprints || allBlueprints.length === 0) {
      blueprintsList.innerHTML = `
        <div class="empty-state">
          <p>No blueprints found. Click "Refresh from API" to fetch blueprints from Eve Online.</p>
        </div>
      `;
      updateBlueprintCount(0);
      return;
    }

    // Fetch blueprint names from SDE
    const typeIds = [...new Set(allBlueprints.map(bp => bp.typeId))];
    blueprintNamesCache = await window.electronAPI.sde.getBlueprintNames(typeIds);
    console.log('Loaded blueprint names:', Object.keys(blueprintNamesCache).length);

    // Add blueprint names to blueprints array
    allBlueprints.forEach(bp => {
      bp.blueprintName = blueprintNamesCache[bp.typeId] || `Blueprint ${bp.typeId}`;
    });

    // Sort by blueprint name
    allBlueprints.sort((a, b) => a.blueprintName.localeCompare(b.blueprintName));

    console.log('Processed blueprints:', allBlueprints.length);

    // Apply filters
    applyFilters();
  } catch (error) {
    console.error('Error loading blueprints:', error);

    if (error.message && error.message.includes('SDE database not found')) {
      blueprintsList.innerHTML = `
        <div class="empty-state">
          <p><strong>Eve SDE database not found.</strong></p>
          <p>Please open Settings (gear icon) and click "Update SDE" to download the database.</p>
        </div>
      `;
    } else {
      blueprintsList.innerHTML = `
        <div class="empty-state">
          <p>Error loading blueprints: ${error.message}</p>
        </div>
      `;
    }
  }
}

// Update blueprint count
function updateBlueprintCount(count) {
  const countEl = document.getElementById('blueprint-count');
  if (countEl) {
    countEl.textContent = `Blueprints: ${count}`;
  }
}

// Apply filters
function applyFilters() {
  const searchQuery = document.getElementById('blueprint-search')?.value.toLowerCase() || '';
  const showOriginals = document.getElementById('show-originals')?.checked || false;
  const showCopies = document.getElementById('show-copies')?.checked || false;
  const showOverridden = document.getElementById('show-overridden')?.checked || false;
  const showManual = document.getElementById('show-manual')?.checked || false;
  const showCharacter = document.getElementById('show-character')?.checked || false;
  const showCorporation = document.getElementById('show-corporation')?.checked || false;

  filteredBlueprints = allBlueprints.filter(bp => {
    // Search filter
    if (searchQuery) {
      const blueprintName = bp.blueprintName || '';
      const typeId = bp.typeId.toString();
      if (!blueprintName.toLowerCase().includes(searchQuery) && !typeId.includes(searchQuery)) {
        return false;
      }
    }

    // Determine blueprint characteristics
    const isOriginal = !bp.isCopy;
    const isCopy = bp.isCopy;
    const hasOverride = bp.overrides && (bp.overrides.materialEfficiency !== undefined || bp.overrides.timeEfficiency !== undefined);
    const isManual = bp.manuallyAdded || bp.source === 'manual';

    // Check if blueprint is corporation-owned (using field or locationFlag)
    const isCorporation = bp.isCorporation || (
      bp.locationFlag && (
        bp.locationFlag.startsWith('CorpSAG') ||
        bp.locationFlag.startsWith('CorpDeliveries')
      )
    );
    const isCharacter = !isCorporation;

    // Ownership filter - must pass this first
    const passesOwnershipFilter = (isCharacter && showCharacter) || (isCorporation && showCorporation);
    if (!passesOwnershipFilter) return false;

    // Status filters (Overridden/Manual) - if either is checked, ONLY show those types
    const anyStatusFilterChecked = showOverridden || showManual;

    if (anyStatusFilterChecked) {
      // If status filters are active, check if blueprint matches
      let matchesStatusFilter = false;

      if (showOverridden && hasOverride) {
        matchesStatusFilter = true;
      }

      if (showManual && isManual) {
        matchesStatusFilter = true;
      }

      if (!matchesStatusFilter) {
        return false;
      }
    }

    // Type filter (BPO/BPC) - applies to all blueprints regardless of status
    const passesTypeFilter = (isOriginal && showOriginals) || (isCopy && showCopies);
    if (!passesTypeFilter) return false;

    return true;
  });

  updateBlueprintCount(filteredBlueprints.length);
  renderBlueprints();
}

// Group blueprints by name, type, runs, ME, and TE
function groupBlueprints(blueprints) {
  const groups = {};

  blueprints.forEach(bp => {
    const effectiveValues = getEffectiveBlueprintValues(bp);

    // Create unique key for grouping
    const key = `${bp.typeId}_${bp.isCopy ? 'bpc' : 'bpo'}_${bp.runs}_${effectiveValues.materialEfficiency}_${effectiveValues.timeEfficiency}`;

    if (!groups[key]) {
      groups[key] = {
        typeId: bp.typeId,
        blueprintName: bp.blueprintName,
        isCopy: bp.isCopy,
        runs: bp.runs,
        materialEfficiency: effectiveValues.materialEfficiency,
        timeEfficiency: effectiveValues.timeEfficiency,
        hasMEOverride: effectiveValues.hasMEOverride,
        hasTEOverride: effectiveValues.hasTEOverride,
        blueprints: [],
      };
    }

    groups[key].blueprints.push(bp);
  });

  // Convert to array and sort by name
  return Object.values(groups).sort((a, b) =>
    a.blueprintName.localeCompare(b.blueprintName)
  );
}

// Render blueprints list
function renderBlueprints() {
  const blueprintsList = document.getElementById('blueprints-list');

  if (filteredBlueprints.length === 0) {
    blueprintsList.innerHTML = `
      <div class="empty-state">
        <p>No blueprints match the current filters.</p>
      </div>
    `;
    return;
  }

  // Group blueprints
  const groupedBlueprints = groupBlueprints(filteredBlueprints);

  blueprintsList.innerHTML = groupedBlueprints.map(group => createBlueprintGroupItem(group)).join('');

  // Add event listeners for expand/collapse and calculator buttons
  groupedBlueprints.forEach(group => {
    const groupKey = `group-${group.typeId}-${group.isCopy ? 'bpc' : 'bpo'}-${group.runs}-${group.materialEfficiency}-${group.timeEfficiency}`;
    const expandBtn = document.getElementById(`expand-${groupKey}`);
    const itemsDiv = document.getElementById(`items-${groupKey}`);
    const calcBtn = document.getElementById(`calc-${groupKey}`);

    if (expandBtn && itemsDiv) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExpanded = itemsDiv.style.display === 'block';
        itemsDiv.style.display = isExpanded ? 'none' : 'block';
        expandBtn.classList.toggle('expanded', !isExpanded);
      });
    }

    if (calcBtn) {
      calcBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openInCalculator(group.typeId, group.materialEfficiency);
      });
    }
  });

  // Add event listeners to controls
  filteredBlueprints.forEach(bp => {
    // ME input
    const meInput = document.getElementById(`bp-${bp.itemId}-me`);
    if (meInput) {
      // Prevent invalid input
      meInput.addEventListener('input', (e) => {
        let value = e.target.value;
        // Remove any non-digit characters except minus at start
        value = value.replace(/[^\d-]/g, '');
        // Remove minus if not at start
        if (value.indexOf('-') > 0) {
          value = value.replace(/-/g, '');
        }
        e.target.value = value;
      });

      // Validate and save on change
      meInput.addEventListener('change', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value)) {
          value = 0;
        }
        // Clamp value between 0 and 10
        value = Math.max(0, Math.min(10, value));
        e.target.value = value;
        setBlueprintValue(bp.itemId, 'materialEfficiency', value);
      });
    }

    // TE input
    const teInput = document.getElementById(`bp-${bp.itemId}-te`);
    if (teInput) {
      // Prevent invalid input
      teInput.addEventListener('input', (e) => {
        let value = e.target.value;
        // Remove any non-digit characters except minus at start
        value = value.replace(/[^\d-]/g, '');
        // Remove minus if not at start
        if (value.indexOf('-') > 0) {
          value = value.replace(/-/g, '');
        }
        e.target.value = value;
      });

      // Validate and save on change
      teInput.addEventListener('change', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value)) {
          value = 0;
        }
        // Clamp value between 0 and 20
        value = Math.max(0, Math.min(20, value));
        e.target.value = value;
        setBlueprintValue(bp.itemId, 'timeEfficiency', value);
      });
    }

    // Reset ME button
    const resetMeBtn = document.getElementById(`bp-${bp.itemId}-reset-me`);
    if (resetMeBtn) {
      resetMeBtn.addEventListener('click', () => resetBlueprintValue(bp.itemId, 'materialEfficiency'));
    }

    // Reset TE button
    const resetTeBtn = document.getElementById(`bp-${bp.itemId}-reset-te`);
    if (resetTeBtn) {
      resetTeBtn.addEventListener('click', () => resetBlueprintValue(bp.itemId, 'timeEfficiency'));
    }

    // Delete button (only for manual blueprints)
    const deleteBtn = document.getElementById(`bp-${bp.itemId}-delete`);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => deleteBlueprint(bp.itemId));
    }
  });
}

// Create blueprint group item HTML
function createBlueprintGroupItem(group) {
  const quantity = group.blueprints.length;
  const hasOverride = group.hasMEOverride || group.hasTEOverride;
  const hasManual = group.blueprints.some(bp => bp.manuallyAdded || bp.source === 'manual');

  const groupKey = `group-${group.typeId}-${group.isCopy ? 'bpc' : 'bpo'}-${group.runs}-${group.materialEfficiency}-${group.timeEfficiency}`;

  const itemClasses = ['blueprint-group'];
  if (hasOverride) itemClasses.push('has-override');
  if (hasManual) itemClasses.push('manually-added');

  const runsDisplay = group.isCopy ? group.runs : 'Infinite';

  return `
    <div class="${itemClasses.join(' ')}">
      <div class="blueprint-group-header" data-group="${groupKey}">
        <div class="blueprint-info">
          <div class="blueprint-name">${group.blueprintName}</div>
          <div class="blueprint-details">
            <span class="blueprint-badge ${group.isCopy ? 'badge-bpc' : 'badge-bpo'}">
              ${group.isCopy ? 'BPC' : 'BPO'}
            </span>
            <span><strong>Runs:</strong> ${runsDisplay}</span>
            <span><strong>ME:</strong> ${group.materialEfficiency}</span>
            <span><strong>TE:</strong> ${group.timeEfficiency}</span>
            <span class="blueprint-qty"><strong>Qty:</strong> ${quantity}</span>
            ${hasManual ? '<span class="blueprint-badge badge-manual">Manual</span>' : ''}
            ${hasOverride ? '<span class="blueprint-badge badge-overridden">Overridden</span>' : ''}
          </div>
        </div>
        <div class="blueprint-group-actions">
          <button class="calculator-btn" id="calc-${groupKey}" data-type-id="${group.typeId}" title="Open in Blueprint Calculator">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect>
              <line x1="8" y1="6" x2="16" y2="6"></line>
              <line x1="8" y1="10" x2="16" y2="10"></line>
              <line x1="8" y1="14" x2="16" y2="14"></line>
              <line x1="8" y1="18" x2="12" y2="18"></line>
            </svg>
          </button>
          <button class="expand-btn" id="expand-${groupKey}">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>
      </div>
      <div class="blueprint-group-items" id="items-${groupKey}" style="display: none;">
        ${group.blueprints.map(bp => createBlueprintItem(bp)).join('')}
      </div>
    </div>
  `;
}

// Create blueprint item HTML
function createBlueprintItem(bp) {
  const effectiveValues = getEffectiveBlueprintValues(bp);
  const isManual = bp.manuallyAdded || bp.source === 'manual';
  const hasOverride = effectiveValues.hasMEOverride || effectiveValues.hasTEOverride;
  const blueprintName = bp.blueprintName || `Blueprint ${bp.typeId}`;

  const itemClasses = ['blueprint-item'];
  if (hasOverride) itemClasses.push('has-override');
  if (isManual) itemClasses.push('manually-added');

  return `
    <div class="${itemClasses.join(' ')}">
      <div class="blueprint-info">
        <div class="blueprint-name">${blueprintName}</div>
        <div class="blueprint-details">
          <span class="blueprint-badge ${bp.isCopy ? 'badge-bpc' : 'badge-bpo'}">
            ${bp.isCopy ? 'BPC' : 'BPO'}
          </span>
          ${bp.isCopy ? `<span>Runs: ${bp.runs}</span>` : ''}
          ${isManual ? '<span class="blueprint-badge badge-manual">Manual</span>' : ''}
          ${hasOverride ? '<span class="blueprint-badge badge-overridden">Overridden</span>' : ''}
        </div>
      </div>
      <div class="blueprint-controls">
        <div class="efficiency-control">
          <div class="efficiency-label">ME</div>
          <div class="efficiency-input-group">
            <input
              type="number"
              class="efficiency-input ${effectiveValues.hasMEOverride ? 'override' : ''}"
              id="bp-${bp.itemId}-me"
              min="0"
              max="10"
              step="1"
              value="${effectiveValues.materialEfficiency}"
              title="Material Efficiency (0-10)"
            >
            ${effectiveValues.hasMEOverride ? `<button class="small-button" id="bp-${bp.itemId}-reset-me">Reset</button>` : ''}
          </div>
        </div>
        <div class="efficiency-control">
          <div class="efficiency-label">TE</div>
          <div class="efficiency-input-group">
            <input
              type="number"
              class="efficiency-input ${effectiveValues.hasTEOverride ? 'override' : ''}"
              id="bp-${bp.itemId}-te"
              min="0"
              max="20"
              step="1"
              value="${effectiveValues.timeEfficiency}"
              title="Time Efficiency (0-20)"
            >
            ${effectiveValues.hasTEOverride ? `<button class="small-button" id="bp-${bp.itemId}-reset-te">Reset</button>` : ''}
          </div>
        </div>
        ${isManual ? `<button class="delete-btn" id="bp-${bp.itemId}-delete">Delete</button>` : ''}
      </div>
    </div>
  `;
}

// Get effective blueprint values (considering overrides)
function getEffectiveBlueprintValues(bp) {
  const hasMEOverride = bp.overrides && bp.overrides.materialEfficiency !== undefined;
  const hasTEOverride = bp.overrides && bp.overrides.timeEfficiency !== undefined;

  return {
    materialEfficiency: hasMEOverride ? bp.overrides.materialEfficiency : bp.materialEfficiency,
    timeEfficiency: hasTEOverride ? bp.overrides.timeEfficiency : bp.timeEfficiency,
    hasMEOverride,
    hasTEOverride,
  };
}

// Set blueprint value (override)
async function setBlueprintValue(itemId, field, value) {
  try {
    const bp = allBlueprints.find(b => b.itemId === itemId);
    if (!bp) return;

    // If setting to actual value, remove override (pass null)
    if (field === 'materialEfficiency' && value === bp.materialEfficiency) {
      value = null;
    } else if (field === 'timeEfficiency' && value === bp.timeEfficiency) {
      value = null;
    }

    const success = await window.electronAPI.blueprints.setOverride(itemId, field, value);

    if (success) {
      console.log(`Set blueprint ${itemId} ${field} to ${value}`);

      // Reload blueprints
      await loadBlueprints();
    } else {
      console.error('Failed to set blueprint override');
    }
  } catch (error) {
    console.error('Error setting blueprint value:', error);
  }
}

// Reset blueprint value (remove override)
async function resetBlueprintValue(itemId, field) {
  try {
    const success = await window.electronAPI.blueprints.setOverride(itemId, field, null);

    if (success) {
      console.log(`Reset blueprint ${itemId} ${field}`);

      // Reload blueprints
      await loadBlueprints();
    } else {
      console.error('Failed to reset blueprint override');
    }
  } catch (error) {
    console.error('Error resetting blueprint value:', error);
  }
}

// Delete blueprint
async function deleteBlueprint(itemId) {
  if (!confirm('Are you sure you want to delete this blueprint?')) {
    return;
  }

  try {
    const success = await window.electronAPI.blueprints.remove(itemId);

    if (success) {
      console.log(`Deleted blueprint ${itemId}`);

      // Reload blueprints
      await loadBlueprints();
    } else {
      console.error('Failed to delete blueprint');
      alert('Failed to delete blueprint');
    }
  } catch (error) {
    console.error('Error deleting blueprint:', error);
    alert(`Error deleting blueprint: ${error.message}`);
  }
}

// Refresh blueprints from API
async function refreshBlueprints() {
  const refreshBtn = document.getElementById('refresh-blueprints-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      Refreshing...
    `;
  }

  try {
    const result = await window.electronAPI.blueprints.fetch(currentCharacterId);

    if (result.success) {
      console.log('Blueprints refreshed successfully');

      // Reload blueprints
      await loadBlueprints();

      // Update button state with new cache
      await updateRefreshButtonState();
    } else {
      console.error('Failed to refresh blueprints:', result.error);
      alert(`Failed to refresh blueprints: ${result.error}`);
    }
  } catch (error) {
    console.error('Error refreshing blueprints:', error);
    alert(`Error refreshing blueprints: ${error.message}`);
  } finally {
    // Update button state
    await updateRefreshButtonState();
  }
}

// Show add blueprint modal
function showAddBlueprintModal() {
  const modal = document.getElementById('add-blueprint-modal');
  if (modal) {
    modal.style.display = 'flex';
  }

  // Clear search
  const searchInput = document.getElementById('blueprint-search-modal');
  if (searchInput) {
    searchInput.value = '';
  }

  // Clear results
  const results = document.getElementById('search-results');
  if (results) {
    results.innerHTML = `
      <div class="empty-state">
        <p>Search for blueprints to add...</p>
      </div>
    `;
  }
}

// Hide add blueprint modal
function hideAddBlueprintModal() {
  const modal = document.getElementById('add-blueprint-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Search blueprints in SDE
let searchTimeout = null;
async function searchBlueprintsModal(searchTerm) {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }

  const results = document.getElementById('search-results');
  if (!results) return;

  if (!searchTerm || searchTerm.length < 2) {
    results.innerHTML = `
      <div class="empty-state">
        <p>Enter at least 2 characters to search...</p>
      </div>
    `;
    return;
  }

  results.innerHTML = `
    <div class="loading-state">
      <p>Searching...</p>
    </div>
  `;

  searchTimeout = setTimeout(async () => {
    try {
      const blueprints = await window.electronAPI.sde.searchBlueprints(searchTerm);
      console.log('Search results:', blueprints.length);

      if (blueprints.length === 0) {
        results.innerHTML = `
          <div class="empty-state">
            <p>No blueprints found.</p>
          </div>
        `;
        return;
      }

      results.innerHTML = blueprints.map(bp => `
        <div class="search-result-item" data-type-id="${bp.typeID}">
          <div class="result-name">${bp.typeName}</div>
          <div class="result-group">${bp.groupName}</div>
        </div>
      `).join('');

      // Add click listeners
      results.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          const typeId = parseInt(item.dataset.typeId);
          const typeName = item.querySelector('.result-name').textContent;
          addManualBlueprint(typeId, typeName);
        });
      });
    } catch (error) {
      console.error('Error searching blueprints:', error);
      results.innerHTML = `
        <div class="empty-state">
          <p>Error searching: ${error.message}</p>
        </div>
      `;
    }
  }, 300);
}

// Add manual blueprint
async function addManualBlueprint(typeId, typeName) {
  try {
    const blueprintData = {
      typeId,
      characterId: currentCharacterId,
      materialEfficiency: 0,
      timeEfficiency: 0,
      runs: -1, // BPO
      isCopy: false,
    };

    const success = await window.electronAPI.blueprints.addManual(blueprintData);

    if (success) {
      console.log(`Added manual blueprint: ${typeName}`);

      // Hide modal
      hideAddBlueprintModal();

      // Reload blueprints
      await loadBlueprints();
    } else {
      console.error('Failed to add manual blueprint');
      alert('Failed to add blueprint');
    }
  } catch (error) {
    console.error('Error adding manual blueprint:', error);
    alert(`Error adding blueprint: ${error.message}`);
  }
}

// Update refresh button state based on cache
async function updateRefreshButtonState() {
  const refreshBtn = document.getElementById('refresh-blueprints-btn');
  if (!refreshBtn || !currentCharacterId) return;

  try {
    const cacheStatus = await window.electronAPI.blueprints.getCacheStatus(currentCharacterId);

    if (cacheStatus.isCached && cacheStatus.remainingSeconds > 0) {
      // Cache is still valid, disable button
      refreshBtn.disabled = true;

      const minutes = Math.floor(cacheStatus.remainingSeconds / 60);
      const seconds = cacheStatus.remainingSeconds % 60;
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        Cached (${timeStr})
      `;
      refreshBtn.title = `ESI cache expires in ${timeStr}`;
    } else {
      // Cache expired, enable button
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        Refresh from API
      `;
      refreshBtn.title = 'Fetch latest blueprints from ESI';
    }
  } catch (error) {
    console.error('Error updating refresh button state:', error);
    // On error, enable the button
    refreshBtn.disabled = false;
  }
}

// Start monitoring cache status
function startCacheMonitoring() {
  // Clear any existing interval
  if (cacheCheckInterval) {
    clearInterval(cacheCheckInterval);
  }

  // Check cache status every second
  cacheCheckInterval = setInterval(async () => {
    await updateRefreshButtonState();
  }, 1000);
}

// Stop monitoring cache status (when window closes)
function stopCacheMonitoring() {
  if (cacheCheckInterval) {
    clearInterval(cacheCheckInterval);
    cacheCheckInterval = null;
  }
}

// Setup event listeners
function setupEventListeners() {
  // Search input
  const searchInput = document.getElementById('blueprint-search');
  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  // Filter checkboxes
  const showOriginals = document.getElementById('show-originals');
  if (showOriginals) {
    showOriginals.addEventListener('change', applyFilters);
  }

  const showCopies = document.getElementById('show-copies');
  if (showCopies) {
    showCopies.addEventListener('change', applyFilters);
  }

  const showOverridden = document.getElementById('show-overridden');
  if (showOverridden) {
    showOverridden.addEventListener('change', applyFilters);
  }

  const showManual = document.getElementById('show-manual');
  if (showManual) {
    showManual.addEventListener('change', applyFilters);
  }

  const showCharacter = document.getElementById('show-character');
  const showCorporation = document.getElementById('show-corporation');

  if (showCharacter) {
    showCharacter.addEventListener('change', (e) => {
      // If Character is checked, uncheck Corporation (mutually exclusive)
      if (e.target.checked && showCorporation) {
        showCorporation.checked = false;
      }
      applyFilters();
    });
  }

  if (showCorporation) {
    showCorporation.addEventListener('change', (e) => {
      // If Corporation is checked, uncheck Character (mutually exclusive)
      if (e.target.checked && showCharacter) {
        showCharacter.checked = false;
      }
      applyFilters();
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById('refresh-blueprints-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshBlueprints);
  }

  // Add manual button
  const addManualBtn = document.getElementById('add-manual-btn');
  if (addManualBtn) {
    addManualBtn.addEventListener('click', showAddBlueprintModal);
  }

  // Close modal button
  const closeModalBtn = document.getElementById('close-modal-btn');
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', hideAddBlueprintModal);
  }

  // Modal backdrop click
  const modal = document.getElementById('add-blueprint-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        hideAddBlueprintModal();
      }
    });
  }

  // Modal search input
  const modalSearchInput = document.getElementById('blueprint-search-modal');
  if (modalSearchInput) {
    modalSearchInput.addEventListener('input', (e) => searchBlueprintsModal(e.target.value));
  }
}

// Open blueprint in calculator
async function openInCalculator(blueprintTypeId, meLevel) {
  try {
    // Request to open the blueprint in the calculator
    await window.electronAPI.blueprints.openInCalculator(blueprintTypeId, meLevel);
  } catch (error) {
    console.error('Error opening blueprint in calculator:', error);
    alert('Failed to open blueprint in calculator');
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, waiting for character ID via IPC...');
  });
}
