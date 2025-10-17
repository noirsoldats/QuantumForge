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
  const launchStartup = document.getElementById('launch-startup');
  if (launchStartup) {
    launchStartup.checked = currentSettings.general?.launchOnStartup || false;
  }

  const minimizeTray = document.getElementById('minimize-tray');
  if (minimizeTray) {
    minimizeTray.checked = currentSettings.general?.minimizeToTray || false;
  }

  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = currentSettings.general?.theme || 'dark';
  }

  const desktopNotifications = document.getElementById('desktop-notifications');
  if (desktopNotifications) {
    desktopNotifications.checked = currentSettings.general?.desktopNotifications !== false;
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
    });
  });

  // Settings handlers - Auto-save on change

  // Launch on startup
  const launchStartup = document.getElementById('launch-startup');
  if (launchStartup) {
    launchStartup.addEventListener('change', (e) => {
      console.log('Launch on startup:', e.target.checked);
      saveSetting('general', 'launchOnStartup', e.target.checked);
    });
  }

  // Minimize to tray
  const minimizeTray = document.getElementById('minimize-tray');
  if (minimizeTray) {
    minimizeTray.addEventListener('change', (e) => {
      console.log('Minimize to tray:', e.target.checked);
      saveSetting('general', 'minimizeToTray', e.target.checked);
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

// SDE Management
let sdeUpdateStatus = null;

// Load SDE status on page load
async function loadSdeStatus() {
  try {
    const status = await window.electronAPI.sde.checkUpdate();
    sdeUpdateStatus = status;
    updateSdeUI(status);
  } catch (error) {
    console.error('Error loading SDE status:', error);
    updateSdeUI({ error: error.message });
  }
}

// Update SDE UI elements
function updateSdeUI(status) {
  const currentVersionEl = document.getElementById('sde-current-version');
  const latestVersionEl = document.getElementById('sde-latest-version');
  const minimumVersionEl = document.getElementById('sde-minimum-version');
  const statusEl = document.getElementById('sde-status');
  const updateBtn = document.getElementById('sde-update-btn');

  if (status.error) {
    if (currentVersionEl) currentVersionEl.textContent = 'Error';
    if (latestVersionEl) latestVersionEl.textContent = 'Error';
    if (statusEl) {
      statusEl.textContent = 'Check Failed';
      statusEl.className = 'sde-value critical';
    }
    if (updateBtn) updateBtn.disabled = true;
    return;
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
      if (progress.stage === 'downloading') {
        progressBar.style.width = `${progress.percent}%`;
        progressText.textContent = `Downloading: ${progress.downloadedMB} MB / ${progress.totalMB} MB (${progress.percent}%)`;
      } else if (progress.stage === 'decompressing') {
        progressBar.style.width = '100%';
        progressText.textContent = 'Decompressing database...';
      } else if (progress.stage === 'complete') {
        progressBar.style.width = '100%';
        progressText.textContent = 'Complete!';
      }
    }
  });

  try {
    const result = await window.electronAPI.sde.download();

    if (result.success) {
      console.log('SDE download successful');
      await loadSdeStatus();

      setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';
      }, 2000);
    } else {
      throw new Error(result.error || 'Download failed');
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
