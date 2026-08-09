/**
 * Pre-migration backup.
 *
 * Takes a copy of the config file and every database BEFORE the first
 * migration of any kind runs, so a user who installs a version they don't
 * get on with can return to the one they were using.
 *
 * This exists because the 0.12 UI overhaul migrates both the settings shape
 * and the character database schema, and several of those migrations are
 * one-way. Reinstalling the old version is not by itself a rollback: the old
 * version cannot read the new shapes.
 *
 * Two hard constraints shape everything here:
 *
 *   1. It must run before ANYTHING mutates the files - including
 *      `loadSettings()`, which is not a pure read (it persists the
 *      window-state key migration on load). That is why this module reads
 *      quantum_config.json with fs/JSON.parse rather than importing
 *      settings-manager. Importing it would trigger the very migration this
 *      backup is meant to precede.
 *
 *   2. It must never prevent startup. Every failure path is caught and
 *      logged. A missing backup is a bad day; an app that won't launch
 *      because a backup failed is a worse one.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { app } = require('electron');

const { getConfigDir, getConfigPath, getMarketDbPath } = require('./config-migration');

// The market cache is an order of magnitude larger than everything else
// combined (~345 MB against ~6 MB), so it is gzipped rather than copied.
// Level 1 is deliberate: measured on a real 345 MB cache it gives ~37%
// in a few seconds, and higher levels cost noticeably more time for very
// little gain on already-dense SQLite pages.
const GZIP_LEVEL = 1;

// How many rotating backup folders to keep. Each is >100 MB (the market cache
// dominates), and a user upgrading repeatedly would otherwise accumulate them
// indefinitely in a folder they never look in.
//
// The NEWEST are kept: rolling back nearly always means "undo the upgrade I
// just did", so the most recent snapshot is the relevant one.
const MAX_BACKUPS = 2;

// ...with one exception, kept forever and NOT counted against MAX_BACKUPS.
//
// This is the snapshot taken immediately before the 0.12 UI overhaul migrated
// a user's data, and it is the only backup whose value does not decay. It is
// the last release-quality state most users had, and the 0.12 migrations
// (window-state keys, settings shape, 27 schema migrations) are the ones that
// make a plain reinstall insufficient. Every later backup is a snapshot of
// 0.12-or-newer data, which restores to a version that already has all of
// that applied.
//
// Pinning it also means the rolling window stays genuinely useful: without
// this exception, keeping `pre-0.12` would consume one of only two slots.
const PERMANENT_BACKUP = 'pre-0.12';

/**
 * Files to back up.
 *
 * Paths are resolved through the same helpers the app itself uses rather
 * than rebuilt from convention. This matters: a real install can be left
 * with stale zero-byte `market_data.sqlite` / `market-data.db` files at the
 * userData root from the pre-0.11 config migration, while the live database
 * is the one inside `config/`. Reconstructing the path by convention can
 * pick the empty husk and produce a backup that restores nothing.
 *
 * @returns {Array<{label: string, src: string, dest: string, gzip: boolean}>}
 */
function backupTargets() {
  const configDir = getConfigDir();

  return [
    {
      label: 'settings',
      src: getConfigPath(),
      dest: 'quantum_config.json',
      gzip: false,
    },
    {
      label: 'character data',
      src: path.join(configDir, 'character-data.db'),
      dest: 'character-data.db',
      gzip: false,
    },
    {
      label: 'ESI status',
      src: path.join(app.getPath('userData'), 'esi-status.db'),
      dest: 'esi-status.db',
      gzip: false,
    },
    {
      label: 'market cache',
      src: getMarketDbPath(),
      dest: 'market_data.sqlite.gz',
      gzip: true,
    },
  ];
}

/**
 * Read the last-run version without going through settings-manager.
 *
 * `loadSettings()` runs migrations and can write to disk, which is exactly
 * what must not happen before the backup. A direct parse is also more
 * robust here: if the config is unreadable or corrupt we want to fall
 * through to "unknown previous version" and still take a backup, not throw.
 *
 * @returns {string|null} The stored version, or null if unknown.
 */
function readLastRunVersion() {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const stored = parsed && parsed.general && parsed.general.lastRunVersion;
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  } catch (error) {
    console.error('[startup-backup] Could not read last-run version:', error.message);
    return null;
  }
}

