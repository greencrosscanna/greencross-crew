#!/usr/bin/env node
/* ─── Sign-in goes to CREW's engine, not GX Core ───────────────────────────────────────────────
 *
 *   RUN:  node tests/login_transport_test.js
 *
 * WHY THIS EXISTS
 * Crew's sign-in used to call GX Core directly from the browser. It worked — that is the point, and
 * why nothing here is a bug fix. Apps Script serializes execution PER SCRIPT, so a Crew sign-in
 * queued behind whatever GX Core was doing at that moment: the Dutchie pulls, the sales sweeps, the
 * AI digest. GX Core was measured spiking to 42s on 2026-09-03, with one call never answering
 * inside 90s. The library call itself is ~1.3s of work. Calling GXCore.login() from Crew's OWN
 * engine puts the front door in Crew's queue, which has one user on it.
 *
 * WHAT MUST HOLD, and why each would be silent if it broke:
 *
 *   1. The frontend does not reach GX Core to sign in. A reverted call still WORKS — it just goes
 *      back into the shared queue, which nobody notices until the queue is busy and Sky is locked
 *      out of a payroll screen. Only the load pattern changes, so only a test can hold it.
 *   2. Sign-in does not wait on a GX Core config lookup to find its own engine. Routing the front
 *      door through Core to learn where the front door is reintroduces the exact wait, in a place
 *      that reads as unrelated plumbing.
 *   3. The engine route is UNGATED and nowhere near the deploy secret. It answers before anyone is
 *      authenticated — the credentials are the credential. A secret on this route would travel in
 *      the URL of an unauthenticated request, and UrlFetchApp puts whole URLs into its exception
 *      messages: that is how the live secret reached an on-screen banner on 2026-09-02.
 *   4. GXCore.login's payload is returned WHOLE. Keeping only r.user is what once printed the slug
 *      "sky" in the header where the person's name belongs — a cosmetic-looking regression with no
 *      error attached to it.
 *   5. A library that cannot answer is not reported as a bad password. Somebody retyping a correct
 *      password forever is the failure mode, and it looks like user error from every angle.
 *   6. Only the TRANSPORT retries. A parsed {ok:false} is the server's answer; re-sending a wrong
 *      password hammers GX Core's login throttle on behalf of someone who mistyped.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

const APPJS  = fs.readFileSync(__dirname + '/../crew.js', 'utf8');
const ENGINE = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const HTML   = fs.readFileSync(__dirname + '/../index.html', 'utf8');

console.log('\nSign-in transport — the frontend');

// 1. Not GX Core any more, in any spelling.
ok('no GXCore.jsonp("login") anywhere in crew.js',
   !/GXCore\s*\.\s*jsonp\s*\(\s*['"]login['"]/.test(APPJS));
ok('no GX Core client is handed the login action at all',
   !/GXCore[^\n]*['"]login['"]/.test(APPJS));

// The positive half. A test that only forbids the old call passes on a file that signs nobody in.
const loginCall = APPJS.match(/engineNow\(\)\s*\.getJSON\(\s*['"]login['"][\s\S]{0,400}?\)\s*;/);
ok('sign-in calls Crew\'s own engine via engineNow().getJSON("login", …)', !!loginCall);

// 6. Bounded, and retrying the transport only.
ok('the login call is bounded (timeoutMs) and retries the transport (retries)',
   !!loginCall && /timeoutMs\s*:/.test(loginCall[0]) && /retries\s*:/.test(loginCall[0]));
ok('it does not retry a refusal — the {ok:false} branch throws rather than re-sending',
   /if\s*\(!r\s*\|\|\s*!r\.ok\)\s*throw/.test(APPJS));

// 2. engineNow() must not consult GX Core. This is the rule that quietly un-fixes everything.
const en = APPJS.match(/function engineNow\s*\(\)\s*\{[\s\S]*?\n  \}/);
ok('engineNow() exists', !!en);
ok('engineNow() never calls GX Core (no config lookup on the sign-in path)',
   !!en && !/GXCore/.test(en[0]));
ok('engineNow() is synchronous — sign-in never awaits a URL lookup',
   !!en && !/\bawait\b/.test(en[0]) && !/async\s+function engineNow/.test(APPJS));
ok('it falls back to the deployed-URL constant, not to nothing',
   !!en && /ENGINE_URL_FALLBACK/.test(en[0]));

// The dev write-guard blocks any action this app has not declared a read. A blocked login on
// localhost throws inside the submit handler and reads as "Sign-in failed", which is a confusing
// hour for whoever meets it first.
ok('"login" is still a declared dev read, so localhost can sign in',
   /GX_DEV_READS\s*=\s*\[[\s\S]*?['"]login['"]/.test(HTML));

console.log('\nSign-in transport — the engine route');

ok('the engine has a login route', /case\s*'login'\s*:/.test(ENGINE));
ok('it delegates to login_()', /case\s*'login'\s*:\s*[\s\S]{0,80}?login_\(\s*p\s*\)/.test(ENGINE));

const handler = ENGINE.match(/function login_\s*\(p\)\s*\{[\s\S]*?\n\}/);
ok('login_() exists', !!handler);

// 3. Ungated, and the secret is not near it.
ok('login_() does not check the deploy secret',
   !!handler && !/secret/i.test(handler[0]));
ok('login_() makes no outbound UrlFetchApp call (the URL-in-exception leak path)',
   !!handler && !/UrlFetchApp/.test(handler[0]));

// 4. Whole payload.
ok('login_() calls GXCore.login with the app key "crew"',
   !!handler && /GXCore\.login\(\s*user\s*,\s*pass\s*,\s*'crew'\s*\)/.test(handler[0]));
ok('it returns the payload whole — not a rebuilt object that drops displayName/avatarConfig',
   !!handler && /return\s+r\s*;/.test(handler[0]) && !/return\s*\{\s*ok:\s*true\s*,\s*user:/.test(handler[0]));
ok('the frontend still reads displayName and avatarConfig off the response',
   /setSession\(\s*r\.token\s*,\s*r\.displayName\s*\|\|\s*r\.user\s*,\s*r\.avatarConfig\s*\)/.test(APPJS));

// 5. An unavailable library says so.
ok('an unbound GXCore is reported as unavailable, not as bad credentials',
   !!handler && /GXCore is not bound/.test(handler[0]));
ok('a pinned GXCore without login() is reported as unavailable',
   !!handler && /has no login\(\)/.test(handler[0]));
ok('a library call that returns nothing is reported as unavailable',
   !!handler && /returned nothing/.test(handler[0]));

// The password must not come back out, and neither must a URL that could carry the secret.
ok('the error path scrubs secret-shaped query parameters',
   !!handler && /loginScrub_/.test(handler[0]) && /function loginScrub_/.test(ENGINE));
ok('login_() never logs the credentials',
   !!handler && !/Logger\.log/.test(handler[0]));

console.log(fail ? `\n${fail} FAILED\n` : '\nAll login-transport checks passed\n');
process.exit(fail ? 1 : 0);
