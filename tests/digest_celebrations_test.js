#!/usr/bin/env node
/* ─── Monday digest: celebrations + the first-Monday EoM reminder ──────────────────────────────
 *
 *   RUN:  node tests/digest_celebrations_test.js    (from the repo root; no deps, no network)
 *
 * WHY THIS EXISTS
 * Three of the rules below fail SILENTLY — the email sends, it looks right, and the only way to
 * notice is to be the person who was wrongly included or wrongly left out:
 *
 *   1. `celebrations_opt_out` must still suppress. It is the one rule here with a named victim.
 *      Sky holds employee_number 00, rings nothing, and ticked the flag; the digest is mailed to
 *      him, so ignoring it would show him his own anniversary in an email he asked for. The flag
 *      has already been dropped once by a writer that rebuilt a record from a hand-written field
 *      list, and the person it re-exposed was Sky. It costs nothing to pin it in a second place.
 *
 *   2. The window is SEVEN days, not the kiosk's fourteen. At fourteen, every celebration prints
 *      in two consecutive Mondays and half of each email is a repeat — which teaches the reader
 *      to skim the whole thing, including the queue above it. Nothing about a 14-day digest looks
 *      broken; it just quietly stops being read.
 *
 *   3. No raw dates leave. Birthdays are stored MM-DD with no year precisely so the celebration
 *      surfaces cannot leak a DOB, and an email forwards a great deal more easily than a kiosk
 *      screen does. The payload carries a name, a store, a type and a count of days.
 *
 * The first-Monday rule gets its own block because `?action=digest` runs on any day somebody asks
 * for it: "the 3rd is a Monday" must not make a Wednesday preview print a reminder that Monday's
 * real send would not have carried.
 */
'use strict';
const fs = require('fs');

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
const C = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
  '\n; return { digestCelebrations_, celebrationWhen_, isFirstMondayOfMonth_, digestEom_,' +
  ' DIGEST_CELEBRATION_DAYS, CELEBRATION_HORIZON_DAYS };')(...names.map(n=>stubs[n]));

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ok  ' + label);
}

/* Monday 2026-09-07 — a first Monday, so one date serves both halves of the suite. */
const MON = new Date(2026, 8, 7);
const person = (o) => Object.assign({
  employee_id: 'x', name: 'X Person', preferred_name: '', store: 'bend',
  birthday: '', work_anniversary: '', retired: false, merged: false,
  celebrations_opt_out: false
}, o);

// ── 1. the window ───────────────────────────────────────────────────────────────────────────────
console.log('\n1. seven days, not fourteen');
eq('the digest window is 7', C.DIGEST_CELEBRATION_DAYS, 7);
eq('and it is SHORTER than the kiosk\'s, which is the whole point',
   C.DIGEST_CELEBRATION_DAYS < C.CELEBRATION_HORIZON_DAYS, true);
{
  const rows = [
    person({ employee_id: 'today',  name: 'Today Person',  birthday: '09-07' }),
    person({ employee_id: 'sunday', name: 'Sunday Person', birthday: '09-13' }),
    person({ employee_id: 'day8',   name: 'Day8 Person',   birthday: '09-14' }),
    person({ employee_id: 'day13',  name: 'Day13 Person',  birthday: '09-20' }),
  ];
  const got = C.digestCelebrations_(rows, MON).map(c => c.name);
  eq('today is in', got.indexOf('Today Person') >= 0, true);
  eq('so is the Sunday at the end of the week', got.indexOf('Sunday Person') >= 0, true);
  eq('day 8 is OUT — it belongs to next Monday\'s email', got.indexOf('Day8 Person') >= 0, false);
  eq('and so is anything the kiosk\'s 14-day window would have caught',
     got.indexOf('Day13 Person') >= 0, false);
}

// ── 2. the opt-out ──────────────────────────────────────────────────────────────────────────────
console.log('\n2. celebrations_opt_out still suppresses — the named victim is Sky');
{
  const rows = [
    person({ employee_id: 'sky', name: 'Skyler Pinnick', preferred_name: 'Sky',
             birthday: '09-08', work_anniversary: '2019-09-09',
             celebrations_opt_out: true }),
    person({ employee_id: 'ana', name: 'Ana Ruiz', birthday: '09-08' }),
  ];
  const got = C.digestCelebrations_(rows, MON);
  eq('an opted-out birthday does not appear',
     got.some(c => c.name.indexOf('Sky') >= 0), false);
  eq('nor does their anniversary — the flag covers both',
     got.some(c => c.type === 'anniversary'), false);
  eq('everyone else is unaffected', got.map(c => c.name), ['Ana Ruiz']);
}
{
  /* Retired and merged rows: a tombstone is still returned by the registry and still matches on
     name, so a celebration attached to one is a card about somebody who does not work here. */
  const rows = [
    person({ employee_id: 'gone', name: 'Gone Person', birthday: '09-08', retired: true }),
    person({ employee_id: 'dupe', name: 'Dupe Person', birthday: '09-08', merged: true }),
  ];
  eq('a retired person is not celebrated', C.digestCelebrations_(rows, MON).length, 0);
}

