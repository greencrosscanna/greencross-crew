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
      '\n; return { storesInRoster, filterByStore, storePills, state, storeName };\n' +
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
const EXPECTED = ['All 6', 'Century 2', 'Center 1', 'River Rd 1', 'Corporate 1', 'No store 1'];
M.state.storeFilter = {};
const clean = M.storePills(rows);
eq('labels and counts', text(clean), EXPECTED);
eq('All lights up when nothing is picked', clean.children[0].getAttribute('aria-pressed'), 'true');

M.state.storeFilter = { bend: true };
const filtered = M.storePills(rows);
eq('counts are unchanged by an active filter', text(filtered), EXPECTED);
eq('All goes dark once a store is picked', filtered.children[0].getAttribute('aria-pressed'), 'false');
eq('the picked pill reads pressed', filtered.children[1].getAttribute('aria-pressed'), 'true');

/* storePills takes the pill SET from state.rows and the COUNTS from its argument — that asymmetry
   is the whole design, so set both. Passing only the argument here would test nothing. */
M.state.storeFilter = {};
M.state.rows = [{ store: 'bend' }, { store: 'bend' }];
eq('a single-store roster gets no pill row at all',
   M.storePills(M.state.rows), null);

console.log(fail ? '\n' + fail + ' FAILED' : '\nroster filter: all passed');
process.exit(fail ? 1 : 0);
