#!/usr/bin/env node
/* ─── The plain-text pin: applied before every write, and never by a request that only reads ──────
 *
 *   RUN:            node tests/attr_text_pin_test.js
 *   PROVE IT BITES: node scripts/prove-attr-text-pin-red.js   (mutates a COPY of Code.gs)
 *
 * WHAT IT PROTECTS. Sheets turns "00" into the number 0, and "05-19" into a date, the moment either
 * is written into a cell that is not plain text. The owner's employee number is 00. So three columns
 * of the attributes tab — employee_number, birthday, permit_number — are pinned to the `@` format.
 *
 * WHAT CHANGED (2026-10-13). That pin used to be re-applied by every request on its first touch of
 * the workbook: three whole-column format WRITES on requests that only read (0.36-0.70s each, live).
 * It is now applied where it does its job — immediately before every write to the tab, and when the
 * tab is created — and not at all by a request that only reads.
 *
 * WHAT THIS FILE HOLDS, against the whole shipped engine driven through its real router:
 *
 *   1. a request that only reads makes ZERO writes of any kind to the attributes tab;
 *   2. every route that writes the tab pins all three columns BEFORE each write (the ORDER of calls
 *      is checked, not their presence), on a normal workbook, on one whose formats were cleared by
 *      hand, and on one that has never had the tab;
 *   3. a leading-zero value written through each of those routes is still that text afterwards;
 *   4. reads are right even where a column is NOT plain text — numbers compared numerically,
 *      permits through their key, a date-coerced birthday read as its day;
 *   5. nothing but writeAttrs_ writes to the tab (the ratchet);
 *   6. read routes answer exactly as before, and approve/send are byte-identical.
 *
 * THE FAKE SHEET COERCES. tests/whole_engine_harness.js stores "00" as 0 in a cell that is not
 * plain text and as "00" in one that is, a format covering exactly the rows it was applied to.
 * Section 0 checks the fake itself, because without that every assertion below passes whether the
 * pin is there or not.
 *
 * CODE_GS=/path/to/Code.gs points the "after" side at another copy of the engine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SECRET, PRACTICE, world, closeScenario } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC_NEW = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
/* The commit this change was built on: v1.416. */
const BASELINE = 'e07c208';
let SRC_OLD = null;
try {
  SRC_OLD = execFileSync('git', ['show', BASELINE + ':apps-script/Code.gs'],
                         { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) { SRC_OLD = null; }

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
const skip = (label, why) => console.log('  ○ SKIP ' + label + ' — ' + why);
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  console.log('\n' + (fail + 1) + ' FAILED (of ' + (pass + fail + 1) + ' reached)');
  process.exit(1);
});

const ATTR = 'crew_attributes';
const PINNED = ['employee_number', 'birthday', 'permit_number'];

/* The roster's attributes, with leading zeros everywhere they can bite. */
const ROWS = (attr) => [
  attr('sky_owner', { employee_number: '00', birthday: '01-05' }),
  attr('bea_bud',   { employee_number: '07', birthday: '05-19', permit_number: '0012345', permit_expires: '2028-01-01', middle_initial: 'Q' }),
  attr('bo_bud',    { birthday: '05-09', permit_number: '0000777', middle_initial: 'R' }),
  attr('mona_mgr',  { employee_number: '12', birthday: '11-30' }),
  attr('old_bud',   { employee_number: '05', permit_number: '0000042' }),
];
const mk = (src, opts) => world(src, Object.assign({ coerce: true, attrRows: ROWS }, opts || {}));

/* What a piece of work did to the attributes tab, in order. */
const opsOf = (W, fn) => { const n = W.ops.length; const r = fn(); return { r, ops: W.ops.slice(n).filter((o) => o.tab === ATTR), all: W.ops.slice(n) }; };
/* Every write of a data row must find all three columns already plain text, and must have been
   preceded — since the previous write — by a format call on each of the three. */
