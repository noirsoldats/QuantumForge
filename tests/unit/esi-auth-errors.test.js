/**
 * Unit Tests for ESI Auth Error Tagging
 *
 * Verifies that token refresh failures and ESI 403 scope errors are correctly
 * tagged with error codes (ESI_TOKEN_REFRESH_FAILED, ESI_SCOPE_ERROR) so that
 * IPC handlers in main.js can broadcast the right auth error to renderers.
 *
 * Also verifies that role-based 403s (e.g. "not a director") are still handled
 * silently without throwing.
 */

// ── Shared mocks ──────────────────────────────────────────────────────────────

const CHARACTER_ID = 123456789;
const CORPORATION_ID = 987654321;

const mockCharacter = {
  characterId: CHARACTER_ID,
  characterName: 'Test Pilot',
  corporationId: CORPORATION_ID,
  accessToken: 'mock-access-token',
  refreshToken: 'mock-refresh-token',
  expiresAt: Date.now() - 1000, // always expired so refresh is triggered
  scopes: [
    'esi-industry.read_character_jobs.v1',
    'esi-industry.read_corporation_jobs.v1',
    'esi-characters.read_blueprints.v1',
    'esi-corporations.read_blueprints.v1',
    'esi-wallet.read_character_wallet.v1',
    'esi-assets.read_assets.v1',
    'esi-assets.read_corporation_assets.v1',
    'esi-skills.read_skills.v1',
    'esi-corporations.read_divisions.v1',
    'esi-wallet.read_corporation_wallets.v1',
  ],
};

const mockNewTokens = {
  access_token: 'new-access-token',
  refresh_token: 'new-refresh-token',
  expires_in: 1200,
  expires_at: Date.now() + 1200000,
};

// Mock responses used across tests
function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
    headers: { get: jest.fn().mockReturnValue(null) },
  };
}

function make403Response(body) {
  return {
    ok: false,
    status: 403,
    text: jest.fn().mockResolvedValue(body),
  };
}

function make401Response() {
  return {
    ok: false,
    status: 401,
    text: jest.fn().mockResolvedValue('Unauthorized'),
  };
}

// ── Common jest.mock setup ─────────────────────────────────────────────────────

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

jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => ({
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn() })),
  })),
}));

