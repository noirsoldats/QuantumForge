const { getUserAgent } = require('./user-agent');
const { getMarketDatabase } = require('./market-database');
const { recordESICallStart, recordESICallSuccess, recordESICallError } = require('./esi-status-tracker');

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

  // Record call start
  recordESICallStart(CALL_KEY, {
    category: 'universe',
    characterId: null,
    endpointType: 'server_status',
    endpointLabel: 'Server Status'
  });

  const startTime = Date.now();

  try {
    // Fetch from ESI with retry logic
    const response = await retryFetch(
      () => fetch(`${ESI_BASE_URL}/status/`, {
        headers: {
          'User-Agent': getUserAgent(),
        },
      }),
      3,
      1000
    );

    if (!response.ok) {
      const errorMsg = `Failed to fetch server status: ${response.status} ${response.statusText}`;
      recordESICallError(CALL_KEY, errorMsg, response.status.toString(), startTime);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const now = Date.now();

    // Determine server status from response
    const serverStatus = data.vip ? 'restarting' : 'online';

    const result = {
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

    // Record success
    const responseSize = JSON.stringify(data).length;
    recordESICallSuccess(CALL_KEY, now + CACHE_TTL, null, responseSize, startTime);

    console.log(`[Server Status] Fetched fresh data from ESI (${data.players} players online)`);
    return result;

  } catch (error) {
    console.error('[ESI Server Status] Error fetching server status:', error);
    recordESICallError(CALL_KEY, error.message, 'NETWORK_ERROR', startTime);
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

/**
 * Retry helper with exponential backoff
 */
async function retryFetch(fetchFn, maxRetries = 3, initialDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetchFn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.log(`[ESI Server Status] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

module.exports = {
  fetchServerStatus,
  getCachedServerStatus,
  getLastServerStatusFetchTime,
};
