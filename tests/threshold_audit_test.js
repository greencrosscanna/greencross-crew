#!/usr/bin/env node
/* ─── The threshold audit note — tests ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/threshold_audit_test.js     (from the repo root; no deps, no network)
 *
 * WHY THESE
 * `incentiveThresholdsRoute_` called `GXCore.addNote(...)` from the day it was written. That name
 * does not exist in the GX Core library — not at Crew's v225 pin, not at HEAD — so every save threw
 * a TypeError into a bare `catch (e) {}`. The threshold write itself succeeded through the
 * secret-gated web route, the tray said "Saved", and the audit line the comment promises was NEVER
 * ONCE WRITTEN, for the setting that decides what every employee earns.
 *
 * Two separate failures, and this file pins both, because fixing only the first leaves the second
 * to hide the next one exactly as well:
 *
 *   • THE NAME. The GX Core stub below carries ONLY functions the real library actually exposes —
 *     it is deliberately NOT a permissive mock. Call a name Core does not have and you get the same
 *     `undefined is not a function` the deployment gets, and the note-was-written assertion fails.
 *     A static sweep does the same job for every other `GXCore.*` call in the file.
 *   • THE SILENCE. A throw or a refusal from the note must stay non-fatal (the comp change is
 *     already stored by then — blocking it would be worse) and must still come back as
 *     `audit_error` plus a log line. The failure that gets found is the one that says something.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so this tests shipped source.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

/* ── What the GX Core library REALLY exposes to a bound caller ───────────────────────────────────
 *
 * Verified against greencross-command-center's .gs files (the library project) on 2026-08-29, at
 * HEAD and at Crew's pinned v225. This list is the point of the file: a name that is not on it is
 * a call that resolves to `undefined` in production and fails inside whatever try/catch surrounds
 * it. Adding to it means going and looking, not guessing. */
const LIB_SURFACE = [
  'requireAuth', 'roleCanEdit', 'libVersion',
  'getEmployees', 'getEmployeeByName', 'getEmployeeByNumber', 'getEmployeeByDutchieId',
  'gxUpsertEmployee', 'gxUpsertEmployees', 'gxUpsertUser',
  'getStores', 'resolveStore', 'getKv', 'setAvatar',
  'gxAddNote', 'gxIngestBug', 'dutchieEmployees',
];

/* Names Crew references that the library does NOT have, and that are correct anyway because the
 * call is GUARDED (`GXCore.setKv ? … : fallback`) and the fallback is the real path. Each one here
 * is a branch that has never executed. Nothing should join this list casually — an UNguarded call
 * to a missing name is the bug this whole file exists for. */
const KNOWN_ABSENT_BUT_GUARDED = ['setKv'];

// ── Recording GX Core stub ──────────────────────────────────────────────────────────────────────
let CALLS, LOGS, FETCHES, ADD_NOTE_THROWS, ADD_NOTE_RESULT, STORED_THRESHOLDS;

const GXCoreStub = {};
LIB_SURFACE.forEach((n) => { GXCoreStub[n] = function () { CALLS.push({ fn: n, args: [].slice.call(arguments) }); }; });

GXCoreStub.requireAuth = () => ({ ok: true, user: 'sky', role: 'admin' });
GXCoreStub.roleCanEdit = (role) => ['admin', 'editor', 'director', 'manager'].indexOf(String(role)) >= 0;
GXCoreStub.libVersion = () => 225;
GXCoreStub.getKv = function (key) {
  CALLS.push({ fn: 'getKv', args: [key] });
  if (key === 'cfg.crewApprover') return 'sky';
  if (key === 'incentiveThresholds') return JSON.stringify(STORED_THRESHOLDS);
  return '';
};
GXCoreStub.gxAddNote = function (fromApp, toApp, title, body, bugId, kind) {
  CALLS.push({ fn: 'gxAddNote', args: [fromApp, toApp, title, body, bugId, kind] });
  if (ADD_NOTE_THROWS) throw new Error(ADD_NOTE_THROWS);
  return ADD_NOTE_RESULT;
};

