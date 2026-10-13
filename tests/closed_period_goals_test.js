#!/usr/bin/env node
/* ─── A closed pay period shows each store's TARGET and % OF GOAL — and not one dollar moves ─────
 *
 *   RUN:  node tests/closed_period_goals_test.js
 *
 * WHY THIS EXISTS
 * Mike, 2026-10-12, attaching a printout of 2026-09-28 → 2026-10-11: Target and % Goal were a dash
 * for all six managers and for the admin row, while Sales, Discount, AOV, SPIFF, Bonus and Payroll
 * were all there. Approval froze the sales and the bonus and never the goal the bonus was tiered
 * against — HISTORY_HEADERS has never had a target — so every closed period lost the two columns
 * the moment it was approved. GX Core still had the goals; Crew just did not keep them.
 *
 * The fix keeps them in THEIR OWN TAB (crew_incentive_goals), written by the approval and read
 * back onto the closed-period payload. Most of this file is the part that needed care:
 *
 *   · THE PAY RECORD IS NOT WIDENED. History rows are read by position by the approval email, the
 *     payout PDF, the void log and the reopen; a display figure added there sits one column from a
 *     pay figure. So approval must still write rows exactly HISTORY_HEADERS wide, and the same rows
 *     whether or not the period carries goals.
 *
 *   · ATTACHING A TARGET MOVES NO FROZEN FIGURE. The same closed period is rendered and exported
 *     with goals and without, and the Capstone export must be byte-identical; on screen, only the
 *     Target and % Goal cells may differ. The silent failure this guards is the one already
 *     recorded in getIncentive_: frozen rows fed to the live math score every manager again.
 *
 *   · A MISSING GOAL IS A DASH, NOT A ZERO. The 27 periods imported from the payout PDFs have no
 *     goals and must keep saying so, and a store Core sent no target for is left out, not stored as 0.
 */
'use strict';
const fs = require('fs');
const H = require('./pay_engine_harness.js');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const GOALS = 'crew_incentive_goals';
const PP = '2026-09-28';
const period = (withGoals) => (pp) => ({ ok: true, payPeriod: { start: pp, end: '2026-10-11', current: false },
  budtenders: [{ employee_id: 'e1', name: 'One', bonus: 40, discount: 0.01, storeSlug: 'bend' }],
  managers: [
    { employee_id: 'm1', name: 'Mgr Bend', storeSlug: 'bend', storeName: 'Century', sales: 62029.55,
      discount: 0.005, aov: 40, target: withGoals ? 65634 : null },
    { employee_id: 'm2', name: 'Mgr Center', storeSlug: 'center', storeName: 'Center', sales: 24233.25,
      discount: 0.005, aov: 40, target: withGoals ? 22493 : null },
    /* Core sent this store no goal at all. It must be left out, not kept as zero. */
    { employee_id: 'm3', name: 'Mgr River', storeSlug: 'river-rd', storeName: 'River Rd', sales: 56630.68,
      discount: 0.005, aov: 40, target: withGoals ? 0 : null }],
  admin: { employee_id: 'a1', name: 'Admin', actual: 319187.3, stores: 6, target: withGoals ? 323889 : null },
  spiff: { ok: true }, unmatched: [] });

/* The record's moving parts stripped: imported_at (col 17) is a timestamp taken at write. */
const frozenRows = (E) => E.rows(H.HIST).filter(r => r[0] === PP).map(r => r.map((v, i) => i === 17 ? 'T' : v));

