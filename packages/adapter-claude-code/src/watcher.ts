import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import { decodePath, shortenWorkspace } from "@claude-monitor/core";

export interface WatcherOptions {
  /** Absolute path to ~/.claude/projects (or test fixture root) */
  projectsDir: string;
}

const SESSION_FILE_RE = /\.jsonl$/i;

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
      ignored: (p) => /(^|\/)\.[^/]/.test(p),
    });

    this.watcher.on("add", (path) => this.handleAdd(path));
    this.watcher.on("change", (path) => this.handleChange(path));
    this.watcher.on("unlink", (path) => this.handleUnlink(path));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
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
  }

  private handleUnlink(path: string): void {
    if (!SESSION_FILE_RE.test(path)) return;
    const refId = sessionIdFromPath(path);
    if (refId) this.emitEvent({ kind: "removed", refId });
  }

  /** Initial scan — yields refs for everything currently on disk. */
  async *scan(): AsyncIterable<SessionRef> {
    const entries = await safeReaddir(this.projectsDir);
    for (const entry of entries) {
      const dir = join(this.projectsDir, entry);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = await safeReaddir(dir);
      for (const f of files) {
        if (!SESSION_FILE_RE.test(f)) continue;
        const ref = await this.refFromPath(join(dir, f));
        if (ref) yield ref;
      }
    }
  }

  private async refFromPath(filePath: string): Promise<SessionRef | null> {
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) return null;
    const id = sessionIdFromPath(filePath);
    if (!id) return null;
    const workspaceEncoded = workspaceEncodedFromPath(filePath, this.projectsDir);
    const workspace = decodePath(workspaceEncoded);
    return {
      id,
      adapterId: "claude-code",
      workspace,
      workspaceShort: shortenWorkspace(workspace) || workspace,
      source: filePath,
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  }
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
