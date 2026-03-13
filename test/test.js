'use strict';

// ── Set up a temp HOME before the server module loads, so DATA_DIR
//   (~/.shoppe) is isolated from any real shoppe data on this machine.
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppe-test-'));
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
    uuid, emojicode, name: 'Integration Test Shoppe'
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
    const cfgDir = path.join(TEST_HOME, '.shoppe');
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
async function uploadArchive(zipBuffer) {
  const form = new FormData();
  form.append('archive', zipBuffer, { filename: 'test.zip', contentType: 'application/zip' });
  return fetch(`${BASE_URL}/plugin/shoppe/upload`, {
    method: 'POST', body: form, headers: form.getHeaders()
  });
}

// ── Always-on tests (no Sanora needed) ───────────────────────────────────────

it('should return 404 for an unknown shoppe identifier', async () => {
  const resp = await fetch(`${BASE_URL}/plugin/shoppe/00000000-0000-0000-0000-000000000000`);
  resp.status.should.equal(404);
});

it('should reject an archive whose manifest uuid/emojicode are missing', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'No UUID Shoppe' })));
  const resp = await uploadArchive(zip.toBuffer());
  const data = await resp.json();
  data.success.should.equal(false);
  data.error.should.match(/uuid|emojicode/i);
});

it('should reject an archive whose uuid does not match any registered tenant', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    uuid: '00000000-0000-0000-0000-000000000000',
    emojicode: '🛍️🎨🎁🌟💎🐉📚🔥',
    name: 'Ghost Shoppe'
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
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Shoppe' })
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
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/tenants`);
    const data = await resp.json();
    data.success.should.equal(true);
    const found = data.tenants.find(t => t.uuid === tenant.uuid);
    found.should.exist;
    found.name.should.equal('Test Shoppe');
  });

  it('should upload an archive with all content categories', async () => {
    const resp = await uploadArchive(buildTestArchive(tenant.uuid, tenant.emojicode));
    const data = await resp.json();
    if (!data.success) console.error('    error:', data.error);
    data.success.should.equal(true);

    const r = data.results;
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
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/goods`);
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

  it('should serve the shoppe HTML page with all tabs', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Test Shoppe');
    html.should.include('class="tab"');
    html.should.include('membership');
  });

  it('should return appointment slots for the uploaded session', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/book/Test%20Session/slots`);
    const data = await resp.json();
    data.available.should.be.an('array');
    data.available.length.should.be.at.least(1, 'expected at least one day with slots in the next 14 days');
    data.available[0].slots[0].should.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    data.timezone.should.be.a('string');
    console.log(`    ${data.available.length} days available, first: ${data.available[0].date} (${data.available[0].slots.length} slots)`);
  });

  it('should serve the appointment booking page', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/book/Test%20Session`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Test Session');
    html.should.include('/slots');
    html.should.include('purchase/intent');
    html.should.include('Continue to Payment'); // paid booking label (price=10000 in test archive)
  });

  it('should serve the subscription sign-up page with benefits', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/subscribe/Bronze%20Tier`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('Bronze Tier');
    html.should.include('Monthly exclusive track');
    html.should.include('purchase/intent');
  });

  it('should serve the membership portal page', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/membership`);
    resp.status.should.equal(200);
    const html = await resp.text();
    html.should.include('membership/check');
    html.should.include('recovery-key');
  });

  it('should report no active subscriptions for an unknown recovery key', async () => {
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/membership/check`, {
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

// ── Stripe purchase flow (requires STRIPE_TEST_KEY + Sanora + Addie) ─────────
const STRIPE_TEST_KEY = process.env.STRIPE_TEST_KEY;
const describeStripe = (STRIPE_TEST_KEY && sanoraAvailable) ? describe : describe.skip;

describeStripe('Stripe purchase flow (requires STRIPE_TEST_KEY + Sanora)', function() {
  it('should create a Stripe payment intent for a subscription', async () => {
    const goods = await (await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/goods`)).json();
    const sub = goods.goods.subscriptions[0];
    const resp = await fetch(`${BASE_URL}/plugin/shoppe/${tenant.uuid}/purchase/intent`, {
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
