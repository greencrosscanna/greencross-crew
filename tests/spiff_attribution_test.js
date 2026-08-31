#!/usr/bin/env node
/* ─── Which pay period a SPIFF program's money belongs to, and which scheme an approval uses ──────
 *
 *   RUN:  node tests/spiff_attribution_test.js    (from the repo root; no deps, no network, no login)
 *
 * WHY THIS EXISTS
 * Two bugs found on 2026-08-31, both on the path that writes crew_incentive_history — the one table
 * in this app that cannot be edited afterwards.
 *
 *   1. SPIFF measures a program over ITS OWN window (spiff's sellthrough_ runs prog.start_date →
 *      prog.end_date, never per fortnight), and Crew attributed that single figure to every pay
 *      period the window OVERLAPPED. A program spanning two fortnights paid its full total into
 *      both, and the closed one showed money earned after it ended.
 *
 *   2. incentiveApprove_ computed against `live.thresholds` — LEADERBOARD's copy of the scheme —
 *      while the screen computed against GX Core's. They agree until Leaderboard cannot reach Core,
 *      at which point LB falls back to its own defaults and the record diverges from the display.
 *      Unlike SPIFF, thresholds move PAYROLL.
 *
 * Neither is visible in the incentive math test: that one drives the arithmetic, and these two
 * decide what gets FED to it. A wrong answer here is arithmetically perfect and still wrong.
 */
'use strict';
const fs = require('fs');

let fail = 0;
function bad(msg) { fail++; console.log('  ✗ ' + msg); }
function ok(msg) { console.log('  ✓ ' + msg); }

/* Same extraction seam the incentive math test uses: run the SHIPPED engine source, not a copy. */
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
  return new Function(grab('spiffShare_') + grab('spiffPeriodOf_') + grab('spiffPeriodRangeStart_') +
    grab('spiffPeriodMatch_') + grab('spiffIsPeriodWindow_') + grab('spiffPayable_') + grab('deepSame_') +
    '; return { share: spiffShare_, match: spiffPeriodMatch_, periodOf: spiffPeriodOf_,' +
    '           rangeStart: spiffPeriodRangeStart_, isPeriod: spiffIsPeriodWindow_,' +
    '           payable: spiffPayable_, same: deepSame_ };')();
})();

/* ── The pay period under test: the first live one, 2026-08-17 → 2026-08-30 ──────────────────── */
const PP = ['2026-08-17', '2026-08-30'];
const share = (a, b) => E.share(a, b, PP[0], PP[1]).share;

/* A program that IS the pay period. The ordinary case, and it must not become collateral damage of
   fixing the ones that are not. */
(function () {
  if (share('2026-08-17', '2026-08-30') !== 1) bad('a program matching the period exactly must be wholly in it');
  else ok('a program matching the pay period exactly counts here in full');
})();

/* SKY'S TOLERANCE, which is why this is majority and not containment: "SPIFFs run concurrent to the
   pay period, and a historical date that does not line up is a typo." Off by a day or two at either
   end still plainly belongs to this fortnight, and containment would have thrown all of it away. */
(function () {
  const cases = [['2026-08-15', '2026-08-30'], ['2026-08-17', '2026-09-01'],
                 ['2026-08-16', '2026-08-29'], ['2026-08-19', '2026-08-30'],
                 ['2026-08-18', '2026-08-28']];
  for (const [a, b] of cases) {
    if (!(share(a, b) > 0.5)) { bad('a program ' + a + ' → ' + b + ' is a date typo, not a different period'); return; }
  }
  ok('a window a day or two out of line still counts here (' + cases.length + ' cases)');
})();

/* THE BUG. A program spanning two fortnights used to pay its full total into both. Under majority
   it can reach at most one — and where it is split evenly it reaches NEITHER, which is the honest
   answer rather than a coin toss. */
