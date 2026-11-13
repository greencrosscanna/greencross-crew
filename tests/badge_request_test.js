/*
 * Badge request + P-Touch label files (2026-11-13).
 *   RUN:  node tests/badge_request_test.js
 *
 * Mike requests a badge from a person's record; Sky makes it and marks it made, which sets the
 * existing "Badge issued". Label files are built in the browser in the exact shape of Sky's
 * BadgeFront.csv / BadgeBack.csv. Two halves:
 *   1. the engine, through the real router (tests/whole_engine_harness.js)
 *   2. crew.js's pure label builders, loaded from the real file
 * Permit numbers are PII: nothing the engine mails, replies to a request with, or records may carry one.
 */
const fs = require('fs');
const path = require('path');
const { world } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const CREW = fs.readFileSync(path.join(ROOT, 'crew.js'), 'utf8');

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  process.exit(1);
});

const ATTR = 'crew_attributes';
const attrOf = (W, id) => {
  const d = W.sheets[ATTR].data, h = d[0];
  const row = d.find((r, i) => i > 0 && r[0] === id);
  if (!row) return null;
  const o = {}; h.forEach((k, i) => { o[k] = row[i] == null ? '' : String(row[i]); });
  return o;
};
const bad = (W, p) => W.get(Object.assign({ action: 'badge_request', token: 'T-mike', employee_id: 'bo_bud' }, p || {}));
const rowOf = (W, id) => (W.get({ action: 'roster', token: 'T-sky', include_retired: '1' }).rows || []).find((r) => r.employee_id === id);

console.log('\nThe columns');
{
  const W = world(SRC);
  const H = W.g('ATTR_HEADERS');
  ok('the three request columns are the LAST entries, in order (append-only)',
     H.slice(-3).join() === 'badge_requested_on,badge_requested_by,badge_request_kind' && H.indexOf('badge_issued') === H.length - 4);
}

console.log('\nRequesting');
{
  const W = world(SRC);
  const r = bad(W, { kind: 'new' });
  ok('a roster editor can request: ' + JSON.stringify(r), r.ok === true && r.request && r.request.kind === 'new' && r.request.by === 'mike');
  const a = attrOf(W, 'bo_bud');
  ok('three columns written, and nothing else disturbed', a.badge_requested_by === 'mike' && a.badge_request_kind === 'new' &&
     /^\d{4}-\d{2}-\d{2}$/.test(a.badge_requested_on) && a.middle_initial === 'R' && a.badge_issued === '');
  ok('the roster carries the pending request on that row only',
     rowOf(W, 'bo_bud').badge_request && rowOf(W, 'bo_bud').badge_request.by === 'mike' && !rowOf(W, 'bea_bud').badge_request);
  const again = bad(W, { kind: 'replacement' });
  ok('asking twice changes nothing (first request stands)', again.ok && again.already === true && attrOf(W, 'bo_bud').badge_request_kind === 'new');
  ok('a bad kind is refused', bad(world(SRC), { kind: 'gold' }).ok === false);
  ok('a read-only session is refused and writes nothing',
     (() => { const V = world(SRC); const b4 = V.book(); const x = bad(V, { token: 'T-view' }); return x.ok === false && V.book() === b4; })());
  ok('an unknown person is refused', bad(world(SRC), { employee_id: 'nobody_here' }).ok === false);
  ok('a retired person is refused', bad(world(SRC), { employee_id: 'old_bud' }).ok === false);
}

console.log('\nThe notice email — the approver only, and never a permit number');
{
  const W = world(SRC);
  W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'bo_bud', permit_number: 'R106Y7', permit_expires: '2027-03-24' });
  const n0 = W.mails.length;
  const r = bad(W);
  ok('one email was sent, to the approver', r.ok && W.mails.length === n0 + 1 && /^sky@/.test(W.mails[n0].to));
  const m = W.mails[n0];
  ok('it names the person and the kind', /Bo Budd/.test(m.subject) && /new/.test(m.subject));
  ok('it says what is missing, in words', /no permit issue date/.test(m.body) && !/no permit number/.test(m.body));
  ok('NO permit number or date is in the subject, body or html',
     !/R106Y7|2027|3\/24/i.test(m.subject + m.body + m.html));
  ok('a repeat request sends no second email', (bad(W), W.mails.length === n0 + 1));
  ok('the reply carries no permit number', !/R106Y7/.test(JSON.stringify(r)));
}

