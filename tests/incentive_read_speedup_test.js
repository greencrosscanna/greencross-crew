#!/usr/bin/env node
/* ─── The closed-period screen reads less, and shows exactly what it showed before ────────────────
 *
 *   RUN:            node tests/incentive_read_speedup_test.js
 *   PROVE IT BITES: node scripts/prove-incentive-read-red.js   (mutates a COPY of Code.gs)
 *
 * WHAT CHANGED (2026-10-13). Opening a CLOSED pay period read the history tab twice and asked GX
 * Core for the whole employee registry every time. `getIncentive_` now hands `incentiveHistory_`
 * the history rows it already holds, and the registry list comes from the screen's existing
 * 10-minute cache. An approved PRACTICE period likewise reads its tab once instead of twice.
 *
 * WHAT MUST NOT HAVE CHANGED, and what this file is for: every figure, on every kind of period;
 * and everything about the paths that WRITE — approve, send, reopen — which must go on reading
 * their own fresh data and never a screen's.
 *
 * HOW. The WHOLE shipped Code.gs is loaded into a sandbox over fake Google services and driven
 * through its real router (`doGet`), so the routes, the gates and the sheet reads are the shipped
 * ones. Three comparisons:
 *
 *   1. FAST vs SLOW, always. The same engine with the hand-over withheld (incentiveHistory_ called
 *      the way the deploy-secret route calls it) must answer byte-for-byte the same.
 *   2. BEFORE vs AFTER, when git can show the commit this branch started from. The engine as it
 *      was, loaded the same way and asked the same questions, must answer the same — screens,
 *      store email, and a whole send/approve/reopen with every sheet and email it produces.
 *      SKIPS LOUDLY in a shallow clone; comparison 1 and the read counts do not.
 *   3. A WRITE, THEN THE SCREEN. Approve, reopen and a rename are each followed at once by a load.
 *
 * CODE_GS=/path/to/Code.gs points the "after" side at another copy of the engine.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_NEW = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
/* The commit this change was built on: request timing merged, the read speedup not yet written. */
const BASELINE = '26d9cd9';
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

const { NOW, SECRET, T, EMPLOYEES, STORES, PERIODS, CLOSED, PRACTICE, corePerf, historyRows, world, fnCode } = require('./whole_engine_harness.js');

const HIST = 'crew_incentive_history';
/* Every screen the change could reach, as { label, params, opts }. */
const SCREENS = [
  ['the default screen (the fortnight waiting to be closed)', {}],
  ['the running period', { pp_start: '2026-10-12' }],
  ['the ended, unapproved period', { pp_start: '2026-09-28' }],
  ['a closed period with goals, a scheme and a tick', { pp_start: '2026-09-14' }],
  ['a closed period with none of those', { pp_start: '2026-08-17' }],
  ['a closed period, read-only viewer', { pp_start: '2026-08-31', token: 'T-view' }],
  ['a closed period, the preparer', { pp_start: '2026-09-14', token: 'T-mike' }],
  ['the practice period, not yet approved', { pp_start: PRACTICE }],
  ['a period that does not exist', { pp_start: '2031-01-06' }],
  ['no session at all', { pp_start: '2026-09-14', token: '' }],
];

/* ── 0. The harness is real ─────────────────────────────────────────────────────────────────── */
console.log('\nThe whole shipped engine, through its own router');
{
  const W = world(SRC_NEW);
  const closed = W.get({ action: 'incentive', token: 'T-sky', pp_start: '2026-09-14' });
  ok('a closed period is served as a frozen record, with its people',
     closed.ok === true && closed.source === 'imported' && closed.budtenders.length === 3 && closed.managers.length === 2 && !!closed.admin);
  ok('…with legal names and middle initials joined on', closed.budtenders[0].full_name === 'Beatrice Budd' && closed.budtenders[0].middle_initial === 'Q');
  ok('…with the frozen goals and scheme', closed.managers[0].target === 13000 && closed.thresholds && closed.thresholds.hoursPerPeriod === 80);
  ok('…and the override it was paid on', closed.budtenders[1].payroll === 40 && closed.budtenders[1].computed_payroll === 25);
  const live = W.get({ action: 'incentive', token: 'T-sky' });
  ok('with nothing asked for, it opens on the ended fortnight, live', live.ok === true && live.source === 'live' && live.payPeriod.start === '2026-09-28' && live.defaulted === 'unapproved_previous');
  ok('…with real rows, stamped to the registry', live.budtenders.length === 3 && live.budtenders[0].employee_id === 'bea_bud' && live.budtenders[0].sales > 8000);
  ok('the period list knows which are closed', live.periods.filter((x) => x.source === 'imported').map((x) => x.pp_start).sort().join() === CLOSED.join());
  const prac = W.get({ action: 'incentive', token: 'T-sky', pp_start: PRACTICE });
  ok('the practice period is live, under its own key', prac.ok === true && prac.source === 'live' && prac.payPeriod.start === PRACTICE && !!prac.practice);
  ok('the harness never let the engine create a workbook', W.created === 0);
}

