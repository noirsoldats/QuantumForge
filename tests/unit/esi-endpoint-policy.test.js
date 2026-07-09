/**
 * Guard test: every endpointType that flows through esiFetch must have an
 * ENDPOINT_POLICY entry. If a new endpoint is added without a policy, esiFetch
 * throws at runtime — this test catches that at CI time instead.
 *
 * The list below is the set of tracked endpointType strings passed to
 * recordESICallStart across the esi-*.js modules.
 */

// esi-fetch pulls in settings-manager/esi-auth at require time; stub them so
// requiring the policy map is side-effect free.
jest.mock('../../src/main/esi-auth', () => ({ refreshAccessToken: jest.fn(), isTokenExpired: jest.fn() }));
jest.mock('../../src/main/settings-manager', () => ({ getCharacter: jest.fn(), updateCharacterTokens: jest.fn() }));
jest.mock('../../src/main/user-agent', () => ({ getUserAgent: jest.fn(() => 'QF/test') }));
jest.mock('../../src/main/esi-status-tracker', () => ({
  recordESICallStart: jest.fn(),
  recordESICallSuccess: jest.fn(),
  recordESICallError: jest.fn(),
  recordRateLimit: jest.fn(),
  canFetchEndpoint: jest.fn(() => true),
}));

const { ENDPOINT_POLICY } = require('../../src/main/esi-fetch');

// Kept in sync with the endpointType strings passed to recordESICallStart.
const TRACKED_ENDPOINT_TYPES = [
  'industry_jobs',
  'corporation_industry_jobs',
  'wallet_transactions',
  'corporation_wallet_transactions',
  'wallet_journal',
  'corporation_wallet_journal',
  'skills',
  'assets',
  'corporation_assets',
  'blueprints',
  'corporation_blueprints',
  'corporation_divisions',
  'market_orders',
  'market_history',
  'adjusted_prices',
  'cost_indices',
  'server_status',
];

describe('ENDPOINT_POLICY coverage', () => {
  test.each(TRACKED_ENDPOINT_TYPES)('has a policy entry for "%s"', (endpointType) => {
    const policy = ENDPOINT_POLICY[endpointType];
    expect(policy).toBeDefined();
    expect(typeof policy.group).toBe('string');
    expect(typeof policy.minIntervalMs).toBe('number');
    expect(typeof policy.paginated).toBe('boolean');
  });

  test('every policy entry is well-formed', () => {
    for (const [key, policy] of Object.entries(ENDPOINT_POLICY)) {
      try {
        expect(policy.group).toBeTruthy();
        expect(policy.minIntervalMs).toBeGreaterThan(0);
        expect(typeof policy.paginated).toBe('boolean');
      } catch (err) {
        throw new Error(`Malformed ENDPOINT_POLICY entry "${key}": ${err.message}`);
      }
    }
  });
});
