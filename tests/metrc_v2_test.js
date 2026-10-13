#!/usr/bin/env node
/* ─── The Metrc connector: v2 reads, GET-only to production, and the permit-date sync ────────────
 *
 *   RUN:  node tests/metrc_v2_test.js     (from the repo root; no deps, no network, no keys)
 *
 * WHY THIS EXISTS
 * Metrc, in writing, 2026-10-12: "v2 keys can not use v1 calls." The connector had been written
 * against /employees/v1/, which returned a bare array and carried per-person active flags. v2
 * wraps every list as {Data, TotalPages, …}, pages it, and has NO IsActive and NO Status. Each of
 * those is a way to be wrong without erroring:
 *
 *   1. A wrapped response read as an array has no rows, and "nobody in Metrc" looks like good news.
 *   2. A second page nobody asked for is people silently missing from every answer.
 *   3. A check for a flag that no longer exists goes on looking like a check.
 *   4. Production Metrc must never receive a write from Crew. Dutchie is the only system that
 *      writes Green Cross data there; a second writer is duplicate records and an OLCC problem.
 *   5. The sync writes permit expiration dates into a payroll app's roster at 5am with nobody
 *      watching, so: matched on permit number, never a blanked column, nothing on a partial read,
 *      nothing the second time, and no staff names in a log.
 *
 * EVERY NAME, PERMIT NUMBER AND DATE BELOW IS INVENTED. The real response is PII and none of it
 * belongs in a repo.
 */
'use strict';
const fs = require('fs');
const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));
const eq = (l, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('  ✓ ' + l);
  else { fail++; console.log('  ✗ ' + l + '\n      got  ' + g + '\n      want ' + w); }
};
function throws(fn) { try { fn(); return ''; } catch (e) { return String(e.message || e) || 'threw'; } }

const PROD = 'https://api-or.metrc.com';
const SANDBOX = 'https://sandbox-api-or.metrc.com';

/* Everything a test can move. Reset per block. */
const T = {
  props: {}, fetches: [], respond: null,
  attrs: {}, writes: [], busts: 0, writeThrowsFor: null, afterFirstRead: null, reads: 0,
  identity: [], auth: { ok: true, user: 'tester', role: 'editor' },
  joined: { rows: [] }, scan: { ok: true, dutchie_active_people: 3, on_the_roster: 3, new_since_last_scan: [] },
  logs: [],
};
function reset(props) {
  T.props = Object.assign({ GX_DEPLOY_SECRET: 'deploy-secret-for-tests' }, props || {});
  T.fetches = []; T.respond = null; T.attrs = {}; T.writes = []; T.busts = 0;
  T.writeThrowsFor = null; T.afterFirstRead = null; T.reads = 0;
  T.identity = []; T.auth = { ok: true, user: 'tester', role: 'editor' };
  T.joined = { rows: [] }; T.logs = [];
}
const CONNECTED = { METRC_VENDOR_KEY: 'vendor-key', METRC_USER_KEY: 'user-key', METRC_LICENSES: 'LIC-A,LIC-B' };

const stubs = {
  SpreadsheetApp: {}, DriveApp: {}, HtmlService: {}, ContentService: {},
  UrlFetchApp: { fetch(url, opts) {
    T.fetches.push({ url: url, method: String((opts && opts.method) || 'get').toLowerCase(),
                     hasBody: !!(opts && (opts.payload != null || opts.contentType != null)) });
    const r = T.respond ? T.respond(url, opts) : { code: 200, body: '{"Data":[],"TotalPages":1,"TotalRecords":0}' };
    return { getResponseCode: () => r.code, getContentText: () => r.body, getAllHeaders: () => ({}) };
  } },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {},
  Logger: { log(s) { T.logs.push(String(s)); } },
  GXCore: { resolveStore: () => null,
            getEmployees: () => T.identity,
            requireAuth: () => T.auth,
            roleCanEdit: (role) => ['admin', 'editor', 'director', 'manager'].indexOf(role) >= 0 },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in T.props ? T.props[k] : null),
    setProperty(k, v) { T.props[k] = v; }, deleteProperty(k) { delete T.props[k]; } }) },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10),
               base64Encode: (s) => Buffer.from(String(s)).toString('base64') },
  __T: T,
};
/* The sheet and the Dutchie scan are swapped for fakes INSIDE the engine's own scope, so the code
   under test is the real connector, planner, run and nightly wrapper, unmodified. */
