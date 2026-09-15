#!/usr/bin/env node
/* ─── The backup approver is on standby until he is needed (2026-09-15) ─────────────────────────
 *
 *   RUN:  node tests/backup_approver_test.js
 *
 * Sky: "Shawn as backup, but I don't want him getting the email unless he's needed as the backup."
 * Then: "Shawn is not locked out on the approval … Mike can ping Shawn and ask him to approve rather
 * than having to wait 4 hours." Settled: Shawn may ALWAYS approve or send back; he is EMAILED only
 * while the approver is marked away or once a period has waited 4 hours; the approver is told
 * whenever he is brought in by the clock or decides anything. Real routes, via the pay harness.
 */
'use strict';
const { engine, WF } = require('./pay_engine_harness');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));
const PP = '2026-08-31';
let n = 0;
const rid = () => 'rq-backup-test-' + String(++n).padStart(6, '0');

function setup() {
  const E = engine(); E.seedClosed();
  E.primary = 'sky';
  E.kv['cfg.crewBackupApprover'] = 'shawn';
  return E;
}
function sendAs(E, who) { E.user = who; return E.send({ pp_start: PP, request_id: rid() }); }
function ageSend(E, hours) {
  const wf = E.wfGet(PP);
  E.wfSet(PP, { sent_at: new Date(Date.now() - hours * 3600000).toISOString() });
  return wf;
}
const toShawn = m => /shawn@/.test(m.to);
const toSky   = m => /sky@/.test(m.to);

console.log('\nAn ordinary fortnight — Shawn gets no email, but is NOT locked out');
{
  const E = setup();
  sendAs(E, 'mike');
  ok('the send went to the approver only', E.mails.length === 1 && toSky(E.mails[0]) && !toShawn(E.mails[0]));
  const sw = E.escalate({});
  ok('the sweep inside 4 hours sends Shawn nothing', sw.escalated.length === 0 && !E.mails.some(toShawn));
  ok('his screen offers Approve anyway — Mike can ping him', E.cover({ user: 'shawn' }, PP).can_decide === true);
  E.user = 'shawn';
  const r = E.approve({ pp_start: PP, confirm: 'yes', request_id: rid() });
  ok('Shawn approves without waiting 4 hours', r.ok && r.written === 2);
  const note = E.mails.find(m => toSky(m) && /Backup approved/.test(m.subject));
  ok('Sky is emailed that Shawn approved it', !!note && /shawn approved it as backup approver\./.test(note.html));
  ok('and Shawn himself was never emailed', !E.mails.some(toShawn));
  const mike = E.mails.find(m => /mike@/.test(m.to) && /^Approved/.test(m.subject));
  ok('Mike gets "carry on", naming Shawn as the approver', !!mike && /shawn/.test(mike.html));
}

console.log('\nShawn sends one back without any cover on');
{
  const E = setup();
  sendAs(E, 'mike');
  E.user = 'shawn';
  const b = E.ret({ pp_start: PP, note: 'Bend looks short', request_id: rid() });
  ok('it goes through', b.ok);
  ok('and Sky is told, with the reason', E.mails.some(m => toSky(m) && /Backup sent back/.test(m.subject) && /Bend looks short/.test(m.html)));
}

console.log('\nSomebody who is neither approver nor backup is still refused');
{
  const E = setup();
  sendAs(E, 'mike');
  E.user = 'tawny';
  ok('approve refused', !E.approve({ pp_start: PP, confirm: 'yes', request_id: rid() }).ok);
  ok('send back refused', !E.ret({ pp_start: PP, note: 'x', request_id: rid() }).ok);
  E.user = 'mike';
  ok('Mike, who prepared it, cannot approve it', !E.approve({ pp_start: PP, confirm: 'yes', request_id: rid() }).ok);
}

