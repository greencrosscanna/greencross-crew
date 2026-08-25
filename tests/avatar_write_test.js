#!/usr/bin/env node
/* ─── Avatar writes go through GXCore.setAvatar — tests ───────────────────────────────────────────
 *
 *   RUN:  node tests/avatar_write_test.js     (from the repo root; no deps, no network)
 *
 * WHY THESE
 * avatar_config was written by two apps with two hand-rolled read-merge-writes that did not agree.
 * GX Core v225 turned Crew's version into `GXCore.setAvatar(ref, config, by)` — the one avatar
 * write in the suite. What has to stay true here:
 *
 *   • an avatar-only edit DELEGATES. If saveIdentity_ ever quietly falls back to building the row
 *     itself, the second implementation is back and nothing errors — the face still saves.
 *   • a MIXED edit (avatar + name/store/role) stays ONE atomic row write, and that row still
 *     carries dutchie_employee_id and user_id. Splitting it to route the avatar separately is how
 *     a half-applied identity edit becomes possible; omitting a column is how gxWrite_ blanks it.
 *   • a refusal from Core is a refusal here. The old failure mode in this area was a write that
 *     reported success and changed nothing, so "setAvatar said no" must never fall through to a
 *     local write.
 *   • the seed is pinned to employee_number, never to a name — a rename must not change a face.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so it tests shipped source.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

// ── Fake Crew attribute sheet (readAttrs_ reaches a real spreadsheet) ────────────────────────────
let ATTR_GRID = [['employee_id']];
function cell(r, c) { const row = ATTR_GRID[r] || []; return row[c] == null ? '' : row[c]; }
const fakeSheet = {
  getLastRow: () => ATTR_GRID.length,
  getLastColumn: () => Math.max(...ATTR_GRID.map(r => r.length)),
  getMaxRows: () => ATTR_GRID.length + 10,
  setFrozenRows() {}, appendRow() {},
  // The rename branch appends a row to the alias tab through sheetOf_(crewSheet_().getParent()).
  getParent: () => ({ getSheetByName: () => fakeSheet, insertSheet: () => fakeSheet }),
  getRange(r, c, nr, nc) {
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = [];
          for (let j = 0; j < (nc || 1); j++) row.push(cell(r - 1 + i, c - 1 + j));
          out.push(row);
        }
        return out;
      },
      setValues() { return this; }, setFontWeight() { return this; }, setNumberFormat() { return this; },
    };
  },
};

// ── GX Core stub: records every call, answers what the test tells it to ──────────────────────────
let CALLS, EMPLOYEES, SET_AVATAR_RESULT, SET_AVATAR_THROWS, UPSERT_RESULT;
function resetCalls() { CALLS = { setAvatar: [], gxUpsertEmployee: [] }; }
resetCalls();

const GXCoreStub = {
  requireAuth: () => ({ ok: true, user: 'sky', role: 'admin' }),
  roleCanEdit: (role) => ['admin', 'editor', 'director', 'manager'].indexOf(String(role)) >= 0,
  getEmployees: () => JSON.parse(JSON.stringify(EMPLOYEES)),
  getStores: () => [{ store_id: 'river-rd' }, { store_id: 'portland-rd' }],
  libVersion: () => 225,
  setAvatar(ref, config, by) {
    CALLS.setAvatar.push({ ref, config, by });
    if (SET_AVATAR_THROWS) throw new Error('GXCore.setAvatar is not a function');
    return SET_AVATAR_RESULT;
  },
  gxUpsertEmployee(rec) { CALLS.gxUpsertEmployee.push(JSON.parse(JSON.stringify(rec))); return UPSERT_RESULT; },
  gxUpsertEmployees(recs) { recs.forEach(r => CALLS.gxUpsertEmployee.push(r)); return { ok: true }; },
};

const stubs = {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSheet, getId: () => 'fake' }) },
  DriveApp: {}, UrlFetchApp: {}, HtmlService: {}, ContentService: {},
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {}, Logger: { log() {} },
  GXCore: GXCoreStub,
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'fake-sheet-id', setProperty() {} }) },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep() {} },
};

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const names = Object.keys(stubs);
let C;
try {
  C = new Function(...names, SRC +
    '\n; return { saveIdentity_, saveAvatarOnly_, avatarCfgSame_, avatarSeedFrom_, avatarSeed_, ATTR_HEADERS };'
  )(...names.map(n => stubs[n]));
} catch (e) {
  console.error('✗ could not load Code.gs:', e && e.message);
  process.exit(1);
}

ATTR_GRID = [C.ATTR_HEADERS.slice()];
function setAttrs(rows) {
  ATTR_GRID = [C.ATTR_HEADERS.slice()].concat(
    rows.map(r => C.ATTR_HEADERS.map(h => (r[h] == null ? '' : r[h]))));
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
const PRIOR = {
  employee_id: 'jayden_ellison', full_name: 'Jayden Ellison', preferred_name: '',
  home_store: 'river-rd', role_title: 'Budtender', hire_date: '2024-02-01',
  status: 'active', employee_number: '42',
  dutchie_employee_id: 'DUT-991', user_id: 'jayden', avatar_config: '',
};
const CFG = { skinColor: 'ffdbb4', top: 'shortFlat', hairColor: '4a312c' };

function fresh(over) {
  EMPLOYEES = [Object.assign({}, PRIOR, over || {})];
  SET_AVATAR_RESULT = { ok: true, employee_id: PRIOR.employee_id, name: PRIOR.full_name, seed: '42', cleared: false };
  SET_AVATAR_THROWS = false;
  UPSERT_RESULT = { ok: true, cleared: [] };
  setAttrs([{ employee_id: PRIOR.employee_id, full_name: PRIOR.full_name, employee_number: '42' }]);
  resetCalls();
}

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

console.log('\nAvatar writes → GXCore.setAvatar\n');

t('an avatar-only save delegates to setAvatar and never builds a row itself', () => {
  fresh();
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: JSON.stringify(CFG) });
  assert.strictEqual(r.ok, true, 'save refused: ' + r.error);
  assert.strictEqual(CALLS.setAvatar.length, 1, 'setAvatar should be called exactly once');
  assert.strictEqual(CALLS.gxUpsertEmployee.length, 0,
    'an avatar-only write must not reach gxUpsertEmployee — that is the second implementation coming back');
  assert.strictEqual(CALLS.setAvatar[0].ref, PRIOR.employee_id);
  assert.deepStrictEqual(CALLS.setAvatar[0].config, CFG, 'the config goes over as given; setAvatar pins the seed');
  assert.ok(/sky/.test(String(CALLS.setAvatar[0].by)), 'the acting user is passed for the audit line');
  assert.deepStrictEqual(r.changed, ['avatar_config']);
  assert.strictEqual(r.seed, '42', "setAvatar's seed is reported back");
});

t('removing an avatar sends an empty config and reports the clear Core verified', () => {
  fresh({ avatar_config: JSON.stringify(Object.assign({ seed: '42' }, CFG)) });
  SET_AVATAR_RESULT = { ok: true, employee_id: PRIOR.employee_id, seed: '42', cleared: true };
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: '' });
  assert.strictEqual(r.ok, true, 'clear refused: ' + r.error);
  assert.strictEqual(CALLS.setAvatar.length, 1);
  assert.strictEqual(CALLS.setAvatar[0].config, '', 'an empty config is how setAvatar is told to clear');
  assert.strictEqual(r.cleared, true);
  assert.deepStrictEqual(r.not_cleared, [], 'setAvatar verifies the clear, so nothing is left over');
  assert.strictEqual(r.warning, '', 'a warning is read by the client as a failed save');
});

t('a refusal from setAvatar is a refusal here — no local fallback write', () => {
  fresh();
  SET_AVATAR_RESULT = { ok: false, error: 'asked to clear avatar_config and it is still set' };
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: JSON.stringify(CFG) });
  assert.strictEqual(r.ok, false);
  assert.ok(/still set/.test(r.error), "Core's own error is surfaced, not replaced");
  assert.strictEqual(CALLS.gxUpsertEmployee.length, 0, 'a refusal must not fall through to a hand-rolled write');
});

t('a lock timeout from setAvatar keeps its retryable flag', () => {
  fresh();
  SET_AVATAR_RESULT = { ok: false, retryable: true, error: 'Lock timeout' };
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: JSON.stringify(CFG) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.retryable, true);
});

t('a pre-v225 library says so instead of throwing "not a function"', () => {
  fresh();
  SET_AVATAR_THROWS = true;
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: JSON.stringify(CFG) });
  assert.strictEqual(r.ok, false);
  assert.ok(/v225/.test(r.error), 'the error must name the version, because the fix is a re-pin AND a redeploy');
  assert.ok(/health/.test(r.error), 'and point at the route that reports the LIVE pin');
  assert.strictEqual(CALLS.gxUpsertEmployee.length, 0);
});

t('malformed JSON is refused before anything is written', () => {
  fresh();
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: '{not json' });
  assert.strictEqual(r.ok, false);
  assert.ok(/DiceBear/.test(r.error));
  assert.strictEqual(CALLS.setAvatar.length, 0);
  assert.strictEqual(CALLS.gxUpsertEmployee.length, 0);
});

t('an array is not a config', () => {
  fresh();
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: '["shortFlat"]' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(CALLS.setAvatar.length, 0);
});

t('re-saving the same face reports no change (the seed is the writer\'s, not the caller\'s)', () => {
  fresh({ avatar_config: JSON.stringify(Object.assign({ seed: '42' }, CFG)) });
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id, avatar_config: JSON.stringify(CFG) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.changed, [], 'the incoming config carries no seed; a raw compare would cry change');
});

console.log('\nA mixed identity edit stays ONE atomic row write\n');

t('avatar + name goes through gxUpsertEmployee once, not setAvatar', () => {
  fresh();
  const r = C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id,
    full_name: 'Jayden Ellison-Ray', avatar_config: JSON.stringify(CFG) });
  assert.strictEqual(r.ok, true, 'save refused: ' + r.error);
  assert.strictEqual(CALLS.setAvatar.length, 0, 'splitting an atomic identity write is the thing not to do');
  assert.strictEqual(CALLS.gxUpsertEmployee.length, 1, 'exactly one write, or the edit can half-apply');
});

t('...and that row still carries the columns this screen never shows', () => {
  fresh();
  C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id,
    home_store: 'portland-rd', avatar_config: JSON.stringify(CFG) });
  const rec = CALLS.gxUpsertEmployee[0];
  assert.strictEqual(rec.dutchie_employee_id, 'DUT-991', 'read-merge-write: SPIFF/Leaderboard attribution');
  assert.strictEqual(rec.user_id, 'jayden', 'read-merge-write: the email link');
  assert.strictEqual(rec.employee_number, '42');
  assert.strictEqual(rec.home_store, 'portland-rd');
});

t('the mixed path still stamps the seed, pinned to employee_number', () => {
  fresh();
  C.saveIdentity_({ token: 't', employee_id: PRIOR.employee_id,
    preferred_name: 'Jay', avatar_config: JSON.stringify(CFG) });
  const stored = JSON.parse(CALLS.gxUpsertEmployee[0].avatar_config);
  assert.strictEqual(stored.seed, '42', 'a rename must never move the seed off the employee number');
  assert.strictEqual(stored.top, 'shortFlat', 'the rest of the config survives the stamp');
});

console.log('\nThe seed definition the READ paths still need\n');

t('avatarSeedFrom_ prefers the employee number over anything name-shaped', () => {
  assert.strictEqual(C.avatarSeedFrom_({ employee_number: '42' }, { employee_number: '' }, 'jayden_ellison'), '42');
  assert.strictEqual(C.avatarSeedFrom_(null, { employee_number: '00' }, 'sky_pinnick'), '00',
    'the owner is 00 and leading zeros must survive as text');
});

t('...and falls back to employee_id only for someone not yet numbered', () => {
  assert.strictEqual(C.avatarSeedFrom_(null, {}, 'andrew_roberts'), 'andrew_roberts');
});

t('avatarCfgSame_ ignores the seed and key order, not the values', () => {
  assert.strictEqual(C.avatarCfgSame_('{"a":"1","b":"2"}', '{"b":"2","a":"1","seed":"42"}'), true);
  assert.strictEqual(C.avatarCfgSame_('{"a":"1"}', '{"a":"2"}'), false);
  assert.strictEqual(C.avatarCfgSame_('', ''), true);
  assert.strictEqual(C.avatarCfgSame_('{"a":"1"}', ''), false);
});

console.log('\nThe dead hand-off routes are gone, and stay gone\n');

t('no `avatars` / `avatar_save` route, and no writer behind them', () => {
  assert.ok(!/case\s+'avatars'/.test(SRC), "route 'avatars' is back — nothing outside Crew ever called it");
  assert.ok(!/case\s+'avatar_save'/.test(SRC), "route 'avatar_save' is back — the write belongs to GXCore.setAvatar");
  assert.ok(!/function\s+avatarSave_/.test(SRC), 'avatarSave_ is a second avatar writer by another name');
  assert.ok(!/function\s+avatarsForKiosk_/.test(SRC));
});

t('Crew has exactly one avatar_config writer left, and it is the mixed identity path', () => {
  const writers = SRC.split('\n').filter(l => /^\s*[a-zA-Z]*\.?avatar_config\s*=/.test(l) ||
                                              /changes\.avatar_config\s*=/.test(l));
  assert.ok(writers.length <= 3, 'unexpected avatar_config assignments:\n' + writers.join('\n'));
  assert.ok(/GXCore\.setAvatar/.test(SRC), 'the primitive is actually called');
});

console.log(failed ? '\n' + failed + ' failing\n' : '\nAll good.\n');
process.exit(failed ? 1 : 0);
