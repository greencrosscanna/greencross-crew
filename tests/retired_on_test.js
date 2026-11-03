/*
 * roster_retire records the LAST DAY WORKED (2026-11-02).
 *
 * Retiring used to record only THAT someone left. Reports need WHEN, so roster_retire now takes
 * `retired_on` (YYYY-MM-DD, a Los Angeles day), refuses to retire without it, refuses a day in the
 * future or before the hire date, and writes it to crew_attributes read-merge-write. Un-retiring
 * clears it. A refused request writes nothing — not the status, not the date.
 *
 * Runs the real engine through tests/whole_engine_harness.js (today there is 2026-10-13, Pacific).
 */
const fs = require('fs');
const path = require('path');
const { world } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  process.exit(1);
});

const ATTR = 'crew_attributes';
const attrOf = (W, id) => {
  const d = W.sheets[ATTR].data, h = d[0];
  const row = d.find((r, i) => i > 0 && r[0] === id);
  if (!row) return null;
  const o = {}; h.forEach((k, i) => { o[k] = row[i] == null ? '' : String(row[i]); });
  return o;
};
const statusOf = (W, id) => (W.employees.find((e) => e.employee_id === id) || {}).status;
const retire = (W, id, extra) => W.get(Object.assign({ action: 'roster_retire', token: 'T-mike', employee_id: id }, extra || {}));
const rosterRow = (W, id) => (W.get({ action: 'roster', token: 'T-sky', include_retired: '1' }).rows || []).find((r) => r.employee_id === id);

console.log('\nThe column');
{
  const W = world(SRC);
  const H = W.g('ATTR_HEADERS');
  ok('retired_on is APPENDED to ATTR_HEADERS (the last column)', H[H.length - 1] === 'retired_on');
  ok('…and is not a GX Core identity field the route sends up', !/retired_on/.test(JSON.stringify(W.employees)));
}

console.log('\nA date is required, and checked, before anything is written');
{
  const W = world(SRC);
  const before = W.book(), emp = JSON.stringify(W.employees);
  const cases = [
    ['no date at all', {}, /required/],
    ['an empty date', { retired_on: '' }, /required/],
    ['not a date', { retired_on: 'last week' }, /invalid/],
    ['a day that does not exist', { retired_on: '2026-02-31' }, /invalid/],
    ['the wrong shape', { retired_on: '10/12/2026' }, /invalid/],
    ['tomorrow (in Los Angeles)', { retired_on: '2026-10-14' }, /future/],
    ['before the hire date (2022-01-01)', { retired_on: '2021-12-31' }, /before their hire date/],
  ];
  cases.forEach(([label, extra, re]) => {
    const r = retire(W, 'bo_bud', Object.assign({ retired: '1' }, extra));
    ok('refused: ' + label + ' — "' + (r && r.error) + '"', r && r.ok === false && re.test(String(r.error)));
  });
  ok('…and none of them wrote a sheet or touched the registry', W.book() === before && JSON.stringify(W.employees) === emp);
  const v = W.get({ action: 'roster_retire', token: 'T-view', employee_id: 'bo_bud', retired: '1', retired_on: '2026-10-01' });
  ok('a read-only session is refused', v && v.ok === false && statusOf(W, 'bo_bud') === 'active');
}

console.log('\nRetiring with a good date');
{
  const W = world(SRC);
  const was = attrOf(W, 'bo_bud');
  const r = retire(W, 'bo_bud', { retired: '1', retired_on: '2026-10-13' });
  ok('today is allowed, and the reply carries the date', r && r.ok === true && r.status === 'retired' && r.retired_on === '2026-10-13');
  ok('the registry says retired', statusOf(W, 'bo_bud') === 'retired');
  const now = attrOf(W, 'bo_bud');
  ok('crew_attributes holds the date', now && now.retired_on === '2026-10-13');
  ok('…read-merge-write: every other attribute is as it was',
     Object.keys(was).every((k) => k === 'retired_on' || k === 'updated_at' || k === 'updated_by' || was[k] === now[k]) && now.middle_initial === 'R');
  ok('…stamped with who did it', now.updated_by === 'mike');
  const row = rosterRow(W, 'bo_bud');
  ok('the roster shows them retired with the date', row && row.retired === true && row.retired_on === '2026-10-13');
  const hire = retire(world(SRC), 'bo_bud', { retired: '1', retired_on: '2022-01-01' });
  ok('the hire date itself is allowed', hire && hire.ok === true);
}

console.log('\nSomeone with no attributes row yet gets one');
{
  const W = world(SRC);
  ok('(cy_bud has no attributes row in the fixture)', attrOf(W, 'cy_bud') === null);
  const r = retire(W, 'cy_bud', { retired: '1', retired_on: '2026-09-30' });
  const a = attrOf(W, 'cy_bud');
  ok('a row is written with the name and the date', r.ok === true && a && a.retired_on === '2026-09-30' && a.full_name === 'Cyrus Budd' && a.name_key === 'cyrus_budd');
}

console.log('\nUn-retiring clears it');
{
  const W = world(SRC);
  retire(W, 'bo_bud', { retired: '1', retired_on: '2026-10-01' });
  const r = retire(W, 'bo_bud', { retired: '0', retired_on: '2026-10-05' });
  ok('un-retire needs no date and ignores one sent', r && r.ok === true && r.status === 'active' && r.retired_on === '');
  ok('the registry says active', statusOf(W, 'bo_bud') === 'active');
  ok('the date is cleared in crew_attributes', attrOf(W, 'bo_bud').retired_on === '');
  ok('…and the roster carries none', rosterRow(W, 'bo_bud').retired_on === '');
  ok('…and the middle initial survived both writes', attrOf(W, 'bo_bud').middle_initial === 'R');
}

console.log('\nA date can only be seen on someone retired');
{
  const W = world(SRC);
  const H = W.sheets[ATTR].data[0];
  const row = W.sheets[ATTR].data.find((r) => r[0] === 'bea_bud');
  row[H.indexOf('retired_on')] = '2026-01-01';                  // a stray date on an active person
  W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'mona_mgr', shirt_size: 'M' });  // busts the cache
  ok('an active person never shows one', rosterRow(W, 'bea_bud').retired_on === '');
  ok('…and a roster_save of an unrelated field does not erase what is stored', attrOf(W, 'bea_bud').retired_on === '2026-01-01');
  W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'bea_bud', shirt_size: 'S' });
  ok('…nor does a roster_save of that same person (the hand-written record carries it)', attrOf(W, 'bea_bud').retired_on === '2026-01-01');
}

console.log('\nretired_on: ' + (fail ? fail + ' FAILED (of ' + (pass + fail) + ')' : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
