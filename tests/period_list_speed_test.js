#!/usr/bin/env node
/* ─── The incentive screen asks for each thing once — and shows exactly what it showed before ─────
 *
 *   RUN:            node tests/period_list_speed_test.js
 *   PROVE IT BITES: node scripts/prove-period-list-red.js   (mutates a COPY of Code.gs)
 *
 * WHAT WAS SLOW (2026-10-13). The `periods` stage of the incentive screen measured about 1.7s on
 * most loads and 0.3s on some. It was never the list. That stage also held "who is the approver",
 * "who is the backup" and the practice pin — three settings read from GX Core — plus a second read
 * of the workflow tab. GX Core's getKv keeps each setting for 60 SECONDS and, on a miss, reads its
 * whole kv tab. So a load more than a minute after the last one paid three kv-tab reads and a sheet
 * read; a load inside the minute paid the sheet read alone. Section 1 reproduces both figures on a
 * simulated clock, against the engine as it was.
 *
 * WHAT CHANGED. Nothing is cached. Within ONE request the screen now (a) works the pay-period
 * calendar out once instead of up to three times, and (b) judges the backup approver's window on
 * the workflow row it has just read instead of reading the tab again. The stage is also split, so
 * the next reading says which of approver / approval_cover / periods is the slow one, and opening
 * the workbook is timed apart from reading the history tab.
 *
 * WHAT IT COULD NOT FIX FROM HERE. The three cold settings are three reads of one tab, and only GX
 * Core's library can make that one. Section 1 prints what is left.
 *
 * HOW. The WHOLE shipped Code.gs is loaded over fake Google services and driven through its real
 * router (tests/whole_engine_harness.js). The fake getKv behaves as GX Core's does — a 60-second
 * cache per key, a whole-tab read on a miss — and every call is counted, so each saving below is a
 * COUNT the test asserts. The one-store view is the browser filtering this same payload, so it is
 * covered by the payload comparisons; the store email is compared as its own route.
 *
 * BEFORE vs AFTER needs git to show the commit this branch started from, and SKIPS LOUDLY in a
 * shallow clone. FAST vs SLOW (the same engine with each hand-over withheld) and the counts do not.
 *
 * CODE_GS=/path/to/Code.gs points the "after" side at another copy of the engine.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');
const { SECRET, PERIODS, CLOSED, PRACTICE, world, closeScenario, fnCode } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC_NEW = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
/* The commit this change was built on: v1.415, closed periods already reading the history tab once. */
const BASELINE = '076e7bc';
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

const WF = 'crew_incentive_workflow', HIST = 'crew_incentive_history';
const ENDED = '2026-09-28', RUNNING = '2026-10-12';
const MIN = 60000, HOUR = 60 * MIN;
const KEYS = { anchor: 'cfg.payPeriodAnchor', days: 'cfg.payPeriodDays', approver: 'cfg.crewApprover',
               backup: 'cfg.crewBackupApprover', practice: 'cfg.crewPracticePeriod' };

/* Each hand-over withheld: the three helpers are called the way they were before this change. */
const forceSlow = (W) => vm.runInContext(
  'var __ac = approvalCover_; approvalCover_ = function (a, p) { return __ac(a, p); };' +
  'var __pl = periodList_; periodList_ = function (i, l) { return __pl(i, l); };' +
  'var __dp = defaultIncentivePeriod_; defaultIncentivePeriod_ = function (x) { return __dp(x); };', W.sb);

/* The per-stage milliseconds the engine recorded for the last incentive request, read back the way
   gxcrewstats reads them. */
function stagesOf(W, params) {
  W.cache.forEach((v, k) => { if (/^crewreq:/.test(k)) W.cache.delete(k); });
  W.get(Object.assign({ action: 'incentive', token: 'T-sky' }, params));
  const raw = [...W.cache.entries()].filter(([k]) => /^crewreq:\d/.test(k)).map(([, v]) => JSON.parse(v))[0] || {};
  const st = (raw.incentive || { st: {} }).st, out = {};
  Object.keys(st).forEach((k) => { out[k] = st[k].ms; });
  return out;
}

