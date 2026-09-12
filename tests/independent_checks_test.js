#!/usr/bin/env node
/* ─── The independent checks on the pay figures ────────────────────────────────────────────────
 *
 *   RUN:  node tests/independent_checks_test.js
 *
 * WHY THIS EXISTS
 * The original safety net for these numbers was a penny-match against Leaderboard, and Leaderboard
 * is being unwound. Measured on 2026-09-11 it had already stopped being a check: on the PAID
 * 2026-08-17 period the two engines differ by $459 company-wide on $311,695 (0.15%) — first
 * reported as $1,382 until Sky refused that figure as too large, which it was: incentive_compare
 * summed three overlapping views of the same sales — and ten nicknamed staff read as present on one
 * side only. Against Dutchie's own closing report that period reads GX Core -$55, Leaderboard
 * +$404. Sky's decision that day:
 * reconcile against Dutchie's own closing report instead, and sanity-check the payouts against the
 * scheme and against every period that has ever closed.
 *
 * WHAT MUST HOLD:
 *   1. THREE STATES, NEVER A BOOLEAN. ok / mismatch / unchecked. `lb_agrees` already cost this repo
 *      two days of chasing a problem that did not exist, because null coerced to false.
 *   2. `unchecked` BLOCKS, exactly like a mismatch. A check that cannot report it ran is
 *      indistinguishable from one that passed.
 *   3. The comparison sums the STORES map, never the people: a manager's row carries their store's
 *      whole total, so budtenders + managers double-counts every store.
 *   4. Tolerances sit outside the measured noise (0.09% sales, 0.9% transactions across six stores
 *      and two periods) and inside the failure they exist to catch (an absent seller: 5-15%).
 *   5. A COMPUTED payout above what the scheme can produce blocks with nothing to acknowledge past;
 *      an OVERRIDE above it warns, because a person decided it.
 *   6. The history band ignores periods whose payroll column is blank — '' and 0 are different
 *      claims, and the oldest imported report predates that column entirely.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));
const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const JS  = fs.readFileSync(__dirname + '/../crew.js', 'utf8');

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
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* The scheme, in the shape GX Core kv holds it — the same fixture the math test uses. */
const T = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center', 'portland'],
               aovTarget: 33, aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25,
               attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 }],
           maxPerStore: 50 }
};

/* ── storeTotals_, against a stubbed sales cache ─────────────────────────────────────────────── */
function tol(name) {
  const m = SRC.match(new RegExp('var ' + name + '\\s*=\\s*([\\d.]+)'));
  if (!m) { console.log('  ✗ ' + name + ' is gone from Code.gs'); process.exit(1); }
  return m[1];
}
let DAILY = [], DAILY_THROWS = '';
const M = new Function('GXCore', 'Utilities',
  /* The SHIPPED tolerances, read out of the source — \s+ because they are column-aligned there, and
     a regex that misses silently yields `undefined`, which compares false against everything and
     turns this file into a test that cannot fail. It did exactly that on the first run. */
  'var TOTALS_SALES_TOL_PCT = ' + tol('TOTALS_SALES_TOL_PCT') + ';\n' +
  'var TOTALS_TXN_TOL_PCT = ' + tol('TOTALS_TXN_TOL_PCT') + ';\n' +
  fnSrc(SRC, 'ppWindow_') + '\n' + fnSrc(SRC, 'ppDaysBetween_') + '\n' + fnSrc(SRC, 'storeTotals_') +
  '\n; return { totals: storeTotals_, window: ppWindow_, days: ppDaysBetween_ };'
)({ getSalesDaily: function () { if (DAILY_THROWS) throw new Error(DAILY_THROWS); return DAILY; } }, {});

/* 14 days of closing-report rows for one store. */
function report(store, netPerDay, ordersPerDay, days) {
  const out = [];
  for (let i = 0; i < (days == null ? 14 : days); i++) {
    const d = new Date(Date.UTC(2026, 7, 17 + i, 12));
    out.push({ store: store, date: d.toISOString().slice(0, 10),
               net: netPerDay, orders: ordersPerDay });
  }
  return out;
}
const period = (stores) => ({ payPeriod: { start: '2026-08-17', end: '2026-08-30', current: false },
                              stores: stores });

