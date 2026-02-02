// Manufacturing Plans Renderer
// Handles UI for creating and managing manufacturing plans

// State
let allPlans = [];
let selectedPlanId = null;
let currentCharacterId = null;
let activeTab = 'overview';
let selectedBlueprintTypeId = null;
let facilities = [];
let autoRefreshInterval = null;
let bulkEditMode = false;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadCharacters();
  await loadFacilities();
  setupEventListeners();
  startAutoRefresh();
});

// Load characters into dropdown
async function loadCharacters() {
  const selector = document.getElementById('character-selector');
  const characters = await window.electronAPI.esi.getCharacters();

  selector.innerHTML = '';

  if (characters.length === 0) {
    selector.innerHTML = '<option value="">No characters found</option>';
    return;
  }

  for (const char of characters) {
    const option = document.createElement('option');
    option.value = char.characterId;
    option.textContent = char.characterName;
    selector.appendChild(option);
  }

  // Get default character
  const defaultChar = await window.electronAPI.esi.getDefaultCharacter();
  if (defaultChar) {
    selector.value = defaultChar.characterId;
    currentCharacterId = defaultChar.characterId;
    await loadPlans();
  } else if (characters.length > 0) {
    currentCharacterId = characters[0].characterId;
    selector.value = currentCharacterId;
    await loadPlans();
  }
}

// Load facilities for dropdown
async function loadFacilities() {
  facilities = await window.electronAPI.facilities.getFacilities();
}

// Setup event listeners
function setupEventListeners() {
  // Character selector
  document.getElementById('character-selector').addEventListener('change', async (e) => {
    currentCharacterId = parseInt(e.target.value);
    await loadPlans();
    showEmptyState();
  });

  // Create plan button
  document.getElementById('create-plan-btn').addEventListener('click', showCreatePlanModal);

  // Create plan modal
  document.getElementById('close-create-modal-btn').addEventListener('click', hideCreatePlanModal);
  document.getElementById('cancel-create-btn').addEventListener('click', hideCreatePlanModal);
  document.getElementById('confirm-create-btn').addEventListener('click', createPlan);

  // Plan actions
  document.getElementById('delete-plan-btn').addEventListener('click', deletePlan);
  document.getElementById('complete-plan-btn').addEventListener('click', completePlan);

  // Plan name editing
  document.getElementById('plan-name').addEventListener('blur', updatePlanName);
  document.getElementById('plan-description').addEventListener('blur', updatePlanDescription);

  // Tab switching
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', (e) => switchTab(e.target.dataset.tab));
  });

  // Blueprint tab
  document.getElementById('add-blueprint-btn').addEventListener('click', showAddBlueprintModal);
  document.getElementById('close-blueprint-modal-btn').addEventListener('click', hideAddBlueprintModal);
  document.getElementById('blueprint-search-modal').addEventListener('input', searchBlueprints);

  // Bulk edit buttons
  document.getElementById('bulk-edit-btn').addEventListener('click', enterBulkEditMode);
  document.getElementById('bulk-save-btn').addEventListener('click', saveBulkEdit);
  document.getElementById('bulk-cancel-btn').addEventListener('click', () => exitBulkEditMode(true));

  // Configure blueprint modal
  document.getElementById('close-configure-modal-btn').addEventListener('click', hideConfigureBlueprintModal);
  document.getElementById('cancel-configure-btn').addEventListener('click', hideConfigureBlueprintModal);
  document.getElementById('confirm-configure-btn').addEventListener('click', confirmAddBlueprint);

  // Update runs/line preview when runs or lines change
  document.getElementById('config-runs').addEventListener('input', updateRunsPerLinePreview);
  document.getElementById('config-lines').addEventListener('input', updateRunsPerLinePreview);

  // Materials tab
  document.getElementById('include-assets-checkbox').addEventListener('change', loadMaterials);
  document.getElementById('refresh-prices-btn').addEventListener('click', refreshPrices);

  // Jobs tab
  document.getElementById('match-jobs-btn').addEventListener('click', matchJobs);

  // Transactions tab
  document.getElementById('match-transactions-btn').addEventListener('click', matchTransactions);

  // Analytics tab
  document.getElementById('refresh-esi-data-btn').addEventListener('click', refreshESIData);

  // Refresh current view button
  document.getElementById('refresh-current-view-btn').addEventListener('click', refreshCurrentView);

  // Search and filters
  document.getElementById('plan-search').addEventListener('input', filterPlans);
  document.querySelectorAll('input[name="status-filter"]').forEach(radio => {
    radio.addEventListener('change', filterPlans);
  });
}

// Load plans for current character
async function loadPlans() {
  if (!currentCharacterId) return;

  const statusFilter = document.querySelector('input[name="status-filter"]:checked').value;
  const filters = statusFilter === 'all' ? {} : { status: statusFilter };

  allPlans = await window.electronAPI.plans.getAll(currentCharacterId, filters);
  renderPlansList();
}