/* ── 1. The diagnosis, reproduced ───────────────────────────────────────────────────────────── */
console.log('\nWhy "periods" was 1.7s and sometimes 0.3s (simulated: a kv-tab read 480ms, a sheet read 260ms)');
{
  const run = (src) => {
    const W = world(src);
    W.clock.perKvTab = 480; W.clock.perRead = 260;
    W.get({ action: 'incentive', token: 'T-sky', pp_start: ENDED });        // somebody has the app open
    W.clock.t += 5 * MIN;                                                   // …and comes back five minutes later
    const cold = stagesOf(W, { pp_start: ENDED });
    W.clock.t += 20000;                                                     // …and again twenty seconds after that
    const warm = stagesOf(W, { pp_start: ENDED });
    return { cold, warm };
  };
  const sum = (s, names) => names.reduce((a, n) => a + (s[n] || 0), 0);
  if (!SRC_OLD) {
    skip('the engine as it was: 3 kv-tab reads + 1 sheet read cold, the sheet read alone warm', 'git cannot show ' + BASELINE + ' here');
  } else {
    const o = run(SRC_OLD);
    console.log('    BEFORE  periods stage: ' + o.cold.periods + 'ms a minute or more after the last load, ' + o.warm.periods + 'ms inside the minute');
    ok('before, cold: three whole reads of GX Core\'s kv tab and a second read of the workflow tab', o.cold.periods === 3 * 480 + 260);
    ok('before, warm: only the second read of the workflow tab', o.warm.periods === 260);
  }
  const n = run(SRC_NEW);
  console.log('    AFTER   approver ' + n.cold.approver + ' + approval_cover ' + n.cold.approval_cover + ' + periods ' + n.cold.periods +
              ' = ' + sum(n.cold, ['approver', 'approval_cover', 'periods']) + 'ms cold;  ' + sum(n.warm, ['approver', 'approval_cover', 'periods']) + 'ms warm');
  console.log('            (a simulated clock — NOT a live measurement)');
  ok('after: the stage is split in three, so the next reading names the slow part',
     ['approver', 'approval_cover', 'periods'].every((k) => typeof n.cold[k] === 'number'));
  ok('after, cold: each of the three is one kv-tab read, and the workflow re-read is gone',
     n.cold.approver === 480 && n.cold.approval_cover === 480 && n.cold.periods === 480);
  ok('after, warm: nothing is left in any of them', sum(n.warm, ['approver', 'approval_cover', 'periods']) === 0);
  ok('WHAT IS LEFT is GX Core\'s: three settings, three whole-tab reads, once a minute', sum(n.cold, ['approver', 'approval_cover', 'periods']) === 3 * 480);
  ok('opening the workbook is timed apart from reading the history tab', typeof n.cold.sheet_open === 'number' && n.cold.history === 260);
}

