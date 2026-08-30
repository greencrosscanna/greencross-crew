#!/usr/bin/env node
/* ─── "Does this person still work here?" — one answer, and it must stay one ────────────────────
 *
 *   RUN:  node tests/status_live_test.js      (from the repo root; no deps, no network)
 *
 * WHY THIS EXISTS
 * Five places in the engine answered this question inline, and by 2026-08-29 they disagreed in
 * two different directions:
 *
 *   • Four of them omitted `'false'`. Booleans are TEXT across this suite, so an `active` column
 *     holding "false" reaches a caller as the status string 'false' — and those four counted that
 *     person as live.
 *
 *   • One — `getCelebrations_`, the ONE endpoint whose output leaves Crew for the all-staff
 *     kiosk — omitted `'retired'` AND `'merged'`. So the most public surface in the app announced
 *     birthdays and work anniversaries for people who had left the company, and for merged
 *     tombstone records, which announce a live person a second time under their old row.
 *
 * That one shipped and ran for as long as the endpoint has existed. It never looked broken: it
 * only shows itself on the one day a year each affected person has a date, on a kiosk nobody
 * audits, and a retired person's card renders exactly like everybody else's. It was caught only
 * because the Monday digest derived the same list from `rosterJoin_` and returned 1 for a week
 * this endpoint claimed 4 for — a cross-check that existed by accident, for one week, because
 * two features happened to overlap.
 *
 * So the fix is not "correct the line". It is one helper, plus the sweep below that fails if a
 * sixth inline spelling appears. The next drift should break a test, not a birthday.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

/* The sweep below reads CODE, not SRC.
 *
 * Comments are blanked out line-by-line (length preserved, so line numbers still point at the
 * real file). Without this the sweep flags its own documentation: the fix for getCelebrations_
 * QUOTES the buggy line it replaced, which is worth keeping — a reader who finds that endpoint
 * should see what it used to do — and a naive scan cannot tell that quote from the real thing. */
const CODE = (() => {
  let inBlock = false;
  return SRC.split('\n').map((line) => {
    let out = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) { out += ' '.repeat(line.length - i); i = line.length; }
        else { out += ' '.repeat(end + 2 - i); i = end + 2; inBlock = false; }
      } else {
        const b = line.indexOf('/*', i), l = line.indexOf('//', i);
        if (l >= 0 && (b < 0 || l < b)) { out += line.slice(i, l) + ' '.repeat(line.length - l); i = line.length; }
        else if (b >= 0) { out += line.slice(i, b); i = b + 2; out += '  '; inBlock = true; }
        else { out += line.slice(i); i = line.length; }
      }
    }
    return out;
  }).join('\n');
})();

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  GXCore:{ resolveStore: () => null, getKv: () => null },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => '', setProperty(){} }) },
  Utilities:{ formatDate: (d) => d.toISOString().slice(0,10),
              base64Encode: (s) => Buffer.from(s).toString('base64') },
};
const names = Object.keys(stubs);
const C = new Function(...names, SRC + '\n; return { statusIsLive_ };')(...names.map(n=>stubs[n]));

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ok  ' + label);
}

// ── 1. the five values that mean "gone" ─────────────────────────────────────────────────────────
console.log('\n1. every spelling of gone');
eq('retired',    C.statusIsLive_('retired'), false);
eq('merged — a TOMBSTONE, still returned by getEmployees() and still matching on name',
   C.statusIsLive_('merged'), false);
eq('inactive',   C.statusIsLive_('inactive'), false);
eq('terminated', C.statusIsLive_('terminated'), false);
eq('false — booleans are TEXT here, so an `active` column saying "false" arrives as this',
   C.statusIsLive_('false'), false);

console.log('\n2. live, including the ways a status arrives empty');
eq('active',            C.statusIsLive_('active'), true);
eq('empty means active — the registry does not always write the column',
   C.statusIsLive_(''), true);
