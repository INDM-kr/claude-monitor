#!/usr/bin/env bash
# Launch the claude-monitor Next.js web UI.
# Installed by scripts/install.sh — @@CM_REPO_ROOT@@ is replaced at install time.

set -eu

CM_REPO_ROOT="${CM_REPO_ROOT:-@@CM_REPO_ROOT@@}"
export HOSTNAME="${HOSTNAME:-127.0.0.1}"
export PORT="${PORT:-11314}"
export CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

if [ ! -d "$CM_REPO_ROOT" ]; then
  echo "error: CM_REPO_ROOT not found: $CM_REPO_ROOT" >&2
  exit 1
fi

cd "$CM_REPO_ROOT"
exec pnpm --filter @claude-monitor/web start
