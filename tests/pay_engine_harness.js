/* ─── The pay-write engine, running for real against a fake spreadsheet ─────────────────────────
 *
 * Shared by tests/pay_period_race_test.js (two copies at the SAME time) and
 * tests/pay_request_id_test.js (a copy that lands AFTER its twin). Not a test itself — the push gate
 * runs tests/*_test.js, and this file is deliberately not named that way.
 *
 * CODE_GS=/path/to/Code.gs points it at another copy of the engine — how the request-id test is
 * shown to FAIL against the code from before request ids existed.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(process.env.CODE_GS || (__dirname + '/../apps-script/Code.gs'), 'utf8');

function fnSrc(name, optional) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) { if (optional) return ''; throw new Error('missing ' + name + ' in Code.gs'); }
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i + 1, k + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* `var NAME = …;` — scanned with comments and strings skipped, because HISTORY_HEADERS carries a
   long comment full of apostrophes in the middle of its array. */
function varSrc(name) {
  const i = SRC.indexOf('\nvar ' + name + ' =');
  if (i < 0) throw new Error('missing var ' + name);
  let d = 0;
  for (let k = i + 1; k < SRC.length; k++) {
    const c = SRC[k], n = SRC[k + 1];
    if (c === '/' && n === '*') { k = SRC.indexOf('*/', k + 2) + 1; continue; }
    if (c === '/' && n === '/') { k = SRC.indexOf('\n', k); continue; }
    if (c === "'" || c === '"') { k = SRC.indexOf(c, k + 1); continue; }
    if (c === '[' || c === '{' || c === '(') d++;
    if (c === ']' || c === '}' || c === ')') d--;
    if (c === ';' && d === 0) return SRC.slice(i + 1, k + 1);
  }
  throw new Error('unterminated var ' + name);
}

const REAL = ['incentiveApprove_', 'incentiveSend_', 'incentiveReturn_', 'incentiveUnapprove_',
              'incentiveUnapproveLocked_', 'upsertIncentiveInput_',
              'VOID_HEADERS', 'saveIncentiveInput_', 'inputsFor_', 'historyPeriods_', 'historySheet_',
              'incTab_', 'isPracticePeriod_', 'wfSheet_', 'wfGet_', 'wfSet_', 'wfUnsend_',
              'freezeScheme_', 'schemeFor_', 'sheetOf_', 'readTab_', 'isTruthyFlag_', 'normDate_', 'pad2_',
              'incPayroll_',
              /* One-time request ids (2026-09-14). Optional, so CODE_GS can point at the engine from
                 before they existed and the request-id test can be seen to fail there. */
              'payReqId_', 'payReqCompact_', 'payReqReplay_', 'payReqCached_', 'payReqSeen_',
              'payReqRecord_', 'payReqUpdate_', 'payReqCache_'];
const VARS = ['HISTORY_TAB', 'HISTORY_HEADERS', 'INPUTS_TAB', 'INPUTS_HEADERS', 'WF_TAB', 'WF_HEADERS',
              'VOID_TAB', 'SCHEME_TAB', 'SCHEME_HEADERS'];
const OPTIONAL_VARS = ['PAYREQ_TAB', 'PAYREQ_HEADERS', 'PAYREQ_KEEP_MS', 'PAYREQ_PRUNE_AT'];
const OPTIONAL = /Locked_|upsert|^payReq/;
function varSrcOpt(name) { try { return varSrc(name); } catch (e) { return ''; } }

const HIST = 'crew_incentive_history', WF = 'crew_incentive_workflow',
      INP = 'crew_incentive_inputs', VOID = 'crew_incentive_voided';