function pinOrder(W, ops) {
  const H = W.sheets[ATTR].data[0], cols = PINNED.map((h) => H.indexOf(h) + 1);
  let since = {}, writes = 0, bad = 0, unpinned = 0;
  ops.forEach((o) => {
    if (o.op === 'format' && o.f === '@') since[o.c] = true;
    if ((o.op === 'write' && o.r >= 2) || o.op === 'append') {
      writes++;
      if (!cols.every((c) => since[c])) bad++;
      if (!PINNED.every((h) => o.pinned[h])) unpinned++;
      since = {};
    }
  });
  return { writes, bad, unpinned, formats: ops.filter((o) => o.op === 'format').length };
}
/* The RAW cell — what the sheet holds, not what a reader makes of it. */
const cell = (W, id, col) => { const d = W.sheets[ATTR].data, c = d[0].indexOf(col); const row = d.find((r) => r[0] === id); return row ? row[c] : undefined; };
const isTextCell = (W, id, col) => { const d = W.sheets[ATTR].data, c = d[0].indexOf(col), r = d.findIndex((x) => x[0] === id); return r > 0 && W.sheets[ATTR].isText(r + 1, c + 1); };

/* ── 0. The fake behaves like Sheets ────────────────────────────────────────────────────────── */
console.log('\nThe fake sheet coerces the way Sheets does (or nothing below means anything)');
{
  const W = mk(SRC_NEW, { attrsUnformatted: true });
  const sh = W.sheets[ATTR], H = sh.data[0], n = H.indexOf('employee_number') + 1, b = H.indexOf('birthday') + 1;
  sh.getRange(20, n).setValues([['00']]);
  sh.getRange(20, b).setValues([['05-19']]);
  ok('"00" written into a cell that is not plain text is stored as the number 0', sh.data[19][n - 1] === 0);
  ok('"05-19" written there is stored as a date', sh.data[19][b - 1] instanceof Date && sh.data[19][b - 1].getMonth() === 4);
  sh.getRange(2, n, 30, 1).setNumberFormat('@');
  ok('formatting afterwards does not bring the zero back', sh.data[19][n - 1] === 0);
  sh.getRange(21, n).setValues([['00']]);
  ok('"00" written into a plain-text cell stays "00"', sh.data[20][n - 1] === '00');
  sh.getRange(40, n).setValues([['00']]);
  ok('a format covers only the rows it was applied to', sh.data[39][n - 1] === 0);
  const P = mk(SRC_NEW);
  ok('the seeded workbook holds its values as text, in plain-text columns', cell(P, 'sky_owner', 'employee_number') === '00' && isTextCell(P, 'sky_owner', 'employee_number'));
  ok('the harness has made no writes of its own', P.ops.length === 0);
}

