// ====================================
// ESI Status Window - Renderer Logic
// ====================================

let currentSelectedCall = null;
let refreshInterval = null;

/**
 * Initialize the ESI Status window
 */
async function initialize() {
  console.log('[ESI Status] Initializing ESI Status window...');

  // Initialize universe endpoints
  await window.electronAPI.esiStatus.initializeUniverse();

  await loadCharacters();

  // Start auto-refresh every 10 seconds
  startAutoRefresh();
}

/**
 * Load characters into navigation
 */
async function loadCharacters() {
  try {
    const characters = await window.electronAPI.esi.getCharacters();
    const navContainer = document.getElementById('character-nav-items');

    if (!characters || characters.length === 0) {
      navContainer.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #888; font-size: 13px;">
          No characters found
        </div>
      `;
      return;
    }

    navContainer.innerHTML = '';

    for (const character of characters) {
      // Initialize character endpoints
      await window.electronAPI.esiStatus.initializeCharacter(character.characterId, character.characterName);

      const navItem = document.createElement('div');
      navItem.className = 'nav-item';
      navItem.dataset.view = 'character';
      navItem.dataset.characterId = character.characterId;
      navItem.dataset.characterName = character.characterName;

      // Get character status
      const calls = await window.electronAPI.esiStatus.getCharacterCalls(character.characterId);
      const statusColor = getOverallStatus(calls);

      navItem.innerHTML = `
        <span class="status-dot ${statusColor}"></span>
        <span>${character.characterName}</span>
      `;

      navItem.addEventListener('click', () => selectCharacter(character.characterId, character.characterName));
      navContainer.appendChild(navItem);
    }

    // Add click handler for universe view
    const universeItem = document.querySelector('.nav-item[data-view="universe"]');
    if (universeItem) {
      universeItem.addEventListener('click', selectUniverse);
    }

  } catch (error) {
    console.error('[ESI Status] Error loading characters:', error);
    const navContainer = document.getElementById('character-nav-items');
    navContainer.innerHTML = `
      <div style="padding: 20px; text-align: center; color: #f44336; font-size: 13px;">
        Error loading characters
      </div>
    `;
  }
}

/**
 * Get overall status color from calls
 */
function getOverallStatus(calls) {
  if (!calls || calls.length === 0) return 'gray';

  let hasError = false;
  let hasWarning = false;

  const oneHourAgo = Date.now() - (60 * 60 * 1000);

  for (const call of calls) {
    if (call.status === 'error') {
      if (call.updated_at && call.updated_at > oneHourAgo) {
        hasError = true;
      } else {
        hasWarning = true;
      }
    } else if (call.status === 'in_progress') {
      hasWarning = true;
    }
  }

  if (hasError) return 'red';
  if (hasWarning) return 'yellow';
  return 'green';
}

/**
 * Select a character and show their ESI calls
 */
async function selectCharacter(characterId, characterName) {
  console.log(`[ESI Status] Selecting character: ${characterName} (${characterId})`);

  // Update navigation active state
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelector(`.nav-item[data-character-id="${characterId}"]`).classList.add('active');

  // Update panel title
  document.getElementById('calls-panel-title').textContent = characterName;
  document.getElementById('calls-panel-subtitle').textContent = 'ESI Calls for this character';

  // Clear call details panel
  clearCallDetails();

  // Load character calls
  await loadCharacterCalls(characterId);
}

/**
 * Select universe view
 */
async function selectUniverse() {
  console.log('[ESI Status] Selecting Eve Universe view');

  // Update navigation active state
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelector('.nav-item[data-view="universe"]').classList.add('active');

  // Update panel title
  document.getElementById('calls-panel-title').textContent = 'Eve Universe';
  document.getElementById('calls-panel-subtitle').textContent = 'Universe-wide ESI Calls';

  // Clear call details panel
  clearCallDetails();

  // Load universe calls
  await loadUniverseCalls();
}

/**
 * Load character-specific ESI calls
 */
async function loadCharacterCalls(characterId) {
  const callsList = document.getElementById('calls-list');
  callsList.innerHTML = '<div class="loading"><div class="spinner"></div>Loading calls...</div>';

  try {
    const calls = await window.electronAPI.esiStatus.getCharacterCalls(characterId);

    if (!calls || calls.length === 0) {
      callsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>No ESI calls found for this character</p>
          <p style="font-size: 12px; color: #666;">ESI calls will appear here once you fetch data</p>
        </div>
      `;
      return;
    }

    callsList.innerHTML = '';

    for (const call of calls) {
      const callItem = createCallItem(call);
      callsList.appendChild(callItem);
    }

  } catch (error) {
    console.error('[ESI Status] Error loading character calls:', error);
    callsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        <p style="color: #f44336;">Error loading calls</p>
        <p style="font-size: 12px;">${error.message}</p>
      </div>
    `;
  }
}

/**
 * Load universe-wide ESI calls
 */
async function loadUniverseCalls() {
  const callsList = document.getElementById('calls-list');
  callsList.innerHTML = '<div class="loading"><div class="spinner"></div>Loading calls...</div>';

  try {
    const calls = await window.electronAPI.esiStatus.getUniverseCalls();

    if (!calls || calls.length === 0) {
      callsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>No universe ESI calls found</p>
          <p style="font-size: 12px; color: #666;">ESI calls will appear here once you fetch data</p>
        </div>
      `;
      return;
    }

    callsList.innerHTML = '';

    for (const call of calls) {
      const callItem = createCallItem(call);
      callsList.appendChild(callItem);
    }

  } catch (error) {
    console.error('[ESI Status] Error loading universe calls:', error);
    callsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        <p style="color: #f44336;">Error loading calls</p>
        <p style="font-size: 12px;">${error.message}</p>
      </div>
    `;
  }
}

/**
 * Create a call item element
 */
function createCallItem(call) {
  const callItem = document.createElement('div');
  callItem.className = `call-item status-${call.status}`;
  callItem.dataset.callKey = call.call_key;

  const lastQueryText = call.last_query_at ? formatTimestamp(call.last_query_at) : 'Never';

  callItem.innerHTML = `
    <div class="call-item-header">
      <div class="call-item-title">
        <span class="status-dot ${getStatusColor(call)}"></span>
        ${call.endpoint_label}
      </div>
      <span class="badge ${call.status === 'success' ? 'success' : (call.status === 'error' ? 'error' : 'warning')}">
        ${call.status.toUpperCase()}
      </span>
    </div>
    <div class="call-item-meta">Last query: ${lastQueryText}</div>
  `;

  callItem.addEventListener('click', () => selectCall(call.call_key));

  return callItem;
}

/**
 * Get status color for a call
 */
function getStatusColor(call) {
  if (call.status === 'success') return 'green';
  if (call.status === 'error') {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    if (call.updated_at && call.updated_at > oneHourAgo) {
      return 'red';
    }
    return 'yellow';
  }
  if (call.status === 'in_progress') return 'yellow';
  if (call.status === 'pending') return 'gray';
  return 'gray';
}

/**
 * Select a call and show its details
 */
async function selectCall(callKey) {
  console.log(`[ESI Status] Selecting call: ${callKey}`);

  currentSelectedCall = callKey;

  // Update selected state
  document.querySelectorAll('.call-item').forEach(item => item.classList.remove('selected'));
  document.querySelector(`.call-item[data-call-key="${callKey}"]`)?.classList.add('selected');

  // Load call details
  await loadCallDetails(callKey);
}

/**
 * Load detailed information for a call
 */
async function loadCallDetails(callKey) {
  const detailsContainer = document.getElementById('call-details');
  detailsContainer.innerHTML = '<div class="loading"><div class="spinner"></div>Loading details...</div>';

  try {
    const details = await window.electronAPI.esiStatus.getCallDetails(callKey);
    const call = details.status;
    const history = details.history || [];

    if (!call) {
      detailsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">❌</div>
          <p>Call not found</p>
        </div>
      `;
      return;
    }

    let detailsHTML = `
      <div class="detail-header">
        <div class="detail-title">${call.endpoint_label}</div>
        <div class="detail-subtitle">${call.call_key}</div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Status</div>
        <div class="detail-row">
          <span class="detail-label">Current Status</span>
          <span class="detail-value ${call.status === 'success' ? 'success' : (call.status === 'error' ? 'error' : 'warning')}">
            ${call.status.toUpperCase()}
          </span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Last Query</span>
          <span class="detail-value">${call.last_query_at ? formatTimestamp(call.last_query_at) : 'Never'}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Last Updated</span>
          <span class="detail-value">${call.updated_at ? formatTimestamp(call.updated_at) : 'Never'}</span>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Cache & Rate Limiting</div>
        <div class="detail-row">
          <span class="detail-label">Cache Expires</span>
          <span class="detail-value">${call.cache_expires_at ? formatTimestamp(call.cache_expires_at) : 'N/A'}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Next Allowed Query</span>
          <span class="detail-value">${call.next_allowed_at ? formatTimestamp(call.next_allowed_at) : 'Anytime'}</span>
        </div>
        ${calculateNextQueryTime(call)}
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Statistics</div>
        <div class="detail-row">
          <span class="detail-label">Total Requests</span>
          <span class="detail-value">${call.request_count || 0}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Successful</span>
          <span class="detail-value success">${call.success_count || 0}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Failed</span>
          <span class="detail-value error">${call.error_count || 0}</span>
        </div>
      </div>
    `;

    if (call.error_message) {
      detailsHTML += `
        <div class="detail-section">
          <div class="detail-section-title">Error Details</div>
          <div class="error-message">
            <div style="font-weight: 600; margin-bottom: 8px;">Error Code: ${call.error_code || 'UNKNOWN'}</div>
            ${call.error_message}
          </div>
        </div>
      `;
    }

    if (history && history.length > 0) {
      detailsHTML += `
        <div class="detail-section">
          <div class="detail-section-title">Recent History (Last ${history.length} calls)</div>
      `;

      for (const entry of history) {
        const statusBadge = entry.status === 'success' ? 'success' : 'error';
        detailsHTML += `
          <div class="detail-row">
            <span class="detail-label">${formatTimestamp(entry.timestamp)}</span>
            <span class="badge ${statusBadge}">${entry.status.toUpperCase()}${entry.duration_ms ? ` (${entry.duration_ms}ms)` : ''}</span>
          </div>
        `;
      }

      detailsHTML += '</div>';
    }

    detailsContainer.innerHTML = detailsHTML;

  } catch (error) {
    console.error('[ESI Status] Error loading call details:', error);
    detailsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        <p style="color: #f44336;">Error loading details</p>
        <p style="font-size: 12px;">${error.message}</p>
      </div>
    `;
  }
}

/**
 * Calculate next query time display
 */
function calculateNextQueryTime(call) {
  const now = Date.now();
  let nextQueryTime = null;
  let label = '';

  if (call.cache_expires_at && call.cache_expires_at > now) {
    nextQueryTime = call.cache_expires_at;
    label = 'Next automatic query';
  } else if (call.next_allowed_at && call.next_allowed_at > now) {
    nextQueryTime = call.next_allowed_at;
    label = 'Rate limited until';
  }

  if (nextQueryTime) {
    const timeUntil = nextQueryTime - now;
    const seconds = Math.floor(timeUntil / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    let countdown = '';
    if (hours > 0) {
      countdown = `in ${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      countdown = `in ${minutes}m ${seconds % 60}s`;
    } else {
      countdown = `in ${seconds}s`;
    }

    return `
      <div class="detail-row">
        <span class="detail-label">${label}</span>
        <span class="detail-value">${countdown}</span>
      </div>
    `;
  }

  return '';
}

