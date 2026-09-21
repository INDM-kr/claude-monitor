import { stat } from "node:fs/promises";
import type { AgentStatus, SessionReader, SessionRef, SessionStatus, SessionSummary } from "@claude-monitor/core";
import {
  computeContext,
  defaultThresholds,
  deriveSessionStatus,
  statusFromMtime,
  type StatusThresholds,
} from "@claude-monitor/core";
import { tailLines } from "../cowork/tail.js";
import { runnerFromOriginator } from "./meta.js";
import { codexTodo, foldCodex, initialCodex, type CodexState } from "./parser.js";

export interface CodexReaderOptions {
  thresholds?: StatusThresholds;
}

/** Lifecycle of a sub-agent child from its own turn events. */
function agentStatusOf(s: CodexState, mtimeSec: number, now: number, thresholds: StatusThresholds): AgentStatus {
  if (s.sawCancelled) return "cancelled";
  if (s.lastTurnClean) return "done";
  return statusFromMtime(mtimeSec, now, thresholds) === "stop" ? "done" : "running";
}

/**
 * Stateful reader for one Codex rollout file. Same tail / rollback /
 * serialization discipline as {@link CoworkReader}; the record semantics live
 * in {@link foldCodex}. Codex sessions have no per-session process (pid null).
 */
export class CodexReader implements SessionReader {
  private state: CodexState = initialCodex();
  private byteOffset = 0;
  private cached: SessionSummary | null = null;
  /** Tail of this reader's pass queue — passes are serialized per reader. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly thresholds: StatusThresholds;

  constructor(public readonly ref: SessionRef, opts: CodexReaderOptions = {}) {
    this.thresholds = opts.thresholds ?? defaultThresholds;
  }

  status(now: number): SessionStatus {
    const mtime = this.cached?.ref.mtime ?? this.ref.mtime;
    return statusFromMtime(mtime, now, this.thresholds);
  }

  readIncremental(): Promise<SessionSummary> {
    const run = this.queue.then(() => this.readPass());
    this.queue = run.catch(() => undefined); // a failed pass must not block later ones
    return run;
  }

  private async readPass(): Promise<SessionSummary> {
    const st = await stat(this.ref.source);
    const size = st.size;
    const mtimeSec = Math.floor(st.mtimeMs / 1000);

    // Truncate/rotate detection — restart from byte 0.
    if (size < this.byteOffset) {
      this.state = initialCodex();
      this.byteOffset = 0;
      this.cached = null;
    }
    if (size > this.byteOffset) {
      this.byteOffset = await tailLines(this.ref.source, this.byteOffset, size, (line) => {
        this.state = foldCodex(this.state, line);
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const s = this.state;
    // Last activity = last timestamped record (every rollout record carries one);
    // file mtime only as a fallback for an empty/unreadable file.
    const activitySec = s.lastTsMs != null ? Math.floor(s.lastTsMs / 1000) : mtimeSec;
    const ref: SessionRef = { ...this.ref, mtime: activitySec };

    const context =
      s.contextTokens != null && s.contextLimit != null ? computeContext(s.contextTokens, s.contextLimit) : null;

    const isChild = ref.parentId != null;
    const ageSec = Math.max(0, now - activitySec);
    // Codex has no "pending sub-agent" signal in the parent's own file (children
    // are separate files, nested by parentId), so hasPending is always false.
    const status = isChild
      ? statusFromMtime(activitySec, now, this.thresholds)
      : deriveSessionStatus(ageSec, s.endedTurn, false, this.thresholds);
    const durationSec =
      s.firstTsMs != null && s.lastTsMs != null ? Math.max(0, Math.round((s.lastTsMs - s.firstTsMs) / 1000)) : 0;

    const summary: SessionSummary = {
      ref,
      status,
      lastTool: s.lastToolName,
      lastActivityDetail: s.lastActivityDetail,
      pendingSubagents: [],
      todo: codexTodo(s),
      lastText: s.lastText,
      firstPrompt: s.userTurns[0] ?? null,
      userTurns: s.userTurns,
      userResponses: s.userResponses,
      turnStartSec: s.lastUserTurnTsMs != null ? Math.floor(s.lastUserTurnTsMs / 1000) : null,
      turnTokens: s.userTurns.length > 0 ? s.turnTokens : null,
      endedTurn: s.endedTurn,
      runner: runnerFromOriginator(s.originator),
      model: s.model,
      mode: s.mode,
      version: s.version,
      context,
      pid: null,
      phase: null,
      agentStatus: isChild ? agentStatusOf(s, activitySec, now, this.thresholds) : null,
      metrics: isChild ? { tokens: s.totalTokens, tools: s.toolCount, durationSec } : null,
      totalTokens: s.totalTokens,
      startSec: s.firstTokenTsMs != null ? Math.floor(s.firstTokenTsMs / 1000) : null,
      updatedAt: now,
    };
    this.cached = summary;
    return summary;
  }

  close(): void {
    this.cached = null;
  }
}
