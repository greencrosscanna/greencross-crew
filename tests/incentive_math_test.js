#!/usr/bin/env node
/* ─── Crew incentive bonus math — differential test against Leaderboard ───────────────────────────
 *
 *   RUN:  node tests/incentive_math_test.js    (from the repo root; no deps, no network, no login)
 *
 * WHY THIS EXISTS
 * The Incentive dashboard is being transplanted from Leaderboard into Crew (2026-08-26). Every other
 * test in this repo guards something that fails LOUDLY or hides a person; this one guards the only
 * thing in the app that can quietly hand somebody the wrong amount of money. Crew's CLAUDE.md is
 * blunt about it: never cut over live payroll numbers without a penny-match against the current
 * Leaderboard output.
 *
 * A penny-match against a real pay period needs live credentials and a period that has closed, so it
 * happens ONCE, by hand, immediately before cutover. It cannot run on a push, and it only ever covers
 * the handful of rows that period happened to contain — real data does not reliably sit on the
 * threshold boundaries, which is exactly where a porting slip hides.
 *
 * So this is the check that DOES run on every push: a frozen copy of Leaderboard's three original
 * functions is driven alongside Crew's port over a generated grid that lands on every boundary in the
 * scheme — the transaction bar (both the normal and low-volume one), the AOV target, the discount
 * ceiling, each manager sales tier, both derived manager discount tiers, every admin tier and the
 * admin per-store cap — and asserts the two agree EXACTLY, field by field. Not "to the cent": both
 * sides run identical float operations, so any difference at all is a port bug, and rounding the
 * comparison would hide the small ones.
 *
 * THE ORACLE IS A FROZEN COPY, ON PURPOSE
 * `LB` below is Leaderboard's code as it stood at the transplant, closure state and all. Reading the
 * live ../greencross-leaderboard/index.html instead would be more faithful for about a week and then
 * permanently broken, because that dashboard gets DELETED once Crew's version is verified — and a
 * test that dies with the thing it was checking takes the guarantee with it. Frozen, it goes on
 * meaning something afterwards: it is the arithmetic that paid people, kept where a future edit to
 * Crew's version has to answer to it.
 *
 * While Leaderboard's copy still exists, `driftCheck()` re-reads it and fails if the frozen oracle no
 * longer matches the shipped source, so the two cannot diverge unnoticed during the transition. Once
 * the file is gone the check reports that it skipped, and the frozen comparison carries on alone.
 */
'use strict';
const fs = require('fs');

let fail = 0;
function bad(msg) { fail++; console.log('  ✗ ' + msg); }

/* ── The oracle: Leaderboard index.html, `incentive` module, verbatim at 2026-08-26 ──────────────
   Closure state (_T, _inp, _d) is preserved exactly as it reads there — the point of a frozen
   reference is that it is not tidied. Crew's port takes the same values as arguments instead;
   that difference is the whole reason a differential test is possible. */
