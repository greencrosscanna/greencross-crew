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
 *   storeToken_ /          matches Dutchie permission labels onto stores. An unmatched label
 *   mapPermissionLocation_ silently drops a person's store rather than erroring.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so it tests shipped source.
 * Cannot reach Apps Script: .clasp.json rootDir is apps-script, so tests/ is out of clasp's scope.
 */
'use strict';
const fs = require('fs');

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}}, GXCore:{},
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
    '\n; return { nameToKey_, normDate_, normBirthday_, storeToken_, mapPermissionLocation_ };')(...names.map(n=>stubs[n]));
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

// ── storeToken_ / mapPermissionLocation_ ─────────────────────────────────────
console.log('\n4. storeToken_ — folds the spellings Dutchie actually emits');
eq(C.storeToken_('River Rd'),   'river', '"River Rd" → river');
eq(C.storeToken_('River Road'), 'river', '"River Road" → river (road/rd folded)');
eq(C.storeToken_('Center St'),  'center','"Center St" → center');
eq(C.storeToken_('Center Street'),'center','street/st folded');
eq(C.storeToken_('  RIVER   RD  '),'river','case and padding collapse');
eq(C.storeToken_('Commercial'), 'commercial','a plain name is unchanged');
eq(C.storeToken_(''),   '', 'empty stays empty');
eq(C.storeToken_(null), '', 'null does not throw');

console.log('\n5. mapPermissionLocation_ — the real Dutchie label shape');
{
  const STORES = [
    { store_id:'river-rd',    display_name:'River',   dutchie_name:'River Rd' },
    { store_id:'commercial',  display_name:'Commercial', dutchie_name:'Commercial' },
    { store_id:'bend',        display_name:'Century', dutchie_name:'Bend' },
  ];
  eq(C.mapPermissionLocation_('TLC Cannabis Emporium - River Rd - Green Cross', STORES), 'river-rd',
     'the middle segment of a vendor label is what matches');
  eq(C.mapPermissionLocation_('TLC - River Road - GC', STORES), 'river-rd',
     'and Road/Rd still folds inside the label');
  eq(C.mapPermissionLocation_('Bend', STORES), 'bend', 'a bare dutchie_name matches');
  eq(C.mapPermissionLocation_('Century', STORES), 'bend',
     'the DISPLAY name matches too — Century IS the Bend store');
  eq(C.mapPermissionLocation_('TLC - Nowhere - GC', STORES), '',
     'an unknown store returns empty rather than guessing a store_id');
  eq(C.mapPermissionLocation_('', STORES), '', 'empty label returns empty');
  eq(C.mapPermissionLocation_(null, STORES), '', 'null does not throw');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
