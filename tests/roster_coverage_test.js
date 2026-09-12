#!/usr/bin/env node
/* ─── A whole store missing from the pay figures ──────────────────────────────────────────────────
 *
 *   RUN:  node tests/roster_coverage_test.js
 *
 * WHY THIS EXISTS
 * A blip in the sales feed does not throw. GX Core catches a per-store failure, carries on, and
 * answers ok:true with that store's sellers simply absent; Crew's mapping is field-by-field, so it
 * maps a short list as faithfully as a complete one. `incentiveBlockers_` guarded exactly two
 * things — an open period and an unreadable SPIFF — so approval would freeze it.
 *
 * THE DANGEROUS CASE IS ONE STORE, NOT ALL OF THEM. Every store failing gives $0 for everybody,
 * which is conspicuous: somebody queries it and nobody approves it. ONE store failing gives a
 * screen where every person shown has entirely plausible figures and one store's staff are just not
 * there. No total looks short, because the missing people never contributed to one. The only
 * evidence is an absence, and nobody spots an absence on a payroll screen.
 *
 * AND THE GUARD FOR THE SMALLER RISK ALREADY EXISTED, with this exact argument: `spiff_unreadable`
 * refuses because vendor money would freeze at $0 for everyone. But SPIFF cancels out of `payroll`
 * entirely and the Capstone export carries payroll ONLY — while the seller list DECIDES payroll.
 *
 * THE TRAP THIS PINS HARDEST is the two store vocabularies. `storeSlug` is LEADERBOARD's
 * (baseline / century / portland / river); `home_store` on the registry is GX Core's
 * (hillsboro / bend / portland-rd / river-rd). Only `center` and `commercial` coincide. A coverage
 * check that compares the wrong one reports four of six stores missing on a perfectly good period,
 * every single time — which is how a guard gets switched off in its first week.
 */
'use strict';
const fs = require('fs');
const path = __dirname + '/../apps-script/Code.gs';
const gs = fs.readFileSync(path, 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

/* The doc block sits ABOVE the function, so `grab` alone cannot see it — and the reason this guard
   must survive `stores_failed` lives in that comment, which is exactly the thing being pinned. */
function grabWithDoc(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  const start = gs.lastIndexOf('/**', i);
  const between = gs.slice(gs.indexOf('*/', start) + 2, i).trim();
  return (start < 0 || between) ? grab(name) : gs.slice(start, i) + grab(name);
}

function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}

/* The engine's own copies. `coverageStoreNames_` reaches for GXCore.getStores, so it gets a stub
   that answers the way the registry does; a throw there must degrade to the slug, never break a
   refusal that is otherwise correct. */
const E = (function () {
  const src = grab('rosterCoverage_') + '\n' + grab('coverageStoreNames_') + '\n' +
              grab('incentiveBlockers_') + '\n' +
              'return { cov: rosterCoverage_, names: coverageStoreNames_, blockers: incentiveBlockers_ };';
  /* storeTotals_ is the OTHER half of incentiveBlockers_ since 2026-09-11 — coverage asks whether a
     store is absent, that asks whether the figures that did arrive add up. Stubbed to 'ok' here so
     these assertions keep testing coverage alone; its own rules are in independent_checks_test.js. */
  const storeTotalsStub = () => ({ state: 'ok', stores: [], mismatches: [] });
  const GXCore = {
    getStores: () => ([
      { store_id: 'portland-rd', display_name: 'Portland Rd' },
      { store_id: 'river-rd',    display_name: 'River Rd' },
      { store_id: 'hillsboro',   display_name: 'Baseline' },
      { store_id: 'bend',        display_name: 'Century' },
      { store_id: 'center',      display_name: 'Center' },
      { store_id: 'commercial',  display_name: 'Commercial' }
    ])
  };
  return new Function('GXCore', 'storeTotals_', src)(GXCore, storeTotalsStub);
})();

