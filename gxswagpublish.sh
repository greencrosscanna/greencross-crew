#!/usr/bin/env bash
# ─── gxswagpublish — preview or run Crew's shirt-size COUNTS publish to GX Core ──────────────────────
#
#   ./gxswagpublish.sh          preview: the counts that WOULD be sent. Calls nothing on Core.
#   ./gxswagpublish.sh --run    publish now (confirm=yes), then print the last run.
#
# Calls ?action=swag_sizes_publish on Crew's own engine (deploy-secret). The reply is counts only; this
# prints only whitelisted, coerced figures. The secret rides on curl's stdin, never argv, and is
# scrubbed from the output. Same handling as gxpermitpublish.sh.
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

RUN=""
case "${1:-}" in
  "") ;;
  --run) RUN="yes" ;;
  *) echo "usage: ./gxswagpublish.sh [--run]"; exit 1 ;;
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
                --data-urlencode "action=swag_sizes_publish" --data-urlencode "confirm=yes" 2>/dev/null)"
  else
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=swag_sizes_publish" 2>/dev/null)"
  fi
  case "$resp" in \{*) break ;; esac
  sleep 2
done
case "$resp" in \{*) ;; *) echo "x Crew's engine did not return JSON after 4 tries (re-run)"; exit 2 ;; esac

printf '%s' "$resp" | GXSW_SECRET="$SECRET" python3 -c '
import sys, json, re, os
def num(v):
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
def word(v, n=40):
    return re.sub(r"[^A-Za-z0-9 _.:-]", "?", v)[:n] if isinstance(v, str) else ""
def line(label, b):
    if not isinstance(b, dict): return
    sh = b.get("shirt") if isinstance(b.get("shirt"), dict) else {}
    sizes = ", ".join("%s %s" % (word(k, 6), num(v)) for k, v in sh.items() if num(v))
    print("  %-14s active=%s not_set=%s  %s" % (word(label, 14), num(b.get("active")), num(b.get("not_set")), sizes))
try: d = json.loads(sys.stdin.read(), strict=False)
except Exception: print("x reply was not JSON"); raise SystemExit(2)
if not isinstance(d, dict): print("x reply was not an object"); raise SystemExit(2)
if d.get("error") == "bad deploy secret": print("x refused: bad deploy secret"); raise SystemExit(1)
if d.get("ran"): print("RAN a publish just now.")
w = d.get("would_send")
if isinstance(w, dict):
    print("Preview (as_of %s):" % word(w.get("as_of"), 12))
    for k, v in (w.get("by_store") or {}).items(): line(k, v)
    line("TOTAL", w.get("total"))
n = d.get("note") if isinstance(d.get("note"), dict) else None
if n: print("This run: ok=%s code=%s active=%s not_set=%s stores=%s" % (n.get("ok") is True, word(n.get("code")) or "-", num(n.get("active")), num(n.get("not_set")), num(n.get("stores"))))
l = d.get("last_run") if isinstance(d.get("last_run"), dict) else None
if l: print("Last publish (%s, %s): ok=%s code=%s" % (word(l.get("why")), word(l.get("at"), 24), l.get("ok") is True, word(l.get("code")) or "-"))
else: print("No publish has run yet.")
if n and n.get("error"): print("  error: " + word(n.get("error"), 160))
' | GXSW_SECRET="$SECRET" python3 -c '
import sys, os
sys.stdout.write(sys.stdin.read().replace(os.environ["GXSW_SECRET"], "<secret>"))'
