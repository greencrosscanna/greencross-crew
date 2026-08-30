#!/usr/bin/env node
/* ─── Reading a WorkforceHub timecard export ──────────────────────────────────────────────────────
 *
 *   RUN:  node tests/hours_import_test.js
 *
 * WHY THIS EXISTS
 * The hours import parses a file format NOBODY HERE HAS SEEN. WorkforceHub's API is sold to
 * resellers, not to the businesses using the clock, so until a partner ID arrives the only way in
 * is the export a human downloads — and it was built against the vendor's field list rather than a
 * real file. That is a guess, and a guess about which column holds hours is exactly the kind that
 * produces a plausible wrong number instead of an error.
 *
 * Two things follow, and they are the design this file pins:
 *
 *   1. THE PREVIEW IS NOT DECORATION. Every inference — the header row, the layout, which columns
 *      are hours, which categories count — is stated on screen and overridable before anything is
 *      written. So the tests below assert what the inference REPORTS, not just what it computes.
 *   2. AN UNMATCHED ROW IS A FEATURE. Attaching a fortnight to the wrong person is far worse than
 *      skipping a row somebody can see, so matching is exact-or-nothing: a code, or a full token
 *      match on a name. There is deliberately no fuzzy score to tune.
 *
 * What CANNOT go wrong here, and why this file is not the last line of defence: hours only ever
 * reach $/hr. tests/incentive_math_test.js pins that they leave bonus, payroll and the Capstone
 * export byte-identical — so the worst a misparse can do is display a wrong ratio, not pay anybody
 * the wrong amount. That is the whole reason this could ship ahead of the vendor.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();';
  const cut = src.lastIndexOf(TAIL);
  if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
  src = src.slice(0, cut) +
        '\n; return { hrsParseCsv, hrsHeaderRow, hrsPlan, hrsBuild, hrsKey, hrsTokens,\n' +
        '           hrsSameCode, hrsRoster, hrsNameOf };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' },
                body: { classList: { add() {}, remove() {} } },
                getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                createElement: () => ({ style: { setProperty() {} }, classList: { add() {} },
                                        setAttribute() {}, addEventListener() {}, appendChild() {} }),
                addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' } };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  return new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
    (doc, win, store, store, { hostname: 'localhost' }, {});
})();

/* ── The CSV itself ──────────────────────────────────────────────────────────────────────────────
   Hand-rolled because this file carries no dependencies. Each case below is something a real
   export produces: Excel's BOM, CRLF, a name with a comma in it, an escaped quote in a nickname. */
console.log('\nCSV parsing');
{
  const rows = M.hrsParseCsv('a,b\r\n1,2\r\n');
  ok('CRLF line endings split into rows, not trailing \\r on every cell',
     rows.length === 2 && rows[1][1] === '2');

  const bom = M.hrsParseCsv('﻿Employee Name,Hours\nA B,8\n');
  ok('Excel\'s byte-order mark does not become part of the first header',
     bom[0][0] === 'Employee Name');

  const q = M.hrsParseCsv('name,hours\n"Kettler, Michael",80\n');
  ok('a comma inside quotes stays inside one field — "Last, First" is the common export shape',
     q[1].length === 2 && q[1][0] === 'Kettler, Michael');

  const esc = M.hrsParseCsv('name\n"He said ""hi"""\n');
  ok('a doubled quote is one literal quote', esc[1][0] === 'He said "hi"');

  const nl = M.hrsParseCsv('a,b\n"line1\nline2",x\n');
  ok('a newline inside quotes does not start a new row', nl.length === 2 && nl[1][1] === 'x');
}

/* ── Finding the header ──────────────────────────────────────────────────────────────────────────
   Exports lead with a report title and a date range. Taking row 0 blindly reads the title as the
   header, every column resolves to nothing, and the import reports that it matched nobody — which
   looks like a roster problem rather than a parsing one. */
console.log('\nHeader detection');
{
  const rows = M.hrsParseCsv(
    'Timecard Export\n' +
    '08/17/2026 - 08/30/2026\n' +
    '\n' +
    'Employee Name,Employee Code,Regular Hours,Overtime Hours,PTO Hours\n' +
    'Ana Reyes,1041,72,3,0\n');
  ok('the header is found past a title row, a date row and a blank', M.hrsHeaderRow(rows) === 3);
  ok('a one-cell title row is never mistaken for a header', M.hrsHeaderRow(rows) !== 0);
}

