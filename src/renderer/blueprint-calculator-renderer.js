// Blueprint Calculator Renderer

console.log('Blueprint Calculator initialized');

let currentBlueprint = null;
let currentDefaultCharacter = null;
let currentDefaultCharacterId = null;
let searchTimeout = null;

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
    });

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
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-container')) {
        hideSearchResults();
      }
    });
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

    const result = await window.electronAPI.calculator.calculateMaterials(
      currentBlueprint.typeID,
      runs,
      meLevel,
      characterId,
      facilityId
    );

    if (result.error) {
      throw new Error(result.error);
    }

    // Display results
    await displayMaterialsCalculation(result, runs, facilityId);

    hideLoading();
  } catch (error) {
    console.error('Error calculating materials:', error);
    hideLoading();
    alert('Failed to calculate materials: ' + error.message);
  }
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

  if (!avatarBtn || !menu || !menuSkills || !menuBlueprints) {
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

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!avatarBtn.contains(e.target) && !menu.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
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
      if (jcb.structureCostBonus > 0) {
        html += '<div class="pricing-row">';
        html += `<span class="indent-1">Structure Cost Bonus:</span>`;
        html += `<span class="pricing-value">-${jcb.structureCostBonus.toFixed(2)}%</span>`;
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
