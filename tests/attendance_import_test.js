#!/usr/bin/env node
/* ─── Reading Mike's attendance bonus list ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/attendance_import_test.js
 *
 * WHY THIS EXISTS, AND WHY IT IS STRICTER THAN THE HOURS ONE IT REPLACED
 * Hours only ever reached $/hr, which is why they could be imported from an unverified source: the
 * worst a misparse could do was display a wrong ratio. `att` is not like that. A tick adds
 * `attendanceBonus` to a budtender AND `teamAttendancePerHead` to their store manager, both of which
 * reach `payroll` and therefore the Capstone export. **This import moves money in both directions.**
 *
 * So the rules it has to hold are about arithmetic and refusals, not about parsing convenience:
 *
 *   • the dollar figure on the confirm button must be the one the MATH would produce — counting
 *     heads understates every change by the manager's share
 *   • a manager's own tick pays nobody (incCalcMgr_ reads their TEAM, never their own att), so it
 *     must not be reported as a change
 *   • a value that is neither yes nor no is skipped and named — "Pending" read as No strips a bonus
 *   • a "No" writes a CLEAR, because Mike's list is a complete determination and somebody ticked in
 *     error has to be untickable by the same file that got it right
 *
 * The real file is an .xlsx with a second summary sheet and no employee code column at all, so the
 * sheet is chosen rather than assumed and matching is name-only — against BOTH the display name and
 * the legal one, because the list mixes them: it says "Mike Kettler" (the nickname) and "Robert
 * Wydick" (the legal name of the person this roster calls Nate).
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();';
  const cut = src.lastIndexOf(TAIL);
  if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
  src = src.slice(0, cut) +
        '\n; return { impParseCsv, impHeaderRow, impKey, impTokens, impRoster,\n' +
        '           attPlan, attBuild, calcBud, calcMgr };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' },
                body: { classList: { add() {}, remove() {} } },
                getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                createElement: () => ({ style: { setProperty() {} }, classList: { add() {} },
                                        setAttribute() {}, addEventListener() {}, appendChild() {} }),
                addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' } };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  return new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
    (doc, win, store, store, { hostname: 'localhost' }, {});
})();

const T = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center', 'portland'],
               aovTarget: 33, aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25,
               attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }], maxPerStore: 50 },
};

/* A live period payload, shaped like getIncentive_ returns one. The names are deliberately the awkward
   ones this roster actually holds: displayed nickname vs legal name, which is the whole match problem. */
const PERIOD = {
  budtenders: [
    { employee_id: 'mya_ward',        name: 'Mya Ward',      full_name: 'Mya Ward',         storeName: 'Baseline', storeSlug: 'baseline' },
    { employee_id: 'taner_perri',     name: 'Taner Perri',   full_name: 'Taner Perri',      storeName: 'Baseline', storeSlug: 'baseline' },
    { employee_id: 'robert_wydick',   name: 'Nate Wydick',   full_name: 'Robert Wydick',    storeName: 'Century',  storeSlug: 'century' },
    { employee_id: 'noah_pinkerton',  name: 'Noah Pinkerton', full_name: 'Noah Pinkerton',  storeName: 'River',    storeSlug: 'river' },
  ],
  managers: [
    { employee_id: 'dean_deloof',      name: 'Dean Deloof',   full_name: 'Dean Deloof',        storeName: 'Baseline', storeSlug: 'baseline' },
    { employee_id: 'christopher_carney', name: 'Chris Carney', full_name: 'Christopher Carney', storeName: 'Century', storeSlug: 'century' },
  ],
  admin: { employee_id: 'sky', name: 'Sky Pinnick', full_name: 'Skyler Pinnick' },
};
const ROSTER = M.impRoster(PERIOD);

/* Mike's real columns, verbatim from Attendance_Bonus_List_8-17_to_8-30-2026.xlsx. */
const HEAD = 'Store,Name,Attendance (Yes/No),Notes\n';
const sheet = csv => [{ name: 'Attendance Bonus', rows: M.impParseCsv(csv) }];

