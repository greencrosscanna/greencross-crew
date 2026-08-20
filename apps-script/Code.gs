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
                          'birthday', 'work_anniversary', 'employee_number', 'wage',
                          'permit_number', 'permit_granted', 'permit_expires', 'permit_status',
                          'updated_at', 'updated_by'];

/* Review queue. Conflicts are DETECTED live, never stored — the roster is the truth and a
 * stale conflict list would be worse than none. What IS stored is the DECISION, so a resolved
 * item stops resurfacing while a genuinely changed one comes back. */
var REVIEW_TAB      = 'crew_reviews';      // items reported by an import (HR/METRC, not engine-reachable)
var REVIEW_HEADERS  = ['review_id', 'kind', 'employee_id', 'name', 'field',
                       'current_value', 'proposed_value', 'source', 'detail', 'reported_at'];
var DECISION_TAB     = 'crew_decisions';   // what a human already ruled on
var DECISION_HEADERS = ['decision_key', 'kind', 'employee_id', 'field', 'chose',
                        'value', 'decided_by', 'decided_at', 'note'];

/** Alias tab: names that have been merged away, so an import never re-splits a person. */
var ALIAS_TAB     = 'crew_aliases';
var ALIAS_HEADERS = ['alias_key', 'alias_name', 'employee_id', 'merged_at', 'merged_by'];

/* Employee of the Month, one row per reign. APPEND-ONLY: a reign is never edited to record its
 * end, because the end is simply the moment the next row begins. A row with a blank employee_id
 * is the "deliberately nobody" marker — the same distinction cfg.eom draws by holding an empty
 * value rather than being deleted — and it closes the reign before it. */
var EOM_TAB     = 'crew_eom_history';
var EOM_HEADERS = ['employee_id', 'name', 'started_at', 'set_by', 'recorded_at', 'source'];

/** Attributes a manager may edit from the roster UI. Everything else is import-owned. */
var EDITABLE_ATTRS = ['shirt_size', 'birthday', 'work_anniversary', 'employee_number', 'wage'];

/*
 * The HR workbook is NO LONGER THE SOURCE OF TRUTH (Sky, 2026-08-18). GX Crew — backed by the
 * GX Core registry — is. The spreadsheet is kept only as the historical record it came from.
 *
 * This is not just a label change. An import from a superseded source must be structurally
 * incapable of overturning curated data: re-sending the sheet is exactly how four role
 * corrections were silently reverted minutes after being made. hrImport_ therefore defaults to
 * FILL mode — it writes a field only where the current value is EMPTY. Overwriting now takes an
 * explicit mode=overwrite, which nothing routine should ever pass.
 */
var HR_SHEET_URL = '';   // no longer surfaced in the UI; Crew is the record

/** Allowed shirt sizes. Kept server-side so the UI can't write junk into payroll-adjacent data. */
var SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

/*
 * THE ROLE VOCABULARY. Four titles, and role_title is a closed set — the roster offers these
 * as a dropdown and the engine refuses anything else, so a role can never arrive misspelled or
 * in a variant nobody else recognises.
 *
 * It has to be enforced here and not only in the UI. role_title is GX Core identity, read by
 * Leaderboard and SPIFF, and Crew is its only writer — but not through one door: the roster
 * panel, hr_import, the Dutchie seed and the review queue all reach role_title. A dropdown
 * closes exactly one of those.
 *
 * Ranked most senior first; the roster orders the dropdown this way rather than alphabetically.
 */
var ROLE_TITLES = ['Admin', 'Store Manager', 'Assistant Manager', 'Budtender'];

/*
 * Names other systems use for the same four jobs. Dutchie's permission groups and the old HR
 * sheet each spell them their own way, and "Assistant Store Manager" is not a fifth role — it
 * is this one, typed differently. Mapping is how an import stays useful without being allowed
 * to widen the vocabulary. Keys are lower-cased and space-collapsed.
 */
var ROLE_ALIASES = {
  'administrator':            'Admin',
  'admin manager':            'Admin',
  'store mgr':                'Store Manager',
  'general manager':          'Store Manager',
  'assistant store manager':  'Assistant Manager',
  'asst store manager':       'Assistant Manager',
  'asst. store manager':      'Assistant Manager',
  'assistant mgr':            'Assistant Manager',
  'asst manager':             'Assistant Manager',
  'assistant general manager':'Assistant Manager',
  'bud tender':               'Budtender',
  'budtenders':               'Budtender',
  'sales associate':          'Budtender'
};

/**
 * Canonicalise a role title, or return '' if it is not one of the four.
 *
 * '' is the honest answer for an unknown title and callers must treat it as a refusal, not as
 * "no role" — silently writing '' would erase a title someone deliberately set.
 */
function normRole_(v) {
  var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (var i = 0; i < ROLE_TITLES.length; i++) {
    if (ROLE_TITLES[i].toLowerCase() === s.toLowerCase()) return ROLE_TITLES[i];
  }
  return ROLE_ALIASES[s.toLowerCase()] || '';
}

/** How far ahead `celebrations` looks. Kiosk wants "today + coming up this week or so". */
var CELEBRATION_HORIZON_DAYS = 14;

function doGet(e)  { return route_(e); }
function doPost(e) { return route_(e); }

function route_(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'health';
  var body = null;
  if (e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); } catch (err) { body = null; }
  }
  try {
    switch (action) {
      // Bulk HR import. POST only — the payload is the whole roster and cannot fit in a query
      // string, and this writes both the shared registry and Crew's attributes.
      case 'hr_import': return json_(hrImport_(p, body), p.callback);

      // One-time-ish migration of Leaderboard's nickname + avatar maps into Core display fields.
      case 'migrate_leaderboard': return json_(migrateLeaderboard_(p, body), p.callback);

      case 'health':
        return json_({ ok: true, app: 'crew', ts: new Date().toISOString() }, p.callback);

      // ── Roster (auth-gated — holds PII) ─────────────────────────────────────
      case 'roster':       return json_(getRoster_(p), p.callback);
      case 'roster_save':  return json_(saveRosterAttrs_(p), p.callback);
      case 'roster_retire':return json_(setRetired_(p), p.callback);
      case 'roster_identity': return json_(saveIdentity_(p), p.callback);
      case 'roster_merge': return json_(mergeEmployees_(p), p.callback);
      case 'assign_numbers': return json_(assignNumbers_(p), p.callback);
      case 'set_number':     return json_(setNumber_(p), p.callback);
      case 'email_proposals': return json_(emailProposals_(p), p.callback);

      // Leaderboard's avatar service — its backend calls these so staff keep self-service
      // without a Crew login. See avatarSave_ for why it is not a public write.
      case 'metrc_health': return json_(metrcHealth_(p), p.callback);
      case 'metrc_setup':  return json_(metrcSandboxSetup_(p), p.callback);
      case 'metrc_probe':  return json_(metrcAuthProbe_(p), p.callback);
      case 'metrc_access': return json_(metrcAccessAudit_(p), p.callback);

      case 'avatars':      return json_(avatarsForKiosk_(p), p.callback);
      case 'avatar_save':  return json_(avatarSave_(p, body), p.callback);
      case 'create_accounts': return json_(createAccounts_(p, body), p.callback);

      // ── Review queue: catch cross-source disagreements, ask a human ─────────
      // Employee of the Month history. The PICK itself is written straight to GX Core by the
      // browser (GXCore set_eom); this reads that value back and keeps Crew's own log of it.
      case 'eom_history':    return json_(getEomHistory_(p), p.callback);

      // Enter the months that predate the log. Deploy-secret, and confirm=yes to write, because
      // it is the only way anything reaches this record that Crew did not observe for itself.
      case 'eom_backfill':   return json_(eomBackfill_(p, body), p.callback);

      case 'review':         return json_(getReview_(p), p.callback);
      case 'review_resolve': return json_(resolveReview_(p), p.callback);
      case 'review_report':  return json_(reportConflicts_(p, body), p.callback);

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

      // Puts a blanked identity row back together. Preview by default; writing takes confirm=yes.
      // See identityRepair_ for what a "blanked row" is and why one appears.
      case 'identity_repair':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(identityRepair_(p), p.callback);

      // Script-property KEYS only (never values) — the Apps Script UI caps its property list at
      // 50, so a big Leaderboard hand-off like GC_NICKNAMES_JSON becomes invisible there. This
      // says what actually landed. Values stay hidden: some properties are secrets.
      case 'props':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(propsInspect_(), p.callback);

      // Is Dutchie's existing permit data good enough to skip the Metrc integrator application?
      case 'permit_coverage':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(permitCoverage_(), p.callback);

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
  // Prefer GX Core's canonical helper (v126+) so every spoke agrees on what "can edit" means —
  // Crew's own list was missing `editor` until it was caught here. Falls back to the local
  // allowlist if the library predates it, so a version skew can never fail OPEN.
  try {
    if (typeof GXCore.roleCanEdit === 'function') return !!GXCore.roleCanEdit(role);
  } catch (e) { /* fall through */ }
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
    return sh;
  }
  // Migrate in place when ATTR_HEADERS grows. Appending only — existing columns keep their
  // position so no stored value shifts under a different header.
  var width = Math.max(sh.getLastColumn(), 1);
  var have  = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var missing = ATTR_HEADERS.filter(function (h) { return have.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    have = have.concat(missing);
  }
  // Sheets turns "00" into the number 0 unless the column is explicitly plain text. Reserved
  // numbers like the owner's 00 have to survive the round trip, so pin the format once.
  ['employee_number', 'birthday', 'permit_number'].forEach(function (h) {
    var c = have.indexOf(h);
    if (c >= 0) sh.getRange(2, c + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });
  return sh;
}

/** All stored attributes, as { employee_id → row object }. */
function attrHeaders_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
           .map(function (h) { return String(h || '').trim(); });
}

function readAttrs_() {
  var sh = crewSheet_();
  var last = sh.getLastRow();
  if (last < 2) return {};
  var hdr = attrHeaders_(sh);
  var values = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var out = {};
  for (var i = 0; i < values.length; i++) {
    var row = {};
    for (var c = 0; c < hdr.length; c++) row[hdr[c]] = String(values[i][c] == null ? '' : values[i][c]).trim();
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
    var hdr = attrHeaders_(sh);
    var row = hdr.map(function (h) { return rec[h] == null ? '' : rec[h]; });
    if (targetRow) sh.getRange(targetRow, 1, 1, hdr.length).setValues([row]);
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





// ─── Employee numbers: system-assigned, never typed ─────────────────────────────
/*
 * employee_number is the canonical stable key the whole suite joins on, so it is issued by the
 * system rather than typed. Two properties matter more than convenience:
 *
 *   • NEVER REUSE. The next number is max(every number ever seen) + 1, counting retired and
 *     merged rows. Reissuing a retired person's number would silently attach their history to
 *     somebody new — 93 and 94 belong to Hinkle and Urenda, which is exactly why the first
 *     backfill had to start at 95 rather than the 93 that looked free.
 *   • DETERMINISTIC ORDER. Hire date first, so the sequence reflects who arrived when. People
 *     with no hire date on file cannot be placed in that order, so they sort last by name and
 *     are REPORTED as such — the number is still correct, but its position carries no meaning
 *     and nobody should read tenure into it.
 */
function assignNumbers_(p) {
  var auth = deploySecretOk_(p) ? { ok: true, user: 'tooling', role: 'admin' } : requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var identity = GXCore.getEmployees() || [];
  var attrs = readAttrs_();

  // Every number ever issued, from BOTH stores and regardless of status.
  var used = {}, maxN = 0;
  function note(v) {
    var n = parseInt(String(v || '').trim(), 10);
    if (!isNaN(n) && n > 0) { used[n] = true; if (n > maxN) maxN = n; }
  }
  identity.forEach(function (r) { note(r.employee_number); });
  Object.keys(attrs).forEach(function (k) { note(attrs[k].employee_number); });

  var need = identity.filter(function (r) {
    var st = String(r.status || 'active').toLowerCase();
    if (st === 'retired' || st === 'merged' || st === 'inactive' || st === 'terminated') return false;
    var id = String(r.employee_id || '').trim();
    return !String((attrs[id] || {}).employee_number || r.employee_number || '').trim();
  });

  need.sort(function (a, b) {
    var ah = normDate_(a.hire_date), bh = normDate_(b.hire_date);
    if (ah && !bh) return -1;
    if (!ah && bh) return 1;
    if (ah && bh && ah !== bh) return ah < bh ? -1 : 1;
    return String(a.full_name).localeCompare(String(b.full_name));
  });

  var next = maxN + 1, plan = [];
  need.forEach(function (r) {
    while (used[next]) next++;            // belt and braces against a gap-filling mistake
    plan.push({ employee_id: String(r.employee_id).trim(), name: String(r.full_name || ''),
                hire_date: normDate_(r.hire_date) || '', number: next,
                ordered_by_hire_date: !!normDate_(r.hire_date) });
    used[next] = true; next++;
  });

  var noDate = plan.filter(function (x) { return !x.ordered_by_hire_date; })
                   .map(function (x) { return x.name; });
  var out = { ok: true, mode: String(p.confirm || '') === 'yes' ? 'assigned' : 'preview',
              highest_in_use: maxN, starting_at: maxN + 1, count: plan.length, plan: plan,
              no_hire_date: noDate };
  if (noDate.length) {
    out.warning = noDate.length + ' of these have no hire date, so their position in the sequence ' +
                  'is alphabetical, not chronological: ' + noDate.join(', ');
  }
  if (String(p.confirm || '') !== 'yes') {
    out.note = 'DRY RUN — nothing written. Repeat with confirm=yes.';
    return out;
  }

  var idRows = [];
  plan.forEach(function (a) {
    var prior = null;
    for (var i = 0; i < identity.length; i++) {
      if (String(identity[i].employee_id || '').trim() === a.employee_id) { prior = identity[i]; break; }
    }
    if (!prior) return;
    var merged = {};
    Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });   // read-merge-write
    merged.employee_id = a.employee_id;
    merged.employee_number = String(a.number);
    idRows.push(merged);

    var was = attrs[a.employee_id] || {};
    var rec = { employee_id: a.employee_id, name_key: nameToKey_(prior.full_name),
                full_name: String(prior.full_name || ''), employee_number: String(a.number),
                updated_at: new Date().toISOString(), updated_by: auth.user + ' (auto-number)' };
    ['shirt_size', 'birthday', 'work_anniversary', 'wage',
     'permit_number', 'permit_granted', 'permit_expires', 'permit_status'].forEach(function (k) {
      rec[k] = was[k] || '';
    });
    writeAttrs_(rec);
  });
  if (idRows.length) GXCore.gxUpsertEmployees(idRows);
  bustRosterCache_();
  out.written = idRows.length;
  return out;
}


/**
 * Explicit override for a single employee number. Deliberately NOT exposed in the UI — numbers
 * are issued by assignNumbers_ — but reserved values exist (00 for the owner), and they have to
 * be settable by someone. Deploy-secret gated, and it refuses a number another person holds:
 * a collision here would graft one person's history onto another across every app that joins on it.
 *
 * A reserved number like 00 sits OUTSIDE the auto sequence on purpose: parseInt gives 0, which
 * the allocator ignores when computing the next number, so it can never collide with the series.
 */
function setNumber_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var id  = String(p.employee_id || '').trim();
  var num = String(p.number == null ? '' : p.number).trim();
  if (!id) return { ok: false, error: 'employee_id required' };
  if (!/^\d{1,5}$/.test(num)) return { ok: false, error: 'number must be 1-5 digits (leading zeros allowed)' };

  var identity = GXCore.getEmployees() || [];
  var attrs = readAttrs_();
  var prior = null, clash = null;
  identity.forEach(function (r) {
    var rid = String(r.employee_id || '').trim();
    if (rid === id) prior = r;
    var held = String((attrs[rid] || {}).employee_number || r.employee_number || '').trim();
    // Compare NUMERICALLY. Sheets coerces "00" to the number 0 on write, so a string compare
    // reads the stored "0" as different from the incoming "00" and waves a collision straight
    // through — which is exactly how a second person was handed 00.
    if (rid !== id && held !== '' && parseInt(held, 10) === parseInt(num, 10)) clash = r.full_name;
  });
  if (!prior) return { ok: false, error: 'unknown employee_id: ' + id };
  if (clash)  return { ok: false, error: 'number ' + num + ' is already held by ' + clash };

  var was = String((attrs[id] || {}).employee_number || prior.employee_number || '').trim();
  var merged = {};
  Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
  merged.employee_id = id;
  merged.employee_number = num;
  GXCore.gxUpsertEmployee(merged);

  var a = attrs[id] || {};
  var rec = { employee_id: id, name_key: nameToKey_(prior.full_name),
              full_name: String(prior.full_name || ''), employee_number: num,
              updated_at: new Date().toISOString(), updated_by: 'tooling (reserved number)' };
  ['shirt_size', 'birthday', 'work_anniversary', 'wage',
   'permit_number', 'permit_granted', 'permit_expires', 'permit_status'].forEach(function (k) {
    rec[k] = a[k] || '';
  });
  writeAttrs_(rec);
  bustRosterCache_();
  return { ok: true, employee_id: id, name: prior.full_name, was: was || '(none)', now: num };
}


