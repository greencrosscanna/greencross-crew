#!/usr/bin/env node
/* Prove tests/attr_text_pin_test.js red, one guard at a time.
 *
 * Mutates a SCRATCH COPY of Code.gs (never the real one — CODE_GS exists for this, and nothing in
 * the repo or the push gate sets it) and reports how many assertions each change costs. A change
 * that costs zero is something the test is not actually holding.
 *
 *   node scripts/prove-attr-text-pin-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-textpin-'));

function inFn(s, name, from, to) {
  const i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) return s;
  const j = s.indexOf('\nfunction ', i + 10);
  const body = s.slice(i, j < 0 ? s.length : j);
  const out = typeof from === 'string' ? body.split(from).join(to) : body.replace(from, to);
  return s.slice(0, i) + out + (j < 0 ? '' : s.slice(j));
}
/* A writer that goes around writeAttrs_: the row is written straight to the tab, with no pin. */
const BYPASS = "(function (r) { var s = crewSheet_(); s.appendRow(attrHeaders_(s).map(function (h) { return r[h] == null ? '' : r[h]; })); })";

const MUTATIONS = [
  /* The pin back on the read path, three ways. Each must fail the zero-writes assertion. */
  ['every request pins the tab again (the old behavior)',
   (s) => inFn(s, 'crewSheetPrepare_', "  if (forWrite === true) pinText(have);", "  pinText(have);")],
  ['crewSheet_ asks for the tab for write',
   (s) => inFn(s, 'crewSheet_', "_crewSheetMemo_ = crewSheetPrepare_();", "_crewSheetMemo_ = crewSheetPrepare_(true);")],
  ['readAttrs_ pins the tab as it reads',
   (s) => inFn(s, 'readAttrs_', "  var sh = crewSheet_();", "  var sh = crewSheetPrepare_(true);")],

  /* The pin taken away from the write path. */
  ['writeAttrs_ does not ask for the pin',
   (s) => inFn(s, 'writeAttrs_', "crewSheetPrepare_(true);", "crewSheetPrepare_();")],
  ['writeAttrs_ uses the per-request memo instead of preparing fresh',
   (s) => inFn(s, 'writeAttrs_', "var sh = _crewSheetMemo_ = crewSheetPrepare_(true);", "var sh = crewSheet_();")],
  ['the pin is applied AFTER the write instead of before',
   (s) => inFn(s, 'writeAttrs_', "var sh = _crewSheetMemo_ = crewSheetPrepare_(true);", "var sh = _crewSheetMemo_ = crewSheetPrepare_();")
            .replace("    else           sh.appendRow(row);\n  } finally {", "    else           sh.appendRow(row);\n    crewSheetPrepare_(true);\n  } finally {")],
  ['a new tab is not pinned as it is created',
   (s) => inFn(s, 'crewSheetPrepare_', /    pinText\(ATTR_HEADERS\);[^\n]*\n/, '')],
  ['the pin is remembered in a script property and skipped the next time',
   (s) => inFn(s, 'crewSheetPrepare_', "  if (forWrite === true) pinText(have);",
     "  if (forWrite === true && !props.getProperty('CREW_ATTRS_PINNED')) { pinText(have); props.setProperty('CREW_ATTRS_PINNED', '1'); }")],
  ['the pin is remembered for the rest of the request and skipped',
   (s) => s.replace("\nfunction crewSheetPrepare_(forWrite) {", "\nvar _pinDone_ = false;\nfunction crewSheetPrepare_(forWrite) {")
           .replace("  if (forWrite === true) pinText(have);", "  if (forWrite === true && !_pinDone_) { pinText(have); _pinDone_ = true; }")],

  /* The pin made weaker. */
  ['employee_number is no longer pinned',
   (s) => inFn(s, 'crewSheetPrepare_', "['employee_number', 'birthday', 'permit_number'].forEach", "['birthday', 'permit_number'].forEach")],
  ['birthday is no longer pinned',
   (s) => inFn(s, 'crewSheetPrepare_', "['employee_number', 'birthday', 'permit_number'].forEach", "['employee_number', 'permit_number'].forEach")],
  ['permit_number is no longer pinned',
   (s) => inFn(s, 'crewSheetPrepare_', "['employee_number', 'birthday', 'permit_number'].forEach", "['employee_number', 'birthday'].forEach")],
  ['only the rows that already hold data are pinned',
   (s) => inFn(s, 'crewSheetPrepare_', "Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@')", "Math.max(sh.getLastRow() - 1, 1), 1).setNumberFormat('@')")],
  ['the pin goes by column POSITION, not by header name',
   (s) => inFn(s, 'crewSheetPrepare_', "      var c = headers.indexOf(h);", "      var c = ATTR_HEADERS.indexOf(h);")],
  ['any truthy argument asks for the pin',
   (s) => inFn(s, 'crewSheetPrepare_', "if (forWrite === true) pinText(have);", "if (forWrite) pinText(have);")],
  ['the nightly run does not re-pin',
   (s) => inFn(s, 'nightlyDutchieScan', "  try { crewSheetPrepare_(true); } catch (e) {}\n", "")],

  /* A writer that goes around the choke point — one mutation per caller of writeAttrs_. */
  ['setNumber_ writes its row around writeAttrs_',        (s) => inFn(s, 'setNumber_', "  writeAttrs_(rec);", "  " + BYPASS + "(rec);")],
  ['assignNumbers_ writes its rows around writeAttrs_',   (s) => inFn(s, 'assignNumbers_', "    writeAttrs_(rec);", "    " + BYPASS + "(rec);")],
  ['saveRosterAttrs_ writes its row around writeAttrs_',  (s) => inFn(s, 'saveRosterAttrs_', "  writeAttrs_(rec);", "  " + BYPASS + "(rec);")],
  ['mergeEmployees_ writes its row around writeAttrs_',   (s) => inFn(s, 'mergeEmployees_', "  writeAttrs_(merged);", "  " + BYPASS + "(merged);")],
  ['hrImport_ writes its rows around writeAttrs_',        (s) => inFn(s, 'hrImport_', "  attrRows.forEach(writeAttrs_);", "  attrRows.forEach(" + BYPASS + ");")],
  ['the Metrc sync writes its rows around writeAttrs_',   (s) => inFn(s, 'metrcPermitSyncRun_', "    try { writeAttrs_(rec); out.written++; }", "    try { " + BYPASS + "(rec); out.written++; }")],
  ['a seventh writer appears: the roster read tidies the tab',
   (s) => inFn(s, 'getRoster_', "  var joined = rosterJoin_();", "  var joined = rosterJoin_();\n  crewSheet_().getRange(1, 1).setValue('employee_id');")],

  /* The reads that must not lean on the format. */
  ['a date-coerced birthday reads as blank again',
   (s) => inFn(s, 'normBirthday_', "    if (!dm) return '';", "    return '';")],
  ['a date-coerced birthday is read through a Date, a day early in another zone',
   (s) => inFn(s, 'normBirthday_', "indexOf(dm[1]) + 1), dm[2]];", "indexOf(dm[1]) + 1), String(Number(dm[2]) - 1)];")],
  ['normBirthday_ accepts a bare month name',
   (s) => inFn(s, 'normBirthday_', "var dm = s.match(/^[A-Z][a-z]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\\d{1,2}) \\d{4} \\d{2}:\\d{2}:\\d{2} GMT/);",
                                    "var dm = s.match(/^([A-Z][a-z]{2} )?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\\d{1,2})/); if (dm) dm = [dm[0], dm[2], dm[3]];")],
  ['employee numbers are compared as text when one is being set',
   (s) => inFn(s, 'setNumber_', "parseInt(held, 10) === parseInt(num, 10)", "held === num")],
  ['the next number is counted from text, not numbers',
   (s) => inFn(s, 'assignNumbers_', "if (!isNaN(n) && n > 0) { used[n] = true; if (n > maxN) maxN = n; }", "if (!isNaN(n) && n > 0) { used[n] = true; if (String(v) > String(maxN)) maxN = n; }")],
  ['permit numbers are matched as written, leading zeros and all',
   (s) => inFn(s, 'metrcPermitKey_', "return /^\\d+$/.test(s) ? s.replace(/^0+(?=\\d)/, '') : s;", "return s;")],

  /* The workbook guard. */
  ['the pin path creates a workbook when the stored one will not open',
   (s) => inFn(s, 'crewSheetPrepare_', /      throw new Error\(\n        'GX Crew HR workbook '[\s\S]*?do not let anything write until it is back\.'\);/, "      if (forWrite !== true) throw new Error('GX Crew HR workbook ' + id + ' could not be opened. NOT auto-creating a replacement');")],
];

let problems = 0;
MUTATIONS.forEach(([label, mutate], i) => {
  const out = mutate(SRC);
  if (out === SRC) {
    console.log('  !! ' + label + ' — the mutation matched nothing; this proof is checking nothing');
    problems++;
    return;
  }
  const file = path.join(dir, 'mutant' + i + '.gs');
  fs.writeFileSync(file, out);
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'attr_text_pin_test.js')],
                      { env: Object.assign({}, process.env, { CODE_GS: file }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let failed = 0;
  if (r.status !== 0) {
    const m = String(r.stdout || '').match(/\n(\d+) FAILED/);
    failed = m ? Number(m[1]) : -1;
  }
  if (failed > 0) console.log('  ✓ ' + label + ' → ' + failed + ' assertion(s) fail');
  else if (failed < 0) { console.log('  ✗ ' + label + ' → the test died without a count: ' + String(r.stderr || '').split('\n')[0]); problems++; }
  else { console.log('  ✗ ' + label + ' → STILL GREEN. The test is not holding this.'); problems++; }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(problems ? '\n' + problems + ' of ' + MUTATIONS.length + ' mutation(s) not held.\n'
                     : '\nAll ' + MUTATIONS.length + ' guards are individually held by the test.\n');
process.exit(problems ? 1 : 0);
