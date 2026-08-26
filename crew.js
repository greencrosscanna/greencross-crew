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
  var AVATAR_KEY = 'gx_crew_avatar';
  /* Single-sourced from the ?v=N cache-buster on this script tag -- the same value deploy.sh records,
     so the version in the user menu can never drift from the version that shipped.
     Accepts a bare integer (v26) AND the MAJOR.MINOR form (v1.27) the suite is moving to, so this
     parser is not the thing standing in the way of the switch. The optional group matters: a plain
     \d+ against "1.27" matches "1" and reports v1 -- a version that looks plausible, sorts wrong,
     and collides with a real one. Failing loudly would have been kinder, so do not narrow it back. */
  var APP_VERSION = (function () {
    var m = /[?&]v=(\d+(?:\.\d+)?)/.exec((document.currentScript && document.currentScript.src) || '');
    return m ? 'v' + m[1] : 'dev';
  })();

  var mount = document.getElementById('app');
  var GXCore = window.GXClient(GXCORE_URL);
  var Engine = null;           // built once we know the engine URL
  /* ── Workspace state ────────────────────────────────────────────────────────
   * One roster screen: a permanent people list on the left, and a right pane that is either
   * ONE person's whole record or — when nobody is selected — the queue of everything that needs
   * a decision. The Review and EoM tabs are gone; their content lives in that overview.
   *
   * There is no edit mode. Every control is live and commits on its own, which is why the state
   * below carries no `editMode`, no per-row `openId` and no dirty flag: there is nothing to arm
   * and nothing to forget to press. `dismissed` and `celebrations` are the optimistic overlays
   * that let a resolved question disappear and a checkbox move before the write comes back.
   */
  var state  = { rows: [], canEdit: false, shirtSizes: [], roleTitles: [], user: '', role: '', identity: null,
                 stores: {}, storeOrder: {}, storeFilter: {},
                 retiredTotal: 0, q: '',
                 /* 'active' | 'attention' | 'retired'. Replaces the old showRetired + onlyFlagged
                    checkbox pair, which could be combined into readings nobody meant. Entering
                    `retired` triggers the same refetch showRetired used to, once. */
                 scope: 'active', fetchedRetired: false,
                 selected: null,           // employee_id, or null for the overview
                 review: null, reviewCounts: {}, reviewErr: '',
                 eom: undefined,           // undefined = not loaded yet; null = nobody holds it
                 eomHistory: undefined, eomHistoryErr: '',
                 dismissed: {},            // review ids resolved in this session
                 avatarOpen: false, merging: false };


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
  /* Also unwinds the workspace shell. Login and the status card render into this same mount, and
     a full-height flex column is the wrong frame for a centred card. */
  function clear() {
    mount.innerHTML = '';
    mount.classList.remove('is-ws');
    document.body.classList.remove('crew-ws');
    ui = null;
  }

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
  function setSession(t, u, avatarCfg) {
    try {
      if (t) {
        sessionStorage.setItem(TOKEN_KEY, t);
        sessionStorage.setItem(USER_KEY, u || '');
        sessionStorage.setItem(AVATAR_KEY, avatarCfg ? JSON.stringify(avatarCfg) : '');
      } else {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(USER_KEY);
        sessionStorage.removeItem(AVATAR_KEY);
      }
    } catch (e) {}
  }
  function currentAvatar() {
    try { var raw = sessionStorage.getItem(AVATAR_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
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
      /* sort_order comes along because the filter pills below render in registry order. Falling
         back to the array index rather than 0 keeps a registry that ever stops sending the column
         in ITS OWN order instead of collapsing every store to a tie. */
      (r && r.stores || []).forEach(function (s, i) {
        state.stores[s.store_id] = s.display_name || s.store_id;
        state.storeOrder[s.store_id] = (s.sort_order != null && s.sort_order !== '') ? Number(s.sort_order) : i;
      });
    } catch (e) { /* fall back to the raw slug */ }
  }
  /* `corporate` is not a shop and so is deliberately absent from GX Core's store registry —
     it is where the admin team sits. Label it here rather than showing the raw slug. */
  var PSEUDO_STORES = { corporate: 'Corporate' };
  function storeName(id) {
    return id ? (state.stores[id] || PSEUDO_STORES[id] || id) : '—';
  }

  /* ── Store filter pills ──────────────────────────────────────────────────────────
   * Multi-select. With nothing chosen every store shows; each pill toggles its own store in and
   * out. "All" is the RESET, not a seventh choice — it lights up exactly when the filter is empty,
   * so the row always shows a live state instead of an ambiguous nothing-selected.
   *
   * The pill SET comes from the loaded roster, not from the store registry. Two reasons, and both
   * would be bugs the other way round: a store with nobody in it is not a filter anyone needs, and
   * `corporate` is deliberately ABSENT from the registry (it is not a shop), so a registry-driven
   * row would silently make the admin team unreachable.
   *
   * The COUNT beside each is computed after the search and flagged filters but BEFORE this one, so
   * the numbers stay truthful while you type and do not shift depending on which pill you last
   * pressed. A zero-count pill dims rather than disappearing — a row that reflows under the cursor
   * is how you click the wrong store.
   */
  function storesInRoster(rows) {
    var seen = {}, ids = [];
    (rows || []).forEach(function (r) {
      var id = String(r.store || '');
      if (!(id in seen)) { seen[id] = true; ids.push(id); }
    });
    ids.sort(function (a, b) {
      if (!a) return 1;                       // "no store" is a defect bucket — keep it last
      if (!b) return -1;
      var oa = state.storeOrder[a], ob = state.storeOrder[b];
      if (oa == null && ob == null) return storeName(a).localeCompare(storeName(b));
      if (oa == null) return 1;               // pseudo-stores (corporate) sit after the real shops
      if (ob == null) return -1;
      return oa - ob;
    });
    return ids;
  }

  /* Colours come from GXStores, which paints them from the same registry every other app reads —
     so Center is the same blue here as on the kiosk. Guarded and optional: the shared script loads
     from Pages behind a cache, and a pill row is not worth throwing over a missing swatch. */
  function storeColor(id) {
    try { return (window.GXStores && GXStores.color && GXStores.color(id)) || ''; }
    catch (e) { return ''; }
  }

  function filterByStore(rows) {
    if (!Object.keys(state.storeFilter).length) return rows;
    return rows.filter(function (r) { return !!state.storeFilter[String(r.store || '')]; });
  }

  /* Rebuilding the row drops focus, which for a keyboard user means the pill they just pressed
     stops existing mid-press. Put it back by key rather than by index — the set can reorder. */
  function refocusPill(key) {
    var list = document.querySelectorAll('.crew-pill');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-store') === key) { list[i].focus(); return; }
    }
  }

  function storePills(matched) {
    var ids = storesInRoster(state.rows);
    if (ids.length < 2) return null;      // one bucket: a filter with a single option is just noise
    var counts = {};
    (matched || []).forEach(function (r) {
      var id = String(r.store || '');
      counts[id] = (counts[id] || 0) + 1;
    });
    var wrap = el('div', 'crew-pills');

    /* No "All" pill any more. It was the reset for a row that had no other way back, and the
       workspace has one: a selected pill toggles itself off. Keeping it would have meant a
       control whose only job is to undo the control beside it. */
    ids.forEach(function (id) {
      var n  = counts[id] || 0;
      var on = !!state.storeFilter[id];
      var b = el('button', 'crew-pill' + (on ? ' is-on' : '') + (n ? '' : ' is-empty'),
        '<span class="crew-pill-dot"></span>' + esc(id ? storeName(id) : 'No store') +
        ' <span class="crew-pill-n">' + n + '</span>');
      b.type = 'button';
      b.setAttribute('data-store', id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var c = storeColor(id);
      if (c) b.style.setProperty('--crew-pill-color', c);
      b.addEventListener('click', function () {
        if (state.storeFilter[id]) delete state.storeFilter[id];
        else state.storeFilter[id] = true;
        paintSubnav(); paintRail(); refocusPill(id);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }


  /* ── Avatars ────────────────────────────────────────────────────────────────
   * buildAvatarUrl and the GC hat SVG are lifted VERBATIM from Leaderboard so a face is
   * byte-identical in both apps. Do not "tidy" the parameter rules — each one encodes a
   * DiceBear quirk: `_none` means probability 0 and skip the colour, `_gchat` renders
   * shortFlat underneath with our hat overlaid, and hat/winterHat1 take hatColor rather
   * than hairColor. Leaderboard keeps only these render bits; Crew owns the data.
   */
  var GC_HAT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 280.01"><g><g><path d="M86.239,62.287c48.508-3.223,59.204-3.223,107.712,0,2.156,9.668,18.16,23.768,9.425,19.336-13.835-7.019-113.784-7.302-125.645.412-6.37,4.143,6.352-10.08,8.507-19.748Z" fill="#2c302d" stroke="#000" stroke-linejoin="round" stroke-width="4"/><path d="M86.7,67.121c-6.468-46.192,32.82-57.199,53.6-57.199,23.549,0,59.586,11.007,53.119,57.199h-106.718Z" fill="#2c302d" stroke="#000" stroke-linejoin="round" stroke-width="4"/><path d="M140.3,4.3c2.679,0,4.851.598,4.851,3.268s-1.931,2.341-4.61,2.341-5.091.329-5.091-2.341,2.172-3.268,4.851-3.268Z"/></g><path d="M146.709,23.878l.003,4.438c0,1.872-1.514,3.387-3.387,3.387l-.003-6.751c0-.578-.468-1.074-1.074-1.074h-4.02c-.578,0-1.074.496-1.074,1.074l-.029,6.405c0,1.873-1.514,3.387-3.359,3.387h-6.334c-.578,0-1.074.496-1.074,1.074v4.02c0,.606.496,1.074,1.074,1.074h4.998c.579,0,1.074-.468,1.074-1.074v-.22c0-1.983,1.597-3.58,3.58-3.58v4.681c0,1.983-1.597,3.58-3.58,3.58h-7.146c-1.982,0-3.58-1.597-3.58-3.58v-5.755c0-1.982,1.597-3.607,3.58-3.607h7.418s0-.748,0-.748l-.008-6.731c0-1.982,1.625-3.58,3.607-3.58h5.755c1.983,0,3.58,1.597,3.58,3.58ZM133.769,51.891l-.003-4.438c0-1.872,1.514-3.387,3.387-3.387l.003,6.751c0,.578.468,1.074,1.074,1.074h4.02c.578,0,1.074-.496,1.074-1.074l-.008-6.751c1.873,0,3.387,1.515,3.387,3.387l.008,4.438c0,1.982-1.625,3.58-3.607,3.58h-5.755c-1.983,0-3.58-1.597-3.58-3.58ZM157.192,44.365h-10.415c-1.982,0-3.58-1.597-3.58-3.58v-5.755c0-1.982,1.597-3.607,3.58-3.607h10.446c0,1.873-1.515,3.387-3.387,3.387h-5.985c-.578,0-1.074.496-1.074,1.074v4.02c0,.606.496,1.074,1.074,1.074h5.954c1.872,0,3.387,1.515,3.387,3.387Z" fill="#93d500"/></g></svg>';

  /* Null-prototype: a lookup table is not a whitelist. HAT_TOPS[cfg.top] is a gate on stored
     data, and a plain object would answer truthy for 'constructor' or '__proto__'. See the note
     on ROLE_ALIASES in Code.gs — same class of bug, fixed on the map so no call site can reopen it. */
  var HAT_TOPS = Object.assign(Object.create(null), { hat: true, winterHat1: true });

  function buildAvatarUrl(cfg, seed) {
    var params = [];
    params.push('seed=' + encodeURIComponent(seed || 'unknown'));
    var noAccessories = cfg.accessories === '_none';
    var noFacialHair  = cfg.facialHair  === '_none';
    var isGcHat       = cfg.top === '_gchat';
    var noHair        = cfg.top === '_none';
    var isHat         = !!(cfg.top && HAT_TOPS[cfg.top]);
    Object.keys(cfg).forEach(function (k) {
      var v = cfg[k];
      if (v == null || v === '_none') return;
      if (k === 'seed') return;
      if (k === 'top' && isGcHat) { params.push('top=shortFlat'); return; }
      if (k === 'accessoriesColor' && noAccessories) return;
      if (k === 'facialHairColor'  && noFacialHair)  return;
      if (k === 'hairColor'        && (noHair || isHat)) return;
      if (k === 'hatColor'         && !isHat)         return;
      params.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    params.push('accessoriesProbability=' + (noAccessories ? '0' : '100'));
    params.push('facialHairProbability='  + (noFacialHair  ? '0' : '100'));
    params.push('topProbability='         + ((noHair && !isGcHat) ? '0' : '100'));
    return 'https://api.dicebear.com/9.x/avataaars/svg?' + params.join('&');
  }

  /* THE OPTION TABLES ARE GONE — gx-theme's GXAvatarPicker owns them now (2026-08-25). It carries
     its own OPTIONS / DEFAULT_CONFIG, and a second copy here would be a second answer to "what can
     an avatar be": add an option in one place and half the suite never offers it.

     ONE ATTRIBUTE WENT WITH THEM AND IS WORTH NAMING: `clothingGraphic`, the design printed on a
     graphic shirt. Crew pinned it because it was the LAST thing the seed still chose — everything
     else in a config is fixed, so once the seed was pinned to employee_number this was the only
     attribute that could still differ between apps, and it did. The shared picker does not offer
     it, so a config re-saved through the picker loses the key and DiceBear picks the design from
     the seed again. Stored configs that still carry it keep rendering it (buildAvatarUrl below
     emits whatever the config holds); only a re-save drops it. Requested back from core-admin —
     it belongs in the shared component, not in a local table that would diverge on day one. */

  function parseCfg(row) {
    if (!row.avatar_config) return null;
    try { return JSON.parse(row.avatar_config); } catch (e) { return null; }
  }
  function initialsOf(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }
  /* ── How Crew writes a person's name, everywhere it writes one ──────────────────
   * The board, the roster and the till receipt all call employee #22 "Mike". METRC calls him
   * Michael, and METRC is right — it is the legal spelling payroll and the OLCC permit are
   * matched against. Both facts are true at once, so the roster leads with the name people use
   * and keeps the legal one visible beside it rather than choosing.
   *
   * The nickname replaces the FIRST TOKEN only, so middle names and compound surnames survive:
   * "Michael J. Kettler" + Mike -> "Mike J. Kettler", "Mary Van Der Berg" + Molly ->
   * "Molly Van Der Berg". Slicing from the first space keeps the original spacing too.
   *
   * NOTHING HERE IS EVER WRITTEN BACK. displayName is a rendering, assembled from two stored
   * fields; `full_name` and `preferred_name` are edited separately in the field grid, and the
   * header that shows this is deliberately not an input. Saving a display name would put "Mike"
   * into the legal-name column, which is the precise mistake the Dutchie->identity seed already
   * made once. */
  function displayName(row) {
    var full = String(row.name || '').trim();
    if (!full) return '';
    var nick = String(row.preferred_name || '').trim();
    if (!nick) return full;
    var sp = full.indexOf(' ');
    return sp < 0 ? nick : nick + full.slice(sp);
  }
  /* The legal first name, and only when it is telling you something. A nickname that IS the
     first name ("Michael" preferring "Michael") would render as a green echo of the word beside
     it — visible punctuation carrying no fact. */
  function legalFirst(row) {
    var full = String(row.name || '').trim(), nick = String(row.preferred_name || '').trim();
    if (!full || !nick) return '';
    var first = full.split(/\s+/)[0];
    return first.toLowerCase() === nick.toLowerCase() ? '' : first;
  }

  /* Puck: the rendered avatar, or initials when nobody has picked one. Faces come from an
     external service, so a failed load falls back to initials rather than a broken image. */
  function avatarPuck(row, size) {
    var cfg = parseCfg(row);
    var puck = el('span', 'crew-ava' + (size ? ' is-' + size : ''));
    if (!cfg) {
      puck.classList.add('is-initials');
      puck.textContent = initialsOf(row.name);
      return puck;
    }
    var img = el('img');
    img.src = buildAvatarUrl(cfg, row.avatar_seed || row.employee_id);
    img.alt = '';
    img.addEventListener('error', function () {
      puck.classList.add('is-initials');
      puck.innerHTML = '';
      puck.textContent = initialsOf(row.name);
    });
    puck.appendChild(img);
    if (cfg.top === '_gchat') {
      var hat = el('span', 'crew-ava-hat', GC_HAT_SVG);
      puck.appendChild(hat);
    }
    return puck;
  }

  // ─── views ───────────────────────────────────────────────────────────────────
  function renderLogin(errMsg) {
    clear();
    var form = el('form', 'gx-login-form');
    form.innerHTML =
      '<label class="gx-login-field"><span>Username</span>' +
        '<input class="gx-input" name="user" autocomplete="username" required></label>' +
      '<label class="gx-login-field"><span>Password</span>' +
        '<input class="gx-input" name="pass" type="password" autocomplete="current-password" required></label>' +
      '<button type="submit" class="gx-btn gx-btn-green gx-login-submit">Sign in</button>';
    var msg = el('p', 'gx-login-err');
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
        // r.user is the SLUG ('sky'); r.displayName is the person's name. The chip showed the slug
        // because only r.user was ever stored.
        setSession(r.token, r.displayName || r.user, r.avatarConfig);
        boot();
      } catch (e) {
        msg.textContent = (e && e.message) || 'Sign-in failed';
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });

    var tabs = document.getElementById('navTabs');  if (tabs) tabs.innerHTML = '';
    var slot = document.getElementById('userSlot'); if (slot) slot.innerHTML = '';
    var wrap = el('div', 'gx-login');
    var cardEl = el('div', 'gx-login-card');
    cardEl.innerHTML =
      '<div class="gx-login-head">' +
        '<img class="gx-login-mark" src="https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png" alt="Green Cross">' +
        '<div class="gx-login-sub">Crew &middot; HR &amp; People</div>' +
      '</div>';
    cardEl.appendChild(form);
    cardEl.appendChild(msg);
    wrap.appendChild(cardEl);
    mount.appendChild(wrap);
  }

  function renderStatus(html) {
    clear();
    mount.appendChild(card('GX&nbsp;Crew', [el('p', 'gx-muted', html)]));
  }

  /* Flags come from the engine so the roster, the UI and any future export share one
     definition of "questionable". A cell clears the moment the underlying value is fixed. */
  function has(row, flag) { return (row.flags || []).indexOf(flag) >= 0; }
  /* Names the gaps a flag stands for, so a status dot's tooltip reads "Missing: wage, OLCC
     permit" instead of repeating the engine's field keys at somebody. Same vocabulary as
     rowFlags_ in Code.gs — add a flag there and it needs a line here or it shows raw. */
  var FLAG_LABEL = { name: 'name', employee_number: 'employee number', hire_date: 'hire date',
    store: 'store', role: 'role', no_account: 'GX account', wage: 'wage', birthday: 'birthday',
    permit: 'OLCC permit', permit_expired: 'expired permit', permit_status: 'permit status' };

  /* RED means damage or a compliance failure — an expired permit, no permit at all, a manager
     who cannot be contacted, a blanked name. GOLD means a record that is merely incomplete.
     The distinction is the whole point of the dot: a roster where everything is red teaches
     people to ignore red. */
  function gapSeverity(row) {
    var gaps = row.flags || [];
    if (!gaps.length) return '';
    var bad = has(row, 'name') || has(row, 'no_account') || has(row, 'permit') ||
              has(row, 'permit_expired') ||
              (row.permit_days_left != null && row.permit_days_left < 0);
    return bad ? 'high' : 'warn';
  }
  function gapTitle(row) {
    return 'Missing: ' + (row.flags || []).map(function (f) { return FLAG_LABEL[f] || f; }).join(', ');
  }

  /* ── New here ─────────────────────────────────────────────────────────────────
   * The gaps that mean a record was never FINISHED, as opposed to merely imperfect. Somebody
   * turning up from a METRC or Dutchie import arrives with a name and a permit and nothing else;
   * these five are what a human still has to supply before the person is set up.
   *
   * Deliberately NOT the full flag list. A ten-year employee missing a shirt size is not a new
   * starter, and putting them in this section would bury the person who actually needs twenty
   * minutes of someone's attention today — which is the entire point of having it.
   */
  /* Which gaps mean a record was never FINISHED, as opposed to merely imperfect. Kept here only
     to NAME them on the card; whether somebody counts as new is the engine's answer, below. */
  var SETUP_FLAGS = ['hire_date', 'wage', 'store', 'role', 'employee_number'];

  /* THE ENGINE DECIDES, and this reads its answer. The rule lived here for an afternoon and had
     to move: the Monday digest renders the same list server-side, and two copies of "who is new"
     would drift the first time either was touched — the same reason `flags` has always been the
     engine's to compute. needsSetup_ in Code.gs is the definition; row.needs_setup is the result.
     Guarded so an older engine, which sends no such field, simply shows an empty section rather
     than throwing. */
  function needsSetup(row) {
    return !row.retired && !!row.needs_setup;
  }
  /* Newest first, and "newest" is the employee NUMBER: they are issued in order of appearance,
     so the highest number is the most recent arrival. Somebody with no number yet is newer
     still — they turned up since the last time numbers were assigned. */
  function byArrival(a, b) {
    var an = parseInt(a.employee_number, 10), bn = parseInt(b.employee_number, 10);
    var ab = isNaN(an), bb = isNaN(bn);
    if (ab && !bb) return -1;
    if (!ab && bb) return 1;
    if (ab && bb)  return byName(a, b);
    return bn - an;
  }

  /* Alphabetical within a store group, on the name the list actually SHOWS. Sorting on the legal
     name instead would file Rebeka Perez under R while the row in front of you reads "Bekah
     Perez" — an alphabetical list you cannot scan alphabetically is worse than an unsorted one.
     Blanks always sink, the rule the old sortRows applied to every column: a record with no name
     is the absence of a value, not the smallest one, and letting it ride the top buries the rows
     you actually came to compare. */
  function byName(a, b) {
    var as = displayName(a), bs = displayName(b);
    if (!as && bs) return 1;
    if (as && !bs) return -1;
    return as.localeCompare(bs);
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
    role:                'Role differs',
    new_hire:            'In Dutchie, not on the roster'
  };

  /* Tabs live in the shared header (#navTabs), not in the page body, so Crew matches every other app.
     Review and EoM are no longer tabs — their content is the roster's overview pane, shown whenever
     nobody is selected, so a disagreement is answered next to the record it is about rather than on
     a screen of its own. That leaves Roster as Crew's only view today; Incentive and Payroll are
     routes the engine still has commented out, and each becomes one more entry here when it lands.
     Returns null: callers no longer insert a nav node into the main column. */
  function navBar() {
    var nav = document.getElementById('navTabs');
    if (!nav) return null;
    nav.innerHTML = '';
    var b = el('button', 'gx-topnav-tab is-active', 'Roster');
    b.type = 'button';
    b.addEventListener('click', function () { state.selected = null; paintSubnav(); paintPane(); });
    nav.appendChild(b);
    return null;
  }

  /* User chip: avatar + name, matching Leaderboard. Settings / version / sign-out live in its menu
     rather than as separate header buttons. gx-topnav.js owns the open/close behaviour. */
  function currentUser() { try { return sessionStorage.getItem(USER_KEY) || ''; } catch (e) { return ''; } }

  function renderUserChip() {
    var slot = document.getElementById('userSlot');
    if (!slot) return;
    var name = currentUser();
    if (!token() || !name) { slot.innerHTML = ''; return; }
    // Real avatar when the roster has one; GXAvatar owns the DiceBear rules.
    var ava = window.GXAvatar ? GXAvatar.chip(currentAvatar(), name) : null;
    // Menu built from CONFIG by the shared component, so it matches every other app and gaining an
    // item later is one entry here rather than new markup.
    // Guarded: the shared scripts come from Pages with a 10-minute cache, so there is always a
    // window where this app has shipped and the shared layer it calls has not arrived yet. An
    // unguarded call throws inside boot() and takes the WHOLE app down over a header detail.
    if (!window.GXTopNav || !GXTopNav.renderUser) { slot.innerHTML = ''; return; }
    if (window.GXChangelog) {
      GXChangelog.init({ app: 'crew', title: 'GX Crew', version: APP_VERSION });
    }
    GXTopNav.renderUser(slot, {
      name: name,
      role: 'Crew',
      avatar: ava,
      items: [
        { action: 'version', label: 'Version', value: APP_VERSION },
        { action: 'logout',  label: 'Sign out', danger: true }
      ]
    });
  }

  /* ── Bug reporter ────────────────────────────────────────────────────────────────
   * gx-theme's shared reporter owns the button, the modal and the state snapshot. Crew supplies
   * only the three things it cannot know: how this app talks to its own engine, who is signed in,
   * and what the user was looking at.
   *
   * Guarded and idempotent like renderUserChip, and for the same reason: the shared scripts come
   * from Pages behind a ~10-minute cache, so there is always a window where this app has shipped
   * and the layer it calls has not arrived. Called from both boot and render so a late arrival
   * still gets wired instead of being missed forever by a single early attempt.
   *
   * WHAT DELIBERATELY DOES NOT GO IN THE SNAPSHOT: the search box contents. `bug_reports` is a
   * SHARED table rendered in the Command Center cockpit, and Crew is the app that holds the PII —
   * a report reading "searched: Rebeka Perez" moves an employee's name into a log that exists for
   * every app. `searchActive` carries the only part that helps reproduce a bug (a filter was on)
   * and none of the part that should not leave here.
   */
  var bugWired = false;
  function initBugReport() {
    if (bugWired || !window.GXBugReport || !GXBugReport.init || !Engine) return;
    GXBugReport.init({
      app:    'crew',
      action: 'bugreport',      // must match the engine's route_ case
      version:  function () { return APP_VERSION; },
      reporter: function () { return state.user || currentUser(); },
      context:  function () {
        var picked = Object.keys(state.storeFilter);
        return {
          /* Which PANE, not which person. The selected employee_id would name an employee in a
             log every app in the suite can read, which is exactly what this snapshot exists to
             avoid — and 'person' plus the scope reproduces the bug just as well. */
          view:         state.selected ? 'person' : 'overview',
          stores:       picked.length ? picked.join(',') : 'all',
          scope:        state.scope,
          searchActive: state.q ? 'yes' : ''
        };
      },
      submit: function (payload) {
        // Crew's own authenticated path, which is the point of `submit` being a function: the shared
        // script never handles a token, so there is no second auth path to keep correct.
        var params = { token: token(), tab: state.selected ? 'person' : 'overview' };
        Object.keys(payload).forEach(function (k) { if (k !== 'action') params[k] = payload[k]; });
        return Engine.jsonp(payload.action, params, { timeoutMs: 20000, retries: 1 });
      }
    });
    bugWired = true;
  }

  /* The queue is loaded in the BACKGROUND, never in front of the roster. It is a second slow
     read against the same two sheets, and the old Review tab made you wait for it before showing
     anything; now it fills the overview in place once it arrives. A failure is recorded rather
     than thrown — the roster is still usable without it, and the overview says so. */
  async function loadReview() {
    try {
      var r = await Engine.jsonp('review', { token: token() }, { timeoutMs: 45000, retries: 1 });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Review load failed');
      state.review = r.items || [];
      state.reviewCounts = r.counts || {};
      state.reviewErr = '';
    } catch (e) {
      state.review = state.review || [];
      state.reviewErr = (e && e.message) || 'could not load the review queue';
    }
    if (mount.classList.contains('is-ws')) { paintPane(); }
  }

  /* Every open question, minus the ones resolved in this session. Optimistic removal: a resolved
     card disappears the moment the write succeeds rather than after a full reload, because the
     count going down is the feedback that says the queue is finite. */
  function openItems() {
    return (state.review || []).filter(function (it) { return !state.dismissed[it.id]; });
  }
  function itemsFor(employeeId) {
    return openItems().filter(function (it) { return String(it.employee_id) === String(employeeId); });
  }
  /* The primary action names what accepting will DO, because the three kinds do genuinely
     different things: two write to GX Core identity, one merges two records, and the rest only
     record that a human handled something this app cannot action (renewing a permit, revoking
     METRC access). "Apply" on all four would promise a write that never happens. */
  function ctaFor(kind) {
    return kind === 'duplicate'     ? 'Merge them'
         : kind === 'name_spelling' ? 'Apply METRC spelling'
         : kind === 'role'          ? 'Apply Leaderboard role'
         : kind === 'new_hire'      ? 'Add to the roster'
         : 'Mark handled';
  }

  /* Records one of the three honest answers. All of them are written: "I looked and it is fine"
     has to silence an item as firmly as a correction does, or the queue never empties. */
  async function resolveItem(it, choice, node, btns) {
    btns.forEach(function (b) { b.disabled = true; });
    try {
      var r = await Engine.jsonp('review_resolve',
        { token: token(), id: it.id, choice: choice }, { timeoutMs: 45000, retries: 2 });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
      state.dismissed[it.id] = true;
      state.reviewCounts[it.severity] = Math.max(0, (state.reviewCounts[it.severity] || 1) - 1);
      if (node && node.parentNode) node.parentNode.removeChild(node);
      toast(choice === 'accept' ? ('✓ ' + (r.applied || ctaFor(it.kind)))
            : choice === 'keep' ? '✓ Kept the current value'
            : '✓ Recorded as not a problem');
      /* Accepting a name, a role or a merge CHANGES the roster, so the rows in hand are stale.
         Refetch quietly rather than patching a guess into them. */
      if (choice === 'accept' && ['duplicate', 'name_spelling', 'role', 'new_hire'].indexOf(it.kind) >= 0) {
        if (it.kind === 'duplicate' && String(state.selected) === String(it.merge_from)) {
          state.selected = it.employee_id;      // the record they were reading no longer exists
        }
        boot(true);
      } else { paintSubnav(); paintPane(); }
    } catch (e) {
      btns.forEach(function (b) { b.disabled = false; });
      toast((e && e.message) || 'Failed', true);
    }
  }

  /* ── Employee of the Month ─────────────────────────────────────────────────────────────────────
     An HR call, so it lives here rather than in Leaderboard, which only RENDERS the badge on the
     kiosk. Moved out of Leaderboard's Settings along with nicknames, avatars and job titles.

     Stored in GX Core as `cfg.eom`, keyed on employee_id — never on a name. Leaderboard used to key
     it on a name-derived string, so renaming somebody silently dropped the star off the board. Same
     flaw we already fixed for avatar seeds by pinning them to employee_number.

     Writes go to GX Core directly with the signed-in user's token; Core checks the crew grant and
     that the id belongs to a live employee. Crew deliberately holds no deploy secret. */

  async function loadEom() {
    state.eom = null;
    try {
      var r = await GXCore.jsonp('config', { key: 'cfg.eom' }, { retries: 1, timeoutMs: 8000 });
      var raw = r && r.value;
      if (raw) {
        var v = (typeof raw === 'object') ? raw : JSON.parse(raw);
        state.eom = (v && v.employee_id) ? String(v.employee_id) : null;
      }
    } catch (e) { state.eom = null; }
    if (mount.classList.contains('is-ws')) { paintRail(); paintPane(); }
    loadEomHistory();
  }

  /* The log is a SECOND request on purpose, not folded into the one above: picking somebody is
     the whole point of this tab, and it must not wait on history to render. The engine reads
     cfg.eom back itself and appends what it finds, so this call is also what records a pick —
     the browser never tells it who holds the award. */
  async function loadEomHistory() {
    try {
      var r = await Engine.jsonp('eom_history', { token: token() }, { timeoutMs: 20000, retries: 1 });
      state.eomHistory = (r && r.ok && r.history) ? r.history : [];
      state.eomHistoryErr = (r && r.ok) ? '' : ((r && r.error) || 'could not load the history');
    } catch (e) {
      state.eomHistory = [];
      state.eomHistoryErr = (e && e.message) || 'could not load the history';
    }
    if (mount.classList.contains('is-ws') && !state.selected) paintPane();
  }

  async function setEom(employeeId, label) {
    var prev = state.eom;
    state.eom = employeeId || null;            // optimistic: the star has already moved
    paintRail(); paintPane();
    try {
      var r = await GXCore.jsonp('set_eom',
        { token: token(), employee_id: employeeId || '' }, { retries: 1, timeoutMs: 12000 });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'Save failed');
      toast(employeeId ? ('★ Employee of the Month · ' + label) : '★ Employee of the Month cleared');
      // Only now, once Core holds the new value — the engine logs what it READS, so asking any
      // earlier would just record the reign that is being replaced.
      state.eomHistory = undefined;
      loadEomHistory();
    } catch (e) {
      state.eom = prev;                        // put it back rather than lie about what is stored
      paintRail(); paintPane();
      toast((e && e.message) || 'Could not save', true);
    }
  }

  /* Bare month and year. A reign is a month-scale thing, so a day and a clock time would be
     false precision — and the one date we cannot know exactly is a cleared award's, which the
     engine can only stamp when it first noticed. */
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  /* Read the YEAR and MONTH straight off the string. `new Date('2026-08-01')` parses as UTC
     midnight and getMonth() answers in LOCAL time, so west of Greenwich every reign that began
     on the 1st was reported a month early — the log read "Jul 2026 — present" for a pick made in
     August. Same class of bug the suite's dates-are-TEXT rule exists to prevent, and there is no
     conversion to get right here: the engine writes an ISO string and we want two fields of it. */
  function eomMonth(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '—';
    var mi = Number(m[2]) - 1;
    if (mi < 0 || mi > 11) return '—';
    return MONTHS[mi] + ' ' + m[1];
  }
  /* "Aug 2026 — present" while it runs, one month if it began and ended in the same one, a
     range otherwise. Reading "Mar 2026 – Mar 2026" tells you nothing the single month does not. */
  function eomSpan(h) {
    var from = eomMonth(h.started_at);
    if (h.current) return from + ' — present';
    var to = eomMonth(h.ended_at);
    return from === to ? from : from + ' – ' + to;
  }

  /* The reign log. The face comes from the roster where they are still on it, but the NAME comes
     from the log: someone since renamed or retired held it under the name they held it under, and
     quietly restating the present would not be a record of the past. */
  /* The reign log writes a person the way every other surface does — nickname + surname — by
     looking them up on the roster, exactly as the holder card directly above it already did. The
     two sitting next to each other saying "Mike Kettler" and "Michael Kettler" was the giveaway.
     
     The log's OWN stored name survives as the fallback, and that half still matters: somebody who
     has left is no longer on the roster to look up, and their name at the time is then the only
     record of who held it. So a current employee reads currently, and a departed one reads as
     they were — rather than the log freezing a spelling we have since corrected. */
  function eomLogName(h) {
    var row = rowById(h.employee_id);
    return row ? displayName(row) : String(h.name || h.employee_id || '');
  }

  function eomHistoryNodes() {
    if (state.eomHistory === undefined) return [el('p', 'crew-hint', 'Loading the reign log…')];
    if (state.eomHistoryErr) return [el('p', 'crew-hint', esc(state.eomHistoryErr))];
    if (!state.eomHistory.length) {
      return [el('p', 'crew-hint', 'Nobody has held it yet. Each pick is recorded here from now on.')];
    }
    var list = el('ol', 'crew-eomlog');
    state.eomHistory.forEach(function (h) {
      var li = el('li', 'crew-eomlog-row');
      /* A deliberate "nobody" is part of the record, not a gap in it — the same distinction
         Core draws by storing an empty value instead of deleting the key. */
      li.appendChild(el('span', 'crew-eomlog-name' + (h.nobody ? ' is-nobody' : ''),
        h.nobody ? 'Nobody held it' : esc(eomLogName(h))));
      li.appendChild(el('span', 'crew-eomlog-when', esc(eomSpan(h))));
      /* Provenance, because the two are not the same claim. An observed reign is what GX Core
         actually held; a backfilled one is somebody's memory of a month that predates the log. */
      li.appendChild(el('span', 'crew-eomlog-by',
        h.backfilled ? 'recorded' : (h.set_by ? 'set by ' + esc(h.set_by) : '')));
      list.appendChild(li);
    });
    return [list];
  }


  /* ── Toast ────────────────────────────────────────────────────────────────────
     There is no Save button anywhere on this screen, so this is the only thing that says a
     write landed. It NAMES the field — on a pane of twenty live controls "Saved" does not tell
     you which one — and carries an undo where one is possible, because the cost of a live
     control is that a stray keystroke commits. */
  var toastNode = null, toastTimer = null;
  function toast(msg, isErr, undo) {
    if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode);
    clearTimeout(toastTimer);
    toastNode = el('div', 'crew-toast' + (isErr ? ' is-err' : ''));
    toastNode.appendChild(el('span', null, esc(msg)));
    if (undo) {
      var u = el('button', null, 'Undo');
      u.type = 'button';
      u.addEventListener('click', function () {
        u.disabled = true;
        undo();
      });
      toastNode.appendChild(u);
    }
    document.body.appendChild(toastNode);
    // An error stays twice as long: it is the only notice you get, and 1.6s is not enough
    // time to read a validation message you were not expecting.
    toastTimer = setTimeout(function () {
      if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode);
      toastNode = null;
    }, isErr ? 4200 : 1600);
  }


  /* ── Which rows are in play ───────────────────────────────────────────────────
     Three layers, applied in this order and never any other: SCOPE (what kind of record),
     SEARCH (what you typed), STORE (which pills are lit). The store pill counts are taken
     between the second and third, so the numbers stay truthful while you type and do not shift
     depending on which pill you last pressed. */
  function scopedRows() {
    if (state.scope === 'retired') return state.rows.filter(function (r) { return r.retired; });
    var live = state.rows.filter(function (r) { return !r.retired; });
    if (state.scope === 'attention') return live.filter(function (r) { return (r.flags || []).length; });
    return live;
  }
  /* Matches name, nickname, store label, role, employee number AND permit number. The last two
     are why this is a search box and not a name filter: "who is #22" and "whose permit is
     OLCC-151903" are both questions the roster gets asked. */
  function searchRows(rows) {
    var q = state.q.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(function (r) {
      /* displayName is in here as well as its two ingredients, because the list shows "Bekah
         Perez" and neither stored field contains that string — typing what is on the screen has
         to find the row it is printed on. */
      return (r.name + ' ' + (r.preferred_name || '') + ' ' + displayName(r) + ' ' +
              storeName(r.store) + ' ' + r.role + ' ' + r.employee_number + ' ' +
              (r.permit_number || ''))
             .toLowerCase().indexOf(q) >= 0;
    });
  }
  function rowById(id) {
    var hit = state.rows.filter(function (r) { return String(r.employee_id) === String(id); });
    return hit[0] || null;
  }


  /* ── Shell ────────────────────────────────────────────────────────────────────
     Built ONCE per load. Everything after this repaints a slot, never the whole page: the search
     box has to keep focus while you type, and the people list has to keep its scroll position
     when you select somebody halfway down it. */
  var ui = null;

  function renderWorkspace() {
    clear();
    mount.classList.add('is-ws');
    document.body.classList.add('crew-ws');
    navBar();
    renderUserChip();
    initBugReport();

    var subnav = el('div', 'crew-subnav');

    var searchWrap = el('div', 'crew-searchwrap');
    var search = el('input', 'crew-search');
    search.type = 'search';
    search.placeholder = 'Search people, permits, stores…';
    search.value = state.q;
    search.setAttribute('aria-label', 'Search people, permits, stores');
    /* Repaints the pills, the counts and the list — never itself, which is the whole reason the
       shell is built once. Rebuilding this input on every keystroke is what the old roster did,
       and it had to hunt the node down and restore the caret afterwards. */
    search.addEventListener('input', function () {
      state.q = search.value;
      paintPills(); paintRail();
    });
    searchWrap.appendChild(search);
    searchWrap.appendChild(el('span', 'crew-searchico', '⌕'));
    subnav.appendChild(searchWrap);

    var seg = el('div', 'crew-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Which records');
    subnav.appendChild(seg);
    subnav.appendChild(el('span', 'crew-div'));

    var pillsSlot = el('div', 'crew-pills-slot');
    subnav.appendChild(pillsSlot);

    /* The attention chip is gone from here — the overview already opens on its own and states
       the same count in its title and stat tiles, so the chip was a second scoreboard to keep
       agreeing with the first. What it ALSO was, though, is the way back from a person to the
       overview, and that had to survive it: Escape, clicking the open person again, and the
       Roster tab all deselect now. */

    var body = el('div', 'crew-body');
    var rail = el('div', 'crew-rail');
    var pane = el('div', 'crew-pane');
    body.appendChild(rail); body.appendChild(pane);

    mount.appendChild(subnav);
    mount.appendChild(body);

    ui = { search: search, seg: seg, pills: pillsSlot, rail: rail, pane: pane };
    paintSubnav(); paintRail(); paintPane();
  }

  /* Escape returns to the overview. It is the keyboard half of "click the open person again",
     and with the chip gone one of the two needed to not be a mouse. Ignored while you are inside
     a control, where Escape means "revert this field" to the browser and to everyone's fingers. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !state.selected || !ui) return;
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    /* One layer at a time. With the avatar builder open, Escape closes THAT — deselecting the
       person out from under it would throw away an unsaved face and drop you two levels in one
       keystroke, when the picker is plainly the thing on screen. Press it again to go back. */
    if (state.avatarOpen) { state.avatarOpen = false; paintPane(); return; }
    state.selected = null; paintRail(); paintPane();
  });

  function paintSubnav() { paintScope(); paintPills(); }

  function paintScope() {
    if (!ui) return;
    ui.seg.innerHTML = '';
    var gaps = state.rows.filter(function (r) { return !r.retired && (r.flags || []).length; }).length;
    [['active', 'Active'],
     ['attention', 'Gaps ' + gaps],
     ['retired', 'Retired' + (state.retiredTotal ? ' ' + state.retiredTotal : '')]
    ].forEach(function (o) {
      var b = el('button', 'crew-seg-btn' + (state.scope === o[0] ? ' is-on' : ''), esc(o[1]));
      b.type = 'button';
      b.setAttribute('aria-pressed', state.scope === o[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (state.scope === o[0]) return;
        state.scope = o[0];
        /* Retired rows are not in hand — the roster read asks for them explicitly, exactly as the
           old "Show retired" checkbox did. Fetch once and keep them; switching back and forth
           should not cost a ten-second read each time. */
        if (o[0] === 'retired' && !state.fetchedRetired) { boot(true); return; }
        paintSubnav(); paintRail();
      });
      ui.seg.appendChild(b);
    });
  }

  function paintPills() {
    if (!ui) return;
    ui.pills.innerHTML = '';
    var row = storePills(searchRows(scopedRows()));
    if (row) ui.pills.appendChild(row);
  }


  /* ── People list (left) ───────────────────────────────────────────────────────
     Grouped by store, alphabetical inside each group, empty groups omitted entirely. The scroll
     position is captured and restored around every repaint: selecting somebody must not move the
     list under the cursor, or the next click lands on whoever slid into that spot. */
  function paintRail() {
    if (!ui) return;
    var keepScroll = ui.rail.scrollTop;
    ui.rail.innerHTML = '';

    if (!state.rows.length) {
      /* A skeleton, not an empty pane. The first roster read is ~10s cold, and an empty column
         where the staff go reads as "nobody works here" rather than "still loading". */
      for (var k = 0; k < 9; k++) ui.rail.appendChild(el('div', 'crew-skel'));
      return;
    }

    var matched = searchRows(scopedRows());
    var rows = filterByStore(matched);
    var ids = storesInRoster(state.rows);
    var shown = 0;

    ids.forEach(function (id) {
      var list = rows.filter(function (r) { return String(r.store || '') === id; }).sort(byName);
      if (!list.length) return;
      shown += list.length;
      var head = el('div', 'crew-group-head');
      var dot = el('span', 'crew-group-dot');
      var c = storeColor(id);
      if (c) dot.style.setProperty('--crew-group-color', c);
      head.appendChild(dot);
      head.appendChild(el('span', 'crew-group-label', esc(id ? storeName(id) : 'No store')));
      head.appendChild(el('span', 'crew-group-n', String(list.length)));
      ui.rail.appendChild(head);
      list.forEach(function (r) { ui.rail.appendChild(personRow(r)); });
    });

    if (!shown) {
      /* Name the filter that is hiding people. "No employees" in front of a 75-person roster
         sent somebody looking for a data problem that was a pressed pill. */
      var why = [];
      if (state.q) why.push('matching “' + esc(state.q) + '”');
      var picked = Object.keys(state.storeFilter);
      if (picked.length) {
        why.push('at ' + picked.map(function (x) {
          return esc(x ? storeName(x) : 'No store'); }).join(' or '));
      }
      if (state.scope === 'attention') why.push('with a gap');
      if (state.scope === 'retired')   why.push('retired');
      ui.rail.appendChild(el('p', 'crew-rail-empty',
        why.length ? 'Nobody ' + why.join(' ') + '.' : 'Nobody in this view.'));
    }
    ui.rail.scrollTop = keepScroll;
  }

  function personRow(r) {
    var sel = String(state.selected) === String(r.employee_id);
    var b = el('button', 'crew-person' + (sel ? ' is-sel' : '') + (r.retired ? ' is-retired' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', sel ? 'true' : 'false');
    b.appendChild(avatarPuck(r));

    var txt = el('span', 'crew-person-txt');
    var named = !!String(r.name || '').trim();
    txt.appendChild(el('span', 'crew-person-name' + (named ? '' : ' is-blank'),
      named ? esc(displayName(r)) : '⚠ Record blanked'));
    /* Role only. The legal first name lived here briefly and earned its place on the RECORD, not
       in the list: scanning for somebody you are looking for, "Budtender · “Michael”" is one more
       thing to read past on every row to answer a question nobody is asking at that moment. It is
       still on the header the moment you open them. */
    txt.appendChild(el('span', 'crew-person-meta', esc(r.role)));
    b.appendChild(txt);

    if (state.eom && String(state.eom) === String(r.employee_id)) {
      var star = el('span', 'crew-person-star', '★');
      star.title = 'Employee of the Month';
      b.appendChild(star);
    }
    var sev = gapSeverity(r);
    if (sev) {
      var d = el('span', 'crew-person-dot');
      d.style.background = sev === 'high' ? 'var(--gx-red)' : 'var(--gx-gold)';
      d.title = gapTitle(r);
      b.appendChild(d);
    }

    b.addEventListener('click', function () {
      /* Clicking whoever is already open closes them, which is now one of the two ways back to
         the overview. Toggling the thing you pressed is also what the pressed state promises. */
      state.selected = sel ? null : r.employee_id;
      paintRail(); paintPane();
    });
    return b;
  }


  /* ── Right pane ───────────────────────────────────────────────────────────── */
  var lastPainted = null;
  /* Set by personHeader while a record is on screen, so a nickname or legal-name save can redraw
     that one heading. Cleared on every repaint: a stale closure would write the previous person's
     name into the pane. */
  var repaintName = null;
  /* Same idea for the record's avatar circle: a save has to move the face without repainting the
     pane, because the pane is what the open picker is sitting in. */
  var repaintHeadPuck = null;
  function paintPane() {
    if (!ui) return;
    repaintName = null;
    repaintHeadPuck = null;
    /* The picker binds a click listener to its own root. That root is about to be thrown away with
       the rest of the pane, so let the component take its listener with it. */
    destroyAvatarPicker();
    /* Panels belong to the person you opened them on. Carrying an open avatar picker or a
       half-typed merge search across a selection change would show one person's editor over
       another person's record. */
    if (String(state.selected) !== String(lastPainted)) {
      state.avatarOpen = false; state.merging = false; lastPainted = state.selected;
      ui.pane.scrollTop = 0;
    }
    ui.pane.innerHTML = '';
    var row = state.selected ? rowById(state.selected) : null;
    /* The selection can outlive the record — a merge or a retire-then-refetch removes rows. Fall
       back to the overview rather than rendering a person-shaped hole. */
    if (state.selected && !row) state.selected = null;
    if (row) renderPerson(row, ui.pane);
    else renderOverview(ui.pane);
  }


  /* ── Overview: everything that needs a person ─────────────────────────────── */
  function renderOverview(pane) {
    var wrap = el('div', 'crew-ov');

    if (state.identity && state.identity.note) wrap.appendChild(banner('warn', esc(state.identity.note)));
    if (state.identity && state.identity.error)
      wrap.appendChild(banner('error', 'GX Core identity read failed: ' + esc(state.identity.error)));

    var live     = state.rows.filter(function (r) { return !r.retired; });
    var open     = openItems();
    var expiring = live.filter(function (r) { return r.permit_days_left != null && r.permit_days_left <= 90; }).length;
    var gaps     = live.filter(function (r) { return (r.flags || []).length; }).length;

    wrap.appendChild(el('h1', 'crew-ov-h1', 'Everything that needs a person'));
    wrap.appendChild(el('p', 'crew-ov-sub',
      open.length + ' open question' + (open.length === 1 ? '' : 's') + ' · ' +
      expiring + ' permit' + (expiring === 1 ? '' : 's') + ' inside 90 days · ' +
      gaps + ' record' + (gaps === 1 ? '' : 's') + ' with a gap'));

    var stats = el('div', 'crew-stats');
    [[live.length, 'active people', ''],
     [open.length, 'open questions', open.length ? 'is-warn' : 'is-ok'],
     [expiring, 'permits inside 90 days', expiring ? 'is-bad' : 'is-ok'],
     [gaps, 'records with a gap', gaps ? 'is-warn' : 'is-ok']
    ].forEach(function (t) {
      var c = el('div', 'crew-stat');
      c.appendChild(el('div', 'crew-stat-n' + (t[2] ? ' ' + t[2] : ''), String(t[0])));
      c.appendChild(el('div', 'crew-stat-l', esc(t[1])));
      stats.appendChild(c);
    });
    wrap.appendChild(stats);

    /* FIRST, above the open questions. A cross-source disagreement can wait for someone to think
       about it; a person who started this week and has no wage on file cannot. */
    var fresh = live.filter(needsSetup).sort(byArrival);
    if (fresh.length) {
      var ns = el('div', 'crew-sect');
      ns.style.marginTop = '0';
      ns.appendChild(el('h2', null, 'New here'));
      ns.appendChild(el('span', null, 'arrived, profile not finished'));
      wrap.appendChild(ns);
      fresh.forEach(function (r) { wrap.appendChild(newcomerCard(r)); });
    }

    var sect = el('div', 'crew-sect');
    sect.appendChild(el('h2', null, 'Open questions'));
    sect.appendChild(el('span', null, 'nothing here has been applied'));
    wrap.appendChild(sect);

    if (state.review === null) {
      wrap.appendChild(el('p', 'crew-hint', 'Checking the HR sheet, METRC and Leaderboard for disagreements…'));
    } else if (state.reviewErr) {
      wrap.appendChild(banner('warn', 'Could not load the review queue: ' + esc(state.reviewErr) +
        ' — the roster below is still current.'));
    } else if (!open.length) {
      wrap.appendChild(el('div', 'crew-clear', '✓ Every source agrees. Nothing to review.'));
    } else {
      open.forEach(function (it) { wrap.appendChild(queueCard(it)); });
    }

    var esect = el('div', 'crew-sect');
    esect.appendChild(el('h2', null, 'Employee of the Month'));
    esect.appendChild(el('span', null, 'picked here, shown on the kiosk'));
    wrap.appendChild(esect);
    wrap.appendChild(eomCard());
    eomHistoryNodes().forEach(function (n) { wrap.appendChild(n); });

    pane.appendChild(wrap);
  }

  function eomCard() {
    var card = el('div', 'crew-eomcard');
    var holder = state.eom ? rowById(state.eom) : null;
    card.appendChild(avatarPuck(holder || { name: '—' }, 'md'));
    var txt = el('div', 'crew-eomcard-txt');
    txt.appendChild(el('div', 'crew-eomcard-name',
      state.eom === undefined ? 'Loading…' : holder ? esc(displayName(holder)) : 'Nobody'));
    var since = (state.eomHistory || []).filter(function (h) { return h.current && !h.nobody; })[0];
    txt.appendChild(el('div', 'crew-eomcard-sub', holder
      ? esc(holder.role) + ' · ' + esc(storeName(holder.store)) +
        (since ? ' · since ' + esc(eomMonth(since.started_at)) : '')
      : 'Nobody holds it right now'));
    card.appendChild(txt);
    if (holder) {
      var b = el('button', 'crew-btn is-gold', 'Open record');
      b.type = 'button';
      b.addEventListener('click', function () {
        state.selected = holder.employee_id; paintRail(); paintPane();
      });
      card.appendChild(b);
    }
    return card;
  }

  /* One newcomer. Names the missing fields rather than saying "incomplete", because the whole
     value of this row is knowing whether it is two minutes of typing or a conversation. */
  function newcomerCard(r) {
    var box = el('div', 'crew-q crew-new');

    var who = el('button', 'crew-q-who');
    who.type = 'button';
    who.appendChild(avatarPuck(r));
    var txt = el('span', 'crew-q-txt');
    txt.appendChild(el('span', 'crew-q-name', esc(displayName(r) || r.employee_id)));
    txt.appendChild(el('span', 'crew-q-kind',
      esc(r.store ? storeName(r.store) : 'no store') + ' · ' +
      esc(r.role_is_default ? 'no role' : r.role)));
    who.appendChild(txt);
    who.addEventListener('click', function () {
      state.selected = r.employee_id; paintRail(); paintPane();
    });
    box.appendChild(who);

    var missing = SETUP_FLAGS.filter(function (f) { return has(r, f); })
                             .map(function (f) { return FLAG_LABEL[f] || f; });
    box.appendChild(el('span', 'crew-q-detail', 'Still needs ' + esc(missing.join(', ')) + '.'));

    var acts = el('div', 'crew-q-acts');
    var go = el('button', 'crew-btn', 'Open record');
    go.type = 'button';
    go.addEventListener('click', function () {
      state.selected = r.employee_id; paintRail(); paintPane();
    });
    acts.appendChild(go);
    box.appendChild(acts);
    return box;
  }

  /* One open question, on the overview. Severity rides the left edge only — a queue of ten
     bordered entirely in red reads as ten alarms, and then as none. */
  function queueCard(it) {
    var box = el('div', 'crew-q sev-' + (it.severity || 'info'));

    var who = el('button', 'crew-q-who');
    who.type = 'button';
    var row = rowById(it.employee_id);
    /* A new_hire has no record to open yet — that is the whole point of the item. The button
       stays a plain label rather than a control that would select nobody. */
    if (!row) { who.disabled = true; who.style.cursor = 'default'; }
    who.appendChild(avatarPuck(row || { name: it.name, employee_id: it.employee_id }));
    var txt = el('span', 'crew-q-txt');
    /* The person label follows the roster's spelling like everywhere else. Where the LEGAL name
       is the subject — a name_spelling item — the now/proposed chips on the record carry it
       verbatim, so nothing is lost by labelling the card with the name people use. */
    txt.appendChild(el('span', 'crew-q-name',
      esc(row ? displayName(row) : (it.name || it.employee_id))));
    txt.appendChild(el('span', 'crew-q-kind', esc(KIND_LABEL[it.kind] || it.kind)));
    who.appendChild(txt);
    who.addEventListener('click', function () {
      state.selected = it.employee_id; paintRail(); paintPane();
    });
    box.appendChild(who);

    box.appendChild(el('span', 'crew-q-detail', esc(it.detail || '')));

    var acts = el('div', 'crew-q-acts');
    if (state.canEdit) {
      var go = el('button', 'crew-btn is-primary', esc(ctaFor(it.kind)));
      var no = el('button', 'crew-btn', 'Not a problem');
      go.type = 'button'; no.type = 'button';
      var btns = [go, no];
      go.addEventListener('click', function () {
        if (it.kind === 'duplicate' &&
            !confirm('Merge "' + it.merge_from_name + '" into "' + it.name + '"?\n\n' +
                     'Nothing is deleted, and future imports of "' + it.merge_from_name +
                     '" will resolve to ' + it.name + '.')) return;
        resolveItem(it, 'accept', box, btns);
      });
      no.addEventListener('click', function () { resolveItem(it, 'dismiss', box, btns); });
      acts.appendChild(go); acts.appendChild(no);
    } else {
      acts.appendChild(el('span', 'crew-hint', 'read-only'));
    }
    box.appendChild(acts);
    return box;
  }


  /* ── Saving ───────────────────────────────────────────────────────────────────
   * ONE FIELD PER WRITE. The old roster posted five at once behind an Edit-mode toggle; every
   * control here is live, so each commits alone.
   *
   * That is only safe because both engine routes are PATCHES: an absent parameter means "leave
   * this alone" and an empty one means "clear it", and both read-merge-write onto the existing
   * row. Send the whole record instead and gxWrite_ blanks whatever you left out — which is
   * dutchie_employee_id (SPIFF and Leaderboard attribution) and user_id (the email link),
   * neither of which this screen even shows.
   *
   * The two routes are not interchangeable. Identity — name, nickname, store, role, hire date,
   * avatar — lives in GX Core and goes through roster_identity, which also records a rename
   * alias so the old employee_id keeps resolving. Everything else is a Crew attribute and goes
   * through roster_save.
   */
  async function postField(row, route, field, value) {
    var q = { token: token(), employee_id: row.employee_id };
    q[field] = value;
    var r = await Engine.jsonp(route === 'identity' ? 'roster_identity' : 'roster_save',
      q, { timeoutMs: 45000, retries: 2 });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Save failed');
    /* saveIdentity_ answers ok:true with a WARNING when GX Core refused to clear a field, because
       Core reads an empty value as "leave alone". Reporting that as a save would repeat exactly
       the lie the warning exists to prevent. */
    if (r.warning) throw new Error(r.warning);
    return r;
  }

  /* The engine owns the definition of "questionable" (rowFlags_), and this does not second-guess
     it — it adjusts the one flag belonging to the field just written, so the gold border and the
     list's status dot stop lying the moment the value lands. The next roster read replaces
     row.flags wholesale with the engine's answer. */
  function retagFlag(row, flag, missing) {
    var f = (row.flags || []).filter(function (x) { return x !== flag; });
    if (missing) f.push(flag);
    row.flags = f;
  }

  var IDENTITY_PATCH = {
    full_name:      function (row, v) { row.name = v; retagFlag(row, 'name', !v); },
    preferred_name: function (row, v) { row.preferred_name = v; },
    home_store:     function (row, v) { row.store = v; retagFlag(row, 'store', !v); },
    role_title:     function (row, v) {
      row.role = v || 'Budtender'; row.role_is_default = !v; retagFlag(row, 'role', !v);
    },
    hire_date:      function (row, v) { row.hire_date = v; retagFlag(row, 'hire_date', !v); },
    avatar_config:  function (row, v) { row.avatar_config = v; }
  };

  function applySaved(row, route, field, value, res) {
    if (route === 'identity') {
      (IDENTITY_PATCH[field] || function () {})(row, value);
      return;
    }
    // roster_save answers with the whole stored record, so take its normalised values rather
    // than the raw text: "17.50 " comes back "17.50", and "3-7" comes back "03-07".
    var saved = (res && res.saved) || {};
    ['wage', 'shirt_size', 'birthday', 'permit_number', 'permit_expires', 'permit_status']
      .forEach(function (k) { if (saved[k] != null) row[k] = saved[k]; });
    if (saved.celebrations_opt_out != null) row.celebrations_opt_out = !!saved.celebrations_opt_out;
    retagFlag(row, 'wage', !row.wage);
    retagFlag(row, 'birthday', !row.birthday);
    retagFlag(row, 'permit', !row.permit_number);
  }

  /* One save, with the undo the live-control trade demands: nothing here is armed, so a stray
     keystroke commits, and the toast is the only place to catch it. Undo re-posts the previous
     value through the same patch — it is a second write, not a rollback, which is the honest
     shape of it when the record has already changed. */
  function saveField(row, route, field, value, label, prev, after) {
    return postField(row, route, field, value)
      .then(function (r) {
        applySaved(row, route, field, value, r);
        var canUndo = prev != null && String(prev) !== String(value) &&
                      !(field === 'full_name' && !String(prev).trim());
        toast('Saved · ' + label, false, canUndo ? function () {
          saveField(row, route, field, prev, label, null, after);
        } : null);
        if (after) after(r);
        paintRail(); paintPills(); paintScope();
      })
      .catch(function (e) {
        toast((e && e.message) || 'Save failed', true);
        if (after) after(null, e);
        throw e;
      });
  }


  /* ── One field, one card ──────────────────────────────────────────────────────
     Text commits on a 600ms pause and again on blur; selects and dates commit the instant they
     change, because there is no half-typed state to wait out. The three fields a careless write
     damages worst — name, store and role — ask once before overwriting a value that is already
     there; the rest just save. */
  var fieldSeq = 0;
  function fieldCard(row, o) {
    /* A DIV wrapping a real <label for>, not a <label> wrapping everything. The wage card carries
       its own "Not on payroll" checkbox, and a <label> nested inside a <label> is invalid — the
       parser re-homes it, which broke the layout and, worse, pointed the inner label's clicks at
       the outer card's control. Explicit for/id keeps the association without the nesting. */
    var card = el('div', 'crew-field');
    var id = 'crewf' + (++fieldSeq);
    var lab = el('label', 'crew-field-label', esc(o.label));
    lab.setAttribute('for', id);
    card.appendChild(lab);

    var input;
    if (o.options) {
      input = el('select');
      input.innerHTML = o.options.map(function (op) {
        return '<option value="' + esc(op[0]) + '"' + (String(o.value || '') === String(op[0]) ? ' selected' : '') +
               '>' + esc(op[1]) + '</option>';
      }).join('');
    } else {
      input = el('input');
      input.type = o.type || 'text';
      input.value = o.value || '';
      if (o.placeholder) input.placeholder = o.placeholder;
    }
    if (o.disabled || !state.canEdit) input.disabled = true;
    if (o.title) input.title = o.title;
    input.id = id;
    card.appendChild(input);

    var note = el('span', 'crew-field-note');
    card.appendChild(note);
    if (o.extra) card.appendChild(o.extra(row, function () { paintNote(); }));

    function paintNote() {
      var n = o.note(row);
      card.className = 'crew-field' + (n.kind === 'gap' ? ' is-gap' : '');
      note.className = 'crew-field-note' + (n.kind === 'bad' ? ' is-bad' : '');
      note.textContent = n.text;
    }
    paintNote();
    if (o.disabled || !state.canEdit) return card;

    var last = String(o.value == null ? '' : o.value);
    var timer = null;

    function commit() {
      clearTimeout(timer);
      var v = input.value;
      if (input.type !== 'date' && !o.options) v = v.trim();
      if (v === last) return;
      var prev = last;
      if (o.confirm && String(prev).trim() &&
          !confirm('Change ' + o.label.toLowerCase() + ' from “' + prev + '” to “' +
                   (v || '— nothing —') + '”?' + (o.confirmNote ? '\n\n' + o.confirmNote : ''))) {
        input.value = prev;
        return;
      }
      last = v;
      input.disabled = true;
      saveField(row, o.route, o.field, v, o.label.toLowerCase(), prev, function (r, err) {
        input.disabled = false;
        if (err) { last = prev; input.value = prev; }
        else if (!o.options) input.value = (o.read ? o.read(row) : v);
        paintNote();
        /* Redraw the heading, never the pane: a text field commits 600ms after you stop typing,
           and repainting the pane there would take the input you are still in with it. */
        if (o.renames && repaintName) repaintName();
      }).catch(function () {});
    }

    if (o.options || input.type === 'date') input.addEventListener('change', commit);
    else {
      input.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(commit, 600);
      });
      input.addEventListener('change', commit);       // blur / Enter beats the timer
    }
    return card;
  }


  /* ── Person record ────────────────────────────────────────────────────────────
     One person's whole record on one screen — what used to be a table row, an inline identity
     panel and two sibling tabs. */
  function renderPerson(row, pane) {
    pane.appendChild(personHeader(row));

    var body = el('div', 'crew-pbody');

    if (state.avatarOpen) body.appendChild(avatarMount(row));

    /* This person's open questions come FIRST, above their own fields: a disagreement should be
       answered where the record is being read, not on a screen you have to remember to visit. */
    itemsFor(row.employee_id).forEach(function (it) { body.appendChild(personQuestion(it, row)); });

    body.appendChild(fieldGrid(row));

    var ps = el('div', 'crew-sect');
    ps.style.marginTop = '0';
    ps.appendChild(el('h2', null, 'OLCC permit'));
    ps.appendChild(el('span', null, 'METRC owns these · read-only here'));
    body.appendChild(ps);
    body.appendChild(permitCard(row));

    var ls = el('div', 'crew-sect');
    ls.appendChild(el('h2', null, 'Links &amp; visibility'));
    body.appendChild(ls);
    body.appendChild(linksCard(row));

    body.appendChild(personFooter(row));
    /* Below the button that opened it, not above — the chooser is what "Merge duplicate…" does
       next, and putting it before the footer made it read as part of the record. */
    if (state.merging && state.canEdit) body.appendChild(mergeBox(row));
    pane.appendChild(body);
  }

  function personHeader(row) {
    var head = el('div', 'crew-phead');
    var inner = el('div', 'crew-phead-in');

    /* THE CIRCLE IS THE CONTROL. Sky, 2026-08-25: "if in Crew, you just click on the user Avatar
       circle to pull up the LB version that'd be great." It replaces a text button that sat over
       in the actions row — two affordances for one action, and the noise he was complaining about.

       A real <button>, not a div with a click handler: this is the only way into the avatar editor
       now, so it has to be reachable by Tab and operable by Enter/Space. The title and the pointer
       cursor are load-bearing too — an avatar that silently does nothing on click is worse than no
       affordance at all, and nothing else on this header is clickable. */
    var puckBtn = el('button', 'crew-avabtn');
    puckBtn.type = 'button';
    puckBtn.disabled = !state.canEdit;
    function paintHeadPuck() {
      puckBtn.innerHTML = '';
      puckBtn.appendChild(avatarPuck(row, 'xl'));
      puckBtn.title = !state.canEdit ? 'Avatar — read-only'
        : state.avatarOpen ? 'Close the avatar builder'
        : (parseCfg(row) ? 'Change this avatar' : 'Give them an avatar');
      puckBtn.setAttribute('aria-label', puckBtn.title);
      puckBtn.setAttribute('aria-expanded', state.avatarOpen ? 'true' : 'false');
    }
    paintHeadPuck();
    /* Held for the picker's onSaved, so a new face lands in the circle without repainting the pane
       the picker is mounted in. Cleared by paintPane, like repaintName. */
    repaintHeadPuck = paintHeadPuck;
    puckBtn.addEventListener('click', function () {
      state.avatarOpen = !state.avatarOpen;
      paintPane();
    });
    inner.appendChild(puckBtn);

    var txt = el('div', 'crew-phead-txt');
    var nameRow = el('div', 'crew-pnamerow');

    /* READ-ONLY, and that is the point. This line reads "Mike Kettler" — a nickname joined to a
       legal surname — so it is a rendering of two fields, not either one of them. It used to be
       an input bound to full_name; leaving it that way now would write "Mike" into the column
       METRC and payroll match on, which is exactly how #22 reached the roster misspelled in the
       first place. Legal name and nickname are edited as their own cards in the grid below. */
    var nameEl = el('span', 'crew-pname');
    var legal = el('span', 'crew-pnick');
    function paintName() {
      var named = !!String(row.name || '').trim();
      nameEl.className = 'crew-pname' + (named ? '' : ' is-blank');
      nameEl.textContent = named ? displayName(row) : '⚠ Record blanked';
      var lf = legalFirst(row);
      legal.textContent = lf ? '“' + lf + '”' : '';
      legal.title = lf ? 'Legal first name — METRC and payroll match on this spelling' : '';
    }
    paintName();
    /* Held for the two fields that change what this line says, so saving a nickname repaints the
       heading without repainting the pane out from under the cursor that is still typing in it. */
    repaintName = paintName;
    nameRow.appendChild(nameEl);
    nameRow.appendChild(legal);
    if (row.retired) nameRow.appendChild(el('span', 'crew-tag', 'retired'));
    txt.appendChild(nameRow);

    var meta = el('div', 'crew-pmeta');
    var st = el('span', 'crew-pmeta-store');
    var dot = el('span', 'crew-pmeta-dot');
    var c = storeColor(row.store);
    if (c) dot.style.setProperty('--crew-store-color', c);
    st.appendChild(dot);
    st.appendChild(el('span', null, esc(row.store ? storeName(row.store) : 'No store')));
    meta.appendChild(st);
    [esc(row.role),
     row.time_with_company && row.time_with_company !== '—'
       ? esc(row.time_with_company) + ' with the company' : 'no hire date on file'
    ].forEach(function (t) {
      meta.appendChild(el('span', 'crew-pmeta-sep', '·'));
      meta.appendChild(el('span', null, t));
    });
    meta.appendChild(el('span', 'crew-pmeta-sep', '·'));
    meta.appendChild(el('span', 'crew-pmeta-num', '#' + esc(row.employee_number || '—')));
    txt.appendChild(meta);
    inner.appendChild(txt);

    var acts = el('div', 'crew-pacts');
    var isEom = state.eom && String(state.eom) === String(row.employee_id);
    var eomBtn = el('button', 'crew-btn crew-eomtog' + (isEom ? ' is-on' : ''), '★ EoM');
    eomBtn.type = 'button';
    eomBtn.disabled = !state.canEdit;
    eomBtn.title = isEom ? 'Holds Employee of the Month — click to clear it'
                         : 'Make them Employee of the Month';
    /* Keyed on employee_id, never on a name: Leaderboard used to key this on a name-derived
       string, so renaming somebody silently dropped the star off the board. */
    eomBtn.addEventListener('click', function () {
      setEom(isEom ? '' : String(row.employee_id), row.name);
    });
    acts.appendChild(eomBtn);
    /* The "Avatar" / "Close avatar" button used to live here. It is gone — the circle at the front
       of this header opens the picker now. */
    inner.appendChild(acts);

    head.appendChild(inner);
    return head;
  }

  /* The same card as the overview's, plus the now → proposed chips. They belong here rather than
     there because this is where you can see what the proposal would replace. */
  function personQuestion(it, row) {
    var box = el('div', 'crew-pq sev-' + (it.severity || 'info'));
    var head = el('div', 'crew-pq-head');
    head.appendChild(el('span', 'crew-pq-kind', esc(KIND_LABEL[it.kind] || it.kind)));
    head.appendChild(el('span', 'crew-pq-src', esc(it.source || '')));
    box.appendChild(head);
    box.appendChild(el('p', 'crew-pq-detail', esc(it.detail || '')));

    /* Both halves or neither. A compliance item's "proposed value" is a verb — renew, revoke,
       assign next number — so pairing it against the current expiry date reads as a swap that is
       not on offer, and a lone chip beside a "—" says even less. */
    if (it.current_value && it.proposed_value) {
      var cmp = el('div', 'crew-pq-cmp');
      cmp.appendChild(el('span', 'crew-pq-chip', esc(it.current_value)));
      cmp.appendChild(el('span', 'crew-pq-arrow', '→'));
      cmp.appendChild(el('span', 'crew-pq-chip is-proposed', esc(it.proposed_value)));
      box.appendChild(cmp);
    }

    if (state.canEdit) {
      var acts = el('div', 'crew-pq-acts');
      var go = el('button', 'crew-btn is-primary', esc(ctaFor(it.kind)));
      var no = el('button', 'crew-btn', 'Keep what we have');
      go.type = 'button'; no.type = 'button';
      var btns = [go, no];
      go.addEventListener('click', function () {
        if (it.kind === 'duplicate' &&
            !confirm('Merge "' + it.merge_from_name + '" into "' + it.name + '"?\n\n' +
                     'Nothing is deleted, and future imports of "' + it.merge_from_name +
                     '" will resolve to ' + it.name + '.')) return;
        resolveItem(it, 'accept', box, btns);
      });
      /* "Keep" and "dismiss" are different recorded answers, not two words for closing a card:
         keep says the value we hold is right, dismiss says the question was never a problem. */
      no.addEventListener('click', function () { resolveItem(it, 'keep', box, btns); });
      acts.appendChild(go); acts.appendChild(no);
      box.appendChild(acts);
    }
    return box;
  }

  /* HOW this person is paid, which is what decides whether an empty wage is a gap or a fact.
     Sits ON the wage card rather than in Links & visibility, because it is a statement about this
     field and nowhere else — and because the gold border it clears is what prompts somebody to
     reach for it. A select rather than a checkbox: the first version was "not on payroll", which
     collapsed salaried managers and the owner into one claim, and the salaried ones are very much
     on payroll. */
  var PAY_TYPES = [['hourly', 'Paid hourly'], ['salary', 'Salaried'], ['none', 'Not on payroll']];
  function payTypeControl(row, repaintNote) {
    var wrap = el('div', 'crew-field-toggle');
    var sel = el('select');
    sel.innerHTML = PAY_TYPES.map(function (t) {
      return '<option value="' + t[0] + '"' +
             ((row.pay_type || 'hourly') === t[0] ? ' selected' : '') + '>' + esc(t[1]) + '</option>';
    }).join('');
    sel.disabled = !state.canEdit;
    sel.setAttribute('aria-label', 'How this person is paid');
    var last = row.pay_type || 'hourly';
    sel.addEventListener('change', function () {
      var v = sel.value, prev = last;
      last = v;
      sel.disabled = true;
      saveField(row, 'attr', 'pay_type', v, 'pay basis', prev, function (r, err) {
        sel.disabled = false;
        if (err) { last = prev; sel.value = prev; return; }
        row.pay_type = v;
        row.wage_exempt = v !== 'hourly';
        /* The gap is the engine's to declare, but it cannot re-answer without a reload, and the
           point of the control is that the gold border goes as you change it. */
        retagFlag(row, 'wage', !row.wage_exempt && !row.wage);
        repaintNote();
        paintRail();
      }).catch(function () {});
    });
    wrap.appendChild(sel);
    return wrap;
  }

  function fieldGrid(row) {
    var grid = el('div', 'crew-fields');

    var storeOpts = [['', '— none —']]
      .concat(Object.keys(state.stores).map(function (sid) { return [sid, state.stores[sid]]; }))
      .concat([['corporate', 'Corporate']]);

    /*
     * Role is a closed set of four, so it is picked and never typed. A free-text box is how
     * "Assistant Store Manager" and "Assistant Manager" both ended up in a registry Leaderboard
     * groups by, and neither one is a typo anybody would notice.
     *
     * The one subtlety: a row may already HOLD a title outside the four, put there by an older
     * import. Dropping it from the list would mean opening this pane to fix a birthday and
     * silently re-filing that person as somebody else on the next save. So an off-list value is
     * carried as its own option, selected, and labelled — visible, kept, one click from correct.
     */
    var held = row.role_is_default ? '' : String(row.role || '').trim();
    var offList = held && state.roleTitles.indexOf(held) < 0;
    var roleOpts = [['', '— none — (shows as Budtender)']]
      .concat(state.roleTitles.map(function (t) { return [t, t]; }))
      .concat(offList ? [[held, held + ' — not a standard role']] : []);

    [
      /* Legal name lives HERE rather than in the header, because the header now shows a nickname
         joined to a surname and an input over that would save the wrong string into the column
         payroll and METRC match on. Its own card, next to the nickname, is also where you would
         look to see the two together. */
      { label: 'Legal name', route: 'identity', field: 'full_name', value: row.name,
        placeholder: 'first and last', confirm: true, renames: true,
        confirmNote: 'GX Core records a rename alias, so Leaderboard and SPIFF keep resolving ' +
          'the old key — but this is the spelling payroll and the OLCC permit are matched against.',
        note: function (r) {
          return String(r.name || '').trim()
            ? { text: 'METRC owns this spelling', kind: '' }
            : { text: 'Blanked by a partial write — put it back', kind: 'bad' };
        },
        read: function (r) { return r.name || ''; } },

      { label: 'Nickname', route: 'identity', field: 'preferred_name', value: row.preferred_name,
        placeholder: 'shown on the board', renames: true,
        note: function () { return { text: 'What the kiosk and this roster call them', kind: '' }; },
        read: function (r) { return r.preferred_name || ''; } },

      { label: 'Store', route: 'identity', field: 'home_store', value: row.store,
        options: storeOpts, confirm: true,
        note: function (r) { return r.store ? { text: '', kind: '' }
                                            : { text: 'No store on file', kind: 'gap' }; } },

      { label: 'Role', route: 'identity', field: 'role_title', value: held,
        options: roleOpts, confirm: true,
        note: function (r) {
          return has(r, 'no_account')
            ? { text: 'Manager with no GX account', kind: 'bad' }
            : { text: 'One of four titles', kind: '' };
        } },

      { label: 'Hire date', route: 'identity', field: 'hire_date', value: row.hire_date, type: 'date',
        note: function (r) { return r.hire_date
          ? { text: 'Drives tenure and anniversaries', kind: '' }
          : { text: 'Missing — no tenure, no anniversary', kind: 'gap' }; } },

      { label: 'Wage', route: 'attr', field: 'wage', value: row.wage, placeholder: '0.00',
        note: function (r) {
          if (r.pay_type === 'none')   return { text: 'Owner — not on payroll', kind: '' };
          if (r.pay_type === 'salary') return { text: 'Salaried — no hourly rate', kind: '' };
          return r.wage ? { text: 'Hourly rate', kind: '' } : { text: 'Not set', kind: 'gap' };
        },
        read: function (r) { return r.wage || ''; },
        extra: payTypeControl },

      { label: 'Birthday', route: 'attr', field: 'birthday', value: row.birthday, placeholder: 'MM-DD',
        title: 'Month and day only — GX Crew does not store birth years.',
        note: function (r) { return { text: 'Month and day only', kind: r.birthday ? '' : 'gap' }; },
        read: function (r) { return r.birthday || ''; } },

      { label: 'Shirt size', route: 'attr', field: 'shirt_size', value: row.shirt_size,
        options: [['', '—']].concat(state.shirtSizes.map(function (x) { return [x, x]; })),
        note: function () { return { text: '', kind: '' }; } },

      /* Shown, never editable. The number is issued by the system and never reused — typing one
         risks handing a new person a retired employee's history. The engine refuses it outright. */
      { label: 'Employee #', value: row.employee_number || 'auto', disabled: true,
        note: function () { return { text: 'Issued, never reused', kind: '' }; } }
    ].forEach(function (o) { grid.appendChild(fieldCard(row, o)); });

    return grid;
  }


  /* ── OLCC permit ──────────────────────────────────────────────────────────────
   * READ-ONLY, because METRC owns every value in it and an import overwrites whatever is here
   * the next time one runs. Typing over it would be a change with a shelf life.
   *
   * With ONE exception, and it is the reason the exception exists at all: when there is no
   * permit number on file the queue raises a `missing_permit` item at HIGH severity whose only
   * offered answer is "Mark handled" — an acknowledgement, not a fix. Seven active staff are in
   * that state. Leaving the card read-only there would make the highest-severity item on the
   * board unresolvable except by lying about it, so an empty permit becomes two inputs and
   * nothing else does. saveRosterAttrs_ has allowed exactly this since it was written.
   */
  function permitCard(row) {
    var pd = row.permit_days_left;
    var expired = pd != null && pd < 0;
    /* An expiry the engine could not parse counts as damage too: nobody is watching that permit,
       because every compliance check downstream gates on permit_days_left being a number. */
    var unreadable = !!row.permit_expires && pd == null;
    var box = el('div', 'crew-permit' +
      ((expired || unreadable || !row.permit_number) ? ' is-bad' : ''));

    var top = el('div', 'crew-permit-top');
    var statusCls = unreadable ? 'is-bad-t'
      : !row.permit_status ? 'is-warn'
      : ['active', 'valid'].indexOf(String(row.permit_status).toLowerCase()) >= 0
        ? (pd != null && pd <= 90 ? 'is-warn' : 'is-ok') : 'is-bad-t';

    if (row.permit_number || !state.canEdit) {
      top.appendChild(el('span', 'crew-permit-no', esc(row.permit_number || 'No permit number on file')));
      top.appendChild(el('span', 'crew-permit-pill ' + statusCls,
        esc(row.permit_status ? String(row.permit_status).toUpperCase() : 'UNKNOWN')));
      /* THREE states, not two. The engine returns permit_days_left = null when it could not read
         the stored expiry, and the old arithmetic here ran anyway — printing the literal
         "null days left" next to a date, which is how this was noticed. A date it cannot count
         from is a defect in the record, so it says so rather than quietly showing a number. */
      var line, lineCls;
      if (!row.permit_expires) {
        line = 'METRC has no matching record under this name'; lineCls = 'is-warn';
      } else if (pd == null) {
        line = 'Expiry on file cannot be read: ' + row.permit_expires; lineCls = 'is-bad-t';
      } else if (expired) {
        line = 'Expired ' + Math.abs(pd) + ' days ago · ' + row.permit_expires; lineCls = 'is-bad-t';
      } else {
        line = pd + ' days left · expires ' + row.permit_expires;
        lineCls = pd <= 90 ? 'is-warn' : '';
      }
      top.appendChild(el('span', 'crew-permit-line ' + lineCls, esc(line)));
    } else {
      var noIn = el('input', 'crew-permit-in is-no');
      noIn.placeholder = 'OLCC-000000';
      noIn.setAttribute('aria-label', 'OLCC permit number');
      var exIn = el('input', 'crew-permit-in');
      exIn.type = 'date';
      exIn.setAttribute('aria-label', 'Permit expiry');
      var add = el('button', 'crew-btn', 'Add permit');
      add.type = 'button';
      add.addEventListener('click', async function () {
        var num = noIn.value.trim();
        if (!num) { toast('Type the permit number first', true); return; }
        add.disabled = true;
        try {
          await postField(row, 'attr', 'permit_number', num);
          if (exIn.value) {
            var r2 = await postField(row, 'attr', 'permit_expires', exIn.value);
            applySaved(row, 'attr', 'permit_expires', exIn.value, r2);
          } else {
            row.permit_number = num;
          }
          retagFlag(row, 'permit', false);
          toast('Saved · OLCC permit');
          paintRail(); paintPane();
        } catch (e) {
          add.disabled = false;
          toast((e && e.message) || 'Save failed', true);
        }
      });
      top.appendChild(noIn); top.appendChild(exIn); top.appendChild(add);
      var hint = el('span', 'crew-permit-line is-warn', 'METRC has no record — type it in if you have it');
      top.appendChild(hint);
    }
    box.appendChild(top);

    /* A two-year permit drawn as elapsed time. It is a shape, not a measurement — the point is
       that a bar nearly full is a renewal you should already be arranging. */
    var bar = el('div', 'crew-permit-bar');
    var fill = el('div', 'crew-permit-fill');
    fill.style.width = pd == null ? '0%'
      : expired ? '100%' : Math.max(4, Math.min(100, Math.round((1 - pd / 730) * 100))) + '%';
    if (unreadable) fill.style.width = '100%';
    fill.style.background = statusCls === 'is-ok' ? 'var(--gx-green)'
      : statusCls === 'is-warn' ? 'var(--gx-gold)' : 'var(--gx-red)';
    bar.appendChild(fill);
    box.appendChild(bar);
    return box;
  }


  /* ── Links & visibility ───────────────────────────────────────────────────────
     The three columns a partial write destroys, shown together and named, because nothing else
     on this pane would tell you they exist until they were gone. */
  function linksCard(row) {
    var box = el('div', 'crew-links');
    var pills = el('div', 'crew-linkrow');
    [['Dutchie', row.dutchie_employee_id || 'not linked', row.dutchie_employee_id ? '' : 'is-warn'],
     ['GX account', row.user_id || 'none',
       row.user_id ? '' : (has(row, 'no_account') ? 'is-bad' : '')],
     ['Employee', '#' + (row.employee_number || '—'), '']
    ].forEach(function (l) {
      var p = el('span', 'crew-linkpill' + (l[2] ? ' ' + l[2] : ''));
      p.appendChild(el('span', 'crew-linkpill-l', esc(l[0])));
      p.appendChild(el('span', null, esc(l[1])));
      pills.appendChild(p);
    });
    box.appendChild(pills);
    box.appendChild(el('p', 'crew-linknote',
      'Every save is read-merge-write, so these links survive it. Blank one and the join to ' +
      'SPIFF, Leaderboard or email breaks silently.'));

    /* Deliberately NOT inferred from role or store: `corporate` and `Admin` both belong to real
       staff who should be celebrated. It is off for the handful of people who are on the roster
       for access rather than for work. Stored inverted — the column is an opt-OUT. */
    var lbl = el('label', 'crew-celeb');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !row.celebrations_opt_out;
    cb.disabled = !state.canEdit;
    cb.addEventListener('change', function () {
      var on = cb.checked;
      cb.disabled = true;
      /* 'no', not '' — an empty value is an explicit clear on this route, and while that happens
         to store the same thing, saying what you mean is what keeps the next reader honest. */
      saveField(row, 'attr', 'celebrations_opt_out', on ? 'no' : 'yes',
        on ? 'celebrations on' : 'celebrations off', null, function (r, err) {
          cb.disabled = false;
          if (err) cb.checked = !on;
        }).catch(function () {});
    });
    lbl.appendChild(cb);
    lbl.appendChild(el('span', null, 'Show birthday and work anniversary on the kiosk'));
    box.appendChild(lbl);

    /* The Monday recap, as this person's own preference rather than a list in the engine.
       Needs a GX account, because that is where the address comes from — so when there is no
       account the control says why instead of storing a wish that can never be honoured. */
    /* user_id is the MAILBOX NAME (`sky`), not an address — the engine reassembles the rest. */
    var hasAccount = !!String(row.user_id || '').trim();
    var dl = el('label', 'crew-celeb');
    var dcb = el('input');
    dcb.type = 'checkbox';
    dcb.checked = !!row.digest_opt_in;
    dcb.disabled = !state.canEdit || !hasAccount;
    dcb.addEventListener('change', function () {
      var on = dcb.checked;
      dcb.disabled = true;
      saveField(row, 'attr', 'digest_opt_in', on ? 'yes' : 'no',
        on ? 'Monday recap on' : 'Monday recap off', null, function (r, err) {
          dcb.disabled = false;
          if (err) dcb.checked = !on;
          else row.digest_opt_in = on;
        }).catch(function () {});
    });
    dl.appendChild(dcb);
    dl.appendChild(el('span', null, hasAccount
      ? 'Email them the Monday recap — everything that needs a person'
      : 'Email them the Monday recap — needs a GX account first, so there is nowhere to send it'));
    box.appendChild(dl);
    return box;
  }


  /* ── Footer: merge and retire ─────────────────────────────────────────────── */
  function personFooter(row) {
    var foot = el('div', 'crew-pfoot');
    if (!state.canEdit) {
      foot.appendChild(el('span', 'crew-hint', 'Your role is read-only on the Crew roster.'));
      return foot;
    }

    var mg = el('button', 'crew-btn', state.merging ? 'Cancel merge' : 'Merge duplicate…');
    mg.type = 'button';
    mg.addEventListener('click', function () { state.merging = !state.merging; paintPane(); });
    foot.appendChild(mg);

    /* Nothing is deleted. Retired staff keep their record, their permit history and their
       employee number; they drop out of the default view. */
    var ret = el('button', 'crew-btn is-danger crew-pfoot-right', row.retired ? 'Un-retire' : 'Retire');
    ret.type = 'button';
    ret.addEventListener('click', async function () {
      if (!row.retired && !confirm('Retire ' + (row.name || 'this person') + '?\n\n' +
          'They drop out of the roster but keep their record, permit history and employee number.')) return;
      ret.disabled = true;
      try {
        var r = await Engine.jsonp('roster_retire',
          { token: token(), employee_id: row.employee_id, retired: row.retired ? '0' : '1' },
          { timeoutMs: 45000, retries: 2 });
        if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
        toast(row.retired ? 'Un-retired · ' + row.name : 'Retired · ' + row.name);
        boot(true);
      } catch (e) {
        ret.disabled = false;
        toast((e && e.message) || 'Failed', true);
      }
    });
    foot.appendChild(ret);
    return foot;
  }

  /* Merging is picking the OTHER record. The old roster did it as a two-click dance across a
     table — mark a row, scroll, press "keep this one" on another — which only worked while both
     rows were on screen at once. There is no table now, so it is a search: this record is always
     the one kept, and you choose who folds into it. */
  function mergeBox(row) {
    var box = el('div', 'crew-mergebox');
    box.appendChild(el('p', 'crew-hint',
      '<b style="color:var(--gx-text)">' + esc(row.name) + '</b> is kept. Any field they are ' +
      'missing is filled from the record you pick. Nothing is deleted, and future imports of ' +
      'the other name resolve here.'));

    var find = el('input', 'crew-search');
    find.type = 'search';
    find.placeholder = 'Find the duplicate record…';
    find.style.marginTop = '10px';
    box.appendChild(find);

    var list = el('div', 'crew-mergelist');
    box.appendChild(list);

    function paint() {
      list.innerHTML = '';
      var q = find.value.trim().toLowerCase();
      var cands = state.rows.filter(function (r) {
        return String(r.employee_id) !== String(row.employee_id) &&
               (!q || (r.name + ' ' + r.employee_number + ' ' + storeName(r.store)).toLowerCase().indexOf(q) >= 0);
      }).sort(byName).slice(0, 40);
      if (!cands.length) { list.appendChild(el('p', 'crew-hint', 'Nobody matches.')); return; }
      cands.forEach(function (c) {
        var b = el('button', 'crew-mergerow');
        b.type = 'button';
        b.appendChild(avatarPuck(c));
        b.appendChild(el('span', null, esc(displayName(c) || c.employee_id) +
          (c.retired ? ' <span class="crew-tag">retired</span>' : '')));
        b.appendChild(el('em', null, esc(storeName(c.store)) + ' · #' + esc(c.employee_number || '—')));
        b.addEventListener('click', async function () {
          if (!confirm('Merge "' + c.name + '" into "' + row.name + '"?\n\n' +
                       row.name + ' is kept. Any field they are missing is filled from ' +
                       c.name + '. Nothing is deleted, and future imports of "' + c.name +
                       '" will resolve to ' + row.name + '.')) return;
          b.disabled = true;
          try {
            var r = await Engine.jsonp('roster_merge',
              { token: token(), keep: row.employee_id, merge: c.employee_id, confirm: 'yes' },
              { timeoutMs: 45000, retries: 2 });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Merge failed');
            state.merging = false;
            toast('Merged · ' + c.name + ' → ' + row.name);
            boot(true);
          } catch (e) {
            b.disabled = false;
            toast((e && e.message) || 'Merge failed', true);
          }
        });
        list.appendChild(b);
      });
    }
    find.addEventListener('input', paint);
    paint();
    return box;
  }


  /* ── Avatar picker — gx-theme's, mounted here ─────────────────────────────────
   * Crew's own 105-line panel is RETIRED, not merged (2026-08-25). It lost on the merits:
   * Sky — "I like the LB picker better... the current, simplified version in Crew is efficient
   * but not intuitive and just adds noise." The one builder for the suite now lives in
   * gx-theme as GXAvatarPicker, promoted from Leaderboard; both apps mount the same component,
   * so a face is built the same way whichever screen you are standing in front of.
   *
   * FOUR THINGS THIS FUNCTION IS RESPONSIBLE FOR, and each is the reason it is not one line:
   *
   *   THE SEED. GXAvatarPicker generates its preview from `seed`, and Leaderboard cannot pass a
   *   real one — its getavatardata carries no employee_number, so it falls back to a name-derived
   *   string, which is exactly what pinning exists to stop mattering. Crew CAN: `row.avatar_seed`
   *   is the engine's read-side answer (avatarSeedFrom_ — attrs employee_number, then the Core
   *   row's, then employee_id for somebody not yet numbered) and it is the same value avatarPuck
   *   renders beside the picker, so the preview and the circle above it agree by construction.
   *   Do not pass employee_number directly: it is the attrs value only, and it is blank for the
   *   unnumbered, which would silently hand them DiceBear's 'unknown' face.
   *
   *   SAVE IS ONE PATH. save(cfg) with cfg === null means REMOVE, and both land on
   *   roster_identity -> saveAvatarOnly_ -> GXCore.setAvatar, which pins the seed, retries lock
   *   contention, NAMES avatar_config in clear= and then verifies the clear landed. postField
   *   throws on !ok AND on a warning, so a refused clear surfaces in the picker's status line
   *   rather than being reported as a save.
   *
   *   NO LEADERBOARD MOCK, NO .gxava-full. showLeaderboardPreview is off: that mock is a sales
   *   standings row and this is an HR record. .gxava-full sets min-height:100vh, which assumes
   *   the component owns the viewport; here it is a panel inside a person.
   *
   *   REPAINTING WITHOUT UNMOUNTING. A save has to move the circle in the header and the face in
   *   the rail, and repainting the pane would tear the picker out from under whoever is still
   *   choosing a hat. onSaved touches only those two, via the closure personHeader leaves behind.
   */
  var avatarHandle = null;
  function destroyAvatarPicker() {
    if (avatarHandle) { try { avatarHandle.destroy(); } catch (e) {} avatarHandle = null; }
  }

  function avatarMount(row) {
    var host = el('div', 'crew-avamount');
    if (!window.GXAvatarPicker) {
      /* gx-theme is loaded by URL from Pages. If that request failed, say so — an empty box where
         an editor should be reads as a bug in Crew. */
      host.appendChild(banner('warn',
        'The avatar builder did not load (gx-avatar-picker.js from gx-theme). Reload the page.'));
      return host;
    }
    destroyAvatarPicker();
    avatarHandle = GXAvatarPicker.mount(host, {
      name:   displayName(row) || row.name || '',
      seed:   row.avatar_seed || row.employee_id,
      config: parseCfg(row),
      showLeaderboardPreview: false,
      save: function (cfg) {
        /* '' is not "leave alone" here — postField names the field, and the engine reads a named
           empty avatar_config as a clear. That is the whole reason Remove works. */
        var payload = cfg ? JSON.stringify(cfg) : '';
        return postField(row, 'identity', 'avatar_config', payload).then(function (res) {
          row.avatar_config = payload;
          /* setAvatar stamps the seed and hands it back. Adopt it so the puck and the picker keep
             agreeing without waiting for the next roster read to re-derive it. */
          if (res && res.seed) row.avatar_seed = String(res.seed);
          return res;
        });
      },
      onSaved: function (cfg) {
        toast(cfg ? 'Saved · avatar' : 'Saved · avatar removed');
        if (repaintHeadPuck) repaintHeadPuck();
        paintRail();
      },
      close: function () { state.avatarOpen = false; paintPane(); }
    });
    return host;
  }


  function render() {
    initBugReport();          // no-op once wired; here so a late gx-bugreport.js still gets picked up
    renderWorkspace();
  }

  /* One listener for the shared header's menu. gx-topnav.js emits the event; what each action MEANS
     is the app's business, which is why the component does not hardcode any of it. */
  document.addEventListener('gx-topnav:action', function (e) {
    var a = e.detail && e.detail.action;
    if (a === 'logout') {
      setSession('', '');
      state.rows = []; state.review = null; state.selected = null;
      state.eom = undefined; state.eomHistory = undefined; state.dismissed = {};
      ui = null;
      var slot = document.getElementById('userSlot'); if (slot) slot.innerHTML = '';
      var tabs = document.getElementById('navTabs');  if (tabs) tabs.innerHTML = '';
      renderLogin();
    }
    // No 'version' branch: GXTopNav opens the shared release-history popup by default
    // (gx-changelog.js). It used to paint the number into the status line — which replaced whatever
    // the roster was telling you, to say something already printed on the row you clicked.
  });


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
      /* Retired rows are asked for ONCE and then kept. The Retired scope needs them and the
         other two do not, but re-reading a ten-second join every time somebody flicks the
         segmented control back and forth is the kind of cost that teaches people not to look. */
      var wantRetired = state.scope === 'retired' || state.fetchedRetired;
      var r = await Engine.jsonp('roster',
        { token: token(), include_retired: wantRetired ? '1' : '' },
        { timeoutMs: 45000, retries: 2 });
      if (!r || !r.ok) {
        // An expired/revoked session should drop to the login form, not a dead-end error.
        if (r && /auth|session|access/i.test(String(r.error || ''))) { setSession('', ''); renderLogin(r.error); return; }
        throw new Error((r && r.error) || 'Roster load failed');
      }
      state.rows       = r.rows || [];
      state.canEdit    = !!r.can_edit;
      state.shirtSizes = r.shirt_sizes || [];
      // The role vocabulary is the engine's, not the UI's — so the dropdown can never offer a
      // title the engine would refuse, and adding a fifth role is a one-line server change.
      state.roleTitles = r.role_titles || [];
      state.user       = r.user || '';
      state.role       = r.role || '';
      state.identity   = r.identity_source || null;
      state.retiredTotal = r.retired_total || 0;
      state.fetchedRetired = wantRetired;
      state.hrSheetUrl = r.hr_sheet_url || '';

      /* Rebuild the shell only when there isn't one. A refetch after a merge, a retire or an
         accepted question repaints the slots in place, so the search box keeps its text and its
         cursor and the people list keeps its scroll. */
      if (ui) { paintSubnav(); paintRail(); paintPane(); }
      else render();

      /* Both of these fill the OVERVIEW, and both are slow reads against the same sheets — so
         they load behind the roster rather than in front of it, and paint themselves in when
         they arrive. The roster is usable without either. */
      if (state.review === null) loadReview();
      if (state.eom === undefined) loadEom();
    } catch (e) {
      renderStatus('⚠️ Could not load the roster: ' + esc((e && e.message) || 'unknown error'));
    }
  }

  /* The clock is chrome, not session state -- start it once at boot so it is never showing placeholder
     dashes on the login screen. Store colours load here too, so --store-<id> is painted before any view
     that uses them renders. */
  function startChrome() {
    if (window.GXTopNav) GXTopNav.startClock();
    if (window.GXStores) GXStores.load(GXCORE_URL).catch(function () { /* colours are a nicety */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { startChrome(); boot(); });
  } else { startChrome(); boot(); }
})();
