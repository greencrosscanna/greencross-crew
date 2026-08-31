# Handoff: GX Crew — Incentive tab polish

## Overview

A visual pass over the existing **Incentive** tab in GX Crew (`crew.js` → `paintIncentive()` +
the `.crew-inc-*` block in `index.html`). **Nothing structural changes**: same three tables
(Admin / Managers / Budtenders), same columns, same math, same routes, same workflow.
What changes is how the screen reads — it currently reads as the spreadsheet it was ported
from, and this makes it read as a payout screen.

The five changes, in order of how much they matter:

1. **A header band.** Title, live/imported badge, period switcher and the period's own facts
   move into a `--crew-rail` band, separated from the tables. Actions (Print PDF / Export CSV /
   settings gear) move up into that band, right-aligned. The gear stops floating over the table.
2. **Totals become tiles** in the same shape the roster overview already uses
   (`.crew-stat`), with the grand total in a green-edged tile. Today they are a bare `<dl>`.
3. **The highlight budget is cut back.** Today five columns can go green at once and Payroll is
   green too, so nothing stands out. Now: a *missed* target renders `--gx-text-dim`, a *met* one
   renders `--gx-green` at weight 600, and **Payroll** keeps the strong green plus a tinted
   column and a green column header — it is the only figure the Capstone export carries and it
   should be the only figure that looks like money.
4. **One column grid across all three tables.** Name, Store, the SPIFF field and the
   Bonus / $/hr / Payroll block sit at identical x positions in Admin, Managers and Budtenders.
   Admin leaves its unused slots blank rather than stretching to fill. Vertical hairlines mark
   the two group boundaries: identity | performance | money.
5. **`$` inside the SPIFF field**, and budtenders can be **grouped by store** with a toggle.

## About the design files

`Incentive - polished.dc.html` is a **design reference written in HTML** — a working prototype
of the intended look, not production code. It renders through a small local preview runtime
(`support.js`); that runtime is part of the harness and must not be ported.

The task is to recreate it inside GX Crew's real environment: no build step, plain
ES5-flavoured JavaScript in `crew.js`, DOM assembled with the existing `el()` / `esc()` string
builders, and **every color and radius from a `--gx-*` custom property in `gx-theme.css`** —
the prototype inlines hex values only because the harness has no stylesheet. The mapping table
below is exhaustive; there is no color in this design that is not already a token.

Do not restyle or fork a shared `gx-theme` component from inside Crew. If the shared layer
needs something, `add_note` to `core-admin`.

## Fidelity

**High-fidelity.** Colors, type sizes, spacing, radii and the column grid are final.
Recreate pixel-for-pixel.

Two deliberate stand-ins:

- **Sample people, stores and figures are invented.** No real PII is in this bundle. The figures
  are internally consistent: they were computed through the real `calcBud` / `calcMgr` /
  `calcAdmin` at the default thresholds pinned in `tests/incentive_math_test.js`
  (`hoursPerPeriod` 80; budtender `txnQualify` 200 / `txnQualifyLowVol` 150 / `aovTarget` 33 /
  `aovBonus` 25 / `discountMaxPct` 1.5 / `discountBonus` 25 / `attendanceBonus` 15; manager
  sales tiers 110→$300, 105→$200, 100→$100, `aovTarget` 33 / `aovBonus` 50 /
  `teamAttendancePerHead` 25; admin tiers 110→$600, 105→$450, 100→$300, `maxPerStore` 50).
  Jo Castellan's row is deliberate: bonus $20, payroll $0, so the "payroll is a muted em-dash,
  not `$0`" rule is visible.
- **Store colors are hard-coded** (`bend #22d3ee`, `center #60a5fa`, `river-rd #a78bfa`).
  In the app they come from `GXStores.color(id)` — store color is registry data, never a
  constant. Store *names* likewise come from `incStoreName()` / `GXStores.name()`, never the
  label the row arrived with.

## Screens / views

One screen, one state: **a live open period, editable, prepared by a non-approver.**
`source: 'live'`, `can_edit: true`, `can_approve: false`, `workflow.status: 'draft'`.

The other states this screen has (`imported` / pending / sent-back / approved / loading / error)
are **unchanged in structure** — apply the same visual rules and keep today's logic in
`incHeadActions()` verbatim.

### 1. App chrome (unchanged — stated so the recreation matches)

