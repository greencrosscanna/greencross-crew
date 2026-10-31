#!/usr/bin/env node
/* ─── Crew's permit publisher sends exactly the contract shape ───────────────────────────────────
 *   RUN:  node tests/permit_publish_test.js
 *
 * WHY. Leaderboard's kiosk now asks GX Core for a person's own OLCC permit before it changes a face.
 * Core holds a keyed hash of what Crew publishes, so three failures here look like nothing at all:
 *   - a retired person's number is never blanked, so an old number keeps opening their face;
 *   - a short or failed read publishes a partial list that Core takes as the whole truth;
 *   - a permit number reaches a log, a property, a URL or a reply.
 * The contract (call, rows, blanks, failure codes) is the hub's core-admin note and the hub's
 * tests/permit_contract_test.js; this file is the PRODUCER's side of it, run against the real
 * functions lifted out of the shipped Code.gs over fake services.
 *
 * Every number below is a fixture. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
function lift(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' not found in Code.gs');
  let depth = 0, end = -1;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  return SRC.slice(at, end);
}

const SECRET = 'fx-secret-9q7z';
let PROPS, CALLS, MAILS, LOGS, CORE_ANSWER, EMPLOYEES, ATTRS, FETCHES;

function build() {
  PROPS = { GX_DEPLOY_SECRET: SECRET }; CALLS = []; MAILS = []; LOGS = []; FETCHES = [];
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in PROPS ? PROPS[k] : null),
      setProperty: (k, v) => { PROPS[k] = String(v); },
      deleteProperty: k => { delete PROPS[k]; } }) },
    CacheService: { getScriptCache: () => ({ remove() {}, get: () => null, put() {} }) },
    Logger: { log: s => LOGS.push(String(s)) },
    UrlFetchApp: { fetch: u => { FETCHES.push(u); throw new Error('Crew must not fetch Core by URL for this'); } },
    GXCore: {
      getEmployees: () => EMPLOYEES,
      publishPermits: (secret, rows, opts) => { CALLS.push({ secret, rows: JSON.parse(JSON.stringify(rows)), opts }); return CORE_ANSWER; },
    },
    readAttrs_: () => ATTRS,
    scrubSecrets_: s => String(s).split(SECRET).join('<secret>'),
    wfApproverEmails_: () => ['sky@greencrosscanna.com'],
    sendMail_: m => { MAILS.push(m); },
    bustPerfScreenCache_: () => {},
    ROSTER_CACHE_KEY: 'k', CORE_EMP_CACHE_KEY: 'k2',
  };
  vm.createContext(sandbox);
  vm.runInContext(['statusIsLive_', 'permitPublishRows_', 'publishPermitsNow_', 'permitPublishNotify_',
                   'publishPermitsIfDirty_', 'bustRosterCache_'].map(lift).join('\n') +
    "\nvar PERMIT_PUBLISH_PROP = 'CREW_LAST_PERMIT_PUBLISH'; var PERMIT_DIRTY_PROP = 'CREW_PERMITS_DIRTY';", sandbox);
  return sandbox;
}
const fixtures = () => {
  EMPLOYEES = [
    { employee_id: 'amy_active', status: 'active' },
    { employee_id: 'ben_blank', status: 'active' },
    { employee_id: 'cat_retired', status: 'retired' },
    { employee_id: 'dan_merged', status: 'merged' },
    { employee_id: 'eve_false', status: 'false' },
    { employee_id: 'fay_nostatus' },
    { status: 'active' },                               // no id: cannot be listed
  ];
  ATTRS = {
    amy_active: { permit_number: 'OLCC-0123 ab' },       // held oddly on purpose: must go as held
    ben_blank: { permit_number: '' },
    cat_retired: { permit_number: 'RET111' },
    dan_merged: { permit_number: 'MRG222' },
    eve_false: { permit_number: 'FLS333' },
    fay_nostatus: { permit_number: '0077123' },
  };
};
/* What the engine RECORDED: every property except the deploy secret, which is the real property under test. */
const recorded = () => JSON.stringify(Object.keys(PROPS).filter(k => k !== 'GX_DEPLOY_SECRET').map(k => PROPS[k]));
const ANSWER_OK = n => ({ ok: true, received: n, stored: n, unchanged: 0, cleared: 0, invalid: 0, unknown_employee_ids: [], published_at: '2026-10-30T20:00:00Z', verified: true });

