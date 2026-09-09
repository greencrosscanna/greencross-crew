#!/usr/bin/env node
/* ─── The Print PDF and the Drive filing must produce the SAME name ────────────────────────────
 *
 *   RUN:  node tests/pdf_name_agreement_test.js
 *
 * WHY THIS EXISTS
 * One pay period can produce that report twice, by two different routes, and they land in the same
 * folder beside each other:
 *
 *   · PRINT PDF (browser) — `incDocName` in crew.js sets document.title, and Chrome names a
 *     Save-as-PDF from it. Whoever prints chooses the folder, and it is usually this one.
 *   · APPROVAL (engine) — `payoutFileName_` in Code.gs names the blob `filePayoutPdf_` writes to
 *     the payout folder automatically.
 *
 * Both were already tested — print_name_test.js and payout_pdf_test.js — and each one passed while
 * asserting against its OWN copy of the convention. Nothing compared them to each other. They are
 * two copies of the same regex and the same string literal in two files that are never edited
 * together, which is the arrangement this repo has already been bitten by: the bonus math is also
 * implemented twice, and the only reason that is safe is `incentive_math_test.js` driving BOTH.
 *
 * What divergence would cost is worse than a cosmetic mismatch. The archive is 28 files deep and
 * sorts by name, so a period that prints one way and files another does not read as a bug — it
 * reads as two different reports, and the pair drifts apart silently for however many fortnights it
 * takes somebody to notice. And `filePayoutPdf_` decides whether a re-approval is a re-approval by
 * asking Drive whether a file of that name already exists, so a rename quietly turns "do not
 * overwrite the original" into "there is no original".
 *
 * WHAT MUST HOLD:
 *   1. Byte-identical names from both builders, for every real pay period.
 *   2. Identical REFUSALS too — a malformed date must yield no name on both sides, not a name on
 *      one and a blank on the other.
 *   3. The shared convention is still the archive's: "Incentive Dashboard - MMDDYY-MMDDYY".
 *   4. Neither ever produces the hand-typed shapes this replaced (8.3.26-8.16.26, 07.06.26-…).
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* ── The engine's builder, lifted from the real source ──────────────────────────────────────── */
const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const engineName = new Function(
  fnSrc(GS, 'isPracticePeriod_') + '\n' + fnSrc(GS, 'practiceSource_') + '\n' +
  fnSrc(GS, 'payoutMMDDYY_') + '\n' + fnSrc(GS, 'payoutFileName_') +
  '\n; return payoutFileName_;'
)();

/* ── The browser's builder, lifted from the real crew.js the same way print_name_test.js does ──
   Loaded whole rather than by function, because incDocName reads `inc.data` and `ui.inc` — the
   point is to exercise the shipped function, not a copy of its body. */
let JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const TAIL = '})();', cut = JS.lastIndexOf(TAIL);
JS = JS.slice(0, cut) +
  '\n; return { incDocName, __setInc:(d,vis)=>{inc.data=d; ui={inc:{style:{display:vis===false?"none":""}}};} };\n' +
  JS.slice(cut);
JS = JS.replace('(function () {', 'return (function () {');
const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' }, title: 'GX Crew',
  body: { classList: { add() {}, remove() {} } }, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: { setProperty() {} }, classList: { add() {} },
    setAttribute() {}, addEventListener() {}, appendChild() {} }), addEventListener() {} };
const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' },
  addEventListener() {}, print() {} };
const store = { getItem: () => '', setItem() {}, removeItem() {} };
const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
  'navigator', JS)(doc, win, store, store, { hostname: 'localhost' }, {});
const browserName = (a, b) => { M.__setInc({ pp_start: a, pp_end: b }); return M.incDocName(); };