/* Six stores with staff, exactly as the registry reports them today (6 active each). */
const ROSTER_STORES = { 'portland-rd': 6, 'river-rd': 6, 'hillsboro': 6, 'bend': 6,
                        'center': 6, 'commercial': 6 };

/* A seller row as it reaches coverage — AFTER stampEmployeeIds_, so it carries BOTH slugs, and the
   two disagree on four of the six stores. That disagreement is the point of the fixture. */
const seller = (name, lbSlug, coreSlug) =>
  ({ name, storeSlug: lbSlug, store_id: coreSlug, txn: 210, sales: 7000, discount: 0.009, aov: 33 });

const FULL = () => ([
  seller('A Bud', 'portland', 'portland-rd'), seller('B Bud', 'river', 'river-rd'),
  seller('C Bud', 'baseline', 'hillsboro'),   seller('D Bud', 'century', 'bend'),
  seller('E Bud', 'center', 'center'),        seller('F Bud', 'commercial', 'commercial')
]);

const period = (buds, extra) => Object.assign(
  { payPeriod: { start: '2026-08-17', end: '2026-08-30', current: false },
    budtenders: buds, managers: [], roster_stores: ROSTER_STORES }, extra || {});

console.log('\nA complete period');
{
  const live = period(FULL());
  const c = E.cov(live);
  ok('reads as covered', c.ok === true && c.checked === true);
  ok('no store reported missing', c.missing.length === 0);
  ok('all six stores expected and all six seen', c.expected.length === 6 && c.seen.length === 6);
  ok('approval is not blocked', E.blockers(live, false, false, false).length === 0);
}

console.log('\nThe store vocabularies must not be confused');
{
  /* If the check compared `storeSlug` against `home_store`, portland/river/baseline/century would
     each miss and this period — which is complete — would be refused four stores at a time. */
  const live = period(FULL());
  const c = E.cov(live);
  ok('a complete period is NOT reported as four stores short',
     c.missing.length === 0);
  ok('the seen set is in registry vocabulary, not Leaderboard\'s',
     c.seen.indexOf('portland-rd') >= 0 && c.seen.indexOf('portland') < 0 &&
     c.seen.indexOf('hillsboro') >= 0 && c.seen.indexOf('baseline') < 0);
}

console.log('\nOne store missing — the dangerous case');
{
  const live = period(FULL().filter(r => r.store_id !== 'river-rd'));
  const c = E.cov(live);
  ok('coverage fails', c.ok === false && c.reason === 'store_missing');
  ok('and names the store', c.missing.length === 1 && c.missing[0] === 'river-rd');

  const b = E.blockers(live, false, false, false);
  ok('approval is blocked', b.length === 1 && b[0].code === 'store_missing');
  ok('the refusal names the store by its DISPLAY name, not its slug',
     /River Rd/.test(b[0].message) && !/river-rd/.test(b[0].message));
  ok('...and says how many the roster expected there', /6 active/.test(b[0].message));
  /* The message has to carry the reason a reader cannot see it for themselves, or it reads as
     pedantry about a screen that looks fine. */
  ok('...and says why nothing downstream would catch it',
     /looks exactly like a store that sold nothing/.test(b[0].message));
}

console.log('\nEvery store missing — conspicuous, but still refused');
{
  const live = period([]);
  const c = E.cov(live);
  ok('coverage fails', c.ok === false && c.reason === 'store_missing');
  ok('all six are named', c.missing.length === 6);
  ok('approval is blocked', E.blockers(live, false, false, false).length === 1);
}

console.log('\nThe acknowledgement — a store really can sell nothing');
{
  const live = period(FULL().filter(r => r.store_id !== 'bend'));
  ok('blocked without it', E.blockers(live, false, false, false).length === 1);
  ok('cleared with it', E.blockers(live, false, false, true).length === 0);
  /* It must clear ONLY coverage. An ack for one refusal quietly clearing another is how a guard
     becomes decorative. */
  const both = period(FULL().filter(r => r.store_id !== 'bend'), { spiff: { ok: false, error: 'x' } });
  const b = E.blockers(both, true, false, true);
  ok('...and does not clear an unreadable SPIFF', b.length === 1 && b[0].code === 'spiff_unreadable');
  const b2 = E.blockers(both, true, true, false);
  ok('...nor does the SPIFF ack clear a missing store',
     b2.length === 1 && b2[0].code === 'store_missing');
}