const stubs = {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getId: () => 'fake' }) },
  DriveApp: {}, HtmlService: {}, ContentService: {},
  UrlFetchApp: {
    fetch(url) {
      FETCHES.push(url);
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    },
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {},
  Logger: { log(m) { LOGS.push(String(m)); } },
  GXCore: GXCoreStub,
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (k) => (k === 'GX_DEPLOY_SECRET' ? 'test-secret' : 'fake-sheet-id'), setProperty() {} }),
  },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep() {} },
};

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
/* Comments stripped first, and that is not a nicety: the fixed route's own comment NAMES the wrong
   function in order to explain it, and a sweep that reads prose would report the explanation as the
   defect forever. Block comments plus whole-line `//` and ` *` lines only — never a trailing `//`,
   which would eat the rest of a line holding a URL. */
const CODE_ONLY = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const names = Object.keys(stubs);
let C;
try {
  C = new Function(...names, SRC +
    '\n; return { incentiveThresholdsRoute_, incentiveThresholds_, thresholdProblems_ };'
  )(...names.map((n) => stubs[n]));
} catch (e) {
  console.error('✗ could not load Code.gs:', e && e.message);
  process.exit(1);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
const GOOD = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 100, bonus: 300 }], maxPerStore: 50 },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

function fresh() {
  CALLS = []; LOGS = []; FETCHES = [];
  ADD_NOTE_THROWS = ''; ADD_NOTE_RESULT = { ok: true, id: 'note-1' };
  STORED_THRESHOLDS = clone(GOOD);
}
const noteCalls = () => CALLS.filter((c) => c.fn === 'gxAddNote');

function save(t) {
  return C.incentiveThresholdsRoute_({ token: 't', save: JSON.stringify(t) });
}

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

console.log('\nThe audit note calls a function GX Core actually has\n');

t('a threshold save writes exactly one note, through gxAddNote', () => {
  fresh();
  const next = clone(GOOD); next.budtender.discountMaxPct = 1.25;
  const r = save(next);
  assert.strictEqual(r.ok, true, 'the save itself: ' + JSON.stringify(r));
  /* THE ASSERTION THIS FILE EXISTS FOR. The stub carries only real library names, so `addNote`
     resolves to undefined here exactly as it does in the deployment, the TypeError lands in the
     route's catch, and this count is zero. */
  assert.strictEqual(noteCalls().length, 1, 'no audit note was written — is the call still GXCore.addNote?');
});

t('...with the six arguments gxAddNote(fromApp, toApp, title, body, bugId, kind) takes, in order', () => {
  fresh();
  const r = save(clone(GOOD));
  assert.strictEqual(r.ok, true);
  const a = noteCalls()[0].args;
  assert.strictEqual(a.length, 6, 'gxAddNote takes six arguments');
  assert.strictEqual(a[0], 'crew', 'from_app');
  assert.strictEqual(a[1], 'core-admin', 'to_app — an address nobody reads is delivered NOWHERE');
  assert.ok(/thresholds changed by sky/i.test(a[2]), 'the title names who changed them: ' + a[2]);
  assert.ok(/before:/.test(a[3]) && /after:/.test(a[3]), 'the body carries before AND after — kv keeps no history');
  assert.strictEqual(a[5], 'fyi', 'kind');
});

