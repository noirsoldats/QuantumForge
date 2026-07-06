#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { swap } = require('./swap-native-sqlite');

const ROOT = path.resolve(__dirname, '..');

function swapBackToElectron() {
  try {
    swap('electron');
  } catch (err) {
    console.error('[run-tests] FAILED to swap better-sqlite3 back to Electron ABI:');
    console.error(err.message);
    console.error('[run-tests] Run "npm run rebuild:electron" manually before launching the app.');
  }
}

function main() {
  swap('node');

  const jestArgs = process.argv.slice(2);
  const jestBin = path.join(ROOT, 'node_modules', '.bin', 'jest');
  let result;

  try {
    result = spawnSync(jestBin, jestArgs, { cwd: ROOT, stdio: 'inherit' });
  } finally {
    swapBackToElectron();
  }

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status === null ? 1 : result.status);
}

main();
