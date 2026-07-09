const { getMarketDatabase } = require('./market-database');
const { esiFetch } = require('./esi-fetch');

/**
 * Check if we can fetch cost indices (rate limiting - 1 hour cache)
 * @returns {boolean} Can fetch
 */
function canFetchCostIndices() {
  const db = getMarketDatabase();
  const cacheKey = 'cost_indices';
  const minInterval = 60 * 60 * 1000; // 1 hour

  const metadata = db.prepare('SELECT last_fetch FROM fetch_metadata WHERE key = ?').get(cacheKey);

  if (!metadata) {
    return true;
  }

  const now = Date.now();
  if (now - metadata.last_fetch < minInterval) {
    return false;
  }

  return true;
}

/**
 * Update fetch metadata for cost indices
 */
function updateCostIndicesFetchMetadata() {
  const db = getMarketDatabase();
  const cacheKey = 'cost_indices';

  db.prepare(`
    INSERT OR REPLACE INTO fetch_metadata (key, last_fetch, expires_at)
    VALUES (?, ?, ?)
  `).run(cacheKey, Date.now(), null);
}

/**
 * Get the last fetch time for cost indices
 * @returns {number|null} Timestamp of last fetch, or null if never fetched
 */
function getLastCostIndicesFetchTime() {
  const db = getMarketDatabase();
  const result = db.prepare('SELECT last_fetch FROM fetch_metadata WHERE key = ?').get('cost_indices');
  return result?.last_fetch || null;
}

/**
 * Fetch cost indices from ESI for all solar systems
 * @param {boolean} forceRefresh - Force fetch from ESI instead of using rate limit
 * @returns {Promise<Object>} Result object with success status and data
 */
async function fetchCostIndices(forceRefresh = false) {
  // Check rate limit
  if (!forceRefresh && !canFetchCostIndices()) {
    const lastFetch = getLastCostIndicesFetchTime();
    const now = Date.now();
    const remainingTime = Math.ceil((60 * 60 * 1000 - (now - lastFetch)) / 60000);
    return {
      success: false,
      error: `Cost indices are cached for 1 hour. Please wait ${remainingTime} minutes before refreshing again.`,
      lastFetch: lastFetch
    };
  }

  const callKey = 'universe_cost_indices';

  try {
    const url = 'https://esi.evetech.net/latest/industry/systems/?datasource=tranquility';

    console.log('Fetching cost indices from ESI:', url);

    // This module keeps its own 1-hour gate (canFetchCostIndices / fetch_metadata),
    // so bypass esiFetch's per-endpoint gate. esiFetch still handles retry,
    // rate-limit headers, 429/420, and status recording.
    const result = await esiFetch('cost_indices', callKey, url, {
      requiresAuth: false,
      category: 'universe',
      endpointLabel: 'Cost Indices',
      skipGate: true,
    });

    const systemsData = result.data || [];
    console.log(`Fetched cost indices for ${systemsData.length} solar systems`);

    // Store in database
    storeCostIndices(systemsData);

    // Update fetch metadata
    updateCostIndicesFetchMetadata();

    return {
      success: true,
      systemCount: systemsData.length,
      lastFetch: Date.now(),
      message: `Cost indices updated for ${systemsData.length} solar systems`
    };
  } catch (error) {
    console.error('Error fetching cost indices:', error);
    return {
      success: false,
      error: error.message,
      lastFetch: getLastCostIndicesFetchTime()
    };
  }
}

/**
 * Store cost indices in database
 * @param {Array} systemsData - Array of system cost index data from ESI
 */
function storeCostIndices(systemsData) {
  const db = getMarketDatabase();
  const fetchedAt = Date.now();

  // Clear old data
  db.prepare('DELETE FROM cost_indices').run();

  const insert = db.prepare(`
    INSERT INTO cost_indices (solar_system_id, activity, cost_index, fetched_at)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((systemsData) => {
    for (const system of systemsData) {
      const solarSystemId = system.solar_system_id;

      // Each system has an array of cost_indices for different activities
      if (system.cost_indices && Array.isArray(system.cost_indices)) {
        for (const costIndex of system.cost_indices) {
          insert.run(
            solarSystemId,
            costIndex.activity,
            costIndex.cost_index,
            fetchedAt
          );
        }
      }
    }
  });

  insertMany(systemsData);
  console.log(`Stored cost indices for ${systemsData.length} solar systems in database`);
}

/**
 * Get cost indices for a specific solar system
 * @param {number} solarSystemId - Solar system ID
 * @returns {Array} Array of cost indices for the system
 */
function getCostIndices(solarSystemId) {
  const db = getMarketDatabase();

  const indices = db.prepare(`
    SELECT activity, cost_index, fetched_at
    FROM cost_indices
    WHERE solar_system_id = ?
  `).all(solarSystemId);

  return indices.map(index => ({
    activity: index.activity,
    costIndex: index.cost_index,
    fetchedAt: index.fetched_at
  }));
}

/**
 * Get all cost indices for all systems
 * @returns {Array} Array of all cost indices
 */
function getAllCostIndices() {
  const db = getMarketDatabase();

  const indices = db.prepare(`
    SELECT solar_system_id, activity, cost_index, fetched_at
    FROM cost_indices
    ORDER BY solar_system_id, activity
  `).all();

  return indices.map(index => ({
    solarSystemId: index.solar_system_id,
    activity: index.activity,
    costIndex: index.cost_index,
    fetchedAt: index.fetched_at
  }));
}

/**
 * Get count of systems with cost indices
 * @returns {number} Count of systems
 */
function getCostIndicesSystemCount() {
  const db = getMarketDatabase();

  const result = db.prepare(`
    SELECT COUNT(DISTINCT solar_system_id) as count
    FROM cost_indices
  `).get();

  return result?.count || 0;
}

module.exports = {
  fetchCostIndices,
  getCostIndices,
  getAllCostIndices,
  getLastCostIndicesFetchTime,
  getCostIndicesSystemCount,
};
