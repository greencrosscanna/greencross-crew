#!/usr/bin/env node
/* ─── The closed-period screen reads less, and shows exactly what it showed before ────────────────
 *
 *   RUN:            node tests/incentive_read_speedup_test.js
 *   PROVE IT BITES: node scripts/prove-incentive-read-red.js   (mutates a COPY of Code.gs)
 *
 * WHAT CHANGED (2026-10-13). Opening a CLOSED pay period read the history tab twice and asked GX
 * Core for the whole employee registry every time. `getIncentive_` now hands `incentiveHistory_`
 * the history rows it already holds, and the registry list comes from the screen's existing
 * 10-minute cache. An approved PRACTICE period likewise reads its tab once instead of twice.
 *
 * WHAT MUST NOT HAVE CHANGED, and what this file is for: every figure, on every kind of period;
 * and everything about the paths that WRITE — approve, send, reopen — which must go on reading
 * their own fresh data and never a screen's.
 *
 * HOW. The WHOLE shipped Code.gs is loaded into a sandbox over fake Google services and driven
 * through its real router (`doGet`), so the routes, the gates and the sheet reads are the shipped
 * ones. Three comparisons:
 *
 *   1. FAST vs SLOW, always. The same engine with the hand-over withheld (incentiveHistory_ called
 *      the way the deploy-secret route calls it) must answer byte-for-byte the same.
 *   2. BEFORE vs AFTER, when git can show the commit this branch started from. The engine as it
 *      was, loaded the same way and asked the same questions, must answer the same — screens,
 *      store email, and a whole send/approve/reopen with every sheet and email it produces.
 *      SKIPS LOUDLY in a shallow clone; comparison 1 and the read counts do not.
 *   3. A WRITE, THEN THE SCREEN. Approve, reopen and a rename are each followed at once by a load.
 *
 * CODE_GS=/path/to/Code.gs points the "after" side at another copy of the engine.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_NEW = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
/* The commit this change was built on: request timing merged, the read speedup not yet written. */
const BASELINE = '26d9cd9';
let SRC_OLD = null;
try {
  SRC_OLD = execFileSync('git', ['show', BASELINE + ':apps-script/Code.gs'],
                         { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) { SRC_OLD = null; }

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
const skip = (label, why) => console.log('  ○ SKIP ' + label + ' — ' + why);
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  console.log('\n' + (fail + 1) + ' FAILED (of ' + (pass + fail + 1) + ' reached)');
  process.exit(1);
});

/* ── Fixtures ───────────────────────────────────────────────────────────────────────────────── */
const NOW = Date.UTC(2026, 9, 13, 18, 0, 0);         // Tuesday 2026-10-13, 11:00 AM Pacific
const SECRET = 'fx-secret-9q7z';                     // a fixture, not a credential
const T = {
  hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: ['center', 'portland'],
               aovTarget: 33, aovBonus: 25, discountMaxPct: 1.5, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 }],
             discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 }], maxPerStore: 50 },
};
const EMPLOYEES = () => [
  { employee_id: 'sky_owner', full_name: 'Sky Owner', home_store: 'corporate', role_title: 'Admin', status: 'active', hire_date: '2015-01-01', user_id: 'sky' },
  { employee_id: 'mike_prep', full_name: 'Mike Preparer', home_store: 'corporate', role_title: 'Admin', status: 'active', hire_date: '2018-01-01', user_id: 'mike' },
  { employee_id: 'mona_mgr', full_name: 'Mona Manager', home_store: 'bend', role_title: 'Manager', status: 'active', hire_date: '2020-01-01', user_id: 'mona' },
  { employee_id: 'max_mgr', full_name: 'Max Manager', home_store: 'center', role_title: 'Manager', status: 'active', hire_date: '2020-01-01', user_id: '' },
  { employee_id: 'bea_bud', full_name: 'Beatrice Budd', preferred_name: 'Bea', home_store: 'bend', role_title: 'Budtender', status: 'active', hire_date: '2022-01-01', user_id: '' },
  { employee_id: 'bo_bud', full_name: 'Bo Budd', home_store: 'bend', role_title: 'Budtender', status: 'active', hire_date: '2022-01-01', user_id: '' },
  { employee_id: 'cy_bud', full_name: 'Cyrus Budd', preferred_name: 'Cy', home_store: 'center', role_title: 'Budtender', status: 'active', hire_date: '2022-01-01', user_id: '' },
  { employee_id: 'old_bud', full_name: 'Olive Gone', home_store: 'center', role_title: 'Budtender', status: 'retired', hire_date: '2019-01-01', user_id: '' },
];
const STORES = [{ store_id: 'bend', display_name: 'Bend' }, { store_id: 'center', display_name: 'Center' },
                { store_id: 'corporate', display_name: 'Corporate' }];
const PERIODS = { '2026-08-17': '2026-08-30', '2026-08-31': '2026-09-13', '2026-09-14': '2026-09-27',
                  '2026-09-28': '2026-10-11', '2026-10-12': '2026-10-25' };
const CLOSED = ['2026-08-17', '2026-08-31', '2026-09-14'];
const PRACTICE = 'practice-2026-09-28';

