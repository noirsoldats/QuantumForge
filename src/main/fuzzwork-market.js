const { getMarketDatabase } = require('./market-database');
const { getUserAgent } = require('./user-agent');

/**
 * Fetch historical market data from Fuzzwork
 * Note: Fuzzwork provides aggregated historical data that ESI doesn't have
 * @param {number} typeId - Type ID
 * @param {number} regionId - Region ID (default: 10000002 = The Forge/Jita)
 * @param {number} days - Number of days of history (default: 365)
 * @returns {Promise<Array>} Historical market data
 */
async function fetchFuzzworkHistory(typeId, regionId = 10000002, days = 365) {
  try {
    // Fuzzwork API endpoint for historical data
    const url = `https://market.fuzzwork.co.uk/aggregates/?region=${regionId}&types=${typeId}`;

    console.log(`Fetching Fuzzwork market data: ${url}`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': getUserAgent(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Fuzzwork data: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data[typeId]) {
      console.log(`No Fuzzwork data available for type ${typeId}`);
      return null;
    }

    const itemData = data[typeId];

    return {
      typeId,
      regionId,
      buy: {
        weightedAverage: itemData.buy?.weightedAverage || 0,
        max: itemData.buy?.max || 0,
        min: itemData.buy?.min || 0,
        stddev: itemData.buy?.stddev || 0,
        median: itemData.buy?.median || 0,
        volume: itemData.buy?.volume || 0,
        orderCount: itemData.buy?.orderCount || 0,
        percentile: itemData.buy?.percentile || 0,
      },
      sell: {
        weightedAverage: itemData.sell?.weightedAverage || 0,
        max: itemData.sell?.max || 0,
        min: itemData.sell?.min || 0,
        stddev: itemData.sell?.stddev || 0,
        median: itemData.sell?.median || 0,
        volume: itemData.sell?.volume || 0,
        orderCount: itemData.sell?.orderCount || 0,
        percentile: itemData.sell?.percentile || 0,
      },
      fetchedAt: Date.now(),
    };
  } catch (error) {
    console.error('Error fetching Fuzzwork market data:', error);
    return null;
  }
}

/**
 * Fetch current Jita 4-4 prices from Fuzzwork
 * This is a convenience method for getting quick Jita prices
 * @param {number} typeId - Type ID
 * @returns {Promise<Object>} Jita prices
 */
async function fetchJitaPrice(typeId) {
  return fetchFuzzworkHistory(typeId, 10000002);
}

/**
 * Fetch prices for multiple items at once
 * @param {Array<number>} typeIds - Array of type IDs
 * @param {number} regionId - Region ID
 * @returns {Promise<Object>} Map of typeId to price data
 */
async function fetchBulkPrices(typeIds, regionId = 10000002) {
  try {
    // Fuzzwork allows comma-separated type IDs
    const typeIdList = typeIds.join(',');
    const url = `https://market.fuzzwork.co.uk/aggregates/?region=${regionId}&types=${typeIdList}`;

    console.log(`Fetching bulk Fuzzwork data for ${typeIds.length} items`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': getUserAgent(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch bulk Fuzzwork data: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const results = {};

    for (const typeId of typeIds) {
      if (data[typeId]) {
        const itemData = data[typeId];
        results[typeId] = {
          typeId: parseInt(typeId),
          regionId,
          buy: {
            weightedAverage: itemData.buy?.weightedAverage || 0,
            max: itemData.buy?.max || 0,
            min: itemData.buy?.min || 0,
            stddev: itemData.buy?.stddev || 0,
            median: itemData.buy?.median || 0,
            volume: itemData.buy?.volume || 0,
            orderCount: itemData.buy?.orderCount || 0,
            percentile: itemData.buy?.percentile || 0,
          },
          sell: {
            weightedAverage: itemData.sell?.weightedAverage || 0,
            max: itemData.sell?.max || 0,
            min: itemData.sell?.min || 0,
            stddev: itemData.sell?.stddev || 0,
            median: itemData.sell?.median || 0,
            volume: itemData.sell?.volume || 0,
            orderCount: itemData.sell?.orderCount || 0,
            percentile: itemData.sell?.percentile || 0,
          },
          fetchedAt: Date.now(),
        };
      }
    }

    console.log(`Fetched Fuzzwork data for ${Object.keys(results).length} items`);
    return results;
  } catch (error) {
    console.error('Error fetching bulk Fuzzwork data:', error);
    return {};
  }
}

/**
 * Store Fuzzwork data as supplementary historical data
 * We'll use a simplified approach: store as a single-day "snapshot"
 * @param {Object} fuzzworkData - Fuzzwork market data
 */
function storeFuzzworkData(fuzzworkData) {
  const db = getMarketDatabase();
  const today = new Date().toISOString().split('T')[0];

  // Store as a market history entry for today
  const insert = db.prepare(`
    INSERT OR REPLACE INTO market_history (
      type_id, region_id, date, average, highest, lowest,
      order_count, volume, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Use sell data as the primary data point
  insert.run(
    fuzzworkData.typeId,
    fuzzworkData.regionId,
    today,
    fuzzworkData.sell.weightedAverage,
    fuzzworkData.sell.max,
    fuzzworkData.sell.min,
    fuzzworkData.sell.orderCount,
    fuzzworkData.sell.volume,
    fuzzworkData.fetchedAt
  );
}

module.exports = {
  fetchFuzzworkHistory,
  fetchJitaPrice,
  fetchBulkPrices,
  storeFuzzworkData,
};
