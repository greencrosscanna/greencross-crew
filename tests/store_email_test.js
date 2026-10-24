#!/usr/bin/env node
/* ─── The store incentive email: right period, right people, same figures as the screen ──────────
 *
 *   RUN:  node tests/store_email_test.js
 *
 * WHY
 * The email carries every employee's name and pay, to a person, at 5am, with nobody watching. The
 * ways it goes wrong are all silent: the wrong period (Monday morning is when a fortnight is being
 * closed, and a report of two days of the NEW one reads as a quiet fortnight), a figure that differs
 * from the one on the screen, a recipient it should not have reached, or a request that finds a way
 * to read the same payload without signing in.
 *
 * Everything here drives the SHIPPED engine functions lifted out of apps-script/Code.gs — and the
 * browser's calcBud/calcMgr out of crew.js, which is what makes "same figures as the screen" a
 * comparison rather than a claim. WHAT MUST HOLD:
 *   1. First day of a pay period → the PREVIOUS period; every other day → the current one.
 *   2. Live rows are scored to the same bonus and payroll the screen computes (override applied
 *      after); a closed period is read as stored, never recomputed. Corporate and the admin get no
 *      table, and every store keeps its own people.
 *   3. Recipients: company-domain mailboxes only; a bad entry refuses the whole change; nobody set
 *      means nothing is sent.
 *   4. Preview sends nothing; send mails exactly the recipients; a failed build from the trigger
 *      mails a notice with NO figures in it.
 *   5. getIncentive_ cannot be told to skip sign-in by a request: only a function argument that
 *      carries the in-process marker does, and the router never passes one.
 *   6. There is still exactly one MailApp call in the engine.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i + 1, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function varLine(name) {
  const m = new RegExp('\\nvar ' + name + '\\s*=[^\\n]*;[^\\n]*\\n').exec(SRC);   // each is a one-line declaration
  if (!m) throw new Error('missing var ' + name);
  return m[0];
}

const LIFT = ['storeEmailPeriod_', 'storeEmailAddress_', 'storeEmailList_', 'storeEmailRecipients_',
  'storeEmailSetTo_', 'storeEmailModel_', 'storeEmailDates_', 'storeEmailHtml_', 'storeEmailBuild_',
  'sendStoreEmail_', 'storeIncentiveEmail', 'computedPeriods_', 'incCalcBud_', 'incCalcMgr_',
  'incPayroll_', 'incHours_', 'incSpiff_', 'storeEmailSpiffHtml_', 'storeEmailSpiffInner_',
  'storeEmailSpiffRead_', 'storeEmailSpiffModel_', 'spiffProgressFromCore_', 'spiffPublishedAgeMin_'];
const VARS = ['STORE_EMAIL_TO_PROP', 'LAST_STORE_EMAIL_PROP', 'STORE_EMAIL_AUTH_', 'ACCOUNT_DOMAIN',
  'STORE_TZ', 'CREW_URL', 'SPIFF_PUBLISHED_STALE_MIN'];

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(date, tz, pat) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return pat === 'yyyy-MM-dd HH:mm' ? p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute
                                    : p.year + '-' + p.month + '-' + p.day;
}

function world(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const mail = [];
  const calls = { getIncentive: [] };
  const FIXED = opts.now || Date.UTC(2026, 9, 12, 12);          // Mon 2026-10-12, noon UTC
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  const ctx = {
    Date: FakeDate, Object, String, Number, Math, JSON, Array, isFinite, RegExp, Intl,
    Utilities: { formatDate: fmtDate },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; } }) },
    GXCore: {
      getKv: (k) => ({ 'cfg.payPeriodAnchor': '2026-09-28', 'cfg.payPeriodDays': '14' })[k] || '',
      getStores: () => [{ store_id: 'bend', display_name: 'Century' }, { store_id: 'river-rd', display_name: 'River' },
                        { store_id: 'center', display_name: 'Center' }],
      publishedSpiffProgress: () => {
        if (!opts.spiffEnv) return { ok: false, error: 'GX Core has no published SPIFF for this period' };
        if (opts.spiffEnv === 'throw') throw new Error('library pin has no publishedSpiffProgress');
        return opts.spiffEnv;
      } },
    scrubSecrets_: (x) => x,
    sendMail_: (m) => { if (opts.mailThrows) throw new Error('mail refused'); mail.push(m); },
    getIncentive_: (p, auth) => {
      calls.getIncentive.push({ p, auth });
      return typeof opts.payload === 'function' ? opts.payload(p) : opts.payload;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(VARS.map(varLine).join('') + LIFT.map(fnSrc).join('\n'), ctx);
  return { ctx, props, mail, calls };
}

const T = { hoursPerPeriod: 80,
  budtender: { txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: [], aovTarget: 33, aovBonus: 25,
               discountMaxPct: 1.0, discountBonus: 25, attendanceBonus: 15 },
  manager: { salesTiers: [{ pct: 100, bonus: 100 }], discountTiers: [{ maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 }],
             aovTarget: 33, aovBonus: 50, teamAttendancePerHead: 25 },
  admin: { tiers: [{ pct: 100, bonus: 300 }], maxPerStore: 50 } };
const bud = (id, n, sid, slug, o) => Object.assign({ employee_id: id, name: n, store_id: sid, storeSlug: slug,
  txn: 250, sales: 9000, discount: 0.005, aov: 36, spiff_earned: 0 }, o || {});
const mgr = (id, n, sid, slug, target) => ({ employee_id: id, name: n, store_id: sid, storeSlug: slug,
  sales: 100000, target, discount: 0.008, aov: 35, spiff_earned: 0 });
const LIVE = { ok: true, source: 'live', thresholds: T, pp_start: '2026-10-12', pp_end: '2026-10-25',
  payPeriod: { start: '2026-10-12', end: '2026-10-25', current: true },
  budtenders: [bud('b1', 'Ann Bend', 'bend', 'bend'), bud('b2', 'Bee Bend', 'bend', 'bend'),
               bud('r1', 'Rae River', 'river-rd', 'river', { spiff_earned: 12 }), bud('r2', 'Roy River', 'river-rd', 'river'),
               bud('f1', 'Fay Floater', 'corporate', 'corporate')],
  managers: [mgr('mb', 'Mia Bend', 'bend', 'bend', 90000), mgr('mr', 'Moe River', 'river-rd', 'river', 120000)],
  admin: { employee_id: 'ad', name: 'Ada Admin', stores: 2, target: 1, actual: 1 },
  inputs: { b1: { att: true }, r1: { att: true }, r2: { att: true, payrollOverride: 7 } } };

console.log('\n1. Which period\n');
{
  /* The clock is set to the day asked about: the real send reads "today" and the period calendar
     from the same moment, and a test that lets them disagree is testing nothing. */
  const per = (iso) => { const [y, m, d] = iso.split('-').map(Number);
                         return world({ now: Date.UTC(y, m - 1, d, 12) }).ctx.storeEmailPeriod_(iso); };
  ok('Monday the 12th, first day of a period → the PREVIOUS one (2026-09-28)', per('2026-10-12').pp_start === '2026-09-28' && per('2026-10-12').which === 'previous');
  ok('Thursday the 15th → the current one', per('2026-10-15').pp_start === '2026-10-12' && per('2026-10-15').which === 'current');
  ok('Monday the 19th, mid-period → the current one (it is not a new period)', per('2026-10-19').pp_start === '2026-10-12');
  ok('Sunday the 11th, last day of the old period → that period', per('2026-10-11').pp_start === '2026-09-28');
  const w = world({ now: Date.UTC(2026, 9, 26, 12) });
  ok('Monday the 26th, the next boundary → previous = 2026-10-12', w.ctx.storeEmailPeriod_('2026-10-26').pp_start === '2026-10-12');
  const noAnchor = world(); noAnchor.ctx.GXCore.getKv = () => '';
  ok('no pay-period anchor says so instead of guessing', noAnchor.ctx.storeEmailPeriod_('2026-10-12').ok === false);
}

