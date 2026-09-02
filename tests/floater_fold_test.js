#!/usr/bin/env node
/* ─── Floaters — one person, one row ──────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/floater_fold_test.js
 *
 * WHY THIS EXISTS
 * A floater picks up shifts wherever they are needed, so Leaderboard sends them once PER STORE.
 * Drew Phillips arrived on the 2026-08-17 period as two rows — Portland (37 txn, $901) and River
 * (24 txn, $557) — and a person split in two is wrong in three ways, only the first of which is
 * cosmetic:
 *
 *   1. He is listed twice on a payroll screen.
 *   2. He QUALIFIES FOR NOTHING. The transaction bar is 200; 37 and 24 each miss it, while his real
 *      61 would at least be judged on its merits. Splitting a person is how they silently earn zero.
 *   3. He would be counted toward TWO stores' team-attendance headcount, paying two managers $25
 *      each for one person showing up.
 *
 * Sky's rule (2026-09-02): aggregate the performance, book them to Corporate, let the sales still
 * count toward each store's own performance but not toward AOV, discount or attendance.
 *
 * WHAT THE ARITHMETIC HAS TO GET RIGHT, and it is the whole risk here: discount is a RATE and AOV
 * is a RATIO. Averaging either across two stores produces a number nobody can reproduce from the
 * transactions — the discount has to be weighted by sales, and the AOV recomputed from the totals.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* The engine's copy, from the shipped Code.gs — the fold runs server-side, before inputs and SPIFF
   are attached, so this is the only implementation of it. */
const E = (function () {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const grab = (name) => {
    const i = gs.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
    let d = 0;
    for (let k = gs.indexOf('{', i); k < gs.length; k++) {
      if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
    }
    throw new Error('unterminated ' + name);
  };
  return new Function(grab('foldFloaters_') + '; return { fold: foldFloaters_ };')();
})();

/* Drew as he actually arrived on the 2026-08-17 period. */
const drewPortland = { employee_id: 'andrew_phillips', name: 'Drew Phillips', is_floater: true,
                       storeName: 'Portland', storeSlug: 'portland', store_id: 'portland-rd',
                       txn: 37, sales: 901, discount: 0.0036, aov: 24.36 };
const drewRiver    = { employee_id: 'andrew_phillips', name: 'Drew Phillips', is_floater: true,
                       storeName: 'River', storeSlug: 'river', store_id: 'river-rd',
                       txn: 24, sales: 557, discount: 0.0036, aov: 23.23 };
const settled      = { employee_id: 'mya_ward', name: 'Mya Ward', is_floater: false,
                       storeName: 'Baseline', storeSlug: 'baseline', store_id: 'hillsboro',
                       txn: 168, sales: 5681, discount: 0.0124, aov: 33.81 };

console.log('\nThe fold');
{
  const live = { budtenders: [drewPortland, drewRiver, settled].map(r => Object.assign({}, r)) };
  E.fold(live);
  ok('two rows become one', live.budtenders.length === 2);
  const drew = live.budtenders.find(r => r.employee_id === 'andrew_phillips');
  ok('transactions add up (37 + 24)', drew.txn === 61);
  ok('sales add up (901 + 557)', near(drew.sales, 1458));
  /* 61 is still under the 200 bar, so he does not suddenly qualify — the point is that he is judged
     on his real volume rather than on two halves of it, whichever way that lands. */
  ok('...which is still his real volume, not a promotion', drew.txn === 37 + 24);

  ok('he is booked to Corporate', drew.storeSlug === 'corporate' && drew.storeName === 'Corporate' &&
     drew.store_id === 'corporate');
  ok('the stores he actually worked are recorded on the row',
     Array.isArray(drew.folded_from) && drew.folded_from.join('+') === 'Portland+River');
  ok('a settled budtender is untouched',
     live.budtenders.some(r => r.employee_id === 'mya_ward' && r.storeSlug === 'baseline'));
}

console.log('\nThe arithmetic that averaging would get wrong');
{
  /* Different rates at each store, so a plain mean and a sales-weighted figure disagree. */
  const a = Object.assign({}, drewPortland, { sales: 1000, txn: 40, discount: 0.01 });
  const b = Object.assign({}, drewRiver,    { sales: 3000, txn: 60, discount: 0.05 });
  const live = { budtenders: [a, b] };
  E.fold(live);
  const drew = live.budtenders[0];
  /* (0.01×1000 + 0.05×3000) / 4000 = 0.04. The mean would be 0.03 — a whole percentage point of
     discount rate, which is several tiers on this scheme. */
  ok('discount is weighted by sales, not averaged', near(drew.discount, 0.04));
  ok('...and the plain mean would have been wrong', !near(0.03, drew.discount));
  /* 4000 / 100 = 40. The mean of the two AOVs (25 and 50) is 37.50 — the AOV target is $33, so the
     two answers land on opposite sides of it. */
  ok('AOV is recomputed from the totals', near(drew.aov, 40));
  ok('...and the mean of the two AOVs would have been wrong', !near(37.5, drew.aov));
}

