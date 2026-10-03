#!/usr/bin/env node
/* ─── THE SAVED COPY NEVER CARRIES MONEY, AND NEVER CLAIMS TO BE LIVE ──────────────────────────
 *
 *   RUN:  node tests/roster_saved_copy_test.js
 *
 * Opening Crew cost 7.5s cold and 3.3s warm (measured 2026-10-02 on the live engine), and 26s in a
 * degraded /exec window. The roster is now painted from the last visit on the first frame. That is
 * a speed change wrapped around four promises about payroll data, and this file is those promises:
 *
 *   1. FIVE COLUMNS ARE NEVER WRITTEN TO DISK — wage, birthday, permit_number, employee_number,
 *      swipeclock_code. A Cloudflare cache was rejected for this app on exactly this ground; a
 *      laptop's disk does not get a different answer.
 *   2. `flags` SURVIVES THE STRIP. The engine computes the gap dots. Recomputing them from the
 *      stripped values would paint "missing wage" on every person in the company — the 2026-10-03
 *      incident manufactured deliberately. The dots stay the engine's answer.
 *   3. A STRIPPED FIELD IS MARKED PENDING, so the detail pane can say "loading" where it would
 *      otherwise say "Not set". Blank and unknown are different claims about a person's pay.
 *   4. WHO IS ASKING IS NEVER SAVED — can_edit, user, role. A stale copy of those is how a cache
 *      makes an admin read-only, or shows edit controls to somebody whose access was revoked.
 *
 * ...plus two refusals: a half-failed response is not saved, and signing out erases the copy.
 *
 * Executes the SHIPPED helpers out of crew.js.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const js = fs.readFileSync(__dirname + '/../crew.js', 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

function grab(name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in crew.js');
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
const bare = js.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
               .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
function constOf(name) {
  const m = new RegExp('var ' + name + '\\s*=\\s*[^;]+;').exec(bare);
  if (!m) throw new Error('missing const ' + name);
  return m[0];
}

function ctxWith(store) {
  const mem = new Map(Object.entries(store || {}));
  const ctx = {
    console, JSON, Object, Array, String, Number, Math, Date, Error,
    localStorage: {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: k => mem.delete(k),
    },
    _mem: mem,
  };
  vm.createContext(ctx);
  vm.runInContext([
    constOf('ROSTER_SAVE_KEY'), constOf('ROSTER_SAVE_MAX_AGE_MS'), constOf('ROSTER_UNSAVED_FIELDS'),
    grab('rosterStrip_'), grab('rosterSaveCopy_'), grab('rosterReadCopy_'), grab('rosterForgetCopy_'),
  ].join('\n'), ctx);
  return ctx;
}

const PERSON = {
  employee_id: 'ana_lopez', name: 'Ana Lopez', store: 'river-rd', role: 'Budtender',
  hire_date: '2025-04-01', retired: false, flags: ['wage'], permit_days_left: 40,
  permit_status: 'active', avatar_seed: '014', time_with_company: '1y 6m',
  wage: '21.50', birthday: '03-14', permit_number: 'OLCC-99281',
  employee_number: '014', swipeclock_code: 'SW-7781',
};
const GOOD = {
  ok: true, rows: [PERSON], shirt_sizes: ['M'], role_titles: ['Budtender'],
  identity_source: { source: 'gxcore' }, retired_total: 31,
  review: { ok: true }, eom_history: { ok: true },
  can_edit: true, user: 'sky', role: 'admin', include_retired: '',
};

console.log('\n1. the five money/PII columns never reach the disk');
{
  const ctx = ctxWith({});
  ctx.rosterSaveCopy_(JSON.parse(JSON.stringify(GOOD)));
  const raw = ctx._mem.get(ctx.ROSTER_SAVE_KEY);
  ok('something was saved', !!raw);
  for (const f of ['wage', 'birthday', 'permit_number', 'employee_number', 'swipeclock_code']) {
    ok(`"${f}" is absent from the stored row`, !(f in JSON.parse(raw).rows[0]));
  }
  ok('...and no stored VALUE leaks either', !/21\.50|OLCC-99281|SW-7781|03-14/.test(raw));
}

console.log('\n2. what the list draws IS kept, including the engine\'s gap flags');
{
  const ctx = ctxWith({});
  ctx.rosterSaveCopy_(JSON.parse(JSON.stringify(GOOD)));
  const row = JSON.parse(ctx._mem.get(ctx.ROSTER_SAVE_KEY)).rows[0];
  for (const f of ['name', 'store', 'role', 'hire_date', 'retired', 'avatar_seed', 'time_with_company']) {
    ok(`"${f}" survives — the roster paints complete`, f in row);
  }
  /* The one that matters: recomputing gaps from stripped values would dot EVERY person. */
  ok('`flags` survives, so the gap dots stay the ENGINE\'s answer',
    JSON.stringify(row.flags) === JSON.stringify(['wage']));
  ok('permit_days_left survives, so a red compliance dot still reads correctly',
    row.permit_days_left === 40);
}

