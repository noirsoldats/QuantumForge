/**
 * Legacy window-state key migration
 *
 * Every screen used to own a bespoke window module storing bounds under its own
 * name. They are all served by `view-window.js` now, which keys bounds as
 * `view-${windowKey(viewId, params)}`. Without this rename a user's remembered
 * size and position is silently abandoned the first time they pop a screen out.
 *
 * THE TRAP: `windowKey` runs param values through `JSON.stringify`, which
 * QUOTES strings. The stored keys are unquoted (`characterId=133585695`), so
 * the id is a NUMBER. Emitting `characterId="133585695"` yields a key nothing
 * ever reads - the migration would appear to run and still lose the placement.
 * The per-character tests below assert against the real `windowKey` rather than
 * a hand-written string, so the two cannot drift.
 */

const fs = require('fs');
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/qf-wsm-' + Date.now()) },
  screen: { getAllDisplays: jest.fn(() => [{ bounds: { x: 0, y: 0, width: 3840, height: 2160 } }]) },
}));

jest.mock('../../src/main/esi-auth', () => ({
  isTokenExpired: jest.fn(() => false),
  refreshAccessToken: jest.fn(),
}));

jest.mock('../../src/main/config-migration', () => ({
  getConfigDir: jest.fn(),
  getConfigPath: jest.fn(),
  getMarketDbPath: jest.fn(),
}));

const bounds = (x) => ({ x, y: x, width: 1200, height: 800, timestamp: 1775168369120 });

