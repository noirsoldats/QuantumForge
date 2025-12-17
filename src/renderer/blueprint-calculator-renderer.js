// Blueprint Calculator Renderer

console.log('Blueprint Calculator initialized');

let currentBlueprint = null;
let currentDefaultCharacter = null;
let currentDefaultCharacterId = null;
let searchTimeout = null;

// Tab and invention state
let currentTab = 'manufacturing';
let inventionDataLoaded = false;
let inventionDataCache = null;

// Store event listeners so they can be removed
let blueprintSearchClickOutsideListener = null;
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
  if (blueprintSearchClickOutsideListener) {
    document.removeEventListener('click', blueprintSearchClickOutsideListener);
  }
  if (characterMenuClickOutsideListener) {
    document.removeEventListener('click', characterMenuClickOutsideListener);
  }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM loaded, initializing Blueprint Calculator');

  // Set up the listener BEFORE initializing to catch any early messages
  window.electronAPI.blueprints.onOpenInCalculator(async (data) => {
    console.log('Received blueprint to open:', data);
    const { blueprintTypeId, meLevel } = data;
    await selectBlueprint(blueprintTypeId);
    // Set ME level if provided
    if (meLevel !== undefined) {
      document.getElementById('me-level').value = meLevel;
    }
  });

  await initializeCalculator();
});

// Initialize the calculator
async function initializeCalculator() {
  try {
    // Get default character
    currentDefaultCharacter = await window.electronAPI.esi.getDefaultCharacter();

    // Load facilities into dropdown
    await loadFacilities();

    // Setup event listeners
    setupEventListeners();

    // Load default character avatar
    await loadDefaultCharacterAvatar();

    // Listen for default character changes
    window.electronAPI.esi.onDefaultCharacterChanged(async () => {
      currentDefaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
      loadDefaultCharacterAvatar();
      // Also update character count in footer when default character changes
      window.footerUtils.updateCharacterCount();
    });

    // Initialize status footer
    await window.footerUtils.initializeFooter();

    console.log('Blueprint Calculator initialized successfully');
  } catch (error) {
    console.error('Error initializing calculator:', error);
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

  // Back button
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  // Blueprint search
  const searchInput = document.getElementById('blueprint-search');
  if (searchInput) {
    searchInput.addEventListener('input', handleBlueprintSearch);

    // Close search results when clicking outside
    // Remove old listener first to prevent accumulation
    if (blueprintSearchClickOutsideListener) {
      document.removeEventListener('click', blueprintSearchClickOutsideListener);
    }

    blueprintSearchClickOutsideListener = (e) => {
      if (!e.target.closest('.search-container')) {
        hideSearchResults();
      }
    };

    document.addEventListener('click', blueprintSearchClickOutsideListener);
  }

  // Calculate button
  const calculateBtn = document.getElementById('calculate-btn');
  if (calculateBtn) {
    calculateBtn.addEventListener('click', handleCalculate);
  }

  // Update Data button
  const updateDataBtn = document.getElementById('update-data-btn');
  if (updateDataBtn) {
    updateDataBtn.addEventListener('click', handleUpdateData);
  }

  // Add to Plan button
  const addToPlanBtn = document.getElementById('add-to-plan-btn');
  if (addToPlanBtn) {
    addToPlanBtn.addEventListener('click', handleAddToPlan);
  }

  // ME and Runs inputs - recalculate on change
  const meInput = document.getElementById('me-level');
  const runsInput = document.getElementById('runs');

  if (meInput) {
    meInput.addEventListener('change', () => {
      if (currentBlueprint) {
        handleCalculate();
      }
    });
  }

  if (runsInput) {
    runsInput.addEventListener('change', () => {
      if (currentBlueprint) {
        handleCalculate();
      }
    });
  }

  // Tab switching
  const tabButtons = document.querySelectorAll('.blueprint-tab');
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tab;
      switchTab(tabName);
    });
  });
}

// Switch between tabs
function switchTab(tabName) {
  console.log('Switching to tab:', tabName);

  // Update current tab
  currentTab = tabName;

  // Update tab button states
  const tabButtons = document.querySelectorAll('.blueprint-tab');
  tabButtons.forEach(button => {
    if (button.dataset.tab === tabName) {
      button.classList.add('active');
    } else {
      button.classList.remove('active');
    }
  });

  // Update tab content visibility
  const tabContents = document.querySelectorAll('.blueprint-tab-content');
  tabContents.forEach(content => {
    if (content.id === `${tabName}-tab-content`) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });

  // Lazy load invention analysis if switching to invention tab
  if (tabName === 'invention' && !inventionDataLoaded && currentBlueprint) {
    loadInventionAnalysis();
  }
}

// Load invention analysis (lazy loading)
async function loadInventionAnalysis() {
  if (inventionDataLoaded || !currentBlueprint) {
    return;
  }

  console.log('Loading invention analysis...');

  // Show loading state
  const inventionContent = document.getElementById('invention-content');
  if (inventionContent) {
    inventionContent.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading invention data...</p></div>';
  }

  try {
    // Get the current runs value
    const runsInput = document.getElementById('runs');
    const runs = runsInput ? parseInt(runsInput.value) || 1 : 1;

    // Call displayInventionAnalysis with required parameters
    await displayInventionAnalysis(currentBlueprint.typeID, runs);
    inventionDataLoaded = true;
  } catch (error) {
    console.error('Error loading invention analysis:', error);
    if (inventionContent) {
      inventionContent.innerHTML = '<div class="error-state"><p>Failed to load invention data</p></div>';
    }
  }
}

// Handle blueprint search input
function handleBlueprintSearch(e) {
  clearTimeout(searchTimeout);
  const searchTerm = e.target.value.trim();

  if (searchTerm.length < 2) {
    hideSearchResults();
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const blueprints = await window.electronAPI.calculator.searchBlueprints(searchTerm, 20);
      displaySearchResults(blueprints);
    } catch (error) {
      console.error('Error searching blueprints:', error);
    }
  }, 300);
}

// Display search results
function displaySearchResults(blueprints) {
  const resultsContainer = document.getElementById('search-results');

  if (!blueprints || blueprints.length === 0) {
    resultsContainer.innerHTML = '<div class="search-result-item">No blueprints found</div>';
    resultsContainer.classList.remove('hidden');
    return;
  }

  resultsContainer.innerHTML = blueprints.map(bp => `
    <div class="search-result-item" data-blueprint-id="${bp.typeID}">
      <div class="search-result-name">${bp.typeName}</div>
      <div class="search-result-details">
        Produces: ${bp.productName} &times; ${bp.productQuantity}
      </div>
    </div>
  `).join('');

  // Add click handlers
  resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const blueprintId = parseInt(item.getAttribute('data-blueprint-id'));
      selectBlueprint(blueprintId);
    });
  });

  resultsContainer.classList.remove('hidden');
}

// Hide search results
function hideSearchResults() {
  const resultsContainer = document.getElementById('search-results');
  resultsContainer.classList.add('hidden');
}

// Select a blueprint
async function selectBlueprint(blueprintTypeId) {
  try {
    hideSearchResults();

    // Get blueprint product
    const product = await window.electronAPI.calculator.getBlueprintProduct(blueprintTypeId);
    if (!product) {
      console.error('Blueprint not found');
      return;
    }

    const blueprintName = await window.electronAPI.calculator.getTypeName(blueprintTypeId);
    const productName = await window.electronAPI.calculator.getTypeName(product.typeID);

    currentBlueprint = {
      typeID: blueprintTypeId,
      typeName: blueprintName,
      product: {
        typeID: product.typeID,
        typeName: productName,
        quantity: product.quantity
      }
    };

    // Update UI
    document.getElementById('blueprint-name').textContent = blueprintName;
    document.getElementById('product-name').textContent = productName;
    document.getElementById('base-quantity').textContent = product.quantity;

    // Check if the default character owns this blueprint and load ME
    let ownedME = 0;
    if (currentDefaultCharacter?.characterId) {
      ownedME = await window.electronAPI.calculator.getOwnedBlueprintME(
        currentDefaultCharacter.characterId,
        blueprintTypeId
      );
    }

    // Set ME level to owned blueprint value, or 0 if not owned
    document.getElementById('me-level').value = ownedME;
    document.getElementById('runs').value = 1;

    // Reset to Blueprint Results tab when loading new blueprint
    switchTab('manufacturing');

    // Clear backend calculation caches for new blueprint
    await window.electronAPI.calculator.clearCaches();

    // Show blueprint display, hide empty state
    document.getElementById('blueprint-display').classList.remove('hidden');
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('materials-display').classList.add('hidden');
  } catch (error) {
    console.error('Error selecting blueprint:', error);
    alert('Failed to load blueprint: ' + error.message);
  }
}

