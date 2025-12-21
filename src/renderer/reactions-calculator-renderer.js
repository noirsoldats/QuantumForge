/**
 * Reactions Calculator Renderer
 * Frontend logic for Eve Online reactions calculator
 */

console.log('Reactions Calculator initialized');

let currentReaction = null;
let currentDefaultCharacter = null;
let currentDefaultCharacterId = null;
let characterMenuClickOutsideListener = null;
let searchTimeout = null;

// Type name cache for performance
const typeNameCache = new Map();

/**
 * Format seconds into D H:M:S format
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '0s';

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
}

// Global error handlers
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Renderer error:', { message, source, lineno, colno, error });
  return false;
};

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('DOM loaded, initializing reactions calculator');
    await initializeCalculator();
  } catch (error) {
    console.error('Fatal initialization error:', error);
    alert('Failed to initialize Reactions Calculator: ' + error.message);
  }
});

/**
 * Initialize the calculator page
 */
async function initializeCalculator() {
  try {
    // Get default character
    currentDefaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    if (currentDefaultCharacter) {
      currentDefaultCharacterId = currentDefaultCharacter.characterId;
    }

    // Setup event listeners
    setupEventListeners();

    // Load facilities (filtered to Refineries)
    await loadFacilities();

    // Load character avatar
    await loadDefaultCharacterAvatar();

    // Initialize footer
    await window.footerUtils.initializeFooter();

    console.log('Reactions Calculator initialized successfully');
  } catch (error) {
    console.error('Error initializing reactions calculator:', error);
    throw error;
  }
}

/**
 * Setup event listeners
 */
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

  // Reaction search (debounced)
  const reactionSearch = document.getElementById('reaction-search');
  if (reactionSearch) {
    reactionSearch.addEventListener('input', handleReactionSearch);
  }

  // Calculate button
  const calculateBtn = document.getElementById('calculate-btn');
  if (calculateBtn) {
    calculateBtn.addEventListener('click', handleCalculate);
  }

  // Update data button
  const updateDataBtn = document.getElementById('update-data-btn');
  if (updateDataBtn) {
    updateDataBtn.addEventListener('click', handleUpdateData);
  }

  // Runs input - recalculate on change if reaction selected
  const runsInput = document.getElementById('runs');
  if (runsInput) {
    runsInput.addEventListener('change', () => {
      if (currentReaction) {
        // Auto-recalculate when runs change
        handleCalculate();
      }
    });
  }

  // Facility select - recalculate on change if reaction selected
  const facilitySelect = document.getElementById('facility-select');
  if (facilitySelect) {
    facilitySelect.addEventListener('change', () => {
      if (currentReaction) {
        // Auto-recalculate when facility changes
        handleCalculate();
      }
    });
  }
}

/**
 * Load facilities - FILTER to Refineries only (Athanor, Tatara)
 */
async function loadFacilities() {
  try {
    const facilitySelect = document.getElementById('facility-select');
    const facilities = await window.electronAPI.facilities.getFacilities();

    facilitySelect.innerHTML = '<option value="">No Facility (No Bonuses)</option>';

    // FILTER: Only show Athanor (35835) and Tatara (35836) or facilities with reaction usage
    const refineryFacilities = facilities.filter(f => {
      const isRefinery = f.structureTypeId === 35835 || f.structureTypeId === 35836;
      const hasReactionUsage = f.usage && f.usage.includes('reaction');
      return isRefinery || hasReactionUsage;
    });

    if (refineryFacilities.length === 0) {
      console.warn('No refinery facilities found. User should create one in Facilities Manager.');
      const noFacilityOption = document.createElement('option');
      noFacilityOption.value = '';
      noFacilityOption.textContent = 'No Refineries configured - create one in Facilities Manager';
      noFacilityOption.disabled = true;
      facilitySelect.appendChild(noFacilityOption);
      return;
    }

    refineryFacilities.forEach(facility => {
      const option = document.createElement('option');
      option.value = facility.id;
      option.textContent = facility.name;
      facilitySelect.appendChild(option);
    });

    console.log(`Loaded ${refineryFacilities.length} refinery facilities`);
  } catch (error) {
    console.error('Error loading facilities:', error);
  }
}

