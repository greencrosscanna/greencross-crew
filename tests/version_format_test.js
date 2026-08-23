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
 *   1. the cache-buster matches the suite scheme, vMAJOR.BBB — a THREE-digit zero-padded build.
 *
 *   2. deploy.sh's OWN extraction, run verbatim against the real index.html, returns exactly that
 *      string. Asserting the file's shape alone would not have caught the earlier bug where the
 *      file was right and the extractor disagreed — the two have to be checked TOGETHER, because
 *      what ends up in version_history is whatever the extractor says, not what the file says.
 *
 * ── CORRECTED 2026-08-23: this file first pinned a TWO-digit minor ("1.NN") ──────────────────────
 * That was wrong, and `1.300` was not the stray character it was written up as. Sky's spec the same
 * day gave a target for every app — performance v1.568, sales v2.4NN, inventory v3.0NN, pricecards
 * v1.41N, spiff v1.28N, crew v1.28N, core-admin v1.1NN — and every one of those is three digits
 * after the dot. The decisive case is Leaderboard: it ships **v1.585** today and Sky named it as the
 * one app already correct. A two-digit rule fails the only app cited as right, which is how you know
 * the rule was the error and not the app.
 *
 * The evidence originally offered for two digits — "Inventory and Sales already ship 2.95-style
 * versions" — described the DRIFT being fixed, not the target. On 2026-08-23 the suite held v1.583,
 * v3.02, '2.5', v42 and two apps both on v1.28: three different build widths, one app with no MAJOR
 * at all, one missing its `v`. Widths that disagree do not sort ('v1.28' is above 'v1.280' as a
 * string, below it as a number), which is the whole reason the width is fixed.
 *
 * The rule now lives in ONE place — gx_core.gs's gxCheckVersionFormat_, the single writer for
 * app_versions — with a matching client-side gate in the shared deploy.sh. If the scheme changes,
 * change it THERE; this test is a local mirror, not a second source of truth.
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
const EXPECTED = /^\d+\.\d{3}$/;
ok('version "' + version + '" matches the suite scheme MAJOR.BBB', EXPECTED.test(version),
   'got "' + version + '" — the build must be exactly three digits, zero-padded on the RIGHT ' +
   '(1.31 -> 1.310, never 1.031: the build is the fractional half of a counter that has been ' +
   'counting up, so left-padding would move the app backwards past everything it has shipped)');

/* deploy.sh's extraction, READ OUT OF deploy.sh rather than copied here. The previous version pasted
   the pipeline in as a literal while its own comment argued against paraphrasing it — and a copy is
   a paraphrase the moment deploy.sh changes, which it since has (it grew a format gate). Lifting the
   real line means this test cannot quietly start agreeing with itself instead of with what ships. */
const EXTRACT = (function () {
  const sh = fs.readFileSync(ROOT + '/deploy.sh', 'utf8');
  const line = sh.split('\n').find(l => l.trim().startsWith('_ver=') && l.includes('js\\?v='));
  if (!line) throw new Error('could not find the ?v= extraction line in deploy.sh');
  return line.trim().replace(/^_ver="\$\(/, '').replace(/\)"$/, '');
})();
let extracted = '';
try { extracted = execSync(EXTRACT, { cwd: ROOT, shell: '/bin/sh' }).toString().trim(); }
catch (e) { extracted = '(extraction failed: ' + e.message + ')'; }

ok('deploy.sh would record exactly "' + version + '"', extracted === version,
   'the file says "' + version + '" but the extractor returns "' + extracted + '" — ' +
   'version_history gets the extractor\'s answer, not the file\'s');

console.log(fail ? '\n' + fail + ' FAILED' : '\nversion format: all passed');
process.exit(fail ? 1 : 0);
