(function() {
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const AdmZip = require('adm-zip');
const sessionless = require('sessionless-node');

const SHOPPE_BASE_EMOJI = process.env.SHOPPE_BASE_EMOJI || '🛍️🎨🎁';

const DATA_DIR     = path.join(process.env.HOME || '/root', '.shoppe');
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
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

  const tenant = {
    uuid: sanoraUser.uuid,
    emojicode,
    name: name || 'Unnamed Shoppe',
    keys,
    sanoraUser,
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

    const results = { books: [], music: [], posts: [], albums: [], products: [], warnings: [] };

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

  const goods = { books: [], music: [], posts: [], albums: [], products: [] };

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
        : `${getSanoraUrl()}/products/${tenant.uuid}/${encodeURIComponent(title)}`
    };
    const CATEGORY_BUCKET = { book: 'books', music: 'music', post: 'posts', 'post-series': 'posts', album: 'albums', product: 'products' };
    const bucket = goods[CATEGORY_BUCKET[product.category]];
    if (bucket) bucket.push(item);
  }

  return goods;
}

const CATEGORY_EMOJI = { book: '📚', music: '🎵', post: '📝', album: '🖼️', product: '📦' };

function renderCards(items, category) {
  if (items.length === 0) {
    return '<p class="empty">Nothing here yet.</p>';
  }
  return items.map(item => {
    const imgHtml = item.image
      ? `<div class="card-img"><img src="${item.image}" alt="" loading="lazy"></div>`
      : `<div class="card-img-placeholder">${CATEGORY_EMOJI[category] || '🎁'}</div>`;
    const priceHtml = (item.price > 0 || category === 'product')
      ? `<div class="price">$${item.price}${item.shipping ? ` <span class="shipping">+ $${item.shipping} shipping</span>` : ''}</div>`
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
    { id: 'all', label: 'All', count: total, always: true },
    { id: 'books',    label: '📚 Books',    count: goods.books.length },
    { id: 'music',    label: '🎵 Music',    count: goods.music.length },
    { id: 'posts',    label: '📝 Posts',    count: goods.posts.length },
    { id: 'albums',   label: '🖼️ Albums',   count: goods.albums.length },
    { id: 'products', label: '📦 Products', count: goods.products.length }
  ]
    .filter(t => t.always || t.count > 0)
    .map((t, i) => `<div class="tab${i === 0 ? ' active' : ''}" onclick="show('${t.id}',this)">${t.label} <span class="badge">${t.count}</span></div>`)
    .join('');

  const allItems = [...goods.books, ...goods.music, ...goods.posts, ...goods.albums, ...goods.products];

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
    const { sanoraUrl } = req.body;
    if (!sanoraUrl) return res.status(400).json({ success: false, error: 'sanoraUrl required' });
    const config = loadConfig();
    config.sanoraUrl = sanoraUrl;
    saveConfig(config);
    console.log('[shoppe] Sanora URL set to:', sanoraUrl);
    res.json({ success: true });
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
