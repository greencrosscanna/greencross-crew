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
                 sortKey: 'name', sortDir: 1, mergeFrom: null, onlyFlagged: false,
                 view: 'roster', review: null, reviewCounts: {},
                 /* The roster is READ-ONLY until you ask for edit mode. Most visits are to look
                    something up, and a table of live inputs invites a stray keystroke into wage
                    or permit data. Edit mode opens exactly five operational fields; anything
                    structural (name, nickname, store, role, hire date, employee #) stays behind
                    the identity panel, which is a deliberate act rather than a click-through. */
                 editMode: false };

  /* The only fields edit mode opens. Employee number is deliberately NOT here — it is the
     canonical stable key the whole suite joins on, so it belongs with identity, not with
     day-to-day corrections. */
  var EDITABLE_INLINE = ['wage', 'shirt_size', 'birthday', 'permit_number', 'permit_expires'];

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
  /* `corporate` is not a shop and so is deliberately absent from GX Core's store registry —
     it is where the admin team sits. Label it here rather than showing the raw slug. */
  var PSEUDO_STORES = { corporate: 'Corporate' };
  function storeName(id) {
    return id ? (state.stores[id] || PSEUDO_STORES[id] || id) : '—';
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

  /* Flags come from the engine so the roster, the UI and any future export share one
     definition of "questionable". A cell clears the moment the underlying value is fixed. */
  function has(row, flag) { return (row.flags || []).indexOf(flag) >= 0; }
  function flagCls(row, flag, base) {
    return (base ? base + ' ' : '') + (has(row, flag) ? 'is-flagged' : '');
  }

  /* Bare YYYY-MM-DD, matching the Hired column so the two read against each other. Urgency is
     carried by colour and by the banner above the table, not by a "(5d)" tail in the cell. */
  function permitExpiryCell(row) {
    if (!row.permit_expires) return '<span class="is-flagged">—</span>';
    var d = row.permit_days_left;
    var cls = d == null ? '' : d < 0 ? 'permit-bad' : d <= 90 ? 'permit-warn' : 'permit-ok';
    return '<span class="' + cls + '">' + esc(row.permit_expires) + '</span>';
  }
  /* The OLCC column states the permit's standing in METRC's own words — ACTIVE / VALID —
     rather than answering a yes/no question the header no longer asks. */
  function permitStatusCell(row) {
    if (!row.permit_status) return '<span class="is-flagged">—</span>';
    var good = ['active', 'valid'].indexOf(String(row.permit_status).toLowerCase()) >= 0;
    return '<span class="' + (good ? 'permit-active' : 'permit-bad') + '">' +
           esc(String(row.permit_status).toUpperCase()) + '</span>';
  }
  function permitNumberCell(row) {
    if (!row.permit_number) return '<span class="is-flagged">—</span>';
    return '<span class="crew-permit-no">' + esc(row.permit_number) + '</span>';
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
    { key: 'shirt_size',      label: 'Tee' },
    { key: 'birthday',        label: 'Birthday' },
    { key: 'permit_number',   label: 'OLCC permit #' },
    { key: 'permit_status',   label: 'OLCC' },
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


  /* ── Review queue ──────────────────────────────────────────────────────────
     Cross-source disagreements, surfaced for a human. Nothing here has been applied;
     every item is a question with three honest answers — take the proposed value, keep
     what we have, or it is not a problem. All three are recorded, because "I looked and
     it is fine" has to silence an item as firmly as a correction does. */
  var KIND_LABEL = {
    duplicate:           'Possible duplicate',
    retired_with_access: 'Retired, still has access',
    missing_permit:      'No OLCC permit on file',
    permit_expired:      'Permit expired',
    permit_expiring:     'Permit expiring',
    missing_field:       'Missing data',
    name_spelling:       'Name spelling differs',
    role:                'Role differs'
  };

  /* Repaint just the count on the Review tab, leaving resolved items and their ✓ in place. */
  function refreshBadge() {
    var n = state.reviewCounts || {};
    var open = (n.high || 0) + (n.warn || 0);
    var tab = document.querySelectorAll('.crew-tab')[1];
    if (!tab) return;
    var badge = tab.querySelector('.crew-badge');
    if (!open) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = el('span', 'crew-badge');
      tab.appendChild(badge);
    }
    badge.textContent = open;
    badge.className = 'crew-badge' + (n.high ? ' is-high' : '');
  }

  function navBar() {
    var nav = el('div', 'crew-nav');
    [['roster', 'Roster'], ['review', 'Review']].forEach(function (v) {
      var n = state.reviewCounts || {};
      var badge = '';
      if (v[0] === 'review' && (n.high || n.warn)) {
        badge = ' <span class="crew-badge' + (n.high ? ' is-high' : '') + '">' +
                ((n.high || 0) + (n.warn || 0)) + '</span>';
      }
      var b = el('button', 'crew-tab' + (state.view === v[0] ? ' is-active' : ''), v[1] + badge);
      b.addEventListener('click', function () {
        state.view = v[0];
        if (v[0] === 'review' && !state.review) loadReview(); else render();
      });
      nav.appendChild(b);
    });
    return nav;
  }

  async function loadReview() {
    renderStatus('Checking for misalignments…');
    try {
      var r = await Engine.jsonp('review', { token: token() }, { timeoutMs: 45000, retries: 2 });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Review load failed');
      state.review = r.items || [];
      state.reviewCounts = r.counts || {};
      render();
    } catch (e) {
      renderStatus('⚠️ Could not load the review queue: ' + esc((e && e.message) || 'unknown error'));
    }
  }

  function renderReview() {
    clear();
    var nodes = [navBar()];
    var items = state.review || [];

    if (!items.length) {
      nodes.push(el('p', 'crew-allclear', '✓ Nothing to review — every source agrees.'));
      mount.appendChild(card('Review', nodes));
      return;
    }

    nodes.push(el('p', 'gx-muted crew-review-intro',
      'Where the HR sheet, METRC and Leaderboard disagree. <b>Nothing here has been applied.</b> ' +
      'Each answer is recorded, so a resolved item stays gone — but if the underlying values ' +
      'change it will come back as a new question.'));

    items.forEach(function (it) {
      var box = el('div', 'crew-review crew-review-' + it.severity);
      var head = el('div', 'crew-review-head');
      head.innerHTML = '<span class="crew-review-kind">' + esc(KIND_LABEL[it.kind] || it.kind) +
        '</span><b>' + esc(it.name) + '</b>' +
        '<span class="crew-review-src">' + esc(it.source) + '</span>';
      box.appendChild(head);
      if (it.detail) box.appendChild(el('p', 'crew-review-detail', esc(it.detail)));

      if (it.current_value || it.proposed_value) {
        var cmp = el('div', 'crew-review-cmp');
        cmp.innerHTML =
          '<span class="crew-review-col"><em>now</em>' +
            (it.current_value ? esc(it.current_value) : '<span class="crew-hint">—</span>') + '</span>' +
          '<span class="crew-review-arrow">→</span>' +
          '<span class="crew-review-col is-proposed"><em>' +
            (it.kind === 'duplicate' ? 'keep' : 'proposed') + '</em>' +
            (it.proposed_value ? esc(it.proposed_value) : '<span class="crew-hint">—</span>') + '</span>';
        box.appendChild(cmp);
      }

      if (state.canEdit) {
        var acts = el('div', 'crew-review-acts');
        var status = el('span', 'crew-save-status');
        var actionable = ['duplicate', 'name_spelling', 'role'].indexOf(it.kind) >= 0;
        [[ 'accept', actionable ? (it.kind === 'duplicate' ? 'Merge them' : 'Apply') : 'Mark handled', 'primary'],
         [ 'keep',    'Current is correct', ''],
         [ 'dismiss', 'Not a problem', '']].forEach(function (a) {
          var b = el('button', 'crew-save' + (a[2] === 'primary' ? ' is-primary' : ''), a[1]);
          b.addEventListener('click', async function () {
            if (it.kind === 'duplicate' && a[0] === 'accept' &&
                !confirm('Merge "' + it.merge_from_name + '" into "' + it.name + '"?\n\n' +
                         'Nothing is deleted, and future imports of "' + it.merge_from_name +
                         '" will resolve to ' + it.name + '.')) return;
            acts.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
            status.textContent = 'Saving…'; status.className = 'crew-save-status';
            try {
              var r = await Engine.jsonp('review_resolve',
                { token: token(), id: it.id, choice: a[0] }, { timeoutMs: 45000, retries: 2 });
              if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
              box.classList.add('is-done');
              status.textContent = '✓ ' + (r.applied || a[1]);
              status.className = 'crew-save-status ok';
              state.review = state.review.filter(function (x) { return x.id !== it.id; });
              state.reviewCounts[it.severity] = Math.max(0, (state.reviewCounts[it.severity] || 1) - 1);
              state.rows = [];   // roster is stale after any of these
              // Update the badge in place. Re-rendering would be simpler but would wipe the ✓
              // confirmations off every item resolved so far, which is the feedback that tells
              // you the queue is actually going down.
              refreshBadge();
            } catch (e) {
              status.textContent = (e && e.message) || 'Failed';
              status.className = 'crew-save-status err';
              acts.querySelectorAll('button').forEach(function (x) { x.disabled = false; });
            }
          });
          acts.appendChild(b);
        });
        acts.appendChild(status);
        box.appendChild(acts);
      }
      nodes.push(box);
    });

    mount.appendChild(card('Review <span class="gx-muted crew-count">' + items.length + '</span>', nodes));
  }

  function render() {
    if (state.view === 'review') renderReview();
    else renderRoster();
  }

  function renderRoster() {
    if (!state.rows.length && state.view === 'roster' && state.review) { boot(true); return; }
    clear();
    var nodes = [navBar()];

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
    if (state.canEdit) {
      var em = el('label', 'crew-toggle crew-editmode' + (state.editMode ? ' is-on' : ''));
      em.innerHTML = '<input type="checkbox"' + (state.editMode ? ' checked' : '') + '> Edit mode';
      em.querySelector('input').addEventListener('change', function () {
        state.editMode = this.checked; renderRoster();
      });
      tools.appendChild(em);
    }
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
      var editing = state.canEdit && state.editMode;
      var tr = el('tr', (row.retired ? 'is-retired' : '') +
                        (state.mergeFrom === row.employee_id ? ' is-merge-src' : ''));

      // Read-only here on purpose: employee_number is the canonical key every app joins on.
      // Changing it is an identity decision, so it lives in the panel.
      tr.appendChild(el('td', flagCls(row, 'employee_number', 'crew-numcell'),
        esc(row.employee_number || '—')));

      tr.appendChild(el('td', null, '<b>' + esc(row.name) + '</b>' +
        (row.preferred_name ? ' <span class="crew-nick">“' + esc(row.preferred_name) + '”</span>' : '') +
        (row.retired ? ' <span class="crew-tag">retired</span>' : '')));
      tr.appendChild(el('td', flagCls(row,'store','gx-muted'), esc(row.store ? storeName(row.store) : '—')));
      tr.appendChild(el('td', flagCls(row,'role','gx-muted'), esc(row.role) +
        (row.role_is_default ? '<span title="No role on file — defaulted"> *</span>' : '')));
      tr.appendChild(el('td', flagCls(row,'hire_date','gx-muted'), esc(row.hire_date || '—')));
      tr.appendChild(el('td', 'gx-muted', esc(row.time_with_company || '—')));

      var tdW = el('td'); var inW = el('input');
      inW.type='text'; inW.value=row.wage||''; inW.size=5; inW.placeholder='0.00';
      inW.className = has(row,'wage') ? 'is-flagged' : '';
      inW.disabled=!editing; tdW.appendChild(inW); tr.appendChild(tdW);

      var tdShirt = el('td'); var sel = el('select');
      sel.innerHTML = '<option value="">—</option>' + state.shirtSizes.map(function (x) {
        return '<option value="'+esc(x)+'"'+(row.shirt_size===x?' selected':'')+'>'+esc(x)+'</option>'; }).join('');
      sel.disabled = !editing; tdShirt.appendChild(sel); tr.appendChild(tdShirt);

      var tdB = el('td'); var inB = el('input');
      inB.type='text'; inB.placeholder='MM-DD'; inB.value=row.birthday||''; inB.size=6;
      inB.disabled=!editing; inB.title='Month and day only — GX Crew does not store birth years.';
      inB.className = has(row,'birthday') ? 'is-flagged' : '';
      tdB.appendChild(inB); tr.appendChild(tdB);

      var tdPn = el('td'); var inPn = el('input');
      inPn.type='text'; inPn.value=row.permit_number||''; inPn.size=8; inPn.placeholder='permit #';
      inPn.className='crew-permit-no' + (has(row,'permit') ? ' is-flagged' : '');
      inPn.disabled=!editing; tdPn.appendChild(inPn); tr.appendChild(tdPn);

      tr.appendChild(el('td', null, permitStatusCell(row)));

      var tdPe = el('td'); var inPe = el('input');
      inPe.type='date'; inPe.value=row.permit_expires||'';
      inPe.className = (row.permit_days_left != null && row.permit_days_left < 0) ? 'is-flagged' : '';
      inPe.disabled=!editing; tdPe.appendChild(inPe); tr.appendChild(tdPe);

      var tdS = el('td', 'crew-actions'); var status = el('span', 'crew-save-status');
      if (editing) {
        var save = el('button', 'crew-save', 'Save'); save.disabled = true;
        var dirty = function () { save.disabled = false; status.textContent = ''; };
        [sel, inB, inW, inPn, inPe].forEach(function (f) { f.addEventListener('input', dirty); f.addEventListener('change', dirty); });
        save.addEventListener('click', async function () {
          save.disabled = true; status.textContent = 'Saving…'; status.className = 'crew-save-status';
          try {
            var r = await Engine.jsonp('roster_save', { token: token(), employee_id: row.employee_id,
              shirt_size: sel.value, birthday: inB.value.trim(),
              wage: inW.value.trim(),
              permit_number: inPn.value.trim(), permit_expires: inPe.value },
              { timeoutMs: 45000, retries: 2 });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Save failed');
            row.shirt_size = r.saved.shirt_size; row.birthday = r.saved.birthday;
            row.wage = r.saved.wage;
            row.permit_number = r.saved.permit_number; row.permit_expires = r.saved.permit_expires;
            inB.value = row.birthday; inW.value = row.wage;
            inPn.value = row.permit_number; inPe.value = row.permit_expires;
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

        /* Identity lives in GX Core, not Crew, so it gets a deliberate panel rather than another
           six inline inputs — and the panel says plainly which linking columns are being
           preserved, because those are the ones a careless write destroys. */
        var ed = el('button', 'crew-link crew-edit', 'Edit');
        ed.addEventListener('click', function () {
          var open = tr.nextSibling && tr.nextSibling.classList &&
                     tr.nextSibling.classList.contains('crew-editrow');
          if (open) { tr.nextSibling.remove(); ed.textContent = 'Edit'; return; }
          ed.textContent = 'Close';
          var erow = el('tr', 'crew-editrow');
          var cell = el('td'); cell.colSpan = COLUMNS.length + 1;
          var form = el('div', 'crew-editform');
          var storeOpts = ['<option value="">— none —</option>']
            .concat(Object.keys(state.stores).map(function (sid) {
              return '<option value="' + esc(sid) + '"' + (row.store === sid ? ' selected' : '') + '>' +
                     esc(state.stores[sid]) + '</option>'; }))
            .concat(['<option value="corporate"' + (row.store === 'corporate' ? ' selected' : '') +
                     '>Corporate</option>']).join('');
          form.innerHTML =
            '<label>Full name<input name="full_name" value="' + esc(row.name) + '"></label>' +
            '<label>Nickname<input name="preferred_name" value="' + esc(row.preferred_name || '') +
              '" placeholder="shown on the board"></label>' +
            '<label>Store<select name="home_store">' + storeOpts + '</select></label>' +
            '<label>Role<input name="role_title" value="' + esc(row.role_is_default ? '' : row.role) +
              '" placeholder="Budtender"></label>' +
            '<label>Hire date<input name="hire_date" type="date" value="' + esc(row.hire_date || '') + '"></label>' +
            /* Shown, never editable. The number is issued by the system and never reused —
               typing one risks handing a new person a retired employee's history. */
            '<label>Employee #<input value="' + esc(row.employee_number || 'auto') +
              '" size="4" disabled title="Assigned automatically — never reused"></label>';
          var linked = [];
          if (row.dutchie_employee_id) linked.push('Dutchie ' + row.dutchie_employee_id);
          if (row.user_id) linked.push('account ' + row.user_id);
          if (row.employee_number) linked.push('employee #' + row.employee_number);
          var note = el('p', 'crew-editnote', linked.length
            ? 'Linked and preserved on save: ' + esc(linked.join(' · '))
            : 'No Dutchie id or account linked to this record.');
          var acts = el('div', 'crew-editacts');
          var st2 = el('span', 'crew-save-status');
          var go = el('button', 'crew-save is-primary', 'Save identity');
          go.addEventListener('click', async function () {
            go.disabled = true; st2.textContent = 'Saving…'; st2.className = 'crew-save-status';
            try {
              var q = { token: token(), employee_id: row.employee_id };
              ['full_name','preferred_name','home_store','role_title','hire_date'].forEach(function (f) {
                q[f] = form.querySelector('[name=' + f + ']').value;
              });
              var r = await Engine.jsonp('roster_identity', q, { timeoutMs: 45000, retries: 2 });
              if (!r || !r.ok) throw new Error((r && r.error) || 'Save failed');

              st2.textContent = '✓ ' + (r.changed.length ? 'updated ' + r.changed.join(', ') : 'no change');
              st2.className = 'crew-save-status ok';
              state.rows = []; state.review = null;
              setTimeout(function () { boot(true); }, 700);
            } catch (e) {
              st2.textContent = (e && e.message) || 'Save failed';
              st2.className = 'crew-save-status err'; go.disabled = false;
            }
          });
          acts.appendChild(go); acts.appendChild(st2);
          cell.appendChild(form); cell.appendChild(note); cell.appendChild(acts);
          erow.appendChild(cell);
          tr.parentNode.insertBefore(erow, tr.nextSibling);
        });
        tdS.appendChild(ed);
      }
      tdS.appendChild(status); tr.appendChild(tdS);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    var wrap = el('div', 'crew-table-wrap'); wrap.appendChild(table);
    nodes.push(wrap);
    nodes.push(el('p', 'crew-hint',
      (state.canEdit && !state.editMode
        ? 'Read-only. Turn on <b>Edit mode</b> to change wage, tee, birthday or OLCC details. ' : '') +
      'Employee numbers are assigned automatically and never reused. ' +
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
      // Pull the review count in the background so the tab badge is right without making the
      // roster wait on a second slow read.
      if (!state.review) {
        Engine.jsonp('review', { token: token() }, { timeoutMs: 45000, retries: 1 })
          .then(function (rv) {
            if (rv && rv.ok) {
              state.review = rv.items || []; state.reviewCounts = rv.counts || {};
              if (state.view === 'roster') renderRoster();
            }
          }).catch(function () { /* badge is a nicety */ });
      }
    } catch (e) {
      renderStatus('⚠️ Could not load the roster: ' + esc((e && e.message) || 'unknown error'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
