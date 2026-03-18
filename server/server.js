(function() {
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const AdmZip = require('adm-zip');
const sessionless = require('sessionless-node');

const SHOPPE_BASE_EMOJI = process.env.SHOPPE_BASE_EMOJI || '🛍️🎨🎁';

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const RECOVER_STRIPE_TMPL      = fs.readFileSync(path.join(TEMPLATES_DIR, 'generic-recover-stripe.html'), 'utf8');
const ADDRESS_STRIPE_TMPL      = fs.readFileSync(path.join(TEMPLATES_DIR, 'generic-address-stripe.html'), 'utf8');
const EBOOK_DOWNLOAD_TMPL      = fs.readFileSync(path.join(TEMPLATES_DIR, 'ebook-download.html'), 'utf8');
const APPOINTMENT_BOOKING_TMPL   = fs.readFileSync(path.join(TEMPLATES_DIR, 'appointment-booking.html'), 'utf8');
const SUBSCRIPTION_SUBSCRIBE_TMPL = fs.readFileSync(path.join(TEMPLATES_DIR, 'subscription-subscribe.html'), 'utf8');
const SUBSCRIPTION_MEMBERSHIP_TMPL = fs.readFileSync(path.join(TEMPLATES_DIR, 'subscription-membership.html'), 'utf8');

const SUBSCRIPTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // default 30-day billing period


function fillTemplate(tmpl, vars) {
  return Object.entries(vars).reduce((html, [k, v]) =>
    html.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v), tmpl);
}

const DATA_DIR     = path.join(process.env.HOME || '/root', '.shoppe');
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');
const BUYERS_FILE  = path.join(DATA_DIR, 'buyers.json');
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
// Shipping addresses are stored locally only — never forwarded to Sanora or any third party.
// This file contains PII (name, address). Purge individual records once orders ship.
const ORDERS_FILE  = path.join(DATA_DIR, 'orders.json');
const TMP_DIR      = '/tmp/shoppe-uploads';

// ============================================================
// CONFIG (allyabase URL, etc.)
// ============================================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Derive the public-facing protocol from the request, respecting reverse-proxy headers.
// Behind HTTPS proxies req.protocol is 'http'; X-Forwarded-Proto carries the real value.
function reqProto(req) {
  return (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
}

function getSanoraUrl() {
  const config = loadConfig();
  if (config.sanoraUrl) return config.sanoraUrl.replace(/\/$/, '');
  return `http://localhost:${process.env.SANORA_PORT || 7243}`;
}

function getAddieUrl() {
  try { return new URL(getSanoraUrl()).origin + '/plugin/allyabase/addie'; } catch { /* fall through */ }
  return `http://localhost:${process.env.ADDIE_PORT || 3005}`;
}

function getLucilleUrl() {
  const config = loadConfig();
  if (config.lucilleUrl) return config.lucilleUrl.replace(/\/$/, '');
  return `http://localhost:${process.env.LUCILLE_PORT || 5444}`;
}

function loadBuyers() {
  if (!fs.existsSync(BUYERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BUYERS_FILE, 'utf8')); } catch { return {}; }
}

function saveBuyers(buyers) {
  fs.writeFileSync(BUYERS_FILE, JSON.stringify(buyers, null, 2));
}

async function getOrCreateBuyerAddieUser(recoveryKey, productId) {
  const buyerKey = recoveryKey + productId;
  const buyers = loadBuyers();
  if (buyers[buyerKey]) return buyers[buyerKey];

  const addieKeys = await sessionless.generateKeys(() => {}, () => null);
  sessionless.getKeys = () => addieKeys;
  const timestamp = Date.now().toString();
  const message = timestamp + addieKeys.pubKey;
  const signature = await sessionless.sign(message);

  const resp = await fetch(`${getAddieUrl()}/user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: addieKeys.pubKey, signature })
  });

  const addieUser = await resp.json();
  if (addieUser.error) throw new Error(`Addie: ${addieUser.error}`);

  const buyer = { uuid: addieUser.uuid, pubKey: addieKeys.pubKey, privateKey: addieKeys.privateKey };
  buyers[buyerKey] = buyer;
  saveBuyers(buyers);
  return buyer;
}

// Same diverse palette as BDO emojicoding
const EMOJI_PALETTE = [
  '🌟', '🌙', '🌍', '🌊', '🔥', '💎', '🎨', '🎭', '🎪', '🎯',
  '🎲', '🎸', '🎹', '🎺', '🎻', '🏆', '🏹', '🏺', '🏰', '🏔',
  '🐉', '🐙', '🐚', '🐝', '🐞', '🐢', '🐳', '🐺', '🐻', '🐼',
  '👑', '👒', '👓', '👔', '👕', '💀', '💡', '💣', '💫', '💰',
  '💼', '📌', '📍', '📎', '📐', '📑', '📕', '📗', '📘', '📙',
  '📚', '📝', '📡', '📢', '📣', '📦', '📧', '📨', '📬', '📮',
  '🔑', '🔒', '🔓', '🔔', '🔨', '🔩', '🔪', '🔫', '🔮', '🔱',
  '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙',
  '🗝', '🗡', '🗿', '😀', '😁', '😂', '😃', '😄', '😅', '😆',
  '🙂', '🙃', '🙄', '🚀', '🚁', '🚂', '🚃', '🚄', '🚅', '🚆'
];

const BOOK_EXTS  = new Set(['.epub', '.pdf', '.mobi', '.azw', '.azw3']);
const MUSIC_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);

// ============================================================
// MARKDOWN / FRONT MATTER UTILITIES
// ============================================================

// Parse +++ TOML or --- YAML front matter from a markdown string.
// Returns { title, date, preview, body } — body is the content after the block.
function parseFrontMatter(content) {
  const result = { title: null, date: null, preview: null, body: content };
  const m = content.match(/^(\+\+\+|---)\s*\n([\s\S]*?)\n\1\s*\n?([\s\S]*)/);
  if (!m) return result;
  const fm = m[2];
  result.body = m[3] || '';
  const grab = key => { const r = fm.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm')); return r ? r[1] : null; };
  result.title   = grab('title');
  result.date    = grab('date') || grab('updated');
  result.preview = grab('preview');
  return result;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Extract kw:-prefixed entries from a Sanora product's tags string into a comma-separated keyword list.
function extractKeywords(product) {
  return (product.tags || '').split(',')
    .filter(t => t.startsWith('kw:'))
    .map(t => t.slice(3).trim())
    .join(', ');
}

// Append keyword tags (as kw:word entries) to a base tags string.
function buildTags(baseTags, keywords) {
  const kwTags = (Array.isArray(keywords) ? keywords : [])
    .map(kw => `kw:${kw.trim()}`).filter(Boolean);
  if (!kwTags.length) return baseTags;
  return baseTags + ',' + kwTags.join(',');
}

// ── Owner key pair (secp256k1 via sessionless) ───────────────────────────────

async function generateOwnerKeyPair() {
  const keys = await sessionless.generateKeys(() => {}, () => null);
  return { pubKey: keys.pubKey, privateKey: keys.privateKey };
}

// Validate owner signature embedded in a manifest.
// If the tenant has no ownerPubKey (registered before this feature), validation is skipped.
function validateOwnerSignature(manifest, tenant) {
  if (!tenant.ownerPubKey) return; // legacy tenant — no signature required

  if (!manifest.ownerPubKey || !manifest.timestamp || !manifest.signature) {
    throw new Error(
      'Archive is missing owner signature fields. Sign it first:\n' +
      '  node shoppe-sign.js'
    );
  }
  if (manifest.ownerPubKey !== tenant.ownerPubKey) {
    throw new Error('Owner public key does not match the registered key for this shoppe');
  }
  const age = Date.now() - parseInt(manifest.timestamp, 10);
  if (isNaN(age) || age < 0 || age > 10 * 60 * 1000) {
    throw new Error('Signature timestamp is invalid or expired — re-run: node shoppe-sign.js');
  }
  const message = manifest.timestamp + manifest.uuid;
  if (!sessionless.verifySignature(manifest.signature, message, manifest.ownerPubKey)) {
    throw new Error('Owner signature verification failed');
  }
}

// Single-use bundle tokens: token → { uuid, expiresAt }
const bundleTokens = new Map();

// Build the starter bundle zip for a newly registered tenant.
function generateBundleBuffer(tenant, ownerPrivateKey, ownerPubKey, wikiOrigin) {
  const SIGN_SCRIPT = fs.readFileSync(
    path.join(__dirname, 'scripts', 'shoppe-sign.js')
  );

  const manifest = {
    uuid:     tenant.uuid,
    emojicode: tenant.emojicode,
    name:     tenant.name,
    wikiUrl:  `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`
  };

  const keyData = { privateKey: ownerPrivateKey, pubKey: ownerPubKey };

  const packageJson = JSON.stringify({
    name: 'shoppe',
    version: '1.0.0',
    private: true,
    description: 'Shoppe content folder',
    dependencies: {
      'sessionless-node': 'latest'
    }
  }, null, 2);

  const readme = [
    `# ${tenant.name} — Shoppe Starter`,
    '',
    '## First-time setup',
    '',
    '1. Install Node.js if needed: https://nodejs.org',
    '2. Run: `npm install`  (installs sessionless-node — one time only)',
    '3. Run: `node shoppe-sign.js init`',
    '   This moves your private key to ~/.shoppe/keys/ and removes it from this folder.',
    '',
    '## Adding content',
    '',
    'Add your goods to the appropriate folders:',
    '',
    '  books/          → .epub / .pdf / .mobi  (+ cover.jpg + info.json)',
    '  music/          → album subfolders or standalone .mp3 files',
    '  posts/          → numbered subfolders with post.md',
    '  albums/         → photo album subfolders',
    '  products/       → physical products with info.json',
    '  videos/         → numbered subfolders with .mp4/.mov/.mkv + cover.jpg + info.json',
    '  appointments/   → bookable services with info.json',
    '  subscriptions/  → membership tiers with info.json',
    '',
    'Each content folder can have an optional info.json:',
    '  { "title": "…", "description": "…", "price": 0, "keywords": ["tag1","tag2"] }',
    '',
    '## Uploading',
    '',
    'Run: `node shoppe-sign.js`',
    '',
    'This signs your manifest and creates a ready-to-upload zip next to this folder.',
    'Drag that zip onto your wiki\'s shoppe plugin.',
    '',
    '## Re-uploading',
    '',
    'Add or update content, then run `node shoppe-sign.js` again.',
    'Each upload overwrites existing items and adds new ones.',
    '',
    '## Uploading videos',
    '',
    'Run: `node shoppe-sign.js upload`',
    '',
    'Opens your shoppe page with a signed URL (valid for 24 hours).',
    'Any video items without a file will show an "Upload Video" button.',
    '',
    '## Viewing orders',
    '',
    'Run: `node shoppe-sign.js orders`',
    '',
    'Opens a signed link to your order dashboard (valid for 5 minutes).',
    '',
    '## Setting up payouts (Stripe)',
    '',
    'Run: `node shoppe-sign.js payouts`',
    '',
    'Opens Stripe Connect onboarding so you can receive payments.',
    'Do this once before your first sale.',
  ].join('\n');

  const zip = new AdmZip();
  zip.addFile('manifest.json',  Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('shoppe-key.json', Buffer.from(JSON.stringify(keyData, null, 2)));
  zip.addFile('shoppe-sign.js', SIGN_SCRIPT);
  zip.addFile('package.json',   Buffer.from(packageJson));
  zip.addFile('README.md',      Buffer.from(readme));

  for (const dir of ['books', 'music', 'posts', 'albums', 'products', 'appointments', 'subscriptions']) {
    zip.addFile(`${dir}/.gitkeep`, Buffer.from(''));
  }

  return zip.toBuffer();
}

function renderMarkdown(md) {
  // Process code blocks first to avoid mangling their contents
  const codeBlocks = [];
  let out = md.replace(/```[\s\S]*?```/g, m => {
    const lang = m.match(/^```(\w*)/)?.[1] || '';
    const code = m.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
    codeBlocks.push(`<pre><code class="lang-${lang}">${escHtml(code)}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  out = out
    .replace(/^#{4} (.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3} (.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2} (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---+$/gm, '<hr>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:1em 0">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Paragraphs: split on blank lines, wrap non-block-level content
  const blockRe = /^<(h[1-6]|hr|pre|ul|ol|li|blockquote)/;
  out = out.split(/\n{2,}/).map(chunk => {
    chunk = chunk.trim();
    if (!chunk || blockRe.test(chunk) || chunk.startsWith('\x00CODE')) return chunk;
    return '<p>' + chunk.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');

  // Restore code blocks
  codeBlocks.forEach((block, i) => { out = out.replace(`\x00CODE${i}\x00`, block); });
  return out;
}

// ============================================================
// TENANT MANAGEMENT
// ============================================================

function loadTenants() {
  if (!fs.existsSync(TENANTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8'));
  } catch (err) {
    console.warn('[shoppe] Failed to load tenants:', err.message);
    return {};
  }
}

function saveTenants(tenants) {
  fs.writeFileSync(TENANTS_FILE, JSON.stringify(tenants, null, 2));
}

function generateEmojicode(tenants) {
  const base = [...SHOPPE_BASE_EMOJI].slice(0, 3).join('');
  const existing = new Set(Object.values(tenants).map(t => t.emojicode));
  for (let i = 0; i < 100; i++) {
    const shuffled = [...EMOJI_PALETTE].sort(() => Math.random() - 0.5);
    const code = base + shuffled.slice(0, 5).join('');
    if (!existing.has(code)) return code;
  }
  throw new Error('Failed to generate unique emojicode after 100 attempts');
}

async function addieCreateUser() {
  const addieKeys = await sessionless.generateKeys(() => {}, () => null);
  sessionless.getKeys = () => addieKeys;
  const timestamp = Date.now().toString();
  const message = timestamp + addieKeys.pubKey;
  const signature = await sessionless.sign(message);

  const resp = await fetch(`${getAddieUrl()}/user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: addieKeys.pubKey, signature })
  });

  const addieUser = await resp.json();
  if (addieUser.error) throw new Error(`Addie: ${addieUser.error}`);

  return { uuid: addieUser.uuid, pubKey: addieKeys.pubKey, privateKey: addieKeys.privateKey };
}

async function registerTenant(name) {
  const tenants = loadTenants();

  // Create a dedicated Sanora user for this tenant
  const keys = await sessionless.generateKeys(() => {}, () => null);
  sessionless.getKeys = () => keys;
  const timestamp = Date.now().toString();
  const message = timestamp + keys.pubKey;
  const signature = await sessionless.sign(message);

  const resp = await fetch(`${getSanoraUrl()}/user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: keys.pubKey, signature })
  });

  const sanoraUser = await resp.json();
  if (sanoraUser.error) throw new Error(`Sanora: ${sanoraUser.error}`);

  const emojicode = generateEmojicode(tenants);

  // Create a dedicated Addie user for payee splits
  let addieKeys = null;
  try {
    addieKeys = await addieCreateUser();
  } catch (err) {
    console.warn('[shoppe] Could not create addie user (payouts unavailable):', err.message);
  }

  // Create a dedicated Lucille user for video uploads
  let lucilleKeys = null;
  try {
    lucilleKeys = await lucilleCreateUser();
  } catch (err) {
    console.warn('[shoppe] Could not create lucille user (video uploads unavailable):', err.message);
  }

  const ownerKeys = await generateOwnerKeyPair();

  const tenant = {
    uuid: sanoraUser.uuid,
    emojicode,
    name: name || 'Unnamed Shoppe',
    keys,
    sanoraUser,
    addieKeys,
    lucilleKeys,
    ownerPubKey: ownerKeys.pubKey,
    createdAt: Date.now()
  };

  tenants[sanoraUser.uuid] = tenant;
  saveTenants(tenants);

  console.log(`[shoppe] Registered tenant: "${name}" ${emojicode} (${sanoraUser.uuid})`);
  // ownerPrivateKey is returned once so the caller can include it in the starter bundle.
  // It is NOT persisted server-side.
  return {
    uuid:            sanoraUser.uuid,
    emojicode,
    name:            tenant.name,
    ownerPrivateKey: ownerKeys.privateKey,
    ownerPubKey:     ownerKeys.pubKey
  };
}

function getTenantByIdentifier(identifier) {
  const tenants = loadTenants();
  if (tenants[identifier]) return tenants[identifier];
  return Object.values(tenants).find(t => t.emojicode === identifier) || null;
}

// ============================================================
// SANORA API HELPERS
// ============================================================

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.epub': 'application/epub+zip',
    '.pdf':  'application/pdf',
    '.mobi': 'application/x-mobipocket-ebook',
    '.mp3':  'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a':  'audio/mp4',
    '.ogg':  'audio/ogg',
    '.wav':  'audio/wav',
    '.md':   'text/markdown',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml'
  })[ext] || 'application/octet-stream';
}

async function sanoraCreateProduct(tenant, title, category, description, price, shipping, tags) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  const safePrice = price || 0;
  const message = timestamp + uuid + title + (description || '') + safePrice;

  sessionless.getKeys = () => keys;
  const signature = await sessionless.sign(message);

  const resp = await fetch(
    `${getSanoraUrl()}/user/${uuid}/product/${encodeURIComponent(title)}`,
    {
      method: 'PUT',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp,
        pubKey: keys.pubKey,
        signature,
        description: description || '',
        price: safePrice,
        shipping: shipping || 0,
        category,
        tags: tags || category
      })
    }
  );

  const product = await resp.json();
  if (product.error) throw new Error(`Create product failed: ${product.error}`);
  return product;
}