/* ── 2. The counts ──────────────────────────────────────────────────────────────────────────── */
console.log('\nWhat one load of the screen asks for, counted');
{
  const loadCounts = (src, params, slow) => {
    const W = world(src);
    if (slow) forceSlow(W);
    return W.count(() => W.get(Object.assign({ action: 'incentive', token: 'T-sky' }, params)));
  };
  const cal = (c) => (c.kv[KEYS.anchor] || 0) + (c.kv[KEYS.days] || 0);
  const explicit = loadCounts(SRC_NEW, { pp_start: ENDED }), dflt = loadCounts(SRC_NEW, {});
  const closed = loadCounts(SRC_NEW, { pp_start: '2026-09-14' }), mike = loadCounts(SRC_NEW, { pp_start: ENDED, token: 'T-mike' });
  const shawn = loadCounts(SRC_NEW, { pp_start: ENDED, token: 'T-shawn' });
  /* The SPIFF fold reads the anchor and the length for itself (it is shared with approval and is
     not touched), so a live load asks for each twice: once there, once for the calendar. */
  ok('a live period, asked for by date: the calendar settings are read 4 times (2 for SPIFF, 2 for the one calendar): ' + cal(explicit), cal(explicit) === 4);
  ok('the default screen: still 4 — picking the default no longer builds a calendar of its own: ' + cal(dflt), cal(dflt) === 4);
  ok('a closed period: 2 — one calendar, and no SPIFF fold: ' + cal(closed), cal(closed) === 2);
  ok('the workflow tab is read ONCE on a live load, for the approver: ' + explicit.reads[WF], explicit.reads[WF] === 1);
  ok('…and for the preparer: ' + mike.reads[WF], mike.reads[WF] === 1);
  ok('…and twice for the backup approver, whose own right to decide is still checked fresh: ' + shawn.reads[WF], shawn.reads[WF] === 2);
  ok('the history tab is still read exactly once', explicit.reads[HIST] === 1 && dflt.reads[HIST] === 1 && closed.reads[HIST] === 1);
  ok('the practice pin is asked for once', explicit.kv[KEYS.practice] === 1 && dflt.kv[KEYS.practice] === 1 && closed.kv[KEYS.practice] === 1);

  const sExplicit = loadCounts(SRC_NEW, { pp_start: ENDED }, true), sDflt = loadCounts(SRC_NEW, {}, true);
  const sClosed = loadCounts(SRC_NEW, { pp_start: '2026-09-14' }, true), sShawn = loadCounts(SRC_NEW, { pp_start: ENDED, token: 'T-shawn' }, true);
  ok('with the hand-overs withheld it is the old cost — calendar settings 6 / 8 / 4, workflow tab 2 (3 for the backup)',
     cal(sExplicit) === 6 && cal(sDflt) === 8 && cal(sClosed) === 4 && sExplicit.reads[WF] === 2 && sShawn.reads[WF] === 3);
  console.log('    kv calls for the calendar, before → after:  by date ' + cal(sExplicit) + ' → ' + cal(explicit) +
              ' · default ' + cal(sDflt) + ' → ' + cal(dflt) + ' · closed ' + cal(sClosed) + ' → ' + cal(closed));
  console.log('    workflow-tab reads on a live load:          ' + sExplicit.reads[WF] + ' → ' + explicit.reads[WF] + '   (backup approver ' + sShawn.reads[WF] + ' → ' + shawn.reads[WF] + ')');
  if (!SRC_OLD) skip('the same counts on the engine as it was', 'git cannot show ' + BASELINE + ' here');
  else {
    const o = [loadCounts(SRC_OLD, { pp_start: ENDED }), loadCounts(SRC_OLD, {}), loadCounts(SRC_OLD, { pp_start: '2026-09-14' })];
    ok('the engine as it was really did cost that: calendar settings 6 / 8 / 4, workflow tab 2',
       cal(o[0]) === 6 && cal(o[1]) === 8 && cal(o[2]) === 4 && o[0].reads[WF] === 2);
    const same = (a, b) => JSON.stringify(Object.keys(a.reads).filter((k) => k !== WF).sort().map((k) => [k, a.reads[k]])) ===
                           JSON.stringify(Object.keys(b.reads).filter((k) => k !== WF).sort().map((k) => [k, b.reads[k]]));
    ok('every OTHER sheet is read exactly as often as before, and the registry too',
       same(o[0], explicit) && same(o[1], dflt) && same(o[2], closed) && o[0].registry === explicit.registry && o[2].registry === closed.registry);
    ok('the approver and backup settings are asked for exactly as often as before (they were left alone)',
       [KEYS.approver, KEYS.backup].every((k) => o[0].kv[k] === explicit.kv[k] && o[2].kv[k] === closed.kv[k]));
  }
}

/* ── 3. The same answer ─────────────────────────────────────────────────────────────────────── */
/* Every state the hand-overs could matter in: who is asking, whether the period is waiting on an
   approval, how long it has waited, and whether the approver is away. */
