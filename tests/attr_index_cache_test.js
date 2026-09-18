#!/usr/bin/env node
/* ─── writeAttrs_ stops re-scanning the id column on every save ─────────────────────────────────
 *
 *   RUN:  node tests/attr_index_cache_test.js
 *
 * WHY THIS EXISTS
 * A per-field roster save (saveRosterAttrs_) used to make writeAttrs_ read the WHOLE id column
 * every time, just to find which row to overwrite. readAttrs_ already walks every row of the attrs
 * tab to build the { employee_id -> attrs } map rosterJoin_ needs, so it can hand writeAttrs_ the
 * row number for free instead of making it scan again.
 *
 * THE ONE THING THAT MATTERS HERE: the cached index is NEVER TRUSTED BLINDLY. A wrong or stale
 * entry pointing at the wrong row would silently overwrite somebody else's attributes — a
 * correctness bug worse than the scan it replaces — so every cache hit is verified against the
 * live cell before it is used, and a miss (cold cache, wrong id, wrong row) falls back to exactly
 * the scan writeAttrs_ always did.
 *
 * Loads the real readAttrs_ and writeAttrs_ out of Code.gs against a fake in-memory sheet that
 * counts how many cells it was actually asked to read, so "no full-column scan happened" is a
 * real assertion about the code, not a guess about it.
 */
'use strict';
const fs = require('fs');
const path = __dirname + '/../apps-script/Code.gs';
const gs = fs.readFileSync(path, 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}

/* `var NAME = …;`, so the test's fake cache uses the REAL key string — a rename in Code.gs that
   forgot to update this test would otherwise still pass, silently testing the wrong key. */
function grabVar(name) {
  const i = gs.indexOf('\nvar ' + name + ' =');
  if (i < 0) throw new Error('missing var ' + name);
  const end = gs.indexOf(';', i);
  return gs.slice(i + 1, end + 1);
}

const HEADERS = ['employee_id', 'name_key', 'full_name', 'wage', 'shirt_size'];

/* A fake Sheets sheet, in memory, that counts what it was actually asked to read — the thing a
   real spreadsheet has no way to tell you, and the thing this test exists to pin. */
function makeFakeSheet(initialRows) {
  const data = initialRows.map(r => r.slice());   // [ [employee_id, name_key, full_name, wage, shirt_size], ... ]
  const calls = { idColumnScans: 0, singleCellReads: 0, rowWrites: 0, appends: 0 };

  function range(r, c, numRows, numCols) {
    if (numRows === undefined) {
      // Two-arg getRange(row, col): a single cell.
      return {
        getValue: () => { calls.singleCellReads++; const row = data[r - 2]; return row ? row[c - 1] : ''; },
        setNumberFormat: () => {}
      };
    }
    return {
      getValues: () => {
        if (r === 1) return [HEADERS.slice(c - 1, c - 1 + numCols)];
        if (numCols === 1) calls.idColumnScans++;
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const row = data[r - 2 + i] || [];
          out.push(row.slice(c - 1, c - 1 + numCols));
        }
        return out;
      },
      setValues: (vals) => {
        calls.rowWrites++;
        for (let i = 0; i < vals.length; i++) {
          const idx = r - 2 + i;
          while (data.length <= idx) data.push(HEADERS.map(() => ''));
          for (let ci = 0; ci < vals[i].length; ci++) data[idx][c - 1 + ci] = vals[i][ci];
        }
      },
      setFontWeight: () => range(r, c, numRows, numCols),
      setNumberFormat: () => {}
    };
  }

  return {
    _data: data, _calls: calls,
    getLastRow: () => data.length + 1,
    getLastColumn: () => HEADERS.length,
    getMaxRows: () => data.length + 1,
    getRange: range,
    appendRow: (row) => { calls.appends++; data.push(HEADERS.map((h, i) => row[i] == null ? '' : row[i])); },
    setFrozenRows: () => {}
  };
}

/* A fake CacheService.getScriptCache() — one shared in-memory store per test, exactly like the
   real one's contract (put/get/remove, string values only), so put-then-get across readAttrs_ and
   writeAttrs_ calls behaves the way the real ScriptCache does between two engine executions. */
function makeFakeCache() {
  const store = Object.create(null);
  return {
    get: (k) => (k in store ? store[k] : null),
    put: (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; }
  };
}

function buildEngine(sheet, cache) {
  const src =
    grabVar('ATTR_INDEX_CACHE_KEY') + '\n' +
    grabVar('ROSTER_CACHE_TTL') + '\n' +
    grab('readAttrs_') + '\n' + grab('attrHeaders_') + '\n' + grab('writeAttrs_') + '\n' +
    'return { readAttrs_, writeAttrs_, ATTR_INDEX_CACHE_KEY };';
  const CacheService = { getScriptCache: () => cache };
  const LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
  const fn = new Function('crewSheet_', 'crewSheetPrepare_', 'CacheService', 'LockService', src);
  return fn(() => sheet, () => sheet, CacheService, LockService);
}

