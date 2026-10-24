#!/usr/bin/env node
/* ─── The Targets PRINTED on the 27 payout reports reach the goals tab — and no pay figure moves ──
 *
 *   RUN:  node tests/printed_period_goals_test.js
 *
 * WHY THIS EXISTS
 * Mike's per-store report shows Target and % Goal. Crew's own approvals keep them; the 27 periods
 * imported from the payout PDFs showed a dash, on the belief that nobody recorded those targets. The
 * reports print one for every manager and (from 2025-10-13) the admin row; the import just never kept
 * it. incentive_goals_printed keeps them — in the goals tab, never the history tab — and only where
 * the printed row proves it belongs to the stored one.
 *
 *   · A ROW THAT FAILS A CHECK IS NOT WRITTEN. Printed sales must equal the stored sales for that
 *     person's row, and the admin's own printed percent must agree with sales / target.
 *   · THE PAY RECORD IS UNTOUCHED. The history tab is byte-identical after the write, the imported
 *     payload's figures are identical with and without goals, and the Capstone export is identical.
 *   · IT IS IDEMPOTENT, AND CANNOT OVERWRITE. A period with goals on file (an approval's, a backfill's,
 *     or a previous run's) is skipped; the Leaderboard-style backfill still refuses imported periods.
 *   · THE BASIS IS SAID. On screen and in the email, a printed target is labeled as such.
 * Drives the shipped functions out of Code.gs and crew.js; nothing is a copy.
 */
'use strict';
const fs = require('fs');
const H = require('./pay_engine_harness.js');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PP = '2026-08-03', PP_OLD = '2025-08-04', GOALS = 'crew_incentive_goals';
const hist = (o) => { // a 20-column history row
  const r = new Array(20).fill('');
  r[0] = o.pp; r[1] = o.end || ''; r[2] = o.section; r[3] = o.id || ''; r[4] = o.name;
  r[5] = o.label || ''; r[6] = o.store == null ? '' : o.store; r[8] = o.sales == null ? '' : o.sales;
  r[12] = o.bonus == null ? 100 : o.bonus; r[14] = o.payroll == null ? 90 : o.payroll;
  r[15] = 'x.pdf'; r[16] = o.format || 'gen2'; r[17] = 'T';
  return r;
};
function seed(E, rows) {
  const sh = E.historySheet(PP);
  sh.getRange(2, 1, rows.length, 20).setValues(rows);
}
const FIXTURE = () => ([
  hist({ pp: PP, section: 'admin', name: 'Michael Kettler', sales: 300000 }),
  hist({ pp: PP, section: 'manager', name: 'Chris Carney', label: 'Bend', store: 'bend', sales: 60000 }),
  hist({ pp: PP, section: 'manager', name: 'Tyson Farris', label: 'Center St', store: 'center', sales: 24000 }),
  hist({ pp: PP, section: 'manager', name: 'Mariana Moxie', label: 'Commercial', store: 'commercial', sales: 90000 }),
  hist({ pp: PP, section: 'manager', name: 'Dean Deloof', label: 'Hillsboro', store: 'hillsboro', sales: 36000 }),
  hist({ pp: PP, section: 'manager', name: 'Scott Penner', label: 'Portland Road', store: '', sales: 15000 }),
  hist({ pp: PP, section: 'budtender', name: 'Sam Keck', label: 'Bend', store: 'bend', sales: 6000 }),
]);
const PRINTED = () => ({ pp_start: PP,
  admin: { name: 'Michael Kettler', target: 320000, sales: 300000, pct_to_goal: 93.75 },
  managers: [
    { name: 'Chris Carney', store_label: 'Bend', target: 66000, sales: 60000 },
    { name: 'Tyson Farris', store_label: 'Center St', target: 22000, sales: 24000.5 },     // sales disagree
    { name: 'Mariana Moxie', store_label: 'Commercial', target: 85000, sales: 90000 },
    { name: 'Dean Deloof', store_label: 'Hillsboro', target: 0, sales: 36000 },            // no target printed
    { name: 'Scott Penner', store_label: 'Portland Road', target: 17500, sales: 15000 } ] });  // store unresolved
const sheetJson = (E, tab) => JSON.stringify(E.sheets[tab] ? E.sheets[tab].data : null);

