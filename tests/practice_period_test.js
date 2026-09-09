#!/usr/bin/env node
/* ─── The practice pay period is isolated, and isolated BY CONSTRUCTION ────────────────────────
 *
 *   RUN:  node tests/practice_period_test.js
 *
 * WHY THIS EXISTS
 * "Build a practice pay period so changes can be tested without touching real pay." A rehearsal
 * surface for the one path in this app that cannot be tried out: approving is immutable, and the
 * step below this on the build order is "rehearse the whole pay period close with Mike, start to
 * finish" — which until now would have meant paying people to find out whether the buttons work.
 *
 * THE FEATURE HAS EXACTLY ONE WAY TO GO CATASTROPHICALLY WRONG, and it is not a wrong number on a
 * screen. A practice period rehearses a REAL fortnight's figures, so two different strings are in
 * play at once: `practice-2026-08-17` is where the rows are stored, and `2026-08-17` is the window
 * whose performance is fetched and scored. Use the storage key where the window belongs and SPIFF
 * silently scores zero for everybody. Use the window where the storage key belongs and a rehearsal
 * writes attendance ticks, a frozen history row and an approval into THE REAL PAY PERIOD — which
 * is not a rehearsal at all, it is an unreviewed approval nobody knows happened.
 *
 * Nothing about that failure is visible. Both strings are valid pay-period identifiers, both find
 * rows, both render a complete-looking screen. So the separation is asserted here in both
 * directions, on both paths that touch money.
 *
 * WHAT MUST HOLD:
 *   1. A practice key is the prefix plus a real date, strictly — anything looser lets a crafted or
 *      mistyped parameter choose a tab.
 *   2. Every incentive tab is routed through one function, and it cannot cross the streams.
 *   3. The screen fetches the SOURCE window and stores under the KEY. Ditto approval.
 *   4. SPIFF is folded on the real window, before the key is swapped in.
 *   5. Enumerating what the company has closed never sees practice.
 *   6. Every document that leaves the app says PRACTICE on it — the filename, the page, the email
 *      subject, the CSV.
 *   7. Reset can only ever name a practice tab.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));
const bad = (l) => { fail++; console.log('  ✗ ' + l); };

const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
/* The prefix is LIFTED FROM THE SOURCE, never retyped here. A test carrying its own copy of the
   one string this whole feature keys on would keep passing after somebody changed it. */
