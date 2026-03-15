#!/usr/bin/env node
'use strict';

/**
 * shoppe-sign.js — Shoppe archive signing utility
 *
 * Commands:
 *   node shoppe-sign.js init            First run: moves shoppe-key.json to ~/.shoppe/keys/
 *                                       and removes it from this directory.
 *
 *   node shoppe-sign.js                 Signs manifest.json and creates a ready-to-upload zip.
 *
 *   node shoppe-sign.js orders          Generates a signed orders URL (opens in browser).
 *
 *   node shoppe-sign.js payouts         Opens Stripe Connect Express onboarding.
 *
 * Requires Node.js 16+ and sessionless-node (run `npm install` once).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ── Paths ────────────────────────────────────────────────────────────────────

const SHOPPE_DIR = __dirname;
const KEYS_DIR   = path.join(os.homedir(), '.shoppe', 'keys');
const MANIFEST   = path.join(SHOPPE_DIR, 'manifest.json');
const LOCAL_KEY  = path.join(SHOPPE_DIR, 'shoppe-key.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('❌  manifest.json not found in:', SHOPPE_DIR);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (err) {
    console.error('❌  manifest.json is not valid JSON:', err.message);
    process.exit(1);
  }
}

function keyFilePath(uuid) {
  return path.join(KEYS_DIR, `${uuid}.json`);
}

function loadStoredKey(uuid) {
  const kp = keyFilePath(uuid);
  if (!fs.existsSync(kp)) {
    console.error('❌  No signing key found at:', kp);
    console.error('   If this is a new shoppe run:  node shoppe-sign.js init');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(kp, 'utf8'));
  } catch (err) {
    console.error('❌  Key file is corrupted:', err.message);
    process.exit(1);
  }
}

// ── init — move key to secure storage ───────────────────────────────────────
// This command intentionally requires no npm install so it works immediately
// after unzipping the starter bundle.

function init() {
  const manifest = readManifest();
  const uuid = manifest.uuid;

  if (!fs.existsSync(LOCAL_KEY)) {
    const kp = keyFilePath(uuid);
    if (fs.existsSync(kp)) {
      console.log('✅  Already initialized. Your key is at:');
      console.log('   ', kp);
      console.log('\nWhenever you want to upload, run:  node shoppe-sign.js');
    } else {
      console.error('❌  shoppe-key.json not found and no stored key exists.');
      console.error('   Download a fresh starter bundle from your wiki.');
    }
    return;
  }

  let keyData;
  try {
    keyData = JSON.parse(fs.readFileSync(LOCAL_KEY, 'utf8'));
  } catch (err) {
    console.error('❌  shoppe-key.json is not valid JSON:', err.message);
    process.exit(1);
  }

  if (!keyData.privateKey || !keyData.pubKey) {
    console.error('❌  shoppe-key.json is missing privateKey or pubKey fields.');
    process.exit(1);
  }

  ensureDir(KEYS_DIR);
  const kp = keyFilePath(uuid);

  // chmod 600 equivalent — silently ignored on Windows
  fs.writeFileSync(kp, JSON.stringify(keyData, null, 2), { mode: 0o600 });
  fs.unlinkSync(LOCAL_KEY);

  console.log('✅  Key stored at:');
  console.log('   ', kp);
  console.log('   shoppe-key.json has been removed from this folder.\n');
  console.log('Next steps:');
  console.log('  npm install           (one-time, installs sessionless-node)');
  console.log('  node shoppe-sign.js   (sign and zip whenever you want to upload)');
}

// ── sign — sign manifest and create upload zip ───────────────────────────────

async function sign() {
  // Require sessionless-node — give a clear error if not yet installed
  let sessionless;
  try {
    sessionless = require('sessionless-node');
  } catch (err) {
    console.error('❌  sessionless-node is not installed.');
    console.error('   Run: npm install');
    process.exit(1);
  }

  const manifest = readManifest();

  if (!manifest.uuid) {
    console.error('❌  manifest.json is missing uuid.');
    process.exit(1);
  }

  if (fs.existsSync(LOCAL_KEY)) {
    console.error('⚠️   shoppe-key.json is still in this folder.');
    console.error('   Run  node shoppe-sign.js init  to store it securely first.');
    process.exit(1);
  }

  const keyData = loadStoredKey(manifest.uuid);

  // Sign with sessionless (secp256k1, message = timestamp + uuid)
  const timestamp = Date.now().toString();
  const message   = timestamp + manifest.uuid;

  sessionless.getKeys = () => ({ pubKey: keyData.pubKey, privateKey: keyData.privateKey });
  const signature = await sessionless.sign(message);

  // Strip any previous signature fields, then write fresh ones
  const { ownerPubKey: _a, timestamp: _b, signature: _c, ...cleanManifest } = manifest;
  const signedManifest = { ...cleanManifest, ownerPubKey: keyData.pubKey, timestamp, signature };

  fs.writeFileSync(MANIFEST, JSON.stringify(signedManifest, null, 2));
  console.log('✅  manifest.json signed.');

  createZip();
}

// ── zip ──────────────────────────────────────────────────────────────────────

function createZip() {
  // Place the zip *next to* the shoppe folder so it can't include itself
  const folderName = path.basename(SHOPPE_DIR);
  const parentDir  = path.dirname(SHOPPE_DIR);
  const outputZip  = path.join(parentDir, `${folderName}-upload.zip`);

  if (fs.existsSync(outputZip)) {
    try { fs.unlinkSync(outputZip); } catch (_) {}
  }

  console.log('\n📦  Creating upload archive...');
  try {
    if (process.platform === 'win32') {
      // Collect items to include (exclude shoppe-key.json if somehow still present)
      const items = fs.readdirSync(SHOPPE_DIR)
        .filter(f => f !== 'shoppe-key.json')
        .map(f => `"${path.join(SHOPPE_DIR, f).replace(/"/g, '`"')}"`)
        .join(',');
      const psCmd = `Compress-Archive -Path @(${items}) -DestinationPath "${outputZip.replace(/\\/g, '\\\\')}" -Force`;
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'pipe' });
    } else {
      execSync(
        `zip -r "${outputZip}" . -x "*/shoppe-key.json"`,
        { cwd: SHOPPE_DIR, stdio: 'pipe' }
      );
    }
    console.log(`✅  Created: ${path.basename(outputZip)}`);
    console.log(`   Location: ${outputZip}`);
    console.log('\n   Drag that file onto your wiki\'s shoppe plugin to upload.');
  } catch (err) {
    console.log('⚠️   Could not auto-create zip:', err.message);
    console.log('\nZip this folder manually (excluding shoppe-key.json):');
    if (process.platform !== 'win32') {
      console.log(`  cd "${parentDir}"`);
      console.log(`  zip -r "${path.basename(outputZip)}" "${folderName}" -x "*/shoppe-key.json"`);
    } else {
      console.log('  Right-click the folder in File Explorer → Send to → Compressed folder');
    }
  }
}

