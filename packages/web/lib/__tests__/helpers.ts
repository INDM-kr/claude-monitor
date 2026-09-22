import type { AISessionAdapter, SessionRef, SessionSummary } from "@claude-monitor/core";

/** Minimal SessionRef for data-source / activity tests. */
export function refFor(
  adapterId: string,
  id: string,
  workspace: string,
  over: Partial<SessionRef> = {},
): SessionRef {
  return {
    id,
    adapterId,
    workspace,
    workspaceShort: workspace,
    projectKey: workspace,
    projectLabel: "ws",
    owner: "alice",
    source: `${workspace}/x.jsonl`,
    mtime: 0,
    ...over,
  };
}

/** A stopped, empty summary for `ref` (override what a test cares about). */
export function summaryFor(ref: SessionRef, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    ref,
    status: "stop",
    lastTool: null,
    pendingSubagents: [],
    todo: null,
    lastText: null,
    firstPrompt: null,
    userTurns: [],
    turnStartSec: null,
    turnTokens: null,
    endedTurn: false,
    runner: "unknown",
    model: null,
    mode: null,
    version: null,
    context: null,
    pid: null,
    updatedAt: 0,
    ...over,
  };
}

/** Adapter that serves fixed summaries — exercises LocalDataSource without any file watching. */
export function fakeAdapter(id: string, summaries: SessionSummary[]): AISessionAdapter {
  return {
    id,
    displayName: id,
    async *discover() {
      for (const s of summaries) yield s.ref;
    },
    open(ref) {
      const s = summaries.find((x) => x.ref.id === ref.id)!;
      return { status: () => s.status, readIncremental: async () => s, close() {} };
    },
    async dispose() {},
    onChange() {
      return () => {};
    },
  };
}

/** Snapshot the given env vars now; call the returned function to restore them. */
export function snapshotEnv(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
