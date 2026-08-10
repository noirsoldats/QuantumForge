/**
 * Unit tests for the central esiFetch wrapper.
 *
 * Covers: token refresh + ESI_TOKEN_REFRESH_FAILED; expires -> cacheExpiresAt;
 * X-Ratelimit-* parsing + recording; nextAllowedAt = max(cache, floor, retryAfter);
 * 429/420 -> ESI_RATE_LIMITED + next_allowed_at set with NO retry; ESI_SCOPE_ERROR
 * vs role-403; X-Pages pagination; skipGate bypass; the gate skip-sentinel; and
 * the universe (token-less) path.
 */

const CHARACTER_ID = 123456789;

jest.mock('../../src/main/esi-auth', () => ({
  refreshAccessToken: jest.fn(),
  isTokenExpired: jest.fn(),
}));

jest.mock('../../src/main/settings-manager', () => ({
  getCharacter: jest.fn(),
  updateCharacterTokens: jest.fn(),
}));

jest.mock('../../src/main/user-agent', () => ({
  getUserAgent: jest.fn(() => 'QuantumForge/test'),
}));

jest.mock('../../src/main/esi-status-tracker', () => ({
  recordESICallStart: jest.fn(),
  recordESICallSuccess: jest.fn(),
  recordESICallError: jest.fn(),
  recordRateLimit: jest.fn(),
  canFetchEndpoint: jest.fn(() => true),
}));

const mockCharacter = {
  characterId: CHARACTER_ID,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 100000,
  scopes: [],
};

/** Build a fetch Response mock with a headers.get map. */
function makeResponse({ status = 200, ok = status >= 200 && status < 300, body = [], headers = {} } = {}) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (name) => (name in headers ? headers[name] : null) },
  };
}

let esiFetch, canFetchEndpoint;
let refreshAccessToken, isTokenExpired, getCharacter, updateCharacterTokens;
let tracker;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
  ({ getCharacter, updateCharacterTokens } = require('../../src/main/settings-manager'));
  tracker = require('../../src/main/esi-status-tracker');
  ({ esiFetch, canFetchEndpoint } = require('../../src/main/esi-fetch'));

  isTokenExpired.mockReturnValue(false);
  getCharacter.mockReturnValue({ ...mockCharacter });
  updateCharacterTokens.mockReturnValue(true);
  tracker.canFetchEndpoint.mockReturnValue(true);

  global.fetch = jest.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe('token refresh', () => {
  test('refreshes an expired token before fetching', async () => {
    isTokenExpired.mockReturnValue(true);
    refreshAccessToken.mockResolvedValue({ access_token: 'new', refresh_token: 'r', expires_in: 1200 });
    getCharacter
      .mockReturnValueOnce({ ...mockCharacter })
      .mockReturnValueOnce({ ...mockCharacter, accessToken: 'new' });
    global.fetch.mockResolvedValue(makeResponse({ body: [] }));

    await esiFetch('skills', 'character_1_skills', 'https://x/', { characterId: CHARACTER_ID });

    expect(refreshAccessToken).toHaveBeenCalled();
    expect(updateCharacterTokens).toHaveBeenCalled();
  });

  test('tags ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
    isTokenExpired.mockReturnValue(true);
    refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    let caught;
    try {
      await esiFetch('skills', 'character_1_skills', 'https://x/', { characterId: CHARACTER_ID });
    } catch (e) { caught = e; }
    expect(caught.code).toBe('ESI_TOKEN_REFRESH_FAILED');
    expect(caught.characterId).toBe(CHARACTER_ID);
  });
});

describe('header parsing', () => {
  test('parses expires into cacheExpiresAt', async () => {
    const expiresStr = new Date(Date.now() + 300000).toUTCString();
    global.fetch.mockResolvedValue(makeResponse({ body: [1, 2], headers: { expires: expiresStr } }));

    const result = await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID });
    expect(result.cacheExpiresAt).toBe(new Date(expiresStr).getTime());
  });

  test('records X-Ratelimit-* headers', async () => {
    global.fetch.mockResolvedValue(makeResponse({
      body: [],
      headers: {
        'X-Ratelimit-Remaining': '99',
        'X-Ratelimit-Limit': '150/15m',
        'X-Ratelimit-Group': 'character',
      },
    }));

    await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID });

    expect(tracker.recordRateLimit).toHaveBeenCalledWith('k', expect.objectContaining({
      remaining: 99, limit: '150/15m', group: 'character',
    }));
  });

  test('nextAllowedAt = max(cacheExpiresAt, now + floor)', async () => {
    const farExpiry = Date.now() + 2 * 60 * 60 * 1000; // 2h — beyond the wallet floor
    global.fetch.mockResolvedValue(makeResponse({
      body: [],
      headers: { expires: new Date(farExpiry).toUTCString() },
    }));

    const result = await esiFetch('wallet_transactions', 'k', 'https://x/', { characterId: CHARACTER_ID });
    // Cache expiry dominates the 30-min floor here.
    expect(result.nextAllowedAt).toBe(new Date(new Date(farExpiry).toUTCString()).getTime());
  });
});

