#!/usr/bin/env node
/* ─── Accepting a new hire must actually add them, or say it didn't ─────────────────────────────
 *
 *   RUN:  node tests/new_hire_accept_test.js     (from the repo root; no deps, no network)
 *
 * WHY THIS EXISTS
 * On 2026-11-11 Mike accepted the nightly scan's "Logan Turney (bend)" new-hire item. Crew called
 * GXCore.gxUpsertEmployee without `create: 1`; GX Core refused an unknown employee_id with
 * {ok:false} (no throw), Crew ignored the answer, recorded "added Logan Turney to the roster" in
 * crew_decisions, and the item was silenced for good. Logan was on nobody's roster for two days and
 * nothing said so.
 *
 * Pinned here: the write asks to create, a refusal or a throw comes back as {ok:false} with the
 * reason, and resolveReview_ returns before recording a decision when either write path is refused.
 */
'use strict';
const fs = require('fs');
const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

let calls = [], answer = null, busts = 0;
const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){}, remove(){}, removeAll(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{ log(){} },
  GXCore:{ resolveStore: () => null,
           gxUpsertEmployee: (p) => { calls.push(p); if (answer instanceof Error) throw answer; return answer; } },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => '', setProperty(){} }) },
  Utilities:{ formatDate: (d) => d.toISOString().slice(0, 10) },
};
const names = Object.keys(stubs);
const C = new Function(...names, SRC +
  '\n; bustRosterCache_ = function () { __bust(); };' +
  '\n; return { addPendingHire_ };')(...names.map(n => stubs[n]));
// eslint-disable-next-line no-undef
globalThis.__bust = () => { busts++; };

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ok  ' + label);
}
const pend = { name_key: 'logan_turney', full_name: 'Logan Turney', home_store: 'bend',
               role_title: 'Budtender', dutchie_employee_id: '45969' };

// ── the write asks GX Core to CREATE ───────────────────────────────────────────────────────────
calls = []; answer = { ok: true, employee_id: 'logan_turney', created: true };
let r = C.addPendingHire_(pend);
eq('a created person is ok', r.ok, true);
eq('the write passes create=1 (the missing flag that lost Logan)', String(calls[0] && calls[0].create), '1');
eq('the write carries the identity', [calls[0].employee_id, calls[0].full_name, calls[0].home_store,
   calls[0].dutchie_employee_id, calls[0].status], ['logan_turney', 'Logan Turney', 'bend', '45969', 'active']);

// ── a refusal is not a throw: it must come back as a failure with the reason ─────────────────────
calls = []; answer = { ok: false, error: 'No employee with employee_id "logan_turney". Pass create=1' };
r = C.addPendingHire_(pend);
eq('a refusal is NOT ok', r.ok, false);
eq('the refusal names the reason', /Pass create=1/.test(r.error), true);
eq('the refusal says nothing was recorded', /nothing recorded/.test(r.error), true);

answer = null;
eq('no answer at all is a failure, not a success', C.addPendingHire_(pend).ok, false);
answer = new Error('lock timeout');
r = C.addPendingHire_(pend);
eq('a throw is a failure with the message', [r.ok, /lock timeout/.test(r.error)], [false, true]);

// ── resolveReview_ records a decision only after a write that said ok ────────────────────────────
const body = (() => {
  const i = SRC.indexOf('function resolveReview_(');
  return SRC.slice(i, SRC.indexOf('\nfunction ', i + 10));
})();
const nh = body.indexOf("item.kind === 'new_hire'"), rec = body.indexOf('sheetOf_(DECISION_TAB');
eq('the new_hire branch returns on a failed add before the decision is written',
   nh > 0 && rec > nh && /if \(!added\.ok\) return/.test(body.slice(nh, rec)), true);
eq('the field-accept branch checks gxUpsertEmployee\'s answer too',
   /var upd = GXCore\.gxUpsertEmployee\(merged\);\s*if \(upd && upd\.ok === false\)/.test(body), true);
eq('there is no bare, unread gxUpsertEmployee call left in resolveReview_',
   /^\s*GXCore\.gxUpsertEmployee\(/m.test(body), false);

if (fail) { console.log(fail + ' FAILED'); process.exit(1); }
console.log('new hire accept: all passed');
