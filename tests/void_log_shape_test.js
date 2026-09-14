#!/usr/bin/env node
/* ─── incentive_voided — a void row is read on the shape it was written in ───────────────────────
 *
 *   RUN:  node tests/void_log_shape_test.js
 *
 * crew_incentive_voided holds two row shapes. Rows voided before 2026-09-02 were copied when
 * HISTORY_HEADERS had 18 columns, so they are 20 wide; everything since is 22. readTab_ reads by
 * position at 22, so an old row's voided_at lands in computed_payroll and its reason in
 * override_note. Live, that made the 2026-08-17 reopen (2026-09-02T21:04:06.171Z, 39 rows) come
 * back with no timestamp and no reason, grouped under an empty key.
 *
 * pay_audit already read that shape correctly; this pins that incentive_voided does too, through
 * the SAME helper — and that nothing rewrites the sheet to get there, because those rows are the
 * audit trail.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));
const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i + 1, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
/* The engine's own header list, not a copy — the whole bug is a column count. */
const HH = new Function(SRC.match(/var HISTORY_HEADERS = \[[\s\S]*?\];/)[0] + '\nreturn HISTORY_HEADERS;')();
const VH = HH.concat(['voided_at', 'void_reason']);

/* The route itself, over a fake sheet that serves raw cells the way getRange().getValues() does. */
function engine(grid, who) {
  const writes = [];
  const sheet = {
    getLastRow: () => grid.length,
    getRange: (r, c, n, w) => ({
      getValues: () => grid.slice(r - 1, r - 1 + n).map(row => Array.from({ length: w }, (_, j) => row[j] ?? '')),
      setValues: () => writes.push('setValues'), setFontWeight() { return this; },
    }),
  };
  const route = new Function('Utilities', 'STORE_TZ', 'HISTORY_HEADERS', 'VOID_TAB', 'sheetOf_',
    'requireCrew_', 'canApprove_', 'isPracticePeriod_',
    ['pad2_', 'normDate_', 'incTab_', 'readTab_', 'VOID_HEADERS', 'voidRowShape_', 'incentiveVoided_']
      .map(fnSrc).join('\n') + '\nreturn incentiveVoided_;')(
    { formatDate: d => d.toISOString().slice(0, 10) }, 'America/Los_Angeles', HH, 'crew_incentive_voided',
    () => sheet, () => ({ ok: true, user: who || 'sky' }), a => a.user === 'sky', pp => /^practice-/.test(pp));
  return { route, writes };
}

const OLD_STAMP = '2026-09-02T21:04:06.171Z', NEW_STAMP = '2026-09-02T23:40:00.000Z';
const OLD_REASON = 'Pre-launch plumbing test of the attendance import — reopened by sky';
const hist = (id, pay) => HH.map(h => ({ pp_start: '2026-08-17', pp_end: '2026-08-30', section: 'budtender',
  employee_id: id, pdf_name: id, payroll: pay, format: 'approved', imported_at: '2026-09-02T20:00:00.000Z' })[h] ?? '');
/* 20 wide: what a pre-2026-09-02 void wrote — 18 history columns, then its stamp and reason. */
const oldVoid = (id, pay) => hist(id, pay).slice(0, 18).concat([OLD_STAMP, OLD_REASON]);
/* 22 wide, with a real computed_payroll and override note, which must stay where they are. */
const newVoid = (id, pay) => { const r = hist(id, pay); r[18] = pay; r[19] = 'as paid in August'; return r.concat([NEW_STAMP, 'second look — reopened by sky']); };
/* The live tab's header is the OLD 20-wide one: sheetOf_ writes headers only on create. */
const OLD_HEAD = HH.slice(0, 18).concat(['voided_at', 'void_reason']);
const grid = () => [OLD_HEAD, oldVoid('a', 40), oldVoid('b', 25), newVoid('a', 40), newVoid('b', 30)];

console.log('\nincentive_voided — the list of reopens');
{
  const { route, writes } = engine(grid());
  const r = route({});
  ok('two reopens, not one real one and one under an empty timestamp — got ' + JSON.stringify(r.periods.map(p => p.voided_at)),
     r.ok && r.periods.length === 2 && r.periods.every(p => /^2026-09-02T/.test(p.voided_at)));
  const old = r.periods.find(p => p.voided_at === OLD_STAMP);
  ok('the old reopen carries its reason', !!old && old.reason === OLD_REASON);
  ok('and its own rows and total', !!old && old.rows === 2 && old.payroll_total === 65);
  ok('newest first', r.periods[0].voided_at === NEW_STAMP);
  ok('nothing was written to the sheet', writes.length === 0);
}

console.log('\nincentive_voided — one period');
{
  const { route } = engine(grid());
  const r = route({ pp_start: '2026-08-17' });
  const olds = r.rows.filter(x => x.voided_at === OLD_STAMP);
  ok('every row has a timestamp', r.rows.length === 4 && r.rows.every(x => x.voided_at));
  ok('old rows have their reason in void_reason', olds.length === 2 && olds.every(x => x.void_reason === OLD_REASON));
  ok('and a blank computed_payroll / override_note, not a timestamp and a sentence',
     olds.every(x => x.computed_payroll === '' && x.override_note === ''));
  const news = r.rows.filter(x => x.voided_at === NEW_STAMP);
  ok('new rows are untouched — computed_payroll and override_note stay put',
     news.length === 2 && news.every(x => x.computed_payroll !== '' && x.override_note === 'as paid in August'));
  ok('the header of the response is the newest void', r.voided_at === NEW_STAMP && /second look/.test(r.reason));
}
{
  /* A tab that only ever held old rows — what 2026-08-17 looked like before any later void. */
  const { route } = engine([OLD_HEAD, oldVoid('a', 40), oldVoid('b', 25)]);
  const r = route({ pp_start: '2026-08-17' });
  ok('a period reopened only the old way reports when and why — got ' + JSON.stringify([r.voided_at, r.reason]),
     r.voided_at === OLD_STAMP && r.reason === OLD_REASON && r.payroll_total === 65);
}

console.log('\nvoidRowShape_ — only that shape moves');
{
  const shape = new Function(fnSrc('voidRowShape_') + '\nreturn voidRowShape_;')();
  const money = shape({ voided_at: '', computed_payroll: '40', override_note: 'x' });
  ok('a blank voided_at over a dollar figure is not remapped', money.voided_at === '' && money.computed_payroll === '40');
  const both = shape({ voided_at: NEW_STAMP, void_reason: 'r', computed_payroll: '2026-09-02T00:00:00Z' });
  ok('a row that already has voided_at is left alone', both.voided_at === NEW_STAMP && both.computed_payroll === '2026-09-02T00:00:00Z');
}

console.log('\none helper, both readers');
{
  ok('incentive_voided reads through voidRowShape_', /voidRowShape_/.test(fnSrc('incentiveVoided_')));
  ok('pay_audit reads through voidRowShape_', /voidRowShape_/.test(fnSrc('payAuditRows_')));
  ok('neither keeps its own copy of the remap',
     !/r\.voided_at = r\.computed_payroll/.test(fnSrc('incentiveVoided_') + fnSrc('payAuditRows_')));
  ok('the helper writes nothing to a sheet', !/setValue|deleteRow|appendRow|getRange/.test(fnSrc('voidRowShape_')));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
