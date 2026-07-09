const { getMarketDatabase, clearPriceCache } = require('./market-database');
const { getUserAgent } = require('./user-agent');
const { esiFetch } = require('./esi-fetch');
// NOTE: retryFetch (below) is retained ONLY for the authenticated structure-market
// helpers (searchStructures / fetchStructureMarketOrders), which are not tracked
// ESI status endpoints. The 3 tracked market endpoints (orders/history/adjusted)
// route through esiFetch.

/**
 * Retry a fetch operation with exponential backoff
 * @param {Function} fetchFn - Async function that performs the fetch
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} initialDelay - Initial delay in milliseconds (default: 1000)
 * @returns {Promise<Response>} Fetch response
 */
async function retryFetch(fetchFn, maxRetries = 3, initialDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn();
      return response;
    } catch (error) {
      lastError = error;

      // Don't retry if error is marked as non-retryable (e.g., 400/404 errors)
      if (error.noRetry) {
        throw error;
      }

      // Don't retry if it's the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Calculate exponential backoff delay
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(`Fetch attempt ${attempt + 1} failed: ${error.message}. Retrying in ${delay}ms...`);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // If we get here, all retries failed
  throw new Error(`Failed after ${maxRetries + 1} attempts: ${lastError.message}`);
}

/**
 * Check if we can fetch from ESI (rate limiting)
 * @param {string} key - Cache key
 * @param {number} minInterval - Minimum interval in milliseconds
 * @returns {boolean} Can fetch
 */
function canFetch(key, minInterval) {
  const db = getMarketDatabase();
  const metadata = db.prepare('SELECT last_fetch, expires_at FROM fetch_metadata WHERE key = ?').get(key);

  if (!metadata) {
    return true;
  }

  const now = Date.now();

  // If we have an expires_at, use that
  if (metadata.expires_at && now < metadata.expires_at) {
    return false;
  }

  // Otherwise check minimum interval
  if (now - metadata.last_fetch < minInterval) {
    return false;
  }

  return true;
}

/**
 * Update fetch metadata
 * @param {string} key - Cache key
 * @param {number} expiresAt - Expiry timestamp (optional)
 */
