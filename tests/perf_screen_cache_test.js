#!/usr/bin/env node
/* ─── The incentive screen keeps GX Core's performance answer for five minutes ────────────────────
 *
 *   RUN:            node tests/perf_screen_cache_test.js
 *   PROVE IT BITES: node scripts/prove-perf-screen-cache-red.js   (mutates a COPY of Code.gs)
 *
 * WHAT WAS SLOW (2026-10-13). `perf_fetch` was the largest stage left on the incentive screen: 0.9
 * to 2.5 seconds on every one of eleven live loads, all of them `perf_source=snapshot`. Nothing was
 * being recomputed. The time is the read itself — GX Core's library, running inside Crew, opening
 * GX Core's workbook and reading its whole snapshot tab.
 *
 * WHAT CHANGED. The screen keeps the answer it was given, for five minutes, in Crew's own script
 * cache. A copy read back is as old as GX Core said it was PLUS the time it has sat in Crew, and
 * the same freshness rule is run again on that figure.
 *
 * WHAT MUST NOT HAVE CHANGED, and what most of this file is for:
 *   - No figure. A kept answer is the answer GX Core gave, only older by the minutes shown.
 *   - Nothing about the paths that WRITE. Approve, send, the dry run and the preview must go on
 *     making their own fresh read of GX Core and must never see the screen's copy.
 *   - The store email, which leaves the app, asks GX Core every time.
 *
 * HOW. The WHOLE shipped Code.gs is loaded over fake Google services and driven through its real
 * router (tests/whole_engine_harness.js), with GX Core's door answering the way it does live — a
 * snapshot with an age — on a clock this file controls. Every call to the door is counted, and so is
 * every read and write of the cache, by key.
 *
 * BEFORE vs AFTER needs git to show the commit this branch started from, and SKIPS LOUDLY in a
 * shallow clone. Everything else runs regardless.
 *
 * CODE_GS=/path/to/Code.gs points the "after" side at another copy of the engine.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');
const { NOW, SECRET, T, PRACTICE, corePerf, world } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC_NEW = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
/* The commit this change was built on: v1.417, re-pinned to GXCore v351. */
const BASELINE = 'a07ca80';
let SRC_OLD = null;
try {
  SRC_OLD = execFileSync('git', ['show', BASELINE + ':apps-script/Code.gs'],
                         { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) { SRC_OLD = null; }

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
const skip = (label, why) => console.log('  ○ SKIP ' + label + ' — ' + why);
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  console.log('\n' + (fail + 1) + ' FAILED (of ' + (pass + fail + 1) + ' reached)');
  process.exit(1);
});

const RUNNING = '2026-10-12', ENDED = '2026-09-28', CLOSED = '2026-09-14';
const SEC = 1000, MIN = 60 * SEC;
const PREFIX = 'crew:perf_screen:v1:', BUST = 'crew:perf_screen:busted_at';
const isPerf = (k) => /^crew:perf_screen:/.test(String(k));

/* GX Core's door, as it answers live: the snapshot, with its age. What it says is set per test. */
function doorAnswer(D, pp) {
  const d = corePerf(D.answerFor || pp);
  if (D.bump) d.budtenders[0].sales += D.bump;
  if (D.mode === 'inprocess') return d;                 // carries cache_policy and no age
  delete d.cache_policy;
  Object.assign(d, { snapshot: true, computed_at: '2026-10-13T17:53:00.000Z', age_minutes: D.age, max_age_minutes: D.max, stale: D.stale });
  if (D.mode === 'noflag') delete d.snapshot;
  if (D.pad) d.returns_not_counted = [D.pad];
  return d;
}

/* A world whose door is the snapshot door, and whose cache records every key read and written. */
function mk(src, opts) {
  const W = world(src, opts);
  W.door = { calls: [], age: 7, max: 30, stale: false, bump: 0, mode: 'snapshot', cost: 0, pad: '', answerFor: '' };
  W.sb.GXCore.incentivePerf = (q) => {
    const pp = String((q && q.pp_start) || '');
    W.door.calls.push(pp);
    W.clock.t += W.door.cost;
    if (W.door.mode === 'throw') throw new Error('the door is down');
    if (W.door.mode === 'refuse') return { ok: false, snapshot: 'missing', error: 'no snapshot for that period' };
    return doorAnswer(W.door, pp);
  };
  W.clog = [];
  W.cmode = { get: false, put: false, cost: 0 };
  W.sb.CacheService = { getScriptCache: () => ({
    get: (k) => { if (W.cmode.get) throw new Error('cache read is down'); W.clog.push(['get', k]); return W.cache.has(k) ? W.cache.get(k) : null; },
    getAll: (ks) => {
      if (W.cmode.get) throw new Error('cache read is down');
      ks.forEach((k) => W.clog.push(['get', k]));
      if (ks.some(isPerf)) W.clock.t += W.cmode.cost;
      const o = {}; ks.forEach((k) => { if (W.cache.has(k)) o[k] = W.cache.get(k); }); return o;
    },
    put: (k, v, ttl) => {
      if (W.cmode.put) throw new Error('cache write is down');
      W.clog.push(['put', k]);
      if (String(v).length > 100000) throw new Error('Argument too large: value');
      W.cache.set(k, String(v)); W.ttl.set(k, ttl);
    },
    remove: (k) => { W.cache.delete(k); },
  }) };
  /* GX Core's set_config, for the two comp settings Crew writes. Everything else as the harness has it. */
  W.setConfigOk = true;
  const fetch0 = W.sb.UrlFetchApp.fetch;
  W.sb.UrlFetchApp = { fetch: (url) => {
    if (/action=set_config/.test(url)) {
      W.fetches.push(String(url).replace(/secret=[^&]*/, 'secret=<s>').replace(/value=[^&]*/, 'value=<v>'));
      return { getContentText: () => JSON.stringify(W.setConfigOk ? { ok: true } : { ok: false, error: 'refused' }), getResponseCode: () => 200 };
    }
    return fetch0(url);
  } };
  W.load = (params) => W.get(Object.assign({ action: 'incentive', token: 'T-sky' }, params));
  W.keys = () => [...W.cache.keys()].filter((k) => k.indexOf(PREFIX) === 0).sort();
  /* What one piece of work did: door calls, and every touch of the screen's copy (reads, writes). */
  W.touch = (fn) => { const d0 = W.door.calls.length, c0 = W.clog.length, f0 = W.fetches.length; const r = fn();
    const perf = W.clog.slice(c0).filter(([, k]) => isPerf(k));
    return { r, door: W.door.calls.length - d0, perf, reads: perf.filter(([op, k]) => op === 'get' && k !== BUST).length,
             entryPuts: perf.filter(([op, k]) => op === 'put' && k !== BUST).length, fetches: W.fetches.slice(f0) }; };
  return W;
}

