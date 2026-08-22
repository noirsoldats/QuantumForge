/**
 * Jest Test Setup
 *
 * This file sets up the test environment, including mocking Electron APIs
 * that are needed for the tests to run in a Node.js environment.
 */

// Mock Electron's app module
// Note: We use require() inside the mock factory to avoid Jest's out-of-scope variable error
jest.mock('electron', () => {
  const mockPath = require('path');
  const mockOs = require('os');

  return {
    app: {
      getPath: (name) => {
        // Return appropriate paths based on the path name
        switch (name) {
          case 'userData':
            // Use a consistent path for testing
            // This should point to where your SDE database actually is
            if (process.platform === 'darwin') {
              return mockPath.join(mockOs.homedir(), 'Library', 'Application Support', 'Quantum Forge');
            } else if (process.platform === 'win32') {
              return mockPath.join(mockOs.homedir(), 'AppData', 'Roaming', 'Quantum Forge');
            } else {
              return mockPath.join(mockOs.homedir(), '.config', 'Quantum Forge');
            }
          case 'appData':
            if (process.platform === 'darwin') {
              return mockPath.join(mockOs.homedir(), 'Library', 'Application Support');
            } else if (process.platform === 'win32') {
              return mockPath.join(mockOs.homedir(), 'AppData', 'Roaming');
            } else {
              return mockPath.join(mockOs.homedir(), '.config');
            }
          case 'home':
            return mockOs.homedir();
          default:
            return mockOs.homedir();
        }
      },
      getName: () => 'Quantum Forge',
      getVersion: () => '0.5.0',
    },
  };
});

/* ------------------------------------------------------------------ network
 *
 * NO TEST MAY TOUCH THE NETWORK.
 *
 * ESI's error limit is APP-WIDE, not per-endpoint, and a 4xx costs ~2.5x what a
 * success does. A test that accidentally calls ESI in a loop can therefore burn
 * the budget for the real application - and CI would do it on every run. The
 * SDE/Fuzzwork endpoints are somebody else's bandwidth too.
 *
 * The guard is installed at `net.Socket.prototype.connect` deliberately, NOT at
 * `global.fetch`:
 *
 *   - Many suites assign their own `global.fetch = jest.fn()` in beforeEach
 *     (every renderer suite does, to serve its view HTML). A guard living on
 *     global.fetch would be silently overwritten by those, leaving the illusion
 *     of protection with none of the substance.
 *   - The socket is the layer everything funnels through - verified against
 *     this Node's undici `fetch`, `http.request`, and `tls.connect`, all of
 *     which hit Socket.prototype.connect.
 *
 * Tests mock at the module boundary (`jest.mock('../../src/main/esi-fetch')`)
 * or by replacing `global.fetch`, so nothing legitimate connects. If a test
 * ever needs a real socket - a local server fixture, say - call
 * `allowNetwork()` in that test and `blockNetwork()` in its afterEach, rather
 * than deleting this.
 */
const net = require('net');

/*
 * Install ONCE per worker process.
 *
 * Jest runs this file for every test file, but test files in the same worker
 * share the `net` module - so a naive install wraps `connect` again on each
 * one. The wrappers then stack, and each closes over its own `allowed` flag:
 * the outermost says yes while an inner one still throws, so allowNetwork()
 * silently stops working (blocking still works, which is what makes it easy to
 * miss). The state therefore lives on a symbol on the shared module, and the
 * patch is applied only if it is not already there.
 */
const GUARD = Symbol.for('quantumforge.test.networkGuard');

function describeTarget(args) {
  const [first] = args;
  if (first && typeof first === 'object') {
    if (first.path) return String(first.path);
    const host = first.host || first.hostname || 'unknown-host';
    return first.port ? `${host}:${first.port}` : String(host);
  }
  // connect(port[, host]) - the positional form.
  if (typeof first === 'number' || typeof first === 'string') {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return `${host}:${first}`;
  }
  return 'unknown target';
}