/* ── 1. What it reads now ───────────────────────────────────────────────────────────────────── */
console.log('\nA closed period: one read of the history tab, and the registry from the cache');
{
  const W = world(SRC_NEW);
  const cold = W.count(() => W.screen({ pp_start: '2026-09-14' }));
  ok('the history tab is read ONCE (it was twice): ' + (cold.reads[HIST] || 0), cold.reads[HIST] === 1);
  ok('a cold cache reads the registry once, and keeps it', cold.registry === 1 && W.cache.has(W.g('CORE_EMP_CACHE_KEY')));
  ok('…for the roster cache\'s ten minutes, not longer', W.ttl.get(W.g('CORE_EMP_CACHE_KEY')) === 600);
  const warm = W.count(() => W.screen({ pp_start: '2026-08-17' }));
  ok('the next closed period reads the registry not at all', warm.registry === 0 && warm.reads[HIST] === 1);
  const liveLoad = W.count(() => W.screen({ pp_start: '2026-09-28' }));
  ok('a live period still reads the history tab once, as before', liveLoad.reads[HIST] === 1);

  const S = world(SRC_NEW); S.forceSlow();
  const slow = S.count(() => S.screen({ pp_start: '2026-09-14' }));
  S.screen({ pp_start: '2026-08-17' });
  ok('with the hand-over withheld it is the old cost: two history reads, the registry every time',
     slow.reads[HIST] === 2 && slow.registry === 1 && S.registry === 2 && !S.cache.has(S.g('CORE_EMP_CACHE_KEY')));

  const P = world(SRC_NEW, { practiceApproved: true });
  const pr = P.count(() => P.screen({ pp_start: PRACTICE }));
  const d = JSON.parse(P.screen({ pp_start: PRACTICE }));
  ok('an APPROVED practice period is served frozen', d.source === 'imported' && !!d.practice && d.budtenders.length === 3);
  ok('…and its tab is read ONCE (it was twice): ' + (pr.reads[HIST + '_practice'] || 0), pr.reads[HIST + '_practice'] === 1);
  const st = world(SRC_NEW, { practiceStale: true });
  const stale = JSON.parse(st.screen({ pp_start: PRACTICE }));
  ok('a practice tab holding only an EARLIER rehearsal does not make this one look approved',
     stale.source === 'live' && stale.payPeriod.start === PRACTICE && stale.can_edit === true);
  ok('…while that earlier rehearsal is still served frozen', JSON.parse(st.screen({ pp_start: 'practice-2026-09-14' })).source === 'imported');
  const pu = world(SRC_NEW);
  const un = pu.count(() => pu.screen({ pp_start: PRACTICE }));
  ok('an unapproved practice period still asks its tab once whether it is approved', (un.reads[HIST + '_practice'] || 0) <= 1 && pu.sheets[HIST + '_practice'] !== undefined);
}

console.log('\nWhat that is worth, in this file\'s own clock (each sheet read 600ms, the registry 1500ms)');
{
  const stage = (W) => {
    W.clock.perRead = 600; W.clock.perRegistry = 1500;
    W.get({ action: 'incentive', token: 'T-sky', pp_start: '2026-08-17' });       // warms the cache
    W.cache.forEach((v, k) => { if (/^crewreq:/.test(k)) W.cache.delete(k); });
    W.get({ action: 'incentive', token: 'T-sky', pp_start: '2026-09-14' });
    const r = W.get({ action: 'request_stats', secret: SECRET, hours: '1' });
    const inc = (r.actions || []).find((a) => a.name === 'incentive') || { stages: [] };
    const s = {}; (inc.stages || []).forEach((x) => { s[x.stage] = x.avg_ms; });
    return { total: inc.max_ms, record: s.closed_record };
  };
  const fast = stage(world(SRC_NEW));
  const S = world(SRC_NEW); S.forceSlow();
  const slow = stage(S);
  console.log('    closed_record stage: ' + slow.record + 'ms with the hand-over withheld, ' + fast.record + 'ms with it');
  console.log('    whole request:       ' + slow.total + 'ms → ' + fast.total + 'ms   (a simulated clock — NOT a live measurement)');
  ok('the closed_record stage is recorded, and is the part that got shorter', fast.record > 0 && slow.record - fast.record === 600 + 1500);
  ok('nothing else in the request got longer', slow.total - fast.total === 600 + 1500);
}

