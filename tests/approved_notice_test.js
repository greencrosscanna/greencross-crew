#!/usr/bin/env node
/* ─── Approving tells the person who sent the period (2026-09-15) ───────────────────────────────
 *
 *   RUN:  node tests/approved_notice_test.js
 *
 * Sky: "when I hit approve, Mike should get an email saying it has been approved and that he can
 * carry on, nothing is happening." Approving mailed nobody — it had never been built. Runs the real
 * incentive_send → incentive_approve routes through tests/pay_engine_harness.js.
 */
'use strict';
const { engine } = require('./pay_engine_harness');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));
const PP = '2026-08-31';

console.log('\nMike sends, Sky approves');
{
  const E = engine(); E.seedClosed();
  E.user = 'mike';
  const s = E.send({ pp_start: PP, request_id: 'rq-send-notice-000001' });
  ok('the send went out', s.ok && s.status === 'pending');
  const before = E.mails.length;
  E.user = 'sky';
  const r = E.approve({ pp_start: PP, confirm: 'yes', request_id: 'rq-appr-notice-000001' });
  ok('the approval succeeded', r.ok && r.written === 2);
  const m = E.mails.slice(before);
  ok('exactly one email went out on approval — got ' + m.length, m.length === 1);
  ok('it went to the preparer, not the approver', m[0] && m[0].to === 'mike@example.com');
  ok('the subject says approved', m[0] && /^Approved — incentive 2026-08-31$/.test(m[0].subject));
  ok('the body says carry on, who approved it, and the total', m[0] &&
     /carry on/.test(m[0].html) && /sky/.test(m[0].html) && /\$65/.test(m[0].html));
  ok('the body names the next two steps', m[0] && /Print PDF/.test(m[0].html) && /Capstone/.test(m[0].html));
  ok('the response reports who was emailed', r.notified && r.notified.to[0] === 'mike@example.com');
  ok('the email is sent OUTSIDE the pay lock', m[0] && m[0].lockHeld === false);

  const again = E.approve({ pp_start: PP, confirm: 'yes', request_id: 'rq-appr-notice-000001' });
  ok('a late retry of the same click sends no second email', again.already_applied && E.mails.length === before + 1);
}

console.log('\nSky approves directly, nobody sent it');
{
  const E = engine(); E.seedClosed();
  const r = E.approve({ pp_start: PP, confirm: 'yes', request_id: 'rq-appr-notice-000002' });
  ok('the approval succeeded', r.ok);
  ok('no email — nobody is waiting on one', E.mails.length === 0);
  ok('and the response says why rather than looking like a failure',
     r.notified && !r.notified.error && /nobody sent/.test(r.notified.skipped || ''));
}

console.log('\nThe mail fails');
{
  const E = engine(); E.seedClosed();
  E.user = 'mike'; E.send({ pp_start: PP, request_id: 'rq-send-notice-000003' });
  E.user = 'sky';
  const { SRC } = require('./pay_engine_harness');
  // Break the mail for the approval only: the harness's MailApp records into E.mails.
  const r = (function () {
    const orig = E.mails.push;
    E.mails.push = function () { throw new Error('Service invoked too many times'); };
    try { return E.approve({ pp_start: PP, confirm: 'yes', request_id: 'rq-appr-notice-000003' }); }
    finally { E.mails.push = orig; }
  })();
  ok('the approval still succeeds', r.ok && r.written === 2);
  ok('and reports the mail error', r.notified && /too many times/.test(r.notified.error || ''));
  ok('notifyApproved_ is wrapped so it can never throw', /function notifyApproved_[\s\S]*?try \{/.test(SRC));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