console.log('\nAn unreadable registry is not a clean one');
{
  /* stampEmployeeIds_ sets roster_stores to null when GXCore.getEmployees() throws. An empty object
     would mean "no store expected anybody", which reads as full coverage — the silent pass this
     whole guard exists to prevent. */
  const live = period(FULL(), { roster_stores: null });
  const c = E.cov(live);
  ok('coverage does not report ok', c.ok === false);
  ok('and says WHY it could not tell', c.reason === 'registry_unreadable');
  ok('it did not quietly claim to have checked', c.checked === false);
  const b = E.blockers(live, false, false, false);
  ok('approval is blocked', b.length === 1 && b[0].code === 'coverage_unknown');
  ok('cleared by the same acknowledgement', E.blockers(live, false, false, true).length === 0);
}

console.log('\nA genuinely empty roster is different from an unreadable one');
{
  const live = period(FULL(), { roster_stores: {} });
  const c = E.cov(live);
  ok('it reports as checked', c.checked === true);
  ok('and passes, because no store had anybody to sell', c.ok === true);
  /* THAT PASS IS SATISFIED BY A PAYLOAD WHERE NOTHING WAS MISSING ANYWAY, so on its own it would
     also be satisfied by a check that never ran — which is the "cleared by coincidence" shape this
     whole feature spent a day on. Discriminating is the real claim: the SAME short payload passes
     against an empty roster and fails against a populated one. */
  const short = FULL().filter(r => r.store_id !== 'river-rd');
  const empty = E.cov(period(short, { roster_stores: {} }));
  const full  = E.cov(period(short.map(r => Object.assign({}, r))));
  ok('...and the same short payload FAILS once the roster expects that store',
     empty.ok === true && full.ok === false && full.missing[0] === 'river-rd');
}

console.log('\nManagers count as sellers for coverage');
{
  /* A store whose only row is its manager is represented. Ignoring managers would refuse a small
     store that happens to have no budtender row on the period. */
  const live = period(FULL().filter(r => r.store_id !== 'center'));
  live.managers = [seller('M Boss', 'center', 'center')];
  delete live.coverage;
  ok('the store is seen', E.cov(live).ok === true);
}

console.log('\nCorporate is not a store');
{
  /* Sky, Mike and the floaters live there, and the fold books every floater there too. A store
     with no sellers is a signal; corporate with no sellers is Tuesday. `roster_stores` is built
     with corporate already excluded — this pins that a corporate row does not become an
     expectation by arriving in the seen set either. */
  const live = period(FULL());
  live.budtenders.push(seller('Floater', 'corporate', 'corporate'));
  delete live.coverage;
  const c = E.cov(live);
  ok('corporate is never expected', c.expected.indexOf('corporate') < 0);
  ok('and a corporate row does not break coverage', c.ok === true);
  /* Same weakness as above: a pass here is also what a dead check looks like. The claim with teeth
     is that a corporate row cannot COVER FOR a missing store — which is exactly what a folded
     floater is, since the fold moves them off the store they actually worked. */
  const noRiver = FULL().filter(r => r.store_id !== 'river-rd');
  noRiver.push(seller('Floater', 'corporate', 'corporate'));
  const c2 = E.cov(period(noRiver));
  ok('...and a corporate row does not stand in for the store that is missing',
     c2.ok === false && c2.missing.length === 1 && c2.missing[0] === 'river-rd');
}

console.log('\nThe answer is computed once per payload');
{
  const live = period(FULL().filter(r => r.store_id !== 'river-rd'));
  const first = E.cov(live);
  ok('it is cached on the payload', live.coverage === first);
  /* incentiveBlockers_ runs up to three times on one approval; each one re-reading the registry
     would put three sheet reads on a screen that already took 20-30s. */
  live.roster_stores = ROSTER_STORES;
  ok('a second call returns the same object', E.cov(live) === first);
}

