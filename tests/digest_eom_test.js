#!/usr/bin/env node
/* ─── The Monday recap must not ask for a pick that has already been made ───────────────────────
 *
 *   RUN:  node tests/digest_eom_test.js
 *
 * WHY THIS EXISTS
 * Sky: "Recap email is showing we need to pick Sept EOM, we have and it's Noah. How can we check
 * before erroneously showing the current EOM as the old one and the reminder to select the current
 * month when it already has been."
 *
 * Both halves were one omission. cfg.eom carries `since`, and nothing compared it to the month the
 * email was asking about — so the first-Monday recap on 7 September asked for a pick Mike had made
 * on 1 September, under a hardcoded line reading "Noah Pinkerton has held it since last month".
 * That sentence was false twice: the reign began that same month, and the CURRENT holder was being
 * described as the old one. Live value at the time, for the record:
 *
 *     cfg.eom = {"employee_id":"noah_pinkerton","since":"2026-09-01T19:43:19.774Z","set_by":"mike"}
 *
 * WHAT MUST HOLD:
 *   1. A pick made this month means no ask — not in the card, and not in the subject line.
 *   2. The month is compared in STORE time. cfg.eom holds an instant, and an evening pick on the
 *      last of the month is next month's date in UTC — the same trap that makes
 *      toISOString().slice(0,10) return tomorrow from 5pm PT.
 *   3. A holder from an earlier month is named by that month, never "last month".
 *   4. Anything undatable or unreadable ASKS. The cost of asking twice is a line of email; the
 *      cost of staying quiet is a month with no Employee of the Month.
 *   5. A settled pick produces NO BLOCK AT ALL — not a quieter one. Sky, 2026-09-08: "it should go
 *      silent in the email recap, we only need to identify what needs to be addressed, nothing
 *      else." The first cut of this fix rendered an "already chosen" card instead, on the argument
 *      that `since` records when a pick was SET rather than which month it was FOR, so a late pick
 *      for the previous month could be swallowed. That is his call to make and he made it: the
 *      recap is a list of things to do, and a settled pick is not one. `?action=digest`'s JSON
 *      still reports it, which is where that distinction belongs.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* A REAL Los Angeles formatter, because the timezone IS the thing under test — a stub that just
   read UTC would make assertion 2 pass while the bug it names sat in the code. */
const fmt = (date, tz, pat) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit' }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  if (pat === 'yyyy-MM') return p.year + '-' + p.month;
  if (pat === 'yyyy-MM-dd') return p.year + '-' + p.month + '-' + p.day;
  if (pat === 'MMM d') {
    const m = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(date);
    return m + ' ' + Number(p.day);
  }
  throw new Error('unhandled pattern ' + pat);
};

let KV = null, KV_THROWS = false;
const build = () => new Function('Utilities', 'GXCore', 'STORE_TZ', 'displayNameOf_',
  'MONTH_NAMES_',
  fnSrc('eomMonthOf_') + '\n' + fnSrc('eomCurrent_') + '\n' + fnSrc('digestEom_') +
  '\n; return { eomMonthOf_: eomMonthOf_, digestEom_: digestEom_ };'
)({ formatDate: fmt },
  { getKv: () => { if (KV_THROWS) throw new Error('GX Core unreachable'); return KV; } },
  'America/Los_Angeles',
  r => r.display,
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
   'October', 'November', 'December']);

const M = build();
const BY_ID = { noah_pinkerton: { display: 'Noah Pinkerton' },
                ayla_mcarthur:  { display: 'Ayla McArthur' } };
/* digestEom_ is handed a date built from the store-time calendar day, as todayInStoreTz_ makes it. */
const day = (y, m, d) => new Date(y, m - 1, d);
const setKv = v => { KV_THROWS = false; KV = v === null ? null : JSON.stringify(v); };

console.log('\nThe real September that started this');
{
  setKv({ employee_id: 'noah_pinkerton', since: '2026-09-01T19:43:19.774Z', set_by: 'mike' });
  const e = M.digestEom_(BY_ID, day(2026, 9, 7));       // the first Monday, when it went out
  ok('September is recognized as already picked', e.picked === true);
  ok('and it names Noah', e.holder === 'Noah Pinkerton');
  ok('with who chose him', e.set_by === 'mike');
  ok('and the date, so a late pick for August would be visible', e.since_on === 'Sep 1');
}

