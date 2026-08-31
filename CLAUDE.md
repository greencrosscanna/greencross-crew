# GX Crew (app key `crew`) — GX 2.0 HR / People app

Part of the Green Cross app suite. **GX Crew is the HR / People system-of-record** — it owns the employee
roster and everything compensation- and people-related, and it **feeds** the Leaderboard (performance) app
rather than living inside it. Split out of Leaderboard on 2026-08-16 (decision recorded in the Command
Center; Incentive was formerly a Leaderboard view). Its app key in GX Core is **`crew`**.

## What GX Crew owns
- **Roster / identity attributes** — the rich HR record: OLCC/METRC permits, time (SwipeClock),
  birthday / work-anniversary, shirt size, badges.
- **Compensation** — the **Incentive / bonus calculation** (ported 2026-08-27 — see the Incentive
  section below), editable comp **thresholds**, **Capstone payroll export** (CSV/PDF), and
  **monthly review snapshots**.
- **Feeds to Leaderboard (via GX Core, never app-to-app):** the **perks** shown on the board and a
  **privacy-preserving "celebrations" feed** (today/upcoming birthdays + anniversaries — a derived flag,
  **not raw DOB**) so the kiosk can surface them without PII leaving GX Crew.

## Boundary with GX Core (the split)
- **GX Core owns canonical employee IDENTITY** — `nameKey`, name, store, role, active, hireDate — the
  shared registry Leaderboard + SPIFF + Crew all read (one writer, many readers).
- **GX Crew owns the rich attributes** (above) and **writes the shared identity slice + celebrations +
  perks up to GX Core**.
- **Reads from GX Core:** identity and the sales cache (`GXCore.getSalesDaily`).
- **SPIFF payouts do NOT reach Crew.** *Corrected 2026-08-25: this used to list `spiff_payouts` as a read
  "for the bonus calc". No such tab exists — not in `GX_TABS`, nothing writes it, nothing reads it. The
  claim was invented in documentation and repeated across six files until it read as fact.* This matters
  more here than anywhere else: the bonus calc is the thing that would consume it, so believing the pipe
  already exists means building on a data source that was never there.

## Extract-first sequencing (important)
The bonus math needs **per-employee, per-transaction** data *with discretionary-discount classification*.
That engine currently lives app-side in Leaderboard and is **not** in the GX Core daily cache (per-store
daily only). So the clean split is sequenced: **first** promote (a) per-employee performance metrics and
(b) the discretionary-discount definition to a canonical home (a shared `gx` library both apps bind — like
`txNet` became canonical — or a GX Core per-employee endpoint), **then** cut Crew over. Do **not** move the
UI before the math has a shared home. Coordinate with `core-admin` (brain note already sent).

**Payroll safety:** completed pay periods are **frozen once** ("these numbers paid people") — carry that
caching discipline over exactly, and never cut over live payroll numbers without a **penny-match** against
the current Leaderboard incentive output for a full pay period.

## The roster is a two-pane workspace (built 2026-08-24, from Claude Design's handoff)
`renderRoster` and its 12-column table are **gone**, and so are the Review and EoM **tabs** —
Roster is Crew's only tab now. The screen is a permanent people list on the left (grouped by
store, sticky group headers) and a right pane that is either **one person's whole record** or,
when nobody is selected, the **overview**: stat tiles, the open-questions queue that used to be
the Review tab, and the Employee-of-the-Month panel that used to be the EoM tab. The attention
chip in the sub nav is what deselects and goes back.

Three things a future session will otherwise get wrong:

- **The roster leads with the name people use, and that name is a RENDERING.** `displayName()`
  joins `preferred_name` to the legal surname — Michael Kettler with nickname Mike reads
  **Mike Kettler** — and the record header shows that in white with the legal first name beside
  it in green quotes (*"Michael"*). The rail sub-line carries the same green legal first name.
  Both are derived at paint time and **never written back**: the header is deliberately not an
  input, because saving what it displays would put "Mike" into `full_name`, which is the column
  METRC and payroll match on and the exact corruption employee #22 arrived with. Legal name and
  nickname are edited as their own adjacent cards in the field grid. `byName` and `searchRows`
  both work on the displayed name too — a list you cannot scan alphabetically, or a search that
  misses the string printed on the row, are the two ways this goes wrong quietly. The **EoM reign
  log** follows it as well, by looking the person up on the roster; it falls back to the name
  stored in the log only for somebody no longer on it, who cannot be looked up and whose name at
  the time is then the only record of who held it.
- **There is no Edit mode, and there is no Save button.** Every control is live: text commits on
  a 600ms pause and again on blur, selects and dates the instant they change, and a toast names
  what was written and offers an undo. Do not reintroduce an arm-then-save gate — the removal is
  the design.
- **One field per write, and that only works because both routes are PATCHES.** `roster_save`
  and `roster_identity` both treat an absent parameter as "leave alone" and an empty one as
  "clear", and both read-merge-write. Post a whole record instead and `gxWrite_` blanks whatever
  you omitted — `dutchie_employee_id` and `user_id`, neither of which this screen shows.
- **"New here" is a SUBSET of "records with a gap", and the difference is the point.** The
  overview lists people who arrived but were never set up: a setup gap (`hire_date`, `wage`,
  `store`, `role`, `employee_number`) **and** signs of a recent arrival (no hire date at all, no
  employee number yet, or a start date inside 90 days). Both halves are load-bearing. The first
  cut used the gap alone and put **Sky and Mike at the top of a list headed "New here"** — neither
  takes an hourly wage, so both carry a permanent `wage` gap, and nobody has been here longer.
- **`pay_type` decides whether an empty wage is a gap or a fact.** A closed set checked
  server-side (`hourly` / `salary` / `none`; empty means hourly), picked from a select on the
  wage card. `rowFlags_` raised a permanent `wage` gap on anyone without an hourly rate, which is
  a red mark on a complete record — **Sky** takes nothing as owner, and **Mike, Tawny and Shawn
  are salaried** (Sky, 2026-08-25). It cannot be inferred: `Admin` and `corporate` both belong to
  hourly staff too, and a rule keyed on either would stop flagging a wage that really is missing.
  It supersedes the `not_on_payroll` boolean shipped hours earlier, which collapsed "salaried"
  and "not on payroll" into one claim — salaried people are very much on payroll. The old column
  is still read as a fallback meaning `none`, and `ATTR_HEADERS` only appends, so it stays.
- **Nothing in the sub nav says how many open questions there are.** The attention chip that
  used to sit there was removed 2026-08-25; the overview opens on its own and states the count
  in its title and its stat tiles, so the chip was a second scoreboard to keep in agreement with
  the first. It was also the way BACK from a person to the overview, so three replacements
  carry that: **Escape**, **clicking the open person again**, and the **Roster tab**. Escape is
  ignored while focus is in an input or select, where it already means "revert this field".
