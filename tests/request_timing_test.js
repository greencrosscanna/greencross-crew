#!/usr/bin/env node
/* ─── REQUEST TIMING: it records what it says, stores nothing else, and can never cost a request ──
 *
 *   RUN:            node tests/request_timing_test.js
 *   PROVE IT BITES: node scripts/prove-request-timing-red.js   (mutates a COPY, one guard at a time)
 *
 * WHY THIS EXISTS. On 2026-10-12 the Executions log showed a 37.5s web request and could not say
 * which route it was. The engine now records, per request, the action, the milliseconds and
 * ok/failed, and inside approve/send how long each stage took. That is a new thing running inside
 * every request of an app that holds PII and pays people, so the promises below are the whole
 * design, and each is executed against the SHIPPED code rather than read out of it:
 *
 *   1. it records a normal request, a refusal, a handler that throws, and a throw that ESCAPES the
 *      router — and the escape still propagates unchanged;
 *   2. a cache that is down, throwing or full never fails a request and never changes its reply;
 *   3. the request path costs one cache read and one cache write: no sheet, no lock, no property;
 *   4. nothing but route names, stage names, counts and milliseconds is stored or returned — a
 *      token, a person's name and a dollar figure pushed through every opening are looked for in
 *      everything that was written;
 *   5. the read-back route answers the deploy secret and nothing else — not a session token;
 *   6. every store is bounded;
 *   7. approve and send return byte-identical results, and write byte-identical sheets and mail,
 *      with timing on, with timing off, and with timing failing.
 *
 * CODE_GS=/path/to/Code.gs points BOTH this file and the pay harness at another copy of the engine.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC_PATH = process.env.CODE_GS || path.join(__dirname, '..', 'apps-script', 'Code.gs');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const { engine } = require('./pay_engine_harness.js');

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
/* A crash is a failure with a count, so the mutation proof can read it the same way as any other —
   several of the guards here, removed, make the engine THROW rather than answer wrongly. */
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.message) || e).slice(0, 200));
  console.log('\n' + (fail + 1) + ' FAILED (of ' + (pass + fail + 1) + ' reached)');
  process.exit(1);
});

/* What must never be stored. Chosen so none can arise from a duration by accident. */
const TOKEN = 'gx-dev:FIXTURE-TOKEN-zq81';
const PERSON = 'Zelda Fixtureson';
const MONEY = 4321.09;
const SECRET = 'fixture-secret-k7';   // a fixture, not a credential — and short enough that the push gate agrees
/* A name typed where the action goes, in the one shape a route name also has: lowercase and
   underscores. A pattern check alone would store it; only "did the router recognize it" does not. */
const PERSON_AS_ACTION = 'fixtureson_zelda';
const LEAKS = [TOKEN, 'FIXTURE-TOKEN', PERSON, 'Zelda', 'Fixtureson', PERSON_AS_ACTION, '4321.09', '4321', SECRET];
const leaksIn = (text) => LEAKS.filter((l) => String(text).indexOf(l) >= 0);

/* ── Lift real code, brace-matched ──────────────────────────────────────────────────────────── */
function block(kind, name) {
  const re = kind === 'fn' ? new RegExp('^function\\s+' + name + '\\s*\\(', 'm')
                           : new RegExp('^var\\s+' + name + '\\s*=', 'm');
  const m = SRC.match(re);
  if (!m) return null;
  if (kind === 'var') {
    let depth = 0;
    for (let i = m.index; i < SRC.length; i++) {
      const c = SRC[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) return SRC.slice(m.index, i + 1);
    }
    return null;
  }
  /* Comments and strings are skipped: deploySecretOk_ compares against the string '{', and a bare
     brace count runs off the end of the file looking for its partner. */
  let depth = 0;
  for (let i = SRC.indexOf('{', m.index); i < SRC.length; i++) {
    const c = SRC[i], n = SRC[i + 1];
    if (c === '/' && n === '*') { i = SRC.indexOf('*/', i + 2) + 1; continue; }
    if (c === '/' && n === '/') { i = SRC.indexOf('\n', i); continue; }
    if (c === "'" || c === '"') {
      for (i = i + 1; i < SRC.length; i++) {
        if (SRC[i] === '\\') { i++; continue; }
        if (SRC[i] === c) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(m.index, i + 1); }
  }
  return null;
}

const WANT = [
  ['var', 'CREW_SHEET_ID_PROP'], ['var', 'AUTH_PARAM_NAMES_'], ['var', 'SECRET_PARAM_NAMES_'],
  ['var', 'SECRET_PARAM_RE_'],
  ['var', 'REQT_PREFIX'], ['var', 'REQT_TTL_S'], ['var', 'REQT_TAB'], ['var', 'REQT_HEADERS'],
  ['var', 'REQT_KEEP_ROWS'], ['var', 'REQT_MAX_NAMES'], ['var', 'REQT_MAX_STAGES'],
  ['var', 'REQT_MAX_BODY'], ['var', 'REQT_MAX_HOURS'], ['var', 'REQT_EDGES'], ['var', 'REQT_NAME_RE'],
  ['var', 'REQT_STAGE_RE'], ['var', '_reqT_'],
  ['fn', 'scrubSecrets_'], ['fn', 'authParamValue_'], ['fn', 'requireCrew_'], ['fn', 'deploySecretOk_'],
  ['fn', 'json_'], ['fn', 'doGet'], ['fn', 'doPost'], ['fn', 'route_'],
  ['fn', 'reqHour_'], ['fn', 'reqBegin_'], ['fn', 'reqUnknown_'], ['fn', 'reqThrew_'],
  ['fn', 'reqReplied_'], ['fn', 'reqVariant_'], ['fn', 'reqMark_'], ['fn', 'reqBucketOf_'],
  ['fn', 'reqFold_'], ['fn', 'reqEnd_'], ['fn', 'reqStatsSheet_'], ['fn', 'reqHourText_'],
  ['fn', 'reqStatsFlush_'], ['fn', 'reqMergeEntry_'], ['fn', 'reqPercentile_'], ['fn', 'reqStats_'],
  ['fn', 'approvalEscalationSweep'], ['fn', 'perfForWrite_'],
];
const missing = WANT.filter(([k, n]) => !block(k, n)).map(([, n]) => n);
console.log('\nThe shipped code is what runs here');
ok('every function and constant this test executes was found in Code.gs' +
   (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), missing.length === 0);
if (missing.length) { console.log('\n' + fail + ' FAILED'); process.exit(1); }

/* ── A fake clock: every read advances it by `step`, and a stub can burn time by moving `t`. ──── */
const HOUR = 3600000;
const BASE = Date.UTC(2026, 9, 12, 18, 30, 0);          // 11:30 AM Pacific, 2026-10-12

function laHour(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour;
}

/* ── A fake sheet, enough for the stats tab ─────────────────────────────────────────────────── */
function makeBook(W) {
  const sheets = Object.create(null);
  function makeSheet(name) {
    const data = [];
    const sh = {
      data, formats: [],
      getLastRow() { W.sheetCalls++; return data.length; },
      getRange(r, c, nr, nc) {
        W.sheetCalls++;
        nr = nr || 1; nc = nc || 1;
        const rng = {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = data[r - 1 + i] || [];
              out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] == null ? '' : row[c - 1 + j]));
            }
            return out;
          },
          setValues(vals) {
            if (W.sheetWriteThrows) throw new Error('Service Spreadsheets failed while accessing document');
            for (let i = 0; i < vals.length; i++) {
              while (data.length < r + i) data.push([]);
              for (let j = 0; j < vals[i].length; j++) data[r - 1 + i][c - 1 + j] = vals[i][j];
            }
            return rng;
          },
          setNumberFormat(f) { sh.formats.push({ r, c, nr, nc, f }); return rng; },
          setFontWeight() { return rng; },
        };
        return rng;
      },
      deleteRows(n, count) { W.sheetCalls++; data.splice(n - 1, count); },
      setFrozenRows() {},
    };
    return sh;
  }
  return { sheets,
           getSheetByName(n) { W.sheetCalls++; return sheets[n] || null; },
           insertSheet(n) { W.sheetCalls++; W.inserted.push(n); return (sheets[n] = makeSheet(n)); } };
}