// ─── Email proposals (firstname@greencrosscanna.com) ────────────────────────────
/*
 * The house convention is firstname@greencrosscanna.com, and gxSeedTeamEmails() already
 * establishes it as GX Core policy. That makes the convention a fine PROPOSAL GENERATOR — but
 * core-admin is right that deriving is not the same as knowing, and this roster proves why:
 *
 *   • First names collide. Two active Zacharys is why Leaderboard carries the nicknames
 *     "Zach B" and "Zach R" at all — the convention cannot name them both.
 *   • People go by something other than their legal first name. Andrew Phillips is "Drew";
 *     Robert Wydick goes by Nathan. Whether the mailbox is andrew@ or drew@ is a fact about
 *     Workspace, not something a rule can derive.
 *   • A derived address is not a mailbox. Deriving it does not create it, and a wrong address
 *     for a SPIFF payout fails silently.
 *
 * So this PROPOSES and reports every reason to doubt each one. Nothing is written; confirmed
 * addresses go in through the normal review/confirm path once a human has checked Workspace.
 */
function emailProposals_(p) {
  if (!deploySecretOk_(p)) {
    var auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  }
  var roleFilter = String(p.role || '').trim().toLowerCase();
  var rows = GXCore.getEmployees() || [];

  var firstOf = function (r) {
    return String(r.full_name || '').trim().split(/\s+/)[0] || '';
  };
  var slug = function (n) { return String(n || '').toLowerCase().replace(/[^a-z]/g, ''); };

  // Count first-name usage across EVERY active person, not just the filtered set — a collision
  // with someone outside the filter is still a collision.
  var firstCount = {};
  rows.forEach(function (r) {
    var st = String(r.status || 'active').toLowerCase();
    if (st === 'retired' || st === 'merged' || st === 'inactive' || st === 'terminated') return;
    var f = slug(firstOf(r));
    if (f) firstCount[f] = (firstCount[f] || 0) + 1;
  });

  var out = [];
  rows.forEach(function (r) {
    var st = String(r.status || 'active').toLowerCase();
    if (st === 'retired' || st === 'merged' || st === 'inactive' || st === 'terminated') return;
    if (roleFilter && String(r.role_title || '').toLowerCase().indexOf(roleFilter) < 0) return;

    var first = firstOf(r), f = slug(first);
    var nick = String(r.preferred_name || '').trim();
    var doubts = [];
    if (firstCount[f] > 1) doubts.push('FIRST NAME COLLIDES with ' + (firstCount[f] - 1) + ' other active staff');
    if (nick && slug(nick) !== f) doubts.push('goes by "' + nick + '", so the mailbox may be ' + slug(nick) + '@');
    /*
     * employee_id was seeded from what DUTCHIE and LEADERBOARD call people — i.e. what they
     * actually go by day to day — while full_name now carries the legal form from HR/METRC.
     * Where those two disagree on the first name, the convention is ambiguous even though
     * nothing looks wrong: "Samuel Keck" with id sam_keck is a sam@, not a samuel@.
     */
    var idFirst = slug(String(r.employee_id || '').split('_')[0]);
    if (idFirst && f && idFirst !== f) {
      doubts.push('known elsewhere as "' + idFirst + '" (employee_id ' + r.employee_id +
                  '), so the mailbox may be ' + idFirst + '@');
    }
    if (!f) doubts.push('no usable first name');
    out.push({
      employee_id: String(r.employee_id || ''), name: String(r.full_name || ''),
      role: String(r.role_title || ''), preferred_name: nick,
      has_account: !!String(r.user_id || '').trim(),
      existing_user_id: String(r.user_id || ''),
      proposed: f ? f + '@greencrosscanna.com' : '',
      confident: doubts.length === 0,
      doubts: doubts
    });
  });

  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { ok: true, policy: 'firstname@greencrosscanna.com (GX Core, gxSeedTeamEmails)',
           counted: out.length,
           needing_account: out.filter(function (x) { return !x.has_account; }).length,
           confident: out.filter(function (x) { return !x.has_account && x.confident; }).length,
           needs_a_human: out.filter(function (x) { return !x.has_account && !x.confident; }).length,
           note: 'PROPOSALS ONLY — nothing written. A derived address is not a mailbox; confirm in Workspace before use.',
           proposals: out };
}


// ─── Account creation (verified addresses only) ─────────────────────────────────
/*
 * Creates the users row and links employees.user_id to it. Addresses come in from the payload
 * because they must be VERIFIED, never derived — this roster produced three cases no rule would
 * have got right: Sam Keck is samuel@, Pam Johnson is pamela@, but Zach Babcock is zach@.
 *
 * Note gxUpsertUser does NOT read-merge — it replaces the row. We therefore send the FULL users
 * schema rather than a partial record. That is safe here because passwords live in the separate
 * user_auth tab, so a rewrite cannot cost anyone their login; but it is the reason nothing
 * partial should ever be sent to it.
 *
 * A users row is identity + address only. It grants NO app access on its own (that is app_access,
 * superadmin-gated) and carries no password, so creating one cannot let anybody in.
 */
function createAccounts_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var list = (body && body.accounts) || [];
  if (!list.length) return { ok: false, error: 'no accounts in payload' };
  var dry = String(p.confirm || '') !== 'yes';

  var identity = GXCore.getEmployees() || [];
  var byId = {};
  identity.forEach(function (r) { byId[String(r.employee_id || '').trim()] = r; });

  var plan = [], problems = [];
  list.forEach(function (a) {
    var eid   = String(a.employee_id || '').trim();
    var email = String(a.email || '').trim().toLowerCase();
    var emp   = byId[eid];
    if (!emp)   { problems.push('unknown employee_id: ' + eid); return; }
    if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      problems.push(emp.full_name + ': not a valid address: ' + email); return;
    }
    // user_id follows the existing convention: the mailbox name, not a name slug.
    var uid = String(a.user_id || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!uid) { problems.push(emp.full_name + ': could not derive a user_id'); return; }
    if (String(emp.user_id || '').trim() && String(emp.user_id).trim() !== uid) {
      problems.push(emp.full_name + ': already linked to account "' + emp.user_id +
                    '" — refusing to relink to "' + uid + '"');
      return;
    }
    var store = String(emp.home_store || '').trim();
    plan.push({ employee_id: eid, name: String(emp.full_name || ''), user_id: uid, email: email,
                // corporate is not a kiosk store, so it is not a default_store
                default_store: store === 'corporate' ? '' : store,
                already_linked: String(emp.user_id || '').trim() === uid });
  });

  var out = { ok: true, mode: dry ? 'preview' : 'commit',
              would_create: plan.filter(function (x) { return !x.already_linked; }).length,
              already_linked: plan.filter(function (x) { return x.already_linked; }).length,
              plan: plan, problems: problems };
  if (dry) { out.note = 'DRY RUN — nothing written. Repeat with confirm=yes.'; return out; }

  var linked = [];
  plan.forEach(function (a) {
    GXCore.gxUpsertUser({
      user_id: a.user_id, display_name: a.name, email: a.email, status: 'active',
      employee_id: a.employee_id, default_store: a.default_store, is_superadmin: 'FALSE',
      notes: 'created by GX Crew from a verified address'
    });
    var prior = byId[a.employee_id];
    var merged = {};
    Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });   // read-merge-write
    merged.employee_id = a.employee_id;
    merged.user_id = a.user_id;
    GXCore.gxUpsertEmployee(merged);
    linked.push(a.name + ' → ' + a.user_id + ' <' + a.email + '>');
  });
  bustRosterCache_();
  out.linked = linked;
  out.note = 'users rows carry no password and grant no app access — app_access is separate.';
  return out;
}


// ─── Avatar service for Leaderboard (server-to-server) ──────────────────────────
/*
 * Staff change their own avatar by clicking their puck on the kiosk — no login, no Crew
 * access. That flow must keep working exactly as it does today; only the destination moves.
 *
 * WHY LEADERBOARD DOES NOT WRITE CORE DIRECTLY:
 *   • core-admin's model is that Crew is the SOLE writer to the employees registry. Two writers
 *     is how rows get silently clobbered, which we have already lived through once.
 *   • gxWrite_ replaces whole rows, so every writer needs the read-merge-write discipline. Better
 *     to keep that in one place than to reimplement it correctly in a second app.
 *   • Leaderboard binds an older GXCore; avatar_config only exists from v127. Going through here
 *     means no re-pin, and no risk of taking Leaderboard down for a cosmetic feature.
 *
 * WHY IT IS SECRET-GATED AND NOT PUBLIC:
 *   The kiosk page is public JS and cannot hold a secret. So the browser calls LEADERBOARD's
 *   backend (which already knows who is logged in), and that backend calls this with the shared
 *   secret. Staff never authenticate to Crew, and there is no open write surface on the internet.
 */
function resolveEmployee_(rows, ref) {
  var want = String(ref || '').trim();
  if (!want) return null;
  var lower = want.toLowerCase();
  var byNum = null, byId = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.employee_id || '').trim().toLowerCase() === lower) byId = r;
    var n = String(r.employee_number || '').trim();
    if (n && (n === want || parseInt(n, 10) === parseInt(want, 10))) byNum = byNum || r;
  }
  if (byId) return byId;
  if (byNum && /^\d+$/.test(want)) return byNum;
  // A merge or rename may have retired this key — follow the alias before giving up.
  var alias = readAliases_()[nameToKey_(want.replace(/_/g, ' '))] || readAliases_()[lower];
  if (alias) {
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j].employee_id || '').trim() === alias) return rows[j];
    }
  }
  for (var k = 0; k < rows.length; k++) {
    if (samePerson_(want.replace(/_/g, ' '), rows[k].full_name)) return rows[k];
  }
  return null;
}

/** Everything Leaderboard needs to render faces, keyed both ways so either join works. */
function avatarsForKiosk_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var rows = GXCore.getEmployees() || [];
  var attrs = readAttrs_();
  var byKey = {}, byNumber = {}, names = {};
  rows.forEach(function (r) {
    var st = String(r.status || 'active').toLowerCase();
    if (st === 'merged') return;
    var id  = String(r.employee_id || '').trim();
    var num = String((attrs[id] || {}).employee_number || r.employee_number || '').trim();
    var cfg = String(r.avatar_config || '').trim();
    if (cfg) {
      var parsed = null;
      try { parsed = JSON.parse(cfg); } catch (e) { parsed = null; }
      if (parsed) {
        // Seed travels WITH the config so Leaderboard never has to derive it from a name.
        parsed.seed = num || id;
        byKey[id] = parsed;
        if (num) byNumber[num] = parsed;
      }
    }
    var nick = String(r.preferred_name || '').trim();
    if (nick) names[id] = nick;
  });
  return { ok: true, avatarConfigs: byKey, byEmployeeNumber: byNumber, nicknames: names,
           note: 'seed is inside each config — do not regenerate it from a name key' };
}

