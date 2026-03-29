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
const { secp256k1: _secp256k1 } = require('ethereum-cryptography/secp256k1');
const { keccak256: _keccak256 } = require('ethereum-cryptography/keccak.js');
const { utf8ToBytes: _utf8ToBytes } = require('ethereum-cryptography/utils.js');

// Race-safe signing: bypasses the shared sessionless.getKeys singleton.
function signMessage(message, privateKey) {
  const hash = _keccak256(_utf8ToBytes(message));
  return _secp256k1.sign(hash, privateKey).toCompactHex();
}

// Stripe is used directly for Terminal (card-present) payments.
// Set STRIPE_SECRET_KEY in the environment. If absent, Terminal endpoints return 503.
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set — Terminal payments unavailable');
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

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
const ORDERS_FILE     = path.join(DATA_DIR, 'orders.json');
const AFFILIATES_FILE = path.join(DATA_DIR, 'affiliates.json');
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
  const sanora = getSanoraUrl();
  try {
    const url = new URL(sanora);
    // Only derive from origin when sanora is a wiki proxy URL (has a path component).
    // A bare host:port URL (e.g. http://localhost:7243) means Addie is on its own port.
    if (url.pathname && url.pathname !== '/') {
      return url.origin + '/plugin/allyabase/addie';
    }
  } catch { /* fall through */ }
  return `http://localhost:${process.env.ADDIE_PORT || 3005}`;
}

// Returns the public-facing Sanora URL (via wiki proxy) for browser-visible resource URLs.
// Always constructed from the current request so it matches the host the browser is using.
function getSanoraPublicUrl(req) {
  return `${reqProto(req)}://${req.get('host')}/plugin/allyabase/sanora`;
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

function loadAffiliates() {
  if (!fs.existsSync(AFFILIATES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(AFFILIATES_FILE, 'utf8')); } catch { return {}; }
}

function saveAffiliates(affiliates) {
  fs.writeFileSync(AFFILIATES_FILE, JSON.stringify(affiliates, null, 2));
}

// Get or create an Addie user representing an affiliate (Shoppere user who initiates NFC charges).
// Keyed by the affiliate's Shoppere pubKey. The affiliate's Addie account receives their cut of
// split payments. Stripe Connect onboarding is a separate step handled outside this function.
async function getOrCreateAffiliateAddieUser(shopperePublicKey) {
  const affiliates = loadAffiliates();
  if (affiliates[shopperePublicKey]) return affiliates[shopperePublicKey];

  const addieKeys = await sessionless.generateKeys(() => {}, () => null);
  const timestamp = Date.now().toString();
  const signature = signMessage(timestamp + addieKeys.pubKey, addieKeys.privateKey);

  const resp = await fetch(`${getAddieUrl()}/user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: addieKeys.pubKey, signature })
  });

  const addieUser = await resp.json();
  if (addieUser.error) throw new Error(`Addie affiliate create: ${addieUser.error}`);

  const entry = {
    uuid: addieUser.uuid,
    pubKey: addieKeys.pubKey,
    privateKey: addieKeys.privateKey,
    shoppereKey: shopperePublicKey
  };
  affiliates[shopperePublicKey] = entry;
  saveAffiliates(affiliates);
  return entry;
}


async function getOrCreateBuyerAddieUser(recoveryKey, productId) {
  const buyerKey = recoveryKey + productId;
  const buyers = loadBuyers();
  if (buyers[buyerKey]) return buyers[buyerKey];

  const addieKeys = await sessionless.generateKeys(() => {}, () => null);
  const timestamp = Date.now().toString();
  const message = timestamp + addieKeys.pubKey;
  const signature = signMessage(message, addieKeys.privateKey);

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

// ── Shoppere app: pubKey-based buyer auth ────────────────────────────────────

// Verify a buyer-signed request from the Shoppere app.
// Message convention: timestamp + pubKey  (mirrors Sessionless ecosystem standard)
// Returns an error string on failure, null on success.
function verifyBuyerSignature(pubKey, timestamp, signature, maxAgeMs = 5 * 60 * 1000) {
  if (!pubKey || !timestamp || !signature) return 'pubKey, timestamp, and signature required';
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age < 0 || age > maxAgeMs) return 'Request expired';
  if (!sessionless.verifySignature(signature, timestamp + pubKey, pubKey)) return 'Invalid signature';
  return null;
}

// Like getOrCreateBuyerAddieUser but keyed by pubKey rather than a recoveryKey.
// Prefixed 'pk:' in buyers.json to avoid collisions with legacy recovery-key entries.
async function getOrCreateBuyerAddieUserByPubKey(pubKey, productId) {
  const buyerKey = 'pk:' + pubKey + productId;
  const buyers = loadBuyers();
  if (buyers[buyerKey]) return buyers[buyerKey];

  const addieKeys = await sessionless.generateKeys(() => {}, () => null);
  const timestamp = Date.now().toString();
  const message = timestamp + addieKeys.pubKey;
  const signature = signMessage(message, addieKeys.privateKey);

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

// Check whether a pubKey has a completed purchase for a productId by looking
// for an order whose orderKey === sha256(pubKey + productId) in Sanora.
async function hasPurchasedByPubKey(tenant, pubKey, productId) {
  const orderKey = crypto.createHash('sha256').update(pubKey + productId).digest('hex');
  const sanoraUrl = getSanoraUrl();
  const timestamp = Date.now().toString();
  const signature = signMessage(timestamp + tenant.uuid, tenant.keys.privateKey);
  try {
    const resp = await fetch(
      `${sanoraUrl}/user/${tenant.uuid}/orders/${encodeURIComponent(productId)}` +
      `?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`
    );
    const json = await resp.json();
    return (json.orders || []).some(o => o.orderKey === orderKey);
  } catch {
    return false;
  }
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
  const timestamp = Date.now().toString();
  const message = timestamp + addieKeys.pubKey;
  const signature = signMessage(message, addieKeys.privateKey);

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
  const timestamp = Date.now().toString();
  const message = timestamp + keys.pubKey;
  const signature = signMessage(message, keys.privateKey);

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
  const entry = tenants[identifier];
  if (entry) {
    // String value = alias left behind after a UUID change (Redis reset); follow it.
    if (typeof entry === 'string') return tenants[entry] || null;
    return entry;
  }
  return Object.values(tenants).find(t => typeof t === 'object' && t.emojicode === identifier) || null;
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

// Ensure the tenant's Sanora user exists (Redis may have been wiped).
// If the user is found by pubKey but has a different UUID (new registration),
// updates tenants.json so all subsequent product calls use the correct UUID.
async function sanoraEnsureUser(tenant) {
  const { keys } = tenant;
  const timestamp = Date.now().toString();
  const message = timestamp + keys.pubKey;
  const signature = signMessage(message, keys.privateKey);

  const resp = await fetch(`${getSanoraUrl()}/user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: keys.pubKey, signature }),
    timeout: 15000
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Sanora user ensure failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const sanoraUser = await resp.json();
  if (sanoraUser.error) throw new Error(`Sanora user ensure: ${sanoraUser.error}`);

  if (sanoraUser.uuid !== tenant.uuid) {
    console.log(`[shoppe] Sanora UUID changed ${tenant.uuid} → ${sanoraUser.uuid} (Redis was reset). Updating tenants.json.`);
    const tenants = loadTenants();
    const oldUuid = tenant.uuid;
    tenant.uuid = sanoraUser.uuid;
    tenants[sanoraUser.uuid] = tenant;
    // Keep old UUID as a forwarding alias so existing manifest.json / shared URLs still resolve.
    tenants[oldUuid] = sanoraUser.uuid;
    saveTenants(tenants);
  }

  return tenant; // tenant.uuid is now correct
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// fetch() wrapper that retries on 429 with exponential backoff (1s, 2s, 4s).
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status !== 429 || attempt === maxRetries) return resp;
    const delay = 1000 * Math.pow(2, attempt);
    console.warn(`[shoppe] 429 rate limited on ${new URL(url).pathname}, retrying in ${delay}ms…`);
    await sleep(delay);
  }
}

async function sanoraCreateProduct(tenant, title, category, description, price, shipping, tags) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  const safePrice = price || 0;
  const message = timestamp + uuid + title + (description || '') + safePrice;

  const signature = signMessage(message, keys.privateKey);

  const resp = await fetchWithRetry(
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

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Create product failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const product = await resp.json();
  if (product.error) throw new Error(`Create product failed: ${product.error}`);
  return product;
}

// Wrapper used by processArchive. On "not found" (Sanora Redis cleared mid-upload),
// re-registers the tenant and retries once. tenant.uuid may be updated in place.
async function sanoraCreateProductResilient(tenant, title, category, description, price, shipping, tags) {
  try {
    return await sanoraCreateProduct(tenant, title, category, description, price, shipping, tags);
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('404')) {
      console.warn(`[shoppe] Sanora user lost mid-upload, re-registering and retrying: ${title}`);
      const updated = await sanoraEnsureUser(tenant);
      // Mutate tenant in place so all subsequent calls use the new UUID
      tenant.uuid = updated.uuid;
      return await sanoraCreateProduct(tenant, title, category, description, price, shipping, tags);
    }
    throw err;
  }
}

async function sanoraUploadArtifact(tenant, title, fileBuffer, filename, artifactType) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  const message = timestamp + uuid + title;
  const signature = signMessage(message, keys.privateKey);

  const form = new FormData();
  form.append('artifact', fileBuffer, { filename, contentType: getMimeType(filename) });

  const resp = await fetchWithRetry(
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

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Artifact upload failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const result = await resp.json();
  if (result.error) throw new Error(`Artifact upload failed: ${result.error}`);
  return result;
}

