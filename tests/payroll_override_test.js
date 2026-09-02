#!/usr/bin/env node
/* ─── The payroll override — recording what was actually paid ──────────────────────────────────────
 *
 *   RUN:  node tests/payroll_override_test.js
 *
 * WHY THIS EXISTS
 * Every other input on the incentive screen FEEDS the math: attendance earns a bonus, SPIFF is
 * vendor money, hours divide $/hr. This one OVERRULES it — a typed number that replaces the
 * computed figure and goes straight to the Capstone export. It is the first thing in Crew where a
 * human decides what somebody was paid, so the ways it can go wrong are the expensive kind.
 *
 * The case that produced it: Levy Nelson was paid $25 on a 1.00% discount rate in the 8/17-8/30
 * period. Leaderboard's data for that closed fortnight later moved to 1.04%, above the 1.0% bar,
 * so the same period now computes $0 for her. Break glass could reopen the period and still could
 * not record what she was actually paid — the reopen was half a tool without this.
 *
 * WHAT MUST HOLD, in the order it would cost money:
 *
 *   1. The override reaches the EXPORT. A figure the screen honours and the CSV ignores would send
 *      payroll a number nobody ever saw — both halves looking right in isolation.
 *   2. The override reaches the TOTALS. A total that disagrees with the column above it loses trust
 *      in both, and "Total payroll" is the number this screen exists to produce.
 *   3. It does NOT reach the math. incCalcBud_/incCalcMgr_ are pinned byte-for-byte against a frozen
 *      Leaderboard oracle; an override reaching inside them would make that comparison meaningless.
 *      An override is not a different calculation — it is a person saying the calculation does not
 *      apply to this row.
 *   4. null is not zero. A deliberate $0 override is a real answer ("paid nothing") and must beat
 *      the computed figure; an absent one must not.
 *   5. The reason survives. An override with no provenance reads as a bug in the calculation.
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
        '\n; return { incPaid, incInput, calcBud, calcMgr, calcAdmin, incCsvRows, incBudTable, inc };\n' +
        src.slice(cut);
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

/* The ENGINE's copy of the same rule, from the shipped Code.gs. Two implementations exist for the
   same reason the bonus math has two — the browser re-scores on a keystroke, the engine decides
   what is written at approval — and they must not disagree about which number was paid. */
const E = (function () {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const i = gs.indexOf('function incPayroll_(');
  if (i < 0) throw new Error('missing incPayroll_ in Code.gs');
  let d = 0, end = -1;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) { end = k + 1; break; } }
  }
  return new Function(gs.slice(i, end) + '; return { paid: incPayroll_ };')();
})();

const T = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'],
               aovTarget: 33, aovBonus: 25, discountMaxPct: 1.0, discountBonus: 25,
               attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }], maxPerStore: 50 },
};

/* Levy as she actually is: 203 transactions at a full-volume store so she qualifies, 1.04% discount
   so she now misses the 1.0% ceiling, AOV under target. Computes to nothing; was paid $25. */
const levy = { employee_id: 'levy_nelson', name: 'Levy Nelson', full_name: 'Levy Nelson',
               storeName: 'Baseline', storeSlug: 'baseline', store_id: 'hillsboro',
               txn: 203, sales: 5842, discount: 0.0104, aov: 28.78 };

console.log('\nThe rule itself');
{
  ok('no override leaves the computed figure alone', M.incPaid(25, { payrollOverride: null }) === 25);
  ok('an override replaces it', M.incPaid(0, { payrollOverride: 25 }) === 25);
  /* The distinction the whole inputs tab is built on, and the one most likely to be "simplified"
     away: `|| 0` here would make a deliberate zero indistinguishable from an absent override. */
  ok('a deliberate $0 override WINS over a computed figure', M.incPaid(40, { payrollOverride: 0 }) === 0);
  ok('an absent override does not', M.incPaid(40, {}) === 40);
  ok('and neither does a missing inputs row', M.incPaid(40, null) === 40);
  for (const [computed, ov] of [[0, 25], [40, 0], [15, 15], [0, null], [25, null]]) {
    if (!Object.is(M.incPaid(computed, { payrollOverride: ov }), E.paid(computed, { payrollOverride: ov }))) {
      ok('browser and engine agree for computed=' + computed + ' override=' + ov, false);
    }
  }
  ok('the browser and engine copies answer identically', true);
}

console.log('\nIt must not reach the math');
{
  const plain = M.calcBud(levy, T, { levy_nelson: { att: false, spiff: 0 } });
  const over  = M.calcBud(levy, T, { levy_nelson: { att: false, spiff: 0, payrollOverride: 25 } });
  /* If an override ever leaks into calcBud, tests/incentive_math_test.js stops meaning anything —
     its whole guarantee is that this arithmetic still matches the arithmetic that paid people. */
  ok('calcBud is byte-identical with and without an override',
     plain.bonus === over.bonus && plain.payroll === over.payroll && plain.qual === over.qual);
  ok('...and Levy really does compute to nothing now', plain.payroll === 0);

  const mgr = { employee_id: 'm1', storeSlug: 'baseline', target: 100, sales: 105, discount: 0.005, aov: 40 };
  const mp = M.calcMgr(mgr, T, {}, [levy]);
  const mo = M.calcMgr(mgr, T, { m1: { payrollOverride: 999 } }, [levy]);
  ok('calcMgr is unaffected too', mp.payroll === mo.payroll && mp.bonus === mo.bonus);
}

