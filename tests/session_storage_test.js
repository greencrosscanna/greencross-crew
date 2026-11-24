#!/usr/bin/env node
/* ─── A SIGN-IN SURVIVES CLOSING THE TAB, AND NOBODY IS SIGNED OUT BY THE MOVE ──────────────────
 *
 *   RUN:  node tests/session_storage_test.js
 *
 * Sky, 2026-11-23: "my computers are private, 30 days is okay". Crew's session moved from
 * sessionStorage (dies with the tab) to localStorage (survives it). Four promises:
 *
 *   1. MIGRATION — someone signed in when this shipped has their token in sessionStorage. The first
 *      read copies token, user and avatar into localStorage and removes the old copies.
 *   2. READ — token(), currentUser(), currentAvatar() read localStorage, and a token already there
 *      wins over anything left in sessionStorage.
 *   3. WRITE — setSession writes localStorage and nothing to sessionStorage.
 *   4. SIGN-OUT clears BOTH stores (and the saved roster copy), so a leftover old copy cannot be
 *      carried back in by the migration on the next read.
 *
 * Executes the SHIPPED functions out of crew.js against stub stores.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const js = fs.readFileSync(__dirname + '/../crew.js', 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

function grab(name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in crew.js');
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
const bare = js.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
               .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
function constOf(name) {
  const m = new RegExp('var ' + name + '\\s*=\\s*[^;]+;').exec(bare);
  if (!m) throw new Error('missing const ' + name);
  return m[0];
}

function stub(init, opts) {
  const mem = new Map(Object.entries(init || {}));
  return {
    _mem: mem,
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { if (opts && opts.failSet) throw new Error('QuotaExceededError'); mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
  };
}

function ctxWith(local, session, opts) {
  const ctx = {
    console, JSON, Object, Array, String, Number, Math, Date, Error,
    localStorage: stub(local, opts && opts.local),
    sessionStorage: stub(session),
    _forgot: 0,
  };
  vm.createContext(ctx);
  vm.runInContext([
    constOf('TOKEN_KEY'), constOf('USER_KEY'), constOf('AVATAR_KEY'),
    'function rosterForgetCopy_() { _forgot++; }',
    grab('sessionMigrate_'), grab('sessionRead_'), grab('token'), grab('setSession'),
    grab('currentAvatar'), grab('currentUser'),
  ].join('\n'), ctx);
  return ctx;
}

const OLD = { gx_crew_token: 'tok-old', gx_crew_user: 'Sky', gx_crew_avatar: '{"top":"shortFlat"}' };

console.log('\n0. the keys are the ones the live app has always used');
{
  const c = ctxWith();
  ok('TOKEN_KEY is gx_crew_token', c.TOKEN_KEY === 'gx_crew_token');
  ok('USER_KEY is gx_crew_user', c.USER_KEY === 'gx_crew_user');
  ok('AVATAR_KEY is gx_crew_avatar', c.AVATAR_KEY === 'gx_crew_avatar');
}

console.log('\n1. migration — someone signed in before the change stays signed in');
{
  const c = ctxWith({}, OLD);
  ok('token() returns the old sessionStorage token', c.token() === 'tok-old');
  ok('...now copied into localStorage', c.localStorage._mem.get('gx_crew_token') === 'tok-old');
  ok('user copied too', c.localStorage._mem.get('gx_crew_user') === 'Sky');
  ok('avatar copied too', c.localStorage._mem.get('gx_crew_avatar') === OLD.gx_crew_avatar);
  ok('the sessionStorage token is removed', !c.sessionStorage._mem.has('gx_crew_token'));
  ok('the sessionStorage user is removed', !c.sessionStorage._mem.has('gx_crew_user'));
  ok('the sessionStorage avatar is removed', !c.sessionStorage._mem.has('gx_crew_avatar'));
  ok('currentUser() reads the migrated user', c.currentUser() === 'Sky');
  ok('currentAvatar() reads the migrated avatar', JSON.stringify(c.currentAvatar()) === OLD.gx_crew_avatar);

  /* Migration via currentUser() first, not token() — any first read carries the whole session. */
  const c2 = ctxWith({}, OLD);
  ok('a first read through currentUser() migrates as well', c2.currentUser() === 'Sky' &&
    c2.localStorage._mem.get('gx_crew_token') === 'tok-old' && !c2.sessionStorage._mem.size);

  /* A copy that fails must not remove the only copy there is. */
  const c3 = ctxWith({}, OLD, { local: { failSet: true } });
  c3.token();
  ok('a failed copy leaves the sessionStorage session in place', c3.sessionStorage._mem.get('gx_crew_token') === 'tok-old');

  const c4 = ctxWith({}, {});
  ok('nobody signed in anywhere → empty token', c4.token() === '');
  ok('...and nothing is written', c4.localStorage._mem.size === 0);
}