- **The store pill row has no "All" pill any more.** Deselecting is clicking the lit pill again.
  `tests/roster_filter_test.js` pins the set, the order, the counts-before-the-store-filter rule
  and the dim-don't-disappear rule; it also now covers the three stacked filters
  (`scopedRows` → `searchRows` → `filterByStore`), because every failure in that stack hides
  people rather than erroring.

The **OLCC permit card is read-only**, per the design — METRC owns it and an import overwrites
whatever you type. **One exception:** when there is no permit number on file the card shows two
inputs and an Add button, because the queue raises `missing_permit` at HIGH severity and its only
offered answer is "Mark handled", which acknowledges rather than fixes. Seven active staff are in
that state; without the exception the highest-severity item on the board could only be cleared by
lying about it. `saveRosterAttrs_` has allowed exactly this write since it was written.

The design bundle it was built from is `design_handoff_roster_workspace/` — the `.dc.html` in
there is a **reference prototype**, not shippable code; its runtime is a preview harness.

## Layout
- **Frontend:** `index.html` (shell; loads `gx-theme.css` + `gx-client.js` from gx-theme by URL, and
  `crew.js?v=N`) + `crew.js` (app logic, wired to `window.GX` for GX Core JSONP). The **`?v=N`**
  cache-buster on the `crew.js` tag is the single source of truth `deploy.sh` reads for the version —
  bump it on every ship.
- **Engine deploy:** `clasp push` then `clasp update-deployment <id>` — **redeploy the existing id**,
  never `create-deployment`, which mints a *new* /exec URL and orphans `cfg.crewEngineUrl`.
  Note `clasp create` clones the remote manifest over the local one, wiping the GXCore binding;
  restore `appsscript.json` from git before the first push. (`clasp open` is `open-script` in v3.)
- **Backend:** `apps-script/` (`Code.gs` doGet/doPost router + `appsscript.json`, pins the `GXCore` library — the version is not written here on purpose (it read **v225** while the app ran v241); ask `?action=health` or `./gxpins.sh --live` —
  v139 is where `gxUpsertEmployee` began read-merge-writing instead of rebuilding a row from the payload,
  and v150 made that unconditional plus refused to blank a live `full_name`, so anything below v150 can
  still blank the columns a partial write omits. **v201** is the floor for the store matcher:
  `GXCore.resolveStore()` exists from v194, but v201 is where it learned the Rd/Road fold and got the
  per-execution registry memo (`gxStoresCached_`) that keeps `mapPermissionLocation_` — one lookup per
  employee × permission location — from turning one sheet read into hundreds. **v211** is the floor for the bug reporter:
  that is where `gxIngestBug` began self-installing the `bug_reports.context` header, and `gxWrite_`
  maps records onto the sheet's REAL header row — so on an older pin the state snapshot is dropped
  **silently** and the report still saves and still returns ok. **v225** is the current pin
  (2026-08-25) and the floor for the avatar write: `GXCore.setAvatar` does not exist below it, and
  `roster_identity` calls it for an avatar-only save. (v219 fixed `getPeriodGoals`, which Crew does
  not call, added the `blocked` status to `brain_notes` and made deploy-secret errors say *missing*
  vs *bad*; v220 fixed a regression in that blocked-status write path.) The engine's `health` route
  reports the version the LIVE DEPLOYMENT runs (`lib`), which is the only pin that matters — a manifest
  bump that was never deployed still runs the old snapshot).
  Deploy the engine with clasp (`clasp create --type webapp --rootDir apps-script` on first setup, then
  `clasp push` / `clasp deploy`).
- **Bug reporter:** gx-theme's shared `gx-bugreport.js` — the button, modal and state snapshot are
  **not in this repo**. Crew supplies only `initBugReport()` in `crew.js` (transport + who is signed in
  + what they were looking at) and the `bugreport` route in `Code.gs`, which forwards to
  `GXCore.gxIngestBug`. The action name is **`bugreport`**, matching Inventory and Leaderboard; Sales
  spells it `reportbug` and Price Cards `reportBug`, so do not copy a route from those two.
  **The snapshot deliberately omits the search box contents** — `bug_reports` is a shared table
  rendered in the Command Center cockpit, and Crew is the app holding the PII, so a report must not
  carry an employee's name out of here. `searchActive` says a filter was on; that is the reproducible
  part.
- **Local loop:** `python3 serve.py` → <http://localhost:8755>. No build step — the working tree IS the
  app, so edit + reload is the whole loop. The backend it talks to is **live**; `gx-dev.js` blocks writes
  until you arm them, and `gx-preflight.sh` runs as a **pre-push hook** refusing dev leftovers — including
  running `tests/identity_test.js`, so a broken invariant blocks the push rather than shipping. Those tests
  cover identity and date invariants only (`nameToKey_`, `normDate_`, `normBirthday_`, the store-label
  split, the attribute carry-forward); **nothing there covers pay**, and for anything touching pay the
  check that counts is still the **penny-match** described above.
- **Shared dev files** (`deploy.sh`, `.claude/` SessionStart hook + settings) come from gx-theme via
  `gx-sync.sh`, filled from `.gx_app` (= `crew`). Re-run `./gx-sync.sh` to refresh them. This CLAUDE.md is
  intentionally **not** synced — keep it app-specific.

## gx-theme is core-admin's — send a request, don't edit (rule from Sky, 2026-08-20)
**Never edit `greencross-gx-theme` from this chat.** Five apps load `gx-theme.css`, `gx-client.js`,
`gx-topnav.js`, `gx-avatar.js`, `gx-session.js` and `gx-stores.js` **live from Pages**, so a change there
is not a change to one app — it reaches every app on its next load, inside the 10-minute cache, with no
deploy and no review in between. That reach is the point of the shared layer and exactly why it does not
get six editors. If Crew needs something from it, `add_note` to `core-admin` saying what and why;
requests are welcome and quick.

**The corollary matters just as much: do not restyle a shared component from inside Crew either.** A local
rule that beats `.gx-btn-green` or `.gx-input` wins here and silently diverges from the other five — that
is literally how the suite ended up with six different login screens.

**What still belongs to Crew** is anything that is genuinely this app's character. The test is *"should all
six get this?"* — if no, it is app-local and stays here. Note `gx-sync.sh` pulls **from** gx-theme; it is
a one-way read, not an editing channel.

## Shipping — direct to `main` until launch (decided 2026-08-18)
GX Crew is **pre-launch**: nobody outside Sky has access yet, so there are no staff to watch a feature
bake. The shared `/gxbrain` ship policy's *feature → branch + PR + merge-when-done* rule exists to protect
daily users, and it doesn't apply here yet. **Until Crew launches, commit and push straight to `main`**,
run `./deploy.sh`, then `dev_ship` the job. Don't open PRs for routine work.

**Revert to branch + PR the moment Crew goes live to anyone but Sky** — from then on staff are looking at
it, and the ordinary policy applies.

## System of record — Crew, not the spreadsheet (decided 2026-08-18)
The HR workbook (`GreenCross_Staff.xlsx`) built the initial roster and is now **history**. **GX Crew,
backed by the GX Core `employees` registry, is the point of truth for people data.**

