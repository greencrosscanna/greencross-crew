#!/usr/bin/env bash
# ─── gxcrewstats — where GX Crew's request time goes, from the CLI ────────────────────────────────
#
#   ./gxcrewstats.sh            last 24 hours
#   ./gxcrewstats.sh 72         last 72 hours (the engine caps it at 336)
#   ./gxcrewstats.sh 6 --flush  also copy closed hours from the cache into their tab first
#
# READ-ONLY. Calls ?action=request_stats on Crew's own engine and nothing else. `--flush` adds
# flush=yes, which moves timing rows from the engine's cache to its `crew_request_stats` tab — the
# only thing this tool can ever cause to be written, and it is timing data, not HR or pay data.
#
# WHY THIS EXISTS
# Crew's engine has timed every request since v1.414: the route, the milliseconds, ok or failed, and
# inside approve/send how long each stage took. The only way to read it is a deploy-secret route, and
# the hub's secret guard lets only committed repo scripts use the secret. Without a committed caller
# the numbers exist and cannot be read — the same gap gxstats.sh closed for GX Core on 2026-09-14.
#
# WHAT IT PRINTS: route names, stage names, counts and milliseconds. The engine stores nothing else,
# and this prints nothing else EVEN IF THE ROUTE SENT IT: every name is checked against the shape a
# route or stage name has, and every figure is coerced to a whole number, before it reaches the
# screen. Crew holds PII and pay; a diagnostic that could echo a field somebody adds to that reply
# later is one nobody could run in front of a second person.
#
# Times are the ENGINE'S OWN execution, not what a browser waited: Google's /exec hop adds about two
# seconds on top, and more when it stalls. typical and p90 are bucket edges capped at the true max;
# count and max are exact.
#
# The secret handling is gxstats.sh's, deliberately and with its reasons: it rides on curl's stdin
# as a config file, never in argv, and every printed line is scrubbed of it as a backstop.
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

HOURS=24
FLUSH=""
for a in "$@"; do
  case "$a" in
    --flush) FLUSH="yes" ;;
    -*) echo "usage: ./gxcrewstats.sh [hours] [--flush]"; exit 1 ;;
    *) HOURS="$a" ;;
  esac
done
case "$HOURS" in
  ''|*[!0-9]*) echo "usage: ./gxcrewstats.sh [hours] [--flush]   (hours is a whole number)"; exit 1 ;;
esac

# THE ENGINE URL IS READ, NOT RETYPED. crew.js already carries it (ENGINE_URL_FALLBACK — the
# deployment gxengine.sh redeploys in place), so a second copy here would be one more place for a
# stale URL to live. It is checked for shape before the secret is sent anywhere near it.
ENGINE="$(python3 -c '
import re, sys
try:
    src = open("crew.js", encoding="utf-8").read()
except Exception:
    sys.exit(0)
m = re.search(r"ENGINE_URL_FALLBACK\s*=\s*[\x27\x22](https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec)[\x27\x22]", src)
print(m.group(1) if m else "")
' 2>/dev/null)"
[ -n "$ENGINE" ] || { echo "✗ could not read ENGINE_URL_FALLBACK from crew.js — run this from the greencross-crew repo"; exit 1; }

SECRET_FILE=".gx_deploy_secret"
[ -f "$SECRET_FILE" ] || { echo "✗ no $SECRET_FILE here — run this from the greencross-crew repo root (a worktree does not carry it)"; exit 1; }
SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
[ -n "$SECRET" ] || { echo "✗ $SECRET_FILE is empty"; exit 1; }

scrub() { GXCREWSTATS_SECRET="$SECRET" python3 -c '
import sys, os
sys.stdout.write(sys.stdin.read().replace(os.environ["GXCREWSTATS_SECRET"], "<secret>"))
' 2>/dev/null; }

# Growing timeouts, for the reason gxstats.sh has them: this route is served by the same /exec whose
# slowness it is being used to diagnose, and a flat ceiling gives up inside the stall. A reply that
# is not JSON is Google's bounce page, not an answer, and is retried.
resp=""
for t in 30 45 60 90; do
  if [ -n "$FLUSH" ]; then
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=request_stats" --data-urlencode "hours=$HOURS" \
                --data-urlencode "flush=yes" 2>/dev/null)"
  else
    resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
            | curl -K - --get --silent --location --max-time "$t" \
                --data-urlencode "action=request_stats" --data-urlencode "hours=$HOURS" 2>/dev/null)"
  fi
  case "$resp" in \{*) break ;; esac
  sleep 2
done
case "$resp" in
  \{*) ;;
  *) echo "✗ Crew's engine did not return JSON after 4 tries (the /exec hop stalls — re-run)"; exit 2 ;;
esac

# THE RENDERER. tests/crew_stats_tool_test.js lifts this block out of THIS file and runs it against
# fixture replies, so keep it a pure function of the JSON on stdin — and keep it free of single
# quotes, which would end the shell string it lives in.
printf '%s' "$resp" | python3 -c '
# gxcrewstats renderer
import sys, json, re

NAME = re.compile(r"^(?:\(unknown\)|[a-z_]{1,40})(?:\.[a-z]{1,12})?$")
STAGE = re.compile(r"^[a-z0-9_]{1,32}$")
HOUR = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}$")
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
STAGED = ["incentive_approve.dry", "incentive_approve.confirm", "incentive_send.send",
          "incentive_send.preview", "incentive"]

