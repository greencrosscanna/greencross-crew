#!/usr/bin/env bash
# ─── gx-store-email-to — read or set WHO gets the store incentive email ───────────────────────────
#
#   bash scripts/gx-store-email-to.sh                 show the current list
#   bash scripts/gx-store-email-to.sh mike,sky        REPLACE the list (company mailboxes only)
#
# Calls ?action=store_email_to on Crew's engine. It never sends anything. A set REPLACES the whole
# list, so include everyone who should keep getting it. Secret rides on curl's stdin, not argv.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
TO="${1-__read__}"
ENGINE="$(python3 -I -c '
import re
m = re.search(r"ENGINE_URL_FALLBACK\s*=\s*[\x27\x22](https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec)[\x27\x22]", open("crew.js", encoding="utf-8").read())
print(m.group(1) if m else "")
')"
[ -n "$ENGINE" ] || { echo "x could not read ENGINE_URL_FALLBACK from crew.js"; exit 1; }
[ -f .gx_deploy_secret ] || { echo "x no .gx_deploy_secret here"; exit 1; }
SECRET="$(tr -d '\r\n' < .gx_deploy_secret)"
resp=""
for t in 45 90; do
  if [ "$TO" = "__read__" ]; then
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" --data-urlencode "action=store_email_to" 2>/dev/null)"
  else
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" --data-urlencode "action=store_email_to" \
                --data-urlencode "to=$TO" 2>/dev/null)"
  fi
  case "$resp" in \{*) break ;; esac
  sleep 2
done
case "$resp" in \{*) printf '%s\n' "$resp" ;; *) echo "x the engine did not return JSON"; exit 2 ;; esac
