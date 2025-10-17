// Renderer process scripts
// This file runs in the web page context

console.log('Quantum Forge initialized');

let currentDefaultCharacterId = null;

document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM loaded');

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

  // Load default character avatar
  await loadDefaultCharacterAvatar();

  // Listen for default character changes
  window.electronAPI.esi.onDefaultCharacterChanged(() => {
    console.log('Default character changed, refreshing avatar...');
    loadDefaultCharacterAvatar();
  });
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