/* A payload with the clock, the age and the hit/miss marker taken out: "the same answer".
   `spiff.from_cache` goes too, and it is the ONLY other field that differs between a first load and
   a later one: it is the SPIFF copy's own marker (false on a world's first load, true after), it
   predates this change, and it is compared untouched wherever the engine as it was is the other side. */
const same = (d) => { const c = JSON.parse(JSON.stringify(d)); delete c.timings; delete c.perf_age_minutes; delete c.perf_cache;
                      if (c.spiff) delete c.spiff.from_cache; return JSON.stringify(c); };
/* …and with only the marker taken out, for comparing against the engine as it was at one instant. */
const sameAged = (d) => { const c = JSON.parse(JSON.stringify(d)); delete c.timings; delete c.perf_cache; return JSON.stringify(c); };
const figures = (d) => JSON.stringify({ ok: d.ok, payPeriod: d.payPeriod, budtenders: d.budtenders, managers: d.managers, admin: d.admin,
                                        adminActual: d.adminActual, adminTarget: d.adminTarget, stores: d.stores, source: d.perf_source });
const bea = (d) => (d.budtenders || []).find((b) => b.employee_id === 'bea_bud') || {};
const N_OF = { '2026-09-28': 4, '2026-10-12': 5 };
const DOOR_SALES = (pp) => 8200 + 10 * N_OF[pp];

/* ── 1. The second load is answered from the copy ───────────────────────────────────────────── */
console.log('\nA second load inside five minutes asks GX Core nothing, and shows the same figures');
{
  const W = mk(SRC_NEW);
  const a = W.load({ pp_start: RUNNING });
  ok('the first load asks the door and says so: snapshot, 7 min old, a miss',
     a.ok === true && a.perf_source === 'snapshot' && a.perf_age_minutes === 7 && a.perf_cache === 'miss' && W.door.calls.join() === RUNNING);
  ok('…and keeps the answer under that pay period, for 300 seconds',
     W.keys().join() === PREFIX + RUNNING && W.ttl.get(PREFIX + RUNNING) === 300 && W.g('PERF_SCREEN_CACHE_S') === 300);
  const env = JSON.parse(W.cache.get(PREFIX + RUNNING));
  ok('what is kept is the door\'s answer and the moment it arrived — nothing Crew derived from it',
     Object.keys(env).sort().join() === 'at,d' && env.at === NOW && JSON.stringify(env.d) === JSON.stringify(doorAnswer(W.door, RUNNING)) &&
     !/nameKey|storeSlug|crew_perf_cache|thresholds|inputs|middle_initial/.test(W.cache.get(PREFIX + RUNNING)));
  W.door.bump = 5000;                                    // the door would now say something else — if it were asked
  const t = W.touch(() => W.load({ pp_start: RUNNING }));
  const b = t.r;
  ok('the second load makes ZERO door calls, and no HTTP read of GX Core either', t.door === 0 && !t.fetches.some((u) => /incentive_perf/.test(u)));
  ok('…and says it was the copy: still `snapshot`, marked a hit', b.perf_source === 'snapshot' && b.perf_cache === 'hit');
  ok('the payload is identical to the first, the timings, the age and the marker aside', same(a) === same(b) && same(a).length > 500);
  ok('…the figures are the door\'s own (' + DOOR_SALES(RUNNING) + '), not something recomputed', bea(b).sales === DOOR_SALES(RUNNING) && bea(a).sales === bea(b).sales);
  ok('at the same instant the age is the same age', b.perf_age_minutes === 7);
  ok('the client\'s label reads what it always read: perf_source "snapshot" and perf_age_minutes',
     /d\.perf_source === 'snapshot' && d\.perf_age_minutes != null/.test(fs.readFileSync(path.join(ROOT, 'crew.js'), 'utf8')));
}

console.log('\nBefore this change and after it (the engine at ' + BASELINE + ' against the shipped one)');
if (!SRC_OLD) skip('every screen and every viewer: the miss and the hit both equal what the engine answered before', 'git cannot show ' + BASELINE + ' here (a shallow clone)');
else {
  const O = mk(SRC_OLD), N = mk(SRC_NEW);
  const bad = []; let n = 0, hits = 0;
  [['the running period', { pp_start: RUNNING }], ['the ended period', { pp_start: ENDED }], ['the default screen', {}],
   ['the practice period', { pp_start: PRACTICE }], ['a closed period', { pp_start: CLOSED }]].forEach(([what, params]) => {
    [['the approver', 'T-sky'], ['the preparer', 'T-mike'], ['the backup', 'T-shawn'], ['a viewer', 'T-view']].forEach(([who, token]) => {
      const p = Object.assign({ token }, params);
      /* Twice each, on both sides, and compared load for load — nothing but the marker taken out. */
      const o1 = O.load(p), n1 = N.load(p), o2 = O.load(p), n2 = N.load(p);
      n += 2;
      if (sameAged(o1) !== sameAged(n1) || sameAged(o2) !== sameAged(n2) || sameAged(o1).length < 200) bad.push(what + ' / ' + who);
      if (n1.perf_cache === 'hit') hits++;
      if (n2.perf_cache === 'hit') hits++;
    });
  });
  ok(n + ' screen loads: the engine as it was and the new one agree on every byte but the marker — whether the new one asked the door or answered from its copy' +
     (bad.length ? ' — DIFFERENT: ' + bad.slice(0, 3).join('; ') : ''), bad.length === 0);
  ok('…and nearly all of the new engine\'s were from the copy (' + hits + ' of the 32 live loads; a closed period has no live read to keep)', hits === 30);
  ok('the old engine asked the door on all 32 live loads; the new one twice (one per fortnight — the default and practice screens ask for the ended one)',
     O.door.calls.length === 32 && N.door.calls.join() === RUNNING + ',' + ENDED);
  const o = world(SRC_OLD), w = world(SRC_NEW);
  const od = o.get({ action: 'incentive', token: 'T-sky', pp_start: RUNNING }), wd = w.get({ action: 'incentive', token: 'T-sky', pp_start: RUNNING });
  delete od.timings; delete wd.timings;
  ok('an answer computed in-process (the harness\'s own door) is untouched: same payload, no marker, nothing kept',
     JSON.stringify(od) === JSON.stringify(wd) && wd.perf_source === 'in-process' && !('perf_cache' in wd) && ![...w.cache.keys()].some(isPerf));
}

