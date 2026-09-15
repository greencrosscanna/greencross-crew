#!/usr/bin/env node
/* ─── A stalled pay write that lands AFTER somebody acted on its twin ───────────────────────────
 *
 *   RUN:  node tests/pay_request_id_test.js
 *   PROVE IT BITES:  CODE_GS=<Code.gs from before request ids> node tests/pay_request_id_test.js
 *
 * pay_period_race_test.js covers two copies of one write running AT THE SAME TIME, which the lock
 * stops. This covers what a lock cannot: attempt 1 stalls, attempt 2 lands, a person then acts on
 * what attempt 2 did — and attempt 1 finally runs. By then every guard has a different answer:
 *
 *   approve  → reopen   → the stalled approve   froze the figures AGAIN
 *   tick     → untick   → the stalled tick      RE-TICKED ($40 back on payroll)
 *   send     → send back → the stalled send     mailed a second approval request
 *   return   → re-send  → the stalled return    sent the NEW send back too
 *   reopen   → approve  → the stalled reopen    voided the NEW approval
 *
 * Each case replays the SAME request_id after the intervening action and asserts nothing moved.
 * Against the engine from before request ids (commit 17391c1), every one of them fails.
 *
 * The replay is also run with the script cache EMPTIED: CacheService may evict whenever it likes,
 * so the guard that counts is the record in the sheet, read under the lock.
 */
'use strict';
const fs = require('fs');
const { engine, HIST, WF, INP, VOID } = require('./pay_engine_harness');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const PP = '2026-08-17';
const REQ = 'crew_pay_requests';
const REASON = 'Levy was paid by hand, recording the override';
const id = n => ('req' + n + '0000000000000000').slice(0, 24);
const forPP = (E, tab) => E.rows(tab).filter(r => r[0] === PP);
const approvalMails = E => E.mails.filter(m => /^Approve incentive/.test(m.subject || '')).length;
const returnMails = E => E.mails.filter(m => /sent back/.test(m.subject || '')).length;

