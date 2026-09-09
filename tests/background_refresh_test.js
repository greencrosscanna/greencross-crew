#!/usr/bin/env node
/* ─── Background work does not compete with the user for GX Core ───────────────────────────────
 *
 *   RUN:  node tests/background_refresh_test.js
 *
 * WHY THIS EXISTS
 * Sky, 2026-09-09: "incentive tab is taking a long time to load." Measured from his browser: 22
 * requests to script.google.com, 15 of them to GX CORE, 656 seconds of request time between them.
 * Crew's own engine answered `health` in 2.2s and the whole incentive payload in 8-12s. The wait
 * was almost entirely the hub.
 *
 * MOST OF THOSE 15 WERE RETRIES, not separate call sites — and that is the part Crew owns. A
 * browser opens about six connections to one host, and every app in the suite lives on
 * script.google.com. When GX Core's heavy routes are slow (36-90s that afternoon), a client
 * timeout of 8-20s fires before the answer arrives, the call retries, and each retry takes another
 * connection AND queues more work on the hub that is already behind. The user's own data is in
 * that same queue.
 *
 * `resolveEngine` refreshing `cfg.crewEngineUrl` is the clearest case: it is a BACKGROUND correction
 * of a value the app already has and is already using, and it was configured `retries: 3,
 * timeoutMs: 20000` — up to four requests over a minute, for a value that is almost never
 * different, while the user waits for their roster.
 *
 * WHAT MUST HOLD:
 *   1. The background refresh does not retry. If it does not answer, the remembered URL stays
 *      correct and the next load asks again.
 *   2. Its timeout is patient rather than short — a short timeout on unwatched work is what
 *      manufactures the retry in the first place.
 *   3. It is still fire-and-forget: nothing awaits it, and a failure cannot break the load.
 *   4. The BLOCKING lookup — cold cache, nothing remembered, somebody genuinely waiting — keeps its
 *      retries. That one is not background work and the rules are opposite.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
function fnSrc(name) {
  const i = JS.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = JS.indexOf('{', i); k < JS.length; k++) {
    if (JS[k] === '{') d++;
    else if (JS[k] === '}') { d--; if (!d) return JS.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

console.log('\nThe engine-URL refresh is background work and behaves like it');
{
  const R = decomment(fnSrc('resolveEngine'));

  /* The two lookups, told apart by which side of the `remembered` guard they are on. The first is
     the background correction; the second is the cold-cache path somebody is actually waiting on. */
  const bg = R.slice(R.indexOf('if (remembered) {'), R.indexOf('return Engine;'));
  const blocking = R.slice(R.indexOf('return Engine;'));

  ok('the background refresh exists at all', /GXCore\.jsonp\('config'/.test(bg));
  /* THE FIX. Retrying here is what turns one slow hub into four queued requests, on six connections
     shared with the data the user is waiting for. */
  ok('and it does NOT retry', /retries: 0/.test(bg) && !/retries: [1-9]/.test(bg));
  /* A short timeout on unwatched work manufactures the retry — it declares failure before a slow
     answer can arrive, and something has to be done about the "failure". */
  ok('its timeout is patient, not short', /timeoutMs: 45000/.test(bg));
  /* Fire-and-forget: nothing waits on it, and a rejection cannot surface as a broken load. */
  ok('nothing awaits it', !/await\s+GXCore\.jsonp\('config'/.test(bg));
  ok('and it swallows its own failure', /\.catch\(/.test(bg));
  ok('it only writes back when the value actually changed',
     /String\(r\.value\) !== remembered/.test(bg));

  /* THE OPPOSITE RULE FOR THE OPPOSITE CASE. Cold cache means there is no remembered URL, nothing
     to fall back to but the constant, and a person watching a blank screen — retries are right. */
  ok('the cold-cache lookup still retries, because somebody IS waiting',
     /await GXCore\.jsonp\('config'/.test(blocking) && /retries: 3/.test(blocking));
}

console.log('\nThe rest of the boot path does not hammer the hub either');
{
  /* Crew makes very few GX Core calls by design — the rest of its traffic goes to its own engine,
     which is the whole point of the 2026-09-03 sign-in move. This pins that the count stays small:
     a new GXCore.jsonp call site is a decision, not a detail. */
  const sites = (decomment(JS).match(/GXCore\.jsonp\(/g) || []).length;
  ok('Crew still makes only a handful of direct GX Core calls (' + sites + ')', sites <= 5);
  /* The EoM config read is the other unwatched one and is already modest — asserted so it does not
     drift up to match some future copy-paste. */
  const eom = decomment(fnSrc('loadEom'));
  ok('the EoM lookup stays cheap too', /retries: 1/.test(eom));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
