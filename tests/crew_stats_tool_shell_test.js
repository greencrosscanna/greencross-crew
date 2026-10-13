#!/usr/bin/env node
/* ─── gxcrewstats.sh, run end to end against a fake curl ──────────────────────────────────────────
 *
 *   RUN:  node tests/crew_stats_tool_shell_test.js
 *
 * tests/crew_stats_tool_test.js reads how the secret is wired and runs the renderer. This file runs
 * the SHELL: a byte-for-byte copy of the shipped script in a scratch folder, with a fixture secret
 * file, a fixture crew.js, and a fake `curl` and `sleep` first on PATH. The fake curl records its
 * arguments and its stdin and answers from a file, so what the script really hands curl — and what
 * it really prints — is observed rather than inferred.
 *
 * Nothing here reaches the network or the real credential: the script changes into its own folder,
 * which is the scratch one, and the only curl it can find is the fake.
 *
 * NOTE FOR A LOCAL RUN. The hub's secret guard refuses any script that names the credential file
 * unless that script is committed and unmodified — correctly. So this file runs in CI and from a
 * clean checkout, and is refused while it has uncommitted edits. Commit, then run.
 *
 * GXCREWSTATS_SH=/path/to/copy points this at another copy of the script.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
process.on('uncaughtException', (e) => {
  console.log('  ✗ the suite crashed: ' + String((e && e.message) || e).slice(0, 200));
  console.log('\n' + (fail + 1) + ' FAILED (of ' + (pass + fail + 1) + ' reached)');
  process.exit(1);
});

const TOOL = process.env.GXCREWSTATS_SH || path.join(__dirname, '..', 'gxcrewstats.sh');
const SECRET = 'fx-secret-9q7z';                 // a fixture, not a credential
const SECRET_FILE = '.gx_deploy_secret';         // the name the tool looks for, in its own folder

const NORMAL = {
  ok: true, hours: 24, from_hour: '2026-10-12 08', to_hour: '2026-10-13 08',
  actions: [
    { name: 'roster', count: 20, failed: 1, avg_ms: 2000, typical_ms: 2000, p90_ms: 5000, max_ms: 6700 },
    { name: 'incentive', count: 6, failed: 0, avg_ms: 8000, typical_ms: 7500, p90_ms: 15000, max_ms: 13466,
      stages: [{ stage: 'perf_fetch', count: 6, avg_ms: 3700, max_ms: 9302, total_ms: 22200 }], unattributed_avg_ms: 300 },
  ],
  sources: { sheet_hours: 5, cache_hours: 2 },
};

function sandbox(replies) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'gxcrewstats-run-'));
  const bin = path.join(box, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(TOOL, path.join(box, 'gxcrewstats.sh'));
  fs.writeFileSync(path.join(box, SECRET_FILE), SECRET + '\n');
  fs.writeFileSync(path.join(box, 'crew.js'),
    "(function () {\n  var ENGINE_URL_FALLBACK = 'https://script.google.com/macros/s/AKfyFIXTUREengine_-09/exec';\n})();\n");
  replies.forEach((r, i) => fs.writeFileSync(path.join(box, 'reply' + (i + 1)), typeof r === 'string' ? r : JSON.stringify(r)));
  /* The fake curl: counts the call, logs its arguments and its stdin, answers with the next reply
     file (the last one again once they run out). */
  fs.writeFileSync(path.join(bin, 'curl'),
    '#!/bin/sh\nB="' + box + '"\nn=0\n[ -f "$B/calls" ] && n=$(cat "$B/calls")\nn=$((n + 1))\necho "$n" > "$B/calls"\n' +
    'printf "%s\\n" "$*" >> "$B/argv"\ncat >> "$B/stdin"\n' +
    'if [ -f "$B/reply$n" ]; then cat "$B/reply$n"; else cat "$B/reply' + replies.length + '"; fi\n');
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\necho "$1" >> "' + box + '/slept"\n');
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  fs.chmodSync(path.join(bin, 'sleep'), 0o755);
  const read = (f) => { try { return fs.readFileSync(path.join(box, f), 'utf8'); } catch (e) { return ''; } };
  return {
    box, read,
    /* Run by ABSOLUTE path from a DIFFERENT working directory, which is how a hub session calls it. */
    run: (args) => {
      const r = spawnSync('bash', [path.join(box, 'gxcrewstats.sh')].concat(args || []),
        { cwd: os.tmpdir(), encoding: 'utf8', env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH }) });
      return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
    },
    done: () => fs.rmSync(box, { recursive: true, force: true }),
  };
}

