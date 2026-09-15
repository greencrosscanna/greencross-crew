#!/usr/bin/env node
/* ─── Mike's whole attendance list in ONE request ──────────────────────────────────────────────────
 *
 *   RUN:  node tests/attendance_batch_test.js
 *
 * The import used to call `incentive_save` once per person: nineteen people, nineteen Apps Script
 * round trips, a minute or two of spinner. `incentive_att_batch` does the same writes in one
 * execution. THIS PATH MOVES PAY — a tick is $15 to a budtender and $25 to their store manager,
 * both of which reach the Capstone export — so what the one-trip version has to keep is not
 * performance but the four guarantees the per-person loop got for free:
 *
 *   1. THE SAME REFUSALS, APPLIED TO THE WHOLE BATCH. A closed period, a period locked pending
 *      approval, a read-only session. Half a list written into a period that should not have been
 *      touched is worse than a refused one — nothing says which half.
 *   2. ONE REQUEST ID FOR THE WHOLE IMPORT, checked and recorded under withPayLock_. A copy that
 *      stalls and lands after Mike has changed a tick by hand must answer from the record, not
 *      re-apply the file.
 *   3. READ-MERGE-WRITE, ONE ROW PER PERSON. A double-append was already found on this tab once
 *      (amirah_montaner, 2026-09-01) and it is a pay bug, not clutter: saves update the FIRST
 *      matching row and `inputsFor_` reads the LAST, so a later untick stops reaching the math.
 *   4. A PARTIAL WRITE NAMES WHO FAILED. It is NOT atomic and does not claim to be.
 *
 * The two-copies-at-once and lands-after-its-twin cases live with their siblings, in
 * tests/pay_period_race_test.js and tests/pay_request_id_test.js.
 */
'use strict';
const { engine, INP, HIST } = require('./pay_engine_harness');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

if (!engine().attBatch) {
  console.log('\n  \u2717 incentive_att_batch is not in Code.gs — the attendance import is still one call per person');
  process.exit(1);
}

const PP = '2026-08-17';
const id = n => ('req' + n + '0000000000000000').slice(0, 24);
const forPP = (E, tab) => E.rows(tab).filter(r => r[0] === PP);

console.log('\nThe list is read, and anything it cannot read refuses the WHOLE batch');
{
  const E = engine(); E.user = 'mike';
  const bad = v => E.attBatch({ pp_start: PP, att: v, request_id: id(Math.random().toString(36).slice(2, 6)) });

  ok('a plain list writes everybody',
     E.attBatch({ pp_start: PP, att: 'e1:1,e2:0', request_id: id('A') }).count === 2);
  ok('the ticks are what the math reads',
     E.inputsFor(PP).e1.att === true && E.inputsFor(PP).e2.att === false);

  const rowsBefore = forPP(E, INP).length;
  const huh = bad('e1:1,e2:maybe');
  ok('a value that is neither 1 nor 0 refuses the batch and names the person',
     huh.ok === false && /e2/.test(huh.error) && /maybe/.test(huh.error));
  const dupe = bad('e1:1,e1:0');
  ok('the same person twice refuses the batch', dupe.ok === false && /twice/.test(dupe.error));
  const junk = bad('e1:1,not-a-pair');
  ok('an entry with no yes/no at all refuses the batch', junk.ok === false && /not-a-pair/.test(junk.error));
  const weird = bad('e1:1,dr op tables:0');
  ok('an employee id that is not an id refuses the batch', weird.ok === false);
  ok('an empty list is refused rather than reported as a clean run', bad('').ok === false);
  ok('…and nothing was written by ANY of those — still ' + rowsBefore + ' rows',
     forPP(E, INP).length === rowsBefore);
  ok('a refused batch changed nobody', E.inputsFor(PP).e1.att === true && E.inputsFor(PP).e2.att === false);

  const many = Array.from({ length: 201 }, (_, i) => 'p' + i + ':1').join(',');
  ok('a list longer than any pay period holds is refused', bad(many).ok === false);
}