(function () {
  const prev = ['2026-08-03', '2026-08-16'];
  const next = ['2026-08-31', '2026-09-13'];
  const inP = (a, b, pp) => E.share(a, b, pp[0], pp[1]).share > 0.5;
  const straddles = [['2026-08-10', '2026-08-23'],   // half in the previous period, half in this
                     ['2026-08-24', '2026-09-06'],   // half in this, half in the next
                     ['2026-08-03', '2026-08-30'],   // exactly two whole periods
                     ['2026-06-01', '2026-08-31']];  // a long vendor programme
  for (const [a, b] of straddles) {
    const hits = [prev, PP, next].filter(pp => inP(a, b, pp)).length;
    if (hits > 1) { bad('program ' + a + ' → ' + b + ' counts in ' + hits + ' periods — the same money twice'); return; }
  }
  ok('no program can be counted into more than one pay period (' + straddles.length + ' spanning cases)');
})();

(function () {
  /* An even split reaches neither, and is therefore REPORTED rather than paid — assert the share is
     what the caller uses to build that report, not merely that it is below the bar. */
  const v = E.share('2026-08-03', '2026-08-30', PP[0], PP[1]);
  if (v.share !== 0.5) bad('two whole periods must read as exactly half in each, got ' + v.share);
  else ok('a program covering two whole periods reads 0.50 — counted nowhere, reported instead');
  const long = E.share('2026-06-01', '2026-08-31', PP[0], PP[1]).share;
  if (!(long > 0 && long < 0.5)) bad('a long programme must overlap without owning the period, got ' + long);
  else ok('a long vendor programme overlaps this period without belonging to it');
})();

/* No overlap at all is 0, not a negative or a NaN — a neighbouring fortnight's programme must be
   silently absent, not reported as straddling. */
(function () {
  for (const [a, b] of [['2026-08-03', '2026-08-16'], ['2026-08-31', '2026-09-13'], ['2025-01-01', '2025-01-14']]) {
    const v = E.share(a, b, PP[0], PP[1]);
    if (v.bad || v.share !== 0) { bad('a programme outside the period must read exactly 0, got ' + JSON.stringify(v)); return; }
  }
  ok('a programme in a neighbouring period reads 0 and is not reported as straddling');
})();

/* Junk dates are FLAGGED, never scored. `bad` and `share: 0` are different claims: one says "this
   row is broken, look at it", the other says "this row is fine and belongs elsewhere". The progress
   cache has already shipped ISO timestamps and Date objects into these columns once. */
(function () {
  const junk = [['', '2026-08-30'], ['2026-08-17', ''], ['not-a-date', '2026-08-30'],
                ['2026-08-30', '2026-08-17'],                       // end before start
                ['2026-08-17T00:00:00.000Z', '2026-08-30']];        // the shape that already escaped once
  for (const [a, b] of junk) {
    if (!E.share(a, b, PP[0], PP[1]).bad) { bad('a malformed window must be flagged, not scored: ' + JSON.stringify([a, b])); return; }
  }
  ok('malformed program windows are flagged for a human, never scored as 0 (' + junk.length + ' cases)');
})();

/* A single-day programme inside the period is wholly in it — the divisor is an INCLUSIVE day count,
   so a start==end window must not divide by zero. */
(function () {
  const v = E.share('2026-08-20', '2026-08-20', PP[0], PP[1]);
  if (v.share !== 1) bad('a one-day programme inside the period must be wholly in it, got ' + v.share);
  else ok('a one-day programme does not divide by zero');
})();

/* DST. The period arithmetic runs at noon UTC for the same reason computedPeriods_ does: a day count
   taken at midnight lands on the wrong side of a clock change twice a year. November 1 2026 is the
   fall-back in Los Angeles. */
(function () {
  const v = E.share('2026-10-26', '2026-11-08', '2026-10-26', '2026-11-08');
  if (v.share !== 1) bad('a period spanning the DST change must read as whole, got ' + v.share);
  else ok('a window spanning the DST change still measures a whole period');
})();

/* ── The pay period is the match (Sky, 2026-08-31) ──────────────────────────────────────────────
 *
 * "Let's use the pay period as the match. It is the thing that doesn't change and they are always
 * linked… the program dates are selected by pay period ranges, so they should always match."
 *
 * It cannot be read off the FIELD of that name — SPIFF's pay-period dropdown has its save key
 * stripped (spiff.js:1118) and only fills the date boxes, so `pay_period` is empty on every program
 * and matching on it alone would pay nobody. But the dropdown fills the dates FROM the period, so
 * the exact window is that link. Exact first, the old share-of-window rule only for historical
 * records whose dates never lined up.
 */
