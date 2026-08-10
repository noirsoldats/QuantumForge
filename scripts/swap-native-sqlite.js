#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');
const RELEASE_DIR = path.join(MODULE_DIR, 'build', 'Release');
const BINARY_PATH = path.join(RELEASE_DIR, 'better_sqlite3.node');
const FORGE_META_PATH = path.join(RELEASE_DIR, '.forge-meta');
const CACHE_ROOT = path.join(ROOT, '.native-cache', 'better-sqlite3');

function getBetterSqlite3Version() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(MODULE_DIR, 'package.json'), 'utf8')
  );
  return pkg.version;
}

function getNodeAbi() {
  return process.versions.modules;
}

function getElectronAbi() {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  const output = execFileSync(
    electronBin,
    ['-e', 'console.log(process.versions.modules)'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    }
  );
  return output.trim();
}

function cachePathFor(version, abi) {
  return path.join(CACHE_ROOT, version, String(abi), 'better_sqlite3.node');
}

function copyIntoCache(version, abi) {
  const dest = cachePathFor(version, abi);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(BINARY_PATH, dest);
}

function copyFromCache(version, abi) {
  const src = cachePathFor(version, abi);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.copyFileSync(src, BINARY_PATH);
}

/**
 * Record which (arch, ABI) the in-place binary was built for.
 *
 * This is a HINT for humans reading the tree, never the source of truth: the
 * binary is also replaced by things that never touch this file (`postinstall`
 * -> `electron-builder install-app-deps`, `npm run rebuild` -> electron-rebuild,
 * a fresh `npm install`). Trusting it would report success on a broken tree.
 * `isUsableUnder` is the authority.
 */
function writeForgeMeta(arch, abi) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(FORGE_META_PATH, `${arch}--${abi}`);
}

function readForgeMeta() {
  try {
    return fs.readFileSync(FORGE_META_PATH, 'utf8').trim() || '(empty)';
  } catch (_) {
    return '(missing)';
  }
}

/**
 * Ground truth: can the in-place binary actually be USED by `target`?
 *
 * `require()` alone proves nothing - better-sqlite3 12.x uses `bindings`, not
 * N-API, so requiring a wrong-ABI binary SUCCEEDS and only aborts much later
 * inside GC (`Assertion failed: (env) != nullptr`, seen as a SIGABRT'd jest
 * worker). Constructing a Database is what actually surfaces
 * ERR_DLOPEN_FAILED, so the probe must go that far.
 *
 * Runs in a subprocess: an in-process require would poison this process's own
 * module cache and pin the binary open on Windows.
 *
 * @returns {boolean}
 */
function isUsableUnder(target) {
  const probe =
    'const D=require(process.argv[1]);' +
    "const db=new D(':memory:');db.exec('CREATE TABLE t(a)');db.close();";
  const bin =
    target === 'node'
      ? process.execPath
      : path.join(ROOT, 'node_modules', '.bin', 'electron');
  const env =
    target === 'electron'
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : process.env;

  try {
    execFileSync(bin, ['-e', probe, MODULE_DIR], { cwd: ROOT, env, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Assert the swap actually worked, and evict the cache entry if it did not.
 *
 * A cache entry that fails here is poisoned - it was cached from a build that
 * never worked (see the npm 11 `--build-from-source` no-op below), so deleting
 * it is what lets the next run rebuild instead of copying the same bad file
 * back forever.
 */
function verifySwap(target, version, abi) {
  if (isUsableUnder(target)) return;

  // Only claim an eviction if something was actually there - `force: true`
  // succeeds silently on a missing path, so existsSync is what makes the
  // reported message honest.
  const cached = cachePathFor(version, abi);
  let evicted = false;
  if (fs.existsSync(cached)) {
    try {
      fs.rmSync(cached, { force: true });
      evicted = true;
    } catch (_) {
      /* unreadable/locked - the guidance below still applies */
    }
  }

  throw new Error(
    `[swap-native-sqlite] better-sqlite3 is NOT usable under the ${target} ABI after swapping.\n` +
      `  better-sqlite3: ${version}\n` +
      `  expected ABI:   ${abi}\n` +
      `  .forge-meta:    ${readForgeMeta()}\n` +
      (evicted
        ? '  Evicted the bad cache entry - re-run to rebuild from source.\n'
        : '') +
      `  If it persists: rm -rf .native-cache && npm run rebuild:${target} -- --force`
  );
}

function runRealRebuild(target) {
  if (target === 'node') {
    // NOTE: `--build-from-source` is NOT an npm flag - npm 11 warns
    // "Unknown cli config" and still exits 0 having done nothing. It is passed
    // through to node-gyp/prebuild-install by older npm, so it stays for
    // compatibility, but its presence must never be taken as proof that a
    // source build happened. verifySwap() is what actually catches a no-op.
    execFileSync('npm', ['rebuild', 'better-sqlite3', '--build-from-source'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } else {
    execFileSync('npx', ['electron-rebuild'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

/**
 * Put a better-sqlite3 binary matching `target`'s ABI in place.
 *
 * Every ABI here is discovered at RUNTIME - the running Node's
 * `process.versions.modules`, and the installed Electron's, read by executing
 * it. Nothing is hardcoded, so this is correct on Node 24, 26, or anything
 * else, and it retargets automatically when Electron is upgraded.
 *
 * The function is idempotent and self-correcting: it trusts nothing about the
 * current on-disk state, because `postinstall` and `electron-rebuild` both
 * replace the binary behind its back.
 */
function swap(target, { force = false } = {}) {
  if (target !== 'node' && target !== 'electron') {
    throw new Error(`Unknown swap target "${target}" (expected "node" or "electron")`);
  }

  const version = getBetterSqlite3Version();
  const abi = target === 'node' ? getNodeAbi() : getElectronAbi();
  const arch = process.arch;

  // Already correct? Nothing to copy - just make the metadata truthful, since
  // whatever put this binary here may not have updated it.
  if (!force && isUsableUnder(target)) {
    console.log(
      `[swap-native-sqlite] already usable under ${target} ABI ${abi} (better-sqlite3@${version}).`
    );
    writeForgeMeta(arch, abi);
    return;
  }

  if (!force && fs.existsSync(cachePathFor(version, abi))) {
    console.log(
      `[swap-native-sqlite] cache hit for ${target} ABI ${abi} (better-sqlite3@${version}), copying...`
    );
    copyFromCache(version, abi);
    writeForgeMeta(arch, abi);
    // A cached binary can still be bad - verify before trusting it.
    verifySwap(target, version, abi);
    return;
  }

  console.log(
    force
      ? `[swap-native-sqlite] --force passed, rebuilding for ${target} ABI ${abi}...`
      : `[swap-native-sqlite] cache miss for ${target} ABI ${abi} (better-sqlite3@${version}), rebuilding from source...`
  );
  runRealRebuild(target);
  writeForgeMeta(arch, abi);

  // Verify BEFORE caching, so a failed/no-op rebuild can never poison the cache.
  verifySwap(target, version, abi);

  copyIntoCache(version, abi);
  console.log(`[swap-native-sqlite] cached ${target} build for future swaps.`);
}

function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  const force = args.includes('--force');

  if (!target) {
    console.error('Usage: node scripts/swap-native-sqlite.js <node|electron> [--force]');
    process.exit(1);
  }

  try {
    swap(target, { force });
  } catch (err) {
    // Print the actionable message on its own, without a stack trace burying it.
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { swap };
