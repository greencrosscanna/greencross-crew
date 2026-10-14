#!/usr/bin/env node
/* Prove tests/incentive_read_speedup_test.js red, one guard at a time.
 *
 * Mutates a SCRATCH COPY of Code.gs (never the real one — CODE_GS exists for this, and nothing in
 * the repo or the push gate sets it) and reports how many assertions each change costs. A change
 * that costs zero is something the test is not actually holding.
 *
 *   node scripts/prove-incentive-read-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-incread-'));

function inFn(s, name, from, to) {
  const i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) return s;
  const j = s.indexOf('\nfunction ', i + 10);
  const body = s.slice(i, j < 0 ? s.length : j);
  const out = typeof from === 'string' ? body.split(from).join(to) : body.replace(from, to);
  return s.slice(0, i) + out + (j < 0 ? '' : s.slice(j));
}

const MUTATIONS = [
  /* The speedup itself: without it the test must notice the old cost is back. */
  ['the closed screen no longer hands its history rows over',
   (s) => inFn(s, 'getIncentive_', ",\n                              { __screen: true, rows: historyRows });", ");")],
  ['the approved-practice screen no longer hands its rows over',
   (s) => inFn(s, 'getIncentive_', ",\n                               { __screen: true, rows: practiceRows });", ");")],
  ['the closed screen never keeps the registry list',
   (s) => inFn(s, 'incentiveHistory_', "      if (fromScreen) coreEmployeesCachePut_(emps);\n", "")],
  ['the closed screen never reads the kept list',
   (s) => inFn(s, 'incentiveHistory_', "var emps = fromScreen ? coreEmployeesCached_() : null;", "var emps = null;")],
  ['the closed_record stage is not marked',
   (s) => inFn(s, 'getIncentive_', "    reqMark_('closed_record');\n", "")],

  /* What it must never do. */
  ['the wrong tab is handed over: a real closed period gets the practice rows',
   (s) => inFn(s, 'getIncentive_', "{ __screen: true, rows: historyRows }", "{ __screen: true, rows: practiceRows || [] }")],
  ['handed rows are not filtered to the period asked for',
   (s) => inFn(s, 'incentiveHistory_', "  var rows = (fromScreen ? have.rows : readTab_(incTab_(HISTORY_TAB, want), HISTORY_HEADERS))\n    .filter(function (r) { return r.pp_start === want; });",
                                       "  var rows = fromScreen ? have.rows : readTab_(incTab_(HISTORY_TAB, want), HISTORY_HEADERS).filter(function (r) { return r.pp_start === want; });")],
  ['any truthy marker is accepted',
   (s) => inFn(s, 'incentiveHistory_', "have.__screen === true", "have.__screen")],
  ['the marker is not needed at all',
   (s) => inFn(s, 'incentiveHistory_', "have && have.__screen === true && Array.isArray(have.rows)", "have && Array.isArray(have.rows)")],
  ['the rows need not be an array',
   (s) => inFn(s, 'incentiveHistory_', "have.__screen === true && Array.isArray(have.rows)", "have.__screen === true && have.rows")],
  ['the hand-over can come from the request',
   (s) => inFn(s, 'incentiveHistory_', "  var fromScreen = !!(have", "  if (p.__screen) { try { have = { __screen: true, rows: JSON.parse(p.rows || '[]') }; } catch (e) {} }\n  var fromScreen = !!(have")],
  ['every caller of incentiveHistory_ reads the cached registry list',
   (s) => inFn(s, 'incentiveHistory_', "var emps = fromScreen ? coreEmployeesCached_() : null;", "var emps = coreEmployeesCached_();")],
  ['every caller of incentiveHistory_ fills the cache',
   (s) => inFn(s, 'incentiveHistory_', "if (fromScreen) coreEmployeesCachePut_(emps);", "coreEmployeesCachePut_(emps);")],
  ['a Crew write no longer clears the registry list',
   (s) => inFn(s, 'bustRosterCache_', "  try { c.remove(CORE_EMP_CACHE_KEY); } catch (e) {}\n", "")],
  ['the registry list is kept for an hour instead of ten minutes',
   (s) => inFn(s, 'coreEmployeesCachePut_', "JSON.stringify(rows), ROSTER_CACHE_TTL)", "JSON.stringify(rows), 3600)")],
  ['a practice tab with ANY rows counts as approved',
   (s) => inFn(s, 'getIncentive_', "practiceRows.some(function (r) { return r.pp_start === want; })", "practiceRows.length")],
  ['the practice tab is never asked, so an approved rehearsal is recomputed live',
   (s) => inFn(s, 'getIncentive_', "var practiceRows = isPracticePeriod_(want) ? readTab_(incTab_(HISTORY_TAB, want), HISTORY_HEADERS) : null;", "var practiceRows = null;")],
  ['the practice check reads the REAL history tab',
   (s) => inFn(s, 'getIncentive_', "isPracticePeriod_(want) ? readTab_(incTab_(HISTORY_TAB, want), HISTORY_HEADERS) : null;", "isPracticePeriod_(want) ? historyRows : null;")],

  /* The cache this branch decided NOT to add, added anyway: the screen's history rows kept for ten
     minutes. A period approved a moment ago must then still look open — and the test must say so. */
  ['the history tab is cached for the screen',
   (s) => inFn(s, 'getIncentive_', "  var historyRows = readTab_(HISTORY_TAB, HISTORY_HEADERS);",
     "  var historyRows = null;\n  try { historyRows = JSON.parse(CacheService.getScriptCache().get('crew:hist') || 'null'); } catch (e0) {}\n" +
     "  if (!historyRows) { historyRows = readTab_(HISTORY_TAB, HISTORY_HEADERS); try { CacheService.getScriptCache().put('crew:hist', JSON.stringify(historyRows), 600); } catch (e1) {} }")],

  /* The write paths. */
  ['approve reads the performance slice through the screen\'s snapshot',
   (s) => inFn(s, 'incentiveApprove_', "  var live = perfForWrite_(pp);", "  var live = perfForWrite_(pp, null, { snapshot: true });")],
  ['the send preview reads through the screen\'s snapshot',
   (s) => inFn(s, 'incentiveSend_', "    var live = perfForWrite_(pp);", "    var live = perfForWrite_(pp, null, { snapshot: true });")],
  ['the write paths stamp from the cached registry list',
   (s) => inFn(s, 'stampEmployeeIds_', "var _cached = (opts && opts.snapshot) ? coreEmployeesCached_() : null;", "var _cached = coreEmployeesCached_();")],
  ['approve reads SPIFF from the screen\'s cache',
   (s) => inFn(s, 'incentiveApprove_', "  applySpiffEarnings_(live, live.payPeriod.start);", "  applySpiffEarnings_(live, live.payPeriod.start, true);")],
  ['a figure on a closed period is rounded on the way out',
   (s) => inFn(s, 'incentiveHistory_', "? (r[h] === '' ? null : Number(r[h])) : r[h];", "? (r[h] === '' ? null : Math.round(Number(r[h]))) : r[h];")],
  ['reopening leaves the frozen rows in place',
   (s) => inFn(s, 'incentiveUnapproveLocked_', "  for (var j = hit.length - 1; j >= 0; j--) sh.deleteRow(hit[j] + 1);", "")],
  /* The code comparison (comments no longer count; code still must). Neither of these changes a
     reply, a sheet or an email in this suite's scenarios, so ONLY the code comparison can catch them. */
  ['the limit right after inputsFor_ changes — code in the stretch whose comments were reworded',
   (s) => s.replace("var SNAPSHOT_OPEN_MAX_MIN = 20;", "var SNAPSHOT_OPEN_MAX_MIN = 21;")],
  ['a statement that changes nothing appears in approve',
   (s) => inFn(s, 'incentiveApprove_', "  var live = perfForWrite_(pp);", "  var live = perfForWrite_(pp); var __unused = 1;")],
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
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'incentive_read_speedup_test.js')],
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

