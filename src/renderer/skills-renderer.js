// Skills window renderer script

console.log('Skills window initialized');

let currentCharacterId = null;
let characterData = null;
let allSkills = [];
let filteredSkills = [];
let skillNamesCache = {};
let cacheCheckInterval = null;

// Listen for character ID from IPC
window.electronAPI.skills.onCharacterId((characterId) => {
  console.log('Received character ID via IPC:', characterId);
  currentCharacterId = characterId;
  initializeSkillsWindow();
});

// Initialize the skills window
async function initializeSkillsWindow() {
  if (!currentCharacterId) {
    console.error('No character ID provided');
    return;
  }

  try {
    // Load character data
    characterData = await window.electronAPI.esi.getCharacter(currentCharacterId);
    console.log('Loaded character data:', characterData);

    if (!characterData) {
      console.error('Character not found');
      return;
    }

    // Update header with character info
    updateCharacterHeader();

    // Load skills
    await loadSkills();

    // Setup event listeners
    setupEventListeners();

    // Check cache status and start monitoring
    await updateRefreshButtonState();
    startCacheMonitoring();
  } catch (error) {
    console.error('Error initializing skills window:', error);
  }
}

// Update character header
function updateCharacterHeader() {
  const portraitEl = document.getElementById('character-portrait');
  const nameEl = document.getElementById('character-name');
  const totalSpEl = document.getElementById('total-sp');

  if (portraitEl) {
    portraitEl.src = `${characterData.portrait}?size=128`;
    portraitEl.alt = characterData.characterName;
  }

  if (nameEl) {
    nameEl.textContent = characterData.characterName;
  }

  if (totalSpEl && characterData.skills) {
    const totalSp = characterData.skills.totalSp || 0;
    totalSpEl.textContent = `Total SP: ${formatNumber(totalSp)}`;
  }
}

// Load skills
async function loadSkills() {
  const skillsList = document.getElementById('skills-list');

  if (!characterData.skills || !characterData.skills.skills) {
    // No skills loaded, show message
    skillsList.innerHTML = `
      <div class="empty-state">
        <p>No skills data loaded. Click "Refresh from API" to fetch skills from Eve Online.</p>
      </div>
    `;
    return;
  }

  // Show loading state
  skillsList.innerHTML = `
    <div class="loading-state">
      <p>Loading skill names from SDE...</p>
    </div>
  `;

  // Convert skills object to array
  allSkills = Object.values(characterData.skills.skills).map(skill => ({
    ...skill,
    hasOverride: characterData.skillOverrides && characterData.skillOverrides[skill.skillId] !== undefined,
    effectiveLevel: getEffectiveLevel(skill.skillId),
  }));

  // Fetch skill names from SDE
  try {
    const skillIds = allSkills.map(s => s.skillId);
    skillNamesCache = await window.electronAPI.sde.getSkillNames(skillIds);
    console.log('Loaded skill names:', Object.keys(skillNamesCache).length);

    // Add skill names to skills array
    allSkills.forEach(skill => {
      skill.skillName = skillNamesCache[skill.skillId] || `Skill ${skill.skillId}`;
    });

    // Sort by skill name
    allSkills.sort((a, b) => a.skillName.localeCompare(b.skillName));
  } catch (error) {
    console.error('Error loading skill names:', error);

    // Check if error is due to missing SDE
    if (error.message && error.message.includes('SDE database not found')) {
      // Show message about missing SDE
      skillsList.innerHTML = `
        <div class="empty-state">
          <p><strong>Eve SDE database not found.</strong></p>
          <p>Please open Settings (gear icon) and click "Update SDE" to download the database.</p>
          <p>Showing skills with IDs only for now...</p>
        </div>
      `;

      // Wait a moment then show skills with IDs
      setTimeout(() => {
        // Add fallback names
        allSkills.forEach(skill => {
          skill.skillName = `Skill ${skill.skillId}`;
        });

        console.log('Loaded skills with ID fallbacks:', allSkills.length);
        applyFilters();
      }, 3000);

      return;
    }

    // Add fallback names for other errors
    allSkills.forEach(skill => {
      skill.skillName = `Skill ${skill.skillId}`;
    });
  }

  console.log('Loaded skills:', allSkills.length);

  // Apply filters
  applyFilters();
}