/* ── One world per scenario: the real router and the real timing code over fake services ──────── */
function world() {
  const W = { clock: { t: BASE, step: 1 }, cache: new Map(), ttls: new Map(), gets: 0, puts: 0,
              cacheMode: 'ok', sheetCalls: 0, lockCalls: 0, propCalls: 0, created: 0, inserted: [],
              sheetId: 'SHEET-1', sheetWriteThrows: false, contentThrows: false, authCalls: 0,
              openById: [], props: { GX_DEPLOY_SECRET: SECRET } };
  W.book = makeBook(W);
  const now = () => { const v = W.clock.t; W.clock.t += W.clock.step; return v; };

  const sandbox = {
    __now: now,
    Utilities: { formatDate: (d) => laHour(d),
                 computeDigest: () => [1, 2, 3], base64Encode: () => 'ZGlnZXN0ZGlnZXN0ZGlnZXN0ZGlnZXN0',
                 DigestAlgorithm: { SHA_256: 1 } },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: (t) => {
        if (W.contentThrows) throw new Error('ContentService is down');
        return { body: t, setMimeType() { return this; } };
      },
    },
    CacheService: { getScriptCache: () => {
      if (W.cacheMode === 'no-service') throw new Error('CacheService unavailable');
      return {
        get: (k) => {
          W.gets++;
          if (W.cacheMode === 'get-throws') throw new Error('Service invoked too many times: cache get');
          return W.cache.has(k) ? W.cache.get(k) : null;
        },
        put: (k, v, ttl) => {
          W.puts++;
          if (W.cacheMode === 'put-throws') throw new Error('Service error: cache put');
          if (W.cacheMode === 'full') throw new Error('Argument too large: value');
          W.cache.set(k, v); W.ttls.set(k, ttl);
        },
      };
    } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => {
        W.propCalls++;
        if (k === 'CREW_SHEET_ID') return W.sheetId;
        return W.props[k] == null ? null : W.props[k];
      },
    }) },
    SpreadsheetApp: {
      openById: (id) => { W.sheetCalls++; W.openById.push(id); return W.book; },
      create: () => { W.created++; return W.book; },
      flush: () => { W.sheetCalls++; },
    },
    LockService: { getScriptLock: () => { W.lockCalls++; return { tryLock: () => true, waitLock() {}, releaseLock() {} }; } },
    UrlFetchApp: { fetch: () => { throw new Error('no fetch in this test'); } },
    GXCORE_URL: 'https://core.example/exec',
    GXCore: { libVersion: () => 'v-test', requireAuth: () => { W.authCalls++; return { ok: true, user: 'viewer', role: 'viewer' }; } },
    Logger: { log() {} },
  };
  vm.createContext(sandbox);
  /* The context's own Date, driven by the fake clock. instanceof still holds: the prototype is shared. */
  vm.runInContext(
    '(function () { var R = Date; function F(a) { return arguments.length ? new R(a) : new R(__now()); }' +
    ' F.now = function () { return __now(); }; F.UTC = R.UTC; F.parse = R.parse; F.prototype = R.prototype; Date = F; })();',
    sandbox);
  vm.runInContext(WANT.map(([k, n]) => block(k, n)).join('\n'), sandbox);

  /* Handlers the router reaches. Stand-ins for the real ones: what is under test is the router and
     the timing around them, and each one deliberately handles the fixtures a real one would. */
  sandbox.__W = W;
  vm.runInContext(`
    function getRoster_(p) {
      __W.clock.t += 1200;
      return { ok: true, token: p.token, rows: [{ name: '${PERSON}', wage: ${MONEY} }] };
    }
    function getReview_(p) { return { ok: false, error: 'Auth required for ${PERSON}' }; }
    function saveRosterAttrs_(p) { __W.clock.t += 300; throw new Error('boom for ${PERSON} at $${MONEY}'); }
    function getIncentive_(p) {
      __W.clock.t += 700; reqMark_('auth');
      __W.clock.t += 9300; reqMark_('perf_fetch');
      return { ok: true, payroll_total: ${MONEY}, name: '${PERSON}' };
    }
    function escalateApprovals_() { return { ok: true, escalated: ['nobody'], marker: 'sweep-out' }; }
  `, sandbox);

  W.sb = sandbox;
  W.get = (params) => sandbox.doGet({ parameter: params });
  W.bucket = (ms) => { const raw = W.cache.get('crewreq:' + laHour(new Date(ms == null ? W.clock.t : ms))); return raw ? JSON.parse(raw) : null; };
  W.dump = () => JSON.stringify([...W.cache.entries()]) + JSON.stringify(Object.keys(W.book.sheets).map((n) => W.book.sheets[n].data));
  return W;
}

