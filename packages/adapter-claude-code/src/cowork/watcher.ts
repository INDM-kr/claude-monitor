import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import { COWORK_ADAPTER_ID, COWORK_DISPLAY } from "./constants.js";

export interface CoworkWatcherOptions {
  /** Absolute path to the cowork sessions root
   *  (`~/Library/Application Support/Claude/local-agent-mode-sessions`). */
  coworkDir: string;
}

const AUDIT_FILE = "audit.jsonl";
const LOCAL_PREFIX = "local_";

export interface CoworkRefParts {
  /** Conversation thread dir `<sid>`. */
  sid: string;
  /** Sub-grouping dir `<sub>`. */
  sub: string;
  /** Per-session id — the `<id>` of `local_<id>` (stable, path-derived). */
  id: string;
}

/**
 * Parse `<sid>/<sub>/local_<id>/audit.jsonl` (relative to `coworkDir`) into its
 * identity parts. Returns null for anything else — the strict 4-segment shape
 * excludes the `skills-plugin/` sibling and the per-session nested
 * `local_<id>/.claude/projects/…/<uuid>.jsonl` Desktop transcripts.
 */
export function coworkRefParts(coworkDir: string, filePath: string): CoworkRefParts | null {
  const rel = relative(coworkDir, filePath);
  if (!rel || rel.startsWith("..")) return null;
  const seg = rel.split(sep);
  if (seg.length !== 4) return null;
  if (seg[3] !== AUDIT_FILE) return null;
  if (!seg[2]!.startsWith(LOCAL_PREFIX)) return null;
  return { sid: seg[0]!, sub: seg[1]!, id: seg[2]!.slice(LOCAL_PREFIX.length) };
}

/** Ignore hidden segments inside the watched tree (the per-session `.claude/`
 *  subtree, `.audit-key`, `.DS_Store`). Judged relative to the root so a dot in
 *  an ancestor (`Application Support`) never ignores the whole tree. */
export function isIgnoredCoworkPath(coworkDir: string, p: string): boolean {
  const rel = relative(coworkDir, p);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(sep).some((s) => s.startsWith("."));
}

/** OS user from a `/Users/<name>/…` path (the cowork root lives under it);
 *  "unknown" otherwise. */
export function ownerFromPath(p: string): string {
  const m = p.match(/^\/Users\/([^/]+)(?:\/|$)/);
  return m ? m[1]! : "unknown";
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Watches the cowork sessions root for `local_<id>/audit.jsonl` files.
 * Flat (no sub-agent layout): every match is a top-level session whose project
 * group is `cowork:<sid>/<sub>`. Mirrors {@link ProjectsWatcher}'s chokidar /
 * directory-level strategy.
 */
export class CoworkWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly coworkDir: string;

  constructor(opts: CoworkWatcherOptions) {
    super();
    this.coworkDir = opts.coworkDir;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.coworkDir, {
      depth: 3, // <sid> → <sub> → local_<id> → audit.jsonl
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      ignored: (p) => isIgnoredCoworkPath(this.coworkDir, p),
    });
    // Swallow rejections from the async handlers so a transient stat error never
    // becomes an unhandledRejection that kills the watcher.
    this.watcher.on("add", (path) => void this.handle(path, "added").catch(() => {}));
    this.watcher.on("change", (path) => void this.handle(path, "changed").catch(() => {}));
    this.watcher.on("unlink", (path) => this.handleUnlink(path));
    // FSWatcher is an EventEmitter — an unhandled "error" (e.g. EACCES on the
    // TCC-protected ~/Library tree) would otherwise crash the whole monitor.
    this.watcher.on("error", () => {});
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

  /** Initial scan — yields a ref for every existing `local_<id>/audit.jsonl`. */
  async *scan(): AsyncIterable<SessionRef> {
    for (const sid of await safeReaddir(this.coworkDir)) {
      if (sid.startsWith(".")) continue;
      const sidDir = join(this.coworkDir, sid);
      if (!(await isDir(sidDir))) continue;
      for (const sub of await safeReaddir(sidDir)) {
        if (sub.startsWith(".")) continue;
        const subDir = join(sidDir, sub);
        if (!(await isDir(subDir))) continue;
        for (const local of await safeReaddir(subDir)) {
          if (!local.startsWith(LOCAL_PREFIX)) continue;
          const ref = await this.refFromPath(join(subDir, local, AUDIT_FILE));
          if (ref) yield ref;
        }
      }
    }
  }

  private async handle(path: string, kind: "added" | "changed"): Promise<void> {
    const ref = await this.refFromPath(path);
    if (ref) this.emitEvent({ kind, ref });
  }

  private handleUnlink(path: string): void {
    const parts = coworkRefParts(this.coworkDir, path);
    if (parts) this.emitEvent({ kind: "removed", refId: parts.id });
  }

  private async refFromPath(filePath: string): Promise<SessionRef | null> {
    const parts = coworkRefParts(this.coworkDir, filePath);
    if (!parts) return null;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) return null;
    return {
      id: parts.id,
      adapterId: COWORK_ADAPTER_ID,
      workspace: COWORK_DISPLAY,
      workspaceShort: COWORK_DISPLAY,
      projectKey: `cowork:${parts.sid}/${parts.sub}`,
      projectLabel: COWORK_DISPLAY,
      owner: ownerFromPath(this.coworkDir),
      source: filePath,
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  }
}

async function isDir(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => null))?.isDirectory() ?? false;
}
