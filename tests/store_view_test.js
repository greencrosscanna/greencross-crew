#!/usr/bin/env node
/* ─── The one-store view shows the SAME figures, and its address follows the screen ──────────────
 *
 *   RUN:  node tests/store_view_test.js
 *
 * WHY
 * The store view (#incentive/<period>/<store_id>) is a FILTER over the payload the all-store screen
 * already holds. It exists so a director can review one store with its manager. The way it could
 * cost money is by quietly becoming a second calculation: a manager's team-attendance bonus counts
 * their store's budtenders, so computing it from an already-filtered list, or re-deriving a closed
 * period's pay, would put a different number on one page than on the other — both plausible.
 *
 * Everything here drives the SHIPPED paintIncentive / incParseHash / incSyncHash / loadIncentive,
 * not copies. WHAT MUST HOLD:
 *   1. Every row for the store is byte-identical to the same row on the all-store screen
 *      (live AND closed), and the store's tiles are the sums of those rows.
 *   2. Nothing from another store, and no Admin, appears in the store view.
 *   3. A closed period is never recomputed: frozen figures render as stored, a missing Target is a
 *      dash, and the calcs are not consulted for them.
 *   4. The address names period + store, opens straight to them, and FOLLOWS the period picker and
 *      the store choice — it used to be read once and never written.
 *   5. The store comes from the registry's key (store_id); the names come from GXStores.
 *   6. The print page names the store; the store view offers no approve/send/export step.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

function mkEl() {
  const e = { className: '', innerHTML: '', style: { setProperty() {} },
    classList: { add() {}, remove() {} }, children: [], setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, appendChild(c) { return c; }, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [], focus() {} };
  return e;
}
const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' }, title: 'GX Crew',
  body: mkEl(), activeElement: null, getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], createElement: () => mkEl(), addEventListener() {} };
const NAMES = { bend: 'Bend', 'river-rd': 'River Rd', hillsboro: 'Hillsboro' };
const loc = { hash: '', pathname: '/crew/', search: '' };
const win = { GXClient: () => ({ jsonp: async () => ({}) }), location: loc,
  GXStores: { color: () => '', name: s => NAMES[s] || '' }, addEventListener() {}, print() {} };
const writes = [];
global.history = { replaceState(_a, _b, url) { writes.push(url); loc.hash = url.slice(url.indexOf('#')); } };
const store = { getItem: () => '', setItem() {}, removeItem() {} };

let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const TAIL = '})();', cut = src.lastIndexOf(TAIL);
src = src.slice(0, cut) +
  '\n; return { paintIncentive, loadIncentive, incReadHash, incParseHash, incHashFor, incSyncHash,\n' +
  '   incOnHashChange, incDocName, calcBud, calcMgr, inc, state,\n' +
  '   __ui:(h)=>{ ui={inc:h,subnav:{style:{}},rail:{style:{}},pane:{style:{}}}; },\n' +
  '   __eng:(e)=>{Engine=e;}, __tok:(f)=>{token=f;} };\n' + src.slice(cut);
src = src.replace('(function () {', 'return (function () {');
const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
  'navigator', src)(doc, win, store, store, loc, {});

const T = { hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: [], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1.0, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 100, bonus: 100 }], discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 100, bonus: 300 }], maxPerStore: 50 } };

/* Two stores, a floater booked to corporate, an admin. storeSlug is Leaderboard's word and store_id
   is the registry's; the screen filters on store_id. */
const S = { bend: 'bend', riv: 'river-rd' };
const bud = (id, n, sid, slug) => ({ employee_id: id, name: n, store_id: sid, storeSlug: slug,
  storeName: NAMES[sid], txn: 250, sales: 9000, discount: 0.005, aov: 36 });
const mgr = (id, n, sid, slug, target) => ({ employee_id: id, name: n, store_id: sid, storeSlug: slug,
  storeName: NAMES[sid], sales: 100000, target, discount: 0.008, aov: 35 });
const LIVE = { source: 'live', can_edit: true, can_approve: true, thresholds: T, pp_start: '2026-10-12',
  payPeriod: { start: '2026-10-12', end: '2026-10-25', current: true },
  periods: [{ pp_start: '2026-10-12', pp_end: '2026-10-25', source: 'live' },
            { pp_start: '2026-09-28', pp_end: '2026-10-11', source: 'imported' }],
  budtenders: [bud('b1', 'Ann Bend', S.bend, 'bend'), bud('b2', 'Bee Bend', S.bend, 'bend'),
               bud('r1', 'Rae River', S.riv, 'river'), bud('r2', 'Roy River', S.riv, 'river'),
               bud('r3', 'Ray River', S.riv, 'river'),
               { employee_id: 'f1', name: 'Fay Floater', store_id: 'corporate', storeSlug: 'corporate',
                 txn: 300, sales: 9000, discount: 0.004, aov: 40 }],
  managers: [mgr('mb', 'Mia Bend-Mgr', S.bend, 'bend', 90000), mgr('mr', 'Moe River-Mgr', S.riv, 'river', 120000)],
  admin: { employee_id: 'ad', name: 'Ada Admin', sales: 200000, target: 210000, stores: 2 },
  inputs: { b1: { att: true }, r1: { att: true }, r2: { att: true } } };

