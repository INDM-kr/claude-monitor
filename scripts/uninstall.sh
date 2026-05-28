#!/usr/bin/env bash
# Remove installed copies. Project source remains untouched.

set -u

BIN_DEST="$HOME/bin/claude-monitor"
APP_DEST="$HOME/Applications/ClaudeMonitor.app"

if [[ -e "$BIN_DEST" ]]; then
  rm -f "$BIN_DEST"
  echo "✓ removed $BIN_DEST"
else
  echo "· not present: $BIN_DEST"
fi

if [[ -e "$APP_DEST" ]]; then
  rm -rf "$APP_DEST"
  echo "✓ removed $APP_DEST"
else
  echo "· not present: $APP_DEST"
fi
