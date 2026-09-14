#!/usr/bin/env node
/* ─── Two copies of one pay-period write, running at the same time ─────────────────────────────
 *
 *   RUN:  node tests/pay_period_race_test.js
 *
 * WHY THIS EXISTS (2026-09-14)
 * The hub measured Apps Script /exec calls stalling 18-34s on their FIRST hop — the moment an
 * execution starts — and a stalled request is QUEUED, not dropped. crew.js sends every pay write
 * through gx-client's jsonp() with `retries: 1` or more, and abandoning a JSONP attempt cancels
 * nothing. So attempt 1 stalls past its 45s budget, the client sends attempt 2, and attempt 1 is
 * still going to run. Crew's own engine was checked the same day: eight parallel `health` calls
 * finished within 10ms of each other, so two executions of this script really do overlap.
 *
 * Every route here guarded a SEQUENTIAL replay ("already a closed record", "already sent for
 * approval") and none took a lock, so two executions that both read the state before either wrote
 * both passed. What that did, per route, against the code before this test:
 *
 *   incentive_approve    history rows APPENDED twice — every person listed twice in the frozen
 *                        record the Capstone export reads, so the file doubles everyone's bonus
 *   incentive_send       two approval EMAILS, each with its own token; the first one's link is dead
 *   incentive_return     two "sent back" emails to the preparer
 *   incentive_unapprove  the second copy deletes by row numbers the first already shifted, so it
 *                        deletes ANOTHER PERIOD's paid rows, and voids the period twice
 *   incentive_save       a second inputs row; later saves update the first, the math reads the
 *                        last, so an untick or an override stops taking effect
 *
 * HOW THE INTERLEAVING IS MODELED
 * Apps Script is synchronous, so two executions are modeled by RE-ENTRY: the fake sheet runs
 * execution 2 to completion immediately after execution 1's guard read has returned its values.
 * That is read(1) → read(2) → write(2) → write(1), the exact order that beats a check-then-write.
 * The fake lock cannot wait (one thread), so a second execution that finds it held gets the
 * refusal — the real one waits instead and then meets the re-check, which the SEQUENTIAL half of
 * each section below covers.
 */
'use strict';
const { engine, HIST, WF, INP, VOID } = require('./pay_engine_harness');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const PP = '2026-08-17';

/* ══ incentive_approve ═════════════════════════════════════════════════════════════════════════ */
console.log('\nincentive_approve — two confirmed approvals of one period');
{
  const E = engine(); E.seedClosed();
  E.interleave(HIST, () => E.approve({ pp_start: PP, confirm: 'yes' }));
  const first = E.approve({ pp_start: PP, confirm: 'yes' });
  const people = E.rows(HIST).filter(r => r[0] === PP);
  ok('the second execution really did run between the first one\'s check and its write', !!E.second);
  ok('exactly ONE approval succeeds', [first, E.second].filter(r => r && r.ok).length === 1);
  ok('the frozen record holds each person ONCE (2 rows, not 4) — got ' + people.length, people.length === 2);
  ok('the payroll total in the record is $65, not doubled', people.reduce((a, r) => a + Number(r[14]), 0) === 65);
  ok('one payout PDF filed, not two — got ' + E.pdfs, E.pdfs === 1);
  ok('one approval backup, not two — got ' + E.backups, E.backups === 1);
  const loser = [first, E.second].find(r => r && !r.ok);
  ok('the losing copy says the period was approved, and that nothing was written twice',
     !!loser && /approved/.test(loser.error) && /nothing was written twice/.test(loser.error));
  ok('the Drive filing and the backup happen OUTSIDE the lock', !E.events.includes('pdf:locked'));
  const unlockAt = E.events.lastIndexOf('unlock');
  ok('the sheet is flushed before the lock is released',
     unlockAt > 0 && E.events.slice(0, unlockAt).includes('flush'));
}
{
  /* From the email link: the token check reads the workflow row, and a copy that interleaves
     AFTER that read has passed both guards — the token is only cleared by the write. */
  const E = engine(); E.seedClosed();
  E.wfSet(PP, { status: 'pending', sent_by: 'mike', sent_at: 't', token: 'abc', token_expires: '2099-01-01T00:00:00Z',
                sent_total: '65' });
  let wfReads = 0;
  E.hook = (name, r, nr) => {
    if (name !== WF || r === 1 || r === 'lastRow') return;
    if (++wfReads !== 1) return;
    E.hook = null;
    E.second = E.approve({ pp_start: PP, confirm: 'yes', approve_token: 'abc' });
  };
  const first = E.approve({ pp_start: PP, confirm: 'yes', approve_token: 'abc' });
  ok('the second copy ran after the first had read the token', !!E.second);
  const n = E.rows(HIST).filter(r => r[0] === PP).length;
  ok('via the email link too, each person is frozen ONCE — got ' + n + ' rows', n === 2);
  ok('and exactly one of the two succeeds', [first, E.second].filter(r => r && r.ok).length === 1);
}
{
  const E = engine(); E.seedClosed();
  const a = E.approve({ pp_start: PP, confirm: 'yes' });
  const b = E.approve({ pp_start: PP, confirm: 'yes' });
  ok('SEQUENTIAL replay (already guarded before the lock): first succeeds', a.ok === true);
  ok('the replay is refused as a closed record', b.ok === false && /closed record/.test(b.error));
  ok('and writes nothing', E.rows(HIST).filter(r => r[0] === PP).length === 2);
}