// Render plans list
function renderPlansList() {
  const container = document.getElementById('plans-list');
  const searchTerm = document.getElementById('plan-search').value.toLowerCase();

  const filteredPlans = allPlans.filter(plan =>
    plan.planName.toLowerCase().includes(searchTerm)
  );

  if (filteredPlans.length === 0) {
    container.innerHTML = '<div class="loading">No plans found</div>';
    return;
  }

  container.innerHTML = filteredPlans.map(plan => {
    const created = new Date(plan.createdAt);
    return `
      <div class="plan-card ${plan.planId === selectedPlanId ? 'selected' : ''}" data-plan-id="${plan.planId}">
        <div class="plan-card-header">
          <div>
            <div class="plan-card-name">${escapeHtml(plan.planName)}</div>
            <div class="plan-card-date">${created.toLocaleDateString()} ${created.toLocaleTimeString()}</div>
          </div>
          <span class="status-badge ${plan.status}">${plan.status}</span>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  container.querySelectorAll('.plan-card').forEach(card => {
    card.addEventListener('click', () => selectPlan(card.dataset.planId));
  });
}

// Select a plan
async function selectPlan(planId) {
  selectedPlanId = planId;
  renderPlansList();
  await loadPlanDetails();
}

// Load and display plan details
async function loadPlanDetails() {
  if (!selectedPlanId) {
    showEmptyState();
    return;
  }

  const plan = await window.electronAPI.plans.get(selectedPlanId);
  if (!plan) {
    showEmptyState();
    return;
  }

  // Show detail view
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('plan-detail').style.display = 'flex';

  // Update header
  document.getElementById('plan-name').textContent = plan.planName;
  document.getElementById('plan-status').textContent = plan.status;
  document.getElementById('plan-status').className = `status-badge ${plan.status}`;

  const created = new Date(plan.createdAt);
  document.getElementById('plan-created').textContent = `Created: ${created.toLocaleDateString()} ${created.toLocaleTimeString()}`;
  document.getElementById('plan-description').value = plan.description || '';

  // Update reactions tab visibility
  await updateReactionsTabVisibility();

  // Load current tab content
  await loadTabContent(activeTab);
}

/**
 * Update Reactions tab visibility based on settings and reactions presence
 */
async function updateReactionsTabVisibility() {
  if (!selectedPlanId) return;

  try {
    const planSettings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    const reactions = await window.electronAPI.plans.getReactions(selectedPlanId);

    const reactionsTab = document.getElementById('reactions-tab-button');
    const showTab = planSettings.reactionsAsIntermediates;
    reactionsTab.style.display = showTab ? 'block' : 'none';
  } catch (error) {
    console.error('Error updating reactions tab visibility:', error);
  }
}

// Show empty state
function showEmptyState() {
  selectedPlanId = null;
  document.getElementById('empty-state').style.display = 'flex';
  document.getElementById('plan-detail').style.display = 'none';
}

// Switch tabs
async function switchTab(tabName) {
  activeTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.remove('active');
  });
  document.getElementById(`${tabName}-tab`).classList.add('active');

  // Load tab content
  await loadTabContent(tabName);
}

// Load tab content
async function loadTabContent(tabName) {
  if (!selectedPlanId) return;

  switch (tabName) {
    case 'overview':
      await loadOverview();
      break;
    case 'blueprints':
      await loadBlueprints();
      break;
    case 'materials':
      await loadMaterials();
      break;
    case 'products':
      await loadProducts();
      break;
    case 'reactions':
      await loadReactions();
      break;
    case 'jobs':
      await loadJobs();
      break;
    case 'transactions':
      await loadTransactions();
      break;
    case 'analytics':
      await loadAnalytics();
      break;
    case 'settings':
      await loadSettings();
      break;
  }
}

// Load overview tab
async function loadOverview() {
  const summary = await window.electronAPI.plans.getSummary(selectedPlanId);

  document.getElementById('overview-material-cost').textContent = formatISK(summary.materialCost);
  document.getElementById('overview-material-meta').textContent = `${summary.materialsWithPrice}/${summary.totalMaterials} priced`;

  document.getElementById('overview-product-value').textContent = formatISK(summary.productValue);
  document.getElementById('overview-product-meta').textContent = `${summary.productsWithPrice}/${summary.totalProducts} priced`;

  const profit = summary.estimatedProfit;
  const profitEl = document.getElementById('overview-profit');
  profitEl.textContent = formatISK(profit);
  profitEl.style.color = profit >= 0 ? '#57f287' : '#ed4245';

  document.getElementById('overview-roi').textContent = `${summary.roi.toFixed(1)}% ROI`;
}

// Load blueprints tab
async function loadBlueprints() {
  const blueprints = await window.electronAPI.plans.getBlueprints(selectedPlanId);
  const allIntermediates = await window.electronAPI.plans.getAllIntermediates(selectedPlanId);
  const container = document.getElementById('blueprints-list-tab');

  // Filter out intermediate blueprints - only use top-level blueprints for hierarchy
  // Intermediate blueprints are already fetched separately and will be rendered as sub-rows
  const topLevelBlueprints = blueprints.filter(bp =>
    !allIntermediates.some(ib => ib.planBlueprintId === bp.planBlueprintId)
  );

  if (topLevelBlueprints.length === 0) {
    container.innerHTML = '<div class="loading">No blueprints in this plan. Click "Add Blueprint" to get started.</div>';
    return;
  }

  // Get blueprint names for top-level and intermediates
  const allTypeIds = [
    ...topLevelBlueprints.map(bp => bp.blueprintTypeId),
    ...allIntermediates.map(ib => ib.blueprintTypeId)
  ];
  const names = await window.electronAPI.sde.getBlueprintNames(allTypeIds);

  // Get product names for intermediates
  const productTypeIds = allIntermediates.map(ib => ib.intermediateProductTypeId).filter(Boolean);
  const productNames = productTypeIds.length > 0
    ? await window.electronAPI.sde.getTypeNames(productTypeIds)
    : {};

  // Build hierarchical structure with recursive intermediate nesting
  function buildIntermediateTree(parentId, depth = 1) {
    const children = allIntermediates
      .filter(ib => ib.parentBlueprintId === parentId)
      .sort((a, b) => b.runs - a.runs); // Sort by runs descending
    return children.map(child => ({
      intermediate: child,
      depth: depth,
      children: buildIntermediateTree(child.planBlueprintId, depth + 1)
    }));
  }

  const hierarchy = topLevelBlueprints.map(bp => ({
    blueprint: bp,
    intermediates: buildIntermediateTree(bp.planBlueprintId, 1)
  }));

  let html = '<table><thead><tr>';
  html += '<th>Blueprint</th>';
  html += '<th>Runs <span class="info-icon" title="Total manufacturing runs to complete. Materials are calculated per-line, then summed across all lines.">&#9432;</span></th>';
  html += '<th>Lines <span class="info-icon" title="Number of parallel production lines. Runs are split across lines (ceil(Runs / Lines) per line). ME efficiency floor is applied per-line.">&#9432;</span></th>';
  html += '<th>ME</th><th>TE</th>';
  html += '<th>Facility</th><th>';
  html += 'Build Plan';
  html += '<span class="info-icon" title="Raw Materials: Expand all intermediate blueprints to raw materials&#10;Buy Components: Purchase component-level materials from market&#10;Buy Intermediate: Purchase the finished intermediate product directly from market&#10;Build/Buy: AI-optimized building vs buying (coming in a future update)">ⓘ</span>';
  html += '</th><th>Actions</th>';
  html += '</tr></thead><tbody>';

  for (const { blueprint, intermediates } of hierarchy) {
    const name = names[blueprint.blueprintTypeId] || `Type ${blueprint.blueprintTypeId}`;
    const facilityName = blueprint.facilitySnapshot ? (blueprint.facilitySnapshot.name || 'Unknown') : 'None';
    const facilityId = blueprint.facilityId || '';

    // Top-level blueprint row
    // Calculate runs per line for display hint
    const runsPerLine = Math.ceil(blueprint.runs / blueprint.lines);

    html += `
      <tr data-blueprint-id="${blueprint.planBlueprintId}" data-editing="false" class="top-level-blueprint">
        <td><strong>${escapeHtml(name)}</strong></td>
        <td class="editable-cell" data-field="runs">
          <span class="cell-value">${blueprint.runs}</span>
          <input type="number" class="cell-input" value="${blueprint.runs}" min="1" style="display: none;">
        </td>
        <td class="editable-cell" data-field="lines">
          <span class="cell-value">${blueprint.lines}<span class="runs-per-line-hint">(${runsPerLine}/line)</span></span>
          <input type="number" class="cell-input" value="${blueprint.lines}" min="1" style="display: none;">
        </td>
        <td class="editable-cell" data-field="meLevel">
          <span class="cell-value">${blueprint.meLevel}</span>
          <input type="number" class="cell-input" value="${blueprint.meLevel}" min="0" max="10" style="display: none;">
        </td>
        <td class="editable-cell" data-field="teLevel">
          <span class="cell-value">${blueprint.teLevel || 0}</span>
          <input type="number" class="cell-input" value="${blueprint.teLevel || 0}" min="0" max="20" style="display: none;">
        </td>
        <td class="editable-cell" data-field="facilityId">
          <span class="cell-value">${escapeHtml(facilityName)}</span>
          <select class="cell-input" style="display: none;">
            <option value="">No facility</option>
            ${facilities.map(f => `<option value="${f.id}" ${f.id === facilityId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
          </select>
        </td>
        <td class="editable-cell" data-field="useIntermediates">
          <span class="cell-value">${blueprint.useIntermediates === 'raw_materials' ? 'Raw Materials' : blueprint.useIntermediates === 'components' ? 'Buy Components' : blueprint.useIntermediates === 'buy' ? 'Buy Intermediate' : blueprint.useIntermediates === 'build_buy' ? 'Build/Buy' : 'Raw Materials'}</span>
          <select class="cell-input" style="display: none;">
            <option value="raw_materials" ${(!blueprint.useIntermediates || blueprint.useIntermediates === 'raw_materials') ? 'selected' : ''}>Raw Materials</option>
            <option value="components" ${blueprint.useIntermediates === 'components' ? 'selected' : ''}>Buy Components</option>
            <option value="buy" ${blueprint.useIntermediates === 'buy' ? 'selected' : ''}>Buy Intermediate</option>
            <option value="build_buy" ${blueprint.useIntermediates === 'build_buy' ? 'selected' : ''} disabled>Build/Buy (Coming in a future update)</option>
          </select>
        </td>
        <td class="blueprint-actions">
          <button class="secondary-button small edit-btn" data-action="edit">Edit</button>
          <button class="primary-button small save-btn" data-action="save" style="display: none;">Save</button>
          <button class="secondary-button small cancel-btn" data-action="cancel" style="display: none;">Cancel</button>
          <button class="secondary-button small remove-btn" data-action="remove">Remove</button>
        </td>
      </tr>
    `;

    // Recursive function to render intermediate blueprint rows with proper depth indentation
    function renderIntermediates(intermediateTree) {
      for (const node of intermediateTree) {
        const intermediate = node.intermediate;
        const depth = node.depth;
        const indentPx = 16 + (depth * 20); // Base 16px + 20px per depth level

        const intName = names[intermediate.blueprintTypeId] || `Type ${intermediate.blueprintTypeId}`;
        const intProductName = productNames[intermediate.intermediateProductTypeId] || `Type ${intermediate.intermediateProductTypeId}`;
        const intFacilityName = intermediate.facilitySnapshot ? (intermediate.facilitySnapshot.name || 'Unknown') : 'None';
        const intFacilityId = intermediate.facilityId || '';

        // Build status badge with partial quantity support
        let builtBadge = '';
        if (intermediate.builtRuns > 0) {
          const percentage = Math.round((intermediate.builtRuns / intermediate.runs) * 100);
          const statusClass = intermediate.builtRuns >= intermediate.runs ? 'fully-built' : 'partially-built';
          builtBadge = `<span class="status-badge ${statusClass}" title="${intermediate.builtRuns} of ${intermediate.runs} runs built">
            ${intermediate.builtRuns}/${intermediate.runs} Built (${percentage}%)
          </span>`;
        }

        // intermediate.runs already contains the correct number of runs needed
        const runsNeeded = intermediate.runs;

        // Calculate total products that will be produced
        const productsPerRun = intermediate.productQuantityPerRun || 1;
        const totalProductsProduced = runsNeeded * productsPerRun;

        // Create indent arrow based on depth
        const arrow = '↳' + '\u00A0'.repeat(depth - 1); // Arrow + non-breaking spaces for nested levels

        html += `
          <tr data-blueprint-id="${intermediate.planBlueprintId}" data-editing="false" class="intermediate-blueprint" data-depth="${depth}">
            <td style="padding-left: ${indentPx}px;">
              ${arrow} ${escapeHtml(intName)} ${builtBadge}
              <div style="font-size: 11px; color: #72767d;">Product: ${totalProductsProduced.toLocaleString()}x ${escapeHtml(intProductName)}</div>
            </td>
            <td>${runsNeeded.toLocaleString()}</td>
            <td><span style="color: #72767d;">-</span></td>
            <td class="editable-cell" data-field="meLevel">
              <span class="cell-value">${intermediate.meLevel}</span>
              <input type="number" class="cell-input" value="${intermediate.meLevel}" min="0" max="10" style="display: none;">
            </td>
            <td class="editable-cell" data-field="teLevel">
              <span class="cell-value">${intermediate.teLevel || 0}</span>
              <input type="number" class="cell-input" value="${intermediate.teLevel || 0}" min="0" max="20" style="display: none;">
            </td>
            <td class="editable-cell" data-field="facilityId">
              <span class="cell-value">${escapeHtml(intFacilityName)}</span>
              <select class="cell-input" style="display: none;">
                <option value="">No facility</option>
                ${facilities.map(f => `<option value="${f.id}" ${f.id === intFacilityId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
              </select>
            </td>
            <td class="editable-cell" data-field="useIntermediates">
              <span class="cell-value">
                ${intermediate.useIntermediates === 'components' ? 'Buy Components' :
                  intermediate.useIntermediates === 'buy' ? 'Buy Intermediate' :
                  intermediate.useIntermediates === 'build_buy' ? 'Build/Buy' : 'Raw Materials'}
              </span>
              <select class="cell-input" style="display: none;">
                <option value="raw_materials" ${(!intermediate.useIntermediates || intermediate.useIntermediates === 'raw_materials') ? 'selected' : ''}>Raw Materials</option>
                <option value="components" ${intermediate.useIntermediates === 'components' ? 'selected' : ''}>Buy Components</option>
                <option value="buy" ${intermediate.useIntermediates === 'buy' ? 'selected' : ''}>Buy Intermediate</option>
                <option value="build_buy" ${intermediate.useIntermediates === 'build_buy' ? 'selected' : ''} disabled>Build/Buy (Coming in a future update)</option>
              </select>
            </td>
            <td class="blueprint-actions">
              <button class="secondary-button small toggle-built-btn" data-action="toggle-built" data-is-built="${intermediate.isBuilt ? '1' : '0'}">
                ${intermediate.builtRuns > 0 ? 'Edit Built Qty' : 'Mark Built'}
              </button>
              <button class="secondary-button small edit-btn" data-action="edit">Edit</button>
              <button class="primary-button small save-btn" data-action="save" style="display: none;">Save</button>
              <button class="secondary-button small cancel-btn" data-action="cancel" style="display: none;">Cancel</button>
            </td>
          </tr>
        `;

        // Recursively render children
        if (node.children && node.children.length > 0) {
          renderIntermediates(node.children);
        }
      }
    }

    // Render all intermediates recursively
    renderIntermediates(intermediates);
  }

  html += '</tbody></table>';
  container.innerHTML = html;

  // Add event listeners for top-level blueprint actions
  container.querySelectorAll('.top-level-blueprint').forEach(row => {
    const blueprintId = row.dataset.blueprintId;
    row.querySelector('[data-action="edit"]')?.addEventListener('click', () => editBlueprint(blueprintId));
    row.querySelector('[data-action="save"]')?.addEventListener('click', () => saveBlueprintEdit(blueprintId));
    row.querySelector('[data-action="cancel"]')?.addEventListener('click', () => cancelBlueprintEdit(blueprintId));
    row.querySelector('[data-action="remove"]')?.addEventListener('click', () => removeBlueprint(blueprintId));
  });

  // Add event listeners for intermediate blueprint actions
  container.querySelectorAll('.intermediate-blueprint').forEach(row => {
    const blueprintId = row.dataset.blueprintId;
    row.querySelector('[data-action="toggle-built"]')?.addEventListener('click', (e) => toggleIntermediateBuilt(blueprintId, e.target.dataset.isBuilt === '1'));
    row.querySelector('[data-action="edit"]')?.addEventListener('click', () => editIntermediateBlueprint(blueprintId));
    row.querySelector('[data-action="save"]')?.addEventListener('click', () => saveIntermediateBlueprintEdit(blueprintId));
    row.querySelector('[data-action="cancel"]')?.addEventListener('click', () => cancelIntermediateBlueprintEdit(blueprintId));
  });
}

/**
 * Categorize a material based on its category and group IDs
 * @param {Object} categoryInfo - { categoryID, groupID }
 * @returns {string} Category name: 'Minerals', 'Reaction Materials', 'Planetary Materials', or 'Other'
 */
function categorizeMaterial(categoryInfo) {
  const { categoryID, groupID } = categoryInfo;

  // Minerals: categoryID = 4 AND groupID = 18
  if (categoryID === 4 && ([18, 422, 423].includes(groupID))) {
    return 'Minerals';
  }

  // Reaction Materials:
  // - categoryID = 4 AND (groupID = 427 OR groupID = 428) (moon materials + intermediates)
  // - OR categoryID = 24 (all reaction outputs)
  if ((categoryID === 4 && ([427, 428, 429, 967, 974, 4096].includes(groupID))) || categoryID === 24) {
    return 'Reaction Materials';
  }

  // Planetary Materials: categoryID = 42 OR categoryID = 43
  if (categoryID === 42 || categoryID === 43) {
    return 'Planetary Materials';
  }

  // Salvage Materials:
  if ((categoryID === 4 && ([754, 866].includes(groupID)))) {
    return 'Salvage Materials';
  }

  // Gas Cloud Materials: groupID = 711 (Harvestable Cloud)
  if (groupID === 711) {
    return 'Gas Cloud Materials';
  }

  // Everything else
  return 'Other';
}

/**
 * Group materials by category
 * @param {Array} materials - Array of material objects
 * @param {Object} categoryInfoMap - Map of typeId -> category info
 * @returns {Object} Grouped materials: { 'Minerals': [...], 'Reaction Materials': [...], ... }
 */
function groupMaterialsByCategory(materials, categoryInfoMap) {
  const groups = {
    'Minerals': [],
    'Reaction Materials': [],
    'Planetary Materials': [],
    'Gas Cloud Materials': [],
    'Salvage Materials': [],
    'Other': []
  };

  for (const material of materials) {
    const categoryInfo = categoryInfoMap[material.typeId] || {};
    const category = categorizeMaterial(categoryInfo);
    groups[category].push(material);
  }

  // Sort each group by quantity DESC (preserve original sorting)
  for (const category in groups) {
    groups[category].sort((a, b) => b.quantity - a.quantity);
  }

  return groups;
}

/**
 * Toggle category visibility
 * @param {string} category - Category name
 */
window.toggleCategory = function(category) {
  const contentId = `category-${category.replace(/\s+/g, '-')}`;
  const content = document.getElementById(contentId);
  if (content) {
    content.classList.toggle('collapsed');
  }
}

// Load materials tab
async function loadMaterials() {
  const includeAssets = document.getElementById('include-assets-checkbox').checked;
  const materials = await window.electronAPI.plans.getMaterials(selectedPlanId, includeAssets);
  const container = document.getElementById('materials-list-tab');

  if (materials.length === 0) {
    container.innerHTML = '<div class="loading">No materials calculated. Add blueprints to this plan.</div>';
    return;
  }

  // Get material names, volumes, and category info
  const typeIds = materials.map(m => m.typeId);
  const [names, volumes, categoryInfo] = await Promise.all([
    window.electronAPI.sde.getTypeNames(typeIds),
    window.electronAPI.sde.getItemVolumes(typeIds),
    window.electronAPI.sde.getTypeCategoryInfo(typeIds)
  ]);

  // Group materials by category
  const groupedMaterials = groupMaterialsByCategory(materials, categoryInfo);

  // Category display order
  const categoryOrder = ['Minerals', 'Reaction Materials', 'Planetary Materials', 'Gas Cloud Materials', 'Salvage Materials', 'Other'];

  // Build HTML with collapsible category sections
  let html = '';

  for (const category of categoryOrder) {
    const categoryMaterials = groupedMaterials[category];

    // Skip empty categories
    if (categoryMaterials.length === 0) {
      continue;
    }

    // Calculate category totals
    let categoryTotalCost = 0;
    let categoryTotalVolume = 0;
    let categoryItemCount = categoryMaterials.length;

    categoryMaterials.forEach(m => {
      const effectivePrice = m.customPrice !== null ? m.customPrice : m.basePrice;
      if (effectivePrice) {
        categoryTotalCost += effectivePrice * m.quantity;
      }
      const volume = volumes[m.typeId] || 0;
      categoryTotalVolume += volume * m.quantity;
    });

    // Category header
    html += `
      <div class="material-category">
        <div class="category-header" data-category="${category}">
          <div class="category-title">
            <svg class="category-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <h4>${category}</h4>
            <span class="category-count">(${categoryItemCount} items)</span>
          </div>
          <div class="category-stats">
            <span class="category-stat">${formatNumber(categoryTotalVolume, 2)} m³</span>
            <span class="category-stat">${formatISK(categoryTotalCost)}</span>
          </div>
        </div>
        <div class="category-content" id="category-${category.replace(/\s+/g, '-')}">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th>Needed</th>
                <th>Still Needed</th>
                ${includeAssets ? '<th>Owned (Personal)</th><th>Owned (Corp)</th>' : ''}
                <th>M³</th>
                <th>Total M³</th>
                <th>Price</th>
                <th>Total Cost</th>
                <th>Acquisition</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
    `;

    // Render materials in category
    for (const m of categoryMaterials) {
      const name = names[m.typeId] || `Type ${m.typeId}`;
      const volume = volumes[m.typeId] || 0;
      const totalM3 = volume * m.quantity;

      // Use custom price if set, otherwise base price
      const effectivePrice = m.customPrice !== null ? m.customPrice : m.basePrice;
      const price = effectivePrice ? formatISK(effectivePrice) : 'N/A';
      const total = effectivePrice ? formatISK(effectivePrice * m.quantity) : 'N/A';

      // Acquisition status - build badges array
      const badges = [];

      // 1. Manual acquisition badge
      if (m.manuallyAcquiredQuantity > 0) {
        const methodLabel = m.acquisitionMethod
          ? m.acquisitionMethod.replace('_', ' ').toUpperCase()
          : 'MANUAL';
        const note = m.acquisitionNote || 'Manually marked as acquired';
        const hasExcess = m.manuallyAcquiredQuantity > m.quantity;
        const excessAmount = hasExcess ? m.manuallyAcquiredQuantity - m.quantity : 0;
        const badgeClass = hasExcess ? 'acquired excess' : 'acquired';
        const badgeText = hasExcess
          ? `${methodLabel}: ${formatNumber(m.manuallyAcquiredQuantity)} (${formatNumber(excessAmount)} excess)`
          : `${methodLabel}: ${formatNumber(m.manuallyAcquiredQuantity)}`;
        badges.push(`<span class="status-badge ${badgeClass}" title="${escapeHtml(note)}">${badgeText}</span>`);
      }

      // 2. Purchased badge (confirmed transactions)
      if (m.purchasedQuantity && m.purchasedQuantity > 0) {
        const title = `${m.purchaseMatchCount || 0} confirmed transaction match(es)`;
        badges.push(`<span class="status-badge purchased" title="${title}">PURCHASED: ${formatNumber(m.purchasedQuantity)}</span>`);
      }

      // 3. Manufactured badge (confirmed jobs)
      if (m.manufacturedQuantity && m.manufacturedQuantity > 0) {
        const title = `${m.manufacturingMatchCount || 0} confirmed job match(es)`;
        badges.push(`<span class="status-badge manufactured" title="${title}">MANUFACTURED: ${formatNumber(m.manufacturedQuantity)}</span>`);
      }

      // Display badges or "Not Acquired"
      const acquisitionDisplay = badges.length > 0
        ? badges.join(' ')
        : '<span class="status-badge">Not Acquired</span>';

      // Calculate total acquired and still needed
      const totalAcquired = (m.manuallyAcquiredQuantity || 0) + (m.purchasedQuantity || 0) + (m.manufacturedQuantity || 0);
      const stillNeeded = Math.max(0, m.quantity - totalAcquired);
      const isFullyAcquired = totalAcquired >= m.quantity;

      html += `
        <tr data-type-id="${m.typeId}" ${isFullyAcquired ? 'data-fully-acquired="true"' : ''}>
          <td>${escapeHtml(name)}</td>
          <td>${formatNumber(m.quantity)}</td>
          <td>${formatNumber(stillNeeded)}</td>
          ${includeAssets ? `
            <td class="owned-quantity tooltip-cell">
              ${formatNumber(m.ownedPersonal)}
              ${m.ownedPersonalDetails && m.ownedPersonalDetails.length > 0 ? `
                <span class="tooltip-text">
                  ${m.ownedPersonalDetails
                    .map(d => `<div class="tooltip-line">${escapeHtml(d.characterName)}: ${formatNumber(d.quantity)}</div>`)
                    .join('')}
                </span>
              ` : ''}
            </td>
            <td class="owned-quantity tooltip-cell">
              ${formatNumber(m.ownedCorp)}
              ${m.ownedCorpDetails && m.ownedCorpDetails.length > 0 ? `
                <span class="tooltip-text">
                  ${m.ownedCorpDetails
                    .map(d => `<div class="tooltip-line">${escapeHtml(d.corporationName)} - ${escapeHtml(d.divisionName)}: ${formatNumber(d.quantity)}</div>`)
                    .join('')}
                </span>
              ` : ''}
            </td>
          ` : ''}
          <td>${formatNumber(volume, 2)}</td>
          <td>${formatNumber(totalM3, 2)}</td>
          <td>
            ${m.customPrice !== null ? '<span class="custom-price-indicator" title="Custom price set">⚙️</span> ' : ''}
            ${price}
          </td>
          <td>${total}</td>
          <td>${acquisitionDisplay}</td>
          <td>
            ${m.manuallyAcquiredQuantity > 0 ? `
              <button class="secondary-button small edit-acquisition-btn"
                data-type-id="${m.typeId}"
                data-material-name="${escapeHtml(name)}"
                data-quantity-needed="${m.quantity}"
                data-already-acquired="${totalAcquired}"
                data-manual-quantity="${m.manuallyAcquiredQuantity}"
                data-still-needed="${Math.max(0, m.quantity - totalAcquired)}">Edit Acquisition</button>
              <button class="secondary-button small unmark-btn" data-type-id="${m.typeId}">Remove Manual</button>
              ${m.manuallyAcquiredQuantity > m.quantity ? `
                <button class="warning-button small cleanup-excess-btn"
                  data-type-id="${m.typeId}"
                  data-material-name="${escapeHtml(name)}"
                  title="Reduce acquired quantity to match needed quantity">Cleanup Excess</button>
              ` : ''}
            ` : `
              <button class="secondary-button small mark-acquired-btn"
                data-type-id="${m.typeId}"
                data-material-name="${escapeHtml(name)}"
                data-quantity-needed="${m.quantity}"
                data-already-acquired="${totalAcquired}"
                data-still-needed="${Math.max(0, m.quantity - totalAcquired)}">Mark Acquired</button>
            `}
          </td>
        </tr>
      `;
    }

    html += `
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // Calculate grand totals
  let grandTotalVolume = 0;
  materials.forEach(m => {
    const volume = volumes[m.typeId] || 0;
    grandTotalVolume += volume * m.quantity;
  });

  html += `
    <div class="materials-footer">
      <div class="footer-stats">
        <span class="footer-stat"><strong>Total Items:</strong> ${materials.length}</span>
        <span class="footer-stat"><strong>Total Volume:</strong> ${formatNumber(grandTotalVolume, 2)} m³</span>
      </div>
    </div>
  `;

  container.innerHTML = html;

  // Attach event listeners after rendering
  // Category header click handlers
  container.querySelectorAll('.category-header').forEach(header => {
    header.addEventListener('click', () => {
      const category = header.dataset.category;
      if (category) {
        window.toggleCategory(category);
      }
    });
  });

  container.querySelectorAll('.mark-acquired-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      const materialName = btn.dataset.materialName;
      const quantityNeeded = parseInt(btn.dataset.quantityNeeded);
      const alreadyAcquired = parseInt(btn.dataset.alreadyAcquired);
      const stillNeeded = parseInt(btn.dataset.stillNeeded);
      showAcquireMaterialModal(typeId, materialName, quantityNeeded, alreadyAcquired, stillNeeded);
    });
  });

  container.querySelectorAll('.unmark-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      unmarkMaterialAcquired(typeId);
    });
  });

  container.querySelectorAll('.cleanup-excess-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      const materialName = btn.dataset.materialName;
      cleanupExcessAcquisition(typeId, materialName);
    });
  });

  container.querySelectorAll('.edit-acquisition-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      const materialName = btn.dataset.materialName;
      const quantityNeeded = parseInt(btn.dataset.quantityNeeded);
      const alreadyAcquired = parseInt(btn.dataset.alreadyAcquired);
      const manualQuantity = parseInt(btn.dataset.manualQuantity);
      const stillNeeded = parseInt(btn.dataset.stillNeeded);
      showAcquireMaterialModal(typeId, materialName, quantityNeeded, alreadyAcquired, stillNeeded, manualQuantity);
    });
  });

  container.querySelectorAll('.edit-price-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      const price = parseFloat(btn.dataset.price);
      editMaterialPrice(typeId, price);
    });
  });

  // After rendering, check for warnings
  checkAndDisplayMaterialWarnings(materials);
}