console.log('\nApproval keeps the goals — in their own tab, and the pay record is not widened');
let withRows, bareRows;
{
  const E = H.engine(); E.seedClosed(); E.live = period(true);
  const res = E.approve({ pp_start: PP, confirm: 'yes' });
  ok('the approval succeeds', res && res.ok === true);
  withRows = frozenRows(E);
  ok('every history row is still exactly 20 columns wide', withRows.length === 5 && withRows.every(r => r.length === 20));
  ok('no target figure appears anywhere in the pay record',
     !withRows.some(r => r.some(v => v === 65634 || v === 22493 || v === 323889)));

  const g = E.rows(GOALS);
  ok('one row is written to the goals tab', g.length === 1 && g[0][0] === PP);
  const stored = JSON.parse(g[0][1]);
  ok('…with each store\'s goal, keyed the way the history row names its store',
     stored.stores.bend === 65634 && stored.stores.center === 22493);
  ok('…and the company goal for the admin row', stored.admin === 323889);
  ok('a store with no goal is LEFT OUT, not stored as 0', !('river-rd' in stored.stores));
  ok('…marked as frozen by the approval, and by whom', g[0][4] === 'approval' && g[0][3] === 'sky');
  ok('goalsFor_ reads it back', E.goalsFor(PP).stores.bend === 65634 && E.goalsFor(PP).source === 'approval');
  ok('a period with nothing on file reads as null, not as an empty set', E.goalsFor('2025-09-01') === null);

  const B = H.engine(); B.seedClosed(); B.live = period(false);
  B.approve({ pp_start: PP, confirm: 'yes' });
  bareRows = frozenRows(B);
  ok('a period with no goals writes no goals row at all', B.rows(GOALS).length === 0);
  ok('THE PAY RECORD IS IDENTICAL with goals and without',
     JSON.stringify(withRows) === JSON.stringify(bareRows));
}

console.log('\nA reopened period approved again shows the goals of the approval that stands');
{
  const E = H.engine(); E.seedClosed(); E.live = period(true);
  E.approve({ pp_start: PP, confirm: 'yes' });
  E.unapprove({ pp_start: PP, confirm: 'yes', reason: 'a store goal was corrected after the close' });
  const second = period(true);
  E.live = (pp) => { const l = second(pp); l.managers[0].target = 60000; return l; };
  E.approve({ pp_start: PP, confirm: 'yes' });
  ok('the later goals win', E.goalsFor(PP).stores.bend === 60000);
}

console.log('\nAttaching goals to the closed payload adds a target and changes nothing else');
{
  const E = H.engine();
  const row = (id, store, sales) => ({ employee_id: id, section: 'manager', store_id: store, sales: sales,
    discount_pct: 0.5, aov: 40, spiff: 12.5, bonus: 87.5, per_hour: 1.09, payroll: 75, computed_payroll: 75,
    override_note: '' });
  const payload = () => ({ ok: true, pp_start: PP, source: 'imported',
    admin: { employee_id: 'a1', section: 'admin', sales: 319187.3, bonus: 0, payroll: 0, computed_payroll: 0 },
    managers: [row('m1', 'bend', 62029.55), row('m3', 'river-rd', 56630.68)],
    budtenders: [{ employee_id: 'e1', store_id: 'bend', sales: 9000, bonus: 40, payroll: 40 }] });
  const before = payload();
  const after = E.attachGoals(payload(), { admin: 323889, stores: { bend: 65634 }, source: 'backfill',
                                           frozen_at: '2026-10-12T20:00:00.000Z' });
  ok('the manager with a goal on file gets it', after.managers[0].target === 65634);
  ok('the manager without one gets NO target key — a dash, not a zero', !('target' in after.managers[1]));
  ok('the admin row gets the company goal', after.admin.target === 323889);
  ok('where the goals came from rides along', after.goals_source === 'backfill');
  const strip = (p) => { const c = JSON.parse(JSON.stringify(p));
    delete c.goals_source; delete c.goals_frozen_at; delete c.admin.target;
    c.managers.forEach(m => { delete m.target; }); return JSON.stringify(c); };
  ok('EVERY OTHER FIELD ON EVERY ROW IS UNTOUCHED', strip(after) === JSON.stringify(before));
  ok('budtender rows are not given a target', !after.budtenders.some(b => 'target' in b));
  const none = payload();
  ok('no goals on file leaves the payload exactly as it was',
     JSON.stringify(E.attachGoals(none, null)) === JSON.stringify(before));
}

