'use strict';

/**
 * Sandbox isolation for the benchmark harness.
 *
 * The benchmark boots the REAL application code against a throwaway data
 * directory, so the single thing that matters here is that no benchmark run can
 * read or write the developer's live Quantum Forge data.
 *
 * WHY THERE IS NO BACKUP/RESTORE
 * ------------------------------
 * An earlier design wrapped every run in `bin/config-manager.sh backup` plus a
 * restore on exit. That was removed: `cmd_restore` runs `rm -rf "$USERDATA_PATH"`
 * before copying, so a harness bug, a mistimed trap, or a Ctrl-C mid-restore
 * could destroy real data that was never at risk. Redirecting the data path
 * PREVENTS the write; restoring only UNDOES it. Adding a destructive operation
 * to guard a non-destructive one is a net increase in risk, so this module
 * relies on prevention alone - and proves it, via assertSandboxed().
 *
 * THE ORDERING RULE (the one way this can silently fail)
 * ------------------------------------------------------
 * `config-migration.js` calls `getDataPath()` at MODULE LOAD TIME and caches
 * `configDir` in a module-level constant. Every database path in the app
 * derives from that one `getConfigDir()` choke point. So:
 *
 *     require('config-migration')  ->  then setPath   ==  BROKEN
 *     setPath                      ->  then require   ==  correct
 *
 * In the broken order `app.getPath('userData')` reports the sandbox while
 * `getConfigDir()` still points at the developer's real config - the databases
 * escape the sandbox while the redirect appears to have worked. This was
 * reproduced directly, not theorised. `assertSandboxed()` below exists to turn
 * that silent failure into a loud abort.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Resolve the developer's REAL user-data directory - the thing we must never
 * touch. Mirrors Electron's own per-platform `userData` resolution for the
 * "Quantum Forge" product name, without requiring electron (this is also
 * callable from a plain-node parent process).
 *
 * @returns {string}
 */
function getLiveUserDataPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Quantum Forge');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Quantum Forge');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Quantum Forge');
  }
}

/**
 * Redirect the app's userData at `dir`.
 *
 * MUST be called before requiring ANY module under src/main - see the ordering
 * rule above. Call this as the first statement after `require('electron')` in a
 * benchmark entry point.
 *
 * @param {Electron.App} app  the electron `app` object
 * @param {string} dir        absolute path to the sandbox directory
 * @returns {string} the resolved sandbox path
 */
function redirectUserData(app, dir) {
  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });

  const live = getLiveUserDataPath();
  if (isInside(target, live) || path.resolve(target) === path.resolve(live)) {
    throw new Error(
      `[sandbox] refusing to use a sandbox inside the live user data directory.\n` +
      `  sandbox: ${target}\n  live:    ${live}`
    );
  }

  app.setPath('userData', target);
  return target;
}

/**
 * True when `child` is the same path as, or nested inside, `parent`.
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Prove the redirect actually took, and abort if it did not.
 *
 * This is a POSITIVE check on the real resolved values rather than an
 * assumption that `setPath` was called early enough. It requires
 * `config-migration` itself - safe here, because by the time this runs the
 * redirect is already in place, and requiring it is exactly what we want to
 * measure.
 *
 * @param {Electron.App} app
 * @param {string} sandboxDir
 * @throws if userData or the derived config dir resolves outside the sandbox
 */
function assertSandboxed(app, sandboxDir) {
  const target = path.resolve(sandboxDir);
  const userData = app.getPath('userData');

  if (!isInside(userData, target)) {
    throw new Error(
      `[sandbox] userData escaped the sandbox.\n` +
      `  expected inside: ${target}\n  actual:          ${userData}`
    );
  }

  // The load-bearing check. getConfigDir() is where every database path comes
  // from, and it caches at require time - so this is the value that reveals a
  // require-before-setPath ordering bug.
  const { getConfigDir } = require('../../src/main/config-migration');
  const configDir = getConfigDir();

  if (!isInside(configDir, target)) {
    throw new Error(
      `[sandbox] config dir escaped the sandbox - this means a src/main module was\n` +
      `required BEFORE app.setPath('userData', ...). See the ordering rule in\n` +
      `scripts/lib/sandbox.js.\n` +
      `  expected inside: ${target}\n  actual:          ${configDir}`
    );
  }

  return { userData, configDir };
}

/**
 * Recursively census mtime + size of every file under `dir`.
 *
 * Used to prove, by absence, that a run never wrote to the live config. Cheap,
 * and it catches any future code path that bypasses getConfigDir() entirely.
 *
 * @param {string} dir
 * @returns {Map<string, string>} relative path -> "mtimeMs:size"
 */
function censusTree(dir) {
  const out = new Map();
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return out;

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return; // unreadable (permissions, vanished mid-walk) - skip
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          out.set(path.relative(root, full), `${st.mtimeMs}:${st.size}`);
        } catch (_) {
          // vanished between readdir and stat - skip
        }
      }
    }
  };

  walk(root);
  return out;
}

/**
 * Diff two censuses taken around a run.
 *
 * @param {Map<string,string>} before
 * @param {Map<string,string>} after
 * @returns {{changed: string[], added: string[], removed: string[], clean: boolean}}
 */
function diffCensus(before, after) {
  const changed = [];
  const added = [];
  const removed = [];

  for (const [file, stamp] of after) {
    if (!before.has(file)) added.push(file);
    else if (before.get(file) !== stamp) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) removed.push(file);
  }

  return {
    changed,
    added,
    removed,
    clean: changed.length === 0 && added.length === 0 && removed.length === 0,
  };
}

module.exports = {
  getLiveUserDataPath,
  redirectUserData,
  assertSandboxed,
  censusTree,
  diffCensus,
  isInside,
};
