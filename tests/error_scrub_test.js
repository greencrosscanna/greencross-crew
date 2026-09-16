#!/usr/bin/env node
/* ─── No reply, and no email, may carry a live credential ──────────────────────────────────────
 *
 *   RUN:  node tests/error_scrub_test.js
 *
 * WHAT LEAKED, AND WHY IT IS WORTH A TEST
 * Apps Script puts the WHOLE URL into an exception message. A handler that throws a UrlFetchApp
 * failure produces "Address unavailable: https://…/exec?action=x&session=<live token>", query
 * string included, and Crew hands that string back as `error` — onto a screen, and in one case into
 * an email. The token in it is a live session: enough to act as that person until it expires. Crew
 * is the HR system of record and it runs payroll, so that person is very likely an admin.
 *
 * Measured across the suite on 2026-09-16, against real URLs: three of the four scrubs that had
 * shipped leaked `session=` and two also leaked `auth=`. Crew leaked both. Every one of them failed
 * the same way — the names the app ACCEPTS as a credential and the names its scrub REDACTS were two
 * hand-maintained lists, and two lists drift.
 *
 * So the fix was structural, and this test pins the structure rather than the words: AUTH_PARAM_NAMES_
 * is the one list, requireCrew_ reads the presented credential from it, and SECRET_PARAM_RE_ is BUILT
 * from it.
 *
 * TWO THINGS THIS TEST DELIBERATELY DOES NOT DO, because both produced a green test that was
 * checking nothing on the night the leak was found:
 *
 *   1. IT DOES NOT TAKE ITS LIST OF NAMES FROM THE IMPLEMENTATION. FLOOR below is hardcoded and the
 *      code under test cannot reach it. A test that iterates the source's own array passes 23 of 23
 *      by silently checking one name fewer the moment somebody deletes a name — which is the exact
 *      bug being fixed. GX Core's first version did that, and Price Cards' first version did it too.
 *      A REMOVAL has to turn this file red, not shrink it.
 *   2. IT DOES NOT GREP FOR THE FIX. The real helpers are lifted out of Code.gs and EXECUTED against
 *      a real "Address unavailable" URL. SPIFF's first version went green because its assertion
 *      matched a scrub that lived in a different function from the one that builds the reply.
 *
 * The planted credential is assembled at runtime and never assigned to a variable named
 * secret/token/key/password — a credential-shaped literal in a fixture is what the push gate's
 * credential scanner exists to stop, and it is right to stop it.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

/* Overridable ONLY so the fix can be proved red on a scratch copy (mutate a temp file, point this
   at it, watch it fail). Nothing in the repo or the push gate sets it. */
const SRC_PATH = process.env.CREW_ENGINE_SRC || (__dirname + '/../apps-script/Code.gs');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/* Source with the prose removed. The shape assertions below ask what the CODE does, and this file's
   own subject matter means the doc comments quote the old regex and the old `p.token` reads
   verbatim — a grep over the raw text would fail on the explanation of the fix. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

/* ── THE FLOOR ────────────────────────────────────────────────────────────────────────────────
 * Hardcoded on purpose. AUTH are the three names GX Core's requireAuth accepts (GX_AUTH_PARAMS_ in
 * gx_core.gs) — Crew's gate delegates to it, so a name Core accepts and Crew does not redact is a
 * leak by definition. SECRET are the non-session credential names. PREFIXED are the underscore
 * forms the old anchored regex walked straight past. */
const FLOOR_AUTH   = ['token', 'session', 'auth'];
const FLOOR_SECRET = ['secret', 'key', 'pass', 'password'];
const FLOOR_PREFIX = ['connector_secret', 'deploy_secret', 'approve_token', 'api_key'];

// A credential-shaped value, built at runtime so no literal of this shape sits in the repo.
const planted = 'ab' + Buffer.from('gx' + Date.now() + 'crew').toString('hex') + 'ZQ';
const leakUrl = (name) =>
  'Address unavailable: https://script.google.com/macros/s/AKfy_example/exec' +
  '?action=roster&' + name + '=' + planted + '&pp_start=2026-08-17';

/* ── Lift the real code out, brace-matched, and run it ───────────────────────────────────────── */
function block(kind, name) {
  const re = kind === 'fn'
    ? new RegExp('^function\\s+' + name + '\\s*\\(', 'm')
    : new RegExp('^var\\s+' + name + '\\s*=', 'm');
  const m = SRC.match(re);
  if (!m) return null;
  const start = m.index;
  if (kind === 'var') {
    // Runs to the first semicolon at depth 0 (the declarations are single statements).
    let depth = 0;
    for (let i = start; i < SRC.length; i++) {
      const c = SRC[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) return SRC.slice(start, i + 1);
    }
    return null;
  }
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  return null;
}

