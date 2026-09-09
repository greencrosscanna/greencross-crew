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
 * though it were part of the honour.
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
  src = src.slice(0, cut) + '\n; return { eomMonth, eomWhen };\n' + src.slice(cut);
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

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