console.log('\n2. read — localStorage is the store, and its token wins');
{
  const c = ctxWith({ gx_crew_token: 'tok-new', gx_crew_user: 'Mike' }, OLD);
  ok('token() returns the localStorage token', c.token() === 'tok-new');
  ok('currentUser() returns the localStorage user', c.currentUser() === 'Mike');
  ok('the localStorage token is not overwritten by the old one', c.localStorage._mem.get('gx_crew_token') === 'tok-new');

  const c2 = ctxWith({ gx_crew_token: 'tok-new' }, {});
  ok('currentAvatar() with no avatar → null', c2.currentAvatar() === null);
}

console.log('\n3. write — setSession writes localStorage only');
{
  const c = ctxWith({}, {});
  c.setSession('tok-abc', 'Shawn', { top: 'bob' });
  ok('token written to localStorage', c.localStorage._mem.get('gx_crew_token') === 'tok-abc');
  ok('user written to localStorage', c.localStorage._mem.get('gx_crew_user') === 'Shawn');
  ok('avatar written to localStorage as JSON', c.localStorage._mem.get('gx_crew_avatar') === '{"top":"bob"}');
  ok('nothing written to sessionStorage', c.sessionStorage._mem.size === 0);
  ok('token() reads it back', c.token() === 'tok-abc');
  ok('the saved roster is not forgotten on sign-IN', c._forgot === 0);

  c.setSession('tok-2', '', null);
  ok('no avatar → empty string, not "null"', c.localStorage._mem.get('gx_crew_avatar') === '');
}

console.log('\n4. sign-out clears BOTH stores');
{
  const c = ctxWith({ gx_crew_token: 'tok-new', gx_crew_user: 'Mike', gx_crew_avatar: '{}', other: 'keep' }, OLD);
  c.setSession('', '');
  ok('localStorage token gone', !c.localStorage._mem.has('gx_crew_token'));
  ok('localStorage user gone', !c.localStorage._mem.has('gx_crew_user'));
  ok('localStorage avatar gone', !c.localStorage._mem.has('gx_crew_avatar'));
  ok('sessionStorage token gone', !c.sessionStorage._mem.has('gx_crew_token'));
  ok('sessionStorage user gone', !c.sessionStorage._mem.has('gx_crew_user'));
  ok('sessionStorage avatar gone', !c.sessionStorage._mem.has('gx_crew_avatar'));
  ok('unrelated localStorage keys are left alone', c.localStorage._mem.get('other') === 'keep');
  ok('the saved roster copy is forgotten', c._forgot === 1);
  ok('the next read finds nobody signed in (no old copy carried back)', c.token() === '');
}

console.log('\n5. no session read outside the helpers still goes to sessionStorage');
{
  const reads = (bare.match(/sessionStorage\.getItem\(/g) || []).length;
  const inMigrate = (grab('sessionMigrate_').match(/sessionStorage\.getItem\(/g) || []).length;
  ok('every sessionStorage read in crew.js is inside sessionMigrate_', reads === inMigrate);
}

console.log(fail ? `\nsession storage: ${fail} FAILED` : '\nsession storage: all passed');
process.exit(fail ? 1 : 0);