for (const evict of [false, true]) {
  const how = evict ? ' (script cache evicted before the replay)' : '';
  const maybeEvict = E => { if (evict) E.cache.clear(); };

  console.log('\nincentive_approve — approve, reopen, then the stalled approve lands' + how);
  {
    const E = engine(); E.seedClosed();
    const first = E.approve({ pp_start: PP, confirm: 'yes', request_id: id('A') });
    const reopen = E.unapprove({ pp_start: PP, reason: REASON, confirm: 'yes', request_id: id('U') });
    maybeEvict(E);
    const late = E.approve({ pp_start: PP, confirm: 'yes', request_id: id('A') });
    ok('the approval and the reopen both went through', first.ok === true && reopen.ok === true);
    ok('the reopened period stays reopened — nothing re-frozen (0 rows) — got ' + forPP(E, HIST).length,
       forPP(E, HIST).length === 0);
    ok('still exactly one payout PDF and one backup', E.pdfs === 1 && E.backups === 1);
    ok('the late copy is told "already done", not an error',
       late.ok === true && late.already_applied === true && late.request_id === id('A'));
    ok('and carries the first answer, so the screen can say what happened',
       late.written === 2 && late.pp_start === PP);
    ok('the period is still draft', E.wfGet(PP).status === 'draft');
    ok('the late answer says where the period is NOW (draft), not what it was (approved)',
       late.status === 'draft' && late.now && late.now.status === 'draft');
  }

  console.log('\nincentive_save — tick, untick, then the stalled tick lands' + how);
  {
    const E = engine(); E.user = 'mike';
    E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('T') });
    E.save({ pp_start: PP, employee_id: 'e1', att: '', request_id: id('X') });
    maybeEvict(E);
    const late = E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('T') });
    ok('the untick is what the math reads — got att=' + (E.inputsFor(PP).e1 || {}).att,
       E.inputsFor(PP).e1 && E.inputsFor(PP).e1.att === false);
    ok('one inputs row for the person', forPP(E, INP).filter(r => r[1] === 'e1').length === 1);
    ok('the late tick is answered as already applied', late.ok === true && late.already_applied === true);
    ok('and carries the person\'s inputs as they are NOW (unticked), so the screen shows the truth',
       late.now && late.now.inputs && late.now.inputs.att === false);
  }

  console.log('\nincentive_att_batch — import, hand-edit a tick, then the stalled import lands' + how);
  {
    const E = engine(); E.user = 'mike';
    if (!E.attBatch) { fail++; console.log('  ✗ incentive_att_batch is not in Code.gs'); }
    else {
      /* ONE id for the WHOLE list, not one per person — which is the point. Mike imports the file,
         then unticks somebody by hand because the list was wrong about them. The stalled copy of
         the import must not put the file's answer back on that one person. */
      const first = E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('BA') });
      E.save({ pp_start: PP, employee_id: 'e1', att: '', request_id: id('BX') });
      maybeEvict(E);
      const late = E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('BA') });
      ok('the import went through first', first.ok === true && first.count === 2);
      ok('the hand untick is what the math reads — NOT re-ticked by the stalled import',
         E.inputsFor(PP).e1 && E.inputsFor(PP).e1.att === false);
      ok('the person the hand edit did not touch keeps the file\'s answer',
         E.inputsFor(PP).e2 && E.inputsFor(PP).e2.att === true);
      ok('one inputs row each, still', forPP(E, INP).length === 2);
      ok('the late import is answered as already applied, not as an error',
         late.ok === true && late.already_applied === true && late.request_id === id('BA'));
      ok('and carries the first answer, so the screen can say who was written',
         Array.isArray(late.saved) && late.saved.length === 2);
      ok('it reports the period\'s inputs as they stand NOW, so the screen shows the untick',
         late.now && late.now.inputs_by_id && late.now.inputs_by_id.e1 &&
         late.now.inputs_by_id.e1.att === false);
    }
  }

  console.log('\nincentive_att_batch — import, APPROVE, then the stalled import lands' + how);
  {
    const E = engine(); E.seedClosed(); E.user = 'mike';
    if (E.attBatch) {
      E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('BB') });
      E.user = 'sky';
      E.approve({ pp_start: PP, confirm: 'yes', request_id: id('BC') });
      maybeEvict(E);
      E.user = 'mike';
      const late = E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('BB') });
      /* Either way, the thing that matters holds: nothing is written into the closed period. */
      ok('the closed record is untouched (2 rows)', forPP(E, HIST).length === 2);
      if (!evict) {
        /* The cached hint is read ABOVE the guards, exactly as the per-person save reads it: the
           import really did land, and answering "that period is closed" would send Mike to re-run
           a file that is already written. */
        ok('the late import is told it already happened, not that the period is closed',
           late.ok === true && late.already_applied === true && !/closed/.test(String(late.error || '')));
      } else {
        /* THE LIMIT, and it is the per-person save's too. CacheService may evict whenever it
           likes; the authoritative record is read INSIDE the lock, which is below the closed-period
           guard. So an evicted replay of a batch whose period has since been approved is refused
           rather than replayed. It writes nothing either way — the cost is a confusing message,
           not a wrong row — and moving the sheet read above the guards would mean a sheet read on
           every request that carries an id. */
        ok('LIMIT: with the cache evicted the late import is refused as closed, and still writes nothing',
           late.ok === false && /closed/.test(late.error));
      }
    }
  }
  {
    /* A BATCH THAT WAS REFUSED under the lock stays refused. */
    const E = engine(); E.user = 'mike';
    if (E.attBatch) {
      E.canEdit = false;
      const refused = E.attBatch({ pp_start: PP, att: 'e1:1', request_id: id('BD') });
      E.canEdit = true;
      ok('a read-only batch is refused', refused.ok === false);
      /* That refusal is decided BEFORE the lock, so it is the documented limit, not a bug: the
         late copy is decided afresh against whatever the session is then. */
      const late = E.attBatch({ pp_start: PP, att: 'e1:1', request_id: id('BD') });
      ok('LIMIT: a pre-lock refusal is not remembered — the late copy is decided afresh',
         late.ok === true && !late.already_applied);
    }
  }

  console.log('\nincentive_send — send, send back, then the stalled send lands' + how);
  {
    const E = engine(); E.seedClosed(); E.user = 'mike';
    const sent = E.send({ pp_start: PP, request_id: id('S') });
    E.user = 'sky';
    E.ret({ pp_start: PP, note: 'Two missed attendance', request_id: id('R') });
    maybeEvict(E);
    E.user = 'mike';
    const late = E.send({ pp_start: PP, request_id: id('S') });
    ok('the send went through first', sent.ok === true && sent.status === 'pending');
    ok('ONE approval email, not two — got ' + approvalMails(E), approvalMails(E) === 1);
    ok('the period stays sent back (draft) — got ' + E.wfGet(PP).status, E.wfGet(PP).status === 'draft');
    ok('the returned note is not wiped by a second send', /missed attendance/.test(E.wfGet(PP).note));
    ok('the late send is answered as already applied', late.ok === true && late.already_applied === true);
    ok('THE WRINKLE: it no longer says "pending" about a period that was sent back — status ' + late.status +
       ', status_then ' + late.status_then, late.status === 'draft' && late.status_then === 'pending' &&
       /draft now/.test(late.replay_note));
  }

  console.log('\nincentive_return — send back, send again, then the stalled send-back lands' + how);
  {
    const E = engine(); E.seedClosed(); E.user = 'mike';
    E.send({ pp_start: PP, request_id: id('S1') });
    E.user = 'sky';
    E.ret({ pp_start: PP, note: 'Two missed attendance', request_id: id('R1') });
    E.user = 'mike';
    E.send({ pp_start: PP, request_id: id('S2') });
    const tokenNow = E.wfGet(PP).token;
    maybeEvict(E);
    E.user = 'sky';
    const late = E.ret({ pp_start: PP, note: 'Two missed attendance', request_id: id('R1') });
    ok('the second send stays pending — got ' + E.wfGet(PP).status, E.wfGet(PP).status === 'pending');
    ok('its approval link still works (token untouched)', !!tokenNow && E.wfGet(PP).token === tokenNow);
    ok('ONE "sent back" email — got ' + returnMails(E), returnMails(E) === 1);
    ok('the late send-back is answered as already applied', late.ok === true && late.already_applied === true);
    ok('and reports the period as pending again — which it is', late.status === 'pending' && late.status_then === 'draft');
  }

  console.log('\nincentive_unapprove — reopen, re-approve, then the stalled reopen lands' + how);
  {
    const E = engine(); E.seedClosed();
    E.approve({ pp_start: PP, confirm: 'yes', request_id: id('A1') });
    E.unapprove({ pp_start: PP, reason: REASON, confirm: 'yes', request_id: id('U1') });
    E.approve({ pp_start: PP, confirm: 'yes', request_id: id('A2') });
    maybeEvict(E);
    const late = E.unapprove({ pp_start: PP, reason: REASON, confirm: 'yes', request_id: id('U1') });
    ok('the NEW approval survives (2 rows frozen) — got ' + forPP(E, HIST).length, forPP(E, HIST).length === 2);
    ok('voided once, not twice (2 rows in the void log) — got ' + forPP(E, VOID).length, forPP(E, VOID).length === 2);
    ok('the period still reads approved', E.wfGet(PP).status === 'approved');
    ok('the older closed period is untouched', E.rows(HIST).filter(r => r[0] === '2026-08-03').length === 1);
    ok('the late reopen is answered as already applied', late.ok === true && late.already_applied === true);
    ok('and reports the period as approved, which it is again', late.status === 'approved');
  }

  console.log('\na refusal decided under the lock is remembered too' + how);
  {
    /* Sky presses "send back" on a period that is not pending — refused, under the lock. Mike then
       sends it. The stalled copy of Sky's refused click must not now send Mike's send back. */
    const E = engine(); E.seedClosed(); E.user = 'sky';
    const refused = E.ret({ pp_start: PP, note: 'Two missed attendance', request_id: id('R1') });
    E.user = 'mike';
    E.send({ pp_start: PP, request_id: id('S1') });
    maybeEvict(E);
    E.user = 'sky';
    const late = E.ret({ pp_start: PP, note: 'Two missed attendance', request_id: id('R1') });
    ok('the send-back was refused at the time', refused.ok === false && /not awaiting approval/.test(refused.error));
    ok('the stalled copy does not send the new send back — still pending', E.wfGet(PP).status === 'pending');
    ok('no "sent back" email', returnMails(E) === 0);
    ok('it gets the same refusal back, marked as a replay',
       late.ok === false && late.already_applied === true && /not awaiting approval/.test(late.error));
  }
  {
    /* THE LIMIT, pinned so nobody believes otherwise. A refusal returned BEFORE the lock (auth, a
       missing field, "already a closed record" on the first read, a blocker) is not recorded:
       nothing was decided that could change, and recording it would mean a sheet write for every
       refused request. Such a click, if its stalled copy lands after the state has moved, is
       decided afresh. */
    const E = engine(); E.seedClosed(); E.user = 'mike';
    E.send({ pp_start: PP, request_id: id('S1') });
    const refused = E.send({ pp_start: PP, request_id: id('S2') });     // already pending: pre-lock
    E.user = 'sky';
    E.ret({ pp_start: PP, note: 'Two missed attendance', request_id: id('R') });
    maybeEvict(E);
    E.user = 'mike';
    const late = E.send({ pp_start: PP, request_id: id('S2') });
    ok('LIMIT: a pre-lock refusal is not remembered — the late copy is decided afresh',
       refused.ok === false && late.ok === true && !late.already_applied);
  }
}