const SCREENS = [
  ['the default screen', {}],
  ['the running period', { pp_start: RUNNING }],
  ['the ended, unapproved period', { pp_start: ENDED }],
  ['a closed period', { pp_start: '2026-09-14' }],
  ['a closed period with no goals or scheme', { pp_start: '2026-08-17' }],
  ['the practice period', { pp_start: PRACTICE }],
  ['a period that does not exist', { pp_start: '2031-01-06' }],
];
const WHO = [['the approver', 'T-sky'], ['the preparer', 'T-mike'], ['the backup approver', 'T-shawn'], ['a viewer', 'T-view'], ['nobody', '']];
const STATES = [
  ['nothing sent', () => {}],
  ['sent for approval a minute ago', (W) => { W.get({ action: 'incentive_send', token: 'T-mike', pp_start: ENDED, request_id: 'rq-S-' + '0'.repeat(20) }); W.clock.t += MIN; }],
  ['sent five hours ago — the backup\'s window is open', (W) => { W.get({ action: 'incentive_send', token: 'T-mike', pp_start: ENDED, request_id: 'rq-S-' + '0'.repeat(20) }); W.clock.t += 5 * HOUR; }],
  ['the approver is away', (W) => { W.props.CREW_APPROVER_AWAY = JSON.stringify({ on: true, by: 'sky', since: '2026-10-13T17:00:00.000Z' }); }],
  ['no backup approver is set', (W) => { delete W.kv['cfg.crewBackupApprover']; }],
  ['no pay-period anchor is set', (W) => { delete W.kv['cfg.payPeriodAnchor']; }],
  ['a practice period is pinned', (W) => { W.kv['cfg.crewPracticePeriod'] = '2026-08-31'; }],
  ['an approved practice period', null, { practiceApproved: true }],
];
function compare(label, mk) {
  STATES.forEach(([state, setup, opts]) => {
    const A = mk.a(opts), B = mk.b(opts);
    if (setup) { setup(A); setup(B); }
    let bad = [], n = 0, sent = 0;
    SCREENS.forEach(([what, params]) => WHO.forEach(([who, token]) => {
      /* Twice: the first load fills the 60-second kv cache and the screen's own, the second reads them. */
      for (let i = 0; i < 2; i++) {
        const p = Object.assign({ token }, params);
        const a = A.screen(p), b = B.screen(p);
        n++;
        if (a !== b || a.length < 30) bad.push(what + ' / ' + who);
        if (/"status":"pending"/.test(a)) sent++;
      }
    }));
    const mail = (W) => JSON.stringify(W.get({ action: 'store_email', secret: SECRET, pp_start: ENDED, show: 'html' })) +
                        JSON.stringify(W.get({ action: 'store_email', secret: SECRET, pp_start: '2026-09-14', show: 'html' })) +
                        JSON.stringify(W.get({ action: 'store_email', secret: SECRET, show: 'html' }));
    const mailsEqual = mail(A) === mail(B);
    ok(label + ' — ' + state + ': ' + n + ' screen loads and 3 store emails identical' + (bad.length ? ' — DIFFERENT: ' + bad.slice(0, 3).join('; ') : ''),
       bad.length === 0 && mailsEqual && (!/^sent /.test(state) || sent > 0));
  });
}
console.log('\nThe same answer with each hand-over and without it');
compare('fast vs slow', { a: (o) => world(SRC_NEW, o), b: (o) => { const W = world(SRC_NEW, o); forceSlow(W); return W; } });

console.log('\nBefore this change and after it (the engine at ' + BASELINE + ' against the shipped one)');
if (!SRC_OLD) skip('every screen, every viewer, every approval state, and the store email', 'git cannot show ' + BASELINE + ' here (a shallow clone)');
else compare('before vs after', { a: (o) => world(SRC_OLD, o), b: (o) => world(SRC_NEW, o) });

/* The cover the screen shows really is exercised in those states — not three ways of saying "no". */
{
  const W = world(SRC_NEW);
  STATES[2][1](W);
  const d = W.get({ action: 'incentive', token: 'T-shawn', pp_start: ENDED });
  ok('the comparison covers a real open backup window (waiting, with the backup able to decide)',
     d.approval_cover.backup_active === true && d.approval_cover.why === 'waiting' && d.can_decide === true && d.approval_cover.as === 'backup');
  const E = world(SRC_NEW);
  STATES[1][1](E);
  const e = E.get({ action: 'incentive', token: 'T-sky', pp_start: ENDED });
  ok('…and a window not yet open, with the time it opens', e.approval_cover.backup_active === false && /^2026-10-13T2/.test(e.approval_cover.backup_at) && e.can_decide === true);
}

