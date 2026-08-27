#!/usr/bin/env node
/* ─── The incentive screen renders both eras correctly ────────────────────────────────────────────
 *
 *   RUN:  node tests/incentive_view_test.js
 *
 * WHY
 * One renderer serves two very different payloads — a LIVE period from Leaderboard's performance
 * slice, where the bonus math runs here in the browser, and an IMPORTED period from the payout
 * PDFs, where the figures are what was paid and nothing may be recomputed. Almost every way this
 * breaks is silent: a number renders, it is just the wrong one.
 *
 * The three that would actually cost money:
 *   • a live row carries `discount` as a DECIMAL (0.0185) and an imported row carries
 *     `discount_pct` as a PERCENT (1.85). Reading one as the other is off by 100x and looks
 *     entirely plausible from either end — 1.85% and 0.0185% are both believable discount rates.
 *   • SPIFF is vendor money. It belongs in Bonus and must never reach the Payroll column or the
 *     Capstone export, or the company pays the vendor's share.
 *   • the oldest report has no payroll column at all, so those rows must export EMPTY, not 0.00.
 *     A zero tells payroll to pay nothing, which is a different claim from "not recorded".
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();';
  const cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) +
        '\n; return { incBudTable, incMgrTable, incAdminTable, incCsvRows, incDiscPct,\n' +
        '           calcBud, calcMgr, calcAdmin, inc };\n' + src.slice(cut);
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

const T = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'],
               aovTarget: 33, aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 }], maxPerStore: 50 },
};

/* ── the 100x trap ── */
ok('a LIVE row\'s decimal discount is read as a percent',
   Math.abs(M.incDiscPct({ discount: 0.0185 }) - 1.85) < 1e-9);
ok('an IMPORTED row\'s percent discount is left alone',
   Math.abs(M.incDiscPct({ discount_pct: 1.85 }) - 1.85) < 1e-9);
ok('a row carrying both prefers the imported column it was stored with',
   Math.abs(M.incDiscPct({ discount_pct: 7.3, discount: 0.0281 }) - 7.3) < 1e-9);

/* Rendered, the two must agree — this is the assertion that would have caught the swap. */
const liveRow = { employee_id: 'a', name: 'A B', storeName: 'Bend', txn: 250, sales: 8000,
                  discount: 0.0185, aov: 35 };
const impRow  = { employee_id: 'a', pdf_name: 'A B', store_label: 'Bend', txn: 250, sales: 8000,
                  discount_pct: 1.85, aov: 35, bonus: 40, payroll: 15, spiff: 25, per_hour: 0.5 };
M.inc.data = { inputs: {} };
const liveHtml = M.incBudTable([liveRow], b => M.calcBud(b, T, {}), false, true, T);
const impHtml  = M.incBudTable([impRow], b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff,
                                                 hr: b.per_hour, qual: null }), true, false, T);
ok('both eras print the same discount for the same rate',
   liveHtml.includes('1.9%') && impHtml.includes('1.9%'));

/* ── ONE identity key: employee_id ──
   Leaderboard sends nameKey ('chris_carney'); GX Core, and therefore every input Crew saves, uses
   employee_id ('christopher_carney'). Keying the inputs on nameKey did not fail — it quietly found
   nothing, so the bonus computed as if no attendance or SPIFF had been entered and the payroll came
   out short. The engine stamps employee_id onto every live row; the nameKey fallback is what keeps
   Leaderboard's own rows (which have no employee_id) working in the differential test. */
ok('an input saved under employee_id is found by the math',
   M.calcBud({ employee_id: 'christopher_carney', nameKey: 'chris_carney', storeSlug: 'bend',
               txn: 400, aov: 40, discount: 0.001 }, T,
             { christopher_carney: { att: true, spiff: 100 } }).spiff === 100);
ok('a Leaderboard row with only a nameKey still resolves',
   M.calcBud({ nameKey: 'chris_carney', storeSlug: 'bend', txn: 400, aov: 40, discount: 0.001 }, T,
             { chris_carney: { att: true, spiff: 100 } }).spiff === 100);
ok('employee_id WINS when a row carries both — the registry is the identity, not Leaderboard',
   M.calcBud({ employee_id: 'christopher_carney', nameKey: 'chris_carney', storeSlug: 'bend',
               txn: 400, aov: 40, discount: 0.001 }, T,
             { christopher_carney: { att: false, spiff: 7 }, chris_carney: { att: true, spiff: 999 } }
            ).spiff === 7);

/* ── SPIFF is not payroll ── */
const budWithSpiff = { employee_id: 'z', nameKey: 'z_q', storeSlug: 'bend', name: 'Z Q',
                       storeName: 'Bend', txn: 400, sales: 20000, discount: 0.001, aov: 40 };