/* ── 2. Fast and slow answer the same ───────────────────────────────────────────────────────── */
console.log('\nThe same answer with the hand-over and without it, on every kind of period');
{
  [false, true].forEach((practiceApproved) => {
    const F = world(SRC_NEW, { practiceApproved }), S = world(SRC_NEW, { practiceApproved });
    S.forceSlow();
    SCREENS.forEach(([label, params]) => {
      /* Twice: the first load fills the fast side's cache, the second reads from it. */
      const a1 = F.screen(params), b1 = S.screen(params), a2 = F.screen(params), b2 = S.screen(params);
      ok((practiceApproved ? 'practice approved — ' : '') + label, a1 === b1 && a2 === b2 && a1.length > 30);
    });
    const mail = (W) => JSON.stringify(W.get({ action: 'store_email', secret: SECRET, pp_start: '2026-09-14', show: 'html' }));
    ok((practiceApproved ? 'practice approved — ' : '') + 'the store email for a closed period (the preAuth caller)', mail(F) === mail(S) && /Bend/.test(mail(F)));
  });
}

/* ── 3. Before and after ────────────────────────────────────────────────────────────────────── */
console.log('\nBefore this change and after it (the engine at ' + BASELINE + ' against the shipped one)');
const WRITE_FNS = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_',
                   'perfForWrite_', 'withPayLock_', 'filePayoutPdf_', 'backupCrewSheet_', 'notifyApproved_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'freezeScheme_', 'freezeGoals_', 'wfSet_', 'historySheet_',
                   'applySpiffEarnings_', 'spiffProgressFor_', 'fetchLivePerfFromCore_', 'stampEmployeeIds_', 'approvalThresholds_',
                   'incentiveBlockers_', 'storeTotals_', 'historyBand_', 'historyPeriods_', 'inputsFor_', 'readTab_', 'sheetOf_'];