/* ── 2. The age is never reset ──────────────────────────────────────────────────────────────── */
console.log('\nThe age shown is the door\'s age plus the time the copy has sat here');
{
  const W = mk(SRC_NEW);
  W.load({ pp_start: RUNNING });
  const at = (ms) => { W.clock.t = NOW + ms; return W.load({ pp_start: RUNNING }); };
  const ages = [30 * SEC, 60 * SEC, 61 * SEC, 2 * MIN, 4 * MIN + 59 * SEC].map((ms) => at(ms).perf_age_minutes);
  ok('7 min at the door → after 30s, 60s, 61s, 2 min, 4:59: ' + ages.join(', ') + ' (part of a minute counts as a minute)', ages.join() === '8,8,9,9,12');
  ok('…all from the copy: one door call in all', W.door.calls.length === 1 && at(4 * MIN + 59 * SEC).perf_cache === 'hit');
  ok('the worst case on screen is the door\'s 7 plus these 5: 12 min, inside the limit of ' + W.g('SNAPSHOT_OPEN_MAX_MIN'), at(5 * MIN).perf_age_minutes === 12 && W.g('SNAPSHOT_OPEN_MAX_MIN') === 20);
}

/* ── 3. The freshness rule is run again on a copy ───────────────────────────────────────────── */
console.log('\nA copy that has aged past the limit is not used, and the door is asked');
{
  const W = mk(SRC_NEW);
  W.door.age = 17;
  W.load({ pp_start: RUNNING });
  const at = (ms) => { W.clock.t = NOW + ms; return W.touch(() => W.load({ pp_start: RUNNING })); };
  const a = at(2 * MIN), b = at(3 * MIN);
  ok('running period, 17 min at the door: used at 19 and at 20 (the limit is inclusive, as it is at the door)',
     a.door === 0 && a.r.perf_age_minutes === 19 && b.door === 0 && b.r.perf_age_minutes === 20);
  const c = at(3 * MIN + SEC);
  ok('…and at 21 it is refused: the door is asked, and the screen shows the door\'s own age again',
     c.door === 1 && c.r.perf_cache === 'miss' && c.r.perf_age_minutes === 17 && c.r.ok === true);

  const E = mk(SRC_NEW);
  E.door.age = 7; E.door.max = 9;
  const first = E.load({ pp_start: ENDED });
  ok('an ended period GX Core calls fresh is kept too', first.perf_cache === 'miss' && first.payPeriod.current === false && E.keys().join() === PREFIX + ENDED);
  const eat = (ms) => { E.clock.t = NOW + ms; return E.touch(() => E.load({ pp_start: ENDED })); };
  const e1 = eat(MIN), e2 = eat(2 * MIN), e3 = eat(2 * MIN + SEC);
  ok('…and held to GX Core\'s own max_age_minutes (9): used at 8 and 9, refused at 10',
     e1.door === 0 && e1.r.perf_age_minutes === 8 && e2.door === 0 && e2.r.perf_age_minutes === 9 && e3.door === 1 && e3.r.perf_cache === 'miss');
  const L = mk(SRC_NEW);
  L.door.age = 25; L.door.max = 60;
  L.load({ pp_start: ENDED });
  L.clock.t = NOW + 4 * MIN;
  ok('an ended period is NOT held to the running period\'s 20 — it has its own limit (29 of 60 is used)',
     L.touch(() => L.load({ pp_start: ENDED })).door === 0 && L.load({ pp_start: ENDED }).perf_age_minutes === 29);
}

/* ── 4. Five minutes, and Crew counts them itself ───────────────────────────────────────────── */
console.log('\nAfter five minutes the door is asked, whatever the cache still holds');
{
  const W = mk(SRC_NEW);
  W.door.age = 1;
  W.load({ pp_start: RUNNING });
  W.clock.t = NOW + 5 * MIN;
  const a = W.touch(() => W.load({ pp_start: RUNNING }));
  ok('at exactly five minutes it is still the copy (1 + 5 = 6 min)', a.door === 0 && a.r.perf_age_minutes === 6);
  W.clock.t = NOW + 5 * MIN + SEC;
  const held = W.cache.has(PREFIX + RUNNING);
  const b = W.touch(() => W.load({ pp_start: RUNNING }));
  ok('one second later the door is asked — though this fake cache never expires anything and still held the entry', held && b.door === 1 && b.r.perf_cache === 'miss' && b.r.perf_age_minutes === 1);
  ok('…and the fresh answer replaces it', JSON.parse(W.cache.get(PREFIX + RUNNING)).at === NOW + 5 * MIN + SEC && W.touch(() => W.load({ pp_start: RUNNING })).door === 0);
}

