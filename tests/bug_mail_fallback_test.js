#!/usr/bin/env node
/* ─── A bug that files, and that nobody is ever told about ────────────────────────────────────────
 *
 *   RUN:  node tests/bug_mail_fallback_test.js
 *
 * WHY THIS EXISTS
 * GX Core v310 made Core's send the only send, and told every spoke to mail on its own "only when
 * gxIngestBug THROWS". It does not throw when its own email dies — a filed report has succeeded and
 * mail must never be what stops it — so the live failure mode was: the row lands, MailApp dies in
 * Core's catch, the call returns ok, and Crew stays silent. Correctly. A bug was filed, nobody was
 * told, and NOTHING recorded that: not the inbox, not the row, not a log. The absence of an email is
 * not an event anybody observes, which is why it could not be left for someone to notice.
 *
 * v312 added `mailed` / `mail_error` / `mail_skipped` so a caller can tell the three apart. Reading
 * them is part of why this app pins v315.
 *
 * THE TRAP THIS PINS HARDEST is the deduped repeat. Crew's /exec has the ~6% second-hop flake and a
 * redirect chain has been measured re-running one request up to three times. gxIngestBug returns at
 * `priorBug` ABOVE its send, so a repeat carries NO mail field at all — which is the only reason
 * "no `mailed` field" is safe to treat as a failure. Get that backwards and every redirect chain
 * reads as three separate mail failures: the three-emails bug rebuilt through its own fix.
 *
 * AND THE REFUSAL DOOR. gxIngestBug answers {ok:false, error} without throwing when it will not take
 * a report. A fallback keyed on the exception misses exactly the case it exists for. Crew has always
 * read the return, so this pins that it stays read.
 */
'use strict';
const fs = require('fs');
const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

let fail = 0;
const ok = (label, cond) => cond ? console.log('  ✓ ' + label) : (fail++, console.log('  ✗ ' + label));

function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in Code.gs');
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}

/* The engine's own three functions, over stubs that record instead of sending. CacheService is real
   enough to dedupe (a Map), because the dedupe is half of what is being tested. */
function build(opts) {
  opts = opts || {};
  const sent = [];
  const cache = new Map();
  const sandbox = {
    ACCOUNT_DOMAIN: 'greencrosscanna.com',
    STORE_TZ: 'America/Los_Angeles',
    requireCrew_: () => ({ ok: true, user: 'jayden', role: 'editor' }),
    GXCore: { gxIngestBug: opts.ingest || (() => ({ ok: true, id: 'bug_1', mailed: 'sky@x' })) },
    MailApp: { sendEmail: (m) => { if (opts.mailThrows) throw new Error('quota'); sent.push(m); } },
    Utilities: {
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
      // Deterministic and collision-free enough for a test: the string itself is the "digest".
      computeDigest: (_a, s) => s,
      base64EncodeWebSafe: (s) => Buffer.from(String(s)).toString('base64'),
      formatDate: () => '9/9/26 5:00 PM'
    },
    LockService: {
      getScriptLock: () => (opts.lockBusy
        ? { waitLock: () => { throw new Error('busy'); }, releaseLock: () => {} }
        : { waitLock: () => {}, releaseLock: () => {} })
    },
    CacheService: {
      getScriptCache: () => (opts.noCache
        ? { get: () => { throw new Error('down'); }, put: () => {} }
        : { get: (k) => cache.get(k) || null, put: (k, v) => cache.set(k, v) })
    },
    console: console
  };
  const src = grab('reportBug_') + '\n' + grab('bugNotify_') + '\n' + grab('bugMailOnce_') +
              '\n;this.reportBug_ = reportBug_; this.bugMailOnce_ = bugMailOnce_;';
  const fn = new Function('sandbox', 'with (sandbox) { ' + src + ' }');
  fn.call(sandbox, sandbox);
  return { call: (p) => sandbox.reportBug_(p || { title: 'roster is wrong', desc: 'no wage' }),
           once: (b, kind) => sandbox.bugMailOnce_(b, kind), sent };
}

console.log('bug mail fallback');

/* ── 1. The normal day sends nothing ──────────────────────────────────────────────────────────── */
{
  const t = build({ ingest: () => ({ ok: true, id: 'bug_1', mailed: 'sky@greencrosscanna.com' }) });
  const r = t.call();
  ok('a filed-and-announced report mails nothing extra', t.sent.length === 0);
  ok('  and still returns ok with the id', r.ok === true && r.id === 'bug_1');
}

/* ── 2. Filed, but Core could not mail — the case this whole file exists for ───────────────────── */
{
  const t = build({ ingest: () => ({ ok: true, id: 'bug_7', mail_error: 'MailApp: quota exhausted' }) });
  const r = t.call();
  ok('mail_error raises a notice', t.sent.length === 1);
  ok('  the report still succeeded, so the reporter is not told it failed', r.ok === true && r.id === 'bug_7');
  const m = t.sent[0];
  ok('  it says DO NOT re-file', /do NOT re-file/.test(m.body));
  ok('  it carries the bug id, which is the only way to go and look at it', /bug_7/.test(m.body));
  ok('  it names why the mail failed', /quota exhausted/.test(m.body));
  ok('  and it goes to Sky', m.to === 'sky@greencrosscanna.com');
}

/* ── 3. mail_skipped is the half that READS as fine ───────────────────────────────────────────── */
{
  const t = build({ ingest: () => ({ ok: true, id: 'bug_8', mail_skipped: 'no watch address' }) });
  t.call();
  ok('mail_skipped raises a notice too', t.sent.length === 1);
  ok('  worded as skipped, not failed', /skipped/.test(t.sent[0].body) && !/failed/.test(t.sent[0].body));
}