console.log('\nA failed email never fails the request');
{
  const W = world(SRC);
  W.sb.MailApp.sendEmail = function () { throw new Error('quota https://x?token=SECRET'); };
  const r = bad(W);
  ok('the request is saved and the reply says the notice failed — without the exception text',
     r.ok === true && attrOf(W, 'bo_bud').badge_requested_by === 'mike' &&
     /could not be sent/.test(r.mail_error || '') && !/SECRET/.test(JSON.stringify(r)));
}

console.log('\nWithdrawing and marking made');
{
  const W = world(SRC);
  bad(W);
  const c = bad(W, { op: 'cancel' });
  ok('withdraw clears all three columns and does NOT set the badge',
     c.ok && c.request === null && attrOf(W, 'bo_bud').badge_requested_on === '' && attrOf(W, 'bo_bud').badge_issued === '');
  ok('withdrawing with nothing pending is a harmless success', bad(W, { op: 'cancel' }).ok === true);
  ok('"made" with nothing pending is refused', bad(W, { op: 'done' }).ok === false);
  bad(W);
  const d = bad(W, { op: 'done' });
  const a = attrOf(W, 'bo_bud');
  ok('made: clears the request AND sets Badge issued', d.ok && d.badge_issued === true && a.badge_issued === 'yes' && a.badge_requested_on === '' && a.badge_request_kind === '');
  ok('the roster shows them issued with nothing pending', rowOf(W, 'bo_bud').badge_issued === true && !rowOf(W, 'bo_bud').badge_request);
  ok('a retried "made" that already landed is a success', (() => { const x = bad(W, { op: 'done' }); return x.ok === true && x.already === true; })());
  const rep = bad(W, { kind: 'replacement' });
  ok('an issued badge can be re-requested as a replacement; the old "issued" stays until it is made',
     rep.ok && rep.request.kind === 'replacement' && attrOf(W, 'bo_bud').badge_issued === 'yes');
}

console.log('\nEvery other roster writer carries the request (no silent blanking)');
{
  const W = world(SRC);
  bad(W);
  W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'bo_bud', shirt_size: 'L' });
  W.get({ action: 'roster_save', token: 'T-sky', employee_id: 'bo_bud', badge_issued: 'yes' });
  const a = attrOf(W, 'bo_bud');
  ok('roster_save of another field and of badge_issued keeps the pending request',
     a.badge_request_kind === 'new' && a.badge_requested_by === 'mike' && a.shirt_size === 'L');
  W.get({ action: 'roster_retire', token: 'T-sky', employee_id: 'bo_bud', retired: '1', retired_on: '2026-10-01' });
  ok('a retired person drops out of the pending list', !rowOf(W, 'bo_bud').badge_request);
}