`.gx-topnav` from `gx-theme.css`: brand (`gx-logo.png`, 22px) + `Crew` subtitle
(11px/700, `--gx-text-mute`, uppercase, 1.1px tracking), tab row (`Roster`, `Incentive` —
Incentive active: `box-shadow: inset 0 -2px 0 var(--gx-green)`, color `--gx-text`), then the
clock and user chip. Min-height 52px, `--gx-surface`, 1px `--gx-border` bottom.

The roster sub nav stays hidden on this tab, exactly as `paintTab()` does today.

### 2. Header band  (new container)

Replaces `.crew-inc-head` + `.crew-inc-tot` + the free-floating `.crew-inc-gear`.

- Container: `background: var(--crew-rail)` (`#0d1211`), `border-bottom: 1px solid var(--gx-border)`,
  `padding: 16px 22px 18px`.
- Top row: `display:flex; align-items:flex-start; gap:20px; flex-wrap:wrap`.

**Left cluster**

| Part | Spec |
|---|---|
| Title | "Incentive", 20px/700, `-.3px` tracking, `--gx-text` |
| Source badge | inline-flex, `gap:6px`, `padding:3px 9px 3px 7px`, radius pill, 10.5px/700 uppercase `.06em`. Live: 6px `--gx-green` dot + "Live", bg `#14251c`, border `#24503a`, text `--gx-green`. Imported keeps today's amber: bg `#2a2118`, border `#4a3a24`, text `#e0a458`, label "As paid". |
| Period switcher | One bordered group: `--gx-surface-2`, 1px `--gx-border`, radius 8px, `overflow:hidden`. `‹` button (`border-right: 1px solid --gx-border`, `padding:6px 10px`, `--gx-text-dim`), the existing `#incPeriod` `<select>` unstyled inside it (transparent bg, no border, 13px/600 `--gx-text`, `padding:6px 8px`), `›` button mirrored. The arrows are prev/next over the same `periods` array the select holds; disable and dim to `--gx-border-strong` at the ends. |
| Period label | The option text becomes **`Aug 17 – Aug 30, 2026`**, not `2026-08-17 → 2026-08-30`. Imported options keep the ` · as paid` suffix. Keep `.crew-inc-printpp` (the print-only plain-text twin) exactly as it is. |
| Facts line | 12px `--gx-text-mute`, beside the switcher: `Current period · closes in 3 days · 13 people`. Derived, not new data. |

**Right cluster** — `display:flex; gap:8px`, all buttons `padding:8px 14px`, radius 7px, 12.5px:

`Print PDF` (`.gx-btn.gx-btn-green`) · `Export Payroll CSV` (`.gx-btn`; the "(Capstone)"
qualifier moves to the button's `title`) · the 34×34 gear (`.gx-btn`, approver-only, unchanged
behavior, `title` unchanged). On a closed period the primary slot carries
`Send for approval` / `Approve & Print PDF` per `incHeadActions()` — that logic is untouched.

**Totals tiles** — `margin-top:16px`, `display:grid; grid-template-columns:repeat(4,minmax(160px,1fr));
gap:10px; max-width:820px`. Each tile: `--gx-surface`, 1px `--gx-border`, radius `--gx-radius-lg`,
`padding:12px 14px`; number 22px/700, `-.4px`, tabular-nums, `--gx-text`; label 10.5px
`--gx-text-mute`, uppercase, `.06em`, `margin-top:3px`.
Order and content unchanged: Manager bonuses · Budtender bonuses · Admin · **Total payroll**.
The total tile borders `#24503a` and its number is `--gx-green`.

### 3. Tables

Body padding `20px 22px 60px`.

**Section head** — `display:flex; align-items:center; gap:9px; margin:22px 0 8px`
(first one `margin-top:0`): label 11.5px/700 uppercase `.1em` `--gx-text-dim`, then a count in
11.5px `--gx-text-mute` ("3 people"). Replaces `.crew-inc-sec`.

**Table shell** — wrapper `overflow:hidden`, 1px `--gx-border`, radius 9px,
`background: var(--crew-rail)`. Table `width:100%`, `table-layout:fixed`, `border-collapse:collapse`,
12.5px.

**Header cells** — `padding:9px 12px`, 10.5px/700, uppercase, `.07em`, `--gx-text-mute`,
`background: var(--gx-surface)`, `border-bottom: 1px solid var(--gx-border)`, sticky as today.
The **Payroll** header is `--gx-green`.

**Body cells** — `padding:9px 12px`, `border-bottom: 1px solid var(--crew-rule)`,
`font-variant-numeric: tabular-nums`. Row hover `#121917`.

