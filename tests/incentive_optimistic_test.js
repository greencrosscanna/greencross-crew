#!/usr/bin/env node
/* ─── Ticking attendance changes the screen on the CLICK, not on the server's answer ───────────
 *
 *   RUN:  node tests/incentive_optimistic_test.js
 *
 * WHY THIS EXISTS
 * Sky, from Mike: "incentive tab, clicking on attendance has lag time and creates confussion for
 * the user." Two separate faults were behind it, and only the first is the wait.
 *
 *   1. `incSave` awaited the round trip before touching the cache or repainting. Crew's own engine
 *      answers in ~2.1-2.9s warm, so a tick moved no figure for about two and a half seconds. The
 *      box itself flipped — the browser does that — so the screen said the tick had registered
 *      while every number it is worth said it had not. One tick is $40 (the budtender's attendance
 *      bonus plus the $25 their manager earns for them) and Mike ticks ~40 of them per period.
 *
 *   2. Worse, and the part that reads as broken rather than slow: `paintIncentive` rebuilds the
 *      whole table from the cache. When the first save landed it repainted EVERY checkbox — and a
 *      box clicked since, whose own save was still in flight, had no cache entry yet, so it
 *      rendered UNTICKED. A tick Mike made two seconds earlier undid itself on screen and came
 *      back a moment later. Measured against the real code at 2.5s: click Ann, click Bee 500ms
 *      later, and at t+2532ms Bee's box goes back to empty.
 *
 * The fix applies the edit to the cache and repaints immediately, then sends the request behind it.
 * That moves ALL the risk into the refusal path, which is what this file is mostly about: an
 * optimistic screen that cannot correctly retract a refused write is worse than a slow one, because
 * it states a figure that was never saved.
 *
 * WHAT MUST HOLD:
 *   1. Cache and computed totals move synchronously with the click, before the engine answers.
 *   2. A second click is not reverted by the first click's repaint.
 *   3. A REFUSED save puts the value back exactly as it was, and says so.
 *   4. A refused save that has since been SUPERSEDED does not roll back — it would restore a value
 *      the server no longer holds, and nothing on the screen would say the two disagree.
 *   5. Rolling back an override restores all three of its keys, not just the one that was named.
 *   6. Clearing still stores null rather than 0 — 0 is itself a valid override meaning "paid
 *      nothing", and the two must not collapse.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* ── A DOM stub that records what the toast said, since a refusal MUST be audible ───────────── */
const toasts = [];
function mkEl() {
  const e = { className: '', innerHTML: '', style: { setProperty() {} },
    classList: { add() {}, remove() {} }, children: [], parentNode: null,
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parentNode = e; return c; },
    removeChild(c) { e.children = e.children.filter(x => x !== c); c.parentNode = null; return c; },
    contains: () => false, querySelector: () => null, querySelectorAll: () => [], focus() {} };
  return e;
}
const body = mkEl();
body.appendChild = c => {
  c.parentNode = body;
  if (/crew-toast/.test(c.className || '')) {
    toasts.push({ err: /is-err/.test(c.className), msg: (c.children[0] || {}).innerHTML || '' });
  }
  return c;
};
const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' }, title: 'GX Crew',
  body, activeElement: null, getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], createElement: () => mkEl(), addEventListener() {} };
const win = { GXClient: () => ({ jsonp: async () => ({}) }),
  GXStores: { color: () => '', name: s => s }, addEventListener() {}, print() {} };
const store = { getItem: () => '', setItem() {}, removeItem() {} };

let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const TAIL = '})();', cut = src.lastIndexOf(TAIL);
src = src.slice(0, cut) +
  '\n; return { incSave, paintIncentive, incInputs, calcBud, calcMgr, incPatch_,\n' +
  '   incFocusKey, incRefocus,\n' +
  '   __wire:(d,host)=>{inc.data=d; inc.loading=false; inc.error=""; ui={inc:host};},\n' +
  '   __eng:(e)=>{Engine=e;}, __tok:(f)=>{token=f;} };\n' + src.slice(cut);
src = src.replace('(function () {', 'return (function () {');
const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location',
  'navigator', src)(doc, win, store, store, { hostname: 'localhost' }, {});

const T = { hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center'], aovTarget: 33,
               aovBonus: 25, discountMaxPct: 1.0, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }], maxPerStore: 50 } };
const bud = (id, n) => ({ employee_id: id, name: n, nameKey: id, storeSlug: 'river',
  store_label: 'River Rd', txn: 250, sales: 9000, discount: 0.005, aov: 36 });
const DATA = { source: 'live', can_edit: true, thresholds: T, pp_start: '2026-08-17',
  payPeriod: { start: '2026-08-17', end: '2026-08-30' },
  budtenders: [bud('a_one', 'Ann One'), bud('b_two', 'Bee Two')],
  managers: [{ employee_id: 'm_mgr', name: 'Em Gee', nameKey: 'm_mgr', storeSlug: 'river',
               store_label: 'River Rd', sales: 100000, goal: 90000, discount: 0.008, aov: 35 }],
  admins: [], inputs: {} };