/** Write one person's avatar. Called by Leaderboard's backend on behalf of a signed-in user. */
function avatarSave_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var ref = String(p.employee || p.nameKey || p.employee_id || '').trim();
  var raw = (body && body.config) || p.config || '';
  var rows = GXCore.getEmployees() || [];
  var emp = resolveEmployee_(rows, ref);
  if (!emp) return { ok: false, error: 'could not resolve "' + ref + '" to anyone on the roster' };

  var cfg = null;
  if (String(raw).trim()) {
    try {
      cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not an object');
    } catch (e) { return { ok: false, error: 'config must be a JSON object of DiceBear params' }; }
  }

  var id = String(emp.employee_id).trim();
  var attrs = readAttrs_();
  var num = String((attrs[id] || {}).employee_number || emp.employee_number || '').trim();
  if (cfg) cfg.seed = num || id;   // pin the seed; a rename must never change the face

  var merged = {};
  Object.keys(emp).forEach(function (k) { merged[k] = emp[k]; });   // read-merge-write
  merged.employee_id = id;
  merged.avatar_config = cfg ? JSON.stringify(cfg) : '';

  /*
   * gxWrite_ serialises on the script lock and gives up after 30s. Under any concurrent write
   * that surfaces as "Lock timeout", which a staff member would see as their avatar failing to
   * save for no reason they can act on. Observed on the very first live call, so it is not
   * theoretical. Retry a couple of times before admitting defeat.
   */
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    try { GXCore.gxUpsertEmployee(merged); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (!/lock/i.test(String((e && e.message) || e))) break;   // only lock contention is retryable
      Utilities.sleep(1500 * (attempt + 1));
    }
  }
  if (lastErr) {
    return { ok: false, retryable: /lock/i.test(String(lastErr.message || lastErr)),
             error: String(lastErr.message || lastErr) };
  }
  bustRosterCache_();
  return { ok: true, employee_id: id, name: emp.full_name, seed: num || id,
           cleared: !cfg, resolved_from: ref };
}


// ─── METRC connector (Oregon) ───────────────────────────────────────────────────
/*
 * Worker-permit truth, straight from the state system, replacing the per-store spreadsheet
 * exports we had been importing by hand.
 *
 * CREDENTIALS LIVE IN SCRIPT PROPERTIES, never in this file and never in the frontend:
 *   METRC_VENDOR_KEY   the integrator/software key Metrc issues
 *   METRC_USER_KEY     the user key generated inside Metrc by the licence owner
 *   METRC_LICENSES     comma-separated licence numbers (e.g. 050-12997,050-13000,…)
 * Metrc authenticates as Basic base64(vendorKey:userKey) — BOTH halves are required; the
 * vendor key is the username. A user key alone cannot authenticate at all.
 *
 * WHY THIS MATTERS BEYOND CONVENIENCE: the review queue currently asks whether retired staff
 * still hold live access, and the honest answer needed a human to open Metrc. With this, Crew
 * can check it directly — which is the difference between a flag someone must chase and a fact.
 */
/*
 * Base URL is a PROPERTY, not a constant, because sandbox and production are different hosts
 * holding different data:
 *   production  https://api-or.metrc.com          — real Green Cross staff and permits
 *   sandbox     https://sandbox-api-or.metrc.com  — Metrc's generic test data, periodically reset
 * Sandbox is for passing Metrc's evaluation. It cannot answer a question about OUR staff, so any
 * audit run against it must be labelled as such rather than mistaken for the real thing.
 */
var METRC_BASE_DEFAULT = 'https://api-or.metrc.com';

function metrcCreds_() {
  var props = PropertiesService.getScriptProperties();
  return {
    base: String(props.getProperty('METRC_BASE') || METRC_BASE_DEFAULT).replace(/\/+$/, ''),
    vendor: String(props.getProperty('METRC_VENDOR_KEY') || '').trim(),
    user:   String(props.getProperty('METRC_USER_KEY') || '').trim(),
    licenses: String(props.getProperty('METRC_LICENSES') || '').split(',')
                .map(function (x) { return x.trim(); }).filter(Boolean)
  };
}

function metrcGet_(path, params) {
  var c = metrcCreds_();
  if (!c.vendor || !c.user) {
    throw new Error('METRC keys are not set. Add METRC_VENDOR_KEY and METRC_USER_KEY to this ' +
                    'script\'s properties. Both are required — Metrc authenticates as ' +
                    'Basic base64(vendorKey:userKey), so a user key alone cannot connect.');
  }
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = c.base + path + (qs ? '?' + qs : '');
  var res = UrlFetchApp.fetch(url, {
    method: 'get', muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.vendor + ':' + c.user) }
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code === 401) throw new Error('METRC rejected the credentials (401). Check both keys, and ' +
                                    'that the user key belongs to an account with API access.');
  if (code === 403) throw new Error('METRC returned 403 — the keys are valid but not authorised ' +
                                    'for this licence or endpoint.');
  if (code >= 300) throw new Error('METRC HTTP ' + code + ': ' + body.slice(0, 300));
  try { return JSON.parse(body); }
  catch (e) { throw new Error('METRC returned non-JSON: ' + body.slice(0, 200)); }
}

/** Connectivity + shape probe. Reports FIELD NAMES only — permit numbers are government IDs. */
function metrcHealth_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var c = metrcCreds_();
  var isSandbox = /sandbox/i.test(c.base);
  var out = { ok: true, base: c.base, environment: isSandbox ? 'SANDBOX (generic test data)' : 'production',
              has_vendor_key: !!c.vendor, has_user_key: !!c.user, licenses: c.licenses.length };
  if (isSandbox) {
    out.warning = 'Sandbox holds Metrc test data, NOT Green Cross staff. Nothing read here can ' +
                  'answer whether our own retired employees are deactivated.';
  }
  if (!c.vendor || !c.user) {
    out.ok = false;
    out.error = 'Missing keys. Set METRC_VENDOR_KEY and METRC_USER_KEY in this script\'s properties.';
    return out;
  }
  if (!c.licenses.length) {
    out.ok = false;
    out.error = 'Set METRC_LICENSES to a comma-separated list of licence numbers.';
    return out;
  }
  try {
    var rows = metrcGet_('/employees/v1/', { licenseNumber: c.licenses[0] }) || [];
    out.probe_license = c.licenses[0];
    out.records = rows.length;
    // Shape, not content — the API's field names differ from the UI export's headers.
    out.fields = rows.length ? Object.keys(rows[0]).sort() : [];
    if (rows.length && rows[0].License && typeof rows[0].License === 'object') {
      out.license_fields = Object.keys(rows[0].License).sort();
    }
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  return out;
}


/**
 * Bootstrap a SANDBOX user key. Metrc's sandbox lets an integrator mint its own industry user
 * key via POST /sandbox/v2/integrator/setup, authenticated with the vendor key on an
 * `x-metrc-key` HEADER — note that is API-Key auth, unlike every other endpoint, which uses
 * Basic base64(vendor:user). Getting that wrong is the obvious first stumble.
 *
 * The returned key is written STRAIGHT INTO SCRIPT PROPERTIES and never included in the
 * response: a credential that travels back over HTTP to a caller has been exposed to the
 * caller's logs, terminal history and mine. We return its shape, not its value.
 */
function metrcSandboxSetup_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var c = metrcCreds_();
  if (!c.vendor) return { ok: false, error: 'METRC_VENDOR_KEY is not set' };
  if (!/sandbox/i.test(c.base)) {
    return { ok: false, error: 'Refusing to run sandbox setup against ' + c.base +
             ' — this endpoint only exists in the sandbox environment.' };
  }
  var res = UrlFetchApp.fetch(c.base + '/sandbox/v2/integrator/setup', {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'x-metrc-key': c.vendor }, payload: '{}'
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) return { ok: false, http: code, error: body.slice(0, 400) };

  /*
   * This endpoint is ASYNCHRONOUS and does not hand back the key. Observed live:
   *   first call  -> 200 "User queued for creation"  (plain text, not JSON)
   *   later calls -> 200 with an empty body          (nothing left to do)
   * Neither is an error, and calling either one a failure sends you debugging a working
   * integration. The key itself is issued into Metrc Connect, not returned over the wire.
   */
  var trimmed = String(body || '').trim();
  var data = null;
  if (trimmed) { try { data = JSON.parse(trimmed); } catch (e) { data = null; } }
  if (!data) {
    return { ok: true, http: code, user_key_stored: false, async: true,
             metrc_said: trimmed || '(empty body)',
             note: trimmed
               ? 'Metrc QUEUED the sandbox user. It does not return the key — collect it from ' +
                 'Metrc Connect > Users, then set METRC_USER_KEY.'
               : 'Nothing to do: the sandbox user already exists from an earlier call. Collect ' +
                 'its key from Metrc Connect > Users, then set METRC_USER_KEY.' };
  }

  // The field name is not documented consistently across states — find the key without guessing.
  var found = '', foundIn = '';
  function scan(o, path) {
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (typeof v === 'string' && v.length >= 20 && /key/i.test(k) && !found) {
        found = v; foundIn = (path ? path + '.' : '') + k;
      } else if (v && typeof v === 'object') { scan(v, (path ? path + '.' : '') + k); }
    });
  }
  scan(Array.isArray(data) ? { list: data } : data, '');

  var out = { ok: true, http: code, response_fields: Object.keys(
    Array.isArray(data) ? (data[0] || {}) : data).sort() };
  if (found) {
    PropertiesService.getScriptProperties().setProperty('METRC_USER_KEY', found);
    out.user_key_stored = true;
    out.found_in_field = foundIn;
    out.key_length = found.length;   // shape only — never the value
    out.note = 'Sandbox user key written to METRC_USER_KEY. Its value is deliberately not returned.';
  } else {
    out.user_key_stored = false;
    out.raw_preview = body.slice(0, 400);
    out.note = 'No key-like field found. Inspect response_fields and set METRC_USER_KEY by hand.';
  }
  return out;
}


/**
 * Auth probe. Metrc's sandbox setup call is asynchronous and returns no key, and the docs list
 * no GET to retrieve one — so before anyone goes hunting through the portal, establish what the
 * vendor key alone can actually reach, and whether the key comes back in a HEADER we ignored.
 * Read-only target (tagtypes) so nothing is created while probing.
 */
function metrcAuthProbe_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var c = metrcCreds_();
  if (!c.vendor) return { ok: false, error: 'METRC_VENDOR_KEY is not set' };

  var target = c.base + '/sandbox/v2/tagtypes';
  var b64 = function (x) { return Utilities.base64Encode(x); };
  var attempts = [
    { how: 'Basic vendor:vendor', headers: { Authorization: 'Basic ' + b64(c.vendor + ':' + c.vendor) } },
    { how: 'Basic vendor:(empty)', headers: { Authorization: 'Basic ' + b64(c.vendor + ':') } },
    { how: 'x-metrc-key header only', headers: { 'x-metrc-key': c.vendor } },
    { how: 'x-metrc-key + Basic vendor:vendor', headers: {
        'x-metrc-key': c.vendor, Authorization: 'Basic ' + b64(c.vendor + ':' + c.vendor) } }
  ];
  var results = attempts.map(function (a) {
    try {
      var r = UrlFetchApp.fetch(target, { method: 'get', muteHttpExceptions: true, headers: a.headers });
      return { how: a.how, http: r.getResponseCode(), body: r.getContentText().slice(0, 120) };
    } catch (e) { return { how: a.how, error: String((e && e.message) || e) }; }
  });

  // Re-run setup and capture RESPONSE HEADERS — a key handed back out-of-band would be here.
  var setupHeaders = {}, setupCode = null, setupBody = '';
  try {
    var sr = UrlFetchApp.fetch(c.base + '/sandbox/v2/integrator/setup', {
      method: 'post', muteHttpExceptions: true, contentType: 'application/json',
      headers: { 'x-metrc-key': c.vendor }, payload: '{}'
    });
    setupCode = sr.getResponseCode();
    setupBody = sr.getContentText().slice(0, 200);
    var h = sr.getAllHeaders();
    Object.keys(h).forEach(function (k) {
      // Names and lengths only — if a credential IS in here, do not print it.
      var v = h[k];
      setupHeaders[k] = (typeof v === 'string' && v.length > 40) ? '<' + v.length + ' chars>' : v;
    });
  } catch (e) { setupBody = 'error: ' + String((e && e.message) || e); }

  return { ok: true, base: c.base, target: target, attempts: results,
           setup_http: setupCode, setup_body: setupBody, setup_headers: setupHeaders };
}

/** Everyone METRC currently knows about, deduped across licences, keyed by permit number. */
function metrcAllEmployees_() {
  var c = metrcCreds_();
  var byPermit = {}, errors = [], seen = 0;
  c.licenses.forEach(function (lic) {
    var rows;
    try { rows = metrcGet_('/employees/v1/', { licenseNumber: lic }) || []; }
    catch (e) { errors.push(lic + ': ' + String((e && e.message) || e)); return; }
    rows.forEach(function (r) {
      seen++;
      var L = r.License || {};
      var permit = String(L.Number || r.LicenseNumber || '').trim();
      var name = String(r.FullName || r.Name || '').trim();
      if (!name) return;
      var key = permit || ('name:' + nameToKey_(name));
      var rec = byPermit[key] || (byPermit[key] = {
        permit: permit, name: name, licenses: [], start: String(L.StartDate || ''),
        end: String(L.EndDate || ''), active: false
      });
      if (rec.licenses.indexOf(lic) < 0) rec.licenses.push(lic);
      // Metrc marks the person per facility; active anywhere means they still hold access.
      var isActive = r.IsActive !== false && String(r.Status || 'Active').toLowerCase() !== 'inactive';
      if (isActive) rec.active = true;
      if (L.EndDate && (!rec.end || String(L.EndDate) > rec.end)) rec.end = String(L.EndDate);
    });
  });
  return { people: byPermit, errors: errors, rows_seen: seen };
}