// Handle calculate button
async function handleCalculate() {
  if (!currentBlueprint) {
    return;
  }

  const meLevel = parseInt(document.getElementById('me-level').value) || 0;
  const runs = parseInt(document.getElementById('runs').value) || 1;

  // Validate inputs
  if (runs < 1) {
    alert('Runs must be at least 1');
    return;
  }

  if (meLevel < 0 || meLevel > 10) {
    alert('ME level must be between 0 and 10');
    return;
  }

  // Show loading indicator
  showLoading();

  try {
    const characterId = currentDefaultCharacter?.characterId || null;
    const facilityId = document.getElementById('facility-select').value || null;

    // Start timing
    const startTime = performance.now();

    const result = await window.electronAPI.calculator.calculateMaterials(
      currentBlueprint.typeID,
      runs,
      meLevel,
      characterId,
      facilityId
    );

    // Calculate and log elapsed time
    const elapsedTime = performance.now() - startTime;
    console.log(`[Blueprint Calculation] Completed in ${elapsedTime.toFixed(2)}ms (${(elapsedTime / 1000).toFixed(2)}s)`);

    if (result.error) {
      throw new Error(result.error);
    }

    // Display results
    await displayMaterialsCalculation(result, runs, facilityId);

    hideLoading();

    // Show "Add to Plan" button after successful calculation
    const addToPlanBtn = document.getElementById('add-to-plan-btn');
    if (addToPlanBtn) {
      addToPlanBtn.style.display = 'inline-flex';
    }
  } catch (error) {
    console.error('Error calculating materials:', error);
    hideLoading();
    alert('Failed to calculate materials: ' + error.message);
  }
}

// Handle add to plan button
async function handleAddToPlan() {
  if (!currentBlueprint) {
    alert('No blueprint selected');
    return;
  }

  try {
    // Get current character
    const characterId = currentDefaultCharacter?.characterId || null;
    if (!characterId) {
      alert('Please select a default character first');
      return;
    }

    // Get all plans for this character
    const plans = await window.electronAPI.plans.getAll(characterId, {});

    // Show modal
    showPlanSelectionModal(plans, characterId);

  } catch (error) {
    console.error('Error loading plans:', error);
    alert('Failed to load plans: ' + error.message);
  }
}

function showPlanSelectionModal(plans, characterId) {
  const modal = document.getElementById('plan-selection-modal');
  const optionsContainer = document.getElementById('plan-selection-options');
  const newPlanSection = document.getElementById('new-plan-section');
  const newPlanInput = document.getElementById('new-plan-name-input');

  if (!modal || !optionsContainer) {
    console.error('Modal elements not found!');
    alert('Error: Modal elements not found in the DOM');
    return;
  }

  // Clear previous options
  optionsContainer.innerHTML = '';
  newPlanSection.style.display = 'none';
  newPlanInput.value = '';

  // Add existing plans as radio options
  if (plans && plans.length > 0) {
    plans.forEach(plan => {
      const option = document.createElement('label');
      option.className = 'plan-option';
      option.innerHTML = `
        <input type="radio" name="plan-selection" value="${plan.planId}">
        <span>${plan.planName} (${plan.status})</span>
      `;
      optionsContainer.appendChild(option);
    });
  }

  // Add "Create New Plan" option
  const newPlanOption = document.createElement('label');
  newPlanOption.className = 'plan-option';
  newPlanOption.innerHTML = `
    <input type="radio" name="plan-selection" value="new">
    <span>Create New Plan</span>
  `;
  optionsContainer.appendChild(newPlanOption);

  // Show/hide new plan name input when "new" is selected
  optionsContainer.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'new') {
        newPlanSection.style.display = 'block';
      } else {
        newPlanSection.style.display = 'none';
      }
    });
  });

  // Show modal
  modal.style.display = 'flex';

  // Handle confirm button
  const confirmBtn = document.getElementById('confirm-plan-selection-btn');
  const newConfirmHandler = async () => {
    const selectedRadio = optionsContainer.querySelector('input[type="radio"]:checked');
    if (!selectedRadio) {
      alert('Please select a plan or create a new one.');
      return;
    }

    try {
      let planId;

      if (selectedRadio.value === 'new') {
        // Create new plan
        const planName = newPlanInput.value.trim() || null;
        const newPlan = await window.electronAPI.plans.create(characterId, planName, null);
        planId = newPlan.planId;
      } else {
        planId = selectedRadio.value;
      }

      // Close modal
      modal.style.display = 'none';
      confirmBtn.removeEventListener('click', newConfirmHandler);

      // Add blueprint to plan
      await addCurrentBlueprintToPlan(planId);

    } catch (error) {
      console.error('Error creating/selecting plan:', error);
      alert('Error: ' + error.message);
    }
  };

  confirmBtn.addEventListener('click', newConfirmHandler);

  // Handle cancel/close
  const closeModal = () => {
    modal.style.display = 'none';
    confirmBtn.removeEventListener('click', newConfirmHandler);
  };

  document.getElementById('cancel-plan-selection-btn').onclick = closeModal;
  document.getElementById('close-plan-selection-modal-btn').onclick = closeModal;

  // Click outside to close
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };
}

async function addCurrentBlueprintToPlan(planId) {
  const meLevel = parseInt(document.getElementById('me-level').value) || 0;
  const runs = parseInt(document.getElementById('runs').value) || 1;
  const teLevel = 0; // Calculator doesn't currently expose TE
  const facilityId = document.getElementById('facility-select').value || null;

  try {
    // Get facility snapshot if facility selected
    let facilitySnapshot = null;
    if (facilityId) {
      const facilities = await window.electronAPI.facilities.getFacilities();
      const facility = facilities.find(f => f.id === facilityId);
      if (facility) {
        facilitySnapshot = {
          name: facility.name,
          systemId: facility.systemId,
          structureTypeId: facility.structureTypeId,
          rigs: facility.rigs || []
        };
      }
    }

    // Add blueprint to plan
    const blueprintConfig = {
      blueprintTypeId: currentBlueprint.typeID,
      runs,
      productionLines: 1,
      meLevel,
      teLevel,
      facilityId,
      facilitySnapshot,
    };

    await window.electronAPI.plans.addBlueprint(planId, blueprintConfig);

    alert('Blueprint added to plan successfully!');
  } catch (error) {
    console.error('Error adding to plan:', error);
    alert('Failed to add blueprint to plan: ' + error.message);
  }
}

// Legacy function - no longer used
function showPlanSelectionDialog(options) {
  return new Promise((resolve) => {
    const message = 'Select a plan or create a new one:\n\n' + options.map((opt, idx) => `${idx}: ${opt}`).join('\n');
    const input = prompt(message + '\n\nEnter number:');

    if (input === null) {
      resolve(null);
      return;
    }

    const selection = parseInt(input);
    if (isNaN(selection) || selection < 0 || selection >= options.length) {
      alert('Invalid selection');
      resolve(null);
      return;
    }

    resolve(selection);
  });
}

