#!/usr/bin/env bash
# Install bin/claude-monitor + app/ClaudeMonitor.app to ~/bin and ~/Applications.
# Idempotent: safe to re-run after edits.

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DEST="$HOME/bin/claude-monitor"
APP_DEST="$HOME/Applications/ClaudeMonitor.app"

mkdir -p "$HOME/bin" "$HOME/Applications"

echo "→ copy $ROOT/bin/claude-monitor → $BIN_DEST"
cp "$ROOT/bin/claude-monitor" "$BIN_DEST"
chmod +x "$BIN_DEST"

echo "→ copy $ROOT/app/ClaudeMonitor.app → $APP_DEST"
rm -rf "$APP_DEST"
cp -R "$ROOT/app/ClaudeMonitor.app" "$APP_DEST"
touch "$APP_DEST"  # invalidate Finder cache

# Force-refresh Spotlight
mdimport "$APP_DEST" 2>/dev/null || true

echo
echo "✓ installed"
echo "  CLI:    $BIN_DEST"
echo "  App:    $APP_DEST"
echo
echo "Drag $APP_DEST to Dock for one-click launch."