console.log('\nThe refusals');
{
  /* A floater whose row never resolved to a registry person keeps its own line. Folding on a name
     is how one person's transactions get attached to another. */
  const ghost1 = { employee_id: '', name: 'Ghost', is_floater: true, storeSlug: 'portland', txn: 5, sales: 100 };
  const ghost2 = { employee_id: '', name: 'Ghost', is_floater: true, storeSlug: 'river', txn: 6, sales: 120 };
  const live = { budtenders: [ghost1, ghost2] };
  E.fold(live);
  ok('unstamped rows are never merged, even with the same name', live.budtenders.length === 2);

  /* Two different people who are both floaters must not collapse into each other. */
  const p1 = { employee_id: 'a_one', name: 'A One', is_floater: true, storeSlug: 'portland', txn: 5, sales: 100, discount: 0 };
  const p2 = { employee_id: 'b_two', name: 'B Two', is_floater: true, storeSlug: 'river', txn: 6, sales: 120, discount: 0 };
  const live2 = { budtenders: [p1, p2] };
  E.fold(live2);
  ok('two different floaters stay two people', live2.budtenders.length === 2);

  /* Nobody flagged: the function must be a no-op, not a silent re-shape of every row. */
  const plain = [Object.assign({}, settled), Object.assign({}, settled, { employee_id: 'x' })];
  const live3 = { budtenders: plain.map(r => Object.assign({}, r)) };
  E.fold(live3);
  ok('a period with no floaters is left exactly as it was',
     live3.budtenders.length === 2 && live3.budtenders[0].storeSlug === 'baseline' &&
     live3.floaters === undefined);

  /* One row for a floater is still one row — and must not acquire a merge label it did not earn. */
  const live4 = { budtenders: [Object.assign({}, drewPortland)] };
  E.fold(live4);
  ok('a floater who worked one store keeps that store and is not labelled merged',
     live4.budtenders.length === 1 && live4.budtenders[0].storeSlug === 'portland' &&
     !live4.budtenders[0].folded_from);
}

console.log('\nWhat the move to Corporate actually buys');
{
  /* THE ATTENDANCE EXCLUSION IS THE STORE SLUG. Crew's teamA term counts budtenders whose slug
     matches the manager's, so a floater booked to `corporate` is out of every store's headcount by
     construction. Without the move he would pay two managers $25 each for one person. */
  const live = { budtenders: [Object.assign({}, drewPortland), Object.assign({}, drewRiver)] };
  E.fold(live);
  const drew = live.budtenders[0];
  ok('no store can count him toward team attendance any more',
     !['portland', 'river', 'baseline', 'center', 'commercial', 'bend'].includes(drew.storeSlug));
  /* The reported summary is what the screen and any future report read, so it carries both the
     identity and what was merged rather than just a count. */
  ok('the period reports which people were folded and from where',
     live.floaters.length === 1 && live.floaters[0].employee_id === 'andrew_phillips' &&
     live.floaters[0].stores.join('+') === 'Portland+River' && live.floaters[0].txn === 61);
}

/* ── One person, one section ─────────────────────────────────────────────────────────────────────
   A floater who is ALSO an admin or manager can arrive twice: their own row, plus a budtender row
   for the shifts they covered. Mike and Tawny both float occasionally, and Mike IS the admin row.
   That pays two bonuses for one fortnight and counts the person's sales in both sections — and
   nothing about the output looks wrong, which is exactly why it has to be detected. */
const D = (function () {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const i = gs.indexOf('function dualRoleRows_(');
  if (i < 0) throw new Error('missing dualRoleRows_ in Code.gs');
  let d = 0, end = -1;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) { end = k + 1; break; } }
  }
  return new Function(gs.slice(i, end) + '; return { check: dualRoleRows_ };')();
})();

console.log('\nOne person, one section');
{
  const mikeAdmin = { employee_id: 'mike_kettler', name: 'Mike Kettler', target: 100, actual: 115, stores: 6 };
  const mikeBud   = { employee_id: 'mike_kettler', name: 'Mike Kettler', storeSlug: 'corporate',
                      txn: 30, sales: 800, discount: 0.004, aov: 26.7 };
  const live = { admin: mikeAdmin, managers: [], budtenders: [mikeBud, Object.assign({}, settled)] };
  D.check(live);
  ok('somebody in two sections is reported',
     live.dual_role && live.dual_role.length === 1 &&
     live.dual_role[0].employee_id === 'mike_kettler');
  ok('...and the report names BOTH sections, since that is the decision to make',
     live.dual_role[0].sections.sort().join('+') === 'admin+budtender');
  /* Reported, NOT resolved — and both rows are meant to pay. Sky, 2026-09-02: a floater can earn on
     the shifts they cover; in practice they rarely clear the 200-transaction bar, and SPIFF is the
     likelier earner since it is per-unit. Dropping either row would withhold money that is owed. */
  ok('neither row is silently removed', live.budtenders.length === 2 && !!live.admin);

  const mgrDual = { employee_id: 'tawny_vierra', name: 'Tawny Vierra', storeSlug: 'river', txn: 1, sales: 20 };
  const live2 = { admin: null,
                  managers: [{ employee_id: 'tawny_vierra', name: 'Tawny Vierra', storeSlug: 'river' }],
                  budtenders: [mgrDual] };
  D.check(live2);
  ok('a manager who also floats is caught the same way',
     live2.dual_role[0].sections.sort().join('+') === 'budtender+manager');

  /* The ordinary period must stay silent, or the warning becomes furniture. */
  const clean = { admin: { employee_id: 'mike_kettler', name: 'Mike Kettler' },
                  managers: [{ employee_id: 'dean_deloof', name: 'Dean Deloof' }],
                  budtenders: [Object.assign({}, settled)] };
  D.check(clean);
  ok('a normal period reports nothing', clean.dual_role === undefined);

  /* Unstamped rows are already reported as `unmatched`; pairing two of them on a blank id would
     invent a clash that is really just two unresolved people. */
  const blanks = { admin: null, managers: [{ employee_id: '', name: 'One' }],
                   budtenders: [{ employee_id: '', name: 'Two' }] };
  D.check(blanks);
  ok('rows with no employee_id are not paired with each other', blanks.dual_role === undefined);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nfloater fold: all passed');
process.exit(fail ? 1 : 0);
