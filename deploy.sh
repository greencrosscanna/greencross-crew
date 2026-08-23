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
# MAJOR.MINOR is allowed here, and extracting it needs BOTH halves changed. The old second stage was
# `grep -oE '[0-9]+'`, which stopped at the dot and filed spiff.js?v=1.28 as "v1" — silently, with a
# success line. Widening only that class to `[0-9.]+` is worse, not better: it matches the dot in
# ".js" first and yields "." for EVERY app, including the integer ones that work today. So the second
# stage is a sed that strips up to `?v=` instead of a grep that hunts for digits anywhere in the tag.
# Verified both ways: 1.28 -> 1.28, 2.10 -> 2.10, 26 -> 26, 40 -> 40. No spoke regresses.
_ver="$(grep -oE '[A-Za-z0-9_.-]+\.js\?v=[0-9]+(\.[0-9]+)?' index.html 2>/dev/null | sed -E 's/.*\?v=//' | head -1 || true)"
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
# ── The suite version format: vMAJOR.BBB, a 3-digit zero-padded build ──────────────────────────
# Checked HERE so you find out before you ship, not after. GX Core's gxRecordVersion enforces the
# same rule server-side — that one is the real gate (any curl can skip this script), this one is the
# one that saves you a redeploy. Keep the two in step; the rule is documented in gx_core.gs.
#
# Six repos each deciding independently what a version looks like is how this drifted: measured
# 2026-08-23 the suite held v1.583, v3.02, '2.5', v42, v1.28 and v1.28 — three build widths, one app
# with no MAJOR at all, one missing its `v`, and two apps colliding on the same number.
#
# Widths that disagree do not sort: 'v1.28' is ABOVE 'v1.280' as a string and BELOW it as a number,
# so What's New ordering and every "is this newer than what I've seen" check disagree the moment a
# counter crosses a digit boundary. A fixed width is what makes one comparison rule work everywhere.
#
# The pad is to the RIGHT. The build is the fractional half of a decimal that has been counting up,
# so v1.28 is the 280s — left-padding to v1.028 would send the app backwards past everything it has
# already shipped.
_bad_version() {
  echo "deploy.sh: version '$APP_VERSION' does not match the suite format vMAJOR.BBB." >&2
  [ -n "${1:-}" ] && echo "  Did you mean ${1}?" >&2
  echo "  Fix it in index.html — the version IS the cache-buster, so it has to be right in the file," >&2
  echo "  not patched on the way to the log. Then re-run ./deploy.sh." >&2
  exit 1
}
_pad3() { printf '%s' "$(printf '%s000' "$1" | cut -c1-3)"; }   # right-pad: 28 -> 280, 5 -> 500
case "$APP_VERSION" in
  v*.*)
    _maj="${APP_VERSION#v}"; _maj="${_maj%%.*}"
    _bld="${APP_VERSION##*.}"
    # Exactly one dot, both halves all-digits, build exactly 3 wide.
    case "$APP_VERSION" in *.*.*) _bad_version "" ;; esac
    case "$_maj$_bld" in *[!0-9]*) _bad_version "" ;; esac
    [ "${#_bld}" -eq 3 ] || _bad_version "v${_maj}.$(_pad3 "$_bld")"
    ;;
  v*)
    # No dot at all — the price-cards shape (v42). Everything after the v is the build.
    _bld="${APP_VERSION#v}"
    case "$_bld" in *[!0-9]*) _bad_version "" ;; esac
    _bad_version "v1.$(_pad3 "$_bld")"
    ;;
  *) _bad_version "" ;;
esac
SHA="$(git rev-parse --short HEAD)"
GX_NOTES="${GX_NOTES:-}"

echo "Recording ${APP} ${APP_VERSION} (${SHA}) to GX Core…"
curl -sL -G "$GXCORE" --data-urlencode action=deploy_version --data-urlencode "secret=$SECRET" \
  --data-urlencode "app=$APP" --data-urlencode "version=$APP_VERSION" \
  --data-urlencode "sha=$SHA" --data-urlencode "notes=$GX_NOTES"
echo