// ── 3. no raw dates, and the shape the template reads ───────────────────────────────────────────
console.log('\n3. derived flags only — no DOB can be reconstructed');
{
  const rows = [person({ employee_id: 'ana', name: 'Ana Ruiz', birthday: '09-09' })];
  const got = C.digestCelebrations_(rows, MON)[0];
  eq('the payload carries no birthday field', got.birthday, undefined);
  eq('no work_anniversary field either', got.work_anniversary, undefined);
  eq('nothing in it looks like an ISO date',
     /\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(JSON.stringify(got)), false);
  eq('what it does carry is days away', got.days_away, 2);
  eq('and a word for it, resolved where `today` is known', got.when, 'Wednesday');
}

// ── 4. anniversaries count years, and year zero is not one ──────────────────────────────────────
console.log('\n4. anniversaries');
{
  const rows = [
    person({ employee_id: 'vet',  name: 'Vet Person',  work_anniversary: '2019-09-09' }),
    person({ employee_id: 'new',  name: 'New Person',  work_anniversary: '2026-09-09' }),
    person({ employee_id: 'one',  name: 'One Person',  work_anniversary: '2025-09-09' }),
  ];
  const got = C.digestCelebrations_(rows, MON);
  const by = {}; got.forEach(c => { by[c.name] = c; });
  eq('seven years reads as seven', by['Vet Person'].years, 7);
  eq('a first anniversary is one', by['One Person'].years, 1);
  eq('somebody hired THIS year has no anniversary yet — year zero is not one',
     by['New Person'], undefined);
}

// ── 5. "when" wording ───────────────────────────────────────────────────────────────────────────
console.log('\n5. when it lands, in words');
eq('zero is Today',    C.celebrationWhen_(0, MON), 'Today');
eq('one is Tomorrow',  C.celebrationWhen_(1, MON), 'Tomorrow');
eq('two is a weekday', C.celebrationWhen_(2, MON), 'Wednesday');
eq('six is Sunday',    C.celebrationWhen_(6, MON), 'Sunday');

// ── 6. the first-Monday rule ────────────────────────────────────────────────────────────────────
console.log('\n6. the EoM reminder fires on the first Monday and no other day');
eq('Mon 2026-09-07 — the first Monday of September',
   C.isFirstMondayOfMonth_(new Date(2026, 8, 7)), true);
eq('Mon 2026-09-14 — a Monday, but the second one',
   C.isFirstMondayOfMonth_(new Date(2026, 8, 14)), false);
eq('Wed 2026-09-02 — inside the first week, but not a Monday. A preview on this day must NOT ' +
   'print a reminder Monday\'s send would not have carried',
   C.isFirstMondayOfMonth_(new Date(2026, 8, 2)), false);
eq('Mon 2026-11-02 — the 1st is a Sunday, so the 2nd is the first Monday',
   C.isFirstMondayOfMonth_(new Date(2026, 10, 2)), true);
eq('Mon 2027-03-01 — the 1st IS the Monday',
   C.isFirstMondayOfMonth_(new Date(2027, 2, 1)), true);
eq('Mon 2026-06-01 — same, a different month',
   C.isFirstMondayOfMonth_(new Date(2026, 5, 1)), true);
eq('Sun 2026-09-06 — the day before, and the closest miss there is',
   C.isFirstMondayOfMonth_(new Date(2026, 8, 6)), false);

// ── 7. the reminder survives an unreadable cfg.eom ──────────────────────────────────────────────
console.log('\n7. an unreachable holder degrades to the bare reminder, never to silence');
{
  /* A GX Core hiccup must not cost a month its Employee of the Month. */
  const got = C.digestEom_({}, MON);
  eq('the month is still named', got.month, 'September');
  eq('and the block is still produced', typeof got, 'object');
  eq('with no holder claimed', got.holder, '');
}

console.log('\n──────────────────────────────');
console.log(fail ? fail + ' FAILED' : 'all passed');
process.exit(fail ? 1 : 0);
