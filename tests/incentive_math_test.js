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

/* ── The ENGINE's copy, loaded from the shipped Code.gs ──────────────────────────────────────────
   There are two implementations of this arithmetic on purpose. The browser's runs on every keystroke
   so an attendance tick re-scores instantly; the engine's runs once, when a period is APPROVED, and
   it exists because a route that writes whatever amount the page hands it is a route where a stale
   tab or an edited request decides payroll.
   Two implementations is a drift risk, and this is the only thing that makes it acceptable: both are
   driven here against the same frozen Leaderboard oracle, so if they ever disagree this fails before
   either can pay anybody. */
const E = (function () {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const grab = (name) => {
    const i = gs.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
    let d = 0;
    for (let k = gs.indexOf('{', i); k < gs.length; k++) {
      if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
    }
    throw new Error('unterminated ' + name);
  };
  /* incHours_ is grabbed alongside the three because incCalcBud_/incCalcMgr_ CALL it. Miss it and
     this fails with a bare ReferenceError at load, before a single combination runs — which reads
     like the test is broken rather than like the extraction list is short. Any future helper the
     math reaches for has to be added here too. */
  return new Function(
    grab('incHours_') + grab('incSpiff_') +
    grab('incCalcBud_') + grab('incCalcMgr_') + grab('incCalcAdmin_') +
    '; return { calcBud: incCalcBud_, calcMgr: incCalcMgr_, calcAdmin: incCalcAdmin_,' +
    '           hours: incHours_, spiff: incSpiff_ };')();
})();

/* ── Crew's port, loaded from the SHIPPED crew.js ────────────────────────────────────────────────
   Same seam the roster tests use: splice a `return` into the IIFE tail so this exercises the real
   file rather than a copy that can drift from it. */
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();';
  const cut = src.lastIndexOf(TAIL);
  if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
  src = src.slice(0, cut) +
        '\n; return { calcBud, calcMgr, calcAdmin, incInput, incTeamAtt, incHours };\n' +
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
  const label = 'budtender ' + c.row.storeSlug + ' txn=' + c.row.txn + ' aov=' + c.row.aov +
                ' disc=' + c.row.discount + ' spiff=' + c.spiff + ' att=' + c.att;
  const cw = M.calcBud(c.row, T, inputs);
  const en = E.calcBud(c.row, T, inputs);
  if (!same(label + ' [browser]', lb, cw, ['qual', 'bonus', 'payroll', 'hr'])) break;
  if (!same(label + ' [engine]', lb, en, ['qual', 'bonus', 'payroll', 'hr'])) break;
  budChecked++;
}
console.log((budChecked === budCases.length ? '  ✓' : '  ✗') +
  ' budtender: ' + budChecked + '/' + budCases.length + ' boundary combinations agree exactly (browser AND engine vs Leaderboard)');

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
          const en = E.calcMgr(mgr, T, inputs, budRows);
          mgrTotal++;
          const lbl = 'manager ' + slug + ' pct=' + pct + ' disc=' + discount + ' aov=' + aov + ' spiff=' + spiff;
          if (!same(lbl + ' [browser]', lb, cw, ['pct', 'teamA', 'payroll', 'bonus', 'hr']) ||
              !same(lbl + ' [engine]',  lb, en, ['pct', 'teamA', 'payroll', 'bonus', 'hr'])) { mgrChecked = -1; break; }
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
    admTotal++;
    if (!same('admin pct=' + pct + ' stores=' + stores + ' [browser]', LB.calcAdmin(), M.calcAdmin(admin, T), ['pct', 'bonus', 'hr']) ||
        !same('admin pct=' + pct + ' stores=' + stores + ' [engine]',  lb, E.calcAdmin(admin, T), ['pct', 'bonus', 'hr'])) break;
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

/* ── Per-person hours (SwipeClock), added 2026-08-30 ─────────────────────────────────────────────
 *
 * $/hr divided every bonus by a flat 80 for everybody. It still does for anyone with no hours on
 * file — which is what the whole grid above just proved, because none of those cases set `hours`
 * and both Crew copies still matched Leaderboard EXACTLY. That agreement is the guarantee: the
 * extension is inert until somebody imports a timecard.
 *
 * THE ORACLE CANNOT SPEAK TO THIS. Leaderboard's frozen functions have no concept of per-person
 * hours, so there is nothing there to differential-test against and pretending otherwise would mean
 * editing the oracle — which is the one thing that must never happen, since it is the arithmetic
 * that actually paid people. So the check below changes shape: the two CREW copies are driven
 * against each other, and against the property that defines the feature.
 *
 * The property that matters most is the LAST one. Hours move $/hr and nothing else. If a future
 * edit lets them reach `bonus` or `payroll`, this is where it stops — because at that point an
 * imported timecard would change what somebody is paid, and hours arrive from a system nobody has
 * penny-matched.
 */
