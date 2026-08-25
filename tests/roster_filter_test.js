#!/usr/bin/env node
/* ─── Crew roster filter (store pills) — tests ────────────────────────────────────────────────────
 *
 *   RUN:  node tests/roster_filter_test.js    (from the repo root; no deps, no network, no login)
 *
 * WHY THESE
 * The roster is the screen Mike actually uses, and every failure below is silent — it hides people
 * rather than erroring, which on an HR roster reads as "they are not employed here":
 *
 *   storesInRoster   pill ORDER and MEMBERSHIP. The set is derived from the loaded roster, not from
 *                    GX Core's store registry, because `corporate` is deliberately absent from that
 *                    registry (it is not a shop). A registry-driven row would drop the admin team
 *                    from the filter entirely and nothing would say so. The blank-store bucket has
 *                    to survive for the same reason: a person whose home_store got blanked by a
 *                    partial write is exactly who you need to be able to find.
 *
 *   filterByStore    an EMPTY filter must pass everything through. Getting that backwards shows an
 *                    empty roster on first paint, which looks like a failed load, not a filter.
 *
 *   storePills       the counts must be computed from the set BEFORE the store filter is applied.
 *                    Count after, and every pill you have not selected reads 0 — so the filter
 *                    tells you there is nobody at Center at the exact moment you want to go there.
 *                    A zero-count pill has to DIM rather than disappear: a row that reflows under
 *                    the cursor is how you click the wrong store.
 *
 *   scopedRows       the segmented Active / Gaps / Retired control replaced three checkboxes, and
 *                    it is now the FIRST of three stacked filters. Getting `active` wrong shows
 *                    retired staff as current employees; getting `retired` wrong shows nobody at
 *                    all on a scope whose whole job is to find somebody who left.
 *
 *   searchRows       matches nickname, employee number and permit number as well as the obvious
 *                    three. "Who is #22" and "whose permit is OLCC-151903" are both questions the
 *                    roster gets asked, and a search that silently ignores them answers "nobody".
 *
 * Loads the real crew.js by splicing a `return` into its IIFE, so this tests shipped source rather
 * than a copy of it. crew.js has no export seam; if it ever grows one, use that instead.
 */
'use strict';
const fs = require('fs');

let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const TAIL = '})();';
const cut = src.lastIndexOf(TAIL);
if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
src = src.slice(0, cut) +
      '\n; return { storesInRoster, filterByStore, storePills, scopedRows, searchRows, byName, state, storeName };\n' +
      src.slice(cut);
src = src.replace('(function () {', 'return (function () {');

/* Just enough DOM for the helpers under test. readyState:'loading' keeps boot() from firing — this
   file tests pure filtering, and a boot would want a network and a session. */
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
                 GXStores: { color: (id) => ({ bend: '#22D3EE', center: '#3B82F6' })[id] || '' } };
const sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };

const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
  (document, window, sessionStorage, sessionStorage, { hostname: 'localhost' }, {});

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ok  ' + label);
}
const text = (row) => row.children.map(c => c._html.replace(/<[^>]*>/g, '').trim());

M.state.stores = { bend: 'Century', center: 'Center', commercial: 'Commercial',
                   hillsboro: 'Baseline', 'portland-rd': 'Portland Rd', 'river-rd': 'River Rd' };
M.state.storeOrder = { bend: 1, center: 2, commercial: 3, hillsboro: 4, 'portland-rd': 5, 'river-rd': 6 };

const rows = [{ store: 'river-rd' }, { store: 'corporate' }, { store: 'bend' },
              { store: '' }, { store: 'center' }, { store: 'bend' }];

// ── order + membership ──────────────────────────────────────────────────────────────────────────
eq('registry order first, pseudo-stores after, blank last',
   M.storesInRoster(rows), ['bend', 'center', 'river-rd', 'corporate', '']);
eq('a store with nobody in it gets no pill',
   M.storesInRoster([{ store: 'bend' }, { store: 'center' }]), ['bend', 'center']);

// ── filtering ───────────────────────────────────────────────────────────────────────────────────
M.state.rows = rows;
M.state.storeFilter = {};
eq('an empty filter passes everything through', M.filterByStore(rows).length, 6);
M.state.storeFilter = { bend: true };
eq('one store', M.filterByStore(rows).map(r => r.store), ['bend', 'bend']);
M.state.storeFilter = { bend: true, corporate: true };
eq('two stores (multi-select)', M.filterByStore(rows).map(r => r.store), ['corporate', 'bend', 'bend']);
M.state.storeFilter = { '': true };
eq('the blank-store bucket is selectable', M.filterByStore(rows).map(r => r.store), ['']);

