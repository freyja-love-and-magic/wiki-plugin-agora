(function() {
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function getSanoraUrl() {
  const config = loadConfig();
  if (config.sanoraUrl) return config.sanoraUrl.replace(/\/$/, '');
  return `http://localhost:${process.env.SANORA_PORT || 7243}`;
}

function getAddieUrl() {
  try { return new URL(getSanoraUrl()).origin + '/plugin/allyabase/addie'; } catch { /* fall through */ }
  return `http://localhost:${process.env.ADDIE_PORT || 3005}`;
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

  const tenant = {
    uuid: sanoraUser.uuid,
    emojicode,
    name: name || 'Unnamed Shoppe',
    keys,
    sanoraUser,
    addieKeys,
    createdAt: Date.now()
  };

  tenants[sanoraUser.uuid] = tenant;
  saveTenants(tenants);

  console.log(`[shoppe] Registered tenant: "${name}" ${emojicode} (${sanoraUser.uuid})`);
  return { uuid: sanoraUser.uuid, emojicode, name: tenant.name };
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
// ARCHIVE PROCESSING
// ============================================================

async function processArchive(zipPath) {
  const zip = new AdmZip(zipPath);
  const tmpDir = path.join(TMP_DIR, `extract-${Date.now()}`);
  zip.extractAllTo(tmpDir, true);

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

    const results = { books: [], music: [], posts: [], albums: [], products: [], appointments: [], subscriptions: [], warnings: [] };

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

          await sanoraCreateProduct(tenant, title, 'book', description, price, 0, 'book');

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
            await sanoraCreateProduct(tenant, albumTitle, 'music', description, price, 0, 'music,album');
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
            await sanoraCreateProduct(tenant, title, 'music', description, price, 0, 'music,track');
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
            await sanoraCreateProduct(tenant, seriesTitle, 'post-series', description, 0, 0, `post,series,order:${order}`);

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
                `post,blog,series:${seriesTitle},part:${partIndex + 1},order:${order}`);

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

            await sanoraCreateProduct(tenant, title, 'post', description, 0, 0, `post,blog,order:${order}`);
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

          await sanoraCreateProduct(tenant, title, 'product', description, price, shipping, `product,physical,order:${order}`);

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

          await sanoraCreateProduct(tenant, title, 'subscription', description, price, 0, 'subscription');

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

          await sanoraCreateProduct(tenant, title, 'appointment', description, price, 0, 'appointment');

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
  const resp = await fetch(`${getSanoraUrl()}/products/${tenant.uuid}`);
  const products = await resp.json();

  const goods = { books: [], music: [], posts: [], albums: [], products: [], appointments: [], subscriptions: [] };

  for (const [title, product] of Object.entries(products)) {
    const isPost = product.category === 'post' || product.category === 'post-series';
    const item = {
      title: product.title || title,
      description: product.description || '',
      price: product.price || 0,
      shipping: product.shipping || 0,
      image: product.image ? `${getSanoraUrl()}/images/${product.image}` : null,
      url: isPost
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
                : `${getSanoraUrl()}/products/${tenant.uuid}/${encodeURIComponent(title)}`
    };
    const CATEGORY_BUCKET = { book: 'books', music: 'music', post: 'posts', 'post-series': 'posts', album: 'albums', product: 'products', appointment: 'appointments', subscription: 'subscriptions' };
    const bucket = goods[CATEGORY_BUCKET[product.category]];
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

const CATEGORY_EMOJI = { book: '📚', music: '🎵', post: '📝', album: '🖼️', product: '📦', appointment: '📅', subscription: '🎁' };

function renderCards(items, category) {
  if (items.length === 0) {
    return '<p class="empty">Nothing here yet.</p>';
  }
  return items.map(item => {
    const imgHtml = item.image
      ? `<div class="card-img"><img src="${item.image}" alt="" loading="lazy"></div>`
      : `<div class="card-img-placeholder">${CATEGORY_EMOJI[category] || '🎁'}</div>`;
    const priceHtml = (item.price > 0 || category === 'product')
      ? `<div class="price">$${(item.price / 100).toFixed(2)}${item.shipping ? ` <span class="shipping">+ $${(item.shipping / 100).toFixed(2)} shipping</span>` : ''}</div>`
      : '';
    return `
      <div class="card" onclick="window.open('${item.url}','_blank')">
        ${imgHtml}
        <div class="card-body">
          <div class="card-title">${item.title}</div>
          ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}
          ${priceHtml}
        </div>
      </div>`;
  }).join('');
}

function generateShoppeHTML(tenant, goods) {
  const total = Object.values(goods).flat().length;
  const tabs = [
    { id: 'all',          label: 'All',              count: total,                       always: true },
    { id: 'books',        label: '📚 Books',          count: goods.books.length },
    { id: 'music',        label: '🎵 Music',          count: goods.music.length },
    { id: 'posts',        label: '📝 Posts',          count: goods.posts.length },
    { id: 'albums',       label: '🖼️ Albums',         count: goods.albums.length },
    { id: 'products',     label: '📦 Products',       count: goods.products.length },
    { id: 'appointments',  label: '📅 Appointments',  count: goods.appointments.length },
    { id: 'subscriptions', label: '🎁 Support',        count: goods.subscriptions.length }
  ]
    .filter(t => t.always || t.count > 0)
    .map((t, i) => `<div class="tab${i === 0 ? ' active' : ''}" onclick="show('${t.id}',this)">${t.label} <span class="badge">${t.count}</span></div>`)
    .join('');

  const allItems = [...goods.books, ...goods.music, ...goods.posts, ...goods.albums, ...goods.products, ...goods.appointments, ...goods.subscriptions];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tenant.name}</title>
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
    <div id="appointments" class="section"><div class="grid">${renderCards(goods.appointments, 'appointment')}</div></div>
    <div id="subscriptions" class="section"><div class="grid">${renderCards(goods.subscriptions, 'subscription')}</div></div>
    <div style="text-align:center;padding:24px 0 8px;font-size:14px;color:#888;">
      Already a supporter? <a href="/plugin/shoppe/${tenant.uuid}/membership" style="color:#0066cc;">Access your membership →</a>
    </div>
  </main>
  <script>
    function show(id, tab) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      tab.classList.add('active');
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
      const tenant = await registerTenant(req.body.name);
      res.json({ success: true, tenant });
    } catch (err) {
      console.error('[shoppe] register error:', err);
      res.status(500).json({ success: false, error: err.message });
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
    res.json({ success: true, sanoraUrl: config.sanoraUrl || '' });
  });

  // Save config (owner only)
  app.post('/plugin/shoppe/config', owner, (req, res) => {
    const { sanoraUrl, addieUrl } = req.body;
    if (!sanoraUrl) return res.status(400).json({ success: false, error: 'sanoraUrl required' });
    const config = loadConfig();
    config.sanoraUrl = sanoraUrl;
    if (addieUrl) config.addieUrl = addieUrl;
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
      const wikiOrigin = `${req.protocol}://${req.get('host')}`;
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
        tenantUuid:      tenant.uuid
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
      const wikiOrigin = `${req.protocol}://${req.get('host')}`;
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
        tenantUuid:      tenant.uuid
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
      const wikiOrigin = `${req.protocol}://${req.get('host')}`;
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
        tenantUuid:      tenant.uuid
      });

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('[shoppe] subscribe page error:', err);
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // Membership portal page
  app.get('/plugin/shoppe/:identifier/membership', (req, res) => {
    const tenant = getTenantByIdentifier(req.params.identifier);
    if (!tenant) return res.status(404).send('<h1>Shoppe not found</h1>');
    const wikiOrigin = `${req.protocol}://${req.get('host')}`;
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
      const wikiOrigin = `${req.protocol}://${req.get('host')}`;
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

      const { recoveryKey, productId, title, slotDatetime } = req.body;
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
      const payees = tenant.addieKeys ? [{ pubKey: tenant.addieKeys.pubKey, amount }] : [];
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

      const { recoveryKey, productId, orderRef, address, title, amount, slotDatetime, contactInfo, type, renewalDays } = req.body;
      const sanoraUrlInternal = getSanoraUrl();

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
        return res.json({ success: true });
      }

      if (recoveryKey) {
        // Digital product — create recovery hash so buyer can re-download
        const recoveryHash = recoveryKey + productId;
        const createResp = await fetch(`${sanoraUrlInternal}/user/create-hash/${encodeURIComponent(recoveryHash)}/product/${encodeURIComponent(productId)}`);
        const createJson = await createResp.json();
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
      res.set('Content-Type', 'text/html');
      res.send(generateShoppeHTML(tenant, goods));
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