/* ── 1. A request that only reads ───────────────────────────────────────────────────────────── */
const READS = [
  ['health', { action: 'health' }],
  ['the roster at boot', { action: 'roster', token: 'T-sky', include_retired: '', parts: 'review,eom_history' }],
  ['the roster, retired included', { action: 'roster', token: 'T-sky', include_retired: '1', parts: 'review,eom_history' }],
  ['the roster, as a viewer', { action: 'roster', token: 'T-view', parts: 'review,eom_history' }],
  ['the review queue', { action: 'review', token: 'T-sky' }],
  ['the Employee of the Month log', { action: 'eom_history', token: 'T-sky' }],
  ['the incentive screen, default', { action: 'incentive', token: 'T-sky' }],
  ['the incentive screen, running period', { action: 'incentive', token: 'T-sky', pp_start: '2026-10-12' }],
  ['the incentive screen, closed period', { action: 'incentive', token: 'T-sky', pp_start: '2026-09-14' }],
  ['the incentive screen, practice period', { action: 'incentive', token: 'T-sky', pp_start: PRACTICE }],
  ['the store email preview', { action: 'store_email', secret: SECRET, pp_start: '2026-09-14', show: 'html' }],
  ['the closed-period history route', { action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14' }],
  ['a number-assignment PREVIEW', { action: 'assign_numbers', secret: SECRET }],
  ['a set-number request that is refused', { action: 'set_number', secret: SECRET, employee_id: 'bo_bud', number: '00' }],
  ['a merge PREVIEW', { action: 'roster_merge', token: 'T-sky', keep: 'bea_bud', merge: 'old_bud' }],
  ['a roster save that is refused', { action: 'roster_save', token: 'T-view', employee_id: 'bea_bud', shirt_size: 'L' }],
  ['the request-timing read-back', { action: 'request_stats', secret: SECRET }],
  ['an unknown route', { action: 'no_such_route' }],
];
console.log('\nA request that only reads writes NOTHING to the attributes tab');
{
  const W = mk(SRC_NEW);
  let total = 0, formats = 0, answered = 0;
  READS.forEach(([label, params]) => {
    const x = opsOf(W, () => W.get(params));
    total += x.ops.length; formats += x.all.filter((o) => o.op === 'format' && o.tab === ATTR).length;
    if (x.r && !x.r.__not_json) answered++;
    if (x.ops.length) ok(label + ' — wrote to the attributes tab: ' + JSON.stringify(x.ops.slice(0, 2)), false);
  });
  ok(READS.length + ' read-only requests, every one answered', answered === READS.length);
  ok('…and between them: 0 format calls on the attributes tab', formats === 0);
  ok('…and 0 writes of any kind to it (rows, header, appends, deletes): ' + total, total === 0);
  ok('they did read it — the roster shows the leading zero', W.get({ action: 'roster', token: 'T-sky' }).rows.find((r) => r.employee_id === 'sky_owner').employee_number === '00');
  ok('the refused set-number really was refused, on the number', /already held by Sky Owner/.test(W.get(READS[13][1]).error));
  if (!SRC_OLD) skip('the same requests on the engine as it was (3 format writes each)', 'git cannot show ' + BASELINE + ' here');
  else {
    const O = mk(SRC_OLD);
    let per = [];
    READS.forEach(([, params]) => { per.push(opsOf(O, () => O.get(params)).ops.filter((o) => o.op === 'format').length); });
    console.log('    format writes per request BEFORE: ' + per.join(' ') + '   AFTER: all 0');
    ok('the engine as it was made 3 format writes on every one of the 14 that touched the workbook',
       per.filter((n) => n === 3).length === 14 && per.every((n) => n === 0 || n === 3));
  }
}

/* ── 2 & 3. Every route that writes ─────────────────────────────────────────────────────────── */
const METRC = (W) => {
  Object.assign(W.props, { METRC_VENDOR_KEY: 'vk', METRC_USER_KEY: 'uk', METRC_LICENSES: '050-1' });
  W.metrc = () => [{ FullName: 'Beatrice Budd', License: { Number: '0012345', StartDate: '2024-05-20', EndDate: '2029-05-19', LicenseType: 'Worker' } },
                   { FullName: 'Bo Budd', License: { Number: '0000777', StartDate: '2024-01-01', EndDate: '2030-02-03', LicenseType: 'Worker' } }];
};
/* Each: the request, what must be true of the reply, and the leading-zero cells that must still be text. */
const WRITES = [
  { name: 'set_number (the reserved 00)', setup: (W) => { const r = W.sheets[ATTR] && W.sheets[ATTR].data.find((x) => x[0] === 'sky_owner'); if (r) r[W.sheets[ATTR].data[0].indexOf('employee_number')] = ''; W.employees.find((e) => e.employee_id === 'sky_owner').employee_number = ''; },
    run: (W) => W.get({ action: 'set_number', secret: SECRET, employee_id: 'sky_owner', number: '00' }),
    good: (r) => r.ok === true && r.now === '00', keep: [['sky_owner', 'employee_number', '00']], minWrites: 1 },
  { name: 'roster_save (one field of the owner\'s row)',
    run: (W) => W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'sky_owner', shirt_size: 'L' }),
    good: (r) => r.ok === true && r.saved.employee_number === '00', keep: [['sky_owner', 'employee_number', '00'], ['sky_owner', 'birthday', '01-05']], minWrites: 1, needsRow: 'sky_owner' },
  { name: 'roster_save (a birthday and a permit typed in)',
    run: (W) => W.get({ action: 'roster_save', token: 'T-mike', employee_id: 'mona_mgr', birthday: '03-04', permit_number: '0000123' }),
    good: (r) => r.ok === true, keep: [['mona_mgr', 'birthday', '03-04'], ['mona_mgr', 'permit_number', '0000123']], minWrites: 1 },
  { name: 'assign_numbers (everyone without one)',
    run: (W) => W.get({ action: 'assign_numbers', secret: SECRET, confirm: 'yes' }),
    good: (r) => r.ok === true && r.mode === 'assigned' && r.written >= 3, keep: [['bo_bud', 'birthday', '05-09'], ['bo_bud', 'permit_number', '0000777']], minWrites: 3, needsRow: 'bo_bud' },
  { name: 'roster_merge (two records into one)',
    run: (W) => W.get({ action: 'roster_merge', token: 'T-sky', keep: 'bea_bud', merge: 'old_bud', confirm: 'yes' }),
    good: (r) => r.ok === true && r.mode === 'merged', keep: [['bea_bud', 'employee_number', '07'], ['bea_bud', 'permit_number', '0012345'], ['bea_bud', 'birthday', '05-19']], minWrites: 1, needsRow: 'bea_bud' },
  { name: 'hr_import (a sheet of people, one of them new)',
    run: (W) => W.post({ action: 'hr_import', secret: SECRET, confirm: 'yes', mode: 'overwrite' },
                       { employees: [{ full_name: 'Sky Owner', employee_number: '00', birthday: '1/5' },
                                     { full_name: 'Nora Newhire', employee_number: '007', birthday: '3/4', permit_number: '0001', home_store: 'bend' }] }),
    good: (r) => r.ok === true && r.mode === 'commit' && r.attributes_written === 2,
    keep: [['sky_owner', 'employee_number', '00'], ['sky_owner', 'birthday', '01-05'], ['nora_newhire', 'employee_number', '007'], ['nora_newhire', 'permit_number', '0001'], ['nora_newhire', 'birthday', '03-04']], minWrites: 2 },
  { name: 'metrc_permit_sync (an expiry date, on a row with a leading-zero permit)', setup: METRC,
    run: (W) => W.get({ action: 'metrc_permit_sync', secret: SECRET, confirm: 'yes' }),
    good: (r) => r.ok === true && r.written >= 1, keep: [['bea_bud', 'permit_number', '0012345'], ['bea_bud', 'employee_number', '07'], ['bea_bud', 'birthday', '05-19']], minWrites: 1, needsRow: 'bea_bud' },
];
const BOOKS = [
  ['a normal workbook', {}],
  ['a workbook whose column formats were cleared by hand', { attrsUnformatted: true }],
  ['a workbook that has never had the tab', { noAttrsTab: true }],
];
console.log('\nEvery route that writes pins the three columns BEFORE each write — and the zero survives');
BOOKS.forEach(([book, opts]) => {
  WRITES.forEach((w) => {
    if (opts.noAttrsTab && w.needsRow) return;            // a route that edits an existing row needs the row
    const W = mk(SRC_NEW, opts);
    if (w.setup) w.setup(W);
    const x = opsOf(W, () => w.run(W));
    const o = pinOrder(W, x.ops);
    const kept = w.keep.filter(([id]) => !(opts.noAttrsTab && id !== 'sky_owner' && id !== 'nora_newhire' && !/roster_save \(a birthday/.test(w.name)))
                       .map(([id, col, want]) => [id + '.' + col, cell(W, id, col), want]);
    const wrong = kept.filter(([, got, want]) => got !== want);
    ok(book + ' — ' + w.name + ': ' + o.writes + ' write(s), each after its own pin' +
       (w.good(x.r) ? '' : ' — THE ROUTE DID NOT DO ITS WORK: ' + JSON.stringify(x.r).slice(0, 140)) +
       (wrong.length ? ' — COERCED: ' + wrong.map(([k, got, want]) => k + ' is ' + JSON.stringify(got) + ', not ' + JSON.stringify(want)).join('; ') : ''),
       w.good(x.r) && o.writes >= w.minWrites && o.bad === 0 && o.unpinned === 0 && wrong.length === 0 && kept.length > 0);
  });
});
{
  /* A WRITE THAT IS THE FIRST THING EVER TO TOUCH THE WORKBOOK. No route does this today — each one
     reads the tab before it writes, and that read is what creates the tab — so this was never live.
     But the old code created the tab and returned it unformatted, and a writer that had not read
     first would have stored 00 as 0. Pinning the tab as it is created closes that. */
  const firstWrite = (src) => { const W = mk(src, { noAttrsTab: true }); W.g('writeAttrs_')({ employee_id: 'sky_owner', employee_number: '00', birthday: '01-05' }); return W; };
  const NW = firstWrite(SRC_NEW);
  ok('a write that is the first thing ever to touch the workbook still stores 00 as text',
     cell(NW, 'sky_owner', 'employee_number') === '00' && cell(NW, 'sky_owner', 'birthday') === '01-05');
  if (!SRC_OLD) skip('the engine as it was stored that 00 as the number 0', 'git cannot show ' + BASELINE + ' here');
  else ok('BEFORE: the same write stored it as the number 0 — latent, since every route reads first',
          cell(firstWrite(SRC_OLD), 'sky_owner', 'employee_number') === 0);
  const N = mk(SRC_NEW, { noAttrsTab: true });
  const first = opsOf(N, () => N.get({ action: 'roster', token: 'T-sky' }));
  const kinds = first.ops.map((o) => o.op + (o.op === 'write' ? '@' + o.r : '')).join(' ');
  ok('a new tab is created, given its header, and pinned — in that order, before any row: ' + kinds, kinds === 'create write@1 format format format');
  ok('…all three columns, from row 2 to the bottom of the sheet',
     PINNED.every((h) => N.sheets[ATTR].isText(2, N.sheets[ATTR].data[0].indexOf(h) + 1) && N.sheets[ATTR].isText(999, N.sheets[ATTR].data[0].indexOf(h) + 1)));
  const M = mk(SRC_NEW);
  /* A column somebody moved: the pin goes by header name, wherever the header now is. */
  const d = M.sheets[ATTR].data, from = d[0].indexOf('employee_number'), to = d[0].length;
  d.forEach((row) => { row[to] = row[from] == null ? '' : row[from]; row[from] = ''; });
  d[0][to] = 'employee_number'; d[0][from] = 'was_here';
  M.sheets[ATTR].rules.length = 0;
  M.get({ action: 'roster_save', token: 'T-sky', employee_id: 'sky_owner', shirt_size: 'M' });
  ok('a column that was moved by hand is pinned where it now is, and the 00 written to it stays text',
     cell(M, 'sky_owner', 'employee_number') === '00' && M.sheets[ATTR].isText(2, to + 1));
}

console.log('\nThe nightly run re-pins the tab for hands in the sheet');
{
  const W = mk(SRC_NEW, { attrsUnformatted: true });
  let out = null, threw = null;
  const x = opsOf(W, () => { try { out = W.g('nightlyDutchieScan')(); } catch (e) { threw = e; } });
  ok('it runs to the end and returns the scan\'s own answer', !threw && out && typeof out === 'object');
  ok('the three columns are plain text again afterwards', PINNED.every((h) => W.sheets[ATTR].isText(2, W.sheets[ATTR].data[0].indexOf(h) + 1)));
  ok('…and it wrote no row to the tab doing it', x.ops.every((o) => o.op === 'format') && x.ops.length >= 3);
  const B = mk(SRC_NEW, { attrsUnformatted: true });
  B.sb.SpreadsheetApp.openById = () => { throw new Error('Drive hiccup'); };
  let t2 = null; try { B.g('nightlyDutchieScan')(); } catch (e) { t2 = e; }
  ok('a workbook that cannot be opened does not make the pin create one', B.created === 0);
}

/* ── 4. Reads that do not depend on the format ──────────────────────────────────────────────── */
console.log('\nReads are right even where a column is NOT plain text');
{
  /* A workbook holding what Sheets would have made of these values with no pin at all. */
  const COERCED = (attr) => [
    attr('sky_owner', { employee_number: 0, birthday: new Date(2026, 0, 5) }),
    attr('bea_bud',   { employee_number: 7, birthday: new Date(2026, 4, 19), permit_number: 12345, permit_expires: '2028-01-01' }),
    attr('mona_mgr',  { employee_number: 12, birthday: '11-30' }),
    attr('bo_bud',    { birthday: new Date(2026, 4, 9), permit_number: 777 }),
  ];
  const W = world(SRC_NEW, { coerce: true, attrsUnformatted: true, attrRows: COERCED });
  const roster = W.get({ action: 'roster', token: 'T-sky' }).rows, row = (id) => roster.find((r) => r.employee_id === id);
  ok('a birthday Sheets turned into a date is read as its day', row('bea_bud').birthday === '05-19' && row('sky_owner').birthday === '01-05' && row('bo_bud').birthday === '05-09');
  ok('…and one still held as text reads as before', row('mona_mgr').birthday === '11-30');
  ok('…so nobody is flagged as missing a birthday they have', row('bea_bud').flags.indexOf('birthday') < 0);
  ok('an employee number held as the NUMBER 0 still reads as held (not as missing)', row('sky_owner').employee_number === '0' && row('sky_owner').flags.indexOf('employee_number') < 0);
  const clash = W.get({ action: 'set_number', secret: SECRET, employee_id: 'bo_bud', number: '00' });
  ok('00 is refused to a second person — compared as a number, against the stored 0', clash.ok === false && /already held by Sky Owner/.test(clash.error));
  const clash2 = W.get({ action: 'set_number', secret: SECRET, employee_id: 'bo_bud', number: '012' });
  ok('012 is refused too — it is 12, and 12 is taken', clash2.ok === false && /already held by Mona Manager/.test(clash2.error));
  const plan = W.get({ action: 'assign_numbers', secret: SECRET });
  ok('the next number is counted from the highest one in use, as numbers', plan.highest_in_use === 12 && plan.starting_at === 13);
  METRC(W);
  const sync = W.get({ action: 'metrc_permit_sync', secret: SECRET });
  const bea = (sync.changes || []).find((c) => /Budd/.test(c.name) && c.to === '2029-05-19');
  ok('a permit number that lost its leading zeros still matches Metrc\'s, by permit', sync.ok === true && !!bea && bea.matched_by === 'permit' &&
     (sync.changes || []).every((c) => c.matched_by === 'permit'));
  if (SRC_OLD) {
    const O = world(SRC_OLD, { coerce: true, attrsUnformatted: true, attrRows: COERCED });
    const ob = O.get({ action: 'roster', token: 'T-sky' }).rows.find((r) => r.employee_id === 'bea_bud');
    ok('BEFORE: that same date-coerced birthday read as blank (' + JSON.stringify(ob.birthday) + ') — the one read that leaned on the format', ob.birthday === '');
  } else skip('the engine as it was read a date-coerced birthday as blank', 'git cannot show ' + BASELINE + ' here');
  const nb = W.g('normBirthday_');
  ok('normBirthday_ still accepts what it accepted, and refuses what it refused',
     nb('05-19') === '05-19' && nb('1990-05-19') === '05-19' && nb('5/9') === '05-09' && nb('') === '' && nb('13-40') === '' && nb('soon') === '' && nb('May 19') === '' && nb('2026') === '');
  ok('…and reads the date text by its own month and day, in any zone it was rendered in',
     nb('Tue May 19 2026 00:00:00 GMT-0700 (Pacific Daylight Time)') === '05-19' && nb('Mon Jan 05 2026 00:00:00 GMT+0000 (Coordinated Universal Time)') === '01-05' &&
     nb('Thu Dec 31 2026 00:00:00 GMT-0800 (Pacific Standard Time)') === '12-31');
}

/* ── 5. The ratchet: one writer ─────────────────────────────────────────────────────────────── */
console.log('\nNothing but writeAttrs_ writes to the attributes tab');
{
  function fnText(src, name) {
    const i = src.indexOf('\nfunction ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\nfunction ', i + 10);
    return src.slice(i, j < 0 ? src.length : j);
  }
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1 ');
  const CODE = decomment(SRC_NEW);
  const names = (CODE.match(/\nfunction ([A-Za-z0-9_]+)\(/g) || []).map((m) => m.replace(/\nfunction |\(/g, ''));
  const body = (n) => decomment(fnText(SRC_NEW, n));
  /* Who can hold the tab at all: only a function that calls crewSheet_() and keeps the result (the
     rest ask it for the workbook, .getParent()), or one that calls crewSheetPrepare_ itself. */
  const holders = names.filter((n) => /crewSheetPrepare_\(/.test(body(n).replace(/^\nfunction [^\n]*/, '')) ||
                                      /crewSheet_\(\)(?!\s*\.getParent\(\))/.test(body(n).replace(/^\nfunction [^\n]*/, '')));
  ok('the functions that can reach the tab itself: ' + holders.sort().join(', '),
     holders.sort().join(',') === 'crewSheet_,getIncentive_,nightlyDutchieScan,perfProbe_,readAttrs_,writeAttrs_');
  const WRITE_CALL = /\.(setValues|setValue|appendRow|deleteRow|deleteRows|clearContent|clear|insertRowAfter|insertRowBefore|setNumberFormat)\(/;
  ok('of those, only writeAttrs_ contains a call that writes a sheet',
     holders.filter((n) => WRITE_CALL.test(body(n))).join() === 'writeAttrs_');
  ok('the tab\'s name is used in one place: where it is opened or created',
     names.filter((n) => /\bATTR_TAB\b/.test(body(n))).join() === 'crewSheetPrepare_');
  const callers = names.filter((n) => /\bwriteAttrs_\b/.test(body(n).replace(/^\nfunction [^\n]*/, '')));
  ok('writeAttrs_ has the six callers it had: ' + callers.sort().join(', '),
     callers.sort().join(',') === 'assignNumbers_,hrImport_,mergeEmployees_,metrcPermitSyncRun_,saveRosterAttrs_,setNumber_');
  const w = body('writeAttrs_');
  ok('writeAttrs_ asks for the tab FOR WRITE, and before its first write',
     /crewSheetPrepare_\(true\)/.test(w) && w.indexOf('crewSheetPrepare_(true)') < w.search(WRITE_CALL) && (w.match(/crewSheetPrepare_\(/g) || []).length === 1);
  ok('…fresh on every call, never from the per-request memo', !/crewSheet_\(\)/.test(w));
  const p = body('crewSheetPrepare_');
  ok('the pin is asked for with `=== true`, a function argument no request can supply',
     /^\nfunction crewSheetPrepare_\(forWrite\) \{/.test(fnText(SRC_NEW, 'crewSheetPrepare_')) && /if \(forWrite === true\) pinText\(have\);/.test(p));
  ok('crewSheet_ — what every reader goes through — passes nothing', /_crewSheetMemo_ = crewSheetPrepare_\(\);/.test(body('crewSheet_')));
  ok('the pin is by header name, on three columns, from row 2 to the bottom',
     /\['employee_number', 'birthday', 'permit_number'\]\.forEach/.test(p) && /headers\.indexOf\(h\)/.test(p) &&
     /sh\.getRange\(2, c \+ 1, Math\.max\(sh\.getMaxRows\(\) - 1, 1\), 1\)\.setNumberFormat\('@'\)/.test(p));
  const propUses = p.match(/(?:get|set|delete)Property\(([^,)]*)/g) || [];
  ok('no flag, property or cache says "already pinned" — the only property touched is the workbook id',
     !/CacheService/.test(p) && propUses.length === 2 && propUses.every((u) => /\(CREW_SHEET_ID_PROP$/.test(u)) && !/_crewSheetMemo_/.test(p));
  ok('the workbook guard is untouched: a stored id that will not open still throws, and only a missing id creates',
     /NOT auto-creating a replacement/.test(fnText(SRC_NEW, 'crewSheetPrepare_')) && (p.match(/SpreadsheetApp\.create\(/g) || []).length === 1 && /if \(!ss\) \{\s*ss = SpreadsheetApp\.create/.test(p));
}

/* ── 6. Nothing else moved ──────────────────────────────────────────────────────────────────── */
console.log('\nBefore this change and after it (the engine at ' + BASELINE + ' against the shipped one)');
if (!SRC_OLD) skip('read routes, write routes and a whole close, before against after', 'git cannot show ' + BASELINE + ' here (a shallow clone)');
else {
  const strip = (d) => { if (d && typeof d === 'object') delete d.timings; return JSON.stringify(d); };
  [['a normal workbook', {}], ['with an approved practice period', { practiceApproved: true }]].forEach(([book, opts]) => {
    const O = mk(SRC_OLD, opts), N = mk(SRC_NEW, opts);
    const bad = [];
    READS.concat([['the approved practice period', { action: 'incentive', token: 'T-sky', pp_start: PRACTICE }]]).forEach(([label, params]) => {
      for (let i = 0; i < 2; i++) { const a = strip(O.get(params)), b = strip(N.get(params)); if (a !== b || a.length < 10) bad.push(label); }
    });
    ok(book + ': ' + (READS.length + 1) + ' read requests, twice each, answer identically' + (bad.length ? ' — DIFFERENT: ' + bad.slice(0, 3).join('; ') : ''), bad.length === 0);
  });
  WRITES.forEach((w) => {
    const O = mk(SRC_OLD), N = mk(SRC_NEW);
    if (w.setup) { w.setup(O); w.setup(N); }
    const a = strip(w.run(O)), b = strip(w.run(N));
    ok(w.name + ': the same reply, and the same workbook afterwards', a === b && O.book() === N.book() && JSON.stringify(O.employees) === JSON.stringify(N.employees));
  });
  const O = mk(SRC_OLD), N = mk(SRC_NEW);
  [O, N].forEach((W) => { W.get({ action: 'incentive', token: 'T-sky' }); W.get({ action: 'roster', token: 'T-sky' }); });
  const o = closeScenario(O), n = closeScenario(N);
  ok('a whole send, approve, retry and reopen really ran', n.done.ok === true && n.done.written === 6 && n.reopened.ok === true);
  ok('…every reply, sheet and email byte-identical', o.text === n.text && o.book === n.book && o.mails === n.mails && JSON.parse(n.mails).length >= 2);
  ok('…the same fetches, and the same locks, writes and flushes in the same order', o.fetches === n.fetches && JSON.stringify(o.events) === JSON.stringify(n.events) && n.events.length > 10);
  ok('…and the pay requests read every sheet, the registry and every setting exactly as often', o.writeReads === n.writeReads);
  const attrOps = (W) => W.ops.filter((x) => x.tab === ATTR).length;
  ok('the close wrote nothing to the attributes tab — where before it re-pinned it ' + attrOps(O) + ' times', attrOps(N) === 0 && attrOps(O) > 0);
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\nattr text pin: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
