#!/usr/bin/env bash
# Build icons/ClaudeMonitor.icns from an SVG source, then install it
# into app/ClaudeMonitor.app/Contents/Resources/applet.icns.
#
# Usage: bash scripts/build-icon.sh [variant]
#   variant defaults to "04-dashboard" — must match a file in icons/src/<variant>.svg

set -eu

VARIANT="${1:-04-dashboard}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_SVG="$ROOT/icons/src/$VARIANT.svg"
RENDERED_PNG="$ROOT/icons/rendered/$VARIANT.png"
ICNS_OUT="$ROOT/icons/ClaudeMonitor.icns"
APP_ICON="$ROOT/app/ClaudeMonitor.app/Contents/Resources/applet.icns"

[[ -f "$SRC_SVG" ]] || { echo "missing: $SRC_SVG" >&2; exit 1; }
command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)" >&2; exit 1; }
command -v sips >/dev/null         || { echo "need sips (macOS)" >&2; exit 1; }
command -v iconutil >/dev/null     || { echo "need iconutil (macOS)" >&2; exit 1; }

echo "→ render SVG → 1024 PNG"
rsvg-convert -w 1024 -h 1024 "$SRC_SVG" -o "$RENDERED_PNG"

echo "→ build .iconset"
ICONSET="$(mktemp -d)/ClaudeMonitor.iconset"
mkdir -p "$ICONSET"
sips -z 16 16     "$RENDERED_PNG" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$RENDERED_PNG" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$RENDERED_PNG" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$RENDERED_PNG" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$RENDERED_PNG" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$RENDERED_PNG" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$RENDERED_PNG" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$RENDERED_PNG" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$RENDERED_PNG" --out "$ICONSET/icon_512x512.png"    >/dev/null
cp "$RENDERED_PNG" "$ICONSET/icon_512x512@2x.png"

echo "→ compile .icns"
iconutil -c icns "$ICONSET" -o "$ICNS_OUT"

if [[ -d "$ROOT/app/ClaudeMonitor.app/Contents/Resources" ]]; then
  cp "$ICNS_OUT" "$APP_ICON"
  touch "$ROOT/app/ClaudeMonitor.app"
  echo "→ installed into app/ClaudeMonitor.app"
fi

echo
echo "✓ done: $ICNS_OUT"
echo "  re-run scripts/install.sh to push to ~/Applications"
