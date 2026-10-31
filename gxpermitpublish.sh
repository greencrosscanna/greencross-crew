#!/usr/bin/env bash
# ─── gxpermitpublish — preview or run Crew's permit publish to GX Core, COUNTS ONLY ──────────────────
#
#   ./gxpermitpublish.sh            preview: how many people would be listed / sent blank, last run,
#                                   and Core's own permitStatus counts. Calls nothing on Core but the status.
#   ./gxpermitpublish.sh --run      publish now (confirm=yes), then print the same.
#
# Calls ?action=permit_publish on Crew's own engine (deploy-secret). It prints numbers, codes and
# yes/no only. Permit numbers are never in the reply, and this prints nothing else even if the route
# is later changed to send more: every field is whitelisted and coerced here. Employee ids Core did
# not recognize come back from the route; they are COUNTED here, never printed (they are names).
# The secret rides on curl's stdin as a config file, never argv, and is scrubbed from the output.
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

RUN=""
case "${1:-}" in
  "") ;;
  --run) RUN="yes" ;;
  *) echo "usage: ./gxpermitpublish.sh [--run]"; exit 1 ;;
esac

ENGINE="$(python3 -c '
import re, sys
try: src = open("crew.js", encoding="utf-8").read()
except Exception: sys.exit(0)
m = re.search(r"ENGINE_URL_FALLBACK\s*=\s*[\x27\x22](https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec)[\x27\x22]", src)
print(m.group(1) if m else "")
' 2>/dev/null)"
[ -n "$ENGINE" ] || { echo "x could not read ENGINE_URL_FALLBACK from crew.js - run from the greencross-crew repo"; exit 1; }
[ -f .gx_deploy_secret ] || { echo "x no .gx_deploy_secret here (a worktree does not carry it)"; exit 1; }
SECRET="$(tr -d '\r\n' < .gx_deploy_secret)"
[ -n "$SECRET" ] || { echo "x .gx_deploy_secret is empty"; exit 1; }

resp=""
for t in 60 90 120 150; do
  if [ -n "$RUN" ]; then
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=permit_publish" --data-urlencode "confirm=yes" 2>/dev/null)"
  else
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=permit_publish" 2>/dev/null)"
  fi
  case "$resp" in \{*) break ;; esac
  sleep 2
done
case "$resp" in \{*) ;; *) echo "x Crew's engine did not return JSON after 4 tries (re-run)"; exit 2 ;; esac

printf '%s' "$resp" | GXPP_SECRET="$SECRET" python3 -c '
import sys, json, re, os
def num(v):
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
def word(v, n=40):
    return re.sub(r"[^A-Za-z0-9 _.:-]", "?", v)[:n] if isinstance(v, str) else ""
try: d = json.loads(sys.stdin.read(), strict=False)
except Exception: print("x reply was not JSON"); raise SystemExit(2)
if not isinstance(d, dict): print("x reply was not an object"); raise SystemExit(2)
if d.get("error") == "bad deploy secret": print("x refused: bad deploy secret"); raise SystemExit(1)
if d.get("ran"): print("RAN a publish just now.")
n = d.get("note") if isinstance(d.get("note"), dict) else (d.get("last_run") if isinstance(d.get("last_run"), dict) else None)
if d.get("would_list") is not None:
    print("Preview: would list %s people, %s of them blank." % (num(d.get("would_list")), num(d.get("would_send_blank"))))
if n:
    print("Last run (%s, %s): ok=%s code=%s" % (word(n.get("why")), word(n.get("at"), 24), n.get("ok") is True, word(n.get("code")) or "-"))
    print("  listed=%s blank=%s received=%s stored=%s unchanged=%s cleared=%s invalid=%s unknown_ids=%s" % tuple(
        num(n.get(k)) for k in ("listed", "blank", "received", "stored", "unchanged", "cleared", "invalid", "unknown")))
    if n.get("error"): print("  error: " + word(n.get("error"), 160))
else:
    print("No publish has run yet.")
ids = d.get("unknown_employee_ids")
if isinstance(ids, list) and ids: print("! %d employee id(s) Core did not recognize (not printed: they are names)." % len(ids))
c = d.get("core")
if isinstance(c, dict):
    print("Core permitStatus: ok=%s with_permit=%s locked_now=%s stale_key_rows=%s key_set=%s newest_published_at=%s" % (
        c.get("ok") is True, num(c.get("with_permit")), num(c.get("locked_now")), num(c.get("stale_key_rows")),
        c.get("key_set") is True, word(c.get("newest_published_at"), 24) or "-"))
    if c.get("ok") is not True and c.get("error"): print("  core error: " + word(c.get("error"), 160))
else:
    print("Core permitStatus: not available (library pin too old, or no answer).")
' | GXPP_SECRET="$SECRET" python3 -c '
import sys, os
sys.stdout.write(sys.stdin.read().replace(os.environ["GXPP_SECRET"], "<secret>"))'
