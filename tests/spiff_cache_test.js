#!/usr/bin/env node
/* ─── The SPIFF read is cached for the SCREEN and nothing else ───────────────────────────────────
 *
 *   RUN:  node tests/spiff_cache_test.js    (from the repo root; no deps, no network, no login)
 *
 * WHY THIS EXISTS
 * Asking SPIFF for vendor earnings is a whole extra Apps Script web-app round trip — ~4 seconds,
 * measured — and it ran on every load of the incentive screen, which was taking 20-30s and filing
 * jsonp-timeout bug reports. SPIFF serves that answer from a cache it only refills when somebody
 * runs a sweep, so the four seconds bought nothing.
 *
 * Caching it is therefore easy and the DANGEROUS part is where it applies. Two of the four callers
 * freeze vendor money into crew_incentive_history, which can never be recomputed:
 *
 *     getIncentive_          paints a screen, writes nothing        -> cached
 *     incentiveApprove_      writes the immutable record           -> MUST be fresh
 *     incentiveSend_         states the total being sent to approve -> MUST be fresh
 *     incentiveProbe_        the diagnostic; a cached probe is a lie about the live path
 *
 * So the flag is opt-IN: a call site added later gets correctness by default and has to ask for
 * speed. This test pins that, because the failure mode of getting it backwards is a bonus frozen
 * off a five-minute-old number, and nothing about the result looks wrong.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const bad = m => { fail++; console.log('  ✗ ' + m); };
const ok  = m => console.log('  ✓ ' + m);

const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = GS.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = GS.indexOf('{', i); k < GS.length; k++) {
    if (GS[k] === '{') d++; else if (GS[k] === '}') { d--; if (!d) return GS.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
/* The two constants come out of the SOURCE, not retyped here — a test that hardcodes the TTL stops
   testing the shipped one the moment somebody changes it. */
const CONSTS = (GS.match(/var SPIFF_PROGRESS_CACHE_S\s*=\s*[^;]+;/) || [''])[0]
             + (GS.match(/var SPIFF_PROGRESS_CACHE_KEY\s*=\s*[^;]+;/) || [''])[0];
if (!/CACHE_S/.test(CONSTS) || !/CACHE_KEY/.test(CONSTS)) bad('the cache constants are not in Code.gs');

/* ── A fake world: one cache, one SPIFF, both counting how often they are touched ─────────────── */
function world(spiffReplies) {
  const store = Object.create(null);
  const calls = { fetch: 0, put: [], removed: 0 };
  let n = 0;
  const sandbox = {
    GXCore: { getKv: k => (k === 'spiffProgress' ? 'https://spiff.example/exec' : '') },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'SECRET' }) },
    CacheService: { getScriptCache: () => ({
      get: k => (store[k] === undefined ? null : store[k]),
      put: (k, v, ttl) => { store[k] = v; calls.put.push(ttl); },
      remove: k => { delete store[k]; calls.removed++; },
    }) },
    UrlFetchApp: { fetch: () => {
      calls.fetch++;
      const r = spiffReplies[Math.min(n++, spiffReplies.length - 1)];
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    } },
  };
  const names = Object.keys(sandbox);
  const fns = new Function(...names, CONSTS + grab('spiffProgressCacheClear_') + grab('spiffProgressFor_')
    + '; return { get: spiffProgressFor_, clear: spiffProgressCacheClear_,'
    + '           TTL: SPIFF_PROGRESS_CACHE_S, KEY: SPIFF_PROGRESS_CACHE_KEY };')(...names.map(k => sandbox[k]));
  return { fns, calls, store };
}
const okReply  = { code: 200, body: JSON.stringify({ ok: true, refreshed_at: '2026-09-01T00:00:00Z', rows: [{ program_id: 'p1' }] }) };
const badReply = { code: 500, body: 'nope' };

console.log('\n1. the screen pays for SPIFF once, not on every load');
{
  const w = world([okReply]);
  const a = w.fns.get('2026-08-17', true);
  const b = w.fns.get('2026-08-17', true);
  a.ok && b.ok ? ok('both reads succeeded') : bad('a cached read did not come back ok');
  w.calls.fetch === 1 ? ok('SPIFF was asked exactly once for two loads') : bad('SPIFF was asked ' + w.calls.fetch + ' times');
  b.from_cache === true ? ok('and the second says so — from_cache rides on the payload') : bad('from_cache not set on the hit');
  a.from_cache === false ? ok('while the first says it was live') : bad('the MISS should report from_cache false, got ' + a.from_cache);
  w.calls.put[0] === w.fns.TTL ? ok('stored for the shipped TTL (' + w.fns.TTL + 's)') : bad('wrong TTL: ' + w.calls.put[0]);
}

