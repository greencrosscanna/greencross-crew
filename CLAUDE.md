# GX Crew (app key `crew`) — GX 2.0 HR / People app

**GX Crew is the HR / People system-of-record** for the Green Cross suite: it owns the roster and
everything compensation-related, and **feeds** Leaderboard rather than living inside it. **It runs
payroll.**

**This file is rules only.** The incidents, "Corrected <date>" notes, measurements and reasoning
behind each rule are in **`docs/claude-md-history.md`**, under the same headings as here. Read that
section before changing or deleting a rule you do not understand — most exist because something
paid, or nearly paid, the wrong amount without erroring.

## What GX Crew owns
- **Roster / identity attributes** — OLCC/METRC permits, time (SwipeClock), birthday /
  work-anniversary, shirt size, badges.
- **Compensation** — the Incentive / bonus calculation, editable comp **thresholds**, **Capstone
  payroll export**, **monthly review snapshots**.
- **Feeds to Leaderboard (via GX Core, never app-to-app):** **perks**, and a privacy-preserving
  **celebrations feed** (a derived today/upcoming flag, **not raw DOB**) so no PII leaves Crew.

## Boundary with GX Core (the split)
- **GX Core owns canonical employee IDENTITY** — `nameKey`, name, store, role, active, hireDate.
- **GX Crew owns the rich attributes** and **writes the identity slice + celebrations + perks up**.
- **Reads from GX Core:** identity and the sales cache (`GXCore.getSalesDaily`).
- **SPIFF payouts do NOT reach Crew. There is no `spiff_payouts` tab** — not in `GX_TABS`, nothing
  writes or reads it. Do not build on the assumption that it exists.

## Extract-first sequencing (important)
The bonus math needs **per-employee, per-transaction** data with discretionary-discount
classification, which is **not** in the GX Core daily cache (per-store daily only). **First** promote
the per-employee metrics and the discretionary-discount definition to a shared home, **then** cut
Crew over. Do **not** move the UI before the math has a shared home. Coordinate with `core-admin`.

**Payroll safety:** completed pay periods are **frozen once** ("these numbers paid people") — carry
that caching discipline over exactly, and never cut over live payroll numbers without a
**penny-match** against Crew's own current incentive output for a full pay period. *(Corrected
2026-10-09, Sky's call: this named Leaderboard's incentive output, whose engine was retired 2026-09-14.
Crew's is the reference now.)*

## The roster is a two-pane workspace
Roster is Crew's only tab (the Review and EoM tabs are gone). Left: people grouped by store. Right:
one person's record, or the **overview** (stat tiles, open-questions queue, Employee-of-the-Month).

- **The displayed name is a RENDERING, never written back.** `displayName()` joins `preferred_name`
  to the legal surname. The record header is deliberately **not an input**: saving it would put a
  nickname into `full_name`, the column METRC and payroll match on. Legal name and nickname are
  edited as their own cards. `byName`, `searchRows` and the EoM reign log all use the displayed
  name (the log falls back to its stored name only for someone no longer on the roster).
- **There is no Edit mode and no Save button.** Text commits on a 600ms pause and on blur, selects
  and dates at once, with an undo toast. Do not reintroduce an arm-then-save gate.
- **One field per write, and both routes are PATCHES.** `roster_save` and `roster_identity` treat an
  absent parameter as "leave alone" and an empty one as "clear", and both read-merge-write. Posting a
  whole record lets `gxWrite_` blank `dutchie_employee_id` and `user_id`.
- **"New here" is a setup gap AND signs of recent arrival** (`hire_date`/`wage`/`store`/`role`/
  `employee_number` missing, **and** no hire date, no number yet, or a start inside 90 days). Both
  halves are load-bearing.
- **`pay_type` decides whether an empty wage is a gap.** Closed set, checked server-side: `hourly` /
  `salary` / `none`; empty means hourly (`rowFlags_` raises the `wage` gap). **It cannot be inferred** from `Admin` or `corporate` —
  hourly staff hold both. The old `not_on_payroll` column is still read as a fallback meaning
  `none`; `ATTR_HEADERS` only appends.
- **No open-question count in the sub nav.** Back to the overview is **Escape** (ignored inside an
  input or select, where it reverts the field), **clicking the open person again**, or the **Roster
  tab**.
- **No "All" store pill** — click the lit pill again. `tests/roster_filter_test.js` pins the set,
  order, counts-before-the-store-filter, dim-don't-disappear, and the three stacked filters
  (`scopedRows` → `searchRows` → `filterByStore`); every failure there hides people, not errors.
- **The OLCC permit card is read-only** (METRC owns it; an import overwrites it). **One exception:**
  with no permit number on file it shows two inputs and an Add button, because `missing_permit` is
  HIGH severity and "Mark handled" only acknowledges. `saveRosterAttrs_` allows exactly this write.
- `design_handoff_roster_workspace/*.dc.html` is a **reference prototype**, not shippable code.

## Layout
- **Frontend:** `index.html` + `crew.js?v=N`. That **`?v=N`** is the single source of truth
  `deploy.sh` reads for the version — bump it on every ship.
- **Engine deploy:** `clasp push` then `clasp update-deployment <id>` — **redeploy the existing id**,
  never `create-deployment`, which mints a new `/exec` URL and orphans `cfg.crewEngineUrl`.
  `clasp create` clones the remote manifest over the local one and wipes the GXCore binding; restore
  `appsscript.json` from git before the first push. (`clasp open` is `open-script` in v3.) First
  setup only: `clasp create --type webapp --rootDir apps-script`.
- **The GXCore pin is deliberately not written here.** Ask `?action=health` (`lib` = what the LIVE
  DEPLOYMENT runs, the only pin that matters) or `./gxpins.sh --live`. A manifest bump that was never
  deployed still runs the old snapshot. **Floors**, not current pins: **v150** read-merge-write on
  `gxUpsertEmployee` is unconditional and a live `full_name` cannot be blanked · **v201** store
  matcher (`GXCore.resolveStore()` with the Rd/Road fold and the per-execution memo) · **v211** bug
  reporter `context` (below it the snapshot is dropped **silently** and the report still returns ok)
  · **v225** `GXCore.setAvatar` · **v310** bug-filed email · **v311** that email carries JS errors ·
  **v312** `mailed` / `mail_error` / `mail_skipped`.
- **Bug reporter:** gx-theme's `gx-bugreport.js`; Crew supplies only `initBugReport()` and the
  `bugreport` route, which forwards to `GXCore.gxIngestBug`. The action is **`bugreport`** — do not
  copy Sales' `reportbug` or Price Cards' `reportBug`.
  - **A report that reached the sheet has succeeded, and mail must never be what stops it.**
  - **Core owns the success-path email; Crew must never add a second.** Crew mails Sky itself only on
    the two failure paths (`reportBug_`), which carry **separate de-dupe keys** because they say
    opposite things: *not on the board, re-file it* and *on the board, do NOT re-file, here is the
    id*. Do not delete those two sends as strays, and do not merge the keys.
  - **A REFUSAL IS NOT A THROW.** `gxIngestBug` answers `{ok:false, error}` without throwing; read the
    return, never key the fallback on an exception.
  - **GATE ON THE PRESENCE OF `mail_error` / `mail_skipped`, NEVER ON THE ABSENCE OF `mailed`.** A
    deduped repeat carries no mail field at all, so an absence rule fires on every repeat. The
    code is `res.mail_error || res.mail_skipped`.
  - **Crew still tells the REPORTER on a refusal** (Leaderboard does not). The unfiled notice carries
    the report text and says the reporter already knows.
  - **No new OAuth scope:** the digest already uses `MailApp`. Pinned by
    `tests/bug_mail_fallback_test.js`.
  - **The snapshot deliberately omits the search box contents** — `bug_reports` is shared and shown
    in the Command Center, so a report must not carry an employee's name out. `searchActive` says a
    filter was on.
