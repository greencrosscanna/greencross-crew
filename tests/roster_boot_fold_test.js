#!/usr/bin/env node
/* ─── Boot folds review + eom_history into the roster call ──────────────────────────────────────
 *
 *   RUN:  node tests/roster_boot_fold_test.js
 *
 * WHY THIS EXISTS
 * Boot used to block on `roster` and then fire `review` and `eom_history` behind it — three
 * queued executions of Crew's own engine for one screen open. `getRoster_` now accepts
 * `parts=review,eom_history` and builds both from the SAME rosterJoin_() call already paid for by
 * the roster itself, each wrapped in its own try/catch so a broken part cannot cost the roster.
 *
 * WHAT THIS PINS
 *   - rosterJoin_ is called EXACTLY ONCE per getRoster_ call, parts or no parts — the whole point.
 *   - `parts=review,eom_history` puts both `review` and `eom_history` on the response, correctly
 *     shaped (same shape the standalone routes already return).
 *   - no `parts` (an older client, or a plain roster re-render) omits both keys entirely — a
 *     silently-added field is still a broken contract for a client that doesn't expect it.
 *   - a part that THROWS reports { ok:false, error } on its own key without taking the roster's
 *     `rows` down with it.
 *   - `eom_history`'s `current_holder` reflects cfg.eom's real state: an id when held, null for
 *     nobody/unset/unreadable — the exact sentinel crew.js's `state.eom` has always used, so the
 *     client can retire its separate GX Core `config` read for cfg.eom.
 *
 * Loads the REAL getRoster_, reviewPayload_, reviewItems_, eomHistoryPayload_, eomSync_,
 * eomCurrent_, eomCurrentHolderId_ and their small real helpers (decisionKey_, normSpace_,
 * liveValueFor_, reportedItemSatisfied_, samePerson_) out of Code.gs. rosterJoin_, GXCore,
 * requireCrew_, canEdit_ and readTab_ are stubs — this is testing the FOLD, not the join or auth,
 * which the roster/coverage tests already pin.
 */
'use strict';
const fs = require('fs');
const path = __dirname + '/../apps-script/Code.gs';
const gs = fs.readFileSync(path, 'utf8');

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

function buildEngine(opts) {
  const rosterCalls = { n: 0 };
  const src =
    grab('reviewPayload_') + '\n' +
    grab('reviewItems_') + '\n' +
    grab('decisionKey_') + '\n' +
    grab('normSpace_') + '\n' +
    grab('liveValueFor_') + '\n' +
    grab('reportedItemSatisfied_') + '\n' +
    grab('nameParts_') + '\n' +
    grab('canonFirst_') + '\n' +
    grab('ratio_') + '\n' +
    grab('samePerson_') + '\n' +
    grab('eomHistoryPayload_') + '\n' +
    grab('eomSync_') + '\n' +
    grab('eomCurrent_') + '\n' +
    grab('eomCurrentHolderId_') + '\n' +
    grab('eomMonthKey_') + '\n' +
    grab('eomSameMonth_') + '\n' +
    grab('getRoster_') + '\n' +
    'function rosterJoin_() { rosterCalls.n++; ' +
    (opts.rosterThrows ? 'throw new Error("rosterJoin_ boom");' : 'return ROSTER;') + ' }\n' +
    'return { getRoster_, reviewItems_, eomHistoryPayload_, eomCurrentHolderId_ };';

  const ROSTER = opts.roster || {
    rows: [
      { employee_id: '1', name: 'Ada Lovelace', retired: false, merged: false },
      { employee_id: '2', name: 'Bea Nguyen',    retired: false, merged: false }
    ],
    identityCount: 2, identityError: '', cached: false,
    names: { '1': 'Ada Lovelace', '2': 'Bea Nguyen' }
  };

  const requireCrew_ = opts.requireCrew || (() => ({ ok: true, user: 'mike', role: 'editor' }));
  const canEdit_ = opts.canEdit || (() => true);
  const readTab_ = opts.readTab || (() => []);   // empty decisions/pending/review/eom tabs by default
  const GXCore = { getKv: opts.getKv || (() => null) };   // cfg.eom unset by default
  // eomSync_ appends a row through this when cfg.eom names a NEW reign the log doesn't have yet —
  // a plain no-op stand-in for the real sheet write, which is not what this file is testing.
  const eomSheet_ = () => ({ appendRow: () => {}, getRange: () => ({ setNumberFormat: () => {} }) });

  const fn = new Function('rosterCalls', 'ROSTER', 'requireCrew_', 'canEdit_', 'readTab_', 'GXCore',
    'eomSheet_', 'NICKNAMES', 'SHIRT_SIZES', 'ROLE_TITLES', 'HR_SHEET_URL', 'DECISION_TAB', 'DECISION_HEADERS',
    'PENDING_TAB', 'PENDING_HEADERS', 'REVIEW_TAB', 'REVIEW_HEADERS', 'EOM_TAB', 'EOM_HEADERS',
    src);
  // Real NICKNAMES map — samePerson_/nameParts_ need it defined, and this test's fixtures include
  // deliberately nickname-distinct names, so the real map (not an empty stand-in) is what makes
  // the duplicate-detection path in reviewItems_ behave exactly as it does in production.
  const NICKNAMES = Object.assign(Object.create(null), {
    mike: 'michael', zach: 'zachary', chris: 'christopher', sam: 'samuel',
    jon: 'jonathan', nick: 'nicholas', dan: 'daniel', matt: 'matthew',
    jen: 'jennifer', tanner: 'taner', sky: 'skyler', skylar: 'skyler',
    bob: 'robert', rob: 'robert', tom: 'thomas', tj: 'thomas', drew: 'andrew'
  });
  const engine = fn(rosterCalls, ROSTER, requireCrew_, canEdit_, readTab_, GXCore,
    eomSheet_, NICKNAMES, ['XS','S','M','L','XL'], ['Admin','Store Manager','Assistant Manager','Budtender'], '',
    'crew_decisions', ['decision_key'], 'crew_pending_hires', ['name_key'],
    'crew_reviews', ['review_id'], 'crew_eom_history', ['employee_id']);
  return { engine, rosterCalls };
}

