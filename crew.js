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
  // Single-sourced from the ?v=N cache-buster on this script tag -- the same value deploy.sh records,
  // so the version in the user menu can never drift from the version that shipped.
  var APP_VERSION = (function () {
    var m = /[?&]v=(\d+)/.exec((document.currentScript && document.currentScript.src) || '');
    return m ? 'v' + m[1] : 'dev';
  })();

  var mount = document.getElementById('app');
  var GXCore = window.GXClient(GXCORE_URL);
  var Engine = null;           // built once we know the engine URL
  var state  = { rows: [], canEdit: false, shirtSizes: [], roleTitles: [], user: '', role: '', identity: null,
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
      (r && r.stores || []).forEach(function (s) { state.stores[s.store_id] = s.display_name || s.store_id; });
    } catch (e) { /* fall back to the raw slug */ }
  }
  /* `corporate` is not a shop and so is deliberately absent from GX Core's store registry —
     it is where the admin team sits. Label it here rather than showing the raw slug. */
  var PSEUDO_STORES = { corporate: 'Corporate' };
  function storeName(id) {
    return id ? (state.stores[id] || PSEUDO_STORES[id] || id) : '—';
  }


  /* ── Avatars ────────────────────────────────────────────────────────────────
   * buildAvatarUrl and the GC hat SVG are lifted VERBATIM from Leaderboard so a face is
   * byte-identical in both apps. Do not "tidy" the parameter rules — each one encodes a
   * DiceBear quirk: `_none` means probability 0 and skip the colour, `_gchat` renders
   * shortFlat underneath with our hat overlaid, and hat/winterHat1 take hatColor rather
   * than hairColor. Leaderboard keeps only these render bits; Crew owns the data.
   */
  var GC_HAT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 280.01"><g><g><path d="M86.239,62.287c48.508-3.223,59.204-3.223,107.712,0,2.156,9.668,18.16,23.768,9.425,19.336-13.835-7.019-113.784-7.302-125.645.412-6.37,4.143,6.352-10.08,8.507-19.748Z" fill="#2c302d" stroke="#000" stroke-linejoin="round" stroke-width="4"/><path d="M86.7,67.121c-6.468-46.192,32.82-57.199,53.6-57.199,23.549,0,59.586,11.007,53.119,57.199h-106.718Z" fill="#2c302d" stroke="#000" stroke-linejoin="round" stroke-width="4"/><path d="M140.3,4.3c2.679,0,4.851.598,4.851,3.268s-1.931,2.341-4.61,2.341-5.091.329-5.091-2.341,2.172-3.268,4.851-3.268Z"/></g><path d="M146.709,23.878l.003,4.438c0,1.872-1.514,3.387-3.387,3.387l-.003-6.751c0-.578-.468-1.074-1.074-1.074h-4.02c-.578,0-1.074.496-1.074,1.074l-.029,6.405c0,1.873-1.514,3.387-3.359,3.387h-6.334c-.578,0-1.074.496-1.074,1.074v4.02c0,.606.496,1.074,1.074,1.074h4.998c.579,0,1.074-.468,1.074-1.074v-.22c0-1.983,1.597-3.58,3.58-3.58v4.681c0,1.983-1.597,3.58-3.58,3.58h-7.146c-1.982,0-3.58-1.597-3.58-3.58v-5.755c0-1.982,1.597-3.607,3.58-3.607h7.418s0-.748,0-.748l-.008-6.731c0-1.982,1.625-3.58,3.607-3.58h5.755c1.983,0,3.58,1.597,3.58,3.58ZM133.769,51.891l-.003-4.438c0-1.872,1.514-3.387,3.387-3.387l.003,6.751c0,.578.468,1.074,1.074,1.074h4.02c.578,0,1.074-.496,1.074-1.074l-.008-6.751c1.873,0,3.387,1.515,3.387,3.387l.008,4.438c0,1.982-1.625,3.58-3.607,3.58h-5.755c-1.983,0-3.58-1.597-3.58-3.58ZM157.192,44.365h-10.415c-1.982,0-3.58-1.597-3.58-3.58v-5.755c0-1.982,1.597-3.607,3.58-3.607h10.446c0,1.873-1.515,3.387-3.387,3.387h-5.985c-.578,0-1.074.496-1.074,1.074v4.02c0,.606.496,1.074,1.074,1.074h5.954c1.872,0,3.387,1.515,3.387,3.387Z" fill="#93d500"/></g></svg>';

  var HAT_TOPS = { hat: true, winterHat1: true };

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

  var AVATAR_OPTIONS = {
    skinColor:    ['ffdbb4','f8d25c','fd9841','edb98a','d08b5b','ae5d29','614335'],
    top: ['_none','_gchat','hat','winterHat1','bigHair','bob','bun','curly','curvy','dreads','dreads01','dreads02','frida','frizzle','fro','froBand','longButNotTooLong','miaWallace','shaggy','shaggyMullet','shavedSides','shortCurly','shortFlat','shortRound','shortWaved','sides','straight01','straight02','straightAndStrand','theCaesar','theCaesarAndSidePart'],
    hairColor:    ['2c1b18','4a312c','724133','a55728','b58143','c93305','d6b370','e8e1e1','ecdcbf','f59797'],
    hatColor:     ['3c4f5c','65c9ff','262e33','5199e4','25557c','929598','a7ffc4','b1e2ff','e6e6e6','ff5c5c','ff488e','ffafb9','ffdeb5','ffffb1','ffffff'],
    eyes:         ['default','eyeRoll','happy','hearts','side','squint','surprised','wink'],
    eyebrows:     ['default','defaultNatural','flatNatural','frownNatural','raisedExcited','raisedExcitedNatural','upDown','upDownNatural'],
    mouth:        ['default','smile','twinkle','tongue','serious','disbelief'],
    facialHair:      ['_none','beardLight','beardMajestic','beardMedium','moustacheFancy','moustacheMagnum'],
    facialHairColor: ['2c1b18','4a312c','724133','a55728','b58143','c93305','d6b370','e8e1e1','ecdcbf','f59797'],
    clothing:     ['blazerAndShirt','blazerAndSweater','collarAndSweater','graphicShirt','hoodie','shirtCrewNeck','shirtScoopNeck','shirtVNeck'],
    clothesColor: ['3c4f5c','65c9ff','262e33','5199e4','25557c','929598','a7ffc4','b1e2ff','e6e6e6','ff5c5c','ff488e','ffafb9','ffdeb5','ffffb1','ffffff'],
    accessories:  ['_none','prescription01','prescription02','round','sunglasses','wayfarers'],
    accessoriesColor: ['3c4f5c','65c9ff','262e33','5199e4','25557c','929598','a7ffc4','b1e2ff','e6e6e6','ff5c5c','ff488e','ffafb9','ffdeb5','ffffb1','ffffff']
  };
  var COLOR_KEYS = { skinColor:1, hairColor:1, hatColor:1, facialHairColor:1, clothesColor:1, accessoriesColor:1 };
  var OPTION_ORDER = ['top','hairColor','hatColor','skinColor','eyes','eyebrows','mouth',
                      'facialHair','facialHairColor','clothing','clothesColor',
                      'accessories','accessoriesColor'];
  var OPTION_LABEL = { top:'Hair / hat', hairColor:'Hair colour', hatColor:'Hat colour',
    skinColor:'Skin', eyes:'Eyes', eyebrows:'Brows', mouth:'Mouth', facialHair:'Facial hair',
    facialHairColor:'Facial hair colour', clothing:'Clothing', clothesColor:'Clothing colour',
    accessories:'Glasses', accessoriesColor:'Glasses colour' };

  var DEFAULT_AVATAR = { skinColor:'ffdbb4', top:'shortFlat', hairColor:'4a312c', hatColor:'262e33',
    eyes:'default', eyebrows:'default', mouth:'default', facialHair:'_none',
    facialHairColor:'2c1b18', clothing:'shirtCrewNeck', clothesColor:'262e33',
    accessories:'_none', accessoriesColor:'3c4f5c' };

  function parseCfg(row) {
    if (!row.avatar_config) return null;
    try { return JSON.parse(row.avatar_config); } catch (e) { return null; }
  }
  function initialsOf(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }
  /* How Crew writes a person, everywhere it writes one: legal name bold, nickname in quotes
     beside it. A row with NO name is not a blank to render as whitespace — it is a GX Core
     identity row that a partial write blanked, and the roster drew it as an avatar floating
     beside nothing at all, which is exactly how it went unnoticed. Name the damage instead. */
  function nameHtml(row) {
    if (!String(row.name || '').trim()) {
      return '<b class="crew-noname">⚠ Record blanked</b>' +
             ' <span class="crew-nick">' + esc(row.employee_id || '') + '</span>';
    }
    return '<b>' + esc(row.name) + '</b>' +
      (row.preferred_name ? ' <span class="crew-nick">“' + esc(row.preferred_name) + '”</span>' : '');
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

  /* Tabs live in the shared header (#navTabs), not in the page body, so Crew matches every other app.
     Returns null: callers no longer insert a nav node into the main column. */
  function navBar() {
    var nav = document.getElementById('navTabs');
    if (!nav) return null;
    nav.innerHTML = '';
    [['roster', 'Roster'], ['review', 'Review'], ['eom', 'EoM']].forEach(function (v) {
      var n = state.reviewCounts || {};
      var badge = '';
      if (v[0] === 'review' && (n.high || n.warn)) {
        badge = ' <span class="crew-badge' + (n.high ? ' is-high' : '') + '">' +
                ((n.high || 0) + (n.warn || 0)) + '</span>';
      }
      var b = el('button', 'gx-topnav-tab' + (state.view === v[0] ? ' is-active' : ''), v[1] + badge);
      b.addEventListener('click', function () {
        state.view = v[0];
        if (v[0] === 'review' && !state.review) loadReview();
        else if (v[0] === 'eom' && state.eom === undefined) loadEom();
        else render();
      });
      nav.appendChild(b);
    });
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
    navBar();                 // paints the shared header's tab row
    renderUserChip();
    var nodes = [];
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
    render();
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
    if (state.view === 'eom') renderEom();
  }

  async function setEom(employeeId, label) {
    var prev = state.eom;
    state.eom = employeeId || null;            // optimistic: the radio has already moved
    renderEom();
    try {
      var r = await GXCore.jsonp('set_eom',
        { token: token(), employee_id: employeeId || '' }, { retries: 1, timeoutMs: 12000 });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'Save failed');
      renderStatus(employeeId ? ('Employee of the Month: <b>' + esc(label) + '</b>')
                              : 'Employee of the Month cleared');
      // Only now, once Core holds the new value — the engine logs what it READS, so asking any
      // earlier would just record the reign that is being replaced.
      state.eomHistory = undefined;
      loadEomHistory();
    } catch (e) {
      state.eom = prev;                        // put it back rather than lie about what is stored
      renderEom();
      renderStatus('Could not save: ' + esc(e.message || String(e)));
    }
  }

  /* Bare month and year. A reign is a month-scale thing, so a day and a clock time would be
     false precision — and the one date we cannot know exactly is a cleared award's, which the
     engine can only stamp when it first noticed. */
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function eomMonth(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  /* "Aug 2026 — present" while it runs, one month if it began and ended in the same one, a
     range otherwise. Reading "Mar 2026 – Mar 2026" tells you nothing the single month does not. */
  function eomSpan(h) {
    var from = eomMonth(h.started_at);
    if (h.current) return from + ' — present';
    var to = eomMonth(h.ended_at);
    return from === to ? from : from + ' – ' + to;
  }

  function eomHistoryNodes() {
    if (state.eomHistory === undefined) return [el('div', 'gx-muted', 'Loading…')];
    if (state.eomHistoryErr) return [el('div', 'gx-muted', esc(state.eomHistoryErr))];
    if (!state.eomHistory.length) {
      return [el('p', 'crew-hint', 'Nobody has held it yet. Each pick is recorded here from now on.')];
    }

    var byId = {};
    (state.rows || []).forEach(function (r) { byId[String(r.employee_id)] = r; });

    var list = el('ol', 'crew-eomlog');
    state.eomHistory.forEach(function (h) {
      var li = el('li', 'crew-eomlog-row' + (h.current ? ' is-current' : ''));

      if (h.nobody) {
        /* A deliberate "nobody" is part of the record, not a gap in it — the same distinction
           Core draws by storing an empty value instead of deleting the key. */
        li.appendChild(el('span', 'crew-eomlog-none', '—'));
        li.appendChild(el('span', 'crew-eomlog-name', '<i>Nobody held it</i>'));
      } else {
        /* The face comes from the roster where they are still on it, but the NAME comes from the
           log: someone who has since been renamed or retired held it under the name they held it
           under, and quietly restating the present would not be a record of the past. */
        li.appendChild(avatarPuck(byId[h.employee_id] || { name: h.name, employee_id: h.employee_id }));
        li.appendChild(el('span', 'crew-eomlog-name', '<b>' + esc(h.name || h.employee_id) + '</b>'));
      }

      li.appendChild(el('span', 'crew-eomlog-when', esc(eomSpan(h))));
      /* Provenance, because the two are not the same claim. An observed reign is what GX Core
         actually held; a backfilled one is somebody's memory of a month that predates the log,
         accurate to the month at best. Saying which is which costs one word. */
      if (h.backfilled) li.appendChild(el('span', 'crew-eomlog-by', 'recorded'));
      else if (h.set_by) li.appendChild(el('span', 'crew-eomlog-by', 'set by ' + esc(h.set_by)));
      list.appendChild(li);
    });

    return [list, el('p', 'crew-hint',
      'Crew keeps this log — GX Core stores only who holds it right now, so a pick that is not ' +
      'recorded here cannot be recovered later.')];
  }

  function renderEom() {
    clear();
    navBar();
    renderUserChip();

    var live = (state.rows || []).filter(function (r) { return !r.retired; });
    live.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });

    var nodes = [];
    var bar = el('div', 'crew-bar');
    bar.innerHTML = '<span>One person at a time. Picking saves immediately' +
      (state.canEdit ? '' : ' <em>(read-only — you cannot change this)</em>') + '.</span>';
    nodes.push(bar);

    if (state.eom === undefined) {
      nodes.push(el('div', 'gx-muted', 'Loading…'));
      mount.appendChild(card('Employee of the Month', nodes));
      return;
    }

    var grid = el('div', 'crew-eom');
    live.forEach(function (row) {
      var isCur = state.eom && String(row.employee_id) === String(state.eom);
      var lbl = el('label', 'crew-eom-pick' + (isCur ? ' is-current' : ''));

      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'crewEom';
      radio.checked = !!isCur;
      radio.disabled = !state.canEdit;
      radio.addEventListener('change', function () {
        if (radio.checked) setEom(String(row.employee_id), row.name);
      });
      lbl.appendChild(radio);
      lbl.appendChild(avatarPuck(row));

      lbl.appendChild(el('span', 'crew-eom-name', nameHtml(row)));
      lbl.appendChild(el('span', 'crew-eom-store', esc(row.store ? storeName(row.store) : '')));
      grid.appendChild(lbl);
    });

    if (!live.length) grid.appendChild(el('div', 'gx-muted', 'No active employees on the roster.'));
    nodes.push(grid);

    if (state.canEdit) {
      var clearBtn = el('button', 'gx-btn', 'Clear');
      clearBtn.disabled = !state.eom;
      clearBtn.addEventListener('click', function () { setEom('', ''); });
      var foot = el('div', 'crew-eom-foot');
      foot.appendChild(clearBtn);
      nodes.push(foot);
    }

    mount.appendChild(card('Employee of the Month', nodes));
    mount.appendChild(card('Who has held it', eomHistoryNodes()));
  }

  function render() {
    if (state.view === 'review') renderReview();
    else if (state.view === 'eom') renderEom();
    else renderRoster();
  }

  /* One listener for the shared header's menu. gx-topnav.js emits the event; what each action MEANS
     is the app's business, which is why the component does not hardcode any of it. */
  document.addEventListener('gx-topnav:action', function (e) {
    var a = e.detail && e.detail.action;
    if (a === 'logout') {
      setSession('', '');
      state.rows = []; state.review = null; state.view = 'roster';
      var slot = document.getElementById('userSlot'); if (slot) slot.innerHTML = '';
      var tabs = document.getElementById('navTabs');  if (tabs) tabs.innerHTML = '';
      renderLogin();
    } else if (a === 'version') {
      renderStatus('GX Crew ' + APP_VERSION);
    }
  });

  function renderRoster() {
    if (!state.rows.length && state.view === 'roster' && state.review) { boot(true); return; }
    clear();
    navBar();                 // paints the shared header's tab row
    renderUserChip();
    var nodes = [];

    var bar = el('div', 'crew-bar');
    bar.innerHTML = '<span>Signed in as <b>' + esc(state.user) + '</b> · ' + esc(state.role) +
      (state.canEdit ? '' : ' <em>(read-only)</em>') + '</span>';
    var right = el('span', 'crew-bar-right');
    /* The HR spreadsheet link is gone deliberately: Crew is the system of record now, and a
       one-click path back to the superseded source is an invitation to edit the wrong thing. */
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

      var tdName = el('td', 'crew-namecell');
      tdName.appendChild(avatarPuck(row));
      tdName.appendChild(el('span', null, nameHtml(row) +
        (row.retired ? ' <span class="crew-tag">retired</span>' : '')));
      tr.appendChild(tdName);
      tr.appendChild(el('td', flagCls(row,'store','gx-muted'), esc(row.store ? storeName(row.store) : '—')));
      /* NO ACCOUNT rides on the Role cell because the role is WHY it is expected — a budtender
         without a login is normal, the same gap on a manager is a defect. Spelled out as a tag
         rather than left as red text: red says "something here is wrong", and the person fixing
         it needs to know it is not the role title itself. */
      tr.appendChild(el('td', flagCls(row,'role','gx-muted'), esc(row.role) +
        (row.role_is_default ? '<span title="No role on file — defaulted"> *</span>' : '') +
        (has(row,'no_account')
          ? '<span class="crew-tag crew-tag-warn" title="Managers are expected to have a GX account. ' +
            'This one has no linked login, so Send-to-Managers and every notification skip them ' +
            'silently — nothing errors. Fix with Create accounts.">no account</span>'
          : '')));
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

        /* Celebrations opt-out. A toggle here rather than a table column, because it applies to
           the handful of people who are on the roster for ACCESS rather than for work — the
           kiosk should not announce the owner's work anniversary to the whole company. It is
           deliberately not inferred from role or store: `corporate` and `Admin` both belong to
           real staff who should be celebrated. */
        var cel = el('button', 'crew-link crew-celebrate',
          row.celebrations_opt_out ? 'Celebrations: off' : 'Celebrations: on');
        cel.title = row.celebrations_opt_out
          ? 'Hidden from the kiosk birthday / anniversary feed. Click to include them again.'
          : 'Shown on the kiosk birthday / anniversary feed. Click to hide them.';
        cel.addEventListener('click', async function () {
          var turningOff = !row.celebrations_opt_out;
          cel.disabled = true; status.textContent = '…'; status.className = 'crew-save-status';
          try {
            var r = await Engine.jsonp('roster_save', { token: token(), employee_id: row.employee_id,
              /* 'no', not '' — an empty param can be dropped on the way out, and a dropped field
                 means "leave alone" to the engine, so turning celebrations back ON would look
                 like it saved and change nothing. */
              celebrations_opt_out: turningOff ? 'yes' : 'no' },
              { timeoutMs: 45000, retries: 2 });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
            row.celebrations_opt_out = turningOff;
            cel.textContent = turningOff ? 'Celebrations: off' : 'Celebrations: on';
            status.textContent = 'Saved'; status.className = 'crew-save-status ok';
          } catch (e) {
            status.textContent = (e && e.message) || 'Failed';
            status.className = 'crew-save-status err';
          } finally { cel.disabled = false; }
        });
        tdS.appendChild(cel);

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

          /*
           * Role is a closed set of four, so it is picked and never typed. A free-text box is how
           * "Assistant Store Manager" and "Assistant Manager" both ended up in a registry that
           * Leaderboard groups by, and neither one is a typo anybody would notice.
           *
           * The one subtlety: a row may already HOLD a title outside the four, put there by an
           * older import. Dropping it from the list would mean opening the panel to fix a
           * birthday and silently re-filing that person as somebody else on save. So an
           * off-list value is carried as its own option, selected, and labelled — visible, kept,
           * and one click from being corrected.
           */
          var held = row.role_is_default ? '' : String(row.role || '').trim();
          var offList = held && state.roleTitles.indexOf(held) < 0;
          var roleOpts = ['<option value="">— none — (shows as Budtender)</option>']
            .concat(state.roleTitles.map(function (t) {
              return '<option value="' + esc(t) + '"' + (held === t ? ' selected' : '') + '>' +
                     esc(t) + '</option>'; }))
            .concat(offList ? ['<option value="' + esc(held) + '" selected>' + esc(held) +
                               ' — not a standard role</option>'] : []).join('');
          form.innerHTML =
            '<label>Full name<input name="full_name" value="' + esc(row.name) + '"></label>' +
            '<label>Nickname<input name="preferred_name" value="' + esc(row.preferred_name || '') +
              '" placeholder="shown on the board"></label>' +
            '<label>Store<select name="home_store">' + storeOpts + '</select></label>' +
            '<label>Role<select name="role_title">' + roleOpts + '</select></label>' +
            '<label>Hire date<input name="hire_date" type="date" value="' + esc(row.hire_date || '') + '"></label>' +
            /* Shown, never editable. The number is issued by the system and never reused —
               typing one risks handing a new person a retired employee's history. */
            '<label>Employee #<input value="' + esc(row.employee_number || 'auto') +
              '" size="4" disabled title="Assigned automatically — never reused"></label>';

          /* Avatar picker. Lives beside the nickname because they are the same decision —
             how this person is presented on the kiosk — and Crew is now the only place
             either is set. */
          var pickWrap = el('div', 'crew-avapick');
          var working = parseCfg(row) || null;
          var preview = el('div', 'crew-avapreview');
          var seedNote = el('p', 'crew-editnote');
          function paintPreview() {
            preview.innerHTML = '';
            var shown = { name: row.name, avatar_config: working ? JSON.stringify(working) : '',
                          avatar_seed: row.avatar_seed, employee_id: row.employee_id };
            preview.appendChild(avatarPuck(shown, 'lg'));
            seedNote.innerHTML = working
              ? 'Seed pinned to employee&nbsp;#<b>' + esc(row.avatar_seed || '—') +
                '</b> — renaming will not change this face.'
              : 'No avatar set — the kiosk shows initials.';
          }
          function paintControls() {
            controls.innerHTML = '';
            if (!working) return;
            OPTION_ORDER.forEach(function (key) {
              // Only offer a colour when the feature it colours is actually switched on.
              if (key === 'hatColor' && !HAT_TOPS[working.top]) return;
              if (key === 'hairColor' && (working.top === '_none' || HAT_TOPS[working.top])) return;
              if (key === 'facialHairColor' && working.facialHair === '_none') return;
              if (key === 'accessoriesColor' && working.accessories === '_none') return;
              /* A config may not carry every key — Sky's had no hatColor at all, so choosing a
                 hat rendered a control showing a value the config did not hold, and the avatar
                 came back with DiceBear's default instead. Adopt the displayed value into the
                 config so what you see is always what gets saved. */
              if (working[key] == null) working[key] = AVATAR_OPTIONS[key][0];
              var wrap = el('label', 'crew-avaopt');
              var isColor = !!COLOR_KEYS[key];
              var opts = AVATAR_OPTIONS[key].map(function (v) {
                var lbl = v === '_none' ? 'none' : v === '_gchat' ? 'GC hat' : v;
                return '<option value="' + esc(v) + '"' + (working[key] === v ? ' selected' : '') +
                       '>' + esc(lbl) + '</option>';
              }).join('');
              wrap.innerHTML = '<span>' + esc(OPTION_LABEL[key] || key) + '</span>' +
                '<select>' + opts + '</select>' +
                (isColor ? '<i class="crew-avaswatch" style="background:#' + esc(working[key] || '000') + '"></i>' : '');
              wrap.querySelector('select').addEventListener('change', function () {
                working[key] = this.value;
                // Controls first: choosing a hat introduces hatColor, and paintControls is what
                // adopts that default into `working`. Painting the preview first would render
                // one change behind, silently dropping the new key from the URL.
                paintControls(); paintPreview();
              });
              controls.appendChild(wrap);
            });
          }
          var controls = el('div', 'crew-avacontrols');
          var avaActs = el('div', 'crew-avaacts');
          var bStart = el('button', 'crew-save', working ? 'Reset to default' : 'Give them an avatar');
          bStart.addEventListener('click', function () {
            working = JSON.parse(JSON.stringify(DEFAULT_AVATAR));
            bClear.style.display = '';
            paintControls(); paintPreview();
          });
          var bClear = el('button', 'crew-save', 'Remove avatar');
          bClear.style.display = working ? '' : 'none';
          bClear.addEventListener('click', function () {
            working = null; bClear.style.display = 'none';
            paintControls(); paintPreview();
          });
          avaActs.appendChild(bStart); avaActs.appendChild(bClear);
          pickWrap.appendChild(preview);
          var pickCol = el('div', 'crew-avacol');
          pickCol.appendChild(controls); pickCol.appendChild(avaActs); pickCol.appendChild(seedNote);
          pickWrap.appendChild(pickCol);
          paintControls(); paintPreview();
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
              q.avatar_config = working ? JSON.stringify(working) : '';
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
          cell.appendChild(form); cell.appendChild(pickWrap); cell.appendChild(note); cell.appendChild(acts);
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
      'This roster is the system of record — the HR spreadsheet it was built from is now history. ' +
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
      // The role vocabulary is the engine's, not the UI's — so the dropdown can never offer a
      // title the engine would refuse, and adding a fifth role is a one-line server change.
      state.roleTitles = r.role_titles || [];
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