/* ══ incentive_send ════════════════════════════════════════════════════════════════════════════ */
console.log('\nincentive_send — two "Send for approval" executions');
{
  const E = engine(); E.user = 'mike'; E.seedClosed();
  E.wfSet(PP, { status: 'draft', note: 'sent back: fix Two' });     // a period that was returned once
  let wfReads = 0;
  E.hook = (name, r) => {
    if (name !== WF || r === 1 || r === 'lastRow') return;
    if (++wfReads !== 1) return;                                    // the pending check
    E.hook = null;
    E.second = E.send({ pp_start: PP });
  };
  const first = E.send({ pp_start: PP });
  ok('the second send ran after the first had passed the "already pending" check', !!E.second);
  ok('ONE approval email goes out, not two — got ' + E.mails.length, E.mails.length === 1);
  ok('exactly one send reports success', [first, E.second].filter(r => r && r.ok).length === 1);
  const wf = E.wfGet(PP);
  ok('the token in the email is the one on record, so its Approve link works',
     E.mails.length >= 1 && E.mails.every(m => m.html === 'token=' + wf.token));
  ok('the email is sent OUTSIDE the lock', E.mails.every(m => !m.lockHeld));
  const loser = [first, E.second].find(r => r && !r.ok);
  ok('the losing copy says it was already sent and that only one email went',
     !!loser && /already sent for approval/.test(loser.error) && /one email/.test(loser.error));
}
{
  /* The first send of a period, with no workflow row at all — the normal case. wfSet_ APPENDS
     here, so an unguarded pair also leaves two workflow rows for one period. */
  const E = engine(); E.user = 'mike'; E.seedClosed();
  let wfPeeks = 0;
  E.hook = (name, r) => {
    if (name !== WF || r !== 'lastRow') return;
    if (++wfPeeks !== 1) return;                                    // the pending check, on an empty tab
    E.hook = null;
    E.second = E.send({ pp_start: PP });
  };
  E.send({ pp_start: PP });
  ok('the second send ran after the first had found no workflow row at all', !!E.second);
  ok('first-ever send, interleaved: one email — got ' + E.mails.length, E.mails.length === 1);
  ok('and one workflow row for the period — got ' + E.rows(WF).length, E.rows(WF).length === 1);
}
{
  const E = engine(); E.user = 'mike';
  E.send({ pp_start: PP });
  const b = E.send({ pp_start: PP });
  ok('SEQUENTIAL replay is refused as already pending, one email',
     b.ok === false && /already sent/.test(b.error) && E.mails.length === 1);
}

/* ══ incentive_return ══════════════════════════════════════════════════════════════════════════ */
console.log('\nincentive_return — two "send back" executions');
{
  const E = engine();
  E.wfSet(PP, { status: 'pending', sent_by: 'mike', sent_at: 't', token: 'abc' });
  E.interleave(WF, () => E.ret({ pp_start: PP, note: 'Two missed attendance' }));
  const first = E.ret({ pp_start: PP, note: 'Two missed attendance' });
  ok('ONE "sent back" email to the preparer — got ' + E.mails.length, E.mails.length === 1);
  ok('the period ends up draft', E.wfGet(PP).status === 'draft');
  ok('the first copy completes', first.ok === true);
}
{
  const E = engine();
  E.wfSet(PP, { status: 'pending', sent_by: 'mike', sent_at: 't', token: 'abc' });
  E.ret({ pp_start: PP, note: 'x' });
  const b = E.ret({ pp_start: PP, note: 'x' });
  ok('SEQUENTIAL replay is refused as not awaiting approval, one email',
     b.ok === false && E.mails.length === 1);
}