console.log('\n1. the list is exactly the contract shape');
{
  fixtures(); const S = build();
  const rows = S.permitPublishRows_(EMPLOYEES, ATTRS);
  ok(rows.length === 6, 'one row per person with an id (the id-less one is not listed)');
  ok(rows.every(r => same(Object.keys(r).sort(), ['employee_id', 'permit_number'])), 'every row is { employee_id, permit_number } and nothing else');
  const by = id => rows.find(r => r.employee_id === id).permit_number;
  ok(by('amy_active') === 'OLCC-0123 ab', 'the number goes as the sheet holds it: not hashed, not normalized, not trimmed of its prefix');
  ok(by('fay_nostatus') === '0077123', 'leading zeros survive');
  ok(by('ben_blank') === '', 'an active person with no permit is sent blank');
  ok(by('cat_retired') === '' && by('dan_merged') === '' && by('eve_false') === '',
     'retired, merged and a false status are sent BLANK even though the sheet still holds a number');
  ok(S.permitPublishRows_([], ATTRS).length === 0 && S.permitPublishRows_(null, null).length === 0, 'no roster lists nobody');
}

console.log('\n2. the call: secret, rows, { by: "crew" }, one list, nothing by URL');
{
  fixtures(); const S = build(); CORE_ANSWER = ANSWER_OK(6);
  const r = S.publishPermitsNow_('nightly');
  ok(CALLS.length === 1, 'exactly one call per run');
  ok(CALLS[0].secret === SECRET && same(CALLS[0].opts, { by: 'crew' }), 'secret first, opts exactly { by: "crew" }');
  ok(same(CALLS[0].rows, S.permitPublishRows_(EMPLOYEES, ATTRS)), 'the rows sent are the full list, retired blanks included');
  ok(FETCHES.length === 0, 'Crew makes no fetch of its own');
  ok(r.ok === true && r.note.ok === true, 'a clean answer is ok');
  ok(!('CREW_PERMITS_DIRTY' in PROPS), 'success clears the dirty flag');
}

console.log('\n3. no permit number ever reaches a property, a log or a mail');
{
  fixtures(); const S = build(); CORE_ANSWER = Object.assign(ANSWER_OK(6), { unknown_employee_ids: ['ghost_id'] });
  const r = S.publishPermitsNow_('manual');
  const everything = recorded() + LOGS.join('|') + JSON.stringify(MAILS);
  ['OLCC-0123', '0123 ab', 'RET111', 'MRG222', 'FLS333', '0077123', SECRET].forEach(v =>
    ok(!everything.includes(v), 'recorded state holds no ' + (v === SECRET ? 'secret' : 'permit value') + ' (' + v.slice(0, 3) + '…)'));
  ok(!recorded().includes('ghost_id') && !everything.includes('ghost_id'), 'unknown ids are recorded as a COUNT, never named, in properties, logs and mail');
  ok(same(r.unknown_employee_ids, ['ghost_id']), '...but the deploy-secret route gets them back to act on');
}

console.log('\n4. an unknown id and a failure are surfaced, not swallowed');
{
  fixtures(); let S = build(); CORE_ANSWER = Object.assign(ANSWER_OK(6), { unknown_employee_ids: ['ghost_id'] });
  let r = S.publishPermitsNow_('manual');
  ok(r.note.attention === true && r.note.unknown === 1, 'a non-empty unknown_employee_ids needs attention');
  ok(MAILS.length === 1, 'and the approver is mailed');
  S.publishPermitsNow_('manual');
  ok(MAILS.length === 1, 'the same problem twice mails once');

  fixtures(); S = build(); CORE_ANSWER = { ok: false, code: 'roster_unreadable', error: 'Core read an empty employees tab' };
  r = S.publishPermitsNow_('nightly');
  ok(r.ok === false && r.note.code === 'roster_unreadable' && r.note.attention === true, 'ok:false carries Core\'s code through');
  ok(JSON.parse(PROPS.CREW_LAST_PERMIT_PUBLISH).code === 'roster_unreadable', 'the last run says why it failed');
  ok(MAILS.length === 1 && /needs a look/.test(MAILS[0].subject), 'a failure is mailed');

  fixtures(); S = build(); PROPS.CREW_PERMITS_DIRTY = '1'; CORE_ANSWER = { ok: false, code: 'unreachable', error: 'no answer after 3 tries' };
  S.publishPermitsNow_('after a roster change');
  ok(PROPS.CREW_PERMITS_DIRTY === '1', 'a failed run leaves the dirty flag set so the next sweep retries');
}

