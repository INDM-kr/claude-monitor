#!/usr/bin/env bash
# Rebuild ClaudeMonitor.app from scratch using osacompile.
# Useful if you change the launch command or need a clean bundle.
# After running, re-run scripts/build-icon.sh to put the icon back.

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app/ClaudeMonitor.app"

rm -rf "$APP"

osacompile -o "$APP" -e 'tell application "Terminal"
  activate
  do script "clear; watch -ct -n 3 $HOME/bin/claude-monitor"
end tell'

echo "✓ built $APP"
echo "  next: bash scripts/build-icon.sh   (to restore icon)"