const LB = (function () {
  let _T = null, _inp = {}, _d = null;
  function setState(T, inp, d) { _T = T; _inp = inp; _d = d; }
  function inpOf(k) { var i = _inp[k]; return { att: !!(i && i.att), spiff: (i && +i.spiff) || 0 }; }
  function calcBud(b) {
    var T = _T.budtender, i = inpOf(b.nameKey);
    var low  = (T.lowVolStores || []).indexOf(b.storeSlug) !== -1;
    var qual = b.txn >= (low ? T.txnQualifyLowVol : T.txnQualify);
    var aovB = (qual && b.aov >= T.aovTarget) ? T.aovBonus : 0;
    var disB = (qual && b.discount * 100 <= T.discountMaxPct) ? T.discountBonus : 0;
    var attB = i.att ? T.attendanceBonus : 0;
    var bonus = aovB + disB + attB + i.spiff;
    return { qual: qual, bonus: bonus, payroll: bonus - i.spiff, hr: bonus / _T.hoursPerPeriod };
  }
  function teamAtt(slug) {
    return _d.budtenders.filter(function(b) { return b.storeSlug === slug && inpOf(b.nameKey).att; }).length;
  }
  function calcMgr(mgr) {
    var T = _T.manager, i = inpOf(mgr.nameKey);
    var p = mgr.target > 0 ? mgr.sales / mgr.target * 100 : 0;
    var sB = 0; for (var a = 0; a < T.salesTiers.length; a++)    { if (p  >= T.salesTiers[a].pct)    { sB = T.salesTiers[a].bonus; break; } }
    // Store-discount tiers follow the discount goal: meet goal → lower bonus,
    // beat it by a third (≤ goal × ⅔) → higher bonus. Only the $ are stored.
    var goal = _T.budtender.discountMaxPct;
    var mgrDiscTiers = [
      { maxPct: goal * 2 / 3, bonus: T.discountTiers[0].bonus },
      { maxPct: goal,         bonus: T.discountTiers[1].bonus },
    ];
    var dp = mgr.discount * 100, dB = 0;
    for (var c = 0; c < mgrDiscTiers.length; c++)               { if (dp <= mgrDiscTiers[c].maxPct) { dB = mgrDiscTiers[c].bonus; break; } }
    var aB = mgr.aov >= T.aovTarget ? T.aovBonus : 0;
    var tA = teamAtt(mgr.storeSlug) * T.teamAttendancePerHead;
    var payroll = sB + dB + aB + tA, bonus = payroll + i.spiff;
    return { pct: p, teamA: tA, payroll: payroll, bonus: bonus, hr: bonus / _T.hoursPerPeriod };
  }
  function calcAdmin() {
    var T = _T.admin, a = _d.admin;
    var p = a.target > 0 ? a.actual / a.target * 100 : 0;
    var tier = 0; for (var t = 0; t < T.tiers.length; t++) { if (p >= T.tiers[t].pct) { tier = T.tiers[t].bonus; break; } }
    var bonus = Math.min(tier, a.stores * T.maxPerStore);
    return { pct: p, bonus: bonus, hr: bonus / _T.hoursPerPeriod };
  }
  return { setState, calcBud, calcMgr, calcAdmin };
})();

/* Leaderboard's incentiveDefaults_() (endpoints.gs), verbatim. */
function defaults() {
  return {
    hoursPerPeriod: 80,
    budtender: {
      txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center', 'portland'],
      aovTarget: 33, aovBonus: 25,
      discountMaxPct: 1.5, discountBonus: 25,
      attendanceBonus: 15,
    },
    manager: {
      salesTiers: [ { pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 } ],
      discountTiers: [ { maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 } ],
      aovTarget: 33, aovBonus: 50,
      teamAttendancePerHead: 25,
    },
    admin: { tiers: [ { pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 } ], maxPerStore: 50 },
  };
}

/* ── Crew's port, loaded from the SHIPPED crew.js ────────────────────────────────────────────────
   Same seam the roster tests use: splice a `return` into the IIFE tail so this exercises the real
   file rather than a copy that can drift from it. */
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();';
  const cut = src.lastIndexOf(TAIL);
  if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
  src = src.slice(0, cut) +
        '\n; return { calcBud, calcMgr, calcAdmin, incInput, incTeamAtt };\n' +
        src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  /* readyState 'loading' keeps boot() from firing — this file tests pure arithmetic, and a boot
     would want a network and a session. */
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

/* ── The grid ────────────────────────────────────────────────────────────────────────────────────
   Every value sits ON a threshold or one step either side of it. Comparisons are `>=` for AOV and
   `<=` for discount, so the exact-equality case is a real branch in both directions and belongs in
   the grid rather than being approximated by "close enough". */
const TXNS      = [0, 149, 150, 151, 199, 200, 201, 400];
const AOVS      = [0, 32.99, 33, 33.01, 60];
const DISCOUNTS = [0, 0.0099, 0.01, 0.0101, 0.0149, 0.015, 0.0151, 0.03];   // 1.0% = the derived manager tier
const SPIFFS    = [0, 25, 50.5];
const STORES    = ['center', 'portland', 'bend', 'river-rd'];               // first two are low-volume

