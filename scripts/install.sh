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

# Validate before modifying installed launchers or app bundles.
if [ "$SKIP_WEB" != "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "error: Node is required for web installation; use SKIP_WEB=1 for CLI only" >&2
    exit 1
  fi
  node "$ROOT/scripts/check-runtime.mjs"
fi

mkdir -p "$HOME/bin" "$HOME/Applications"

echo "→ copy $ROOT/bin/claude-monitor → $BIN_DEST"
cp "$ROOT/bin/claude-monitor" "$BIN_DEST"
chmod +x "$BIN_DEST"

# Make `claude-monitor` runnable as a bare command. ~/bin is frequently not on
# PATH; prefer a symlink into a dir that already is (works in a new shell with no
# rc edit), else append ~/bin to the shell rc. Never silent — always reports.
if ! command -v claude-monitor >/dev/null 2>&1; then
  linked=""
  for d in "$HOME/.local/bin" "/usr/local/bin"; do
    case ":$PATH:" in
      *":$d:"*)
        if [ -d "$d" ] || mkdir -p "$d" 2>/dev/null; then
          if ln -sf "$BIN_DEST" "$d/claude-monitor" 2>/dev/null; then linked="$d/claude-monitor"; break; fi
        fi ;;
    esac
  done
  if [ -n "$linked" ]; then
    echo "→ linked $linked → $BIN_DEST  (claude-monitor now on PATH)"
  else
    case "${SHELL:-}" in
      *zsh)  rc="$HOME/.zshrc" ;;
      *bash) rc="$HOME/.bashrc" ;;
      *)     rc="$HOME/.profile" ;;
    esac
    mark="# added by claude-monitor install.sh"
    if ! grep -qF "$mark" "$rc" 2>/dev/null; then
      printf '\n%s\nexport PATH="$HOME/bin:$PATH"\n' "$mark" >> "$rc"
      echo "→ added ~/bin to PATH in $rc  — restart your shell or run: source $rc"
    else
      echo "→ ~/bin PATH entry already present in $rc  — restart your shell if claude-monitor isn't found"
    fi
  fi
else
  echo "→ claude-monitor already resolvable on PATH"
fi

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

echo "→ install web deps + build (pnpm)"
( cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null )
( cd "$ROOT" && pnpm build >/dev/null )

echo "→ install $WEB_START_DEST"
install -m 0755 "$ROOT/scripts/start-web.sh" "$WEB_START_DEST"
# Bake repo root into the launcher (sed in-place, macOS-compatible).
sed -i '' "s|@@CM_REPO_ROOT@@|$ROOT|g" "$WEB_START_DEST"

if [ "$WITH_LAUNCHAGENT" = "1" ]; then
  LA_DIR="$HOME/Library/LaunchAgents"
  LA_PLIST="$LA_DIR/com.indm.claude-monitor-web.plist"
  # launchd does not read shell rc files; its default PATH is only the system dirs below, so a
  # version-managed node/pnpm (nvm, fnm, ...) is invisible to the launcher. Record the node/pnpm
  # that passed check-runtime above. Re-run this installer after switching Node versions.
  LAUNCHD_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "error: pnpm is required for the LaunchAgent; see README runtime requirements" >&2
    exit 1
  fi
  NODE_DIR="$(dirname "$(command -v node)")"
  PNPM_DIR="$(dirname "$(command -v pnpm)")"
  LA_PATH="$NODE_DIR"
  [ "$PNPM_DIR" = "$NODE_DIR" ] || LA_PATH="$LA_PATH:$PNPM_DIR"
  LA_PATH="$LA_PATH:$LAUNCHD_SYSTEM_PATH"
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
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$LA_PATH</string></dict>
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
if [ "$WITH_LAUNCHAGENT" = "1" ]; then
  echo "LaunchAgent active — web UI starts at login."
fi
