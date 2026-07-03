import type {
  AISessionAdapter,
  AdapterEvent,
  AuthContext,
  DataSource,
  SessionReader,
  SessionRef,
  SessionSummary,
} from "@claude-monitor/core";
import { computeContext } from "@claude-monitor/core";
import { ChatAdapter, ClaudeCodeAdapter, CoworkAdapter } from "@claude-monitor/adapter-claude-code";
import { getHub } from "../sse/hub";
import { loadConfig } from "../config";
import { probeProcesses } from "../process-probe";
import { remoteProject } from "../git-remote";
import { findProjectRoot } from "../project-root";

const DEBOUNCE_MS = 150;

interface SessionEntry {
  ref: SessionRef;
  reader: SessionReader;
  lastSummary: SessionSummary | null;
  flushTimer: NodeJS.Timeout | null;
}

export class LocalDataSource implements DataSource {
  readonly kind = "local" as const;
  private readonly _adapters: AISessionAdapter[];
  private readonly entries = new Map<string, SessionEntry>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private discovered = false;
  private discoverPromise: Promise<void> | null = null;
  private unsubAdapterEvents: Array<() => void> = [];
  // The 1M context window ([1m]) only shows in the live process args, never the
  // transcript. Remember each session's detected limit so context % stays correct
  // after the process exits (else it falls back to the 200k default). In-memory:
  // reset on server restart.
  private readonly ctxLimits = new Map<string, number>();

  constructor(adapters?: AISessionAdapter[]) {
    const cfg = loadConfig();
    if (adapters && adapters.length > 0) {
      this._adapters = adapters;
    } else {
      const list: AISessionAdapter[] = [
        new ClaudeCodeAdapter({ projectsDir: cfg.projectsDir, thresholds: cfg.thresholds }),
      ];
      if (cfg.enableCowork) {
        list.push(new CoworkAdapter({ coworkDir: cfg.coworkDir, thresholds: cfg.thresholds }));
      }
      if (cfg.enableChat) {
        list.push(new ChatAdapter({ idbDir: cfg.chatIdbDir, thresholds: cfg.thresholds }));
      }
      this._adapters = list;
    }
  }

  adapters(): AISessionAdapter[] {
    return this._adapters;
  }

  auth(): AuthContext {
    return { scheme: "anonymous" };
  }

  subscribe(cb: (e: AdapterEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async ensureDiscovered(): Promise<void> {
    if (this.discovered) return;
    if (!this.discoverPromise) this.discoverPromise = this.runDiscover();
    await this.discoverPromise;
  }

  async snapshot(): Promise<SessionSummary[]> {
    await this.ensureDiscovered();
    const raw = [...this.entries.values()]
      .map((e) => e.lastSummary)
      .filter((s): s is SessionSummary => Boolean(s));
    return Promise.all(raw.map((s) => this.enrich(s)));
  }

  async getById(adapterId: string, sessionId: string): Promise<SessionSummary | null> {
    await this.ensureDiscovered();
    const key = compositeKey(adapterId, sessionId);
    const e = this.entries.get(key);
    if (!e) return null;
    const fresh = await e.reader.readIncremental();
    const enriched = await this.enrich(fresh);
    e.lastSummary = enriched;
    return enriched;
  }

  async dispose(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.flushTimer) clearTimeout(e.flushTimer);
      e.reader.close();
    }
    this.entries.clear();
    for (const off of this.unsubAdapterEvents) off();
    this.unsubAdapterEvents = [];
    await Promise.all(this._adapters.map((a) => a.dispose()));
  }

