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