async function sanoraUploadImage(tenant, title, imageBuffer, filename) {
  const { uuid, keys } = tenant;
  const timestamp = Date.now().toString();
  const message = timestamp + uuid + title;
  const signature = signMessage(message, keys.privateKey);

  const form = new FormData();
  form.append('image', imageBuffer, { filename, contentType: getMimeType(filename) });

  const resp = await fetchWithRetry(
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

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Image upload failed (${resp.status}): ${text.slice(0, 200)}`);
  }
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

  const signature = signMessage(message, keys.privateKey);

  await fetch(
    `${getSanoraUrl()}/user/${uuid}/product/${encodeURIComponent(title)}?timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`,
    { method: 'DELETE' }
  );
}

// ============================================================

async function lucilleCreateUser(lucilleUrl) {
  const url = lucilleUrl || getLucilleUrl();
  const keys = await sessionless.generateKeys(() => {}, () => null);
  const timestamp = Date.now().toString();
  const message = timestamp + keys.pubKey;
  const signature = signMessage(message, keys.privateKey);

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
  const signature = signMessage(timestamp + lucilleKeys.pubKey, lucilleKeys.privateKey);

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
  const signature = signMessage(timestamp + lucilleKeys.pubKey, lucilleKeys.privateKey);

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

// ── Upload job store ─────────────────────────────────────────────────────────
// Each job buffers SSE events so the client can replay them if it connects late.
const uploadJobs = new Map(); // jobId → { sse: res|null, queue: [], done: false }

function countItems(root) {
  let count = 0;

  const booksDir = path.join(root, 'books');
  if (fs.existsSync(booksDir))
    count += fs.readdirSync(booksDir).filter(f => fs.statSync(path.join(booksDir, f)).isDirectory()).length;

  const musicDir = path.join(root, 'music');
  if (fs.existsSync(musicDir)) {
    for (const entry of fs.readdirSync(musicDir)) {
      const stat = fs.statSync(path.join(musicDir, entry));
      if (stat.isDirectory()) count++;
      else if (MUSIC_EXTS.has(path.extname(entry).toLowerCase())) count++;
    }
  }

  const postsDir = path.join(root, 'posts');
  if (fs.existsSync(postsDir)) {
    for (const entry of fs.readdirSync(postsDir)) {
      const entryPath = path.join(postsDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      const subDirs = fs.readdirSync(entryPath).filter(f => fs.statSync(path.join(entryPath, f)).isDirectory());
      count += subDirs.length > 0 ? 1 + subDirs.length : 1;
    }
  }

  for (const dirName of ['albums', 'products', 'subscriptions', 'videos', 'appointments']) {
    const dir = path.join(root, dirName);
    if (fs.existsSync(dir))
      count += fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory()).length;
  }

  return count;
}

async function processArchive(zipPath, onProgress = () => {}) {
  const tmpDir = path.join(TMP_DIR, `extract-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  // Use system unzip to stream-extract without loading entire archive into RAM.
  // AdmZip loads the whole zip into memory upfront, which OOM-kills Node on large archives.
  try {
    const unzipBin = (() => {
      for (const p of ['/usr/bin/unzip', '/bin/unzip', '/usr/local/bin/unzip']) {
        if (fs.existsSync(p)) return p;
      }
      return 'unzip'; // fallback, let it fail with a clear error
    })();
    execSync(`"${unzipBin}" -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
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

    let tenant = getTenantByIdentifier(manifest.uuid);
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
    if (manifest.lightMode !== undefined) {
      tenantUpdates.lightMode = !!manifest.lightMode;
    }
    if (manifest.affiliateCommission != null && typeof manifest.affiliateCommission === 'number') {
      // Clamp to [0, 0.50] — affiliates can earn at most 50% commission
      tenantUpdates.affiliateCommission = Math.max(0, Math.min(0.50, manifest.affiliateCommission));
    }
    if (Object.keys(tenantUpdates).length > 0) {
      const tenants = loadTenants();
      Object.assign(tenants[tenant.uuid], tenantUpdates);
      saveTenants(tenants);
      Object.assign(tenant, tenantUpdates);
    }

    // Ensure the Sanora user exists before uploading any products.
    // If Redis was wiped, this re-creates the user and updates tenant.uuid.
    tenant = await sanoraEnsureUser(tenant);

    const total = countItems(root);
    let current = 0;
    onProgress({ type: 'start', total, name: manifest.name });

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

          onProgress({ type: 'progress', current: ++current, total, label: `📚 ${title}` });
          await sanoraCreateProductResilient(tenant, title, 'book', description, price, 0, buildTags('book', info.keywords));

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
            onProgress({ type: 'progress', current: ++current, total, label: `🎵 ${albumTitle}` });
            await sanoraCreateProductResilient(tenant, albumTitle, 'music', description, price, 0, buildTags('music,album', info.keywords));
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
            onProgress({ type: 'progress', current: ++current, total, label: `🎵 ${title}` });
            await sanoraCreateProductResilient(tenant, title, 'music', description, price, 0, buildTags('music,track', trackInfo.keywords));
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
            onProgress({ type: 'progress', current: ++current, total, label: `📝 ${seriesTitle} (series)` });
            await sanoraCreateProductResilient(tenant, seriesTitle, 'post-series', description, 0, 0, buildTags(`post,series,order:${order}`, info.keywords));

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

              onProgress({ type: 'progress', current: ++current, total, label: `📝 ${productTitle}` });
              await sanoraCreateProductResilient(tenant, productTitle, 'post', description, 0, 0,
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

            onProgress({ type: 'progress', current: ++current, total, label: `📝 ${title}` });
            await sanoraCreateProductResilient(tenant, title, 'post', description, 0, 0, buildTags(`post,blog,order:${order}`, info.keywords));
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
          onProgress({ type: 'progress', current: ++current, total, label: `🖼️ ${entry}` });
          await sanoraCreateProductResilient(tenant, entry, 'album', `Photo album: ${entry}`, 0, 0, 'album,photos');
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

          onProgress({ type: 'progress', current: ++current, total, label: `📦 ${title}` });
          await sanoraCreateProductResilient(tenant, title, 'product', description, price, shipping, buildTags(`product,physical,order:${order}`, info.keywords));

          // Hero image: prefer hero.jpg / hero.png, fall back to first image
          const images = fs.readdirSync(entryPath).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
          const heroFile = images.find(f => /^hero\.(jpg|jpeg|png|webp)$/i.test(f)) || images[0];
          if (heroFile) {
            try {
              const heroBuf = fs.readFileSync(path.join(entryPath, heroFile));
              await sanoraUploadImage(tenant, title, heroBuf, heroFile);
            } catch (imgErr) {
              console.warn(`[shoppe]   ⚠️  image upload for ${title}: ${imgErr.message}`);
              results.warnings.push(`Image upload for "${title}" failed: ${imgErr.message}`);
            }
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

          onProgress({ type: 'progress', current: ++current, total, label: `🎁 ${title}` });
          await sanoraCreateProductResilient(tenant, title, 'subscription', description, price, 0, buildTags('subscription', info.keywords));

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
          onProgress({ type: 'progress', current: ++current, total, label: `🎬 ${title}` });
          await sanoraCreateProductResilient(tenant, title, 'video', description, price, 0, videoTags);

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

          onProgress({ type: 'progress', current: ++current, total, label: `📅 ${title}` });
          await sanoraCreateProductResilient(tenant, title, 'appointment', description, price, 0, buildTags('appointment', info.keywords));

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

async function getShoppeGoods(tenant, imageBaseUrl) {
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

    const resolvedUrl = (bucketName && redirects[bucketName]) || defaultUrl;

    const item = {
      title: product.title || title,
      description: product.description || '',
      price: product.price || 0,
      shipping: product.shipping || 0,
      image: product.image ? `${imageBaseUrl || getSanoraUrl()}/images/${product.image}` : null,
      url: resolvedUrl,
      ...(isPost && { category: product.category, tags: product.tags || '' }),
      ...(lucillePlayerUrl && { lucillePlayerUrl }),
      ...(product.category === 'video' && { shoppeId: tenant.uuid })
    };
    const bucket = goods[bucketName];
    if (bucket) bucket.push(item);
  }

  // Enrich subscription and appointment items with artifact metadata
  const productsByTitle = {};
  for (const [key, product] of Object.entries(products)) {
    productsByTitle[product.title || key] = product;
  }
  await Promise.all([
    ...goods.subscriptions.map(async item => {
      const product = productsByTitle[item.title];
      if (!product) return;
      item.productId   = product.productId || '';
      const tierInfo   = await getTierInfo(tenant, product).catch(() => null);
      item.renewalDays = tierInfo ? (tierInfo.renewalDays || 30) : 30;
      item.benefits    = tierInfo ? (tierInfo.benefits    || []) : [];
    }),
    ...goods.appointments.map(async item => {
      const product = productsByTitle[item.title];
      if (!product) return;
      item.productId = product.productId || '';
      const schedule  = await getAppointmentSchedule(tenant, product).catch(() => null);
      item.timezone   = schedule ? (schedule.timezone || 'UTC') : 'UTC';
      item.duration   = schedule ? (schedule.duration  || 60)  : 60;
    })
  ]);

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
  const timestamp = Date.now().toString();
  const signature = signMessage(timestamp + tenant.uuid, tenantKeys.privateKey);
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
  const timestamp = Date.now().toString();
  const signature = signMessage(timestamp + tenant.uuid, tenantKeys.privateKey);
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


  const results = [];
  for (const [title, product] of Object.entries(products)) {
    const timestamp = Date.now().toString();
    const signature = signMessage(timestamp + tenant.uuid, tenant.keys.privateKey);
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
    const targetUrl = item.url;
    const clickHandler = isVideo
      ? `playVideo('${item.lucillePlayerUrl}')`
      : `window.open('${escHtml(targetUrl)}','_blank')`;
    const saveBtn = (item.price > 0 && item.productId)
      ? `<button class="save-shoppere-btn" onclick="event.stopPropagation();saveToShoppere(${JSON.stringify(item.title)},${JSON.stringify(item.productId)},${item.price},${JSON.stringify(category)})" title="Save to Shoppere wallet">📱 Save</button>`
      : '';
    return `
      <div class="card" onclick="${clickHandler}">
        ${imgHtml}
        <div class="card-body">
          <div class="card-title">${item.title}</div>
          ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}
          ${priceHtml}
          ${saveBtn}
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
  <script>
    const _shoppeId   = ${JSON.stringify(tenant.uuid)};
    const _shoppeName = ${JSON.stringify(tenant.name)};
    function saveToShoppere(title, productId, price, category) {
      const url = 'shoppere://product?'
        + 'd=' + encodeURIComponent(window.location.hostname)
        + '&s=' + encodeURIComponent(_shoppeId)
        + '&n=' + encodeURIComponent(_shoppeName)
        + '&t=' + encodeURIComponent(title)
        + '&i=' + encodeURIComponent(productId || title)
        + '&p=' + price
        + '&c=' + encodeURIComponent(category);
      window.location.href = url;
    }
  </script>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    /* ── Theme variables (dark default) ── */
    :root {
      --bg:           #0f0f12;
      --card-bg:      #18181c;
      --card-bg-2:    #1e1e22;
      --input-bg:     #2a2a2e;
      --nav-bg:       #18181c;
      --text:         #e8e8ea;
      --text-2:       #aaa;
      --text-3:       #888;
      --accent:       #7ec8e3;
      --border:       #333;
      --hover-bg:     #1a3040;
      --badge-bg:     #1a3040;
      --placeholder:  #2a2a2e;
      --shadow:       rgba(0,0,0,0.4);
      --shadow-hover: rgba(0,0,0,0.65);
      --row-border:   #2a2a2e;
      --progress-bg:  #333;
      --chip-bg:      #2a2a2e;
      --note-bg:      #2a2600;
      --note-border:  #665500;
      --note-text:    #ccaa44;
      --ok-bg:        #0a2a18;
      --ok-border:    #2a7050;
      --ok-text:      #5dd49a;
    }
    body.light {
      --bg:           #f5f5f7;
      --card-bg:      white;
      --card-bg-2:    #fafafa;
      --input-bg:     white;
      --nav-bg:       white;
      --text:         #1d1d1f;
      --text-2:       #666;
      --text-3:       #888;
      --accent:       #0066cc;
      --border:       #ddd;
      --hover-bg:     #e8f0fe;
      --badge-bg:     #e8f0fe;
      --placeholder:  #f0f0f7;
      --shadow:       rgba(0,0,0,0.07);
      --shadow-hover: rgba(0,0,0,0.12);
      --row-border:   #f0f0f0;
      --progress-bg:  #e0e0e0;
      --chip-bg:      #f0f0f7;
      --note-bg:      #fffde7;
      --note-border:  #e0c040;
      --note-text:    #7a6000;
      --ok-bg:        #f0faf4;
      --ok-border:    #48bb78;
      --ok-text:      #276749;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
    header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; padding: 48px 24px 40px; text-align: center; }
    .emojicode { font-size: 30px; letter-spacing: 6px; margin-bottom: 14px; }
    header h1 { font-size: 38px; font-weight: 700; margin-bottom: 6px; }
    .count { opacity: 0.65; font-size: 15px; }
    nav { display: flex; overflow-x: auto; background: var(--nav-bg); border-bottom: 1px solid var(--border); padding: 0 20px; gap: 0; }
    .tab { padding: 14px 18px; cursor: pointer; font-size: 14px; font-weight: 500; white-space: nowrap; border-bottom: 2px solid transparent; color: var(--text-2); transition: color 0.15s, border-color 0.15s; }
    .tab:hover { color: var(--accent); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .badge { background: var(--badge-bg); color: var(--accent); border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 5px; }
    main { max-width: 1200px; margin: 0 auto; padding: 36px 24px; }
    .section { display: none; }
    .section.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 20px; }
    .card { background: var(--card-bg); border-radius: 14px; overflow: hidden; box-shadow: 0 2px 8px var(--shadow); cursor: pointer; transition: transform 0.18s, box-shadow 0.18s; }
    .card:hover { transform: translateY(-3px); box-shadow: 0 8px 24px var(--shadow-hover); }
    .card-img img { width: 100%; height: 190px; object-fit: cover; display: block; }
    .card-img-placeholder { height: 110px; display: flex; align-items: center; justify-content: center; font-size: 44px; background: var(--placeholder); }
    .card-body { padding: 16px; }
    .card-title { font-size: 15px; font-weight: 600; margin-bottom: 5px; line-height: 1.3; }
    .card-desc { font-size: 13px; color: var(--text-2); margin-bottom: 8px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .price { font-size: 15px; font-weight: 700; color: var(--accent); }
    .shipping { font-size: 12px; font-weight: 400; color: var(--text-3); }
    .save-shoppere-btn { margin-top: 8px; background: none; border: 1px solid var(--border); border-radius: 14px; color: var(--text-3); font-size: 11px; padding: 4px 10px; cursor: pointer; display: inline-block; }
    .save-shoppere-btn:active { opacity: 0.6; }
    .empty { color: var(--text-3); text-align: center; padding: 60px 0; font-size: 15px; }
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
    .upload-btn-label { display: inline-block; background: var(--accent); color: white; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .upload-btn-label:hover { opacity: 0.85; }
    .upload-progress { margin-top: 8px; font-size: 12px; color: var(--text-2); }
    .upload-progress-bar { height: 4px; background: var(--progress-bg); border-radius: 2px; margin-top: 4px; overflow: hidden; }
    .upload-progress-bar-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.2s; }
    /* ── Posts browser ── */
    .posts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 20px; }
    .posts-back-btn { background: none; border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; margin-bottom: 20px; color: var(--text); }
    .posts-back-btn:hover { border-color: var(--accent); color: var(--accent); }
    .posts-series-header { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 24px; }
    .posts-series-cover { width: 120px; height: 120px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
    .posts-series-title { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
    .posts-series-desc { font-size: 14px; color: var(--text-2); line-height: 1.5; }
    .posts-part-row { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 10px; cursor: pointer; transition: background 0.15s; border-bottom: 1px solid var(--row-border); text-decoration: none; color: inherit; }
    .posts-part-row:hover { background: var(--hover-bg); }
    .posts-part-num { font-size: 13px; color: var(--text-3); min-width: 28px; text-align: center; font-weight: 600; }
    .posts-part-info { flex: 1; min-width: 0; }
    .posts-part-title { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .posts-part-desc { font-size: 12px; color: var(--text-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .posts-part-arrow { color: var(--accent); font-size: 14px; }
    .posts-standalones-label { font-size: 12px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: .5px; margin: 28px 0 12px; }
    /* ── Music player ── */
    .music-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; }
    .music-album-card { cursor: pointer; }
    .music-back-btn { background: none; border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; margin-bottom: 20px; color: var(--text); }
    .music-back-btn:hover { border-color: var(--accent); color: var(--accent); }
    .music-detail-header { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 24px; }
    .music-detail-cover { width: 140px; height: 140px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
    .music-detail-title { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
    .music-detail-desc { font-size: 14px; color: var(--text-2); line-height: 1.5; }
    .music-track-row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 10px; cursor: pointer; transition: background 0.15s; }
    .music-track-row:hover, .music-track-row.playing { background: var(--hover-bg); }
    .music-track-row.playing .music-track-title { color: var(--accent); font-weight: 600; }
    .music-track-num { font-size: 14px; color: var(--text-3); min-width: 24px; text-align: center; }
    .music-track-cover { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
    .music-track-cover-ph { width: 40px; height: 40px; border-radius: 6px; background: var(--placeholder); display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
    .music-track-info { flex: 1; min-width: 0; }
    .music-track-title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .music-track-meta { font-size: 12px; color: var(--text-3); }
    .music-play-icon { font-size: 14px; color: var(--text-3); opacity: 0; transition: opacity 0.15s; }
    .music-track-row:hover .music-play-icon { opacity: 1; }
    .music-track-row.playing .music-play-icon { opacity: 1; color: var(--accent); }
    .music-singles-label { font-size: 12px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: .5px; margin: 28px 0 8px; }
    /* ── Music player bar (always dark) ── */
    #music-player-bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(15,15,30,0.97); backdrop-filter: blur(12px); border-top: 1px solid #8b5cf6; padding: 12px 20px; z-index: 500; display: none; }
    .music-bar-inner { max-width: 1200px; margin: 0 auto; display: flex; align-items: center; gap: 16px; }
    .music-bar-art { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
    .music-bar-info { flex: 1; min-width: 0; }
    .music-bar-title { font-size: 14px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .music-bar-album { font-size: 12px; color: #8b5cf6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .music-bar-controls { display: flex; align-items: center; gap: 10px; }
    .music-bar-btn { background: none; border: none; cursor: pointer; color: #10b981; font-size: 20px; padding: 4px 8px; line-height: 1; transition: color 0.15s; }
    .music-bar-btn:hover { color: #fff; }
    .music-bar-progress { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 120px; }
    .music-bar-time { font-size: 11px; color: #fbbf24; min-width: 36px; text-align: center; }
    .music-bar-track { flex: 1; height: 4px; background: rgba(139,92,246,0.3); border-radius: 2px; cursor: pointer; position: relative; }
    .music-bar-fill { height: 100%; background: linear-gradient(90deg, #10b981, #8b5cf6); border-radius: 2px; width: 0%; transition: width 0.1s linear; }
    /* ── Inline subscription tiers ── */
    .sub-tier-card { background: var(--card-bg); border-radius: 14px; overflow: hidden; box-shadow: 0 2px 8px var(--shadow); margin-bottom: 20px; }
    .sub-tier-header { display: flex; gap: 20px; padding: 20px; }
    .sub-tier-img { width: 110px; height: 110px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
    .sub-tier-img-ph { width: 110px; height: 110px; border-radius: 10px; background: linear-gradient(135deg, #1a1a2e, #0f3460); display: flex; align-items: center; justify-content: center; font-size: 36px; flex-shrink: 0; }
    .sub-tier-info { flex: 1; min-width: 0; }
    .sub-tier-name { font-size: 19px; font-weight: 700; margin-bottom: 5px; }
    .sub-tier-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; margin-bottom: 10px; }
    .sub-tier-price { display: inline-flex; align-items: baseline; gap: 5px; color: var(--accent); font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .sub-tier-price span { font-size: 12px; color: var(--text-3); font-weight: 400; }
    .sub-benefits { list-style: none; display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .sub-benefits li { font-size: 12px; color: var(--text-2); padding-left: 16px; position: relative; }
    .sub-benefits li::before { content: '✓'; position: absolute; left: 0; color: var(--accent); font-weight: 700; }
    .sub-btn { background: linear-gradient(90deg, #0f3460, var(--accent)); color: white; border: none; border-radius: 8px; padding: 9px 20px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .sub-btn:hover { opacity: 0.88; }
    .sub-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .sub-form-panel { display: none; padding: 24px; border-top: 1px solid var(--border); background: var(--card-bg-2); }
    .sub-form-panel.open { display: block; }
    .sub-field-group { margin-bottom: 14px; }
    .sub-field-group label { display: block; font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; }
    .sub-field-group input { width: 100%; max-width: 400px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; color: var(--text); font-size: 14px; outline: none; transition: border-color 0.15s; }
    .sub-field-group input:focus { border-color: var(--accent); }
    .sub-error { color: #ff6b6b; font-size: 13px; margin-top: 8px; display: none; }
    .sub-recovery-note { background: var(--note-bg); border: 1px solid var(--note-border); border-radius: 8px; padding: 10px 14px; font-size: 12px; color: var(--note-text); margin-bottom: 14px; line-height: 1.5; }
    .sub-already { background: var(--ok-bg); border: 1px solid var(--ok-border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
    .sub-already strong { color: var(--ok-text); font-size: 14px; display: block; margin-bottom: 4px; }
    .sub-already p { font-size: 13px; color: var(--text-2); }
    .sub-confirm-box { text-align: center; padding: 24px; }
    .sub-confirm-box .icon { font-size: 48px; margin-bottom: 10px; }
    .sub-confirm-box h3 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .sub-confirm-box .renews { color: var(--accent); font-size: 14px; margin-bottom: 8px; }
    /* ── Inline appointment booking ── */
    .appt-card { background: var(--card-bg); border-radius: 14px; overflow: hidden; box-shadow: 0 2px 8px var(--shadow); margin-bottom: 20px; }
    .appt-card-header { display: flex; gap: 20px; padding: 20px; cursor: pointer; }
    .appt-card-header:hover { background: var(--card-bg-2); }
    .appt-img { width: 110px; height: 110px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
    .appt-img-ph { width: 110px; height: 110px; border-radius: 10px; background: linear-gradient(135deg, #1a1a2e, #0f3460); display: flex; align-items: center; justify-content: center; font-size: 36px; flex-shrink: 0; }
    .appt-info { flex: 1; min-width: 0; }
    .appt-name { font-size: 19px; font-weight: 700; margin-bottom: 5px; }
    .appt-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; margin-bottom: 10px; }
    .appt-meta { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .appt-chip { background: var(--chip-bg); border-radius: 20px; padding: 4px 12px; font-size: 12px; color: var(--text-2); }
    .appt-book-btn { background: linear-gradient(90deg, #0f3460, var(--accent)); color: white; border: none; border-radius: 8px; padding: 9px 20px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .appt-book-btn:hover { opacity: 0.88; }
    .appt-book-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .appt-booking-panel { display: none; padding: 24px; border-top: 1px solid var(--border); background: var(--card-bg-2); }
    .appt-booking-panel.open { display: block; }
    .appt-date-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 16px; scrollbar-width: thin; }
    .appt-date-card { flex: 0 0 66px; background: var(--input-bg); border: 2px solid var(--border); border-radius: 10px; padding: 8px 4px; text-align: center; cursor: pointer; transition: border-color 0.15s; }
    .appt-date-card:hover { border-color: var(--accent); }
    .appt-date-card.active { border-color: var(--accent); background: var(--hover-bg); }
    .appt-date-card .dow { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.5px; }
    .appt-date-card .dom { font-size: 20px; font-weight: 700; margin: 1px 0; color: var(--text); }
    .appt-date-card .mon { font-size: 10px; color: var(--text-3); }
    .appt-slot-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .appt-slot-btn { background: var(--input-bg); border: 2px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 13px; color: var(--text); cursor: pointer; transition: border-color 0.15s; }
    .appt-slot-btn:hover { border-color: var(--accent); }
    .appt-slot-btn.active { border-color: var(--accent); background: var(--hover-bg); color: var(--accent); font-weight: 600; }
    .appt-selected-slot { background: var(--hover-bg); border: 1px solid var(--accent); border-radius: 8px; padding: 10px 14px; font-size: 13px; color: var(--accent); margin-bottom: 14px; }
    .appt-back-btn { background: none; border: 1px solid var(--border); border-radius: 8px; padding: 9px 16px; font-size: 13px; cursor: pointer; color: var(--text-2); }
    .appt-back-btn:hover { border-color: var(--accent); color: var(--accent); }
    .appt-confirm-box { text-align: center; padding: 24px; }
    .appt-confirm-box .icon { font-size: 48px; margin-bottom: 10px; }
    .appt-confirm-box h3 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .appt-confirm-box .slot-label { color: var(--accent); font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  </style>
</head>
<body${tenant.lightMode ? ' class="light"' : ''}>
  <header>
    <div class="emojicode">${tenant.emojicode}</div>
    <h1>${tenant.name}</h1>
    <div class="count">${total} item${total !== 1 ? 's' : ''}</div>
  </header>
  <nav>${tabs}</nav>
  <main>
    <div id="all" class="section active"><div class="grid">${renderCards(allItems, 'all')}</div></div>
    <div id="books" class="section"><div class="grid">${renderCards(goods.books, 'book')}</div></div>
    <div id="music" class="section">
      <div id="music-album-grid"></div>
      <div id="music-album-detail" style="display:none">
        <button class="music-back-btn" onclick="musicShowGrid()">&#8592; Albums</button>
        <div id="music-detail-header"></div>
        <div id="music-track-list"></div>
      </div>
    </div>
    <div id="posts" class="section">
      <div id="posts-grid"></div>
      <div id="posts-series-detail" style="display:none">
        <button class="posts-back-btn" onclick="postsShowGrid()">&#8592; Posts</button>
        <div id="posts-series-header"></div>
        <div id="posts-parts-list"></div>
      </div>
    </div>
    <div id="albums" class="section"><div class="grid">${renderCards(goods.albums, 'album')}</div></div>
    <div id="products" class="section"><div class="grid">${renderCards(goods.products, 'product')}</div></div>
    <div id="videos" class="section"><div class="grid">${renderCards(goods.videos, 'video')}</div></div>
    <div id="appointments" class="section">
      <div id="appointments-list"></div>
    </div>
    <div id="subscriptions" class="section">
      <div id="subscriptions-list"></div>
      <div style="text-align:center;padding:12px 0 8px;font-size:13px;color:#888;">
        Already infusing? <a href="/plugin/shoppe/${tenant.uuid}/membership" style="color:#0066cc;">Access your membership →</a>
      </div>
    </div>
  </main>
  <div id="music-player-bar">
    <div class="music-bar-inner">
      <img id="music-bar-art" class="music-bar-art" src="" alt="" style="display:none">
      <div class="music-bar-info">
        <div class="music-bar-title" id="music-bar-title">—</div>
        <div class="music-bar-album" id="music-bar-album"></div>
      </div>
      <div class="music-bar-controls">
        <button class="music-bar-btn" onclick="musicBarPrev()" title="Previous">&#9664;&#9664;</button>
        <button class="music-bar-btn" id="music-bar-play" onclick="musicBarPlayPause()" title="Play/Pause">&#9654;</button>
        <button class="music-bar-btn" onclick="musicBarNext()" title="Next">&#9654;&#9654;</button>
      </div>
      <div class="music-bar-progress">
        <span class="music-bar-time" id="music-bar-time">0:00</span>
        <div class="music-bar-track" onclick="musicBarSeek(event)">
          <div class="music-bar-fill" id="music-bar-fill"></div>
        </div>
        <span class="music-bar-time" id="music-bar-dur">0:00</span>
      </div>
    </div>
  </div>
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
      if (id === 'music' && !_musicLoaded) initMusic();
      if (id === 'posts' && !_postsLoaded) initPosts();
      if (id === 'subscriptions' && !_subsLoaded) initSubscriptions();
      if (id === 'appointments' && !_apptsLoaded) initAppointments();
    }

    // ── Posts browser ───────────────────────────────────────────────────────
    const _postsRaw = ${(() => {
      // Build structured posts data server-side so the client just reads JSON.
      const seriesMap = {};  // seriesTitle → { item, parts: [] }
      const standalones = [];
      // First pass: collect series parents
      for (const item of goods.posts) {
        if (item.category === 'post-series') seriesMap[item.title] = { ...item, parts: [] };
      }
      // Second pass: attach parts to their series, or collect standalones
      for (const item of goods.posts) {
        if (item.category !== 'post') continue;
        const tagParts = (item.tags || '').split(',');
        const seriesTag = tagParts.find(t => t.startsWith('series:'));
        const partTag   = tagParts.find(t => t.startsWith('part:'));
        const seriesTitle = seriesTag ? seriesTag.slice('series:'.length) : null;
        const partNum     = partTag   ? parseInt(partTag.slice('part:'.length)) || 0 : 0;
        if (seriesTitle && seriesMap[seriesTitle]) {
          seriesMap[seriesTitle].parts.push({ ...item, partNum });
        } else {
          standalones.push(item);
        }
      }
      // Sort parts within each series
      for (const s of Object.values(seriesMap)) {
        s.parts.sort((a, b) => (a.partNum || 0) - (b.partNum || 0));
      }
      return JSON.stringify({ series: Object.values(seriesMap), standalones });
    })()};
    let _postsLoaded = false;

    function initPosts() {
      _postsLoaded = true;
      postsRenderGrid();
    }

    function postsRenderGrid() {
      const grid = document.getElementById('posts-grid');
      const { series, standalones } = _postsRaw;
      if (series.length === 0 && standalones.length === 0) {
        grid.innerHTML = '<p class="empty">No posts yet.</p>';
        return;
      }
      const seriesHtml = series.length ? \`<div class="posts-grid">\${series.map((s, i) => \`
        <div class="card" style="cursor:pointer" onclick="postsShowSeries(\${i})">
          \${s.image ? \`<div class="card-img"><img src="\${_escHtml(s.image)}" alt="" loading="lazy"></div>\` : '<div class="card-img-placeholder">📝</div>'}
          <div class="card-body">
            <div class="card-title">\${_escHtml(s.title)}</div>
            \${s.description ? \`<div class="card-desc">\${_escHtml(s.description)}</div>\` : ''}
            <div style="font-size:12px;color:#0066cc;margin-top:6px;font-weight:600">\${s.parts.length} part\${s.parts.length !== 1 ? 's' : ''}</div>
          </div>
        </div>\`).join('')}</div>\` : '';
      const standaloneHtml = standalones.length ? \`
        \${series.length ? '<div class="posts-standalones-label">Posts</div>' : ''}
        <div class="posts-grid">\${standalones.map(p => \`
          <div class="card" style="cursor:pointer" onclick="window.location.href='\${_escHtml(p.url)}'">
            \${p.image ? \`<div class="card-img"><img src="\${_escHtml(p.image)}" alt="" loading="lazy"></div>\` : '<div class="card-img-placeholder">📝</div>'}
            <div class="card-body">
              <div class="card-title">\${_escHtml(p.title)}</div>
              \${p.description ? \`<div class="card-desc">\${_escHtml(p.description)}</div>\` : ''}
            </div>
          </div>\`).join('')}</div>\` : '';
      grid.innerHTML = seriesHtml + standaloneHtml;
    }

    function postsShowSeries(idx) {
      const s = _postsRaw.series[idx];
      document.getElementById('posts-grid').style.display = 'none';
      document.getElementById('posts-series-detail').style.display = 'block';
      document.getElementById('posts-series-header').innerHTML = \`
        <div class="posts-series-header">
          \${s.image ? \`<img class="posts-series-cover" src="\${_escHtml(s.image)}" alt="">\` : ''}
          <div>
            <div class="posts-series-title">\${_escHtml(s.title)}</div>
            \${s.description ? \`<div class="posts-series-desc">\${_escHtml(s.description)}</div>\` : ''}
          </div>
        </div>\`;
      document.getElementById('posts-parts-list').innerHTML = s.parts.map((p, i) => \`
        <a class="posts-part-row" href="\${_escHtml(p.url)}">
          <div class="posts-part-num">\${p.partNum || i + 1}</div>
          <div class="posts-part-info">
            <div class="posts-part-title">\${_escHtml(p.title.replace(s.title + ': ', ''))}</div>
            \${p.description ? \`<div class="posts-part-desc">\${_escHtml(p.description)}</div>\` : ''}
          </div>
          <div class="posts-part-arrow">&#8594;</div>
        </a>\`).join('');
    }

    function postsShowGrid() {
      document.getElementById('posts-grid').style.display = '';
      document.getElementById('posts-series-detail').style.display = 'none';
    }

    // ── Music player ────────────────────────────────────────────────────────
    let _musicLoaded = false, _musicAlbums = [], _musicTracks = [], _musicAllTracks = [], _musicCurrentIdx = -1;
    const _musicAudio = new Audio();

    function _escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function initMusic() {
      _musicLoaded = true;
      const grid = document.getElementById('music-album-grid');
      grid.innerHTML = '<p class="empty">Loading music\u2026</p>';
      try {
        const resp = await fetch('/plugin/shoppe/${tenant.uuid}/music/feed');
        const data = await resp.json();
        _musicAlbums = data.albums || [];
        _musicTracks = data.tracks || [];
        _musicAllTracks = [
          ..._musicAlbums.flatMap(a => a.tracks.map(t => ({ ...t, cover: a.cover, albumName: a.name }))),
          ..._musicTracks.map(t => ({ ...t, albumName: '' }))
        ];
        musicRenderGrid();
      } catch (e) {
        grid.innerHTML = '<p class="empty">Could not load music.</p>';
      }
    }

    function musicRenderGrid() {
      const grid = document.getElementById('music-album-grid');
      if (_musicAlbums.length === 0 && _musicTracks.length === 0) {
        grid.innerHTML = '<p class="empty">No music yet.</p>';
        return;
      }
      const albumsHtml = _musicAlbums.length ? \`<div class="music-grid">\${_musicAlbums.map((a, i) => \`
        <div class="card music-album-card" onclick="musicShowAlbum(\${i})">
          \${a.cover ? \`<div class="card-img"><img src="\${_escHtml(a.cover)}" alt="" loading="lazy"></div>\` : '<div class="card-img-placeholder">🎵</div>'}
          <div class="card-body">
            <div class="card-title">\${_escHtml(a.name)}</div>
            <div class="card-desc">\${a.tracks.length} track\${a.tracks.length !== 1 ? 's' : ''}</div>
          </div>
        </div>\`).join('')}</div>\` : '';
      const tracksHtml = _musicTracks.length ? \`
        <div class="music-singles-label">Singles</div>
        \${_musicTracks.map((t, i) => \`
          <div class="music-track-row" id="mts-\${i}" onclick="musicPlayStandalone(\${i})">
            \${t.cover ? \`<img class="music-track-cover" src="\${_escHtml(t.cover)}" alt="">\` : '<div class="music-track-cover-ph">🎵</div>'}
            <div class="music-track-info"><div class="music-track-title">\${_escHtml(t.title)}</div></div>
            <div class="music-play-icon">&#9654;</div>
          </div>\`).join('')}\` : '';
      grid.innerHTML = albumsHtml + tracksHtml;
    }

    function musicShowAlbum(idx) {
      const a = _musicAlbums[idx];
      document.getElementById('music-album-grid').style.display = 'none';
      const det = document.getElementById('music-album-detail');
      det.style.display = 'block';
      document.getElementById('music-detail-header').innerHTML = \`
        <div class="music-detail-header">
          \${a.cover ? \`<img class="music-detail-cover" src="\${_escHtml(a.cover)}" alt="">\` : ''}
          <div>
            <div class="music-detail-title">\${_escHtml(a.name)}</div>
            \${a.description ? \`<div class="music-detail-desc">\${_escHtml(a.description)}</div>\` : ''}
          </div>
        </div>\`;
      document.getElementById('music-track-list').innerHTML = a.tracks.map((t, i) => \`
        <div class="music-track-row" id="mta-\${idx}-\${i}" onclick="musicPlayAlbumTrack(\${idx},\${i})">
          <div class="music-track-num">\${t.number}</div>
          <div class="music-track-info"><div class="music-track-title">\${_escHtml(t.title)}</div></div>
          <div class="music-play-icon">&#9654;</div>
        </div>\`).join('');
    }

    function musicShowGrid() {
      document.getElementById('music-album-grid').style.display = '';
      document.getElementById('music-album-detail').style.display = 'none';
    }

    function musicPlayAlbumTrack(albumIdx, trackIdx) {
      const a = _musicAlbums[albumIdx], t = a.tracks[trackIdx];
      _musicCurrentIdx = _musicAllTracks.findIndex(x => x.src === t.src);
      _musicDoPlay({ ...t, cover: a.cover, albumName: a.name });
      document.querySelectorAll('[id^="mta-"]').forEach(el => el.classList.remove('playing'));
      const el = document.getElementById(\`mta-\${albumIdx}-\${trackIdx}\`);
      if (el) el.classList.add('playing');
    }

    function musicPlayStandalone(idx) {
      const t = _musicTracks[idx];
      _musicCurrentIdx = _musicAllTracks.findIndex(x => x.src === t.src);
      _musicDoPlay(t);
      document.querySelectorAll('[id^="mts-"]').forEach(el => el.classList.remove('playing'));
      const el = document.getElementById(\`mts-\${idx}\`);
      if (el) el.classList.add('playing');
    }

    function _musicDoPlay(track) {
      _musicAudio.src = track.src;
      _musicAudio.play();
      const bar = document.getElementById('music-player-bar');
      bar.style.display = 'block';
      document.getElementById('music-bar-title').textContent = track.title;
      document.getElementById('music-bar-album').textContent = track.albumName || '';
      const art = document.getElementById('music-bar-art');
      if (track.cover) { art.src = track.cover; art.style.display = 'block'; }
      else art.style.display = 'none';
      document.getElementById('music-bar-play').innerHTML = '&#9646;&#9646;';
    }

    _musicAudio.addEventListener('ended', () => {
      if (_musicCurrentIdx < _musicAllTracks.length - 1) {
        _musicCurrentIdx++;
        _musicDoPlay(_musicAllTracks[_musicCurrentIdx]);
      } else {
        document.getElementById('music-bar-play').innerHTML = '&#9654;';
      }
    });
    _musicAudio.addEventListener('timeupdate', () => {
      if (!_musicAudio.duration) return;
      document.getElementById('music-bar-fill').style.width = (_musicAudio.currentTime / _musicAudio.duration * 100) + '%';
      document.getElementById('music-bar-time').textContent = _musicFmt(_musicAudio.currentTime);
    });
    _musicAudio.addEventListener('loadedmetadata', () => {
      document.getElementById('music-bar-dur').textContent = _musicFmt(_musicAudio.duration);
    });

    function _musicFmt(s) {
      if (!s || isNaN(s)) return '0:00';
      return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    }
    function musicBarPlayPause() {
      if (_musicAudio.paused) { _musicAudio.play(); document.getElementById('music-bar-play').innerHTML = '&#9646;&#9646;'; }
      else { _musicAudio.pause(); document.getElementById('music-bar-play').innerHTML = '&#9654;'; }
    }
    function musicBarPrev() {
      if (_musicCurrentIdx > 0) { _musicCurrentIdx--; _musicDoPlay(_musicAllTracks[_musicCurrentIdx]); }
    }
    function musicBarNext() {
      if (_musicCurrentIdx < _musicAllTracks.length - 1) { _musicCurrentIdx++; _musicDoPlay(_musicAllTracks[_musicCurrentIdx]); }
    }
    function musicBarSeek(e) {
      const r = e.currentTarget.getBoundingClientRect();
      _musicAudio.currentTime = _musicAudio.duration * ((e.clientX - r.left) / r.width);
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

    // ── Inline subscription tiers ────────────────────────────────────────────
    const _subsData = ${JSON.stringify(goods.subscriptions)};
    let _subsLoaded = false;

    function initSubscriptions() {
      _subsLoaded = true;
      renderSubTiers();
    }

    function renderSubTiers() {
      const container = document.getElementById('subscriptions-list');
      if (!_subsData.length) { container.innerHTML = '<p class="empty">No subscription tiers yet.</p>'; return; }
      container.innerHTML = _subsData.map((tier, i) => {
        const fmtPrice = (tier.price / 100).toFixed(2);
        const benefitsHtml = (tier.benefits && tier.benefits.length)
          ? \`<ul class="sub-benefits">\${tier.benefits.map(b => \`<li>\${_escHtml(b)}</li>\`).join('')}</ul>\`
          : '';
        return \`
        <div class="sub-tier-card">
          <div class="sub-tier-header">
            \${tier.image ? \`<img class="sub-tier-img" src="\${_escHtml(tier.image)}" alt="">\` : '<div class="sub-tier-img-ph">🎁</div>'}
            <div class="sub-tier-info">
              <div class="sub-tier-name">\${_escHtml(tier.title)}</div>
              \${tier.description ? \`<div class="sub-tier-desc">\${_escHtml(tier.description)}</div>\` : ''}
              <div class="sub-tier-price">$\${fmtPrice}<span>/ \${tier.renewalDays || 30} days</span></div>
              \${benefitsHtml}
              <button class="sub-btn" onclick="subToggle(\${i})">Subscribe →</button>
            </div>
          </div>
          <div class="sub-form-panel" id="sub-panel-\${i}">
            <div id="sub-already-\${i}" class="sub-already" style="display:none">
              <strong>✅ You're already infusing!</strong>
              <p id="sub-already-desc-\${i}"></p>
            </div>
            <div id="sub-recovery-\${i}">
              <div class="sub-recovery-note">🔑 Choose a recovery key — a word or phrase only you know. You'll use it every time you want to access your membership benefits.</div>
              <div class="sub-field-group">
                <label>Recovery Key *</label>
                <input type="text" id="sub-rkey-\${i}" placeholder="e.g. golden-ticket-2026" autocomplete="off">
              </div>
              <button class="sub-btn" onclick="subProceed(\${i})">Continue to Payment →</button>
              <div id="sub-rkey-error-\${i}" class="sub-error"></div>
            </div>
            <div id="sub-payment-\${i}" style="display:none">
              <div style="font-size:14px;font-weight:600;margin-bottom:12px;">Complete your subscription — $\${fmtPrice} / \${tier.renewalDays || 30} days</div>
              <div id="sub-stripe-el-\${i}" style="margin-bottom:14px;"></div>
              <button class="sub-btn" id="sub-pay-btn-\${i}" onclick="subConfirm(\${i})">Pay $\${fmtPrice}</button>
              <div id="sub-pay-loading-\${i}" style="display:none;font-size:13px;color:#888;margin-top:8px;"></div>
              <div id="sub-pay-error-\${i}" class="sub-error"></div>
            </div>
            <div id="sub-confirm-\${i}" style="display:none">
              <div class="sub-confirm-box">
                <div class="icon">🎉</div>
                <h3>Thank you for infusing!</h3>
                <div class="renews" id="sub-confirm-renews-\${i}"></div>
                <p style="font-size:13px;color:#888;margin:8px 0 14px;">Use your recovery key at the <a href="/plugin/shoppe/${tenant.uuid}/membership" style="color:#0066cc;">membership portal</a> to access exclusive content.</p>
              </div>
            </div>
          </div>
        </div>\`;
      }).join('');
    }

    const _subStripeInst = {}, _subEls = {}, _subClientSecrets = {};

    function subToggle(i) {
      const panel = document.getElementById(\`sub-panel-\${i}\`);
      const isOpen = panel.classList.contains('open');
      document.querySelectorAll('.sub-form-panel').forEach(p => p.classList.remove('open'));
      if (!isOpen) { panel.classList.add('open'); panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }

    async function subProceed(i) {
      const tier = _subsData[i];
      const recoveryKey = document.getElementById(\`sub-rkey-\${i}\`).value.trim();
      const errEl = document.getElementById(\`sub-rkey-error-\${i}\`);
      if (!recoveryKey) { errEl.textContent = 'Recovery key is required.'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';
      try {
        const resp = await fetch('/plugin/shoppe/${tenant.uuid}/purchase/intent', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recoveryKey, productId: tier.productId, title: tier.title })
        });
        const data = await resp.json();
        if (data.alreadySubscribed) {
          document.getElementById(\`sub-recovery-\${i}\`).style.display = 'none';
          const banner = document.getElementById(\`sub-already-\${i}\`);
          banner.style.display = 'block';
          document.getElementById(\`sub-already-desc-\${i}\`).textContent = \`Your subscription is active for \${data.daysLeft} more day\${data.daysLeft !== 1 ? 's' : ''}.\`;
          return;
        }
        if (data.error) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }
        document.getElementById(\`sub-recovery-\${i}\`).style.display = 'none';
        document.getElementById(\`sub-payment-\${i}\`).style.display = 'block';
        _subClientSecrets[i] = data.clientSecret;
        _subStripeInst[i] = Stripe(data.publishableKey);
        _subEls[i] = _subStripeInst[i].elements({ clientSecret: data.clientSecret });
        _subEls[i].create('payment').mount(\`#sub-stripe-el-\${i}\`);
      } catch (err) {
        errEl.textContent = 'Could not start checkout. Please try again.';
        errEl.style.display = 'block';
      }
    }

    async function subConfirm(i) {
      const tier = _subsData[i];
      const payBtn = document.getElementById(\`sub-pay-btn-\${i}\`);
      const payLoading = document.getElementById(\`sub-pay-loading-\${i}\`);
      const payError = document.getElementById(\`sub-pay-error-\${i}\`);
      payBtn.disabled = true; payLoading.style.display = 'block'; payLoading.textContent = 'Processing…'; payError.style.display = 'none';
      try {
        const { error } = await _subStripeInst[i].confirmPayment({
          elements: _subEls[i], confirmParams: { return_url: window.location.href }, redirect: 'if_required'
        });
        if (error) { payError.textContent = error.message; payError.style.display = 'block'; payBtn.disabled = false; payLoading.style.display = 'none'; return; }
        const recoveryKey = document.getElementById(\`sub-rkey-\${i}\`).value.trim();
        const paymentIntentId = _subClientSecrets[i] ? _subClientSecrets[i].split('_secret_')[0] : undefined;
        await fetch('/plugin/shoppe/${tenant.uuid}/purchase/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recoveryKey, productId: tier.productId, title: tier.title, amount: tier.price, type: 'subscription', renewalDays: tier.renewalDays || 30, paymentIntentId })
        });
        document.getElementById(\`sub-payment-\${i}\`).style.display = 'none';
        const conf = document.getElementById(\`sub-confirm-\${i}\`);
        conf.style.display = 'block';
        const renewsAt = new Date(Date.now() + (tier.renewalDays || 30) * 24 * 60 * 60 * 1000);
        document.getElementById(\`sub-confirm-renews-\${i}\`).textContent = 'Active until ' + renewsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      } catch (err) {
        payError.textContent = 'An unexpected error occurred.'; payError.style.display = 'block';
        payBtn.disabled = false; payLoading.style.display = 'none';
      }
    }

    // ── Inline appointment booking ────────────────────────────────────────────
    const _apptsData = ${JSON.stringify(goods.appointments)};
    let _apptsLoaded = false;
    const _apptState = {}; // per-appointment state: { availableDates, selectedSlot }
    const _apptStripe = {}, _apptElems = {}, _apptSecrets = {};

    function initAppointments() {
      _apptsLoaded = true;
      renderAppts();
    }

    function renderAppts() {
      const container = document.getElementById('appointments-list');
      if (!_apptsData.length) { container.innerHTML = '<p class="empty">No appointments yet.</p>'; return; }
      container.innerHTML = _apptsData.map((appt, i) => {
        const fmtPrice = appt.price > 0 ? ('$' + (appt.price / 100).toFixed(2) + '/session') : 'Free';
        return \`
        <div class="appt-card">
          <div class="appt-card-header" onclick="apptToggle(\${i})">
            \${appt.image ? \`<img class="appt-img" src="\${_escHtml(appt.image)}" alt="">\` : '<div class="appt-img-ph">📅</div>'}
            <div class="appt-info">
              <div class="appt-name">\${_escHtml(appt.title)}</div>
              \${appt.description ? \`<div class="appt-desc">\${_escHtml(appt.description)}</div>\` : ''}
              <div class="appt-meta">
                <span class="appt-chip">💰 \${fmtPrice}</span>
                <span class="appt-chip">⏱ \${appt.duration || 60} min</span>
              </div>
              <button class="appt-book-btn">Book →</button>
            </div>
          </div>
          <div class="appt-booking-panel" id="appt-panel-\${i}">
            <div id="appt-step-dates-\${i}">
              <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Choose a date</h3>
              <div id="appt-date-strip-\${i}" class="appt-date-strip"></div>
              <div id="appt-loading-\${i}" style="font-size:13px;color:#888;">Loading availability…</div>
              <div id="appt-no-slots-\${i}" style="display:none;font-size:13px;color:#888;">No upcoming availability.</div>
            </div>
            <div id="appt-step-slots-\${i}" style="display:none">
              <h3 id="appt-slot-heading-\${i}" style="font-size:15px;font-weight:600;margin-bottom:10px;">Available times</h3>
              <div id="appt-slot-grid-\${i}" class="appt-slot-grid"></div>
            </div>
            <div id="appt-form-\${i}" style="display:none">
              <div id="appt-slot-display-\${i}" class="appt-selected-slot"></div>
              <div class="sub-recovery-note">🔑 Choose a recovery key — you'll use it to look up your booking later.</div>
              <div class="sub-field-group"><label>Recovery Key *</label><input type="text" id="appt-rkey-\${i}" placeholder="e.g. sunflower-2026" autocomplete="off"></div>
              <div class="sub-field-group"><label>Your Name *</label><input type="text" id="appt-name-\${i}" placeholder="Full name"></div>
              <div class="sub-field-group"><label>Email *</label><input type="email" id="appt-email-\${i}" placeholder="For booking confirmation"></div>
              <div style="display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;">
                <button class="appt-back-btn" onclick="apptBackToSlots(\${i})">← Change time</button>
                <button class="appt-book-btn" id="appt-proceed-btn-\${i}" onclick="apptProceed(\${i})">\${appt.price === 0 ? 'Confirm Booking →' : 'Continue to Payment →'}</button>
              </div>
              <div id="appt-form-error-\${i}" class="sub-error"></div>
            </div>
            <div id="appt-payment-\${i}" style="display:none">
              <div id="appt-slot-display-pay-\${i}" class="appt-selected-slot" style="margin-bottom:14px;"></div>
              <div id="appt-stripe-el-\${i}" style="margin-bottom:14px;"></div>
              <button class="appt-book-btn" id="appt-pay-btn-\${i}" onclick="apptConfirmPayment(\${i})">Pay $\${(appt.price/100).toFixed(2)}</button>
              <div id="appt-pay-loading-\${i}" style="display:none;font-size:13px;color:#888;margin-top:8px;"></div>
              <div id="appt-pay-error-\${i}" class="sub-error"></div>
            </div>
            <div id="appt-confirm-\${i}" style="display:none">
              <div class="appt-confirm-box">
                <div class="icon">✅</div>
                <h3>You're booked!</h3>
                <div class="slot-label" id="appt-confirm-slot-\${i}"></div>
                <p style="font-size:12px;color:#888;margin-top:8px;">Keep your recovery key safe — it's how you look up this booking.</p>
              </div>
            </div>
          </div>
        </div>\`;
      }).join('');
    }

    function apptToggle(i) {
      const panel = document.getElementById(\`appt-panel-\${i}\`);
      const isOpen = panel.classList.contains('open');
      document.querySelectorAll('.appt-booking-panel').forEach(p => p.classList.remove('open'));
      if (!isOpen) {
        panel.classList.add('open');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (!_apptState[i]) { _apptState[i] = {}; apptLoadSlots(i); }
      }
    }

    async function apptLoadSlots(i) {
      const appt = _apptsData[i];
      const loadingEl = document.getElementById(\`appt-loading-\${i}\`);
      const noSlotsEl = document.getElementById(\`appt-no-slots-\${i}\`);
      try {
        const resp = await fetch('/plugin/shoppe/${tenant.uuid}/book/' + encodeURIComponent(appt.title) + '/slots');
        const data = await resp.json();
        loadingEl.style.display = 'none';
        if (!data.available || !data.available.length) { noSlotsEl.style.display = 'block'; return; }
        _apptState[i].availableDates = data.available;
        apptRenderDateStrip(i);
        apptSelectDate(i, data.available[0]);
      } catch (err) {
        loadingEl.textContent = 'Could not load availability.';
      }
    }

    function apptRenderDateStrip(i) {
      const strip = document.getElementById(\`appt-date-strip-\${i}\`);
      strip.innerHTML = '';
      (_apptState[i].availableDates || []).forEach((d, di) => {
        const parts = d.date.split('-');
        const dateObj = new Date(+parts[0], +parts[1] - 1, +parts[2]);
        const dow = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
        const mon = dateObj.toLocaleDateString('en-US', { month: 'short' });
        const card = document.createElement('div');
        card.className = 'appt-date-card';
        card.innerHTML = \`<div class="dow">\${dow}</div><div class="dom">\${dateObj.getDate()}</div><div class="mon">\${mon}</div>\`;
        card.addEventListener('click', () => apptSelectDate(i, d));
        strip.appendChild(card);
      });
    }

    function apptSelectDate(i, dateData) {
      _apptState[i].selectedDate = dateData;
      _apptState[i].selectedSlot = null;
      document.querySelectorAll(\`#appt-date-strip-\${i} .appt-date-card\`).forEach((c, di) => {
        c.classList.toggle('active', (_apptState[i].availableDates || [])[di] === dateData);
      });
      const slotsDiv = document.getElementById(\`appt-step-slots-\${i}\`);
      slotsDiv.style.display = 'block';
      document.getElementById(\`appt-slot-heading-\${i}\`).textContent = 'Times on ' + dateData.dayLabel;
      apptRenderSlots(i, dateData.slots);
      document.getElementById(\`appt-form-\${i}\`).style.display = 'none';
      document.getElementById(\`appt-payment-\${i}\`).style.display = 'none';
    }

    function apptRenderSlots(i, slots) {
      const grid = document.getElementById(\`appt-slot-grid-\${i}\`);
      grid.innerHTML = '';
      slots.forEach(slotStr => {
        const [, time] = slotStr.split('T');
        const [h, m] = time.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        const label = h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
        const btn = document.createElement('button');
        btn.className = 'appt-slot-btn';
        btn.textContent = label;
        btn.addEventListener('click', () => apptSelectSlot(i, slotStr, label));
        grid.appendChild(btn);
      });
    }

    function apptSelectSlot(i, slotStr, label) {
      _apptState[i].selectedSlot = slotStr;
      document.querySelectorAll(\`#appt-slot-grid-\${i} .appt-slot-btn\`).forEach(b => b.classList.remove('active'));
      event.currentTarget.classList.add('active');
      const display = apptFormatSlot(i, slotStr);
      document.getElementById(\`appt-slot-display-\${i}\`).textContent = '📅 ' + display;
      const formDiv = document.getElementById(\`appt-form-\${i}\`);
      formDiv.style.display = 'block';
      formDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function apptFormatSlot(i, slotStr) {
      const appt = _apptsData[i];
      const [datePart, timePart] = slotStr.split('T');
      const [y, mo, d] = datePart.split('-').map(Number);
      const [h, m] = timePart.split(':').map(Number);
      const dateObj = new Date(y, mo - 1, d);
      const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return dateLabel + ' at ' + h12 + ':' + String(m).padStart(2,'0') + ' ' + ampm + ' ' + (appt.timezone || '');
    }

    function apptBackToSlots(i) {
      _apptState[i].selectedSlot = null;
      document.getElementById(\`appt-form-\${i}\`).style.display = 'none';
      document.getElementById(\`appt-payment-\${i}\`).style.display = 'none';
      document.querySelectorAll(\`#appt-slot-grid-\${i} .appt-slot-btn\`).forEach(b => b.classList.remove('active'));
    }

    async function apptProceed(i) {
      const appt = _apptsData[i];
      const recoveryKey = document.getElementById(\`appt-rkey-\${i}\`).value.trim();
      const name = document.getElementById(\`appt-name-\${i}\`).value.trim();
      const email = document.getElementById(\`appt-email-\${i}\`).value.trim();
      const errEl = document.getElementById(\`appt-form-error-\${i}\`);
      const selectedSlot = _apptState[i] && _apptState[i].selectedSlot;
      if (!recoveryKey) { errEl.textContent = 'Recovery key is required.'; errEl.style.display = 'block'; return; }
      if (!name) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
      if (!email) { errEl.textContent = 'Email is required.'; errEl.style.display = 'block'; return; }
      if (!selectedSlot) { errEl.textContent = 'Please select a time slot.'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';
      document.getElementById(\`appt-proceed-btn-\${i}\`).disabled = true;
      try {
        const resp = await fetch('/plugin/shoppe/${tenant.uuid}/purchase/intent', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recoveryKey, productId: appt.productId, title: appt.title, slotDatetime: selectedSlot })
        });
        const data = await resp.json();
        if (data.error) { errEl.textContent = data.error; errEl.style.display = 'block'; document.getElementById(\`appt-proceed-btn-\${i}\`).disabled = false; return; }
        if (data.free) {
          await fetch('/plugin/shoppe/${tenant.uuid}/purchase/complete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recoveryKey, productId: appt.productId, title: appt.title, slotDatetime: selectedSlot, contactInfo: { name, email } })
          });
          document.getElementById(\`appt-form-\${i}\`).style.display = 'none';
          apptShowConfirm(i, selectedSlot);
          return;
        }
        document.getElementById(\`appt-form-\${i}\`).style.display = 'none';
        const payDiv = document.getElementById(\`appt-payment-\${i}\`);
        payDiv.style.display = 'block';
        document.getElementById(\`appt-slot-display-pay-\${i}\`).textContent = '📅 ' + apptFormatSlot(i, selectedSlot);
        _apptSecrets[i] = data.clientSecret;
        _apptStripe[i] = Stripe(data.publishableKey);
        _apptElems[i] = _apptStripe[i].elements({ clientSecret: data.clientSecret });
        _apptElems[i].create('payment').mount(\`#appt-stripe-el-\${i}\`);
        payDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        errEl.textContent = 'Could not start checkout. Please try again.';
        errEl.style.display = 'block';
        document.getElementById(\`appt-proceed-btn-\${i}\`).disabled = false;
      }
    }

    async function apptConfirmPayment(i) {
      const appt = _apptsData[i];
      const payBtn = document.getElementById(\`appt-pay-btn-\${i}\`);
      const payLoading = document.getElementById(\`appt-pay-loading-\${i}\`);
      const payError = document.getElementById(\`appt-pay-error-\${i}\`);
      payBtn.disabled = true; payLoading.style.display = 'block'; payLoading.textContent = 'Processing…'; payError.style.display = 'none';
      try {
        const { error } = await _apptStripe[i].confirmPayment({
          elements: _apptElems[i], confirmParams: { return_url: window.location.href }, redirect: 'if_required'
        });
        if (error) { payError.textContent = error.message; payError.style.display = 'block'; payBtn.disabled = false; payLoading.style.display = 'none'; return; }
        const recoveryKey = document.getElementById(\`appt-rkey-\${i}\`).value.trim();
        const name = document.getElementById(\`appt-name-\${i}\`).value.trim();
        const email = document.getElementById(\`appt-email-\${i}\`).value.trim();
        const selectedSlot = _apptState[i] && _apptState[i].selectedSlot;
        const paymentIntentId = _apptSecrets[i] ? _apptSecrets[i].split('_secret_')[0] : undefined;
        await fetch('/plugin/shoppe/${tenant.uuid}/purchase/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recoveryKey, productId: appt.productId, title: appt.title, slotDatetime: selectedSlot, contactInfo: { name, email }, paymentIntentId })
        });
        document.getElementById(\`appt-payment-\${i}\`).style.display = 'none';
        apptShowConfirm(i, selectedSlot);
      } catch (err) {
        payError.textContent = 'An unexpected error occurred.'; payError.style.display = 'block';
        payBtn.disabled = false; payLoading.style.display = 'none';
      }
    }

    function apptShowConfirm(i, slotStr) {
      const conf = document.getElementById(\`appt-confirm-\${i}\`);
      conf.style.display = 'block';
      document.getElementById(\`appt-confirm-slot-\${i}\`).textContent = apptFormatSlot(i, slotStr);
      conf.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

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

  // Allow Shoppere desktop/mobile app (tauri://localhost) to call our JSON API
  const SHOPPERE_ORIGINS = ['tauri://localhost', 'https://tauri.localhost'];
  app.use('/plugin/shoppe', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && SHOPPERE_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
    }
    next();
  });

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
  app.post('/plugin/shoppe/upload', upload.single('archive'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No archive uploaded' });
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = { sse: null, queue: [], done: false };
    uploadJobs.set(jobId, job);
    setTimeout(() => uploadJobs.delete(jobId), 15 * 60 * 1000); // clean up after 15 min

    res.json({ success: true, jobId });

    function emit(type, data) {
      job.queue.push({ type, data });
      if (job.sse) job.sse.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const zipPath = req.file.path;
    console.log('[shoppe] Processing archive:', req.file.originalname);
    processArchive(zipPath, emit)
      .then(result  => emit('complete', { success: true, ...result }))
      .catch(err    => { console.error('[shoppe] upload error:', err); emit('error', { message: err.message }); })
      .finally(() => {
        job.done = true;
        if (job.sse) { job.sse.end(); job.sse = null; }
        if (fs.existsSync(zipPath)) try { fs.unlinkSync(zipPath); } catch (e) {}
      });
  });

  app.get('/plugin/shoppe/upload/progress/:jobId', (req, res) => {
    const job = uploadJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown job' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Replay buffered events for late-connecting clients.
    for (const evt of job.queue) {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    }

    if (job.done) { res.end(); return; }

    job.sse = res;
    req.on('close', () => { if (job.sse === res) job.sse = null; });
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

      const imageUrl = product.image ? `${sanoraUrl}/images/${product.image}` : '';
      const ebookUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}/download/${encodeURIComponent(title)}`;
      const shoppeUrl = `${wikiOrigin}/plugin/shoppe/${tenant.uuid}`;
      const payees = tenant.addieKeys
        ? JSON.stringify([{ pubKey: tenant.addieKeys.pubKey, amount: product.price || 0 }])
        : '[]';

      // Forward Shoppere credentials if present in the query string
      const buyerPubKey    = req.query.pubKey    || '';
      const buyerTimestamp = req.query.timestamp || '';
      const buyerSignature = req.query.signature || '';

      // When a pubKey credential is present, the download page can verify access via
      // a signed request — embed the credentials so the template can redirect there.
      const ebookUrlWithCreds = buyerPubKey
        ? `${ebookUrl}?pubKey=${encodeURIComponent(buyerPubKey)}&timestamp=${encodeURIComponent(buyerTimestamp)}&signature=${encodeURIComponent(buyerSignature)}`
        : ebookUrl;

      const html = fillTemplate(templateHtml, {
        title:           product.title || title,
        description:     product.description || '',
        image:           `"${imageUrl}"`,
        amount:          String(product.price || 0),
        formattedAmount: ((product.price || 0) / 100).toFixed(2),
        productId:       product.productId || '',
        buyerPubKey,
        buyerTimestamp,
        buyerSignature,
        sanoraUrl,
        allyabaseOrigin: wikiOrigin,
        ebookUrl:        ebookUrlWithCreds,
        shoppeUrl,
        payees,
        tenantUuid:      tenant.uuid,
        keywords:        extractKeywords(product),
        shopName:        tenant.name || '',
        shopName_json:   JSON.stringify(tenant.name || ''),
        title_json:      JSON.stringify(product.title || title),
        category:        product.category || 'book',
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
      const imageUrl = product.image ? `${getSanoraPublicUrl(req)}/images/${product.image}` : '';

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
        keywords:        extractKeywords(product),
        title_json:      JSON.stringify(product.title || title),
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
      const imageUrl = product.image ? `${getSanoraPublicUrl(req)}/images/${product.image}` : '';
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
        keywords:        extractKeywords(product),
        title_json:      JSON.stringify(product.title || title),
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
      const timestamp = Date.now().toString();
      const message   = timestamp + tenant.addieKeys.uuid;
      const signature = signMessage(message, addieKeys.privateKey);

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
          image:              product.image ? `${getSanoraPublicUrl(req)}/images/${product.image}` : null,
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

      const { recoveryKey, pubKey, timestamp: buyerTimestamp, signature: buyerSignature, productId, title, slotDatetime, payees: clientPayees,
              affiliatePubKey } = req.body;
      if (!productId) return res.status(400).json({ error: 'productId required' });
      if (!pubKey && !recoveryKey && !title) return res.status(400).json({ error: 'pubKey (with timestamp+signature) or recoveryKey required' });

      // Shoppere app path: verify the buyer's Sessionless signature before proceeding
      if (pubKey) {
        const sigErr = verifyBuyerSignature(pubKey, buyerTimestamp, buyerSignature);
        if (sigErr) return res.status(401).json({ error: sigErr });
      }

      const sanoraUrlInternal = getSanoraUrl();

      // Get product price
      const productsResp = await fetch(`${sanoraUrlInternal}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = (title && products[title]) || Object.values(products).find(p => p.productId === productId);
      const amount = product?.price || 0;

      let buyer;
      let orderRef;

      if (pubKey && product?.category === 'subscription') {
        // Shoppere: subscription — check active status by pubKey orderKey
        const alreadyPurchased = await hasPurchasedByPubKey(tenant, pubKey, productId);
        if (alreadyPurchased) {
          return res.json({ alreadySubscribed: true });
        }
        buyer = await getOrCreateBuyerAddieUserByPubKey(pubKey, productId);
      } else if (pubKey && slotDatetime) {
        // Shoppere: appointment — verify slot availability
        const schedule = await getAppointmentSchedule(tenant, product);
        if (schedule) {
          const bookedSlots = await getBookedSlots(tenant, productId);
          if (bookedSlots.includes(slotDatetime)) {
            return res.status(409).json({ error: 'That time slot is no longer available.' });
          }
        }
        buyer = await getOrCreateBuyerAddieUserByPubKey(pubKey, productId);
      } else if (pubKey) {
        // Shoppere: digital product — check if already purchased by pubKey
        const alreadyPurchased = await hasPurchasedByPubKey(tenant, pubKey, productId);
        if (alreadyPurchased) return res.json({ purchased: true });
        buyer = await getOrCreateBuyerAddieUserByPubKey(pubKey, productId);
      } else if (recoveryKey && product?.category === 'subscription') {
        // Legacy recovery key: subscription flow — check if already actively subscribed
        const status = await getSubscriptionStatus(tenant, productId, recoveryKey);
        if (status.active) {
          return res.json({ alreadySubscribed: true, renewsAt: status.renewsAt, daysLeft: status.daysLeft });
        }
        buyer = await getOrCreateBuyerAddieUser(recoveryKey, productId);
      } else if (recoveryKey && slotDatetime) {
        // Legacy recovery key: appointment flow — verify slot is still open before charging
        const schedule = await getAppointmentSchedule(tenant, product);
        if (schedule) {
          const bookedSlots = await getBookedSlots(tenant, productId);
          if (bookedSlots.includes(slotDatetime)) {
            return res.status(409).json({ error: 'That time slot is no longer available.' });
          }
        }
        buyer = await getOrCreateBuyerAddieUser(recoveryKey, productId);
      } else if (recoveryKey) {
        // Legacy recovery key: digital product flow — check if already purchased
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

      // Build payees for Addie.
      // If an affiliate pubKey is present (NFC proximity charge / referral link flow),
      // split: affiliate gets affiliateCommission %, tenant gets the rest.
      // Addie enforces its own signing — we just pass pubKeys as payees.
      let payees;
      if (affiliatePubKey) {
        const affiliateCommission = tenant.affiliateCommission ?? 0.10;
        const affiliateAmount = Math.floor(amount * affiliateCommission);
        const tenantAmount = amount - affiliateAmount;

        const affiliateAddieUser = await getOrCreateAffiliateAddieUser(affiliatePubKey);
        payees = tenant.addieKeys
          ? [
              { pubKey: tenant.addieKeys.pubKey, amount: tenantAmount },
              { pubKey: affiliateAddieUser.pubKey, amount: affiliateAmount }
            ]
          : [{ pubKey: affiliateAddieUser.pubKey, amount }];
      } else {
        // Standard flow — optionally accept client-supplied payees capped at 5% each
        const maxPayeeAmount = amount * 0.05;
        const validatedPayees = Array.isArray(clientPayees)
          ? clientPayees.filter(p => {
              if (p.percent != null && p.percent > 5) return false;
              if (p.amount  != null && p.amount  > maxPayeeAmount) return false;
              return true;
            })
          : [];
        payees = validatedPayees.length > 0
          ? validatedPayees
          : tenant.addieKeys ? [{ pubKey: tenant.addieKeys.pubKey, amount }] : [];
      }
      const buyerKeys = { pubKey: buyer.pubKey, privateKey: buyer.privateKey };
      const intentTimestamp = Date.now().toString();
      const intentSignature = signMessage(intentTimestamp + buyer.uuid + amount + 'USD', buyerKeys.privateKey);
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

      const { recoveryKey, pubKey, timestamp: buyerTimestamp, signature: buyerSignature, productId, orderRef, address, title, amount, slotDatetime, contactInfo, type, renewalDays, paymentIntentId } = req.body;
      const sanoraUrlInternal = getSanoraUrl();

      // Verify Shoppere signature if pubKey path
      if (pubKey) {
        const sigErr = verifyBuyerSignature(pubKey, buyerTimestamp, buyerSignature);
        if (sigErr) return res.status(401).json({ error: sigErr });
      }

      // Fire transfer after successful payment — fire-and-forget, does not affect response
      function triggerTransfer() {
        if (!paymentIntentId || !tenant.addieKeys) return;
        fetch(`${getAddieUrl()}/payment/${encodeURIComponent(paymentIntentId)}/process-transfers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).catch(err => console.warn('[shoppe] transfer trigger failed:', err.message));
      }

      // ── Shoppere app (pubKey) paths ───────────────────────────────────────

      if (pubKey && type === 'subscription') {
        // Shoppere subscription: orderKey = sha256(pubKey + productId)
        const orderKey = crypto.createHash('sha256').update(pubKey + productId).digest('hex');
        const tenantKeys = tenant.keys;
        const ts  = Date.now().toString();
        const sig = signMessage(ts + tenant.uuid, tenantKeys.privateKey);
        const order = { orderKey, pubKey, paidAt: Date.now(), title, productId, renewalDays: renewalDays || 30, status: 'active' };
        await fetch(`${sanoraUrlInternal}/user/${tenant.uuid}/orders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: ts, signature: sig, order })
        });
        triggerTransfer();
        return res.json({ success: true });
      }

      if (pubKey && slotDatetime) {
        // Shoppere appointment: record booking with pubKey credential
        const orderKey = crypto.createHash('sha256').update(pubKey + productId).digest('hex');
        const tenantKeys = tenant.keys;
        const bookingTimestamp = Date.now().toString();
        const bookingSignature = signMessage(bookingTimestamp + tenant.uuid, tenantKeys.privateKey);
        const order = {
          orderKey,
          pubKey,
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

      if (pubKey) {
        // Shoppere digital product: record purchase with pubKey as credential
        const orderKey = crypto.createHash('sha256').update(pubKey + productId).digest('hex');
        const tenantKeys = tenant.keys;
        const ts  = Date.now().toString();
        const sig = signMessage(ts + tenant.uuid, tenantKeys.privateKey);
        const order = { orderKey, pubKey, paidAt: Date.now(), title, productId, status: 'purchased' };
        await fetch(`${sanoraUrlInternal}/user/${tenant.uuid}/orders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: ts, signature: sig, order })
        });
        triggerTransfer();
        // Return a download URL for digital goods so the Shoppere app can open the content
        const sanoraUrl = getSanoraUrl();
        const products = await fetchWithRetry(`${sanoraUrl}/products/${tenant.uuid}`).then(r => r.ok ? r.json() : {});
        const product = Object.values(products).find(p => p.uuid === productId || p.title === title);
        let downloadUrl = null;
        if (product && ['book', 'post', 'video'].includes(product.category)) {
          downloadUrl = `https://${req.get('host')}/plugin/shoppe/${tenant.uuid}/download/${encodeURIComponent(product.title)}`;
        }
        return res.json({ success: true, downloadUrl });
      }

      // ── Legacy recovery key paths ─────────────────────────────────────────

      if (recoveryKey && type === 'subscription') {
        // Subscription payment — record an order with a hashed subscriber key + payment timestamp.
        // The recovery key itself is never stored; orderKey = sha256(recoveryKey + productId).
        const orderKey = crypto.createHash('sha256').update(recoveryKey + productId).digest('hex');
        const tenantKeys = tenant.keys;
        const ts  = Date.now().toString();
        const sig = signMessage(ts + tenant.uuid, tenantKeys.privateKey);
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
        const bookingTimestamp = Date.now().toString();
        const bookingSignature = signMessage(bookingTimestamp + tenant.uuid, tenantKeys.privateKey);
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
        const orderTimestamp = Date.now().toString();
        const orderSignature = signMessage(orderTimestamp + tenant.uuid, tenantKeys.privateKey);
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

  // ── Stripe Terminal routes ─────────────────────────────────────────────────

  app.get('/plugin/shoppe/:identifier/terminal/connection-token', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });
      const stripe = getStripe();
      const token = await stripe.terminal.connectionTokens.create();
      res.json({ secret: token.secret });
    } catch (err) {
      const status = err.message.includes('STRIPE_SECRET_KEY') ? 503 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/plugin/shoppe/:identifier/terminal/payment-intent', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { amount, currency = 'usd', productId, productTitle, affiliatePubKey } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' });

      const stripe = getStripe();
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency,
        payment_method_types: ['card_present'],
        capture_method: 'manual',
        description: productTitle || 'Shoppere charge',
        metadata: {
          shopId:          tenant.uuid,
          productId:       productId       || '',
          affiliatePubKey: affiliatePubKey || '',
        },
      });

      res.json({ paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret });
    } catch (err) {
      console.error('[shoppe] terminal payment-intent error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/plugin/shoppe/:identifier/terminal/capture', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { paymentIntentId, productId, productTitle, buyerInfo } = req.body;
      if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

      const stripe = getStripe();

      // Capture the card-present payment
      const pi = await stripe.paymentIntents.capture(paymentIntentId);
      const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
      const amount   = pi.amount_received || pi.amount;

      // Retrieve affiliate info from PI metadata
      const affiliatePubKey = pi.metadata?.affiliatePubKey || '';

      // Split funds via Stripe Transfers if Stripe account IDs are available
      const affiliateCommission = tenant.affiliateCommission ?? 0.10;
      const affiliateAmount     = Math.floor(amount * affiliateCommission);
      const tenantAmount        = amount - affiliateAmount;

      const transferBase = chargeId ? { source_transaction: chargeId, transfer_group: paymentIntentId } : { transfer_group: paymentIntentId };

      if (tenant.stripeAccountId && tenantAmount > 0) {
        stripe.transfers.create({ amount: tenantAmount, currency: 'usd', destination: tenant.stripeAccountId, ...transferBase })
          .catch(e => console.warn('[shoppe] tenant transfer failed:', e.message));
      }

      if (affiliatePubKey) {
        const affiliates = loadAffiliates();
        const aff = affiliates[affiliatePubKey];
        if (aff?.stripeAccountId && affiliateAmount > 0) {
          stripe.transfers.create({ amount: affiliateAmount, currency: 'usd', destination: aff.stripeAccountId, ...transferBase })
            .catch(e => console.warn('[shoppe] affiliate transfer failed:', e.message));
        }
      }

      // Record order in Sanora (fire-and-forget)
      if (productId && tenant.keys) {
        const ts = Date.now().toString();
        const orderSig = signMessage(ts + tenant.uuid).catch(() => null, tenant.keys.privateKey);
        if (orderSig) {
          const order = {
            productId,
            title: productTitle || productId,
            paidAt: ts,
            paymentIntentId,
            channel: 'terminal',
            buyerInfo: buyerInfo || null,
          };
          fetch(`${getSanoraUrl()}/user/orders`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timestamp: ts, order, signature: orderSig }),
          }).catch(() => {});
        }
      }

      res.json({ success: true, amount, affiliateAmount, tenantAmount });
    } catch (err) {
      console.error('[shoppe] terminal capture error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Called after Stripe Connect onboarding to link a Stripe account to the tenant or affiliate.
  // body: { type: 'tenant' | 'affiliate', stripeAccountId, pubKey? (for affiliate) }
  app.post('/plugin/shoppe/:identifier/terminal/stripe-account', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { type, stripeAccountId, pubKey } = req.body;
      if (!stripeAccountId) return res.status(400).json({ error: 'stripeAccountId required' });

      if (type === 'tenant') {
        const tenants = loadTenants();
        tenants[tenant.uuid].stripeAccountId = stripeAccountId;
        saveTenants(tenants);
        return res.json({ ok: true });
      }

      if (type === 'affiliate' && pubKey) {
        const affiliates = loadAffiliates();
        if (!affiliates[pubKey]) return res.status(404).json({ error: 'Affiliate not found — they must initiate a charge first' });
        affiliates[pubKey].stripeAccountId = stripeAccountId;
        saveAffiliates(affiliates);
        return res.json({ ok: true });
      }

      res.status(400).json({ error: 'type must be tenant or affiliate (with pubKey)' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ebook download page (reached after successful payment + hash creation)
  app.get('/plugin/shoppe/:identifier/download/:title', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');

      const title = decodeURIComponent(req.params.title);
      const { pubKey, timestamp: buyerTimestamp, signature: buyerSignature } = req.query;
      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      const products = await productsResp.json();
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).send('<h1>Book not found</h1>');

      // Verify access credential — either a valid Shoppere pubKey signature
      // with a matching purchase record, or the legacy recovery hash (checked client-side
      // in the download template itself via the existing hash endpoints).
      if (pubKey) {
        const sigErr = verifyBuyerSignature(pubKey, buyerTimestamp, buyerSignature);
        if (sigErr) return res.status(401).send(`<h1>Access denied</h1><p>${sigErr}</p>`);
        const purchased = await hasPurchasedByPubKey(tenant, pubKey, product.productId);
        if (!purchased) return res.status(403).send('<h1>No purchase found for this key</h1>');
      }

      const sanoraPublicUrl = getSanoraPublicUrl(req);
      const imageUrl = product.image ? `${sanoraPublicUrl}/images/${product.image}` : '';

      // Map artifact UUIDs to download paths by extension
      let epubPath = '', pdfPath = '', mobiPath = '';
      (product.artifacts || []).forEach(artifact => {
        if (artifact.includes('epub')) epubPath = `${sanoraPublicUrl}/artifacts/${artifact}`;
        if (artifact.includes('pdf'))  pdfPath  = `${sanoraPublicUrl}/artifacts/${artifact}`;
        if (artifact.includes('mobi')) mobiPath = `${sanoraPublicUrl}/artifacts/${artifact}`;
      });

      const html = fillTemplate(EBOOK_DOWNLOAD_TMPL, {
        title:       product.title || title,
        description: product.description || '',
        image:       imageUrl,
        productId:   product.productId || '',
        pubKey:      pubKey || '',
        signature:   buyerSignature || '',
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
      const product = products[title] || Object.values(products).find(p => p.title === title);
      if (!product) return res.status(404).send('<h1>Post not found</h1>');

      // Find the markdown artifact (UUID-named .md file)
      const mdArtifact = (product.artifacts || []).find(a => a.includes('.md'));
      let mdContent = '';
      if (mdArtifact) {
        const artResp = await fetch(`${getSanoraUrl()}/artifacts/${mdArtifact}`);
        mdContent = await artResp.text();
      }

      const fm = parseFrontMatter(mdContent);
      const postTitle = fm.title || title;
      const postDate  = fm.date || '';
      const imageUrl  = product.image ? `${getSanoraPublicUrl(req)}/images/${product.image}` : null;

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
      const signature = signMessage(timestamp + pubKey, privateKey);

      const uploadUrl = `${lucilleBase}/user/${lucilleUuid}/video/${encodeURIComponent(title)}/file`;
      res.json({ uploadUrl, timestamp, signature });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shoppere app: purchases for a pubKey across all products on this shoppe.
  // Auth: pubKey + timestamp + signature (Sessionless, 5-min TTL)
  // Returns the subset of Sanora orders whose orderKey === sha256(pubKey + productId).
  app.get('/plugin/shoppe/:identifier/purchases', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });

      const { pubKey, timestamp, signature } = req.query;
      const sigErr = verifyBuyerSignature(pubKey, timestamp, signature);
      if (sigErr) return res.status(401).json({ error: sigErr });

      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetch(`${sanoraUrl}/products/${tenant.uuid}`);
      if (!productsResp.ok) return res.status(502).json({ error: 'Could not reach Sanora' });
      const products = await productsResp.json();

      sessionless.getKeys = () => tenant.keys;
      const purchases = [];

      for (const [, product] of Object.entries(products)) {
        if (!product.productId) continue;
        const orderKey = crypto.createHash('sha256').update(pubKey + product.productId).digest('hex');
        const ts  = Date.now().toString();
        const sig = await sessionless.sign(ts + tenant.uuid);
        try {
          const ordersResp = await fetch(
            `${sanoraUrl}/user/${tenant.uuid}/orders/${encodeURIComponent(product.productId)}` +
            `?timestamp=${ts}&signature=${encodeURIComponent(sig)}`
          );
          const json = await ordersResp.json();
          const match = (json.orders || []).find(o => o.orderKey === orderKey);
          if (match) {
            purchases.push({
              productId:    product.productId,
              title:        product.title,
              category:     product.category,
              image:        product.image ? `${getSanoraPublicUrl(req)}/images/${product.image}` : null,
              price:        product.price,
              paidAt:       match.paidAt,
              status:       match.status,
              slot:         match.slot || null,
              renewalDays:  match.renewalDays || null,
              downloadUrl:  ['book', 'post', 'video'].includes(product.category)
                ? `${reqProto(req)}://${req.get('host')}/plugin/shoppe/${tenant.uuid}/download/${encodeURIComponent(product.title)}`
                : null,
            });
          }
        } catch { /* skip products whose orders can't be fetched */ }
      }

      res.json({ success: true, shopName: tenant.name, purchases });
    } catch (err) {
      console.error('[shoppe] purchases error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Goods JSON (public)
  app.get('/plugin/shoppe/:identifier/goods', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });
      const goods = await getShoppeGoods(tenant, getSanoraPublicUrl(req));
      const cat = req.query.category;
      res.json({ success: true, goods: (cat && goods[cat]) ? goods[cat] : goods });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Music feed — builds { albums, tracks } from Sanora products directly
  app.get('/plugin/shoppe/:identifier/music/feed', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).json({ error: 'Shoppe not found' });
      const sanoraUrl = getSanoraUrl();
      const productsResp = await fetchWithRetry(`${sanoraUrl}/products/${tenant.uuid}`, { timeout: 15000 });
      if (!productsResp.ok) return res.status(502).json({ error: 'Could not load products' });
      const products = await productsResp.json();

      const albums = [];
      const tracks = [];
      for (const [key, product] of Object.entries(products)) {
        if (product.category !== 'music') continue;
        const cover = product.image ? `${getSanoraPublicUrl(req)}/images/${product.image}` : null;
        const artifacts = product.artifacts || [];
        if (artifacts.length > 1) {
          albums.push({
            name: product.title || key,
            cover,
            description: product.description || '',
            tracks: artifacts.map((a, i) => ({
              number: i + 1,
              title: `Track ${i + 1}`,
              src: `${sanoraUrl}/artifacts/${a}`,
              type: 'audio/mpeg'
            }))
          });
        } else if (artifacts.length === 1) {
          tracks.push({
            title: product.title || key,
            src: `${sanoraUrl}/artifacts/${artifacts[0]}`,
            cover,
            description: product.description || ''
          });
        }
      }
      res.json({ albums, tracks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shoppe HTML page (public)
  app.get('/plugin/shoppe/:identifier', async (req, res) => {
    try {
      const tenant = getTenantByIdentifier(req.params.identifier);
      if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');
      const goods = await getShoppeGoods(tenant, getSanoraPublicUrl(req));

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
