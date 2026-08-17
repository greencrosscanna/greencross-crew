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
- **Backend:** `apps-script/` (`Code.gs` doGet/doPost router + `appsscript.json`, binds **GXCore v45**).
  Deploy the engine with clasp (`clasp create --type webapp --rootDir apps-script` on first setup, then
  `clasp push` / `clasp deploy`).
- **Shared dev files** (`deploy.sh`, `.claude/` SessionStart hook + settings) come from gx-theme via
  `gx-sync.sh`, filled from `.gx_app` (= `crew`). Re-run `./gx-sync.sh` to refresh them. This CLAUDE.md is
  intentionally **not** synced — keep it app-specific.

## Access
Owner + Mike to start (HR / managers later). GX Crew handles compensation + PII, so it is a **separate
deployment** from the all-staff kiosk Leaderboard — keep the sensitive surface isolated.

## Sync with the brain — run `/gxbrain` (or say "brain sync")
This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX
Core. Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` reads notes addressed to
`to_app=crew`, resolves done ones (`resolve_note`), and writes note-backs to any app (`add_note`). The
SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`crew`** in GX Core; binds `GXCore` library **v45**;
version recorded on deploy via the shared `deploy_version` endpoint (`deploy.sh`, reading `crew.js?v=N`)
using the shared untracked `.gx_deploy_secret`.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work from the Command Center (dependency-ordered, filtered to `crew`). It reads the app key
above automatically.

**Close the loop when you're done:** when a dispatched or `/gxwhatsnext`-started task's goals look met,
proactively tell Sky and **offer to ship/close it out.** Shipping (open/return the PR → `dev_update …
status=in_review`; on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command
Center. Find the job via `dev_queue` (filtered to `crew`) if you need its id.
