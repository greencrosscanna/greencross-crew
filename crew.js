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
                 stores: {}, showRetired: false, retiredTotal: 0, hrSheetUrl: '', q: '',
                 sortKey: 'name', sortDir: 1, mergeFrom: null, onlyFlagged: false };

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

  /* Flags come from the engine so the roster, the UI and any future export share one
     definition of "questionable". A cell clears the moment the underlying value is fixed. */
  function has(row, flag) { return (row.flags || []).indexOf(flag) >= 0; }
  function flagCls(row, flag, base) {
    return (base ? base + ' ' : '') + (has(row, flag) ? 'is-flagged' : '');
  }

  function permitExpiryCell(row) {
    if (!row.permit_expires) return '<span class="is-flagged">—</span>';
    var d = row.permit_days_left;
    var cls = d == null ? '' : d < 0 ? 'permit-bad' : d <= 90 ? 'permit-warn' : 'permit-ok';
    // Only count down when it actually matters — "(1600d)" on a 2031 permit is noise that
    // makes the genuinely urgent ones harder to spot.
    var tail = d == null ? '' : d < 0 ? ' (expired)' : d <= 90 ? ' (' + d + 'd)' : '';
    return '<span class="' + cls + '">' + esc(row.permit_expires) + tail + '</span>';
  }
  function permitActiveCell(row) {
    if (!row.permit_active) return '<span class="is-flagged">—</span>';
    var yes = row.permit_active === 'Yes';
    return '<span class="' + (yes ? 'permit-ok' : 'permit-bad') + '">' + esc(row.permit_active) + '</span>';
  }

  var COLUMNS = [
    { key: 'employee_number', label: '#',            num: true },
    { key: 'name',            label: 'Name' },
    { key: 'store',           label: 'Store',        val: function (r) { return storeName(r.store); } },
    { key: 'role',            label: 'Role' },
    { key: 'hire_date',       label: 'Hired' },
    { key: 'time_with_company', label: 'Time w Co.', num: true,
      val: function (r) { var m = /(\d+)yr (\d+)mo/.exec(r.time_with_company || ''); 
                          return m ? Number(m[1]) * 12 + Number(m[2]) : -1; } },
    { key: 'wage',            label: 'Wage',         num: true },
    { key: 'shirt_size',      label: 'Shirt' },
    { key: 'birthday',        label: 'Birthday' },
    { key: 'permit_active',   label: 'OLCC active' },
    { key: 'permit_expires',  label: 'OLCC expires' }
  ];

  function sortRows(rows) {
    var col = COLUMNS.filter(function (c) { return c.key === state.sortKey; })[0] || COLUMNS[1];
    var dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var av = col.val ? col.val(a) : a[col.key];
      var bv = col.val ? col.val(b) : b[col.key];
      // Blanks ALWAYS sink, whichever column and whichever direction — a missing wage is the
      // absence of a value, not the smallest one, and letting it ride the top of an ascending
      // sort buries the rows you actually wanted to compare.
      if (col.num) {
        var an = parseFloat(av), bn = parseFloat(bv);
        var ab = isNaN(an), bb = isNaN(bn);
        if (ab && !bb) return 1;
        if (!ab && bb) return -1;
        if (ab && bb)  return a.name.localeCompare(b.name);
        return (an - bn) * dir || a.name.localeCompare(b.name);
      }
      var as = String(av || ''), bs = String(bv || '');
      if (!as && bs) return 1;
      if (as && !bs) return -1;
      return as.localeCompare(bs) * dir || a.name.localeCompare(b.name);
    });
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
    var flagged = state.rows.filter(function (r) { return (r.flags || []).length; }).length;
    if (flagged) {
      var fl = el('label', 'crew-toggle');
      fl.innerHTML = '<input type="checkbox"' + (state.onlyFlagged ? ' checked' : '') +
        '> Needs attention (' + flagged + ')';
      fl.querySelector('input').addEventListener('change', function () {
        state.onlyFlagged = this.checked; renderRoster();
      });
      tools.appendChild(fl);
    }
    nodes.push(tools);

    var q = state.q.trim().toLowerCase();
    var base = state.onlyFlagged
      ? state.rows.filter(function (r) { return (r.flags || []).length; }) : state.rows;
    var rows = !q ? base : base.filter(function (r) {
      return (r.name + ' ' + storeName(r.store) + ' ' + r.role + ' ' + r.employee_number).toLowerCase().indexOf(q) >= 0;
    });

    if (!rows.length) {
      nodes.push(el('p', 'gx-muted', q ? 'No one matches “' + esc(state.q) + '”.' : 'No employees to show yet.'));
      mount.appendChild(card('Roster', nodes));
      return;
    }

    var table = el('table', 'crew-table');
    var thead = el('thead'); var htr = el('tr');
    COLUMNS.forEach(function (c) {
      var th = el('th', 'crew-sort' + (state.sortKey === c.key ? ' is-sorted' : ''),
        esc(c.label) + '<span class="crew-caret">' +
        (state.sortKey === c.key ? (state.sortDir === 1 ? '▲' : '▼') : '') + '</span>');
      th.addEventListener('click', function () {
        if (state.sortKey === c.key) state.sortDir = -state.sortDir;
        else { state.sortKey = c.key; state.sortDir = 1; }
        renderRoster();
      });
      htr.appendChild(th);
    });
    htr.appendChild(el('th', null, ''));
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = el('tbody');

    sortRows(rows).forEach(function (row) {
      var tr = el('tr', (row.retired ? 'is-retired' : '') +
                        (state.mergeFrom === row.employee_id ? ' is-merge-src' : ''));

      var tdNum = el('td'); var inNum = el('input');
      inNum.type='text'; inNum.value=row.employee_number||''; inNum.size=3;
      inNum.className='crew-num ' + (has(row,'employee_number')?'is-flagged':'');
      inNum.disabled=!state.canEdit; tdNum.appendChild(inNum);
      tr.appendChild(tdNum);

      tr.appendChild(el('td', null, '<b>' + esc(row.name) + '</b>' +
        (row.retired ? ' <span class="crew-tag">retired</span>' : '')));
      tr.appendChild(el('td', flagCls(row,'store','gx-muted'), esc(row.store ? storeName(row.store) : '—')));
      tr.appendChild(el('td', flagCls(row,'role','gx-muted'), esc(row.role) +
        (row.role_is_default ? '<span title="No role on file — defaulted"> *</span>' : '')));
      tr.appendChild(el('td', flagCls(row,'hire_date','gx-muted'), esc(row.hire_date || '—')));
      tr.appendChild(el('td', 'gx-muted', esc(row.time_with_company || '—')));

      var tdW = el('td'); var inW = el('input');
      inW.type='text'; inW.value=row.wage||''; inW.size=5; inW.placeholder='0.00';
      inW.className = has(row,'wage') ? 'is-flagged' : '';
      inW.disabled=!state.canEdit; tdW.appendChild(inW); tr.appendChild(tdW);

      var tdShirt = el('td'); var sel = el('select');
      sel.innerHTML = '<option value="">—</option>' + state.shirtSizes.map(function (x) {
        return '<option value="'+esc(x)+'"'+(row.shirt_size===x?' selected':'')+'>'+esc(x)+'</option>'; }).join('');
      sel.disabled = !state.canEdit; tdShirt.appendChild(sel); tr.appendChild(tdShirt);

      var tdB = el('td'); var inB = el('input');
      inB.type='text'; inB.placeholder='MM-DD'; inB.value=row.birthday||''; inB.size=6;
      inB.disabled=!state.canEdit; inB.title='Month and day only — GX Crew does not store birth years.';
      inB.className = has(row,'birthday') ? 'is-flagged' : '';
      tdB.appendChild(inB); tr.appendChild(tdB);

      tr.appendChild(el('td', null, permitActiveCell(row)));
      tr.appendChild(el('td', null, permitExpiryCell(row)));

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
              wage: inW.value.trim(), employee_number: inNum.value.trim() },
              { timeoutMs: 45000, retries: 2 });
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
              employee_id: row.employee_id, retired: row.retired ? '0' : '1' },
              { timeoutMs: 45000, retries: 2 });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
            boot(true);
          } catch (e) {
            status.textContent = (e && e.message) || 'Failed';
            status.className = 'crew-save-status err'; ret.disabled = false;
          }
        });
        tdS.appendChild(ret);

        /* Merge is two clicks: mark one row, then pick the row to keep. Duplicates are always
           two rows in this table, so selecting them here beats typing ids into a form. */
        var mg = el('button', 'crew-link crew-merge',
          state.mergeFrom === row.employee_id ? 'Cancel' :
          state.mergeFrom ? 'Keep this one' : 'Merge…');
        mg.addEventListener('click', async function () {
          if (state.mergeFrom === row.employee_id) { state.mergeFrom = null; renderRoster(); return; }
          if (!state.mergeFrom) { state.mergeFrom = row.employee_id; renderRoster(); return; }
          var loser = state.rows.filter(function (x) { return x.employee_id === state.mergeFrom; })[0];
          if (!loser) { state.mergeFrom = null; renderRoster(); return; }
          if (!confirm('Merge "' + loser.name + '" into "' + row.name + '"?\n\n' +
                       row.name + ' is kept. Any field they are missing is filled from ' +
                       loser.name + '. Nothing is deleted, and future imports of "' +
                       loser.name + '" will resolve to ' + row.name + '.')) return;
          status.textContent = 'Merging…';
          try {
            var r = await Engine.jsonp('roster_merge', { token: token(),
              keep: row.employee_id, merge: loser.employee_id, confirm: 'yes' },
              { timeoutMs: 45000, retries: 2 });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Merge failed');
            state.mergeFrom = null; boot(true);
          } catch (e) {
            status.textContent = (e && e.message) || 'Merge failed';
            status.className = 'crew-save-status err';
          }
        });
        tdS.appendChild(mg);
      }
      tdS.appendChild(status); tr.appendChild(tdS);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    var wrap = el('div', 'crew-table-wrap'); wrap.appendChild(table);
    nodes.push(wrap);
    nodes.push(el('p', 'crew-hint',
      'Red marks missing or questionable data — it clears as soon as the value is filled in. ' +
      'Birthdays are month + day only, no birth year. Permit columns are imported from METRC ' +
      'and read-only here. Leaderboard receives a derived celebrations flag, never a date.'));

    mount.appendChild(card('Roster <span class="gx-muted crew-count">' + rows.length +
      (q ? ' of ' + state.rows.length : '') + '</span>', nodes));
  }

  // ─── boot ────────────────────────────────────────────────────────────────────
  async function boot(quiet) {
    if (!window.GXClient) { renderStatus('⚠️ gx-client failed to load — cannot reach GX Core.'); return; }
    if (!token()) { renderLogin(''); return; }

    if (!quiet) renderStatus('Loading roster… <span class="crew-hint">(first load reads GX Core, ~10s)</span>');
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
      /* The roster reads two Google Sheets through the GXCore library; a cold call measured
         ~12s, well past gx-client's 8s default, so every attempt timed out and the view never
         loaded. The engine caches the join for 2 minutes, but the FIRST call still has to pay
         full price — so give it a real budget instead of retrying into the same wall. */
      var r = await Engine.jsonp('roster',
        { token: token(), include_retired: state.showRetired ? '1' : '' },
        { timeoutMs: 45000, retries: 2 });
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