/* ── 1. Recording ───────────────────────────────────────────────────────────────────────────── */
console.log('\nA request is recorded: the action, the milliseconds, ok or failed');
{
  const W = world();
  const res = W.get({ action: 'roster', token: TOKEN });
  const b = W.bucket() || {};
  ok('an ordinary request is recorded under its action, once', !!b.roster && b.roster.n === 1);
  ok('…as ok — neither failed nor thrown', b.roster && b.roster.f === 0 && b.roster.x === 0);
  ok('…with the time the handler took (1200ms burned inside it)', b.roster && b.roster.ms >= 1200 && b.roster.ms < 1260);
  const plain = vm.runInContext('json_(getRoster_({ token: "' + TOKEN + '" }))', W.sb);   // no request open
  ok('…and its reply is byte-identical to the one built with no request open', res.body === plain.body);

  W.get({ action: 'review', token: TOKEN });
  const b2 = W.bucket();
  ok('a refusal ({ok:false}) is recorded as failed, and not as thrown', b2.review.n === 1 && b2.review.f === 1 && b2.review.x === 0);

  const thrown = W.get({ action: 'roster_save', token: TOKEN });
  const b3 = W.bucket();
  ok('a handler that throws is recorded as thrown (and failed)', b3.roster_save.n === 1 && b3.roster_save.x === 1 && b3.roster_save.f === 1);
  ok('…and the router still answers with the error, exactly as before',
     JSON.parse(thrown.body).ok === false && /^boom for /.test(JSON.parse(thrown.body).error));

  W.get({});
  ok('no action at all is the health route, recorded as health', W.bucket().health.n === 1);

  W.get({ action: 'incentive', token: TOKEN });
  const inc = W.bucket().incentive;
  ok('stage marks made inside a handler are kept with the request',
     inc.st.auth && inc.st.perf_fetch && inc.st.perf_fetch.ms >= 9300 && inc.st.perf_fetch.ms < 9320 && inc.st.auth.ms >= 700);
  ok('…and the stages add up to no more than the request', inc.st.auth.ms + inc.st.perf_fetch.ms <= inc.ms);
}

console.log('\nA throw that ESCAPES the router still propagates, unchanged — and is still recorded');
{
  const W = world();
  W.contentThrows = true;                       // json_ fails in the try AND in the catch: nothing can answer
  let caught = null;
  try { W.get({ action: 'roster', token: TOKEN }); } catch (e) { caught = e; }
  ok('the original error reaches the caller', !!caught && caught.message === 'ContentService is down');
  const b = W.bucket() || {};
  ok('…and the request is recorded as thrown', !!b.roster && b.roster.n === 1 && b.roster.x === 1 && b.roster.f === 1);
  W.contentThrows = false;
  W.get({ action: 'roster', token: TOKEN });
  ok('the next request is its own: one more, and not thrown', W.bucket().roster.n === 2 && W.bucket().roster.x === 1);
}

console.log('\nThe collector does not outlive its request');
{
  const W = world();
  W.get({ action: 'roster' });
  ok('it is cleared when the request ends', W.sb._reqT_ === null || vm.runInContext('_reqT_', W.sb) === null);
  vm.runInContext('reqMark_("stray"); reqVariant_("stray");', W.sb);   // a trigger on the same warm instance
  W.get({ action: 'roster' });
  const b = W.bucket();
  ok('a mark made between requests lands nowhere', !b.roster.st.stray && !b['roster.stray'] && b.roster.n === 2);
}

