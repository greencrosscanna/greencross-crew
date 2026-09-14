#!/usr/bin/env node
/* ─── inputs_dedupe — deletes a duplicate inputs row only when it cannot change a figure ─────────
 *
 *   RUN:  node tests/inputs_dedupe_test.js
 *
 * pay_audit found amirah_montaner with two identical inputs rows for 2026-08-17 (2026-09-14). The
 * route that removes one must refuse anything that could move pay: a row that disagrees with the
 * one staying, a row belonging to somebody else, a person with only one row, a missing secret.
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

const IH = ['pp_start', 'employee_id', 'att', 'spiff', 'hours', 'updated_at', 'updated_by', 'payroll_override', 'override_note'];
function run(rows, p, secretOk) {
  const data = [IH.slice()].concat(rows.map(r => IH.map(h => r[h] == null ? '' : r[h])));
  const deleted = [];
  const sh = {
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({ getValues: () => data.slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)) }),
    deleteRow: n => { deleted.push(n); data.splice(n - 1, 1); },
  };
  const f = new Function('deploySecretOk_', 'sheetOf_', 'withPayLock_', 'Utilities', 'Logger',
    'var INPUTS_TAB = "crew_incentive_inputs"; var INPUTS_HEADERS = ' + JSON.stringify(IH) + '; var STORE_TZ = "x";' +
    fnSrc('incTab_') + fnSrc('isPracticePeriod_') + fnSrc('pad2_') + fnSrc('normDate_') + fnSrc('inputsDedupe_') +
    '\nreturn inputsDedupe_;')(() => secretOk !== false, () => sh, fn => fn(),
      { formatDate: d => d.toISOString().slice(0, 10) }, { log() {} });
  return { res: f(p), deleted, data };
}
const PP = '2026-08-17';
const base = [
  { pp_start: PP, employee_id: 'someone', att: 'true' },
  { pp_start: PP, employee_id: 'amirah_montaner', att: 'true', updated_at: '2026-09-01T19:55:40.223Z', updated_by: 'sky' },
  { pp_start: PP, employee_id: 'amirah_montaner', att: 'true', updated_at: '2026-09-01T19:21:42.213Z', updated_by: 'sky' },
];

console.log('\ninputs_dedupe');
{
  const { res, deleted } = run(base, { pp_start: PP, employee_id: 'amirah_montaner', row: 4 });
  ok('dry by default: says what it would delete, deletes nothing',
     res.ok && res.dry_run === true && res.delete_row === 4 && res.identical_to_row === 3 && deleted.length === 0);
}
{
  const { res, deleted, data } = run(base, { pp_start: PP, employee_id: 'amirah_montaner', row: 4, confirm: 'yes' });
  ok('confirm=yes deletes exactly that row', res.ok && deleted.join() === '4' && data.length === 3);
  ok('the person keeps one row with the same values', data.filter(r => r[1] === 'amirah_montaner').length === 1 &&
     data.find(r => r[1] === 'amirah_montaner')[2] === 'true');
}
{
  const rows = base.map(r => Object.assign({}, r)); rows[2].att = '';
  const { res, deleted } = run(rows, { pp_start: PP, employee_id: 'amirah_montaner', row: 4, confirm: 'yes' });
  ok('refuses when the rows DISAGREE — that could change pay', res.ok === false && /could change pay/.test(res.error) && !deleted.length);
}
{
  const { res, deleted } = run(base, { pp_start: PP, employee_id: 'amirah_montaner', row: 2, confirm: 'yes' });
  ok('refuses a row that belongs to somebody else', res.ok === false && !deleted.length);
}
{
  const { res, deleted } = run(base, { pp_start: PP, employee_id: 'someone', row: 2, confirm: 'yes' });
  ok('refuses a person who has only one row', res.ok === false && /nothing to de-duplicate/.test(res.error) && !deleted.length);
}
{
  const { res, deleted } = run(base, { pp_start: PP, employee_id: 'amirah_montaner', row: 4, confirm: 'yes' }, false);
  ok('refuses without the deploy secret', res.ok === false && /secret/.test(res.error) && !deleted.length);
}
{
  const { res } = run(base, { pp_start: PP, employee_id: 'amirah_montaner', row: 3, confirm: 'no' });
  ok('either copy of an identical pair can be named', res.ok && res.identical_to_row === 4);
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