console.log('\nThe secret: on stdin, never in argv, never on screen');
{
  /* The reply echoes the secret back in the fields the renderer prints free text from. */
  const echo = JSON.parse(JSON.stringify(NORMAL));
  echo.last_flush = { ok: false, at: 'x', error: 'bad call with secret ' + SECRET };
  echo.sheet_error = SECRET;
  const S = sandbox([echo]);
  const r = S.run(['12']);
  ok('it ran, from a different working directory, by absolute path', r.code === 0 && /GX Crew over the last/.test(r.out));
  ok('curl was called once', S.read('calls').trim() === '1');
  ok('the secret is NOT in curl\'s arguments', S.read('argv').indexOf(SECRET) < 0 && /action=request_stats/.test(S.read('argv')));
  ok('the secret IS in the config on curl\'s stdin, beside the engine URL read from crew.js',
     S.read('stdin').indexOf('--data-urlencode secret=' + SECRET) >= 0 &&
     S.read('stdin').indexOf('url = "https://script.google.com/macros/s/AKfyFIXTUREengine_-09/exec"') >= 0);
  ok('curl is told to read that config from stdin', /-K -/.test(S.read('argv')));
  ok('the output never contains the secret, even when the reply echoes it back', r.out.indexOf(SECRET) < 0 && /<secret>/.test(r.out));
  ok('the hours asked for are passed on', /hours=12/.test(S.read('argv')));
  ok('with no --flush, no flush is asked for', !/flush/.test(S.read('argv')));
  S.done();
}

console.log('\nArguments');
{
  const F = sandbox([NORMAL]);
  F.run(['--flush', '6']);
  ok('--flush adds flush=yes, whichever side of the hours it is on', /flush=yes/.test(F.read('argv')) && /hours=6/.test(F.read('argv')));
  F.done();

  const D = sandbox([NORMAL]);
  D.run([]);
  ok('no arguments means 24 hours', /hours=24/.test(D.read('argv')));
  D.done();

  const B = sandbox([NORMAL]);
  const bad = B.run(['24; touch pwned']);
  ok('hours that are not a whole number are refused before anything is called',
     bad.code === 1 && /usage/.test(bad.out) && B.read('calls') === '' && !fs.existsSync(path.join(B.box, 'pwned')));
  const badFlag = B.run(['--write']);
  ok('an unknown flag is refused before anything is called', badFlag.code === 1 && B.read('calls') === '');
  B.done();
}

console.log('\nRetries, refusals and an empty window');
{
  const R = sandbox(['<!DOCTYPE html><html>bounce</html>', '', NORMAL]);
  const r = R.run(['24']);
  ok('a reply that is not JSON is retried until one is', r.code === 0 && R.read('calls').trim() === '3' && /GX Crew over the last/.test(r.out));
  const waits = (R.read('argv').match(/--max-time (\d+)/g) || []).map((m) => Number(m.split(' ')[1]));
  ok('each try waits longer than the last: ' + waits.join(', '), waits.length === 3 && waits[0] >= 30 && waits[0] < waits[1] && waits[1] < waits[2]);
  R.done();

  const N = sandbox(['<html>bounce</html>']);
  const n = N.run(['24']);
  ok('four tries, then it says the engine did not answer and exits 2',
     n.code === 2 && N.read('calls').trim() === '4' && /did not return JSON after 4 tries/.test(n.out));
  ok('…without printing any of the page it got', !/bounce/.test(n.out));
  N.done();

  const X = sandbox([{ ok: false, error: 'bad deploy secret' }]);
  const x = X.run(['24']);
  ok('a refusal from the engine is printed once, exits 1, and is not retried',
     x.code === 1 && /refused: bad deploy secret/.test(x.out) && X.read('calls').trim() === '1');
  X.done();

  const E = sandbox([{ ok: true, hours: 24, actions: [] }]);
  const e = E.run(['24']);
  ok('an empty window prints the no-requests line and exits 0', e.code === 0 && /no requests recorded in the last 24 hour\(s\)/.test(e.out));
  E.done();
}

console.log('\nIt refuses to guess where the engine or the secret is');
{
  const S = sandbox([NORMAL]);
  fs.rmSync(path.join(S.box, SECRET_FILE));
  const a = S.run(['24']);
  ok('no secret file: it stops and says so, and calls nothing', a.code === 1 && /no \.gx_deploy_secret here/.test(a.out) && S.read('calls') === '');
  S.done();

  const U = sandbox([NORMAL]);
  fs.writeFileSync(path.join(U.box, 'crew.js'), "var ENGINE_URL_FALLBACK = 'https://evil.example/collect';\n");
  const u = U.run(['24']);
  ok('an engine URL that is not an Apps Script /exec is not used, and the secret is sent nowhere',
     u.code === 1 && /could not read ENGINE_URL_FALLBACK/.test(u.out) && U.read('calls') === '' && U.read('stdin') === '');
  U.done();
}

console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\ncrew stats tool, shell: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
