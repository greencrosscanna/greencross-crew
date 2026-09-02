# Handoff: GX Crew — Roster tab redesign ("People workspace")

## Overview

The GX Crew roster (`crew.js` → `renderRoster()`) is a 12-column table at a 1320px minimum
width inside a 1240px page, gated behind a page-wide **Edit mode** toggle with a **Save** button
per row, an identity panel that expands inline and pushes the table apart, and three sibling
tabs (Roster / Review / EoM) that split one person's record across three screens.

This handoff covers the approved replacement for the **Roster tab**: a two-pane *people
workspace*. A permanent people list (grouped by store) on the left; a single right pane that is
either **one person's whole record** or, when nobody is selected, the **queue of everything that
needs a decision** (what the Review tab used to hold) plus the Employee-of-the-Month panel.
Editing is save-as-you-go — no Edit mode, no per-row Save.

Approved direction: **B. People workspace**.

## About the design files

The `.dc.html` files in this bundle are **design references written in HTML** — working
prototypes that show the intended look and behavior. They are **not production code to copy**.
They render through a small local runtime (`support.js`) that turns the template + logic class
into React at load time; that runtime is a preview harness, not something to ship.

The task is to **recreate these designs inside GX Crew's actual environment**: no build step,
plain ES5-flavored JavaScript in `crew.js`, DOM built with the existing `el()` / `esc()` /
`card()` helpers, all color and type from `gx-theme.css` custom properties loaded from Pages.
Every literal hex in the prototypes maps to a `--gx-*` token (table below) — **use the token,
never the hex**. Do not restyle or fork a shared `gx-theme` component from inside Crew; if the
shared layer needs something, `add_note` to `core-admin`.

## Fidelity

**High-fidelity.** Colors, type sizes, spacing, radii and states are final and are all taken
from `gx-theme.css`. Recreate pixel-for-pixel. The one deliberate stand-in: store colors in the
prototype are hard-coded (`bend #22d3ee`, `center #60a5fa`, `river-rd #a78bfa`, `corporate` no
color). In the real app they must come from `GXStores.color(id)` — store color is data from
the GX Core registry, never a constant in the app.

Sample people, permit numbers, wages and review items in `crew-data.js` are **invented**. No real
PII is in this bundle.

---

## Screens / views

### 1. App chrome (unchanged, stated so the recreation matches)

- `.gx-topnav` from `gx-theme.css`: brand (`gx-logo.png`, height 22px) + `Crew` subtitle
  (11px/700, `--gx-text-mute`, uppercase, 1.1px tracking), then the app's established tab row,
  then the right cluster (clock + user chip). Min-height 52px, `--gx-surface` background,
  1px `--gx-border` bottom.
- The tab row keeps whatever the app's real sibling tabs are; **Roster** is the active tab
  (`box-shadow: inset 0 -2px 0 var(--gx-green)`, color `--gx-text`). The prototype shows
  `Roster / Incentive / Payroll` as placeholders — substitute the real ones.
- Review and EoM disappear as tabs. Their content moves into this screen (see §3).

### 2. Sub nav — the roster's own controls

A `.gx-subnav`-shaped row directly under the top nav: `display:flex; flex-wrap:wrap;
align-items:center; gap:9px; padding:9px 18px; background:var(--gx-surface); border-bottom:1px
solid var(--gx-border)`. Contents left to right:

