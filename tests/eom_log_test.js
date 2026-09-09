#!/usr/bin/env node
/* ─── The Employee of the Month log shows the month, not a range ────────────────────────────────
 *
 *   RUN:  node tests/eom_log_test.js
 *
 * WHY THIS EXISTS
 * Sky: "EOM section, just show the Month Year in roster page, not the range."
 *
 * The log used to read "Aug 2026 — present" while a reign ran, and "Mar 2026 – Apr 2026" wherever a
 * pick had not been changed promptly. Both describe how long somebody HELD the star, which is a
 * fact about when the next pick happened rather than about the award. Employee of the Month is a
 * monthly award, so the month it was given for is the whole answer — a second month in the row only
 * ever meant "nobody got round to picking in April", which the log of who won should not report as
 * though it were part of the honor.
 *
 * AND THE BUG THAT MUST NOT COME BACK WITH IT. The month is read off the ISO string, never through
 * `new Date`. `new Date('2026-08-01')` parses as UTC midnight and getMonth() answers in LOCAL time,
 * so west of Greenwich every reign that began on the 1st was reported a month early — the log read
 * "Jul 2026" for a pick made in August. Same class of failure the suite's dates-are-TEXT rule
 * exists to prevent, and cfg.eom's own `since` is written on the 1st more often than any other day.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();', cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) + '\n; return { eomMonth, eomWhen, eomFold };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const mk = () => ({ className: '', innerHTML: '', style: { setProperty() {} },
    classList: { add() {}, remove() {} }, setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, appendChild() {}, removeChild() {}, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [], focus() {} });
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' }, body: mk(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => mk(), addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' },
    addEventListener() {}, print() {} };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  return new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
    'navigator', src)(doc, win, store, store, { hostname: 'localhost' }, {});
})();

console.log('\nOne month per reign — never a range, never "present"');
{
  /* The live value the day this was written: Noah, picked 1 September, still holding. */
  const current = { employee_id: 'noah_pinkerton', started_at: '2026-09-01T19:43:19.774Z',
                    ended_at: '', current: true };
  ok('a running reign reads as its month', M.eomWhen(current) === 'Sep 2026');
  ok('…and not "— present"', M.eomWhen(current).indexOf('present') < 0);

  const oneMonth = { started_at: '2026-03-02T18:00:00Z', ended_at: '2026-03-30T18:00:00Z' };
  ok('a reign inside one month reads as that month', M.eomWhen(oneMonth) === 'Mar 2026');

  /* The case the range existed for: a pick left standing into the next month. It is March's award. */
  const spilled = { started_at: '2026-03-02T18:00:00Z', ended_at: '2026-04-20T18:00:00Z' };
  ok('a reign that ran into the next month is still MARCH\'s award', M.eomWhen(spilled) === 'Mar 2026');
  ok('…with no second month in the row', M.eomWhen(spilled).indexOf('Apr') < 0 &&
     M.eomWhen(spilled).indexOf('–') < 0 && M.eomWhen(spilled).indexOf('—') < 0);

  /* Whatever the row carries, one month comes out. A range in this column is the regression. */
  [current, oneMonth, spilled].forEach(h => {
    if (/[–—]|present/.test(M.eomWhen(h))) { fail++; console.log('  ✗ range leaked: ' + M.eomWhen(h)); }
  });
  ok('no range survives on any shape of row', true);
}

console.log('\nThe month is read off the STRING — the bug that reported August as July');
{
  /* new Date('2026-08-01') is UTC midnight, and getMonth() answers local — so west of Greenwich a
     reign begun on the 1st came out a month early. cfg.eom's `since` lands on the 1st more often
     than any other day, so this is the common case, not the edge one. */
  ok('a bare 1st-of-month date stays in its own month', M.eomMonth('2026-08-01') === 'Aug 2026');
  ok('…and so does a UTC-midnight timestamp', M.eomMonth('2026-08-01T00:00:00.000Z') === 'Aug 2026');
  ok('January does not wrap to the year before', M.eomMonth('2026-01-01T00:00:00.000Z') === 'Jan 2026');
  ok('and the real September value reads September', M.eomMonth('2026-09-01T19:43:19.774Z') === 'Sep 2026');

  /* Proof it is not going through Date at all: a string Date would happily reinterpret. */
  ok('a month index out of range is refused rather than wrapped', M.eomMonth('2026-13-01') === '—');
  ok('an empty value reads as unknown, not as a month', M.eomMonth('') === '—');
  ok('and so does junk', M.eomMonth('not a date') === '—');
}