console.log('\n2. WITHOUT the flag it always goes to SPIFF — the default is correctness');
{
  const w = world([okReply]);
  w.fns.get('2026-08-17');           // no flag at all, as approval calls it
  w.fns.get('2026-08-17', false);
  w.calls.fetch === 2 ? ok('two uncached reads, two fetches') : bad('an uncached read was served from cache');
  w.calls.put.length === 0 ? ok('and an uncached read does not POPULATE the cache either') : bad('an uncached read wrote to the cache');
}

console.log('\n3. a warm cache must not serve an approval');
{
  const w = world([okReply]);
  w.fns.get('2026-08-17', true);                       // the screen fills it
  const fresh = w.fns.get('2026-08-17');               // approval asks
  w.calls.fetch === 2 ? ok('approval went to SPIFF even with the screen\'s copy sitting there') : bad('approval was served a cached figure');
  fresh.from_cache === false ? ok('and its payload says the figure is live') : bad('approval got from_cache ' + fresh.from_cache);
}

console.log('\n4. a FAILED read is never cached — a cached $0 is indistinguishable from a quiet fortnight');
{
  const w = world([badReply, okReply]);
  const a = w.fns.get('2026-08-17', true);
  a.ok === false ? ok('the failure is reported, not swallowed') : bad('a 500 came back ok');
  w.calls.put.length === 0 ? ok('and nothing was stored') : bad('a failure was cached for ' + w.fns.TTL + 's');
  const b = w.fns.get('2026-08-17', true);
  b.ok === true ? ok('so the next load recovers as soon as SPIFF does') : bad('the failure stuck');
}

console.log('\n5. an unreadable cache entry is not an answer');
{
  const w = world([okReply]);
  w.store[w.fns.KEY] = '{not json';
  const a = w.fns.get('2026-08-17', true);
  a.ok === true && w.calls.fetch === 1 ? ok('it falls through and fetches rather than throwing') : bad('corrupt cache broke the read');
}

console.log('\n6. refreshing SPIFF drops the screen\'s copy');
{
  const w = world([okReply]);
  w.fns.get('2026-08-17', true);
  w.fns.clear();
  w.fns.get('2026-08-17', true);
  w.calls.fetch === 2 ? ok('a cleared cache is re-fetched') : bad('the clear did not take');
}

console.log('\n7. …and incentiveSpiffRefresh_ actually calls that clear');
{
  const body = grab('incentiveSpiffRefresh_');
  /clear/i.test(body) && body.includes('spiffProgressCacheClear_()')
    ? ok('the refresh route invalidates the cache, so a manager sees what they just re-measured')
    : bad('incentiveSpiffRefresh_ does not clear the cache — a refresh would visibly do nothing for ' + Math.round(300 / 60) + ' minutes');
}

console.log('\n8. exactly ONE call site opts in, and it is the screen');
{
  const cached = GS.match(/applySpiffEarnings_\([^)]*,\s*true\s*\)/g) || [];
  cached.length === 1 ? ok('one cached call site in the whole engine') : bad(cached.length + ' call sites pass the cache flag');
  grab('getIncentive_').match(/applySpiffEarnings_\([^)]*,\s*true\s*\)/)
    ? ok('and it is getIncentive_, the read-only screen route') : bad('the cached call site is not getIncentive_');
  ['incentiveApprove_', 'incentiveSend_', 'incentiveProbe_'].forEach(fn => {
    const b = grab(fn);
    if (!/applySpiffEarnings_/.test(b)) return bad(fn + ' no longer folds SPIFF at all — that is a different bug');
    /applySpiffEarnings_\([^)]*,\s*true\s*\)/.test(b)
      ? bad(fn + ' passes the cache flag — it freezes or reports money and must read fresh')
      : ok(fn + ' reads fresh');
  });
}

console.log(fail ? '\nspiff cache: ' + fail + ' FAILED' : '\nspiff cache: all passed');
process.exit(fail ? 1 : 0);
