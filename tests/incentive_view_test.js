#!/usr/bin/env node
/* ─── The incentive screen renders both eras correctly ────────────────────────────────────────────
 *
 *   RUN:  node tests/incentive_view_test.js
 *
 * WHY
 * One renderer serves two very different payloads — a LIVE period from Leaderboard's performance
 * slice, where the bonus math runs here in the browser, and an IMPORTED period from the payout
 * PDFs, where the figures are what was paid and nothing may be recomputed. Almost every way this
 * breaks is silent: a number renders, it is just the wrong one.
 *
 * The three that would actually cost money:
 *   • a live row carries `discount` as a DECIMAL (0.0185) and an imported row carries
 *     `discount_pct` as a PERCENT (1.85). Reading one as the other is off by 100x and looks
 *     entirely plausible from either end — 1.85% and 0.0185% are both believable discount rates.
 *   • SPIFF is vendor money. It belongs in Bonus and must never reach the Payroll column or the
 *     Capstone export, or the company pays the vendor's share.
 *   • the oldest report has no payroll column at all, so those rows must export EMPTY, not 0.00.
 *     A zero tells payroll to pay nothing, which is a different claim from "not recorded".
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const TAIL = '})();';
  const cut = src.lastIndexOf(TAIL);
  src = src.slice(0, cut) +
        '\n; return { incBudTable, incMgrTable, incAdminTable, incCsvRows, incDiscPct,\n' +
        '           incHeadActions, incMMDDYY, legalSortName, CAPSTONE_SECTIONS,\n' +
        '           incPeriodLabel, incFacts, INC_COLS, incGoal,\n' +
        '           incTrayHtml, incTrayRead, incDiscListHtml,\n' +
        '           calcBud, calcMgr, calcAdmin, inc };\n' + src.slice(cut);
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
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'],
               aovTarget: 33, aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 }], maxPerStore: 50 },
};

/* ── the 100x trap ── */
ok('a LIVE row\'s decimal discount is read as a percent',
   Math.abs(M.incDiscPct({ discount: 0.0185 }) - 1.85) < 1e-9);
ok('an IMPORTED row\'s percent discount is left alone',
   Math.abs(M.incDiscPct({ discount_pct: 1.85 }) - 1.85) < 1e-9);
ok('a row carrying both prefers the imported column it was stored with',
   Math.abs(M.incDiscPct({ discount_pct: 7.3, discount: 0.0281 }) - 7.3) < 1e-9);

/* Rendered, the two must agree — this is the assertion that would have caught the swap. */
const liveRow = { employee_id: 'a', name: 'A B', storeName: 'Bend', txn: 250, sales: 8000,
                  discount: 0.0185, aov: 35 };
const impRow  = { employee_id: 'a', pdf_name: 'A B', store_label: 'Bend', txn: 250, sales: 8000,
                  discount_pct: 1.85, aov: 35, bonus: 40, payroll: 15, spiff: 25, per_hour: 0.5 };
M.inc.data = { inputs: {} };
const liveHtml = M.incBudTable([liveRow], b => M.calcBud(b, T, {}), false, true, T);
const impHtml  = M.incBudTable([impRow], b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff,
                                                 hr: b.per_hour, qual: null }), true, false, T);
/* TWO decimals since 2026-09-01, and the second one is load-bearing. The manager tiers cut at
   two-thirds of the budtender goal (0.67% against a 1.0% goal), so at one decimal a store on 0.70%
   and one on 0.65% both printed as comfortably inside the 1% bar while one of them had taken $50
   less. Attainment stays at one decimal — nobody is scored on the second decimal of 96.6%. */
ok('both eras print the same discount for the same rate',
   liveHtml.includes('1.85%') && impHtml.includes('1.85%'));
ok('and the discount column carries the second decimal a tier boundary can turn on',
   !liveHtml.includes('>1.9%<'));

/* ── ONE identity key: employee_id ──
   Leaderboard sends nameKey ('chris_carney'); GX Core, and therefore every input Crew saves, uses
   employee_id ('christopher_carney'). Keying the inputs on nameKey did not fail — it quietly found
   nothing, so the bonus computed as if no attendance or SPIFF had been entered and the payroll came
   out short. The engine stamps employee_id onto every live row; the nameKey fallback is what keeps
   Leaderboard's own rows (which have no employee_id) working in the differential test. */
ok('an input saved under employee_id is found by the math',
   M.calcBud({ employee_id: 'christopher_carney', nameKey: 'chris_carney', storeSlug: 'bend',
               txn: 400, aov: 40, discount: 0.001 }, T,
             { christopher_carney: { att: true, spiff: 100 } }).spiff === 100);
ok('a Leaderboard row with only a nameKey still resolves',
   M.calcBud({ nameKey: 'chris_carney', storeSlug: 'bend', txn: 400, aov: 40, discount: 0.001 }, T,
             { chris_carney: { att: true, spiff: 100 } }).spiff === 100);
