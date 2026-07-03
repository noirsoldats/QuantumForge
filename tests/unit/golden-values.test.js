/**
 * Golden-Value Regression Tests
 *
 * Pins calculateVWAP / calculatePercentilePrice / calculateHistoricalAverage
 * against hand-derived expected prices (see tests/unit/fixtures/golden-values.js
 * for the derivation of each expected value) so a future change that shifts
 * price-selection math is caught immediately, rather than only being noticed
 * as a symptom (e.g. "Manufacturing Plans shows a different price than
 * Blueprint Calculator").
 *
 * Explicit expected values, not snapshots: a snapshot would just freeze
 * "whatever the code currently outputs" as truth, which is the opposite of
 * what a correctness regression suite needs. Snapshots remain appropriate
 * for shape/structure tests (see tests/unit/blueprint-tree.test.js) but not
 * for pinning numeric correctness.
 *
 * ME/TE material-quantity and invention-probability golden values already
 * exist in tests/unit/blueprint-calculator-pure.test.js and
 * tests/unit/invention-system.test.js (via tests/unit/fixtures/blueprints.js's
 * scourgeExpectedMaterials and tests/unit/fixtures/skills.js's
 * expectedInventionProbabilities) — not duplicated here.
 */

const { calculateVWAP, calculatePercentilePrice, calculateHistoricalAverage } = require('../../src/main/market-pricing');
const { tritaniumSellOrders, tritaniumHistory, pricingGolden } = require('./fixtures/golden-values');

describe('Golden values — price method selection', () => {
  test.each(pricingGolden)('$description', (testCase) => {
    let actualPrice;

    switch (testCase.method) {
      case 'percentile':
        actualPrice = calculatePercentilePrice(tritaniumSellOrders, false, testCase.percentile);
        break;
      case 'vwap':
        actualPrice = calculateVWAP(tritaniumSellOrders, testCase.quantity, false).price;
        break;
      case 'historical':
        actualPrice = calculateHistoricalAverage(tritaniumHistory, 'average', testCase.historyDays);
        break;
      default:
        throw new Error(`Unknown golden test method: ${testCase.method}`);
    }

    expect(actualPrice).toBeCloseTo(testCase.expectedPrice, 4);
  });
});