/* ── 4. THE TRAP: a deduped repeat carries no mail field and must stay silent ──────────────────── */
{
  const t = build({ ingest: () => ({ ok: true, id: 'bug_9', app: 'crew', deduped: true }) });
  const r = t.call();
  ok('a deduped repeat mails NOTHING', t.sent.length === 0);
  ok('  and returns the prior id', r.ok === true && r.id === 'bug_9');
}

/* ── 5. THE REFUSAL DOOR: {ok:false} without a throw ───────────────────────────────────────────── */
{
  const t = build({ ingest: () => ({ ok: false, error: 'title or detail required' }) });
  const r = t.call();
  ok('a refusal (no throw) raises a notice', t.sent.length === 1);
  ok('  the reporter IS told, unlike Leaderboard', r.ok === false && /title or detail required/.test(r.error));
  ok('  the notice says it is NOT on the board', /NOT ON THE BUG BOARD/.test(t.sent[0].body));
  ok('  and carries the description, which exists nowhere else', /no wage/.test(t.sent[0].body));
  ok('  and does not tell Sky the reporter thinks it worked',
     /reporter WAS shown the failure/.test(t.sent[0].body));
}

/* ── 6. Core unreachable — a throw ─────────────────────────────────────────────────────────────── */
{
  const t = build({ ingest: () => { throw new Error('library not bound'); } });
  const r = t.call();
  ok('a throw raises the unfiled notice', t.sent.length === 1 && /NOT ON THE BUG BOARD/.test(t.sent[0].body));
  ok('  and the error travels to the reporter', r.ok === false && /library not bound/.test(r.error));
}

/* ── 7. The two notices must not share a de-dupe key ───────────────────────────────────────────── */
{
  const t = build();
  const b = { reporter: 'jayden', title: 'x', desc: 'y' };
  ok('first unfiled mark is taken', t.once(b, 'unfiled') === true);
  ok('  a repeat inside the window is refused', t.once(b, 'unfiled') === false);
  ok('  but the OTHER kind is still free — contradictory instructions must both get through',
     t.once(b, 'unannounced') === true);
}

/* ── 8. It FAILS OPEN: a dead cache or a busy lock must never silence a report ─────────────────── */
{
  const dead = build({ noCache: true, ingest: () => ({ ok: true, id: 'b', mail_error: 'x' }) });
  dead.call();
  ok('a dead cache still sends', dead.sent.length === 1);

  const busy = build({ lockBusy: true, ingest: () => ({ ok: true, id: 'b', mail_error: 'x' }) });
  busy.call();
  ok('a busy lock still sends', busy.sent.length === 1);
}

/* ── 9. Mail is the enhancement, the report is the thing ───────────────────────────────────────── */
{
  const t = build({ mailThrows: true, ingest: () => ({ ok: true, id: 'bug_5', mail_error: 'x' }) });
  let r = null, threw = false;
  try { r = t.call(); } catch (e) { threw = true; }
  ok('a failed fallback send does not break the filing', !threw && r && r.ok === true && r.id === 'bug_5');
}

/* ── 10. The same report twice inside the window mails once ────────────────────────────────────── */
{
  const t = build({ ingest: () => ({ ok: true, id: 'bug_6', mail_error: 'x' }) });
  t.call(); t.call();
  ok('a repeat of the SAME report inside 3 minutes mails once', t.sent.length === 1);
  t.call({ title: 'something else', desc: 'different' });
  ok('  a DIFFERENT report still mails', t.sent.length === 2);
}

/* ── 11. Source-level invariants the stubs cannot see ──────────────────────────────────────────── */
{
  const src = grab('reportBug_');
  ok('the refusal is read off the RETURN, not the exception', /res\.ok === false/.test(src));
  ok('the mail fields are read with truthiness, never `in`',
     /res\.mail_error \|\| res\.mail_skipped/.test(src) && !/'mail_error' in /.test(src));
  ok('the two notices use different de-dupe kinds',
     /bugMailOnce_\(b, 'unfiled'\)/.test(src) && /bugMailOnce_\(b, 'unannounced'\)/.test(src));
  ok('the recipient is not fetched from GX Core',
     !/getKv|GXCore\./.test(grab('bugNotify_')));
  ok('the dedupe window matches gxIngestBug (180s)', /180/.test(grab('bugMailOnce_')));

  /* THE UNREACHABLE BRANCH MUST SURVIVE. Core's watch address defaults to sky@ and is emptied only
     by the literal 'off', so `mail_skipped` cannot fire today — which is exactly the shape of a
     branch somebody deletes as dead a year from now. It goes live overnight from one config
     change, so the reason it is unreachable is dated in the comment and pinned here. */
  ok('the mail_skipped branch is still read', /res\.mail_skipped/.test(src));
  ok('  and the comment dates WHY it is unreachable rather than leaving it to look dead',
     /UNREACHABLE TODAY/.test(gs) && /UNSET IS\n     NOT OFF/.test(gs));
  ok('mail_check reports the setting that makes it reachable',
     /bug_watch_email/.test(gs) && /bug_mail_skipped_reachable/.test(gs));
  ok('  and an unreadable key does not read as "off"',
     /watch\.toLowerCase\(\) === 'off'/.test(gs) && /\(unreadable/.test(gs));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nbug mail fallback: all passed');
process.exit(fail ? 1 : 0);
