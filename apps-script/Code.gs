/**
 * ============================================================================
 *  GX Crew — HR / People backend  (Apps Script)
 *  App key: crew.  doGet/doPost router in the GX Core spoke style.
 *  Binds GXCore (the shared brain) for identity, sales metrics, SPIFF payouts.
 *  See ../CLAUDE.md for the architecture + build order.
 *
 *  BOUNDARY (do not blur this):
 *    • GX Core owns canonical employee IDENTITY — employee_id, full_name, home_store,
 *      role_title, status, hire_date. One writer, many readers. We READ it, never fork it.
 *    • GX Crew owns the RICH ATTRIBUTES — shirt size, birthday, work anniversary (and later
 *      OLCC/METRC permits, badges, SwipeClock). Those live in OUR sheet, keyed to Core's
 *      employee_id. This file is the system of record for them.
 *
 *  PII POSTURE (birthdays are PII — read before changing):
 *    • We store birthday as MM-DD ONLY. No birth year, ever. A year would give us age, which
 *      we have no business need for and no right to hold; MM-DD supports every celebration
 *      feature we actually want. `normBirthday_` strips a year if one is submitted.
 *    • Roster read/write require a GX Core session with a `crew` grant (GXCore.requireAuth).
 *      The web app itself is ANYONE_ANONYMOUS (Apps Script needs that for JSONP), so the
 *      auth gate in code is the ONLY thing standing between the open internet and staff PII.
 *      Every handler that touches attributes must go through requireCrew_().
 *    • `celebrations` is the ONE endpoint Leaderboard consumes and it is deliberately
 *      PII-free: derived flags (today/upcoming, days away, years of service) and never a
 *      raw date. That asymmetry is the whole point of the split — see CLAUDE.md.
 * ============================================================================
 */
var GXCORE_URL = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
var STORE_TZ   = 'America/Los_Angeles';

/** Crew's own spreadsheet (created on first use; id cached in ScriptProperties). */
var CREW_SHEET_ID_PROP = 'CREW_SHEET_ID';
var ATTR_TAB           = 'crew_attributes';
var ATTR_HEADERS       = ['employee_id', 'name_key', 'full_name', 'shirt_size',
                          'birthday', 'work_anniversary', 'updated_at', 'updated_by'];

/** Allowed shirt sizes. Kept server-side so the UI can't write junk into payroll-adjacent data. */
var SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

/** How far ahead `celebrations` looks. Kiosk wants "today + coming up this week or so". */
var CELEBRATION_HORIZON_DAYS = 14;

function doGet(e)  { return route_(e); }
function doPost(e) { return route_(e); }

function route_(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'health';
  try {
    switch (action) {
      case 'health':
        return json_({ ok: true, app: 'crew', ts: new Date().toISOString() }, p.callback);

      // ── Roster (auth-gated — holds PII) ─────────────────────────────────────
      case 'roster':       return json_(getRoster_(p), p.callback);
      case 'roster_save':  return json_(saveRosterAttrs_(p), p.callback);

      // ── Derived, PII-free feed for Leaderboard (deploy-secret gated) ────────
      case 'celebrations': return json_(getCelebrations_(p), p.callback);

      // Read-only seed dry-run, so the Dutchie field mapping can be checked before committing.
      case 'seed_preview':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(seedIdentityPreview(), p.callback);

      // Commit the seed. Writes the canonical identity registry every other app reads, so it
      // takes the deploy secret AND an explicit confirm=yes — the secret alone is carried by
      // routine tooling, and this is not something that should ever fire as a side effect.
      // seedIdentityCommit() is also runnable straight from the editor.
      case 'seed_commit':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        if (String(p.confirm || '') !== 'yes') {
          return json_({ ok: false, error: 'refusing to write identity without confirm=yes — run action=seed_preview first' }, p.callback);
        }
        return json_(seedIdentityCommit(), p.callback);

      // Reads BACK from GX Core so a seed can be confirmed independently of the writer's own
      // return value. Counts and store distribution only — no names, so it stays safe to call.
      case 'identity_health':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(identityHealth_(), p.callback);

      // ── To build (see /gxwhatsnext) ─────────────────────────────────────────
      // case 'incentive':    return json_(getIncentiveData_(p), p.callback);   // bonus calc (ported from Leaderboard)
      // case 'thresholds':   return json_(getThresholds_(p), p.callback);      // editable comp thresholds
      // case 'export':       return json_(buildCapstoneExport_(p), p.callback);// payroll export (CSV/PDF)
      // case 'snapshot':     return json_(monthlySnapshot_(p), p.callback);    // monthly review snapshot

      default:
        return json_({ ok: false, error: 'unknown action: ' + action }, p.callback);
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) }, p.callback);
  }
}