This is enforced, not just documented: `hr_import` defaults to **fill-only** — it writes a field only
where the current value is empty, and overturning a held value needs an explicit `mode=overwrite`.
That default exists because re-sending the sheet once silently reverted four role corrections minutes
after they were made. A superseded source must not be able to contradict the record.

Related invariants worth keeping:
- **`employee_number` is issued, never typed** — `assign_numbers` allocates `max(ever seen) + 1`,
  counting retired and merged rows, so a number is never reused. `00` is reserved for the owner and
  sits outside the sequence. `set_number` (deploy-secret) is the only override.
- **Every write to GX Core is read-merge-write.** `gxWrite_` replaces the whole row, so a partial
  write blanks `dutchie_employee_id` (SPIFF/Leaderboard attribution) and `user_id` (email link).
- **Leading zeros need plain-text columns.** Sheets coerces `"00"` to `0`; `employee_number`,
  `birthday` and `permit_number` are pinned to `@` format, and number comparisons are numeric.

## METRC is the source of truth — once we have API access (decided 2026-08-22)
The METRC connector (`metrc_*` routes) is written but **not connected**: `METRC_BASE` still points at
the sandbox and `METRC_USER_KEY` is unset, so `metrc_health` reports "Missing keys" and nothing real
has ever come through it. Today its only consumer is `metrcAccessAudit_`, which answers "are retired
staff still active in METRC?" — **names only, no writes**.

When production credentials land, METRC becomes the authority for:

| Field | Notes |
|---|---|
| `permit_number` | OLCC permit — the export's **License Number** |
| `permit_granted` | OLCC Granted |
| `permit_expires` | OLCC Expires |
| `permit_status` | Active / Valid |
| **legal first + last name** | the spelling `full_name` should carry, but see the casing note below |

***`hire_date` is NOT on that list, corrected 2026-08-25.*** This line used to claim it was, and
six real METRC employee exports disprove it: the **Hired** column is *the date that person was
added to that licence*, not their company start date. In 72 rows across six licences, **30 land
on 2025-04-29 and 11 more on 2025-04-30** — facility-setup days, not thirty people starting work
together — and Michael Kettler reads `2025-04-29` in five exports and `2025-07-23` in the sixth.
Writing it into `hire_date` would have reported ~1yr of tenure for people who have been here
seven. It is only plausible for somebody on **one** licence with a non-bulk date, which is a
new hire whose facility-add really is close to their start; even then it is a proposal for a
human, not a value to write. A METRC sync must leave `hire_date` alone.

Two more things the real exports show that the connector's field list does not:

- **METRC's own casing is unreliable** — the same file carries `ellison, jayden`,
  `PINKERTON, NOAH` and `Mcarthur, Ayla`. METRC wins on *spelling*, not on capitalisation, so a
  sync must not copy the case through.
- **`Employee Role` is empty for everyone, and `Home` is a METRC landing page** (`Sales`,
  `Packages`, `Reports`), not a store. Neither maps to `role_title` or `home_store`.