/* GX Core's incentive_perf payload for one fortnight — the shape mapCorePerf_ reads. */
function corePerf(pp) {
  const start = pp || '2026-10-12', n = Object.keys(PERIODS).indexOf(start) + 1;
  const bud = (name, full, store, txn, sales) => ({ name, full_name: full, store, store_name: store === 'bend' ? 'Bend' : 'Center',
    transactions: txn, sales, discount_rate: 0.011, aov: Math.round(sales / txn * 100) / 100 });
  return { ok: true, cache_policy: 'ended-30min', pp_start: start, pp_end: PERIODS[start],
    payPeriod: { start, end: PERIODS[start], current: start === '2026-10-12' },
    budtenders: [bud('Bea Budd', 'Beatrice Budd', 'bend', 240 + n, 8200 + 10 * n), bud('Bo Budd', 'Bo Budd', 'bend', 190, 6100.5),
                 bud('Cy Budd', 'Cyrus Budd', 'center', 210, 7000)],
    managers: [Object.assign(bud('Mona Manager', 'Mona Manager', 'bend', 430 + n, 14300.5 + 10 * n), { target: 13000 }),
               Object.assign(bud('Max Manager', 'Max Manager', 'center', 210, 7000), { target: 7500 })],
    admin: { employee_id: 'sky_owner', name: 'Sky Owner', actual: 21300.5 + 10 * n, target: 20500 },
    admin_actual: 21300.5 + 10 * n, admin_target: 20500,
    stores: { bend: { sales: 14300.5 + 10 * n, txns: 430 + n }, center: { sales: 7000, txns: 210 } },
    returns_not_counted: [], return_grace_days: 7, unresolved: [] };
}

/* A closed period's frozen rows, by position, in HISTORY_HEADERS order. */
function historyRows(pp, tag) {
  const end = PERIODS[pp.replace('practice-', '')];
  const at = '2026-09-0' + (CLOSED.indexOf(pp) + 1) + 'T17:00:00.000Z';
  const row = (section, id, name, store, sid, txn, sales, disc, aov, spiff, bonus, hr, payroll, computed, note) =>
    [pp, end, section, id, name, store, sid, txn, sales, disc, aov, spiff, bonus, hr, payroll, 'approved by sky' + (tag || ''), 'approved', at, computed, note];
  return [
    row('admin', 'sky_owner', 'Sky Owner', '', '', '', 21310.5, '', '', '', 300, 3.75, 300, 300, ''),
    row('manager', 'mona_mgr', 'Mona Manager', 'Bend', 'bend', '', 14310.5, 1.1, 33.2, 12.5, 262.5, 3.28, 250, 250, ''),
    row('manager', 'max_mgr', 'Max Manager', 'Center', 'center', '', 7000, 1.1, 33.33, '', 100, 1.25, 100, 100, ''),
    row('budtender', 'bea_bud', 'Bea Budd', 'Bend', 'bend', 241, 8210, 1.1, 34.07, 20, 85, 1.06, 65, 65, ''),
    row('budtender', 'bo_bud', 'Bo Budd', 'Bend', 'bend', 190, 6100.5, 1.1, 32.11, '', 25, 0.31, 40, 25, 'paid 40 by hand, agreed with Mike'),
    row('budtender', 'old_bud', 'Olive Gone', 'Center', 'center', 210, 7000, 1.1, 33.33, '', 50, 0.63, 50, 50, ''),
  ];
}

/* ── Fake Google services ───────────────────────────────────────────────────────────────────── */
function laParts(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return p;
}
function formatDate(d, tz, fmt) {
  const p = laParts(d);
  return String(fmt).replace(/yyyy/g, p.year).replace(/MM/g, p.month).replace(/dd/g, p.day)
    .replace(/HH/g, p.hour).replace(/mm/g, p.minute).replace(/ss/g, p.second)
    .replace(/\bM\b/g, String(Number(p.month))).replace(/\bd\b/g, String(Number(p.day))).replace(/yy/g, p.year.slice(2));
}