const TAIL = `
;readAttrs_ = function () {
  __T.reads++;
  var copy = JSON.parse(JSON.stringify(__T.attrs));
  if (__T.reads === 1 && __T.afterFirstRead) __T.afterFirstRead();
  return copy;
};
writeAttrs_ = function (rec) {
  if (__T.writeThrowsFor && rec.employee_id === __T.writeThrowsFor) throw new Error('sheet said no');
  __T.writes.push(JSON.parse(JSON.stringify(rec)));
  __T.attrs[rec.employee_id] = JSON.parse(JSON.stringify(rec));
};
bustRosterCache_ = function () { __T.busts++; };
rosterJoin_ = function () { return __T.joined; };
dutchieNewHireScan_ = function () { return __T.scan; };
return { metrcGet_, metrcGetAll_, metrcAllEmployees_, metrcHealth_,
         metrcAccessAudit_, metrcPermitPlan_, metrcPermitSyncRun_, metrcPermitSync_, metrcPermitKey_,
         metrcDay_, nightlyMetrcPermitSync_, nightlyDutchieScan };`;
const names = Object.keys(stubs);
const C = new Function(...names, SRC + TAIL)(...names.map(n => stubs[n]));

function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── synthetic Metrc ─────────────────────────────────────────────────────────────────────────── */
const emp = (name, permit, end, start) => ({
  FullName: name,
  License: { Number: permit, EmployeeLicenseNumber: permit, StartDate: start || '2021-01-01',
             EndDate: end, LicenseType: 'Marijuana Worker Permit' },
  IsOwner: false, IsManager: false, IsIndustryAdmin: false });
const page = (rows, pageNo, totalPages, totalRecords) => ({ code: 200, body: JSON.stringify({
  Data: rows, Total: totalRecords, TotalRecords: totalRecords, PageSize: rows.length,
  RecordsOnPage: rows.length, Page: pageNo, CurrentPage: pageNo, TotalPages: totalPages }) });
const qp = (url, k) => { const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url); return m ? decodeURIComponent(m[1]) : null; };
/* licenses -> list of rows; served one page at a time, `per` rows per page. */
function serve(byLicense, per) {
  T.respond = (url) => {
    const lic = qp(url, 'licenseNumber');
    const rows = byLicense[lic];
    if (!rows) return { code: 500, body: 'boom' };
    const size = per || Math.max(1, rows.length);
    const n = Number(qp(url, 'pageNumber') || 1);
    const pages = Math.max(1, Math.ceil(rows.length / size));
    return page(rows.slice((n - 1) * size, n * size), n, pages, rows.length);
  };
}

console.log('\nv2 lists are unwrapped, and every page is read');
{
  reset(CONNECTED);
  const rows = [emp('Avery Stone', 'AB12CD', '2029-05-19'), emp('Blake Rivers', 'EF34GH', '2027-01-02'),
                emp('Casey Lane', 'JK56LM', '2028-03-04'), emp('Devon Marsh', 'NP78QR', '2030-07-08'),
                emp('Emery Frost', 'ST90UV', '2026-12-31')];
  serve({ 'LIC-A': rows }, 2);
  const got = C.metrcGetAll_('/employees/v2/', { licenseNumber: 'LIC-A' });
  eq('all five rows across three pages', got.map(r => r.FullName), rows.map(r => r.FullName));
  eq('asked for pages 1, 2 and 3 in order', T.fetches.map(f => qp(f.url, 'pageNumber')), ['1', '2', '3']);
  ok('every page carried the license number', T.fetches.every(f => qp(f.url, 'licenseNumber') === 'LIC-A'));
  ok('the path is v2', T.fetches.every(f => f.url.indexOf(PROD + '/employees/v2/?') === 0));

  reset(CONNECTED);
  T.respond = () => ({ code: 200, body: JSON.stringify([emp('Avery Stone', 'AB12CD', '2029-05-19')]) });
  ok('a bare array (the v1 shape) THROWS rather than reading as rows or as nobody',
     /unexpected shape/.test(throws(() => C.metrcGetAll_('/employees/v2/', { licenseNumber: 'LIC-A' }))));

  T.respond = () => ({ code: 200, body: '{"Message":"something else"}' });
  ok('an object with no Data list throws', /unexpected shape/.test(throws(() => C.metrcGetAll_('/x/v2/', {}))));

  T.respond = (url) => page([emp('Avery Stone', 'AB12CD', '2029-05-19')], Number(qp(url, 'pageNumber')), 1, 4);
  ok('fewer rows than Metrc said exist is an incomplete read, and throws',
     /incomplete read/.test(throws(() => C.metrcGetAll_('/x/v2/', {}))));

  reset(CONNECTED);
  T.respond = (url) => page([emp('Avery Stone', 'AB12CD', '2029-05-19')], Number(qp(url, 'pageNumber')), 9999, null);
  ok('a runaway page count refuses a partial list', /refusing a partial list/.test(throws(() => C.metrcGetAll_('/x/v2/', {}))));
  ok('…and stops asking at the cap', T.fetches.length === 50);

  ok('no v1 employees path is left in the engine', SRC.indexOf('/employees/v1/') < 0);
}

