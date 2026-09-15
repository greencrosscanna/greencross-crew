#!/usr/bin/env node
/* ─── The incentive load waits long enough to get its answer ──────────────────────────────────────
 *
 *   RUN:  node tests/incentive_load_timeout_test.js
 *
 * 2026-09-15: Sky saw "GX jsonp "incentive" failed after 2 tries: jsonp timeout". The route's own
 * work measured ~11s; the round trip through Apps Script measured 25-48s. With a 45s per-attempt
 * budget the first try was abandoned just before answering and the retry queued a second full
 * computation. A short timeout on a slow-but-alive route manufactures the failure it reports.
 *
 * Also pins the engine's `timings` payload, which is how the next slow load gets diagnosed without
 * guessing whether Crew or the platform is the slow part.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

console.log('\nBrowser\n');
const m = JS.match(/Engine\.jsonp\('incentive', params, \{ timeoutMs: (\d+), retries: (\d+) \}\)/);
ok('the incentive load is a single call site', !!m && (JS.match(/Engine\.jsonp\('incentive',/g) || []).length === 1);
ok('its per-attempt budget clears the measured 48s round trip (>= 90s)', m && +m[1] >= 90000);
ok('it still retries once — the HTML second-hop miss fails fast and needs it', m && +m[2] === 1);

console.log('\nApprove and send — same recompute, same budget\n');
['incentive_approve', 'incentive_send'].forEach(function (route) {
  const re = new RegExp("Engine\\.jsonp\\('" + route + "',[\\s\\S]*?\\{ timeoutMs: (\\d+), retries: (\\d+) \\}\\)", 'g');
  const calls = [...JS.matchAll(re)];
  ok(route + ' has a call site', calls.length > 0);
  calls.forEach((c, i) => ok(route + ' call ' + (i + 1) + ' waits >= 90s (got ' + c[1] + ')', +c[1] >= 90000));
});

console.log('\nEngine\n');
const body = GS.slice(GS.indexOf('function getIncentive_('), GS.indexOf('function computedPeriods_('));
ok('the live payload carries per-stage timings', /live\.timings = timings;/.test(body) && /timings\.total = Date\.now\(\) - T0;/.test(body));
ok('the performance fetch is timed apart from the stamp', /timings\.perf_fetch = /.test(GS) && /timings\.stamp = /.test(GS));
ok('perfForWrite_ still works without a timings object (both write paths call it bare)',
   /if \(timings\) \{ timings\.perf_fetch/.test(GS) && /perfForWrite_\(pp\)|perfForWrite_\(want\)|perfForWrite_\(/.test(GS));

console.log('\nEngine: the 11 seconds, trimmed (2026-09-15)\n');
{
  function fnSrc(src, name) {
    const i = src.indexOf('function ' + name + '(');
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
  }
  /* 1. The attrs sheet is prepared once per request, and the memo cannot outlive the request. */
  let prepared = 0;
  const C = new Function('crewSheetPrepare_', 'var _crewSheetMemo_ = null;\n' + fnSrc(GS, 'crewSheet_') +
    '\n; return { crewSheet_: crewSheet_, reset: function () { _crewSheetMemo_ = null; } };')
    (() => { prepared++; return { sheet: prepared }; });
  C.crewSheet_(); C.crewSheet_(); C.crewSheet_();
  ok('crewSheet_ prepares the sheet once however often it is asked', prepared === 1);
  C.reset(); C.crewSheet_();
  ok('…and again after a reset', prepared === 2);
  ok('an attrs WRITE prepares the sheet fresh, so a bulk import keeps "00" formatted as text on every new row',
     /var sh = _crewSheetMemo_ = crewSheetPrepare_\(\);/.test(fnSrc(GS, 'writeAttrs_')));
  ok('route_ resets the memo before doing anything else — a warm instance must not carry it',
     /function route_\(e\) \{\s*_crewSheetMemo_ = null;/.test(GS));

  /* 2. The screen reads the real history tab once. */
  const G = fnSrc(GS, 'getIncentive_');
  ok('getIncentive_ reads the REAL history tab once and shares the rows',
     /var historyRows = readTab_\(HISTORY_TAB, HISTORY_HEADERS\);/.test(G) &&
     /historyPeriods_\('', historyRows\)/.test(G) && /historyBand_\(live\.payPeriod\.start, historyRows\)/.test(G));
  ok('historyPeriods_ only accepts handed-in rows for the real tab, never a practice key',
     /rows && !pp \? rows : readTab_\(incTab_\(HISTORY_TAB, pp\)/.test(fnSrc(GS, 'historyPeriods_')));

  /* 3. Only the screen may use a cached sales read. */
  const calls = GS.match(/storeTotals_\(live[^)]*\)/g) || [];
  ok('exactly one storeTotals_ call uses the cache, and it is the screen\'s',
     calls.filter((c) => /true/.test(c)).length === 1 && /live\.store_totals = storeTotals_\(live, true\)/.test(G));
  const ST = fnSrc(GS, 'storeTotals_');
  ok('an empty sales read is never cached as the answer', /if \(salesCache && rows && rows\.length\)/.test(ST));
  ok('the cache is consulted only when asked', /if \(useCache\) \{/.test(ST));
}

console.log('\nEngine: the screen reads GX Core\'s snapshot, within Sky\'s freshness limit\n');
{
  function fnSrc(src, name) {
    const i = src.indexOf('function ' + name + '(');
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
  }
  const LIMIT = (GS.match(/var SNAPSHOT_OPEN_MAX_MIN = (\d+);/) || [])[1];
  ok('the running-period limit is 20 minutes (15-minute warmer plus a rebuild)', LIMIT === '20');
  let answer, asked = 0;
  const core = { incentivePerf: () => { asked++; return answer; } };
  const P = new Function('GXCore', 'SNAPSHOT_OPEN_MAX_MIN', fnSrc(GS, 'perfFromSnapshot_') + '; return perfFromSnapshot_;')
    (core, 20);
  const snap = (o) => Object.assign({ snapshot: true, ok: true, pp_start: '2026-09-14', payPeriod: { start: '2026-09-14', current: true },
                                      age_minutes: 5, stale: true }, o);
  answer = { ok: true, pp_start: '2026-09-14', payPeriod: { start: '2026-09-14', current: true },
             cached: true, cache_policy: 'open-3min' };
  ok('an in-process answer under GX Core\'s own cache policy → used, with no age limit applied',
     P('').use === true && P('').inProcess === true);
  answer = snap({ snapshot: true, cache_policy: 'open-3min', age_minutes: 25 });
  ok('…but a real snapshot that also names a policy still obeys the age limit', P('').use === false);
  const snap0 = snap;
  answer = snap({ age_minutes: 14 });
  ok('running period, 14 min old → used (GX Core calls it stale; Sky\'s limit is what counts)', P('').use === true);
  answer = snap({ age_minutes: 21 });
  ok('running period, 21 min old → falls back to a live calculation', P('').use === false);
  answer = snap({ payPeriod: { start: '2026-08-31', current: false }, age_minutes: 12, stale: false });
  ok('ended period GX Core calls fresh → used', P('2026-08-31').use === true);
  answer = snap({ payPeriod: { start: '2026-08-31', current: false }, age_minutes: 12, stale: true });
  ok('ended period GX Core calls stale → falls back, even at 12 min', P('2026-08-31').use === false);
  answer = snap({ age_minutes: null });
  ok('age unknown → falls back, never "fresh"', P('').use === false);
  answer = { ok: false, snapshot: 'missing', error: 'no snapshot' };
  ok('missing snapshot → falls back and says why', P('').use === false && /missing/.test(P('').why));
  answer = snap({ pp_start: '', payPeriod: {} });
  ok('a snapshot naming no period → falls back', P('').use === false);
  const noDoor = new Function('GXCore', 'SNAPSHOT_OPEN_MAX_MIN', fnSrc(GS, 'perfFromSnapshot_') + '; return perfFromSnapshot_;')({}, 20);
  ok('a GXCore pin without the door → falls back', noDoor('').use === false);
  const thrower = new Function('GXCore', 'SNAPSHOT_OPEN_MAX_MIN', fnSrc(GS, 'perfFromSnapshot_') + '; return perfFromSnapshot_;')
    ({ incentivePerf: () => { throw new Error('boom'); } }, 20);
  ok('a door that throws → falls back', thrower('').use === false && /boom/.test(thrower('').why));

  /* Sliced to the next function rather than brace-counted: the body compares a character to '{'. */
  const F = GS.slice(GS.indexOf('function fetchLivePerfFromCore_('), GS.indexOf('function mapCorePerf_('));
  ok('the fetch consults the snapshot ONLY when asked', /var snap = \(opts && opts\.snapshot\) \? perfFromSnapshot_\(ppStart\) : null;/.test(F));
  ok('every door goes through the one mapping', (F.match(/mapCorePerf_\(/g) || []).length === 3 && !/body\.forEach|name: *String\(r\.name/.test(F));
  const calls = (GS.match(/perfForWrite_\([^)]*\)/g) || []).filter((c) => !/function|\(pp, timings, opts\)/.test(c));
  ok('exactly one caller asks for the snapshot, and it is the screen',
     calls.filter((c) => /snapshot/.test(c)).length === 1 &&
     /perfForWrite_\(want, timings, \{ snapshot: true \}\)/.test(fnSrc(GS, 'getIncentive_')));
  ok('approval computes live (perfForWrite_ called bare)', /perfForWrite_\(pp\)/.test(fnSrc(GS, 'incentiveApprove_')));
  ok('the payload says which door answered and how old it is',
     /perf_source: \(extra && extra\.perf_source\) \|\| 'live'/.test(GS) && /perf_age_minutes:/.test(GS));
  ok('the screen says "sales as of" when the figures are the snapshot',
     /d\.perf_source === 'snapshot'/.test(JS) && /sales as of/.test(JS));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