function world(src, opts) {
  opts = opts || {};
  const W = { clock: { t: NOW, step: 0, perRead: 0, perRegistry: 0 }, reads: Object.create(null), writes: Object.create(null),
              registry: 0, fetches: [], mails: [], cache: new Map(), ttl: new Map(), props: { CREW_SHEET_ID: 'SHEET-1', GX_DEPLOY_SECRET: SECRET, STORE_EMAIL_TO: 'mike@greencrosscanna.com' },
              employees: EMPLOYEES(), uuid: 0, created: 0 };
  const kv = { 'cfg.payPeriodAnchor': '2026-08-17', 'cfg.payPeriodDays': '14', 'cfg.crewApprover': 'sky',
               'cfg.crewBackupApprover': 'shawn', incentiveThresholds: JSON.stringify(T), spiffProgress: 'https://spiff.example/exec' };
  W.kv = kv;
  const now = () => { const v = W.clock.t; W.clock.t += W.clock.step; return v; };

  const sheets = Object.create(null);
  W.sheets = sheets;
  function makeSheet(name) {
    const data = [];
    const sh = {
      data, getName: () => name, getParent: () => book,
      getLastRow() { let n = data.length; while (n && data[n - 1].every((v) => v === '' || v == null)) n--; return n; },
      getLastColumn() { return data.reduce((m, r) => Math.max(m, r.length), 0); },
      getMaxRows() { return Math.max(1000, data.length); },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        const rng = {
          getValue() { const row = data[r - 1] || []; return row[c - 1] == null ? '' : row[c - 1]; },
          getValues() {
            if (r >= 2) { W.reads[name] = (W.reads[name] || 0) + 1; W.clock.t += W.clock.perRead; }
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = data[r - 1 + i] || [];
              out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] == null ? '' : row[c - 1 + j]));
            }
            return out;
          },
          setValues(vals) {
            if (r >= 2) W.writes[name] = (W.writes[name] || 0) + 1;
            for (let i = 0; i < vals.length; i++) {
              while (data.length < r + i) data.push([]);
              for (let j = 0; j < vals[i].length; j++) data[r - 1 + i][c - 1 + j] = vals[i][j];
            }
            return rng;
          },
          setValue(v) { return rng.setValues([[v]]); },
          setNumberFormat() { return rng; }, setFontWeight() { return rng; }, setBackground() { return rng; },
          setFontColor() { return rng; }, setWrap() { return rng; }, clearContent() { return rng; },
        };
        return rng;
      },
      getDataRange() { return sh.getRange(1, 1, Math.max(1, sh.getLastRow()), Math.max(1, sh.getLastColumn())); },
      appendRow(row) { W.writes[name] = (W.writes[name] || 0) + 1; data.push(row.slice()); return sh; },
      deleteRow(n) { W.writes[name] = (W.writes[name] || 0) + 1; data.splice(n - 1, 1); },
      deleteRows(n, count) { W.writes[name] = (W.writes[name] || 0) + 1; data.splice(n - 1, count); },
      setFrozenRows() {}, setColumnWidth() {}, autoResizeColumns() {}, hideSheet() {},
    };
    return sh;
  }
  const book = {
    getId: () => 'SHEET-1', getName: () => 'GX Crew — HR data', getUrl: () => 'https://sheets.example/SHEET-1',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    deleteSheet: (sh) => { delete sheets[sh.getName()]; },
    getSheets: () => Object.keys(sheets).map((n) => sheets[n]),
  };

  const sandbox = {
    __now: now,
    console: { log() {} },
    Utilities: { formatDate, getUuid: () => 'uuid-' + (++W.uuid) + '-aaaa-bbbb', sleep() {},
                 computeDigest: (a, s) => Array.from(String(s)).map((ch) => ch.charCodeAt(0) % 127),
                 base64Encode: (b) => Buffer.from(b).toString('base64'), base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
                 newBlob: (s) => ({ getAs: () => ({ setName() { return this; } }), setName() { return this; } }),
                 DigestAlgorithm: { SHA_256: 1, MD5: 2 }, Charset: { UTF_8: 1 } },
    ContentService: { MimeType: { JSON: 'json', JAVASCRIPT: 'js' }, createTextOutput: (t) => ({ body: t, setMimeType() { return this; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (W.cache.has(k) ? W.cache.get(k) : null),
      put: (k, v, ttl) => { if (String(v).length > 100000) throw new Error('Argument too large: value'); W.cache.set(k, String(v)); W.ttl.set(k, ttl); },
      remove: (k) => { W.cache.delete(k); },
      getAll: (ks) => { const o = {}; ks.forEach((k) => { if (W.cache.has(k)) o[k] = W.cache.get(k); }); return o; },
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (W.props[k] == null ? null : W.props[k]),
      setProperty: (k, v) => { W.props[k] = String(v); }, deleteProperty: (k) => { delete W.props[k]; },
      getProperties: () => Object.assign({}, W.props), getKeys: () => Object.keys(W.props),
    }) },
    SpreadsheetApp: { openById: () => book, create: () => { W.created++; return book; }, flush() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {}, hasLock: () => true }) },
    MailApp: { sendEmail: (o) => { W.mails.push({ to: o.to, subject: o.subject, body: o.body || '', html: o.htmlBody || '' }); },
               getRemainingDailyQuota: () => 100 },
    /* The two live reads approve and send make over HTTP: GX Core's performance slice and SPIFF. */
    UrlFetchApp: { fetch: (url) => {
      W.fetches.push(String(url).replace(/secret=[^&]*/, 'secret=<s>'));
      const reply = (o) => ({ getContentText: () => JSON.stringify(o), getResponseCode: () => 200 });
      const pp = (String(url).match(/pp_start=([0-9-]+)/) || [])[1] || '';
      if (/action=incentive_perf/.test(url)) return reply(Object.assign(corePerf(pp), { cache_policy: undefined }));
      if (/action=progress/.test(url)) return reply({ ok: true, rows: [], by_employee: [], refreshed_at: '2026-10-12 18:00:00' });
      throw new Error('unexpected fetch in this test');
    } },
    DriveApp: { getFolderById: () => { throw new Error('no Drive in this test'); }, getFileById: () => { throw new Error('no Drive in this test'); } },
    ScriptApp: { getProjectTriggers: () => [], getOAuthToken: () => 'tok', getService: () => ({ getUrl: () => 'https://crew.example/exec' }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'sky@example.com' }), getEffectiveUser: () => ({ getEmail: () => 'sky@example.com' }),
               getScriptTimeZone: () => 'America/Los_Angeles' },
    Logger: { log() {} },
    GXCore: {
      libVersion: () => 'v-test',
      requireAuth: (params) => {
        const tok = String((params && (params.token || params.session || params.auth)) || '');
        if (tok === 'T-sky') return { ok: true, user: 'sky', role: 'admin' };
        if (tok === 'T-mike') return { ok: true, user: 'mike', role: 'editor' };
        if (tok === 'T-view') return { ok: true, user: 'dev', role: 'viewer' };
        return { ok: false, error: 'Auth required' };
      },
      verifySession: () => ({ ok: false }),
      roleCanEdit: (role) => ['admin', 'editor', 'director', 'manager'].indexOf(String(role)) >= 0,
      getKv: (k) => (kv[k] == null ? null : kv[k]),
      getEmployees: () => { W.registry++; W.clock.t += W.clock.perRegistry; return JSON.parse(JSON.stringify(W.employees)); },
      getStores: () => JSON.parse(JSON.stringify(STORES)),
      resolveStore: (label) => STORES.find((s) => s.store_id === String(label).toLowerCase() || s.display_name.toLowerCase() === String(label).toLowerCase()) || null,
      /* Dutchie's closing report, agreeing with the slice: fourteen equal days per store. Without it
         "Send for approval" refuses, correctly — the store totals could not be checked. */
      getSalesDaily: (store, from, to) => {
        if (!PERIODS[from] || PERIODS[from] !== to) return [];
        const perf = corePerf(from), rows = [];
        Object.keys(perf.stores).forEach((sid) => {
          for (let i = 0; i < 14; i++) {
            const d = new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10) + i, 12)).toISOString().slice(0, 10);
            rows.push({ store: sid, date: d, net: perf.stores[sid].sales / 14, orders: perf.stores[sid].txns / 14 });
          }
        });
        return rows;
      },
      incentivePerf: (o) => corePerf(String((o && o.pp_start) || '')),
      publishedSpiffProgress: () => ({ ok: true, published_at: '2026-10-13T17:00:00.000Z', published_by: 'spiff', scope: '',
                                       payload: { ok: true, rows: [], by_employee: [], refreshed_at: '2026-10-12 18:00:00' } }),
      getPeriodGoals: () => [],
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    '(function () { var R = Date; function F(a, b, c, d, e, f, g) { var n = arguments.length;' +
    ' if (n === 0) return new R(__now()); if (n === 1) return new R(a); return new R(a, b, c || 1, d || 0, e || 0, f || 0, g || 0); }' +
    ' F.now = function () { return __now(); }; F.UTC = R.UTC; F.parse = R.parse; F.prototype = R.prototype; Date = F; })();', sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  W.sb = sandbox;
  const g = (name) => vm.runInContext(name, sandbox);
  W.g = g;

  /* Seed the workbook: three closed periods, their schemes and goals, attributes, a tick. */
  const seed = (tab, headers, rows) => { const sh = book.insertSheet(tab); sh.data.push(headers.slice()); rows.forEach((r) => sh.data.push(r.slice())); };
  const H = g('HISTORY_HEADERS');
  let hist = [];
  CLOSED.forEach((pp) => { hist = hist.concat(historyRows(pp)); });
  seed(g('HISTORY_TAB'), H, hist);
  const A = g('ATTR_HEADERS');
  const attr = (id, patch) => A.map((h) => (h === 'employee_id' ? id : (patch[h] == null ? '' : patch[h])));
  seed(g('ATTR_TAB'), A, [attr('bea_bud', { middle_initial: 'Q', employee_number: '07' }), attr('bo_bud', { middle_initial: 'R' }),
                          attr('mona_mgr', { middle_initial: 'M' }), attr('sky_owner', { employee_number: '00' })]);
  seed(g('SCHEME_TAB'), g('SCHEME_HEADERS'), [['2026-09-14', JSON.stringify(T), '2026-09-29T17:00:00.000Z', 'sky']]);
  seed(g('GOALS_TAB'), g('GOALS_HEADERS'), [['2026-09-14', JSON.stringify({ admin: 20500, stores: { bend: 13000, center: 7500 } }), '2026-09-29T17:00:00.000Z', 'sky', 'approval']]);
  const I = g('INPUTS_HEADERS');
  const inp = (pp, id, patch) => I.map((h) => (h === 'pp_start' ? pp : h === 'employee_id' ? id : (patch[h] == null ? '' : patch[h])));
  seed(g('INPUTS_TAB'), I, [inp('2026-09-14', 'bea_bud', { att: 'TRUE' }), inp('2026-09-28', 'bea_bud', { att: 'TRUE' }),
                            inp('2026-09-28', 'bo_bud', { att: 'TRUE', payroll_override: 40, override_note: 'agreed with Mike' })]);
  if (opts.practiceApproved) {
    seed(g('HISTORY_TAB') + '_practice', H, historyRows(PRACTICE, ' (practice)').map((r) => { r[1] = PERIODS['2026-09-28']; return r; }));
  }
  /* A practice tab that holds only an EARLIER rehearsal: rows, but none for the period asked about. */
  if (opts.practiceStale) {
    seed(g('HISTORY_TAB') + '_practice', H, historyRows('practice-2026-09-14', ' (practice)').map((r) => { r[1] = PERIODS['2026-09-14']; return r; }));
  }

  W.get = (params) => {
    const res = sandbox.doGet({ parameter: params });
    let d = null;
    try { d = JSON.parse(res.body); } catch (e) { d = { __not_json: String(res.body).slice(0, 80) }; }
    return d;
  };
  /* A payload with the clock-and-machine parts taken out, as text: what "the same answer" means. */
  W.screen = (params) => { const d = W.get(Object.assign({ action: 'incentive', token: 'T-sky' }, params)); delete d.timings; return JSON.stringify(d); };
  W.count = (fn) => { const r0 = Object.assign({}, W.reads), e0 = W.registry; fn();
    const d = {}; Object.keys(W.reads).forEach((k) => { if ((W.reads[k] || 0) !== (r0[k] || 0)) d[k] = W.reads[k] - (r0[k] || 0); });
    return { reads: d, registry: W.registry - e0 }; };
  W.book = () => { const o = {}; Object.keys(sheets).sort().forEach((n) => { if (n !== 'crew_request_stats') o[n] = sheets[n].data; }); return JSON.stringify(o); };
  /* Withhold the hand-over: incentiveHistory_ is called with ONE argument, as the route calls it. */
  W.forceSlow = () => vm.runInContext('var __ih = incentiveHistory_; incentiveHistory_ = function (p) { return __ih(p); };', sandbox);
  return W;
}