console.log('\nThe staff figures reconcile against Dutchie\'s closing report');
{
  DAILY = report('bend', 1000, 100);
  let r = M.totals(period({ bend: { sales: 14000, txns: 1400 } }));
  ok('an exact agreement is ok', r.state === 'ok' && r.mismatches.length === 0);
  ok('…and it says so store by store, so a pass can be seen to have run',
     r.stores.length === 1 && r.stores[0].state === 'ok' && r.stores[0].report_sales === 14000);

  /* The worst real gap measured across six stores and two periods was 0.09% on sales, 0.9% on
     transactions. Both of these sit inside the tolerance and must not fire. */
  r = M.totals(period({ bend: { sales: 14012, txns: 1412 } }));
  ok('0.09% on sales and 0.86% on transactions — the measured worst case — still passes',
     r.state === 'ok');

  /* One absent budtender at a six-seller store is 5-15%. */
  r = M.totals(period({ bend: { sales: 12600, txns: 1260 } }));
  ok('a missing seller (-10%) is a mismatch', r.state === 'mismatch' && r.mismatches.length === 1);
  ok('…and the finding carries both figures, not just a verdict',
     r.mismatches[0].staff_sales === 12600 && r.mismatches[0].report_sales === 14000 &&
     r.mismatches[0].sales_diff_pct === -10);

  /* Sales can look right while the transaction count is wrong — a qualification bar is counted in
     transactions, so it is checked separately rather than assumed to follow the money. */
  r = M.totals(period({ bend: { sales: 14000, txns: 1200 } }));
  ok('transactions out by 14% is a mismatch even when sales agree', r.state === 'mismatch');
}

console.log('\nUnchecked is its own state, and it never reads as a pass');
{
  DAILY = report('bend', 1000, 100);
  let r = M.totals({ payPeriod: { start: '2026-08-17', end: '2026-08-30', current: false }, stores: {} });
  ok('an engine that sends no per-store totals is unchecked, not ok', r.state === 'unchecked');
  ok('…and says why', /no per-store totals/.test(r.reason));

  r = M.totals({ payPeriod: { start: '2026-08-17', end: '2026-08-30', current: true },
                 stores: { bend: { sales: 1, txns: 1 } } });
  ok('an open period is unchecked rather than a mismatch', r.state === 'unchecked' && /still open/.test(r.reason));

  DAILY_THROWS = 'cache offline';
  r = M.totals(period({ bend: { sales: 14000, txns: 1400 } }));
  ok('an unreadable sales cache is unchecked, never ok', r.state === 'unchecked' && /cache/.test(r.reason));
  DAILY_THROWS = '';

  DAILY = [];
  r = M.totals(period({ bend: { sales: 14000, txns: 1400 } }));
  ok('an empty cache is unchecked', r.state === 'unchecked');

  /* A SHORT CACHE IS NOT A SMALL STORE: missing days lower the report total for a reason that has
     nothing to do with the figures being checked. Reading that as a mismatch would cry wolf; as a
     pass it would be a lie. */
  DAILY = report('bend', 1000, 100, 9);
  r = M.totals(period({ bend: { sales: 14000, txns: 1400 } }));
  ok('a cache holding 9 of 14 days is unchecked, not a 55% mismatch',
     r.state === 'unchecked' && r.stores[0].state === 'unchecked' && /9 of 14 days/.test(r.stores[0].reason));

  DAILY = report('bend', 1000, 100);
  r = M.totals(period({ bend: { sales: 14000, txns: 1400 }, 'river-rd': { sales: 5, txns: 1 } }));
  ok('a store the report has no days for is unchecked, and the whole answer with it',
     r.state === 'unchecked');
}

console.log('\nThe window, and the store vocabulary');
{
  ok('a normal period uses its own dates',
     M.window({ payPeriod: { start: '2026-08-17', end: '2026-08-30' } }).from === '2026-08-17');
  /* On a practice period payPeriod.start has been rewritten to the STORAGE KEY, which is not a
     date. Asking the cache for `practice-2026-08-17` returns nothing, and nothing reads as a
     store that sold nothing — so the window comes off the end date instead. */
  ok('a practice key falls back to 13 days before the end, not to the key',
     M.window({ payPeriod: { start: 'practice-2026-08-17', end: '2026-08-30' } }).from === '2026-08-17');
  ok('no usable end date yields no window at all',
     M.window({ payPeriod: { start: '2026-08-17', end: '' } }) === null);
  ok('a fortnight is 14 days inclusive', M.days('2026-08-17', '2026-08-30') === 14);

  const S = decomment(fnSrc(SRC, 'storeTotals_'));
  /* store_id (`portland-rd`) vs Leaderboard's display slug (`portland`) is the trap that reports
     four of six stores wrong on a perfectly good period. Both sides here are store_ids. */
  ok('it compares the slice\'s own store keys against sales_daily.store, with no slug translation',
     /r\.store/.test(S) && !/storeSlug/.test(S));
  ok('it sums the STORES map, never budtenders + managers (which double-counts every store)',
     !/budtenders/.test(S) && !/managers/.test(S));
}