**Reconciled once by hand, 2026-08-25.** Six exports → 42 unique people → `hr_import` fill-only.
Permit fields for all 42 (41 matched existing records; **Andrew Roberts was created** — permit
`R106Y7`, Portland Rd, employee **#117**, Budtender). Then `hire_date` for exactly **three**
people whose METRC date passed the single-licence, non-bulk test: Andrew Roberts 2026-08-22,
Nathaniel Schneider 2026-03-07, Sierra Martin 2026-08-11. The other 39 were left alone.

Fill-only is the right mode for this even though the paragraph above warns against routing METRC
through `hr_import` — that warning is about **`full_name`**, which is guarded and always
populated, so a spelling correction is silently skipped. Permit columns are usually *empty*,
which is exactly what fill-only exists to complete.

**The export files do not name a store, and the registry has no licence column.** `getStores()`
returns `store_id, display_name, dutchie_name, short_code, color, region, sort_order, timezone,
is_dc, aliases` — nothing to join an OLCC licence on. Known so far: **050-16892 → `portland-rd`**
(Sky, 2026-08-25). The other five (050-12997 / 13000 / 13003 / 13006 / 13009 — a consecutive block
registered together, with 16892 added later) are unmapped. To identify one, take the people who
appear on **that licence only**: six staff have company-wide access and sit on all six exports
(Samantha Bryson, Michael Kettler, Andrew Phillips, Skyler Pinnick, Shawn Todd, Tawny Vierra), so
whoever remains is that store's own crew and names it on sight.

**Why METRC and not Dutchie, which is where the roster's names actually came from.** Dutchie is
*supposed* to mirror METRC, so it looks like an equivalent source — but a Dutchie admin (Mike) can
edit a person's name in Dutchie, and a nickname typed there flows straight into `full_name` via the
identity seed. That is exactly how employee #22 reached the roster as "Mike Kettler" while METRC has
him as Michael. **Dutchie is not trustworthy for legal spelling; METRC is.** Any future reconciliation
should treat a Dutchie/METRC name disagreement as "METRC wins", which is what the open review item on
Rebeka Perez already says in prose.

**The consequence for whoever builds the ingest — do not route it through `hr_import`.** That path
defaults to fill-only and `full_name` is in its guarded list, so a correct legal name is *silently
skipped* whenever the field already holds something, which it always will. Worse, the matching works
perfectly first — `NICKNAMES` maps mike→michael, so `samePerson_('Michael Kettler','Mike Kettler')` is
true — meaning the import identifies the person, keeps the right `employee_id`, reports the drift under
`matched_despite_name_drift`, and then declines to apply the improvement. Nothing errors.

So a METRC sync must either post `review_report` items (the `name_spelling` kind, which `resolveReview_`
applies through `saveIdentity_` — that also records the rename alias, so the old `employee_id` keeps
resolving for Leaderboard/SPIFF joins) or write its owned fields explicitly. Note `review_report`
**replaces the whole `crew_reviews` tab wholesale** — a sync that posts only its own findings deletes
every hand-filed item, so it must re-post what it did not author.

Note also that accepting a `name_spelling` item writes `full_name` **only**. Setting the nickname
(`preferred_name`) so the roster reads *Michael Kettler "Mike"* like the other 18 people is a separate
edit in the identity panel.

## Nightly Dutchie scan — it REPORTS, it never writes (built 2026-08-25)
Nothing polled anything until now: a new hire reached Crew only when somebody remembered to run a
seed or an import, which is how Andrew Roberts sat in METRC for three days unnoticed. A time
trigger runs `nightlyDutchieScan()` at **05:00 store time**; it compares Dutchie's active people
against the GX Core registry and parks anyone it cannot match in **`crew_pending_hires`**.

- **It creates nobody.** `seed_commit`'s own comment is the reason — writing the registry every
  app reads "is not something that should ever fire as a side effect", and a 5am cron is exactly
  that. Each find surfaces as a **`new_hire`** item in the review queue; accepting it (*"Add to
  the roster"*) is the only path to a write, and a human presses it.
- **Matching is `hrImport_`'s ladder**, not a second opinion — exact `employee_id`, then a merge
  alias, then `samePerson_` fuzzy. Two detectors disagreeing about whether somebody is already on
  the roster would either hide a real hire or propose a duplicate of an existing one.
- **A failed Dutchie read changes nothing.** Writing "no new hires" because the source was
  unreachable looks exactly like good news, so an empty read returns an error instead.
- **Its own tab, deliberately not `crew_reviews`** — `reportConflicts_` replaces that one
  wholesale, so a nightly writer sharing it would delete every hand-filed item every night.
- Routes: `new_hires` (run the scan on demand) and `install_triggers` (`confirm=yes`), both
  deploy-secret. `ScriptApp.newTrigger` needs the `script.scriptapp` scope this project did not
  previously use, so the first install may need the owner to run `installNightlyScan()` once from
  the editor and grant it.

## Monday digest — and the Apps Script auth trap it walked into
The nightly scan's findings, plus the permit and gap counts, mailed **Mondays 07:00 store time**.
Same content as the roster's overview minus Employee of the Month.

**Who receives it is a per-person setting, not a list in the source** — `digest_opt_in`, ticked on
their own record under *Links & visibility*. It needs a **GX account** too, because `user_id` is
where the address comes from; with no account the control says so rather than storing a preference
that could never be honoured. **`user_id` is the MAILBOX NAME, not an address** — `createAccounts_`
derives it as `email.split('@')[0]`, so Sky's account is `sky`. The address is reassembled as
`user_id@greencrosscanna.com` (`ACCOUNT_DOMAIN`); GX Core holds the real one in its `users` tab but
the library exposes no reader for it. There is deliberately **no fallback list**: "if nobody opted in, send
to these people" would mail somebody who had just switched it off, which is the one thing a
preference must never do. Nobody opted in means the send reports that it went to nobody. `?action=digest` previews, `&send=yes` sends, `&to=` overrides. Every
attempt records its outcome and its **source** (`editor` / `webapp` / `trigger`) to a script
property, readable via `?action=mail_check`, which also lists the live triggers.

**Adding a new OAuth scope does not re-prompt, and costs a day if you do not know that.** Adding
`MailApp` meant the project needed `script.send_mail`; Google decided the authorization was
already settled and never showed a consent dialog. Every symptom pointed elsewhere:

- Running the function from the editor **grants your account, not the deployment.** The web app
  is `executeAs: USER_DEPLOYING` and carries its own stored authorization.
- **`clasp update-deployment` never raises a consent prompt.** Redeploying does not help.
- The editor logged the run as **Completed** because `sendDigest_` catches the auth error and
  returns it. A refused send looked exactly like a successful one. `sendDigestNow` now rethrows.

**What actually works:** revoke the project at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) → *Remove access*,
then run `sendDigestNow()` from the editor. With no stored grant Apps Script re-derives every
scope and prompts for the full set. **The engine is down between those two steps** — the web app
runs on that same authorization — so it is a minute of outage, not a free action.

Deliberately NOT fixed by pinning `oauthScopes` in `appsscript.json`: an explicit list replaces
auto-detection and would have to enumerate everything **GXCore** needs as well as this script's.
A scope missed there breaks the roster and the review queue, not just email.

## Avatars are written by GX Core now (2026-08-25)
`GXCore.setAvatar(ref, config, by)` — **v225** — is the single avatar write in the suite, and it is
**Crew's own logic, promoted**: seed pinned to `employee_number`, lock contention retried, a clear
NAMED in `clear=` and then verified to have landed. Leaderboard had a second implementation that did
none of that, so which behavior a staff member got depended on which app they stood in front of.

Two consequences for this repo:

- **`roster_identity` delegates when the avatar is the ONLY change** — which is every write the
  picker makes, since the roster saves one field at a time. It sends a patch of
  `{ employee_id, avatar_config }`, so there is no row for `gxWrite_` to blank; `dutchie_employee_id`
  and `user_id` survive by construction rather than by remembering to carry them. An avatar arriving
  **alongside** other identity fields stays one atomic row write and stamps the seed locally
  (`avatarSeed_`) — splitting it in two just to route the avatar would let a half-applied identity
  edit exist.
- **The `avatars` and `avatar_save` routes are gone**, with `avatarSave_`, `avatarsForKiosk_` and
  `resolveEmployee_`. They were Crew's half of a Leaderboard hand-off that was never wired — no
  caller anywhere in the suite. `avatarSeedFrom_` **stays**, because `rosterJoin_` and
  `migrateLeaderboard_` re-derive the seed at READ time; that is why a stored seed could drift for a
  release without a single face rendering wrong. `tests/avatar_write_test.js` pins all of it,
  including that the dead routes do not come back.

### …and the PICKER is gx-theme's too (2026-08-25, same day)
Crew's own `avatarPanel` — 105 lines, a grid of fourteen `<select>`s — is **retired, not merged**.
Sky: *"I like the LB picker better… the current, simplified version in Crew is efficient but not
intuitive and just adds noise."* The one builder for the suite is `GXAvatarPicker` in gx-theme
(`gx-avatar-picker.js` + `.css`, loaded **by URL** alongside `gx-avatar.js`), promoted out of
Leaderboard. Crew mounts it; it does not own it.

- **The avatar circle in the record header IS the control.** A real `<button>` (`.crew-avabtn`)
  wrapping the puck, so it is reachable by Tab — it is now the *only* way in, which is why the
  redundant "Avatar" text button in the actions row was deleted rather than left as a second door.
- **Crew passes a real `seed`, and that is the thing Crew can do that Leaderboard cannot.**
  `row.avatar_seed` — the engine's own `avatarSeedFrom_` answer (attrs `employee_number`, then the
  Core row's, then `employee_id` for anyone not yet numbered). Leaderboard's `getavatardata` carries
  no employee number and falls back to a **name-derived** seed, which is precisely what pinning
  exists to stop mattering. Do not "simplify" this to `row.employee_number`: that is the attrs value
  only and is blank for the unnumbered, who would silently get DiceBear's `unknown` face.
- **`showLeaderboardPreview: false`, and never `.gxava-full`.** The mock is a sales standings row
  ("Jordan M. $4,820") and this is an employee record; `.gxava-full` sets `min-height:100vh` and
  assumes it owns the viewport, but here it is a panel inside a person. Both are the component's
  defaults — the point is that they are stated, not relied on.
- **One attribute was lost in the swap: `clothingGraphic`.** Crew's table pinned the design on a
  graphic shirt because it was the last thing the seed still chose. The shared picker does not offer
  it, so a config **re-saved** through the picker drops the key and DiceBear picks the design from
  the seed again. Stored configs keep rendering theirs until re-saved. Requested back from
  `core-admin` — it belongs in the shared component, and a local table would diverge on day one.
- `tests/avatar_picker_adoption_test.js` pins the contract a push gate can hold: both files loaded,
  no vendored copy, no local `.gxava-*` override, `avatarPanel` and the option tables gone. The
  behavior (click → save → reload → remove) needs a browser and is not in the gate.

## Incentive — transplanted from Leaderboard (2026-08-27)

**The split that survives the move:** Leaderboard stays the **performance engine** — Dutchie ingest,
`aggregateTransactions_`, the discretionary-discount classification, and the frozen closed-period
snapshots. **GX Crew is the payout app** — the bonus math, the attendance/SPIFF inputs, the Capstone
export and the approval. Sky's own framing: SPIFF sets the goals, LB tracks the performance, Crew
reads the performance.

Crew reaches it through LB's `incentiveperf` route: deploy-secret, **read-only**, no save twin,
and placed *above* `requireAuth_` because everything below that line is rejected as "not signed in"
before a machine caller reaches it. **This is app-to-app, which the brain forbids, and it is
deliberate and temporary** — promoting the per-employee slice into GX Core needs a library cut Crew
could not wait for. A brain note asks `core-admin` for it; SPIFF wants the same data. Delete the
route when GX Core exposes the slice.

### A period is served from one of two places, and the payload says which

- **`imported`** — a closed period from the 27 payout PDFs (2025-08-04 → 2026-08-16), or one Crew
  has since approved. Figures **as paid**. Read-only, never recomputed.
- **`live`** — LB's slice plus Crew's inputs, with the math running in the browser so a tick
  re-scores instantly.

Where the two overlap the **import wins** — LB offers its last 8 periods regardless, and serving one
live would re-derive a paid fortnight against today's thresholds.

**Never recompute a closed period.** The benchmarks have already moved once: the source spreadsheet
measured **gross** discount against a ~2.75% bar, the app measures budtender-controlled
**discretionary** discount against whatever the settings tray holds. Same staff, same fortnight,
7.30% and 2.81%. So the PDFs are history, *not* a penny-match corpus — run the app's formulas over
them and they disagree, correctly.

*Corrected 2026-08-31: this named Crew's bar as **1.5%**; the live value in GX Core kv
`incentiveThresholds` is **1.0**. Sky: "my notes about 1.5 should be irrelevant, we built a setting
that can be updated and that should be what influences the calculations." The ~2.75% stays because
it describes the old spreadsheet, which really is frozen; Crew's own bar is a setting and naming it
here just dates the file. Same failure as the `spiff_payouts` and `version_history` corrections
above — a doc asserting a value nothing can contradict. Read `budtender.discountMaxPct` from the
tray, never from this paragraph.*
Leaderboard still has this bug in miniature: its performance figures freeze but its thresholds do
not, so editing the discount goal re-scores every period it already paid.

### There are TWO implementations of the bonus math, on purpose

The browser's (`calcBud`/`calcMgr`/`calcAdmin` in `crew.js`) runs on every keystroke. The engine's
(`incCalcBud_`/`incCalcMgr_`/`incCalcAdmin_`) runs once, at approval, because a route that writes
whatever amount the page hands it is a route where a stale tab decides payroll.

**This is only acceptable because `tests/incentive_math_test.js` drives BOTH against a frozen copy
of Leaderboard's originals** across 12,040 boundary combinations. Do not touch either without
running it. The oracle is frozen rather than read from `../greencross-leaderboard` because that
dashboard gets deleted — a test that dies with the thing it was checking takes the guarantee with it.

### Approval — Mike prepares, Sky decides

```
draft ──send──► pending ──approve──► approved (immutable, in history)
  ▲                │
  └──send back─────┘  reason required, emailed to the preparer
```

Sending **locks the inputs** server-side for everyone, approver included. Approval is the only thing
that writes, which is why sending back needs no undo. **`incentive_unapprove` is the break glass:**
deploy-secret only, never a button, and it **voids rather than deletes** — rows are copied to
`crew_incentive_voided` with who and why.

**Who approves is NOT a role check.** GX Core's vocabulary is `viewer/editor/admin/director` —
there is no `owner`, and Crew is admin-only so Sky and Mike hold the same grant. The approver is
named in GX Core kv **`cfg.crewApprover`** (currently `sky`). Unset, nobody can approve and the
screen says so: failing closed beats a default that lets the preparer approve their own work.
Email links carry a single-use 72-hour token bound to the period **and the total that was sent**.

`?action=incentive_send&preview=1&secret=…&to=…` dry-runs the email with no state change.

### Things that silently pay the wrong amount

- **SPIFF is vendor money.** In Bonus, never in Payroll, never in the export. Budtenders subtract it
  out (`bonus - spiff`); managers add it on. Same rule, opposite construction.
- **One identity key: `employee_id`.** LB sends its own `nameKey` (`chris_carney`) and GX Core uses
  `christopher_carney`. Keying inputs on nameKey did not fail — it found nothing, so bonuses computed
  as if nothing had been entered. `stampEmployeeIds_` attaches the id, the legal name and the middle
  initial to every live row.
- **A `merged` record is a tombstone**, still returned by `getEmployees()` and still matching on
  name. Filter it out or history attaches to a record nothing renders. `retired` is NOT the same —
  those people really did work those periods.
- **`GXCore.getEmployees()` has no `display_name`**; that column is added by GX Core's *HTTP* route.
  Match on `displayNameOf_` (which already existed — do not write a second one).
- **`discount` is a DECIMAL on live rows and `discount_pct` a PERCENT on imported ones.** Off by
  100×, and both readings look plausible.
- **`''` and `0` are different claims.** The oldest report has no payroll column; those rows export
  empty, because 0.00 tells payroll to pay nothing.

### The settings tray — thresholds AND discount rules in GX Core

**Thresholds live in GX Core kv as `incentiveThresholds`.** Deliberately **not** a `cfg.` key: that
prefix is public on `?action=config`, and comp policy should not be readable by anyone with the URL.
They were a Leaderboard ScriptProperty, which was wrong twice — compensation is not the kiosk's, and
**Leaderboard's own discount coloring reads `budtender.discountMaxPct`** to decide what counts as a
good rate on the board every staff member sees. Two copies of that number means the board grades
people against a goal nobody set on it.

Leaderboard reads GX Core → its local property → its defaults, **in that order**: an unreachable GX
Core must keep the board scoring as it did rather than silently reverting everyone to defaults. Its
per-execution memo is **cleared at the top of `doGet`** — Apps Script reuses warm instances, so a
module-level global outlives the request that filled it, and without that reset a threshold edit
appears to do nothing for minutes.

**Editing is the approver's, not any editor's** — Mike prepares a period, he does not move the bar.

**The tray's CSS is copied verbatim from `greencross-leaderboard/index.html`** (the `.ist-*` and
`.inc-tray-*` blocks). Sky designed it; a rewrite was worse. The only change is a variable bridge —
that sheet names colors `--text`/`--green`/`--border`, gx-theme names them `--gx-*` — aliased once
and scoped to the tray. **Re-copy on any change there rather than hand-editing**, and keep the class
names: renaming one silently unstyles a section instead of erroring.

