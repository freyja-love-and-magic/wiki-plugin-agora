(function() {

  window.plugins.agora = {
    emit: function($item, item) {
      const div = $item[0];
      div.innerHTML = `
        <div class="sw">
          <style>
            .sw { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 0 auto; color: #1d1d1f; }
            .sw h2 { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
            .sw h3 { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 10px; }
            .sw-section { margin-bottom: 24px; }
            .sw-card { background: #f5f5f7; border-radius: 12px; padding: 18px 20px; margin-bottom: 10px; }
            .sw-step { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 12px; }
            .sw-step:last-child { margin-bottom: 0; }
            .sw-step-num { background: #0066cc; color: white; border-radius: 50%; width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; margin-top: 1px; }
            .sw-step-body { font-size: 14px; line-height: 1.5; color: #333; }
            .sw-step-body strong { color: #1d1d1f; }
            .sw-step-body code { background: #e8e8ed; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
            .sw-tree { font-family: monospace; font-size: 12px; background: #1d1d1f; color: #a8f0a8; border-radius: 8px; padding: 14px 16px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; margin-top: 8px; }
            .sw-agora { display: flex; align-items: center; justify-content: space-between; background: white; border: 1px solid #e5e5ea; border-radius: 10px; padding: 12px 16px; margin-bottom: 8px; }
            .sw-agora-left { display: flex; flex-direction: column; gap: 2px; }
            .sw-agora-name { font-weight: 600; font-size: 15px; }
            .sw-agora-code { font-size: 18px; letter-spacing: 4px; }
            .sw-agora-actions { display: flex; align-items: center; gap: 12px; }
            .sw-link { font-size: 13px; color: #0066cc; text-decoration: none; white-space: nowrap; }
            .sw-link:hover { text-decoration: underline; }
            .sw-btn-delete { background: none; border: none; color: #cc0000; font-size: 13px; cursor: pointer; padding: 0; white-space: nowrap; }
            .sw-btn-delete:hover { text-decoration: underline; }
            .sw-empty { font-size: 13px; color: #999; font-style: italic; }
            .sw-drop { border: 2px dashed #ccc; border-radius: 12px; padding: 28px 20px; text-align: center; background: #fafafa; transition: border-color 0.2s, background 0.2s; cursor: pointer; }
            .sw-drop.dragover { border-color: #0066cc; background: #e8f0fe; }
            .sw-drop p { font-size: 13px; color: #888; margin: 6px 0 14px; }
            .sw-btn { display: inline-block; padding: 9px 20px; border-radius: 18px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; }
            .sw-btn-blue  { background: #0066cc; color: white; }
            .sw-btn-blue:hover  { background: #0055aa; }
            .sw-btn-green { background: #10b981; color: white; }
            .sw-btn-green:hover { background: #059669; }
            .sw-register { display: flex; gap: 8px; margin-top: 10px; }
            .sw-register input { flex: 1; padding: 9px 13px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; outline: none; }
            .sw-register input:focus { border-color: #0066cc; }
            .sw-status { margin-top: 12px; border-radius: 10px; padding: 13px 16px; font-size: 14px; line-height: 1.5; display: none; }
            .sw-status.info    { background: #e8f0fe; color: #1a56db; display: block; }
            .sw-status.success { background: #d1fae5; color: #065f46; display: block; }
            .sw-status.error   { background: #fee2e2; color: #991b1b; display: block; }
            .sw-status code { background: rgba(0,0,0,0.08); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
            .sw-progress-bar-track { background: rgba(0,0,0,0.12); border-radius: 4px; height: 8px; margin: 8px 0; overflow: hidden; }
            .sw-progress-bar-fill  { height: 100%; background: #1a56db; border-radius: 4px; width: 0%; transition: width 0.25s ease; }
            .sw-progress-meta { display: flex; justify-content: space-between; font-size: 12px; opacity: 0.75; }
            .sw-progress-item { margin-top: 6px; font-size: 13px; font-style: italic; }
            .sw-remove { display: block; width: 100%; margin-top: 24px; padding: 8px; background: none; border: 1px solid #e5e5ea; border-radius: 8px; font-size: 12px; color: #aaa; cursor: pointer; text-align: center; }
            .sw-remove:hover { border-color: #cc0000; color: #cc0000; }
            .sw-stripe-banner { display: none; margin-top: 16px; background: #fff8e1; border: 1px solid #f59e0b; border-radius: 10px; padding: 14px 16px; }
            .sw-stripe-banner h4 { font-size: 14px; font-weight: 700; color: #92400e; margin-bottom: 6px; }
            .sw-stripe-banner p { font-size: 13px; color: #78350f; margin-bottom: 10px; line-height: 1.5; }
            .sw-stripe-banner.done { background: #d1fae5; border-color: #10b981; }
            .sw-stripe-banner.done h4 { color: #065f46; }
            .sw-stripe-banner.done p { color: #047857; }
          </style>

          <!-- Directory -->
          <div class="sw-section">
            <h2>🛍️ Agora</h2>
            <p style="font-size:14px;color:#555;margin:4px 0 16px">A multi-tenant digital goods marketplace. Browse the agoras below, or open one of your own.</p>
            <h3>Agoras on this server</h3>
            <div id="sw-directory"><em class="sw-empty">Loading...</em></div>
          </div>

          <!-- How to join -->
          <div class="sw-section">
            <h3>How to open an agora</h3>
            <div class="sw-card">
              <div class="sw-step">
                <div class="sw-step-num">1</div>
                <div class="sw-step-body"><strong>Ask the wiki owner to register you.</strong> They'll download a <strong>starter bundle</strong> — a zip with your signing key, a template folder structure, and the <code>agora-sign.js</code> utility. Run <code>node agora-sign.js init</code> to store your key securely.</div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">2</div>
                <div class="sw-step-body"><strong>Set up payouts</strong> by running <code>node agora-sign.js payouts</code>. This opens Stripe Connect onboarding so you can receive payments. Do this once before your first sale.</div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">3</div>
                <div class="sw-step-body"><strong>Build your agora folder</strong> with this structure:
                  <div class="sw-tree">my-agora.zip
  manifest.json       ← { "uuid": "…", "emojicode": "…", "name": "My Agora" }
  books/
    My Novel/         ← subfolder per book
      my-novel.epub
      cover.jpg
      info.json       ← { "title": "…", "description": "…", "price": 0 }
  music/
    My Album/         ← subfolder = album (add cover.jpg inside)
      cover.jpg
      01-track.mp3
    standalone.mp3    ← file directly here = single track
  posts/
    01-Hello World/   ← number prefix sets table of contents order
      post.md         ← the post content
      cover.jpg       ← optional cover image
      screenshot.png  ← any assets referenced in the markdown
      info.json       ← optional: { "title": "…", "description": "…" }
    02-My Series/     ← subdirectories = multi-part series
      cover.jpg       ← optional series cover
      info.json       ← optional: { "title": "…", "description": "…" }
      01-Part One/
        post.md
        diagram.png
      02-Part Two/
        post.md
  albums/
    Vacation 2025/    ← subfolder of images = photo album
      photo1.jpg
  products/
    T-Shirt/          ← subfolder = physical product
      cover.jpg
      info.json       ← { "title": "…", "description": "…", "price": 25, "shipping": 5 }
  appointments/
    Office Hours/     ← subfolder = bookable appointment type
      cover.jpg
      info.json       ← { "title": "…", "description": "…", "price": 0, "duration": 30,
                           "timezone": "America/Chicago", "advanceDays": 21,
                           "availability": [
                             { "day": "Monday", "slots": ["09:00", "10:00", "11:00"] },
                             { "day": "Friday", "slots": ["14:00", "15:00"] }
                           ] }
  subscriptions/
    Bronze Tier/      ← subfolder = infuse tier
      cover.jpg
      info.json       ← { "title": "…", "description": "…", "price": 500,
                           "renewalDays": 30,
                           "benefits": ["Early access", "Monthly exclusive track"] }
      bonus.mp3       ← any extra files become exclusive content for infusers</div>
                </div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">4</div>
                <div class="sw-step-body"><strong>Run <code>node agora-sign.js</code></strong> from inside your agora folder. This signs your manifest and creates an <code>upload.zip</code> next to the folder.</div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">5</div>
                <div class="sw-step-body"><strong>Drag <code>upload.zip</code> onto the upload zone below.</strong> Your goods will be registered and your agora will go live immediately.</div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">6</div>
                <div class="sw-step-body"><strong>To update your agora</strong>, add content to your folder and run <code>node agora-sign.js</code> again — existing items are overwritten, new ones added.</div>
              </div>
            </div>
          </div>

          <!-- Upload -->
          <div class="sw-section">
            <h3>Upload your archive</h3>
            <div class="sw-drop" id="sw-drop">
              <div style="font-size:40px">📦</div>
              <p>Drag and drop your signed <code>upload.zip</code> here, or click to browse.<br>Run <code>node agora-sign.js</code> in your agora folder to create it.</p>
              <button class="sw-btn sw-btn-blue" id="sw-browse-btn">Choose Archive</button>
              <input type="file" id="sw-file-input" accept=".zip" style="display:none">
            </div>
            <div id="sw-upload-status" class="sw-status"></div>
          </div>

          <!-- Owner: config + register -->
          <div class="sw-section" id="sw-owner-section" style="display:none">
            <h3>Allyabase connection (owner only)</h3>
            <div class="sw-register">
              <input type="text" id="sw-url-input" placeholder="https://dojo.allyabase.com/plugin/allyabase/sanora">
              <button class="sw-btn sw-btn-blue" id="sw-url-btn">Save</button>
            </div>
            <div id="sw-url-status" class="sw-status"></div>

            <div class="sw-stripe-banner" id="sw-stripe-banner">
              <h4 id="sw-stripe-banner-title">💳 Enable server payouts</h4>
              <p id="sw-stripe-banner-desc">Complete Stripe onboarding so your server receives a 5% platform fee from all purchases across your tenants' agoras.</p>
              <a id="sw-stripe-banner-btn" href="/plugin/agora/setup/stripe" target="_blank" class="sw-btn sw-btn-blue" style="text-decoration:none;display:inline-block;">Set up payouts →</a>
            </div>

            <h3 style="margin-top:20px">Register a new agora (owner only)</h3>
            <div class="sw-register">
              <input type="text" id="sw-name-input" placeholder="Agora name (e.g. Zach's Art Store)">
              <button class="sw-btn sw-btn-green" id="sw-register-btn">Register</button>
            </div>
            <div id="sw-register-status" class="sw-status"></div>
          </div>

          <button class="sw-remove" id="sw-remove-btn">Remove plugin from page</button>

        </div>
      `;

      div.querySelector('#sw-remove-btn').addEventListener('click', () => {
        const $page = $item.parents('.page');
        if (window.wiki && wiki.pageHandler && $page.length) {
          wiki.pageHandler.put($page, { type: 'remove', id: item.id });
          $item.remove();
        } else if (window.wiki && wiki.textEditor) {
          wiki.textEditor($item, item);
        }
      });

      setupListeners(div);
      checkOwner(div).then(isOwner => {
        if (!isOwner) loadDirectory(div, false);
      });
    },

    bind: function($item, item) {
      $item.on('dblclick', () => {
        const $page = $item.parents('.page');
        if (window.wiki && wiki.pageHandler && $page.length) {
          wiki.pageHandler.put($page, { type: 'remove', id: item.id });
          $item.remove();
        } else if (window.wiki && wiki.textEditor) {
          wiki.textEditor($item, item);
        }
      });
    }
  };

  // ── Directory ────────────────────────────────────────────────────────────────

  async function loadDirectory(container, isOwner = false) {
    const el = container.querySelector('#sw-directory');
    try {
      const resp = await fetch(isOwner ? '/plugin/agora/tenants' : '/plugin/agora/directory');
      const result = await resp.json();
      const agoras = isOwner ? result.tenants : result.agoras;
      if (!result.success || !agoras || agoras.length === 0) {
        el.innerHTML = '<em class="sw-empty">No agoras yet — be the first!</em>';
        return;
      }
      el.innerHTML = agoras.map(s => `
        <div class="sw-agora" id="sw-agora-${s.uuid}">
          <div class="sw-agora-left">
            <span class="sw-agora-name">${s.name}</span>
            <span class="sw-agora-code">${s.emojicode}</span>
          </div>
          <div class="sw-agora-actions">
            <a class="sw-link" href="${s.url}" target="_blank">Visit agora →</a>
            ${isOwner ? `<button class="sw-btn-delete" data-uuid="${s.uuid}" data-name="${s.name}">Delete</button>` : ''}
          </div>
        </div>
      `).join('');

      if (isOwner) {
        el.querySelectorAll('.sw-btn-delete').forEach(btn => {
          btn.addEventListener('click', () => deleteAgora(btn.dataset.uuid, btn.dataset.name, container));
        });
      }
    } catch (err) {
      el.innerHTML = '<em class="sw-empty">Could not load directory.</em>';
    }
  }

  // ── Owner check ─────────────────────────────────────────────────────────────

  async function checkOwner(container) {
    try {
      const resp = await fetch('/plugin/agora/config');
      if (resp.ok) {
        container.querySelector('#sw-owner-section').style.display = 'block';
        const result = await resp.json();
        if (result.sanoraUrl) {
          container.querySelector('#sw-url-input').value = result.sanoraUrl;
        }
        updateStripeBanner(container, result);
        loadDirectory(container, true);
        return true;
      }
    } catch (err) { /* not owner, stay hidden */ }
    return false;
  }

  function updateStripeBanner(container, result) {
    const banner = container.querySelector('#sw-stripe-banner');
    if (!banner) return;
    if (!result.serverAddieReady) {
      // Addie not reachable yet — don't show banner until URL is saved
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'block';
    if (result.stripeOnboarded) {
      banner.className = 'sw-stripe-banner done';
      banner.querySelector('#sw-stripe-banner-title').textContent = '✅ Server payouts enabled';
      banner.querySelector('#sw-stripe-banner-desc').textContent =
        'Your server is connected to Stripe and will receive a 5% platform fee from all purchases.';
      const btn = banner.querySelector('#sw-stripe-banner-btn');
      btn.textContent = 'Update Stripe account';
      btn.style.background = '#10b981';
    } else {
      banner.className = 'sw-stripe-banner';
      banner.querySelector('#sw-stripe-banner-title').textContent = '💳 Enable server payouts';
      banner.querySelector('#sw-stripe-banner-desc').textContent =
        'Complete Stripe onboarding so your server receives a 5% platform fee from all purchases across your tenants\' agoras.';
      const btn = banner.querySelector('#sw-stripe-banner-btn');
      btn.textContent = 'Set up payouts →';
      btn.style.background = '';
    }
  }

  // ── Delete agora (owner) ────────────────────────────────────────────────────

  async function deleteAgora(uuid, name, container) {
    if (!confirm(`Delete "${name}"? This will remove the agora and all its products from Sanora.`)) return;

    const row = container.querySelector(`#sw-agora-${uuid}`);
    if (row) row.style.opacity = '0.4';

    try {
      const resp = await fetch(`/plugin/agora/${uuid}`, { method: 'DELETE' });
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || 'Delete failed');
      loadDirectory(container, true);
    } catch (err) {
      if (row) row.style.opacity = '1';
      alert(`Could not delete agora: ${err.message}`);
    }
  }

  // ── Listeners ───────────────────────────────────────────────────────────────

  function setupListeners(container) {
    const drop      = container.querySelector('#sw-drop');
    const fileInput = container.querySelector('#sw-file-input');
    const browseBtn = container.querySelector('#sw-browse-btn');
    const registerBtn = container.querySelector('#sw-register-btn');
    const nameInput = container.querySelector('#sw-name-input');
    const urlBtn    = container.querySelector('#sw-url-btn');
    const urlInput  = container.querySelector('#sw-url-input');

    if (urlBtn) {
      urlBtn.addEventListener('click', () => saveUrl(container));
    }

    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) uploadArchive(e.target.files[0], container);
    });

    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.zip')) {
        uploadArchive(file, container);
      } else {
        showStatus(container, '#sw-upload-status', 'Please drop a .zip archive', 'error');
      }
    });

    if (registerBtn) {
      registerBtn.addEventListener('click', () => registerAgora(container));
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function uploadArchive(file, container) {
    const statusEl = container.querySelector('#sw-upload-status');

    // Step 1: POST the file, get a jobId back immediately.
    showStatus(container, '#sw-upload-status', `⏳ Uploading <strong>${file.name}</strong>…`, 'info');
    const form = new FormData();
    form.append('archive', file);
    let jobId;
    try {
      const resp = await fetch('/plugin/agora/upload', { method: 'POST', body: form });
      const result = await resp.json();
      if (!result.success || !result.jobId) throw new Error(result.error || 'Upload failed');
      jobId = result.jobId;
    } catch (err) {
      showStatus(container, '#sw-upload-status', `❌ ${err.message}`, 'error');
      return;
    }

    // Step 2: Show progress UI and open SSE stream.
    statusEl.className = 'sw-status info';
    statusEl.style.display = 'block';
    statusEl.innerHTML = `
      <div id="sw-progress-title" style="font-weight:600;margin-bottom:6px;">⏳ Processing archive…</div>
      <div class="sw-progress-bar-track"><div id="sw-progress-fill" class="sw-progress-bar-fill"></div></div>
      <div class="sw-progress-meta">
        <span id="sw-progress-count">0 / …</span>
        <span id="sw-progress-pct">0%</span>
      </div>
      <div id="sw-progress-item" class="sw-progress-item"></div>
    `;

    const fillEl  = statusEl.querySelector('#sw-progress-fill');
    const countEl = statusEl.querySelector('#sw-progress-count');
    const pctEl   = statusEl.querySelector('#sw-progress-pct');
    const itemEl  = statusEl.querySelector('#sw-progress-item');
    const titleEl = statusEl.querySelector('#sw-progress-title');

    const es = new EventSource(`/plugin/agora/upload/progress/${jobId}`);

    es.addEventListener('start', e => {
      const { total, name } = JSON.parse(e.data);
      titleEl.innerHTML = `⏳ Uploading <strong>${name}</strong> — ${total} item${total !== 1 ? 's' : ''}`;
      countEl.textContent = `0 / ${total}`;
    });

    es.addEventListener('progress', e => {
      const { current, total, label } = JSON.parse(e.data);
      const pct = total > 0 ? Math.round(current / total * 100) : 0;
      fillEl.style.width  = pct + '%';
      countEl.textContent = `${current} / ${total}`;
      pctEl.textContent   = pct + '%';
      itemEl.textContent  = label;
    });

    es.addEventListener('complete', e => {
      es.close();
      const result = JSON.parse(e.data);
      const r = result.results;
      const counts = [
        r.books        && r.books.length        && `📚 ${r.books.length} book${r.books.length !== 1 ? 's' : ''}`,
        r.music        && r.music.length        && `🎵 ${r.music.length} music item${r.music.length !== 1 ? 's' : ''}`,
        r.posts        && r.posts.length        && `📝 ${r.posts.length} post${r.posts.length !== 1 ? 's' : ''}`,
        r.albums       && r.albums.length       && `🖼️ ${r.albums.length} album${r.albums.length !== 1 ? 's' : ''}`,
        r.products     && r.products.length     && `📦 ${r.products.length} product${r.products.length !== 1 ? 's' : ''}`,
        r.appointments && r.appointments.length && `📅 ${r.appointments.length} appointment${r.appointments.length !== 1 ? 's' : ''}`,
        r.subscriptions && r.subscriptions.length && `🎁 ${r.subscriptions.length} subscription tier${r.subscriptions.length !== 1 ? 's' : ''}`
      ].filter(Boolean).join(' · ') || 'no items found';
      const warnings = (r.warnings && r.warnings.length > 0)
        ? `<br><br>⚠️ <strong>Warnings (${r.warnings.length}):</strong><br>${r.warnings.map(w => `• ${w}`).join('<br>')}`
        : '';
      showStatus(container, '#sw-upload-status',
        `✅ <strong>${result.tenant.name}</strong> ${result.tenant.emojicode} updated — ${counts}${warnings}<br>
         <a href="/plugin/agora/${result.tenant.uuid}" target="_blank" class="sw-link" style="display:inline-block;margin-top:8px;">View your agora →</a>`,
        'success');
      loadDirectory(container);
    });

    es.addEventListener('error', e => {
      es.close();
      let msg = 'Upload failed';
      try { msg = JSON.parse(e.data).message; } catch (err) { /* use default */ }
      showStatus(container, '#sw-upload-status', `❌ ${msg}`, 'error');
    });
  }

  // ── Save URL (owner) ────────────────────────────────────────────────────────

  async function saveUrl(container) {
    const urlInput = container.querySelector('#sw-url-input');
    const urlBtn   = container.querySelector('#sw-url-btn');
    const url = urlInput.value.trim();
    if (!url) { showStatus(container, '#sw-url-status', 'Enter an allyabase URL first', 'error'); return; }

    urlBtn.disabled = true;
    urlBtn.textContent = 'Saving…';
    try {
      const resp = await fetch('/plugin/agora/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sanoraUrl: url })
      });
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || 'Save failed');
      showStatus(container, '#sw-url-status', `✅ Connected to <strong>${url}</strong>`, 'success');
      updateStripeBanner(container, result);
    } catch (err) {
      showStatus(container, '#sw-url-status', `❌ ${err.message}`, 'error');
    } finally {
      urlBtn.disabled = false;
      urlBtn.textContent = 'Save';
    }
  }

  // ── Register (owner) ────────────────────────────────────────────────────────

  async function registerAgora(container) {
    const nameInput   = container.querySelector('#sw-name-input');
    const registerBtn = container.querySelector('#sw-register-btn');
    const name = nameInput.value.trim();
    if (!name) { showStatus(container, '#sw-register-status', 'Enter an agora name first', 'error'); return; }

    registerBtn.disabled = true;
    registerBtn.textContent = 'Registering…';
    try {
      const resp = await fetch('/plugin/agora/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || 'Registration failed');

      nameInput.value = '';
      const bundleUrl = result.bundleToken ? `/plugin/agora/bundle/${result.bundleToken}` : null;
      showStatus(container, '#sw-register-status',
        `✅ <strong>${result.tenant.name}</strong> registered!<br>
         Emojicode: <strong>${result.tenant.emojicode}</strong><br><br>
         ${bundleUrl
           ? `<a href="${bundleUrl}" class="sw-btn sw-btn-green" style="display:inline-block;text-decoration:none;margin-bottom:8px;">⬇️ Download Starter Bundle</a><br>
              <span style="font-size:12px;color:#555;">Hand this zip to the agora owner. The download link expires in 15 minutes and works only once.</span>`
           : `UUID: <code>${result.tenant.uuid}</code>`}`,
        'success');
      loadDirectory(container);
    } catch (err) {
      showStatus(container, '#sw-register-status', `❌ ${err.message}`, 'error');
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = 'Register';
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function showStatus(container, selector, html, type) {
    const el = container.querySelector(selector);
    el.className = `sw-status ${type}`;
    el.innerHTML = html;
  }

})();
