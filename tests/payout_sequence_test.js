#!/usr/bin/env node
/* ─── The payout steps run in order: approve, then print, then export ──────────────────────────
 *
 *   RUN:  node tests/payout_sequence_test.js
 *
 * WHY THIS EXISTS
 * Sky: "change process: approve > sky email/approval > Print/Save to GD > Export each button is
 * disabled until the prior has been done."
 *
 * Before this, Export Payroll CSV rendered on every period including one still running — so the
 * file payroll imports could be produced from figures that had not stopped moving, and nothing on
 * the screen said not to.
 *
 * APPROVAL IS THE ONLY GATE, and it is the only one that could be. Printing and exporting are
 * browser actions that leave no trace, so "has he printed yet" is not a question this app can
 * answer; gating Export on Print would mean inventing a state that resets on reload. Approval is
 * recorded, effectively irreversible, and is the moment the figures freeze — so both later steps
 * hang off it. The Drive copy is filed by the approval itself, so by the time Print lights up the
 * saved PDF already exists.
 *
 * DRAFT PRINTING WENT WITH IT, on Sky's explicit choice when asked (2026-09-08): Print and Export
 * are both dead until approved, on every period including a running one.
 *
 * WHAT MUST HOLD:
 *   1. A running period offers neither. An ended-but-unapproved one offers neither.
 *   2. An approved period offers both — including the 27 legacy imported ones, which are records.
 *   3. The reason is on screen, not only in a tooltip. A dead button with no explanation reads as
 *      a broken app.
 *   4. The HANDLERS refuse too. `disabled` is a property of one DOM node; the CSV is the file
 *      payroll imports, and a page left open across an un-approval must not still produce it.
 *   5. Approving is never gated — it is the step that opens the others.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const toasts = [];
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();', cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) +
    '\n; return { incHeadActions, incPayoutGate, incExportCsv, incPrintWithName, inc,\n' +
    '   __printed:() => __P, __resetPrinted:() => { __P = 0; } };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  /* Count real print calls, and capture toasts, by watching what the app actually reaches for. */
  src = 'var __P = 0;\n' + src;
  const mk = () => ({ className: '', innerHTML: '', style: { setProperty() {} },
    classList: { add() {}, remove() {} }, children: [], parentNode: null, setAttribute() {},
    getAttribute: () => null, addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; }, contains: () => false, querySelector: () => null,
    querySelectorAll: () => [], focus() {}, click() {} });
  const body = mk();
  body.appendChild = c => {
    if (/crew-toast/.test(c.className || '')) toasts.push((c.children[0] || {}).innerHTML || '');
    return c;
  };
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' }, title: 'GX Crew',
    body, activeElement: null, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], createElement: () => mk(), addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' },
    addEventListener() {}, print: () => { /* replaced below */ } };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  win.print = function () { /* counted via the wrapper injected above */ };
  const mod = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
    'navigator', src)(doc, win, store, store, { hostname: 'localhost' }, {});
  mod.__win = win;
  return mod;
})();

let printed = 0;
/* window.print is what incPrintWithName calls once it is satisfied — count it directly. */
M.__win.print = () => { printed++; };

const PERIOD = { start: '2026-08-31', end: '2026-09-13' };
const base = extra => Object.assign({
  thresholds: null, budtenders: [], managers: [], admin: null, inputs: {},
  can_edit: true, can_approve: true, periods: []
}, extra);

const running  = base({ source: 'live', payPeriod: { start: PERIOD.start, end: PERIOD.end, current: true },
                        pp_start: PERIOD.start, workflow: { status: 'draft' } });
const ended    = base({ source: 'live', payPeriod: { start: PERIOD.start, end: PERIOD.end, current: false },
                        pp_start: PERIOD.start, workflow: { status: 'draft' } });
/* can_edit FALSE, as the engine really sends it: sending up locks the inputs server-side for
   everyone, so "Import attendance…" is not on offer here either. A fixture that left it true would
   have this file asserting against a state the app cannot be in. */
const pending  = base({ source: 'live', can_edit: false,
                        payPeriod: { start: PERIOD.start, end: PERIOD.end, current: false },
                        pp_start: PERIOD.start, workflow: { status: 'pending', sent_at: '2026-09-14T10:00:00Z' } });
const approved = base({ source: 'imported', pp_start: '2026-08-17', pp_end: '2026-08-30',
                        can_edit: false, workflow: { status: 'approved' } });

const btn = (html, id) => {
  const i = html.indexOf('id="' + id + '"');
  if (i < 0) return null;
  const from = html.lastIndexOf('<button', i);
  return html.slice(from, html.indexOf('>', i) + 1);
};
const isOff = (html, id) => { const b = btn(html, id); return b !== null && b.indexOf('disabled') >= 0; };
const isOn  = (html, id) => { const b = btn(html, id); return b !== null && b.indexOf('disabled') < 0; };

