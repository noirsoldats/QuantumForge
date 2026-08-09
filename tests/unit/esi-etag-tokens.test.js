/**
 * Conditional requests (ETag / If-None-Match) and bucket-limiter token costs.
 *
 * ESI supports conditional requests: send a stored ETag back as If-None-Match
 * and an unchanged resource answers 304 with no body. Under the bucket limiter
 * a 304 costs 1 token instead of 2, transfers nothing, and - being 3xx - spends
 * no error budget at all.
 *
 * The token costs are NOT uniform (2XX=2, 3XX=1, 4XX=5, 5XX=0), which is why
 * they are modelled explicitly: a burst of 403s drains the rate bucket 2.5x
 * faster than the call count suggests.
 * https://developers.eveonline.com/docs/services/esi/rate-limiting/
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/main/esi-fetch.js'),
  'utf8'
);

/** Pull the pure cost function out of the module without booting Electron. */
function loadTokenCost() {
  const match = SOURCE.match(/function rateLimitTokenCost[\s\S]*?\n}/);
  // eslint-disable-next-line no-eval
  return eval(`(${match[0].replace('function rateLimitTokenCost', 'function')})`);
}

describe('bucket-limiter token costs', () => {
  const cost = loadTokenCost();

  test.each([
    [200, 2, 'success'],
    [204, 2, 'no content'],
    [304, 1, 'not modified'],
    [403, 5, 'forbidden'],
    [404, 5, 'not found'],
    [420, 5, 'error limited'],
    [500, 0, 'server error'],
    [503, 0, 'unavailable'],
  ])('HTTP %i costs %i tokens (%s)', (status, expected) => {
    expect(cost(status)).toBe(expected);
  });

  test('a 4xx costs 2.5x a success - the reason bursts of 403s hurt', () => {
    expect(cost(403)).toBe(cost(200) * 2.5);
  });

  test('a 304 is the cheapest non-free response', () => {
    expect(cost(304)).toBeLessThan(cost(200));
  });

  test('5xx are free, so server faults do not cost us the bucket', () => {
    expect(cost(500)).toBe(0);
  });
});

describe('ETag wiring in esiFetch', () => {
  test('conditional requests are OPT-IN', () => {
    // A 304 returns no body, so this is only safe where the caller persists its
    // previous result. Defaulting it on would silently blank data elsewhere.
    expect(SOURCE).toMatch(/useETag\s*=\s*false/);
  });

  test('If-None-Match is never sent on a paginated call', () => {
    // An ETag identifies ONE page; mixing a 304 page with fetched pages would
    // silently drop data.
    expect(SOURCE).toMatch(/useETag\s*&&\s*!policy\.paginated/);
  });

  test('a 304 short-circuits before the body is parsed', () => {
    const idx304 = SOURCE.indexOf('response.status === 304');
    const idxJson = SOURCE.indexOf('await response.json()');
    expect(idx304).toBeGreaterThan(-1);
    expect(idx304).toBeLessThan(idxJson);
  });

  test('the 304 branch returns BEFORE the ETag is stored', () => {
    // Otherwise a 304 (which carries no ETag of its own) would overwrite the
    // stored one with null and disable conditional requests from then on.
    const idxNotModified = SOURCE.indexOf('first.notModified');
    const idxStore = SOURCE.indexOf('recordETag(callKey, etag)');
    expect(idxNotModified).toBeGreaterThan(-1);
    expect(idxStore).toBeGreaterThan(-1);
    expect(idxNotModified).toBeLessThan(idxStore);
  });

  test('a 304 does NOT emit a data-changed event', () => {
    // Nothing changed; emitting would make every 304 look like fresh data.
    // Strip comments first - the block explains WHY it does not emit, and a
    // naive text match would hit that explanation instead of real code.
    const block = SOURCE.slice(
      SOURCE.indexOf('if (first.notModified)'),
      SOURCE.indexOf('// Store the ETag for next time')
    ).replace(/\/\/.*$/gm, '');

    expect(block).not.toMatch(/emitDataChanged/);
  });

  test('a 304 still refreshes the next-allowed deadline', () => {
    // It is a successful call: not re-deriving the deadline would make the
    // endpoint retry immediately and waste the saving.
    const block = SOURCE.slice(
      SOURCE.indexOf('if (first.notModified)'),
      SOURCE.indexOf('// Store the ETag for next time')
    );
    expect(block).toMatch(/recordESICallSuccess/);
    expect(block).toMatch(/nextAllowedAt/);
  });
});

describe('mutually exclusive limiter headers', () => {
  test('the code records the exclusivity of the two header sets', () => {
    // Per ESI's best-practices doc the legacy X-ESI-Error-Limit-* headers and
    // the newer bucket headers are mutually exclusive - a route on the new
    // limiter sends no error-limit headers at all. An earlier comment asserted
    // that EVERY response carries the error-limit headers, which would have
    // misled the next reader into treating their absence as a fault.
    expect(SOURCE).toMatch(/mutually exclusive/);
  });

  test('X-Ratelimit-Used is read, with the cost table as fallback', () => {
    expect(SOURCE).toMatch(/X-Ratelimit-Used/);
    expect(SOURCE).toMatch(/rateLimitTokenCost\(status\)/);
  });
});
