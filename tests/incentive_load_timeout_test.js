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

console.log('\nEngine\n');
const body = GS.slice(GS.indexOf('function getIncentive_('), GS.indexOf('function computedPeriods_('));
ok('the live payload carries per-stage timings', /live\.timings = timings;/.test(body) && /timings\.total = Date\.now\(\) - T0;/.test(body));
ok('the performance fetch is timed apart from the stamp', /timings\.perf_fetch = /.test(GS) && /timings\.stamp = /.test(GS));
ok('perfForWrite_ still works without a timings object (both write paths call it bare)',
   /if \(timings\) \{ timings\.perf_fetch/.test(GS) && /perfForWrite_\(pp\)|perfForWrite_\(want\)|perfForWrite_\(/.test(GS));

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
