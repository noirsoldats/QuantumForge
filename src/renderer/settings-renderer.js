// Settings window renderer script

console.log('Settings window initialized');


let currentSettings = {};

/**
 * Toast helper.
 *
 * This file still uses alert() in many places (a pre-existing issue tracked in
 * the UI overhaul plan). New code uses the shared toast instead: under the
 * application shell an alert() is modal and freezes the whole window.
 */
function showToast(message, type = 'info') {
  if (window.QFToast) {
    window.QFToast.show(message, type);
  } else {
    console[type === 'error' ? 'error' : 'log']('[settings]', message);
  }
}


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
  // General settings - auto-update character data (handle both old boolean and new object format)
  const autoUpdateSetting = currentSettings.general?.autoUpdateCharacterData;
  const autoUpdateSkills = document.getElementById('auto-update-skills');
  const autoUpdateBlueprints = document.getElementById('auto-update-blueprints');
  const autoUpdateAssets = document.getElementById('auto-update-assets');

  if (typeof autoUpdateSetting === 'boolean') {
    // Legacy boolean - apply to all checkboxes
    if (autoUpdateSkills) autoUpdateSkills.checked = autoUpdateSetting;
    if (autoUpdateBlueprints) autoUpdateBlueprints.checked = autoUpdateSetting;
    if (autoUpdateAssets) autoUpdateAssets.checked = autoUpdateSetting;
  } else if (typeof autoUpdateSetting === 'object' && autoUpdateSetting !== null) {
    // New object format
    if (autoUpdateSkills) autoUpdateSkills.checked = autoUpdateSetting.skills !== false;
    if (autoUpdateBlueprints) autoUpdateBlueprints.checked = autoUpdateSetting.blueprints !== false;
    if (autoUpdateAssets) autoUpdateAssets.checked = autoUpdateSetting.assets !== false;
  } else {
    // Default to all enabled
    if (autoUpdateSkills) autoUpdateSkills.checked = true;
    if (autoUpdateBlueprints) autoUpdateBlueprints.checked = true;
    if (autoUpdateAssets) autoUpdateAssets.checked = true;
  }

  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = currentSettings.general?.theme || 'dark';
  }

  const desktopNotifications = document.getElementById('desktop-notifications');
  if (desktopNotifications && !desktopNotifications.disabled) {
    desktopNotifications.checked = currentSettings.general?.desktopNotifications !== false;
  }

  const updatesNotification = document.getElementById('updates-notification');
  if (updatesNotification) {
    updatesNotification.checked = currentSettings.general?.updatesNotification !== false;
  }

  const auditModeEnabled = document.getElementById('audit-mode-enabled');
  if (auditModeEnabled) {
    auditModeEnabled.checked = currentSettings.general?.auditModeEnabled === true;
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

/**
 * Main init for the Settings screen.
 *
 * Extracted from a DOMContentLoaded handler so the shell can mount Settings as
 * a native view into a live document, where that event has long since fired.
 * Called by initSettingsView() below.
 */
async function initSettingsMain() {
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

  // Auto-update character data - individual checkboxes
  const autoUpdateSkills = document.getElementById('auto-update-skills');
  const autoUpdateBlueprints = document.getElementById('auto-update-blueprints');
  const autoUpdateAssets = document.getElementById('auto-update-assets');

  async function saveAutoUpdateSettings() {
    const value = {
      skills: autoUpdateSkills?.checked !== false,
      blueprints: autoUpdateBlueprints?.checked !== false,
      assets: autoUpdateAssets?.checked !== false
    };
    await saveSetting('general', 'autoUpdateCharacterData', value);
    console.log('Auto-update settings saved:', value);
  }

  if (autoUpdateSkills) {
    autoUpdateSkills.addEventListener('change', saveAutoUpdateSettings);
  }
  if (autoUpdateBlueprints) {
    autoUpdateBlueprints.addEventListener('change', saveAutoUpdateSettings);
  }
  if (autoUpdateAssets) {
    autoUpdateAssets.addEventListener('change', saveAutoUpdateSettings);
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

  // Audit Mode
  const auditModeEnabled = document.getElementById('audit-mode-enabled');
  if (auditModeEnabled) {
    auditModeEnabled.addEventListener('change', (e) => {
      console.log('Audit Mode:', e.target.checked);
      saveSetting('general', 'auditModeEnabled', e.target.checked);
    });
  }

  // Open Audit Log window
  const openAuditLog = document.getElementById('open-audit-log');
  if (openAuditLog) {
    openAuditLog.addEventListener('click', () => {
      window.electronAPI.audit.openWindow();
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
      // withButtonBusy restores the label it captured, so the icon in the
      // markup stays intact rather than being re-emitted from JS.
      await QFUI.withButtonBusy(connectCharacterBtn, 'Authenticating…', async () => {
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
        }
      });
    });
  }

  console.log('Settings handlers initialized');
}

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

      // Corporation names are not stored locally. One deduped, session-cached
      // call covers every character; failure falls back to the bare ID.
      let corpNames = {};
      try {
        corpNames = await window.electronAPI.esi.resolveCorporationNames(
          characters.map(c => c.corporationId)
        ) || {};
      } catch (error) {
        console.error('Error resolving corporation names:', error);
      }

      charactersList.innerHTML = characters.map(char =>
        createCharacterCard(char, char.characterId === defaultCharacterId, corpNames)
      ).join('');

      QFUI.attachPortraitFallbacks(charactersList);

      // Add event handlers
      characters.forEach(char => {
        const isDefault = char.characterId === defaultCharacterId;

        // Assets button handler
        const assetsBtn = document.getElementById(`assets-${char.characterId}`);
        if (assetsBtn) {
          assetsBtn.addEventListener('click', () => {
            window.electronAPI.window.openView('assets', { characterId: char.characterId });
          });
        }

        // Skills button handler
        const skillsBtn = document.getElementById(`skills-${char.characterId}`);
        if (skillsBtn) {
          skillsBtn.addEventListener('click', () => {
            console.log('Opening skills window for character:', char.characterId);
            window.electronAPI.window.openView('skills', { characterId: char.characterId });
          });
        }

        // Blueprints button handler
        const blueprintsBtn = document.getElementById(`blueprints-${char.characterId}`);
        if (blueprintsBtn) {
          blueprintsBtn.addEventListener('click', () => {
            console.log('Opening blueprints window for character:', char.characterId);
            window.electronAPI.window.openView('blueprints', { characterId: char.characterId });
          });
        }

        // Remove button handler
        const removeBtn = document.getElementById(`remove-${char.characterId}`);
        if (removeBtn) {
          removeBtn.addEventListener('click', () => {
            removeCharacter(char.characterId);
          });
        }

        // Default button handler.
        //
        // Clicking the CURRENT default is a no-op: "characters exist but none
        // is default" is not a supported state (every tool that resolves
        // skills, blueprints or pricing would need its own fallback), so the
        // way to change it is to make a different character default.
        const defaultBtn = document.getElementById(`default-${char.characterId}`);
        if (defaultBtn && !isDefault) {
          defaultBtn.addEventListener('click', () => {
            setDefaultCharacter(char.characterId);
          });
        }
      });
    }
  } catch (error) {
    console.error('Error loading characters:', error);
  }
}