console.log('\nFinding the right sheet and columns');
{
  const plan = M.attPlan(sheet(HEAD +
    'Baseline,Mya Ward,Yes,No attendance issues.\n' +
    'Baseline,Taner Perri,No,Multiple punch issues.\n' +
    'Century Dr,Robert Wydick,No,"PTO used 7.50 hrs on 8/20, and 7.50 hrs on 8/25."\n'));
  ok('the name column is found', plan && plan.headers[plan.nameCol] === 'Name');
  ok('the Yes/No column is found', plan && plan.headers[plan.attCol] === 'Attendance (Yes/No)');
  ok('the notes column is found', plan && plan.headers[plan.noteCol] === 'Notes');
  ok('"Store" is not mistaken for the name column', plan && plan.headers[plan.nameCol] !== 'Store');
  ok('three data rows past the header', plan && plan.body.length === 3);

  /* Mike's workbook has a second "Summary" sheet whose first row is a sentence and which has no
     Name column. Reading it instead would produce an import of nobody, reported as a clean run. */
  const two = M.attPlan([
    { name: 'Summary', rows: M.impParseCsv('Attendance Bonus Eligibility — Pay Period 8/17-8/30/2026\n\nTotal Staff Listed,40\nEligible (Yes),11\n') },
    { name: 'Attendance Bonus', rows: M.impParseCsv(HEAD + 'Baseline,Mya Ward,Yes,No issues.\n') },
  ]);
  ok('the summary sheet is skipped in favour of the one with names', two && two.sheetName === 'Attendance Bonus');

  /* A header can be spelled anything; the vocabulary in the cells cannot be mistaken. */
  const odd = M.attPlan(sheet('Name,Bonus?\nMya Ward,Yes\nTaner Perri,No\nNoah Pinkerton,Yes\n'));
  ok('an unnamed yes/no column is found by its VALUES', odd && odd.headers[odd.attCol] === 'Bonus?');

  ok('a file with no yes/no column at all is refused, not guessed at',
     M.attPlan(sheet('Name,Hours\nMya Ward,72\n')) === null);
}

console.log('\nMatching against the period');
{
  const plan = M.attPlan(sheet(HEAD +
    'Baseline,Mya Ward,Yes,No attendance issues.\n' +
    'Century Dr,Robert Wydick,No,PTO used 7.50 hrs on 8/20.\n' +
    'Baseline,Dean Deloof,No,Excluded by role (Store Manager).\n' +
    'Intake,Andrew Phillips,No,Excluded by role (Intake).\n'));
  const b = M.attBuild(plan, ROSTER, {}, T);

  /* The list says "Robert Wydick"; this roster leads with "Nate Wydick". Matched on the legal name,
     and landing in `same` rather than `change` is itself correct — he is not ticked and the file
     says No, so there is nothing to write. Asserted across every bucket that means "resolved to a
     person", because which one he lands in is a separate question from whether he was found. */
  ok('somebody the roster lists under a NICKNAME matches on their legal name',
     [].concat(b.change, b.same, b.noeffect).some(x => x.id === 'robert_wydick'));
  ok('...and is not reported as a stranger', !b.absent.some(x => /Wydick/.test(x.name)));
  ok('Mya Ward is a real change — she is not ticked yet and the file says Yes',
     b.change.some(x => x.id === 'mya_ward' && x.want === true));
  ok('Mike\'s reason is carried through, not dropped',
     b.change.find(x => x.id === 'mya_ward').note === 'No attendance issues.');
  ok('a manager is written but reported as changing no bonus',
     b.noeffect.some(x => x.id === 'dean_deloof'));
  ok('somebody not on this pay period is listed separately, not counted as a change',
     b.absent.some(x => x.name === 'Andrew Phillips'));
  ok('a budtender in the period but absent from the file is reported',
     b.missing.some(x => x.id === 'taner_perri') && b.missing.some(x => x.id === 'noah_pinkerton'));
  ok('the owner is never reported as missing', !b.missing.some(x => x.id === 'sky'));
}

