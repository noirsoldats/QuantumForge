const { getUserAgent } = require('./user-agent');
const { getMarketDatabase } = require('./market-database');

const ESI_BASE_URL = 'https://esi.evetech.net/latest';
const CACHE_TTL = 60 * 1000; // 1 minute cache

/**
 * Fetch Eve server status from ESI
 * @param {boolean} forceRefresh - Force refresh ignoring cache
 * @returns {Promise<Object>} Server status data
 */
async function fetchServerStatus(forceRefresh = false) {
  // Check if we can fetch (rate limiting)
  if (!forceRefresh && !canFetchServerStatus()) {
    // Return rate limit message - caller should use last known status
    const lastFetch = getLastServerStatusFetchTime();
    return {
      success: false,
      error: 'Rate limited - using cached data',
      lastFetch,
      cached: true
    };
  }

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
      throw new Error(`Failed to fetch server status: ${response.status} ${response.statusText}`);
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

    // Update fetch metadata for rate limiting
    const db = getMarketDatabase();
    db.prepare(`
      INSERT OR REPLACE INTO fetch_metadata (key, last_fetch, expires_at)
      VALUES (?, ?, ?)
    `).run('server_status', now, now + CACHE_TTL);

    console.log(`[ESI Server Status] Fetched: ${data.players} players online, status: ${serverStatus}`);
    return result;

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
  return now >= result.expires_at;
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
  getLastServerStatusFetchTime,
};
