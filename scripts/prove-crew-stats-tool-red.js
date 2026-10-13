#!/usr/bin/env node
/* Prove tests/crew_stats_tool_test.js red, one guard at a time.
 *
 * Mutates a SCRATCH COPY of gxcrewstats.sh (never the real one — GXCREWSTATS_SH exists for this) and
 * reports how many assertions each removal costs. A removal that costs zero is a guard the test is
 * not actually holding. Nothing here runs the tool: the test it drives only parses the script and
 * lifts its python blocks.
 *
 *   node scripts/prove-crew-stats-tool-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'gxcrewstats.sh'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-statstool-'));
const all = (s, from, to) => s.split(from).join(to);

const MUTATIONS = [
  ['the secret goes on curl\'s command line',
   (s) => all(s, '--data-urlencode "action=request_stats"', '--data-urlencode "secret=$SECRET" --data-urlencode "action=request_stats"')],
  ['the config is no longer piped into curl -K -',
   (s) => all(s, '| curl -K - --get', '| curl --get')],
  ['the output is not scrubbed',
   (s) => s.replace("\n' | scrub\n", "\n'\n")],
  ['the scrub replaces nothing',
   (s) => s.replace('.replace(os.environ["GXCREWSTATS_SECRET"], "<secret>")', '')],
  ['a second route is called',
   (s) => s.replace('--data-urlencode "flush=yes"', '--data-urlencode "flush=yes" --data-urlencode "action=backup_now"')],
  ['flush=yes is always sent',
   (s) => s.replace('--data-urlencode "action=request_stats" --data-urlencode "hours=$HOURS" 2>/dev/null)"\n  fi',
                    '--data-urlencode "action=request_stats" --data-urlencode "hours=$HOURS" --data-urlencode "flush=yes" 2>/dev/null)"\n  fi')],
  ['the engine URL is hardcoded here too',
   (s) => s.replace('[ -n "$ENGINE" ] ||', 'ENGINE="https://script.google.com/macros/s/AKfycbxHARDCODED/exec"\n[ -n "$ENGINE" ] ||')],
  ['any URL in crew.js is accepted',
   (s) => s.replace('(https://script\\.google\\.com/macros/s/[A-Za-z0-9_-]+/exec)', '(https?://[^\\x27\\x22]+)')],
  ['one try, no retry',
   (s) => s.replace('for t in 30 45 60 90; do', 'for t in 30; do')],
  ['hours are not checked',
   (s) => s.replace("  ''|*[!0-9]*) echo", "  '') echo")],
  ['it no longer resolves its own directory',
   (s) => s.replace('cd "$(cd "$(dirname "$0")" && pwd)"\n', '')],
  ['an empty window prints nothing',
   (s) => s.replace('    print("GX Crew: no requests recorded in the last %d hour(s)%s." % (hours, window))\n', '    pass\n')],
  ['a refusal is rendered as an empty table',
   (s) => s.replace('if d.get("ok") is not True:', 'if False:')],
  ['a truthy ok is good enough',
   (s) => s.replace('if d.get("ok") is not True:', 'if not d.get("ok"):')],
  ['a refusal reason is printed raw',
   (s) => s.replace('print("x refused by the engine: " + (plain(err, 160) or "no reason given"))', 'print("x refused by the engine: " + str(err))')],
  ['route names are printed unchecked',
   (s) => s.replace('    if not isinstance(name, str) or not NAME.match(name): continue\n', '    if not isinstance(name, str): continue\n')],
  ['stage names are printed unchecked',
   (s) => s.replace('            if not isinstance(sn, str) or not STAGE.match(sn): continue\n', '            if not isinstance(sn, str): continue\n')],
  ['figures are printed as sent',
   (s) => s.replace('    n = num(v)\n    return ("%" + str(width) + "s") % ("-" if n is None else str(n))', '    return ("%" + str(width) + "s") % str(v)')],
  ['the window is printed as sent',
   (s) => s.replace('if isinstance(fr, str) and isinstance(to, str) and HOUR.match(fr) and HOUR.match(to):', 'if isinstance(fr, str) and isinstance(to, str):')],
  ['a flush timestamp is printed as sent',
   (s) => s.replace('at = f.get("at") if isinstance(f.get("at"), str) and STAMP.match(f.get("at")) else "time unknown"', 'at = str(f.get("at"))')],
  ['a flush error is printed raw',
   (s) => s.replace('print("%s: FAILED (%s UTC): %s" % (label, at, plain(f.get("error"), 160) or "no reason given"))', 'print("%s: FAILED (%s UTC): %s" % (label, at, f.get("error")))')],
  ['plain() lets every character through',
   (s) => s.replace('return re.sub(r"[^A-Za-z0-9 .,:;()_/-]", "?", s)[:limit]', 'return s[:limit]')],
  ['plain() does not cut the text short',
   (s) => s.replace('return re.sub(r"[^A-Za-z0-9 .,:;()_/-]", "?", s)[:limit]', 'return re.sub(r"[^A-Za-z0-9 .,:;()_/-]", "?", s)')],
  ['the route\'s notes are echoed',
   (s) => s.replace('print("typical and p90 are bucket edges', 'print(" ".join(str(x) for x in (d.get("notes") or [])))\nprint("typical and p90 are bucket edges')],
  ['routes are sorted by count, not total time',
   (s) => s.replace('rows.sort(key=lambda r: (-r[2], r[0]))', 'rows.sort(key=lambda r: (-r[1], r[0]))')],
  ['stages are printed in the order sent',
   (s) => s.replace('        clean.sort(key=lambda x: (-x[2], x[0]))\n', '')],
  ['only approve gets a stage block',
   (s) => s.replace('STAGED = ["incentive_approve.dry", "incentive_approve.confirm", "incentive_send.send",\n          "incentive_send.preview", "incentive"]', 'STAGED = ["incentive_approve.confirm"]')],
  ['unattributed time is not shown',
   (s) => s.replace('        if un is not None:\n', '        if False:\n')],
  ['the last flush is not reported',
   (s) => s.replace('for label, key in (("Flush just now", "flush_now"), ("Last flush", "last_flush")):', 'for label, key in ():')],
  ['a non-JSON reply is a traceback',
   (s) => s.replace('try:\n    d = json.loads(sys.stdin.read(), strict=False)\nexcept Exception:\n    print("x the reply was not JSON"); raise SystemExit(2)', 'd = json.loads(sys.stdin.read(), strict=False)')],
];

let problems = 0;
MUTATIONS.forEach(([label, mutate], i) => {
  const out = mutate(SRC);
  if (out === SRC) {
    console.log('  !! ' + label + ' — the mutation matched nothing; this proof is checking nothing');
    problems++;
    return;
  }
  const file = path.join(dir, 'mutant' + i + '.sh');
  fs.writeFileSync(file, out);
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'crew_stats_tool_test.js')],
                      { env: Object.assign({}, process.env, { GXCREWSTATS_SH: file }), encoding: 'utf8' });
  let failed = 0;
  if (r.status !== 0) {
    const m = String(r.stdout || '').match(/\n(\d+) FAILED/);
    failed = m ? Number(m[1]) : -1;
  }
  if (failed > 0) console.log('  ✓ ' + label + ' → ' + failed + ' assertion(s) fail');
  else if (failed < 0) { console.log('  ✗ ' + label + ' → the test died without a count'); problems++; }
  else { console.log('  ✗ ' + label + ' → STILL GREEN. The test is not holding this.'); problems++; }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(problems ? '\n' + problems + ' of ' + MUTATIONS.length + ' mutation(s) not held.\n'
                     : '\nAll ' + MUTATIONS.length + ' guards are individually held by the test.\n');
process.exit(problems ? 1 : 0);
