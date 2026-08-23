#!/usr/bin/env node
/* ─── Crew identity + date invariants — tests ─────────────────────────────────────────────────────
 *
 *   RUN:  node tests/identity_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY THESE FOUR
 * Crew owns payroll and PII, and each of these is a documented invariant whose failure is silent:
 *
 *   nameToKey_             the key the whole suite joins people on. Drift here does not error — it
 *                          detaches a person from their own record.
 *   normDate_              "Dates are TEXT (YYYY-MM-DD)" is the suite's hardest rule; a Date object
 *                          crossing a sheet/script timezone boundary shifts a day and corrupts
 *                          hire dates and pay-period alignment.
 *   normBirthday_          must DISCARD the year. Crew publishes a celebrations feed to the kiosk
 *                          and raw DOB must never leave this app. A regression here is a PII leak
 *                          that looks like a working feature.
 *   mapPermissionLocation_ splits a Dutchie permission label and hands the middle segment to
 *                          GXCore.resolveStore. An unmatched label silently drops a person's store
 *                          rather than erroring — and because home_store is written through
 *                          writeAttrs_/gxWrite_, which replaces the whole row, "dropped" means
 *                          BLANKED on the next seed.
 *   storeToken_            folds Dutchie's `status` string, which decides whether a person is on
 *                          the roster at all.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so it tests shipped source.
 * Cannot reach Apps Script: .clasp.json rootDir is apps-script, so tests/ is out of clasp's scope.
 */
'use strict';
const fs = require('fs');

let RESOLVE = {}, RESOLVE_CALLS = [];

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  /*
   * GXCore.resolveStore is a LOOKUP TABLE here, deliberately not a reimplementation of Core's
   * matching. Crew stopped owning that logic on purpose; re-deriving it in the test would put a
   * third copy of the fold in the repo and let this file keep passing while the real resolver
   * changed underneath it. What is Crew's to get right is the half above the call — which slice
   * of the label gets handed over, and that a null comes back as '' — so the stub records its
   * argument and answers from a fixture, and the tests assert both.
   */
  GXCore:{ resolveStore(arg) { RESOLVE_CALLS.push(arg); return RESOLVE[String(arg == null ? '' : arg).trim()] || null; } },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => '', setProperty(){} }) },
  // formatDate must behave, not just exist: normDate_ falls through to it for anything that is not
  // already YYYY-MM-DD, so a lazy stub would make the Date-tolerance cases test nothing.
  Utilities:{ formatDate: (d) => {
    const p = n => String(n).padStart(2,'0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
  }},
};
const names = Object.keys(stubs);
let C;
try {
  C = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
    '\n; return { nameToKey_, normDate_, normBirthday_, storeToken_, mapPermissionLocation_, attrFields_, ATTR_HEADERS, EDITABLE_ATTRS };')(...names.map(n=>stubs[n]));
} catch (e) {
  console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
  console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
  process.exit(2);
}

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  if (got === want) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
};

// ── nameToKey_ ───────────────────────────────────────────────────────────────
console.log('\n1. nameToKey_ — the key the whole suite joins people on');
eq(C.nameToKey_('Sky Pinnick'),   'sky_pinnick',  'basic name');
eq(C.nameToKey_('  Sky Pinnick '),'sky_pinnick',  'surrounding whitespace does not change the key');
eq(C.nameToKey_('SKY PINNICK'),   'sky_pinnick',  'case does not change the key');
eq(C.nameToKey_("Shawn O'Brien"), 'shawn_obrien', 'apostrophes are stripped, not encoded');
eq(C.nameToKey_('J.T. Smith'),    'jt_smith',     'periods stripped — "J.T." and "JT" are one person');
eq(C.nameToKey_('Ana  Maria Ruiz'),'ana_maria_ruiz','a double space collapses to one underscore');
eq(C.nameToKey_(''),   '', 'empty stays empty');
eq(C.nameToKey_(null), '', 'null does not throw');

// ── normDate_ ────────────────────────────────────────────────────────────────
console.log('\n2. normDate_ — dates are TEXT, and never a shifted day');
eq(C.normDate_('2026-08-22'), '2026-08-22', 'canonical passes through');
eq(C.normDate_('2026-8-2'),   '2026-08-02', 'single digits are zero-padded, not left ragged');
eq(C.normDate_(''),        '', 'empty stays empty');
eq(C.normDate_(null),      '', 'null does not throw');
eq(C.normDate_('not a date'), '', 'garbage returns empty rather than a guess');
eq(C.normDate_('2026-13-01'), '', 'month 13 refused');
eq(C.normDate_('2026-00-10'), '', 'month 0 refused');
eq(C.normDate_('2026-02-32'), '', 'day 32 refused');
{
  // Sheets hands back a real Date when a cell was formatted as one — the exact source of the
  // timezone-shift corruption the TEXT rule exists to prevent.
  const got = C.normDate_(new Date(2026, 7, 22));
  eq(got, '2026-08-22', 'a real Date is normalised to TEXT on the SAME day');
}

// ── normBirthday_ ────────────────────────────────────────────────────────────
console.log('\n3. normBirthday_ — must DISCARD the year (PII leaves this app as MM-DD only)');
eq(C.normBirthday_('1987-08-22'), '08-22', 'YYYY-MM-DD drops the year');
eq(C.normBirthday_('08-22'),      '08-22', 'MM-DD passes through');
eq(C.normBirthday_(''),   '', 'empty stays empty');
eq(C.normBirthday_(null), '', 'null does not throw');
{
  const out = C.normBirthday_('1987-08-22');
  const leaks = /19|20\d\d/.test(out);
  if (!leaks) { pass++; console.log('  PASS  no year survives — the celebrations feed cannot leak DOB'); }
  else { fail++; console.log('  FAIL  a year survived: ' + out); }
}

