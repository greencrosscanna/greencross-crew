#!/usr/bin/env bash
# Compare the two incentive engines for one pay period, before flipping cfg.incentiveEngine.
#
#   ./compare-incentive.sh 2026-08-17      one period
#   ./compare-incentive.sh                 the period running today
#
# Runs BOTH engines and reports where they disagree. Prints names only where it must and never a
# per-person salary — deltas only. Safe to run any time; it writes nothing.
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

PP="${1:-}"
SECRET_FILE="../greencross-command-center/.gx_deploy_secret"
[ -f "$SECRET_FILE" ] || { echo "no deploy secret at $SECRET_FILE" >&2; exit 1; }
SECRET="$(cat "$SECRET_FILE")"
CREW="https://script.google.com/macros/s/AKfycbxco5dVO8mV-KpIKYpPKfjTa1bpSZFjrjVgJfbYjNNnkR3GujP8LtkgiFs0Z124gLPL/exec"

# The /exec second hop 404s on ~6% of rapid calls, and a warm instance can serve the previous
# deployment for a minute after a ship — so retry rather than trusting one answer.
for i in $(seq 1 15); do
  RESP="$(curl -sL --max-time 300 --get "$CREW" \
      --data-urlencode "action=incentive_compare" \
      --data-urlencode "pp_start=$PP" \
      --data-urlencode "secret=$SECRET")"
  case "$RESP" in
    \{*) break ;;
  esac
  sleep 1
done

printf '%s' "$RESP" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("could not read a response — try again"); raise SystemExit(1)
if not d.get("ok"):
    print("FAILED (%s): %s" % (d.get("stage","?"), d.get("error")))
    raise SystemExit(1)
t = d["totals"]; p = d["people"]
print("period            %s .. %s" % (d["pp_start"], d["pp_end"]))
print()
print("  Leaderboard     %12.2f" % t["leaderboard"])
print("  GX Core         %12.2f" % t["gxcore"])
pct = (100.0*t["delta"]/t["leaderboard"]) if t["leaderboard"] else 0.0
print("  difference      %12.2f   (%+.3f%%)" % (t["delta"], pct))
print()
print("  people on both sides   %d" % p["in_both"])
print("  only in Leaderboard    %s" % (p["only_leaderboard"] or "none"))
print("  only in GX Core        %s" % (p["only_gxcore"] or "none"))
print("  people whose number moves %d" % d["differing_people"])
if d.get("largest_deltas"):
    print("  largest moves: %s" % ", ".join("%+.2f" % x["delta"] for x in d["largest_deltas"][:8]))
print()
print("  returns GX Core ignored (sale in an earlier period): %s" % d.get("gxcore_ignored_returns"))
print()
# STRUCTURE BEFORE NUMBERS. A field Leaderboard sends and GX Core does not is a feature that
# disappears on the flip — it never shows up as a delta, it shows up as nothing at all.
miss = d.get("fields_missing_in_gxcore") or []
print("  fields Leaderboard sends that GX Core does NOT: %s" % (", ".join(miss) if miss else "none"))
ar = d.get("admin_row") or {}
print("  admin row     leaderboard=%s  gxcore=%s  names match=%s"
      % (ar.get("leaderboard"), ar.get("gxcore"), ar.get("names_match")))
sh = d.get("shape") or {}
for k in ("admin", "payPeriod"):
    v = sh.get(k) or {}
    lbf, gxf = v.get("leaderboard") or [], v.get("gxcore") or []
    gap = [x for x in lbf if x not in gxf]
    print("  %-10s sub-fields missing in GX Core: %s" % (k, ", ".join(gap) if gap else "none"))
if miss or not ar.get("gxcore"):
    print()
    print("  *** DO NOT FLIP — something Leaderboard provides is missing on the GX Core side. ***")
print()
print("WHAT SHOULD DIFFER: voids Leaderboard counts, and returns it deducts that were sold in an")
print("earlier period. Anything ELSE, or a person missing from one side, is worth stopping for.")
'
