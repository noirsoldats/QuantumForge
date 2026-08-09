/**
 * ESI error-budget governor.
 *
 * ESI's error limit is APPLICATION-WIDE: ~100 errored requests per 60s across
 * every endpoint. Exceed it and ESI returns 420 for everything, including
 * calls that would have succeeded. One screen resolving a structure per asset
 * burned the whole window on 403s and took the background refresh cycle down
 * with it - which is what this module exists to prevent.
 *
 * The two properties that matter are the RESERVE (gate above zero, not at the
 * last error) and ATTRIBUTION (name the offender so a user can report it).
 */

const budget = require('../../src/main/esi-error-budget');

/** Minimal Headers stand-in - only .get() is used. */
function headers(map) {
  return { get: (name) => (name in map ? map[name] : null) };
}

beforeEach(() => {
  budget.reset();
});

describe('reading the headers', () => {
  test('records remaining and reset from any response', async () => {
    budget.recordHeaders(headers({
      'X-ESI-Error-Limit-Remain': '87',
      'X-ESI-Error-Limit-Reset': '42',
    }), 1_000_000);

    const status = budget.getStatus();
    expect(status.remaining).toBe(87);
    expect(status.resetAt).toBe(1_000_000 + 42_000);
  });

  test('ignores a response without the headers', () => {
    budget.recordHeaders(headers({}));
    expect(budget.getStatus().remaining).toBeNull();
  });

  test('survives a null headers object', () => {
    expect(() => budget.recordHeaders(null)).not.toThrow();
  });
});

describe('spending', () => {
  test('allows calls before anything is known', () => {
    // The first call is what teaches us the state, so it must go out.
    expect(budget.canSpend().allowed).toBe(true);
  });

  test('allows calls with healthy budget', () => {
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '95' }));
    expect(budget.canSpend().allowed).toBe(true);
  });

  test('RESERVES headroom - background calls stop well above zero', () => {
    // The whole point: do not spend down to the last error.
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '25' }));

    const result = budget.canSpend();
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('reserved');
    expect(result.remaining).toBe(25);
  });

  test('a user-initiated call still goes through inside the reserve', () => {
    // The reserve exists so an action someone just took is not refused
    // because a background sweep spent the budget.
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '25' }));

    expect(budget.canSpend({ userInitiated: true }).allowed).toBe(true);
  });

  test('below CRITICAL even user-initiated calls stop', () => {
    // 420 is imminent; letting anything through only deepens the hole.
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '5' }));

    const result = budget.canSpend({ userInitiated: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('critical');
  });

  test('the reserve sits above the critical threshold', () => {
    expect(budget.RESERVE_THRESHOLD).toBeGreaterThan(budget.CRITICAL_THRESHOLD);
    expect(budget.CRITICAL_THRESHOLD).toBeGreaterThan(0);
  });
});

describe('a 420 blocks everything', () => {
  test('nothing goes out until the retry deadline', () => {
    budget.recordBlocked(Date.now() + 30_000);

    expect(budget.canSpend().allowed).toBe(false);
    expect(budget.canSpend({ userInitiated: true }).allowed).toBe(false);
    expect(budget.getStatus().isBlocked).toBe(true);
  });

  test('calls resume once the deadline passes', () => {
    budget.recordBlocked(Date.now() - 1000);

    expect(budget.canSpend().allowed).toBe(true);
    expect(budget.getStatus().isBlocked).toBe(false);
  });

  test('emits a blocked event naming the offenders', () => {
    const seen = [];
    budget.bus.once('blocked', (p) => seen.push(p));

    budget.recordError('structure', 'structure_1054095650865', 'HTTP 403');
    budget.recordError('structure', 'structure_1054095650866', 'HTTP 403');
    budget.recordBlocked(Date.now() + 30_000);

    expect(seen).toHaveLength(1);
    expect(seen[0].offenders[0]).toMatchObject({ endpointType: 'structure', count: 2 });
  });
});

describe('attribution', () => {
  test('counts errors per endpoint', () => {
    budget.recordError('structure', 'structure_1', 'HTTP 403');
    budget.recordError('structure', 'structure_2', 'HTTP 403');
    budget.recordError('corporation_industry_jobs', 'corp_1_jobs', 'HTTP 420');

    const offenders = budget.topOffenders();
    expect(offenders[0]).toMatchObject({ endpointType: 'structure', count: 2 });
    expect(offenders[1]).toMatchObject({ endpointType: 'corporation_industry_jobs', count: 1 });
  });

  test('keeps a few sample call keys, not thousands', () => {
    // A user needs enough to reproduce; the full set could be every asset.
    for (let i = 0; i < 500; i += 1) {
      budget.recordError('structure', `structure_${i}`, 'HTTP 403');
    }

    const [offender] = budget.topOffenders();
    expect(offender.count).toBe(500);
    expect(offender.sampleCallKeys.length).toBeLessThanOrEqual(3);
  });

  test('getStatus carries everything needed to report a problem', () => {
    budget.recordHeaders(headers({
      'X-ESI-Error-Limit-Remain': '12',
      'X-ESI-Error-Limit-Reset': '30',
    }));
    budget.recordError('structure', 'structure_1', 'HTTP 403');

    const status = budget.getStatus();
    expect(status).toMatchObject({ remaining: 12, isLow: true });
    expect(status.offenders[0].endpointType).toBe('structure');
    expect(status.reserveThreshold).toBe(budget.RESERVE_THRESHOLD);
  });
});

describe('warning the user', () => {
  test('emits once when the budget enters the reserve', () => {
    const seen = [];
    budget.bus.on('low', (p) => seen.push(p));

    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '20' }));

    expect(seen).toHaveLength(1);
    expect(seen[0].remaining).toBe(20);
    budget.bus.removeAllListeners('low');
  });

  test('does not repeat the warning for the same episode', () => {
    // Otherwise a burst of failing calls emits a warning per call.
    const seen = [];
    budget.bus.on('low', (p) => seen.push(p));

    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '20' }));
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '18' }));
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '15' }));

    expect(seen).toHaveLength(1);
    budget.bus.removeAllListeners('low');
  });

  test('stays quiet while the budget is healthy', () => {
    const seen = [];
    budget.bus.on('low', (p) => seen.push(p));

    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '95' }));

    expect(seen).toHaveLength(0);
    budget.bus.removeAllListeners('low');
  });
});

describe('window reset', () => {
  test('a new window clears the offenders and re-arms the warning', () => {
    const now = 1_000_000;
    budget.recordHeaders(headers({
      'X-ESI-Error-Limit-Remain': '15',
      'X-ESI-Error-Limit-Reset': '10',
    }), now);
    budget.recordError('structure', 'structure_1', 'HTTP 403');
    expect(budget.topOffenders()).toHaveLength(1);

    // A response after the window rolled over.
    budget.recordHeaders(headers({ 'X-ESI-Error-Limit-Remain': '100' }), now + 11_000);

    expect(budget.topOffenders()).toHaveLength(0);
    expect(budget.canSpend().allowed).toBe(true);
  });
});
