/**
 * Unit Tests — Startup Character Data Refresh: Auth Error Handling
 *
 * Regression coverage for the bug where an expired ESI refresh token during
 * the automatic startup character-data refresh (runCharacterDataRefresh in
 * startup-manager.js) was silently logged and dropped — no re-auth popup
 * ever appeared, unlike every user-triggered ESI refresh in main.js, which
 * correctly calls broadcastAuthError(buildAuthErrorInfo(...)).
 *
 * Verifies: (1) an ESI_TOKEN_REFRESH_FAILED/ESI_SCOPE_ERROR error from any
 * of the per-character ESI fetch calls triggers broadcastAuthError once per
 * affected character, and (2) the refresh loop does not block/throw — it
 * must continue to the next character and let startup complete.
 */

const CHAR_1 = { characterId: 133585695, characterName: 'Buckwalter', corporationId: null };
const CHAR_2 = { characterId: 1194303072, characterName: 'Roshcar', corporationId: null };

const notCached = { isCached: false, expiresAt: null, remainingSeconds: 0 };
const cached = { isCached: true, expiresAt: Date.now() + 100000, remainingSeconds: 100 };

function tagAuthError(message, code, characterId) {
  const err = new Error(message);
  err.code = code;
  err.characterId = characterId;
  return err;
}

jest.mock('../../src/main/settings-manager', () => ({
  getCharacters: jest.fn(),
  getSkillsCacheStatus: jest.fn(),
  getBlueprintsCacheStatus: jest.fn(),
  getSetting: jest.fn(),
  updateCharacterSkills: jest.fn(),
  updateCharacterBlueprints: jest.fn(),
}));

jest.mock('../../src/main/esi-skills', () => ({
  fetchCharacterSkills: jest.fn(),
}));

jest.mock('../../src/main/esi-blueprints', () => ({
  fetchCharacterBlueprints: jest.fn(),
}));

jest.mock('../../src/main/esi-assets', () => ({
  fetchCharacterAssets: jest.fn(),
  fetchCorporationAssets: jest.fn(),
  saveAssets: jest.fn(),
  getAssetsCacheStatus: jest.fn(),
}));

jest.mock('../../src/main/auth-error-window', () => ({
  broadcastAuthError: jest.fn(),
  buildAuthErrorInfo: jest.fn((error, characterId) => ({ type: 'token_refresh_failed', characterId })),
}));

// runStartupChecks pulls in several other startup-step modules at require time;
// mock them minimally so requiring startup-manager.js doesn't pull in unrelated
// dependencies (market DB, SDE manager, etc.) that this test doesn't exercise.
jest.mock('../../src/main/market-database', () => ({ initializeMarketDatabase: jest.fn() }));
jest.mock('../../src/main/sde-manager', () => ({
  checkUpdateRequired: jest.fn(),
  sdeExists: jest.fn(),
  downloadAndValidateSDE: jest.fn(),
  getSdePath: jest.fn(),
  getCurrentVersion: jest.fn(),
}));
jest.mock('../../src/main/sde-source-migration', () => ({
  needsMigration: jest.fn(),
  migrateToGitHub: jest.fn(),
}));

describe('runCharacterDataRefresh — auth error handling', () => {
  let runCharacterDataRefresh;
  let getCharacters, getSkillsCacheStatus, getBlueprintsCacheStatus, getSetting;
  let fetchCharacterSkills;
  let getAssetsCacheStatus;
  let broadcastAuthError, buildAuthErrorInfo;
  let fakeSplashWindow;

  beforeEach(() => {
    jest.clearAllMocks();

    ({ getCharacters, getSkillsCacheStatus, getBlueprintsCacheStatus, getSetting } = require('../../src/main/settings-manager'));
    ({ fetchCharacterSkills } = require('../../src/main/esi-skills'));
    ({ getAssetsCacheStatus } = require('../../src/main/esi-assets'));
    ({ broadcastAuthError, buildAuthErrorInfo } = require('../../src/main/auth-error-window'));
    ({ runCharacterDataRefresh } = require('../../src/main/startup-manager'));

    fakeSplashWindow = { webContents: { send: jest.fn() } };

    getSetting.mockReturnValue({ skills: true, blueprints: false, assets: false });
    getSkillsCacheStatus.mockReturnValue(notCached);
    getBlueprintsCacheStatus.mockReturnValue(cached);
    getAssetsCacheStatus.mockReturnValue(cached);
  });

  test('calls broadcastAuthError when a character\'s refresh token has expired', async () => {
    getCharacters.mockReturnValue([CHAR_1]);
    fetchCharacterSkills.mockRejectedValue(
      tagAuthError('Token refresh failed: {"error":"invalid_grant"}', 'ESI_TOKEN_REFRESH_FAILED', CHAR_1.characterId)
    );

    await expect(runCharacterDataRefresh(fakeSplashWindow)).resolves.not.toThrow();

    expect(broadcastAuthError).toHaveBeenCalledTimes(1);
    expect(buildAuthErrorInfo).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ESI_TOKEN_REFRESH_FAILED' }),
      CHAR_1.characterId
    );
  });

  test('does not block the loop — continues to the next character after an auth error', async () => {
    getCharacters.mockReturnValue([CHAR_1, CHAR_2]);
    fetchCharacterSkills.mockImplementation((characterId) => {
      if (characterId === CHAR_1.characterId) {
        return Promise.reject(
          tagAuthError('Token refresh failed: {"error":"invalid_grant"}', 'ESI_TOKEN_REFRESH_FAILED', CHAR_1.characterId)
        );
      }
      return Promise.resolve({ skills: [], total_sp: 0, unallocated_sp: 0 });
    });

    await runCharacterDataRefresh(fakeSplashWindow);

    // Both characters were attempted — the first character's auth error did not
    // stop the loop from reaching the second.
    expect(fetchCharacterSkills).toHaveBeenCalledTimes(2);
    expect(fetchCharacterSkills).toHaveBeenCalledWith(CHAR_1.characterId);
    expect(fetchCharacterSkills).toHaveBeenCalledWith(CHAR_2.characterId);
  });

  test('shows a popup for each character when multiple refresh tokens have expired', async () => {
    getCharacters.mockReturnValue([CHAR_1, CHAR_2]);
    fetchCharacterSkills.mockImplementation((characterId) =>
      Promise.reject(tagAuthError('Token refresh failed: {"error":"invalid_grant"}', 'ESI_TOKEN_REFRESH_FAILED', characterId))
    );

    await runCharacterDataRefresh(fakeSplashWindow);

    expect(broadcastAuthError).toHaveBeenCalledTimes(2);
  });

  test('does not call broadcastAuthError for non-auth errors (e.g. network timeout)', async () => {
    getCharacters.mockReturnValue([CHAR_1]);
    const timeoutError = new Error('fetch failed');
    fetchCharacterSkills.mockRejectedValue(timeoutError);

    await runCharacterDataRefresh(fakeSplashWindow);

    expect(broadcastAuthError).not.toHaveBeenCalled();
  });

  test('calls broadcastAuthError for ESI_SCOPE_ERROR as well as ESI_TOKEN_REFRESH_FAILED', async () => {
    getCharacters.mockReturnValue([CHAR_1]);
    fetchCharacterSkills.mockRejectedValue(
      tagAuthError('{"error":"token not valid for scope"}', 'ESI_SCOPE_ERROR', CHAR_1.characterId)
    );

    await runCharacterDataRefresh(fakeSplashWindow);

    expect(broadcastAuthError).toHaveBeenCalledTimes(1);
  });
});