console.log('\nThe plan: what is kept, and why a row is not');
{
  const E = H.engine(); seed(E, FIXTURE());
  const rows = E.sheets['crew_incentive_history'].data.slice(1).map(r => ({
    section: r[2], pdf_name: r[4], store_label: r[5], store_id: r[6], sales: r[8], format: r[16] }));
  const plan = E.printedPlan(PRINTED(), rows);
  const by = n => plan.rows.find(r => r.name === n);
  ok('a manager whose printed sales equal the stored sales is kept, keyed on the STORED store_id',
     by('Chris Carney').status === 'ok' && plan.goals.stores.bend === 66000);
  ok('…and gets the percent that implies', by('Chris Carney').pct === 90.9);
  ok('printed sales that differ from the stored sales are refused, and the reason says so',
     by('Tyson Farris').status === 'refused' && /do not equal stored/.test(by('Tyson Farris').reason) &&
     !('center' in plan.goals.stores));
  ok('a printed target of 0 is "no target printed" — not kept, not an error',
     by('Dean Deloof').status === 'none' && !('hillsboro' in plan.goals.stores));
  ok('a stored row with no store_id is refused, never guessed',
     by('Scott Penner').status === 'refused' && /no store_id/.test(by('Scott Penner').reason));
  ok('the admin is kept when the report\'s own percent agrees',
     plan.goals.admin === 320000 && by('Michael Kettler').pct === 93.8);
  ok('exactly the passing rows are counted', plan.keep === 3);

  const wrongPct = PRINTED(); wrongPct.admin.pct_to_goal = 97.5;
  ok('an admin percent the report printed but the division does not reproduce is refused',
     E.printedPlan(wrongPct, rows).goals.admin === null);
  const noAdmin = PRINTED(); noAdmin.admin = null;
  ok('a report with no admin row (the five oldest) keeps no admin goal and nothing else changes',
     E.printedPlan(noAdmin, rows).goals.admin === null && E.printedPlan(noAdmin, rows).keep === 2);
  const noPct = PRINTED(); noPct.admin.pct_to_goal = null;
  ok('an admin row with nothing printed to check against is refused rather than trusted',
     E.printedPlan(noPct, rows).goals.admin === null);
  const dupRows = rows.concat([{ section: 'manager', pdf_name: 'Mariana Moxie', store_label: 'Commercial',
                                 store_id: 'commercial', sales: 90000 }]);
  ok('a name stored twice matches no SINGLE stored row and is refused, not guessed',
     E.printedPlan(PRINTED(), dupRows).rows.filter(r => r.name === 'Mariana Moxie').every(r => r.status === 'refused'));
  const two = FIXTURE(); two.push(hist({ pp: PP, section: 'manager', name: 'Second Mgr', label: 'Bend', store: 'bend', sales: 60000 }));
  const rows2 = two.slice(0).map(r => ({ section: r[2], pdf_name: r[4], store_label: r[5], store_id: r[6], sales: r[8] }));
  const p2 = PRINTED(); p2.managers.push({ name: 'Second Mgr', store_label: 'Bend', target: 70000, sales: 60000 });
  const plan2 = E.printedPlan(p2, rows2);
  ok('two managers printing DIFFERENT targets for one store: neither is kept',
     !('bend' in plan2.goals.stores) && plan2.rows.filter(r => r.store_label === 'Bend').every(r => r.status === 'refused'));
}

console.log('\nThe route: dry by default, goals tab only, idempotent');
{
  const E = H.engine(); E.secretOk = true; seed(E, FIXTURE());
  const before = sheetJson(E, 'crew_incentive_history');
  const body = { periods: [PRINTED()] };

  const bad = H.engine(); seed(bad, FIXTURE());
  ok('without the deploy secret it refuses', bad.printedGoals({ confirm: 'yes' }, body).ok === false &&
     bad.rows(GOALS).length === 0);

  const dry = E.printedGoals({}, body);
  ok('a dry run reports what it WOULD write and writes nothing',
     dry.ok && dry.dry_run === true && dry.periods[0].status === 'would write' && E.rows(GOALS).length === 0);

  const res = E.printedGoals({ confirm: 'yes' }, body);
  ok('confirm writes exactly one goals row for the period', res.ok && res.written === 1 && E.rows(GOALS).length === 1);
  const g = E.rows(GOALS)[0], stored = JSON.parse(g[1]);
  ok('…marked as the printed report — not "approval", not "backfill"', g[4] === 'printed_report' && g[0] === PP);
  ok('…carrying only the rows that passed', JSON.stringify(stored.stores) === JSON.stringify({ bend: 66000, commercial: 85000 }) &&
     stored.admin === 320000);
  ok('THE HISTORY TAB IS BYTE-IDENTICAL after the write', sheetJson(E, 'crew_incentive_history') === before);
  ok('goalsFor_ reads it back with its source', E.goalsFor(PP).source === 'printed_report');

  const again = E.printedGoals({ confirm: 'yes' }, body);
  ok('a second run is a no-op — skipped, one row still', again.written === 0 &&
     /already on file/.test(again.periods[0].status) && E.rows(GOALS).length === 1);

  const E2 = H.engine(); E2.secretOk = true; seed(E2, FIXTURE());
  /* Goals already on file — whoever wrote them — stand. The first call puts a row there; the second
     meets it, exactly as it would meet an approval's or a backfill's. */
  E2.printedGoals({ confirm: 'yes' }, { periods: [PRINTED()] });
  const nothing = E2.printedGoals({ confirm: 'yes' }, { periods: [PRINTED()] });
  ok('goals already on file — from any source — are never overwritten', nothing.written === 0 && E2.rows(GOALS).length === 1);

  const E3 = H.engine(); E3.secretOk = true;
  const ap = FIXTURE().map(r => { r[16] = 'approved'; return r; });
  seed(E3, ap);
  const r3 = E3.printedGoals({ confirm: 'yes' }, body);
  ok('a period Crew approved itself is refused — its goals come from the approval',
     /approved in Crew/.test(r3.periods[0].status) && E3.rows(GOALS).length === 0);
  const r4 = E3.printedGoals({ confirm: 'yes' }, { periods: [{ pp_start: '1999-01-01', managers: [] }] });
  ok('a period with no history is refused', /not a closed period/.test(r4.periods[0].status));

  const all = JSON.stringify(PRINTED()).includes('"Dean Deloof"');
  const onlyNone = PRINTED(); onlyNone.managers = [onlyNone.managers[3]]; onlyNone.admin = null;
  const E5 = H.engine(); E5.secretOk = true; seed(E5, FIXTURE());
  ok('a period where nothing passes writes no row at all',
     all && E5.printedGoals({ confirm: 'yes' }, { periods: [onlyNone] }).written === 0 && E5.rows(GOALS).length === 0);
}