| Control | Spec |
|---|---|
| Search | `flex:1 1 320px; max-width:460px`. Input: `--gx-surface-3` bg, 1px `--gx-border`, radius `--gx-radius-md` (8px), 13px text, padding `7px 12px 7px 32px`, `⌕` glyph absolutely positioned at left 11px / top 7px in `--gx-text-mute`. Placeholder "Search people, permits, stores…". Matches name, **nickname**, store label, role, employee number **and permit number**. |
| Scope segmented | Container `--gx-surface-2`, 1px `--gx-border`, radius 8px, 2px padding. Three buttons — `Active`, `Gaps <n>`, `Retired` — 12px/600, padding `6px 12px`, radius `--gx-radius` (6px). Selected: `--gx-border` background, `--gx-text`. Unselected: transparent, `--gx-text-dim`. Replaces today's three loose checkboxes. |
| Divider | 1px × 22px, `--gx-border`. |
| Store pills | Unchanged behavior from today's `storePills()`: multi-select, derived from the loaded roster (not the registry, so `corporate` and the "No store" defect bucket both appear), counts computed after search but before the store filter, zero-count pills dim to `.45` rather than disappearing. Visual: `padding:4px 10px`, radius pill, `--gx-surface-2` bg, 11.5px/600, 6px color dot, tabular-nums count in `--gx-text-mute`. Selected: border becomes the store color, label `--gx-text`. |
| Attention chip | `margin-left:auto`. Pill button, `padding:6px 13px`, 12px/600. Label `"<n> to look at"`, or `"All clear"` at zero. 7px status dot: `--gx-red` if any high-severity item, `--gx-gold` if any, else `--gx-green`. When the overview is showing (nobody selected) the chip is "on": `rgba(212,168,71,.07)` background, `--gx-gold-line` border, `--gx-gold` text. Otherwise transparent / `--gx-border` / `--gx-text-dim`. Clicking it deselects the current person and returns to the overview. |

### 3. Body — two panes, full height

Page is `height:100vh; display:flex; flex-direction:column; overflow:hidden`; the two panes each
scroll independently. Only these two panes scroll — the page itself never does, and nothing
scrolls sideways.

#### 3a. People list (left)

`width:340px; flex:none; border-right:1px solid var(--gx-border); background:#0d1211`
(a half-step between `--gx-bg` and `--gx-surface`; if a token is preferred use `--gx-bg`).
Scrolls vertically, `padding:6px 0 40px`.

**Store group header** — sticky at the top of its group (`position:sticky; top:0`, same
background, z-index 1): 6px store-color dot, label 10px/700 uppercase 1.2px tracking in
`--gx-text-mute`, count right-aligned 10.5px `#3d4744` tabular-nums. Padding `10px 14px 6px`.

**Person row** — a full-width `<button>`: `display:flex; align-items:center; gap:10px;
padding:7px 14px 7px 12px; border-left:2px solid transparent`. Left to right:

- 28px avatar puck — circle, `--gx-surface-3` bg, 1px `--gx-border-strong`, overflow hidden.
  Renders the DiceBear avatar when `avatar_config` exists, otherwise two-letter initials at
  9.5px/700 in `--gx-text-dim`. `_gchat` keeps the GC-hat SVG overlay. Avatar URL construction is
  unchanged from `buildAvatarUrl()` in `crew.js` — do not tidy those parameter rules.
- Name 13px/600 `--gx-text`, ellipsized. A blanked identity row shows `⚠ Record blanked` in
  `--gx-red`.
- Sub-line 11px `--gx-text-mute`: role, plus `· "Nickname"` when set.
- `★` in `--gx-gold` if this person is Employee of the Month.
- 7px status dot when the record has gaps: `--gx-red` for an expired permit, a missing permit, a
  manager with no account, or a blanked name; `--gx-gold` otherwise. `title` attribute lists the
  missing fields by name.

Selected row: `border-left-color: var(--gx-green)`, background `--gx-surface-2`. Retired rows
render at `opacity:.6`. Groups with no matches are omitted entirely.

#### 3b. Overview pane (right, when nobody is selected)

`padding:26px 30px 60px; max-width:900px`. This is where the Review and EoM tabs went.

1. **Title** — "Everything that needs a person", 23px/700, `-.3px` tracking, `--gx-text`.
   Sub-line 13px `--gx-text-mute`: "*n* open questions · *n* permits inside 90 days · *n* records
   with a gap".