/* ── The browser ─────────────────────────────────────────────────────────────────────────────── */
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();', cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) +
    '\n; return { incMgrTable, incAdminTable, incCsvRows, incFrozenPct, inc };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' },
    body: { classList: { add() {}, remove() {} } }, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: { setProperty() {} }, classList: { add() {} },
      setAttribute() {}, addEventListener() {}, appendChild() {} }), addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '', name: (id) => id } };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  return new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
    'navigator', src)(doc, win, store, store, { hostname: 'localhost' }, {});
})();

const T = { hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: [], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1.0, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 100, bonus: 300 }], maxPerStore: 50 } };

/* Frozen manager rows as incentive_history returns them. Bend missed its goal and was paid $75;
   Center beat its goal and was paid $250. Under the LIVE math with these targets both figures
   would come out different — which is what makes the comparison below mean something. */
const mgr = (id, name, store, sales, payroll, target) => {
  const r = { employee_id: id, pdf_name: name, full_name: name, store_label: store, store_id: store,
              sales: sales, discount_pct: 0.5, aov: 40, spiff: 12.5, bonus: payroll + 12.5,
              per_hour: 1.1, payroll: payroll, computed_payroll: payroll, override_note: '' };
  if (target != null) r.target = target;
  return r;
};
const closed = (withGoals) => ({ source: 'imported', can_edit: false, thresholds: T,
  pp_start: PP, pp_end: '2026-10-11', inputs: {}, budtenders: [],
  goals_source: withGoals ? 'backfill' : '', goals_frozen_at: withGoals ? '2026-10-12T20:00:00.000Z' : '',
  admin: Object.assign({ employee_id: 'a1', pdf_name: 'Admin Person', full_name: 'Admin Person',
                         sales: 319187.3, bonus: 0, payroll: 0, per_hour: 0 },
                       withGoals ? { target: 323889 } : {}),
  managers: [mgr('m1', 'Mgr Bend', 'bend', 62029.55, 75, withGoals ? 65634 : null),
             mgr('m2', 'Mgr Center', 'center', 24233.25, 250, withGoals ? 22493 : null)] });
const calcOf = (m) => ({ bonus: m.bonus, payroll: m.payroll, spiff: m.spiff, hr: m.per_hour,
  pct: M.incFrozenPct(m.sales, m.target), salesB: null, discB: null, aovB: null, teamA: m.team_attendance });
const admCalc = (a) => ({ bonus: a.bonus, payroll: a.payroll, pct: M.incFrozenPct(a.sales, a.target) });
const render = (d) => { M.inc.data = d;
  return { mgr: M.incMgrTable(d.managers, calcOf, true, false, T),
           adm: M.incAdminTable(d.admin, admCalc(d.admin), true),
           csv: JSON.stringify(M.incCsvRows(d, true)) }; };
/* Table cells, with markup removed, one array per row. */
const cells = (html) => html.split('<tr>').slice(1).map(tr =>
  tr.split(/<t[dh][^>]*>/).slice(1).map(c => c.replace(/<[^>]+>/g, '').trim()));

console.log('\nThe closed screen prints the goal and the percent');
const bare = render(closed(false)), full = render(closed(true));
{
  const rows = cells(full.mgr).filter(r => /Mgr/.test(r[0]));
  const bend = rows.find(r => r[0] === 'Mgr Bend'), center = rows.find(r => r[0] === 'Mgr Center');
  ok('Target shows the store goal', bend[2] === '$65,634' && center[2] === '$22,493');
  ok('% Goal is frozen sales over that goal', bend[4] === '94.5%' && center[4] === '107.7%');
  ok('a store that beat its goal is marked as a hit, one that missed is not',
     /crew-inc-hit[^>]*>107\.7%/.test(full.mgr) && !/crew-inc-hit[^>]*>94\.5%/.test(full.mgr));
  const adm = cells(full.adm).pop();
  ok('the admin row shows the company goal and percent', adm[2] === '$323,889' && adm[4] === '98.5%');
  ok('a goal read after the close says so on hover', /read from GX Core on 2026-10-12/.test(full.mgr));
  const none = cells(bare.mgr).filter(r => /Mgr/.test(r[0]));
  ok('with no goal on file both cells stay a dash — the 27 PDF periods keep saying they do not know',
     none.every(r => r[2] === '—' && r[4] === '—'));
  ok('…and no hover note is invented for them', !/read from GX Core/.test(bare.mgr));
}