// Get effective skill level (considering overrides)
function getEffectiveLevel(skillId) {
  if (characterData.skillOverrides && characterData.skillOverrides[skillId] !== undefined) {
    return characterData.skillOverrides[skillId];
  }

  const skill = characterData.skills.skills[skillId];
  return skill ? skill.trainedSkillLevel : 0;
}

// Apply filters
function applyFilters() {
  const searchQuery = document.getElementById('skill-search')?.value.toLowerCase() || '';
  const showTrained = document.getElementById('show-trained')?.checked || false;
  const showOverridden = document.getElementById('show-overridden')?.checked || false;
  const showUntrained = document.getElementById('show-untrained')?.checked || false;

  filteredSkills = allSkills.filter(skill => {
    // Search filter (by skill name or ID)
    if (searchQuery) {
      const skillName = skill.skillName || '';
      const skillId = skill.skillId.toString();
      if (!skillName.toLowerCase().includes(searchQuery) && !skillId.includes(searchQuery)) {
        return false;
      }
    }

    // Determine skill characteristics
    const hasTrainedLevels = skill.trainedSkillLevel > 0;
    const isOverridden = skill.hasOverride;
    const isUntrained = skill.trainedSkillLevel === 0 && !skill.hasOverride;

    // If "Overridden" filter is checked, ONLY show overridden skills
    if (showOverridden) {
      if (!isOverridden) return false;
    }

    // Apply trained/untrained filters
    // Overridden skills with trained levels should appear in "Trained" category
    const isTrained = hasTrainedLevels || isOverridden;

    if (isTrained && !showTrained && !showOverridden) return false;
    if (isUntrained && !showUntrained) return false;

    return true;
  });

  renderSkills();
}

// Render skills list
function renderSkills() {
  const skillsList = document.getElementById('skills-list');

  if (filteredSkills.length === 0) {
    skillsList.innerHTML = `
      <div class="empty-state">
        <p>No skills match the current filters.</p>
      </div>
    `;
    return;
  }

  skillsList.innerHTML = filteredSkills.map(skill => createSkillItem(skill)).join('');

  // Add event listeners to level buttons
  filteredSkills.forEach(skill => {
    for (let level = 0; level <= 5; level++) {
      const btn = document.getElementById(`skill-${skill.skillId}-level-${level}`);
      if (btn) {
        btn.addEventListener('click', () => setSkillLevel(skill.skillId, level));
      }
    }
  });
}

