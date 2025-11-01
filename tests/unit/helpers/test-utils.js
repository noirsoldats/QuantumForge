/**
 * Common Test Utilities
 *
 * Provides helper functions and custom matchers for testing
 */

/**
 * Compare floating point numbers with tolerance
 * @param {number} actual - Actual value
 * @param {number} expected - Expected value
 * @param {number} tolerance - Tolerance (default 0.0001)
 * @returns {boolean} Whether values are approximately equal
 */
function approximatelyEqual(actual, expected, tolerance = 0.0001) {
  return Math.abs(actual - expected) < tolerance;
}

/**
 * Custom Jest matcher for approximate equality
 */
expect.extend({
  toBeApproximately(received, expected, tolerance = 0.0001) {
    const pass = Math.abs(received - expected) < tolerance;
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be approximately ${expected} (tolerance: ${tolerance})`,
        pass: true
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be approximately ${expected} (tolerance: ${tolerance}), difference: ${Math.abs(received - expected)}`,
        pass: false
      };
    }
  }
});

/**
 * Custom Jest matcher for array approximate equality
 */
expect.extend({
  toBeApproximatelyArray(received, expected, tolerance = 0.0001) {
    if (received.length !== expected.length) {
      return {
        message: () =>
          `expected array length ${received.length} to equal ${expected.length}`,
        pass: false
      };
    }

    for (let i = 0; i < received.length; i++) {
      if (Math.abs(received[i] - expected[i]) >= tolerance) {
        return {
          message: () =>
            `expected ${received[i]} at index ${i} to be approximately ${expected[i]} (tolerance: ${tolerance})`,
          pass: false
        };
      }
    }

    return {
      message: () => `expected arrays not to be approximately equal`,
      pass: true
    };
  }
});

/**
 * Custom Jest matcher for material lists (compares by typeID and quantity)
 */
expect.extend({
  toMatchMaterials(received, expected, tolerance = 0) {
    if (!Array.isArray(received) || !Array.isArray(expected)) {
      return {
        message: () => 'expected both arguments to be arrays',
        pass: false
      };
    }

    if (received.length !== expected.length) {
      return {
        message: () =>
          `expected ${received.length} materials, received ${expected.length}`,
        pass: false
      };
    }

    // Sort both arrays by typeID for comparison
    const sortedReceived = [...received].sort((a, b) => a.typeID - b.typeID);
    const sortedExpected = [...expected].sort((a, b) => a.typeID - b.typeID);

    for (let i = 0; i < sortedReceived.length; i++) {
      const rec = sortedReceived[i];
      const exp = sortedExpected[i];

      if (rec.typeID !== exp.typeID) {
        return {
          message: () =>
            `expected typeID ${rec.typeID} to equal ${exp.typeID} at position ${i}`,
          pass: false
        };
      }

      const quantityDiff = Math.abs(rec.quantity - exp.quantity);
      if (quantityDiff > tolerance) {
        return {
          message: () =>
            `expected quantity ${rec.quantity} to be within ${tolerance} of ${exp.quantity} for typeID ${rec.typeID}`,
          pass: false
        };
      }
    }

    return {
      message: () => 'expected materials not to match',
      pass: true
    };
  }
});

/**
 * Create a mock price function that returns fixed prices
 * @param {Object} priceMap - Map of typeID to price
 * @returns {Function} Mock price function
 */
function createMockPriceFunction(priceMap) {
  return jest.fn((typeId) => {
    return priceMap[typeId] || 0;
  });
}

/**
 * Create mock material prices for common materials
 * @returns {Object} Price map
 */
function createMockMaterialPrices() {
  return {
    34: 6.50,      // Tritanium
    35: 13.00,     // Pyerite
    36: 52.00,     // Mexallon
    37: 104.00,    // Isogen
    38: 520.00,    // Nocxium
    39: 1040.00,   // Zydrine
    40: 5200.00,   // Megacyte
    11399: 26000.00 // Morphite
  };
}

/**
 * Calculate expected VWAP manually (for validation)
 * @param {Array} orders - Market orders
 * @param {number} quantity - Quantity to calculate for
 * @param {boolean} isBuy - Whether buying or selling
 * @returns {number} Expected VWAP
 */
