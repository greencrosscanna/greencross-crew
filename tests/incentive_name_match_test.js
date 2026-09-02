#!/usr/bin/env node
/* ─── The incentive import's name matcher must not drift from the engine's ────────────────────────
 *
 *   RUN:  node tests/incentive_name_match_test.js
 *
 * WHY
 * tools/match_incentive_names.py reconciles a year of payout history against the GX Core registry,
 * and it does that with a PYTHON PORT of the engine's own ladder (nameToKey_, canonFirst_, ratio_,
 * nameParts_, samePerson_). Crew's CLAUDE.md is explicit that two detectors disagreeing about
 * whether somebody is already on the roster is worse than either alone: one hides a real person,
 * the other proposes a duplicate of an existing one. A port that silently drifts from the original
 * is exactly that second detector.
 *
 * There is no way to run Python from this gate, so this pins the thing that actually drifts: the
 * NICKNAMES table, which is hand-maintained in both files and is what the matcher's correctness
 * turns on. The behavioral cases below run the ENGINE's copy against the real names in the PDFs.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label)
                                 : (fail++, console.log('  ✗ ' + label));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const py = fs.readFileSync(__dirname + '/../tools/match_incentive_names.py', 'utf8');

function pairs(text, start) {
  const i = text.indexOf(start);
  if (i < 0) throw new Error('NICKNAMES table not found: ' + start);
  const body = text.slice(i, text.indexOf('}', i));
  const out = {};
  for (const m of body.matchAll(/'?([a-z]+)'?\s*:\s*'([a-z]+)'/g)) out[m[1]] = m[2];
  return out;
}
const A = pairs(gs, 'var NICKNAMES');
const B = pairs(py, 'NICKNAMES = {');

ok('both NICKNAMES tables were found and are non-trivial', Object.keys(A).length > 8 && Object.keys(B).length > 8);
const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
const diff = keys.filter(k => A[k] !== B[k]);
ok('engine and importer agree on every nickname (' + keys.length + ' entries)' +
   (diff.length ? ' — differs on: ' + diff.map(k => `${k}: ${A[k]}/${B[k]}`).join(', ') : ''),
   diff.length === 0);

/* Run the ENGINE's own ladder over the names the PDFs actually contain. Each of these is a real
   pair from the 27 payout reports; getting one wrong attaches a year of somebody's pay to the
   wrong person, which no amount of UI review would catch. */
const M = (function () {
  const grab = name => {
    const i = gs.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    let j = gs.indexOf('{', i), d = 0;
    for (let k = j; k < gs.length; k++) {
      if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
    }
    throw new Error('unterminated ' + name);
  };
  const src = 'var NICKNAMES = ' + JSON.stringify(A) + ';' +
    ['canonFirst_', 'ratio_', 'nameParts_', 'samePerson_', 'nameToKey_'].map(grab).join('\n') +
    '; return { samePerson_, nameToKey_, canonFirst_ };';
  return new Function(src)();
})();

const SAME = [
  ['Chris Carney', 'Christopher Carney'],
  ['Mike Kettler', 'Michael Kettler'],
  ['Pam Johnson', 'Pamela Johnson'],
  ['Sam Keck', 'Samuel Keck'],
  ['Jeff Keller', 'Jeffery Keller'],
  ['Nathaniel Schnieder', 'Nathaniel Schneider'],   // misspelled in the sheet
  ['Isaac White', 'Issac White'],                   // misspelled in the registry
  ['Liliana Torres', 'Lilliana Torres'],
  ['Rene Villaneuva', 'Rene Villanueva'],
  ['Sareena Sunshine Gonzalez', 'Sareena Gonzalez'],
  ['Sareena Sunshine Gonzale', 'Sareena Gonzalez'], // the sheet itself truncated this one
  ['TJ Peterson', 'Thomas Peterson'],               // the pair that produced a duplicate record
];
let hits = 0;
for (const [a, b] of SAME) {
  if (M.samePerson_(a, b)) hits++;
  else console.log('  ✗ should match: ' + a + ' / ' + b);
}
ok('all ' + SAME.length + ' real name pairs from the payout PDFs match', hits === SAME.length);
if (hits !== SAME.length) fail++;

/* The bar has to stay high enough to keep DIFFERENT people apart -- these are real colleagues,
   and two of them share a surname. A matcher that fuses them merges two people's pay. */
const DIFFERENT = [
  ['Zachary Babcock', 'Zachary Rodriguez'],
  ['Michael Reynolds', 'Michael Kettler'],
  ['Brody Henry-Logan', 'Ceara Logan'],
  ['Noah Pinkerton', 'Skyler Pinnick'],
  ['Juan Gomez', 'Juan Ramirez'],
];
let kept = 0;
for (const [a, b] of DIFFERENT) {
  if (!M.samePerson_(a, b)) kept++;
  else console.log('  ✗ must NOT match: ' + a + ' / ' + b);
}
ok('all ' + DIFFERENT.length + ' distinct-colleague pairs stay apart', kept === DIFFERENT.length);
if (kept !== DIFFERENT.length) fail++;

/* nameToKey_ strips the quotes the sheet embedded nicknames with, so the key is stable either way. */
ok('quoted nicknames do not change the key',
   M.nameToKey_('Jennifer "Jayce" Alexander') === M.nameToKey_('Jennifer Jayce Alexander'));

/* ── Dutchie's legal name vs the board's nickname (2026-09-02) ───────────────────────────────────
   SPIFF attributes from Dutchie, which prints the LEGAL name; the board leads with the nickname.
   Drew Phillips is the sharpest case on the roster — ratio_('drew','andrew') sits right on the 0.8
   bar and neither is a prefix of the other, so before `drew` joined NICKNAMES this was FALSE and
   $2.25 of his SPIFF was reported as "owed but not on this board" while he was on it. */
ok('Dutchie\'s "Andrew Phillips" is the board\'s "Drew Phillips"',
   M.samePerson_('Andrew Phillips', 'Drew Phillips'));
ok('...and the reverse direction holds too',
   M.samePerson_('Drew Phillips', 'Andrew Phillips'));
/* The bar has to stay tight enough to keep the two Andrews apart — they share a first name and
   both work here, so a looser rule would attach one person's vendor money to the other. */
ok('two different people who share a first name still do not match',
   !M.samePerson_('Andrew Phillips', 'Andrew Roberts'));
ok('and an unrelated pair does not match', !M.samePerson_('Drew Phillips', 'Pam Johnson'));

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentive name match: all passed');
process.exit(fail ? 1 : 0);