/* ── 2. A broken cache ──────────────────────────────────────────────────────────────────────── */
console.log('\nA cache that is down, throwing or full never fails a request or changes its reply');
{
  const healthy = world();
  const want = healthy.get({ action: 'roster', token: TOKEN }).body;
  ['no-service', 'get-throws', 'put-throws', 'full'].forEach((mode) => {
    const W = world();
    W.cacheMode = mode;
    let got = null, threw = null;
    try { got = W.get({ action: 'roster', token: TOKEN }).body; } catch (e) { threw = e; }
    ok('cache ' + mode + ': the request answers, with the identical reply', !threw && got === want);
    let got2 = null;
    try { got2 = JSON.parse(W.get({ action: 'roster_save' }).body); } catch (e) { threw = e; }
    ok('cache ' + mode + ': a throwing handler is still answered by the router', !threw && got2 && got2.ok === false);
  });

  /* An outage must not replace an hour of samples with one. */
  const W = world();
  W.get({ action: 'roster' }); W.get({ action: 'roster' });
  W.cacheMode = 'get-throws';
  const putsBefore = W.puts;
  W.get({ action: 'roster' });
  W.cacheMode = 'ok';
  ok('a cache READ that throws writes nothing, so the hour already recorded survives',
     W.puts === putsBefore && W.bucket().roster.n === 2);
  W.cache.set('crewreq:' + laHour(new Date(W.clock.t)), '{not json');
  W.get({ action: 'roster' });
  ok('a corrupt bucket is replaced rather than fatal', W.bucket().roster.n === 1);
}

/* ── 3. What it costs ───────────────────────────────────────────────────────────────────────── */
console.log('\nThe request path costs one cache read and one cache write, and nothing else');
{
  const W = world();
  W.get({ action: 'roster', token: TOKEN });
  ok('one get and one put for an ordinary request', W.gets === 1 && W.puts === 1);
  ok('no spreadsheet is opened or written', W.sheetCalls === 0 && W.created === 0);
  ok('no lock is taken', W.lockCalls === 0);
  ok('no script property is read', W.propCalls === 0);
  W.get({ action: 'incentive', token: TOKEN });
  ok('stage marks add no cache traffic — still one get and one put per request', W.gets === 2 && W.puts === 2);
  /* Even with closed hours waiting to be flushed, a request never does the flushing. */
  W.clock.t += 3 * HOUR;
  W.get({ action: 'roster' });
  ok('a request never flushes: closed hours waiting, and still no sheet', W.sheetCalls === 0 && W.gets === 3 && W.puts === 3);
  ok('the bucket is written with the 6-hour ttl', [...W.ttls.values()].every((t) => t === 21600));
}

/* ── 4. Nothing else is stored ──────────────────────────────────────────────────────────────── */
console.log('\nOnly route names, stage names, counts and milliseconds are stored');
{
  const W = world();
  /* The fixtures go in through every opening a request has: the session parameter, arbitrary
     parameters, the ACTION itself, a JSONP callback, the handler's reply and a thrown error. */
  W.get({ action: 'roster', token: TOKEN, name: PERSON, amount: String(MONEY), secret: SECRET });
  W.get({ action: 'roster_save', token: TOKEN, full_name: PERSON, wage: String(MONEY) });
  W.get({ action: 'incentive', session: TOKEN, auth: TOKEN, pp_start: PERSON });
  W.get({ action: TOKEN, token: TOKEN });
  W.get({ action: PERSON });
  W.get({ action: String(MONEY) });
  W.get({ action: PERSON_AS_ACTION });
  W.get({ action: 'roster', callback: 'cb_' + 'Fixtureson' });
  const b = W.bucket();
  ok('an unrecognized action is stored as (unknown), never as the text the caller sent',
     b['(unknown)'] && b['(unknown)'].n === 4 && Object.keys(b).sort().join(',') === '(unknown),incentive,roster,roster_save');
  ok('the cache holds none of: the token, the name, the dollar figure, the secret' +
     (leaksIn(W.dump()).length ? ' — FOUND ' + leaksIn(W.dump()).join(', ') : ''), leaksIn(W.dump()).length === 0);

  /* …and after the flush, in the tab. The bucket is first given an entry no request could have
     written — a person's name as a key — because the flush checks names again rather than trusting
     whatever the cache holds. */
  const closedKey = 'crewreq:' + laHour(new Date(W.clock.t));
  const tampered = JSON.parse(W.cache.get(closedKey));
  tampered[PERSON] = { n: 1, f: 0, x: 0, ms: 5, hi: 5, h: { 0: 1 }, st: {} };
  W.cache.set(closedKey, JSON.stringify(tampered));
  W.clock.t += HOUR;
  const fl = vm.runInContext('reqStatsFlush_()', W.sb);
  const tabText = () => JSON.stringify(W.book.sheets.crew_request_stats.data);
  ok('the flush wrote the closed hour — the four real names, and not the planted one', fl.ok === true && fl.rows === 4);
  ok('the tab holds none of them either' + (leaksIn(tabText()).length ? ' — FOUND ' + leaksIn(tabText()).join(', ') : ''),
     leaksIn(tabText()).length === 0);
  const rows = W.book.sheets.crew_request_stats.data.slice(1);
  ok('every stored row is: an hour, a route name, numbers',
     rows.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}$/.test(r[0]) &&
                       /^(\(unknown\)|[a-z_]+)(\.[a-z]+)?$/.test(r[1]) &&
                       /^[{}":,0-9a-z_]+$/.test(r[2])));

  /* …and in what the read-back returns. */
  const out = W.get({ action: 'request_stats', secret: SECRET, hours: '24' }).body;
  const text = out.replace(/"notes":\[[^\]]*\]/, '');
  ok('the read-back returns none of them' + (leaksIn(text).length ? ' — FOUND ' + leaksIn(text).join(', ') : ''),
     leaksIn(text).length === 0);

  /* A hand-edited tab cannot smuggle prose into a reply. */
  W.book.sheets.crew_request_stats.data.push([laHour(new Date(W.clock.t - HOUR)), PERSON, '{"n":1,"f":0,"x":0,"ms":5,"hi":5,"h":{"0":1},"st":{"' + PERSON + '":{"n":1,"ms":5,"hi":5}}}', 'x']);
  W.book.sheets.crew_request_stats.data.push([laHour(new Date(W.clock.t - HOUR)), 'roster', '{"n":1,"f":0,"x":0,"ms":5,"hi":5,"h":{"0":1},"st":{"' + PERSON + '":{"n":1,"ms":5,"hi":5}}}', 'x']);
  const out2 = W.get({ action: 'request_stats', secret: SECRET }).body;
  ok('a name typed into the tab by hand is not echoed back', leaksIn(out2.replace(/"notes":\[[^\]]*\]/, '')).length === 0);
}

