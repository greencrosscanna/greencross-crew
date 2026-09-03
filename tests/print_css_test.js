#!/usr/bin/env node
/* ─── Print PDF — the rules that decide what lands on paper ────────────────────────────────────
 *
 *   RUN:  node tests/print_css_test.js
 *
 * WHY THIS EXISTS
 * "Print PDF" produced a BLANK page. Not a broken layout — blank paper, from a button on a payroll
 * screen, with no error anywhere.
 *
 * There were two @media print blocks in index.html. The second one said:
 *
 *     body * { visibility: hidden; }
 *     .inc-wrap, .inc-wrap * { visibility: visible; }
 *
 * Hide everything, then win back the report. That is a legitimate print idiom and it worked in
 * Leaderboard, where the incentive root really is `.inc-wrap`. Crew's is `.crew-inc-wrap` — the
 * bare `inc-` names came over with the transplanted tray CSS and were never re-prefixed. So the
 * first rule matched every element on the page, the second matched nothing at all, and the PDF
 * came out empty.
 *
 * WHY IT COULD NOT BE CAUGHT BY READING IT: `visibility: hidden` on `body *` cannot be overridden
 * by the other print block, however careful that one is. Whichever block is wrong simply wins, in
 * silence, and only in print — a medium nobody looks at until they need the document.
 *
 * WHAT MUST HOLD:
 *
 *   1. Nothing blanket-hides the document in print. This is the bug, exactly.
 *   2. No print rule targets a class this app never renders — that is the prefix drift itself, and
 *      it is invisible until somebody prints.
 *   3. The report's own furniture survives to paper: the table, the money column, the pay period.
 *   4. The screen-only chrome does not.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const APPJS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');

/* Strip /* … *​/ comments before looking at rules. The fix left a long comment QUOTING the deleted
   rule, on purpose — so a test that greps raw source would read the explanation as the bug and
   fail forever, which is how a warning comment gets deleted by the next person. */
const CSS = HTML.replace(/\/\*[\s\S]*?\*\//g, '');

/* Every @media print block, with its body. */
function printBlocks(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('@media print', i)) >= 0) {
    const open = src.indexOf('{', i);
    let d = 0, end = -1;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) { end = k; break; } }
    }
    out.push(src.slice(open + 1, end));
    i = end;
  }
  return out;
}
const BLOCKS = printBlocks(CSS);

console.log('\nNothing blanket-hides the document');
{
  ok('there is at least one print block', BLOCKS.length > 0);
  const all = BLOCKS.join('\n');
  /* The exact shape of the bug. */
  ok('no `body * { visibility: hidden }`',
     !/body\s*\*\s*\{[^}]*visibility\s*:\s*hidden/.test(all));
  ok('nothing hides the whole body by display either',
     !/(^|[^-\w])body\s*\{[^}]*display\s*:\s*none/.test(all));
  /* Hide-all-then-reveal is workable but it is what produced blank paper here; the surviving block
     hides named chrome instead. If someone reintroduces the idiom, they must prove the target
     exists — which is the next assertion. */
  const revealers = all.match(/([.#][\w-]+)[^{]*\{[^}]*visibility\s*:\s*visible/g) || [];
  ok('no rule wins visibility back for an element that is never rendered',
     revealers.every(r => {
       const cls = (r.match(/\.([\w-]+)/) || [])[1];
       return !cls || new RegExp('[\'"\\s.]' + cls + '[\'"\\s]').test(APPJS);
     }));
}

console.log('\nNo print rule targets a class this app never renders');
{
  /* The prefix drift, generalised. Every `.crew-inc-*` / `.inc-*` class named in a print rule must
     appear in crew.js (which builds the DOM) or in index.html's own markup. `.inc-wrap` failed
     exactly this and cost a blank payroll document. */
  const named = new Set();
  BLOCKS.join('\n').replace(/\.((?:crew-)?inc[\w-]*)/g, (_, c) => named.add(c));
  const missing = [...named].filter(c => {
    const re = new RegExp('[\'"\\s.>]' + c + '[\'"\\s.<]');
    return !re.test(APPJS) && !re.test(HTML.replace(/@media print[\s\S]*?\n\s*\}/g, ''));
  });
  ok('every incentive class named in a print rule exists' +
     (missing.length ? ' — orphaned: ' + missing.join(', ') : ''), missing.length === 0);
  ok('`.inc-wrap` specifically is gone (the one that blanked the page)', !named.has('inc-wrap'));
}

console.log('\nThe report survives to paper, the chrome does not');
{
  const all = BLOCKS.join('\n');
  const hiddenList = (all.match(/([^{}]+)\{[^}]*display\s*:\s*none[^}]*\}/g) || []).join(' ');
  const hides = c => new RegExp('\\.' + c + '\\b').test(hiddenList);

  ok('the buttons are hidden on paper', hides('crew-inc-actions'));
  ok('the import back-link is hidden', hides('crew-imp-back'));
  ok('the settings gear is hidden', hides('crew-inc-gear'));
  ok('the bug reporter is hidden', /gxBugFab|gx-bug-fab/.test(hiddenList));

  /* The <select> prints as an empty box, so a plain-text twin carries the period. On a payroll
     record, the fortnight it covers is not optional. */
  ok('the pay period has a plain-text twin that is shown in print',
     /crew-inc-printpp[^}]*\{[^}]*display\s*:\s*inline/.test(all));
  ok('…and the app actually renders that twin', /crew-inc-printpp/.test(APPJS));

  /* Money must not be hidden or dropped to a gray that vanishes on a laser printer. */
  ok('the payroll column is not hidden', !hides('crew-inc-pay'));
  ok('the tables are not hidden', !hides('crew-inc-tbl') && !hides('crew-inc-wrap'));
  ok('a person row cannot straddle a page break',
     /crew-inc-tbl tr\s*\{[^}]*page-break-inside\s*:\s*avoid/.test(all));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
