#!/usr/bin/env node
/* ─── gxcrewstats.sh: it prints timing and nothing else, and the secret never reaches a screen ────
 *
 *   RUN:            node tests/crew_stats_tool_test.js
 *   PROVE IT BITES: node scripts/prove-crew-stats-tool-red.js   (mutates a COPY of the script)
 *
 * The tool reads Crew's request timing with the deploy secret, so two things about it have to be
 * true and stay true: what it prints is durations and counts only, whatever the route sends; and the
 * secret travels on curl's stdin, never in argv, and never appears in the output.
 *
 * THIS FILE NEVER RUNS THE TOOL. It checks that the script parses, reads how the secret is wired,
 * and LIFTS two python blocks out of the SHIPPED script — the renderer and the scrub — to run them
 * against fixtures (the way gx-theme's brain_notes_silence_test lifts its renderer). A copy inlined
 * here would pass forever while the script rotted underneath it. No network, no credential file.
 *
 * The shell around those blocks — arguments, retries, what curl is actually handed — is run end to
 * end by tests/crew_stats_tool_shell_test.js, against a fake curl.
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
const src = fs.readFileSync(TOOL, 'utf8');
const lines = src.split('\n');

/* Fixtures that must never be printed. */
const SECRET = 'fx-secret-9q7z';                 // a fixture, not a credential
const PERSON = 'Zelda Fixtureson';
const MONEY = '4321.09';
const LEAKS = [SECRET, PERSON, 'Zelda', 'Fixtureson', MONEY, '4321', 'gx-dev:'];
const leaksIn = (t) => LEAKS.filter((l) => String(t).indexOf(l) >= 0);