function updateFetchMetadata(key, expiresAt = null) {
  const db = getMarketDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO fetch_metadata (key, last_fetch, expires_at)
    VALUES (?, ?, ?)
  `).run(key, Date.now(), expiresAt);
}

/**
 * Get cache expiry from ESI response headers
 * @param {Response} response - Fetch response
 * @returns {number|null} Expiry timestamp
 */
function getCacheExpiry(response) {
  const expiresHeader = response.headers.get('expires');
  if (expiresHeader) {
    const expiresDate = new Date(expiresHeader);
    return expiresDate.getTime();
  }
  return null;
}

/**
 * Fetch market orders for a type in a region from ESI
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID (optional, fetches all if not provided)
 * @param {Object} locationFilter - Location filter (optional)
 * @param {boolean} forceRefresh - Force fetch from ESI instead of cache
 * @returns {Promise<Array>} Market orders
 */
async function fetchMarketOrders(regionId, typeId = null, locationFilter = null, forceRefresh = false) {
  // Always return cached data unless forceRefresh is true
  if (!forceRefresh) {
    console.log(`Returning cached market orders for region ${regionId} type ${typeId}`);
    return getCachedMarketOrders(regionId, typeId, locationFilter);
  }

  const cacheKey = `market_orders_${regionId}_${typeId || 'all'}`;
  const minInterval = 30 * 60 * 1000; // 30 minutes

  if (!canFetch(cacheKey, minInterval)) {
    console.log(`Market orders for region ${regionId} type ${typeId} recently fetched, using cache`);
    return getCachedMarketOrders(regionId, typeId, locationFilter);
  }

  const callKey = `universe_market_orders_${regionId}`;

  try {
    const baseUrl = typeId
      ? `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`
      : `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility`;

    console.log(`Fetching market orders from ESI: ${baseUrl}`);

    // This module keeps its own canFetch/fetch_metadata gate, so bypass esiFetch's
    // per-endpoint gate. esiFetch handles retry, rate-limit headers, 429/420,
    // parallel pagination, per-page progress events, status recording, and treats
    // 400/404 as an expected-empty result (item not on market).
    const result = await esiFetch('market_orders', callKey, baseUrl, {
      requiresAuth: false,
      category: 'universe',
      endpointLabel: 'Market Orders',
      skipGate: true,
      parallelPages: true,
      emptyStatuses: [400, 404],
      onProgress: (p) => {
        const { BrowserWindow } = require('electron');
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
          mainWindow.webContents.send('market:fetchProgress', p);
        }
      },
    });

    // 400/404 → item not available in market (expected for T2 BPs, etc.).
    if (result.empty) {
      console.log(`Item ${typeId} not available in market (expected for T2 Blueprints, etc.) - using fallback pricing`);
      return [];
    }

    const allOrders = result.data || [];
    console.log(`Fetched ${allOrders.length} total market orders for region ${regionId}`);

    // Store in database
    storeMarketOrders(allOrders, regionId);

    // Update fetch metadata
    updateFetchMetadata(cacheKey, result.cacheExpiresAt);

    // Apply location filter to fetched orders before returning
    if (locationFilter) {
      if (locationFilter.stationId) {
        return allOrders.filter(o => o.location_id === locationFilter.stationId);
      } else if (locationFilter.systemId) {
        return allOrders.filter(o => o.system_id === locationFilter.systemId);
      }
    }

    return allOrders;
  } catch (error) {
    console.error('Error fetching market orders:', error);
    // Return cached data on error
    return getCachedMarketOrders(regionId, typeId, locationFilter);
  }
}

/**
 * Store market orders in database
 * @param {Array} orders - Market orders
 * @param {number} regionId - Region ID
 */
function storeMarketOrders(orders, regionId) {
  const db = getMarketDatabase();
  const fetchedAt = Date.now();

  // Clear old orders for this region
  db.prepare('DELETE FROM market_orders WHERE region_id = ?').run(regionId);

  const insert = db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, location_id, region_id, system_id,
      is_buy_order, price, volume_remain, volume_total,
      min_volume, duration, issued, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((orders) => {
    for (const order of orders) {
      insert.run(
        order.order_id,
        order.type_id,
        order.location_id,
        regionId,
        order.system_id || null,
        order.is_buy_order ? 1 : 0,
        order.price,
        order.volume_remain,
        order.volume_total,
        order.min_volume || null,
        order.duration,
        order.issued,
        fetchedAt
      );
    }
  });

  insertMany(orders);
  console.log(`Stored ${orders.length} market orders in database`);

  // Clear price cache for this region since we have fresh data
  clearPriceCache(regionId);
  console.log(`[ESI Market] Cleared price cache for region ${regionId} after storing ${orders.length} orders`);
}

/**
 * Get cached market orders from database
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID (optional)
 * @param {Object} locationFilter - Location filter (optional)
 * @returns {Array} Market orders
 */
function getCachedMarketOrders(regionId, typeId = null, locationFilter = null) {
  const db = getMarketDatabase();

  let query = 'SELECT * FROM market_orders WHERE region_id = ?';
  const params = [regionId];

  if (typeId) {
    query += ' AND type_id = ?';
    params.push(typeId);
  }

  // Apply location filter
  if (locationFilter) {
    if (locationFilter.stationId) {
      query += ' AND location_id = ?';
      params.push(locationFilter.stationId);
    } else if (locationFilter.systemId) {
      query += ' AND system_id = ?';
      params.push(locationFilter.systemId);
    }
    // If only regionId is specified, we already filter by region above
  }

  const orders = db.prepare(query).all(...params);

  return orders.map(order => ({
    order_id: order.order_id,
    type_id: order.type_id,
    location_id: order.location_id,
    region_id: order.region_id,
    system_id: order.system_id,
    is_buy_order: order.is_buy_order === 1,
    price: order.price,
    volume_remain: order.volume_remain,
    volume_total: order.volume_total,
    min_volume: order.min_volume,
    duration: order.duration,
    issued: order.issued,
  }));
}

/**
 * Check if market history data is stale (not fetched since today's 11:05 UTC)
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 * @returns {boolean} True if data is stale and should be refreshed
 */
function isHistoryStale(regionId, typeId) {
  // Validate typeId
  if (!typeId || typeId === 0 || isNaN(typeId)) {
    console.error(`[isHistoryStale] Invalid typeId: ${typeId}`);
    return false; // Return false so we don't try to fetch
  }

  const db = getMarketDatabase();

  // Get most recent fetch timestamp for this item
  const result = db.prepare(`
    SELECT MAX(fetched_at) as last_fetched
    FROM market_history
    WHERE region_id = ? AND type_id = ?
  `).get(regionId, typeId);

  if (!result || !result.last_fetched) {
    // No history data exists - it's stale
    console.log(`[isHistoryStale] No cached data for typeId ${typeId} - will fetch`);
    return true;
  }

  const lastFetchedTime = new Date(result.last_fetched);

  // Calculate today's 11:05 UTC cutoff
  const now = new Date();
  const todayUpdate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    11, // 11:05 UTC
    5,
    0
  ));

  // If current time is before today's update, use yesterday's update time
  const cutoffTime = now >= todayUpdate ? todayUpdate : new Date(todayUpdate.getTime() - 86400000);

  // Data is stale if it was fetched before the cutoff
  const isStale = lastFetchedTime < cutoffTime;

  if (isStale) {
    console.log(`[isHistoryStale] Data stale for typeId ${typeId} - last fetched: ${lastFetchedTime.toISOString()}, cutoff: ${cutoffTime.toISOString()}`);
  }

  return isStale;
}

/**
 * Fetch market history from ESI (actual HTTP request)
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 * @returns {Promise<Array>} Market history
 */
async function fetchHistoryFromESI(regionId, typeId) {
  const callKey = `universe_market_history_${regionId}`;

  try {
    const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;

    console.log(`Fetching market history from ESI: ${url}`);

    // Own cache gate lives in fetchMarketHistory; skip esiFetch's gate here.
    // 400/404 → item not on market (expected-empty).
    const result = await esiFetch('market_history', callKey, url, {
      requiresAuth: false,
      category: 'universe',
      endpointLabel: 'Market History',
      skipGate: true,
      emptyStatuses: [400, 404],
    });

    if (result.empty) {
      console.log(`Item ${typeId} not available in market - returning empty array`);
      return [];
    }

    const history = result.data || [];
    console.log(`Fetched ${history.length} days of market history for type ${typeId} in region ${regionId}`);

    // Store in database
    storeMarketHistory(history, regionId, typeId);

    // Update fetch metadata
    const cacheKey = `market_history_${regionId}_${typeId}`;
    updateFetchMetadata(cacheKey, result.cacheExpiresAt);

    return history;
  } catch (error) {
    console.error('Error fetching market history:', error);
    // Return cached data on error
    return getCachedMarketHistory(regionId, typeId);
  }
}

/**
 * Fetch market history for a type in a region from ESI
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 * @param {boolean} forceRefresh - Force fetch from ESI instead of cache
 * @returns {Promise<Array>} Market history
 */
async function fetchMarketHistory(regionId, typeId, forceRefresh = false) {
  // Validate typeId
  if (!typeId || typeId === 0 || isNaN(typeId)) {
    console.error(`[fetchMarketHistory] Invalid typeId: ${typeId}. Stack trace:`, new Error().stack);
    return [];
  }

  // Manual refresh - always fetch from ESI
  if (forceRefresh) {
    console.log(`Manual refresh: Fetching market history from ESI for type ${typeId}`);
    return await fetchHistoryFromESI(regionId, typeId);
  }

  // Auto-refresh check: is data stale (before today's 11:05 UTC)?
  const stale = isHistoryStale(regionId, typeId);

  if (stale) {
    console.log(`Market history stale for type ${typeId} (before 11:05 UTC cutoff), auto-fetching from ESI`);
    return await fetchHistoryFromESI(regionId, typeId);
  }

  // Data is fresh, return cached
  console.log(`Returning fresh cached market history for type ${typeId}`);
  return getCachedMarketHistory(regionId, typeId);
}

/**
 * Store market history in database
 * @param {Array} history - Market history
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 */
function storeMarketHistory(history, regionId, typeId) {
  const db = getMarketDatabase();
  const fetchedAt = Date.now();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO market_history (
      type_id, region_id, date, average, highest, lowest,
      order_count, volume, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((history) => {
    for (const day of history) {
      insert.run(
        typeId,
        regionId,
        day.date,
        day.average,
        day.highest,
        day.lowest,
        day.order_count,
        day.volume,
        fetchedAt
      );
    }
  });

  insertMany(history);
  console.log(`Stored ${history.length} days of market history in database`);

  // Clear price cache for this type since we have fresh data
  clearPriceCache(regionId, typeId);
  console.log(`[ESI Market] Cleared price cache for typeId ${typeId} in region ${regionId} after storing history`);
}

/**
 * Check if we have fresh cached history data (less than 24 hours old)
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 * @returns {boolean} True if we have fresh cached data
 */
function hasFreshHistoryCache(regionId, typeId) {
  const db = getMarketDatabase();

  const result = db.prepare(`
    SELECT MAX(fetched_at) as last_fetch FROM market_history
    WHERE region_id = ? AND type_id = ?
  `).get(regionId, typeId);

  if (!result || !result.last_fetch) {
    return false;
  }

  const now = Date.now();
  const cacheAge = now - result.last_fetch;
  const oneDayInMs = 24 * 60 * 60 * 1000; // 24 hours

  return cacheAge < oneDayInMs;
}

/**
 * Get cached market history from database
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 * @param {number} days - Number of days to retrieve (default: all)
 * @returns {Array} Market history
 */
function getCachedMarketHistory(regionId, typeId, days = null) {
  const db = getMarketDatabase();

  let query = `
    SELECT * FROM market_history
    WHERE region_id = ? AND type_id = ?
    ORDER BY date DESC
  `;

  if (days) {
    query += ` LIMIT ${days}`;
  }

  const history = db.prepare(query).all(regionId, typeId);

  return history.map(day => ({
    date: day.date,
    average: day.average,
    highest: day.highest,
    lowest: day.lowest,
    order_count: day.order_count,
    volume: day.volume,
  })).reverse(); // Return in chronological order
}

/**
 * Fetch all market data for a type (orders + history)
 * @param {number} regionId - Region ID
 * @param {number} typeId - Type ID
 * @returns {Promise<Object>} Market data with orders and history
 */
async function fetchMarketData(regionId, typeId) {
  const [orders, history] = await Promise.all([
    fetchMarketOrders(regionId, typeId),
    fetchMarketHistory(regionId, typeId),
  ]);

  return {
    orders,
    history,
    typeId,
    regionId,
    fetchedAt: Date.now(),
  };
}

/**
 * Get the last fetch time across all market data
 * @returns {number|null} Timestamp of last fetch, or null if never fetched
 */
function getLastMarketFetchTime() {
  const db = getMarketDatabase();
  const result = db.prepare('SELECT MAX(last_fetch) as last_fetch FROM fetch_metadata WHERE key LIKE ?').get('market_orders_%');
  return result?.last_fetch || null;
}

/**
 * Get the last fetch time for a specific region's market data
 * @param {number} regionId - Region ID
 * @returns {number|null} Timestamp of last fetch, or null if never fetched
 */
function getLastMarketFetchTimeForRegion(regionId) {
  const db = getMarketDatabase();
  const cacheKey = `market_orders_${regionId}_all`;
  const result = db.prepare('SELECT last_fetch FROM fetch_metadata WHERE key = ?').get(cacheKey);
  return result?.last_fetch || null;
}

/**
 * Get the last fetch time for a specific private structure's market data
 * @param {number} structureId - Structure ID
 * @returns {number|null} Timestamp of last fetch, or null if never fetched
 */
function getLastStructureMarketFetchTime(structureId) {
  const db = getMarketDatabase();
  const cacheKey = `market_orders_structure_${structureId}`;
  const result = db.prepare('SELECT last_fetch FROM fetch_metadata WHERE key = ?').get(cacheKey);
  return result?.last_fetch || null;
}

/**
 * Get the last history fetch time
 * @returns {number|null} Timestamp of last history fetch, or null if never fetched
 */
function getLastHistoryFetchTime() {
  const db = getMarketDatabase();
  const result = db.prepare('SELECT MAX(last_fetch) as last_fetch FROM fetch_metadata WHERE key LIKE ?').get('market_history_%');
  return result?.last_fetch || null;
}

/**
 * Get all unique type IDs from market orders
 * @param {number} regionId - Region ID
 * @returns {Array<number>} Array of type IDs
 */
function getAllMarketTypeIds(regionId) {
  const db = getMarketDatabase();
  const rows = db.prepare('SELECT DISTINCT type_id FROM market_orders WHERE region_id = ?').all(regionId);
  return rows.map(row => row.type_id);
}

/**
 * Get history data status - count of up-to-date vs total items
 * @param {number} regionId - Region ID
 * @returns {Object} Object with upToDate and total counts
 */
function getHistoryDataStatus(regionId) {
  const db = getMarketDatabase();

  // Get total unique type IDs from market orders (items that could have history)
  const totalResult = db.prepare(`
    SELECT COUNT(DISTINCT type_id) as total FROM market_orders
    WHERE region_id = ?
  `).get(regionId);

  const total = totalResult?.total || 0;

  // Get count of items with fresh history (less than 24 hours old)
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const upToDateResult = db.prepare(`
    SELECT COUNT(DISTINCT type_id) as count FROM market_history
    WHERE region_id = ? AND fetched_at > ?
  `).get(regionId, oneDayAgo);

  const upToDate = upToDateResult?.count || 0;

  return {
    upToDate,
    total
  };
}

/**
 * Manually refresh all market data for a specific region
 * Uses per-region rate limiting (30 minutes between refreshes per region)
 * @param {number} regionId - Region ID to refresh
 * @returns {Promise<Object>} Refresh status
 */
async function manualRefreshMarketData(regionId) {
  const lastFetch = getLastMarketFetchTimeForRegion(regionId);
  const now = Date.now();
  const minInterval = 30 * 60 * 1000; // 30 minutes

  // Check if we can refresh this specific region
  if (lastFetch && (now - lastFetch) < minInterval) {
    const remainingTime = Math.ceil((minInterval - (now - lastFetch)) / 60000);
    return {
      success: false,
      rateLimited: true,
      message: `Region ${regionId}: Using cached data (${remainingTime} min until refresh available)`,
      lastFetch: lastFetch
    };
  }

  try {
    console.log(`Manual refresh: Fetching all market orders for region ${regionId}`);

    // Fetch all market orders for the region (force refresh)
    await fetchMarketOrders(regionId, null, null, true);

    // Additional cache clear to ensure fresh calculations
    // (storeMarketOrders already clears, but this ensures it happens)
    clearPriceCache(regionId);

    return {
      success: true,
      lastFetch: Date.now(),
      message: `Region ${regionId} market data updated successfully`
    };
  } catch (error) {
    console.error('Error refreshing market data:', error);
    return {
      success: false,
      error: error.message,
      isError: true,
      lastFetch: lastFetch
    };
  }
}

/**
 * Manually refresh all history data for items with market data
 * @param {number} regionId - Region ID to refresh
 * @returns {Promise<Object>} Refresh status
 */
async function manualRefreshHistoryData(regionId) {
  const lastFetch = getLastHistoryFetchTime();
  const now = Date.now();
  const minInterval = 30 * 60 * 1000; // 30 minutes

  // Check if we can refresh
  if (lastFetch && (now - lastFetch) < minInterval) {
    const remainingTime = Math.ceil((minInterval - (now - lastFetch)) / 60000);
    return {
      success: false,
      error: `Please wait ${remainingTime} minutes before refreshing history again.`,
      lastFetch: lastFetch
    };
  }

  try {
    console.log(`Manual history refresh: Fetching history for all items in region ${regionId}`);

    // Get all type IDs from market orders
    const typeIds = getAllMarketTypeIds(regionId);
    console.log(`Found ${typeIds.length} unique items to fetch history for`);

    if (typeIds.length === 0) {
      return {
        success: false,
        error: 'No market data available. Please update market data first.',
        lastFetch: lastFetch
      };
    }

    const { BrowserWindow } = require('electron');
    const mainWindow = BrowserWindow.getAllWindows()[0];

    // Fetch history for each type ID
    let completed = 0;
    for (const typeId of typeIds) {
      await fetchMarketHistory(regionId, typeId, true);
      completed++;

      // Send progress update
      if (mainWindow) {
        mainWindow.webContents.send('market:historyProgress', {
          currentItem: completed,
          totalItems: typeIds.length,
          progress: (completed / typeIds.length) * 100
        });
      }

      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Additional cache clear for the entire region to ensure fresh calculations
    // (storeMarketHistory already clears per-type, but this ensures full refresh)
    clearPriceCache(regionId);

    return {
      success: true,
      lastFetch: Date.now(),
      message: `History data updated for ${typeIds.length} items`,
      itemsUpdated: typeIds.length
    };
  } catch (error) {
    console.error('Error refreshing history data:', error);
    return {
      success: false,
      error: error.message,
      lastFetch: lastFetch
    };
  }
}

/**
 * Fetch adjusted prices from ESI
 * @returns {Promise<Array>} Array of price objects
 */
async function fetchAdjustedPrices() {
  const callKey = 'universe_adjusted_prices';

  console.log('Fetching adjusted prices from ESI...');

  // No own cache gate here — caller (manualRefreshAdjustedPrices) controls cadence.
  // Keep skipGate:true to preserve today's always-fetch-on-call behavior.
  const result = await esiFetch('adjusted_prices', callKey, 'https://esi.evetech.net/latest/markets/prices/?datasource=tranquility', {
    requiresAuth: false,
    category: 'universe',
    endpointLabel: 'Adjusted Prices',
    skipGate: true,
  });

  const prices = result.data || [];
  console.log(`Fetched ${prices.length} adjusted prices from ESI`);

  return prices;
}

/**
 * Manually refresh adjusted prices
 * @returns {Promise<Object>} Status object
 */
async function manualRefreshAdjustedPrices() {
  try {
    console.log('Starting manual refresh of adjusted prices...');

    const { clearAdjustedPrices, saveAdjustedPrices } = require('./market-database');

    // Clear existing prices
    clearAdjustedPrices();

    // Fetch new prices
    const prices = await fetchAdjustedPrices();

    // Save to database
    saveAdjustedPrices(prices);

    return {
      success: true,
      lastFetch: Date.now(),
      message: `Adjusted prices updated for ${prices.length} items`,
      itemsUpdated: prices.length
    };
  } catch (error) {
    console.error('Error refreshing adjusted prices:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Refresh market data for multiple regions (deduplicates region IDs)
 * Each region has its own 30-minute rate limit
 * @param {Array<number>} regionIds - Array of region IDs to refresh
 * @returns {Promise<Object>} Combined refresh status
 */
async function refreshMultipleRegions(regionIds) {
  // Deduplicate region IDs
  const uniqueRegionIds = [...new Set(regionIds.filter(id => id && !isNaN(id)))];

  console.log(`[Market] Refreshing ${uniqueRegionIds.length} unique regions:`, uniqueRegionIds);

  const results = [];

  for (const regionId of uniqueRegionIds) {
    try {
      const result = await manualRefreshMarketData(regionId);
      results.push({ regionId, ...result });
    } catch (error) {
      console.error(`Error refreshing region ${regionId}:`, error);
      results.push({ regionId, success: false, error: error.message, isError: true });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const rateLimitedCount = results.filter(r => r.rateLimited).length;
  const errorCount = results.filter(r => r.isError).length;

  // Only report as failed if there were actual errors (not just rate-limited)
  const hasErrors = errorCount > 0;

  let message;
  if (errorCount > 0) {
    message = `Refreshed ${successCount}/${uniqueRegionIds.length} regions (${errorCount} error(s))`;
  } else if (rateLimitedCount > 0) {
    message = successCount > 0
      ? `Refreshed ${successCount} region(s), ${rateLimitedCount} using cached data`
      : `All ${rateLimitedCount} region(s) using cached data`;
  } else {
    message = `Successfully refreshed ${successCount} region(s)`;
  }

  return {
    success: !hasErrors,
    results,
    message,
    refreshedCount: successCount,
    rateLimitedCount,
    errorCount,
  };
}

/**
 * Search for player-owned structures by name using ESI character search.
 * Requires 'esi-search.search_structures.v1' and 'esi-universe.read_structures.v1' scopes.
 * @param {number} characterId - Character ID to authenticate with
 * @param {string} accessToken - Valid ESI access token
 * @param {string} searchTerm - Structure name search term (min 3 chars)
 * @returns {Promise<Array>} Array of { structureId, structureName, solarSystemId, regionId, typeId }
 */
async function searchStructures(characterId, accessToken, searchTerm) {
  const Database = require('better-sqlite3');
  const { getSdePath } = require('./sde-manager');

  // Search for structures using character-authenticated ESI endpoint
  const searchUrl = `https://esi.evetech.net/latest/characters/${characterId}/search/?categories=structure&search=${encodeURIComponent(searchTerm)}&datasource=tranquility&strict=false`;

  const searchResponse = await retryFetch(async () => {
    const res = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': getUserAgent(),
      },
    });
    if (!res.ok) {
      const error = new Error(`Structure search failed: ${res.status} ${res.statusText}`);
      if (res.status === 403 || res.status === 401) error.noRetry = true;
      throw error;
    }
    return res;
  });

  const searchData = await searchResponse.json();
  const structureIds = searchData.structure || [];

  if (structureIds.length === 0) {
    return [];
  }

  // Fetch details for each structure (cap at 20 results)
  const limitedIds = structureIds.slice(0, 20);
  const sdePath = getSdePath();
  const sdeDb = sdePath ? new Database(sdePath, { readonly: true }) : null;

  const results = [];

  for (const structureId of limitedIds) {
    try {
      const structureUrl = `https://esi.evetech.net/latest/universe/structures/${structureId}/?datasource=tranquility`;
      const structureResponse = await retryFetch(async () => {
        const res = await fetch(structureUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': getUserAgent(),
          },
        });
        if (!res.ok) {
          const error = new Error(`Failed to get structure ${structureId}: ${res.status}`);
          if (res.status === 403) error.noRetry = true; // No access to this structure
          throw error;
        }
        return res;
      });

      const structureData = await structureResponse.json();
      const solarSystemId = structureData.solar_system_id;

      // Look up region ID from SDE
      let regionId = null;
      if (sdeDb && solarSystemId) {
        const row = sdeDb.prepare('SELECT regionID FROM mapSolarSystems WHERE solarSystemID = ?').get(solarSystemId);
        regionId = row?.regionID ?? null;
      }

      results.push({
        structureId,
        structureName: structureData.name,
        solarSystemId,
        regionId,
        typeId: structureData.type_id,
      });
    } catch (err) {
      // Skip structures we can't access (e.g. 403 Forbidden)
      console.log(`[searchStructures] Skipping structure ${structureId}: ${err.message}`);
    }
  }

  if (sdeDb) sdeDb.close();

  return results;
}

