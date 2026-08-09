/**
 * Manufacturing profitability metrics.
 *
 * These formulas were EXTRACTED from manufacturing-summary-renderer.js during
 * the UI port. That makes transcription error the dominant risk: a plausible
 * but wrong constant changes every ranking on the summary screen without
 * breaking anything visibly.
 *
 * Two of the eight were in fact transcribed wrong on the first attempt:
 *   - calculateMarketHealthScore: invented caps (10 vs 2.0), invented weights
 *     (0.35/0.30/0.20/0.15 vs 0.3/0.3/0.2/0.2), and returned 0-100 instead of
 *     0-1.
 *   - calculateMaterialCostVolatility: written as a mean of per-material
 *     volatilities, when the original measures the QUANTITY-WEIGHTED BASKET
 *     cost per day.
 *
 * So the first block below re-implements each original formula independently
 * and asserts the extracted version produces identical output. Those are the
 * regression net; the rest cover edges the originals handled by returning 0.
 */

const metrics = require('../../src/main/manufacturing-metrics');

/** History rows, most recent first, `days` long. */
function makeHistory(days, volumeFor, averageFor) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({
      date: d.toISOString().slice(0, 10),
      volume: volumeFor(i),
      average: averageFor(i),
    });
  }
  return out;
}

const HISTORY = makeHistory(40, (i) => 1000 + (i * 10), (i) => 100 + (i % 7));

/* ------------------------------------------------------------------------ */
/* Independent re-implementations of the ORIGINAL renderer formulas.          */
/* Transcribed from manufacturing-summary-renderer.js, not from the module    */
/* under test - otherwise they would agree by construction.                   */
/* ------------------------------------------------------------------------ */

function originalSVR(allHistory, period, productionTimeHours) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);
  const recent = allHistory.filter((day) => new Date(day.date) >= cutoff);
  if (recent.length === 0) return 0;

  const totalSold = recent.reduce((sum, day) => sum + (day.volume || 0), 0);
  const unitsProducible = productionTimeHours > 0 ? (period * 24) / productionTimeHours : 0;
  return unitsProducible > 0 ? totalSold / unitsProducible : 0;
}

function originalProfitVelocity(allHistory, profitPerUnit, period = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);
  const recent = allHistory.filter((day) => new Date(day.date) >= cutoff);
  if (recent.length === 0) return 0;

  const totalSold = recent.reduce((sum, day) => sum + (day.volume || 0), 0);
  return profitPerUnit * (totalSold / recent.length);
}

function originalMarketSaturation(allHistory, totalSellVolume, period = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);
  const recent = allHistory.filter((day) => new Date(day.date) >= cutoff);
  if (recent.length === 0) return 0;

  const totalSold = recent.reduce((sum, day) => sum + (day.volume || 0), 0);
  const avgDailySales = totalSold / recent.length;
  if (avgDailySales === 0) return 0;

  return totalSellVolume / avgDailySales;
}

function originalPriceMomentum(allHistory) {
  if (!allHistory || allHistory.length < 30) return 0;
  const sorted = [...allHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

  const last7 = sorted.slice(0, 7);
  const ma7 = last7.reduce((sum, day) => sum + (day.average || 0), 0) / last7.length;
  const last30 = sorted.slice(0, 30);
  const ma30 = last30.reduce((sum, day) => sum + (day.average || 0), 0) / last30.length;

  if (ma30 === 0) return 0;
  return (ma7 - ma30) / ma30;
}

function originalProfitStability(allHistory, period = 28) {
  if (!allHistory || allHistory.length < period) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);
  const recent = allHistory.filter((day) => new Date(day.date) >= cutoff);
  if (recent.length === 0) return 0;

  const margins = recent.map((day) => day.average || 0);
  const mean = margins.reduce((sum, v) => sum + v, 0) / margins.length;
  const variance = margins.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / margins.length;
  if (mean === 0) return 0;

  return Math.max(0, Math.min(1, 1 - (Math.sqrt(variance) / mean)));
}

function originalDemandGrowth(allHistory) {
  if (!allHistory || allHistory.length < 14) return 0;
  const sorted = [...allHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

  const avgLast7 = sorted.slice(0, 7).reduce((sum, d) => sum + (d.volume || 0), 0) / 7;
  const avgPrev7 = sorted.slice(7, 14).reduce((sum, d) => sum + (d.volume || 0), 0) / 7;
  if (avgPrev7 === 0) return 0;

  return (avgLast7 - avgPrev7) / avgPrev7;
}

function originalHealthScore(svr, msi, momentum, psi) {
  const normalizedSVR = Math.min(svr / 2.0, 1.0);
  const normalizedMSI = Math.max(0, 1 - (msi / 10));
  const normalizedMomentum = Math.max(0, Math.min(1, (momentum + 0.5) / 1.0));
  return (0.3 * normalizedSVR) + (0.3 * normalizedMSI)
    + (0.2 * normalizedMomentum) + (0.2 * psi);
}

function originalMaterialCostVolatility(materialPriceHistories, period = 30) {
  if (materialPriceHistories.length === 0) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - period);

  const allDates = new Set();
  materialPriceHistories.forEach((mph) => {
    mph.history.forEach((day) => {
      if (new Date(day.date) >= cutoff) allDates.add(day.date);
    });
  });

  const sortedDates = Array.from(allDates).sort();
  if (sortedDates.length < 2) return 0;

  const dailyCosts = sortedDates.map((date) => {
    let totalCost = 0;
    materialPriceHistories.forEach((mph) => {
      const dayData = mph.history.find((d) => d.date === date);
      if (dayData) totalCost += (dayData.average || 0) * mph.quantity;
    });
    return totalCost;
  }).filter((cost) => cost > 0);

  if (dailyCosts.length < 2) return 0;

  const mean = dailyCosts.reduce((sum, v) => sum + v, 0) / dailyCosts.length;
  const variance = dailyCosts.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / dailyCosts.length;
  if (mean === 0) return 0;

  return Math.sqrt(variance) / mean;
}

