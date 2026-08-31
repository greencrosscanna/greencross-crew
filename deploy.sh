#!/usr/bin/env bash
# ─── SHARED deploy recorder (source of truth: gx-theme) ──────────────────────────────────────────
# Record a release in the GX Core shared version log. Synced into every spoke by gx-sync.sh, which
# fills the app-key placeholder from the repo's .gx_app. Run AFTER you ship (git push to Pages /
# clasp deploy engine). Do NOT write that placeholder literally in prose here: gx-sync substitutes
# every occurrence, so an explanatory mention becomes 'fills inventory from the repo's .gx_app'.
#   Usage:  GX_NOTES="what changed this release" ./deploy.sh
#           GX_VERSION=v3.020 GX_NOTES="..." ./deploy.sh    # record this version, skip extraction
# Version comes from the ?v=NN cache-buster on the JS <script> in HEAD:index.html, falling back to an
# APP_VERSION / GC.VERSION constant for monolith apps that have no external JS. HEAD, not the working
# tree — see the long note below; reading the tree published a release that was never shipped. To
# change this script, edit it HERE and re-sync spokes.
set -euo pipefail
cd "$(dirname "$0")"

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
APP="crew"
SECRET="$(cat .gx_deploy_secret)"
# ── Which index.html do we read the version out of? HEAD, not the working tree ─────────────────
# THE BUG THIS FIXES. deploy.sh takes no version argument, so it used to grep the version out of
# index.html AS IT SAT ON DISK. On 2026-08-23 that recorded inventory v3.020 — a release that was
# never shipped. A second session was mid-edit in the same repo with the version bumped to a
# not-yet-shipped value, and this script faithfully published it. Worse, the sha it recorded came
# from `git rev-parse HEAD` — the COMMITTED code — so the row paired a version and a sha that never
# coexisted. Two repos here are Dropbox-synced and routinely have more than one session open, so
# "the working tree is what shipped" is not a safe assumption anywhere in this suite.
#
# THE FIX. Read the version from `git show HEAD:index.html`. deploy.sh runs AFTER you ship, and
# shipping is a git push (Pages) or a clasp deploy of pushed code — so HEAD is what is live, and the
# sha we record is HEAD's anyway. Reading HEAD makes the version and the sha consistent BY
# CONSTRUCTION rather than by the author remembering to check. A dirty tree can no longer leak in.
#
# Two escape hatches, both deliberate:
#   GX_VERSION=v3.020 ./deploy.sh   record this exact version; skip extraction entirely. For the
#                                   caller who knows what shipped and should not have to launder it
#                                   through a file. Still format-gated below — an override is a way
#                                   round the GUESS, not round the rule.
#   GX_ALLOW_DIRTY=1                proceed even though HEAD and the working tree disagree about the
#                                   version. Prints what it is doing. You almost never want this.
_extract_version() {   # $1 = index.html contents on stdin-ish (passed as a single string)
  local _src="$1" _v=""
  # 1. the ?v=NN cache-buster on a JS <script>   (crew, price-cards, spiff — apps with external JS)
  # MAJOR.MINOR is allowed, and extracting it needs BOTH halves right. The old second stage was
  # `grep -oE '[0-9]+'`, which stopped at the dot and filed spiff.js?v=1.28 as "v1" — silently, with
  # a success line. Widening only that class to `[0-9.]+` is WORSE, not better: it matches the dot
  # in ".js" first and yields "." for EVERY app, including the integer ones that work today. So the
  # second stage is a sed that strips up to `?v=` rather than a grep hunting digits anywhere.
  # Verified both ways: 1.28 -> 1.28, 2.10 -> 2.10, 26 -> 26, 40 -> 40. No spoke regresses.
  _v="$(printf '%s' "$_src" | grep -oE '[A-Za-z0-9_.-]+\.js\?v=[0-9]+(\.[0-9]+)?' 2>/dev/null | sed -E 's/.*\?v=//' | head -1 || true)"
  if [ -n "$_v" ]; then printf 'v%s' "$_v"; return; fi
  # 2. an APP_VERSION / GC.VERSION constant      (inventory, sales — monoliths with inline JS)
  # A monolith has no external .js file to hang a cache-buster on, so #1 alone found nothing. Under
  # `set -euo pipefail` a no-match grep aborts the whole script, which is why releases for those two
  # apps went unrecorded for a while. Every grep here is `|| true` so a miss falls through.
  # Accepts APP_VERSION = 'v2.95' and APP_VERSION = '2.0' alike; the v is normalized on.
  _v="$(printf '%s' "$_src" | grep -oE "(APP_VERSION|GC\.VERSION)[[:space:]]*=[[:space:]]*['\"][^'\"]+['\"]" 2>/dev/null \
        | head -1 | grep -oE "['\"][^'\"]+['\"]" | tr -d "\"'" || true)"
  case "$_v" in
    v*) printf '%s' "$_v"  ;;
    ?*) printf 'v%s' "$_v" ;;
    *)  printf ''          ;;
  esac
}