console.log('\nA holder from an earlier month — still an ask, and NAMED');
{
  setKv({ employee_id: 'ayla_mcarthur', since: '2026-07-02T18:00:00.000Z', set_by: 'sky' });
  const e = M.digestEom_(BY_ID, day(2026, 9, 7));
  ok('September is NOT picked', e.picked === false);
  ok('the holding month is named as July, not "last month"', e.since_month === 'July');
  ok('and the month being asked for is September', e.month === 'September');
}

console.log('\nSTORE TIME, not UTC — the trap that would put this bug straight back');
{
  /* 2026-10-01T02:00:00Z is 30 September, 7pm, in Salem. It belongs to September. Read as UTC it
     is October, and the first-Monday-of-October recap would call it already picked and never ask. */
  setKv({ employee_id: 'noah_pinkerton', since: '2026-10-01T02:00:00.000Z', set_by: 'mike' });
  ok('an evening pick on the 30th is a SEPTEMBER pick', M.eomMonthOf_('2026-10-01T02:00:00.000Z') === '2026-09');
  ok('…so September reads as picked', M.digestEom_(BY_ID, day(2026, 9, 30)).picked === true);
  ok('…and October still ASKS', M.digestEom_(BY_ID, day(2026, 10, 5)).picked === false);
  ok('…naming September as when the holder took it',
     M.digestEom_(BY_ID, day(2026, 10, 5)).since_month === 'September');
}

console.log('\nEverything undatable or unreadable ASKS');
{
  setKv({ employee_id: 'noah_pinkerton', since: '', set_by: 'mike' });
  ok('a reign with no date asks', M.digestEom_(BY_ID, day(2026, 9, 7)).picked === false);
  setKv({ employee_id: 'noah_pinkerton', since: 'not a date', set_by: 'mike' });
  ok('an unparseable date asks', M.digestEom_(BY_ID, day(2026, 9, 7)).picked === false);
  ok('and eomMonthOf_ says so rather than guessing', M.eomMonthOf_('not a date') === '');
  setKv(null);
  const unset = M.digestEom_(BY_ID, day(2026, 9, 7));
  ok('an unset cfg.eom asks', unset.picked === false && unset.state === 'unset');
  KV = '';
  const nobody = M.digestEom_(BY_ID, day(2026, 9, 7));
  ok('a deliberate nobody asks', nobody.picked === false && nobody.state === 'nobody');
  KV_THROWS = true;
  const err = M.digestEom_(BY_ID, day(2026, 9, 7));
  ok('an unreachable GX Core asks rather than going quiet',
     err.picked === false && err.state === 'unknown');
}

console.log('\nA settled pick leaves the email entirely — no card, no subject line');
{
  /* Source-level: the render and the subject are built inside sendDigest_, which needs a live
     roster and MailApp. What a push gate can hold is that ONE decision drops it, so the card and
     the subject cannot disagree, and that no "already chosen" branch survives to be maintained. */
  /* Sliced to the end of digestData_'s return object rather than by a character count — a fixed
     window silently stops matching the moment a comment above the line grows. */
  const dStart = SRC.indexOf('var eomFacts =');
  const data = SRC.slice(dStart, SRC.indexOf('eom_facts: eomFacts', dStart) + 40);
  ok('digestData_ drops a settled pick before anything renders',
     /eom:\s*\(eomFacts\s*&&\s*eomFacts\.picked\)\s*\?\s*null\s*:\s*eomFacts/.test(data));
  ok('…and still keeps the facts for the preview JSON', /eom_facts:\s*eomFacts/.test(data));

  const card = SRC.slice(SRC.indexOf('if (d.eom) {'), SRC.indexOf('if (d.fresh.length)'));
  ok('the card has no "already chosen" branch left to keep in step',
     card.indexOf('Already chosen') < 0 && card.indexOf('eomDone') < 0);
  ok('it is the ask, and only the ask', card.indexOf('Pick ') > 0);

  const subj = SRC.slice(SRC.indexOf('var subject ='), SRC.indexOf('var subject =') + 700);
  ok('the subject needs no second condition — presence IS outstanding',
     /\(d\.eom\s*\?\s*'pick '/.test(subj) && subj.indexOf('!d.eom.picked') < 0);

  ok('the hardcoded "since last month" is gone from the rendered output',
     SRC.indexOf("' has held it since last month.'") < 0);
  ok('…and the month it names is read from the data',
     /has held it since '\s*\+/.test(SRC) && SRC.indexOf('d.eom.since_month') > 0);
  ok('the preview still tells "already chosen" apart from "not the first Monday"',
     SRC.indexOf('eom_picked: !!(d.eom_facts && d.eom_facts.picked)') > 0);
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