// Create skill item HTML
function createSkillItem(skill) {
  const isOverride = skill.hasOverride;
  const effectiveLevel = skill.effectiveLevel;
  const actualLevel = skill.trainedSkillLevel;
  const sp = skill.skillpointsInSkill || 0;
  const skillName = skill.skillName || `Skill ${skill.skillId}`;

  return `
    <div class="skill-item ${isOverride ? 'has-override' : ''}">
      <div class="skill-info">
        <div class="skill-name">${skillName}</div>
        <div class="skill-details">
          <span>Level: ${actualLevel}</span>
          <span class="skill-sp">SP: ${formatNumber(sp)}</span>
        </div>
      </div>
      <div class="skill-controls">
        <div class="level-display ${isOverride ? 'override' : ''}">
          ${isOverride ? `Override: ${effectiveLevel}` : `Level ${effectiveLevel}`}
        </div>
        <div class="level-selector">
          ${[0, 1, 2, 3, 4, 5].map(level => {
            let btnClass = 'level-btn';

            // Highlight the effective (override) level
            if (effectiveLevel === level) {
              btnClass += isOverride ? ' override' : ' active';
            }

            // Highlight the actual trained level if overridden and different
            if (isOverride && actualLevel === level && actualLevel !== effectiveLevel) {
              btnClass += ' trained-level';
            }

            return `
              <button
                class="${btnClass}"
                id="skill-${skill.skillId}-level-${level}"
                title="Set level to ${level}"
              >
                ${level}
              </button>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

// Set skill level (override)
async function setSkillLevel(skillId, level) {
  try {
    const skill = allSkills.find(s => s.skillId === skillId);
    if (!skill) return;

    // If setting to actual level, remove override
    if (level === skill.trainedSkillLevel) {
      level = null;
    }

    const success = await window.electronAPI.skills.setOverride(currentCharacterId, skillId, level);

    if (success) {
      console.log(`Set skill ${skillId} override to ${level}`);

      // Reload character data and skills
      characterData = await window.electronAPI.esi.getCharacter(currentCharacterId);
      await loadSkills();
    } else {
      console.error('Failed to set skill override');
    }
  } catch (error) {
    console.error('Error setting skill level:', error);
  }
}

// Refresh skills from API
async function refreshSkills() {
  const refreshBtn = document.getElementById('refresh-skills-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      Refreshing...
    `;
  }

  try {
    const result = await window.electronAPI.skills.fetch(currentCharacterId);

    if (result.success) {
      console.log('Skills refreshed successfully');

      // Reload character data and skills
      characterData = await window.electronAPI.esi.getCharacter(currentCharacterId);
      await loadSkills();
      updateCharacterHeader();

      // Update button state with new cache
      await updateRefreshButtonState();
    } else {
      console.error('Failed to refresh skills:', result.error);
      alert(`Failed to refresh skills: ${result.error}`);
    }
  } catch (error) {
    console.error('Error refreshing skills:', error);
    alert(`Error refreshing skills: ${error.message}`);
  } finally {
    // Update button state
    await updateRefreshButtonState();
  }
}

// Update refresh button state based on cache
async function updateRefreshButtonState() {
  const refreshBtn = document.getElementById('refresh-skills-btn');
  if (!refreshBtn || !currentCharacterId) return;

  try {
    const cacheStatus = await window.electronAPI.skills.getCacheStatus(currentCharacterId);

    if (cacheStatus.isCached && cacheStatus.remainingSeconds > 0) {
      // Cache is still valid, disable button
      refreshBtn.disabled = true;

      const minutes = Math.floor(cacheStatus.remainingSeconds / 60);
      const seconds = cacheStatus.remainingSeconds % 60;
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        Cached (${timeStr})
      `;
      refreshBtn.title = `ESI cache expires in ${timeStr}`;
    } else {
      // Cache expired, enable button
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        Refresh from API
      `;
      refreshBtn.title = 'Fetch latest skills from ESI';
    }
  } catch (error) {
    console.error('Error updating refresh button state:', error);
    // On error, enable the button
    refreshBtn.disabled = false;
  }
}

// Start monitoring cache status
function startCacheMonitoring() {
  // Clear any existing interval
  if (cacheCheckInterval) {
    clearInterval(cacheCheckInterval);
  }

  // Check cache status every second
  cacheCheckInterval = setInterval(async () => {
    await updateRefreshButtonState();
  }, 1000);
}

// Stop monitoring cache status (when window closes)
function stopCacheMonitoring() {
  if (cacheCheckInterval) {
    clearInterval(cacheCheckInterval);
    cacheCheckInterval = null;
  }
}

// Clear all overrides
async function clearAllOverrides() {
  if (!confirm('Are you sure you want to clear all skill overrides? This will reset all skills to their actual trained levels.')) {
    return;
  }

  try {
    const success = await window.electronAPI.skills.clearOverrides(currentCharacterId);

    if (success) {
      console.log('All overrides cleared');

      // Reload character data and skills
      characterData = await window.electronAPI.esi.getCharacter(currentCharacterId);
      await loadSkills();
    } else {
      console.error('Failed to clear overrides');
      alert('Failed to clear overrides');
    }
  } catch (error) {
    console.error('Error clearing overrides:', error);
    alert(`Error clearing overrides: ${error.message}`);
  }
}

// Setup event listeners
function setupEventListeners() {
  // Search input
  const searchInput = document.getElementById('skill-search');
  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  // Filter checkboxes
  const showTrained = document.getElementById('show-trained');
  const showOverridden = document.getElementById('show-overridden');
  const showUntrained = document.getElementById('show-untrained');

  if (showTrained) {
    showTrained.addEventListener('change', (e) => {
      // If Trained is checked, uncheck Untrained (mutually exclusive)
      if (e.target.checked && showUntrained) {
        showUntrained.checked = false;
      }
      applyFilters();
    });
  }

  if (showOverridden) {
    showOverridden.addEventListener('change', applyFilters);
  }

  if (showUntrained) {
    showUntrained.addEventListener('change', (e) => {
      // If Untrained is checked, uncheck Trained (mutually exclusive)
      if (e.target.checked && showTrained) {
        showTrained.checked = false;
      }
      applyFilters();
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById('refresh-skills-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshSkills);
  }

  // Clear overrides button
  const clearBtn = document.getElementById('clear-overrides-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearAllOverrides);
  }
}

// Utility function to format numbers with commas
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Initialize when DOM is ready (character ID will come via IPC)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, waiting for character ID via IPC...');
  });
}