/**
 * Handle reaction search input (debounced)
 */
function handleReactionSearch(e) {
  clearTimeout(searchTimeout);
  const searchTerm = e.target.value.trim();

  if (searchTerm.length < 2) {
    hideSearchResults();
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const reactions = await window.electronAPI.reactions.searchReactions(searchTerm, 50);
      displaySearchResults(reactions);
    } catch (error) {
      console.error('Error searching reactions:', error);
      hideSearchResults();
    }
  }, 300); // 300ms debounce
}

/**
 * Display search results
 */
function displaySearchResults(reactions) {
  const resultsContainer = document.getElementById('search-results');

  if (!reactions || reactions.length === 0) {
    resultsContainer.innerHTML = '<div class="search-result-item">No reactions found</div>';
    resultsContainer.classList.remove('hidden');
    return;
  }

  resultsContainer.innerHTML = reactions.map(r => `
    <div class="search-result-item" data-reaction-id="${r.typeID}">
      <div class="search-result-name">${r.typeName}</div>
      <div class="search-result-details">
        Produces: ${r.productName} × ${r.productQuantity}
      </div>
    </div>
  `).join('');

  // Add click handlers
  resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const reactionId = parseInt(item.getAttribute('data-reaction-id'));
      selectReaction(reactionId);
    });
  });

  resultsContainer.classList.remove('hidden');
}

/**
 * Hide search results
 */
function hideSearchResults() {
  const resultsContainer = document.getElementById('search-results');
  resultsContainer.classList.add('hidden');
}

/**
 * Select a reaction formula
 */
async function selectReaction(reactionTypeId) {
  try {
    hideSearchResults();

    // Get reaction product
    const product = await window.electronAPI.reactions.getReactionProduct(reactionTypeId);
    if (!product) {
      console.error('Reaction not found:', reactionTypeId);
      alert('Reaction formula not found');
      return;
    }

    const reactionName = await window.electronAPI.reactions.getTypeName(reactionTypeId);
    const productName = await window.electronAPI.reactions.getTypeName(product.typeID);
    const reactionTime = await window.electronAPI.reactions.getReactionTime(reactionTypeId);

    currentReaction = {
      typeID: reactionTypeId,
      typeName: reactionName,
      product: {
        typeID: product.typeID,
        typeName: productName,
        quantity: product.quantity
      },
      time: reactionTime || 3600
    };

    // Update UI
    document.getElementById('reaction-name').textContent = reactionName;
    document.getElementById('product-name').textContent = productName;
    document.getElementById('base-quantity').textContent = product.quantity;
    document.getElementById('reaction-time').textContent = formatTime(reactionTime || 3600);

    // Reset runs to 1
    document.getElementById('runs').value = 1;

    // Clear backend caches
    await window.electronAPI.reactions.clearCaches();

    // Show reaction display, hide empty state
    document.getElementById('reaction-display').classList.remove('hidden');
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('materials-display').classList.add('hidden');

    console.log('Selected reaction:', currentReaction);
  } catch (error) {
    console.error('Error selecting reaction:', error);
    alert('Failed to load reaction: ' + error.message);
  }
}

/**
 * Handle calculate button click
 */
async function handleCalculate() {
  if (!currentReaction) {
    return;
  }

  const runs = parseInt(document.getElementById('runs').value) || 1;

  if (runs < 1) {
    alert('Runs must be at least 1');
    return;
  }

  showLoading();

  try {
    const characterId = currentDefaultCharacterId || null;
    const facilityId = document.getElementById('facility-select').value || null;

    const startTime = performance.now();

    console.log(`[Reaction Calculation] Starting for ${currentReaction.typeName}, runs: ${runs}, facility: ${facilityId || 'none'}`);

    const result = await window.electronAPI.reactions.calculateMaterials(
      currentReaction.typeID,
      runs,
      characterId,
      facilityId
    );

    const elapsedTime = performance.now() - startTime;
    console.log(`[Reaction Calculation] Completed in ${elapsedTime.toFixed(2)}ms`);
    console.log('[Reaction Result]', result);

    if (result.error) {
      throw new Error(result.error);
    }

    // Display results
    await displayReactionResults(result, runs, facilityId);

    hideLoading();
  } catch (error) {
    console.error('Error calculating reaction:', error);
    hideLoading();
    alert('Failed to calculate reaction: ' + error.message);
  }
}