/** JSON response, or JSONP when a ?callback= is supplied (gx-client uses JSONP for cross-origin GETs). */
function json_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

/**
 * Gate for anything touching staff PII. Delegates to GX Core so there is exactly one
 * password/session/grant system across the suite — Crew never mints or checks credentials itself.
 * Returns { ok, user, role } or { ok:false, error }.
 */
function requireCrew_(p) {
  return GXCore.requireAuth(p, 'crew');
}

/**
 * Writes need an edit-grade grant; `viewer` can read the roster but not change it.
 *
 * GX Core's actual role vocabulary is viewer / editor / admin / director — `editor` is the
 * plain "can edit this app" grant and MUST be here, or granting someone crew/editor would hand
 * them a read-only roster while the role name says otherwise. `manager` is not in Core's
 * vocabulary today; it is allowed for the HR-manager grants CLAUDE.md anticipates.
 *
 * Deliberately an allowlist, not `role !== 'viewer'` — an unrecognised or empty role should fall
 * through to read-only rather than silently earning write access to staff PII.
 */
var EDIT_ROLES = ['admin', 'editor', 'director', 'manager'];
function canEdit_(auth) {
  var role = String((auth && auth.role) || '').toLowerCase();
  return EDIT_ROLES.indexOf(role) >= 0;
}

/**
 * The deploy secret gates machine-to-machine calls (celebrations feed, seed preview) where there
 * is no user session.
 *
 * The suite's deploy secret lives in GX Core as the `GC_DEPLOY_SECRET` script property, and Core
 * only exposes it through a private validator, so a spoke cannot read it via the library. Rather
 * than copy the secret into every spoke (one more place to leak it, one more place to rotate), we
 * ASK Core whether a given secret is good, using a cheap already-secret-gated route.
 *
 * A local GX_DEPLOY_SECRET script property short-circuits this if anyone sets one later.
 * Positive results are cached briefly, keyed by digest — never by the secret itself.
 */
function deploySecretOk_(p) {
  var given = String((p && p.secret) || '');
  if (!given) return false;

  var local = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (local) return given === local;

  var digest = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, given)).slice(0, 24);
  var cache = CacheService.getScriptCache();
  var ckey  = 'gxsecret:' + digest;
  var hit   = cache.get(ckey);
  if (hit) return hit === '1';

  var ok = false;
  try {
    var url = GXCORE_URL + '?action=notes&app=crew&status=resolved&secret=' + encodeURIComponent(given);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var body = res.getContentText();
    // Core replies { ok:false, error:'bad deploy secret' } for a wrong one. Anything that isn't
    // clean JSON (Drive's intermittent HTML page) must NOT be read as a pass.
    if (body && body.charAt(0) === '{') ok = !!(JSON.parse(body) || {}).ok;
  } catch (e) {
    ok = false;
  }
  // Only cache a definite yes. Caching a no would make a transient Drive HTML blip lock a valid
  // caller out for the whole TTL.
  if (ok) cache.put(ckey, '1', 300);
  return ok;
}

// ─── Crew's attribute store ─────────────────────────────────────────────────────

/**
 * Crew's own spreadsheet. Created on first call and remembered in ScriptProperties, so the
 * script stays standalone (no container binding to lose) and nobody has to hand-wire an ID.
 */
function crewSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CREW_SHEET_ID_PROP);
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('GX Crew — HR data (PII: do not share)');
    props.setProperty(CREW_SHEET_ID_PROP, ss.getId());
  }
  var sh = ss.getSheetByName(ATTR_TAB);
  if (!sh) {
    sh = ss.insertSheet(ATTR_TAB);
    sh.getRange(1, 1, 1, ATTR_HEADERS.length).setValues([ATTR_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** All stored attributes, as { employee_id → row object }. */
function readAttrs_() {
  var sh = crewSheet_();
  var last = sh.getLastRow();
  if (last < 2) return {};
  var values = sh.getRange(2, 1, last - 1, ATTR_HEADERS.length).getValues();
  var out = {};
  for (var i = 0; i < values.length; i++) {
    var row = {};
    for (var c = 0; c < ATTR_HEADERS.length; c++) row[ATTR_HEADERS[c]] = String(values[i][c] == null ? '' : values[i][c]).trim();
    if (row.employee_id) out[row.employee_id] = row;
  }
  return out;
}

/**
 * Upsert one employee's attributes. Locked, because two managers editing the roster at once
 * would otherwise race on the same row and one edit would silently vanish.
 */
function writeAttrs_(rec) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = crewSheet_();
    var last = sh.getLastRow();
    var targetRow = 0;
    if (last >= 2) {
      var ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]).trim() === rec.employee_id) { targetRow = i + 2; break; }
      }
    }
    var row = ATTR_HEADERS.map(function (h) { return rec[h] == null ? '' : rec[h]; });
    if (targetRow) sh.getRange(targetRow, 1, 1, ATTR_HEADERS.length).setValues([row]);
    else           sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

// ─── Normalisation ──────────────────────────────────────────────────────────────

/**
 * Leaderboard's join key. MUST stay byte-identical to `nameToKey_` in the Leaderboard repo
 * (endpoints.gs) — it is how the celebrations feed lines up with the kiosk's roster, and a
 * drift here shows up as staff silently missing from the board rather than as an error.
 */
function nameToKey_(name) {
  return String(name || '').toLowerCase().replace(/["'`]/g, '').replace(/\./g, '').replace(/\s+/g, '_').trim();
}

/**
 * Birthday → 'MM-DD'. Accepts 'MM-DD', 'YYYY-MM-DD', or 'M/D' and DELIBERATELY discards any
 * year: see the PII note at the top. Returns '' for anything unparseable rather than guessing.
 */
function normBirthday_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)      // YYYY-MM-DD → drop the year
       || s.match(/^()(\d{1,2})-(\d{1,2})$/)            // MM-DD
       || s.match(/^()(\d{1,2})\/(\d{1,2})$/);          // M/D
  if (!m) return '';
  var mo = Number(m[2]), da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  return pad2_(mo) + '-' + pad2_(da);
}

/** Work anniversary → 'YYYY-MM-DD'. Here the year IS the point (years of service). */
function normDate_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    var mo = Number(m[2]), da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
    return m[1] + '-' + pad2_(mo) + '-' + pad2_(da);
  }
  // Tolerate a real Date (Sheets hands these back when a cell was formatted as a date).
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, STORE_TZ, 'yyyy-MM-dd');
  return '';
}