console.log('\n5. a bad read can never clear anyone');
{
  fixtures(); EMPLOYEES = []; let S = build(); CORE_ANSWER = ANSWER_OK(0);
  let r = S.publishPermitsNow_('nightly');
  ok(CALLS.length === 0 && r.note.code === 'empty_roster', 'an empty Core roster sends nothing');
  fixtures(); S = build(); delete PROPS.GX_DEPLOY_SECRET;
  r = S.publishPermitsNow_('nightly');
  ok(CALLS.length === 0 && r.note.code === 'no_secret', 'no secret sends nothing and says so');
  fixtures(); S = build(); S.GXCore.publishPermits = undefined;
  r = S.publishPermitsNow_('nightly');
  ok(r.note.code === 'library_too_old', 'an old pin says so rather than throwing');
  fixtures(); S = build(); S.GXCore.getEmployees = () => { throw new Error('boom ' + SECRET); };
  r = S.publishPermitsNow_('nightly');
  ok(CALLS.length === 0 && r.ok === false && !recorded().includes(SECRET), 'a throw is caught, sends nothing, and the secret is scrubbed from the record');
}

console.log('\n6. a roster write queues a publish; the sweep sends it');
{
  fixtures(); const S = build(); CORE_ANSWER = ANSWER_OK(6);
  ok(S.publishPermitsIfDirty_() === null && CALLS.length === 0, 'nothing queued: the sweep does nothing');
  S.bustRosterCache_();
  ok(PROPS.CREW_PERMITS_DIRTY === '1', 'bustRosterCache_ (every roster writer) queues a publish');
  const r = S.publishPermitsIfDirty_();
  ok(CALLS.length === 1 && r.ok === true && !PROPS.CREW_PERMITS_DIRTY, 'the sweep publishes once and clears the flag');
}

console.log('\n7. wiring and source guards');
{
  const body = ['publishPermitsNow_', 'permitPublishRows_', 'permitPublishNotify_', 'permitPublish_'].map(lift).join('\n');
  ok(!/metrcPermitKey_|toUpperCase|sha|hmac|Utilities\./i.test(lift('permitPublishRows_') + lift('publishPermitsNow_')),
     'the publisher does not hash or normalize: Core does, and metrcPermitKey_ is the hub\'s contract');
  ok(!/UrlFetchApp/.test(body), 'the publisher never fetches by URL');
  ok(/GXCore\.publishPermits\(secret, rows, \{ by: 'crew' \}\)/.test(lift('publishPermitsNow_')), 'the call is GXCore.publishPermits(secret, rows, { by: \'crew\' })');
  ok(!/Logger\.log\([^)]*rows/.test(body) && !/JSON\.stringify\(rows/.test(body), 'rows are never logged or stringified');
  ok(/publishPermitsNow_\('nightly'\)/.test(lift('nightlyDutchieScan')), 'the 5am trigger runs the full publish');
  ok(/publishPermitsIfDirty_\(\)/.test(lift('approvalEscalationSweep')), 'the 15-minute sweep sends a queued publish');
  ok(/case 'permit_publish':\s*return json_\(permitPublish_\(p\)/.test(SRC), 'the deploy-secret route is wired');
  ok(/deploySecretOk_\(p\)/.test(lift('permitPublish_')), 'and gated on the deploy secret');
  ok(/"version": "352"/.test(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'appsscript.json'), 'utf8')),
     'GXCore is pinned at 352 or later in the manifest');
}

console.log('\n─────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