ok('employee_id WINS when a row carries both — the registry is the identity, not Leaderboard',
   M.calcBud({ employee_id: 'christopher_carney', nameKey: 'chris_carney', storeSlug: 'bend',
               txn: 400, aov: 40, discount: 0.001 }, T,
             { christopher_carney: { att: false, spiff: 7 }, chris_carney: { att: true, spiff: 999 } }
            ).spiff === 7);

/* ── SPIFF is not payroll ── */
const budWithSpiff = { employee_id: 'z', nameKey: 'z_q', storeSlug: 'bend', name: 'Z Q',
                       storeName: 'Bend', txn: 400, sales: 20000, discount: 0.001, aov: 40 };
M.inc.data = { inputs: { z: { att: true, spiff: 500 } } };
const c = M.calcBud(budWithSpiff, T, { z: { att: true, spiff: 500 } });
ok('a $500 SPIFF lands in Bonus but not Payroll', c.bonus === 565 && c.payroll === 65);

const csv = M.incCsvRows({
  thresholds: T, admin: null, managers: [],
  budtenders: [Object.assign({}, budWithSpiff, { store_id: 'bend', full_name: 'Zed Quill' })],
  payPeriod: { start: '2026-08-17' },
}, false);
ok('the export carries the PAYROLL figure, never the bonus',
   csv[1][3] === '65.00' && !csv.some(r => r[3] === '565.00'));
/* The header says Bonus because that is Capstone's column name; the VALUE is payroll. The file has
   to speak their language, not ours. */
ok('the header uses Capstone\'s own column names',
   csv[0].join(',') === 'Section,Name,Store,Bonus');

/* ── "not recorded" is not zero ──
   The oldest report has no payroll column. Exporting 0.00 for those rows instructs payroll to pay
   nothing; exporting empty says the source did not record it, which is the truth. */
const noPayroll = { employee_id: 'g', pdf_name: 'Old Timer', store_label: 'Bend',
                    txn: 145, sales: null, discount_pct: 2.97, aov: 27.83,
                    bonus: 0, payroll: null, spiff: null, per_hour: 0 };
const csv2 = M.incCsvRows({ admin: null, managers: [],
  budtenders: [Object.assign({}, noPayroll, { store_id: 'bend', full_name: 'Old Timer' })],
  pp_start: '2025-08-04' }, true);
