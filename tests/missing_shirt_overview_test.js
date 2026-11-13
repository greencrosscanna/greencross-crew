#!/usr/bin/env node
/* ─── Overview: "Missing shirt size" — tests ──────────────────────────────────────────────────────
 *   RUN:  node tests/missing_shirt_overview_test.js
 * The overview lists ACTIVE staff with no shirt_size, grouped by store, so the swag order can be
 * completed. Same population as the swag-size publish (not retired). Shirt size is not pay, so
 * nothing here may depend on can_see_pay. Loads the real crew.js.
 */
'use strict';
const fs = require('fs');
let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const cut = src.lastIndexOf('})();');
src = src.slice(0, cut) + '\n; return { noShirtGroups, noBadgeGroups, state };\n' + src.slice(cut);
src = src.replace('(function () {', 'return (function () {');
const fakeEl = () => ({ style: { setProperty() {} }, classList: { add() {} }, setAttribute() {},
  addEventListener() {}, appendChild() {} });
const document = { readyState: 'loading', currentScript: { src: 'crew.js?v=1' },
  body: { classList: { add() {}, remove() {} } }, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], createElement: fakeEl, addEventListener() {} };
const window = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' } };
const ss = { getItem: () => '', setItem() {}, removeItem() {} };
const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
  (document, window, ss, ss, { hostname: 'localhost' }, {});

let fail = 0;
function eq(l, g, w) {
  const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a !== b) { fail++; console.log('FAIL ' + l + '\n  got  ' + a + '\n  want ' + b); } else console.log('  ok  ' + l);
}
M.state.stores = { bend: 'Century', center: 'Center' };
M.state.storeOrder = { bend: 1, center: 2 };
const rows = [
  { employee_id: 'a', name: 'Zed Z', store: 'center', shirt_size: '' },
  { employee_id: 'b', name: 'Amy A', store: 'center' },
  { employee_id: 'c', name: 'Bo B', store: 'bend', shirt_size: 'M' },
  { employee_id: 'd', name: 'Cy C', store: 'bend', shirt_size: '  ' },
  { employee_id: 'e', name: 'Old O', store: 'bend', retired: true },
  { employee_id: 'f', name: 'Nos N', store: '' },
];
M.state.canSeePay = false;
const g = M.noShirtGroups(rows);
eq('groups in pill order, blank store last', g.map(x => x.store), ['bend', 'center', '']);
eq('names sorted within a store', g[1].rows.map(r => r.employee_id), ['b', 'a']);
eq('blank/whitespace counts as missing; a size does not; retired never', g[0].rows.map(r => r.employee_id), ['d']);
eq('roster-only users (no pay) get the same list', M.noShirtGroups(rows).length, 3);
eq('nobody missing -> no groups', M.noShirtGroups([{ store: 'bend', shirt_size: 'L' }]), []);

// ── badges: same population, same grouping ──
const brows = [
  { employee_id: 'a', name: 'Zed Z', store: 'center' },
  { employee_id: 'b', name: 'Amy A', store: 'center', badge_issued: true },
  { employee_id: 'c', name: 'Bo B', store: 'bend', badge_issued: false },
  { employee_id: 'e', name: 'Old O', store: 'bend', retired: true },
];
const bg = M.noBadgeGroups(brows);
eq('badge: groups by store, issued and retired excluded', bg.map(x => [x.store, x.rows.map(r => r.employee_id)]),
   [['bend', ['c']], ['center', ['a']]]);

// ── engine: badge_issued is appended, carried by the save, never inferred ──
const code = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const hdr = code.slice(code.indexOf('var ATTR_HEADERS'), code.indexOf('/* The ATTRIBUTE columns'));
eq('badge_issued is appended after retired_on, and only the badge-request columns come after it (append-only)',
   /'retired_on',[\s\S]*'badge_issued',[\s\S]*'badge_requested_on', 'badge_requested_by', 'badge_request_kind'\];/.test(hdr), true);
eq('roster_save carries it (patch-safe)', /badge_issued:\s+p\.badge_issued == null\s+\? \(existing\.badge_issued \|\| ''\)/.test(code), true);
eq('roster rows expose it', /badge_issued: isTruthyFlag_\(a\.badge_issued\)/.test(code), true);
console.log(fail ? '\n' + fail + ' FAILED' : '\nmissing shirt overview: all passed');
process.exit(fail ? 1 : 0);