describe('rate limiting', () => {
  test('429 with Retry-After throws ESI_RATE_LIMITED and does not retry', async () => {
    const retryAfterSec = 120;
    global.fetch.mockResolvedValue(makeResponse({
      status: 429, ok: false,
      headers: { 'Retry-After': String(retryAfterSec) },
    }));

    let caught;
    try {
      await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID });
    } catch (e) { caught = e; }

    expect(caught.code).toBe('ESI_RATE_LIMITED');
    expect(global.fetch).toHaveBeenCalledTimes(1); // no blind retry
    expect(tracker.recordRateLimit).toHaveBeenCalledWith('k', expect.objectContaining({
      retryAfterAt: expect.any(Number),
    }));
  });

  test('420 legacy error-limit throws ESI_RATE_LIMITED', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 420, ok: false, headers: {} }));

    let caught;
    try {
      await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID });
    } catch (e) { caught = e; }
    expect(caught.code).toBe('ESI_RATE_LIMITED');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('403 handling', () => {
  test('scope error tags ESI_SCOPE_ERROR', async () => {
    global.fetch.mockResolvedValue(makeResponse({
      status: 403, ok: false, body: '{"error":"token not valid for scope"}',
    }));

    let caught;
    try {
      await esiFetch('corporation_industry_jobs', 'k', 'https://x/', { characterId: CHARACTER_ID });
    } catch (e) { caught = e; }
    expect(caught.code).toBe('ESI_SCOPE_ERROR');
  });

  test('role-based 403 returns roleForbidden empty (no throw)', async () => {
    global.fetch.mockResolvedValue(makeResponse({
      status: 403, ok: false, body: '{"error":"Character does not have required role"}',
    }));

    const result = await esiFetch('corporation_industry_jobs', 'k', 'https://x/', { characterId: CHARACTER_ID });
    expect(result.roleForbidden).toBe(true);
    expect(result.data).toEqual([]);
  });
});

