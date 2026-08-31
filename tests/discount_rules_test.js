#!/usr/bin/env node
/* ─── Discount rules: GX Core holds the state, Leaderboard only supplies the names ────────────────
 *
 *   RUN:  node tests/discount_rules_test.js      (from the repo root; no deps, no network)
 *
 * WHY THESE
 * Which discretionary discounts count against a budtender decides what everybody earns, and every
 * way it goes wrong is silent — a wrong answer here still renders as a perfectly plausible bonus.
 * Three failures this file pins, two of which have actually happened:
 *
 *   • THE INVERSION. The checkbox means COUNTED; the store holds EXCLUDED. Post one while
 *     displaying the other and every budtender is graded against the opposite rule, and nothing
 *     about the result looks wrong. The flip is the engine's, in exactly one place.
 *   • THE SEPARATOR. crew.js sent `join('\\n')` — a literal backslash-n — from the day it was
 *     written, so the engine's split never matched, the whole list arrived as ONE string that
 *     equalled no discount name, and the old inversion wrote EXCLUDED for every discretionary
 *     discount. That pays the discount bonus to everybody. Fixed 2026-08-30; pinned here in both
 *     directions (the client sends a real newline; the engine tolerates the typo inertly).
 *   • THE MERGE ONTO NOTHING. The write is a read-merge-write and `set_config` replaces the whole
 *     kv value, so merging onto a `{}` that was really a FAILED read silently switches rules back
 *     on. Unreadable must refuse, absent may default.
 *
 * It also pins the boundary itself: the write goes to GX CORE and to nowhere else, and the names
 * still come from Leaderboard because GX Core has no discount data at all — the honest shape of
 * this change is "the write hop is gone, the read hop for names is not".
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so this tests shipped source.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

const CREW_ENGINE = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const CREW_JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');

/* Only names the real GX Core library exposes to a bound caller — deliberately not a permissive
   mock, for the same reason threshold_audit_test.js is not one. `setKv` is absent on purpose. */
const LIB_SURFACE = [
  'requireAuth', 'roleCanEdit', 'libVersion',
  'getEmployees', 'getEmployeeByName', 'getEmployeeByNumber', 'getEmployeeByDutchieId',
  'gxUpsertEmployee', 'gxUpsertEmployees', 'gxUpsertUser',
  'getStores', 'resolveStore', 'getKv', 'setAvatar',
  'gxAddNote', 'gxIngestBug', 'dutchieEmployees',
];

let CALLS, LOGS, FETCHES, KV, KV_THROWS, LB_REPLY, LB_HTTP, USER, NOTE_RESULT, NOTE_THROWS;

const GXCoreStub = {};
LIB_SURFACE.forEach((n) => { GXCoreStub[n] = function () { CALLS.push({ fn: n, args: [].slice.call(arguments) }); }; });
GXCoreStub.requireAuth = () => ({ ok: true, user: USER, role: 'admin' });
GXCoreStub.roleCanEdit = () => true;
GXCoreStub.libVersion = () => 244;
GXCoreStub.getKv = function (key) {
  CALLS.push({ fn: 'getKv', args: [key] });
  if (KV_THROWS && key === 'discountRules') throw new Error(KV_THROWS);
  return Object.prototype.hasOwnProperty.call(KV, key) ? KV[key] : '';
};
GXCoreStub.gxAddNote = function () {
  CALLS.push({ fn: 'gxAddNote', args: [].slice.call(arguments) });
  if (NOTE_THROWS) throw new Error(NOTE_THROWS);
  return NOTE_RESULT;
};