console.log('\n3. a stripped field is PENDING, not empty');
{
  const ctx = ctxWith({});
  const rows = ctx.rosterStrip_([PERSON]);
  ok('the row is marked with what it is missing', Array.isArray(rows[0]._pending));
  ok('...naming exactly the five', rows[0]._pending.join(',') ===
    'wage,birthday,permit_number,employee_number,swipeclock_code');
  /* The shipped renderer gates on this, and the gate is asserted against the source so a rename
     of `_pending` cannot quietly leave "Not set" showing against somebody's pay. */
  ok('the field renderer checks _pending before calling a note function',
    /_pending\s*\|\|\s*\[\]\)\.indexOf\(o\.field\)/.test(js));
}

console.log('\n4. who is ASKING is never saved');
{
  const ctx = ctxWith({});
  ctx.rosterSaveCopy_(JSON.parse(JSON.stringify(GOOD)));
  const o = JSON.parse(ctx._mem.get(ctx.ROSTER_SAVE_KEY));
  ok('can_edit is not stored', !('can_edit' in o));
  ok('user is not stored', !('user' in o));
  ok('role is not stored', !('role' in o));
  /* …and the boot path must not restore them either. */
  ok('boot does not take canEdit from the saved copy', !/state\.canEdit\s*=\s*saved\./.test(js));
  ok('boot does not take role from the saved copy', !/state\.role\s*=\s*saved\./.test(js));
}

console.log('\n5. refusals — a copy is an accelerator, never a reason to show something doubtful');
{
  const half = JSON.parse(JSON.stringify(GOOD)); half.review = { ok: false, error: 'boom' };
  const c1 = ctxWith({}); c1.rosterSaveCopy_(half);
  ok('a response with a FAILED part is not saved', !c1._mem.has(c1.ROSTER_SAVE_KEY));

  const retired = JSON.parse(JSON.stringify(GOOD)); retired.include_retired = '1';
  const c2 = ctxWith({}); c2.rosterSaveCopy_(retired);
  ok('the retired view is not saved — it is a deliberate click, not the open',
    !c2._mem.has(c2.ROSTER_SAVE_KEY));

  const c3 = ctxWith({}); c3.rosterSaveCopy_({ ok: true, rows: [] });
  ok('an empty roster is not saved', !c3._mem.has(c3.ROSTER_SAVE_KEY));

  const c4 = ctxWith({}); c4.rosterSaveCopy_({ ok: false, error: 'Auth required' });
  ok('a failed response is not saved', !c4._mem.has(c4.ROSTER_SAVE_KEY));
}

console.log('\n6. reading back refuses anything doubtful');
{
  const c = ctxWith({});
  ok('nothing stored → null', c.rosterReadCopy_() === null);
  c._mem.set(c.ROSTER_SAVE_KEY, 'not json{');
  ok('corrupt → null, never a throw', c.rosterReadCopy_() === null);
  c._mem.set(c.ROSTER_SAVE_KEY, JSON.stringify({ saved_at: Date.now() - 100 * 3600 * 1000, rows: [PERSON] }));
  ok('older than the paint window → null', c.rosterReadCopy_() === null);
  c._mem.set(c.ROSTER_SAVE_KEY, JSON.stringify({ saved_at: Date.now(), rows: [] }));
  ok('empty rows → null', c.rosterReadCopy_() === null);

  const c2 = ctxWith({});
  c2.rosterSaveCopy_(JSON.parse(JSON.stringify(GOOD)));
  const back = c2.rosterReadCopy_();
  ok('a fresh whole copy reads back', !!back && back.rows.length === 1);
  ok('...still without a wage', !('wage' in back.rows[0]));
}

console.log('\n7. signing out erases it');
{
  const c = ctxWith({});
  c.rosterSaveCopy_(JSON.parse(JSON.stringify(GOOD)));
  ok('a copy exists', c._mem.has(c.ROSTER_SAVE_KEY));
  c.rosterForgetCopy_();
  ok('forgetting removes it', !c._mem.has(c.ROSTER_SAVE_KEY));
  /* Asserted against the source because the call site is what makes it true: every path that drops
     a session goes through setSession('', ''), including boot()'s expired-token branch. */
  ok('setSession clears it when the session is dropped',
    /removeItem\(AVATAR_KEY\);[\s\S]{0,900}?rosterForgetCopy_\(\)/.test(js));
}

console.log(fail ? `\nroster saved copy: ${fail} FAILED` : '\nroster saved copy: all passed');
process.exit(fail ? 1 : 0);
