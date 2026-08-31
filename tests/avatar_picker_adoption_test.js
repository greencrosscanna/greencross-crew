#!/usr/bin/env node
/* ─── Crew mounts gx-theme's avatar picker, and owns no second one — tests ────────────────────────
 *
 *   RUN:  node tests/avatar_picker_adoption_test.js     (from the repo root; no deps, no network)
 *
 * WHY THESE
 * Crew used to carry its own 105-line `avatarPanel`. It was retired on 2026-08-25 in favor of
 * gx-theme's `GXAvatarPicker` — the Leaderboard one, promoted — so that a face is built the same
 * way in both apps. Sky's words: "I like the LB picker better... the current, simplified version
 * in Crew is efficient but not intuitive and just adds noise."
 *
 * The failure this file exists to prevent is a QUIET one: a future session adds "just one more
 * option" locally, or copies the panel back to avoid a Pages round-trip, and Crew starts building
 * avatars its own way again. Nothing errors — the faces still save. That is exactly how there came
 * to be two avatar writers in the first place, and it took a GX Core library cut to undo.
 *
 * These are source assertions, deliberately. The behavior lives in a browser (click the circle ->
 * picker mounts -> save -> reload -> remove), which needs a DOM, a network fetch of gx-theme and a
 * running server — the wrong shape for a push gate that has to run in a second with no deps. What
 * a push gate CAN hold is the contract: which files load, which globals are used, and which local
 * re-implementation must never come back.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

const JS   = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');

/* Both files talk ABOUT the classes they must not use — that is the point of the comments — so a
   raw string search would fail on its own documentation. Crude on purpose: these are two files we
   control, not arbitrary input, and a stripper clever enough to respect string literals would be
   the more likely thing to be wrong. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')     // /* … */  (JS and CSS)
            .replace(/<!--[\s\S]*?-->/g, ' ')      // <!-- … --> (HTML)
            .replace(/^\s*\/\/.*$/gm, ' ');        // whole-line //
}

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('\nThe shared picker is loaded, from gx-theme, by URL\n');

t('the picker is NOT loaded eagerly — it is fetched when someone opens one', () => {
  /* Inverted 2026-08-26. This used to require both tags in index.html, which is what the adoption
     originally did — and it cost EVERY Crew page load two blocking cross-origin requests (~29KB,
     ~185ms warm, over a second on a cold CDN edge) for a builder most sessions never open.
     GXAvatar.loadPicker() (in gx-avatar.js, already loaded here for the roster pucks) injects both
     on first use, so on-demand loading added no request of its own. */
  assert.ok(!/<script src="[^"]*gx-avatar-picker\.js"><\/script>/.test(HTML),
    'gx-avatar-picker.js is back to being loaded on every page');
  assert.ok(!/<link rel="stylesheet" href="[^"]*gx-avatar-picker\.css">/.test(HTML),
    'gx-avatar-picker.css is back to being loaded on every page');
  assert.ok(/GXAvatar\.loadPicker\(\)/.test(JS),
    'nothing fetches the picker — the circle would open an empty box');
  // The CSS must still arrive somehow; loadPicker is the only thing that brings it now.
  assert.ok(/loadPicker/.test(JS) && !/gx-avatar-picker\.css/.test(stripComments(JS)),
    'the css comes from loadPicker, not a hand-rolled injection here');
});

t('gx-avatar.js is still loaded — the picker is useless without it', () => {
  // GXAvatarPicker calls GXAvatar.url() and GXAvatar.hatSvg; it renders a BLANK preview rather
  // than a wrong face when they are absent, which is a silent failure if this tag ever moves.
  assert.ok(/gx-theme\/gx-avatar\.js/.test(HTML));
});

t('no local copy of either file', () => {
  assert.ok(!fs.existsSync(__dirname + '/../gx-avatar-picker.js'),
    'a vendored copy stops tracking gx-theme the day it is committed');
  assert.ok(!fs.existsSync(__dirname + '/../gx-avatar-picker.css'));
});

console.log('\nMounted as a PANEL, with the options the HR screen needs\n');

