/**
 * Golden-Value Fixtures for Regression Testing
 *
 * Explicit, hand-derived (and cross-checked against the real implementation
 * once, at fixture-authoring time — see tests/unit/golden-values.test.js's
 * header comment) expected outputs for the core pricing-method formulas.
 *
 * These use the SAME Tritanium sell-order/history dataset as
 * tests/fixtures/db/pricing-consistency.market.db (see that directory's
 * README) and tests/unit/fixtures/market-data.js's tritaniumOrders, so a
 * discrepancy here cross-checks against those too.
 *
 * ME/TE material-quantity golden values and invention-probability golden
 * values already exist and are well covered in
 * tests/unit/fixtures/blueprints.js (scourgeExpectedMaterials) and
 * tests/unit/fixtures/skills.js (expectedInventionProbabilities) — this file
 * does not duplicate those. It fills the one gap not yet pinned anywhere:
 * calculateRealisticPrice's per-method price selection against one canonical
 * order book, values.
 */

// Tritanium (typeID 34) sell orders in The Forge — same data as
// tests/unit/fixtures/market-data.js's tritaniumOrders.sell and
// tests/fixtures/db/pricing-consistency.market.db
const tritaniumSellOrders = [
  { order_id: 6, price: 6.52, volume_remain: 15000000, is_buy_order: false, location_id: 60003760 },
  { order_id: 7, price: 6.53, volume_remain: 12000000, is_buy_order: false, location_id: 60003760 },
  { order_id: 8, price: 6.55, volume_remain: 8000000, is_buy_order: false, location_id: 60003760 },
  { order_id: 9, price: 6.60, volume_remain: 5000000, is_buy_order: false, location_id: 60003760 },
  { order_id: 10, price: 6.75, volume_remain: 3000000, is_buy_order: false, location_id: 60003760 },
];

// 5 days of Tritanium history — same data as
// tests/fixtures/db/pricing-consistency.market.db
const tritaniumHistory = [
  { date: '2026-06-28', average: 6.40, volume: 50000000 },
  { date: '2026-06-29', average: 6.42, volume: 48000000 },
  { date: '2026-06-30', average: 6.38, volume: 52000000 },
  { date: '2026-07-01', average: 6.41, volume: 49000000 },
  { date: '2026-07-02', average: 6.39, volume: 51000000 },
];

// Expected price selection per method, hand-derived from the order book
// above (total sell volume = 43,000,000):
//  - percentile @ 0.2: target volume = 43M * 0.2 = 8.6M; cumulative volume
//    reaches 15M (>= 8.6M) at the very first (cheapest) order -> 6.52
//  - vwap @ 20,000,000 units: fills 15M @ 6.52 (=97.8) + 5M @ 6.53 (=32.65)
//    = 130.45 / 20M = 6.5225
//  - vwap @ 1,000,000 units: fills entirely from the cheapest order -> 6.52
//  - historical (5-day average of the `average` column) -> 6.40
const pricingGolden = [
  {
    description: 'percentile method, 0.2 percentile, full sell book',
    method: 'percentile',
    percentile: 0.2,
    expectedPrice: 6.52,
  },
  {
    description: 'vwap method, 20,000,000 unit order spanning 2 sell orders',
    method: 'vwap',
    quantity: 20000000,
    expectedPrice: 6.5225,
  },
  {
    description: 'vwap method, 1,000,000 unit order filled by cheapest order alone',
    method: 'vwap',
    quantity: 1000000,
    expectedPrice: 6.52,
  },
  {
    description: 'historical method, 5-day average',
    method: 'historical',
    historyDays: 5,
    expectedPrice: 6.40,
  },
];

module.exports = {
  tritaniumSellOrders,
  tritaniumHistory,
  pricingGolden,
};
