// Settings window renderer script

console.log('Settings window initialized');

let currentSettings = {};

// Load settings when window opens
async function loadSettings() {
  try {
    currentSettings = await window.electronAPI.settings.load();
    console.log('Loaded settings:', currentSettings);
    populateSettings();
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Populate UI with loaded settings
function populateSettings() {
  // General settings
  const autoUpdateCharacterData = document.getElementById('auto-update-character-data');
  if (autoUpdateCharacterData) {
    autoUpdateCharacterData.checked = currentSettings.general?.autoUpdateCharacterData !== false;
  }

  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = currentSettings.general?.theme || 'dark';
  }

  const desktopNotifications = document.getElementById('desktop-notifications');
  if (desktopNotifications) {
    desktopNotifications.checked = currentSettings.general?.desktopNotifications !== false;
  }

  const updatesNotification = document.getElementById('updates-notification');
  if (updatesNotification) {
    updatesNotification.checked = currentSettings.general?.updatesNotification !== false;
  }

  // Industry settings - reactions toggle only
  const reactionsToggle = document.getElementById('reactions-as-intermediates');
  if (reactionsToggle) {
    reactionsToggle.checked = currentSettings.industry?.calculateReactionsAsIntermediates || false;
  }
}

// Save a specific setting
async function saveSetting(category, key, value) {
  try {
    const updates = { [key]: value };
    const success = await window.electronAPI.settings.update(category, updates);
    if (success) {
      console.log(`Saved ${category}.${key}:`, value);
      // Update local cache
      if (!currentSettings[category]) {
        currentSettings[category] = {};
      }
      currentSettings[category][key] = value;
    } else {
      console.error(`Failed to save ${category}.${key}`);
    }
  } catch (error) {
    console.error('Error saving setting:', error);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings first
  await loadSettings();

  // Load and display app version
  try {
    const version = await window.electronAPI.app.getVersion();
    const appVersionEl = document.getElementById('app-version');
    if (appVersionEl) {
      appVersionEl.textContent = `v${version}`;
    }

    // Also display Electron version
    const electronVersionEl = document.getElementById('electron-version');
    if (electronVersionEl) {
      const electronVersion = await window.electronAPI.app.getElectronVersion();
      electronVersionEl.textContent = electronVersion;
    }
  } catch (error) {
    console.error('Error loading version:', error);
  }

  // Tab switching functionality
  const tabItems = document.querySelectorAll('.tab-item');
  const tabContents = document.querySelectorAll('.tab-content');

  tabItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');

      // Remove active class from all tabs and contents
      tabItems.forEach(tab => tab.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));

      // Add active class to clicked tab
      item.classList.add('active');

      // Show corresponding content
      const targetContent = document.getElementById(`${targetTab}-tab`);
      if (targetContent) {
        targetContent.classList.add('active');
      }

      // Load division settings when Industry tab is activated
      if (targetTab === 'industry') {
        loadIndustryDivisions();
        loadDefaultManufacturingCharacters();
      }
    });
  });

  // Settings handlers - Auto-save on change

  // Auto-update character data
  const autoUpdateCharacterData = document.getElementById('auto-update-character-data');
  if (autoUpdateCharacterData) {
    autoUpdateCharacterData.addEventListener('change', (e) => {
      console.log('Auto-update character data:', e.target.checked);
      saveSetting('general', 'autoUpdateCharacterData', e.target.checked);
    });
  }

  // Theme selection
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => {
      console.log('Theme changed to:', e.target.value);
      saveSetting('general', 'theme', e.target.value);
    });
  }

  // Desktop notifications
  const desktopNotifications = document.getElementById('desktop-notifications');
  if (desktopNotifications) {
    desktopNotifications.addEventListener('change', (e) => {
      console.log('Desktop notifications:', e.target.checked);
      saveSetting('general', 'desktopNotifications', e.target.checked);
    });
  }

  // Updates notification
  const updatesNotification = document.getElementById('updates-notification');
  if (updatesNotification) {
    updatesNotification.addEventListener('change', (e) => {
      console.log('Updates notification:', e.target.checked);
      saveSetting('general', 'updatesNotification', e.target.checked);
    });
  }

  // Industry Settings - Reactions toggle only

  // Reactions toggle
  const reactionsToggle = document.getElementById('reactions-as-intermediates');
  if (reactionsToggle) {
    reactionsToggle.addEventListener('change', async (e) => {
      console.log('Calculate reactions as intermediates:', e.target.checked);
      await saveSetting('industry', 'calculateReactionsAsIntermediates', e.target.checked);
    });
  }

  // ESI Character Management
  loadCharacters();

  // Connect Character button
  const connectCharacterBtn = document.getElementById('connect-character-btn');
  if (connectCharacterBtn) {
    connectCharacterBtn.addEventListener('click', async () => {
      console.log('Connect Character clicked');
      connectCharacterBtn.disabled = true;
      connectCharacterBtn.textContent = 'Authenticating...';

      try {
        const result = await window.electronAPI.esi.authenticate();
        if (result.success) {
          console.log('Character connected:', result.character);
          await loadCharacters();
        } else {
          console.error('Authentication failed:', result.error);
          alert(`Authentication failed: ${result.error}`);
        }
      } catch (error) {
        console.error('Error during authentication:', error);
        alert('An error occurred during authentication. Please try again.');
      } finally {
        connectCharacterBtn.disabled = false;
        connectCharacterBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Connect Character
        `;
      }
    });
  }

  console.log('Settings handlers initialized');
});

// Load and display characters
async function loadCharacters() {
  try {
    const characters = await window.electronAPI.esi.getCharacters();
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    const defaultCharacterId = defaultCharacter ? defaultCharacter.characterId : null;

    console.log('Loaded characters:', characters);
    console.log('Default character:', defaultCharacterId);

    const charactersList = document.getElementById('characters-list');
    const emptyState = document.getElementById('empty-characters-state');

    if (!charactersList) return;

    if (characters.length === 0) {
      charactersList.innerHTML = '';
      if (emptyState) emptyState.style.display = 'flex';
    } else {
      if (emptyState) emptyState.style.display = 'none';
      charactersList.innerHTML = characters.map(char =>
        createCharacterCard(char, char.characterId === defaultCharacterId)
      ).join('');

      // Add event handlers
      characters.forEach(char => {
        const isDefault = char.characterId === defaultCharacterId;

        // Skills button handler
        const skillsBtn = document.getElementById(`skills-${char.characterId}`);
        if (skillsBtn) {
          skillsBtn.addEventListener('click', () => {
            console.log('Opening skills window for character:', char.characterId);
            window.electronAPI.skills.openWindow(char.characterId);
          });
        }

        // Blueprints button handler
        const blueprintsBtn = document.getElementById(`blueprints-${char.characterId}`);
        if (blueprintsBtn) {
          blueprintsBtn.addEventListener('click', () => {
            console.log('Opening blueprints window for character:', char.characterId);
            window.electronAPI.blueprints.openWindow(char.characterId);
          });
        }

        // Remove button handler
        const removeBtn = document.getElementById(`remove-${char.characterId}`);
        if (removeBtn) {
          removeBtn.addEventListener('click', () => {
            removeCharacter(char.characterId);
          });
        }

        // Default button handler
        const defaultBtn = document.getElementById(`default-${char.characterId}`);
        if (defaultBtn) {
          defaultBtn.addEventListener('click', () => {
            if (isDefault) {
              clearDefaultCharacter();
            } else {
              setDefaultCharacter(char.characterId);
            }
          });
        }
      });
    }
  } catch (error) {
    console.error('Error loading characters:', error);
  }
}

// Create character card HTML
function createCharacterCard(character, isDefault = false) {
  return `
    <div class="character-card ${isDefault ? 'default-character' : ''}" data-character-id="${character.characterId}">
      ${isDefault ? '<div class="default-badge">Default</div>' : ''}
      <img
        src="${character.portrait}?size=128"
        alt="${character.characterName}"
        class="character-portrait"
        onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22128%22 height=%22128%22%3E%3Crect fill=%22%232d2d44%22 width=%22128%22 height=%22128%22/%3E%3C/svg%3E'"
      />
      <div class="character-info">
        <div class="character-name">${character.characterName}</div>
        <div class="character-details">
          <span class="character-id">ID: ${character.characterId}</span>
          <span>Added: ${new Date(character.addedAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="character-actions">
        <button
          class="text-button"
          id="skills-${character.characterId}"
          title="Open Skills Manager"
        >
          Skills
        </button>
        <button
          class="text-button"
          id="blueprints-${character.characterId}"
          title="Open Blueprint Manager"
        >
          Blueprints
        </button>
        <button
          class="icon-button ${isDefault ? 'active' : ''}"
          id="default-${character.characterId}"
          title="${isDefault ? 'Clear Default Character' : 'Set as Default Character'}"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="${isDefault ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        </button>
        <button
          class="icon-button danger"
          id="remove-${character.characterId}"
          title="Remove Character"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>
    </div>
  `;
}

// Remove character
async function removeCharacter(characterId) {
  if (!confirm('Are you sure you want to remove this character?')) {
    return;
  }

  try {
    const success = await window.electronAPI.esi.removeCharacter(characterId);
    if (success) {
      console.log('Character removed:', characterId);
      await loadCharacters();
    } else {
      alert('Failed to remove character');
    }
  } catch (error) {
    console.error('Error removing character:', error);
    alert('An error occurred while removing the character');
  }
}

// Set default character
async function setDefaultCharacter(characterId) {
  try {
    const success = await window.electronAPI.esi.setDefaultCharacter(characterId);
    if (success) {
      console.log('Set default character:', characterId);
      await loadCharacters();
    } else {
      alert('Failed to set default character');
    }
  } catch (error) {
    console.error('Error setting default character:', error);
    alert('An error occurred while setting default character');
  }
}

// Clear default character
async function clearDefaultCharacter() {
  try {
    const success = await window.electronAPI.esi.clearDefaultCharacter();
    if (success) {
      console.log('Cleared default character');
      await loadCharacters();
    } else {
      alert('Failed to clear default character');
    }
  } catch (error) {
    console.error('Error clearing default character:', error);
    alert('An error occurred while clearing default character');
  }
}

// Industry Tab - Division Settings Functions

/**
 * Load all characters and render division sections on Industry tab
 */
async function loadIndustryDivisions() {
  const containerEl = document.getElementById('character-divisions-container');
  if (!containerEl) return;

  try {
    // Show loading
    containerEl.innerHTML = '<div class="divisions-loading"><div class="spinner"></div><span>Loading division settings...</span></div>';

    // Get all characters (same method as Accounts tab)
    const characters = await window.electronAPI.esi.getCharacters();

    if (characters.length === 0) {
      containerEl.innerHTML = '<p class="no-data">No characters authenticated. Go to Accounts tab to add characters.</p>';
      return;
    }

    // Render a section for each character
    containerEl.innerHTML = '';
    for (const character of characters) {
      await renderCharacterDivisionSection(character);
    }

  } catch (error) {
    console.error('Error loading industry divisions:', error);
    containerEl.innerHTML = '<p class="error-text">Failed to load division settings</p>';
  }
}

/**
 * Render a collapsible section for one character showing selected divisions in header
 */
async function renderCharacterDivisionSection(character) {
  const containerEl = document.getElementById('character-divisions-container');
  if (!containerEl) return;

  const characterId = character.characterId;

  try {
    // Fetch division settings
    const settings = await window.electronAPI.divisions.getSettings(characterId);
    const { enabledDivisions, divisionNames, hasCustomNames } = settings;

    // Build selected divisions summary for header
    let selectedSummary = 'None selected';
    if (enabledDivisions.length > 0) {
      const divisionLabels = enabledDivisions.map(divId => {
        return divisionNames[divId] || `Division ${divId}`;
      });
      selectedSummary = divisionLabels.join(', ');
    }

    // Create section HTML
    const sectionHTML = `
      <div class="character-division-section">
        <div class="character-division-header" id="division-header-${characterId}">
          <div class="character-division-header-left">
            <span class="expand-toggle" id="expand-toggle-${characterId}">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </span>
            <span class="character-name">${character.characterName}</span>
          </div>
          <div class="character-division-summary" id="division-summary-${characterId}">
            <span class="summary-label">Selected:</span>
            <span class="summary-value">${selectedSummary}</span>
          </div>
        </div>
        <div class="character-division-content" id="division-content-${characterId}" style="display: none;">
          ${!hasCustomNames ? `
            <div class="info-banner">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <span>Using generic division names. Click "Refresh Names" to fetch custom names from your corporation.</span>
            </div>
          ` : ''}
          <div class="divisions-grid" id="divisions-grid-${characterId}">
            ${renderDivisionCheckboxes(characterId, enabledDivisions, divisionNames)}
          </div>
          <div class="division-actions">
            <button class="secondary-button" id="fetch-divisions-${characterId}">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
              Refresh Division Names
            </button>
          </div>
        </div>
      </div>
    `;

    containerEl.insertAdjacentHTML('beforeend', sectionHTML);

    // Set up event listeners
    setupCharacterDivisionListeners(characterId);

    // Add click listener to header for expand/collapse
    const headerEl = document.getElementById(`division-header-${characterId}`);
    if (headerEl) {
      headerEl.addEventListener('click', () => toggleCharacterDivisions(characterId));
    }

  } catch (error) {
    console.error(`Error rendering division section for character ${characterId}:`, error);
  }
}

/**
 * Render division checkboxes HTML (returns HTML string)
 */
function renderDivisionCheckboxes(characterId, enabledDivisions, divisionNames) {
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
 * Set up checkbox and fetch button listeners for a character
 */
function setupCharacterDivisionListeners(characterId) {
  // Division checkbox listeners
  const checkboxes = document.querySelectorAll(`#divisions-grid-${characterId} .division-checkbox`);
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('change', handleDivisionToggle);
  });

  // Fetch button listener
  const fetchBtn = document.getElementById(`fetch-divisions-${characterId}`);
  if (fetchBtn) {
    fetchBtn.onclick = () => fetchCharacterDivisionNames(characterId);
  }
}

/**
 * Toggle expand/collapse of character division section
 */
function toggleCharacterDivisions(characterId) {
  const contentEl = document.getElementById(`division-content-${characterId}`);
  const toggleIcon = document.getElementById(`expand-toggle-${characterId}`);

  if (!contentEl || !toggleIcon) return;

  const isExpanded = contentEl.style.display !== 'none';

  if (isExpanded) {
    // Collapse
    contentEl.style.display = 'none';
    toggleIcon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    `;
  } else {
    // Expand
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
async function handleDivisionToggle(event) {
  const checkbox = event.target;
  const characterId = parseInt(checkbox.getAttribute('data-character'));
  const divisionId = parseInt(checkbox.getAttribute('data-division'));
  const isChecked = checkbox.checked;

  try {
    // Get current settings
    const settings = await window.electronAPI.divisions.getSettings(characterId);
    let enabledDivisions = settings.enabledDivisions || [];

    // Update array
    if (isChecked) {
      if (!enabledDivisions.includes(divisionId)) {
        enabledDivisions.push(divisionId);
      }
    } else {
      enabledDivisions = enabledDivisions.filter(id => id !== divisionId);
    }

    // Sort for consistency
    enabledDivisions.sort((a, b) => a - b);

    // Save to database
    const success = await window.electronAPI.divisions.updateEnabled(characterId, enabledDivisions);

    if (!success) {
      console.error('Failed to update division settings');
      // Revert checkbox
      checkbox.checked = !isChecked;
      alert('Failed to update division settings. Please try again.');
    } else {
      console.log(`Updated divisions for character ${characterId}:`, enabledDivisions);
      // Update header summary
      await updateCharacterDivisionHeader(characterId);
    }

  } catch (error) {
    console.error('Error toggling division:', error);
    // Revert checkbox
    checkbox.checked = !isChecked;
    alert('An error occurred while updating division settings.');
  }
}

/**
 * Update the header summary after division selection changes
 */
async function updateCharacterDivisionHeader(characterId) {
  const summaryEl = document.getElementById(`division-summary-${characterId}`);
  if (!summaryEl) return;

  try {
    const settings = await window.electronAPI.divisions.getSettings(characterId);
    const { enabledDivisions, divisionNames } = settings;

    let selectedSummary = 'None selected';
    if (enabledDivisions.length > 0) {
      const divisionLabels = enabledDivisions.map(divId => {
        return divisionNames[divId] || `Division ${divId}`;
      });
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
 * Fetch custom division names from ESI
 */
async function fetchCharacterDivisionNames(characterId) {
  const fetchBtn = document.getElementById(`fetch-divisions-${characterId}`);
  const originalHTML = fetchBtn.innerHTML;

  try {
    // Disable button and show loading
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = `
      <div class="spinner small"></div>
      Fetching...
    `;

    // Fetch from ESI
    const result = await window.electronAPI.divisions.fetchNames(characterId);

    if (!result.success) {
      if (!result.hasScope) {
        alert('Your character does not have the "esi-corporations.read_divisions.v1" scope. Please re-authenticate to fetch custom division names.');
      } else {
        alert(`Failed to fetch division names: ${result.error || 'Unknown error'}`);
      }
      return;
    }

    // Reload all division sections to show new names
    await loadIndustryDivisions();

    // Show success message
    const divCount = Object.keys(result.divisions).length;
    if (divCount > 0) {
      alert(`Successfully fetched ${divCount} custom division name(s)!`);
    } else {
      alert('No custom division names found. Using generic names.');
    }

  } catch (error) {
    console.error('Error fetching division names:', error);
    alert('An error occurred while fetching division names. Please try again.');
  } finally {
    // Re-enable button
    fetchBtn.disabled = false;
    fetchBtn.innerHTML = originalHTML;
  }
}

// Default Manufacturing Characters Functions

/**
 * Load and render default manufacturing characters checkboxes
 */
async function loadDefaultManufacturingCharacters() {
  const containerEl = document.getElementById('default-manufacturing-characters-container');
  if (!containerEl) return;

  try {
    // Show loading
    containerEl.innerHTML = '<div class="divisions-loading"><div class="spinner"></div><span>Loading characters...</span></div>';

    // Get all characters
    const characters = await window.electronAPI.esi.getCharacters();

    if (characters.length === 0) {
      containerEl.innerHTML = '<p class="no-data">No characters authenticated. Go to Accounts tab to add characters.</p>';
      return;
    }

    // Get current default manufacturing characters
    const defaultCharacterIds = await window.electronAPI.industry.getDefaultManufacturingCharacters();

    // Render checkboxes
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

    // Add event listeners to checkboxes
    const checkboxes = containerEl.querySelectorAll('.character-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', handleDefaultManufacturingCharacterToggle);
    });

  } catch (error) {
    console.error('Error loading default manufacturing characters:', error);
    containerEl.innerHTML = '<p class="error-text">Failed to load characters</p>';
  }
}

/**
 * Handle default manufacturing character checkbox toggle
 */
async function handleDefaultManufacturingCharacterToggle(event) {
  const checkbox = event.target;
  const characterId = parseInt(checkbox.getAttribute('data-character-id'));
  const isChecked = checkbox.checked;

  try {
    // Get current defaults
    const currentDefaults = await window.electronAPI.industry.getDefaultManufacturingCharacters();

    // Update array
    let updatedDefaults;
    if (isChecked) {
      // Add character if not already in array
      if (!currentDefaults.includes(characterId)) {
        updatedDefaults = [...currentDefaults, characterId];
      } else {
        updatedDefaults = currentDefaults;
      }
    } else {
      // Remove character from array
      updatedDefaults = currentDefaults.filter(id => id !== characterId);
    }

    // Save to settings
    const success = await window.electronAPI.industry.setDefaultManufacturingCharacters(updatedDefaults);

    if (!success) {
      console.error('Failed to update default manufacturing characters');
      // Revert checkbox
      checkbox.checked = !isChecked;
      alert('Failed to update default manufacturing characters. Please try again.');
    } else {
      console.log('Updated default manufacturing characters:', updatedDefaults);
    }

  } catch (error) {
    console.error('Error toggling default manufacturing character:', error);
    // Revert checkbox
    checkbox.checked = !isChecked;
    alert('An error occurred while updating default manufacturing characters.');
  }
}

// SDE Management
let sdeUpdateStatus = null;

// Load SDE status on page load
async function loadSdeStatus() {
  try {
    const status = await window.electronAPI.sde.checkUpdate();
    sdeUpdateStatus = status;

    // Load validation status from settings
    const settings = await window.electronAPI.settings.load();
    const validationStatus = settings.sde?.validationStatus;

    // Check if backup exists
    const hasBackup = await window.electronAPI.sde.hasBackup();
    const backupVersion = hasBackup ? await window.electronAPI.sde.getBackupVersion() : null;

    updateSdeUI(status, validationStatus, hasBackup, backupVersion);
  } catch (error) {
    console.error('Error loading SDE status:', error);
    updateSdeUI({ error: error.message }, null, false, null);
  }
}

// Update SDE UI elements
function updateSdeUI(status, validationStatus, hasBackup, backupVersion) {
  const sourceEl = document.getElementById('sde-source');
  const currentVersionEl = document.getElementById('sde-current-version');
  const latestVersionEl = document.getElementById('sde-latest-version');
  const minimumVersionEl = document.getElementById('sde-minimum-version');
  const statusEl = document.getElementById('sde-status');
  const updateBtn = document.getElementById('sde-update-btn');
  const validationIndicator = document.getElementById('validation-indicator');
  const validationText = document.getElementById('validation-text');
  const backupStatusEl = document.getElementById('sde-backup-status');
  const restoreBtn = document.getElementById('sde-restore-btn');

  if (status.error) {
    if (sourceEl) sourceEl.textContent = 'Unknown';
    if (currentVersionEl) currentVersionEl.textContent = 'Error';
    if (latestVersionEl) latestVersionEl.textContent = 'Error';
    if (statusEl) {
      statusEl.textContent = 'Check Failed';
      statusEl.className = 'sde-value critical';
    }
    if (updateBtn) updateBtn.disabled = true;
    return;
  }

  // SDE Source
  if (sourceEl) {
    const source = status.source || 'github';
    if (source === 'github') {
      const sourceUrl = 'https://github.com/noirsoldats/eve-sde-converter';
      sourceEl.innerHTML = `<a href="#" class="external-link" data-url="${sourceUrl}" style="color: #00d4ff; text-decoration: none;">GitHub (eve-sde-converter)</a>`;

      // Add click handler to open in external browser
      const link = sourceEl.querySelector('.external-link');
      if (link) {
        link.addEventListener('click', async (e) => {
          e.preventDefault();
          const url = e.target.getAttribute('data-url');
          try {
            await window.electronAPI.shell.openExternal(url);
          } catch (error) {
            console.error('Error opening external link:', error);
          }
        });
      }
    } else if (source === 'fuzzwork') {
      sourceEl.textContent = 'Fuzzwork (Legacy)';
    } else {
      sourceEl.textContent = 'Local';
    }
  }

  // Current version
  if (currentVersionEl) {
    currentVersionEl.textContent = status.currentVersion || 'Not Installed';
    if (!status.currentVersion) {
      currentVersionEl.className = 'sde-value critical';
    }
  }

  // Latest version
  if (latestVersionEl) {
    latestVersionEl.textContent = status.latestVersion || 'Unknown';
  }

  // Minimum version
  if (minimumVersionEl) {
    minimumVersionEl.textContent = status.minimumVersion || 'Unknown';
  }

  // Status
  if (statusEl) {
    if (status.isCritical) {
      statusEl.textContent = 'Critical Update Required';
      statusEl.className = 'sde-value critical';
    } else if (status.needsUpdate) {
      statusEl.textContent = 'Update Available';
      statusEl.className = 'sde-value outdated';
    } else {
      statusEl.textContent = 'Up to Date';
      statusEl.className = 'sde-value up-to-date';
    }
  }

  // Update button
  if (updateBtn) {
    updateBtn.disabled = !status.needsUpdate && !status.isCritical;
  }

  // Validation status indicator
  if (validationIndicator && validationText) {
    if (validationStatus && validationStatus.passed) {
      validationIndicator.className = 'validation-indicator passed';
      validationIndicator.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <span id="validation-text">Passed</span>
      `;
    } else if (validationStatus && !validationStatus.passed) {
      validationIndicator.className = 'validation-indicator failed';
      validationIndicator.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        <span id="validation-text">Failed</span>
      `;
    } else {
      validationIndicator.className = 'validation-indicator unknown';
      validationIndicator.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="16" x2="12" y2="12"></line>
          <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
        <span id="validation-text">Unknown</span>
      `;
    }

    // Make validation indicator clickable to show details
    if (validationStatus) {
      validationIndicator.style.cursor = 'pointer';
      validationIndicator.onclick = () => {
        showValidationResults({
          ...validationStatus,
          details: [], // We don't store full details in settings
        });
      };
    }
  }

  // Backup status
  if (backupStatusEl) {
    if (hasBackup) {
      backupStatusEl.textContent = backupVersion ? `Yes (v${backupVersion})` : 'Yes';
      backupStatusEl.className = 'sde-value up-to-date';
    } else {
      backupStatusEl.textContent = 'No';
      backupStatusEl.className = 'sde-value';
    }
  }

  // Restore button
  if (restoreBtn) {
    restoreBtn.disabled = !hasBackup;
  }
}

// Check for SDE updates
async function checkSdeUpdate() {
  const checkBtn = document.getElementById('sde-check-btn');
  if (checkBtn) {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking...';
  }

  try {
    await loadSdeStatus();
  } finally {
    if (checkBtn) {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check for Updates';
    }
  }
}

// Download SDE
async function downloadSde() {
  const updateBtn = document.getElementById('sde-update-btn');
  const progressContainer = document.getElementById('sde-progress');
  const progressBar = document.getElementById('sde-progress-bar');
  const progressText = document.getElementById('sde-progress-text');

  if (updateBtn) updateBtn.disabled = true;
  if (progressContainer) progressContainer.style.display = 'flex';

  // Listen for progress updates
  window.electronAPI.sde.onProgress((progress) => {
    if (progressBar && progressText) {
      progressBar.style.width = `${progress.percent || 0}%`;

      if (progress.message) {
        progressText.textContent = progress.message;
      } else if (progress.stage === 'downloading') {
        progressText.textContent = `Downloading: ${progress.downloadedMB} MB / ${progress.totalMB} MB (${progress.percent}%)`;
      } else if (progress.stage === 'decompressing') {
        progressText.textContent = 'Decompressing database...';
      } else if (progress.stage === 'validating') {
        progressText.textContent = 'Validating database...';
      } else if (progress.stage === 'backing up') {
        progressText.textContent = 'Backing up current SDE...';
      } else if (progress.stage === 'installing') {
        progressText.textContent = 'Installing new SDE...';
      } else if (progress.stage === 'complete') {
        progressText.textContent = 'Complete!';
      }
    }
  });

  try {
    // Use downloadAndValidate instead of download
    const result = await window.electronAPI.sde.downloadAndValidate();

    if (result.success) {
      console.log('SDE download and validation successful');

      // Show validation results
      if (result.validationResults) {
        showValidationResults(result.validationResults);
      }

      await loadSdeStatus();

      setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';
      }, 2000);
    } else {
      // Show validation failure if available
      if (result.validationResults && !result.validationResults.passed) {
        showValidationResults(result.validationResults);
      } else {
        throw new Error(result.error || 'Download failed');
      }

      if (progressContainer) progressContainer.style.display = 'none';
      if (progressBar) progressBar.style.width = '0%';
    }
  } catch (error) {
    console.error('Error downloading SDE:', error);
    alert(`Failed to download SDE: ${error.message}`);

    if (progressContainer) progressContainer.style.display = 'none';
    if (progressBar) progressBar.style.width = '0%';
  } finally {
    window.electronAPI.sde.removeProgressListener();
    if (updateBtn) updateBtn.disabled = false;
  }
}

