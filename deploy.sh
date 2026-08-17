#!/usr/bin/env bash
# ─── SHARED deploy recorder (source of truth: gx-theme) ──────────────────────────────────────────
# Record a release in the GX Core shared version log. Synced into every spoke by gx-sync.sh, which
# fills crew from the repo's .gx_app. Run AFTER you ship (git push to Pages / clasp deploy engine).
#   Usage:  GX_NOTES="what changed this release" ./deploy.sh
# Version is single-sourced from the ?v=NN cache-buster on the JS <script> in index.html — works for
# any app (generator.js, app.js, main.js, …). To change this script, edit it HERE and re-sync spokes.
set -euo pipefail
cd "$(dirname "$0")"

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
APP="crew"
SECRET="$(cat .gx_deploy_secret)"
APP_VERSION="v$(grep -oE '[A-Za-z0-9_.-]+\.js\?v=[0-9]+' index.html | grep -oE '[0-9]+' | head -1)"
SHA="$(git rev-parse --short HEAD)"
GX_NOTES="${GX_NOTES:-}"

echo "Recording ${APP} ${APP_VERSION} (${SHA}) to GX Core…"
curl -sL -G "$GXCORE" --data-urlencode action=deploy_version --data-urlencode "secret=$SECRET" \
  --data-urlencode "app=$APP" --data-urlencode "version=$APP_VERSION" \
  --data-urlencode "sha=$SHA" --data-urlencode "notes=$GX_NOTES"
echo