**Discount rules moved to GX Core kv `discountRules` on 2026-08-30** — same shape Leaderboard's own
`GC_DISCOUNT_EXCL_JSON` always had, `{overrides:{"<name>":true}}`, `true` = **excluded**, i.e. does
not count against the budtender. Read with `GXCore.getKv`; written through the secret-gated
`?action=set_config`, exactly like the thresholds, because **there is no `GXCore.setKv`** and never
has been. `gxSetKvViaWeb_` is the one writer for both.

**The write hop to Leaderboard is gone. The read hop for the NAMES is not, and cannot be.**
`discretionary` is derived from Leaderboard's discount **registry** — a union of Dutchie's
`/reporting/discounts` across every store, classified automatic / loyalty / discretionary. GX Core
holds no discount data of any kind and no Dutchie credentials, and the registry sits downstream of
the transaction ingest that is deliberately staying in Leaderboard. Core knows the three names
somebody has an *opinion* about; it does not know the forty that exist, so a tray rendered from Core
alone would show three unchecked boxes and no way to switch a fourth discount off. So:
**Leaderboard says what exists, GX Core says what counts, and where their `excluded` flags disagree
Core wins** — LB's flags are read and discarded, which is what stops the two copies drifting back
apart. If Leaderboard is unreachable the tray degrades to the names Core holds an override for,
flagged `partial` with a warning that says the list is incomplete; saving still works, because the
merge only touches names that were on screen.