const WANT = [
  ['var', 'AUTH_PARAM_NAMES_'], ['var', 'SECRET_PARAM_NAMES_'], ['var', 'SECRET_PARAM_RE_'],
  ['fn', 'authParamValue_'], ['fn', 'scrubSecrets_'], ['fn', 'loginScrub_'],
  ['fn', 'json_'], ['fn', 'requireCrew_'], ['fn', 'bugNotify_']
];
const missing = WANT.filter(([k, n]) => !block(k, n)).map(([, n]) => n);
ok('every helper this test executes was found in Code.gs' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''),
   missing.length === 0);
if (missing.length) { console.log('\n' + missing.length + ' helper(s) missing — cannot execute.'); process.exit(1); }

// Stubs: the Apps Script services the lifted code touches, and nothing else.
const mailed = [];
const sandbox = {
  ACCOUNT_DOMAIN: 'greencrosscanna.com',
  STORE_TZ: 'America/Los_Angeles',
  ContentService: {
    MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
    createTextOutput: (t) => ({ body: t, setMimeType() { return this; } })
  },
  MailApp: { sendEmail: (o) => mailed.push(o) },
  Utilities: { formatDate: () => '9/16/26 8:00 PM' },
  GXCore: { requireAuth: (params, app) => ({ ok: true, seen: params, app: app, role: 'admin' }) },
  Object: Object, String: String, RegExp: RegExp, JSON: JSON, Buffer: Buffer
};
vm.createContext(sandbox);
vm.runInContext(WANT.map(([k, n]) => block(k, n)).join('\n'), sandbox);

/* ── 1. The scrub, executed against a real exception message ─────────────────────────────────── */
console.log('\nThe scrub — run against a real "Address unavailable" URL');

FLOOR_AUTH.concat(FLOOR_SECRET).forEach((name) => {
  const out = sandbox.scrubSecrets_(leakUrl(name));
  ok('?' + name + '= is redacted', out.indexOf(planted) < 0 && /\[redacted\]/.test(out));
});

FLOOR_PREFIX.forEach((name) => {
  const out = sandbox.scrubSecrets_(leakUrl(name));
  ok('?' + name + '= is redacted too — the regex is not anchored on the bare name',
     out.indexOf(planted) < 0);
});

// The same message through the sign-in path's alias, which is where this first leaked in 2026-09.
FLOOR_AUTH.forEach((name) => {
  ok('loginScrub_ redacts ?' + name + '= as well (same function, one behavior)',
     sandbox.loginScrub_(leakUrl(name)).indexOf(planted) < 0);
});

// A redaction must eat one value, not the rest of the message.
const kept = sandbox.scrubSecrets_(leakUrl('session'));
ok('the redaction stops at & — pp_start survives, so the error is still diagnosable',
   /pp_start=2026-08-17/.test(kept));
ok('a message with no credential in it is returned unchanged',
   sandbox.scrubSecrets_('Address unavailable: https://example.com/exec?action=roster')
     === 'Address unavailable: https://example.com/exec?action=roster');
ok('null and undefined scrub to an empty string rather than "null"',
   sandbox.scrubSecrets_(null) === '' && sandbox.scrubSecrets_(undefined) === '');
ok('an Authorization header value is redacted',
   sandbox.scrubSecrets_('failed: Bearer ' + planted).indexOf(planted) < 0);

/* ── 2. The choke point: every reply, not one catch ──────────────────────────────────────────── */
console.log('\nThe reply builder — json_ is Crew\'s only exit');

ok('json_ is the only ContentService call in the engine, so scrubbing there covers every reply',
   (SRC.match(/ContentService\.createTextOutput/g) || []).length === 2 &&
   /function json_[\s\S]{0,900}ContentService\.createTextOutput/.test(SRC));

FLOOR_AUTH.forEach((name) => {
  const out = sandbox.json_({ ok: false, error: leakUrl(name) });
  ok('a reply carrying ?' + name + '= comes out redacted', out.body.indexOf(planted) < 0);
});

const jsonp = sandbox.json_({ ok: false, error: leakUrl('session') }, 'cb7');
ok('the JSONP wrapper is scrubbed too, and still parses',
   jsonp.body.indexOf(planted) < 0 &&
   JSON.parse(jsonp.body.slice('cb7('.length, -1)).ok === false);

// The hazard is not only in the error field, and not only on an ok:false reply — Price Cards' leak
// was a per-store errors map hanging off an otherwise successful response.
const nested = sandbox.json_({ ok: true, rows: [{ name: 'Mike' }],
                               errors: { 'portland-rd': leakUrl('auth') } });
