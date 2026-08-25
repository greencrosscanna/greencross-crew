# GX Crew (app key `crew`) — GX 2.0 HR / People app

Part of the Green Cross app suite. **GX Crew is the HR / People system-of-record** — it owns the employee
roster and everything compensation- and people-related, and it **feeds** the Leaderboard (performance) app
rather than living inside it. Split out of Leaderboard on 2026-08-16 (decision recorded in the Command
Center; Incentive was formerly a Leaderboard view). Its app key in GX Core is **`crew`**.

## What GX Crew owns
- **Roster / identity attributes** — the rich HR record: OLCC/METRC permits, time (SwipeClock),
  birthday / work-anniversary, shirt size, badges.
- **Compensation** — the **Incentive / bonus calculation** (ported from Leaderboard), editable comp
  **thresholds**, **Capstone payroll export** (CSV/PDF), and **monthly review snapshots**.
- **Feeds to Leaderboard (via GX Core, never app-to-app):** the **perks** shown on the board and a
  **privacy-preserving "celebrations" feed** (today/upcoming birthdays + anniversaries — a derived flag,
  **not raw DOB**) so the kiosk can surface them without PII leaving GX Crew.

## Boundary with GX Core (the split)
- **GX Core owns canonical employee IDENTITY** — `nameKey`, name, store, role, active, hireDate — the
  shared registry Leaderboard + SPIFF + Crew all read (one writer, many readers).
- **GX Crew owns the rich attributes** (above) and **writes the shared identity slice + celebrations +
  perks up to GX Core**.
- **Reads from GX Core:** identity, the sales cache (`GXCore.getSalesDaily`), and **SPIFF payouts**
  (`spiff_payouts`) for the bonus calc.

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
  misses the string printed on the row, are the two ways this goes wrong quietly.
- **There is no Edit mode, and there is no Save button.** Every control is live: text commits on
  a 600ms pause and again on blur, selects and dates the instant they change, and a toast names
  what was written and offers an undo. Do not reintroduce an arm-then-save gate — the removal is
  the design.
- **One field per write, and that only works because both routes are PATCHES.** `roster_save`
  and `roster_identity` both treat an absent parameter as "leave alone" and an empty one as
  "clear", and both read-merge-write. Post a whole record instead and `gxWrite_` blanks whatever
  you omitted — `dutchie_employee_id` and `user_id`, neither of which this screen shows.
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
- **Backend:** `apps-script/` (`Code.gs` doGet/doPost router + `appsscript.json`, pins **GXCore v211** —
  v139 is where `gxUpsertEmployee` began read-merge-writing instead of rebuilding a row from the payload,
  and v150 made that unconditional plus refused to blank a live `full_name`, so anything below v150 can
  still blank the columns a partial write omits. **v201** is the floor for the store matcher:
  `GXCore.resolveStore()` exists from v194, but v201 is where it learned the Rd/Road fold and got the
  per-execution registry memo (`gxStoresCached_`) that keeps `mapPermissionLocation_` — one lookup per
  employee × permission location — from turning one sheet read into hundreds. **v211** is the floor for the bug reporter:
  that is where `gxIngestBug` began self-installing the `bug_reports.context` header, and `gxWrite_`
  maps records onto the sheet's REAL header row — so on an older pin the state snapshot is dropped
  **silently** and the report still saves and still returns ok. The engine's `health` route
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

## Access
Owner + Mike to start (HR / managers later). GX Crew handles compensation + PII, so it is a **separate
deployment** from the all-staff kiosk Leaderboard — keep the sensitive surface isolated.

## Sync with the brain — run `/gxbrain` (or say "brain sync")
This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX
Core. Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` reads notes addressed to
`to_app=crew`, resolves done ones (`resolve_note`), and writes note-backs to any app (`add_note`). The
SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`crew`** in GX Core; `appsscript.json` pins `GXCore`
**v211** (this line has said **v179**, **v194**, **v203** and **v204** — check `health`, not prose);
version recorded on deploy via the shared `deploy_version` endpoint (`deploy.sh`, reading `crew.js?v=N`)
using the shared untracked `.gx_deploy_secret`.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work from the Command Center (dependency-ordered, filtered to `crew`). It reads the app key
above automatically.

**Close the loop when you're done:** when a dispatched or `/gxwhatsnext`-started task's goals look met,
proactively tell Sky and **offer to ship/close it out.** Shipping (open/return the PR → `dev_update …
status=in_review`; on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command
Center. Find the job via `dev_queue` (filtered to `crew`) if you need its id.