async function sanoraUploadArtifact(tenant, title, fileBuffer, filename, artifactType) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  sessionless.getKeys = () => keys;
  const message = timestamp + uuid + title;
  const signature = await sessionless.sign(message);

  const form = new FormData();
  form.append('artifact', fileBuffer, { filename, contentType: getMimeType(filename) });

  const resp = await fetch(
    `${getSanoraUrl()}/user/${uuid}/product/${encodeURIComponent(title)}/artifact`,
    {
      method: 'PUT',
      timeout: 30000,
      headers: {
        'x-pn-artifact-type': artifactType,
        'x-pn-timestamp': timestamp,
        'x-pn-signature': signature,
        ...form.getHeaders()
      },
      body: form
    }
  );

  const result = await resp.json();
  if (result.error) throw new Error(`Artifact upload failed: ${result.error}`);
  return result;
}

async function sanoraUploadImage(tenant, title, imageBuffer, filename) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  sessionless.getKeys = () => keys;
  const message = timestamp + uuid + title;
  const signature = await sessionless.sign(message);

  const form = new FormData();
  form.append('image', imageBuffer, { filename, contentType: getMimeType(filename) });

  const resp = await fetch(
    `${getSanoraUrl()}/user/${uuid}/product/${encodeURIComponent(title)}/image`,
    {
      method: 'PUT',
      timeout: 30000,
      headers: {
        'x-pn-timestamp': timestamp,
        'x-pn-signature': signature,
        ...form.getHeaders()
      },
      body: form
    }
  );

  const result = await resp.json();
  if (result.error) throw new Error(`Image upload failed: ${result.error}`);
  return result;
}

// ============================================================
// LUCILLE HELPERS
async function sanoraDeleteProduct(tenant, title) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  const message = timestamp + uuid + title;

  sessionless.getKeys = () => keys;
  const signature = await sessionless.sign(message);

  await fetch(
    `${getSanoraUrl()}/user/${uuid}/product/${encodeURIComponent(title)}?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`,
    { method: 'DELETE' }
  );
}

// ============================================================

async function lucilleCreateUser(lucilleUrl) {
  const url = lucilleUrl || getLucilleUrl();
  const keys = await sessionless.generateKeys(() => {}, () => null);
  sessionless.getKeys = () => keys;
  const timestamp = Date.now().toString();
  const message = timestamp + keys.pubKey;
  const signature = await sessionless.sign(message);

  const resp = await fetch(`${url}/user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: keys.pubKey, signature })
  });

  const lucilleUser = await resp.json();
  if (lucilleUser.error) throw new Error(`Lucille: ${lucilleUser.error}`);
  return { uuid: lucilleUser.uuid, pubKey: keys.pubKey, privateKey: keys.privateKey };
}

async function lucilleGetVideos(lucilleUuid, lucilleUrl) {
  const url = lucilleUrl || getLucilleUrl();
  try {
    const resp = await fetch(`${url}/videos/${lucilleUuid}`);
    if (!resp.ok) return {};
    return await resp.json();
  } catch (err) {
    return {};
  }
}

async function lucilleRegisterVideo(tenant, title, description, tags, lucilleUrl) {
  const url = lucilleUrl || getLucilleUrl();
  const { lucilleKeys } = tenant;
  if (!lucilleKeys) throw new Error('Tenant has no Lucille user — re-register to enable video uploads');
  const timestamp = Date.now().toString();
  sessionless.getKeys = () => lucilleKeys;
  const signature = await sessionless.sign(timestamp + lucilleKeys.pubKey);

  const resp = await fetch(
    `${url}/user/${lucilleKeys.uuid}/video/${encodeURIComponent(title)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp, signature, description: description || '', tags: tags || [] })
    }
  );

  const result = await resp.json();
  if (result.error) throw new Error(`Lucille register video failed: ${result.error}`);
  return result;
}

async function lucilleUploadVideo(tenant, title, fileBuffer, filename, lucilleUrl) {
  const url = lucilleUrl || getLucilleUrl();
  const { lucilleKeys } = tenant;
  if (!lucilleKeys) throw new Error('Tenant has no Lucille user');
  const timestamp = Date.now().toString();
  sessionless.getKeys = () => lucilleKeys;
  const signature = await sessionless.sign(timestamp + lucilleKeys.pubKey);

  const form = new FormData();
  form.append('video', fileBuffer, { filename, contentType: getMimeType(filename) });

  const resp = await fetch(
    `${url}/user/${lucilleKeys.uuid}/video/${encodeURIComponent(title)}/file`,
    {
      method: 'PUT',
      headers: {
        'x-pn-timestamp': timestamp,
        'x-pn-signature': signature,
        ...form.getHeaders()
      },
      body: form
    }
  );

  const result = await resp.json();
  if (result.error) throw new Error(`Lucille video upload failed: ${result.error}`);
  return result;
}

// ============================================================
// ARCHIVE PROCESSING
// ============================================================