const M = (a, b, pp0, pp1, stored) => E.match(a, b, pp0 || PP[0], pp1 || PP[1], stored);

(function () {
  /* THE CASE SKY DESCRIBED, and the reason he asked for this: a programme that ENDED on the 30th
     and one that STARTED on the 31st, both still marked active because nobody has closed the first
     one yet. Exact windows separate them without status having an opinion. */
  const NEXT = ['2026-08-31', '2026-09-13'];
  const ended = ['2026-08-17', '2026-08-30'], started = ['2026-08-31', '2026-09-13'];

  const a = M(ended[0], ended[1]);
  if (!a.match || a.how !== 'exact_window') bad('the programme that just ended must match the period that just ended, exactly');
  else ok('a programme whose dates ARE the pay period matches it exactly');

  if (M(started[0], started[1]).match) bad('the programme that starts tomorrow must NOT count in the period that just ended');
  else ok('a programme starting the day after does not count in the period that just ended');

  if (!E.match(started[0], started[1], NEXT[0], NEXT[1], '').match) bad('the new programme must match the new period');
  else ok('the new programme matches the new period');

  if (E.match(ended[0], ended[1], NEXT[0], NEXT[1], '').match) bad('the ended programme must not leak into the new period');
  else ok('two overlapping-in-time programmes are told apart with no reference to status');

  /* An exact window must not need the majority rule to agree with it — that is the whole point of
     promoting it above the heuristic. */
  if (M(ended[0], ended[1]).share !== 1) bad('an exact window is wholly in its period');
  else ok('an exact match does not fall through to a share calculation');
})();