console.log('\nWaited 4 hours — the sweep brings Shawn in, once, and tells Sky');
{
  const E = setup();
  sendAs(E, 'mike');
  ageSend(E, 4.1);
  const sw = E.escalate({});
  ok('the sweep escalated the period', sw.escalated.length === 1 && sw.escalated[0].why === 'waiting');
  const shawnMail = E.mails.filter(toShawn);
  ok('Shawn got ONE email', shawnMail.length === 1);
  ok('it says backup approval is needed, and why', /Backup approval needed/.test(shawnMail[0].subject) && /4 hours/.test(shawnMail[0].html));
  ok('it carries the approve link with the period\'s token', /#approve\/2026-08-31\/tok[a-z0-9]+"/.test(shawnMail[0].html));
  ok('Sky was told his backup was called in', E.mails.some(m => toSky(m) && /Backup called in/.test(m.subject)));
  const before = E.mails.length;
  const again = E.escalate({});
  ok('the next sweep does not mail him again', again.escalated.length === 0 && E.mails.length === before);

  E.user = 'shawn';
  const r = E.approve({ pp_start: PP, confirm: 'yes', request_id: rid() });
  ok('Shawn\'s approval goes through', r.ok && r.written === 2);
  ok('Sky\'s notice says it had waited 4 hours', E.mails.some(m => toSky(m) && /Backup approved/.test(m.subject) && /after it waited 4 hours/.test(m.html)));
  ok('and Mike still gets his "carry on"', E.mails.some(m => /mike@/.test(m.to) && /^Approved/.test(m.subject)));
}

console.log('\nA period re-sent after being sent back escalates again on its own clock');
{
  const E = setup();
  sendAs(E, 'mike'); ageSend(E, 5); E.escalate({});
  E.user = 'sky';
  E.ret({ pp_start: PP, note: 'fix the SPIFF column', request_id: rid() });
  sendAs(E, 'mike');
  const fresh = E.escalate({});
  ok('a fresh send is not escalated immediately', fresh.escalated.length === 0);
  ageSend(E, 4.5);
  const later = E.escalate({});
  ok('but is, once IT has waited 4 hours', later.escalated.length === 1);
}

console.log('\nSky marks himself away');
{
  const E = setup();
  E.user = 'mike';
  ok('Mike cannot switch cover on', !E.away({ on: 'yes' }).ok);
  E.user = 'shawn';
  ok('neither can Shawn', !E.away({ on: 'yes' }).ok);
  E.user = 'sky';
  const on = E.away({ on: 'yes' });
  ok('Sky can', on.ok && on.away.on === true && on.away.by === 'sky');

  sendAs(E, 'mike');
  const m = E.mails[E.mails.length - 1];
  ok('a send while he is away reaches Shawn at once', toShawn(m) && toSky(m));
  const sw = E.escalate({});
  ok('and the sweep does not send Shawn a second copy', sw.escalated.length === 0 && E.mails.filter(toShawn).length === 1);
  ok('and Sky is NOT told his backup was "called in" — he asked for it', !E.mails.some(x => /Backup called in/.test(x.subject)));

  E.user = 'shawn';
  const b = E.ret({ pp_start: PP, note: 'a store is missing', request_id: rid() });
  ok('Shawn can send it back while Sky is away', b.ok);
  ok('and Sky is told, with the reason', E.mails.some(x => toSky(x) && /Backup sent back/.test(x.subject) && /a store is missing/.test(x.html)));

  E.user = 'sky';
  const off = E.away({ on: 'no' });
  ok('Sky switches it off', off.ok && off.away.on === false);
  const before = E.mails.filter(toShawn).length;
  sendAs(E, 'mike');
  ok('and the next send no longer emails Shawn', E.mails.filter(toShawn).length === before);
}

console.log('\nAway with a period ALREADY waiting — Shawn gets it now, not at the next tick');
{
  const E = setup();
  sendAs(E, 'mike');
  E.user = 'sky';
  const on = E.away({ on: 'yes' });
  ok('switching cover on sweeps immediately', on.sweep && on.sweep.escalated.length === 1 && E.mails.some(toShawn));
}

console.log('\nThings the backup does NOT cover');
{
  const E = setup();
  E.user = 'sky'; E.away({ on: 'yes' });
  const c = E.cover({ user: 'shawn' }, PP);
  ok('Shawn may decide, as backup', c.can_decide && c.as === 'backup');
  const S = require('fs').readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
  ok('canApprove_ still means the primary only (settings, reopen, overrides, voided)',
     /function canApprove_\(auth\) \{\s*var me[\s\S]{0,120}approverIds_\(\)\.indexOf\(me\) >= 0;\s*\}/.test(S));
  ok('the payroll override still checks canApprove_, not canDecide_', /wantsOverride && !canApprove_\(auth\)/.test(S));
  ok('reopening still checks canApprove_', /function incentiveUnapprove_[\s\S]{0,900}!canApprove_\(auth\)/.test(S));
  ok('the screen\'s can_approve stays canApprove_', /live\.can_approve = canApprove_\(auth\);/.test(S));
}

console.log('\nNo backup set — nothing changes');
{
  const E = setup(); E.kv['cfg.crewBackupApprover'] = '';
  sendAs(E, 'mike'); ageSend(E, 9);
  const sw = E.escalate({});
  ok('the sweep does nothing', sw.escalated.length === 0 && /no backup/.test(sw.note));
  E.user = 'sky';
  ok('and Sky cannot switch "away" on with nobody to cover', !E.away({ on: 'yes' }).ok);
  ok('someone named as BOTH is the primary, not a backup', (E.kv['cfg.crewBackupApprover'] = 'sky, shawn', E.escalate({}).backup.join()) === 'shawn');
}

console.log('\nForcing an escalation — practice periods only');
{
  const E = setup();
  ok('a real period cannot be forced', !E.escalate({ force_pp: PP }).ok);
  const P = 'practice-2026-08-17';
  E.user = 'mike'; E.send({ pp_start: P, request_id: rid() });
  const plain = E.escalate({});
  ok('an ordinary sweep ignores a pending practice period', !plain.escalated.some(x => x.pp_start === P));
  const f = E.escalate({ force_pp: P });
  ok('force_pp escalates it at once', f.ok && f.escalated.length === 1 && f.escalated[0].pp_start === P);
  ok('and the email is marked PRACTICE', E.mails.some(m => toShawn(m) && /^\[PRACTICE\] Backup approval needed/.test(m.subject)));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