console.log('\nThe refusals are the whole batch\'s, and they land before anything is written');
{
  /* A CLOSED PERIOD. Its figures are what was paid. */
  const E = engine(); E.user = 'mike';
  E.attBatch({ pp_start: PP, att: 'e1:1', request_id: id('B') });
  E.approve({ pp_start: PP, confirm: 'yes', request_id: id('C') });
  const after = E.attBatch({ pp_start: PP, att: 'e1:0,e2:1', request_id: id('D') });
  ok('an imported (closed) period refuses the batch', after.ok === false && /closed/.test(after.error));
  ok('…and not one row of it was written — e1 is still ticked, e2 has no row',
     E.inputsFor(PP).e1.att === true && !E.inputsFor(PP).e2);
}
{
  /* LOCKED PENDING APPROVAL. The numbers being approved must be the ones that were sent. */
  const E = engine(); E.seedClosed(); E.user = 'mike';
  E.attBatch({ pp_start: PP, att: 'e1:1', request_id: id('E') });
  E.send({ pp_start: PP, request_id: id('F') });
  const locked = E.attBatch({ pp_start: PP, att: 'e1:0,e2:1', request_id: id('G') });
  ok('a period sent for approval refuses the batch', locked.ok === false && /locked/.test(locked.error));
  ok('…and nothing was written', E.inputsFor(PP).e1.att === true && !E.inputsFor(PP).e2);
}
{
  /* READ-ONLY. The role check is the batch's too, and it is checked before the list is read. */
  const E = engine(); E.user = 'viewer'; E.canEdit = false;
  const ro = E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('R') });
  ok('a read-only session refuses the batch', ro.ok === false && /read-only/.test(ro.error));
  ok('…and wrote nobody', Object.keys(E.inputsFor(PP)).length === 0);
}
{
  /* THE APPROVER-ONLY OVERRIDE CANNOT TRAVEL IN A BATCH, because the route never reads it. A list
     that could set forty payroll figures is the opposite of what that field is for. */
  const E = engine(); E.user = 'mike';
  E.attBatch({ pp_start: PP, att: 'e1:1', payroll_override: '999', override_note: 'nice try',
               spiff: '500', hours: '900', request_id: id('S') });
  const i = E.inputsFor(PP).e1;
  ok('an override posted alongside a batch is ignored, not applied', i.payrollOverride === null);
  ok('so is a spiff figure', i.spiff === null);
  ok('so are hours', i.hours === null);
  ok('only the tick landed', i.att === true);
}

console.log('\nRead-merge-write: one row per person, and nothing else on the row is touched');
{
  const E = engine(); E.user = 'sky';
  /* A person with a SPIFF override, hours and a payroll override already on file. */
  E.save({ pp_start: PP, employee_id: 'e1', spiff: '120', hours: '64', request_id: id('H') });
  E.save({ pp_start: PP, employee_id: 'e1', payroll_override: '25',
           override_note: 'paid by hand in August', request_id: id('I') });
  E.user = 'mike';
  const r = E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('J') });
  ok('the batch wrote both', r.ok === true && r.count === 2);
  const i1 = E.inputsFor(PP).e1;
  ok('the tick landed', i1.att === true);
  ok('the SPIFF override survived', i1.spiff === 120);
  ok('the hours survived', i1.hours === 64);
  ok('the payroll override survived — a batch must not blank what it does not carry',
     i1.payrollOverride === 25 && i1.overrideNote === 'paid by hand in August');
  ok('one row for e1, not two — got ' + forPP(E, INP).filter(x => x[1] === 'e1').length,
     forPP(E, INP).filter(x => x[1] === 'e1').length === 1);
  ok('one row for the person the batch created too',
     forPP(E, INP).filter(x => x[1] === 'e2').length === 1);
  ok('it says how many it updated and how many it created', r.updated === 1 && r.appended === 1);

  /* A second batch must update those rows, never append beside them. */
  E.attBatch({ pp_start: PP, att: 'e1:0,e2:0', request_id: id('K') });
  ok('a second batch updates the same rows — still 2 rows for the period',
     forPP(E, INP).length === 2);
  ok('…and the untick is what the math reads',
     E.inputsFor(PP).e1.att === false && E.inputsFor(PP).e2.att === false);
}