/* ── 5. Reading it back ─────────────────────────────────────────────────────────────────────── */
console.log('\nThe read-back answers the deploy secret and nothing else');
{
  const W = world();
  W.get({ action: 'roster' });
  const none = JSON.parse(W.get({ action: 'request_stats' }).body);
  ok('no secret: refused', none.ok === false && /secret/.test(none.error) && !none.actions);
  const wrong = JSON.parse(W.get({ action: 'request_stats', secret: 'not-it' }).body);
  ok('a wrong secret: refused', wrong.ok === false && !wrong.actions);
  const sess = JSON.parse(W.get({ action: 'request_stats', token: TOKEN, session: TOKEN, auth: TOKEN }).body);
  ok('a session token, in any of its three names: refused', sess.ok === false && !sess.actions);
  ok('…and the session gate was never even consulted', W.authCalls === 0);
  const good = JSON.parse(W.get({ action: 'request_stats', secret: SECRET }).body);
  ok('the secret: answered', good.ok === true && Array.isArray(good.actions));
}

console.log('\nWhat it returns: count, typical, p90, max, and the stage breakdown');
{
  const W = world();
  /* Ten roster loads with known durations, one of them slow. */
  const burn = [300, 300, 400, 600, 800, 900, 1100, 1500, 4000, 21000];
  burn.forEach((ms) => {
    vm.runInContext('reqBegin_("roster");', W.sb);
    W.clock.t += ms;
    vm.runInContext('reqReplied_({ ok: true }); reqEnd_();', W.sb);
  });
  vm.runInContext('reqBegin_("incentive_approve"); reqVariant_("confirm");', W.sb);
  W.clock.t += 5000; vm.runInContext('reqMark_("perf_fetch");', W.sb);
  W.clock.t += 9000; vm.runInContext('reqMark_("backup");', W.sb);
  W.clock.t += 1000;
  vm.runInContext('reqReplied_({ ok: true }); reqEnd_();', W.sb);

  const r = JSON.parse(W.get({ action: 'request_stats', secret: SECRET, hours: '2' }).body);
  const roster = r.actions.find((a) => a.name === 'roster');
  ok('count is exact', roster && roster.count === 10 && roster.failed === 0);
  ok('max is exact (to the fake clock\'s tick)', roster && roster.max_ms >= 21000 && roster.max_ms < 21010);
  ok('typical is the bucket the 5th of 10 falls in (800ms → the 1000ms edge)', roster && roster.typical_ms === 1000);
  ok('p90 is the bucket the 9th of 10 falls in (4000ms → the 5000ms edge)', roster && roster.p90_ms === 5000);
  ok('avg is exact', roster && Math.abs(roster.avg_ms - 3090) <= 5);
  const appr = r.actions.find((a) => a.name === 'incentive_approve.confirm');
  ok('an approve carries its stage breakdown, largest first',
     appr && appr.stages && appr.stages[0].stage === 'backup' && appr.stages[1].stage === 'perf_fetch' &&
     appr.stages[0].avg_ms >= 9000 && appr.stages[0].avg_ms < 9010);
  ok('time no stage claimed is reported as unattributed', appr && appr.unattributed_avg_ms >= 1000 && appr.unattributed_avg_ms < 1020);
  ok('a percentile never exceeds the max', r.actions.every((a) => a.p90_ms <= a.max_ms && a.typical_ms <= a.p90_ms));
  ok('the slowest at p90 is listed first', r.actions[0].name === 'incentive_approve.confirm');

  /* Flushed hours and live hours are merged without counting an hour twice. */
  W.clock.t += HOUR;
  vm.runInContext('reqStatsFlush_()', W.sb);
  vm.runInContext('reqBegin_("roster");', W.sb); W.clock.t += 200; vm.runInContext('reqReplied_({ok:true}); reqEnd_();', W.sb);
  const r2 = JSON.parse(W.get({ action: 'request_stats', secret: SECRET, hours: '6' }).body);
  ok('an hour that is in both the tab and the cache is counted once',
     r2.actions.find((a) => a.name === 'roster').count === 11 && r2.sources.sheet_hours === 1 && r2.sources.cache_hours === 1);
  W.clock.t += 3 * HOUR;
  const r3 = JSON.parse(W.get({ action: 'request_stats', secret: SECRET, hours: '1' }).body);
  const r4 = JSON.parse(W.get({ action: 'request_stats', secret: SECRET, hours: '6' }).body);
  ok('`hours` limits how far back it reads (three hours on: 1 sees no roster load, 6 sees all 11)',
     !r3.actions.some((a) => a.name === 'roster') && r4.actions.find((a) => a.name === 'roster').count === 11);
  ok('`hours` is clamped: a million asks for 336', JSON.parse(W.get({ action: 'request_stats', secret: SECRET, hours: '1000000' }).body).hours === 336);
  ok('…and nonsense asks for the default', JSON.parse(W.get({ action: 'request_stats', secret: SECRET, hours: 'lots' }).body).hours === 24);
}

