const { getMarketDatabase } = require('./market-database');
const { fetchMarketData, getCachedMarketOrders, getCachedMarketHistory } = require('./esi-market');
const { fetchFuzzworkHistory } = require('./fuzzwork-market');

/**
 * Calculate Volume-Weighted Average Price (VWAP)
 * @param {Array} orders - Market orders
 * @param {number} quantity - Quantity needed
 * @param {boolean} isBuy - True for buy orders, false for sell orders
 * @returns {Object} VWAP result with price and metadata
 */
function calculateVWAP(orders, quantity, isBuy = false) {
  if (!orders || orders.length === 0) {
    return { price: 0, incomplete: true, ordersUsed: 0 };
  }

  // Filter for the correct order type
  const filteredOrders = orders.filter(o => o.is_buy_order === isBuy);

  // Sort orders by price (ascending for sell, descending for buy)
  const sortedOrders = filteredOrders.sort((a, b) =>
    isBuy ? b.price - a.price : a.price - b.price
  );

  let remainingQty = quantity;
  let totalCost = 0;
  let ordersUsed = 0;

  for (const order of sortedOrders) {
    if (remainingQty <= 0) break;

    const qtyFromThisOrder = Math.min(remainingQty, order.volume_remain);
    totalCost += qtyFromThisOrder * order.price;
    remainingQty -= qtyFromThisOrder;
    ordersUsed++;
  }

  // If we couldn't fill the order, flag it
  const incomplete = remainingQty > 0;
  const avgPrice = quantity > 0 ? totalCost / (quantity - remainingQty) : 0;

  return {
    price: avgPrice,
    incomplete,
    ordersUsed,
    quantityFilled: quantity - remainingQty,
    quantityRequested: quantity,
  };
}

/**
 * Calculate percentile-based pricing
 * @param {Array} orders - Market orders
 * @param {boolean} isBuy - True for buy orders, false for sell orders
 * @param {number} percentile - Percentile to use (0-1)
 * @returns {number} Percentile price
 */
function calculatePercentilePrice(orders, isBuy = false, percentile = 0.2) {
  if (!orders || orders.length === 0) {
    return 0;
  }

  // Filter for the correct order type
  const filteredOrders = orders.filter(o => o.is_buy_order === isBuy);

  if (filteredOrders.length === 0) {
    return 0;
  }

  // Sort orders by price
  const sorted = filteredOrders.sort((a, b) => a.price - b.price);

  // Calculate total volume
  const totalVolume = sorted.reduce((sum, o) => sum + o.volume_remain, 0);

  if (totalVolume === 0) {
    return sorted[0].price;
  }

  // Find the price at the Xth percentile of volume
  let cumulativeVolume = 0;
  const targetVolume = totalVolume * percentile;

  for (const order of sorted) {
    cumulativeVolume += order.volume_remain;
    if (cumulativeVolume >= targetVolume) {
      return order.price;
    }
  }

  return sorted[0].price;
}

/**
 * Get best price with minimum volume threshold
 * @param {Array} orders - Market orders
 * @param {boolean} isBuy - True for buy orders, false for sell orders
 * @param {number} minVolume - Minimum volume threshold
 * @returns {number} Best price
 */
function getBestPriceWithMinVolume(orders, isBuy = false, minVolume = 1000) {
  if (!orders || orders.length === 0) {
    return 0;
  }

  // Filter for the correct order type
  const filteredOrders = orders.filter(o => o.is_buy_order === isBuy);

  if (filteredOrders.length === 0) {
    return 0;
  }

  // Find orders with sufficient volume
  const validOrders = filteredOrders.filter(o => o.volume_remain >= minVolume);

  if (validOrders.length === 0) {
    // Fallback: use average of top 5 orders if no large orders
    const sorted = filteredOrders.sort((a, b) =>
      isBuy ? b.price - a.price : a.price - b.price
    );
    const topOrders = sorted.slice(0, Math.min(5, sorted.length));
    return topOrders.reduce((sum, o) => sum + o.price, 0) / topOrders.length;
  }

  // Return best price from valid orders
  const prices = validOrders.map(o => o.price);
  return isBuy ? Math.max(...prices) : Math.min(...prices);
}

/**
 * Remove statistical outliers using IQR method
 * @param {Array} orders - Market orders
 * @param {boolean} isBuy - True for buy orders, false for sell orders
 * @returns {Array} Filtered orders
 */
