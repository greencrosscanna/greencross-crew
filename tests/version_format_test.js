#!/usr/bin/env node
/* ─── The shipped version string ─────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/version_format_test.js    (from the repo root; no deps, no network)
 *
 * WHY THIS EXISTS
 * Crew shipped `crew.js?v=1.300` on 2026-08-23 and deploy.sh dutifully filed it as **v1.300** in
 * version_history — the shared log every app reads for What's New. One stray character, and the
 * entry was already written by the time anyone looked.
 *
 * That is the SAME failure this repo had already reasoned about once: a version that looks
 * plausible, sorts wrong, and sits next to real ones. The argument was made in prose, in a commit
 * message, and in a note to core-admin — and then it happened anyway, because prose does not run.
 * This does.
 *
 * TWO ASSERTIONS, and the second is the one that matters:
 *
 *   1. the cache-buster matches the documented scheme, MAJOR.MINOR with a two-digit minor
 *      ("1.NN" — Sky, 2026-08-23; Inventory and Sales already ship 2.95-style versions).
 *
 *   2. deploy.sh's OWN extraction, run verbatim against the real index.html, returns exactly that
 *      string. Asserting the file's shape alone would not have caught the earlier bug where the
 *      file was right and the extractor disagreed — the two have to be checked TOGETHER, because
 *      what ends up in version_history is whatever the extractor says, not what the file says.
 *
 * If the scheme itself changes, change EXPECTED here and in CLAUDE.md together.
 */
'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = __dirname + '/..';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');

let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); return; }
  fail++; console.log('FAIL ' + label + (detail ? '\n  ' + detail : ''));
}

const m = /([A-Za-z0-9_.-]+\.js)\?v=([0-9.]+)/.exec(html);
ok('index.html carries a ?v= cache-buster on the app JS', !!m,
   'no <script src="*.js?v=..."> found — deploy.sh would refuse to record a release');
if (!m) { console.log('\n1 FAILED'); process.exit(1); }

const version = m[2];
const EXPECTED = /^\d+\.\d{2}$/;
ok('version "' + version + '" matches the documented MAJOR.NN scheme', EXPECTED.test(version),
   'got "' + version + '" — 1.300 is the real bug this test was written for');

/* deploy.sh's extraction, verbatim. Kept as a string rather than reimplemented: a paraphrase would
   drift from the script and start agreeing with itself instead of with what actually ships. */
const EXTRACT =
  "grep -oE '[A-Za-z0-9_.-]+\\.js\\?v=[0-9]+(\\.[0-9]+)?' index.html | sed -E 's/.*\\?v=//' | head -1";
let extracted = '';
try { extracted = execSync(EXTRACT, { cwd: ROOT, shell: '/bin/sh' }).toString().trim(); }
catch (e) { extracted = '(extraction failed: ' + e.message + ')'; }

ok('deploy.sh would record exactly "' + version + '"', extracted === version,
   'the file says "' + version + '" but the extractor returns "' + extracted + '" — ' +
   'version_history gets the extractor\'s answer, not the file\'s');

console.log(fail ? '\n' + fail + ' FAILED' : '\nversion format: all passed');
process.exit(fail ? 1 : 0);