if (!net[GUARD]) {
  const realSocketConnect = net.Socket.prototype.connect;

  // The single source of truth for "is network allowed", shared by every test
  // file that runs in this worker.
  const guard = { allowed: false };
  net[GUARD] = guard;

  net.Socket.prototype.connect = function guardedConnect(...args) {
    if (guard.allowed) return realSocketConnect.apply(this, args);
    throw new Error(
      `Network access is blocked in tests (tried to connect to ${describeTarget(args)}).\n`
      + 'Mock the module instead - e.g. jest.mock("../../src/main/esi-fetch") - or\n'
      + 'assign global.fetch. See the network guard in tests/setup.js.'
    );
  };
}

/** Escape hatch for a test that genuinely needs a socket (e.g. a local server). */
global.allowNetwork = () => { net[GUARD].allowed = true; };
/** Restore the block. Call in afterEach whenever allowNetwork() was used. */
global.blockNetwork = () => { net[GUARD].allowed = false; };

// Re-block between tests: an allowNetwork() a test forgets to undo must not
// leak into the next one.
beforeEach(() => { net[GUARD].allowed = false; });

// Suppress console logs during tests (optional)
// Uncomment if you want cleaner test output
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn(),
// };

// Custom Jest Matchers
expect.extend({
  /**
   * Check if a number is approximately equal to another within a tolerance
   * @param {number} received - The received value
   * @param {number} expected - The expected value
   * @param {number} tolerance - The allowed difference (default: 0.01)
   */
  toBeApproximately(received, expected, tolerance = 0.01) {
    const pass = Math.abs(received - expected) <= tolerance;
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be approximately ${expected} (tolerance: ${tolerance})`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be approximately ${expected} (tolerance: ${tolerance}), difference: ${Math.abs(received - expected)}`,
        pass: false,
      };
    }
  },

  /**
   * Check if an array of numbers is approximately equal to another array within a tolerance
   * @param {Array<number>} received - The received array
   * @param {Array<number>} expected - The expected array
   * @param {number} tolerance - The allowed difference per element (default: 0.01)
   */
  toBeApproximatelyArray(received, expected, tolerance = 0.01) {
    if (!Array.isArray(received) || !Array.isArray(expected)) {
      return {
        message: () => `expected both values to be arrays`,
        pass: false,
      };
    }

    if (received.length !== expected.length) {
      return {
        message: () =>
          `expected arrays to have same length, but got ${received.length} and ${expected.length}`,
        pass: false,
      };
    }

    for (let i = 0; i < received.length; i++) {
      if (Math.abs(received[i] - expected[i]) > tolerance) {
        return {
          message: () =>
            `expected arrays to be approximately equal, but element ${i} differs: ${received[i]} vs ${expected[i]} (tolerance: ${tolerance})`,
          pass: false,
        };
      }
    }

    return {
      message: () => `expected arrays not to be approximately equal`,
      pass: true,
    };
  },

  /**
   * Check if a material list matches expected materials within a tolerance
   * @param {Array<Object>} received - The received materials array
   * @param {Array<Object>} expected - The expected materials array
   * @param {number} tolerance - The allowed difference for quantities (default: 0.01)
   */
  toMatchMaterials(received, expected, tolerance = 0.01) {
    if (!Array.isArray(received) || !Array.isArray(expected)) {
      return {
        message: () => `expected both values to be arrays`,
        pass: false,
      };
    }

    if (received.length !== expected.length) {
      return {
        message: () =>
          `expected material lists to have same length, but got ${received.length} and ${expected.length}`,
        pass: false,
      };
    }

    // Sort both arrays by typeID for comparison
    const sortedReceived = [...received].sort((a, b) => a.typeID - b.typeID);
    const sortedExpected = [...expected].sort((a, b) => a.typeID - b.typeID);

    for (let i = 0; i < sortedReceived.length; i++) {
      const recMat = sortedReceived[i];
      const expMat = sortedExpected[i];

      if (recMat.typeID !== expMat.typeID) {
        return {
          message: () =>
            `expected material at index ${i} to have typeID ${expMat.typeID}, but got ${recMat.typeID}`,
          pass: false,
        };
      }

      if (Math.abs(recMat.quantity - expMat.quantity) > tolerance) {
        return {
          message: () =>
            `expected material ${recMat.typeID} to have quantity approximately ${expMat.quantity}, but got ${recMat.quantity} (tolerance: ${tolerance})`,
          pass: false,
        };
      }
    }

    return {
      message: () => `expected material lists not to match`,
      pass: true,
    };
  },
});