console.log('\nNo active flag: listed on a license is the only signal');
{
  reset(CONNECTED);
  const shared = emp('Avery Stone', 'AB12CD', '2029-05-19T00:00:00');
  serve({ 'LIC-A': [shared, emp('Blake Rivers', 'EF34GH', '2027-01-02')],
          'LIC-B': [shared, emp('Casey Lane', 'JK56LM', '2028-03-04')] });
  const m = C.metrcAllEmployees_();
  eq('three people from four rows, deduped on permit number', [Object.keys(m.people).length, m.rows_seen], [3, 4]);
  eq('a person on two licenses lists both', m.people.AB12CD.licenses, ['LIC-A', 'LIC-B']);
  eq('a time suffix on the date is dropped, the day kept as written', m.people.AB12CD.end, '2029-05-19');
  ok('no record carries an `active` field any more',
     Object.keys(m.people).every(k => !('active' in m.people[k])));
  const ALL = fnSrc('metrcAllEmployees_');
  ok('the reader looks at neither IsActive nor Status', !/\.IsActive|\.Status\b/.test(ALL));
  ok('the audit does not read an active flag either', !/\.active\b/.test(fnSrc('metrcAccessAudit_')));

  reset(CONNECTED);
  serve({ 'LIC-A': [emp('Avery Stone', 'AB12CD', '2029-05-19')] });        // LIC-B answers 500
  const partial = C.metrcAllEmployees_();
  ok('a license that fails is named in errors, not swallowed',
     partial.errors.length === 1 && /^LIC-B: /.test(partial.errors[0]));

  eq('metrcDay_ keeps a bare day', C.metrcDay_('2027-11-30'), '2027-11-30');
  eq('metrcDay_ refuses a non-date rather than guessing', [C.metrcDay_(''), C.metrcDay_(null), C.metrcDay_('soon'), C.metrcDay_('2027-13-40')], ['', '', '', '']);
}

console.log('\nThe access audit under v2');
{
  reset(CONNECTED);
  serve({ 'LIC-A': [emp('Avery Stone', 'AB12CD', '2029-05-19')], 'LIC-B': [emp('Blake Rivers', 'EF34GH', '2027-01-02')] });
  T.joined = { rows: [
    { name: 'Avery Stone', retired: true, permit_number: 'ab12cd' },      // still listed, found by permit
    { name: 'Blake Q. Rivers', retired: true, permit_number: '' },        // still listed, found by name
    { name: 'Gone Person', retired: true, permit_number: 'ZZ99ZZ' },      // on no license
    { name: 'Casey Lane', retired: false, permit_number: 'JK56LM' } ] };
  const a = C.metrcAccessAudit_({ secret: 'deploy-secret-for-tests' });
  eq('retired and still listed are named', a.still_active_in_metrc.map(x => x.name), ['Avery Stone', 'Blake Q. Rivers']);
  eq('retired and on no license is counted', a.retired_and_absent_from_metrc, 1);
  ok('a full read is not marked partial', a.partial_read === false);
  ok('the v1-only "properly_deactivated" count is gone', !('properly_deactivated' in a));

  reset(CONNECTED);
  serve({ 'LIC-A': [] });
  T.joined = { rows: [{ name: 'Gone Person', retired: true, permit_number: 'ZZ99ZZ' }] };
  const p = C.metrcAccessAudit_({ secret: 'deploy-secret-for-tests' });
  ok('a failed license makes the result say INCOMPLETE', p.partial_read === true && /INCOMPLETE/.test(p.note));

  reset(Object.assign({}, CONNECTED, { METRC_BASE: SANDBOX }));
  ok('the audit still refuses the sandbox', /SANDBOX/.test(C.metrcAccessAudit_({ secret: 'deploy-secret-for-tests' }).error));
}

