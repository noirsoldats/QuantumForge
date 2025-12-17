// ====================================
// Footer Update Logic - Shared Module
// ====================================
// This module provides footer initialization and update logic
// that can be used across all pages in the main window

let footerUpdateIntervals = {
  clock: null,
  status: null,
};

// Constants
const CACHE_KEY = 'quantum_forge_server_status_cache';
const MIN_FETCH_INTERVAL = 30 * 1000; // 30 seconds minimum between fetches

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

  // Start Eve Time clock (updates every second)
  startEveTimeClock();

  // Start server status polling (updates every minute)
  startServerStatusPolling();
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
 * Update server status and player count
 */
async function updateServerStatus() {
  try {
    const now = Date.now();
    const cached = getCachedServerStatus();

    // Check if we can use cached data
    let status;
    if (cached && cached.data) {
      const timeSinceLastFetch = now - cached.timestamp;

      if (timeSinceLastFetch < MIN_FETCH_INTERVAL) {
        // Use cached data
        status = cached.data;
        console.log(`[Footer] Using cached server status (${Math.round(timeSinceLastFetch / 1000)}s old, cache valid for ${Math.round((MIN_FETCH_INTERVAL - timeSinceLastFetch) / 1000)}s more)`);
      } else {
        // Cache expired, fetch fresh data
        console.log(`[Footer] Cache expired (${Math.round(timeSinceLastFetch / 1000)}s old), fetching fresh server status...`);
        status = await window.electronAPI.status.fetch();
        setCachedServerStatus(status);
      }
    } else {
      // No cache exists, fetch fresh data
      console.log('[Footer] No cache found, fetching fresh server status...');
      status = await window.electronAPI.status.fetch();
      setCachedServerStatus(status);
    }

    // Update player count
    const playersElement = document.getElementById('players-online');
    if (playersElement && status.success) {
      playersElement.textContent = status.players ? status.players.toLocaleString() : '--';
    }

    // Update server status icon and tooltip
    const iconElement = document.getElementById('server-status-icon');
    const textElement = document.getElementById('server-status-text');
    const statusItem = document.getElementById('server-status-item');

    if (iconElement && textElement && statusItem) {
      // Remove all status classes
      iconElement.classList.remove('status-online', 'status-offline', 'status-restarting', 'status-loading');

      if (status.success) {
        const serverStatus = status.serverStatus || 'offline';
        iconElement.classList.add(`status-${serverStatus}`);

        // Update SVG icon based on status
        if (serverStatus === 'online') {
          iconElement.innerHTML = `
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9 12l2 2 4-4"></path>
          `;
          textElement.textContent = 'Online';
          statusItem.title = `Server Status: Online (${status.players} players)`;
        } else if (serverStatus === 'restarting') {
          iconElement.innerHTML = `
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          `;
          textElement.textContent = 'Restarting';
          statusItem.title = 'Server Status: VIP Mode (Restarting/Maintenance)';
        } else {
          iconElement.innerHTML = `
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          `;
          textElement.textContent = 'Offline';
          statusItem.title = 'Server Status: Offline';
        }
      } else {
        // Error state
        iconElement.classList.add('status-offline');
        iconElement.innerHTML = `
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        `;
        textElement.textContent = 'Error';
        statusItem.title = `Server Status: Error (${status.error || 'Unknown error'})`;
      }
    }
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
 * Cleanup footer intervals (call when window unloads)
 */
function cleanupFooter() {
  if (footerUpdateIntervals.clock) {
    clearInterval(footerUpdateIntervals.clock);
  }
  if (footerUpdateIntervals.status) {
    clearInterval(footerUpdateIntervals.status);
  }
}

// Cleanup on window unload
window.addEventListener('beforeunload', () => {
  cleanupFooter();
});

// Export for use in other modules
window.footerUtils = {
  initializeFooter,
  updateCharacterCount,
  updateServerStatus,
  cleanupFooter,
};