/* ------------------------------------------------------------------------ */

describe('parity with the original renderer formulas', () => {
  test('SVR', () => {
    expect(metrics.calculateSVR(HISTORY, 30, 2))
      .toBe(originalSVR(HISTORY, 30, 2));
  });

  test('profit velocity', () => {
    expect(metrics.calculateProfitVelocity(HISTORY, 5000, 30))
      .toBe(originalProfitVelocity(HISTORY, 5000, 30));
  });

  test('market saturation', () => {
    expect(metrics.calculateMarketSaturation(HISTORY, 250000, 30))
      .toBe(originalMarketSaturation(HISTORY, 250000, 30));
  });

  test('price momentum', () => {
    expect(metrics.calculatePriceMomentum(HISTORY))
      .toBe(originalPriceMomentum(HISTORY));
  });

  test('profit stability', () => {
    expect(metrics.calculateProfitStability(HISTORY, 0, 28))
      .toBe(originalProfitStability(HISTORY, 28));
  });

  test('demand growth', () => {
    expect(metrics.calculateDemandGrowth(HISTORY))
      .toBe(originalDemandGrowth(HISTORY));
  });

  test.each([
    [1.2, 4, 0.10, 0.80],
    [0.0, 0, 0.00, 0.00],
    [5.0, 25, -0.90, 1.00],
    [2.0, 10, 0.50, 0.50],
  ])('market health score (svr=%p msi=%p momentum=%p psi=%p)', (svr, msi, momentum, psi) => {
    // The one that was transcribed wrong: caps, weights AND output range.
    expect(metrics.calculateMarketHealthScore(svr, msi, momentum, psi))
      .toBe(originalHealthScore(svr, msi, momentum, psi));
  });

  test('material cost volatility uses the quantity-weighted basket', () => {
    // The other wrong transcription. A cheap, wildly volatile trace material
    // must NOT count the same as the bulk input - averaging per-material
    // volatilities would make these two fixtures score identically.
    const bulk = makeHistory(30, () => 0, (i) => 5 + (i % 3));
    const trace = makeHistory(30, () => 0, (i) => (i % 2 ? 1000 : 100));

    const materials = [
      { quantity: 1000000, history: bulk },
      { quantity: 1, history: trace },
    ];

    expect(metrics.calculateMaterialCostVolatility(materials, 30))
      .toBe(originalMaterialCostVolatility(materials, 30));
  });

  test('a volatile TRACE material barely moves the basket', () => {
    // Pins the weighting itself, independent of the reference implementation.
    const steady = makeHistory(30, () => 0, () => 10);
    const wild = makeHistory(30, () => 0, (i) => (i % 2 ? 10000 : 1));

    const withTrace = metrics.calculateMaterialCostVolatility([
      { quantity: 1000000, history: steady },
      { quantity: 1, history: wild },
    ], 30);

    expect(withTrace).toBeLessThan(0.05);
  });
});

