#!/usr/bin/env bash
# ─── SHARED deploy recorder (source of truth: gx-theme) ──────────────────────────────────────────
# Record a release in the GX Core shared version log. Synced into every spoke by gx-sync.sh, which
# fills the app-key placeholder from the repo's .gx_app. Run AFTER you ship (git push to Pages /
# clasp deploy engine). Do NOT write that placeholder literally in prose here: gx-sync substitutes
# every occurrence, so an explanatory mention becomes 'fills inventory from the repo's .gx_app'.
#   Usage:  GX_NOTES="what changed this release" ./deploy.sh
# Version comes from the ?v=NN cache-buster on the JS <script>, falling back to an APP_VERSION /
# GC.VERSION constant for monolith apps that have no external JS. To change this script, edit it
# HERE and re-sync spokes.
set -euo pipefail
cd "$(dirname "$0")"

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
APP="crew"
SECRET="$(cat .gx_deploy_secret)"
# ── Version, in order of preference ────────────────────────────────────────────────────────────
#  1. the ?v=NN cache-buster on a JS <script>   (crew, price-cards, spiff — apps with external JS)
#  2. an APP_VERSION / GC.VERSION constant      (inventory, sales — monoliths with inline JS)
# A monolith has no external .js file to hang a cache-buster on, so #1 alone found nothing. Under
# `set -euo pipefail` a no-match grep aborts the whole script, which is why releases for those two
# apps were never recorded at all. Both greps are `|| true` so a miss falls through to the next
# source instead of killing the run.
_ver="$(grep -oE '[A-Za-z0-9_.-]+\.js\?v=[0-9]+' index.html 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
if [ -n "$_ver" ]; then
  APP_VERSION="v$_ver"
else
  # Accepts APP_VERSION = 'v2.95' and APP_VERSION = '2.0' alike; the v is normalised on below.
  _ver="$(grep -oE "(APP_VERSION|GC\.VERSION)[[:space:]]*=[[:space:]]*['\"][^'\"]+['\"]" index.html 2>/dev/null \
          | head -1 | grep -oE "['\"][^'\"]+['\"]" | tr -d "\"'" || true)"
  case "$_ver" in
    v*) APP_VERSION="$_ver"  ;;
    ?*) APP_VERSION="v$_ver" ;;
    *)  APP_VERSION=""       ;;
  esac
fi
# Never file a versionless release: the shared log is what every app reads for What's New, and a
# blank or bare-"v" entry there is worse than a failed deploy record you can see and fix.
if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" = "v" ]; then
  echo "deploy.sh: could not determine a version from index.html." >&2
  echo "  Expected a ?v=NN cache-buster on a JS <script>, or an APP_VERSION/GC.VERSION constant." >&2
  echo "  Refusing to record a versionless release." >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
GX_NOTES="${GX_NOTES:-}"

echo "Recording ${APP} ${APP_VERSION} (${SHA}) to GX Core…"
curl -sL -G "$GXCORE" --data-urlencode action=deploy_version --data-urlencode "secret=$SECRET" \
  --data-urlencode "app=$APP" --data-urlencode "version=$APP_VERSION" \
  --data-urlencode "sha=$SHA" --data-urlencode "notes=$GX_NOTES"
echo