/**
 * Record the version we are now running, so the backup fires once per
 * version rather than on every launch.
 *
 * Written with a read-modify-write against the raw file for the same reason
 * as the read: settings-manager must not be involved this early. This runs
 * AFTER the backup, so touching the file here is safe.
 *
 * @param {string} version
 */
function writeLastRunVersion(version) {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return;

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed.general || typeof parsed.general !== 'object') parsed.general = {};
    parsed.general.lastRunVersion = version;

    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch (error) {
    console.error('[startup-backup] Could not record last-run version:', error.message);
  }
}

/**
 * Copy one file, optionally gzipping it.
 *
 * The gzip path is streamed rather than buffered - the market cache is
 * hundreds of megabytes and must never be held in memory.
 *
 * @returns {Promise<number>} Bytes written, or 0 if the source was absent.
 */
async function copyOne(target, backupDir) {
  if (!fs.existsSync(target.src)) {
    // Entirely normal: a fresh install has no databases, and a user who has
    // never opened the market has no market cache.
    console.log(`[startup-backup] Skipping ${target.label} (not present)`);
    return 0;
  }

  const destPath = path.join(backupDir, target.dest);

  if (target.gzip) {
    await pipeline(
      fs.createReadStream(target.src),
      zlib.createGzip({ level: GZIP_LEVEL }),
      fs.createWriteStream(destPath)
    );
  } else {
    await fs.promises.copyFile(target.src, destPath);
  }

  return fs.statSync(destPath).size;
}

/**
 * Delete surplus backups, keeping the newest MAX_BACKUPS plus the permanent
 * pre-0.12 snapshot.
 *
 * Three deliberate safety properties, because this deletes user data:
 *
 *   - `pre-0.12` is never removed, and never counts against the limit. See
 *     PERMANENT_BACKUP.
 *
 *   - Only directories containing a `backup-info.json` we wrote are
 *     considered. Anything else in `backups/` - a folder the user copied
 *     there themselves, a stray file - is invisible to this function and can
 *     never be removed by it.
 *
 *   - Ordering is by the recorded `createdAt`, not mtime (restoring a backup
 *     touches mtimes) and not by parsing version strings (`pre-0.12` is not
 *     a version, and semver-comparing beta tags is needless risk here).
 *     A backup with an unreadable manifest sorts newest, so a corrupt
 *     manifest can never single a folder out for deletion.
 *
 * Never throws.
 *
 * @param {string} backupsRoot
 * @returns {string[]} Names of the directories removed.
 */
function pruneOldBackups(backupsRoot) {
  const removed = [];

  try {
    if (!fs.existsSync(backupsRoot)) return removed;

    const candidates = [];
    for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === PERMANENT_BACKUP) continue; // Pinned forever.

      const infoPath = path.join(backupsRoot, entry.name, 'backup-info.json');
      if (!fs.existsSync(infoPath)) continue; // Not ours; leave it alone.

      // Unreadable or undated manifests sort NEWEST (Infinity) so that a
      // corrupt manifest errs towards keeping the folder. The alternative -
      // treating it as age zero - would make a damaged manifest the first
      // thing deleted, which is the opposite of what a user would want.
      let createdAt = Number.POSITIVE_INFINITY;
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        const parsedAt = Date.parse(info.createdAt);
        if (Number.isFinite(parsedAt)) createdAt = parsedAt;
      } catch {
        // Left as Infinity - see above.
      }
      candidates.push({ name: entry.name, createdAt });
    }

    if (candidates.length <= MAX_BACKUPS) return removed;

    // Newest first, then drop everything past the keep count.
    candidates.sort((a, b) => b.createdAt - a.createdAt);

    for (const surplus of candidates.slice(MAX_BACKUPS)) {
      const dir = path.join(backupsRoot, surplus.name);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(surplus.name);
      console.log(`[startup-backup] Pruned old backup ${surplus.name}`);
    }
  } catch (error) {
    // Failing to prune costs disk space; failing loudly would cost a launch.
    console.error('[startup-backup] Could not prune old backups:', error.message);
  }

  return removed;
}