(function hoursTests() {
  const HRS = [1, 12.5, 40, 63.75, 80, 96, 336];
  const row = { nameKey: 'h1', employee_id: 'h1', storeSlug: 'bend', txn: 400, aov: 40, discount: 0.001 };
  const mgr = { nameKey: 'h2', employee_id: 'h2', storeSlug: 'bend', target: 100000, sales: 115000,
                discount: 0.005, aov: 40 };

  let agree = 0;
  for (const hours of HRS) {
    const inp = { h1: { att: true, spiff: 25, hours }, h2: { att: false, spiff: 10, hours } };
    const cw = M.calcBud(row, T, inp), en = E.calcBud(row, T, inp);
    const cm = M.calcMgr(mgr, T, inp, [row]), em = E.calcMgr(mgr, T, inp, [row]);
    if (!same('hours=' + hours + ' budtender [browser vs engine]', cw, en, ['qual', 'bonus', 'payroll', 'hr'])) return;
    if (!same('hours=' + hours + ' manager [browser vs engine]',  cm, em, ['pct', 'teamA', 'payroll', 'bonus', 'hr'])) return;
    if (!Object.is(cw.hr, cw.bonus / hours)) { bad('budtender $/hr must be bonus / hours at ' + hours); return; }
    if (!Object.is(cm.hr, cm.bonus / hours)) { bad('manager $/hr must be bonus / hours at ' + hours); return; }
    agree++;
  }
  console.log('  ✓ per-person hours: ' + agree + '/' + HRS.length +
              ' divide $/hr exactly, browser and engine agreeing');

  /* Everything that is not a usable positive number means "use the flat figure". Each of these has
     a real way to arrive: '' is a cleared cell, null is what inputsFor_ returns for a blank, 0 is a
     parse that found the wrong column, and the string is a header row read as data. A fallback is
     the only safe answer — dividing by 0 renders $/hr as Infinity beside a real bonus. */
  const flat = M.calcBud(row, T, { h1: { att: true, spiff: 25 } }).hr;
  const BAD = ['', null, undefined, 0, -8, NaN, 'forty', {}];
  let fell = 0;
  for (const h of BAD) {
    const inp = { h1: { att: true, spiff: 25, hours: h } };
    const cw = M.calcBud(row, T, inp), en = E.calcBud(row, T, inp);
    if (!Object.is(cw.hr, flat) || !Object.is(en.hr, flat)) {
      bad('hours=' + JSON.stringify(h) + ' must fall back to the flat ' + T.hoursPerPeriod + '-hour figure');
      return;
    }
    fell++;
  }
  console.log('  ✓ ' + fell + ' unusable hour values fall back to the flat figure, in both copies');

  /* Hours are per PERSON, keyed the same way att and spiff are. A divisor that leaked across rows
     would rescale a colleague's $/hr, and nothing on screen would say which row was wrong. */
  (function () {
    const a = { nameKey: 'p1', employee_id: 'p1', storeSlug: 'bend', txn: 400, aov: 40, discount: 0 };
    const b = { nameKey: 'p2', employee_id: 'p2', storeSlug: 'bend', txn: 400, aov: 40, discount: 0 };
    const inp = { p1: { att: true, spiff: 0, hours: 40 }, p2: { att: true, spiff: 0 } };
    const ra = M.calcBud(a, T, inp), rb = M.calcBud(b, T, inp);
    if (!Object.is(ra.hr, ra.bonus / 40)) bad('the person WITH hours must use them');
    else if (!Object.is(rb.hr, rb.bonus / T.hoursPerPeriod)) bad('the person WITHOUT hours must keep the flat figure');
    else console.log('  ✓ hours apply to one person only — a colleague keeps the flat figure');
  })();

  /* Admin takes no inputs at all, so hours cannot reach it however they are passed. Sky does not
     clock in; there is no timecard for the owner's row. */
  (function () {
    const admin = { target: 100, actual: 115, stores: 6 };
    const withH = M.calcAdmin(admin, T), plain = M.calcAdmin(admin, T);
    if (!Object.is(withH.hr, plain.hr) || !Object.is(withH.hr, withH.bonus / T.hoursPerPeriod)) {
      bad('admin $/hr must stay on the flat figure — the owner has no timecard');
    } else console.log('  ✓ admin $/hr is untouched by hours');
  })();

  /* THE ONE THAT MATTERS. Hours are a yardstick, not money: bonus, payroll and qualification must
     be byte-identical with and without them. The Capstone export carries `payroll`, so if this ever
     fails, an imported timecard has started deciding what somebody is paid. */
  (function () {
    let checked = 0;
    for (const hours of HRS) {
      for (const spiff of SPIFFS) {
        for (const att of [true, false]) {
          const on  = { h1: { att, spiff, hours } }, off = { h1: { att, spiff } };
          const a = M.calcBud(row, T, on),  b = M.calcBud(row, T, off);
          const c = M.calcMgr(mgr, T, { h2: { att, spiff, hours } }, [row]);
          const d = M.calcMgr(mgr, T, { h2: { att, spiff } }, [row]);
          if (!same('budtender money unchanged by hours=' + hours, b, a, ['qual', 'bonus', 'payroll']) ||
              !same('manager money unchanged by hours=' + hours,  d, c, ['payroll', 'bonus', 'teamA'])) return;
          checked++;
        }
      }
    }
    console.log('  ✓ hours change $/hr and NOTHING else — ' + checked +
                ' combinations keep bonus, payroll and qualification identical');
  })();

  /* The two helpers are separate implementations of one rule; assert they answer identically
     rather than trusting that they were edited together. */
  (function () {
    for (const h of HRS.concat(BAD)) {
      if (!Object.is(M.incHours({ hours: h }, T), E.hours({ hours: h }, T))) {
        bad('incHours disagrees between browser and engine for ' + JSON.stringify(h)); return;
      }
    }
    console.log('  ✓ the browser and engine hour helpers answer identically');
  })();
})();