describe('the metrics themselves', () => {
  test('SVR is sales divided by what you could produce', () => {
    // 10 days x 100 sold = 1000 sold. At 24h per unit over 10 days you could
    // make 10, so the market absorbs 100x your output.
    const history = makeHistory(10, () => 100, () => 50);
    expect(metrics.calculateSVR(history, 10, 24)).toBe(100);
  });

  test('SVR is 0 when nothing can be produced', () => {
    const history = makeHistory(10, () => 100, () => 50);
    expect(metrics.calculateSVR(history, 10, 0)).toBe(0);
  });

  test('saturation compares listed stock to daily sales', () => {
    // 100/day sold, 1000 listed = 10 days of stock on the market.
    const history = makeHistory(30, () => 100, () => 50);
    expect(metrics.calculateMarketSaturation(history, 1000, 30)).toBe(10);
  });

  test('momentum is positive when recent prices are above the 30-day mean', () => {
    // Index 0 is today; higher `i` is older, so a rising recent price means
    // LOW i has the HIGH value.
    const rising = makeHistory(30, () => 100, (i) => (i < 7 ? 200 : 100));
    expect(metrics.calculatePriceMomentum(rising)).toBeGreaterThan(0);

    const falling = makeHistory(30, () => 100, (i) => (i < 7 ? 50 : 100));
    expect(metrics.calculatePriceMomentum(falling)).toBeLessThan(0);
  });

  test('stability is 1 for a perfectly flat price', () => {
    const flat = makeHistory(30, () => 100, () => 500);
    expect(metrics.calculateProfitStability(flat, 0, 28)).toBe(1);
  });

  test('stability is clamped to 0..1', () => {
    const erratic = makeHistory(30, () => 100, (i) => (i % 2 ? 1 : 10000));
    const psi = metrics.calculateProfitStability(erratic, 0, 28);
    expect(psi).toBeGreaterThanOrEqual(0);
    expect(psi).toBeLessThanOrEqual(1);
  });

  test('demand growth compares the last 7 days to the 7 before', () => {
    const doubling = makeHistory(14, (i) => (i < 7 ? 200 : 100), () => 50);
    expect(metrics.calculateDemandGrowth(doubling)).toBe(1);
  });

  test('sell volume ignores buy orders', () => {
    const orders = [
      { is_buy_order: false, volume_remain: 100 },
      { is_buy_order: true, volume_remain: 999 },
      { is_buy_order: false, volume_remain: 50 },
    ];
    expect(metrics.calculateTotalSellVolume(orders)).toBe(150);
  });
});

describe('insufficient data returns 0 rather than throwing', () => {
  // The originals swallowed everything in try/catch and returned 0. A metric
  // that cannot be computed must not break the whole summary row.
  const CASES = [
    ['calculateSVR', [[], 30, 2]],
    ['calculateProfitVelocity', [[], 100]],
    ['calculateMarketSaturation', [[], 500]],
    ['calculatePriceMomentum', [[]]],
    ['calculateProfitStability', [[], 0]],
    ['calculateDemandGrowth', [[]]],
    ['calculateTotalSellVolume', [[]]],
  ];

  test.each(CASES)('%s with empty history', (fn, args) => {
    expect(metrics[fn](...args)).toBe(0);
  });

  test.each(CASES)('%s with null', (fn, args) => {
    const nulled = [null, ...args.slice(1)];
    expect(metrics[fn](...nulled)).toBe(0);
  });

  test('momentum needs 30 days', () => {
    expect(metrics.calculatePriceMomentum(makeHistory(29, () => 100, () => 50))).toBe(0);
    expect(metrics.calculatePriceMomentum(makeHistory(30, () => 100, () => 50))).not.toBeNaN();
  });

  test('demand growth needs 14 days', () => {
    expect(metrics.calculateDemandGrowth(makeHistory(13, () => 100, () => 50))).toBe(0);
  });

  test('material volatility needs at least two priced days', () => {
    expect(metrics.calculateMaterialCostVolatility([], 30)).toBe(0);
    expect(metrics.calculateMaterialCostVolatility([
      { quantity: 1, history: makeHistory(1, () => 0, () => 100) },
    ], 30)).toBe(0);
  });
});

describe('collectProductMetrics', () => {
  // The whole point of the extraction: ONE history read feeds every metric.
  // The renderer previously fetched the same product history six times per
  // blueprint - ~1,200 calls on a 200-blueprint run instead of ~200.

  const orders = [
    { is_buy_order: false, volume_remain: 5000 },
    { is_buy_order: true, volume_remain: 9999 },
  ];

  test('returns every metric from a single history argument', () => {
    const result = metrics.collectProductMetrics({
      history: HISTORY,
      orders,
      svrPeriod: 30,
      productionTimeHours: 2,
      profitPerUnit: 5000,
    });

    expect(Object.keys(result).sort()).toEqual([
      'demandGrowth', 'marketHealthScore', 'marketSaturation', 'priceMomentum',
      'profitStability', 'profitVelocity', 'svr', 'totalSellVolume',
    ]);
  });

  test('each value matches calling the individual function', () => {
    const result = metrics.collectProductMetrics({
      history: HISTORY,
      orders,
      svrPeriod: 30,
      productionTimeHours: 2,
      profitPerUnit: 5000,
    });

    expect(result.svr).toBe(metrics.calculateSVR(HISTORY, 30, 2));
    expect(result.profitVelocity).toBe(metrics.calculateProfitVelocity(HISTORY, 5000));
    expect(result.priceMomentum).toBe(metrics.calculatePriceMomentum(HISTORY));
    expect(result.demandGrowth).toBe(metrics.calculateDemandGrowth(HISTORY));
    expect(result.totalSellVolume).toBe(5000);
  });

  test('saturation uses the sell volume derived from the SAME orders', () => {
    const result = metrics.collectProductMetrics({
      history: HISTORY, orders, svrPeriod: 30, productionTimeHours: 2, profitPerUnit: 0,
    });

    expect(result.marketSaturation)
      .toBe(metrics.calculateMarketSaturation(HISTORY, 5000, 30));
  });

  test('survives being called with nothing at all', () => {
    const result = metrics.collectProductMetrics();
    expect(result.svr).toBe(0);
    expect(result.marketHealthScore).toBeGreaterThanOrEqual(0);
  });
});