/* ── One fresh engine per scenario: real state machine, fake spreadsheet, fake lock ──────────── */
function engine() {
  const E = { mails: [], pdfs: 0, backups: 0, events: [], hook: null, user: 'sky' };

  const sheets = Object.create(null);
  function makeSheet(name) {
    const data = [];
    const sh = {
      data,
      getLastRow() {
        let n = data.length; while (n && data[n - 1].every(v => v === '' || v == null)) n--;
        /* A read of an EMPTY tab never reaches getValues — readTab_ returns at `last < 2` — so the
           first send of a period can only be interleaved here. */
        if (E.hook) E.hook(name, 'lastRow', n);
        return n;
      },
      getLastColumn() { return data.reduce((m, r) => Math.max(m, r.length), 0); },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        const rng = {
          getValue() { const row = data[r - 1] || []; return row[c - 1] == null ? '' : row[c - 1]; },
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = data[r - 1 + i] || [];
              out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] == null ? '' : row[c - 1 + j]));
            }
            /* AFTER the values are captured: execution 1 has read; now execution 2 runs whole. */
            if (E.hook) E.hook(name, r, nr);
            return out;
          },
          setValues(vals) {
            E.events.push('write:' + name);
            for (let i = 0; i < vals.length; i++) {
              while (data.length < r + i) data.push([]);
              for (let j = 0; j < vals[i].length; j++) data[r - 1 + i][c - 1 + j] = vals[i][j];
            }
            return rng;
          },
          setNumberFormat() { return rng; },
          setFontWeight() { return rng; },
        };
        return rng;
      },
      getDataRange() { return sh.getRange(1, 1, Math.max(1, sh.getLastRow()), Math.max(1, sh.getLastColumn())); },
      deleteRows(n, count) {
        E.events.push('delete:' + name); data.splice(n - 1, count);
      },
      deleteRow(n) {
        if (n > data.length) throw new Error('Those rows are out of bounds.');
        E.events.push('delete:' + name); data.splice(n - 1, 1);
      },
      setFrozenRows() {},
    };
    return sh;
  }
  const SS = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n)) };
  E.sheets = sheets;

  const lock = { held: false, refusals: 0 };
  E.lock = lock;
  const LockService = { getScriptLock: () => ({
    tryLock() { if (lock.held) { lock.refusals++; return false; } lock.held = true; E.events.push('lock'); return true; },
    waitLock() { if (lock.held) { lock.refusals++; throw new Error('Lock timeout'); } lock.held = true; E.events.push('lock'); },
    releaseLock() { if (lock.held) E.events.push('unlock'); lock.held = false; },
    hasLock() { return lock.held; },
  }) };
  const SpreadsheetApp = { flush() { E.events.push('flush'); } };
  let uuid = 0;
  const Utilities = { getUuid: () => 'tok-' + (++uuid) + '-x', formatDate: () => '' };
  const MailApp = { sendEmail(o) { E.mails.push({ to: o.to, subject: o.subject, html: o.htmlBody, lockHeld: lock.held }); } };

  const live = pp => ({ ok: true, payPeriod: { start: pp, end: '2026-08-30', current: false },
    budtenders: [{ employee_id: 'e1', name: 'One', bonus: 40, discount: 0.01 },
                 { employee_id: 'e2', name: 'Two', bonus: 25, discount: 0.01 }],
    managers: [], admin: null, spiff: { ok: true }, unmatched: [] });

  const stubs = `
    function crewSheet_() { return { getParent: function () { return SS; } }; }
    function requireCrew_() { return { ok: true, user: E.user, role: 'admin' }; }
    function canEdit_() { return true; }
    function canApprove_() { return true; }
    function approverIds_() { return ['sky']; }
    function noApproverError_() { return 'no approver'; }
    function deploySecretOk_() { return false; }
    function perfForWrite_(pp) { return LIVE(pp); }
    function incentiveBlockers_() { return []; }
    function applySpiffEarnings_() {}
    function practiceSource_() { return ''; }
    function approvalThresholds_() { return { ok: true, T: { v: 1 }, source: 'gxcore', lb_agrees: null, lb_check: 'x' }; }
    function rosterCoverage_() { return { ok: true }; }
    function storeTotals_() { return { state: 'ok' }; }
    function incCalcBud_(b) { return { spiff: null, bonus: b.bonus, hr: 0, payroll: b.bonus }; }
    function incCalcMgr_(m) { return { spiff: null, bonus: 0, hr: 0, payroll: 0 }; }
    function incCalcAdmin_() { return { bonus: 0, hr: 0 }; }
    function ceilingProblems_() { return { over_computed: [], over_override: [] }; }
    function bandWarnings_() { return []; }
    function historyBand_() { return null; }
    function incentiveSpiffReport_() { return {}; }
    function wfMoney_(v) { return '$' + v; }
    function filePayoutPdf_() { E.pdfs++; E.events.push('pdf' + (E.lock.held ? ':locked' : '')); return { ok: true }; }
    function backupCrewSheet_() { E.backups++; return { ok: true }; }
    function wfApprovalEmail_(pp, pre, sender, token) { return 'token=' + token; }
    function wfApproverEmails_() { return ['sky@example.com']; }
    function rosterJoin_() { return { rows: [{ user_id: 'mike' }] }; }
    function accountEmail_() { return 'mike@example.com'; }
    var CREW_URL = 'https://crew.example/';
    var STORE_TZ = 'America/Los_Angeles';
    var Logger = { log: function (m) { E.logs = (E.logs || []).concat([String(m)]); } };
  `;
  const body = stubs + VARS.map(varSrc).join('\n') + '\n' + OPTIONAL_VARS.map(varSrcOpt).join('\n') + '\n' +
    REAL.map(n => fnSrc(n, OPTIONAL.test(n))).join('\n') + '\n' + fnSrc('withPayLock_', true) + '\n' +
    'return { approve: incentiveApprove_, send: incentiveSend_, ret: incentiveReturn_, ' +
    'unapprove: incentiveUnapprove_, save: saveIncentiveInput_, inputsFor: inputsFor_, ' +
    'wfSet: wfSet_, wfGet: wfGet_, historySheet: historySheet_, ' +
    'withPayLock: typeof withPayLock_ === "function" ? withPayLock_ : null };';
  /* An in-memory script cache that can be EMPTIED, because CacheService may evict at any time and
     the request-id guard must still hold when it has. */
  const cache = new Map();
  E.cache = cache;
  const CacheService = { getScriptCache: () => ({
    get: k => cache.has(k) ? cache.get(k) : null,
    put: (k, v) => { cache.set(k, v); },
  }) };
  const api = new Function('E', 'SS', 'LockService', 'SpreadsheetApp', 'Utilities', 'MailApp', 'LIVE', 'CacheService', body)
    (E, SS, LockService, SpreadsheetApp, Utilities, MailApp, live, CacheService);
  Object.assign(E, api);

  /* Fire `second` once, right after the first read of `tab` that returns data rows (r >= 2 or a
     whole-sheet read). Disarmed before it runs, so the second execution's own reads do not re-enter. */
  E.interleave = (tab, second) => {
    E.hook = (name, r, nr) => {
      if (name !== tab || r === 'lastRow' || (r === 1 && nr === 1)) return;
      E.hook = null;
      E.second = second();
    };
  };
  /* A closed period already on file, as there always is live (28 of them). Without it the history
     tab is empty, readTab_ returns before reading anything, and there is no read to interleave at. */
  E.seedClosed = () => {
    const r = new Array(20).fill(''); r[0] = '2026-08-03'; r[3] = 'old'; r[14] = 99;
    E.historySheet('2026-08-03').getRange(2, 1, 1, 20).setValues([r]);
  };
  E.rows = tab => (sheets[tab] ? sheets[tab].data.slice(1).filter(r => r.some(v => v !== '' && v != null)) : []);
  return E;
}


module.exports = { engine, HIST, WF, INP, VOID, SRC, fnSrc };