/* Budtenders: full cross product of the boundaries, both attendance states. */
let budCases = [];
let n = 0;
STORES.forEach(slug => TXNS.forEach(txn => AOVS.forEach(aov => DISCOUNTS.forEach(discount =>
  SPIFFS.forEach(spiff => [true, false].forEach(att => {
    budCases.push({ row: { nameKey: 'b' + (n++), storeSlug: slug, txn, aov, discount }, att, spiff });
  }))))));

const T = defaults();
const inputs = {};
budCases.forEach(c => { inputs[c.row.nameKey] = { att: c.att, spiff: c.spiff }; });
const budRows = budCases.map(c => c.row);

/* Compare every field the two sides share. Exact equality: identical float ops on both sides, so a
   difference of any size is a port bug, and a tolerance would swallow the small ones. */
function same(label, a, b, keys) {
  for (const k of keys) {
    if (!Object.is(a[k], b[k])) { bad(label + ' — ' + k + ': Leaderboard ' + a[k] + ' vs Crew ' + b[k]); return false; }
  }
  return true;
}

LB.setState(T, inputs, { budtenders: budRows, admin: null });
let budChecked = 0;
for (const c of budCases) {
  const lb = LB.calcBud(c.row);
  const cw = M.calcBud(c.row, T, inputs);
  if (!same('budtender ' + c.row.storeSlug + ' txn=' + c.row.txn + ' aov=' + c.row.aov +
            ' disc=' + c.row.discount + ' spiff=' + c.spiff + ' att=' + c.att, lb, cw,
            ['qual', 'bonus', 'payroll', 'hr'])) break;
  budChecked++;
}
console.log((budChecked === budCases.length ? '  ✓' : '  ✗') +
  ' budtender: ' + budChecked + '/' + budCases.length + ' boundary combinations agree exactly');

/* Managers: sales % against each tier edge, both derived discount tiers, AOV edge, and a real team
   behind them so teamAttendancePerHead is exercised rather than multiplied by zero. */
const MGR_PCTS = [0, 99, 99.99, 100, 104.99, 105, 109.99, 110, 150];
let mgrChecked = 0, mgrTotal = 0;
for (const slug of STORES) {
  for (const pct of MGR_PCTS) {
    for (const discount of DISCOUNTS) {
      for (const aov of AOVS) {
        for (const spiff of SPIFFS) {
          const target = 100000;
          const mgr = { nameKey: 'm_' + slug, storeSlug: slug, target, sales: target * pct / 100, discount, aov };
          inputs[mgr.nameKey] = { att: false, spiff };
          LB.setState(T, inputs, { budtenders: budRows, admin: null });
          const lb = LB.calcMgr(mgr);
          const cw = M.calcMgr(mgr, T, inputs, budRows);
          mgrTotal++;
          if (!same('manager ' + slug + ' pct=' + pct + ' disc=' + discount + ' aov=' + aov + ' spiff=' + spiff,
                    lb, cw, ['pct', 'teamA', 'payroll', 'bonus', 'hr'])) { slug && (mgrChecked = -1); break; }
          mgrChecked++;
        }
      }
    }
  }
}
console.log((mgrChecked === mgrTotal ? '  ✓' : '  ✗') +
  ' manager: ' + mgrChecked + '/' + mgrTotal + ' boundary combinations agree exactly');

/* Admin: every tier edge, plus store counts that make the per-store cap bite. With maxPerStore 50,
   four stores cap at $200 — below every tier — so the cap is the operative number, not the tier. */