/* ── 6. The flush ───────────────────────────────────────────────────────────────────────────── */
console.log('\nThe flush: closed hours only, once each, and it recovers by itself');
{
  const W = world();
  const flush = () => vm.runInContext('reqStatsFlush_()', W.sb);
  const tab = () => (W.book.sheets.crew_request_stats ? W.book.sheets.crew_request_stats.data.slice(1) : []);
  W.get({ action: 'roster' });
  const h0 = laHour(new Date(W.clock.t));
  let f = flush();
  ok('the hour still open is left alone, and the workbook is not even opened', f.ok && f.flushed.length === 0 && W.openById.length === 0);
  W.clock.t += HOUR;
  W.get({ action: 'incentive' });
  f = flush();
  ok('a closed hour is written, one row per route', f.ok && f.flushed.join() === h0 && tab().length === 1 && tab()[0][1] === 'roster');
  ok('the workbook is reached by its stored id', W.openById.join() === 'SHEET-1' && W.created === 0);
  ok('the hour is stored as text', W.book.sheets.crew_request_stats.formats.some((x) => x.f === '@' && x.c === 1));
  f = flush();
  ok('a second run writes nothing', f.ok && f.rows === 0 && tab().length === 1);
  /* The "done" marker is only a hint. With it evicted, the TAB still says the hour is there. */
  [...W.cache.keys()].filter((k) => /crewreq:done:/.test(k)).forEach((k) => W.cache.delete(k));
  f = flush();
  ok('…even after the cache forgets it was flushed — the tab is the record', f.ok && f.rows === 0 && f.already.join() === h0 && tab().length === 1);

  /* THE 2026-09-03 FAILURE, in GX Core: one failed flush and the hour was gone for good. */
  W.clock.t += HOUR;
  W.sheetWriteThrows = true;
  let threw = null;
  try { f = flush(); } catch (e) { threw = e; }
  ok('a failed write does not throw', !threw && f.ok === false && /Spreadsheets failed/.test(f.error));
  ok('…and is on the record, where the read-back can show it',
     JSON.parse(W.cache.get('crewreq:lastflush')).ok === false);
  W.sheetWriteThrows = false;
  f = flush();
  ok('the next run writes the hour the failed one could not', f.ok && f.rows === 1 && tab().length === 2 && tab()[1][1] === 'incentive');
  const lf = JSON.parse(W.get({ action: 'request_stats', secret: SECRET }).body).last_flush;
  ok('the read-back reports the last flush', lf && lf.ok === true);

  /* No stored id is not a reason to make a workbook. */
  const N = world();
  N.sheetId = null;
  N.get({ action: 'roster' });
  N.clock.t += HOUR;
  const nf = vm.runInContext('reqStatsFlush_()', N.sb);
  ok('with no stored workbook id it refuses — and creates nothing', nf.ok === false && N.created === 0 && N.openById.length === 0 && N.inserted.length === 0);
  const ns = JSON.parse(N.get({ action: 'request_stats', secret: SECRET, hours: '3' }).body);
  ok('…and the read-back still answers from the cache', ns.ok === true && ns.actions.some((a) => a.name === 'roster'));

  /* The trigger it rides. */
  const S = world();
  S.get({ action: 'roster' });
  S.clock.t += HOUR;
  const sweep = vm.runInContext('approvalEscalationSweep()', S.sb);
  ok('the 15-minute sweep still returns what it always returned', sweep && sweep.marker === 'sweep-out' && sweep.escalated.length === 1);
  ok('…and flushes the closed hour as it goes', S.book.sheets.crew_request_stats && S.book.sheets.crew_request_stats.data.length === 2);
  const S2 = world();
  S2.get({ action: 'roster' });
  S2.clock.t += HOUR;
  S2.sb.SpreadsheetApp.openById = () => { throw new Error('Drive is down'); };
  let sweepThrew = null, out2 = null;
  try { out2 = vm.runInContext('approvalEscalationSweep()', S2.sb); } catch (e) { sweepThrew = e; }
  ok('a flush that cannot reach Drive does not break the sweep', !sweepThrew && out2 && out2.marker === 'sweep-out');
}

/* ── 7. Bounds ──────────────────────────────────────────────────────────────────────────────── */
console.log('\nEvery store is bounded');
{
  const W = world();
  const many = vm.runInContext(
    '(function () { var b = {}; for (var i = 0; i < 500; i++) reqFold_(b, "n" + i, 5, false, false, {}); return Object.keys(b).length; })()', W.sb);
  ok('an hour holds at most 120 names (' + many + ' after 500 distinct ones)', many === 120);
  const stages = vm.runInContext(
    '(function () { var b = {}, st = {}; for (var i = 0; i < 200; i++) st["s" + i] = 1; reqFold_(b, "roster", 5, false, false, st); return Object.keys(b.roster.st).length; })()', W.sb);
  ok('a route holds at most 40 stages (' + stages + ' after 200)', stages === 40);
  const still = vm.runInContext(
    '(function () { var b = {}; for (var i = 0; i < 500; i++) reqFold_(b, "n" + i, 5, false, false, {}); reqFold_(b, "n0", 5, false, false, {}); return b.n0.n; })()', W.sb);
  ok('a name already present still counts once the cap is reached', still === 2);
  const badStage = vm.runInContext(
    '(function () { var b = {}; reqFold_(b, "roster", 5, false, false, { "' + PERSON + '": 3, "ok_stage": 3 }); return Object.keys(b.roster.st).join(); })()', W.sb);
  ok('a stage name that is not a plain identifier is dropped', badStage === 'ok_stage');

  /* A bucket near the cache ceiling is not written past it. */
  const big = {};
  for (let i = 0; i < 119; i++) big['n' + i] = { n: 1, f: 0, x: 0, ms: 1, hi: 1, h: { 0: 1 }, st: {}, pad: 'x'.repeat(800) };
  W.cache.set('crewreq:' + laHour(new Date(W.clock.t)), JSON.stringify(big));
  const before = W.puts;
  W.get({ action: 'roster' });
  ok('a bucket past 90KB is not written (the cache refuses 100KB)', W.puts === before);

  /* The tab is a ring. */
  const R = world();
  R.get({ action: 'roster' });
  const sh = R.book.insertSheet('crew_request_stats');
  sh.data.push(['hour', 'name', 'stats', 'flushed_at']);
  for (let i = 0; i < 3005; i++) sh.data.push(['2026-09-01 0' + (i % 10), 'roster', '{"n":1}', 'x']);
  R.clock.t += HOUR;
  const f = vm.runInContext('reqStatsFlush_()', R.sb);
  ok('the tab is trimmed to 3000 rows, oldest first', f.ok && sh.data.length === 3001 && sh.data[sh.data.length - 1][0] === laHour(new Date(R.clock.t - HOUR)));
  ok('…and the header row survives the trim', sh.data[0][0] === 'hour');
}