function removeOutliers(orders, isBuy = false) {
  if (!orders || orders.length < 4) {
    return orders;
  }

  // Filter for the correct order type
  const filteredOrders = orders.filter(o => o.is_buy_order === isBuy);

  if (filteredOrders.length < 4) {
    return filteredOrders;
  }

  const prices = filteredOrders.map(o => o.price).sort((a, b) => a - b);

  const q1Index = Math.floor(prices.length * 0.25);
  const q3Index = Math.floor(prices.length * 0.75);

  const q1 = prices[q1Index];
  const q3 = prices[q3Index];
  const iqr = q3 - q1;

  const lowerBound = q1 - (1.5 * iqr);
  const upperBound = q3 + (1.5 * iqr);

  return filteredOrders.filter(o => o.price >= lowerBound && o.price <= upperBound);
}

/**
 * Calculate average from historical data
 * @param {Array} history - Historical market data
 * @param {string} field - Field to average ('average', 'highest', 'lowest')
 * @param {number} days - Number of recent days to average
 * @returns {number} Average value
 */
function calculateHistoricalAverage(history, field = 'average', days = null) {
  if (!history || history.length === 0) {
    return 0;
  }

  const recentHistory = days ? history.slice(-days) : history;
  const sum = recentHistory.reduce((acc, day) => acc + (day[field] || 0), 0);
  return sum / recentHistory.length;
}

/**
 * Calculate standard deviation from historical data
 * @param {Array} history - Historical market data
 * @param {string} field - Field to calculate stddev for
 * @returns {number} Standard deviation
 */