/**
 * The question the review queue could not answer without a human: are the people we have marked
 * retired actually deactivated in METRC? Names only — no permit numbers leave this.
 */
function metrcAccessAudit_(p) {
  if (!deploySecretOk_(p)) {
    var auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  }
  var creds = metrcCreds_();
  if (/sandbox/i.test(creds.base)) {
    return { ok: false, error: 'Refusing to audit against SANDBOX. It holds Metrc test data, not ' +
             'Green Cross staff, so a clean result here would be meaningless and a dirty one ' +
             'alarming. Point METRC_BASE at production once credentials are issued.' };
  }
  var m = metrcAllEmployees_();
  var metrcPeople = Object.keys(m.people).map(function (k) { return m.people[k]; });
  var joined = rosterJoin_();

  var stillActive = [], properlyRemoved = [], notInMetrc = [];
  joined.rows.forEach(function (r) {
    if (!r.retired) return;
    var hit = null;
    for (var i = 0; i < metrcPeople.length; i++) {
      if (samePerson_(r.name, metrcPeople[i].name)) { hit = metrcPeople[i]; break; }
    }
    if (!hit) { notInMetrc.push(r.name); return; }
    if (hit.active) stillActive.push({ name: r.name, licenses: hit.licenses.length });
    else properlyRemoved.push(r.name);
  });

  return {
    ok: true, metrc_rows_seen: m.rows_seen, metrc_people: metrcPeople.length,
    retired_in_crew: joined.rows.filter(function (r) { return r.retired; }).length,
    still_active_in_metrc: stillActive,
    properly_deactivated: properlyRemoved.length,
    retired_and_absent_from_metrc: notInMetrc.length,
    errors: m.errors,
    note: stillActive.length
      ? stillActive.length + ' retired staff still hold METRC access — revoke in METRC, this only reports.'
      : 'No retired staff hold active METRC access.'
  };
}

// ─── Review queue ───────────────────────────────────────────────────────────────
/*
 * The point of holding three sources is catching where they disagree — and then asking a human,
 * never silently picking. So:
 *
 *   • Conflicts are DETECTED on read from live data. Nothing is cached as a "conflict list",
 *     because one that drifts out of date is worse than not having one.
 *   • DECISIONS are persisted. Resolving an item records what was chosen, keyed on the item's
 *     values — so it stays gone, but if the underlying values CHANGE it surfaces again as a new
 *     question. Silence and "already answered" must not be the same state.
 *   • Defaults follow Sky's ruling: METRC wins on spelling (OLCC-validated, not hand-typed),
 *     Leaderboard wins on role. Those set which side is offered as `proposed`; they never apply
 *     themselves.
 */
function sheetOf_(tab, headers) {
  var ss = crewSheet_().getParent();
  var sh = ss.getSheetByName(tab);
  if (!sh) {
    sh = ss.insertSheet(tab);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readTab_(tab, headers) {
  var sh = sheetOf_(tab, headers);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues().map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    return o;
  });
}

/** Stable identity for a conflict: same question + same values = same decision. */
function decisionKey_(kind, employeeId, field, proposed) {
  return [kind, employeeId, field, String(proposed || '').toLowerCase()].join('|');
}

function reviewItems_() {
  var joined = rosterJoin_();
  var rows = joined.rows;
  var byId = {};
  rows.forEach(function (r) { byId[r.employee_id] = r; });

  var decided = {};
  readTab_(DECISION_TAB, DECISION_HEADERS).forEach(function (d) { decided[d.decision_key] = d; });

  var items = [];
  function add(kind, row, field, current, proposed, source, detail, severity) {
    var key = decisionKey_(kind, row.employee_id, field, proposed);
    if (decided[key]) return;
    items.push({
      id: key, kind: kind, employee_id: row.employee_id, name: row.name,
      field: field, current_value: String(current == null ? '' : current),
      proposed_value: String(proposed == null ? '' : proposed),
      source: source, detail: detail || '', severity: severity || 'info'
    });
  }

  // ── 1. Duplicates. This is what catches "TJ Peterson" without anyone noticing him first.
  for (var i = 0; i < rows.length; i++) {
    for (var j = i + 1; j < rows.length; j++) {
      var a = rows[i], b = rows[j];
      if (a.retired && b.retired) continue;
      if (!samePerson_(a.name, b.name)) continue;
      // Richer record wins by default — more populated fields means more to lose.
      // A dutchie_employee_id outweighs everything else: SPIFF and Leaderboard attribution
      // resolve through it, so keeping the other row would move payout math. Same for user_id,
      // which links to the account that owns email. Field count only breaks the tie.
      var score = function (r) {
        return (r.dutchie_employee_id ? 100 : 0) + (r.user_id ? 50 : 0) +
               (r.employee_number ? 1 : 0) + (r.hire_date ? 1 : 0) + (r.permit_number ? 1 : 0) +
               (r.wage ? 1 : 0) + (r.birthday ? 1 : 0) + (r.store ? 1 : 0);
      };
      var keep = score(a) >= score(b) ? a : b, drop = keep === a ? b : a;
      add('duplicate', keep, 'identity', drop.name, keep.name, 'GX Core',
          'Two records look like the same person. Keeping "' + keep.name + '" merges "' +
          drop.name + '" into it — nothing is deleted.', 'high');
      items[items.length - 1].merge_from = drop.employee_id;
      items[items.length - 1].merge_from_name = drop.name;
    }
  }

  // ── 2. Permits — the compliance half.
  rows.forEach(function (r) {
    if (r.retired) {
      if (r.permit_number && r.permit_status &&
          ['active', 'valid'].indexOf(String(r.permit_status).toLowerCase()) >= 0) {
        add('retired_with_access', r, 'permit_status', 'retired staff, permit still ' + r.permit_status,
            'revoke', 'METRC', 'Retired on the roster but still holds an active METRC permit/access.', 'high');
      }
      return;
    }
    if (!r.permit_number) {
      add('missing_permit', r, 'permit_number', '', 'needs a permit on file', 'METRC',
          'Active staff with no OLCC worker permit recorded.', 'high');
    } else if (r.permit_days_left != null && r.permit_days_left < 0) {
      add('permit_expired', r, 'permit_expires', r.permit_expires, 'renew', 'METRC',
          'Permit expired ' + (-r.permit_days_left) + ' days ago.', 'high');
    } else if (r.permit_days_left != null && r.permit_days_left <= 90) {
      add('permit_expiring', r, 'permit_expires', r.permit_expires, 'renew', 'METRC',
          'Permit expires in ' + r.permit_days_left + ' days.', 'warn');
    }
  });

  // ── 3. Gaps that need a person, not a default.
  rows.forEach(function (r) {
    if (r.retired) return;
    if (!r.employee_number) {
      add('missing_field', r, 'employee_number', '', 'assign next number', 'GX Crew',
          'No employee number — the canonical stable key. Run the auto-assign to issue the next one.', 'warn');
    }
    if (!r.hire_date) {
      add('missing_field', r, 'hire_date', '', 'needs a hire date', 'GX Crew',
          'No hire date, so tenure and work anniversary cannot be derived. Set it in the identity panel.', 'warn');
    }
  });

  // ── 4. Anything an import reported that the engine cannot see for itself (HR sheet, METRC
  //       exports — neither is reachable from Apps Script, so imports post their findings here).
  readTab_(REVIEW_TAB, REVIEW_HEADERS).forEach(function (rep) {
    var row = byId[rep.employee_id] || { employee_id: rep.employee_id, name: rep.name, retired: false };
    var key = decisionKey_(rep.kind, rep.employee_id, rep.field, rep.proposed_value);
    if (decided[key]) return;
    items.push({
      id: key, kind: rep.kind, employee_id: rep.employee_id, name: rep.name || row.name,
      field: rep.field, current_value: rep.current_value, proposed_value: rep.proposed_value,
      source: rep.source, detail: rep.detail, severity: 'warn', reported: true
    });
  });

  var rank = { high: 0, warn: 1, info: 2 };
  items.sort(function (x, y) {
    return (rank[x.severity] - rank[y.severity]) || x.name.localeCompare(y.name);
  });
  return items;
}

function getReview_(p) {
  // Deploy secret is accepted alongside a user session so the queue can be inspected from
  // tooling, same as seed_preview. Resolving still requires a real signed-in editor.
  var auth = deploySecretOk_(p) ? { ok: true, user: 'tooling', role: 'admin' } : requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  var items = reviewItems_();
  var counts = { high: 0, warn: 0, info: 0 };
  items.forEach(function (i) { counts[i.severity] = (counts[i.severity] || 0) + 1; });
  return { ok: true, can_edit: canEdit_(auth), total: items.length, counts: counts, items: items };
}

/**
 * Resolve one item. `choice` is 'accept' (take the proposed value), 'keep' (the current value is
 * correct) or 'dismiss' (not a problem). All three record a decision — "I looked and it's fine"
 * is an answer, and must silence the item just as firmly as a correction does.
 */
function resolveReview_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.id || '').trim();
  var choice = String(p.choice || '').trim();
  if (!id) return { ok: false, error: 'id required' };
  if (['accept', 'keep', 'dismiss'].indexOf(choice) < 0) {
    return { ok: false, error: 'choice must be accept, keep or dismiss' };
  }
  var items = reviewItems_();
  var item = null;
  for (var i = 0; i < items.length; i++) if (items[i].id === id) { item = items[i]; break; }
  if (!item) return { ok: false, error: 'no open review item with that id (already resolved?)' };

  var applied = '';
  if (choice === 'accept') {
    if (item.kind === 'duplicate') {
      var m = mergeEmployees_({ token: p.token, keep: item.employee_id,
                                merge: item.merge_from, confirm: 'yes' });
      if (!m.ok) return m;
      applied = 'merged ' + item.merge_from_name + ' into ' + item.name;
    } else if (item.kind === 'name_spelling' || item.kind === 'role') {
      var field = item.kind === 'role' ? 'role_title' : 'full_name';
      var value = item.proposed_value;
      /* A role proposal comes from outside (an import posts it via review_report), so it can
         name a title we do not carry. Accepting is a WRITE to Core identity and gets the same
         closed set as the roster dropdown — "keep" and "dismiss" are still open, so the item
         can be cleared without widening the vocabulary through the back door. */
      if (field === 'role_title') {
        value = normRole_(value);
        if (!value) {
          return { ok: false, error: 'cannot accept role "' + item.proposed_value + '" — not one of ' +
                                     ROLE_TITLES.join(', ') + '. Keep or dismiss instead.' };
        }
      }
      var identity = GXCore.getEmployees() || [];
      var prior = null;
      for (var z = 0; z < identity.length; z++) {
        if (String(identity[z].employee_id || '').trim() === item.employee_id) { prior = identity[z]; break; }
      }
      if (!prior) return { ok: false, error: 'unknown employee_id: ' + item.employee_id };
      var merged = {};
      Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
      merged[field] = value;
      GXCore.gxUpsertEmployee(merged);
      applied = field + ' → ' + value;
    } else {
      // Compliance items (renew a permit, revoke access, fill a gap) are actioned OUTSIDE this
      // app. Accepting records that it was handled; it does not pretend to have done it.
      applied = 'acknowledged as handled';
    }
  }

  sheetOf_(DECISION_TAB, DECISION_HEADERS).appendRow([
    id, item.kind, item.employee_id, item.field, choice,
    choice === 'accept' ? item.proposed_value : item.current_value,
    auth.user, new Date().toISOString(), applied
  ]);
  bustRosterCache_();
  return { ok: true, id: id, choice: choice, applied: applied };
}

/** Imports post what the engine cannot see (HR sheet / METRC disagreements) into the queue. */
function reportConflicts_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var list = (body && body.conflicts) || [];
  if (!list.length) return { ok: false, error: 'no conflicts in payload' };
  var sh = sheetOf_(REVIEW_TAB, REVIEW_HEADERS);
  // Replace wholesale: these are re-derived by whoever runs the reconciliation, and stale rows
  // would linger forever. Decisions live in the other tab and are unaffected.
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  var now = new Date().toISOString();
  var rows = list.map(function (c) {
    return REVIEW_HEADERS.map(function (h) {
      if (h === 'reported_at') return now;
      if (h === 'review_id') return decisionKey_(c.kind, c.employee_id, c.field, c.proposed_value);
      return String(c[h] == null ? '' : c[h]);
    });
  });
  if (rows.length) sh.getRange(2, 1, rows.length, REVIEW_HEADERS.length).setValues(rows);
  bustRosterCache_();
  return { ok: true, reported: rows.length };
}

// ─── Leaderboard hand-off: nicknames + avatars → Core display fields ────────────
/*
 * Per core-admin (v127) nickname and avatar are CORE display fields, not Crew attributes:
 * Leaderboard reads them from the registry, Crew is the sole writer. This migrates the two
 * ScriptProperty blobs Leaderboard has carried since before the split.
 *
 * THE SEED. A DiceBear avatar is generated from a seed. Leaderboard seeded from the nameKey,
 * which is derived from the person's NAME — so a legal-name change, a nickname change or one of
 * our merges silently regenerates a different face. We therefore stamp `seed` INTO avatar_config,
 * pinned to employee_number (the stable key), so the face survives every rename from here on.
 *
 * Leaderboard's own keying is already inconsistent — it carries avatars under both `zach_r`
 * (a nickname) and `zachary_rodriguez` for the same person. Fuzzy matching resolves those, and
 * anything it cannot resolve is REPORTED rather than guessed.
 */
