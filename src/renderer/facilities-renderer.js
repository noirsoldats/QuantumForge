// Facilities Manager Renderer

console.log('Facilities Manager initialized');

let facilities = [];
let regions = [];
let systems = [];
let structureTypes = [];
let structureRigs = [];
let editingFacilityId = null; // Track which facility is being edited

document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM loaded, initializing facilities manager');

  // Load initial data
  await loadInitialData();

  // Setup event listeners
  setupEventListeners();

  // Load existing facilities
  await loadFacilities();
});

// Load initial data (regions, structure types, rigs)
async function loadInitialData() {
  try {
    // Load regions
    console.log('Loading regions...');
    regions = await window.electronAPI.facilities.getAllRegions();
    console.log('Regions loaded:', regions.length);
    populateRegionDropdown();

    // Load all systems for display purposes
    console.log('Loading all systems...');
    const allSystemsData = await window.electronAPI.sde.getAllSystems();
    systems = allSystemsData.map(system => ({
      systemId: system.solarSystemID,
      systemName: system.solarSystemName,
      security: system.security,
      regionId: system.regionID
    }));
    console.log('Systems loaded:', systems.length);

    // Load structure types
    console.log('Loading structure types...');
    structureTypes = await window.electronAPI.facilities.getStructureTypes();
    console.log('Structure types loaded:', structureTypes.length);
    populateStructureTypesDropdown();

    // Load structure rigs
    console.log('Loading structure rigs...');
    structureRigs = await window.electronAPI.facilities.getStructureRigs();
    console.log('Structure rigs loaded:', structureRigs.length);
    populateRigsDropdowns();

    console.log('Initial data loaded successfully');
  } catch (error) {
    console.error('Error loading initial data:', error);
    alert('Error loading facility data. Please check the SDE is installed.');
  }
}

// Populate region dropdown
function populateRegionDropdown() {
  const regionSelect = document.getElementById('facility-region');
  regionSelect.innerHTML = '<option value="">Select Region</option>';

  regions.forEach(region => {
    const option = document.createElement('option');
    option.value = region.regionId;
    option.textContent = region.regionName;
    regionSelect.appendChild(option);
  });
}

// Populate structure types dropdown
function populateStructureTypesDropdown() {
  const structureTypeSelect = document.getElementById('structure-type');
  structureTypeSelect.innerHTML = '<option value="">Select Structure Type</option>';

  if (!structureTypes || structureTypes.length === 0) {
    console.warn('No structure types available to populate dropdown');
    const option = document.createElement('option');
    option.value = "";
    option.textContent = "No structures found - Check SDE";
    option.disabled = true;
    structureTypeSelect.appendChild(option);
    return;
  }

  console.log('Populating structure types dropdown with', structureTypes.length, 'structures');

  // All structures are Engineering Complexes now
  // Create a single optgroup
  const optgroup = document.createElement('optgroup');
  optgroup.label = 'Engineering Complexes';

  structureTypes.forEach(structure => {
    const option = document.createElement('option');
    option.value = structure.typeId;
    option.textContent = `${structure.typeName} (${structure.size})`;
    optgroup.appendChild(option);
  });

  structureTypeSelect.appendChild(optgroup);
}

// Populate rig dropdowns
function populateRigsDropdowns(filterBySize = null) {
  const rigsToShow = filterBySize
    ? structureRigs.filter(rig => rig.rigSize === filterBySize)
    : structureRigs;

  if (!rigsToShow || rigsToShow.length === 0) {
    console.warn('No structure rigs available to populate dropdowns for size:', filterBySize);
  } else {
    console.log('Populating rig dropdowns with', rigsToShow.length, 'rigs for size:', filterBySize);
  }

  ['rig-1', 'rig-2', 'rig-3'].forEach(rigId => {
    const rigSelect = document.getElementById(rigId);
    const currentValue = rigSelect.value; // Save current selection
    rigSelect.innerHTML = '<option value="">No Rig</option>';

    if (rigsToShow && rigsToShow.length > 0) {
      rigsToShow.forEach(rig => {
        const option = document.createElement('option');
        option.value = rig.typeId;
        option.textContent = rig.typeName;
        rigSelect.appendChild(option);
      });

      // Try to restore previous selection if it's still valid
      if (currentValue && rigsToShow.find(r => r.typeId == currentValue)) {
        rigSelect.value = currentValue;
      }
    }
  });
}