let admChecked = 0, admTotal = 0;
for (const pct of [0, 99, 100, 104.99, 105, 109.99, 110, 130]) {
  for (const stores of [1, 4, 6, 12, 20]) {
    const target = 1000000;
    const admin = { target, actual: target * pct / 100, stores };
    LB.setState(T, inputs, { budtenders: budRows, admin });
    const lb = LB.calcAdmin();
    const cw = M.calcAdmin(admin, T);
    admTotal++;
    if (!same('admin pct=' + pct + ' stores=' + stores, lb, cw, ['pct', 'bonus', 'hr'])) break;
    admChecked++;
  }
}
console.log((admChecked === admTotal ? '  ✓' : '  ✗') +
  ' admin: ' + admChecked + '/' + admTotal + ' tier and cap combinations agree exactly');

/* ── The properties the grid alone would not state out loud ──────────────────────────────────────
   Each of these is a rule someone could "clean up" without any boundary case changing colour. */

/* SPIFF is vendor money and must never reach the Capstone export, which carries `payroll` only. */
(function () {
  const row = { nameKey: 'sp', storeSlug: 'bend', txn: 400, aov: 40, discount: 0.001 };
  const withS = M.calcBud(row, T, { sp: { att: true, spiff: 500 } });
  const noS   = M.calcBud(row, T, { sp: { att: true, spiff: 0 } });
  if (withS.payroll !== noS.payroll) bad('budtender payroll must exclude SPIFF (vendor-funded, not payroll)');
  else console.log('  ✓ budtender payroll excludes SPIFF, however large');
  if (withS.bonus - withS.payroll !== 500) bad('budtender bonus must be payroll + SPIFF');
})();

(function () {
  const mgr = { nameKey: 'mg', storeSlug: 'bend', target: 100, sales: 120, discount: 0.001, aov: 40 };
  const withS = M.calcMgr(mgr, T, { mg: { att: false, spiff: 500 } }, []);
  const noS   = M.calcMgr(mgr, T, { mg: { att: false, spiff: 0 } }, []);
  if (withS.payroll !== noS.payroll) bad('manager payroll must exclude SPIFF');
  else console.log('  ✓ manager payroll excludes SPIFF (built from the opposite direction)');
})();

/* Missing the transaction bar costs the performance bonuses, never attendance. */
(function () {
  const r = M.calcBud({ nameKey: 'q', storeSlug: 'bend', txn: 1, aov: 99, discount: 0 }, T, { q: { att: true, spiff: 0 } });
  if (r.qual) bad('1 transaction must not qualify at a full-volume store');
  if (r.aovB !== 0 || r.disB !== 0) bad('unqualified staff must not draw the AOV or discount bonus');
  if (r.attB !== T.budtender.attendanceBonus) bad('attendance is not gated by qualifying — showing up is not a volume metric');
  else console.log('  ✓ unqualified staff keep attendance, lose the performance bonuses');
})();

/* The low-volume list is what separates the two transaction bars; 150 txns is a pass at Center and
   a fail at Bend, and a store dropping off that list silently costs its whole team two bonuses. */
(function () {
  const at = slug => M.calcBud({ nameKey: 'lv', storeSlug: slug, txn: 150, aov: 40, discount: 0 }, T, {}).qual;
  if (!at('center') || at('bend')) bad('150 txns must qualify at a low-volume store and not at a full-volume one');
  else console.log('  ✓ the low-volume transaction bar applies only to the listed stores');
})();

/* A manager's discount cut-offs are DERIVED from the budtender goal — the stored tiers contribute
   only their dollar amounts. Moving the budtender goal must move the manager tiers with it; if a
   future edit reads `discountTiers[].maxPct` instead, this is the test that catches it. */
(function () {
  const T2 = defaults(); T2.budtender.discountMaxPct = 3.0;         // tiers become ≤2.0% and ≤3.0%
  const mgr = { nameKey: 'd', storeSlug: 'bend', target: 100, sales: 0, discount: 0.025, aov: 0 };
  const moved = M.calcMgr(mgr, T2, {}, []);
  const base  = M.calcMgr(mgr, T,  {}, []);
  if (moved.discB !== T.manager.discountTiers[1].bonus) bad('2.5% should sit in the lower tier once the goal moves to 3%');
  if (base.discB !== 0) bad('2.5% should earn nothing while the goal is 1.5%');
  if (moved.discB === base.discB) bad('manager discount tiers must follow the budtender goal, not the stored maxPct');
  else console.log('  ✓ manager discount tiers derive from the budtender goal, not the stored maxPct');
})();

