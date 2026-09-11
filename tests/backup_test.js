#!/usr/bin/env node
/* ─── Backups of Crew's spreadsheet to the shared drive ────────────────────────────────────────
 *
 *   RUN:  node tests/backup_test.js
 *
 * WHY THIS EXISTS
 * On 2026-09-11 "where is the payroll record backed up?" was answered NOTHING: one spreadsheet in
 * one person's Drive, copied nowhere. This is the copy. Every rule below is one deleted line away
 * from a backup that looks like it works and does not:
 *
 *   1. Rotation trashes WEEKLY copies only, oldest first, beyond the keep count. An approval copy, or
 *      anything else somebody put in the folder, is never a candidate.
 *   2. There is no default folder. A fallback into My Drive would look like a working backup while
 *      protecting against half of what it exists for.
 *   3. It never reaches the sheet through crewSheet_(), which CREATES an empty spreadsheet when it
 *      cannot open the real one — and it never rotates when the source has no pay rows.
 *   4. It never throws, and never fails an approval: it runs after the record is written.
 *   5. A rehearsal is not a record — no copy for a practice period.
 *   6. A broken backup reaches a person: the Monday recap carries it, and only when it is broken.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));
const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const B = new Function(
  "var BACKUP_PREFIX = 'GX Crew backup · ';\n" +
  fnSrc('backupPrunePlan_') + '\n; return { plan: backupPrunePlan_ };')();

console.log('\nRotation touches weekly copies only');
{
  const day = 86400000;
  const weekly = Array.from({ length: 15 }, (_, i) => ({
    id: 'w' + i, name: 'GX Crew backup · 2026-0' + (1 + (i % 9)) + '-01 0300 · weekly', created: i * 7 * day }));
  const others = [
    { id: 'a1', name: 'GX Crew backup · 2026-01-01 0900 · approved 2025-12-08', created: 0 },
    { id: 'm1', name: 'GX Crew backup · 2026-01-01 0900 · manual', created: 0 },
    { id: 'x1', name: 'Something Sky saved here · weekly', created: 0 },
    { id: 'x2', name: 'GX Crew backup · weekly notes.txt', created: 0 },
  ];
  const plan = B.plan(weekly.concat(others), 12);
  ok('keeps the newest 12 weekly copies, trashes the 3 oldest',
     plan.length === 3 && ['w0', 'w1', 'w2'].every(id => plan.includes(id)));
  ok('never an approval copy', !plan.includes('a1'));
  ok('never a manual copy', !plan.includes('m1'));
  ok('never a file that merely mentions "weekly"', !plan.includes('x1') && !plan.includes('x2'));
  ok('fewer than the keep count → nothing trashed', B.plan(weekly.slice(0, 5), 12).length === 0);
  ok('ordered by creation, not by name', (() => {
    const shuffled = weekly.slice().reverse();
    return B.plan(shuffled, 12).sort().join() === plan.sort().join();
  })());
}

console.log('\nNo default folder, and never the self-creating sheet helper');
{
  const FOLDER = fnSrc('backupFolderId_');
  ok('no Drive id literal in the folder lookup', !/'[A-Za-z0-9_-]{25,}'/.test(FOLDER));
  ok('no fallback constant like PAYOUT_FOLDER_ID', !/FOLDER_ID\b/.test(FOLDER));
  ok('a failed GX Core read falls back to the REMEMBERED folder', /getProperty\(BACKUP_FOLDER_PROP\)/.test(FOLDER));
  ok('clearing the setting forgets the remembered folder too', /deleteProperty\(BACKUP_FOLDER_PROP\)/.test(FOLDER));

  const COPY = fnSrc('backupCrewSheet_');
  ok('an unset folder refuses and records it', /no backup folder is set/.test(COPY) && /return note\(out\)/.test(COPY));
  ok('reads the sheet by its stored id', /getProperty\(CREW_SHEET_ID_PROP\)/.test(COPY));
  ok('never calls crewSheet_(), which creates an empty sheet on failure', !/crewSheet_\(/.test(COPY));
  ok('rotation is skipped when the source has no pay rows', /prune_skipped/.test(COPY) && /!out\.history_rows/.test(COPY));
  ok('only weekly runs rotate', /kind === 'weekly'/.test(COPY));
  ok('old copies are trashed, never permanently removed',
     /setTrashed\(true\)/.test(COPY) && !/Drive\.Files\.remove|\.remove\(/.test(COPY));
}

console.log('\nIt cannot break an approval');
{
  const COPY = fnSrc('backupCrewSheet_');
  ok('no throw in the backup', !/\bthrow\b/.test(COPY));
  ok('the copy is inside a try', /try \{[\s\S]*makeCopy/.test(COPY));
  ok('every attempt records its outcome', /setProperty\(BACKUP_LAST_PROP/.test(COPY));

  const APPROVE = fnSrc('incentiveApprove_');
  const iPdf = APPROVE.indexOf('filePayoutPdf_(');
  const iBak = APPROVE.indexOf('backupCrewSheet_(');
  ok('the backup runs after the record and the PDF', iPdf > 0 && iBak > iPdf &&
     APPROVE.indexOf("status: 'approved'") < iBak);
  ok('a practice period gets no copy', /isPracticePeriod_\(pp\)\s*\?\s*\{[^}]*skipped/.test(APPROVE));
  ok('the result rides along on the response', /backup: backup/.test(APPROVE));
}

console.log('\nThe schedule, and a broken backup reaches a person');
{
  const INST = fnSrc('installNightlyScanUnsafe_');
  ok('weeklyBackup is installed', /newTrigger\('weeklyBackup'\)/.test(INST));
  ok('…and cleared first, so a re-install leaves one trigger', /'weeklyBackup'\]/.test(INST));
  ok('…whether or not this context can mail', (INST.match(/'weeklyBackup'/g) || []).length >= 3);

  const HEALTH = fnSrc('backupHealth_');
  ok('health fails on: no folder, never run, last failed, late',
     /No backup folder/.test(HEALTH) && /no backup has run yet/.test(HEALTH) &&
     /last backup failed/.test(HEALTH) && /BACKUP_STALE_DAYS/.test(HEALTH));

  const DATA = fnSrc('digestData_');
  const HTML = fnSrc('digestHtml_');
  ok('the recap reads the same health check', /backupHealth_\(\)/.test(DATA));
  ok('the recap shows it only when broken', /d\.backup && !d\.backup\.ok/.test(HTML));
}

console.log('\nNo new permission');
{
  const man = JSON.parse(fs.readFileSync(__dirname + '/../apps-script/appsscript.json', 'utf8'));
  ok('Drive is already in the grant', man.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
  ok('ScriptApp triggers are already in the grant',
     man.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
}

console.log(fail ? `\n${fail} FAILED` : '\nbackups: all passed');
process.exit(fail ? 1 : 0);