/**
 * Clear the call details panel back to default state
 */
function clearCallDetails() {
  const detailsContainer = document.getElementById('call-details');
  if (detailsContainer) {
    detailsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <p>Click on any call to see its details</p>
      </div>
    `;
  }

  // Clear selected call
  currentSelectedCall = null;

  // Remove selected state from all call items
  document.querySelectorAll('.call-item').forEach(item => item.classList.remove('selected'));
}

/**
 * Format timestamp to relative time
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return 'Never';

  const now = Date.now();
  const diff = now - timestamp;

  // Future timestamps
  if (diff < 0) {
    const absDiff = Math.abs(diff);
    const seconds = Math.floor(absDiff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `in ${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
    return `in ${seconds} second${seconds > 1 ? 's' : ''}`;
  }

  // Past timestamps
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    const date = new Date(timestamp);
    return date.toLocaleString();
  }
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (seconds > 5) return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Start auto-refresh
 */
function startAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  refreshInterval = setInterval(async () => {
    console.log('[ESI Status] Auto-refreshing view...');

    // Refresh character navigation status indicators
    await loadCharacters();

    // Refresh current view if active
    const activeNav = document.querySelector('.nav-item.active');
    if (activeNav) {
      if (activeNav.dataset.view === 'character') {
        await loadCharacterCalls(parseInt(activeNav.dataset.characterId));
      } else if (activeNav.dataset.view === 'universe') {
        await loadUniverseCalls();
      }
    }

    // Refresh current call details if selected
    if (currentSelectedCall) {
      await loadCallDetails(currentSelectedCall);
    }
  }, 10000); // 10 seconds
}

/**
 * Cleanup on window unload
 */
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initialize);
