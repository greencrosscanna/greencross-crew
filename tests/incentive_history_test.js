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
    getLastColumn() { return this.rows[0].length; },
    getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; },
    deleteRow(n) { this.rows.splice(n - 1, 1); },
    getRange(r, c, nr, nc) {
      const s = this;
      if (nr === undefined) { nr = 1; nc = 1; }      // getRange(row, col) — a single cell
      return {
        setValue(v) { s.rows[r - 1][c - 1] = v; return this; },
        /* Writes at the COLUMN OFFSET, like the real API. The first version replaced whole rows,
           which meant the header-append migration appeared to wipe the header instead of extending
           it — the stub was lying in the direction that hides the bug. */
        setValues(vals) {
          vals.forEach((row, i) => {
            const y = r - 1 + i;
            while (s.rows.length <= y) s.rows.push([]);
            const target = s.rows[y];
            while (target.length < c - 1) target.push('');
            row.forEach((v, j) => { target[c - 1 + j] = v; });
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

let REGISTRY = () => [];      // swapped per-test; see stampEmployeeIds_ below

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
    var SCHEME_TAB = 'crew_incentive_schemes';
    var SCHEME_HEADERS = ['pp_start', 'thresholds_json', 'frozen_at', 'frozen_by'];
    var HISTORY_HEADERS = ${JSON.stringify(HEADERS)};
    function deploySecretOk_() { return true; }
    function sheetOf_() { return SHEET; }
    function readTab_(tab, headers) {
      /* The stub holds ONE sheet — the history tab. Any other tab reads empty, which is exactly
         right for the scheme lookup on an imported period: nobody recorded one. */
      if (tab !== HISTORY_TAB) return [];
      var last = SHEET.getLastRow(); if (last < 2) return [];
      return SHEET.getRange(2, 1, last - 1, headers.length).getValues().map(function (r) {
        var o = {}; headers.forEach(function (h, i) { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
        return o;
      });
    }
    ${grab('historyStoreId_')} ${grab('historySheet_')} ${grab('historyPeriods_')}
    ${grab('schemeFor_')} ${grab('freezeScheme_')}
    ${grab('incentiveImport_')} ${grab('incentiveHistory_')} ${grab('incentiveRelink_')}
    ${grab('nameToKey_')} ${grab('canonFirst_')} ${grab('ratio_')} ${grab('nameParts_')}
    ${grab('samePerson_')} ${grab('displayNameOf_')} ${grab('stampEmployeeIds_')}
    ${grab('thresholdProblems_')}
    var NICKNAMES = Object.create(null);
    return { incentiveImport_: incentiveImport_, incentiveHistory_: incentiveHistory_,
             incentiveRelink_: incentiveRelink_, historyPeriods_: historyPeriods_,
             stampEmployeeIds_: stampEmployeeIds_, thresholdProblems_: thresholdProblems_ };`;
  /* GX Core is INJECTED, not global — the engine calls it as a bound library. resolveStore is
     genuinely its job; the local store table this replaces is exactly what must not exist here.
     getEmployees reads through a mutable hook so a test can swap the registry, including for the
     case where the read throws. */
  /* Keyed on the strings the real resolveStore accepts as aliases — the historical report labels
     AND today's display names, since live rows arrive with the latter. */
  const STORE_ALIASES = { 'Hillsboro': 'hillsboro', 'Baseline': 'hillsboro',
                          'Portland Road': 'portland-rd', 'Portland': 'portland-rd',
                          'River Rd': 'river-rd', 'River': 'river-rd',
                          'Bend': 'bend', 'Century': 'bend',
                          'Center': 'center', 'Commercial': 'commercial' };
  const GXCore = { resolveStore: l => STORE_ALIASES[l] ? { store_id: STORE_ALIASES[l] } : null,
                   getEmployees: () => REGISTRY() };
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

/* ── every live row leaves the engine carrying an employee_id ──
   Crew keys its saved inputs on employee_id; Leaderboard sends only its own nameKey. If a row
   arrives without an employee_id stamped on it, the math looks the input up under a key nothing
   ever wrote, so an attendance tick or a SPIFF entry is silently ignored and the payroll comes out
   short. Nothing throws — the payload looks complete, with blanks where the ids should be.

   This is the test the shadowing bug needed: `var live = emps.filter(...)` shadowed the `live`
   PARAMETER, so `live.budtenders` was undefined, forEach ran zero times, and not one row was
   stamped. It reached production and was caught by the probe reporting `stamped: 0` alongside
   `unmatched: []` — a pair that cannot both be true if the loop ran at all. */
sheet = makeSheet(HEADERS); M = load(sheet);
/* THE SHAPE THE LIBRARY ACTUALLY RETURNS. GXCore.getEmployees() hands back the raw `employees`
   tab: preferred_name, no display_name. That column is added by GX Core's HTTP ?action=employees
   route, not by the library — so a fixture carrying display_name would test a field the engine
   never sees, and would have passed while production matched nobody by nickname. */
const REG = [
  { employee_id: 'christopher_carney', full_name: 'Christopher Carney', preferred_name: 'Chris', status: 'active' },
  { employee_id: 'tj_peterson',     full_name: 'Thomas Peterson', preferred_name: 'TJ',   status: 'active' },
  { employee_id: 'thomas_peterson', full_name: 'Thomas Peterson', preferred_name: '',     status: 'merged' },
  { employee_id: 'robert_wydick',   full_name: 'Robert Wydick',   preferred_name: 'Nate', status: 'active' },
  { employee_id: 'nathan_wydick',   full_name: 'Nathan Wydick',   preferred_name: 'Nate', status: 'merged' },
  { employee_id: 'jane_schwenger',  full_name: 'Jane Schwenger',  preferred_name: '',     status: 'retired' },
];
const payload = {
  admin: { name: 'Michael Kettler', nameKey: 'mike_kettler' },
  managers: [{ name: 'Chris Carney', nameKey: 'chris_carney' },
             { name: 'TJ Peterson', nameKey: 'tj_peterson' }],
  budtenders: [{ name: 'Nathan Wydick', nameKey: 'nathan_wydick' },
               { name: 'Jane Schwenger', nameKey: 'jane_schwenger' },
               { name: 'Nobody Here', nameKey: 'nobody_here' }],
};
REGISTRY = () => REG;
M.stampEmployeeIds_(payload);
const stamped = payload.budtenders.concat(payload.managers).filter(r => r.employee_id).length;
ok('the loop actually runs — rows come back stamped', stamped > 0);
ok('a legal-name match resolves', payload.managers[0].employee_id === 'christopher_carney');
/* The reports print the name people are CALLED by. Robert Wydick is "Nate Wydick" on the board and
   "Nathan Wydick" in the payout PDFs; matching full_name alone reaches neither. */
ok('a NICKNAME match resolves to the live record, not the tombstone — and the nickname is\n     derived from preferred_name, because the library returns no display_name column',
   payload.budtenders[0].employee_id === 'robert_wydick');
ok('a nameKey that collides with a MERGED id does not win',
   payload.managers[1].employee_id === 'tj_peterson');
ok('a RETIRED person still resolves — they really did work that period',
   payload.budtenders[1].employee_id === 'jane_schwenger');
ok('somebody with no registry record is reported, not silently blank',
   payload.budtenders[2].employee_id === '' && payload.unmatched.indexOf('Nobody Here') >= 0);
ok('unmatched lands on the PAYLOAD, not on some other object',
   Array.isArray(payload.unmatched));

/* ── Leaderboard's store slugs are not GX Core's ──
   LB says baseline / century / portland / river; the registry says hillsboro / bend / portland-rd /
   river-rd. Only `center` and `commercial` coincide, which is why exactly those two rows had a
   coloured dot and the other four were grey.
   The SLUG MUST SURVIVE: thresholds express lowVolStores in LEADERBOARD's slugs, and the bonus math
   matches against it — rewriting it to the registry id would move two stores off the low-volume
   transaction bar and change what their staff are paid. */
const stores = { admin: null, managers: [], budtenders: [
  { name: 'Chris Carney', nameKey: 'chris_carney', storeSlug: 'century', storeName: 'Century' },
  { name: 'Dean Deloof', nameKey: 'dean_deloof', storeSlug: 'baseline', storeName: 'Baseline' },
] };
REGISTRY = () => REG;
M.stampEmployeeIds_(stores);
ok('a Leaderboard slug resolves to the registry store_id',
   stores.budtenders[0].store_id === 'bend' && stores.budtenders[1].store_id === 'hillsboro');
ok('and the Leaderboard slug is left untouched — the bonus math matches on it',
   stores.budtenders[0].storeSlug === 'century' && stores.budtenders[1].storeSlug === 'baseline');

/* A registry read that fails must not look like "nobody matched": every row unstamped AND every
   name reported is the honest outcome, and it is distinguishable from a clean run. */
REGISTRY = () => { throw new Error('GX Core unreachable'); };
const p2 = { admin: null, managers: [], budtenders: [{ name: 'Chris Carney', nameKey: 'chris_carney' }] };
M.stampEmployeeIds_(p2);
ok('a failed registry read reports the name rather than silently blanking it',
   p2.budtenders[0].employee_id === '' && p2.unmatched.length === 1);

/* ── the header row migrates by APPENDING, and only by appending ──
   sheetOf_ writes headers only when it creates the tab, so a column added to HISTORY_HEADERS later
   would never reach a sheet that already exists — and readTab_ pairs headers to columns by
   POSITION, so a short or reordered header row silently re-attributes every figure in the tab.
   approved_by / approved_at were added exactly this way, to a tab that already held 1,012 rows. */
sheet = makeSheet(HEADERS.slice(0, HEADERS.length - 2));      // an older, narrower tab
sheet.rows.push(HEADERS.slice(0, HEADERS.length - 2).map((_, i) => 'v' + i));
M = load(sheet);
M.incentiveImport_({ confirm: 'yes' }, body());
const hdr = sheet.getDataRange().getValues()[0];
ok('a missing column is appended to an existing tab', hdr.length === HEADERS.length);
ok('and appended at the END, so existing columns keep their positions',
   hdr.slice(0, HEADERS.length - 2).join(',') === HEADERS.slice(0, HEADERS.length - 2).join(','));
ok('the pre-existing row is left where it was', sheet.getDataRange().getValues()[1][0] === 'v0');

/* ── the thresholds GX Core stores are validated before they can pay anybody ──
   The scheme moved to GX Core so Crew can edit it and Leaderboard's kiosk colouring reads the same
   discount target. It is edited as JSON, so the engine is the only thing standing between a typo
   and a payroll run. Every rule below is one whose absence pays the wrong amount rather than
   erroring. */
const goodT = { hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 100, bonus: 300 }], maxPerStore: 50 } };
const clone = () => JSON.parse(JSON.stringify(goodT));

ok('a complete scheme is accepted', M.thresholdProblems_(goodT).length === 0);

/* THE ONE THAT PAYS EVERYBODY WRONG AND LOOKS FINE. Tiers are matched high-to-low with a break on
   the first hit, so an ascending list silently pays everyone the LOWEST tier they clear. Nothing
   else in the system would notice. */
const asc = clone();
asc.manager.salesTiers = [{ pct: 100, bonus: 100 }, { pct: 105, bonus: 200 }, { pct: 110, bonus: 300 }];
const ascErr = M.thresholdProblems_(asc);
ok('an ascending sales tier list is refused', ascErr.length > 0);
ok('and the refusal says WHY, not just "invalid"',
   /lowest tier they clear/.test(ascErr.join(' ')));
const ascAdmin = clone();
ascAdmin.admin.tiers = [{ pct: 100, bonus: 300 }, { pct: 110, bonus: 600 }];
ok('the admin tiers are checked the same way', M.thresholdProblems_(ascAdmin).length > 0);

ok('a missing number is named', /discountMaxPct/.test(
   M.thresholdProblems_((function () { const t = clone(); delete t.budtender.discountMaxPct; return t; })()).join(' ')));
ok('a string where a number belongs is refused', M.thresholdProblems_(
   (function () { const t = clone(); t.budtender.aovTarget = '33'; return t; })()).length > 0);
ok('hoursPerPeriod of zero is refused — it divides the $/hr column', M.thresholdProblems_(
   (function () { const t = clone(); t.hoursPerPeriod = 0; return t; })()).length > 0);
ok('lowVolStores must be a list — a bare string would match by character',
   M.thresholdProblems_((function () { const t = clone(); t.budtender.lowVolStores = 'center'; return t; })()).length > 0);
ok('an empty tier list is refused', M.thresholdProblems_(
   (function () { const t = clone(); t.manager.salesTiers = []; return t; })()).length > 0);
ok('junk is refused without throwing', M.thresholdProblems_(null).length > 0 &&
   M.thresholdProblems_('nope').length > 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentive history: all passed');
process.exit(fail ? 1 : 0);