ok('an unrecorded payroll exports EMPTY, not 0.00', csv2[1][3] === '');
const oldHtml = M.incBudTable([noPayroll], b => ({ bonus: b.bonus, payroll: b.payroll,
  spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T);
ok('and renders as a dash that says why', /No payroll column in this report/.test(oldHtml));
ok('an unrecorded sales figure also renders as a dash, not $0', /—/.test(oldHtml));

/* ── an imported period offers no way to edit it ──
   It is closed and paid. An input here would imply a recalculation that is never going to happen. */
ok('imported rows render no attendance checkbox', !impHtml.includes('crew-inc-att'));
ok('imported rows render no SPIFF input', !impHtml.includes('<input type="number"'));
/* SPIFF IS NO LONGER EDITABLE ANYWHERE. It was a number Mike typed; it is a number SPIFF measured,
   and once a figure comes from a system there is no version of typing over it that is not a way to
   reintroduce the error the automation removed. Attendance is the only manual input left. */
ok('a LIVE row renders no SPIFF input either — it is measured, not typed',
   !liveHtml.includes('crew-inc-spiff') && !/<input type="number"/.test(liveHtml));
ok('a live row is still editable for attendance', liveHtml.includes('crew-inc-att'));
const roHtml = M.incBudTable([liveRow], b => M.calcBud(b, T, {}), false, false, T);
/* A read-only session still needs to SEE whether somebody had full attendance, so the checkbox
   stays and is disabled — removing it would hide the fact rather than protect it. The SPIFF field
   becomes plain text, because an empty-looking input reads as "nothing entered". */
ok('a read-only session gets a disabled checkbox, not a missing one',
   roHtml.includes('type="checkbox"') && roHtml.includes('disabled'));
ok('and no editable SPIFF field anywhere', !roHtml.includes('<input type="number"'));

/* ── a met target is marked ON the figure ── */
ok('an AOV over target is marked green', liveHtml.includes('crew-inc-hit'));
const missed = M.incBudTable([{ employee_id: 'm', name: 'M M', storeName: 'Bend', txn: 10,
  sales: 100, discount: 0.09, aov: 12 }], b => M.calcBud(b, T, {}), false, true, T);
ok('a row that missed every target is marked nowhere', !missed.includes('crew-inc-hit'));

/* ── the payroll tooltip explains the sum ── */
ok('a budtender payroll figure carries its breakdown',
   /title="[^"]*qualified[^"]*AOV[^"]*discount[^"]*attendance/.test(liveHtml));
const mgrHtml = M.incMgrTable([{ employee_id: 'q', name: 'Q R', storeName: 'Bend', target: 100,
  sales: 115, discount: 0.005, aov: 40 }], m => M.calcMgr(m, T, {}, []), false, true, T);
ok('a manager payroll figure carries its four components',
   /title="sales [^"]*discount[^"]*AOV[^"]*team attendance/.test(mgrHtml));
ok('imported rows carry no tooltip — there is nothing to recompute',
   !/title="sales/.test(impHtml) && !/qualified/.test(impHtml));

/* ── names come from whichever field the era used ── */
ok('an imported row shows the name the report printed', impHtml.includes('A B'));
ok('a departed person with no employee_id still renders',
   M.incBudTable([{ pdf_name: 'Finnick Winchester', store_label: 'Hillsboro', bonus: 40,
     payroll: 40, spiff: 0, per_hour: 0.5 }], b => ({ bonus: b.bonus, payroll: b.payroll,
     spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T).includes('Finnick Winchester'));

/* ── color and zero-suppression carry meaning, so they are pinned ──
   Sky, comparing this against the Leaderboard dashboard it replaces: "we aren't using color to our
   benefit in the new version." Three specific things had been lost in the port, and each is a
   readability regression rather than a wrong number — which is exactly the kind that survives a
   test suite unless someone asserts it. */
const zeroRow = { employee_id: 'z0', pdf_name: 'Zero Person', store_label: 'Bend', store_id: 'bend',
                  txn: 100, sales: 3000, discount_pct: 5, aov: 20,
                  bonus: 0, payroll: 0, spiff: 0, per_hour: 0 };
const zeroHtml = M.incBudTable([zeroRow], b => ({ bonus: b.bonus, payroll: b.payroll,
  spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T);

/* A column of "$0 / $0.00 / $0" is noise the eye has to wade through to find the few people who
   actually earned something — and on an imported period that is most of the table. */
ok('a zero bonus renders as a muted dash, not $0', !/>\$0</.test(zeroHtml));
ok('a zero $/hr renders as a dash, not $0.00', !/\$0\.00/.test(zeroHtml));
ok('zeros are muted rather than shouted', (zeroHtml.match(/crew-inc-zero/g) || []).length >= 3);

/* PAYROLL is what the company pays and the only column Capstone receives, so it is the figure that
   gets the color. Bonus stays plain white beside it so the gap between them — SPIFF, which vendors
   fund — is visible without reading the footnote. */
const paidRow = Object.assign({}, zeroRow, { bonus: 40, payroll: 15, spiff: 25, per_hour: 0.5 });
const paidHtml = M.incBudTable([paidRow], b => ({ bonus: b.bonus, payroll: b.payroll,
  spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T);
ok('a non-zero payroll is in the payroll class that colors it', /crew-inc-pay[^>]*>\$15/.test(paidHtml));
ok('bonus is NOT given the payroll color', !/crew-inc-pay[^>]*>\$40/.test(paidHtml));

/* The store dot groups a 32-row table by eye. Imported rows print the label the REPORT used
   ("Hillsboro" for what is now Baseline) but color by the resolved store_id, so a year of history
   still groups against today's stores. */
ok('a store dot is rendered', paidHtml.includes('crew-inc-dot'));
ok('the dot is colored by the resolved store_id, not the historical label',
   /crew-inc-dot[^>]*store-bend|crew-inc-dot[^>]*background:/.test(paidHtml));
const oldLabel = M.incBudTable([Object.assign({}, paidRow, { store_label: 'Hillsboro', store_id: 'hillsboro' })],
  b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff, hr: b.per_hour, qual: null }), true, false, T);
ok('the historical store LABEL is still what the row prints',
   oldLabel.includes('Hillsboro') && /store-hillsboro|background:/.test(oldLabel));

/* ── what the print path has to get right ──
   Checked against the first real PDF, which came back with a bug-report icon printed in the middle
   of the budtender table, two screen-only footnotes on the last page, and a generic filename. */
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const printCss = html.slice(html.indexOf('@media print'));

/* gx-bugreport.js names its launcher gx-bug-fab / #gxBugFab. The first stylesheet hid
   `.gx-bugreport-btn`, a class that does not exist anywhere, so it silently hid nothing. */
ok('the bug launcher is hidden by its REAL selector',
   /gx-bug-fab/.test(printCss) && /#gxBugFab/.test(printCss));
ok('the screen-only footnotes do not print',
   /\.crew-inc-note \{ display: none/.test(printCss));
ok('the period control is replaced by plain text on paper',
   /#incPeriod/.test(printCss) && /crew-inc-printpp/.test(printCss));
ok('a row never straddles a page break', /page-break-inside: avoid/.test(printCss));

/* MMDDYY-MMDDYY, matching the names already in the Drive archive. */
ok('the pay period becomes the archive filename convention',
   M.incMMDDYY('2026-03-02') === '030226' && M.incMMDDYY('2026-03-15') === '031526');
ok('a malformed date yields no filename rather than a wrong one', M.incMMDDYY('') === '' &&
   M.incMMDDYY('3/2/26') === '');

/* ── the action bar offers only what the viewer can actually do ──
   Mike prepares and Sky approves, so the same period shows different buttons to each of them, and
   a period awaiting a decision shows almost none. Every wrong combination here is either a dead
   button or — worse — the preparer approving their own work. */
function headOf(d) { M.inc.data = d; return M.incHeadActions(d, d.source === 'imported'); }
const CLOSED = { start: '2026-08-03', current: false };
const OPEN   = { start: '2026-08-17', current: true };

ok('a closed record offers Print PDF and nothing to approve',
   headOf({ source: 'imported', pp_start: '2026-08-03' }).includes('>Print PDF<'));
ok('an open period cannot be approved — it is still selling',
   !/Approve|Send for approval/.test(headOf({ source: 'live', payPeriod: OPEN })));

/* The preparer sends; they never see an Approve button, which is the whole control. */
const mike = headOf({ source: 'live', payPeriod: CLOSED, can_edit: true, can_approve: false,
                      workflow: { status: 'draft' } });
ok('the preparer is offered Send for approval', mike.includes('id="incSend"'));
ok('and is NOT offered Approve', !mike.includes('id="incApprove"'));

/* The approver approves directly. Making Sky email himself would be ceremony, not a control. */
const sky = headOf({ source: 'live', payPeriod: CLOSED, can_edit: true, can_approve: true,
                     workflow: { status: 'draft' } });
ok('the approver approves without sending it to themselves',
   sky.includes('id="incApprove"') && !sky.includes('id="incSend"'));
/* The gear is LAST in the action row, right of Export — Sky, 2026-08-28. It used to float over the
   table; a control with no home in the row ends up nowhere. */
ok('the gear sits right of Export Payroll CSV',
   sky.indexOf('id="incCsv"') > -1 && sky.indexOf('id="incGear"') > sky.indexOf('id="incCsv"'));
ok('and only the approver gets one', !mike.includes('id="incGear"'));

/* Pending: locked for the preparer, decidable for the approver. */
const pendingMike = headOf({ source: 'live', payPeriod: CLOSED, can_edit: false, can_approve: false,
                             workflow: { status: 'pending', sent_by: 'mike', sent_at: '2026-08-31T10:00:00Z' } });
ok('once sent, the preparer gets no buttons — only who has it',
   !pendingMike.includes('id="incApprove"') && !pendingMike.includes('id="incSend"') &&
   /locked until/.test(pendingMike));
const pendingSky = headOf({ source: 'live', payPeriod: CLOSED, can_edit: false, can_approve: true,
                            workflow: { status: 'pending', sent_by: 'mike' } });
ok('the approver gets both Approve and Send back',
   pendingSky.includes('id="incApprove"') && pendingSky.includes('id="incReturn"'));

/* A returned period carries its reason where the person who must act on it will see it. */
const returned = headOf({ source: 'live', payPeriod: CLOSED, can_edit: true, can_approve: false,
                          workflow: { status: 'draft', note: 'Zach\'s attendance is wrong',
                                      decided_by: 'sky' } });
ok('the reason it came back is shown with the buttons, not in a toast',
   /Sent back by sky/.test(returned) && /attendance is wrong/.test(returned));
ok('and it is editable again — Send for approval is back', returned.includes('id="incSend"'));

/* ── the export is shaped like CAPSTONE'S sheet, not ours ──
   Sky supplied their template: an ADMIN block, then one block per store in THEIR order, each sorted
   by surname, so a new starter at River lands in the River block in the right alphabetical slot
   without anyone re-sorting the file by hand. */
ok('surname first, then given name and a middle initial',
   M.legalSortName({ full_name: 'Michael C Kettler' }) === 'Kettler Michael C');
/* Nobody stores a middle name today, so most rows are "Surname First" — correct rather than
   approximate. An invented initial on a payroll file is worse than a missing one. */
ok('no middle name means no invented initial',
   M.legalSortName({ full_name: 'Robert Wydick' }) === 'Wydick Robert');
ok('a single-word name survives intact', M.legalSortName({ full_name: 'Cher' }) === 'Cher');
/* Payroll matches on the LEGAL name. The roster leads with "Nate Wydick"; Capstone pays
   Wydick Robert. Preferring the display name here would send the wrong person's name to payroll. */
ok('the legal name wins over the name the screen shows',
   M.legalSortName({ full_name: 'Robert Wydick', name: 'Nate Wydick', pdf_name: 'Nathan Wydick' })
     === 'Wydick Robert');

const big = M.incCsvRows({
  admin: { pdf_name: 'Mike Kettler', full_name: 'Michael C Kettler', payroll: 300 },
  managers: [{ full_name: 'Thomas Peterson', store_id: 'river-rd', payroll: 50 }],
  budtenders: [
    { full_name: 'Noah Pinkerton',   store_id: 'river-rd',  payroll: 15 },
    { full_name: 'Kristin Bailey',   store_id: 'river-rd',  payroll: 40 },
    { full_name: 'Zachary Babcock',  store_id: 'hillsboro', payroll: 40 },
    { full_name: 'Shane Styrt',      store_id: 'commercial', payroll: 25 },
    { full_name: 'Nobody Anywhere',  store_id: 'atlantis',  payroll: 10 },
  ], pp_start: '2026-08-03' }, true);
const sections = big.slice(1).map(r => r[0]);
ok('ADMIN leads, then the stores in Capstone\'s order',
   sections.join(',') === 'ADMIN,HILLSBORO,RIVER,RIVER,RIVER,SOUTH,UNASSIGNED');
/* Commercial is SOUTH on their sheet, Baseline is HILLSBORO, Century is BEND. Deliberately NOT the
   store registry — it is a third party's import format and must not move when a store is renamed
   in Command Center. */
ok('Commercial exports as SOUTH, their label not ours', sections.indexOf('SOUTH') > -1);
const river = big.slice(1).filter(r => r[0] === 'RIVER').map(r => r[1]);
ok('each block is sorted by surname, so a new starter lands in the right slot',
   river.join(' | ') === 'Bailey Kristin | Peterson Thomas | Pinkerton Noah');
/* An unresolvable store would otherwise drop the person from the file entirely — a silent omission
   on a payroll export is the worst way for this to fail. */
ok('somebody whose store did not resolve is flagged, not dropped',
   big.some(r => r[0] === 'UNASSIGNED' && r[1] === 'Anywhere Nobody'));

/* ── a period is marked against the rules that applied TO IT ──
   Performance froze, the goal froze, the inputs were per-period — and the thresholds floated. So an
   imported 2025 row was being marked green against today's 1.5% bar, a target that did not exist
   when it was paid. Approval now freezes the scheme; the 27 imported periods have none and never
   will, because nobody recorded theirs. */
const histRow = { employee_id: 'h', pdf_name: 'Old Hand', store_label: 'Bend', store_id: 'bend',
                  txn: 400, sales: 12000, discount_pct: 1.2, aov: 35,
                  bonus: 40, payroll: 40, spiff: 0, per_hour: 0.5 };
const calcHist = b => ({ bonus: b.bonus, payroll: b.payroll, spiff: b.spiff, hr: b.per_hour, qual: null });

const noScheme = M.incBudTable([histRow], calcHist, true, false, null);
ok('with no frozen scheme, nothing is marked as having hit a target',
   !noScheme.includes('crew-inc-hit'));
ok('but the figures are still all there', /1\.20%/.test(noScheme) && /\$35\.00/.test(noScheme));

/* Same row, scored under a scheme that was actually frozen with it — now the marks mean something. */
const withScheme = M.incBudTable([histRow], calcHist, true, false, T);
ok('with a frozen scheme, targets it cleared are marked', withScheme.includes('crew-inc-hit'));

/* ── the color classes must actually WIN against the base cell rule ──
   This is the bug the DOM assertions above cannot see, and it shipped. `.crew-inc-tbl td` is a
   class plus an element — specificity (0,1,1). A bare `.crew-inc-hit` is (0,1,0) and loses to it
   regardless of source order. So every color class was present in the markup and not one of them
   painted: the screen was entirely gray while every test asserting the class name passed.

   Specificity is not visible from the HTML, so it has to be asserted from the STYLESHEET. */
function spec(sel) {                       // [ids, classes, elements] — enough for this sheet
  var ids = (sel.match(/#[\w-]+/g) || []).length;
  var cls = (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/\[[^\]]+\]/g) || []).length;
  var els = (sel.replace(/[#.][\w-]+/g, ' ').match(/\b[a-z]+\b/g) || []).length;
  return [ids, cls, els];
}
function beats(a, b) {
  const x = spec(a), y = spec(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return true;                             // equal specificity: later wins, and ours are later
}
/* Pulled from the sheet rather than hardcoded, so a renamed base rule fails here loudly. */
const BASE = (html.match(/(\.crew-inc-tbl td)\s*\{[^}]*color:/) || [])[1];
ok('the base cell rule is still the thing to beat', !!BASE);
['crew-inc-hit', 'crew-inc-pay', 'crew-inc-zero'].forEach(function (cls) {
  const rule = (html.match(new RegExp('([^\\n{}]*\\.' + cls + '[^\\n{}]*)\\s*\\{[^}]*color:')) || [])[1];
  ok(cls + ' has a color rule that out-specifies the base cell',
     !!rule && !!BASE && beats(rule.trim(), BASE));
});

/* ── the settings tray round-trips the scheme without moving a number ──
   The tray is Leaderboard's design: a labeled control per threshold, which is far better to use
   than raw JSON and far easier to get quietly wrong. The first version read the inputs back in DOM
   ORDER, so adding or reordering a row would have shifted every value after it — an AOV bonus
   landing in attendance, with nothing on screen to see. Each input now carries the path it writes
   to, and this asserts the trip out and back is lossless. */
function parseInputs(html) {
  const out = [];
  const re = /<input\b[^>]*data-thr="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g;
  let m;
  /* Capture per iteration — `m` is reassigned by exec, so a closure over it reads the LAST match
     for every entry (and null once the loop ends). */
  while ((m = re.exec(html))) {
    const path = m[1], value = m[2];
    out.push({ getAttribute: k => (k === "data-thr" ? path : null), value: value });
  }
  return out;
}
const trayHtml = M.incTrayHtml(T);
const back = M.incTrayRead(JSON.parse(JSON.stringify(T)), parseInputs(trayHtml));
ok('every threshold survives a trip through the tray untouched',
   JSON.stringify(back) === JSON.stringify((function () {
     const t = JSON.parse(JSON.stringify(T));
     t.manager.discountTiers[0].maxPct = Math.round(t.budtender.discountMaxPct * 2 / 3 * 100) / 100;
     t.manager.discountTiers[1].maxPct = t.budtender.discountMaxPct;
     return t;
   })()));

/* Every editable threshold must actually HAVE a control — one silently missing means a value that
   can never be changed from the screen it is displayed on. */
const paths = parseInputs(trayHtml).map(i => i.getAttribute('data-thr'));
['budtender.discountMaxPct', 'budtender.txnQualify', 'budtender.txnQualifyLowVol',
 'budtender.aovTarget', 'budtender.aovBonus', 'budtender.discountBonus', 'budtender.attendanceBonus',
 'manager.aovTarget', 'manager.aovBonus', 'manager.teamAttendancePerHead',
 'manager.discountTiers.0.bonus', 'manager.discountTiers.1.bonus',
 'hoursPerPeriod'].forEach(function (p) {
  ok('the tray edits ' + p, paths.indexOf(p) >= 0);
});
ok('every sales tier gets its own pair of controls',
   T.manager.salesTiers.every((_, i) => paths.indexOf('manager.salesTiers.' + i + '.pct') >= 0 &&
                                        paths.indexOf('manager.salesTiers.' + i + '.bonus') >= 0));
ok('every admin tier does too',
   T.admin.tiers.every((_, i) => paths.indexOf('admin.tiers.' + i + '.pct') >= 0 &&
                                 paths.indexOf('admin.tiers.' + i + '.bonus') >= 0));
/* The manager store-discount CUT-OFFS derive from the budtender goal — only the dollar amounts are
   stored. Making them editable would invite setting a value the math then ignores. */
ok('the derived manager discount cut-offs are NOT editable',
   paths.indexOf('manager.discountTiers.0.maxPct') < 0 &&
   paths.indexOf('manager.discountTiers.1.maxPct') < 0);
/* An edit lands where it says it does. */
const edited = parseInputs(trayHtml);
edited.filter(i => i.getAttribute('data-thr') === 'budtender.aovBonus')[0].value = '40';
ok('changing one control changes only that threshold',
   M.incTrayRead(JSON.parse(JSON.stringify(T)), edited).budtender.aovBonus === 40 &&
   M.incTrayRead(JSON.parse(JSON.stringify(T)), edited).budtender.attendanceBonus === T.budtender.attendanceBonus);

/* ── the tray is Leaderboard's, and the class names are load-bearing ──
   The CSS is copied verbatim from that app; it targets .ist-* and .inc-tray-*. Renaming one class
   here silently unstyles a whole section rather than erroring, so the markup and the stylesheet are
   checked against each other. */
['ist-body', 'ist-sec', 'ist-seclabel', 'ist-goalrow', 'ist-chips', 'ist-chip', 'ist-role',
 'ist-rhead', 'ist-grid', 'ist-c', 'ist-inp', 'ist-rin', 'ist-ln', 'ist-hoursrow', 'ist-footer',
 'ist-savebtn'].forEach(function (cls) {
  ok('the tray still uses .' + cls + ', which the copied CSS targets',
     trayHtml.indexOf(cls) >= 0 && html.indexOf('.' + cls) >= 0);
});

/* The discount rules section: checkbox CHECKED means the rule COUNTS. Leaderboard stores the
   inverse, and the flip happens in the engine — but the list rendering has to get the direction
   right too, or every rule shows the opposite of its real state. */
const discs = M.incDiscListHtml({
  discretionary: [{ name: 'Employee Discount', code: 'Employee25', excluded: true },
                  { name: 'Volume - All Items', code: 'Vol', excluded: false }],
  autoExcluded: { loyalty: ['Points'], automatic: ['BOGO'] },
  counts: { loyalty: 11, automatic: 21 } });
ok('an EXCLUDED rule renders unchecked and dimmed',
   /class="ist-dr off"[\s\S]*?Employee Discount/.test(discs) &&
   !/data-name="Employee Discount"[^>]*checked/.test(discs));
ok('a COUNTED rule renders checked and undimmed',
   /data-name="Volume - All Items"[^>]*checked/.test(discs));
ok('the always-excluded footer states both counts',
   /Loyalty \(11\)/.test(discs) && /Automatic promos \(21\)/.test(discs));
ok('discount codes are shown, since two rules can share a name',
   /ist-code">Employee25</.test(discs));

/* ── SPIFF is read, not typed ──
   Sky: "the goal is there is no typing needed… I'm trying to take human error out of the equation."
   The figure comes from SPIFF's progress cache; a manual entry wins only when somebody deliberately
   made one. An override that a background refresh silently reverted would be worse than no
   automation — Mike would fix it, watch it come back, and stop trusting the column. */
const spRow = { employee_id: 'sp1', nameKey: 'sp1', storeSlug: 'bend', name: 'Sold Lots',
                txn: 400, aov: 40, discount: 0.001, spiff_earned: 25 };
ok('a measured SPIFF lands in the bonus with nothing typed',
   M.calcBud(spRow, T, {}).spiff === 25);
ok('and it is excluded from payroll, like any other SPIFF',
   M.calcBud(spRow, T, {}).payroll === M.calcBud(Object.assign({}, spRow, { spiff_earned: 0 }), T, {}).payroll);

/* An explicit manual entry overrides the measurement — that is the miss Mike is allowed to fix. */
ok('a manual entry overrides what SPIFF measured',
   M.calcBud(spRow, T, { sp1: { att: false, spiff: 40 } }).spiff === 40);
/* Zero is a real override, not an absence: "SPIFF says 25, but they did not actually earn it." */
ok('an explicit zero overrides too, rather than falling back to the measurement',
   M.calcBud(spRow, T, { sp1: { att: false, spiff: 0 } }).spiff === 0);
/* An empty box is NOT an override — it is nobody having typed anything. */
ok('an empty entry falls back to the measurement',
   M.calcBud(spRow, T, { sp1: { att: true, spiff: '' } }).spiff === 25);

/* The cell says where its number came from, because a measured figure and a typed one are
   different claims about vendor money. */
M.inc.data = { inputs: { sp1: { att: false, spiff: 40 } } };
const over = M.incBudTable([spRow], b => M.calcBud(b, T, M.inc.data.inputs), false, true, T);
/* An earned SPIFF reads BOLD GREEN — the same mark every other cleared target uses, because a
   SPIFF paid out IS an achieved goal and should not look like a data-entry field with a number in
   it. Class on the TD, so it out-specifies the base cell rule like every other color here. */
M.inc.data = { inputs: {} };
const earnedHtml = M.incBudTable([spRow], b => M.calcBud(b, T, {}), false, true, T);
ok('an earned SPIFF is bold green on the cell itself',
   /<td class="crew-inc-hit"[^>]*>\$25</.test(earnedHtml));
const noneHtml = M.incBudTable([Object.assign({}, spRow, { spiff_earned: 0 })],
                               b => M.calcBud(b, T, {}), false, true, T);
ok('nothing earned is a muted dash, not $0', /<td class="crew-inc-zero">—/.test(noneHtml));
ok('an existing override shows in amber and says what was measured',
   /crew-inc-over/.test(over) && /SPIFF measured \$25/.test(over));

/* ── overriding is a DELIBERATE ACT, not an open field ──
   Sky asked for an edit button with a payroll warning. The difference is the whole design: an
   always-editable box invites a stray keystroke on a payroll screen, and this column exists
   precisely to stop numbers being typed. */
ok('an editable row offers the pencil, not a field',
   /crew-inc-edit/.test(earnedHtml) && !/crew-inc-spiff/.test(earnedHtml));
ok('the pencil carries what the confirm has to name — who, and what was measured',
   /data-name="Sold Lots"/.test(earnedHtml) && /data-measured="25"/.test(earnedHtml));
const roSpiff = M.incBudTable([spRow], b => M.calcBud(b, T, {}), false, false, T);
ok('a read-only session is offered no pencil at all', !/crew-inc-edit/.test(roSpiff));
/* Never a one-way door: an override offers ↺ to put the measured figure back. */
ok('an override offers a way back to the measured figure',
   /crew-inc-revert/.test(over) && /Put back the measured figure/.test(over));
ok('and an un-overridden cell has nothing to revert', !/crew-inc-revert/.test(earnedHtml));

/* '' CLEARS an override and must not become 0 — zero is itself a valid override meaning "they
   earned nothing", and collapsing the two would make reverting impossible. */
ok('an empty override falls back to the measurement',
   M.calcBud(spRow, T, { sp1: { att: false, spiff: '' } }).spiff === 25);
ok('an explicit zero override still means zero',
   M.calcBud(spRow, T, { sp1: { att: false, spiff: 0 } }).spiff === 0);
M.inc.data = { inputs: {} };
const plain = M.incBudTable([spRow], b => M.calcBud(b, T, {}), false, true, T);
ok('an un-overridden one is not marked', !/is-over/.test(plain));

/* ── the shared maintenance gate is wired ──
   Its whole value is being already wired when something breaks: the app that skipped it is the one
   still showing a stack trace to a store while every other app shows the screen. */
ok('gx-maintenance.js is loaded', /gx-maintenance\.js/.test(html));
ok('and initialised with this app key', /GXMaintenance\.init\([\s\S]{0,200}app: 'crew'/.test(html));
/* core-admin's note says `gxcore: GXCORE_URL`, but in Crew that constant lives inside crew.js's
   IIFE and is not a global — referencing it here throws before the gate initialises, on every page
   load, whether or not maintenance is on. */
/* Scoped to the CALL, not the whole file: the comment above it quotes the wrong form in order to
   explain why not to use it, and a naive search for that string finds the warning and calls it the
   bug. */
const maintInit = html.slice(html.indexOf('GXMaintenance.init('), html.indexOf('GXMaintenance.init(') + 500);
ok('the GX Core URL is a literal, not a constant that is not in scope here',
   /gxcore:\s*'https:/.test(maintInit) && !/gxcore:\s*GXCORE_URL/.test(maintInit));

/* ── the polish pass (design_handoff_incentive_polish) ──
   Same tables, same math, same routes; what changed is that the screen stops reading like the
   spreadsheet it was ported from. These pin the parts that would regress silently. */

/* ONE GRID ACROSS ALL THREE TABLES is the whole point of the layout — the money block has to line
   up down the screen, and a column added to one table without the others breaks it invisibly. */
ok('the shared grid has twelve slots', M.INC_COLS.length === 12);
ok('the widths sum to something the percentages can divide',
   M.INC_COLS.reduce((a, c) => a + c.w, 0) === 1354);
ok('exactly two vertical rules — identity | performance | money',
   M.INC_COLS.filter(c => c.rule).length === 2);
const mgrH = M.incMgrTable([], () => ({}), false, true, T);
const budH = M.incBudTable([], () => ({}), false, true, T);
const admH = M.incAdminTable({ pdf_name: 'A', target: 1, actual: 1 }, { pct: 100, bonus: 0, hr: 0, payroll: 0 }, true);
[mgrH, budH, admH].forEach(function (t, i) {
  const widths = (t.match(/width:([\d.]+)%/g) || []).length;
  ok('table ' + i + ' sets its column widths on the header', widths >= 10);
});
/* Admin leaves its unused slots EMPTY rather than stretching — stretching is what broke the
   alignment with the two tables below it. */
ok('admin spans its unused middle slots rather than widening the used ones',
   /colspan="4"/.test(admH));
ok('budtenders span Discount across the % Goal slot they do not have',
   /colspan="2"[^>]*>|colspan="2">/.test(budH) && /Discount/.test(budH));

/* A MISS RECEDES. Before, five columns could go green at once and nothing stood out; the contrast
   between met and missed is the information. */
ok('a met target is green and a missed one is dimmed, not merely un-green',
   M.incGoal(true) === 'crew-inc-hit' && M.incGoal(false) === 'crew-inc-miss');
ok('and "no bar to clear" is neither', M.incGoal(null) === '');
ok('the Payroll header is the only green column header', /crew-inc-payh/.test(budH));

/* The period reads as a person would say it, not as the engine stores it. */
ok('the period label is human', M.incPeriodLabel('2026-08-17', '2026-08-30') === 'Aug 17 – Aug 30, 2026');
ok('a malformed period falls back rather than inventing a date',
   M.incPeriodLabel('', '') === ' → ');

/* The facts line is derived from what is already loaded — never a new fetch, and never nonsense
   on a closed period ("closes in -4 days"). */
ok('a live period counts down and counts people',
   /Current period/.test(M.incFacts({ source: 'live', payPeriod: { current: true, end: '2099-01-30' } },
                                    [{}, {}], [{}])) &&
   /3 people/.test(M.incFacts({ source: 'live', payPeriod: { current: true, end: '2099-01-30' } },
                              [{}, {}], [{}])));
ok('an imported period says so instead of counting down',
   /^Imported/.test(M.incFacts({ source: 'imported' }, [{}], [])));
ok('a closed live period does not count down into the past',
   /^Closed period/.test(M.incFacts({ source: 'live', payPeriod: { current: false } }, [{}], [])));
ok('one person is not "1 people"', /1 person/.test(M.incFacts({ source: 'imported' }, [{}], [])));

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentive view: all passed');
process.exit(fail ? 1 : 0);
