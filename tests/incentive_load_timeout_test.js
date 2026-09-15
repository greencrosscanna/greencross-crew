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

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