// The real key string, pulled from Code.gs once — every test below uses this, never a literal.
const KEY = buildEngine(makeFakeSheet([]), makeFakeCache()).ATTR_INDEX_CACHE_KEY;
ok('ATTR_INDEX_CACHE_KEY is a non-empty string', typeof KEY === 'string' && KEY.length > 0);

// ── 1. A warm, correct cache avoids the full id-column scan entirely ───────────────────────────
(function () {
  const sheet = makeFakeSheet([
    ['1', 'ada_lovelace', 'Ada Lovelace', '', ''],
    ['2', 'bea_nguyen',   'Bea Nguyen',   '', ''],
    ['3', 'cy_ito',       'Cy Ito',       '', '']
  ]);
  const cache = makeFakeCache();
  const E = buildEngine(sheet, cache);

  E.readAttrs_();                          // builds and caches the id -> row index, as rosterJoin_ would
  ok('index cache is populated after a read', cache.get(KEY) !== null);

  sheet._calls.idColumnScans = 0;          // reset the counter — only the WRITE below is under test
  E.writeAttrs_({ employee_id: '2', name_key: 'bea_nguyen', full_name: 'Bea Nguyen', wage: '20.00' });

  ok('no full id-column scan when the cached index is correct', sheet._calls.idColumnScans === 0);
  ok('exactly one verification cell read (the cache hit, checked before trusting it)',
     sheet._calls.singleCellReads === 1);
  ok('the write landed on the RIGHT row (row 3 = Bea, employee_id 2)', sheet._data[1][3] === '20.00');
  ok('the other rows were not touched', sheet._data[0][3] === '' && sheet._data[2][3] === '');
})();

// ── 2. A cold cache falls back to the scan and still writes correctly ──────────────────────────
(function () {
  const sheet = makeFakeSheet([
    ['1', 'ada_lovelace', 'Ada Lovelace', '', ''],
    ['2', 'bea_nguyen',   'Bea Nguyen',   '', '']
  ]);
  const cache = makeFakeCache();           // never warmed — readAttrs_ was never called
  const E = buildEngine(sheet, cache);

  E.writeAttrs_({ employee_id: '2', name_key: 'bea_nguyen', full_name: 'Bea Nguyen', wage: '21.00' });

  ok('cold cache: falls back to the id-column scan', sheet._calls.idColumnScans === 1);
  ok('cold cache: still writes to the right row', sheet._data[1][3] === '21.00');
})();

// ── 3. A WRONG cached index is never trusted — verified, then corrected by falling back ────────
// This is the one that matters: a stale or wrong index pointing at the wrong row must not
// silently overwrite the wrong person's attributes.
(function () {
  const sheet = makeFakeSheet([
    ['1', 'ada_lovelace', 'Ada Lovelace', '', ''],
    ['2', 'bea_nguyen',   'Bea Nguyen',   '', '']
  ]);
  const cache = makeFakeCache();
  // A deliberately WRONG index: claims employee 2 is on row 2 (Ada's row), not row 3.
  cache.put(KEY, JSON.stringify({ '1': 2, '2': 2 }));
  const E = buildEngine(sheet, cache);

  E.writeAttrs_({ employee_id: '2', name_key: 'bea_nguyen', full_name: 'Bea Nguyen', wage: '22.00' });

  ok('a wrong cache entry is caught by the verification read, not trusted',
     sheet._calls.singleCellReads === 1);
  ok('falls back to the real scan when verification fails', sheet._calls.idColumnScans === 1);
  ok('Ada\'s row is untouched', sheet._data[0][3] === '');
  ok('Bea\'s row (the real one) got the write, not Ada\'s', sheet._data[1][3] === '22.00');
})();

// ── 4. A brand-new employee (not yet in the cached index) still appends correctly ──────────────
(function () {
  const sheet = makeFakeSheet([['1', 'ada_lovelace', 'Ada Lovelace', '', '']]);
  const cache = makeFakeCache();
  cache.put(KEY, JSON.stringify({ '1': 2 }));   // index built before employee 9 existed
  const E = buildEngine(sheet, cache);

  E.writeAttrs_({ employee_id: '9', name_key: 'new_hire', full_name: 'New Hire', wage: '18.00' });

  ok('a new employee not in the cached index still gets appended', sheet._calls.appends === 1);
  ok('the existing row was not overwritten', sheet._data[0][2] === 'Ada Lovelace');
  ok('the new row landed with the right data', sheet._data[1][2] === 'New Hire');
})();

console.log(fail ? ('\n' + fail + ' FAILED') : '\nattr index cache: all passed');
process.exit(fail ? 1 : 0);
