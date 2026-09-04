#!/usr/bin/env node
/* ─── "Does Leaderboard agree?" is a THREE-way question ────────────────────────────────────────
 *
 *   RUN:  node tests/threshold_agreement_test.js     (no deps, no network)
 *
 * WHY THIS EXISTS
 * `approvalThresholds_` reported `lb_agrees: deepSame_(live.thresholds || null, core)` — a boolean
 * over three possible states. It returns FALSE for "Leaderboard disagrees" and FALSE for "there was
 * nothing to compare", and since 2026-09-01 the second is the only one that ever happens:
 * `cfg.incentiveEngine` was flipped to `gxcore`, so performance comes from GX Core's incentive_perf,
 * and that mapping deliberately carries NO thresholds — Core computes no scheme, Crew reads it from
 * kv. So every dry run since has said "Leaderboard disagrees" about an app it no longer asks.
 *
 * THE COST WAS REAL AND IT WAS NOT THE FLAG'S OWN BUDGET. The claim it makes — the kiosk grading
 * staff against a scheme they are not paid on — is alarming and plausible, so on 2026-09-03 it was
 * reported to Sky as a live problem, then chased through both apps until both schemes were fetched
 * and diffed BY HAND and found byte-identical, discountMaxPct 1.0 included. Nothing was wrong
 * anywhere except this one line. A check that cries wolf is the failure this repo names repeatedly;
 * this is the version where somebody actually went and looked.
 *
 * WHAT MUST HOLD:
 *
 *   1. Nothing to compare is reported as NULL, never as false. This is the bug, exactly.
 *   2. The two reasons for "nothing" are told apart — the engine sends no scheme (structural, every
 *      period, today) versus Leaderboard having no record for one closed period (its documented
 *      `unrecorded` answer for the 28 snapshots that predate scheme-freezing). Same value, opposite
 *      implications: one is a wiring fact, the other is per-period history.
 *   3. A real comparison still happens when a scheme DOES arrive, and still returns false when the
 *      schemes genuinely differ. Fixing a false alarm by never alarming is not a fix — the kiosk
 *      really does hold its own copy.
 *   4. Both reporters carry the reason, so a caller reading only the boolean cannot be silently
 *      misled by a null that coerces to false.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

let ENGINE = 'gxcore';
let STORED = null;

const GXCoreStub = {
  requireAuth: () => ({ ok: true, user: 'sky', role: 'admin' }),
  roleCanEdit: () => true,
  libVersion: () => 300,
  getKv(key) {
    if (key === 'cfg.incentiveEngine') return ENGINE;
    if (key === 'incentiveThresholds') return JSON.stringify(STORED);
    if (key === 'cfg.crewApprover') return 'sky';
    return '';
  },
  getEmployees: () => [],
  getStores: () => [],
};

const stubs = {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getId: () => 'fake' }) },
  DriveApp: {}, HtmlService: {}, ContentService: {},
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{"ok":true}' }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {},
  Logger: { log() {} },
  GXCore: GXCoreStub,
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'test-secret', setProperty() {} }) },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep() {} },
};

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const names = Object.keys(stubs);
let C;
try {
  C = new Function(...names, SRC + '\n; return { approvalThresholds_, deepSame_ };')(...names.map((n) => stubs[n]));
} catch (e) {
  console.error('✗ could not load Code.gs:', e && e.message);
  process.exit(1);
}

const SCHEME = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 0.67, bonus: 100 }, { maxPct: 1, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 }], maxPerStore: 50 },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

let fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); }
                          catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); } };

console.log('\nNothing to compare is NULL, not false\n');

t('the GX Core engine sends no scheme — reported as null, not as disagreement', () => {
  ENGINE = 'gxcore'; STORED = clone(SCHEME);
  const r = C.approvalThresholds_({ ok: true });          // no `thresholds` key at all
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.lb_agrees, null, 'must be null — false is the bug this file exists for');
  assert.ok(/not applicable/i.test(r.lb_check), 'lb_check must say why: ' + r.lb_check);
});

t('...and it still returns GX Core\'s scheme to compute with', () => {
  ENGINE = 'gxcore'; STORED = clone(SCHEME);
  const r = C.approvalThresholds_({ ok: true });
  assert.strictEqual(r.source, 'gx_core');
  assert.ok(C.deepSame_(r.T, SCHEME), 'the scheme approval uses must be unchanged by this fix');
});

t('Leaderboard answering with no scheme is null too — and says so DIFFERENTLY', () => {
  ENGINE = 'leaderboard'; STORED = clone(SCHEME);
  const r = C.approvalThresholds_({ ok: true, thresholds: null, thresholds_source: 'unrecorded' });
  assert.strictEqual(r.lb_agrees, null);
  assert.ok(/Leaderboard sent no scheme/i.test(r.lb_check), r.lb_check);
  assert.ok(/unrecorded/.test(r.lb_check), 'carries LB\'s own label through: ' + r.lb_check);
});

t('the two "nothing to compare" reasons are not the same string', () => {
  ENGINE = 'gxcore'; STORED = clone(SCHEME);
  const viaEngine = C.approvalThresholds_({ ok: true }).lb_check;
  ENGINE = 'leaderboard';
  const viaLb = C.approvalThresholds_({ ok: true, thresholds: null }).lb_check;
  assert.notStrictEqual(viaEngine, viaLb,
    'a wiring fact and a per-period history gap must not read identically');
});

t('a half-written scheme counts as nothing, not as a disagreement', () => {
  ENGINE = 'leaderboard'; STORED = clone(SCHEME);
  const half = { budtender: SCHEME.budtender };      // no manager, no admin
  const r = C.approvalThresholds_({ ok: true, thresholds: half });
  assert.strictEqual(r.lb_agrees, null, 'scoring some rows and not others is worse than not scoring');
});

console.log('\nA real comparison still happens\n');

t('identical schemes agree', () => {
  ENGINE = 'leaderboard'; STORED = clone(SCHEME);
  const r = C.approvalThresholds_({ ok: true, thresholds: clone(SCHEME) });
  assert.strictEqual(r.lb_agrees, true);
  assert.strictEqual(r.lb_check, 'compared');
});

t('a genuinely different scheme still reports FALSE — the check is not neutered', () => {
  ENGINE = 'leaderboard'; STORED = clone(SCHEME);
  const other = clone(SCHEME); other.budtender.discountMaxPct = 2.75;
  const r = C.approvalThresholds_({ ok: true, thresholds: other });
  assert.strictEqual(r.lb_agrees, false, 'this is the condition the indicator exists for');
  assert.strictEqual(r.lb_check, 'compared');
});

t('a one-tier difference deep in the manager scheme is caught', () => {
  ENGINE = 'leaderboard'; STORED = clone(SCHEME);
  const other = clone(SCHEME); other.manager.salesTiers[1].bonus = 201;
  assert.strictEqual(C.approvalThresholds_({ ok: true, thresholds: other }).lb_agrees, false);
});

console.log('\nThe reason travels with the verdict\n');

t('both reporters carry leaderboard_check beside leaderboard_agrees', () => {
  const src = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const sites = src.match(/leaderboard_agrees\s*:/g) || [];
  const checks = src.match(/leaderboard_check\s*:/g) || [];
  assert.ok(sites.length >= 2, 'expected both the approval and the preview reporters');
  assert.strictEqual(checks.length, sites.length,
    'every place that reports the verdict must also report the reason — a bare null coerces to false');
});

t('no caller reads lb_agrees as a plain boolean', () => {
  const src = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  assert.ok(!/if\s*\(\s*!?\s*\w*\.?lb_agrees\s*\)/.test(src),
    'a truthiness test on a three-state value reads null as disagreement, which is the old bug back');
});

console.log(fail ? `\n${fail} FAILED\n` : '\nAll threshold-agreement checks passed\n');
process.exit(fail ? 1 : 0);
