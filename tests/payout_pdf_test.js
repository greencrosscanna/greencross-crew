#!/usr/bin/env node
/* ─── The payout PDF filed to Drive on approval ────────────────────────────────────────────────
 *
 *   RUN:  node tests/payout_pdf_test.js
 *
 * WHY THIS EXISTS
 * Sky has saved one of these by hand every fortnight for 28 periods, into a Drive folder called
 * "Incentive Program Payout Reports". Doing it on approval means the PDF is built from `rows` —
 * the exact array being written to crew_incentive_history — so the document, the record and the
 * Capstone export are one source and cannot drift.
 *
 * The hand-filed folder shows what drifts when a person does it: `8.3.26-8.16.26.pdf`,
 * `07.06.26-07.19.26.pdf`, `033026-041226.pdf`, and one saved as `...6.7.26pdf` with the dot
 * missing. The name is derived here, not typed.
 *
 * WHAT MUST HOLD:
 *   1. The filename matches the archive convention exactly, MMDDYY-MMDDYY.
 *   2. A re-approval never overwrites the file that was filed the first time — reopening a period
 *      produces different figures ON PURPOSE, and both are part of the paper record.
 *   3. A Drive failure NEVER fails the approval. The history rows are already written by then and a
 *      period cannot be approved twice, so throwing would report an error for work that succeeded
 *      and the obvious retry would answer "already a closed record".
 *   4. The paid figure is column 14 (carrying any override), and a hand-set figure is MARKED — a
 *      payroll printout in greyscale still has to show which numbers a person decided.
 *   5. The report is built from the frozen rows, not recomputed.
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

/* Real frozen rows, in HISTORY_HEADERS order, including Levy's override (paid 25, computed 0). */
const R = (section, name, store, txn, sales, disc, aov, spiff, bonus, paid, computed, note) =>
  ['2026-08-17', '2026-08-30', section, name.toLowerCase().replace(' ', '_'), name, store, '',
   txn, sales, disc, aov, spiff, bonus, '', paid, 'approved by sky', 'approved',
   '2026-09-03T01:00:00Z', computed, note || ''];

const rows = [
  R('budtender', 'Levy Nelson', 'Baseline', 203, 5842, 1.04, 28.78, 11.25, 11.25, 25, 0,
    'Paid $25 on the original approval at a 1.00% discount; LB now reports 1.04%.'),
  R('budtender', 'Ayla McArthur', 'Century', 413, 12000, 0.5, 34.2, 0, 50.5, 40, 40, ''),
  R('manager', 'Shawn Todd', 'Commercial', '', 90000, 1.2, 33.5, 0, 100, 100, 100, ''),
  R('admin', 'Skyler Pinnick', '', '', 890000, '', '', '', 0, 0, 0, '')
];

const M = new Function(
  'wfMoney_', 'GXCore',
  fnSrc('payoutMMDDYY_') + '\n' + fnSrc('payoutFileName_') + '\n' + fnSrc('payoutHtml_') + '\n' +
  'var PAYOUT_FOLDER_ID = "SEED";\n' + fnSrc('payoutFolderId_') + '\n' +
  '; return { mmddyy: payoutMMDDYY_, fileName: payoutFileName_, html: payoutHtml_, folder: payoutFolderId_ };'
)(v => '$' + (Number(v) || 0).toFixed(2), { getKv: () => '' });

console.log('\nThe filename follows the archive, not a typist');
{
  ok('033026-041226 — the file Sky pointed at',
     M.fileName('2026-03-30', '2026-04-12') === 'Incentive Dashboard - 033026-041226');
  ok('081726-083026 — the period being approved',
     M.fileName('2026-08-17', '2026-08-30') === 'Incentive Dashboard - 081726-083026');
  /* The hand-filed names this replaces. */
  ok('never produces Mike\'s "8.3.26-8.16.26" shape',
     !/\d\.\d/.test(M.fileName('2026-08-03', '2026-08-16')));
  ok('a missing date yields NO name rather than half of one',
     M.fileName('2026-08-17', '') === '' && M.fileName('', '2026-08-30') === '');
}