console.log('\nBoth write paths are shaped by ONE function');
{
  /* The floater fold went missing on approval, was fixed, then was found missing on the send
     preview a week later; the preview also summed the computed payroll where approval sums the
     figure a human recorded. Three breaks by three routes is two call sites that agree only while
     somebody remembers to edit both. */
  const approve = grab('incentiveApprove_');
  const send    = grab('incentiveSend_');
  ok('approval does not fetch performance itself', !/fetchLivePerf_\(/.test(approve));
  ok('the send preview does not fetch performance itself', !/fetchLivePerf_\(/.test(send));
  ok('approval goes through perfForWrite_', /perfForWrite_\(/.test(approve));
  ok('the send preview goes through perfForWrite_', /perfForWrite_\(/.test(send));
  ok('neither re-folds floaters by hand', !/foldFloaters_\(/.test(approve) && !/foldFloaters_\(/.test(send));
  ok('neither re-stamps by hand', !/stampEmployeeIds_\(/.test(approve) && !/stampEmployeeIds_\(/.test(send));

  /* The one function that IS allowed to call it directly, and why: the probe reports the raw
     stages so a broken join can be told apart from a broken fetch. */
  const probe = grab('incentiveProbe_');
  ok('the diagnostic probe still reads the raw fetch', /fetchLivePerf_\(/.test(probe));

  /* And the practice split lives in the shared helper, so neither path can get it wrong alone.
     Storage key where the window belongs scores $0 SPIFF for everybody; window where the storage
     key belongs writes an approval into the REAL pay period. */
  const helper = grab('perfForWrite_');
  ok('the practice window/key split is inside the helper',
     /isPracticePeriod_\(/.test(helper) && /practiceSource_\(/.test(helper));
}

console.log('\nThe screen reports it; only the write paths refuse');
{
  const screen = grab('getIncentive_');
  ok('the screen asks for coverage', /rosterCoverage_\(/.test(screen));
  ok('the screen does not refuse on it', !/incentiveBlockers_\(/.test(screen));
  const send = grab('incentiveSend_');
  ok('the send preview reports it too', /coverage: rosterCoverage_\(/.test(send));
}

console.log('\nAn approval that overrides it says so on the record');
{
  const approve = grab('incentiveApprove_');
  ok('the acknowledgement is read from the request', /coverage_ok/.test(approve));
  ok('and lands in the note frozen onto every row',
     /no sellers from/.test(approve) && /noteTxt/.test(approve));
  ok('an unverified registry is recorded differently from a known-missing store',
     /store coverage unverified/.test(approve));
  /* The old remedy line named spiff_unavailable=yes whatever had gone wrong, which would send
     whoever read a coverage refusal to set a flag that does not clear it. */
  ok('the remedy names the flag for the blocker that actually fired',
     /coverage_ok=yes/.test(approve) && /spiff_unavailable=yes/.test(approve));
}

console.log('\nWhy this is NOT made redundant by GX Core\'s stores_failed');
{
  /* stores_failed reports a store that ERRORED. This reports a store that returned nobody for any
     reason — a credential that authenticates and hands back an empty set, a 200 with nothing in
     it — which raises nothing anywhere. It also holds when cfg.incentiveEngine selects
     Leaderboard, which sends no stores_failed at all. Pinned as a comment so the next reader does
     not delete this as duplication once the precise check lands. */
  const src = grabWithDoc('rosterCoverage_');
  ok('the reason it survives stores_failed is written down',
     /stores_failed/.test(src) && /DO NOT DELETE/i.test(src));
  ok('...including that it covers the Leaderboard engine too', /Leaderboard/.test(src));
}

console.log(fail ? `\n✗ ${fail} failed\n` : '\nroster coverage: all passed\n');
process.exit(fail ? 1 : 0);