/**
 * Fetch market orders from a private player-owned structure via authenticated ESI.
 * Requires 'esi-markets.structure_markets.v1' scope.
 * @param {number} structureId - Structure ID (large integer)
 * @param {number} regionId - Real EVE region ID (from SDE mapSolarSystems)
 * @param {string} accessToken - Valid ESI access token
 * @param {boolean} forceRefresh - Force fetch regardless of rate limit
 * @returns {Promise<Array>} Fetched orders
 */
async function fetchStructureMarketOrders(structureId, regionId, accessToken, forceRefresh = false) {
  const cacheKey = `market_orders_structure_${structureId}`;
  const minInterval = 30 * 60 * 1000; // 30 minutes

  if (!forceRefresh && !canFetch(cacheKey, minInterval)) {
    console.log(`[Structure Market] Structure ${structureId} recently fetched, using cache`);
    return getCachedMarketOrders(regionId, null, { stationId: structureId });
  }

  console.log(`[Structure Market] Fetching orders for structure ${structureId} (region ${regionId})`);

  try {
    const baseUrl = `https://esi.evetech.net/latest/markets/structures/${structureId}/?datasource=tranquility`;

    const firstResponse = await retryFetch(async () => {
      const res = await fetch(`${baseUrl}&page=1`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': getUserAgent(),
        },
      });
      if (!res.ok) {
        const error = new Error(`Structure market fetch failed: ${res.status} ${res.statusText}`);
        if (res.status === 403 || res.status === 401) error.noRetry = true;
        throw error;
      }
      return res;
    });

    const firstPageOrders = await firstResponse.json();
    const totalPages = parseInt(firstResponse.headers.get('X-Pages') || '1', 10);
    const expiresAt = getCacheExpiry(firstResponse);

    let allOrders = [...firstPageOrders];

    if (totalPages > 1) {
      for (let page = 2; page <= totalPages; page++) {
        try {
          const pageResponse = await retryFetch(async () => {
            const res = await fetch(`${baseUrl}&page=${page}`, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': getUserAgent(),
              },
            });
            if (!res.ok) {
              throw new Error(`Failed to fetch structure market page ${page}: ${res.status}`);
            }
            return res;
          });
          const pageOrders = await pageResponse.json();
          allOrders = allOrders.concat(pageOrders);
          console.log(`[Structure Market] Fetched page ${page}/${totalPages} (${pageOrders.length} orders)`);
        } catch (err) {
          console.error(`[Structure Market] Failed to fetch page ${page}: ${err.message}`);
        }
      }
    }

    console.log(`[Structure Market] Fetched ${allOrders.length} orders for structure ${structureId}`);

    // Store under the structure's real region ID.
    // The location_id on each order will equal the structureId, so price calc
    // can filter with location_id === structureId to isolate structure orders.
    // Do NOT preserve structure orders here — we're replacing THIS structure's orders.
    // We do need to avoid wiping OTHER structures' orders in the same region,
    // so we delete only orders with this specific location_id.
    const db = getMarketDatabase();
    db.prepare('DELETE FROM market_orders WHERE region_id = ? AND location_id = ?').run(regionId, structureId);

    // Re-use the insert logic from storeMarketOrders but without the region-wide delete
    const fetchedAt = Date.now();
    const insert = db.prepare(`
      INSERT INTO market_orders (
        order_id, type_id, location_id, region_id, system_id,
        is_buy_order, price, volume_remain, volume_total,
        min_volume, duration, issued, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((orders) => {
      for (const order of orders) {
        insert.run(
          order.order_id,
          order.type_id,
          order.location_id || structureId,
          regionId,
          order.system_id || null,
          order.is_buy_order ? 1 : 0,
          order.price,
          order.volume_remain,
          order.volume_total,
          order.min_volume || null,
          order.duration,
          order.issued,
          fetchedAt
        );
      }
    });
    insertMany(allOrders);
    console.log(`[Structure Market] Stored ${allOrders.length} orders in database`);

    clearPriceCache(regionId);
    updateFetchMetadata(cacheKey, expiresAt);

    return allOrders;
  } catch (error) {
    console.error(`[Structure Market] Error fetching structure ${structureId}:`, error);
    return getCachedMarketOrders(regionId, null, { stationId: structureId });
  }
}

/**
 * Refresh private-structure market orders for every Market Set location that
 * points at a private structure, scoped to a single region (or all regions
 * if regionId is null). Never throws — per-structure failures (revoked
 * token, missing esi-markets.structure_markets.v1 scope, etc.) are caught
 * and collected so the caller can report them without failing the whole
 * refresh operation.
 * @param {number|null} regionId - Region to scope the refresh to, or null for all regions
 * @param {Array} marketSets - Optional pre-fetched Market Sets (avoids a redundant DB read)
 * @returns {Promise<{refreshed: number[], errors: Array<{structureId: number, structureName: string, message: string}>}>}
 */
async function refreshStructuresInRegion(regionId, marketSets = null) {
  const { getInputLocation, getOutputLocation } = require('./blueprint-pricing');
  const { getMarketSets, getCharacter, updateCharacterTokens } = require('./settings-manager');
  const { isTokenExpired, refreshAccessToken } = require('./esi-auth');

  const sets = marketSets || getMarketSets();
  const structureLocs = [];
  for (const set of sets) {
    [getInputLocation(set), getOutputLocation(set)].forEach(loc => {
      if (
        loc.locationType === 'private_structure' &&
        loc.structureId &&
        loc.characterId &&
        (regionId === null || loc.regionId === regionId)
      ) {
        structureLocs.push(loc);
      }
    });
  }
  const uniqueStructures = [...new Map(structureLocs.map(l => [l.structureId, l])).values()];

  const refreshed = [];
  const errors = [];

  for (const loc of uniqueStructures) {
    try {
      let character = getCharacter(loc.characterId);
      if (!character) {
        errors.push({ structureId: loc.structureId, structureName: loc.structureName, message: 'Character not found' });
        continue;
      }
      if (isTokenExpired(character.expiresAt)) {
        const newTokens = await refreshAccessToken(character.refreshToken);
        updateCharacterTokens(loc.characterId, newTokens);
        character = getCharacter(loc.characterId);
      }
      await fetchStructureMarketOrders(loc.structureId, loc.regionId, character.accessToken, true);
      refreshed.push(loc.structureId);
    } catch (err) {
      console.error(`[Structure Market] Failed to refresh structure ${loc.structureId}:`, err);
      errors.push({ structureId: loc.structureId, structureName: loc.structureName, message: err.message });
    }
  }

  return { refreshed, errors };
}

module.exports = {
  fetchMarketOrders,
  fetchMarketHistory,
  fetchMarketData,
  getCachedMarketOrders,
  getCachedMarketHistory,
  getLastMarketFetchTime,
  getLastMarketFetchTimeForRegion,
  getLastStructureMarketFetchTime,
  getLastHistoryFetchTime,
  getHistoryDataStatus,
  manualRefreshMarketData,
  manualRefreshHistoryData,
  fetchAdjustedPrices,
  manualRefreshAdjustedPrices,
  refreshMultipleRegions,
  searchStructures,
  fetchStructureMarketOrders,
  refreshStructuresInRegion,
};