/* ── 8. The real perfForWrite_ ──────────────────────────────────────────────────────────────── */
console.log('\nperfForWrite_ marks the GX Core fetch and the roster stamp, on every path');
{
  const W = world();
  vm.runInContext(`
    function isPracticePeriod_() { return false; }
    function fetchLivePerf_(pp) { __W.clock.t += 8000; return { ok: true, pp: pp, rows: [{ name: '${PERSON}', bonus: ${MONEY} }] }; }
    function stampEmployeeIds_(live) { __W.clock.t += 1500; live.stamped = true; }
    function foldFloaters_(live) { live.folded = true; }
  `, W.sb);
  const bare = JSON.stringify(vm.runInContext('perfForWrite_("2026-09-28")', W.sb));
  vm.runInContext('reqBegin_("incentive_approve"); reqVariant_("dry");', W.sb);
  const timed = JSON.stringify(vm.runInContext('perfForWrite_("2026-09-28")', W.sb));
  vm.runInContext('reqReplied_({ ok: true }); reqEnd_();', W.sb);
  const e = W.bucket()['incentive_approve.dry'];
  ok('perf_fetch is the GX Core fetch (8000ms burned in it)', e && e.st.perf_fetch && e.st.perf_fetch.ms >= 8000 && e.st.perf_fetch.ms < 8020);
  ok('stamp is the registry + attributes read (1500ms)', e && e.st.stamp && e.st.stamp.ms >= 1500 && e.st.stamp.ms < 1520);
  ok('what it returns is identical with a request open and with none', bare === timed);
  ok('outside a request it records nothing at all', W.gets === 1 && W.puts === 1);
}

/* ── 9. Approve and send, through the real pay engine ───────────────────────────────────────── */
const PP = '2026-08-17';
const RealDate = Date;
const fake = { t: BASE, step: 0 };
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(fake.now()); }
  static now() { return fake.now(); }
}
fake.now = () => { const v = fake.t; fake.t += fake.step; return v; };
const withClock = (step, fn) => {
  fake.t = BASE; fake.step = step;
  global.Date = FakeDate;
  try { return fn(); } finally { global.Date = RealDate; }
};
const rid = (s) => 'rq-' + s + '-' + '0'.repeat(20);

/* The fixture period: a named person, a dollar figure that must never be stored. */
function payEngine() {
  const E = engine();
  E.live = (pp) => ({ ok: true, payPeriod: { start: pp, end: '2026-08-30', current: false },
    budtenders: [{ employee_id: 'e1', name: PERSON, bonus: MONEY, discount: 0.01 },
                 { employee_id: 'e2', name: 'Two', bonus: 25, discount: 0.01 }],
    managers: [], admin: null, spiff: { ok: true }, unmatched: [] });
  E.seedClosed();
  return E;
}
/* What route_ does around a handler: open the request, hand the reply to json_ (which tells the
   collector a reply was built), close it in a finally. */
const inRequest = (E, action, fn) => {
  if (!E.req) return fn();
  E.req.begin(action);
  try { const r = fn(); E.req.replied(r); return r; } finally { E.req.end(); }
};
const reqBucket = (E) => { const raw = E.cache.get('crewreq:'); return raw ? JSON.parse(raw) : {}; };