console.log('\na replay with nothing in between still reads as done');
{
  const E = engine(); E.seedClosed(); E.user = 'mike';
  E.send({ pp_start: PP, request_id: id('S') });
  const late = E.send({ pp_start: PP, request_id: id('S') });
  ok('status now and status then agree (pending)', late.status === 'pending' && late.status_then === 'pending');
}

console.log('\nno id, bad ids, and different ids');
{
  const E = engine(); E.seedClosed();
  E.approve({ pp_start: PP, confirm: 'yes' });
  E.unapprove({ pp_start: PP, reason: REASON, confirm: 'yes' });
  const again = E.approve({ pp_start: PP, confirm: 'yes' });
  ok('with NO request id (deploy-secret tooling, an older open tab) behavior is unchanged',
     again.ok === true && !again.already_applied && forPP(E, HIST).length === 2);
  ok('and nothing is recorded for it', E.rows(REQ).length === 0);
}
{
  const E = engine(); E.user = 'mike';
  const r = E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: 'short' });
  ok('a malformed id is refused with words, before anything is written',
     r.ok === false && /request id/.test(r.error) && forPP(E, INP).length === 0);
  const inj = E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: 'x'.repeat(20) + "'; DROP" });
  ok('so is one with characters an id never has', inj.ok === false && forPP(E, INP).length === 0);
}
{
  const E = engine(); E.user = 'mike';
  E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('T1') });
  E.save({ pp_start: PP, employee_id: 'e1', att: '', request_id: id('T2') });
  E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('T3') });
  ok('three different clicks are three writes — the last tick stands', E.inputsFor(PP).e1.att === true);
  ok('each decision is recorded once', E.rows(REQ).length === 3);
}
{
  const E = engine(); E.seedClosed(); E.user = 'mike';
  E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('Z') });
  E.user = 'sky';
  const r = E.approve({ pp_start: PP, confirm: 'yes', request_id: id('Z') });
  ok('an id already used for a DIFFERENT action is refused, and approves nothing',
     r.ok === false && /already used for incentive_save/.test(r.error) && forPP(E, HIST).length === 0);
}
{
  /* The id is checked and recorded while the lock is held, and flushed before it is released —
     the same consistency the pay writes themselves have. */
  const E = engine(); E.user = 'mike';
  E.events.length = 0;
  E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('L') });
  const ev = E.events;
  const w = ev.indexOf('write:' + REQ);
  ok('the request is recorded between lock and unlock, before the flush',
     w > ev.indexOf('lock') && w < ev.indexOf('flush') && ev.indexOf('flush') < ev.indexOf('unlock'));
  ok('a dry-run approve records nothing', (() => {
    const D = engine(); D.seedClosed();
    D.approve({ pp_start: PP, request_id: id('D') });
    return D.rows(REQ).length === 0;
  })());
}
{
  /* Old decisions are pruned once the tab passes 3,000 rows; a recent one still replays. */
  const E = engine(); E.user = 'mike';
  E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('FRESH') });
  const sh = E.sheets[REQ];
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  const fresh = sh.data.splice(1, 1)[0];
  for (let i = 0; i < 3000; i++) sh.data.push(['old' + String(i).padStart(21, '0'), 'incentive_save', PP, old, 'mike', 'yes', '{}']);
  sh.data.push(fresh);
  E.save({ pp_start: PP, employee_id: 'e2', att: '1', request_id: id('NEXT') });
  ok('week-old decisions are pruned — got ' + E.rows(REQ).length + ' rows', E.rows(REQ).length === 2);
  E.cache.clear();
  E.save({ pp_start: PP, employee_id: 'e1', att: '', request_id: id('UNTICK') });
  const late = E.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('FRESH') });
  ok('and a recent decision still replays after the prune', late.already_applied === true && E.inputsFor(PP).e1.att === false);
}