eq('null means active',      C.statusIsLive_(null), true);
eq('undefined means active', C.statusIsLive_(undefined), true);
eq('an unknown status is LIVE — failing the other way would silently hide a real person',
   C.statusIsLive_('on-leave'), true);

console.log('\n3. the shapes a sheet actually hands back');
eq('cased',   C.statusIsLive_('Retired'), false);
eq('shouted', C.statusIsLive_('RETIRED'), false);
eq('padded — trailing spaces in sheet cells are routine', C.statusIsLive_('  merged  '), false);
eq('the BOOLEAN false, not the string', C.statusIsLive_(false), false);
eq('and the boolean true is live',      C.statusIsLive_(true), true);

// ── 4. the sweep: no sixth inline spelling ──────────────────────────────────────────────────────
/*
 * The helper only helps if callers use it. This looks for the pattern the five removed lines all
 * had — a comparison of a status against one of the gone-values — anywhere outside the helper
 * itself and the three sites that deliberately keep their own logic.
 *
 * Those three are exempt for stated reasons, and the reasons are the point: rosterJoin_ RENDERS
 * retired and merged differently so it must tell them apart; identity_health COUNTS them
 * separately, which is its entire output; identity_repair excludes merged only, because a retired
 * person with a damaged full_name still wants repairing. Each carries a "NOT statusIsLive_"
 * comment at the line, and this test requires that comment — an exemption nobody explained is
 * indistinguishable from the bug.
 */
console.log('\n4. no sixth inline spelling of the same question');
{
  const lines = SRC.split('\n');
  const code  = CODE.split('\n');
  const GONE  = /'(retired|merged|inactive|terminated|false)'/;
  /* The helper's own body, by span — it is the one place allowed to spell these out. */
  const hStart = code.findIndex((l) => /function statusIsLive_/.test(l));
  const hEnd   = code.findIndex((l, i) => i > hStart && /^\}/.test(l));
  const offenders = [];
  code.forEach((line, i) => {
    if (i >= hStart && i <= hEnd) return;
    if (!GONE.test(line)) return;
    if (!/st\s*===|st\s*!==/.test(line)) return;
    /* A deliberate exception must SAY it is one, within a few lines above — in the REAL source,
       since that is where the comment lives. An exemption nobody explained is indistinguishable
       from the bug. */
    const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    if (/NOT statusIsLive_/.test(context)) return;
    offenders.push((i + 1) + ': ' + line.trim());
  });
  eq('every status comparison is either the helper, or an exception that says why' +
     (offenders.length ? '\n  OFFENDERS:\n    ' + offenders.join('\n    ') : ''),
     offenders.length, 0);
}

// ── 5. the three exemptions are still THERE ─────────────────────────────────────────────────────
/* The sweep above passes trivially if somebody deletes the exceptions, so pin that they exist. */
console.log('\n5. the deliberate exceptions are present and explained');
eq('rosterJoin_ still tells retired and merged apart',
   /var isMerged\s*=\s*st === 'merged';/.test(SRC), true);
eq('identity_health still counts them separately',
   /if \(st === 'merged'\)\s*\{\s*merged\+\+;/.test(SRC), true);
eq('all three carry a NOT statusIsLive_ note',
   (SRC.match(/NOT statusIsLive_/g) || []).length, 3);

// ── 6. getCelebrations_ specifically — the endpoint that leaves the app ─────────────────────────
console.log('\n6. the kiosk feed calls the helper');
{
  const i = CODE.indexOf('function getCelebrations_');
  eq('getCelebrations_ exists', i >= 0, true);
  const body = CODE.slice(i, i + 4000);
  eq('and gates its identity map on statusIsLive_',
     /if \(!statusIsLive_\(r\.status\)\) return;/.test(body), true);
  eq('the old three-value test is gone from it',
     /st === 'inactive' \|\| st === 'terminated' \|\| st === 'false'/.test(body), false);
}

console.log('\n──────────────────────────────');
console.log(fail ? fail + ' FAILED' : 'status live: all passed');
process.exit(fail ? 1 : 0);
