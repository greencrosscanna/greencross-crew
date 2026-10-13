#!/usr/bin/env node
/* Prove tests/request_timing_test.js red, one guard at a time.
 *
 * Mutates a SCRATCH COPY of Code.gs (never the real one — CODE_GS exists for this, and nothing in
 * the repo or the push gate sets it) and reports how many assertions each removal costs. A removal
 * that costs zero is a guard the test is not actually holding.
 *
 *   node scripts/prove-request-timing-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-reqtiming-'));

/* Replace inside ONE named function, so a line that also appears elsewhere is not hit by accident. */
function inFn(s, name, from, to) {
  const i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) return s;
  const j = s.indexOf('\nfunction ', i + 10);
  const body = s.slice(i, j < 0 ? s.length : j);
  const out = typeof from === 'string' ? body.split(from).join(to) : body.replace(from, to);
  return s.slice(0, i) + out + (j < 0 ? '' : s.slice(j));
}

const MUTATIONS = [
  ['route_ never opens the request',
   (s) => inFn(s, 'route_', "  reqBegin_(action);", "  ")],
  ['route_ records on the way out only if nothing threw (no finally)',
   (s) => inFn(s, 'route_', /\} finally \{\s*reqEnd_\(\);[^\n]*\n\s*\}/, '}')],
  ['a handler that throws is not marked as thrown',
   (s) => inFn(s, 'route_', "    reqThrew_();\n", "")],
  ['a refusal is not marked as failed',
   (s) => inFn(s, 'reqReplied_', "_reqT_.failed = !!(obj && obj.ok === false);", "_reqT_.failed = false;")],
  ['reqEnd_ lets a cache failure out into the request',
   (s) => inFn(s, 'reqEnd_', /\} catch \(e\) \{ \/\* telemetry must never break[^\n]*\n/, '} catch (e) { throw e; }\n')],
  ['a cache READ that throws is treated as an empty hour and written over',
   (s) => inFn(s, 'reqEnd_', /var raw = cache\.get\(key\);[^\n]*\n/, 'var raw = null; try { raw = cache.get(key); } catch (e0) {}\n')],
  ['the collector is not cleared when the request ends',
   (s) => inFn(s, 'reqEnd_', "  var t = _reqT_;\n  _reqT_ = null;", "  var t = _reqT_;")],
  ['the action is stored as the caller sent it',
   (s) => inFn(s, 'reqEnd_', /var name = \(t\.known[^\n]*\n/, 'var name = t.action;\n')],
  ['an unmatched action is no longer flagged (only its shape is checked)',
   (s) => inFn(s, 'route_', /        reqUnknown_\(\);[^\n]*\n/, '')],
  ['the request flushes to the sheet itself',
   (s) => inFn(s, 'reqEnd_', "if (body.length < REQT_MAX_BODY) cache.put(key, body, REQT_TTL_S);",
                             "if (body.length < REQT_MAX_BODY) cache.put(key, body, REQT_TTL_S); reqStatsFlush_();")],
  ['the bucket is written however large it is',
   (s) => inFn(s, 'reqEnd_', "if (body.length < REQT_MAX_BODY) cache.put", "cache.put")],
  ['an hour may hold any number of names',
   (s) => inFn(s, 'reqFold_', "    if (Object.keys(b).length >= REQT_MAX_NAMES) return;\n", "")],
  ['a route may hold any number of stages',
   (s) => inFn(s, 'reqFold_', "      if (Object.keys(e.st).length >= REQT_MAX_STAGES) return;\n", "")],
  ['a stage name is stored whatever it looks like',
   (s) => inFn(s, 'reqFold_', "    if (!REQT_STAGE_RE.test(sn)) return;\n", "")],
  ['the read-back needs no secret',
   (s) => inFn(s, 'route_', "        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);\n        return json_(reqStats_(p), p.callback);",
                            "        return json_(reqStats_(p), p.callback);")],
  ['the read-back accepts a signed-in session',
   (s) => inFn(s, 'route_', "        if (!deploySecretOk_(p)) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);\n        return json_(reqStats_(p), p.callback);",
                            "        if (!deploySecretOk_(p) && !requireCrew_(p).ok) return json_({ ok: false, error: 'bad deploy secret' }, p.callback);\n        return json_(reqStats_(p), p.callback);")],
  ['the read-back echoes any name it finds in the tab',
   (s) => inFn(s, 'reqStats_', "    if (!REQT_NAME_RE.test(name)) return;\n", "")],
  ['the read-back echoes any stage name it finds in the tab',
   (s) => inFn(s, 'reqMergeEntry_', "    if (!REQT_STAGE_RE.test(sn)) return;\n", "")],
  ['the read-back counts an hour that is in both the tab and the cache twice',
   (s) => inFn(s, 'reqStats_', "if (hour < cutoff || sheetHours[hour] || cacheHours[hour]) continue;", "if (hour < cutoff) continue;")],
  ['`hours` is not clamped',
   (s) => inFn(s, 'reqStats_', "Math.max(1, Math.min(REQT_MAX_HOURS, Math.floor(Number((p && p.hours) || 24)) || 24))", "(Number((p && p.hours) || 24) || 24)")],
  ['a percentile may exceed the max',
   (s) => inFn(s, 'reqPercentile_', "Math.min(REQT_EDGES[i], e.hi)", "REQT_EDGES[i]")],
  ['the flush writes the hour that is still open',
   (s) => inFn(s, 'reqStatsFlush_', "for (var h = 1; h <= 6; h++) {", "for (var h = 0; h <= 6; h++) {")
            .replace("if (hour === open || seen[hour]) continue;", "if (seen[hour]) continue;")],
  ['the flush trusts the cache marker and never asks the tab',
   (s) => inFn(s, 'reqStatsFlush_', "        if (have[pd.hour]) { out.already.push(pd.hour); return; }\n", "")],
  ['the flush writes any name it finds in the cache',
   (s) => inFn(s, 'reqStatsFlush_', "          if (!REQT_NAME_RE.test(name)) return;\n", "")],
  ['the hour is written without the text format',
   (s) => inFn(s, 'reqStatsFlush_', /        rng\.setNumberFormat\('@'\);[^\n]*\n/, '')],
  ['the tab is never trimmed',
   (s) => inFn(s, 'reqStatsFlush_', "if (n > REQT_KEEP_ROWS) {", "if (false) {")],
  ['a failed flush leaves no record',
   (s) => inFn(s, 'reqStatsFlush_', /  try \{ if \(cache\) cache\.put\(REQT_PREFIX \+ 'lastflush'[^\n]*\n/, '')],
  ['a failed flush throws',
   (s) => inFn(s, 'reqStatsFlush_', "    out.ok = false;\n", "    throw e;\n")
            .replace("  try { reqStatsFlush_(); } catch (e) {}\n", "  reqStatsFlush_();\n")],
  ['with no stored workbook id the stats tab makes a workbook',
   (s) => inFn(s, 'reqStatsSheet_', "  if (!id) return null;", "  if (!id) { SpreadsheetApp.create('GX Crew stats'); return null; }")],
  ['the 15-minute sweep no longer flushes',
   (s) => inFn(s, 'approvalEscalationSweep', "  try { reqStatsFlush_(); } catch (e) {}\n", "")],
  ['the sweep returns the flush result instead of its own',
   (s) => inFn(s, 'approvalEscalationSweep', "  try { reqStatsFlush_(); } catch (e) {}\n", "  out = reqStatsFlush_();\n")],
  ['perfForWrite_ does not mark the GX Core fetch',
   (s) => inFn(s, 'perfForWrite_', /  reqMark_\('perf_fetch'\);[^\n]*\n/, '')],
  ['perfForWrite_ does not mark the stamp',
   (s) => inFn(s, 'perfForWrite_', /  reqMark_\('stamp'\);[^\n]*\n/, '')],
  ['approve does not say whether it is the dry run or the confirm',
   (s) => inFn(s, 'incentiveApprove_', "  reqVariant_(String(p.confirm || '') === 'yes' ? 'confirm' : 'dry');\n", "")],
  ['the LAST variant wins, so a send is recorded as the dry run inside it',
   (s) => inFn(s, 'reqVariant_', "if (_reqT_ && !_reqT_.variant)", "if (_reqT_)")],
  ['send does not say it is a send',
   (s) => inFn(s, 'incentiveSend_', "  reqVariant_(preview ? 'preview' : 'send');\n", "")],
  ['approve does not mark the SPIFF read',
   (s) => inFn(s, 'incentiveApprove_', /  reqMark_\('spiff_read'\);[^\n]*\n/, '')],
  ['approve does not mark the history write',
   (s) => inFn(s, 'incentiveApprove_', "  reqMark_('history_write');\n", "")],
  ['approve does not mark the PDF',
   (s) => inFn(s, 'incentiveApprove_', "  reqMark_('pdf');\n", "")],
  ['approve does not mark the backup',
   (s) => inFn(s, 'incentiveApprove_', "  reqMark_('backup');\n", "")],
  ['approve does not mark the email',
   (s) => inFn(s, 'incentiveApprove_', /  reqMark_\('email'\);[^\n]*\n/, '')],
  ['send does not mark its email',
   (s) => inFn(s, 'incentiveSend_', /  reqMark_\('email'\);[^\n]*\n/, '')],
  ['a stage mark throws inside a request (timing can break approve)',
   (s) => inFn(s, 'reqMark_', "    _reqT_.last = n;\n  } catch (e) {}", "    _reqT_.last = n; throw new Error('mark failed');\n  } catch (e) { throw e; }")],
  ['a stage mark changes what approve returns (timing leaks into the result)',
   (s) => inFn(s, 'incentiveApprove_', "  reqMark_('sheet_reads');", "  reqMark_('sheet_reads'); if (_reqT_) by = by + ' ';")],
  ['a stage mark writes to the sheet (timing changes what approve writes)',
   (s) => inFn(s, 'incentiveApprove_', "  reqMark_('pdf');\n", "  reqMark_('pdf'); if (_reqT_) wfSet_(pp, { note: 'timed' });\n")],
];

let problems = 0;
MUTATIONS.forEach(([label, mutate], i) => {
  const out = mutate(SRC);
  if (out === SRC) {
    console.log('  !! ' + label + ' — the mutation matched nothing; this proof is checking nothing');
    problems++;
    return;
  }
  const file = path.join(dir, 'mutant' + i + '.gs');
  fs.writeFileSync(file, out);
  const r = spawnSync('node', [path.join(ROOT, 'tests', 'request_timing_test.js')],
                      { env: Object.assign({}, process.env, { CODE_GS: file }), encoding: 'utf8' });
  let failed = 0;
  if (r.status !== 0) {
    const m = String(r.stdout || '').match(/\n(\d+) FAILED/);
    failed = m ? Number(m[1]) : -1;
  }
  if (failed > 0) console.log('  ✓ ' + label + ' → ' + failed + ' assertion(s) fail');
  else if (failed < 0) { console.log('  ✗ ' + label + ' → the test died without a count: ' + String(r.stderr || '').split('\n')[0]); problems++; }
  else { console.log('  ✗ ' + label + ' → STILL GREEN. The test is not holding this.'); problems++; }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(problems ? '\n' + problems + ' of ' + MUTATIONS.length + ' mutation(s) not held.\n'
                     : '\nAll ' + MUTATIONS.length + ' guards are individually held by the test.\n');
process.exit(problems ? 1 : 0);