/* ══ The browser: one id per click, placed where every retry sends it ══════════════════════════ */
console.log('\ncrew.js — every pay write sends a request id minted once per action');
{
  const JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  /* Each Engine.jsonp call to a pay write, with the params that reach it. */
  const calls = [];
  const re = /Engine\.jsonp\('(incentive_(?:save|approve|send|return|unapprove))',\s*([\s\S]*?)\{\s*timeoutMs/g;
  let m;
  while ((m = re.exec(JS))) calls.push({ action: m[1], args: m[2], at: m.index });
  const has = (action, pred) => calls.filter(c => c.action === action).some(pred);
  ok('found the five routes\' call sites', ['save', 'approve', 'send', 'return', 'unapprove']
     .every(a => calls.some(c => c.action === 'incentive_' + a)));
  ok('every incentive_save call carries request_id — ' + calls.filter(c => c.action === 'incentive_save').length + ' sites',
     calls.filter(c => c.action === 'incentive_save').every(c =>
       /request_id: payRequestId\(\)/.test(c.args) ||
       (/^params, $/.test(c.args.trim() + ' ') &&
        /var params = \{[^}]*request_id: payRequestId\(\)/.test(JS.slice(JS.lastIndexOf('async function incSave', c.at), c.at)))));
  ok('the CONFIRMED approve carries one; the dry run does not need one',
     has('incentive_approve', c => /params/.test(c.args) &&
       /confirm: 'yes', request_id: payRequestId\(\)/.test(JS.slice(Math.max(0, c.at - 400), c.at))));
  ok('send, return and reopen each carry one',
     ['incentive_send', 'incentive_return', 'incentive_unapprove'].every(a =>
       has(a, c => /request_id: payRequestId\(\)/.test(c.args))));
  ok('the id is never minted inside a retry loop — it rides every attempt of one action',
     !/for \(var a = 0; a <= retries/.test(JS));

  const gen = new Function('window', 'crypto', JS.slice(JS.indexOf('function payRequestId()'),
    JS.indexOf('\n  }', JS.indexOf('function payRequestId()')) + 4) + '\nreturn payRequestId;');
  const ids = [gen({ crypto: require('crypto').webcrypto }, undefined)(),
               gen({}, undefined)(), gen({ crypto: { getRandomValues: a => require('crypto').webcrypto.getRandomValues(a) } }, undefined)()];
  ok('the id is one the engine accepts, with or without crypto.randomUUID — ' + ids.join(' '),
     ids.every(x => /^[A-Za-z0-9_-]{16,64}$/.test(x)));
  const toastSrc = JS.slice(JS.indexOf('function payStatusWords('), JS.indexOf('\n  }', JS.indexOf('function payReplayToast(')) + 4);
  const T = new Function(toastSrc + '\nreturn payReplayToast;')();
  ok('a late send on a sent-back period does NOT say it is awaiting approval — "' +
     T('Sent for approval', { status: 'draft' }, 'pending') + '"',
     /now back in preparation/.test(T('Sent for approval', { status: 'draft' }, 'pending')) &&
     !/awaiting approval/.test(T('Sent for approval', { status: 'draft' }, 'pending')));
  ok('with nothing in between it just says it landed first',
     /landed first/.test(T('Sent for approval', { status: 'pending' }, 'pending')));
  ok('the old fixed "Already sent for approval" wording is gone, and every replay toast reads the fresh status',
     !/Already sent for approval/.test(JS) && (JS.match(/payReplayToast\(/g) || []).length >= 5);
  ok('and two clicks get two ids', gen({ crypto: require('crypto').webcrypto })() !== gen({ crypto: require('crypto').webcrypto })());
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