/* ── 5. What is never kept ──────────────────────────────────────────────────────────────────── */
console.log('\nA refusal, an error or a stale answer is never kept');
{
  const big = 'x'.repeat(95500);
  const CASES = [
    ['the door refuses (no snapshot)', RUNNING, (D) => { D.mode = 'refuse'; }, 'live', undefined],
    ['the door throws', RUNNING, (D) => { D.mode = 'throw'; }, 'live', undefined],
    ['a running period 25 min old', RUNNING, (D) => { D.age = 25; }, 'live', undefined],
    ['an ended period GX Core calls stale', ENDED, (D) => { D.stale = true; }, 'live', undefined],
    ['an answer that states no age', RUNNING, (D) => { D.age = null; }, 'live', undefined],
    ['an answer computed in-process (no age to re-judge)', RUNNING, (D) => { D.mode = 'inprocess'; }, 'in-process', undefined],
    ['an answer not marked as the snapshot', RUNNING, (D) => { D.mode = 'noflag'; }, 'snapshot', 'skip'],
    ['an answer for a different period than was asked for', RUNNING, (D) => { D.answerFor = ENDED; }, 'snapshot', 'skip'],
    ['an ended period with no max_age_minutes (its age could not be re-judged)', ENDED, (D) => { D.max = undefined; }, 'snapshot', 'skip'],
    ['an answer too large for one cache entry', RUNNING, (D) => { D.pad = big; }, 'snapshot', 'skip'],
  ];
  CASES.forEach(([label, pp, setup, source, marker]) => {
    const W = mk(SRC_NEW);
    setup(W.door);
    const a = W.touch(() => W.load({ pp_start: pp }));
    const b = W.touch(() => W.load({ pp_start: pp }));
    const live = source === 'live';
    ok(label + ' → answered (' + source + '), nothing kept, and the next load asks again',
       a.r.ok === true && a.r.perf_source === source && a.r.perf_cache === marker && W.keys().length === 0 && a.entryPuts === 0 &&
       a.door === 1 && b.door === 1 && b.r.perf_source === source &&
       (!live || (a.fetches.some((u) => /incentive_perf/.test(u)) && b.fetches.some((u) => /incentive_perf/.test(u)))));
  });
  const S = mk(SRC_NEW); S.door.pad = big;
  const len = JSON.stringify({ at: NOW, d: doorAnswer(S.door, RUNNING) }).length;
  ok('that large answer would have FIT the cache\'s own 100KB (' + len + ' characters) — it is Crew\'s ceiling of ' + S.g('PERF_SCREEN_MAX_BODY') + ' that declines it',
     len < 100000 && len >= S.g('PERF_SCREEN_MAX_BODY') && S.load({ pp_start: RUNNING }).returns_not_counted[0].length === 95500);

  const A = mk(SRC_NEW);
  delete A.kv['cfg.payPeriodAnchor'];
  const none = A.touch(() => A.load({}));
  ok('a load that names no period ("the current one") is not kept: the door is asked each time',
     none.r.ok === true && none.r.perf_cache === 'skip' && A.door.calls.join() === '' && A.keys().length === 0 && A.touch(() => A.load({})).door === 1);
  const key = A.g('perfScreenKey_');
  ok('only a plain calendar day makes a key', key('') === '' && key('practice-2026-09-28') === '' && key('2026-9-28') === '' && key(undefined) === '' && key(ENDED) === PREFIX + ENDED);

  /* A good answer is kept; what comes after it does not disturb the rule. */
  const G = mk(SRC_NEW);
  G.load({ pp_start: RUNNING });
  G.door.mode = 'refuse';
  G.clock.t = NOW + 6 * MIN;
  const late = G.touch(() => G.load({ pp_start: RUNNING }));
  ok('a kept answer is not stretched to cover a door that has since stopped answering: past five minutes it is the live read',
     late.door === 1 && late.r.perf_source === 'live' && late.r.perf_cache === undefined && late.fetches.some((u) => /incentive_perf/.test(u)));
}

console.log('\nAn entry that is not what it should be is ignored');
{
  const good = (W, pp) => JSON.stringify({ at: W.clock.t, d: doorAnswer(Object.assign({}, W.door, { bump: 7777 }), pp) });
  const PLANTS = [
    ['an answer for ANOTHER period, under this period\'s key', (W) => good(W, ENDED)],
    ['text that is not JSON', () => 'not json{'],
    ['a kept refusal', (W) => JSON.stringify({ at: W.clock.t, d: { ok: false, snapshot: 'missing' } })],
    ['an entry stamped in the future', (W) => JSON.stringify({ at: W.clock.t + MIN, d: doorAnswer(W.door, RUNNING) })],
    ['an entry with no time on it', (W) => JSON.stringify({ d: doorAnswer(W.door, RUNNING) })],
    ['an entry older than five minutes', (W) => JSON.stringify({ at: W.clock.t - 5 * MIN - SEC, d: doorAnswer(W.door, RUNNING) })],
    ['an answer with no age', (W) => JSON.stringify({ at: W.clock.t, d: doorAnswer(Object.assign({}, W.door, { age: null }), RUNNING) })],
    ['an answer not marked as the snapshot', (W) => JSON.stringify({ at: W.clock.t, d: doorAnswer(Object.assign({}, W.door, { mode: 'noflag' }), RUNNING) })],
    ['a running answer already past the limit', (W) => JSON.stringify({ at: W.clock.t, d: doorAnswer(Object.assign({}, W.door, { age: 21 }), RUNNING) })],
  ];
  PLANTS.forEach(([label, plant]) => {
    const W = mk(SRC_NEW);
    W.cache.set(PREFIX + RUNNING, plant(W));
    const t = W.touch(() => W.load({ pp_start: RUNNING }));
    ok(label + ' → the door is asked, and its figures are the ones shown', t.door === 1 && t.r.ok === true && bea(t.r).sales === DOOR_SALES(RUNNING) && t.r.payPeriod.start === RUNNING);
  });
  const W = mk(SRC_NEW);
  W.cache.set(PREFIX + RUNNING, JSON.stringify({ at: W.clock.t, d: doorAnswer(Object.assign({}, W.door, { bump: 7777 }), RUNNING) }));
  ok('(a well-formed entry planted the same way IS used — so the cases above were refused for what was wrong with them)',
     W.touch(() => W.load({ pp_start: RUNNING })).door === 0 && bea(W.load({ pp_start: RUNNING })).sales === DOOR_SALES(RUNNING) + 7777);
}

/* ── 6. One entry per pay period ────────────────────────────────────────────────────────────── */
console.log('\nEach pay period has its own entry; a practice period shares the fortnight it mirrors');
{
  const W = mk(SRC_NEW);
  const r1 = W.load({ pp_start: RUNNING }), e1 = W.load({ pp_start: ENDED });
  ok('two periods, two door calls, two entries', W.door.calls.join() === RUNNING + ',' + ENDED && W.keys().join() === [PREFIX + ENDED, PREFIX + RUNNING].join());
  W.door.bump = 5000;
  const t = W.touch(() => [W.load({ pp_start: RUNNING }), W.load({ pp_start: ENDED }), W.load({ pp_start: RUNNING })]);
  ok('each is answered from its own, with its own figures (' + DOOR_SALES(RUNNING) + ' and ' + DOOR_SALES(ENDED) + ')',
     t.door === 0 && same(t.r[0]) === same(r1) && same(t.r[1]) === same(e1) && same(t.r[2]) === same(r1) &&
     bea(t.r[0]).sales === DOOR_SALES(RUNNING) && bea(t.r[1]).sales === DOOR_SALES(ENDED) && t.r[0].payPeriod.start === RUNNING && t.r[1].payPeriod.start === ENDED);

  const p = W.touch(() => W.load({ pp_start: PRACTICE }));
  ok('the practice period asks for ' + ENDED + ' — the same question — and is answered from that entry',
     p.door === 0 && p.r.perf_cache === 'hit' && p.r.payPeriod.start === PRACTICE && !!p.r.practice && bea(p.r).sales === DOOR_SALES(ENDED));
  const C = mk(SRC_NEW);
  const cold = C.load({ pp_start: PRACTICE });
  ok('…with exactly the payload a cold practice load gets from the door', C.door.calls.join() === ENDED && cold.perf_cache === 'miss' && same(cold) === same(p.r) && C.keys().join() === PREFIX + ENDED);
  ok('the practice period\'s own inputs and workflow are still its own (storage is untouched by the shared read)',
     JSON.stringify(p.r.inputs) !== JSON.stringify(e1.inputs) || p.r.payPeriod.start !== e1.payPeriod.start);

  const M = mk(SRC_NEW), M0 = mk(SRC_NEW);
  M.load({ pp_start: RUNNING });                         // the approver's load fills it
  const mike = M.touch(() => M.load({ pp_start: RUNNING, token: 'T-mike' })), view = M.touch(() => M.load({ pp_start: RUNNING, token: 'T-view' }));
  ok('the answer does not depend on who is looking: the preparer and a viewer are answered from the approver\'s entry, each with their own screen',
     mike.door === 0 && view.door === 0 && same(mike.r) === same(M0.load({ pp_start: RUNNING, token: 'T-mike' })) &&
     same(view.r) === same(M0.load({ pp_start: RUNNING, token: 'T-view' })) && mike.r.can_approve === false && view.r.can_edit === false);
  ok('…and somebody with no session gets nothing, copy or not', M.load({ pp_start: RUNNING, token: '' }).ok === false);
}