function migrateLeaderboard_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var nicknames = (body && body.nicknames) || {};
  var avatars   = (body && body.avatarConfigs) || {};
  if (!Object.keys(nicknames).length && !Object.keys(avatars).length) {
    return { ok: false, error: 'payload carried neither nicknames nor avatarConfigs' };
  }
  var dry = String(p.confirm || '') !== 'yes';

  var existing = GXCore.getEmployees() || [];
  var attrs = readAttrs_();
  var byId = {};
  existing.forEach(function (r) { byId[String(r.employee_id || '').trim()] = r; });

  function resolve(k) {
    if (byId[k]) return byId[k];
    // exact nameKey miss — try the same person-matcher the importer uses
    var want = String(k).replace(/_/g, ' ');
    for (var i = 0; i < existing.length; i++) {
      if (samePerson_(want, existing[i].full_name)) return existing[i];
    }
    return null;
  }

  var writes = {}, resolved = [], unmatched = [], collisions = [];

  Object.keys(nicknames).forEach(function (k) {
    var e = resolve(k);
    if (!e) { unmatched.push('nickname ' + k + ' → ' + nicknames[k]); return; }
    var id = String(e.employee_id).trim();
    writes[id] = writes[id] || { employee_id: id };
    writes[id].preferred_name = String(nicknames[k]).trim();
    if (k !== id) resolved.push('nickname ' + k + ' → ' + e.full_name);
  });

  Object.keys(avatars).forEach(function (k) {
    var e = resolve(k);
    if (!e) { unmatched.push('avatar ' + k); return; }
    var id = String(e.employee_id).trim();
    var cfg = avatars[k] || {};
    writes[id] = writes[id] || { employee_id: id };
    if (writes[id].avatar_config) { collisions.push(e.full_name + ' (keys ' + k + ' and another)'); }
    // Pin the seed to employee_number so no future rename can scramble the face. Fall back to
    // employee_id only when a number is genuinely absent.
    var num = String((attrs[id] || {}).employee_number || e.employee_number || '').trim();
    cfg.seed = num || id;
    writes[id].avatar_config = JSON.stringify(cfg);
    if (k !== id) resolved.push('avatar ' + k + ' → ' + e.full_name);
  });

  // Merge onto the live row — gxWrite_ replaces whole rows, so a partial write would blank
  // everything else we have spent this whole session populating.
  var rows = Object.keys(writes).map(function (id) {
    var merged = {};
    Object.keys(byId[id] || {}).forEach(function (kk) { merged[kk] = byId[id][kk]; });
    merged.employee_id = id;
    if (writes[id].preferred_name) merged.preferred_name = writes[id].preferred_name;
    if (writes[id].avatar_config)  merged.avatar_config  = writes[id].avatar_config;
    return merged;
  });

  var out = { ok: true, mode: dry ? 'preview' : 'commit',
              nicknames_in: Object.keys(nicknames).length, avatars_in: Object.keys(avatars).length,
              people_to_write: rows.length, matched_by_fuzzy: resolved,
              unmatched: unmatched, avatar_key_collisions: collisions };
  if (dry) { out.note = 'DRY RUN — nothing written. Repeat with confirm=yes.'; return out; }
  GXCore.gxUpsertEmployees(rows);
  bustRosterCache_();
  out.written = rows.length;
  return out;
}

// ─── Merge (TJ Peterson → Thomas Peterson) ──────────────────────────────────────
/*
 * Duplicates are structural here, not accidental: three systems (Dutchie, METRC, the HR
 * workbook) each spell people their own way, and new hires keep arriving. A one-off cleanup
 * fixes today and gets undone by the next import.
 *
 * So a merge does three things, and the third is the one that makes it stick:
 *   1. moves Crew attributes from the loser onto the winner, FILLING GAPS ONLY — a populated
 *      value on the winner is never overwritten by the duplicate;
 *   2. marks the loser 'merged' in Core so it leaves the roster (nothing is deleted — the row
 *      stays auditable, and un-merging is possible);
 *   3. records the loser's name as an ALIAS, so the next import resolves "TJ Peterson" onto
 *      Thomas Peterson's employee_id instead of creating the duplicate all over again.
 */
function aliasSheet_() {
  var ss = crewSheet_().getParent();
  var sh = ss.getSheetByName(ALIAS_TAB);
  if (!sh) {
    sh = ss.insertSheet(ALIAS_TAB);
    sh.getRange(1, 1, 1, ALIAS_HEADERS.length).setValues([ALIAS_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** { aliasKey → employee_id } for every name that has been merged away. */
function readAliases_() {
  var sh = aliasSheet_();
  var last = sh.getLastRow();
  if (last < 2) return {};
  var v = sh.getRange(2, 1, last - 1, ALIAS_HEADERS.length).getValues();
  var out = {};
  v.forEach(function (r) {
    var k = String(r[0] || '').trim();
    if (k) out[k] = String(r[2] || '').trim();
  });
  return out;
}

function mergeEmployees_(p) {
  // Deploy secret is accepted alongside a user session, so a coordinated cross-app merge can be
  // run from tooling. It still needs confirm=yes — merging identity rows moves payout math.
  var auth = deploySecretOk_(p) ? { ok: true, user: 'tooling', role: 'admin' } : requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var winner = String(p.keep || '').trim();
  var loser  = String(p.merge || '').trim();
  if (!winner || !loser) return { ok: false, error: 'keep and merge employee_ids are both required' };
  if (winner === loser)  return { ok: false, error: 'cannot merge someone into themselves' };

  var identity = GXCore.getEmployees() || [];
  var W = null, L = null;
  identity.forEach(function (r) {
    var id = String(r.employee_id || '').trim();
    if (id === winner) W = r;
    if (id === loser)  L = r;
  });
  if (!W) return { ok: false, error: 'unknown employee_id to keep: ' + winner };
  if (!L) return { ok: false, error: 'unknown employee_id to merge: ' + loser };

  var attrs = readAttrs_();
  var wa = attrs[winner] || {}, la = attrs[loser] || {};
  var merged = { employee_id: winner, name_key: nameToKey_(W.full_name), full_name: String(W.full_name || '') };
  var filled = [];
  ['shirt_size', 'birthday', 'work_anniversary', 'employee_number', 'wage',
   'permit_number', 'permit_granted', 'permit_expires', 'permit_status'].forEach(function (k) {
    var mine = String(wa[k] || '').trim(), theirs = String(la[k] || '').trim();
    merged[k] = mine || theirs;
    if (!mine && theirs) filled.push(k);
  });
  merged.updated_at = new Date().toISOString();
  merged.updated_by = auth.user + ' (merge)';

  // Identity: take the loser's hire_date / dutchie id only where the winner has none.
  var wid = {};
  Object.keys(W).forEach(function (k) { wid[k] = W[k]; });
  var idFilled = [];
  ['hire_date', 'dutchie_employee_id', 'home_store', 'role_title', 'user_id',
   'employee_number', 'preferred_name', 'avatar_config'].forEach(function (k) {
    if (!String(wid[k] || '').trim() && String(L[k] || '').trim()) {
      wid[k] = L[k];
      idFilled.push(k + '=' + L[k]);
    }
  });
  wid.employee_id = winner;

  if (String(p.confirm || '') !== 'yes') {
    return { ok: true, mode: 'preview', keep: winner, keep_name: W.full_name,
             merge: loser, merge_name: L.full_name,
             // Both halves matter: attribute gaps AND the identity columns folded across.
             // Reporting only the first made a merge that DOES move data look like a no-op.
             would_fill_attributes: filled, would_fill_identity: idFilled,
             keeps_dutchie_id: String(wid.dutchie_employee_id || '') || '(none)',
             keeps_user_id: String(wid.user_id || '') || '(none)',
             note: 'DRY RUN — nothing written. Repeat with confirm=yes.' };
  }

  var lid = {};
  Object.keys(L).forEach(function (k) { lid[k] = L[k]; });
  lid.employee_id = loser;
  lid.status = 'merged';

  GXCore.gxUpsertEmployees([wid, lid]);
  writeAttrs_(merged);

  var sh = aliasSheet_();
  sh.appendRow([nameToKey_(L.full_name), String(L.full_name || ''), winner,
                new Date().toISOString(), auth.user]);
  bustRosterCache_();
  return { ok: true, mode: 'merged', keep: winner, keep_name: W.full_name,
           merged_away: L.full_name, filled_attributes: filled, filled_identity: idFilled,
           kept_dutchie_id: String(wid.dutchie_employee_id || '') || '(none)',
           kept_user_id: String(wid.user_id || '') || '(none)' };
}


/*
 * Which cells look wrong or unfinished. Computed server-side so the roster, any future export
 * and the UI all agree on what "questionable" means — and so fixing a value in the UI clears
 * the flag on the next read with no second definition to keep in sync.
 *
 * Only ever flags MISSING or MALFORMED data. It never flags a value merely because it is
 * unusual: a genuinely low wage or an odd shirt size is not an error, and crying wolf on those
 * teaches people to ignore the red.
 */
function rowFlags_(r) {
  var f = [];
  // Checked BEFORE the retired escape hatch: an incomplete retired record is expected, but a
  // record with no NAME is not incomplete, it is damaged — a GX Core row that a partial write
  // blanked. identityRepair_ explains the mechanism and puts it back.
  if (!String(r.name || '').trim()) f.push('name');
  if (r.retired) return f;                       // retired records are allowed to be incomplete
  if (!r.employee_number)          f.push('employee_number');
  if (!r.hire_date)                f.push('hire_date');
  if (!r.store)                    f.push('store');
  if (r.role_is_default)           f.push('role');
  if (!r.wage)                     f.push('wage');
  if (!r.birthday)                 f.push('birthday');
  if (!r.permit_number)            f.push('permit');
  else if (r.permit_days_left != null && r.permit_days_left < 0) f.push('permit_expired');
  if (r.permit_status && ['active', 'valid'].indexOf(String(r.permit_status).toLowerCase()) < 0)
    f.push('permit_status');
  return f;
}

// ─── Roster cache ───────────────────────────────────────────────────────────────
/*
 * GXCore.getEmployees() measured ~9.8s on its own, and the roster also reads Crew's attribute
 * sheet — together comfortably past the 8s JSONP budget in gx-client, so every attempt timed
 * out and the roster never loaded at all. Most of that is fixed overhead (library load +
 * SpreadsheetApp open), not row count, so it does not shrink as we optimise the join.
 *
 * We cache the expensive part — the identity x attributes join — and keep the per-user bits
 * (role, can_edit) outside it, so the cache can never hand one user another user's permissions.
 * Short TTL, and every writer busts it, so an edit is visible immediately rather than up to a
 * minute later.
 */
var ROSTER_CACHE_KEY = 'crew:roster:v1';
var ROSTER_CACHE_TTL = 120;   // seconds

function bustRosterCache_() {
  try { CacheService.getScriptCache().remove(ROSTER_CACHE_KEY); } catch (e) {}
}

function rosterJoin_() {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(ROSTER_CACHE_KEY);
    if (hit) { var o = JSON.parse(hit); o.cached = true; return o; }
  } catch (e) { /* fall through and rebuild */ }

  var identity = [], identityError = '';
  try { identity = GXCore.getEmployees() || []; }
  catch (e) { identityError = String((e && e.message) || e); }

  var attrs = readAttrs_();
  var today = todayInStoreTz_();

  var rows = identity.map(function (r) {
    var id = String(r.employee_id || '').trim();
    var a  = attrs[id] || {};
    var st = String(r.status || 'active').toLowerCase();
    var isRetired = st === 'retired' || st === 'inactive' || st === 'terminated' || st === 'false';
    var isMerged  = st === 'merged';
    var anniv = normDate_(a.work_anniversary) || normDate_(r.hire_date);
    return {
      employee_id: id, name_key: nameToKey_(r.full_name), name: String(r.full_name || ''),
      store: String(r.home_store || ''),
      preferred_name: String(r.preferred_name || ''),
      avatar_config: String(r.avatar_config || ''),
      /* THE AVATAR SEED. DiceBear generates a face from a seed, and Leaderboard historically
         seeded on nameKey — which derives from the NAME, so a rename or one of our merges
         silently produced a different person's face. Pinned to employee_number, which is
         issued once and never reused. employee_id is only a fallback for someone not yet
         numbered; they get a stable face the moment a number is assigned. */
      avatar_seed: String(a.employee_number || r.employee_number || r.employee_id || ''),
      dutchie_employee_id: String(r.dutchie_employee_id || ''),
      user_id: String(r.user_id || ''),
      role: String(r.role_title || '').trim() || 'Budtender',
      role_is_default: !String(r.role_title || '').trim(),
      retired: isRetired, merged: isMerged,
      hire_date: normDate_(r.hire_date),
      time_with_company: timeWithCompany_(normDate_(r.hire_date), today),
      employee_number: a.employee_number || '', wage: a.wage || '',
      shirt_size: normShirt_(a.shirt_size), birthday: normBirthday_(a.birthday),
      work_anniversary: anniv, anniversary_is_override: !!normDate_(a.work_anniversary),
      permit_number: a.permit_number || '', permit_expires: a.permit_expires || '',
      permit_status: a.permit_status || '',
      permit_days_left: a.permit_expires && dateFromIso_(a.permit_expires)
        ? daysBetween_(today, dateFromIso_(a.permit_expires)) : null,
      permit_active: a.permit_status
        ? (['active', 'valid'].indexOf(String(a.permit_status).toLowerCase()) >= 0 ? 'Yes' : 'No')
        : '',
      updated_at: a.updated_at || '', updated_by: a.updated_by || ''
    };
  }).map(function (r) { r.flags = rowFlags_(r); return r; })
    .filter(function (r) { return !r.merged; })
    .sort(function (x, y) { return x.name.localeCompare(y.name); });

  var out = { rows: rows, identityCount: identity.length, identityError: identityError, cached: false };
  // Only cache a good read. Caching an empty result behind a transient GX Core error would
  // serve "you have no staff" for the whole TTL.
  if (!identityError && rows.length) {
    try { cache.put(ROSTER_CACHE_KEY, JSON.stringify(out), ROSTER_CACHE_TTL); } catch (e) {}
  }
  return out;
}

function getRoster_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var joined = rosterJoin_();
  var includeRetired = String(p.include_retired || '') === '1';
  var retiredCount = 0;
  joined.rows.forEach(function (r) { if (r.retired) retiredCount++; });

  return {
    ok: true, user: auth.user, role: auth.role, can_edit: canEdit_(auth),
    shirt_sizes: SHIRT_SIZES, role_titles: ROLE_TITLES, hr_sheet_url: HR_SHEET_URL,
    include_retired: includeRetired, retired_total: retiredCount, cached: joined.cached,
    rows: joined.rows.filter(function (r) { return includeRetired || !r.retired; }),
    identity_source: {
      count: joined.identityCount, error: joined.identityError,
      note: joined.identityCount ? '' :
        'GX Core `employees` is empty — identity has no writer yet (needs core-admin: gxUpsertEmployee + seed). ' +
        'Crew attributes are stored and will join automatically once identity lands.'
    }
  };
}

function dateFromIso_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * "10yr 7mo", matching how the HR sheet already phrases it — managers read this column next to
 * a printout, so the format should not need translating.
 */
function timeWithCompany_(hireIso, today) {
  var d = dateFromIso_(hireIso);
  if (!d) return '';
  var months = (today.getFullYear() - d.getFullYear()) * 12 + (today.getMonth() - d.getMonth());
  if (today.getDate() < d.getDate()) months--;
  if (months < 0) return '';
  return Math.floor(months / 12) + 'yr ' + (months % 12) + 'mo';
}


/**
 * Edit the GX Core identity slice from the roster. Crew is the sole writer up to Core, so this
 * is the only path Mike has for fixing a name, nickname, store, role or hire date.
 *
 * READ-MERGE-WRITE, non-negotiable. gxWrite_ rebuilds the entire row from the record and writes
 * '' for anything absent, so a partial update silently destroys columns this app never shows —
 * dutchie_employee_id (SPIFF and Leaderboard attribution resolve through it) and user_id (the
 * link to the users tab that owns email). core-admin lost these once already and caught it only
 * by diffing all 75 rows. We read the live row, lay changes on top, and write the whole thing back.
 */
var IDENTITY_FIELDS = ['full_name', 'preferred_name', 'home_store', 'role_title', 'hire_date',
                       'avatar_config'];

function saveIdentity_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.employee_id || '').trim();
  if (!id) return { ok: false, error: 'employee_id required' };

  var identity = GXCore.getEmployees() || [];
  var prior = null;
  for (var i = 0; i < identity.length; i++) {
    if (String(identity[i].employee_id || '').trim() === id) { prior = identity[i]; break; }
  }
  if (!prior) return { ok: false, error: 'unknown employee_id: ' + id };

  // Validate before touching anything — a half-applied identity edit is worse than a refusal.
  var changes = {}, touched = [];
  if (p.full_name != null) {
    var nm = String(p.full_name).replace(/\s+/g, ' ').trim();
    if (!nm) return { ok: false, error: 'name cannot be empty' };
    if (nm.indexOf(' ') < 0) return { ok: false, error: 'name should be first and last: "' + nm + '"' };
    changes.full_name = nm;
  }
  if (p.preferred_name != null) changes.preferred_name = String(p.preferred_name).trim();
  if (p.home_store != null) {
    var st = String(p.home_store).trim();
    if (st) {
      var known = (GXCore.getStores() || []).some(function (x) { return String(x.store_id).trim() === st; });
      if (!known && st !== 'corporate') return { ok: false, error: 'unknown store: ' + st };
    }
    changes.home_store = st;
  }
  if (p.role_title != null) {
    var rt = String(p.role_title).replace(/\s+/g, ' ').trim();
    /* The roster sends one of ROLE_TITLES or ''. Anything else reached us around the dropdown,
       so refuse rather than store it — this is the field Leaderboard renders and SPIFF groups by,
       and a one-off variant here becomes an unmatchable role everywhere else.
       The exception is a title this row ALREADY holds: rows predating the vocabulary carry one,
       the panel offers it back unchanged, and refusing it would make every other field on that
       person uneditable until somebody re-filed them. Keeping a value is not introducing one. */
    if (rt && !normRole_(rt) && rt !== String(prior.role_title || '').replace(/\s+/g, ' ').trim()) {
      return { ok: false, error: 'invalid role: ' + rt + ' (expected one of ' + ROLE_TITLES.join(', ') + ')' };
    }
    changes.role_title = rt ? (normRole_(rt) || rt) : '';
  }
  if (p.avatar_config != null) {
    var av = String(p.avatar_config).trim();
    if (av) {
      // Store the config, never a rendered image — Core keeps DiceBear params only.
      try {
        var parsed = JSON.parse(av);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        av = JSON.stringify(parsed);
      } catch (e) {
        return { ok: false, error: 'avatar_config must be a JSON object of DiceBear params' };
      }
    }
    changes.avatar_config = av;
  }
  if (p.hire_date != null) {
    var hd = String(p.hire_date).trim();
    if (hd && !normDate_(hd)) return { ok: false, error: 'invalid hire date: ' + hd + ' (expected YYYY-MM-DD)' };
    changes.hire_date = hd ? normDate_(hd) : '';
  }
  if (!Object.keys(changes).length) return { ok: false, error: 'nothing to change' };

  var merged = {};
  Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });   // <- every column survives
  Object.keys(changes).forEach(function (k) {
    if (String(prior[k] || '') !== String(changes[k])) touched.push(k);
    merged[k] = changes[k];
  });
  merged.employee_id = id;
  GXCore.gxUpsertEmployee(merged);

  // employee_id is derived from the name, so a rename leaves the old key stranded in every
  // other app. Record an alias so imports and lookups keep resolving to this row.
  if (changes.full_name && nameToKey_(prior.full_name) !== nameToKey_(changes.full_name)) {
    sheetOf_(ALIAS_TAB, ALIAS_HEADERS).appendRow([
      nameToKey_(prior.full_name), String(prior.full_name || ''), id,
      new Date().toISOString(), auth.user + ' (rename)'
    ]);
  }

  bustRosterCache_();
  return { ok: true, employee_id: id, changed: touched,
           preserved: ['dutchie_employee_id', 'user_id', 'employee_number', 'avatar_config']
             .filter(function (k) { return String(prior[k] || '').trim(); }) };
}

