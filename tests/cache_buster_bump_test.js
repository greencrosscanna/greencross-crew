#!/usr/bin/env node
/* ─── A CHANGE TO crew.js THAT LEAVES ?v= ALONE IS A SHIP THAT DOES NOT SHIP ───────────────────
 *
 *   RUN:  node tests/cache_buster_bump_test.js
 *
 * WHY THIS EXISTS. On 2026-10-03 the saved-copy open (#10) was written, reviewed, tested in a
 * browser, merged and deployed — and would have reached NOBODY. index.html loads
 * `crew.js?v=1.410`, the PR never touched that line, and every browser would have gone on serving
 * the cached 1.410 file. The merge was real, the code was live in the repo, and the one character
 * that makes a browser go and fetch it was missing. Caught by hand at deploy time, which is not a
 * control.
 *
 * It is a perfect silent failure: nothing errors, the deploy records a new version, git shows the
 * change, the site serves the old code. The only symptom is "the thing you just shipped isn't
 * there", which reads as a bug in the feature rather than as a bug in the shipping.
 *
 * HOW IT CHECKS, without a manifest anybody has to maintain: ask GIT. The `?v=` in index.html was
 * introduced by some commit. If crew.js as it stands differs from crew.js AT THAT COMMIT, then the
 * file has moved since the version did, and the version owes a bump.
 *
 * That is self-maintaining in both directions — bumping `?v=` re-bases the comparison on its own
 * commit, and no hash, lockfile or generated list has to be kept in step.
 *
 * SKIPS, LOUDLY, outside a git checkout or when the version's commit cannot be found (a fresh
 * clone with a shallow history, a tarball). A check that cannot run must say so rather than pass —
 * this repo has three recorded instances of a guard that was incapable of failing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));
const skip = (label, why) => console.log('  ○ SKIP ' + label + ' — ' + why);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log('\ncrew.js and its cache-buster move together');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = /<script[^>]+src="crew\.js\?v=([0-9.]+)"/.exec(html);
ok('index.html loads crew.js with a ?v= cache-buster', !!m);
if (!m) { process.exit(1); }
const version = m[1];
console.log('    current: crew.js?v=' + version);

let inGit = true;
try { git(['rev-parse', '--is-inside-work-tree']); } catch (e) { inGit = false; }

if (!inGit) {
  skip('crew.js has not changed since the version did', 'not a git checkout');
} else {
  /* The commit that INTRODUCED this exact ?v= string. -S finds commits where the number of
     occurrences changed, so the last one is where it appeared. */
  let commit = '';
  try {
    const log = git(['log', '--format=%H', '-S', 'crew.js?v=' + version, '--', 'index.html']);
    commit = log.trim().split('\n').filter(Boolean)[0] || '';
  } catch (e) { commit = ''; }

  if (!commit) {
    skip('crew.js has not changed since the version did',
      'no commit introduces ?v=' + version + ' (shallow clone, or the bump is uncommitted)');
  } else {
    let thenJs = null;
    try { thenJs = git(['show', commit + ':crew.js']); } catch (e) { thenJs = null; }

    if (thenJs === null) {
      skip('crew.js has not changed since the version did', 'crew.js is absent at ' + commit.slice(0, 8));
    } else {
      const nowJs = fs.readFileSync(path.join(ROOT, 'crew.js'), 'utf8');
      ok('crew.js is unchanged since ?v=' + version + ' was set (' + commit.slice(0, 8) + ')' +
         (thenJs === nowJs ? '' : ' — BUMP ?v= in index.html, or this ships to nobody'),
         thenJs === nowJs);
    }
  }
}

/* The guard above compares against whatever version is in the file, so a bump to a LOWER number
   would satisfy it while leaving caches holding the newer one. Versions only go up. */
if (inGit) {
  let prev = '';
  try {
    const hist = git(['log', '--format=%H', '-5', '--', 'index.html']).trim().split('\n').filter(Boolean);
    for (const c of hist.slice(1)) {
      const old = git(['show', c + ':index.html']);
      const pm = /<script[^>]+src="crew\.js\?v=([0-9.]+)"/.exec(old);
      if (pm && pm[1] !== version) { prev = pm[1]; break; }
    }
  } catch (e) { prev = ''; }
  if (!prev) skip('the version only ever goes up', 'no earlier different version in recent history');
  else ok('the version only ever goes up (' + prev + ' → ' + version + ')',
          parseFloat(version) > parseFloat(prev));
}

console.log(fail ? `\ncache-buster bump: ${fail} FAILED` : '\ncache-buster bump: all passed');
process.exit(fail ? 1 : 0);