/* ── Wide: one row per person, a column per category ─────────────────────────────────────────── */
console.log('\nWide layout');
const WIDE =
  'Timecard Export\n' +
  'Employee Name,Employee Code,Department,Regular Hours,Overtime Hours,PTO Hours,Pay Rate\n' +
  'Ana Reyes,1041,Bend,72,3,8,17.50\n' +
  '"Kettler, Michael",1002,Corporate,80,0,0,0\n';
{
  const p = M.hrsPlan(M.hrsParseCsv(WIDE));
  ok('detected as one row per person', p.shape === 'wide');
  ok('the employee code column is found', p.headers[p.codeCol] === 'Employee Code');
  ok('the name column is found', p.headers[p.nameCol] === 'Employee Name');
  ok('three hour columns are offered', p.cats.length === 3);
  const on = p.cats.filter(c => c.on).map(c => c.label);
  ok('regular and overtime are counted by default', on.includes('Regular Hours') && on.includes('Overtime Hours'));
  ok('PTO is NOT counted by default — $/hr means per hour on the floor',
     !on.includes('PTO Hours'));
  ok('Pay Rate is not offered as hours despite being numeric — it is not named like hours',
     !p.cats.some(c => /pay rate/i.test(c.label)));
  ok('Department is not mistaken for the name column',
     p.headers[p.nameCol] !== 'Department');
}

/* ── Long: one row per person PER category ───────────────────────────────────────────────────── */
console.log('\nLong layout');
const LONG =
  'Employee Name,Employee Code,Punch Category,Total Hours\n' +
  'Ana Reyes,1041,Regular,72\n' +
  'Ana Reyes,1041,Overtime,3\n' +
  'Ana Reyes,1041,PTO,8\n' +
  'Noah Pinkerton,1055,Regular,64\n';
{
  const p = M.hrsPlan(M.hrsParseCsv(LONG));
  ok('detected as one row per category', p.shape === 'long');
  ok('the categories come from the DATA, not from the headers',
     p.cats.map(c => c.label).join('|') === 'Regular|Overtime|PTO');
  ok('PTO is off by default here too', !p.cats.find(c => c.label === 'PTO').on);

  /* A single hours column beside a column literally named "Type" is a WIDE sheet — reading it as
     long would collapse every category into one and treble somebody's fortnight. */
  const wideish = M.hrsPlan(M.hrsParseCsv(
    'Employee Name,Type,Regular Hours,PTO Hours\nAna Reyes,Full time,72,8\n'));
  ok('two hour columns beside a "Type" column stay WIDE', wideish.shape === 'wide');
}

/* ── Name and code comparison ────────────────────────────────────────────────────────────────── */
console.log('\nMatching primitives');
{
  ok('"Kettler, Michael" and "Michael Kettler" are the same person',
     M.hrsTokens('Kettler, Michael') === M.hrsTokens('Michael Kettler'));
  ok('METRC\'s shouting does not change the answer',
     M.hrsTokens('PINKERTON, NOAH') === M.hrsTokens('Noah Pinkerton'));
  /* A single-letter middle INITIAL is dropped, a middle NAME is not, and the difference is
     deliberate. Crew stores `middle_initial` as its own field precisely because payroll writes
     "Kettler Michael C" — so an export carrying the initial is the same person and must match.
     A full middle name is a different claim: the roster may simply not know it, and quietly
     matching on a subset of the tokens is how one Reyes becomes another. That one goes to the
     unmatched list, where a human resolves it. */
  ok('a middle INITIAL still matches — payroll files people with one',
     M.hrsTokens('Michael C Kettler') === M.hrsTokens('Michael Kettler'));
  ok('a full middle NAME does not silently match',
     M.hrsTokens('Michael Andrew Kettler') !== M.hrsTokens('Michael Kettler'));
  ok('two different people do not match', M.hrsTokens('Ana Reyes') !== M.hrsTokens('Ava Reyes'));

  /* Sheets coerces "0041" to 41 — the same rule that makes Sky employee 0 rather than 00. */
  ok('leading zeros do not break a code match', M.hrsSameCode('0041', '41'));
  ok('a code matches itself regardless of case', M.hrsSameCode('a1b', 'A1B'));
  ok('two blanks are NOT a match — everybody without a code would match everybody',
     !M.hrsSameCode('', ''));
  ok('a blank never matches a real code', !M.hrsSameCode('', '1041'));
  ok('different codes do not match', !M.hrsSameCode('1041', '1042'));
}