describe('window-state key migration', () => {
  let settingsManager;
  let windowKey;
  let tempDir;
  let settingsFilePath;

  function loadWith(windowStates) {
    fs.writeFileSync(
      settingsFilePath,
      JSON.stringify({ marketSets: [], windowStates }, null, 2)
    );
    return settingsManager.loadSettings();
  }

  const readFromDisk = () => JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));

  beforeEach(() => {
    tempDir = '/tmp/qf-wsm-' + Date.now() + '-' + Math.random();
    const configDir = path.join(tempDir, 'config');

    jest.resetModules();

    require('electron').app.getPath.mockReturnValue(tempDir);

    const configMigration = require('../../src/main/config-migration');
    configMigration.getConfigDir.mockReturnValue(configDir);
    settingsFilePath = path.join(configDir, 'quantum_config.json');
    configMigration.getConfigPath.mockReturnValue(settingsFilePath);

    fs.mkdirSync(configDir, { recursive: true });

    settingsManager = require('../../src/main/settings-manager');
    ({ windowKey } = require('../../src/main/view-window'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('simple prefix renames', () => {
    test.each([
      ['loot-analyzer', 'view-loot-analyzer'],
      ['manufacturing-summary', 'view-manufacturing-summary'],
      ['manufacturing-plans', 'view-manufacturing-plans'],
      ['esi-status', 'view-esi-status'],
      ['audit-log', 'view-audit-log'],
      ['settings', 'view-settings'],
    ])('%s -> %s', (oldKey, newKey) => {
      const result = loadWith({ [oldKey]: bounds(10) });

      expect(result.windowStates[newKey]).toEqual(bounds(10));
      expect(result.windowStates[oldKey]).toBeUndefined();
    });
  });

  describe('renamed tool', () => {
    test('cleanup-tool becomes view-what-can-i-build', () => {
      // The tool was renamed to "What Can I Build?"; the window key must follow
      // the new view id, not the old module name.
      const result = loadWith({ 'cleanup-tool': bounds(20) });

      expect(result.windowStates['view-what-can-i-build']).toEqual(bounds(20));
      expect(result.windowStates['cleanup-tool']).toBeUndefined();
    });
  });

  describe('per-character windows', () => {
    test.each(['skills', 'blueprints', 'assets'])(
      '%s-<id> matches what windowKey() will ask for',
      (view) => {
        const characterId = 133585695;
        const result = loadWith({ [`${view}-${characterId}`]: bounds(30) });

        // Asserted against the REAL windowKey, so a change to either side fails
        // rather than silently producing an unreadable key.
        const expected = `view-${windowKey(view, { characterId })}`;
        expect(result.windowStates[expected]).toEqual(bounds(30));
      }
    );

    test('the character id is emitted UNQUOTED', () => {
      // JSON.stringify quotes strings; the id must serialise as a number.
      const result = loadWith({ 'skills-133585695': bounds(40) });
      const keys = Object.keys(result.windowStates);

      expect(keys).toContain('view-skills?characterId=133585695');
      expect(keys.some((k) => k.includes('"'))).toBe(false);
    });

    test('several characters each keep their own bounds', () => {
      const result = loadWith({
        'skills-111': bounds(1),
        'skills-222': bounds(2),
        'blueprints-111': bounds(3),
      });

      expect(result.windowStates['view-skills?characterId=111']).toEqual(bounds(1));
      expect(result.windowStates['view-skills?characterId=222']).toEqual(bounds(2));
      expect(result.windowStates['view-blueprints?characterId=111']).toEqual(bounds(3));
    });

    test('an unknown per-character prefix is left alone', () => {
      // Only skills/blueprints/assets were ever per-character windows. A key
      // that merely LOOKS like one must not be renamed into a view that does
      // not exist.
      const result = loadWith({ 'widgets-999': bounds(50) });

      expect(result.windowStates['widgets-999']).toEqual(bounds(50));
      expect(result.windowStates['view-widgets?characterId=999']).toBeUndefined();
    });
  });

  describe('safety', () => {
    test('the main window is never touched', () => {
      const result = loadWith({ main: bounds(60), 'loot-analyzer': bounds(61) });

      expect(result.windowStates.main).toEqual(bounds(60));
      expect(result.windowStates['view-main']).toBeUndefined();
    });

    test('already-migrated keys are left alone', () => {
      const result = loadWith({ 'view-loot-analyzer': bounds(70) });
      expect(result.windowStates['view-loot-analyzer']).toEqual(bounds(70));
    });

    test('bounds are carried across byte for byte', () => {
      // x/y are what preserve the monitor the window was on - the whole point.
      const exact = { x: 2328, y: 245, width: 1400, height: 900, timestamp: 1775168369120 };
      const result = loadWith({ 'cleanup-tool': { ...exact } });

      expect(result.windowStates['view-what-can-i-build']).toEqual(exact);
    });

    test('persists, so it does not re-run', () => {
      loadWith({ 'cleanup-tool': bounds(80) });

      const onDisk = readFromDisk();
      expect(onDisk.windowStates['view-what-can-i-build']).toEqual(bounds(80));
      expect(onDisk.windowStates['cleanup-tool']).toBeUndefined();
    });

    test('is idempotent across repeated loads', () => {
      loadWith({ 'cleanup-tool': bounds(90), 'skills-111': bounds(91) });
      const first = readFromDisk().windowStates;

      settingsManager.loadSettings();
      settingsManager.loadSettings();

      expect(readFromDisk().windowStates).toEqual(first);
    });

    test('a fresh install is untouched', () => {
      expect(loadWith({}).windowStates).toEqual({});
    });

    test('a config with no windowStates does not throw', () => {
      fs.writeFileSync(settingsFilePath, JSON.stringify({ marketSets: [] }, null, 2));
      expect(() => settingsManager.loadSettings()).not.toThrow();
    });

    test('migrates a full legacy config in one pass', () => {
      const legacy = {
        main: bounds(1),
        settings: bounds(2),
        'skills-1194303072': bounds(3),
        'blueprints-133585695': bounds(4),
        'assets-133585695': bounds(5),
        'manufacturing-summary': bounds(6),
        'manufacturing-plans': bounds(7),
        'esi-status': bounds(8),
        'cleanup-tool': bounds(9),
        'loot-analyzer': bounds(10),
        'audit-log': bounds(11),
      };

      const result = loadWith(legacy);
      const keys = Object.keys(result.windowStates);

      // Everything except `main` is now a view-* key.
      expect(keys.filter((k) => k !== 'main' && !k.startsWith('view-'))).toEqual([]);
      expect(keys).toContain('main');
      expect(keys).toHaveLength(11);
    });
  });
});