const host = mkEl();
M.__ui(host);
M.__tok(() => 'tok');
const paint = (data, storeId) => {
  M.inc.data = JSON.parse(JSON.stringify(data)); M.inc.loading = false; M.inc.error = '';
  M.inc.pp = data.pp_start; M.inc.store = storeId || ''; M.state.tab = 'incentive';
  host.innerHTML = ''; M.paintIncentive(); return host.innerHTML;
};
/* A person's row, cut out of the page — the whole <tr>, every cell. */
const rowOf = (html, name) => {
  const i = html.indexOf(name); if (i < 0) return null;
  return html.slice(html.lastIndexOf('<tr', i), html.indexOf('</tr>', i) + 5);
};
const tile = (html, label) => {
  const i = html.indexOf('<dt>' + label + '</dt>'); if (i < 0) return null;
  const s = html.lastIndexOf('<dd>', i); return html.slice(s + 4, html.indexOf('</dd>', s));
};

console.log('\nLive period — one store is a filter, not a second calculation\n');
{
  const all = paint(LIVE, ''), riv = paint(LIVE, 'river-rd'), bend = paint(LIVE, 'bend');
  ['Moe River-Mgr', 'Rae River', 'Roy River', 'Ray River'].forEach((n) =>
    ok(n + ': the row is byte-identical to the all-store screen', rowOf(riv, n) && rowOf(riv, n) === rowOf(all, n)));
  ok('Bend\'s manager row is identical too (team attendance counts Bend\'s ticks only)',
     rowOf(bend, 'Mia Bend-Mgr') === rowOf(all, 'Mia Bend-Mgr'));
  ok('no floater and no admin in a store\'s page', !riv.includes('Fay Floater') && !riv.includes('Ada Admin'));
  ok('and River\'s page carries no Bend person', !riv.includes('Ann Bend') && !riv.includes('Mia Bend-Mgr'));
  /* Totals are the sum of the rows the page shows, by the same calcs. */
  const calcs = (b) => M.calcBud(b, T, LIVE.inputs);
  const rb = LIVE.budtenders.filter((b) => b.store_id === 'river-rd');
  const mg = LIVE.managers[1];
  const budSum = rb.reduce((a, b) => a + (calcs(b).payroll), 0);
  const mgSum = M.calcMgr(mg, T, LIVE.inputs, LIVE.budtenders).payroll;
  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  ok('Budtender tile = River\'s budtenders only', tile(riv, 'Budtender bonuses') === fmt(budSum + 0) ||
     tile(riv, 'Budtender bonuses') === fmt(rb.reduce((a, b) => a + calcs(b).bonus, 0)));
  ok('Manager tile = River\'s manager, with team attendance from the FULL list', tile(riv, 'Manager bonuses') === fmt(M.calcMgr(mg, T, LIVE.inputs, LIVE.budtenders).bonus));
  ok('Store payroll tile = River\'s manager + budtenders', tile(riv, 'Store payroll') === fmt(budSum + mgSum));
  ok('no Admin tile, no all-store total', !riv.includes('<dt>Admin</dt>') && !riv.includes('<dt>Total payroll</dt>'));
  ok('the all-store screen is unchanged: Admin and Total payroll present, no store picker value',
     all.includes('<dt>Admin</dt>') && all.includes('<dt>Total payroll</dt>') && all.includes('Ada Admin'));
  ok('the heading names the store and the period line is there',
     /crew-inc-title">Incentive — River Rd</.test(riv) && riv.includes('Pay period 2026-10-12'));
  ok('the store picker lists stores from the payload, not corporate, current one selected',
     riv.includes('<option value="river-rd" selected>River Rd</option>') &&
     riv.includes('<option value="bend">Bend</option>') && !riv.includes('value="corporate"'));
  ok('no approve / send / export / gear in the store view; print and a way back are',
     !/id="incApprove"|id="incSend"|id="incCsv"|id="incGear"/.test(riv) &&
     riv.includes('id="incStorePrint"') && riv.includes('id="incAllStores"'));
  ok('the store view is marked for the print stylesheet', riv.includes('crew-inc-body crew-inc-storeview'));
  ok('an unknown store says so instead of showing an empty page as if it were fine',
     /No one is on record for this store/.test(paint(LIVE, 'hillsboro')));
}

console.log('\nClosed period — as paid, never recomputed\n');
{
  const FROZEN = { source: 'imported', can_edit: false, thresholds: null, pp_start: '2026-09-28',
    payPeriod: { start: '2026-09-28', end: '2026-10-11' }, periods: LIVE.periods,
    managers: [{ pdf_name: 'Moe River-Mgr', store_id: 'river-rd', store_label: 'River Rd', sales: 100000,
                 target: 125000, discount_pct: 0.8, aov: 35, bonus: 777, payroll: 777, per_hour: 9.71, team_attendance: 55 },
               { pdf_name: 'Mia Bend-Mgr', store_id: 'bend', store_label: 'Bend', sales: 80000,
                 target: null, discount_pct: 0.9, aov: 34, bonus: 640, payroll: 640, per_hour: 8 }],
    budtenders: [{ pdf_name: 'Rae River', store_id: 'river-rd', store_label: 'River Rd', txn: 250, sales: 9000,
                   discount_pct: 0.5, aov: 36, bonus: 333, payroll: 333, spiff: 12, per_hour: 4.1 }],
    admin: { pdf_name: 'Ada Admin', bonus: 300, payroll: 300 }, inputs: {} };
  const all = paint(FROZEN, ''), riv = paint(FROZEN, 'river-rd'), bend = paint(FROZEN, 'bend');
  ok('frozen figures render as stored (777 / 333 are not what any calc could produce)',
     riv.includes('$777') && riv.includes('$333'));
  ok('rows match the all-store screen byte for byte',
     rowOf(riv, 'Moe River-Mgr') === rowOf(all, 'Moe River-Mgr') && rowOf(riv, 'Rae River') === rowOf(all, 'Rae River'));
  ok('Target and % Goal show on a period that has a goal', riv.includes('$125,000') && /80\.0%/.test(rowOf(riv, 'Moe River-Mgr')));
  ok('a period with no recorded goal keeps its dash — no Target invented',
     /crew-inc-bar[^>]*><span class="crew-inc-zero" title="Not recorded in this report">—<\/span>/.test(rowOf(bend, 'Mia Bend-Mgr')) &&
     rowOf(bend, 'Mia Bend-Mgr') === rowOf(all, 'Mia Bend-Mgr'));
  ok('the store total is the stored payroll, summed', tile(riv, 'Store payroll') === '$1,110');
}

console.log('\nThe address names the store and period, and follows the screen\n');
{
  ok('shape: #incentive/<period>/<store_id>', M.incHashFor('2026-09-28', 'bend') === '#incentive/2026-09-28/bend');
  ok('no store → the old all-store address, unchanged', M.incHashFor('2026-09-28', '') === '#incentive/2026-09-28');
  ok('parses period + store', JSON.stringify(M.incParseHash('#incentive/2026-09-28/river-rd')) === '{"pp":"2026-09-28","store":"river-rd"}');
  ok('parses the old links', JSON.stringify(M.incParseHash('#incentive/2026-09-28')) === '{"pp":"2026-09-28","store":""}' &&
     JSON.stringify(M.incParseHash('#incentive')) === '{"pp":"","store":""}');
  ok('refuses things that are not incentive addresses', M.incParseHash('#approve/2026-09-28/abc123') === null && M.incParseHash('#incentive/a/b/c') === null);

  loc.hash = '#incentive/2026-09-28/river-rd'; M.inc.pp = ''; M.inc.store = ''; M.state.tab = 'roster';
  ok('opening the address lands on that period, that store, on the Incentive tab',
     M.incReadHash() === true && M.inc.pp === '2026-09-28' && M.inc.store === 'river-rd' && M.state.tab === 'incentive');

  /* The picker: a period change goes through loadIncentive, then the address must have moved. */
  M.__eng({ jsonp: async (_a, p) => Object.assign(JSON.parse(JSON.stringify(LIVE)), { pp_start: p.pp_start }) });
  writes.length = 0; loc.hash = '#incentive/2026-09-28/river-rd';
  (async () => {
    await M.loadIncentive('2026-10-12');
    ok('picking a period rewrites the address and keeps the store', loc.hash === '#incentive/2026-10-12/river-rd');
    M.inc.store = 'bend'; M.paintIncentive();
    ok('picking a store rewrites the address and keeps the period', loc.hash === '#incentive/2026-10-12/bend');
    M.inc.store = ''; M.paintIncentive();
    ok('"All stores" puts the all-store address back (works on the old screen too)', loc.hash === '#incentive/2026-10-12');
    const n = writes.length; M.paintIncentive();
    ok('a repaint that changes nothing writes nothing', writes.length === n);
    M.state.tab = 'roster'; M.inc.store = 'bend'; M.paintIncentive();
    ok('off the Incentive tab the address is left alone', loc.hash === '#incentive/2026-10-12');
    ok('print title names the store so it cannot be filed over the payout record',
       (M.state.tab = 'incentive', M.inc.store = 'river-rd', M.inc.data = JSON.parse(JSON.stringify(LIVE)), true) &&
       (host.style = { display: '' }, M.incDocName() === 'Incentive Dashboard - River Rd - 101226-102526'));
    M.inc.store = '';
    ok('and the all-store name is exactly what it was', M.incDocName() === 'Incentive Dashboard - 101226-102526');

    const src2 = fs.readFileSync(__dirname + '/../index.html', 'utf8');
    ok('print stylesheet hides the store picker and keeps the store page on one sheet',
       /\.crew-inc-storepick/.test(src2) && /\.crew-inc-storeview \.crew-inc-tbl td/.test(src2));
    console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
    process.exit(fail ? 1 : 0);
  })();
}
