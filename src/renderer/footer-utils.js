// ====================================
// Footer Update Logic - Shared Module
// ====================================
// This module provides footer initialization and update logic
// that can be used across all pages in the main window

// The EVE clock is the only remaining timer: it is local Date arithmetic with
// no IPC, so it costs nothing per window. Server and ESI status are both
// event-driven now - main fetches, footers listen.
let footerUpdateIntervals = {
  clock: null,
};

// Unsubscribe functions for the data-change subscriptions that replaced the
// old polls. Guarded so re-initialising the footer does not stack them.
let footerDisposers = {
  status: null,
  esiStatus: null,
};

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

  // Update pulse dot
  const pulseDot = document.getElementById('server-pulse-dot');
  if (pulseDot) {
    pulseDot.className = 'pulse-dot';
    if (serverStatus === 'online') pulseDot.classList.add('online');
    else if (serverStatus === 'restarting') pulseDot.classList.add('warning');
    else pulseDot.classList.add('error');
  }

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
/**
 * Redraw the server-status footer item from STORED data.
 *
 * Read-only by design: this never triggers an ESI call. The background
 * refresh cycle owns fetching, and this runs when it reports one landed.
 * Every window calling status.fetch() was the multi-window waste being fixed.
 */
async function updateServerStatus() {
  try {
    const stored = await window.electronAPI.status.getCached();

    if (!stored) {
      // Nothing fetched yet - the first cycle has not run. Leave the loading
      // state rather than claiming an error the user cannot act on.
      return;
    }

    const ageSeconds = stored.lastUpdated
      ? Math.max(0, Math.floor((Date.now() - stored.lastUpdated) / 1000))
      : 0;

    // getCachedServerStatus returns vip but not the derived label the display
    // expects, so derive it the same way fetchServerStatus does.
    updateServerStatusDisplay(
      { ...stored, serverStatus: stored.vip ? 'restarting' : 'online' },
      false,
      ageSeconds
    );
  } catch (error) {
    console.error('[Footer] Error updating server status:', error);
  }
}

/**
 * Start server status polling (every 1 minute)
 */
function startServerStatusPolling() {
  // Not a poll any more. The footer is a pure CONSUMER: the background refresh
  // cycle owns the fetch (GLOBAL_TASKS in esi-background-refresh.js) and this
  // just redraws when it lands.
  //
  // Previously every window ran its own 5-minute timer, each triggering a real
  // ESI fetch - so N windows meant N fetch cycles, and closing the last window
  // stopped server status updating at all. Main now fetches once regardless of
  // how many windows are open.
  const api = window.electronAPI && window.electronAPI.data;
  if (api && api.onChanged && !footerDisposers.status) {
    footerDisposers.status = api.onChanged((info) => {
      if (info && info.endpointType === 'server_status') updateServerStatus();
    });
  }

  // One read at startup so a newly-opened window shows the stored value
  // immediately rather than waiting for the next cycle.
  updateServerStatus();
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

      const esiPulseDot = document.getElementById('esi-pulse-dot');

      if (status.overall === 'green') {
        iconElement.classList.add('status-online');
        textElement.textContent = 'ESI: OK';
        statusItem.title = `ESI Status: All systems operational (${status.totalCount} calls tracked)`;
        if (esiPulseDot) { esiPulseDot.className = 'pulse-dot online'; }
      } else if (status.overall === 'yellow') {
        iconElement.classList.add('status-warning');
        textElement.textContent = 'ESI: Warning';
        statusItem.title = `ESI Status: ${status.warningCount} calls need attention, ${status.inProgressCount || 0} in progress`;
        if (esiPulseDot) { esiPulseDot.className = 'pulse-dot warning'; }
      } else {
        iconElement.classList.add('status-error');
        textElement.textContent = 'ESI: Error';
        statusItem.title = `ESI Status: ${status.errorCount} calls failed`;
        if (esiPulseDot) { esiPulseDot.className = 'pulse-dot error'; }
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
  // No interval at all. getAggregated() is a pure read of esi_call_status,
  // and every ESI call both writes that table and emits esi:data-changed - so
  // a timer could only ever re-read rows the event already prompted.
  const api = window.electronAPI && window.electronAPI.data;
  if (api && api.onChanged && !footerDisposers.esiStatus) {
    footerDisposers.esiStatus = api.onChanged(() => updateESIStatus());
  }

  // One read at startup, for the state accumulated before this window opened.
  updateESIStatus();
}

/**
 * Cleanup footer intervals (call when window unloads)
 */
function cleanupFooter() {
  if (footerUpdateIntervals.clock) {
    clearInterval(footerUpdateIntervals.clock);
    footerUpdateIntervals.clock = null;
  }

  // Release the data-change subscriptions too, or they outlive the footer.
  Object.keys(footerDisposers).forEach((key) => {
    if (footerDisposers[key]) {
      try { footerDisposers[key](); } catch (_) { /* already gone */ }
      footerDisposers[key] = null;
    }
  });
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
