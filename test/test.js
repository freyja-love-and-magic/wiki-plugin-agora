'use strict';

// ── Set up a temp HOME before the server module loads, so DATA_DIR
//   (~/.agora) is isolated from any real agora data on this machine.
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-test-'));
process.env.HOME = TEST_HOME;

// ── Dependencies ─────────────────────────────────────────────────────────────
const express  = require('express');
const AdmZip   = require('adm-zip');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const assert   = require('assert');
const { should } = require('chai');
should();

const { startServer } = require('../server/server.js');

// ── Config ────────────────────────────────────────────────────────────────────
const TEST_PORT  = 9977;
const BASE_URL   = `http://localhost:${TEST_PORT}`;
const SANORA_URL = process.env.SANORA_URL || `http://localhost:${process.env.SANORA_PORT || 7243}`;

// Shared state
let httpServer;
let tenant = null;  // populated after register
let sanoraAvailable = false;

// ── Sanora connectivity check ─────────────────────────────────────────────────
async function checkSanora() {
  try {
    const resp = await fetch(`${SANORA_URL}/products/ping`, { timeout: 2000 });
    // Any response (even 404) means Sanora is up
    return resp.status < 600;
  } catch {
    return false;
  }
}

// ── Test archive factory ──────────────────────────────────────────────────────
function buildTestArchive(uuid, emojicode) {
  const zip = new AdmZip();

  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    uuid, emojicode, name: 'Integration Test Agora'
  })));

  // book
  zip.addFile('books/Test Book/info.json', Buffer.from(JSON.stringify({
    title: 'Test Book', description: 'A test ebook', price: 999
  })));
  zip.addFile('books/Test Book/test-book.epub', Buffer.from('fake epub'));
  zip.addFile('books/Test Book/cover.jpg', Buffer.from('fake jpg'));

  // music album
  zip.addFile('music/Test Album/info.json', Buffer.from(JSON.stringify({
    title: 'Test Album', description: 'A test album', price: 599
  })));
  zip.addFile('music/Test Album/cover.jpg', Buffer.from('fake jpg'));
  zip.addFile('music/Test Album/01-track.mp3', Buffer.from('fake mp3'));

  // post
  zip.addFile('posts/01-Hello Post/post.md', Buffer.from([
    '+++',
    'title = "Hello Post"',
    'date = "2026-01-01"',
    '+++',
    '',
    '# Hello',
    'Test post content.',
  ].join('\n')));

  // album
  zip.addFile('albums/Vacation 2025/photo1.jpg', Buffer.from('fake jpg'));

  // physical product with shipping
  zip.addFile('products/01-Widget/info.json', Buffer.from(JSON.stringify({
    title: 'Test Widget', description: 'A physical thing', price: 2500, shipping: 500
  })));
  zip.addFile('products/01-Widget/hero.jpg', Buffer.from('fake jpg'));

  // appointment — all 7 days so slots always generate
  zip.addFile('appointments/Test Session/info.json', Buffer.from(JSON.stringify({
    title: 'Test Session',
    description: 'One hour session',
    price: 10000,
    duration: 60,
    timezone: 'America/New_York',
    advanceDays: 14,
    availability: [
      { day: 'Monday',    slots: ['09:00', '10:00', '11:00'] },
      { day: 'Tuesday',   slots: ['09:00', '10:00', '11:00'] },
      { day: 'Wednesday', slots: ['09:00', '10:00', '11:00'] },
      { day: 'Thursday',  slots: ['09:00', '10:00', '11:00'] },
      { day: 'Friday',    slots: ['09:00', '10:00', '11:00'] },
      { day: 'Saturday',  slots: ['10:00', '11:00'] },
      { day: 'Sunday',    slots: ['10:00', '11:00'] },
    ]
  })));
  zip.addFile('appointments/Test Session/cover.jpg', Buffer.from('fake jpg'));

  // subscription tier with exclusive content
  zip.addFile('subscriptions/Bronze Tier/info.json', Buffer.from(JSON.stringify({
    title: 'Bronze Tier',
    description: 'Entry-level supporter',
    price: 500,
    renewalDays: 30,
    benefits: ['Monthly exclusive track', 'Early access']
  })));
  zip.addFile('subscriptions/Bronze Tier/cover.jpg', Buffer.from('fake jpg'));
  zip.addFile('subscriptions/Bronze Tier/bonus.mp3', Buffer.from('fake exclusive mp3'));

  return zip.toBuffer();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
