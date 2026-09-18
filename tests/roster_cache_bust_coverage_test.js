#!/usr/bin/env node
/* ─── Every writer of identity or Crew attributes busts the roster cache ────────────────────────
 *
 *   RUN:  node tests/roster_cache_bust_coverage_test.js
 *
 * WHY THIS EXISTS
 * `ROSTER_CACHE_TTL` went from 120s to 600s on 2026-09-17. The cache was always correct only
 * because every writer called `bustRosterCache_()` — at 120s a missed writer meant a two-minute
 * stale window; at 600s the same miss is a ten-minute one, on a payroll app. Auditing every write
 * path by hand once (which is how the gap in `seedIdentityCommit()` was actually found — it wrote
 * straight to GX Core identity and had never busted the cache, at ANY TTL) is not the same as
 * keeping the invariant. This makes it a standing check: any function that writes identity
 * (`GXCore.gxUpsertEmployee[s]`, `GXCore.setAvatar`) or Crew's own attribute sheet (`writeAttrs_`)
 * must also call `bustRosterCache_()` somewhere in its own body.
 *
 * It reads the REAL source, not a copy of the rule — a future writer that forgets the bust call
 * fails this the same way `seedIdentityCommit()` would have if it had existed when that one shipped.
 *
 * MUTATION-VERIFIED: stripping the bust call from a known writer (a string edit, not the file on
 * disk) must turn this red. Run `node tests/roster_cache_bust_coverage_test.js --prove-red` to see it.
 */
'use strict';
const fs = require('fs');
const path = __dirname + '/../apps-script/Code.gs';
const SRC = fs.readFileSync(path, 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

/* Is the `/` at the end of `tail` a regex literal or a division operator? Division follows an
   identifier, a number, `)` or `]`; a regex follows everything else, INCLUDING a keyword like
   `return` — which this file actually has four of (`return /^[^@\s]+@…$/i.test(e)`), and which a
   naive "last char is alnum → division" rule gets backwards, because `return` also ends in an
   alnum character. */
function isRegexContext(tail) {
  const t = tail.replace(/\s+$/, '');
  if (!t) return true;
  const lastChar = t[t.length - 1];
  if (/[A-Za-z0-9_$)\]]/.test(lastChar)) {
    const wm = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(t);
    return !!(wm && /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|yield|do|else)$/.test(wm[1]));
  }
  return true;
}

/* Scans from a function's opening `{` to its matching `}`, skipping comments, strings AND regex
   literals — a plain brace/quote scanner (like pay_engine_harness.js's varSrc) reads the `"'`\``
   inside `/["'`]/g` (nameToKey_'s own regex, a few hundred lines above the functions this test
   cares about) as the start of a string and runs off the end of the file. A regex's `{`/`}` — this
   file also has `/\s{2,}/`-shaped ones — must never be counted as brace nesting either, so the
   whole literal is skipped in one jump rather than character by character. */
function matchBrace(src, braceStart) {
  let d = 0, tail = '';
  const pushTail = (s) => { tail = (tail + s).slice(-24); };
  for (let k = braceStart; k < src.length; k++) {
    const c = src[k], n = src[k + 1];
    if (c === '/' && n === '*') { const e = src.indexOf('*/', k + 2); k = (e < 0 ? src.length : e + 1); pushTail('*/'); continue; }
    if (c === '/' && n === '/') { const e = src.indexOf('\n', k); k = (e < 0 ? src.length : e); pushTail(' '); continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = k + 1;
      for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === c) break; }
      k = j; pushTail(c); continue;
    }
    if (c === '/' && isRegexContext(tail)) {
      let j = k + 1, inClass = false;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;   // unterminated regex guard
      }
      k = j;
      while (src[k + 1] && /[a-z]/i.test(src[k + 1])) k++;   // flags
      pushTail('/'); continue;
    }
    if (c === '{') { d++; pushTail(c); }
    else if (c === '}') { d--; pushTail(c); if (!d) return k; }
    else pushTail(c);
  }
  throw new Error('unterminated function body starting at ' + braceStart);
}

/* Every top-level `function name_(...) { ... }` in the file. A doc block mentioning
   `GXCore.setAvatar(` in prose (there is one, just above the avatar helpers) is never mistaken for
   a call inside some OTHER function's body — it sits between two functions, outside any brace
   pair, so it is never captured as anybody's body in the first place. */
function extractFunctions(src) {
  const out = [];
  const re = /\nfunction ([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const braceStart = src.indexOf('{', m.index);
    if (braceStart < 0) continue;
    const end = matchBrace(src, braceStart);
    out.push({ name: name, body: src.slice(braceStart, end + 1) });
  }
  return out;
}

const WRITE_PATTERNS = [
  /GXCore\.gxUpsertEmployee\(/, /GXCore\.gxUpsertEmployees\(/, /GXCore\.setAvatar\(/, /writeAttrs_\(/
];

function checkCoverage(src, label) {
  const fns = extractFunctions(src);
  ok(label + ': found the roster-affecting functions this file is known to have',
     fns.some(f => f.name === 'saveRosterAttrs_') && fns.some(f => f.name === 'seedIdentityCommit'));

  const writers = fns.filter(f => WRITE_PATTERNS.some(p => p.test(f.body)));
  ok(label + ': at least a dozen functions write identity or attrs (sanity floor)', writers.length >= 12);

  const missing = writers.filter(f => !/bustRosterCache_\(\)/.test(f.body)).map(f => f.name);
  ok(label + ': every writer of identity/attrs also busts the roster cache' +
     (missing.length ? ' — missing: ' + missing.join(', ') : ''),
     missing.length === 0);

  return missing;
}

if (process.argv.includes('--prove-red')) {
  // A real writer, with its OWN bust call deleted (string surgery, not a file edit) — must fail.
  const mutated = SRC.replace(
    'GXCore.gxUpsertEmployees(b.rows);\n  // This writes the identity registry the roster join reads and had never busted its cache —\n  // invisible at a 120s TTL (a one-time onboarding call), a real staleness window at 600s.\n  // Found 2026-09-17 auditing every writer before raising the TTL.\n  bustRosterCache_();',
    'GXCore.gxUpsertEmployees(b.rows);'
  );
  if (mutated === SRC) { console.log('  ✗ mutation did not apply — string to strip not found'); process.exit(1); }
  const missing = checkCoverage(mutated, 'MUTATED (seedIdentityCommit bust removed)');
  process.exit(missing.indexOf('seedIdentityCommit') >= 0 ? 0 : 1);
}

checkCoverage(SRC, 'live Code.gs');

ok('ROSTER_CACHE_TTL is 600 (raised from 120, 2026-09-17)',
   /var ROSTER_CACHE_TTL = 600;/.test(SRC));

console.log(fail ? ('\n' + fail + ' FAILED') : '\nroster cache bust coverage: all passed');
process.exit(fail ? 1 : 0);
