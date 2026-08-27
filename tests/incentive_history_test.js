#!/usr/bin/env node
/* ─── Imported payout history is immutable ────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/incentive_history_test.js
 *
 * WHY
 * Sky, 2026-08-26: "historical needs to be imported but not changed." Every assertion here is that
 * sentence. These 27 pay periods are what people were actually paid; the benchmarks behind them
 * have already moved once (the source spreadsheet measured GROSS discount against ~2.75%, the app
 * measures DISCRETIONARY discount against 1.5%) and will move again. Nothing about a closed period
 * may depend on today's numbers.
 *
 * The failure this guards against is not an exception — it is a re-run that quietly restates a paid
 * figure and reports success. Leaderboard has the same bug in miniature right now: its performance
 * data freezes but its thresholds do not, so editing the discount goal re-scores every period that
 * already paid out.
 *
 * Runs the ENGINE's real incentiveImport_ against an in-memory sheet, so these are behaviours, not
 * a reading of the source.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

/* ── A sheet that behaves like the parts of the Apps Script API this code touches ── */
function makeSheet(headers) {
  return {
    rows: [headers.slice()],
    getLastRow() { return this.rows.length; },
    getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; },
    deleteRow(n) { this.rows.splice(n - 1, 1); },
    getRange(r, c, nr, nc) {
      const s = this;
      if (nr === undefined) { nr = 1; nc = 1; }      // getRange(row, col) — a single cell
      return {
        setValue(v) { s.rows[r - 1][c - 1] = v; return this; },
        setValues(vals) {
          vals.forEach((row, i) => {
            while (s.rows.length < r - 1 + i + 1) s.rows.push(new Array(headers.length).fill(''));
            s.rows[r - 1 + i] = row.slice();
          });
          return this;
        },
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        getValues() { return s.rows.slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)); },
      };
    },
    setFrozenRows() {},
  };
}

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
/* Read the header list out of the engine rather than restating it here: a test carrying its own
   copy of the column order passes happily while the real sheet writes into the wrong columns. */