- **Local loop:** `python3 serve.py` → <http://localhost:8755>. The backend is **live**; `gx-dev.js`
  blocks writes until armed; `gx-preflight.sh` is a **pre-push hook** and runs
  `tests/identity_test.js`. Those cover identity and date invariants only — **nothing there covers
  pay**; for pay the check that counts is the **penny-match**.
- **Shared dev files** (`deploy.sh`, `.claude/` hook + settings) come from gx-theme via
  `./gx-sync.sh`, filled from `.gx_app`. This CLAUDE.md is intentionally **not** synced.

## Boot is one Crew-engine call now, not three
- **`roster` takes `parts=review,eom_history`** and folds both into its response from the same
  `rosterJoin_()`. Each part has its own try/catch (`reviewPayload_`, `eomHistoryPayload_`) and
  arrives as `{ok:false, error}` on its own key rather than taking `rows` down.
  `eom_history` carries `current_holder`, so `boot()` reads `state.eom` off the folded response and
  makes no GX Core `config` call for `cfg.eom`.
- **Feature-detected, not version-gated.** `crew.js` always sends `parts=`; an older engine ignores
  it, `foldRosterParts()` reports `gotReview`/`gotEom` as `false`, and `boot()` falls through to
  `loadReview()` / `loadEom()`.
- **`ROSTER_CACHE_TTL` is 600s, so every writer of identity or the attribute sheet must call
  `bustRosterCache_()`** — a stale roster in a payroll app is worse than a slow one.
  `tests/roster_cache_bust_coverage_test.js` scans every function in `Code.gs` and fails a writer
  that forgets (`seedIdentityCommit()` / the `seed_commit` route was the one that had been missed).
- **The cached attrs row index (`writeAttrs_`) is verified against the live cell, never trusted
  blindly** (a wrong index overwrites the wrong person); a miss or failed check falls back to the
  full scan.
- **`stamp` is served from `CORE_EMP_CACHE_KEY` on the screen path only; every write computes live**
  (`tests/core_employees_cache_test.js`).
- **Read the `timings` on the payload before believing any speed figure**, in any doc. There is no
  slow calculation left; the variance is the `/exec` hop and `perf_fetch`.
- Tests: `roster_boot_fold_test.js`, `roster_boot_client_fold_test.js`, `attr_index_cache_test.js`.
- **Nothing ships to GX Core, gx-theme, or Crew's live engine without Sky's word first in this
  chat.** (made explicit 2026-10-09; previously implied by "Boot is one Crew-engine call now, not
  three", which cited it as "the standing rule")

## Sign-in runs on Crew's OWN engine
The `login` route calls `GXCore.login` **in-process**, so sign-in does not queue behind GX Core's
shared `/exec`.

- **The route is ungated, on purpose. Do not add the deploy secret to it** — it would travel in the
  URL of an unauthenticated request, and `UrlFetchApp` puts whole URLs into its exception messages.
- **`GXCore.login`'s payload is returned WHOLE** — token, expiresAt, user (the **slug**), role,
  displayName, avatarConfig. `setSession` reads three of them; do not keep only `r.user`.
- **A library that cannot answer is not a bad password.** Unbound `GXCore`, a pin with no
  `login()`, and a call returning nothing each say so in their own words.
- **`engineNow()` must never call GX Core.** It uses the remembered URL, else `ENGINE_URL_FALLBACK`,
  and never blocks; `boot()` runs the real `resolveEngine()` after sign-in succeeds.
- **Retry the transport, never a refusal.** A parsed `{ok:false}` is the server's answer;
  re-sending it hammers Core's login throttle. `getJSON` is a bounded fetch (per-attempt
  `AbortController`) that reads the body as text so the Drive HTML page reports as a bounce.
- Crew's own `/exec` still has the ~6% second-hop flake; that is what the two retries are for.
- Crew still calls GX Core by browser JSONP for **stores** and **config** at boot; moving those is
  Sky's call.

Pinned by `tests/login_transport_test.js`.

### One list of credential parameter names — accepted and redacted by the same array
`AUTH_PARAM_NAMES_ = ['token', 'session', 'auth']` in `Code.gs` is the only place those names are
written. `requireCrew_` reads the credential through `authParamValue_`, and `SECRET_PARAM_RE_` is
**built** from the list (`SECRET_PARAM_NAMES_` = `secret`, `key`, `pass`, `password` + that array).
**Do not add a name to one half.**

- The list must not be **shorter** than GX Core's `GX_AUTH_PARAMS_` (Crew's gate delegates to
  `GXCore.requireAuth`); longer is harmless.
- **The scrub is on the SERIALIZED reply body in `json_`** — the only `ContentService` call in the
  engine — not on the router catch. It matches `?name=` / `&name=` only; **a JSON *field* called
  `token` is left alone on purpose** (that is how sign-in returns the session).
- **Every email is scrubbed, because `sendMail_` is the only `MailApp.sendEmail` call in the
  engine.** Do not add a second call site. `bugNotify_` scrubs too.
- **The two Script-Property logs are scrubbed AT THE WRITE, not only at the replay** (the digest's
  and the backup's `note()`); `backupHealth_` renders `last.error` into the Monday email.
- **Never read `p.token` at a call site.** `authParamValue_` is the only sanctioned reader.
- **THE WILDCARD IS ON BOTH SIDES OF THE CREDENTIAL WORD.** The list is a list of **words**, not
  whole parameter names (`sessionid=`, `tokenValue=`, `connector_session=` all redact). There is
  deliberately no second list of prefixes or suffixes.
- **Accepted cost (Sky, 2026-09-16): a parameter whose name merely CONTAINS a credential word is
  redacted too** (`?keyword=`). Do not narrow the regex to recover one; the test goes red on purpose.
- The router returns `err.message` only and references `.stack` nowhere; every catch returns
  through `json_`. Keep it so.
- `tests/error_scrub_test.js` **executes** the real helpers, and its protected names are a
  **hardcoded floor** — never iterate the source's own array in that test.
  `scripts/prove-scrub-red.js` removes one scrub at a time on scratch copies; a removal costing
  **zero** assertions is a failure. Mutations run on a copy, never on `Code.gs` (`CREW_ENGINE_SRC`;
  nothing in the repo or push gate sets it).

## gx-theme is core-admin's — send a request, don't edit (rule from Sky, 2026-08-20)
**Never edit `greencross-gx-theme` from this chat.** Five apps load its files live from Pages, so a
change reaches all of them inside the 10-minute cache with no deploy and no review. `add_note` to
`core-admin` saying what and why.

**Do not restyle a shared component from inside Crew either** — a local rule that beats
`.gx-btn-green` or `.gx-input` silently diverges from the other five. The test is *"should all six
get this?"* `gx-sync.sh` pulls **from** gx-theme; it is a one-way read, not an editing channel.

## The HUB is core-admin's too — send a note, don't edit (rule from Sky, 2026-09-02)
**Never edit `greencross-command-center` from this chat.** Two sessions cannot share a Dropbox git
checkout. **`add_note` to `core-admin` with what you need and why, and stop.**

- **Reading the hub is fine and often necessary** — `gx_core.gs` and `gx_dutchie.gs` are the source
  of truth for every route Crew calls. Read, never guess a payload shape; run `./gxpins.sh`.
- **Calling GX Core's HTTP routes is not editing it** (`deploy.sh`, `gxengine.sh`, `set_config`,
  `bug_update`, `resolve_note`, `add_note`). Changing a *setting* through `set_config` is Crew's;
  changing *code* is not.
