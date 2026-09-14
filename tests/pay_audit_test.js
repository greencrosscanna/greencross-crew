#!/usr/bin/env node
/* ─── pay_audit — does it find each fingerprint the pre-lock race could leave? ──────────────────
 *
 *   RUN:  node tests/pay_audit_test.js
 *
 * `pay_audit` is how anyone answers "did a retried pay write ever land twice before withPayLock_
 * went live (2026-09-14)?". An audit that reports clean because it cannot see a duplicate is worse
 * than no audit, so every fingerprint pay_period_race_test.js describes is planted here, and a
 * clean fixture must stay clean — including a genuine reopen → re-approve → reopen, which is not
 * a race and must not be reported as one.
 *
 * Also pinned: the route never goes through crewSheet_() or sheetOf_(), which CREATE what they
 * cannot find — an audit must not be able to add a tab to the payroll spreadsheet.
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
const auditRows = new Function('Utilities', 'STORE_TZ',
  fnSrc('pad2_') + fnSrc('normDate_') + fnSrc('voidRowShape_') + fnSrc('payAuditRows_') + '\nreturn payAuditRows_;')
  ({ formatDate: d => d.toISOString().slice(0, 10) }, 'America/Los_Angeles');

const HH = ['pp_start', 'pp_end', 'section', 'employee_id', 'pdf_name', 'store_label', 'store_id', 'txn',
            'sales', 'discount_pct', 'aov', 'spiff', 'bonus', 'per_hour', 'payroll', 'source_file', 'format',
            'imported_at', 'computed_payroll', 'override_note'];
const IH = ['pp_start', 'employee_id', 'att', 'spiff', 'hours', 'updated_at', 'updated_by', 'payroll_override', 'override_note'];
const WH = ['pp_start', 'status', 'sent_by', 'sent_at', 'decided_by', 'decided_at', 'note', 'token', 'token_expires', 'sent_total'];
const VH = HH.concat(['voided_at', 'void_reason']);
const SH = ['pp_start', 'thresholds_json', 'frozen_at', 'frozen_by'];
/* The engine's own headers, which is what the route passes. */
const audit = t => auditRows(t, { history: HH, inputs: IH, workflow: WH, voided: VH, schemes: SH });
const hrow = (pp, id, pay, fmt, at, section) => HH.map(h => ({ pp_start: pp, employee_id: id, pdf_name: id, payroll: pay,
  section: section || 'budtender', format: fmt || 'gen2', imported_at: at || '2026-08-27T06:38:04.758Z' })[h] ?? '');
const vrow = (pp, id, pay, at) => hrow(pp, id, pay, 'approved', '2026-09-02T20:00:00.000Z').concat([at, 'fix it — reopened by sky']);

function cleanTabs() {
  return {
    history: [HH, hrow('2026-08-03', 'a', 10), hrow('2026-08-03', 'b', 20),
              hrow('2026-08-17', 'a', 40, 'approved', '2026-09-02T23:51:39.770Z'),
              hrow('2026-08-17', 'b', 25, 'approved', '2026-09-02T23:51:39.770Z'),
              hrow('2026-08-17', 'b', 0, 'approved', '2026-09-02T23:51:39.770Z', 'manager')],   // dual role: not a dup
    inputs: [IH, IH.map(h => ({ pp_start: '2026-08-17', employee_id: 'a', att: 'true' })[h] ?? ''),
                 IH.map(h => ({ pp_start: '2026-08-17', employee_id: 'b', att: '' })[h] ?? '')],
    workflow: [WH, WH.map(h => ({ pp_start: '2026-08-17', status: 'approved', sent_total: '65' })[h] ?? '')],
    /* A real reopen, a re-approval, and a second reopen hours later — then approved again. */
    voided: [VH, vrow('2026-08-17', 'a', 40, '2026-09-02T21:00:00.000Z'), vrow('2026-08-17', 'b', 25, '2026-09-02T21:00:00.000Z'),
                 vrow('2026-08-17', 'a', 40, '2026-09-02T23:00:00.000Z'), vrow('2026-08-17', 'b', 25, '2026-09-02T23:00:00.000Z')],
    schemes: [SH, ['2026-08-17', '{}', '2026-09-02T23:51:39.770Z', 'sky']],
  };
}
console.log('\npay_audit — a clean record stays clean');
{
  const t = cleanTabs();
  /* The second reopen removed the 22:00 re-approval, so that approval now lives only on the rows
     it copied into the void log — which is exactly where the audit has to look for it. */
  t.voided[3][17] = '2026-09-02T22:00:00.000Z'; t.voided[4][17] = '2026-09-02T22:00:00.000Z';
  const r = audit(t);
  ok('no findings on a clean fixture — got ' + JSON.stringify(r.findings.map(f => f.kind)),
     r.findings.length === 0 && r.clean === true);
  ok('all five tabs reported present', Object.values(r.tabs).every(Boolean));
  ok('the dual-role person (budtender + manager) is NOT a duplicate',
     r.history.find(p => p.pp_start === '2026-08-17').duplicate_people.length === 0);
  ok('periods are listed with row counts and payroll totals',
     r.history.length === 2 && r.history[1].rows === 3 && r.history[1].payroll_total === 65);
  ok('sheet row references are 1-based with the header as row 1', r.history[0].first_row === 2 && r.history[1].last_row === 6);
}