console.log('\n2. Same figures as the screen\n');
{
  /* The browser's own calcBud/calcMgr, out of crew.js. */
  let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
  const cut = src.lastIndexOf('})();');
  src = src.slice(0, cut) + '\n; return { calcBud, calcMgr, incPaid, incInput, incKey };\n' + src.slice(cut);
  src = src.replace('(function () {', 'return (function () {');
  const doc = { readyState: 'loading', currentScript: { src: 'crew.js?v=99' }, body: { classList: { add() {}, remove() {} } },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: { setProperty() {} }, classList: { add() {} }, setAttribute() {}, addEventListener() {}, appendChild() {} }),
    addEventListener() {} };
  const st = { getItem: () => '', setItem() {}, removeItem() {} };
  const B = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)(
    doc, { GXClient: () => ({ jsonp: async () => ({}) }), GXStores: { color: () => '' } }, st, st, { hostname: 'localhost' }, {});

  const w = world({ payload: LIVE });
  const model = w.ctx.storeEmailModel_(LIVE, (id) => id);
  const bend = model.find((s) => s.id === 'bend'), river = model.find((s) => s.id === 'river-rd');
  ok('two stores, no corporate table, no admin', model.length === 2 && !model.some((s) => s.id === 'corporate'));
  ok('each store has only its own people',
     bend.buds.map((r) => r.name).join() === 'Ann Bend,Bee Bend' && river.buds.map((r) => r.name).join() === 'Rae River,Roy River');
  const pay = (row, calc, inputs) => B.incPaid(calc.payroll == null ? calc.bonus : calc.payroll, B.incInput(inputs, B.incKey(row), row));
  let same = true;
  LIVE.budtenders.filter((b) => b.store_id !== 'corporate').forEach((b) => {
    const c = B.calcBud(b, T, LIVE.inputs);
    const row = model.map((s) => s.buds.find((r) => r.name === b.name)).find(Boolean);
    if (row.bonus !== c.bonus || row.payroll !== pay(b, c, LIVE.inputs) || row.spiff !== c.spiff) same = false;
  });
  ok('every budtender\'s bonus, SPIFF and payroll equal the screen\'s', same);
  let sameM = true;
  LIVE.managers.forEach((m) => {
    const c = B.calcMgr(m, T, LIVE.inputs, LIVE.budtenders);
    const row = model.map((s) => s.mgrs.find((r) => r.name === m.name)).find(Boolean);
    if (row.bonus !== c.bonus || row.payroll !== pay(m, c, LIVE.inputs) || row.team !== c.teamA || Math.abs(row.pct - c.pct) > 1e-9) sameM = false;
  });
  ok('every manager\'s bonus, % goal, team attendance and payroll equal the screen\'s', sameM);
  ok('a recorded payroll override is applied AFTER the calc ($7, not the computed figure)',
     river.buds.find((r) => r.name === 'Roy River').payroll === 7);
  ok('the store\'s payroll total is the sum of the payroll column', river.total === river.mgrs.concat(river.buds).reduce((a, r) => a + r.payroll, 0));

  const CLOSED = { ok: true, source: 'imported', pp_start: '2026-09-28', pp_end: '2026-10-11', thresholds: null,
    managers: [{ pdf_name: 'Moe River', store_id: 'river-rd', sales: 100000, target: 125000, discount_pct: 0.8, aov: 35, team_attendance: 55, spiff: 25, bonus: 777, payroll: 777 },
               { pdf_name: 'Mia Bend', store_id: 'bend', sales: 80000, target: null, discount_pct: 0.9, aov: 34, bonus: 640, payroll: 640 }],
    budtenders: [{ pdf_name: 'Rae River', store_id: 'river-rd', sales: 9000, discount_pct: 0.5, aov: 36, spiff: 12, bonus: 333, payroll: 333 }],
    admin: { pdf_name: 'Ada Admin', bonus: 300, payroll: 300 }, inputs: {} };
  const cm = w.ctx.storeEmailModel_(CLOSED, (id) => id);
  const cr = cm.find((s) => s.id === 'river-rd'), cb = cm.find((s) => s.id === 'bend');
  ok('a closed period prints the stored figures (777 / 333 — no calc could produce them)',
     cr.mgrs[0].payroll === 777 && cr.buds[0].payroll === 333 && cr.total === 1110);
  ok('target and % goal come from the record; a missing target is a dash, not an invented one',
     Math.abs(cr.mgrs[0].pct - 80) < 1e-9 && cb.mgrs[0].pct === null);
  const html = w.ctx.storeEmailHtml_(cm, { pp_start: '2026-09-28', dates: 'Sep 28 – Oct 11, 2026', status: 'as paid', warnings: [] });
  ok('the table is plain HTML a recipient can copy', /<table border="1"/.test(html) && html.includes('$125,000') && html.includes('80.0%'));
  ok('each store links to its live page by store id', html.includes('#incentive/2026-09-28/river-rd') && html.includes('#incentive/2026-09-28/bend'));
  ok('names are HTML-escaped', w.ctx.storeEmailHtml_([{ id: 'x', label: 'A<b>', mgrs: [], buds: [{ name: 'Tom <script>', sales: 1, disc: 1, aov: 1, bonus: 0, payroll: 0 }], total: 0 }],
     { pp_start: 'p', dates: 'd', status: 's', warnings: [] }).indexOf('<script>') < 0);
}