// ── orders — generate a signed orders URL ────────────────────────────────────

async function orders() {
  let sessionless;
  try {
    sessionless = require('sessionless-node');
  } catch (err) {
    console.error('❌  sessionless-node is not installed.');
    console.error('   Run: npm install');
    process.exit(1);
  }

  const manifest = readManifest();

  if (!manifest.uuid) {
    console.error('❌  manifest.json is missing uuid.');
    process.exit(1);
  }

  if (fs.existsSync(LOCAL_KEY)) {
    console.error('⚠️   shoppe-key.json is still in this folder.');
    console.error('   Run  node shoppe-sign.js init  first.');
    process.exit(1);
  }

  const keyData = loadStoredKey(manifest.uuid);

  const timestamp = Date.now().toString();
  const message   = timestamp + manifest.uuid;

  sessionless.getKeys = () => ({ pubKey: keyData.pubKey, privateKey: keyData.privateKey });
  const signature = await sessionless.sign(message);

  // Determine base URL: manifest.wikiUrl, CLI argument, or just show the path
  const wikiUrlArg = process.argv[3];
  const baseUrl    = wikiUrlArg
    ? wikiUrlArg.replace(/\/+$/, '')
    : manifest.wikiUrl
      ? manifest.wikiUrl.replace(/\/orders.*$/, '') // strip any existing /orders path
      : null;

  const ordersPath = `/plugin/shoppe/${manifest.uuid}/orders?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;
  const fullUrl    = baseUrl ? `${baseUrl}/orders?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}` : null;

  console.log('\n🔑  Signed orders URL (valid for 5 minutes):\n');
  if (fullUrl) {
    console.log('   ' + fullUrl);
  } else {
    console.log('   Path: ' + ordersPath);
    console.log('\n   Prepend your wiki URL, e.g.:');
    console.log('   https://mywiki.com' + ordersPath);
    console.log('\n   Or pass your wiki URL as an argument next time:');
    console.log('   node shoppe-sign.js orders https://mywiki.com');
  }

  // Try to open in the default browser
  if (fullUrl) {
    console.log('\n   Opening in browser...');
    try {
      const open = process.platform === 'win32' ? 'start' :
                   process.platform === 'darwin' ? 'open' : 'xdg-open';
      execSync(`${open} "${fullUrl}"`, { stdio: 'ignore' });
    } catch (_) {
      // Browser open failed — URL is still printed above
    }
  }
  console.log('');
}

// ── payouts — open Stripe Connect Express onboarding ─────────────────────────

async function payouts() {
  let sessionless;
  try {
    sessionless = require('sessionless-node');
  } catch (err) {
    console.error('❌  sessionless-node is not installed.');
    console.error('   Run: npm install');
    process.exit(1);
  }

  const manifest = readManifest();

  if (!manifest.uuid) {
    console.error('❌  manifest.json is missing uuid.');
    process.exit(1);
  }

  if (fs.existsSync(LOCAL_KEY)) {
    console.error('⚠️   shoppe-key.json is still in this folder.');
    console.error('   Run  node shoppe-sign.js init  first.');
    process.exit(1);
  }

  const keyData = loadStoredKey(manifest.uuid);

  const timestamp = Date.now().toString();
  const message   = timestamp + manifest.uuid;

  sessionless.getKeys = () => ({ pubKey: keyData.pubKey, privateKey: keyData.privateKey });
  const signature = await sessionless.sign(message);

  // Determine base URL: manifest.wikiUrl, CLI argument, or just show the path
  const wikiUrlArg = process.argv[3];
  const baseUrl    = wikiUrlArg
    ? wikiUrlArg.replace(/\/+$/, '')
    : manifest.wikiUrl
      ? manifest.wikiUrl.replace(/\/payouts.*$/, '') // strip any existing /payouts path
      : null;

  const payoutsPath = `/plugin/shoppe/${manifest.uuid}/payouts?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;
  const fullUrl     = baseUrl ? `${baseUrl}/payouts?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}` : null;

  console.log('\n💳  Stripe Connect onboarding URL (valid for 5 minutes):\n');
  if (fullUrl) {
    console.log('   ' + fullUrl);
  } else {
    console.log('   Path: ' + payoutsPath);
    console.log('\n   Prepend your wiki URL, e.g.:');
    console.log('   https://mywiki.com' + payoutsPath);
    console.log('\n   Or pass your wiki URL as an argument next time:');
    console.log('   node shoppe-sign.js payouts https://mywiki.com');
  }

  // Try to open in the default browser
  if (fullUrl) {
    console.log('\n   Opening in browser...');
    try {
      const open = process.platform === 'win32' ? 'start' :
                   process.platform === 'darwin' ? 'open' : 'xdg-open';
      execSync(`${open} "${fullUrl}"`, { stdio: 'ignore' });
    } catch (_) {
      // Browser open failed — URL is still printed above
    }
  }
  console.log('');
}

// ── main ─────────────────────────────────────────────────────────────────────

const command = process.argv[2];
if (command === 'init') {
  init();
} else if (command === 'orders') {
  orders().catch(err => {
    console.error('❌ ', err.message);
    process.exit(1);
  });
} else if (command === 'payouts') {
  payouts().catch(err => {
    console.error('❌ ', err.message);
    process.exit(1);
  });
} else if (command === undefined) {
  sign().catch(err => {
    console.error('❌ ', err.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage:  node shoppe-sign.js [init | orders [wiki-url] | payouts [wiki-url]]');
  process.exit(1);
}