/* ── 1. The script itself ───────────────────────────────────────────────────────────────────── */
console.log('\nThe script itself');
{
  const r = spawnSync('bash', ['-n', TOOL], { encoding: 'utf8' });
  ok('bash -n: the script parses' + (r.status ? ' — ' + String(r.stderr).split('\n')[0] : ''), r.status === 0);
  ok('it resolves its own directory, so it works when called by an absolute path', /^cd "\$\(cd "\$\(dirname "\$0"\)" && pwd\)"$/m.test(src));
  const codeLines = lines.filter((l) => !l.trim().startsWith('#'));
  const code = codeLines.join('\n');
  const actions = code.match(/action=([a-z_]+)/g) || [];
  ok('the only route it names is request_stats', actions.length > 0 && actions.every((m) => m === 'action=request_stats'));
  ok('it carries no engine URL of its own — crew.js already has one',
     !/script\.google\.com\/macros\/s\/AKfy/.test(code) && /ENGINE_URL_FALLBACK/.test(code) && /open\("crew\.js"/.test(code));
  ok('an engine URL is only accepted if it is an Apps Script /exec', /https:\/\/script\\\.google\\\.com\/macros\/s\/\[A-Za-z0-9_-\]\+\/exec/.test(code));

  /* WHERE THE SECRET GOES. Every line that expands it is one of three shapes: the scrub's
     environment, or the printf that writes curl's CONFIG — and that printf must be piped straight
     into `curl -K -`, which reads the config from stdin. Anything else is the secret on a command
     line, where `ps` and a shell trace can see it. */
  const uses = codeLines.map((l, i) => ({ l, i })).filter((x) => /\$\{?SECRET\b/.test(x.l));
  const isScrub = (l) => /^scrub\(\) \{ GXCREWSTATS_SECRET="\$SECRET" python3 -c '$/.test(l);
  const isConfig = (l) => /printf '%s\\n' "url = \\"\$ENGINE\\"" "--data-urlencode secret=\$SECRET" \\$/.test(l);
  const isEmptyCheck = (l) => /^\[ -n "\$SECRET" \] \|\| \{ echo "✗ \$SECRET_FILE is empty"; exit 1; \}$/.test(l);
  ok('the secret is expanded in ' + uses.length + ' places, each one the empty check, the scrub or curl\'s stdin config',
     uses.length >= 3 && uses.every((x) => isScrub(x.l) || isConfig(x.l) || isEmptyCheck(x.l)));
  const configs = uses.filter((x) => isConfig(x.l));
  ok('every config printf is piped straight into `curl -K -`', configs.length >= 1 &&
     configs.every((x) => /^\s*\| curl -K - --get --silent --location --max-time "\$t" \\$/.test(codeLines[x.i + 1])));
  ok('no curl line carries the secret as an argument', !codeLines.some((l) => /curl\b/.test(l) && /SECRET/.test(l)));
  const waits = (code.match(/for t in ([0-9 ]+); do/) || [])[1];
  ok('four tries with growing timeouts (' + waits + ')', !!waits && waits.trim().split(/\s+/).map(Number).every((t, i, a) => t >= 30 && (i === 0 || t > a[i - 1])) && waits.trim().split(/\s+/).length === 4);
  ok('a reply that is not JSON is retried, and reported after the last try',
     /case "\$resp" in \\\{\*\) break ;; esac\n\s*sleep 2/.test(code) && /did not return JSON after 4 tries/.test(code));
  ok('flush=yes is sent only under --flush', (code.match(/flush=yes/g) || []).length === 1 && /if \[ -n "\$FLUSH" \]; then/.test(code) && /--flush\) FLUSH="yes" ;;/.test(code));
  ok('hours must be a whole number before anything is called', /case "\$HOURS" in\n\s*''\|\*\[!0-9\]\*\) echo "usage/.test(code));
}

/* ── 2. The scrub, lifted and run ───────────────────────────────────────────────────────────── */
console.log('\nThe scrub — the last thing every printed line passes through');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gxcrewstats-'));
{
  const s0 = lines.findIndex((l) => /^scrub\(\) \{ GXCREWSTATS_SECRET="\$SECRET" python3 -c '$/.test(l));
  const sEnd = s0 < 0 ? -1 : lines.slice(s0).findIndex((l, i) => i > 0 && l.startsWith("'"));
  ok('the scrub block is present', s0 !== -1 && sEnd > 0);
  const SCRUB = s0 < 0 ? '' : lines.slice(s0 + 1, s0 + sEnd).join('\n');
  const f = path.join(dir, 'scrub.py');
  fs.writeFileSync(f, SCRUB);
  const r = spawnSync('python3', [f], { input: 'a ' + SECRET + ' b\nurl?secret=' + SECRET + '&x=1\n', encoding: 'utf8',
                                        env: Object.assign({}, process.env, { GXCREWSTATS_SECRET: SECRET }) });
  ok('it replaces every occurrence of the secret', r.status === 0 && r.stdout === 'a <secret> b\nurl?secret=<secret>&x=1\n');
}

/* ── 3. The renderer, lifted from the shipped file ──────────────────────────────────────────── */
const startIdx = lines.findIndex((l) => /printf '%s' "\$resp" \| python3 -c '$/.test(l));
ok('the renderer block is still present in gxcrewstats.sh', startIdx !== -1);
if (startIdx === -1) { console.log('\n' + fail + ' FAILED'); process.exit(1); }
const endRel = lines.slice(startIdx).findIndex((l, i) => i > 0 && l.startsWith("'"));
const RENDERER = lines.slice(startIdx + 1, startIdx + endRel).join('\n');
ok('the lifted block is the real renderer', /gxcrewstats renderer/.test(RENDERER) && RENDERER.length > 800);
ok('…and the shipped pipeline sends everything it prints through the scrub', /^' \| scrub$/.test(lines[startIdx + endRel]));

const PY = path.join(dir, 'renderer.py');
fs.writeFileSync(PY, RENDERER);
const render = (payload, raw) => {
  const r = spawnSync('python3', [PY], { input: raw ? payload : JSON.stringify(payload), encoding: 'utf8' });
  return { out: r.stdout || '', code: r.status, err: r.stderr || '' };
};

const st = (stage, count, avg, max) => ({ stage, count, avg_ms: avg, max_ms: max, total_ms: count * avg });
const NORMAL = {
  ok: true, hours: 24, from_hour: '2026-10-12 08', to_hour: '2026-10-13 08', timezone: 'America/Los_Angeles',
  actions: [
    { name: 'roster', count: 20, failed: 1, threw: 0, avg_ms: 2000, typical_ms: 2000, p90_ms: 5000, max_ms: 6700 },
    { name: 'incentive_approve.confirm', count: 1, failed: 0, threw: 0, avg_ms: 37500, typical_ms: 37500, p90_ms: 37500, max_ms: 37500,
      stages: [st('perf_fetch', 1, 9000, 9000), st('backup', 1, 14000, 14000), st('spiff_read', 1, 6000, 6000), st('pdf', 1, 4000, 4000)],
      unattributed_avg_ms: 4500 },
    { name: 'incentive', count: 6, failed: 0, threw: 0, avg_ms: 8000, typical_ms: 7500, p90_ms: 15000, max_ms: 13466,
      stages: [st('perf_fetch', 6, 3700, 9302), st('history', 6, 800, 1207)], unattributed_avg_ms: 300 },
    { name: 'health', count: 3, failed: 0, threw: 0, avg_ms: 5, typical_ms: 250, p90_ms: 250, max_ms: 9 },
  ],
  sources: { sheet_hours: 5, cache_hours: 2 },
  last_flush: { ok: true, rows: 7, at: '2026-10-13T15:15:02.120Z', flushed: ['2026-10-13 07'] },
  notes: ['a note the tool does not echo'],
};

console.log('\nA normal reply renders the table and the stages');
{
  const r = render(NORMAL);
  const out = r.out, L = out.split('\n');
  ok('it exits 0 and writes nothing to stderr', r.code === 0 && r.err === '');
  ok('the headline counts the requests and the engine time', /30 requests/.test(out) && /2\.[01] min of engine time/.test(out));
  ok('the window is named, in Pacific', /2026-10-12 08 to 2026-10-13 08 Pacific/.test(out));
  const tableEnd = L.findIndex((l) => /^Where the time went/.test(l));
  const order = L.slice(0, tableEnd).filter((l) => /^  (roster|incentive|incentive_approve\.confirm|health) /.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  ok('routes are sorted by TOTAL time, not by count or by slowest: ' + order.join(' > '),
     order.join(',') === 'incentive,roster,incentive_approve.confirm,health');
  const roster = (L.find((l) => /^  roster /.test(l)) || '').trim().split(/\s+/);
  ok('a row is: route, count, failed, typical, p90, max, total minutes', roster.join(' ') === 'roster 20 1 2000 5000 6700 0.7');
  const iApprove = L.findIndex((l) => /^  incentive_approve\.confirm  \(1 requests\)/.test(l));
  ok('the approve confirm has a stage block', iApprove > 0);
  const stages = L.slice(iApprove + 2, iApprove + 6).map((l) => l.trim().split(/\s+/)[0]);
  ok('its stages are listed largest first: ' + stages.join(' > '), stages.join(',') === 'backup,perf_fetch,spiff_read,pdf');
  ok('a stage row is: stage, count, avg, max, total seconds', /^    backup\s+1\s+14000\s+14000\s+14\.0$/.test(L[iApprove + 2] || ''));
  ok('time no stage claimed is shown', /\(no stage claimed it\)\s+4500/.test(out));
  ok('the incentive screen has a stage block too', /^  incentive  \(6 requests\)/m.test(out) && /perf_fetch\s+6\s+3700\s+9302/.test(out));
  ok('a route with no stages gets no block', !/^  roster  \(/m.test(out) && !/^  health  \(/m.test(out));
  ok('where the hours came from, and the last flush, are stated',
     /5 hour\(s\) in the tab, 2 hour\(s\) still only in the cache/.test(out) && /Last flush: ok, 7 row\(s\) written \(2026-10-13T15:15:02\.120Z UTC\)/.test(out));
  ok('the route\'s own notes are not echoed', !/a note the tool does not echo/.test(out));

  /* The four approve/send variants each get a block when they carry stages. */
  const four = { ok: true, hours: 24, actions: ['incentive_approve.dry', 'incentive_approve.confirm', 'incentive_send.send', 'incentive_send.preview']
    .map((name, i) => ({ name, count: 1, failed: 0, avg_ms: 1000 * (i + 1), typical_ms: 1000, p90_ms: 1000, max_ms: 1000, stages: [st('precheck', 1, 100, 100)] })) };
  const f = render(four).out;
  ok('each of the four approve/send variants gets its own stage block',
     ['incentive_approve.dry', 'incentive_approve.confirm', 'incentive_send.send', 'incentive_send.preview'].every((n) => f.indexOf('  ' + n + '  (1 requests)') >= 0));
}

console.log('\nAn empty window says so, in words');
{
  const r = render({ ok: true, hours: 6, actions: [], sources: { sheet_hours: 0, cache_hours: 0 }, last_flush: null });
  ok('it prints a clear line rather than nothing or an empty table', /no requests recorded in the last 6 hour\(s\)/.test(r.out) && r.code === 0);
  ok('…and no table under it', !/typical|p90 ms/.test(r.out.split('\n').slice(0, 4).join('\n')));
  const z = render({ ok: true, hours: 6, actions: [{ name: 'roster', count: 0, avg_ms: 0 }] });
  ok('a reply whose routes all have zero requests is the same empty window', /no requests recorded/.test(z.out));
  const m = render({ ok: true });
  ok('a reply with no actions field at all still says so', /no requests recorded in the last 0 hour\(s\)/.test(m.out) && m.code === 0);
}

console.log('\nA refusal is printed as a refusal');
{
  const r = render({ ok: false, error: 'bad deploy secret' });
  ok('a bad secret is named, and the exit code is 1', /refused: bad deploy secret/.test(r.out) && r.code === 1);
  ok('…and no table is drawn', !/typical|requests,/.test(r.out));
  const e = render({ ok: false, error: 'Service Spreadsheets failed while accessing document' });
  ok('any other refusal prints its reason', /refused by the engine: Service Spreadsheets failed while accessing document/.test(e.out) && e.code === 1);
  const n = render({ ok: false });
  ok('a refusal with no reason still says it was refused', /refused by the engine: no reason given/.test(n.out) && n.code === 1);
  const t = render({ ok: 'yes', actions: NORMAL.actions });
  ok('anything but ok:true is a refusal — a truthy string is not an answer', /refused/.test(t.out) && t.code === 1 && !/roster/.test(t.out));
  const j = render('<!DOCTYPE html><html>Google Drive</html>', true);
  ok('a reply that is not JSON is reported, not a traceback', /was not JSON/.test(j.out) && j.code === 2 && !/Traceback/.test(j.err));
  const a = render('[1, 2, 3]', true);
  ok('a reply that is JSON but not an object is reported too', /not a JSON object/.test(a.out) && a.code === 2 && !/Traceback/.test(a.err));
}

console.log('\nIt prints durations and counts only — whatever the route sends');
{
  /* A reply from an engine that has started sending things it never should: a person in a route
     name, in a stage name, a figure where a duration goes, extra fields, a session in an error. */
  const HOSTILE = {
    ok: true, hours: 24, from_hour: PERSON, to_hour: '2026-10-13 08',
    actions: [
      { name: 'roster', count: 4, failed: PERSON, threw: 0, avg_ms: 1000, typical_ms: MONEY, p90_ms: [PERSON], max_ms: { v: MONEY },
        user: PERSON, payroll_total: 4321.09, token: 'gx-dev:abc' },
      { name: PERSON, count: 9, avg_ms: 9000, max_ms: 9000 },
      { name: 'Roster for ' + PERSON, count: 9, avg_ms: 9000 },
      { name: 'incentive', count: 2, failed: 0, avg_ms: 5000, typical_ms: 5000, p90_ms: 5000, max_ms: 5000,
        stages: [st('perf_fetch', 2, 3000, 3000), { stage: PERSON, count: 2, avg_ms: 100, max_ms: 100, total_ms: 200 },
                 { stage: 'spiff_read', count: PERSON, avg_ms: MONEY, max_ms: null, total_ms: 10, name: PERSON }],
        unattributed_avg_ms: PERSON, people: [PERSON] },
      PERSON, null, 7,
    ],
    sources: { sheet_hours: PERSON, cache_hours: 1 },
    last_flush: { ok: false, at: PERSON, error: 'failed for ' + PERSON + ' <b>$' + MONEY + '</b> ?token=gx-dev:abc' },
    sheet_error: 'could not read "' + PERSON + '"',
    notes: [PERSON], rows: [{ name: PERSON, wage: MONEY }], user: PERSON,
  };
  const r = render(HOSTILE);
  ok('it still renders the rows that are well-formed', r.code === 0 && /^  roster\s+4\s/m.test(r.out) && /^  incentive\s+2\s/m.test(r.out));
  ok('a route name that is not a route name is dropped, with its row', !/9000/.test(r.out));
  ok('a figure that is not a number prints as a dash', /^  roster\s+4\s+-\s+-\s+-\s+-\s+0\.1$/m.test(r.out));
  ok('a stage name that is not a stage name is dropped; a real one stays', /perf_fetch\s+2\s+3000\s+3000/.test(r.out) && /spiff_read\s+-\s+-\s+-/.test(r.out));
  /* The one place free text is let through is an error, and it is filtered to plain characters and
     cut short — so this checks the planted values are gone from everywhere ELSE, and that the error
     lines lost their markup, quotes and parameters. */
  const isErr = (l) => /^Last flush: FAILED|^! sheet error/.test(l);
  const body = r.out.split('\n').filter((l) => !isErr(l)).join('\n');
  ok('outside the two error lines, none of the planted values appear' + (leaksIn(body).length ? ' — FOUND ' + leaksIn(body).join(', ') : ''),
     leaksIn(body).length === 0);
  const errLines = r.out.split('\n').filter(isErr);
  ok('both error lines are printed', errLines.length === 2);
  ok('…with no markup, quotes, dollar sign, equals sign or ampersand left in them', errLines.every((l) => !/[<>"$=&]/.test(l)));
  ok('a timestamp that is not a timestamp is not printed', /Last flush: FAILED \(time unknown UTC\)/.test(r.out));
  const long = render({ ok: false, error: 'x'.repeat(5000) });
  ok('a refusal reason is cut short', long.out.length < 260);
  const fl = render({ ok: true, hours: 1, actions: [], flush_now: { ok: true, rows: 3, at: '2026-10-13T15:15:02Z' } });
  ok('a flush asked for just now is reported', /Flush just now: ok, 3 row\(s\) written/.test(fl.out));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? '\n' + fail + ' FAILED (of ' + (pass + fail) + ')' : '\ncrew stats tool: all ' + pass + ' passed');
process.exit(fail ? 1 : 0);