console.log('\nOne person saved singly and in a batch land on the same row, identically');
{
  const A = engine(); A.user = 'mike';
  A.save({ pp_start: PP, employee_id: 'e1', att: '1', request_id: id('L') });
  const B = engine(); B.user = 'mike';
  B.attBatch({ pp_start: PP, att: 'e1:1', request_id: id('M') });
  const strip = r => r.slice(0, 5).concat(r.slice(6));   // the timestamp is the only difference
  ok('the row the batch writes is the row incentive_save writes',
     JSON.stringify(strip(A.rows(INP)[0])) === JSON.stringify(strip(B.rows(INP)[0])));
  ok('and both read back the same through inputsFor_',
     JSON.stringify(A.inputsFor(PP)) === JSON.stringify(B.inputsFor(PP)));
}

console.log('\nIT IS NOT ATOMIC, AND IT SAYS WHO FAILED');
{
  const E = engine(); E.user = 'mike';
  E.attBatch({ pp_start: PP, att: 'e1:0,e2:0', request_id: id('N') });   // two rows on file
  /* Make the write of e2's row fail, the way a Sheets hiccup would, and nothing else. */
  const sh = E.sheets[INP];
  const realRange = sh.getRange;
  sh.getRange = function (r, c, nr, nc) {
    if (r === 3 && nr === 1 && nc === 9) {
      return { setValues() { throw new Error('the sheet refused that write'); },
               setNumberFormat() { return this; }, getValues: () => [[]], getValue: () => '' };
    }
    return realRange.call(sh, r, c, nr, nc);
  };
  const r = E.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('O') });
  sh.getRange = realRange;
  ok('the batch still reports ok — most of the list went through', r.ok === true);
  ok('e1 was written', r.saved.indexOf('e1') >= 0 && E.inputsFor(PP).e1.att === true);
  ok('e2 is named in `failed`, with the reason',
     r.failed.length === 1 && /^e2:/.test(r.failed[0]) && /refused that write/.test(r.failed[0]));
  ok('e2 really was not written — it keeps what it had', E.inputsFor(PP).e2.att === false);
  ok('the count is what landed, not what was asked for', r.count === 1);

  /* And when NOTHING lands, ok is false — a caller reading only `ok` must not read an empty
     write as a success. */
  const F = engine(); F.user = 'mike';
  const fsh = F.sheets[INP] || (F.attBatch({ pp_start: PP, att: 'e9:1', request_id: id('P') }), F.sheets[INP]);
  const fr = fsh.getRange;
  fsh.getRange = function (r, c, nr, nc) {
    if (nc === 9 && nr >= 1 && r >= 2) {
      return { setValues() { throw new Error('nope'); }, setNumberFormat() { return this; },
               getValues: () => realRowsOf(fsh, r, nr), getValue: () => '' };
    }
    return fr.call(fsh, r, c, nr, nc);
  };
  function realRowsOf(sheet, r, nr) {
    const out = [];
    for (let i = 0; i < nr; i++) {
      const row = sheet.data[r - 1 + i] || [];
      out.push(Array.from({ length: 9 }, (_, j) => row[j] == null ? '' : row[j]));
    }
    return out;
  }
  const none = F.attBatch({ pp_start: PP, att: 'e1:1,e2:1', request_id: id('Q') });
  fsh.getRange = fr;
  ok('a batch that wrote nobody answers ok:false, with a reason',
     none.ok === false && /nothing was saved/.test(none.error) && none.failed.length === 2);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nattendance batch: all passed');
process.exit(fail ? 1 : 0);
