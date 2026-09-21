import { EventEmitter } from "node:events";
import { promises as fs, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import { projectIdentityFromCwd, shortenWorkspace } from "@claude-monitor/core";
import { CODEX_ADAPTER_ID } from "./constants.js";
import { codexSessionIdFromPath, parseCodexMeta, type CodexMeta } from "./meta.js";

export interface CodexWatcherOptions {
  /** Absolute path to the Codex rollout root (`~/.codex/sessions`). */
  codexDir: string;
}

const LF = 0x0a;
const CHUNK = 64 * 1024;
/** `<codexDir>/YYYY/MM/DD/rollout-*.jsonl` — segments below the root. */
const ROLLOUT_DEPTH = 4;
/** The first line holds `base_instructions` (the whole system prompt) — tens
 *  of KB is normal; anything past this is not a rollout file. */
const FIRST_LINE_MAX = 8 * 1024 * 1024;

/** Read the first `\n`-terminated line of a file (without the newline). Null
 *  when the file has no complete first line yet (still being created) or the
 *  first line exceeds `maxBytes`. */
export async function readFirstLine(path: string, maxBytes = FIRST_LINE_MAX): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let pos = 0;
    while (pos < maxBytes) {
      const buf = Buffer.alloc(Math.min(CHUNK, maxBytes - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const view = buf.subarray(0, bytesRead);
      const nl = view.indexOf(LF);
      if (nl !== -1) {
        chunks.push(Buffer.from(view.subarray(0, nl)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(view));
      pos += bytesRead;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Ignore hidden segments inside the watched tree (`.DS_Store`…), judged
 *  relative to the root so the `.codex` ancestor never ignores everything. */
export function isIgnoredCodexPath(codexDir: string, p: string): boolean {
  const rel = relative(codexDir, p);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(sep).some((s) => s.startsWith("."));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function statOrNull(p: string): Promise<Stats | null> {
  return fs.stat(p).catch(() => null);
}

/**
 * Watches `<codexDir>/YYYY/MM/DD/rollout-*.jsonl`. Every rollout file is one
 * session; identity (cwd, parent thread) comes from its first line, so a file
 * whose first line is not complete yet is skipped until its next change event.
 * Codex-internal threads (guardian reviews) are never emitted.
 */
export class CodexWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly codexDir: string;
  /** First-line identity per file. The first line never changes once written,
   *  so it is parsed once (Codex appends many records per turn; re-reading a
   *  multi-KB first line on every change is wasted I/O). `null` remembers a
   *  hidden thread. Not-yet-complete first lines are not cached. */
  private readonly metaByPath = new Map<string, CodexMeta | null>();

  constructor(opts: CodexWatcherOptions) {
    super();
    this.codexDir = opts.codexDir;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.codexDir, {
      depth: 3, // YYYY → MM → DD → rollout-*.jsonl
      persistent: true,
      ignoreInitial: true, // scan() yields existing files; a second `add` per file would double the startup fan-out
      awaitWriteFinish: false,
      ignored: (p) => isIgnoredCodexPath(this.codexDir, p),
    });
    this.watcher.on("add", (path) => void this.handle(path, "added").catch(() => {}));
    this.watcher.on("change", (path) => void this.handle(path, "changed").catch(() => {}));
    this.watcher.on("unlink", (path) => this.handleUnlink(path));
    // An unhandled FSWatcher "error" would crash the whole monitor.
    this.watcher.on("error", () => {});
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.metaByPath.clear();
  }

  /** A rollout file at exactly `YYYY/MM/DD/rollout-*.jsonl` below the root
   *  (the same shape scan() walks — chokidar's depth bound alone would also
   *  accept a rollout-named file one or two levels up). */
  private isRolloutPath(p: string): boolean {
    const rel = relative(this.codexDir, p);
    if (!rel || rel.startsWith("..")) return false;
    return rel.split(sep).length === ROLLOUT_DEPTH && codexSessionIdFromPath(p) != null;
  }

  emitEvent(event: AdapterEvent): void {
    this.emit("event", event);
  }

  on(event: "event", listener: (e: AdapterEvent) => void): this {
    return super.on(event, listener);
  }

  /** Initial scan — every rollout file under YYYY/MM/DD. */
  async *scan(): AsyncIterable<SessionRef> {
    for (const y of await safeReaddir(this.codexDir)) {
      if (y.startsWith(".")) continue;
      const yDir = join(this.codexDir, y);
      if (!(await statOrNull(yDir))?.isDirectory()) continue;
      for (const m of await safeReaddir(yDir)) {
        if (m.startsWith(".")) continue;
        const mDir = join(yDir, m);
        if (!(await statOrNull(mDir))?.isDirectory()) continue;
        for (const d of await safeReaddir(mDir)) {
          if (d.startsWith(".")) continue;
          const dDir = join(mDir, d);
          if (!(await statOrNull(dDir))?.isDirectory()) continue;
          for (const f of await safeReaddir(dDir)) {
            if (!codexSessionIdFromPath(f)) continue;
            const ref = await this.refFromPath(join(dDir, f));
            if (ref) yield ref;
          }
        }
      }
    }
  }

  private async handle(path: string, kind: "added" | "changed"): Promise<void> {
    if (!this.isRolloutPath(path)) return;
    const ref = await this.refFromPath(path);
    if (ref) this.emitEvent({ kind, ref });
  }

  private handleUnlink(path: string): void {
    if (!this.isRolloutPath(path)) return;
    this.metaByPath.delete(path);
    const id = codexSessionIdFromPath(path);
    if (id) this.emitEvent({ kind: "removed", refId: id });
  }

  private async refFromPath(filePath: string): Promise<SessionRef | null> {
    const id = codexSessionIdFromPath(filePath);
    if (!id) return null;
    const st = await statOrNull(filePath);
    if (!st || !st.isFile()) return null;
    let meta = this.metaByPath.get(filePath);
    if (meta === undefined) {
      const first = await readFirstLine(filePath).catch(() => null);
      if (first == null) return null; // first line not complete yet — retry on the next event
      const parsed = parseCodexMeta(first);
      meta = parsed != null && parsed.kind !== "hidden" ? parsed : null;
      this.metaByPath.set(filePath, meta);
    }
    if (meta == null) return null;
    const identity = projectIdentityFromCwd(meta.cwd);
    const ref: SessionRef = {
      id,
      adapterId: CODEX_ADAPTER_ID,
      workspace: meta.cwd,
      workspaceShort: shortenWorkspace(meta.cwd) || meta.cwd,
      projectKey: identity.key,
      projectLabel: identity.label,
      owner: identity.owner,
      source: filePath,
      mtime: Math.floor(st.mtimeMs / 1000),
    };
    if (meta.kind === "subagent" && meta.parentThreadId) ref.parentId = meta.parentThreadId;
    return ref;
  }
}
