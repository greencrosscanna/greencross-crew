#!/usr/bin/env node
/* ─── Approve and Send say they are working, BEFORE they ask the question ──────────────────────
 *
 *   RUN:  node tests/button_busy_test.js
 *
 * WHY THIS EXISTS
 * Sky, 2026-09-09, pressing Approve on the practice period: "it takes 5-10sec for the pop-up
 * confirm window to come up, the delay made me think it wasn't working."
 *
 * Both buttons run a full server-side dry run before they show anything — it re-fetches the
 * fortnight's performance, folds in SPIFF and totals it, so the confirm can say "38 people · $475
 * to Capstone" rather than asking somebody to approve payroll blind. That check is right and is
 * staying. The bug was that neither button changed while it ran: Approve's busy state was set AFTER
 * the confirm, so the one moment feedback was needed was the one moment there was none.
 *
 * SEND IS THE WORSE ONE, and it is the button MIKE uses — the person this hand-off was built for
 * and who has never once had it work (see the approval_send section in CLAUDE.md). It had no busy
 * state before its call at all: it disabled only on success, so the button stayed live through the
 * whole wait and a second click was a second send. `incentive_send` refuses a period that is
 * already `pending`, so the second click's reward is an error about the work the first click was
 * still doing — which reads as "it is broken", which is what prompts the second click.
 *
 * WHAT MUST HOLD:
 *   1. Both buttons go busy BEFORE the call that makes you wait, not after.
 *   2. Approve says "Checking…", not "Approving…" — nothing is approved until you say yes.
 *   3. Approve is restored BEFORE the confirm, so cancelling leaves the row as it was found.
 *   4. Restoring puts back what was there, not a remembered default — a renderer that deliberately
 *      disabled a button must not have it re-enabled by a handler.
 *   5. The label always comes back, from the one constant the renderer uses.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
function fnSrc(name) {
  const i = JS.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = JS.indexOf('{', i); k < JS.length; k++) {
    if (JS[k] === '{') d++;
    else if (JS[k] === '}') { d--; if (!d) return JS.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
/* Comments out first: twice in this repo a source check has failed on the note explaining the old
   code rather than on the code, which forces the next person to delete the explanation. */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ── The helper does what it claims, run for real ───────────────────────────────────────────── */
console.log('\nincBusy disables, relabels, and puts back exactly what it found');
{
  const incBusy = new Function('return ' + fnSrc('incBusy'))();

  const btn = { textContent: 'Approve', disabled: false };
  const undo = incBusy(btn, 'Checking…');
  ok('it disables the button', btn.disabled === true);
  ok('and says what is happening', btn.textContent === 'Checking…');
  undo();
  ok('undo restores the label', btn.textContent === 'Approve');
  ok('and the enabled state', btn.disabled === false);

  /* THE RESTORE READS WHAT WAS THERE, not a default. A handler that re-enables unconditionally can
     switch on a control the renderer had deliberately switched off — which on this screen is how a
     dead Print button came back to life on an unapproved period. */
  const already = { textContent: 'Print PDF', disabled: true };
  incBusy(already, 'Working…')();
  ok('a button that was ALREADY disabled stays disabled', already.disabled === true);
  ok('and keeps its own label', already.textContent === 'Print PDF');

  /* Every caller calls the return value unconditionally, so it has to be safe on nothing. */
  ok('a missing button is a no-op, not a crash', typeof incBusy(null, 'x') === 'function');
  let threw = false;
  try { incBusy(null, 'x')(); } catch (e) { threw = true; }
  ok('and its undo is too', !threw);
}

/* ── Approve: busy before the wait, back before the question ────────────────────────────────── */
console.log('\nApprove goes busy before the dry run, and is restored before it asks');
{
  const A = decomment(fnSrc('incApproveAndPrint'));
  const iBusy    = A.indexOf('incBusy(btn,');
  const iDry     = A.indexOf("Engine.jsonp('incentive_approve'");
  const iUndo    = A.indexOf('undoBusy()');
  const iConfirm = A.indexOf('window.confirm');

  ok('it goes busy at all', iBusy > 0);
  /* The bug, stated as an order. Every other assertion here passes with the busy state set one line
     after the dry run, which is where it was. */
  ok('BEFORE the dry run that makes you wait', iBusy > 0 && iDry > iBusy);
  ok('and it says "Checking…", not "Approving…" — nothing is approved yet',
     /incBusy\(btn, 'Checking…'\)/.test(A));
  ok('restored before the confirm, so cancelling leaves the row as it was',
     iUndo > iDry && iConfirm > iUndo);
  /* The write still gets its own state, and the label still comes back from one place. */
  ok('the actual write still says "Approving…"', /textContent = 'Approving…'/.test(A));
  ok('and the label is restored from the shared constant',
     /textContent = INC_APPROVE_LABEL/.test(A));
}

/* ── Send: Mike's button, and the one that could double-send ────────────────────────────────── */
console.log('\nSend goes busy before its call, and comes back with its name');
{
  const S = decomment(fnSrc('incSendForApproval'));
  const iBusy = S.indexOf('incBusy(btn,');
  const iCall = S.indexOf("Engine.jsonp('incentive_send'");

  ok('it goes busy at all', iBusy > 0);
  ok('BEFORE the send, so a second click cannot land during the wait',
     iBusy > 0 && iCall > iBusy);
  ok('the label is restored in finally, so it cannot stay reading "Sending…"',
     /textContent = INC_SEND_LABEL/.test(S));

  /* One literal, read by the renderer and the restore. Two is how "Approve & Print PDF" survived on
     screen after the row had stopped saying it. */
  const decJS = decomment(JS);
  ok('the send label is a named constant', /var INC_SEND_LABEL = 'Send for approval';/.test(decJS));
  ok('and the renderer reads it rather than repeating the string',
     /id="incSend">' \+\s*\n?\s*esc\(INC_SEND_LABEL\)/.test(decJS) ||
     /esc\(INC_SEND_LABEL\)/.test(decJS));
  const literals = (decJS.match(/>Send for approval</g) || []).length;
  ok('no hardcoded copy of it survives in the markup (' + literals + ')', literals === 0);
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