// Validate current SDE
async function validateCurrentSde() {
  const validateBtn = document.getElementById('sde-validate-btn');

  if (validateBtn) {
    validateBtn.disabled = true;
    const originalText = validateBtn.textContent;
    validateBtn.textContent = 'Validating...';

    try {
      const result = await window.electronAPI.sde.validateCurrent();

      // Show validation results
      showValidationResults(result);

      // Reload SDE status to update validation indicator
      await loadSdeStatus();
    } catch (error) {
      console.error('Validation error:', error);
      alert(`Validation failed: ${error.message}`);
    } finally {
      validateBtn.disabled = false;
      validateBtn.textContent = originalText;
    }
  }
}

// Restore backup SDE
async function restoreBackupSde() {
  const restoreBtn = document.getElementById('sde-restore-btn');

  // Confirm with user
  const confirmed = confirm('Are you sure you want to restore the previous SDE version? This will replace your current SDE database.');

  if (!confirmed) {
    return;
  }

  if (restoreBtn) {
    restoreBtn.disabled = true;
    const originalText = restoreBtn.textContent;
    restoreBtn.textContent = 'Restoring...';

    try {
      const result = await window.electronAPI.sde.restoreBackup();

      if (result.success) {
        alert('SDE successfully restored from backup.');

        // Reload SDE status
        await loadSdeStatus();
      } else {
        alert(`Failed to restore backup: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Restore error:', error);
      alert(`Restore failed: ${error.message}`);
    } finally {
      restoreBtn.disabled = false;
      restoreBtn.textContent = originalText;
    }
  }
}

// Show validation results in modal
function showValidationResults(results) {
  const modal = document.getElementById('validation-modal');
  const summary = document.getElementById('validation-summary');
  const details = document.getElementById('validation-details');

  if (!modal || !summary || !details) return;

  // Build summary
  const summaryClass = results.passed ? 'validation-passed' : 'validation-failed';
  summary.innerHTML = `
    <div class="${summaryClass}">
      <div class="validation-icon">
        ${results.passed
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
        }
      </div>
      <h3>${results.passed ? 'Validation Passed' : 'Validation Failed'}</h3>
      <p>${results.summary}</p>
      ${results.executionTime ? `<small>Completed in ${results.executionTime}ms</small>` : ''}
    </div>
  `;

  // Build details
  if (results.details && results.details.length > 0) {
    details.innerHTML = `
      <h4>Detailed Results (${results.passedChecks || 0}/${results.totalChecks || 0} checks passed)</h4>
      <div class="validation-checks">
        ${results.details.map(detail => `
          <div class="validation-check ${detail.passed ? 'passed' : 'failed'}">
            ${detail.passed
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>'
              : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
            }
            <span>${detail.check}</span>
          </div>
        `).join('')}
      </div>
    `;
  } else if (results.failedChecks && results.failedChecks.length > 0) {
    // Show failed checks if details not available
    details.innerHTML = `
      <h4>Failed Checks</h4>
      <div class="validation-checks">
        ${results.failedChecks.map(failed => `
          <div class="validation-check failed">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            <span>${failed.check}: ${failed.error}</span>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    details.innerHTML = '';
  }

  // Show modal
  modal.style.display = 'flex';
}

// Initialize SDE controls
function initializeSdeControls() {
  loadSdeStatus();

  const updateBtn = document.getElementById('sde-update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', downloadSde);
  }

  const checkBtn = document.getElementById('sde-check-btn');
  if (checkBtn) {
    checkBtn.addEventListener('click', checkSdeUpdate);
  }

  const validateBtn = document.getElementById('sde-validate-btn');
  if (validateBtn) {
    validateBtn.addEventListener('click', validateCurrentSde);
  }

  const restoreBtn = document.getElementById('sde-restore-btn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', restoreBackupSde);
  }

  // Modal close handlers
  const modalCloseBtn = document.getElementById('validation-modal-close');
  const modalOkBtn = document.getElementById('validation-modal-ok');
  const modal = document.getElementById('validation-modal');

  if (modalCloseBtn && modal) {
    modalCloseBtn.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  if (modalOkBtn && modal) {
    modalOkBtn.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  // Close modal on outside click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  }
}

// Cost Indices Management
async function loadCostIndicesStatus() {
  try {
    const systemCount = await window.electronAPI.costIndices.getSystemCount();
    const lastFetch = await window.electronAPI.costIndices.getLastFetchTime();

    const countEl = document.getElementById('cost-indices-count');
    const lastFetchEl = document.getElementById('cost-indices-last-fetch');

    if (countEl) {
      countEl.textContent = systemCount > 0 ? systemCount.toLocaleString() : 'Not yet fetched';
      countEl.className = systemCount > 0 ? 'sde-value up-to-date' : 'sde-value critical';
    }

    if (lastFetchEl) {
      if (lastFetch) {
        const date = new Date(lastFetch);
        lastFetchEl.textContent = date.toLocaleString();

        // Check if data is stale (over 1 hour old)
        const now = Date.now();
        const ageInHours = (now - lastFetch) / (60 * 60 * 1000);
        if (ageInHours > 1) {
          lastFetchEl.className = 'sde-value outdated';
        } else {
          lastFetchEl.className = 'sde-value up-to-date';
        }
      } else {
        lastFetchEl.textContent = 'Never';
        lastFetchEl.className = 'sde-value critical';
      }
    }
  } catch (error) {
    console.error('Error loading cost indices status:', error);
  }
}

async function updateCostIndices() {
  const updateBtn = document.getElementById('cost-indices-update-btn');
  if (!updateBtn) return;

  updateBtn.disabled = true;
  updateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
    </svg>
    Updating...
  `;

  try {
    const result = await window.electronAPI.costIndices.fetch();

    if (result.success) {
      // Show success state
      updateBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Updated!
      `;

      // Reload status
      await loadCostIndicesStatus();

      // Show success message
      setTimeout(() => {
        alert(`Successfully updated cost indices for ${result.systemCount.toLocaleString()} solar systems!`);
      }, 100);

      // Reset button after 2 seconds
      setTimeout(() => {
        updateBtn.disabled = false;
        updateBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 2v6h-6"></path>
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
            <path d="M3 22v-6h6"></path>
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
          </svg>
          Update Cost Indices
        `;
      }, 2000);
    } else {
      // Show error
      alert(`Failed to update cost indices: ${result.error}`);

      updateBtn.disabled = false;
      updateBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 2v6h-6"></path>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
          <path d="M3 22v-6h6"></path>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
        </svg>
        Update Cost Indices
      `;
    }
  } catch (error) {
    console.error('Error updating cost indices:', error);
    alert(`Error updating cost indices: ${error.message}`);

    updateBtn.disabled = false;
    updateBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 2v6h-6"></path>
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
        <path d="M3 22v-6h6"></path>
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
      </svg>
      Update Cost Indices
    `;
  }
}

function initializeCostIndicesControls() {
  loadCostIndicesStatus();

  const updateBtn = document.getElementById('cost-indices-update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', updateCostIndices);
  }
}

// Call this when settings window loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeSdeControls();
    initializeCostIndicesControls();
  });
} else {
  initializeSdeControls();
  initializeCostIndicesControls();
}
