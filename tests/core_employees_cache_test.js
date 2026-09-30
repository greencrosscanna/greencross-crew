#!/usr/bin/env node
/* ─── The screen may read a cached roster. A PAYROLL WRITE MAY NOT. ────────────────────────────
 *
 *   RUN:  node tests/core_employees_cache_test.js
 *
 * WHY THIS EXISTS
 * Measured 2026-09-30, six live `?action=incentive` loads: the `stamp` stage cost 1.3-2.0s every
 * time, all of it one `GXCore.getEmployees()` call for a list `rosterJoin_` had usually just
 * cached. The incentive screen reads the whole roster twice per load. It now reads a cached copy —
 * but ONLY on the screen path.
 *
 * WHAT THIS PINS, and every one of these is a way to be wrong that still returns a full payload:
 *
 *   - A WRITE NEVER TOUCHES THE CACHE. perfForWrite_ is called bare by the two write paths and
 *     with {snapshot:true} by the screen. A bonus computed against a ten-minute-old roster
 *     balances, reconciles, and pays somebody the wrong amount. This is the assertion that matters;
 *     everything else here is speed.
 *   - AN EMPTY READ IS NEVER CACHED, and a cached empty is never served. stampEmployeeIds_ treats
 *     an empty roster as "nobody matched" — it stamps no one, throws nothing, and returns a
 *     complete-looking payload in which every employee_id is blank. Caching that would make one
 *     bad GX Core read persist for ten minutes; this file's sibling
 *     (roster_cache_bust_coverage_test.js) exists because of a related silent failure.
 *   - MERGED RECORDS SURVIVE THE CACHE. rosterJoin_ filters merged tombstones out of its joined
 *     rows; the stamp needs them, because a merged id must still resolve for a Leaderboard join.
 *     Caching the joined rows instead of the raw tab would silently stop stamping exactly the
 *     people whose records were merged.
 *   - THE BUST CLEARS BOTH KEYS. It rides the roster bust so every existing writer invalidates it
 *     with no new call site to remember. If it only cleared the roster, every writer in the
 *     coverage test would be half-effective.
 *   - A CACHE OUTAGE COSTS A RE-READ, NEVER AN ANSWER.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
function constOf(name) {
  const re = new RegExp('var ' + name + '\\s*=\\s*[^;]+;');
  const m = re.exec(gs);
  if (!m) throw new Error('missing const ' + name);
  return m[0];
}

/* A CacheService stand-in that counts, so "did it re-read" is measured rather than inferred. */
function makeEnv({ employees, cacheBroken = false } = {}) {
  const store = new Map();
  const counts = { coreReads: 0, puts: 0 };
  const cache = {
    get(k) { if (cacheBroken) throw new Error('cache down'); return store.has(k) ? store.get(k) : null; },
    put(k, v) { if (cacheBroken) throw new Error('cache down'); counts.puts++; store.set(k, v); },
    remove(k) { if (cacheBroken) throw new Error('cache down'); store.delete(k); },
  };
  const ctx = {
    console, JSON, Object, Array, String, Number, Boolean, Math, Date, RegExp,
    CacheService: { getScriptCache: () => cache },
    GXCore: { getEmployees() { counts.coreReads++; return employees; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    readAttrs_: () => ({}),
    nameToKey_: n => String(n || '').toLowerCase().trim().replace(/\s+/g, '_'),
    displayNameOf_: e => String(e.full_name || ''),
    samePerson_: (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase(),
    isTruthyFlag_: v => v === true || v === 'true' || v === 1,
    rosterCoverage_: () => ({}),
    normDate_: v => String(v || ''),
    dateFromIso_: () => null,
    statusIsLive_: e => String(e && e.status || '').toLowerCase() !== 'merged',
  };
  vm.createContext(ctx);
  vm.runInContext([
    constOf('ROSTER_CACHE_KEY'), constOf('ROSTER_CACHE_TTL'), constOf('CORE_EMP_CACHE_KEY'),
    grab('bustRosterCache_'), grab('coreEmployeesCached_'), grab('coreEmployeesCachePut_'),
    grab('stampEmployeeIds_'),
  ].join('\n'), ctx);
  return { ctx, counts, store };
}

const ROSTER = [
  { employee_id: 'ana_lopez', full_name: 'Ana Lopez', status: 'active' },
  { employee_id: 'bo_reed', full_name: 'Bo Reed', status: 'active' },
  { employee_id: 'old_reed', full_name: 'Bo Reed', status: 'merged' },
];
const boardOf = () => ({ budtenders: [{ name: 'Ana Lopez' }, { name: 'Bo Reed' }], managers: [] });

console.log('\n1. the screen caches; the second read costs nothing');
{
  const { ctx, counts } = makeEnv({ employees: ROSTER });
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  ok('the first screen load reads GX Core', counts.coreReads === 1);
  ok('...and caches it', counts.puts === 1);
  const live2 = boardOf();
  ctx.stampEmployeeIds_(live2, { snapshot: true });
  ok('the second screen load reads GX Core ZERO more times', counts.coreReads === 1);
  ok('...and still stamps everybody', live2.budtenders.every(r => r.employee_id));
}

console.log('\n2. a payroll WRITE never reads the cache — the assertion that matters');
{
  const { ctx, counts } = makeEnv({ employees: ROSTER });
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });   // warm it
  ok('cache is warm', counts.coreReads === 1);
  ctx.stampEmployeeIds_(boardOf());                       // a write path: bare, no opts
  ok('a write path goes to GX Core anyway', counts.coreReads === 2);
  ctx.stampEmployeeIds_(boardOf(), {});                   // opts without snapshot
  ok('...and so does any caller not claiming to be the screen', counts.coreReads === 3);
  ok('a write never writes the cache either', counts.puts === 1);
}

console.log('\n3. an empty or failed read is never cached, and never served');
{
  const { ctx, counts, store } = makeEnv({ employees: [] });
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  ok('an empty roster is not cached', counts.puts === 0);
  ok('...so nothing is stored under the key', !store.has(ctx.CORE_EMP_CACHE_KEY));
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  ok('...and the next load re-reads rather than serving the empty', counts.coreReads === 2);

  const env2 = makeEnv({ employees: ROSTER });
  env2.store.set(env2.ctx.CORE_EMP_CACHE_KEY, '[]');
  env2.ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  ok('a cached EMPTY array is refused and the live read happens', env2.counts.coreReads === 1);

  const env3 = makeEnv({ employees: ROSTER });
  env3.store.set(env3.ctx.CORE_EMP_CACHE_KEY, 'not json{');
  env3.ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  ok('a corrupt entry falls through to a live read rather than throwing', env3.counts.coreReads === 1);
}

console.log('\n4. merged tombstones survive the round trip');
{
  const { ctx, store } = makeEnv({ employees: ROSTER });
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  const cached = JSON.parse(store.get(ctx.CORE_EMP_CACHE_KEY));
  ok('the RAW tab is cached, merged rows included', cached.length === 3);
  ok('...including the merged tombstone by id', cached.some(r => r.status === 'merged'));
}

console.log('\n5. the bust clears BOTH keys');
{
  const { ctx, store, counts } = makeEnv({ employees: ROSTER });
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  store.set(ctx.ROSTER_CACHE_KEY, '{"rows":[]}');
  ok('both keys are populated', store.has(ctx.ROSTER_CACHE_KEY) && store.has(ctx.CORE_EMP_CACHE_KEY));
  ctx.bustRosterCache_();
  ok('the roster key is cleared', !store.has(ctx.ROSTER_CACHE_KEY));
  ok('the employees key is cleared TOO — every existing writer invalidates it', !store.has(ctx.CORE_EMP_CACHE_KEY));
  ctx.stampEmployeeIds_(boardOf(), { snapshot: true });
  ok('...so the next screen load re-reads', counts.coreReads === 2);
}

console.log('\n6. a cache outage costs a re-read, never an answer');
{
  const { ctx, counts } = makeEnv({ employees: ROSTER, cacheBroken: true });
  const live = boardOf();
  let threw = false;
  try { ctx.stampEmployeeIds_(live, { snapshot: true }); } catch (e) { threw = true; }
  ok('a dead cache does not throw', !threw);
  ok('...the roster still arrives', counts.coreReads === 1);
  ok('...and everybody is still stamped', live.budtenders.every(r => r.employee_id));
  let bustThrew = false;
  try { ctx.bustRosterCache_(); } catch (e) { bustThrew = true; }
  ok('busting against a dead cache does not throw either', !bustThrew);
}

console.log(fail ? `\ncore employees cache: ${fail} FAILED` : '\ncore employees cache: all passed');
process.exit(fail ? 1 : 0);
