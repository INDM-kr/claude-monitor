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
import { ClaudeCodeAdapter } from "@claude-monitor/adapter-claude-code";
import { getHub } from "../sse/hub";
import { loadConfig } from "../config";
import { probeProcesses } from "../process-probe";
import { remoteProject } from "../git-remote";

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

  constructor(adapters?: AISessionAdapter[]) {
    const cfg = loadConfig();
    this._adapters =
      adapters && adapters.length > 0
        ? adapters
        : [new ClaudeCodeAdapter({ projectsDir: cfg.projectsDir, thresholds: cfg.thresholds })];
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
    // the reader's cwd-derived projectKey.
    const remote = await remoteProject(summary.ref.workspace);
    const ref: SessionRef = remote
      ? { ...summary.ref, projectKey: remote.key, projectLabel: remote.label }
      : summary.ref;

    const probe = await probeProcesses();
    const e = probe.get(summary.ref.id);
    if (!e) return ref === summary.ref ? summary : { ...summary, ref };

    const limit = e.contextLimit ?? summary.context?.limit ?? null;
    const context =
      summary.context && limit ? computeContext(summary.context.tokens, limit) : summary.context;
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