/* ── 7. A cache that is down ────────────────────────────────────────────────────────────────── */
console.log('\nA cache that throws changes nothing but speed');
{
  const R = mk(SRC_NEW);
  const ref = figures(R.load({ pp_start: RUNNING }));
  [['on every read', { get: true, put: false }, 'miss'], ['on every write', { get: false, put: true }, 'skip'], ['on both', { get: true, put: true }, 'skip']].forEach(([label, mode, marker]) => {
    const W = mk(SRC_NEW);
    Object.assign(W.cmode, mode);
    const a = W.touch(() => W.load({ pp_start: RUNNING })), b = W.touch(() => W.load({ pp_start: RUNNING }));
    ok('throwing ' + label + ': both loads answer, from the door, with the same figures',
       a.r.ok === true && b.r.ok === true && a.door === 1 && b.door === 1 && figures(a.r) === ref && figures(b.r) === ref && a.r.perf_cache === marker && a.r.perf_age_minutes === 7);
  });
  const W = mk(SRC_NEW);
  W.load({ pp_start: RUNNING });
  W.cmode.get = true;
  const t = W.touch(() => W.load({ pp_start: RUNNING }));
  ok('a cache that goes down AFTER an answer was kept: the door is asked', t.door === 1 && t.r.ok === true && figures(t.r) === ref);
  W.cmode.get = false; W.cmode.put = true;
  let threw = false;
  try { W.g('bustPerfScreenCache_')(); W.g('bustRosterCache_')(); } catch (e) { threw = true; }
  ok('a bust against a cache that will not write does not throw', !threw);
}

/* ── 8. The paths that write ────────────────────────────────────────────────────────────────── */
console.log('\nApprove, send, the dry run and the preview never see the copy');
const ACK = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' };
const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
/* A whole close with the screen's copy warm before every write — and holding DIFFERENT figures from
   the ones GX Core's live route returns, so a write that read it would freeze the wrong sales. */
function writeScenario(W) {
  W.door.bump = 5000;
  const rec = [], out = [];
  const warm = () => { W.load({ pp_start: ENDED }); W.load({ pp_start: RUNNING }); W.load({ pp_start: PRACTICE }); W.load({}); };
  const call = (label, p) => {
    warm();
    const e0 = W.events.length;
    let reads = null;
    const t = W.touch(() => { let d = null; reads = W.count(() => { d = W.get(p); }); return d; });
    delete t.r.timings;
    out.push(t.r);
    rec.push({ label, door: t.door, perf: t.perf, perfReads: t.reads, fetches: t.fetches, events: W.events.slice(e0), reads });
    return t.r;
  };
  const dry = call('the dry run (the preparer)', Object.assign({ action: 'incentive_approve', token: 'T-mike', pp_start: ENDED }, ACK));
  const preview = call('the send preview', Object.assign({ action: 'incentive_send', preview: '1', secret: SECRET, to: 'mike@greencrosscanna.com', pp_start: ENDED }, ACK));
  call('the send preview, on the running period', Object.assign({ action: 'incentive_send', preview: '1', secret: SECRET, to: 'mike@greencrosscanna.com', pp_start: RUNNING }, ACK));
  call('a dry run of the practice period', Object.assign({ action: 'incentive_approve', token: 'T-mike', pp_start: PRACTICE }, ACK));
  const sent = call('send for approval', Object.assign({ action: 'incentive_send', token: 'T-mike', pp_start: ENDED, request_id: rid('S') }, ACK));
  call('the dry run (the approver)', Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: ENDED }, ACK));
  const done = call('approve', Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: ENDED, confirm: 'yes', request_id: rid('A') }, ACK));
  const frozen = W.load({ pp_start: ENDED });
  const again = call('a retry of that approval', Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: ENDED, confirm: 'yes', request_id: rid('A') }, ACK));
  const reopened = call('reopen', { action: 'incentive_unapprove', token: 'T-sky', pp_start: ENDED, confirm: 'yes', request_id: rid('U'),
                                    reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' });
  const screen = W.load({ pp_start: RUNNING });
  return { rec, out, dry, preview, sent, done, frozen, again, reopened, screen, text: JSON.stringify(out), book: W.book(), mails: JSON.stringify(W.mails),
           fetches: JSON.stringify(rec.map((r) => r.fetches)), events: JSON.stringify(rec.map((r) => r.events)), reads: JSON.stringify(rec.map((r) => r.reads)) };
}
const WRITE_FNS = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_',
                   'perfForWrite_', 'fetchLivePerf_', 'fetchLivePerfFromCore_', 'withPayLock_', 'filePayoutPdf_', 'backupCrewSheet_', 'notifyApproved_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'freezeScheme_', 'freezeGoals_', 'wfSet_', 'wfGet_', 'historySheet_',
                   'applySpiffEarnings_', 'spiffProgressFor_', 'stampEmployeeIds_', 'foldFloaters_', 'approvalThresholds_',
                   'incentiveBlockers_', 'storeTotals_', 'historyBand_', 'historyPeriods_', 'inputsFor_', 'readTab_', 'sheetOf_',
                   'canDecide_', 'canApprove_', 'approverIds_', 'backupApproverIds_', 'backupWindow_', 'approverAway_', 'computedPeriods_',
                   'escalateApprovals_', 'wfApproverEmails_', 'wfBackupEmails_', 'incentiveHistory_', 'crewSheet_', 'incCalcBud_', 'incCalcMgr_', 'incCalcAdmin_', 'incPayroll_'];
