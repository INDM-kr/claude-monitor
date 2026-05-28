#!/usr/bin/env bash
# Remove installed CLI + .app + web launcher + LaunchAgent if present.
# Project source remains untouched.

set -u

BIN_DEST="$HOME/bin/claude-monitor"
WEB_START_DEST="$HOME/bin/claude-monitor-web"
APP_DEST="$HOME/Applications/ClaudeMonitor.app"
LA_PLIST="$HOME/Library/LaunchAgents/com.indm.claude-monitor-web.plist"

if [[ -e "$LA_PLIST" ]]; then
  launchctl unload "$LA_PLIST" 2>/dev/null || true
  rm -f "$LA_PLIST"
  echo "✓ removed $LA_PLIST"
else
  echo "· not present: $LA_PLIST"
fi

for f in "$BIN_DEST" "$WEB_START_DEST"; do
  if [[ -e "$f" ]]; then
    rm -f "$f"
    echo "✓ removed $f"
  else
    echo "· not present: $f"
  fi
done

if [[ -e "$APP_DEST" ]]; then
  rm -rf "$APP_DEST"
  echo "✓ removed $APP_DEST"
else
  echo "· not present: $APP_DEST"
fi
