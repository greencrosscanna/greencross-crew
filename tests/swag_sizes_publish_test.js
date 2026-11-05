#!/usr/bin/env node
/* ─── Crew publishes shirt-size COUNTS to GX Core for SPIFF's swag card ──────────────────────────
 *   RUN:  node tests/swag_sizes_publish_test.js
 * Runs the real functions lifted out of Code.gs over fake services. Failures here look like nothing:
 * a retired person ordered a shirt, a name reaching Core, or a not-yet-pinned library throwing. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
function lift(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' not found in Code.gs');
  let depth = 0, end = -1;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  return SRC.slice(at, end);
}
const SECRET = 'fx-secret-9q7z';
let PROPS, CALLS, LOGS, ANSWER, EMPLOYEES, ATTRS;
const SIZES_LINE = SRC.split('\n').find(l => l.startsWith('var SHIRT_SIZES'));

function build() {
  PROPS = { GX_DEPLOY_SECRET: SECRET }; CALLS = []; LOGS = [];
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in PROPS ? PROPS[k] : null),
      setProperty: (k, v) => { PROPS[k] = String(v); },
      deleteProperty: k => { delete PROPS[k]; } }) },
    CacheService: { getScriptCache: () => ({ remove() {} }) },
    Utilities: { formatDate: () => '2026-11-05' },
    Logger: { log: s => LOGS.push(String(s)) },
    GXCore: {
      getEmployees: () => EMPLOYEES,
      publishCrewSwagSizes: (secret, payload, opts) => { CALLS.push({ secret, payload: JSON.parse(JSON.stringify(payload)), opts }); return ANSWER; },
    },
    readAttrs_: () => ATTRS,
    scrubSecrets_: s => String(s).split(SECRET).join('<secret>'),
    deploySecretOk_: p => p.secret === SECRET,
    bustPerfScreenCache_: () => {},
    ROSTER_CACHE_KEY: 'k', CORE_EMP_CACHE_KEY: 'k2',
  };
  vm.createContext(sandbox);
  vm.runInContext(SIZES_LINE + '\n' + ['statusIsLive_', 'normShirt_', 'swagSizesPayload_', 'publishSwagSizesNow_',
    'publishSwagSizesIfDue_', 'swagSizesPublish_', 'bustRosterCache_'].map(lift).join('\n') +
    "\nvar SWAG_PUBLISH_PROP='CREW_LAST_SWAG_PUBLISH'; var SWAG_DIRTY_PROP='CREW_SWAG_DIRTY'; var SWAG_EVERY_MS=55*60*1000;", sandbox);
  return sandbox;
}
const fixtures = () => {
  EMPLOYEES = [
    { employee_id: 'a1', status: 'active', home_store: 'river-rd' },
    { employee_id: 'a2', status: 'active', home_store: 'river-rd' },
    { employee_id: 'a3', status: 'active', home_store: 'river-rd' },
    { employee_id: 'b1', status: 'active', home_store: 'bend' },
    { employee_id: 'c1', status: 'active', home_store: 'bend' },
    { employee_id: 'r1', status: 'retired', home_store: 'bend' },
    { employee_id: 'm1', status: 'merged', home_store: 'bend' },
    { employee_id: 'n1', status: 'active', home_store: '' },
  ];
  ATTRS = { a1: { shirt_size: 'M' }, a2: { shirt_size: 'm' }, a3: { shirt_size: '' }, b1: { shirt_size: 'L' },
    c1: { shirt_size: 'XXL?' }, r1: { shirt_size: 'L' }, m1: { shirt_size: 'L' }, n1: { shirt_size: '2XL' } };
};

console.log('\n1. the counts');
{
  fixtures(); const S = build();
  const p = S.swagSizesPayload_(EMPLOYEES, ATTRS, '2026-11-05');
  ok(p.as_of === '2026-11-05' && same(p.sizes, ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']), 'as_of and sizes');
  ok(p.by_store['river-rd'].shirt.M === 2 && p.by_store['river-rd'].not_set === 1 && p.by_store['river-rd'].active === 3, 'river-rd: 2 M (case folded), 1 not set, 3 active');
  ok(p.by_store.bend.shirt.L === 1 && p.by_store.bend.not_set === 1 && p.by_store.bend.active === 2, 'bend: retired/merged not counted; an invalid size is not set');
  ok(p.total.active === 6 && p.total.shirt.M === 2 && p.total.shirt.L === 1 && p.total['shirt']['2XL'] === 1 && p.total.not_set === 2, 'total includes the store-less person');
  ok(!('' in p.by_store), 'no blank store key');
  ok(Object.keys(p.by_store.bend.shirt).length === 7 && !('hat' in p.total), 'every size present, no hat field');
  const s = JSON.stringify(p);
  ok(!/a1|n1|employee|name/.test(s.replace(/as_of/g, '')), 'no ids or names anywhere');
}

console.log('\n2. the call and the record');
{
  fixtures(); const S = build(); ANSWER = { ok: true };
  const r = S.publishSwagSizesNow_('hourly');
  ok(CALLS.length === 1 && CALLS[0].secret === SECRET && same(CALLS[0].opts, { by: 'crew' }), 'one call: secret, payload, { by: "crew" }');
  ok(r.ok && !PROPS.CREW_SWAG_DIRTY, 'success ok and clears dirty');
  const rec = PROPS.CREW_LAST_SWAG_PUBLISH + LOGS.join('|');
  ok(!rec.includes('a1') && !rec.includes(SECRET) && /"active":6/.test(rec), 'record holds counts only');
  fixtures(); const S2 = build(); PROPS.CREW_SWAG_DIRTY = '1'; ANSWER = { ok: false, code: 'bad_shape', error: 'nope' };
  const r2 = S2.publishSwagSizesNow_('x');
  ok(!r2.ok && r2.note.code === 'bad_shape' && PROPS.CREW_SWAG_DIRTY === '1', 'a refusal is reported and leaves it queued');
}

console.log('\n3. failures send nothing and never throw');
{
  fixtures(); let S = build(); S.GXCore.publishCrewSwagSizes = undefined;
  let r = S.publishSwagSizesNow_('hourly');
  ok(r.note.code === 'library_too_old' && !r.ok, 'unpinned library: recorded, no throw');
  fixtures(); S = build(); EMPLOYEES = []; ANSWER = { ok: true };
  r = S.publishSwagSizesNow_('hourly');
  ok(CALLS.length === 0 && r.note.code === 'empty_roster', 'empty roster sends nothing');
  fixtures(); S = build(); delete PROPS.GX_DEPLOY_SECRET;
  ok(S.publishSwagSizesNow_('x').note.code === 'no_secret' && CALLS.length === 0, 'no secret sends nothing');
  fixtures(); S = build(); S.GXCore.getEmployees = () => { throw new Error('boom ' + SECRET); };
  r = S.publishSwagSizesNow_('x');
  ok(!r.ok && !PROPS.CREW_LAST_SWAG_PUBLISH.includes(SECRET), 'a throw is caught and scrubbed');
}

console.log('\n4. schedule: dirty or hourly');
{
  fixtures(); const S = build(); ANSWER = { ok: true };
  ok(S.publishSwagSizesIfDue_() !== null && CALLS.length === 1, 'never published: goes');
  ok(S.publishSwagSizesIfDue_() === null && CALLS.length === 1, 'just published: waits');
  S.bustRosterCache_();
  ok(PROPS.CREW_SWAG_DIRTY === '1', 'a roster write queues a publish');
  S.publishSwagSizesIfDue_();
  ok(CALLS.length === 2 && !PROPS.CREW_SWAG_DIRTY, 'the sweep sends it and clears the flag');
  PROPS.CREW_LAST_SWAG_PUBLISH = JSON.stringify({ at: new Date(Date.now() - 56 * 60000).toISOString(), ok: true });
  S.publishSwagSizesIfDue_();
  ok(CALLS.length === 3, 'an hour later it goes again');
}

console.log('\n5. the route: dry by default, secret-gated');
{
  fixtures(); const S = build(); ANSWER = { ok: true };
  ok(S.swagSizesPublish_({ secret: 'wrong' }).ok === false && CALLS.length === 0, 'bad secret refused');
  const d = S.swagSizesPublish_({ secret: SECRET });
  ok(CALLS.length === 0 && d.would_send && d.would_send.total.active === 6 && !PROPS.CREW_LAST_SWAG_PUBLISH, 'dry run calls nothing, records nothing, shows counts');
  const g = S.swagSizesPublish_({ secret: SECRET, confirm: 'yes' });
  ok(CALLS.length === 1 && g.ran === true, 'confirm=yes publishes');
}

console.log('\n6. wiring');
{
  ok(/publishSwagSizesIfDue_\(\)/.test(lift('approvalEscalationSweep')), 'the 15-minute sweep calls it');
  ok(/case 'swag_sizes_publish':\s*return json_\(swagSizesPublish_\(p\)/.test(SRC), 'route wired');
  ok(/typeof GXCore\.publishCrewSwagSizes !== 'function'/.test(lift('publishSwagSizesNow_')), 'feature-detected');
  ok(!/UrlFetchApp|Logger\.log\([^)]*swagCounts/.test(lift('publishSwagSizesNow_')), 'no URL fetch; payload not logged');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