console.log('\n3. Who receives it\n');
{
  const w = world();
  ok('a bare mailbox name gets the company domain', w.ctx.storeEmailAddress_('mike') === 'mike@greencrosscanna.com');
  ok('an outside address is refused', w.ctx.storeEmailAddress_('mike@gmail.com') === '' && w.ctx.storeEmailAddress_('x@greencrosscanna.com.evil.io') === '');
  ok('setting Mike stores him and reads back', w.ctx.storeEmailSetTo_({ to: 'mike' }).ok && w.ctx.storeEmailRecipients_().join() === 'mike@greencrosscanna.com');
  const bad = w.ctx.storeEmailSetTo_({ to: 'mike,attacker@evil.io' });
  ok('one off-domain entry refuses the whole change and keeps what was set',
     bad.ok === false && w.ctx.storeEmailRecipients_().join() === 'mike@greencrosscanna.com');
  ok('an empty value clears it', w.ctx.storeEmailSetTo_({ to: '' }).ok && w.ctx.storeEmailRecipients_().length === 0);
  ok('no `to` just reads', w.ctx.storeEmailSetTo_({}).recipients.length === 0);
  const none = world({ payload: LIVE });
  const r = none.ctx.sendStoreEmail_({ send: 'yes' });
  ok('nobody set → nothing sent, and it says why', r.ok === false && none.mail.length === 0 && /nobody/.test(r.error));
  const off = world({ payload: LIVE, props: { STORE_EMAIL_TO: 'mike@greencrosscanna.com' } });
  const ro = off.ctx.sendStoreEmail_({ send: 'yes', to: 'someone@evil.io' });
  ok('a to= override off the company domain sends to nobody', ro.ok === false && off.mail.length === 0);
}

