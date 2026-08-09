/**
 * Manufacturing profitability metrics.
 *
 * Extracted from manufacturing-summary-renderer.js during the UI port. Two
 * things changed in the move, both deliberate:
 *
 * 1. THESE ARE PURE. Every function takes the market history it needs as an
 *    argument instead of fetching it. The renderer versions each called
 *    `market.fetchHistory(regionId, productTypeId)` themselves, so a single
 *    blueprint pulled the SAME product history SIX times - once for SVR, and
 *    again for velocity, saturation, momentum, stability and demand growth. A
 *    200-blueprint run made ~1,200 history calls where ~200 would do.
 *    `collectProductMetrics` below fetches once and feeds all six.
 *
 * 2. THEY LIVE IN MAIN. Pure arithmetic with no DOM, so it is unit-testable
 *    without jsdom and reusable by any screen that wants the same numbers.
 *
 * The formulas are carried over unchanged - this is a move, not a rewrite.
 * Every function returns 0 on missing or insufficient data rather than
 * throwing, matching the original behaviour: a metric that cannot be computed
 * should not break a whole summary row.
 */

/** History rows older than `period` days are dropped. */
function withinPeriod(history, period) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);
  return history.filter((day) => new Date(day.date) >= cutoff);
}

/** Most recent first. */
function sortedDescending(history) {
  return [...history].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function sumVolume(days) {
  return days.reduce((sum, day) => sum + (day.volume || 0), 0);
}

function averageVolume(days) {
  return days.length > 0 ? sumVolume(days) / days.length : 0;
}

/**
 * Sales-to-Volume Ratio: how much the market absorbs versus what you could
 * make in the same window. Below 1 means you can out-produce demand.
 *
 * @param {Array} history - market history for the PRODUCT
 * @param {number} period - days
 * @param {number} productionTimeHours - hours to build one unit
 */
function calculateSVR(history, period, productionTimeHours) {
  const recent = withinPeriod(history, period);
  if (recent.length === 0) return 0;

  const totalSold = sumVolume(recent);
  const periodHours = period * 24;
  const unitsProducible = productionTimeHours > 0 ? periodHours / productionTimeHours : 0;

  return unitsProducible > 0 ? totalSold / unitsProducible : 0;
}

/**
 * Profit Velocity (ISK/day): profit per unit x average units sold per day.
 */
function calculateProfitVelocity(history, profitPerUnit, period = 30) {
  const recent = withinPeriod(history, period);
  if (recent.length === 0) return 0;
  return profitPerUnit * averageVolume(recent);
}

/**
 * Market Saturation Index: listed sell volume against daily sales.
 * Higher means oversupply; lower means healthy demand.
 */
function calculateMarketSaturation(history, totalSellVolume, period = 30) {
  const recent = withinPeriod(history, period);
  if (recent.length === 0) return 0;

  const avgDailySales = averageVolume(recent);
  if (avgDailySales === 0) return 0;

  return totalSellVolume / avgDailySales;
}

/**
 * Price Momentum: (7-day MA - 30-day MA) / 30-day MA.
 * Positive means the price is rising. Needs 30 days of data.
 */
function calculatePriceMomentum(history) {
  if (!Array.isArray(history) || history.length < 30) return 0;

  const sorted = sortedDescending(history);
  const last7 = sorted.slice(0, 7);
  const last30 = sorted.slice(0, 30);

  const ma7 = last7.reduce((sum, day) => sum + (day.average || 0), 0) / last7.length;
  const ma30 = last30.reduce((sum, day) => sum + (day.average || 0), 0) / last30.length;

  if (ma30 === 0) return 0;
  return (ma7 - ma30) / ma30;
}

/**
 * Profit Stability Index: 1 - (stdev / mean) of daily prices, clamped to 0..1.
 * Higher means steadier margins. Needs `period` days of data.
 */
function calculateProfitStability(history, currentProfit, period = 28) {
  if (!Array.isArray(history) || history.length < period) return 0;

  const recent = withinPeriod(history, period);
  if (recent.length === 0) return 0;

  const values = recent.map((day) => day.average || 0);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;

  const variance = values.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return Math.max(0, Math.min(1, 1 - (stdDev / mean)));
}

/**
 * Demand Growth Rate: last 7 days of sales against the 7 before them.
 * Positive means demand is growing. Needs 14 days of data.
 */
function calculateDemandGrowth(history) {
  if (!Array.isArray(history) || history.length < 14) return 0;

  const sorted = sortedDescending(history);
  const avgLast7 = averageVolume(sorted.slice(0, 7));
  const avgPrevious7 = averageVolume(sorted.slice(7, 14));

  if (avgPrevious7 === 0) return 0;
  return (avgLast7 - avgPrevious7) / avgPrevious7;
}

/**
 * Material Cost Volatility: coefficient of variation of the BASKET cost.
 *
 * NOT an average of per-material volatilities. The original builds the
 * quantity-weighted total cost of the whole material list for each day, then
 * measures how much that daily total moves - so a volatile trace mineral that
 * you need one unit of barely registers, while a swing in the bulk input
 * dominates. Averaging individual volatilities would weight them equally and
 * give a materially different number.
 *
 * @param {Array} entries - [{ quantity, history }] one per material
 * @param {number} period - days
 */
function calculateMaterialCostVolatility(entries, period = 30) {
  const materials = (entries || []).filter((m) => m && Array.isArray(m.history));
  if (materials.length === 0) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);

  // Every date any material has data for, inside the window.
  const dates = new Set();
  materials.forEach(({ history }) => {
    history.forEach((day) => {
      if (new Date(day.date) >= cutoff) dates.add(day.date);
    });
  });

  const sortedDates = [...dates].sort();
  if (sortedDates.length < 2) return 0;

  // Basket cost per day. A material missing that date contributes nothing,
  // matching the original's `find` returning undefined.
  const dailyCosts = sortedDates
    .map((date) => materials.reduce((total, { history, quantity }) => {
      const day = history.find((d) => d.date === date);
      return total + (day ? (day.average || 0) * quantity : 0);
    }, 0))
    .filter((cost) => cost > 0);

  if (dailyCosts.length < 2) return 0;

  const mean = dailyCosts.reduce((sum, v) => sum + v, 0) / dailyCosts.length;
  if (mean === 0) return 0;

  const variance = dailyCosts.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / dailyCosts.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Composite market health score, 0..1 (NOT a percentage).
 *
 * Carried over verbatim from the renderer - the caps and weights below are the
 * original values and must not be "tidied": they set the shape of every
 * ranking on the summary screen.
 */
function calculateMarketHealthScore(svr, msi, momentum, psi) {
  // SVR capped at 2.0 - beyond that, more liquidity does not help further.
  const normalizedSVR = Math.min(svr / 2.0, 1.0);

  // MSI INVERTED: lower saturation is better, floor at 10 days of stock.
  const normalizedMSI = Math.max(0, 1 - (msi / 10));

  // Momentum spans roughly -50%..+50%, mapped onto 0..1.
  const normalizedMomentum = Math.max(0, Math.min(1, (momentum + 0.5) / 1.0));

  // PSI is already 0..1.
  return (0.3 * normalizedSVR)
    + (0.3 * normalizedMSI)
    + (0.2 * normalizedMomentum)
    + (0.2 * psi);
}

/**
 * Total volume listed in sell orders.
 * @param {Array} orders - market orders for the product
 */
function calculateTotalSellVolume(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
  return orders
    .filter((o) => !o.is_buy_order)
    .reduce((sum, o) => sum + (o.volume_remain || 0), 0);
}

/**
 * Every product metric from ONE history read.
 *
 * This is the point of the extraction: the renderer used to call six separate
 * functions that each fetched the same history. Fetching once and passing it
 * down cuts a 200-blueprint run from ~1,200 history calls to ~200.
 *
 * @param {Object} input
 * @param {Array}  input.history         product market history (fetched once)
 * @param {Array}  input.orders          product market orders (fetched once)
 * @param {number} input.svrPeriod
 * @param {number} input.productionTimeHours
 * @param {number} input.profitPerUnit
 * @returns {Object} the metric set, plus the composite health score
 */
function collectProductMetrics({
  history = [],
  orders = [],
  svrPeriod = 30,
  productionTimeHours = 0,
  profitPerUnit = 0,
} = {}) {
  const totalSellVolume = calculateTotalSellVolume(orders);

  const svr = calculateSVR(history, svrPeriod, productionTimeHours);
  const profitVelocity = calculateProfitVelocity(history, profitPerUnit);
  const marketSaturation = calculateMarketSaturation(history, totalSellVolume);
  const priceMomentum = calculatePriceMomentum(history);
  const profitStability = calculateProfitStability(history, profitPerUnit);
  const demandGrowth = calculateDemandGrowth(history);

  return {
    totalSellVolume,
    svr,
    profitVelocity,
    marketSaturation,
    priceMomentum,
    profitStability,
    demandGrowth,
    marketHealthScore: calculateMarketHealthScore(
      svr, marketSaturation, priceMomentum, profitStability
    ),
  };
}

module.exports = {
  calculateSVR,
  calculateTotalSellVolume,
  calculateProfitVelocity,
  calculateMarketSaturation,
  calculatePriceMomentum,
  calculateProfitStability,
  calculateDemandGrowth,
  calculateMaterialCostVolatility,
  calculateMarketHealthScore,
  collectProductMetrics,
  // Exported for tests and for callers that need the same windowing.
  withinPeriod,
};