const HIST = 'crew_incentive_history';
/* Every screen the change could reach, as { label, params, opts }. */
const SCREENS = [
  ['the default screen (the fortnight waiting to be closed)', {}],
  ['the running period', { pp_start: '2026-10-12' }],
  ['the ended, unapproved period', { pp_start: '2026-09-28' }],
  ['a closed period with goals, a scheme and a tick', { pp_start: '2026-09-14' }],
  ['a closed period with none of those', { pp_start: '2026-08-17' }],
  ['a closed period, read-only viewer', { pp_start: '2026-08-31', token: 'T-view' }],
  ['a closed period, the preparer', { pp_start: '2026-09-14', token: 'T-mike' }],
  ['the practice period, not yet approved', { pp_start: PRACTICE }],
  ['a period that does not exist', { pp_start: '2031-01-06' }],
  ['no session at all', { pp_start: '2026-09-14', token: '' }],
];

/* ── 0. The harness is real ─────────────────────────────────────────────────────────────────── */
console.log('\nThe whole shipped engine, through its own router');
{
  const W = world(SRC_NEW);
  const closed = W.get({ action: 'incentive', token: 'T-sky', pp_start: '2026-09-14' });
  ok('a closed period is served as a frozen record, with its people',
     closed.ok === true && closed.source === 'imported' && closed.budtenders.length === 3 && closed.managers.length === 2 && !!closed.admin);
  ok('…with legal names and middle initials joined on', closed.budtenders[0].full_name === 'Beatrice Budd' && closed.budtenders[0].middle_initial === 'Q');
  ok('…with the frozen goals and scheme', closed.managers[0].target === 13000 && closed.thresholds && closed.thresholds.hoursPerPeriod === 80);
  ok('…and the override it was paid on', closed.budtenders[1].payroll === 40 && closed.budtenders[1].computed_payroll === 25);
  const live = W.get({ action: 'incentive', token: 'T-sky' });
  ok('with nothing asked for, it opens on the ended fortnight, live', live.ok === true && live.source === 'live' && live.payPeriod.start === '2026-09-28' && live.defaulted === 'unapproved_previous');
  ok('…with real rows, stamped to the registry', live.budtenders.length === 3 && live.budtenders[0].employee_id === 'bea_bud' && live.budtenders[0].sales > 8000);
  ok('the period list knows which are closed', live.periods.filter((x) => x.source === 'imported').map((x) => x.pp_start).sort().join() === CLOSED.join());
  const prac = W.get({ action: 'incentive', token: 'T-sky', pp_start: PRACTICE });
  ok('the practice period is live, under its own key', prac.ok === true && prac.source === 'live' && prac.payPeriod.start === PRACTICE && !!prac.practice);
  ok('the harness never let the engine create a workbook', W.created === 0);
}