- **Crew's own engine and repo are yours** — `clasp push` / `gxengine.sh --deploy` touch only this
  project.

## Shipping — branch + PR, because Crew is LIVE
**Crew is live to Sky and Mike.** A **feature** goes on a `feat/…` branch with a PR and **Sky
merges**. A **small fix** that is correct the moment it lands ships direct to `main`. After a merge:
bump `?v=N` on the `crew.js` tag, `./gxengine.sh --deploy` for the engine, then `./deploy.sh`, then
`dev_ship` the job if there is one.

- **Do not restore the old "pre-launch, push to `main`" rule for `crew` on the argument that a
  change is small or that Mike will not notice.** The approval, the Capstone export and the frozen
  history are what a person is paid on.
- **If a rule here depends on a condition, write what is true NOW and re-date it** — never leave an
  "until X" that no test, route or script will evaluate. Same for versions and values: do not write
  a number in this file that nothing can contradict.
- Still per-app: `spiff` is pre-launch and works direct on `main`. GX Core library cuts stay
  PR-gated regardless.

## System of record — Crew, not the spreadsheet (decided 2026-08-18)
`GreenCross_Staff.xlsx` built the initial roster and is now **history**. **GX Crew, backed by the GX
Core `employees` registry, is the point of truth for people data.** `hr_import` defaults to
**fill-only** — it writes a field only where the current value is empty; overturning a held value
needs an explicit `mode=overwrite`. A superseded source must not be able to contradict the record.

- **`employee_number` is issued, never typed** — `assign_numbers` allocates `max(ever seen) + 1`,
  counting retired and merged rows, so a number is never reused. `00` is reserved for the owner,
  outside the sequence. `set_number` (deploy-secret) is the only override.
- **Every write to GX Core is read-merge-write.** `gxWrite_` replaces the whole row, so a partial
  write blanks `dutchie_employee_id` (SPIFF/Leaderboard attribution) and `user_id` (email link).
- **Leading zeros need plain-text columns.** Sheets coerces `"00"` to `0`; `employee_number`,
  `birthday` and `permit_number` are pinned to `@`, and number comparisons are numeric.
- **Never reach the HR workbook through a path that can create one:** `crewSheet_()` *creates an
  empty spreadsheet* when it cannot open the real one (see Backups). (made explicit 2026-10-09;
  previously implied by "Backups — the whole spreadsheet, to a shared drive")

## METRC is the source of truth — once we have API access (decided 2026-08-22)
The `metrc_*` connector is written but **not connected** (`METRC_BASE` on the sandbox,
`METRC_USER_KEY` unset, so `metrc_health` reports "Missing keys"). Its only consumer is `metrcAccessAudit_` — **names only, no writes**.

- **API access is IN PROCESS — do not delete the connector (Sky, 2026-09-08).** Leave `METRC_BASE`
  on the sandbox until real keys arrive. This is the opposite of SwipeClock, which was deliberately
  abandoned.
- When connected, METRC is the authority for `permit_number` (the export's **License Number**),
  `permit_granted`, `permit_expires`, `permit_status`, and the **legal first + last name spelling**.
- **`hire_date` is NOT on that list. A METRC sync must leave `hire_date` alone** — METRC's *Hired*
  is the date the person was added to that license. It is plausible only for someone on **one**
  license with a non-bulk date, and even then it is a proposal for a human, not a value to write.
- **METRC wins on spelling, not capitalization** — a sync must not copy its casing through.
- **`Employee Role` is empty and `Home` is a METRC landing page**; neither maps to `role_title` or
  `home_store`.
- **Dutchie is not trustworthy for legal spelling** (an admin can type a nickname there, which the
  identity seed carries into `full_name`). On a Dutchie/METRC name disagreement, **METRC wins**.
- **Do not route a METRC name ingest through `hr_import`.** `full_name` is in its guarded list, so a
  correct legal name is *silently skipped* (reported only under `matched_despite_name_drift`);
  nothing errors. Fill-only **is** right for the permit
  columns, which are usually empty.
- A sync must either post `review_report` items (`name_spelling`, which `resolveReview_` applies
  through `saveIdentity_` and records the rename alias) or write its owned fields explicitly.
  **`review_report` replaces the whole `crew_reviews` tab wholesale** — a sync must re-post what it
  did not author.
- Accepting a `name_spelling` item writes `full_name` **only**; `preferred_name` is a separate edit.
- **Exports do not name a store and the registry has no license column.** Known: **050-16892 →
  `portland-rd`**. The other five (050-12997 / 13000 / 13003 / 13006 / 13009) are unmapped; identify
  one from the people who appear on that license only (six staff with company-wide access sit on
  all six).

## Nightly Dutchie scan — it REPORTS, it never writes
`nightlyDutchieScan()` runs at **05:00 store time**, compares Dutchie's active people with the GX
Core registry, and parks anyone unmatched in **`crew_pending_hires`**.

- **It creates nobody.** Each find is a **`new_hire`** review item; accepting it is the only path to
  a write, and a human presses it.
- **Matching is `hrImport_`'s ladder** — exact `employee_id`, then a merge alias, then `samePerson_`
  fuzzy. Do not write a second detector.
- **A failed Dutchie read changes nothing** — an empty read returns an error, never "no new hires".
- **Its own tab, deliberately not `crew_reviews`** (`reportConflicts_` replaces that one wholesale).
- Routes: `new_hires` (run now) and `install_triggers` (`confirm=yes`), both deploy-secret.
  `ScriptApp.newTrigger` needs `script.scriptapp`, so a first install may need the owner to run
  `installNightlyScan()` once from the editor.

## Monday digest — and the Apps Script auth trap it walked into
Mailed **Mondays 07:00 store time**: the scan's findings plus permit and gap counts (the roster
overview minus Employee of the Month).

- **Recipients are a per-person setting, not a list in the source** (`digest_opt_in`), and need a
  **GX account** — with none, the control says so rather than storing a preference.
  **`user_id` is the MAILBOX NAME, not an address** (`createAccounts_` derives it as
  `email.split('@')[0]`); the address is `user_id@greencrosscanna.com`
  (`ACCOUNT_DOMAIN`). The GXCore library exposes no reader for the real address.
- **There is deliberately no fallback list.** Nobody opted in means the send reports it went to
  nobody.
- `?action=digest` previews, `&send=yes` sends, `&to=` overrides. Every attempt records its outcome
  and **source** (`editor` / `webapp` / `trigger`); `?action=mail_check` reads it and lists triggers.
- **Adding a new OAuth scope does not re-prompt** (`MailApp` needed `script.send_mail`). Running a
  function from the editor grants your account, not the deployment (`executeAs: USER_DEPLOYING`);
  **`clasp update-deployment` never raises a consent prompt**; `sendDigest_` catches the auth error,
  so a refused send logs as *Completed* (`sendDigestNow` rethrows).
- **What works:** revoke the project at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions) → *Remove access*,
  then run `sendDigestNow()` from the editor. **The engine is down between those two steps.**
- **`oauthScopes` IS declared, and the list is the GRANT, not a guess.** `?action=scopes_check`
  (deploy-secret, read-only) returns the deployment's real scope list. `userinfo.email` and
  `script.container.ui` are declared to keep list == grant.