(function () {
  /* The stored field WINS when it is ever populated — Sky's rule, kept for the day SPIFF starts
     writing it. Accepts every shape that column has held: a bare date, a human range, and the ISO
     timestamp it leaked before the text pin. */
  for (const shape of ['2026-08-17', '2026-08-17 - 2026-08-30', '2026-08-17T00:00:00.000Z']) {
    if (E.periodOf(shape) !== '2026-08-17') { bad('pay_period start not read out of ' + JSON.stringify(shape)); return; }
  }
  ok('the period start is read from every shape that column has held');

  /* ONLY A RANGE IS A PAY PERIOD. The same column holds two different facts: the record editor's
     picker writes a range, and the 22 programmes seeded from the .docx files on 2026-08-30 carry a
     SINGLE date that is four or five days after the programme ENDED — the payout date. None of the
     11 populated seed values lands on a pay-period start, while their DATES are exact periods. */
  if (E.rangeStart('2026-08-17 - 2026-08-30') !== '2026-08-17') bad('a range must yield its start');
  for (const notRange of ['2026-02-20', '2026-08-17T00:00:00.000Z', '', null]) {
    if (E.rangeStart(notRange)) { bad('a single date is NOT a pay period range: ' + JSON.stringify(notRange)); return; }
  }
  ok('only a two-date range is read as a pay period; a lone date is not');

  /* THE REGRESSION THIS EXISTS FOR. Real seeded records: dates that ARE a pay period, and a
     pay_period column holding the payout date. Letting that column win excluded them from EVERY
     period at once — payable, dates fine, so nothing else would have reported them. */
  const SEEDED = [['2026-02-02', '2026-02-15', '2026-02-20'],
                  ['2025-11-24', '2025-12-07', '2025-12-12']];
  for (const [a, b, payout] of SEEDED) {
    const r = E.match(a, b, a, b, payout);
    if (!r.match || r.how !== 'exact_window') {
      bad('a seeded programme (' + a + '..' + b + ', payout ' + payout + ') must match its own ' +
          'period on its DATES — its pay_period column is a payout date, not a period'); return;
    }
    if (r.ignored_pay_period !== payout) { bad('the ignored payout date must be reported, got ' + r.ignored_pay_period); return; }
  }
  ok('a seeded programme matches on its dates, and the payout date it carries is reported not obeyed');

  /* THE INVARIANT, stated on its own: a stored pay_period must never SILENTLY cost a programme a
     match its dates alone would have earned. It may disambiguate; it may raise a conflict somebody
     can see; it may not quietly subtract. */
  const withPayout = E.match('2026-02-02', '2026-02-15', '2026-02-02', '2026-02-15', '2026-02-20').match;
  const without    = E.match('2026-02-02', '2026-02-15', '2026-02-02', '2026-02-15', '').match;
  if (without && !withPayout) bad('a pay_period value silently removed a match the dates had earned — the whole bug');
  else ok('a pay_period value can never silently subtract a match the dates earned');

  /* A RANGE that disagrees with exact dates. It PAYS ONCE — in the period the range names — and the
     disagreement is reported on BOTH sides. An earlier cut raised it only where the dates pointed,
     which is the period that pays nothing: approving the period the range named handed over the
     money with an empty conflicts list and nothing to look at. */
  const c = M('2026-08-17', '2026-08-30', null, null, '2026-08-03 - 2026-08-16');
  if (c.match || !c.conflict) bad('standing on the period the DATES name, a contradicting range must raise a conflict');
  else ok('the period the dates name reports the conflict and pays nothing');

  const paid = E.match('2026-08-17', '2026-08-30', '2026-08-03', '2026-08-16', '2026-08-03 - 2026-08-16');
  if (!paid.match || paid.how !== 'pay_period') bad('the period the RANGE names is the one that pays — exactly once, no double pay, no silent zero');
  else ok('the period the range names is the one that pays');

  /* The cross-check that makes that paying side report it. Only fires when the dates are exactly
     ANOTHER pay period — dates merely EDITED off the period are legitimate ("they stay editable —
     not every program lines up with payroll") and must not become noise. */
  const ANCHOR = '2026-08-17', DAYS = 14;
  if (!E.isPeriod('2026-08-17', '2026-08-30', ANCHOR, DAYS)) bad('the anchor period must read as a period window');
  if (!E.isPeriod('2026-02-02', '2026-02-15', ANCHOR, DAYS)) bad('a period 14 fortnights back must read as one');
  if (!E.isPeriod('2025-11-24', '2025-12-07', ANCHOR, DAYS)) bad('a 2025 period must read as one — the picker no longer reaches it, the arithmetic does');
  if (E.isPeriod('2026-08-18', '2026-08-31', ANCHOR, DAYS)) bad('right length, off the cadence — must NOT read as a period');
  if (E.isPeriod('2026-08-17', '2026-08-29', ANCHOR, DAYS)) bad('on the cadence, wrong length — must NOT read as a period');
  if (E.isPeriod('2026-06-01', '2026-06-30', ANCHOR, DAYS)) bad('a 30-day programme is not a pay period');
  ok('a period window is recognised by cadence AND length, forward and back');

  /* THE ACTUAL VALUE IN THE LIVE CACHE, pinned as a literal. On 2026-08-31 the cache held 38 rows
     reading exactly this. It is a RANGE, so a raw `stored === pp_start` is false and rung 1 would
     never fire on data where it visibly should — the same trap that made ?action=progress report $0
     for everyone. This test is the one that fails if anybody "simplifies" spiffPeriodOf_ away. */
  (function () {
    const REAL = '2026-08-17 - 2026-08-30';
    if (REAL === PP[0]) bad('the stored range must NOT equal the period start — that is the whole point');
    const hit = M('2026-08-17', '2026-08-30', null, null, REAL);
    if (!hit.match || hit.how !== 'pay_period') {
      bad('the live cache value ' + JSON.stringify(REAL) + ' must match its period on rung 1, got ' + JSON.stringify(hit));
    } else if (E.match('2026-08-17', '2026-08-30', '2026-08-31', '2026-09-13', REAL).match) {
      bad('the live cache value must not also match the NEXT period');
    } else ok('the live cache range value matches on rung 1 and only for its own period');
  })();

  /* Empty in every spelling falls through to the dates — 25 rows in that same cache are blank, so
     this is not a hypothetical branch; it is how BeGoat and anything like it gets judged at all. */
  for (const empty of ['', null, undefined, '   ', '2026-02-20']) {
    const r = M('2026-08-17', '2026-08-30', null, null, empty);
    if (!r.match || r.how !== 'exact_window') { bad('an empty pay_period must fall through to the dates, not pay nobody: ' + JSON.stringify(empty)); return; }
  }
  ok('an empty pay_period falls through to the dates rather than paying nobody');
})();

