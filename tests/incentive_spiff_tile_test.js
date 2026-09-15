#!/usr/bin/env node
/* ─── The period's SPIFF tile, between Budtender bonuses and Admin ────────────────────────────────
 *
 *   RUN:  node tests/incentive_spiff_tile_test.js      (from the repo root; no deps, no network)
 *
 * Sky, 2026-09-15: "Add a SPIFF KPI Card between BT Bonuses and Admin". What can go wrong:
 *   • SPIFF leaking into Total payroll. It is vendor money — in Bonus, never in Payroll — and the
 *     Capstone export carries payroll only. The tile sits among payroll tiles; it must not join them.
 *   • Blank read as $0. The 2025-08-04 report has no SPIFF column; that period shows a dash.
 *   • A stated 0 read as blank. A live period where nobody earned SPIFF is a real $0.
 *
 * Loads the real crew.js, so this tests shipped source.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const SRC = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const M = (function () {
  let src = SRC;
  const cut = src.lastIndexOf('})();');
  src = src.slice(0, cut) + '\n; return { incSpiffTotal, calcBud, calcMgr };\n' + src.slice(cut);
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

console.log('\nThe total\n');
ok('sums managers and budtenders, cents kept',
   JSON.stringify(M.incSpiffTotal([{ spiff: 50 }, { spiff: 0.75 }, { spiff: 11.25 }])) === '{"total":62,"any":true}');
ok('every row blank (the 2025-08-04 report) → not recorded, not $0',
   M.incSpiffTotal([{ spiff: null }, { spiff: undefined }, { spiff: '' }]).any === false);
ok('a stated zero IS recorded — a live period where nobody earned SPIFF is a real $0',
   JSON.stringify(M.incSpiffTotal([{ spiff: 0 }, { spiff: 0 }])) === '{"total":0,"any":true}');
ok('blank rows beside stated ones are skipped, not zeroed into NaN',
   M.incSpiffTotal([{ spiff: null }, { spiff: 25 }]).total === 25);
ok('no rows / missing input → nothing recorded', M.incSpiffTotal([]).any === false && M.incSpiffTotal().any === false);

console.log('\nThe tile\n');
{
  const paint = SRC.slice(SRC.indexOf('function paintIncentive('));
  const tiles = paint.slice(paint.indexOf('<dl class="crew-inc-tot">'), paint.indexOf("'</dl></div>'"));
  const order = ['Manager bonuses', 'Budtender bonuses', 'SPIFF · vendor-funded', 'Admin', 'Total payroll']
    .map((l) => tiles.indexOf('<dt>' + l + '</dt>'));
  ok('five tiles in order: Manager, Budtender, SPIFF, Admin, Total payroll',
     order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]));
  ok('SPIFF is NOT added into Total payroll',
     /esc\(m0\(budTotal \+ mgrTotal \+ admPay\)\)/.test(tiles) && !/spiffTot\.total\s*\+|\+\s*spiffTot/.test(paint));
  ok('its figure comes from the same calcs the tables render',
     /incSpiffTotal\(buds\.map\(budCalc\)\.concat\(mgrs\.map\(mgrCalc\)\)\)/.test(paint));
  ok('an unrecorded period prints a dash', /spiffTot\.any \? esc\(m0\(spiffTot\.total\)\) : '—'/.test(tiles));
}

console.log('\nThe calcs it reads agree with the SPIFF/payroll split\n');
{
  const T = { hoursPerPeriod: 80,
    budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: [], aovTarget: 33, aovBonus: 25,
                 discountMaxPct: 1.5, discountBonus: 25, attendanceBonus: 15 },
    manager: { salesTiers: [{ pct: 100, bonus: 100 }], discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
               aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 } };
  const b = M.calcBud({ nameKey: 'a', txn: 250, aov: 40, discount: 0.01, spiff_earned: 40 }, T, {});
  const m = M.calcMgr({ nameKey: 'm', sales: 100, target: 100, aov: 40, discount: 0.01, spiff_earned: 10 }, T, {}, []);
  ok('budtender: SPIFF is in bonus and out of payroll', b.spiff === 40 && b.bonus - b.payroll === 40);
  ok('manager: SPIFF is in bonus and out of payroll', m.spiff === 10 && m.bonus - m.payroll === 10);
  ok('the tile totals exactly the vendor share', M.incSpiffTotal([b, m]).total === 50);
}

{
  const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  console.log('\nLayout\n');
  ok('five columns on a wide screen', /\.crew-inc-tot \{ display: grid; grid-template-columns: repeat\(5,/.test(HTML));
  ok('wraps on a narrow one', /@media \(max-width: 1000px\) \{\s*\.crew-inc-tot \{ grid-template-columns: repeat\(auto-fit/.test(HTML));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