// Check and display material warnings
async function checkAndDisplayMaterialWarnings(materials) {
  const warningsContainer = document.getElementById('material-warnings');
  if (!warningsContainer) return;

  const warnings = [];

  // Check for excess acquisitions
  const excessMaterials = materials.filter(m =>
    m.manuallyAcquiredQuantity > 0 && m.manuallyAcquiredQuantity > m.quantity
  );

  if (excessMaterials.length > 0) {
    // Get type names for display
    const typeIds = excessMaterials.map(m => m.typeId);
    const names = await window.electronAPI.sde.getTypeNames(typeIds);

    warnings.push({
      type: 'excess_acquisitions',
      materials: excessMaterials.map(m => ({
        typeId: m.typeId,
        typeName: names[m.typeId] || `Type ${m.typeId}`,
        needed: m.quantity,
        acquired: m.manuallyAcquiredQuantity,
        excess: m.manuallyAcquiredQuantity - m.quantity
      }))
    });
  }

  // Render warnings
  if (warnings.length > 0) {
    renderMaterialWarnings(warnings);
  } else {
    warningsContainer.style.display = 'none';
    warningsContainer.innerHTML = '';
  }
}

// Render material warnings
function renderMaterialWarnings(warnings) {
  const warningsContainer = document.getElementById('material-warnings');
  if (!warnings || warnings.length === 0) {
    warningsContainer.innerHTML = '';
    warningsContainer.style.display = 'none';
    return;
  }

  let warningsHtml = '';

  warnings.forEach(warning => {
    if (warning.type === 'excess_acquisitions') {
      warningsHtml += `
        <div class="alert alert-warning">
          <h4>⚠️ Excess Acquisitions Detected</h4>
          <p>The following materials have more acquired than needed:</p>
          <ul>
            ${warning.materials.map(m => `
              <li>
                <strong>${escapeHtml(m.typeName)}</strong>:
                Needed ${formatNumber(m.needed)},
                Acquired ${formatNumber(m.acquired)}
                (${formatNumber(m.excess)} excess)
                <button class="warning-button small cleanup-excess-btn-warning"
                        data-type-id="${m.typeId}"
                        data-material-name="${escapeHtml(m.typeName)}">
                  Fix
                </button>
              </li>
            `).join('')}
          </ul>
          <button class="warning-button"
                  onclick="cleanupAllExcessAcquisitions()">
            Fix All
          </button>
        </div>
      `;
    }

    if (warning.type === 'removed_acquisitions') {
      warningsHtml += `
        <div class="alert alert-info">
          <h4>ℹ️ Acquisition Tracking Removed</h4>
          <p>The following materials were removed from the plan and their acquisition tracking was deleted:</p>
          <ul>
            ${warning.materials.map(m => `
              <li>
                <strong>${escapeHtml(m.typeName)}</strong>:
                Had ${formatNumber(m.acquiredQuantity)} marked as
                ${m.method?.toUpperCase() || 'acquired'}
              </li>
            `).join('')}
          </ul>
          <button class="secondary-button" onclick="dismissWarning('removed_acquisitions')">
            Dismiss
          </button>
        </div>
      `;
    }
  });

  warningsContainer.innerHTML = warningsHtml;
  warningsContainer.style.display = 'block';

  // Attach event listeners to inline cleanup buttons
  warningsContainer.querySelectorAll('.cleanup-excess-btn-warning').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeId);
      const materialName = btn.dataset.materialName;
      cleanupExcessAcquisition(typeId, materialName);
    });
  });
}

