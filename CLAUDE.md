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

## Layout
- **Frontend:** `index.html` (shell; loads `gx-theme.css` + `gx-client.js` from gx-theme by URL, and
  `crew.js?v=N`) + `crew.js` (app logic, wired to `window.GX` for GX Core JSONP). The **`?v=N`**
  cache-buster on the `crew.js` tag is the single source of truth `deploy.sh` reads for the version —
  bump it on every ship.
- **Engine deploy:** `clasp push` then `clasp update-deployment <id>` — **redeploy the existing id**,
  never `create-deployment`, which mints a *new* /exec URL and orphans `cfg.crewEngineUrl`.
  Note `clasp create` clones the remote manifest over the local one, wiping the GXCore binding;
  restore `appsscript.json` from git before the first push. (`clasp open` is `open-script` in v3.)
- **Backend:** `apps-script/` (`Code.gs` doGet/doPost router + `appsscript.json`, pins **GXCore v194** —
  v139 is where `gxUpsertEmployee` began read-merge-writing instead of rebuilding a row from the payload,
  and v150 made that unconditional plus refused to blank a live `full_name`, so anything below v150 can
  still blank the columns a partial write omits. The engine's `health` route reports the version the LIVE
  DEPLOYMENT runs (`lib`), which is the only pin that matters — a manifest bump that was never deployed
  still runs the old snapshot).
  Deploy the engine with clasp (`clasp create --type webapp --rootDir apps-script` on first setup, then
  `clasp push` / `clasp deploy`).
- **Local loop:** `python3 serve.py` → <http://localhost:8755>. No build step — the working tree IS the
  app, so edit + reload is the whole loop. The backend it talks to is **live**; `gx-dev.js` blocks writes
  until you arm them, and `gx-preflight.sh` runs as a **pre-push hook** refusing dev leftovers. No automated
  test suite yet — for anything touching pay, the check that counts is the **penny-match** described above.
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

## Access
Owner + Mike to start (HR / managers later). GX Crew handles compensation + PII, so it is a **separate
deployment** from the all-staff kiosk Leaderboard — keep the sensitive surface isolated.

## Sync with the brain — run `/gxbrain` (or say "brain sync")
This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX
Core. Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` reads notes addressed to
`to_app=crew`, resolves done ones (`resolve_note`), and writes note-backs to any app (`add_note`). The
SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`crew`** in GX Core; `appsscript.json` pins `GXCore`
**v194** (this line said **v179** until 2026-08-22 — check `health`, not prose);
version recorded on deploy via the shared `deploy_version` endpoint (`deploy.sh`, reading `crew.js?v=N`)
using the shared untracked `.gx_deploy_secret`.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work from the Command Center (dependency-ordered, filtered to `crew`). It reads the app key
above automatically.

**Close the loop when you're done:** when a dispatched or `/gxwhatsnext`-started task's goals look met,
proactively tell Sky and **offer to ship/close it out.** Shipping (open/return the PR → `dev_update …
status=in_review`; on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command
Center. Find the job via `dev_queue` (filtered to `crew`) if you need its id.