console.log('\nThe engine half — wired where it has to be');
{
  const fn = H.fnSrc('incentiveGoalsPrinted_'), plan = H.fnSrc('printedGoalsPlan_');
  ok('the route is registered', /case 'incentive_goals_printed': return json_\(incentiveGoalsPrinted_\(p, body\)/.test(H.SRC));
  ok('deploy-secret first', /if \(!deploySecretOk_\(p\)\) return/.test(fn));
  ok('dry unless confirmed', /String\(p\.confirm \|\| ''\) === 'yes'/.test(fn));
  ok('writes only through freezeGoals_ — never the history sheet',
     fn.indexOf('historySheet_') < 0 && fn.indexOf('setValues') < 0 && fn.indexOf('deleteRow') < 0 &&
     /freezeGoals_\(pp, plan\.goals, 'tooling', GOALS_SOURCE_PRINTED\)/.test(fn));
  ok('under the pay lock, re-checking inside it', /withPayLock_\(function \(\) \{\s*if \(goalsFor_\(pp\)\)/.test(fn));
  ok('the planner reads no sheet and calls no service (a pure function of what it is handed)',
     !/readTab_|SpreadsheetApp|UrlFetchApp|GXCore|getRange/.test(plan));
  ok('the backfill still refuses report periods', /!== 'approved'/.test(H.fnSrc('incentiveGoalsBackfill_')));
  ok('HISTORY_HEADERS did not grow a target column', !/'target'/.test(H.SRC.slice(H.SRC.indexOf('var HISTORY_HEADERS'),
     H.SRC.indexOf('];', H.SRC.indexOf('var HISTORY_HEADERS')))));
}

/* ── The imported payload, before and after goals exist ─────────────────────────────────────────── */
console.log('\nNo pay figure moves when a report period gains goals');
const GS = H.SRC, HEADERS = new Function('return ' + /var HISTORY_HEADERS = (\[[\s\S]*?\]);/.exec(GS)[1])();
function payload(goalRows) {
  const histObjs = FIXTURE().map(r => { const o = {}; HEADERS.forEach((h, i) => { o[h] = String(r[i] == null ? '' : r[i]); }); return o; });
  const src = `
    var HISTORY_TAB='crew_incentive_history', SCHEME_TAB='crew_incentive_schemes',
        SCHEME_HEADERS=['pp_start','thresholds_json','frozen_at','frozen_by'];
    var HISTORY_HEADERS=${JSON.stringify(HEADERS)};
    var GOALS_TAB='crew_incentive_goals', GOALS_HEADERS=['pp_start','goals_json','frozen_at','frozen_by','source'];
    function deploySecretOk_(){return true}
    function coreEmployeesCached_(){return null}
    function readAttrs_(){return {}}
    var GXCore={getEmployees:function(){return []}};
    function readTab_(tab){ return tab==='crew_incentive_history' ? HIST.map(function(o){return Object.assign({},o)})
                                 : tab==='crew_incentive_goals' ? GOALROWS : []; }
    ${H.fnSrc('isPracticePeriod_')} ${H.fnSrc('practiceSource_')} ${H.fnSrc('incTab_')}
    ${H.fnSrc('schemeFor_')} ${H.fnSrc('goalsFor_')} ${H.fnSrc('attachGoals_')} ${H.fnSrc('incentiveHistory_')}
    return incentiveHistory_({ pp_start: '${PP}' });`;
  return new Function('HIST', 'GOALROWS', src)(histObjs, goalRows);
}
const bare = payload([]);
const withGoals = payload([{ pp_start: PP, goals_json: JSON.stringify({ admin: 320000, stores: { bend: 66000, commercial: 85000 } }),
  frozen_at: '2026-10-13T00:00:00.000Z', frozen_by: 'tooling', source: 'printed_report' }]);
{
  ok('the bare payload loaded (the comparison is not passing on an empty payload)',
     bare.ok === true && bare.managers.length === 5 && bare.admin && bare.budtenders.length === 1);
  ok('goals attach: targets on the two stores that have one, none on the rest',
     withGoals.managers.find(m => m.store_id === 'bend').target === 66000 &&
     withGoals.managers.find(m => m.store_id === 'commercial').target === 85000 &&
     !('target' in withGoals.managers.find(m => m.store_id === 'center')) && withGoals.admin.target === 320000);
  ok('…and the payload says where they came from', withGoals.goals_source === 'printed_report');
  const strip = (p) => { const c = JSON.parse(JSON.stringify(p)); delete c.goals_source; delete c.goals_frozen_at;
    if (c.admin) delete c.admin.target; c.managers.forEach(m => { delete m.target; }); return JSON.stringify(c); };
  ok('EVERY OTHER FIELD OF THE IMPORTED PAYLOAD — every bonus and payroll figure — IS IDENTICAL',
     strip(withGoals) === strip(bare));
}

/* ── The browser: export identical, label present ───────────────────────────────────────────────── */
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();', cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) +
    '\n; return { incMgrTable, incAdminTable, incCsvRows, incTargetCell, inc };\n' + src.slice(cut);
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
{
  const T = { hoursPerPeriod: 80, budtender: {}, manager: { salesTiers: [], discountTiers: [] }, admin: { tiers: [] } };
  const shape = (p) => Object.assign({ source: 'imported', can_edit: false, thresholds: null, pp_end: '2026-08-16',
    inputs: {} }, JSON.parse(JSON.stringify(p)), { pp_start: PP });
  const csv = (p) => { const d = shape(p); M.inc.data = d; return JSON.stringify(M.incCsvRows(d, true)); };
  const a = csv(bare), b = csv(withGoals);
  ok('the Capstone export is byte-identical with and without goals', a === b);
  ok('…and carries the paid figures (the comparison is not passing on an empty file)', /90\.00/.test(b));
  M.inc.data = shape(withGoals);
  ok('on screen a printed target is labeled with what it is',
     /as printed on that period.s report, set on a different basis/.test(M.incTargetCell(66000)));
  M.inc.data = shape(Object.assign({}, withGoals, { goals_source: 'approval' }));
  ok('an approval\'s own goals get no such label', M.incTargetCell(66000).indexOf('printed') < 0);
  const view = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  ok('the one-line note is printed under the tables for a report period with printed goals — gated on both',
     /if \(isImported && d\.goals_source === 'printed_report'\) \{\s*h\.push\('<p class="crew-inc-note">' \+ esc\(INC_PRINTED_GOALS_NOTE\)/.test(view));
}

/* ── The email ──────────────────────────────────────────────────────────────────────────────────── */
console.log('\nThe store email says it too');
{
  const body = `${H.fnSrc('storeEmailProgs_')} ${H.fnSrc('storeEmailModel_')} ${H.fnSrc('storeEmailHtml_')} ${H.fnSrc('storeEmailSpiffHtml_')} ${H.fnSrc('storeEmailSpiffInner_')}
    var CREW_URL = 'https://crew.example/';
    return { model: storeEmailModel_, html: storeEmailHtml_ };`;
  const E = new Function(body)();
  const d = Object.assign({ source: 'imported', thresholds: null, inputs: {}, budtenders: [] }, JSON.parse(JSON.stringify(withGoals)));
  const model = E.model(d, id => id);
  const withNote = E.html(model, { pp_start: PP, dates: 'x', status: 'as paid', warnings: [],
    goals_note: 'Targets are as printed on that period’s report, set on a different basis than today’s goals.' });
  const without = E.html(model, { pp_start: PP, dates: 'x', status: 'as paid', warnings: [] });
  ok('a report period\'s email carries Target and % Goal from the printed goals',
     /\$66,000/.test(withNote) && /90\.9%/.test(withNote));
  ok('…and the one-line basis note', /as printed on that period.s report/.test(withNote));
  ok('no note when there is none to make', !/as printed on that period/.test(without));
  const build = H.fnSrc('storeEmailBuild_');
  ok('the build adds it only for an imported period whose goals came from the printed report',
     /d\.source === 'imported' && d\.goals_source === GOALS_SOURCE_PRINTED/.test(build) && /meta\.goals_note/.test(build));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
