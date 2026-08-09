/**
 * View handoff slots
 *
 * Popping a tool out used to mean the new window re-derived everything from its
 * mount params. Fine for the Blueprint Calculator; not for Manufacturing
 * Summary or What Can I Build?, where the result is a multi-second sweep.
 * Electron cannot move DOM or live objects between windows, but the RESULTS are
 * plain data, so they can be handed over and re-rendered instead of recomputed.
 *
 * The payload deliberately does NOT travel in mount params: `openViewWindow`
 * puts params in the window's `windowKey`, so a 79 KB result set would make the
 * key unique per payload and saved bounds would never match again. Only a token
 * travels; the payload waits here.
 */

const handoff = require('../../src/main/view-handoff');

/** A realistic summary payload - 212 blueprints, the user's actual run size. */
const bigPayload = () => ({
  results: Array.from({ length: 212 }, (_, i) => ({
    blueprintTypeId: i,
    itemName: `Item ${i}`,
    profit: i * 1e6,
  })),
  sortColumn: 'profit',
  sortDirection: 'desc',
});

beforeEach(() => {
  handoff.clearAll();
  jest.restoreAllMocks();
});

describe('create and claim', () => {
  test('a claimed payload comes back intact', () => {
    const payload = bigPayload();
    const token = handoff.createHandoff('manufacturing-summary', payload);

    expect(handoff.claimHandoff(token, 'manufacturing-summary')).toEqual(payload);
  });

  test('the slot is consumed by the first reader', () => {
    // One shot: a stale token must not be able to resurrect old results into a
    // window opened later.
    const token = handoff.createHandoff('market', { a: 1 });

    expect(handoff.claimHandoff(token, 'market')).toEqual({ a: 1 });
    expect(handoff.claimHandoff(token, 'market')).toBeNull();
  });

  test('an unknown token yields null rather than throwing', () => {
    expect(handoff.claimHandoff('no-such-token', 'market')).toBeNull();
  });

  test('tokens are unique', () => {
    const a = handoff.createHandoff('market', {});
    const b = handoff.createHandoff('market', {});

    expect(a).not.toBe(b);
  });

  test('several slots coexist', () => {
    // Two windows can be popped in quick succession.
    const a = handoff.createHandoff('market', { which: 'a' });
    const b = handoff.createHandoff('facilities', { which: 'b' });

    expect(handoff.claimHandoff(b, 'facilities')).toEqual({ which: 'b' });
    expect(handoff.claimHandoff(a, 'market')).toEqual({ which: 'a' });
  });
});

describe('view binding', () => {
  test('another view cannot claim the payload', () => {
    // Params are visible in the window query. Handing Summary's rows to What
    // Can I Build? would render nonsense rather than fail loudly.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const token = handoff.createHandoff('manufacturing-summary', bigPayload());

    expect(handoff.claimHandoff(token, 'what-can-i-build')).toBeNull();
  });

  test('a mismatched claim still consumes the slot', () => {
    // Otherwise a wrong claim leaves the payload sitting there to be picked up
    // by a later window.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const token = handoff.createHandoff('manufacturing-summary', { a: 1 });

    handoff.claimHandoff(token, 'what-can-i-build');

    expect(handoff.pendingCount()).toBe(0);
    expect(handoff.claimHandoff(token, 'manufacturing-summary')).toBeNull();
  });

  test('a mismatch is logged, not silent', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const token = handoff.createHandoff('manufacturing-summary', { a: 1 });

    handoff.claimHandoff(token, 'market');

    expect(spy).toHaveBeenCalled();
  });
});

describe('expiry', () => {
  test('an unclaimed slot is dropped after its TTL', () => {
    // A window that never opened - the renderer threw during mount, say -
    // would otherwise pin a large payload for the whole session.
    const token = handoff.createHandoff('market', bigPayload());
    expect(handoff.pendingCount()).toBe(1);

    const realNow = Date.now;
    Date.now = () => realNow() + handoff.SLOT_TTL_MS + 1000;
    try {
      expect(handoff.pendingCount()).toBe(0);
      expect(handoff.claimHandoff(token, 'market')).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('a fresh slot survives while another expires', () => {
    const realNow = Date.now;
    const old = handoff.createHandoff('market', { which: 'old' });

    Date.now = () => realNow() + handoff.SLOT_TTL_MS + 1000;
    try {
      const fresh = handoff.createHandoff('market', { which: 'fresh' });

      expect(handoff.claimHandoff(old, 'market')).toBeNull();
      expect(handoff.claimHandoff(fresh, 'market')).toEqual({ which: 'fresh' });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('payload size', () => {
  test('a full result set survives the round trip', () => {
    // ~79 KB for a 212-blueprint summary. Structured-clone territory; this is
    // the case the whole mechanism exists for.
    const payload = bigPayload();
    const token = handoff.createHandoff('manufacturing-summary', payload);
    const claimed = handoff.claimHandoff(token, 'manufacturing-summary');

    expect(claimed.results).toHaveLength(212);
    expect(claimed.results[211].itemName).toBe('Item 211');
    expect(claimed.sortColumn).toBe('profit');
  });
});
