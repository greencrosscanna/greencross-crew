#!/usr/bin/env bash
# ─── gx-spiff-publication — read one pay period's published SPIFF progress from GX Core ──────────
#
#   bash scripts/gx-spiff-publication.sh 2026-10-12 [out.json]
#
# READ-ONLY. Calls GX Core's ?action=published_spiff_progress (deploy-secret) and writes the reply
# to out.json (default: stdout). Used to eyeball the real publication the store incentive email
# reads, and to check a test fixture still has the real shape. The secret rides on curl's stdin as a
# config file, never in argv (gxcrewstats.sh's rule), and is scrubbed from anything printed.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

PP="${1:-}"
OUT="${2:-}"
case "$PP" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "usage: bash scripts/gx-spiff-publication.sh YYYY-MM-DD [out.json]"; exit 1 ;;
esac

CORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
[ -f .gx_deploy_secret ] || { echo "x no .gx_deploy_secret here"; exit 1; }
SECRET="$(tr -d '\r\n' < .gx_deploy_secret)"

resp=""
for t in 30 60 90; do
  resp="$(printf '%s\n' "url = \"$CORE\"" "--data-urlencode secret=$SECRET" \
          | curl -K - --get --silent --location --max-time "$t" \
              --data-urlencode "action=published_spiff_progress" \
              --data-urlencode "producer=spiff" --data-urlencode "scope=$PP" 2>/dev/null)"
  case "$resp" in \{*) break ;; esac
  sleep 2
done
case "$resp" in
  \{*) ;;
  *) echo "x GX Core did not return JSON after 3 tries"; exit 2 ;;
esac

if [ -n "$OUT" ]; then
  printf '%s' "$resp" > "$OUT"
  echo "wrote $OUT"
else
  printf '%s\n' "$resp"
fi