function calculateExpectedVWAP(orders, quantity, isBuy) {
  const sortedOrders = [...orders]
    .filter(o => o.is_buy_order === isBuy)
    .sort((a, b) => isBuy ? (b.price - a.price) : (a.price - b.price));

  let remaining = quantity;
  let totalCost = 0;
  let totalVolume = 0;

  for (const order of sortedOrders) {
    const available = order.volume_remain;
    const toTake = Math.min(remaining, available);

    totalCost += toTake * order.price;
    totalVolume += toTake;
    remaining -= toTake;

    if (remaining <= 0) break;
  }

  return totalVolume > 0 ? totalCost / totalVolume : 0;
}

/**
 * Calculate expected percentile price (for validation)
 * @param {Array} orders - Market orders
 * @param {boolean} isBuy - Whether buying or selling
 * @param {number} percentile - Percentile (0-1)
 * @returns {number} Expected percentile price
 */
function calculateExpectedPercentile(orders, isBuy, percentile) {
  const prices = orders
    .filter(o => o.is_buy_order === isBuy)
    .map(o => o.price)
    .sort((a, b) => a - b);

  if (prices.length === 0) return 0;

  const index = Math.floor(prices.length * percentile);
  return prices[Math.min(index, prices.length - 1)];
}

/**
 * Calculate expected material quantity with ME bonus
 * @param {number} baseQuantity - Base quantity
 * @param {number} meLevel - ME level (0-10)
 * @param {number} runs - Number of runs
 * @param {Object} facility - Facility data (optional)
 * @returns {number} Expected quantity
 */
function calculateExpectedMaterialQuantity(baseQuantity, meLevel, runs, facility = null) {
  let quantity = runs * baseQuantity * (1 - meLevel / 100);

  // Apply structure bonus (1% for Upwell)
  if (facility && facility.structureTypeId) {
    quantity = quantity * 0.99;  // 1% reduction
  }

  // Apply rig bonuses (if any)
  if (facility && facility.rigs && facility.rigs.length > 0) {
    for (const rig of facility.rigs) {
      if (rig.bonusType === 'materialEfficiency') {
        // Rig bonus is negative (reduces materials further)
        quantity = quantity * (1 + rig.bonusValue / 100);
      }
    }
  }

  // Result cannot be less than runs
  return Math.max(runs, Math.ceil(quantity));
}

/**
 * Wait for async operations to complete (useful for cache tests)
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise} Promise that resolves after delay
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Suppress console output during tests
 * @param {Function} testFn - Test function to run with suppressed output
 * @returns {*} Result of test function
 */
async function suppressConsole(testFn) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();

  try {
    const result = await testFn();
    return result;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

/**
 * Create a spy on console methods for testing logging
 * @returns {Object} Console spies
 */
function createConsoleSpy() {
  return {
    log: jest.spyOn(console, 'log').mockImplementation(),
    error: jest.spyOn(console, 'error').mockImplementation(),
    warn: jest.spyOn(console, 'warn').mockImplementation(),
    restore: () => {
      console.log.mockRestore();
      console.error.mockRestore();
      console.warn.mockRestore();
    }
  };
}

/**
 * Generate a range of numbers for parameterized tests
 * @param {number} start - Start value
 * @param {number} end - End value
 * @param {number} step - Step size
 * @returns {Array} Array of numbers
 */
function range(start, end, step = 1) {
  const result = [];
  for (let i = start; i <= end; i += step) {
    result.push(i);
  }
  return result;
}

/**
 * Create test cases for parameterized tests
 * @param {Array} inputs - Array of input values
 * @param {Function} transform - Function to transform each input
 * @returns {Array} Array of test cases
 */
function createTestCases(inputs, transform) {
  return inputs.map(input => {
    const result = transform(input);
    return Array.isArray(result) ? result : [input, result];
  });
}

module.exports = {
  approximatelyEqual,
  createMockPriceFunction,
  createMockMaterialPrices,
  calculateExpectedVWAP,
  calculateExpectedPercentile,
  calculateExpectedMaterialQuantity,
  wait,
  suppressConsole,
  createConsoleSpy,
  range,
  createTestCases
};