**The checkboxes mean COUNTED and the store holds EXCLUDED**; the flip happens in the engine, never
the browser, because a UI posting one while displaying the other grades every budtender against the
opposite rule and nothing about the result looks wrong. The browser posts in its own vocabulary —
`count=` (these now count) and `off=` (these now do not), newline-separated because the names contain
commas. It sends only what **changed**: the engine read-merge-writes Core's map, so an unsent name
keeps the value the screen was already showing, an override for a discount no longer in the registry
survives, and a rule somebody else edited while the tray sat open is not silently reverted. A failed
Core read **refuses** the write rather than merging onto `{}` — `set_config` replaces the whole value,
so that would switch every rule back on. The retired `save=<every counted name>` format is rejected
with "hard-reload", not half-honoured.

***The separator was broken for the route's entire life.*** `crew.js` sent `join('\\n')` — a literal
backslash-n — while the engine split on a real newline, so nothing split, the whole list arrived as
**one string** matching no discount name, and the old inversion wrote `excluded = true` for **every
discretionary discount**. That reads every budtender's discount rate as ~0% and pays the discount
bonus to everyone. Evidence says it never landed: the value seeded into GX Core is exactly
Leaderboard's three-name `DISCOUNT_SEED_EXCLUDED` constant, not forty. Fixed both ways —
the client sends a real newline and the engine tolerates the typo *inertly*.

**Two consequences of the move to watch.** (1) Leaderboard's `saveDiscountSettings_` used to bust its
own director/standings caches; a Core write does not, so a rule change takes up to its ~6-minute TTL
to show on the board — and LB's `_discCfgMemo_` must be cleared at the top of `doGet` the way the
thresholds' memo is, or an edit appears to do nothing for minutes. (2) **Until Leaderboard reads
`discountRules` from Core, saving a rule in Crew changes no number anywhere** — LB still classifies
transactions from its own ScriptProperty, and Crew's own figures come from LB's `incentiveperf`.
Leaderboard must cut over first.

Pinned by `tests/discount_rules_test.js` — the inversion, the merge, the separator in both
directions, Core-wins-over-LB, the refusals, and that no `discountrules_save` call survives here.

**Tier lists are ORDER-SENSITIVE** — matched high-to-low, first hit wins — so `thresholdProblems_`
refuses an ascending list *by name*. Ascending would pay everyone the lowest tier they clear, and
nothing else in the suite would notice.

**Manager store-discount cut-offs are derived** (`goal × ⅔` and `goal`) and render as text, not
inputs: only their dollar amounts are stored, so an editable field would invite setting a value the
math ignores.

### Hours — $/hr is per-person now, and SwipeClock is NOT connected (2026-08-30)

`$/hr` divided every bonus by a flat `thresholds.hoursPerPeriod` (80) for everybody. It still does
for anyone with no hours on file. When a timecard **is** on file, `incHours_` (engine) /
`incHours` (browser) uses it instead. Blank, zero, negative and unparseable all fall back to the
flat figure — a blank is a claim ("use the flat one"), not a gap.

**`hours` was already there.** The column, the reader (`inputsFor_`) and the writer
(`incentive_save`) all shipped with the transplant; nothing consumed it. So this was one divisor
change plus a source of numbers, not a schema project.

**The safety argument, which is the whole reason this could ship without a penny-match:** hours
reach `$/hr` and nothing else. Not `bonus`, not `payroll`, and `$/hr` is not one of the four
columns the Capstone export carries. `tests/incentive_math_test.js` pins that — the original
12,040 boundary combinations still agree **exactly** with the frozen Leaderboard oracle (none of
them set hours, which proves the extension is inert), and a new section asserts that switching
hours on changes `$/hr` and leaves bonus, payroll and qualification byte-identical. If that ever
fails, an imported timecard has started deciding pay.

**`hr` is frozen into `crew_incentive_history` at approval, so the cutover is FORWARD-ONLY.**
Approved periods keep the flat-80 figure they were approved with. Never backfill hours into a
closed period — same rule as the thresholds, for the same reason.

`incCalcAdmin_` takes no `inputs` and is deliberately untouched: the owner does not clock in.

#### The import reads a file. There is no API, and that is not an oversight.

`?action=timeCardExport` exists and Apps Script could call it — WorkforceHub signs **HS256**, which
`Utilities.computeHmacSha256Signature` does natively, and the flow is: self-sign a ≤5-minute JWT
(`sub:"client"`, `iss:<siteId>`, `product:"twpclient"`, `siteInfo`) → `POST
clock.payrollservers.us/AuthenticationService/oauth2/userToken` → call
`api.workforcehub.com/api/` with `x-api-version: 1` and `x-integration-partner-id`.

**That last header is the blocker.** Swipeclock issues it to *resellers*, and Green Cross is a
client. A client/site-level API secret does exist (and a client admin can *view* it), but the
partner ID has to come from whoever sells us WorkforceHub. **Do not build the connector until it
does** — this repo already ran that experiment: the METRC connector was written in full and then
sat on the sandbox with unset keys, `metrc_health` reporting "Missing keys", nothing real ever
through it. Note also that a client secret is **per site**, and we may have six.

So the import is a **CSV the browser reads**, and the CSV path is not throwaway — when credentials
land, only the parser is replaced; matching, preview and write are the same.

- **The browser parses it because the transport is JSONP**, which is GET — a CSV does not fit in a
  URL, and a deploy-secret POST route could not be called by a signed-in session anyway. FileReader
  means the file never leaves the machine.