def num(v):
    # A whole number or nothing. A string, a list, a bool or a float with a story to tell is not a
    # duration, and is not printed.
    if isinstance(v, bool) or not isinstance(v, (int, float)): return None
    if v != v or v in (float("inf"), float("-inf")): return None
    return int(round(v))

def show(v, width):
    n = num(v)
    return ("%" + str(width) + "s") % ("-" if n is None else str(n))

def plain(v, limit):
    # For the two places free text can arrive (a refusal, a flush error): letters, digits and
    # ordinary punctuation only, and short. Anything else becomes a question mark.
    s = v if isinstance(v, str) else ""
    return re.sub(r"[^A-Za-z0-9 .,:;()_/-]", "?", s)[:limit]

try:
    d = json.loads(sys.stdin.read(), strict=False)
except Exception:
    print("x the reply was not JSON"); raise SystemExit(2)
if not isinstance(d, dict):
    print("x the reply was not a JSON object"); raise SystemExit(2)

if d.get("ok") is not True:
    err = d.get("error")
    if err == "bad deploy secret":
        print("x refused: bad deploy secret. Is .gx_deploy_secret the current one?")
    else:
        print("x refused by the engine: " + (plain(err, 160) or "no reason given"))
    raise SystemExit(1)

hours = num(d.get("hours")) or 0
rows = []
for a in (d.get("actions") or []):
    if not isinstance(a, dict): continue
    name = a.get("name")
    if not isinstance(name, str) or not NAME.match(name): continue
    count, avg = num(a.get("count")) or 0, num(a.get("avg_ms")) or 0
    rows.append((name, count, count * avg, a))
rows.sort(key=lambda r: (-r[2], r[0]))

fr, to = d.get("from_hour"), d.get("to_hour")
window = ""
if isinstance(fr, str) and isinstance(to, str) and HOUR.match(fr) and HOUR.match(to):
    window = " (%s to %s Pacific)" % (fr, to)

total_calls = sum(r[1] for r in rows)
total_ms = sum(r[2] for r in rows)
if not rows or not total_calls:
    print("GX Crew: no requests recorded in the last %d hour(s)%s." % (hours, window))
    print("  Nobody used the app in that window, or the hours asked for are older than the 6 the cache")
    print("  holds and the 15-minute trigger has not copied them to the tab. Try --flush, or fewer hours.")
else:
    print("GX Crew over the last %d hour(s)%s: %d requests, %.1f min of engine time" % (hours, window, total_calls, total_ms / 60000.0))
    print("")
    print("  %-28s %6s %6s %9s %9s %9s %9s" % ("route", "count", "failed", "typical", "p90 ms", "max ms", "total min"))
    for name, count, tot, a in rows:
        print("  %-28s %6d %s %s %s %s %9.1f" % (name[:28], count, show(a.get("failed"), 6), show(a.get("typical_ms"), 9),
                                             show(a.get("p90_ms"), 9), show(a.get("max_ms"), 9), tot / 60000.0))
    by = dict((r[0], r[3]) for r in rows)
    printed = False
    for name in STAGED:
        a = by.get(name)
        stages = a.get("stages") if a else None
        if not isinstance(stages, list) or not stages: continue
        if not printed:
            print("")
            print("Where the time went, by stage (avg and max are per request that reached the stage):")
            printed = True
        print("")
        print("  %s  (%d requests)" % (name, num(a.get("count")) or 0))
        print("    %-22s %6s %9s %9s %9s" % ("stage", "count", "avg ms", "max ms", "total s"))
        clean = []
        for s in stages:
            if not isinstance(s, dict): continue
            sn = s.get("stage")
            if not isinstance(sn, str) or not STAGE.match(sn): continue
            clean.append((sn, s, num(s.get("total_ms")) or 0))
        clean.sort(key=lambda x: (-x[2], x[0]))
        for sn, s, tot in clean:
            print("    %-22s %s %s %s %9.1f" % (sn, show(s.get("count"), 6), show(s.get("avg_ms"), 9), show(s.get("max_ms"), 9), tot / 1000.0))
        un = num(a.get("unattributed_avg_ms"))
        if un is not None:
            print("    %-22s %6s %9d" % ("(no stage claimed it)", "", un))
    if not printed:
        print("")
        print("No approve, send or incentive-screen requests with stages in this window.")

print("")
src = d.get("sources") if isinstance(d.get("sources"), dict) else {}
print("Read from: %s hour(s) in the tab, %s hour(s) still only in the cache." % (show(src.get("sheet_hours"), 1).strip(), show(src.get("cache_hours"), 1).strip()))
for label, key in (("Flush just now", "flush_now"), ("Last flush", "last_flush")):
    f = d.get(key)
    if not isinstance(f, dict): continue
    at = f.get("at") if isinstance(f.get("at"), str) and STAMP.match(f.get("at")) else "time unknown"
    if f.get("ok") is True:
        print("%s: ok, %s row(s) written (%s UTC)." % (label, show(f.get("rows"), 1).strip(), at))
    else:
        print("%s: FAILED (%s UTC): %s" % (label, at, plain(f.get("error"), 160) or "no reason given"))
for k in ("sheet_error", "cache_error"):
    if isinstance(d.get(k), str) and d.get(k):
        print("! %s: %s" % (k.replace("_", " "), plain(d.get(k), 160)))
print("typical and p90 are bucket edges capped at max. Times are the engine alone, not the /exec hop.")
' | scrub
exit "${PIPESTATUS[1]}"