// Setup event listeners
function setupEventListeners() {
  // Back button
  const backBtn = document.getElementById('back-btn');
  backBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Facility type change
  const facilityTypeSelect = document.getElementById('facility-type');
  facilityTypeSelect.addEventListener('change', handleFacilityTypeChange);

  // Region change
  const regionSelect = document.getElementById('facility-region');
  regionSelect.addEventListener('change', handleRegionChange);

  // System change
  const systemSelect = document.getElementById('facility-system');
  systemSelect.addEventListener('change', handleSystemChange);

  // Structure type change
  const structureTypeSelect = document.getElementById('structure-type');
  structureTypeSelect.addEventListener('change', handleStructureTypeChange);

  // Rig changes
  ['rig-1', 'rig-2', 'rig-3'].forEach(rigId => {
    const rigSelect = document.getElementById(rigId);
    rigSelect.addEventListener('change', handleRigChange);
  });

  // Form submit
  const form = document.getElementById('add-facility-form');
  form.addEventListener('submit', handleFormSubmit);

  // Cancel button
  const cancelBtn = document.getElementById('cancel-btn');
  cancelBtn.addEventListener('click', clearForm);
}

// Handle facility type change
function handleFacilityTypeChange(e) {
  const facilityType = e.target.value;
  const structureFields = document.querySelectorAll('#structure-type-group, #rig1-group, #rig2-group, #rig3-group, #facility-tax-group, #facility-tax-spacer');
  const structureTypeSelect = document.getElementById('structure-type');
  const facilityTaxInput = document.getElementById('facility-tax');

  if (facilityType === 'structure') {
    structureFields.forEach(field => field.style.display = 'flex');
    // Make structure type required when structure is selected
    structureTypeSelect.setAttribute('required', 'required');
    // Set default facility tax for player structures (0%)
    if (!facilityTaxInput.value) {
      facilityTaxInput.value = '0.00';
    }
  } else {
    structureFields.forEach(field => field.style.display = 'none');
    document.getElementById('structure-bonuses-section').style.display = 'none';
    document.getElementById('rig-effects-section').style.display = 'none';
    // Remove required attribute when not a structure
    structureTypeSelect.removeAttribute('required');
    structureTypeSelect.value = '';
    // Clear facility tax for NPC stations (handled by backend default)
    facilityTaxInput.value = '';
  }
}

// Handle region change
async function handleRegionChange(e) {
  const regionId = e.target.value;
  const systemSelect = document.getElementById('facility-system');

  if (!regionId) {
    systemSelect.disabled = true;
    systemSelect.innerHTML = '<option value="">Select System</option>';
    document.getElementById('cost-index-section').style.display = 'none';
    return;
  }

  try {
    console.log('Loading systems for region:', regionId);

    // Filter systems from the already loaded systems array
    const regionSystems = systems.filter(s => s.regionId === parseInt(regionId));
    console.log('Filtered systems:', regionSystems.length);

    systemSelect.innerHTML = '<option value="">Select System</option>';

    regionSystems.forEach(system => {
      const option = document.createElement('option');
      option.value = system.systemId;
      option.textContent = system.systemName;
      systemSelect.appendChild(option);
    });

    systemSelect.disabled = false;
    console.log('System dropdown populated with', regionSystems.length, 'systems');
  } catch (error) {
    console.error('Error loading systems:', error);
    alert('Error loading systems for this region: ' + error.message);
  }
}

// Handle system change
async function handleSystemChange(e) {
  const systemId = e.target.value;

  if (!systemId) {
    document.getElementById('cost-index-section').style.display = 'none';
    return;
  }

  try {
    const costIndices = await window.electronAPI.facilities.getCostIndices(systemId);
    displayCostIndices(costIndices);
  } catch (error) {
    console.error('Error loading cost indices:', error);
  }
}