/* CONTROLS — edits that must leave the suite GREEN. The code comparison ignores comments; if it
   ever stopped doing so, a comment fix would block a ship again, which is what it was re-based for. */
const CONTROLS = [
  ['the warmer comment after inputsFor_ is reworded',
   (s) => s.replace('every 5 minutes from 06:00', 'every 9 minutes from 06:00')],
  ['every comment inside approve is reworded',
   (s) => inFn(s, 'incentiveApprove_', '/* ', '/* REWORDED ')],
];
CONTROLS.forEach(([label, mutate], i) => {
  const out = mutate(SRC);
  if (out === SRC) { console.log('  !! control: ' + label + ' — matched nothing'); problems++; return; }
  const file = path.join(dir, 'control' + i + '.gs');
  fs.writeFileSync(file, out);
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'incentive_read_speedup_test.js')],
                      { env: Object.assign({}, process.env, { CODE_GS: file }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status === 0) console.log('  ✓ control: ' + label + ' → still green, as it must be');
  else { console.log('  ✗ control: ' + label + ' → went RED on a comment-only edit'); problems++; }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(problems ? '\n' + problems + ' problem(s) among ' + MUTATIONS.length + ' mutations and ' + CONTROLS.length + ' controls.\n'
                     : '\nAll ' + MUTATIONS.length + ' guards are individually held by the test, and all ' + CONTROLS.length + ' comment-only controls stay green.\n');
process.exit(problems ? 1 : 0);