const HEADERS = (function () {
  const m = gs.match(/var HISTORY_HEADERS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('HISTORY_HEADERS not found in Code.gs');
  return new Function('return ' + m[1])();
})();

function load(sheet) {
  const src = `
    var HISTORY_TAB = 'crew_incentive_history';
    var HISTORY_HEADERS = ${JSON.stringify(HEADERS)};
    function deploySecretOk_() { return true; }
    function sheetOf_() { return SHEET; }
    function readTab_(tab, headers) {
      var last = SHEET.getLastRow(); if (last < 2) return [];
      return SHEET.getRange(2, 1, last - 1, headers.length).getValues().map(function (r) {
        var o = {}; headers.forEach(function (h, i) { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
        return o;
      });
    }
    ${grab('historyStoreId_')} ${grab('historyPeriods_')}
    ${grab('incentiveImport_')} ${grab('incentiveHistory_')} ${grab('incentiveRelink_')}
    return { incentiveImport_: incentiveImport_, incentiveHistory_: incentiveHistory_,
             incentiveRelink_: incentiveRelink_, historyPeriods_: historyPeriods_ };`;
  // resolveStore is GX Core's; the local table this replaces is exactly what must not exist.
  const GXCore = { resolveStore: l => ({ 'Hillsboro': { store_id: 'hillsboro' },
                                         'Portland Road': { store_id: 'portland-rd' },
                                         'River Rd': { store_id: 'river-rd' },
                                         'Bend': { store_id: 'bend' } }[l] || null) };
  return new Function('SHEET', 'GXCore', 'Date', src)(sheet, GXCore, Date);
}

const PERIOD = {
  pp_start: '2026-08-03', pp_end: '2026-08-16', format: 'gen2', file: 'x.pdf',
  admin: { name: 'Michael Kettler', bonus: 300, payroll: 300 },
  managers: [{ name: 'Chris Carney', store_label: 'Bend', bonus: 250, payroll: 250, spiff: 0 }],
  budtenders: [{ name: 'Sam Keck', store_label: 'Bend', txn: 221, sales: 6953.67,
                 discount_pct: 7.3, aov: 31.46, spiff: 25, bonus: 40, per_hour: 0.5, payroll: 15 }],
};
const NAMES = { 'Chris Carney': 'christopher_carney', 'Sam Keck': 'samuel_keck',
                'Michael Kettler': 'michael_kettler' };
const body = () => ({ periods: [JSON.parse(JSON.stringify(PERIOD))], names: NAMES });

/* ── dry by default ── */
let sheet = makeSheet(HEADERS); let M = load(sheet);
let r = M.incentiveImport_({}, body());
ok('dry run by default — writes nothing without confirm=yes', r.dry_run === true && sheet.getLastRow() === 1);
ok('a dry run still reports what it would write', r.rows === 3 && r.bonus_total === 590);

/* ── the write ── */
r = M.incentiveImport_({ confirm: 'yes' }, body());
ok('confirm=yes writes every section (admin + manager + budtender)', r.written === 3 && sheet.getLastRow() === 4);

/* THE GUARANTEE. A second run of the same import — a re-parse, or a second operator typing the
   same command — must not restate a paid figure. It reports the skip rather than failing, because
   re-running an import over a mix of new and old periods is normal and only the old ones skip. */
r = M.incentiveImport_({ confirm: 'yes' }, body());
ok('re-importing an already-imported period is REFUSED, not silently rewritten',
   r.skipped_already_imported.length === 1 && r.written === undefined && sheet.getLastRow() === 4);

/* Replacing needs BOTH the mode and the confirmation — either alone leaves history untouched. */
const mutated = () => { const b = body(); b.periods[0].budtenders[0].bonus = 9999; return b; };
r = M.incentiveImport_({ confirm: 'yes' }, mutated());
ok('mode=replace omitted — a changed figure cannot overwrite history', r.skipped_already_imported.length === 1);
r = M.incentiveImport_({ mode: 'replace' }, mutated());
ok('confirm omitted — mode=replace alone is still a dry run', r.dry_run === true && sheet.getLastRow() === 4);
let after = sheet.getDataRange().getValues().find(x => x[4] === 'Sam Keck');
ok('the stored bonus survived both attempts', Number(after[12]) === 40);

r = M.incentiveImport_({ mode: 'replace', confirm: 'yes' }, mutated());
ok('mode=replace WITH confirm=yes does replace, and says which period it replaced',
   r.replaced[0] === '2026-08-03' && r.written === 3);
ok('replacing leaves no duplicate rows behind', sheet.getLastRow() === 4);
after = sheet.getDataRange().getValues().find(x => x[4] === 'Sam Keck');
ok('and the replacement value is the one that landed', Number(after[12]) === 9999);

/* ── what the document did not say stays EMPTY ──
   The oldest report has no PAYROLL column at all. '' and 0 are different claims about a fortnight
   that paid people, and only one of them is true — a zero here would assert the company paid
   nothing, which is not what the document says. It says nothing. */
sheet = makeSheet(HEADERS); M = load(sheet);
const gen1 = { periods: [{ pp_start: '2025-08-04', pp_end: '2025-08-17', format: 'gen1', file: 'g.pdf',
  managers: [], budtenders: [{ name: 'Sam Keck', store_label: 'Bend', txn: 145, sales: null,
    discount_pct: 2.97, aov: 27.83, spiff: null, bonus: 0, per_hour: 0, payroll: null }] }], names: NAMES };
M.incentiveImport_({ confirm: 'yes' }, gen1);
const row = sheet.getDataRange().getValues()[1];
ok('an unrecorded payroll is stored EMPTY, not zero', row[14] === '');
ok('an unrecorded sales figure is stored EMPTY, not zero', row[8] === '');
ok('a real zero bonus is still stored as 0', row[12] === 0);
const back = M.incentiveHistory_({ pp_start: '2025-08-04' });
ok('reading it back keeps null distinct from 0',
   back.budtenders[0].payroll === null && back.budtenders[0].bonus === 0);

/* ── a person who has left keeps their history ──
   employee_id is blank and pdf_name carries the only record of who was paid — the same arrangement
   the EoM reign log uses, and for the same reason: a name that can no longer be looked up is not a
   reason to drop the row. */
sheet = makeSheet(HEADERS); M = load(sheet);
M.incentiveImport_({ confirm: 'yes' }, { periods: [{ pp_start: '2025-09-01', pp_end: '2025-09-14',
  format: 'gen2', managers: [], budtenders: [{ name: 'Finnick Winchester', store_label: 'Hillsboro',
  bonus: 40, payroll: 40, spiff: 0 }] }], names: {} });
const gone = sheet.getDataRange().getValues()[1];
ok('a departed person is imported with a blank employee_id, not dropped',
   gone[3] === '' && gone[4] === 'Finnick Winchester' && Number(gone[12]) === 40);
r = M.incentiveImport_({ confirm: 'yes' }, { periods: [{ pp_start: '2025-09-15', pp_end: '2025-09-28',
  format: 'gen2', managers: [], budtenders: [{ name: 'Ceara Logan', store_label: 'Nowhere',
  bonus: 15, payroll: 15 }] }], names: {} });
ok('unresolved names are REPORTED so a human can decide', r.unresolved_names['Ceara Logan'] === 1);
ok('an unresolvable store label is reported and left blank, never guessed',
   r.unresolved_stores['Nowhere'] === 1 && sheet.getDataRange().getValues()[2][6] === '');
ok('a store label that GX Core does know is resolved through it',
   gone[5] === 'Hillsboro' && gone[6] === 'hillsboro');

/* ── relink attaches history to a person and CANNOT touch a figure ──
   Identity and money come apart constantly — Thomas Peterson holds two GX Core records today, and
   after they are merged his 27 periods have to point at the survivor. Doing that through
   mode=replace would delete a year of paid figures and rewrite them from a re-parse, which is the
   operation this whole design exists to prevent, for a change that is not about the figures. */
sheet = makeSheet(HEADERS); M = load(sheet);
M.incentiveImport_({ confirm: 'yes' }, { periods: [{ pp_start: '2026-08-03', pp_end: '2026-08-16',
  format: 'gen2', managers: [{ name: 'TJ Peterson', store_label: 'River Rd', txn: 0, sales: 59247.29,
  discount_pct: 6.99, aov: 32.19, spiff: 0, bonus: 50, per_hour: 0.63, payroll: 50 }],
  budtenders: [] }], names: {} });
const before = sheet.getDataRange().getValues()[1].slice();
ok('a manager with no registry match imports with a blank employee_id', before[3] === '');

r = M.incentiveRelink_({ pdf_name: 'TJ Peterson', employee_id: 'thomas_peterson' });
ok('relink is a dry run by default, and reports what it would change',
   r.dry_run === true && r.rows === 1 && r.currently['(blank)'] === 1);
ok('the dry run wrote nothing', sheet.getDataRange().getValues()[1][3] === '');

r = M.incentiveRelink_({ pdf_name: 'TJ Peterson', employee_id: 'thomas_peterson', confirm: 'yes' });
const relinked = sheet.getDataRange().getValues()[1];
ok('confirm=yes attaches the history to the person', r.written === 1 && relinked[3] === 'thomas_peterson');

/* The assertion that matters: EVERY other cell is byte-for-byte what it was. A relink that
   silently re-rounded a payout would be worse than the duplicate record it was fixing. */
const untouched = before.every((v, i) => i === 3 || Object.is(v, relinked[i]));
ok('every other cell — every figure — is unchanged', untouched);

r = M.incentiveRelink_({ pdf_name: 'Nobody At All', employee_id: 'x', confirm: 'yes' });
ok('relinking a name with no history is refused, not silently a no-op', r.ok === false);

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentive history: all passed');
process.exit(fail ? 1 : 0);