APP_VERSION=""
VERSION_SOURCE=""
if [ -n "${GX_VERSION:-}" ]; then
  case "$GX_VERSION" in v*) APP_VERSION="$GX_VERSION" ;; *) APP_VERSION="v$GX_VERSION" ;; esac
  VERSION_SOURCE="GX_VERSION override"
else
  _head_src="$(git show HEAD:index.html 2>/dev/null || true)"
  if [ -n "$_head_src" ]; then
    APP_VERSION="$(_extract_version "$_head_src")"
    VERSION_SOURCE="HEAD:index.html"
    # A tree that disagrees with HEAD is the exact condition that produced the phantom row. We are
    # now reading the safe side, but the disagreement still means someone is mid-edit in this
    # checkout — and if that someone is another session, the thing you just shipped may not be the
    # thing you think. Say so and stop; a warning nobody has to answer is a warning nobody reads.
    _tree_ver="$(_extract_version "$(cat index.html 2>/dev/null || true)")"
    if [ -n "$_tree_ver" ] && [ "$_tree_ver" != "$APP_VERSION" ]; then
      echo "deploy.sh: index.html in the working tree does not agree with HEAD about the version." >&2
      echo "  HEAD:         $APP_VERSION   <- what is actually shipped, and what the sha below refers to" >&2
      echo "  working tree: $_tree_ver   <- uncommitted, NOT shipped" >&2
      echo "" >&2
      echo "  This is how a release that never existed got into the shared log on 2026-08-23. Either" >&2
      echo "  another session is mid-edit in this checkout, or you have not committed your bump yet." >&2
      echo "  Do NOT 'git add -A' to tidy it — that sweeps up the other session's work." >&2
      echo "" >&2
      echo "  If $APP_VERSION really is what shipped:  GX_ALLOW_DIRTY=1 ./deploy.sh" >&2
      echo "  If you know the right version outright:  GX_VERSION=vX.YYY ./deploy.sh" >&2
      [ "${GX_ALLOW_DIRTY:-}" = "1" ] || exit 1
      echo "GX_ALLOW_DIRTY=1 — recording HEAD's $APP_VERSION anyway." >&2
    fi
  else
    # Not a git repo, or no HEAD yet. Fall back to the tree, but never silently: the whole point of
    # reading HEAD is that the tree cannot be trusted, so a fallback to it has to be visible.
    APP_VERSION="$(_extract_version "$(cat index.html 2>/dev/null || true)")"
    VERSION_SOURCE="working tree (no HEAD to read — UNVERIFIED)"
    echo "deploy.sh: warning — could not read HEAD:index.html, falling back to the working tree." >&2
  fi
fi
# Never file a versionless release: the shared log is what every app reads for What's New, and a
# blank or bare-"v" entry there is worse than a failed deploy record you can see and fix.
if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" = "v" ]; then
  echo "deploy.sh: could not determine a version from index.html ($VERSION_SOURCE)." >&2
  echo "  Expected a ?v=NN cache-buster on a JS <script>, or an APP_VERSION/GC.VERSION constant." >&2
  echo "  Refusing to record a versionless release." >&2
  echo "  If you know the version, pass it: GX_VERSION=vX.YYY ./deploy.sh" >&2
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