/**
 * Retire (or un-retire) someone. Status is GX Core identity, not a Crew attribute, so this
 * writes UP to Core — and read-merge-writes for the same reason hrImport_ does: gxWrite_
 * replaces the whole row, and a partial write would blank dutchie_employee_id.
 *
 * Nothing is deleted. Retired staff keep their attributes, their permit history and their
 * employee number; they simply drop out of the default roster view.
 */
function setRetired_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.employee_id || '').trim();
  if (!id) return { ok: false, error: 'employee_id required' };
  var retire = String(p.retired || '') !== '0';

  var identity = GXCore.getEmployees() || [];
  var prior = null;
  for (var i = 0; i < identity.length; i++) {
    if (String(identity[i].employee_id || '').trim() === id) { prior = identity[i]; break; }
  }
  if (!prior) return { ok: false, error: 'unknown employee_id: ' + id };

  var merged = {};
  Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
  merged.employee_id = id;
  merged.status = retire ? 'retired' : 'active';
  GXCore.gxUpsertEmployee(merged);
  bustRosterCache_();
  return { ok: true, employee_id: id, status: merged.status, by: auth.user };
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
  var wage = String(p.wage == null ? '' : p.wage).trim();
  if (wage && !/^\$?\s*\d{1,3}(\.\d{1,2})?$/.test(wage)) {
    return { ok: false, error: 'invalid wage: ' + wage + ' (expected an hourly rate like 17.50)' };
  }
  // employee_number is issued by assignNumbers_, never typed: it is the key the whole suite
  // joins on, and a hand-entered collision would attach one person's history to another.
  if (p.employee_number != null) {
    return { ok: false, error: 'employee_number is assigned automatically and cannot be edited' };
  }
  var shirt = String(p.shirt_size == null ? '' : p.shirt_size).trim();
  if (shirt && !normShirt_(shirt)) return { ok: false, error: 'invalid shirt_size: ' + shirt + ' (expected one of ' + SHIRT_SIZES.join(', ') + ')' };
  var bday = String(p.birthday == null ? '' : p.birthday).trim();
  if (bday && !normBirthday_(bday)) return { ok: false, error: 'invalid birthday: ' + bday + ' (expected MM-DD)' };
  var anniv = String(p.work_anniversary == null ? '' : p.work_anniversary).trim();
  if (anniv && !normDate_(anniv)) return { ok: false, error: 'invalid work_anniversary: ' + anniv + ' (expected YYYY-MM-DD)' };
  var pexp = String(p.permit_expires == null ? '' : p.permit_expires).trim();
  if (pexp && !normDate_(pexp)) return { ok: false, error: 'invalid permit expiry: ' + pexp + ' (expected YYYY-MM-DD)' };

  var existing = readAttrs_()[id] || {};
  var rec = {
    employee_id:      id,
    name_key:         nameToKey_(match.full_name),
    full_name:        String(match.full_name || ''),
    // Absent field = leave alone; empty string = explicit clear. Lets the UI PATCH one cell.
    shirt_size:       p.shirt_size       == null ? (existing.shirt_size       || '') : normShirt_(shirt),
    birthday:         p.birthday         == null ? (existing.birthday         || '') : normBirthday_(bday),
    work_anniversary: p.work_anniversary == null ? (existing.work_anniversary || '') : normDate_(anniv),
    employee_number:  existing.employee_number || '',
    wage:             p.wage             == null ? (existing.wage             || '') : wage.replace(/^\$\s*/, ''),
    // METRC stays the source of truth — an import overwrites these whenever it carries a value.
    // But 7 active staff have no permit on file at all, and a human who can read the permit
    // should be able to type it in rather than wait for the next export.
    permit_number:    p.permit_number  == null ? (existing.permit_number  || '') : String(p.permit_number).trim(),
    permit_granted:   existing.permit_granted || '',
    permit_expires:   p.permit_expires == null ? (existing.permit_expires || '') : (normDate_(String(p.permit_expires).trim()) || ''),
    permit_status:    p.permit_expires != null && String(p.permit_expires).trim() && !existing.permit_status
                        ? 'Active' : (existing.permit_status || ''),
    updated_at:       new Date().toISOString(),
    updated_by:       String(auth.user || '')
  };
  writeAttrs_(rec);
  bustRosterCache_();
  return { ok: true, employee_id: id, saved: rec };
}


// ─── HR import (staff sheet + METRC permits → Core identity + Crew attributes) ───
/*
 * One reconciled payload in, two destinations out:
 *   • GX Core identity — full_name, home_store, role_title, status, hire_date
 *   • Crew attributes  — employee_number, wage, shirt_size, birthday, permit_*
 *
 * Two things this must get right, both learned the hard way:
 *
 * 1. gxWrite_ REPLACES the whole row. It rebuilds every column from the record, so any field
 *    absent from the payload is written as ''. A naive partial upsert silently wipes
 *    dutchie_employee_id and user_id — the very columns that let SPIFF and Leaderboard join.
 *    So we read the existing row and merge onto it, and never overwrite a populated value
 *    with an empty one.
 *
 * 2. Names drift between sources. The registry was seeded from Dutchie ("Skyler Poteet"); the
 *    HR sheet says "Poteet, Skylar". Keying purely on nameKey would append a SECOND row for the
 *    same person. So we match against the existing registry first — exact key, then fuzzy — and
 *    reuse whatever employee_id is already there.
 */

/** Nicknames seen across Dutchie / METRC / the HR sheet. Explicit and reviewable, not guessed. */
var NICKNAMES = { mike: 'michael', zach: 'zachary', chris: 'christopher', sam: 'samuel',
                  jon: 'jonathan', nick: 'nicholas', dan: 'daniel', matt: 'matthew',
                  jen: 'jennifer', tanner: 'taner', sky: 'skyler', skylar: 'skyler',
                  bob: 'robert', rob: 'robert', tom: 'thomas' };

function canonFirst_(f) {
  var x = String(f || '').toLowerCase().replace(/[^a-z]/g, '');
  return NICKNAMES[x] || x;
}
function ratio_(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  var m = 0, used = {};
  for (var i = 0; i < a.length; i++) {
    for (var j = 0; j < b.length; j++) {
      if (!used[j] && a[i] === b[j]) { used[j] = 1; m++; break; }
    }
  }
  return (2 * m) / (a.length + b.length);
}
function nameParts_(full) {
  var t = String(full || '').trim().split(/\s+/);
  return { first: t[0] || '', last: t.length > 1 ? t[t.length - 1] : '' };
}

/** Same human seen from two systems that disagree on spelling or nickname? */
function samePerson_(fullA, fullB) {
  var a = nameParts_(fullA), b = nameParts_(fullB);
  var af = canonFirst_(a.first), bf = canonFirst_(b.first);
  var al = String(a.last).toLowerCase().replace(/[^a-z]/g, '');
  var bl = String(b.last).toLowerCase().replace(/[^a-z]/g, '');
  if (!al || !bl) return false;
  var firstOk = af === bf || af.indexOf(bf.slice(0, 3)) === 0 || bf.indexOf(af.slice(0, 3)) === 0
                || ratio_(af, bf) >= 0.8;
  if (!firstOk) return false;
  return al === bl || al.indexOf(bl) >= 0 || bl.indexOf(al) >= 0 || ratio_(al, bl) >= 0.85;
}