  private async enrich(summary: SessionSummary): Promise<SessionSummary> {
    // Group by the repo's origin remote URL when resolvable (unifies worktrees /
    // clones of the same repo regardless of path). cwd gone / no remote → keep
    // the reader's cwd-derived projectKey. Only Claude Code sessions have a repo
    // workspace; skip the `git` spawn for cowork (its workspace is a synthetic
    // label, and walking up could mis-resolve against an ancestor `.git`).
    const isClaudeCode = summary.ref.adapterId === "claude-code";
    const remote = isClaudeCode ? await remoteProject(summary.ref.workspace) : null;
    let ref: SessionRef = summary.ref;
    if (remote) {
      ref = { ...summary.ref, projectKey: remote.key, projectLabel: remote.label };
    } else if (isClaudeCode) {
      // Non-git fallback: fold a subfolder of a non-git project (e.g. a `_plan`
      // planning dir) into the nearest ancestor that owns a root marker
      // (VCS dir / CLAUDE.md), so it groups with the project instead of as its own.
      const root = await findProjectRoot(summary.ref.workspace);
      if (root && root.key !== summary.ref.projectKey) {
        ref = { ...summary.ref, projectKey: root.key, projectLabel: root.label };
      }
    }

    const probe = await probeProcesses();
    // The ps probe (and ctxLimits) are keyed by the bare session id. Only Claude
    // Code sessions have a live `claude` process; gate the lookup by adapterId so
    // a cowork id can't collide with a Claude Code session id and borrow its
    // pid/runner/context-limit. (Cowork's runner/pid/context come from the reader
    // and survive when `e` is undefined.)
    const e = summary.ref.adapterId === "claude-code" ? probe.get(summary.ref.id) : undefined;

    // Remember a positively-detected context limit (1M for [1m]) so it survives
    // the process exiting; reuse it as the fallback when no live process is found.
    if (e?.contextLimit) this.ctxLimits.set(summary.ref.id, e.contextLimit);
    const limit = e?.contextLimit ?? this.ctxLimits.get(summary.ref.id) ?? summary.context?.limit ?? null;
    const context =
      summary.context && limit ? computeContext(summary.context.tokens, limit) : summary.context;

    if (!e) return { ...summary, ref, context };

    // Live probe wins only when it positively classified the runner; otherwise
    // keep the reader's entrypoint-derived fallback (so stopped/unclassified
    // live procs still show a badge).
    const runner = e.runner !== "unknown" ? e.runner : summary.runner;
    return { ...summary, ref, runner, pid: e.pid, context };
  }

  private async runDiscover(): Promise<void> {
    for (const adapter of this._adapters) {
      const off = adapter.onChange((e) => this.handleAdapterEvent(adapter, e));
      this.unsubAdapterEvents.push(off);
      for await (const ref of adapter.discover()) {
        this.addOrUpdateRef(adapter, ref, false);
      }
    }
    // Initial fan-out: prime all readers
    for (const entry of this.entries.values()) {
      try {
        const fresh = await entry.reader.readIncremental();
        entry.lastSummary = await this.enrich(fresh);
      } catch {
        // ignore per-file failure
      }
    }
    this.discovered = true;
  }

  private handleAdapterEvent(adapter: AISessionAdapter, event: AdapterEvent): void {
    if (event.kind === "added") {
      this.addOrUpdateRef(adapter, event.ref, true);
    } else if (event.kind === "changed") {
      const key = compositeKey(adapter.id, event.ref.id);
      const entry = this.entries.get(key);
      if (entry) {
        entry.ref = event.ref;
        this.scheduleFlush(entry);
      } else {
        this.addOrUpdateRef(adapter, event.ref, true);
      }
    } else if (event.kind === "removed") {
      const key = compositeKey(adapter.id, event.refId);
      const entry = this.entries.get(key);
      if (entry) {
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        entry.reader.close();
        this.entries.delete(key);
        getHub().publish({ kind: "removed", data: { refId: event.refId } });
      }
    }
    for (const listener of this.listeners) listener(event);
  }

  private addOrUpdateRef(adapter: AISessionAdapter, ref: SessionRef, scheduleFlush: boolean): void {
    const key = compositeKey(adapter.id, ref.id);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        ref,
        reader: adapter.open(ref),
        lastSummary: null,
        flushTimer: null,
      };
      this.entries.set(key, entry);
    } else {
      entry.ref = ref;
    }
    if (scheduleFlush) this.scheduleFlush(entry);
  }

  private scheduleFlush(entry: SessionEntry): void {
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(async () => {
      entry.flushTimer = null;
      try {
        const summary = await entry.reader.readIncremental();
        const enriched = await this.enrich(summary);
        entry.lastSummary = enriched;
        getHub().publish({ kind: "summary", data: enriched });
      } catch {
        // Ignore — next tick will retry on the next change.
      }
    }, DEBOUNCE_MS);
  }
}

function compositeKey(adapterId: string, sessionId: string): string {
  return `${adapterId}::${sessionId}`;
}

declare global {
  // eslint-disable-next-line no-var
  var __claudeMonitorDataSource: LocalDataSource | undefined;
}

export function getDataSource(): LocalDataSource {
  if (!globalThis.__claudeMonitorDataSource) {
    globalThis.__claudeMonitorDataSource = new LocalDataSource();
  }
  return globalThis.__claudeMonitorDataSource;
}