// ── the pill row itself ─────────────────────────────────────────────────────────────────────────
/* There is no "All" pill any more. It was the reset for a row with no other way back, and the
   workspace has one — a selected pill toggles itself off — so it became a control whose only job
   was to undo the control beside it. The SET and the COUNTS are unchanged. */
const EXPECTED = ['Century 2', 'Center 1', 'River Rd 1', 'Corporate 1', 'No store 1'];
M.state.storeFilter = {};
const clean = M.storePills(rows);
eq('labels and counts', text(clean), EXPECTED);
eq('no All pill', clean.children.map(c => c.getAttribute('data-store')),
   ['bend', 'center', 'river-rd', 'corporate', '']);
eq('nothing reads pressed when nothing is picked',
   clean.children.map(c => c.getAttribute('aria-pressed')),
   ['false', 'false', 'false', 'false', 'false']);

M.state.storeFilter = { bend: true };
const filtered = M.storePills(rows);
eq('counts are unchanged by an active filter', text(filtered), EXPECTED);
eq('the picked pill reads pressed', filtered.children[0].getAttribute('aria-pressed'), 'true');
eq('an unpicked pill does not', filtered.children[1].getAttribute('aria-pressed'), 'false');

/* Counts come from the argument, the SET from state.rows — so a store the search filtered out
   still gets a pill, dimmed, rather than vanishing mid-keystroke. */
M.state.storeFilter = {};
const searched = M.storePills(rows.filter(r => r.store === 'bend'));
eq('a store with no matches keeps its pill', text(searched),
   ['Century 2', 'Center 0', 'River Rd 0', 'Corporate 0', 'No store 0']);
eq('and dims instead of disappearing',
   searched.children.map(c => c.className.indexOf('is-empty') >= 0),
   [false, true, true, true, true]);

// ── scope: the first of the three filters ───────────────────────────────────────────────────────
const people = [
  { name: 'Ada Fennimore',  store: 'bend',     role: 'Budtender',     employee_number: '11',
    preferred_name: '',     permit_number: 'OLCC-100001', flags: [] },
  { name: 'Iggy Barrera',   store: 'bend',     role: 'Budtender',     employee_number: '25',
    preferred_name: '',     permit_number: '',            flags: ['permit'] },
  { name: 'Marisol Vega',   store: 'center',   role: 'Budtender',     employee_number: '31',
    preferred_name: 'Mari', permit_number: 'OLCC-100003', flags: [] },
  { name: 'Tom Older',      store: 'river-rd', role: 'Store Manager', employee_number: '4',
    preferred_name: '',     permit_number: 'OLCC-100004', flags: ['wage'], retired: true }
];
M.state.rows = people;
M.state.q = '';
M.state.scope = 'active';
eq('active hides retired', M.scopedRows().map(r => r.employee_number), ['11', '25', '31']);
M.state.scope = 'attention';
eq('gaps is active AND flagged — a retired row with a gap is not a gap',
   M.scopedRows().map(r => r.employee_number), ['25']);
M.state.scope = 'retired';
eq('retired is ONLY retired', M.scopedRows().map(r => r.employee_number), ['4']);
M.state.scope = 'active';

// ── search: the fields that are not obvious ─────────────────────────────────────────────────────
const found = (q) => { M.state.q = q; return M.searchRows(people).map(r => r.employee_number); };
eq('name', found('barrera'), ['25']);
eq('nickname', found('mari'), ['31']);
eq('store LABEL, not the slug', found('century'), ['11', '25']);
eq('role', found('store manager'), ['4']);
eq('employee number', found('31'), ['31']);
eq('permit number', found('OLCC-100004'), ['4']);
eq('an empty search passes everything through', found(''), ['11', '25', '31', '4']);
M.state.q = '';

// ── ordering inside a group ─────────────────────────────────────────────────────────────────────
/* Blanks sink, in every comparison, always. A record with no name is the ABSENCE of a value, not
   the smallest one — and letting it ride the top of the list buries the people you came to find.
   It is also the row that most needs finding: a blank name means a partial write damaged it. */
eq('alphabetical, blanks last',
   [{ name: 'Zoe' }, { name: '' }, { name: 'Ada' }].sort(M.byName).map(r => r.name),
   ['Ada', 'Zoe', '']);

/* storePills takes the pill SET from state.rows and the COUNTS from its argument — that asymmetry
   is the whole design, so set both. Passing only the argument here would test nothing. */
M.state.storeFilter = {};
M.state.rows = [{ store: 'bend' }, { store: 'bend' }];
eq('a single-store roster gets no pill row at all',
   M.storePills(M.state.rows), null);

console.log(fail ? '\n' + fail + ' FAILED' : '\nroster filter: all passed');
process.exit(fail ? 1 : 0);