console.log('\nShowing the goal moves NO frozen figure');
{
  ok('the Capstone export is byte-identical with goals and without', bare.csv === full.csv);
  ok('…and it does carry the paid figures (the comparison is not passing on an empty file)',
     /75\.00/.test(full.csv) && /250\.00/.test(full.csv));
  const a = cells(bare.mgr), b = cells(full.mgr);
  const diff = [];
  a.forEach((r, i) => r.forEach((c, j) => { if (c !== b[i][j]) diff.push(j); }));
  ok('on the manager table ONLY the Target and % Goal columns differ',
     diff.length === 4 && diff.every(j => j === 2 || j === 4));
  const x = cells(bare.adm), y = cells(full.adm);
  const adiff = [];
  x.forEach((r, i) => r.forEach((c, j) => { if (c !== y[i][j]) adiff.push(j); }));
  ok('…and on the admin table the same two', adiff.length === 2 && adiff.every(j => j === 2 || j === 4));
  /* What the live math would have paid on these targets: Bend 0 + 100 + 50 = $150, Center
     200 + 100 + 50 = $350. Neither may appear — the record says $75 and $250. */
  ok('the frozen payroll is what prints, not a re-score against the goal',
     /\$75/.test(full.mgr) && /\$250/.test(full.mgr) && !/\$150/.test(full.mgr) && !/\$350/.test(full.mgr));
}

console.log('\nThe percent is a label: null whenever either number is missing');
{
  ok('no target', M.incFrozenPct(62029.55, undefined) === null && M.incFrozenPct(62029.55, null) === null);
  ok('a zero or junk target', M.incFrozenPct(100, 0) === null && M.incFrozenPct(100, 'x') === null);
  ok('no recorded sales', M.incFrozenPct(null, 65634) === null && M.incFrozenPct('', 65634) === null);
  ok('real numbers divide', Math.abs(M.incFrozenPct(50, 200) - 25) < 1e-9);
}

console.log('\nThe ENGINE half — wired where it has to be, and nowhere near the pay record');
{
  const GS = H.SRC;
  ok('incentiveHistory_ attaches the goals to the closed payload',
     /attachGoals_\(out, goalsFor_\(want\)\)/.test(H.fnSrc('incentiveHistory_')));
  const ap = H.fnSrc('incentiveApprove_');
  ok('approval freezes them AFTER the workflow is marked approved, and cannot be failed by them',
     ap.indexOf('try { freezeGoals_(') > ap.indexOf("wfSet_(pp, { status: 'approved'") &&
     ap.indexOf("wfSet_(pp, { status: 'approved'") > 0);
  ok('HISTORY_HEADERS did not grow a target column', !/'target'/.test(GS.slice(GS.indexOf('var HISTORY_HEADERS'),
     GS.indexOf('];', GS.indexOf('var HISTORY_HEADERS')))));
  const bf = H.fnSrc('incentiveGoalsBackfill_');
  ok('the backfill is deploy-secret', /if \(!deploySecretOk_\(p\)\) return/.test(bf));
  ok('…writes only through freezeGoals_ — never the history sheet',
     bf.indexOf('historySheet_') < 0 && bf.indexOf('setValues') < 0 && bf.indexOf('deleteRow') < 0);
  ok('…refuses a period that came from a payout PDF', /!== 'approved'/.test(bf));
  ok('…and is a dry run unless confirmed', /String\(p\.confirm \|\| ''\) !== 'yes'/.test(bf));
  ok('the practice reset clears the goals twin too',
     /\[HISTORY_TAB, INPUTS_TAB, WF_TAB, VOID_TAB, SCHEME_TAB, GOALS_TAB\]/.test(H.fnSrc('incentivePracticeReset_')));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