- **`tests/oauth_scopes_test.js` fails a push** that calls an undeclared scope's service or declares
  a scope outside the recorded grant. To add one: revoke-and-reconsent first, confirm with
  `scopes_check`, then move the test's `GRANTED` list.

## Avatars are written by GX Core now
`GXCore.setAvatar(ref, config, by)` (v225) is the single avatar write in the suite: seed pinned to
`employee_number`, lock contention retried, a clear NAMED in `clear=` and then verified.

- **`roster_identity` delegates when the avatar is the ONLY change**, sending a patch of
  `{ employee_id, avatar_config }`. An avatar arriving **alongside** other identity fields stays one
  atomic row write and stamps the seed locally (`avatarSeed_`) — do not split it.
- **The `avatars` and `avatar_save` routes are gone** (with `avatarSave_`, `avatarsForKiosk_` and
  `resolveEmployee_`) and must not come back. `avatarSeedFrom_`
  **stays** (`rosterJoin_` and `migrateLeaderboard_` re-derive the seed at read time). Pinned by
  `tests/avatar_write_test.js`.

### …and the PICKER is gx-theme's too
`GXAvatarPicker` (`gx-avatar-picker.js` + `.css`, loaded **by URL**) is the one builder. Crew
mounts it; it does not own it.

- **The avatar circle in the record header IS the control** — a real `<button>` (`.crew-avabtn`),
  the only way in.
- **Crew passes a real `seed`: `row.avatar_seed`.** Do not "simplify" this to
  `row.employee_number` — that is blank for the unnumbered, who would get DiceBear's `unknown` face.
- **`showLeaderboardPreview: false`, and never `.gxava-full`** — stated, not relied on as defaults.
- **`clothingGraphic` is lost on re-save** through the shared picker; requested from `core-admin`.
  Do not add a local table.
- `tests/avatar_picker_adoption_test.js`: both files loaded, no vendored copy, no local `.gxava-*`
  override, `avatarPanel` gone. Click → save → reload → remove needs a browser.

## Incentive — transplanted from Leaderboard
**GX Crew is the payout app** — the bonus math, the attendance/SPIFF inputs, the Capstone export
and the approval. Performance comes from GX Core.

- **`fetchLivePerf_` reads GX Core's `incentive_perf`, full stop.** `cfg.incentiveEngine` is no
  longer read and the Leaderboard fallback (`fetchLivePerfLeaderboard_`, `incentiveEngine_`,
  `incentive_compare`) is deleted. **Do not add a fallback engine** — if the one source cannot
  answer, the screen says so.
- **GX Core sends NO thresholds**; Crew reads the scheme from kv. `lb_agrees` is **always `null`**
  with `lb_check: 'not applicable…'`; the field is kept so nothing reading it breaks, and a scheme
  that turns up on the payload anyway (`live.thresholds`) is ignored. **Never read `lb_agrees` for
  truthiness** (it also surfaces as `leaderboard_agrees`) — `null` coerces to `false`. Pinned by
  `tests/threshold_agreement_test.js`.

### A period is served from one of two places, and the payload says which
- **`imported`** — a closed period from the 27 payout PDFs (2025-08-04 → 2026-08-16) or one Crew
  has approved. Figures **as paid**. Read-only, never recomputed.
- **`live`** — the performance slice plus Crew's inputs, with the math running in the browser.
- **`practice`** is a separate field, not a third `source` (below).

Where they overlap the **import wins**. **Never recompute a closed period** — the benchmarks have
moved, so the PDFs are history, *not* a penny-match corpus. **Read `budtender.discountMaxPct` from
the tray, never from a doc.**

### Which period the tab opens on, and in what order
- **With no period asked for, the tab opens on the LAST completed fortnight until it is approved,
  then on the running one** (`defaultIncentivePeriod_`). "Approved" means **in the real history
  tab** and nothing else — a period only *sent*, or **reopened**, keeps opening on the old one.
- An explicit `pp_start` is honored exactly. No `cfg.payPeriodAnchor` means the running period. The
  payload's `defaulted` says when it chose.
- **Grouped by store is the default view**; a period change restores it. Stores are alphabetical by
  the printed name (`incByStore`), corporate and unresolved last. **Display only — the Capstone
  export keeps Capstone's block order.** Pinned by `tests/incentive_defaults_test.js`.

### The practice pay period — rehearse the close without paying anybody
A real fortnight under a different key: `practice-2026-08-17` is where rows go; `2026-08-17` is the
fortnight fetched and scored. Real staff, real numbers.

- **The isolation is the TAB, not a filter.** Each of the five incentive tabs has a `_practice`
  twin (`crew_incentive_history_practice`, `crew_incentive_inputs_practice`, …) chosen by
  `incTab_(BASE, pp)`, the one place the suffix is written. Never keep practice rows in the real
  tabs and filter them out. **Practice never appears in any enumeration of what the company
  actually closed** — `historyPeriods_()`, the Capstone export, the digest, the payout backfill.
- **THE ONE WAY THIS GOES CATASTROPHICALLY WRONG is confusing the storage key with the performance
  window.** Storage key where the window belongs → SPIFF scores **$0 for everybody**. Window where
  the key belongs → a rehearsal writes ticks, frozen rows and an **approval into the real pay
  period**. So: **fetch and score against `practiceSource_(pp)`, store against `pp`**, and the SPIFF
  fold runs *before* the key is swapped in, on both `getIncentive_` and `incentiveApprove_`.
  Pinned by `tests/practice_period_test.js`.
- **`source` KEEPS ITS TWO VALUES — `live` and `imported` — and practice is a SEPARATE field.**
  Never set `source: 'practice'`. `isImported` derives from `source` and every money path hangs off
  it (`budCalc`/`mgrCalc`, `paidOf`, the attendance cell, whether Approve renders). `d.practice` is the only
  thing `incIsPractice` reads. `can_reset_practice` is its own flag (a ROLE question), not
  `can_edit`.
- **`payPeriod.start` is rewritten to the key** in the engine; the browser knows only `incPPDate`
  (a key is not a date — an unstripped key yields `''` and a file named `GX Crew.pdf`) and
  `incIsPractice`.
- **Everything that leaves the app says PRACTICE on it**: the PDF's filename *and* first line, the
  CSV filename, the email **subject**, and an on-screen banner deliberately **not** in the print
  hide list. The badge is red. Practice PDFs file to a `Practice` subfolder.
- **`incentive_practice_reset`** deletes the practice tabs (`sheetOf_` recreates them) and **cannot be pointed anywhere else**:
  it builds the key from `cfg.crewPracticePeriod`, takes no period from the request, and refuses if
  any name it would clear does not end `_practice`. Editor-level. **Reopening does not reset.**
- It mirrors the last COMPLETED fortnight (`cfg.crewPracticePeriod` pins another), is offered
  **last** in the picker, and is always there rather than behind a flag.

### There are TWO implementations of the bonus math, on purpose
The browser's (`calcBud`/`calcMgr`/`calcAdmin`) runs on every keystroke; the engine's
(`incCalcBud_`/`incCalcMgr_`/`incCalcAdmin_`) runs once, at approval — a route that writes whatever
amount the page hands it lets a stale tab decide payroll. **`tests/incentive_math_test.js` drives
BOTH against a frozen copy of Leaderboard's originals** (12,040 boundary combinations). **Do not
touch either without running it.** The oracle is frozen on purpose; do not point it at
`../greencross-leaderboard`.