(function () {
  /* The heuristic survives, demoted, for the historical records Sky said he would fix — they still
     pay, and they are named so the list empties itself as the dates are corrected. */
  const off = M('2026-08-15', '2026-08-30');
  if (!off.match || off.how !== 'majority') bad('a date typo must still pay, via the majority rule');
  else ok('a historical date typo still pays, flagged as majority-matched rather than exact');

  const split = M('2026-08-10', '2026-08-23');
  if (split.match) bad('a programme split evenly across two periods must not pay in either');
  else ok('a programme no period owns still pays in neither');
})();

/* ── Is the money owed at all? (Sky, 2026-08-31: BeGoat is not active) ──────────────────────────
 *
 * Crew had no status check whatever — every cache row whose dates lined up was paid. SPIFF's
 * vocabulary is three words and the middle one is a trap: `closed` means PAID OUT, not cancelled.
 */
(function () {
  /* CLOSED MUST PAY. This is the one that would quietly break every approval there will ever be: a
     pay period is approved AFTER it ends, by which time its programs have closed. A filter of
     status === 'active' zeroes the vendor column on every period anybody approves, and a $0 there
     is indistinguishable from a fortnight in which nobody earned. */
  if (!E.payable('closed').pay) bad('CLOSED must pay — it is SPIFF\'s word for "paid out", and every approved period is full of them');
  else ok('a closed program still pays — approval happens after the period ends');

  if (!E.payable('active').pay) bad('an active program must pay');
  else ok('an active program pays');

  /* Draft never started; nothing is owed. */
  if (E.payable('draft').pay) bad('a draft program must not pay — it never ran');
  else ok('a draft program does not pay');

  /* THE BeGoat CASE. SPIFF resolves status at read time by joining to its `programs` tab, so ''
     means that tab has no row for this program_id — the record is gone. Not paid, and named in the
     report rather than dropped, because "SPIFF lost a row" and "nothing was earned" need completely
     different fixes and a silent filter is where that difference disappears. */
  for (const gone of ['', null, undefined, '   ']) {
    const v = E.payable(gone);
    if (v.pay) { bad('a program SPIFF has no record of must not pay: ' + JSON.stringify(gone)); return; }
    if (!/no record/i.test(v.why)) { bad('an orphaned program must say WHY it was skipped, got: ' + v.why); return; }
  }
  ok('a program SPIFF has no record of does not pay, and says so by name');

  /* Case and whitespace are SPIFF's formatting, not a policy difference. */
  for (const st of ['ACTIVE', ' Closed ', 'Active']) {
    if (!E.payable(st).pay) { bad('status matching must not depend on casing or padding: ' + JSON.stringify(st)); return; }
  }
  ok('status matching survives casing and padding');

  /* An UNRECOGNISED status is counted and flagged, not withheld. Withholding wrongly produces a $0
     that looks exactly like a quiet fortnight; counting wrongly produces a number somebody queries. */
  const odd = E.payable('paused');
  if (!odd.pay) bad('an unrecognised status must be counted, not silently withheld — $0 hides, a number gets questioned');
  else if (!odd.why) bad('an unrecognised status must be reported even though it is counted');
  else ok('an unrecognised status is counted AND flagged, never silently withheld');
})();

/* ── The scheme an approval is computed against ─────────────────────────────────────────────────
   deepSame_ exists so a KEY-ORDER difference between Leaderboard's payload and Core's parsed value
   is not reported as a policy disagreement — that would send somebody hunting a difference that is
   not there, and the fastest way to make a warning useless is to have it cry wolf. */
