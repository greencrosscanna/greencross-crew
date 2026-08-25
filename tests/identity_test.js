#!/usr/bin/env node
/* ─── Crew identity + date invariants — tests ─────────────────────────────────────────────────────
 *
 *   RUN:  node tests/identity_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY THESE FOUR
 * Crew owns payroll and PII, and each of these is a documented invariant whose failure is silent:
 *
 *   nameToKey_             the key the whole suite joins people on. Drift here does not error — it
 *                          detaches a person from their own record.
 *   normDate_              "Dates are TEXT (YYYY-MM-DD)" is the suite's hardest rule; a Date object
 *                          crossing a sheet/script timezone boundary shifts a day and corrupts
 *                          hire dates and pay-period alignment.
 *   normBirthday_          must DISCARD the year. Crew publishes a celebrations feed to the kiosk
 *                          and raw DOB must never leave this app. A regression here is a PII leak
 *                          that looks like a working feature.
 *   mapPermissionLocation_ splits a Dutchie permission label and hands the middle segment to
 *                          GXCore.resolveStore. An unmatched label silently drops a person's store
 *                          rather than erroring — and because home_store is written through
 *                          writeAttrs_/gxWrite_, which replaces the whole row, "dropped" means
 *                          BLANKED on the next seed.
 *   statusToken_            folds Dutchie's `status` string, which decides whether a person is on
 *                          the roster at all.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so it tests shipped source.
 * Cannot reach Apps Script: .clasp.json rootDir is apps-script, so tests/ is out of clasp's scope.
 */
'use strict';
const fs = require('fs');

let RESOLVE = {}, RESOLVE_CALLS = [];

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  /*
   * GXCore.resolveStore is a LOOKUP TABLE here, deliberately not a reimplementation of Core's
   * matching. Crew stopped owning that logic on purpose; re-deriving it in the test would put a
   * third copy of the fold in the repo and let this file keep passing while the real resolver
   * changed underneath it. What is Crew's to get right is the half above the call — which slice
   * of the label gets handed over, and that a null comes back as '' — so the stub records its
   * argument and answers from a fixture, and the tests assert both.
   */
  GXCore:{ resolveStore(arg) { RESOLVE_CALLS.push(arg); return RESOLVE[String(arg == null ? '' : arg).trim()] || null; } },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => '', setProperty(){} }) },
  // formatDate must behave, not just exist: normDate_ falls through to it for anything that is not
  // already YYYY-MM-DD, so a lazy stub would make the Date-tolerance cases test nothing.
  Utilities:{ formatDate: (d) => {
    const p = n => String(n).padStart(2,'0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
  }},
};
const names = Object.keys(stubs);
let C;
try {
  C = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
    '\n; return { nameToKey_, normDate_, dateFromIso_, normBirthday_, statusToken_, mapPermissionLocation_, attrFields_, normPayType_, wageExempt_, PAY_TYPES, needsSetup_, SETUP_FLAGS, digestHtml_, displayNameOf_, digestRecipients_, accountEmail_, ATTR_HEADERS, EDITABLE_ATTRS };')(...names.map(n=>stubs[n]));
} catch (e) {
  console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
  console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
  process.exit(2);
}

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  if (got === want) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
};

// ── nameToKey_ ───────────────────────────────────────────────────────────────
console.log('\n1. nameToKey_ — the key the whole suite joins people on');
eq(C.nameToKey_('Sky Pinnick'),   'sky_pinnick',  'basic name');
eq(C.nameToKey_('  Sky Pinnick '),'sky_pinnick',  'surrounding whitespace does not change the key');
eq(C.nameToKey_('SKY PINNICK'),   'sky_pinnick',  'case does not change the key');
eq(C.nameToKey_("Shawn O'Brien"), 'shawn_obrien', 'apostrophes are stripped, not encoded');
eq(C.nameToKey_('J.T. Smith'),    'jt_smith',     'periods stripped — "J.T." and "JT" are one person');
eq(C.nameToKey_('Ana  Maria Ruiz'),'ana_maria_ruiz','a double space collapses to one underscore');
eq(C.nameToKey_(''),   '', 'empty stays empty');
eq(C.nameToKey_(null), '', 'null does not throw');