console.log('\n4. Preview, send, failure\n');
{
  const w = world({ payload: LIVE, props: { STORE_EMAIL_TO: 'mike' } });
  const pv = w.ctx.sendStoreEmail_({ today: '2026-10-15' });
  ok('preview sends nothing and carries no figures unless asked', pv.mode === 'preview' && w.mail.length === 0 && !('html' in pv));
  ok('Thursday asks getIncentive_ for the current period, with the in-process identity',
     w.calls.getIncentive[0].p.pp_start === '2026-10-12' && w.calls.getIncentive[0].auth.__system === true && w.calls.getIncentive[0].auth.role === 'viewer');
  ok('show=html returns the body in a preview', typeof world({ payload: LIVE, props: { STORE_EMAIL_TO: 'mike' } }).ctx.sendStoreEmail_({ show: 'html' }).html === 'string');
  const s = world({ payload: LIVE, props: { STORE_EMAIL_TO: 'mike' } });
  const rs = s.ctx.sendStoreEmail_({ send: 'yes', today: '2026-10-15', source: 'trigger' });
  ok('send=yes mails exactly the recipient, once', rs.ok && s.mail.length === 1 && s.mail[0].to === 'mike@greencrosscanna.com');
  ok('subject names the period and its status', /Oct 12 – Oct 25, 2026/.test(s.mail[0].subject) && /still running/.test(s.mail[0].htmlBody));
  ok('the last attempt is recorded for whoever checks', /"mode":"sent"/.test(s.props.CREW_LAST_STORE_EMAIL || ''));
  const dead = world({ payload: { ok: false, error: 'GX Core unreachable' }, props: { STORE_EMAIL_TO: 'mike' } });
  const rd = dead.ctx.sendStoreEmail_({ send: 'yes', source: 'trigger' });
  ok('a failed build from the trigger mails a notice naming the reason — and no figures',
     rd.ok === false && dead.mail.length === 1 && /GX Core unreachable/.test(dead.mail[0].body) && !dead.mail[0].htmlBody && !/\$/.test(dead.mail[0].body));
  const hand = world({ payload: { ok: false, error: 'x' }, props: { STORE_EMAIL_TO: 'mike' } });
  hand.ctx.sendStoreEmail_({ send: 'yes', source: 'editor' });
  ok('a hand-run failure mails nothing; the caller sees the error', hand.mail.length === 0);
  const empty = world({ payload: { ok: true, source: 'live', thresholds: T, budtenders: [], managers: [], inputs: {}, payPeriod: { current: true } }, props: { STORE_EMAIL_TO: 'mike' } });
  ok('a period with no store rows is an error, never an empty email', empty.ctx.sendStoreEmail_({ send: 'yes' }).ok === false && empty.mail.length === 0);
  const warn = world({ payload: Object.assign({}, LIVE, { coverage: { ok: false, missing: ['center'] } }), props: { STORE_EMAIL_TO: 'mike' } });
  warn.ctx.sendStoreEmail_({ send: 'yes' });
  ok('a missing store is said at the top of the email, not hidden', /may be missing/.test(warn.mail[0].htmlBody));
}