/**
 * Describe a character's authorisation state for the card's status line.
 * Returns a label plus a semantic colour token.
 *
 * Deliberately says nothing about `expiresAt`. That timestamp belongs to the
 * ACCESS token, which ESI issues with a ~20 minute life and which esi-fetch
 * renews automatically from the refresh token before every call - so a short
 * or already-elapsed access token is the normal steady state, not a condition
 * the user can act on. Surfacing it as a countdown read as an impending
 * problem when nothing was wrong. The refresh token itself carries no
 * expiration (we persist only the token, never an expiry for it), so there is
 * no meaningful deadline to show in its place.
 *
 * @param {Object} character
 * @returns {{ text: string, tone: 'success'|'warning'|'error' }}
 */
function getCharacterAuthStatus(character) {
  const scopeCount = Array.isArray(character.scopes) ? character.scopes.length : 0;
  return {
    text: scopeCount ? `Authorized - ${scopeCount} scopes` : 'Authorized',
    tone: 'success',
  };
}

// Create character card HTML
function createCharacterCard(character, isDefault = false, corpNames = {}) {
  const status = getCharacterAuthStatus(character);
  // Resolved name when ESI could supply one; the bare ID otherwise, so a
  // rate-limited or deleted corporation still identifies the character.
  const corpLine = corpNames[character.corporationId]
    || (character.corporationId
      ? `Corporation ${character.corporationId}`
      : 'Corporation unknown');

  return `
    <div class="character-card ${isDefault ? 'default-character' : ''}" data-character-id="${character.characterId}">
      <div class="character-portrait-wrap">
        <img
          src="${character.portrait}?size=128"
          alt="${character.characterName}"
          class="character-portrait"
          data-fallback="portrait"
        />
        ${isDefault ? `
        <span class="character-default-star" title="Default character">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
            <path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z"></path>
          </svg>
        </span>` : ''}
      </div>
      <div class="character-info">
        <div class="character-name-row">
          <span class="character-name">${character.characterName}</span>
          ${isDefault ? '<span class="default-badge">Default</span>' : ''}
        </div>
        <div class="character-corp">${corpLine}</div>
        <div class="character-status character-status-${status.tone}">
          <span class="character-status-dot"></span>${status.text}
        </div>
      </div>
      <div class="character-actions">
        <button
          class="text-button"
          id="assets-${character.characterId}"
          title="Open Assets Manager"
        >
          Assets
        </button>
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
          class="text-button text-button-accent ${isDefault ? 'active' : ''}"
          id="default-${character.characterId}"
          title="${isDefault ? 'This is the default character' : 'Set as Default Character'}"
          ${isDefault ? 'disabled' : ''}
        >
          ${isDefault ? 'Default' : 'Set Default'}
        </button>
        <button
          class="text-button text-button-danger"
          id="remove-${character.characterId}"
          title="Remove Character"
        >
          Remove
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

    // Blueprint DIVISIONS are a separate axis stored alongside the asset ones.
    // The per-character "use blueprints from" toggle lives in Default
    // Manufacturing Characters, beside its asset counterpart - not here.
    const blueprintSettings = await window.electronAPI.divisions.getBlueprintSettings(characterId);
    const blueprintDivisions = blueprintSettings.enabledDivisions || [];

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
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 15 12 9 6 15"></polyline>
              </svg>
            </span>
            <img
              src="${character.portrait}?size=64"
              alt=""
              class="division-character-portrait"
              data-fallback="portrait"
            />
            <span class="character-name">${character.characterName}</span>
          </div>
          <div class="character-division-summary" id="division-summary-${characterId}">
            <span class="summary-label">Selected:</span>
            <span class="summary-value">${selectedSummary}</span>
          </div>
        </div>
        <!-- Expanded by default, matching the mockup. toggleCharacterDivisions
             reads this inline style, so it must stay inline. -->
        <div class="character-division-content" id="division-content-${characterId}" style="display: block;">
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
            ${renderDivisionCheckboxes(characterId, enabledDivisions, divisionNames, blueprintDivisions)}
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
    QFUI.attachPortraitFallbacks(containerEl);

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
function renderDivisionCheckboxes(
  characterId,
  enabledDivisions,
  divisionNames,
  blueprintDivisions = []
) {
  // Two INDEPENDENT axes per division: assets and blueprints. A corp may keep
  // BPOs in a library division while materials live in a production division,
  // so enabling one must never imply the other.
  let html = `
    <div class="division-item division-item-head">
      <span class="division-name"></span>
      <span class="division-axis-label" title="Use this division's assets">Assets</span>
      <span class="division-axis-label" title="Use this division's blueprints">Blueprints</span>
    </div>
  `;

  for (let divId = 1; divId <= 7; divId++) {
    const assetsChecked = enabledDivisions.includes(divId);
    const blueprintsChecked = blueprintDivisions.includes(divId);
    const divName = divisionNames[divId] || `Division ${divId}`;

    html += `
      <div class="division-item">
        <span class="division-name">
          ${divName}
          ${divisionNames[divId] ? '<span class="custom-name-badge">Custom</span>' : ''}
        </span>
        <label class="division-axis" title="Use ${divName} assets">
          <input
            type="checkbox"
            class="division-checkbox"
            data-character="${characterId}"
            data-division="${divId}"
            ${assetsChecked ? 'checked' : ''}
          />
        </label>
        <label class="division-axis" title="Use ${divName} blueprints">
          <input
            type="checkbox"
            class="division-blueprint-checkbox"
            data-character="${characterId}"
            data-division="${divId}"
            ${blueprintsChecked ? 'checked' : ''}
          />
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
  // Division checkbox listeners - ASSET axis
  const checkboxes = document.querySelectorAll(`#divisions-grid-${characterId} .division-checkbox`);
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('change', handleDivisionToggle);
  });

  // Division checkbox listeners - BLUEPRINT axis (independent of the above)
  const blueprintCheckboxes = document.querySelectorAll(
    `#divisions-grid-${characterId} .division-blueprint-checkbox`
  );
  blueprintCheckboxes.forEach(checkbox => {
    checkbox.addEventListener('change', handleBlueprintDivisionToggle);
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
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    `;
  } else {
    // Expand
    contentEl.style.display = 'block';
    toggleIcon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
 * Toggle a corp division as a BLUEPRINT source.
 *
 * Deliberately separate from handleDivisionToggle: the two axes are
 * independent, so this must never touch the asset divisions.
 */
async function handleBlueprintDivisionToggle(event) {
  const checkbox = event.target;
  const characterId = parseInt(checkbox.getAttribute('data-character'), 10);
  const divisionId = parseInt(checkbox.getAttribute('data-division'), 10);
  const isChecked = checkbox.checked;

  try {
    const settings = await window.electronAPI.divisions.getBlueprintSettings(characterId);
    let divisions = settings.enabledDivisions || [];

    if (isChecked) {
      if (!divisions.includes(divisionId)) divisions.push(divisionId);
    } else {
      divisions = divisions.filter(id => id !== divisionId);
    }
    divisions.sort((a, b) => a - b);

    const success = await window.electronAPI.divisions.updateBlueprintDivisions(
      characterId,
      divisions
    );

    if (!success) {
      // Revert so the checkbox never shows a state that was not saved.
      checkbox.checked = !isChecked;
      showToast('Failed to update blueprint divisions.', 'error');
      return;
    }
    console.log(`Updated blueprint divisions for character ${characterId}:`, divisions);
  } catch (error) {
    console.error('Error toggling blueprint division:', error);
    checkbox.checked = !isChecked;
    showToast('An error occurred while updating blueprint divisions.', 'error');
  }
}

/**
 * Toggle whether a character's PERSONAL blueprints are used at all.
 *
 * Corp divisions are gated separately - turning this off does not clear them,
 * so re-enabling the character restores their previous division selection.
 */
async function handleUseBlueprintsFromToggle(event) {
  const checkbox = event.target;
  const characterId = parseInt(checkbox.getAttribute('data-character'), 10);
  const isChecked = checkbox.checked;

  try {
    const success = await window.electronAPI.divisions.setUseBlueprintsFrom(
      characterId,
      isChecked
    );

    if (!success) {
      checkbox.checked = !isChecked;
      showToast('Failed to update blueprint source.', 'error');
      return;
    }
    console.log(`Character ${characterId} blueprint source: ${isChecked ? 'on' : 'off'}`);
  } catch (error) {
    console.error('Error toggling blueprint source:', error);
    checkbox.checked = !isChecked;
    showToast('An error occurred while updating the blueprint source.', 'error');
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
    // Disable button and show loading. This one restores the whole innerHTML
    // rather than using withButtonBusy, because the button's content is
    // rebuilt wholesale; the spinner is the shared one either way.
    fetchBtn.disabled = true;
    fetchBtn.classList.add('is-busy');
    fetchBtn.innerHTML = `
      <span class="qf-spinner qf-spinner-sm" aria-hidden="true"></span>
      Fetching…
    `;

    // Fetch from ESI
    const result = await window.electronAPI.divisions.fetchNames(characterId);

    if (!result.success) {
      if (!result.hasScope) {
        const charInfo = await window.electronAPI.esi.checkMissingScopes(characterId);
        window.electronAPI.esi.openAuthErrorWindow({
          type: 'missing_scopes',
          characterId,
          characterName: charInfo.characterName || `Character ${characterId}`,
          missingScopes: ['esi-corporations.read_divisions.v1'],
        });
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
    fetchBtn.classList.remove('is-busy');
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

    // Get current default manufacturing characters (the ASSET axis)
    const defaultCharacterIds = await window.electronAPI.industry.getDefaultManufacturingCharacters();

    // ...and the BLUEPRINT axis, which is stored separately per character.
    const blueprintSettings = {};
    for (const character of characters) {
      blueprintSettings[character.characterId] =
        await window.electronAPI.divisions.getBlueprintSettings(character.characterId);
    }

    // Two INDEPENDENT axes per character, matching the division grid above:
    // which characters' assets count, and which characters' blueprints supply
    // ME/TE. A character can be one without being the other.
    let html = `
      <div class="default-characters-grid">
        <div class="character-checkbox-item character-checkbox-head">
          <span class="character-checkbox-name"></span>
          <span class="division-axis-label" title="Use this character's assets">Assets</span>
          <span class="division-axis-label" title="Use this character's blueprints">Blueprints</span>
        </div>
    `;

    for (const character of characters) {
      const assetsChecked = defaultCharacterIds.includes(character.characterId);
      const blueprintsChecked = !!(blueprintSettings[character.characterId] || {}).useBlueprintsFrom;

      html += `
        <div class="character-checkbox-item">
          <span class="character-checkbox-name">
            <img
              src="${character.portrait}?size=64"
              alt=""
              class="mfg-character-portrait"
              data-fallback="portrait"
            />
            <span>${character.characterName}</span>
          </span>
          <label class="division-axis" title="Use ${character.characterName}'s assets">
            <input
              type="checkbox"
              class="character-checkbox"
              data-character-id="${character.characterId}"
              ${assetsChecked ? 'checked' : ''}
            />
          </label>
          <label class="division-axis" title="Use ${character.characterName}'s blueprints">
            <input
              type="checkbox"
              class="character-blueprints-checkbox"
              data-character="${character.characterId}"
              ${blueprintsChecked ? 'checked' : ''}
            />
          </label>
        </div>
      `;
    }

    html += '</div>';
    containerEl.innerHTML = html;
    QFUI.attachPortraitFallbacks(containerEl);

    // Asset axis
    const checkboxes = containerEl.querySelectorAll('.character-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', handleDefaultManufacturingCharacterToggle);
    });

    // Blueprint axis - independent of the asset checkboxes above.
    const blueprintCheckboxes = containerEl.querySelectorAll('.character-blueprints-checkbox');
    blueprintCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', handleUseBlueprintsFromToggle);
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
  await QFUI.withButtonBusy(checkBtn, 'Checking…', async () => {
    await loadSdeStatus();
  });
}

// Download SDE
async function downloadSde() {
  const updateBtn = document.getElementById('sde-update-btn');
  const progressContainer = document.getElementById('sde-progress');
  const progressBar = document.getElementById('sde-progress-bar');
  const progressText = document.getElementById('sde-progress-text');

  if (updateBtn) updateBtn.disabled = true;
  if (progressContainer) progressContainer.style.display = 'flex';

  // Listen for progress updates. Hold the disposer so we remove only OUR
  // handler - removeProgressListener() nukes every listener on the channel,
  // including other views'.
  const disposeProgress = window.electronAPI.sde.onProgress((progress) => {
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
    disposeProgress();
    if (updateBtn) updateBtn.disabled = false;
  }
}

// Validate current SDE
async function validateCurrentSde() {
  const validateBtn = document.getElementById('sde-validate-btn');

  if (!validateBtn) return;

  await QFUI.withButtonBusy(validateBtn, 'Validating…', async () => {
    try {
      const result = await window.electronAPI.sde.validateCurrent();

      // Show validation results
      showValidationResults(result);

      // Reload SDE status to update validation indicator
      await loadSdeStatus();
    } catch (error) {
      console.error('Validation error:', error);
      alert(`Validation failed: ${error.message}`);
    }
  });
}

// Restore backup SDE
async function restoreBackupSde() {
  const restoreBtn = document.getElementById('sde-restore-btn');

  // Confirm with user
  const confirmed = confirm('Are you sure you want to restore the previous SDE version? This will replace your current SDE database.');

  if (!confirmed) {
    return;
  }

  if (!restoreBtn) return;

  await QFUI.withButtonBusy(restoreBtn, 'Restoring…', async () => {
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
    }
  });
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
      <div class="validation-summary-text">
        <h3>${results.passed ? 'Validation Passed' : 'Validation Failed'}</h3>
        <p>${results.summary}</p>
        ${results.executionTime ? `<small>Completed in ${results.executionTime}ms</small>` : ''}
      </div>
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

  // Only the fetch is busy-wrapped: the success path deliberately holds an
  // "Updated!" confirmation for two seconds afterwards, which is a separate
  // state from "in flight" and must survive the busy restore.
  let outcome = null;

  await QFUI.withButtonBusy(updateBtn, 'Updating…', async () => {
    try {
      const result = await window.electronAPI.costIndices.fetch();

      if (result.success) {
        outcome = result;
        // Reload status
        await loadCostIndicesStatus();
      } else {
        // Show error
        alert(`Failed to update cost indices: ${result.error}`);
      }
    } catch (error) {
      console.error('Error updating cost indices:', error);
      alert(`Error updating cost indices: ${error.message}`);
    }
  });

  if (!outcome) return;

  // Show success state (label only - the icon stays put)
  updateBtn.disabled = true;
  QFUI.setButtonLabel(updateBtn, 'Updated!');

  // Show success message
  setTimeout(() => {
    alert(`Successfully updated cost indices for ${outcome.systemCount.toLocaleString()} solar systems!`);
  }, 100);

  // Reset button after 2 seconds
  setTimeout(() => {
    updateBtn.disabled = false;
    QFUI.setButtonLabel(updateBtn, 'Update Cost Indices');
  }, 2000);
}

function initializeCostIndicesControls() {
  loadCostIndicesStatus();

  const updateBtn = document.getElementById('cost-indices-update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', updateCostIndices);
  }
}

/* ============================================================
   View lifecycle

   Settings is a NATIVE shell view: the shell mounts it directly into
   #view-host, with no iframe. This is the pattern every remaining screen
   follows, so keep the contract intact:

     - init(container, ctx): wire everything; register disposable resources
       on `ctx` so the router tears them down on unmount.
     - destroy():            release anything ctx does not cover.

   Module-level state is reset on each mount, since the module is evaluated
   once but the view may be mounted many times.
   ============================================================ */

let settingsTemplateCache = null;

/**
 * Fetch the Settings markup from public/settings.view.html.
 *
 * The markup lives in its own file rather than inline in index.html, so the
 * view's structure stays readable and separate from the dashboard. Fetched once
 * and cached; each mount gets a fresh clone.
 *
 * @returns {Promise<DocumentFragment|null>}
 */
async function loadSettingsTemplate() {
  if (!settingsTemplateCache) {
    try {
      const html = await fetch('settings.view.html').then((r) => r.text());
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const tpl = parsed.getElementById('settings-view-template');
      if (!tpl) {
        console.error('[settings] template not found in settings.view.html');
        return null;
      }
      settingsTemplateCache = tpl.content;
    } catch (error) {
      console.error('[settings] failed to load template:', error);
      return null;
    }
  }
  return document.importNode(settingsTemplateCache, true);
}

/** Reset per-mount state so a remount does not inherit the previous one. */
function resetSettingsState() {
  currentSettings = {};
  sdeUpdateStatus = null;
}

/**
 * Mount the Settings view.
 * @param {HTMLElement} container  The shell's view container.
 * @param {Object} [ctx]           ViewContext; tracked resources are auto-disposed.
 */
async function initSettingsView(container, ctx) {
  resetSettingsState();

  // Inject the markup, fetched from settings.view.html on first mount.
  if (container && !container.querySelector('#settings-app')) {
    const fragment = await loadSettingsTemplate();
    if (fragment) container.appendChild(fragment);
  }

  await initSettingsMain();
  initializeSdeControls();
  initializeCostIndicesControls();

  // The SDE progress subscription is created per-download inside downloadSde()
  // and disposed in its own `finally`, so there is nothing to track here. If a
  // future long-lived subscription is added, register it as:
  //   ctx.track(window.electronAPI.<ns>.on<Event>(handler));
  void ctx;
}

/** Unmount: release anything the ViewContext does not own. */
function destroySettingsView() {
  // The SDE progress subscription is registered on ctx and disposed by the
  // router; nothing else here holds a resource.
  resetSettingsState();
}

// Settings is a native shell view - the ONLY way it renders. There is no
// standalone-window path.
window.QFShell.router.register('settings', {
  title: 'Settings',
  poppable: false, // configuration, not a working surface to place side by side
  mount(container, params, ctx) {
    initSettingsView(container, ctx);
    return { destroy: destroySettingsView };
  },
});