// ── normDate_ ────────────────────────────────────────────────────────────────
console.log('\n2. normDate_ — dates are TEXT, and never a shifted day');
eq(C.normDate_('2026-08-22'), '2026-08-22', 'canonical passes through');
eq(C.normDate_('2026-8-2'),   '2026-08-02', 'single digits are zero-padded, not left ragged');
eq(C.normDate_(''),        '', 'empty stays empty');
eq(C.normDate_(null),      '', 'null does not throw');
eq(C.normDate_('not a date'), '', 'garbage returns empty rather than a guess');
eq(C.normDate_('2026-13-01'), '', 'month 13 refused');
eq(C.normDate_('2026-00-10'), '', 'month 0 refused');
eq(C.normDate_('2026-02-32'), '', 'day 32 refused');
{
  // Sheets hands back a real Date when a cell was formatted as one — the exact source of the
  // timezone-shift corruption the TEXT rule exists to prevent.
  const got = C.normDate_(new Date(2026, 7, 22));
  eq(got, '2026-08-22', 'a real Date is normalised to TEXT on the SAME day');
}

/*
 * The exact string readAttrs_ produces from a date-formatted cell. It does String() over every
 * value, so a permit_expires Sheets stored as a real Date arrives looking like this — and the
 * roster row builder used to hand it to dateFromIso_ RAW. dateFromIso_ cannot read it, so
 * permit_days_left came back null, the UI printed "null days left" beside a date, and every
 * compliance check downstream went quiet: rowFlags_ skips permit_expired and reviewItems_ raises
 * neither permit_expired nor permit_expiring, because all three gate on days_left being a number.
 * A permit nobody is watching, reported as all clear.
 *
 * normDate_ has tolerated this since it was written; it simply was not being called. These pin
 * the whole chain rather than just the first link, because reading the value was never the part
 * that was broken -- COUNTING FROM IT was.
 */
{
  const SHEETS = 'Sat May 19 2029 00:00:00 GMT-0700 (Pacific Daylight Time)';
  eq(C.normDate_(SHEETS), '2029-05-19', "a date-formatted cell's String() form is normalised");
  eq(C.dateFromIso_(SHEETS) === null || C.dateFromIso_(SHEETS) === undefined, true,
     'and dateFromIso_ still cannot read it raw — which is why normDate_ has to run first');
  const d = C.dateFromIso_(C.normDate_(SHEETS));
  eq(!!d && d.getFullYear() === 2029 && d.getMonth() === 4 && d.getDate() === 19, true,
     'normDate_ then dateFromIso_ gives a real date, so days-left can be counted');
}

// ── pay_type ─────────────────────────────────────────────────────────────────
/*
 * Decides whether an empty `wage` is a GAP or a FACT, so getting it wrong is visible on the
 * roster as a permanent red mark on a complete record — which is exactly what happened before it
 * existed, on the two owners.
 *
 * The fallback matters as much as the parsing: `not_on_payroll` shipped hours earlier and was
 * written to at least one live row, so a person carrying only the old boolean must still come out
 * exempt. Empty means HOURLY, not "unknown" — hourly is what almost everyone is, and a third
 * unknown state would just be a gap wearing a different hat.
 */
console.log('\n2b. pay_type — is an empty wage a gap, or a fact?');
eq(C.normPayType_('hourly'), 'hourly', 'hourly');
eq(C.normPayType_('SALARY'), 'salary', 'case is normalised');
eq(C.normPayType_('  none '), 'none',  'whitespace trimmed');
eq(C.normPayType_(''),     '', 'empty stays empty — and empty MEANS hourly downstream');
eq(C.normPayType_(null),   '', 'null does not throw');
/* Closed set, like role_title, and for the same reason: a free-text pay basis is how a column
   payroll will one day group by ends up holding Salary, salaried and SAL. */