const host = mkEl();
M.__wire(JSON.parse(JSON.stringify(DATA)), host);
M.__tok(() => 'tok');
const att = id => { const i = M.incInputs()[id]; return !!(i && i.att); };
/* A rollback can delete the row outright, and reading a field off undefined THROWS — which aborts
   the run instead of failing the one assertion. Mutation-testing this file crashed here rather than
   reporting, which is how a passing suite can hide a deleted guard. */
const fld = (id, f) => { const i = M.incInputs()[id]; return i ? i[f] : undefined; };
const total = () => DATA.budtenders.reduce((s, b) => s + M.calcBud(b, T, M.incInputs()).bonus, 0) +
                    M.calcMgr(DATA.managers[0], T, M.incInputs(), DATA.budtenders).bonus;
const reset = () => { M.__wire(JSON.parse(JSON.stringify(DATA)), host); toasts.length = 0; };
const slow  = ms => ({ jsonp: () => new Promise(r => setTimeout(() => r({ ok: true }), ms)) });
const refuse = (ms, err) => ({ jsonp: () => new Promise((_, j) =>
  setTimeout(() => j(new Error(err || 'locked pending approval')), ms)) });

(async () => {

console.log('\nThe tick lands on the screen before the engine has answered');
{
  reset(); M.__eng(slow(2500));
  const t0 = total();
  const p = M.incSave('a_one', 'att', '1');       // deliberately NOT awaited — that is the point
  ok('the box reads ticked immediately', att('a_one'));
  ok('and the money has already moved — $' + t0 + ' -> $' + total(), total() === t0 + 40);
  ok('$40, not $15: the tick pays the manager too', total() - t0 === 40);
  await p;
  ok('still ticked once the save lands', att('a_one') && total() === t0 + 40);
}

console.log('\nA second click is NOT undone by the first one landing');
{
  /* The exact sequence from the report: two ticks inside one round trip. */
  reset(); M.__eng(slow(300));
  const A = M.incSave('a_one', 'att', '1');
  const B = M.incSave('b_two', 'att', '1');
  await A;
  ok('after the FIRST save lands, the second is still ticked', att('b_two'));
  await B;
  ok('and both are ticked at the end', att('a_one') && att('b_two'));
}

console.log('\nA refused save puts it back, and says so');
{
  reset(); M.__eng(refuse(50, 'this pay period is locked pending approval'));
  const t0 = total();
  await M.incSave('a_one', 'att', '1');
  ok('the tick is rolled back', !att('a_one'));
  ok('and the money with it — back to $' + total(), total() === t0);
  ok('the failure is audible, not silent', toasts.some(t => t.err));
  ok('and it names the engine\'s own reason',
     toasts.some(t => t.err && /locked pending approval/.test(t.msg)));
}

console.log('\nA SUPERSEDED refusal must not roll back over a newer save');
{
  /* THE VALUES HERE ARE CHOSEN SO THE GUARD IS THE ONLY THING THAT CAN PASS THEM. An earlier
     version of this block used tick-then-untick, where the stale save's own "before" happened to
     equal the newer save's result — so rolling back landed on the right answer by luck and the
     assertion passed with the guard deleted. Caught by mutation-testing this file, which is the
     only reason it is written this way. The rule: the stale refusal's BEFORE must differ from the
     newer save's AFTER, or the test proves nothing. */

  // (a) the approver corrects a figure while the first attempt is still in flight
  reset();
  let n = 0;
  M.__eng({ jsonp: () => ++n === 1
    ? new Promise((_, j) => setTimeout(() => j(new Error('flaked')), 400))
    : new Promise(r => setTimeout(() => r({ ok: true }), 20)) });
  const slowFail = M.incSave('a_one', 'payroll_override', '25', 'first go');   // before: no override
  await new Promise(r => setTimeout(r, 60));
  await M.incSave('a_one', 'payroll_override', '50', 'meant fifty');           // succeeds
  ok('the newer figure is what the screen shows', fld('a_one', 'payrollOverride') === 50);
  await slowFail;
  ok('the stale refusal does NOT wipe it back to nothing — still $50',
     fld('a_one', 'payrollOverride') === 50);
  ok('but it is still reported — a write that did not land is never silent',
     toasts.some(t => t.err && /flaked/.test(t.msg)));

  // (b) the impatient double-click: untick, nothing happens, untick again
  reset();
  M.incPatch_(M.incInputs(), 'a_one', 'att', '1');        // already ticked and saved earlier
  let m = 0;
  M.__eng({ jsonp: () => ++m === 1
    ? new Promise((_, j) => setTimeout(() => j(new Error('flaked')), 400))
    : new Promise(r => setTimeout(() => r({ ok: true }), 20)) });
  const staleUntick = M.incSave('a_one', 'att', '');       // before: ticked. FAILS, slowly
  await new Promise(r => setTimeout(r, 60));
  await M.incSave('a_one', 'att', '');                     // clicked again, succeeds
  ok('after the successful second click it reads unticked', !att('a_one'));
  await staleUntick;
  ok('and the first click\'s refusal does not re-tick it', !att('a_one'));
}

console.log('\nRolling back an override restores ALL of it, not just the named field');
{
  reset(); M.__eng(refuse(30, 'a reason is required'));
  const cur = M.incInputs();
  M.incPatch_(cur, 'a_one', 'payroll_override', '25', 'paid at the original rate');
  const held = JSON.parse(JSON.stringify(cur['a_one']));
  await M.incSave('a_one', 'payroll_override', '99', 'x');
  const back = M.incInputs()['a_one'] || {};
  ok('the figure is put back', back.payroll_override === held.payroll_override);
  ok('the camelCase mirror the cells read is put back too',
     back.payrollOverride === held.payrollOverride && back.payrollOverride === 25);
  ok('and the REASON is put back — a restored figure with a cleared reason reads as unexplained',
     back.overrideNote === 'paid at the original rate');
}

console.log('\nClearing stores null, never 0 — they are different claims');
{
  reset(); M.__eng(slow(10));
  await M.incSave('a_one', 'payroll_override', '0', 'genuinely paid nothing');
  ok('an explicit 0 override is 0', fld('a_one', 'payrollOverride') === 0);
  await M.incSave('a_one', 'payroll_override', '', '');
  ok('a cleared override is null, not 0', fld('a_one', 'payrollOverride') === null);
  await M.incSave('a_one', 'hours', '');
  ok('cleared hours are null too — a blank means "use the flat figure"',
     fld('a_one', 'hours') === null);
}

console.log('\nFocus survives the repaint — the cost of repainting on the click');
{
  /* Repainting on the click means the checkbox under the cursor is destroyed and rebuilt straight
     away. For a keyboard user pressing Space that drops focus to the body, so every person would
     mean tabbing back from the top of the table. */
  const fh = mkEl();
  const cb = mkEl();
  cb.className = 'crew-inc-att';
  cb.getAttribute = a => (a === 'data-k' ? 'b_two' : null);
  fh.contains = n => n === cb;

  doc.activeElement = cb;
  const want = M.incFocusKey(fh);
  ok('the focused attendance box is remembered', want && want.cls === 'crew-inc-att' && want.k === 'b_two');

  /* THE KEY, NOT THE POSITION. The tables are re-sorted and re-filtered, so restoring by index
     would move the cursor to whoever now occupies that slot — a different PERSON, on a screen
     where the next keystroke ticks a $40 bonus. */
  let asked = '';
  let focused = 0;
  fh.querySelector = sel => { asked = sel; return { focus() { focused++; } }; };
  M.incRefocus(fh, want);
  ok('and restored by that row key, never by position', /\[data-k="b_two"\]/.test(asked));
  ok('…on the same kind of control it left', /crew-inc-att/.test(asked));
  ok('focus is actually called', focused === 1);

  doc.activeElement = null;
  ok('nothing focused -> nothing remembered', M.incFocusKey(fh) === null);

  const stray = mkEl();
  stray.className = 'crew-inc-att';
  stray.getAttribute = () => 'a_one';
  doc.activeElement = stray;                 // focused, but NOT inside the incentive host
  ok('focus outside the table is left alone', M.incFocusKey(fh) === null);

  doc.activeElement = cb;
  fh.querySelector = () => null;             // that person got filtered off the screen
  let threw = false;
  try { M.incRefocus(fh, { cls: 'crew-inc-att', k: 'gone' }); } catch (e) { threw = true; }
  ok('a row that vanished from the table does not throw', !threw);
  doc.activeElement = null;

  /* THE ALLOWLIST MUST NAME CONTROLS THAT EXIST. Focus restoration fails silently by nature — a
     class that never matches produces no error, the cursor simply goes missing — so a rename or a
     hopeful entry would not be noticed by using the app. The first cut of this listed
     'crew-inc-hr', which is not a thing: $/hr is a display cell with no input. */
  const CREW = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const listed = (CREW.match(/c === '(crew-inc-[a-z-]+)'/g) || [])
                   .map(m => m.replace(/.*'(.*)'/, '$1'));
  const rendered = new Set((CREW.match(/class="(crew-inc-[a-z-]+)" data-k=/g) || [])
                   .map(m => m.replace(/class="(.*)" data-k=/, '$1')));
  ok('the allowlist is not empty', listed.length > 0);
  listed.forEach(c => ok('"' + c + '" is really rendered with a data-k', rendered.has(c)));
  rendered.forEach(c => ok('"' + c + '" is covered by the allowlist', listed.indexOf(c) >= 0));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll good.\n');
process.exit(fail ? 1 : 0);
})();
