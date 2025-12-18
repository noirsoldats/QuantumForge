// ====================================
// Footer Update Logic - Shared Module
// ====================================
// This module provides footer initialization and update logic
// that can be used across all pages in the main window

let footerUpdateIntervals = {
  clock: null,
  status: null,
  esiStatus: null,
};

// Constants
const CACHE_KEY = 'quantum_forge_server_status_cache';
const MIN_FETCH_INTERVAL = 60 * 1000; // 60 seconds minimum between fetches (match backend)

/**
 * Get cached server status from sessionStorage
 * Returns null if cache doesn't exist or is invalid
 */
function getCachedServerStatus() {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (!cached) {
      return null;
    }
    return JSON.parse(cached);
  } catch (error) {
    console.error('[Footer] Error reading cache:', error);
    return null;
  }
}

/**
 * Save server status to sessionStorage cache
 */
function setCachedServerStatus(data) {
  try {
    const cacheEntry = {
      data: data,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cacheEntry));
  } catch (error) {
    console.error('[Footer] Error writing cache:', error);
  }
}

/**
 * Initialize status footer
 */
async function initializeFooter() {
  console.log('[Footer] Initializing status footer...');

  // Initial data load
  await updateCharacterCount();
  await updateServerStatus();
  await updateESIStatus();

  // Start Eve Time clock (updates every second)
  startEveTimeClock();

  // Start server status polling (updates every minute)
  startServerStatusPolling();

  // Start ESI status polling (updates every 30 seconds)
  startESIStatusPolling();
}

/**
 * Update character count in footer
 */
async function updateCharacterCount() {
  try {
    const characters = await window.electronAPI.esi.getCharacters();
    const count = characters ? characters.length : 0;

    const countElement = document.getElementById('character-count');
    if (countElement) {
      countElement.textContent = count;
    }
  } catch (error) {
    console.error('[Footer] Error updating character count:', error);
  }
}

/**
 * Start Eve Time clock (UTC)
 */
function startEveTimeClock() {
  // Clear existing interval if any
  if (footerUpdateIntervals.clock) {
    clearInterval(footerUpdateIntervals.clock);
  }

  // Update function
  const updateClock = () => {
    const now = new Date();
    const timeString = now.toISOString().substr(11, 8); // HH:MM:SS format

    const timeElement = document.getElementById('eve-time');
    if (timeElement) {
      timeElement.textContent = timeString;
    }
  };

  // Update immediately
  updateClock();

  // Update every second
  footerUpdateIntervals.clock = setInterval(updateClock, 1000);
}

/**
 * Update server status display
 * @param {Object} data - Server status data
 * @param {boolean} isCached - Whether data is from cache
 * @param {number} ageSeconds - Age of cached data in seconds
 */
function updateServerStatusDisplay(data, isCached = false, ageSeconds = 0) {
  const iconElement = document.getElementById('server-status-icon');
  const textElement = document.getElementById('server-status-text');
  const statusItem = document.getElementById('server-status-item');
  const playersElement = document.getElementById('players-online');

  if (!iconElement || !textElement || !statusItem) return;

  // Update player count
  if (playersElement) {
    playersElement.textContent = data.players ? data.players.toLocaleString() : '--';
  }

  // Remove all status classes
  iconElement.classList.remove('status-online', 'status-offline', 'status-restarting', 'status-loading', 'status-error');

  const serverStatus = data.vip ? 'restarting' : (data.players !== undefined ? 'online' : 'offline');
  iconElement.classList.add(`status-${serverStatus}`);

  // Build title with cache indicator
  let title = `Server Status: ${serverStatus.charAt(0).toUpperCase() + serverStatus.slice(1)}`;
  if (data.players !== undefined) {
    title += ` (${data.players.toLocaleString()} players)`;
  }
  if (isCached && ageSeconds > 0) {
    title += ` [cached, ${ageSeconds}s old]`;
  }

  // Update SVG icon based on status
  if (serverStatus === 'online') {
    iconElement.innerHTML = `
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M9 12l2 2 4-4"></path>
    `;
    textElement.textContent = 'Online';
  } else if (serverStatus === 'restarting') {
    iconElement.innerHTML = `
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    `;
    textElement.textContent = 'Restarting';
  } else {
    iconElement.innerHTML = `
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="15" y1="9" x2="9" y2="15"></line>
      <line x1="9" y1="9" x2="15" y2="15"></line>
    `;
    textElement.textContent = 'Offline';
  }

  statusItem.title = title;
}

/**
 * Update server status and player count
 */