/**
 * Display reaction calculation results
 */
async function displayReactionResults(result, runs, facilityId) {
  const materialsDisplay = document.getElementById('materials-display');
  materialsDisplay.classList.remove('hidden');

  // Display facility bonuses if facility selected
  if (facilityId) {
    await displayFacilityBonuses(facilityId);
  } else {
    document.getElementById('facility-bonuses').style.display = 'none';
  }

  // Display production time
  if (result.time) {
    displayProductionTime(result.time);
  } else {
    document.getElementById('production-time-section').style.display = 'none';
  }

  // Display reaction tree (CRITICAL: Tree visualization)
  displayReactionTree(result.tree, result.product);

  // Display total raw materials summary (with pricing if available)
  displayTotalMaterials(result.materials, result.pricing);

  // Display pricing if available (future feature)
  if (result.pricing) {
    displayPricingInformation(result.pricing);
  } else {
    document.getElementById('pricing-display').style.display = 'none';
  }
}

/**
 * Display production time with bonuses
 */
function displayProductionTime(timeData) {
  const section = document.getElementById('production-time-section');
  const baseTimeEl = document.getElementById('base-time');
  const totalTimeEl = document.getElementById('total-time');

  if (!timeData) {
    section.style.display = 'none';
    return;
  }

  // Format base time (per run)
  const baseTimeFormatted = formatTime(timeData.baseTime);

  // Format total time (all runs with bonuses)
  const totalTimeFormatted = formatTime(timeData.totalTime);

  // Calculate time saved if there's a bonus
  const timeSaved = timeData.baseTime * timeData.runs - timeData.totalTime;
  const timeSavedFormatted = timeSaved > 0 ? ` (saved ${formatTime(timeSaved)})` : '';

  baseTimeEl.textContent = `${baseTimeFormatted} per run`;
  totalTimeEl.textContent = `${totalTimeFormatted} for ${timeData.runs} run(s)${timeSavedFormatted}`;

  section.style.display = 'block';
}

/**
 * CRITICAL FUNCTION: Display reaction tree with visual hierarchy
 * Uses recursive rendering to show nested structure
 */
function displayReactionTree(treeNodes, finalProduct) {
  const treeContainer = document.getElementById('reaction-tree');

  // Build tree HTML recursively
  const treeHTML = buildTreeHTML(treeNodes, 0, finalProduct);

  treeContainer.innerHTML = `
    <div class="tree-root">
      <div class="tree-node tree-node-product depth-0">
        <div class="tree-node-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
        </div>
        <div class="tree-node-content">
          <div class="tree-node-name">${finalProduct.typeName}</div>
          <div class="tree-node-quantity">× ${finalProduct.quantity.toLocaleString()}</div>
        </div>
      </div>
      ${treeHTML}
    </div>
  `;
}

/**
 * Recursively build tree HTML
 * @param {Array} nodes - Tree nodes
 * @param {number} depth - Current depth level
 * @param {Object} parentProduct - Parent product (for context)
 * @returns {string} HTML string
 */
function buildTreeHTML(nodes, depth, parentProduct) {
  if (!nodes || nodes.length === 0) {
    return '';
  }

  let html = '<div class="tree-children">';

  nodes.forEach(node => {
    const depthClass = `depth-${depth + 1}`;
    const typeClass = node.isIntermediate ? 'tree-node-intermediate' : 'tree-node-raw';

    html += `
      <div class="tree-node ${typeClass} ${depthClass}">
        <div class="tree-connector"></div>
        <div class="tree-node-icon">
          ${node.isIntermediate ? `
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="8"></circle>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
          ` : `
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            </svg>
          `}
        </div>
        <div class="tree-node-content">
          <div class="tree-node-info">
            <div class="tree-node-name">
              ${node.typeName}
              ${node.isIntermediate ?
                `<span class="tree-node-badge badge-intermediate">Intermediate</span>` :
                `<span class="tree-node-badge badge-raw">Raw</span>`
              }
            </div>
            ${node.isIntermediate ? `<div class="tree-node-formula">${node.reactionName}</div>` : ''}
          </div>
          <div class="tree-node-quantity">× ${node.quantity.toLocaleString()}</div>
        </div>
      </div>
    `;

    // Recursively render children
    if (node.children && node.children.length > 0) {
      html += buildTreeHTML(node.children, depth + 1, node);
    }
  });

  html += '</div>';
  return html;
}

