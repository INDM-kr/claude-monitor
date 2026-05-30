# claude-monitor

Dashboard for monitoring Claude Code (CCD) sessions across all projects on a single Mac. Scans `~/.claude/projects/*.jsonl` transcripts, **unifies a project's worktrees into one collapsible group**, detects running sub-agents, and surfaces TodoWrite progress where present. Read-only **except** for one action: the web UI can **kill** a running local session (see [Web UI](#web-ui)).

## What it shows

Sessions are grouped by **project** (Conductor worktrees and `.worktrees/` siblings of the same repo collapse into a single group, derived from each session's real `cwd` — not the lossy encoded directory name). Each group is collapsible (state persists in `localStorage`).

Per session:

- **Status** — `● LIVE` (transcript written in last 60s), `○ idle` (last 10m), `· stop` (older)
- **Runner** — badge for `Conductor` / `Claude Code` / `Claude Desktop` (classified from the live process; absent if the process isn't found)
- **Model · mode** — e.g. `claude-opus-4-8 · acceptEdits` (model from the transcript, mode = `permissionMode`)
- **Context %** — approximate context-window occupancy (last assistant turn's input + cache tokens ÷ model limit; the `[1m]` 1M window is detected from the running process args, else a 200k default)
- **Last tool** invoked in the most recent assistant turn
- **Pending sub-agents** — `Task` / `Agent` tool calls without a matching `tool_result`
- **TodoWrite snapshot** — `n/m completed`, current in-progress item, next pending item
- **Last assistant message** — first 120 chars as context
- **Kill** — terminates the session's local process (only shown when the process is found; web UI only)

Click a session to open its **detail page**: full last message, full todo list, all pending sub-agents, source path, runner/model/mode/version, and a **context-usage trend** sparkline.

ETA / time-remaining is intentionally not displayed: Claude does not write its own time estimates into the transcript, and synthesizing one would be a guess.

## Install

```bash
git clone <repo-url> ~/projects/claude-monitor
cd ~/projects/claude-monitor
bash scripts/install.sh                       # CLI + Web UI
SKIP_WEB=1 bash scripts/install.sh            # CLI only
WITH_LAUNCHAGENT=1 bash scripts/install.sh    # also auto-start web UI at login
```

This copies:

- `bin/claude-monitor` → `~/bin/claude-monitor`
- `app/ClaudeMonitor.app` → `~/Applications/ClaudeMonitor.app`
- `scripts/start-web.sh` → `~/bin/claude-monitor-web` (when web UI is installed)

Re-run `scripts/install.sh` to push project changes to the installed copies.

### Dependencies

- macOS (uses `sips`, `iconutil`, `osacompile` from system; `Terminal.app`)
- `jq` (any version)
- `watch` (`brew install watch` if missing — only needed for the `.app` launcher)
- `rsvg-convert` (`brew install librsvg`) and ImageMagick (`brew install imagemagick`) — only needed to rebuild the icon from SVGs
- For the web UI: Node 18+ and `pnpm` 8+ (`brew install node pnpm` or `corepack enable`)

## Web UI

```bash
~/bin/claude-monitor-web                      # starts Next.js server on 127.0.0.1:11314
open http://127.0.0.1:11314
```

The Next.js server binds to `127.0.0.1` by default — LAN access is blocked. Set `HOSTNAME=0.0.0.0` to expose it on your LAN, but pair that with `CM_BEARER_TOKEN` for auth:

```bash
CM_BEARER_TOKEN=$(openssl rand -hex 32) ~/bin/claude-monitor-web
# clients must send: Authorization: Bearer <token>
```

### Killing sessions (the one write action)

The **Kill** button (and `POST /api/sessions/[id]/kill`) terminates a session's local process with `SIGTERM`. It resolves the PID by scanning `ps` for the process whose args carry that session's `--resume`/`--session-id <uuid>`, and **re-verifies the PID's command line still belongs to that session immediately before signalling** (TOCTOU guard) so an unrelated/recycled process is never killed. Only **local** sessions on this machine are killable; the button is hidden when no matching process is found.

Because this is a write action, keep the server on the default `127.0.0.1` bind. If you expose it to a LAN (`HOSTNAME=0.0.0.0`), **set `CM_BEARER_TOKEN`** — kill (and every API/page request) is then rejected without a valid `Authorization: Bearer` header.

> **Known limitation:** when `CM_BEARER_TOKEN` is set, the browser UI cannot attach the token to its own requests (page navigation, the SSE stream, and the kill `fetch` all lack a way to send custom auth headers). So with a token set, the web UI's live updates and kill button stop working from the browser — they fail **closed** (blocked, never an unauthenticated kill). The token mode is meant for headless/programmatic clients that send the header themselves; for interactive local use, leave `CM_BEARER_TOKEN` unset (the `127.0.0.1` bind is the boundary).

Tunables (all optional):

| env | default | meaning |
|---|---|---|
| `HOSTNAME` | `127.0.0.1` | bind address |
| `PORT` | `11314` | listening port |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | source directory |
| `CM_ACTIVE_THRESHOLD_SEC` | `60` | < this → LIVE |
| `CM_RECENT_THRESHOLD_SEC` | `600` | < this → idle |
| `CM_MAX_AGE_HOURS` | `24` | default cutoff for `/?` and `/api/sessions` |
| `CM_BEARER_TOKEN` | _(unset)_ | when set, all API + page requests require `Authorization: Bearer <token>` |

The web UI is a separate codepath from the CLI — both exist side-by-side. The CLI stays for SSH/headless use and as a fallback when the web server is down.

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
  install.sh             Copy bin + app to ~/bin and ~/Applications; build web UI
  start-web.sh           Web UI launcher (installed as ~/bin/claude-monitor-web)
  uninstall.sh           Remove installed copies (leaves project intact)
packages/
  core/                  Shared types, util, adapter & widget registries
  adapter-claude-code/   JSONL parser, incremental tail reader, chokidar watcher
  web/                   Next.js 14 App Router dashboard + SSE
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