// Cleanup all excess acquisitions
window.cleanupAllExcessAcquisitions = async function() {
  if (!confirm('Reduce all excess acquisitions to match needed quantities?')) {
    return;
  }

  try {
    showLoading('Cleaning up all excess acquisitions...');
    const result = await window.electronAPI.plans.cleanupExcessAcquisitions(selectedPlanId, null);

    if (result.success) {
      await loadMaterials();
      await loadOverview();
      showToast(`All excess acquisitions adjusted${result.adjusted ? ` (${result.adjusted} material(s))` : ''}`, 'success');
    } else {
      showToast('Failed to cleanup excess: ' + result.error, 'error');
    }
  } catch (error) {
    showToast('Failed to cleanup excess: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Show acquire material modal
window.showAcquireMaterialModal = async function(typeId, materialName, quantityNeeded = 0, alreadyAcquired = 0, stillNeeded = 0, currentManualQuantity = 0) {
  const modal = document.getElementById('acquire-material-modal');
  if (!modal) {
    createAcquireMaterialModal();
    return showAcquireMaterialModal(typeId, materialName, quantityNeeded, alreadyAcquired, stillNeeded, currentManualQuantity);
  }

  document.getElementById('acquire-material-name').textContent = materialName;
  document.getElementById('acquire-type-id').value = typeId;

  // Pre-fill with current manual quantity if editing, otherwise use stillNeeded
  document.getElementById('acquisition-quantity').value = currentManualQuantity > 0 ? currentManualQuantity : stillNeeded;

  document.getElementById('acquire-total-needed').textContent = formatNumber(quantityNeeded);
  document.getElementById('acquire-already-acquired').textContent = formatNumber(alreadyAcquired);
  document.getElementById('acquire-still-needed').textContent = formatNumber(stillNeeded);
  document.getElementById('acquisition-method').value = 'owned';
  document.getElementById('custom-price-input').value = '';
  document.getElementById('acquisition-note-input').value = '';

  // Update modal title based on mode
  const title = currentManualQuantity > 0 ? 'Edit Manual Acquisition' : 'Mark Material as Acquired';
  document.querySelector('#acquire-material-modal .modal-header h2').textContent = title;

  // Fetch and display owned assets for this material type
  const ownedAssetsContainer = document.getElementById('acquire-owned-assets-container');
  if (ownedAssetsContainer && selectedPlanId) {
    ownedAssetsContainer.innerHTML = '<div class="owned-assets-loading"><div class="spinner small"></div> Loading assets...</div>';

    try {
      const ownedAssets = await window.electronAPI.plans.getProductOwnedAssets(selectedPlanId, typeId);
      const totalOwned = ownedAssets.ownedPersonal + ownedAssets.ownedCorp;

      let ownedAssetsHtml = '';
      if (totalOwned > 0 || ownedAssets.personalDetails.length > 0 || ownedAssets.corpDetails.length > 0) {
        ownedAssetsHtml = `
          <div class="owned-assets-summary">
            <span class="owned-total">Total Owned: <strong>${formatNumber(totalOwned)}</strong></span>
          </div>
          ${ownedAssets.personalDetails.length > 0 ? `
            <div class="owned-assets-group">
              <h5>Personal Hangars (${formatNumber(ownedAssets.ownedPersonal)})</h5>
              <ul class="owned-assets-list">
                ${ownedAssets.personalDetails.map(d => `
                  <li>${escapeHtml(d.characterName)}: <strong>${formatNumber(d.quantity)}</strong></li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
          ${ownedAssets.corpDetails.length > 0 ? `
            <div class="owned-assets-group">
              <h5>Corporation Hangars (${formatNumber(ownedAssets.ownedCorp)})</h5>
              <ul class="owned-assets-list">
                ${ownedAssets.corpDetails.map(d => `
                  <li>${escapeHtml(d.corporationName)} - ${escapeHtml(d.divisionName)}: <strong>${formatNumber(d.quantity)}</strong></li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
        `;
      } else {
        ownedAssetsHtml = '<p class="no-assets-message">No assets found in configured character/corporation hangars.</p>';
      }
      ownedAssetsContainer.innerHTML = ownedAssetsHtml;
    } catch (error) {
      console.error('Error fetching owned assets:', error);
      ownedAssetsContainer.innerHTML = '<p class="no-assets-message">Failed to load owned assets.</p>';
    }
  }

  modal.style.display = 'flex';
};

// Hide acquire material modal
function hideAcquireMaterialModal() {
  document.getElementById('acquire-material-modal').style.display = 'none';
}

// Create acquire material modal dynamically
function createAcquireMaterialModal() {
  const modalHTML = `
    <div id="acquire-material-modal" class="modal" style="display: none;">
      <div class="modal-content large">
        <div class="modal-header">
          <h2>Mark Material as Acquired</h2>
          <button class="close-btn" id="close-acquire-modal">&times;</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="acquire-type-id">

          <div style="margin-bottom: 24px; padding: 12px; background: rgba(88, 101, 242, 0.1); border-radius: 4px;">
            <div style="font-size: 13px; color: #b9bbbe; margin-bottom: 4px;">Material</div>
            <div style="font-size: 16px; font-weight: 600;" id="acquire-material-name"></div>
          </div>

          <div class="owned-assets-section">
            <h4>Owned Assets</h4>
            <div id="acquire-owned-assets-container">
              <p class="no-assets-message">Loading...</p>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <label for="acquisition-quantity">Quantity Acquired</label>
            <input type="number" id="acquisition-quantity" class="input-field" min="1" step="1" required>
            <div style="font-size: 12px; color: #72767d; margin-top: 4px;">
              Total needed: <span id="acquire-total-needed">0</span> |
              Already acquired: <span id="acquire-already-acquired">0</span> |
              Still needed: <span id="acquire-still-needed">0</span>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <label for="acquisition-method">How was this material acquired?</label>
            <select id="acquisition-method" class="input-field">
              <option value="owned">Already Owned (Assets)</option>
              <option value="manufactured">Manufactured by Me</option>
              <option value="gift">Gift/Donation</option>
              <option value="contract">Contract/Trade</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div style="margin-bottom: 20px;">
            <label for="custom-price-input">Custom Price per Unit (ISK)</label>
            <input type="number" id="custom-price-input" class="input-field" min="0" step="0.01" placeholder="Leave empty to use market price">
            <div style="font-size: 12px; color: #72767d; margin-top: 4px;">Enter a custom price if the actual cost differs from market estimate</div>
          </div>

          <div style="margin-bottom: 20px;">
            <label for="acquisition-note-input">Note (Optional)</label>
            <textarea id="acquisition-note-input" class="textarea-field" rows="3" placeholder="Add any notes about this acquisition..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary-button" id="cancel-acquire-btn">Cancel</button>
          <button class="primary-button" id="confirm-acquire-btn">Confirm</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  // Attach event listeners (CSP-compliant)
  document.getElementById('close-acquire-modal').addEventListener('click', hideAcquireMaterialModal);
  document.getElementById('cancel-acquire-btn').addEventListener('click', hideAcquireMaterialModal);
  document.getElementById('confirm-acquire-btn').addEventListener('click', confirmAcquireMaterial);
}

// Confirm acquire material
window.confirmAcquireMaterial = async function() {
  const typeId = parseInt(document.getElementById('acquire-type-id').value);
  const quantity = parseInt(document.getElementById('acquisition-quantity').value);
  const acquisitionMethod = document.getElementById('acquisition-method').value;
  const customPriceInput = document.getElementById('custom-price-input').value;
  const acquisitionNote = document.getElementById('acquisition-note-input').value.trim();

  // Validate quantity
  if (!quantity || quantity <= 0) {
    showToast('Please enter a valid quantity', 'error');
    return;
  }

  const customPrice = customPriceInput ? parseFloat(customPriceInput) : null;

  try {
    showLoading('Marking material as acquired...');
    await window.electronAPI.plans.markMaterialAcquired(selectedPlanId, typeId, {
      quantity,
      acquisitionMethod,
      customPrice,
      acquisitionNote: acquisitionNote || null
    });

    hideAcquireMaterialModal();
    await loadMaterials();
    await loadOverview(); // Update cost calculations
    showToast('Material marked as acquired', 'success');
  } catch (error) {
    showToast('Failed to mark material: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Unmark material as acquired
window.unmarkMaterialAcquired = async function(typeId) {
  try {
    showLoading('Unmarking material...');
    await window.electronAPI.plans.unmarkMaterialAcquired(selectedPlanId, typeId);
    await loadMaterials();
    await loadOverview();
    showToast('Material unmarked', 'success');
  } catch (error) {
    showToast('Failed to unmark material: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Cleanup excess acquisition
window.cleanupExcessAcquisition = async function(typeId, materialName) {
  if (!confirm(`Reduce acquired quantity for ${materialName} to match needed quantity?`)) {
    return;
  }

  try {
    showLoading('Cleaning up excess acquisition...');
    const result = await window.electronAPI.plans.cleanupExcessAcquisitions(selectedPlanId, typeId);

    if (result.success) {
      await loadMaterials();
      await loadOverview();
      showToast(`Acquisition adjusted${result.adjusted ? ` (${result.adjusted} material(s))` : ''}`, 'success');
    } else {
      showToast('Failed to cleanup excess: ' + result.error, 'error');
    }
  } catch (error) {
    showToast('Failed to cleanup excess: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Edit material price
window.editMaterialPrice = async function(typeId, currentPrice) {
  const newPrice = prompt('Enter new price per unit (ISK):', currentPrice);

  if (newPrice === null) return; // User cancelled

  const price = parseFloat(newPrice);
  if (isNaN(price) || price < 0) {
    showToast('Invalid price entered', 'error');
    return;
  }

  try {
    showLoading('Updating price...');
    await window.electronAPI.plans.updateMaterialCustomPrice(selectedPlanId, typeId, price);
    await loadMaterials();
    await loadOverview();
    showToast('Price updated', 'success');
  } catch (error) {
    showToast('Failed to update price: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Load products tab
async function loadProducts() {
  const products = await window.electronAPI.plans.getProducts(selectedPlanId);
  const container = document.getElementById('products-list-tab');

  if (products.length === 0) {
    container.innerHTML = '<div class="loading">No products calculated. Add blueprints to this plan.</div>';
    return;
  }

  // Group products by depth
  const productsByDepth = {};
  for (const product of products) {
    const depth = product.intermediateDepth || 0;
    if (!productsByDepth[depth]) productsByDepth[depth] = [];
    productsByDepth[depth].push(product);
  }

  // Get product names and volumes
  const typeIds = products.map(p => p.typeId);
  const [names, volumes] = await Promise.all([
    window.electronAPI.sde.getTypeNames(typeIds),
    window.electronAPI.sde.getItemVolumes(typeIds)
  ]);

  let html = '';

  // Final Products (depth 0)
  if (productsByDepth[0] && productsByDepth[0].length > 0) {
    html += `
      <div class="products-section">
        <h3 class="section-header">Final Products</h3>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Quantity</th>
              <th>Total m³</th>
              <th>Price</th>
              <th>Total Value</th>
            </tr>
          </thead>
          <tbody>
            ${productsByDepth[0].map(p => {
              const name = names[p.typeId] || `Type ${p.typeId}`;
              const volume = volumes[p.typeId] || 0;
              const totalM3 = volume * p.quantity;
              const price = p.basePrice ? formatISK(p.basePrice) : 'N/A';
              const total = p.basePrice ? formatISK(p.basePrice * p.quantity) : 'N/A';

              return `
                <tr>
                  <td>${escapeHtml(name)}</td>
                  <td>${formatNumber(p.quantity)}</td>
                  <td>${formatNumber(totalM3, 2)} m³</td>
                  <td>${price}</td>
                  <td>${total}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // Intermediate Products (depth > 0)
  const maxDepth = Math.max(...Object.keys(productsByDepth).map(d => parseInt(d)));
  if (maxDepth > 0) {
    html += `
      <div class="products-section">
        <h3 class="section-header">Intermediate Components</h3>
        <p class="section-description">Components that will be manufactured as intermediate steps before producing the final products.</p>
    `;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const depthProducts = productsByDepth[depth] || [];
      if (depthProducts.length === 0) continue;

      const indent = depth * 15;
      html += `
        <h4 style="margin-left: ${indent}px; color: #72767d; margin-top: 20px; margin-bottom: 10px;">Level ${depth} Intermediates</h4>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Quantity</th>
              <th>Total m³</th>
              <th>Price</th>
              <th>Total Value</th>
            </tr>
          </thead>
          <tbody>
            ${depthProducts.map(p => {
              const name = names[p.typeId] || `Type ${p.typeId}`;
              const volume = volumes[p.typeId] || 0;
              const totalM3 = volume * p.quantity;
              const price = p.basePrice ? formatISK(p.basePrice) : 'N/A';
              const total = p.basePrice ? formatISK(p.basePrice * p.quantity) : 'N/A';
              const rowIndent = depth * 20;

              return `
                <tr>
                  <td style="padding-left: ${rowIndent}px;">${escapeHtml(name)}</td>
                  <td>${formatNumber(p.quantity)}</td>
                  <td>${formatNumber(totalM3, 2)} m³</td>
                  <td>${price}</td>
                  <td>${total}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }

    html += '</div>';
  }

  container.innerHTML = html;
}

/**
 * Load and display reactions for the current plan
 */
async function loadReactions() {
  const container = document.getElementById('reactions-container');

  try {
    // Get reactions from the plan
    const reactions = await window.electronAPI.plans.getReactions(selectedPlanId);

    if (reactions.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 6v6l4 2"></path>
          </svg>
          <h3 style="margin-top: 16px; color: var(--text-primary);">No Reactions Required</h3>
          <p style="margin-top: 8px;">This manufacturing plan does not require any reaction materials.</p>
          <div style="max-width: 500px; margin-top: 16px; padding: 16px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid #7289da;">
            <p style="margin: 0 0 12px 0; font-weight: 600; color: var(--text-primary);">What are reactions?</p>
            <p style="margin: 0 0 8px 0; font-size: 14px; color: var(--text-secondary);">
              Reactions are industrial processes that convert moon goo and other materials into intermediate components like:
            </p>
            <ul style="margin: 8px 0; padding-left: 20px; font-size: 14px; color: var(--text-secondary);">
              <li>Fernite Carbide</li>
              <li>Hypersynaptic Fibers</li>
              <li>Nanotransistors</li>
              <li>Fullerides and other advanced materials</li>
            </ul>
            <p style="margin: 8px 0 0 0; font-size: 14px; color: var(--text-secondary);">
              Your blueprint uses manufactured components instead, so no reactions are needed.
            </p>
          </div>
        </div>
      `;
      return;
    }

    let html = '';

    // Reactions are already aggregated in the backend (one record per reaction type)
    // No frontend aggregation needed
    for (const reaction of reactions) {
      try {
        // Get reaction calculation with runs
        const calculation = await window.electronAPI.reactions.calculateMaterials(
          reaction.reactionTypeId,
          reaction.runs,
          null, // characterId
          reaction.facilityId
        );

        html += await renderReactionTree(reaction, calculation);
      } catch (error) {
        console.error('Error calculating reaction:', error);
        html += `
          <div class="reaction-item error">
            <p>Error calculating reaction ${reaction.reactionTypeId}: ${error.message}</p>
          </div>
        `;
      }
    }

    container.innerHTML = html || '<div class="loading">No reaction data available</div>';

    // Show save facilities button if there are reactions
    const saveFacilitiesBtn = document.getElementById('save-reaction-facilities-btn');
    if (saveFacilitiesBtn) {
      saveFacilitiesBtn.style.display = reactions.length > 0 ? 'inline-flex' : 'none';
    }

    // Attach event listeners for reaction actions
    attachReactionEventListeners();

  } catch (error) {
    console.error('Error loading reactions:', error);
    container.innerHTML = `
      <div class="error-state">
        <p>Error loading reactions: ${error.message}</p>
      </div>
    `;
    // Hide save facilities button on error
    const saveFacilitiesBtn = document.getElementById('save-reaction-facilities-btn');
    if (saveFacilitiesBtn) {
      saveFacilitiesBtn.style.display = 'none';
    }
  }
}

/**
 * Render a reaction with its tree visualization
 * Reactions are already aggregated in backend, so no aggregation needed here
 */
async function renderReactionTree(reaction, calculation) {
  const product = calculation.product;
  const productName = product ? product.typeName : `Type ${reaction.reactionTypeId}`;

  // Build status badge
  let builtBadge = '';
  if (reaction.builtRuns > 0) {
    const percentage = Math.round((reaction.builtRuns / reaction.runs) * 100);
    const statusClass = reaction.builtRuns >= reaction.runs ? 'fully-built' : 'partially-built';
    builtBadge = ` <span class="status-badge ${statusClass}">${formatNumber(reaction.builtRuns)}/${formatNumber(reaction.runs)} Built (${percentage}%)</span>`;
  }

  // Build facility dropdown
  let facilityOptions = '<option value="">No facility</option>';
  facilities.forEach(facility => {
    // Use string comparison to handle type mismatches
    const selected = String(reaction.facilityId) === String(facility.id) ? 'selected' : '';
    facilityOptions += `<option value="${facility.id}" ${selected}>${escapeHtml(facility.name)}</option>`;
  });

  // Build header with reaction info
  let html = `
    <div class="reaction-item" data-reaction-id="${reaction.planBlueprintId}">
      <div class="reaction-header">
        <div class="reaction-info">
          <h4>${escapeHtml(productName)}${builtBadge}</h4>
          <div class="reaction-meta">
            <span>Runs: ${formatNumber(reaction.runs)}</span>
            <label style="margin-left: 16px;">
              <span style="margin-right: 8px;">Facility:</span>
              <select class="reaction-facility-select" data-reaction-id="${reaction.planBlueprintId}" style="padding: 4px 8px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px;">
                ${facilityOptions}
              </select>
            </label>
          </div>
        </div>
        <div class="reaction-actions">
          <button class="secondary-button small" data-action="mark-built" data-reaction-id="${reaction.planBlueprintId}" data-runs="${reaction.runs}">
            ${reaction.builtRuns > 0 ? 'Edit Built Qty' : 'Mark Built'}
          </button>
        </div>
      </div>
      <div class="reaction-tree">
  `;

  // Render the tree if available
  if (calculation.tree && calculation.tree.length > 0) {
    html += renderTreeNodes(calculation.tree, product);
  } else {
    html += '<p class="empty-hint">No tree data available</p>';
  }

  html += `
      </div>
    </div>
  `;

  return html;
}

/**
 * Render tree nodes recursively (similar to reactions-calculator)
 */
function renderTreeNodes(nodes, finalProduct) {
  let html = '';

  for (const node of nodes) {
    const depth = node.depth || 0;
    const depthClass = `depth-${Math.min(depth, 8)}`;

    // Determine node type
    let nodeClass = 'tree-node';
    let badge = '';

    if (node.typeID === finalProduct?.typeID && depth === 0) {
      nodeClass += ' tree-node-product';
      badge = '<span class="badge badge-product">PRODUCT</span>';
    } else if (node.isIntermediate) {
      nodeClass += ' tree-node-intermediate';
      badge = '<span class="badge badge-intermediate">INTERMEDIATE</span>';
    } else {
      nodeClass += ' tree-node-raw';
      badge = '<span class="badge badge-raw">RAW</span>';
    }

    html += `
      <div class="${nodeClass} ${depthClass}">
        <div class="tree-node-content">
          <span class="tree-node-icon">
            ${node.isIntermediate ? '⊕' : (depth === 0 ? '●' : '■')}
          </span>
          <span class="tree-node-name">${escapeHtml(node.typeName || `Type ${node.typeID}`)}</span>
          <span class="tree-node-quantity">×${formatNumber(node.quantity)}</span>
          ${badge}
        </div>
    `;

    // Render children recursively if present
    if (node.children && node.children.length > 0) {
      html += renderTreeNodes(node.children, finalProduct);
    }

    html += '</div>';
  }

  return html;
}

/**
 * Attach event listeners for reaction buttons
 */
function attachReactionEventListeners() {
  // Refresh prices button
  const refreshBtn = document.getElementById('refresh-reaction-prices-btn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      await window.electronAPI.plans.recalculateMaterials(selectedPlanId, true);
      await loadReactions();
      // Reload overview and plans list to reflect updated prices
      await loadOverview();
      await loadPlans();
      showToast('Reaction prices refreshed', 'success');
    };
  }

  // Save facilities button
  const saveFacilitiesBtn = document.getElementById('save-reaction-facilities-btn');
  if (saveFacilitiesBtn) {
    saveFacilitiesBtn.onclick = async () => {
      const container = document.getElementById('reactions-container');
      const selects = container.querySelectorAll('.reaction-facility-select');

      try {
        showLoading('Updating facilities and recalculating reactions...');

        // Get all facility updates
        const updates = [];
        for (const select of selects) {
          const reactionId = select.dataset.reactionId;
          const facilityId = select.value || null;

          // Get facility snapshot if facility selected
          let facilitySnapshot = null;
          if (facilityId) {
            // Use string comparison to handle type mismatches
            const facility = facilities.find(f => String(f.id) === String(facilityId));
            if (facility) {
              facilitySnapshot = facility;
              console.log('[Reactions] Saving facility snapshot for reaction:', {
                reactionId,
                id: facility.id,
                name: facility.name,
                hasRigs: !!facility.rigs,
                rigCount: facility.rigs?.length || 0,
                structureTypeId: facility.structureTypeId,
                snapshotSize: JSON.stringify(facility).length
              });
            } else {
              console.warn('[Reactions] Facility not found for ID:', facilityId, 'Available:', facilities.map(f => f.id));
            }
          }

          updates.push({
            reactionId,
            facilityId,
            facilitySnapshot
          });
        }

        // Update all reactions (without triggering recalculation for each)
        for (const update of updates) {
          await window.electronAPI.plans.updateBlueprint(update.reactionId, {
            facilityId: update.facilityId,
            facilitySnapshot: update.facilitySnapshot,
            skipRecalculation: true // Don't recalculate for each update
          });
        }

        // Clear reaction cache to ensure new facility bonuses are applied
        await window.electronAPI.reactions.clearCaches();

        // Recalculate once after all updates
        await window.electronAPI.plans.recalculateMaterials(selectedPlanId, false);

        await loadReactions();
        // Reload overview and plans list to reflect updated reaction costs
        await loadOverview();
        await loadPlans();
        showToast(`Updated ${updates.length} reaction(s) successfully`, 'success');
      } catch (error) {
        console.error('Error saving reaction facilities:', error);
        showToast('Failed to save facilities: ' + error.message, 'error');
      } finally {
        hideLoading();
      }
    };
  }

  // Attach event listeners to reaction action buttons
  const container = document.getElementById('reactions-container');
  if (container) {
    container.querySelectorAll('[data-action="mark-built"]').forEach(btn => {
      const reactionId = btn.dataset.reactionId;
      const runs = parseInt(btn.dataset.runs);
      btn.addEventListener('click', () => showMarkReactionBuiltModal(reactionId, runs));
    });
  }
}

/**
 * Show modal to mark a reaction as built
 */
window.showMarkReactionBuiltModal = async function(planBlueprintId, totalRuns) {
  try {
    // Get reaction data
    const reactions = await window.electronAPI.plans.getReactions(selectedPlanId);
    const reaction = reactions.find(r => r.planBlueprintId === planBlueprintId);

    if (!reaction) {
      showToast('Reaction not found', 'error');
      return;
    }

    // Get product name from SDE
    let productName = `Type ${reaction.reactionTypeId}`;
    try {
      const typeInfo = await window.electronAPI.sde.getTypeInfo(reaction.reactionTypeId);
      if (typeInfo) {
        productName = typeInfo.typeName;
      }
    } catch (error) {
      console.error('Error fetching product name:', error);
    }

    const builtRuns = reaction.builtRuns || 0;

    // Create modal dynamically
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content mark-built-modal">
        <div class="modal-header">
          <h3>Mark Reaction as Built</h3>
          <button class="close-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <p><strong>${escapeHtml(productName)}</strong></p>
          <p>Total Runs Needed: <strong>${totalRuns}</strong></p>

          <label for="reaction-built-runs-input">Runs Already Built:</label>
          <input
            type="number"
            id="reaction-built-runs-input"
            min="0"
            max="${totalRuns}"
            value="${builtRuns}"
            step="1"
          />

          <div class="built-progress">
            <div class="progress-bar">
              <div class="progress-fill" id="reaction-built-progress-fill" style="width: ${Math.round((builtRuns / totalRuns) * 100)}%"></div>
            </div>
            <span id="reaction-built-percentage">${Math.round((builtRuns / totalRuns) * 100)}%</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary-button cancel-btn">Cancel</button>
          <button class="primary-button save-btn">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Update progress bar when input changes
    const input = modal.querySelector('#reaction-built-runs-input');
    const progressFill = modal.querySelector('#reaction-built-progress-fill');
    const progressText = modal.querySelector('#reaction-built-percentage');

    input.addEventListener('input', () => {
      const value = parseInt(input.value) || 0;
      const percentage = Math.round((value / totalRuns) * 100);
      progressFill.style.width = `${percentage}%`;
      progressText.textContent = `${percentage}%`;
    });

    // Close button
    modal.querySelector('.close-modal').addEventListener('click', () => {
      modal.remove();
    });

    // Cancel button
    modal.querySelector('.cancel-btn').addEventListener('click', () => {
      modal.remove();
    });

    // Click outside to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });

    // Save button
    modal.querySelector('.save-btn').addEventListener('click', async () => {
      const builtRunsValue = parseInt(input.value);

      if (isNaN(builtRunsValue) || builtRunsValue < 0 || builtRunsValue > totalRuns) {
        showToast(`Please enter a valid number of runs between 0 and ${totalRuns}`, 'error');
        return;
      }

      try {
        await window.electronAPI.plans.markReactionBuilt(planBlueprintId, builtRunsValue);
        modal.remove();
        await loadReactions();
        showToast('Reaction marked as built', 'success');
      } catch (error) {
        console.error('Error marking reaction as built:', error);
        showToast('Failed to mark reaction as built: ' + error.message, 'error');
      }
    });

    modal.style.display = 'flex';
  } catch (error) {
    console.error('Error showing mark reaction built modal:', error);
    showToast('Failed to show modal: ' + error.message, 'error');
  }
};

// Show create plan modal
function showCreatePlanModal() {
  document.getElementById('new-plan-name').value = '';
  document.getElementById('new-plan-description').value = '';
  document.getElementById('create-plan-modal').style.display = 'flex';
}

// Hide create plan modal
function hideCreatePlanModal() {
  document.getElementById('create-plan-modal').style.display = 'none';
}

// Create plan
async function createPlan() {
  if (!currentCharacterId) {
    showToast('Please select a character', 'warning');
    return;
  }

  const planName = document.getElementById('new-plan-name').value.trim();
  const description = document.getElementById('new-plan-description').value.trim();

  try {
    showLoading('Creating plan...');
    const plan = await window.electronAPI.plans.create(
      currentCharacterId,
      planName || null,
      description || null
    );

    hideCreatePlanModal();
    await loadPlans();
    await selectPlan(plan.planId);
    showToast('Manufacturing plan created successfully', 'success');
  } catch (error) {
    showToast('Failed to create plan: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Delete plan
async function deletePlan() {
  if (!selectedPlanId) return;

  const confirmed = await showConfirmDialog(
    'Are you sure you want to delete this plan? This cannot be undone.',
    'Delete Plan',
    'Delete',
    'Cancel'
  );

  if (!confirmed) return;

  try {
    showLoading('Deleting plan...');
    await window.electronAPI.plans.delete(selectedPlanId);
    await loadPlans();
    showEmptyState();
    showToast('Plan deleted successfully', 'success');
  } catch (error) {
    showToast('Failed to delete plan: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Complete plan
async function completePlan() {
  if (!selectedPlanId) return;

  const confirmed = await showConfirmDialog(
    'Mark this plan as completed? You can still view it later.',
    'Complete Plan',
    'Mark Complete',
    'Cancel'
  );

  if (!confirmed) return;

  try {
    showLoading('Updating plan status...');
    await window.electronAPI.plans.update(selectedPlanId, {
      status: 'completed',
      completedAt: Date.now(),
    });
    await loadPlans();
    await loadPlanDetails();
    showToast('Plan marked as completed', 'success');
  } catch (error) {
    showToast('Failed to complete plan: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Update plan name
async function updatePlanName() {
  if (!selectedPlanId) return;

  const newName = document.getElementById('plan-name').textContent.trim();
  if (!newName) {
    await loadPlanDetails();
    return;
  }

  try {
    await window.electronAPI.plans.update(selectedPlanId, { planName: newName });
    await loadPlans();
  } catch (error) {
    console.error('Failed to update plan name:', error);
    await loadPlanDetails();
  }
}

// Update plan description
async function updatePlanDescription() {
  if (!selectedPlanId) return;

  const description = document.getElementById('plan-description').value.trim();

  try {
    await window.electronAPI.plans.update(selectedPlanId, { description: description || null });
  } catch (error) {
    console.error('Failed to update plan description:', error);
  }
}

// Show add blueprint modal
function showAddBlueprintModal() {
  document.getElementById('blueprint-search-modal').value = '';
  document.getElementById('blueprint-search-results').innerHTML = '<div class="loading">Search for blueprints...</div>';
  document.getElementById('add-blueprint-modal').style.display = 'flex';
}

// Hide add blueprint modal
function hideAddBlueprintModal() {
  document.getElementById('add-blueprint-modal').style.display = 'none';
}

// Search blueprints
let searchTimeout;
async function searchBlueprints(e) {
  clearTimeout(searchTimeout);

  const query = e.target.value.trim();
  if (query.length < 2) {
    document.getElementById('blueprint-search-results').innerHTML = '<div class="loading">Search for blueprints...</div>';
    return;
  }

  searchTimeout = setTimeout(async () => {
    const results = await window.electronAPI.sde.searchBlueprints(query);
    const container = document.getElementById('blueprint-search-results');

    if (results.length === 0) {
      container.innerHTML = '<div class="loading">No blueprints found</div>';
      return;
    }

    container.innerHTML = results.slice(0, 20).map(bp => `
      <div class="search-result-item" data-type-id="${bp.typeID}">
        <strong>${escapeHtml(bp.typeName)}</strong>
      </div>
    `).join('');

    // Add click handlers
    container.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        selectedBlueprintTypeId = parseInt(item.dataset.typeId);
        showConfigureBlueprintModal(item.querySelector('strong').textContent);
      });
    });
  }, 300);
}

// Show configure blueprint modal
async function showConfigureBlueprintModal(blueprintName) {
  hideAddBlueprintModal();

  document.getElementById('config-blueprint-name').textContent = blueprintName;
  document.getElementById('config-runs').value = 1;
  document.getElementById('config-lines').value = 1;

  // Get character's owned blueprints to pre-fill ME/TE
  let meLevel = 0;
  let teLevel = 0;

  if (currentCharacterId && selectedBlueprintTypeId) {
    try {
      const blueprints = await window.electronAPI.blueprints.getAll(currentCharacterId);
      if (blueprints && blueprints.length > 0) {
        const ownedBlueprint = blueprints.find(bp => bp.typeId === selectedBlueprintTypeId);
        if (ownedBlueprint) {
          meLevel = ownedBlueprint.materialEfficiency || 0;
          teLevel = ownedBlueprint.timeEfficiency || 0;
        }
      }
    } catch (error) {
      console.warn('Could not fetch character blueprints:', error);
    }
  }

  document.getElementById('config-me').value = meLevel;
  document.getElementById('config-te').value = teLevel;

  // Populate facilities dropdown and select default
  const facilitySelect = document.getElementById('config-facility');
  facilitySelect.innerHTML = '<option value="">No facility</option>';

  let defaultFacilityId = null;
  facilities.forEach(facility => {
    const option = document.createElement('option');
    option.value = facility.id;
    option.textContent = facility.name;
    facilitySelect.appendChild(option);

    // Track default facility (usage === 'default')
    if (facility.usage === 'default') {
      defaultFacilityId = facility.id;
    }
  });

  // Select default facility if one exists
  if (defaultFacilityId) {
    facilitySelect.value = defaultFacilityId;
  }

  // Initialize runs per line preview
  updateRunsPerLinePreview();

  document.getElementById('configure-blueprint-modal').style.display = 'flex';
}

// Update runs per line preview in configure modal
function updateRunsPerLinePreview() {
  const runs = parseInt(document.getElementById('config-runs').value) || 1;
  const lines = parseInt(document.getElementById('config-lines').value) || 1;
  const runsPerLine = Math.ceil(runs / lines);
  const previewElement = document.getElementById('runs-per-line-value');
  if (previewElement) {
    previewElement.textContent = runsPerLine;
  }
}

// Hide configure blueprint modal
function hideConfigureBlueprintModal() {
  document.getElementById('configure-blueprint-modal').style.display = 'none';
}

// Confirm add blueprint
async function confirmAddBlueprint() {
  if (!selectedBlueprintTypeId || !selectedPlanId) return;

  const runs = parseInt(document.getElementById('config-runs').value);
  const lines = parseInt(document.getElementById('config-lines').value);
  const meLevel = parseInt(document.getElementById('config-me').value);
  const teLevel = parseInt(document.getElementById('config-te').value);
  const facilityId = document.getElementById('config-facility').value;

  // Get facility snapshot
  let facilitySnapshot = null;
  if (facilityId) {
    const facility = facilities.find(f => f.id === facilityId);
    if (facility) {
      facilitySnapshot = facility;
    }
  }

  const blueprintConfig = {
    blueprintTypeId: selectedBlueprintTypeId,
    runs,
    lines,
    meLevel,
    teLevel,
    facilityId: facilityId || null,
    facilitySnapshot,
  };

  try {
    hideConfigureBlueprintModal();
    showLoading('Adding blueprint to plan...');
    await window.electronAPI.plans.addBlueprint(selectedPlanId, blueprintConfig);
    await loadTabContent(activeTab);
    if (activeTab !== 'overview') {
      await loadOverview(); // Update overview stats
    }
    // Force refresh Materials and Products tabs to ensure they're in sync
    await loadMaterials();
    await loadProducts();
    // Reload plans list to update summary card
    await loadPlans();
    showToast('Blueprint added to plan successfully', 'success');
  } catch (error) {
    showToast('Failed to add blueprint: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Edit blueprint - enable editing mode
window.editBlueprint = function(planBlueprintId) {
  const row = document.querySelector(`tr[data-blueprint-id="${planBlueprintId}"]`);
  if (!row) return;

  row.dataset.editing = 'true';

  // Show inputs, hide values
  row.querySelectorAll('.editable-cell').forEach(cell => {
    cell.querySelector('.cell-value').style.display = 'none';
    cell.querySelector('.cell-input').style.display = 'block';
  });

  // Show save/cancel buttons, hide edit/remove buttons
  row.querySelector('.edit-btn').style.display = 'none';
  row.querySelector('.remove-btn').style.display = 'none';
  row.querySelector('.save-btn').style.display = 'inline-flex';
  row.querySelector('.cancel-btn').style.display = 'inline-flex';
};

// Save blueprint edits
window.saveBlueprintEdit = async function(planBlueprintId) {
  const row = document.querySelector(`tr[data-blueprint-id="${planBlueprintId}"]`);
  if (!row) return;

  try {
    // Collect updated values
    const updates = {};

    row.querySelectorAll('.editable-cell').forEach(cell => {
      const field = cell.dataset.field;
      const input = cell.querySelector('.cell-input');

      if (field === 'facilityId') {
        const facilityId = input.value || null;
        updates.facilityId = facilityId;

        // Get facility snapshot if facility is selected
        if (facilityId) {
          const facility = facilities.find(f => f.id === facilityId);
          if (facility) {
            updates.facilitySnapshot = facility;
          }
        } else {
          updates.facilitySnapshot = null;
        }
      } else if (field === 'useIntermediates') {
        // Keep as string for build plan strategy
        updates[field] = input.value;
      } else {
        updates[field] = parseInt(input.value);
      }
    });

    showLoading('Updating blueprint...');
    await window.electronAPI.plans.updateBlueprint(planBlueprintId, updates);

    // Recalculate materials after blueprint update
    await window.electronAPI.plans.recalculateMaterials(selectedPlanId, false);

    await loadBlueprints();
    await loadOverview(); // Update overview stats
    // Force refresh Materials and Products tabs to ensure they're in sync
    await loadMaterials();
    await loadProducts();
    // Reload plans list to update summary card
    await loadPlans();
    showToast('Blueprint updated successfully', 'success');
  } catch (error) {
    showToast('Failed to update blueprint: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Cancel blueprint edit - revert to view mode
window.cancelBlueprintEdit = function(planBlueprintId) {
  const row = document.querySelector(`tr[data-blueprint-id="${planBlueprintId}"]`);
  if (!row) return;

  row.dataset.editing = 'false';

  // Show values, hide inputs (reset to original values)
  row.querySelectorAll('.editable-cell').forEach(cell => {
    const value = cell.querySelector('.cell-value');
    const input = cell.querySelector('.cell-input');

    // Reset input to original value
    if (input.tagName === 'SELECT') {
      const originalValue = input.querySelector('option[selected]')?.value || '';
      input.value = originalValue;
    } else {
      const originalValue = value.textContent;
      input.value = originalValue;
    }

    value.style.display = 'block';
    input.style.display = 'none';
  });

  // Show edit/remove buttons, hide save/cancel buttons
  row.querySelector('.edit-btn').style.display = 'inline-flex';
  row.querySelector('.remove-btn').style.display = 'inline-flex';
  row.querySelector('.save-btn').style.display = 'none';
  row.querySelector('.cancel-btn').style.display = 'none';
};

// Enter bulk edit mode - make ALL rows editable
window.enterBulkEditMode = function() {
  bulkEditMode = true;

  // Make ALL rows editable (both top-level and intermediate blueprints)
  const allRows = document.querySelectorAll('.top-level-blueprint, .intermediate-blueprint');
  allRows.forEach(row => {
    row.dataset.editing = 'true';

    // Show inputs, hide values for all .editable-cell elements
    row.querySelectorAll('.editable-cell').forEach(cell => {
      cell.querySelector('.cell-value').style.display = 'none';
      cell.querySelector('.cell-input').style.display = 'block';
    });

    // Hide individual action buttons
    const editBtn = row.querySelector('.edit-btn');
    const removeBtn = row.querySelector('.remove-btn');
    const toggleBuiltBtn = row.querySelector('.toggle-built-btn');
    if (editBtn) editBtn.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';
    if (toggleBuiltBtn) toggleBuiltBtn.style.display = 'none';
  });

  // Show Bulk Save/Cancel buttons, hide Bulk Edit button
  document.getElementById('bulk-edit-btn').style.display = 'none';
  document.getElementById('bulk-save-btn').style.display = 'inline-flex';
  document.getElementById('bulk-cancel-btn').style.display = 'inline-flex';

  // Show banner
  document.getElementById('bulk-edit-banner').style.display = 'flex';
};

// Exit bulk edit mode
window.exitBulkEditMode = async function(reload = false) {
  bulkEditMode = false;

  if (reload) {
    // Reload entire tab to reset all values
    await loadBlueprints();
  } else {
    // Revert UI without reloading
    const allRows = document.querySelectorAll('.top-level-blueprint, .intermediate-blueprint');
    allRows.forEach(row => {
      row.dataset.editing = 'false';

      row.querySelectorAll('.editable-cell').forEach(cell => {
        cell.querySelector('.cell-value').style.display = 'block';
        cell.querySelector('.cell-input').style.display = 'none';
      });

      // Restore buttons
      const editBtn = row.querySelector('.edit-btn');
      const removeBtn = row.querySelector('.remove-btn');
      const toggleBuiltBtn = row.querySelector('.toggle-built-btn');
      if (editBtn) editBtn.style.display = 'inline-flex';
      if (removeBtn) removeBtn.style.display = 'inline-flex';
      if (toggleBuiltBtn) toggleBuiltBtn.style.display = 'inline-flex';
    });
  }

  // Restore button states
  document.getElementById('bulk-edit-btn').style.display = 'inline-flex';
  document.getElementById('bulk-save-btn').style.display = 'none';
  document.getElementById('bulk-cancel-btn').style.display = 'none';
  document.getElementById('bulk-edit-banner').style.display = 'none';
};

// Save bulk edit - collect and save all changes
window.saveBulkEdit = async function() {
  try {
    // Collect all changes from ALL rows (both top-level and intermediate blueprints)
    const allRows = document.querySelectorAll('.top-level-blueprint, .intermediate-blueprint');
    const bulkUpdates = [];

    allRows.forEach(row => {
      const planBlueprintId = row.dataset.blueprintId;
      const updates = {};
      let hasChanges = false;

      row.querySelectorAll('.editable-cell').forEach(cell => {
        const field = cell.dataset.field;
        const input = cell.querySelector('.cell-input');
        const originalValue = cell.querySelector('.cell-value').textContent.trim();
        const newValue = input.value;

        if (field === 'facilityId') {
          // Compare facility IDs (could be empty string vs "None")
          const oldFacilityId = originalValue === 'None' ? '' : originalValue;
          if (newValue !== oldFacilityId) {
            hasChanges = true;
            updates.facilityId = newValue || null;

            // Get facility snapshot if facility is selected
            if (newValue) {
              const facility = facilities.find(f => f.id === newValue);
              if (facility) {
                updates.facilitySnapshot = facility;
              }
            } else {
              updates.facilitySnapshot = null;
            }
          }
        } else if (field === 'useIntermediates') {
          // Compare string values for build plan strategy
          if (newValue !== originalValue) {
            hasChanges = true;
            updates[field] = newValue;
          }
        } else if (input.type === 'number') {
          // Compare numeric values
          const oldNum = parseInt(originalValue) || 0;
          const newNum = parseInt(newValue) || 0;
          if (newNum !== oldNum) {
            hasChanges = true;
            updates[field] = newNum;
          }
        }
      });

      // Only add to bulk updates if there are changes
      if (hasChanges) {
        bulkUpdates.push({ planBlueprintId, updates });
      }
    });

    if (bulkUpdates.length === 0) {
      showToast('No changes to save', 'info');
      await exitBulkEditMode(false);
      return;
    }

    // Send to backend
    showLoading(`Saving ${bulkUpdates.length} blueprint(s)...`);
    await window.electronAPI.plans.bulkUpdateBlueprints(selectedPlanId, bulkUpdates);

    // Recalculate materials once for entire plan
    await window.electronAPI.plans.recalculateMaterials(selectedPlanId, false);

    // Reload all tabs
    await loadBlueprints();
    await loadOverview();
    await loadMaterials();
    await loadProducts();
    // Reload plans list to update summary card
    await loadPlans();

    showToast(`Successfully updated ${bulkUpdates.length} blueprint(s)`, 'success');
    await exitBulkEditMode(false);
  } catch (error) {
    showToast('Failed to save bulk changes: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Remove blueprint
window.removeBlueprint = async function(planBlueprintId) {
  const confirmed = await showConfirmDialog(
    'Remove this blueprint from the plan?',
    'Remove Blueprint',
    'Remove',
    'Cancel'
  );

  if (!confirmed) return;

  try {
    showLoading('Removing blueprint...');
    await window.electronAPI.plans.removeBlueprint(planBlueprintId);

    // Recalculate materials after blueprint removal
    await window.electronAPI.plans.recalculateMaterials(selectedPlanId, false);

    await loadTabContent(activeTab);
    if (activeTab !== 'overview') {
      await loadOverview(); // Update overview stats
    }
    // Force refresh Materials and Products tabs to ensure they're in sync
    await loadMaterials();
    await loadProducts();
    // Reload plans list to update summary card
    await loadPlans();
    showToast('Blueprint removed from plan', 'success');
  } catch (error) {
    showToast('Failed to remove blueprint: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Toggle intermediate built status
window.showMarkBuiltModal = async function(intermediateBlueprintId) {
  console.log('showMarkBuiltModal called with:', intermediateBlueprintId);
  console.log('Current selectedPlanId:', selectedPlanId);

  try {
    if (!selectedPlanId) {
      console.error('No plan selected!');
      showToast('No plan selected', 'error');
      return;
    }

    // Get all intermediates for this plan
    console.log('Fetching intermediates for plan:', selectedPlanId);
    const allIntermediates = await window.electronAPI.plans.getAllIntermediates(selectedPlanId);
    console.log('Got intermediates:', allIntermediates.length);

    const intermediate = allIntermediates.find(i => i.planBlueprintId === intermediateBlueprintId);
    console.log('Found intermediate:', intermediate);

    if (!intermediate) {
      console.error('Intermediate not found in list');
      showToast('Intermediate blueprint not found', 'error');
      return;
    }

    // Get type name for display
    console.log('About to fetch type name for:', intermediate.intermediateProductTypeId);
    const typeNames = await window.electronAPI.sde.getTypeNames([intermediate.intermediateProductTypeId]);
    console.log('Type names result:', typeNames);
    const name = typeNames[intermediate.intermediateProductTypeId] || 'Unknown';
    console.log('Using name:', name);

    // Fetch owned assets for this product type
    const ownedAssets = await window.electronAPI.plans.getProductOwnedAssets(selectedPlanId, intermediate.intermediateProductTypeId);
    console.log('Owned assets:', ownedAssets);
    const totalOwned = ownedAssets.ownedPersonal + ownedAssets.ownedCorp;

    // Build owned assets HTML section
    let ownedAssetsHtml = '';
    if (totalOwned > 0 || ownedAssets.personalDetails.length > 0 || ownedAssets.corpDetails.length > 0) {
      ownedAssetsHtml = `
        <div class="owned-assets-section">
          <h4>Owned Assets</h4>
          <div class="owned-assets-summary">
            <span class="owned-total">Total Owned: <strong>${formatNumber(totalOwned)}</strong></span>
          </div>
          ${ownedAssets.personalDetails.length > 0 ? `
            <div class="owned-assets-group">
              <h5>Personal Hangars (${formatNumber(ownedAssets.ownedPersonal)})</h5>
              <ul class="owned-assets-list">
                ${ownedAssets.personalDetails.map(d => `
                  <li>${escapeHtml(d.characterName)}: <strong>${formatNumber(d.quantity)}</strong></li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
          ${ownedAssets.corpDetails.length > 0 ? `
            <div class="owned-assets-group">
              <h5>Corporation Hangars (${formatNumber(ownedAssets.ownedCorp)})</h5>
              <ul class="owned-assets-list">
                ${ownedAssets.corpDetails.map(d => `
                  <li>${escapeHtml(d.corporationName)} - ${escapeHtml(d.divisionName)}: <strong>${formatNumber(d.quantity)}</strong></li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
        </div>
      `;
    } else {
      ownedAssetsHtml = `
        <div class="owned-assets-section">
          <h4>Owned Assets</h4>
          <p class="no-assets-message">No assets found in configured character/corporation hangars.</p>
        </div>
      `;
    }

    // Create modal
    console.log('Creating modal element...');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    console.log('Setting modal HTML...');
    modal.innerHTML = `
      <div class="modal-content mark-built-modal">
        <div class="modal-header">
          <h3>Mark Intermediate as Built</h3>
          <button class="close-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <p><strong>${escapeHtml(name)}</strong></p>
          <p>Total Runs Needed: <strong>${intermediate.runs}</strong></p>

          <label for="built-runs-input">Runs Already Built:</label>
          <input
            type="number"
            id="built-runs-input"
            min="0"
            max="${intermediate.runs}"
            value="${intermediate.builtRuns || 0}"
            step="1"
          />

          <div class="quick-actions">
            <button class="secondary-button small" data-percent="0">0% (None)</button>
            <button class="secondary-button small" data-percent="25">25%</button>
            <button class="secondary-button small" data-percent="50">50%</button>
            <button class="secondary-button small" data-percent="75">75%</button>
            <button class="secondary-button small" data-percent="100">100% (All)</button>
          </div>

          <div class="built-progress">
            <div class="progress-bar">
              <div class="progress-fill" id="built-progress-fill" style="width: ${Math.round(((intermediate.builtRuns || 0) / intermediate.runs) * 100)}%"></div>
            </div>
            <span id="built-percentage">${Math.round(((intermediate.builtRuns || 0) / intermediate.runs) * 100)}%</span>
          </div>

          ${ownedAssetsHtml}
        </div>
        <div class="modal-footer">
          <button class="secondary-button cancel-btn">Cancel</button>
          <button class="primary-button save-btn">Save</button>
        </div>
      </div>
    `;

    console.log('Modal HTML set, about to append to body');
    document.body.appendChild(modal);
    console.log('Modal appended to body successfully');

    const input = modal.querySelector('#built-runs-input');
    const progressFill = modal.querySelector('#built-progress-fill');
    const percentageText = modal.querySelector('#built-percentage');
    const closeBtn = modal.querySelector('.close-modal');
    const cancelBtn = modal.querySelector('.cancel-btn');
    const saveBtn = modal.querySelector('.save-btn');

    // Update progress bar on input change
    function updateProgress() {
      const value = parseInt(input.value) || 0;
      const percentage = Math.round((value / intermediate.runs) * 100);
      progressFill.style.width = percentage + '%';
      percentageText.textContent = percentage + '%';
    }

    input.addEventListener('input', updateProgress);

    // Quick action buttons
    modal.querySelectorAll('.quick-actions button').forEach(btn => {
      btn.addEventListener('click', () => {
        const percent = parseInt(btn.dataset.percent);
        const runs = Math.round((percent / 100) * intermediate.runs);
        input.value = runs;
        updateProgress();
      });
    });

    // Close handlers
    function closeModal() {
      modal.remove();
    }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Save handler
    saveBtn.addEventListener('click', async () => {
      const builtRuns = parseInt(input.value) || 0;

      if (builtRuns < 0 || builtRuns > intermediate.runs) {
        showToast(`Invalid value. Must be between 0 and ${intermediate.runs}`, 'error');
        return;
      }

      try {
        closeModal();
        showLoading('Updating built quantity...');
        const result = await window.electronAPI.plans.markIntermediateBuilt(intermediateBlueprintId, builtRuns);

        if (result.warnings && result.warnings.length > 0) {
          for (const warning of result.warnings) {
            showToast(warning, 'warning');
          }
        }

        await loadBlueprints();
        await loadMaterials();
        await loadOverview();
        showToast(`Updated built quantity to ${builtRuns} runs`, 'success');
      } catch (error) {
        showToast('Failed to update built quantity: ' + error.message, 'error');
      } finally {
        hideLoading();
      }
    });

  } catch (error) {
    console.error('Error showing mark built modal:', error);
    showToast('Failed to show modal: ' + error.message, 'error');
  }
};

// Keep old function for backward compatibility during transition
window.toggleIntermediateBuilt = async function(intermediateBlueprintId, currentlyBuilt) {
  console.log('toggleIntermediateBuilt called with:', intermediateBlueprintId, currentlyBuilt);
  console.log('selectedPlanId:', selectedPlanId);
  try {
    // Redirect to new modal
    await window.showMarkBuiltModal(intermediateBlueprintId);
  } catch (error) {
    console.error('Error in toggleIntermediateBuilt:', error);
    showToast('Error opening modal: ' + error.message, 'error');
  }
};

// Edit intermediate blueprint
window.editIntermediateBlueprint = function(intermediateBlueprintId) {
  const row = document.querySelector(`tr.intermediate-blueprint[data-blueprint-id="${intermediateBlueprintId}"]`);
  if (!row) return;

  row.dataset.editing = 'true';

  // Show inputs for editable fields only (ME, TE, Facility)
  row.querySelectorAll('.editable-cell').forEach(cell => {
    cell.querySelector('.cell-value').style.display = 'none';
    cell.querySelector('.cell-input').style.display = 'block';
  });

  // Show save/cancel buttons, hide edit/toggle buttons
  row.querySelector('.edit-btn').style.display = 'none';
  row.querySelector('.toggle-built-btn').style.display = 'none';
  row.querySelector('.save-btn').style.display = 'inline-flex';
  row.querySelector('.cancel-btn').style.display = 'inline-flex';
};

// Save intermediate blueprint edits
window.saveIntermediateBlueprintEdit = async function(intermediateBlueprintId) {
  const row = document.querySelector(`tr.intermediate-blueprint[data-blueprint-id="${intermediateBlueprintId}"]`);
  if (!row) return;

  try {
    // Collect updated values (only ME, TE, Facility)
    const updates = {};

    row.querySelectorAll('.editable-cell').forEach(cell => {
      const field = cell.dataset.field;
      const input = cell.querySelector('.cell-input');

      if (field === 'facilityId') {
        const facilityId = input.value || null;
        updates.facilityId = facilityId;

        if (facilityId) {
          const facility = facilities.find(f => f.id === facilityId);
          if (facility) {
            updates.facilitySnapshot = facility;
          }
        } else {
          updates.facilitySnapshot = null;
        }
      } else if (field === 'useIntermediates') {
        // String field - don't parse as integer
        updates.useIntermediates = input.value;
        console.log(`[DEBUG] Setting useIntermediates to: ${input.value}`);
      } else if (field === 'meLevel') {
        updates.meLevel = parseInt(input.value);
      } else if (field === 'teLevel') {
        updates.teLevel = parseInt(input.value);
      }
    });

    console.log('[DEBUG] Updates object:', updates);

    showLoading('Updating intermediate blueprint...');
    await window.electronAPI.plans.updateIntermediateBlueprint(intermediateBlueprintId, updates);

    await loadBlueprints();
    await loadMaterials();
    await loadOverview();
    showToast('Intermediate blueprint updated successfully', 'success');
  } catch (error) {
    showToast('Failed to update intermediate blueprint: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
};

// Cancel intermediate blueprint edits
window.cancelIntermediateBlueprintEdit = function(intermediateBlueprintId) {
  const row = document.querySelector(`tr.intermediate-blueprint[data-blueprint-id="${intermediateBlueprintId}"]`);
  if (!row) return;

  row.dataset.editing = 'false';

  // Show values, hide inputs (reset to original values)
  row.querySelectorAll('.editable-cell').forEach(cell => {
    const value = cell.querySelector('.cell-value');
    const input = cell.querySelector('.cell-input');

    // Reset input to original value
    if (input.tagName === 'SELECT') {
      const originalValue = input.querySelector('option[selected]')?.value || '';
      input.value = originalValue;
    } else {
      const originalValue = value.textContent;
      input.value = originalValue;
    }

    value.style.display = 'block';
    input.style.display = 'none';
  });

  // Show edit/built buttons, hide save/cancel buttons
  row.querySelector('.edit-btn').style.display = 'inline-flex';
  row.querySelector('.toggle-built-btn').style.display = 'inline-flex';
  row.querySelector('.save-btn').style.display = 'none';
  row.querySelector('.cancel-btn').style.display = 'none';
};

// Refresh prices
async function refreshPrices() {
  if (!selectedPlanId) return;

  const confirmed = await showConfirmDialog(
    'Refresh all material and product prices from the market? This will overwrite frozen prices.',
    'Refresh Prices',
    'Refresh',
    'Cancel'
  );

  if (!confirmed) return;

  try {
    showLoading('Refreshing prices from market...');
    await window.electronAPI.plans.recalculateMaterials(selectedPlanId, true);
    await loadMaterials();
    await loadProducts();
    await loadOverview();
    // Reload plans list to update summary card with new prices
    await loadPlans();
    showToast('Prices refreshed successfully', 'success');
  } catch (error) {
    showToast('Failed to refresh prices: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Filter plans
function filterPlans() {
  renderPlansList();
}

// Load jobs tab
async function loadJobs() {
  const container = document.getElementById('jobs-list-tab');

  try {
    const pendingMatches = await window.electronAPI.plans.getPendingMatches(selectedPlanId);
    const pendingJobMatches = pendingMatches.jobMatches || [];

    const confirmedJobMatches = await window.electronAPI.plans.getConfirmedJobMatches(selectedPlanId);

    // Get all blueprint names
    const allMatches = [...pendingJobMatches, ...confirmedJobMatches];
    const blueprintTypeIds = [...new Set(allMatches.map(m => m.planBlueprint?.blueprintTypeId).filter(Boolean))];
    const names = blueprintTypeIds.length > 0 ? await window.electronAPI.sde.getBlueprintNames(blueprintTypeIds) : {};

    let html = '';

    // Pending Matches Section
    html += '<div class="jobs-section">';
    if (pendingJobMatches.length > 0) {
      html += `
        <h3 class="section-header">Pending Job Matches</h3>
        <table>
          <thead>
            <tr>
              <th>Blueprint</th>
              <th>Character</th>
              <th>Job ID</th>
              <th>Runs</th>
              <th>Status</th>
              <th>Facility</th>
              <th>Confidence</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pendingJobMatches.map(match => {
              const blueprintName = match.planBlueprint?.blueprintTypeId
                ? (names[match.planBlueprint.blueprintTypeId] || `Type ${match.planBlueprint.blueprintTypeId}`)
                : 'Unknown';
              const confidence = (match.confidence * 100).toFixed(0);
              const confidenceClass = match.confidence >= 0.8 ? 'high' : match.confidence >= 0.5 ? 'medium' : 'low';
              const facilityName = match.job?.facilityId || 'Unknown';
              const jobStatus = match.job?.status || 'unknown';

              return `
                <tr data-match-id="${match.matchId}">
                  <td>${escapeHtml(blueprintName)}</td>
                  <td>${escapeHtml(match.job?.characterName || 'Unknown')}</td>
                  <td>${match.job?.jobId || 'N/A'}</td>
                  <td>${match.job?.runs || 'N/A'}</td>
                  <td>${jobStatus}</td>
                  <td>${facilityName}</td>
                  <td><span class="confidence-badge ${confidenceClass}">${confidence}%</span></td>
                  <td>
                    <button class="secondary-button small" data-action="confirm-job">Confirm</button>
                    <button class="secondary-button small" data-action="reject-job">Reject</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      html += '<div class="loading">No pending job matches found. Click "Match Jobs" to find matches from ESI.</div>';
    }
    html += '</div>';

    // Linked Jobs Section
    if (confirmedJobMatches.length > 0) {
      html += `
        <div class="jobs-section">
          <h3 class="section-header">Linked Jobs</h3>
          <table>
            <thead>
              <tr>
                <th>Blueprint</th>
                <th>Character</th>
                <th>Job ID</th>
                <th>Runs</th>
                <th>Status</th>
                <th>Facility</th>
                <th>Linked At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${confirmedJobMatches.map(match => {
                const blueprintName = match.planBlueprint?.blueprintTypeId
                  ? (names[match.planBlueprint.blueprintTypeId] || `Type ${match.planBlueprint.blueprintTypeId}`)
                  : 'Unknown';
                const facilityName = match.job?.facilityId || 'Unknown';
                const jobStatus = match.job?.status || 'unknown';
                const linkedDate = match.confirmedAt ? new Date(match.confirmedAt).toLocaleString() : 'Unknown';

                return `
                  <tr data-match-id="${match.matchId}">
                    <td>${escapeHtml(blueprintName)}</td>
                    <td>${escapeHtml(match.job?.characterName || 'Unknown')}</td>
                    <td>${match.job?.jobId || 'N/A'}</td>
                    <td>${match.job?.runs || 'N/A'}</td>
                    <td>${jobStatus}</td>
                    <td>${facilityName}</td>
                    <td>${linkedDate}</td>
                    <td>
                      <button class="secondary-button small" data-action="unlink-job">Unlink</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    container.innerHTML = html;

    // Add event listeners for pending job match actions
    container.querySelectorAll('tr[data-match-id] [data-action="confirm-job"]').forEach(btn => {
      const matchId = btn.closest('tr').dataset.matchId;
      btn.addEventListener('click', () => confirmJobMatch(matchId));
    });

    container.querySelectorAll('tr[data-match-id] [data-action="reject-job"]').forEach(btn => {
      const matchId = btn.closest('tr').dataset.matchId;
      btn.addEventListener('click', () => rejectJobMatch(matchId));
    });

    // Add event listeners for unlink actions
    container.querySelectorAll('tr[data-match-id] [data-action="unlink-job"]').forEach(btn => {
      const matchId = btn.closest('tr').dataset.matchId;
      btn.addEventListener('click', () => unlinkJobMatch(matchId));
    });
  } catch (error) {
    console.error('Failed to load job matches:', error);
    container.innerHTML = '<div class="loading">Failed to load job matches</div>';
  }
}

// Load transactions tab
async function loadTransactions() {
  const container = document.getElementById('transactions-list-tab');

  try {
    const pendingMatches = await window.electronAPI.plans.getPendingMatches(selectedPlanId);
    const pendingTransactionMatches = pendingMatches.transactionMatches || [];

    const confirmedTransactionMatches = await window.electronAPI.plans.getConfirmedTransactionMatches(selectedPlanId);

    // Get all type names
    const allMatches = [...pendingTransactionMatches, ...confirmedTransactionMatches];
    const typeIds = [...new Set(allMatches.map(m => m.transaction?.typeId).filter(Boolean))];
    const names = typeIds.length > 0 ? await window.electronAPI.sde.getTypeNames(typeIds) : {};

    let html = '';

    // Pending Matches Section
    html += '<div class="jobs-section">';
    if (pendingTransactionMatches.length > 0) {
      html += `
        <h3 class="section-header">Pending Transaction Matches</h3>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Character</th>
              <th>Transaction ID</th>
              <th>Quantity</th>
              <th>Price</th>
              <th>Total</th>
              <th>Type</th>
              <th>Confidence</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pendingTransactionMatches.map(match => {
              const typeName = match.transaction?.typeId
                ? (names[match.transaction.typeId] || `Type ${match.transaction.typeId}`)
                : 'Unknown';
              const confidence = (match.confidence * 100).toFixed(0);
              const confidenceClass = match.confidence >= 0.8 ? 'high' : match.confidence >= 0.5 ? 'medium' : 'low';
              const quantity = match.transaction?.quantity || 0;
              const price = match.transaction?.unitPrice || 0;
              const total = quantity * price;
              const matchType = match.matchType === 'material_buy' ? 'Purchase' : 'Sale';

              return `
                <tr data-match-id="${match.matchId}">
                  <td>${escapeHtml(typeName)}</td>
                  <td>${escapeHtml(match.transaction?.characterName || 'Unknown')}</td>
                  <td>${match.transaction?.transactionId || 'N/A'}</td>
                  <td>${formatNumber(quantity)}</td>
                  <td>${formatISK(price)}</td>
                  <td>${formatISK(total)}</td>
                  <td>${matchType}</td>
                  <td><span class="confidence-badge ${confidenceClass}">${confidence}%</span></td>
                  <td>
                    <button class="secondary-button small" data-action="confirm-transaction">Confirm</button>
                    <button class="secondary-button small" data-action="reject-transaction">Reject</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      html += '<div class="loading">No pending transaction matches found. Click "Match Transactions" to find matches from ESI.</div>';
    }
    html += '</div>';

    // Linked Transactions Section
    if (confirmedTransactionMatches.length > 0) {
      html += `
        <div class="jobs-section">
          <h3 class="section-header">Linked Transactions</h3>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Character</th>
                <th>Transaction ID</th>
                <th>Quantity</th>
                <th>Price</th>
                <th>Total</th>
                <th>Type</th>
                <th>Linked At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${confirmedTransactionMatches.map(match => {
                const typeName = match.transaction?.typeId
                  ? (names[match.transaction.typeId] || `Type ${match.transaction.typeId}`)
                  : 'Unknown';
                const quantity = match.transaction?.quantity || 0;
                const price = match.transaction?.unitPrice || 0;
                const total = quantity * price;
                const matchType = match.matchType === 'material_buy' ? 'Purchase' : 'Sale';
                const linkedDate = match.confirmedAt ? new Date(match.confirmedAt).toLocaleString() : 'Unknown';

                return `
                  <tr data-match-id="${match.matchId}">
                    <td>${escapeHtml(typeName)}</td>
                    <td>${escapeHtml(match.transaction?.characterName || 'Unknown')}</td>
                    <td>${match.transaction?.transactionId || 'N/A'}</td>
                    <td>${formatNumber(quantity)}</td>
                    <td>${formatISK(price)}</td>
                    <td>${formatISK(total)}</td>
                    <td>${matchType}</td>
                    <td>${linkedDate}</td>
                    <td>
                      <button class="secondary-button small" data-action="unlink-transaction">Unlink</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    container.innerHTML = html;

    // Add event listeners for pending transaction match actions
    container.querySelectorAll('tr[data-match-id] [data-action="confirm-transaction"]').forEach(btn => {
      const matchId = btn.closest('tr').dataset.matchId;
      btn.addEventListener('click', () => confirmTransactionMatch(matchId));
    });

    container.querySelectorAll('tr[data-match-id] [data-action="reject-transaction"]').forEach(btn => {
      const matchId = btn.closest('tr').dataset.matchId;
      btn.addEventListener('click', () => rejectTransactionMatch(matchId));
    });

    // Add event listeners for unlink actions
    container.querySelectorAll('tr[data-match-id] [data-action="unlink-transaction"]').forEach(btn => {
      const matchId = btn.closest('tr').dataset.matchId;
      btn.addEventListener('click', () => unlinkTransactionMatch(matchId));
    });
  } catch (error) {
    console.error('Failed to load transaction matches:', error);
    container.innerHTML = '<div class="loading">Failed to load transaction matches</div>';
  }
}

// Match jobs
async function matchJobs() {
  if (!selectedPlanId) return;

  try {
    showLoading('Matching industry jobs...');

    // Get configured characters from plan settings
    const planSettings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    let characterIds = planSettings.defaultCharacters || [];

    if (characterIds.length === 0) {
      // Fallback: use current character
      characterIds = [currentCharacterId];
    }

    // Match using ALL characters
    const matches = await window.electronAPI.plans.matchJobs(selectedPlanId, {
      characterIds,
      minConfidence: 0.3
    });

    if (matches.length === 0) {
      showToast('No job matches found. Make sure you have industry jobs running and blueprints in the plan.', 'info');
      return;
    }

    await window.electronAPI.plans.saveJobMatches(matches);
    await loadJobs();
    showToast(`Found ${matches.length} potential job match${matches.length > 1 ? 'es' : ''}`, 'success');
  } catch (error) {
    showToast('Failed to match jobs: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Match transactions
async function matchTransactions() {
  if (!selectedPlanId) return;

  try {
    showLoading('Matching wallet transactions...');

    // Get configured characters from plan settings
    const planSettings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    let characterIds = planSettings.defaultCharacters || [];

    if (characterIds.length === 0) {
      // Fallback: use current character
      characterIds = [currentCharacterId];
    }

    // Match using ALL characters
    const matches = await window.electronAPI.plans.matchTransactions(selectedPlanId, {
      characterIds,
      minConfidence: 0.3
    });

    if (matches.length === 0) {
      showToast('No transaction matches found. Make sure you have wallet transactions and materials/products in the plan.', 'info');
      return;
    }

    await window.electronAPI.plans.saveTransactionMatches(matches);
    await loadTransactions();
    showToast(`Found ${matches.length} potential transaction match${matches.length > 1 ? 'es' : ''}`, 'success');
  } catch (error) {
    showToast('Failed to match transactions: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Confirm job match
window.confirmJobMatch = async function(matchId) {
  try {
    await window.electronAPI.plans.confirmJobMatch(matchId);
    await loadJobs();
    await loadOverview(); // Update stats
    // Reload analytics tab if active
    if (activeTab === 'analytics') {
      await loadAnalytics();
    }
    showToast('Job match confirmed', 'success');
  } catch (error) {
    showToast('Failed to confirm job match: ' + error.message, 'error');
  }
};

// Reject job match
window.rejectJobMatch = async function(matchId) {
  try {
    await window.electronAPI.plans.rejectJobMatch(matchId);
    await loadJobs();
    showToast('Job match rejected', 'info');
  } catch (error) {
    showToast('Failed to reject job match: ' + error.message, 'error');
  }
};

// Unlink job match
window.unlinkJobMatch = async function(matchId) {
  try {
    await window.electronAPI.plans.unlinkJobMatch(matchId);
    await loadJobs();
    await loadOverview(); // Update stats
    // Reload analytics tab if active
    if (activeTab === 'analytics') {
      await loadAnalytics();
    }
    showToast('Job unlinked successfully', 'info');
  } catch (error) {
    showToast('Failed to unlink job: ' + error.message, 'error');
  }
};

// Confirm transaction match
window.confirmTransactionMatch = async function(matchId) {
  try {
    await window.electronAPI.plans.confirmTransactionMatch(matchId);
    await loadTransactions();
    await loadOverview(); // Update stats
    // Reload analytics tab if active
    if (activeTab === 'analytics') {
      await loadAnalytics();
    }
    showToast('Transaction match confirmed', 'success');
  } catch (error) {
    showToast('Failed to confirm transaction match: ' + error.message, 'error');
  }
};

// Reject transaction match
window.rejectTransactionMatch = async function(matchId) {
  try {
    await window.electronAPI.plans.rejectTransactionMatch(matchId);
    await loadTransactions();
    showToast('Transaction match rejected', 'info');
  } catch (error) {
    showToast('Failed to reject transaction match: ' + error.message, 'error');
  }
};

// Unlink transaction match
window.unlinkTransactionMatch = async function(matchId) {
  try {
    await window.electronAPI.plans.unlinkTransactionMatch(matchId);
    await loadTransactions();
    await loadOverview(); // Update stats
    // Reload analytics tab if active
    if (activeTab === 'analytics') {
      await loadAnalytics();
    }
    showToast('Transaction unlinked successfully', 'info');
  } catch (error) {
    showToast('Failed to unlink transaction: ' + error.message, 'error');
  }
};

// Load analytics tab
async function loadAnalytics() {
  try {
    const analytics = await window.electronAPI.plans.getAnalytics(selectedPlanId);

    // Update progress bars
    updateProgressBar('jobs', analytics.progress.jobs.completed, analytics.progress.jobs.total, analytics.progress.jobs.percent);
    updateProgressBar('materials', analytics.progress.materials.purchased, analytics.progress.materials.total, analytics.progress.materials.percent);
    updateProgressBar('products', analytics.progress.products.sold, analytics.progress.products.total, analytics.progress.products.percent);
    updateProgressBar('overall', 0, 0, analytics.progress.overall);

    // Update material costs comparison
    document.getElementById('planned-material-cost').textContent = formatISK(analytics.materialCosts.planned);
    document.getElementById('actual-material-cost').textContent = formatISK(analytics.materialCosts.actual);
    const materialDeltaEl = document.getElementById('material-cost-delta');
    materialDeltaEl.textContent = `${formatISK(analytics.materialCosts.delta)} (${analytics.materialCosts.deltaPercent.toFixed(1)}%)`;
    materialDeltaEl.style.color = analytics.materialCosts.delta < 0 ? '#57f287' : '#ed4245';

    // Update product value comparison
    document.getElementById('planned-product-value').textContent = formatISK(analytics.productValue.planned);
    document.getElementById('actual-product-value').textContent = formatISK(analytics.productValue.actual);
    const productDeltaEl = document.getElementById('product-value-delta');
    productDeltaEl.textContent = `${formatISK(analytics.productValue.delta)} (${analytics.productValue.deltaPercent.toFixed(1)}%)`;
    productDeltaEl.style.color = analytics.productValue.delta > 0 ? '#57f287' : '#ed4245';

    // Update profit comparison
    document.getElementById('planned-profit').textContent = formatISK(analytics.profit.planned);
    document.getElementById('actual-profit').textContent = formatISK(analytics.profit.actual);
    const profitDeltaEl = document.getElementById('profit-delta');
    profitDeltaEl.textContent = `${formatISK(analytics.profit.delta)} (${analytics.profit.deltaPercent.toFixed(1)}%)`;
    profitDeltaEl.style.color = analytics.profit.delta > 0 ? '#57f287' : '#ed4245';

    // Update ROI comparison
    document.getElementById('planned-roi').textContent = `${analytics.summary.plannedROI.toFixed(1)}%`;
    document.getElementById('actual-roi').textContent = `${analytics.summary.actualROI.toFixed(1)}%`;
    const roiDelta = analytics.summary.actualROI - analytics.summary.plannedROI;
    const roiDeltaEl = document.getElementById('roi-delta');
    roiDeltaEl.textContent = `${roiDelta > 0 ? '+' : ''}${roiDelta.toFixed(1)}%`;
    roiDeltaEl.style.color = roiDelta > 0 ? '#57f287' : '#ed4245';

  } catch (error) {
    console.error('Failed to load analytics:', error);
  }
}

/**
 * Load settings tab content
 */
async function loadSettings() {
  if (!selectedPlanId) {
    console.warn('No plan selected');
    return;
  }

  try {
    // Get plan settings
    const planSettings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);

    // Load corporation divisions (per-character)
    await loadPlanDivisions(planSettings.enabledDivisions);

    // Load default characters
    await loadPlanDefaultCharacters(planSettings.defaultCharacters);

    // Load reactions toggle
    const reactionsCheckbox = document.getElementById('plan-reactions-as-intermediates');
    if (reactionsCheckbox) {
      reactionsCheckbox.checked = planSettings.reactionsAsIntermediates;

      // Add event listener
      reactionsCheckbox.removeEventListener('change', handlePlanReactionsToggle);
      reactionsCheckbox.addEventListener('change', handlePlanReactionsToggle);
    }

  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

/**
 * Load plan corporation divisions (per-character sections)
 */
async function loadPlanDivisions(enabledDivisionsMap) {
  const containerEl = document.getElementById('plan-character-divisions-container');
  if (!containerEl) return;

  try {
    containerEl.innerHTML = '<div class="divisions-loading"><div class="spinner"></div><span>Loading divisions...</span></div>';

    // Get all characters
    const characters = await window.electronAPI.esi.getCharacters();

    if (characters.length === 0) {
      containerEl.innerHTML = '<p class="no-data">No characters authenticated.</p>';
      return;
    }

    // Build complete HTML for all characters first (avoids insertAdjacentHTML race conditions)
    let html = '';
    for (const character of characters) {
      html += await buildPlanCharacterDivisionHTML(character, enabledDivisionsMap[character.characterId] || []);
    }

    // Set all HTML at once (destroys old elements and their listeners)
    containerEl.innerHTML = html;

    // Add event listeners AFTER all HTML is in DOM
    for (const character of characters) {
      attachPlanDivisionEventListeners(character.characterId);
    }

  } catch (error) {
    console.error('Error loading plan divisions:', error);
    containerEl.innerHTML = '<p class="error-text">Failed to load divisions</p>';
  }
}

/**
 * Build HTML for collapsible division section for one character
 * Returns HTML string instead of inserting directly (to avoid race conditions)
 */
async function buildPlanCharacterDivisionHTML(character, enabledDivisions) {
  const characterId = character.characterId;

  // Get division names from character settings
  const divisionSettings = await window.electronAPI.divisions.getSettings(characterId);
  const divisionNames = divisionSettings.divisionNames || {};

  // Build selected divisions summary
  let selectedSummary = 'None selected';
  if (enabledDivisions.length > 0) {
    const divisionLabels = enabledDivisions.map(divId => divisionNames[divId] || `Division ${divId}`);
    selectedSummary = divisionLabels.join(', ');
  }

  // Return section HTML (same pattern as settings-renderer.js)
  return `
    <div class="character-division-section">
      <div class="character-division-header" id="plan-division-header-${characterId}">
        <div class="character-division-header-left">
          <span class="expand-toggle" id="plan-expand-toggle-${characterId}">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
          <span class="character-name">${character.characterName}</span>
        </div>
        <div class="character-division-summary" id="plan-division-summary-${characterId}">
          <span class="summary-label">Selected:</span>
          <span class="summary-value">${selectedSummary}</span>
        </div>
      </div>
      <div class="character-division-content" id="plan-division-content-${characterId}" style="display: none;">
        <div class="divisions-grid" id="plan-divisions-grid-${characterId}">
          ${renderPlanDivisionCheckboxes(characterId, enabledDivisions, divisionNames)}
        </div>
      </div>
    </div>
  `;
}

/**
 * Attach event listeners for a character's division section
 * Called after HTML is set via innerHTML (which destroys old elements/listeners)
 */
function attachPlanDivisionEventListeners(characterId) {
  const headerEl = document.getElementById(`plan-division-header-${characterId}`);
  if (headerEl) {
    headerEl.addEventListener('click', () => togglePlanCharacterDivisions(characterId));
  }

  const checkboxes = document.querySelectorAll(`#plan-divisions-grid-${characterId} .division-checkbox`);
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('change', handlePlanDivisionToggle);
  });
}

/**
 * Render division checkboxes HTML
 */
function renderPlanDivisionCheckboxes(characterId, enabledDivisions, divisionNames) {
  let html = '';
  for (let divId = 1; divId <= 7; divId++) {
    const isChecked = enabledDivisions.includes(divId);
    const divName = divisionNames[divId] || `Division ${divId}`;

    html += `
      <div class="division-item">
        <label class="division-label">
          <input
            type="checkbox"
            class="division-checkbox"
            data-character="${characterId}"
            data-division="${divId}"
            ${isChecked ? 'checked' : ''}
          />
          <span class="division-name">${divName}</span>
          ${divisionNames[divId] ? '<span class="custom-name-badge">Custom</span>' : ''}
        </label>
      </div>
    `;
  }
  return html;
}

/**
 * Toggle expand/collapse division section
 */
function togglePlanCharacterDivisions(characterId) {
  const contentEl = document.getElementById(`plan-division-content-${characterId}`);
  const toggleIcon = document.getElementById(`plan-expand-toggle-${characterId}`);

  if (!contentEl || !toggleIcon) return;

  const isExpanded = contentEl.style.display !== 'none';

  if (isExpanded) {
    contentEl.style.display = 'none';
    toggleIcon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    `;
  } else {
    contentEl.style.display = 'block';
    toggleIcon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="18 15 12 9 6 15"></polyline>
      </svg>
    `;
  }
}

/**
 * Handle division checkbox toggle
 */
async function handlePlanDivisionToggle(event) {
  const checkbox = event.target;
  const characterId = parseInt(checkbox.getAttribute('data-character'));
  const divisionId = parseInt(checkbox.getAttribute('data-division'));
  const isChecked = checkbox.checked;

  try {
    // Get current plan settings
    const settings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    let enabledDivisions = settings.enabledDivisions[characterId] || [];

    // Update array
    if (isChecked) {
      if (!enabledDivisions.includes(divisionId)) {
        enabledDivisions.push(divisionId);
      }
    } else {
      enabledDivisions = enabledDivisions.filter(id => id !== divisionId);
    }

    enabledDivisions.sort((a, b) => a - b);

    // Save to database
    const success = await window.electronAPI.plans.updateCharacterDivisions(
      selectedPlanId,
      characterId,
      enabledDivisions
    );

    if (!success) {
      console.error('Failed to update plan divisions');
      checkbox.checked = !isChecked;
      showToast('Failed to update divisions', 'error');
    } else {
      console.log(`Updated plan divisions for character ${characterId}:`, enabledDivisions);
      // Update header summary
      await updatePlanDivisionHeader(characterId);
      // Reload materials tab to reflect division changes
      if (activeTab === 'materials') {
        await loadMaterials();
      }
    }

  } catch (error) {
    console.error('Error toggling plan division:', error);
    checkbox.checked = !isChecked;
    showToast('Error updating divisions', 'error');
  }
}

/**
 * Update division header summary
 */
async function updatePlanDivisionHeader(characterId) {
  const summaryEl = document.getElementById(`plan-division-summary-${characterId}`);
  if (!summaryEl) return;

  try {
    const settings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    const enabledDivisions = settings.enabledDivisions[characterId] || [];
    const divisionSettings = await window.electronAPI.divisions.getSettings(characterId);
    const divisionNames = divisionSettings.divisionNames || {};

    let selectedSummary = 'None selected';
    if (enabledDivisions.length > 0) {
      const divisionLabels = enabledDivisions.map(divId => divisionNames[divId] || `Division ${divId}`);
      selectedSummary = divisionLabels.join(', ');
    }

    summaryEl.innerHTML = `
      <span class="summary-label">Selected:</span>
      <span class="summary-value">${selectedSummary}</span>
    `;
  } catch (error) {
    console.error('Error updating division header:', error);
  }
}

/**
 * Load plan default manufacturing characters
 */
async function loadPlanDefaultCharacters(defaultCharacterIds) {
  const containerEl = document.getElementById('plan-default-characters-container');
  if (!containerEl) return;

  try {
    containerEl.innerHTML = '<div class="divisions-loading"><div class="spinner"></div><span>Loading characters...</span></div>';

    const characters = await window.electronAPI.esi.getCharacters();

    if (characters.length === 0) {
      containerEl.innerHTML = '<p class="no-data">No characters authenticated.</p>';
      return;
    }

    let html = '<div class="default-characters-grid">';

    for (const character of characters) {
      const isChecked = defaultCharacterIds.includes(character.characterId);

      html += `
        <div class="character-checkbox-item">
          <label class="character-checkbox-label">
            <input
              type="checkbox"
              class="character-checkbox"
              data-character-id="${character.characterId}"
              ${isChecked ? 'checked' : ''}
            />
            <span class="character-checkbox-name">${character.characterName}</span>
          </label>
        </div>
      `;
    }

    html += '</div>';
    containerEl.innerHTML = html;

    // Add event listeners
    const checkboxes = containerEl.querySelectorAll('.character-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', handlePlanDefaultCharacterToggle);
    });

  } catch (error) {
    console.error('Error loading plan default characters:', error);
    containerEl.innerHTML = '<p class="error-text">Failed to load characters</p>';
  }
}

/**
 * Handle default character checkbox toggle
 */
async function handlePlanDefaultCharacterToggle(event) {
  const checkbox = event.target;
  const characterId = parseInt(checkbox.getAttribute('data-character-id'));
  const isChecked = checkbox.checked;

  try {
    const settings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    let defaultCharacters = settings.defaultCharacters || [];

    if (isChecked) {
      if (!defaultCharacters.includes(characterId)) {
        defaultCharacters.push(characterId);
      }
    } else {
      defaultCharacters = defaultCharacters.filter(id => id !== characterId);
    }

    settings.defaultCharacters = defaultCharacters;
    const success = await window.electronAPI.plans.updateIndustrySettings(selectedPlanId, settings);

    if (!success) {
      console.error('Failed to update plan default characters');
      checkbox.checked = !isChecked;
      showToast('Failed to update default characters', 'error');
    } else {
      console.log('Updated plan default characters:', defaultCharacters);
      // Recalculate materials if character defaults changed
      await window.electronAPI.plans.recalculateMaterials(selectedPlanId, false);
      // Reload current tab to reflect changes
      await loadTabContent(activeTab);
      // Reload plans list to update summary card
      await loadPlans();
    }

  } catch (error) {
    console.error('Error toggling plan default character:', error);
    checkbox.checked = !isChecked;
    showToast('Error updating default characters', 'error');
  }
}

/**
 * Handle reactions toggle change
 */
async function handlePlanReactionsToggle(event) {
  const isChecked = event.target.checked;

  try {
    const settings = await window.electronAPI.plans.getIndustrySettings(selectedPlanId);
    settings.reactionsAsIntermediates = isChecked;

    const success = await window.electronAPI.plans.updateIndustrySettings(selectedPlanId, settings);

    if (!success) {
      console.error('Failed to update reactions setting');
      event.target.checked = !isChecked;
      showToast('Failed to update reactions setting', 'error');
    } else {
      console.log('Updated reactions as intermediates:', isChecked);
      // Recalculate materials when reactions setting changes
      await window.electronAPI.plans.recalculateMaterials(selectedPlanId, false);
      // Update reactions tab visibility
      await updateReactionsTabVisibility();
      // Reload current tab to reflect changes
      await loadTabContent(activeTab);
      // Reload plans list to update summary card
      await loadPlans();
    }

  } catch (error) {
    console.error('Error toggling reactions:', error);
    event.target.checked = !isChecked;
    showToast('Error updating reactions setting', 'error');
  }
}

// Update progress bar
function updateProgressBar(type, completed, total, percent) {
  const barEl = document.getElementById(`${type}-progress-bar`);
  const textEl = document.getElementById(`${type}-progress-text`);

  // Handle undefined/null percent
  const safePercent = percent || 0;
  barEl.style.width = `${Math.min(safePercent, 100)}%`;

  if (type === 'overall') {
    textEl.textContent = `${safePercent.toFixed(1)}%`;
  } else {
    textEl.textContent = `${completed || 0} / ${total || 0} (${safePercent.toFixed(1)}%)`;
  }
}

// Refresh ESI data
async function refreshESIData() {
  if (!selectedPlanId) {
    showToast('No plan selected', 'warning');
    return;
  }

  try {
    showLoading('Refreshing ESI data for all manufacturing characters...');
    // Use plan-based refresh to fetch data for all selected manufacturing characters
    const result = await window.electronAPI.plans.refreshPlanESIData(selectedPlanId);

    if (result.success) {
      const message = result.message || 'ESI data refreshed successfully';
      if (result.errors && result.errors.length > 0) {
        showToast(`${message} (${result.errors.length} error(s))`, 'warning');
        console.error('ESI refresh errors:', result.errors);
      } else {
        showToast(message, 'success');
      }
      // Reload current tab to show updated data
      await loadTabContent(activeTab);
    } else {
      showToast('Failed to refresh ESI data: ' + (result.message || 'Unknown error'), 'error');
    }
  } catch (error) {
    showToast('Failed to refresh ESI data: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Start auto-refresh for active plans (every 15 minutes)
function startAutoRefresh() {
  // Clear any existing interval
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }

  // Refresh every 15 minutes (900000 ms)
  const REFRESH_INTERVAL = 15 * 60 * 1000;

  autoRefreshInterval = setInterval(async () => {
    // Only refresh if viewing a plan
    if (!selectedPlanId) {
      return;
    }

    try {
      console.log('Auto-refreshing ESI data for plan...');
      // Use plan-based refresh instead of character-based
      const result = await window.electronAPI.plans.refreshPlanESIData(selectedPlanId);

      if (result.success) {
        console.log(`Auto-refresh: ${result.message}`);

        // Reload current tab to show new matches
        const currentTab = document.querySelector('.manufacturing-tab.active');
        if (currentTab) {
          const tabName = currentTab.dataset.tab;
          if (tabName === 'jobs') {
            await loadJobs();
          } else if (tabName === 'transactions') {
            await loadTransactions();
          }
        }
      }
    } catch (error) {
      console.error('Auto-refresh failed:', error);
    }
  }, REFRESH_INTERVAL);
}

// Stop auto-refresh (called when window is closed)
function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

// Refresh current view (manual refresh button)
async function refreshCurrentView() {
  if (!selectedPlanId) return;

  try {
    showLoading('Refreshing...');

    // Reload the current tab content
    await loadTabContent(activeTab);

    // Also reload the plans list to update summary stats
    await loadPlans();

    // Re-select the current plan to refresh the header
    const currentPlan = allPlans.find(p => p.planId === selectedPlanId);
    if (currentPlan) {
      await selectPlan(selectedPlanId);
    }

    showToast('View refreshed', 'success');
  } catch (error) {
    console.error('Failed to refresh view:', error);
    showToast('Failed to refresh view: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  stopAutoRefresh();
});

// Utility functions
function formatISK(value) {
  if (value === null || value === undefined) return 'N/A';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value).replace('$', '') + ' ISK';
}

function formatNumber(value, decimals = 0) {
  if (value === null || value === undefined) return '0';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(value);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Loading overlay functions
function showLoading(message = 'Loading...') {
  const overlay = document.getElementById('loading-overlay');
  const textEl = overlay.querySelector('.loading-text');
  textEl.textContent = message;
  overlay.style.display = 'flex';
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = 'none';
}

// Toast notification system
function showToast(message, type = 'info', title = null, duration = 5000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  const titles = {
    success: title || 'Success',
    error: title || 'Error',
    warning: title || 'Warning',
    info: title || 'Info'
  };

  toast.innerHTML = `
    <div class="toast-icon ${type}">${icons[type]}</div>
    <div class="toast-content">
      <div class="toast-title">${titles[type]}</div>
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(toast);

  // Close button
  toast.querySelector('.toast-close').addEventListener('click', () => {
    toast.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => toast.remove(), 300);
  });

  // Auto-remove after duration
  if (duration > 0) {
    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  return toast;
}

// Confirmation dialog
function showConfirmDialog(message, title = 'Confirm Action', confirmText = 'Confirm', cancelText = 'Cancel') {
  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <div class="confirm-dialog-content">
        <div class="confirm-dialog-header">
          <h3>${escapeHtml(title)}</h3>
        </div>
        <div class="confirm-dialog-body">
          ${escapeHtml(message)}
        </div>
        <div class="confirm-dialog-footer">
          <button class="secondary-button" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="primary-button" data-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const handleClick = (confirmed) => {
      dialog.remove();
      resolve(confirmed);
    };

    dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => handleClick(true));
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => handleClick(false));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) handleClick(false);
    });
  });
}

// Position tooltips dynamically for fixed positioning
document.addEventListener('DOMContentLoaded', () => {
  // Use event delegation for dynamically added tooltip cells
  document.addEventListener('mouseenter', (e) => {
    // Ensure e.target is an Element (not a text node or document)
    if (!e.target || typeof e.target.closest !== 'function') return;

    const tooltipCell = e.target.closest('.tooltip-cell');
    if (!tooltipCell) return;

    const tooltip = tooltipCell.querySelector('.tooltip-text');
    if (!tooltip) return;

    // Get the bounding rect of the cell
    const rect = tooltipCell.getBoundingClientRect();

    // Position tooltip below the cell, centered horizontally
    const tooltipLeft = rect.left + (rect.width / 2);
    const tooltipTop = rect.bottom + 8; // 8px gap below cell

    tooltip.style.left = `${tooltipLeft}px`;
    tooltip.style.top = `${tooltipTop}px`;
    tooltip.style.transform = 'translateX(-50%)';
  }, true); // Use capture phase to catch events early
});