# ── Recording the release: retry the two-hop miss, and NEVER exit 0 on a failure ──────────────
# THE BUG THIS FIXES. GX Core's /exec URL is a TWO-HOP redirect and the second hop intermittently
# serves Google's "Sorry, unable to open the file at this time" HTML page instead of our JSON —
# Google's content-delivery layer failing, not our doGet. Every frontend in the suite survives this
# by retrying (gx-client.js); this script did not. On 2026-08-26 it missed twice in a row while
# recording price-cards v1.422 and dumped ~200 lines of Drive HTML into the terminal.
#
# The dump was the visible half. The DANGEROUS half was the exit code: a bare `curl -sL` succeeds at
# fetching the HTML page, so the script exited 0 and printed nothing that read as an error. A shipper
# who does not read the wall of markup believes the release was recorded when version_history never
# got the row — and version_history is what every app reads for What's New. Silent, and in the same
# place the version-extraction bug was silent.
#
# WHY A RETRY IS SAFE HERE, stated rather than assumed. The miss is on the SECOND hop, so the request
# reached Apps Script and the write MAY ALREADY HAVE RUN: a retry re-runs it. That is only acceptable
# where re-running is a no-op. It is: gxRecordVersion keys its gxWrite_ on ['app','version'], so a
# replay UPSERTS the same row rather than appending a duplicate. The only thing that moves is
# deployed_at, by the length of one backoff. Do not copy this retry onto a route without checking the
# same thing — see the POST_RETRY rules in gx-client.js postJSON.
#
# The conditionals below are full if/fi rather than `[ x ] && echo …` purely for readability; both
# forms are safe under this script's `set -euo pipefail`, since bash exempts a failed left-hand
# operand of && from -e even as the last command of a loop body. Verified, because the opposite was
# assumed here first and the assumption was wrong.
_record_attempts=4
_resp=""
echo "Recording ${APP} ${APP_VERSION} (${SHA}) to GX Core…  [version from: ${VERSION_SOURCE}]"
for _n in $(seq 1 "$_record_attempts"); do
  if [ "$_n" -gt 1 ]; then sleep "$((_n - 1))"; fi    # linear backoff: 1s, 2s, 3s
  # --http1.1 for the same reason gxrepin.sh uses it; --max-time so a hung hop cannot park a ship.
  # `|| true` because -f is deliberately NOT used: the HTML page arrives with a cheerful 200, so the
  # status code is no help and the BODY SHAPE is the only tell there is.
  _resp="$(curl -sL --http1.1 --max-time 45 -G "$GXCORE" \
    --data-urlencode action=deploy_version --data-urlencode "secret=$SECRET" \
    --data-urlencode "app=$APP" --data-urlencode "version=$APP_VERSION" \
    --data-urlencode "sha=$SHA" --data-urlencode "notes=$GX_NOTES" 2>/dev/null || true)"
  case "$_resp" in
    '{'*|'['*) break ;;                      # JSON of any shape — GX Core answered, stop retrying
    *)
      if [ "$_n" -lt "$_record_attempts" ]; then
        echo "deploy.sh: GX Core returned no JSON (two-hop miss), retrying — attempt $((_n + 1))/${_record_attempts}…" >&2
      fi
      ;;
  esac
done

case "$_resp" in
  '{'*|'['*) ;;
  *)
    # ONE line about what happened, not the page itself. The HTML is what buried the last failure.
    echo "deploy.sh: FAILED to record ${APP} ${APP_VERSION} — GX Core never returned JSON in ${_record_attempts} tries." >&2
    if [ -z "$_resp" ]; then
      echo "  The response was empty (network, or --max-time hit)." >&2
    else
      echo "  Got $(printf '%s' "$_resp" | wc -c | tr -d ' ') bytes of non-JSON — almost certainly Google's Drive HTML page." >&2
    fi
    echo "  version_history has NO row for this release. The code shipped; only the record is missing." >&2
    echo "  Re-run to record it (safe to repeat — the row is keyed on app+version):" >&2
    echo "    GX_VERSION=${APP_VERSION} GX_NOTES='${GX_NOTES}' ./deploy.sh" >&2
    exit 1
    ;;
esac

# GX Core answered, but answering is not agreeing: a format refusal or a bad secret is well-formed
# JSON with ok:false, and exiting 0 on that would recreate the very bug above one layer up.
case "$_resp" in
  *'"ok":true'*|*'"ok": true'*) ;;
  *)
    echo "deploy.sh: GX Core REFUSED the release record for ${APP} ${APP_VERSION}." >&2
    echo "  $_resp" >&2
    exit 1
    ;;
esac

echo "Recorded ${APP} ${APP_VERSION} (${SHA}) to GX Core.  [version from: ${VERSION_SOURCE}]"
echo "  $_resp"