M.inc.data = { inputs: { z: { att: true, spiff: 500 } } };
const c = M.calcBud(budWithSpiff, T, { z: { att: true, spiff: 500 } });
ok('a $500 SPIFF lands in Bonus but not Payroll', c.bonus === 565 && c.payroll === 65);

const csv = M.incCsvRows({
  thresholds: T, admin: null, managers: [],
  budtenders: [budWithSpiff], payPeriod: { start: '2026-08-17' },
}, false);
ok('the Capstone export carries Payroll, never Bonus',
   csv[1][3] === '65.00' && !csv.some(r => r[3] === '565.00'));
ok('the export has exactly the four columns payroll expects',
   csv[0].join(',') === 'Section,Name,Store,Payroll');

/* ── "not recorded" is not zero ──
   The oldest report has no payroll column. Exporting 0.00 for those rows instructs payroll to pay
   nothing; exporting empty says the source did not record it, which is the truth. */
const noPayroll = { employee_id: 'g', pdf_name: 'Old Timer', store_label: 'Bend',
                    txn: 145, sales: null, discount_pct: 2.97, aov: 27.83,
                    bonus: 0, payroll: null, spiff: null, per_hour: 0 };
const csv2 = M.incCsvRows({ admin: null, managers: [], budtenders: [noPayroll],
                            pp_start: '2025-08-04' }, true);
ok('an unrecorded payroll exports EMPTY, not 0.00', csv2[1][3] === '');
const oldHtml = M.incBudTable([noPayroll], b => ({ bonus: b.bonus, payroll: b.payroll,
  spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T);
ok('and renders as a dash that says why', /No payroll column in this report/.test(oldHtml));
ok('an unrecorded sales figure also renders as a dash, not $0', /—/.test(oldHtml));

/* ── an imported period offers no way to edit it ──
   It is closed and paid. An input here would imply a recalculation that is never going to happen. */
ok('imported rows render no attendance checkbox', !impHtml.includes('crew-inc-att'));
ok('imported rows render no SPIFF input', !impHtml.includes('<input type="number"'));
ok('a live row IS editable when the session can edit', liveHtml.includes('crew-inc-att') &&
   liveHtml.includes('crew-inc-spiff'));
const roHtml = M.incBudTable([liveRow], b => M.calcBud(b, T, {}), false, false, T);
/* A read-only session still needs to SEE whether somebody had full attendance, so the checkbox
   stays and is disabled — removing it would hide the fact rather than protect it. The SPIFF field
   becomes plain text, because an empty-looking input reads as "nothing entered". */
ok('a read-only session gets a disabled checkbox, not a missing one',
   roHtml.includes('type="checkbox"') && roHtml.includes('disabled'));
ok('and no editable SPIFF field', !roHtml.includes('<input type="number"'));

/* ── a met target is marked ON the figure ── */
ok('an AOV over target is marked green', liveHtml.includes('crew-inc-hit'));
const missed = M.incBudTable([{ employee_id: 'm', name: 'M M', storeName: 'Bend', txn: 10,
  sales: 100, discount: 0.09, aov: 12 }], b => M.calcBud(b, T, {}), false, true, T);
ok('a row that missed every target is marked nowhere', !missed.includes('crew-inc-hit'));

/* ── the payroll tooltip explains the sum ── */
ok('a budtender payroll figure carries its breakdown',
   /title="[^"]*qualified[^"]*AOV[^"]*discount[^"]*attendance/.test(liveHtml));
const mgrHtml = M.incMgrTable([{ employee_id: 'q', name: 'Q R', storeName: 'Bend', target: 100,
  sales: 115, discount: 0.005, aov: 40 }], m => M.calcMgr(m, T, {}, []), false, true, T);
ok('a manager payroll figure carries its four components',
   /title="sales [^"]*discount[^"]*AOV[^"]*team attendance/.test(mgrHtml));
ok('imported rows carry no tooltip — there is nothing to recompute',
   !/title="sales/.test(impHtml) && !/qualified/.test(impHtml));

/* ── names come from whichever field the era used ── */
ok('an imported row shows the name the report printed', impHtml.includes('A B'));
ok('a departed person with no employee_id still renders',
   M.incBudTable([{ pdf_name: 'Finnick Winchester', store_label: 'Hillsboro', bonus: 40,
     payroll: 40, spiff: 0, per_hour: 0.5 }], b => ({ bonus: b.bonus, payroll: b.payroll,
     spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T).includes('Finnick Winchester'));

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentive view: all passed');
process.exit(fail ? 1 : 0);