function calculateStdDev(history, field = 'average') {
  if (!history || history.length === 0) {
    return 0;
  }

  const values = history.map(day => day[field] || 0);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map(value => Math.pow(value - avg, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;

  return Math.sqrt(avgSquareDiff);
}

/**
 * Calculate median from array
 * @param {Array} values - Array of numbers
 * @returns {number} Median value
 */
function calculateMedian(values) {
  if (!values || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

/**
 * Calculate realistic market price using hybrid approach
 * @param {number} typeId - Type ID
 * @param {number} regionId - Region ID
 * @param {number} locationId - Station/structure ID (optional)
 * @param {string} priceType - 'buy' or 'sell'
 * @param {number} quantity - Quantity needed
 * @param {Object} settings - Market settings
 * @returns {Promise<Object>} Price calculation result
 */
async function calculateRealisticPrice(typeId, regionId, locationId, priceType, quantity, settings = {}) {
  const isBuy = priceType === 'buy';

  console.log(`[Price Calc] TypeID: ${typeId}, Region: ${regionId}, Location: ${locationId}, Type: ${priceType}, Qty: ${quantity}`);

  // Check for user override first
  const override = getPriceOverride(typeId);
  if (override) {
    return {
      price: override.price,
      method: 'override',
      confidence: 'high',
      warning: null,
      metadata: {
        notes: override.notes,
        updatedAt: override.updated_at,
      },
    };
  }

  // Get cached orders and history
  let orders = getCachedMarketOrders(regionId, typeId);
  let history = getCachedMarketHistory(regionId, typeId);

  console.log(`[Price Calc] Initial orders: ${orders ? orders.length : 0}, history: ${history ? history.length : 0}`);

  // If no cached data, fetch from ESI
  if (!orders || orders.length === 0 || !history || history.length === 0) {
    const marketData = await fetchMarketData(regionId, typeId);
    orders = marketData.orders;
    history = marketData.history;
    console.log(`[Price Calc] After fetch - orders: ${orders ? orders.length : 0}, history: ${history ? history.length : 0}`);
  }

  // Filter orders by location if specified
  if (locationId) {
    const beforeFilter = orders.length;
    orders = orders.filter(o => o.location_id === locationId);
    console.log(`[Price Calc] Location filter: ${beforeFilter} → ${orders.length} orders`);
  }

  // Calculate historical averages
  const avgPrice7d = calculateHistoricalAverage(history, 'average', 7);
  const avgPrice30d = calculateHistoricalAverage(history, 'average', 30);
  const stdDev7d = calculateStdDev(history.slice(-7), 'average');

  // Calculate multiple price estimates
  const vwapResult = calculateVWAP(orders, quantity, isBuy);
  const percentilePrice = calculatePercentilePrice(orders, isBuy, settings.percentile || 0.2);
  const minVolumePrice = getBestPriceWithMinVolume(orders, isBuy, settings.minVolume || Math.min(quantity * 0.1, 1000));

  // Remove outliers and get best price
  const cleanedOrders = removeOutliers(orders, isBuy);
  const cleanedBestPrice = cleanedOrders.length > 0
    ? (isBuy ? Math.max(...cleanedOrders.map(o => o.price)) : Math.min(...cleanedOrders.map(o => o.price)))
    : 0;

  // Collect candidate prices
  const candidates = [vwapResult.price, percentilePrice, minVolumePrice, cleanedBestPrice].filter(p => p > 0);

  // Validate against history (within 50% of 7-day average)
  const validPrices = candidates.filter(price => {
    if (avgPrice7d === 0) return true;
    return Math.abs(price - avgPrice7d) <= avgPrice7d * 0.5;
  });

  // Choose the best price based on method
  let finalPrice;
  let method;
  let confidence;
  let warning = null;

  // Get the best immediate price (highest buy or lowest sell)
  // Filter to only the order type we want (buy or sell)
  const relevantOrders = orders.filter(o => o.is_buy_order === isBuy);
  const immediatePrice = relevantOrders.length > 0
    ? (isBuy ? Math.max(...relevantOrders.map(o => o.price)) : Math.min(...relevantOrders.map(o => o.price)))
    : 0;

  console.log(`[Price Calc] Relevant orders (is_buy=${isBuy}): ${relevantOrders.length}, Immediate price: ${immediatePrice}`);

  // Determine which method to use
  const requestedMethod = settings.priceMethod || 'hybrid';
  console.log(`[Price Calc] Requested method: ${requestedMethod}`);

  switch (requestedMethod) {
    case 'immediate':
      if (immediatePrice > 0) {
        finalPrice = immediatePrice;
        method = 'immediate';
        confidence = 'high';
      } else {
        // Fallback if no orders
        finalPrice = avgPrice7d || 0;
        method = 'historical';
        confidence = 'low';
        warning = 'No current market orders found, using historical average';
      }
      break;

    case 'vwap':
      if (vwapResult.price > 0) {
        finalPrice = vwapResult.price;
        method = 'vwap';
        confidence = vwapResult.incomplete ? 'medium' : 'high';
        if (vwapResult.incomplete) {
          warning = `Insufficient market depth (${vwapResult.quantityFilled}/${quantity} available)`;
        }
      } else {
        finalPrice = avgPrice7d || 0;
        method = 'historical';
        confidence = 'low';
        warning = 'No current market orders found, using historical average';
      }
      break;

    case 'percentile':
      if (percentilePrice > 0) {
        finalPrice = percentilePrice;
        method = 'percentile';
        confidence = 'high';
      } else {
        finalPrice = avgPrice7d || 0;
        method = 'historical';
        confidence = 'low';
        warning = 'No current market orders found, using historical average';
      }
      break;

    case 'historical':
      if (avgPrice30d > 0) {
        finalPrice = avgPrice30d;
        method = 'historical';
        confidence = 'medium';
      } else if (avgPrice7d > 0) {
        finalPrice = avgPrice7d;
        method = 'historical';
        confidence = 'low';
      } else {
        finalPrice = 0;
        method = 'none';
        confidence = 'none';
        warning = 'No historical data available';
      }
      break;

    case 'hybrid':
    default:
      if (validPrices.length > 0) {
        // Use median of valid prices
        finalPrice = calculateMedian(validPrices);
        method = 'hybrid';
        confidence = 'high';
      } else if (candidates.length > 0) {
        // Use median of candidates even if they look suspicious
        finalPrice = calculateMedian(candidates);
        method = 'hybrid';
        confidence = 'medium';
        warning = 'Price deviates significantly from historical average';
      } else if (avgPrice7d > 0) {
        // Fallback to 7-day average
        finalPrice = avgPrice7d;
        method = 'historical';
        confidence = 'low';
        warning = 'No current market orders found, using historical average';
      } else {
        // No data available
        finalPrice = 0;
        method = 'none';
        confidence = 'none';
        warning = 'No market data available';
      }
      break;
  }

  // Add warning if market depth is insufficient (for non-vwap methods that didn't already set this)
  if (requestedMethod !== 'vwap' && vwapResult.incomplete && !warning) {
    warning = `Insufficient market depth (${vwapResult.quantityFilled}/${quantity} available)`;
    if (confidence === 'high') {
      confidence = 'medium';
    }
  }

  // Apply price modifier if specified
  if (settings.priceModifier && settings.priceModifier !== 1.0) {
    finalPrice *= settings.priceModifier;
  }

  // Cache the result
  cachePriceCalculation(typeId, locationId || regionId, regionId, priceType, finalPrice, {
    vwap: vwapResult.price,
    percentile: percentilePrice,
    historical7d: avgPrice7d,
    historical30d: avgPrice30d,
    confidence,
    warning,
    quantity,
  });

  return {
    price: finalPrice,
    immediate: immediatePrice,
    vwap: vwapResult.price,
    percentile: percentilePrice,
    minVolume: minVolumePrice,
    cleaned: cleanedBestPrice,
    historical7d: avgPrice7d,
    historical30d: avgPrice30d,
    method,
    confidence,
    warning,
    metadata: {
      ordersAvailable: orders.length,
      ordersUsed: vwapResult.ordersUsed,
      quantityFilled: vwapResult.quantityFilled,
      quantityRequested: quantity,
      historicalDays: history.length,
    },
  };
}

/**
 * Cache a price calculation
 */
function cachePriceCalculation(typeId, locationId, regionId, priceType, price, metadata) {
  const db = getMarketDatabase();
  if (!db) {
    console.error('Market database not initialized');
    return;
  }
  const calculatedAt = Date.now();
  const expiresAt = calculatedAt + (5 * 60 * 1000); // 5 minutes

  db.prepare(`
    INSERT OR REPLACE INTO market_price_cache (
      type_id, location_id, region_id, price_type, price,
      vwap, percentile_price, historical_7d, historical_30d,
      confidence, warning, quantity, calculated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    typeId,
    locationId,
    regionId,
    priceType,
    price,
    metadata.vwap || null,
    metadata.percentile || null,
    metadata.historical7d || null,
    metadata.historical30d || null,
    metadata.confidence || null,
    metadata.warning || null,
    metadata.quantity || null,
    calculatedAt,
    expiresAt
  );
}

/**
 * Get price override for a type
 */
function getPriceOverride(typeId) {
  const db = getMarketDatabase();
  if (!db) {
    console.error('Market database not initialized');
    return null;
  }
  const override = db.prepare('SELECT * FROM price_overrides WHERE type_id = ?').get(typeId);

  if (!override) {
    return null;
  }

  // Map database columns to camelCase for renderer
  return {
    typeId: override.type_id,
    price: override.price,
    notes: override.notes,
    timestamp: override.updated_at
  };
}

/**
 * Set price override for a type
 */
function setPriceOverride(typeId, price, notes = null) {
  const db = getMarketDatabase();
  if (!db) {
    console.error('Market database not initialized');
    return false;
  }
  db.prepare(`
    INSERT OR REPLACE INTO price_overrides (type_id, price, notes, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(typeId, price, notes, Date.now());
  return true;
}

/**
 * Remove price override for a type
 */
function removePriceOverride(typeId) {
  const db = getMarketDatabase();
  if (!db) {
    console.error('Market database not initialized');
    return false;
  }
  db.prepare('DELETE FROM price_overrides WHERE type_id = ?').run(typeId);
  return true;
}

/**
 * Get all price overrides
 */
function getAllPriceOverrides() {
  const db = getMarketDatabase();
  if (!db) {
    console.error('Market database not initialized');
    return [];
  }
  const overrides = db.prepare('SELECT * FROM price_overrides').all();

  // Map database columns to camelCase for renderer
  return overrides.map(override => ({
    typeId: override.type_id,
    price: override.price,
    notes: override.notes,
    timestamp: override.updated_at
  }));
}

module.exports = {
  calculateVWAP,
  calculatePercentilePrice,
  getBestPriceWithMinVolume,
  removeOutliers,
  calculateHistoricalAverage,
  calculateStdDev,
  calculateMedian,
  calculateRealisticPrice,
  getPriceOverride,
  setPriceOverride,
  removePriceOverride,
  getAllPriceOverrides,
};