- **It writes through `incentive_save`, one person at a time.** That route already refuses an
  imported period, already refuses one locked pending approval, already checks the role and now
  validates hours. No second set of guards to keep in agreement with the first. A partial run is
  safe by construction — whoever was not written keeps the flat figure — so it reports which people
  failed instead of pretending to be atomic.
- **The format is INFERRED, and every inference is on screen before anything is written.** Nobody
  here has seen a real export. It detects the header row past title/date rows, tells wide (a column
  per category) from long (a row per category), and lists the hour columns as **checkboxes**.
  **Time off is unticked by default** — `$/hr` means per hour on the floor, and counting a week of
  vacation into the divisor halves it for somebody who worked a normal week. That default is a
  guess made visible enough to overrule, not a rule.
- **Matching is exact-or-nothing:** `swipeclock_code`, then a full sorted-token name match
  (`"Kettler, Michael"` ≡ `Michael Kettler`; a middle *initial* still matches, a middle *name* does
  not). There is deliberately no fuzzy score — attaching one person's fortnight to another is far
  worse than an unmatched row somebody can see. Two file rows resolving to one person are
  **reported**, never allowed to overwrite each other. Unmatched rows and roster people absent from
  the file are both listed.
- **`swipeclock_code` is Crew's, appended to `ATTR_HEADERS`.** Phase 0 sketched a `swipeclock_id`
  on GX Core's registry; that would need a library cut and a re-pin in five spokes to deliver a
  field one app reads. It is a rich HR attribute, so it lives here. It is **learned** on a
  name match, so the column fills itself and the next period matches on a code that survives a
  legal-name change. It is deliberately **not** flagged as a gap on the roster — every record is
  blank until a file is imported, and a red mark on 39 finished records to report an unused feature
  is the mistake the permanent `wage` gap already made on the salaried.
- Because `saveRosterAttrs_` builds its record from a **hand-written list**, `swipeclock_code` had
  to be added there explicitly or the next roster edit would blank it. The other three attr writers
  derive from `attrFields_()` and needed nothing.

Pinned by `tests/hours_import_test.js` (parsing, layout detection, the PTO default, the matching
ladder and every refusal) and the hours section of `tests/incentive_math_test.js`.

**Still open, and answered with defaults rather than blocked on:** whether our six stores are six
WorkforceHub sites or one; whether OT should count (it does, by default); whether salaried staff
should show a real `$/hr` at all. The checkbox row makes the first two a click.

### The Capstone export is THEIR shape, not ours

ADMIN, then one block per store in Capstone's order (BEND / HILLSBORO / RIVER / CENTER / SOUTH /
PORTLAND), surname-sorted within each. Their labels — SOUTH is Commercial, BEND is Century —
**deliberately not the store registry**, because it is a third party's import format and must not
move when a store is renamed. Header column is `Bonus`; the value is payroll. Names are legal names,
surname first, from `full_name` + the `middle_initial` roster field (backfilled for 36 of 39; three
have none). Anyone whose store does not resolve exports under `UNASSIGNED` rather than vanishing.

**On screen, stores come from the registry** — `GXStores.name(store_id)`, never the label the row
arrived with. The original shows on hover.

### What the APPROVAL path was computing, and it was not what the screen showed (2026-08-31)

Found the day before the first live approval, all on the one path that writes
`crew_incentive_history` — the table that cannot be edited afterwards. None of it changed anybody's
**pay**: SPIFF cancels out of `payroll` on both sides (`bonus - spiff` for budtenders, `payroll +
spiff` for managers) and the Capstone export carries `payroll` only. What was wrong was the frozen
`spiff`, `bonus` and `$/hr` columns, plus one that *would* have moved payroll.

- **`incentiveApprove_` never called `applySpiffEarnings_`.** The engine's calcs read `spiff` from
  the inputs tab alone and never looked at `spiff_earned`, so everyone whose SPIFF was **measured**
  rather than typed — the normal case, and the entire point of reading it from SPIFF — froze at $0.
  Fixed by folding SPIFF in before computing, and by `incSpiff_`, which mirrors the browser's
  `incInput` exactly. **A typed 0 still beats the measurement** (zeroing a miss is a decision); only
  an absent one falls through.
- **A blank spiff cell was read as a deliberate $0, and this broke the SCREEN too.** `inputsFor_`
  did `Number(r.spiff || 0) || 0`, so a blank came back as 0 and the browser treated it as an
  override. Ticking **attendance** creates the inputs row with spiff still empty — so every person
  with an att tick displayed $0 SPIFF on the live dashboard, not just in history. `inputsFor_` now
  returns `null` for a blank, the same shape `hours` already used for the same reason.
- **Approval computed against Leaderboard's thresholds; the screen computed against GX Core's.**
  `getIncentive_` has always overridden `live.thresholds` with `incentiveThresholds_()`;
  `incentiveApprove_` and the send preview did not. They agree while LB's own read of Core succeeds
  — but LB falls back to its local ScriptProperty and then to its **defaults**, so the two diverge
  exactly when Core is unreachable. **Unlike SPIFF, this moves payroll.** `approvalThresholds_` is
  now the one source, it **refuses** rather than falling back (freezing pay against a scheme Core
  cannot confirm is not a degradation, it is a wrong record), and `freezeScheme_` records the scheme
  actually used. The dry run reports `leaderboard_agrees` — false is not an error, it means the
  **board** is grading people against a different scheme from the one they are paid on.

**Two refusals, one rule: an unreadable source must not freeze as an empty one.** A failed SPIFF
read now refuses the approval instead of writing $0 for everybody; `spiff_unavailable=yes` is the
acknowledgement, and it is written into every row's note so the record says the column is
incomplete. A *successful* read with no programs is not a failure and needs no acknowledgement.

### A SPIFF program belongs to ONE pay period — majority, not overlap (2026-08-31)

SPIFF measures a program over **its own window** (`sellthrough_` runs `prog.start_date` →
`prog.end_date`, never per fortnight), so `earned` is one figure for the whole program. Crew
attributed it to every period the window **overlapped** — a program spanning two fortnights paid its
full total into **both**, and the closed one showed money earned after it ended.