function fnText(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) return null;
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? src.length : j).replace(/\n\/\*[\s\S]*$/, (m) => (/\*\/\s*$/.test(m) ? '' : m));
}
/* One whole close: Mike sends, Sky looks, Sky approves, a retry lands, Sky reopens. */
function closeScenario(W) {
  const pp = '2026-09-28', ack = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' };
  const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
  const out = [];
  const call = (p) => { const d = W.get(p); delete d.timings; out.push(d); return d; };
  call(Object.assign({ action: 'incentive_approve', token: 'T-mike', pp_start: pp }, ack));
  call(Object.assign({ action: 'incentive_send', token: 'T-mike', pp_start: pp, request_id: rid('S') }, ack));
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp }, ack));
  const done = call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  call({ action: 'incentive', token: 'T-sky' });
  call({ action: 'incentive_unapprove', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('U'),
         reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' });
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  return { out, done, text: JSON.stringify(out), book: W.book(), mails: JSON.stringify(W.mails), fetches: JSON.stringify(W.fetches) };
}
if (!SRC_OLD) {
  skip('screens, store email and a whole close, before against after', 'git cannot show ' + BASELINE + ' here (a shallow clone)');
} else {
  [false, true].forEach((practiceApproved) => {
    const O = world(SRC_OLD, { practiceApproved }), N = world(SRC_NEW, { practiceApproved });
    SCREENS.concat(practiceApproved ? [['the approved practice period', { pp_start: PRACTICE }]] : []).forEach(([label, params]) => {
      /* Twice each: a first load fills caches (the SPIFF copy, the registry list), a second reads them. */
      const o1 = O.screen(params), n1 = N.screen(params), o2 = O.screen(params), n2 = N.screen(params);
      ok((practiceApproved ? 'practice approved — ' : '') + label, o1 === n1 && o2 === n2 && o1.length > 30);
    });
    ['2026-09-14', '2026-09-28', '2026-10-12'].forEach((pp) => {
      const mail = (W) => JSON.stringify(W.get({ action: 'store_email', secret: SECRET, pp_start: pp, show: 'html' })).replace(/<!--spiff-->.*?<!--\/spiff-->/g, '');   // SPIFF section is new since the baseline
      ok((practiceApproved ? 'practice approved — ' : '') + 'the store email for ' + pp, mail(O) === mail(N) && mail(N).length > 200);
    });
    const hist = (W) => JSON.stringify(W.get({ action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14' }));
    ok((practiceApproved ? 'practice approved — ' : '') + 'the deploy-secret incentive_history route', hist(O) === hist(N) && /Beatrice Budd/.test(hist(N)));
  });

  const O = world(SRC_OLD), N = world(SRC_NEW);
  /* Warm the screen's caches on the new side first, so a write path that wrongly read one would show. */
  N.screen({ pp_start: '2026-09-14' }); O.screen({ pp_start: '2026-09-14' });
  const o = closeScenario(O), n = closeScenario(N);
  ok('the scenario really closed a period: rows frozen, then reopened', n.done.ok === true && n.done.written === 6 && n.out[8].ok === true && /"source":"live"/.test(JSON.stringify(n.out[9])));
  ok('send, approve, the retry and the reopen: every reply byte-identical', o.text === n.text);
  ok('every sheet they wrote is byte-identical', o.book === n.book);
  ok('every email they sent is byte-identical (' + JSON.parse(n.mails).length + ' sent)', o.mails === n.mails && JSON.parse(n.mails).length >= 1);
  ok('they made the same live reads of GX Core and SPIFF, in the same order', o.fetches === n.fetches && /incentive_perf/.test(n.fetches) && /action=progress/.test(n.fetches));
  /* CODE, NOT COMMENTS (re-based without moving the baseline). This compares each function's code,
     from `function name(` to the next function, with comments removed (fnCode in the harness). It
     used to compare the raw text, so a comment-only correction in the stretch after inputsFor_ —
     the warmer wording above SNAPSHOT_OPEN_MAX_MIN — failed it while changing nothing that runs.
     The BASELINE commit is deliberately NOT moved forward: comparing against a later commit would
     only say "nothing changed since then", and lose what this line exists to say — that the read
     speedup left the write paths' code alone, measured from before it. The samples below prove the
     comparison still sees code (strings, regexes, values) and ignores only comments;
     scripts/prove-incentive-read-red.js shows a real code change in that stretch still fails it. */
  const moved = WRITE_FNS.filter((f) => fnCode(SRC_OLD, f) !== fnCode(SRC_NEW, f));
  ok('the CODE of all ' + WRITE_FNS.length + ' write-path functions is unchanged (comments aside)' + (moved.length ? ' — CHANGED: ' + moved.join(', ') : ''),
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

/* ── 4. A write, then the screen ────────────────────────────────────────────────────────────── */
console.log('\nA write followed at once by a screen load shows the new state');
{
  const W = world(SRC_NEW);
  const pp = '2026-09-28', ack = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' };
  const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
  /* Everything a screen can cache is warm before the write. */
  W.screen({}); W.screen({ pp_start: '2026-09-14' }); W.screen({ pp_start: pp });
  const before = JSON.parse(W.screen({ pp_start: pp }));
  ok('before: the period is open, and listed as open', before.source === 'live' && before.periods.find((x) => x.pp_start === pp).source === 'live');
  const regBefore = W.registry, fetchBefore = W.fetches.length;
  const done = W.get(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  ok('the approval went through', done.ok === true && done.written === 6);
  ok('…reading the registry and GX Core LIVE, not the screen\'s warm cache', W.registry > regBefore && W.fetches.length > fetchBefore);
  const after = JSON.parse(W.screen({ pp_start: pp }));
  ok('the very next load shows it closed, as paid', after.source === 'imported' && after.can_edit === false && after.budtenders.length === 3);
  ok('…and the period list agrees', after.periods.find((x) => x.pp_start === pp).source === 'imported');
  ok('…with the override that was approved', after.budtenders.find((b) => b.employee_id === 'bo_bud').payroll === 40);
  const dflt = JSON.parse(W.screen({}));
  ok('the default screen has moved on to the running period', dflt.source === 'live' && dflt.payPeriod.start === '2026-10-12');
  ok('a second approval is refused — the screen never offered an approved period as open',
     W.get(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('B') }, ack)).ok === false);

  const re = W.get({ action: 'incentive_unapprove', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('U'),
                     reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' });
  ok('the reopen went through', re.ok === true);
  const reopened = JSON.parse(W.screen({ pp_start: pp }));
  ok('the very next load shows it open again, and says it was reopened', reopened.source === 'live' && reopened.workflow.voided === true &&
     reopened.periods.find((x) => x.pp_start === pp).source === 'live');

  /* The registry list is the one thing here that IS cached. */
  const R = world(SRC_NEW);
  R.screen({ pp_start: '2026-09-14' });
  R.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Beatrice Budd-Smith';
  R.g('bustRosterCache_')();          // what every Crew write to identity or attributes does (roster_cache_bust_coverage_test)
  const renamed = JSON.parse(R.screen({ pp_start: '2026-09-14' }));
  ok('a rename made through Crew shows on the next closed-period load', renamed.budtenders[0].full_name === 'Beatrice Budd-Smith');
  ok('…and no figure moved with it', renamed.budtenders[0].payroll === 65 && renamed.budtenders[0].sales === 8210);
  const X = world(SRC_NEW);
  const first = X.screen({ pp_start: '2026-09-14' });
  X.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Changed Elsewhere';
  const stale = X.screen({ pp_start: '2026-09-14' });
  ok('KNOWN LIMIT, pinned: a rename made OUTSIDE Crew is not seen until the cache ages out', stale === first);
  X.cache.delete(X.g('CORE_EMP_CACHE_KEY'));
  ok('…and is seen the moment it does, with nothing else different',
     X.screen({ pp_start: '2026-09-14' }) === first.split('Beatrice Budd').join('Changed Elsewhere'));
}

/* ── 5. Only the screen gets the hand-over ──────────────────────────────────────────────────── */
console.log('\nOnly the screen gets the hand-over');
{
  const W = world(SRC_NEW);
  W.screen({ pp_start: '2026-09-14' });                 // the cache is warm
  W.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Fresh From Core';
  const c = W.count(() => { W.last = W.get({ action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14' }); });
  ok('the deploy-secret incentive_history route reads the tab and the registry itself, fresh',
     c.reads[HIST] === 1 && c.registry === 1 && W.last.budtenders[0].full_name === 'Fresh From Core');
  const c2 = W.count(() => { W.last = W.get({ action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14', __screen: 'true', rows: '[]', have: '{"__screen":true,"rows":[]}' }); });
  ok('a request cannot supply the hand-over: it still reads fresh, and still finds the period',
     c2.registry === 1 && c2.reads[HIST] === 1 && W.last.ok === true && W.last.budtenders.length === 3);
  const ih = W.g('incentiveHistory_');
  const bad = [{ rows: [] }, { __screen: 'true', rows: [] }, { __screen: true }, { __screen: true, rows: 'x' }, null, true];
  ok('nor can anything but the exact marker AND an array of rows',
     bad.every((have) => { const d = ih({ __internal: true, pp_start: '2026-09-14' }, have); return d.ok === true && d.budtenders.length === 3; }));
  const empty = ih({ __internal: true, pp_start: '2026-09-14' }, { __screen: true, rows: [] });
  ok('rows that do not hold the period answer "no history" — never a half-empty period', empty.ok === false && /no imported history/.test(empty.error));

  const body = (name) => fnText(SRC_NEW, name) || '';
  ok('the router calls incentiveHistory_ with one argument', /case 'incentive_history': return json_\(incentiveHistory_\(p\), p\.callback\);/.test(SRC_NEW));
  const inGet = (body('getIncentive_').match(/\{ __screen: true, rows: /g) || []).length;
  ok('the hand-over is built in getIncentive_ and nowhere else (' + inGet + ' places)',
     inGet === 2 && (SRC_NEW.match(/__screen: *true, rows:/g) || []).length === 2);
  const callers = (SRC_NEW.match(/(?<!function )coreEmployeesCached_\(\)/g) || []).length;
  ok('the cached registry list has exactly two readers: the live screen\'s stamp and the closed screen',
     callers === 2 && /coreEmployeesCached_\(\)/.test(body('stampEmployeeIds_')) && /fromScreen \? coreEmployeesCached_\(\) : null/.test(body('incentiveHistory_')));
  const writers = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'perfForWrite_', 'incentiveGoalsBackfill_'];
  ok('no write path mentions the hand-over, the cached list or the screen\'s snapshot',
     writers.every((f) => body(f) && !/__screen|coreEmployeesCached_|snapshot: *true/.test(body(f))));
  ok('there is no cache of the period list or the to-date totals — the history tab is read every load',
     !/cache\.put\([^)]*(periods|to_date|imported)/i.test(body('getIncentive_')) && /var historyRows = readTab_\(HISTORY_TAB, HISTORY_HEADERS\);/.test(body('getIncentive_')));
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\nincentive read speedup: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