(function () {
  const core = { budtender: { aovTarget: 33, discountMaxPct: 1.5, aovBonus: 100 },
                 manager: { salesTiers: [{ pct: 100, bonus: 500 }] }, admin: { tiers: [] } };
  const reordered = { admin: { tiers: [] },
                      manager: { salesTiers: [{ bonus: 500, pct: 100 }] },
                      budtender: { discountMaxPct: 1.5, aovBonus: 100, aovTarget: 33 } };
  if (!E.same(core, reordered)) bad('a key-order difference must not read as a threshold disagreement');
  else ok('key order is not a threshold disagreement');

  const moved = JSON.parse(JSON.stringify(core));
  moved.budtender.discountMaxPct = 1.4;
  if (E.same(core, moved)) bad('a moved threshold MUST read as a disagreement — it is what changes the bonus');
  else ok('a moved threshold reads as a disagreement, however small');

  /* Order inside a tier LIST is significant — tiers are matched high-to-low, first hit wins, so a
     reordered list is a different scheme even holding identical values. */
  const swapped = { t: [{ pct: 100, bonus: 500 }, { pct: 90, bonus: 250 }] };
  const unswapped = { t: [{ pct: 90, bonus: 250 }, { pct: 100, bonus: 500 }] };
  if (E.same(swapped, unswapped)) bad('tier ORDER is significant — a reordered tier list is a different scheme');
  else ok('a reordered tier list reads as a different scheme (tiers are order-sensitive)');

  /* Missing and null are not the same as absent-and-equal. */
  if (E.same({ a: 1 }, { a: 1, b: undefined })) bad('an extra key must not compare equal');
  else ok('an extra key is a difference');
})();

/* THE INVARIANT BEHIND BOTH FIXES, stated once: the engine must not read the thresholds Leaderboard
   sent. Grepping the shipped source is the only way to hold this — it is an absence, and an absence
   cannot be asserted by calling anything. */