/* ── 4. The calendar is the same calendar ───────────────────────────────────────────────────── */
console.log('\nOne calendar answers all three questions, on every date');
{
  const W = world(SRC_NEW);
  const call = (expr) => JSON.stringify(vm.runInContext(expr, W.sb));
  let bad = [], n = 0;
  /* From before the anchor, through its first days, to well past: every date the three differ on. */
  for (let day = -20; day <= 75; day++) {
    W.clock.t = Date.UTC(2026, 7, 17 + day, 19, 0, 0);
    [{}, { '2026-08-17': 1 }, { '2026-08-31': 1, '2026-09-14': 1 }].forEach((importedBy, i) => {
      W.sb.__imp = importedBy;
      n++;
      if (call('defaultIncentivePeriod_(__imp)') !== call('defaultIncentivePeriod_(__imp, computedPeriods_())')) bad.push('default@' + day + '/' + i);
    });
    n++;
    if (call('practiceSourceStart_()') !== call('practiceSourceStart_(computedPeriods_())')) bad.push('practice@' + day);
    n++;
    if (call('periodList_([], null)') !== call('periodList_([], null, computedPeriods_())')) bad.push('list@' + day);
    n++;
    if (call('computedPeriods_(1)') !== call('computedPeriods_().slice(0, 2)') || call('computedPeriods_(2)') !== call('computedPeriods_().slice(0, 3)')) bad.push('prefix@' + day);
  }
  ok(n + ' comparisons across 96 dates: the default period, the practice source and the list are unchanged' + (bad.length ? ' — DIFFERENT: ' + bad.slice(0, 4).join(', ') : ''), bad.length === 0);
  W.kv['cfg.crewPracticePeriod'] = '2026-08-31';
  W.clock.t += 2 * MIN;
  ok('a pinned practice period still wins over the calendar handed in', call('practiceSourceStart_(computedPeriods_())') === '"2026-08-31"');
  delete W.kv['cfg.crewPracticePeriod'];
  delete W.kv['cfg.payPeriodAnchor'];
  W.clock.t += 2 * MIN;
  ok('with no anchor: no periods, no default, no practice — handed a calendar or not',
     call('computedPeriods_()') === '[]' && call('defaultIncentivePeriod_({}, computedPeriods_())') === '""' && call('practiceSourceStart_(computedPeriods_())') === '""');
  ok('anything that is not a calendar is ignored, and the helper works it out itself',
     call('practiceSourceStart_("2026-01-01")') === call('practiceSourceStart_()') && call('defaultIncentivePeriod_({}, { length: 3 })') === call('defaultIncentivePeriod_({})'));
}

/* ── 5. The workflow row in hand ────────────────────────────────────────────────────────────── */
console.log('\nThe backup\'s window is judged on the row the screen just read — and only then');
{
  const W = world(SRC_NEW);
  STATES[2][1](W);                                             // sent five hours ago
  const cover = W.g('approvalCover_'), wfGet = W.g('wfGet_');
  const auth = { ok: true, user: 'shawn', role: 'editor' }, sky = { ok: true, user: 'sky', role: 'admin' };
  const row = wfGet(ENDED);
  const reads = (fn) => { let r; const c = W.count(() => { r = fn(); }); return { r: JSON.stringify(r), n: c.reads[WF] || 0 }; };
  const plain = reads(() => cover(sky, ENDED)), handed = reads(() => cover(sky, ENDED, { __screen: true, wf: row }));
  ok('the same cover, one workflow read fewer', plain.r === handed.r && plain.n === 1 && handed.n === 0 && /"why":"waiting"/.test(handed.r));
  const bPlain = reads(() => cover(auth, ENDED)), bHanded = reads(() => cover(auth, ENDED, { __screen: true, wf: row }));
  ok('for the backup too — whose own right to decide is still read fresh', bPlain.r === bHanded.r && bPlain.n === 2 && bHanded.n === 1);
  const none = reads(() => cover(sky, RUNNING, { __screen: true, wf: null }));
  ok('"no row" (null) is an answer, and is not read again', none.n === 0 && /"backup_active":false/.test(none.r));
  const wrong = [{ wf: row }, { __screen: 'true', wf: row }, { __screen: true }, { __screen: true, wf: 'pending' }, { __screen: true, wf: undefined },
                 { __screen: true, wf: { pp_start: RUNNING, status: 'pending', sent_at: '2020-01-01T00:00:00.000Z' } }, null, true];
  ok('anything else — no marker, a string, a row for ANOTHER period — is ignored and the tab is read',
     wrong.every((have) => { const x = reads(() => cover(sky, ENDED, have)); return x.r === plain.r && x.n === 1; }));
  const req = W.count(() => { W.last = W.get({ action: 'incentive', token: 'T-sky', pp_start: ENDED, __screen: 'true', wf: '{"status":"draft"}', have: '{"__screen":true,"wf":null}' }); });
  ok('a request cannot supply it', W.last.approval_cover.why === 'waiting' && req.reads[WF] === 1);
}