t('the picker is mounted through GXAvatarPicker.mount, not re-implemented', () => {
  assert.ok(/GXAvatarPicker\.mount\(/.test(JS), 'nothing calls GXAvatarPicker.mount');
  /* The load-failure guard moved from a `window.GXAvatarPicker` truth-test to loadPicker()'s
     rejection handler, which is strictly better: it fires on a failed FETCH rather than only on a
     tag that silently never arrived, and it can say "try again" because a retry now actually
     retries. What must not regress is that SOME failure path shows a human a message. */
  assert.ok(/loadPicker\(\)\.then\([\s\S]{0,400}?function \(\)/.test(JS),
    'loadPicker has no rejection handler — a failed fetch would leave a silent empty box');
  assert.ok(/did not load/.test(JS),
    'no human-readable message on load failure');
});

t('showLeaderboardPreview is explicitly OFF', () => {
  const m = JS.match(/showLeaderboardPreview:\s*(\w+)/);
  assert.ok(m, 'the flag is not stated at all — it defaults off, but this is an HR screen and the ' +
               'next person to read this should not have to know that');
  assert.strictEqual(m[1], 'false',
    'that mock is a sales standings row ("Jordan M. $4,820") inside an employee record');
});

t('.gxava-full is never APPLIED', () => {
  // Named in a comment is fine and in fact desirable — the point is that no element ever wears it.
  // .gxava-full sets min-height:100vh; it assumes the picker owns the viewport, and here the
  // picker is a panel inside one person's record.
  assert.ok(!/gxava-full/.test(stripComments(JS)),   'crew.js applies .gxava-full');
  assert.ok(!/gxava-full/.test(stripComments(HTML)), 'index.html applies .gxava-full');
});

t('a close handler is passed, so the picker renders its Back button', () => {
  assert.ok(/close:\s*function/.test(JS), 'without close: there is no visible way out of the panel');
});

console.log('\nThe seed is a real employee_number, which is the whole reason Crew is the better host\n');

t('seed comes from avatar_seed (the engine\'s employee_number answer), not the name', () => {
  const m = JS.match(/seed:\s*([^,\n]+)/);
  assert.ok(m, 'no seed passed — GXAvatarPicker would fall back to the NAME, which is exactly what ' +
               'pinning to employee_number exists to stop mattering');
  assert.ok(/avatar_seed/.test(m[1]),
    'expected row.avatar_seed (avatarSeedFrom_: attrs employee_number -> Core row -> employee_id), got: ' + m[1]);
  assert.ok(!/\bname\b/.test(m[1]), 'a name-derived seed changes a face on a rename');
});

console.log('\nCrew\'s own picker is retired, and stays retired\n');

t('avatarPanel and its option tables are gone', () => {
  assert.ok(!/function\s+avatarPanel/.test(JS), 'avatarPanel is back — it lost on the merits, twice');
  ['AVATAR_OPTIONS', 'OPTION_ORDER', 'OPTION_LABEL', 'COLOR_KEYS', 'DEFAULT_AVATAR'].forEach(k => {
    assert.ok(!new RegExp('var\\s+' + k + '\\s*=').test(JS),
      k + ' is back — a second table of what an avatar can be means adding an option in one place ' +
      'and half the suite never offering it');
  });
});

t('no local picker CSS left behind in index.html', () => {
  ['crew-avapick', 'crew-avacontrols', 'crew-avaopt', 'crew-avaswatch', 'crew-avaacts',
   'crew-avacol', 'crew-avapreview', 'crew-editnote'].forEach(c => {
    assert.ok(!HTML.includes(c), c + ' still has rules but nothing renders it');
    assert.ok(!JS.includes(c), c + ' is still rendered by crew.js');
  });
});

t('Crew does NOT restyle the shared component from here', () => {
  // The rule that beat six different login screens: a local .gxava-* override wins in Crew and
  // silently diverges from Leaderboard. Crew's own two classes are the mount host and the button
  // wrapping the circle, both of which are genuinely this app's.
  const styleBlock = (HTML.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  const overrides = (styleBlock.match(/^\s*\.gxava-[\w-]+/gm) || []);
  assert.deepStrictEqual(overrides, [],
    'local overrides of gx-theme classes: ' + overrides.join(', ') +
    ' — send core-admin a note instead');
});

console.log('\nThe circle is the control\n');

t('the avatar circle is a real <button> with a title', () => {
  assert.ok(/crew-avabtn/.test(JS) && /crew-avabtn/.test(HTML),
    'the clickable wrapper is missing from crew.js or its stylesheet');
  assert.ok(/puckBtn\.type = 'button'/.test(JS),
    'a <div> with a click handler is not reachable by Tab, and this is now the ONLY way in');
  assert.ok(/puckBtn\.title\s*=/.test(JS),
    'an avatar that does nothing visible on click is worse than no affordance');
  assert.ok(/cursor: pointer/.test(HTML.slice(HTML.indexOf('.crew-avabtn'))),
    '.crew-avabtn needs a pointer cursor');
});

t('the redundant "Avatar" text button is gone', () => {
  assert.ok(!/'Close avatar'/.test(JS) && !/crew-btn', state\.avatarOpen \? 'Close avatar'/.test(JS),
    'two affordances for one action is the noise Sky asked us to remove');
});

t('save goes through postField -> roster_identity, one field, both directions', () => {
  assert.ok(/postField\(row, 'identity', 'avatar_config', payload\)/.test(JS),
    'the write must stay the single-field identity patch — a whole-record post lets gxWrite_ blank ' +
    'dutchie_employee_id and user_id, neither of which this screen shows');
  assert.ok(/cfg \? JSON\.stringify\(cfg\) : ''/.test(JS),
    'cfg === null must post a NAMED empty avatar_config; that is what the engine reads as a clear');
});

console.log(failed ? '\n' + failed + ' failing\n' : '\nAll good.\n');
process.exit(failed ? 1 : 0);
