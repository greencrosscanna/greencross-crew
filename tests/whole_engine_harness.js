/* ─── The WHOLE shipped engine in a sandbox, over fake Google services ───────────────────────────
 *
 * Shared by tests/incentive_read_speedup_test.js and tests/period_list_speed_test.js. Not a test
 * itself — the push gate runs tests/*_test.js, and this file is deliberately not named that way.
 *
 * `world(src)` loads an entire Code.gs (the shipped one, or the one a commit held) and returns
 * handles to drive it through its real router, `doGet`, with every Google service faked and every
 * read counted: sheet reads per tab, registry reads, kv reads per key, HTTP fetches, mail.
 */
'use strict';
const vm = require('vm');

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
  W.kvCalls = Object.create(null); W.kvTabReads = 0; W.kvCache = new Map(); W.events = [];
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
            if (r >= 2) { W.writes[name] = (W.writes[name] || 0) + 1; W.events.push('write:' + name); }
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
    /* W.events is the ORDER of things: every lock taken and released, every flush, every sheet write
       and read by tab, every fetch and every email — what "the same lock order" is compared on. */
    SpreadsheetApp: { openById: () => book, create: () => { W.created++; return book; }, flush() { W.events.push('flush'); } },
    LockService: { getScriptLock: () => ({ tryLock: () => { W.events.push('lock'); return true; }, waitLock() { W.events.push('lock'); },
                                           releaseLock() { W.events.push('unlock'); }, hasLock: () => true }) },
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
        if (tok === 'T-shawn') return { ok: true, user: 'shawn', role: 'editor' };   // the backup approver
        return { ok: false, error: 'Auth required' };
      },
      verifySession: () => ({ ok: false }),
      roleCanEdit: (role) => ['admin', 'editor', 'director', 'manager'].indexOf(String(role)) >= 0,
      /* GX Core's getKv, as the library really behaves (gx_core.gs): each key is kept for 60 seconds
         in the caller's script cache — a miss included — and a key that is not there costs a read of
         the WHOLE kv tab. Calls are counted per key, and tab reads counted and (optionally) timed. */
      getKv: (k) => {
        const key = String(k == null ? '' : k).trim();
        W.kvCalls[key] = (W.kvCalls[key] || 0) + 1;
        const hit = W.kvCache.get(key);
        if (hit && hit.until > W.clock.t) return hit.v;
        W.kvTabReads++; W.clock.t += W.clock.perKvTab || 0;
        const v = kv[key] == null ? null : kv[key];
        W.kvCache.set(key, { v, until: W.clock.t + 60000 });
        return v;
      },
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
  /* The workflow tab as it really is: a row for every period that has been through an approval. An
     empty tab is never read at all (readTab_ stops at the header), which would hide a repeated read. */
  seed(g('WF_TAB'), g('WF_HEADERS'), CLOSED.map((pp) => g('WF_HEADERS').map((h) =>
    (h === 'pp_start' ? pp : h === 'status' ? 'approved' : h === 'decided_by' ? 'sky' : h === 'decided_at' ? '2026-09-29T17:00:00.000Z' : ''))));
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
  /* What one piece of work read: sheet reads per tab, registry reads, kv calls per key, and how many
     of those kv calls missed the 60-second cache and read the whole kv tab. */
  W.count = (fn) => { const r0 = Object.assign({}, W.reads), e0 = W.registry, k0 = Object.assign({}, W.kvCalls), t0 = W.kvTabReads; fn();
    const d = {}; Object.keys(W.reads).forEach((k) => { if ((W.reads[k] || 0) !== (r0[k] || 0)) d[k] = W.reads[k] - (r0[k] || 0); });
    const kd = {}; Object.keys(W.kvCalls).forEach((k) => { if ((W.kvCalls[k] || 0) !== (k0[k] || 0)) kd[k] = W.kvCalls[k] - (k0[k] || 0); });
    return { reads: d, registry: W.registry - e0, kv: kd, kvTabReads: W.kvTabReads - t0 }; };
  W.book = () => { const o = {}; Object.keys(sheets).sort().forEach((n) => { if (n !== 'crew_request_stats') o[n] = sheets[n].data; }); return JSON.stringify(o); };
  /* Withhold the hand-over: incentiveHistory_ is called with ONE argument, as the route calls it. */
  W.forceSlow = () => vm.runInContext('var __ih = incentiveHistory_; incentiveHistory_ = function (p) { return __ih(p); };', sandbox);
  return W;
}

/* One whole close through the real router: Mike checks and sends, Sky looks and approves, a retry of
   the approval lands, the screens are read, Sky reopens. Returns every reply and everything written. */
function closeScenario(W) {
  const pp = '2026-09-28', ack = { coverage_ok: 'yes', totals_ok: 'yes', spiff_unavailable: 'yes' };
  const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);
  const out = [], counts = [];
  const call = (p) => { let d = null; const c = W.count(() => { d = W.get(p); }); delete d.timings; out.push(d);
                        counts.push({ action: p.action, reads: c.reads, registry: c.registry, kv: c.kv }); return d; };
  call(Object.assign({ action: 'incentive_approve', token: 'T-mike', pp_start: pp }, ack));
  call(Object.assign({ action: 'incentive_send', token: 'T-mike', pp_start: pp, request_id: rid('S') }, ack));
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  call({ action: 'incentive', token: 'T-shawn', pp_start: pp });
  call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp }, ack));
  const done = call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  call(Object.assign({ action: 'incentive_approve', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('A') }, ack));
  call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  call({ action: 'incentive', token: 'T-sky' });
  const reopened = call({ action: 'incentive_unapprove', token: 'T-sky', pp_start: pp, confirm: 'yes', request_id: rid('U'),
         reason: 'Bo was paid forty dollars by hand and the record must say so before it is frozen.' });
  const after = call({ action: 'incentive', token: 'T-sky', pp_start: pp });
  return { out, done, reopened, after, text: JSON.stringify(out), book: W.book(), mails: JSON.stringify(W.mails), fetches: JSON.stringify(W.fetches),
           events: W.events.slice(), counts,
           /* What the WRITE requests alone read — every sheet, registry and kv read they made. */
           writeReads: JSON.stringify(counts.filter((c) => c.action !== 'incentive')) };
}

module.exports = { NOW, SECRET, T, EMPLOYEES, STORES, PERIODS, CLOSED, PRACTICE, corePerf, historyRows, world, closeScenario };