console.log('\nNobody is paid more than the scheme can produce');
{
  const C = new Function('T',
    fnSrc(SRC, 'incHours_') + fnSrc(SRC, 'incSpiff_') + fnSrc(SRC, 'incCalcBud_') +
    fnSrc(SRC, 'incCalcMgr_') + fnSrc(SRC, 'incCalcAdmin_') + fnSrc(SRC, 'payoutCeilings_') +
    fnSrc(SRC, 'ceilingProblems_') +
    '; return { ceilings: payoutCeilings_, problems: ceilingProblems_ };')();

  const buds = [{ employee_id: 'a', storeSlug: 'bend' }, { employee_id: 'b', storeSlug: 'bend' }];
  const live = { budtenders: buds, managers: [{ employee_id: 'm', storeSlug: 'bend' }],
                 admin: { stores: 6 } };
  const ceil = C.ceilings(live, T);
  ok('a budtender can earn at most AOV + discount + attendance ($65)', ceil.budtender === 65);
  ok('a manager at most top tier + best discount tier + AOV + their own team ($500)',
     ceil.manager.bend === 300 + 100 + 50 + 2 * 25);
  ok('the admin ceiling respects the per-store cap (6 × $50)', ceil.admin === 300);

  /* Rows in HISTORY_HEADERS order: [2] section, [3] employee_id, [4] name, [14] paid,
     [18] computed. Positional because that is how the rows being frozen are actually shaped. */
  const row = (section, id, name, paid, computed) => {
    const r = new Array(20).fill('');
    r[2] = section; r[3] = id; r[4] = name; r[14] = paid; r[18] = computed;
    return r;
  };
  let p = C.problems([row('budtender', 'a', 'Amirah', 65, 65)], live, T);
  ok('a full-house budtender is not a finding', !p.over_computed.length && !p.over_override.length);

  p = C.problems([row('budtender', 'a', 'Amirah', 90, 90)], live, T);
  ok('a COMPUTED figure above the ceiling is a blocker', p.over_computed.length === 1);
  ok('…naming the person and both figures',
     p.over_computed[0].name === 'Amirah' && p.over_computed[0].ceiling === 65);

  p = C.problems([row('budtender', 'a', 'Amirah', 250, 65)], live, T);
  ok('an OVERRIDE above the ceiling warns instead — a person decided it',
     !p.over_computed.length && p.over_override.length === 1 && p.over_override[0].paid === 250);

  p = C.problems([row('manager', 'm', 'Chris', 520, 520)], live, T);
  ok('a manager is measured against THEIR store\'s ceiling', p.over_computed.length === 1);

  const CEIL = decomment(fnSrc(SRC, 'payoutCeilings_'));
  ok('the ceiling is produced by the shipped calcs, not a second formula',
     /incCalcBud_\(/.test(CEIL) && /incCalcMgr_\(/.test(CEIL) && /incCalcAdmin_\(/.test(CEIL));
  ok('both manager discount tiers are tried rather than assuming which pays more',
     /forEach/.test(CEIL) && /best/.test(CEIL));
}

console.log('\nThe history band, and what it refuses to count');
{
  const H = new Function('readTab_', 'HISTORY_TAB', 'HISTORY_HEADERS',
    fnSrc(SRC, 'historyBand_') + '; return historyBand_;');
  const rows = [
    /* The oldest imported report has NO payroll column — every row blank. Counted as zero it would
       drop the floor to $0 and make the band meaningless. */
    { pp_start: '2025-08-04', payroll: '' }, { pp_start: '2025-08-04', payroll: '' },
    { pp_start: '2025-08-18', payroll: 1000 }, { pp_start: '2025-08-18', payroll: 950 },
    { pp_start: '2025-08-18', payroll: 0 },
    { pp_start: '2026-08-17', payroll: 400 }, { pp_start: '2026-08-17', payroll: 540 }
  ];
  const band = H(() => rows, 'crew_incentive_history', [])();
  ok('a period with no payroll figures at all is skipped, not counted as $0', band.periods === 2);
  ok('the band is the min and max of the periods that stated one',
     band.payroll_min === 940 && band.payroll_max === 1950);
  ok('people paid counts only non-zero payroll', band.paid_min === 2 && band.paid_max === 2);

  const excl = H(() => rows, 'crew_incentive_history', [])('2026-08-17');
  ok('the period being approved is excluded from the band it is judged against',
     excl.periods === 1 && excl.payroll_max === 1950);

  const HB = decomment(fnSrc(SRC, 'historyBand_'));
  ok('it reads the REAL history tab, never the practice twin — a rehearsal cannot widen the band',
     /readTab_\(HISTORY_TAB/.test(HB) && !/incTab_/.test(HB));

  const W = new Function('wfMoney_', fnSrc(SRC, 'bandWarnings_') + '; return bandWarnings_;')(
    (v) => '$' + Number(v).toFixed(2));
  ok('a total inside the band says nothing', W(1000, 2, band).length === 0);
  ok('a total outside it warns', W(9000, 2, band).some(w => w.code === 'total_outside_history'));
  ok('a headcount outside it warns', W(1000, 30, band).some(w => w.code === 'headcount_outside_history'));
  ok('no history means no warnings rather than a false alarm', W(9000, 30, { periods: 0 }).length === 0);
}

console.log('\nWired in: the gate refuses, the screen reports, the email says so');
{
  const B = decomment(fnSrc(SRC, 'incentiveBlockers_'));
  ok('the blockers ask storeTotals_', /storeTotals_\(live\)/.test(B));
  ok('unchecked blocks as well as mismatch',
     /store_totals_unknown/.test(B) && /store_totals_mismatch/.test(B));
  ok('…and it is acknowledgeable, by its OWN flag', /totalsAck/.test(B));

  const A = decomment(fnSrc(SRC, 'incentiveApprove_'));
  ok('approval reads totals_ok separately from coverage_ok',
     /p\.totals_ok/.test(A) && /p\.coverage_ok/.test(A));
  ok('the acknowledgement is written into the note frozen onto every row',
     /store totals disagree with Dutchie/.test(A) && /noteTxt/.test(A));
  /* The ceiling check must sit ABOVE the dry-run return: "Send for approval" runs this function as
     its dry run, and a send that mails figures approval will reject burns the single-use token. */
  ok('the ceiling check runs before the dry-run return, so the SEND refuses too',
     A.indexOf('ceilingProblems_') > 0 &&
     A.indexOf('ceilingProblems_') < A.indexOf("String(p.confirm || '') !== 'yes'"));
  ok('a computed figure over the ceiling has nothing to acknowledge past',
     /nothing to acknowledge past/.test(A));

  const G = decomment(fnSrc(SRC, 'getIncentive_'));
  ok('the screen is given the reconciliation', /live\.store_totals = storeTotals_\(live\)/.test(G));
  ok('…and the band, not a verdict', /live\.history_band = historyBand_\(/.test(G));
  ok('the screen does not refuse on it — only the write paths do', !/incentiveBlockers_\(/.test(G));

  const E = decomment(fnSrc(SRC, 'wfApprovalEmail_'));
  ok('the approval email carries the check', /store_totals/.test(E));
  ok('…and states a PASS too, so a check that stopped running is visible',
     /agree with Dutchie/.test(E));

  const V = decomment(JS);
  ok('the incentive screen renders the mismatch', /store_totals/.test(V));
  ok('…and compares its own totals against the engine\'s band', /history_band/.test(V));
  /* IT CALLED `money()`, WHICH LIVES IN THE CSV EXPORT AND IS NOT IN SCOPE THERE — the whole
     incentive tab rendered "Loading incentive data…" forever with "money is not defined" in the
     console. Nothing source-level would have caught it; a browser did, before it shipped. The
     screen's own formatter is m0. */
  /* Decommented, because the comment above that code NAMES the function it must not call. */
  const paint = V.slice(V.indexOf('var st = (d.payPeriod'), V.indexOf('var sp = d.spiff;'));
  ok('the new notices use the incentive screen\'s own money formatter',
     paint.indexOf('money(') < 0 && /m0\(/.test(paint));
  ok('an open period is not reported as unreconciled', /payPeriod && d\.payPeriod\.current/.test(paint));
  /* A fortnight two days in has earned two days of bonuses, so "below everything on record" is true
     every time and means nothing. Seen live at $200 against a $930 floor. */
  const bandPaint = V.slice(V.indexOf('var band = '), V.indexOf('var sp = d.spiff;'));
  ok('…and its total is not compared against the band mid-period',
     /payPeriod && d\.payPeriod\.current/.test(bandPaint));
}

console.log(fail ? `\n${fail} FAILED` : '\nindependent checks: all passed');
process.exit(fail ? 1 : 0);
