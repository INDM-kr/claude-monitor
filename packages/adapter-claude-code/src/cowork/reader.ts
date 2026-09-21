import { stat } from "node:fs/promises";
import type { SessionReader, SessionRef, SessionStatus, SessionSummary } from "@claude-monitor/core";
import {
  defaultThresholds,
  statusFromMtime,
  deriveSessionStatus,
  type StatusThresholds,
  computeContext,
  contextLimitForModel,
} from "@claude-monitor/core";
import { fold, initial, pendingSubagents, summarizeTasks, summarizeTodos, type ParserState } from "../parser.js";
import { normalizeCoworkLine } from "./normalize.js";
import { tailLines } from "./tail.js";

export interface CoworkReaderOptions {
  thresholds?: StatusThresholds;
}

/** Claude Desktop's 1M-context variant carries a `[1m]` suffix on the
 *  `system/init` model — the only in-transcript 1M signal cowork has (there's
 *  no live process for the ps probe to read). Mirrors process-probe.ts. */
const CONTEXT_LIMIT_1M = 1_000_000;
const ONE_M_RE = /\[1m\]/i;

/**
 * Stateful reader for one cowork `audit.jsonl`. Reuses the shared `fold()`
 * parser via {@link normalizeCoworkLine}; differs from {@link ClaudeCodeReader}
 * only in the cowork-specific envelope handling and the synthetic identity
 * (cowork sessions have no repo, no PID, and are always top-level).
 */
export class CoworkReader implements SessionReader {
  private state: ParserState = initial();
  private byteOffset = 0;
  /** init record's model (may carry `[1m]`) — drives the context-window limit. */
  private initModel: string | null = null;
  /** Whether the LAST record read was a clean `result` (= turn finished). */
  private lastWasCleanResult = false;
  private cached: SessionSummary | null = null;
  /** Tail of this reader's pass queue — see readIncremental(). */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly thresholds: StatusThresholds;

  constructor(public readonly ref: SessionRef, opts: CoworkReaderOptions = {}) {
    this.thresholds = opts.thresholds ?? defaultThresholds;
  }

  status(now: number): SessionStatus {
    const mtime = this.cached?.ref.mtime ?? this.ref.mtime;
    return statusFromMtime(mtime, now, this.thresholds);
  }

  /** Serialized per reader, for the same reason as ClaudeCodeReader.readIncremental:
   *  a pass advances `byteOffset` and folds into `state` across awaits. */
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
      this.state = initial();
      this.byteOffset = 0;
      this.initModel = null;
      this.lastWasCleanResult = false;
      this.cached = null;
    }

    if (size > this.byteOffset) {
      this.byteOffset = await tailLines(this.ref.source, this.byteOffset, size, (line) => {
        const norm = normalizeCoworkLine(line);
        if (norm.initModel) this.initModel = norm.initModel;
        // A clean `result` finishes the turn; the next turn's real activity (a
        // human turn or assistant content) clears it. Passive trailing pings
        // (system/status, rate_limit_event) leave it latched — so a finished
        // session stays "ended" even if a status ping is written after the
        // result. At EOF this is the cowork analogue of `end_turn`.
        if (norm.isCleanResult) this.lastWasCleanResult = true;
        else if (norm.activity) this.lastWasCleanResult = false;
        if (norm.line) this.state = fold(this.state, norm.line);
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const s = this.state;
    const ref: SessionRef = { ...this.ref, mtime: mtimeSec };

    const limit = this.initModel && ONE_M_RE.test(this.initModel)
      ? CONTEXT_LIMIT_1M
      : contextLimitForModel(s.model);
    const context = s.contextTokens != null ? computeContext(s.contextTokens, limit) : null;

    const pending = pendingSubagents(this.state);
    const endedTurn = this.lastWasCleanResult;
    const ageSec = Math.max(0, now - mtimeSec);
    const status = deriveSessionStatus(ageSec, endedTurn, pending.length > 0, this.thresholds);

    // Display model: the assistant transcript model (no `[1m]`); fall back to the
    // init model with `[1m]` stripped so an early (pre-assistant) session still
    // shows one.
    const model = s.model ?? (this.initModel ? this.initModel.replace(ONE_M_RE, "") : null);

    const summary: SessionSummary = {
      ref,
      status,
      lastTool: s.lastToolName,
      lastActivityDetail: s.lastActivityDetail,
      pendingSubagents: pending,
      todo: summarizeTodos(s.lastTodos) ?? summarizeTasks(s),
      lastText: s.lastText,
      firstPrompt: s.userTurns[0] ?? null,
      userTurns: s.userTurns,
      userResponses: s.userResponses,
      turnStartSec: s.lastUserTurnTsMs != null ? Math.floor(s.lastUserTurnTsMs / 1000) : null,
      turnTokens: s.userTurns.length > 0 ? s.turnTokens : null,
      endedTurn,
      runner: "claude-desktop",
      model,
      mode: s.mode,
      version: s.version,
      context,
      pid: null,
      phase: s.phase,
      // Cowork sessions are always top-level — no sub-agent lifecycle/metrics.
      agentStatus: null,
      metrics: null,
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