2. **Stat tiles** — `grid; repeat(auto-fit, minmax(150px,1fr)); gap:10px`. Card: `--gx-surface`,
   1px `--gx-border`, radius `--gx-radius-lg` (10px), padding `14px 16px`. Number 23px/700
   tabular-nums, `-.4px` tracking; label 11px `--gx-text-mute`. Four tiles: active people
   (`--gx-text`), open questions (gold if any), permits inside 90 days (red if any), records with
   a gap (gold if any).
3. **Open questions** — section head 11px/700 uppercase 1.4px `--gx-text-dim`, with the
   qualifier "nothing here has been applied" in `--gx-text-mute` beside it. One card per item:
   `--gx-surface`, 1px `--gx-border`, `border-left:3px solid` severity color (`--gx-red` high,
   `--gx-gold` warn, `--gx-border-strong` info), radius 9px, padding `12px 14px`, 8px apart.
   Card is `display:flex; flex-wrap:wrap; gap:12px 14px` with three children: a person button
   (`flex:0 1 190px; min-width:150px` — 28px avatar, name 13px/600, kind label 9.5px/700
   uppercase in the severity color), the detail text (`flex:1 1 240px; min-width:180px`, 12.5px
   `--gx-text-dim`), and the action pair (`margin-left:auto`, nowrap): a primary green button
   whose label depends on the kind — "Merge them" / "Apply METRC spelling" / "Apply Leaderboard
   role" / "Open record" — and a secondary "Not a problem".
   Empty state: a bordered card, centered, `✓ Every source agrees. Nothing to review.` in
   `--gx-green`.
4. **Employee of the Month** — one card, `--gx-surface`, `rgba(212,168,71,.45)` border, radius
   10px, padding `16px 18px`: 48px avatar with a `--gx-gold` ring, name 15px/700, sub-line
   (role · store · since *month*), and an "Open record" button in gold. Below it the reign log as
   a plain list: name, span ("Aug 2026 — present", one month, or a range), and provenance
   ("set by sky" / "recorded"). A deliberate "Nobody held it" entry renders italic in
   `--gx-text-mute` — it is part of the record, not a gap in it.

#### 3c. Person record (right, when someone is selected)

**Header** — `padding:24px 30px 18px`, background `#0d1211`, 1px `--gx-border` bottom:
62px avatar; the full name as a borderless inline input at 24px/700 `-.4px` (edits in place);
nickname beside it in `--gx-green` 14px; a `retired` tag when applicable; then a meta line
(12.5px `--gx-text-dim`): store dot + label · role · tenure · `#employee_number`. Right cluster:
`★ EoM` toggle pill (gold when held, `--gx-border-strong` / `--gx-text-mute` when not),
`Avatar` button, and a `···` overflow.

**Open questions for this person** — the same card as §3b.3, filtered to this person, shown
first in the body so a disagreement is answered where the record is being read. Includes the
now → proposed comparison chips (`--gx-surface-3` / `--gx-green` bordered).

**Field grid** — `grid; repeat(auto-fit, minmax(190px,1fr)); gap:10px`. Each field is a card:
`--gx-surface`, 1px `--gx-border`, radius 9px, padding `11px 13px`, containing a 9.5px/700
uppercase label in `--gx-text-mute`, the control (`--gx-surface-3`, 1px `--gx-border`, radius 6px,
`7px 9px`, 13.5px), and a 10.5px note line. A field that is missing something borders
`rgba(212,168,71,.5)` and its note turns `--gx-gold`. Fields in order: Nickname, Store, Role,
Hire date, Wage, Birthday, Shirt size, Employee # (disabled, `--gx-text-mute`, note "Issued,
never reused").

**OLCC permit** — read-only card: permit number in `ui-monospace` 14px with `.5px` tracking, a
status pill (ACTIVE green / gold when inside 90 days / red when expired or unknown), and a right-
aligned line: "*n* days left · expires *date*" or "Expired *n* days ago · *date*" or "METRC has
no matching record under this name". A 4px progress bar underneath in the status color. Card
border turns `rgba(239,68,68,.4)` when expired or missing.

