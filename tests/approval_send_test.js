#!/usr/bin/env node
/* ─── "Send for approval" — the hand-off that never worked ─────────────────────────────────────
 *
 *   RUN:  node tests/approval_send_test.js
 *
 * WHY THIS EXISTS
 * Sky reported that the approval email was not arriving, tested by him clicking and by Mike
 * clicking. It read as a mail problem — a scope, a quota, a spam folder. It was not: mail was
 * authorized the whole time, with 1,477 sends of quota left.
 *
 * `incentiveSend_` is MIKE's button. It runs `incentiveApprove_` as its dry run to validate the
 * period and total it. But `incentiveApprove_` opened with an APPROVER-ONLY gate, above the
 * confirm split — so the dry run was refused for anybody who is not the named approver, and Mike's
 * click came back "only the named approver can approve — use “Send for approval” instead": an
 * error telling him to press the button he had just pressed. No email, to anyone, ever.
 *
 * Both the gate and the dry-run call arrived in the SAME commit (v1.330, 2026-08-27), so the
 * hand-off has never once worked for the person it was built for.
 *
 * WHAT MUST HOLD, in the order it would cost:
 *
 *   1. A NON-APPROVER CAN DRY-RUN. That is the send path. If this regresses, Mike cannot hand a
 *      period over at all, and the symptom is silence rather than an error anybody reads.
 *   2. A NON-APPROVER STILL CANNOT APPROVE. The gate had to move, not go away — approval is the
 *      immutable write, and letting the preparer approve his own work is the one outcome this
 *      whole workflow exists to prevent.
 *   3. A SEND THAT MAILED NOBODY DOES NOT LEAVE THE PERIOD `pending`. The route refuses a period
 *      that is already pending, so a failed send used to lock it out of ever being re-sent —
 *      recoverable only by break glass.
 *   4. THE ROLLBACK CLEARS THE TOKEN. It is single-use and bound to the total sent; leaving a live
 *      one behind means a later legitimate send mints a second while the first still works.
 *   5. AN UNREADABLE SETTING IS NOT AN UNSET ONE. "No approver is configured" when cfg.crewApprover
 *      reads `sky` sends someone to fix a value that was never wrong.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

/* Pull one top-level function out of Code.gs by brace-matching, the way the other engine-side
   tests do. Reading the shipped source rather than a copy is the point: a test with its own
   transcription of the rule passes while the app is broken. */
function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* The real approver resolution, with GX Core stubbed. `kv` decides what the setting reads;
   throwing from it is the unreachable-Core case. */
function loadApprover(kv) {
  const body = 'var GXCore = { getKv: KV };\n' +
               'var _approverReadFailed_ = false;\n' +
               fnSrc('approverIds_') + '\n' +
               fnSrc('approverUnreadable_') + '\n' +
               fnSrc('noApproverError_') + '\n' +
               'return { ids: approverIds_, unreadable: approverUnreadable_, msg: noApproverError_ };';
  return new Function('KV', body)(kv);
}

console.log('\nWho the approver is');
{
  const A = loadApprover(() => 'sky');
  ok('the configured approver is found', A.ids().join(',') === 'sky');
  ok('and the read is not flagged as failed', A.unreadable() === false);

  const multi = loadApprover(() => 'sky, Mike');
  ok('a comma-separated list is split and lowercased', multi.ids().join(',') === 'sky,mike');

  const unset = loadApprover(() => '');
  ok('genuinely unset yields nobody', unset.ids().length === 0);
  ok('and says so as a SETTING problem',
     /no approver is configured/.test(unset.msg()));
}

console.log('\nAn unreadable setting is not an unset one');
{
  const down = loadApprover(() => { throw new Error('GX Core unreachable'); });
  ok('a failed read still yields nobody (fails CLOSED — nobody wrongly approves)',
     down.ids().length === 0);
  ok('but it is flagged as a read failure', down.unreadable() === true);
  /* The distinction that matters to whoever is reading the error at 5pm: one of these sends you to
     the Command Center to fix a setting, and the other tells you to wait. */
  ok('and it reads as a CONNECTION problem, not a missing setting',
     /connection problem/.test(down.msg()) && !/^no approver is configured/.test(down.msg()));
}

console.log('\nThe gate moved to the write, and did not go away');
{
  /* The guard exactly as it is written in the shipped source — extracted rather than retyped so
     that rewording the condition cannot leave this test passing against the old behaviour. */
  const APPROVE = fnSrc('incentiveApprove_');
  const line = APPROVE.split('\n').find(l => l.includes('!canApprove_(auth)'));
  ok('the approver gate exists at all', !!line);
  ok('and it is conditioned on confirm=yes (the WRITE), not on entry',
     !!line && /confirm[^)]*\)\s*===\s*'yes'\s*&&\s*!canApprove_/.test(line.replace(/\s+/g, ' ')));

  const guard = new Function('p', 'isApprover',
    'return ' + (line.match(/if \((.*)\) \{/) || [])[1]
      .replace(/canApprove_\(auth\)/, 'isApprover') + ';');
  ok('DRY RUN by a non-approver is allowed  (this is Mike sending)',
     guard({}, false) === false);
  ok('dry run by the approver is allowed too', guard({}, true) === false);
  ok('CONFIRMED APPROVAL by a non-approver is REFUSED',
     guard({ confirm: 'yes' }, false) === true);
  ok('confirmed approval by the approver is allowed',
     guard({ confirm: 'yes' }, true) === false);
}