console.log('\npay_audit — approve ran twice');
{
  const t = cleanTabs();
  t.history.push(hrow('2026-08-17', 'a', 40, 'approved', '2026-09-02T23:51:41.001Z'),
                 hrow('2026-08-17', 'b', 25, 'approved', '2026-09-02T23:51:41.001Z'));
  const r = audit(t);
  const dup = r.findings.find(f => f.kind === 'history_duplicate_person');
  ok('each person appearing twice is found', !!dup && dup.pp_start === '2026-08-17' && dup.count === 2);
  ok('with the sheet rows of both copies', !!dup && JSON.stringify(dup.detail[0].rows) === '[4,7]');
  ok('and the two append batches are named', r.findings.some(f => f.kind === 'history_multiple_batches'));
  ok('and the record is not called clean', r.clean === false);
}

console.log('\npay_audit — save appended a hidden second row');
{
  const t = cleanTabs();
  t.inputs.push(IH.map(h => ({ pp_start: '2026-08-17', employee_id: 'a', att: '' })[h] ?? ''));
  const r = audit(t);
  const f = r.findings.find(x => x.kind === 'inputs_duplicate_row');
  ok('the duplicate inputs row is found', !!f && f.count === 1);
  ok('with both rows and the field that now reads differently',
     !!f && JSON.stringify(f.detail[0].rows) === '[2,4]' && f.detail[0].differing_fields.join() === 'att');
}
{
  const t = cleanTabs();
  /* A Date in pp_start is how Sheets hands back a cell it parsed — it must still group with the text. */
  t.inputs.push(IH.map(h => ({ pp_start: new Date('2026-08-17T12:00:00Z'), employee_id: 'b', att: '' })[h] ?? ''));
  ok('a Date-typed pp_start still counts as the same period',
     audit(t).findings.some(x => x.kind === 'inputs_duplicate_row'));
}

console.log('\npay_audit — send / approve left a second workflow or scheme row');
{
  const t = cleanTabs();
  t.workflow.push(WH.map(h => ({ pp_start: '2026-08-17', status: 'pending' })[h] ?? ''));
  t.schemes.push(['2026-08-17', '{}', '2026-09-02T23:51:41.000Z', 'sky']);
  const r = audit(t);
  ok('two workflow rows for one period are found', r.findings.some(f => f.kind === 'workflow_duplicate_row'));
  ok('two frozen schemes for one period are found', r.findings.some(f => f.kind === 'scheme_duplicate_row'));
}