const stubs = {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getId: () => 'fake' }) },
  DriveApp: {}, HtmlService: {}, ContentService: {},
  UrlFetchApp: {
    fetch(url) {
      FETCHES.push(url);
      if (/action=discountrules/.test(url)) {
        return { getResponseCode: () => LB_HTTP, getContentText: () => JSON.stringify(LB_REPLY) };
      }
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

const names = Object.keys(stubs);
let C;
try {
  C = new Function(...names, CREW_ENGINE +
    '\n; return { incentiveDiscountsRoute_, incentiveDiscountsPayload_, discountRules_, discountRegistry_ };'
  )(...names.map((n) => stubs[n]));
} catch (e) {
  console.error('could not load Code.gs:', e && e.message);
  process.exit(1);
}

/* Leaderboard's real reply shape. Its `excluded` flags are WRONG here on purpose: they are the
   opposite of what Core says, so any test that passes while reading them is reading the wrong
   source of truth. */
const LB_OK = {
  ok: true,
  builtAt: '2026-08-30T00:00:00.000Z',
  discretionary: [
    { name: 'Employee Discount', code: 'EMP', method: 'Manual', excluded: false },
    { name: '$2 GOOGLE REVIEW PRE-ROLL', code: 'GOOG', method: 'Code', excluded: false },
    { name: '5 for $20 Gummies, same strain only', code: 'G5', method: 'Code', excluded: true },
    { name: 'Veteran', code: 'VET', method: 'Manual', excluded: true },
  ],
  autoExcluded: { automatic: ['Vendor Day'], loyalty: ['Points Redemption'] },
  counts: { automatic: 1, loyalty: 1, discretionary: 4 },
};

const SEEDED = { overrides: { '$2 GOOGLE REVIEW PRE-ROLL': true, 'Employee Discount': true,
                              'Employee Only | 40% off Apparel': true } };

function fresh() {
  CALLS = []; LOGS = []; FETCHES = [];
  KV = { 'cfg.crewApprover': 'sky', lbGoals: 'https://lb.example/exec',
         discountRules: JSON.stringify(SEEDED) };
  KV_THROWS = ''; LB_REPLY = JSON.parse(JSON.stringify(LB_OK)); LB_HTTP = 200;
  USER = 'sky'; NOTE_RESULT = { ok: true, id: 'n1' }; NOTE_THROWS = '';
}
const read = () => C.incentiveDiscountsRoute_({ token: 't' });
const write = (count, off) => C.incentiveDiscountsRoute_({ token: 't', count: count, off: off });
const coreWrites = () => FETCHES.filter((u) => /action=set_config/.test(u));
const lbWrites = () => FETCHES.filter((u) => /discountrules_save/.test(u));
const storedOverrides = () => {
  const u = coreWrites()[0];
  const m = /[?&]value=([^&]*)/.exec(u);
  return JSON.parse(decodeURIComponent(m[1])).overrides;
};
const byName = (r, n) => (r.discretionary || []).filter((x) => x.name === n)[0];

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

console.log('\nReading: state from GX Core, names from Leaderboard\n');

t('the overrides come from GX Core kv discountRules, not from Leaderboard', () => {
  fresh();
  const r = read();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(CALLS.some((c) => c.fn === 'getKv' && c.args[0] === 'discountRules'), 'Core was never read');
  assert.strictEqual(r.source, 'gx-core');
});

t('where Core and Leaderboard disagree about excluded, CORE WINS', () => {
  fresh();
  const r = read();
  /* LB says these two are counted and the other two are not. Core says the opposite for three of
     them. Reading LB's flags is how the two copies silently drift back apart. */
  assert.strictEqual(byName(r, 'Employee Discount').excluded, true, 'Core says excluded');
  assert.strictEqual(byName(r, '$2 GOOGLE REVIEW PRE-ROLL').excluded, true, 'Core says excluded');
  assert.strictEqual(byName(r, '5 for $20 Gummies, same strain only').excluded, false,
    'Core has no override, so it counts — LB claiming otherwise must not win');
  assert.strictEqual(byName(r, 'Veteran').excluded, false, 'same');
});

t('the NAME list is Leaderboard\'s registry — every discretionary discount, not just the opinionated ones', () => {
  fresh();
  const r = read();
  assert.strictEqual(r.discretionary.length, 4,
    'Core knows 3 names; the registry knows 4. Rendering from Core alone hides the ones nobody has toggled.');
  assert.strictEqual(byName(r, 'Veteran').code, 'VET', 'the code comes across for the UI');
  assert.deepStrictEqual(r.autoExcluded.loyalty, ['Points Redemption']);
  assert.strictEqual(r.partial, false);
});

t('reading never asks Leaderboard to save anything', () => {
  fresh(); read();
  assert.strictEqual(lbWrites().length, 0);
  assert.strictEqual(coreWrites().length, 0);
});

console.log('\nDegrading: Leaderboard down, GX Core still authoritative\n');

t('an unreachable Leaderboard degrades to the names Core holds, flagged partial with a warning', () => {
  fresh(); LB_HTTP = 500;
  const r = read();
  assert.strictEqual(r.ok, true, 'the tray must still open: ' + JSON.stringify(r));
  assert.strictEqual(r.partial, true);
  assert.ok(/not the full list/i.test(r.warning), 'the list is incomplete and must SAY so: ' + r.warning);
  assert.deepStrictEqual(r.discretionary.map((x) => x.name).sort(),
    Object.keys(SEEDED.overrides).sort(), 'shows exactly what Core has an opinion about');
});

t('an absent discountRules key warns rather than quietly showing everything as counted', () => {
  fresh(); delete KV.discountRules;
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.ok(/no discountRules key/i.test(r.warning), r.warning);
  assert.ok(r.discretionary.every((x) => x.excluded === false));
});

t('an UNPARSEABLE discountRules refuses instead of defaulting to "nothing is excluded"', () => {
  fresh(); KV.discountRules = '{not json';
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.ok(/not valid JSON/i.test(r.error), r.error);
});

t('a discountRules of the wrong SHAPE refuses too', () => {
  fresh(); KV.discountRules = '["Employee Discount"]';
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.ok(/overrides/.test(r.error), r.error);
});

console.log('\nWriting: to GX Core, and to nowhere else\n');

t('the write goes to GX Core set_config&key=discountRules', () => {
  fresh();
  const r = write('Employee Discount', '');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(coreWrites().length, 1, 'expected exactly one GX Core write: ' + FETCHES.join('\n'));
  assert.ok(/action=set_config&key=discountRules/.test(coreWrites()[0]), coreWrites()[0]);
});

t('...and NOT to Leaderboard — the app-to-app write hop is gone', () => {
  fresh(); write('Employee Discount', 'Veteran');
  assert.strictEqual(lbWrites().length, 0,
    'something still posts discountrules_save to Leaderboard:\n        ' + FETCHES.join('\n        '));
});

t('the inversion is right: `count` stores false, `off` stores true', () => {
  fresh();
  write('Employee Discount', 'Veteran');
  const o = storedOverrides();
  assert.strictEqual(o['Employee Discount'], false, 'counted means NOT excluded');
  assert.strictEqual(o.Veteran, true, 'not counted means excluded');
});

t('read-merge-write: a name that was not sent keeps its stored value', () => {
  fresh();
  write('Employee Discount', '');
  const o = storedOverrides();
  assert.strictEqual(o['$2 GOOGLE REVIEW PRE-ROLL'], true, 'an untouched rule was reverted');
  assert.strictEqual(o['Employee Only | 40% off Apparel'], true,
    'an override for a discount NOT in the registry was dropped — it still applies to the data');
});

t('a name containing a comma survives the wire', () => {
  fresh();
  write('', '5 for $20 Gummies, same strain only');
  assert.strictEqual(storedOverrides()['5 for $20 Gummies, same strain only'], true);
});

t('multiple names split on a real newline', () => {
  fresh();
  write('Employee Discount\n$2 GOOGLE REVIEW PRE-ROLL', 'Veteran');
  const o = storedOverrides();
  assert.strictEqual(o['Employee Discount'], false);
  assert.strictEqual(o['$2 GOOGLE REVIEW PRE-ROLL'], false);
  assert.strictEqual(o.Veteran, true);
});

t('a literal backslash-n separator is tolerated, not silently treated as one giant name', () => {
  fresh();
  write('Employee Discount\\n$2 GOOGLE REVIEW PRE-ROLL', '');
  const o = storedOverrides();
  assert.strictEqual(o['Employee Discount'], false, 'the old client typo must stay INERT, never pay-affecting');
  assert.strictEqual(o['$2 GOOGLE REVIEW PRE-ROLL'], false);
  assert.ok(!Object.keys(o).some((k) => /\\n/.test(k)), 'a junk key was stored: ' + Object.keys(o).join(' | '));
});

t('a failed Core read refuses the write rather than merging onto {}', () => {
  fresh(); KV_THROWS = 'kv unavailable';
  const r = write('Employee Discount', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(coreWrites().length, 0, 'it wrote anyway — three rules would have switched back on');
});

t('a non-approver cannot change the rules, and writes nothing', () => {
  fresh(); USER = 'mike';
  const r = write('Employee Discount', '');
  assert.strictEqual(r.ok, false);
  assert.ok(/only the approver/i.test(r.error), r.error);
  assert.strictEqual(coreWrites().length, 0);
});

t('an empty save is refused rather than written as "nothing is excluded"', () => {
  fresh();
  const r = write('', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(coreWrites().length, 0);
});

t('the same name sent both ways is refused, not resolved by argument order', () => {
  fresh();
  const r = write('Veteran', 'Veteran');
  assert.strictEqual(r.ok, false);
  assert.ok(/both counted and not counted/i.test(r.error), r.error);
});

t('the OLD save= wire format is refused loudly, not half-honored', () => {
  fresh();
  /* Under the merge, the old "every counted name" payload would set the checked ones and never set
     anything back to excluded — unticking a box would look like it worked and change nothing. */
  const r = C.incentiveDiscountsRoute_({ token: 't', save: 'Employee Discount' });
  assert.strictEqual(r.ok, false);
  assert.ok(/out of date|reload/i.test(r.error), r.error);
  assert.strictEqual(coreWrites().length, 0);
});

t('a successful write hands back the fresh state, so the tray cannot show a stale answer', () => {
  fresh();
  const r = write('Employee Discount', 'Veteran');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'gx-core');
  assert.ok(Array.isArray(r.changed) && r.changed.length === 2, JSON.stringify(r.changed));
  assert.strictEqual(r.saved_by, 'sky');
});

console.log('\nThe audit line — same reason the thresholds have one\n');

t('a rule change files exactly one gxAddNote to core-admin, before and after', () => {
  fresh();
  const r = write('Employee Discount', '');
  assert.strictEqual(r.ok, true);
  const n = CALLS.filter((c) => c.fn === 'gxAddNote');
  assert.strictEqual(n.length, 1, 'no audit note — kv keeps no history, so this is the only record');
  assert.strictEqual(n[0].args[0], 'crew');
  assert.strictEqual(n[0].args[1], 'core-admin');
  assert.ok(/discount rules changed by sky/i.test(n[0].args[2]), n[0].args[2]);
  assert.ok(/not counted/.test(n[0].args[3]) && /counted/.test(n[0].args[3]), n[0].args[3]);
  assert.strictEqual(n[0].args[5], 'fyi');
});

t('a note that THROWS is non-fatal but is reported and logged, never discarded', () => {
  fresh(); NOTE_THROWS = 'gxAddNote is not a function';
  const r = write('Employee Discount', '');
  assert.strictEqual(r.ok, true, 'the rules were already stored — blocking the save would be worse');
  assert.ok(/not a function/.test(r.audit_error || ''), 'swallowed: ' + JSON.stringify(r));
  assert.ok(LOGS.some((l) => /audit note FAILED/i.test(l)), LOGS.join(' | '));
});

t('a note REFUSED with {ok:false} counts as a failure too — it writes nothing and throws nothing', () => {
  fresh(); NOTE_RESULT = { ok: false, error: 'unknown to_app' };
  const r = write('Employee Discount', '');
  assert.ok(/unknown to_app/.test(r.audit_error || ''), JSON.stringify(r));
});

console.log('\nThe source itself\n');

t('no discountrules_save call survives anywhere in the engine', () => {
  assert.ok(!/discountrules_save/.test(CREW_ENGINE),
    'Crew still writes into Leaderboard somewhere');
});

t('crew.js joins the name lists with a REAL newline', () => {
  assert.ok(!/\.join\('\\\\n'\)/.test(CREW_JS.replace(/\/\*[\s\S]*?\*\//g, '')),
    "crew.js is back to join('\\\\n') — a literal backslash-n. The engine tolerates it now, but it " +
    'is the exact typo that wrote EXCLUDED for every discount.');
});

t('crew.js posts count/off and no longer posts save= to incentive_discounts', () => {
  const found = CREW_JS.split("Engine.jsonp('incentive_discounts'").slice(1)
    .map((s) => s.slice(0, 240));
  assert.ok(found.length >= 1, 'the tray no longer calls incentive_discounts at all');
  const saver = found.filter((s) => /\bcount:/.test(s) || /\bsave:/.test(s));
  assert.strictEqual(saver.length, 1, 'expected exactly one save call: ' + saver.length);
  assert.ok(/count:/.test(saver[0]) && /off:/.test(saver[0]), saver[0]);
  assert.ok(!/save:/.test(saver[0]), 'the retired wire format is back: ' + saver[0]);
});

t('every GXCore.* call added here names a function the library exposes', () => {
  const codeOnly = CREW_ENGINE.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const used = Array.from(new Set((codeOnly.match(/GXCore\.[A-Za-z_][A-Za-z0-9_]*/g) || [])
    .map((s) => s.slice('GXCore.'.length))));
  const unknown = used.filter((n) => LIB_SURFACE.indexOf(n) < 0 && n !== 'setKv');
  assert.deepStrictEqual(unknown, [], 'these resolve to undefined in the deployment: ' + unknown.join(', '));
});

console.log(failed ? '\ndiscount rules: ' + failed + ' FAILED\n' : '\ndiscount rules: all passed\n');
process.exit(failed ? 1 : 0);