function fnText(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) return null;
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? src.length : j).replace(/\n\/\*[\s\S]*$/, (m) => (/\*\/\s*$/.test(m) ? '' : m));
}
{
  const N = mk(SRC_NEW);
  const n = writeScenario(N);
  ok('the scenario really closed a period: dry run, preview, sent, approved (6 rows), retried, reopened',
     n.dry.ok === true && n.preview.ok === true && n.sent.status === 'pending' && n.done.ok === true && n.done.written === 6 &&
     n.again.already_applied === true && n.reopened.ok === true && n.frozen.source === 'imported');
  ok('the copy was warm throughout, and held figures the live route does not (' + (DOOR_SALES(RUNNING) + 5000) + ' against ' + DOOR_SALES(RUNNING) + ')',
     n.screen.perf_cache === 'hit' && bea(n.screen).sales === DOOR_SALES(RUNNING) + 5000 && N.keys().length === 2);
  const touched = n.rec.filter((r) => r.door !== 0 || r.perfReads !== 0 || r.perf.some(([op, k]) => op === 'put' && k !== BUST));
  ok('none of the ' + n.rec.length + ' write requests asked the door, read the copy or kept one' + (touched.length ? ' — BUT: ' + touched.map((r) => r.label).join('; ') : ''),
     touched.length === 0 && n.rec.length === 9);
  const fresh = ['the dry run (the preparer)', 'the send preview', 'the send preview, on the running period', 'a dry run of the practice period',
                 'send for approval', 'the dry run (the approver)', 'approve'];
  ok('each of the ' + fresh.length + ' that compute made its own fresh read of GX Core over HTTP, as before',
     fresh.every((l) => n.rec.find((r) => r.label === l).fetches.filter((u) => /action=incentive_perf/.test(u)).length === 1));
  ok('what was frozen is what the LIVE route said (' + DOOR_SALES(ENDED) + '), not what the screen\'s copy held',
     bea(n.frozen).sales === DOOR_SALES(ENDED) && !/13240|5000/.test(JSON.stringify(N.sheets.crew_incentive_history.data.filter((r) => r[0] === ENDED).map((r) => r[8]))));

  if (!SRC_OLD) skip('the same close on the engine as it was: replies, sheets, mail, fetches, locks', 'git cannot show ' + BASELINE + ' here');
  else {
    const O = mk(SRC_OLD);
    const o = writeScenario(O);
    ok('every reply byte-identical to the engine at ' + BASELINE, o.text === n.text && n.text.length > 2000);
    ok('every sheet byte-identical', o.book === n.book);
    ok('every email byte-identical (' + JSON.parse(n.mails).length + ' sent)', o.mails === n.mails && JSON.parse(n.mails).length >= 4);
    ok('the same fetches by each request, in the same order', o.fetches === n.fetches && /incentive_perf/.test(n.fetches) && /action=progress/.test(n.fetches));
    ok('the same locks, writes and flushes by each request, in the same order', o.events === n.events && (n.events.match(/"lock"/g) || []).length >= 3 && /write:crew_incentive_history/.test(n.events));
    ok('each request read every sheet, the registry and every setting exactly as often', o.reads === n.reads && n.reads.length > 400);
    const moved = WRITE_FNS.filter((f) => fnText(SRC_OLD, f) !== fnText(SRC_NEW, f));
    ok('the source of all ' + WRITE_FNS.length + ' functions the write paths run is unchanged' + (moved.length ? ' — CHANGED: ' + moved.join(', ') : ''),
       moved.length === 0 && WRITE_FNS.every((f) => fnText(SRC_NEW, f)));
  }
}