### Approval — Mike prepares, Sky decides
```
draft ──send──► pending ──approve──► approved (immutable, in history)
  ▲                │
  └──send back─────┘  reason required, emailed to the preparer
```
- Sending **locks the inputs** server-side for everyone, approver included. Approval is the only
  thing that writes.
- **`incentive_unapprove` is the break glass, and it voids rather than deletes** — rows are copied
  to `crew_incentive_voided` with who and why. It is an approver-only **button** (same
  `cfg.crewApprover` gate as Approve), needs a typed **reason of at least a sentence**, refused on
  both sides, and an explicit confirm naming the period. The deploy-secret path still works.
- **`incentive_voided` reads the trail back**; the panel diffs frozen against live.
- **A calendar day is TEXT.** `pp_start` on the void sheet is pinned to `@` and normalized on write
  *and* read — as a Date it never equals `2026-08-17` and the route answers "never reopened".
- **A reopened period is not a sent-back one.** `workflow.voided` is derived server-side from the
  `VOIDED:` prefix; the browser does not parse prose.
- **Who approves is NOT a role check** — GX Core's roles are `viewer/editor/admin/director`, there
  is no `owner`, and Sky and Mike hold the same grant. The approver is named in GX Core kv
  **`cfg.crewApprover`** (`sky`; read by `approverIds_`). Unset, nobody can approve and the screen says so — failing closed beats letting the preparer
  approve their own work.
- Email links carry a single-use 72-hour token bound to the period **and the total that was sent**
  (`sent_total`).
- `?action=incentive_send&preview=1&secret=…&to=…` dry-runs the email with no state change.

### The backup approver — always allowed, emailed only when needed
Named in GX Core kv **`cfg.crewBackupApprover`** (`shawn`). **The backup may approve or send back ANY time.**
What waits is his inbox — he is emailed only while:

- **away** — *I'm away* is on (`approver_away`, a script property). A send while away mails him at
  once; switching it on sweeps anything already waiting.
- **waiting** — `pending` for **4 hours** since `sent_at` (`BACKUP_AFTER_MS`). The
  `approvalEscalationSweep` trigger (every 15 min, installed by `install_triggers`) mails him once
  per send, keyed `pp|sent_at`, so a re-send re-arms the clock.

- **Sky is emailed whenever the clock brings the backup in, and whenever the backup decides
  anything** — that notice replaced the lock; do not drop it as noise.
- **`canApprove_` still means the PRIMARY** and gates the tray, reopening, voided figures and payroll
  overrides. `canDecide_(auth, pp)` (primary or backup) is what approve/return use (`can_decide`).
  The preparer is not an approver unless named.
- **Practice periods never escalate on the clock.**
  `?action=approval_escalate&force_pp=practice-…` (deploy-secret) forces one and refuses a real
  period.
- The backup's Crew grant is `editor`, so he can also edit the roster.

Pinned by `tests/backup_approver_test.js`.

### Two copies of one pay write at once — `withPayLock_`
Retries make overlapping executions real. `approve`, `send`, `return`, `unapprove` and `save` take
the script lock around **the re-check and the sheet writes only**, flush, and release.

- **Never widen the lock around the performance fetch, the Drive filing, the backup or an email** —
  it is the lock every roster edit waits on. A lock it cannot get is a worded refusal that says
  nothing was saved.
- **One-time request ids cover a copy stalled for minutes.** `crew.js` mints one `request_id` per
  click (`payRequestId()`) into the params object, which gx-client re-sends on every retry. The
  engine checks and records it **inside `withPayLock_`**, in **`crew_pay_requests`** (kept 7 days);
  a second arrival gets the first answer with `already_applied: true`, which the screen treats as
  done. Script cache is only a hint; the sheet is the guard.
- **Refusals decided under the lock are remembered too. Refusals returned before the lock are not**
  (auth, missing fields, blockers) — the known limit, pinned by the test.
- **No id = old behavior** (tooling still works). A malformed id is refused before anything runs.
- **Never mint the id inside a retry**, or per call to a helper that retries. One id per
  person-action.
- `roster_retire` and `roster_merge` need neither (both converge on a keyed upsert).
- **`?action=pay_audit` (deploy-secret, read-only)** finds duplicate people in a closed record,
  duplicate inputs/workflow/scheme rows, and rows voided twice. It reads tabs **by position**:
  `crew_incentive_voided` and `crew_incentive_inputs` have header rows older than their columns.

Pinned by `tests/pay_period_race_test.js` and `tests/pay_request_id_test.js`, which run the real
routes through `tests/pay_engine_harness.js`.

### Things that silently pay the wrong amount
- **SPIFF is vendor money.** In Bonus, never in Payroll, never in the export. Budtenders subtract it
  out (`bonus - spiff`); managers add it on. Same rule, opposite construction.
- **One identity key: `employee_id`.** The performance slice sends its own `nameKey`
  (`chris_carney`) where GX Core uses `christopher_carney`; keying inputs on nameKey finds nothing
  and computes as if nothing was entered. `stampEmployeeIds_` attaches the id, legal name and middle
  initial to every live row.
- **A `merged` record is a tombstone**, still returned by `getEmployees()` and still matching on
  name. Filter it out. `retired` is NOT the same — those people really worked those periods.
- **`GXCore.getEmployees()` has no `display_name`** (GX Core's *HTTP* route adds it). Match on
  `displayNameOf_` — do not write a second one.
- **`discount` is a DECIMAL on live rows and `discount_pct` a PERCENT on imported ones.** Off by
  100×, and both readings look plausible.
- **`''` and `0` are different claims.** The oldest report has no payroll column; those rows export
  empty, because 0.00 tells payroll to pay nothing.
- **Never give a helper a name that already exists in `Code.gs`** — a second definition silently
  wins (`ppDaysBetween_` exists because `daysBetween_` was taken). (made explicit 2026-10-09;
  previously implied by "What independently checks these figures")

### The settings tray — thresholds AND discount rules in GX Core
- **Thresholds live in GX Core kv as `incentiveThresholds`. Deliberately not a `cfg.` key** — that
  prefix is public on `?action=config`, and comp policy must not be readable by anyone with the URL.
- Leaderboard's discount coloring reads `budtender.discountMaxPct` from the same value, in the
  order GX Core → its local property → its defaults; its per-execution memos (thresholds and
  `_discCfgMemo_`) must be **cleared at the top of `doGet`**.
- **Editing is the approver's, not any editor's.**
- **The tray's CSS is copied verbatim from `greencross-leaderboard/index.html`** (`.ist-*`,
  `.inc-tray-*`), with one scoped variable bridge (`--text`/`--green`/`--border` → `--gx-*`). **Re-copy on any change there rather
  than hand-editing, and keep the class names** — a rename silently unstyles a section.
- **Discount rules live in GX Core kv `discountRules`**: `{overrides:{"<name>":true}}`, `true` =
  **excluded** (does not count against the budtender). Read with `GXCore.getKv`; written through the
  secret-gated `?action=set_config`. **There is no `GXCore.setKv`.** `gxSetKvViaWeb_` is the one
  writer for both.
- **Names come from the registry, opinions from Core, and Core wins.** `discountRegistry_` reads
  three rungs: **Core's kv `discountRegistry` (published by Leaderboard) → Leaderboard's `/exec` →
  the names Core holds an override for**; `names_from` says which (`gx-core` / `leaderboard` /
  `overrides-only`). Leaderboard's own `excluded` flags are read and discarded.
- **Older than 14 days is still shown, with a warning naming the date** (`stale: true`); it does
  **not** fall back to Leaderboard on stale. **An empty, unparseable or list-less Core value falls
  back** — never render an empty tray. `overrides-only` is flagged `partial` and saving still works.
  The Leaderboard rung (`discountRegistryFromLeaderboard_`) is deleted when Leaderboard is.