console.log('\nThe old span function is gone, not just unused');
{
  const CREW = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const code = CREW.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('eomSpan no longer exists in the code', code.indexOf('eomSpan') < 0);
  ok('and the log row renders eomWhen', /crew-eomlog-when', esc\(eomWhen\(h\)\)/.test(code));
}

console.log('\nOne row per person per month — Noah appeared twice under Sep 2026');
{
  /* The log appends whenever cfg.eom's `since` changes, so re-picking the same person in the same
     month (star toggled off and on, or the pick simply made again) wrote a second row. The engine
     no longer creates those, but crew_eom_history is APPEND-ONLY and the ones already written are
     still in it — so the screen folds them, or the fix would only reach months nobody has had yet.
     Rows arrive NEWEST FIRST, which is what these fixtures reproduce. */
  const noahLate  = { employee_id: 'noah_pinkerton', started_at: '2026-09-04T17:02:00Z', current: true };
  const noahFirst = { employee_id: 'noah_pinkerton', started_at: '2026-09-01T19:43:19.774Z' };
  const shawn     = { employee_id: 'shawn_todd',     started_at: '2026-08-01T18:00:00Z' };

  const folded = M.eomFold([noahLate, noahFirst, shawn]);
  ok('the two Noah rows become one', folded.length === 2);
  ok('and it is still September', M.eomWhen(folded[0]) === 'Sep 2026');
  /* The month is won when it is FIRST given; a re-pick does not restart it. */
  ok('keeping the EARLIEST start, not the re-pick',
     folded[0].started_at === '2026-09-01T19:43:19.774Z');
  ok('and staying the current holder', folded[0].current === true);
  ok('the month before is untouched', folded[1].employee_id === 'shawn_todd');

  /* THE CARE IN IT: only consecutive runs fold. Somebody else holding it in between makes those
     genuinely two reigns, and collapsing them would erase a real handover. */
  const ayla = { employee_id: 'ayla_mcarthur', started_at: '2026-09-03T18:00:00Z' };
  const sandwich = M.eomFold([noahLate, ayla, noahFirst]);
  ok('a run broken by somebody else is NOT folded', sandwich.length === 3);

  /* Same person, different months, is two awards. */
  const noahAug = { employee_id: 'noah_pinkerton', started_at: '2026-08-02T18:00:00Z' };
  ok('the same person in two months keeps both rows',
     M.eomFold([noahFirst, noahAug]).length === 2);

  /* A deliberate "nobody" is part of the record; two of them running together are still one gap,
     and a nobody must never fold into a person. */
  const nob1 = { employee_id: '', nobody: true, started_at: '2026-07-20T18:00:00Z' };
  const nob2 = { employee_id: '', nobody: true, started_at: '2026-07-04T18:00:00Z' };
  ok('two consecutive "nobody" rows in one month fold', M.eomFold([nob1, nob2]).length === 1);
  ok('and a nobody never folds into a person',
     M.eomFold([nob1, { employee_id: '', nobody: false, started_at: '2026-07-02T18:00:00Z' }]).length === 2);

  /* Undatable rows must not all collapse onto each other — '—' is not a month. */
  const junk1 = { employee_id: 'x', started_at: '' };
  const junk2 = { employee_id: 'x', started_at: 'nope' };
  ok('rows with no usable date are left alone rather than merged', M.eomFold([junk1, junk2]).length === 2);

  ok('an empty log folds to nothing, without throwing', M.eomFold([]).length === 0);
  ok('and a missing one too', M.eomFold(undefined).length === 0);

  /* AND THE RENDERER ACTUALLY USES IT. Everything above drives eomFold directly, so all of it
     passes just as happily with the call deleted from the list builder and the duplicate back on
     screen — which is exactly what mutation-testing this file did. A function that is only ever
     correct in its own test is not a fix. */
  const code = fs.readFileSync(__dirname + '/../crew.js', 'utf8')
                 .replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the log is built from the FOLDED list, not the raw one',
     /eomFold\(state\.eomHistory\)\.forEach/.test(code));
  ok('…and nothing iterates the raw history to build rows',
     !/state\.eomHistory\.forEach/.test(code));
}

console.log('\nThe "set by" column is gone from the screen, not from the record');
{
  const CREW = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  const code = CREW.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the log row no longer renders it', code.indexOf('crew-eomlog-by') < 0);
  ok('and its CSS went with it rather than being left orphaned',
     HTML.indexOf('crew-eomlog-by') < 0);
  /* The engine still WRITES set_by and source — losing the column is a screen decision, and the
     provenance it carried (observed vs backfilled) is still on the sheet. */
  const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  ok('the engine still records who set it', /EOM_HEADERS = \[[^\]]*'set_by'/.test(GS));
  ok('…and whether it was observed or backfilled', /EOM_HEADERS = \[[^\]]*'source'/.test(GS));
}

console.log('\nThe ENGINE stops writing the duplicate in the first place');
{
  const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const code = GS.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('eomSync_ dedups on the MONTH, not on the exact since value',
     /eomSameMonth_\(last\.started_at, cur\.since\)/.test(code));
  ok('…and no longer compares started_at to since exactly',
     code.indexOf("String(last.started_at) === String(cur.since") < 0);
  /* Month off the string here too — the same trap that had the log reporting August as July. */
  ok('the engine reads the month off the string, never through Date',
     /function eomMonthKey_[\s\S]{0,200}\/\^\(\\d\{4\}\)-\(\\d\{2\}\)\//.test(code));
  ok('two unusable dates are NOT treated as the same month',
     /return !!x && x === y;/.test(code));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