function hrImport_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var list = (body && body.employees) || [];
  if (!list.length) return { ok: false, error: 'no employees in payload' };
  var dry = String(p.confirm || '') !== 'yes';
  var overwrite = String(p.mode || '') === 'overwrite';

  var existing = [];
  try { existing = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: 'could not read GX Core identity: ' + String((e && e.message) || e) }; }

  var attrs = readAttrs_();
  var aliases = readAliases_();
  var idRows = [], attrRows = [], renamed = [], created = [], viaAlias = [], skippedRoles = [];

  list.forEach(function (r) {
    var full = String(r.full_name || '').trim();
    if (!full) return;
    var key = nameToKey_(full);

    var prior = null;
    // A previous merge wins over everything: if this name was merged away, it resolves to the
    // person it was merged into, and the duplicate is never recreated.
    var aliasTarget = aliases[key];
    if (aliasTarget) {
      for (var z = 0; z < existing.length; z++) {
        if (String(existing[z].employee_id || '').trim() === aliasTarget) { prior = existing[z]; break; }
      }
      if (prior) viaAlias.push(full + '  →  ' + prior.full_name);
    }
    if (!prior) {
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i].employee_id || '').trim() === key) { prior = existing[i]; break; }
      }
    }
    if (!prior) {
      for (var j = 0; j < existing.length; j++) {
        if (samePerson_(full, existing[j].full_name)) { prior = existing[j]; break; }
      }
      if (prior) renamed.push(prior.full_name + '  →  ' + full + '  (kept id ' + prior.employee_id + ')');
    }
    if (!prior) created.push(full);

    var id = prior ? String(prior.employee_id).trim() : key;

    // Merge onto the existing row: never blank a populated Core field with an empty payload value.
    var merged = {};
    if (prior) Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
    merged.employee_id = id;
    ['full_name', 'home_store', 'role_title', 'status', 'hire_date', 'employee_number'].forEach(function (k) {
      var v = String(r[k] == null ? '' : r[k]).trim();
      /* A title the sheet spells its own way maps onto one of the four; one that maps to nothing
         is skipped, not written. The sheet is history and cannot widen the vocabulary. */
      if (k === 'role_title' && v !== '') {
        v = normRole_(v);
        if (!v) { skippedRoles.push(full + ': ' + String(r[k]).trim()); return; }
      }
      if (v === '') return;
      // FILL mode: never overturn a value the roster already holds. Crew is the system of
      // record now, so an import can complete it but not contradict it.
      if (!overwrite && String(merged[k] || '').trim() !== '') return;
      merged[k] = v;
    });
    idRows.push(merged);

    var was = attrs[id] || {};
    var a = { employee_id: id, name_key: key, full_name: full };
    ['shirt_size', 'birthday', 'work_anniversary', 'employee_number', 'wage',
     'permit_number', 'permit_granted', 'permit_expires', 'permit_status'].forEach(function (k) {
      var v = String(r[k] == null ? '' : r[k]).trim();
      if (k === 'birthday') v = normBirthday_(v);
      if (k === 'shirt_size') v = normShirt_(v) || (was[k] || '');
      var current = String(was[k] || '').trim();
      a[k] = (!overwrite && current !== '') ? current : (v !== '' ? v : current);
    });
    a.updated_at = new Date().toISOString();
    a.updated_by = 'hr-import';
    attrRows.push(a);
  });

  var summary = {
    ok: true, mode: dry ? 'preview' : 'commit',
    write_mode: overwrite ? 'OVERWRITE (contradicts the roster)' : 'fill-only (never overturns a held value)',
    incoming: list.length,
    matched_existing: idRows.length - created.length,
    would_create: created.length, created_names: created.slice(0, 40),
    matched_despite_name_drift: renamed, matched_via_merge_alias: viaAlias,
    // Named, never silent: a title the sheet holds that is not one of the four was dropped,
    // and somebody has to decide which of the four that person actually is.
    skipped_unknown_roles: skippedRoles,
    active: idRows.filter(function (r) { return String(r.status).toLowerCase() !== 'retired'; }).length,
    retired: idRows.filter(function (r) { return String(r.status).toLowerCase() === 'retired'; }).length,
    with_permit: attrRows.filter(function (r) { return r.permit_number; }).length,
    with_wage: attrRows.filter(function (r) { return r.wage; }).length,
    with_employee_number: attrRows.filter(function (r) { return r.employee_number; }).length
  };
  if (dry) { summary.note = 'DRY RUN — nothing written. Repeat with confirm=yes.'; return summary; }

  GXCore.gxUpsertEmployees(idRows);
  attrRows.forEach(writeAttrs_);
  bustRosterCache_();
  summary.identity_written = idRows.length;
  summary.attributes_written = attrRows.length;
  return summary;
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
  ['Assistant Store Managers', 'Assistant Manager'],
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

  var list = dutchieEmployeeList_(stores, errors);
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

/**
 * Dutchie's employee list, fetched ONCE. The endpoint returns the same company-wide list from
 * every store, so we try each store only until one answers — a second success would just be the
 * same rows again.
 */
function dutchieEmployeeList_(stores, errors) {
  var list = null;
  for (var i = 0; i < stores.length && !list; i++) {
    var dn = String(stores[i].dutchie_name || '').trim();
    if (!dn) continue;
    try { list = GXCore.dutchieEmployees(dn) || []; }
    catch (e) { if (errors) errors.push(String(stores[i].store_id) + ': ' + String((e && e.message) || e)); }
  }
  return list;
}

/**
 * Does Dutchie already carry usable OLCC permit data? Its employee payload has `stateId` and
 * `mmjExpiration`, which LOOK like permit number + expiry. Before pursuing Metrc API access
 * (which needs an integrator key Metrc only issues after an application), it is worth measuring
 * whether the data we already have is populated and current enough to do the job.
 *
 * COVERAGE ONLY — counts and expiry buckets. A worker permit number is a government ID; this
 * never returns one, and never returns a name alongside a date.
 */
function permitCoverage_() {
  var errors = [];
  var stores = GXCore.getStores() || [];
  var list = dutchieEmployeeList_(stores, errors);
  if (!list) return { ok: false, error: 'could not read Dutchie employees', store_errors: errors };

  var today = todayInStoreTz_();
  var seen = 0, active = 0, withId = 0, withExp = 0, unparseableExp = 0;
  var buckets = { expired: 0, within_30d: 0, within_90d: 0, beyond_90d: 0 };

  list.forEach(function (r) {
    seen++;
    if (storeToken_(pick_(r, ['status'])) !== 'active') return;
    active++;

    if (pick_(r, ['stateId'])) withId++;

    var raw = pick_(r, ['mmjExpiration']);
    if (!raw) return;
    withExp++;
    var d = new Date(raw);
    if (isNaN(d.getTime())) { unparseableExp++; return; }
    var days = daysBetween_(today, new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    if (days < 0)        buckets.expired++;
    else if (days <= 30) buckets.within_30d++;
    else if (days <= 90) buckets.within_90d++;
    else                 buckets.beyond_90d++;
  });

  return {
    ok: true, rows_seen: seen, active_people: active,
    with_state_id: withId, with_expiration: withExp,
    unparseable_expiration: unparseableExp,
    expiry_buckets: buckets,
    coverage_pct: active ? Math.round(withId / active * 100) : 0,
    note: 'stateId/mmjExpiration are Dutchie-entered fields, NOT synced from Metrc. Treat coverage ' +
          'as a measure of how well staff keep Dutchie current, not as authoritative OLCC data.'
  };
}

/** Which script properties exist, how big they are, and (for JSON blobs) how many entries. */
function propsInspect_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var out = Object.keys(props).sort().map(function (k) {
    var v = String(props[k] == null ? '' : props[k]);
    var row = { key: k, length: v.length };
    // Report SHAPE, never content — several of these are secrets.
    if (v.charAt(0) === '{' || v.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(v);
        row.json = true;
        row.entries = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
        var keys = Array.isArray(parsed) ? [] : Object.keys(parsed).slice(0, 3);
        if (keys.length) row.sample_keys = keys;
      } catch (e) { row.json = false; }
    }
    return row;
  });
  return { ok: true, count: out.length, properties: out };
}