console.log('\n5. getIncentive_ cannot be told to skip sign-in by a request\n');
{
  const asked = [];
  const ctx = { Date, Object, String, Number, Math, JSON, Array,
    requireCrew_: (p) => { asked.push(p); return { ok: false, error: 'Auth required' }; },
    readTab_: () => { throw new Error('reached the data without signing in'); } };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('getIncentive_'), ctx);
  const a = ctx.getIncentive_({ __system: true, ok: true, user: 'x', role: 'admin' });
  ok('request parameters that look like the marker still go through sign-in', a.ok === false && asked.length === 1);
  const b = ctx.getIncentive_({}, { ok: true, user: 'x', role: 'admin' });
  ok('an argument without the in-process marker also goes through sign-in', b.ok === false && asked.length === 2);
  const b2 = ctx.getIncentive_({}, { ok: true, __system: 'true' });
  ok('and a string where the marker should be is not the marker', b2.ok === false && asked.length === 3);
  ok('the router passes ONE argument to getIncentive_', /case 'incentive':\s+return json_\(getIncentive_\(p\), p\.callback\)/.test(SRC));
  const callers = SRC.match(/(?<!function )getIncentive_\([^)]*,[^)]*\)/g) || [];
  ok('the only caller that passes a second argument is the store email', callers.length === 1 && /STORE_EMAIL_AUTH_/.test(callers[0]));
  ok('the system identity is read-only', /STORE_EMAIL_AUTH_ = \{ ok: true, user: 'store-email', role: 'viewer', __system: true \}/.test(SRC));
}