function normShirt_(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return SHIRT_SIZES.indexOf(s) >= 0 ? s : '';
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// ─── Roster ─────────────────────────────────────────────────────────────────────

/**
 * The joined roster: GX Core identity (canonical) LEFT JOIN Crew attributes (ours).
 *
 * Note on the empty state: GX Core's `employees` tab currently has no writer anywhere in the
 * suite, so it is expected to come back empty until core-admin ships `gxUpsertEmployee` and a
 * seed. We surface that as an explicit `identity_source` diagnostic instead of rendering a
 * blank table, because "no employees" and "identity not seeded yet" are very different bugs.
 */
function getRoster_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var identity = [];
  var identityError = '';
  try {
    identity = GXCore.getEmployees() || [];
  } catch (e) {
    identityError = String((e && e.message) || e);
  }

  var active = identity.filter(function (r) {
    var st = String(r.status || 'active').toLowerCase();
    return st !== 'inactive' && st !== 'terminated' && st !== 'false';
  });

  var attrs = readAttrs_();
  var rows = active.map(function (r) {
    var id = String(r.employee_id || '').trim();
    var a  = attrs[id] || {};
    // Work anniversary falls back to Core's hire_date — that IS the anniversary unless HR
    // has recorded an override (rehire, corrected start date).
    var anniv = normDate_(a.work_anniversary) || normDate_(r.hire_date);
    return {
      employee_id:      id,
      name_key:         nameToKey_(r.full_name),
      name:             String(r.full_name || ''),
      store:            String(r.home_store || ''),
      role:             String(r.role_title || ''),
      shirt_size:       normShirt_(a.shirt_size),
      birthday:         normBirthday_(a.birthday),
      work_anniversary: anniv,
      anniversary_is_override: !!normDate_(a.work_anniversary),
      updated_at:       a.updated_at || '',
      updated_by:       a.updated_by || ''
    };
  }).sort(function (x, y) { return x.name.localeCompare(y.name); });

  return {
    ok: true,
    user: auth.user,
    role: auth.role,
    can_edit: canEdit_(auth),
    shirt_sizes: SHIRT_SIZES,
    rows: rows,
    identity_source: {
      count: identity.length,
      active: active.length,
      error: identityError,
      note: identity.length ? '' :
        'GX Core `employees` is empty — identity has no writer yet (needs core-admin: gxUpsertEmployee + seed). ' +
        'Crew attributes are stored and will join automatically once identity lands.'
    }
  };
}

/**
 * Save one employee's Crew-owned attributes. Identity fields are NOT writable here by design —
 * name/store/role belong to GX Core, and letting Crew edit them would fork the registry.
 */
function saveRosterAttrs_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.employee_id || '').trim();
  if (!id) return { ok: false, error: 'employee_id required' };

  // Only accept an employee_id GX Core actually knows — otherwise a typo silently creates an
  // orphan attribute row that never joins to anyone and never shows up again.
  var identity = GXCore.getEmployees() || [];
  var match = null;
  for (var i = 0; i < identity.length; i++) {
    if (String(identity[i].employee_id || '').trim() === id) { match = identity[i]; break; }
  }
  if (!match) return { ok: false, error: 'unknown employee_id: ' + id };

  // Reject bad input loudly rather than storing '' — a silently-dropped birthday looks like a
  // save that worked, and nobody notices until the celebration never fires.
  var shirt = String(p.shirt_size == null ? '' : p.shirt_size).trim();
  if (shirt && !normShirt_(shirt)) return { ok: false, error: 'invalid shirt_size: ' + shirt + ' (expected one of ' + SHIRT_SIZES.join(', ') + ')' };
  var bday = String(p.birthday == null ? '' : p.birthday).trim();
  if (bday && !normBirthday_(bday)) return { ok: false, error: 'invalid birthday: ' + bday + ' (expected MM-DD)' };
  var anniv = String(p.work_anniversary == null ? '' : p.work_anniversary).trim();
  if (anniv && !normDate_(anniv)) return { ok: false, error: 'invalid work_anniversary: ' + anniv + ' (expected YYYY-MM-DD)' };

  var existing = readAttrs_()[id] || {};
  var rec = {
    employee_id:      id,
    name_key:         nameToKey_(match.full_name),
    full_name:        String(match.full_name || ''),
    // Absent field = leave alone; empty string = explicit clear. Lets the UI PATCH one cell.
    shirt_size:       p.shirt_size       == null ? (existing.shirt_size       || '') : normShirt_(shirt),
    birthday:         p.birthday         == null ? (existing.birthday         || '') : normBirthday_(bday),
    work_anniversary: p.work_anniversary == null ? (existing.work_anniversary || '') : normDate_(anniv),
    updated_at:       new Date().toISOString(),
    updated_by:       String(auth.user || '')
  };
  writeAttrs_(rec);
  return { ok: true, employee_id: id, saved: rec };
}

