/*
 * WHO MAY SEE PAY — Sky, 2026-11-05: "can we make it so tawny doesn't see pay info?"
 *
 * A Crew grant opens the roster. Pay is a separate allowlist (Script Property CREW_PAY_VIEWERS, plus
 * the approver and backup approver). Someone with a grant but not on that list must get:
 *   - the roster with NO wage, pay_type, wage_exempt or not_on_payroll on any row, and no `wage` gap;
 *   - a refusal from every session-reachable incentive route and approver_away;
 *   - a refusal when they try to write a wage or a pay basis, and a roster_save reply with no wage.
 * And the people who DO see pay must see exactly what they saw before.
 *
 * Runs the WHOLE engine through its real router (tests/whole_engine_harness.js). The check is on what
 * the ENGINE sends — hiding a field in the browser while the engine still sends it is not a fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { SECRET, world } = require('./whole_engine_harness.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.CODE_GS || path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const CREW_JS = fs.readFileSync(path.join(ROOT, 'crew.js'), 'utf8');

let fail = 0, pass = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  console.log('\n' + (fail + 1) + ' FAILED (of ' + (pass + fail + 1) + ' reached)');
  process.exit(1);
});

/* Distinctive wages, so "does this text contain a wage" is a plain substring test. */
const WAGES = ['18.37', '29.91', '17.13'];
const ROWS = (attr) => [
  attr('sky_owner', { employee_number: '00', pay_type: 'none' }),
  attr('mike_prep', { employee_number: '01', wage: WAGES[1] }),
  attr('bea_bud',   { employee_number: '07', wage: WAGES[0] }),
  attr('bo_bud',    { employee_number: '08', wage: WAGES[2] }),
  attr('cy_bud',    { employee_number: '09' }),                  // a real `wage` gap
];
const PAY_KEYS = ['wage', 'pay_type', 'wage_exempt', 'not_on_payroll'];
const NO_PAY = /Pay figures are not shown to this account/;
const hasWage = (text) => WAGES.some((w) => text.indexOf(w) >= 0);

const W = world(SRC, { attrRows: ROWS });
const setViewers = (v) => { if (v == null) delete W.props.CREW_PAY_VIEWERS; else W.props.CREW_PAY_VIEWERS = v; };

console.log('pay access:');

// ── 1. Someone on the list sees pay exactly as before ───────────────────────────────────────────
setViewers('mike');
const rMike = W.get({ action: 'roster', token: 'T-mike' });
ok('a pay viewer gets the roster', rMike.ok === true);
ok('…with wages on it', (rMike.rows || []).some((r) => r.wage === WAGES[0]));
ok('…and pay_type', (rMike.rows || []).every((r) => 'pay_type' in r));
ok('…and no can_see_pay field at all (a pay viewer\'s reply is unchanged)', !('can_see_pay' in rMike));
ok('…and the real wage gap is still raised', ((rMike.rows || []).find((r) => r.employee_id === 'cy_bud') || {}).flags.indexOf('wage') >= 0);
ok('a pay viewer can open the incentive screen', W.get({ action: 'incentive', token: 'T-mike' }).ok === true);

// ── 2. A viewer NOT on the list: roster without pay ─────────────────────────────────────────────
const rDev = W.get({ action: 'roster', token: 'T-view', parts: 'review,eom_history' });
const devText = JSON.stringify(rDev);
ok('a grant without pay still gets the roster', rDev.ok === true && (rDev.rows || []).length > 0);
ok('…told can_see_pay: false', rDev.can_see_pay === false);
ok('…with no pay field on any row', (rDev.rows || []).every((r) => PAY_KEYS.every((k) => !(k in r))));
ok('…no wage anywhere in the reply, review and EoM parts included', !hasWage(devText));
ok('…and no `wage` gap on anyone', (rDev.rows || []).every((r) => (r.flags || []).indexOf('wage') < 0));
ok('…while the other gaps survive (cy_bud has no birthday)',
   ((rDev.rows || []).find((r) => r.employee_id === 'cy_bud') || {}).flags.indexOf('birthday') >= 0);
const rDevRet = W.get({ action: 'roster', token: 'T-view', include_retired: '1' });
ok('…retired rows included, still no wage', rDevRet.ok === true && !hasWage(JSON.stringify(rDevRet)));
// The roster cache is shared: the stripped copy must not have leaked back into it.
ok('the pay viewer\'s next roster still has wages (the strip did not touch the shared rows)',
   W.get({ action: 'roster', token: 'T-mike' }).rows.some((r) => r.wage === WAGES[0]));

// ── 3. An EDITOR not on the list (Tawny's likely grant): every pay route refuses ────────────────
setViewers('');
const ROUTER = SRC.slice(SRC.indexOf('function route_('), SRC.indexOf('function route_(') + 60000);
const incentiveRoutes = Array.from(new Set((ROUTER.match(/case '(incentive[a-z_]*)'/g) || [])
  .map((s) => s.slice(6, -1))));
ok('the router lists incentive routes to check (' + incentiveRoutes.length + ')', incentiveRoutes.length >= 12);
/* The session-reachable ones: their handler calls requireCrew_. Every other incentive route is
   deploy-secret only and refuses a session for that reason — checked below as well. */
const SESSION_PAY = ['incentive', 'incentive_save', 'incentive_att_batch', 'incentive_thresholds',
  'incentive_discounts', 'incentive_spiff_refresh', 'incentive_approve', 'incentive_practice_reset',
  'incentive_send', 'incentive_return', 'incentive_unapprove', 'incentive_voided', 'approver_away'];
