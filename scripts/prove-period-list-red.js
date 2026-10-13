#!/usr/bin/env node
/* Prove tests/period_list_speed_test.js red, one guard at a time.
 *
 * Mutates a SCRATCH COPY of Code.gs (never the real one — CODE_GS exists for this, and nothing in
 * the repo or the push gate sets it) and reports how many assertions each change costs. A change
 * that costs zero is something the test is not actually holding.
 *
 *   node scripts/prove-period-list-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-periodlist-'));

function inFn(s, name, from, to) {
  const i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) return s;
  const j = s.indexOf('\nfunction ', i + 10);
  const body = s.slice(i, j < 0 ? s.length : j);
  const out = typeof from === 'string' ? body.split(from).join(to) : body.replace(from, to);
  return s.slice(0, i) + out + (j < 0 ? '' : s.slice(j));
}

const MUTATIONS = [
  /* The savings themselves: with one taken out, the test must see the old count come back. */
  ['the screen no longer hands the workflow row to the approval cover',
   (s) => inFn(s, 'getIncentive_', "approvalCover_(auth, live.payPeriod.start, { __screen: true, wf: wfRow });", "approvalCover_(auth, live.payPeriod.start);")],
  ['the approval cover ignores the row in hand',
   (s) => inFn(s, 'approvalCover_', "var w = inHand ? backupWindow_(pp, have.wf) : backupWindow_(pp);", "var w = backupWindow_(pp);")],
  ['the live period list builds its own calendar',
   (s) => inFn(s, 'getIncentive_', "live.periods = periodList_(imported, live.periods, cal());", "live.periods = periodList_(imported, live.periods);")],
  ['a closed period\'s list builds its own calendar',
   (s) => inFn(s, 'getIncentive_', "h.periods = periodList_(imported, null, cal());", "h.periods = periodList_(imported, null);")],
  ['picking the default period builds its own calendar',
   (s) => inFn(s, 'getIncentive_', "defaultIncentivePeriod_(importedBy, cal());", "defaultIncentivePeriod_(importedBy);")],
  ['the calendar is rebuilt every time it is asked for',
   (s) => inFn(s, 'getIncentive_', "var cal = function () { return _cal || (_cal = computedPeriods_()); };", "var cal = function () { return computedPeriods_(); };")],
  ['the practice source works the calendar out again',
   (s) => inFn(s, 'periodList_', "practiceSourceStart_(calendar);", "practiceSourceStart_();")],
  ['the approver stage is not marked',
   (s) => inFn(s, 'getIncentive_', /  mark\('approver'\);[^\n]*\n/, '')],
  ['the approval_cover stage is not marked',
   (s) => inFn(s, 'getIncentive_', /  mark\('approval_cover'\);[^\n]*\n/, '')],
  ['opening the workbook is not timed on its own',
   (s) => inFn(s, 'getIncentive_', "  crewSheet_();\n  mark('sheet_open');\n", "")],

  /* What must not have changed. */
  /* slice(2), not slice(1): dropping only the running period leaves the same first completed one,
     which is the same answer and so not a mutation at all. */
  ['handed a calendar, the default is the fortnight BEFORE the last completed one',
   (s) => inFn(s, 'defaultIncentivePeriod_', "(Array.isArray(cal) ? cal : computedPeriods_(1))", "(Array.isArray(cal) ? cal.slice(2) : computedPeriods_(1))")],
  ['handed a calendar, the practice source is the SECOND completed fortnight',
   (s) => inFn(s, 'practiceSourceStart_', "var computed = Array.isArray(cal) ? cal : computedPeriods_(2);", "var computed = Array.isArray(cal) ? cal.slice(2) : computedPeriods_(2);")],
  ['a handed calendar beats the practice pin',
   (s) => inFn(s, 'practiceSourceStart_', "  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(pinned)) return pinned;", "  if (!Array.isArray(cal) && /^\\d{4}-\\d{2}-\\d{2}$/.test(pinned)) return pinned;")],
  ['the list is built from a shorter calendar',
   (s) => inFn(s, 'getIncentive_', "(_cal = computedPeriods_())", "(_cal = computedPeriods_(2))")],
  ['anything truthy is taken for a calendar',
   (s) => inFn(s, 'practiceSourceStart_', "Array.isArray(cal) ? cal", "cal ? cal").replace("(Array.isArray(cal) ? cal : computedPeriods_(1))", "(cal ? cal : computedPeriods_(1))")],
  ['the cover trusts a row for ANOTHER period',
   (s) => inFn(s, 'approvalCover_', " && String(have.wf.pp_start || '') === String(pp || '')", "")],
  ['the cover takes the row without the marker',
   (s) => inFn(s, 'approvalCover_', "have && have.__screen === true && ", "have && ")],
  ['the cover takes any truthy marker',
   (s) => inFn(s, 'approvalCover_', "have.__screen === true", "have.__screen")],
  ['the cover takes a string for a row',
   (s) => inFn(s, 'approvalCover_', "(have.wf === null || (typeof have.wf === 'object' && ", "(have.wf === null || typeof have.wf === 'string' || (").replace("String(have.wf.pp_start || '') === String(pp || ''))));", "String((have.wf || {}).pp_start || '') === String(pp || ''))));")],
  ['the screen hands over a stand-in row instead of the one it read',
   (s) => inFn(s, 'getIncentive_', "{ __screen: true, wf: wfRow }", "{ __screen: true, wf: null }")],
  ['the cover can be supplied by the request',
   (s) => inFn(s, 'getIncentive_', "approvalCover_(auth, live.payPeriod.start, { __screen: true, wf: wfRow });", "approvalCover_(auth, live.payPeriod.start, p.have ? { __screen: true, wf: null } : { __screen: true, wf: wfRow });")],

  /* The caches that were ruled out, added anyway. */
  ['the calendar is kept between requests',
   (s) => s.replace("\nfunction getIncentive_(p, preAuth) {", "\nvar _calKeep = null;\nfunction getIncentive_(p, preAuth) {")
           .replace("var cal = function () { return _cal || (_cal = computedPeriods_()); };", "var cal = function () { return _calKeep || (_calKeep = computedPeriods_()); };")],
  ['the period list is cached for the screen',
   (s) => inFn(s, 'getIncentive_', "  live.periods = periodList_(imported, live.periods, cal());",
     "  var _pl = null; try { _pl = JSON.parse(CacheService.getScriptCache().get('crew:pl') || 'null'); } catch (e0) {}\n" +
     "  if (!_pl) { _pl = periodList_(imported, live.periods, cal()); try { CacheService.getScriptCache().put('crew:pl', JSON.stringify(_pl), 600); } catch (e1) {} }\n  live.periods = _pl;")],
  ['the workflow row is cached for the screen',
   (s) => inFn(s, 'getIncentive_', "  var wfRow = wfGet_(live.payPeriod.start);",
     "  var wfRow = null, _wk = 'crew:wf:' + live.payPeriod.start; try { wfRow = JSON.parse(CacheService.getScriptCache().get(_wk) || 'null'); } catch (e0) {}\n" +
     "  if (!wfRow) { wfRow = wfGet_(live.payPeriod.start); try { CacheService.getScriptCache().put(_wk, JSON.stringify(wfRow), 600); } catch (e1) {} }\n  var _unused = 0;")],

  /* The write paths. */
  ['approve asks the cover (and so a row in hand) instead of reading for itself',
   (s) => inFn(s, 'canDecide_', "  var w = backupWindow_(pp);", "  var w = backupWindow_(pp, null);")],
  ['approve reads the performance slice through the screen\'s snapshot',
   (s) => inFn(s, 'incentiveApprove_', "  var live = perfForWrite_(pp);", "  var live = perfForWrite_(pp, null, { snapshot: true });")],
  ['send skips its second check of the workflow row',
   (s) => inFn(s, 'incentiveSend_', "      var cur = wfGet_(pp);", "      var cur = wfPrev;")],
  ['the backup may decide only once the window is open',
   (s) => inFn(s, 'canDecide_', "  return { ok: true, as: 'backup', why: w.active ? w.why : '' };", "  return { ok: w.active, as: 'backup', why: w.active ? w.why : '' };")],
];