/* ── 1. What it reads now ───────────────────────────────────────────────────────────────────── */
console.log('\nA closed period: one read of the history tab, and the registry from the cache');
{
  const W = world(SRC_NEW);
  const cold = W.count(() => W.screen({ pp_start: '2026-09-14' }));
  ok('the history tab is read ONCE (it was twice): ' + (cold.reads[HIST] || 0), cold.reads[HIST] === 1);
  ok('a cold cache reads the registry once, and keeps it', cold.registry === 1 && W.cache.has(W.g('CORE_EMP_CACHE_KEY')));
  ok('…for the roster cache\'s ten minutes, not longer', W.ttl.get(W.g('CORE_EMP_CACHE_KEY')) === 600);
  const warm = W.count(() => W.screen({ pp_start: '2026-08-17' }));
  ok('the next closed period reads the registry not at all', warm.registry === 0 && warm.reads[HIST] === 1);
  const liveLoad = W.count(() => W.screen({ pp_start: '2026-09-28' }));
  ok('a live period still reads the history tab once, as before', liveLoad.reads[HIST] === 1);

  const S = world(SRC_NEW); S.forceSlow();
  const slow = S.count(() => S.screen({ pp_start: '2026-09-14' }));
  S.screen({ pp_start: '2026-08-17' });
  ok('with the hand-over withheld it is the old cost: two history reads, the registry every time',
     slow.reads[HIST] === 2 && slow.registry === 1 && S.registry === 2 && !S.cache.has(S.g('CORE_EMP_CACHE_KEY')));

  const P = world(SRC_NEW, { practiceApproved: true });
  const pr = P.count(() => P.screen({ pp_start: PRACTICE }));
  const d = JSON.parse(P.screen({ pp_start: PRACTICE }));
  ok('an APPROVED practice period is served frozen', d.source === 'imported' && !!d.practice && d.budtenders.length === 3);
  ok('…and its tab is read ONCE (it was twice): ' + (pr.reads[HIST + '_practice'] || 0), pr.reads[HIST + '_practice'] === 1);
  const st = world(SRC_NEW, { practiceStale: true });
  const stale = JSON.parse(st.screen({ pp_start: PRACTICE }));
  ok('a practice tab holding only an EARLIER rehearsal does not make this one look approved',
     stale.source === 'live' && stale.payPeriod.start === PRACTICE && stale.can_edit === true);
  ok('…while that earlier rehearsal is still served frozen', JSON.parse(st.screen({ pp_start: 'practice-2026-09-14' })).source === 'imported');
  const pu = world(SRC_NEW);
  const un = pu.count(() => pu.screen({ pp_start: PRACTICE }));
  ok('an unapproved practice period still asks its tab once whether it is approved', (un.reads[HIST + '_practice'] || 0) <= 1 && pu.sheets[HIST + '_practice'] !== undefined);
}

