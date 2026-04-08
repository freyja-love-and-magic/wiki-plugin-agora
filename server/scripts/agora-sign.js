#!/usr/bin/env node
'use strict';

/**
 * agora-sign.js — Agora archive signing utility
 *
 * Commands:
 *   node agora-sign.js init            First run: moves agora-key.json to ~/.agora/keys/
 *                                       and removes it from this directory.
 *
 *   node agora-sign.js                 Signs manifest.json and creates a ready-to-upload zip.
 *
 *   node agora-sign.js orders          Generates a signed orders URL (opens in browser).
 *
 *   node agora-sign.js payouts         Opens Stripe Connect Express onboarding.
 *
 * Requires Node.js 16+ and sessionless-node (run `npm install` once).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ── Paths ────────────────────────────────────────────────────────────────────

const AGORA_DIR = __dirname;
const KEYS_DIR   = path.join(os.homedir(), '.agora', 'keys');
const MANIFEST   = path.join(AGORA_DIR, 'manifest.json');
const LOCAL_KEY  = path.join(AGORA_DIR, 'agora-key.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('❌  manifest.json not found in:', AGORA_DIR);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (err) {
    console.error('❌  manifest.json is not valid JSON:', err.message);
    process.exit(1);
  }
}

function getImageDimensions(buf) {
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset + 4 < buf.length) {
      if (buf[offset] !== 0xFF) break;
      const marker = buf[offset + 1];
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
          (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }
  return null;
}

function keyFilePath(uuid) {
  return path.join(KEYS_DIR, `${uuid}.json`);
}

function loadStoredKey(uuid) {
  const kp = keyFilePath(uuid);
  if (!fs.existsSync(kp)) {
    console.error('❌  No signing key found at:', kp);
    console.error('   If this is a new agora run:  node agora-sign.js init');
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
      console.log('\nIf you haven\'t connected Stripe yet, do that first:');
      console.log('  node agora-sign.js payouts <wiki-url>');
      console.log('\nTo sign and upload:  node agora-sign.js');
    } else {
      console.error('❌  agora-key.json not found and no stored key exists.');
      console.error('   Download a fresh starter bundle from your wiki.');
    }
    return;
  }

  let keyData;
  try {
    keyData = JSON.parse(fs.readFileSync(LOCAL_KEY, 'utf8'));
  } catch (err) {
    console.error('❌  agora-key.json is not valid JSON:', err.message);
    process.exit(1);
  }

  if (!keyData.privateKey || !keyData.pubKey) {
    console.error('❌  agora-key.json is missing privateKey or pubKey fields.');
    process.exit(1);
  }

  ensureDir(KEYS_DIR);
  const kp = keyFilePath(uuid);

  // chmod 600 equivalent — silently ignored on Windows
  fs.writeFileSync(kp, JSON.stringify(keyData, null, 2), { mode: 0o600 });
  fs.unlinkSync(LOCAL_KEY);

  console.log('✅  Key stored at:');
  console.log('   ', kp);
  console.log('   agora-key.json has been removed from this folder.\n');
  console.log('Next steps:');
  console.log('  1.  npm install                            (one-time, installs sessionless-node)');
  console.log('  2.  node agora-sign.js payouts <wiki-url>  (connect Stripe so you can receive payments)');
  console.log('      ⚠️  You must complete Stripe onboarding before your first upload.');
  console.log('  3.  node agora-sign.js                     (sign and zip whenever you want to upload)');
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
    console.error('⚠️   agora-key.json is still in this folder.');
    console.error('   Run  node agora-sign.js init  to store it securely first.');
    process.exit(1);
  }

  // ── Validate bio (if present) ────────────────────────────────────────────
  if (manifest.bio && typeof manifest.bio === 'object') {
    const bioDesc = manifest.bio.description ? String(manifest.bio.description).trim() : '';
    if (bioDesc.length > 2048) {
      console.error(`❌  bio.description is too long: ${bioDesc.length} characters (max 2048).`);
      process.exit(1);
    }

    // Check bio image if a bio/ folder exists
    const bioDir = path.join(AGORA_DIR, 'bio');
    if (fs.existsSync(bioDir)) {
      const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
      const bioImages = fs.readdirSync(bioDir).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
      if (bioImages.length > 0) {
        const imgBuf = fs.readFileSync(path.join(bioDir, bioImages[0]));
        const dims   = getImageDimensions(imgBuf);
        if (dims && (dims.width > 1024 || dims.height > 1024)) {
          console.error(`❌  bio image must be at most 1024×1024 px (got ${dims.width}×${dims.height}).`);
          console.error('   Please resize it before signing.');
          process.exit(1);
        }
      }
    }
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
  // Place the zip *next to* the agora folder so it can't include itself
  const folderName = path.basename(AGORA_DIR);
  const parentDir  = path.dirname(AGORA_DIR);
  const outputZip  = path.join(parentDir, `${folderName}-upload.zip`);

  if (fs.existsSync(outputZip)) {
    try { fs.unlinkSync(outputZip); } catch (_) {}
  }

  console.log('\n📦  Creating upload archive...');
  try {
    if (process.platform === 'win32') {
      // Collect items to include (exclude agora-key.json if somehow still present)
      const items = fs.readdirSync(AGORA_DIR)
        .filter(f => f !== 'agora-key.json')
        .map(f => `"${path.join(AGORA_DIR, f).replace(/"/g, '`"')}"`)
        .join(',');
      const psCmd = `Compress-Archive -Path @(${items}) -DestinationPath "${outputZip.replace(/\\/g, '\\\\')}" -Force`;
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'pipe' });
    } else {
      execSync(
        `zip -r "${outputZip}" . -x "*/agora-key.json" -x "*.mp4" -x "*.mov" -x "*.mkv" -x "*.webm" -x "*.avi"`,
        { cwd: AGORA_DIR, stdio: 'pipe' }
      );
    }
    console.log(`✅  Created: ${path.basename(outputZip)}`);
    console.log(`   Location: ${outputZip}`);
    console.log('\n   Drag that file onto your wiki\'s agora plugin to upload.');
  } catch (err) {
    console.log('⚠️   Could not auto-create zip:', err.message);
    console.log('\nZip this folder manually (excluding agora-key.json):');
    if (process.platform !== 'win32') {
      console.log(`  cd "${parentDir}"`);
      console.log(`  zip -r "${path.basename(outputZip)}" "${folderName}" -x "*/agora-key.json"`);
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
    console.error('⚠️   agora-key.json is still in this folder.');
    console.error('   Run  node agora-sign.js init  first.');
    process.exit(1);
  }

  const keyData = loadStoredKey(manifest.uuid);

  const timestamp = Date.now().toString();
  const message   = timestamp + manifest.uuid;

  sessionless.getKeys = () => ({ pubKey: keyData.pubKey, privateKey: keyData.privateKey });
  const signature = await sessionless.sign(message);

  // Determine base URL: CLI argument > manifest.wikiUrl > nothing
  const wikiUrlArg = process.argv[3];
  const baseUrl    = wikiUrlArg
    ? wikiUrlArg.replace(/\/+$/, '')
    : manifest.wikiUrl
      ? manifest.wikiUrl.replace(/\/plugin\/agora.*$/, '')
      : null;

  // Persist wikiUrl to manifest on first use so future runs don't need the arg
  if (wikiUrlArg && !manifest.wikiUrl) {
    try {
      manifest.wikiUrl = wikiUrlArg.replace(/\/+$/, '');
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
      console.log(`   Saved wiki URL to manifest.json for future use.`);
    } catch (_) { /* non-fatal */ }
  }

  const ordersPath = `/plugin/agora/${manifest.uuid}/orders?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;
  const fullUrl    = baseUrl ? `${baseUrl}${ordersPath}` : null;

  console.log('\n🔑  Signed orders URL (valid for 5 minutes):\n');
  if (fullUrl) {
    console.log('   ' + fullUrl);
  } else {
    console.log('   Path: ' + ordersPath);
    console.log('\n   Prepend your wiki URL, e.g.:');
    console.log('   https://mywiki.com' + ordersPath);
    console.log('\n   Or pass your wiki URL as an argument next time:');
    console.log('   node agora-sign.js orders https://mywiki.com');
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

// ── upload — generate a signed agora URL for video uploading ────────────────

async function upload() {
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
    console.error('⚠️   agora-key.json is still in this folder.');
    console.error('   Run  node agora-sign.js init  first.');
    process.exit(1);
  }

  const keyData = loadStoredKey(manifest.uuid);

  const timestamp = Date.now().toString();
  const message   = timestamp + manifest.uuid;

  sessionless.getKeys = () => ({ pubKey: keyData.pubKey, privateKey: keyData.privateKey });
  const signature = await sessionless.sign(message);

  const wikiUrlArg = process.argv[3];
  const baseUrl    = wikiUrlArg
    ? wikiUrlArg.replace(/\/+$/, '')
    : manifest.wikiUrl
      ? manifest.wikiUrl.replace(/\/plugin.*$/, '')
      : null;

  const agoraPath =`/plugin/agora/${manifest.uuid}?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;
  const fullUrl    = baseUrl ? `${baseUrl}${agoraPath}` : null;

  console.log('\n🎬  Signed agora URL for video uploading (valid for 24 hours):\n');
  if (fullUrl) {
    console.log('   ' + fullUrl);
  } else {
    console.log('   Path: ' + agoraPath);
    console.log('\n   Prepend your wiki URL, e.g.:');
    console.log('   https://mywiki.com' + agoraPath);
    console.log('\n   Or pass your wiki URL as an argument:');
    console.log('   node agora-sign.js upload https://mywiki.com');
  }

  if (fullUrl) {
    console.log('\n   Opening in browser...');
    try {
      const open = process.platform === 'win32' ? 'start' :
                   process.platform === 'darwin' ? 'open' : 'xdg-open';
      execSync(`${open} "${fullUrl}"`, { stdio: 'ignore' });
    } catch (_) {}
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
    console.error('⚠️   agora-key.json is still in this folder.');
    console.error('   Run  node agora-sign.js init  first.');
    process.exit(1);
  }

  const keyData = loadStoredKey(manifest.uuid);

  const timestamp = Date.now().toString();
  const message   = timestamp + manifest.uuid;

  sessionless.getKeys = () => ({ pubKey: keyData.pubKey, privateKey: keyData.privateKey });
  const signature = await sessionless.sign(message);

  const wikiUrlArg = process.argv[3];
  const baseUrl    = wikiUrlArg
    ? wikiUrlArg.replace(/\/+$/, '')
    : manifest.wikiUrl
      ? manifest.wikiUrl.replace(/\/plugin\/agora.*$/, '')
      : null;

  if (wikiUrlArg && !manifest.wikiUrl) {
    try {
      manifest.wikiUrl = wikiUrlArg.replace(/\/+$/, '');
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
      console.log(`   Saved wiki URL to manifest.json for future use.`);
    } catch (_) { /* non-fatal */ }
  }

  const payoutsPath = `/plugin/agora/${manifest.uuid}/payouts?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;
  const fullUrl     = baseUrl ? `${baseUrl}${payoutsPath}` : null;

  console.log('\n💳  Stripe Connect onboarding URL (valid for 5 minutes):\n');
  if (fullUrl) {
    console.log('   ' + fullUrl);
  } else {
    console.log('   Path: ' + payoutsPath);
    console.log('\n   Prepend your wiki URL, e.g.:');
    console.log('   https://mywiki.com' + payoutsPath);
    console.log('\n   Or pass your wiki URL as an argument next time:');
    console.log('   node agora-sign.js payouts https://mywiki.com');
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
} else if (command === 'upload') {
  upload().catch(err => {
    console.error('❌ ', err.message);
    process.exit(1);
  });
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
  console.error('Usage:  node agora-sign.js [init | orders [wiki-url] | payouts [wiki-url]]');
  process.exit(1);
}