console.log('\nApprove and send record their stages — and the dry run and the confirm are told apart');
withClock(3, () => {
  const E = payEngine();
  ok('the harness lifted the shipped timing helpers', !!E.req);
  if (!E.req) return;
  E.user = 'mike';
  const sent = inRequest(E, 'incentive_send', () => E.send({ token: TOKEN, pp_start: PP, request_id: rid('S') }));
  E.user = 'sky';
  const dry = inRequest(E, 'incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP }));
  const done = inRequest(E, 'incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP, confirm: 'yes', request_id: rid('A') }));
  ok('the three calls did what they do: sent, dry run, approved',
     sent.ok && sent.status === 'pending' && dry.ok && dry.dry_run === true && done.ok && done.written === 2);
  const b = reqBucket(E);
  const names = Object.keys(b).sort().join(',');
  ok('three separate names: ' + names, names === 'incentive_approve.confirm,incentive_approve.dry,incentive_send.send');
  const st = (n) => Object.keys((b[n] || { st: {} }).st).sort().join(',');
  ok('the dry run: precheck → the two check passes → SPIFF → sheet reads → the math',
     st('incentive_approve.dry') === 'calc_and_band,checks_first,checks_second,precheck,sheet_reads,spiff_read');
  ok('the confirm adds the history write, the PDF, the backup and the email',
     st('incentive_approve.confirm') === 'backup,calc_and_band,checks_first,checks_second,email,history_write,pdf,precheck,sheet_reads,spiff_read');
  ok('a send is a SEND — not the approve dry run it runs inside — with its claim and its email',
     st('incentive_send.send') === 'calc_and_band,checks_first,checks_second,claim_write,email,email_build,precheck,sheet_reads,spiff_read');
  ok('each ran once and none is marked failed', ['incentive_approve.dry', 'incentive_approve.confirm', 'incentive_send.send'].every((n) => b[n].n === 1 && b[n].f === 0));
  const stored = JSON.stringify([...E.cache.entries()].filter(([k]) => /^crewreq:/.test(k)));
  ok('what approve and send stored holds no token, no name and no dollar figure' +
     (leaksIn(stored).length ? ' — FOUND ' + leaksIn(stored).join(', ') : ''), leaksIn(stored).length === 0);

  /* A refusal decided inside approve is a failed request, and still one of the two kinds. */
  const again = inRequest(E, 'incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP, confirm: 'yes', request_id: rid('B') }));
  ok('approving a closed period is refused, as ever', again.ok === false);
  ok('…and that refusal is recorded under the confirm', reqBucket(E)['incentive_approve.confirm'].n === 2);
});

console.log('\nApprove and send are byte-identical with timing on, off, and failing');
{
  /* One whole close: prepare, send, look, approve, look again. Frozen clock, so every timestamp the
     engine writes is the same in every run and any difference is the timing code's doing. */
  const scenario = (mode) => withClock(0, () => {
    const E = payEngine();
    if (mode === 'cache-get-throws') E.cacheBreak = (k, op) => { if (/^crewreq:/.test(k) && op === 'get') throw new Error('cache down'); };
    if (mode === 'cache-put-throws') E.cacheBreak = (k, op) => { if (/^crewreq:/.test(k) && op === 'put') throw new Error('Argument too large'); };
    const call = (action, fn) => (mode === 'off' ? fn() : inRequest(E, action, fn));
    const out = [];
    E.user = 'mike';
    out.push(call('incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP })));
    out.push(call('incentive_send', () => E.send({ token: TOKEN, pp_start: PP, request_id: rid('S') })));
    out.push(call('incentive_send', () => E.send({ token: TOKEN, pp_start: PP, request_id: rid('S2') })));   // refused: pending
    E.user = 'sky';
    out.push(call('incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP })));
    out.push(call('incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP, confirm: 'yes', request_id: rid('A') })));
    out.push(call('incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP, confirm: 'yes', request_id: rid('A') })));   // replay
    out.push(call('incentive_approve', () => E.approve({ token: TOKEN, pp_start: PP, confirm: 'yes', request_id: rid('B') })));   // refused: closed
    const sheets = {};
    Object.keys(E.sheets).sort().forEach((n) => { sheets[n] = E.sheets[n].data; });
    return { results: JSON.stringify(out), sheets: JSON.stringify(sheets), mails: JSON.stringify(E.mails),
             events: JSON.stringify(E.events), pdfs: E.pdfs, backups: E.backups,
             recorded: [...E.cache.keys()].filter((k) => /^crewreq:/.test(k)).length };
  });
  const off = scenario('off');
  const on = scenario('on');
  const noGet = scenario('cache-get-throws');
  const noPut = scenario('cache-put-throws');
  ok('the scenario really exercised the pay engine (rows frozen, mail sent, a PDF and a backup made)',
     /"written":2/.test(off.results) && off.pdfs === 1 && off.backups === 1 && JSON.parse(off.mails).length >= 2);
  ok('timing really ran in the "on" run, and really failed in the failing ones',
     on.recorded === 1 && noGet.recorded === 0 && noPut.recorded === 0 && off.recorded === 0);
  [['on', on], ['with the cache read throwing', noGet], ['with the cache write throwing', noPut]].forEach(([label, run]) => {
    ok('timing ' + label + ': every reply is byte-identical to timing off', run.results === off.results);
    ok('timing ' + label + ': every sheet is byte-identical', run.sheets === off.sheets);
    ok('timing ' + label + ': the mail, and the order of locks, writes and flushes, are identical',
       run.mails === off.mails && run.events === off.events && run.pdfs === off.pdfs && run.backups === off.backups);
  });
}

/* ── 10. Static: where the hooks are, and where they are not ────────────────────────────────── */
console.log('\nWhere it is wired');
{
  const route = block('fn', 'route_');
  ok('route_ records in a finally, so no return and no throw can skip it', /finally\s*\{\s*reqEnd_\(\);/.test(route));
  ok('the read-back is gated on the deploy secret, in the router', /case 'request_stats':\s*if \(!deploySecretOk_\(p\)\) return json_\(\{ ok: false, error: 'bad deploy secret' \}/.test(route));
  const end = block('fn', 'reqEnd_');
  ok('reqEnd_ touches no sheet, lock, property or fetch', !/SpreadsheetApp|LockService|PropertiesService|UrlFetchApp|reqStatsFlush_|sheetOf_|crewSheet_/.test(end));
  const body = WANT.filter(([k, n]) => k === 'fn' && /^req/.test(n)).map(([k, n]) => block(k, n)).join('\n');
  ok('nothing in request timing takes a lock', !/LockService/.test(body));
  ok('nothing in request timing reaches the workbook through crewSheet_ or sheetOf_, which can create one', !/crewSheet_\(|sheetOf_\(|SpreadsheetApp\.create/.test(body));
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\nrequest timing: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
