#!/usr/bin/env node
/* ─── The incentive tab's defaults: which period it opens on, and how the tables are ordered ──────
 *
 *   RUN:  node tests/incentive_defaults_test.js      (from the repo root; no deps, no network)
 *
 * Sky, 2026-09-14, two asks:
 *   1. Open on the LAST pay period until it has been approved, then on the current one. On the
 *      Monday after a period ends — close week — the tab used to open on two days of a fortnight
 *      nobody is working on.
 *   2. Group by store by default, with Managers and Budtenders in alphabetical store order.
 *
 * Neither touches a figure. What they can break is WHICH period somebody is looking at when they
 * press a button, so the engine half pins the two ways that goes wrong: opening on an approved
 * period (read-only, nothing to do) and overriding a period somebody explicitly asked for.
 *
 * Loads the real apps-script/Code.gs and crew.js, so this tests shipped source.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

/* ── engine ─────────────────────────────────────────────────────────────────────────────────── */
const ENGINE = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
let KV, TODAY;
const stubs = {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getId: () => 'fake' }) },
  DriveApp: {}, HtmlService: {}, ContentService: {}, UrlFetchApp: {}, MailApp: {}, GmailApp: {},
  ScriptApp: {}, Session: {}, Logger: { log() {} },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  GXCore: { getKv: (k) => (Object.prototype.hasOwnProperty.call(KV, k) ? KV[k] : '') },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => '', setProperty() {} }) },
  Utilities: { formatDate: () => TODAY, sleep() {} },
};
const names = Object.keys(stubs);
const E = new Function(...names, ENGINE + '\n; return { defaultIncentivePeriod_, computedPeriods_ };')
  (...names.map((n) => stubs[n]));

KV = { 'cfg.payPeriodAnchor': '2025-08-04', 'cfg.payPeriodDays': '14' };
const pick = (today, approved) => {
  TODAY = today;
  const by = Object.create(null);
  (approved || []).forEach((s) => { by[s] = { pp_start: s }; });
  return E.defaultIncentivePeriod_(by);
};

console.log('\nWhich period the tab opens on\n');
/* 2026-08-31 → 2026-09-13 is the last completed fortnight on Monday 2026-09-14. */
ok('close-week Monday, last period not approved → opens on the last period',
   pick('2026-09-14', ['2026-08-17']) === '2026-08-31');
ok('last period approved → opens on the running one',
   pick('2026-09-14', ['2026-08-17', '2026-08-31']) === '');
ok('only the IMMEDIATELY previous period counts — an older unapproved one does not pull it back',
   pick('2026-09-14', []) === '2026-08-31');
ok('the last day of the running period still treats the one before it as "last"',
   pick('2026-09-27', []) === '2026-08-31' && pick('2026-09-27', ['2026-08-31']) === '');
ok('the first day of the next period rolls "last" forward',
   pick('2026-09-28', ['2026-08-31']) === '2026-09-14' && pick('2026-09-28', ['2026-09-14']) === '');
KV = {};
ok('no pay-period anchor configured → running period, the old behavior', pick('2026-09-14', []) === '');

const body = ENGINE.slice(ENGINE.indexOf('function getIncentive_('));
const head = body.slice(0, body.indexOf('isPracticePeriod_(want)'));
ok('getIncentive_ only defaults when NO period was asked for',
   /if \(!want\) \{\s*want = defaultIncentivePeriod_\(importedBy\);/.test(head));
ok('the default is chosen BEFORE any branch reads `want`', head.indexOf('defaultIncentivePeriod_') > 0);
ok('the payload says why it chose the period (`defaulted`)', /live\.defaulted = defaulted;/.test(body));

/* ── browser ────────────────────────────────────────────────────────────────────────────────── */
const STORE_NAMES = { 'river-rd': 'River Rd', bend: 'Bend', center: 'Center', commercial: 'Commercial',
                      hillsboro: 'Hillsboro', 'portland-rd': 'Portland Rd' };
const M = (function () {
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const cut = src.lastIndexOf('})();');
  src = src.slice(0, cut) +
        '\n; return { incByStore, incBudTable, incMgrTable, loadIncentive, isGrouped: function () { return incGrouped; } };\n' +
        src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' },
                body: { classList: { add() {}, remove() {} } },
                getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                createElement: () => ({ style: { setProperty() {} }, classList: { add() {} },
                                        setAttribute() {}, addEventListener() {}, appendChild() {} }),
                addEventListener() {} };
  const win = { GXClient: () => ({ jsonp: async () => ({}) }),
                GXStores: { color: () => '', name: (id) => STORE_NAMES[id] || '' } };
  const store = { getItem: () => '', setItem() {}, removeItem() {} };
  /* In a browser `window.GXStores` and bare `GXStores` are the same object; here `window` is a
     parameter, so the bare name has to be put where a free identifier resolves. */
  globalThis.GXStores = win.GXStores;
  return new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
    (doc, win, store, store, { hostname: 'localhost' }, {});
})();

