#!/usr/bin/env node
/* Prove tests/perf_screen_cache_test.js red, one guard at a time.
 *
 * Mutates a SCRATCH COPY of Code.gs (never the real one — CODE_GS exists for this, and nothing in
 * the repo or the push gate sets it) and reports how many assertions each change costs. A change
 * that costs zero is something the test is not actually holding.
 *
 *   node scripts/prove-perf-screen-cache-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-perfcache-'));

function inFn(s, name, from, to) {
  const i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) return s;
  const j = s.indexOf('\nfunction ', i + 10);
  const body = s.slice(i, j < 0 ? s.length : j);
  const out = typeof from === 'string' ? body.split(from).join(to) : body.replace(from, to);
  return s.slice(0, i) + out + (j < 0 ? '' : s.slice(j));
}
const PERIOD_CHECK = "    if (!perfScreenPeriodOk_(d, ppStart, perfScreenToday_())) return ";
const DAY_RE = "/^\\d{4}-\\d{2}-\\d{2}$/";

const MUTATIONS = [
  /* The age. */
  ['a kept answer is shown at the age it had at the door, not its age now',
   (s) => inFn(s, 'perfScreenCacheGet_', "var age = age0 + Math.ceil((now - at) / 60000);", "var age = age0;")],
  ['part of a minute is rounded DOWN',
   (s) => inFn(s, 'perfScreenCacheGet_', "Math.ceil((now - at) / 60000)", "Math.floor((now - at) / 60000)")],
  ['a hit reports no age at all',
   (s) => inFn(s, 'perfFromSnapshot_', "return { use: true, d: hit.d, age: hit.age, kept: true };", "return { use: true, d: hit.d, age: null, kept: true };")],
  ['a kept answer with no age counts as brand new',
   (s) => inFn(s, 'perfScreenCacheGet_', "    if (age0 === null || age0 < 0) return null;\n", "")],

  /* The freshness rule, run again. */
  ['the freshness rule is NOT run again on a kept answer',
   (s) => inFn(s, 'perfScreenCacheGet_', "    if (perfSnapshotRefusal_(d, age, true)) return null;\n", "")],
  ['a kept ended period is not held to GX Core\'s max_age_minutes',
   (s) => inFn(s, 'perfSnapshotRefusal_', "  if (kept) {", "  if (false) {")],
  ['an ended period with no max_age_minutes counts as within it',
   (s) => inFn(s, 'perfSnapshotRefusal_', "if (max === null || age > max)", "if (max !== null && age > max)")],
  ['the running-period limit is loosened to 30',
   (s) => s.replace("var SNAPSHOT_OPEN_MAX_MIN = 20;", "var SNAPSHOT_OPEN_MAX_MIN = 30;")],
  ['an ended period is held to the running period\'s limit instead of its own',
   (s) => inFn(s, 'perfSnapshotRefusal_', "  if (open) return age > SNAPSHOT_OPEN_MAX_MIN", "  if (open || kept) return age > SNAPSHOT_OPEN_MAX_MIN")],

  /* The five minutes. */
  ['the five minutes are left to the cache to enforce',
   (s) => inFn(s, 'perfScreenCacheGet_', " || now - at > PERF_SCREEN_CACHE_S * 1000", "")],
  ['the copy is kept for ten minutes',
   (s) => s.replace("var PERF_SCREEN_CACHE_S = 300;", "var PERF_SCREEN_CACHE_S = 600;")],
  ['an entry stamped in the future is accepted',
   (s) => inFn(s, 'perfScreenCacheGet_', "now < at || ", "")],
  /* NOT HERE, ON PURPOSE: dropping the `at === null` test. With no time on the entry the lifetime
     check beside it already refuses (a number minus nothing is past five minutes), so that removal
     changes no behavior and no test could tell. The explicit test stays in the code because it
     says what is meant; the suite pins the behavior ("an entry with no time on it"). */

  /* What may be kept. */
  ['the freshness rule is not applied before keeping',
   (s) => inFn(s, 'perfScreenCachePut_', " || perfSnapshotRefusal_(d, age, true)) return false;", ") return false;")],
  ['an answer not marked as the snapshot is kept',
   (s) => inFn(s, 'perfScreenCachePut_', "if (!d || d.ok === false || d.snapshot !== true) return false;", "if (!d || d.ok === false) return false;")],
  ['an answer for another period is kept',
   (s) => inFn(s, 'perfScreenCachePut_', PERIOD_CHECK + "false;\n", "")],
  ['the size ceiling is gone',
   (s) => inFn(s, 'perfScreenCachePut_', "    if (body.length >= PERF_SCREEN_MAX_BODY) return false;\n", "")],
  ['Crew\'s own marker is stored with the answer',
   (s) => inFn(s, 'perfFromSnapshot_', "    var kept = key ? perfScreenCachePut_(key, ppStart, d, age) : false;\n", "    d.crew_perf_cache = 'miss';\n    var kept = key ? perfScreenCachePut_(key, ppStart, d, age) : false;\n")],
  ['a stale answer is kept before it is judged',
   (s) => inFn(s, 'perfFromSnapshot_', "  var refusal = perfSnapshotRefusal_(d, age, false);",
               "  try { CacheService.getScriptCache().put(PERF_SCREEN_CACHE_PREFIX + ppStart, JSON.stringify({ at: Date.now(), d: d }), 300); } catch (e9) {}\n  var refusal = perfSnapshotRefusal_(d, age, false);")],
  ['a refusal is kept',
   (s) => inFn(s, 'perfFromSnapshot_', "  if (!d || d.ok === false) return { use: false,",
               "  try { CacheService.getScriptCache().put(PERF_SCREEN_CACHE_PREFIX + ppStart, JSON.stringify({ at: Date.now(), d: d }), 300); } catch (e9) {}\n  if (!d || d.ok === false) return { use: false,")],

  /* What may be read back. */
  ['an entry for another period is used',
   (s) => inFn(s, 'perfScreenCacheGet_', PERIOD_CHECK + "null;\n", "")],
  ['an entry that is not a snapshot answer is used',
   (s) => inFn(s, 'perfScreenCacheGet_', "if (!d || d.ok === false || d.snapshot !== true) return null;", "if (!d) return null;")],
  ['the key ignores the pay period',
   (s) => inFn(s, 'perfScreenKey_', ".test(pp)) tail = pp;", ".test(pp)) tail = 'period';")],
  ['any text at all makes a key',
   (s) => inFn(s, 'perfScreenKey_', "else if (" + DAY_RE + ".test(pp)) tail = pp;", "else tail = pp;")],

  /* A load that names no period — "the current one". */
  ['a load that names no period is not kept at all (as it was before v1.420)',
   (s) => inFn(s, 'perfScreenKey_', "tail = today ? 'current@' + today : '';", "tail = '';")],
  ['the no-period key does not carry the day',
   (s) => inFn(s, 'perfScreenKey_', "tail = today ? 'current@' + today : '';", "tail = today ? 'current@' : '';")],
  ['a no-period load shares the dated entry\'s key space (keyed on the day alone)',
   (s) => inFn(s, 'perfScreenKey_', "tail = today ? 'current@' + today : '';", "tail = today;")],
  ['the day is taken from toISOString — UTC, tomorrow from 5 PM Pacific',
   (s) => inFn(s, 'perfScreenToday_', "String(Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'))", "new Date().toISOString().slice(0, 10)")],
  ['a date that cannot be had fails the screen',
   (s) => inFn(s, 'perfScreenToday_', "  } catch (e) { return ''; }", "  } catch (e) { throw e; }")],
  ['a day in any shape is used as it comes',
   (s) => inFn(s, 'perfScreenToday_', "return " + DAY_RE + ".test(day) ? day : '';", "return day;")],
  ['a period that is NOT running is kept as the current one',
   (s) => inFn(s, 'perfScreenPeriodOk_', "if (!per || per.current !== true) return false;", "if (!per) return false;")],
  ['a truthy stand-in counts as running',
   (s) => inFn(s, 'perfScreenPeriodOk_', "per.current !== true", "!per.current")],
  ['a start that is not a plain date is accepted',
   (s) => inFn(s, 'perfScreenPeriodOk_', "if (!day.test(start) || ", "if (")],
  ['the rule runs without a readable today',
   (s) => inFn(s, 'perfScreenPeriodOk_', " || !day.test(String(today || ''))", "")],
  ['a period that has not started yet is accepted',
   (s) => inFn(s, 'perfScreenPeriodOk_', " || start > today) return false;", ") return false;")],
  ['a period that ended before today is accepted',
   (s) => inFn(s, 'perfScreenPeriodOk_', " || today > String(per.end)) return false;", ") return false;")],
  ['an end that cannot be read is waved through',
   (s) => inFn(s, 'perfScreenPeriodOk_', "if (!day.test(String(per.end)) || ", "if (")],
  ['a no-period answer is not checked at all',
   (s) => inFn(s, 'perfScreenPeriodOk_', "  if (pp !== '') return ", "  if (pp === '') return true;\n  if (pp !== '') return ")],
  ['a named period accepts an answer for any period',
   (s) => inFn(s, 'perfScreenPeriodOk_', "|| d.pp_start || '') === pp;", "|| d.pp_start || '') !== '';")],
  ['a no-period load asks the door for a period by date',
   (s) => inFn(s, 'perfFromSnapshot_', "{ pp_start: ppStart || '' }", "{ pp_start: ppStart || Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd') }")],

  /* The bust. */
  ['a bust is not looked for',
   (s) => inFn(s, 'perfScreenCacheGet_', "    if (busted !== null && busted >= at) return null;\n", "")],
  ['a bust in the same instant as the answer is missed',
   (s) => inFn(s, 'perfScreenCacheGet_', "busted >= at", "busted > at")],
  ['a comp-setting save does not void the copy',
   (s) => inFn(s, 'gxSetKvViaWeb_', "    bustPerfScreenCache_();\n", "")],
  ['a REFUSED comp-setting save voids the copy anyway',
   (s) => inFn(s, 'gxSetKvViaWeb_', "    var d = JSON.parse(res.getContentText());\n", "    var d = JSON.parse(res.getContentText());\n    bustPerfScreenCache_();\n")],
  ['a roster write does not void the copy',
   (s) => inFn(s, 'bustRosterCache_', "  try { bustPerfScreenCache_(); } catch (e) {}\n", "")],
  ['the bust is forgotten after five minutes',
   (s) => s.replace("var PERF_SCREEN_BUST_S = 21600;", "var PERF_SCREEN_BUST_S = 300;")],

  /* A cache that is down. */
  ['a cache READ that throws fails the screen',
   (s) => inFn(s, 'perfScreenCacheGet_', "  } catch (e) { return null; }", "  } catch (e) { throw e; }")],
  ['a cache WRITE that throws fails the screen',
   (s) => inFn(s, 'perfScreenCachePut_', "  } catch (e) { return false; }", "  } catch (e) { throw e; }")],
  ['a bust that cannot write throws',
   (s) => inFn(s, 'bustPerfScreenCache_', "catch (e) { /* a cache that is down has nothing to serve either */ }", "catch (e) { throw e; }")],

  /* The two locks. */
  ['the copy is read without the arm',
   (s) => inFn(s, 'perfFromSnapshot_', "var key = armed ? perfScreenKey_(ppStart) : '';", "var key = perfScreenKey_(ppStart);")],
  ['an unarmed caller keeps its answer',
   (s) => inFn(s, 'perfFromSnapshot_', "  if (armed) {\n    /* Kept BEFORE", "  if (true) {\n    key = perfScreenKey_(ppStart);\n    /* Kept BEFORE")],
  ['the store email is armed too',
   (s) => inFn(s, 'getIncentive_', "_perfScreenArmed_ = (preAuth === undefined);", "_perfScreenArmed_ = true;")],
  ['a truthy stand-in arms it',
   (s) => inFn(s, 'perfScreenArmedTake_', "(_perfScreenArmed_ === true)", "(!!_perfScreenArmed_)")],
  ['the look does not disarm it',
   (s) => inFn(s, 'perfScreenArmedTake_', "  _perfScreenArmed_ = false;\n", "")],
  ['the arm survives a fetch that throws',
   (s) => inFn(s, 'getIncentive_', "} finally { _perfScreenArmed_ = false; }", "} finally { }")],
  ['a request does not clear the arm before it runs',
   (s) => inFn(s, 'route_', /  _perfScreenArmed_ = false;[^\n]*\n/, "")],
  ['approve asks for the screen\'s snapshot',
   (s) => inFn(s, 'incentiveApprove_', "  var live = perfForWrite_(pp);", "  var live = perfForWrite_(pp, null, { snapshot: true });")],
  ['the send preview asks for the screen\'s snapshot',
   (s) => inFn(s, 'incentiveSend_', "    var live = perfForWrite_(pp);", "    var live = perfForWrite_(pp, null, { snapshot: true });")],
  ['approve opens BOTH locks: arms itself and asks for the snapshot',
   (s) => inFn(s, 'incentiveApprove_', "  var live = perfForWrite_(pp);", "  _perfScreenArmed_ = true; var live = perfForWrite_(pp, null, { snapshot: true });")],
  ['every fetch is the screen\'s: the shared fetch ignores who is asking',
   (s) => inFn(s, 'fetchLivePerfFromCore_', "var snap = (opts && opts.snapshot) ? perfFromSnapshot_(ppStart) : null;", "var snap = perfFromSnapshot_(ppStart);")],
  ['a second reader of the copy appears, on the approval path',
   (s) => inFn(s, 'incentiveApprove_', "  var live = perfForWrite_(pp);", "  var live = perfForWrite_(pp); perfScreenCacheGet_(perfScreenKey_(pp), pp);")],

  /* What the screen and the timing tool are told. */
  ['the payload does not say hit or miss',
   (s) => inFn(s, 'mapCorePerf_', /  if \(d && typeof d\.crew_perf_cache === 'string'[^\n]*\n/, "")],
  ['a hit is reported as a miss',
   (s) => inFn(s, 'perfFromSnapshot_', "hit.d.crew_perf_cache = 'hit';", "hit.d.crew_perf_cache = 'miss';")],
  ['an answer that could not be kept is reported as kept',
   (s) => inFn(s, 'perfFromSnapshot_', "kept ? 'miss' : 'skip'", "'miss'")],
  ['a hit is not marked for the timing tool',
   (s) => inFn(s, 'perfFromSnapshot_', "      reqMark_('perf_cache_hit');\n", "")],
  ['a door read is not marked for the timing tool',
   (s) => inFn(s, 'perfFromSnapshot_', "  reqMark_('perf_door');\n", "")],
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
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'perf_screen_cache_test.js')],
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