- **The checkboxes mean COUNTED and the store holds EXCLUDED; the flip happens in the engine, never
  the browser.** The browser posts `count=` and `off=`, **newline-separated** (names contain commas;
  a real newline, not `'\\n'`), and only what **changed**. The engine read-merge-writes Core's map.
- **A failed Core read REFUSES the write rather than merging onto `{}`** — `set_config` replaces the
  whole value, so that would switch every rule back on. The retired `save=<every counted name>`
  format is rejected with "hard-reload".
- A Core write does not bust Leaderboard's caches; a rule change takes up to its ~6-minute TTL to
  show on the board. No `discountrules_save` call to Leaderboard survives here; keep it so.
- **Written 2026-08-30 and not re-verified since performance moved to GX Core — check before
  relying on it either way:** "Until Leaderboard reads `discountRules` from Core, saving a rule in
  Crew changes no number anywhere."
- **Tier lists are ORDER-SENSITIVE** — matched high-to-low, first hit wins — so `thresholdProblems_`
  refuses an ascending list by name. Ascending pays everyone the lowest tier they clear.
- **Manager store-discount cut-offs are derived** (`goal × ⅔` and `goal`) and render as text, not
  inputs.

Pinned by `tests/discount_rules_test.js`.

### Hours — $/hr is per-person, but nothing fills it
`$/hr` divides by a timecard when one is on file (`incHours_` / `incHours`), else by the flat
`thresholds.hoursPerPeriod`. Blank, zero, negative and unparseable all fall back to the flat figure.

- **Hours reach `$/hr` and nothing else** — not `bonus`, not `payroll`, not the Capstone export.
  `tests/incentive_math_test.js` pins it; if that fails, a timecard has started deciding pay.
- **`hr` is frozen into `crew_incentive_history` at approval, so the cutover is FORWARD-ONLY. Never
  backfill hours into a closed period.**
- `incCalcAdmin_` takes no `inputs` and is deliberately untouched.

#### SwipeClock is NOT being connected — the attendance upload is the answer (Sky, 2026-09-02)
- **Do not chase the partner ID, and do not build the connector.** Decided, not deferred.
- **`hours` stays writable and consumed but unfilled** — a live divisor with no source, not dead
  code. Do not rebuild its importer.
- **`swipeclock_code` stays** on `ATTR_HEADERS` (append-only) with its roster card, typed by hand.

### Attendance import — Mike's eligibility list
**Import attendance…** reads `Attendance_Bonus_List_<period>.xlsx` (`Store, Name, Attendance
(Yes/No), Notes`, plus a **Summary** sheet) and writes the ticks.

- **THIS ONE MOVES PAY.** A tick adds `attendanceBonus` to a budtender **and**
  `teamAttendancePerHead` to their store manager; both reach `payroll` and the Capstone export. The
  preview leads with **the dollar change in both directions** and a `confirm()` names it.
- **The money is computed the way the MATH computes it, not by counting heads**
  (`attendanceBonus + teamAttendancePerHead`, or the bonus alone where the store has no manager on
  the period). The test reconciles against `calcBud`/`calcMgr`.
- **A "No" writes a CLEAR, it does not skip.** The list is a complete determination.
- **A manager's own tick pays nobody** (`incCalcMgr_` counts THEIR budtenders). Those rows are
  written but reported in their own bucket.
- **Rows are classified by what saving them would DO**: *will change* / *already correct* /
  *written but changes no bonus* / *not on this pay period* / *could not read*.
- **Anything that is neither Yes nor No is skipped and named.** A **blank** does not clear a tick.
- **.xlsx is read in the browser with no library** (`impUnzip`, `impReadXlsx`,
  `DecompressionStream('deflate-raw')`, `DOMParser`), handling **both** string storages — inline `<is>` and
  pooled `sharedStrings`. CSV still works.
- **The sheet is CHOSEN, not assumed to be the first** — the one whose header names a person and a
  yes/no; else a column whose *values* are all yes/no.
- **Matching is name-only: exact first, then close spelling**, against both the display and legal
  name. Duplicates are reported, never allowed to overwrite.
- **Close spelling is narrow on purpose:** **exact surname**, first name **within two letters**,
  **exactly one** candidate (two is never picked), and never a person another row names exactly.
  Every hit shows **spelling differs** in the preview.

#### The whole list saves in ONE request — `incentive_att_batch`
- **The refusals are the BATCH's, checked before a single row is written** — a closed period, one
  locked pending approval, a read-only session.
- **ATTENDANCE ONLY, and that is a decision.** The batch route never reads spiff, hours or
  `payroll_override`.
- **ONE request id for the whole import**, minted once in the browser, checked and recorded inside
  the same `withPayLock_` as the writes.
- **It is NOT atomic and does not claim to be.** Each person is one read-merge-write; a row that
  cannot be written is named in `failed`. An id is queued at most once and new rows go in a single
  appended block after the loop.
- **The list travels as `<id>:<1|0>` pairs**, not JSON. Anything unreadable refuses the whole batch
  **by name** — a person quietly dropped is a bonus quietly withheld.
- **The preview and its confirm are untouched.**

Pinned by `tests/attendance_batch_test.js`, `tests/attendance_import_test.js` (exactly one engine
call, one id), and the batch sections of `pay_period_race_test.js` and `pay_request_id_test.js`.

### Floaters — one person, one row
A floater arrives **once per store**. Split, they qualify for nothing and count toward two stores'
attendance headcount. Sky's rule: aggregate the performance, book them to **Corporate**; their
sales still count toward each store but **not** toward its AOV, discount or attendance.

- **`is_floater` is a flag, deliberately NOT inferred from `home_store = 'corporate'`.**
- **Weighted, not averaged.** Discount is a RATE (weighted by sales), AOV a RATIO (recomputed from
  totals).
- **The attendance exclusion and "sales still count toward the store" both need no code** —
  `incTeamAtt` matches on the manager's slug, and store figures arrive on the *manager* row already
  aggregated. Do not "finish" either.
- **Only rows that resolved to the same registry person are merged.** An unstamped row keeps its
  own line; never fold on a name.
- Folded rows carry `folded_from` and render a **merged** label.
- **`dual_role`:** a floater who also holds an admin or manager row appears in two sections and
  **both rows pay, and that is intended** (Sky, 2026-09-02). `dualRoleRows_` detects it; the notice
  is **informational, in gold**, because it is also what a mis-attributed row looks like.

Pinned by `tests/floater_fold_test.js`.

### What independently checks these figures
| what | against what | when |
|---|---|---|
| the formulas | the frozen Leaderboard oracle, 12,040 boundary combinations | every push |
| the sales figures | **Dutchie's CLOSING REPORT**, per store (`storeTotals_`) | blocks approval + send |
| the payouts | what the scheme can produce (`ceilingProblems_`), and 27 closed periods (`historyBand_`) | blocks / warns |

- The closing report is a **different Dutchie source** from the per-transaction pull (`sales_daily`
  ← `/reporting/closing-report`; the slice ← `dutchieTransactions`) — that is what makes it a second
  opinion. Bars: **0.5%** on sales, **2%** on transactions.
- **Sum the `stores` map, NEVER budtenders + managers** (a manager's row carries the store's whole
  total). The check reads `live.stores` and runs **before the floater fold**.
- **Three states, never truthiness:** `ok` / `mismatch` / `unchecked`. **`unchecked` blocks too.**
  Acknowledged with **`totals_ok=yes`**; `coverage_ok` is a different question and **neither clears
  the other**. Both are written into the row note.