ok('a nested error on an ok:true reply is redacted as well', nested.body.indexOf(planted) < 0);
ok('a scrubbed reply is still valid JSON', (() => { try { JSON.parse(nested.body); return true; }
                                                    catch (e) { return false; } })());
ok('ordinary payload data is untouched', /"name":"Mike"/.test(nested.body));

/* THE OTHER DIRECTION, AND IT IS THE ONE THAT WOULD HURT MOST. Sign-in's reply carries the freshly
   minted session token as a JSON FIELD, and json_ is the builder it comes out of. A scrub that
   matched `token":"` instead of `?token=` would redact the credential the browser needs and lock
   Sky and Mike out of payroll — the regex requires a ? or & in front of the name for exactly this
   reason. */
const loginReply = sandbox.json_({ ok: true, token: planted, expiresAt: '2026-09-17T03:00:00Z',
                                   user: 'sky', role: 'admin', displayName: 'Skyler Pinnick' });
ok('a sign-in reply keeps its token — a JSON field is not a query parameter',
   JSON.parse(loginReply.body).token === planted);
ok('a JSON field literally named session survives too',
   JSON.parse(sandbox.json_({ ok: true, session: planted }).body).session === planted);

/* ── 3. ONE list: the auth read and the regex are the same names ─────────────────────────────── */
console.log('\nOne list — what auth accepts is what the scrub redacts');

FLOOR_AUTH.forEach((name) => {
  const p = {}; p[name] = planted;
  ok('authParamValue_ resolves ?' + name + '=', sandbox.authParamValue_(p) === planted);
  const seen = sandbox.requireCrew_(p).seen;
  ok('requireCrew_ presents ?' + name + '= to GX Core as a credential', seen && seen.token === planted);
});
ok('authParamValue_ answers empty when nothing is presented',
   sandbox.authParamValue_({ action: 'roster' }) === '' && sandbox.authParamValue_(null) === '');
ok('requireCrew_ forwards the rest of the request untouched',
   sandbox.requireCrew_({ session: planted, pp_start: '2026-08-17' }).seen.pp_start === '2026-08-17');

// The structural half: the regex must be BUILT from the auth list, not re-typed beside it.
ok('SECRET_PARAM_RE_ is constructed from SECRET_PARAM_NAMES_, which concats AUTH_PARAM_NAMES_',
   /SECRET_PARAM_NAMES_[\s\S]{0,200}\.concat\(AUTH_PARAM_NAMES_\)/.test(SRC) &&
   /new RegExp\([\s\S]{0,200}SECRET_PARAM_NAMES_\.join\('\|'\)/.test(SRC));
ok('no second hand-typed list of parameter names survives in a regex literal',
   !/\(\?:secret\|token\|key\|pass\|password\)/.test(CODE));

/* Reading p.token at a call site is how a name escapes the list — two sites did, and ?session=
   users were refused by those two routes only. */
const directReads = (CODE.match(/\bp\.(token|session|auth)\b/g) || [])
  .concat(CODE.match(/\bparams\.(token|session|auth)\b/g) || [])
  .filter((s) => s !== 'params.token');   // requireCrew_'s own q.token assignment is the sanctioned one
ok('no route reads p.token / p.session / p.auth directly any more' +
   (directReads.length ? ' (found: ' + directReads.join(', ') + ')' : ''),
   directReads.length === 0);

/* ── 4. The surface that leaves the building ─────────────────────────────────────────────────── */
console.log('\nThe email path — the one exit that is not a reply');

mailed.length = 0;
sandbox.bugNotify_({
  /* A reporter pastes the URL that failed them into the title, and the title IS the subject. That
     is the realistic way a credential reaches a subject line, and it survives in a mailbox. */
  subject: 'UNFILED GX Crew bug [high]: ' + leakUrl('session'),
  lead: ['THIS REPORT IS NOT ON THE BUG BOARD. Could not reach the central bug log: ' +
         leakUrl('session') + ','],
  b: { reporter: 'mike', priority: 'high', tab: 'roster', appVer: 'v1.407', context: '', desc: 'x' }
});
ok('the unfiled-bug email is sent', mailed.length === 1);
ok('its body carries no credential', mailed.length === 1 && mailed[0].body.indexOf(planted) < 0);
ok('its subject is scrubbed too', mailed.length === 1 && mailed[0].subject.indexOf(planted) < 0);
ok('the rest of the report survives the scrub', mailed.length === 1 && /Reporter : mike/.test(mailed[0].body));

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll assertions passed.\n');
process.exit(fail ? 1 : 0);