// Display cost indices
function displayCostIndices(indices) {
  const section = document.getElementById('cost-index-section');
  const display = document.getElementById('cost-indices-display');

  if (!indices || indices.length === 0) {
    display.innerHTML = '<p class="loading">No cost index data available for this system</p>';
    section.style.display = 'block';
    return;
  }

  // Helper function to format activity names
  function formatActivityName(activity) {
    // Remove underscores and convert to title case
    return activity
      .replace(/_/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  display.innerHTML = indices.map(index => `
    <div class="cost-index-item">
      <div class="cost-index-label">${formatActivityName(index.activity)}</div>
      <div class="cost-index-value">${(index.costIndex * 100).toFixed(2)}%</div>
    </div>
  `).join('');

  section.style.display = 'block';
}

// Handle structure type change
async function handleStructureTypeChange(e) {
  const structureTypeId = e.target.value;

  if (!structureTypeId) {
    document.getElementById('structure-bonuses-section').style.display = 'none';
    // Reset rig dropdowns to show all rigs
    populateRigsDropdowns();
    return;
  }

  try {
    const bonuses = await window.electronAPI.facilities.getStructureBonuses(structureTypeId);
    displayStructureBonuses(bonuses);

    // Filter rig dropdowns based on structure rig size
    if (bonuses.rigSize) {
      console.log('Filtering rigs for structure rig size:', bonuses.rigSize);
      populateRigsDropdowns(bonuses.rigSize);
    } else {
      // If no rig size info, show all rigs
      populateRigsDropdowns();
    }
  } catch (error) {
    console.error('Error loading structure bonuses:', error);
  }
}

// Display structure bonuses
function displayStructureBonuses(bonuses) {
  const section = document.getElementById('structure-bonuses-section');
  const display = document.getElementById('structure-bonuses-display');

  // Use bonuses from backend (which includes correct values)
  // Display as negative values to show reduction
  const meBonus = bonuses.materialEfficiency ? -bonuses.materialEfficiency : 0;
  const teBonus = bonuses.timeEfficiency ? -bonuses.timeEfficiency : 0;
  const costBonus = bonuses.costReduction ? -bonuses.costReduction : 0;

  display.innerHTML = `
    <div class="bonus-item">
      <div class="bonus-label">Material Efficiency</div>
      <div class="bonus-value">${meBonus}%</div>
    </div>
    <div class="bonus-item">
      <div class="bonus-label">Time Efficiency</div>
      <div class="bonus-value">${teBonus}%</div>
    </div>
    <div class="bonus-item">
      <div class="bonus-label">Cost Index</div>
      <div class="bonus-value">${costBonus}%</div>
    </div>
  `;

  section.style.display = 'block';
}

// Handle rig change
async function handleRigChange() {
  const rig1 = document.getElementById('rig-1').value;
  const rig2 = document.getElementById('rig-2').value;
  const rig3 = document.getElementById('rig-3').value;

  const selectedRigs = [rig1, rig2, rig3].filter(r => r);

  if (selectedRigs.length === 0) {
    document.getElementById('rig-effects-section').style.display = 'none';
    return;
  }

  try {
    const rigEffects = await Promise.all(
      selectedRigs.map(rigId => window.electronAPI.facilities.getRigEffects(rigId))
    );
    displayRigEffects(selectedRigs, rigEffects);
  } catch (error) {
    console.error('Error loading rig effects:', error);
  }
}

// Display rig effects
function displayRigEffects(rigIds, effects) {
  const section = document.getElementById('rig-effects-section');
  const display = document.getElementById('rig-effects-display');

  const rigData = rigIds.map(rigId => {
    const rig = structureRigs.find(r => r.typeId === parseInt(rigId));
    return rig || { typeName: 'Unknown Rig' };
  });

  display.innerHTML = rigData.map((rig, index) => {
    const rigEffects = effects[index] || [];

    // Filter and format the important bonuses
    const formattedEffects = rigEffects
      .filter(effect => {
        // Filter to only relevant manufacturing bonuses
        const name = effect.displayName.toLowerCase();
        return name.includes('bonus') ||
               name.includes('reduction') ||
               name.includes('multiplier');
      })
      .map(effect => {
        let label = effect.displayName;
        let value = effect.value;

        // Format the value as a percentage if it makes sense
        if (label.includes('Reduction') || label.includes('Bonus')) {
          // Negative values are reductions, positive are bonuses
          const sign = value < 0 ? '' : '+';
          value = `${sign}${value}%`;
        }

        return { label, value };
      });

    // Show a message if no effects found
    const effectsHTML = formattedEffects.length > 0
      ? formattedEffects.map(effect => `
          <span class="rig-bonus">${effect.label}: ${effect.value}</span>
        `).join('')
      : '<span class="rig-bonus">No bonus data available</span>';

    return `
      <div class="rig-effect-item">
        <div class="rig-effect-name">${rig.typeName}</div>
        <div class="rig-effect-bonuses">
          ${effectsHTML}
        </div>
      </div>
    `;
  }).join('');

  section.style.display = 'block';
}

// Handle form submit
async function handleFormSubmit(e) {
  e.preventDefault();

  const usage = document.getElementById('facility-usage').value;
  const name = document.getElementById('facility-name').value.trim();
  const facilityType = document.getElementById('facility-type').value;

  // Check if facility name already exists (exclude current facility when editing)
  const existingFacility = facilities.find(f =>
    f.name.toLowerCase() === name.toLowerCase() &&
    f.id !== editingFacilityId
  );
  if (existingFacility) {
    alert(`A facility with the name "${name}" already exists. Please choose a different name.`);
    return;
  }

  // Check if trying to add a Default facility when one already exists (exclude current facility when editing)
  if (usage === 'default') {
    const existingDefault = facilities.find(f =>
      f.usage === 'default' &&
      f.id !== editingFacilityId
    );
    if (existingDefault) {
      alert(`Only one Default facility is allowed. "${existingDefault.name}" is already set as the Default facility.`);
      return;
    }
  }

  // Validate required fields
  if (!name) {
    alert('Facility Name is required.');
    return;
  }

  const formData = {
    usage: usage,
    name: name,
    facilityType: facilityType,
    regionId: document.getElementById('facility-region').value,
    systemId: document.getElementById('facility-system').value,
  };

  // Add structure-specific data and validate
  if (formData.facilityType === 'structure') {
    const structureTypeId = document.getElementById('structure-type').value;
    if (!structureTypeId) {
      alert('Structure Type is required for Player Structures.');
      return;
    }
    formData.structureTypeId = structureTypeId;
    formData.rigs = [
      document.getElementById('rig-1').value,
      document.getElementById('rig-2').value,
      document.getElementById('rig-3').value,
    ].filter(r => r);

    // Add facility tax for player structures
    const facilityTaxInput = document.getElementById('facility-tax');
    const facilityTax = parseFloat(facilityTaxInput.value);
    if (!isNaN(facilityTax)) {
      formData.facilityTax = facilityTax;
    }
  }

  try {
    if (editingFacilityId) {
      // Update existing facility
      await window.electronAPI.facilities.updateFacility(editingFacilityId, formData);
      alert('Facility updated successfully!');
    } else {
      // Add new facility
      await window.electronAPI.facilities.addFacility(formData);
      alert('Facility added successfully!');
    }
    clearForm();
    await loadFacilities();
  } catch (error) {
    console.error('Error saving facility:', error);
    alert('Error saving facility: ' + error.message);
  }
}

// Clear form
function clearForm() {
  // Reset edit mode
  editingFacilityId = null;
  document.getElementById('form-section-title').textContent = 'Add Manufacturing Facility';
  document.getElementById('submit-btn').textContent = 'Add Facility';
  document.getElementById('cancel-btn').textContent = 'Clear Form';

  // Reset form
  document.getElementById('add-facility-form').reset();
  document.getElementById('facility-system').disabled = true;
  document.querySelectorAll('#structure-type-group, #rig1-group, #rig2-group, #rig3-group, #facility-tax-group, #facility-tax-spacer').forEach(field => {
    field.style.display = 'none';
  });
  document.querySelectorAll('.info-section').forEach(section => {
    section.style.display = 'none';
  });
}

// Load and display facilities
async function loadFacilities() {
  try {
    facilities = await window.electronAPI.facilities.getFacilities();
    displayFacilities();
  } catch (error) {
    console.error('Error loading facilities:', error);
  }
}

// Display facilities list
function displayFacilities() {
  const listContainer = document.getElementById('facilities-list');

  if (facilities.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect>
          <path d="M9 22v-4h6v4"></path>
          <path d="M8 6h.01"></path>
        </svg>
        <p>No facilities added yet</p>
        <small>Add your first manufacturing facility above</small>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = facilities.map(facility => createFacilityCard(facility)).join('');

  // Add edit and delete handlers
  facilities.forEach(facility => {
    const editBtn = document.getElementById(`edit-${facility.id}`);
    if (editBtn) {
      editBtn.addEventListener('click', () => editFacility(facility.id));
    }

    const deleteBtn = document.getElementById(`delete-${facility.id}`);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => deleteFacility(facility.id));
    }
  });
}

// Create facility card HTML
function createFacilityCard(facility) {
  const region = regions.find(r => r.regionId === parseInt(facility.regionId));
  const system = systems.find(s => s.systemId === parseInt(facility.systemId));

  // Get structure type name if available
  let structureName = '';
  if (facility.structureTypeId) {
    const structure = structureTypes.find(s => s.typeId === parseInt(facility.structureTypeId));
    structureName = structure ? structure.typeName : 'Unknown Structure';
  }

  // Get rig names if available
  let rigNames = [];
  if (facility.rigs && facility.rigs.length > 0) {
    rigNames = facility.rigs.map(rigId => {
      const rig = structureRigs.find(r => r.typeId === parseInt(rigId));
      return rig ? rig.typeName : 'Unknown Rig';
    });
  }

  // Format usage label
  const usageLabels = {
    'default': 'Default',
    'components': 'Components',
    'subsystems': 'Subsystems',
    't3-ships': 'T3 Ships',
    'capitals': 'Capitals',
    'super-capitals': 'Super Capitals',
    't2-invention': 'T2 Invention',
    't3-invention': 'T3 Invention',
    'copy': 'Copy',
    'boosters': 'Boosters',
    'reactions': 'Reactions'
  };

  return `
    <div class="facility-card">
      <div class="facility-card-header">
        <div>
          <div class="facility-name">${facility.name}</div>
          <div style="display: flex; gap: 8px; margin-top: 4px;">
            <span class="facility-type-badge ${facility.facilityType}">${facility.facilityType === 'station' ? 'NPC Station' : 'Player Structure'}</span>
            ${facility.usage ? `<span class="facility-usage-badge ${facility.usage === 'default' ? 'default' : ''}">${usageLabels[facility.usage] || facility.usage}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="facility-location">
        ${system ? system.systemName : 'Unknown System'}, ${region ? region.regionName : 'Unknown Region'}
      </div>
      ${facility.facilityType === 'structure' && structureName ? `
        <div class="facility-details">
          <div class="facility-detail-item">
            <span class="facility-detail-label">Structure Type</span>
            <span class="facility-detail-value">${structureName}</span>
          </div>
          ${rigNames.length > 0 ? `
            <div class="facility-rigs">
              <div class="facility-rigs-label">Installed Rigs:</div>
              <div class="facility-rigs-list">
                ${rigNames.map(name => `<span class="rig-badge">${name}</span>`).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      ` : ''}
      <div class="facility-actions">
        <button class="icon-button" id="edit-${facility.id}" title="Edit Facility">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="icon-button danger" id="delete-${facility.id}" title="Delete Facility">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
  `;
}

// Edit facility
async function editFacility(id) {
  const facility = facilities.find(f => f.id === id);
  if (!facility) {
    alert('Facility not found');
    return;
  }

  editingFacilityId = id;

  // Update form title and button text
  document.getElementById('form-section-title').textContent = 'Edit Manufacturing Facility';
  document.getElementById('submit-btn').textContent = 'Save Facility';
  document.getElementById('cancel-btn').textContent = 'Cancel Edit';

  // Populate form with facility data
  document.getElementById('facility-usage').value = facility.usage || '';
  document.getElementById('facility-name').value = facility.name || '';
  document.getElementById('facility-type').value = facility.facilityType || '';

  // Trigger facility type change to show/hide structure fields
  handleFacilityTypeChange({ target: document.getElementById('facility-type') });

  // Load region
  document.getElementById('facility-region').value = facility.regionId || '';

  // Load systems for the selected region
  if (facility.regionId) {
    await handleRegionChange({ target: document.getElementById('facility-region') });
    document.getElementById('facility-system').value = facility.systemId || '';

    // Load cost indices for the system
    if (facility.systemId) {
      await handleSystemChange({ target: document.getElementById('facility-system') });
    }
  }

  // If structure, populate structure-specific fields
  if (facility.facilityType === 'structure') {
    if (facility.structureTypeId) {
      document.getElementById('structure-type').value = facility.structureTypeId;
      await handleStructureTypeChange({ target: document.getElementById('structure-type') });
    }

    // Populate rigs
    if (facility.rigs && facility.rigs.length > 0) {
      facility.rigs.forEach((rigId, index) => {
        const rigSelect = document.getElementById(`rig-${index + 1}`);
        if (rigSelect) {
          rigSelect.value = rigId;
        }
      });

      // Load rig effects
      await handleRigChange();
    }

    // Populate facility tax
    if (facility.facilityTax !== undefined) {
      document.getElementById('facility-tax').value = facility.facilityTax.toFixed(2);
    }
  }

  // Scroll to form
  document.querySelector('.add-facility-section').scrollIntoView({ behavior: 'smooth' });
}

// Delete facility
async function deleteFacility(id) {
  if (!confirm('Are you sure you want to delete this facility?')) {
    return;
  }

  try {
    await window.electronAPI.facilities.removeFacility(id);
    await loadFacilities();
  } catch (error) {
    console.error('Error deleting facility:', error);
    alert('Error deleting facility');
  }
}
