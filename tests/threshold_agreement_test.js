#!/usr/bin/env node
/* ─── Leaderboard is not an incentive source any more — and nothing may pretend it is ─────────────
 *
 *   RUN:  node tests/threshold_agreement_test.js     (no deps, no network)
 *
 * HISTORY, because the file name outlived its first job.
 * This pinned `lb_agrees` as THREE-state — true / false / null-meaning-not-checked — after a boolean
 * reported "Leaderboard disagrees" on every dry run following the 2026-09-01 flip to GX Core, and
 * cost a by-hand diff on 2026-09-03 that found the two schemes byte-identical.
 *
 * On 2026-09-14 Leaderboard retired its incentive engine and Crew deleted everything that read it
 * (Sky's call): the `cfg.incentiveEngine` flag, `fetchLivePerfLeaderboard_`, and the side-by-side
 * `incentive_compare` tool. So there is nothing left that could ever send a scheme to compare.
 *
 * WHAT MUST HOLD NOW:
 *   1. `lb_agrees` is always NULL with a reason — kept, not deleted, so nothing reading it breaks —
 *      and no caller reads it for truthiness (null → false is the original false alarm).
 *   2. A scheme that somehow arrives on the live payload is IGNORED. Approval computes against GX
 *      Core's scheme and nothing else.
 *   3. THE FALLBACK IS GONE. The old `incentiveEngine_` answered `leaderboard` on a blank flag or a
 *      kv read that threw, silently scoring pay on a different engine during a GX Core hiccup.
 *      Performance must come from GX Core whatever `cfg.incentiveEngine` holds or throws.
 *   4. Nothing in the engine can reach Leaderboard's incentive routes.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

let FLAG = 'gxcore', FLAG_THROWS = false, STORED = null, FETCHES = [];

const GXCoreStub = {
  requireAuth: () => ({ ok: true, user: 'sky', role: 'admin' }),
  roleCanEdit: () => true,
  libVersion: () => 300,
  getKv(key) {
    if (key === 'cfg.incentiveEngine') { if (FLAG_THROWS) throw new Error('kv down'); return FLAG; }
    if (key === 'incentiveThresholds') return JSON.stringify(STORED);
    if (key === 'lbGoals') return 'https://lb.example/exec';
    return '';
  },
  getEmployees: () => [],
  getStores: () => [],
};

const stubs = {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getId: () => 'fake' }) },
  DriveApp: {}, HtmlService: {}, ContentService: {},
  UrlFetchApp: { fetch: (url) => { FETCHES.push(url);
    return { getResponseCode: () => 200, getContentText: () => '{"ok":false,"error":"stub"}' }; } },
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
  C = new Function(...names, SRC + '\n; return { approvalThresholds_, deepSame_, fetchLivePerf_ };')(...names.map((n) => stubs[n]));
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

console.log('\nlb_agrees is always null, with a reason\n');

t('no scheme on the payload → null, not disagreement, and the reason says why', () => {
  STORED = clone(SCHEME);
  const r = C.approvalThresholds_({ ok: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.lb_agrees, null, 'must be null — false is the old false alarm');
  assert.ok(/not applicable/i.test(r.lb_check), r.lb_check);
});

t('a scheme that arrives anyway is IGNORED — GX Core\'s is what approval uses', () => {
  STORED = clone(SCHEME);
  const other = clone(SCHEME); other.budtender.discountMaxPct = 2.75;
  const r = C.approvalThresholds_({ ok: true, thresholds: other });
  assert.strictEqual(r.lb_agrees, null);
  assert.strictEqual(r.source, 'gx_core');
  assert.ok(C.deepSame_(r.T, SCHEME), 'approval must compute against Core\'s scheme, never the payload\'s');
});

t('an unreadable Core scheme still refuses', () => {
  STORED = null;
  assert.strictEqual(C.approvalThresholds_({ ok: true }).ok, false);
});

console.log('\nOne source for performance, no fallback\n');

[['flag gxcore', 'gxcore', false], ['flag leaderboard', 'leaderboard', false],
 ['flag blank', '', false], ['flag read THROWS', 'gxcore', true]].forEach(([label, flag, throws]) => {
  t(label + ' → GX Core is asked, Leaderboard never is', () => {
    FLAG = flag; FLAG_THROWS = throws; FETCHES = [];
    C.fetchLivePerf_('2026-08-31');
    assert.ok(FETCHES.length > 0 && FETCHES.every((u) => /action=incentive_perf/.test(u)),
      'fetched: ' + JSON.stringify(FETCHES));
    assert.ok(!FETCHES.some((u) => /lb\.example|incentiveperf/.test(u)), 'reached Leaderboard');
  });
});
FLAG = 'gxcore'; FLAG_THROWS = false;

console.log('\nThe source itself\n');

t('the Leaderboard engine, the flag reader and the compare tool are gone', () => {
  ['fetchLivePerfLeaderboard_', 'incentiveEngine_', 'incentiveCompare_'].forEach((fn) =>
    assert.ok(!new RegExp('function ' + fn + '\\(').test(SRC), fn + ' came back'));
  assert.ok(!/case 'incentive_compare'/.test(SRC), 'the incentive_compare route came back');
  assert.ok(!/getKv\('cfg\.incentiveEngine'\)/.test(SRC), 'cfg.incentiveEngine is read again');
});

t('nothing builds a URL to Leaderboard\'s retired incentive routes', () => {
  assert.ok(!/['"]\?action=(incentiveperf|frozenperiods?|saveincentive|incentive)&/.test(SRC),
    'a Leaderboard incentive route is being called');
});

t('both reporters carry leaderboard_check beside leaderboard_agrees', () => {
  const sites = SRC.match(/leaderboard_agrees\s*:/g) || [];
  const checks = SRC.match(/leaderboard_check\s*:/g) || [];
  assert.strictEqual(checks.length, sites.length,
    'every place that reports the verdict must also report the reason — a bare null coerces to false');
});

t('no caller reads lb_agrees as a plain boolean', () => {
  assert.ok(!/if\s*\(\s*!?\s*\w*\.?lb_agrees\s*\)/.test(SRC),
    'a truthiness test on a null reads as disagreement, which is the old bug back');
});

console.log(fail ? `\n${fail} FAILED\n` : '\nAll threshold-agreement checks passed\n');
process.exit(fail ? 1 : 0);