**Links & visibility** — three pills (Dutchie id, GX account, employee #), each `--gx-surface-3`
with a 9.5px uppercase label; a missing Dutchie id shows gold, a manager with no account shows
red. Below: the sentence "Every save is read-merge-write, so these links survive it. Blank one
and the join to SPIFF, Leaderboard or email breaks silently." Then the celebrations checkbox —
"Show birthday and work anniversary on the kiosk" — which maps to `celebrations_opt_out`
inverted.

**Footer actions** — `Merge duplicate…` on the left, `Retire` / `Un-retire` in `--gx-red` text on
the right, above a `--gx-border` rule.

---

## Interactions & behavior

- **No Edit mode.** Every control is live. A field commits on change and a toast confirms:
  pill at the bottom center, `--gx-surface-2`, 1px `--gx-green-dim`, radius pill, `8px 18px`,
  12.5px `--gx-green`, auto-dismiss at 1.6s. Recommended production behavior: debounce text
  fields ~600ms, commit selects and dates immediately, and offer an undo inside the toast.
- **One field per write.** Today `roster_save` posts five fields at once. Field-level saves must
  still go through the read-merge-write path — a partial write blanks `dutchie_employee_id` and
  `user_id`. Consider a one-line confirm for `full_name`, `home_store` and `role_title`, the three
  fields a careless write damages worst.
- **Selection.** Clicking a person in the list sets the selection; the attention chip clears it.
  Selection does not change list scroll position. Recommended addition (not prototyped): ↑/↓ to
  move the selection and type-to-find in the list.
- **Resolving a question** removes the card, decrements the chip count, and toasts what was
  applied. Three answers are recorded, exactly as `review_resolve` does today: accept, keep,
  dismiss. "I looked and it is fine" must silence an item as firmly as a correction.
- **EoM toggle** is optimistic — the star moves, then the write goes out; on failure it moves
  back rather than lying about what is stored. Keyed on `employee_id`, never on a name.
- **Sorting.** The list is alphabetical inside each store group. The blanks-always-sink rule from
  `sortRows()` still applies anywhere values are compared.
- **Loading.** First roster read is ~10s cold. Keep the existing status line; the list column
  should show a skeleton rather than an empty pane, since an empty roster reads as "nobody works
  here".
- **Responsive.** Desktop only, per the brief. Below ~1100px the sub nav wraps to two lines; the
  list column stays 340px.

## State

| State | Purpose |
|---|---|
| `q` | search string |
| `scope` | `active` \| `attention` \| `retired` (replaces `showRetired` + `onlyFlagged`; `retired` still triggers the refetch that `showRetired` does today) |
| `storeFilter` | `{ [store_id]: true }`, multi-select |
| `selected` | `employee_id` or `null` (null = overview) |
| `eom` | `employee_id` or `null` |
| `dismissed` | resolved review ids, for optimistic removal |
| `celebrations` | local override per person until the write lands |
| `toast` | save confirmation string |

Gone: `editMode`, `openId` for the inline edit row, `mergeFrom` (merge moves to a proper compare
view — not yet designed), `view`.

## Design tokens

All from `gx-theme.css` — the prototypes inline the hex values only because the harness has no
stylesheet. Use the variable.

| Token | Value | Used for |
|---|---|---|
| `--gx-bg` | `#0a0e0d` | page |
| `--gx-surface` | `#121715` | cards, top nav, sub nav |
| `--gx-surface-2` | `#161c1a` | selected row, segmented container, toast |
| `--gx-surface-3` | `#1a221f` | inputs, avatar puck, link pills |
| `--gx-border` | `#232a27` | hairlines, input borders |
| `--gx-border-strong` | `#2e3733` | secondary buttons, avatar ring |
| `--gx-text` | `#e6ece9` | primary text |
| `--gx-text-dim` | `#8a958f` | secondary text |
| `--gx-text-mute` | `#5e6864` | labels, notes |
| `--gx-green` | `#4ade80` | primary action, active tab, nicknames, selected row edge |
| `--gx-green-dim` | `#2f8a52` | focus ring, toast border |
| `--gx-green-ink` | `#06210f` | text on a green fill |
| `--gx-gold` / `--gx-gold-line` / `--gx-gold-soft` | `#d4a847` / `rgba(212,168,71,.6)` / `rgba(212,168,71,.07)` | EoM, warnings, gaps |
| `--gx-red` / `--gx-red-soft` | `#ef4444` / `rgba(239,68,68,.10)` | expired, damaged, unreachable |
| `--gx-font` | `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif` | everything |
| Radii | `--gx-radius-sm` 4 · `--gx-radius` 6 · `--gx-radius-md` 8 · `--gx-radius-lg` 10 · `--gx-radius-pill` 999 | |

Type scale in use: 23px/700 page title · 15px/700 card title · 13.5px controls · 13px/600 list
name · 12.5px body · 11–11.5px meta · 10px/700 uppercase 1.2–1.4px section labels · 9.5px/700
uppercase field labels.

## Constraints to carry forward (each one exists because of an incident)

- `role_title` is a **closed set of four** — Admin, Store Manager, Assistant Manager, Budtender —
  enforced server-side. An off-list value already held on a record is carried as its own selected
  option and labeled, never silently dropped.
- `employee_number` is **issued, never typed**, and never reused. Read-only everywhere in the UI.
- **Every write is read-merge-write.** `gxWrite_` replaces the whole row.
- Birthdays are **month + day only**. Leaderboard receives a derived celebrations flag, never a
  date. Celebrations opt-out stays an explicit per-person toggle — it cannot be inferred from role
  or store.
- Store colors come from `GXStores`, sourced from the GX Core registry.
- The store pill set is derived from the **loaded roster**, not the registry, so `corporate` and
  the empty "No store" bucket stay reachable.
- The bug-report snapshot must keep omitting the search box contents — Crew holds the PII.

## Assets

- `gx-logo.png`, `gc-icon.png`, `gc-touch-icon.png` — loaded from
  `https://greencrosscanna.github.io/greencross-gx-theme/`. Already referenced by `index.html`;
  nothing new to add.
- Avatars — DiceBear `avataaars` v9 via `buildAvatarUrl()`, seeded on `employee_number`. The GC
  hat is an inline SVG overlay for the `_gchat` top. Both already exist in `crew.js`.
- No new icons or images are introduced by this design. The `⌕`, `★`, `→`, `✓`, `···` marks are
  text characters.

## Files in this bundle

| File | What it is |
|---|---|
| `Crew Roster - B. People workspace.dc.html` | **The design to build.** Interactive: search, scope, pills, selection, resolving questions, EoM toggle, save toasts. |
| `crew-data.js` | Invented sample roster, review queue and EoM log. Field names and value shapes match `Code.gs`'s roster row builder and `rowFlags_`. |
| `support.js` | Preview runtime for the `.dc.html` files. Not part of the design; do not port. |

Open the `.dc.html` directly in a browser to view it.

### `screenshots/`

| File | State captured |
|---|---|
| `01-B-people-workspace.png` | Overview pane — stat tiles, open-questions queue, EoM panel |
| `02-B-people-workspace.png` | Person record — Iggy Barrera, expired permit, question card, field grid |
| `03-B-people-workspace.png` | Search in the sub nav |

## Source read while designing

`index.html` (shell + all app-local CSS), `crew.js` (roster, review, EoM, avatars, pills, flags),
`apps-script/Code.gs` (`rowFlags_`, `ROLE_TITLES`, `SHIRT_SIZES`, `normRole_`, roster row builder),
`tests/roster_filter_test.js`, `CLAUDE.md`, and `gx-theme.css`.
