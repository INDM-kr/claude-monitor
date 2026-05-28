#!/usr/bin/env bash
# Install bin/claude-monitor + app/ClaudeMonitor.app to ~/bin and ~/Applications.
# Also (optionally) sets up the web UI: builds the Next.js app and installs a
# start script + LaunchAgent.  Idempotent: safe to re-run.

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DEST="$HOME/bin/claude-monitor"
WEB_START_DEST="$HOME/bin/claude-monitor-web"
APP_DEST="$HOME/Applications/ClaudeMonitor.app"

SKIP_WEB="${SKIP_WEB:-0}"
WITH_LAUNCHAGENT="${WITH_LAUNCHAGENT:-0}"

mkdir -p "$HOME/bin" "$HOME/Applications"

echo "→ copy $ROOT/bin/claude-monitor → $BIN_DEST"
cp "$ROOT/bin/claude-monitor" "$BIN_DEST"
chmod +x "$BIN_DEST"

echo "→ copy $ROOT/app/ClaudeMonitor.app → $APP_DEST"
rm -rf "$APP_DEST"
cp -R "$ROOT/app/ClaudeMonitor.app" "$APP_DEST"
touch "$APP_DEST"
mdimport "$APP_DEST" 2>/dev/null || true

if [ "$SKIP_WEB" = "1" ]; then
  echo
  echo "✓ installed (CLI only — SKIP_WEB=1)"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "⚠ node not found — skipping web UI (set SKIP_WEB=1 to silence)"
  exit 0
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "⚠ pnpm not found — skipping web UI (install pnpm or set SKIP_WEB=1)"
  exit 0
fi

echo "→ install web deps + build (pnpm)"
( cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null )
( cd "$ROOT" && pnpm --filter @claude-monitor/core build >/dev/null )
( cd "$ROOT" && pnpm --filter @claude-monitor/adapter-claude-code build >/dev/null )
( cd "$ROOT" && pnpm --filter @claude-monitor/web build >/dev/null )

echo "→ install $WEB_START_DEST"
install -m 0755 "$ROOT/scripts/start-web.sh" "$WEB_START_DEST"
# Bake repo root into the launcher (sed in-place, macOS-compatible).
sed -i '' "s|@@CM_REPO_ROOT@@|$ROOT|g" "$WEB_START_DEST"

if [ "$WITH_LAUNCHAGENT" = "1" ]; then
  LA_DIR="$HOME/Library/LaunchAgents"
  LA_PLIST="$LA_DIR/com.indm.claude-monitor-web.plist"
  mkdir -p "$LA_DIR"
  cat > "$LA_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.indm.claude-monitor-web</string>
  <key>ProgramArguments</key>
  <array>
    <string>$WEB_START_DEST</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/claude-monitor-web.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/claude-monitor-web.log</string>
</dict>
</plist>
EOF
  launchctl unload "$LA_PLIST" 2>/dev/null || true
  launchctl load "$LA_PLIST"
  echo "→ LaunchAgent loaded ($LA_PLIST)"
fi

echo
echo "✓ installed"
echo "  CLI:        $BIN_DEST"
echo "  App:        $APP_DEST"
echo "  Web:        $WEB_START_DEST"
echo "  URL:        http://127.0.0.1:11314"
echo
echo "Run \`$WEB_START_DEST\` to launch the web UI (Ctrl+C to stop)."
[ "$WITH_LAUNCHAGENT" = "1" ] && echo "LaunchAgent active — web UI starts at login."
