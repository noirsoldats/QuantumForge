const { getMarketDatabase } = require('./market-database');
const { esiFetch } = require('./esi-fetch');

const ESI_BASE_URL = 'https://esi.evetech.net/latest';
const CACHE_TTL = 60 * 1000; // 1 minute cache
const CALL_KEY = 'universe_server_status';

/**
 * Fetch Eve server status from ESI
 * @param {boolean} forceRefresh - Force refresh ignoring cache
 * @returns {Promise<Object>} Server status data
 */
async function fetchServerStatus(forceRefresh = false) {
  // Check if we can fetch (rate limiting)
  if (!forceRefresh && !canFetchServerStatus()) {
    console.log('[Server Status] Rate limited, returning cached data');
    // Return cached data instead of error
    const cachedData = getCachedServerStatus();
    if (cachedData) {
      return {
        success: true,
        data: cachedData,
        cached: true,
        message: 'Using cached data (rate limited)'
      };
    }
    // If no cache exists, return error
    return {
      success: false,
      error: 'Rate limited - no cached data available',
    };
  }

  try {
    // This module keeps its own gate (canFetchServerStatus / fetch_metadata),
    // so bypass esiFetch's per-endpoint gate. esiFetch still handles retry,
    // rate-limit headers, 429/420, and status recording.
    const result = await esiFetch('server_status', CALL_KEY, `${ESI_BASE_URL}/status/`, {
      requiresAuth: false,
      category: 'universe',
      endpointLabel: 'Server Status',
      skipGate: true,
    });

    const data = result.data || {};
    const now = Date.now();

    // Determine server status from response
    const serverStatus = data.vip ? 'restarting' : 'online';

    const statusResult = {
      players: data.players,
      serverVersion: data.server_version,
      startTime: data.start_time,
      vip: data.vip,
      serverStatus,
      lastFetch: now,
      success: true,
    };

    // Store server status in database
    const db = getMarketDatabase();
    db.prepare(`
      INSERT OR REPLACE INTO server_status (id, players, server_version, start_time, vip, last_updated)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(data.players, data.server_version, data.start_time, data.vip ? 1 : 0, now);

    // Update fetch metadata for rate limiting
    db.prepare(`
      INSERT OR REPLACE INTO fetch_metadata (key, last_fetch, expires_at)
      VALUES (?, ?, ?)
    `).run('server_status', now, now + CACHE_TTL);

    console.log(`[Server Status] Fetched fresh data from ESI (${data.players} players online)`);
    return statusResult;

  } catch (error) {
    console.error('[ESI Server Status] Error fetching server status:', error);
    return {
      success: false,
      error: error.message,
      lastFetch: getLastServerStatusFetchTime(),
      serverStatus: 'offline',
    };
  }
}

/**
 * Check if we can fetch server status (rate limiting)
 */
function canFetchServerStatus() {
  const db = getMarketDatabase();
  const result = db.prepare('SELECT last_fetch, expires_at FROM fetch_metadata WHERE key = ?')
    .get('server_status');

  if (!result) return true;

  const now = Date.now();
  if (now < result.expires_at) {
    const secondsAgo = Math.floor((now - result.last_fetch) / 1000);
    console.log(`[Server Status] Rate limited (last fetch ${secondsAgo}s ago)`);
    return false;
  }
  return true;
}

/**
 * Get cached server status from database
 * @returns {Object|null} Cached server status or null
 */
function getCachedServerStatus() {
  try {
    const db = getMarketDatabase();

    // Get cached status from database
    const cached = db.prepare(`
      SELECT * FROM server_status
      WHERE id = 1
      LIMIT 1
    `).get();

    if (!cached) {
      return null;
    }

    return {
      players: cached.players,
      serverVersion: cached.server_version,
      startTime: cached.start_time,
      vip: cached.vip === 1,
      lastUpdated: cached.last_updated,
    };
  } catch (error) {
    console.error('[Server Status] Error getting cached status:', error);
    return null;
  }
}

/**
 * Get last fetch timestamp
 */
function getLastServerStatusFetchTime() {
  const db = getMarketDatabase();
  const result = db.prepare('SELECT last_fetch FROM fetch_metadata WHERE key = ?')
    .get('server_status');

  return result ? result.last_fetch : null;
}

module.exports = {
  fetchServerStatus,
  getCachedServerStatus,
  getLastServerStatusFetchTime,
};
