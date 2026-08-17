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

/** Writes need a manager-grade grant; a plain viewer can read the roster but not edit it. */
function canEdit_(auth) {
  var role = String((auth && auth.role) || '').toLowerCase();
  return role === 'admin' || role === 'director' || role === 'manager';
}

/** The deploy secret gates the machine-to-machine celebrations feed (no user session involved). */
function deploySecretOk_(p) {
  var expected = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  return !!expected && String(p.secret || '') === expected;
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