// ── storeToken_ ──────────────────────────────────────────────────────────────
console.log('\n4. storeToken_ — folds the status string Dutchie actually emits');
/*
 * This function WAS the store matcher, and Core's gxStoreToken_ is the byte-for-byte copy that
 * was lifted from it. Store matching now lives in GXCore.resolveStore; what is left here is the
 * `status` check that decides whether a person is on the roster at all, so that is what is tested.
 * The Rd/Road fold is still in the function and still a no-op on these two values — the cases below
 * pin the values the roster depends on, not the folding nothing calls any more.
 */
eq(C.storeToken_('Active'),     'active',     'the value that puts someone on the roster');
eq(C.storeToken_('In-Active'),  'in active',  'and the one that does not — punctuation collapses, and it is NOT "active"');
eq(C.storeToken_('  ACTIVE  '), 'active',     'case and padding collapse');
eq(C.storeToken_(''),           '',           'empty stays empty');
eq(C.storeToken_(null),         '',           'null does not throw');

console.log('\n5. mapPermissionLocation_ — split here, match in GX Core');
{
  const RIVER = { store_id:'river-rd', display_name:'River', dutchie_name:'River Rd' };
  RESOLVE = { 'River Rd': RIVER, 'Century Dr': { store_id:'bend' } };

  RESOLVE_CALLS = [];
  eq(C.mapPermissionLocation_('TLC Cannabis Emporium - River Rd - Green Cross'), 'river-rd',
     'the middle segment of a vendor label is what matches');
  eq(RESOLVE_CALLS[0], 'River Rd',
     'and the MIDDLE SEGMENT is what Core is asked about — not the whole label');

  RESOLVE_CALLS = [];
  eq(C.mapPermissionLocation_('River Rd'), 'river-rd', 'a bare name is passed through whole');
  eq(RESOLVE_CALLS[0], 'River Rd', 'a label with no " - " sandwich is handed over unsplit');

  // The reason for the switch: Core knows the registry's `aliases` column and Crew's own matcher
  // never did, so names staff actually use resolved everywhere in the suite except here.
  eq(C.mapPermissionLocation_('TLC - Century Dr - GC'), 'bend',
     'an ALIAS resolves — Century Dr IS the Bend store, which the old local matcher could not see');

  // The '' contract. Callers branch on it (`if (loc)`), and home_store goes out through a
  // whole-row write, so a null from Core must arrive as '' and never as 'null' or undefined.
  eq(C.mapPermissionLocation_('TLC - Nowhere - GC'), '',
     'an unknown store returns empty rather than guessing a store_id');
  eq(C.mapPermissionLocation_(''), '', 'empty label returns empty');
  eq(C.mapPermissionLocation_(null), '', 'null does not throw');
  eq(typeof C.mapPermissionLocation_('TLC - Nowhere - GC'), 'string',
     'the miss is a STRING — callers write it into a row, and undefined would blank it differently');

  // Core returns null rather than picking one when a name folds onto two stores. Crew must carry
  // that through as a miss: a confident wrong home_store is worse than a blank one.
  RESOLVE = {};
  eq(C.mapPermissionLocation_('TLC - Center - GC'), '',
     'an AMBIGUOUS name comes back null from Core and stays a miss here');

  // A row that resolves is read for store_id only, so a fuller Core row cannot leak extra fields.
  RESOLVE = { 'River Rd': RIVER };
  eq(C.mapPermissionLocation_('TLC - River Rd - GC'), 'river-rd', 'only store_id is taken off the row');
}

// ── attrFields_ — the carry-forward list ─────────────────────────────────────
console.log('\n6. attrFields_ — derived from the schema, so no writer can drop a column');
{
  const ok2 = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
  const f = C.attrFields_();

  ok2(f.indexOf('celebrations_opt_out') >= 0,
      'celebrations_opt_out IS carried — omitting it re-exposed people in the kiosk feed');
  ok2(f.indexOf('employee_id') === -1, 'identity keys are excluded');
  ok2(f.indexOf('name_key') === -1,    'name_key excluded');
  ok2(f.indexOf('full_name') === -1,   'full_name excluded');
  ok2(f.indexOf('updated_at') === -1,  'audit stamps excluded');
  ok2(f.indexOf('updated_by') === -1,  'updated_by excluded');

  // THE regression guard: every non-identity, non-audit header must be carried. This is what makes
  // adding a column safe — writeAttrs_ writes the FULL row, so anything missing here is blanked.
  const identity = ['employee_id','name_key','full_name','updated_at','updated_by'];
  const missing = C.ATTR_HEADERS.filter(h => identity.indexOf(h) === -1 && f.indexOf(h) === -1);
  ok2(missing.length === 0,
      'EVERY attribute column is carried' + (missing.length ? ' — MISSING: ' + missing.join(', ') : ''));

  // And prove it is derived rather than a second hand-written list that happens to agree today.
  C.ATTR_HEADERS.push('zz_future_column');
  const after = C.attrFields_();
  ok2(after.indexOf('zz_future_column') >= 0,
      'a NEW column appears automatically — derived, not a copy that drifts');
  C.ATTR_HEADERS.pop();

  ok2(C.EDITABLE_ATTRS.indexOf('celebrations_opt_out') === -1,
      'EDITABLE_ATTRS stays a deliberate SUBSET — carried is not the same as user-editable');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
