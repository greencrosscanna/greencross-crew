#!/usr/bin/env node
/* ─── Crew roster filter (store pills) — tests ────────────────────────────────────────────────────
 *
 *   RUN:  node tests/roster_filter_test.js    (from the repo root; no deps, no network, no login)
 *
 * WHY THESE
 * The roster is the screen Mike actually uses, and every failure below is silent — it hides people
 * rather than erroring, which on an HR roster reads as "they are not employed here":
 *
 *   storesInRoster   pill ORDER and MEMBERSHIP. The set is derived from the loaded roster, not from
 *                    GX Core's store registry, because `corporate` is deliberately absent from that
 *                    registry (it is not a shop). A registry-driven row would drop the admin team
 *                    from the filter entirely and nothing would say so. The blank-store bucket has
 *                    to survive for the same reason: a person whose home_store got blanked by a
 *                    partial write is exactly who you need to be able to find.
 *
 *   filterByStore    an EMPTY filter must pass everything through. Getting that backwards shows an
 *                    empty roster on first paint, which looks like a failed load, not a filter.
 *
 *   storePills       the counts must be computed from the set BEFORE the store filter is applied.
 *                    Count after, and every pill you have not selected reads 0 — so the filter
 *                    tells you there is nobody at Center at the exact moment you want to go there.
 *                    A zero-count pill has to DIM rather than disappear: a row that reflows under
 *                    the cursor is how you click the wrong store.
 *
 *   scopedRows       the segmented Active / Gaps / Retired control replaced three checkboxes, and
 *                    it is now the FIRST of three stacked filters. Getting `active` wrong shows
 *                    retired staff as current employees; getting `retired` wrong shows nobody at
 *                    all on a scope whose whole job is to find somebody who left.
 *
 *   needsSetup /     who lands in the overview's "New here" list. It has to stay a SUBSET of the
 *   byArrival        flagged rows -- a ten-year employee with no shirt size is not a new starter,
 *                    and listing them buries the person who arrived on Tuesday with no wage. The
 *                    ordering is by employee NUMBER descending, because numbers are issued in
 *                    order of appearance, so the highest is the most recent arrival and someone
 *                    with no number yet is newer still.
 *
 *   displayName      the roster LEADS with the name people use -- nickname joined to the legal
 *                    surname -- and it is a RENDERING, never a stored value. If this ever leaked
 *                    into a write it would put "Mike" in the column METRC and payroll match on,
 *                    which is the exact corruption employee #22 already arrived with once. The
 *                    header that shows it is deliberately not an input; these tests pin the
 *                    assembly so a future edit cannot quietly turn it back into one.
 *
 *   searchRows       matches nickname, employee number and permit number as well as the obvious
 *                    three. "Who is #22" and "whose permit is OLCC-151903" are both questions the
 *                    roster gets asked, and a search that silently ignores them answers "nobody".
 *
 * Loads the real crew.js by splicing a `return` into its IIFE, so this tests shipped source rather
 * than a copy of it. crew.js has no export seam; if it ever grows one, use that instead.
 */
'use strict';
const fs = require('fs');

let src = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const TAIL = '})();';
const cut = src.lastIndexOf(TAIL);
if (cut < 0) throw new Error('crew.js: IIFE tail not found — has the file been restructured?');
src = src.slice(0, cut) +
      '\n; return { storesInRoster, filterByStore, storePills, scopedRows, searchRows, byName,\n' +
      '           displayName, legalFirst, needsSetup, arrivedRecently, byArrival, isoDaysAgo,\n' +
      '           state, storeName };\n' +
      src.slice(cut);
src = src.replace('(function () {', 'return (function () {');

/* Just enough DOM for the helpers under test. readyState:'loading' keeps boot() from firing — this
   file tests pure filtering, and a boot would want a network and a session. */
function fakeEl() {
  return { _cls: '', _html: '', attrs: {}, children: [],
           style: { setProperty() {} }, classList: { add() {} },
           set className(v) { this._cls = v; }, get className() { return this._cls; },
           set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
           setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
           addEventListener() {}, appendChild(c) { this.children.push(c); } };
}
const document = { readyState: 'loading', currentScript: { src: 'crew.js?v=26' },
                   body: { classList: { add() {}, remove() {} } },
                   getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                   createElement: () => fakeEl(), addEventListener() {} };
const window = { GXClient: () => ({ jsonp: async () => ({}) }),
                 GXStores: { color: (id) => ({ bend: '#22D3EE', center: '#3B82F6' })[id] || '' } };
const sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };

const M = new Function('document', 'window', 'sessionStorage', 'localStorage', 'location', 'navigator', src)
  (document, window, sessionStorage, sessionStorage, { hostname: 'localhost' }, {});

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
  else console.log('  ok  ' + label);
}
const text = (row) => row.children.map(c => c._html.replace(/<[^>]*>/g, '').trim());

M.state.stores = { bend: 'Century', center: 'Center', commercial: 'Commercial',
                   hillsboro: 'Baseline', 'portland-rd': 'Portland Rd', 'river-rd': 'River Rd' };
M.state.storeOrder = { bend: 1, center: 2, commercial: 3, hillsboro: 4, 'portland-rd': 5, 'river-rd': 6 };

const rows = [{ store: 'river-rd' }, { store: 'corporate' }, { store: 'bend' },
              { store: '' }, { store: 'center' }, { store: 'bend' }];

// ── order + membership ──────────────────────────────────────────────────────────────────────────
eq('registry order first, pseudo-stores after, blank last',
   M.storesInRoster(rows), ['bend', 'center', 'river-rd', 'corporate', '']);
eq('a store with nobody in it gets no pill',
   M.storesInRoster([{ store: 'bend' }, { store: 'center' }]), ['bend', 'center']);

// ── filtering ───────────────────────────────────────────────────────────────────────────────────
M.state.rows = rows;
M.state.storeFilter = {};
eq('an empty filter passes everything through', M.filterByStore(rows).length, 6);
M.state.storeFilter = { bend: true };
eq('one store', M.filterByStore(rows).map(r => r.store), ['bend', 'bend']);
M.state.storeFilter = { bend: true, corporate: true };
eq('two stores (multi-select)', M.filterByStore(rows).map(r => r.store), ['corporate', 'bend', 'bend']);
M.state.storeFilter = { '': true };
eq('the blank-store bucket is selectable', M.filterByStore(rows).map(r => r.store), ['']);

// ── the pill row itself ─────────────────────────────────────────────────────────────────────────
/* There is no "All" pill any more. It was the reset for a row with no other way back, and the
   workspace has one — a selected pill toggles itself off — so it became a control whose only job
   was to undo the control beside it. The SET and the COUNTS are unchanged. */
const EXPECTED = ['Century 2', 'Center 1', 'River Rd 1', 'Corporate 1', 'No store 1'];
M.state.storeFilter = {};
const clean = M.storePills(rows);
eq('labels and counts', text(clean), EXPECTED);
eq('no All pill', clean.children.map(c => c.getAttribute('data-store')),
   ['bend', 'center', 'river-rd', 'corporate', '']);
eq('nothing reads pressed when nothing is picked',
   clean.children.map(c => c.getAttribute('aria-pressed')),
   ['false', 'false', 'false', 'false', 'false']);

M.state.storeFilter = { bend: true };
const filtered = M.storePills(rows);
eq('counts are unchanged by an active filter', text(filtered), EXPECTED);
eq('the picked pill reads pressed', filtered.children[0].getAttribute('aria-pressed'), 'true');
eq('an unpicked pill does not', filtered.children[1].getAttribute('aria-pressed'), 'false');

/* Counts come from the argument, the SET from state.rows — so a store the search filtered out
   still gets a pill, dimmed, rather than vanishing mid-keystroke. */
M.state.storeFilter = {};
const searched = M.storePills(rows.filter(r => r.store === 'bend'));
eq('a store with no matches keeps its pill', text(searched),
   ['Century 2', 'Center 0', 'River Rd 0', 'Corporate 0', 'No store 0']);
eq('and dims instead of disappearing',
   searched.children.map(c => c.className.indexOf('is-empty') >= 0),
   [false, true, true, true, true]);

// ── scope: the first of the three filters ───────────────────────────────────────────────────────
const people = [
  { name: 'Ada Fennimore',  store: 'bend',     role: 'Budtender',     employee_number: '11',
    preferred_name: '',     permit_number: 'OLCC-100001', flags: [] },
  { name: 'Iggy Barrera',   store: 'bend',     role: 'Budtender',     employee_number: '25',
    preferred_name: '',     permit_number: '',            flags: ['permit'] },
  { name: 'Marisol Vega',   store: 'center',   role: 'Budtender',     employee_number: '31',
    preferred_name: 'Mari', permit_number: 'OLCC-100003', flags: [] },
  { name: 'Tom Older',      store: 'river-rd', role: 'Store Manager', employee_number: '4',
    preferred_name: '',     permit_number: 'OLCC-100004', flags: ['wage'], retired: true }
];
M.state.rows = people;
M.state.q = '';
M.state.scope = 'active';
eq('active hides retired', M.scopedRows().map(r => r.employee_number), ['11', '25', '31']);
M.state.scope = 'attention';
eq('gaps is active AND flagged — a retired row with a gap is not a gap',
   M.scopedRows().map(r => r.employee_number), ['25']);