console.log('\nProduction Metrc is GET-only');
{
  const GET = fnSrc('metrcGet_');
  ok("metrcGet_ hardcodes method 'get'", /method:\s*'get'/.test(GET));
  ok('metrcGet_ takes no method argument', /^function metrcGet_\(path, params\)/.test(GET));
  ok('metrcGet_ cannot post, put or delete', !/'(post|put|delete|patch)'/i.test(GET));

  const S = { secret: 'deploy-secret-for-tests' };

  /* THE SANDBOX BOOTSTRAP TOOLS ARE GONE (2026-10-12), and this is what keeps them gone. They held
     the only POSTs in the connector; first they were fenced to the sandbox host, then, with the
     evaluation finished, removed. What is pinned now is the stronger property: there is no code
     path in the engine that can send any Metrc host anything but a GET. */
  ok('the metrc_setup and metrc_probe routes are gone',
     !/case\s+'metrc_setup'/.test(SRC) && !/case\s+'metrc_probe'/.test(SRC));
  ok('…and so are their functions and the guard that only they used',
     !/function metrcSandboxSetup_|function metrcAuthProbe_|function metrcSandboxOnly_|function metrcIsSandbox_/.test(SRC));
  ok('nothing in the engine names the sandbox setup endpoint', SRC.indexOf('/sandbox/v2/') < 0);
  ok('nothing in the engine writes a Metrc key into Script Properties',
     !/setProperty\(\s*'METRC_(USER|VENDOR)_KEY'/.test(SRC));

  const secStart = SRC.indexOf('// ─── METRC connector (Oregon)');
  const secEnd = SRC.indexOf('// ─── Review queue');
  const metrcSection = SRC.slice(secStart, secEnd);
  const code = metrcSection.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the connector section was found', secStart > 0 && secEnd > secStart);
  eq('exactly one fetch in the whole connector, and it is inside metrcGet_',
     [(code.match(/UrlFetchApp\.fetch/g) || []).length, (GET.match(/UrlFetchApp\.fetch/g) || []).length], [1, 1]);
  ok('no fetchAll either', !/UrlFetchApp\.fetchAll/.test(code));
  ok('no write method anywhere in the connector', !/method:\s*'(post|put|delete|patch)'/i.test(code));
  ok('no request body anywhere in the connector', !/\bpayload\s*:/.test(code) && !/\bcontentType\s*:/.test(code));

  /* …and nothing OUTSIDE the connector can reach Metrc: the host, the base and the credentials are
     named nowhere else in the engine, so no other fetch has an address or a key to use. */
  const outside = (SRC.slice(0, secStart) + SRC.slice(secEnd)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no Metrc host outside the connector', !/metrc\.com/i.test(outside));
  ok('the base and the keys are read nowhere else',
     !/METRC_BASE|METRC_VENDOR_KEY|METRC_USER_KEY|metrcCreds_\(/.test(outside));
  ok('metrcGet_ is called nowhere else', !/metrcGet_\(|metrcGetAll_\(/.test(outside));

  /* Everything the connector can send to production, exercised end to end. */
  reset(CONNECTED);
  serve({ 'LIC-A': [emp('Avery Stone', 'AB12CD', '2029-05-19')], 'LIC-B': [emp('Blake Rivers', 'EF34GH', '2027-01-02')] });
  T.identity = [{ employee_id: 'avery_stone', full_name: 'Avery Stone', status: 'active' }];
  T.attrs = { avery_stone: { employee_id: 'avery_stone', permit_number: 'AB12CD', permit_expires: '2026-01-01' } };
  C.metrcHealth_(S); C.metrcAccessAudit_(S); C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  C.nightlyMetrcPermitSync_();
  ok('health, audit, sync and the nightly run made requests', T.fetches.length >= 7);
  ok('every one of them was a GET', T.fetches.every(f => f.method === 'get'));
  ok('every one of them was a v2 employees read', T.fetches.every(f => f.url.indexOf(PROD + '/employees/v2/?') === 0));
  ok('none of them carried a body', T.fetches.every(f => f.hasBody === false));
}

console.log('\nmetrc_health reads the v2 envelope');
{
  reset(CONNECTED);
  serve({ 'LIC-A': [emp('Avery Stone', 'AB12CD', '2029-05-19'), emp('Blake Rivers', 'EF34GH', '2027-01-02')] });
  const h = C.metrcHealth_({ secret: 'deploy-secret-for-tests' });
  eq('ok, with the record count and the field names', [h.ok, h.records, h.total_records, h.api],
     [true, 2, 2, 'v2']);
  eq('reports shape only', h.license_fields, ['EmployeeLicenseNumber', 'EndDate', 'LicenseType', 'Number', 'StartDate']);
  ok('no name, permit number or date in the health answer',
     !/Avery|Blake|AB12CD|EF34GH|2029-05-19/.test(JSON.stringify(h)));
  T.respond = () => ({ code: 200, body: '[]' });
  const bad = C.metrcHealth_({ secret: 'deploy-secret-for-tests' });
  ok('a v1-shaped answer is reported as a failure, not as zero records', bad.ok === false && /v1 shape/.test(bad.error));
}

console.log('\nThe plan: who gets which date');
{
  const person = (id, name, status) => ({ employee_id: id, full_name: name, status: status || 'active' });
  const people = {
    AB12CD: { permit: 'AB12CD', name: 'Avery Stone', end: '2029-05-19', licenses: ['LIC-A'] },
    EF34GH: { permit: 'EF34GH', name: 'Blake Rivers', end: '2027-01-02', licenses: ['LIC-A'] },
    JK56LM: { permit: 'JK56LM', name: 'Casey Lane', end: '2028-03-04', licenses: ['LIC-A'] },
    NP78QR: { permit: 'NP78QR', name: 'Devon Marsh', end: '', licenses: ['LIC-A'] },
    ST90UV: { permit: 'ST90UV', name: 'Emery Frost', end: '2026-12-31', licenses: ['LIC-A'] },
    WX11YZ: { permit: 'WX11YZ', name: 'Jordan Vale', end: '2031-02-02', licenses: ['LIC-B'] },
    QQ22RR: { permit: 'QQ22RR', name: 'Jordan Vale', end: '2031-09-09', licenses: ['LIC-B'] },
    TT33UU: { permit: 'TT33UU', name: 'Morgan Reed', end: '2030-10-10', licenses: ['LIC-B'] },
    VV44WW: { permit: 'VV44WW', name: 'Stranger Danger', end: '2030-01-01', licenses: ['LIC-B'] },
  };
  const identity = [
    person('avery_stone', 'Avery Stone'), person('blake_rivers', 'Blake Rivers'),
    person('casey_lane', 'Casey Lane'), person('devon_marsh', 'Devon Marsh'),
    person('emery_frost', 'Emery Frost'), person('finley_ward', 'Finley Ward'),
    person('jordan_vale', 'Jordan Vale'), person('morgan_reed', 'Morgan Reed'),
    person('morgan_reid', 'Morgann Reed'), person('quinn_hale', 'Quinn Hale'),
    person('riley_gone', 'Riley Gone', 'retired'), person('old_tombstone', 'Old Tombstone', 'merged'),
  ];
  const attrs = {
    avery_stone: { permit_number: ' ab12cd ', permit_expires: '2026-05-19' },   // renewed: later
    blake_rivers: { permit_number: 'EF34GH', permit_expires: '2027-01-02' },    // agrees
    casey_lane: { permit_number: 'JK56LM', permit_expires: '' },                // empty: filled
    devon_marsh: { permit_number: 'NP78QR', permit_expires: '2027-07-07' },     // Metrc has no date
    emery_frost: { permit_number: 'ST90UV', permit_expires: '2027-06-30' },     // Metrc is EARLIER
    finley_ward: { permit_number: 'ZZ00ZZ', permit_expires: '2027-01-01' },     // number not in Metrc
    jordan_vale: { permit_number: '', permit_expires: '' },                     // two Metrc candidates
    morgan_reed: { permit_number: '', permit_expires: '' },                     // } both answer to the
    morgan_reid: { permit_number: '', permit_expires: '' },                     // } same Metrc person
    riley_gone: { permit_number: 'VV44WW', permit_expires: '2020-01-01' },      // retired
  };
  const plan = C.metrcPermitPlan_(identity, attrs, people);
  const by = (id) => plan.changes.filter(c => c.employee_id === id)[0];

  eq('active people counted, retired and merged left out', plan.active_people, 10);
  eq('a renewal moves the date forward, matched on permit number despite case and spaces',
     [by('avery_stone').from, by('avery_stone').to, by('avery_stone').matched_by, by('avery_stone').direction],
     ['2026-05-19', '2029-05-19', 'permit', 'later']);
  ok('a date that already agrees is not a change', !by('blake_rivers') && plan.agree === 1);
  eq('an empty date is filled', [by('casey_lane').to, by('casey_lane').direction], ['2028-03-04', 'filled']);
  ok('an empty Metrc date NEVER replaces a date Crew holds', !by('devon_marsh') && plan.metrc_no_date.includes('Devon Marsh'));
  eq('an earlier Metrc date is applied and flagged', by('emery_frost').direction, 'earlier');
  ok('a number Metrc does not know is reported, not name-matched around', !by('finley_ward') && plan.not_in_metrc.includes('Finley Ward'));
  ok('two Metrc candidates for one person: left alone and named', !by('jordan_vale') && plan.ambiguous.includes('Jordan Vale'));
  ok('two roster people answering to one Metrc person: both left alone',
     !by('morgan_reed') && !by('morgan_reid') && plan.ambiguous.includes('Morgan Reed') && plan.ambiguous.includes('Morgann Reed'));
  ok('nobody in Metrc under that name: reported', plan.no_permit_no_match.includes('Quinn Hale'));
  ok('a retired person is never written, even with a matching permit', !by('riley_gone'));
  ok('Metrc people with no active roster match are listed', plan.in_metrc_not_on_active_roster.includes('Stranger Danger'));
  eq('exactly the three expected changes', plan.changes.map(c => c.employee_id).sort(), ['avery_stone', 'casey_lane', 'emery_frost']);

  const solo = C.metrcPermitPlan_([person('uma_frey', 'Uma Frey')], { uma_frey: { permit_number: '' } },
    { HH55JJ: { permit: 'HH55JJ', name: 'Uma Frey', end: '2030-04-04', licenses: ['LIC-A'] } });
  eq('no number on file and exactly one name match: matched by name', [solo.changes.length, solo.changes[0].matched_by, solo.matched_by_name], [1, 'name', ['Uma Frey']]);

  const taken = C.metrcPermitPlan_(
    [person('uma_frey', 'Uma Frey'), person('uma_frei', 'Uma Frei')],
    { uma_frey: { permit_number: 'HH55JJ', permit_expires: '2030-04-04' }, uma_frei: { permit_number: '' } },
    { HH55JJ: { permit: 'HH55JJ', name: 'Uma Frey', end: '2030-04-04', licenses: ['LIC-A'] } });
  ok('a Metrc person already claimed by permit number is not offered to a name match',
     taken.changes.length === 0 && taken.no_permit_no_match.includes('Uma Frei'));

  eq('permit keys: case, spaces and leading zeros on an all-digit number',
     [C.metrcPermitKey_(' ab-12 cd '), C.metrcPermitKey_('001234'), C.metrcPermitKey_(1234), C.metrcPermitKey_('0A12'), C.metrcPermitKey_('')],
     ['AB12CD', '1234', '1234', '0A12', '']);
}

console.log('\nThe run: preview, commit, and nothing the second time');
{
  const S = { secret: 'deploy-secret-for-tests' };
  const setup = () => {
    reset(CONNECTED);
    const everyone = emp('Avery Stone', 'AB12CD', '2029-05-19');
    serve({ 'LIC-A': [everyone, emp('Blake Rivers', 'EF34GH', '2027-01-02')],
            'LIC-B': [everyone, emp('Casey Lane', 'JK56LM', '2028-03-04')] });
    T.identity = [{ employee_id: 'avery_stone', full_name: 'Avery Stone', status: 'active' },
                  { employee_id: 'blake_rivers', full_name: 'Blake Rivers', status: 'active' },
                  { employee_id: 'casey_lane', full_name: 'Casey Lane', status: 'active' }];
    T.attrs = {
      avery_stone: { employee_id: 'avery_stone', name_key: 'avery_stone', full_name: 'Avery Stone',
                     shirt_size: 'M', birthday: '03-14', work_anniversary: '2022-02-02', employee_number: '00',
                     wage: '21.50', permit_number: 'AB12CD', permit_granted: '2021-05-19',
                     permit_expires: '2026-05-19', permit_status: 'Active', pay_type: 'hourly',
                     digest_opt_in: 'yes', middle_initial: 'Q', swipeclock_code: 'W-7', is_floater: 'yes',
                     updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'someone' },
      blake_rivers: { employee_id: 'blake_rivers', full_name: 'Blake Rivers', permit_number: 'EF34GH', permit_expires: '2027-01-02' },
      casey_lane: { employee_id: 'casey_lane', full_name: 'Casey Lane', permit_number: 'JK56LM', permit_expires: '2028-03-04' } };
  };

  setup();
  const before = JSON.stringify(T.attrs);
  const pre = C.metrcPermitSync_(S);
  eq('with no confirm it previews', [pre.ok, pre.mode, pre.to_change, pre.written], [true, 'preview', 1, 0]);
  ok('a preview writes nothing and busts nothing', T.writes.length === 0 && T.busts === 0 && JSON.stringify(T.attrs) === before);
  eq('the preview names the change for the caller', pre.changes, [{ name: 'Avery Stone', from: '2026-05-19', to: '2029-05-19', matched_by: 'permit', direction: 'later' }]);

  const run = C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  eq('confirm=yes writes the one row that differs', [run.ok, run.mode, run.written, T.writes.length, run.already_agree], [true, 'commit', 1, 1, 2]);
  const w = T.writes[0];
  eq('the new date is on the row', [w.employee_id, w.permit_expires], ['avery_stone', '2029-05-19']);
  const carried = ['name_key', 'full_name', 'shirt_size', 'birthday', 'work_anniversary', 'employee_number', 'wage',
                   'permit_number', 'permit_granted', 'permit_status', 'pay_type', 'digest_opt_in', 'middle_initial',
                   'swipeclock_code', 'is_floater'];
  const orig = JSON.parse(before).avery_stone;
  ok('every other column is carried exactly, including employee number "00"',
     carried.every(k => w[k] === orig[k]) && w.employee_number === '00');
  ok('the stored name is not rewritten', w.full_name === 'Avery Stone');
  ok('the row says who changed it', w.updated_by === 'metrc-sync' && w.updated_at !== orig.updated_at);
  ok('the roster cache is busted once', T.busts === 1);

  const again = C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  eq('a second run changes nothing', [again.ok, again.to_change, again.written, T.writes.length, T.busts, again.already_agree], [true, 0, 0, 1, 1, 3]);

  setup();
  serve({ 'LIC-A': [emp('Avery Stone', 'AB12CD', '2029-05-19')] });     // LIC-B fails
  const part = C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  ok('one unreadable license: nothing is written at all', part.ok === false && T.writes.length === 0 && /nothing was changed/.test(part.error));

  setup();
  serve({ 'LIC-A': [], 'LIC-B': [] });
  ok('Metrc returning nobody changes nothing', C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S)).ok === false && T.writes.length === 0);

  setup(); T.identity = [];
  ok('an empty GX Core read changes nothing', C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S)).ok === false && T.writes.length === 0);

  setup(); T.props.METRC_BASE = SANDBOX;
  const sb = C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  ok('the sandbox is never synced from, and is not even read', sb.skipped === 'sandbox' && T.fetches.length === 0 && T.writes.length === 0);

  setup(); delete T.props.METRC_USER_KEY;
  ok('no keys: skipped, nothing fetched', C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S)).skipped === 'no_keys' && T.fetches.length === 0);
  setup(); delete T.props.METRC_LICENSES;
  ok('no licenses: skipped, nothing fetched', C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S)).skipped === 'no_licenses' && T.fetches.length === 0);

  /* A person edits the roster while Metrc is being read. */
  setup();
  T.afterFirstRead = () => { T.attrs.avery_stone.wage = '23.00'; };
  C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  ok('an edit made during the run is carried, not overwritten by the earlier read', T.writes[0].wage === '23.00');

  setup();
  T.afterFirstRead = () => { T.attrs.avery_stone.permit_number = 'XX00XX'; };
  const moved = C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  ok('a permit number changed during the run: the row is left alone and named',
     T.writes.length === 0 && moved.skipped_changed_underneath.includes('Avery Stone'));

  setup(); T.writeThrowsFor = 'avery_stone';
  const failed = C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  ok('a row that cannot be written is named and the run is not ok', failed.ok === false && failed.failed.includes('Avery Stone') && T.busts === 0);

  /* A matched person with no attribute row yet gets one, built from the roster's own name. */
  reset(CONNECTED);
  serve({ 'LIC-A': [emp('Uma Frey', 'HH55JJ', '2030-04-04')], 'LIC-B': [] });
  T.identity = [{ employee_id: 'uma_frey', full_name: 'Uma Frey', status: 'active' }];
  T.attrs = {};
  C.metrcPermitSync_(Object.assign({ confirm: 'yes' }, S));
  eq('new attribute row: id, name key, name and the date, nothing invented',
     [T.writes[0].employee_id, T.writes[0].name_key, T.writes[0].full_name, T.writes[0].permit_expires, 'permit_number' in T.writes[0]],
     ['uma_frey', 'uma_frey', 'Uma Frey', '2030-04-04', false]);

  /* Who may run it. */
  setup(); T.auth = { ok: false, error: 'Auth required' };
  ok('no secret and no session: refused before Metrc is called', C.metrcPermitSync_({ confirm: 'yes' }).ok === false && T.fetches.length === 0);
  setup(); T.auth = { ok: true, user: 'viewer', role: 'viewer' };
  ok('a read-only role cannot write', /read-only/.test(C.metrcPermitSync_({ token: 't', confirm: 'yes' }).error) && T.writes.length === 0 && T.fetches.length === 0);
  ok('…but can preview', C.metrcPermitSync_({ token: 't' }).mode === 'preview' && T.writes.length === 0);
  setup(); T.auth = { ok: true, user: 'pat', role: 'editor' };
  C.metrcPermitSync_({ token: 't', confirm: 'yes' });
  ok('an editor can, and the row names them', T.writes.length === 1 && T.writes[0].updated_by === 'metrc-sync (pat)');

  const RUN = fnSrc('metrcPermitSyncRun_');
  ok('the run never calls GX Core to write', !/gxUpsertEmployee|setAvatar/.test(RUN));
  ok('…and goes through the one attribute writer', /writeAttrs_\(rec\)/.test(RUN));
}

