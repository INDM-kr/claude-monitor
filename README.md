# claude-monitor

Read-only dashboard for monitoring Claude Code (CCD) sessions across all projects on a single Mac. Scans `~/.claude/projects/*.jsonl` transcripts and groups by workspace, detects running sub-agents, and surfaces TodoWrite progress where present.

## What it shows

For every workspace under `~/.claude/projects/`:

- **Status** — `● LIVE` (transcript written in last 60s), `○ idle` (last 10m), `· stop` (older)
- **Last tool** invoked in the most recent assistant turn
- **Pending sub-agents** — `Task` / `Agent` tool calls without a matching `tool_result`
- **TodoWrite snapshot** — `n/m completed`, current in-progress item, next pending item
- **Last assistant message** — first 120 chars as context

ETA / time-remaining is intentionally not displayed: Claude does not write its own time estimates into the transcript, and synthesizing one would be a guess.

## Install

```bash
git clone <repo-url> ~/projects/claude-monitor
cd ~/projects/claude-monitor
bash scripts/install.sh
```

This copies:

- `bin/claude-monitor` → `~/bin/claude-monitor`
- `app/ClaudeMonitor.app` → `~/Applications/ClaudeMonitor.app`

Both are independent copies; re-run `scripts/install.sh` to push changes from the project to the installed locations.

### Dependencies

- macOS (uses `sips`, `iconutil`, `osacompile` from system; `Terminal.app`)
- `jq` (any version)
- `watch` (`brew install watch` if missing — only needed for the `.app` launcher)
- `rsvg-convert` (`brew install librsvg`) and ImageMagick (`brew install imagemagick`) — only needed to rebuild the icon from SVGs

## Usage

```bash
~/bin/claude-monitor                          # last 24h, all projects
~/bin/claude-monitor --all                    # include stopped sessions
~/bin/claude-monitor --max-age-hours 6        # cutoff 6h
~/bin/claude-monitor --filter '*indm-codegen*' # only matching project dirs
```

Continuous refresh:

```bash
watch -ct -n 3 ~/bin/claude-monitor
```

Or double-click `~/Applications/ClaudeMonitor.app` — opens a Terminal window running the above.

## Layout

```
bin/claude-monitor       Main shell script (bash 3.2 compatible, jq-driven)
app/
  build-app.sh           Rebuilds ClaudeMonitor.app from osacompile
  ClaudeMonitor.app/     Prebuilt launcher (committed)
icons/
  src/*.svg              Hand-written design sources (4 candidates)
  rendered/*.png         1024×1024 PNGs (rsvg-convert output)
  ClaudeMonitor.icns     Compiled multi-resolution icon
scripts/
  build-icon.sh          SVG → PNG → .icns → install into app
  install.sh             Copy bin + app to ~/bin and ~/Applications
  uninstall.sh           Remove installed copies (leaves project intact)
```

## How sessions are discovered

Each Claude Code workspace gets one directory under `~/.claude/projects/` named after the encoded `cwd`. Inside, each `<sessionId>.jsonl` is a single session's full transcript. The monitor:

1. Globs project dirs matching `--filter` (default `*`).
2. For each `.jsonl`, reads `stat -f %m` to get mtime → status bucket.
3. Streams the file through `jq` to extract: last `tool_use` name, pending sub-agent IDs (Task/Agent tool_use without matching tool_result in any user turn), last TodoWrite snapshot, last assistant text.

Read-only. Never modifies transcripts.

## Why no ETA

Claude doesn't self-estimate remaining time in the transcript. Computing one externally would require either guessing from token rates (noisy, model-dependent) or hardcoding heuristics that drift. TodoWrite `n/m completed` is shown when the running session uses it; that's the closest honest progress signal available.

## Rebuild icon

```bash
# Edit icons/src/04-dashboard.svg (or any other), then:
bash scripts/build-icon.sh 04-dashboard
```

This regenerates `icons/ClaudeMonitor.icns` and copies it into `app/ClaudeMonitor.app/Contents/Resources/applet.icns`. Re-run `scripts/install.sh` to push to `~/Applications`.

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes `~/bin/claude-monitor` and `~/Applications/ClaudeMonitor.app`. Does not touch the project source.
