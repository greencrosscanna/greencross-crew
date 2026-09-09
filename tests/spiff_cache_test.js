#!/usr/bin/env node
/* ─── The screen reads GX Core; the money paths read SPIFF itself ────────────────────────────────
 *
 *   RUN:  node tests/spiff_cache_test.js    (from the repo root; no deps, no network, no login)
 *
 * WHY THIS EXISTS
 * Asking SPIFF for vendor earnings was a whole extra Apps Script web-app round trip — ~4 seconds,
 * measured — on every load of the incentive screen, which was taking 20-30s and filing
 * jsonp-timeout bug reports. It was cached for the screen and only the screen.
 *
 * Since 2026-09-08 SPIFF publishes its finished per-employee figures to GX Core after every
 * refresh, so the screen reads them from Core instead of calling another app at all. The flag now
 * chooses the SOURCE as well as the cache, and the split is the same one and for the same reason.
 * Two of the four callers freeze vendor money into crew_incentive_history, which can never be
 * recomputed:
 *
 *     getIncentive_          paints a screen, writes nothing        -> GX Core, cached
 *     incentiveApprove_      writes the immutable record           -> MUST be SPIFF, live
 *     incentiveSend_         states the total being sent to approve -> MUST be SPIFF, live
 *     incentiveProbe_        the diagnostic; a cached probe is a lie about the live path
 *
 * That exception is documented and deliberate, not an oversight for a later session to tidy away:
 * a stale figure frozen into history is silent and permanent, where a live read that fails is loud
 * and recoverable in front of the person who just clicked Approve.
 *
 * So the flag is opt-IN: a call site added later gets correctness by default and has to ask for
 * speed. This test pins that, because the failure mode of getting it backwards is a bonus frozen
 * off a stale number, and nothing about the result looks wrong.
 *
 * AND THE NEW FAILURE MODE THE SOURCE INTRODUCES: nothing on the Core path recomputes. If SPIFF
 * stops publishing, the payload just gets older and NOTHING throws anywhere. So the age is
 * recomputed from published_at on every read — never taken from the envelope, which would be
 * frozen by the cache and would keep reassuring.
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
             + (GS.match(/var SPIFF_PROGRESS_CACHE_KEY\s*=\s*[^;]+;/) || [''])[0]
             + (GS.match(/var SPIFF_PUBLISHED_STALE_MIN\s*=\s*[^;]+;/) || [''])[0];
if (!/CACHE_S/.test(CONSTS) || !/CACHE_KEY/.test(CONSTS)) bad('the cache constants are not in Code.gs');

/* ── A fake world: one cache, one SPIFF, both counting how often they are touched ─────────────── */
function world(spiffReplies, coreReplies) {
  const store = Object.create(null);
  const calls = { fetch: 0, put: [], removed: 0, core: 0 };
  let n = 0, cn = 0;
  const CORE_OK = { ok: true, scope: '2026-08-17', published_at: new Date().toISOString(),
                    published_by: 'spiff', age_minutes: 3,
                    payload: { ok: true, refreshed_at: '2026-09-08 18:57:04',
                               rows: [{ program_id: 'p1', earned: 25 }], by_employee: [] } };
  const cReplies = coreReplies || [CORE_OK];
  const sandbox = {
    GXCore: {
      getKv: k => (k === 'spiffProgress' ? 'https://spiff.example/exec' : ''),
      publishedSpiffProgress: () => {
        calls.core++;
        const r = cReplies[Math.min(cn++, cReplies.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    },
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
  const fns = new Function(...names, CONSTS + grab('spiffProgressCacheClear_')
    + grab('spiffPublishedAgeMin_') + grab('spiffProgressFromCore_') + grab('spiffProgressFor_')
    + '; return { get: spiffProgressFor_, clear: spiffProgressCacheClear_, age: spiffPublishedAgeMin_,'
    + '           TTL: SPIFF_PROGRESS_CACHE_S, KEY: SPIFF_PROGRESS_CACHE_KEY,'
    + '           STALE: SPIFF_PUBLISHED_STALE_MIN };')(...names.map(k => sandbox[k]));
  return { fns, calls, store };
}
const okReply  = { code: 200, body: JSON.stringify({ ok: true, refreshed_at: '2026-09-01T00:00:00Z', rows: [{ program_id: 'p1' }] }) };
const badReply = { code: 500, body: 'nope' };

const CORE_FAIL = { ok: false, error: 'nothing published for scope 2026-08-17' };

console.log('\n1. the screen reads GX Core, once, and never SPIFF');
{
  const w = world([okReply]);
  const a = w.fns.get('2026-08-17', true);
  const b = w.fns.get('2026-08-17', true);
  a.ok && b.ok ? ok('both reads succeeded') : bad('a cached read did not come back ok');
  w.calls.core === 1 ? ok('Core was asked exactly once for two loads') : bad('Core was asked ' + w.calls.core + ' times');
  w.calls.fetch === 0 ? ok('and SPIFF was never called directly — that is the whole point') : bad('the screen still called SPIFF ' + w.calls.fetch + ' times');
  b.from_cache === true ? ok('the second says so — from_cache rides on the payload') : bad('from_cache not set on the hit');
  a.from_cache === false ? ok('while the first says it was read live') : bad('the MISS should report from_cache false, got ' + a.from_cache);
  w.calls.put[0] === w.fns.TTL ? ok('stored for the shipped TTL (' + w.fns.TTL + 's)') : bad('wrong TTL: ' + w.calls.put[0]);
  a.source === 'gxcore' ? ok('and the payload says where it came from') : bad('source was ' + a.source);
  a.rows && a.rows.length ? ok('the rows come through unwrapped from the envelope') : bad('no rows on the Core payload');
}

console.log('\n2. WITHOUT the flag it always goes to SPIFF — the default is correctness');
{
  const w = world([okReply]);
  w.fns.get('2026-08-17');           // no flag at all, as approval calls it
  w.fns.get('2026-08-17', false);
  w.calls.fetch === 2 ? ok('two uncached reads, two fetches straight to SPIFF') : bad('an uncached read was served from cache');
  w.calls.core === 0 ? ok('and Core is not consulted for money') : bad('a money path read the published copy');
  w.calls.put.length === 0 ? ok('and an uncached read does not POPULATE the cache either') : bad('an uncached read wrote to the cache');
}

console.log('\n3. a warm screen copy must not serve an approval');
{
  const w = world([okReply]);
  w.fns.get('2026-08-17', true);                       // the screen fills it from Core
  const fresh = w.fns.get('2026-08-17');               // approval asks
  w.calls.fetch === 1 ? ok('approval went to SPIFF even with the screen\'s copy sitting there') : bad('approval was served a cached figure');
  w.calls.core === 1 ? ok('and did not read Core instead') : bad('approval read Core');
  fresh.from_cache === false ? ok('its payload says the figure is live') : bad('approval got from_cache ' + fresh.from_cache);
  fresh.source !== 'gxcore' ? ok('and that it did not come from the published copy') : bad('approval payload claims gxcore');
}

console.log('\n4. a FAILED read is never cached — a cached $0 is indistinguishable from a quiet fortnight');
{
  const w = world([okReply], [CORE_FAIL, undefined]);
  const a = w.fns.get('2026-08-17', true);
  a.ok === false ? ok('nothing published is reported, not swallowed') : bad('a refusal came back ok');
  /nothing published/.test(a.error || '') ? ok('and it says so in Core\'s own words') : bad('lost the reason: ' + a.error);
  w.calls.put.length === 0 ? ok('and nothing was stored') : bad('a failure was cached for ' + w.fns.TTL + 's');
}

console.log('\n4b. a library that cannot answer is not "nobody earned anything"');
{
  /* An unbound GXCore, or a pin below v306 where publishedSpiffProgress does not exist, throws.
     Reading that as an empty result would put $0 in a vendor money column with no error at all. */
  const w = world([okReply], [new Error('publishedSpiffProgress is not a function')]);
  const a = w.fns.get('2026-08-17', true);
  a.ok === false ? ok('a throwing library is a failure, not an empty period') : bad('a thrown error came back ok');
  /publishedSpiffProgress/.test(a.error || '') ? ok('and the reason survives to the screen') : bad('lost the reason: ' + a.error);

  /* An envelope with no payload is the same class of thing. */
  const w2 = world([okReply], [{ ok: true, published_at: new Date().toISOString() }]);
  w2.fns.get('2026-08-17', true).ok === false
    ? ok('an envelope with no rows is refused too') : bad('a payload-less envelope came back ok');
}

console.log('\n5. an unreadable cache entry is not an answer');
{
  const w = world([okReply]);
  w.store[w.fns.KEY] = '{not json';
  const a = w.fns.get('2026-08-17', true);
  a.ok === true && w.calls.core === 1 ? ok('it falls through and re-reads rather than throwing') : bad('corrupt cache broke the read');
}

console.log('\n6. refreshing SPIFF drops the screen\'s copy');
{
  const w = world([okReply]);
  w.fns.get('2026-08-17', true);
  w.fns.clear();
  w.fns.get('2026-08-17', true);
  w.calls.core === 2 ? ok('a cleared cache is re-read') : bad('the clear did not take');
}

console.log('\n6b. AGE is recomputed from published_at, never taken from the envelope');
{
  /* The envelope carries age_minutes, and caching it would freeze that number — a staleness check
     that itself goes stale is worse than none, because it actively reassures. */
  const hourAgo = new Date(Date.now() - 60 * 60000).toISOString();
  const w = world([okReply], [{ ok: true, published_at: hourAgo, published_by: 'spiff',
                                age_minutes: 0,          // a lie the cache would have frozen
                                payload: { ok: true, rows: [{ program_id: 'p1' }] } }]);
  const a = w.fns.get('2026-08-17', true);
  const age = w.fns.age(a.published_at);
  age >= 59 && age <= 61 ? ok('an hour-old publication measures as an hour (' + age + ' min)') : bad('age came out ' + age);

  w.fns.age('') === null ? ok('no timestamp reads as unknown, not as fresh') : bad('an empty published_at gave ' + w.fns.age(''));
  w.fns.age('nope') === null ? ok('and neither does junk') : bad('junk gave ' + w.fns.age('nope'));
  /* SPIFF writes "2026-09-08 18:58:15"; Core's envelope writes ISO. Both have to measure. */
  const sp = w.fns.age(new Date(Date.now() - 120 * 60000).toISOString().replace('T', ' ').slice(0, 19));
  sp >= 119 && sp <= 121 ? ok("SPIFF's space-separated format measures too (" + sp + ' min)') : bad('space format gave ' + sp);
  w.fns.age(new Date(Date.now() + 60 * 60000).toISOString()) === 0
    ? ok('and clock skew into the future clamps to 0 rather than going negative') : bad('a future timestamp gave a negative age');
  typeof w.fns.STALE === 'number' && w.fns.STALE > 0
    ? ok('the staleness threshold is a named constant (' + w.fns.STALE + ' min)') : bad('no staleness threshold');
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