// ─── Identity seeding (Crew → GX Core) ──────────────────────────────────────────
/*
 * Per CLAUDE.md, Crew writes the shared identity slice UP to GX Core. Dutchie is the real
 * source of truth for who works here, so we seed from it: getStores() → dutchieEmployees(store)
 * → gxUpsertEmployees(rows).
 *
 * These are EDITOR-RUN, deliberately not routed through doGet. Seeding writes to the canonical
 * registry every other app reads; that is not something the open internet should be able to poke,
 * even behind a secret.
 *
 *   Run `seedIdentityPreview()` first  — reads Dutchie, writes NOTHING, returns what it would do
 *                                        plus a raw sample record so the field mapping can be checked.
 *   Then `seedIdentityCommit()`        — same thing, but actually upserts.
 *
 * KEY CHOICE — employee_id is the nameKey (`ana_reyes`), not Dutchie's numeric id.
 * Everything in the suite joins on nameKey today (Leaderboard's roster, incentive inputs, SPIFF
 * attribution; GX Core's own comment at gx_dutchie.gs notes name is the only reliable join until
 * this registry exists). Seeding with nameKey makes the registry immediately joinable with all of
 * it. dutchie_employee_id rides along so we can migrate to a numeric join later without a rename.
 * The tradeoff is real: nameKey breaks on a legal-name change, which then needs a manual merge.
 */

