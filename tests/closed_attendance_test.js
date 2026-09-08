#!/usr/bin/env node
/* ─── A closed pay period shows WHO earned attendance, not a dash for everybody ─────────────────
 *
 *   RUN:  node tests/closed_attendance_test.js
 *
 * WHY THIS EXISTS
 * Sky: "once a pay period is closed the attendance column is showing – and should show a check
 * mark." The frozen record has no attendance column — HISTORY_HEADERS never carried one — and the
 * imported payload never included the inputs, so a closed period rendered an em dash for all forty
 * people. The fortnight Mike had just spent ticking read back as though nobody had earned it.
 *
 * The tick data was never gone. `crew_incentive_inputs` is keyed on pp_start, approval does not
 * clear it, and nothing anywhere in the engine deletes from that tab. So the fix is to send it and
 * render it.
 *
 * THE PART THAT NEEDED CARE, and most of what this file checks:
 *
 *   · Attaching `inputs` to an IMPORTED payload must not move a single frozen figure. Every money
 *     path in the browser is already guarded on isImported — budCalc/mgrCalc return the row,
 *     paidOf returns the frozen payroll, incHrCell gets a null row, the CSV returns r.payroll —
 *     and the attendance cell is the one unguarded reader. That is a property worth pinning
 *     rather than re-deriving by reading, because the failure is silent: a closed period would
 *     start recomputing against today's inputs and every number would still look plausible.
 *
 *   · "No record" and "recorded as no" both render —, and on a CLOSED period that is honest: the
 *     bonus is frozen and was computed by the engine reading this same tab, where an absent row
 *     and an unticked one both mean no attendance bonus. — says "did not get the bonus", not
 *     something about the person.
 *
 *   · The case that WOULD mislead is a period with no attendance record at all — the 27 imported
 *     from the payout PDFs, which did pay attendance bonuses but recorded no per-person answer.
 *     A column of dashes there reads as "nobody earned it", so the period says so in words.
 *     Crucially that notice keys on whether any row EXISTS, not on whether any tick is true: a
 *     fortnight where the answer really was no for everyone must read as a real column of dashes.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();', cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) +
    '\n; return { incBudTable, incAttCell, incAttUnrecorded, incCsvRows, calcBud, inc };\n' +
    src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' },
    body: { classList: { add() {}, remove() {} } }, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: { setProperty() {} }, classList: { add() {} },
      setAttribute() {}, addEventListener() {}, appendChild() {} }), addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' } };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  return new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
    'navigator', src)(doc, win, store, store, { hostname: 'localhost' }, {});
})();

const T = { hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1.0, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }], maxPerStore: 50 } };

/* A frozen row, as incentive_history returns it: figures as PAID. */
const frozen = (id, name, bonus, payroll) => ({ employee_id: id, pdf_name: name, name: name,
  nameKey: id, store_label: 'River Rd', storeSlug: 'river', txn: 250, sales: 9000,
  discount_pct: 0.5, aov: 36, spiff: null, bonus: bonus, payroll: payroll, per_hour: 1.2 });

const ROWS = [frozen('a_one', 'Ann One', 65, 65),
              frozen('b_two', 'Bee Two', 50, 50),
              frozen('c_three', 'Cee Three', 50, 50)];

console.log('\nA closed period the app itself approved');
{
  /* Ann was ticked. Bee was assessed and marked No. Cee was never on Mike's list. */
  const inputs = { a_one: { att: true,  spiff: null, hours: null, payrollOverride: null },
                   b_two: { att: false, spiff: null, hours: null, payrollOverride: null } };
  M.inc.data = { source: 'imported', can_edit: false, thresholds: T,
                 pp_start: '2026-08-17', pp_end: '2026-08-30',
                 budtenders: ROWS, managers: [], inputs: inputs };
  const html = M.incBudTable(ROWS, b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff,
    hr: b.per_hour, qual: null, aovB: null, disB: null, attB: null }), true, false, T);

  const rowOf = n => html.split('<tr>').find(r => r.indexOf(n) >= 0) || '';
  ok('the person who earned it gets a check mark', /✓/.test(rowOf('Ann One')));
  ok('…in the green the print sheet already uses for a tick',
     /crew-inc-hit/.test(rowOf('Ann One')));
  ok('the person marked No does not', !/✓/.test(rowOf('Bee Two')) && /—/.test(rowOf('Bee Two')));
  ok('nor does the person nobody recorded', !/✓/.test(rowOf('Cee Three')));
  ok('and a closed period renders NO checkbox anywhere — it is a record, not a form',
     html.indexOf('type="checkbox"') < 0);
  ok('the period is not flagged as unrecorded — it has answers',
     M.incAttUnrecorded(M.inc.data, true) === false);
}

console.log('\nA live period is untouched — still the tickable checkbox');
{
  const inputs = { a_one: { att: true, spiff: null, hours: null, payrollOverride: null } };
  M.inc.data = { source: 'live', can_edit: true, thresholds: T, pp_start: '2026-08-31',
                 budtenders: ROWS, managers: [], inputs: inputs };
  const html = M.incBudTable(ROWS, b => M.calcBud(b, T, inputs), false, true, T);
  ok('checkboxes, not glyphs', html.indexOf('type="checkbox"') >= 0 && !/>✓</.test(html));
  ok('the ticked one is checked', /data-k="a_one"[^>]*checked/.test(html));
  ok('and it is still editable', html.indexOf('disabled') < 0);
  ok('a live period is never called unrecorded', M.incAttUnrecorded(M.inc.data, false) === false);
}

