const { getMarketDatabase, clearPriceCache } = require('./market-database');
const { getUserAgent } = require('./user-agent');

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

  try {
    const baseUrl = typeId
      ? `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`
      : `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility`;

    console.log(`Fetching market orders from ESI: ${baseUrl}`);

    // Fetch first page to check for pagination (with retry logic)
    const firstResponse = await retryFetch(async () => {
      const response = await fetch(`${baseUrl}&page=1`, {
        headers: {
          'User-Agent': getUserAgent(),
        },
      });

      if (!response.ok) {
        // Don't retry on 400 errors - item doesn't exist in market
        if (response.status === 400 || response.status === 404) {
          const error = new Error(`Item not available in market: ${response.status} ${response.statusText}`);
          error.noRetry = true;
          throw error;
        }
        throw new Error(`Failed to fetch market orders: ${response.status} ${response.statusText}`);
      }

      return response;
    });

    const firstPageOrders = await firstResponse.json();
    const expiresAt = getCacheExpiry(firstResponse);

    // Check for pagination
    const totalPages = parseInt(firstResponse.headers.get('X-Pages') || '1', 10);
    console.log(`Total pages for region ${regionId}: ${totalPages}`);

    let allOrders = [...firstPageOrders];

    // Fetch remaining pages if there are multiple pages
    if (totalPages > 1) {
      const pagePromises = [];

      for (let page = 2; page <= totalPages; page++) {
        pagePromises.push(
          retryFetch(async () => {
            const response = await fetch(`${baseUrl}&page=${page}`, {
              headers: {
                'User-Agent': getUserAgent(),
              },
            });

            if (!response.ok) {
              // Don't retry on 400 errors - item doesn't exist in market
              if (response.status === 400 || response.status === 404) {
                const error = new Error(`Item not available in market: ${response.status} ${response.statusText}`);
                error.noRetry = true;
                throw error;
              }
              throw new Error(`Failed to fetch page ${page}: ${response.status} ${response.statusText}`);
            }

            return response;
          }).then(async (response) => {
            const pageOrders = await response.json();
            console.log(`Fetched page ${page}/${totalPages} (${pageOrders.length} orders)`);

            // Send progress update
            const { BrowserWindow } = require('electron');
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (mainWindow) {
              mainWindow.webContents.send('market:fetchProgress', {
                currentPage: page,
                totalPages: totalPages,
                progress: (page / totalPages) * 100
              });
            }

            return pageOrders;
          }).catch((error) => {
            console.error(`Failed to fetch page ${page} after retries: ${error.message}`);
            return [];
          })
        );
      }

      // Wait for all pages to complete
      const remainingPages = await Promise.all(pagePromises);
      remainingPages.forEach(pageOrders => {
        allOrders = allOrders.concat(pageOrders);
      });
    }

    console.log(`Fetched ${allOrders.length} total market orders for region ${regionId}`);

    // Store in database
    storeMarketOrders(allOrders, regionId);

    // Update fetch metadata
    updateFetchMetadata(cacheKey, expiresAt);

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
    // Special handling for items not available in market (T2 Blueprints, etc.)
    if (error.noRetry) {
      console.log(`Item ${typeId} not available in market (expected for T2 Blueprints, etc.) - using fallback pricing`);
      return []; // Return empty array for items without market data
    }
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
  try {
    const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;

    console.log(`Fetching market history from ESI: ${url}`);

    const response = await retryFetch(async () => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': getUserAgent(),
        },
      });

      if (!res.ok) {
        if (res.status === 400 || res.status === 404) {
          const error = new Error(`Item not available in market: ${res.status} ${res.statusText}`);
          error.noRetry = true;
          throw error;
        }
        throw new Error(`Failed to fetch market history: ${res.status} ${res.statusText}`);
      }

      return res;
    });

    const history = await response.json();
    const expiresAt = getCacheExpiry(response);

    console.log(`Fetched ${history.length} days of market history for type ${typeId} in region ${regionId}`);

    // Store in database
    storeMarketHistory(history, regionId, typeId);

    // Update fetch metadata
    const cacheKey = `market_history_${regionId}_${typeId}`;
    updateFetchMetadata(cacheKey, expiresAt);

    return history;
  } catch (error) {
    if (error.noRetry) {
      console.log(`Item ${typeId} not available in market - returning empty array`);
      return [];
    }
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
 * Manually refresh all market data for current region
 * @param {number} regionId - Region ID to refresh
 * @returns {Promise<Object>} Refresh status
 */
async function manualRefreshMarketData(regionId) {
  const lastFetch = getLastMarketFetchTime();
  const now = Date.now();
  const minInterval = 30 * 60 * 1000; // 30 minutes

  // Check if we can refresh
  if (lastFetch && (now - lastFetch) < minInterval) {
    const remainingTime = Math.ceil((minInterval - (now - lastFetch)) / 60000);
    return {
      success: false,
      error: `Please wait ${remainingTime} minutes before refreshing again.`,
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
      message: 'Market data updated successfully'
    };
  } catch (error) {
    console.error('Error refreshing market data:', error);
    return {
      success: false,
      error: error.message,
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
  try {
    console.log('Fetching adjusted prices from ESI...');

    const response = await retryFetch(async () => {
      const res = await fetch('https://esi.evetech.net/latest/markets/prices/?datasource=tranquility');
      if (!res.ok) {
        throw new Error(`ESI returned status ${res.status}`);
      }
      return res;
    });

    const prices = await response.json();
    console.log(`Fetched ${prices.length} adjusted prices from ESI`);

    return prices;
  } catch (error) {
    console.error('Error fetching adjusted prices:', error);
    throw error;
  }
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

module.exports = {
  fetchMarketOrders,
  fetchMarketHistory,
  fetchMarketData,
  getCachedMarketOrders,
  getCachedMarketHistory,
  getLastMarketFetchTime,
  getLastHistoryFetchTime,
  getHistoryDataStatus,
  manualRefreshMarketData,
  manualRefreshHistoryData,
  fetchAdjustedPrices,
  manualRefreshAdjustedPrices,
};