eq(C.normPayType_('Salaried'), '', 'an off-list value is refused, not stored');
eq(C.normPayType_('contractor'), '', 'and so is a plausible-sounding one');

eq(C.wageExempt_('hourly', ''), false, 'hourly staff SHOULD have a wage — an empty one is a gap');
eq(C.wageExempt_('', ''),       false, 'and so should someone with no pay type set');
eq(C.wageExempt_('salary', ''), true,  'salaried: there is no hourly rate to hold');
eq(C.wageExempt_('none', ''),   true,  'the owner takes nothing');
/* The legacy boolean still has to work — it was written to a live row before pay_type existed. */
eq(C.wageExempt_('', 'yes'),      true,  'legacy not_on_payroll still exempts');
eq(C.wageExempt_('hourly', 'yes'), false, 'but an explicit pay_type WINS over the old boolean');

// ── needsSetup_ — arrived, but never finished ────────────────────────────────
/*
 * Drives the roster's "New here" section AND the Monday digest, which is why it lives here rather
 * than in either of them.
 *
 * BOTH HALVES ARE LOAD-BEARING. A setup gap alone put Sky and Mike at the top of a list headed
 * "New here" — neither takes an hourly wage, so both carried a permanent `wage` gap, and nobody
 * in the company has been here longer. So it also takes a sign of recent arrival.
 */
console.log('\n2c. needsSetup_ — who actually just arrived?');
const TODAY = new Date(2026, 7, 25);
const NS = (o) => C.needsSetup_(Object.assign(
  { flags: [], retired: false, employee_number: '42', hire_date: '2019-03-04' }, o), TODAY);
eq(NS({ flags: [] }), false, 'a complete record is not new');
eq(NS({ flags: ['hire_date'], hire_date: '' }), true, 'no hire date — we cannot tell, so it needs a person');
eq(NS({ flags: ['employee_number'], employee_number: '' }), true, 'no number yet — turned up since the last run');
eq(NS({ flags: ['wage'], hire_date: '2026-08-01' }), true, 'started three weeks ago and has no wage');
/* THE OWNERS. */
eq(NS({ flags: ['wage'], hire_date: '2019-03-04' }), false,
   'a seven-year employee with no wage is NOT new — this is the bug the second half fixes');
eq(NS({ flags: ['store'], hire_date: '2019-03-04' }), false, 'nor one missing a store since 2019');
/* Only the gaps that mean "never set up". An imperfect record is not an unfinished one. */
eq(NS({ flags: ['shirt_size'], hire_date: '2026-08-01' }), false, 'a missing shirt size does not count');
eq(NS({ flags: ['birthday'], hire_date: '2026-08-01' }), false, 'nor a missing birthday');
eq(NS({ flags: ['permit'], hire_date: '2026-08-01' }), false, 'nor a missing permit');
eq(NS({ flags: ['hire_date', 'wage'], hire_date: '', retired: true }), false,
   'a retired record is never new, whatever it is missing');
/* The 90-day boundary, from both sides. */
eq(NS({ flags: ['wage'], hire_date: '2026-05-28' }), true,  '89 days ago is recent');
eq(NS({ flags: ['wage'], hire_date: '2026-05-26' }), false, '91 days ago is not');

// ── who receives the digest ──────────────────────────────────────────────────
/*
 * A per-person setting, not a list in the source. Two conditions and BOTH matter: opted in, and
 * has a GX account — the account is where the address comes from, so a preference without one
 * cannot be honoured and must not be treated as if it could.
 *
 * There is deliberately NO fallback list. "If nobody opted in, send to these people instead" would
 * mail somebody who had just switched it off, which is the one thing a preference must never do.
 */