/**
 * Display total raw materials (flat summary)
 */
async function displayTotalMaterials(materials, pricing = null) {
  const container = document.getElementById('total-materials');

  const formatISK = (value) => {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Get type names and build list with pricing info
  const materialsList = [];
  for (const [typeIdStr, qty] of Object.entries(materials)) {
    const typeId = parseInt(typeIdStr);
    let typeName = typeNameCache.get(typeId);

    if (!typeName) {
      try {
        typeName = await window.electronAPI.reactions.getTypeName(typeId);
        typeNameCache.set(typeId, typeName);
      } catch (error) {
        console.error(`Error getting type name for ${typeId}:`, error);
        typeName = `Unknown Type ${typeId}`;
      }
    }

    // Get pricing info if available
    const priceData = pricing?.inputCosts?.materialPrices?.[typeIdStr];

    materialsList.push({
      typeId,
      typeName,
      quantity: qty,
      unitPrice: priceData?.unitPrice || 0,
      totalPrice: priceData?.totalPrice || 0,
      hasPrice: priceData?.hasPrice || false
    });
  }

  // Sort by quantity descending
  materialsList.sort((a, b) => b.quantity - a.quantity);

  // Build HTML
  let html = '';

  if (pricing && pricing.inputCosts && pricing.inputCosts.materialPrices) {
    // Display with pricing information
    html = materialsList.map(mat => `
      <div class="material-item-with-price">
        <div class="material-basic-info">
          <img src="https://images.evetech.net/types/${mat.typeId}/icon?size=32"
               alt="${mat.typeName}"
               class="material-icon"
               onerror="this.style.display='none'">
          <div class="material-name">${mat.typeName}</div>
        </div>
        <div class="material-price-info">
          <div class="material-quantity-price">
            ${mat.quantity.toLocaleString()}x @ ${formatISK(mat.unitPrice)} ISK
          </div>
          <div class="material-total-cost">
            ${formatISK(mat.totalPrice)} ISK
          </div>
        </div>
      </div>
    `).join('');

    // Add total cost summary
    const totalCost = pricing.inputCosts.totalCost || 0;
    html += `
      <div class="materials-total-cost">
        <span><strong>Total Materials Cost:</strong></span>
        <span class="total-cost-value"><strong>${formatISK(totalCost)} ISK</strong></span>
      </div>
    `;

    // Add warning if some prices are missing
    if (pricing.inputCosts.itemsWithoutPrices > 0) {
      html += `
        <div class="materials-price-warning">
          ⚠️ ${pricing.inputCosts.itemsWithoutPrices} material(s) missing price data
        </div>
      `;
    }
  } else {
    // Display without pricing (quantity only)
    html = materialsList.map(mat => `
      <div class="material-item">
        <img src="https://images.evetech.net/types/${mat.typeId}/icon?size=32"
             alt="${mat.typeName}"
             class="material-icon"
             onerror="this.style.display='none'">
        <div class="material-info">
          <div class="material-name">${mat.typeName}</div>
        </div>
        <div class="material-quantity">× ${mat.quantity.toLocaleString()}</div>
      </div>
    `).join('');
  }

  container.innerHTML = html;
}

/**
 * Display facility bonuses
 */
async function displayFacilityBonuses(facilityId) {
  try {
    const bonusesSection = document.getElementById('facility-bonuses');
    const bonusesContent = document.getElementById('facility-bonuses-content');

    const facility = await window.electronAPI.facilities.getFacility(facilityId);
    if (!facility) {
      bonusesSection.style.display = 'none';
      return;
    }

    const bonuses = await window.electronAPI.facilities.getStructureBonuses(facility.structureTypeId);

    bonusesContent.innerHTML = `
      <div class="bonus-item">
        <div class="bonus-label">Structure</div>
        <div class="bonus-value">${facility.name} (${bonuses.structureName})</div>
      </div>
      <div class="bonus-item">
        <div class="bonus-label">Material Reduction</div>
        <div class="bonus-value">${bonuses.materialEfficiency}%</div>
      </div>
      <div class="bonus-item">
        <div class="bonus-label">Time Reduction</div>
        <div class="bonus-value">${bonuses.timeEfficiency}%</div>
      </div>
      <div class="bonus-item">
        <div class="bonus-label">Cost Reduction</div>
        <div class="bonus-value">${bonuses.costReduction}%</div>
      </div>
    `;

    bonusesSection.style.display = 'block';
  } catch (error) {
    console.error('Error displaying facility bonuses:', error);
  }
}

/**
 * Display pricing information (future feature)
 */
function displayPricingInformation(pricing) {
  const pricingDisplay = document.getElementById('pricing-display');
  const pricingContent = document.getElementById('pricing-content');

  const inputCosts = pricing.inputCosts?.totalCost || 0;
  const outputValue = pricing.outputValue?.totalValue || 0;
  const totalCost = pricing.totalCost || 0;
  const profit = pricing.profit || 0;
  const profitMargin = pricing.profitMargin || 0;

  const formatISK = (value) => {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  let html = '<div class="pricing-grid">';

  // Summary Cards
  html += `
    <div class="pricing-card">
      <h5>Material Costs</h5>
      <div class="pricing-value">${formatISK(inputCosts)} ISK</div>
    </div>
    <div class="pricing-card">
      <h5>Output Value</h5>
      <div class="pricing-value">${formatISK(outputValue)} ISK</div>
    </div>
    <div class="pricing-card ${profit >= 0 ? 'pricing-positive' : 'pricing-negative'}">
      <h5>Profit</h5>
      <div class="pricing-value">${profit >= 0 ? '+' : ''}${formatISK(profit)} ISK</div>
      <div class="pricing-secondary">${profitMargin.toFixed(2)}% margin</div>
    </div>
  `;

  html += '</div>'; // Close pricing-grid

  // Job Cost Breakdown
  if (pricing.jobCostBreakdown) {
    const jcb = pricing.jobCostBreakdown;

    html += '<div class="job-cost-section">';
    html += '<h4>Reaction Job Fees & Taxes</h4>';

    html += '<div class="job-cost-breakdown">';

    // Job Cost Details
    html += '<div class="job-cost-group">';
    html += '<h5>Job Installation Cost</h5>';

    html += `<div class="job-cost-row">`;
    html += `<span class="job-cost-label">Estimated Item Value (EIV):</span>`;
    html += `<span class="job-cost-value">${formatISK(jcb.estimatedItemValue)} ISK</span>`;
    html += `</div>`;

    html += `<div class="job-cost-row">`;
    html += `<span class="job-cost-label">System Cost Index (Reaction):</span>`;
    html += `<span class="job-cost-value">${(jcb.systemCostIndex * 100).toFixed(2)}%</span>`;
    html += `</div>`;

    html += `<div class="job-cost-row">`;
    html += `<span class="job-cost-label">Job Gross Cost:</span>`;
    html += `<span class="job-cost-value">${formatISK(jcb.jobGrossCost)} ISK</span>`;
    html += `</div>`;

    html += `<div class="job-cost-row job-cost-subtotal">`;
    html += `<span class="job-cost-label"><strong>Job Base Cost:</strong></span>`;
    html += `<span class="job-cost-value"><strong>${formatISK(jcb.jobBaseCost)} ISK</strong></span>`;
    html += `</div>`;

    html += '</div>'; // Close job-cost-group

    // Taxes
    html += '<div class="job-cost-group">';
    html += '<h5>Installation Taxes</h5>';

    html += `<div class="job-cost-row">`;
    html += `<span class="job-cost-label">Facility Tax (${jcb.facilityTaxRate.toFixed(2)}%):</span>`;
    html += `<span class="job-cost-value">${formatISK(jcb.facilityTax)} ISK</span>`;
    html += `</div>`;

    html += `<div class="job-cost-row">`;
    html += `<span class="job-cost-label">SCC Surcharge (4%):</span>`;
    html += `<span class="job-cost-value">${formatISK(jcb.sccSurcharge)} ISK</span>`;
    html += `</div>`;

    html += '</div>'; // Close job-cost-group

    // Total
    html += '<div class="job-cost-total">';
    html += `<div class="job-cost-row">`;
    html += `<span class="job-cost-label"><strong>Total Job Cost:</strong></span>`;
    html += `<span class="job-cost-value"><strong>${formatISK(jcb.totalJobCost)} ISK</strong></span>`;
    html += `</div>`;
    html += '</div>';

    html += '</div>'; // Close job-cost-breakdown
    html += '</div>'; // Close job-cost-section
  }

  pricingContent.innerHTML = html;
  pricingDisplay.style.display = 'block';
}

/**
 * Show loading indicator
 */
function showLoading() {
  document.getElementById('loading-indicator').classList.remove('hidden');
}

/**
 * Hide loading indicator
 */
function hideLoading() {
  document.getElementById('loading-indicator').classList.add('hidden');
}

/**
 * Handle update data button
 */
async function handleUpdateData() {
  const updateBtn = document.getElementById('update-data-btn');

  if (!updateBtn) {
    return;
  }

  // Disable button and show loading state
  const originalText = updateBtn.innerHTML;
  updateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;">
      <polyline points="23 4 23 10 17 10"></polyline>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
    </svg>
    Updating...
  `;
  updateBtn.disabled = true;

  try {
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
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Updated!
    `;

    // Clear any active calculation to force recalculation with new data
    await window.electronAPI.reactions.clearCaches();

    // Reset button after delay
    setTimeout(() => {
      updateBtn.innerHTML = originalText;
      updateBtn.disabled = false;
    }, 3000);

  } catch (error) {
    console.error('Error updating data:', error);

    // Show error state
    updateBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      Failed
    `;

    // Reset button after delay
    setTimeout(() => {
      updateBtn.innerHTML = originalText;
      updateBtn.disabled = false;
    }, 3000);

    alert('Failed to update data: ' + error.message);
  }
}

/**
 * Load and display default character avatar
 */
async function loadDefaultCharacterAvatar() {
  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();

    const avatarContainer = document.getElementById('character-avatar-container');
    const avatarImg = document.getElementById('character-avatar-img');
    const menuNameEl = document.getElementById('character-menu-name');

    if (!avatarContainer || !avatarImg || !menuNameEl) return;

    if (defaultCharacter) {
      if (currentDefaultCharacterId !== defaultCharacter.characterId) {
        currentDefaultCharacterId = defaultCharacter.characterId;
        avatarImg.src = `${defaultCharacter.portrait}?size=128`;
        avatarImg.alt = defaultCharacter.characterName;
        menuNameEl.textContent = defaultCharacter.characterName;
        avatarContainer.style.display = 'block';
        setupCharacterMenu(defaultCharacter);
      }
    } else {
      currentDefaultCharacterId = null;
      avatarContainer.style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading default character avatar:', error);
  }
}

/**
 * Setup character menu
 */
function setupCharacterMenu(defaultCharacter) {
  const avatarBtn = document.getElementById('character-avatar-btn');
  const menu = document.getElementById('character-menu');
  const menuSkills = document.getElementById('menu-skills');
  const menuBlueprints = document.getElementById('menu-blueprints');
  const menuAssets = document.getElementById('menu-assets');

  if (!avatarBtn || !menu || !menuSkills || !menuBlueprints || !menuAssets) return;

  avatarBtn.onclick = (e) => {
    e.stopPropagation();
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
  };

  menuSkills.onclick = () => {
    window.electronAPI.skills.openWindow(defaultCharacter.characterId);
    menu.style.display = 'none';
  };

  menuBlueprints.onclick = () => {
    window.electronAPI.blueprints.openWindow(defaultCharacter.characterId);
    menu.style.display = 'none';
  };

  menuAssets.onclick = () => {
    window.electronAPI.assets.openWindow(defaultCharacter.characterId);
    menu.style.display = 'none';
  };

  // Close menu when clicking outside
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

/**
 * Clean up on unload
 */
window.addEventListener('beforeunload', () => {
  if (characterMenuClickOutsideListener) {
    document.removeEventListener('click', characterMenuClickOutsideListener);
  }
});