const PREFIX = (GS.match(/var PRACTICE_PREFIX = '[^']*';/) || [])[0];
if (!PREFIX) { console.log('  ✗ PRACTICE_PREFIX is gone from Code.gs'); process.exit(1); }

/* Strip comments before any source-level check. Twice in this repo a check of this kind has failed
   on the prose explaining the code rather than on the code, which forces the next person to delete
   the explanation to get a green gate. */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ── 1. What counts as a practice key ────────────────────────────────────────────────────────── */
console.log('\nA practice key is the prefix plus a real date, and nothing else is');
{
  const P = new Function(
    PREFIX + fnSrc(GS, 'isPracticePeriod_') + fnSrc(GS, 'practiceSource_') + fnSrc(GS, 'practiceKeyFor_') +
    '; return { is: isPracticePeriod_, src: practiceSource_, key: practiceKeyFor_ };')();

  ok('the real thing is a practice key', P.is('practice-2026-08-17'));
  /* Every one of these is a string somebody could reach this code with — a typo, a truncated
     parameter, a URL somebody built by hand. A loose test (indexOf, startsWith) accepts most of
     them, and each acceptance is a write landing in a tab nobody meant. */
  const notKeys = ['2026-08-17', '', 'practice', 'practice-', 'practice-2026-8-17',
                   'practice-2026-08-17-extra', 'PRACTICE-2026-08-17', ' practice-2026-08-17',
                   'xpractice-2026-08-17', 'practice-abcd-ef-gh'];
  const wrong = notKeys.filter(k => P.is(k));
  ok('nothing else is (' + notKeys.length + ' near-misses)' +
     (wrong.length ? ' — accepted ' + JSON.stringify(wrong) : ''), !wrong.length);

  ok('the source window comes back out of the key', P.src('practice-2026-08-17') === '2026-08-17');
  /* '' rather than the input: a caller that forgot the guard gets an empty window and an obvious
     failure, instead of quietly fetching the period it was handed. */
  ok('a non-key yields no window at all, rather than itself', P.src('2026-08-17') === '');
  ok('key and source are inverses', P.src(P.key('2026-08-17')) === '2026-08-17');
}

/* ── 2. One function routes every tab ────────────────────────────────────────────────────────── */
console.log('\nEvery incentive tab is routed through incTab_, and the streams never cross');
{
  const T = new Function(
    PREFIX + fnSrc(GS, 'isPracticePeriod_') + fnSrc(GS, 'incTab_') + '; return incTab_;')();
  /* The five tabs that hold anything keyed on a pay period. If a sixth is ever added and not
     listed here, the reset assertion further down is what catches it. */
  const TABS = ['crew_incentive_history', 'crew_incentive_inputs', 'crew_incentive_workflow',
                'crew_incentive_voided', 'crew_incentive_schemes'];
  const real = TABS.filter(t => T(t, '2026-08-17') === t);
  ok('a real period reads and writes the real tabs', real.length === TABS.length);
  const prac = TABS.filter(t => T(t, 'practice-2026-08-17') === t + '_practice');
  ok('a practice period reads and writes the practice twins', prac.length === TABS.length);
  ok('no argument at all means the real tab — every caller written before practice existed',
     T('crew_incentive_history', undefined) === 'crew_incentive_history' &&
     T('crew_incentive_history', '') === 'crew_incentive_history');
  /* THE ONE THAT MATTERS. A practice key must never be able to name the real history tab. */
  ok('a practice key can never name a real tab',
     !TABS.some(t => T(t, 'practice-2026-08-17') === t));
}

/* ── 3. The screen: fetch the window, store under the key ───────────────────────────────────── */
console.log('\ngetIncentive_ fetches the real fortnight and stores under the practice key');
{
  /* getIncentive_ is run for real, with every collaborator injected so the two strings can be
     watched as they travel. The practice helpers are the SHIPPED ones — stubbing those would test
     the stub. */
  const seen = { fetched: null, spiff: null, inputs: null, wf: null, history: [] };
  const run = (want) => {
    seen.fetched = seen.spiff = seen.inputs = seen.wf = null;
    seen.history = [];
    const src =
      PREFIX + fnSrc(GS, 'isPracticePeriod_') + fnSrc(GS, 'practiceSource_') + fnSrc(GS, 'practiceInfo_') +
      /* THE SHIPPED perfForWrite_, not a stub. The window/key split moved inside it, and it is the
         thing under test here — a stub would answer whatever this file decided it should. */
      fnSrc(GS, 'perfForWrite_') +
      fnSrc(GS, 'getIncentive_') + '; return getIncentive_;';
    const fn = new Function(
      'requireCrew_', 'historyPeriods_', 'incentiveHistory_', 'periodList_', 'canApprove_',
      'canEdit_', 'inputsFor_', 'fetchLivePerf_', 'incentiveThresholds_', 'stampEmployeeIds_',
      'foldFloaters_', 'dualRoleRows_', 'applySpiffEarnings_', 'wfGet_', 'rosterCoverage_', src)(
      () => ({ ok: true, user: 'mike', role: 'admin' }),
      (pp) => { seen.history.push(pp); return []; },
      () => ({ ok: true }),
      () => [],
      () => false, () => true,
      (pp) => { seen.inputs = pp; return {}; },
      (pp) => { seen.fetched = pp;
                return { ok: true, payPeriod: { start: pp, end: '2026-08-30', current: false },
                         budtenders: [], managers: [] }; },
      () => ({ ok: true, thresholds: { budtender: {} } }),
      () => {}, () => {}, () => {},
      (live, pp) => { seen.spiff = pp; },
      (pp) => { seen.wf = pp; return null; },
      () => ({ ok: true, checked: true, missing: [] }));
    return fn({ pp_start: want });
  };

  const d = run('practice-2026-08-17');
  ok('the PERFORMANCE fetch asks for the real fortnight', seen.fetched === '2026-08-17');
  /* The whole reason the fold runs before the remap. A vendor program is matched on its dates, and
     `practice-2026-08-17` matches no program's dates at all — so getting this wrong does not error,
     it scores every SPIFF at zero and the vendor column reads as a quiet fortnight. */
  ok('SPIFF is folded on the real fortnight, not on the key', seen.spiff === '2026-08-17');
  /* And the other direction — the one that would write into real pay. */
  ok('the INPUTS are read under the practice key', seen.inputs === 'practice-2026-08-17');
  ok('the WORKFLOW row is read under the practice key', seen.wf === 'practice-2026-08-17');
  /* The browser posts payPeriod.start on every save, send, approve and reopen. Rewriting it here is
     what lets the browser stay ignorant of practice keys — and what would send every one of those
     writes at the real period if it were left alone. */
  ok('payPeriod.start is the KEY, which is what the browser posts back',
     d.payPeriod.start === 'practice-2026-08-17');
  ok('the real fortnight is still carried, for the label and the dates',
     d.practice && d.practice.source_start === '2026-08-17' && d.payPeriod.end === '2026-08-30');
  /* `source` KEEPS ITS TWO VALUES. It answers one question — live computation or frozen record —
     and `isImported` is derived from it in the browser, guarding every money path on the screen.
     Giving it a third value is what let an APPROVED practice period be recomputed by the live math
     over frozen rows that carry no target: $2,220 on screen against a record frozen at $970, and
     Approve offered on a period already approved. Found 2026-09-09, an hour after shipping. */
  ok('source still says only where the figures come from', d.source === 'live');
  ok('and `practice` is the separate fact — whose figures they are', !!d.practice);
  ok('resetting is offered on a role, not on the period being editable',
     d.can_reset_practice === true);
  ok('a practice period is never treated as the current one', d.payPeriod.current === false);

  const r = run('2026-08-17');
  ok('an ordinary period is untouched by any of this',
     seen.fetched === '2026-08-17' && seen.spiff === '2026-08-17' &&
     seen.inputs === '2026-08-17' && seen.wf === '2026-08-17' &&
     r.source === 'live' && !r.practice && r.can_reset_practice === undefined);
}

/* ── 3b. An APPROVED practice period is read as a frozen record, not recomputed ─────────────── */
console.log('\nAn approved practice period is served like any other closed record');
{
  const G = decomment(fnSrc(GS, 'getIncentive_'));
  const branch = G.slice(G.indexOf('if (isPracticePeriod_(want) &&'),
                         G.indexOf("if (want && importedBy[want]) {"));
  ok('it is served from its own history tab', /historyPeriods_\(want\)/.test(branch) &&
     /incentiveHistory_\(/.test(branch));
  /* THE BUG, stated as an absence. Setting source here is what bypassed every money guard in the
     browser — `isImported` is derived from it, and the live calculators then ran over history rows
     that have no `target`, scoring every manager against a missing goal. */
  ok('it does NOT relabel `source` — the browser derives isImported from it',
     !/\bph\.source\s*=/.test(branch));
  ok('it is read-only', /ph\.can_edit = false/.test(branch));
  ok('but still marked as practice', /ph\.practice = practiceInfo_/.test(branch));
  ok('and still offers a reset, which is a role question not a period one',
     /ph\.can_reset_practice = canEdit_\(auth\)/.test(branch));
  /* The approver keeps break glass on it — reopening a practice period is part of the rehearsal. */
  ok('the approver can still reopen it', /ph\.can_approve = canApprove_\(auth\)/.test(branch));

  /* HISTORY_HEADERS has never carried a target, which is why recomputing a frozen row cannot work
     and why this must be read, not calculated. Asserted so nobody "fixes" the symptom by adding a
     target column instead. */
  const H = GS.slice(GS.indexOf('var HISTORY_HEADERS'), GS.indexOf('];', GS.indexOf('var HISTORY_HEADERS')));
  ok('frozen rows carry no target, so they can only ever be READ', !/'target'/.test(H));
}

/* ── 4. Approval: the same split, on the path that writes ───────────────────────────────────── */
console.log('\nincentiveApprove_ splits them the same way — and writes to the practice tab');
{
  const A = decomment(fnSrc(GS, 'incentiveApprove_'));
  /* Source-level, because running approval needs the whole scoring stack and a sheet. The claim is
     narrow and exact: the fetch consults practiceSource_, and the write does not. */
  /* THE SPLIT MOVED INTO perfForWrite_ (2026-09-09) so approval and the send preview cannot shape
     rows differently — they had disagreed three times. So this is now two claims, and both must
     hold: approval delegates, and the thing it delegates to still asks for the WINDOW. Asserting
     only the first would pass against a helper that fetched the key. */
  const PFW = decomment(fnSrc(GS, 'perfForWrite_'));
  ok('approval delegates the fetch to the one shared shaper', /perfForWrite_\(pp\)/.test(A));
  ok('the performance fetch asks for the source window',
     /fetchLivePerf_\(isPracticePeriod_\(pp\) \? practiceSource_\(pp\) : pp\)/.test(PFW));
  /* And approval must not have kept a second copy that could drift back apart. */
  ok('...and approval no longer fetches on its own', !/fetchLivePerf_\(/.test(A));
  ok('the frozen rows are keyed on pp — the practice key — not on the window',
     /rows\.push\(\[pp,/.test(A));
  ok('the history sheet is chosen by the same key', /historySheet_\(pp\)/.test(A));
  ok('the frozen scheme and the workflow row follow it too',
     /freezeScheme_\(pp,/.test(A) && /wfSet_\(pp,/.test(A));
  ok('the inputs are read under it', /inputsFor_\(pp\)/.test(A));

  /* ORDER, and it is the same invariant as on the screen: SPIFF is scored on the real window, so
     the remap has to come after the fold. Asserted as a position, because a future edit that moves
     the remap up would leave every assertion above still passing. */
  const iSpiff = A.indexOf('applySpiffEarnings_(live, live.payPeriod.start)');
  const iRemap = A.indexOf('if (isPracticePeriod_(pp)) {');
  ok('the SPIFF fold happens BEFORE the key is swapped in', iSpiff > 0 && iRemap > iSpiff);
  /* Both paths remap in the same place, or the screen and the record disagree about which
     fortnight was scored — which is the thing approval exists not to do. */
  const G = decomment(fnSrc(GS, 'getIncentive_'));
  const gSpiff = G.indexOf('applySpiffEarnings_(live, live.payPeriod.start, true)');
  const gRemap = G.indexOf('if (isPracticePeriod_(want)) {');
  ok('and the screen does it in the same order', gSpiff > 0 && gRemap > gSpiff);
}

/* ── 5. Practice is invisible to everything that counts real money ──────────────────────────── */
console.log('\nNothing that enumerates what the company actually closed can see practice');
{
  const H = decomment(fnSrc(GS, 'historyPeriods_'));
  ok('historyPeriods_ reads whichever tab its argument names', /incTab_\(HISTORY_TAB, pp\)/.test(H));
  /* Called with nothing it reads the REAL history — which is every caller that answers "what has
     this company closed": the imported period list, the import guard, the digest. That is the whole
     isolation, and it is a property of the tab rather than of a filter somebody has to remember. */
  const callers = decomment(GS).match(/historyPeriods_\(\)/g) || [];
  ok('and the bare calls — the ones that enumerate real closed periods — still exist',
     callers.length >= 3);
  const single = decomment(GS).match(/historyPeriods_\(pp\)\.some/g) || [];
  ok('while every "is THIS period already closed" guard passes the key (' + single.length + ')',
     single.length === 3);

  /* The picker offers it last. Sorted newest-first, a practice entry at the top is the one a hurried
     click lands on — so it is appended after the sort, where its position cannot drift. */
  const L = decomment(fnSrc(GS, 'periodList_'));
  ok('the practice entry is appended AFTER the sort, so it is always last',
     L.indexOf('out.sort(') < L.indexOf('source: \'practice\''));
  ok('and it names the fortnight it mirrors', /practice_of: practiceSrc/.test(L));

  /* The default is the last COMPLETED fortnight. Practising on the running one means the numbers
     move under you mid-rehearsal, and a close is something you do to a period that has ended. */
  const S = decomment(fnSrc(GS, 'practiceSourceStart_'));
  ok('the mirrored fortnight is a completed one, never the running period',
     /if \(!computed\[i\]\.current\) return computed\[i\]\.start/.test(S));
  ok('and Sky can pin a different one without a deploy', /cfg\.crewPracticePeriod/.test(S));
}

/* ── 6. Everything that leaves the app says so ──────────────────────────────────────────────── */
console.log('\nEvery document that leaves the app is marked, including on paper');
{
  const N = new Function(
    PREFIX + fnSrc(GS, 'isPracticePeriod_') + fnSrc(GS, 'practiceSource_') +
    fnSrc(GS, 'payoutMMDDYY_') + fnSrc(GS, 'payoutFileName_') + '; return payoutFileName_;')();

  const real = N('2026-08-17', '2026-08-30');
  const prac = N('practice-2026-08-17', '2026-08-30');
  ok('the real archive name is unchanged', real === 'Incentive Dashboard - 081726-083026');
  /* Not '' — which is what an un-stripped key produced, and which was the "could not build a
     filename" refusal. A rehearsal that silently fails to file proves nothing about the filing. */
  ok('a practice payout still gets a name', !!prac);
  ok('and it carries the real dates, so it files itself sensibly',
     /081726-083026$/.test(prac));
  ok('and it says PRACTICE first, where a folder listing sorts on it',
     prac === 'PRACTICE - Incentive Dashboard - 081726-083026');

  /* THE BROWSER MUST AGREE, and for the same reason pdf_name_agreement_test.js exists: two builders
     of one filename is how the archive ends up with `033026-041226.pdf` beside `8.3.26-8.16.26.pdf`. */
  const B = new Function('return ' + fnSrc(JS, 'incPPDate').replace(/^function /, 'function '))();
  ok('the browser strips the key the same way', B('practice-2026-08-17') === '2026-08-17');
  ok('and leaves a real period alone', B('2026-08-17') === '2026-08-17');

  const doc = decomment(fnSrc(JS, 'incDocName'));
  ok('the printed document is named PRACTICE too', /incIsPractice\(d\) \? 'PRACTICE - '/.test(doc));
  ok('and it strips the key before parsing dates, so the name is not empty',
     /incMMDDYY\(incPPDate\(/.test(doc));

  const csv = decomment(fnSrc(JS, 'incExportCsv'));
  /* The CSV is the file that reaches payroll. Its contents are names and dollars either way and
     nothing inside it says which fortnight it rehearses, so the name is the only thing that travels. */
  ok('the Capstone export is marked in its filename',
     /incIsPractice\(d\) \? 'PRACTICE-'/.test(csv) && /incPPDate\(pp\)/.test(csv));

  const html = decomment(fnSrc(GS, 'payoutHtml_'));
  ok('the payout PDF says it on the page, not only in the filename',
     /PRACTICE &mdash; NOT A PAYROLL/.test(html));
  ok('and the page shows the rehearsed fortnight, not the storage key',
     /esc\(ppLabel\)/.test(html));

  const mail = decomment(GS);
  ok('the approval email says it in the SUBJECT, which is read before the body',
     /isPracticePeriod_\(pp\) \? '\[PRACTICE\] ' : ''/.test(mail));
  const body = decomment(fnSrc(GS, 'wfApprovalEmail_'));
  ok('and banners it above the figures', /PRACTICE — this is not payroll/.test(body));
  ok('the email names the real fortnight, not the key', /var ppLabel = isPrac/.test(body));

  /* Filed to a subfolder — Sky has 28 fortnights of payout reports in that archive and a rehearsal
     must not land beside them, whatever it is called. */
  const file = decomment(fnSrc(GS, 'filePayoutPdf_'));
  ok('a practice PDF is filed to the Practice subfolder, never the archive itself',
     /if \(isPracticePeriod_\(pp\)\) folder = practiceFolder_\(folder\)/.test(file));
}

/* ── 7. The screen wears it, and it survives print ──────────────────────────────────────────── */
console.log('\nThe screen says it where somebody about to approve will see it');
{
  const render = decomment(JS);
  ok('the banner is rendered above the title, not as a dismissible notice',
     /crew-inc-practice/.test(render));
  ok('the badge is its own state, not a shade of "as paid"',
     /is-practice">Practice/.test(render));
  /* Keyed on `practice`, not on `source` — see above. This is the browser half of the same fix. */
  ok('the browser reads practice off its own field, never off `source`',
     /function incIsPractice\(d\) \{ return !!\(d && d\.practice\); \}/.test(render));
  ok('isImported still derives from source alone, with its two values',
     /var isImported = d\.source === 'imported';/.test(render));
  ok('and the reset button hangs off the role flag, not the period being editable',
     /incIsPractice\(d\) && d\.can_reset_practice/.test(render));
  /* Checked BEFORE `imported`: an approved practice period is served from a history tab, and
     "Imported" is the one word on this screen that means "this was paid". */
  const facts = decomment(fnSrc(JS, 'incFacts'));
  ok('and an APPROVED practice period does not read as "Imported"',
     facts.indexOf("incIsPractice(d)") < facts.indexOf("d.source === 'imported'"));

  const css = decomment(HTML);
  ok('the banner is styled', /\.crew-inc-practice \{/.test(css));
  /* The failure this guards is a practice payout printed, filed and read on paper. A print
     stylesheet that hides it, or leaves it as a color a grayscale printer drops, undoes the whole
     feature in the one medium where nothing downstream can catch the mistake. */
  const printBlock = css.slice(css.indexOf('@media print'));
  ok('it is NOT hidden when printing',
     !/\.crew-inc-practice[^{]*\{[^}]*display:\s*none/.test(printBlock));
  ok('and it prints as black on white with a border, which grayscale keeps',
     /\.crew-inc-practice \{ background: #fff !important; color: #000 !important;/.test(printBlock));
}

/* ── 8. Reset can only ever name a practice tab ─────────────────────────────────────────────── */
console.log('\nReset is the one button here that deletes, and it cannot be pointed at real data');
{
  const R = decomment(fnSrc(GS, 'incentivePracticeReset_'));
  /* The key is BUILT here from the configured window. Nothing the caller sends chooses a sheet, so
     a request naming a real period does not clear that period — it clears the practice tabs,
     because that is the only thing this function can name. */
  ok('the key is built from config, never taken from the request',
     /var key = practiceKeyFor_\(src\)/.test(R) && !/p\.pp_start/.test(R));
  ok('every name it clears is built by incTab_', /incTab_\(t, key\)/.test(R));
  ok('and it refuses outright if a name is not a practice tab',
     /_practice\$\/\.test\(n\)/.test(R) && /refusing to clear/.test(R));
  ok('it is confirm-gated, so a stray load cannot fire it', /p\.confirm \|\| ''\) !== 'yes'/.test(R));
  ok('it is editor-level — rehearsing is the preparer\'s job', /canEdit_\(auth\)/.test(R));

  const btn = decomment(fnSrc(JS, 'incHeadActions'));
  /* Rendered only on a practice period, so the one destructive control in this app cannot be
     reached from a screen where deleting rows would mean something. */
  ok('the button renders only on a practice period',
     /if \(incIsPractice\(d\) && d\.can_reset_practice\)/.test(btn));
  ok('and the route is registered', /case 'incentive_practice_reset'/.test(decomment(GS)));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