console.log('\n2e. digestRecipients_ — a setting, not a list');
{
  const R = (o) => Object.assign({ retired: false, digest_opt_in: false, user_id: '' }, o);
  const rows = [
    R({ digest_opt_in: true,  user_id: 'sky' }),
    R({ digest_opt_in: false, user_id: 'mike' }),
    R({ digest_opt_in: true,  user_id: '' }),
    R({ digest_opt_in: true,  user_id: 'gone', retired: true })
  ];
  eq(JSON.stringify(C.digestRecipients_(rows)), '["sky@greencrosscanna.com"]',
     'only the opted-in, contactable, still-employed person');
  /* THE BUG THIS SHIPPED WITH. user_id is the MAILBOX NAME, not an address — createAccounts_
     derives it as email.split('@')[0]. Filtering for an '@' matched nobody, so the first live run
     silently unsubscribed everyone: the setting saved, read back true, and the list came out
     empty. An address has to be REASSEMBLED from the id, not read out of it. */
  eq(C.accountEmail_({ user_id: 'sky' }), 'sky@greencrosscanna.com',
     'a mailbox name becomes an address — this is what came out empty');
  eq(C.accountEmail_({ user_id: 'sky@greencrosscanna.com' }), 'sky@greencrosscanna.com',
     'and one that is already an address is left alone');
  eq(C.accountEmail_({ user_id: '' }), '', 'no account, no address');
  eq(C.accountEmail_({}), '', 'a row without the field does not throw');
  eq(C.digestRecipients_(rows.filter((r) => !r.digest_opt_in)).length, 0,
     'nobody opted in means nobody gets it — no fallback list');
  eq(C.digestRecipients_([]).length, 0, 'an empty roster does not throw');
  eq(C.digestRecipients_(null).length, 0, 'nor does a missing one');
}

// ── the Monday digest's HTML ─────────────────────────────────────────────────
/*
 * WHY THIS IS TESTED AT ALL, given it is "just an email". The first version shipped with the
 * newcomer card called with FOUR arguments instead of five, so every value slid one place left:
 * the person's name landed in the kickerColour slot and rendered as an invalid CSS colour (black
 * on a black card), and the line where the name belonged printed "Still needs wage." Six cards
 * went out, not one of them naming the person it was about, and nothing failed — a wrong-arity
 * call in JavaScript is a silent success.
 *
 * The colour assertion below is the general form of that bug: any CSS colour that is not a hex
 * literal means a value reached a slot meant for one.
 */