**The match is the pay period, and majority is only the fallback** (Sky, 2026-08-31: *"let's use the
pay period as the match. It is the thing that doesn't change and they are always linked… the program
dates are selected by pay period ranges, so they should always match."*)

**The field of that name is half the answer, and it is not a date.** `pay_period` is populated on
some programs and blank on others, and where it is set it holds a human-readable **range**. Live
cache, 2026-08-31: 38 rows read `"2026-08-17 - 2026-08-30"`, 25 read `""`. So it cannot be the only
rung — a blank one would pay nobody — and **it must never be compared raw**: `stored ===
'2026-08-17'` is false against that range. That is the same trap already recorded against
`?action=progress`, where it made the column read **$0 for everyone**. `spiffPeriodOf_` takes the
first date out of whatever shape is stored. The picker also fills the dates **from** the period, so
an exact window is the link for everything the column is blank on. Three rungs, most authoritative
first:

| rung | test | when |
|---|---|---|
| `pay_period` | the stored **range**'s start equals `pp_start` | programs saved through the record editor |
| `exact_window` | program start **and** end equal the period's | everything else that was picked from the dropdown |
| `majority` | more than half the window falls inside | historical records whose dates never lined up |

***Only a RANGE counts as a pay period, and that distinction is load-bearing.*** The column holds two
different facts. The picker writes a range; the **22 programs seeded from the .docx files on
2026-08-30 carry a single date four or five days after the program ENDED — the day it was paid out.**

| program | dates | stored `pay_period` |
|---|---|---|
| `green-cross-test-202608` | 08-17 → 08-30 | `2026-08-17 - 2026-08-30` — the period |
| `freshy-2026-02-02…` | 02-02 → 02-15 | `2026-02-20` — a payout date |
| `kaprikorn-2025-11-24…` | 11-24 → 12-07 | `2025-12-12` — a payout date |

**Not one of the 11 populated seed values lands on a pay-period start, while their dates are exact
periods** (02-02 → 02-15 *is* the 2026-02-02 fortnight). An earlier cut of this read every value as
a period start and let it win outright, which excluded those programs from **every period at once**
— not mis-filed by a fortnight, gone, at $0, and unreported, because they are payable and their
dates are fine so no other check looks at them. Latent only because the progress cache holds two
programs today; the seeded ones are `closed`, and closed pays, so the first refresh including them
would have zeroed 22 legacy vendor programs across the whole history. Caught before shipping,
2026-08-31.

**The invariant that prevents the next version of it:** a stored `pay_period` may *disambiguate*, and
it may raise a conflict somebody can see — it may **never silently cost a program a match its dates
alone would have earned**. A bare date is ignored and listed in
`live.spiff.payout_date_pay_periods`, which is the cleanup that eventually makes rung 1 trustworthy
for everything. **Those rows are counted correctly, on their dates** — the list is a cleanup queue,
not a list of wrong numbers, and its wording says so, because read as a warning it sends somebody
hunting a figure that is already right. It is deliberately **not** narrowed to programs that could
still move a figure: that would hide the very records the cleanup exists for.

**The cleanup is a SPIFF code change, not data entry.** `pay_period` cannot be edited from the SPIFF
UI at all — the period picker's save key is stripped (`spiff.js:1118`), so choosing a period fills
`start_date`/`end_date` and never writes the column, and every program write path requires a session
token with no deploy-secret route. Don't send anyone to a screen to fix it.

**A range contradicting exact dates pays ONCE — in the period the range names — and is reported on
BOTH sides.** The second half of that is the fix, not the decoration: an earlier cut raised the
conflict only where the *dates* pointed, which is the period that pays **nothing**. Approving the
period the range named handed over the money with `period_conflicts: []` and nothing on the dry run
to look at — the disagreement was invisible in the one run where money moved, which is precisely the
decision-nobody-can-see this bag exists to prevent. `spiffIsPeriodWindow_` is what lets the paying
side raise it: dates merely **edited** off the period are legitimate (SPIFF's own picker says *"they
stay editable — not every program lines up with payroll"*) and must not become noise, so the warning
fires only when the dates are exactly **another** pay period — right length *and* on the cadence,
computed arithmetically so it still answers for 2025 dates the picker no longer reaches.

`exact_window` is what separates a program that **ended on the 30th** from one that **started on the
31st** — with no reference to status, so it holds even when nobody has closed the first one yet.
That was the case Sky asked this for.

Majority survives because Sky's older rule still applies to the back catalogue — *"a historical date
that does not line up is a typo"* — so those still pay, at more than half the window, and are named
in `live.spiff.loose_dates` while they do. That list empties itself as the dates are corrected,
rather than becoming a permanent warning nobody reads. `live.spiff.matched_by` counts the rungs; a
`majority` above zero is the work remaining. Only one period can hold more than half of anything, so
**double-counting is impossible by construction**, and a program no period owns pays in neither and
is reported with its amount (`live.spiff.straddling`).

### `closed` means PAID OUT — the status filter that would have zeroed every approval

Crew had **no status check at all** and paid any cache row whose dates lined up, which is how a
deleted program (BeGoat, Sky 2026-08-31) reached the payout screen. SPIFF's vocabulary is exactly
three words, from its own status picker: **draft** — not started · **active** — running now ·
**closed** — *paid out*.

**The obvious filter is the wrong one.** `status === 'active'` looks right and would zero the vendor
column on **every period anybody ever approves**, because a period is approved *after* it ends, by
which time its programs have closed — and a $0 there is indistinguishable from a fortnight in which
nobody earned. So: `active` and `closed` **pay**; `draft` does not; `''` does not.

`''` is not "an old cache row" — SPIFF resolves status at **read time** by joining to its `programs`
tab, so `''` means that tab has no row for this `program_id`. It is reported by name
(`live.spiff.not_payable`), never dropped quietly: SPIFF keeps orphans distinct from "no rows" on
purpose, and a silent filter is where that distinction disappears. An **unrecognized** status is
counted **and** flagged — withholding wrongly produces a $0 that hides, counting wrongly produces a
number somebody questions.

Two guards that are one deleted line from becoming silent, both pinned by
`tests/spiff_attribution_test.js`: payability is settled **before** the window is scored (or a dead
program that also straddles gets reported as missing money and hand-entered — the worst of the three
outcomes), and if **no** row carries a `status` key at all the filter is skipped entirely, because a
SPIFF deployment predating the read-time join would otherwise read every row as an orphan and
withhold every vendor dollar.

**Still SPIFF's to fix, not Crew's:** a program spanning two fortnights, and any test program left
`active` (`green-cross-test-202608`, vendor "Green Cross", was live at the time of writing). Crew
reports both; it does not code around them.

## Access
Owner + Mike to start (HR / managers later). GX Crew handles compensation + PII, so it is a **separate
deployment** from the all-staff kiosk Leaderboard — keep the sensitive surface isolated.

## Sync with the brain — run `/gxbrain` (or say "brain sync")
This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX
Core. Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` reads notes addressed to
`to_app=crew`, resolves done ones (`resolve_note`), and writes note-backs to any app (`add_note`). The
SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`crew`** in GX Core; `appsscript.json` pins `GXCore`
**v225** (this line has said **v179**, **v194**, **v203**, **v204**, **v211** and **v220** — check `health`, not prose);
version recorded on deploy via the shared `deploy_version` endpoint (`deploy.sh`, reading `crew.js?v=N`)
using the shared untracked `.gx_deploy_secret`.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work from the Command Center (dependency-ordered, filtered to `crew`). It reads the app key
above automatically.

**Close the loop when you're done:** when a dispatched or `/gxwhatsnext`-started task's goals look met,
proactively tell Sky and **offer to ship/close it out.** Shipping (open/return the PR → `dev_update …
status=in_review`; on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command
Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.