t('no GXCore.addNote call survives anywhere in the engine', () => {
  assert.ok(!/GXCore\.addNote\s*\(/.test(CODE_ONLY),
    'GXCore.addNote is back — that name has never existed in the library, at any version');
});

t('every GXCore.* call in Code.gs names a function the library exposes', () => {
  const used = Array.from(new Set((CODE_ONLY.match(/GXCore\.[A-Za-z_][A-Za-z0-9_]*/g) || [])
    .map((s) => s.slice('GXCore.'.length))));
  const unknown = used.filter((n) => LIB_SURFACE.indexOf(n) < 0 && KNOWN_ABSENT_BUT_GUARDED.indexOf(n) < 0);
  assert.deepStrictEqual(unknown, [],
    'these resolve to undefined in the deployment:\n      ' + unknown.join(', ') +
    '\n      Check the name against greencross-command-center/*.gs, then add it to LIB_SURFACE.');
});

t('the GXCore.setKv branch is dead and the secret-gated web route is what runs', () => {
  fresh();
  assert.strictEqual(typeof GXCoreStub.setKv, 'undefined', 'the stub must not invent a kv writer Core lacks');
  const r = save(clone(GOOD));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(FETCHES.length, 1, 'the write went somewhere other than gxSetThresholdsViaWeb_');
  assert.ok(/action=set_config&key=incentiveThresholds/.test(FETCHES[0]), FETCHES[0]);
});

console.log('\nA failed note is reported, never discarded\n');

t('a THROW from the note comes back as audit_error and is logged', () => {
  fresh();
  ADD_NOTE_THROWS = 'GXCore.gxAddNote is not a function';
  const r = save(clone(GOOD));
  assert.ok(r.audit_error, 'the failure was swallowed — this is how the bug hid for its whole life');
  assert.ok(/not a function/.test(r.audit_error), r.audit_error);
  assert.ok(LOGS.some((l) => /audit note FAILED/i.test(l) && /not a function/.test(l)),
    'nothing reached the execution log:\n      ' + LOGS.join('\n      '));
});

t('...and the thresholds still save, because the comp change is already stored by then', () => {
  fresh();
  ADD_NOTE_THROWS = 'boom';
  const r = save(clone(GOOD));
  assert.strictEqual(r.ok, true, 'a failed audit note must never block a legitimate threshold save');
  assert.strictEqual(FETCHES.length, 1, 'the write still happened');
  assert.strictEqual(r.saved_by, 'sky');
});

t('a REFUSAL is a failure too — {ok:false} writes no note and throws nothing', () => {
  fresh();
  ADD_NOTE_RESULT = { ok: false, error: 'unknown to_app: core_admin' };
  const r = save(clone(GOOD));
  assert.strictEqual(r.ok, true);
  assert.ok(/unknown to_app/.test(r.audit_error || ''),
    'a refused note reported success: ' + JSON.stringify(r.audit_error));
  assert.ok(LOGS.some((l) => /audit note FAILED/i.test(l)), 'the refusal was not logged');
});

t('a clean save says so explicitly — audit_error is present and empty', () => {
  fresh();
  const r = save(clone(GOOD));
  assert.ok('audit_error' in r, 'the field must always be present, or "no failure" and "old build" look alike');
  assert.strictEqual(r.audit_error, '');
  assert.strictEqual(LOGS.length, 0, 'nothing to log when nothing failed: ' + LOGS.join(' | '));
});

console.log('\nThe note is downstream of the guards, not around them\n');

t('a rejected scheme writes no note and no threshold', () => {
  fresh();
  const bad = clone(GOOD);
  bad.manager.salesTiers = [{ pct: 100, bonus: 100 }, { pct: 110, bonus: 300 }];   // ascending
  const r = save(bad);
  assert.strictEqual(r.ok, false, 'an ascending tier list pays everyone the lowest tier they clear');
  assert.strictEqual(noteCalls().length, 0, 'audited a change that never happened');
  assert.strictEqual(FETCHES.length, 0);
});

t('a non-approver writes no note and no threshold', () => {
  fresh();
  const was = GXCoreStub.requireAuth;
  GXCoreStub.requireAuth = () => ({ ok: true, user: 'mike', role: 'admin' });
  try {
    const r = save(clone(GOOD));
    assert.strictEqual(r.ok, false, 'Mike prepares a period; he does not move the bar');
    assert.strictEqual(noteCalls().length, 0);
    assert.strictEqual(FETCHES.length, 0);
  } finally { GXCoreStub.requireAuth = was; }
});

console.log(failed ? '\n' + failed + ' FAILED\n' : '\nthreshold audit: all passed\n');
process.exit(failed ? 1 : 0);