(function () {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const body = (name) => {
    const i = gs.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    let d = 0;
    for (let k = gs.indexOf('{', i); k < gs.length; k++) {
      if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
    }
  };
  const approve = body('incentiveApprove_');
  if (!/approvalThresholds_\(/.test(approve)) {
    bad('incentiveApprove_ must take its scheme from approvalThresholds_ (GX Core), not the payload');
  } else if (/var T = live\.thresholds/.test(approve)) {
    bad('incentiveApprove_ is computing against Leaderboard\'s thresholds again — that is the bug');
  } else ok('incentiveApprove_ computes against GX Core\'s scheme, not Leaderboard\'s');

  if (!/applySpiffEarnings_\(/.test(approve)) {
    bad('incentiveApprove_ must fold SPIFF in before computing, or it freezes $0 for everyone measured');
  } else ok('incentiveApprove_ folds the measured SPIFF in before it computes');

  /* The refusals. Both are the same rule — an unreadable source must not freeze as an empty one —
     and both are one deleted line away from becoming silent. */
  if (!/spiff_unavailable/.test(approve)) bad('a failed SPIFF read must refuse rather than freeze $0 for everybody');
  else ok('a failed SPIFF read refuses, with an acknowledgement that is recorded');

  /* The payability check must run BEFORE the window is scored, or a dead program that also straddles
     two fortnights gets reported as missing money and hand-entered — the worst outcome of the three. */
  const fold = body('applySpiffEarnings_');
  const iPay = fold.indexOf('spiffPayable_('), iShare = fold.indexOf('spiffShare_(');
  if (iPay < 0) bad('applySpiffEarnings_ must ask whether a program is payable at all');
  else if (iShare >= 0 && iPay > iShare) {
    bad('payability must be checked BEFORE the window — otherwise a dead program lands in the ' +
        '"vendor money nobody can see" report and gets entered by hand');
  } else ok('payability is settled before the pay-period window is scored');

  /* The degradation guard. Without it, an older SPIFF deployment that does not resolve status makes
     every row look orphaned and zeroes the entire column. */
  /* The match must go through spiffPeriodMatch_, not straight to the share — the exact rungs are
     the point, and calling spiffShare_ directly here is how they get quietly bypassed. */
  if (!/spiffPeriodMatch_\(/.test(fold)) {
    bad('applySpiffEarnings_ must match through spiffPeriodMatch_ (pay period, then exact window, ' +
        'then majority) rather than going straight to a share of the window');
  } else ok('the fold matches on the pay period first and the share only as a fallback');

  /* The paying-side conflict report. Its absence is invisible — the money still moves and the run
     looks clean — so the only thing that can hold it is a check on the source. */
  if (!/spiffIsPeriodWindow_\(/.test(fold)) {
    bad('applySpiffEarnings_ must cross-check a rung-1 match against the dates, or a contradicting ' +
        'range pays with an EMPTY conflicts list on the very period that hands over the money');
  } else ok('a contradicting range is reported on the paying side, not only where the dates point');

  if (!/hasStatus/.test(fold)) {
    bad('applySpiffEarnings_ must skip the payability filter when SPIFF sends no status at all — ' +
        'otherwise an older SPIFF deployment zeroes every vendor dollar');
  } else ok('a SPIFF deployment that sends no status degrades to dates-only rather than paying nobody');
})();
/* ── The preview must run the same checks as the approval ────────────────────────────────────────
 *
 * `?action=incentive_send&preview=1` exists so an approval email can be dry-run before a real
 * fortnight closes, and it is the route used to show somebody what approving would do. Until
 * 2026-08-31 it computed its own totals down a separate branch that never called
 * applySpiffEarnings_ — so it folded no vendor money and reported none of the checks, while its
 * PAYROLL figure agreed with approval's exactly, because SPIFF cancels out of payroll on both
 * sides. A dry run that is right about the one number nobody doubts, and silent on everything you
 * would check it against, is worse than no dry run: it gets trusted.
 *
 * Source-level, because the behaviour needs a live Leaderboard, a live SPIFF and a session. What
 * can be pinned without them is that the preview branch still folds SPIFF and still reports
 * through the SAME builders approval uses — which is what stops the two drifting apart again. */
(function previewRunsTheSameChecks() {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const body = (name) => {
    const i = gs.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    let d = 0;
    for (let k = gs.indexOf('{', i); k < gs.length; k++) {
      if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
    }
    throw new Error('unterminated ' + name);
  };

  const send = body('incentiveSend_'), approve = body('incentiveApprove_');
  const prev = send.slice(send.indexOf('if (preview) {'), send.indexOf('} else {'));

  if (!/applySpiffEarnings_\(/.test(prev)) {
    bad('the preview branch no longer folds SPIFF — it will report $0 vendor money and every check empty');
  }
  if (!/approvalThresholds_\(/.test(prev)) {
    bad('the preview branch no longer takes thresholds from GX Core');
  }
  ['incentiveSpiffReport_', 'incentiveBlockers_'].forEach((fn) => {
    if (!prev.includes(fn)) bad('the preview branch no longer calls ' + fn + ' — the two paths can now disagree');
    if (!approve.includes(fn)) bad('incentiveApprove_ no longer calls ' + fn + ' — the two paths can now disagree');
  });

  /* One builder, not two. A second inline copy of the report is how they diverged the first time. */
  const reports = (gs.match(/period_conflicts:\s*(s\.|\(live\.spiff)/g) || []).length;
  if (reports !== 1) bad('expected exactly one SPIFF report builder, found ' + reports);

  /* The preview must NOT refuse — it writes nothing and is deliberately allowed on an open period. */
  if (/if \(_blocked\.length\)|return \{ ok: false, error: _open/.test(prev)) {
    bad('the preview now refuses on a blocker; it must report `would_block` and carry on');
  }
  if (!/would_block/.test(send)) bad('the preview no longer returns would_block');

  console.log('  ✓ the send preview folds SPIFF and reports through the same builders as approval');
})();

/* The `__internal` flag on incentive_history is an AUTH BYPASS, and `p` is the query string.
 * `?action=incentive_history&__internal=1` arrived as a truthy STRING and walked past the deploy
 * secret, returning every name, sales figure and payout amount in a closed period to anyone with
 * the /exec URL. Verified against the live deployment on 2026-08-31. A query parameter is always a
 * string, so the guard has to compare against the boolean the one real caller passes. */
(function internalFlagIsNotSpoofable() {
  const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  const i = gs.indexOf('function incentiveHistory_(');
  const gate = gs.slice(i, i + 1400);
  if (!/p\.__internal !== true/.test(gate)) {
    bad('incentive_history no longer requires __internal === true — ?__internal=1 bypasses the deploy secret');
  }
  if (/if \(!p\.__internal &&/.test(gs)) {
    bad('a truthy __internal check is back: a query string can set it and skip the secret');
  }
  console.log('  ✓ __internal cannot be set from a query string to bypass the deploy secret');
})();

console.log(fail ? '\n' + fail + ' FAILED' : '\nspiff attribution: all passed');
process.exit(fail ? 1 : 0);