/**
 * Back up config and databases before any migration runs.
 *
 * No-ops when the stored last-run version already matches the running one,
 * and when a backup directory for that version already exists. The second
 * guard is the important one: without it, launching the same version twice
 * would overwrite a good pre-migration backup with post-migration data,
 * destroying the thing the user needs to roll back.
 *
 * Never throws.
 *
 * @param {(message: string) => void} [onProgress] Splash progress reporter;
 *   the gzip step takes a few seconds and otherwise looks like a hang.
 * @returns {Promise<{backedUp: boolean, reason?: string, dir?: string, files?: number}>}
 */
async function backupBeforeMigration(onProgress) {
  try {
    const currentVersion = app.getVersion();
    const previousVersion = readLastRunVersion();

    if (previousVersion === currentVersion) {
      return { backedUp: false, reason: 'same-version' };
    }

    // A first-ever launch has nothing worth preserving. Record the version so
    // the next upgrade has a real "from" to label the backup with.
    if (!fs.existsSync(getConfigPath())) {
      writeLastRunVersion(currentVersion);
      return { backedUp: false, reason: 'fresh-install' };
    }

    // Label the backup with the version being left behind - that is the
    // version a user would reinstall.
    //
    // `pre-0.12` is not a fallback for an edge case; it is what EVERY tester
    // gets on the upgrade that matters. lastRunVersion ships for the first
    // time in 0.12.0-beta.1, so no 0.11.x install can ever have written it -
    // that build does not contain this code. The first backup is therefore
    // always labelled `pre-0.12`, and real version numbers only start
    // appearing from the second upgrade onwards (0.12.0-beta.1 -> -beta.2).
    const fromVersion = previousVersion || 'pre-0.12';
    const backupDir = path.join(app.getPath('userData'), 'backups', fromVersion);

    if (fs.existsSync(backupDir)) {
      // Already backed up for this source version. Do not touch it - the
      // files on disk right now may already be migrated.
      writeLastRunVersion(currentVersion);
      return { backedUp: false, reason: 'already-exists', dir: backupDir };
    }

    console.log(
      `[startup-backup] Upgrading ${fromVersion} -> ${currentVersion}, backing up to ${backupDir}`
    );
    if (onProgress) onProgress('Backing up your data before upgrading...');

    fs.mkdirSync(backupDir, { recursive: true });

    let filesWritten = 0;
    for (const target of backupTargets()) {
      if (onProgress) onProgress(`Backing up ${target.label}...`);
      const bytes = await copyOne(target, backupDir);
      if (bytes > 0) {
        filesWritten += 1;
        console.log(
          `[startup-backup] ${target.label}: ${(bytes / 1024 / 1024).toFixed(1)} MB`
        );
      }
    }

    // A manifest, so a tester (or we) can tell what a backup folder is
    // without inferring it from filenames.
    fs.writeFileSync(
      path.join(backupDir, 'backup-info.json'),
      JSON.stringify(
        {
          fromVersion,
          toVersion: currentVersion,
          createdAt: new Date().toISOString(),
          files: backupTargets().map((t) => t.dest),
          note: 'Restore by copying these files back. market_data.sqlite.gz must be gunzipped first. See BETA-TESTING.md.',
        },
        null,
        2
      ),
      'utf8'
    );

    writeLastRunVersion(currentVersion);

    // Prune only AFTER a backup has completed and its manifest is on disk.
    // Pruning first - or on a failure path - could delete a user's only
    // rollback point in order to make room for one that never got written.
    const pruned = pruneOldBackups(path.join(app.getPath('userData'), 'backups'));

    console.log(`[startup-backup] Backed up ${filesWritten} file(s) to ${backupDir}`);
    return { backedUp: true, dir: backupDir, files: filesWritten, pruned };
  } catch (error) {
    // Deliberately swallowed. A failed backup must not stop the app from
    // starting; the user is told nothing here because there is nothing they
    // can usefully do about it mid-launch.
    console.error('[startup-backup] Backup failed, continuing startup:', error);
    return { backedUp: false, reason: 'error' };
  }
}

module.exports = {
  backupBeforeMigration,
  // Exported for tests.
  backupTargets,
  pruneOldBackups,
  readLastRunVersion,
  writeLastRunVersion,
  MAX_BACKUPS,
};