console.log('\nA period that is still running offers neither');
{
  const h = M.incHeadActions(running, false);
  ok('Print is dead', isOff(h, 'incPrint'));
  ok('Export is dead — this is the file payroll imports', isOff(h, 'incCsv'));
  ok('and the reason is ON SCREEN, not only on hover',
     h.indexOf('still running') > 0 && h.indexOf('crew-inc-wait') > 0);
}

console.log('\nEnded, not yet approved — approving is the step, and it is never gated');
{
  const h = M.incHeadActions(ended, false);
  ok('Approve is live', isOn(h, 'incApprove'));
  ok('Print is dead until it is approved', isOff(h, 'incPrint'));
  ok('Export is dead', isOff(h, 'incCsv'));
  ok('and it says which step comes first', h.indexOf('Approve the period first') > 0);

  /* The preparer sees the same sequence, with Send in place of Approve. */
  const mike = M.incHeadActions(Object.assign({}, ended, { can_approve: false }), false);
  ok('the preparer gets Send for approval, live', isOn(mike, 'incSend'));
  ok('and the same two dead steps after it', isOff(mike, 'incPrint') && isOff(mike, 'incCsv'));
}

console.log('\nSent up and waiting — nothing downstream opens early');
{
  const h = M.incHeadActions(pending, false);
  /* PRESENT AND DISABLED, not absent. This branch used to render no Print button at all, so the
     step did not read as "not yet, and here is why" — it simply vanished and reappeared after
     approval. Asserting `isOff` rather than "not usable" is deliberate: absence would also stop a
     click, and would also pass a looser check, while teaching the reader nothing about what
     comes next. */
  ok('Print is present and dead, not missing', isOff(h, 'incPrint'));
  ok('Export still dead', isOff(h, 'incCsv'));
  ok('and it names what is being waited on', h.indexOf('Waiting on the approver') > 0);
  const mike = M.incHeadActions(Object.assign({}, pending, { can_approve: false }), false);
  ok('the preparer is told it is locked, with no action', mike.indexOf('locked until they decide') > 0);
  /* ONE explanation, not two. That branch already says why the row is grey, and adding the generic
     gate line underneath it would repeat the same fact in different words — noise on the screen
     Sky asked to be quieter. */
  ok('and NOT told twice in different words — one status line, not two',
     mike.split('crew-inc-wait').length - 1 === 1 &&
     mike.indexOf('>Waiting on the approver.<') < 0);
  /* The tooltip on each dead button still carries it, which is right: hovering a grey control
     should say why THAT control is grey, whatever the row already said. */
  ok('…though the tooltips still explain each dead button',
     mike.indexOf('title="Waiting on the approver.') > 0);
  /* The approver, who has an action, still gets the reason — nothing above explained it to them. */
  ok('while the approver still gets the reason for the grey pair',
     h.indexOf('Waiting on the approver.') > 0);
}

console.log('\nApproved — both steps open, and the row stops explaining itself');
{
  const h = M.incHeadActions(approved, true);
  ok('Print is live', isOn(h, 'incPrint'));
  ok('Export is live', isOn(h, 'incCsv'));
  ok('no gate message once nothing is blocked', h.indexOf('crew-inc-wait') < 0);
  ok('and the break glass is offered, since this is a record', h.indexOf('incReopen') > 0);
}

console.log('\nThe HANDLERS refuse too — a disabled button is only one DOM node');
{
  M.inc.data = running;
  toasts.length = 0; printed = 0;
  M.incExportCsv(running, false);
  ok('exporting a running period produces no file', toasts.length === 1 && /still running/.test(toasts[0]));
  M.incPrintWithName(running);
  ok('printing a running period does not reach window.print', printed === 0);

  toasts.length = 0;
  M.incExportCsv(ended, false);
  ok('exporting an unapproved period is refused', toasts.length === 1 && /Approve the period first/.test(toasts[0]));
  M.incPrintWithName(ended);
  ok('and printing one is too', printed === 0);

  M.inc.data = approved;
  toasts.length = 0;
  M.incPrintWithName(approved);
  ok('an approved period DOES print — the gate is a sequence, not a wall', printed === 1);
}

console.log('\nThe gate itself');
{
  ok('approved passes', M.incPayoutGate(approved, true).ok === true);
  ok('running fails', M.incPayoutGate(running, false).ok === false);
  ok('ended-unapproved fails', M.incPayoutGate(ended, false).ok === false);
  ok('pending fails', M.incPayoutGate(pending, false).ok === false);
  /* The 27 legacy periods are records, not drafts, and predate the workflow entirely. */
  ok('a legacy imported period with NO workflow still passes',
     M.incPayoutGate({ source: 'imported', pp_start: '2025-09-01' }, true).ok === true);
  ok('every refusal carries a reason — a silent one reads as a broken app',
     [running, ended, pending].every(d => (M.incPayoutGate(d, false).why || '').length > 20));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
