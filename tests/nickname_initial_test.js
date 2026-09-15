#!/usr/bin/env node
/* ─── "Zach B Babcock" reads "Zach Babcock" (2026-09-15) ────────────────────────────────────────
 *
 *   RUN:  node tests/nickname_initial_test.js
 *
 * Sky: "zach r and zach b, since the initial is how we visually separate them, we don't need that
 * shown in their full name." The nickname keeps its initial (the Leaderboard kiosk prints the
 * nickname alone and needs it); Crew drops it only where the surname already carries it. Both copies
 * of the display-name rule — browser and engine — must agree.
 */
'use strict';
const fs = require('fs');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

function extract(src, name) {
  const i = src.indexOf('function ' + name + '(');
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
}
const JS = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const GS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const browser = new Function(extract(JS, 'nickWithoutSurnameInitial') + extract(JS, 'displayName') + '; return displayName;')();
const engine  = new Function(extract(GS, 'nickWithoutSurnameInitial_') + extract(GS, 'displayNameOf_') + '; return displayNameOf_;')();

const cases = [
  [{ name: 'Zachary Babcock',   preferred_name: 'Zach B' },  'Zach Babcock',     'the initial matching the surname is dropped'],
  [{ name: 'Zachary Rodriguez', preferred_name: 'Zach R' },  'Zach Rodriguez',   '…for both Zachs'],
  [{ name: 'Zachary Babcock',   preferred_name: 'Zach B.' }, 'Zach Babcock',     'with a trailing period too'],
  [{ name: 'Zachary Babcock',   preferred_name: 'zach b' },  'zach Babcock',     'case-insensitively'],
  [{ name: 'Michael Kettler',   preferred_name: 'Mike' },    'Mike Kettler',     'an ordinary nickname is untouched'],
  [{ name: 'Thomas Peterson',   preferred_name: 'TJ' },      'TJ Peterson',      'initials AS the nickname are untouched'],
  [{ name: 'Anna Smith',        preferred_name: 'Anna K' },  'Anna K Smith',     'an initial that is NOT the surname is kept — it means something'],
  [{ name: 'Robert Wydick',     preferred_name: 'Nate' },    'Nate Wydick',      'a nickname unlike the legal name is untouched'],
  [{ name: 'Cher',              preferred_name: 'Cher C' },  'Cher C',           'no surname to carry it, so it stays'],
  [{ name: 'Skyler Pinnick',    preferred_name: '' },        'Skyler Pinnick',   'no nickname reads the legal name'],
];
console.log('\nBrowser (crew.js displayName)');
cases.forEach(([row, want, label]) => ok(label + ' — ' + JSON.stringify(browser(row)), browser(row) === want));
console.log('\nEngine (Code.gs displayNameOf_) agrees on every case');
cases.forEach(([row, want, label]) => ok(label, engine(row) === want));
ok('the engine also reads full_name when name is absent', engine({ full_name: 'Zachary Babcock', preferred_name: 'Zach B' }) === 'Zach Babcock');

console.log('\nMatching still finds a source that sends the older "Zach B Babcock"');
ok('stampEmployeeIds_ indexes the nickname as stored, beside the display form',
   /\[e\.full_name, displayNameOf_\(e\), rawDisplay\]/.test(GS) &&
   /rawDisplay = rawNick \? rawNick \+ String\(e\.full_name/.test(GS));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
