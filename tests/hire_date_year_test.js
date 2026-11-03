/*
 * A hire date typed into the record saved year 0022 (2026-11-03, Mike, on Poem's record).
 *
 * A browser date box fires `change` on every keystroke that forms a valid date, and typing a year
 * digit by digit passes through 0002 → 0020 → 0202 → 2024. The card committed the FIRST of those,
 * then disabled the box while saving, so the rest of the typing went nowhere. The engine accepted
 * it, because normDate_ takes any four digits.
 *
 * Two guards, both pinned here:
 *   1. the browser waits for a real year (plausibleDate) and reverts on blur if one never arrives;
 *   2. roster_identity refuses a hire date before 1900, so an old open tab cannot store one.
 * Runs the real engine through tests/whole_engine_harness.js.
 */
const fs = require('fs');
const path = require('path');
const { world } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'crew.js'), 'utf8');

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  process.exit(1);
});

console.log('\nThe engine refuses a year a date box passes through mid-typing');
{
  const W = world(SRC);
  const hireOf = () => (W.employees.find((e) => e.employee_id === 'bo_bud') || {}).hire_date;
  const before = hireOf();
  ['0002-11-26', '0022-11-26', '0202-11-26', '1899-12-31'].forEach((d) => {
    const r = W.get({ action: 'roster_identity', token: 'T-mike', employee_id: 'bo_bud', hire_date: d });
    ok('refused ' + d + ' — "' + (r && r.error) + '"', r && r.ok === false && /four-digit year/.test(String(r.error)));
  });
  ok('…and nothing was written', hireOf() === before);

  const good = W.get({ action: 'roster_identity', token: 'T-mike', employee_id: 'bo_bud', hire_date: '2024-11-26' });
  ok('a real date still saves', good && good.ok === true && hireOf() === '2024-11-26');
  const clear = W.get({ action: 'roster_identity', token: 'T-mike', employee_id: 'bo_bud', hire_date: '' });
  ok('clearing it still works', clear && clear.ok === true);
}

console.log('\nThe browser waits for a real year before it saves');
{
  const m = JS.match(/function plausibleDate\(v\) \{[\s\S]*?\n  \}/);
  ok('crew.js defines plausibleDate', !!m);
  const plausibleDate = m ? new Function(m[0] + '; return plausibleDate;')() : () => true;
  ['0002-11-26', '0020-11-26', '0202-11-26', '1899-01-01'].forEach((d) =>
    ok('not yet: ' + d, plausibleDate(d) === false));
  ['2024-11-26', '1900-01-01', ''].forEach((d) =>
    ok('ready: ' + (d || '(empty — a deliberate clear)'), plausibleDate(d) === true));
  ok('commit() checks it before saving a date',
     /input\.type === 'date' && !plausibleDate\(v\)\) return;/.test(JS));
  ok('a date box reverts on blur when no real year arrived',
     /addEventListener\('blur'[\s\S]{0,120}plausibleDate\(input\.value\)[\s\S]{0,60}input\.value = last/.test(JS));
}

console.log('\nhire date year: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