console.log('\nWhat that is worth, in this file\'s own clock (each sheet read 600ms, the registry 1500ms)');
{
  const stage = (W) => {
    W.clock.perRead = 600; W.clock.perRegistry = 1500;
    W.get({ action: 'incentive', token: 'T-sky', pp_start: '2026-08-17' });       // warms the cache
    W.cache.forEach((v, k) => { if (/^crewreq:/.test(k)) W.cache.delete(k); });
    W.get({ action: 'incentive', token: 'T-sky', pp_start: '2026-09-14' });
    const r = W.get({ action: 'request_stats', secret: SECRET, hours: '1' });
    const inc = (r.actions || []).find((a) => a.name === 'incentive') || { stages: [] };
    const s = {}; (inc.stages || []).forEach((x) => { s[x.stage] = x.avg_ms; });
    return { total: inc.max_ms, record: s.closed_record };
  };
  const fast = stage(world(SRC_NEW));
  const S = world(SRC_NEW); S.forceSlow();
  const slow = stage(S);
  console.log('    closed_record stage: ' + slow.record + 'ms with the hand-over withheld, ' + fast.record + 'ms with it');
  console.log('    whole request:       ' + slow.total + 'ms → ' + fast.total + 'ms   (a simulated clock — NOT a live measurement)');
  ok('the closed_record stage is recorded, and is the part that got shorter', fast.record > 0 && slow.record - fast.record === 600 + 1500);
  ok('nothing else in the request got longer', slow.total - fast.total === 600 + 1500);
}

/* ── 2. Fast and slow answer the same ───────────────────────────────────────────────────────── */
console.log('\nThe same answer with the hand-over and without it, on every kind of period');
{
  [false, true].forEach((practiceApproved) => {
    const F = world(SRC_NEW, { practiceApproved }), S = world(SRC_NEW, { practiceApproved });
    S.forceSlow();
    SCREENS.forEach(([label, params]) => {
      /* Twice: the first load fills the fast side's cache, the second reads from it. */
      const a1 = F.screen(params), b1 = S.screen(params), a2 = F.screen(params), b2 = S.screen(params);
      ok((practiceApproved ? 'practice approved — ' : '') + label, a1 === b1 && a2 === b2 && a1.length > 30);
    });
    const mail = (W) => JSON.stringify(W.get({ action: 'store_email', secret: SECRET, pp_start: '2026-09-14', show: 'html' }));
    ok((practiceApproved ? 'practice approved — ' : '') + 'the store email for a closed period (the preAuth caller)', mail(F) === mail(S) && /Bend/.test(mail(F)));
  });
}

/* ── 3. Before and after ────────────────────────────────────────────────────────────────────── */
console.log('\nBefore this change and after it (the engine at ' + BASELINE + ' against the shipped one)');
const WRITE_FNS = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_',
                   'perfForWrite_', 'withPayLock_', 'filePayoutPdf_', 'backupCrewSheet_', 'notifyApproved_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'freezeScheme_', 'freezeGoals_', 'wfSet_', 'historySheet_',
                   'applySpiffEarnings_', 'spiffProgressFor_', 'fetchLivePerfFromCore_', 'stampEmployeeIds_', 'approvalThresholds_',
                   'incentiveBlockers_', 'storeTotals_', 'historyBand_', 'historyPeriods_', 'inputsFor_', 'readTab_', 'sheetOf_'];