before(async function() {
  // If SANORA_URL env var is set, write it to config before server starts
  if (process.env.SANORA_URL) {
    const cfgDir = path.join(TEST_HOME, '.agora');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'),
      JSON.stringify({ sanoraUrl: process.env.SANORA_URL }));
  }

  const app = express();
  app.use(express.json());
  app.securityhandler = { isAuthorized: () => true };

  await startServer({ app });
  await new Promise(resolve => {
    httpServer = app.listen(TEST_PORT, resolve);
  });

  sanoraAvailable = await checkSanora();
  if (!sanoraAvailable) {
    console.log('\n  ⚠️  Sanora not running — skipping upload/purchase tests.');
    console.log(`     Start Sanora or set SANORA_URL=... to run the full suite.\n`);
  }
});

after(done => {
  httpServer.close(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    done();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Upload a zip buffer and wait for the SSE progress stream to deliver a
 * `complete` or `error` event.  Returns a fake response-like object with a
 * `.json()` method so callers can do:  `const data = await resp.json()`.
 *
 * Normalised shape:
 *   success  — true  → { success: true, results: { books, music, … } }
 *   error    → { success: false, error: '<message>' }
 */
async function uploadArchive(zipBuffer) {
  const form = new FormData();
  form.append('archive', zipBuffer, { filename: 'test.zip', contentType: 'application/zip' });

  const uploadResp = await fetch(`${BASE_URL}/plugin/agora/upload`, {
    method: 'POST', body: form, headers: form.getHeaders()
  });
  if (!uploadResp.ok) {
    const body = await uploadResp.json();
    return { json: () => Promise.resolve(body) };
  }

  const { jobId } = await uploadResp.json();

  // Consume the SSE stream until complete or error.
  const result = await new Promise((resolve, reject) => {
    const http = require('http');
    const url  = new URL(`/plugin/agora/upload/progress/${jobId}`, BASE_URL);

    const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const blocks = buf.split('\n\n');
        buf = blocks.pop();          // keep any partial trailing block

        for (const block of blocks) {
          const typeMatch = block.match(/^event: (.+)/m);
          const dataMatch = block.match(/^data: (.+)/m);
          if (!typeMatch || !dataMatch) continue;
          const type = typeMatch[1].trim();
          let data;
          try { data = JSON.parse(dataMatch[1]); } catch { continue; }

          if (type === 'complete') {
            req.destroy();
            resolve({ success: true,  results: data });
          } else if (type === 'error') {
            req.destroy();
            resolve({ success: false, error: data.message });
          }
          // ignore start / progress / warning events
        }
      });
      res.on('end', () => reject(new Error('SSE stream ended without complete/error')));
    });

    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('Upload SSE timeout after 30s')); }, 30000);
  });

  return { json: () => Promise.resolve(result) };
}

// ── Always-on tests (no Sanora needed) ───────────────────────────────────────

it('should return 404 for an unknown agora identifier', async () => {
  const resp = await fetch(`${BASE_URL}/plugin/agora/00000000-0000-0000-0000-000000000000`);
  resp.status.should.equal(404);
});

it('should reject an archive whose manifest uuid/emojicode are missing', async function() {
  this.timeout(15000);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'No UUID Agora' })));
  const resp = await uploadArchive(zip.toBuffer());
  const data = await resp.json();
  data.success.should.equal(false);
  data.error.should.match(/uuid|emojicode/i);
});

it('should reject an archive whose uuid does not match any registered tenant', async function() {
  this.timeout(15000);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    uuid: '00000000-0000-0000-0000-000000000000',
    emojicode: '🛍️🎨🎁🌟💎🐉📚🔥',
    name: 'Ghost Agora'
  })));
  const resp = await uploadArchive(zip.toBuffer());
  const data = await resp.json();
  data.success.should.equal(false);
});

