#!/usr/bin/env node
/* Prove tests/error_scrub_test.js red, one scrub at a time.
 *
 * Mutates a SCRATCH COPY of Code.gs (never the real one — CREW_ENGINE_SRC exists for this and
 * nothing in the repo or the push gate sets it) and reports how many assertions each removal costs.
 * A removal that costs zero is a scrub the test is not actually holding.
 *
 *   node scripts/prove-scrub-red.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-scrub-'));

const MUTATIONS = [
  ['drop the scrubs inside sendMail_',
   (s) => s.replace(/if \(out\.subject != null\)  out\.subject  = scrubSecrets_\(out\.subject\);\n  if \(out\.body != null\)     out\.body     = scrubSecrets_\(out\.body\);\n  if \(out\.htmlBody != null\) out\.htmlBody = scrubSecrets_\(out\.htmlBody\);\n/, '')],

  ['restore a second raw MailApp.sendEmail call site',
   (s) => s.replace('return sendMail_({ to: recipients.join(\',\')', 'return MailApp.sendEmail({ to: recipients.join(\',\')')
            .replace('sendMail_({ to: recipients.join(\',\')', 'MailApp.sendEmail({ to: recipients.join(\',\')')],

  ['drop the scrub from the digest log write',
   (s) => s.replace('setProperty(LAST_DIGEST_PROP, scrubSecrets_(JSON.stringify(res)))',
                    'setProperty(LAST_DIGEST_PROP, JSON.stringify(res))')],

  ['drop the scrub from the backup log write',
   (s) => s.replace('setProperty(BACKUP_LAST_PROP, scrubSecrets_(JSON.stringify(res)))',
                    'setProperty(BACKUP_LAST_PROP, JSON.stringify(res))')],

  ['restore the old anchored regex (the bug the note reported)',
   (s) => s.replace(/var SECRET_PARAM_RE_ = new RegExp\([\s\S]*?'gi'\);/,
                    "var SECRET_PARAM_RE_ = /([?&](?:secret|token|key|pass|password)=)[^&\\s\"'<>\\\\]*/gi;")],
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
  let failed = 0;
  try {
    execFileSync('node', [path.join(ROOT, 'tests', 'error_scrub_test.js')],
                 { env: Object.assign({}, process.env, { CREW_ENGINE_SRC: file }), encoding: 'utf8' });
  } catch (e) {
    const m = String(e.stdout || '').match(/\n(\d+) FAILED/);
    failed = m ? Number(m[1]) : -1;
  }
  if (failed > 0) console.log('  ✓ ' + label + ' → ' + failed + ' assertion(s) fail');
  else { console.log('  ✗ ' + label + ' → STILL GREEN. The test is not holding this.'); problems++; }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(problems ? '\n' + problems + ' mutation(s) not held.\n' : '\nEvery scrub is individually held by the test.\n');
process.exit(problems ? 1 : 0);