// ── 1. rosterJoin_ is called exactly once, whether or not parts are requested ──────────────────
(function () {
  const { engine, rosterCalls } = buildEngine({});
  engine.getRoster_({ token: 't' });
  ok('plain roster (no parts): rosterJoin_ called once', rosterCalls.n === 1);
})();

(function () {
  const { engine, rosterCalls } = buildEngine({});
  engine.getRoster_({ token: 't', parts: 'review,eom_history' });
  ok('roster + both parts folded: rosterJoin_ STILL called once, not three times', rosterCalls.n === 1);
})();

// ── 2. no `parts` param: response shape is unchanged, no review/eom_history keys ───────────────
(function () {
  const { engine } = buildEngine({});
  const r = engine.getRoster_({ token: 't' });
  ok('no parts: response has no `review` key', !('review' in r));
  ok('no parts: response has no `eom_history` key', !('eom_history' in r));
  ok('no parts: roster rows are still there', r.rows.length === 2);
})();

// ── 3. `parts=review,eom_history`: both keys present and correctly shaped ──────────────────────
(function () {
  const { engine } = buildEngine({ getKv: (k) => k === 'cfg.eom' ? JSON.stringify({ employee_id: '1', since: '2026-09-01T00:00:00.000Z', set_by: 'sky' }) : null });
  const r = engine.getRoster_({ token: 't', parts: 'review,eom_history' });
  ok('review is present and ok', r.review && r.review.ok === true);
  ok('review has items/counts shape', Array.isArray(r.review.items) && typeof r.review.counts === 'object');
  ok('eom_history is present and ok', r.eom_history && r.eom_history.ok === true);
  ok('eom_history carries current_holder = the held id', r.eom_history.current_holder === '1');
})();

// ── 4. cfg.eom states map to the right current_holder ───────────────────────────────────────────
(function () {
  const cases = [
    ['unset (never picked)', () => null, null],
    ['nobody (explicitly cleared)', () => '', null],
    ['unreadable cfg.eom', () => { throw new Error('kv boom'); }, null],
    ['held', () => JSON.stringify({ employee_id: '2', since: '2026-09-01T00:00:00.000Z' }), '2']
  ];
  cases.forEach(([label, getKv]) => {
    const { engine } = buildEngine({ getKv });
    const r = engine.getRoster_({ token: 't', parts: 'eom_history' });
    ok('current_holder for ' + label + ': ' + JSON.stringify(r.eom_history.current_holder),
       r.eom_history.current_holder === cases.find(c => c[0] === label)[2]);
  });
})();

// ── 5. a part that throws does not cost the roster ──────────────────────────────────────────────
(function () {
  const { engine } = buildEngine({
    readTab: () => { throw new Error('sheet unreachable'); }
  });
  const r = engine.getRoster_({ token: 't', parts: 'review,eom_history' });
  ok('roster rows survive a broken review/eom read', r.ok === true && r.rows.length === 2);
  ok('review reports its own failure', r.review && r.review.ok === false && /sheet unreachable/.test(r.review.error));
  // eom_history's readTab_ failure surfaces through eomSync_'s own rows read — same guard.
  ok('eom_history reports its own failure', r.eom_history && r.eom_history.ok === false);
})();

// ── 6. a completely unknown `parts` value folds nothing (and rosterJoin_ still runs once) ───────
(function () {
  const { engine, rosterCalls } = buildEngine({});
  const r = engine.getRoster_({ token: 't', parts: 'something_else' });
  ok('unknown part name: no review/eom_history keys added', !('review' in r) && !('eom_history' in r));
  ok('unknown part name: rosterJoin_ still called once', rosterCalls.n === 1);
})();

console.log(fail ? ('\n' + fail + ' FAILED') : '\nroster boot fold: all passed');
process.exit(fail ? 1 : 0);