jest.mock('../../src/main/esi-status-tracker', () => ({
  recordESICallStart: jest.fn(() => 'mock-call-key'),
  recordESICallSuccess: jest.fn(),
  recordESICallError: jest.fn(),
  // The central esi-fetch wrapper (now used by all modules) also consults these.
  recordRateLimit: jest.fn(),
  canFetchEndpoint: jest.fn(() => true), // always eligible in these tests
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Assert that an async call throws with a specific error.code */
async function expectErrorCode(fn, code) {
  let caught;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught.code).toBe(code);
  return caught;
}

/** Assert that an async call does NOT throw */
async function expectNoThrow(fn) {
  let caught;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeUndefined();
}

// ─────────────────────────────────────────────────────────────────────────────
// esi-industry-jobs.js
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-industry-jobs — auth error tagging', () => {
  let fetchCharacterIndustryJobs;
  let fetchCorporationIndustryJobs;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;
  let updateCharacterTokens;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter, updateCharacterTokens } = require('../../src/main/settings-manager'));
    ({ fetchCharacterIndustryJobs, fetchCorporationIndustryJobs } = require('../../src/main/esi-industry-jobs'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });
    updateCharacterTokens.mockReturnValue(true);

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('fetchCharacterIndustryJobs', () => {
    test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh token is revoked', async () => {
      refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

      const err = await expectErrorCode(
        () => fetchCharacterIndustryJobs(CHARACTER_ID),
        'ESI_TOKEN_REFRESH_FAILED'
      );
      expect(err.message).toContain('Token refresh failed');
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('does not tag unrelated errors', async () => {
      refreshAccessToken.mockResolvedValue(mockNewTokens);
      global.fetch.mockResolvedValue({ ok: false, status: 500, text: jest.fn().mockResolvedValue('Internal Server Error') });

      const err = await expectErrorCode(
        () => fetchCharacterIndustryJobs(CHARACTER_ID),
        undefined
      );
      expect(err.code).toBeUndefined();
    });

    test('succeeds and does not throw when token refresh succeeds', async () => {
      refreshAccessToken.mockResolvedValue(mockNewTokens);
      getCharacter
        .mockReturnValueOnce({ ...mockCharacter })
        .mockReturnValueOnce({ ...mockCharacter, accessToken: 'new-access-token' });

      global.fetch.mockResolvedValue(makeOkResponse([]));

      await expectNoThrow(() => fetchCharacterIndustryJobs(CHARACTER_ID));
    });
  });

  describe('fetchCorporationIndustryJobs', () => {
    test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh token is revoked', async () => {
      refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

      const err = await expectErrorCode(
        () => fetchCorporationIndustryJobs(CHARACTER_ID, CORPORATION_ID),
        'ESI_TOKEN_REFRESH_FAILED'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('tags ESI_SCOPE_ERROR when 403 body contains "token not valid for scope"', async () => {
      isTokenExpired.mockReturnValue(false); // skip refresh, go straight to fetch
      const corpChar = { ...mockCharacter, scopes: [...mockCharacter.scopes] };
      getCharacter.mockReturnValue(corpChar);

      global.fetch.mockResolvedValue(make403Response('{"error":"token not valid for scope"}'));

      const err = await expectErrorCode(
        () => fetchCorporationIndustryJobs(CHARACTER_ID, CORPORATION_ID),
        'ESI_SCOPE_ERROR'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('returns empty jobs silently when 403 is a role error (not director)', async () => {
      isTokenExpired.mockReturnValue(false);
      getCharacter.mockReturnValue({ ...mockCharacter });

      global.fetch.mockResolvedValue(make403Response('{"error":"Character does not have required role"}'));

      const result = await fetchCorporationIndustryJobs(CHARACTER_ID, CORPORATION_ID);
      expect(result.jobs).toEqual([]);
    });

    test('skips fetch silently when character lacks corporation jobs scope', async () => {
      isTokenExpired.mockReturnValue(false);
      const charWithoutScope = {
        ...mockCharacter,
        scopes: mockCharacter.scopes.filter(s => s !== 'esi-industry.read_corporation_jobs.v1'),
      };
      getCharacter.mockReturnValue(charWithoutScope);

      const result = await fetchCorporationIndustryJobs(CHARACTER_ID, CORPORATION_ID);
      expect(result.jobs).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esi-wallet.js
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-wallet — auth error tagging', () => {
  let fetchCharacterWalletTransactions;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter } = require('../../src/main/settings-manager'));
    ({ fetchCharacterWalletTransactions } = require('../../src/main/esi-wallet'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
    refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

    const err = await expectErrorCode(
      () => fetchCharacterWalletTransactions(CHARACTER_ID),
      'ESI_TOKEN_REFRESH_FAILED'
    );
    expect(err.characterId).toBe(CHARACTER_ID);
  });

  test('succeeds when token refresh succeeds and ESI returns 200', async () => {
    refreshAccessToken.mockResolvedValue(mockNewTokens);
    const { updateCharacterTokens } = require('../../src/main/settings-manager');
    updateCharacterTokens.mockReturnValue(true);
    getCharacter
      .mockReturnValueOnce({ ...mockCharacter })
      .mockReturnValueOnce({ ...mockCharacter, accessToken: 'new-access-token' });

    global.fetch.mockResolvedValue(makeOkResponse([]));

    await expectNoThrow(() => fetchCharacterWalletTransactions(CHARACTER_ID));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esi-wallet.js — journal + corp fetchers (Ledger overhaul)
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-wallet — journal + corp auth error tagging', () => {
  let fetchCharacterWalletJournal, fetchCorporationWalletTransactions, fetchCorporationWalletJournal;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter } = require('../../src/main/settings-manager'));
    ({ fetchCharacterWalletJournal, fetchCorporationWalletTransactions, fetchCorporationWalletJournal } =
      require('../../src/main/esi-wallet'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('character journal tags ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
    refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));
    const err = await expectErrorCode(() => fetchCharacterWalletJournal(CHARACTER_ID), 'ESI_TOKEN_REFRESH_FAILED');
    expect(err.characterId).toBe(CHARACTER_ID);
  });

  test('corp transactions tag ESI_SCOPE_ERROR on scope-403', async () => {
    isTokenExpired.mockReturnValue(false);
    getCharacter.mockReturnValue({ ...mockCharacter });
    global.fetch.mockResolvedValue(make403Response('{"error":"token not valid for scope"}'));
    const err = await expectErrorCode(
      () => fetchCorporationWalletTransactions(CHARACTER_ID, CORPORATION_ID, 1),
      'ESI_SCOPE_ERROR'
    );
    expect(err.characterId).toBe(CHARACTER_ID);
  });

  test('corp journal returns empty silently on role-403', async () => {
    isTokenExpired.mockReturnValue(false);
    getCharacter.mockReturnValue({ ...mockCharacter });
    global.fetch.mockResolvedValue(make403Response('{"error":"Character does not have required role"}'));
    const result = await fetchCorporationWalletJournal(CHARACTER_ID, CORPORATION_ID, 1);
    expect(result.entries).toEqual([]);
  });

  test('corp transactions skip (no fetch) when character lacks the corp wallet scope', async () => {
    isTokenExpired.mockReturnValue(false);
    const noScope = { ...mockCharacter, scopes: mockCharacter.scopes.filter(s => s !== 'esi-wallet.read_corporation_wallets.v1') };
    getCharacter.mockReturnValue(noScope);
    const result = await fetchCorporationWalletTransactions(CHARACTER_ID, CORPORATION_ID, 1);
    expect(result.transactions).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esi-divisions.js
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-divisions — auth error tagging', () => {
  let fetchCorporationDivisions;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter } = require('../../src/main/settings-manager'));
    ({ fetchCorporationDivisions } = require('../../src/main/esi-divisions'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
    refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

    const err = await expectErrorCode(
      () => fetchCorporationDivisions(CHARACTER_ID, CORPORATION_ID),
      'ESI_TOKEN_REFRESH_FAILED'
    );
    expect(err.characterId).toBe(CHARACTER_ID);
  });

  test('tags ESI_SCOPE_ERROR when 403 body contains "token not valid for scope"', async () => {
    isTokenExpired.mockReturnValue(false);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch.mockResolvedValue(make403Response('{"error":"token not valid for scope"}'));

    const err = await expectErrorCode(
      () => fetchCorporationDivisions(CHARACTER_ID, CORPORATION_ID),
      'ESI_SCOPE_ERROR'
    );
    expect(err.characterId).toBe(CHARACTER_ID);
  });

  test('returns hasScope:false silently when 403 is a role/permission error', async () => {
    isTokenExpired.mockReturnValue(false);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch.mockResolvedValue(make403Response('{"error":"forbidden"}'));

    // "forbidden" does not contain "token not valid for scope" or "invalid scope" —
    // should fall through to the graceful return
    const result = await fetchCorporationDivisions(CHARACTER_ID, CORPORATION_ID);
    expect(result.hasScope).toBe(false);
    expect(result.divisions).toEqual({});
  });

  test('skips fetch silently when character lacks divisions scope', async () => {
    isTokenExpired.mockReturnValue(false);
    const charWithoutScope = {
      ...mockCharacter,
      scopes: mockCharacter.scopes.filter(s => s !== 'esi-corporations.read_divisions.v1'),
    };
    getCharacter.mockReturnValue(charWithoutScope);

    const result = await fetchCorporationDivisions(CHARACTER_ID, CORPORATION_ID);
    expect(result.hasScope).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esi-skills.js
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-skills — auth error tagging', () => {
  let fetchCharacterSkills;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter } = require('../../src/main/settings-manager'));
    ({ fetchCharacterSkills } = require('../../src/main/esi-skills'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
    refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

    const err = await expectErrorCode(
      () => fetchCharacterSkills(CHARACTER_ID),
      'ESI_TOKEN_REFRESH_FAILED'
    );
    expect(err.characterId).toBe(CHARACTER_ID);
  });

  test('succeeds when token refresh succeeds and ESI returns skills data', async () => {
    refreshAccessToken.mockResolvedValue(mockNewTokens);
    const { updateCharacterTokens } = require('../../src/main/settings-manager');
    updateCharacterTokens.mockReturnValue(true);
    getCharacter
      .mockReturnValueOnce({ ...mockCharacter })
      .mockReturnValueOnce({ ...mockCharacter, accessToken: 'new-access-token' });

    global.fetch.mockResolvedValue(makeOkResponse({ skills: [], total_sp: 0, unallocated_sp: 0 }));

    await expectNoThrow(() => fetchCharacterSkills(CHARACTER_ID));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esi-blueprints.js
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-blueprints — auth error tagging', () => {
  let fetchCorporationBlueprints;
  let fetchCharacterBlueprints;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter } = require('../../src/main/settings-manager'));
    ({ fetchCorporationBlueprints, fetchCharacterBlueprints } = require('../../src/main/esi-blueprints'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('fetchCorporationBlueprints', () => {
    test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
      refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

      const err = await expectErrorCode(
        () => fetchCorporationBlueprints(CHARACTER_ID, CORPORATION_ID),
        'ESI_TOKEN_REFRESH_FAILED'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('tags ESI_SCOPE_ERROR when 403 body contains scope error text', async () => {
      isTokenExpired.mockReturnValue(false);
      getCharacter.mockReturnValue({ ...mockCharacter });

      global.fetch.mockResolvedValue(make403Response('{"error":"token not valid for scope"}'));

      const err = await expectErrorCode(
        () => fetchCorporationBlueprints(CHARACTER_ID, CORPORATION_ID),
        'ESI_SCOPE_ERROR'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('returns empty array silently when 403 is a role error', async () => {
      isTokenExpired.mockReturnValue(false);
      getCharacter.mockReturnValue({ ...mockCharacter });

      global.fetch.mockResolvedValue(make403Response('{"error":"Character does not have required role"}'));

      const result = await fetchCorporationBlueprints(CHARACTER_ID, CORPORATION_ID);
      expect(result).toEqual([]);
    });

    test('skips fetch silently when character lacks corporation blueprints scope', async () => {
      isTokenExpired.mockReturnValue(false);
      const charWithoutScope = {
        ...mockCharacter,
        scopes: mockCharacter.scopes.filter(s => s !== 'esi-corporations.read_blueprints.v1'),
      };
      getCharacter.mockReturnValue(charWithoutScope);

      const result = await fetchCorporationBlueprints(CHARACTER_ID, CORPORATION_ID);
      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('fetchCharacterBlueprints', () => {
    test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
      refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

      const err = await expectErrorCode(
        () => fetchCharacterBlueprints(CHARACTER_ID),
        'ESI_TOKEN_REFRESH_FAILED'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('succeeds when refresh succeeds and ESI returns blueprints', async () => {
      refreshAccessToken.mockResolvedValue(mockNewTokens);
      const { updateCharacterTokens } = require('../../src/main/settings-manager');
      updateCharacterTokens.mockReturnValue(true);
      getCharacter
        .mockReturnValueOnce({ ...mockCharacter })
        .mockReturnValueOnce({ ...mockCharacter, accessToken: 'new-access-token' });

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue([]),
        headers: { get: jest.fn().mockReturnValue('1') },
      });

      await expectNoThrow(() => fetchCharacterBlueprints(CHARACTER_ID));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esi-assets.js
// ─────────────────────────────────────────────────────────────────────────────

describe('esi-assets — auth error tagging', () => {
  let fetchCharacterAssets;
  let fetchCorporationAssets;
  let refreshAccessToken;
  let isTokenExpired;
  let getCharacter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    ({ refreshAccessToken, isTokenExpired } = require('../../src/main/esi-auth'));
    ({ getCharacter } = require('../../src/main/settings-manager'));
    ({ fetchCharacterAssets, fetchCorporationAssets } = require('../../src/main/esi-assets'));

    isTokenExpired.mockReturnValue(true);
    getCharacter.mockReturnValue({ ...mockCharacter });

    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('fetchCharacterAssets', () => {
    test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
      refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

      const err = await expectErrorCode(
        () => fetchCharacterAssets(CHARACTER_ID),
        'ESI_TOKEN_REFRESH_FAILED'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('succeeds when token refresh succeeds and ESI returns assets', async () => {
      refreshAccessToken.mockResolvedValue(mockNewTokens);
      const { updateCharacterTokens } = require('../../src/main/settings-manager');
      updateCharacterTokens.mockReturnValue(true);
      getCharacter
        .mockReturnValueOnce({ ...mockCharacter })
        .mockReturnValueOnce({ ...mockCharacter, accessToken: 'new-access-token' });

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue([]),
        headers: { get: jest.fn().mockReturnValue('1') },
      });

      await expectNoThrow(() => fetchCharacterAssets(CHARACTER_ID));
    });
  });

  describe('fetchCorporationAssets', () => {
    test('tags error as ESI_TOKEN_REFRESH_FAILED when refresh fails', async () => {
      refreshAccessToken.mockRejectedValue(new Error('Token refresh failed: {"error":"invalid_grant"}'));

      const err = await expectErrorCode(
        () => fetchCorporationAssets(CHARACTER_ID, CORPORATION_ID),
        'ESI_TOKEN_REFRESH_FAILED'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('tags ESI_SCOPE_ERROR when 403 body contains scope error text', async () => {
      isTokenExpired.mockReturnValue(false);
      getCharacter.mockReturnValue({ ...mockCharacter });

      global.fetch.mockResolvedValue(make403Response('{"error":"token not valid for scope"}'));

      const err = await expectErrorCode(
        () => fetchCorporationAssets(CHARACTER_ID, CORPORATION_ID),
        'ESI_SCOPE_ERROR'
      );
      expect(err.characterId).toBe(CHARACTER_ID);
    });

    test('returns empty assets silently when 403 is a role/permission error', async () => {
      isTokenExpired.mockReturnValue(false);
      getCharacter.mockReturnValue({ ...mockCharacter });

      global.fetch.mockResolvedValue(make403Response('{"error":"Character does not have required role"}'));

      const result = await fetchCorporationAssets(CHARACTER_ID, CORPORATION_ID);
      expect(result.assets).toEqual([]);
    });

    test('skips fetch silently when character lacks corporation assets scope', async () => {
      isTokenExpired.mockReturnValue(false);
      const charWithoutScope = {
        ...mockCharacter,
        scopes: mockCharacter.scopes.filter(s => s !== 'esi-assets.read_corporation_assets.v1'),
      };
      getCharacter.mockReturnValue(charWithoutScope);

      const result = await fetchCorporationAssets(CHARACTER_ID, CORPORATION_ID);
      expect(result.assets).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
