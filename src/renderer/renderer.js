// Renderer process scripts
// This file runs in the web page context

console.log('Quantum Forge renderer initialized');
console.log('[SDE] Registering update listener...');

let currentDefaultCharacterId = null;

// Store event listeners so they can be removed
let characterMenuClickOutsideListener = null;

// Global error handlers
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Renderer error:', { message, source, lineno, colno, error });
  return false;
};

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// Listen for SDE update available
window.electronAPI.sde.onUpdateAvailable((updateInfo) => {
  console.log('[SDE] Renderer received update notification:', updateInfo);
  showUpdateModal(updateInfo);
});

console.log('[SDE] Update listener registered');

// Show SDE update modal
function showUpdateModal(updateInfo) {
  const modal = document.getElementById('sde-update-modal');
  const currentVersionEl = document.getElementById('update-current-version');
  const latestVersionEl = document.getElementById('update-latest-version');
  const messageEl = document.getElementById('update-message');

  if (!modal) return;

  // Update content
  if (currentVersionEl) {
    currentVersionEl.textContent = updateInfo.currentVersion || 'Not installed';
  }

  if (latestVersionEl) {
    latestVersionEl.textContent = updateInfo.latestVersion || 'Unknown';
  }

  if (messageEl) {
    if (updateInfo.isCritical) {
      messageEl.textContent = 'A critical SDE update is required. Please update as soon as possible.';
    } else {
      messageEl.textContent = 'A new version of the Eve Online Static Data Export is available.';
    }
  }

  // Show modal
  modal.style.display = 'flex';
}

// Clean up event listeners on page unload
window.addEventListener('beforeunload', () => {
  if (characterMenuClickOutsideListener) {
    document.removeEventListener('click', characterMenuClickOutsideListener);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('DOM loaded');

  // SDE Update modal handlers
  const updateModal = document.getElementById('sde-update-modal');
  const updateNowBtn = document.getElementById('update-now-btn');
  const updateLaterBtn = document.getElementById('update-later-btn');
  const updateSettingsBtn = document.getElementById('update-settings-btn');

  if (updateNowBtn) {
    updateNowBtn.addEventListener('click', () => {
      // Open settings and close modal
      if (updateModal) updateModal.style.display = 'none';
      window.electronAPI.openSettings();
    });
  }

  if (updateLaterBtn) {
    updateLaterBtn.addEventListener('click', () => {
      if (updateModal) updateModal.style.display = 'none';
    });
  }

  if (updateSettingsBtn) {
    updateSettingsBtn.addEventListener('click', () => {
      if (updateModal) updateModal.style.display = 'none';
      window.electronAPI.openSettings();
    });
  }

  // Settings button handler
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      window.electronAPI.openSettings();
    });
  }

  // Market Manager card handler
  const marketCard = document.getElementById('market-manager-card');
  if (marketCard) {
    marketCard.addEventListener('click', () => {
      console.log('Opening Market Manager');
      window.location.href = 'market.html';
    });
  }

  // Blueprints card handler
  const blueprintsCard = document.getElementById('blueprints-card');
  if (blueprintsCard) {
    blueprintsCard.addEventListener('click', () => {
      console.log('Opening Blueprint Calculator');
      window.location.href = 'blueprint-calculator.html';
    });
  }

  // Facilities card handler
  const facilitiesCard = document.getElementById('facilities-card');
  if (facilitiesCard) {
    facilitiesCard.addEventListener('click', () => {
      console.log('Opening Facilities Manager');
      window.location.href = 'facilities.html';
    });
  }

  const manufacturingSummaryCard = document.getElementById('manufacturing-summary-card');
  if (manufacturingSummaryCard) {
    manufacturingSummaryCard.addEventListener('click', () => {
      console.log('Opening Manufacturing Summary');
      window.electronAPI.manufacturingSummary.openWindow();
    });
  }

  const manufacturingPlansCard = document.getElementById('manufacturing-plans-card');
  if (manufacturingPlansCard) {
    manufacturingPlansCard.addEventListener('click', () => {
      console.log('Opening Manufacturing Plans');
      window.electronAPI.plans.openWindow();
    });
  }

  // Reactions Calculator card handler
  const reactionsCalculatorCard = document.getElementById('reactions-calculator-card');
  if (reactionsCalculatorCard) {
    reactionsCalculatorCard.addEventListener('click', () => {
      console.log('Opening Reactions Calculator');
      window.location.href = 'reactions-calculator.html';
    });
  }

  // Cleanup Tool card handler
  const cleanupToolCard = document.getElementById('cleanup-tool-card');
  if (cleanupToolCard) {
    cleanupToolCard.addEventListener('click', () => {
      console.log('Opening Cleanup Tool');
      window.electronAPI.cleanupTool.openWindow();
    });
  }

  // Load default character avatar
  await loadDefaultCharacterAvatar();

  // Listen for default character changes
  window.electronAPI.esi.onDefaultCharacterChanged(() => {
    console.log('Default character changed, refreshing avatar...');
    loadDefaultCharacterAvatar();
    // Also update character count in footer when default character changes
    window.footerUtils.updateCharacterCount();
  });

  // Initialize status footer
  await window.footerUtils.initializeFooter();

  } catch (error) {
    console.error('Fatal initialization error:', error);
    document.body.innerHTML = `
      <div style="color: #ff4444; padding: 40px; font-family: system-ui; text-align: center;">
        <h2>Failed to Initialize</h2>
        <p>${error.message}</p>
        <p style="font-size: 0.9em; color: #999; margin-top: 20px;">Check the console for more details</p>
      </div>
    `;
  }
});

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

        // Set avatar image
        avatarImg.src = `${defaultCharacter.portrait}?size=128`;
        avatarImg.alt = defaultCharacter.characterName;

        // Update menu header
        menuNameEl.textContent = defaultCharacter.characterName;

        // Show the avatar container
        avatarContainer.style.display = 'block';

        // Setup menu toggle
        setupCharacterMenu(defaultCharacter);

        console.log('Loaded default character avatar:', defaultCharacter.characterName);
      } else {
        console.log('Default character unchanged, skipping update');
      }
    } else {
      // No default character, hide the container
      currentDefaultCharacterId = null;
      avatarContainer.style.display = 'none';
      console.log('No default character set');
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