SESSION_PAY.forEach((a) => {
  const r = W.get({ action: a, token: 'T-mike', pp_start: '2026-08-17', employee_id: 'bea_bud', confirm: 'yes' });
  ok('editor without pay: ' + a + ' refused as pay', r.ok === false && NO_PAY.test(String(r.error || '')));
  ok('…and its reply carries no wage', !hasWage(JSON.stringify(r)));
});
incentiveRoutes.concat(['approver_away']).forEach((a) => {
  const r = W.get({ action: a, token: 'T-mike', pp_start: '2026-08-17' });
  ok('editor without pay: ' + a + ' does not answer ok', r.ok !== true);
});
ok('a viewer without pay: incentive refused too', NO_PAY.test(String(W.get({ action: 'incentive', token: 'T-view' }).error || '')));

// ── 4. Writing pay is pay ───────────────────────────────────────────────────────────────────────
const before = W.book();
['wage', 'pay_type', 'not_on_payroll'].forEach((f) => {
  const q = { action: 'roster_save', token: 'T-mike', employee_id: 'bea_bud' };
  q[f] = f === 'wage' ? '99.99' : f === 'pay_type' ? 'salary' : 'yes';
  const r = W.get(q);
  ok('editor without pay: roster_save of ' + f + ' refused', r.ok === false && NO_PAY.test(String(r.error || '')));
});
ok('…and nothing was written', W.book() === before);
const sv = W.get({ action: 'roster_save', token: 'T-mike', employee_id: 'bea_bud', shirt_size: 'L' });
ok('a non-pay edit still saves', sv.ok === true && sv.saved && sv.saved.shirt_size === 'L');
ok('…its reply echoes no wage or pay basis', PAY_KEYS.every((k) => !(k in (sv.saved || {}))) && !hasWage(JSON.stringify(sv)));
ok('…and the stored wage is untouched', W.book().indexOf(WAGES[0]) >= 0);
setViewers('mike');
const sv2 = W.get({ action: 'roster_save', token: 'T-mike', employee_id: 'bea_bud', shirt_size: 'M' });
ok('a pay viewer\'s roster_save reply still carries the whole record', sv2.ok === true && sv2.saved.wage === WAGES[0]);

// ── 5. Approvers see pay without being listed; fails CLOSED for everyone else ───────────────────
setViewers(null);
const rSky = W.get({ action: 'roster', token: 'T-sky' });
ok('property unset: the approver still sees wages', rSky.ok === true && rSky.rows.some((r) => r.wage === WAGES[0]));
ok('property unset: the backup approver still sees wages', W.get({ action: 'roster', token: 'T-shawn' }).rows.some((r) => r.wage === WAGES[0]));
ok('property unset: the approver can open the incentive screen', W.get({ action: 'incentive', token: 'T-sky' }).ok === true);
ok('property unset: an editor who is neither approver nor listed sees NO pay', W.get({ action: 'roster', token: 'T-mike' }).can_see_pay === false);
W.kv['cfg.crewApprover'] = '';
W.kv['cfg.crewBackupApprover'] = '';
W.kvCache.clear();                  // GX Core's 60-second getKv copy would otherwise still say sky
ok('no approver configured and nobody listed: nobody sees pay', W.get({ action: 'roster', token: 'T-sky' }).can_see_pay === false);
W.kv['cfg.crewApprover'] = 'sky';
W.kv['cfg.crewBackupApprover'] = 'shawn';
W.kvCache.clear();

// ── 6. The setting itself ───────────────────────────────────────────────────────────────────────
ok('pay_viewers refuses without the deploy secret', W.get({ action: 'pay_viewers', token: 'T-sky', to: 'dev' }).ok === false);
ok('pay_viewers refuses a session trying to add itself', W.props.CREW_PAY_VIEWERS == null);
const set = W.get({ action: 'pay_viewers', secret: SECRET, to: 'Mike, shawn' });
ok('pay_viewers sets the list, lowercased', set.ok === true && W.props.CREW_PAY_VIEWERS === 'mike,shawn');
ok('pay_viewers reads it back', JSON.stringify(W.get({ action: 'pay_viewers', secret: SECRET }).pay_viewers) === '["mike","shawn"]');
ok('a bad entry refuses the whole change', W.get({ action: 'pay_viewers', secret: SECRET, to: 'mike,<x>' }).ok === false &&
   W.props.CREW_PAY_VIEWERS === 'mike,shawn');
ok('the list takes effect: mike sees wages again', W.get({ action: 'roster', token: 'T-mike' }).rows.some((r) => r.wage === WAGES[0]));
ok('an empty `to` clears it', W.get({ action: 'pay_viewers', secret: SECRET, to: '' }).ok === true && W.props.CREW_PAY_VIEWERS == null);

// ── 7. Never a name in code, and the browser follows the engine ─────────────────────────────────
const gate = SRC.slice(SRC.indexOf('function canSeePay_('), SRC.indexOf('function stripPayFromRow_('));
ok('the gate names no person', !/'(tawny|mike|shawn|sky)'/i.test(gate));
ok('crew.js drops the Incentive tab when can_see_pay is false', /t\[0\] !== 'incentive'/.test(CREW_JS) && /state\.canSeePay\s*=\s*r\.can_see_pay !== false/.test(CREW_JS));
ok('crew.js drops the wage card when can_see_pay is false', /o\.field !== 'wage'/.test(CREW_JS));

console.log('\npay access: ' + (fail ? fail + ' FAILED (of ' + (pass + fail) + ')' : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
