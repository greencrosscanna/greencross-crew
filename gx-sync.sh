#!/bin/sh
# ─── gx-sync — pull shared GX spoke files from the gx-theme source of truth ───────────────────────
# Source of truth:  https://github.com/greencrosscanna/greencross-gx-theme  (served via Pages)
# One-time setup per repo:
#     echo <gxkey> > .gx_app      # this app's GX Core key, e.g.  pricecards
#     curl -fsSL https://greencrosscanna.github.io/greencross-gx-theme/gx-sync.sh > gx-sync.sh
#     chmod +x gx-sync.sh
# Then, any time the shared files change upstream:   ./gx-sync.sh
# It fetches each canonical file and fills __APP__ from .gx_app, so the shared files stay identical
# across every spoke and the app key lives in exactly one place per repo.
set -eu

BASE="https://greencrosscanna.github.io/greencross-gx-theme"
[ -f .gx_app ] || { echo "✗ create .gx_app first (one line = this app's GX key, e.g. pricecards)"; exit 1; }
APP="$(tr -d ' \t\r\n' < .gx_app)"
[ -n "$APP" ] || { echo "✗ .gx_app is empty"; exit 1; }

# fetch <path-under-gx-theme> <local-dest> — copy + substitute __APP__, only on a good fetch
fetch() {
  tmp="$(mktemp)"
  if curl -fsSL "$BASE/$1" | sed "s/__APP__/$APP/g" > "$tmp" && [ -s "$tmp" ]; then
    mkdir -p "$(dirname "$2")"; mv "$tmp" "$2"; echo "  ✓ $2"
  else
    rm -f "$tmp"; echo "  ✗ $1 (skipped — fetch failed, left existing file untouched)"; return 1
  fi
}

echo "Syncing shared GX spoke files for app=$APP …"
fetch gx-brain-notes.sh .claude/gx-brain-notes.sh || true
fetch deploy.sh          deploy.sh                 || true
chmod +x .claude/gx-brain-notes.sh deploy.sh 2>/dev/null || true

# Ensure the SessionStart hook is wired — create a minimal settings.json, never clobber an existing one.
if [ ! -f .claude/settings.json ]; then
  mkdir -p .claude
  cat > .claude/settings.json <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "sh .claude/gx-brain-notes.sh" } ] }
    ]
  }
}
JSON
  echo "  ✓ .claude/settings.json (created)"
else
  echo "  • .claude/settings.json exists — leave it; ensure it runs 'sh .claude/gx-brain-notes.sh' on SessionStart"
fi
echo "Done. (gx-sync.sh itself is not self-updating — re-copy it from gx-theme if it changes.)"