console.log('\nStore order and grouping\n');
const row = (name, store_id) => ({ name, store_id, employee_id: name.toLowerCase() });
const engineOrder = [
  row('Zed', 'river-rd'), row('Amy', 'portland-rd'), row('Floater', 'corporate'), row('Bo', 'bend'),
  row('Nobody', ''), row('Cy', 'river-rd'), row('Di', 'commercial'), row('Ed', 'center'), row('Al', 'bend'),
];
const sorted = M.incByStore(engineOrder).map((r) => r.name);
ok('stores A→Z by the name the screen prints, corporate then unassigned last',
   sorted.join(',') === 'Bo,Al,Ed,Di,Amy,Zed,Cy,Floater,Nobody');
ok('within a store the engine\'s order is kept (Bo before Al, Zed before Cy)',
   sorted.indexOf('Bo') < sorted.indexOf('Al') && sorted.indexOf('Zed') < sorted.indexOf('Cy'));
ok('the input array is not reordered — totals and facts read it too',
   engineOrder.map((r) => r.name).join(',') === 'Zed,Amy,Floater,Bo,Nobody,Cy,Di,Ed,Al');
ok('a renamed store sorts by its NEW name, not its id',
   (() => { STORE_NAMES.bend = 'Zebra'; const o = M.incByStore(engineOrder).map((r) => r.name);
            STORE_NAMES.bend = 'Bend'; return o.indexOf('Bo') > o.indexOf('Cy') && o.indexOf('Bo') < o.indexOf('Floater'); })());

ok('the tab opens grouped by store', M.isGrouped() === true);

const calc = () => ({ qual: false, bonus: 0, payroll: 0 });
const budHtml = M.incBudTable(engineOrder, calc, false, false, null);
const groupOrder = (budHtml.match(/crew-inc-grouplbl">([^<]*)</g) || []).map((m) => m.replace(/.*>/, '').replace(/<$/, ''));
ok('budtender groups render in store order', groupOrder.join('|') === 'Bend|Center|Commercial|Portland Rd|River Rd|corporate|');
ok('the toggle reads "Grouped by store" and is lit', /crew-inc-group is-on" id="incGroupBy">Grouped by store/.test(budHtml));

const mgrHtml = M.incMgrTable([row('M-River', 'river-rd'), row('M-Bend', 'bend'), row('M-Center', 'center')],
                              calc, true, false, null);
ok('managers render in store order', mgrHtml.indexOf('M-Bend') < mgrHtml.indexOf('M-Center') &&
                                     mgrHtml.indexOf('M-Center') < mgrHtml.indexOf('M-River'));

const flat = M.incBudTable(engineOrder, calc, true, false, null);
ok('an as-paid period renders flat but still in store order',
   !/crew-inc-grouprow/.test(flat) && flat.indexOf('>Bo<') < flat.indexOf('>Ed<') && flat.indexOf('>Ed<') < flat.indexOf('>Zed<'));

const SRC = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const load = SRC.slice(SRC.indexOf('async function loadIncentive('));
ok('changing period puts the view back to grouped, not flat',
   /incGrouped = true;/.test(load.slice(0, 600)) && !/incGrouped = false/.test(SRC));

console.log(fail ? '\nincentive defaults: ' + fail + ' FAILED\n' : '\nincentive defaults: all passed\n');
process.exit(fail ? 1 : 0);