/* ── 6. The write paths ─────────────────────────────────────────────────────────────────────── */
console.log('\nThe paths that write are untouched');
const WRITE_FNS = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_',
                   'perfForWrite_', 'withPayLock_', 'filePayoutPdf_', 'backupCrewSheet_', 'notifyApproved_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'freezeScheme_', 'freezeGoals_', 'wfSet_', 'wfGet_', 'historySheet_',
                   'applySpiffEarnings_', 'spiffProgressFor_', 'fetchLivePerfFromCore_', 'stampEmployeeIds_', 'approvalThresholds_',
                   'incentiveBlockers_', 'storeTotals_', 'historyBand_', 'historyPeriods_', 'inputsFor_', 'readTab_', 'sheetOf_',
                   'canDecide_', 'canApprove_', 'approverIds_', 'backupApproverIds_', 'backupWindow_', 'approverAway_', 'computedPeriods_',
                   /* crewSheetPrepare_ was on this list and came off on 2026-10-13, when the plain-text
                      pin moved from every request to the writer: it legitimately changed, and
                      tests/attr_text_pin_test.js now holds what it must and must not do. */
                   'escalateApprovals_', 'wfApproverEmails_', 'wfBackupEmails_', 'incentiveHistory_', 'crewSheet_'];
function fnText(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) return null;
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? src.length : j).replace(/\n\/\*[\s\S]*$/, (m) => (/\*\/\s*$/.test(m) ? '' : m));
}
if (!SRC_OLD) skip('a whole send, approve, retry and reopen, before against after', 'git cannot show ' + BASELINE + ' here');
else {
  const O = world(SRC_OLD), N = world(SRC_NEW);
  /* Everything a screen can warm is warm on both sides first, so a write that read a screen's copy would show. */
  [O, N].forEach((W) => { W.screen({}); W.screen({ pp_start: ENDED }); W.screen({ pp_start: '2026-09-14' }); });
  const o = closeScenario(O), n = closeScenario(N);
  ok('the scenario really closed a period: sent, approved, retried, reopened',
     n.out[1].status === 'pending' && n.done.ok === true && n.done.written === 6 && n.out[6].already_applied === true && n.reopened.ok === true && n.after.source === 'live');
  ok('every reply byte-identical — the writes and the screens between them', o.text === n.text);
  ok('every sheet byte-identical', o.book === n.book);
  ok('every email byte-identical (' + JSON.parse(n.mails).length + ' sent)', o.mails === n.mails && JSON.parse(n.mails).length >= 2);
  ok('the same live reads of GX Core and SPIFF, in the same order', o.fetches === n.fetches && /incentive_perf/.test(n.fetches) && /action=progress/.test(n.fetches));
  ok('the same locks, writes and flushes, in the same order (' + n.events.length + ' events)',
     JSON.stringify(o.events) === JSON.stringify(n.events) && n.events.filter((e) => e === 'lock').length >= 3 && n.events.indexOf('write:' + HIST) > 0);
  ok('each WRITE request read every sheet, the registry and every setting exactly as often as before', o.writeReads === n.writeReads && n.writeReads.length > 200);
  /* CODE, NOT COMMENTS (re-based without moving the baseline). This compares each function's code,
     from `function name(` to the next function, with comments removed (fnCode in the harness). It
     used to compare the raw text, so a comment-only correction in the stretch after inputsFor_ —
     the warmer wording above SNAPSHOT_OPEN_MAX_MIN — failed it while changing nothing that runs.
     The BASELINE commit is deliberately NOT moved forward: comparing against a later commit would
     only say "nothing changed since then", and lose what this line exists to say — that the
     period-list speedup changed only what it meant to, measured from before it. The samples below
     prove the comparison still sees code (strings, regexes, values) and ignores only comments;
     scripts/prove-period-list-red.js shows a real code change in that stretch still fails it. */
  const moved = WRITE_FNS.filter((f) => fnCode(SRC_OLD, f) !== fnCode(SRC_NEW, f));
  ok('the CODE of all ' + WRITE_FNS.length + ' functions the write paths run is unchanged (comments aside)' + (moved.length ? ' — CHANGED: ' + moved.join(', ') : ''),
     moved.length === 0 && WRITE_FNS.every((f) => fnCode(SRC_NEW, f)));
}
{
  /* The comparator itself: blind to comments, never to code. */
  const f = (body) => fnCode('\nfunction f_(s) {' + body + '}\nfunction g_() {}', 'f_');
  ok('the code comparison ignores a comment edit, and sees a code edit, a string edit and a regex edit',
     f(' /* every 15 minutes */ var x = 20;\n') === f(' /* every 5\n   minutes */ var x = 20; // note\n') &&
     f(' var x = 20; ') !== f(' var x = 21; ') &&
     f(" var u = 'https://a/*b'; ") !== f(" var u = 'https://a/*c'; ") &&
     f(' return /["\']\\/\\*/.test(s) && 1; ') !== f(' return /["\']\\/\\*/.test(s) && 2; ') &&
     f(' var t = a / b / c; ') !== f(' var t = a / b / d; '));
  const stretch = SRC_NEW.indexOf('\nfunction inputsFor_(');
  const commentEdit = SRC_NEW.slice(0, stretch) + SRC_NEW.slice(stretch).replace('by its warmer', 'by its WARMER, reworded');
  const codeEdit = SRC_NEW.replace('var SNAPSHOT_OPEN_MAX_MIN = 20;', 'var SNAPSHOT_OPEN_MAX_MIN = 21;');
  ok('on the real file: rewording the comment after inputsFor_ leaves its code the same; changing the limit beside it does not',
     commentEdit !== SRC_NEW && fnCode(commentEdit, 'inputsFor_') === fnCode(SRC_NEW, 'inputsFor_') &&
     codeEdit !== SRC_NEW && fnCode(codeEdit, 'inputsFor_') !== fnCode(SRC_NEW, 'inputsFor_'));
}
{
  const body = (name) => fnText(SRC_NEW, name) || '';
  const writers = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'perfForWrite_', 'canDecide_', 'escalateApprovals_', 'incentivePracticeReset_'];
  ok('no write path passes a calendar or a workflow row in hand',
     writers.every((f) => body(f) && !/__screen|periodList_\(|defaultIncentivePeriod_\(|approvalCover_\(/.test(body(f))));
  ok('canDecide_ — what approve and send-back ask — still reads the workflow row itself', /var w = backupWindow_\(pp\);/.test(body('canDecide_')));
  ok('the hand-overs are built in getIncentive_ and nowhere else',
     (SRC_NEW.match(/\{ __screen: true, wf: wfRow \}/g) || []).length === 1 && /\{ __screen: true, wf: wfRow \}/.test(body('getIncentive_')) &&
     (SRC_NEW.match(/approvalCover_\([^)]*,[^)]*,[^)]*\)/g) || []).filter((m) => !/^approvalCover_\(auth, pp, have\)$/.test(m)).length === 1 &&
     (SRC_NEW.match(/, cal\(\)\)/g) || []).length === (body('getIncentive_').match(/, cal\(\)\)/g) || []).length);
  ok('the calendar is a local of one call — nothing outlives the request',
     /\n  var _cal = null;\n  var cal = function \(\) \{ return _cal \|\| \(_cal = computedPeriods_\(\)\); \};/.test(body('getIncentive_')) && !/\nvar _cal\b/.test(SRC_NEW));
  ok('nothing here is a cache: getIncentive_, periodList_ and approvalCover_ never touch CacheService or a script property',
     ['getIncentive_', 'periodList_', 'approvalCover_', 'defaultIncentivePeriod_', 'practiceSourceStart_'].every((f) => !/CacheService|setProperty/.test(body(f))));
}