M.state.scope = 'retired';
eq('retired is ONLY retired', M.scopedRows().map(r => r.employee_number), ['4']);
M.state.scope = 'active';

// ── search: the fields that are not obvious ─────────────────────────────────────────────────────
const found = (q) => { M.state.q = q; return M.searchRows(people).map(r => r.employee_number); };
eq('name', found('barrera'), ['25']);
eq('nickname', found('mari'), ['31']);
eq('store LABEL, not the slug', found('century'), ['11', '25']);
eq('role', found('store manager'), ['4']);
eq('employee number', found('31'), ['31']);
eq('permit number', found('OLCC-100004'), ['4']);
/* The list prints "Mari Vega"; neither stored field contains that string, so typing what is on
   the screen has to be a hit or the search is lying about the row it is printed on. */
eq('the DISPLAYED name, which is in neither stored field', found('mari vega'), ['31']);
eq('an empty search passes everything through', found(''), ['11', '25', '31', '4']);
M.state.q = '';

// ── who is "new here" ───────────────────────────────────────────────────────────────────────────
const RECENT = M.isoDaysAgo(10), OLD = '2019-03-04';
/* employee_number set + an old hire date = an established person, so only the GAP varies. */
const P = (o) => Object.assign({ name: 'X Y', flags: [], retired: false,
                                 employee_number: '42', hire_date: OLD }, o);
eq('a record with no gaps is not new',    M.needsSetup(P({ flags: [] })), false);
eq('no hire date means unfinished',       M.needsSetup(P({ flags: ['hire_date'], hire_date: '' })), true);
eq('no store, recently arrived',          M.needsSetup(P({ flags: ['store'], hire_date: RECENT })), true);
eq('no role, recently arrived',           M.needsSetup(P({ flags: ['role'], hire_date: RECENT })), true);
eq('no employee number at all',           M.needsSetup(P({ flags: ['employee_number'], employee_number: '' })), true);
eq('no wage, recently arrived',           M.needsSetup(P({ flags: ['wage'], hire_date: RECENT })), true);

/* THE OWNERS. Neither takes an hourly wage, so rowFlags_ raised a permanent `wage` gap on both,
   and the first cut of this rule put the two longest-serving people in the company at the top of
   a list headed "New here". Two independent guards now: a gap is not newness (here), and
   not_on_payroll stops the gap being raised at all (rowFlags_ in Code.gs). Either alone fixes
   the symptom; both are worth keeping, because the flag has to be SET per person and this rule
   holds for anyone nobody has got round to setting it on. */
eq('a seven-year employee with no wage is NOT new',
   M.needsSetup(P({ flags: ['wage'], hire_date: OLD })), false);
eq('nor one missing a store after seven years',
   M.needsSetup(P({ flags: ['store'], hire_date: OLD })), false);

eq('recent means inside 90 days',  M.arrivedRecently(P({ hire_date: M.isoDaysAgo(89) })), true);
eq('and 91 days is not recent',    M.arrivedRecently(P({ hire_date: M.isoDaysAgo(91) })), false);
/* No number yet means they turned up since the last assignment run — newer than anyone holding
   one, however old their hire date happens to be. */
eq('no employee number beats any hire date',
   M.arrivedRecently(P({ hire_date: OLD, employee_number: '' })), true);
/* The whole point of the section is that it is SMALLER than "records with a gap". A long-serving
   employee missing a shirt size or a birthday has an imperfect record, not an unfinished one, and
   putting them here buries the person who actually started this week. */
eq('a missing shirt size does NOT make someone new',
   M.needsSetup(P({ flags: ['shirt_size'], hire_date: RECENT })), false);
eq('nor a missing birthday', M.needsSetup(P({ flags: ['birthday'], hire_date: RECENT })), false);
eq('nor an expired permit',
   M.needsSetup(P({ flags: ['permit', 'permit_expired'], hire_date: RECENT })), false);
eq('a retired record is never new, whatever it is missing',
   M.needsSetup(P({ flags: ['hire_date', 'wage'], hire_date: '', retired: true })), false);