/* ── SPIFF: measured by default, overridden on purpose (2026-08-31) ──────────────────────────────
 *
 * SPIFF is READ from SPIFF's progress cache and lands on each live row as `spiff_earned`; the input
 * column is an OVERRIDE for when the measurement missed. The engine ignored `spiff_earned` entirely
 * until this date — the browser used it, `incentiveApprove_` did not — so the screen and the frozen
 * record disagreed for everyone who had not typed a figure, which is nearly everyone.
 *
 * The grid above proves the extension is INERT: none of its 12,040 combinations sets `spiff_earned`,
 * and they still agree with the frozen Leaderboard oracle exactly. What follows is the behaviour the
 * grid cannot state, and the browser/engine agreement that keeps two implementations honest. */
(function () {
  const bud = { nameKey: 'sx', storeSlug: 'bend', txn: 400, aov: 40, discount: 0.001 };
  const mgr = { nameKey: 'mx', storeSlug: 'bend', target: 100, sales: 120, discount: 0.001, aov: 40 };

  /* No input row at all — the ordinary case, and the one that froze $0. */
  (function () {
    const earned = M.calcBud(Object.assign({ spiff_earned: 120 }, bud), T, {});
    if (earned.spiff !== 120) bad('a measured SPIFF must be used when nobody typed an override (got ' + earned.spiff + ')');
    else console.log('  ✓ a measured SPIFF is used when there is no override');
    const e2 = E.calcBud(Object.assign({ spiff_earned: 120 }, bud), T, {});
    if (!Object.is(e2.spiff, earned.spiff) || !Object.is(e2.bonus, earned.bonus) || !Object.is(e2.hr, earned.hr)) {
      bad('browser and engine disagree on a measured SPIFF — the approved record would not match the screen');
    } else console.log('  ✓ browser and engine agree on the measured figure (screen == frozen record)');
  })();

  /* THE ROW EXISTS BUT THE CELL IS BLANK. This is what an attendance tick creates, and treating
     that blank as a deliberate $0 is precisely the bug: `inputsFor_` must send null, not 0. */
  (function () {
    for (const blank of [undefined, null, '']) {
      const inp = { sx: { att: true, spiff: blank } };
      const r = M.calcBud(Object.assign({ spiff_earned: 75 }, bud), T, inp);
      const e = E.calcBud(Object.assign({ spiff_earned: 75 }, bud), T, inp);
      if (r.spiff !== 75 || e.spiff !== 75) {
        bad('a blank SPIFF cell (' + JSON.stringify(blank) + ') must mean "no override", not $0 — ' +
            'ticking attendance creates exactly this row'); return;
      }
    }
    console.log('  ✓ a blank SPIFF cell falls through to the measured amount, however it is spelled');
  })();

  /* ...and a typed 0 does NOT. Zeroing a miss is a decision, and a refresh must not revert it. */
  (function () {
    for (const zero of [0, '0']) {
      const inp = { sx: { att: true, spiff: zero } };
      if (M.calcBud(Object.assign({ spiff_earned: 500 }, bud), T, inp).spiff !== 0 ||
          E.calcBud(Object.assign({ spiff_earned: 500 }, bud), T, inp).spiff !== 0) {
        bad('a typed 0 must beat the measured amount (' + JSON.stringify(zero) + ') — ' +
            'otherwise a background refresh silently reverts an override'); return;
      }
    }
    const inp = { sx: { att: true, spiff: 40 } };
    if (M.calcBud(Object.assign({ spiff_earned: 500 }, bud), T, inp).spiff !== 40) bad('a typed override must beat the measured amount');
    else console.log('  ✓ a typed override wins over the measurement, including a deliberate 0');
  })();

  /* Managers take SPIFF from the opposite direction; the same resolution has to reach them. */
  (function () {
    const r = M.calcMgr(Object.assign({ spiff_earned: 90 }, mgr), T, {}, []);
    const e = E.calcMgr(Object.assign({ spiff_earned: 90 }, mgr), T, {}, []);
    if (r.spiff !== 90 || !Object.is(e.spiff, r.spiff) || !Object.is(e.bonus, r.bonus)) {
      bad('managers must resolve a measured SPIFF the same way budtenders do');
    } else console.log('  ✓ managers resolve the measured SPIFF identically');
  })();

  /* THE SAFETY ARGUMENT, restated as an assertion: SPIFF is vendor money and cannot move payroll,
     which is the only column the Capstone export carries. If this fails, a vendor's measurement has
     started deciding what Green Cross pays. */
  (function () {
    let checked = 0;
    for (const earnedAmt of [0, 25, 500.5]) {
      for (const att of [true, false]) {
        const b0 = M.calcBud(Object.assign({}, bud), T, { sx: { att } });
        const b1 = M.calcBud(Object.assign({ spiff_earned: earnedAmt }, bud), T, { sx: { att } });
        const m0 = M.calcMgr(Object.assign({}, mgr), T, { mx: { att } }, []);
        const m1 = M.calcMgr(Object.assign({ spiff_earned: earnedAmt }, mgr), T, { mx: { att } }, []);
        if (!Object.is(b0.payroll, b1.payroll) || !Object.is(b0.qual, b1.qual) ||
            !Object.is(m0.payroll, m1.payroll)) {
          bad('a measured SPIFF of ' + earnedAmt + ' changed PAYROLL — vendor money must never reach it'); return;
        }
        checked++;
      }
    }
    console.log('  ✓ the measured SPIFF moves bonus and $/hr only — payroll identical across ' +
                checked + ' combinations');
  })();

  /* Two implementations of one rule; assert they answer identically rather than trusting they were
     edited together. Same arrangement as the hours helpers above. */
  (function () {
    const CASES = [[undefined, undefined], [{}, undefined], [{}, 0], [{}, 300],
                   [{ spiff: '' }, 40], [{ spiff: null }, 40], [{ spiff: 0 }, 40],
                   [{ spiff: '0' }, 40], [{ spiff: 12.5 }, 40], [{ spiff: '12.5' }, 40],
                   [{ spiff: 'x' }, 40], [{ spiff: -5 }, 40]];
    for (const [i, earnedAmt] of CASES) {
      const row = earnedAmt === undefined ? {} : { spiff_earned: earnedAmt };
      const mine = M.incInput({ k: i }, 'k', row).spiff;
      const theirs = E.spiff(i, row);
      if (!Object.is(mine, theirs)) {
        bad('SPIFF resolution disagrees between browser and engine for input ' + JSON.stringify(i) +
            ' / earned ' + JSON.stringify(earnedAmt) + ': browser ' + mine + ' vs engine ' + theirs);
        return;
      }
    }
    console.log('  ✓ the browser and engine SPIFF helpers answer identically (' + CASES.length + ' cases)');
  })();
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