describe('pagination', () => {
  test('honors X-Pages and concatenates pages', async () => {
    global.fetch
      .mockResolvedValueOnce(makeResponse({ body: [1, 2], headers: { 'X-Pages': '2' } }))
      .mockResolvedValueOnce(makeResponse({ body: [3, 4] }));

    const result = await esiFetch('corporation_industry_jobs', 'k', 'https://x/', { characterId: CHARACTER_ID });
    expect(result.data).toEqual([1, 2, 3, 4]);
    expect(result.pages).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('non-paginated endpoint makes a single request', async () => {
    global.fetch.mockResolvedValue(makeResponse({ body: [1], headers: { 'X-Pages': '5' } }));
    await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  /*
   * onProgress reports the COUNT of pages fetched, never the number of the page
   * that finished last. With parallelPages the pages resolve out of order, so
   * reporting the page number made the Market Manager bar jump backwards and
   * overstate itself - page 5 arriving first claimed 5 of 5 done.
   */
  describe('onProgress counts pages, not page numbers', () => {
    /** Resolve page N only when its turn comes in `order`. */
    function mockPagesResolvingInOrder(totalPages, order) {
      const gates = new Map();
      global.fetch.mockImplementation((url) => {
        const m = /[?&]page=(\d+)/.exec(url);
        const page = m ? parseInt(m[1], 10) : 1;
        if (page === 1) {
          return Promise.resolve(makeResponse({
            body: [1], headers: { 'X-Pages': String(totalPages) },
          }));
        }
        return new Promise((resolve) => {
          gates.set(page, () => resolve(makeResponse({ body: [page] })));
        });
      });
      // Release the gates in the requested order, once all are registered.
      const release = async () => {
        for (const page of order) {
          while (!gates.has(page)) await Promise.resolve();
          gates.get(page)();
          await Promise.resolve();
        }
      };
      return release;
    }

    test('reports a strictly increasing count when pages finish out of order', async () => {
      const seen = [];
      // 5 pages total; 2..5 come back scrambled.
      const release = mockPagesResolvingInOrder(5, [4, 2, 5, 3]);

      const p = esiFetch('market_orders', 'k', 'https://x/', {
        requiresAuth: false,
        skipGate: true,
        parallelPages: true,
        onProgress: (prog) => seen.push(prog),
      });
      await release();
      await p;

      // Page 1 is already in hand, so the first report is 2.
      expect(seen.map(s => s.currentPage)).toEqual([2, 3, 4, 5]);
      expect(seen.every(s => s.totalPages === 5)).toBe(true);
      expect(seen[seen.length - 1].progress).toBe(100);
    });

    test('a page that fails out is NOT counted, and is reported as partial', async () => {
      const seen = [];
      // Page 1 carries X-Pages, page 2 fails out, page 3 succeeds. NOTE: page 1
      // is itself requested as `page=1`, so it must be matched BEFORE the
      // generic `page=` branch - otherwise X-Pages never lands, totalPages
      // stays 1, and the pagination path never runs at all.
      global.fetch.mockImplementation((url) => {
        if (/[?&]page=1(&|$)/.test(url)) {
          return Promise.resolve(makeResponse({ body: [1], headers: { 'X-Pages': '3' } }));
        }
        // A 500 throws straight out of fetchOne with no retry/backoff; a
        // transport rejection would burn ~7s of real retry delay here. Either
        // way it reaches the tolerated-failure catch already fully failed.
        if (/[?&]page=2(&|$)/.test(url)) {
          return Promise.resolve(makeResponse({ status: 500, body: 'boom' }));
        }
        return Promise.resolve(makeResponse({ body: [9] }));
      });

      const result = await esiFetch('market_orders', 'k', 'https://x/', {
        requiresAuth: false,
        skipGate: true,
        parallelPages: true,
        onProgress: (prog) => seen.push(prog),
      });

      // Only the ONE page that succeeded is counted. Progress stops at 2 of 3 -
      // a failed page must never be painted over as completed.
      expect(seen.map(s => s.currentPage)).toEqual([2]);
      expect(seen[seen.length - 1].progress).toBeCloseTo(66.67, 1);

      // ...and the shortfall is surfaced, so the caller can raise an error
      // rather than reporting a clean refresh over missing orders.
      expect(result.partial).toBe(true);
      expect(result.failedPages).toHaveLength(1);
      expect(result.failedPages[0].page).toBe(2);
      // Page 2's orders are genuinely absent from the data.
      expect(result.data).toEqual([1, 9]);
    });

    test('a fully successful paginated fetch is not flagged partial', async () => {
      const result = await (async () => {
        global.fetch.mockImplementation((url) => (
          /[?&]page=1(&|$)/.test(url)
            ? Promise.resolve(makeResponse({ body: [1], headers: { 'X-Pages': '2' } }))
            : Promise.resolve(makeResponse({ body: [2] }))
        ));
        return esiFetch('market_orders', 'k', 'https://x/', {
          requiresAuth: false, skipGate: true, parallelPages: true,
        });
      })();

      expect(result.partial).toBeUndefined();
      expect(result.failedPages).toBeUndefined();
      expect(result.data).toEqual([1, 2]);
    });
  });
});

describe('gate', () => {
  test('skipped sentinel when not eligible', async () => {
    tracker.canFetchEndpoint.mockReturnValue(false);
    const result = await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID });
    expect(result.skipped).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(tracker.recordESICallStart).not.toHaveBeenCalled();
  });

  test('skipGate bypasses the gate', async () => {
    tracker.canFetchEndpoint.mockReturnValue(false);
    global.fetch.mockResolvedValue(makeResponse({ body: [] }));
    const result = await esiFetch('skills', 'k', 'https://x/', { characterId: CHARACTER_ID, skipGate: true });
    expect(result.skipped).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });
});

describe('universe (token-less) path', () => {
  test('does not attempt token refresh when requiresAuth is false', async () => {
    global.fetch.mockResolvedValue(makeResponse({ body: { players: 30000 } }));
    const result = await esiFetch('server_status', 'universe_server_status', 'https://x/status/', {
      requiresAuth: false, category: 'universe',
    });
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(getCharacter).not.toHaveBeenCalled();
    expect(result.data.players).toBe(30000);
  });
});

describe('emptyStatuses (market)', () => {
  test('400 is treated as expected-empty, not an error', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 400, ok: false, headers: {} }));
    const result = await esiFetch('market_orders', 'k', 'https://x/', {
      requiresAuth: false, skipGate: true, emptyStatuses: [400, 404],
    });
    expect(result.empty).toBe(true);
    expect(result.data).toEqual([]);
  });
});

describe('canFetchEndpoint re-export', () => {
  test('delegates to the status tracker', () => {
    tracker.canFetchEndpoint.mockReturnValue(true);
    expect(canFetchEndpoint('anything')).toBe(true);
  });
});
