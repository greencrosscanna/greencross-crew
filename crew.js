"use strict";
/* ─────────────────────────────────────────────────────────────────────────────
 *  GX Crew — HR / People app (frontend)
 *  App key: crew.  Standalone spoke that FEEDS Leaderboard (perks + celebrations).
 *
 *  This view is the ROSTER: GX Core identity (canonical, read-only here) joined to the
 *  rich HR attributes GX Crew owns — shirt size, birthday, work anniversary.
 *
 *  It is behind a login on purpose. Birthdays are PII, and per CLAUDE.md Crew is a
 *  separate deployment from the all-staff kiosk precisely so this surface stays isolated.
 *  The session comes from GX Core (one credential system for the whole suite); Crew never
 *  handles a password beyond posting it straight to Core's login action.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var APP = 'crew';
  var GXCORE_URL = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';

  /* Crew's own Apps Script engine (apps-script/Code.gs).
   * Fill this in after the first `clasp deploy` — or, better, set `cfg.crewEngineUrl` in GX Core's
   * kv tab and every deployment picks it up without a code change (the config read below wins). */
  var ENGINE_URL_FALLBACK = '';

  var TOKEN_KEY = 'gx_crew_token';
  var USER_KEY  = 'gx_crew_user';

  var mount = document.getElementById('app');
  var GXCore = window.GXClient(GXCORE_URL);
  var Engine = null;           // built once we know the engine URL
  var state  = { rows: [], canEdit: false, shirtSizes: [], user: '', role: '', identity: null };

  // ─── tiny DOM helpers ────────────────────────────────────────────────────────
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clear() { mount.innerHTML = ''; }

  function card(titleHtml, bodyNodes) {
    var c = el('section', 'gx-card');
    if (titleHtml) c.appendChild(el('h1', null, titleHtml));
    (bodyNodes || []).forEach(function (n) { c.appendChild(n); });
    return c;
  }

  function banner(kind, html) {
    var b = el('p', 'crew-banner crew-banner-' + kind, html);
    return b;
  }

  // ─── session ─────────────────────────────────────────────────────────────────
  function token()      { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setSession(t, u) {
    try {
      if (t) { sessionStorage.setItem(TOKEN_KEY, t); sessionStorage.setItem(USER_KEY, u || ''); }
      else   { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(USER_KEY); }
    } catch (e) {}
  }

  // ─── engine resolution ───────────────────────────────────────────────────────
  /* Pull the engine URL from GX Core config so the deployed URL lives in one place for the
   * whole suite. Falls back to the constant above if the key isn't set yet. */
  async function resolveEngine() {
    var url = ENGINE_URL_FALLBACK;
    try {
      var r = await GXCore.jsonp('config', { key: 'cfg.crewEngineUrl' }, { retries: 1, timeoutMs: 6000 });
      if (r && r.ok && r.value) url = String(r.value);
    } catch (e) { /* config is a nicety, not a dependency */ }
    if (!url) return null;
    Engine = window.GXClient(url);
    return Engine;
  }

  // ─── views ───────────────────────────────────────────────────────────────────
  function renderLogin(errMsg) {
    clear();
    var form = el('form', 'crew-login');
    form.innerHTML =
      '<p class="gx-muted">GX Crew holds compensation and staff PII. Sign in with your GX account.</p>' +
      '<label>Username<input name="user" autocomplete="username" required></label>' +
      '<label>Password<input name="pass" type="password" autocomplete="current-password" required></label>' +
      '<button type="submit">Sign in</button>';
    var msg = el('p', 'crew-error');
    if (errMsg) msg.textContent = errMsg;

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Signing in…';
      msg.textContent = '';
      try {
        var r = await GXCore.jsonp('login', {
          user: form.user.value.trim(), pass: form.pass.value, app: APP
        });
        if (!r || !r.ok) throw new Error((r && r.error) || 'Sign-in failed');
        setSession(r.token, r.user);
        boot();
      } catch (e) {
        msg.textContent = (e && e.message) || 'Sign-in failed';
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });

    mount.appendChild(card('GX&nbsp;Crew', [form, msg]));
  }

  function renderStatus(html) {
    clear();
    mount.appendChild(card('GX&nbsp;Crew', [el('p', 'gx-muted', html)]));
  }

  function renderRoster() {
    clear();
    var nodes = [];

    var bar = el('div', 'crew-bar');
    bar.innerHTML = '<span class="gx-muted">Signed in as <b>' + esc(state.user) + '</b> · ' + esc(state.role) +
      (state.canEdit ? '' : ' <em>(read-only)</em>') + '</span>';
    var out = el('button', 'crew-link', 'Sign out');
    out.addEventListener('click', function () { setSession('', ''); boot(); });
    bar.appendChild(out);
    nodes.push(bar);

    // Identity is Core's, not ours — say so loudly when it hasn't been seeded, otherwise an
    // empty table reads as "we have no staff" instead of "the registry isn't populated yet".
    if (state.identity && state.identity.note) {
      nodes.push(banner('warn', esc(state.identity.note)));
    }
    if (state.identity && state.identity.error) {
      nodes.push(banner('error', 'GX Core identity read failed: ' + esc(state.identity.error)));
    }

    if (!state.rows.length) {
      nodes.push(el('p', 'gx-muted', 'No active employees to show yet.'));
      mount.appendChild(card('Roster', nodes));
      return;
    }

    var table = el('table', 'crew-table');
    table.innerHTML =
      '<thead><tr>' +
        '<th>Name</th><th>Store</th><th>Role</th>' +
        '<th>Shirt</th><th>Birthday <span class="gx-muted">(MM-DD)</span></th>' +
        '<th>Work anniversary</th><th></th>' +
      '</tr></thead>';
    var tbody = el('tbody');

    state.rows.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', null, '<b>' + esc(row.name) + '</b>'));
      tr.appendChild(el('td', 'gx-muted', esc(row.store)));
      tr.appendChild(el('td', 'gx-muted', esc(row.role)));

      // shirt size
      var tdShirt = el('td');
      var sel = el('select');
      sel.innerHTML = '<option value="">—</option>' + state.shirtSizes.map(function (s) {
        return '<option value="' + esc(s) + '"' + (row.shirt_size === s ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('');
      sel.disabled = !state.canEdit;
      tdShirt.appendChild(sel);
      tr.appendChild(tdShirt);

      // birthday — month/day only; we never ask for or store a birth year
      var tdB = el('td');
      var inB = el('input');
      inB.type = 'text'; inB.placeholder = 'MM-DD'; inB.value = row.birthday || '';
      inB.size = 6; inB.disabled = !state.canEdit;
      inB.title = 'Month and day only — GX Crew does not store birth years.';
      tdB.appendChild(inB);
      tr.appendChild(tdB);

      // work anniversary
      var tdA = el('td');
      var inA = el('input');
      inA.type = 'date'; inA.value = row.work_anniversary || '';
      inA.disabled = !state.canEdit;
      if (row.work_anniversary && !row.anniversary_is_override) {
        inA.title = 'From GX Core hire date. Editing here records a Crew override.';
      }
      tdA.appendChild(inA);
      if (row.work_anniversary && !row.anniversary_is_override) tdA.appendChild(el('span', 'crew-hint', ' from hire date'));
      tr.appendChild(tdA);

      // save
      var tdS = el('td');
      var status = el('span', 'crew-save-status');
      if (state.canEdit) {
        var save = el('button', 'crew-save', 'Save');
        save.disabled = true;
        var dirty = function () { save.disabled = false; status.textContent = ''; };
        sel.addEventListener('change', dirty);
        inB.addEventListener('input', dirty);
        inA.addEventListener('input', dirty);

        save.addEventListener('click', async function () {
          save.disabled = true; status.textContent = 'Saving…'; status.className = 'crew-save-status';
          try {
            var r = await Engine.jsonp('roster_save', {
              token: token(),
              employee_id: row.employee_id,
              shirt_size: sel.value,
              birthday: inB.value.trim(),
              work_anniversary: inA.value
            });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Save failed');
            row.shirt_size = r.saved.shirt_size;
            row.birthday = r.saved.birthday;
            row.work_anniversary = r.saved.work_anniversary;
            row.anniversary_is_override = !!r.saved.work_anniversary;
            inB.value = row.birthday;
            status.textContent = 'Saved';
            status.className = 'crew-save-status ok';
          } catch (e) {
            status.textContent = (e && e.message) || 'Save failed';
            status.className = 'crew-save-status err';
            save.disabled = false;
          }
        });
        tdS.appendChild(save);
      }
      tdS.appendChild(status);
      tr.appendChild(tdS);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    nodes.push(table);
    nodes.push(el('p', 'crew-hint',
      'Birthdays are stored as month + day only — no birth year. Leaderboard receives a derived ' +
      'celebrations flag (today / upcoming), never a date.'));

    mount.appendChild(card('Roster <span class="gx-muted crew-count">' + state.rows.length + '</span>', nodes));
  }

  // ─── boot ────────────────────────────────────────────────────────────────────
  async function boot() {
    if (!window.GXClient) { renderStatus('⚠️ gx-client failed to load — cannot reach GX Core.'); return; }
    if (!token()) { renderLogin(''); return; }

    renderStatus('Loading roster…');

    if (!Engine) {
      await resolveEngine();
      if (!Engine) {
        renderStatus('⚠️ The GX Crew engine is not deployed yet. Deploy <code>apps-script/</code> with ' +
          '<code>clasp deploy</code>, then set <code>cfg.crewEngineUrl</code> in GX Core (or fill ' +
          '<code>ENGINE_URL_FALLBACK</code> in crew.js).');
        return;
      }
    }

    try {
      var r = await Engine.jsonp('roster', { token: token() });
      if (!r || !r.ok) {
        // An expired/revoked session should drop to the login form, not a dead-end error.
        if (r && /auth|session|access/i.test(String(r.error || ''))) { setSession('', ''); renderLogin(r.error); return; }
        throw new Error((r && r.error) || 'Roster load failed');
      }
      state.rows       = r.rows || [];
      state.canEdit    = !!r.can_edit;
      state.shirtSizes = r.shirt_sizes || [];
      state.user       = r.user || '';
      state.role       = r.role || '';
      state.identity   = r.identity_source || null;
      renderRoster();
    } catch (e) {
      renderStatus('⚠️ Could not load the roster: ' + esc((e && e.message) || 'unknown error'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