/** Pull one field out of a Dutchie record, tolerating the several names it ships under. */
function pick_(obj, names) {
  for (var i = 0; i < names.length; i++) {
    var v = obj[names[i]];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Non-PII fields whose distinct values we surface to drive the mapping. Allowlist, not a filter. */
var FACET_FIELDS = ['status', 'groups', 'defaultLocation', 'permissionsLocation'];

/**
 * Dutchie permission groups → a job title, most senior first. An employee carries several
 * ("Assistant Store Managers, Bud Tenders"), and the senior one is the real title.
 * "[Individual Permissions]" is a permissions bucket, not a job — it is ignored.
 */
var GROUP_RANK = [
  ['Admin',                    'Admin'],
  ['Store Managers',           'Store Manager'],
  ['Assistant Store Managers', 'Assistant Store Manager'],
  ['Inventory Coordinators',   'Inventory Coordinator'],
  ['Accounting',               'Accounting'],
  ['Inventory',                'Inventory'],
  ['Bud Tenders',              'Budtender']
];

/**
 * Dutchie logins that are not people. These ring transactions and hold permissions like staff,
 * so nothing in the payload distinguishes them — an explicit, reviewable list is honest, and
 * anything new shows up in the preview's roster for a human to catch.
 */
var NON_PERSON_LOGINS = ['authorize override pin', 'test user', 'training', 'admin'];

/** Normalise a location label for matching. Handles Rd/Road and St/Street drift. */
function storeToken_(s) {
  return String(s || '').toLowerCase()
    .replace(/\broad\b/g, 'rd').replace(/\bstreet\b/g, 'st')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\s+(rd|st)$/, '');
}

/** "TLC Cannabis Emporium - River Rd - Green Cross…" → the GX store_id, or '' if unmatched. */
function mapPermissionLocation_(label, stores) {
  var parts = String(label || '').split(' - ');
  var mid = parts.length >= 2 ? parts[1] : label;
  var tok = storeToken_(mid);
  if (!tok) return '';
  for (var i = 0; i < stores.length; i++) {
    var s = stores[i];
    if (storeToken_(s.dutchie_name) === tok || storeToken_(s.store_id) === tok
        || storeToken_(s.display_name) === tok) {
      return String(s.store_id || '').trim();
    }
  }
  return '';
}

/**
 * Read Dutchie and map to GX Core's employees schema. No writes.
 *
 * Dutchie's /employees returns the SAME company-wide list from every store, with one row per
 * (employee × permission location) — so a naive per-store loop reads the roster 6× over and sees
 * every person up to 6 times. We fetch once and dedupe on userId (stable), rather than per store
 * and dedupe on name (which would also merge two real people who share a name).
 */
function buildIdentityRows_() {
  var stores = GXCore.getStores() || [];
  var errors = [], sample = null, facets = {};
  FACET_FIELDS.forEach(function (f) { facets[f] = {}; });

  function noteFacet_(r) {
    FACET_FIELDS.forEach(function (f) {
      var v = r[f];
      if (v == null) return;
      var vals = Object.prototype.toString.call(v) === '[object Array]'
        ? v.map(function (x) { return typeof x === 'object' && x ? (x.name || x.groupName || JSON.stringify(x)) : String(x); })
        : [String(v)];
      vals.forEach(function (s) {
        s = s.trim(); if (!s) return;
        facets[f][s] = (facets[f][s] || 0) + 1;
      });
    });
  }

  // One fetch. Try each store only until one answers — they all return the same list, so a
  // second success would just be the same rows again.
  var list = null;
  for (var i = 0; i < stores.length && !list; i++) {
    var dn = String(stores[i].dutchie_name || '').trim();
    if (!dn) continue;
    try { list = GXCore.dutchieEmployees(dn) || []; }
    catch (e) { errors.push(String(stores[i].store_id) + ': ' + String((e && e.message) || e)); }
  }
  if (!list) return { rows: [], errors: errors, sample: null, seen: 0, skipped_inactive: 0,
                      skipped_non_person: 0, excluded: [], multi_store: [], facets: {} };

  var byUser = {}, seen = 0, skippedNonPerson = 0, excluded = [];

  list.forEach(function (r) {
    seen++;
    if (!sample) sample = r;
    noteFacet_(r);

    var full = pick_(r, ['fullName', 'full_name', 'name', 'displayName']);
    if (!full) return;
    full = full.replace(/\s+/g, ' ').trim();   // Dutchie ships some double-spaced names

    if (NON_PERSON_LOGINS.indexOf(full.toLowerCase()) >= 0) {
      skippedNonPerson++;
      if (excluded.indexOf(full) < 0) excluded.push(full);
      return;
    }

    // userId is Dutchie's stable person id; fall back to the name key only if it is missing.
    var uid = pick_(r, ['userId', 'globalUserId']) || ('name:' + nameToKey_(full));
    var rec = byUser[uid];
    if (!rec) {
      rec = byUser[uid] = { full_name: full, uid: uid, active: false, groups: {}, locations: {} };
    }

    // Active at ANY location counts as active — a transfer leaves an In-Active row behind at
    // the old store, and dropping the person on that basis would delete a current employee.
    if (storeToken_(pick_(r, ['status'])) === 'active') rec.active = true;

    String(pick_(r, ['groups']) || '').split(',').forEach(function (g) {
      g = g.trim(); if (g && g !== '[Individual Permissions]') rec.groups[g] = 1;
    });

    var loc = mapPermissionLocation_(pick_(r, ['permissionsLocation']), stores);
    if (loc) rec.locations[loc] = 1;
  });

  var skippedInactive = 0, multiStore = [], rows = [];
  Object.keys(byUser).forEach(function (uid) {
    var rec = byUser[uid];
    if (!rec.active) { skippedInactive++; return; }

    var title = '';
    for (var i = 0; i < GROUP_RANK.length && !title; i++) {
      if (rec.groups[GROUP_RANK[i][0]]) title = GROUP_RANK[i][1];
    }

    // One permission location = that's their store. Several (managers, admins) is genuinely
    // ambiguous, so leave home_store blank for HR rather than guessing them onto a wrong store.
    var locs = Object.keys(rec.locations);
    var home = locs.length === 1 ? locs[0] : '';
    if (locs.length > 1) multiStore.push(rec.full_name + ' (' + locs.sort().join(', ') + ')');

    rows.push({
      employee_id:         nameToKey_(rec.full_name),
      full_name:           rec.full_name,
      home_store:          home,
      dutchie_employee_id: rec.uid.indexOf('name:') === 0 ? '' : rec.uid,
      role_title:          title,
      status:              'active'
      // hire_date is deliberately absent: Dutchie's /employees carries no hire or start date, and
      // writing '' would blank a good value on re-seed. Work anniversaries need another source.
    });
  });

  rows.sort(function (a, b) { return a.full_name.localeCompare(b.full_name); });

  var facetOut = {};
  FACET_FIELDS.forEach(function (f) {
    facetOut[f] = Object.keys(facets[f])
      .map(function (k) { return { value: k, n: facets[f][k] }; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, 40);
  });

  return { rows: rows, errors: errors, sample: sample, seen: seen,
           skipped_inactive: skippedInactive, skipped_non_person: skippedNonPerson,
           excluded: excluded, multi_store: multiStore.sort(), facets: facetOut };
}

/** DRY RUN. Reads Dutchie, writes nothing. Check `sample` against `rows[0]` before committing. */
function seedIdentityPreview() {
  var b = buildIdentityRows_();
  var noStore = b.rows.filter(function (r) { return !r.home_store; }).length;
  var noTitle = b.rows.filter(function (r) { return !r.role_title; }).length;
  var out = {
    ok: true, mode: 'preview', would_upsert: b.rows.length,
    dutchie_rows_seen: b.seen,
    skipped_inactive: b.skipped_inactive, skipped_non_person: b.skipped_non_person,
    excluded_logins: b.excluded,
    without_home_store: noStore, without_role_title: noTitle,
    multi_store_people: b.multi_store, store_errors: b.errors,
    first_5: b.rows.slice(0, 5),
    // FIELD NAMES ONLY. Dutchie's /employees payload carries loginId, stateId (OLCC permit) and
    // mmjExpiration; the mapped `first_5` above already proves whether the mapping worked, so
    // there is no reason to ship identifying detail over the wire just to inspect a schema.
    raw_dutchie_fields: b.sample ? Object.keys(b.sample).sort() : [],
    // Distinct values for the low-cardinality CLASSIFICATION fields only — these drive the
    // mapping (which status counts as active, what `groups` looks like, how defaultLocation
    // spells a store) and none of them identify a person. Explicit allowlist, never a loop
    // over every key, so a new PII field in Dutchie's payload can't leak in by default.
    raw_dutchie_facets: b.facets,
    hire_date_note: 'Dutchie /employees carries no hire date — work anniversaries need another source.'
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** COMMITS to GX Core's employees registry. Run seedIdentityPreview() first. */
function seedIdentityCommit() {
  var b = buildIdentityRows_();
  if (!b.rows.length) {
    var empty = { ok: false, error: 'nothing to seed', store_errors: b.errors, dutchie_rows_seen: b.seen };
    Logger.log(JSON.stringify(empty, null, 2));
    return empty;
  }
  var res = GXCore.gxUpsertEmployees(b.rows);
  var out = {
    ok: true, mode: 'commit', upserted: (res && res.upserted) || 0,
    skipped_inactive: b.skipped_inactive, skipped_non_person: b.skipped_non_person,
    multi_store_people: b.multi_store, store_errors: b.errors
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** What GX Core actually holds now — aggregate only, so this never leaks a roster. */
function identityHealth_() {
  var rows = [];
  try { rows = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  var byStore = {}, byRole = {}, missingStore = 0, missingDutchieId = 0;
  rows.forEach(function (r) {
    var st = String(r.home_store || '').trim() || '(none)';
    if (st === '(none)') missingStore++;
    byStore[st] = (byStore[st] || 0) + 1;
    var ro = String(r.role_title || '').trim() || '(none)';
    byRole[ro] = (byRole[ro] || 0) + 1;
    if (!String(r.dutchie_employee_id || '').trim()) missingDutchieId++;
  });

  return {
    ok: true, total: rows.length,
    by_store: byStore, by_role: byRole,
    missing_home_store: missingStore, missing_dutchie_id: missingDutchieId,
    with_hire_date: rows.filter(function (r) { return String(r.hire_date || '').trim(); }).length
  };
}

// ─── Celebrations (the PII-free feed Leaderboard consumes) ──────────────────────

/** Days from today (store TZ) until the next occurrence of MM-DD. Today = 0. */
function daysUntilMonthDay_(mmdd, today) {
  var m = String(mmdd || '').match(/^(\d{2})-(\d{2})$/);
  if (!m) return -1;
  var mo = Number(m[1]), da = Number(m[2]);
  var y = today.getFullYear();
  var next = new Date(y, mo - 1, da);
  // Feb 29 in a common year: celebrate Mar 1 so the person isn't skipped three years in four.
  if (next.getMonth() !== mo - 1) next = new Date(y, mo, 1);
  if (daysBetween_(today, next) < 0) {
    next = new Date(y + 1, mo - 1, da);
    if (next.getMonth() !== mo - 1) next = new Date(y + 1, mo, 1);
  }
  return daysBetween_(today, next);
}

function daysBetween_(a, b) {
  var MS = 86400000;
  var da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  var db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / MS);
}

/** "Today" in store time, as a plain local Date — avoids UTC rolling the date over at 5pm PT. */
function todayInStoreTz_() {
  var s = Utilities.formatDate(new Date(), STORE_TZ, 'yyyy-MM-dd').split('-');
  return new Date(Number(s[0]), Number(s[1]) - 1, Number(s[2]));
}

/**
 * Today's + upcoming birthdays and work anniversaries, as DERIVED FLAGS ONLY.
 *
 * This is the payload that leaves Crew for the all-staff kiosk, so it carries no raw dates:
 * name, store, type, days_away, and years-of-service for anniversaries. Someone reading the
 * Leaderboard response can tell that Ana has a birthday Thursday; they cannot tell her DOB,
 * and they cannot reconstruct it by watching the feed. Keep it that way.
 */
function getCelebrations_(p) {
  // Machine-to-machine (Leaderboard/GX Core), so: deploy secret OR a signed-in crew user.
  if (!deploySecretOk_(p)) {
    var auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  }

  var horizon = Math.max(0, Math.min(60, Number(p.days || CELEBRATION_HORIZON_DAYS) || CELEBRATION_HORIZON_DAYS));
  var today = todayInStoreTz_();

  var identity = [];
  try { identity = GXCore.getEmployees() || []; } catch (e) { identity = []; }
  var byId = {};
  identity.forEach(function (r) {
    var st = String(r.status || 'active').toLowerCase();
    if (st === 'inactive' || st === 'terminated' || st === 'false') return;
    byId[String(r.employee_id || '').trim()] = r;
  });

  var attrs = readAttrs_();
  var out = [];

  Object.keys(attrs).forEach(function (id) {
    var a = attrs[id];
    var person = byId[id];
    if (!person) return;   // inactive or unknown — don't celebrate someone who left
    var base = {
      name_key: nameToKey_(person.full_name),
      name:     String(person.full_name || ''),
      store:    String(person.home_store || '')
    };

    var bday = normBirthday_(a.birthday);
    if (bday) {
      var bd = daysUntilMonthDay_(bday, today);
      if (bd >= 0 && bd <= horizon) {
        out.push({ name_key: base.name_key, name: base.name, store: base.store,
                   type: 'birthday', when: bd === 0 ? 'today' : 'upcoming', days_away: bd });
      }
    }

    var anniv = normDate_(a.work_anniversary) || normDate_(person.hire_date);
    if (anniv) {
      var parts = anniv.split('-');
      var ad = daysUntilMonthDay_(parts[1] + '-' + parts[2], today);
      if (ad >= 0 && ad <= horizon) {
        // Years being completed on that upcoming date, not years completed today.
        var years = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ad).getFullYear() - Number(parts[0]);
        if (years > 0) {
          out.push({ name_key: base.name_key, name: base.name, store: base.store,
                     type: 'anniversary', when: ad === 0 ? 'today' : 'upcoming', days_away: ad, years: years });
        }
      }
    }
  });

  out.sort(function (x, y) { return x.days_away - y.days_away || x.name.localeCompare(y.name); });
  return { ok: true, app: 'crew', horizon_days: horizon, today: Utilities.formatDate(today, STORE_TZ, 'yyyy-MM-dd'), celebrations: out };
}