console.log('\n2d. digestHtml_ — the email says who it is about');
{
  const wes = { employee_id: 'wes_tanaka', name: 'Wes Tanaka', preferred_name: '',
                store: 'portland-rd', role: 'Budtender', role_is_default: false, flags: ['wage'] };
  const mari = { employee_id: 'marisol_vega', name: 'Marisol Vega', preferred_name: 'Mari',
                 store: 'bend', role: 'Budtender', role_is_default: false, flags: ['hire_date'] };
  const shawn = { employee_id: 'shawn_todd', name: 'Shawn Todd', preferred_name: '' };
  const html = C.digestHtml_({
    active: 43, gaps: 14, expiring: [1, 2, 3, 4, 5],
    questions: [{ kind: 'permit_expiring', severity: 'warn', employee_id: 'shawn_todd',
                  name: 'Shawn Todd', detail: 'Permit expires in 36 days.' }],
    fresh: [wes, mari],
    byId: { shawn_todd: shawn },
    stores: { 'portland-rd': 'Portland', bend: 'Century' }
  });

  eq(html.indexOf('Wes Tanaka') >= 0, true, 'a newcomer is NAMED — this is the bug that shipped');
  eq(html.indexOf('Still needs wage.') >= 0, true, 'and what they still need is stated');
  /* Nickname + surname, the same convention every other surface uses. */
  eq(html.indexOf('Mari Vega') >= 0, true, 'a nickname is used, like everywhere else');
  eq(html.indexOf('Marisol Vega') >= 0, false, 'and the legal name is not ALSO printed beside it');
  /* Store LABELS, not slugs. "PORTLAND-RD" is what the roster calls a database key. */
  eq(html.indexOf('Portland') >= 0, true, 'stores read as labels');
  eq(html.indexOf('portland-rd') >= 0, false, 'never as slugs');
  eq(html.indexOf('Shawn Todd') >= 0, true, 'an open question names its person too');

  /* THE GENERAL GUARD. Every CSS colour in this document is a hex literal; anything else means a
     value landed in a slot meant for a colour, which is precisely how the name went invisible. */
  const colours = html.match(/[^-a-z]color:\s*[^;"']+/g) || [];
  const bad = colours.filter((c) => !/color:\s*#[0-9a-fA-F]{3,8}$/.test(c.trim()));
  eq(bad.length, 0, 'every CSS colour is a hex literal' + (bad.length ? ' — GOT: ' + bad.join(' | ') : ''));
  eq(colours.length > 10, true, 'and there are colours to check, so the regex is not vacuous');
}

// ── normBirthday_ ────────────────────────────────────────────────────────────
console.log('\n3. normBirthday_ — must DISCARD the year (PII leaves this app as MM-DD only)');
eq(C.normBirthday_('1987-08-22'), '08-22', 'YYYY-MM-DD drops the year');
eq(C.normBirthday_('08-22'),      '08-22', 'MM-DD passes through');
eq(C.normBirthday_(''),   '', 'empty stays empty');
eq(C.normBirthday_(null), '', 'null does not throw');
{
  const out = C.normBirthday_('1987-08-22');
  const leaks = /19|20\d\d/.test(out);
  if (!leaks) { pass++; console.log('  PASS  no year survives — the celebrations feed cannot leak DOB'); }
  else { fail++; console.log('  FAIL  a year survived: ' + out); }
}

// ── statusToken_ ──────────────────────────────────────────────────────────────
console.log('\n4. statusToken_ — folds the status string Dutchie actually emits');
/*
 * This function WAS the store matcher, and Core's gxStoreToken_ is the byte-for-byte copy that
 * was lifted from it. Store matching now lives in GXCore.resolveStore; what is left here is the
 * `status` check that decides whether a person is on the roster at all, so that is what is tested.
 * The Rd/Road fold is still in the function and still a no-op on these two values — the cases below
 * pin the values the roster depends on, not the folding nothing calls any more.
 */
eq(C.statusToken_('Active'),     'active',     'the value that puts someone on the roster');
eq(C.statusToken_('In-Active'),  'in active',  'and the one that does not — punctuation collapses, and it is NOT "active"');
eq(C.statusToken_('  ACTIVE  '), 'active',     'case and padding collapse');
eq(C.statusToken_(''),           '',           'empty stays empty');
eq(C.statusToken_(null),         '',           'null does not throw');

console.log('\n5. mapPermissionLocation_ — split here, match in GX Core');
{
  const RIVER = { store_id:'river-rd', display_name:'River', dutchie_name:'River Rd' };
  RESOLVE = { 'River Rd': RIVER, 'Century Dr': { store_id:'bend' } };

  RESOLVE_CALLS = [];
  eq(C.mapPermissionLocation_('TLC Cannabis Emporium - River Rd - Green Cross'), 'river-rd',
     'the middle segment of a vendor label is what matches');
  eq(RESOLVE_CALLS[0], 'River Rd',
     'and the MIDDLE SEGMENT is what Core is asked about — not the whole label');

  RESOLVE_CALLS = [];
  eq(C.mapPermissionLocation_('River Rd'), 'river-rd', 'a bare name is passed through whole');
  eq(RESOLVE_CALLS[0], 'River Rd', 'a label with no " - " sandwich is handed over unsplit');

  // The reason for the switch: Core knows the registry's `aliases` column and Crew's own matcher
  // never did, so names staff actually use resolved everywhere in the suite except here.
  eq(C.mapPermissionLocation_('TLC - Century Dr - GC'), 'bend',
     'an ALIAS resolves — Century Dr IS the Bend store, which the old local matcher could not see');

  // The '' contract. Callers branch on it (`if (loc)`), and home_store goes out through a
  // whole-row write, so a null from Core must arrive as '' and never as 'null' or undefined.
  eq(C.mapPermissionLocation_('TLC - Nowhere - GC'), '',
     'an unknown store returns empty rather than guessing a store_id');
  eq(C.mapPermissionLocation_(''), '', 'empty label returns empty');
  eq(C.mapPermissionLocation_(null), '', 'null does not throw');
  eq(typeof C.mapPermissionLocation_('TLC - Nowhere - GC'), 'string',
     'the miss is a STRING — callers write it into a row, and undefined would blank it differently');

  // Core returns null rather than picking one when a name folds onto two stores. Crew must carry
  // that through as a miss: a confident wrong home_store is worse than a blank one.
  RESOLVE = {};
  eq(C.mapPermissionLocation_('TLC - Center - GC'), '',
     'an AMBIGUOUS name comes back null from Core and stays a miss here');

  // A row that resolves is read for store_id only, so a fuller Core row cannot leak extra fields.
  RESOLVE = { 'River Rd': RIVER };
  eq(C.mapPermissionLocation_('TLC - River Rd - GC'), 'river-rd', 'only store_id is taken off the row');
}

// ── attrFields_ — the carry-forward list ─────────────────────────────────────
console.log('\n6. attrFields_ — derived from the schema, so no writer can drop a column');
{
  const ok2 = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
  const f = C.attrFields_();

  ok2(f.indexOf('celebrations_opt_out') >= 0,
      'celebrations_opt_out IS carried — omitting it re-exposed people in the kiosk feed');
  ok2(f.indexOf('not_on_payroll') >= 0,
      'not_on_payroll IS carried — superseded by pay_type, but still read as a fallback, and '
      + 'writeAttrs_ writes the FULL row so dropping it would blank the rows that still hold it');
  ok2(f.indexOf('digest_opt_in') >= 0,
      'digest_opt_in IS carried — it is who receives the Monday recap, and writeAttrs_ writes the '
      + 'FULL row, so dropping it here silently unsubscribes everybody');
  ok2(f.indexOf('pay_type') >= 0,
      'pay_type IS carried — it decides whether an empty wage is a gap or a fact, so losing it '
      + 'puts a permanent false gap back on every salaried person and the owner');
  ok2(f.indexOf('employee_id') === -1, 'identity keys are excluded');
  ok2(f.indexOf('name_key') === -1,    'name_key excluded');
  ok2(f.indexOf('full_name') === -1,   'full_name excluded');
  ok2(f.indexOf('updated_at') === -1,  'audit stamps excluded');
  ok2(f.indexOf('updated_by') === -1,  'updated_by excluded');

  // THE regression guard: every non-identity, non-audit header must be carried. This is what makes
  // adding a column safe — writeAttrs_ writes the FULL row, so anything missing here is blanked.
  const identity = ['employee_id','name_key','full_name','updated_at','updated_by'];
  const missing = C.ATTR_HEADERS.filter(h => identity.indexOf(h) === -1 && f.indexOf(h) === -1);
  ok2(missing.length === 0,
      'EVERY attribute column is carried' + (missing.length ? ' — MISSING: ' + missing.join(', ') : ''));

  // And prove it is derived rather than a second hand-written list that happens to agree today.
  C.ATTR_HEADERS.push('zz_future_column');
  const after = C.attrFields_();
  ok2(after.indexOf('zz_future_column') >= 0,
      'a NEW column appears automatically — derived, not a copy that drifts');
  C.ATTR_HEADERS.pop();

  ok2(C.EDITABLE_ATTRS.indexOf('celebrations_opt_out') === -1,
      'EDITABLE_ATTRS stays a deliberate SUBSET — carried is not the same as user-editable');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
