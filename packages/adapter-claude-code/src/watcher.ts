import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import {
  decodePath,
  shortenWorkspace,
  projectIdentityFromCwd,
  parentInfoFromSubagentPath,
} from "@claude-monitor/core";

export interface WatcherOptions {
  /** Absolute path to ~/.claude/projects (or test fixture root) */
  projectsDir: string;
}

const SESSION_FILE_RE = /\.jsonl$/i;
const AGENT_FILE_RE = /^agent-[^/]+\.jsonl$/i;

/**
 * Watches ~/.claude/projects/* for session files.
 *
 * Strategy:
 *   - chokidar watches the top-level projects dir at depth 2.
 *   - Each `*.jsonl` add/change/unlink emits a SessionRef-level event.
 *   - addDir picks up brand-new workspaces automatically.
 *
 * Uses chokidar (not fs.watch) for FSEvents burst stability on macOS.
 * Uses directory-level watch (not per-file) to avoid the ulimit risk with
 * 50+ session files.
 */
export class ProjectsWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  /** Dedicated watcher for discovered `<UUID>/subagents` subtrees — kept off
   *  the main depth:2 watch so we don't widen it over every project dir. */
  private subWatcher: FSWatcher | null = null;
  private readonly subDirs = new Set<string>();
  private readonly projectsDir: string;

  constructor(opts: WatcherOptions) {
    super();
    this.projectsDir = opts.projectsDir;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.projectsDir, {
      depth: 2,
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      ignored: (p) => isIgnoredWatchPath(this.projectsDir, p),
    });

    this.watcher.on("add", (path) => this.handleAdd(path));
    this.watcher.on("change", (path) => this.handleChange(path));
    this.watcher.on("unlink", (path) => this.handleUnlink(path));
    // FSWatcher is an EventEmitter — an unhandled "error" would otherwise
    // become an uncaught exception and crash the whole monitor.
    this.watcher.on("error", () => {});
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.subWatcher) {
      await this.subWatcher.close();
      this.subWatcher = null;
    }
    this.subDirs.clear();
  }

  emitEvent(event: AdapterEvent): void {
    this.emit("event", event);
  }

  on(event: "event", listener: (e: AdapterEvent) => void): this {
    return super.on(event, listener);
  }

  private async handleAdd(path: string): Promise<void> {
    if (!SESSION_FILE_RE.test(path)) return;
    const ref = await this.refFromPath(path);
    if (ref) this.emitEvent({ kind: "added", ref });
  }

  private async handleChange(path: string): Promise<void> {
    if (!SESSION_FILE_RE.test(path)) return;
    const ref = await this.refFromPath(path);
    if (ref) this.emitEvent({ kind: "changed", ref });
    // A top-level parent writing → it may have just spawned its first
    // sub-agents. Lazily start watching that subagents dir (cheap once known).
    if (ref && !ref.parentId) await this.maybeWatchSubagents(path);
  }

  private handleUnlink(path: string): void {
    if (!SESSION_FILE_RE.test(path)) return;
    const sub = parentInfoFromSubagentPath(this.projectsDir, path);
    const refId = sub ? sub.childId : sessionIdFromPath(path);
    if (refId) this.emitEvent({ kind: "removed", refId });
  }

  /** Initial scan — yields refs for everything currently on disk (top-level
   *  sessions plus their `<UUID>/subagents` child transcripts). */
  async *scan(): AsyncIterable<SessionRef> {
    const entries = await safeReaddir(this.projectsDir);
    for (const entry of entries) {
      const dir = join(this.projectsDir, entry);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = await safeReaddir(dir);
      for (const f of files) {
        const full = join(dir, f);
        if (SESSION_FILE_RE.test(f)) {
          const ref = await this.refFromPath(full);
          if (ref) yield ref;
          continue;
        }
        // A `<UUID>` dir may hold a `subagents/` folder of child transcripts.
        const subDir = join(full, "subagents");
        if ((await fs.stat(subDir).catch(() => null))?.isDirectory()) {
          this.ensureSubWatch(subDir);
          for await (const childRef of this.scanSubagents(subDir)) yield childRef;
        }
      }
    }
  }

  /** Recursively yield child refs under a `subagents` dir (direct layout and
   *  the nested `workflows/wf_<id>/` layout). */
  private async *scanSubagents(subDir: string): AsyncIterable<SessionRef> {
    const stack = [subDir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of await safeReaddir(cur)) {
        const full = join(cur, e);
        if (AGENT_FILE_RE.test(e)) {
          const ref = await this.refFromPath(full);
          if (ref) yield ref;
        } else if (!e.includes(".")) {
          if ((await fs.stat(full).catch(() => null))?.isDirectory()) stack.push(full);
        }
      }
    }
  }

  /** Start watching a subagents dir for live child add/change/unlink. Idempotent. */
  private ensureSubWatch(dir: string): void {
    if (this.subDirs.has(dir)) return;
    this.subDirs.add(dir);
    if (!this.subWatcher) {
      this.subWatcher = chokidar.watch(dir, {
        depth: 4, // subagents/ → workflows/ → wf_*/ → agent-*.jsonl
        persistent: true,
        ignoreInitial: true, // scan() already yielded existing files
        awaitWriteFinish: false,
        ignored: (p) => isIgnoredWatchPath(this.projectsDir, p),
      });
      this.subWatcher.on("add", (p) => this.handleAdd(p));
      this.subWatcher.on("change", (p) => this.handleChange(p));
      this.subWatcher.on("unlink", (p) => this.handleUnlink(p));
      // Same crash guard as the main watcher — see start().
      this.subWatcher.on("error", () => {});
    } else {
      this.subWatcher.add(dir);
    }
  }

  /** When a top-level session writes, pick up a freshly-created subagents dir. */
  private async maybeWatchSubagents(parentFilePath: string): Promise<void> {
    const uuid = sessionIdFromPath(parentFilePath);
    if (!uuid) return;
    const subDir = join(dirname(parentFilePath), uuid, "subagents");
    if (this.subDirs.has(subDir)) return;
    if (!(await fs.stat(subDir).catch(() => null))?.isDirectory()) return;
    this.ensureSubWatch(subDir);
    for await (const ref of this.scanSubagents(subDir)) this.emitEvent({ kind: "added", ref });
  }

  private async refFromPath(filePath: string): Promise<SessionRef | null> {
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) return null;
    const sub = parentInfoFromSubagentPath(this.projectsDir, filePath);
    const id = sub ? sub.childId : sessionIdFromPath(filePath);
    if (!id) return null;
    const workspaceEncoded = workspaceEncodedFromPath(filePath, this.projectsDir);
    const workspace = decodePath(workspaceEncoded);
    const provisional = projectIdentityFromCwd(workspace); // 임시 — reader가 cwd로 정정
    const ref: SessionRef = {
      id,
      adapterId: "claude-code",
      workspace,
      workspaceShort: shortenWorkspace(workspace) || workspace,
      projectKey: provisional.key,
      projectLabel: provisional.label,
      owner: provisional.owner,
      source: filePath,
      mtime: Math.floor(st.mtimeMs / 1000),
    };
    if (sub) {
      ref.parentId = sub.parentUuid;
      if (sub.wfId) ref.wfId = sub.wfId;
    }
    return ref;
  }
}

/**
 * chokidar passes ABSOLUTE paths to `ignored`. Judge hidden-ness by the segment
 * *relative to* projectsDir — otherwise a dot in an ancestor (e.g. the `.claude`
 * in `~/.claude/projects`) matches the whole tree and chokidar silently ignores
 * every session file (no live updates). Only hidden segments *inside* the
 * watched tree should be ignored.
 */
export function isIgnoredWatchPath(projectsDir: string, p: string): boolean {
  const rel = relative(projectsDir, p);
  if (rel === "" || rel.startsWith("..")) return false; // root / outside → never ignore
  return rel.split(sep).some((seg) => seg.startsWith("."));
}

function sessionIdFromPath(p: string): string | null {
  const m = p.match(/([^/]+)\.jsonl$/i);
  return m ? m[1]! : null;
}

function workspaceEncodedFromPath(filePath: string, projectsDir: string): string {
  const rel = filePath.startsWith(projectsDir)
    ? filePath.slice(projectsDir.length).replace(/^\/+/, "")
    : filePath;
  return rel.split("/")[0] ?? "";
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
