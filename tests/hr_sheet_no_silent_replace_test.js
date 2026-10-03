#!/usr/bin/env node
/* ─── A STORED HR WORKBOOK IS NEVER SILENTLY REPLACED ──────────────────────────────────────────
 *
 *   RUN:  node tests/hr_sheet_no_silent_replace_test.js
 *
 * THIS IS A REGRESSION TEST FOR A PRODUCTION INCIDENT, 2026-10-03.
 *
 * crewSheetPrepare_ opened the HR workbook by its stored id and, on ANY throw, created a new
 * spreadsheet and overwrote CREW_SHEET_ID with the empty one. A single transient Drive error did
 * it: 17:45 UTC the real sheet read fine, 18:00 UTC a replacement existed, and from then on every
 * wage, birthday, permit number and employee number was blank for all 42 people. The data was
 * never touched — only the pointer to it.
 *
 * WHAT MAKES IT WORTH A TEST RATHER THAN A COMMENT:
 *
 *   - IT LOOKS LIKE DATA ENTRY, NOT AN OUTAGE. Identity (name, store, role, hire date) comes from
 *     GX Core and kept working, so the roster rendered fully populated and correct. Only this
 *     workbook's own columns went blank, which reads as "nobody filled these in".
 *   - THE REPLACEMENT HAS THE SAME NAME. Drive then lists two identical titles and only the file
 *     size tells them apart — and the stored id, which has just been overwritten, was the only
 *     record of which one was real.
 *   - THE AUTO-CREATE IS STILL CORRECT FOR AN EMPTY INSTALL, so it cannot simply be deleted. The
 *     distinction being pinned is between "no id yet" (nothing to lose) and "the id I was given
 *     will not open" (everything to lose).
 *
 * Executes the SHIPPED crewSheetPrepare_ against fake SpreadsheetApp/PropertiesService.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
/* Comments are BLANKED, not deleted, and their newlines are kept — so a declaration is found at its
 * real position and a line number still means something. ATTR_HEADERS is the reason this is not a
 * bare `[^;]+;` regex: it carries an inline comment containing a semicolon ("...an HR attribute;"),
 * which truncated the capture mid-comment and left the rest of the extracted source inside an
 * unterminated block comment. The symptom was a syntax error pointing at a line that was fine. */
const gsBare = gs.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                 .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
function constOf(name) {
  const m = new RegExp('var ' + name + '\\s*=\\s*[^;]+;').exec(gsBare);
  if (!m) throw new Error('missing const ' + name);
  return m[0];
}

function makeCtx({ storedId, openThrows }) {
  const props = new Map();
  if (storedId) props.set('CREW_SHEET_ID', storedId);
  const created = [];
  const sheet = {
    getLastColumn: () => 1, getLastRow: () => 1, getMaxRows: () => 5,
    getRange: () => ({ getValues: () => [['employee_id']], setValues() { return this; },
                       setFontWeight() { return this; }, setNumberFormat() { return this; } }),
    setFrozenRows() {}, getName: () => 'attrs',
  };
  const realSS = { getId: () => storedId, getSheetByName: () => sheet, insertSheet: () => sheet,
                   getUrl: () => 'https://real' };
  const ctx = {
    console, JSON, Object, Array, String, Number, Math, Date, RegExp, Error,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, v); },
    }) },
    SpreadsheetApp: {
      openById(id) {
        if (openThrows) throw new Error('Drive hiccup');
        return realSS;
      },
      create(name) {
        created.push(name);
        return { getId: () => 'NEW_EMPTY_ID', getSheetByName: () => null,
                 insertSheet: () => sheet, getUrl: () => 'https://new' };
      },
    },
    attrHeaders_: () => ['employee_id'],
  };
  vm.createContext(ctx);
  vm.runInContext([
    constOf('CREW_SHEET_ID_PROP'), constOf('ATTR_TAB'), constOf('ATTR_HEADERS'),
    grab('crewSheetPrepare_'),
  ].join('\n'), ctx);
  return { ctx, props, created };
}

console.log('\n1. a stored id that will not open is an ERROR — never a replacement');
{
  const { ctx, props, created } = makeCtx({ storedId: 'REAL_ID', openThrows: true });
  let threw = null;
  try { ctx.crewSheetPrepare_(); } catch (e) { threw = e; }
  ok('it throws rather than carrying on', !!threw);
  ok('NO replacement spreadsheet is created', created.length === 0);
  ok('the stored id is left ALONE — it is the only record of which file is real',
    props.get('CREW_SHEET_ID') === 'REAL_ID');
  ok('the message names the id, so recovery does not need a Drive hunt',
    !!threw && threw.message.includes('REAL_ID'));
  ok('...and names the property to restore',
    !!threw && threw.message.includes('CREW_SHEET_ID'));
}

console.log('\n2. a FRESH install still auto-creates — there is nothing to lose');
{
  const { ctx, props, created } = makeCtx({ storedId: '', openThrows: false });
  let threw = null;
  try { ctx.crewSheetPrepare_(); } catch (e) { threw = e; }
  ok('no id stored → no throw', !threw);
  ok('...a workbook is created', created.length === 1);
  ok('...and its id is remembered', props.get('CREW_SHEET_ID') === 'NEW_EMPTY_ID');
}

console.log('\n3. the ordinary path is untouched');
{
  const { ctx, props, created } = makeCtx({ storedId: 'REAL_ID', openThrows: false });
  let threw = null;
  try { ctx.crewSheetPrepare_(); } catch (e) { threw = e; }
  ok('a reachable stored sheet opens cleanly', !threw);
  ok('...creating nothing', created.length === 0);
  ok('...and leaving the id as it was', props.get('CREW_SHEET_ID') === 'REAL_ID');
}

console.log(fail ? `\nhr sheet replace guard: ${fail} FAILED` : '\nhr sheet replace guard: all passed');
process.exit(fail ? 1 : 0);