- **A COMPUTED payout above the scheme's maximum has nothing to acknowledge past.** An **override**
  above it only warns. Ceilings come from running the **shipped** calcs on a best-case row.
- **The ceiling check sits ABOVE the dry-run return**, so "Send for approval" refuses too.
- **The band skips periods whose payroll column is blank**, reads the real history tab only, and
  **warns, never blocks**.
- **The screen reports; only the write paths refuse.** A **pass is stated too**, on screen and in
  the email.
- **A void is not a sale** (`isVoid` on a `Retail` row); GX Core's `gxIsRetail_` tests both.
  Leaderboard's frozen snapshots of earlier periods carry the voids permanently — do not "reconcile"
  to them. (made explicit 2026-10-09; previously implied by "What independently checks these
  figures")

Pinned by `tests/independent_checks_test.js`.

### A missing store looks exactly like a store that sold nothing
GX Core catches a per-store failure into `slice.errors` and answers `ok:true` with that store's
sellers simply absent (`fetchLivePerfFromCore_`
maps field-by-field, a short list as faithfully as a full one), and approval would freeze that.
`incentiveBlockers_` holds the guards, beside `spiff_unreadable`. **THE DANGEROUS CASE IS ONE
STORE, NOT ALL OF THEM.**

- **`store_id`, NEVER `storeSlug`.** `storeSlug` is Leaderboard's vocabulary (`baseline`, `century`,
  `portland`, `river`); `home_store` is GX Core's (`hillsboro`, `bend`, `portland-rd`, `river-rd`).
  Only `center` and `commercial` coincide.
  `stampEmployeeIds_` resolves `store_id`.
- **ACTIVE staff only, and hire dates against the PERIOD** (`hire_date` vs `payPeriod.end`). Read
  live every time; never a typed-in headcount.
- **Corporate is not a store** — Sky, Mike and every floater (`foldFloaters_`) are booked there.
- **An unreadable registry is not a clean one.** `roster_stores` is `null` on a failed read and
  `{}` only on a real empty one, and the two produce different blockers.
- **It is acknowledged, not bypassed** — `coverage_ok=yes`, same shape as `spiff_unavailable=yes`,
  **written into every row's note**. Neither ack clears the other.
- **The screen reports it; only the write paths refuse.**
- **DO NOT DELETE THIS WHEN GX Core's `stores_failed` ARRIVES.** A cached payload can be older than
  the field and carries no version stamp, and `stores_failed` reports only a store that *errored*,
  not one that returned nobody.
- **When `stores_failed` IS wired in beside it, read it as THREE states, never for truthiness** —
  `undefined` / `0` / `>0` (refuse).

### `perfForWrite_` — the row shape, in one place
`incentiveApprove_`, the send preview and `getIncentive_` must produce identical rows, so all three
call `perfForWrite_(pp)` (fetch with the practice window/key split, stamp, fold). **Neither write
path fetches, stamps or folds on its own.**

- **Deliberately NOT in it:** the SPIFF fold, the threshold read and the practice remap — ordered
  differently on purpose. Do not fold them in behind a flag.
- `incentiveProbe_` still calls `fetchLivePerf_` directly, on purpose.

Pinned by `tests/roster_coverage_test.js`.

### "Send for approval" never worked, and it was not the email
- **The approver gate is on the WRITE:** `confirm === 'yes' && !canApprove_(auth)`. `incentiveSend_`
  (the preparer's button) runs `incentiveApprove_` as its dry run, so the dry run is open to the
  preparer; approving is still approver-only.
- **A send that mailed nobody does not leave the period `pending`.** `wfUnsend_` puts the status
  back and **clears the token**; a human-written note is not touched.
- **An unreadable `cfg.crewApprover` is not an unset one.** It still fails **closed**; it says
  *connection problem*, not "no approver is configured".
- **Only the non-approver sees "Send for approval."** Sky gets **Approve** directly, so **Sky cannot
  exercise the send button from his own login — Mike has to click it.**

Pinned by `tests/approval_send_test.js` (and `tests/button_busy_test.js` for the button itself).

### The approval email understated the total, and never said a human set it
- **Totals use `incPayroll_`, the single applier** — the figure a person **recorded**, not
  `c.payroll`. Never copy the rule; a preview that renders different NUMBERS is worse than one
  rendering different HTML.
- **The email names every adjustment** — amber block, diamond, **each person named** with what the
  math said and the reason. Never a count.
- It reads the rows about to be written — **14 `payroll`, 18 `computed_payroll`, 19
  `override_note`**. Those indices are positional and **`HISTORY_HEADERS` only ever appends**.
- A dry run reads "a preview run", or pass `as=mike`.

### The Print PDF filename — set when the view paints
- **`document.title` is set when the incentive VIEW PAINTS** (`Incentive Dashboard -
  081726-083026`), because Chrome/Safari settle the save-panel name before `beforeprint`.
  `beforeprint` stays as a backstop calling the same one function. Do not move naming into the Print
  button's handler (Cmd+P calls `window.print()` directly), and do not reintroduce a restore timer.
- It renames nothing unless the incentive slot is displayed (`ui.inc.style.display`); a missing
  date yields no name.
- **The listeners are guarded on `typeof window.addEventListener === 'function'`** — `crew.js` is
  loaded in Node by the test harnesses. Not defensive noise.

Pinned by `tests/print_name_test.js`.

### The payout PDF files itself to Drive on approval
Folder **"Incentive Program Payout Reports"** (`1rQAQsRDwzh0VvUWEqytdSuNtoHAz-fYW`).

- **It fires on APPROVAL, not from a button**, built from the exact `rows` written to
  `crew_incentive_history`. The name is derived, never typed.
- **A Drive failure must never fail the approval.** `filePayoutPdf_` catches everything and returns
  `pdf: {ok:false, error, fix}`. It is ordered **after** `wfSet_`.
- **A re-approval does not overwrite the original filing** — a collision becomes
  `… (reapproved YYYY-MM-DD).pdf`. Nothing is ever trashed.
- **The folder is a constant with a `cfg.crewPayoutFolder` override.**
- **A hand-set figure is marked with the ◆ diamond, not only colored.**
- **THE SCOPE TRAP:** `DriveApp` is the only Drive call, and Apps Script does not re-prompt for an
  added scope. Granting it: revoke GX Crew at myaccount.google.com/permissions, then run
  `pdfSelfTest()` from the editor. **The engine is down between those two steps.**
  `?action=pdf_check` (deploy-secret) writes a real file and trashes it.
- **`pdf_file` backfills an already-approved period** from its frozen rows and refuses anything not
  in history; `dry=1` reports.
- **Blank is not zero:** payroll, sales, AOV, SPIFF and bonus cells render a blank as an em dash,
  never through `Number(x) || 0`. A period with no payroll shows the **bonus** total with a line
  saying why. Genuine zeros still print `$0.00`.

Pinned by `tests/payout_pdf_test.js`.

### Backups — the whole spreadsheet, to a shared drive
`backupCrewSheet_` copies the **whole spreadsheet** (`GX Crew — HR data (PII: do not share)`) into
the folder named by GX Core kv **`cfg.crewBackupFolder`** — a **shared drive**.

- **Weekly**, Sunday 03:00 store time (`weeklyBackup`, installed by `install_triggers`), newest
  **12** kept, older ones **trashed**, not deleted outright.
- **On every real approval**, after the record and the PDF — **never rotated**. Practice periods get
  none.
- **No default folder.** Unset, it refuses and says so. A failed GX Core read uses the folder last
  confirmed (`CREW_BACKUP_FOLDER` script property).
- **Never through `crewSheet_()`**, which *creates an empty spreadsheet* when it cannot open the
  real one. A source with no pay rows is still copied but **nothing is rotated**.
- **A broken backup reaches a person.** `backupHealth_` fails on no folder, never run, last attempt
  failed, or more than 8 days late, and the **Monday recap shows a red card only then**.
  `?action=backup_check` (secret) reads it; `?action=backup_now&confirm=yes` makes one.
- The account Crew runs as must be **Content manager or Manager** on the shared drive. **Keep that
  drive's membership to people who may see PII** — the copy is the roster too.

Pinned by `tests/backup_test.js`.

### Print PDF came out blank — two print stylesheets
**Keep `index.html` to ONE `@media print` block.** Never blanket-hide
(`body * { visibility: hidden }`); hide named chrome. Crew's root is `.crew-inc-wrap`, not
`.inc-wrap`. `tests/print_css_test.js` asserts nothing blanket-hides the document and that every
`.crew-inc-*` / `.inc-*` class in a print rule is one the app renders.

### The payroll override — recording what was actually paid
`payroll_override` **overrules** the math: a typed figure that replaces the computed one and goes
to the Capstone export.

- **Approver-only**, the only field on `incentive_save` that is. The preparer sees the flag but
  never the pencil.
- **A reason is required and refused if under 5 characters.** Clearing the figure clears its reason.
- **AMBER, with a diamond** — a decision, neither good news nor an error.
- **It is applied AFTER the calc, never inside it** (`incPayroll_` engine / `incPaid` browser).
  `incCalcBud_`/`incCalcMgr_` stay byte-for-byte against the oracle.
- **`null` is not `0`.** A deliberate $0 override means "paid nothing" and beats the computed
  figure; an absent one must not.
- **It reaches the export and the totals** — otherwise the non-zero filter drops the person from
  the file entirely.
- **Approval freezes BOTH numbers.** `computed_payroll` and `override_note` are **appended** to
  `HISTORY_HEADERS`, because `incentiveUnapprove_` reads payroll as `all[i][14]`. Never insert a
  column.

Pinned by `tests/payroll_override_test.js`.

### The Capstone export is THEIR shape, not ours
ADMIN, then one block per store in **Capstone's order** (Century / Baseline / River / Center /
Commercial / Portland), surname-sorted within each. **The ORDER is theirs; the LABELS are ours.**

