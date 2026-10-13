#!/usr/bin/env node
/* ─── The Targets printed on the 27 payout reports → Crew's goals tab ────────────────────────────
 *
 *   node scripts/printed-goals.js <parsed.json>                  DRY RUN, local: reads, writes nothing
 *   node scripts/printed-goals.js <parsed.json> --post           asks the ENGINE for its own dry run
 *   node scripts/printed-goals.js <parsed.json> --post --confirm WRITES (needs the engine deployed,
 *                                                                and Sky's word in chat first)
 *
 * <parsed.json> is `python3 -I tools/parse_incentive_pdfs.py --dir <folder of the 27> --out <file>`.
 *
 * The local dry run reads each imported period back from the engine (incentive_history — a read-only,
 * deploy-secret route) and runs the engine's OWN printedGoalsPlan_, lifted out of Code.gs, over it:
 * the same two checks (printed sales = stored sales; admin percent = the report's own percent) and the
 * same store_id the import already resolved. Nothing here can write; only --post --confirm does, and
 * only through incentive_goals_printed, which writes the goals tab and nothing else.
 *
 * The secret is read from .gx_deploy_secret, rides in the request only, and is scrubbed from any line
 * this prints.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const POST = args.includes('--post'), CONFIRM = args.includes('--confirm');
if (!file || (CONFIRM && !POST)) {
  console.log('usage: node scripts/printed-goals.js <parsed.json> [--post [--confirm]]'); process.exit(1);
}
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
const periods = (parsed.periods || []).slice().sort((a, b) => a.pp_start < b.pp_start ? -1 : 1);

const crewSrc = fs.readFileSync(path.join(ROOT, 'crew.js'), 'utf8');
const em = /ENGINE_URL_FALLBACK\s*=\s*['"](https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)['"]/.exec(crewSrc);
if (!em) { console.log('✗ could not read ENGINE_URL_FALLBACK from crew.js'); process.exit(1); }
const ENGINE = em[1];
const SECRET = fs.readFileSync(path.join(ROOT, '.gx_deploy_secret'), 'utf8').replace(/[\r\n]/g, '');
if (!SECRET) { console.log('✗ .gx_deploy_secret is empty'); process.exit(1); }
const scrub = s => String(s).split(SECRET).join('<secret>');

/* The engine's own planner, lifted — never a copy. */
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
function fnSrc(name) {
  const i = GS.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = GS.indexOf('{', i); k < GS.length; k++) {
    if (GS[k] === '{') d++; else if (GS[k] === '}') { d--; if (!d) return GS.slice(i + 1, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const plan = new Function(fnSrc('printedGoalsPlan_') + '\nreturn printedGoalsPlan_;')();

async function call(params, body) {
  const u = new URL(ENGINE);
  Object.keys(params).forEach(k => u.searchParams.set(k, params[k]));
  u.searchParams.set('secret', SECRET);
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(u, body ? { method: 'POST', headers: { 'Content-Type': 'text/plain' },
                                         body: JSON.stringify(body), redirect: 'follow' } : { redirect: 'follow' });
      const txt = await r.text();
      if (txt.trim()[0] === '{') return JSON.parse(txt);
    } catch (e) { /* the /exec hop stalls now and then; retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('the engine did not return JSON after 4 tries');
}

const $ = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const trim = per => ({ pp_start: per.pp_start,
  admin: per.admin ? { name: per.admin.name, target: per.admin.target, sales: per.admin.sales,
                       pct_to_goal: per.admin.pct_to_goal } : null,
  managers: (per.managers || []).map(m => ({ name: m.name, store_label: m.store_label, target: m.target, sales: m.sales })) });

(async () => {
  if (POST) {
    const res = await call(CONFIRM ? { action: 'incentive_goals_printed', confirm: 'yes' }
                                   : { action: 'incentive_goals_printed' }, { periods: periods.map(trim) });
    if (!res.ok) { console.log(scrub('✗ refused: ' + res.error)); process.exit(1); }
    res.periods.forEach(p => console.log(scrub(p.pp_start + '  ' + p.status + '  (' + p.keep + ' kept)')));
    console.log('\n' + (res.dry_run ? 'DRY RUN — nothing written.' : 'WRITTEN: ' + res.written + ' period(s).'));
    return;
  }

  let kept = 0, refused = 0, none = 0, ok = 0;
  const bad = [];
  console.log('period      who               store          printed target   printed sales   stored sales    % goal   result');
  for (const per of periods) {
    const h = await call({ action: 'incentive_history', pp_start: per.pp_start });
    if (!h.ok) { bad.push(per.pp_start + ': ' + h.error); console.log(per.pp_start + '  ✗ ' + scrub(h.error)); continue; }
    if (h.format === 'approved') {
      console.log(per.pp_start + '  skipped — approved in Crew, not a report period'); continue;
    }
    const hist = (h.managers || []).map(r => Object.assign({}, r, { section: 'manager' }))
      .concat(h.admin ? [Object.assign({}, h.admin, { section: 'admin' })] : []);
    const p = plan(per, hist);
    p.rows.forEach(r => {
      const verdict = r.status === 'ok' ? 'ok' : r.status === 'none' ? 'no target printed' : 'NOT WRITTEN — ' + r.reason;
      if (r.status === 'ok') ok++; else if (r.status === 'none') none++; else { refused++; bad.push(per.pp_start + ' ' + r.name + ': ' + r.reason); }
      console.log([per.pp_start, (r.section === 'admin' ? 'ADMIN' : r.name).padEnd(17).slice(0, 17),
        (r.section === 'admin' ? 'company' : (r.store_id || r.store_label)).padEnd(13), $(r.printed_target).padStart(15),
        $(r.printed_sales).padStart(15), $(r.stored_sales).padStart(14),
        (r.pct == null ? '—' : r.pct + '%').padStart(8), ' ' + verdict].join('  '));
    });
    kept += p.keep;
  }
  console.log('\n' + periods.length + ' periods · ' + ok + ' rows pass · ' + none + ' have no printed target (dash stays) · ' +
              refused + ' fail a check and are NOT written');
  bad.forEach(b => console.log('  ✗ ' + scrub(b)));
  console.log('NOTHING WRITTEN — this was a read-only dry run.');
})().catch(e => { console.log(scrub('✗ ' + e.message)); process.exit(1); });