console.log('\nThe label builders (crew.js)');
{
  let src = CREW;
  const cut = src.lastIndexOf('})();');
  src = src.slice(0, cut) + '\n; return { badgeFor, badgeFrontCsv, badgeBackCsv, badgeLeftOut, badgeDay, pendingBadges };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const fakeEl = () => ({ style: { setProperty() {} }, classList: { add() {} }, setAttribute() {}, addEventListener() {}, appendChild() {} });
  const document = { readyState: 'loading', currentScript: { src: 'crew.js?v=1' }, body: { classList: { add() {}, remove() {} } },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: fakeEl, addEventListener() {} };
  const window = { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' } };
  const ss = { getItem: () => '', setItem() {}, removeItem() {} };
  const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
    (document, window, ss, ss, { hostname: 'localhost' }, {});

  const nate = { employee_id: 'n', name: 'Nathaniel Quill', preferred_name: '', permit_number: 'r106y7', permit_granted: '2022-03-25', permit_expires: '2027-03-24', metrc_legal_name: 'Michael Reynolds' };
  // Sky's own reference files, byte for byte (BOM, CRLF, no final newline).
  /* BadgeFront.csv holds one name, but P-Touch Editor will not import a one-record database
     (Sky, 2026-11-13), so a single name is followed by a row holding one space. */
  ok('FRONT for one person: the legal first name, then a one-space row so P-Touch imports it',
     M.badgeFrontCsv([nate]) === '﻿FRONT\r\nNATHANIEL\r\n ');
  ok('two or more people get no padding row', M.badgeFrontCsv([nate, nate]) === '﻿FRONT\r\nNATHANIEL\r\nNATHANIEL');
  ok('BACK matches BadgeBack.csv: METRC legal name, permit, issued, expires — four rows, M/D/YY',
     M.badgeBackCsv([nate]) === '﻿BACK\r\nMICHAEL REYNOLDS\r\nR106Y7\r\n3/25/22\r\n3/24/27');
  ok('no trailing newline', !/\r\n$/.test(M.badgeBackCsv([nate])) && !/\r\n$/.test(M.badgeFrontCsv([nate])));
  ok('the file starts with a UTF-8 byte-order mark', Buffer.from(M.badgeBackCsv([nate]))[0] === 0xEF);
  ok('a nickname wins, and a trailing surname initial is dropped', M.badgeFrontCsv([{ name: 'Zach Babcock', preferred_name: 'Zach B' }]) === '﻿FRONT\r\nZACH\r\n ');
  ok('…but an initial that is not the surname stays', M.badgeFrontCsv([{ name: 'Zach Babcock', preferred_name: 'Zach R' }]) === '﻿FRONT\r\nZACH R\r\n ');
  const legal = { employee_id: 'l', name: 'Ana Lopez', permit_number: '1029288', permit_granted: '2026-01-08', permit_expires: '2031-01-08' };
  ok('without METRC, Crew\'s legal name is used', /ANA LOPEZ\r\n1029288\r\n1\/8\/26\r\n1\/8\/31$/.test(M.badgeBackCsv([legal])));
  const batch = M.badgeBackCsv([nate, legal]);
  ok('a batch is the same single column, four rows per person, in order', batch.split('\r\n').length === 1 + 8 && batch.split('\r\n')[5] === 'ANA LOPEZ');

  const noPermit = { employee_id: 'p', name: 'Pat Poe', permit_expires: '2027-01-01' };
  ok('missing data is named, not blank: ' + M.badgeFor(noPermit).missing.join(', '),
     M.badgeFor(noPermit).missing.join() === 'permit number,permit issue date' && !M.badgeFor(noPermit).backOk && M.badgeFor(noPermit).frontOk);
  ok('a person with anything missing is left OUT of the back file (never a blank strip)', M.badgeBackCsv([noPermit, nate]) === M.badgeBackCsv([nate]));
  ok('…but still prints on the front', M.badgeFrontCsv([noPermit, nate]) === '﻿FRONT\r\nPAT\r\nNATHANIEL');
  ok('…and is reported as left out', M.badgeLeftOut([noPermit, nate]).map((r) => r.employee_id).join() === 'p');
  ok('nobody printable -> an empty string, not an empty file', M.badgeBackCsv([noPermit]) === '' && M.badgeFrontCsv([]) === '');
  ok('a name with a comma is quoted', M.badgeFrontCsv([{ name: 'X', preferred_name: 'A,B' }]) === '﻿FRONT\r\n"A,B"\r\n ');
  ok('dates: an unreadable one is missing, not guessed', M.badgeDay('3/25/22') === '' && M.badgeDay('2022-03-05') === '3/5/22');
  ok('pending list: active only, oldest first',
     M.pendingBadges([{ employee_id: 'b', badge_request: { on: '2026-11-02' } }, { employee_id: 'a', badge_request: { on: '2026-11-01' } },
                      { employee_id: 'r', retired: true, badge_request: { on: '2026-10-01' } }, { employee_id: 'z' }]).map((r) => r.employee_id).join() === 'a,b');
}

console.log('\nSource guards');
{
  ok('the label builders never touch the network (no permit number reaches a request)',
     !/badgeFrontCsv[\s\S]{0,400}Engine\.jsonp/.test(CREW.slice(CREW.indexOf('function badgeDay'), CREW.indexOf('function gapGroups'))));
  ok('the engine route sends the person and the op, never a permit or a date',
     /var q = \{ token: token\(\), employee_id: row\.employee_id, op: op \};/.test(CREW));
  const eng = SRC.slice(SRC.indexOf('function badgeRequest_'), SRC.indexOf('// ─── Monday digest'));
  ok('the badge engine code logs nothing and records no timing detail', !/Logger\.log|console\.|setProperty|CacheService/.test(eng));
  ok('the only mail call is sendMail_', !/MailApp\.sendEmail/.test(eng) && /sendMail_\(/.test(eng));
  ok('every write busts the roster cache', /writeAttrs_\(rec\);\s*bustRosterCache_\(\);/.test(eng));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
