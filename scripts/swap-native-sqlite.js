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

function copyFromCache(version, abi, arch) {
  const src = cachePathFor(version, abi);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.copyFileSync(src, BINARY_PATH);
  fs.writeFileSync(FORGE_META_PATH, `${arch}--${abi}`);
}

function runRealRebuild(target) {
  if (target === 'node') {
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

function swap(target, { force = false } = {}) {
  if (target !== 'node' && target !== 'electron') {
    throw new Error(`Unknown swap target "${target}" (expected "node" or "electron")`);
  }

  const version = getBetterSqlite3Version();
  const abi = target === 'node' ? getNodeAbi() : getElectronAbi();
  const arch = process.arch;

  if (!force && fs.existsSync(cachePathFor(version, abi))) {
    console.log(
      `[swap-native-sqlite] cache hit for ${target} ABI ${abi} (better-sqlite3@${version}), copying...`
    );
    copyFromCache(version, abi, arch);
    return;
  }

  console.log(
    force
      ? `[swap-native-sqlite] --force passed, rebuilding for ${target} ABI ${abi}...`
      : `[swap-native-sqlite] cache miss for ${target} ABI ${abi} (better-sqlite3@${version}), rebuilding from source...`
  );
  runRealRebuild(target);
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

  swap(target, { force });
}

if (require.main === module) {
  main();
}

module.exports = { swap };