async function updateServerStatus() {
  try {
    const now = Date.now();
    const cached = getCachedServerStatus();

    // Check if we can use cached data
    if (cached && cached.data) {
      const timeSinceLastFetch = now - cached.timestamp;

      if (timeSinceLastFetch < MIN_FETCH_INTERVAL) {
        // Use cached data
        const ageSeconds = Math.floor(timeSinceLastFetch / 1000);
        console.log(`[Footer] Using cached server status (${ageSeconds}s old)`);
        updateServerStatusDisplay(cached.data, true, ageSeconds);
        return;
      }
    }

    // Fetch fresh data from backend
    const result = await window.electronAPI.status.fetch();

    if (!result.success) {
      console.error('Failed to fetch server status:', result.error);

      // Check if we have cached data in sessionStorage as fallback
      if (cached && cached.data) {
        const ageSeconds = Math.floor((now - cached.timestamp) / 1000);
        console.log(`Using sessionStorage fallback (${ageSeconds}s old)`);
        updateServerStatusDisplay(cached.data, true, ageSeconds);
        return;
      }

      // No fallback available, show error
      const iconElement = document.getElementById('server-status-icon');
      const textElement = document.getElementById('server-status-text');
      const statusItem = document.getElementById('server-status-item');

      if (iconElement && textElement && statusItem) {
        iconElement.classList.remove('status-online', 'status-offline', 'status-restarting', 'status-loading');
        iconElement.classList.add('status-error');
        iconElement.innerHTML = `
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        `;
        textElement.textContent = 'Error';
        statusItem.title = `Server Status: Error (${result.error || 'Unknown error'})`;
      }
      return;
    }

    const serverData = result.data || result;

    // Update display
    updateServerStatusDisplay(serverData, result.cached || false, 0);

    // Cache the successful result
    setCachedServerStatus(serverData);

  } catch (error) {
    console.error('[Footer] Error updating server status:', error);
  }
}

/**
 * Start server status polling (every 1 minute)
 */
function startServerStatusPolling() {
  // Clear existing interval if any
  if (footerUpdateIntervals.status) {
    clearInterval(footerUpdateIntervals.status);
  }

  // Update every 60 seconds
  footerUpdateIntervals.status = setInterval(updateServerStatus, 60 * 1000);
}

/**
 * Update ESI status in footer
 */
async function updateESIStatus() {
  try {
    const status = await window.electronAPI.esiStatus.getAggregated();

    const iconElement = document.getElementById('esi-status-icon');
    const textElement = document.getElementById('esi-status-text');
    const statusItem = document.getElementById('esi-status-item');

    if (iconElement && textElement && statusItem) {
      // Remove all status classes
      iconElement.classList.remove('status-online', 'status-warning', 'status-error', 'status-loading');

      if (status.overall === 'green') {
        iconElement.classList.add('status-online');
        textElement.textContent = 'ESI: OK';
        statusItem.title = `ESI Status: All systems operational (${status.totalCount} calls tracked)`;
      } else if (status.overall === 'yellow') {
        iconElement.classList.add('status-warning');
        textElement.textContent = 'ESI: Warning';
        statusItem.title = `ESI Status: ${status.warningCount} calls need attention, ${status.inProgressCount || 0} in progress`;
      } else {
        iconElement.classList.add('status-error');
        textElement.textContent = 'ESI: Error';
        statusItem.title = `ESI Status: ${status.errorCount} calls failed`;
      }
    }
  } catch (error) {
    console.error('[Footer] Error updating ESI status:', error);
  }
}

/**
 * Start ESI status polling (every 30 seconds)
 */
function startESIStatusPolling() {
  // Clear existing interval if any
  if (footerUpdateIntervals.esiStatus) {
    clearInterval(footerUpdateIntervals.esiStatus);
  }

  // Update every 30 seconds
  footerUpdateIntervals.esiStatus = setInterval(updateESIStatus, 30 * 1000);
}

/**
 * Cleanup footer intervals (call when window unloads)
 */
function cleanupFooter() {
  if (footerUpdateIntervals.clock) {
    clearInterval(footerUpdateIntervals.clock);
  }
  if (footerUpdateIntervals.status) {
    clearInterval(footerUpdateIntervals.status);
  }
  if (footerUpdateIntervals.esiStatus) {
    clearInterval(footerUpdateIntervals.esiStatus);
  }
}

// Add click handler for ESI status item to open window
document.addEventListener('DOMContentLoaded', () => {
  const esiStatusItem = document.getElementById('esi-status-item');
  if (esiStatusItem) {
    esiStatusItem.addEventListener('click', () => {
      console.log('[Footer] Opening ESI Status window...');
      window.electronAPI.esiStatus.openWindow();
    });
  }
});

// Cleanup on window unload
window.addEventListener('beforeunload', () => {
  cleanupFooter();
});

// Export for use in other modules
window.footerUtils = {
  initializeFooter,
  updateCharacterCount,
  updateServerStatus,
  updateESIStatus,
  cleanupFooter,
};