console.log('\npay_audit — reopen ran twice');
{
  const t = cleanTabs();
  t.voided = [VH, vrow('2026-08-17', 'a', 40, '2026-09-02T21:00:00.000Z'), vrow('2026-08-17', 'b', 25, '2026-09-02T21:00:00.000Z'),
                  vrow('2026-08-17', 'a', 40, '2026-09-02T21:00:03.500Z'), vrow('2026-08-17', 'b', 25, '2026-09-02T21:00:03.500Z')];
  const r = audit(t);
  const f = r.findings.find(x => x.kind === 'void_same_rows_twice');
  ok('the same rows voided twice seconds apart is found', !!f && f.detail[0].gap_seconds === 4);
  ok('with no approval between the two', !!f && f.detail[0].approved_between === false);
}
{
  const t = cleanTabs();
  const r = audit(t);
  ok('the same people voided twice with NO approval between is a race, however far apart',
     r.findings.some(x => x.kind === 'void_same_rows_twice'));
}

console.log('\npay_audit — a tab whose header row is older than its rows');
{
  /* crew_incentive_voided, live: created when history had 18 columns, so its header row is 20 wide
     while every void since 2026-09-02 writes 22. Read by header name, `voided_at` is a dollar figure. */
  const t = cleanTabs();
  const oldHead = HH.slice(0, 18).concat(['voided_at', 'void_reason']);
  t.voided[0] = oldHead;
  const r = audit(t);
  ok('the void batches are still grouped on the real voided_at — got ' + r.voids.map(v => v.voided_at).join(),
     r.voids.length === 2 && r.voids.every(v => /^2026-09-02T2/.test(v.voided_at)));
  ok('and the stale header is reported', !!r.header_drift.voided && r.header_drift.voided.sheet_says.length === 20);
  ok('a current header reports no drift', r.header_drift.history === null);
}
{
  /* The oldest void rows: 20 wide, so read 22 wide their stamp lands in computed_payroll. */
  const t = cleanTabs();
  const narrow = (id, pay) => hrow('2026-08-17', id, pay, 'approved', '2026-09-02T20:00:00.000Z').slice(0, 18)
    .concat(['2026-09-02T21:04:06.171Z', 'plumbing test — reopened by sky']);
  t.voided = [VH, narrow('a', 40), narrow('b', 25)];
  const r = audit(t);
  ok('a pre-2026-09-02 void row is read on its own shape — got ' + r.voids.map(v => v.voided_at).join(),
     r.voids.length === 1 && r.voids[0].voided_at === '2026-09-02T21:04:06.171Z' && /plumbing/.test(r.voids[0].reason));
}
{
  const t = cleanTabs();
  t.voided = [VH, vrow('2026-08-17', 'a', 40, '2026-09-02T21:00:00.000Z'), vrow('2026-08-17', 'b', 25, '2026-09-02T21:00:00.000Z')];
  const twice = vrow('2026-08-17', 'a', 40, '2026-09-02T21:00:00.000Z'); twice[17] = '2026-09-02T20:00:01.200Z';
  t.voided.push(twice);
  const r = audit(t);
  const f = r.findings.find(x => x.kind === 'void_batch_duplicate_person');
  ok('a double approval later swept into the void log is found, with both approval stamps',
     !!f && f.from_approvals.length === 2);
}
{
  const t = cleanTabs();
  t.inputs.push(IH.map(h => ({ pp_start: '2026-08-17', employee_id: 'a', att: 'true', updated_at: '2026-09-02T18:00:00Z', updated_by: 'mike' })[h] ?? ''));
  const f = audit(t).findings.find(x => x.kind === 'inputs_duplicate_row');
  ok('a duplicate inputs row reports when and by whom each copy was written',
     !!f && f.detail[0].written.length === 2 && f.detail[0].written[1].updated_by === 'mike');
}

console.log('\npay_audit — the route reads, it never creates');
{
  const route = fnSrc('payAudit_');
  ok('it checks the deploy secret', /deploySecretOk_\(p\)/.test(route));
  ok('it never calls crewSheet_() or sheetOf_(), which create missing tabs',
     !/crewSheet_\(|sheetOf_\(|readTab_\(|insertSheet/.test(route));
  ok('it writes nothing', !/setValue|setValues|deleteRow|appendRow|setNumberFormat|clear\(/.test(route + fnSrc('payAuditRows_')));
  ok('an absent tab is reported absent, not an error', audit({ history: null, inputs: null, workflow: null, voided: null, schemes: null }).clean === true);
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