let problems = 0;
MUTATIONS.forEach(([label, mutate], i) => {
  const out = mutate(SRC);
  if (out === SRC) {
    console.log('  !! ' + label + ' — the mutation matched nothing; this proof is checking nothing');
    problems++;
    return;
  }
  const file = path.join(dir, 'mutant' + i + '.gs');
  fs.writeFileSync(file, out);
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'period_list_speed_test.js')],
                      { env: Object.assign({}, process.env, { CODE_GS: file }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let failed = 0;
  if (r.status !== 0) {
    const m = String(r.stdout || '').match(/\n(\d+) FAILED/);
    failed = m ? Number(m[1]) : -1;
  }
  if (failed > 0) console.log('  ✓ ' + label + ' → ' + failed + ' assertion(s) fail');
  else if (failed < 0) { console.log('  ✗ ' + label + ' → the test died without a count: ' + String(r.stderr || '').split('\n')[0]); problems++; }
  else { console.log('  ✗ ' + label + ' → STILL GREEN. The test is not holding this.'); problems++; }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(problems ? '\n' + problems + ' of ' + MUTATIONS.length + ' mutation(s) not held.\n'
                     : '\nAll ' + MUTATIONS.length + ' guards are individually held by the test.\n');
process.exit(problems ? 1 : 0);
