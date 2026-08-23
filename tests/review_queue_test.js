#!/usr/bin/env node
/* ─── Crew review queue: reported items must not outlive their fix ────────────────────────────────
 *
 *   RUN:  node tests/review_queue_test.js     (from the repo root; no deps, no network, no login)
 *
 * WHY THIS EXISTS
 * Filed as bug_mt67on71_calt (2026-08-23, severity high) by Sky, on the first real bug report Crew
 * ever received: "Mike was still showing as Mike and not Michael. I updated his profile, but thought
 * this was going to be done automatically."
 *
 * The identity write had worked. What had not is the QUEUE: a reported item only cleared when it was
 * resolved through resolveReview_, which records a decision. The identity panel is the other — and
 * equally correct — way to fix a name, and it records none, so the item survived its own fix and went
 * on proposing a change that had already been made. An accept at that point is a no-op write, and a
 * queue full of no-ops is a queue people stop reading.
 *
 * The second half is subtler and was in the same four lines: current_value was echoed from the
 * REPORT rather than read from the record, so the item displayed "Mike Kettler" as the current name
 * minutes after it became "Michael Kettler" — a stale value rendered as a measured one, directly
 * beside a proposal to change it.
 *
 * The fail-safe direction is the point of the third block below: when the live value cannot be
 * determined, the item is KEPT. A stale item is something a human can dismiss; a real cross-source
 * disagreement that vanishes on a guess is not recoverable, and this queue is the only place some of
 * them are ever seen.
 */
'use strict';
const fs = require('fs');

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  GXCore:{ resolveStore: () => null },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => '', setProperty(){} }) },
  Utilities:{ formatDate: (d) => d.toISOString().slice(0,10),
              base64Encode: (s) => Buffer.from(s).toString('base64') },
};
const names = Object.keys(stubs);
const C = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
  '\n; return { normSpace_, liveValueFor_, reportedItemSatisfied_ };')(...names.map(n=>stubs[n]));

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ok  ' + label);
}

// ── the field mapping (Core's column names vs the joined row's) ─────────────────────────────────
const mike = { employee_id: 'mike_kettler', name: 'Michael Kettler', role: 'Admin' };
eq('full_name reads the joined row\'s `name`',  C.liveValueFor_(mike, 'full_name'),  'Michael Kettler');
eq('role_title reads the joined row\'s `role`', C.liveValueFor_(mike, 'role_title'), 'Admin');
eq('an unmapped field is "cannot tell", not ""', C.liveValueFor_(mike, 'birthday'), null);
eq('a person no longer on the roster is "cannot tell"', C.liveValueFor_(null, 'full_name'), null);

// ── the suppression rule ────────────────────────────────────────────────────────────────────────
eq('an applied proposal is satisfied — this is the reported bug',
   C.reportedItemSatisfied_('Michael Kettler', 'Michael Kettler'), true);
eq('an unapplied proposal stays open',
   C.reportedItemSatisfied_('Mike Kettler', 'Michael Kettler'), false);
eq('a THIRD value stays open — we cannot assume the proposal is stale',
   C.reportedItemSatisfied_('Mick Kettler', 'Michael Kettler'), false);

// ── fail safe, in both directions ───────────────────────────────────────────────────────────────
eq('unknown live value is NOT satisfied (keep the item)',
   C.reportedItemSatisfied_(null, 'Michael Kettler'), false);
eq('an empty live value is not satisfied by a non-empty proposal',
   C.reportedItemSatisfied_('', 'Michael Kettler'), false);

// ── whitespace, matching what saveIdentity_ collapses on write ──────────────────────────────────
eq('collapses whitespace like the writer does',
   C.reportedItemSatisfied_('Michael  Kettler', 'Michael Kettler'), true);
eq('trims',
   C.reportedItemSatisfied_('  Michael Kettler ', 'Michael Kettler'), true);
eq('case IS a real disagreement and stays open',
   C.reportedItemSatisfied_('michael kettler', 'Michael Kettler'), false);
eq('normSpace_ handles null without throwing', C.normSpace_(null), '');

console.log(fail ? '\n' + fail + ' FAILED' : '\nreview queue: all passed');
process.exit(fail ? 1 : 0);
