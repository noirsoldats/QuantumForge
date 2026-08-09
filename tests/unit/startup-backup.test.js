/**
 * Unit tests for the pre-migration backup.
 *
 * These run against a REAL temp directory rather than a mocked fs, because
 * the two things most worth proving - that the market cache is genuinely
 * gzipped and round-trips, and that an existing backup is never overwritten -
 * are both properties of actual files on disk. A mocked fs would assert that
 * we called copyFile, not that a tester can recover their data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

let userDataDir;
let configDir;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => global.__QF_USER_DATA__),
    getVersion: jest.fn(() => global.__QF_VERSION__),
  },
}));

// `path` is required inside the factory rather than closed over: jest.mock()
// factories are hoisted above the imports, so referencing an out-of-scope
// binding is a ReferenceError unless its name begins with "mock".
jest.mock('../../src/main/config-migration', () => {
  const nodePath = require('path');
  const configDirFor = () => nodePath.join(global.__QF_USER_DATA__, 'config');
  return {
    getConfigDir: configDirFor,
    getConfigPath: () => nodePath.join(configDirFor(), 'quantum_config.json'),
    getMarketDbPath: () => nodePath.join(configDirFor(), 'market_data.sqlite'),
  };
});

const {
  backupBeforeMigration,
  pruneOldBackups,
  readLastRunVersion,
  MAX_BACKUPS,
} = require('../../src/main/startup-backup');

/** Create a backup folder as the module would have written it. */
function seedBackup(name, createdAt, { withManifest = true } = {}) {
  const dir = path.join(userDataDir, 'backups', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character-data.db'), `DATA FOR ${name}`);
  if (withManifest) {
    fs.writeFileSync(
      path.join(dir, 'backup-info.json'),
      JSON.stringify({ fromVersion: name, createdAt })
    );
  }
  return dir;
}

/** Write a config file with the given stored version. */
function writeConfig(lastRunVersion) {
  const general = { theme: 'dark' };
  if (lastRunVersion !== undefined) general.lastRunVersion = lastRunVersion;
  fs.writeFileSync(
    path.join(configDir, 'quantum_config.json'),
    JSON.stringify({ general, accounts: { characters: [] } }, null, 2)
  );
}

/** Populate the four backup targets with recognisable content. */
function writeAllTargets() {
  fs.writeFileSync(path.join(configDir, 'character-data.db'), 'CHARACTER DATA');
  fs.writeFileSync(path.join(userDataDir, 'esi-status.db'), 'ESI STATUS');
  fs.writeFileSync(path.join(configDir, 'market_data.sqlite'), 'MARKET CACHE CONTENTS');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-backup-'));
  configDir = path.join(userDataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  global.__QF_USER_DATA__ = userDataDir;
  global.__QF_VERSION__ = '0.12.0-beta.1';

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('backupBeforeMigration', () => {
  test('backs up all four targets, gzipping only the market cache', async () => {
    writeConfig('0.11.0');
    writeAllTargets();

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(true);
    expect(result.files).toBe(4);

    // Labelled with the version being LEFT BEHIND - that is the version a
    // user would reinstall.
    const backupDir = path.join(userDataDir, 'backups', '0.11.0');
    expect(fs.existsSync(backupDir)).toBe(true);

    expect(fs.readFileSync(path.join(backupDir, 'character-data.db'), 'utf8'))
      .toBe('CHARACTER DATA');
    expect(fs.readFileSync(path.join(backupDir, 'esi-status.db'), 'utf8'))
      .toBe('ESI STATUS');

    // The market cache is gzipped, and must round-trip: a backup that cannot
    // be restored is not a backup.
    const gz = fs.readFileSync(path.join(backupDir, 'market_data.sqlite.gz'));
    expect(zlib.gunzipSync(gz).toString('utf8')).toBe('MARKET CACHE CONTENTS');

    // The uncompressed name must NOT be present - restore instructions tell
    // testers to gunzip, so an unzipped file here would mean the instructions
    // are wrong.
    expect(fs.existsSync(path.join(backupDir, 'market_data.sqlite'))).toBe(false);
  });

  test('backs up the settings file itself', async () => {
    writeConfig('0.11.0');

    await backupBeforeMigration();

    const backedUp = JSON.parse(
      fs.readFileSync(
        path.join(userDataDir, 'backups', '0.11.0', 'quantum_config.json'),
        'utf8'
      )
    );
    // Captured BEFORE lastRunVersion is bumped, so it still reads 0.11.0 -
    // this is the copy that restores the user's pre-upgrade state.
    expect(backedUp.general.lastRunVersion).toBe('0.11.0');
  });

  test('does NOT overwrite an existing backup for the same source version', async () => {
    writeConfig('0.11.0');
    writeAllTargets();

    await backupBeforeMigration();

    const charBackup = path.join(userDataDir, 'backups', '0.11.0', 'character-data.db');
    expect(fs.readFileSync(charBackup, 'utf8')).toBe('CHARACTER DATA');

    // Simulate the app having since migrated the live files, then force a
    // second attempt by rewinding the stored version. Without the guard this
    // would clobber the good pre-migration copy with migrated data - the
    // single worst failure this module can have.
    fs.writeFileSync(path.join(configDir, 'character-data.db'), 'MIGRATED DATA');
    writeConfig('0.11.0');

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(false);
    expect(result.reason).toBe('already-exists');
    expect(fs.readFileSync(charBackup, 'utf8')).toBe('CHARACTER DATA');
  });

  test('no-ops when the stored version already matches the running one', async () => {
    writeConfig('0.12.0-beta.1');
    writeAllTargets();

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(false);
    expect(result.reason).toBe('same-version');
    expect(fs.existsSync(path.join(userDataDir, 'backups'))).toBe(false);
  });

  test('skips missing files without failing', async () => {
    writeConfig('0.11.0');
    // Only the config exists - no databases at all.

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(true);
    expect(result.files).toBe(1);

    const backupDir = path.join(userDataDir, 'backups', '0.11.0');
    expect(fs.existsSync(path.join(backupDir, 'quantum_config.json'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'character-data.db'))).toBe(false);
  });

  test('labels the backup pre-0.12 when the config predates version tracking', async () => {
    writeConfig(undefined); // no lastRunVersion key at all
    writeAllTargets();

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'backups', 'pre-0.12'))).toBe(true);
  });

  test('does nothing on a fresh install but records the version', async () => {
    // No config file at all.
    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(false);
    expect(result.reason).toBe('fresh-install');
    expect(fs.existsSync(path.join(userDataDir, 'backups'))).toBe(false);
  });

  test('records the running version so the next launch no-ops', async () => {
    writeConfig('0.11.0');
    writeAllTargets();

    await backupBeforeMigration();
    expect(readLastRunVersion()).toBe('0.12.0-beta.1');

    // Second launch of the same version: nothing further happens.
    const second = await backupBeforeMigration();
    expect(second.reason).toBe('same-version');
  });

  test('writes a manifest describing the backup', async () => {
    writeConfig('0.11.0');
    writeAllTargets();

    await backupBeforeMigration();

    const info = JSON.parse(
      fs.readFileSync(
        path.join(userDataDir, 'backups', '0.11.0', 'backup-info.json'),
        'utf8'
      )
    );
    expect(info.fromVersion).toBe('0.11.0');
    expect(info.toVersion).toBe('0.12.0-beta.1');
    expect(info.files).toContain('market_data.sqlite.gz');
  });

  test('prunes surplus backups after a successful one, keeping the newest', async () => {
    seedBackup('pre-0.12', '2026-01-01T00:00:00.000Z');
    seedBackup('0.12.0-beta.1', '2026-02-01T00:00:00.000Z');
    seedBackup('0.12.0-beta.2', '2026-03-01T00:00:00.000Z');

    writeConfig('0.12.0-beta.3');
    writeAllTargets();
    global.__QF_VERSION__ = '0.12.0-beta.4';

    const result = await backupBeforeMigration();
    expect(result.backedUp).toBe(true);

    const remaining = fs.readdirSync(path.join(userDataDir, 'backups')).sort();

    // Rolling back means undoing the upgrade just performed, so the most
    // recent snapshots survive and the stale ones go...
    expect(remaining).toContain('0.12.0-beta.3');
    expect(remaining).toContain('0.12.0-beta.2');
    expect(remaining).not.toContain('0.12.0-beta.1');

    // ...except pre-0.12, which is pinned and does not consume a slot.
    expect(remaining).toContain('pre-0.12');
    expect(remaining).toHaveLength(MAX_BACKUPS + 1);
  });

  test('pre-0.12 is never pruned, however many upgrades follow', async () => {
    seedBackup('pre-0.12', '2026-01-01T00:00:00.000Z');

    // Walk through several upgrades, as a long-running tester would.
    for (const [from, to] of [
      ['0.12.0-beta.1', '0.12.0-beta.2'],
      ['0.12.0-beta.2', '0.12.0-beta.3'],
      ['0.12.0-beta.3', '0.12.0'],
      ['0.12.0', '0.12.1'],
      ['0.12.1', '0.13.0'],
    ]) {
      writeConfig(from);
      writeAllTargets();
      global.__QF_VERSION__ = to;
      await backupBeforeMigration();
    }

    const remaining = fs.readdirSync(path.join(userDataDir, 'backups')).sort();

    // Still there after five further upgrades, and still holding the
    // pre-migration data.
    expect(remaining).toContain('pre-0.12');
    expect(fs.readFileSync(
      path.join(userDataDir, 'backups', 'pre-0.12', 'character-data.db'), 'utf8'
    )).toBe('DATA FOR pre-0.12');

    // The rolling window stayed bounded: pinned + MAX_BACKUPS, no growth.
    expect(remaining).toHaveLength(MAX_BACKUPS + 1);
    expect(remaining).toContain('0.12.1'); // most recent rollback point
  });

  test('pruning never touches folders we did not create', () => {
    // The manifested backups must ALREADY exceed the keep limit on their own,
    // so pruning is guaranteed to run and delete something. Otherwise an
    // unmanifested folder survives by luck of sort order rather than by the
    // guard, and this test passes with the guard removed - verified by
    // deleting the guard and watching it still go green.
    // Deliberately NOT using pre-0.12 here: that name is pinned, so it would
    // survive for a reason unrelated to the manifest guard and mask a bug.
    seedBackup('0.12.0', '2026-01-01T00:00:00.000Z');
    seedBackup('0.12.1', '2026-02-01T00:00:00.000Z');
    seedBackup('0.12.2', '2026-03-01T00:00:00.000Z');
    seedBackup('0.12.3', '2026-04-01T00:00:00.000Z');

    // A folder the user made themselves, undated so it would be among the
    // FIRST things deleted if pruning ever considered it. It has no manifest,
    // so it must be invisible.
    const userFolder = path.join(userDataDir, 'backups', 'my-own-copy');
    fs.mkdirSync(userFolder, { recursive: true });
    fs.writeFileSync(path.join(userFolder, 'precious.db'), 'USER DATA');
    fs.writeFileSync(path.join(userDataDir, 'backups', 'notes.txt'), 'hello');

    const removed = pruneOldBackups(path.join(userDataDir, 'backups'));

    // Pruning definitely ran and only took our own surplus backups.
    expect(removed.sort()).toEqual(['0.12.0', '0.12.1']);

    expect(fs.readFileSync(path.join(userFolder, 'precious.db'), 'utf8')).toBe('USER DATA');
    expect(fs.existsSync(path.join(userDataDir, 'backups', 'notes.txt'))).toBe(true);
  });

  test('keeps a backup whose manifest is unreadable rather than destroying it', () => {
    const broken = seedBackup('mystery', 'ignored');
    fs.writeFileSync(path.join(broken, 'backup-info.json'), '{ corrupt');
    seedBackup('0.12.0', '2026-01-01T00:00:00.000Z');
    seedBackup('0.12.1', '2026-02-01T00:00:00.000Z');
    seedBackup('0.12.2', '2026-03-01T00:00:00.000Z');

    pruneOldBackups(path.join(userDataDir, 'backups'));

    // A damaged manifest must never make a folder the FIRST thing deleted -
    // it sorts newest so the failure mode is keeping too much, not too little.
    expect(fs.existsSync(broken)).toBe(true);
  });

  test('does not prune when at or under the limit', () => {
    seedBackup('0.12.0', '2026-01-01T00:00:00.000Z');
    seedBackup('0.12.1', '2026-02-01T00:00:00.000Z');

    const removed = pruneOldBackups(path.join(userDataDir, 'backups'));

    expect(removed).toEqual([]);
    expect(fs.readdirSync(path.join(userDataDir, 'backups'))).toHaveLength(2);
  });

  test('the pinned backup does not consume a rolling slot', () => {
    // Pinned + exactly MAX_BACKUPS rotating: nothing should be pruned.
    seedBackup('pre-0.12', '2026-01-01T00:00:00.000Z');
    seedBackup('0.12.0', '2026-02-01T00:00:00.000Z');
    seedBackup('0.12.1', '2026-03-01T00:00:00.000Z');

    const removed = pruneOldBackups(path.join(userDataDir, 'backups'));

    expect(removed).toEqual([]);
    expect(fs.readdirSync(path.join(userDataDir, 'backups'))).toHaveLength(3);
  });

  test('does not prune when the backup itself failed', async () => {
    seedBackup('0.12.0', '2026-01-01T00:00:00.000Z');
    seedBackup('0.12.1', '2026-02-01T00:00:00.000Z');
    seedBackup('0.12.2', '2026-03-01T00:00:00.000Z');

    writeConfig('0.12.3');
    // Force the new backup to fail: the target dir name already exists as a
    // FILE, so mkdirSync throws.
    fs.writeFileSync(path.join(userDataDir, 'backups', '0.12.3'), 'x');
    global.__QF_VERSION__ = '0.12.4';

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(false);
    // Nothing was deleted to make room for a backup that never happened.
    expect(fs.existsSync(path.join(userDataDir, 'backups', '0.12.0'))).toBe(true);
  });

  test('pruning tolerates a missing backups directory', () => {
    expect(() => pruneOldBackups(path.join(userDataDir, 'backups'))).not.toThrow();
  });

  test('never throws when the backup cannot be written', async () => {
    writeConfig('0.11.0');
    writeAllTargets();

    // Make the backups directory un-creatable.
    const backupsRoot = path.join(userDataDir, 'backups');
    fs.writeFileSync(backupsRoot, 'not a directory');

    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(false);
    expect(result.reason).toBe('error');
    expect(console.error).toHaveBeenCalled();
  });

  test('labels the first tester upgrade pre-0.12, not 0.11.0', async () => {
    // lastRunVersion ships for the first time in 0.12.0-beta.1, so a 0.11.x
    // install can never have written it. `pre-0.12` is the NORMAL label for
    // the upgrade that matters, not an edge case.
    writeConfig(undefined);
    writeAllTargets();

    await backupBeforeMigration();

    expect(fs.existsSync(path.join(userDataDir, 'backups', 'pre-0.12'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'backups', '0.11.0'))).toBe(false);
  });

  test('survives a corrupt config file', async () => {
    fs.writeFileSync(path.join(configDir, 'quantum_config.json'), '{ not valid json');
    writeAllTargets();

    // An unreadable config must not stop the backup - that user needs it most.
    const result = await backupBeforeMigration();

    expect(result.backedUp).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'backups', 'pre-0.12'))).toBe(true);
  });
});