- **If a Capstone import ever rejects these rows, look at the labels first — reverting the three
  (SOUTH for Commercial, BEND for Century, HILLSBORO for Baseline) is the whole fix.**
- **Still a literal table, deliberately NOT read from the registry** — a store rename should make it
  *wrong and visible*, not different and plausible. Pinned with the block order by
  `tests/incentive_view_test.js`, whose fixture puts a person in **every** block.
- Header column is `Bonus`; the value is payroll. Names are legal, surname first, from `full_name`
  + `middle_initial`.
- **On screen, stores come from the registry** — `GXStores.name(store_id)`, never the row's label.
- **Three columns, and only people who earned something.** Anyone whose store does not resolve is
  still exported, flagged in the **Store** cell as `UNASSIGNED (<the label they arrived with>)`.
- **`0` is dropped; `null` is NOT.**
- **How many were left out is reported in a toast, deliberately not in the file** — Capstone would
  import a footer row.

### What the APPROVAL path computes
- **Approval folds SPIFF in before computing** (`applySpiffEarnings_`, then `incSpiff_`, mirroring
  the browser's `incInput`), so the measured `spiff_earned` is used, not only a typed `spiff`. **A typed 0 still beats the measurement**; only an absent one falls
  through.
- **A blank spiff cell is `null`, not 0** (`inputsFor_`), same as `hours`.
- **`approvalThresholds_` is the one threshold source for approval and the send preview, and it
  REFUSES rather than falling back** (the screen's `getIncentive_` reads `incentiveThresholds_()`). `freezeScheme_` records the scheme actually used.
- **An unreadable source must not freeze as an empty one.** A failed SPIFF read refuses the
  approval; `spiff_unavailable=yes` is the acknowledgement, written into every row's note. A
  *successful* read with no programs needs none.

### A SPIFF program belongs to ONE pay period — majority, not overlap
`earned` is one figure for a program's whole window. Three rungs, most authoritative first:

| rung | test |
|---|---|
| `pay_period` | the stored **range**'s start equals `pp_start` |
| `exact_window` | program start **and** end equal the period's |
| `majority` | more than half the window falls inside |

- **`pay_period` must never be compared raw** — it holds a range (`"2026-08-17 - 2026-08-30"`) or
  blank. `spiffPeriodOf_` takes the first date out of whatever is stored.
- **Only a RANGE counts as a pay period.** A bare date is a payout date: ignored and listed in
  `live.spiff.payout_date_pay_periods` — a cleanup queue, not a list of wrong numbers; do not narrow
  it.
- **Invariant: a stored `pay_period` may disambiguate and may raise a visible conflict — it may
  never silently cost a program a match its dates alone would have earned.**
- **The cleanup is a SPIFF code change, not data entry** — `pay_period` cannot be edited from the
  SPIFF UI. Don't send anyone to a screen to fix it.
- **A range contradicting exact dates pays ONCE — in the period the range names — and is reported
  on BOTH sides** (`period_conflicts`). `spiffIsPeriodWindow_` warns only when the dates are exactly **another** pay
  period.
- `live.spiff.loose_dates` names majority matches, `matched_by` counts the rungs, and a program no
  period owns pays in neither and is reported with its amount (`live.spiff.straddling`).

### `closed` means PAID OUT — the status filter that would have zeroed every approval
SPIFF's statuses: **draft** · **active** · **closed** (*paid out*).

- **`active` and `closed` pay; `draft` does not; `''` does not.** Never filter on
  `status === 'active'` — a period is approved after its programs close.
- `''` means SPIFF's `programs` tab has no row for that `program_id`; it is reported by name
  (`live.spiff.not_payable`), never dropped quietly. An **unrecognized** status is counted **and**
  flagged.
- **Payability is settled before the window is scored**, and **if no row carries a `status` key at
  all the filter is skipped entirely.** Both pinned by `tests/spiff_attribution_test.js`.
- A program spanning two fortnights, or a test program left `active`, is **SPIFF's to fix** — Crew
  reports both and does not code around them.

## Access
Owner + Mike to start (HR / managers later). GX Crew handles compensation + PII, so it is a
**separate deployment** from the all-staff kiosk Leaderboard — keep the sensitive surface isolated.

## Sync with the brain — run `/gxbrain` (or say "brain sync")
`/gxbrain` loads the shared rules and reconciles this chat with GX Core: it reads notes addressed
to `to_app=crew`, resolves done ones (`resolve_note`), and writes note-backs (`add_note`). The
SessionStart hook surfaces the same inbox. `deploy.sh` records the version (from `crew.js?v=N`) via
`deploy_version`, using the untracked `.gx_deploy_secret`.

**What to build next:** `/gxwhatsnext` pulls this app's prioritized work from the Command Center.

**Close the loop when you're done:** when a task's goals look met, tell Sky and **offer to
ship/close it out** (PR → `dev_update … status=in_review`; on merge → `dev_ship`). Find the job via
`dev_queue`, but **refer to it by its `title`, never its id** — same for `bug_…` and note ids.
**Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch
`action=whats_next` and let Sky pick by number.