/* ── Every real pay period, fortnightly from the oldest imported report forward ─────────────── */
console.log('\nBoth routes name the same period the same way');
{
  let compared = 0, disagreed = 0, first = '', last = '';
  let d = Date.UTC(2025, 7, 4);                       // 2025-08-04, the oldest imported report
  for (let i = 0; i < 60; i++) {                      // ~2.3 years of fortnights, past today
    const s = new Date(d).toISOString().slice(0, 10);
    const e = new Date(d + 13 * 864e5).toISOString().slice(0, 10);
    const b = browserName(s, e), g = engineName(s, e);
    compared++;
    if (b !== g) { disagreed++; console.log('      ' + s + ': print=' + b + '  drive=' + g); }
    if (!first) first = b;
    last = b;
    d += 14 * 864e5;
  }
  ok(compared + ' pay periods compared, 0 disagreements', compared === 60 && disagreed === 0);
  ok('the oldest imported report — ' + first,
     first === 'Incentive Dashboard - 080425-081725');
  ok('and the convention holds to the end of the range — ' + last, /^Incentive Dashboard - \d{6}-\d{6}$/.test(last));
}

console.log('\nThe archive convention, from both sides');
{
  const P = ['2026-03-30', '2026-04-12'];             // the file Sky pointed at
  ok('033026-041226 from the print route',
     browserName(P[0], P[1]) === 'Incentive Dashboard - 033026-041226');
  ok('033026-041226 from the Drive route',
     engineName(P[0], P[1]) === 'Incentive Dashboard - 033026-041226');
  const A = ['2026-08-17', '2026-08-30'];             // the first period approved live
  ok('081726-083026 agrees on the first live approval',
     browserName(A[0], A[1]) === engineName(A[0], A[1]) &&
     browserName(A[0], A[1]) === 'Incentive Dashboard - 081726-083026');
}

console.log('\nNeither produces the hand-typed shapes this replaced');
{
  /* The real folder held 8.3.26-8.16.26.pdf, 07.06.26-07.19.26.pdf, and one missing its dot. */
  const b = browserName('2026-08-03', '2026-08-16'), g = engineName('2026-08-03', '2026-08-16');
  ok('no dotted dates from either', !/\d\.\d/.test(b) && !/\d\.\d/.test(g));
  ok('no ISO dates leaking through', !/\d{4}-\d{2}-\d{2}/.test(b) && !/\d{4}-\d{2}-\d{2}/.test(g));
}

console.log('\nThey REFUSE identically — half a name on one side is the silent version of this bug');
{
  const cases = [['', ''], ['2026-08-17', ''], ['', '2026-08-30'],
                 ['3/2/26', '2026-03-15'], ['2026-8-17', '2026-08-30'],
                 ['not a date', 'nor this']];
  let agreed = 0;
  cases.forEach(([a, b]) => {
    const x = browserName(a, b), y = engineName(a, b);
    if (x === y && x === '') agreed++;
    else console.log('      ' + JSON.stringify([a, b]) + ' print=' + JSON.stringify(x) +
                     ' drive=' + JSON.stringify(y));
  });
  ok('all ' + cases.length + ' malformed inputs yield no name on BOTH sides', agreed === cases.length);
}

console.log('\nThe one asymmetry that is CORRECT, and must stay');
{
  /* The engine names a period it was HANDED; the browser names only what is being LOOKED AT.
     Printing the roster must not file itself as a payout report, so a blank from the browser while
     the incentive view is hidden is right — and is the single case where the two legitimately
     differ. Asserted so a future "make them agree everywhere" does not delete it. */
  M.__setInc({ pp_start: '2026-08-17', pp_end: '2026-08-30' }, true);
  ok('displayed: the print route names it',
     M.incDocName() === 'Incentive Dashboard - 081726-083026');
  M.__setInc({ pp_start: '2026-08-17', pp_end: '2026-08-30' }, false);
  ok('hidden: the print route names NOTHING, even holding the same dates',
     M.incDocName() === '');
  ok('…while the engine, which needs no view, still names that period',
     engineName('2026-08-17', '2026-08-30') === 'Incentive Dashboard - 081726-083026');
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
