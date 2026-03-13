(function() {

  window.plugins.shoppe = {
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
            .sw-tree { font-family: monospace; font-size: 12px; background: #1d1d1f; color: #a8f0a8; border-radius: 8px; padding: 14px 16px; line-height: 1.7; white-space: pre; overflow-x: auto; margin-top: 8px; }
            .sw-shoppe { display: flex; align-items: center; justify-content: space-between; background: white; border: 1px solid #e5e5ea; border-radius: 10px; padding: 12px 16px; margin-bottom: 8px; }
            .sw-shoppe-left { display: flex; flex-direction: column; gap: 2px; }
            .sw-shoppe-name { font-weight: 600; font-size: 15px; }
            .sw-shoppe-code { font-size: 18px; letter-spacing: 4px; }
            .sw-link { font-size: 13px; color: #0066cc; text-decoration: none; white-space: nowrap; }
            .sw-link:hover { text-decoration: underline; }
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
          </style>

          <!-- Directory -->
          <div class="sw-section">
            <h2>🛍️ Shoppe</h2>
            <p style="font-size:14px;color:#555;margin:4px 0 16px">A multi-tenant digital goods marketplace. Browse the shoppes below, or open one of your own.</p>
            <h3>Shoppes on this server</h3>
            <div id="sw-directory"><em class="sw-empty">Loading...</em></div>
          </div>

          <!-- How to join -->
          <div class="sw-section">
            <h3>How to open a shoppe</h3>
            <div class="sw-card">
              <div class="sw-step">
                <div class="sw-step-num">1</div>
                <div class="sw-step-body"><strong>Ask the wiki owner to register you.</strong> They'll use the form at the bottom of this page and give you a <code>uuid</code> and <code>emojicode</code> — your shoppe's identity.</div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">2</div>
                <div class="sw-step-body"><strong>Build your shoppe folder</strong> with this structure, then zip the whole thing:
                  <div class="sw-tree">my-shoppe.zip
  manifest.json       ← { "uuid": "…", "emojicode": "…", "name": "My Shoppe" }
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
      info.json       ← { "title": "…", "description": "…", "price": 25, "shipping": 5 }</div>
                </div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">3</div>
                <div class="sw-step-body"><strong>Drag your .zip onto the upload zone below.</strong> Your goods will be registered and your shoppe will go live immediately.</div>
              </div>
              <div class="sw-step">
                <div class="sw-step-num">4</div>
                <div class="sw-step-body"><strong>To update your shoppe</strong>, just rebuild your folder and upload a new archive — existing items will be overwritten and new ones added.</div>
              </div>
            </div>
          </div>

          <!-- Upload -->
          <div class="sw-section">
            <h3>Upload your archive</h3>
            <div class="sw-drop" id="sw-drop">
              <div style="font-size:40px">📦</div>
              <p>Drag and drop your .zip here, or click to browse.<br>Your <code>manifest.json</code> must contain the <code>uuid</code> and <code>emojicode</code> you were given.</p>
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

            <h3 style="margin-top:20px">Register a new shoppe (owner only)</h3>
            <div class="sw-register">
              <input type="text" id="sw-name-input" placeholder="Shoppe name (e.g. Zach's Art Store)">
              <button class="sw-btn sw-btn-green" id="sw-register-btn">Register</button>
            </div>
            <div id="sw-register-status" class="sw-status"></div>
          </div>

        </div>
      `;

      setupListeners(div);
      loadDirectory(div);
      checkOwner(div);
    },

    bind: function($item, item) {}
  };

  // ── Directory (public) ──────────────────────────────────────────────────────

  async function loadDirectory(container) {
    const el = container.querySelector('#sw-directory');
    try {
      const resp = await fetch('/plugin/shoppe/directory');
      const result = await resp.json();
      if (!result.success || result.shoppes.length === 0) {
        el.innerHTML = '<em class="sw-empty">No shoppes yet — be the first!</em>';
        return;
      }
      el.innerHTML = result.shoppes.map(s => `
        <div class="sw-shoppe">
          <div class="sw-shoppe-left">
            <span class="sw-shoppe-name">${s.name}</span>
            <span class="sw-shoppe-code">${s.emojicode}</span>
          </div>
          <a class="sw-link" href="${s.url}" target="_blank">Visit shoppe →</a>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = '<em class="sw-empty">Could not load directory.</em>';
    }
  }

  // ── Owner check ─────────────────────────────────────────────────────────────

  async function checkOwner(container) {
    try {
      const resp = await fetch('/plugin/shoppe/config');
      if (resp.ok) {
        container.querySelector('#sw-owner-section').style.display = 'block';
        const result = await resp.json();
        if (result.sanoraUrl) {
          container.querySelector('#sw-url-input').value = result.sanoraUrl;
        }
      }
    } catch (err) { /* not owner, stay hidden */ }
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
      registerBtn.addEventListener('click', () => registerShoppe(container));
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function uploadArchive(file, container) {
    showStatus(container, '#sw-upload-status', `⏳ Uploading <strong>${file.name}</strong>…`, 'info');
    const form = new FormData();
    form.append('archive', file);
    try {
      const resp = await fetch('/plugin/shoppe/upload', { method: 'POST', body: form });
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || 'Upload failed');

      const r = result.results;
      const counts = [
        r.books.length        && `📚 ${r.books.length} book${r.books.length !== 1 ? 's' : ''}`,
        r.music.length        && `🎵 ${r.music.length} music item${r.music.length !== 1 ? 's' : ''}`,
        r.posts.length        && `📝 ${r.posts.length} post${r.posts.length !== 1 ? 's' : ''}`,
        r.albums.length       && `🖼️ ${r.albums.length} album${r.albums.length !== 1 ? 's' : ''}`,
        r.products.length     && `📦 ${r.products.length} product${r.products.length !== 1 ? 's' : ''}`,
        r.appointments && r.appointments.length && `📅 ${r.appointments.length} appointment${r.appointments.length !== 1 ? 's' : ''}`,
        r.subscriptions && r.subscriptions.length && `🎁 ${r.subscriptions.length} subscription tier${r.subscriptions.length !== 1 ? 's' : ''}`
      ].filter(Boolean).join(' · ') || 'no items found';

      const warnings = (r.warnings && r.warnings.length > 0)
        ? `<br><br>⚠️ <strong>Warnings (${r.warnings.length}):</strong><br>${r.warnings.map(w => `• ${w}`).join('<br>')}`
        : '';
      showStatus(container, '#sw-upload-status',
        `✅ <strong>${result.tenant.name}</strong> ${result.tenant.emojicode} updated — ${counts}${warnings}<br>
         <a href="/plugin/shoppe/${result.tenant.uuid}" target="_blank" class="sw-link" style="display:inline-block;margin-top:8px;">View your shoppe →</a>`,
        'success');
      loadDirectory(container);
    } catch (err) {
      showStatus(container, '#sw-upload-status', `❌ ${err.message}`, 'error');
    }
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
      const resp = await fetch('/plugin/shoppe/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sanoraUrl: url })
      });
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || 'Save failed');
      showStatus(container, '#sw-url-status', `✅ Connected to <strong>${url}</strong>`, 'success');
    } catch (err) {
      showStatus(container, '#sw-url-status', `❌ ${err.message}`, 'error');
    } finally {
      urlBtn.disabled = false;
      urlBtn.textContent = 'Save';
    }
  }

  // ── Register (owner) ────────────────────────────────────────────────────────

  async function registerShoppe(container) {
    const nameInput   = container.querySelector('#sw-name-input');
    const registerBtn = container.querySelector('#sw-register-btn');
    const name = nameInput.value.trim();
    if (!name) { showStatus(container, '#sw-register-status', 'Enter a shoppe name first', 'error'); return; }

    registerBtn.disabled = true;
    registerBtn.textContent = 'Registering…';
    try {
      const resp = await fetch('/plugin/shoppe/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || 'Registration failed');

      nameInput.value = '';
      showStatus(container, '#sw-register-status',
        `✅ Registered! Give these to the shoppe owner:<br>
         UUID: <code>${result.tenant.uuid}</code><br>
         Emojicode: <strong>${result.tenant.emojicode}</strong>`,
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