/* ══ incentive_unapprove ═══════════════════════════════════════════════════════════════════════ */
console.log('\nincentive_unapprove — two reopen executions');
function seedTwoPeriods(E) {
  const sh = E.historySheet(PP);
  const row = (pp, id, pay) => { const r = new Array(20).fill(''); r[0] = pp; r[3] = id; r[14] = pay; return r; };
  /* The reopened fortnight first, then two later ones — history is chronological, and reopening an
     older period while newer ones sit below it is exactly when shifted row numbers hit paid rows. */
  const rows = [row('2026-08-03', 'a1', 10), row('2026-08-03', 'a2', 20), row('2026-08-03', 'a3', 30),
                row(PP, 'b1', 40), row(PP, 'b2', 25), row('2026-08-31', 'c1', 15), row('2026-08-31', 'c2', 35)];
  sh.getRange(2, 1, rows.length, 20).setValues(rows);
}
{
  const E = engine();
  seedTwoPeriods(E);
  const reason = 'Levy was paid by hand, recording the override';
  E.interleave(HIST, () => E.unapprove({ pp_start: '2026-08-03', reason, confirm: 'yes' }));
  let threw = null, first;
  try { first = E.unapprove({ pp_start: '2026-08-03', reason, confirm: 'yes' }); } catch (e) { threw = e; }
  const left = E.rows(HIST);
  ok('the reopen did not throw halfway through deleting rows' + (threw ? ' — threw: ' + threw.message : ''), !threw);
  const later = left.filter(r => r[0] === PP || r[0] === '2026-08-31').length;
  ok('the LATER periods\' paid rows all survive (4 rows) — got ' + later, later === 4);
  ok('the reopened period is gone from history', left.filter(r => r[0] === '2026-08-03').length === 0);
  ok('it is voided ONCE (3 rows in the void log, not 6) — got ' + E.rows(VOID).length, E.rows(VOID).length === 3);
}
{
  const E = engine();
  seedTwoPeriods(E);
  const reason = 'Levy was paid by hand, recording the override';
  E.unapprove({ pp_start: '2026-08-03', reason, confirm: 'yes' });
  const b = E.unapprove({ pp_start: '2026-08-03', reason, confirm: 'yes' });
  ok('SEQUENTIAL replay finds nothing to void and deletes nothing',
     b.ok === false && E.rows(HIST).length === 4 && E.rows(VOID).length === 3);
}

/* ══ incentive_save ════════════════════════════════════════════════════════════════════════════ */
console.log('\nincentive_save — a retried attendance tick');
{
  const E = engine(); E.user = 'mike';
  E.save({ pp_start: PP, employee_id: 'e2', att: '1' });          // somebody else is already ticked
  E.interleave(INP, () => E.save({ pp_start: PP, employee_id: 'e1', att: '1' }));
  E.save({ pp_start: PP, employee_id: 'e1', att: '1' });
  const mine = E.rows(INP).filter(r => r[1] === 'e1');
  ok('one inputs row for the person, not two — got ' + mine.length, mine.length === 1);
  /* The consequence that makes a duplicate row a pay bug rather than clutter: saves update the
     FIRST matching row, inputsFor_ reads the LAST, so the untick below would not take effect. */
  E.save({ pp_start: PP, employee_id: 'e1', att: '' });
  ok('a later UNtick is what the math reads', E.inputsFor(PP).e1 && E.inputsFor(PP).e1.att === false);
}
{
  const E = engine(); E.user = 'mike';
  E.save({ pp_start: PP, employee_id: 'e1', att: '1' });
  const b = E.save({ pp_start: PP, employee_id: 'e1', att: '1' });
  ok('SEQUENTIAL replay converges on the same row', b.ok === true && E.rows(INP).length === 1);
}

/* ══ The lock helper itself ════════════════════════════════════════════════════════════════════ */
console.log('\nwithPayLock_');
{
  const E = engine();
  ok('exists', typeof E.withPayLock === 'function');
  if (E.withPayLock) {
    E.lock.held = true;
    let ran = false;
    const r = E.withPayLock(() => { ran = true; return { ok: true }; });
    ok('a lock it cannot get is a clear REFUSAL, not a throw', r && r.ok === false && /nothing was (saved|written)/.test(r.error));
    ok('and the guarded work does not run', ran === false);
    E.lock.held = false;
    let threw = false;
    try { E.withPayLock(() => { throw new Error('boom'); }); } catch (e) { threw = true; }
    ok('an error inside still propagates', threw);
    ok('and the lock is released anyway', E.lock.held === false);
  }
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
