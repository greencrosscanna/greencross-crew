/**
 * ============================================================================
 *  GX Crew — HR / People backend  (Apps Script)
 *  App key: crew.  doGet/doPost router in the GX Core spoke style.
 *  Binds GXCore (the shared brain) for identity, sales metrics, SPIFF payouts.
 *  See ../CLAUDE.md for the architecture + build order.
 *
 *  BOUNDARY (do not blur this):
 *    • GX Core owns canonical employee IDENTITY — employee_id, full_name, home_store,
 *      role_title, status, hire_date. One writer, many readers. We READ it, never fork it.
 *    • GX Crew owns the RICH ATTRIBUTES — shirt size, birthday, work anniversary (and later
 *      OLCC/METRC permits, badges, SwipeClock). Those live in OUR sheet, keyed to Core's
 *      employee_id. This file is the system of record for them.
 *
 *  PII POSTURE (birthdays are PII — read before changing):
 *    • We store birthday as MM-DD ONLY. No birth year, ever. A year would give us age, which
 *      we have no business need for and no right to hold; MM-DD supports every celebration
 *      feature we actually want. `normBirthday_` strips a year if one is submitted.
 *    • Roster read/write require a GX Core session with a `crew` grant (GXCore.requireAuth).
 *      The web app itself is ANYONE_ANONYMOUS (Apps Script needs that for JSONP), so the
 *      auth gate in code is the ONLY thing standing between the open internet and staff PII.
 *      Every handler that touches attributes must go through requireCrew_().
 *    • `celebrations` is the ONE endpoint Leaderboard consumes and it is deliberately
 *      PII-free: derived flags (today/upcoming, days away, years of service) and never a
 *      raw date. That asymmetry is the whole point of the split — see CLAUDE.md.
 * ============================================================================
 */
var GXCORE_URL = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
var STORE_TZ   = 'America/Los_Angeles';

/** Crew's own spreadsheet (created on first use; id cached in ScriptProperties). */
var CREW_SHEET_ID_PROP = 'CREW_SHEET_ID';
var ATTR_TAB           = 'crew_attributes';
var ATTR_HEADERS       = ['employee_id', 'name_key', 'full_name', 'shirt_size',
                          'birthday', 'work_anniversary', 'employee_number', 'wage',
                          'permit_number', 'permit_granted', 'permit_expires', 'permit_status',
                          'celebrations_opt_out', 'not_on_payroll', 'pay_type', 'digest_opt_in',
                          'updated_at', 'updated_by',
                          /* APPENDED 2026-08-27, after ATTR_HEADERS' own rule: only ever append.
                             Payroll matches on the legal name and Capstone's sheet writes it
                             "Kettler Michael C", so the initial is a real field, not something to
                             parse out of full_name — most people simply do not have a middle name
                             recorded, and guessing one onto a payroll file is worse than leaving it
                             out. Crew owns it because it is an HR attribute; GX Core's identity
                             slice stays exactly as it is. */
                          'middle_initial',
                          /* APPENDED 2026-08-30. WorkforceHub's own employee code, which is how a
                             timecard export names a person — the file carries a code and a name and
                             nothing else we hold. Matching on the name alone works until somebody
                             marries, and then a fortnight of hours silently attaches to nobody.
                             CREW'S, NOT GX CORE'S: Phase 0 sketched a swipeclock_id column on the
                             registry, but nothing outside Crew consumes hours, and putting it in
                             Core would need a library cut and a re-pin in five spokes to deliver a
                             field one app reads. Crew owns the rich attributes; this is one. */
                          'swipeclock_code'];

/* The ATTRIBUTE columns — every ATTR_HEADER that is not an identity key or an audit stamp.
 *
 * DERIVED, NOT LISTED, and that is the whole point. writeAttrs_ writes the FULL row: it maps over the
 * sheet's headers and writes '' for anything the record omits. So any writer that rebuilds a record
 * from a hand-written field list silently BLANKS every column missing from that list.
 *
 * That already happened. `celebrations_opt_out` was added to ATTR_HEADERS but not to the four
 * hand-written lists, so assigning or setting an employee number cleared it — and the person
 * reappeared in the all-staff kiosk celebrations feed. The flag's own comment names the victim: Sky
 * holds employee_number 00 and rings nothing, so `assign_numbers` re-exposed exactly the person it
 * was written to protect.
 *
 * Deriving it means the next column added to ATTR_HEADERS is carried by every writer automatically,
 * instead of being dropped by whichever one nobody remembered to update.
 */
var ATTR_IDENTITY_COLS = ['employee_id', 'name_key', 'full_name'];
var ATTR_AUDIT_COLS    = ['updated_at', 'updated_by'];
function attrFields_() {
  return ATTR_HEADERS.filter(function (h) {
    return ATTR_IDENTITY_COLS.indexOf(h) === -1 && ATTR_AUDIT_COLS.indexOf(h) === -1;
  });
}

/* celebrations_opt_out: 'yes' keeps someone out of the kiosk celebrations feed.
 *
 * WHY A FLAG AND NOT A RULE. Some people are on the roster for ACCESS rather than for work —
 * Sky is the owner, holds employee_number 00, and rings nothing — and the all-staff kiosk
 * announcing his work anniversary is wrong. Every property that could be used to infer this
 * belongs to real staff too: `corporate` is Mike's and Tawny's home_store, and `Admin` is a
 * role people actually hold. So it cannot be derived; somebody has to say it.
 *
 * OPT-OUT, NOT OPT-IN, so an empty column means celebrate — every existing row keeps working
 * and a new hire is never silently left out by a field nobody knew to set.
 *
 * SCOPE: celebrations ONLY. It deliberately does not touch EoM eligibility, perks, or payroll,
 * because "don't announce my birthday on the kiosk" and "cannot be Employee of the Month" are
 * different claims and one should not quietly imply the other. If those need it, read it there
 * on purpose. */

/* Review queue. Conflicts are DETECTED live, never stored — the roster is the truth and a
 * stale conflict list would be worse than none. What IS stored is the DECISION, so a resolved
 * item stops resurfacing while a genuinely changed one comes back. */
var REVIEW_TAB      = 'crew_reviews';      // items reported by an import (HR/METRC, not engine-reachable)
var REVIEW_HEADERS  = ['review_id', 'kind', 'employee_id', 'name', 'field',
                       'current_value', 'proposed_value', 'source', 'detail', 'reported_at'];
var DECISION_TAB     = 'crew_decisions';   // what a human already ruled on
/* People Dutchie says work here that the registry has never heard of. Its OWN tab, deliberately
   not crew_reviews: reportConflicts_ replaces that one wholesale, so a nightly writer sharing it
   would delete every hand-filed item each time it ran. */
var PENDING_TAB      = 'crew_pending_hires';
var PENDING_HEADERS  = ['name_key', 'full_name', 'home_store', 'role_title',
                        'dutchie_employee_id', 'first_seen', 'last_seen'];
var DECISION_HEADERS = ['decision_key', 'kind', 'employee_id', 'field', 'chose',
                        'value', 'decided_by', 'decided_at', 'note'];

/** Alias tab: names that have been merged away, so an import never re-splits a person. */
var ALIAS_TAB     = 'crew_aliases';
var ALIAS_HEADERS = ['alias_key', 'alias_name', 'employee_id', 'merged_at', 'merged_by'];

/* Employee of the Month, one row per reign. APPEND-ONLY: a reign is never edited to record its
 * end, because the end is simply the moment the next row begins. A row with a blank employee_id
 * is the "deliberately nobody" marker — the same distinction cfg.eom draws by holding an empty
 * value rather than being deleted — and it closes the reign before it. */
var EOM_TAB     = 'crew_eom_history';
var EOM_HEADERS = ['employee_id', 'name', 'started_at', 'set_by', 'recorded_at', 'source'];

/** Attributes a manager may edit from the roster UI. Everything else is import-owned. */
var EDITABLE_ATTRS = ['shirt_size', 'birthday', 'work_anniversary', 'employee_number', 'wage'];

/* pay_type: how this person is paid, and therefore whether an empty `wage` is a GAP or a FACT.
 *
 *   ''  / 'hourly'  the default. `wage` is their hourly rate and its absence is a real gap.
 *   'salary'        salaried. There is no hourly rate to hold, so an empty wage is correct.
 *   'none'          not on payroll at all — the owner.
 *
 * A CLOSED SET, checked server-side like role_title, for the same reason: a free-text pay basis
 * is how you end up with 'Salary', 'salaried' and 'SAL' in a column that payroll will one day
 * group by. Empty means hourly rather than "unknown", because hourly is what almost everyone is
 * and an unknown third state would just be a gap wearing a different hat.
 *
 * This REPLACES the not_on_payroll boolean shipped hours earlier, which was too blunt: it made
 * "no hourly wage" and "not on payroll" the same statement, and they are not. Mike, Tawny and
 * Shawn are salaried — very much ON payroll — while Sky the owner takes nothing (Sky, 2026-08-25).
 * The old column is still read as a fallback meaning 'none' so the one row that used it keeps
 * working; ATTR_HEADERS only ever appends, so it stays in the sheet either way. */
var PAY_TYPES = ['hourly', 'salary', 'none'];
function normPayType_(v) {
  var t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return '';
  return PAY_TYPES.indexOf(t) >= 0 ? t : '';
}
/** True when an empty wage is CORRECT for this person rather than missing. */
function wageExempt_(payType, legacyNotOnPayroll) {
  var t = normPayType_(payType);
  if (t) return t !== 'hourly';
  return isTruthyFlag_(legacyNotOnPayroll);
}

/* not_on_payroll (LEGACY, superseded by pay_type above): 'yes' meant an empty `wage` is correct.
 *
 * Same shape of problem as celebrations_opt_out above, same answer, and for the same person. Sky
 * is the owner and takes no hourly wage; Mike is the other. rowFlags_ raised a `wage` gap on both
 * of them forever — a permanent red mark on a record that is complete, counted in "records with a
 * gap", and (until this flag) enough to put the two longest-serving people in the company at the
 * top of a list headed "New here".
 *
 * WHY A FLAG AND NOT A RULE, again. Every property that could be used to infer it belongs to real
 * waged staff too: `Admin` is a role people hold and `corporate` is a home_store people work at.
 * A rule keyed on either would silently stop flagging a missing wage for staff who should have
 * one, which is a worse failure than the one it fixes — it hides a real gap instead of showing a
 * false one. Somebody has to say it, per person, once. */

/*
 * The HR workbook is NO LONGER THE SOURCE OF TRUTH (Sky, 2026-08-18). GX Crew — backed by the
 * GX Core registry — is. The spreadsheet is kept only as the historical record it came from.
 *
 * This is not just a label change. An import from a superseded source must be structurally
 * incapable of overturning curated data: re-sending the sheet is exactly how four role
 * corrections were silently reverted minutes after being made. hrImport_ therefore defaults to
 * FILL mode — it writes a field only where the current value is EMPTY. Overwriting now takes an
 * explicit mode=overwrite, which nothing routine should ever pass.
 */
var HR_SHEET_URL = '';   // no longer surfaced in the UI; Crew is the record

/** Allowed shirt sizes. Kept server-side so the UI can't write junk into payroll-adjacent data. */
var SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

/*
 * THE ROLE VOCABULARY. Four titles, and role_title is a closed set — the roster offers these
 * as a dropdown and the engine refuses anything else, so a role can never arrive misspelled or
 * in a variant nobody else recognizes.
 *
 * It has to be enforced here and not only in the UI. role_title is GX Core identity, read by
 * Leaderboard and SPIFF, and Crew is its only writer — but not through one door: the roster
 * panel, hr_import, the Dutchie seed and the review queue all reach role_title. A dropdown
 * closes exactly one of those.
 *
 * Ranked most senior first; the roster orders the dropdown this way rather than alphabetically.
 */
var ROLE_TITLES = ['Admin', 'Store Manager', 'Assistant Manager', 'Budtender'];

/*
 * Who "manager" means for the account rule. Copied deliberately from GX Core's identity_health
 * rather than rebuilt from ROLE_TITLES, so the two stay one definition: a regex over the title
 * matches 'Store Manager' and 'Assistant Manager', and keeps matching a non-canonical variant
 * like 'Assistant Store Manager' that reached Core without passing through normRole_.
 */
var MANAGER_ROLE_RE = /manager/i;

/*
 * Names other systems use for the same four jobs. Dutchie's permission groups and the old HR
 * sheet each spell them their own way, and "Assistant Store Manager" is not a fifth role — it
 * is this one, typed differently. Mapping is how an import stays useful without being allowed
 * to widen the vocabulary. Keys are lower-cased and space-collapsed.
 */
/*
 * PROTOTYPE-LESS ON PURPOSE (pricecards' finding, suite-wide fix in GXCore v170).
 * A LOOKUP TABLE IS NOT A WHITELIST. Every plain object inherits constructor, __proto__, toString,
 * valueOf, hasOwnProperty and isPrototypeOf, so those names pass ANY map lookup as truthy.
 * Measured here before fixing: normRole_('constructor') returned Object's constructor FUNCTION and
 * normRole_('__proto__') returned an object — both truthy, so both sailed through the guard whose
 * whole job is to refuse a title that is not one of the four, and would have been written into
 * role_title, the field Leaderboard renders and SPIFF groups by. 'toString' and 'valueOf' missed
 * only because the lookup lowercases first, which is luck, not a defense.
 *
 * Fixed on the MAP rather than at each call site: a null-prototype object inherits nothing, so
 * every present and future lookup is safe by construction. Patching lookups one by one leaves the
 * next call site to get it wrong.
 */
var ROLE_ALIASES = Object.assign(Object.create(null), {
  'administrator':            'Admin',
  'admin manager':            'Admin',
  'store mgr':                'Store Manager',
  'general manager':          'Store Manager',
  'assistant store manager':  'Assistant Manager',
  'asst store manager':       'Assistant Manager',
  'asst. store manager':      'Assistant Manager',
  'assistant mgr':            'Assistant Manager',
  'asst manager':             'Assistant Manager',
  'assistant general manager':'Assistant Manager',
  'inventory coordinator':    'Assistant Manager',   // Sky's ruling, 2026-08-20
  'bud tender':               'Budtender',
  'budtenders':               'Budtender',
  'sales associate':          'Budtender'
});

/**
 * Canonicalise a role title, or return '' if it is not one of the four.
 *
 * '' is the honest answer for an unknown title and callers must treat it as a refusal, not as
 * "no role" — silently writing '' would erase a title someone deliberately set.
 */
function normRole_(v) {
  var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (var i = 0; i < ROLE_TITLES.length; i++) {
    if (ROLE_TITLES[i].toLowerCase() === s.toLowerCase()) return ROLE_TITLES[i];
  }
  return ROLE_ALIASES[s.toLowerCase()] || '';
}

/** How far ahead `celebrations` looks. Kiosk wants "today + coming up this week or so". */
var CELEBRATION_HORIZON_DAYS = 14;

/* The Monday digest's own window, deliberately SHORTER than the kiosk's 14.
 *
 * The kiosk is looked at all day and wants a bit of runway. The digest arrives once a week, so a
 * 14-day window prints every birthday in TWO consecutive Mondays — and a reader who learns that
 * half the list is a repeat starts skimming the whole email, which is the one thing this digest
 * cannot afford. Seven days is Monday through Sunday: each celebration appears exactly once, in
 * the week it happens.
 *
 * SEVEN DAYS MEANS TODAY PLUS THE NEXT SIX, so the comparison below is `< days`, not `<= days`.
 * Inclusive-of-seven reaches next Monday from this Monday — an eight-day window that reintroduces
 * the duplicate on the one day it matters most, the day the next digest sends. */
var DIGEST_CELEBRATION_DAYS = 7;

function doGet(e)  { return route_(e); }
function doPost(e) { return route_(e); }

function route_(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'health';
  var body = null;
  if (e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); } catch (err) { body = null; }
  }
  try {
    switch (action) {
      // Bulk HR import. POST only — the payload is the whole roster and cannot fit in a query
      // string, and this writes both the shared registry and Crew's attributes.
      case 'hr_import': return json_(hrImport_(p, body), p.callback);

      // One-time-ish migration of Leaderboard's nickname + avatar maps into Core display fields.
      case 'migrate_leaderboard': return json_(migrateLeaderboard_(p, body), p.callback);

      // `lib` is the GXCore version this DEPLOYMENT actually runs, not the one appsscript.json
      // reads today — a library call executes the snapshot the live deployment pinned, so the
      // manifest in git can say 155 while the deployed engine still runs 152. This is the only
      // way to tell from outside. Guarded because libVersion() itself only exists from v139.
      case 'health':
        var lib_ = null;
        try { lib_ = GXCore.libVersion(); } catch (e) { lib_ = 'pre-139'; }
        return json_({ ok: true, app: 'crew', lib: lib_, ts: new Date().toISOString() }, p.callback);

      // The SUITE-STANDARD spelling of the question `health` already answers (inventory, 2026-08-20).
      // Kept as a separate route rather than folding into health because the point is that ONE curl
      // works across every spoke: a fleet check that has to special-case Crew's response shape is
      // the thing this route exists to avoid. Pre-auth on purpose — needing a session to ask "what
      // version am I running" is the kind of friction that means nobody asks.
      //
      // An old pin IDENTIFIES ITSELF instead of throwing. A pre-v153 library has no libVersion(),
      // and letting that blow up would break the diagnostic exactly when it is most needed: a 500
      // says nothing about WHICH version you are on. Reported as data, so the route always answers.
      case 'libversion':
        return json_(libVersion_(), p.callback);

      // ── Roster (auth-gated — holds PII) ─────────────────────────────────────
      case 'roster':       return json_(getRoster_(p), p.callback);
      case 'roster_save':  return json_(saveRosterAttrs_(p), p.callback);
      case 'roster_retire':return json_(setRetired_(p), p.callback);
      case 'roster_identity': return json_(saveIdentity_(p), p.callback);
      case 'roster_merge': return json_(mergeEmployees_(p), p.callback);
      case 'assign_numbers': return json_(assignNumbers_(p), p.callback);
      case 'set_number':     return json_(setNumber_(p), p.callback);
      case 'email_proposals': return json_(emailProposals_(p), p.callback);

      // ── METRC connector (worker permits) ───────────────────────────────────
      case 'metrc_health': return json_(metrcHealth_(p), p.callback);
      case 'metrc_setup':  return json_(metrcSandboxSetup_(p), p.callback);
      case 'metrc_probe':  return json_(metrcAuthProbe_(p), p.callback);
      case 'metrc_access': return json_(metrcAccessAudit_(p), p.callback);

      /* REMOVED 2026-08-25: `avatars` and `avatar_save`. They were Crew's half of a
         Leaderboard hand-off that was never wired — nothing outside this repo ever called
         either one, verified across the whole tree. The write they offered now lives in
         GX Core as GXCore.setAvatar (v225), built from this app's logic, so BOTH apps write
         avatars through one function instead of two hand-rolled merges. Dead code that reads
         like a live contract is what the spiff_payouts cleanup was about; deleted, not parked. */
      case 'create_accounts': return json_(createAccounts_(p, body), p.callback);

      // ── Review queue: catch cross-source disagreements, ask a human ─────────
      // Employee of the Month history. The PICK itself is written straight to GX Core by the
      // browser (GXCore set_eom); this reads that value back and keeps Crew's own log of it.
      case 'eom_history':    return json_(getEomHistory_(p), p.callback);

      // Enter the months that predate the log. Deploy-secret, and confirm=yes to write, because
      // it is the only way anything reaches this record that Crew did not observe for itself.
      case 'eom_backfill':   return json_(eomBackfill_(p, body), p.callback);

      // ── Bug reporter (gx-theme's shared button/modal posts here) ───────────
      // 'bugreport' is inventory's and leaderboard's spelling. Sales says 'reportbug' and Price Cards
      // 'reportBug'; picking the majority spelling keeps Crew from adding a fourth to the zoo.
      case 'bugreport':      return json_(reportBug_(p), p.callback);

      case 'review':         return json_(getReview_(p), p.callback);
      case 'review_resolve': return json_(resolveReview_(p), p.callback);
      case 'review_report':  return json_(reportConflicts_(p, body), p.callback);

      // ── Derived, PII-free feed for Leaderboard (deploy-secret gated) ────────
      case 'celebrations': return json_(getCelebrations_(p), p.callback);

      // Read-only seed dry-run, so the Dutchie field mapping can be checked before committing.
      case 'seed_preview':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(seedIdentityPreview(), p.callback);

      // Commit the seed. Writes the canonical identity registry every other app reads, so it
      // takes the deploy secret AND an explicit confirm=yes — the secret alone is carried by
      // routine tooling, and this is not something that should ever fire as a side effect.
      // seedIdentityCommit() is also runnable straight from the editor.
      case 'seed_commit':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        if (String(p.confirm || '') !== 'yes') {
          return json_({ ok: false, error: 'refusing to write identity without confirm=yes — run action=seed_preview first' }, p.callback);
        }
        return json_(seedIdentityCommit(), p.callback);

      // Reads BACK from GX Core so a seed can be confirmed independently of the writer's own
      // return value. Counts and store distribution only — no names, so it stays safe to call.
      case 'identity_health':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(identityHealth_(), p.callback);

      // Stored name_keys vs what nameToKey_ would produce now. Read-only; see nameKeyHealth_.
      case 'namekey_health':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(nameKeyHealth_(), p.callback);

      // Puts a blanked identity row back together. Preview by default; writing takes confirm=yes.
      // See identityRepair_ for what a "blanked row" is and why one appears.
      case 'identity_repair':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(identityRepair_(p), p.callback);

      // Script-property KEYS only (never values) — the Apps Script UI caps its property list at
      // 50, so a big Leaderboard hand-off like GC_NICKNAMES_JSON becomes invisible there. This
      // says what actually landed. Values stay hidden: some properties are secrets.
      case 'props':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(propsInspect_(), p.callback);

      // Who does Dutchie say works here that the registry has never heard of? Read-only against
      // the registry — it writes nothing but its own pending tab. Safe to call any time.
      case 'new_hires':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(dutchieNewHireScan_(p && p.secret), p.callback);

      // Install or remove the nightly schedule. confirm=yes because a trigger is a standing
      // arrangement that keeps running long after whoever set it up has forgotten.
      case 'install_triggers':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        if (String(p.confirm || '') !== 'yes') {
          return json_({ ok: false, error: 'refusing to change a schedule without confirm=yes' }, p.callback);
        }
        return json_(installNightlyScan_(p), p.callback);

      // Who is this deployment running as, and can it send? Diagnostic for the mail-scope dance.
      case 'mail_check':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(mailCheck_(), p.callback);

      // The Monday recap. Previews by default; send=yes actually mails it, to= overrides who.
      case 'digest':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(sendDigest_(p), p.callback);

      // Is Dutchie's existing permit data good enough to skip the Metrc integrator application?
      // Run BOTH incentive engines for a period and report where they disagree. The thing to look
      // at before flipping cfg.incentiveEngine, since that switch changes what people are paid on.
      case 'incentive_compare':
        return json_(incentiveCompare_(p), p.callback);

      case 'permit_coverage':
        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);
        return json_(permitCoverage_(p), p.callback);

      // Incentive history: imported once from the payout PDFs, then read-only. POST for the
      // import (a year of rows will not fit in a query string); both are deploy-secret.
      case 'incentive_import':  return json_(incentiveImport_(p, body), p.callback);
      case 'incentive_history': return json_(incentiveHistory_(p), p.callback);
      // Attach history to a person after a merge or rename. Writes employee_id ONLY — never a figure.
      case 'incentive_relink':  return json_(incentiveRelink_(p), p.callback);

      // The dashboard itself: an imported period, or the live one from Leaderboard's slice.
      case 'incentive':      return json_(getIncentive_(p), p.callback);
      case 'incentive_save': return json_(saveIncentiveInput_(p), p.callback);
      // Is the Crew -> Leaderboard hop alive? Shape only, never figures. Secret, not a session,
      // so it can be checked from a shell instead of by a signed-in user hitting an error.
      case 'incentive_probe': return json_(incentiveProbe_(p), p.callback);
      // Comp thresholds: GX Core holds them, Crew edits them, Leaderboard reads them.
      case 'incentive_thresholds': return json_(incentiveThresholdsRoute_(p), p.callback);
      // Discount rules: same — GX Core holds the state. Leaderboard is still asked for the
      // discount NAMES, which are derived from its Dutchie registry and exist nowhere else.
      case 'incentive_discounts':  return json_(incentiveDiscountsRoute_(p), p.callback);
      case 'incentive_spiff_refresh': return json_(incentiveSpiffRefresh_(p), p.callback);
      // Approve a CLOSED period: compute it here and write it into history, after which it is a
      // record like the imported ones and can never be recomputed.
      case 'incentive_approve': return json_(incentiveApprove_(p), p.callback);
      // The approval loop: prepare -> send -> approve, or send back with a reason.
      case 'incentive_send':    return json_(incentiveSend_(p), p.callback);
      case 'incentive_return':  return json_(incentiveReturn_(p), p.callback);
      // Break glass. Deploy-secret only, never a button — see the header on incentiveUnapprove_.
      case 'incentive_unapprove': return json_(incentiveUnapprove_(p), p.callback);

      // ── To build (see /gxwhatsnext) ─────────────────────────────────────────
      // case 'export':       return json_(buildCapstoneExport_(p), p.callback);// payroll export (CSV/PDF)
      // case 'snapshot':     return json_(monthlySnapshot_(p), p.callback);    // monthly review snapshot

      default:
        return json_({ ok: false, error: 'unknown action: ' + action }, p.callback);
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) }, p.callback);
  }
}

/** JSON response, or JSONP when a ?callback= is supplied (gx-client uses JSONP for cross-origin GETs). */
function json_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

/**
 * Gate for anything touching staff PII. Delegates to GX Core so there is exactly one
 * password/session/grant system across the suite — Crew never mints or checks credentials itself.
 * Returns { ok, user, role } or { ok:false, error }.
 */
function libVersion_() {
  try {
    if (typeof GXCore === 'undefined' || !GXCore) return { ok: false, error: 'GXCore not bound' };
    if (typeof GXCore.libVersion !== 'function') {
      return { ok: false, error: 'pinned GXCore has no libVersion() - pre-v153' };
    }
    return { ok: true, gxcore: GXCore.libVersion() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function requireCrew_(p) {
  return GXCore.requireAuth(p, 'crew');
}

/**
 * Writes need an edit-grade grant; `viewer` can read the roster but not change it.
 *
 * GX Core's actual role vocabulary is viewer / editor / admin / director — `editor` is the
 * plain "can edit this app" grant and MUST be here, or granting someone crew/editor would hand
 * them a read-only roster while the role name says otherwise. `manager` is not in Core's
 * vocabulary today; it is allowed for the HR-manager grants CLAUDE.md anticipates.
 *
 * Deliberately an allowlist, not `role !== 'viewer'` — an unrecognized or empty role should fall
 * through to read-only rather than silently earning write access to staff PII.
 */
var EDIT_ROLES = ['admin', 'editor', 'director', 'manager'];
function canEdit_(auth) {
  var role = String((auth && auth.role) || '').toLowerCase();
  // Prefer GX Core's canonical helper (v126+) so every spoke agrees on what "can edit" means —
  // Crew's own list was missing `editor` until it was caught here. Falls back to the local
  // allowlist if the library predates it, so a version skew can never fail OPEN.
  try {
    if (typeof GXCore.roleCanEdit === 'function') return !!GXCore.roleCanEdit(role);
  } catch (e) { /* fall through */ }
  return EDIT_ROLES.indexOf(role) >= 0;
}

/**
 * The deploy secret gates machine-to-machine calls (celebrations feed, seed preview) where there
 * is no user session.
 *
 * The suite's deploy secret lives in GX Core, which only exposes it through a private validator,
 * so a spoke cannot read it via the library. Rather than copy the secret into every spoke (one
 * more place to leak it, one more place to rotate), we ASK Core whether a given secret is good,
 * using a cheap already-secret-gated route.
 *
 * The property name is `GX_DEPLOY_SECRET` suite-wide (decided 2026-08-20 — every other constant
 * is GX_, and GC_ was the lone outlier, which is exactly how two names drifted apart unnoticed).
 * Core still tolerates GC_ as a migration fallback; do NOT write new code against that name.
 *
 * A local GX_DEPLOY_SECRET script property short-circuits this if anyone sets one later. Both
 * halves have to agree — this is the name the CODE reads, and the name SET in Script Properties
 * cannot be read from outside the project, so a mismatch fails silently and looks like success.
 * Positive results are cached briefly, keyed by digest — never by the secret itself.
 */
function deploySecretOk_(p) {
  var given = String((p && p.secret) || '');
  if (!given) return false;

  var local = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (local) return given === local;

  var digest = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, given)).slice(0, 24);
  var cache = CacheService.getScriptCache();
  var ckey  = 'gxsecret:' + digest;
  var hit   = cache.get(ckey);
  if (hit) return hit === '1';

  var ok = false;
  try {
    var url = GXCORE_URL + '?action=notes&app=crew&status=resolved&secret=' + encodeURIComponent(given);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var body = res.getContentText();
    // Core replies { ok:false, error:'bad deploy secret' } for a wrong one. Anything that isn't
    // clean JSON (Drive's intermittent HTML page) must NOT be read as a pass.
    if (body && body.charAt(0) === '{') ok = !!(JSON.parse(body) || {}).ok;
  } catch (e) {
    ok = false;
  }
  // Only cache a definite yes. Caching a no would make a transient Drive HTML blip lock a valid
  // caller out for the whole TTL.
  if (ok) cache.put(ckey, '1', 300);
  return ok;
}

// ─── Crew's attribute store ─────────────────────────────────────────────────────

/**
 * Crew's own spreadsheet. Created on first call and remembered in ScriptProperties, so the
 * script stays standalone (no container binding to lose) and nobody has to hand-wire an ID.
 */
function crewSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CREW_SHEET_ID_PROP);
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('GX Crew — HR data (PII: do not share)');
    props.setProperty(CREW_SHEET_ID_PROP, ss.getId());
  }
  var sh = ss.getSheetByName(ATTR_TAB);
  if (!sh) {
    sh = ss.insertSheet(ATTR_TAB);
    sh.getRange(1, 1, 1, ATTR_HEADERS.length).setValues([ATTR_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  // Migrate in place when ATTR_HEADERS grows. Appending only — existing columns keep their
  // position so no stored value shifts under a different header.
  var width = Math.max(sh.getLastColumn(), 1);
  var have  = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var missing = ATTR_HEADERS.filter(function (h) { return have.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    have = have.concat(missing);
  }
  // Sheets turns "00" into the number 0 unless the column is explicitly plain text. Reserved
  // numbers like the owner's 00 have to survive the round trip, so pin the format once.
  ['employee_number', 'birthday', 'permit_number'].forEach(function (h) {
    var c = have.indexOf(h);
    if (c >= 0) sh.getRange(2, c + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });
  return sh;
}

/** All stored attributes, as { employee_id → row object }. */
function attrHeaders_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
           .map(function (h) { return String(h || '').trim(); });
}

function readAttrs_() {
  var sh = crewSheet_();
  var last = sh.getLastRow();
  if (last < 2) return Object.create(null);
  var hdr = attrHeaders_(sh);
  var values = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var out = Object.create(null);
  for (var i = 0; i < values.length; i++) {
    var row = {};
    for (var c = 0; c < hdr.length; c++) row[hdr[c]] = String(values[i][c] == null ? '' : values[i][c]).trim();
    if (row.employee_id) out[row.employee_id] = row;
  }
  return out;
}

/**
 * Upsert one employee's attributes. Locked, because two managers editing the roster at once
 * would otherwise race on the same row and one edit would silently vanish.
 */
function writeAttrs_(rec) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = crewSheet_();
    var last = sh.getLastRow();
    var targetRow = 0;
    if (last >= 2) {
      var ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]).trim() === rec.employee_id) { targetRow = i + 2; break; }
      }
    }
    var hdr = attrHeaders_(sh);
    var row = hdr.map(function (h) { return rec[h] == null ? '' : rec[h]; });
    if (targetRow) sh.getRange(targetRow, 1, 1, hdr.length).setValues([row]);
    else           sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

// ─── Normalization ──────────────────────────────────────────────────────────────

/**
 * A stored yes/no. Sheets hands back a checkbox as the BOOLEAN true, a typed cell as the string
 * 'TRUE', and our own writes as 'yes' — readAttrs_ stringifies all three, so compare on text and
 * accept every spelling rather than betting on which one a human used.
 */
function isTruthyFlag_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === 'y' || s === '1';
}

/* ─── "Does this person still work here?", in ONE place ──────────────────────────────────────────
 *
 * Every caller that asks this question was answering it inline, and by 2026-08-29 there were five
 * spellings of the answer across the file. Four of them missed `'false'`; one — getCelebrations_,
 * the ONE endpoint whose output leaves Crew for the all-staff kiosk — missed `'retired'` and
 * `'merged'`, so the kiosk announced birthdays and work anniversaries for people who had left and
 * for merged tombstone records. It went unnoticed because it only shows itself on the one day a
 * year each affected person has a date, on a screen nobody audits, and a retired person's card
 * looks exactly like everyone else's.
 *
 * The values, and why each is here:
 *   retired    — left the company. Still in the sheet, because they worked the periods they worked.
 *   merged     — a TOMBSTONE. getEmployees() still returns it and it still matches on name, so a
 *                caller that keeps it either double-counts a live person or renders a ghost.
 *   inactive / terminated — other spellings the registry has carried.
 *   false      — the boolean-as-text case. Booleans are TEXT throughout the suite, so an `active`
 *                column that says "false" arrives here as the status string 'false'.
 *
 * NOT every status check should call this. Three deliberately ask a different question and keep
 * their own logic: rosterJoin_ needs retired and merged told APART (it renders both, differently);
 * identity_health COUNTS them separately; identity_repair excludes only merged, because a retired
 * person with a damaged full_name still wants repairing. Those are marked where they sit. */
function statusIsLive_(status) {
  var st = String(status == null ? '' : status).trim().toLowerCase() || 'active';
  return st !== 'retired' && st !== 'merged' && st !== 'inactive' &&
         st !== 'terminated' && st !== 'false';
}

/**
 * Leaderboard's join key. MUST stay byte-identical to `nameToKey_` in the Leaderboard repo
 * (endpoints.gs) — it is how the celebrations feed lines up with the kiosk's roster, and a
 * drift here shows up as staff silently missing from the board rather than as an error.
 */
function nameToKey_(name) {
  // trim() must come BEFORE whitespace becomes underscores. It used to run last, so a padded cell
  // produced a DIFFERENT key: "  Sky Pinnick " -> "_sky_pinnick_" rather than "sky_pinnick", and
  // trim() then had no whitespace left to remove. Trailing spaces in spreadsheet cells are routine,
  // and this is the key the whole suite joins a person on — the failure is not an error, it is a
  // person silently detached from their own record.
  return String(name || '').toLowerCase().replace(/["'`]/g, '').replace(/\./g, '').trim().replace(/\s+/g, '_');
}

/**
 * Birthday → 'MM-DD'. Accepts 'MM-DD', 'YYYY-MM-DD', or 'M/D' and DELIBERATELY discards any
 * year: see the PII note at the top. Returns '' for anything unparseable rather than guessing.
 */
function normBirthday_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)      // YYYY-MM-DD → drop the year
       || s.match(/^()(\d{1,2})-(\d{1,2})$/)            // MM-DD
       || s.match(/^()(\d{1,2})\/(\d{1,2})$/);          // M/D
  if (!m) return '';
  var mo = Number(m[2]), da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  return pad2_(mo) + '-' + pad2_(da);
}

/** Work anniversary → 'YYYY-MM-DD'. Here the year IS the point (years of service). */
function normDate_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    var mo = Number(m[2]), da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
    return m[1] + '-' + pad2_(mo) + '-' + pad2_(da);
  }
  // Tolerate a real Date (Sheets hands these back when a cell was formatted as a date).
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, STORE_TZ, 'yyyy-MM-dd');
  return '';
}

function normShirt_(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return SHIRT_SIZES.indexOf(s) >= 0 ? s : '';
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// ─── Roster ─────────────────────────────────────────────────────────────────────

/**
 * The joined roster: GX Core identity (canonical) LEFT JOIN Crew attributes (ours).
 *
 * Note on the empty state: GX Core's `employees` tab currently has no writer anywhere in the
 * suite, so it is expected to come back empty until core-admin ships `gxUpsertEmployee` and a
 * seed. We surface that as an explicit `identity_source` diagnostic instead of rendering a
 * blank table, because "no employees" and "identity not seeded yet" are very different bugs.
 */





// ─── Employee numbers: system-assigned, never typed ─────────────────────────────
/*
 * employee_number is the canonical stable key the whole suite joins on, so it is issued by the
 * system rather than typed. Two properties matter more than convenience:
 *
 *   • NEVER REUSE. The next number is max(every number ever seen) + 1, counting retired and
 *     merged rows. Reissuing a retired person's number would silently attach their history to
 *     somebody new — 93 and 94 belong to Hinkle and Urenda, which is exactly why the first
 *     backfill had to start at 95 rather than the 93 that looked free.
 *   • DETERMINISTIC ORDER. Hire date first, so the sequence reflects who arrived when. People
 *     with no hire date on file cannot be placed in that order, so they sort last by name and
 *     are REPORTED as such — the number is still correct, but its position carries no meaning
 *     and nobody should read tenure into it.
 */
function assignNumbers_(p) {
  var auth = deploySecretOk_(p) ? { ok: true, user: 'tooling', role: 'admin' } : requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var identity = GXCore.getEmployees() || [];
  var attrs = readAttrs_();

  // Every number ever issued, from BOTH stores and regardless of status.
  var used = {}, maxN = 0;
  function note(v) {
    var n = parseInt(String(v || '').trim(), 10);
    if (!isNaN(n) && n > 0) { used[n] = true; if (n > maxN) maxN = n; }
  }
  identity.forEach(function (r) { note(r.employee_number); });
  Object.keys(attrs).forEach(function (k) { note(attrs[k].employee_number); });

  var need = identity.filter(function (r) {
    if (!statusIsLive_(r.status)) return false;
    var id = String(r.employee_id || '').trim();
    return !String((attrs[id] || {}).employee_number || r.employee_number || '').trim();
  });

  need.sort(function (a, b) {
    var ah = normDate_(a.hire_date), bh = normDate_(b.hire_date);
    if (ah && !bh) return -1;
    if (!ah && bh) return 1;
    if (ah && bh && ah !== bh) return ah < bh ? -1 : 1;
    return String(a.full_name).localeCompare(String(b.full_name));
  });

  var next = maxN + 1, plan = [];
  need.forEach(function (r) {
    while (used[next]) next++;            // belt and braces against a gap-filling mistake
    plan.push({ employee_id: String(r.employee_id).trim(), name: String(r.full_name || ''),
                hire_date: normDate_(r.hire_date) || '', number: next,
                ordered_by_hire_date: !!normDate_(r.hire_date) });
    used[next] = true; next++;
  });

  var noDate = plan.filter(function (x) { return !x.ordered_by_hire_date; })
                   .map(function (x) { return x.name; });
  var out = { ok: true, mode: String(p.confirm || '') === 'yes' ? 'assigned' : 'preview',
              highest_in_use: maxN, starting_at: maxN + 1, count: plan.length, plan: plan,
              no_hire_date: noDate };
  if (noDate.length) {
    out.warning = noDate.length + ' of these have no hire date, so their position in the sequence ' +
                  'is alphabetical, not chronological: ' + noDate.join(', ');
  }
  if (String(p.confirm || '') !== 'yes') {
    out.note = 'DRY RUN — nothing written. Repeat with confirm=yes.';
    return out;
  }

  var idRows = [];
  plan.forEach(function (a) {
    var prior = null;
    for (var i = 0; i < identity.length; i++) {
      if (String(identity[i].employee_id || '').trim() === a.employee_id) { prior = identity[i]; break; }
    }
    if (!prior) return;
    var merged = {};
    Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });   // read-merge-write
    merged.employee_id = a.employee_id;
    merged.employee_number = String(a.number);
    idRows.push(merged);

    var was = attrs[a.employee_id] || {};
    var rec = { employee_id: a.employee_id, name_key: nameToKey_(prior.full_name),
                full_name: String(prior.full_name || ''), employee_number: String(a.number),
                updated_at: new Date().toISOString(), updated_by: auth.user + ' (auto-number)' };
    // Carry EVERY stored attribute forward first, then apply the one field this call changes.
    // writeAttrs_ replaces the whole row, so anything not carried here is erased.
    attrFields_().forEach(function (k) { rec[k] = was[k] || ''; });
    rec.employee_number = String(a.number);
    writeAttrs_(rec);
  });
  if (idRows.length) GXCore.gxUpsertEmployees(idRows);
  bustRosterCache_();
  out.written = idRows.length;
  return out;
}


/**
 * Explicit override for a single employee number. Deliberately NOT exposed in the UI — numbers
 * are issued by assignNumbers_ — but reserved values exist (00 for the owner), and they have to
 * be settable by someone. Deploy-secret gated, and it refuses a number another person holds:
 * a collision here would graft one person's history onto another across every app that joins on it.
 *
 * A reserved number like 00 sits OUTSIDE the auto sequence on purpose: parseInt gives 0, which
 * the allocator ignores when computing the next number, so it can never collide with the series.
 */
function setNumber_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var id  = String(p.employee_id || '').trim();
  var num = String(p.number == null ? '' : p.number).trim();
  if (!id) return { ok: false, error: 'employee_id required' };
  if (!/^\d{1,5}$/.test(num)) return { ok: false, error: 'number must be 1-5 digits (leading zeros allowed)' };

  var identity = GXCore.getEmployees() || [];
  var attrs = readAttrs_();
  var prior = null, clash = null;
  identity.forEach(function (r) {
    var rid = String(r.employee_id || '').trim();
    if (rid === id) prior = r;
    var held = String((attrs[rid] || {}).employee_number || r.employee_number || '').trim();
    // Compare NUMERICALLY. Sheets coerces "00" to the number 0 on write, so a string compare
    // reads the stored "0" as different from the incoming "00" and waves a collision straight
    // through — which is exactly how a second person was handed 00.
    if (rid !== id && held !== '' && parseInt(held, 10) === parseInt(num, 10)) clash = r.full_name;
  });
  if (!prior) return { ok: false, error: 'unknown employee_id: ' + id };
  if (clash)  return { ok: false, error: 'number ' + num + ' is already held by ' + clash };

  var was = String((attrs[id] || {}).employee_number || prior.employee_number || '').trim();
  var merged = {};
  Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
  merged.employee_id = id;
  merged.employee_number = num;
  GXCore.gxUpsertEmployee(merged);

  var a = attrs[id] || {};
  var rec = { employee_id: id, name_key: nameToKey_(prior.full_name),
              full_name: String(prior.full_name || ''), employee_number: num,
              updated_at: new Date().toISOString(), updated_by: 'tooling (reserved number)' };
  attrFields_().forEach(function (k) { rec[k] = a[k] || ''; });
  rec.employee_number = num;
  writeAttrs_(rec);
  bustRosterCache_();
  return { ok: true, employee_id: id, name: prior.full_name, was: was || '(none)', now: num };
}


// ─── Email proposals (firstname@greencrosscanna.com) ────────────────────────────
/*
 * The house convention is firstname@greencrosscanna.com, and gxSeedTeamEmails() already
 * establishes it as GX Core policy. That makes the convention a fine PROPOSAL GENERATOR — but
 * core-admin is right that deriving is not the same as knowing, and this roster proves why:
 *
 *   • First names collide. Two active Zacharys is why Leaderboard carries the nicknames
 *     "Zach B" and "Zach R" at all — the convention cannot name them both.
 *   • People go by something other than their legal first name. Andrew Phillips is "Drew";
 *     Robert Wydick goes by Nathan. Whether the mailbox is andrew@ or drew@ is a fact about
 *     Workspace, not something a rule can derive.
 *   • A derived address is not a mailbox. Deriving it does not create it, and a wrong address
 *     for a SPIFF payout fails silently.
 *
 * So this PROPOSES and reports every reason to doubt each one. Nothing is written; confirmed
 * addresses go in through the normal review/confirm path once a human has checked Workspace.
 */
function emailProposals_(p) {
  if (!deploySecretOk_(p)) {
    var auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  }
  var roleFilter = String(p.role || '').trim().toLowerCase();
  var rows = GXCore.getEmployees() || [];

  var firstOf = function (r) {
    return String(r.full_name || '').trim().split(/\s+/)[0] || '';
  };
  var slug = function (n) { return String(n || '').toLowerCase().replace(/[^a-z]/g, ''); };

  // Count first-name usage across EVERY active person, not just the filtered set — a collision
  // with someone outside the filter is still a collision.
  var firstCount = Object.create(null);
  rows.forEach(function (r) {
    if (!statusIsLive_(r.status)) return;
    var f = slug(firstOf(r));
    if (f) firstCount[f] = (firstCount[f] || 0) + 1;
  });

  var out = [];
  rows.forEach(function (r) {
    if (!statusIsLive_(r.status)) return;
    if (roleFilter && String(r.role_title || '').toLowerCase().indexOf(roleFilter) < 0) return;

    var first = firstOf(r), f = slug(first);
    var nick = String(r.preferred_name || '').trim();
    var doubts = [];
    if (firstCount[f] > 1) doubts.push('FIRST NAME COLLIDES with ' + (firstCount[f] - 1) + ' other active staff');
    if (nick && slug(nick) !== f) doubts.push('goes by "' + nick + '", so the mailbox may be ' + slug(nick) + '@');
    /*
     * employee_id was seeded from what DUTCHIE and LEADERBOARD call people — i.e. what they
     * actually go by day to day — while full_name now carries the legal form from HR/METRC.
     * Where those two disagree on the first name, the convention is ambiguous even though
     * nothing looks wrong: "Samuel Keck" with id sam_keck is a sam@, not a samuel@.
     */
    var idFirst = slug(String(r.employee_id || '').split('_')[0]);
    if (idFirst && f && idFirst !== f) {
      doubts.push('known elsewhere as "' + idFirst + '" (employee_id ' + r.employee_id +
                  '), so the mailbox may be ' + idFirst + '@');
    }
    if (!f) doubts.push('no usable first name');
    out.push({
      employee_id: String(r.employee_id || ''), name: String(r.full_name || ''),
      role: String(r.role_title || ''), preferred_name: nick,
      has_account: !!String(r.user_id || '').trim(),
      existing_user_id: String(r.user_id || ''),
      proposed: f ? f + '@greencrosscanna.com' : '',
      confident: doubts.length === 0,
      doubts: doubts
    });
  });

  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { ok: true, policy: 'firstname@greencrosscanna.com (GX Core, gxSeedTeamEmails)',
           counted: out.length,
           needing_account: out.filter(function (x) { return !x.has_account; }).length,
           confident: out.filter(function (x) { return !x.has_account && x.confident; }).length,
           needs_a_human: out.filter(function (x) { return !x.has_account && !x.confident; }).length,
           note: 'PROPOSALS ONLY — nothing written. A derived address is not a mailbox; confirm in Workspace before use.',
           proposals: out };
}


// ─── Account creation (verified addresses only) ─────────────────────────────────
/*
 * Creates the users row and links employees.user_id to it. Addresses come in from the payload
 * because they must be VERIFIED, never derived — this roster produced three cases no rule would
 * have got right: Sam Keck is samuel@, Pam Johnson is pamela@, but Zach Babcock is zach@.
 *
 * Note gxUpsertUser does NOT read-merge — it replaces the row. We therefore send the FULL users
 * schema rather than a partial record. That is safe here because passwords live in the separate
 * user_auth tab, so a rewrite cannot cost anyone their login; but it is the reason nothing
 * partial should ever be sent to it.
 *
 * A users row is identity + address only. It grants NO app access on its own (that is app_access,
 * superadmin-gated) and carries no password, so creating one cannot let anybody in.
 */
function createAccounts_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var list = (body && body.accounts) || [];
  if (!list.length) return { ok: false, error: 'no accounts in payload' };
  var dry = String(p.confirm || '') !== 'yes';

  var identity = GXCore.getEmployees() || [];
  var byId = Object.create(null);
  identity.forEach(function (r) { byId[String(r.employee_id || '').trim()] = r; });

  var plan = [], problems = [];
  list.forEach(function (a) {
    var eid   = String(a.employee_id || '').trim();
    var email = String(a.email || '').trim().toLowerCase();
    var emp   = byId[eid];
    if (!emp)   { problems.push('unknown employee_id: ' + eid); return; }
    if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      problems.push(emp.full_name + ': not a valid address: ' + email); return;
    }
    // user_id follows the existing convention: the mailbox name, not a name slug.
    var uid = String(a.user_id || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!uid) { problems.push(emp.full_name + ': could not derive a user_id'); return; }
    if (String(emp.user_id || '').trim() && String(emp.user_id).trim() !== uid) {
      problems.push(emp.full_name + ': already linked to account "' + emp.user_id +
                    '" — refusing to relink to "' + uid + '"');
      return;
    }
    var store = String(emp.home_store || '').trim();
    plan.push({ employee_id: eid, name: String(emp.full_name || ''), user_id: uid, email: email,
                // corporate is not a kiosk store, so it is not a default_store
                default_store: store === 'corporate' ? '' : store,
                already_linked: String(emp.user_id || '').trim() === uid });
  });

  var out = { ok: true, mode: dry ? 'preview' : 'commit',
              would_create: plan.filter(function (x) { return !x.already_linked; }).length,
              already_linked: plan.filter(function (x) { return x.already_linked; }).length,
              plan: plan, problems: problems };
  if (dry) { out.note = 'DRY RUN — nothing written. Repeat with confirm=yes.'; return out; }

  var linked = [];
  plan.forEach(function (a) {
    GXCore.gxUpsertUser({
      user_id: a.user_id, display_name: a.name, email: a.email, status: 'active',
      employee_id: a.employee_id, default_store: a.default_store, is_superadmin: 'FALSE',
      notes: 'created by GX Crew from a verified address'
    });
    var prior = byId[a.employee_id];
    var merged = {};
    Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });   // read-merge-write
    merged.employee_id = a.employee_id;
    merged.user_id = a.user_id;
    GXCore.gxUpsertEmployee(merged);
    linked.push(a.name + ' → ' + a.user_id + ' <' + a.email + '>');
  });
  bustRosterCache_();
  out.linked = linked;
  out.note = 'users rows carry no password and grant no app access — app_access is separate.';
  return out;
}


// ─── Avatar seed + clear-verification helpers ───────────────────────────────────
/*
 * WHERE THE AVATAR WRITE WENT (2026-08-25): to GX Core. `GXCore.setAvatar(ref, config, by)`
 * (v225) is the ONE place avatar_config is written, and it was built from THIS app's version of
 * the logic — seed pinned to employee_number, lock contention retried, a clear NAMED in clear=
 * and then verified to have landed. Leaderboard's own writer did none of that, so which
 * behavior a staff member got depended on which app they were standing in front of.
 *
 * Deleted with it: `avatarsForKiosk_` (route `avatars`), `avatarSave_` (route `avatar_save`) and
 * `resolveEmployee_`, which only avatarSave_ used. They were Crew's half of a Leaderboard
 * hand-off that never got wired — no caller anywhere in the suite, verified across the tree.
 * setAvatar does its own resolution (employee_id, employee_number, dutchie id, name).
 *
 * What stays here is what the READ paths need. `rosterJoin_` and `migrateLeaderboard_` re-derive
 * the seed at read time (that is why the stored seed could drift for a release without a single
 * face rendering wrong), and `saveIdentity_` still stamps it on the one path that does NOT
 * delegate — an avatar arriving alongside other identity fields, which stays a single atomic
 * row write rather than being split in two just to route the avatar separately.
 */

/**
 * THE avatar seed for one person — the single definition, because there is more than one door.
 *
 * A face is generated from this seed, so it must never move: it is pinned to employee_number,
 * which is issued once and never reused, precisely so a rename or a merge cannot hand someone a
 * different face. employee_id is only a fallback for someone not yet numbered; they get a stable
 * face the moment a number is assigned.
 *
 * It lives in a function because avatar_config used to be written through TWO doors in this app
 * — the old avatar_save route and roster_identity — and for a while only one of them stamped.
 * Nothing broke, because every reader re-derives the seed at READ time, so a config stored
 * without one still rendered correctly. That is exactly what made it hard to notice: the stored
 * record quietly drifted from the invariant while every rendered face stayed right. The write
 * itself is GXCore.setAvatar's job now (it pins the same way); this remains the READ-side
 * definition, and the one write path that stays local uses it so both agree.
 *
 * ONE DIFFERENCE FROM setAvatar, deliberate: this prefers Crew's attribute sheet over the Core
 * row, because a number can be recorded here first. In practice the two agree — assignNumbers_,
 * setNumber_ and hrImport_ all write employee_number to BOTH — and readers re-derive anyway, so
 * a stored seed can only ever be advisory. Do not "fix" it by dropping the attrs lookup: it is
 * the reader's answer, and the reader is what a face is actually generated from.
 */
function avatarSeedFrom_(attrRow, coreRow, employeeId) {
  var num = String((attrRow && attrRow.employee_number) ||
                   (coreRow && coreRow.employee_number) || '').trim();
  return num || String(employeeId || '').trim();
}

/*
 * Convenience for the single-record path that still stamps locally (saveIdentity_'s mixed
 * write), which holds no attrs map. The bulk paths (migrateLeaderboard_, rosterJoin_) have
 * already read attrs for their whole loop and call avatarSeedFrom_ directly rather than
 * re-reading the sheet per person.
 */
function avatarSeed_(employeeId, priorRow) {
  return avatarSeedFrom_(readAttrs_()[employeeId], priorRow, employeeId);
}

/**
 * Which fields did the caller ask to BLANK that are still set afterwards?
 *
 * GX Core's gxUpsertEmployee is a PATCH: `if (p[k] === '') return;  // absent means "leave alone"`.
 * That guard is deliberate and good — it is what stops a partial write blanking a live record, the
 * failure that reduced a real employee to an id and a status in August. But it has a consequence
 * nobody had written down: THERE IS NO WAY TO CLEAR A FIELD. A requested blank is not refused, it
 * is ignored, and the write reports success.
 *
 * Crew was reporting its own INTENT as the outcome — `cleared: !cfg`, computed from what Crew meant
 * to do rather than from what happened — while Core was returning the truth in `cleared` and Crew
 * discarded the return value. So "Remove avatar" reported success and changed nothing.
 *
 * This compares the request against Core's own answer. Callers must surface the result: a silent
 * no-op that claims success is the exact failure mode this app keeps finding elsewhere.
 */
function unclearedFields_(prior, changes, res) {
  var actuallyCleared = {};
  ((res && res.cleared) || []).forEach(function (k) { actuallyCleared[k] = 1; });
  return Object.keys(changes || {}).filter(function (k) {
    return String(changes[k] == null ? '' : changes[k]) === '' &&   // caller asked to blank it
           String((prior && prior[k]) || '').trim() &&              // there was something there
           !actuallyCleared[k];                                     // and Core did not remove it
  });
}



// ─── METRC connector (Oregon) ───────────────────────────────────────────────────
/*
 * Worker-permit truth, straight from the state system, replacing the per-store spreadsheet
 * exports we had been importing by hand.
 *
 * CREDENTIALS LIVE IN SCRIPT PROPERTIES, never in this file and never in the frontend:
 *   METRC_VENDOR_KEY   the integrator/software key Metrc issues
 *   METRC_USER_KEY     the user key generated inside Metrc by the license owner
 *   METRC_LICENSES     comma-separated license numbers (e.g. 050-12997,050-13000,…)
 * Metrc authenticates as Basic base64(vendorKey:userKey) — BOTH halves are required; the
 * vendor key is the username. A user key alone cannot authenticate at all.
 *
 * WHY THIS MATTERS BEYOND CONVENIENCE: the review queue currently asks whether retired staff
 * still hold live access, and the honest answer needed a human to open Metrc. With this, Crew
 * can check it directly — which is the difference between a flag someone must chase and a fact.
 */
/*
 * Base URL is a PROPERTY, not a constant, because sandbox and production are different hosts
 * holding different data:
 *   production  https://api-or.metrc.com          — real Green Cross staff and permits
 *   sandbox     https://sandbox-api-or.metrc.com  — Metrc's generic test data, periodically reset
 * Sandbox is for passing Metrc's evaluation. It cannot answer a question about OUR staff, so any
 * audit run against it must be labeled as such rather than mistaken for the real thing.
 */
var METRC_BASE_DEFAULT = 'https://api-or.metrc.com';

function metrcCreds_() {
  var props = PropertiesService.getScriptProperties();
  return {
    base: String(props.getProperty('METRC_BASE') || METRC_BASE_DEFAULT).replace(/\/+$/, ''),
    vendor: String(props.getProperty('METRC_VENDOR_KEY') || '').trim(),
    user:   String(props.getProperty('METRC_USER_KEY') || '').trim(),
    licenses: String(props.getProperty('METRC_LICENSES') || '').split(',')
                .map(function (x) { return x.trim(); }).filter(Boolean)
  };
}

function metrcGet_(path, params) {
  var c = metrcCreds_();
  if (!c.vendor || !c.user) {
    throw new Error('METRC keys are not set. Add METRC_VENDOR_KEY and METRC_USER_KEY to this ' +
                    'script\'s properties. Both are required — Metrc authenticates as ' +
                    'Basic base64(vendorKey:userKey), so a user key alone cannot connect.');
  }
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = c.base + path + (qs ? '?' + qs : '');
  var res = UrlFetchApp.fetch(url, {
    method: 'get', muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.vendor + ':' + c.user) }
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code === 401) throw new Error('METRC rejected the credentials (401). Check both keys, and ' +
                                    'that the user key belongs to an account with API access.');
  if (code === 403) throw new Error('METRC returned 403 — the keys are valid but not authorized ' +
                                    'for this license or endpoint.');
  if (code >= 300) throw new Error('METRC HTTP ' + code + ': ' + body.slice(0, 300));
  try { return JSON.parse(body); }
  catch (e) { throw new Error('METRC returned non-JSON: ' + body.slice(0, 200)); }
}

/** Connectivity + shape probe. Reports FIELD NAMES only — permit numbers are government IDs. */
function metrcHealth_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var c = metrcCreds_();
  var isSandbox = /sandbox/i.test(c.base);
  var out = { ok: true, base: c.base, environment: isSandbox ? 'SANDBOX (generic test data)' : 'production',
              has_vendor_key: !!c.vendor, has_user_key: !!c.user, licenses: c.licenses.length };
  if (isSandbox) {
    out.warning = 'Sandbox holds Metrc test data, NOT Green Cross staff. Nothing read here can ' +
                  'answer whether our own retired employees are deactivated.';
  }
  if (!c.vendor || !c.user) {
    out.ok = false;
    out.error = 'Missing keys. Set METRC_VENDOR_KEY and METRC_USER_KEY in this script\'s properties.';
    return out;
  }
  if (!c.licenses.length) {
    out.ok = false;
    out.error = 'Set METRC_LICENSES to a comma-separated list of license numbers.';
    return out;
  }
  try {
    var rows = metrcGet_('/employees/v1/', { licenseNumber: c.licenses[0] }) || [];
    out.probe_license = c.licenses[0];
    out.records = rows.length;
    // Shape, not content — the API's field names differ from the UI export's headers.
    out.fields = rows.length ? Object.keys(rows[0]).sort() : [];
    if (rows.length && rows[0].License && typeof rows[0].License === 'object') {
      out.license_fields = Object.keys(rows[0].License).sort();
    }
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  return out;
}


/**
 * Bootstrap a SANDBOX user key. Metrc's sandbox lets an integrator mint its own industry user
 * key via POST /sandbox/v2/integrator/setup, authenticated with the vendor key on an
 * `x-metrc-key` HEADER — note that is API-Key auth, unlike every other endpoint, which uses
 * Basic base64(vendor:user). Getting that wrong is the obvious first stumble.
 *
 * The returned key is written STRAIGHT INTO SCRIPT PROPERTIES and never included in the
 * response: a credential that travels back over HTTP to a caller has been exposed to the
 * caller's logs, terminal history and mine. We return its shape, not its value.
 */
function metrcSandboxSetup_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var c = metrcCreds_();
  if (!c.vendor) return { ok: false, error: 'METRC_VENDOR_KEY is not set' };
  if (!/sandbox/i.test(c.base)) {
    return { ok: false, error: 'Refusing to run sandbox setup against ' + c.base +
             ' — this endpoint only exists in the sandbox environment.' };
  }
  var res = UrlFetchApp.fetch(c.base + '/sandbox/v2/integrator/setup', {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'x-metrc-key': c.vendor }, payload: '{}'
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) return { ok: false, http: code, error: body.slice(0, 400) };

  /*
   * This endpoint is ASYNCHRONOUS and does not hand back the key. Observed live:
   *   first call  -> 200 "User queued for creation"  (plain text, not JSON)
   *   later calls -> 200 with an empty body          (nothing left to do)
   * Neither is an error, and calling either one a failure sends you debugging a working
   * integration. The key itself is issued into Metrc Connect, not returned over the wire.
   */
  var trimmed = String(body || '').trim();
  var data = null;
  if (trimmed) { try { data = JSON.parse(trimmed); } catch (e) { data = null; } }
  if (!data) {
    return { ok: true, http: code, user_key_stored: false, async: true,
             metrc_said: trimmed || '(empty body)',
             note: trimmed
               ? 'Metrc QUEUED the sandbox user. It does not return the key — collect it from ' +
                 'Metrc Connect > Users, then set METRC_USER_KEY.'
               : 'Nothing to do: the sandbox user already exists from an earlier call. Collect ' +
                 'its key from Metrc Connect > Users, then set METRC_USER_KEY.' };
  }

  // The field name is not documented consistently across states — find the key without guessing.
  var found = '', foundIn = '';
  function scan(o, path) {
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (typeof v === 'string' && v.length >= 20 && /key/i.test(k) && !found) {
        found = v; foundIn = (path ? path + '.' : '') + k;
      } else if (v && typeof v === 'object') { scan(v, (path ? path + '.' : '') + k); }
    });
  }
  scan(Array.isArray(data) ? { list: data } : data, '');

  var out = { ok: true, http: code, response_fields: Object.keys(
    Array.isArray(data) ? (data[0] || {}) : data).sort() };
  if (found) {
    PropertiesService.getScriptProperties().setProperty('METRC_USER_KEY', found);
    out.user_key_stored = true;
    out.found_in_field = foundIn;
    out.key_length = found.length;   // shape only — never the value
    out.note = 'Sandbox user key written to METRC_USER_KEY. Its value is deliberately not returned.';
  } else {
    out.user_key_stored = false;
    out.raw_preview = body.slice(0, 400);
    out.note = 'No key-like field found. Inspect response_fields and set METRC_USER_KEY by hand.';
  }
  return out;
}


/**
 * Auth probe. Metrc's sandbox setup call is asynchronous and returns no key, and the docs list
 * no GET to retrieve one — so before anyone goes hunting through the portal, establish what the
 * vendor key alone can actually reach, and whether the key comes back in a HEADER we ignored.
 * Read-only target (tagtypes) so nothing is created while probing.
 */
function metrcAuthProbe_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var c = metrcCreds_();
  if (!c.vendor) return { ok: false, error: 'METRC_VENDOR_KEY is not set' };

  var target = c.base + '/sandbox/v2/tagtypes';
  var b64 = function (x) { return Utilities.base64Encode(x); };
  var attempts = [
    { how: 'Basic vendor:vendor', headers: { Authorization: 'Basic ' + b64(c.vendor + ':' + c.vendor) } },
    { how: 'Basic vendor:(empty)', headers: { Authorization: 'Basic ' + b64(c.vendor + ':') } },
    { how: 'x-metrc-key header only', headers: { 'x-metrc-key': c.vendor } },
    { how: 'x-metrc-key + Basic vendor:vendor', headers: {
        'x-metrc-key': c.vendor, Authorization: 'Basic ' + b64(c.vendor + ':' + c.vendor) } }
  ];
  var results = attempts.map(function (a) {
    try {
      var r = UrlFetchApp.fetch(target, { method: 'get', muteHttpExceptions: true, headers: a.headers });
      return { how: a.how, http: r.getResponseCode(), body: r.getContentText().slice(0, 120) };
    } catch (e) { return { how: a.how, error: String((e && e.message) || e) }; }
  });

  // Re-run setup and capture RESPONSE HEADERS — a key handed back out-of-band would be here.
  var setupHeaders = {}, setupCode = null, setupBody = '';
  try {
    var sr = UrlFetchApp.fetch(c.base + '/sandbox/v2/integrator/setup', {
      method: 'post', muteHttpExceptions: true, contentType: 'application/json',
      headers: { 'x-metrc-key': c.vendor }, payload: '{}'
    });
    setupCode = sr.getResponseCode();
    setupBody = sr.getContentText().slice(0, 200);
    var h = sr.getAllHeaders();
    Object.keys(h).forEach(function (k) {
      // Names and lengths only — if a credential IS in here, do not print it.
      var v = h[k];
      setupHeaders[k] = (typeof v === 'string' && v.length > 40) ? '<' + v.length + ' chars>' : v;
    });
  } catch (e) { setupBody = 'error: ' + String((e && e.message) || e); }

  return { ok: true, base: c.base, target: target, attempts: results,
           setup_http: setupCode, setup_body: setupBody, setup_headers: setupHeaders };
}

/** Everyone METRC currently knows about, deduped across licenses, keyed by permit number. */
function metrcAllEmployees_() {
  var c = metrcCreds_();
  var byPermit = {}, errors = [], seen = 0;
  c.licenses.forEach(function (lic) {
    var rows;
    try { rows = metrcGet_('/employees/v1/', { licenseNumber: lic }) || []; }
    catch (e) { errors.push(lic + ': ' + String((e && e.message) || e)); return; }
    rows.forEach(function (r) {
      seen++;
      var L = r.License || {};
      var permit = String(L.Number || r.LicenseNumber || '').trim();
      var name = String(r.FullName || r.Name || '').trim();
      if (!name) return;
      var key = permit || ('name:' + nameToKey_(name));
      var rec = byPermit[key] || (byPermit[key] = {
        permit: permit, name: name, licenses: [], start: String(L.StartDate || ''),
        end: String(L.EndDate || ''), active: false
      });
      if (rec.licenses.indexOf(lic) < 0) rec.licenses.push(lic);
      // Metrc marks the person per facility; active anywhere means they still hold access.
      var isActive = r.IsActive !== false && String(r.Status || 'Active').toLowerCase() !== 'inactive';
      if (isActive) rec.active = true;
      if (L.EndDate && (!rec.end || String(L.EndDate) > rec.end)) rec.end = String(L.EndDate);
    });
  });
  return { people: byPermit, errors: errors, rows_seen: seen };
}

/**
 * The question the review queue could not answer without a human: are the people we have marked
 * retired actually deactivated in METRC? Names only — no permit numbers leave this.
 */
function metrcAccessAudit_(p) {
  if (!deploySecretOk_(p)) {
    var auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  }
  var creds = metrcCreds_();
  if (/sandbox/i.test(creds.base)) {
    return { ok: false, error: 'Refusing to audit against SANDBOX. It holds Metrc test data, not ' +
             'Green Cross staff, so a clean result here would be meaningless and a dirty one ' +
             'alarming. Point METRC_BASE at production once credentials are issued.' };
  }
  var m = metrcAllEmployees_();
  var metrcPeople = Object.keys(m.people).map(function (k) { return m.people[k]; });
  var joined = rosterJoin_();

  var stillActive = [], properlyRemoved = [], notInMetrc = [];
  joined.rows.forEach(function (r) {
    if (!r.retired) return;
    var hit = null;
    for (var i = 0; i < metrcPeople.length; i++) {
      if (samePerson_(r.name, metrcPeople[i].name)) { hit = metrcPeople[i]; break; }
    }
    if (!hit) { notInMetrc.push(r.name); return; }
    if (hit.active) stillActive.push({ name: r.name, licenses: hit.licenses.length });
    else properlyRemoved.push(r.name);
  });

  return {
    ok: true, metrc_rows_seen: m.rows_seen, metrc_people: metrcPeople.length,
    retired_in_crew: joined.rows.filter(function (r) { return r.retired; }).length,
    still_active_in_metrc: stillActive,
    properly_deactivated: properlyRemoved.length,
    retired_and_absent_from_metrc: notInMetrc.length,
    errors: m.errors,
    note: stillActive.length
      ? stillActive.length + ' retired staff still hold METRC access — revoke in METRC, this only reports.'
      : 'No retired staff hold active METRC access.'
  };
}

// ─── Review queue ───────────────────────────────────────────────────────────────
/*
 * The point of holding three sources is catching where they disagree — and then asking a human,
 * never silently picking. So:
 *
 *   • Conflicts are DETECTED on read from live data. Nothing is cached as a "conflict list",
 *     because one that drifts out of date is worse than not having one.
 *   • DECISIONS are persisted. Resolving an item records what was chosen, keyed on the item's
 *     values — so it stays gone, but if the underlying values CHANGE it surfaces again as a new
 *     question. Silence and "already answered" must not be the same state.
 *   • Defaults follow Sky's ruling: METRC wins on spelling (OLCC-validated, not hand-typed),
 *     Leaderboard wins on role. Those set which side is offered as `proposed`; they never apply
 *     themselves.
 */
function sheetOf_(tab, headers) {
  var ss = crewSheet_().getParent();
  var sh = ss.getSheetByName(tab);
  if (!sh) {
    sh = ss.insertSheet(tab);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readTab_(tab, headers) {
  var sh = sheetOf_(tab, headers);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues().map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    return o;
  });
}

/** Stable identity for a conflict: same question + same values = same decision. */
function decisionKey_(kind, employeeId, field, proposed) {
  return [kind, employeeId, field, String(proposed || '').toLowerCase()].join('|');
}

/* Whitespace-normalized comparison, matching what saveIdentity_ does on the way IN — it collapses
   runs of whitespace before writing, so "Michael  Kettler" and "Michael Kettler" are the same value
   and an item must not stay open over the difference. Deliberately CASE-SENSITIVE: "michael" vs
   "Michael" is a real spelling disagreement and is exactly what this queue exists to surface. */
function normSpace_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

/* The live value of the field a reported item is talking about, or null for "cannot tell".
   The joined roster row renames Core's columns (full_name -> name, role_title -> role), so this is
   the one place that mapping is stated; adding a new reportable field means adding it here too. */
function liveValueFor_(row, field) {
  if (!row) return null;
  if (field === 'full_name')  return String(row.name || '');
  if (field === 'role_title') return String(row.role || '');
  return null;
}

/* Has the record already caught up with what the report proposed?
   null (unknown field, or a person no longer on the roster) is NOT satisfied — an item we cannot
   judge stays visible for a human, rather than disappearing on a guess. */
function reportedItemSatisfied_(liveValue, proposedValue) {
  if (liveValue == null) return false;
  return normSpace_(liveValue) === normSpace_(proposedValue);
}

function reviewItems_() {
  var joined = rosterJoin_();
  var rows = joined.rows;
  var byId = Object.create(null);
  rows.forEach(function (r) { byId[r.employee_id] = r; });

  var decided = Object.create(null);
  readTab_(DECISION_TAB, DECISION_HEADERS).forEach(function (d) { decided[d.decision_key] = d; });

  var items = [];
  function add(kind, row, field, current, proposed, source, detail, severity) {
    var key = decisionKey_(kind, row.employee_id, field, proposed);
    if (decided[key]) return;
    items.push({
      id: key, kind: kind, employee_id: row.employee_id, name: row.name,
      field: field, current_value: String(current == null ? '' : current),
      proposed_value: String(proposed == null ? '' : proposed),
      source: source, detail: detail || '', severity: severity || 'info'
    });
  }

  // ── 1. Duplicates. This is what catches "TJ Peterson" without anyone noticing him first.
  for (var i = 0; i < rows.length; i++) {
    for (var j = i + 1; j < rows.length; j++) {
      var a = rows[i], b = rows[j];
      if (a.retired && b.retired) continue;
      if (!samePerson_(a.name, b.name)) continue;
      // Richer record wins by default — more populated fields means more to lose.
      // A dutchie_employee_id outweighs everything else: SPIFF and Leaderboard attribution
      // resolve through it, so keeping the other row would move payout math. Same for user_id,
      // which links to the account that owns email. Field count only breaks the tie.
      var score = function (r) {
        return (r.dutchie_employee_id ? 100 : 0) + (r.user_id ? 50 : 0) +
               (r.employee_number ? 1 : 0) + (r.hire_date ? 1 : 0) + (r.permit_number ? 1 : 0) +
               (r.wage ? 1 : 0) + (r.birthday ? 1 : 0) + (r.store ? 1 : 0);
      };
      var keep = score(a) >= score(b) ? a : b, drop = keep === a ? b : a;
      add('duplicate', keep, 'identity', drop.name, keep.name, 'GX Core',
          'Two records look like the same person. Keeping "' + keep.name + '" merges "' +
          drop.name + '" into it — nothing is deleted.', 'high');
      items[items.length - 1].merge_from = drop.employee_id;
      items[items.length - 1].merge_from_name = drop.name;
    }
  }

  // ── 2. Permits — the compliance half.
  rows.forEach(function (r) {
    if (r.retired) {
      if (r.permit_number && r.permit_status &&
          ['active', 'valid'].indexOf(String(r.permit_status).toLowerCase()) >= 0) {
        add('retired_with_access', r, 'permit_status', 'retired staff, permit still ' + r.permit_status,
            'revoke', 'METRC', 'Retired on the roster but still holds an active METRC permit/access.', 'high');
      }
      return;
    }
    if (!r.permit_number) {
      add('missing_permit', r, 'permit_number', '', 'needs a permit on file', 'METRC',
          'Active staff with no OLCC worker permit recorded.', 'high');
    } else if (r.permit_days_left != null && r.permit_days_left < 0) {
      add('permit_expired', r, 'permit_expires', r.permit_expires, 'renew', 'METRC',
          'Permit expired ' + (-r.permit_days_left) + ' days ago.', 'high');
    } else if (r.permit_days_left != null && r.permit_days_left <= 90) {
      add('permit_expiring', r, 'permit_expires', r.permit_expires, 'renew', 'METRC',
          'Permit expires in ' + r.permit_days_left + ' days.', 'warn');
    }
  });

  // ── 3. Gaps that need a person, not a default.
  rows.forEach(function (r) {
    if (r.retired) return;
    if (!r.employee_number) {
      add('missing_field', r, 'employee_number', '', 'assign next number', 'GX Crew',
          'No employee number — the canonical stable key. Run the auto-assign to issue the next one.', 'warn');
    }
    if (!r.hire_date) {
      add('missing_field', r, 'hire_date', '', 'needs a hire date', 'GX Crew',
          'No hire date, so tenure and work anniversary cannot be derived. Set it in the identity panel.', 'warn');
    }
  });

  // ── 3b. In Dutchie, not on the roster. Parked by the nightly scan; only a human adds them.
  readTab_(PENDING_TAB, PENDING_HEADERS).forEach(function (h) {
    var key = String(h.name_key || '').trim();
    if (!key) return;
    if (byId[key]) return;          // added since the scan ran — the item has answered itself
    var id = decisionKey_('new_hire', key, 'identity', h.full_name);
    if (decided[id]) return;
    items.push({
      id: id, kind: 'new_hire', employee_id: key, name: h.full_name,
      field: 'identity', current_value: '', proposed_value: h.full_name,
      source: 'Dutchie',
      detail: 'Active in Dutchie' + (h.home_store ? ' at ' + h.home_store : '') +
              ' since ' + String(h.first_seen || '').slice(0, 10) +
              ', with no record in Crew. Adding them creates the identity row every app reads.',
      severity: 'warn'
    });
  });

  // ── 4. Anything an import reported that the engine cannot see for itself (HR sheet, METRC
  //       exports — neither is reachable from Apps Script, so imports post their findings here).
  //
  // READ THE LIVE RECORD, DO NOT ECHO THE REPORT. A reported row is a snapshot of what some other
  // system saw at the moment it was filed, and the roster keeps moving afterwards. Two things
  // follow, and both were bugs here (filed as bug_mt67on71_calt, 2026-08-23):
  //
  //   • An item whose proposal has ALREADY BEEN APPLIED must drop out. resolveReview_ records a
  //     decision, so accepting one clears it — but the identity panel is the other, equally valid
  //     way to fix a name, and it writes no decision. Fix Michael Kettler there and the item
  //     survived forever, still proposing a change that had already been made. Accepting it would
  //     have been a no-op write, which is how a queue teaches people to ignore it.
  //
  //   • current_value must come from the RECORD, not from the report. Echoing rep.current_value
  //     showed "Mike Kettler" as the current name minutes after it became Michael Kettler — a
  //     stale fact rendered as a measured one, next to a proposal to change it.
  //
  // Unknown field -> liveValueFor_ returns null -> the item is KEPT. Failing safe means a stale
  // item somebody can dismiss, never a real disagreement silently swallowed.
  readTab_(REVIEW_TAB, REVIEW_HEADERS).forEach(function (rep) {
    var live = byId[rep.employee_id] || null;
    var row  = live || { employee_id: rep.employee_id, name: rep.name, retired: false };
    var key  = decisionKey_(rep.kind, rep.employee_id, rep.field, rep.proposed_value);
    if (decided[key]) return;
    var current = liveValueFor_(live, rep.field);
    if (reportedItemSatisfied_(current, rep.proposed_value)) return;
    items.push({
      id: key, kind: rep.kind, employee_id: rep.employee_id, name: row.name || rep.name,
      field: rep.field,
      current_value: current == null ? rep.current_value : current,
      proposed_value: rep.proposed_value,
      source: rep.source, detail: rep.detail, severity: 'warn', reported: true
    });
  });

  var rank = { high: 0, warn: 1, info: 2 };
  items.sort(function (x, y) {
    return (rank[x.severity] - rank[y.severity]) || x.name.localeCompare(y.name);
  });
  return items;
}

/**
 * File a bug into GX Core's shared bug_reports log. The shared reporter (gx-theme/gx-bugreport.js)
 * owns the button, the modal and the state snapshot; this is only the transport and the auth.
 *
 * SIGNED IN, BUT NOT EDIT-GATED. A viewer who cannot change a wage is still the person most likely
 * to notice the roster is wrong, and a reporter they are refused is a reporter that produces
 * silence — which reads as "no problems" rather than "no reporter".
 *
 * DO NOT SWALLOW A FAILURE HERE. Inventory wraps its gxIngestBug call in a bare catch because it
 * has an email fallback to fall back TO. Crew has none, so a swallowed throw would return ok:true
 * and the user would read "✓ Reported — thank you!" over a report that does not exist. That exact
 * silent-success is the failure gx-bugreport.js checks res.ok to avoid, and the one gxIngestBug's
 * own title fallback was written for. Let the error travel.
 *
 * NOTE THE PIN. `context` only reaches the sheet from GXCore v211, where gxIngestBug began
 * self-installing the bug_reports.context header — gxWrite_ maps onto the sheet's REAL header row,
 * so on an older pin the snapshot is dropped silently and the report still returns ok.
 */
function reportBug_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var title = String(p.title || '').trim();
  var desc  = String(p.desc  || '').trim();
  if (!title && !desc) return { ok: false, error: 'Say what went wrong.' };

  var res;
  try {
    res = GXCore.gxIngestBug('crew', auth.user, {
      title:    title,
      desc:     desc,
      priority: String(p.priority || 'normal'),
      tab:      String(p.tab || ''),
      appVer:   String(p.appVer || ''),
      context:  String(p.context || '')
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach the central bug log: ' +
                              String((e && e.message) || e) };
  }
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'GX Core refused the report' };
  return { ok: true, id: res.id };
}

function getReview_(p) {
  // Deploy secret is accepted alongside a user session so the queue can be inspected from
  // tooling, same as seed_preview. Resolving still requires a real signed-in editor.
  var auth = deploySecretOk_(p) ? { ok: true, user: 'tooling', role: 'admin' } : requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  var items = reviewItems_();
  var counts = { high: 0, warn: 0, info: 0 };
  items.forEach(function (i) { counts[i.severity] = (counts[i.severity] || 0) + 1; });
  return { ok: true, can_edit: canEdit_(auth), total: items.length, counts: counts, items: items };
}

/**
 * Resolve one item. `choice` is 'accept' (take the proposed value), 'keep' (the current value is
 * correct) or 'dismiss' (not a problem). All three record a decision — "I looked and it's fine"
 * is an answer, and must silence the item just as firmly as a correction does.
 */
function resolveReview_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.id || '').trim();
  var choice = String(p.choice || '').trim();
  if (!id) return { ok: false, error: 'id required' };
  if (['accept', 'keep', 'dismiss'].indexOf(choice) < 0) {
    return { ok: false, error: 'choice must be accept, keep or dismiss' };
  }
  var items = reviewItems_();
  var item = null;
  for (var i = 0; i < items.length; i++) if (items[i].id === id) { item = items[i]; break; }
  if (!item) return { ok: false, error: 'no open review item with that id (already resolved?)' };

  var applied = '';
  if (choice === 'accept') {
    if (item.kind === 'duplicate') {
      var m = mergeEmployees_({ token: p.token, keep: item.employee_id,
                                merge: item.merge_from, confirm: 'yes' });
      if (!m.ok) return m;
      applied = 'merged ' + item.merge_from_name + ' into ' + item.name;
    } else if (item.kind === 'name_spelling' || item.kind === 'role') {
      var field = item.kind === 'role' ? 'role_title' : 'full_name';
      var value = item.proposed_value;
      /* A role proposal comes from outside (an import posts it via review_report), so it can
         name a title we do not carry. Accepting is a WRITE to Core identity and gets the same
         closed set as the roster dropdown — "keep" and "dismiss" are still open, so the item
         can be cleared without widening the vocabulary through the back door. */
      if (field === 'role_title') {
        value = normRole_(value);
        if (!value) {
          return { ok: false, error: 'cannot accept role "' + item.proposed_value + '" — not one of ' +
                                     ROLE_TITLES.join(', ') + '. Keep or dismiss instead.' };
        }
      }
      var identity = GXCore.getEmployees() || [];
      var prior = null;
      for (var z = 0; z < identity.length; z++) {
        if (String(identity[z].employee_id || '').trim() === item.employee_id) { prior = identity[z]; break; }
      }
      if (!prior) return { ok: false, error: 'unknown employee_id: ' + item.employee_id };
      var merged = {};
      Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
      merged[field] = value;
      GXCore.gxUpsertEmployee(merged);
      applied = field + ' → ' + value;
    } else if (item.kind === 'new_hire') {
      /* THE ONE PLACE THE NIGHTLY SCAN'S FINDING BECOMES A WRITE, and it takes a human pressing
         a button to get here. Read the pending row rather than trusting the item: the item was
         built from a scan that may be hours old, and this creates a row every app in the suite
         reads. */
      var pend = null;
      readTab_(PENDING_TAB, PENDING_HEADERS).forEach(function (x) {
        if (String(x.name_key || '').trim() === item.employee_id) pend = x;
      });
      if (!pend) return { ok: false, error: 'no pending hire with that key — already added, or the scan has moved on' };
      var rt = normRole_(pend.role_title) || '';
      GXCore.gxUpsertEmployee({
        employee_id: pend.name_key, full_name: pend.full_name,
        home_store: pend.home_store || '', role_title: rt,
        dutchie_employee_id: pend.dutchie_employee_id || '', status: 'active'
      });
      applied = 'added ' + pend.full_name + ' to the roster';
    } else {
      // Compliance items (renew a permit, revoke access, fill a gap) are actioned OUTSIDE this
      // app. Accepting records that it was handled; it does not pretend to have done it.
      applied = 'acknowledged as handled';
    }
  }

  sheetOf_(DECISION_TAB, DECISION_HEADERS).appendRow([
    id, item.kind, item.employee_id, item.field, choice,
    choice === 'accept' ? item.proposed_value : item.current_value,
    auth.user, new Date().toISOString(), applied
  ]);
  bustRosterCache_();
  return { ok: true, id: id, choice: choice, applied: applied };
}

/** Imports post what the engine cannot see (HR sheet / METRC disagreements) into the queue. */
function reportConflicts_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var list = (body && body.conflicts) || [];
  if (!list.length) return { ok: false, error: 'no conflicts in payload' };
  var sh = sheetOf_(REVIEW_TAB, REVIEW_HEADERS);
  // Replace wholesale: these are re-derived by whoever runs the reconciliation, and stale rows
  // would linger forever. Decisions live in the other tab and are unaffected.
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  var now = new Date().toISOString();
  var rows = list.map(function (c) {
    return REVIEW_HEADERS.map(function (h) {
      if (h === 'reported_at') return now;
      if (h === 'review_id') return decisionKey_(c.kind, c.employee_id, c.field, c.proposed_value);
      return String(c[h] == null ? '' : c[h]);
    });
  });
  if (rows.length) sh.getRange(2, 1, rows.length, REVIEW_HEADERS.length).setValues(rows);
  bustRosterCache_();
  return { ok: true, reported: rows.length };
}

// ─── Leaderboard hand-off: nicknames + avatars → Core display fields ────────────
/*
 * Per core-admin (v127) nickname and avatar are CORE display fields, not Crew attributes:
 * Leaderboard reads them from the registry, Crew is the sole writer. This migrates the two
 * ScriptProperty blobs Leaderboard has carried since before the split.
 *
 * THE SEED. A DiceBear avatar is generated from a seed. Leaderboard seeded from the nameKey,
 * which is derived from the person's NAME — so a legal-name change, a nickname change or one of
 * our merges silently regenerates a different face. We therefore stamp `seed` INTO avatar_config,
 * pinned to employee_number (the stable key), so the face survives every rename from here on.
 *
 * Leaderboard's own keying is already inconsistent — it carries avatars under both `zach_r`
 * (a nickname) and `zachary_rodriguez` for the same person. Fuzzy matching resolves those, and
 * anything it cannot resolve is REPORTED rather than guessed.
 */
function migrateLeaderboard_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var nicknames = (body && body.nicknames) || {};
  var avatars   = (body && body.avatarConfigs) || {};
  if (!Object.keys(nicknames).length && !Object.keys(avatars).length) {
    return { ok: false, error: 'payload carried neither nicknames nor avatarConfigs' };
  }
  var dry = String(p.confirm || '') !== 'yes';

  var existing = GXCore.getEmployees() || [];
  var attrs = readAttrs_();
  var byId = Object.create(null);
  existing.forEach(function (r) { byId[String(r.employee_id || '').trim()] = r; });

  function resolve(k) {
    if (byId[k]) return byId[k];
    // exact nameKey miss — try the same person-matcher the importer uses
    var want = String(k).replace(/_/g, ' ');
    for (var i = 0; i < existing.length; i++) {
      if (samePerson_(want, existing[i].full_name)) return existing[i];
    }
    return null;
  }

  var writes = Object.create(null), resolved = [], unmatched = [], collisions = [];

  Object.keys(nicknames).forEach(function (k) {
    var e = resolve(k);
    if (!e) { unmatched.push('nickname ' + k + ' → ' + nicknames[k]); return; }
    var id = String(e.employee_id).trim();
    writes[id] = writes[id] || { employee_id: id };
    writes[id].preferred_name = String(nicknames[k]).trim();
    if (k !== id) resolved.push('nickname ' + k + ' → ' + e.full_name);
  });

  Object.keys(avatars).forEach(function (k) {
    var e = resolve(k);
    if (!e) { unmatched.push('avatar ' + k); return; }
    var id = String(e.employee_id).trim();
    var cfg = avatars[k] || {};
    writes[id] = writes[id] || { employee_id: id };
    if (writes[id].avatar_config) { collisions.push(e.full_name + ' (keys ' + k + ' and another)'); }
    // Pin the seed to employee_number so no future rename can scramble the face. Fall back to
    // employee_id only when a number is genuinely absent.
    cfg.seed = avatarSeedFrom_(attrs[id], e, id);
    writes[id].avatar_config = JSON.stringify(cfg);
    if (k !== id) resolved.push('avatar ' + k + ' → ' + e.full_name);
  });

  // Merge onto the live row — gxWrite_ replaces whole rows, so a partial write would blank
  // everything else we have spent this whole session populating.
  var rows = Object.keys(writes).map(function (id) {
    var merged = {};
    Object.keys(byId[id] || {}).forEach(function (kk) { merged[kk] = byId[id][kk]; });
    merged.employee_id = id;
    if (writes[id].preferred_name) merged.preferred_name = writes[id].preferred_name;
    if (writes[id].avatar_config)  merged.avatar_config  = writes[id].avatar_config;
    return merged;
  });

  var out = { ok: true, mode: dry ? 'preview' : 'commit',
              nicknames_in: Object.keys(nicknames).length, avatars_in: Object.keys(avatars).length,
              people_to_write: rows.length, matched_by_fuzzy: resolved,
              unmatched: unmatched, avatar_key_collisions: collisions };
  if (dry) { out.note = 'DRY RUN — nothing written. Repeat with confirm=yes.'; return out; }
  GXCore.gxUpsertEmployees(rows);
  bustRosterCache_();
  out.written = rows.length;
  return out;
}

// ─── Merge (TJ Peterson → Thomas Peterson) ──────────────────────────────────────
/*
 * Duplicates are structural here, not accidental: three systems (Dutchie, METRC, the HR
 * workbook) each spell people their own way, and new hires keep arriving. A one-off cleanup
 * fixes today and gets undone by the next import.
 *
 * So a merge does three things, and the third is the one that makes it stick:
 *   1. moves Crew attributes from the loser onto the winner, FILLING GAPS ONLY — a populated
 *      value on the winner is never overwritten by the duplicate;
 *   2. marks the loser 'merged' in Core so it leaves the roster (nothing is deleted — the row
 *      stays auditable, and un-merging is possible);
 *   3. records the loser's name as an ALIAS, so the next import resolves "TJ Peterson" onto
 *      Thomas Peterson's employee_id instead of creating the duplicate all over again.
 */
function aliasSheet_() {
  var ss = crewSheet_().getParent();
  var sh = ss.getSheetByName(ALIAS_TAB);
  if (!sh) {
    sh = ss.insertSheet(ALIAS_TAB);
    sh.getRange(1, 1, 1, ALIAS_HEADERS.length).setValues([ALIAS_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** { aliasKey → employee_id } for every name that has been merged away. */
function readAliases_() {
  var sh = aliasSheet_();
  var last = sh.getLastRow();
  if (last < 2) return Object.create(null);
  var v = sh.getRange(2, 1, last - 1, ALIAS_HEADERS.length).getValues();
  var out = Object.create(null);
  v.forEach(function (r) {
    var k = String(r[0] || '').trim();
    if (k) out[k] = String(r[2] || '').trim();
  });
  return out;
}

function mergeEmployees_(p) {
  // Deploy secret is accepted alongside a user session, so a coordinated cross-app merge can be
  // run from tooling. It still needs confirm=yes — merging identity rows moves payout math.
  var auth = deploySecretOk_(p) ? { ok: true, user: 'tooling', role: 'admin' } : requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var winner = String(p.keep || '').trim();
  var loser  = String(p.merge || '').trim();
  if (!winner || !loser) return { ok: false, error: 'keep and merge employee_ids are both required' };
  if (winner === loser)  return { ok: false, error: 'cannot merge someone into themselves' };

  var identity = GXCore.getEmployees() || [];
  var W = null, L = null;
  identity.forEach(function (r) {
    var id = String(r.employee_id || '').trim();
    if (id === winner) W = r;
    if (id === loser)  L = r;
  });
  if (!W) return { ok: false, error: 'unknown employee_id to keep: ' + winner };
  if (!L) return { ok: false, error: 'unknown employee_id to merge: ' + loser };

  var attrs = readAttrs_();
  var wa = attrs[winner] || {}, la = attrs[loser] || {};
  var merged = { employee_id: winner, name_key: nameToKey_(W.full_name), full_name: String(W.full_name || '') };
  var filled = [];
  attrFields_().forEach(function (k) {
    var mine = String(wa[k] || '').trim(), theirs = String(la[k] || '').trim();
    merged[k] = mine || theirs;
    if (!mine && theirs) filled.push(k);
  });
  merged.updated_at = new Date().toISOString();
  merged.updated_by = auth.user + ' (merge)';

  // Identity: take the loser's hire_date / dutchie id only where the winner has none.
  var wid = {};
  Object.keys(W).forEach(function (k) { wid[k] = W[k]; });
  var idFilled = [];
  ['hire_date', 'dutchie_employee_id', 'home_store', 'role_title', 'user_id',
   'employee_number', 'preferred_name', 'avatar_config'].forEach(function (k) {
    if (!String(wid[k] || '').trim() && String(L[k] || '').trim()) {
      wid[k] = L[k];
      idFilled.push(k + '=' + L[k]);
    }
  });
  wid.employee_id = winner;

  if (String(p.confirm || '') !== 'yes') {
    return { ok: true, mode: 'preview', keep: winner, keep_name: W.full_name,
             merge: loser, merge_name: L.full_name,
             // Both halves matter: attribute gaps AND the identity columns folded across.
             // Reporting only the first made a merge that DOES move data look like a no-op.
             would_fill_attributes: filled, would_fill_identity: idFilled,
             keeps_dutchie_id: String(wid.dutchie_employee_id || '') || '(none)',
             keeps_user_id: String(wid.user_id || '') || '(none)',
             note: 'DRY RUN — nothing written. Repeat with confirm=yes.' };
  }

  var lid = {};
  Object.keys(L).forEach(function (k) { lid[k] = L[k]; });
  lid.employee_id = loser;
  lid.status = 'merged';

  GXCore.gxUpsertEmployees([wid, lid]);
  writeAttrs_(merged);

  var sh = aliasSheet_();
  sh.appendRow([nameToKey_(L.full_name), String(L.full_name || ''), winner,
                new Date().toISOString(), auth.user]);
  bustRosterCache_();
  return { ok: true, mode: 'merged', keep: winner, keep_name: W.full_name,
           merged_away: L.full_name, filled_attributes: filled, filled_identity: idFilled,
           kept_dutchie_id: String(wid.dutchie_employee_id || '') || '(none)',
           kept_user_id: String(wid.user_id || '') || '(none)' };
}


/*
 * Which cells look wrong or unfinished. Computed server-side so the roster, any future export
 * and the UI all agree on what "questionable" means — and so fixing a value in the UI clears
 * the flag on the next read with no second definition to keep in sync.
 *
 * Only ever flags MISSING or MALFORMED data. It never flags a value merely because it is
 * unusual: a genuinely low wage or an odd shirt size is not an error, and crying wolf on those
 * teaches people to ignore the red.
 */
/* ── "New here": arrived, but the record was never finished ──────────────────────
 * ONE definition, computed here, exactly like rowFlags_ and for the same reason: the roster, the
 * Monday digest and anything later must not each carry their own idea of who is new. The client
 * reads `needs_setup` off the row; it does not re-derive it.
 *
 * Both halves are load-bearing. A setup gap ALONE put Sky and Mike at the top of a list headed
 * "New here" — neither takes an hourly wage, so both carried a permanent `wage` gap, and nobody
 * has been here longer. So it also takes signs of a recent arrival: no hire date at all (we
 * cannot tell how long they have been here, which is itself an unfinished record), no employee
 * number yet (they turned up since the last assignment run), or a start date inside 90 days.
 */
var SETUP_FLAGS = ['hire_date', 'wage', 'store', 'role', 'employee_number'];
function needsSetup_(r, today) {
  if (r.retired) return false;
  var gap = false;
  for (var i = 0; i < SETUP_FLAGS.length; i++) {
    if ((r.flags || []).indexOf(SETUP_FLAGS[i]) >= 0) { gap = true; break; }
  }
  if (!gap) return false;
  if (!String(r.employee_number || '').trim()) return true;
  if (!r.hire_date) return true;
  var d = dateFromIso_(r.hire_date);
  return !!d && daysBetween_(d, today) <= 90;
}

function rowFlags_(r) {
  var f = [];
  // Checked BEFORE the retired escape hatch: an incomplete retired record is expected, but a
  // record with no NAME is not incomplete, it is damaged — a GX Core row that a partial write
  // blanked. identityRepair_ explains the mechanism and puts it back.
  if (!String(r.name || '').trim()) f.push('name');
  if (r.retired) return f;                       // retired records are allowed to be incomplete
  if (!r.employee_number)          f.push('employee_number');
  if (!r.hire_date)                f.push('hire_date');
  if (!r.store)                    f.push('store');
  if (r.role_is_default)           f.push('role');
  /* A manager with no GX account is a DEFECT, not a preference (Sky, 2026-08-20: every manager
     having an account is deliberate policy, not something that merely accumulated).

     It matters because it fails SILENTLY. Send-to-Managers and every notification target the
     employees.user_id -> users.email join, so an unlinked manager is not refused — they are
     simply never contacted, and the send reports success. That is how sam_keck sat unreachable
     with a perfectly good account already sitting in `users`; only the LINK was missing.

     Deliberately the same test GX Core's identity_health uses -- /manager/i on the role title,
     active rows only -- so the roster and the suite-wide detector can never disagree about who
     counts. Two detectors that answer differently are worse than one. Admin is excluded there
     and so here: notifications target managers. Retired rows never reach this line. */
  if (MANAGER_ROLE_RE.test(r.role) && !String(r.user_id || '').trim()) f.push('no_account');
  /* Not "has no wage" — "has no wage AND is supposed to have one". A salaried manager and the
     owner both hold an empty wage correctly; see pay_type above. */
  if (!r.wage && !r.wage_exempt) f.push('wage');
  if (!r.birthday)                 f.push('birthday');
  if (!r.permit_number)            f.push('permit');
  else if (r.permit_days_left != null && r.permit_days_left < 0) f.push('permit_expired');
  if (r.permit_status && ['active', 'valid'].indexOf(String(r.permit_status).toLowerCase()) < 0)
    f.push('permit_status');
  return f;
}

// ─── Roster cache ───────────────────────────────────────────────────────────────
/*
 * GXCore.getEmployees() measured ~9.8s on its own, and the roster also reads Crew's attribute
 * sheet — together comfortably past the 8s JSONP budget in gx-client, so every attempt timed
 * out and the roster never loaded at all. Most of that is fixed overhead (library load +
 * SpreadsheetApp open), not row count, so it does not shrink as we optimize the join.
 *
 * We cache the expensive part — the identity x attributes join — and keep the per-user bits
 * (role, can_edit) outside it, so the cache can never hand one user another user's permissions.
 * Short TTL, and every writer busts it, so an edit is visible immediately rather than up to a
 * minute later.
 */
var ROSTER_CACHE_KEY = 'crew:roster:v1';
var ROSTER_CACHE_TTL = 120;   // seconds

function bustRosterCache_() {
  try { CacheService.getScriptCache().remove(ROSTER_CACHE_KEY); } catch (e) {}
}

function rosterJoin_() {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(ROSTER_CACHE_KEY);
    if (hit) { var o = JSON.parse(hit); o.cached = true; return o; }
  } catch (e) { /* fall through and rebuild */ }

  var identity = [], identityError = '';
  try { identity = GXCore.getEmployees() || []; }
  catch (e) { identityError = String((e && e.message) || e); }

  var attrs = readAttrs_();
  var today = todayInStoreTz_();

  var rows = identity.map(function (r) {
    var id = String(r.employee_id || '').trim();
    var a  = attrs[id] || {};
    /* NOT statusIsLive_, deliberately: this screen RENDERS both states and has to tell them
       apart — retired is a person who left, merged is a tombstone. The helper collapses them
       into one boolean, which is right for every caller that only asks "still here?". */
    var st = String(r.status || 'active').toLowerCase();
    var isRetired = st === 'retired' || st === 'inactive' || st === 'terminated' || st === 'false';
    var isMerged  = st === 'merged';
    var anniv = normDate_(a.work_anniversary) || normDate_(r.hire_date);
    return {
      employee_id: id, name_key: nameToKey_(r.full_name), name: String(r.full_name || ''),
      store: String(r.home_store || ''),
      preferred_name: String(r.preferred_name || ''),
      middle_initial: String(a.middle_initial || '').trim().toUpperCase().slice(0, 1),
      swipeclock_code: String(a.swipeclock_code || '').trim(),
      avatar_config: String(r.avatar_config || ''),
      /* THE AVATAR SEED. DiceBear generates a face from a seed, and Leaderboard historically
         seeded on nameKey — which derives from the NAME, so a rename or one of our merges
         silently produced a different person's face. Pinned to employee_number, which is
         issued once and never reused. employee_id is only a fallback for someone not yet
         numbered; they get a stable face the moment a number is assigned. */
      avatar_seed: avatarSeedFrom_(a, r, id),
      dutchie_employee_id: String(r.dutchie_employee_id || ''),
      user_id: String(r.user_id || ''),
      role: String(r.role_title || '').trim() || 'Budtender',
      role_is_default: !String(r.role_title || '').trim(),
      retired: isRetired, merged: isMerged,
      hire_date: normDate_(r.hire_date),
      time_with_company: timeWithCompany_(normDate_(r.hire_date), today),
      employee_number: a.employee_number || '', wage: a.wage || '',
      shirt_size: normShirt_(a.shirt_size), birthday: normBirthday_(a.birthday),
      work_anniversary: anniv, anniversary_is_override: !!normDate_(a.work_anniversary),
      celebrations_opt_out: isTruthyFlag_(a.celebrations_opt_out),
      digest_opt_in: isTruthyFlag_(a.digest_opt_in),
      pay_type: normPayType_(a.pay_type) || (isTruthyFlag_(a.not_on_payroll) ? 'none' : 'hourly'),
      /* Derived once here so the UI and rowFlags_ cannot disagree about it. */
      wage_exempt: wageExempt_(a.pay_type, a.not_on_payroll),
      permit_number: a.permit_number || '',
      /* NORMALIZED, like hire_date two lines up — this was the one date on the row that was not,
         and the omission was silent in the worst way. readAttrs_ does String() over the cell, so
         a permit_expires that Sheets stored as a real Date comes back as
         "Sat May 19 2029 00:00:00 GMT-0700 (Pacific Daylight Time)". dateFromIso_ cannot read
         that, so permit_days_left was null -- and EVERY compliance check downstream gates on it
         being a number: rowFlags_ skips permit_expired, and reviewItems_ raises neither
         permit_expired nor permit_expiring. The roster showed a permit with an unreadable date
         and no warning attached, and the queue reported all clear. normDate_ has tolerated a
         real Date since it was written; it just was not being called here. */
      permit_expires: normDate_(a.permit_expires),
      permit_status: a.permit_status || '',
      permit_days_left: normDate_(a.permit_expires)
        ? daysBetween_(today, dateFromIso_(normDate_(a.permit_expires))) : null,
      permit_active: a.permit_status
        ? (['active', 'valid'].indexOf(String(a.permit_status).toLowerCase()) >= 0 ? 'Yes' : 'No')
        : '',
      updated_at: a.updated_at || '', updated_by: a.updated_by || ''
    };
  }).map(function (r) { r.flags = rowFlags_(r); r.needs_setup = needsSetup_(r, today); return r; })
    .filter(function (r) { return !r.merged; })
    .sort(function (x, y) { return x.name.localeCompare(y.name); });

  var out = { rows: rows, identityCount: identity.length, identityError: identityError, cached: false };
  // Only cache a good read. Caching an empty result behind a transient GX Core error would
  // serve "you have no staff" for the whole TTL.
  if (!identityError && rows.length) {
    try { cache.put(ROSTER_CACHE_KEY, JSON.stringify(out), ROSTER_CACHE_TTL); } catch (e) {}
  }
  return out;
}

function getRoster_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var joined = rosterJoin_();
  var includeRetired = String(p.include_retired || '') === '1';
  var retiredCount = 0;
  joined.rows.forEach(function (r) { if (r.retired) retiredCount++; });

  return {
    ok: true, user: auth.user, role: auth.role, can_edit: canEdit_(auth),
    shirt_sizes: SHIRT_SIZES, role_titles: ROLE_TITLES, hr_sheet_url: HR_SHEET_URL,
    include_retired: includeRetired, retired_total: retiredCount, cached: joined.cached,
    rows: joined.rows.filter(function (r) { return includeRetired || !r.retired; }),
    identity_source: {
      count: joined.identityCount, error: joined.identityError,
      note: joined.identityCount ? '' :
        'GX Core `employees` is empty — identity has no writer yet (needs core-admin: gxUpsertEmployee + seed). ' +
        'Crew attributes are stored and will join automatically once identity lands.'
    }
  };
}

function dateFromIso_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * "10yr 7mo", matching how the HR sheet already phrases it — managers read this column next to
 * a printout, so the format should not need translating.
 */
function timeWithCompany_(hireIso, today) {
  var d = dateFromIso_(hireIso);
  if (!d) return '';
  var months = (today.getFullYear() - d.getFullYear()) * 12 + (today.getMonth() - d.getMonth());
  if (today.getDate() < d.getDate()) months--;
  if (months < 0) return '';
  return Math.floor(months / 12) + 'yr ' + (months % 12) + 'mo';
}


/**
 * Edit the GX Core identity slice from the roster. Crew is the sole writer up to Core, so this
 * is the only path Mike has for fixing a name, nickname, store, role or hire date.
 *
 * READ-MERGE-WRITE, non-negotiable. gxWrite_ rebuilds the entire row from the record and writes
 * '' for anything absent, so a partial update silently destroys columns this app never shows —
 * dutchie_employee_id (SPIFF and Leaderboard attribution resolve through it) and user_id (the
 * link to the users tab that owns email). core-admin lost these once already and caught it only
 * by diffing all 75 rows. We read the live row, lay changes on top, and write the whole thing back.
 */
var IDENTITY_FIELDS = ['full_name', 'preferred_name', 'home_store', 'role_title', 'hire_date',
                       'avatar_config'];

function saveIdentity_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.employee_id || '').trim();
  if (!id) return { ok: false, error: 'employee_id required' };

  var identity = GXCore.getEmployees() || [];
  var prior = null;
  for (var i = 0; i < identity.length; i++) {
    if (String(identity[i].employee_id || '').trim() === id) { prior = identity[i]; break; }
  }
  if (!prior) return { ok: false, error: 'unknown employee_id: ' + id };

  // Validate before touching anything — a half-applied identity edit is worse than a refusal.
  var changes = {}, touched = [];
  if (p.full_name != null) {
    var nm = String(p.full_name).replace(/\s+/g, ' ').trim();
    if (!nm) return { ok: false, error: 'name cannot be empty' };
    if (nm.indexOf(' ') < 0) return { ok: false, error: 'name should be first and last: "' + nm + '"' };
    changes.full_name = nm;
  }
  if (p.preferred_name != null) changes.preferred_name = String(p.preferred_name).trim();
  if (p.home_store != null) {
    var st = String(p.home_store).trim();
    if (st) {
      var known = (GXCore.getStores() || []).some(function (x) { return String(x.store_id).trim() === st; });
      if (!known && st !== 'corporate') return { ok: false, error: 'unknown store: ' + st };
    }
    changes.home_store = st;
  }
  if (p.role_title != null) {
    var rt = String(p.role_title).replace(/\s+/g, ' ').trim();
    /* The roster sends one of ROLE_TITLES or ''. Anything else reached us around the dropdown,
       so refuse rather than store it — this is the field Leaderboard renders and SPIFF groups by,
       and a one-off variant here becomes an unmatchable role everywhere else.
       The exception is a title this row ALREADY holds: rows predating the vocabulary carry one,
       the panel offers it back unchanged, and refusing it would make every other field on that
       person uneditable until somebody re-filed them. Keeping a value is not introducing one. */
    if (rt && !normRole_(rt) && rt !== String(prior.role_title || '').replace(/\s+/g, ' ').trim()) {
      return { ok: false, error: 'invalid role: ' + rt + ' (expected one of ' + ROLE_TITLES.join(', ') + ')' };
    }
    changes.role_title = rt ? (normRole_(rt) || rt) : '';
  }
  /* Parsed here, written further down — an avatar-only edit does not go through the merge at
     all. Validate before touching anything either way: a half-applied identity edit is worse
     than a refusal, and this is the one field that can arrive as malformed JSON. */
  var avatarCfg;                                  // undefined = untouched, null = clear
  if (p.avatar_config != null) {
    var av = String(p.avatar_config).trim();
    avatarCfg = null;
    if (av) {
      // Store the config, never a rendered image — Core keeps DiceBear params only.
      try {
        avatarCfg = JSON.parse(av);
        if (!avatarCfg || typeof avatarCfg !== 'object' || Array.isArray(avatarCfg)) throw new Error('not an object');
      } catch (e) {
        return { ok: false, error: 'avatar_config must be a JSON object of DiceBear params' };
      }
    }
    changes.avatar_config = av;
  }
  if (p.hire_date != null) {
    var hd = String(p.hire_date).trim();
    if (hd && !normDate_(hd)) return { ok: false, error: 'invalid hire date: ' + hd + ' (expected YYYY-MM-DD)' };
    changes.hire_date = hd ? normDate_(hd) : '';
  }
  if (!Object.keys(changes).length) return { ok: false, error: 'nothing to change' };

  /* AN AVATAR-ONLY EDIT IS NOT AN IDENTITY WRITE — it is THE avatar write, and GX Core owns that
     now. GXCore.setAvatar (v225) pins the seed, retries lock contention, NAMES avatar_config in
     clear= and then verifies the clear actually landed. It is this app's own logic, promoted, so
     that Leaderboard's copy could be deleted rather than left disagreeing with ours. Every write
     the picker makes lands here: it saves one field at a time.

     The MIXED case deliberately does not delegate. An avatar arriving with a name or a store
     change is one atomic row write, and splitting it into two calls to route the avatar
     separately would give a half-applied identity edit a way to exist — the exact failure the
     validation above is arranged to prevent. It stamps the seed locally instead (same
     definition, avatarSeed_), which is why that helper is still here. */
  var avatarOnly = Object.keys(changes).length === 1 && changes.avatar_config != null;
  if (avatarOnly) return saveAvatarOnly_(id, prior, avatarCfg, changes.avatar_config, auth.user);

  if (avatarCfg) {
    /* The picker builds a config from DEFAULT_AVATAR, which carries no seed, so a brand-new
       avatar created in Crew used to be stored without one — and it RENDERED fine, because the
       seed is re-derived at read time. The invariant regressed silently while every face stayed
       correct. Unconditional: it also repairs a config that arrives carrying a stale seed. */
    avatarCfg.seed = avatarSeed_(id, prior);
    changes.avatar_config = JSON.stringify(avatarCfg);
  }

  var merged = {};
  Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });   // <- every column survives
  Object.keys(changes).forEach(function (k) {
    if (String(prior[k] || '') !== String(changes[k])) touched.push(k);
    merged[k] = changes[k];
  });
  merged.employee_id = id;
  /* Every field the caller deliberately emptied that currently holds a value. Core will not blank
     on an empty value alone, so these must be NAMED — and naming them is what keeps an ordinary
     partial write from ever blanking anything by accident. */
  var wantClear = Object.keys(changes).filter(function (k) {
    return String(changes[k] == null ? '' : changes[k]) === '' && String(prior[k] || '').trim();
  });
  if (wantClear.length) merged.clear = wantClear.join(',');
  var res = GXCore.gxUpsertEmployee(merged);
  /* Kept as a safety net even though clear= now works: it compares Core's OWN answer against the
     request, so if a field ever stops being clearable this reports it instead of quietly claiming
     a change that did not happen. That silent-success is the bug this pair exists to prevent. */
  var uncleared = unclearedFields_(prior, changes, res);
  if (uncleared.length) {
    touched = touched.filter(function (k) { return uncleared.indexOf(k) < 0; });
  }

  // employee_id is derived from the name, so a rename leaves the old key stranded in every
  // other app. Record an alias so imports and lookups keep resolving to this row.
  if (changes.full_name && nameToKey_(prior.full_name) !== nameToKey_(changes.full_name)) {
    sheetOf_(ALIAS_TAB, ALIAS_HEADERS).appendRow([
      nameToKey_(prior.full_name), String(prior.full_name || ''), id,
      new Date().toISOString(), auth.user + ' (rename)'
    ]);
  }

  bustRosterCache_();
  return { ok: true, employee_id: id, changed: touched, not_cleared: uncleared,
           warning: uncleared.length
             ? 'Could not clear ' + uncleared.join(', ') + ' — GX Core treats an empty value as ' +
               '"leave alone", so these keep their previous value. Everything else saved.'
             : '',
           preserved: ['dutchie_employee_id', 'user_id', 'employee_number', 'avatar_config']
             .filter(function (k) { return String(prior[k] || '').trim(); }) };
}

/**
 * The avatar-only branch of saveIdentity_: hand the write to GX Core and translate its answer
 * back into the shape roster_identity's caller already reads.
 *
 * There is no read-merge-write here and that is the point — GXCore.setAvatar sends a PATCH of
 * { employee_id, avatar_config } (plus clear= when removing), and Core's own upsert merges it
 * onto the live row. Crew is not omitting columns; it is not sending a row at all, so there is
 * nothing for gxWrite_ to blank. dutchie_employee_id and user_id are untouched by construction
 * rather than by remembering to carry them, which is the whole reason the primitive exists.
 */
function saveAvatarOnly_(id, prior, cfg, requested, by) {
  var res;
  try {
    res = GXCore.setAvatar(id, cfg || '', String(by || 'crew') + ' (crew roster)');
  } catch (e) {
    /* No setAvatar means the LIVE DEPLOYMENT binds a library below v225 — the manifest at HEAD
       says nothing about what the deployed snapshot runs, so name the fix (re-pin AND redeploy)
       instead of surfacing "setAvatar is not a function" to somebody picking a hat. */
    return { ok: false, employee_id: id,
             error: 'GX Core could not save the avatar: ' + String((e && e.message) || e) +
                    ' — setAvatar needs GXCore v225; check ?action=health for the live pin' };
  }
  if (!res || res.ok === false) {
    return { ok: false, employee_id: id, retryable: !!(res && res.retryable),
             error: (res && res.error) || 'GX Core returned nothing for setAvatar' };
  }
  bustRosterCache_();
  /* setAvatar VERIFIES a clear actually landed and fails loud if it did not, so not_cleared is
     empty by construction on this path. It stays in the response because the caller treats a
     warning as a failed save, and the two branches of roster_identity must not answer in
     different shapes. */
  return { ok: true, employee_id: id,
           changed: avatarCfgSame_(prior.avatar_config, requested) ? [] : ['avatar_config'],
           not_cleared: [], warning: '', seed: res.seed, cleared: !!res.cleared,
           preserved: ['dutchie_employee_id', 'user_id', 'employee_number', 'full_name']
             .filter(function (k) { return String(prior[k] || '').trim(); }) };
}

/*
 * Same avatar, ignoring the seed. `changed` reports what a HUMAN altered, and the seed is
 * stamped by the writer, not chosen by the caller — the picker posts a config with no seed at
 * all, so a raw string compare against the stored value would call every re-save a change.
 */
function avatarCfgSame_(a, b) {
  function norm(v) {
    var raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { return raw; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return raw;
    delete o.seed;
    return Object.keys(o).sort().map(function (k) { return k + '=' + o[k]; }).join('&');
  }
  return norm(a) === norm(b);
}

/**
 * Retire (or un-retire) someone. Status is GX Core identity, not a Crew attribute, so this
 * writes UP to Core — and read-merge-writes for the same reason hrImport_ does: gxWrite_
 * replaces the whole row, and a partial write would blank dutchie_employee_id.
 *
 * Nothing is deleted. Retired staff keep their attributes, their permit history and their
 * employee number; they simply drop out of the default roster view.
 */
function setRetired_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.employee_id || '').trim();
  if (!id) return { ok: false, error: 'employee_id required' };
  var retire = String(p.retired || '') !== '0';

  var identity = GXCore.getEmployees() || [];
  var prior = null;
  for (var i = 0; i < identity.length; i++) {
    if (String(identity[i].employee_id || '').trim() === id) { prior = identity[i]; break; }
  }
  if (!prior) return { ok: false, error: 'unknown employee_id: ' + id };

  var merged = {};
  Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
  merged.employee_id = id;
  merged.status = retire ? 'retired' : 'active';
  GXCore.gxUpsertEmployee(merged);
  bustRosterCache_();
  return { ok: true, employee_id: id, status: merged.status, by: auth.user };
}

/**
 * Save one employee's Crew-owned attributes. Identity fields are NOT writable here by design —
 * name/store/role belong to GX Core, and letting Crew edit them would fork the registry.
 */
function saveRosterAttrs_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'Your role is read-only on the Crew roster' };

  var id = String(p.employee_id || '').trim();
  if (!id) return { ok: false, error: 'employee_id required' };

  // Only accept an employee_id GX Core actually knows — otherwise a typo silently creates an
  // orphan attribute row that never joins to anyone and never shows up again.
  var identity = GXCore.getEmployees() || [];
  var match = null;
  for (var i = 0; i < identity.length; i++) {
    if (String(identity[i].employee_id || '').trim() === id) { match = identity[i]; break; }
  }
  if (!match) return { ok: false, error: 'unknown employee_id: ' + id };

  // Reject bad input loudly rather than storing '' — a silently-dropped birthday looks like a
  // save that worked, and nobody notices until the celebration never fires.
  var wage = String(p.wage == null ? '' : p.wage).trim();
  if (wage && !/^\$?\s*\d{1,3}(\.\d{1,2})?$/.test(wage)) {
    return { ok: false, error: 'invalid wage: ' + wage + ' (expected an hourly rate like 17.50)' };
  }
  // employee_number is issued by assignNumbers_, never typed: it is the key the whole suite
  // joins on, and a hand-entered collision would attach one person's history to another.
  if (p.employee_number != null) {
    return { ok: false, error: 'employee_number is assigned automatically and cannot be edited' };
  }
  var payType = String(p.pay_type == null ? '' : p.pay_type).trim();
  if (payType && !normPayType_(payType)) {
    return { ok: false, error: 'invalid pay_type: ' + payType + ' (expected one of ' + PAY_TYPES.join(', ') + ')' };
  }
  var shirt = String(p.shirt_size == null ? '' : p.shirt_size).trim();
  if (shirt && !normShirt_(shirt)) return { ok: false, error: 'invalid shirt_size: ' + shirt + ' (expected one of ' + SHIRT_SIZES.join(', ') + ')' };
  var bday = String(p.birthday == null ? '' : p.birthday).trim();
  if (bday && !normBirthday_(bday)) return { ok: false, error: 'invalid birthday: ' + bday + ' (expected MM-DD)' };
  var anniv = String(p.work_anniversary == null ? '' : p.work_anniversary).trim();
  if (anniv && !normDate_(anniv)) return { ok: false, error: 'invalid work_anniversary: ' + anniv + ' (expected YYYY-MM-DD)' };
  var pexp = String(p.permit_expires == null ? '' : p.permit_expires).trim();
  if (pexp && !normDate_(pexp)) return { ok: false, error: 'invalid permit expiry: ' + pexp + ' (expected YYYY-MM-DD)' };

  var existing = readAttrs_()[id] || {};
  var rec = {
    employee_id:      id,
    name_key:         nameToKey_(match.full_name),
    full_name:        String(match.full_name || ''),
    // Absent field = leave alone; empty string = explicit clear. Lets the UI PATCH one cell.
    shirt_size:       p.shirt_size       == null ? (existing.shirt_size       || '') : normShirt_(shirt),
    birthday:         p.birthday         == null ? (existing.birthday         || '') : normBirthday_(bday),
    work_anniversary: p.work_anniversary == null ? (existing.work_anniversary || '') : normDate_(anniv),
    employee_number:  existing.employee_number || '',
    wage:             p.wage             == null ? (existing.wage             || '') : wage.replace(/^\$\s*/, ''),
    // METRC stays the source of truth — an import overwrites these whenever it carries a value.
    // But 7 active staff have no permit on file at all, and a human who can read the permit
    // should be able to type it in rather than wait for the next export.
    permit_number:    p.permit_number  == null ? (existing.permit_number  || '') : String(p.permit_number).trim(),
    permit_granted:   existing.permit_granted || '',
    permit_expires:   p.permit_expires == null ? (existing.permit_expires || '') : (normDate_(String(p.permit_expires).trim()) || ''),
    permit_status:    p.permit_expires != null && String(p.permit_expires).trim() && !existing.permit_status
                        ? 'Active' : (existing.permit_status || ''),
    celebrations_opt_out: p.celebrations_opt_out == null
                        ? (existing.celebrations_opt_out || '')
                        : (isTruthyFlag_(p.celebrations_opt_out) ? 'yes' : ''),
    not_on_payroll:     p.not_on_payroll == null
                        ? (existing.not_on_payroll || '')
                        : (isTruthyFlag_(p.not_on_payroll) ? 'yes' : ''),
    pay_type:           p.pay_type == null ? (existing.pay_type || '') : normPayType_(p.pay_type),
    digest_opt_in:      p.digest_opt_in == null
                        ? (existing.digest_opt_in || '')
                        : (isTruthyFlag_(p.digest_opt_in) ? 'yes' : ''),
    /* One letter, upper case. Normalized on the way in rather than trusted: the payroll export
       reads this straight into a name and "j." or "James" would land in the file as typed. */
    middle_initial:     p.middle_initial == null
                        ? (existing.middle_initial || '')
                        : String(p.middle_initial).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1),
    /* WorkforceHub's employee code. THIS LIST IS HAND-WRITTEN and writeAttrs_ replaces the whole
       row, so a column added to ATTR_HEADERS but not to this record is blanked by the next roster
       edit — which is exactly how celebrations_opt_out was lost once already. */
    swipeclock_code:    p.swipeclock_code == null
                        ? (existing.swipeclock_code || '')
                        : String(p.swipeclock_code).trim(),
    updated_at:       new Date().toISOString(),
    updated_by:       String(auth.user || '')
  };
  writeAttrs_(rec);
  bustRosterCache_();
  return { ok: true, employee_id: id, saved: rec };
}


// ─── Monday digest: "Everything that needs a person", by email ──────────────────
/*
 * The same recap the roster's overview shows.
 *
 * IT USED TO EXCLUDE EMPLOYEE OF THE MONTH, on the grounds that a nice thing to look at mixed
 * into a list of things to do teaches people to skim. That reasoning stands and the distinction
 * it draws is the one that let EoM back in (Sky, 2026-08-29): the roster's EoM PANEL — who holds
 * it, the reign log — is decoration and is still not here. The first-Monday REMINDER is not; it
 * is an ask with a deadline, and the only line in this email that expires. Same test applied to
 * celebrations: a birthday on Thursday needs a person to say it, so it belongs — but below the
 * queue, not inside it.
 *
 * WHY EMAIL AT ALL, given the app already says this. Because the app only says it to somebody
 * who opens the app. A permit expiring in 36 days is not urgent enough to make anyone open Crew
 * on a Tuesday, and it stays not-urgent right up until it is expired.
 *
 * It reads. It writes nothing, and it is deliberately not the place any of this gets actioned —
 * every line links back to the roster, because that is where the decisions are recorded.
 */
/* WHO GETS IT IS A PER-PERSON SETTING, not a list in this file (Sky, 2026-08-25).
 *
 * `digest_opt_in` on the employee record, ticked from their own record in the app. Two conditions,
 * and the second is not a formality: they must have opted in, AND have a `user_id` — the GX
 * account, which is where the address comes from. Somebody with no account has nowhere to receive
 * it, so the control says so rather than storing a preference that can never be honored.
 *
 * NO FALLBACK LIST. An "if nobody opted in, send to these people" default would mail somebody who
 * had just turned it off, which is the one thing a preference must never do. Nobody opted in means
 * nobody gets it, and the send records that it sent to nobody. */
/* `user_id` is the MAILBOX NAME, not an address — createAccounts_ derives it as
   email.split('@')[0], so Sky's account is `sky`, not `sky@greencrosscanna.com`. The first cut of
   this filtered on user_id containing an '@', so it matched nobody and silently unsubscribed
   everyone: the write succeeded, the setting read back true, and the recipient list came out
   empty. GX Core holds the real address in its `users` tab, but the library exposes no reader for
   it, so the address is reassembled from the convention that produced the id. */
var ACCOUNT_DOMAIN = 'greencrosscanna.com';
function accountEmail_(r) {
  var uid = String((r && r.user_id) || '').trim().toLowerCase();
  if (!uid) return '';
  return uid.indexOf('@') > 0 ? uid : uid + '@' + ACCOUNT_DOMAIN;
}
function digestRecipients_(rows) {
  return (rows || []).filter(function (r) { return !r.retired && r.digest_opt_in && r.user_id; })
                     .map(accountEmail_)
                     .filter(function (e) { return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e); });
}
var LAST_DIGEST_PROP = 'CREW_LAST_DIGEST';
var CREW_URL  = 'https://greencrosscanna.github.io/greencross-crew/';

/* ─── Celebrations in the digest, and the opt-out that still applies ─────────────────────────────
 *
 * Birthdays and work anniversaries for the week ahead, computed off the join digestData_ already
 * did rather than by calling getCelebrations_ — that route re-reads GXCore.getEmployees() and
 * readAttrs_() to rebuild a roster this function is holding.
 *
 * `celebrations_opt_out` IS HONORED HERE. The flag's declaration scopes it to "the kiosk
 * celebrations feed", and one could argue a private managers' email is the opposite of the
 * all-staff screen it was written against — it is how Mike knows to buy a card. It is honored
 * anyway, for two reasons. The flag is named for celebrations and this is a celebrations
 * section; and the person who ticked it is Sky, who is also the person the digest is mailed to,
 * so ignoring it would show him his own anniversary in an email he asked for — exactly the
 * awkwardness the flag exists to prevent. If managers should see suppressed people, that is a
 * deliberate second decision and a second flag, not an inference from this one.
 *
 * Dates never leave: same derived shape the kiosk gets — name, store, type, days away, and years
 * of service for an anniversary. No DOB, no birth year, nothing to reconstruct one from. An
 * email forwards more easily than a kiosk does, so this matters more here, not less. */
var DOW_ = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* "Today" / "Tomorrow" / the weekday name. Resolved HERE rather than in the template because
   `today` is the only thing that can name the day an offset lands on, and the template has no
   business recomputing a date it was handed a count for. */
function celebrationWhen_(daysAway, today) {
  if (daysAway === 0) return 'Today';
  if (daysAway === 1) return 'Tomorrow';
  var on = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAway);
  return DOW_[on.getDay()];
}

function digestCelebrations_(rows, today, horizon) {
  var days = horizon == null ? DIGEST_CELEBRATION_DAYS : horizon;
  var out = [];
  (rows || []).forEach(function (r) {
    if (r.retired || r.merged) return;
    if (r.celebrations_opt_out) return;
    var who = displayNameOf_(r) || r.employee_id;

    var bday = normBirthday_(r.birthday);
    if (bday) {
      var bd = daysUntilMonthDay_(bday, today);
      if (bd >= 0 && bd < days) {
        out.push({ name: who, store: r.store || '', type: 'birthday',
                   days_away: bd, when: celebrationWhen_(bd, today) });
      }
    }

    /* rosterJoin_ already folded work_anniversary down to hire_date where no override is set, so
       this reads one field and not two. A year-zero anniversary is not one — somebody hired six
       days ago has an anniversary "in 359 days", not a first anniversary this week. */
    var anniv = normDate_(r.work_anniversary);
    if (anniv) {
      var parts = anniv.split('-');
      var ad = daysUntilMonthDay_(parts[1] + '-' + parts[2], today);
      if (ad >= 0 && ad < days) {
        var on = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ad);
        var years = on.getFullYear() - Number(parts[0]);
        if (years > 0) {
          out.push({ name: who, store: r.store || '', type: 'anniversary',
                     days_away: ad, years: years, when: celebrationWhen_(ad, today) });
        }
      }
    }
  });
  out.sort(function (x, y) {
    return x.days_away - y.days_away || x.name.localeCompare(y.name);
  });
  return out;
}

/* First Monday of the month — when the EoM reminder fires.
 *
 * Both halves are checked, and the day-of-month one is not redundant: the digest also runs from
 * `?action=digest` on any day somebody asks for it, and "the 3rd is a Monday" must not make a
 * Wednesday preview print a reminder that the real send would not have carried. A preview should
 * show what Monday's email says, and on a Wednesday the honest answer is "not this one". */
function isFirstMondayOfMonth_(today) {
  return today.getDay() === 1 && today.getDate() <= 7;
}

var MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

/* The EoM reminder: pick this month's, and who is still holding last month's.
 *
 * The holder is context, not the point — the ASK is the pick. cfg.eom holding nothing is a
 * perfectly good state to be reminded from, so an unset or deliberately-nobody value still
 * produces a reminder rather than suppressing it.
 *
 * A cfg.eom that cannot be read degrades to the bare reminder. The alternative — dropping the
 * block, or printing the error into an email — turns a GX Core hiccup into a missed month. */
function digestEom_(byId, today) {
  var cur = {};
  try { cur = eomCurrent_() || {}; } catch (e) { cur = { error: String((e && e.message) || e) }; }
  var holder = '';
  if (cur.state === 'held') {
    var row = byId[String(cur.employee_id)];
    holder = (row && displayNameOf_(row)) || String(cur.employee_id || '');
  }
  return { month: MONTH_NAMES_[today.getMonth()], holder: holder,
           state: cur.error ? 'unknown' : (cur.state || 'unset'), since: cur.since || '' };
}

function digestData_() {
  var joined = rosterJoin_();
  var live = joined.rows.filter(function (r) { return !r.retired; });
  var items = reviewItems_();
  var expiring = live.filter(function (r) { return r.permit_days_left != null && r.permit_days_left <= 90; })
                     .sort(function (a, b) { return a.permit_days_left - b.permit_days_left; });
  var byId = {};
  joined.rows.forEach(function (r) { byId[String(r.employee_id)] = r; });
  var stores = {};
  try {
    (GXCore.getStores() || []).forEach(function (x) { stores[x.store_id] = x.display_name || x.store_id; });
  } catch (e) { /* labels are a nicety; the slug still reads */ }
  stores.corporate = stores.corporate || 'Corporate';
  var today = todayInStoreTz_();
  return {
    active: live.length,
    questions: items,
    expiring: expiring,
    gaps: live.filter(function (r) { return (r.flags || []).length; }).length,
    fresh: live.filter(function (r) { return r.needs_setup; }),
    celebrations: digestCelebrations_(live, today),
    /* null on every other Monday of the month, so the template has one thing to test. */
    eom: isFirstMondayOfMonth_(today) ? digestEom_(byId, today) : null,
    byId: byId, stores: stores, all: joined.rows
  };
}

/* Hex literals, not --gx-* tokens, and this is the one place that is correct: an email client has
   no stylesheet to read them from. Tables and inline styles for the same reason — Outlook still
   does not do flexbox. The values are the theme's, copied deliberately. */
function digestHtml_(d) {
  var GOLD = '#d4a847', RED = '#ef4444', GREEN = '#4ade80';
  var TXT = '#e6ece9', DIM = '#8a958f', MUTE = '#5e6864';
  var BG = '#0a0e0d', CARD = '#121715', LINE = '#232a27';
  var esc = function (x) { return String(x == null ? '' : x).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };

  function tile(n, label, color) {
    /* min-height so a label that wraps ("permits inside 90 days") does not leave one tile taller
       than the other three. Outlook ignores it and falls back to ragged, which is survivable. */
    return '<td style="padding:0 6px 0 0;width:25%" valign="top">' +
      '<div style="background:' + CARD + ';border:1px solid ' + LINE + ';border-radius:10px;' +
      'padding:14px 16px;min-height:62px">' +
      '<div style="font:700 23px/1.1 Helvetica,Arial,sans-serif;color:' + color + '">' + n + '</div>' +
      '<div style="font:400 11px/1.4 Helvetica,Arial,sans-serif;color:' + MUTE + ';padding-top:4px">' +
      esc(label) + '</div></div></td>';
  }
  function section(title, note) {
    return '<div style="font:700 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:1.4px;' +
      'text-transform:uppercase;color:' + DIM + ';padding:26px 0 10px">' + esc(title) +
      (note ? '<span style="font-weight:400;letter-spacing:0;text-transform:none;color:' + MUTE +
              ';padding-left:10px">' + esc(note) + '</span>' : '') + '</div>';
  }
  function card(edge, kicker, kickerColor, name, detail) {
    return '<div style="background:' + CARD + ';border:1px solid ' + LINE + ';border-left:3px solid ' +
      edge + ';border-radius:9px;padding:12px 14px;margin:0 0 8px">' +
      '<div style="font:700 9.5px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.9px;' +
      'text-transform:uppercase;color:' + kickerColor + '">' + esc(kicker) + '</div>' +
      '<div style="font:600 14px/1.4 Helvetica,Arial,sans-serif;color:' + TXT + ';padding:2px 0 4px">' +
      esc(name) + '</div>' +
      '<div style="font:400 12.5px/1.5 Helvetica,Arial,sans-serif;color:' + DIM + '">' +
      esc(detail) + '</div></div>';
  }

  var open = d.questions.length;
  var h = '<div style="background:' + BG + ';padding:26px 30px;font-family:Helvetica,Arial,sans-serif">' +
    '<div style="max-width:640px">' +
    '<div style="font:700 23px/1.2 Helvetica,Arial,sans-serif;color:' + TXT + ';letter-spacing:-.3px">' +
    'Everything that needs a person</div>' +
    '<div style="font:400 13px/1.5 Helvetica,Arial,sans-serif;color:' + MUTE + ';padding:6px 0 22px">' +
    open + ' open question' + (open === 1 ? '' : 's') + ' &middot; ' +
    d.expiring.length + ' permit' + (d.expiring.length === 1 ? '' : 's') + ' inside 90 days &middot; ' +
    d.gaps + ' record' + (d.gaps === 1 ? '' : 's') + ' with a gap</div>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate"><tr>' +
    tile(d.active, 'active people', TXT) +
    tile(open, 'open questions', open ? GOLD : GREEN) +
    tile(d.expiring.length, 'permits inside 90 days', d.expiring.length ? RED : GREEN) +
    tile(d.gaps, 'records with a gap', d.gaps ? GOLD : GREEN) +
    '</tr></table>';

  /* EoM sits ABOVE the questions, not below, and only on the one Monday it fires. It is a
     once-a-month ask with a deadline attached; under a long questions list it is the line
     somebody scrolls past, and then the month has no Employee of the Month. */
  if (d.eom) {
    var eomLine = d.eom.state === 'held'
      ? esc(d.eom.holder) + ' has held it since last month.'
      : d.eom.state === 'unknown'
        ? 'Could not read the current holder just now.'
        : 'Nobody holds it at the moment.';
    h += '<div style="background:' + CARD + ';border:1px solid ' + LINE + ';border-left:3px solid ' +
      GOLD + ';border-radius:9px;padding:14px 16px;margin:18px 0 0">' +
      '<div style="font:700 9.5px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.9px;' +
      'text-transform:uppercase;color:' + GOLD + '">First Monday</div>' +
      '<div style="font:600 14px/1.4 Helvetica,Arial,sans-serif;color:' + TXT + ';padding:2px 0 4px">' +
      'Pick ' + esc(d.eom.month) + '&rsquo;s Employee of the Month</div>' +
      '<div style="font:400 12.5px/1.5 Helvetica,Arial,sans-serif;color:' + DIM + '">' +
      eomLine + '</div></div>';
  }

  if (d.fresh.length) {
    h += section('New here', 'arrived, profile not finished');
    d.fresh.forEach(function (r) {
      var missing = SETUP_FLAGS.filter(function (f) { return (r.flags || []).indexOf(f) >= 0; })
                               .map(function (f) { return FLAG_LABEL_[f] || f; });
      /* FIVE arguments. The first cut passed four, so the person's NAME slid into the
         kickerColor slot — every card rendered its kicker in an invalid color (black on black)
         and printed "Still needs wage." where the name belonged. Six cards, not one of them
         naming the person they were about. */
      h += card(GREEN,
                (r.store ? (d.stores[r.store] || r.store) : 'no store') + ' \u00b7 ' +
                  (r.role_is_default ? 'no role' : r.role),
                MUTE,
                displayNameOf_(r) || r.employee_id,
                'Still needs ' + missing.join(', ') + '.');
    });
  }

  h += section('Open questions', 'nothing here has been applied');
  if (!open) {
    h += '<div style="background:' + CARD + ';border:1px solid ' + LINE + ';border-radius:10px;' +
         'padding:22px;text-align:center;font:400 13.5px Helvetica,Arial,sans-serif;color:' + GREEN + '">' +
         '&#10003; Every source agrees. Nothing to review.</div>';
  } else {
    d.questions.forEach(function (it) {
      var edge = it.severity === 'high' ? RED : it.severity === 'warn' ? GOLD : LINE;
      var row = d.byId[String(it.employee_id)];
      h += card(edge, KIND_LABEL_[it.kind] || it.kind, edge,
                (row && displayNameOf_(row)) || it.name, it.detail);
    });
  }

  /* Celebrations LAST, below the questions, and that ordering is the compromise this section had
     to make. The digest's title is "Everything that needs a person" and its first note says EoM
     was left out because mixing a nice-to-look-at with a to-do teaches people to skim. A birthday
     on Thursday genuinely is a thing that needs a person — somebody has to say it — but it is not
     a record that needs fixing, so it goes after the queue rather than into it. */
  if (d.celebrations.length) {
    h += section('This week', 'birthdays and work anniversaries');
    d.celebrations.forEach(function (c) {
      var what = c.type === 'birthday'
        ? 'Birthday'
        : c.years + ' year' + (c.years === 1 ? '' : 's') + ' with the company';
      h += card(GREEN, c.when + ' · ' + (c.store ? (d.stores[c.store] || c.store) : 'no store'),
                MUTE, c.name, what);
    });
  }

  h += '<div style="padding:28px 0 0">' +
    '<a href="' + CREW_URL + '" style="display:inline-block;background:' + GREEN + ';color:#06210f;' +
    'font:700 13px Helvetica,Arial,sans-serif;text-decoration:none;padding:10px 18px;border-radius:6px">' +
    'Open GX Crew</a></div>' +
    '<div style="font:400 11px/1.6 Helvetica,Arial,sans-serif;color:' + MUTE + ';padding:20px 0 0">' +
    'Sent Monday mornings from GX Crew. Nothing in this email has been applied &mdash; every ' +
    'decision is recorded in the app.</div>' +
    '</div></div>';
  return h;
}

/* Labels shared with the frontend's copies. Duplicated deliberately rather than imported: the
   email is rendered server-side and has no access to crew.js, and a kind with no label here shows
   its raw key rather than nothing. */
var KIND_LABEL_ = { duplicate: 'Possible duplicate', retired_with_access: 'Retired, still has access',
  missing_permit: 'No OLCC permit on file', permit_expired: 'Permit expired',
  permit_expiring: 'Permit expiring', missing_field: 'Missing data',
  name_spelling: 'Name spelling differs', role: 'Role differs',
  new_hire: 'In Dutchie, not on the roster' };
var FLAG_LABEL_ = { name: 'name', employee_number: 'employee number', hire_date: 'hire date',
  store: 'store', role: 'role', no_account: 'GX account', wage: 'wage', birthday: 'birthday',
  permit: 'OLCC permit', permit_expired: 'expired permit', permit_status: 'permit status' };

/** Nickname + surname, the way every surface writes a person. Mirrors displayName() in crew.js. */
function displayNameOf_(r) {
  var full = String(r.name || r.full_name || '').trim();
  if (!full) return '';
  var nick = String(r.preferred_name || '').trim();
  if (!nick) return full;
  var sp = full.indexOf(' ');
  return sp < 0 ? nick : nick + full.slice(sp);
}

/* WHICH ACCOUNT is the web app actually running as, and can it send mail?
 *
 * The deployment runs executeAs USER_DEPLOYING, so the mail scope has to be granted by the user
 * the DEPLOYMENT belongs to — which is not necessarily the account sitting in the editor. Running
 * a function in the IDE authorizes the editor session; it does not re-authorize a deployment that
 * a different account created. Guessing between those two costs a round trip each time, so ask. */
function mailCheck_() {
  var who = '(unknown — userinfo.email not granted)';
  try { who = Session.getEffectiveUser().getEmail() || who; } catch (e) {}
  var quota = null, mailErr = '';
  try { quota = MailApp.getRemainingDailyQuota(); }
  catch (e) { mailErr = String((e && e.message) || e); }
  var subscribers = [];
  try { subscribers = digestRecipients_(rosterJoin_().rows); }
  catch (e) { subscribers = ['(could not read the roster: ' + String((e && e.message) || e) + ')']; }
  var last = null;
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(LAST_DIGEST_PROP);
    if (raw) last = JSON.parse(raw);
  } catch (e) {}
  /* What is actually SCHEDULED. Every previous answer to "is the digest set up?" was inferred
     from the return value of the call that set it up, which says what was attempted rather than
     what survives — and the two came apart once, when the mail guard skipped creating the digest
     trigger and nothing said so afterwards. */
  var triggers = [];
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      triggers.push(t.getHandlerFunction() + ' (' + String(t.getEventType()) + ')');
    });
  } catch (e) { triggers = ['(unreadable: ' + String((e && e.message) || e) + ')']; }
  return { ok: true, effective_user: who, can_send_mail: quota !== null,
           remaining_daily_quota: quota, mail_error: mailErr, triggers: triggers,
           /* What the LAST attempt did, from wherever it was run. This is the only window into an
              editor execution from out here. */
           last_attempt: last, configured_recipients: subscribers,
           note: quota === null
             ? 'The account above is the one that must grant the mail scope — open the script ' +
               'signed in AS THAT ACCOUNT, run sendDigestNow(), accept the prompt.'
             : 'Mail is authorized for this deployment.' };
}

function sendDigest_(p) {
  var to = String(p.to || '').trim();
  /* WHERE it ran, recorded because the two contexts fail identically and are fixed differently:
     an editor run is authorized by the signed-in owner, a web-app run by the deployment. Passed
     in rather than sniffed — there is no scope-free way to ask, and the caller always knows.
     Declared HERE, above the preview return that reads it: `var` hoists but the assignment did
     not, so every preview reported `source: undefined`. */
  var source = String(p.source || 'webapp');
  var d = digestData_();
  var recipients = to ? to.split(/[,;\s]+/).filter(function (x) { return x; })
                      : digestRecipients_(d.all);
  var html = digestHtml_(d);
  var open = d.questions.length;
  /* The EoM ask leads the subject on the one Monday it fires. Everything else in this email is a
     standing queue that keeps until next week; picking the month's Employee is the only line with
     a deadline, and a subject that buries it behind "3 open questions" is how a month goes by
     without one. Celebrations deliberately stay OUT of the subject — a birthday is not why
     somebody should open their email, and it would push the queue count out on most weeks. */
  var subject = 'GX Crew — ' +
                (d.eom ? 'pick ' + d.eom.month + '\u2019s Employee of the Month \u00b7 ' : '') +
                (open ? open + ' open question' + (open === 1 ? '' : 's') : 'all clear') +
                (d.expiring.length ? ', ' + d.expiring.length + ' permit' +
                 (d.expiring.length === 1 ? '' : 's') + ' inside 90 days' : '');
  if (!recipients.length) {
    return { ok: false, error: 'nobody has the Monday recap switched on', mode: 'no recipients',
             fix: 'Tick "Email me the Monday recap" on a person who has a GX account.' };
  }
  if (String(p.send || '') !== 'yes') {
    return { ok: true, mode: 'preview', source: source, would_send_to: recipients, subject: subject,
             active: d.active, open_questions: open, expiring: d.expiring.length,
             gaps: d.gaps, new_here: d.fresh.length,
             celebrations: d.celebrations.length, eom_reminder: !!d.eom,
             /* WHO, not just how many. A preview that says "celebrations: 1" cannot be checked
                against anything — the first cross-check against ?action=celebrations found a
                count that disagreed, and the payload gave nothing to find the missing person
                with. Names and offsets only, the same shape that route already returns to this
                same secret-gated caller; still no dates. Preview only. */
             celebration_list: d.celebrations.map(function (c) {
               return c.when + ' · ' + c.name + ' · ' + c.type + (c.years ? ' ' + c.years + 'y' : '');
             }),
             note: 'Nothing sent. Repeat with send=yes.' };
  }
  /* EVERY attempt is recorded, successful or not. An editor run returns its result to a window
     nobody is looking at and leaves no trace anywhere reachable, which is exactly why "I ran it
     and never got the email" was undiagnosable: no way to tell a refused scope from a delivered
     message that landed in spam, or from a wrong address. Now there is. */
  function note(res) {
    try {
      PropertiesService.getScriptProperties().setProperty(LAST_DIGEST_PROP, JSON.stringify(res));
    } catch (e) { /* the record is a nicety; never fail the send over it */ }
    return res;
  }
  var at = new Date().toISOString();
  try {
    MailApp.sendEmail({ to: recipients.join(','), subject: subject, htmlBody: html,
                        name: 'GX Crew' });
  } catch (e) {
    return note({ ok: false, at: at, source: source, to: recipients, needs_authorization: true,
                  error: String((e && e.message) || e),
                  fix: 'MailApp needs the script.send_mail scope, granted by whoever this context ' +
                       'runs as. From the editor that is you; from the web app it is the deployment.' });
  }
  var quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) {}
  return note({ ok: true, at: at, source: source, mode: 'sent', to: recipients, subject: subject,
                remaining_daily_quota: quota,
                open_questions: open, expiring: d.expiring.length, new_here: d.fresh.length,
                celebrations: d.celebrations.length, eom_reminder: !!d.eom });
}

/* Trigger entry point, and the editor-runnable twin for the one-time mail authorization. */
function weeklyDigest() { return sendDigest_({ send: 'yes', source: 'trigger' }); }

/* RUN THIS ONE FROM THE EDITOR to send a digest by hand.
 *
 * It THROWS on a failed send, and that is deliberate. sendDigest_ catches the authorization error
 * so the web app can answer with a useful object rather than a 500 — but from the editor that
 * turned a refused send into an execution logged as **Completed**, which is a lie told in the one
 * place somebody goes to check. A run that did not send should read Failed. */
function sendDigestNow() {
  var r = sendDigest_({ send: 'yes', source: 'editor' });
  if (!r.ok) throw new Error((r.error || 'digest failed') + (r.fix ? ' — ' + r.fix : ''));
  return r;
}

// ─── Nightly: who does Dutchie say works here that Crew has never heard of? ─────
/*
 * THE GAP THIS CLOSES. Nothing polled anything. A new hire appeared in Crew only when a human
 * remembered to run a seed or an import — Andrew Roberts sat in METRC for three days and surfaced
 * only because somebody exported a spreadsheet by hand (2026-08-25).
 *
 * IT REPORTS, IT DOES NOT WRITE. seed_commit already says this in its own comment: writing the
 * canonical registry every other app reads "is not something that should ever fire as a side
 * effect". A cron that created people would be exactly that side effect, and it would do it at
 * 5am with nobody watching. So the scan finds candidates, parks them, and a human accepts each
 * one from the review queue — which is the same shape every other cross-source disagreement in
 * this app already has.
 *
 * MATCHING IS hrImport_'S LADDER, not a second opinion: exact employee_id, then a merge alias,
 * then samePerson_ fuzzy. Two detectors that disagree about whether somebody is already on the
 * roster would either hide a real hire or propose a duplicate of an existing one.
 */
function dutchieNewHireScan_(secret) {
  var b = buildIdentityRows_(secret);
  /* A failed Dutchie read must not empty the tab. Same rule as the roster cache: writing "no new
     hires" because the source was unreachable is a worse answer than saying nothing, because it
     looks exactly like good news. */
  if (!b.rows.length) {
    return { ok: false, error: 'Dutchie returned no usable rows — nothing scanned, nothing changed',
             store_errors: b.errors, dutchie_rows_seen: b.seen };
  }

  var existing = [];
  try { existing = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: 'could not read GX Core identity: ' + String((e && e.message) || e) }; }

  var byId = Object.create(null);
  existing.forEach(function (r) { byId[String(r.employee_id || '').trim()] = r; });
  var aliases = readAliases_();

  var unknown = [];
  b.rows.forEach(function (r) {
    var key = String(r.employee_id || '').trim();
    if (!key) return;
    if (aliases[key] && byId[aliases[key]]) return;      // merged away — resolves to a real person
    if (byId[key]) return;                               // already on the roster
    for (var i = 0; i < existing.length; i++) {
      if (samePerson_(r.full_name, existing[i].full_name)) return;   // spelled differently, same human
    }
    unknown.push(r);
  });

  /* first_seen survives a re-scan so "in Dutchie since the 4th, still not on the roster" is
     answerable; last_seen is what proves the finding is still true rather than stale. */
  var now = new Date().toISOString();
  var was = {};
  readTab_(PENDING_TAB, PENDING_HEADERS).forEach(function (x) { was[x.name_key] = x; });

  var rows = unknown.map(function (r) {
    var prior = was[r.employee_id];
    return PENDING_HEADERS.map(function (h) {
      if (h === 'name_key')   return r.employee_id;
      if (h === 'first_seen') return (prior && prior.first_seen) || now;
      if (h === 'last_seen')  return now;
      return String(r[h] == null ? '' : r[h]);
    });
  });

  /* Replace only THIS tab's rows. Anyone who has since been added to the roster simply is not in
     `unknown` any more, so they drop out without needing a delete path of their own. */
  var sh = sheetOf_(PENDING_TAB, PENDING_HEADERS);
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  if (rows.length) sh.getRange(2, 1, rows.length, PENDING_HEADERS.length).setValues(rows);

  var fresh = unknown.filter(function (r) { return !was[r.employee_id]; })
                     .map(function (r) { return r.full_name; });
  return { ok: true, scanned_at: now, dutchie_active_people: b.rows.length,
           on_the_roster: b.rows.length - unknown.length,
           pending: unknown.length, new_since_last_scan: fresh,
           names: unknown.map(function (r) {
             return r.full_name + (r.home_store ? ' (' + r.home_store + ')' : ' (no store)');
           }),
           store_errors: b.errors };
}

/* The trigger's entry point. A plain global name because that is what ScriptApp binds to, and it
   does nothing but call the scan so the schedule and the work stay separable. */
function nightlyDutchieScan() {
  var out = dutchieNewHireScan_();
  Logger.log(JSON.stringify(out));
  return out;
}

/* Installs (or removes) the nightly schedule. Idempotent by construction — it clears its own
   handler first, so running it twice leaves ONE trigger rather than two firing an hour apart. */
function installNightlyScan_(p) {
  /* ScriptApp.newTrigger needs the script.scriptapp OAuth scope, which this project did not
     previously use. Apps Script detects scopes from the code, so the requirement appears the
     moment this ships — and a web app deployed as USER_DEPLOYING cannot grant itself a scope the
     owner has not consented to. Caught and NAMED rather than thrown, so the answer is "the owner
     has to authorize this once" instead of a stack trace from a 5am cron nobody is watching. */
  try {
    return installNightlyScanUnsafe_(p);
  } catch (e) {
    return { ok: false, needs_authorization: true,
             error: String((e && e.message) || e),
             fix: 'Open the Apps Script project and run installNightlyScan() once from the editor, ' +
                  'granting the trigger permission when prompted. Everything else keeps working.' };
  }
}

/** Editor-runnable wrapper, for the one-time authorization described above. */
function installNightlyScan() { return installNightlyScanUnsafe_({ enabled: 'yes' }); }

function installNightlyScanUnsafe_(p) {
  var on = String(p.enabled || 'yes') !== 'no';

  /* CAN THIS CONTEXT SEND MAIL? A trigger runs under the authority of whoever created it, so one
     created from the web app inherits the deployment's authorization and one created from the
     editor inherits the signed-in user's. Those differ here: the deployment has never been
     granted script.send_mail, the owner's account has.
     
     Which makes this route a footgun without the check below. Re-running it from the web app
     would delete a working, editor-created digest trigger and replace it with one that cannot
     send — silently, and not discovered until the following Monday. So when mail is unavailable
     the digest trigger is LEFT ALONE rather than reinstalled badly. */
  var canMail = true;
  try { MailApp.getRemainingDailyQuota(); } catch (e) { canMail = false; }

  var handlers = canMail ? ['nightlyDutchieScan', 'weeklyDigest'] : ['nightlyDutchieScan'];
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); removed++; }
  });
  if (!on) return { ok: true, enabled: false, removed: removed, touched: handlers };
  /* 5am store time: after the last shift's Dutchie writes have settled and before anyone opens
     Crew, so the queue is already right the first time somebody looks at it. */
  ScriptApp.newTrigger('nightlyDutchieScan').timeBased().atHour(5).everyDays(1)
    .inTimezone(STORE_TZ).create();
  /* Monday 07:00, an hour after the nightly scan has already filed anything new — so the digest
     reports the week including whoever turned up over the weekend, rather than racing it. */
  if (canMail) {
    ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(7).inTimezone(STORE_TZ).create();
  }
  /* PROVE THE CRON PATH, NOW, WHILE SOMEBODY IS WATCHING.
   *
   * Installing a trigger and verifying the scan are two different claims, and the request that
   * installs proves only the second. A REQUEST carries its own secret; the 5am trigger carries
   * none and falls back to the GX_DEPLOY_SECRET script property. So "?action=new_hires works"
   * and "the nightly run works" are not the same sentence, and the difference surfaces at 5am
   * in front of nobody.
   *
   * This calls the trigger's exact entry point with no argument -- the same call the scheduler
   * will make -- so the answer arrives at install time instead of a week later. The scan writes
   * only its own pending tab and is safe to run on demand. A failure here does NOT unwind the
   * install: the trigger is correctly scheduled either way, and the fix is a property, not a
   * schedule. It is reported instead, named. */
  var dry = null;
  try {
    var r = nightlyDutchieScan();
    dry = (r && r.ok)
      ? 'OK — ran the real 5am call just now: ' + (r.dutchie_active_people || 0) + ' active in '
        + 'Dutchie, ' + (r.on_the_roster || 0) + ' already on the roster, '
        + ((r.new_since_last_scan || []).length) + ' new'
      : 'FAILING — the schedule is set, but the 5am call itself returns: '
        + ((r && r.error) || 'unknown') + '. Most likely GX_DEPLOY_SECRET is missing on this '
        + 'project; a request-driven scan can still pass its own secret and will look fine.';
  } catch (e) {
    dry = 'FAILING — the 5am call threw: ' + String((e && e.message) || e);
  }

  return { ok: true, enabled: true, replaced: removed,
           nightly_scan_hour: 5, timezone: STORE_TZ, cron_path_check: dry,
           digest_trigger: canMail ? 'installed, MONDAY 07:00' :
             'LEFT UNTOUCHED — this context cannot send mail, so reinstalling it here would ' +
             'replace a working trigger with one that fails silently. Run installNightlyScan() ' +
             'from the Apps Script editor instead.' };
}

// ─── HR import (staff sheet + METRC permits → Core identity + Crew attributes) ───
/*
 * One reconciled payload in, two destinations out:
 *   • GX Core identity — full_name, home_store, role_title, status, hire_date
 *   • Crew attributes  — employee_number, wage, shirt_size, birthday, permit_*
 *
 * Two things this must get right, both learned the hard way:
 *
 * 1. gxWrite_ REPLACES the whole row. It rebuilds every column from the record, so any field
 *    absent from the payload is written as ''. A naive partial upsert silently wipes
 *    dutchie_employee_id and user_id — the very columns that let SPIFF and Leaderboard join.
 *    So we read the existing row and merge onto it, and never overwrite a populated value
 *    with an empty one.
 *
 * 2. Names drift between sources. The registry was seeded from Dutchie ("Skyler Poteet"); the
 *    HR sheet says "Poteet, Skylar". Keying purely on nameKey would append a SECOND row for the
 *    same person. So we match against the existing registry first — exact key, then fuzzy — and
 *    reuse whatever employee_id is already there.
 */

/** Nicknames seen across Dutchie / METRC / the HR sheet. Explicit and reviewable, not guessed. */
var NICKNAMES = Object.assign(Object.create(null), { mike: 'michael', zach: 'zachary', chris: 'christopher', sam: 'samuel',
                  jon: 'jonathan', nick: 'nicholas', dan: 'daniel', matt: 'matthew',
                  jen: 'jennifer', tanner: 'taner', sky: 'skyler', skylar: 'skyler',
                  bob: 'robert', rob: 'robert', tom: 'thomas', tj: 'thomas' });
/* `tj` added 2026-08-27. ratio_('tj','thomas') is 0.25, far under the 0.8 first-name bar, so
   samePerson_('TJ Peterson', 'Thomas Peterson') was false and any source that prints the nickname
   -- which the incentive payout reports do, for all 27 of them -- could not reach the registry
   record by legal name alone.

   CORRECTION, same day: this comment first claimed the gap had CREATED a duplicate record for him.
   It had not. `thomas_peterson` and `tj_peterson` are a completed roster_merge -- a tombstone plus
   its survivor -- which is the arrangement that keeps an old employee_id resolving for Leaderboard
   and SPIFF joins. The reviewer who spotted it had merged them himself. An invented cause is worse
   than none: it is the spiff_payouts mistake in miniature, and someone would eventually have
   "fixed" a merge that was working correctly. The real fix for name-vs-nickname is matching
   display_name, which stampEmployeeIds_ and the importer now both do; this entry is still correct
   on its own terms and stays. */

function canonFirst_(f) {
  var x = String(f || '').toLowerCase().replace(/[^a-z]/g, '');
  return NICKNAMES[x] || x;
}
function ratio_(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  var m = 0, used = {};
  for (var i = 0; i < a.length; i++) {
    for (var j = 0; j < b.length; j++) {
      if (!used[j] && a[i] === b[j]) { used[j] = 1; m++; break; }
    }
  }
  return (2 * m) / (a.length + b.length);
}
function nameParts_(full) {
  var t = String(full || '').trim().split(/\s+/);
  return { first: t[0] || '', last: t.length > 1 ? t[t.length - 1] : '' };
}

/** Same human seen from two systems that disagree on spelling or nickname? */
function samePerson_(fullA, fullB) {
  var a = nameParts_(fullA), b = nameParts_(fullB);
  var af = canonFirst_(a.first), bf = canonFirst_(b.first);
  var al = String(a.last).toLowerCase().replace(/[^a-z]/g, '');
  var bl = String(b.last).toLowerCase().replace(/[^a-z]/g, '');
  if (!al || !bl) return false;
  var firstOk = af === bf || af.indexOf(bf.slice(0, 3)) === 0 || bf.indexOf(af.slice(0, 3)) === 0
                || ratio_(af, bf) >= 0.8;
  if (!firstOk) return false;
  return al === bl || al.indexOf(bl) >= 0 || bl.indexOf(al) >= 0 || ratio_(al, bl) >= 0.85;
}

/* ══ Incentive history — imported once, then never changed ═══════════════════════════════════════
 *
 * 27 pay periods of payout reports (2025-08-04 .. 2026-08-16) exported from the "Green Cross
 * Incentive Program" spreadsheet, which is what Leaderboard's dashboard was ported from. Sky,
 * 2026-08-26: "the SPIFFs change, and in the future the other benchmarks can change. historical
 * needs to be imported but not changed."
 *
 * That sentence is the whole design. A closed period is a RECORD OF WHAT WAS PAID, not an input to
 * a formula, so nothing here recomputes anything. It matters because the benchmarks have already
 * moved once and will again: the spreadsheet measured GROSS discount against a ~2.75% bar, the app
 * measures budtender-controlled DISCRETIONARY discount against 1.5%, and re-scoring a 2025 period
 * with 2026 thresholds would quietly restate what people took home. Leaderboard has this bug today
 * in miniature — its performance figures freeze but its thresholds do not, so editing the discount
 * goal re-scores every period already paid.
 *
 * WHAT AN IMPORTED ROW IS ALLOWED TO CARRY. Only what the document actually said. The oldest report
 * has no PAYROLL column, so payroll is EMPTY for that period rather than derived — the company /
 * vendor-funded split simply was not recorded, and a plausible guess is indistinguishable from a
 * fact once it is in a sheet.
 *
 * A PERSON WHO HAS LEFT STILL HAS HISTORY. employee_id is blank for the three people in these
 * reports who predate the roster, and pdf_name then carries the only record of who was paid. Same
 * arrangement as the EoM reign log, and for the same reason: a name that can no longer be looked
 * up is not a reason to drop the row. */
var HISTORY_TAB = 'crew_incentive_history';
var HISTORY_HEADERS = ['pp_start', 'pp_end', 'section', 'employee_id', 'pdf_name', 'store_label',
                       'store_id', 'txn', 'sales', 'discount_pct', 'aov', 'spiff', 'bonus',
                       'per_hour', 'payroll', 'source_file', 'format', 'imported_at'];

/* Store labels in the reports are a year old and several no longer exist under those names —
 * "Hillsboro" is Baseline now, "Portland Road" is portland-rd. GXCore.resolveStore() already knows
 * the aliases and the Rd/Road fold (v201+), so this asks it rather than carrying a local table that
 * would diverge the first time a store is renamed. CLAUDE.md: never hardcode stores.
 * An unresolvable label is left blank and REPORTED, never guessed. */
function historyStoreId_(label) {
  if (!label) return '';
  try {
    var row = GXCore.resolveStore(String(label));
    return (row && (row.store_id || row.id)) || '';
  } catch (e) { return ''; }
}

/* sheetOf_ writes headers only when it CREATES the tab, so a column added to HISTORY_HEADERS later
   would never reach a sheet that already exists — reads would then map by index onto a short row.
   This appends what is missing, and only ever appends: readTab_ pairs headers to columns by
   POSITION, so reordering HISTORY_HEADERS would silently re-attribute every figure in the tab. */
function historySheet_() {
  var sh = sheetOf_(HISTORY_TAB, HISTORY_HEADERS);
  var width = Math.max(1, sh.getLastColumn());
  var have = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  var missing = HISTORY_HEADERS.filter(function (h) { return have.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sh;
}

/** Which pay periods are already imported. Read once; the import checks against it. */
function historyPeriods_() {
  var seen = Object.create(null);
  readTab_(HISTORY_TAB, HISTORY_HEADERS).forEach(function (r) {
    if (!r.pp_start) return;
    var e = seen[r.pp_start] || (seen[r.pp_start] = { pp_start: r.pp_start, pp_end: r.pp_end,
                                                      rows: 0, bonus: 0, imported_at: r.imported_at,
                                                      format: r.format });
    e.rows++;
    e.bonus += Number(r.bonus || 0) || 0;
  });
  return Object.keys(seen).sort().map(function (k) {
    seen[k].bonus = Math.round(seen[k].bonus * 100) / 100;
    return seen[k];
  });
}

/**
 * Import parsed payout periods. Deploy-secret only, POST — the payload is a year of rows and does
 * not fit in a query string.
 *
 * body: { periods: [ { pp_start, pp_end, format, admin, managers[], budtenders[] } ],
 *         names:   { "<pdf name>": "<employee_id>" } }   // from tools/match_incentive_names.py
 *
 * REFUSES TO TOUCH A PERIOD IT HAS ALREADY IMPORTED. Not a convenience — it is the guarantee. A
 * re-run with a re-parsed file, or a second operator running the same command, must not be able to
 * restate a paid figure. The only way past it is mode=replace WITH confirm=yes, which exists for
 * one case: a parse was wrong and the row is worse than nothing. That combination is deliberately
 * awkward to type by accident and says what it deleted.
 *
 * Dry by default, like hr_import — confirm=yes writes.
 */
function incentiveImport_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var periods = (body && body.periods) || [];
  if (!periods.length) return { ok: false, error: 'no periods in payload' };
  var names = (body && body.names) || {};
  var dry = String(p.confirm || '') !== 'yes';
  var replace = String(p.mode || '') === 'replace';

  var already = Object.create(null);
  historyPeriods_().forEach(function (h) { already[h.pp_start] = h; });

  var rows = [], skipped = [], replaced = [], unresolvedNames = {}, unresolvedStores = {};
  var now = new Date().toISOString();

  periods.forEach(function (per) {
    var start = String(per.pp_start || '');
    if (!start) return;
    if (already[start]) {
      if (!replace) { skipped.push(start); return; }        // the default, and the point
      replaced.push(start);
    }
    var fmt = String(per.format || '');
    function add(section, r) {
      if (!r || !r.name) return;
      var pdfName = String(r.name).trim();
      var empId = names[pdfName] || '';
      if (!empId) unresolvedNames[pdfName] = (unresolvedNames[pdfName] || 0) + 1;
      var label = String(r.store_label || '');
      var storeId = historyStoreId_(label);
      if (label && !storeId) unresolvedStores[label] = (unresolvedStores[label] || 0) + 1;
      /* Dates are TEXT and every figure is written as a NUMBER except the ones the document did
         not state, which stay EMPTY — '' and 0 are different claims about a pay period, and only
         one of them is true for the report with no payroll column. */
      rows.push([start, String(per.pp_end || ''), section, empId, pdfName, label, storeId,
                 r.txn == null ? '' : r.txn, r.sales == null ? '' : r.sales,
                 r.discount_pct == null ? '' : r.discount_pct, r.aov == null ? '' : r.aov,
                 r.spiff == null ? '' : r.spiff, r.bonus == null ? '' : r.bonus,
                 r.per_hour == null ? '' : r.per_hour, r.payroll == null ? '' : r.payroll,
                 String(per.file || ''), fmt, now]);
    }
    (per.budtenders || []).forEach(function (r) { add('budtender', r); });
    (per.managers || []).forEach(function (r) { add('manager', r); });
    if (per.admin) add('admin', per.admin);
  });

  var summary = {
    ok: true, dry_run: dry, periods_in_payload: periods.length,
    periods_to_write: periods.length - skipped.length,
    rows: rows.length, skipped_already_imported: skipped, replaced: replaced,
    unresolved_names: unresolvedNames, unresolved_stores: unresolvedStores,
    bonus_total: Math.round(rows.reduce(function (a, r) { return a + (Number(r[12]) || 0); }, 0) * 100) / 100
  };
  if (dry) { summary.note = 'dry run — nothing written. Re-send with confirm=yes.'; return summary; }
  if (!rows.length) { summary.note = 'nothing new to import'; return summary; }

  var sh = historySheet_();
  if (replaced.length) {
    /* Delete bottom-up: deleting a row shifts every row beneath it, so top-down deletion walks off
       its own indices and removes the wrong rows — on payout history. */
    var all = sh.getDataRange().getValues();
    for (var i = all.length - 1; i >= 1; i--) {
      if (replaced.indexOf(String(all[i][0])) >= 0) sh.deleteRow(i + 1);
    }
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HISTORY_HEADERS.length).setValues(rows);
  /* employee_number-style leading zeros are not in play here, but pp_start/pp_end are DATES AS TEXT
     and Sheets will happily coerce them into Date objects on the next edit, shifting them a day on
     a timezone mismatch. Pin the two date columns to plain text. */
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 2).setNumberFormat('@');
  summary.written = rows.length;
  return summary;
}

/**
 * Attach imported history to a person, WITHOUT touching a single figure.
 *   ?action=incentive_relink&pdf_name=TJ%20Peterson&employee_id=thomas_peterson&confirm=yes
 *
 * WHY THIS EXISTS SEPARATELY FROM mode=replace
 * Immutability here is about the MONEY, not about who the money is attached to. Those come apart
 * constantly: Thomas Peterson currently holds two GX Core records (tj_peterson and
 * thomas_peterson) and once they are merged his 27 periods need to point at the survivor. People
 * also get renamed, and three people in these reports predate the roster entirely — if any of them
 * is ever added back, their history should find them.
 *
 * Doing that through mode=replace would mean deleting a year of paid figures and rewriting them
 * from a re-parse, which is exactly the operation this whole design exists to prevent, for a change
 * that is not about the figures at all. So this writes ONE column and cannot write any other: it
 * reads each matching row, sets employee_id, and puts the row back with every money cell byte-for-
 * byte as it found it. A relink that silently altered a payout would be worse than the duplicate
 * it was fixing.
 *
 * Matches on pdf_name — the name as the report printed it — because that is the only handle these
 * rows have when employee_id is blank, which is the case this is for.
 */
function incentiveRelink_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var pdfName = String(p.pdf_name || '').trim();
  var empId   = String(p.employee_id || '').trim();
  if (!pdfName) return { ok: false, error: 'pdf_name required' };
  var dry = String(p.confirm || '') !== 'yes';

  var sh = historySheet_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'no imported history' };
  var NAME_COL = HISTORY_HEADERS.indexOf('pdf_name') + 1;
  var ID_COL   = HISTORY_HEADERS.indexOf('employee_id') + 1;

  var names = sh.getRange(2, NAME_COL, last - 1, 1).getValues();
  var ids   = sh.getRange(2, ID_COL,   last - 1, 1).getValues();
  var hits = [], was = Object.create(null);
  for (var i = 0; i < names.length; i++) {
    if (String(names[i][0]).trim() !== pdfName) continue;
    hits.push(i + 2);
    var cur = String(ids[i][0] || '(blank)');
    was[cur] = (was[cur] || 0) + 1;
  }
  if (!hits.length) return { ok: false, error: 'no history rows for pdf_name ' + pdfName };

  var out = { ok: true, dry_run: dry, pdf_name: pdfName, employee_id: empId,
              rows: hits.length, currently: was };
  if (dry) { out.note = 'dry run — nothing written. Re-send with confirm=yes.'; return out; }

  /* One column, one cell at a time. Writing the whole row back — even "unchanged" — is how a
     rounded or re-serialized figure gets in, and these are numbers that paid people. */
  hits.forEach(function (rowNum) { sh.getRange(rowNum, ID_COL).setValue(empId); });
  out.written = hits.length;
  return out;
}

/** Read imported history back: ?action=incentive_history[&pp_start=YYYY-MM-DD]. */
function incentiveHistory_(p) {
  /* getIncentive_ calls this after its own requireCrew_ gate, so an internal call skips the
     secret check rather than the engine having to hold its own secret to talk to itself.

     STRICTLY `=== true`, AND THAT IS THE WHOLE GUARD. `p` is `e.parameter`, so every key here can
     be set by whoever builds the URL — `?action=incentive_history&__internal=1` reached this as a
     truthy STRING and walked straight past the secret, returning every name, sales figure and
     payout amount in a closed period to anyone holding the /exec link. Verified live and fixed
     2026-08-31. A query parameter is always a string, so comparing against the boolean the one
     real caller passes closes it exactly; `!p.__internal` did not. Any future internal-call flag
     needs the same treatment — truthiness is not an authentication check. */
  if (p.__internal !== true && !deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var want = String(p.pp_start || '');
  if (!want) return { ok: true, periods: historyPeriods_() };
  var rows = readTab_(HISTORY_TAB, HISTORY_HEADERS).filter(function (r) { return r.pp_start === want; });
  if (!rows.length) return { ok: false, error: 'no imported history for ' + want };
  /* Imported rows store the name the REPORT printed, which is what the document said and what the
     screen shows. The export needs the legal name, so the registry is joined in here rather than
     the history tab carrying a copy that would go stale the next time somebody is renamed. */
  var legalById = Object.create(null), midById = Object.create(null);
  try {
    (GXCore.getEmployees() || []).forEach(function (e) {
      if (e.employee_id) legalById[String(e.employee_id)] = String(e.full_name || '');
    });
  } catch (e) {}
  /* middle_initial is a CREW attribute, not part of GX Core's identity slice, so it comes from
     this app's own attribute tab rather than the registry read above. */
  try {
    var attrs = readAttrs_();
    Object.keys(attrs).forEach(function (id) {
      midById[id] = String(attrs[id].middle_initial || '');
    });
  } catch (e) {}

  function group(section) {
    return rows.filter(function (r) { return r.section === section; }).map(function (r) {
      var o = {};
      HISTORY_HEADERS.forEach(function (h) {
        o[h] = (h === 'txn' || h === 'sales' || h === 'discount_pct' || h === 'aov' ||
                h === 'spiff' || h === 'bonus' || h === 'per_hour' || h === 'payroll')
               ? (r[h] === '' ? null : Number(r[h])) : r[h];
      });
      o.full_name = legalById[String(r.employee_id || '')] || '';
      o.middle_initial = midById[String(r.employee_id || '')] || '';
      return o;
    });
  }
  /* null for the 27 imported periods — nobody recorded their thresholds, and inventing them would
     be a fabrication dressed as history. The screen marks no targets when it is absent. */
  return { ok: true, pp_start: want, pp_end: rows[0].pp_end, format: rows[0].format,
           imported_at: rows[0].imported_at, source: 'imported',
           thresholds: schemeFor_(want),
           admin: group('admin')[0] || null, managers: group('manager'), budtenders: group('budtender') };
}

/* ══ Incentive, live side ════════════════════════════════════════════════════════════════════════
 *
 * A pay period is served from one of two places and the answer says which:
 *
 *   imported  a closed period from the payout PDFs (2025-08-04 .. 2026-08-16). Figures as paid.
 *             Nothing is computed and nothing is editable — see the header on crew_incentive_history.
 *   live      Leaderboard's incentiveperf slice plus Crew's own inputs. The bonus MATH runs in the
 *             browser (crew.js calcBud/calcMgr/calcAdmin) so an attendance or SPIFF edit re-scores
 *             immediately, which is the behavior the Leaderboard dashboard had and staff expect.
 *
 * THE SPLIT THAT SURVIVES THE MOVE. Leaderboard stays the PERFORMANCE engine — Dutchie ingest,
 * aggregateTransactions_, the discretionary-discount classification, and the frozen closed-period
 * snapshots. GX Crew is the PAYOUT app — the math, the inputs, the thresholds and the Capstone
 * export. Sky's own sentence: SPIFF sets the goals, LB tracks the performance, Crew reads it.
 *
 * The hop to Leaderboard is app-to-app, which the shared brain forbids, and it is TEMPORARY: a
 * brain note asks core-admin to promote the per-employee slice into GX Core, and SPIFF wants the
 * same data. When that lands, only fetchLivePerf_ changes. */
var INPUTS_TAB = 'crew_incentive_inputs';
var INPUTS_HEADERS = ['pp_start', 'employee_id', 'att', 'spiff', 'hours', 'updated_at', 'updated_by'];

/* `hours` is here BEFORE anything fills it, on purpose. The dashboard's $/hr column divides by a
 * flat thresholds.hoursPerPeriod (80) for everybody — fine as a uniform yardstick, which is what
 * Sky confirmed it is, but wrong for anyone who did not work a full fortnight. "connect to
 * SwipeClock" is already on the build order, and when it lands it fills THIS column: a blank means
 * "use the flat figure", so $/hr becomes true per-person the day the clock connects, with no
 * schema migration and no recompute of any period already closed. */
function inputsFor_(ppStart) {
  var out = Object.create(null);
  readTab_(INPUTS_TAB, INPUTS_HEADERS).forEach(function (r) {
    if (r.pp_start !== ppStart || !r.employee_id) return;
    /* A BLANK SPIFF CELL IS NOT A ZERO. `null` means "nobody typed anything", which is what lets
       the measured figure from SPIFF's progress cache stand; a real 0 is Mike deliberately zeroing
       a miss and must beat it. Collapsing the two here is what broke both halves of this column:
       ticking ATTENDANCE creates the row with spiff still empty, so every person with a tick was
       sent `spiff: 0`, the browser read that as a deliberate override, and the measured amount
       never showed. Same shape as `hours` directly below, for the same reason. */
    out[r.employee_id] = { att: isTruthyFlag_(r.att),
                           spiff: (r.spiff === '' || r.spiff == null) ? null : (Number(r.spiff) || 0),
                           hours: r.hours === '' ? null : (Number(r.hours) || null) };
  });
  return out;
}

/* Run BOTH engines for a period and report where they disagree — the thing to look at before
   flipping cfg.incentiveEngine. Names only and per-person deltas; it is already behind the deploy
   secret, but there is no reason for a comparison tool to print a roster of salaries.

   Deliberately calls each source directly rather than going through fetchLivePerf_, so it reports
   what the two ENGINES say and cannot be fooled by whichever one the flag currently selects. */
function incentiveCompare_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var pp = String((p && p.pp_start) || '').trim();

  var lb = fetchLivePerfLeaderboard_(pp);
  var gx = fetchLivePerfFromCore_(pp);
  if (lb.ok === false) return { ok: false, stage: 'leaderboard', error: lb.error };
  if (gx.ok === false) return { ok: false, stage: 'gxcore', error: gx.error };

  /* STRUCTURE FIRST, NUMBERS SECOND — and this order is the lesson.
   *
   * The first version of this compared budtenders and managers, which were the two groups I had in
   * mind. Leaderboard also sends an `admin` row that the browser renders, scores and exports, and
   * because nothing compared it, flipping the engine dropped a person off a pay screen while this
   * tool reported a clean diff. A comparison is only as good as the fields somebody thought to
   * compare, so it now checks WHICH FIELDS EXIST on each side before looking at any value. */
  function fieldsOf(o) {
    return Object.keys(o || {}).filter(function (k) { return o[k] !== undefined && o[k] !== null; }).sort();
  }
  /* FIELDS CREW SUPPLIES ITSELF, so their absence from the engine payload is expected and must not
     trip the guard. A check that cries wolf is one people learn to click past, which is the failure
     this whole comparison exists to avoid — so each entry here is verified, not assumed:

       periods     Crew computes the calendar in periodList_/computedPeriods_ and deliberately does
                   NOT borrow it: a null list once stranded the picker on an imported period with no
                   way back to the current one.
       thresholds  overlaid from GX Core kv `incentiveThresholds` in the view; confirmed complete
                   (budtender, manager, admin) on 2026-09-01.
       saved       nothing reads it on the incentive path. crew.js's only `.saved` is the roster_save
                   response, an unrelated route. Crew builds its own via inputsFor_(). */
  var CREW_SUPPLIES = ['periods', 'thresholds', 'saved'];

  var lbFields = fieldsOf(lb), gxFields = fieldsOf(gx);
  var missingInGx = lbFields.filter(function (k) {
    return gxFields.indexOf(k) === -1 && CREW_SUPPLIES.indexOf(k) === -1;
  });
  var supplied = lbFields.filter(function (k) {
    return gxFields.indexOf(k) === -1 && CREW_SUPPLIES.indexOf(k) !== -1;
  });
  var extraInGx   = gxFields.filter(function (k) { return lbFields.indexOf(k) === -1; });

  // Sub-shapes that matter: a present-but-empty admin or payPeriod is as bad as a missing one.
  function subFields(o, k) { return o && o[k] ? fieldsOf(o[k]) : []; }
  var shape = {
    admin:      { leaderboard: subFields(lb, 'admin'),     gxcore: subFields(gx, 'admin') },
    payPeriod:  { leaderboard: subFields(lb, 'payPeriod'), gxcore: subFields(gx, 'payPeriod') }
  };

  function index(payload) {
    var m = Object.create(null);
    // ALL THREE groups. The admin row has no `name` in the same sense, so it is keyed explicitly.
    (payload.budtenders || []).concat(payload.managers || []).forEach(function (r) {
      var k = nameToKey_(r.name);
      if (!k) return;
      m[k] = (m[k] || 0) + (Number(r.sales) || 0);
    });
    /* Keyed on the ROLE, not the name. Leaderboard hardcoded 'Mike Kettler'; GX Core reads the
       roster and gets the legal 'Michael Kettler'. Keying on the name made one row look like two
       different people appearing and disappearing. The name difference is reported separately,
       where it is information rather than an alarm. */
    if (payload.admin) m['(admin)'] = Number(payload.admin.actual) || 0;
    return m;
  }
  var a = index(lb), b = index(gx);
  var names = Object.create(null);
  Object.keys(a).forEach(function (k) { names[k] = 1; });
  Object.keys(b).forEach(function (k) { names[k] = 1; });

  var diffs = [], both = 0, onlyLb = [], onlyGx = [];
  Object.keys(names).forEach(function (k) {
    var inA = a[k] !== undefined, inB = b[k] !== undefined;
    if (inA && inB) {
      both++;
      var d = Math.round((b[k] - a[k]) * 100) / 100;
      if (Math.abs(d) > 0.005) diffs.push({ name_key: k, delta: d });
    } else if (inA) { onlyLb.push(k); } else { onlyGx.push(k); }
  });
  diffs.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });

  var sum = function (o) { return Object.keys(o).reduce(function (t, k) { return t + o[k]; }, 0); };
  return {
    ok: true,
    pp_start: gx.payPeriod.start, pp_end: gx.payPeriod.end,
    people: { in_both: both, only_leaderboard: onlyLb, only_gxcore: onlyGx },
    totals: { leaderboard: Math.round(sum(a) * 100) / 100,
              gxcore: Math.round(sum(b) * 100) / 100,
              delta: Math.round((sum(b) - sum(a)) * 100) / 100 },
    differing_people: diffs.length,
    largest_deltas: diffs.slice(0, 15),
    /* Read THIS before the numbers. A field Leaderboard sends and GX Core does not is a feature that
       disappears on the flip, and it will not show up as a delta — it shows up as nothing at all. */
    fields_missing_in_gxcore: missingInGx,
    fields_crew_supplies_itself: supplied,
    fields_only_in_gxcore: extraInGx,
    shape: shape,
    admin_row: { leaderboard: !!lb.admin, gxcore: !!gx.admin,
                 leaderboard_name: (lb.admin || {}).name || '',
                 gxcore_name: (gx.admin || {}).name || '',
                 /* samePerson_ is the ladder the rest of this engine uses to decide whether two
                    spellings are one human, so the comparison asks it rather than inventing a
                    second opinion about whether Mike and Michael are the same person. */
                 same_person: !!(lb.admin && gx.admin &&
                   samePerson_(lb.admin.name || '', gx.admin.name || '')) },
    /* The two known, intended reasons the totals can differ. Anything NOT explained by these is
       what the comparison exists to surface. */
    gxcore_ignored_returns: (gx.returns_not_counted || []).length,
    gxcore_return_grace_days: gx.return_grace_days,
    note: 'GX Core excludes voids and scores returns against the SALE period (+grace); Leaderboard '
        + 'deducts returns in the period they were processed. Store keys also differ: store_id vs '
        + 'Leaderboard display slugs.'
  };
}

/* ─── THE SAME PAYLOAD, FROM GX CORE ─────────────────────────────────────────────────────────────
 *
 * Leaderboard has been the performance engine and this app the payout app, with Crew reaching into
 * Leaderboard over ?action=incentiveperf — app-to-app, which the shared brain forbids, and which
 * both apps' comments have called TEMPORARY since it was written. GX Core now computes the same
 * slice (?action=incentive_perf), built on the shared sales_by_employee aggregation rather than a
 * second Dutchie pull.
 *
 * BEHIND A FLAG, and deliberately. kv `cfg.incentiveEngine` selects the source and defaults to
 * `leaderboard`, so merging this changes nothing. These numbers decide what people are paid; the
 * switch should be a toggle somebody flips after looking at a comparison, and one that can be
 * flipped back in seconds without a deploy.
 *
 * WHAT DIFFERS, and it is not nothing:
 *   · GX Core excludes VOIDS. Leaderboard counted them until 2026-08-31 — 403.93 in one fortnight
 *     across six stores. Both are fixed now, but an old period recomputed from each side can still
 *     differ if it was scored before that.
 *   · RETURNS follow the sale, and count only within their own period plus a five-day grace.
 *     Leaderboard deducts every return in the period it was PROCESSED.
 *   · store keys are GX Core store_id (bend, hillsboro, portland-rd), not Leaderboard display slugs
 *     (century, baseline, portland). Everything else in this engine already resolves stores through
 *     GXCore.resolveStore, so this moves Crew onto the suite vocabulary — but it is a visible change
 *     to any consumer matching on the old strings, which is the main thing to look at before
 *     flipping.
 * ------------------------------------------------------------------------------------------------ */
function incentiveEngine_() {
  try { return String(GXCore.getKv('cfg.incentiveEngine') || '').trim().toLowerCase() || 'leaderboard'; }
  catch (e) { return 'leaderboard'; }   // unreachable kv must not silently switch a pay source
}

/* GX Core's incentive_perf, mapped into the shape this engine already consumes. The mapping is the
   whole risk surface, so it is explicit rather than a spread: a renamed field that silently arrives
   as undefined reads downstream as a zero, and a zero here is somebody's bonus. */
function fetchLivePerfFromCore_(ppStart) {
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) {
    return { ok: false, error: 'GX_DEPLOY_SECRET is not set on the Crew script, so Crew cannot '
           + 'authenticate to GX Core for live performance data.', needs: 'GX_DEPLOY_SECRET script property' };
  }
  var url = GXCORE_URL + '?action=incentive_perf&secret=' + encodeURIComponent(secret)
          + (ppStart ? '&pp_start=' + encodeURIComponent(ppStart) : '');
  var d = null, lastErr = '';
  for (var i = 0; i < 5; i++) {
    try {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      var body = res.getContentText();
      if (body && body.charAt(0) === '{') { d = JSON.parse(body); break; }
      lastErr = 'HTTP ' + res.getResponseCode();
    } catch (e) { lastErr = String((e && e.message) || e); }
    Utilities.sleep(400);   // the /exec second hop 404s on ~6% of rapid calls
  }
  if (!d) return { ok: false, error: 'GX Core incentive_perf unreachable — ' + lastErr };
  if (d.ok === false) return { ok: false, error: 'GX Core incentive_perf: ' + (d.error || 'refused') };

  var row = function (r) {
    return {
      name:      String(r.name || ''),
      nameKey:   nameToKey_(String(r.name || '')),
      /* The LEGAL name rides along: the screen shows the friendly one, the Capstone export needs
         this one. Leaderboard never sent it and stampEmployeeIds_ filled it in from the registry;
         GX Core already knows it, so it arrives rather than being re-derived. */
      full_name: String(r.full_name || ''),
      storeSlug: String(r.store || ''),
      storeName: String(r.store_name || ''),
      txn:       Number(r.transactions) || 0,
      sales:     Number(r.sales) || 0,
      discount:  Number(r.discount_rate) || 0,   // a RATE, as Leaderboard sent it — not a dollar amount
      aov:       Number(r.aov) || 0,
      /* THE TARGET. Dropped by the first cut of this mapping, so every manager row rendered "—"
         under TARGET and 0.0% under % GOAL while the engine was returning real figures. A field
         that arrives as undefined reads downstream as nothing at all, which is exactly why the
         mapping is written out one line at a time rather than spread. */
      target:    (r.target == null ? null : Number(r.target))
    };
  };
  return {
    ok: true,
    source: 'gxcore',
    /* payPeriod.current gates editability across the whole incentive view — omitting it reads as
       false and silently locks the screen for the period people are working in. GX Core computes
       it; this carries it rather than re-deriving a second opinion about which period is open. */
    payPeriod: (d.payPeriod && d.payPeriod.start)
      ? d.payPeriod
      : { start: String(d.pp_start || ''), end: String(d.pp_end || ''), current: false },
    /* THE ADMIN ROW. Its absence is what forced the 2026-09-01 rollback: the browser renders,
       scores, counts and exports this row, and without it a person simply left the pay screen. */
    admin: d.admin || null,
    budtenders: (d.budtenders || []).map(row),
    managers:   (d.managers || []).map(row),
    adminActual: Number(d.admin_actual) || 0,
    adminTarget: Number(d.admin_target) || 0,
    stores: d.stores || {},
    // Carried through so the screen can show what the engine chose to ignore rather than the
    // difference appearing as an unexplained few dollars.
    returns_not_counted: d.returns_not_counted || [],
    return_grace_days: d.return_grace_days,
    unresolved: d.unresolved || []
  };
}

/* Leaderboard's incentiveperf. A failed read RETURNS AN ERROR rather than an empty period: a
 * dashboard that renders "no bonuses" because a fetch failed looks exactly like a fortnight in
 * which nobody earned anything, and this one is about pay. Same rule as the nightly Dutchie scan. */
function fetchLivePerf_(ppStart) {
  return incentiveEngine_() === 'gxcore'
    ? fetchLivePerfFromCore_(ppStart)
    : fetchLivePerfLeaderboard_(ppStart);
}

/* The original app-to-app path. Kept under its own name so incentiveCompare_ can call it directly
   regardless of which engine the flag selects — a comparison that ran whatever the flag chose would
   compare one engine against itself and report a clean zero. */
function fetchLivePerfLeaderboard_(ppStart) {

  /* The URL lives in GX Core's kv, not in this file — the same place Leaderboard's own callers
     read it from, so a redeploy that mints a new /exec is fixed in one place for the whole suite. */
  var base = '';
  try { base = String(GXCore.getKv('lbGoals') || ''); } catch (e) { base = ''; }
  if (!base) return { ok: false, error: 'no Leaderboard engine URL in GX Core kv (key lbGoals)' };
  /* INBOUND auth (deploySecretOk_) does not need this property — it falls back to a cached digest
     of a secret somebody already presented, which is why every other route works without it. This
     is the one OUTBOUND call in the engine, and it needs the secret's actual VALUE to present to
     Leaderboard, which only the script property can hold. So the engine can look perfectly healthy
     and still fail here, and the old message ("not set on this script") did not say where to set
     it or why only this one route cared. */
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) {
    return { ok: false, error: 'GX_DEPLOY_SECRET is not set on the Crew script, so Crew cannot ' +
      'authenticate to Leaderboard for live performance data. Imported (closed) periods still ' +
      'work — they need nothing from Leaderboard. To fix: open the Crew Apps Script project → ' +
      'Project Settings → Script Properties → add GX_DEPLOY_SECRET with the value in ' +
      '.gx_deploy_secret. https://script.google.com/home/projects/' +
      '109qNE_Gjz91xK4cTBFCquQo2OKTHenfA2VWIAXnEZlkr7UHF1tPIw9KP/settings',
      needs: 'GX_DEPLOY_SECRET script property' };
  }
  var url = base + '?action=incentiveperf&secret=' + encodeURIComponent(secret) +
            (ppStart ? '&ppStart=' + encodeURIComponent(ppStart) : '');
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) {
      return { ok: false, error: 'Leaderboard returned HTTP ' + res.getResponseCode() };
    }
    var d = JSON.parse(res.getContentText());
    if (!d || d.ok === false) return { ok: false, error: (d && d.error) || 'Leaderboard refused' };
    return d;
  } catch (e) {
    return { ok: false, error: 'could not reach Leaderboard: ' + String((e && e.message) || e) };
  }
}

/* Leaderboard identifies people by its own nameKey ('chris_carney'); GX Core — and therefore every
 * input Crew saves, every joined roster row, and the imported history — uses employee_id
 * ('christopher_carney'). They are different strings for the same person often enough that treating
 * them as interchangeable does not fail, it just quietly stops finding things: an attendance tick
 * saved against employee_id would never be found by a row keyed on nameKey, so the bonus computed
 * as though nothing had been entered and the payroll came out short. Nothing errors.
 *
 * So every live row gets an employee_id stamped on it before it leaves the engine, resolved through
 * the SAME ladder the rest of Crew uses (exact key, then samePerson_) rather than a second opinion.
 * A row that cannot be resolved keeps a blank employee_id and is reported in `unmatched` — it will
 * render, and it simply cannot hold an input until somebody is matched to it. */
function stampEmployeeIds_(live) {
  var emps = [];
  try { emps = GXCore.getEmployees() || []; } catch (e) { emps = []; }
  /* A MERGED record is a tombstone GX Core keeps so the old employee_id still resolves for
     Leaderboard and SPIFF joins. It is still returned here and still matches on name, so without
     this filter a live row can be stamped with an id nothing renders — and an input saved against
     it would vanish. RETIRED is deliberately kept: a retired person really did work that period. */
  /* NAMED `roster`, not `live`. It was `var live = …` and that SHADOWED THE PARAMETER: from that
     line on, `live` was the employee array, so `live.budtenders` was undefined, forEach ran zero
     times, and not one row was stamped. Nothing threw — the route returned a complete-looking
     payload in which every employee_id was blank, so every input saved from the screen would have
     been looked up under a key nothing wrote. Caught by incentive_probe reporting the impossible
     pair `stamped: 0, unmatched: []`. */
  var roster = emps.filter(function (e) { return String(e.status || '').toLowerCase() !== 'merged'; });
  var midById = Object.create(null), swcById = Object.create(null);
  try {
    var _attrs = readAttrs_();
    Object.keys(_attrs).forEach(function (id) {
      midById[id] = String(_attrs[id].middle_initial || '');
      swcById[id] = String(_attrs[id].swipeclock_code || '').trim();
    });
  } catch (e) {}
  var byKey = Object.create(null), legalById = Object.create(null);
  roster.forEach(function (e) {
    if (e.employee_id) legalById[String(e.employee_id)] = String(e.full_name || '');
    /* The name people are CALLED by, as well as the legal one: the registry's Robert Wydick is
       "Nate Wydick" on the board and "Nathan Wydick" in the payout reports, and Thomas Peterson is
       "TJ Peterson". Matching only full_name reaches neither.

       DERIVED through displayNameOf_, which this file already had. GXCore.getEmployees() returns
       the raw `employees` tab,
       which has no display_name column — that field is added by GX Core's HTTP ?action=employees
       route via gxDisplayName_(), and is simply undefined on the library call this engine makes.
       Reading e.display_name therefore matched nothing and failed silently: the probe reported 37
       of 38 stamped, and the one holdout was exactly the person whose legal name nobody uses. */
    [e.full_name, displayNameOf_(e)].forEach(function (n) {
      var k = nameToKey_(n);
      if (k && !byKey[k]) byKey[k] = e.employee_id;
    });
    if (e.employee_id && !byKey[String(e.employee_id)]) byKey[String(e.employee_id)] = e.employee_id;
  });
  var unmatched = [];
  function stamp(r) {
    if (!r) return;
    var hit = byKey[String(r.nameKey || '')] || byKey[nameToKey_(r.name)] || '';
    if (!hit) {
      for (var i = 0; i < roster.length; i++) {
        if (samePerson_(r.name, roster[i].full_name) ||
            samePerson_(r.name, displayNameOf_(roster[i]))) {
          hit = roster[i].employee_id; break;
        }
      }
    }
    r.employee_id = hit || '';
    /* The LEGAL name, which only the registry holds. Leaderboard sends whatever Dutchie calls the
       person and the payout reports print the nickname; Capstone pays "Wydick Robert N". The
       screen keeps leading with the name people use — this rides alongside for the export. */
    r.full_name = hit ? (legalById[hit] || '') : '';
    r.middle_initial = hit ? (midById[hit] || '') : '';
    /* Rides along so the hours import can match on a CODE rather than on a name. It is the only
       field on the row that comes from the timekeeping system, and it is the difference between
       an import that survives a legal-name change and one that quietly drops that person. */
    r.swipeclock_code = hit ? (swcById[hit] || '') : '';
    if (!hit) unmatched.push(r.name);
  }
  /* LEADERBOARD'S STORE SLUGS ARE NOT GX CORE'S. LB says baseline / century / portland / river;
     the registry says hillsboro / bend / portland-rd / river-rd. Only `center` and `commercial`
     coincide — which is why exactly those two rows had a colored dot and the other four were gray.
     Resolved through GXCore.resolveStore on the DISPLAY NAME, whose aliases already cover every one
     of these ('Baseline' → hillsboro, 'Century' → bend), rather than a local translation table that
     would need editing every time a store is renamed.

     `storeSlug` is deliberately LEFT ALONE. The thresholds express lowVolStores in LEADERBOARD's
     slugs (['center','portland']), and the bonus math matches against it — rewriting the slug to
     the registry's id would silently move two stores off the low-volume transaction bar and change
     what their staff are paid. store_id rides alongside for display and for the export. */
  function stampStore(r) {
    if (!r) return;
    var id = '';
    try {
      var row = GXCore.resolveStore(String(r.storeName || r.storeSlug || ''));
      id = (row && (row.store_id || row.id)) || '';
    } catch (e) { id = ''; }
    r.store_id = id;
  }
  (live.budtenders || []).forEach(function (r) { stamp(r); stampStore(r); });
  (live.managers || []).forEach(function (r) { stamp(r); stampStore(r); });
  if (live.admin) stamp(live.admin);
  live.unmatched = unmatched;
}

/**
 * ?action=incentive_probe — is the Crew → Leaderboard hop alive? Deploy-secret gated.
 *
 * The live half of this dashboard depends on ANOTHER APP'S deployment, a secret held in this
 * script's properties, and an OAuth scope that Apps Script grants silently or not at all. Each can
 * break without anything here changing, and the symptom is identical every time: a signed-in user
 * sees an error on one tab while the engine's own health route says ok. That is a bad way to find
 * out, and it needs a session to reproduce, so it cannot be checked from a shell.
 *
 * This answers it with a secret instead of a session, and returns SHAPE, never figures — row counts
 * and the period it got, so it can be called from a deploy script or a cron without putting anyone's
 * pay into a log. Delete it with the incentiveperf route when GX Core takes the slice over.
 */
function incentiveProbe_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var hasSecret = !!PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  var t0 = new Date().getTime();
  var live = fetchLivePerf_(String(p.pp_start || ''));
  var ms = new Date().getTime() - t0;
  if (live.ok === false) {
    return { ok: false, stage: 'fetch', secret_property_set: hasSecret, ms: ms, error: live.error };
  }
  stampEmployeeIds_(live);
  /* The SPIFF fold, reported here for the same reason the stamp is: it is the other join that can
     silently match nobody, and a payroll column reading $0 for everyone looks exactly like a quiet
     fortnight. Names only, never amounts — this route is safe to log. */
  applySpiffEarnings_(live, (live.payPeriod || {}).start || '');
  var withSpiff = (live.budtenders || []).concat(live.managers || [])
                    .filter(function (r) { return (Number(r.spiff_earned) || 0) > 0; });
  return {
    ok: true, secret_property_set: hasSecret, ms: ms,
    spiff: live.spiff ? { ok: live.spiff.ok, error: live.spiff.error || '',
                          refreshed_at: live.spiff.refreshed_at || '',
                          matched: live.spiff.matched, people: live.spiff.people,
                          rows_in_cache: live.spiff.rows_in_cache,
                          rows_in_window: live.spiff.rows_in_window,
                          unmatched: live.spiff.unmatched,
                          earning: withSpiff.map(function (r) { return r.name; }) } : null,
    source: live.source || 'leaderboard',
    pay_period: live.payPeriod,
    managers: (live.managers || []).length,
    budtenders: (live.budtenders || []).length,
    admin: !!live.admin,
    thresholds: !!live.thresholds,
    /* Names only, and only the ones that FAILED to match — the whole point is to surface people the
       stamp could not resolve, since an input saved against a blank id goes nowhere. */
    unmatched: live.unmatched || [],
    stamped: (live.budtenders || []).filter(function (b) { return b.employee_id; }).length +
             (live.managers || []).filter(function (m) { return m.employee_id; }).length
  };
}

/* ══ SPIFF — vendor money, read not typed ═══════════════════════════════════════════════════════
 *
 * Sky, 2026-08-27: "the goal is there is no typing needed… I'm trying to take human error out of
 * the equation." So the SPIFF column is populated from what SPIFF actually measured, and Mike
 * overrides only when something is a miss.
 *
 * Read from SPIFF's progress cache, never computed here. SPIFF owns the sell-through, the targets
 * and the payout rule; Crew reads a finished figure. Computing it a second time would be a second
 * answer to "what does this person get", and the vendor is being sent SPIFF's number.
 *
 * App-to-app again, and temporary for the same reason as the Leaderboard hop: it goes when GX Core
 * carries the slice. `spiffProgress` in GX Core kv holds the URL so a redeploy is a config change.
 */
function spiffProgressFor_(ppStart) {
  var base = '';
  try { base = String(GXCore.getKv('spiffProgress') || ''); } catch (e) {}
  if (!base) return { ok: false, error: 'no SPIFF engine URL in GX Core kv (key spiffProgress)' };
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on the Crew script' };
  /* NO pay_period FILTER. SPIFF stores it as a human-readable RANGE — "2026-08-17 - 2026-08-30" —
     not a start date, so asking for "2026-08-17" matched nothing and the column read $0 for
     everyone: indistinguishable from a fortnight where nobody earned. Crew filters on the WINDOW
     instead, which is the fact rather than its formatting, and survives whatever string SPIFF
     chooses next. */
  var url = base + '?action=progress&secret=' + encodeURIComponent(secret);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'SPIFF returned HTTP ' + res.getResponseCode() };
    var d = JSON.parse(res.getContentText());
    if (!d || d.ok === false) return { ok: false, error: (d && d.error) || 'SPIFF refused' };
    return d;
  } catch (e) {
    return { ok: false, error: 'could not reach SPIFF: ' + String((e && e.message) || e) };
  }
}

/**
 * ?action=incentive_spiff_refresh — ask SPIFF to re-measure, store by store.
 *
 * SPIFF's own sweep is ~9s per store and /exec dies at 60, so it hands back a PLAN and the caller
 * loops. Crew does that looping HERE rather than in the browser: the tab would have to stay open
 * for the whole run, and a manager who navigated away mid-loop would leave half the stores stale
 * with nothing saying so.
 *
 * Bounded by `max` because this route has the same 60s ceiling. It reports what it did and what is
 * LEFT, so the caller can call again and finish the job rather than believing it is done.
 */
function incentiveSpiffRefresh_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'read-only' };

  var base = '';
  try { base = String(GXCore.getKv('spiffProgress') || ''); } catch (e) {}
  if (!base) return { ok: false, error: 'no SPIFF engine URL in GX Core kv (key spiffProgress)' };
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on the Crew script' };

  function call(qs) {
    var res = UrlFetchApp.fetch(base + '?secret=' + encodeURIComponent(secret) + qs,
                                { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'SPIFF HTTP ' + res.getResponseCode() };
    try { return JSON.parse(res.getContentText()); }
    catch (e) { return { ok: false, error: 'SPIFF returned something that is not JSON' }; }
  }

  var plan = call('&action=refreshProgress');
  if (!plan || plan.ok === false) return plan || { ok: false, error: 'no plan from SPIFF' };
  var todo = plan.plan || [];
  if (!todo.length) {
    return { ok: true, refreshed: 0, remaining: 0, programs: plan.programs || 0,
             by_status: plan.all_programs_by_status || {},
             note: 'no active programs to measure' };
  }

  /* Four stores a call keeps this comfortably under the ceiling even on a slow day; the caller
     repeats until `remaining` is 0. Deliberately not "as many as fit" — a run that sometimes
     finishes and sometimes times out is worse than one that always needs two clicks. */
  var max = Math.max(1, Math.min(6, Number(p.max) || 4));
  var done = [], failed = [];
  for (var i = 0; i < todo.length && i < max; i++) {
    var r = call('&action=refreshProgress&program=' + encodeURIComponent(todo[i].program) +
                 '&store=' + encodeURIComponent(todo[i].store));
    if (!r || r.ok === false) failed.push({ store: todo[i].store, error: (r && r.error) || 'failed' });
    else done.push(todo[i].store + ' (' + (r.rows || 0) + ')');
  }
  return { ok: true, refreshed: done.length, stores: done, failed: failed,
           remaining: Math.max(0, todo.length - max), total: todo.length };
}

/* Fold SPIFF's earnings onto the live rows. Matched on employee_id, with a displayed-name fallback
 * for anyone SPIFF could not resolve — SPIFF attributes from Dutchie's completedByUser and its own
 * source comment anticipates the roster being seeded, which it now is.
 *
 * The computed figure does NOT overwrite a manual entry. Mike can override a miss, and an override
 * that a background refresh silently reverted would be worse than no automation at all: he would
 * fix it, watch it come back, and stop trusting the column. Both are returned; the screen shows the
 * computed one, marks a row where they disagree, and the export uses whichever is in force. */
/* WHICH PAY PERIOD A SPIFF PROGRAM'S MONEY BELONGS TO.
 *
 * SPIFF measures a program over ITS OWN WINDOW — `sellthrough_` runs from `prog.start_date` to
 * `prog.end_date`, never per fortnight — so `earned` is one figure for the whole program. This used
 * to be attributed to every pay period the window OVERLAPPED, which means a program spanning two
 * fortnights paid its full total into BOTH: the same vendor dollars counted twice, and the earlier
 * period showing money earned after it had already closed.
 *
 * Sky's rule stands and is why this is not simple containment: "SPIFFs run concurrent to the pay
 * period, and a historical date that does not line up is a typo." A program two days out of line
 * must still land in the fortnight it plainly belongs to. So the test is MAJORITY, not overlap and
 * not containment — a program counts for the period holding more than half its window:
 *
 *   exact match ............. 1.00  → counts here
 *   off by a day or two ..... 0.86  → counts here (Sky's tolerance, intact)
 *   split evenly across two . 0.50  → counts NOWHERE, and is reported
 *   a 90-day vendor program . 0.16  → counts NOWHERE, and is reported
 *
 * Only one period can hold more than half of anything, so double-counting is impossible by
 * construction rather than by nobody having noticed. The excluded cases are REPORTED with their
 * amounts, not dropped — vendor money nobody can see is the exact failure this column exists to
 * prevent, and the override field is the answer until SPIFF can measure per period.
 *
 * Dates are TEXT and the arithmetic runs at NOON UTC, the same brace `computedPeriods_` uses: a day
 * count computed at midnight lands on the wrong side of a DST change twice a year. */
/* IS THIS PROGRAM'S MONEY OWED AT ALL? Crew had no such check until 2026-08-31 — it took every row
 * in the cache whose dates lined up, which is how a deleted program (BeGoat, Sky 2026-08-31) still
 * reached the payout screen.
 *
 * SPIFF's vocabulary is exactly three (`spiff.js`, the status picker): draft — not started ·
 * active — running now · closed — PAID OUT. Status is not stored on a cached row; SPIFF resolves it
 * at read time by joining to its `programs` tab, so what arrives here is current, and `''` means
 * that tab has no row with this program_id at all.
 *
 *   active  → pay. Running now, this is the ordinary case.
 *   closed  → PAY. "Closed" is SPIFF's word for paid out, not for canceled, and a pay period is
 *             approved AFTER it ends — by which time its programs have closed. Excluding these
 *             would zero the vendor column on every period anybody ever approves, which is the
 *             opposite of the bug being fixed and would look exactly like a quiet fortnight.
 *   draft   → no. Never started; nothing is owed.
 *   ''      → no. SPIFF has no record of the program. Reported by name, never dropped quietly:
 *             SPIFF keeps orphans distinct from "no rows" on purpose, and a filter is where that
 *             distinction disappears.
 *   other   → PAY, and report it. A status this file has not heard of is far more likely to be a
 *             new flavor of active/closed than a reason to withhold money — and paying wrongly is
 *             a number on screen somebody can question, while withholding wrongly is a $0 that
 *             looks exactly like a budtender who sold nothing.
 */
function spiffPayable_(status) {
  var st = String(status == null ? '' : status).trim().toLowerCase();
  if (st === 'active' || st === 'closed') return { pay: true, why: '' };
  if (st === 'draft') return { pay: false, why: 'draft — never started' };
  if (st === '') return { pay: false, why: 'SPIFF has no record of this program' };
  return { pay: true, why: 'unrecognized status "' + st + '" — counted, please check' };
}

/* The pay-period START out of whatever shape SPIFF stored. The column has held a bare date, a
 * human-readable range ("2026-08-17 - 2026-08-30"), and — before `forceProgressTextDates_` pinned it
 * to plain text — a Date object that serialized to an ISO timestamp. The first YYYY-MM-DD in the
 * string is the period start in every one of those shapes. */
function spiffPeriodOf_(v) {
  var m = String(v == null ? '' : v).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

/* THE SAME COLUMN MEANS TWO DIFFERENT THINGS, and only one of them is a pay period.
 *
 * Programs saved through the record editor carry a RANGE — "2026-08-17 - 2026-08-30" — which is the
 * period, written by the picker. The 22 programs seeded from the .docx files on 2026-08-30 carry a
 * SINGLE date that is consistently four or five days AFTER the program ends: the day the spiff was
 * PAID OUT, not the fortnight it was earned in.
 *
 *   green-cross-test-202608   pp "2026-08-17 - 2026-08-30"   dates 08-17..08-30   period
 *   freshy-2026-02-02…        pp "2026-02-20"                dates 02-02..02-15   payout date
 *   kaprikorn-2025-11-24…     pp "2025-12-12"                dates 11-24..12-07   payout date
 *
 * Not one of the 11 seeded values that is populated lands on a pay-period start — while their DATES
 * are exact periods (02-02..02-15 IS the 2026-02-02 fortnight). So reading every value as a period
 * start and letting it win excluded those programs from EVERY period at once: not mis-attributed by
 * a fortnight, gone, at $0, with nothing raised — the programs are payable and their dates are fine,
 * so no other report catches them. Latent only because the progress cache holds two programs today;
 * the seeded ones are `closed`, and closed pays, so the first refresh that included them would have
 * zeroed 22 legacy vendor programs across the whole history.
 *
 * Hence: only a RANGE is treated as a pay period. A bare date is the legacy payout-date shape and
 * gets no vote — the window decides, which for those records is exactly right. */
function spiffPeriodRangeStart_(v) {
  var m = String(v == null ? '' : v).match(/\d{4}-\d{2}-\d{2}/g);
  return (m && m.length >= 2) ? m[0] : '';
}

/* WHICH PAY PERIOD A PROGRAM BELONGS TO — exact first, heuristic only as a fallback.
 *
 * Sky, 2026-08-31: "let's use the pay period as the match. It is the thing that doesn't change and
 * they are always linked… the program dates are selected by pay period ranges, so they should
 * always match." That is right, and it is a better rule than a share of a window. It just cannot be
 * read off the field of that name:
 *
 *   `pay_period` IS POPULATED ON SOME PROGRAMS AND BLANK ON OTHERS, and it holds a human-readable
 *   RANGE, not a start date. Live cache, 2026-08-31: 38 rows carry "2026-08-17 - 2026-08-30" and 25
 *   carry "". So it cannot be the only rung — a blank one would pay nobody — and it cannot be
 *   compared raw: `stored === '2026-08-17'` is false against that range, which is the trap already
 *   recorded against the `?action=progress` filter, where it made the whole column read $0.
 *   `spiffPeriodOf_` takes the FIRST date out of whatever shape is stored; that is the period start
 *   in all of them. Never compare the raw string.
 *
 *   (Corrected 2026-08-31, same day: this comment claimed the column was empty on EVERY program,
 *   reasoned from the source — the record editor's period picker has its save key stripped, and the
 *   calculator import writes ''. Live data disproved it within the hour. Some writer or a hand edit
 *   populates it; reading the code did not find which, and the honest version of that is this
 *   sentence rather than a mechanism nobody verified.)
 *
 * The picker also FILLS THE DATES FROM THE PERIOD, so a program tied to one carries that period's
 * exact start and end — which is the link for every program whose `pay_period` is blank. Three
 * rungs, most authoritative first:
 *
 *   pay_period    the stored period, if SPIFF ever starts writing it. Authoritative when present.
 *   exact_window  start and end equal the period's. The normal case for anything picked from the
 *                 dropdown, and it separates a program that ENDED on the 30th from one that
 *                 STARTED on the 31st without caring whether either is still marked active.
 *   majority      the old share-of-window rule, for historical records whose dates never lined up.
 *                 Counted, but REPORTED — this is the typo list Sky said he would fix, and it
 *                 disappears on its own as those records are corrected.
 */
/* Is this window a pay period in its own right — the right length AND on the cadence? Used to tell
 * a program whose dates were EDITED away from its period (legitimate; SPIFF's own picker says "they
 * stay editable — not every program lines up with payroll") from one whose dates are exactly some
 * OTHER period, which is a contradiction worth a human. Arithmetic rather than a list, so it answers
 * for 2025 dates the period picker no longer reaches back to. Noon UTC, same DST brace as
 * `computedPeriods_`. */
function spiffIsPeriodWindow_(a, b, anchor, days) {
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO.test(a) || !ISO.test(b) || !ISO.test(anchor) || !(days > 0)) return false;
  var noon = function (d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 12); };
  if (Math.round((noon(b) - noon(a)) / 86400000) + 1 !== days) return false;
  var off = Math.round((noon(a) - noon(anchor)) / 86400000);
  return off % days === 0;
}

function spiffPeriodMatch_(progStart, progEnd, ppStart, ppEnd, payPeriod) {
  var v = spiffShare_(progStart, progEnd, ppStart, ppEnd);
  if (v.bad) return { bad: true, how: '', match: false, share: 0 };
  var exact = (progStart === ppStart && progEnd === ppEnd);
  var stored = spiffPeriodRangeStart_(payPeriod);
  if (stored) {
    if (stored === ppStart) return { bad: false, how: 'pay_period', match: true, share: 1 };
    /* A range that names one period while the dates are exactly another. Counted in NEITHER and
       reported: guessing would either double-pay (letting both rungs win in their own period) or
       silently zero it (letting the range exclude). The one thing that must not happen is a
       decision nobody can see. */
    if (exact) return { bad: false, how: 'conflict', match: false, share: 1, conflict: true };
    return { bad: false, how: 'pay_period', match: false, share: v.share };
  }
  /* A bare date was present and deliberately ignored — the legacy payout-date shape. Reported on
     BOTH remaining rungs: the seeded records match on `exact_window`, so attaching it only to
     `majority` would report the ignored value for nobody it actually applies to. */
  var ignored = spiffPeriodOf_(payPeriod) || '';
  if (exact) return { bad: false, how: 'exact_window', match: true, share: 1, ignored_pay_period: ignored };
  return { bad: false, how: 'majority', match: v.share > 0.5, share: v.share, ignored_pay_period: ignored };
}

function spiffShare_(progStart, progEnd, ppStart, ppEnd) {
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO.test(progStart) || !ISO.test(progEnd) || progStart > progEnd) return { bad: true, share: 0 };
  if (!ISO.test(ppStart) || !ISO.test(ppEnd) || ppStart > ppEnd) return { bad: true, share: 0 };
  var noon = function (d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 12); };
  var days = function (a, b) { return Math.round((noon(b) - noon(a)) / 86400000) + 1; };   // inclusive
  var from = progStart > ppStart ? progStart : ppStart;
  var to   = progEnd   < ppEnd   ? progEnd   : ppEnd;
  if (from > to) return { bad: false, share: 0 };                    // no overlap at all
  return { bad: false, share: days(from, to) / days(progStart, progEnd) };
}

function applySpiffEarnings_(live, ppStart) {
  var sp = spiffProgressFor_(ppStart);
  if (sp.ok === false) { live.spiff = { ok: false, error: sp.error }; return; }

  var d10 = function (v) { return String(v || '').slice(0, 10); };
  var ppEnd = d10((live.payPeriod || {}).end);
  var ppFrom = d10(ppStart);
  /* Does this SPIFF deployment resolve status at all? If NOT A SINGLE row carries the key, it
     predates the read-time join, and applying the payability filter would read every row as an
     orphan and zero the whole column. Degrade to the old date-only behavior and SAY SO, rather
     than silently withholding every vendor dollar because the other app is behind. */
  var hasStatus = (sp.rows || []).some(function (r) { return r && r.status !== undefined; });

  /* The cadence, for the "are these dates exactly ANOTHER period" cross-check below. Read once, and
     an unreadable config just disables that one warning rather than failing the fold. */
  var ppAnchor = '', ppDays = 0;
  try { ppAnchor = String(GXCore.getKv('cfg.payPeriodAnchor') || '').slice(0, 10); } catch (e) {}
  try { ppDays = Number(GXCore.getKv('cfg.payPeriodDays')) || 14; } catch (e) { ppDays = 14; }

  var rows = [], straddle = Object.create(null), malformed = Object.create(null);
  var notPayable = Object.create(null), oddStatus = Object.create(null);
  var looseDates = Object.create(null), matchedBy = Object.create(null);
  var conflicts = Object.create(null), payoutDates = Object.create(null);
  function note(bag, r, a, b, why) {
    var k = String(r.program_id);
    var e = bag[k] || (bag[k] = { program_id: r.program_id, vendor: r.vendor, name: r.program_name,
                                  window: (a || '?') + ' → ' + (b || '?'), status: r.status,
                                  reason: why, earned: 0 });
    e.earned = Math.round((e.earned + (Number(r.earned) || 0)) * 100) / 100;
  }
  (sp.rows || []).forEach(function (r) {
    var a = d10(r.start_date), b = d10(r.end_date);
    /* PAYABILITY IS CHECKED FIRST, before the window is even looked at. A dead program that also
       straddles two fortnights would otherwise be reported as "$350 of vendor money nobody can
       see, use the override" — which is precisely the wrong prompt for money that is not owed. */
    if (hasStatus) {
      var pay = spiffPayable_(r.status);
      if (!pay.pay) { note(notPayable, r, a, b, pay.why); return; }
      if (pay.why) note(oddStatus, r, a, b, pay.why);
    }
    var v = spiffPeriodMatch_(a, b, ppFrom, ppEnd, r.pay_period);
    if (v.bad) { malformed[String(r.program_id)] = (r.program_name || r.program_id) +
                 ' (' + (a || '?') + ' → ' + (b || '?') + ')'; return; }
    if (v.conflict) { note(conflicts, r, a, b, 'pay_period says ' +
                        spiffPeriodRangeStart_(r.pay_period) + ' but the dates are this period'); return; }
    if (v.match) {
      rows.push(r);
      matchedBy[v.how] = (matchedBy[v.how] || 0) + 1;
      /* THE CONFLICT MUST BE VISIBLE ON THE SIDE THAT PAYS. Raising it only where the DATES point
         put the warning on the one period that pays nothing: approve the period the range names and
         the money arrives with an empty conflicts list and nothing on the dry run to look at. A
         disagreement invisible in the run where money moves is the decision nobody can see that
         this whole bag exists to prevent. Only when the dates are exactly ANOTHER pay period —
         merely custom dates are legitimate and must not become noise. */
      if (v.how === 'pay_period' && !(a === ppFrom && b === ppEnd) &&
          spiffIsPeriodWindow_(a, b, ppAnchor, ppDays)) {
        note(conflicts, r, a, b, 'paid into ' + ppFrom + ' because pay_period says so, but its dates are the ' + a + ' period');
      }
      /* A legacy payout-date value that was ignored so the dates could decide. Worth listing once:
         cleaning them up in SPIFF is what eventually makes rung 1 trustworthy for everything. */
      /* Wording matters more than usual here: this row's money IS counted, on its dates, correctly.
         The entry is a DATA-CLEANUP item, not a discrepancy — read as a warning it would send
         somebody hunting a figure that is already right. Deliberately not filtered down to programs
         that could still move a number: that would hide exactly the records the cleanup is for. */
      if (v.ignored_pay_period) note(payoutDates, r, a, b,
                                     'counted correctly on its dates; its pay_period column holds the payout date "' +
                                     v.ignored_pay_period + '" rather than a period — cleanup, not a discrepancy');
      /* Counted, but its dates do not line up with any pay period — the record Sky is going to
         fix. Named while it still pays, so the list empties itself as the typos are corrected
         rather than becoming a permanent warning nobody reads. */
      if (v.how === 'majority') note(looseDates, r, a, b, 'dates do not match a pay period exactly');
      return;
    }
    if (v.how === 'majority' && v.share > 0) {
      var k = String(r.program_id);
      var e = straddle[k] || (straddle[k] = { program_id: r.program_id, vendor: r.vendor,
                                             name: r.program_name, window: a + ' → ' + b,
                                             in_period_pct: Math.round(v.share * 100), earned: 0 });
      e.earned = Math.round((e.earned + (Number(r.earned) || 0)) * 100) / 100;
    }
  });
  var bagList = function (bag) { return Object.keys(bag).map(function (k) { return bag[k]; }); };

  /* SPIFF's employee_id is DUTCHIE'S numeric id (42790), not GX Core's slug (tyler_goldsmith) —
     it attributes from Dutchie's own export. The registry already carries dutchie_employee_id for
     exactly this join; CLAUDE.md calls it out as the column SPIFF and Leaderboard resolve through,
     and it is why a partial write blanking it is treated as a bug. Matching on the raw value would
     have found nobody, then quietly fallen through to names. */
  var dutchieToId = Object.create(null);
  try {
    (GXCore.getEmployees() || []).forEach(function (e) {
      var d = String(e.dutchie_employee_id || '').trim();
      if (d && e.employee_id) dutchieToId[d] = String(e.employee_id);
    });
  } catch (e) {}

  var byId = Object.create(null), byName = Object.create(null);
  var agg = Object.create(null);
  rows.forEach(function (r) {
    var gxId = dutchieToId[String(r.employee_id || '').trim()] || '';
    var key = gxId || ('name:' + nameToKey_(r.name));
    var e = agg[key] || (agg[key] = { employee_id: gxId, name: r.name, earned: 0, programs: [] });
    e.earned += Number(r.earned) || 0;
    e.programs.push({ program_id: r.program_id, vendor: r.vendor, name: r.program_name,
                      units: r.units, target: r.target, hit: r.hit, earned: r.earned });
  });
  Object.keys(agg).forEach(function (k) {
    var e = agg[k];
    if (e.employee_id) byId[String(e.employee_id)] = e;
    if (e.name) byName[nameToKey_(e.name)] = e;
  });
  sp.by_employee = Object.keys(agg).map(function (k) { return agg[k]; });
  var matched = 0, unmatched = [];
  function fold(r) {
    if (!r) return;
    var e = byId[String(r.employee_id || '')] ||
            byName[nameToKey_(r.name)] || byName[nameToKey_(displayNameOf_(r))];
    if (!e) return;
    r.spiff_earned = Number(e.earned) || 0;
    r.spiff_programs = e.programs || [];
    matched++;
  }
  (live.budtenders || []).forEach(fold);
  (live.managers || []).forEach(fold);
  (sp.by_employee || []).forEach(function (e) {
    var onBoard = (live.budtenders || []).concat(live.managers || []).some(function (r) {
      return String(r.employee_id || '') === String(e.employee_id || '') ||
             nameToKey_(r.name) === nameToKey_(e.name);
    });
    /* Somebody SPIFF is paying who is not on this period's performance slice — a leaver, or a
       name the connector could not resolve. Reported rather than dropped: unpaid vendor money is
       the thing this whole column exists to stop being missed. */
    if (!onBoard && (Number(e.earned) || 0) > 0) unmatched.push(e.name + ' ($' + e.earned + ')');
  });
  live.spiff = { ok: true, refreshed_at: sp.refreshed_at || '', matched: matched,
                 unmatched: unmatched, people: (sp.by_employee || []).length,
                 rows_in_window: rows.length, rows_in_cache: (sp.rows || []).length,
                 /* Programs whose window no single pay period holds a majority of. Their money is
                    NOT in the figures above — it is listed here so it can be entered by hand
                    rather than silently double-counted or silently lost. */
                 straddling: bagList(straddle),
                 malformed: Object.keys(malformed).map(function (k) { return malformed[k]; }),
                 /* Programs whose money is NOT owed — draft, or deleted from SPIFF's programs tab.
                    Named rather than dropped, so "SPIFF lost a row" stays distinguishable from
                    "nothing was earned", which is the distinction SPIFF itself keeps. */
                 not_payable: bagList(notPayable),
                 /* HOW each counted program was tied to this period. `majority` above zero means
                    somebody's dates need correcting; it should fall to zero and stay there. */
                 matched_by: matchedBy,
                 loose_dates: bagList(looseDates),
                 /* Counted in no period because its two claims disagree — needs a human, not a guess. */
                 period_conflicts: bagList(conflicts),
                 /* Counted on their dates; their pay_period column holds a payout date. */
                 payout_date_pay_periods: bagList(payoutDates),
                 /* Counted, but with a status this file does not recognize. */
                 odd_status: bagList(oddStatus),
                 /* False = the SPIFF deployment predates the read-time status join, so nothing was
                    filtered on payability and a dead program could still be in the figures. */
                 status_checked: hasStatus };
}

/**
 * ?action=incentive[&pp_start=YYYY-MM-DD]
 * Admin-gated through GX Core's own permissions (requireCrew_ + canEdit_) — Crew is admin-only and
 * Sky gates it from Command Center, so there is deliberately no second allowlist here. Leaderboard
 * gates its copy on a hardcoded sky/mike username list, a workaround for both being 'director';
 * that list does not come along.
 */
function getIncentive_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var imported = historyPeriods_();
  var importedBy = Object.create(null);
  imported.forEach(function (h) { importedBy[h.pp_start] = h; });

  var want = String(p.pp_start || '');
  if (want && importedBy[want]) {
    var h = incentiveHistory_({ secret: 'internal', pp_start: want, __internal: true });
    h.periods = periodList_(imported, null);
    h.can_edit = false;
    h.why_read_only = 'Imported from the payout report for this period — the figures as paid.';
    return h;
  }

  var live = fetchLivePerf_(want);
  if (live.ok === false) return live;
  live.source = 'live';
  /* GX Core is the source of truth for the scheme. Leaderboard sends its own read of the same kv
     key, so these agree today — but if LB ever falls back to its local copy, Crew must not compute
     against a number GX Core does not hold. */
  /* NO SCHEME, NO SCREEN. Falling through with whatever the engine happened to send would compute
     bonuses against a scheme GX Core does not hold — and once the engine is GX Core, against no
     scheme at all, which renders as a page of zeros indistinguishable from a quiet fortnight. */
  var coreT = incentiveThresholds_();
  if (!coreT.ok) {
    return { ok: false, stage: 'thresholds', error: coreT.error,
             hint: 'Set incentiveThresholds in GX Core kv. Crew owns compensation; the scheme is '
                 + 'read from there and no longer travels in the performance payload.' };
  }
  live.thresholds = coreT.thresholds;
  stampEmployeeIds_(live);
  live.inputs = inputsFor_(live.payPeriod.start);
  applySpiffEarnings_(live, live.payPeriod.start);
  var wf = wfGet_(live.payPeriod.start) || { status: 'draft' };
  live.workflow = { status: wf.status || 'draft', sent_by: wf.sent_by || '', sent_at: wf.sent_at || '',
                    decided_by: wf.decided_by || '', decided_at: wf.decided_at || '',
                    note: wf.note || '' };
  live.can_approve = canApprove_(auth);
  /* Locked while pending — for everyone, including the approver. Sky editing a figure he is about
     to approve is the same problem as Mike editing one he already sent. */
  live.can_edit = canEdit_(auth) && wf.status !== 'pending';
  live.periods = periodList_(imported, live.periods);
  return live;
}

/* One period list across both eras, newest first, each saying where it comes from — so the picker
   cannot offer a period that neither side can serve. Leaderboard's own list overlaps the imported
   range (it offers the last 8 regardless), and where they overlap the IMPORT wins: it is what was
   actually paid, and the live path would re-derive it against today's thresholds. */
/* Every pay period from the anchor to the one running today, newest first. Dates are TEXT and the
 * arithmetic runs at NOON UTC on purpose: a period boundary computed at midnight lands on the wrong
 * side of a DST change twice a year, which would shift a whole fortnight's worth of sales into the
 * neighboring period. `back` limits how far the picker reaches; imported periods are added
 * separately and are not bounded by it. */
function computedPeriods_(back) {
  var anchorStr = '', days = 14;
  try { anchorStr = String(GXCore.getKv('cfg.payPeriodAnchor') || ''); } catch (e) {}
  try { days = Number(GXCore.getKv('cfg.payPeriodDays')) || 14; } catch (e) {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorStr)) return [];

  function noonUTC(iso) {
    return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12);
  }
  function iso(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) +
           '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  var DAY = 86400000, span = days * DAY;
  var a = noonUTC(anchorStr), now = noonUTC(Utilities.formatDate(new Date(), STORE_TZ, 'yyyy-MM-dd'));
  /* Math.floor, so a date BEFORE the anchor still lands on a real period rather than rounding
     toward zero into the one after it. */
  var n = Math.floor((now - a) / span);
  var out = [];
  var limit = back == null ? 12 : back;
  for (var i = 0; i <= limit; i++) {
    var startMs = a + (n - i) * span;
    if (startMs < a) break;
    out.push({ start: iso(startMs), end: iso(startMs + span - DAY), current: i === 0 });
  }
  return out;
}

function periodList_(imported, livePeriods) {
  var seen = Object.create(null), out = [];
  /* THE CALENDAR IS COMPUTED, NOT BORROWED FROM THE FETCH. Viewing an imported period served no
     live payload, so livePeriods was null and the picker lost every period Leaderboard would have
     offered — including the CURRENT one. Selecting a 2025 period therefore stranded you there with
     no way back, which is exactly the sort of dead end a payroll screen must not have.
     Pay periods are a fixed 14-day cadence from a known anchor (GX Core cfg.payPeriodAnchor /
     cfg.payPeriodDays — the same two values Leaderboard derives its own list from), so Crew can
     work them out for itself in a millisecond instead of paying for a cross-app round trip just to
     populate a dropdown. */
  computedPeriods_().forEach(function (x) {
    if (imported.some(function (h) { return h.pp_start === x.start; })) return;
    seen[x.start] = 1;
    out.push({ pp_start: x.start, pp_end: x.end, current: !!x.current, source: 'live' });
  });
  (livePeriods || []).forEach(function (x) {
    if (seen[x.start] || imported.some(function (h) { return h.pp_start === x.start; })) return;
    seen[x.start] = 1;
    out.push({ pp_start: x.start, pp_end: x.end, current: !!x.current, source: 'live' });
  });
  imported.forEach(function (h) {
    if (seen[h.pp_start]) return;
    out.push({ pp_start: h.pp_start, pp_end: h.pp_end, current: false, source: 'imported' });
  });
  out.sort(function (a, b) { return a.pp_start < b.pp_start ? 1 : a.pp_start > b.pp_start ? -1 : 0; });
  return out;
}

/**
 * ?action=incentive_save — one field at a time, same as the roster.
 * pp_start, employee_id, and any of att / spiff / hours. An ABSENT parameter means "leave alone";
 * an empty one means "clear". Read-merge-write, for the reason stated all over this file: posting a
 * whole record blanks whatever it omits.
 *
 * REFUSES TO WRITE INTO AN IMPORTED PERIOD. Those are closed and paid; an attendance tick against
 * one would imply a recalculation that is never going to happen, and the row it wrote would sit
 * there looking authoritative.
 */
function saveIncentiveInput_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'read-only' };

  var pp  = String(p.pp_start || '').trim();
  var eid = String(p.employee_id || '').trim();
  if (!pp || !eid) return { ok: false, error: 'pp_start and employee_id required' };
  if (historyPeriods_().some(function (h) { return h.pp_start === pp; })) {
    return { ok: false, error: pp + ' is an imported (closed) period — its figures are what was paid and cannot be edited' };
  }
  /* LOCKED WHILE AWAITING APPROVAL. Otherwise the numbers being approved are not the ones that
     were sent: a tick between the email and the click changes what gets frozen, and nothing
     anywhere would say so. */
  var _wf = wfGet_(pp);
  if (_wf && _wf.status === 'pending') {
    return { ok: false, error: pp + ' was sent for approval on ' + _wf.sent_at +
             ' and is locked until it is approved or sent back' };
  }

  /* HOURS ARE REFUSED LOUDLY, never coerced. `inputsFor_` reads this back through
     `Number(r.hours) || null`, so anything unparseable would land in the sheet, read back as null,
     and silently restore the flat 80 — a save that reported ok and did nothing. The ceiling is a
     typo guard, not a policy: a fortnight is 336 hours end to end, so 400 is past anything a real
     timecard can hold and "8000" (a stray zero on 800, itself already impossible) is a mistake
     worth stopping rather than storing. Empty still clears, which is how a row goes back to flat. */
  if (p.hours !== undefined && String(p.hours).trim() !== '') {
    var hv = Number(String(p.hours).trim());
    if (!isFinite(hv) || hv <= 0) {
      return { ok: false, error: 'invalid hours: ' + p.hours + ' (expected a positive number, or empty to use the flat figure)' };
    }
    if (hv > 400) {
      return { ok: false, error: 'implausible hours: ' + p.hours + ' — a 14-day period holds 336 hours end to end' };
    }
  }

  /* SPIFF IS REFUSED LOUDLY TOO, and for a sharper reason than hours. `inputsFor_` now reads a
     blank as "no override" and anything else as a deliberate amount — so an unparseable cell would
     read back as an override of $0 and SUPPRESS the figure SPIFF measured, which is the one
     outcome this column exists to prevent. Empty still clears, which is how a row goes back to
     the measured value. Negatives are allowed: a clawback is a real correction. */
  if (p.spiff !== undefined && String(p.spiff).trim() !== '') {
    var sv = Number(String(p.spiff).trim());
    if (!isFinite(sv)) {
      return { ok: false, error: 'invalid SPIFF: ' + p.spiff +
               ' (expected a number, or empty to use the amount SPIFF measured)' };
    }
  }

  var sh = sheetOf_(INPUTS_TAB, INPUTS_HEADERS);
  var rows = readTab_(INPUTS_TAB, INPUTS_HEADERS);
  var idx = -1;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].pp_start === pp && rows[i].employee_id === eid) { idx = i; break; }
  }
  var cur = idx >= 0 ? rows[idx] : { pp_start: pp, employee_id: eid, att: '', spiff: '', hours: '' };
  ['att', 'spiff', 'hours'].forEach(function (f) {
    if (p[f] === undefined) return;                       // absent = leave alone
    cur[f] = String(p[f]);                                // empty = clear
  });
  cur.updated_at = new Date().toISOString();
  cur.updated_by = auth.user || '';

  var line = INPUTS_HEADERS.map(function (h) { return cur[h] == null ? '' : cur[h]; });
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, INPUTS_HEADERS.length).setValues([line]);
  else          sh.getRange(sh.getLastRow() + 1, 1, 1, INPUTS_HEADERS.length).setValues([line]);
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).setNumberFormat('@');   // pp_start stays TEXT
  return { ok: true, pp_start: pp, employee_id: eid, saved: { att: cur.att, spiff: cur.spiff, hours: cur.hours } };
}

/* ══ Approving a period — the moment live numbers become a record ════════════════════════════════
 *
 * Leaderboard's dashboard has "Approve & Print PDF", and the 27 PDFs in Drive are what it produced.
 * If Crew replaces it without this, the historical record stops being produced at exactly the moment
 * Crew becomes the system of record.
 *
 * Approving writes the period into crew_incentive_history, which is the same store the imported PDFs
 * went into and carries the same guarantee: written once, never recomputed. From then on the period
 * renders `as paid` and cannot be edited. That is what makes Crew self-sufficient — after the first
 * approval there is nothing left to import.
 *
 * THE FIGURES ARE COMPUTED HERE, NOT POSTED FROM THE BROWSER. Everywhere else in this screen the
 * math runs client-side, because an attendance tick has to re-score instantly and a wrong number on
 * screen is fixed by unticking it. This is different: it is the permanent record of what somebody
 * was paid, and a route that writes whatever amount the page hands it is a route where a stale tab,
 * a half-loaded threshold set, or an edited request decides payroll. So approve re-reads the
 * performance slice and the inputs and does the arithmetic itself.
 *
 * That means a SECOND implementation of the bonus math, which is the thing this project has been
 * carefully avoiding all along. It is only acceptable because both implementations are driven
 * against the same frozen Leaderboard oracle by tests/incentive_math_test.js — if the engine and
 * the browser ever disagree, that test fails before either can pay anybody. Do not edit these
 * without running it. */

/* THE DIVISOR FOR $/hr, and the only thing per-person hours change.
 *
 * `hours` is what somebody actually worked this fortnight, from the timekeeping system;
 * T.hoursPerPeriod is the flat 80 the dashboard has always used for everybody. A blank means "use
 * the flat figure" — the same claim `inputsFor_` already encodes by returning null — so a period
 * nobody imported hours for scores EXACTLY as it did before, which is what lets this land without
 * touching a single closed period.
 *
 * ZERO AND NEGATIVE FALL BACK TOO, on purpose. A parse that produced 0 would otherwise divide into
 * Infinity and render as a $/hr of ∞ next to a real bonus; falling back shows the flat yardstick,
 * which is wrong in the same direction it has always been wrong rather than newly nonsensical.
 *
 * SCOPE: $/hr ONLY. It does not touch bonus or payroll, and $/hr is not one of the four columns the
 * Capstone export carries — so nothing here can change what anybody is paid. That is deliberate:
 * it is why hours can be imported from a source we have not yet automated without a penny-match. */
function incHours_(i, T) {
  var h = Number(i && i.hours);
  return (isFinite(h) && h > 0) ? h : T.hoursPerPeriod;
}

/* SPIFF: measured unless somebody overrode it. Mirrors the browser's `incInput` EXACTLY — the two
 * implementations exist on purpose (see the header) and this is the rule they have to agree on.
 *
 * The engine read only `inputs` until 2026-08-31, so `spiff_earned` — the figure SPIFF actually
 * measured, which is the whole point of the column and the only one most people have — never
 * reached the engine's arithmetic. The screen showed it, `incentiveApprove_` froze 0. Payroll was
 * never affected (SPIFF cancels out of it on both sides, and the Capstone export carries payroll),
 * so nobody was paid the wrong amount; the permanent record's `spiff`, `bonus` and `$/hr` columns
 * were simply wrong, and history is immutable.
 *
 * ORDER MATTERS AND IS NOT SYMMETRIC: a manual entry wins even when it is 0, because zeroing a miss
 * is a decision. Only an ABSENT one falls through to what SPIFF measured. */
function incSpiff_(i, row) {
  var manual = (i && i.spiff != null && i.spiff !== '') ? Number(i.spiff) : null;
  if (manual != null && isFinite(manual)) return manual;
  var earned = (row && row.spiff_earned != null) ? Number(row.spiff_earned) : 0;
  return isFinite(earned) ? earned : 0;
}

function incCalcBud_(b, T, inputs) {
  var t = T.budtender, i = inputs[b.employee_id || b.nameKey] || {};
  var spiff = incSpiff_(i, b), att = !!i.att;
  var low  = (t.lowVolStores || []).indexOf(b.storeSlug) !== -1;
  var qual = b.txn >= (low ? t.txnQualifyLowVol : t.txnQualify);
  var aovB = (qual && b.aov >= t.aovTarget) ? t.aovBonus : 0;
  var disB = (qual && b.discount * 100 <= t.discountMaxPct) ? t.discountBonus : 0;
  var attB = att ? t.attendanceBonus : 0;
  var bonus = aovB + disB + attB + spiff;
  return { qual: qual, aovB: aovB, disB: disB, attB: attB, spiff: spiff,
           bonus: bonus, payroll: bonus - spiff, hr: bonus / incHours_(i, T) };
}

function incCalcMgr_(mgr, T, inputs, budtenders) {
  var t = T.manager, i = inputs[mgr.employee_id || mgr.nameKey] || {};
  var spiff = incSpiff_(i, mgr);
  var pct = mgr.target > 0 ? mgr.sales / mgr.target * 100 : 0;
  var sB = 0;
  for (var a = 0; a < t.salesTiers.length; a++) {
    if (pct >= t.salesTiers[a].pct) { sB = t.salesTiers[a].bonus; break; }
  }
  var goal = T.budtender.discountMaxPct;
  var tiers = [{ maxPct: goal * 2 / 3, bonus: t.discountTiers[0].bonus },
               { maxPct: goal,         bonus: t.discountTiers[1].bonus }];
  var dp = mgr.discount * 100, dB = 0;
  for (var c = 0; c < tiers.length; c++) { if (dp <= tiers[c].maxPct) { dB = tiers[c].bonus; break; } }
  var aB = mgr.aov >= t.aovTarget ? t.aovBonus : 0;
  var tA = (budtenders || []).filter(function (b) {
    var bi = inputs[b.employee_id || b.nameKey] || {};
    return b.storeSlug === mgr.storeSlug && !!bi.att;
  }).length * t.teamAttendancePerHead;
  var payroll = sB + dB + aB + tA;
  return { pct: pct, salesB: sB, discB: dB, aovB: aB, teamA: tA, spiff: spiff,
           payroll: payroll, bonus: payroll + spiff, hr: (payroll + spiff) / incHours_(i, T) };
}

/* NO `inputs` PARAMETER, and so no per-person hours — deliberately unchanged by the SwipeClock
   work. Admin is the owner's row: he takes nothing hourly, does not clock in, and has no timecard
   for the export to carry. Reaching hours in here would mean inventing a divisor for the one
   person the clock will never have an opinion about. */
function incCalcAdmin_(admin, T) {
  var t = T.admin;
  var pct = admin.target > 0 ? admin.actual / admin.target * 100 : 0;
  var tier = 0;
  for (var x = 0; x < t.tiers.length; x++) { if (pct >= t.tiers[x].pct) { tier = t.tiers[x].bonus; break; } }
  var bonus = Math.min(tier, admin.stores * t.maxPerStore);
  return { pct: pct, tier: tier, bonus: bonus, hr: bonus / T.hoursPerPeriod };
}

/**
 * ?action=incentive_approve&pp_start=YYYY-MM-DD&confirm=yes
 *
 * Refuses a period that has not ENDED. Leaderboard's own dashboard says it out loud — "live
 * mid-cycle, sales bonuses lock at period end" — and freezing a fortnight that is still selling
 * records a number that was never final.
 *
 * Refuses a period already in history, imported or approved, for the reason the whole tab exists.
 */
function incentiveApprove_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canEdit_(auth)) return { ok: false, error: 'read-only' };
  /* APPROVING IS THE OWNER'S CALL. Preparing is any editor's — that separation is the entire
     point of the workflow, and without this check Mike approves his own work. Deliberately a
     ROLE from GX Core's app_access rather than a username: Leaderboard gated its copy on a
     hardcoded sky/mike list and that is what this replaced. */
  if (!canApprove_(auth)) {
    return { ok: false, error: approverIds_().length
      ? 'only the named approver can approve — use “Send for approval” instead'
      : 'no approver is configured — set cfg.crewApprover in the Command Center to a GX user_id' };
  }

  var pp = String(p.pp_start || '').trim();
  if (!pp) return { ok: false, error: 'pp_start required' };
  if (historyPeriods_().some(function (h) { return h.pp_start === pp; })) {
    return { ok: false, error: pp + ' is already a closed record and cannot be approved again' };
  }

  var live = fetchLivePerf_(pp);
  if (live.ok === false) return live;
  stampEmployeeIds_(live);
  var _open = incentiveBlockers_(live, false, false);
  if (_open.length) return { ok: false, error: _open[0].message };

  /* FOLD SPIFF IN BEFORE COMPUTING. This was missing until 2026-08-31: approval computed from
     `inputs` alone, so every person whose SPIFF was MEASURED rather than typed — which is the
     normal case, and the entire point of reading it from SPIFF — was frozen at 0. Nobody was paid
     wrongly (SPIFF cancels out of payroll, and the export carries payroll), but `crew_incentive_
     history` is what every later view reads and it is immutable. Ordered after the open-period
     refusal so a period that cannot be approved does not pay for a cross-app round trip. */
  applySpiffEarnings_(live, live.payPeriod.start);

  /* A FAILED SPIFF READ IS NOT AN EMPTY ONE, and approval is the one write that cannot be taken
     back. Same rule as the nightly Dutchie scan and the Core read behind the discount rules:
     freezing $0 for everybody because SPIFF was unreachable looks exactly like a fortnight in
     which no vendor money was earned, and there is no way to tell the two apart afterwards.
     `spiff_unavailable=yes` is the acknowledgement, not a bypass — it is recorded on every row it
     writes, so the record says the column is incomplete instead of quietly claiming zero. A
     successful read with no programs is NOT a failure and needs no acknowledgement. */
  var spiffFailed = !!(live.spiff && live.spiff.ok === false);
  var spiffAck = String(p.spiff_unavailable || '') === 'yes';
  var _blocked = incentiveBlockers_(live, spiffFailed, spiffAck);
  if (_blocked.length) {
    return { ok: false, error: _blocked[0].message + ' Fix the SPIFF connection and approve ' +
             'again, or re-send with spiff_unavailable=yes to approve without them and say so ' +
             'on the record.' };
  }

  var scheme = approvalThresholds_(live);
  if (!scheme.ok) return { ok: false, error: scheme.error };
  live.thresholds = scheme.T;                 // so freezeScheme_ records the one that was USED

  var T = scheme.T, inputs = inputsFor_(pp), rows = [];
  var now = new Date().toISOString();
  var by  = String(auth.user || '');
  var noteTxt = 'approved by ' + by + (spiffFailed ? ' — SPIFF unreadable, vendor amounts not included' : '');
  function push(section, r, c, extra) {
    rows.push([pp, String(live.payPeriod.end || ''), section, r.employee_id || '', r.name || '',
               r.storeName || '', r.storeSlug || '',
               extra.txn == null ? '' : extra.txn, extra.sales == null ? '' : extra.sales,
               extra.disc == null ? '' : extra.disc, extra.aov == null ? '' : extra.aov,
               c.spiff == null ? '' : c.spiff, c.bonus, c.hr,
               c.payroll == null ? c.bonus : c.payroll,
               noteTxt, 'approved', now]);
  }
  (live.budtenders || []).forEach(function (b) {
    push('budtender', b, incCalcBud_(b, T, inputs),
         { txn: b.txn, sales: b.sales, disc: b.discount * 100, aov: b.aov });
  });
  (live.managers || []).forEach(function (m) {
    push('manager', m, incCalcMgr_(m, T, inputs, live.budtenders || []),
         { txn: null, sales: m.sales, disc: m.discount * 100, aov: m.aov });
  });
  if (live.admin) {
    var ac = incCalcAdmin_(live.admin, T);
    push('admin', { employee_id: live.admin.employee_id, name: live.admin.name },
         { spiff: null, bonus: ac.bonus, hr: ac.hr, payroll: ac.bonus },
         { txn: null, sales: live.admin.actual, disc: null, aov: null });
  }

  var total = rows.reduce(function (a, r) { return a + (Number(r[14]) || 0); }, 0);
  /* Split the same three ways the screen's header does, so the approval email and the portal
     cannot disagree about where the money went — column 2 is the section, 14 the payroll. */
  function sectionTotal(name) {
    return Math.round(rows.reduce(function (a, r) {
      return a + (r[2] === name ? (Number(r[14]) || 0) : 0);
    }, 0) * 100) / 100;
  }
  var split = { manager: sectionTotal('manager'), budtender: sectionTotal('budtender'),
                admin: sectionTotal('admin') };
  /* The SPIFF column, stated in the dry run rather than only in the rows it writes. This is what
     `incentive_send` puts in front of the approver, and a vendor total of $0 is the symptom of
     every failure mode this fold has — an unreachable SPIFF, a join that matched nobody, a stale
     cache. Reporting it here is what makes it noticeable BEFORE the immutable write. */
  var spiffTotal = Math.round(rows.reduce(function (a, r) { return a + (Number(r[11]) || 0); }, 0) * 100) / 100;
  var spiffInfo = incentiveSpiffReport_(live, spiffFailed, spiffAck, spiffTotal);
  /* `lb_agrees: false` is not an error and does not block: the figures here are GX Core's, which is
     the authority. It means LEADERBOARD is grading the board against a different scheme from the one
     people are paid on — worth knowing, and invisible from either app on its own. */
  var schemeInfo = { source: scheme.source, leaderboard_agrees: scheme.lb_agrees };
  if (String(p.confirm || '') !== 'yes') {
    return { ok: true, dry_run: true, pp_start: pp, rows: rows.length, pp_end: live.payPeriod.end,
             payroll_total: Math.round(total * 100) / 100, split: split, spiff: spiffInfo,
             thresholds: schemeInfo,
             unmatched: live.unmatched || [], note: 'nothing written — re-send with confirm=yes' };
  }

  /* An approve link from the email carries a single-use token. It is checked against the period
     AND against the total that was sent: if anything moved between the email and the click, the
     link refuses and Sky goes and looks instead of approving a number he never saw. */
  var wf = wfGet_(pp);
  var tok = String(p.approve_token || '').trim();
  if (tok) {
    if (!wf || wf.status !== 'pending') return { ok: false, error: 'this period is no longer awaiting approval' };
    if (tok !== String(wf.token || '')) return { ok: false, error: 'that approval link is not valid any more' };
    if (wf.token_expires && new Date(wf.token_expires).getTime() < new Date().getTime()) {
      return { ok: false, error: 'that approval link has expired — open the period in Crew to approve it' };
    }
    if (Math.abs(Number(wf.sent_total || 0) - total) > 0.005) {
      return { ok: false, error: 'the figures have changed since that email was sent (was ' +
               wfMoney_(wf.sent_total) + ', now ' + wfMoney_(total) + ') — open it in Crew and review' };
    }
  }

  var sh = historySheet_();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HISTORY_HEADERS.length).setValues(rows);
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 2).setNumberFormat('@');   // dates stay TEXT
  freezeScheme_(pp, T, by);      // the rules these figures were produced by, kept with them
  wfSet_(pp, { status: 'approved', decided_by: by, decided_at: now, token: '', token_expires: '' });
  return { ok: true, pp_start: pp, written: rows.length, approved_by: by, approved_at: now,
           payroll_total: Math.round(total * 100) / 100, split: split, spiff: spiffInfo,
           thresholds: schemeInfo, unmatched: live.unmatched || [] };
}

/* ══ Approval — who prepares, who decides, and how a mistake gets undone ══════════════════════════
 *
 * Mike prepares a closed period; Sky approves it. Before this, anyone with edit rights approved
 * their own work and nobody was told, which is not an approval process — it is a button.
 *
 *     draft ──Mike sends──► pending ──Sky approves──► approved   (immutable, in history)
 *       ▲                      │
 *       └──Sky sends back──────┘  with a reason
 *
 * SENDING LOCKS THE INPUTS. Otherwise the numbers Sky approves are not necessarily the ones Mike
 * sent — an attendance tick between the email and the click would change what gets frozen, and
 * nothing would say so.
 *
 * SENDING BACK IS A FIRST-CLASS ACTION, not an escape hatch. Nothing has been written to history at
 * that point, so there is nothing to undo — which is the whole reason approval is the only thing
 * that writes. The reason and both timestamps stay on the period, so one that bounced twice shows
 * that it did.
 *
 * APPROVAL IS THE IRREVERSIBLE ONE, and `incentive_unapprove` is the break-glass Sky asked for. It
 * is DEPLOY-SECRET ONLY — not a button anywhere, because a screen that can un-pay people is a
 * screen where that happens by accident — and it VOIDS rather than deletes: every row it removes is
 * copied to crew_incentive_voided first, with who did it and why. Break glass, and there is glass
 * on the floor afterwards. */
var WF_TAB = 'crew_incentive_workflow';
var WF_HEADERS = ['pp_start', 'status', 'sent_by', 'sent_at', 'decided_by', 'decided_at',
                  'note', 'token', 'token_expires', 'sent_total'];
var VOID_TAB = 'crew_incentive_voided';

function wfSheet_() { return sheetOf_(WF_TAB, WF_HEADERS); }

function wfGet_(pp) {
  var rows = readTab_(WF_TAB, WF_HEADERS);
  for (var i = 0; i < rows.length; i++) if (rows[i].pp_start === pp) return rows[i];
  return null;
}

function wfSet_(pp, patch) {
  var sh = wfSheet_();
  var rows = readTab_(WF_TAB, WF_HEADERS);
  var idx = -1;
  for (var i = 0; i < rows.length; i++) if (rows[i].pp_start === pp) { idx = i; break; }
  var cur = idx >= 0 ? rows[idx] : { pp_start: pp, status: 'draft' };
  Object.keys(patch).forEach(function (k) { cur[k] = patch[k] == null ? '' : String(patch[k]); });
  var line = WF_HEADERS.map(function (h) { return cur[h] == null ? '' : cur[h]; });
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, WF_HEADERS.length).setValues([line]);
  else          sh.getRange(sh.getLastRow() + 1, 1, 1, WF_HEADERS.length).setValues([line]);
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).setNumberFormat('@');
  return cur;
}

/* WHO APPROVES — and why this is not a role check.
 *
 * The obvious answer was `role === 'owner'`, and it is wrong twice over. GX Core's role vocabulary
 * is viewer / editor / admin / director; there is no `owner`, so that check would have been false
 * for everybody and nothing could ever have been approved. And Crew is admin-only by design — Sky
 * and Mike hold the SAME grant — so no role can tell the approver from the preparer. That is the
 * exact situation Leaderboard solved with a hardcoded sky/mike allowlist in its source.
 *
 * So the approver is named in GX Core kv (`cfg.crewApprover`, a user_id or a comma-separated few).
 * That is a list, like Leaderboard's — but it is DATA Sky edits in the Command Center cockpit
 * rather than a constant that needs a deploy, which is the part that actually mattered.
 *
 * Unset, NOBODY can approve, and the screen says so. Failing closed is right here: the alternative
 * is a default that quietly lets the preparer approve their own work, which is the one outcome this
 * whole workflow exists to prevent. */
function approverIds_() {
  var raw = '';
  try { raw = String(GXCore.getKv('cfg.crewApprover') || ''); } catch (e) {}
  return raw.split(',').map(function (x) { return x.trim().toLowerCase(); })
            .filter(function (x) { return !!x; });
}
function canApprove_(auth) {
  var me = String((auth && auth.user) || '').trim().toLowerCase();
  if (!me) return false;
  return approverIds_().indexOf(me) >= 0;
}

/** Addresses for the approvers, from the same one source of truth. */
function wfApproverEmails_() {
  var want = approverIds_();
  if (!want.length) return [];
  var rows = rosterJoin_().rows || [];
  var out = [];
  rows.forEach(function (r) {
    var uid = String(r.user_id || '').trim().toLowerCase();
    if (!uid || want.indexOf(uid) < 0) return;
    out.push(accountEmail_(r));
  });
  /* A named approver with no roster row still gets mail — the convention that builds the address
     is the same one createAccounts_ used, and refusing to send because HR has not caught up is a
     worse failure than sending to an address that might bounce. */
  want.forEach(function (uid) {
    var addr = uid.indexOf('@') > 0 ? uid : uid + '@' + ACCOUNT_DOMAIN;
    if (out.indexOf(addr) < 0) out.push(addr);
  });
  return out.filter(function (e) { return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e); });
}

function wfMoney_(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

/* THE SPIFF REPORT THAT SITS IN FRONT OF AN APPROVER, built in exactly one place.
 *
 * Extracted 2026-08-31. The `preview=1` branch of incentive_send computed its own totals and never
 * called applySpiffEarnings_ at all, so the route whose entire job is "show me what approving this
 * would do" folded no vendor money and reported not one of these checks — no unmatched people, no
 * unpayable programs, no date conflicts. Its payroll figure was right, because SPIFF cancels out
 * of payroll on both sides, which is precisely why the gap was invisible: the number you check
 * agrees while everything you would check it AGAINST is missing.
 *
 * Two builders for "what would approval write" is the same shape of bug as the two bonus-math
 * implementations, minus the differential test that makes those safe. So there is one builder, and
 * both callers pass through it. */
function incentiveSpiffReport_(live, failed, ack, total) {
  var s = live.spiff || {};
  return { ok: !failed, error: s.error || '', acknowledged: !!(failed && ack),
           refreshed_at: s.refreshed_at || '',
           matched: s.matched || 0, unmatched: s.unmatched || [],
           /* Money deliberately NOT included — a program no single period owns. Listed
              here because this is the last screen before an immutable write. */
           straddling: s.straddling || [], not_payable: s.not_payable || [],
           matched_by: s.matched_by || {}, loose_dates: s.loose_dates || [],
           period_conflicts: s.period_conflicts || [], odd_status: s.odd_status || [],
           payout_date_pay_periods: s.payout_date_pay_periods || [],
           status_checked: !!s.status_checked, total: total };
}

/* WHAT WOULD STOP THIS PERIOD BEING APPROVED, as data rather than as an early return.
 *
 * incentiveApprove_ refuses on these and says why. The preview must not refuse — it writes nothing,
 * and it is deliberately allowed on an OPEN period so the email can be dry-run before the first
 * real fortnight closes — but it must SAY the same things, or "the preview looked fine" means
 * nothing. Same predicates, one list, two dispositions. */
function incentiveBlockers_(live, spiffFailed, spiffAck) {
  var out = [];
  if (live.payPeriod && live.payPeriod.current) {
    out.push({ code: 'period_open', message: 'this pay period is still open (' +
      live.payPeriod.start + ' → ' + live.payPeriod.end +
      '). Sales bonuses are not final until it ends.' });
  }
  if (spiffFailed && !spiffAck) {
    out.push({ code: 'spiff_unreadable', message: 'SPIFF could not be read (' +
      ((live.spiff && live.spiff.error) || 'unknown') + '), so vendor amounts would freeze at $0 ' +
      'for everyone and this record cannot be edited afterwards.' });
  }
  return out;
}

/**
 * ?action=incentive_send&pp_start=…  — Mike hands a closed period to Sky.
 * Computes it exactly as approval will, so the email says what approval would write.
 */
function incentiveSend_(p) {
  /* PREVIEW is deploy-secret so the email can be dry-run from a shell before the first real pay
     period closes — otherwise the first time anyone sees this email is the day it matters. It
     changes NO state, mints no token, and is allowed on an OPEN period, which the real send
     refuses. Everything else runs identically: the body comes from the same builder, because a
     preview that renders different HTML tests nothing. */
  var preview = isTruthyFlag_(p.preview || '');
  var auth;
  if (preview && deploySecretOk_(p)) auth = { ok: true, user: String(p.as || 'preview'), role: 'admin' };
  else {
    auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
    if (!canEdit_(auth)) return { ok: false, error: 'read-only' };
  }
  var pp = String(p.pp_start || '').trim();
  if (!pp) return { ok: false, error: 'pp_start required' };
  if (!preview) {
    if (historyPeriods_().some(function (h) { return h.pp_start === pp; })) {
      return { ok: false, error: pp + ' is already a closed record' };
    }
    var wfPrev = wfGet_(pp);
    if (wfPrev && wfPrev.status === 'pending') {
      return { ok: false, error: 'already sent for approval on ' + wfPrev.sent_at + ' by ' + wfPrev.sent_by };
    }
  }

  var pre;
  if (preview) {
    /* incentiveApprove_ refuses an open period, which is correct for approving and useless for
       previewing. Compute the same figures directly instead of loosening that guard. */
    var live = fetchLivePerf_(pp);
    if (live.ok === false) return live;
    stampEmployeeIds_(live);
    /* GX Core's scheme, the same one incentiveApprove_ will use. A preview computed against
       Leaderboard's copy would show a total the approval then does not produce. */
    var _sch = approvalThresholds_(live);
    if (!_sch.ok) return { ok: false, error: _sch.error };
    /* FOLD SPIFF, exactly as approval does. Omitting this was the whole bug: the preview reported
       no vendor money and none of the checks, while its payroll total agreed with approval's —
       because SPIFF cancels out of payroll. A dry run that is only right about the number nobody
       doubted is worse than none, because it is trusted. */
    var _spiffFailed = false, _spiffTotal = 0;
    var _ack = String(p.spiff_unavailable || '') === 'yes';
    applySpiffEarnings_(live, (live.payPeriod || {}).start || pp);
    _spiffFailed = !!(live.spiff && live.spiff.ok === false);

    var T = _sch.T, inputs = inputsFor_(pp), n = 0;
    var sp = { budtender: 0, manager: 0, admin: 0 };
    (live.budtenders || []).forEach(function (b) {
      var c = incCalcBud_(b, T, inputs); sp.budtender += c.payroll || 0;
      _spiffTotal += Number(c.spiff) || 0; n++;
    });
    (live.managers || []).forEach(function (m) {
      var c = incCalcMgr_(m, T, inputs, live.budtenders || []);
      sp.manager += c.payroll || 0; _spiffTotal += Number(c.spiff) || 0; n++;
    });
    if (live.admin) { sp.admin += incCalcAdmin_(live.admin, T).bonus || 0; n++; }
    Object.keys(sp).forEach(function (k) { sp[k] = Math.round(sp[k] * 100) / 100; });
    _spiffTotal = Math.round(_spiffTotal * 100) / 100;
    /* The blockers are REPORTED, not enforced: the preview writes nothing, and it is deliberately
       allowed on an open period. `would_block` is empty for a period approval would accept. */
    pre = { ok: true, rows: n, payroll_total: Math.round((sp.budtender + sp.manager + sp.admin) * 100) / 100,
            split: sp, pp_end: (live.payPeriod || {}).end || '', unmatched: live.unmatched || [],
            still_open: !!(live.payPeriod || {}).current,
            spiff: incentiveSpiffReport_(live, _spiffFailed, _ack, _spiffTotal),
            thresholds: { source: _sch.source, leaderboard_agrees: _sch.lb_agrees },
            would_block: incentiveBlockers_(live, _spiffFailed, _ack) };
  } else {
    pre = incentiveApprove_({ token: p.token, pp_start: pp });   // dry — validates + totals
    if (pre.ok === false) return pre;
  }

  /* Single-use, 72 hours, and bound to the TOTAL that was sent. If anything about the period
     changes after the email goes out, the link refuses and sends Sky into the app to look —
     a standing key to payroll in an inbox is the thing to avoid, not the click. */
  var token = preview ? 'PREVIEW' : Utilities.getUuid().replace(/-/g, '');
  var expires = new Date(new Date().getTime() + 72 * 3600 * 1000).toISOString();
  if (!preview) {
    wfSet_(pp, { status: 'pending', sent_by: auth.user || '', sent_at: new Date().toISOString(),
                 decided_by: '', decided_at: '', note: '', token: token, token_expires: expires,
                 sent_total: String(pre.payroll_total) });
  }

  var html = wfApprovalEmail_(pp, pre, auth.user || 'a manager', token, preview);
  var to = preview
    ? String(p.to || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
    : wfApproverEmails_();
  /* The preview echoes the SAME blocks the approval dry run returns. Returning only totals is what
     made this route quietly useless: it could not have told anyone that vendor money was missing,
     that a program was unpayable, or that the period was still open. */
  if (preview && !to.length) return { ok: true, preview: true, pp_start: pp, rows: pre.rows,
                                      payroll_total: pre.payroll_total, split: pre.split,
                                      still_open: !!pre.still_open,
                                      spiff: pre.spiff, thresholds: pre.thresholds,
                                      would_block: pre.would_block || [],
                                      unmatched: pre.unmatched || [],
                                      to: wfApproverEmails_(), html: html,
                                      note: 'nothing sent — add &to=someone@… to actually mail it' };

  var mailed = [];
  if (to.length) {
    try {
      MailApp.sendEmail({ to: to.join(','), name: 'GX Crew', htmlBody: html,
        subject: (preview ? '[PREVIEW] ' : '') + 'Approve incentive — ' + pp });
      mailed = to;
    } catch (e) {
      /* The state is already `pending`, which is correct — it WAS sent for approval. Report the
         mail failure rather than throwing, so the sender learns to nudge in person instead of
         believing an email went out. */
      return { ok: true, pp_start: pp, status: preview ? 'preview' : 'pending', rows: pre.rows,
               payroll_total: pre.payroll_total, mailed: [],
               warning: 'the email failed: ' + String((e && e.message) || e) };
    }
  }
  /* The split is echoed back, not just put in the email: a send that reports only a total cannot
     be checked against the screen without opening the mail, and the whole reason it is in the
     email is that the two must agree. */
  return { ok: true, preview: preview || undefined, pp_start: pp,
           status: preview ? 'preview' : 'pending', rows: pre.rows,
           payroll_total: pre.payroll_total, split: pre.split, mailed: mailed,
           still_open: !!pre.still_open,
           warning: mailed.length ? '' : 'no approver is configured (cfg.crewApprover) — nobody was emailed' };
}

/* ONE builder for the real email and the preview. Two would drift, and the drift would only show
 * up on the day it mattered. */
function wfApprovalEmail_(pp, pre, sender, token, preview) {
  var link = CREW_URL + '#incentive/' + encodeURIComponent(pp);
  var approveLink = CREW_URL + '#approve/' + encodeURIComponent(pp) + '/' + token;
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
    (preview ? '<p style="background:#fde68a;color:#4a3208;padding:8px 12px;border-radius:6px;' +
       'margin:0 0 16px;font-size:13px"><strong>Preview.</strong> Nothing was sent for approval and ' +
       'the button below will not approve anything' +
       (pre.still_open ? ' — this pay period is still open, so these figures are not final.' : '.') +
       '</p>' : '') +
    '<h2 style="margin:0 0 4px">Incentive ready for approval</h2>' +
    '<p style="margin:0 0 16px;color:#555">Pay period <strong>' + pp + ' → ' +
      (pre.pp_end || '') + '</strong>, prepared by ' + sender + '.</p>' +
    /* The same breakdown, in the same order, as the header of the screen this links to. Reading
       one figure in the email and four on the page invites a decision made on a number that was
       never compared — and the split is where a wrong SPIFF or a missed attendance shows up. */
    (function () {
      var sp = pre.split || {};
      function row(label, v, strong) {
        return '<tr><td style="padding:5px 22px 5px 0;color:#555' +
          (strong ? ';border-top:1px solid #ddd;padding-top:9px' : '') + '">' + label + '</td>' +
          '<td style="text-align:right;font-weight:700;font-size:' + (strong ? '17px' : '15px') +
          (strong ? ';border-top:1px solid #ddd;padding-top:9px' : '') + '">' + wfMoney_(v) + '</td></tr>';
      }
      return '<table style="border-collapse:collapse;margin-bottom:18px">' +
        row('Manager bonuses', sp.manager || 0) +
        row('Budtender bonuses', sp.budtender || 0) +
        row('Admin', sp.admin || 0) +
        row('Total', pre.payroll_total, true) +
        '<tr><td style="padding:9px 22px 0 0;color:#555">People</td>' +
          '<td style="text-align:right;padding-top:9px">' + pre.rows + '</td></tr>' +
        (pre.unmatched && pre.unmatched.length
          ? '<tr><td style="padding:5px 22px 0 0;color:#a33">Not on the roster</td>' +
            '<td style="text-align:right;color:#a33">' + pre.unmatched.join(', ') + '</td></tr>' : '') +
        '</table>';
    })() +
    '<p style="margin:0 0 8px"><a href="' + approveLink + '" style="background:#22c55e;color:#04210f;' +
      'padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:700">Approve</a>' +
      '&nbsp;&nbsp;<a href="' + link + '" style="color:#0a7a3d">Open in GX Crew to review</a></p>' +
    '<p style="color:#777;font-size:12px;margin:14px 0 0">Approving freezes these figures as the ' +
      'record of what was paid. If something needs fixing, open it in Crew and send it back to ' +
      sender + ' with a note. This link works once and expires in 72 hours.</p>' +
    '</div>';
}

/** ?action=incentive_return&pp_start=…&note=…  — Sky sends it back for a fix. */
function incentiveReturn_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  if (!canApprove_(auth)) return { ok: false, error: 'only the named approver can send a period back' };
  var pp = String(p.pp_start || '').trim();
  var note = String(p.note || '').trim();
  if (!pp) return { ok: false, error: 'pp_start required' };
  /* A reason is required. "Sent back" with no note is a period that bounces again for the same
     thing, and the person fixing it has to guess what was wrong. */
  if (!note) return { ok: false, error: 'a reason is required — it is what the sender has to work from' };
  var wf = wfGet_(pp);
  if (!wf || wf.status !== 'pending') {
    return { ok: false, error: pp + ' is not awaiting approval' };
  }
  wfSet_(pp, { status: 'draft', decided_by: auth.user || '', decided_at: new Date().toISOString(),
               note: note, token: '', token_expires: '' });

  var rows = rosterJoin_().rows || [];
  var sender = null;
  rows.forEach(function (r) { if (String(r.user_id || '') === wf.sent_by) sender = r; });
  var to = sender ? accountEmail_(sender) : '';
  if (to) {
    try {
      MailApp.sendEmail({ to: to, subject: 'Incentive ' + pp + ' sent back', name: 'GX Crew',
        htmlBody: '<div style="font-family:system-ui,sans-serif;max-width:520px">' +
          '<h2 style="margin:0 0 4px">Sent back for a fix</h2>' +
          '<p style="margin:0 0 12px;color:#555">Pay period <strong>' + pp + '</strong>, returned by ' +
            (auth.user || 'the owner') + '.</p>' +
          '<blockquote style="margin:0 0 16px;padding:10px 14px;background:#f5f5f5;' +
            'border-left:3px solid #999">' + note.replace(/</g, '&lt;') + '</blockquote>' +
          '<p><a href="' + CREW_URL + '#incentive/' + encodeURIComponent(pp) + '">Open in GX Crew</a>' +
          '</p><p style="color:#777;font-size:12px">It is editable again. Nothing was written to the ' +
          'payroll record.</p></div>' });
    } catch (e) { /* the state change is what matters; a failed nudge is not a failed return */ }
  }
  return { ok: true, pp_start: pp, status: 'draft', returned_to: wf.sent_by, note: note, mailed: to };
}

/**
 * ?action=incentive_unapprove&pp_start=…&reason=…&secret=…&confirm=yes
 *
 * THE BREAK GLASS. Deploy-secret only and deliberately not wired to any button: a screen that can
 * un-pay people is a screen where that eventually happens by accident.
 *
 * VOIDS, never deletes. Every row is copied to crew_incentive_voided with who did it and why,
 * before it leaves history — so the period can be rebuilt, and so an approved figure that somebody
 * removed leaves a trace rather than a gap. A `reason` is required for the same purpose.
 */
function incentiveUnapprove_(p) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var pp = String(p.pp_start || '').trim();
  var reason = String(p.reason || '').trim();
  if (!pp) return { ok: false, error: 'pp_start required' };
  if (!reason) return { ok: false, error: 'reason required — voiding a paid period must say why' };

  var sh = historySheet_();
  var all = sh.getDataRange().getValues();
  var hit = [];
  for (var i = 1; i < all.length; i++) if (String(all[i][0]) === pp) hit.push(i);
  if (!hit.length) return { ok: false, error: 'no approved or imported history for ' + pp };

  var total = hit.reduce(function (a, i) { return a + (Number(all[i][14]) || 0); }, 0);
  if (String(p.confirm || '') !== 'yes') {
    return { ok: true, dry_run: true, pp_start: pp, rows: hit.length,
             payroll_total: Math.round(total * 100) / 100,
             note: 'nothing voided — re-send with confirm=yes' };
  }

  var now = new Date().toISOString();
  var vh = VOID_HEADERS();
  var vsh = sheetOf_(VOID_TAB, vh);
  var copies = hit.map(function (i) { return all[i].concat([now, reason]); });
  vsh.getRange(vsh.getLastRow() + 1, 1, copies.length, vh.length).setValues(copies);
  /* Bottom-up: deleting top-down shifts every row beneath and walks off its own indices. */
  for (var j = hit.length - 1; j >= 0; j--) sh.deleteRow(hit[j] + 1);

  wfSet_(pp, { status: 'draft', decided_by: '', decided_at: '', note: 'VOIDED: ' + reason,
               token: '', token_expires: '' });
  return { ok: true, pp_start: pp, voided: copies.length,
           payroll_total: Math.round(total * 100) / 100, reason: reason,
           note: 'copied to ' + VOID_TAB + ' — the period is editable again' };
}
function VOID_HEADERS() { return HISTORY_HEADERS.concat(['voided_at', 'void_reason']); }

/* ══ Thresholds — GX Core holds them, Crew edits them ════════════════════════════════════════════
 *
 * They were a Leaderboard ScriptProperty, which was wrong twice: compensation policy is not the
 * kiosk's, and LEADERBOARD'S OWN DISCOUNT COLORING reads budtender.discountMaxPct to decide what
 * counts as a good discount rate on the board every staff member sees. Two copies of that number
 * means the board grades people against a goal nobody set on it.
 *
 * So they live in GX Core kv (`incentiveThresholds`) — deliberately NOT a `cfg.` key, because that
 * prefix is public on ?action=config and comp policy should not be readable by anyone with the URL.
 * Crew writes; Leaderboard and Crew both read.
 */
/* Structural equality without JSON.stringify, whose key ORDER is significant — Leaderboard's payload
 * and Core's parsed value hold the same numbers in whatever order each JSON happened to serialize,
 * and a false "these disagree" sends somebody hunting a difference that is not there. */
function deepSame_(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !deepSame_(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}

/* THE SCHEME AN APPROVAL IS COMPUTED AGAINST, and it is GX Core's — never the copy Leaderboard sent.
 *
 * `getIncentive_` has always overridden `live.thresholds` with this; `incentiveApprove_` and the
 * send preview did not, until 2026-08-31. So the screen scored against GX Core and the immutable
 * record scored against whatever Leaderboard happened to hand over. They agree while LB's own read
 * of Core succeeds — but LB falls back to its local ScriptProperty and then to its DEFAULTS when
 * Core is unreachable, which is exactly the moment the two silently diverge. Unlike SPIFF, this
 * moves PAYROLL: a threshold that differs by a tenth of a point flips whole bonuses.
 *
 * NO FALLBACK AND NO OVERRIDE HERE, deliberately. Displaying LB's copy is a reasonable degradation
 * — the board keeps scoring as it did. Freezing payroll against a scheme GX Core cannot confirm is
 * not, and it cannot be edited afterwards. Refusing costs a minute in the settings tray; the other
 * way costs a fortnight of wrong bonuses nobody can tell from right ones. */
function approvalThresholds_(live) {
  var coreRes = incentiveThresholds_();
  if (!coreRes.ok) {
    /* Carries the SPECIFIC reason now — not set, unreadable, malformed, or missing a tier — rather
       than one message for four different problems, each with a different fix. */
    return { ok: false, error: 'GX Core holds no usable incentive thresholds: ' + coreRes.error +
             '. Approving would freeze payroll against a scheme Core cannot confirm. Open the ' +
             'Incentive settings tray, save the thresholds, and approve again.' };
  }
  var core = coreRes.thresholds;
  return { ok: true, T: core, source: 'gx_core',
           lb_agrees: deepSame_(live.thresholds || null, core) };
}

/* GX CORE HOLDS THE THRESHOLDS, AND THERE IS NOTHING BEHIND THEM.
 *
 * This returned null on any failure and the caller fell back to "whatever Leaderboard sent" — which
 * worked only while Leaderboard was also sending them. GX Core's engine does not, deliberately:
 * Crew owns compensation and reads the scheme from kv, so a second copy traveling in the payload
 * is exactly the drift the move was meant to end.
 *
 * So the fallback is gone, and the failure is loud. Silently computing a bonus against a MISSING
 * scheme is the worst available outcome: calcBud would read undefined tiers, every bonus would come
 * out zero, and a payroll of zeros looks exactly like a fortnight in which nobody earned anything.
 * The screen showing an error instead is strictly better — it is wrong in a way somebody notices.
 *
 * Returns { ok, thresholds, error } rather than a bare value, so the caller cannot mistake a
 * failure for an empty scheme. */
function incentiveThresholds_() {
  var complete = function (t) { return !!(t && t.budtender && t.manager && t.admin); };
  var raw = null;
  try { raw = GXCore.getKv('incentiveThresholds'); }
  catch (e) {
    return { ok: false, thresholds: null,
             error: 'could not read incentiveThresholds from GX Core: ' + String((e && e.message) || e) };
  }
  if (!raw) return { ok: false, thresholds: null, error: 'GX Core kv incentiveThresholds is not set' };
  var t = null;
  try { t = JSON.parse(raw); }
  catch (e) { return { ok: false, thresholds: null, error: 'incentiveThresholds is not valid JSON' }; }
  if (!complete(t)) {
    return { ok: false, thresholds: null,
             error: 'incentiveThresholds is incomplete — needs budtender, manager and admin; has: '
                  + Object.keys(t || {}).sort().join(', ') };
  }
  return { ok: true, thresholds: t, error: '' };
}

/* ══ Discount rules — GX Core holds the STATE, Leaderboard still supplies the NAMES ═════════════
 *
 * Which discretionary discounts count against a budtender is a pay-affecting setting, so it lives
 * in GX Core kv (`discountRules`) beside `incentiveThresholds` — same reason, same shape of
 * ownership: comp policy is not the kiosk's ScriptProperty. Deliberately NOT a `cfg.` key, because
 * that prefix is public on ?action=config.
 *
 *   { "overrides": { "<discount name>": true } }        true = EXCLUDED, i.e. does NOT count
 *
 * Byte-identical to the shape Leaderboard's GC_DISCOUNT_EXCL_JSON has always used, so the value is
 * portable between them and neither side has to translate.
 *
 * THE NAME LIST DID NOT MOVE AND CANNOT. `discretionary` is derived from Leaderboard's discount
 * REGISTRY — a union of Dutchie's /reporting/discounts across every store, classified into
 * automatic / loyalty / discretionary. GX Core has no discount data of any kind and no Dutchie
 * credentials, and the registry is downstream of the transaction ingest that is staying in
 * Leaderboard. So Core knows the three names somebody has an OPINION about; it does not know the
 * forty that exist. Rendering the tray from Core alone would show three unchecked boxes and no way
 * to switch a fourth discount off.
 *
 * Hence the split, and it is the honest description of this route: the WRITE hop to Leaderboard is
 * gone, the READ hop for names is not. What each side is authoritative for:
 *
 *   Leaderboard  →  which discretionary discounts EXIST (name, code, method) + the locked
 *                   loyalty/automatic groups.  Read-only, best effort.
 *   GX Core      →  whether each one counts.  Authoritative. If Leaderboard's payload disagrees
 *                   with Core about `excluded`, Core wins — we never read LB's flags.
 *
 * When Leaderboard is unreachable the tray degrades to the names Core already holds an override
 * for, flagged `partial`, rather than showing nothing. That list is short and incomplete, which is
 * why it says so.
 */
var DISCOUNT_RULES_KV = 'discountRules';

/**
 * The authoritative overrides, from GX Core.
 *
 * The distinction between ABSENT and UNREADABLE is load-bearing, which is why this returns a
 * result rather than a map. Absent legitimately means "nothing is excluded". Unreadable means we
 * do not know — and the save path is a read-merge-write, so merging onto a `{}` that was really a
 * failed read would silently switch three discount rules back on and pay people differently.
 * Unreadable therefore refuses rather than defaults.
 */
function discountRules_() {
  var raw;
  try { raw = GXCore.getKv(DISCOUNT_RULES_KV); }
  catch (e) {
    return { ok: false, error: 'could not read discountRules from GX Core: ' + String((e && e.message) || e) };
  }
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, overrides: {}, present: false };
  var d;
  try { d = JSON.parse(s); }
  catch (e) { return { ok: false, error: 'discountRules in GX Core kv is not valid JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d) ||
      (d.overrides != null && (typeof d.overrides !== 'object' || Array.isArray(d.overrides)))) {
    return { ok: false, error: 'discountRules in GX Core kv is not { overrides: { name: bool } }' };
  }
  return { ok: true, overrides: d.overrides || {}, present: true };
}

/**
 * The discount NAMES, from Leaderboard's registry. Read-only, and its `excluded` flags are
 * deliberately DISCARDED — that is Core's answer now, and reading LB's copy is how the two would
 * drift back apart without anybody noticing.
 */
function discountRegistry_() {
  var base = '';
  try { base = String(GXCore.getKv('lbGoals') || ''); } catch (e) {}
  if (!base) return { ok: false, error: 'no Leaderboard engine URL in GX Core kv (key lbGoals)' };
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on the Crew script' };
  var url = base + '?action=discountrules&secret=' + encodeURIComponent(secret);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) {
      return { ok: false, error: 'Leaderboard returned HTTP ' + res.getResponseCode() };
    }
    var d = JSON.parse(res.getContentText());
    if (!d || d.ok === false) return { ok: false, error: (d && d.error) || 'Leaderboard refused' };
    return {
      ok: true,
      names: (d.discretionary || []).map(function (x) {
        return { name: String(x.name || ''), code: x.code || '', method: x.method || '' };
      }).filter(function (x) { return !!x.name; }),
      autoExcluded: d.autoExcluded || { automatic: [], loyalty: [] },
      counts: d.counts || { automatic: 0, loyalty: 0, discretionary: 0 },
      builtAt: d.builtAt || null
    };
  } catch (e) {
    return { ok: false, error: 'could not reach Leaderboard: ' + String((e && e.message) || e) };
  }
}

/**
 * ?action=incentive_discounts                    read
 * ?action=incentive_discounts&count=…&off=…      write (approver only)
 *
 * `count` and `off` are NEWLINE-separated name lists — newline because the names themselves
 * contain commas ("5 for $20 Gummies, same strain only"). They carry only what CHANGED, and they
 * are stated in the browser's own vocabulary: `count` means these now count, `off` means these
 * now do not. The inversion to the stored `excluded` boolean happens here and only here — a UI
 * that posted "excluded" while its checkboxes read "counted" is one flipped boolean away from
 * grading every budtender against the opposite rule, and nothing about the result would look wrong.
 *
 * Changed-only, rather than the old "send every name": the write is a read-merge-write over Core's
 * current map, so an unsent name keeps its value — which is exactly what the screen was showing,
 * because the screen was rendered from that same map. It also means a rule somebody else changed
 * while this tray sat open survives instead of being silently reverted, and it keeps the URL short
 * enough that a forty-name registry cannot overflow a JSONP GET.
 */
function incentiveDiscountsRoute_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  /* The old wire format was `save=<every counted name>`, with absence meaning excluded. Under the
     new merge that would set the checked ones and never set anything back to excluded — unticking
     a box would appear to work and change nothing. So a stale page is refused, loudly, instead of
     being half-honored. */
  if (p.save != null) {
    return { ok: false, error: 'this page is out of date — hard-reload GX Crew and set the discount rules again' };
  }

  var writing = (p.count != null || p.off != null);
  if (!writing) return incentiveDiscountsPayload_(auth);

  /* Editing the scheme is the approver's call, not any editor's. Mike prepares a period; he does
     not move the bar people are measured against. */
  if (!canApprove_(auth)) return { ok: false, error: 'only the approver can change the discount rules' };

  /* Splits on a real newline OR the two-character sequence \n. The second alternative is not
     tidiness: the browser sent `join('\\n')` for its entire life, so nothing ever split, the whole
     list arrived as one string, and the old inversion wrote EXCLUDED for every discretionary
     discount — which pays the discount bonus to everybody. The client is fixed; this makes the
     same typo inert rather than pay-affecting if it is ever reintroduced. */
  var lines = function (v) {
    return String(v == null ? '' : v).split(/\r?\n|\\n/)
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return !!x; });
  };
  var count = lines(p.count), off = lines(p.off);
  if (!count.length && !off.length) {
    return { ok: false, error: 'nothing to save — no discount names were sent' };
  }
  var clash = count.filter(function (n) { return off.indexOf(n) >= 0; });
  if (clash.length) {
    return { ok: false, error: 'the same discount was sent as both counted and not counted: ' + clash.join(', ') };
  }

  var cur = discountRules_();
  if (!cur.ok) return cur;                       // never merge onto a state we could not read

  var before = {}, overrides = {};
  Object.keys(cur.overrides).forEach(function (k) {
    before[k] = !!cur.overrides[k]; overrides[k] = !!cur.overrides[k];
  });
  count.forEach(function (n) { overrides[n] = false; });   // counts against the budtender
  off.forEach(function (n) { overrides[n] = true; });      // excluded from the basis

  var changed = [];
  Object.keys(overrides).forEach(function (k) {
    if (!!before[k] !== !!overrides[k]) {
      changed.push(k + ': ' + (before[k] ? 'not counted' : 'counted') +
                   ' → ' + (overrides[k] ? 'not counted' : 'counted'));
    }
  });

  var w = gxSetKvViaWeb_(DISCOUNT_RULES_KV, JSON.stringify({ overrides: overrides }),
    'Incentive: discretionary discounts that do NOT count against a budtender (true = excluded). Written by GX Crew.');
  if (w && w.ok === false) return w;

  /* Same audit line the thresholds get, for the same reason: this decides what everybody earns and
     the kv tab keeps no history. Non-fatal — the money number is already stored by this point and a
     failed note must not block a legitimate comp change — but never DISCARDED. The thresholds' note
     called a function name no library version has ever had and wrote nothing for its entire life,
     and what hid that was the silence, not the typo. So the reason is logged and echoed back. */
  var auditErr = '';
  try {
    var note = GXCore.gxAddNote('crew', 'core-admin',
      'Incentive discount rules changed by ' + (auth.user || '?'),
      (changed.length ? changed.join('\n') : '(no effective change)') +
      '\n\nfull map after: ' + JSON.stringify(overrides), '', 'fyi');
    if (note && note.ok === false) auditErr = String(note.error || 'GX Core refused the note');
  } catch (e) {
    auditErr = String((e && e.message) || e);
  }
  if (auditErr) {
    Logger.log('incentive_discounts: the audit note FAILED and the rules were saved anyway — ' + auditErr);
  }

  var out = incentiveDiscountsPayload_(auth);
  out.saved_by = auth.user || '';
  out.changed = changed;
  if (auditErr) out.audit_error = auditErr;
  return out;
}

/** State from GX Core, names from Leaderboard, and it says which parts it actually got. */
function incentiveDiscountsPayload_(auth) {
  var rules = discountRules_();
  if (!rules.ok) return rules;
  var reg = discountRegistry_();

  var discretionary, partial = false, warning = '';
  if (reg.ok) {
    discretionary = reg.names.map(function (x) {
      return { name: x.name, code: x.code, method: x.method, excluded: !!rules.overrides[x.name] };
    });
  } else {
    /* No registry: show what Core knows an opinion about rather than nothing. Short and incomplete
       — a discount nobody has ever toggled is missing entirely — so the tray says so. Saving still
       works and is still safe, because the merge only touches the names that were on screen. */
    partial = true;
    warning = 'Leaderboard is unreachable, so this is only the discounts a rule has already been ' +
              'set for — not the full list. ' + reg.error;
    discretionary = Object.keys(rules.overrides).sort().map(function (n) {
      return { name: n, code: '', method: '', excluded: !!rules.overrides[n] };
    });
  }

  if (!rules.present && !warning) {
    warning = 'GX Core has no discountRules key yet, so every discretionary discount is shown as ' +
              'counted. Save once to write the rules.';
  }

  return {
    ok: true,
    source: 'gx-core',
    discretionary: discretionary,
    autoExcluded: reg.ok ? reg.autoExcluded : { automatic: [], loyalty: [] },
    counts: reg.ok ? reg.counts : { automatic: 0, loyalty: 0, discretionary: discretionary.length },
    builtAt: reg.ok ? reg.builtAt : null,
    partial: partial,
    warning: warning,
    can_edit: canApprove_(auth)
  };
}

/**
 * ?action=incentive_thresholds            read
 * ?action=incentive_thresholds&save=…     write (approver only)
 *
 * WRITES THE WHOLE OBJECT, and validates it first. A partial write here is not a blanked column,
 * it is a bonus scheme with a missing tier — and the failure would land on the next payroll rather
 * than on the person who typed it.
 */
function incentiveThresholdsRoute_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var raw = p.save == null ? '' : String(p.save);
  if (!raw) {
    var cur = incentiveThresholds_();
    return { ok: cur.ok, thresholds: cur.thresholds, error: cur.error,
             can_edit: canApprove_(auth), source: 'gx-core' };
  }
  /* Editing the scheme is the approver's call, not any editor's. Mike prepares a period; he does
     not move the bar people are measured against. */
  if (!canApprove_(auth)) return { ok: false, error: 'only the approver can change the thresholds' };

  var t;
  try { t = JSON.parse(raw); } catch (e) { return { ok: false, error: 'thresholds are not valid JSON' }; }
  var bad = thresholdProblems_(t);
  if (bad.length) return { ok: false, error: 'rejected: ' + bad.join('; ') };

  var beforeRes = incentiveThresholds_();
  var before = beforeRes.ok ? beforeRes.thresholds : null;   // unreadable != empty; the audit says which
  /* THE `GXCore.setKv` BRANCH HAS NEVER RUN. The library exposes `getKv` but no kv WRITER to bound
     callers — not at the v225 pin, not at HEAD — so the guard is always false and the secret-gated
     web route below is the only path this write has ever taken. The guard is correct and stays:
     it is the right shape for the day Core does expose one. It is noted because a reader otherwise
     assumes the two branches share the traffic, and debugs the one that does nothing. */
  var r = GXCore.setKv ? GXCore.setKv('incentiveThresholds', JSON.stringify(t))
                       : gxSetThresholdsViaWeb_(JSON.stringify(t));
  if (r && r.ok === false) return r;

  /* An audit line, because this changes what everybody earns and the kv tab keeps no history.
   *
   * THE FUNCTION IS `gxAddNote`. This said `GXCore.addNote` from the day it was written, and no
   * library version has ever had that name — so every save threw a TypeError straight into the
   * bare `catch (e) {}` below, the threshold write itself succeeded through the web route, the
   * screen reported saved, and the audit line this comment promises was never once written. For
   * the setting that decides what every employee earns.
   *
   * The catch stays NON-FATAL — a failed note must not block a legitimate comp change, the money
   * number is already stored by this point — but it no longer DISCARDS. What hid this for its
   * entire life was the silence, not the typo, and the next failure here would hide identically.
   * So the reason is logged and echoed back as `audit_error`; a refusal (gxAddNote answers
   * `{ok:false}` for an address nobody reads) counts as a failure too, since it writes no note
   * and throws nothing. */
  var auditErr = '';
  try {
    var note = GXCore.gxAddNote('crew', 'core-admin',
      'Incentive thresholds changed by ' + (auth.user || '?'),
      'before: ' + JSON.stringify(before) + '\nafter: ' + JSON.stringify(t), '', 'fyi');
    if (note && note.ok === false) auditErr = String(note.error || 'GX Core refused the note');
  } catch (e) {
    auditErr = String((e && e.message) || e);
  }
  if (auditErr) {
    Logger.log('incentive_thresholds: the audit note FAILED and the thresholds were saved anyway — ' +
               auditErr);
  }
  return { ok: true, thresholds: t, saved_by: auth.user || '', audit_error: auditErr };
}

/* GXCore exposes no kv WRITER to bound libraries; the secret-gated web route is the only path.
 *
 * ONE writer for both comp settings. `set_config` replaces the whole kv row, `notes` included, so
 * an omitted note blanks the cell — pass a describing one rather than nothing. */
function gxSetKvViaWeb_(key, json, notes) {
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on the Crew script' };
  var url = GXCORE_URL + '?action=set_config&key=' + encodeURIComponent(key) +
            '&secret=' + encodeURIComponent(secret) + '&value=' + encodeURIComponent(json) +
            (notes ? '&notes=' + encodeURIComponent(notes) : '');
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var d = JSON.parse(res.getContentText());
    if (!d || d.ok === false) return { ok: false, error: (d && d.error) || 'GX Core refused the write' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'could not write to GX Core: ' + String((e && e.message) || e) };
  }
}
function gxSetThresholdsViaWeb_(json) { return gxSetKvViaWeb_('incentiveThresholds', json, ''); }

/* Every rule here is one whose absence pays somebody the wrong amount rather than erroring. */
function thresholdProblems_(t) {
  var bad = [];
  function num(v) { return typeof v === 'number' && isFinite(v); }
  if (!t || typeof t !== 'object') return ['not an object'];
  if (!num(t.hoursPerPeriod) || t.hoursPerPeriod <= 0) bad.push('hoursPerPeriod must be a positive number');
  var b = t.budtender || {}, m = t.manager || {}, a = t.admin || {};
  ['txnQualify', 'txnQualifyLowVol', 'aovTarget', 'aovBonus', 'discountMaxPct', 'discountBonus',
   'attendanceBonus'].forEach(function (k) { if (!num(b[k])) bad.push('budtender.' + k + ' must be a number'); });
  if (!Array.isArray(b.lowVolStores)) bad.push('budtender.lowVolStores must be a list');
  ['aovTarget', 'aovBonus', 'teamAttendancePerHead'].forEach(function (k) {
    if (!num(m[k])) bad.push('manager.' + k + ' must be a number');
  });
  if (!num(a.maxPerStore)) bad.push('admin.maxPerStore must be a number');
  /* Tiers are matched HIGH TO LOW with a break on the first hit, so an ascending list silently pays
     everyone the lowest tier they clear instead of the highest. Nothing else would catch it. */
  function tiers(list, label, key) {
    if (!Array.isArray(list) || !list.length) { bad.push(label + ' must be a non-empty list'); return; }
    for (var i = 0; i < list.length; i++) {
      if (!num(list[i][key]) || !num(list[i].bonus)) { bad.push(label + '[' + i + '] needs ' + key + ' and bonus'); return; }
      if (i && list[i][key] > list[i - 1][key]) bad.push(label + ' must run highest-first — ' +
        list[i][key] + ' comes after ' + list[i - 1][key] + ', so everyone would be paid the lowest tier they clear');
    }
  }
  tiers(m.salesTiers, 'manager.salesTiers', 'pct');
  tiers(a.tiers, 'admin.tiers', 'pct');
  if (!Array.isArray(m.discountTiers) || m.discountTiers.length < 2) {
    bad.push('manager.discountTiers needs two entries (only their bonus amounts are used)');
  }
  return bad;
}

/* ══ The scheme a period was scored under ════════════════════════════════════════════════════════
 *
 * Performance froze, the goal froze, the inputs were per-period — and the THRESHOLDS floated. So
 * editing the discount goal re-scored every period that had not yet been written to history, and
 * every imported period was being marked against today's bar rather than the one that applied.
 *
 * Approval now records the scheme alongside the figures. Its own tab rather than a column on every
 * row: it is one object per period, and repeating 600 bytes across 40 rows to say the same thing
 * once is how a sheet becomes unreadable.
 *
 * The 27 IMPORTED periods have no scheme and never will — nobody recorded what the thresholds were
 * in 2025, and the reports measured gross discount against a bar that no longer exists. That is
 * left NULL rather than back-filled with today's numbers, which would be a fabrication dressed as
 * history. The screen shows their figures and simply does not mark targets on them.
 */
var SCHEME_TAB = 'crew_incentive_schemes';
var SCHEME_HEADERS = ['pp_start', 'thresholds_json', 'frozen_at', 'frozen_by'];

function schemeFor_(pp) {
  var rows = readTab_(SCHEME_TAB, SCHEME_HEADERS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].pp_start !== pp) continue;
    try { return JSON.parse(rows[i].thresholds_json || 'null'); } catch (e) { return null; }
  }
  return null;
}

function freezeScheme_(pp, thresholds, by) {
  if (!thresholds) return;
  if (schemeFor_(pp)) return;            // written once, like everything else about a closed period
  var sh = sheetOf_(SCHEME_TAB, SCHEME_HEADERS);
  sh.getRange(sh.getLastRow() + 1, 1, 1, SCHEME_HEADERS.length).setValues([[
    pp, JSON.stringify(thresholds), new Date().toISOString(), String(by || '')
  ]]);
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).setNumberFormat('@');
}

function hrImport_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var list = (body && body.employees) || [];
  if (!list.length) return { ok: false, error: 'no employees in payload' };
  var dry = String(p.confirm || '') !== 'yes';
  var overwrite = String(p.mode || '') === 'overwrite';

  var existing = [];
  try { existing = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: 'could not read GX Core identity: ' + String((e && e.message) || e) }; }

  var attrs = readAttrs_();
  var aliases = readAliases_();
  var idRows = [], attrRows = [], renamed = [], created = [], viaAlias = [], skippedRoles = [];

  list.forEach(function (r) {
    var full = String(r.full_name || '').trim();
    if (!full) return;
    var key = nameToKey_(full);

    var prior = null;
    // A previous merge wins over everything: if this name was merged away, it resolves to the
    // person it was merged into, and the duplicate is never recreated.
    var aliasTarget = aliases[key];
    if (aliasTarget) {
      for (var z = 0; z < existing.length; z++) {
        if (String(existing[z].employee_id || '').trim() === aliasTarget) { prior = existing[z]; break; }
      }
      if (prior) viaAlias.push(full + '  →  ' + prior.full_name);
    }
    if (!prior) {
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i].employee_id || '').trim() === key) { prior = existing[i]; break; }
      }
    }
    if (!prior) {
      for (var j = 0; j < existing.length; j++) {
        if (samePerson_(full, existing[j].full_name)) { prior = existing[j]; break; }
      }
      if (prior) renamed.push(prior.full_name + '  →  ' + full + '  (kept id ' + prior.employee_id + ')');
    }
    if (!prior) created.push(full);

    var id = prior ? String(prior.employee_id).trim() : key;

    // Merge onto the existing row: never blank a populated Core field with an empty payload value.
    var merged = {};
    if (prior) Object.keys(prior).forEach(function (k) { merged[k] = prior[k]; });
    merged.employee_id = id;
    ['full_name', 'home_store', 'role_title', 'status', 'hire_date', 'employee_number'].forEach(function (k) {
      var v = String(r[k] == null ? '' : r[k]).trim();
      /* A title the sheet spells its own way maps onto one of the four; one that maps to nothing
         is skipped, not written. The sheet is history and cannot widen the vocabulary. */
      if (k === 'role_title' && v !== '') {
        v = normRole_(v);
        if (!v) { skippedRoles.push(full + ': ' + String(r[k]).trim()); return; }
      }
      if (v === '') return;
      // FILL mode: never overturn a value the roster already holds. Crew is the system of
      // record now, so an import can complete it but not contradict it.
      if (!overwrite && String(merged[k] || '').trim() !== '') return;
      merged[k] = v;
    });
    idRows.push(merged);

    var was = attrs[id] || {};
    var a = { employee_id: id, name_key: key, full_name: full };
    attrFields_().forEach(function (k) {
      var v = String(r[k] == null ? '' : r[k]).trim();
      if (k === 'birthday') v = normBirthday_(v);
      if (k === 'shirt_size') v = normShirt_(v) || (was[k] || '');
      var current = String(was[k] || '').trim();
      a[k] = (!overwrite && current !== '') ? current : (v !== '' ? v : current);
    });
    a.updated_at = new Date().toISOString();
    a.updated_by = 'hr-import';
    attrRows.push(a);
  });

  var summary = {
    ok: true, mode: dry ? 'preview' : 'commit',
    write_mode: overwrite ? 'OVERWRITE (contradicts the roster)' : 'fill-only (never overturns a held value)',
    incoming: list.length,
    matched_existing: idRows.length - created.length,
    would_create: created.length, created_names: created.slice(0, 40),
    matched_despite_name_drift: renamed, matched_via_merge_alias: viaAlias,
    // Named, never silent: a title the sheet holds that is not one of the four was dropped,
    // and somebody has to decide which of the four that person actually is.
    skipped_unknown_roles: skippedRoles,
    active: idRows.filter(function (r) { return String(r.status).toLowerCase() !== 'retired'; }).length,
    retired: idRows.filter(function (r) { return String(r.status).toLowerCase() === 'retired'; }).length,
    with_permit: attrRows.filter(function (r) { return r.permit_number; }).length,
    with_wage: attrRows.filter(function (r) { return r.wage; }).length,
    with_employee_number: attrRows.filter(function (r) { return r.employee_number; }).length
  };
  if (dry) { summary.note = 'DRY RUN — nothing written. Repeat with confirm=yes.'; return summary; }

  GXCore.gxUpsertEmployees(idRows);
  attrRows.forEach(writeAttrs_);
  bustRosterCache_();
  summary.identity_written = idRows.length;
  summary.attributes_written = attrRows.length;
  return summary;
}

// ─── Identity seeding (Crew → GX Core) ──────────────────────────────────────────
/*
 * Per CLAUDE.md, Crew writes the shared identity slice UP to GX Core. Dutchie is the real
 * source of truth for who works here, so we seed from it: getStores() → dutchieEmployees(store)
 * → gxUpsertEmployees(rows).
 *
 * These are EDITOR-RUN, deliberately not routed through doGet. Seeding writes to the canonical
 * registry every other app reads; that is not something the open internet should be able to poke,
 * even behind a secret.
 *
 *   Run `seedIdentityPreview()` first  — reads Dutchie, writes NOTHING, returns what it would do
 *                                        plus a raw sample record so the field mapping can be checked.
 *   Then `seedIdentityCommit()`        — same thing, but actually upserts.
 *
 * KEY CHOICE — employee_id is the nameKey (`ana_reyes`), not Dutchie's numeric id.
 * Everything in the suite joins on nameKey today (Leaderboard's roster, incentive inputs, SPIFF
 * attribution; GX Core's own comment at gx_dutchie.gs notes name is the only reliable join until
 * this registry exists). Seeding with nameKey makes the registry immediately joinable with all of
 * it. dutchie_employee_id rides along so we can migrate to a numeric join later without a rename.
 * The tradeoff is real: nameKey breaks on a legal-name change, which then needs a manual merge.
 */

/** Pull one field out of a Dutchie record, tolerating the several names it ships under. */
function pick_(obj, names) {
  for (var i = 0; i < names.length; i++) {
    var v = obj[names[i]];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Non-PII fields whose distinct values we surface to drive the mapping. Allowlist, not a filter. */
var FACET_FIELDS = ['status', 'groups', 'defaultLocation', 'permissionsLocation'];

/**
 * Dutchie permission groups → a job title, most senior first. An employee carries several
 * ("Assistant Store Managers, Bud Tenders"), and the senior one is the real title.
 * "[Individual Permissions]" is a permissions bucket, not a job — it is ignored.
 */
var GROUP_RANK = [
  ['Admin',                    'Admin'],
  ['Store Managers',           'Store Manager'],
  ['Assistant Store Managers', 'Assistant Manager'],
  ['Inventory Coordinators',   'Assistant Manager'],
  ['Accounting',               'Accounting'],
  ['Inventory',                'Inventory'],
  ['Bud Tenders',              'Budtender']
];

/**
 * Dutchie logins that are not people. These ring transactions and hold permissions like staff,
 * so nothing in the payload distinguishes them — an explicit, reviewable list is honest, and
 * anything new shows up in the preview's roster for a human to catch.
 */
var NON_PERSON_LOGINS = ['authorize override pin', 'test user', 'training', 'admin'];

/**
 * Fold Dutchie's `status` string to a comparable token: "Active" → active, "In-Active" → in active.
 *
 * This was the local store matcher — and the byte-for-byte original of Core's gxStoreToken_, which
 * was lifted from it. Store matching moved to GXCore.resolveStore(), which left this function named
 * after a job it no longer does: a trap for the next person who greps for the store matcher and
 * finds a live function with the right name and the wrong purpose. Renamed for that reason alone.
 *
 * The BODY is deliberately untouched, including the Rd/Road and trailing-suffix folding that is
 * vestigial here. It is a no-op on the only two values that reach it, and simplifying it would be
 * an unforced change to the check that decides whether a person is on the roster at all — a
 * cleanup with nothing to gain and a live roster to lose.
 *
 * Do not reach for this to match a store name. That answer lives in Core now, and a second copy
 * here is exactly what was just removed.
 */
function statusToken_(s) {
  return String(s || '').toLowerCase()
    .replace(/\broad\b/g, 'rd').replace(/\bstreet\b/g, 'st')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\s+(rd|st)$/, '');
}

/**
 * "TLC Cannabis Emporium - River Rd - Green Cross…" → the GX store_id, or '' if unmatched.
 *
 * The LABEL SPLIT is Crew's, because the three-part sandwich is a Dutchie-payload shape and
 * nothing outside this import has to know about it. The MATCH is GX Core's, because "what store
 * is this name" is a suite-wide question and Crew was answering it with a private copy that had
 * drifted from the registry in two ways:
 *
 *   • it compared dutchie_name / store_id / display_name and skipped the `aliases` column, so
 *     "South", "Baseline" and "Century Dr" — names Core resolves and staff actually use — landed
 *     as unmatched here. A new alias added to the stores sheet reached every caller except this one.
 *   • it returned the FIRST match. resolveStore refuses an ambiguous fold and returns null, which
 *     is the right answer when folding has genuinely collapsed two stores together: home_store goes
 *     out through writeAttrs_/gxWrite_, and a confident wrong store is worse than a blank one.
 *
 * `stores` is still taken (callers pass it, and it is what dutchieEmployeeList_ needs) but the
 * match no longer reads it — Core memoizes the registry per execution (gxStoresCached_, added in
 * v201 for exactly this caller), so resolving one store per (employee × permission location)
 * across the roster is still a single sheet read.
 *
 * Verified against the live roster before the switch, 2026-08-22: all 6 distinct labels resolve
 * identically, nothing lost, nothing moved to a different store.
 */
function mapPermissionLocation_(label, stores) {
  var parts = String(label || '').split(' - ');
  var mid = parts.length >= 2 ? parts[1] : label;
  var row = GXCore.resolveStore(mid);
  return String((row && row.store_id) || '').trim();
}

/**
 * Read Dutchie and map to GX Core's employees schema. No writes.
 *
 * Dutchie's /employees returns the SAME company-wide list from every store, with one row per
 * (employee × permission location) — so a naive per-store loop reads the roster 6× over and sees
 * every person up to 6 times. We fetch once and dedupe on userId (stable), rather than per store
 * and dedupe on name (which would also merge two real people who share a name).
 */
function buildIdentityRows_(secret) {
  var stores = GXCore.getStores() || [];
  var errors = [], sample = null, facets = {};
  FACET_FIELDS.forEach(function (f) { facets[f] = {}; });

  function noteFacet_(r) {
    FACET_FIELDS.forEach(function (f) {
      var v = r[f];
      if (v == null) return;
      var vals = Object.prototype.toString.call(v) === '[object Array]'
        ? v.map(function (x) { return typeof x === 'object' && x ? (x.name || x.groupName || JSON.stringify(x)) : String(x); })
        : [String(v)];
      vals.forEach(function (s) {
        s = s.trim(); if (!s) return;
        facets[f][s] = (facets[f][s] || 0) + 1;
      });
    });
  }

  var list = dutchieEmployeeList_(stores, errors, secret);
  if (!list) return { rows: [], errors: errors, sample: null, seen: 0, skipped_inactive: 0,
                      skipped_non_person: 0, excluded: [], multi_store: [], facets: {} };

  var byUser = {}, seen = 0, skippedNonPerson = 0, excluded = [];

  list.forEach(function (r) {
    seen++;
    if (!sample) sample = r;
    noteFacet_(r);

    var full = pick_(r, ['fullName', 'full_name', 'name', 'displayName']);
    if (!full) return;
    full = full.replace(/\s+/g, ' ').trim();   // Dutchie ships some double-spaced names

    if (NON_PERSON_LOGINS.indexOf(full.toLowerCase()) >= 0) {
      skippedNonPerson++;
      if (excluded.indexOf(full) < 0) excluded.push(full);
      return;
    }

    // userId is Dutchie's stable person id; fall back to the name key only if it is missing.
    var uid = pick_(r, ['userId', 'globalUserId']) || ('name:' + nameToKey_(full));
    var rec = byUser[uid];
    if (!rec) {
      rec = byUser[uid] = { full_name: full, uid: uid, active: false, groups: {}, locations: {} };
    }

    // Active at ANY location counts as active — a transfer leaves an In-Active row behind at
    // the old store, and dropping the person on that basis would delete a current employee.
    if (statusToken_(pick_(r, ['status'])) === 'active') rec.active = true;

    String(pick_(r, ['groups']) || '').split(',').forEach(function (g) {
      g = g.trim(); if (g && g !== '[Individual Permissions]') rec.groups[g] = 1;
    });

    var loc = mapPermissionLocation_(pick_(r, ['permissionsLocation']), stores);
    if (loc) rec.locations[loc] = 1;
  });

  var skippedInactive = 0, multiStore = [], rows = [];
  Object.keys(byUser).forEach(function (uid) {
    var rec = byUser[uid];
    if (!rec.active) { skippedInactive++; return; }

    var title = '';
    for (var i = 0; i < GROUP_RANK.length && !title; i++) {
      if (rec.groups[GROUP_RANK[i][0]]) title = GROUP_RANK[i][1];
    }

    // One permission location = that's their store. Several (managers, admins) is genuinely
    // ambiguous, so leave home_store blank for HR rather than guessing them onto a wrong store.
    var locs = Object.keys(rec.locations);
    var home = locs.length === 1 ? locs[0] : '';
    if (locs.length > 1) multiStore.push(rec.full_name + ' (' + locs.sort().join(', ') + ')');

    rows.push({
      employee_id:         nameToKey_(rec.full_name),
      full_name:           rec.full_name,
      home_store:          home,
      dutchie_employee_id: rec.uid.indexOf('name:') === 0 ? '' : rec.uid,
      role_title:          title,
      status:              'active'
      // hire_date is deliberately absent: Dutchie's /employees carries no hire or start date, and
      // writing '' would blank a good value on re-seed. Work anniversaries need another source.
    });
  });

  rows.sort(function (a, b) { return a.full_name.localeCompare(b.full_name); });

  var facetOut = {};
  FACET_FIELDS.forEach(function (f) {
    facetOut[f] = Object.keys(facets[f])
      .map(function (k) { return { value: k, n: facets[f][k] }; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, 40);
  });

  return { rows: rows, errors: errors, sample: sample, seen: seen,
           skipped_inactive: skippedInactive, skipped_non_person: skippedNonPerson,
           excluded: excluded, multi_store: multiStore.sort(), facets: facetOut };
}

/** DRY RUN. Reads Dutchie, writes nothing. Check `sample` against `rows[0]` before committing. */
function seedIdentityPreview() {
  var b = buildIdentityRows_();
  var noStore = b.rows.filter(function (r) { return !r.home_store; }).length;
  var noTitle = b.rows.filter(function (r) { return !r.role_title; }).length;
  /*
   * Dutchie has permission groups that are not one of the four roles — Inventory Coordinator,
   * Accounting, Inventory — and GROUP_RANK still maps them, because deciding which of the four
   * an Inventory Coordinator IS is an HR call, not a mapping one.
   *
   * So the seed is not allowed to make it quietly. The dry run is a mandatory step before
   * commit, and it names every person a re-seed would file under a title the roster dropdown
   * cannot offer. Nothing to fix here if the list is empty; if it is not, decide first.
   */
  var offVocab = b.rows.filter(function (r) { return r.role_title && !normRole_(r.role_title); })
    .map(function (r) { return r.full_name + ': ' + r.role_title; });
  var out = {
    ok: true, mode: 'preview', would_upsert: b.rows.length,
    dutchie_rows_seen: b.seen,
    skipped_inactive: b.skipped_inactive, skipped_non_person: b.skipped_non_person,
    excluded_logins: b.excluded,
    without_home_store: noStore, without_role_title: noTitle,
    roles_outside_vocabulary: offVocab,
    multi_store_people: b.multi_store, store_errors: b.errors,
    first_5: b.rows.slice(0, 5),
    // FIELD NAMES ONLY. Dutchie's /employees payload carries loginId, stateId (OLCC permit) and
    // mmjExpiration; the mapped `first_5` above already proves whether the mapping worked, so
    // there is no reason to ship identifying detail over the wire just to inspect a schema.
    raw_dutchie_fields: b.sample ? Object.keys(b.sample).sort() : [],
    // Distinct values for the low-cardinality CLASSIFICATION fields only — these drive the
    // mapping (which status counts as active, what `groups` looks like, how defaultLocation
    // spells a store) and none of them identify a person. Explicit allowlist, never a loop
    // over every key, so a new PII field in Dutchie's payload can't leak in by default.
    raw_dutchie_facets: b.facets,
    hire_date_note: 'Dutchie /employees carries no hire date — work anniversaries need another source.'
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** COMMITS to GX Core's employees registry. Run seedIdentityPreview() first. */
function seedIdentityCommit() {
  var b = buildIdentityRows_();
  if (!b.rows.length) {
    var empty = { ok: false, error: 'nothing to seed', store_errors: b.errors, dutchie_rows_seen: b.seen };
    Logger.log(JSON.stringify(empty, null, 2));
    return empty;
  }
  var res = GXCore.gxUpsertEmployees(b.rows);
  var out = {
    ok: true, mode: 'commit', upserted: (res && res.upserted) || 0,
    skipped_inactive: b.skipped_inactive, skipped_non_person: b.skipped_non_person,
    multi_store_people: b.multi_store, store_errors: b.errors
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Dutchie's employee list, fetched ONCE. The endpoint returns the same company-wide list from
 * every store, so we try each store only until one answers — a second success would just be the
 * same rows again.
 */
function dutchieEmployeeList_(stores, errors, secret) {
  /* WAS GXCore.dutchieEmployees(dn), WHICH COULD NEVER HAVE WORKED (fixed 2026-08-31).
   * PropertiesService.getScriptProperties() scopes to the CALLING project, so the library looked
   * for DUTCHIE_STORE_KEYS_JSON in THIS project, which has never held one. Every store threw, the
   * throws went into `errors`, and callers treated a null list as "Dutchie had nothing" -- so this
   * has returned nothing since the day it was written. GX Core's own gx_core.gs:187 documents the
   * same constraint; GX_DUTCHIE_CACHE_SCOPE.md asserted the opposite and was wrong.
   *
   * The web route executes AS GX Core and reads Core's properties, which is the thing a library
   * call cannot do. It takes a store_id, so the Dutchie label never leaves Core.
   *
   * THE SECRET, AND WHY THIS IS FIDDLY: this app deliberately holds no deploy secret -- it asks
   * Core to validate an incoming one instead (see deploySecretOk_), precisely to avoid one more
   * copy to leak and rotate. So a REQUEST can pass its own secret straight through, and a
   * request-driven path works with no new configuration. The nightly 5am trigger has no request
   * and therefore no secret; it works only if GX_DEPLOY_SECRET is set locally, which
   * deploySecretOk_ already anticipates. Until then it fails LOUDLY here rather than silently
   * returning nothing, which is what it did for months.
   */
  var sec = String(secret || '').trim()
         || PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!sec) {
    if (errors) errors.push('no deploy secret available — a request must pass secret=, or set '
                          + 'GX_DEPLOY_SECRET on this project for the nightly trigger to work');
    return null;
  }

  var list = null;
  for (var i = 0; i < stores.length && !list; i++) {
    var id = String(stores[i].store_id || '').trim();
    if (!id) continue;
    try {
      /* RAW ROWS, via dutchie_get — NOT ?action=dutchie_employees.
       *
       * That route returns a REDUCED shape: { id, name, active }. It was built to resolve one
       * person's dutchie_employee_id, and for that it is exactly right. This scan needs the whole
       * record: buildIdentityRows_ filters on `status`, derives the role from PERMISSION GROUPS and
       * the store from the permission LOCATION, and none of those survive the reduction.
       *
       * Measured 2026-09-01: 131 rows came back, zero store errors, and every single row was
       * dropped as inactive — because `status` was not in the payload at all, so no row could ever
       * be active. The scan reported "Dutchie returned no usable rows", which reads as a Dutchie
       * problem and is not one.
       *
       * My own regression, from this morning: the library call this replaced returned raw Dutchie
       * rows, and I swapped it for a route with a different shape without checking what the
       * consumer reads. dutchie_get forwards the query verbatim and hands back what Dutchie sent,
       * which is what this needs. */
      var url = GXCORE_URL + '?action=dutchie_get&store=' + encodeURIComponent(id)
              + '&path=' + encodeURIComponent('/employees')
              + '&Skip=0&Take=500'
              + '&secret=' + encodeURIComponent(sec);
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      var d = JSON.parse(res.getContentText() || 'null');
      if (d && d.ok === true && d.rows && d.rows.length) { list = d.rows; break; }
      if (errors && d && d.ok === false) errors.push(id + ': ' + (d.error || 'refused'));
    } catch (e) {
      if (errors) errors.push(id + ': ' + String((e && e.message) || e));
    }
  }
  return list;
}

/**
 * Does Dutchie already carry usable OLCC permit data? Its employee payload has `stateId` and
 * `mmjExpiration`, which LOOK like permit number + expiry. Before pursuing Metrc API access
 * (which needs an integrator key Metrc only issues after an application), it is worth measuring
 * whether the data we already have is populated and current enough to do the job.
 *
 * COVERAGE ONLY — counts and expiry buckets. A worker permit number is a government ID; this
 * never returns one, and never returns a name alongside a date.
 */
function permitCoverage_(p) {
  var errors = [];
  var stores = GXCore.getStores() || [];
  var list = dutchieEmployeeList_(stores, errors, p && p.secret);
  if (!list) return { ok: false, error: 'could not read Dutchie employees', store_errors: errors };

  var today = todayInStoreTz_();
  var seen = 0, active = 0, withId = 0, withExp = 0, unparseableExp = 0;
  var buckets = { expired: 0, within_30d: 0, within_90d: 0, beyond_90d: 0 };

  list.forEach(function (r) {
    seen++;
    if (statusToken_(pick_(r, ['status'])) !== 'active') return;
    active++;

    if (pick_(r, ['stateId'])) withId++;

    var raw = pick_(r, ['mmjExpiration']);
    if (!raw) return;
    withExp++;
    var d = new Date(raw);
    if (isNaN(d.getTime())) { unparseableExp++; return; }
    var days = daysBetween_(today, new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    if (days < 0)        buckets.expired++;
    else if (days <= 30) buckets.within_30d++;
    else if (days <= 90) buckets.within_90d++;
    else                 buckets.beyond_90d++;
  });

  return {
    ok: true, rows_seen: seen, active_people: active,
    with_state_id: withId, with_expiration: withExp,
    unparseable_expiration: unparseableExp,
    expiry_buckets: buckets,
    coverage_pct: active ? Math.round(withId / active * 100) : 0,
    note: 'stateId/mmjExpiration are Dutchie-entered fields, NOT synced from Metrc. Treat coverage ' +
          'as a measure of how well staff keep Dutchie current, not as authoritative OLCC data.'
  };
}

/** Which script properties exist, how big they are, and (for JSON blobs) how many entries. */
function propsInspect_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var out = Object.keys(props).sort().map(function (k) {
    var v = String(props[k] == null ? '' : props[k]);
    var row = { key: k, length: v.length };
    // Report SHAPE, never content — several of these are secrets.
    if (v.charAt(0) === '{' || v.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(v);
        row.json = true;
        row.entries = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
        var keys = Array.isArray(parsed) ? [] : Object.keys(parsed).slice(0, 3);
        if (keys.length) row.sample_keys = keys;
      } catch (e) { row.json = false; }
    }
    return row;
  });
  return { ok: true, count: out.length, properties: out };
}

/** What GX Core actually holds now — aggregate only, so this never leaks a roster. */
/**
 * Which stored name_keys disagree with what nameToKey_ would produce from the full_name on record?
 *
 * WHY THIS EXISTS: nameToKey_ used to replace whitespace with underscores BEFORE trimming, so a
 * padded cell ("  Sky Pinnick ") produced "_sky_pinnick_" instead of "sky_pinnick". Trailing spaces
 * in spreadsheet cells are routine, and name_key is what the suite joins a person on — the failure
 * is not an error, it is a person detached from their own record. The function is fixed; any key
 * WRITTEN by the old path is still wrong and will not match the corrected one.
 *
 * READ-ONLY, deliberately. It reports; repairing is a separate, deliberate act (see identity_repair
 * for the same split). Secret-gated like identity_health.
 *
 * Output is minimal: employee_id plus the stored and expected keys. That is what you need to fix a
 * row. It does not dump the roster.
 */
function nameKeyHealth_() {
  var attrs = readAttrs_();
  var ids = Object.keys(attrs);
  var mismatched = [], padded = [], blank = [], byKey = {}, dupes = [], superseded = [];

  var identityById = {};
  try { (GXCore.getEmployees() || []).forEach(function (r) {
    identityById[String(r.employee_id || '').trim()] = r;
  }); } catch (e) {}

  ids.forEach(function (id) {
    var r = attrs[id] || {};
    var stored = String(r.name_key || '');
    var full   = String(r.full_name || '');
    var expect = full ? nameToKey_(full) : '';

    if (!stored) { blank.push({ employee_id: id }); return; }
    // The specific fingerprint of the old bug: a leading or trailing underscore, which nameToKey_
    // can no longer produce from any input.
    if (/^_|_$/.test(stored)) padded.push({ employee_id: id, stored: stored, expected: expect });
    else if (expect && stored !== expect) mismatched.push({ employee_id: id, stored: stored, expected: expect });

    if (!byKey[stored]) byKey[stored] = [];
    byKey[stored].push(id);
  });

  // For a duplicate, report enough to DECIDE which row is canonical without dumping the roster.
  // A shared join key is not automatically a merge: one row may be a retired predecessor, and
  // merging a live person into a retired shell is not recoverable by re-running anything.
  // A MERGED or RETIRED predecessor keeps the same name_key on purpose — that is what makes the
  // merge traceable afterwards. Flagging it as a duplicate is a false positive, and a check that
  // cries wolf on a correct state is one people learn to ignore. Only a collision between rows that
  // are still LIVE is a real join hazard.
  function liveRow_(id) {
    return statusIsLive_((identityById[id] || {}).status);
  }

  Object.keys(byKey).forEach(function (k) {
    if (byKey[k].length < 2) return;
    var live = byKey[k].filter(liveRow_);
    if (live.length < 2) {
      superseded.push({ name_key: k, live: live, superseded_by_status: byKey[k].filter(function (id) { return !liveRow_(id); }) });
      return;
    }
    dupes.push({
      name_key: k,
      rows: byKey[k].map(function (id) {
        var a = attrs[id] || {}, i = identityById[id] || {};
        return {
          employee_id: id,
          full_name: String(a.full_name || i.full_name || ''),
          preferred_name: String(i.preferred_name || ''),
          employee_number: String(a.employee_number || i.employee_number || ''),
          status: String(i.status || '(not in GX Core)'),
          home_store: String(i.home_store || ''),
          dutchie_employee_id: String(i.dutchie_employee_id || ''),
          user_id: String(i.user_id || ''),
          attrs_updated_at: String(a.updated_at || ''),
        };
      }),
    });
  });

  return {
    ok: true,
    checked: ids.length,
    padded_underscore: padded,      // written by the pre-fix nameToKey_
    mismatched: mismatched,         // disagree with the name on record for some other reason
    blank_name_key: blank,
    duplicate_name_key: dupes,      // two LIVE rows sharing a join key — a real attribution hazard
    superseded_name_key: superseded, // a merged/retired predecessor keeping its key — EXPECTED, informational
    clean: padded.length === 0 && mismatched.length === 0 && blank.length === 0 && dupes.length === 0,
  };
}

function identityHealth_() {
  var rows = [];
  try { rows = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  var byStore = {}, byRole = {}, missingStore = 0, missingDutchieId = 0, merged = 0, retired = 0;
  rows.forEach(function (r) {
    // Merged and retired rows stay in the sheet for audit, but counting them in the live role
    // spread reads as "7 store managers for 6 stores" and sends you looking for a bug.
    /* NOT statusIsLive_: this COUNTS the two separately, which is the whole output. */
    var st = String(r.status || '').toLowerCase();
    if (st === 'merged')  { merged++;  return; }
    if (st === 'retired') { retired++; return; }
    var st = String(r.home_store || '').trim() || '(none)';
    if (st === '(none)') missingStore++;
    byStore[st] = (byStore[st] || 0) + 1;
    var ro = String(r.role_title || '').trim() || '(none)';
    byRole[ro] = (byRole[ro] || 0) + 1;
    if (!String(r.dutchie_employee_id || '').trim()) missingDutchieId++;
  });

  var probe = rows[0] || {};
  var lib = {
    roleCanEdit:          typeof GXCore.roleCanEdit === 'function',
    getEmployeeByNumber:  typeof GXCore.getEmployeeByNumber === 'function',
    getEmployeeByDutchieId: typeof GXCore.getEmployeeByDutchieId === 'function',
    getEmployeeByName:    typeof GXCore.getEmployeeByName === 'function',
    // EoM history reads cfg.eom back through this; without it the log cannot record a pick.
    getKv:                typeof GXCore.getKv === 'function',
    columns: Object.keys(probe).sort()
  };
  return {
    ok: true, total: rows.length, merged: merged, retired: retired,
    active: rows.length - merged - retired, library: lib,
    with_employee_number: rows.filter(function (r) { return String(r.employee_number || '').trim(); }).length,
    with_preferred_name:  rows.filter(function (r) { return String(r.preferred_name || '').trim(); }).length,
    with_avatar:          rows.filter(function (r) { return String(r.avatar_config || '').trim(); }).length,
    by_store: byStore, by_role: byRole,
    missing_home_store: missingStore, missing_dutchie_id: missingDutchieId,
    with_hire_date: rows.filter(function (r) { return String(r.hire_date || '').trim(); }).length
  };
}

/*
 * Puts a BLANKED identity row back together.
 *
 * The damage signature is a GX Core employee row that still has its employee_id and is still
 * "active", but holds nothing else — no name, no store, no role, no dutchie id. In the roster
 * that renders as a person with a face and no details, which is exactly how it was found.
 *
 * The mechanism is the one hr_import already guards against, arriving from another app:
 * gxWrite_ REPLACES the whole row, rebuilding every column from the record it is handed, so an
 * upsert of { employee_id, avatar_config } writes '' over everything it did not mention. Crew's
 * own writers (saveIdentity_, hrImport_) all read-merge-write and cannot do this;
 * a partial upsert from outside Crew can, and did.
 *
 * Two sources still hold the truth, neither of which the wipe touched:
 *   • Crew's attribute sheet — full_name and employee_number, kept independently of Core
 *   • Dutchie — home_store, role_title and dutchie_employee_id, re-derived exactly as the seed
 *     derives them, so a repaired row is identical to a freshly seeded one
 *
 * FILL ONLY, for the same reason hr_import is: a field is written only where Core currently
 * holds nothing, so a repair can complete a row but never contradict a curated value. hire_date
 * has no machine source at all (Dutchie carries none) and is reported as still empty for a human
 * to fill rather than guessed at.
 *
 * SUPPLYING WHAT NO MACHINE SOURCE HAS. Some fields cannot be re-derived by anyone: hire_date
 * exists in no system Crew can read, and home_store is genuinely ambiguous for the managers who
 * hold permissions at several stores — the seed refuses to guess between them, correctly. Pass
 * those as parameters alongside employee_id and they are treated as the highest-priority source,
 * still FILL-ONLY, so this stays a repair and never becomes a back door for editing a live value.
 * Ordinary identity edits belong in the UI, where they are attributable to a signed-in person.
 *
 * Preview by default. Pass confirm=yes to write, employee_id=<id> to look at one row.
 */
function identityRepair_(p) {
  var only   = String(p.employee_id || '').trim();
  var commit = String(p.confirm || '') === 'yes';

  // Values a human supplies for this one row. Validated up front: a repair that half-applies,
  // or that writes an unknown store into the registry six apps read, is worse than a refusal.
  var GIVEN_FIELDS = ['full_name', 'home_store', 'role_title', 'preferred_name', 'hire_date'];
  var given = {};
  GIVEN_FIELDS.forEach(function (k) { if (p[k] != null) given[k] = String(p[k]).trim(); });
  if (Object.keys(given).length && !only) {
    return { ok: false, error: 'supplying a value needs an employee_id — a repair fills one named row' };
  }
  if (given.home_store) {
    var known = (GXCore.getStores() || []).some(function (x) {
      return String(x.store_id).trim() === given.home_store;
    });
    if (!known && given.home_store !== 'corporate') {
      return { ok: false, error: 'unknown store: ' + given.home_store };
    }
  }
  if (given.hire_date) {
    var hd = normDate_(given.hire_date);
    if (!hd) return { ok: false, error: 'invalid hire date: ' + given.hire_date + ' (expected YYYY-MM-DD)' };
    given.hire_date = hd;
  }

  var live = [];
  try { live = GXCore.getEmployees() || []; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  var damaged = live.filter(function (r) {
    /* NOT statusIsLive_: merged only, on purpose. A RETIRED person with a damaged full_name
       still wants repairing — they worked the periods they worked and history joins on it. */
    if (String(r.status || '').toLowerCase() === 'merged') return false;
    if (only) return String(r.employee_id || '').trim() === only;
    return !String(r.full_name || '').trim();
  });
  if (!damaged.length) {
    return { ok: true, mode: 'preview', damaged: 0, repaired: [],
             note: only ? 'no live row with employee_id ' + only
                        : 'every identity row still has its name' };
  }

  var attrs = readAttrs_();
  var seed = {}, seedError = '';
  try {
    buildIdentityRows_().rows.forEach(function (r) { seed[r.employee_id] = r; });
  } catch (e) { seedError = String((e && e.message) || e); }

  var REFILL = ['full_name', 'home_store', 'role_title', 'preferred_name', 'hire_date',
                'dutchie_employee_id', 'employee_number', 'status'];
  var report = [];

  damaged.forEach(function (row) {
    var id = String(row.employee_id || '').trim();
    var a  = attrs[id] || {};
    var d  = seed[id]  || {};
    var source = {
      full_name:           given.full_name  || a.full_name || d.full_name || '',
      home_store:          given.home_store || d.home_store || '',
      role_title:          given.role_title || d.role_title || '',
      preferred_name:      given.preferred_name || '',
      // No machine anywhere holds a hire date: Dutchie carries none, and Crew's attribute sheet
      // stores work_anniversary rather than the date itself. A human is the only source.
      hire_date:           given.hire_date  || '',
      dutchie_employee_id: d.dutchie_employee_id || '',
      // Crew's attribute sheet is where a number is ISSUED, so it is authoritative here and the
      // Core column is only a mirror of it — but SPIFF and Leaderboard read that mirror.
      employee_number:     a.employee_number || '',
      status:              d.status || 'active'
    };

    var merged = {}, filled = [], stillEmpty = [];
    Object.keys(row).forEach(function (k) { merged[k] = row[k]; });   // <- every column survives
    merged.employee_id = id;
    REFILL.forEach(function (k) {
      if (String(merged[k] || '').trim()) return;      // fill only
      var v = String(source[k] || '').trim();
      if (!v) { stillEmpty.push(k); return; }
      merged[k] = v;
      filled.push(k + ' = ' + v);
    });

    if (commit && filled.length) GXCore.gxUpsertEmployee(merged);

    report.push({
      employee_id: id,
      employee_number: a.employee_number || '',
      name_source: a.full_name ? 'crew attributes' : (d.full_name ? 'dutchie' : '(none — cannot name this row)'),
      filled: filled,
      still_empty: stillEmpty,
      /* Crew's attribute sheet is a SEPARATE store and a wipe of the Core row cannot touch it.
         Saying which of those fields are on file — presence only, never the values, because
         wage and birthday are exactly the PII this channel should not be shipping — is what
         distinguishes "the wipe took this" from "nobody ever filled it in". */
      attributes_on_file: ['employee_number', 'wage', 'shirt_size', 'birthday',
                           'work_anniversary', 'permit_number'].reduce(function (o, k) {
        o[k] = !!String(a[k] || '').trim(); return o;
      }, {}),
      // The seed is stamped into avatar_config and pinned to employee_number, so a repaired
      // person keeps the same face they had before the wipe.
      keeps_avatar: !!String(row.avatar_config || '').trim()
    });
  });

  if (commit) bustRosterCache_();
  return { ok: true, mode: commit ? 'commit' : 'preview',
           damaged: damaged.length, dutchie_error: seedError, repaired: report,
           note: commit ? 'written to GX Core' : 're-run with confirm=yes to write' };
}

// ─── Employee of the Month history ──────────────────────────────────────────────
/*
 * Crew keeps the record of who has held EoM. GX Core's cfg.eom holds only the CURRENT holder —
 * one object, overwritten on every pick — so by the time you want to know who had it in March,
 * March is gone. That is fine for Core and for the kiosk, which only ever ask "who is it now",
 * and wrong for HR, which is the one party that needs the series.
 *
 * WHERE THE LOG COMES FROM, and why it is not written where the pick is made. The pick goes
 * straight from the browser to GX Core (GXCore set_eom), deliberately — it needed no engine
 * change and no library re-pin. So the Crew engine never sees the write. Rather than add a
 * second client-side write that could fail on its own and silently lose a reign, the engine
 * READS cfg.eom back with GXCore.getKv and appends whenever the live value differs from the
 * newest row it already has. The browser never supplies the values, so it cannot falsify them.
 *
 * That reconciliation runs on every read of this tab, which has a useful consequence: a change
 * made outside Crew entirely still lands in the history the next time somebody opens the tab.
 * Its one blind spot is honest and worth stating — two changes between two reads leave the
 * middle holder unrecorded. For a monthly award picked by a handful of managers that is a trade
 * worth making against a write path that can half-succeed.
 *
 * APPEND-ONLY. A reign's end is the next reign's start, so nothing is ever edited; a blank
 * employee_id is the "deliberately nobody" row, carrying the same meaning as the empty value
 * Core stores when the award is cleared.
 */

/*
 * The log's own sheet. started_at and recorded_at are pinned to PLAIN TEXT for the reason the
 * roster's employee_number and birthday are: Sheets coerces anything date-shaped, and a coerced
 * cell reads back as "Sun Mar 01 2026 …" rather than the ISO string this file compares and sorts
 * on. Every ordering decision here is a string compare, so the format is load-bearing.
 */
function eomSheet_() {
  var sh = sheetOf_(EOM_TAB, EOM_HEADERS);
  try {
    sh.getRange('C:C').setNumberFormat('@');
    sh.getRange('E:E').setNumberFormat('@');
  } catch (e) { /* formatting is a nicety; never fail a write over it */ }
  return sh;
}

/** cfg.eom, normalized. undefined = never set, null = deliberately nobody, else the holder. */
function eomCurrent_() {
  var raw;
  try { raw = GXCore.getKv('cfg.eom'); }
  catch (e) { return { error: String((e && e.message) || e) }; }
  if (raw === null || raw === undefined) return { state: 'unset' };
  if (String(raw).trim() === '') return { state: 'nobody' };
  var v;
  try { v = (typeof raw === 'object') ? raw : JSON.parse(raw); }
  catch (e) { return { error: 'cfg.eom is not JSON: ' + String(raw).slice(0, 80) }; }
  var id = String((v && v.employee_id) || '').trim();
  if (!id) return { state: 'nobody' };
  return { state: 'held', employee_id: id,
           since: String((v && v.since) || ''), set_by: String((v && v.set_by) || '') };
}

/**
 * Bring the log level with cfg.eom, appending at most one row. Returns the rows, oldest first.
 *
 * Identity of a reign is (employee_id, started_at): the same person picked again after somebody
 * else held it is a NEW reign and gets its own row, while re-reading an unchanged value appends
 * nothing however many times the tab is opened.
 */
function eomSync_(names) {
  var rows = readTab_(EOM_TAB, EOM_HEADERS);
  var cur  = eomCurrent_();
  if (cur.error || cur.state === 'unset') return { rows: rows, error: cur.error || '' };

  var last = rows.length ? rows[rows.length - 1] : null;
  var wantId = cur.state === 'nobody' ? '' : cur.employee_id;
  /* A cleared award has no timestamp of its own — Core stores an empty VALUE, which cannot carry
     one — so a clear is deduped on "the log already ends in a clear" rather than on its time,
     and its recorded_at is when Crew first saw it rather than when it happened. */
  var same = last && String(last.employee_id) === wantId &&
             (wantId === '' || String(last.started_at) === String(cur.since || ''));
  if (same) return { rows: rows, error: '' };

  var now = new Date().toISOString();
  var startedAt = wantId ? String(cur.since || now) : now;
  /* The log is a timeline, so it must not be able to step backwards. cfg.eom's `since` is
     stamped by GX Core and a clear is stamped here, so clock skew between the two — or a
     hand-edited cfg.eom — could otherwise seat a reign before the one it replaces, and the tab
     would show somebody's month ending before it began. ISO-8601 in UTC sorts lexicographically,
     which is why a plain string compare is the right one. */
  if (last && last.started_at && startedAt < String(last.started_at)) {
    startedAt = String(last.started_at);
  }
  var name = wantId ? String((names || {})[wantId] || '') : '';
  var setBy = wantId ? String(cur.set_by || '') : '';
  eomSheet_().appendRow([wantId, name, startedAt, setBy, now, 'observed']);
  rows.push({ employee_id: wantId, name: name, started_at: startedAt,
              set_by: setBy, recorded_at: now, source: 'observed' });
  return { rows: rows, error: '' };
}

/**
 * The history, newest first, each reign carrying the moment it ended.
 *
 * Names are stored WITH the row and only refreshed from the registry where the row has none.
 * Someone who has since been renamed, retired or merged away still held it under the name they
 * held it under, and a log that quietly restates the present is not a record of the past.
 */
function getEomHistory_(p) {
  var auth = requireCrew_(p);
  if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };

  var names = Object.create(null);
  try {
    (GXCore.getEmployees() || []).forEach(function (r) {
      names[String(r.employee_id || '').trim()] = String(r.full_name || '');
    });
  } catch (e) { /* a name lookup failure must not cost us the log */ }

  var synced = eomSync_(names);
  var rows = synced.rows;

  var out = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    out.push({
      employee_id: r.employee_id,
      name: r.name || names[r.employee_id] || '',
      started_at: r.started_at,
      // The reign ended when the next one began; the newest row is still running.
      ended_at: i < rows.length - 1 ? rows[i + 1].started_at : '',
      set_by: r.set_by,
      current: i === rows.length - 1,
      nobody: !r.employee_id,
      // Observed from cfg.eom, or entered by hand for a month that predates the log.
      backfilled: r.source === 'backfill'
    });
  }
  return { ok: true, history: out, sync_error: synced.error || '' };
}

/*
 * Enter reigns that predate the log.
 *
 * The engine can only observe what cfg.eom holds, and cfg.eom holds one value — so every month
 * before Crew started watching is gone from the machine and survives only in somebody's memory.
 * That is not a reason to leave the record starting in August; it is a reason to let a human put
 * the earlier months in, and to mark them as what they are.
 *
 * Rows land with source='backfill', which the tab renders as "recorded" rather than passing them
 * off as observed. A month is the granularity the record actually has — nobody remembers which
 * Tuesday — so a backfilled reign starts on the 1st, the day is nominal, and the tab shows month
 * and year only, which is the truth about how precise this is.
 *
 * DEDUPED ON (employee_id, month), not on the exact timestamp, for the same reason: re-running
 * this must not seat a second August beside the one already observed, even though the observed
 * one starts on the 20th.
 *
 * The tab is re-sorted by started_at afterwards. eomSync_ compares against the LAST row to decide
 * whether cfg.eom has moved on, so a history appended out of order would make it think the award
 * had changed hands every time anybody opened the tab.
 */
function eomBackfill_(p, body) {
  if (!deploySecretOk_(p)) return { ok: false, error: 'bad deploy secret' };
  var want = (body && body.rows) || null;
  if (!want && p.rows) { try { want = JSON.parse(p.rows); } catch (e) { want = null; } }
  if (!Array.isArray(want) || !want.length) {
    return { ok: false, error: 'rows required: [{ employee_id, started_at }, …]' };
  }

  var known = {};
  try {
    (GXCore.getEmployees() || []).forEach(function (r) {
      known[String(r.employee_id || '').trim()] = String(r.full_name || '');
    });
  } catch (e) { return { ok: false, error: 'could not read the registry: ' + String((e && e.message) || e) }; }

  // Validate the WHOLE batch before writing any of it — a half-entered history is worse than a
  // refusal, because the gap looks like a month nobody held it.
  var plan = [];
  for (var i = 0; i < want.length; i++) {
    var id = String((want[i] && want[i].employee_id) || '').trim();
    var at = String((want[i] && want[i].started_at) || '').trim();
    if (!id) return { ok: false, error: 'row ' + (i + 1) + ': employee_id required' };
    // Someone who held it and has since retired or been merged away still held it, so any status
    // is acceptable — but the id must be a real person, not a typo that logs a reign to nobody.
    if (!(id in known)) return { ok: false, error: 'row ' + (i + 1) + ': unknown employee_id ' + id };
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) {
      return { ok: false, error: 'row ' + (i + 1) + ': started_at must be a full ISO timestamp, got "' + at + '"' };
    }
    plan.push({ employee_id: id, name: known[id], started_at: at, month: at.slice(0, 7) });
  }

  /*
   * REFUSE TO BACKFILL THE MONTH THAT IS CURRENTLY RUNNING. cfg.eom is live and eomSync_ will
   * record it with its real timestamp the next time anybody opens the tab; entering it by hand
   * first seats a second row for the same person in the same month, because the two disagree on
   * the day and observation is deliberately exact where memory is not. Backfill is for months
   * the log could never have seen, and the running one is not that.
   */
  var cur = eomCurrent_();
  if (cur.state === 'held' && cur.since) {
    var liveMonth = String(cur.since).slice(0, 7);
    for (var j = 0; j < plan.length; j++) {
      if (plan[j].month === liveMonth) {
        return { ok: false, error: plan[j].month + ' is the month currently held by ' +
          (known[cur.employee_id] || cur.employee_id) + ' — it will record itself. ' +
          'Backfill only months that ended before the log started.' };
      }
    }
  }

  var have = Object.create(null);
  readTab_(EOM_TAB, EOM_HEADERS).forEach(function (r) {
    have[r.employee_id + '|' + String(r.started_at).slice(0, 7)] = true;
  });

  if (String(p.confirm || '') !== 'yes') {
    return { ok: true, mode: 'preview', would_add: plan.filter(function (x) {
      return !have[x.employee_id + '|' + x.month]; }),
      already_logged: plan.filter(function (x) { return have[x.employee_id + '|' + x.month]; })
        .map(function (x) { return x.month + ' ' + x.name; }),
      note: 're-run with confirm=yes to write' };
  }

  var sh = eomSheet_();
  var now = new Date().toISOString();
  var added = [], skipped = [];
  plan.forEach(function (x) {
    var key = x.employee_id + '|' + x.month;
    if (have[key]) { skipped.push(x.month + ' ' + x.name); return; }
    have[key] = true;
    sh.appendRow([x.employee_id, x.name, x.started_at, '', now, 'backfill']);
    added.push(x.month + ' ' + x.name);
  });

  var last = sh.getLastRow();
  if (last > 2) sh.getRange(2, 1, last - 1, EOM_HEADERS.length).sort({ column: 3, ascending: true });

  return { ok: true, mode: 'commit', added: added, skipped_already_logged: skipped };
}

// ─── Celebrations (the PII-free feed Leaderboard consumes) ──────────────────────

/** Days from today (store TZ) until the next occurrence of MM-DD. Today = 0. */
function daysUntilMonthDay_(mmdd, today) {
  var m = String(mmdd || '').match(/^(\d{2})-(\d{2})$/);
  if (!m) return -1;
  var mo = Number(m[1]), da = Number(m[2]);
  var y = today.getFullYear();
  var next = new Date(y, mo - 1, da);
  // Feb 29 in a common year: celebrate Mar 1 so the person isn't skipped three years in four.
  if (next.getMonth() !== mo - 1) next = new Date(y, mo, 1);
  if (daysBetween_(today, next) < 0) {
    next = new Date(y + 1, mo - 1, da);
    if (next.getMonth() !== mo - 1) next = new Date(y + 1, mo, 1);
  }
  return daysBetween_(today, next);
}

function daysBetween_(a, b) {
  var MS = 86400000;
  var da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  var db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / MS);
}

/** "Today" in store time, as a plain local Date — avoids UTC rolling the date over at 5pm PT. */
function todayInStoreTz_() {
  var s = Utilities.formatDate(new Date(), STORE_TZ, 'yyyy-MM-dd').split('-');
  return new Date(Number(s[0]), Number(s[1]) - 1, Number(s[2]));
}

/**
 * Today's + upcoming birthdays and work anniversaries, as DERIVED FLAGS ONLY.
 *
 * This is the payload that leaves Crew for the all-staff kiosk, so it carries no raw dates:
 * name, store, type, days_away, and years-of-service for anniversaries. Someone reading the
 * Leaderboard response can tell that Ana has a birthday Thursday; they cannot tell her DOB,
 * and they cannot reconstruct it by watching the feed. Keep it that way.
 */
function getCelebrations_(p) {
  // Machine-to-machine (Leaderboard/GX Core), so: deploy secret OR a signed-in crew user.
  if (!deploySecretOk_(p)) {
    var auth = requireCrew_(p);
    if (!auth.ok) return { ok: false, error: auth.error || 'Auth required' };
  }

  var horizon = Math.max(0, Math.min(60, Number(p.days || CELEBRATION_HORIZON_DAYS) || CELEBRATION_HORIZON_DAYS));
  var today = todayInStoreTz_();

  var identity = [];
  try { identity = GXCore.getEmployees() || []; } catch (e) { identity = []; }
  var byId = Object.create(null);
  identity.forEach(function (r) {
    /* THE BUG THIS LINE USED TO BE (fixed 2026-08-29). It read
         if (st === 'inactive' || st === 'terminated' || st === 'false') return;
       — no 'retired', no 'merged'. This is the one endpoint whose output leaves Crew for the
       all-staff kiosk, so the most public surface in the app was announcing birthdays and work
       anniversaries for people who had left, and for merged tombstones that would announce a live
       person a second time. Caught by cross-checking against the Monday digest, which derives its
       list from rosterJoin_ and returned 1 for a week this route claimed 4 for. */
    if (!statusIsLive_(r.status)) return;
    byId[String(r.employee_id || '').trim()] = r;
  });

  var attrs = readAttrs_();
  var out = [];
  /* Who is being SUPPRESSED, not just who is being celebrated. An opt-out only shows its effect
     on one day a year, so without this the only way to confirm the flag is set is to open the
     roster and look — or to wait for the date it is meant to prevent. Names, no dates: the
     caller is already trusted with the celebration names below. */
  var suppressed = [];

  Object.keys(attrs).forEach(function (id) {
    var a = attrs[id];
    var person = byId[id];
    if (!person) return;   // inactive or unknown — don't celebrate someone who left
    if (isTruthyFlag_(a.celebrations_opt_out)) {        // on the roster for access, not for work
      suppressed.push(String(person.full_name || id));
      return;
    }
    var base = {
      name_key: nameToKey_(person.full_name),
      name:     String(person.full_name || ''),
      store:    String(person.home_store || '')
    };

    var bday = normBirthday_(a.birthday);
    if (bday) {
      var bd = daysUntilMonthDay_(bday, today);
      if (bd >= 0 && bd <= horizon) {
        out.push({ name_key: base.name_key, name: base.name, store: base.store,
                   type: 'birthday', when: bd === 0 ? 'today' : 'upcoming', days_away: bd });
      }
    }

    var anniv = normDate_(a.work_anniversary) || normDate_(person.hire_date);
    if (anniv) {
      var parts = anniv.split('-');
      var ad = daysUntilMonthDay_(parts[1] + '-' + parts[2], today);
      if (ad >= 0 && ad <= horizon) {
        // Years being completed on that upcoming date, not years completed today.
        var years = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ad).getFullYear() - Number(parts[0]);
        if (years > 0) {
          out.push({ name_key: base.name_key, name: base.name, store: base.store,
                     type: 'anniversary', when: ad === 0 ? 'today' : 'upcoming', days_away: ad, years: years });
        }
      }
    }
  });

  out.sort(function (x, y) { return x.days_away - y.days_away || x.name.localeCompare(y.name); });
  suppressed.sort();
  return { ok: true, app: 'crew', horizon_days: horizon, today: Utilities.formatDate(today, STORE_TZ, 'yyyy-MM-dd'),
           celebrations: out, opted_out: suppressed };
}