/* Newest first: numbers are issued in order of appearance, so the highest is the most recent —
   and somebody with no number at all turned up since the last assignment run, so they are newer
   than anyone holding one. */
eq('highest employee number first, un-numbered ahead of everyone',
   [P({ name: 'Old Hand', employee_number: '04' }),
    P({ name: 'Just Arrived', employee_number: '' }),
    P({ name: 'Recent', employee_number: '117' })].sort(M.byArrival).map(r => r.name),
   ['Just Arrived', 'Recent', 'Old Hand']);
/* "00" is the owner and sits outside the sequence — it must not read as un-numbered and jump to
   the head of the newest-arrivals list. */
eq('employee 00 is numbered, not blank',
   [P({ name: 'Owner', employee_number: '00' }),
    P({ name: 'Unnumbered', employee_number: '' })].sort(M.byArrival).map(r => r.name),
   ['Unnumbered', 'Owner']);
/* Numeric, not lexical: "9" is a lower number than "117" but sorts after it as a string, which
   would file the newest arrival at the bottom of the list they exist to head. */
eq('compared as numbers, not strings',
   [P({ name: 'Nine', employee_number: '9' }),
    P({ name: 'OneSeventeen', employee_number: '117' })].sort(M.byArrival).map(r => r.name),
   ['OneSeventeen', 'Nine']);

// ── how a person's name is written ──────────────────────────────────────────────────────────────
const N = (name, nick) => ({ name, preferred_name: nick });
eq('no nickname is just the legal name', M.displayName(N('Michael Kettler', '')), 'Michael Kettler');
eq('a nickname replaces the FIRST name', M.displayName(N('Michael Kettler', 'Mike')), 'Mike Kettler');
/* First TOKEN only. Replacing "everything before the last word" would eat a middle name, and
   replacing the last word would rename the family. */
eq('a middle name survives', M.displayName(N('Michael J. Kettler', 'Mike')), 'Mike J. Kettler');
eq('a compound surname survives', M.displayName(N('Mary Van Der Berg', 'Molly')), 'Molly Van Der Berg');
eq('a one-word legal name with a nickname is just the nickname', M.displayName(N('Cher', 'Cheryl')), 'Cheryl');
eq('a blanked record renders empty, so callers can say so themselves', M.displayName(N('', 'Mike')), '');
eq('surrounding whitespace does not become part of the surname',
   M.displayName(N('  Michael   Kettler  ', 'Mike')), 'Mike   Kettler');

eq('the green quote holds the LEGAL first name', M.legalFirst(N('Michael Kettler', 'Mike')), 'Michael');
eq('no nickname, nothing to contrast', M.legalFirst(N('Michael Kettler', '')), '');
/* A nickname identical to the first name would render as a green echo of the word beside it —
   punctuation carrying no fact. */
eq('a nickname that IS the first name is not worth printing',
   M.legalFirst(N('Michael Kettler', 'Michael')), '');
eq('and case alone is not a difference', M.legalFirst(N('Michael Kettler', 'michael')), '');

// ── ordering inside a group ─────────────────────────────────────────────────────────────────────
/* Blanks sink, in every comparison, always. A record with no name is the ABSENCE of a value, not
   the smallest one — and letting it ride the top of the list buries the people you came to find.
   It is also the row that most needs finding: a blank name means a partial write damaged it. */
eq('alphabetical, blanks last',
   [{ name: 'Zoe' }, { name: '' }, { name: 'Ada' }].sort(M.byName).map(r => r.name),
   ['Ada', 'Zoe', '']);
/* Sorted on what the row SHOWS. Rebeka "Bekah" Perez reads "Bekah Perez", so she files under B —
   sorting on the legal name would put her under R, and an alphabetical list you cannot scan
   alphabetically is worse than an unsorted one. */
eq('sorted by the displayed name, not the stored one',
   [N('Rebeka Perez', 'Bekah'), N('Ada Fennimore', ''), N('Michael Kettler', 'Mike')]
     .sort(M.byName).map(M.displayName),
   ['Ada Fennimore', 'Bekah Perez', 'Mike Kettler']);

/* storePills takes the pill SET from state.rows and the COUNTS from its argument — that asymmetry
   is the whole design, so set both. Passing only the argument here would test nothing. */
M.state.storeFilter = {};
M.state.rows = [{ store: 'bend' }, { store: 'bend' }];
eq('a single-store roster gets no pill row at all',
   M.storePills(M.state.rows), null);

console.log(fail ? '\n' + fail + ' FAILED' : '\nroster filter: all passed');
process.exit(fail ? 1 : 0);