// Handle update data button
async function handleUpdateData() {
  const updateBtn = document.getElementById('update-data-btn');

  if (!updateBtn) {
    return;
  }

  // Disable button and show loading state
  updateBtn.disabled = true;
  const originalText = updateBtn.innerHTML;
  updateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning">
      <polyline points="23 4 23 10 17 10"></polyline>
      <polyline points="1 20 1 14 7 14"></polyline>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
    Updating...
  `;

  try {
    console.log('Starting data update...');

    // Get market settings to get the region ID
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002; // Default to The Forge (Jita)

    // Update market prices
    await window.electronAPI.market.manualRefresh(regionId);

    // Update adjusted prices
    await window.electronAPI.market.refreshAdjustedPrices();

    // Update cost indices
    await window.electronAPI.costIndices.fetch();

    // Show success message
    updateBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Updated!
    `;

    // Reset button after 2 seconds
    setTimeout(() => {
      updateBtn.innerHTML = originalText;
      updateBtn.disabled = false;
    }, 2000);

  } catch (error) {
    console.error('Error updating data:', error);

    // Show error state
    updateBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
      Update Failed
    `;

    // Reset button after 3 seconds
    setTimeout(() => {
      updateBtn.innerHTML = originalText;
      updateBtn.disabled = false;
    }, 3000);

    alert('Failed to update data: ' + error.message);
  }
}

// Display materials calculation results
async function displayMaterialsCalculation(result, runs, facilityId = null) {
  // Show materials display
  document.getElementById('materials-display').classList.remove('hidden');

  // Display facility bonuses if a facility is selected
  if (facilityId) {
    await displayFacilityBonuses(facilityId);
  } else {
    // Hide facility bonuses section if no facility selected
    const facilityBonusesEl = document.getElementById('facility-bonuses');
    if (facilityBonusesEl) {
      facilityBonusesEl.style.display = 'none';
    }
  }

  // Display total materials
  await displayTotalMaterials(result.materials);

  // Display breakdown
  await displayMaterialsBreakdown(result.breakdown, runs);

  // Display pricing information if available
  if (result.pricing) {
    await displayPricingInformation(result.pricing);
  } else {
    // Hide pricing display if no pricing data
    const pricingEl = document.getElementById('pricing-display');
    if (pricingEl) {
      pricingEl.style.display = 'none';
    }
  }

  // Show tabs
  const tabsElement = document.getElementById('blueprint-tabs');
  if (tabsElement) {
    tabsElement.classList.remove('hidden');
  }

  // Check if invention is possible for this blueprint
  await checkAndConfigureInventionTab(currentBlueprint.typeID);

  // Reset invention state (will be loaded when tab is clicked)
  inventionDataLoaded = false;
  inventionDataCache = null;

  // If user is on invention tab, load it now
  if (currentTab === 'invention') {
    await loadInventionAnalysis();
  }
}

// Check if invention is possible and configure the invention tab accordingly
async function checkAndConfigureInventionTab(blueprintTypeId) {
  const inventionTabBtn = document.getElementById('invention-tab-btn');

  if (!inventionTabBtn) {
    return;
  }

  try {
    // Try to get invention data
    const inventionData = await window.electronAPI.calculator.getInventionData(blueprintTypeId);

    if (inventionData && inventionData.products && inventionData.products.length > 0) {
      // Invention is possible - show the tab
      inventionTabBtn.style.display = 'flex';
    } else {
      // No invention possible - hide the tab and switch to manufacturing if needed
      inventionTabBtn.style.display = 'none';
      if (currentTab === 'invention') {
        switchTab('manufacturing');
      }
    }
  } catch (error) {
    console.error('Error checking invention data:', error);
    // On error, hide invention tab
    inventionTabBtn.style.display = 'none';
    if (currentTab === 'invention') {
      switchTab('manufacturing');
    }
  }
}

// Display total materials summary
async function displayTotalMaterials(materials) {
  const container = document.getElementById('total-materials');

  if (!materials || Object.keys(materials).length === 0) {
    container.innerHTML = '<p style="color: #a0a0b0;">No materials required</p>';
    return;
  }

  // Get material names and sort by quantity
  const materialList = await Promise.all(
    Object.entries(materials).map(async ([typeId, quantity]) => {
      const typeName = await window.electronAPI.calculator.getTypeName(parseInt(typeId));
      return {
        typeId: parseInt(typeId),
        typeName,
        quantity
      };
    })
  );

  materialList.sort((a, b) => b.quantity - a.quantity);

  container.innerHTML = materialList.map(mat => `
    <div class="material-item">
      <span class="material-name">${mat.typeName}</span>
      <span class="material-quantity">${formatNumber(mat.quantity)}</span>
    </div>
  `).join('');
}

// Display materials breakdown by blueprint
async function displayMaterialsBreakdown(breakdown, totalRuns) {
  const container = document.getElementById('blueprint-breakdown');

  if (!breakdown || breakdown.length === 0) {
    container.innerHTML = '<p style="color: #a0a0b0;">No breakdown available</p>';
    return;
  }

  let html = '';

  for (const item of breakdown) {
    const hasIntermediates = item.intermediateComponents && item.intermediateComponents.length > 0;

    html += `
      <div class="breakdown-item">
        <div class="breakdown-header">
          <span class="breakdown-title">${item.blueprintName}</span>
          <div>
            <span class="breakdown-badge">ME ${item.meLevel}</span>
            <span class="breakdown-badge">${item.runs} Run${item.runs > 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="breakdown-content">
          <p style="margin-bottom: 15px; color: #a0a0b0;">
            <strong>Produces:</strong> ${item.productName} &times; ${formatNumber(item.productQuantity)}
          </p>
    `;

    // Show raw materials
    if (item.rawMaterials && item.rawMaterials.length > 0) {
      html += `
        <h5 style="color: #64b4ff; margin-bottom: 10px;">Raw Materials</h5>
        <div class="breakdown-materials">
      `;

      for (const mat of item.rawMaterials) {
        html += `
          <div class="sub-material-item">
            <span class="sub-material-name">${mat.typeName}</span>
            <span class="sub-material-quantity">${formatNumber(mat.quantity)}</span>
          </div>
        `;
      }

      html += '</div>';
    }

    // Show intermediate components
    if (hasIntermediates) {
      html += `
        <h5 style="color: #ffa500; margin-top: 20px; margin-bottom: 10px;">Intermediate Components (Manufactured)</h5>
        <div class="breakdown-materials">
      `;

      for (const comp of item.intermediateComponents) {
        html += `
          <div class="sub-material-item intermediate">
            <span class="sub-material-name">
              ${comp.typeName}
              <span class="intermediate-badge">ME ${comp.meLevel}</span>
            </span>
            <span class="sub-material-quantity">${formatNumber(comp.quantity)}</span>
          </div>
        `;
      }

      html += '</div>';
    }

    html += `
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// Show loading indicator
function showLoading() {
  document.getElementById('loading-indicator').classList.remove('hidden');
  document.getElementById('materials-display').classList.add('hidden');
}

// Hide loading indicator
function hideLoading() {
  document.getElementById('loading-indicator').classList.add('hidden');
}

// Format number with commas
function formatNumber(value) {
  if (!value) return '0';
  return value.toLocaleString('en-US');
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
        currentDefaultCharacter = defaultCharacter;

        // Set avatar image
        avatarImg.src = `${defaultCharacter.portrait}?size=128`;
        avatarImg.alt = defaultCharacter.characterName;

        // Update menu header
        menuNameEl.textContent = defaultCharacter.characterName;

        // Show the avatar container
        avatarContainer.style.display = 'block';

        // Setup menu toggle
        setupCharacterMenu(defaultCharacter);
      }
    } else {
      // No default character, hide the container
      currentDefaultCharacterId = null;
      currentDefaultCharacter = null;
      avatarContainer.style.display = 'none';
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

// Load facilities into dropdown
async function loadFacilities() {
  try {
    const facilities = await window.electronAPI.facilities.getFacilities();
    const facilitySelect = document.getElementById('facility-select');

    if (!facilitySelect) {
      console.error('Facility select element not found');
      return;
    }

    // Clear existing options except the first one (No Facility)
    facilitySelect.innerHTML = '<option value="">No Facility (No Bonuses)</option>';

    // Find the default facility
    let defaultFacilityId = null;

    // Add facility options
    facilities.forEach(facility => {
      const option = document.createElement('option');
      option.value = facility.id;
      option.textContent = facility.name;
      facilitySelect.appendChild(option);

      // Check if this is the default facility
      if (facility.usage === 'default') {
        defaultFacilityId = facility.id;
      }
    });

    // Select the default facility if one exists
    if (defaultFacilityId) {
      facilitySelect.value = defaultFacilityId;
    }

    console.log(`Loaded ${facilities.length} facilities${defaultFacilityId ? ', default facility selected' : ''}`);
  } catch (error) {
    console.error('Error loading facilities:', error);
  }
}

// Display facility bonuses information
async function displayFacilityBonuses(facilityId) {
  try {
    const facility = await window.electronAPI.facilities.getFacility(facilityId);
    const bonusesEl = document.getElementById('facility-bonuses');
    const contentEl = document.getElementById('facility-bonuses-content');

    if (!facility || !bonusesEl || !contentEl) {
      return;
    }

    // Get security status if we have a systemId
    if (facility.systemId) {
      facility.securityStatus = await window.electronAPI.sde.getSystemSecurityStatus(facility.systemId);
    }

    let bonusesHtml = `<div class="facility-info">`;
    bonusesHtml += `<p><strong>Facility:</strong> ${facility.name}</p>`;

    // Structure bonus (all Upwell structures)
    if (facility.structureTypeId) {
      bonusesHtml += `<p><strong>Structure Bonus:</strong> -1% Material Cost</p>`;
    }

    // Rig bonuses
    if (facility.rigs && facility.rigs.length > 0) {
      bonusesHtml += `<p><strong>Rigs Installed:</strong> ${facility.rigs.length}</p>`;
      bonusesHtml += `<ul class="rig-list">`;

      for (const rig of facility.rigs) {
        // Handle both string typeIds and object format {typeId: ...}
        const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
        const rigName = await window.electronAPI.calculator.getTypeName(rigTypeId);
        bonusesHtml += `<li>${rigName}</li>`;
      }

      bonusesHtml += `</ul>`;

      // Security status info
      const secStatus = facility.securityStatus || 0.5;
      const secMultiplier = secStatus >= 0.5 ? 1.0 : secStatus > 0 ? 1.9 : 2.1;
      const secInfo = secStatus >= 0.5 ? 'High-Sec (1.0x)' :
                      secStatus > 0 ? 'Low-Sec (1.9x)' :
                      'Null-Sec/WH (2.1x)';
      bonusesHtml += `<p><strong>Security Multiplier:</strong> ${secInfo}</p>`;

      // Calculate total rig ME bonus for display
      let totalRigBonus = 0;
      for (const rig of facility.rigs) {
        const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
        // Get rig bonuses from a simple query (we'll need to add this)
        try {
          const rigBonuses = await window.electronAPI.calculator.getRigBonuses(rigTypeId);
          if (rigBonuses && rigBonuses.materialBonus) {
            totalRigBonus += rigBonuses.materialBonus * secMultiplier;
          }
        } catch (error) {
          console.error('Error getting rig bonuses for display:', error);
        }
      }

      if (totalRigBonus !== 0) {
        bonusesHtml += `<p><strong>Rigs Bonus:</strong> ${totalRigBonus.toFixed(2)}% Material Reduction</p>`;
      }

      bonusesHtml += `<p class="bonus-note">Note: Rig bonuses are applied to items they affect based on their type</p>`;
    } else {
      bonusesHtml += `<p><em>No rigs installed</em></p>`;
    }

    bonusesHtml += `</div>`;

    contentEl.innerHTML = bonusesHtml;
    bonusesEl.style.display = 'block';
  } catch (error) {
    console.error('Error displaying facility bonuses:', error);
  }
}

// Display pricing information
async function displayPricingInformation(pricing) {
  try {
    const pricingEl = document.getElementById('pricing-display');
    const contentEl = document.getElementById('pricing-content');

    if (!pricingEl || !contentEl) {
      return;
    }

    // Format ISK values
    const formatISK = (value) => {
      if (!value || value === 0) return '0.00 ISK';
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ISK';
    };

    let html = '<div class="pricing-breakdown">';

    // Input Costs Section
    html += '<div class="pricing-section">';
    html += '<h5>Input Costs</h5>';

    // Display detailed material list
    if (pricing.inputCosts.materialPrices) {
      html += '<div class="material-prices-list">';

      // Get material names and sort by quantity (descending)
      const materialEntries = await Promise.all(
        Object.entries(pricing.inputCosts.materialPrices).map(async ([typeId, data]) => {
          const typeName = await window.electronAPI.calculator.getTypeName(parseInt(typeId));
          return {
            typeId: parseInt(typeId),
            typeName,
            ...data
          };
        })
      );

      // Sort by quantity descending
      materialEntries.sort((a, b) => b.quantity - a.quantity);

      // Display each material
      for (const material of materialEntries) {
        html += '<div class="material-price-row">';
        html += `<span class="material-name">${material.typeName}</span>`;
        html += '<div class="material-price-details">';
        html += `<span class="material-quantity">${formatNumber(material.quantity)}x @ ${formatISK(material.unitPrice)}</span>`;
        html += `<span class="material-total-price">${formatISK(material.totalPrice)}</span>`;
        html += '</div>';
        html += '</div>';
      }

      html += '</div>'; // Close material-prices-list
    }

    // Total materials cost
    html += '<div class="pricing-row pricing-subtotal">';
    html += `<span><strong>Total Materials Cost:</strong></span>`;
    html += `<span class="pricing-value"><strong>${formatISK(pricing.inputCosts.totalCost)}</strong></span>`;
    html += '</div>';

    if (pricing.inputCosts.itemsWithoutPrices > 0) {
      html += '<div class="pricing-warning">';
      html += `⚠️ ${pricing.inputCosts.itemsWithoutPrices} material(s) missing price data`;
      html += '</div>';
    }
    html += '</div>';

    // Manufacturing Fees Section
    html += '<div class="pricing-section">';
    html += '<h5>Manufacturing Fees</h5>';

    // Job Cost Breakdown
    if (pricing.jobCostBreakdown) {
      const jcb = pricing.jobCostBreakdown;

      // Job Cost Group
      html += '<div class="fee-group">';
      html += '<h6 class="fee-group-header">Job Costs</h6>';
      html += '<div class="fee-group-content">';

      // Estimated Item Value
      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Estimated Item Value:</span>`;
      html += `<span class="pricing-value">${formatISK(jcb.estimatedItemValue)}</span>`;
      html += '</div>';

      // System Cost Index
      html += '<div class="pricing-row">';
      html += `<span class="indent-1">System Cost Index:</span>`;
      html += `<span class="pricing-value">${(jcb.systemCostIndex * 100).toFixed(2)}%</span>`;
      html += '</div>';

      // Job Gross Cost
      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Job Gross Cost:</span>`;
      html += `<span class="pricing-value">${formatISK(jcb.jobGrossCost)}</span>`;
      html += '</div>';

      // Structure Cost Bonus (if applicable)
      if (jcb.structureRollBonus > 0) {
        html += '<div class="pricing-row">';
        html += `<span class="indent-1">Structure Cost Bonus:</span>`;
        html += `<span class="pricing-value">-${jcb.structureRollBonus.toFixed(2)}%</span>`;
        html += '</div>';
      }

      // Job Base Cost (after structure bonus)
      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Job Base Cost:</span>`;
      html += `<span class="pricing-value">${formatISK(jcb.jobBaseCost)}</span>`;
      html += '</div>';

      html += '</div>'; // Close fee-group-content

      // Taxes subsection
      html += '<div class="fee-subgroup">';
      html += '<div class="fee-subgroup-header">Installation Taxes</div>';

      // Facility Tax
      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Facility Tax (${jcb.facilityTaxRate.toFixed(2)}%):</span>`;
      html += `<span class="pricing-value">${formatISK(jcb.facilityTax)}</span>`;
      html += '</div>';

      // SCC Surcharge
      html += '<div class="pricing-row">';
      html += `<span class="indent-1">SCC Surcharge (4%):</span>`;
      html += `<span class="pricing-value">${formatISK(jcb.sccSurcharge)}</span>`;
      html += '</div>';

      html += '</div>'; // Close fee-subgroup

      // Total Job Cost
      html += '<div class="pricing-row pricing-subtotal">';
      html += `<span><strong>Total Job Cost:</strong></span>`;
      html += `<span class="pricing-value"><strong>${formatISK(jcb.totalJobCost)}</strong></span>`;
      html += '</div>';

      html += '</div>'; // Close fee-group
    } else {
      // Fallback for legacy format
      html += '<div class="pricing-row">';
      html += `<span>Job Cost (Installation):</span>`;
      html += `<span class="pricing-value">${formatISK(pricing.jobCost)}</span>`;
      html += '</div>';
    }

    // Sales Tax and Broker's Fee breakdown
    if (pricing.taxesBreakdown) {
      const tb = pricing.taxesBreakdown;

      // Trading Taxes Group
      html += '<div class="fee-group">';
      html += '<h6 class="fee-group-header">Trading Fees</h6>';

      // Material Purchase Fees section (broker's fee on buying materials)
      html += '<div class="fee-group-content">';
      html += '<div class="fee-subgroup-header">Material Purchase Fees</div>';

      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Materials Cost:</span>`;
      html += `<span class="pricing-value">${formatISK(tb.materialsCost)}</span>`;
      html += '</div>';

      html += '<div class="pricing-row">';
      const brokerSkillText = tb.brokerRelationsSkillLevel > 0 ? ` (Broker Relations ${tb.brokerRelationsSkillLevel})` : '';
      html += `<span class="indent-1">Broker Fee Rate${brokerSkillText}:</span>`;
      html += `<span class="pricing-value">${tb.materialBrokerFeeRate.toFixed(2)}%</span>`;
      html += '</div>';

      html += '<div class="pricing-row pricing-subtotal">';
      html += `<span class="indent-1"><strong>Material Purchase Fees Total:</strong></span>`;
      html += `<span class="pricing-value"><strong>${formatISK(tb.materialBrokerFee)}</strong></span>`;
      html += '</div>';
      html += '</div>'; // Close fee-group-content

      // Product Selling Fees section (sales tax + broker's fee on selling products)
      html += '<div class="fee-group-content">';
      html += '<div class="fee-subgroup-header">Product Selling Fees</div>';

      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Product Value:</span>`;
      html += `<span class="pricing-value">${formatISK(tb.outputValue)}</span>`;
      html += '</div>';

      // Sales Tax
      html += '<div class="pricing-row">';
      const accountingSkillText = tb.accountingSkillLevel > 0 ? ` (Accounting ${tb.accountingSkillLevel})` : '';
      html += `<span class="indent-1">Sales Tax Rate${accountingSkillText}:</span>`;
      html += `<span class="pricing-value">${tb.effectiveSalesTaxRate.toFixed(2)}%</span>`;
      html += '</div>';

      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Sales Tax:</span>`;
      html += `<span class="pricing-value">${formatISK(tb.productSalesTax)}</span>`;
      html += '</div>';

      // Broker's Fee
      html += '<div class="pricing-row">';
      const productBrokerSkillText = tb.brokerRelationsSkillLevel > 0 ? ` (Broker Relations ${tb.brokerRelationsSkillLevel})` : '';
      html += `<span class="indent-1">Broker Fee Rate${productBrokerSkillText}:</span>`;
      html += `<span class="pricing-value">${tb.productBrokerFeeRate.toFixed(2)}%</span>`;
      html += '</div>';

      html += '<div class="pricing-row">';
      html += `<span class="indent-1">Broker Fee:</span>`;
      html += `<span class="pricing-value">${formatISK(tb.productBrokerFee)}</span>`;
      html += '</div>';

      html += '<div class="pricing-row pricing-subtotal">';
      html += `<span class="indent-1"><strong>Product Selling Fees Total:</strong></span>`;
      html += `<span class="pricing-value"><strong>${formatISK(tb.totalProductFees)}</strong></span>`;
      html += '</div>';
      html += '</div>'; // Close fee-group-content

      html += '</div>'; // Close fee-group
    } else {
      // Fallback for legacy format
      html += '<div class="pricing-row">';
      html += `<span>Sales Tax (Materials):</span>`;
      html += `<span class="pricing-value">${formatISK(pricing.salesTax)}</span>`;
      html += '</div>';
    }
    html += '</div>';

    // Total Costs Section
    html += '<div class="pricing-section pricing-total">';
    html += '<div class="pricing-row">';
    html += `<span><strong>Total Manufacturing Cost:</strong></span>`;
    html += `<span class="pricing-value"><strong>${formatISK(pricing.totalCosts)}</strong></span>`;
    html += '</div>';
    html += '</div>';

    // Output Value Section
    html += '<div class="pricing-section">';
    html += '<h5>Output Value</h5>';
    html += '<div class="pricing-row">';
    html += `<span>Product Value (${pricing.outputValue.quantity}x units):</span>`;
    html += `<span class="pricing-value">${formatISK(pricing.outputValue.totalValue)}</span>`;
    html += '</div>';

    if (!pricing.outputValue.hasPrice) {
      html += '<div class="pricing-warning">';
      html += '⚠️ Product price data not available';
      html += '</div>';
    }
    html += '</div>';

    // Profit/Loss Section
    html += '<div class="pricing-section pricing-profit">';
    const isProfit = pricing.profit >= 0;
    const profitClass = isProfit ? 'profit-positive' : 'profit-negative';

    html += '<div class="pricing-row">';
    html += `<span><strong>${isProfit ? 'Profit' : 'Loss'}:</strong></span>`;
    html += `<span class="pricing-value ${profitClass}"><strong>${formatISK(Math.abs(pricing.profit))}</strong></span>`;
    html += '</div>';

    html += '<div class="pricing-row">';
    html += `<span>Profit Margin:</span>`;
    html += `<span class="pricing-value ${profitClass}">${pricing.profitMargin.toFixed(2)}%</span>`;
    html += '</div>';
    html += '</div>';

    html += '</div>'; // Close pricing-breakdown

    contentEl.innerHTML = html;
    pricingEl.style.display = 'block';
  } catch (error) {
    console.error('Error displaying pricing information:', error);
  }
}

// Display invention analysis
async function displayInventionAnalysis(blueprintTypeId, runs, cachedInventionData = null, cachedSelectedIndex = 0) {
  const inventionEl = document.getElementById('invention-display');

  try {
    const contentEl = document.getElementById('invention-content');

    if (!inventionEl || !contentEl) {
      console.warn('Invention display elements not found in DOM');
      return;
    }

    // Get invention data (use cached if available from product selection change)
    let inventionData;
    if (cachedInventionData) {
      console.log('Using cached invention data');
      inventionData = cachedInventionData;
    } else {
      console.log('Fetching invention data for blueprint:', blueprintTypeId);
      inventionData = await window.electronAPI.calculator.getInventionData(blueprintTypeId);
      console.log('Invention data received:', inventionData);
    }

    // If no invention data (T1 blueprint that cannot be invented), hide the section
    if (!inventionData || !inventionData.products || inventionData.products.length === 0) {
      console.log('No invention data or products, hiding section');
      inventionEl.style.display = 'none';
      return;
    }

    // Validate we have materials
    if (!inventionData.materials || inventionData.materials.length === 0) {
      console.warn('No invention materials found for blueprint:', blueprintTypeId);
      inventionEl.style.display = 'none';
      return;
    }

    console.log('Invention data valid, proceeding with display');
    console.log(`Found ${inventionData.products.length} possible invention target(s)`);

    // Select which product to analyze (use cached index or default to first)
    let selectedProductIndex = cachedSelectedIndex;

    // If there are multiple products, we'll show a selector
    const hasMultipleProducts = inventionData.products.length > 1;

    // Format ISK values
    const formatISK = (value) => {
      if (!value || value === 0) return '0.00 ISK';
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ISK';
    };

    // Format time values (seconds to human-readable)
    const formatTime = (seconds) => {
      if (!seconds || seconds === 0) return '0s';
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);

      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

      return parts.join(' ');
    };

    // Get display name for optimization strategy
    const getStrategyDisplayName = (strategy) => {
      const strategyNames = {
        'invention-only': 'Invention Cost Only',
        'total-per-item': 'Total Cost per Item',
        'total-full-bpc': 'Total Cost for Full BPC',
        'time-optimized': 'Fastest Manufacturing Time',
        'custom-volume': 'Custom Volume'
      };
      return strategyNames[strategy] || strategy;
    };

    // Get market settings for pricing
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;
    const locationId = marketSettings.locationId || null;

    // Get material prices (just unit prices for backend calculation)
    const materialPrices = {};
    console.log('Fetching prices for invention materials:', inventionData.materials);

    for (const material of inventionData.materials) {
      // Get typeId (handle both typeId and typeID from SDE)
      const materialTypeId = material.typeID || material.typeId;

      // Skip materials without valid typeId
      if (!materialTypeId || materialTypeId === null || materialTypeId === undefined) {
        console.warn('Skipping material with invalid typeId:', material);
        continue;
      }

      try {
        console.log(`Fetching price for ${material.typeName} (${materialTypeId}) in region ${regionId}, location ${locationId}`);
        const priceData = await window.electronAPI.market.calculatePrice(
          materialTypeId,
          regionId,
          locationId,
          marketSettings.inputMaterials?.priceType || 'vwap',
          1  // Get unit price
        );
        console.log(`Price data received:`, priceData);
        // The price structure returns 'price' not 'unitPrice'
        materialPrices[materialTypeId] = priceData.price || priceData.unitPrice || 0;
        console.log(`Set material price for ${materialTypeId} to ${materialPrices[materialTypeId]}`);
      } catch (error) {
        console.error(`Error getting price for material ${materialTypeId}:`, error);
        materialPrices[materialTypeId] = 0;
      }
    }

    console.log('Material prices collected:', materialPrices);

    // Get decryptor prices for accurate cost comparison
    const allDecryptors = await window.electronAPI.calculator.getAllDecryptors();
    for (const decryptor of allDecryptors) {
      try {
        const decryptorPriceData = await window.electronAPI.market.calculatePrice(
          decryptor.typeID,
          regionId,
          locationId,
          marketSettings.inputMaterials?.priceType || 'vwap',
          1  // Get unit price
        );
        materialPrices[decryptor.typeID] = decryptorPriceData.price || decryptorPriceData.unitPrice || 0;
      } catch (error) {
        console.warn(`Could not get price for decryptor ${decryptor.typeName}:`, error);
        materialPrices[decryptor.typeID] = 0;
      }
    }

    // IMPORTANT: We need to fetch prices for ALL materials that will be used in manufacturing
    // The backend calculateManufacturingCost() will recursively expand intermediate components
    // Ask the backend what materials it needs, then fetch prices for ALL of them
    console.log('DEBUG: inventionData.product:', inventionData.product);
    console.log('DEBUG: inventionData.products:', inventionData.products);
    console.log('DEBUG: selectedProductIndex:', selectedProductIndex);

    // Try multiple ways to get the invented blueprint typeID
    const productForMaterialPrices = inventionData.product ||
                                     (inventionData.products && inventionData.products[selectedProductIndex]) ||
                                     null;

    console.log('DEBUG: productForMaterialPrices:', productForMaterialPrices);

    const inventedBlueprintTypeId = productForMaterialPrices?.typeID || productForMaterialPrices?.typeId;
    console.log(`DEBUG: inventedBlueprintTypeId = ${inventedBlueprintTypeId}`);

    if (inventedBlueprintTypeId) {
      console.log(`Fetching manufacturing material list for invented blueprint ${inventedBlueprintTypeId}`);
      try {
        const baselineME = 2;
        const facilityId = document.getElementById('facility-select').value || null;

        // Get the full expanded material list from the backend
        const materialCalc = await window.electronAPI.calculator.calculateMaterials(
          inventedBlueprintTypeId,
          1,
          baselineME,
          currentDefaultCharacter?.characterId || null,
          facilityId
        );

        if (materialCalc && materialCalc.materials) {
          const materialIds = Object.keys(materialCalc.materials);
          console.log(`Got ${materialIds.length} materials from backend, fetching prices...`);

          // Fetch prices for ALL materials
          for (const materialTypeId of materialIds) {
            const materialTypeIdNum = parseInt(materialTypeId);

            // Skip if we already have this price
            if (materialPrices[materialTypeIdNum]) {
              continue;
            }

            try {
              const materialPriceData = await window.electronAPI.market.calculatePrice(
                materialTypeIdNum,
                regionId,
                locationId,
                'immediate',
                1
              );
              materialPrices[materialTypeIdNum] = materialPriceData.price || materialPriceData.unitPrice || 0;
            } catch (error) {
              console.warn(`Could not get price for material ${materialTypeIdNum}:`, error);
              materialPrices[materialTypeIdNum] = 0;
            }
          }

          console.log(`Total material prices now: ${Object.keys(materialPrices).length}`);
        }
      } catch (error) {
        console.error('Error fetching manufacturing material prices:', error);
      }
    }

    // Get selected product based on index
    const selectedProduct = inventionData.products[selectedProductIndex];

    // Get product price (the manufactured item's value, not the blueprint itself)
    // Blueprints aren't tradeable, so we use the manufactured product for pricing
    let productPrice = 0;
    const manufacturedProductTypeId = selectedProduct.manufacturedProduct?.typeID || selectedProduct.manufacturedProduct?.typeId;

    if (manufacturedProductTypeId) {
      try {
        console.log(`Fetching price for manufactured product: ${selectedProduct.manufacturedProduct?.typeName} (${manufacturedProductTypeId})`);
        const productPriceData = await window.electronAPI.market.calculatePrice(
          manufacturedProductTypeId,
          regionId,
          locationId,
          marketSettings.outputProducts?.priceType || 'vwap',
          1
        );
        productPrice = productPriceData.price || productPriceData.unitPrice || 0;
        console.log(`Manufactured product price: ${productPrice} ISK`);
      } catch (error) {
        console.error('Error getting manufactured product price:', error);
      }
    } else {
      console.warn('No manufactured product found for invention analysis');
    }

    // Get character skills for invention calculation
    const skills = {};
    if (currentDefaultCharacter?.characterId) {
      try {
        // Get encryption skill
        const encryptionSkillId = 21790; // Encryption Methods
        skills.encryption = await window.electronAPI.skills.getEffectiveLevel(
          currentDefaultCharacter.characterId,
          encryptionSkillId
        ) || 0;

        // Get datacore skills (we'll use the required skills from invention data)
        if (inventionData.skills && inventionData.skills.length >= 2) {
          const datacore1SkillId = inventionData.skills[0].skillID || inventionData.skills[0].skillId;
          const datacore2SkillId = inventionData.skills[1].skillID || inventionData.skills[1].skillId;

          console.log('Fetching skill levels for:', datacore1SkillId, datacore2SkillId);

          skills.datacore1 = await window.electronAPI.skills.getEffectiveLevel(
            currentDefaultCharacter.characterId,
            datacore1SkillId
          ) || 0;

          skills.datacore2 = await window.electronAPI.skills.getEffectiveLevel(
            currentDefaultCharacter.characterId,
            datacore2SkillId
          ) || 0;

          // Store skill names for display
          skills.datacore1Name = inventionData.skills[0].skillName;
          skills.datacore2Name = inventionData.skills[1].skillName;
        } else {
          skills.datacore1 = 0;
          skills.datacore2 = 0;
        }
      } catch (error) {
        console.error('Error getting character skills:', error);
        skills.encryption = 0;
        skills.datacore1 = 0;
        skills.datacore2 = 0;
      }
    } else {
      skills.encryption = 0;
      skills.datacore1 = 0;
      skills.datacore2 = 0;
    }

    // Create a modified invention data with the selected product
    const selectedInventionData = {
      materials: inventionData.materials,
      product: selectedProduct,
      baseProbability: selectedProduct.baseProbability,
      skills: inventionData.skills,
      time: inventionData.time
    };

    // Get optimization strategy and custom volume from UI
    let optimizationStrategy = 'total-per-item'; // default
    let customVolume = 1; // default
    const strategySelector = document.getElementById('optimization-strategy');
    const volumeInput = document.getElementById('manufacturing-volume');

    if (strategySelector) {
      optimizationStrategy = strategySelector.value;
    }

    if (volumeInput && optimizationStrategy === 'custom-volume') {
      customVolume = parseInt(volumeInput.value, 10) || 1;
    }

    console.log(`[Frontend] Finding best decryptor with strategy: '${optimizationStrategy}', volume: ${customVolume}`);
    console.log(`[Frontend] Strategy selector element exists: ${!!strategySelector}`);
    console.log(`[Frontend] Strategy selector value: ${strategySelector ? strategySelector.value : 'N/A'}`);

    // Find best decryptor for the selected product
    // Pass null for facility - backend will use default facility
    const bestDecryptorResult = await window.electronAPI.calculator.findBestDecryptor(
      selectedInventionData,
      materialPrices,
      productPrice,
      skills,
      null,  // facility - use default
      optimizationStrategy,
      customVolume
    );

    console.log('[Frontend] Best decryptor result:', bestDecryptorResult);

    // Validate we got a result
    if (!bestDecryptorResult || !bestDecryptorResult.best) {
      console.error('Invalid decryptor result:', bestDecryptorResult);
      inventionEl.style.display = 'none';
      return;
    }

    // Normalize the result structure (backend returns 'best', we use 'bestOption')
    const bestOption = bestDecryptorResult.best;
    const noDecryptorOption = bestDecryptorResult.noDecryptor;
    const allOptions = bestDecryptorResult.allOptions || [];

    // Track which decryptor to display (starts with optimal)
    let displayOption = bestOption;

    console.log('Best option for display:', bestOption);
    console.log('All options count:', allOptions.length);
    console.log('Material prices used:', materialPrices);

    let html = '<div class="invention-breakdown">';

    // Product Selector (if multiple products available)
    if (hasMultipleProducts) {
      html += '<div class="invention-section invention-product-selector">';
      html += '<h5>Select Invention Target</h5>';
      html += '<div class="invention-row">';
      html += '<label for="invention-product-select">Target Blueprint:</label>';
      html += '<select id="invention-product-select" class="control-input">';
      inventionData.products.forEach((product, index) => {
        const selected = index === selectedProductIndex ? ' selected' : '';
        html += `<option value="${index}"${selected}>${product.typeName}</option>`;
      });
      html += '</select>';
      html += '</div>';
      html += '</div>';
    }

    // Product Information
    html += '<div class="invention-section">';
    html += '<h5>Invention Target</h5>';
    html += '<div class="invention-row">';
    html += `<span>Invented Blueprint:</span>`;
    html += `<span class="invention-value">${selectedProduct.typeName}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Manufactures:</span>`;
    html += `<span class="invention-value">${selectedProduct.manufacturedProduct?.typeName || 'Unknown'}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Base Probability:</span>`;
    html += `<span class="invention-value">${(selectedProduct.baseProbability * 100).toFixed(2)}%</span>`;
    html += '</div>';
    html += '</div>';

    // Skills Information
    html += '<div class="invention-section">';
    html += '<h5>Character Skills</h5>';
    html += '<div class="invention-row">';
    html += `<span>Encryption Methods:</span>`;
    html += `<span class="invention-value">Level ${skills.encryption || 0}</span>`;
    html += '</div>';
    if (skills.datacore1Name && skills.datacore2Name) {
      html += '<div class="invention-row">';
      html += `<span>${skills.datacore1Name}:</span>`;
      html += `<span class="invention-value">Level ${skills.datacore1 || 0}</span>`;
      html += '</div>';
      html += '<div class="invention-row">';
      html += `<span>${skills.datacore2Name}:</span>`;
      html += `<span class="invention-value">Level ${skills.datacore2 || 0}</span>`;
      html += '</div>';
    }
    html += '</div>';

    // Optimization Strategy Selector
    html += '<div class="invention-section invention-optimization-selector">';
    html += '<h5>Optimization Strategy</h5>';
    html += '<div class="invention-row">';
    html += '<label for="optimization-strategy">Optimize For:</label>';
    html += '<select id="optimization-strategy" class="control-input">';
    html += `<option value="invention-only"${optimizationStrategy === 'invention-only' ? ' selected' : ''}>Invention Cost Only</option>`;
    html += `<option value="total-per-item"${optimizationStrategy === 'total-per-item' ? ' selected' : ''}>Total Cost per Item (Recommended)</option>`;
    html += `<option value="total-full-bpc"${optimizationStrategy === 'total-full-bpc' ? ' selected' : ''}>Total Cost for Full BPC</option>`;
    html += `<option value="time-optimized"${optimizationStrategy === 'time-optimized' ? ' selected' : ''}>Fastest Manufacturing Time</option>`;
    html += `<option value="custom-volume"${optimizationStrategy === 'custom-volume' ? ' selected' : ''}>Custom Volume...</option>`;
    html += '</select>';
    html += '</div>';
    // Custom volume input (hidden by default)
    const showCustomVolume = optimizationStrategy === 'custom-volume' ? '' : 'none';
    html += `<div id="custom-volume-input" class="invention-row" style="display:${showCustomVolume};">`;
    html += '<label for="manufacturing-volume">Manufacturing Volume:</label>';
    html += `<input type="number" id="manufacturing-volume" class="control-input" min="1" value="${customVolume}">`;
    html += '</div>';
    html += '</div>';

    // Best Decryptor Results
    html += '<div class="invention-section invention-optimal-decryptor">';
    html += '<h5>Optimal Decryptor</h5>';

    if (bestOption.name !== 'No Decryptor' && bestOption.typeID) {
      html += '<div class="invention-row">';
      html += `<span>Decryptor:</span>`;
      html += `<span class="invention-value">${bestOption.name}</span>`;
      html += '</div>';
      html += '<div class="invention-row">';
      html += `<span>Success Probability:</span>`;
      html += `<span class="invention-value">${(bestOption.probability * 100).toFixed(2)}%</span>`;
      html += '</div>';
      html += '<div class="invention-row">';
      html += `<span>ME Modifier:</span>`;
      html += `<span class="invention-value">${bestOption.meModifier >= 0 ? '+' : ''}${bestOption.meModifier}</span>`;
      html += '</div>';
      html += '<div class="invention-row">';
      html += `<span>TE Modifier:</span>`;
      html += `<span class="invention-value">${bestOption.teModifier >= 0 ? '+' : ''}${bestOption.teModifier}</span>`;
      html += '</div>';
      html += '<div class="invention-row">';
      html += `<span>Runs Modifier:</span>`;
      html += `<span class="invention-value">${bestOption.runsModifier >= 0 ? '+' : ''}${bestOption.runsModifier}</span>`;
      html += '</div>';
    } else {
      html += '<div class="invention-row">';
      html += `<span>Decryptor:</span>`;
      html += `<span class="invention-value">No Decryptor (Most Cost-Effective)</span>`;
      html += '</div>';
      html += '<div class="invention-row">';
      html += `<span>Success Probability:</span>`;
      html += `<span class="invention-value">${(bestOption.probability * 100).toFixed(2)}%</span>`;
      html += '</div>';
    }
    html += '</div>';

    // Decryptor Selector
    html += '<div class="invention-section invention-decryptor-selector">';
    html += '<h5>Select Decryptor to Analyze</h5>';
    html += '<div class="invention-row">';
    html += '<label for="decryptor-select">Choose Decryptor:</label>';
    html += '<select id="decryptor-select" class="control-input">';
    // Add "Optimal Decryptor" option at the top
    html += `<option value="optimal" selected>Optimal Decryptor (${bestOption.name})</option>`;
    html += '<option disabled>──────────</option>'; // Separator
    allOptions.forEach((option, index) => {
      html += `<option value="${index}">${option.name}</option>`;
    });
    html += '</select>';
    html += '</div>';
    html += '</div>';

    // Output Blueprint Stats (will be updated by selector)
    // Invented T2 blueprints start with base ME: 2, base TE: 4
    const baseME = 2;
    const baseTE = 4;
    const finalME = baseME + (bestOption.meModifier || 0);
    const finalTE = baseTE + (bestOption.teModifier || 0);

    html += '<div class="invention-section" id="invention-output-blueprint-section">';
    html += '<h5>Output Blueprint Stats</h5>';
    html += '<div class="invention-row">';
    html += `<span>Total Runs:</span>`;
    html += `<span class="invention-value">${bestOption.runsPerBPC || 1}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Material Efficiency (ME):</span>`;
    html += `<span class="invention-value">${finalME}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Time Efficiency (TE):</span>`;
    html += `<span class="invention-value">${finalTE}</span>`;
    html += '</div>';
    html += '</div>';

    // Cost Analysis (will be updated by selector)
    html += '<div class="invention-section" id="invention-costs-section">';
    html += '<h5>Invention Costs</h5>';
    html += '<div class="invention-row">';
    html += `<span>Material Cost per Attempt:</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.materialCost)}</span>`;
    html += '</div>';

    if (bestOption.decryptorCost && bestOption.decryptorCost > 0) {
      html += '<div class="invention-row">';
      html += `<span>Decryptor Cost per Attempt:</span>`;
      html += `<span class="invention-value">${formatISK(bestOption.decryptorCost)}</span>`;
      html += '</div>';
    }

    html += '<div class="invention-row">';
    html += `<span>Job Cost per Attempt:</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.jobCost)}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Total Cost per Attempt:</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.totalCostPerAttempt)}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Runs per Invented BPC:</span>`;
    html += `<span class="invention-value">${bestOption.runsPerBPC || 1}</span>`;
    html += '</div>';
    html += '<div class="invention-row">';
    html += `<span>Average Cost per Successful Invention:</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.costPerSuccess)}</span>`;
    html += '</div>';
    html += '<div class="invention-row invention-highlight">';
    html += `<span><strong>Average Cost per Run:</strong></span>`;
    html += `<span class="invention-value"><strong>${formatISK(bestOption.costPerRun)}</strong></span>`;
    html += '</div>';
    html += '</div>';

    // Economic Analysis - Manufacturing Costs
    html += '<div class="invention-section" id="invention-economic-analysis-section">';
    html += '<h5>Economic Analysis</h5>';

    // Show current optimization strategy
    html += '<div class="invention-row">';
    html += `<span>Optimization Strategy:</span>`;
    html += `<span class="invention-value">${getStrategyDisplayName(bestDecryptorResult.optimizationStrategy)}</span>`;
    html += '</div>';

    // Manufacturing cost per item
    html += '<div class="invention-row">';
    html += `<span>Manufacturing Cost per Item:</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.manufacturingCostPerItem || 0)}</span>`;
    html += '</div>';

    // Manufacturing cost for full BPC
    html += '<div class="invention-row">';
    html += `<span>Manufacturing Cost for Full BPC (${bestOption.runsPerBPC || 1} runs):</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.manufacturingCostFullBPC || 0)}</span>`;
    html += '</div>';

    // Manufacturing time per item
    if (bestOption.manufacturingTimePerItem && bestOption.manufacturingTimePerItem > 0) {
      html += '<div class="invention-row">';
      html += `<span>Manufacturing Time per Item:</span>`;
      html += `<span class="invention-value">${formatTime(bestOption.manufacturingTimePerItem)}</span>`;
      html += '</div>';
    }

    // Total cost per item (invention + manufacturing)
    html += '<div class="invention-row invention-highlight">';
    html += `<span><strong>Total Cost per Item:</strong></span>`;
    html += `<span class="invention-value"><strong>${formatISK(bestOption.totalCostPerItem || 0)}</strong></span>`;
    html += '</div>';

    // Total cost for full BPC
    html += '<div class="invention-row">';
    html += `<span>Total Cost for Full BPC:</span>`;
    html += `<span class="invention-value">${formatISK(bestOption.totalCostFullBPC || 0)}</span>`;
    html += '</div>';

    html += '</div>';

    // Comparison with No Decryptor
    if (bestOption.typeID && noDecryptorOption) {
      const savingsPerRun = noDecryptorOption.costPerRun - bestOption.costPerRun;
      if (savingsPerRun > 0) {
        html += '<div class="invention-section invention-savings">';
        html += '<h5>Decryptor Benefit</h5>';
        html += '<div class="invention-row">';
        html += `<span>Cost Savings per Run vs. No Decryptor:</span>`;
        html += `<span class="invention-value positive">${formatISK(savingsPerRun)}</span>`;
        html += '</div>';
        html += '<div class="invention-row">';
        html += `<span>Savings Percentage:</span>`;
        html += `<span class="invention-value positive">${((savingsPerRun / noDecryptorOption.costPerRun) * 100).toFixed(2)}%</span>`;
        html += '</div>';
        html += '</div>';
      }
    }

    html += '</div>'; // Close invention-breakdown

    contentEl.innerHTML = html;
    inventionEl.style.display = 'block';

    // Function to update costs display based on selected decryptor
    function updateCostsDisplay(selectedOption) {
      const costsSection = document.getElementById('invention-costs-section');
      const blueprintSection = document.getElementById('invention-output-blueprint-section');
      if (!costsSection || !blueprintSection) return;

      // Check if this is the optimal selection (compare by name and cost per run to be safe)
      const isOptimal = selectedOption.name === bestOption.name &&
                       Math.abs(selectedOption.costPerRun - bestOption.costPerRun) < 0.01;

      // Update Output Blueprint Stats
      // Invented T2 blueprints start with base ME: 2, base TE: 4
      const baseME = 2;
      const baseTE = 4;
      const finalME = baseME + (selectedOption.meModifier || 0);
      const finalTE = baseTE + (selectedOption.teModifier || 0);

      let blueprintHtml = '<h5>Output Blueprint Stats</h5>';
      blueprintHtml += '<div class="invention-row">';
      blueprintHtml += `<span>Total Runs:</span>`;
      blueprintHtml += `<span class="invention-value">${selectedOption.runsPerBPC || 1}</span>`;
      blueprintHtml += '</div>';
      blueprintHtml += '<div class="invention-row">';
      blueprintHtml += `<span>Material Efficiency (ME):</span>`;
      blueprintHtml += `<span class="invention-value">${finalME}</span>`;
      blueprintHtml += '</div>';
      blueprintHtml += '<div class="invention-row">';
      blueprintHtml += `<span>Time Efficiency (TE):</span>`;
      blueprintHtml += `<span class="invention-value">${finalTE}</span>`;
      blueprintHtml += '</div>';
      blueprintSection.innerHTML = blueprintHtml;

      let costsHtml = '<h5>Invention Costs';
      if (!isOptimal) {
        costsHtml += ' <span style="color: #ffa500; font-size: 0.9em;">(Custom Selection)</span>';
      }
      costsHtml += '</h5>';

      costsHtml += '<div class="invention-row">';
      costsHtml += `<span>Material Cost per Attempt:</span>`;
      costsHtml += `<span class="invention-value">${formatISK(selectedOption.materialCost)}</span>`;
      costsHtml += '</div>';

      if (selectedOption.decryptorCost && selectedOption.decryptorCost > 0) {
        costsHtml += '<div class="invention-row">';
        costsHtml += `<span>Decryptor Cost per Attempt:</span>`;
        costsHtml += `<span class="invention-value">${formatISK(selectedOption.decryptorCost)}</span>`;
        costsHtml += '</div>';
      }

      costsHtml += '<div class="invention-row">';
      costsHtml += `<span>Job Cost per Attempt:</span>`;
      costsHtml += `<span class="invention-value">${formatISK(selectedOption.jobCost)}</span>`;
      costsHtml += '</div>';
      costsHtml += '<div class="invention-row">';
      costsHtml += `<span>Total Cost per Attempt:</span>`;
      costsHtml += `<span class="invention-value">${formatISK(selectedOption.totalCostPerAttempt)}</span>`;
      costsHtml += '</div>';
      costsHtml += '<div class="invention-row">';
      costsHtml += `<span>Runs per Invented BPC:</span>`;
      costsHtml += `<span class="invention-value">${selectedOption.runsPerBPC || 1}</span>`;
      costsHtml += '</div>';
      costsHtml += '<div class="invention-row">';
      costsHtml += `<span>Average Cost per Successful Invention:</span>`;
      costsHtml += `<span class="invention-value">${formatISK(selectedOption.costPerSuccess)}</span>`;
      costsHtml += '</div>';
      costsHtml += '<div class="invention-row invention-highlight">';
      costsHtml += `<span><strong>Average Cost per Run:</strong></span>`;
      costsHtml += `<span class="invention-value"><strong>${formatISK(selectedOption.costPerRun)}</strong></span>`;
      costsHtml += '</div>';

      // Show comparison if not already optimal
      if (!isOptimal) {
        const costDiff = selectedOption.costPerRun - bestOption.costPerRun;
        if (Math.abs(costDiff) > 0.01) {
          costsHtml += '<div class="invention-row" style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255, 165, 0, 0.2);">';
          costsHtml += `<span>Difference vs. Optimal:</span>`;
          const color = costDiff > 0 ? '#ff4757' : '#2ed573';
          const sign = costDiff > 0 ? '+' : '';
          costsHtml += `<span class="invention-value" style="color: ${color};">${sign}${formatISK(costDiff)}</span>`;
          costsHtml += '</div>';
        }
      }

      costsSection.innerHTML = costsHtml;

      // Update Economic Analysis Section
      const economicSection = document.getElementById('invention-economic-analysis-section');
      if (economicSection) {
        let economicHtml = '<h5>Economic Analysis</h5>';

        // Show current optimization strategy
        economicHtml += '<div class="invention-row">';
        economicHtml += `<span>Optimization Strategy:</span>`;
        economicHtml += `<span class="invention-value">${getStrategyDisplayName(selectedOption.optimizationStrategy || 'total-per-item')}</span>`;
        economicHtml += '</div>';

        // Manufacturing cost per item
        economicHtml += '<div class="invention-row">';
        economicHtml += `<span>Manufacturing Cost per Item:</span>`;
        economicHtml += `<span class="invention-value">${formatISK(selectedOption.manufacturingCostPerItem || 0)}</span>`;
        economicHtml += '</div>';

        // Manufacturing cost for full BPC
        economicHtml += '<div class="invention-row">';
        economicHtml += `<span>Manufacturing Cost for Full BPC (${selectedOption.runsPerBPC || 1} runs):</span>`;
        economicHtml += `<span class="invention-value">${formatISK(selectedOption.manufacturingCostFullBPC || 0)}</span>`;
        economicHtml += '</div>';

        // Manufacturing time per item
        if (selectedOption.manufacturingTimePerItem && selectedOption.manufacturingTimePerItem > 0) {
          economicHtml += '<div class="invention-row">';
          economicHtml += `<span>Manufacturing Time per Item:</span>`;
          economicHtml += `<span class="invention-value">${formatTime(selectedOption.manufacturingTimePerItem)}</span>`;
          economicHtml += '</div>';
        }

        // Total cost per item (invention + manufacturing)
        economicHtml += '<div class="invention-row invention-highlight">';
        economicHtml += `<span><strong>Total Cost per Item:</strong></span>`;
        economicHtml += `<span class="invention-value"><strong>${formatISK(selectedOption.totalCostPerItem || 0)}</strong></span>`;
        economicHtml += '</div>';

        // Total cost for full BPC
        economicHtml += '<div class="invention-row">';
        economicHtml += `<span>Total Cost for Full BPC:</span>`;
        economicHtml += `<span class="invention-value">${formatISK(selectedOption.totalCostFullBPC || 0)}</span>`;
        economicHtml += '</div>';

        economicSection.innerHTML = economicHtml;
      }
    }

    // Add event listener for product selector (if multiple products)
    if (hasMultipleProducts) {
      const productSelector = document.getElementById('invention-product-select');
      if (productSelector) {
        productSelector.addEventListener('change', async (e) => {
          const newIndex = parseInt(e.target.value, 10);
          console.log(`Product selection changed to index ${newIndex}: ${inventionData.products[newIndex].typeName}`);
          // Recursively call display function with new selection
          await displayInventionAnalysis(blueprintTypeId, runs, inventionData, newIndex);
        });
      }
    }

    // Add event listener for optimization strategy selector
    const optimizationStrategySelector = document.getElementById('optimization-strategy');
    if (optimizationStrategySelector) {
      optimizationStrategySelector.addEventListener('change', async (e) => {
        const selectedStrategy = e.target.value;
        console.log(`Optimization strategy changed to: ${selectedStrategy}`);

        // Show/hide custom volume input
        const customVolumeInput = document.getElementById('custom-volume-input');
        if (customVolumeInput) {
          if (selectedStrategy === 'custom-volume') {
            customVolumeInput.style.display = '';
          } else {
            customVolumeInput.style.display = 'none';
          }
        }

        // Hide sections below and show loading indicator
        const optimalDecryptorSection = document.querySelector('.invention-optimal-decryptor');
        const decryptorSelector = document.querySelector('.invention-decryptor-selector');
        const outputBlueprintSection = document.getElementById('invention-output-blueprint-section');
        const costsSection = document.getElementById('invention-costs-section');
        const economicSection = document.getElementById('invention-economic-analysis-section');
        const comparisonSection = document.querySelector('.invention-savings');

        // Hide sections
        if (optimalDecryptorSection) optimalDecryptorSection.style.display = 'none';
        if (decryptorSelector) decryptorSelector.style.display = 'none';
        if (outputBlueprintSection) outputBlueprintSection.style.display = 'none';
        if (costsSection) costsSection.style.display = 'none';
        if (economicSection) economicSection.style.display = 'none';
        if (comparisonSection) comparisonSection.style.display = 'none';

        // Show loading indicator
        let loadingDiv = document.getElementById('invention-loading-indicator');
        if (!loadingDiv) {
          loadingDiv = document.createElement('div');
          loadingDiv.id = 'invention-loading-indicator';
          loadingDiv.className = 'invention-section invention-loading';
          loadingDiv.innerHTML = `
            <div style="text-align: center; padding: 20px;">
              <div class="spinner" style="margin: 0 auto 15px;"></div>
              <p style="color: #a0a0b0; margin: 0;">Recalculating optimal decryptor...</p>
            </div>
          `;
          const optimizationSection = document.querySelector('.invention-optimization-selector');
          if (optimizationSection && optimizationSection.nextSibling) {
            optimizationSection.parentNode.insertBefore(loadingDiv, optimizationSection.nextSibling);
          }
        } else {
          loadingDiv.style.display = 'block';
        }

        // Re-run invention analysis with new strategy
        await displayInventionAnalysis(blueprintTypeId, runs, cachedInventionData, cachedSelectedIndex);

        // Hide loading indicator and restore sections
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (optimalDecryptorSection) optimalDecryptorSection.style.display = '';
        if (decryptorSelector) decryptorSelector.style.display = '';
        if (outputBlueprintSection) outputBlueprintSection.style.display = '';
        if (costsSection) costsSection.style.display = '';
        if (economicSection) economicSection.style.display = '';
        if (comparisonSection) comparisonSection.style.display = '';
      });
    }

    // Add event listener for custom volume input
    const manufacturingVolumeInput = document.getElementById('manufacturing-volume');
    if (manufacturingVolumeInput) {
      manufacturingVolumeInput.addEventListener('change', async (e) => {
        const volume = parseInt(e.target.value, 10);
        console.log(`Manufacturing volume changed to: ${volume}`);

        // Only re-run if custom-volume strategy is selected
        const strategySelector = document.getElementById('optimization-strategy');
        if (strategySelector && strategySelector.value === 'custom-volume') {
          // Hide sections below and show loading indicator
          const optimalDecryptorSection = document.querySelector('.invention-optimal-decryptor');
          const decryptorSelector = document.querySelector('.invention-decryptor-selector');
          const outputBlueprintSection = document.getElementById('invention-output-blueprint-section');
          const costsSection = document.getElementById('invention-costs-section');
          const economicSection = document.getElementById('invention-economic-analysis-section');
          const comparisonSection = document.querySelector('.invention-savings');

          // Hide sections
          if (optimalDecryptorSection) optimalDecryptorSection.style.display = 'none';
          if (decryptorSelector) decryptorSelector.style.display = 'none';
          if (outputBlueprintSection) outputBlueprintSection.style.display = 'none';
          if (costsSection) costsSection.style.display = 'none';
          if (economicSection) economicSection.style.display = 'none';
          if (comparisonSection) comparisonSection.style.display = 'none';

          // Show loading indicator
          let loadingDiv = document.getElementById('invention-loading-indicator');
          if (!loadingDiv) {
            loadingDiv = document.createElement('div');
            loadingDiv.id = 'invention-loading-indicator';
            loadingDiv.className = 'invention-section invention-loading';
            loadingDiv.innerHTML = `
              <div style="text-align: center; padding: 20px;">
                <div class="spinner" style="margin: 0 auto 15px;"></div>
                <p style="color: #a0a0b0; margin: 0;">Recalculating optimal decryptor...</p>
              </div>
            `;
            const optimizationSection = document.querySelector('.invention-optimization-selector');
            if (optimizationSection && optimizationSection.nextSibling) {
              optimizationSection.parentNode.insertBefore(loadingDiv, optimizationSection.nextSibling);
            }
          } else {
            loadingDiv.style.display = 'block';
          }

          await displayInventionAnalysis(blueprintTypeId, runs, cachedInventionData, cachedSelectedIndex);

          // Hide loading indicator and restore sections
          if (loadingDiv) loadingDiv.style.display = 'none';
          if (optimalDecryptorSection) optimalDecryptorSection.style.display = '';
          if (decryptorSelector) decryptorSelector.style.display = '';
          if (outputBlueprintSection) outputBlueprintSection.style.display = '';
          if (costsSection) costsSection.style.display = '';
          if (economicSection) economicSection.style.display = '';
          if (comparisonSection) comparisonSection.style.display = '';
        }
      });
    }

    // Add event listener for decryptor selector
    const decryptorSelector = document.getElementById('decryptor-select');
    if (decryptorSelector) {
      decryptorSelector.addEventListener('change', (e) => {
        const selectedValue = e.target.value;
        let selectedOption;

        if (selectedValue === 'optimal') {
          selectedOption = bestOption;
          console.log('Decryptor selection changed to: Optimal (automatic)');
        } else {
          const selectedIndex = parseInt(selectedValue, 10);
          selectedOption = allOptions[selectedIndex];
          console.log(`Decryptor selection changed to: ${selectedOption.name}`);
        }

        updateCostsDisplay(selectedOption);
      });
    }
  } catch (error) {
    console.error('Error displaying invention analysis:', error);
    // Hide invention display on error
    const inventionEl = document.getElementById('invention-display');
    if (inventionEl) {
      inventionEl.style.display = 'none';
    }
  }
}