/* ── 7. A write, then the screen ────────────────────────────────────────────────────────────── */
console.log('\nA write followed at once by a screen load shows the new state');
{
  const W = world(SRC_NEW);
  const ack = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' }, rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
  const load = (params) => JSON.parse(W.screen(params));
  W.screen({}); W.screen({ pp_start: ENDED }); W.screen({ pp_start: '2026-09-14' });       // everything warm
  const src = (d, pp) => (d.periods.find((x) => x.pp_start === pp) || {}).source;
  ok('before: open, listed as open, and the default screen', load({}).payPeriod.start === ENDED && src(load({ pp_start: ENDED }), ENDED) === 'live');

  ok('Mike sends it', W.get({ action: 'incentive_send', token: 'T-mike', pp_start: ENDED, request_id: rid('S') }).status === 'pending');
  const sent = load({ pp_start: ENDED });
  ok('the very next load shows it pending and locked, with the backup\'s clock started',
     sent.workflow.status === 'pending' && sent.can_edit === false && sent.approval_cover.backup_active === false && !!sent.approval_cover.backup_at);

  ok('Sky approves it', W.get(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: ENDED, confirm: 'yes', request_id: rid('A') }, ack)).written === 6);
  const closed = load({ pp_start: ENDED });
  ok('the very next load shows it closed, as paid — in the payload and in the period list', closed.source === 'imported' && src(closed, ENDED) === 'imported' && closed.can_edit === false);
  const dflt = load({});
  ok('the default screen has moved on to the running period, which lists the closed one as closed', dflt.payPeriod.start === RUNNING && src(dflt, ENDED) === 'imported');
  ok('a second approval is refused', W.get(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: ENDED, confirm: 'yes', request_id: rid('B') }, ack)).ok === false);

  ok('Sky reopens it', W.get({ action: 'incentive_unapprove', token: 'T-sky', pp_start: ENDED, confirm: 'yes', request_id: rid('U'),
                               reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' }).ok === true);
  const re = load({ pp_start: ENDED });
  ok('the very next load shows it open again, reopened, and the default screen is back on it',
     re.source === 'live' && re.workflow.voided === true && src(re, ENDED) === 'live' && load({}).payPeriod.start === ENDED);

  W.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Beatrice Budd-Smith';
  W.g('bustRosterCache_')();
  ok('a rename made through Crew shows on the next load, live and closed',
     load({ pp_start: ENDED }).budtenders[0].full_name === 'Beatrice Budd-Smith' && load({ pp_start: '2026-09-14' }).budtenders[0].full_name === 'Beatrice Budd-Smith');

  W.props.CREW_APPROVER_AWAY = JSON.stringify({ on: true, by: 'sky', since: '2026-10-13T18:00:00.000Z' });
  ok('the away switch shows on the next load (it is a script property, read every time)', load({ pp_start: ENDED }).approval_cover.backup_active === true);
}

/* ── 8. The stage marks ─────────────────────────────────────────────────────────────────────── */
console.log('\nWhat gxcrewstats will show next');
{
  const W = world(SRC_NEW);
  const live = Object.keys(stagesOf(W, { pp_start: ENDED })).sort().join(',');
  ok('a live load: ' + live, ['sheet_open', 'history', 'approver', 'approval_cover', 'periods', 'workflow', 'inputs'].every((s) => live.split(',').indexOf(s) >= 0));
  const closed = Object.keys(stagesOf(W, { pp_start: '2026-09-14' })).sort().join(',');
  ok('a closed load: ' + closed, ['sheet_open', 'history', 'closed_record', 'periods', 'approver', 'approval_cover', 'closed_extras'].every((s) => closed.split(',').indexOf(s) >= 0));
  const t = W.get({ action: 'incentive', token: 'T-sky', pp_start: ENDED }).timings;
  ok('the payload\'s own timings carry the same split', ['sheet_open', 'approver', 'approval_cover', 'periods'].every((k) => typeof t[k] === 'number'));
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\nperiod list speed: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