console.log('\nThe report is built from the frozen rows');
{
  const split = { manager: 100, budtender: 65, admin: 0 };
  const overrides = { rows: [{ name: 'Levy Nelson', paid: 25, computed: 0,
                               note: 'Paid $25 on the original approval.' }], net: 25 };
  const h = M.html('2026-08-17', '2026-08-30', rows, split, 165, 'sky',
                   '2026-09-03T01:00:00Z', overrides, { total: 11.25 });

  ok('names the pay period', h.includes('2026-08-17') && h.includes('2026-08-30'));
  ok('states who approved it and when', h.includes('sky') && h.includes('2026-09-03'));
  ok('carries the three-way split and the total',
     h.includes('$100.00') && h.includes('$65.00') && h.includes('$165.00'));
  ok('lists every person', ['Levy Nelson', 'Ayla McArthur', 'Shawn Todd', 'Skyler Pinnick']
     .every(n => h.includes(n)));
  ok('has all three sections', /Budtenders/.test(h) && /Managers/.test(h) && /Admin/.test(h));

  /* The claim the email makes, in the medium that outlives it. */
  ok('the manual adjustment is called out', /set by hand/.test(h));
  ok('…with what the math said', h.includes('was $0.00'));
  ok('…and the reason', /Paid \$25 on the original approval/.test(h));
  /* Greyscale-safe: the diamond, not just a color. */
  ok('a hand-set figure is marked with the diamond, not only colored',
     (h.match(/&#9670;/g) || []).length >= 2);

  ok('vendor SPIFF is named as vendor money, not payroll', /not payroll/.test(h));

  /* Money must come from the PAID column, never the computed one. */
  ok('Levy prints the $25 she was paid, not the $0 the math now computes',
     h.includes('$25.00'));
}

console.log('\nDrive cannot break an approval that already succeeded');
{
  const FILE = fnSrc('filePayoutPdf_');
  ok('every Drive call is inside a try', /try \{[\s\S]*DriveApp/.test(FILE));
  ok('it returns a failure instead of throwing', /catch \(e\)[\s\S]*return \{ ok: false/.test(FILE));
  ok('no throw anywhere in the filer', !/\bthrow\b/.test(FILE));
  ok('a permission error explains the revoke-and-reconsent fix', /myaccount\.google\.com/.test(FILE));

  const APPROVE = fnSrc('incentiveApprove_');
  const iWrite = APPROVE.indexOf('setValues(rows)');
  const iPdf = APPROVE.indexOf('filePayoutPdf_');
  ok('the PDF is filed AFTER the history write', iWrite > 0 && iPdf > iWrite);
  ok('…and after the workflow is marked approved',
     APPROVE.indexOf("status: 'approved'") < iPdf);
  ok('its result rides along on the response, so a failure is visible', /pdf: pdf/.test(APPROVE));
}

console.log('\nA re-approval does not overwrite the original filing');
{
  const FILE = fnSrc('filePayoutPdf_');
  ok('an existing file of that name is detected', /getFilesByName/.test(FILE));
  ok('…and the new one is renamed rather than replacing it', /reapproved/.test(FILE));
  ok('nothing is ever trashed or overwritten in the filer',
     !/setTrashed|removeFile|setContent/.test(FILE));
}

console.log('\nThe folder is configurable but never depends on a live read');
{
  ok('falls back to the constant when GX Core says nothing', M.folder() === 'SEED');
  const F = fnSrc('payoutFolderId_');
  ok('a failed GX Core read cannot cost the filing', /catch \(e\) \{\}/.test(F));
}

console.log('\nThe backfill can only ever file a record that already exists');
{
  /* Approval is immutable, so there is no "run it again to see" on the real path. This route reads
     the FROZEN rows and renders the same report — which is also how the 27 historical periods that
     predate the feature get a filed PDF. */
  const F = fnSrc('pdfFile_');
  ok('it is deploy-secret gated', /deploySecretOk_/.test(F));
  ok('it REFUSES a period that is not in history',
     /is not an approved period/.test(F));
  ok('it reads the frozen rows, it does not recompute',
     /readTab_\(HISTORY_TAB, HISTORY_HEADERS\)/.test(F) && !/incCalcBud_|fetchLivePerf_/.test(F));
  ok('rows go back into HISTORY_HEADERS order, since payoutHtml_ reads BY INDEX',
     /HISTORY_HEADERS\.map/.test(F));
  ok('the paid figure is column 14 and computed 18, as everywhere else',
     /r\[14\]/.test(F) && /r\[18\]/.test(F));
  ok('dry=1 writes nothing and says whether the file is already there',
     /dry_run: true/.test(F) && /already_there/.test(F) && /nothing written/.test(F));
  ok('it credits whoever APPROVED it, not whoever ran the backfill',
     /wf\.decided_by/.test(F));
  /* It decides nothing, so it needs no approver gate — but it must not be able to write history. */
  ok('it cannot write to history', !/setValues|historySheet_\(\)/.test(F));
}

console.log("\n'' and 0 are different claims — the oldest report has no payroll column");
{
  /* 2025-08-04 (`gen1`) carries a real bonus for all 37 people and NO payroll figure at all.
     Through `Number(x) || 0` that renders "$0.00" against every name and a $0.00 total, which does
     not say "this report predates the column" — it says nobody was paid, on a payroll document. */
  const g1 = [
    R('budtender', 'Robert Wydick', 'River', 550, '', '', '', '', 40, '', '', ''),
    R('budtender', 'Jon Juslen', 'Century', 300, '', '', '', '', 25, '', '', ''),
    R('manager', 'Shawn Todd', 'Commercial', '', '', '', '', '', 65, '', '', '')
  ];
  const h = M.html('2025-08-04', '2025-08-17', g1, { manager: 0, budtender: 0, admin: 0 }, 0,
                   'import', '2025-08-18T00:00:00Z', { rows: [], net: 0 }, null);
  /* Only the explanatory sentence may contain that string — never a table cell. */
  const cells = h.replace(/<p style="border-left[\s\S]*?<\/p>/, '');
  ok('no "$0.00" is printed against anybody in the table', !/\$0\.00/.test(cells));
  ok('blank sales and SPIFF are dashes too, not zeros',
     (cells.match(/&mdash;/g) || []).length >= 3);
  ok('payroll reads as an em dash instead', /&mdash;/.test(h));
  ok('it says the report predates the payroll column', /predates the payroll column/.test(h));
  ok('and shows the BONUS total, which the source did record', /Total bonus/.test(h) && /\$130\.00/.test(h));
  ok('the people are still all listed',
     ['Robert Wydick', 'Jon Juslen', 'Shawn Todd'].every(n => h.includes(n)));

  /* And the normal case must be untouched by that branch. */
  const ok2 = M.html('2026-08-17', '2026-08-30', rows, { manager: 100, budtender: 65, admin: 0 }, 165,
                     'sky', '2026-09-03T01:00:00Z', { rows: [], net: 0 }, null);
  ok('a report WITH payroll still shows the three-way split',
     /Manager bonuses/.test(ok2) && !/predates the payroll column/.test(ok2));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