console.log('\nA send that mailed nobody is not a send');
{
  /* wfUnsend_ against a stubbed wfSet_, so what is asserted is the patch it actually writes. */
  let wrote = null;
  const U = new Function('CAPTURE',
    'function wfSet_(pp, patch) { CAPTURE({ pp: pp, patch: patch }); }\n' +
    fnSrc('wfUnsend_') + '\n; return wfUnsend_;')(x => { wrote = x; });

  U('2026-08-17', { status: 'draft', sent_by: '', sent_at: '', note: 'reopened: VOIDED: fix' });
  ok('the period goes back to the status it had', wrote.patch.status === 'draft');
  ok('the single-use token is cleared', wrote.patch.token === '');
  ok('…and so is its expiry', wrote.patch.token_expires === '');
  ok('…and the total it was bound to', wrote.patch.sent_total === '');
  /* A sent-back period carries a reason somebody typed. A failed send must not eat it. */
  ok('a note written by a human is NOT touched', !('note' in wrote.patch));

  U('2026-08-17', null);
  ok('a period with no prior row falls back to draft', wrote.patch.status === 'draft');

  const sent = fnSrc('incentiveSend_');
  ok('the mail-threw path rolls back', /catch \(e\) \{[\s\S]*?wfUnsend_\(pp, wfPrev\)/.test(sent));
  ok('the mailed-nobody path rolls back too',
     /!preview && !mailed\.length\) wfUnsend_\(pp, wfPrev\)/.test(sent));
  ok('and the reported status is not "pending" when nothing was mailed',
     /mailed\.length \? 'pending'/.test(sent));
  /* The rollback is worthless if the refusal it exists to escape is checked against a stale read. */
  ok('the already-pending refusal is still there (this is what made it unrecoverable)',
     /already sent for approval on/.test(sent));
}

console.log('\nThe email states manual adjustments');
{
  /* Sky, 2026-09-02: "maybe the email should note if there were any manual adjustments." Every
     other figure in that email is arithmetic the approver could re-derive; an override is the one
     number a person decided, and Approve is what makes it permanent. */
  const SEND = fnSrc('incentiveSend_');
  const MAIL = fnSrc('wfApprovalEmail_');

  ok('the email renders an overrides block', /pre\.overrides/.test(MAIL));
  ok('…naming each person, not just a count',
     /list\.map\(/.test(MAIL) && /o\.name/.test(MAIL));
  ok('…showing what the math computed alongside what was paid',
     /o\.computed/.test(MAIL) && /o\.paid/.test(MAIL));
  ok('…and carrying the reason that was required at entry', /o\.note/.test(MAIL));
  ok('nothing is rendered when there are no overrides',
     /if \(!list\.length\) return '';/.test(MAIL));

  ok('the real approval path reports its overrides', /overrides: overrides/.test(SRC));
  ok('the preview path reports them too', /overrides: _over/.test(SEND));
}

console.log('\nThe preview must not under-state the total');
{
  /* THE BUG THIS SECTION EXISTS FOR: the preview summed the COMPUTED figure while the real
     approval sums the figure a human recorded, so a $940 fortnight rendered as $915 in the email —
     Laural Nelson's $25, paid at a 1.00% discount and now computing $0 at 1.04%. A preview that
     shows different NUMBERS is worse than one that shows different HTML: it looks like it worked. */
  const SEND = fnSrc('incentiveSend_');
  ok('the preview applies the override through incPayroll_', /incPayroll_\(computed, i\)/.test(SEND));
  ok('…and no longer sums the raw computed payroll',
     !/sp\.budtender \+= c\.payroll/.test(SEND) && !/sp\.manager \+= c\.payroll/.test(SEND));
  /* One applier, not two copies of the rule — the same argument the shared email builder rests on. */
  ok('incPayroll_ is the single applier (the preview does not reimplement it)',
     (SEND.match(/payrollOverride/g) || []).length === 0);

  /* Both paths must agree, since the whole point of a preview is to rehearse the real thing. */
  const APPROVE = fnSrc('incentiveApprove_');
  ok('the approval path applies it the same way', /incPayroll_\(computed, i\)/.test(APPROVE));

  /* The record's columns are positional and HISTORY_HEADERS only ever appends; reading the wrong
     index here would report somebody else's number as a manual adjustment. */
  ok('overrides are read from payroll(14) vs computed_payroll(18) with the note at 19',
     /Number\(r\[14\]\)[^;]*Number\(r\[18\]\)/.test(APPROVE) && /r\[19\]/.test(APPROVE));
}

console.log('\nThe preview says who prepared it');
{
  const SEND = fnSrc('incentiveSend_');
  ok('a dry run no longer reads "prepared by preview"', /'a preview run'/.test(SEND));
  ok('and `as=` can rehearse it as a named person', /p\.as \? String\(p\.as\)/.test(SEND));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