/* Tier arrays match high-to-low on the first hit. Re-sorted ascending, 112% would pay the 100 tier. */
(function () {
  const mgr = { nameKey: 'z', storeSlug: 'bend', target: 100, sales: 112, discount: 1, aov: 0 };
  if (M.calcMgr(mgr, T, {}, []).salesB !== 300) bad('112% of goal must pay the 110 tier, not a lower one it also clears');
  else console.log('  ✓ sales tiers pay the highest tier cleared, not the first one passed');
  const a = M.calcAdmin({ target: 100, actual: 112, stores: 20 }, T);
  if (a.bonus !== 600) bad('admin at 112% must pay the 110 tier when the cap allows');
})();

/* The per-store cap can beat the tier, and does at every store count we actually run. */
(function () {
  const capped = M.calcAdmin({ target: 100, actual: 200, stores: 4 }, T);
  if (capped.bonus !== 200) bad('4 stores must cap the admin bonus at $200 regardless of tier');
  else console.log('  ✓ the admin per-store cap overrides the tier when it is lower');
})();

/* A zero target must not produce Infinity or NaN — an unset store goal is a normal mid-setup state. */
(function () {
  const m = M.calcMgr({ nameKey: 'zt', storeSlug: 'bend', target: 0, sales: 5000, discount: 0, aov: 0 }, T, {}, []);
  const a = M.calcAdmin({ target: 0, actual: 5000, stores: 6 }, T);
  if (!Number.isFinite(m.pct) || m.pct !== 0) bad('a manager with no target must read 0%, not Infinity/NaN');
  else if (!Number.isFinite(a.pct) || a.pct !== 0) bad('an admin with no target must read 0%, not Infinity/NaN');
  else console.log('  ✓ an unset goal reads 0%, never Infinity or NaN');
})();

/* ── Drift check ─────────────────────────────────────────────────────────────────────────────────
   While Leaderboard's dashboard still exists, the frozen oracle above must still match it. Compares
   whitespace-normalised bodies so a reformat does not fail the push, but any change to the
   arithmetic does. Skips cleanly once the file is gone — which is the plan for it. */
(function driftCheck() {
  const lbPath = __dirname + '/../../greencross-leaderboard/index.html';
  if (!fs.existsSync(lbPath)) { console.log('  – drift check skipped (Leaderboard checkout not present)'); return; }
  const src = fs.readFileSync(lbPath, 'utf8');
  /* Comments are stripped before comparing: a reworded comment in Leaderboard is not a change to
     the money, and failing Crew's push over one would train people to bypass this check. */
  const norm = s => s.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
                     .replace(/\s+/g, ' ').trim();
  const mine = norm(fs.readFileSync(__filename, 'utf8'));
  let checked = 0;
  for (const name of ['calcBud', 'calcMgr', 'calcAdmin']) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) { console.log('  – ' + name + ' no longer in Leaderboard (transplant complete?)'); continue; }
    // Walk braces from the first { after the signature to find the body exactly.
    let i = src.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) { bad('could not parse ' + name + ' out of Leaderboard'); continue; }
    if (!mine.includes(norm(src.slice(start, end)))) {
      bad('DRIFT: Leaderboard\'s ' + name + ' no longer matches the frozen oracle in this test — ' +
          'Leaderboard changed the live bonus math; re-freeze the oracle and re-verify Crew against it');
    } else checked++;
  }
  if (checked) console.log('  ✓ frozen oracle still matches Leaderboard\'s live ' + checked + ' function(s)');
})();

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentive math: all passed');
process.exit(fail ? 1 : 0);
