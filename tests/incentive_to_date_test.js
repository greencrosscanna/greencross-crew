#!/usr/bin/env node
/* ─── Approved-to-date totals: Performance bonus, SPIFF, Total incentives ─────────────────────────
 *
 *   RUN:  node tests/incentive_to_date_test.js      (from the repo root; no deps, no network)
 *
 * Sky, 2026-09-14: aggregate tiles at the top of the Incentive tab — "break out performance bonus,
 * spiff and total incentives". Three ways this goes quietly wrong, and each is pinned below:
 *
 *   • DOUBLE COUNTING. Budtender payroll = bonus − SPIFF; manager bonus = payroll + SPIFF. Summing
 *     `bonus` as Performance and then adding SPIFF counts vendor money twice. Performance is the
 *     recorded PAYROLL, so Performance + SPIFF = Total, with no overlap.
 *   • BLANK IS NOT ZERO. The 2025-08-04 report has no payroll or SPIFF column. Reading blank payroll
 *     as $0 erases a fortnight of real bonuses from the total.
 *   • OVERRIDES. Levy's 2026-08-17 row was paid $25 by hand while `bonus` still says the math's
 *     figure. The total must follow what was paid.
 *   • PRACTICE. A rehearsal is frozen into its own tab and must never inflate what the company paid.
 *
 * Loads the real apps-script/Code.gs and crew.js, so this tests shipped source.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

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

/* ── engine ─────────────────────────────────────────────────────────────────────────────────── */
const TABS = {};
const readTab_ = (tab) => TABS[tab] || [];
const incTab_ = (base, pp) => (pp && /^practice-/.test(pp)) ? base + '_practice' : base;
const E = new Function('readTab_', 'incTab_', 'HISTORY_TAB', 'HISTORY_HEADERS',
  fnSrc(GS, 'historyPeriods_') + '\n' + fnSrc(GS, 'incentiveToDate_') +
  '\n; return { historyPeriods_, incentiveToDate_ };')
  (readTab_, incTab_, 'crew_incentive_history', []);

/* readTab_ hands back TEXT, blank as '' — exactly like the shipped reader. */
const row = (pp, end, section, bonus, payroll, spiff) =>
  ({ pp_start: pp, pp_end: end, section, bonus: String(bonus), payroll: String(payroll),
     spiff: String(spiff), format: 'x', imported_at: '' });

TABS.crew_incentive_history = [
  /* gen1: no payroll, no SPIFF column at all */
  row('2025-08-04', '2025-08-17', 'managers', 400, '', ''),
  row('2025-08-04', '2025-08-17', 'budtenders', 50, '', ''),
  /* gen2: a manager (bonus = payroll + spiff) and a budtender (payroll = bonus − spiff) */
  row('2026-02-02', '2026-02-15', 'managers', 350, 300, 50),
  row('2026-02-02', '2026-02-15', 'budtenders', 90, 40, 50),
  row('2026-02-02', '2026-02-15', 'admin', 0, 0, ''),
  /* approved: Levy's override — math said $0 payroll, a person recorded $25 */
  row('2026-08-17', '2026-08-30', 'budtenders', 11.25, 25, 11.25),
  row('2026-08-17', '2026-08-30', 'managers', 100.75, 100, 0.75),
];
TABS.crew_incentive_history_practice = [
  row('practice-2026-08-17', '2026-08-30', 'managers', 9999, 9999, 9999),
];

console.log('\nPer-period split\n');
const periods = E.historyPeriods_();
const by = Object.fromEntries(periods.map((p) => [p.pp_start, p]));
ok('practice is invisible to the bare call', periods.length === 3 && !by['practice-2026-08-17']);
ok('blank payroll falls back to the recorded bonus, not $0 (gen1 performance $450)',
   by['2025-08-04'].performance === 450);
ok('a report with no SPIFF column says so (spiff_recorded false)', by['2025-08-04'].spiff_recorded === false);
ok('performance is PAYROLL, not bonus (2026-02-02: $340, not $440)', by['2026-02-02'].performance === 340);
ok('SPIFF sums both sections (2026-02-02: $100)', by['2026-02-02'].spiff === 100);
ok('performance + SPIFF equals total bonus when nothing was overridden',
   by['2026-02-02'].performance + by['2026-02-02'].spiff === by['2026-02-02'].bonus);
