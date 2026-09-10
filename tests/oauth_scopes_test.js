#!/usr/bin/env node
/* ─── Crew's declared Google permissions ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/oauth_scopes_test.js    (from the repo root; no deps, no network)
 *
 * WHY THIS EXISTS
 * Until 2026-09-09 Crew was the only app of six with no `oauthScopes` in its manifest, so Apps
 * Script guessed the list from the code. Both of Crew's permission failures came through that
 * guess: `MailApp` for the digest and `DriveApp` for the payout PDF. Apps Script does NOT re-prompt
 * for a scope added to an authorized project, so each new API arrived looking fine and failed only
 * when called — a digest that "Completed" having sent nothing, a PDF that never filed.
 *
 * A declared list does not stop that on its own. What stops it is this file: code that starts using
 * a Google service whose scope is not declared fails HERE, at push, instead of in front of Mike.
 *
 * THE LIST IS THE GRANT, NOT A GUESS. It was read off the live deployment's own token with
 * `?action=scopes_check` on 2026-09-09 and declared exactly — which is why declaring it needed no
 * reconsent and caused no downtime. Two entries look odd and are not:
 *   - `userinfo.email` — `Session.getEffectiveUser().getEmail()` in mail_check and pdf_check.
 *   - `script.container.ui` — nothing in Crew uses it; GXCore's own web page (HtmlService) does,
 *     and auto-detect folds library scopes into the grant. Declared so the list equals the grant.
 *     Dropping it is probably harmless and certainly untested, which is the wrong trade here.
 *
 * ADDING A SCOPE IS NOT A ONE-LINE CHANGE. The deployment runs on a stored grant that a manifest
 * edit does not widen. The only way through is: revoke GX Crew at myaccount.google.com/permissions,
 * then run a function from the editor and accept the consent screen — and THE ENGINE IS DOWN
 * between those two steps. So a new scope fails the GRANTED check below until someone updates it,
 * and whoever updates it should have done the reconsent first. Confirm with `scopes_check`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const G = 'https://www.googleapis.com/auth/';

// What the live deployment held on 2026-09-09 (scopes_check). Move only after a reconsent.
const GRANTED = ['spreadsheets', 'drive', 'script.external_request', 'script.scriptapp',
                 'script.send_mail', 'userinfo.email', 'script.container.ui'].map(s => G + s);

// Google service → the scope it needs. A service not listed here fails the test: add the mapping
// deliberately rather than let a new API through unexamined.
const NEEDS = {
  SpreadsheetApp: 'spreadsheets',
  DriveApp: 'drive',
  UrlFetchApp: 'script.external_request',
  ScriptApp: 'script.scriptapp',
  MailApp: 'script.send_mail',
  'Session.getEffectiveUser().getEmail': 'userinfo.email',
  'Session.getActiveUser().getEmail': 'userinfo.email',
};
const UNMAPPED = ['GmailApp', 'CalendarApp', 'DocumentApp', 'FormApp', 'SlidesApp', 'GroupsApp',
                  'ContactsApp', 'People', 'AdminDirectory', 'BigQuery', 'Drive', 'Sheets'];

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail++; };

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script/appsscript.json'), 'utf8'));
const declared = manifest.oauthScopes || [];
const src = fs.readdirSync(path.join(ROOT, 'apps-script'))
  .filter(f => f.endsWith('.gs'))
  .map(f => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // comments are not calls

console.log('oauth scopes:');
ok(Array.isArray(manifest.oauthScopes) && declared.length > 0,
   'the manifest declares oauthScopes (auto-detect is what made both past scope failures silent)');

for (const [svc, scope] of Object.entries(NEEDS)) {
  const used = src.includes(svc.includes('.') ? svc : svc + '.');
  if (used) ok(declared.includes(G + scope), `${svc} is used, and ${scope} is declared`);
}

for (const svc of UNMAPPED) {
  const re = new RegExp('\\b' + svc + '\\.');
  ok(!re.test(src), `${svc} is not used — if it is now, map its scope here AND reconsent first`);
}

for (const s of declared) {
  ok(GRANTED.includes(s), `${s.replace(G, '')} is in the live grant ` +
     '(a scope outside it is refused until revoke + reconsent — see the header)');
}
for (const s of GRANTED) {
  ok(declared.includes(s), `granted scope ${s.replace(G, '')} is still declared`);
}

ok(!declared.includes('email'),
   'no bare "email" alias — tokeninfo reports it, but it is not a manifest scope');

// The route that produced the list must stay — it is the only way to re-check the grant.
ok(/case 'scopes_check':/.test(src) && /function scopesCheck_\(/.test(src),
   'scopes_check route still exists to re-read the live grant');
ok(!/tokeninfo\?access_token/.test(src), 'the token is never put in a URL');

if (fail) { console.log(`\noauth scopes: ${fail} FAILED`); process.exit(1); }
console.log('\noauth scopes: all passed');
