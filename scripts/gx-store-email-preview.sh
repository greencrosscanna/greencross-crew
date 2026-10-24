#!/usr/bin/env bash
# ─── gx-store-email-preview — PREVIEW the store incentive email; it can never send ────────────────
#
#   bash scripts/gx-store-email-preview.sh [pp_start] [out.json]
#
# Calls ?action=store_email&show=html on Crew's engine WITHOUT send=yes, so it mails nobody.
# The reply is the email's HTML and facts (it carries every person's name and pay: keep the output
# file out of the repo). The secret rides on curl's stdin, never in argv (gxcrewstats.sh's rule).
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

PP="${1:-}"
OUT="${2:-}"
ENGINE="$(python3 -I -c '
import re
m = re.search(r"ENGINE_URL_FALLBACK\s*=\s*[\x27\x22](https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec)[\x27\x22]", open("crew.js", encoding="utf-8").read())
print(m.group(1) if m else "")
')"
[ -n "$ENGINE" ] || { echo "x could not read ENGINE_URL_FALLBACK from crew.js"; exit 1; }
[ -f .gx_deploy_secret ] || { echo "x no .gx_deploy_secret here"; exit 1; }
SECRET="$(tr -d '\r\n' < .gx_deploy_secret)"

resp=""
for t in 60 90 120; do
  if [ -n "$PP" ]; then
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=store_email" --data-urlencode "show=html" \
                --data-urlencode "pp_start=$PP" 2>/dev/null)"
  else
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=store_email" --data-urlencode "show=html" 2>/dev/null)"
  fi
  case "$resp" in \{*) break ;; esac
  sleep 2
done
case "$resp" in
  \{*) ;;
  *) echo "x the engine did not return JSON after 3 tries"; exit 2 ;;
esac
if [ -n "$OUT" ]; then printf '%s' "$resp" > "$OUT"; echo "wrote $OUT"; else printf '%s\n' "$resp"; fi