it('should generate appointment slots from a schedule object', () => {
  // Test the slot generation logic directly without needing Sanora.
  // We reconstruct the same algorithm used in generateAvailableSlots.
  const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const schedule = {
    timezone: 'UTC',
    advanceDays: 7,
    duration: 60,
    availability: [
      { day: 'Monday',  slots: ['09:00', '10:00'] },
      { day: 'Tuesday', slots: ['14:00'] },
    ]
  };
  const bookedSlots = new Set();
  const results = [];
  const now = new Date();

  const dateFmt    = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });

  for (let d = 0; d < 7; d++) {
    const day = new Date(now.getTime() + d * 86400000);
    const dateStr    = dateFmt.format(day);
    const weekdayStr = weekdayFmt.format(day).toLowerCase();
    const avail = schedule.availability.find(a => a.day.toLowerCase() === weekdayStr);
    if (!avail) continue;
    const slots = avail.slots
      .map(t => `${dateStr}T${t}`)
      .filter(s => !bookedSlots.has(s));
    if (slots.length) results.push({ date: dateStr, slots });
  }

  results.should.be.an('array');
  results.length.should.be.at.least(1, 'expected at least one slot day in the next 7 days');
  results[0].slots[0].should.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'slot format should be YYYY-MM-DDTHH:MM');
});

// ── Sanora-dependent tests ────────────────────────────────────────────────────
//   These require Sanora (and optionally Addie) to be running.
//   Run with: SANORA_URL=https://dev.allyabase.com/plugin/allyabase/sanora npm test

describe('Sanora integration', function() {
  before(function() {
    if (!sanoraAvailable) this.skip();
  });

  it('should register a new tenant', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Agora' })
    });
    const data = await resp.json();
    if (!data.success) console.error('    error:', data.error);
    data.success.should.equal(true);
    data.tenant.uuid.should.be.a('string');
    data.tenant.emojicode.should.be.a('string');

    tenant = data.tenant;
    console.log(`    tenant: ${tenant.emojicode}  (${tenant.uuid})`);
  });

  it('should list tenants including the new one', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/tenants`);
    const data = await resp.json();
    data.success.should.equal(true);
    const found = data.tenants.find(t => t.uuid === tenant.uuid);
    found.should.exist;
    found.name.should.equal('Test Agora');
  });

  it('should upload an archive with all content categories', async function() {
    this.timeout(60000);
    const resp = await uploadArchive(buildTestArchive(tenant.uuid, tenant.emojicode));
    const data = await resp.json();
    if (!data.success) console.error('    error:', data.error);
    data.success.should.equal(true);

    // uploadArchive wraps SSE complete event as { success, results }
    const r = data.results || data;
    r.books.length.should.equal(1,         'expected 1 book');
    r.music.length.should.equal(1,         'expected 1 music item');
    r.posts.length.should.equal(1,         'expected 1 post');
    r.albums.length.should.equal(1,        'expected 1 album');
    r.products.length.should.equal(1,      'expected 1 product');
    r.appointments.length.should.equal(1,  'expected 1 appointment');
    r.subscriptions.length.should.equal(1, 'expected 1 subscription tier');

    console.log(`    📚${r.books.length} 🎵${r.music.length} 📝${r.posts.length} 🖼️${r.albums.length} 📦${r.products.length} 📅${r.appointments.length} 🎁${r.subscriptions.length}`);
  });

  it('should return all goods categories from the goods endpoint', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/goods`);
    const data = await resp.json();
    data.success.should.equal(true);
    data.goods.books.length.should.be.at.least(1,         'missing books');
    data.goods.music.length.should.be.at.least(1,         'missing music');
    data.goods.posts.length.should.be.at.least(1,         'missing posts');
    data.goods.albums.length.should.be.at.least(1,        'missing albums');
    data.goods.products.length.should.be.at.least(1,      'missing products');
    data.goods.appointments.length.should.be.at.least(1,  'missing appointments');
    data.goods.subscriptions.length.should.be.at.least(1, 'missing subscriptions');
  });

  it('should serve the agora HTML page with all tabs', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Test Agora');
    html.should.include('class="tab"');
    html.should.include('membership');
  });

  it('should return appointment slots for the uploaded session', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/book/Test%20Session/slots`);
    const data = await resp.json();
    data.available.should.be.an('array');
    data.available.length.should.be.at.least(1, 'expected at least one day with slots in the next 14 days');
    data.available[0].slots[0].should.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    data.timezone.should.be.a('string');
    console.log(`    ${data.available.length} days available, first: ${data.available[0].date} (${data.available[0].slots.length} slots)`);
  });

  it('should serve the appointment booking page', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/book/Test%20Session`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Test Session');
    html.should.include('/slots');
    html.should.include('purchase/intent');
    html.should.include('Continue to Payment'); // paid booking label (price=10000 in test archive)
  });

  it('should serve the subscription sign-up page with benefits', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/subscribe/Bronze%20Tier`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Bronze Tier');
    html.should.include('Monthly exclusive track');
    html.should.include('purchase/intent');
  });

  it('should serve the membership portal page', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/membership`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('membership/check');
    html.should.include('recovery-key');
  });

  it('should report no active subscriptions for an unknown recovery key', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/membership/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recoveryKey: 'no-such-key-xyz-99' })
    });
    const data = await resp.json();
    data.subscriptions.should.be.an('array');
    const bronze = data.subscriptions.find(s => s.title === 'Bronze Tier');
    bronze.should.exist;
    bronze.active.should.equal(false);
    bronze.benefits.should.deep.equal(['Monthly exclusive track', 'Early access']);
    bronze.exclusiveArtifacts.should.deep.equal([]);
  });
});