console.log('\nThe money, which is what this import actually does');
{
  /* Two budtenders gaining: each is worth their own $15 plus $25 to their store's manager. Baseline
     and Century both have a manager on this period, so both carry the uplift. */
  const plan = M.attPlan(sheet(HEAD +
    'Baseline,Mya Ward,Yes,ok\n' +
    'Century Dr,Robert Wydick,Yes,ok\n'));
  const b = M.attBuild(plan, ROSTER, {}, T);
  ok('two budtenders gaining is $80, not $30 — the manager\'s share is real money',
     b.gain === (15 + 25) * 2 && b.net === 80);

  /* River has no manager on this period, so nobody gets the per-head uplift for Noah. */
  const solo = M.attBuild(M.attPlan(sheet(HEAD + 'River Rd,Noah Pinkerton,Yes,ok\n')), ROSTER, {}, T);
  ok('a budtender whose store has no manager on the period is worth only their own $15',
     solo.gain === 15 && solo.net === 15);

  /* The removing direction. Ticked today, the file says No. */
  const off = M.attBuild(M.attPlan(sheet(HEAD + 'Baseline,Mya Ward,No,Unpaid day 8/21.\n')),
                         ROSTER, { mya_ward: { att: true } }, T);
  ok('un-ticking somebody is counted as a LOSS, with the manager\'s share',
     off.losing === 1 && off.lose === 40 && off.net === -40);

  /* This is the number on the button, so it has to reconcile against the real math rather than
     against a second opinion written here. */
  const withAtt = M.calcBud({ employee_id: 'mya_ward', storeSlug: 'baseline', txn: 400, aov: 40, discount: 0 },
                            T, { mya_ward: { att: true, spiff: 0 } });
  const without = M.calcBud({ employee_id: 'mya_ward', storeSlug: 'baseline', txn: 400, aov: 40, discount: 0 },
                            T, { mya_ward: { att: false, spiff: 0 } });
  const mgrOn  = M.calcMgr({ employee_id: 'dean_deloof', storeSlug: 'baseline', target: 100, sales: 0, discount: 1, aov: 0 },
                           T, { mya_ward: { att: true } }, [{ employee_id: 'mya_ward', storeSlug: 'baseline' }]);
  const mgrOff = M.calcMgr({ employee_id: 'dean_deloof', storeSlug: 'baseline', target: 100, sales: 0, discount: 1, aov: 0 },
                           T, {}, [{ employee_id: 'mya_ward', storeSlug: 'baseline' }]);
  const real = (withAtt.payroll - without.payroll) + (mgrOn.payroll - mgrOff.payroll);
  const claimed = M.attBuild(M.attPlan(sheet(HEAD + 'Baseline,Mya Ward,Yes,ok\n')), ROSTER, {}, T).net;
  ok('the figure on the button equals what the bonus math actually pays out ($' + real + ')',
     claimed === real);
}

console.log('\nAlready correct, and the refusals');
{
  const same = M.attBuild(M.attPlan(sheet(HEAD + 'Baseline,Mya Ward,Yes,ok\n')),
                          ROSTER, { mya_ward: { att: true } }, T);
  ok('somebody already ticked correctly is not counted as a change',
     same.change.length === 0 && same.same.length === 1 && same.net === 0);

  /* "Pending" is neither Yes nor No. Reading it as No strips $40 on a word Mike had not decided. */
  const huh = M.attBuild(M.attPlan(sheet(HEAD +
    'Baseline,Mya Ward,Pending,awaiting ASM confirmation\n' +
    'Baseline,Taner Perri,No,punch issues\n')), ROSTER, { mya_ward: { att: true } }, T);
  ok('an unreadable Yes/No is skipped and named, never read as No',
     huh.unreadable.some(x => x.name === 'Mya Ward' && x.raw === 'Pending') &&
     !huh.change.some(x => x.id === 'mya_ward'));

  /* Two rows for one person means the match is wrong or the file has them twice; taking the last
     silently overwrites the first, and here that is a bonus appearing or vanishing with no trace. */
  const dupe = M.attBuild(M.attPlan(sheet(HEAD +
    'Baseline,Mya Ward,Yes,first\n' +
    'Baseline,"Ward, Mya",No,second\n')), ROSTER, {}, T);
  ok('a second row for the same person is refused, not allowed to overwrite the first',
     dupe.change.length === 1 && dupe.unreadable.some(x => x.dupe));

  /* A blank cell is an absence, not a No. */
  const blank = M.attBuild(M.attPlan(sheet(HEAD +
    'Baseline,Mya Ward,,\nBaseline,Taner Perri,No,x\nBaseline,Zachary Babcock,Yes,x\n')),
    ROSTER, { mya_ward: { att: true } }, T);
  ok('a blank Yes/No does not strip an existing tick',
     !blank.change.some(x => x.id === 'mya_ward'));

  ok('yes/no spellings are all accepted',
     ['Yes', 'YES', 'y', 'TRUE', '1'].every(v =>
       M.attBuild(M.attPlan(sheet(HEAD + 'Baseline,Mya Ward,' + v + ',x\n')), ROSTER, {}, T)
        .change.some(c => c.want === true)));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nattendance import: all passed');
process.exit(fail ? 1 : 0);