console.log('\n5b. SPIFF progress: read as published, never recomputed\n');
{
  /* Shaped like the real publication (GX Core published_spiff_progress, scope 2026-10-12): an
     envelope with published_at, around SPIFF's payload — rows keyed on store_id with units / target /
     hit, plus the programs sidecar with per-store goals. Names are made up. */
  const row = (pid, store, name, units, target, extra) => Object.assign({ program_id: pid, pay_period: '2026-10-12',
    store_id: store, employee_id: 40000 + units, name, units, target, hit: units >= target, earned: units >= target ? 50 : 0,
    vendor: 'Kaprikorn', program_name: 'All Products', start_date: '2026-10-12', end_date: '2026-10-25',
    refreshed_at: '2026-10-12 04:00:00', status: 'active' }, extra || {});
  const prog = (pid, status, goals) => ({ program_id: pid, vendor: 'Kaprikorn', program_name: pid === 'k-all' ? 'All Products' : 'Prerolls',
    status, start_date: '2026-10-12', end_date: '2026-10-25', product: 'All Kaprikorn products', payout: 50, payout_type: 'flat',
    store_goals: goals, bt_goals: goals, tips: [] });
  const env = (rows, programs, at) => ({ ok: true, producer: 'spiff', scope: '2026-10-12', published_at: at || '2026-10-12T11:00:00.000Z',
    age_minutes: 60, published_by: 'spiff', payload: { ok: true, pay_period: '2026-10-12', rows, by_employee: [], programs, last_programs: {} } });
  const props = { GX_DEPLOY_SECRET: 'fx' };
  const build = (spiffEnv) => world({ payload: LIVE, props, spiffEnv }).ctx.storeEmailBuild_({ pp_start: '2026-10-12' });

  const rows = [row('k-all', 'bend', 'Ann Bend', 14, 20), row('k-all', 'bend', 'Bee Bend', 22, 20, { display_name: 'Bee B.' }),
                row('k-pre', 'bend', 'Ann Bend', 3, 10, { program_name: 'Prerolls' })];
  const programs = [prog('k-all', 'active', { bend: 20, 'river-rd': 20 }), prog('k-pre', 'active', { bend: 10 }),
                    prog('k-draft', 'draft', { bend: 5 })];
  const b = build(env(rows, programs));
  const html = b.html, section = (store) => { const i = html.indexOf('>' + store + '</h3>'); const j = html.indexOf('<!--/spiff-->', i);
                                               return html.slice(html.indexOf('<!--spiff-->', i), j); };
  ok('the preview builds and carries a SPIFF section for every store', b.ok === true && (html.match(/<!--spiff-->/g) || []).length === 2);
  const c = section('Century');
  ok('units sold against each person\'s goal, as published ("14 / 20")', /Ann Bend<\/td><td align="right">14 \/ 20<\/td>/.test(c));
  ok('…and the display name wins where SPIFF sent one', /Bee B\.<\/td><td align="right">22 \/ 20/.test(c) && !/Bee Bend<\/td><td align="right">22/.test(c));
  ok('hit / not-yet indicator: "6 to go" and "Goal hit"', /6 to go/.test(c) && /Goal hit/.test(c));
  ok('a store running two programs shows both', /Kaprikorn — All Products/.test(c) && /Kaprikorn — Prerolls/.test(c) && /3 \/ 10/.test(c));
  ok('a draft program is not shown', !/k-draft/.test(c) && !/5 \/ /.test(c));
  ok('the as-of time is printed, in store time (Oct 12, 4:00 AM PT)', /as of Oct 12, 4:00 AM PT/.test(c));
  ok('fresh data raises no warning', b.meta.warnings.length === 0);
  const r = section('River');
  ok('a store SPIFF has a goal for but no measurement is UNAVAILABLE, not zeros',
     /Unavailable/.test(r) && /not zero/.test(r) && !/ 0 \/ /.test(r));
  ok('nothing is recomputed: a row whose hit flag disagrees with its units is shown as published, not re-judged',
     /Goal hit/.test(build(env([row('k-all', 'bend', 'Odd One', 30, 20, { hit: false })], programs)).html) === false);

  const none = build(env([], []));
  ok('no running program says so instead of an empty block',
     (none.html.match(/No SPIFF program is running at this store/g) || []).length === 2);
  const stale = build(env(rows, programs, '2026-10-09T11:00:00.000Z'));
  ok('data older than a day warns, and still prints its as-of time',
     stale.meta.warnings.some((x) => /out of date/.test(x)) && /as of Oct 9/.test(stale.html));
  const refused = build(null);
  ok('a publication that cannot be read marks every SPIFF section unavailable and warns',
     refused.ok === true && (refused.html.match(/SPIFF progress is unavailable right now/g) || []).length === 2 &&
     refused.meta.warnings.some((x) => /could not be read/.test(x)));
  const threw = build('throw');
  ok('a library that throws does not stop the pay figures from being emailed', threw.ok === true && /Ann Bend/.test(threw.html) && /\$/.test(threw.html));
  ok('the SPIFF section only READS the publication: the module has no second SPIFF calculation',
     !/storeEmailSpiff(Model|Read)_[^]*?(incCalc|applySpiffEarnings_)/.test(fnSrc('storeEmailSpiffModel_') + fnSrc('storeEmailSpiffRead_')));
}

console.log('\n6. One MailApp call, and the routes are gated\n');
{
  ok('exactly one MailApp.sendEmail in the engine (sendMail_)', (SRC.match(/MailApp\.sendEmail\(/g) || []).length === 1);
  ok('store_email is behind the deploy secret', /case 'store_email':\s+if \(!deploySecretOk_\(p\)\)/.test(SRC));
  ok('store_email_to is behind the deploy secret', /case 'store_email_to':\s+if \(!deploySecretOk_\(p\)\)/.test(SRC));
  ok('the trigger is Monday and Thursday at 05:00 store time',
     /newTrigger\('storeIncentiveEmail'\)\.timeBased\(\)\.onWeekDay\(ScriptApp\.WeekDay\.MONDAY\)\s+\.atHour\(5\)\.inTimezone\(STORE_TZ\)/.test(SRC) &&
     /newTrigger\('storeIncentiveEmail'\)\.timeBased\(\)\.onWeekDay\(ScriptApp\.WeekDay\.THURSDAY\)\s+\.atHour\(5\)\.inTimezone\(STORE_TZ\)/.test(SRC));
  ok('re-installing clears the store email trigger first, so it cannot double', /'approvalEscalationSweep',\s*'storeIncentiveEmail'\]/.test(SRC));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