/* ── 9. Two locks, and a write path holds neither key ───────────────────────────────────────── */
console.log('\nThe copy is behind two locks, and only the router\'s screen call opens both');
{
  const W = mk(SRC_NEW);
  W.load({ pp_start: RUNNING });
  W.door.bump = 5000;
  const armed = () => vm.runInContext('_perfScreenArmed_', W.sb);
  ok('after a screen load nothing is left armed', armed() === false);
  /* Lock 2 alone: a caller that DOES pass { snapshot: true } but is not the router's screen. */
  const t = W.touch(() => W.g('perfForWrite_')(RUNNING, null, { snapshot: true }));
  ok('anything else that asks for the snapshot gets the DOOR — not the copy — and keeps nothing',
     t.door === 1 && t.reads === 0 && t.entryPuts === 0 && t.r.perf_source === 'snapshot' && !('perf_cache' in t.r) && t.r.budtenders[0].sales === DOOR_SALES(RUNNING) + 5000);
  const bare = W.touch(() => W.g('perfForWrite_')(RUNNING));
  ok('called bare, as approve and send call it: no door, no copy, the live route', bare.door === 0 && bare.reads === 0 && bare.r.perf_source === 'live' && bare.fetches.length === 1);
  vm.runInContext('_perfScreenArmed_ = "yes";', W.sb);
  const loose = W.touch(() => W.g('perfForWrite_')(RUNNING, null, { snapshot: true }));
  ok('only the exact value arms it — a truthy stand-in does not — and one look disarms it', loose.door === 1 && loose.reads === 0 && armed() === false);
  vm.runInContext('_perfScreenArmed_ = true;', W.sb);
  W.get({ action: 'incentive_approve', token: 'T-mike', pp_start: RUNNING });
  ok('a request clears whatever an earlier one left behind, before it runs anything', armed() === false);
  vm.runInContext('var __fl = fetchLivePerf_; fetchLivePerf_ = function () { throw new Error("blew up mid-fetch"); };', W.sb);
  const boom = W.load({ pp_start: RUNNING });
  ok('a fetch that throws still leaves nothing armed', boom.ok === false && armed() === false);
  vm.runInContext('fetchLivePerf_ = __fl;', W.sb);
  const req = W.touch(() => W.get({ action: 'incentive_approve', token: 'T-mike', pp_start: ENDED, snapshot: 'true', preAuth: 'x', _perfScreenArmed_: 'true', opts: '{"snapshot":true}' }));
  ok('a request cannot supply either key', req.door === 0 && req.reads === 0 && req.r.ok === true);

  /* The same thing, read off the source — so an edit that opens a path is caught before it runs. */
  const fns = {};
  SRC_NEW.split(/\n(?=function [A-Za-z0-9_$]+\()/).forEach((chunk) => { const m = /^function ([A-Za-z0-9_$]+)\(/.exec(chunk); if (m) fns[m[1]] = chunk; });
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  const names = Object.keys(fns);
  const calls = {};
  names.forEach((n) => { const body = code(fns[n]).replace(/^function [A-Za-z0-9_$]+\(/, ''); calls[n] = names.filter((m) => new RegExp('(^|[^A-Za-z0-9_$.])' + m.replace(/\$/g, '\\$') + '\\b').test(body)); });
  const reach = (roots, cut) => { const seen = {}; const q = roots.slice(); while (q.length) { const f = q.pop(); if (seen[f] || f === cut) continue; seen[f] = 1; (calls[f] || []).forEach((c) => q.push(c)); } return Object.keys(seen); };
  const ROOTS = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'saveIncentiveInput_', 'saveAttendanceBatch_', 'incentiveGoalsBackfill_', 'pdfFile_'];
  ok('the write routes are all there to be followed (' + ROOTS.length + '), and the map of who calls whom is real (' + names.length + ' functions)',
     ROOTS.every((r) => fns[r]) && names.length > 300 && calls.incentiveApprove_.indexOf('perfForWrite_') >= 0 && calls.incentiveSend_.indexOf('incentiveApprove_') >= 0);
  const whole = reach(ROOTS, null);
  ok('by name alone a write path CAN reach perfFromSnapshot_ (through the shared fetch) — which is why the next three checks exist',
     whole.indexOf('perfFromSnapshot_') >= 0 && whole.indexOf('fetchLivePerfFromCore_') >= 0);
  const users = (name) => names.filter((n) => n !== name && calls[n].indexOf(name) >= 0);
  ok('lock 1: perfFromSnapshot_ has one caller, and that call is behind the caller\'s own { snapshot } argument',
     users('perfFromSnapshot_').join() === 'fetchLivePerfFromCore_' && (code(SRC_NEW).match(/perfFromSnapshot_\(/g) || []).length === 2 &&
     /var snap = \(opts && opts\.snapshot\) \? perfFromSnapshot_\(ppStart\) : null;/.test(fns.fetchLivePerfFromCore_));
  const rest = reach(ROOTS, 'perfFromSnapshot_');
  const passes = rest.filter((f) => /snapshot\s*:/.test(code(fns[f])));
  ok('…and nothing a write path runs passes that argument' + (passes.length ? ' — BUT: ' + passes.join(', ') : ''),
     passes.length === 0 && /perfForWrite_\(pp\);/.test(fns.incentiveApprove_) && /perfForWrite_\(pp\);/.test(fns.incentiveSend_) && rest.length > 60);
  ok('the copy is read and kept by perfFromSnapshot_ and nothing else',
     users('perfScreenCacheGet_').join() === 'perfFromSnapshot_' && users('perfScreenCachePut_').join() === 'perfFromSnapshot_' && users('perfScreenArmedTake_').join() === 'perfFromSnapshot_' &&
     (code(SRC_NEW).match(/PERF_SCREEN_CACHE_PREFIX/g) || []).length === 2 && (code(fns.perfScreenKey_).match(/PERF_SCREEN_CACHE_PREFIX/g) || []).length === 1 &&
     users('perfScreenKey_').join() === 'perfFromSnapshot_' && !/crew:perf_screen:v1/.test(code(SRC_NEW).replace(/var PERF_SCREEN_CACHE_PREFIX = [^;]+;/, '')));
  const armers = names.filter((n) => /_perfScreenArmed_\s*=[^=]/.test(code(fns[n])));
  const sets = (code(SRC_NEW).match(/_perfScreenArmed_ = [^;]+;/g) || []).map((s) => s.replace(/^_perfScreenArmed_ = |;$/g, '')).sort();
  ok('lock 2: the arm is set in three functions, and only getIncentive_ can set it to anything but false: ' + sets.join(' | '),
     armers.sort().join() === 'getIncentive_,perfScreenArmedTake_,route_' && sets.join('|') === '(preAuth === undefined)|false|false|false|false');
  ok('…for the router\'s call only, cleared however the fetch ends, cleared at the top of every request, and cleared by the one look at it',
     /_perfScreenArmed_ = \(preAuth === undefined\);\s*try \{\s*var live = perfForWrite_\(want, timings, \{ snapshot: true \}\);\s*\} finally \{ _perfScreenArmed_ = false; \}/.test(fns.getIncentive_) &&
     /function route_\(e\) \{\s*_crewSheetMemo_ = null;[^\n]*\n\s*_perfScreenArmed_ = false;/.test(SRC_NEW) &&
     /var armed = \(_perfScreenArmed_ === true\);\s*_perfScreenArmed_ = false;\s*return armed;/.test(fns.perfScreenArmedTake_) &&
     /var armed = perfScreenArmedTake_\(\);\s*var key = armed \? perfScreenKey_\(ppStart\) : '';/.test(fns.perfFromSnapshot_));
  const holders = rest.filter((f) => ['getIncentive_', 'perfScreenCacheGet_', 'perfScreenCachePut_', 'perfScreenArmedTake_', 'perfScreenKey_', 'route_'].indexOf(f) >= 0 || /_perfScreenArmed_/.test(code(fns[f])));
  ok('no write route, and nothing any of them runs, can arm it or reach the copy any other way' + (holders.length ? ' — BUT: ' + holders.join(', ') : ''), holders.length === 0);
  ok('getIncentive_ is called by the router and by the store email, and by nothing else', users('getIncentive_').sort().join() === 'route_,storeEmailBuild_');
  ok('the bust only ever writes a timestamp; it reads nothing', !/\.get\(|getAll/.test(code(fns.bustPerfScreenCache_)) && /put\(PERF_SCREEN_BUST_KEY, String\(Date\.now\(\)\), PERF_SCREEN_BUST_S\)/.test(fns.bustPerfScreenCache_));
}

/* ── 10. The store email ────────────────────────────────────────────────────────────────────── */
console.log('\nThe store email does NOT share the screen\'s copy — it asks GX Core every time');
{
  const W = mk(SRC_NEW);
  W.load({ pp_start: RUNNING }); W.load({ pp_start: ENDED });
  W.door.bump = 5000;
  const mail = (X, pp) => X.get(Object.assign({ action: 'store_email', secret: SECRET, show: 'html' }, pp ? { pp_start: pp } : {}));
  const t = W.touch(() => mail(W, RUNNING));
  ok('with the copy warm, the email still asks the door, and neither reads the copy nor keeps one', t.r.ok === true && t.door === 1 && t.reads === 0 && t.entryPuts === 0);
  const C = mk(SRC_NEW); C.door.bump = 5000;
  ok('…so it carries what the door says NOW, not what the screen was shown a moment ago',
     JSON.stringify(t.r) === JSON.stringify(mail(C, RUNNING)) && bea(W.load({ pp_start: RUNNING })).sales === DOOR_SALES(RUNNING) && /13,?250/.test(JSON.stringify(t.r)));
  ok('…and the screen is still answered from its copy afterwards', W.touch(() => W.load({ pp_start: RUNNING })).door === 0);
  if (!SRC_OLD) skip('the store email, before against after', 'git cannot show ' + BASELINE + ' here');
  else {
    const O = mk(SRC_OLD), N = mk(SRC_NEW);
    [O, N].forEach((X) => { X.load({ pp_start: RUNNING }); X.load({ pp_start: ENDED }); X.load({ pp_start: CLOSED }); });
    const all = (X) => JSON.stringify([mail(X, RUNNING), mail(X, ENDED), mail(X, CLOSED), mail(X, '')]);
    const a = all(O), b = all(N);
    ok('four store emails (running, ended, closed, and the one the schedule would pick) byte-identical to the engine at ' + BASELINE, a === b && b.length > 2000 && /Bend/.test(b));
    ok('…and it asked the door exactly as it did before: once per live email, three in all, on top of the two screens that warmed the copy',
       O.door.calls.join() === N.door.calls.join() && N.door.calls.join() === [RUNNING, ENDED, RUNNING, ENDED, RUNNING].join());
  }
}

/* ── 11. A Crew write that could move these figures ─────────────────────────────────────────── */
console.log('\nA Crew write that could change what GX Core computes voids the copy');
{
  const W = mk(SRC_NEW);
  W.load({ pp_start: RUNNING }); W.load({ pp_start: ENDED });
  ok('(warm: both periods answered from the copy)', W.touch(() => [W.load({ pp_start: RUNNING }), W.load({ pp_start: ENDED })]).door === 0);
  W.setConfigOk = false;
  const refused = W.get({ action: 'incentive_thresholds', token: 'T-sky', save: JSON.stringify(T) });
  ok('a comp-setting save GX Core REFUSED changes nothing: still the copy', refused.ok === false && W.touch(() => W.load({ pp_start: RUNNING })).door === 0);
  W.setConfigOk = true;
  const saved = W.get({ action: 'incentive_thresholds', token: 'T-sky', save: JSON.stringify(T) });
  W.clock.t += SEC;
  const after = W.touch(() => [W.load({ pp_start: RUNNING }), W.load({ pp_start: ENDED })]);
  ok('a comp-setting save that went through: the next load of EVERY period asks the door', saved.ok === true && after.door === 2 && after.r[0].perf_cache === 'miss' && after.r[1].perf_cache === 'miss');
  ok('…and the one after that is the copy again', W.touch(() => [W.load({ pp_start: RUNNING }), W.load({ pp_start: ENDED })]).door === 0);

  W.clock.t += SEC;
  const roster = W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'bea_bud', shirt_size: 'L' });
  W.clock.t += SEC;
  ok('a roster write (it rides the roster bust every identity and attribute writer already calls): the door is asked',
     roster.ok === true && W.touch(() => W.load({ pp_start: RUNNING })).door === 1);

  const S = mk(SRC_NEW);
  S.load({ pp_start: RUNNING });
  S.g('bustPerfScreenCache_')();                          // the same instant the answer was kept
  ok('a bust in the very instant an answer was kept still voids it', S.touch(() => S.load({ pp_start: RUNNING })).door === 1);
  ok('the bust is a timestamp kept for six hours, far longer than any entry', S.ttl.get(BUST) === 21600 && Number(S.cache.get(BUST)) === NOW);
  const inputs = mk(SRC_NEW);
  inputs.load({ pp_start: RUNNING });
  const tick = inputs.get({ action: 'incentive_save', token: 'T-sky', pp_start: RUNNING, employee_id: 'bea_bud', att: '1' });
  inputs.clock.t += SEC;
  const shown = inputs.touch(() => inputs.load({ pp_start: RUNNING }));
  ok('an attendance tick needs no bust: it is not in the door\'s answer, and it shows on the very next load, from the copy',
     tick.ok === true && shown.door === 0 && shown.r.perf_cache === 'hit' && shown.r.inputs.bea_bud && shown.r.inputs.bea_bud.att === true);
}

/* ── 12. What the timing tool will show ─────────────────────────────────────────────────────── */
console.log('\nWhat gxcrewstats will show next (the door 1500ms, a cache read 40ms — a simulated clock, NOT a live measurement)');
{
  const W = mk(SRC_NEW);
  W.door.cost = 1500; W.cmode.cost = 40;
  const a = W.load({ pp_start: RUNNING }), b = W.load({ pp_start: RUNNING });
  const r = W.get({ action: 'request_stats', secret: SECRET, hours: '1' });
  const inc = (r.actions || []).find((x) => x.name === 'incentive') || { stages: [] };
  const st = {}; (inc.stages || []).forEach((x) => { st[x.stage] = x; });
  console.log('    perf_fetch on the payload: ' + a.timings.perf_fetch + 'ms asking the door, ' + b.timings.perf_fetch + 'ms from the copy');
  ok('the payload\'s own perf_fetch is the whole fetch either way', a.timings.perf_fetch === 1540 && b.timings.perf_fetch === 40);
  ok('the tool can tell them apart by stage: perf_door once (1540ms), perf_cache_hit once (40ms)',
     inc.count === 2 && st.perf_door && st.perf_door.count === 1 && st.perf_door.max_ms === 1540 && st.perf_cache_hit && st.perf_cache_hit.count === 1 && st.perf_cache_hit.max_ms === 40);
  ok('…and perf_fetch on these loads is what is left over (0ms), so nothing is counted twice', st.perf_fetch && st.perf_fetch.count === 2 && st.perf_fetch.max_ms === 0);
  ok('the stage names are plain literals the timing store accepts', ['perf_door', 'perf_cache_hit'].every((s) => W.g('REQT_STAGE_RE').test(s)));
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\nperf screen cache: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