/* ── The whole build ─────────────────────────────────────────────────────────────────────────── */
console.log('\nMatching a file against a period');
const ROSTER = [
  { id: 'ana_reyes',       name: 'Ana Reyes',       legal: 'Ana Reyes',       code: '1041', store: 'Bend' },
  { id: 'michael_kettler', name: 'Mike Kettler',    legal: 'Michael Kettler', code: '',     store: 'Corporate' },
  { id: 'noah_pinkerton',  name: 'Noah Pinkerton',  legal: 'Noah Pinkerton',  code: '',     store: 'River' },
  { id: 'sky',             name: 'Sky Pinnick',     legal: 'Skyler Pinnick',  code: '',     store: '', admin: true },
];
{
  const b = M.hrsBuild(M.hrsPlan(M.hrsParseCsv(WIDE)), ROSTER);
  const ana = b.matched.find(m => m.id === 'ana_reyes');
  ok('a person with a code on file matches on the CODE', ana && ana.how === 'code');
  ok('the default column choice sums regular + overtime and drops PTO (72 + 3, not 83)',
     ana && ana.hours === 75);

  const mike = b.matched.find(m => m.id === 'michael_kettler');
  ok('a person with no code matches on the LEGAL name, not the nickname the roster leads with',
     mike && mike.how === 'name');
  ok('a name match on somebody with no code offers to learn it', mike && mike.learn === true);
  ok('a code match never re-learns a code already on file', ana && ana.learn === false);

  ok('roster people absent from the file are reported, not silently left flat',
     b.missing.some(m => m.id === 'noah_pinkerton'));
  ok('the owner is not counted as missing — he has no timecard',
     !b.missing.some(m => m.id === 'sky'));
}

/* Switching a category on is what "which hours count" looks like in practice, and it must change
   the numbers without re-reading the file. */
{
  const p = M.hrsPlan(M.hrsParseCsv(WIDE));
  p.cats.find(c => c.label === 'PTO Hours').on = true;
  const withPto = M.hrsBuild(p, ROSTER).matched.find(m => m.id === 'ana_reyes');
  ok('ticking PTO back on adds it (72 + 3 + 8)', withPto.hours === 83);

  const off = M.hrsPlan(M.hrsParseCsv(WIDE));
  off.cats.forEach(c => { c.on = false; });
  const none = M.hrsBuild(off, ROSTER).matched.find(m => m.id === 'ana_reyes');
  ok('switching everything off yields zero hours — which the screen refuses to save',
     none.hours === 0);
}

/* The long layout must total to exactly the same place as the wide one. If these two ever disagree,
   which layout the vendor happened to export would decide somebody's $/hr. */
{
  const b = M.hrsBuild(M.hrsPlan(M.hrsParseCsv(LONG)), ROSTER);
  const ana = b.matched.find(m => m.id === 'ana_reyes');
  ok('long and wide reach the same total for the same person', ana && ana.hours === 75);
  ok('a person appearing on three rows is imported once, not three times',
     b.matched.filter(m => m.id === 'ana_reyes').length === 1);
}

console.log('\nThe refusals');
{
  /* Two file rows resolving to one person means the match is wrong or the file has them twice.
     Taking the last silently overwrites the first with no trace of either. */
  const dupe = M.hrsBuild(M.hrsPlan(M.hrsParseCsv(
    'Employee Name,Employee Code,Regular Hours\n' +
    'Ana Reyes,1041,72\n' +
    '"Reyes, Ana",,40\n')), ROSTER);
  ok('a second row matching the same person is REPORTED, never allowed to overwrite the first',
     dupe.matched.length === 1 && dupe.unmatched.some(u => /also matched/.test(u.why)));

  const stranger = M.hrsBuild(M.hrsPlan(M.hrsParseCsv(
    'Employee Name,Employee Code,Regular Hours\nWho Dis,9999,40\n')), ROSTER);
  ok('somebody the period has never heard of is listed, not guessed at',
     stranger.matched.length === 0 && stranger.unmatched.length === 1);
  ok('the unmatched row keeps its hours so the number can be eyeballed',
     stranger.unmatched[0].hours === 40);

  /* A row with no employee_id cannot hold an input — incentive_save keys on it — so hrsRoster
     drops those people rather than offering a write that would land nowhere. */
  const r = M.hrsRoster({ budtenders: [{ employee_id: '', name: 'Ghost', storeName: 'Bend' },
                                       { employee_id: 'real', name: 'Real Person', storeName: 'Bend' }],
                          managers: [], admin: null });
  ok('a live row with no employee_id is not offered as a match target',
     r.length === 1 && r[0].id === 'real');

  /* The owner is carried so his row is not reported as unmatched, but flagged so commit skips him:
     calcAdmin takes no inputs, so saving hours for him would be a write that provably does nothing. */
  const ra = M.hrsRoster({ budtenders: [], managers: [],
                           admin: { employee_id: 'sky', name: 'Sky Pinnick' } });
  ok('the owner is present but marked as having no timecard', ra.length === 1 && ra[0].admin === true);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nhours import: all passed');
process.exit(fail ? 1 : 0);