console.log('\nIt must reach the export');
{
  const inputs = { levy_nelson: { att: false, spiff: 0, payrollOverride: 25, overrideNote: 'paid as filed' } };
  M.inc.data = { inputs: inputs };
  const csv = M.incCsvRows({
    thresholds: T, admin: null, managers: [],
    budtenders: [levy], payPeriod: { start: '2026-08-17' } }, false);
  const row = csv.slice(1).find(r => /Nelson/.test(r[0]));
  ok('an overridden person appears in the Capstone file at the PAID figure',
     !!row && row[2] === '25.00');
  /* The reason this is not merely a display bug: without the override she computes $0, and the
     non-zero filter drops zero rows — so a broken override does not send the wrong number, it
     sends no row at all, and she is simply absent from payroll. */
  M.inc.data = { inputs: { levy_nelson: { att: false, spiff: 0 } } };
  const csv2 = M.incCsvRows({
    thresholds: T, admin: null, managers: [],
    budtenders: [levy], payPeriod: { start: '2026-08-17' } }, false);
  ok('without the override she is dropped from the file entirely — which is what it exists to stop',
     !csv2.slice(1).some(r => /Nelson/.test(r[0])));
}

console.log('\nWhat the cell says');
{
  M.inc.data = { inputs: { levy_nelson: { att: false, spiff: 0, payrollOverride: 25,
                                          overrideNote: 'paid as filed on the original approval' } },
                 can_approve: true, can_edit: true, thresholds: T };
  const html = M.incBudTable([levy], b => M.calcBud(b, T, M.inc.data.inputs), false, true, T);
  ok('an overridden payroll cell is marked', /crew-inc-over/.test(html));
  ok('it shows the PAID figure, not the computed one', /\$25/.test(html) && !/>\$0</.test(html));
  ok('the tooltip carries what the math said', /math computes/.test(html));
  ok('...and the reason, which is the part that matters a year later',
     /paid as filed on the original approval/.test(html));
  /* The breakdown is how anybody checks a figure. An override is a reason ON TOP of that argument,
     not a replacement for it — losing it would make the one cell a human can change the only cell
     nobody can check. */
  ok('the bonus breakdown survives alongside the override reason',
     /qualified|did not qualify/.test(html));

  /* Not the approver: no pencil. The engine refuses the write, so rendering the control would be an
     offer the server declines — the worst kind of permission gate. */
  M.inc.data.can_approve = false;
  const asPreparer = M.incBudTable([levy], b => M.calcBud(b, T, M.inc.data.inputs), false, true, T);
  ok('the preparer sees the override but cannot reach for it', /crew-inc-over/.test(asPreparer) &&
     !/crew-inc-payedit/.test(asPreparer));
  M.inc.data.can_approve = true;
  const asApprover = M.incBudTable([levy], b => M.calcBud(b, T, M.inc.data.inputs), false, true, T);
  ok('the approver gets the pencil', /crew-inc-payedit/.test(asApprover));

  /* A locked period (can_edit false, e.g. sent for approval) offers nothing either, or the screen
     would invite an edit the route refuses for a different reason again. */
  M.inc.data.can_edit = false;
  const locked = M.incBudTable([levy], b => M.calcBud(b, T, M.inc.data.inputs), false, false, T);
  ok('a period locked pending approval offers no pencil', !/crew-inc-payedit/.test(locked));
  M.inc.data.can_edit = true;
}

console.log('\nImported periods carry their own frozen answer');
{
  /* A closed period is what was paid and is never recomputed, so nothing is re-applied to it — the
     override it was approved with is already in `payroll`, and the note rides along to explain it. */
  const frozen = { employee_id: 'levy_nelson', pdf_name: 'Levy Nelson', store_label: 'Baseline',
                   store_id: 'hillsboro', txn: 203, sales: 5842, discount_pct: 1.0, aov: 28.78,
                   bonus: 62.5, payroll: 25, spiff: 37.5, per_hour: 0.78,
                   computed_payroll: 0, override_note: 'paid as filed' };
  M.inc.data = { inputs: {}, can_approve: true, can_edit: false };
  const html = M.incBudTable([frozen], b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff,
                                               hr: b.per_hour, qual: null }), true, false, T);
  ok('a frozen override is still marked on an imported period', /crew-inc-over/.test(html));
  ok('it reads the note the period was approved with', /paid as filed/.test(html));
  ok('and the live inputs are not consulted for it', /\$25/.test(html));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\npayroll override: all passed');
process.exit(fail ? 1 : 0);