function fnText(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) return null;
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? src.length : j).replace(/\n\/\*[\s\S]*$/, (m) => (/\*\/\s*$/.test(m) ? '' : m));
}
/* One whole close: Mike sends, Sky looks, Sky approves, a retry lands, Sky reopens. */
function closeScenario(W) {
  const pp = '2026-09-28', ack = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' };
  const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
  const out = [];
  const call = (p) => { const d = W.get(p); delete d.timings; out.push(d); return d; };
  call(Object.assign({ action: 'incentive_approve', token: 'T-mike', pp_start: pp }, ack));
  call(Object.assign({ action: 'incentive_send', token: 'T-mike', pp_start: pp, request_id: rid('S') }, ack));
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp }, ack));
  const done = call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  call({ action: 'incentive', token: 'T-sky' });
  call({ action: 'incentive_unapprove', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('U'),
         reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' });
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  return { out, done, text: JSON.stringify(out), book: W.book(), mails: JSON.stringify(W.mails), fetches: JSON.stringify(W.fetches) };
}
if (!SRC_OLD) {
  skip('screens, store email and a whole close, before against after', 'git cannot show ' + BASELINE + ' here (a shallow clone)');
} else {
  [false, true].forEach((practiceApproved) => {
    const O = world(SRC_OLD, { practiceApproved }), N = world(SRC_NEW, { practiceApproved });
    SCREENS.concat(practiceApproved ? [['the approved practice period', { pp_start: PRACTICE }]] : []).forEach(([label, params]) => {
      /* Twice each: a first load fills caches (the SPIFF copy, the registry list), a second reads them. */
      const o1 = O.screen(params), n1 = N.screen(params), o2 = O.screen(params), n2 = N.screen(params);
      ok((practiceApproved ? 'practice approved — ' : '') + label, o1 === n1 && o2 === n2 && o1.length > 30);
    });
    ['2026-09-14', '2026-09-28', '2026-10-12'].forEach((pp) => {
      const mail = (W) => JSON.stringify(W.get({ action: 'store_email', secret: SECRET, pp_start: pp, show: 'html' }));
      ok((practiceApproved ? 'practice approved — ' : '') + 'the store email for ' + pp, mail(O) === mail(N) && mail(N).length > 200);
    });
    const hist = (W) => JSON.stringify(W.get({ action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14' }));
    ok((practiceApproved ? 'practice approved — ' : '') + 'the deploy-secret incentive_history route', hist(O) === hist(N) && /Beatrice Budd/.test(hist(N)));
  });

  const O = world(SRC_OLD), N = world(SRC_NEW);
  /* Warm the screen's caches on the new side first, so a write path that wrongly read one would show. */
  N.screen({ pp_start: '2026-09-14' }); O.screen({ pp_start: '2026-09-14' });
  const o = closeScenario(O), n = closeScenario(N);
  ok('the scenario really closed a period: rows frozen, then reopened', n.done.ok === true && n.done.written === 6 && n.out[8].ok === true && /"source":"live"/.test(JSON.stringify(n.out[9])));
  ok('send, approve, the retry and the reopen: every reply byte-identical', o.text === n.text);
  ok('every sheet they wrote is byte-identical', o.book === n.book);
  ok('every email they sent is byte-identical (' + JSON.parse(n.mails).length + ' sent)', o.mails === n.mails && JSON.parse(n.mails).length >= 1);
  ok('they made the same live reads of GX Core and SPIFF, in the same order', o.fetches === n.fetches && /incentive_perf/.test(n.fetches) && /action=progress/.test(n.fetches));
  const moved = WRITE_FNS.filter((f) => fnText(SRC_OLD, f) !== fnText(SRC_NEW, f));
  ok('the source of all ' + WRITE_FNS.length + ' write-path functions is unchanged' + (moved.length ? ' — CHANGED: ' + moved.join(', ') : ''),
     moved.length === 0 && WRITE_FNS.every((f) => fnText(SRC_NEW, f)));
}

/* ── 4. A write, then the screen ────────────────────────────────────────────────────────────── */
console.log('\nA write followed at once by a screen load shows the new state');
{
  const W = world(SRC_NEW);
  const pp = '2026-09-28', ack = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' };
  const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
  /* Everything a screen can cache is warm before the write. */
  W.screen({}); W.screen({ pp_start: '2026-09-14' }); W.screen({ pp_start: pp });
  const before = JSON.parse(W.screen({ pp_start: pp }));
  ok('before: the period is open, and listed as open', before.source === 'live' && before.periods.find((x) => x.pp_start === pp).source === 'live');
  const regBefore = W.registry, fetchBefore = W.fetches.length;
  const done = W.get(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  ok('the approval went through', done.ok === true && done.written === 6);
  ok('…reading the registry and GX Core LIVE, not the screen\'s warm cache', W.registry > regBefore && W.fetches.length > fetchBefore);
  const after = JSON.parse(W.screen({ pp_start: pp }));
  ok('the very next load shows it closed, as paid', after.source === 'imported' && after.can_edit === false && after.budtenders.length === 3);
  ok('…and the period list agrees', after.periods.find((x) => x.pp_start === pp).source === 'imported');
  ok('…with the override that was approved', after.budtenders.find((b) => b.employee_id === 'bo_bud').payroll === 40);
  const dflt = JSON.parse(W.screen({}));
  ok('the default screen has moved on to the running period', dflt.source === 'live' && dflt.payPeriod.start === '2026-10-12');
  ok('a second approval is refused — the screen never offered an approved period as open',
     W.get(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('B') }, ack)).ok === false);

  const re = W.get({ action: 'incentive_unapprove', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('U'),
                     reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' });
  ok('the reopen went through', re.ok === true);
  const reopened = JSON.parse(W.screen({ pp_start: pp }));
  ok('the very next load shows it open again, and says it was reopened', reopened.source === 'live' && reopened.workflow.voided === true &&
     reopened.periods.find((x) => x.pp_start === pp).source === 'live');

  /* The registry list is the one thing here that IS cached. */
  const R = world(SRC_NEW);
  R.screen({ pp_start: '2026-09-14' });
  R.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Beatrice Budd-Smith';
  R.g('bustRosterCache_')();          // what every Crew write to identity or attributes does (roster_cache_bust_coverage_test)
  const renamed = JSON.parse(R.screen({ pp_start: '2026-09-14' }));
  ok('a rename made through Crew shows on the next closed-period load', renamed.budtenders[0].full_name === 'Beatrice Budd-Smith');
  ok('…and no figure moved with it', renamed.budtenders[0].payroll === 65 && renamed.budtenders[0].sales === 8210);
  const X = world(SRC_NEW);
  const first = X.screen({ pp_start: '2026-09-14' });
  X.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Changed Elsewhere';
  const stale = X.screen({ pp_start: '2026-09-14' });
  ok('KNOWN LIMIT, pinned: a rename made OUTSIDE Crew is not seen until the cache ages out', stale === first);
  X.cache.delete(X.g('CORE_EMP_CACHE_KEY'));
  ok('…and is seen the moment it does, with nothing else different',
     X.screen({ pp_start: '2026-09-14' }) === first.split('Beatrice Budd').join('Changed Elsewhere'));
}

/* ── 5. Only the screen gets the hand-over ──────────────────────────────────────────────────── */
console.log('\nOnly the screen gets the hand-over');
{
  const W = world(SRC_NEW);
  W.screen({ pp_start: '2026-09-14' });                 // the cache is warm
  W.employees.find((e) => e.employee_id === 'bea_bud').full_name = 'Fresh From Core';
  const c = W.count(() => { W.last = W.get({ action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14' }); });
  ok('the deploy-secret incentive_history route reads the tab and the registry itself, fresh',
     c.reads[HIST] === 1 && c.registry === 1 && W.last.budtenders[0].full_name === 'Fresh From Core');
  const c2 = W.count(() => { W.last = W.get({ action: 'incentive_history', secret: SECRET, pp_start: '2026-09-14', __screen: 'true', rows: '[]', have: '{"__screen":true,"rows":[]}' }); });
  ok('a request cannot supply the hand-over: it still reads fresh, and still finds the period',
     c2.registry === 1 && c2.reads[HIST] === 1 && W.last.ok === true && W.last.budtenders.length === 3);
  const ih = W.g('incentiveHistory_');
  const bad = [{ rows: [] }, { __screen: 'true', rows: [] }, { __screen: true }, { __screen: true, rows: 'x' }, null, true];
  ok('nor can anything but the exact marker AND an array of rows',
     bad.every((have) => { const d = ih({ __internal: true, pp_start: '2026-09-14' }, have); return d.ok === true && d.budtenders.length === 3; }));
  const empty = ih({ __internal: true, pp_start: '2026-09-14' }, { __screen: true, rows: [] });
  ok('rows that do not hold the period answer "no history" — never a half-empty period', empty.ok === false && /no imported history/.test(empty.error));

  const body = (name) => fnText(SRC_NEW, name) || '';
  ok('the router calls incentiveHistory_ with one argument', /case 'incentive_history': return json_\(incentiveHistory_\(p\), p\.callback\);/.test(SRC_NEW));
  const inGet = (body('getIncentive_').match(/\{ __screen: true, rows: /g) || []).length;
  ok('the hand-over is built in getIncentive_ and nowhere else (' + inGet + ' places)',
     inGet === 2 && (SRC_NEW.match(/__screen: *true/g) || []).length === 2);
  const callers = (SRC_NEW.match(/(?<!function )coreEmployeesCached_\(\)/g) || []).length;
  ok('the cached registry list has exactly two readers: the live screen\'s stamp and the closed screen',
     callers === 2 && /coreEmployeesCached_\(\)/.test(body('stampEmployeeIds_')) && /fromScreen \? coreEmployeesCached_\(\) : null/.test(body('incentiveHistory_')));
  const writers = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_', 'incentiveUnapproveLocked_', 'pdfFile_',
                   'saveIncentiveInput_', 'saveAttendanceBatch_', 'perfForWrite_', 'incentiveGoalsBackfill_'];
  ok('no write path mentions the hand-over, the cached list or the screen\'s snapshot',
     writers.every((f) => body(f) && !/__screen|coreEmployeesCached_|snapshot: *true/.test(body(f))));
  ok('there is no cache of the period list or the to-date totals — the history tab is read every load',
     !/cache\.put\([^)]*(periods|to_date|imported)/i.test(body('getIncentive_')) && /var historyRows = readTab_\(HISTORY_TAB, HISTORY_HEADERS\);/.test(body('getIncentive_')));
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\nincentive read speedup: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
