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
  var state  = { rows: [], canEdit: false, shirtSizes: [], user: '', role: '', identity: null,
                 stores: {}, showRetired: false, retiredTotal: 0, hrSheetUrl: '', q: '' };

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

  /* Store display names come from GX Core's registry, so Crew shows "Century" and "Baseline"
     like every other app instead of inventing its own labels from the store_id slug. */
  async function loadStores() {
    try {
      var r = await GXCore.jsonp('stores', {}, { retries: 1, timeoutMs: 6000 });
      (r && r.stores || []).forEach(function (s) { state.stores[s.store_id] = s.display_name || s.store_id; });
    } catch (e) { /* fall back to the raw slug */ }
  }
  function storeName(id) { return id ? (state.stores[id] || id) : '—'; }

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

  function permitCell(row) {
    if (!row.permit_expires) return '<span class="crew-hint">—</span>';
    var d = row.permit_days_left;
    var cls = d == null ? '' : d < 0 ? 'permit-bad' : d <= 90 ? 'permit-warn' : 'permit-ok';
    // Only count down when it actually matters — "(1600d)" on a 2031 permit is noise that
    // makes the genuinely urgent ones harder to spot.
    var tail = d == null ? '' : d < 0 ? ' (expired)' : d <= 90 ? ' (' + d + 'd)' : '';
    return '<span class="' + cls + '">' + esc(row.permit_expires) + tail + '</span>';
  }

  function renderRoster() {
    clear();
    var nodes = [];

    var bar = el('div', 'crew-bar');
    bar.innerHTML = '<span>Signed in as <b>' + esc(state.user) + '</b> · ' + esc(state.role) +
      (state.canEdit ? '' : ' <em>(read-only)</em>') + '</span>';
    var right = el('span', 'crew-bar-right');
    if (state.hrSheetUrl) {
      right.innerHTML = '<a class="crew-link" href="' + esc(state.hrSheetUrl) +
        '" target="_blank" rel="noopener">HR staff sheet ↗</a>';
    }
    var out = el('button', 'crew-link', 'Sign out');
    out.addEventListener('click', function () { setSession('', ''); boot(); });
    right.appendChild(out);
    bar.appendChild(right);
    nodes.push(bar);

    if (state.identity && state.identity.note) nodes.push(banner('warn', esc(state.identity.note)));
    if (state.identity && state.identity.error)
      nodes.push(banner('error', 'GX Core identity read failed: ' + esc(state.identity.error)));

    // expiring permits are the reason this data is here — surface them, don't make people scan
    var soon = state.rows.filter(function (r) { return r.permit_days_left != null && r.permit_days_left <= 90; })
                         .sort(function (a, b) { return a.permit_days_left - b.permit_days_left; });
    if (soon.length) {
      nodes.push(banner(soon.some(function (r) { return r.permit_days_left < 0; }) ? 'error' : 'warn',
        '<b>' + soon.length + ' OLCC permit' + (soon.length > 1 ? 's' : '') + ' need attention:</b> ' +
        soon.map(function (r) {
          return esc(r.name) + ' — ' + (r.permit_days_left < 0 ? 'EXPIRED' : r.permit_days_left + 'd');
        }).join(' · ')));
    }

    var tools = el('div', 'crew-tools');
    var search = el('input', 'crew-search');
    search.type = 'search'; search.placeholder = 'Filter by name, store or role…'; search.value = state.q;
    search.addEventListener('input', function () { state.q = search.value; renderRoster();
      var s2 = document.querySelector('.crew-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } });
    tools.appendChild(search);
    var lbl = el('label', 'crew-toggle');
    lbl.innerHTML = '<input type="checkbox"' + (state.showRetired ? ' checked' : '') + '> Show retired' +
      (state.retiredTotal ? ' (' + state.retiredTotal + ')' : '');
    lbl.querySelector('input').addEventListener('change', function () {
      state.showRetired = this.checked; boot(true);
    });
    tools.appendChild(lbl);
    nodes.push(tools);

    var q = state.q.trim().toLowerCase();
    var rows = !q ? state.rows : state.rows.filter(function (r) {
      return (r.name + ' ' + storeName(r.store) + ' ' + r.role + ' ' + r.employee_number).toLowerCase().indexOf(q) >= 0;
    });

    if (!rows.length) {
      nodes.push(el('p', 'gx-muted', q ? 'No one matches “' + esc(state.q) + '”.' : 'No employees to show yet.'));
      mount.appendChild(card('Roster', nodes));
      return;
    }

    var table = el('table', 'crew-table');
    table.innerHTML =
      '<thead><tr>' +
        '<th>#</th><th>Name</th><th>Store</th><th>Role</th>' +
        '<th>Hired</th><th>Time w Co.</th><th>Wage</th>' +
        '<th>Shirt</th><th>Birthday</th><th>OLCC permit</th><th></th>' +
      '</tr></thead>';
    var tbody = el('tbody');

    rows.forEach(function (row) {
      var tr = el('tr', row.retired ? 'is-retired' : '');

      var tdNum = el('td'); var inNum = el('input');
      inNum.type='text'; inNum.value=row.employee_number||''; inNum.size=3;
      inNum.className='crew-num'; inNum.disabled=!state.canEdit; tdNum.appendChild(inNum);
      tr.appendChild(tdNum);

      tr.appendChild(el('td', null, '<b>' + esc(row.name) + '</b>' +
        (row.retired ? ' <span class="crew-tag">retired</span>' : '')));
      tr.appendChild(el('td', 'gx-muted', esc(storeName(row.store))));
      tr.appendChild(el('td', 'gx-muted', esc(row.role) +
        (row.role_is_default ? '<span class="crew-hint" title="No role on file — defaulted"> *</span>' : '')));
      tr.appendChild(el('td', 'gx-muted', esc(row.hire_date || '—')));
      tr.appendChild(el('td', 'gx-muted', esc(row.time_with_company || '—')));

      var tdW = el('td'); var inW = el('input');
      inW.type='text'; inW.value=row.wage||''; inW.size=5; inW.placeholder='0.00';
      inW.disabled=!state.canEdit; tdW.appendChild(inW); tr.appendChild(tdW);

      var tdShirt = el('td'); var sel = el('select');
      sel.innerHTML = '<option value="">—</option>' + state.shirtSizes.map(function (x) {
        return '<option value="'+esc(x)+'"'+(row.shirt_size===x?' selected':'')+'>'+esc(x)+'</option>'; }).join('');
      sel.disabled = !state.canEdit; tdShirt.appendChild(sel); tr.appendChild(tdShirt);

      var tdB = el('td'); var inB = el('input');
      inB.type='text'; inB.placeholder='MM-DD'; inB.value=row.birthday||''; inB.size=6;
      inB.disabled=!state.canEdit; inB.title='Month and day only — GX Crew does not store birth years.';
      tdB.appendChild(inB); tr.appendChild(tdB);

      tr.appendChild(el('td', null, permitCell(row)));

      var tdS = el('td', 'crew-actions'); var status = el('span', 'crew-save-status');
      if (state.canEdit) {
        var save = el('button', 'crew-save', 'Save'); save.disabled = true;
        var dirty = function () { save.disabled = false; status.textContent = ''; };
        [sel, inB, inW, inNum].forEach(function (f) { f.addEventListener('input', dirty); f.addEventListener('change', dirty); });
        save.addEventListener('click', async function () {
          save.disabled = true; status.textContent = 'Saving…'; status.className = 'crew-save-status';
          try {
            var r = await Engine.jsonp('roster_save', { token: token(), employee_id: row.employee_id,
              shirt_size: sel.value, birthday: inB.value.trim(),
              wage: inW.value.trim(), employee_number: inNum.value.trim() });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Save failed');
            row.shirt_size = r.saved.shirt_size; row.birthday = r.saved.birthday;
            row.wage = r.saved.wage; row.employee_number = r.saved.employee_number;
            inB.value = row.birthday; inW.value = row.wage; inNum.value = row.employee_number;
            status.textContent = 'Saved'; status.className = 'crew-save-status ok';
          } catch (e) {
            status.textContent = (e && e.message) || 'Save failed';
            status.className = 'crew-save-status err'; save.disabled = false;
          }
        });
        tdS.appendChild(save);

        var ret = el('button', 'crew-link crew-retire', row.retired ? 'Un-retire' : 'Retire');
        ret.addEventListener('click', async function () {
          if (!row.retired && !confirm('Retire ' + row.name + '?\n\nThey drop out of the roster but keep their record, permit history and employee number.')) return;
          ret.disabled = true; status.textContent = '…';
          try {
            var r = await Engine.jsonp('roster_retire', { token: token(),
              employee_id: row.employee_id, retired: row.retired ? '0' : '1' });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
            boot(true);
          } catch (e) {
            status.textContent = (e && e.message) || 'Failed';
            status.className = 'crew-save-status err'; ret.disabled = false;
          }
        });
        tdS.appendChild(ret);
      }
      tdS.appendChild(status); tr.appendChild(tdS);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    var wrap = el('div', 'crew-table-wrap'); wrap.appendChild(table);
    nodes.push(wrap);
    nodes.push(el('p', 'crew-hint',
      'Birthdays are month + day only — no birth year. Permit data is imported from METRC and is ' +
      'read-only here. Leaderboard receives a derived celebrations flag, never a date.'));

    mount.appendChild(card('Roster <span class="gx-muted crew-count">' + rows.length +
      (q ? ' of ' + state.rows.length : '') + '</span>', nodes));
  }

  // ─── boot ────────────────────────────────────────────────────────────────────
  async function boot(quiet) {
    if (!window.GXClient) { renderStatus('⚠️ gx-client failed to load — cannot reach GX Core.'); return; }
    if (!token()) { renderLogin(''); return; }

    if (!quiet) renderStatus('Loading roster…');
    if (!Object.keys(state.stores).length) await loadStores();

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
      var r = await Engine.jsonp('roster', { token: token(),
        include_retired: state.showRetired ? '1' : '' });
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
      state.retiredTotal = r.retired_total || 0;
      state.hrSheetUrl = r.hr_sheet_url || '';
      renderRoster();
    } catch (e) {
      renderStatus('⚠️ Could not load the roster: ' + esc((e && e.message) || 'unknown error'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