**The column grid.** All three tables use the same twelve slots, so the money block lines up
down the whole screen. Widths below are the px values used at a 1354px table (the pane at
1400px); express them as the same ratios. Set `box-sizing:border-box` and put the width on the
header cell.

| # | Slot | px | Admin | Managers | Budtenders |
|---|---|---|---|---|---|
| 1 | Name | 186 | Name | Manager | Name |
| 2 | Store | 143 | *(empty)* | Store | Store |
| 3 | Target / Txn | 115 | Target | Target | Txn |
| 4 | Sales | 115 | Actual | Sales | Sales |
| 5 | % Goal | 88 | % Goal | % Goal | *(Discount spans 5+6 = 187)* |
| 6 | Discount | 99 | *(empty, colspan 4 → 401)* | Discount | ↳ |
| 7 | AOV | 93 | ↳ | AOV | AOV |
| 8 | Attendance | 99 | ↳ | Team att. | Att. |
| 9 | SPIFF | 110 | ↳ | SPIFF | SPIFF |
| 10 | Bonus | 99 | Bonus | Bonus | Bonus |
| 11 | $/hr | 88 | $/hr | $/hr | $/hr |
| 12 | Payroll | 119 | Payroll | Payroll | Payroll |

Admin renders 9 cells: `Name`, an empty cell in slot 2, `Target`, `Actual`, `% Goal`, an empty
`colspan="4"` cell over slots 6–9, then `Bonus`, `$/hr`, `Payroll`.

**Two vertical rules**, both `border-left`: `--gx-border` on the header cell, `--crew-rule` on
body cells.
- Before slot 3 (Target / Txn) — separates identity from performance.
- Before slot 10 (Bonus) — separates performance from money. *(This one exists today; it is the
  one being matched.)*

**Number treatment**

| Figure | Treatment |
|---|---|
| Target (managers, admin) | `--gx-text-mute` — it is the bar, not the result |
| Sales / Actual, Txn (when not a hit), Team att. | `--gx-text` |
| A **met** target (`% Goal ≥ 100`, discount `≤ goal`, AOV `≥ target`, txn qualifies) | `--gx-green`, weight **600** |
| A **missed** target | `--gx-text-dim`, weight 400 |
| Bonus | `--gx-text` |
| $/hr | `--gx-text-mute` |
| **Payroll** | `--gx-green`, weight 700, cell background `#101614`, dotted underline `--gx-border-strong` at `3px` offset, `cursor:help`, breakdown in `title` — all as today |
| A zero or absent payroll | `--gx-text-mute`, weight 400, em-dash. `''` and `0` stay different claims. |

The specificity trap in today's CSS still applies: every color rule must be written
`.crew-inc-tbl td.crew-inc-hit`, not `.crew-inc-hit`.

**SPIFF field** — `display:inline-flex` shell: `--gx-surface-3`, 1px `--gx-border`, radius 6px,
`padding:0 6px 0 7px`; inside it a `$` in 11.5px `--gx-text-mute`, then the existing
`<input type="number" min="0" step="5">` with `background:transparent; border:0; outline:none;
width:46px; text-align:right; padding:4px 2px; 12.5px; tabular-nums`. Behavior unchanged:
600ms debounce on input, commit again on blur. When not editable it renders as plain text
(`--gx-text-mute` em-dash at zero), and the print rules that strip the input still apply — they
now need to strip the `$` shell too, since paper shows the value with its own `$`.

**Attendance** — unchanged 15×15 checkbox, `accent-color: var(--gx-green)`, but the column
centres (`text-align:center`) instead of right-aligning.

**Budtenders grouped by store** — a pill toggle at the right end of the section head:
`--gx-surface-2`, 1px `--gx-border-strong`, radius pill, `padding:5px 12px`, 11.5px/600,
`--gx-text-dim`; label `Group by store` / `Grouped by store`. When on, a full-width group row
precedes each store's block: `background:#101614`, 1px `--crew-rule` top and bottom,
`padding:7px 12px`, a 6px store dot, the store name at 10px/700 uppercase 1.2px `--gx-text-dim`,
and the count in 10.5px `--crew-count` — the same treatment as the roster rail's sticky group
header. Rows stay in the order the engine sent them, grouped by `store_id`. The per-row Store
cell stays visible; it is the store's color that carries the grouping, and hiding the cell
would break the shared grid.

**Footnote** — unchanged copy, `margin:14px 0 0`, 12px `--gx-text-mute`, `max-width:760px`,
`line-height:1.55`. The imported-period second paragraph is unchanged too.

