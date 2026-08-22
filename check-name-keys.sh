#!/usr/bin/env bash
# ─── check-name-keys — do the stored name_keys still match the names on record? ──────────────────
#
#   sh ./check-name-keys.sh
#
# WHY
# nameToKey_ used to replace whitespace with underscores BEFORE trimming, so a padded cell
# ("  Sky Pinnick ") produced "_sky_pinnick_" rather than "sky_pinnick". name_key is what the whole
# suite joins a person on, and the failure is silent: no error, just a person detached from their own
# attributes, permits and wage. The function is fixed — but any key WRITTEN by the old path is still
# wrong and will never match the corrected one.
#
# READ-ONLY. It reports and repairs nothing.
#
# The deploy secret is read here and handed straight to curl, exactly as deploy.sh does. It is never
# printed, and nothing here echoes the request URL — a secret in a query string ends up in shell
# history and in Apps Script's execution log, so do not paste this call by hand with the value
# inlined.
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

SECRET_FILE=".gx_deploy_secret"
[ -f "$SECRET_FILE" ] || { echo "✗ no $SECRET_FILE here — this needs the deploy secret."; exit 1; }

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
# Resolve Crew's engine from GX Core config rather than hardcoding it — cfg.crewEngineUrl is the
# pattern Crew already uses, and it means a redeploy that mints a new /exec does not strand this.
ENGINE="$(curl -sL --max-time 15 "$GXCORE?action=config&key=cfg.crewEngineUrl" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); v=d.get('value') or ''
    print(v if d.get('ok') and str(v).startswith('https://') else '')
except Exception: print('')")"
[ -n "$ENGINE" ] || { echo "✗ could not resolve cfg.crewEngineUrl from GX Core."; exit 1; }

RESP="$(curl -sL --max-time 30 -G "$ENGINE" \
  --data-urlencode action=namekey_health \
  --data-urlencode "secret=$(tr -d '\r\n' < "$SECRET_FILE")" 2>/dev/null)"

printf '%s' "$RESP" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("✗ engine did not return JSON. First 200 chars:"); print(raw[:200])
    print("  (Apps Script serves consent HTML until the owner has authorized — run authorize() once.)")
    raise SystemExit(1)

if not d.get("ok"):
    err = str(d.get("error", "unknown error"))
    print("✗ " + err)
    # Name the actual cause. The first run of this said "bad secret" at an "unknown action" error,
    # which sends you to check a credential when the real answer is that the engine has not been
    # redeployed yet. A wrong hint costs more than no hint.
    if "unknown action" in err.lower():
        print("  The engine is running an older deployment. Redeploy it:  ./gxengine.sh --deploy")
    elif "secret" in err.lower():
        print("  The local .gx_deploy_secret does not match GX_DEPLOY_SECRET on the engine.")
    raise SystemExit(1)

print("checked %d roster rows\n" % d.get("checked", 0))
def show(key, title, note):
    rows = d.get(key) or []
    if not rows:
        print("  ✓ %s: none" % title); return 0
    print("  ✗ %s: %d" % (title, len(rows)))
    print("      %s" % note)
    for r in rows:
        if "employee_ids" in r:
            print("      %-24s shared by %s" % (r.get("name_key",""), ", ".join(r["employee_ids"])))
        else:
            print("      %-22s stored=%-24s expected=%s" % (r.get("employee_id",""), r.get("stored","(blank)"), r.get("expected","")))
    return len(rows)

bad  = show("padded_underscore", "leading/trailing underscore", "written by the pre-fix nameToKey_ — these will not match the corrected key")
bad += show("mismatched",        "disagree with full_name",     "the stored key is not what the name on record produces")
bad += show("blank_name_key",    "blank name_key",              "no join key at all")
bad += show("duplicate_name_key","duplicate name_key",          "two people sharing one join key")

print()
if bad == 0:
    print("All stored name_keys match the names on record. Nothing to repair.")
else:
    print("%d row(s) need attention. This script changes nothing — repair deliberately." % bad)
    print("Re-saving a person through the roster rewrites name_key from their full_name.")
    raise SystemExit(1)
'