async function processArchive(zipPath) {
  const tmpDir = path.join(TMP_DIR, `extract-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  // Use system unzip to stream-extract without loading entire archive into RAM.
  // AdmZip loads the whole zip into memory upfront, which OOM-kills Node on large archives.
  try {
    execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to extract archive: ${err.stderr ? err.stderr.toString().trim() : err.message}`);
  }

  try {
    // Find manifest.json — handle zips wrapped in a top-level folder and
    // macOS zips that include a __MACOSX metadata folder alongside the content.
    function findManifest(dir, depth = 0) {
      const direct = path.join(dir, 'manifest.json');
      if (fs.existsSync(direct)) return dir;
      if (depth >= 2) return null;
      const entries = fs.readdirSync(dir).filter(f =>
        f !== '__MACOSX' && fs.statSync(path.join(dir, f)).isDirectory()
      );
      for (const entry of entries) {
        const found = findManifest(path.join(dir, entry), depth + 1);
        if (found) return found;
      }
      return null;
    }

    const root = findManifest(tmpDir);
    if (!root) {
      throw new Error('Archive is missing manifest.json');
    }
    const manifestPath = path.join(root, 'manifest.json');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.uuid || !manifest.emojicode) {
      throw new Error('manifest.json must contain uuid and emojicode');
    }

    const tenant = getTenantByIdentifier(manifest.uuid);
    if (!tenant) throw new Error(`Unknown UUID: ${manifest.uuid}`);
    if (tenant.emojicode !== manifest.emojicode) {
      throw new Error('emojicode does not match registered tenant');
    }

    // Verify owner signature (required for tenants registered after signing support was added).
    validateOwnerSignature(manifest, tenant);

    // Store manifest-level keywords and per-category redirect URLs in the tenant record.
    const tenantUpdates = {};
    if (Array.isArray(manifest.keywords) && manifest.keywords.length > 0) {
      tenantUpdates.keywords = manifest.keywords.join(', ');
    }
    if (manifest.redirects && typeof manifest.redirects === 'object') {
      tenantUpdates.redirects = manifest.redirects;
    }
    if (Object.keys(tenantUpdates).length > 0) {
      const tenants = loadTenants();
      Object.assign(tenants[tenant.uuid], tenantUpdates);
      saveTenants(tenants);
      Object.assign(tenant, tenantUpdates);
    }

    const results = { books: [], music: [], posts: [], albums: [], products: [], videos: [], appointments: [], subscriptions: [], warnings: [] };

    function readInfo(entryPath) {
      const infoPath = path.join(entryPath, 'info.json');
      if (!fs.existsSync(infoPath)) return {};
      try {
        return JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      } catch (err) {
        const msg = `info.json in "${path.basename(entryPath)}" is invalid JSON: ${err.message}`;
        results.warnings.push(msg);
        console.warn(`[shoppe]   ⚠️  ${msg}`);
        return {};
      }
    }

    // ---- books/ ----
    // Each book is a subfolder containing the book file, cover.jpg, and info.json
    const booksDir = path.join(root, 'books');
    if (fs.existsSync(booksDir)) {
      for (const entry of fs.readdirSync(booksDir)) {
        const entryPath = path.join(booksDir, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        try {
          const info = readInfo(entryPath);
          const title = info.title || entry;
          const description = info.description || '';
          const price = info.price || 0;

          await sanoraCreateProduct(tenant, title, 'book', description, price, 0, buildTags('book', info.keywords));

          // Cover image — use info.cover to pin a specific file, else first image found
          const covers = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
          const coverFile = info.cover ? (covers.find(f => f === info.cover) || covers[0]) : covers[0];
          if (coverFile) {
            const coverBuf = fs.readFileSync(path.join(entryPath, coverFile));
            await sanoraUploadImage(tenant, title, coverBuf, coverFile);
          }

          // Book file
          const bookFiles = fs.readdirSync(entryPath).filter(f => BOOK_EXTS.has(path.extname(f).toLowerCase()));
          if (bookFiles.length > 0) {
            const buf = fs.readFileSync(path.join(entryPath, bookFiles[0]));
            await sanoraUploadArtifact(tenant, title, buf, bookFiles[0], 'ebook');
          }

          results.books.push({ title, price });
          console.log(`[shoppe]   📚 book: ${title}`);
        } catch (err) {
          console.warn(`[shoppe]   ⚠️  book ${entry}: ${err.message}`);
        }
      }
    }

    // ---- music/ ----
    // Albums are subfolders; standalone files are individual tracks
    const musicDir = path.join(root, 'music');
    if (fs.existsSync(musicDir)) {
      for (const entry of fs.readdirSync(musicDir)) {
        const entryPath = path.join(musicDir, entry);
        const stat = fs.statSync(entryPath);

        if (stat.isDirectory()) {
          // Album — supports info.json: { title, description, price, cover }
          const info = readInfo(entryPath);
          const albumTitle = info.title || entry;
          const tracks = fs.readdirSync(entryPath).filter(f => MUSIC_EXTS.has(path.extname(f).toLowerCase()));
          const covers = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
          try {
            const description = info.description || `Album: ${albumTitle}`;
            const price = info.price || 0;
            await sanoraCreateProduct(tenant, albumTitle, 'music', description, price, 0, buildTags('music,album', info.keywords));
            const coverFile = info.cover ? (covers.find(f => f === info.cover) || covers[0]) : covers[0];
            if (coverFile) {
              const coverBuf = fs.readFileSync(path.join(entryPath, coverFile));
              await sanoraUploadImage(tenant, albumTitle, coverBuf, coverFile);
            }
            for (const track of tracks) {
              const buf = fs.readFileSync(path.join(entryPath, track));
              await sanoraUploadArtifact(tenant, albumTitle, buf, track, 'audio');
            }
            results.music.push({ title: albumTitle, type: 'album', tracks: tracks.length });
            console.log(`[shoppe]   🎵 album: ${albumTitle} (${tracks.length} tracks)`);
          } catch (err) {
            console.warn(`[shoppe]   ⚠️  album ${entry}: ${err.message}`);
          }
        } else if (MUSIC_EXTS.has(path.extname(entry).toLowerCase())) {
          // Standalone track — supports a sidecar .json with same basename: { title, description, price }
          const baseName = path.basename(entry, path.extname(entry));
          const sidecarPath = path.join(musicDir, baseName + '.json');
          let trackInfo = {};
          if (fs.existsSync(sidecarPath)) {
            try { trackInfo = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); }
            catch (e) { results.warnings.push(`sidecar JSON for "${entry}" is invalid: ${e.message}`); }
          }
          const title = trackInfo.title || baseName;
          try {
            const buf = fs.readFileSync(entryPath);
            const description = trackInfo.description || `Track: ${title}`;
            const price = trackInfo.price || 0;
            await sanoraCreateProduct(tenant, title, 'music', description, price, 0, buildTags('music,track', trackInfo.keywords));
            await sanoraUploadArtifact(tenant, title, buf, entry, 'audio');
            results.music.push({ title, type: 'track' });
            console.log(`[shoppe]   🎵 track: ${title}`);
          } catch (err) {
            console.warn(`[shoppe]   ⚠️  track ${entry}: ${err.message}`);
          }
        }
      }
    }

    // ---- posts/ ----
    // Each post is a numbered subfolder: "01-My Title/" containing post.md,
    // optional assets (images etc.), and optional info.json for metadata overrides.
    // Folders are sorted by their numeric prefix to build the table of contents.
    const postsDir = path.join(root, 'posts');
    if (fs.existsSync(postsDir)) {
      const postFolders = fs.readdirSync(postsDir)
        .filter(f => fs.statSync(path.join(postsDir, f)).isDirectory())
        .sort(); // lexicographic sort respects numeric prefixes (01-, 02-, …)

      for (let order = 0; order < postFolders.length; order++) {
        const entry = postFolders[order];
        const entryPath = path.join(postsDir, entry);
        const folderTitle = entry.replace(/^\d+-/, '');

        const info = readInfo(entryPath);
        const seriesTitle = info.title || folderTitle;

        // Check if this is a multi-part series (has numbered subdirectories)
        const subDirs = fs.readdirSync(entryPath)
          .filter(f => fs.statSync(path.join(entryPath, f)).isDirectory())
          .sort();
        const mdFiles = fs.readdirSync(entryPath).filter(f => f.endsWith('.md'));
        const isSeries = subDirs.length > 0;

        if (isSeries) {
          // Register the series itself as a parent product
          try {
            const description = info.description || `A ${subDirs.length}-part series`;
            await sanoraCreateProduct(tenant, seriesTitle, 'post-series', description, 0, 0, buildTags(`post,series,order:${order}`, info.keywords));

            const covers = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
            if (covers.length > 0) {
              const coverBuf = fs.readFileSync(path.join(entryPath, covers[0]));
              await sanoraUploadImage(tenant, seriesTitle, coverBuf, covers[0]);
            }

            // Optional series-level intro .md
            if (mdFiles.length > 0) {
              const mdBuf = fs.readFileSync(path.join(entryPath, mdFiles[0]));
              await sanoraUploadArtifact(tenant, seriesTitle, mdBuf, mdFiles[0], 'text');
            }

            console.log(`[shoppe]   📝 series [${order + 1}]: ${seriesTitle} (${subDirs.length} parts)`);
          } catch (err) {
            console.warn(`[shoppe]   ⚠️  series ${entry}: ${err.message}`);
          }

          // Register each part
          for (let partIndex = 0; partIndex < subDirs.length; partIndex++) {
            const partEntry = subDirs[partIndex];
            const partPath = path.join(entryPath, partEntry);
            const partFolderTitle = partEntry.replace(/^\d+-/, '');

            const partInfo = readInfo(partPath);

            try {
              const partMdFiles = fs.readdirSync(partPath).filter(f => f.endsWith('.md'));
              if (partMdFiles.length === 0) {
                console.warn(`[shoppe]   ⚠️  part ${partEntry}: no .md file, skipping`);
                continue;
              }

              const mdBuf = fs.readFileSync(path.join(partPath, partMdFiles[0]));
              const partFm = parseFrontMatter(mdBuf.toString('utf8'));
              const resolvedTitle = partFm.title || partInfo.title || partFolderTitle;
              const productTitle = `${seriesTitle}: ${resolvedTitle}`;
              const description = partInfo.description || partFm.body.split('\n\n')[0].replace(/^#+\s*/, '').trim() || resolvedTitle;

              await sanoraCreateProduct(tenant, productTitle, 'post', description, 0, 0,
                buildTags(`post,blog,series:${seriesTitle},part:${partIndex + 1},order:${order}`, partInfo.keywords));

              await sanoraUploadArtifact(tenant, productTitle, mdBuf, partMdFiles[0], 'text');

              const partCovers = fs.readdirSync(partPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
              const partCoverFile = partFm.preview ? (partCovers.find(f => f === partFm.preview) || partCovers[0]) : partCovers[0];
              if (partCoverFile) {
                const coverBuf = fs.readFileSync(path.join(partPath, partCoverFile));
                await sanoraUploadImage(tenant, productTitle, coverBuf, partCoverFile);
              }

              const partAssets = fs.readdirSync(partPath).filter(f =>
                !f.endsWith('.md') && f !== 'info.json' && f !== partCovers[0] &&
                IMAGE_EXTS.has(path.extname(f).toLowerCase())
              );
              for (const asset of partAssets) {
                const buf = fs.readFileSync(path.join(partPath, asset));
                await sanoraUploadArtifact(tenant, productTitle, buf, asset, 'image');
              }

              console.log(`[shoppe]     part ${partIndex + 1}: ${resolvedTitle}`);
            } catch (err) {
              console.warn(`[shoppe]   ⚠️  part ${partEntry}: ${err.message}`);
            }
          }

          results.posts.push({ title: seriesTitle, order, parts: subDirs.length });

        } else {
          // Single post
          try {
            if (mdFiles.length === 0) {
              console.warn(`[shoppe]   ⚠️  post ${entry}: no .md file found, skipping`);
              continue;
            }
            const mdBuf = fs.readFileSync(path.join(entryPath, mdFiles[0]));
            const fm = parseFrontMatter(mdBuf.toString('utf8'));
            const title = fm.title || info.title || folderTitle;
            const firstLine = fm.body.split('\n').find(l => l.trim()).replace(/^#+\s*/, '');
            const description = info.description || fm.body.split('\n\n')[0].replace(/^#+\s*/, '').trim() || firstLine || title;

            await sanoraCreateProduct(tenant, title, 'post', description, 0, 0, buildTags(`post,blog,order:${order}`, info.keywords));
            await sanoraUploadArtifact(tenant, title, mdBuf, mdFiles[0], 'text');

            const covers = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
            const coverFile = fm.preview ? (covers.find(f => f === fm.preview) || covers[0]) : covers[0];
            if (coverFile) {
              const coverBuf = fs.readFileSync(path.join(entryPath, coverFile));
              await sanoraUploadImage(tenant, title, coverBuf, coverFile);
            }

            const assets = fs.readdirSync(entryPath).filter(f =>
              !f.endsWith('.md') && f !== 'info.json' && f !== covers[0] &&
              IMAGE_EXTS.has(path.extname(f).toLowerCase())
            );
            for (const asset of assets) {
              const buf = fs.readFileSync(path.join(entryPath, asset));
              await sanoraUploadArtifact(tenant, title, buf, asset, 'image');
            }

            results.posts.push({ title, order });
            console.log(`[shoppe]   📝 post [${order + 1}]: ${title}`);
          } catch (err) {
            console.warn(`[shoppe]   ⚠️  post ${entry}: ${err.message}`);
          }
        }
      }
    }

    // ---- albums/ ----
    // Each subfolder is a photo album
    const albumsDir = path.join(root, 'albums');
    if (fs.existsSync(albumsDir)) {
      for (const entry of fs.readdirSync(albumsDir)) {
        const entryPath = path.join(albumsDir, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        const images = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
        try {
          await sanoraCreateProduct(tenant, entry, 'album', `Photo album: ${entry}`, 0, 0, 'album,photos');
          if (images.length > 0) {
            const coverBuf = fs.readFileSync(path.join(entryPath, images[0]));
            await sanoraUploadImage(tenant, entry, coverBuf, images[0]);
          }
          for (const img of images) {
            const buf = fs.readFileSync(path.join(entryPath, img));
            await sanoraUploadArtifact(tenant, entry, buf, img, 'image');
          }
          results.albums.push({ title: entry, images: images.length });
          console.log(`[shoppe]   🖼️  album: ${entry} (${images.length} images)`);
        } catch (err) {
          console.warn(`[shoppe]   ⚠️  album ${entry}: ${err.message}`);
        }
      }
    }

    // ---- products/ ----
    // Each subfolder is a physical product with hero.jpg/hero.png + info.json.
    // Numeric prefix on folder name sets display order (01-T-Shirt, 02-Hat, …).
    const productsDir = path.join(root, 'products');
    if (fs.existsSync(productsDir)) {
      const productFolders = fs.readdirSync(productsDir)
        .filter(f => fs.statSync(path.join(productsDir, f)).isDirectory())
        .sort();

      for (let order = 0; order < productFolders.length; order++) {
        const entry = productFolders[order];
        const entryPath = path.join(productsDir, entry);
        const folderTitle = entry.replace(/^\d+-/, '');
        try {
          const info = readInfo(entryPath);
          const title = info.title || folderTitle;
          const description = info.description || '';
          const price = info.price || 0;
          const shipping = info.shipping || 0;

          await sanoraCreateProduct(tenant, title, 'product', description, price, shipping, buildTags(`product,physical,order:${order}`, info.keywords));

          // Hero image: prefer hero.jpg / hero.png, fall back to first image
          const images = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
          const heroFile = images.find(f => /^hero\.(jpg|jpeg|png|webp)$/i.test(f)) || images[0];
          if (heroFile) {
            const heroBuf = fs.readFileSync(path.join(entryPath, heroFile));
            await sanoraUploadImage(tenant, title, heroBuf, heroFile);
          }

          results.products.push({ title, order, price, shipping });
          console.log(`[shoppe]   📦 product [${order + 1}]: ${title} ($${price} + $${shipping} shipping)`);
        } catch (err) {
          console.warn(`[shoppe]   ⚠️  product ${entry}: ${err.message}`);
        }
      }
    }

    // ---- subscriptions/ ----
    // Each subfolder defines one support tier (Patreon-style).
    // info.json: { title, description, price (cents/month), benefits: [], renewalDays: 30 }
    // cover.jpg / hero.jpg → product image.  All other files → exclusive member artifacts.
    const subscriptionsDir = path.join(root, 'subscriptions');
    if (fs.existsSync(subscriptionsDir)) {
      const subFolders = fs.readdirSync(subscriptionsDir)
        .filter(f => fs.statSync(path.join(subscriptionsDir, f)).isDirectory())
        .sort();

      for (const entry of subFolders) {
        const entryPath = path.join(subscriptionsDir, entry);
        const folderTitle = entry.replace(/^\d+-/, '');
        try {
          const info = readInfo(entryPath);
          const title = info.title || folderTitle;
          const description = info.description || '';
          const price = info.price || 0;
          const tierMeta = {
            benefits:    info.benefits    || [],
            renewalDays: info.renewalDays || 30
          };

          await sanoraCreateProduct(tenant, title, 'subscription', description, price, 0, buildTags('subscription', info.keywords));

          // Upload tier metadata (benefits list, renewal period) as a JSON artifact
          const tierBuf = Buffer.from(JSON.stringify(tierMeta));
          await sanoraUploadArtifact(tenant, title, tierBuf, 'tier-info.json', 'application/json');

          // Cover image (optional)
          const allFiles = fs.readdirSync(entryPath);
          const coverFile = allFiles.find(f => /^(cover|hero)\.(jpg|jpeg|png|webp)$/i.test(f));
          if (coverFile) {
            const buf = fs.readFileSync(path.join(entryPath, coverFile));
            await sanoraUploadImage(tenant, title, buf, coverFile);
          }

          // Every other non-JSON, non-cover file is an exclusive member artifact
          const exclusiveFiles = allFiles.filter(f =>
            f !== 'info.json' && f !== coverFile && !f.endsWith('.json')
          );
          for (const ef of exclusiveFiles) {
            const buf = fs.readFileSync(path.join(entryPath, ef));
            await sanoraUploadArtifact(tenant, title, buf, ef, getMimeType(ef));
          }

          results.subscriptions.push({ title, price, renewalDays: tierMeta.renewalDays });
          console.log(`[shoppe]   🎁 subscription tier: ${title} ($${price}/mo, ${exclusiveFiles.length} exclusive files)`);
        } catch (err) {
          console.warn(`[shoppe]   ⚠️  subscription ${entry}: ${err.message}`);
        }
      }
    }

    // ---- videos/ ----
    // Each subfolder is a video. Contains the video file, optional cover/poster image, and info.json.
    // info.json: { title, description, price, tags[] }
    // Video is uploaded to Lucille (DO Spaces + WebTorrent seeder); Sanora holds the catalog entry.
    //
    // The manifest may specify a lucilleUrl to override the plugin's global config — this lets
    // different shoppe tenants point to different Lucille instances.
    //
    // Deduplication: Lucille stores a SHA-256 contentHash for each uploaded file. Before uploading,
    // shoppe computes the local file's hash and skips the upload if it matches what Lucille has.
    const videosDir = path.join(root, 'videos');
    if (fs.existsSync(videosDir)) {
      const effectiveLucilleUrl = (manifest.lucilleUrl || '').replace(/\/$/, '') || null;

      const videoFolders = fs.readdirSync(videosDir)
        .filter(f => fs.statSync(path.join(videosDir, f)).isDirectory())
        .sort();

      // Fetch existing Lucille videos once for this tenant so we can dedup
      let existingLucilleVideos = {};
      if (tenant.lucilleKeys) {
        existingLucilleVideos = await lucilleGetVideos(tenant.lucilleKeys.uuid, effectiveLucilleUrl);
      }

      for (const entry of videoFolders) {
        const entryPath = path.join(videosDir, entry);
        const folderTitle = entry.replace(/^\d+-/, '');
        try {
          const info = readInfo(entryPath);
          const title = info.title || folderTitle;
          const description = info.description || '';
          const price = info.price || 0;
          const tags = info.tags || [];

          // Compute Lucille videoId deterministically (sha256(lucilleUuid + title))
          // so we can embed it in the Sanora product tags before calling Lucille.
          const lucilleBase = (effectiveLucilleUrl || getLucilleUrl()).replace(/\/$/, '');
          const lucilleVideoId = tenant.lucilleKeys
            ? crypto.createHash('sha256').update(tenant.lucilleKeys.uuid + title).digest('hex')
            : null;
          const videoTags = buildTags('video', info.keywords) +
            (lucilleVideoId ? `,lucille-id:${lucilleVideoId},lucille-url:${lucilleBase}` : '');

          // Sanora catalog entry (for discovery / storefront)
          await sanoraCreateProduct(tenant, title, 'video', description, price, 0, videoTags);

          // Cover / poster image (optional)
          const images = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
          const coverFile = images.find(f => /^(cover|poster|hero|thumbnail)\.(jpg|jpeg|png|webp)$/i.test(f)) || images[0];
          if (coverFile) {
            const coverBuf = fs.readFileSync(path.join(entryPath, coverFile));
            await sanoraUploadImage(tenant, title, coverBuf, coverFile);
          }

          // Register video metadata in Lucille (file upload happens separately via upload-info endpoint)
          await lucilleRegisterVideo(tenant, title, description, tags, effectiveLucilleUrl);
          results.videos.push({ title, price });
          console.log(`[shoppe]   🎬 video registered: ${title} (upload file separately)`);
        } catch (err) {
          console.warn(`[shoppe]   ⚠️  video ${entry}: ${err.message}`);
          results.warnings.push(`video "${entry}": ${err.message}`);
        }
      }
    }

    // ---- appointments/ ----
    // Each subfolder is a bookable appointment type.
    // info.json: { title, description, price, duration (mins), timezone, availability[], advanceDays }
    // availability: [{ day: "monday", start: "09:00", end: "17:00" }, ...]
    const appointmentsDir = path.join(root, 'appointments');
    if (fs.existsSync(appointmentsDir)) {
      const apptFolders = fs.readdirSync(appointmentsDir)
        .filter(f => fs.statSync(path.join(appointmentsDir, f)).isDirectory())
        .sort();

      for (const entry of apptFolders) {
        const entryPath = path.join(appointmentsDir, entry);
        const folderTitle = entry.replace(/^\d+-/, '');
        try {
          const info = readInfo(entryPath);
          const title = info.title || folderTitle;
          const description = info.description || '';
          const price = info.price || 0;
          const schedule = {
            duration:     info.duration     || 60,
            timezone:     info.timezone     || 'America/New_York',
            availability: info.availability || [],
            advanceDays:  info.advanceDays  || 30
          };

          await sanoraCreateProduct(tenant, title, 'appointment', description, price, 0, buildTags('appointment', info.keywords));

          // Upload schedule as a JSON artifact so the booking page can retrieve it
          const scheduleBuf = Buffer.from(JSON.stringify(schedule));
          await sanoraUploadArtifact(tenant, title, scheduleBuf, 'schedule.json', 'application/json');

          // Cover image (optional)
          const images = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
          const coverFile = images.find(f => /^(cover|hero)\.(jpg|jpeg|png|webp)$/i.test(f)) || images[0];
          if (coverFile) {
            const coverBuf = fs.readFileSync(path.join(entryPath, coverFile));
            await sanoraUploadImage(tenant, title, coverBuf, coverFile);
          }

          results.appointments.push({ title, price, duration: schedule.duration });
          console.log(`[shoppe]   📅 appointment: ${title} ($${price}/session, ${schedule.duration}min)`);
        } catch (err) {
          console.warn(`[shoppe]   ⚠️  appointment ${entry}: ${err.message}`);
        }
      }
    }

    return {
      tenant: { uuid: tenant.uuid, emojicode: tenant.emojicode, name: tenant.name },
      results
    };

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
}

// ============================================================
// PORTFOLIO PAGE GENERATION
// ============================================================

async function getShoppeGoods(tenant) {
  let products = {};
  try {
    const resp = await fetch(`${getSanoraUrl()}/products/${tenant.uuid}`, { timeout: 15000 });
    if (resp.ok) products = await resp.json();
    else console.warn(`[shoppe] getShoppeGoods: Sanora returned ${resp.status} for ${tenant.uuid}`);
  } catch (err) {
    console.warn(`[shoppe] getShoppeGoods: Sanora unreachable — ${err.message}`);
  }
  const redirects = tenant.redirects || {};

  const goods = { books: [], music: [], posts: [], albums: [], products: [], videos: [], appointments: [], subscriptions: [] };

  const CATEGORY_BUCKET = { book: 'books', music: 'music', post: 'posts', 'post-series': 'posts', album: 'albums', product: 'products', video: 'videos', appointment: 'appointments', subscription: 'subscriptions' };

  for (const [title, product] of Object.entries(products)) {
    const isPost = product.category === 'post' || product.category === 'post-series';
    const bucketName = CATEGORY_BUCKET[product.category];

    // Extract lucille-id and lucille-url from tags for video products
    let lucillePlayerUrl = null;
    if (product.category === 'video' && product.tags) {
      const tagParts = product.tags.split(',');
      const idTag  = tagParts.find(t => t.startsWith('lucille-id:'));
      const urlTag = tagParts.find(t => t.startsWith('lucille-url:'));
      if (idTag && urlTag) {
        const videoId   = idTag.slice('lucille-id:'.length);
        const lucilleBase = urlTag.slice('lucille-url:'.length);
        lucillePlayerUrl = `${lucilleBase}/watch/${videoId}`;
      }
    }

    const defaultUrl = isPost
      ? `/plugin/shoppe/${tenant.uuid}/post/${encodeURIComponent(title)}`
      : product.category === 'book'
        ? `/plugin/shoppe/${tenant.uuid}/buy/${encodeURIComponent(title)}`
        : product.category === 'subscription'
          ? `/plugin/shoppe/${tenant.uuid}/subscribe/${encodeURIComponent(title)}`
          : product.category === 'appointment'
            ? `/plugin/shoppe/${tenant.uuid}/book/${encodeURIComponent(title)}`
          : product.category === 'product' && product.shipping > 0
            ? `/plugin/shoppe/${tenant.uuid}/buy/${encodeURIComponent(title)}/address`
            : product.category === 'product'
              ? `/plugin/shoppe/${tenant.uuid}/buy/${encodeURIComponent(title)}`
              : product.category === 'video' && lucillePlayerUrl
                ? lucillePlayerUrl
                : `${getSanoraUrl()}/products/${tenant.uuid}/${encodeURIComponent(title)}`;

    const item = {
      title: product.title || title,
      description: product.description || '',
      price: product.price || 0,
      shipping: product.shipping || 0,
      image: product.image ? `${getSanoraUrl()}/images/${product.image}` : null,
      url: (bucketName && redirects[bucketName]) || defaultUrl,
      ...(lucillePlayerUrl && { lucillePlayerUrl }),
      ...(product.category === 'video' && { shoppeId: tenant.uuid })
    };
    const bucket = goods[bucketName];
    if (bucket) bucket.push(item);
  }

  return goods;
}

// ============================================================
// APPOINTMENT UTILITIES
// ============================================================

// Fetch and parse the schedule JSON artifact for an appointment product.
async function getAppointmentSchedule(tenant, product) {
  const sanoraUrl = getSanoraUrl();
  const scheduleArtifact = (product.artifacts || []).find(a => a.endsWith('.json'));
  if (!scheduleArtifact) return null;
  const resp = await fetch(`${sanoraUrl}/artifacts/${scheduleArtifact}`);
  if (!resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
}

// Fetch booked slot strings for an appointment product from Sanora orders.
async function getBookedSlots(tenant, productId) {
  const sanoraUrl = getSanoraUrl();
  const tenantKeys = tenant.keys;
  sessionless.getKeys = () => tenantKeys;
  const timestamp = Date.now().toString();
  const signature = await sessionless.sign(timestamp + tenant.uuid);
  const resp = await fetch(
    `${sanoraUrl}/user/${tenant.uuid}/orders/${encodeURIComponent(productId)}?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`
  );
  if (!resp.ok) return [];
  try {
    const data = await resp.json();
    return (data.orders || []).map(o => o.slot).filter(Boolean);
  } catch { return []; }
}

// Generate available slot strings grouped by date.
// Slot strings are "YYYY-MM-DDTHH:MM" in the appointment's local timezone.
// Returns: [{ date: "YYYY-MM-DD", dayLabel: "Monday", slots: ["YYYY-MM-DDTHH:MM", ...] }]
function generateAvailableSlots(schedule, bookedSlots) {
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const timezone    = schedule.timezone    || 'UTC';
  const advanceDays = schedule.advanceDays || 30;
  const duration    = schedule.duration    || 60;
  const bookedSet   = new Set(bookedSlots);

  const dateFmt    = new Intl.DateTimeFormat('en-CA',  { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt    = new Intl.DateTimeFormat('en-GB',  { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const weekdayFmt = new Intl.DateTimeFormat('en-US',  { timeZone: timezone, weekday: 'long' });
  const dayLabelFmt= new Intl.DateTimeFormat('en-US',  { timeZone: timezone, weekday: 'long', month: 'short', day: 'numeric' });

  const nowStr  = timeFmt.format(new Date());
  const nowMins = parseInt(nowStr.split(':')[0]) * 60 + parseInt(nowStr.split(':')[1]);

  const available = [];
  const now = new Date();

  for (let d = 0; d < advanceDays; d++) {
    const date    = new Date(now.getTime() + d * 86400000);
    const dateStr = dateFmt.format(date);
    const dayName = weekdayFmt.format(date).toLowerCase();
    const rule    = (schedule.availability || []).find(a => a.day.toLowerCase() === dayName);
    if (!rule || !rule.slots || !rule.slots.length) continue;

    const slots = [];
    for (const slotTime of rule.slots) {
      const [h, m] = slotTime.split(':').map(Number);
      const slotMins = h * 60 + m;
      // For today, skip slots within the next hour
      if (d === 0 && slotMins <= nowMins + 60) continue;
      const slotStr = `${dateStr}T${slotTime}`;
      if (!bookedSet.has(slotStr)) slots.push(slotStr);
    }

    if (slots.length > 0) {
      available.push({ date: dateStr, dayLabel: dayLabelFmt.format(date), slots });
    }
  }
  return available;
}

// ============================================================
// SUBSCRIPTION UTILITIES
// ============================================================

// Fetch tier metadata (benefits list, renewalDays) from the tier-info artifact.
async function getTierInfo(tenant, product) {
  const sanoraUrl = getSanoraUrl();
  const tierArtifact = (product.artifacts || []).find(a => a.endsWith('.json'));
  if (!tierArtifact) return null;
  const resp = await fetch(`${sanoraUrl}/artifacts/${tierArtifact}`);
  if (!resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
}

// Check whether a subscriber (identified by recoveryKey) has an active subscription
// for a given subscription product.  Uses Sanora orders only — no session-based hash.
// The recovery key itself is never stored; the order records sha256(recoveryKey+productId).
async function getSubscriptionStatus(tenant, productId, recoveryKey) {
  const orderKey  = crypto.createHash('sha256').update(recoveryKey + productId).digest('hex');
  const sanoraUrl = getSanoraUrl();
  const tenantKeys = tenant.keys;
  sessionless.getKeys = () => tenantKeys;
  const timestamp = Date.now().toString();
  const signature = await sessionless.sign(timestamp + tenant.uuid);
  try {
    const resp = await fetch(
      `${sanoraUrl}/user/${tenant.uuid}/orders/${encodeURIComponent(productId)}?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`
    );
    if (!resp.ok) return { active: false };
    const data = await resp.json();
    const myOrders = (data.orders || []).filter(o => o.orderKey === orderKey);
    if (!myOrders.length) return { active: false };
    const latest  = myOrders.reduce((a, b) => (b.paidAt > a.paidAt ? b : a));
    const period  = (latest.renewalDays || 30) * 24 * 60 * 60 * 1000;
    const renewsAt = latest.paidAt + period;
    const now      = Date.now();
    const active   = renewsAt > now;
    const daysLeft = Math.max(0, Math.floor((renewsAt - now) / (24 * 60 * 60 * 1000)));
    return { active, paidAt: latest.paidAt, renewsAt, daysLeft };
  } catch { return { active: false }; }
}

const CATEGORY_EMOJI = { book: '📚', music: '🎵', post: '📝', album: '🖼️', product: '📦', appointment: '📅', subscription: '🎁', video: '🎬' };

// ============================================================
// OWNER ORDERS
// ============================================================

// Validate an owner-signed request (used for browser-facing owner routes).
// Expects req.query.timestamp and req.query.signature.
// Returns an error string if invalid, null if valid.
function checkOwnerSignature(req, tenant, maxAgeMs = 5 * 60 * 1000) {
  if (!tenant.ownerPubKey) return 'This shoppe was registered before owner signing was added';
  const { timestamp, signature } = req.query;
  if (!timestamp || !signature) return 'Missing timestamp or signature — generate a fresh URL with: node shoppe-sign.js orders';
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age < 0 || age > maxAgeMs) return 'URL has expired — generate a new one with: node shoppe-sign.js orders';
  const message = timestamp + tenant.uuid;
  if (!sessionless.verifySignature(signature, message, tenant.ownerPubKey)) return 'Signature invalid';
  return null;
}

// Fetch all orders for every product belonging to a tenant.
// Returns an array of { product, orders } objects.
async function getAllOrders(tenant) {
  const sanoraUrl  = getSanoraUrl();
  let products = {};
  try {
    const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`, { timeout: 15000 });
    if (productsResp.ok) products = await productsResp.json();
  } catch (err) {
    console.warn(`[shoppe] getAllOrders: Sanora unreachable — ${err.message}`);
  }

  sessionless.getKeys = () => tenant.keys;

  const results = [];
  for (const [title, product] of Object.entries(products)) {
    const timestamp = Date.now().toString();
    const signature = await sessionless.sign(timestamp + tenant.uuid);
    try {
      const resp = await fetch(
        `${sanoraUrl}/user/${tenant.uuid}/orders/${encodeURIComponent(product.productId)}` +
        `?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      const orders = data.orders || [];
      if (orders.length > 0) results.push({ product, orders });
    } catch { /* skip products with no order data */ }
  }
  return results;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function generateOrdersHTML(tenant, orderData) {
  const totalOrders  = orderData.reduce((n, p) => n + p.orders.length, 0);
  const totalRevenue = orderData.reduce((n, p) =>
    n + p.orders.reduce((m, o) => m + (o.amount || p.product.price || 0), 0), 0);

  const sections = orderData.map(({ product, orders }) => {
    const emoji = CATEGORY_EMOJI[product.category] || '🛍️';
    const rows = orders.map(o => {
      const date   = fmtDate(o.paidAt || o.createdAt || Date.now());
      const amount = o.amount != null ? `$${(o.amount / 100).toFixed(2)}` : `$${((product.price || 0) / 100).toFixed(2)}`;
      const detail = o.slot
        ? `<span class="tag">📅 ${o.slot}</span>`
        : o.renewalDays
          ? `<span class="tag">🔄 ${o.renewalDays}d renewal</span>`
          : '';
      const keyHint = o.orderKey
        ? `<span class="hash" title="sha256(recoveryKey+productId)">${o.orderKey.slice(0, 12)}…</span>`
        : '—';
      return `<tr><td>${date}</td><td>${amount}</td><td>${keyHint}</td><td>${detail}</td></tr>`;
    }).join('');

    return `
    <div class="product-section">
      <div class="product-header">
        <span class="product-emoji">${emoji}</span>
        <span class="product-title">${escHtml(product.title || 'Untitled')}</span>
        <span class="order-count">${orders.length} order${orders.length !== 1 ? 's' : ''}</span>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Key hash</th><th>Details</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const empty = totalOrders === 0
    ? '<p class="empty">No orders yet. Share your shoppe link to get started!</p>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Orders — ${escHtml(tenant.name)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f12; color: #e0e0e0; min-height: 100vh; }
    header { background: linear-gradient(135deg, #1a1a2e, #0f3460); padding: 36px 32px 28px; }
    header h1 { font-size: 26px; font-weight: 700; margin-bottom: 4px; }
    header p  { font-size: 14px; color: #aaa; }
    .stats { display: flex; gap: 20px; padding: 24px 32px; border-bottom: 1px solid #222; }
    .stat { background: #18181c; border: 1px solid #333; border-radius: 12px; padding: 16px 24px; }
    .stat-val { font-size: 28px; font-weight: 800; color: #7ec8e3; }
    .stat-lbl { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .main { max-width: 900px; margin: 0 auto; padding: 28px 24px 60px; }
    .product-section { margin-bottom: 32px; }
    .product-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .product-emoji { font-size: 20px; }
    .product-title { font-size: 17px; font-weight: 600; flex: 1; }
    .order-count { font-size: 12px; color: #888; background: #222; border-radius: 10px; padding: 3px 10px; }
    table { width: 100%; border-collapse: collapse; background: #18181c; border: 1px solid #2a2a2e; border-radius: 12px; overflow: hidden; }
    thead { background: #222; }
    th { padding: 10px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; text-align: left; }
    td { padding: 11px 14px; font-size: 13px; border-top: 1px solid #222; }
    .hash { font-family: monospace; font-size: 12px; color: #7ec8e3; }
    .tag  { background: #2a2a2e; border-radius: 6px; padding: 2px 8px; font-size: 12px; color: #ccc; }
    .empty { color: #555; font-size: 15px; text-align: center; padding: 60px 0; }
    .back { display: inline-block; margin-bottom: 20px; color: #7ec8e3; text-decoration: none; font-size: 13px; }
    .back:hover { text-decoration: underline; }
    .warning { background: #2a1f0a; border: 1px solid #665; border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #cc9; margin-bottom: 24px; }
  </style>
</head>
<body>
  <header>
    <h1>${escHtml(tenant.emojicode)} ${escHtml(tenant.name)}</h1>
    <p>Order history — this URL is valid for 5 minutes</p>
  </header>
  <div class="stats">
    <div class="stat"><div class="stat-val">${totalOrders}</div><div class="stat-lbl">Total orders</div></div>
    <div class="stat"><div class="stat-val">$${(totalRevenue / 100).toFixed(2)}</div><div class="stat-lbl">Total revenue</div></div>
    <div class="stat"><div class="stat-val">${orderData.length}</div><div class="stat-lbl">Products sold</div></div>
  </div>
  <div class="main">
    <a class="back" href="/plugin/shoppe/${tenant.uuid}">← Back to shoppe</a>
    <div class="warning">🔑 Key hashes are shown (not recovery keys — those never reach this server). Revenue totals are approximate when order amounts aren't stored.</div>
    ${empty}
    ${sections}
  </div>
</body>
</html>`;
}

function renderCards(items, category) {
  if (items.length === 0) {
    return '<p class="empty">Nothing here yet.</p>';
  }
  return items.map(item => {
    const isVideo = !!item.lucillePlayerUrl;
    const isUnuploadedVideo = item.shoppeId && !item.lucillePlayerUrl;
    const imgHtml = item.image
      ? `<div class="card-img${isVideo ? ' card-video-play' : ''}"><img src="${item.image}" alt="" loading="lazy"></div>`
      : isUnuploadedVideo
        ? `<div class="card-img-placeholder card-video-upload"><span style="font-size:44px">🎬</span></div>`
        : `<div class="card-img-placeholder">${CATEGORY_EMOJI[category] || '🎁'}</div>`;
    const priceHtml = (item.price > 0 || category === 'product')
      ? `<div class="price">$${(item.price / 100).toFixed(2)}${item.shipping ? ` <span class="shipping">+ $${(item.shipping / 100).toFixed(2)} shipping</span>` : ''}</div>`
      : '';
    if (isUnuploadedVideo) {
      const safeTitle = item.title.replace(/'/g, "\\'");
      return `
      <div class="card" id="video-card-${item.shoppeId}-${item.title.replace(/[^a-z0-9]/gi,'_')}">
        ${imgHtml}
        <div class="card-body">
          <div class="card-title">${item.title}</div>
          ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}
          ${priceHtml}
          <div class="video-upload-area" id="upload-area-${item.shoppeId}-${item.title.replace(/[^a-z0-9]/gi,'_')}">
            <label class="upload-btn-label">
              📁 Upload Video
              <input type="file" accept="video/*" style="display:none"
                onchange="startVideoUpload(this,'${item.shoppeId}','${safeTitle}')">
            </label>
            <div class="upload-progress" style="display:none"></div>
          </div>
        </div>
      </div>`;
    }
    const clickHandler = isVideo
      ? `playVideo('${item.lucillePlayerUrl}')`
      : `window.open('${item.url}','_blank')`;
    return `
      <div class="card" onclick="${clickHandler}">
        ${imgHtml}
        <div class="card-body">
          <div class="card-title">${item.title}</div>
          ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}
          ${priceHtml}
        </div>
      </div>`;
  }).join('');
}

function generateShoppeHTML(tenant, goods, uploadAuth = null) {
  const total = Object.values(goods).flat().length;
  const tabs = [
    { id: 'all',          label: 'All',              count: total,                       always: true },
    { id: 'books',        label: '📚 Books',          count: goods.books.length },
    { id: 'music',        label: '🎵 Music',          count: goods.music.length },
    { id: 'posts',        label: '📝 Posts',          count: goods.posts.length },
    { id: 'albums',       label: '🖼️ Albums',         count: goods.albums.length },
    { id: 'products',     label: '📦 Products',       count: goods.products.length },
    { id: 'videos',        label: '🎬 Videos',         count: goods.videos.length },
    { id: 'appointments',  label: '📅 Appointments',  count: goods.appointments.length },
    { id: 'subscriptions', label: '🎁 Infuse',          count: goods.subscriptions.length }
  ]
    .filter(t => t.always || t.count > 0)
    .map((t, i) => `<div class="tab${i === 0 ? ' active' : ''}" onclick="show('${t.id}',this)">${t.label} <span class="badge">${t.count}</span></div>`)
    .join('');

  const allItems = [...goods.books, ...goods.music, ...goods.posts, ...goods.albums, ...goods.products, ...goods.videos, ...goods.appointments, ...goods.subscriptions];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tenant.name}</title>
  ${tenant.keywords ? `<meta name="keywords" content="${escHtml(tenant.keywords)}">` : ''}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; }
    header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; padding: 48px 24px 40px; text-align: center; }
    .emojicode { font-size: 30px; letter-spacing: 6px; margin-bottom: 14px; }
    header h1 { font-size: 38px; font-weight: 700; margin-bottom: 6px; }
    .count { opacity: 0.65; font-size: 15px; }
    nav { display: flex; overflow-x: auto; background: white; border-bottom: 1px solid #ddd; padding: 0 20px; gap: 0; }
    .tab { padding: 14px 18px; cursor: pointer; font-size: 14px; font-weight: 500; white-space: nowrap; border-bottom: 2px solid transparent; color: #555; transition: color 0.15s, border-color 0.15s; }
    .tab:hover { color: #0066cc; }
    .tab.active { color: #0066cc; border-bottom-color: #0066cc; }
    .badge { background: #e8f0fe; color: #0066cc; border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 5px; }
    main { max-width: 1200px; margin: 0 auto; padding: 36px 24px; }
    .section { display: none; }
    .section.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 20px; }
    .card { background: white; border-radius: 14px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.07); cursor: pointer; transition: transform 0.18s, box-shadow 0.18s; }
    .card:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .card-img img { width: 100%; height: 190px; object-fit: cover; display: block; }
    .card-img-placeholder { height: 110px; display: flex; align-items: center; justify-content: center; font-size: 44px; background: #f0f0f7; }
    .card-body { padding: 16px; }
    .card-title { font-size: 15px; font-weight: 600; margin-bottom: 5px; line-height: 1.3; }
    .card-desc { font-size: 13px; color: #666; margin-bottom: 8px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .price { font-size: 15px; font-weight: 700; color: #0066cc; }
    .shipping { font-size: 12px; font-weight: 400; color: #888; }
    .empty { color: #999; text-align: center; padding: 60px 0; font-size: 15px; }
    .card-video-play { position: relative; }
    .card-video-play::after { content: '▶'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 36px; color: rgba(255,255,255,0.9); background: rgba(0,0,0,0.35); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    .card:hover .card-video-play::after { opacity: 1; }
    .video-modal { display: none; position: fixed; inset: 0; z-index: 1000; align-items: center; justify-content: center; }
    .video-modal.open { display: flex; }
    .video-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.85); }
    .video-modal-content { position: relative; z-index: 1; width: 90vw; max-width: 960px; aspect-ratio: 16/9; background: #000; border-radius: 10px; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,0.6); }
    .video-modal-content iframe { width: 100%; height: 100%; border: none; display: block; }
    .video-modal-close { position: absolute; top: 10px; right: 12px; z-index: 2; background: rgba(0,0,0,0.5); border: none; color: #fff; font-size: 20px; line-height: 1; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
    .video-modal-close:hover { background: rgba(0,0,0,0.8); }
    .card-video-upload { cursor: default !important; }
    .upload-btn-label { display: inline-block; background: #0066cc; color: white; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .upload-btn-label:hover { background: #0052a3; }
    .upload-progress { margin-top: 8px; font-size: 12px; color: #555; }
    .upload-progress-bar { height: 4px; background: #e0e0e0; border-radius: 2px; margin-top: 4px; overflow: hidden; }
    .upload-progress-bar-fill { height: 100%; background: #0066cc; border-radius: 2px; transition: width 0.2s; }
  </style>
</head>
<body>
  <header>
    <div class="emojicode">${tenant.emojicode}</div>
    <h1>${tenant.name}</h1>
    <div class="count">${total} item${total !== 1 ? 's' : ''}</div>
  </header>
  <nav>${tabs}</nav>
  <main>
    <div id="all" class="section active"><div class="grid">${renderCards(allItems, 'all')}</div></div>
    <div id="books" class="section"><div class="grid">${renderCards(goods.books, 'book')}</div></div>
    <div id="music" class="section"><div class="grid">${renderCards(goods.music, 'music')}</div></div>
    <div id="posts" class="section"><div class="grid">${renderCards(goods.posts, 'post')}</div></div>
    <div id="albums" class="section"><div class="grid">${renderCards(goods.albums, 'album')}</div></div>
    <div id="products" class="section"><div class="grid">${renderCards(goods.products, 'product')}</div></div>
    <div id="videos" class="section"><div class="grid">${renderCards(goods.videos, 'video')}</div></div>
    <div id="appointments" class="section"><div class="grid">${renderCards(goods.appointments, 'appointment')}</div></div>
    <div id="subscriptions" class="section"><div class="grid">${renderCards(goods.subscriptions, 'subscription')}</div></div>
    <div style="text-align:center;padding:24px 0 8px;font-size:14px;color:#888;">
      Already infusing? <a href="/plugin/shoppe/${tenant.uuid}/membership" style="color:#0066cc;">Access your membership →</a>
    </div>
  </main>
  <div id="video-modal" class="video-modal">
    <div class="video-modal-backdrop" onclick="closeVideo()"></div>
    <div class="video-modal-content">
      <button class="video-modal-close" onclick="closeVideo()">✕</button>
      <iframe id="video-iframe" src="" allowfullscreen allow="autoplay"></iframe>
    </div>
  </div>
  <script>
    const UPLOAD_AUTH = ${uploadAuth ? JSON.stringify(uploadAuth) : 'null'};
    function show(id, tab) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      tab.classList.add('active');
    }
    function playVideo(url) {
      document.getElementById('video-iframe').src = url;
      document.getElementById('video-modal').classList.add('open');
    }
    function closeVideo() {
      document.getElementById('video-modal').classList.remove('open');
      document.getElementById('video-iframe').src = '';
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVideo(); });

    async function startVideoUpload(input, shoppeId, title) {
      const file = input.files[0];
      if (!file) return;

      const areaId = 'upload-area-' + shoppeId + '-' + title.replace(/[^a-z0-9]/gi,'_');
      const area = document.getElementById(areaId);
      const progressDiv = area.querySelector('.upload-progress');
      const label = area.querySelector('.upload-btn-label');

      label.style.display = 'none';
      progressDiv.style.display = 'block';
      progressDiv.innerHTML = 'Getting upload credentials…';

      try {
        if (!UPLOAD_AUTH) throw new Error('Not authorized to upload — visit the shoppe via a signed URL (node shoppe-sign.js upload)');
        const authParams = '?timestamp=' + encodeURIComponent(UPLOAD_AUTH.timestamp) + '&signature=' + encodeURIComponent(UPLOAD_AUTH.signature);
        const infoRes = await fetch('/plugin/shoppe/' + shoppeId + '/video/' + encodeURIComponent(title) + '/upload-info' + authParams);
        if (!infoRes.ok) throw new Error('Could not get upload credentials (' + infoRes.status + ')');
        const { uploadUrl, timestamp, signature } = await infoRes.json();

        progressDiv.innerHTML = 'Uploading… 0%<div class="upload-progress-bar"><div class="upload-progress-bar-fill" id="fill-' + areaId + '" style="width:0%"></div></div>';

        const form = new FormData();
        form.append('video', file, file.name);

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
              const pct = Math.round(e.loaded / e.total * 100);
              progressDiv.querySelector('div').textContent = '';
              progressDiv.firstChild.textContent = 'Uploading… ' + pct + '%';
              const fill = document.getElementById('fill-' + areaId);
              if (fill) fill.style.width = pct + '%';
            }
          };
          xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error('Upload failed: ' + xhr.status));
          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.open('PUT', uploadUrl);
          xhr.setRequestHeader('x-pn-timestamp', timestamp);
          xhr.setRequestHeader('x-pn-signature', signature);
          xhr.send(form);
        });

        progressDiv.innerHTML = '✅ Uploaded! Reloading…';
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        progressDiv.innerHTML = '❌ ' + err.message;
        label.style.display = 'inline-block';
      }
    }
  </script>
</body>
</html>`;
}

function generatePostHTML(tenant, title, date, imageUrl, markdownBody) {
  const content = renderMarkdown(markdownBody);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)} — ${escHtml(tenant.name)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; }
    .back-bar { background: #1a1a2e; padding: 12px 24px; }
    .back-bar a { color: rgba(255,255,255,0.75); text-decoration: none; font-size: 14px; }
    .back-bar a:hover { color: white; }
    .hero { width: 100%; max-height: 420px; object-fit: cover; display: block; }
    .post-header { max-width: 740px; margin: 48px auto 0; padding: 0 24px; }
    .post-header h1 { font-size: 38px; font-weight: 800; line-height: 1.15; letter-spacing: -0.5px; }
    .post-date { margin-top: 10px; font-size: 14px; color: #888; }
    article { max-width: 740px; margin: 36px auto 80px; padding: 0 24px; line-height: 1.75; font-size: 17px; color: #2d2d2f; }
    article h1,article h2,article h3,article h4 { margin: 2em 0 0.5em; line-height: 1.2; color: #1d1d1f; }
    article h1 { font-size: 28px; } article h2 { font-size: 24px; } article h3 { font-size: 20px; }
    article p { margin-bottom: 1.4em; }
    article a { color: #0066cc; }
    article code { background: #e8e8ed; border-radius: 4px; padding: 2px 6px; font-size: 14px; }
    article pre { background: #1d1d1f; color: #a8f0a8; border-radius: 10px; padding: 20px; overflow-x: auto; margin: 1.5em 0; }
    article pre code { background: none; padding: 0; font-size: 14px; color: inherit; }
    article img { max-width: 100%; border-radius: 8px; margin: 1em 0; }
    article hr { border: none; border-top: 1px solid #ddd; margin: 2.5em 0; }
    article strong { color: #1d1d1f; }
  </style>
</head>
<body>
  <div class="back-bar"><a href="/plugin/shoppe/${tenant.uuid}">← ${escHtml(tenant.name)}</a></div>
  ${imageUrl ? `<img class="hero" src="${imageUrl}" alt="">` : ''}
  <div class="post-header">
    <h1>${escHtml(title)}</h1>
    ${date ? `<div class="post-date">${escHtml(date)}</div>` : ''}
  </div>
  <article>${content}</article>
</body>
</html>`;
}

// ============================================================
// EXPRESS ROUTES
// ============================================================

async function startServer(params) {
  const app = params.app;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TMP_DIR))  fs.mkdirSync(TMP_DIR,  { recursive: true });
  console.log('🛍️  wiki-plugin-shoppe starting...');

  const owner = (req, res, next) => {
    if (!app.securityhandler.isAuthorized(req)) {
      return res.status(401).json({ error: 'must be owner' });
    }
    return next();
  };

  const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
  });

  // Register a new tenant (owner only)
  app.post('/plugin/shoppe/register', owner, async (req, res) => {
    try {
      const { uuid, emojicode, name, ownerPrivateKey, ownerPubKey } = await registerTenant(req.body.name);

      // Generate a single-use, short-lived token for the starter bundle download.
      const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
      const token = crypto.randomBytes(24).toString('hex');
      bundleTokens.set(token, { uuid, ownerPrivateKey, ownerPubKey, wikiOrigin, expiresAt: Date.now() + 15 * 60 * 1000 });

      // Expire tokens automatically after 15 minutes.
      setTimeout(() => bundleTokens.delete(token), 15 * 60 * 1000);

      res.json({ success: true, tenant: { uuid, emojicode, name }, bundleToken: token });
    } catch (err) {
      console.error('[shoppe] register error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Starter bundle download — single-use token acts as the credential.
  // The zip contains manifest.json, shoppe-key.json (private key), shoppe-sign.js, and empty content folders.
  app.get('/plugin/shoppe/bundle/:token', (req, res) => {
    const entry = bundleTokens.get(req.params.token);
    if (!entry) {
      return res.status(404).send('<h1>Bundle link expired or invalid</h1><p>Re-register to get a new link.</p>');
    }
    if (Date.now() > entry.expiresAt) {
      bundleTokens.delete(req.params.token);
      return res.status(410).send('<h1>Bundle link expired</h1><p>Re-register to get a new link.</p>');
    }

    // Invalidate immediately — single use
    bundleTokens.delete(req.params.token);

    const tenant = getTenantByIdentifier(entry.uuid);
    if (!tenant) return res.status(404).send('<h1>Tenant not found</h1>');

    try {
      const buf = generateBundleBuffer(tenant, entry.ownerPrivateKey, entry.ownerPubKey, entry.wikiOrigin);
      const filename = `${tenant.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-shoppe-starter.zip`;
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
      console.log(`[shoppe] Starter bundle downloaded for "${tenant.name}" (${tenant.uuid})`);
    } catch (err) {
      console.error('[shoppe] bundle error:', err);
      res.status(500).send('<h1>Error generating bundle</h1><p>' + err.message + '</p>');
    }
  });

  // List all tenants (owner only — includes uuid for management)
  app.get('/plugin/shoppe/tenants', owner, (req, res) => {
    const tenants = loadTenants();
    const safe = Object.values(tenants).map(({ uuid, emojicode, name, createdAt }) => ({
      uuid, emojicode, name, createdAt,
      url: `/plugin/shoppe/${uuid}`
    }));
    res.json({ success: true, tenants: safe });
  });

  // Delete a shoppe tenant (owner only)
  app.delete('/plugin/shoppe/:identifier', owner, async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'tenant not found' });

      // Fetch all products from Sanora and fire-and-forget delete each one
      const sanoraUrl = getSanoraUrl();
      fetch(`${sanoraUrl}/products/${tenant.uuid}`)
        .then(r => r.json())
        .then(products => {
          for (const title of Object.keys(products)) {
            sanoraDeleteProduct(tenant, title).catch(err =>
              console.warn(`[shoppe] delete product "${title}" failed:`, err.message)
            );
          }
        })
        .catch(err => console.warn('[shoppe] fetch products for delete failed:', err.message));

      // Remove tenant from local registry
      const tenants = loadTenants();
      delete tenants[tenant.uuid];
      saveTenants(tenants);

      res.json({ success: true, deleted: tenant.uuid });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Public directory — name, emojicode, and shoppe URL only
  app.get('/plugin/shoppe/directory', (req, res) => {
    const tenants = loadTenants();
    const listing = Object.values(tenants).map(({ uuid, emojicode, name }) => ({
      name, emojicode,
      url: `/plugin/shoppe/${uuid}`
    }));
    res.json({ success: true, shoppes: listing });
  });

  // Upload goods archive (auth via manifest uuid+emojicode)
  app.post('/plugin/shoppe/upload', upload.single('archive'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No archive uploaded' });
      }
      console.log('[shoppe] Processing archive:', req.file.originalname);
      const result = await processArchive(req.file.path);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[shoppe] upload error:', err);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
    }
  });

  // Get config (owner only)
  app.get('/plugin/shoppe/config', owner, (req, res) => {
    const config = loadConfig();
    res.json({ success: true, sanoraUrl: config.sanoraUrl || '', lucilleUrl: config.lucilleUrl || '' });
  });

  // Save config (owner only)
  app.post('/plugin/shoppe/config', owner, (req, res) => {
    const { sanoraUrl, addieUrl, lucilleUrl } = req.body;
    if (!sanoraUrl) return res.status(400).json({ success: false, error: 'sanoraUrl required' });
    const config = loadConfig();
    config.sanoraUrl = sanoraUrl;
    if (addieUrl) config.addieUrl = addieUrl;
    if (lucilleUrl) config.lucilleUrl = lucilleUrl;
    saveConfig(config);
    console.log('[shoppe] Sanora URL set to:', sanoraUrl);
    res.json({ success: true });
  });

  // Purchase pages — shoppe-hosted versions of the Sanora payment templates
  async function renderPurchasePage(req, res, templateHtml) {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const title = decodeURIComponent(req.params.title);
      const sanoraUrlInternal = getSanoraUrl();
      const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
      const sanoraUrl = `${wikiOrigin}/plugin/allyabase/sanora`;
      const productsResp = await fetch(`${sanoraUrlInternal}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).send('<h1>Product not found</h1>');

      const imageUrl = product.image ? `${sanoraUrlInternal}/images/${product.image}` : '';
      const ebookUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}/download/${encodeURIComponent(title)}`;
      const shoppeUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`;
      const payees = tenant.addieKeys
        ? JSON.stringify([{ pubKey: tenant.addieKeys.pubKey, amount: product.price || 0 }])
        : '[]';

      const html = fillTemplate(templateHtml, {
        title:           product.title || title,
        description:     product.description || '',
        image:           `"${imageUrl}"`,
        amount:          String(product.price || 0),
        formattedAmount: ((product.price || 0) / 100).toFixed(2),
        productId:       product.productId || '',
        pubKey:          '',
        signature:       '',
        sanoraUrl,
        allyabaseOrigin: wikiOrigin,
        ebookUrl,
        shoppeUrl,
        payees,
        tenantUuid:      tenant.uuid,
        keywords:        extractKeywords(product)
      });

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('[shoppe] purchase page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  }

  // Books + no-shipping products → recovery key + stripe
  app.get('/plugin/shoppe/:identifier/buy/:title', (req, res) =>
    renderPurchasePage(req, res, RECOVER_STRIPE_TMPL));

  // Physical products with shipping → address + stripe
  app.get('/plugin/shoppe/:identifier/buy/:title/address', (req, res) =>
    renderPurchasePage(req, res, ADDRESS_STRIPE_TMPL));

  // Appointment booking page
  app.get('/plugin/shoppe/:identifier/book/:title', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const title = decodeURIComponent(req.params.title);
      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).send('<h1>Appointment not found</h1>');

      const schedule = await getAppointmentSchedule(tenant, product);
      const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
      const shoppeUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`;
      const imageUrl = product.image ? `${sanoraUrl}/images/${product.image}` : '';

      const price = product.price || 0;
      const html = fillTemplate(APPOINTMENT_BOOKING_TMPL, {
        title:           product.title || title,
        description:     product.description || '',
        image:           `"${imageUrl}"`,
        amount:          String(price),
        formattedAmount: (price / 100).toFixed(2),
        productId:       product.productId || '',
        timezone:        schedule ? schedule.timezone : 'UTC',
        duration:        String(schedule ? schedule.duration : 60),
        proceedLabel:    price === 0 ? 'Confirm Booking →' : 'Continue to Payment →',
        shoppeUrl,
        tenantUuid:      tenant.uuid,
        keywords:        extractKeywords(product)
      });

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('[shoppe] appointment booking page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // Available slots JSON for an appointment
  app.get('/plugin/shoppe/:identifier/book/:title/slots', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const title = decodeURIComponent(req.params.title);
      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).json({ error: 'Appointment not found' });

      const schedule = await getAppointmentSchedule(tenant, product);
      if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

      const bookedSlots = await getBookedSlots(tenant, product.productId);
      const available = generateAvailableSlots(schedule, bookedSlots);

      res.json({ available, timezone: schedule.timezone, duration: schedule.duration });
    } catch (err) {
      console.error('[shoppe] slots error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Subscription sign-up / renew page
  app.get('/plugin/shoppe/:identifier/subscribe/:title', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const title = decodeURIComponent(req.params.title);
      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).send('<h1>Tier not found</h1>');

      const tierInfo = await getTierInfo(tenant, product);
      const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
      const shoppeUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`;
      const imageUrl = product.image ? `${sanoraUrl}/images/${product.image}` : '';
      const benefits = tierInfo && tierInfo.benefits
        ? tierInfo.benefits.map(b => `<li>${escHtml(b)}</li>`).join('')
        : '';

      const html = fillTemplate(SUBSCRIPTION_SUBSCRIBE_TMPL, {
        title:           product.title || title,
        description:     product.description || '',
        image:           `"${imageUrl}"`,
        amount:          String(product.price || 0),
        formattedAmount: ((product.price || 0) / 100).toFixed(2),
        productId:       product.productId || '',
        benefits,
        renewalDays:     String(tierInfo ? (tierInfo.renewalDays || 30) : 30),
        shoppeUrl,
        tenantUuid:      tenant.uuid,
        keywords:        extractKeywords(product)
      });

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('[shoppe] subscribe page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // Owner orders page — authenticated via signed URL from shoppe-sign.js
  app.get('/plugin/shoppe/:uuid/orders', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.uuid);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const err = checkOwnerSignature(req, tenant);
      if (err) {
        return res.status(403).send(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f12;color:#e0e0e0">` +
          `<h2>Access denied</h2><p style="color:#f66;margin-top:12px">${escHtml(err)}</p></body></html>`
        );
      }

      const orderData = await getAllOrders(tenant);
      res.set('Content-Type', 'text/html');
      res.send(generateOrdersHTML(tenant, orderData));
    } catch (err) {
      console.error('[shoppe] orders page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // Owner payouts setup — validates owner sig, redirects to Stripe Connect Express onboarding
  app.get('/plugin/shoppe/:uuid/payouts', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.uuid);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const err = checkOwnerSignature(req, tenant);
      if (err) {
        return res.status(403).send(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f12;color:#e0e0e0">` +
          `<h2>Access denied</h2><p style="color:#f66;margin-top:12px">${escHtml(err)}</p></body></html>`
        );
      }

      if (!tenant.addieKeys) {
        return res.status(500).send(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f12;color:#e0e0e0">` +
          `<h2>Payment account not configured</h2><p>This shoppe has no Addie user. Re-register to get one.</p></body></html>`
        );
      }

      const addieKeys = { pubKey: tenant.addieKeys.pubKey, privateKey: tenant.addieKeys.privateKey };
      sessionless.getKeys = () => addieKeys;
      const timestamp = Date.now().toString();
      const message   = timestamp + tenant.addieKeys.uuid;
      const signature = await sessionless.sign(message);

      const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
      const returnUrl  = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}/payouts/return`;

      const resp = await fetch(`${getAddieUrl()}/user/${tenant.addieKeys.uuid}/processor/stripe/express`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp, pubKey: tenant.addieKeys.pubKey, signature, returnUrl })
      });
      const json = await resp.json();

      if (json.error) {
        return res.status(500).send(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f12;color:#e0e0e0">` +
          `<h2>Error setting up payouts</h2><p style="color:#f66;margin-top:12px">${escHtml(json.error)}</p></body></html>`
        );
      }

      res.redirect(json.onboardingUrl);
    } catch (err) {
      console.error('[shoppe] payouts error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // Stripe Connect Express return page — no auth, Stripe redirects here after onboarding
  app.get('/plugin/shoppe/:uuid/payouts/return', (req, res) => {
    const tenant = getTenantByIdentifier(req.params.uuid);
    const name     = tenant ? escHtml(tenant.name) : 'your shoppe';
    const shoppeUrl = tenant ? `/plugin/shoppe/${tenant.uuid}` : '/';
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payouts connected — ${name}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f12; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #18181c; border: 1px solid #333; border-radius: 16px; padding: 48px 40px; max-width: 480px; text-align: center; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 12px; }
    p  { color: #aaa; font-size: 15px; line-height: 1.6; margin-top: 10px; }
    a  { display: inline-block; margin-top: 28px; color: #7ec8e3; text-decoration: none; font-size: 14px; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:52px;margin-bottom:20px">✅</div>
    <h1>Payouts connected!</h1>
    <p>Your Stripe account is now linked to <strong>${name}</strong>.</p>
    <p>Payments will be transferred to your account automatically after each sale.</p>
    <a href="${escHtml(shoppeUrl)}">← Back to shoppe</a>
  </div>
</body>
</html>`);
  });

  // Membership portal page
  app.get('/plugin/shoppe/:identifier/membership', (req, res) => {
    const tenant = getTenantByIdentifier(req.params.identifier);
    if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');
    const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
    const shoppeUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`;
    const html = fillTemplate(SUBSCRIPTION_MEMBERSHIP_TMPL, { shoppeUrl, tenantUuid: tenant.uuid });
    res.set('Content-Type', 'text/html');
    res.send(html);
  });

  // Check subscription status for all tiers — used by the membership portal
  app.post('/plugin/shoppe/:identifier/membership/check', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { recoveryKey } = req.body;
      if (!recoveryKey) return res.status(400).json({ error: 'recoveryKey required' });

      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const wikiOrigin = `${reqProto(req)}://${req.get('host')}`;
      const shoppeUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`;

      const subscriptions = [];
      for (const [title, product] of Object.entries(products)) {
        if (product.category !== 'subscription') continue;

        const [status, tierInfo] = await Promise.all([
          getSubscriptionStatus(tenant, product.productId, recoveryKey),
          getTierInfo(tenant, product)
        ]);

        // Only expose exclusive artifact URLs to active subscribers
        const exclusiveArtifacts = status.active
          ? (product.artifacts || [])
              .filter(a => !a.endsWith('.json'))
              .map(a => ({ name: a.split('-').slice(1).join('-'), url: `${sanoraUrl}/artifacts/${a}` }))
          : [];

        subscriptions.push({
          title:              product.title || title,
          productId:          product.productId,
          description:        product.description || '',
          price:              product.price || 0,
          image:              product.image ? `${sanoraUrl}/images/${product.image}` : null,
          benefits:           tierInfo ? (tierInfo.benefits || []) : [],
          renewalDays:        tierInfo ? (tierInfo.renewalDays || 30) : 30,
          active:             status.active,
          daysLeft:           status.daysLeft  || 0,
          renewsAt:           status.renewsAt  || null,
          exclusiveArtifacts,
          subscribeUrl:       `${shoppeUrl}/subscribe/${encodeURIComponent(product.title || title)}`
        });
      }

      res.json({ subscriptions });
    } catch (err) {
      console.error('[shoppe] membership check error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Purchase intent — creates buyer Addie user, returns Stripe client secret.
  // Digital products (recoveryKey): checks if already purchased first.
  // Physical products (no recoveryKey): generates an orderRef the client carries to purchase/complete.
  app.post('/plugin/shoppe/:identifier/purchase/intent', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { recoveryKey, productId, title, slotDatetime, payees: clientPayees } = req.body;
      if (!productId) return res.status(400).json({ error: 'productId required' });
      if (!recoveryKey && !title) return res.status(400).json({ error: 'recoveryKey or title required' });

      const sanoraUrlInternal = getSanoraUrl();

      // Get product price
      const productsResp = await fetch(`${sanoraUrlInternal}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = (title && products[title]) || Object.values(products).find(p => p.productId === productId);
      const amount = product?.price || 0;

      let buyer;
      let orderRef;

      if (recoveryKey && product?.category === 'subscription') {
        // Subscription flow — check if already actively subscribed
        const status = await getSubscriptionStatus(tenant, productId, recoveryKey);
        if (status.active) {
          return res.json({ alreadySubscribed: true, renewsAt: status.renewsAt, daysLeft: status.daysLeft });
        }
        buyer = await getOrCreateBuyerAddieUser(recoveryKey, productId);
      } else if (recoveryKey && slotDatetime) {
        // Appointment flow — verify slot is still open before charging
        const schedule = await getAppointmentSchedule(tenant, product);
        if (schedule) {
          const bookedSlots = await getBookedSlots(tenant, productId);
          if (bookedSlots.includes(slotDatetime)) {
            return res.status(409).json({ error: 'That time slot is no longer available.' });
          }
        }
        buyer = await getOrCreateBuyerAddieUser(recoveryKey, productId);
      } else if (recoveryKey) {
        // Digital product flow — check if already purchased
        const recoveryHash = recoveryKey + productId;
        const checkResp = await fetch(`${sanoraUrlInternal}/user/check-hash/${encodeURIComponent(recoveryHash)}/product/${encodeURIComponent(productId)}`);
        const checkJson = await checkResp.json();
        if (checkJson.success) return res.json({ purchased: true });
        buyer = await getOrCreateBuyerAddieUser(recoveryKey, productId);
      } else {
        // Physical product flow — generate an orderRef to link intent → complete
        orderRef = crypto.randomBytes(16).toString('hex');
        buyer = await getOrCreateBuyerAddieUser(orderRef, productId);
      }

      // Free items (price = 0) skip Stripe entirely
      if (amount === 0) {
        return res.json({ free: true });
      }

      // Sign and create Stripe intent via Addie
      // Client may supply payees parsed from ?payees= URL param (pipe-separated 4-tuples).
      // Each payee is capped at 5% of the product price; any that exceed this are dropped.
      const maxPayeeAmount = amount * 0.05;
      const validatedPayees = Array.isArray(clientPayees)
        ? clientPayees.filter(p => {
            if (p.percent != null && p.percent > 5) return false;
            if (p.amount  != null && p.amount  > maxPayeeAmount) return false;
            return true;
          })
        : [];
      const payees = validatedPayees.length > 0
        ? validatedPayees
        : tenant.addieKeys ? [{ pubKey: tenant.addieKeys.pubKey, amount }] : [];
      const buyerKeys = { pubKey: buyer.pubKey, privateKey: buyer.privateKey };
      sessionless.getKeys = () => buyerKeys;
      const intentTimestamp = Date.now().toString();
      const intentSignature = await sessionless.sign(intentTimestamp + buyer.uuid + amount + 'USD');
      const intentResp = await fetch(`${getAddieUrl()}/user/${buyer.uuid}/processor/stripe/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: intentTimestamp, amount, currency: 'USD', payees, signature: intentSignature })
      });

      const intentJson = await intentResp.json();
      if (intentJson.error) return res.status(500).json({ error: intentJson.error });

      const response = { purchased: false, clientSecret: intentJson.paymentIntent, publishableKey: intentJson.publishableKey };
      if (orderRef) response.orderRef = orderRef;
      res.json(response);
    } catch (err) {
      console.error('[shoppe] purchase intent error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Purchase complete — called after Stripe payment confirms.
  // Digital: creates a recovery hash in Sanora.
  // Physical: records the order (including shipping address) in Sanora, signed by the tenant.
  //           Address is routed through the shoppe server so it never goes directly
  //           from the browser to Sanora. It is only stored after payment succeeds.
  app.post('/plugin/shoppe/:identifier/purchase/complete', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { recoveryKey, productId, orderRef, address, title, amount, slotDatetime, contactInfo, type, renewalDays, paymentIntentId } = req.body;
      const sanoraUrlInternal = getSanoraUrl();

      // Fire transfer after successful payment — fire-and-forget, does not affect response
      function triggerTransfer() {
        if (!paymentIntentId || !tenant.addieKeys) return;
        fetch(`${getAddieUrl()}/payment/${encodeURIComponent(paymentIntentId)}/process-transfers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).catch(err => console.warn('[shoppe] transfer trigger failed:', err.message));
      }

      if (recoveryKey && type === 'subscription') {
        // Subscription payment — record an order with a hashed subscriber key + payment timestamp.
        // The recovery key itself is never stored; orderKey = sha256(recoveryKey + productId).
        const orderKey = crypto.createHash('sha256').update(recoveryKey + productId).digest('hex');
        const tenantKeys = tenant.keys;
        sessionless.getKeys = () => tenantKeys;
        const ts  = Date.now().toString();
        const sig = await sessionless.sign(ts + tenant.uuid);
        const order = { orderKey, paidAt: Date.now(), title, productId, renewalDays: renewalDays || 30, status: 'active' };
        await fetch(`${sanoraUrlInternal}/user/${tenant.uuid}/orders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: ts, signature: sig, order })
        });
        triggerTransfer();
        return res.json({ success: true });
      }

      if (recoveryKey && slotDatetime) {
        // Appointment — create recovery hash + record booking in Sanora
        const recoveryHash = recoveryKey + productId;
        const createResp = await fetch(`${sanoraUrlInternal}/user/create-hash/${encodeURIComponent(recoveryHash)}/product/${encodeURIComponent(productId)}`);
        await createResp.json();

        // Record the booking in Sanora (contact info flows through the server, never direct from browser)
        const tenantKeys = tenant.keys;
        sessionless.getKeys = () => tenantKeys;
        const bookingTimestamp = Date.now().toString();
        const bookingSignature = await sessionless.sign(bookingTimestamp + tenant.uuid);
        const order = {
          productId,
          title,
          slot: slotDatetime,
          contactInfo: contactInfo || {},
          status: 'booked'
        };
        await fetch(`${sanoraUrlInternal}/user/${tenant.uuid}/orders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: bookingTimestamp, signature: bookingSignature, order })
        });
        triggerTransfer();
        return res.json({ success: true });
      }

      if (recoveryKey) {
        // Digital product — create recovery hash so buyer can re-download
        const recoveryHash = recoveryKey + productId;
        const createResp = await fetch(`${sanoraUrlInternal}/user/create-hash/${encodeURIComponent(recoveryHash)}/product/${encodeURIComponent(productId)}`);
        const createJson = await createResp.json();
        triggerTransfer();
        return res.json({ success: createJson.success });
      }

      if (orderRef && address) {
        // Physical product — record order in Sanora signed by the tenant.
        // The shippingAddress is collected here (post-payment) and sent once, server-side.
        const tenantKeys = tenant.keys;
        sessionless.getKeys = () => tenantKeys;
        const orderTimestamp = Date.now().toString();
        const orderSignature = await sessionless.sign(orderTimestamp + tenant.uuid);
        const order = {
          productId,
          title,
          amount,
          orderRef,
          shippingAddress: {
            recipientName: address.name,
            street:        address.line1,
            street2:       address.line2 || '',
            city:          address.city,
            state:         address.state,
            zip:           address.zip,
            country:       'US'
          },
          status: 'pending'
        };
        await fetch(`${sanoraUrlInternal}/user/${tenant.uuid}/orders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: orderTimestamp, signature: orderSignature, order })
        });
        triggerTransfer();
        return res.json({ success: true });
      }

      res.status(400).json({ error: 'recoveryKey or (orderRef + address) required' });
    } catch (err) {
      console.error('[shoppe] purchase complete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Ebook download page (reached after successful payment + hash creation)
  app.get('/plugin/shoppe/:identifier/download/:title', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const title = decodeURIComponent(req.params.title);
      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).send('<h1>Book not found</h1>');

      const imageUrl = product.image ? `${sanoraUrl}/images/${product.image}` : '';

      // Map artifact UUIDs to download paths by extension
      let epubPath = '', pdfPath = '', mobiPath = '';
      (product.artifacts || []).forEach(artifact => {
        if (artifact.includes('epub')) epubPath = `${sanoraUrl}/artifacts/${artifact}`;
        if (artifact.includes('pdf'))  pdfPath  = `${sanoraUrl}/artifacts/${artifact}`;
        if (artifact.includes('mobi')) mobiPath = `${sanoraUrl}/artifacts/${artifact}`;
      });

      const html = fillTemplate(EBOOK_DOWNLOAD_TMPL, {
        title:       product.title || title,
        description: product.description || '',
        image:       imageUrl,
        productId:   product.productId || '',
        pubKey:      '',
        signature:   '',
        epubPath,
        pdfPath,
        mobiPath
      });

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('[shoppe] download page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // Post reader — fetches markdown from Sanora and renders it as HTML
  app.get('/plugin/shoppe/:identifier/post/:title', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const title = decodeURIComponent(req.params.title);
      const productsResp = await fetch(`${getSanoraUrl()}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title];
      if (!product) return res.status(404).send('<h1>Post not found</h1>');

      // Find the markdown artifact (UUID-named .md file)
      const mdArtifact = (product.artifacts || []).find(a => a.endsWith('.md'));
      let mdContent = '';
      if (mdArtifact) {
        const artResp = await fetch(`${getSanoraUrl()}/artifacts/${mdArtifact}`);
        mdContent = await artResp.text();
      }

      const fm = parseFrontMatter(mdContent);
      const postTitle = fm.title || title;
      const postDate  = fm.date || '';
      const imageUrl  = product.image ? `${getSanoraUrl()}/images/${product.image}` : null;

      res.set('Content-Type', 'text/html');
      res.send(generatePostHTML(tenant, postTitle, postDate, imageUrl, fm.body || mdContent));
    } catch (err) {
      console.error('[shoppe] post page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // GET /plugin/shoppe/:id/video/:title/upload-info
  // Returns a pre-signed lucille upload URL so the browser can PUT the video file directly to lucille.
  // Auth: shoppe tenant owner signature (timestamp + uuid), valid for 24 hours.
  // Generate the signed URL with: node shoppe-sign.js upload
  app.get('/plugin/shoppe/:identifier/video/:title/upload-info', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'tenant not found' });

      const sigErr = checkOwnerSignature(req, tenant, 24 * 60 * 60 * 1000);
      if (sigErr) return res.status(403).json({ error: sigErr });

      if (!tenant.lucilleKeys) return res.status(400).json({ error: 'tenant has no lucille user — re-register' });

      const title = req.params.title;
      const lucilleBase = getLucilleUrl().replace(/\/$/, '');
      const { uuid: lucilleUuid, pubKey, privateKey } = tenant.lucilleKeys;

      const timestamp = Date.now().toString();
      sessionless.getKeys = () => ({ pubKey, privateKey });
      const signature = await sessionless.sign(timestamp + pubKey);

      const uploadUrl = `${lucilleBase}/user/${lucilleUuid}/video/${encodeURIComponent(title)}/file`;
      res.json({ uploadUrl, timestamp, signature });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Goods JSON (public)
  app.get('/plugin/shoppe/:identifier/goods', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });
      const goods = await getShoppeGoods(tenant);
      const cat = req.query.category;
      res.json({ success: true, goods: (cat && goods[cat]) ? goods[cat] : goods });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shoppe HTML page (public)
  app.get('/plugin/shoppe/:identifier', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');
      const goods = await getShoppeGoods(tenant);

      // Check if the request carries a valid owner signature — if so, embed auth
      // params in the page so the upload button can authenticate with upload-info.
      const sigErr = checkOwnerSignature(req, tenant, 24 * 60 * 60 * 1000);
      const uploadAuth = sigErr ? null : { timestamp: req.query.timestamp, signature: req.query.signature };

      res.set('Content-Type', 'text/html');
      res.send(generateShoppeHTML(tenant, goods, uploadAuth));
    } catch (err) {
      console.error('[shoppe] page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  console.log('✅ wiki-plugin-shoppe ready!');
  console.log('   POST /plugin/shoppe/register        — register tenant (owner)');
  console.log('   GET  /plugin/shoppe/tenants         — list tenants (owner)');
  console.log('   POST /plugin/shoppe/upload          — upload goods archive');
  console.log('   GET  /plugin/shoppe/:id             — shoppe page');
  console.log('   GET  /plugin/shoppe/:id/goods       — goods JSON');
}

module.exports = { startServer };
}).call(this);