## Interactions & behavior

Everything here already exists in `crew.js`; nothing new is introduced.

- **No Edit mode, no Save button.** Attendance commits on change; SPIFF on a 600ms pause and
  again on blur. A toast names what was written.
- **Editing re-scores in the browser.** `incSave()` updates `inc.data.inputs` in place and calls
  `paintIncentive()`; the row, the section totals and the four tiles all move without a round
  trip. Ticking a budtender's attendance also moves their manager's **Team att.** and payroll.
- **Period change** calls `loadIncentive(value)`. The new `‹ ›` arrows step the same array.
- **Print / Export / Approve / Send / Send-back / gear** — all unchanged.
- **Group-by-store** is view-only state; it must not survive a period change or be persisted
  anywhere the engine sees.
- **Responsive**: desktop only. The table wrapper keeps `overflow-x:auto`; below the grid's
  natural width the whole table scrolls sideways as one, so the columns stay aligned.

## State

| State | Purpose |
|---|---|
| `inc.data` / `inc.loading` / `inc.error` / `inc.pp` | unchanged |
| `inc.data.inputs[employee_id]` | `{ att, spiff }` — unchanged, keyed on **`employee_id`**, never `nameKey` |
| `incGrouped` (new) | boolean, budtender store grouping. View-only. |

## Design tokens

All from `gx-theme.css` except the three app-local half-steps already declared on `.gx-app`.

| Token | Value | Used for |
|---|---|---|
| `--gx-bg` | `#0a0e0d` | pane |
| `--gx-surface` | `#121715` | top nav, tiles, table header row |
| `--gx-surface-2` | `#161c1a` | secondary buttons, period switcher, group toggle |
| `--gx-surface-3` | `#1a221f` | SPIFF field shell |
| `--gx-border` | `#232a27` | hairlines, table header rule, vertical rules (header) |
| `--gx-border-strong` | `#2e3733` | secondary button borders, dotted payroll underline |
| `--gx-text` | `#e6ece9` | primary figures |
| `--gx-text-dim` | `#8a958f` | missed targets, section labels, store names |
| `--gx-text-mute` | `#5e6864` | column headers, targets, $/hr, notes |
| `--gx-green` | `#4ade80` | met targets, payroll, total, live badge |
| `--gx-green-ink` | `#06210f` | text on the green button |
| `--crew-rail` | `#0d1211` | header band, table shell background |
| `--crew-rule` | `#1c2320` | row rules, vertical rules (body) |
| `--crew-count` | `#3d4744` | group counts |
| — | `#14251c` / `#24503a` | live badge fill / border, total tile border |
| — | `#2a2118` / `#4a3a24` / `#e0a458` | imported badge (unchanged) |
| — | `#101614` | payroll column tint, group header row |
| — | `#121917` | row hover |
| Radii | `--gx-radius` 6 · `--gx-radius-md` 8 · `--gx-radius-lg` 10 · pill 999 | 7px on the header-band buttons, 9px on the table shell |
| Type | 20/700 title · 22/700 tile figure · 12.5px table body · 11.5px/700 section label · 10.5px/700 column header · 10px/700 group header | `--gx-font` throughout |

Store colors: `GXStores.color(store_id)`, with the prototype's `bend #22d3ee`,
`center #60a5fa`, `river-rd #a78bfa` standing in.

## Assets

None new. `gx-logo.png` from
`https://greencrosscanna.github.io/greencross-gx-theme/`, already referenced by `index.html`.
The `‹ › ⚙ ✓ ▾ $` marks are text characters.

## Files

| File | What it is |
|---|---|
| `Incentive - polished.dc.html` | **The design.** Open directly in a browser. The store-grouping toggle is live. |
| `support.js` | Preview runtime. Not part of the design; do not port. |
| `screenshots/01-incentive-live-period.png` | The screen as specified above. |

## Source read while designing

`crew.js` (`paintIncentive`, `incHeadActions`, `incPeriodSelect`, `incAdminTable`,
`incMgrTable`, `incBudTable`, `incSpiffCell`, `incWire`, `incSave`, `incExportCsv`,
`calcBud` / `calcMgr` / `calcAdmin`, `navBar`, `paintTab`), `index.html` (the `.crew-inc-*`,
print and settings-tray blocks, and the `.gx-app` local tokens),
`tests/incentive_view_test.js`, `tests/incentive_math_test.js`, `CLAUDE.md`, and the
`design_handoff_roster_workspace/` bundle for the token table and house style of this document.
