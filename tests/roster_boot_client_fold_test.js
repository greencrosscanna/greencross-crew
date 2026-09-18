#!/usr/bin/env node
/* ─── crew.js: applying a folded roster response ─────────────────────────────────────────────────
 *
 *   RUN:  node tests/roster_boot_client_fold_test.js
 *
 * WHY THIS EXISTS
 * boot() used to fire `review` and `eom_history` as two separate background calls after the
 * roster landed, plus loadEom() made its own direct GX Core `config` call for cfg.eom. Now the
 * roster call itself can carry `review` and `eom_history` (`parts=review,eom_history`), and
 * `foldRosterParts` (crew.js) is the pure function that decides what to apply to `state` from
 * whatever the engine sent back. This pins that function directly — no DOM, no network, no boot().
 *
 * WHAT THIS PINS
 *   - a fully-folded response (both parts, both ok) sets state exactly like loadReview()/loadEom()
 *     always did on success.
 *   - `current_holder` becomes `state.eom` — this is the thing that lets the browser retire its
 *     separate GX Core call for cfg.eom, so it has to carry the SAME three-way meaning that call
 *     always had: an id when held, `null` for nobody/unset (never `undefined`, which means
 *     "not loaded").
 *   - a response with NEITHER key (an older engine that ignores `parts=`) says gotReview/gotEom
 *     are both false, which is what tells boot() to fall back to loadReview()/loadEom().
 *   - a part that came back `{ ok:false, error }` still counts as "got" (so boot() does not ALSO
 *     retry it) and its error message survives into `reviewErr`/`eomHistoryErr`.
 *
 * Loads the real crew.js by splicing a `return` into its IIFE, exactly like roster_filter_test.js.
 */
'use strict';
const fs = require('fs');

let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const TAIL = '})();';
const cut = src.lastIndexOf(TAIL);
if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
src = src.slice(0, cut) + '\n; return { foldRosterParts };\n' + src.slice(cut);
src = src.replace('(function () {', 'return (function () {');

function fakeEl() {
  return { _cls: '', _html: '', attrs: {}, children: [],
           style: { setProperty() {} }, classList: { add() {} },
           set className(v) { this._cls = v; }, get className() { return this._cls; },
           set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
           setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
           addEventListener() {}, appendChild(c) { this.children.push(c); } };
}
const document = { readyState: 'loading', currentScript: { src: 'crew.js?v=26' },
                   body: { classList: { add() {}, remove() {} } },
                   getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                   createElement: () => fakeEl(), addEventListener() {} };
const window = { GXClient: () => ({ jsonp: async () => ({}) }),
                 GXStores: { color: () => '' } };
const sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };

const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
  (document, window, sessionStorage, sessionStorage, { hostname: 'localhost' }, {});

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ✓ ' + label);
}
function ok(label, cond) { cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label)); }

// ── 1. both parts folded successfully ───────────────────────────────────────────────────────────
(function () {
  const r = {
    ok: true, rows: [],
    review: { ok: true, items: [{ id: 'x' }], counts: { high: 1, warn: 0, info: 0 } },
    eom_history: { ok: true, history: [{ employee_id: '2', current: true }], current_holder: '2' }
  };
  const f = M.foldRosterParts(r);
  ok('gotReview true', f.gotReview === true);
  ok('gotEom true', f.gotEom === true);
  eq('review items carried through', f.review, [{ id: 'x' }]);
  eq('review counts carried through', f.reviewCounts, { high: 1, warn: 0, info: 0 });
  eq('reviewErr empty on success', f.reviewErr, '');
  eq('eomHistory rows carried through', f.eomHistory, [{ employee_id: '2', current: true }]);
  eq('eomHistoryErr empty on success', f.eomHistoryErr, '');
  eq('eom = current_holder (a real id)', f.eom, '2');
})();

// ── 2. current_holder null (nobody holds it) is NOT the same as "not loaded" ────────────────────
(function () {
  const r = { ok: true, rows: [], eom_history: { ok: true, history: [], current_holder: null } };
  const f = M.foldRosterParts(r);
  ok('gotEom true even when nobody holds it', f.gotEom === true);
  ok('eom is null, not undefined — this IS loaded, just empty', f.eom === null);
})();

// ── 3. neither part present (an engine that ignores parts=) — both flags false ──────────────────
(function () {
  const r = { ok: true, rows: [] };
  const f = M.foldRosterParts(r);
  ok('gotReview false with no review key', f.gotReview === false);
  ok('gotEom false with no eom_history key', f.gotEom === false);
  ok('no review/reviewCounts/reviewErr fields set', !('review' in f) && !('reviewErr' in f));
  ok('no eom/eomHistory fields set', !('eom' in f) && !('eomHistory' in f));
})();

// ── 4. a part that failed server-side still counts as "got" (boot must not double-fetch it) ─────
(function () {
  const r = {
    ok: true, rows: [],
    review: { ok: false, error: 'sheet unreachable' },
    eom_history: { ok: false, error: 'kv boom' }
  };
  const f = M.foldRosterParts(r);
  ok('a failed review part still counts as gotReview', f.gotReview === true);
  ok('a failed eom_history part still counts as gotEom', f.gotEom === true);
  eq('review falls back to an empty list, not undefined', f.review, []);
  eq('the review error message survives', f.reviewErr, 'sheet unreachable');
  eq('eomHistory falls back to an empty list', f.eomHistory, []);
  eq('the eom_history error message survives', f.eomHistoryErr, 'kv boom');
  ok('eom falls back to null on a failed part (never undefined)', f.eom === null);
})();

// ── 5. eom_history ok but missing current_holder entirely degrades to null, not undefined ───────
(function () {
  const r = { ok: true, rows: [], eom_history: { ok: true, history: [] } };   // an even OLDER shape
  const f = M.foldRosterParts(r);
  ok('missing current_holder key still resolves to null, never undefined',
     f.eom === null && f.eom !== undefined);
})();

console.log(fail ? ('\n' + fail + ' FAILED') : '\nroster boot client fold: all passed');
process.exit(fail ? 1 : 0);