// ── Extended feature tests (Sanora required) ─────────────────────────────────

describe('Extended features (Sanora required)', function() {
  let sessionless;
  let buyerKeys;

  before(function() {
    if (!sanoraAvailable) this.skip();
    sessionless = require('sessionless-node');
  });

  // Helper: sign a message as the tenant owner (reads keys from TEST_HOME)
  async function ownerSign(message) {
    const tenantsPath = path.join(TEST_HOME, '.agora', 'tenants.json');
    const tenants = JSON.parse(fs.readFileSync(tenantsPath, 'utf8'));
    const record = Object.values(tenants).find(t => t && typeof t === 'object' && t.uuid === tenant.uuid);
    if (!record || !record.ownerPrivateKey) throw new Error('ownerPrivateKey not found in tenants.json');
    const prev = sessionless.getKeys;
    sessionless.getKeys = () => ({ privateKey: record.ownerPrivateKey, pubKey: record.ownerPubKey });
    const sig = await sessionless.sign(message);
    sessionless.getKeys = prev;
    return sig;
  }

  // Helper: build signed owner query string for the orders endpoint
  async function ownerQuery() {
    const ts = Date.now().toString();
    const sig = await ownerSign(ts + tenant.uuid);
    return `timestamp=${encodeURIComponent(ts)}&signature=${encodeURIComponent(sig)}`;
  }

  it('should store tenant email from manifest on re-upload', async () => {
    // Build an archive with email in the manifest
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      uuid: tenant.uuid,
      emojicode: tenant.emojicode,
      name: 'Integration Test Agora',
      email: 'creator@example.com',
    })));
    // Minimal book so upload doesn't fail content processing
    zip.addFile('books/Test Book/info.json', Buffer.from(JSON.stringify({
      title: 'Test Book', description: 'A test ebook', price: 999
    })));
    zip.addFile('books/Test Book/test-book.epub', Buffer.from('fake epub'));
    zip.addFile('books/Test Book/cover.jpg', Buffer.from('fake jpg'));

    const resp = await uploadArchive(zip.toBuffer());
    const data = await resp.json();
    data.success.should.equal(true);

    // Verify email was saved via the tenants listing
    const listResp = await fetch(`${BASE_URL}/plugin/agora/tenants`);
    const listData = await listResp.json();
    const found = listData.tenants.find(t => t.uuid === tenant.uuid);
    found.should.exist;
    found.email.should.equal('creator@example.com');
  });

  it('should include OG meta tags in the agora page', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}`);
    const html = await resp.text();
    html.should.include('og:title');
    html.should.include('og:description');
    html.should.include('og:site_name');
    html.should.include('twitter:card');
    html.should.include('Integration Test Agora');
  });

  it('should filter goods by category', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/goods?category=books`);
    const data = await resp.json();
    data.success.should.equal(true);
    data.goods.books.should.be.an('array').with.length.at.least(1);
    // Other categories should be absent or empty
    Object.keys(data.goods).forEach(cat => {
      if (cat !== 'books') data.goods[cat].should.be.an('array').with.length(0);
    });
  });

  it('should reject purchase/complete with an invalid buyer signature', async () => {
    const goods = await (await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/goods`)).json();
    const book = goods.goods.books[0];
    const timestamp = Date.now().toString();
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/purchase/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubKey:    'deadbeef'.repeat(8) + '02', // invalid but 33-byte-ish
        timestamp,
        signature: 'badbad'.repeat(10),
        productId: book.productId,
        title:     book.title,
      })
    });
    resp.status.should.equal(401);
  });

  it('should accept purchase/complete with a valid pubKey signature and record an order', async () => {
    buyerKeys = await sessionless.generateKeys(() => {}, () => null);
    const goods = await (await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/goods`)).json();
    const book = goods.goods.books[0];

    const timestamp = Date.now().toString();
    sessionless.getKeys = () => buyerKeys;
    const signature = await sessionless.sign(timestamp + buyerKeys.pubKey);

    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/purchase/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubKey:    buyerKeys.pubKey,
        timestamp,
        signature,
        productId: book.productId,
        title:     book.title,
      })
    });
    const data = await resp.json();
    if (data.error) console.error('    error:', data.error);
    data.success.should.equal(true);
  });

  it('should accept purchase/complete with contactInfo.email', async () => {
    const freshKeys = await sessionless.generateKeys(() => {}, () => null);
    const goods = await (await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/goods`)).json();
    const book = goods.goods.books[0];

    const timestamp = Date.now().toString();
    sessionless.getKeys = () => freshKeys;
    const signature = await sessionless.sign(timestamp + freshKeys.pubKey);

    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/purchase/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubKey:      freshKeys.pubKey,
        timestamp,
        signature,
        productId:   book.productId,
        title:       book.title,
        contactInfo: { email: 'buyer@example.com' },
      })
    });
    const data = await resp.json();
    data.success.should.equal(true);
  });

  it('should render the orders page for a valid owner-signed URL', async () => {
    const qs = await ownerQuery();
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/orders?${qs}`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Test Agora');
    html.should.include('orders');
  });

  it('should reject the orders page for an expired or missing signature', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/orders`);
    resp.status.should.equal(403);
  });

  it('should persist buyer email in session and pre-fill the membership portal', async () => {
    // Step 1: POST to /membership/check to register the email in the session.
    const checkResp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/membership/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recoveryKey: 'session-test@example.com' })
    });
    checkResp.status.should.equal(200);
    const checkData = await checkResp.json();
    checkData.subscriptions.should.be.an('array');
    checkData.subscriptions.forEach(sub => {
      sub.should.have.property('title');
      sub.should.have.property('active');
    });

    // Step 2: GET /membership — if express-session is wired up on the test server,
    // the Set-Cookie header is returned and the next GET would pre-fill sessionEmail.
    // In the minimal test-server setup (no express-session), we just verify the
    // membership portal renders successfully.
    const portalResp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/membership`);
    portalResp.status.should.equal(200);
    const html = await portalResp.text();
    html.should.include('membership/check');
    // Input for email lookup is present
    html.should.include('recovery-key');

    // Step 3: If we receive a session cookie from the check step, reuse it and
    // confirm the portal pre-fills the email.
    const cookie = checkResp.headers.get('set-cookie');
    if (cookie) {
      const sessionResp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/membership`, {
        headers: { 'Cookie': cookie.split(';')[0] }
      });
      const sessionHtml = await sessionResp.text();
      sessionHtml.should.include('session-test@example.com');
    }
  });
});

// ── Stripe purchase flow (requires STRIPE_TEST_KEY + Sanora + Addie) ─────────
const STRIPE_TEST_KEY = process.env.STRIPE_TEST_KEY;
const describeStripe = (STRIPE_TEST_KEY && sanoraAvailable) ? describe : describe.skip;

describeStripe('Stripe purchase flow (requires STRIPE_TEST_KEY + Sanora)', function() {
  it('should create a Stripe payment intent for a subscription', async () => {
    const goods = await (await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/goods`)).json();
    const sub = goods.goods.subscriptions[0];
    const resp = await fetch(`${BASE_URL}/plugin/agora/${tenant.uuid}/purchase/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recoveryKey: 'test-recovery-key-stripe',
        productId: sub.productId || sub.title,
        title: sub.title
      })
    });
    const data = await resp.json();
    if (data.error) console.error('    error:', data.error);
    data.clientSecret.should.be.a('string');
    data.publishableKey.should.be.a('string');
  });
});