ok('an override counts as what was PAID (2026-08-17 performance $125, not $100)',
   by['2026-08-17'].performance === 125);
ok('cents survive and are rounded (2026-08-17 SPIFF $12.00)', by['2026-08-17'].spiff === 12);
ok('existing `bonus` field is unchanged for its other readers', by['2026-02-02'].bonus === 440);

console.log('\nTo-date totals\n');
const t = E.incentiveToDate_(periods);
ok('counts every approved period', t.periods === 3);
ok('span runs first start → last end', t.first_start === '2025-08-04' && t.last_end === '2026-08-30');
ok('performance = 450 + 340 + 125', t.performance === 915);
ok('SPIFF = 0 + 100 + 12', t.spiff === 112);
ok('total is exactly performance + SPIFF — no double counting', t.total === 1027);
ok('names the periods whose SPIFF was never recorded', JSON.stringify(t.spiff_unrecorded) === '["2025-08-04"]');
const empty = E.incentiveToDate_([]);
ok('nothing approved → zero periods, zero totals', empty.periods === 0 && empty.total === 0);

console.log('\nEvery shape of the incentive payload carries it\n');
{
  const body = fnSrc(GS, 'getIncentive_');
  const hits = body.match(/\b(ph|h|live)\.to_date = incentiveToDate_\(imported\);/g) || [];
  ok('frozen, practice-frozen and live branches all attach to_date (' + hits.length + ')', hits.length === 3);
  ok('built from the REAL history list, never a practice read',
     !/incentiveToDate_\(historyPeriods_\(\w/.test(body));
  ok('incentiveToDate_ reads no sheet of its own', !/readTab_|historyPeriods_\(/.test(fnSrc(GS, 'incentiveToDate_')));
}

/* ── browser ────────────────────────────────────────────────────────────────────────────────── */
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const cut = src.lastIndexOf('})();');
  src = src.slice(0, cut) + '\n; return { incToDateHtml };\n' + src.slice(cut);
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

console.log('\nThe tiles\n');
{
  const html = M.incToDateHtml(t);
  const tiles = [...html.matchAll(/<dd>([^<]*)<\/dd><dt>([^<]*)<\/dt>/g)].map((m) => [m[2], m[1]]);
  ok('three tiles, in order: Performance bonus, SPIFF, Total incentives',
     tiles.length === 3 && /^Performance bonus$/.test(tiles[0][0]) && /^SPIFF/.test(tiles[1][0]) &&
     /^Total incentives$/.test(tiles[2][0]));
  ok('figures are the engine\'s, unchanged', tiles[0][1] === '$915' && tiles[1][1] === '$112' && tiles[2][1] === '$1,027');
  ok('Total is the highlighted tile', /<div class="is-total"><dd>\$1,027/.test(html));
  ok('the caption says these are ALL approved periods, not this one',
     /All approved pay periods/.test(html) && /3 approved pay periods/.test(html));
  ok('the span names BOTH years — it crosses one', /Aug 4, 2025 – Aug 30, 2026/.test(html));
  ok('an unrecorded SPIFF period is disclosed on the SPIFF tile', /not recorded for 1 period/.test(html));
  ok('no unrecorded periods → no note', !/not recorded/.test(M.incToDateHtml(Object.assign({}, t, { spiff_unrecorded: [] }))));
  ok('nothing approved yet → renders nothing (no row of $0 tiles)',
     M.incToDateHtml(empty) === '' && M.incToDateHtml(undefined) === '');
}

console.log('\nPrint\n');
{
  const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  const printBlock = HTML.slice(HTML.indexOf('@media print {'));
  const hide = printBlock.slice(0, printBlock.indexOf('{ display: none !important; }'));
  ok('the to-date row is hidden on the filed payout PDF, which is ONE period\'s record',
     /\.crew-inc-todate\b/.test(hide));
  const js = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  ok('the incentive header actually renders it', /h\.push\(incToDateHtml\(d\.to_date\)\);/.test(js));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