console.log('\nThe 5am run');
{
  reset(CONNECTED);
  serve({ 'LIC-A': [emp('Avery Stone', 'AB12CD', '2029-05-19')], 'LIC-B': [emp('Blake Rivers', 'EF34GH', '2027-01-02')] });
  T.identity = [{ employee_id: 'avery_stone', full_name: 'Avery Stone', status: 'active' },
                { employee_id: 'finley_ward', full_name: 'Finley Ward', status: 'active' }];
  T.attrs = { avery_stone: { employee_id: 'avery_stone', full_name: 'Avery Stone', permit_number: 'AB12CD', permit_expires: '2026-05-19' },
              finley_ward: { employee_id: 'finley_ward', full_name: 'Finley Ward', permit_number: 'ZZ00ZZ', permit_expires: '2027-01-01' } };
  const out = C.nightlyDutchieScan();
  ok('the trigger still returns the Dutchie scan result, untouched', out === T.scan);
  ok('…and the permit date was updated on the same run', T.writes.length === 1 && T.writes[0].updated_by === 'metrc-sync (nightly)');
  const note = JSON.parse(T.props.CREW_LAST_METRC_SYNC);
  eq('what it did is recorded as counts', [note.ok, note.written, note.to_change, note.has_permit_but_not_in_metrc], [true, 1, 1, 1]);
  const kept = T.props.CREW_LAST_METRC_SYNC + '\n' + T.logs.filter(l => /metrc/.test(l)).join('\n');
  ok('no name, permit number or date reaches the property or the log',
     !/Avery|Stone|Finley|Ward|Blake|Rivers|AB12CD|EF34GH|ZZ00ZZ|2029-05-19|2026-05-19/.test(kept));
  ok('metrc_health shows the last nightly run', C.metrcHealth_({ secret: 'deploy-secret-for-tests' }).last_nightly_permit_sync.written === 1);

  reset({});                                        // not connected at all
  const idle = C.nightlyDutchieScan();
  ok('not connected: the scan still returns, nothing fetched, recorded as skipped',
     idle === T.scan && T.fetches.length === 0 && JSON.parse(T.props.CREW_LAST_METRC_SYNC).skipped === 'no_keys');

  reset(CONNECTED);
  T.respond = () => { throw new Error('network down'); };
  T.identity = [{ employee_id: 'avery_stone', full_name: 'Avery Stone', status: 'active' }];
  let threw = false, got = null;
  try { got = C.nightlyDutchieScan(); } catch (e) { threw = true; }
  ok('a Metrc outage never fails the 5am trigger', !threw && got === T.scan && T.writes.length === 0);
  ok('…and is recorded as a failure', JSON.parse(T.props.CREW_LAST_METRC_SYNC).ok === false);

  const NIGHT = fnSrc('nightlyDutchieScan');
  ok('the sync runs after the scan and cannot replace its return value',
     NIGHT.indexOf('dutchieNewHireScan_()') < NIGHT.indexOf('nightlyMetrcPermitSync_()') && /return out;/.test(NIGHT));
  ok('no new trigger was invented for it', !/newTrigger\('nightlyMetrc/.test(SRC) && !/newTrigger\('metrc/i.test(SRC));
}

console.log(fail ? `\n${fail} FAILED` : '\nmetrc v2: all passed');
process.exit(fail ? 1 : 0);