/** What GX Core actually holds now — aggregate only, so this never leaks a roster. */
function identityHealth_() {
  var rows = [];
  try { rows = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  var byStore = {}, byRole = {}, missingStore = 0, missingDutchieId = 0, merged = 0, retired = 0;
  rows.forEach(function (r) {
    // Merged and retired rows stay in the sheet for audit, but counting them in the live role
    // spread reads as "7 store managers for 6 stores" and sends you looking for a bug.
    var st = String(r.status || '').toLowerCase();
    if (st === 'merged')  { merged++;  return; }
    if (st === 'retired') { retired++; return; }
    var st = String(r.home_store || '').trim() || '(none)';
    if (st === '(none)') missingStore++;
    byStore[st] = (byStore[st] || 0) + 1;
    var ro = String(r.role_title || '').trim() || '(none)';
    byRole[ro] = (byRole[ro] || 0) + 1;
    if (!String(r.dutchie_employee_id || '').trim()) missingDutchieId++;
  });

  var probe = rows[0] || {};
  var lib = {
    roleCanEdit:          typeof GXCore.roleCanEdit === 'function',
    getEmployeeByNumber:  typeof GXCore.getEmployeeByNumber === 'function',
    getEmployeeByDutchieId: typeof GXCore.getEmployeeByDutchieId === 'function',
    getEmployeeByName:    typeof GXCore.getEmployeeByName === 'function',
    // EoM history reads cfg.eom back through this; without it the log cannot record a pick.
    getKv:                typeof GXCore.getKv === 'function',
    columns: Object.keys(probe).sort()
  };
  return {
    ok: true, total: rows.length, merged: merged, retired: retired,
    active: rows.length - merged - retired, library: lib,
    with_employee_number: rows.filter(function (r) { return String(r.employee_number || '').trim(); }).length,
    with_preferred_name:  rows.filter(function (r) { return String(r.preferred_name || '').trim(); }).length,
    with_avatar:          rows.filter(function (r) { return String(r.avatar_config || '').trim(); }).length,
    by_store: byStore, by_role: byRole,
    missing_home_store: missingStore, missing_dutchie_id: missingDutchieId,
    with_hire_date: rows.filter(function (r) { return String(r.hire_date || '').trim(); }).length
  };
}

/*
 * Puts a BLANKED identity row back together.
 *
 * The damage signature is a GX Core employee row that still has its employee_id and is still
 * "active", but holds nothing else — no name, no store, no role, no dutchie id. In the roster
 * that renders as a person with a face and no details, which is exactly how it was found.
 *
 * The mechanism is the one hr_import already guards against, arriving from another app:
 * gxWrite_ REPLACES the whole row, rebuilding every column from the record it is handed, so an
 * upsert of { employee_id, avatar_config } writes '' over everything it did not mention. Crew's
 * own writers (saveIdentity_, avatarSave_, hrImport_) all read-merge-write and cannot do this;
 * a partial upsert from outside Crew can, and did.
 *
 * Two sources still hold the truth, neither of which the wipe touched:
 *   • Crew's attribute sheet — full_name and employee_number, kept independently of Core
 *   • Dutchie — home_store, role_title and dutchie_employee_id, re-derived exactly as the seed
 *     derives them, so a repaired row is identical to a freshly seeded one
 *
 * FILL ONLY, for the same reason hr_import is: a field is written only where Core currently
 * holds nothing, so a repair can complete a row but never contradict a curated value. hire_date
 * has no machine source at all (Dutchie carries none) and is reported as still empty for a human
 * to fill rather than guessed at.
 *
 * SUPPLYING WHAT NO MACHINE SOURCE HAS. Some fields cannot be re-derived by anyone: hire_date
 * exists in no system Crew can read, and home_store is genuinely ambiguous for the managers who
 * hold permissions at several stores — the seed refuses to guess between them, correctly. Pass
 * those as parameters alongside employee_id and they are treated as the highest-priority source,
 * still FILL-ONLY, so this stays a repair and never becomes a back door for editing a live value.
 * Ordinary identity edits belong in the UI, where they are attributable to a signed-in person.
 *
 * Preview by default. Pass confirm=yes to write, employee_id=<id> to look at one row.
 */
function identityRepair_(p) {
  var only   = String(p.employee_id || '').trim();
  var commit = String(p.confirm || '') === 'yes';

  // Values a human supplies for this one row. Validated up front: a repair that half-applies,
  // or that writes an unknown store into the registry six apps read, is worse than a refusal.
  var GIVEN_FIELDS = ['full_name', 'home_store', 'role_title', 'preferred_name', 'hire_date'];
  var given = {};
  GIVEN_FIELDS.forEach(function (k) { if (p[k] != null) given[k] = String(p[k]).trim(); });
  if (Object.keys(given).length && !only) {
    return { ok: false, error: 'supplying a value needs an employee_id — a repair fills one named row' };
  }
  if (given.home_store) {
    var known = (GXCore.getStores() || []).some(function (x) {
      return String(x.store_id).trim() === given.home_store;
    });
    if (!known && given.home_store !== 'corporate') {
      return { ok: false, error: 'unknown store: ' + given.home_store };
    }
  }
  if (given.hire_date) {
    var hd = normDate_(given.hire_date);
    if (!hd) return { ok: false, error: 'invalid hire date: ' + given.hire_date + ' (expected YYYY-MM-DD)' };
    given.hire_date = hd;
  }

  var live = [];
  try { live = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  var damaged = live.filter(function (r) {
    if (String(r.status || '').toLowerCase() === 'merged') return false;
    if (only) return String(r.employee_id || '').trim() === only;
    return !String(r.full_name || '').trim();
  });
  if (!damaged.length) {
    return { ok: true, mode: 'preview', damaged: 0, repaired: [],
             note: only ? 'no live row with employee_id ' + only
                        : 'every identity row still has its name' };
  }

  var attrs = readAttrs_();
  var seed = {}, seedError = '';
  try {
    buildIdentityRows_().rows.forEach(function (r) { seed[r.employee_id] = r; });
  } catch (e) { seedError = String((e && e.message) || e); }

  var REFILL = ['full_name', 'home_store', 'role_title', 'preferred_name', 'hire_date',
                'dutchie_employee_id', 'employee_number', 'status'];
  var report = [];

  damaged.forEach(function (row) {
    var id = String(row.employee_id || '').trim();
    var a  = attrs[id] || {};
    var d  = seed[id]  || {};
    var source = {
      full_name:           given.full_name  || a.full_name || d.full_name || '',
      home_store:          given.home_store || d.home_store || '',
      role_title:          given.role_title || d.role_title || '',
      preferred_name:      given.preferred_name || '',
      // No machine anywhere holds a hire date: Dutchie carries none, and Crew's attribute sheet
      // stores work_anniversary rather than the date itself. A human is the only source.
      hire_date:           given.hire_date  || '',
      dutchie_employee_id: d.dutchie_employee_id || '',
      // Crew's attribute sheet is where a number is ISSUED, so it is authoritative here and the
      // Core column is only a mirror of it — but SPIFF and Leaderboard read that mirror.
      employee_number:     a.employee_number || '',
      status:              d.status || 'active'
    };

    var merged = {}, filled = [], stillEmpty = [];
    Object.keys(row).forEach(function (k) { merged[k] = row[k]; });   // <- every column survives
    merged.employee_id = id;
    REFILL.forEach(function (k) {
      if (String(merged[k] || '').trim()) return;      // fill only
      var v = String(source[k] || '').trim();
      if (!v) { stillEmpty.push(k); return; }
      merged[k] = v;
      filled.push(k + ' = ' + v);
    });

    if (commit && filled.length) GXCore.gxUpsertEmployee(merged);

    report.push({
      employee_id: id,
      employee_number: a.employee_number || '',
      name_source: a.full_name ? 'crew attributes' : (d.full_name ? 'dutchie' : '(none — cannot name this row)'),
      filled: filled,
      still_empty: stillEmpty,
      /* Crew's attribute sheet is a SEPARATE store and a wipe of the Core row cannot touch it.
         Saying which of those fields are on file — presence only, never the values, because
         wage and birthday are exactly the PII this channel should not be shipping — is what
         distinguishes "the wipe took this" from "nobody ever filled it in". */
      attributes_on_file: ['employee_number', 'wage', 'shirt_size', 'birthday',
                           'work_anniversary', 'permit_number'].reduce(function (o, k) {
        o[k] = !!String(a[k] || '').trim(); return o;
      }, {}),
      // The seed is stamped into avatar_config and pinned to employee_number, so a repaired
      // person keeps the same face they had before the wipe.
      keeps_avatar: !!String(row.avatar_config || '').trim()
    });
  });

  if (commit) bustRosterCache_();
  return { ok: true, mode: commit ? 'commit' : 'preview',
           damaged: damaged.length, dutchie_error: seedError, repaired: report,
           note: commit ? 'written to GX Core' : 're-run with confirm=yes to write' };
}

// ─── Employee of the Month history ──────────────────────────────────────────────
/*
 * Crew keeps the record of who has held EoM. GX Core's cfg.eom holds only the CURRENT holder —
 * one object, overwritten on every pick — so by the time you want to know who had it in March,
 * March is gone. That is fine for Core and for the kiosk, which only ever ask "who is it now",
 * and wrong for HR, which is the one party that needs the series.
 *
 * WHERE THE LOG COMES FROM, and why it is not written where the pick is made. The pick goes
 * straight from the browser to GX Core (GXCore set_eom), deliberately — it needed no engine
 * change and no library re-pin. So the Crew engine never sees the write. Rather than add a
 * second client-side write that could fail on its own and silently lose a reign, the engine
 * READS cfg.eom back with GXCore.getKv and appends whenever the live value differs from the
 * newest row it already has. The browser never supplies the values, so it cannot falsify them.
 *
 * That reconciliation runs on every read of this tab, which has a useful consequence: a change
 * made outside Crew entirely still lands in the history the next time somebody opens the tab.
 * Its one blind spot is honest and worth stating — two changes between two reads leave the
 * middle holder unrecorded. For a monthly award picked by a handful of managers that is a trade
 * worth making against a write path that can half-succeed.
 *
 * APPEND-ONLY. A reign's end is the next reign's start, so nothing is ever edited; a blank
 * employee_id is the "deliberately nobody" row, carrying the same meaning as the empty value
 * Core stores when the award is cleared.
 */

/*
 * The log's own sheet. started_at and recorded_at are pinned to PLAIN TEXT for the reason the
 * roster's employee_number and birthday are: Sheets coerces anything date-shaped, and a coerced
 * cell reads back as "Sun Mar 01 2026 …" rather than the ISO string this file compares and sorts
 * on. Every ordering decision here is a string compare, so the format is load-bearing.
 */
function eomSheet_() {
  var sh = sheetOf_(EOM_TAB, EOM_HEADERS);
  try {
    sh.getRange('C:C').setNumberFormat('@');
    sh.getRange('E:E').setNumberFormat('@');
  } catch (e) { /* formatting is a nicety; never fail a write over it */ }
  return sh;
}

/** cfg.eom, normalised. undefined = never set, null = deliberately nobody, else the holder. */
function eomCurrent_() {
  var raw;
  try { raw = GXCore.getKv('cfg.eom'); }
  catch (e) { return { error: String((e && e.message) || e) }; }
  if (raw === null || raw === undefined) return { state: 'unset' };
  if (String(raw).trim() === '') return { state: 'nobody' };
  var v;
  try { v = (typeof raw === 'object') ? raw : JSON.parse(raw); }
  catch (e) { return { error: 'cfg.eom is not JSON: ' + String(raw).slice(0, 80) }; }
  var id = String((v && v.employee_id) || '').trim();
  if (!id) return { state: 'nobody' };
  return { state: 'held', employee_id: id,
           since: String((v && v.since) || ''), set_by: String((v && v.set_by) || '') };
}

/**
 * Bring the log level with cfg.eom, appending at most one row. Returns the rows, oldest first.
 *
 * Identity of a reign is (employee_id, started_at): the same person picked again after somebody
 * else held it is a NEW reign and gets its own row, while re-reading an unchanged value appends
 * nothing however many times the tab is opened.
 */
function eomSync_(names) {
  var rows = readTab_(EOM_TAB, EOM_HEADERS);
  var cur  = eomCurrent_();
  if (cur.error || cur.state === 'unset') return { rows: rows, error: cur.error || '' };

  var last = rows.length ? rows[rows.length - 1] : null;
  var wantId = cur.state === 'nobody' ? '' : cur.employee_id;
  /* A cleared award has no timestamp of its own — Core stores an empty VALUE, which cannot carry
     one — so a clear is deduped on "the log already ends in a clear" rather than on its time,
     and its recorded_at is when Crew first saw it rather than when it happened. */
  var same = last && String(last.employee_id) === wantId &&
             (wantId === '' || String(last.started_at) === String(cur.since || ''));
  if (same) return { rows: rows, error: '' };

  var now = new Date().toISOString();
  var startedAt = wantId ? String(cur.since || now) : now;
  /* The log is a timeline, so it must not be able to step backwards. cfg.eom's `since` is
     stamped by GX Core and a clear is stamped here, so clock skew between the two — or a
     hand-edited cfg.eom — could otherwise seat a reign before the one it replaces, and the tab
     would show somebody's month ending before it began. ISO-8601 in UTC sorts lexicographically,
     which is why a plain string compare is the right one. */
  if (last && last.started_at && startedAt < String(last.started_at)) {
    startedAt = String(last.started_at);
  }
  var name = wantId ? String((names || {})[wantId] || '') : '';
  var setBy = wantId ? String(cur.set_by || '') : '';
  eomSheet_().appendRow([wantId, name, startedAt, setBy, now, 'observed']);
  rows.push({ employee_id: wantId, name: name, started_at: startedAt,
              set_by: setBy, recorded_at: now, source: 'observed' });
  return { rows: rows, error: '' };
}

/**
 * The history, newest first, each reign carrying the moment it ended.
 *
 * Names are stored WITH the row and only refreshed from the registry where the row has none.
 * Someone who has since been renamed, retired or merged away still held it under the name they
 * held it under, and a log that quietly restates the present is not a record of the past.
 */
function getEomHistory_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var names = {};
  try {
    (GXCore.getEmployees() || []).forEach(function (r) {
      names[String(r.employee_id || '').trim()] = String(r.full_name || '');
    });
  } catch (e) { /* a name lookup failure must not cost us the log */ }

  var synced = eomSync_(names);
  var rows = synced.rows;

  var out = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    out.push({
      employee_id: r.employee_id,
      name: r.name || names[r.employee_id] || '',
      started_at: r.started_at,
      // The reign ended when the next one began; the newest row is still running.
      ended_at: i < rows.length - 1 ? rows[i + 1].started_at : '',
      set_by: r.set_by,
      current: i === rows.length - 1,
      nobody: !r.employee_id,
      // Observed from cfg.eom, or entered by hand for a month that predates the log.
      backfilled: r.source === 'backfill'
    });
  }
  return { ok: true, history: out, sync_error: synced.error || '' };
}

/*
 * Enter reigns that predate the log.
 *
 * The engine can only observe what cfg.eom holds, and cfg.eom holds one value — so every month
 * before Crew started watching is gone from the machine and survives only in somebody's memory.
 * That is not a reason to leave the record starting in August; it is a reason to let a human put
 * the earlier months in, and to mark them as what they are.
 *
 * Rows land with source='backfill', which the tab renders as "recorded" rather than passing them
 * off as observed. A month is the granularity the record actually has — nobody remembers which
 * Tuesday — so a backfilled reign starts on the 1st, the day is nominal, and the tab shows month
 * and year only, which is the truth about how precise this is.
 *
 * DEDUPED ON (employee_id, month), not on the exact timestamp, for the same reason: re-running
 * this must not seat a second August beside the one already observed, even though the observed
 * one starts on the 20th.
 *
 * The tab is re-sorted by started_at afterwards. eomSync_ compares against the LAST row to decide
 * whether cfg.eom has moved on, so a history appended out of order would make it think the award
 * had changed hands every time anybody opened the tab.
 */
function eomBackfill_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var want = (body && body.rows) || null;
  if (!want && p.rows) { try { want = JSON.parse(p.rows); } catch (e) { want = null; } }
  if (!Array.isArray(want) || !want.length) {
    return { ok: false, error: 'rows required: [{ employee_id, started_at }, …]' };
  }

  var known = {};
  try {
    (GXCore.getEmployees() || []).forEach(function (r) {
      known[String(r.employee_id || '').trim()] = String(r.full_name || '');
    });
  } catch (e) { return { ok: false, error: 'could not read the registry: ' + String((e && e.message) || e) }; }

  // Validate the WHOLE batch before writing any of it — a half-entered history is worse than a
  // refusal, because the gap looks like a month nobody held it.
  var plan = [];
  for (var i = 0; i < want.length; i++) {
    var id = String((want[i] && want[i].employee_id) || '').trim();
    var at = String((want[i] && want[i].started_at) || '').trim();
    if (!id) return { ok: false, error: 'row ' + (i + 1) + ': employee_id required' };
    // Someone who held it and has since retired or been merged away still held it, so any status
    // is acceptable — but the id must be a real person, not a typo that logs a reign to nobody.
    if (!(id in known)) return { ok: false, error: 'row ' + (i + 1) + ': unknown employee_id ' + id };
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) {
      return { ok: false, error: 'row ' + (i + 1) + ': started_at must be a full ISO timestamp, got "' + at + '"' };
    }
    plan.push({ employee_id: id, name: known[id], started_at: at, month: at.slice(0, 7) });
  }

  /*
   * REFUSE TO BACKFILL THE MONTH THAT IS CURRENTLY RUNNING. cfg.eom is live and eomSync_ will
   * record it with its real timestamp the next time anybody opens the tab; entering it by hand
   * first seats a second row for the same person in the same month, because the two disagree on
   * the day and observation is deliberately exact where memory is not. Backfill is for months
   * the log could never have seen, and the running one is not that.
   */
  var cur = eomCurrent_();
  if (cur.state === 'held' && cur.since) {
    var liveMonth = String(cur.since).slice(0, 7);
    for (var j = 0; j < plan.length; j++) {
      if (plan[j].month === liveMonth) {
        return { ok: false, error: plan[j].month + ' is the month currently held by ' +
          (known[cur.employee_id] || cur.employee_id) + ' — it will record itself. ' +
          'Backfill only months that ended before the log started.' };
      }
    }
  }

  var have = {};
  readTab_(EOM_TAB, EOM_HEADERS).forEach(function (r) {
    have[r.employee_id + '|' + String(r.started_at).slice(0, 7)] = true;
  });

  if (String(p.confirm || '') !== 'yes') {
    return { ok: true, mode: 'preview', would_add: plan.filter(function (x) {
      return !have[x.employee_id + '|' + x.month]; }),
      already_logged: plan.filter(function (x) { return have[x.employee_id + '|' + x.month]; })
        .map(function (x) { return x.month + ' ' + x.name; }),
      note: 're-run with confirm=yes to write' };
  }

  var sh = eomSheet_();
  var now = new Date().toISOString();
  var added = [], skipped = [];
  plan.forEach(function (x) {
    var key = x.employee_id + '|' + x.month;
    if (have[key]) { skipped.push(x.month + ' ' + x.name); return; }
    have[key] = true;
    sh.appendRow([x.employee_id, x.name, x.started_at, '', now, 'backfill']);
    added.push(x.month + ' ' + x.name);
  });

  var last = sh.getLastRow();
  if (last > 2) sh.getRange(2, 1, last - 1, EOM_HEADERS.length).sort({ column: 3, ascending: true });

  return { ok: true, mode: 'commit', added: added, skipped_already_logged: skipped };
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