console.log('\nOne of the 27 payout-PDF periods — nothing was recorded, and it SAYS so');
{
  M.inc.data = { source: 'imported', can_edit: false, thresholds: null,
                 pp_start: '2025-09-01', pp_end: '2025-09-14',
                 budtenders: ROWS, managers: [], inputs: {} };
  ok('the period is flagged as having no attendance record',
     M.incAttUnrecorded(M.inc.data, true) === true);
  const html = M.incBudTable(ROWS, b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff,
    hr: b.per_hour, qual: null, aovB: null, disB: null, attB: null }), true, false, T);
  ok('no check marks are invented for it', !/✓/.test(html));

  /* THE DISTINCTION THIS TURNS ON. A fortnight where the answer really was "no" for everybody has
     rows, and must read as a real column of dashes — not as one nobody filled in. Keying the
     notice on "did anyone TICK" instead of "does anyone have a ROW" would collapse the two. */
  const allNo = { a_one: { att: false }, b_two: { att: false }, c_three: { att: false } };
  ok('a period where everyone was marked No is NOT "unrecorded"',
     M.incAttUnrecorded({ inputs: allNo }, true) === false);
  ok('a missing inputs key is treated as unrecorded, not as a crash',
     M.incAttUnrecorded({}, true) === true);
}

console.log('\nAttaching inputs to a closed period moves NO frozen figure');
{
  /* The silent failure this guards: a closed period starting to recompute against today's inputs.
     Every figure would still look plausible. So the same rows are rendered and exported twice —
     once with inputs that would change everything if they were read, once with none — and the
     output must be byte-identical. */
  const loaded = { a_one: { att: true, spiff: 999, hours: 12, payrollOverride: 4242,
                            overrideNote: 'would be very visible if it leaked' },
                   b_two: { att: true, spiff: 888, hours: 3, payrollOverride: 1111,
                            overrideNote: 'likewise' } };
  const calc = b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff, hr: b.per_hour,
                       qual: null, aovB: null, disB: null, attB: null });

  M.inc.data = { source: 'imported', can_edit: false, thresholds: T, pp_start: '2026-08-17',
                 budtenders: ROWS, managers: [], inputs: {} };
  const csvBare = JSON.stringify(M.incCsvRows(M.inc.data, true));
  const htmlBare = M.incBudTable(ROWS, calc, true, false, T);

  M.inc.data = { source: 'imported', can_edit: false, thresholds: T, pp_start: '2026-08-17',
                 budtenders: ROWS, managers: [], inputs: loaded };
  const csvLoaded = JSON.stringify(M.incCsvRows(M.inc.data, true));
  const htmlLoaded = M.incBudTable(ROWS, calc, true, false, T);

  ok('the Capstone export is byte-identical with and without inputs', csvBare === csvLoaded);
  ok('no override figure leaks into the export', csvLoaded.indexOf('4242') < 0);
  ok('no override reason leaks into the screen', htmlLoaded.indexOf('would be very visible') < 0);
  ok('no phantom SPIFF appears', htmlLoaded.indexOf('999') < 0 && htmlLoaded.indexOf('888') < 0);
  ok('no imported timecard changes $/hr', htmlLoaded.indexOf('12 hours worked') < 0);

  /* The attendance column is the ONE cell allowed to differ, and it must actually differ, or the
     comparison above is passing for the wrong reason. */
  ok('…and the ONLY difference is the attendance column',
     htmlBare !== htmlLoaded &&
     htmlBare.split('✓').length === 1 && htmlLoaded.split('✓').length === 3);
}

console.log('\nThe ENGINE half — the closed branch actually sends the inputs');
{
  /* The browser tests above hand `inputs` in directly, so they pass whether or not the engine ever
     sends any. Without this the two halves could disagree and the screen would go back to a column
     of dashes with every browser test still green — which is how M1 of this file's mutation check
     slipped through when it was first written. A source assertion, not a behavior one: getIncentive_
     needs a live sheet and cannot be run here. */
  const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const i = GS.indexOf('function getIncentive_(');
  ok('getIncentive_ exists', i >= 0);
  /* The imported branch is the block guarded by `if (want && importedBy[want])`, ending at its
     return. Reading just that slice keeps this from passing on the LIVE branch's own assignment
     further down, which has always been there. */
  const from = GS.indexOf('if (want && importedBy[want])', i);
  const to = GS.indexOf('var live = fetchLivePerf_', from);
  const branch = GS.slice(from, to);
  ok('the closed-period branch is found', from > 0 && to > from);
  ok('…and it attaches the inputs, or the check mark has no data',
     /h\.inputs\s*=\s*inputsFor_\(/.test(branch));
  ok('…keyed on the period being served, not something else',
     /h\.inputs\s*=\s*inputsFor_\(want\)/.test(branch));
  /* It must not start attaching anything ELSE from the live path: those figures are frozen. */
  ok('and it does not fold SPIFF earnings onto a frozen period',
     branch.indexOf('applySpiffEarnings_') < 0);
  ok('nor re-stamp employee ids over the frozen record',
     branch.indexOf('stampEmployeeIds_') < 0);
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
