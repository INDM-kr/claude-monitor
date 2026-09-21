import { open, stat } from "node:fs/promises";
import type { AgentStatus, SessionReader, SessionRef, SessionStatus, SessionSummary } from "@claude-monitor/core";
import { defaultThresholds, statusFromMtime, deriveSessionStatus, type StatusThresholds, shortenWorkspace, projectIdentityFromCwd, contextLimitForModel, computeContext, runnerFromEntrypoint } from "@claude-monitor/core";
import { fold, initial, pendingSubagents, summarizeTasks, summarizeTodos, type ParserState } from "./parser.js";

export interface ReaderOptions {
  thresholds?: StatusThresholds;
}

const LF = 0x0a;
const CHUNK = 64 * 1024;

/** Lifecycle of a sub-agent run from its transcript signals. */
function agentStatusOf(
  s: ParserState,
  mtimeSec: number,
  now: number,
  thresholds: StatusThresholds,
): AgentStatus {
  if (s.sawCancelled) return "cancelled"; // explicit user interruption
  if (s.sawError) return "error";
  if (s.lastStopReason === "end_turn") return "done"; // clean finish
  // No marker: a stopped run finished (e.g. structured-output ends on a tool_use,
  // not end_turn); a still-recent run is running.
  return statusFromMtime(mtimeSec, now, thresholds) === "stop" ? "done" : "running";
}

export class ClaudeCodeReader implements SessionReader {
  private state: ParserState = initial();
  private cached: SessionSummary | null = null;
  /** Tail of this reader's pass queue — see readIncremental(). */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly thresholds: StatusThresholds;

  constructor(public readonly ref: SessionRef, opts: ReaderOptions = {}) {
    this.thresholds = opts.thresholds ?? defaultThresholds;
  }

  status(now: number): SessionStatus {
    const mtime = this.cached?.ref.mtime ?? this.ref.mtime;
    return statusFromMtime(mtime, now, this.thresholds);
  }

  /**
   * Safe under concurrent calls: passes are SERIALIZED per reader — each starts
   * after the previous one settles and re-stats the file itself. A pass mutates
   * `state` (byteOffset + folded fields) across awaits, so two overlapping passes
   * would read the same byte range and fold it twice (observed at startup: a
   * watcher flush still in flight when the priming loop reached the same entry).
   * Joining the in-flight pass instead would be stale — its stat can predate the
   * write that triggered this call, missing e.g. the turn's closing end_turn.
   */
  readIncremental(): Promise<SessionSummary> {
    const run = this.queue.then(() => this.readPass());
    this.queue = run.catch(() => undefined); // a failed pass must not block later ones
    return run;
  }

  private async readPass(): Promise<SessionSummary> {
    const st = await stat(this.ref.source);
    const size = st.size;
    const mtimeSec = Math.floor(st.mtimeMs / 1000);

    // Truncate/rotate detection — restart
    if (size < this.state.byteOffset) {
      this.state = initial();
      this.cached = null;
    }

    if (size > this.state.byteOffset) {
      await this.tail(size);
    }

    const now = Math.floor(Date.now() / 1000);

    // "Last activity" = the last TIMESTAMPED conversation record, not the file
    // mtime. The file mtime is unreliable: Desktop-bridge / metadata records
    // (file-history-snapshot, ai-title, bridge-session, mode, …) carry no
    // timestamp and bump the file long after the last real turn, making a stale
    // session look recent (observed: mtime up to ~18h ahead of the last turn).
    // Drives the age filter, sort, and status. Falls back to file mtime when the
    // transcript has no timestamped records at all.
    const activitySec =
      this.state.lastTsMs != null ? Math.floor(this.state.lastTsMs / 1000) : mtimeSec;

    // cwd가 있으면 lossy decoded ref를 정정
    const cwd = this.state.cwd;
    const baseRef = cwd
      ? (() => {
          const id = projectIdentityFromCwd(cwd);
          return {
            ...this.ref,
            workspace: cwd,
            workspaceShort: shortenWorkspace(cwd) || cwd,
            projectKey: id.key,
            projectLabel: id.label,
            owner: id.owner,
            mtime: activitySec,
          };
        })()
      : { ...this.ref, mtime: activitySec };

    const limit = contextLimitForModel(this.state.model);
    const context =
      this.state.contextTokens != null ? computeContext(this.state.contextTokens, limit) : null;

    // Agent lifecycle + metrics are only meaningful for sub-agent child runs.
    const isChild = this.ref.parentId != null;
    const s = this.state;
    const durationSec =
      s.firstTsMs != null && s.lastTsMs != null
        ? Math.max(0, Math.round((s.lastTsMs - s.firstTsMs) / 1000))
        : 0;

    const pending = pendingSubagents(this.state);
    // A finished turn = last record is an assistant message that ended cleanly.
    const endedTurn = s.lastRecordType === "assistant" && s.lastStopReason === "end_turn";
    const ageSec = Math.max(0, now - activitySec);
    // Children keep the plain age-bucket status (lifecycle is in agentStatus);
    // top-level sessions get the content-aware status (waiting vs live/idle/stop).
    const status = isChild
      ? statusFromMtime(activitySec, now, this.thresholds)
      : deriveSessionStatus(ageSec, endedTurn, pending.length > 0, this.thresholds);

    const summary: SessionSummary = {
      ref: baseRef,
      status,
      lastTool: this.state.lastToolName,
      lastActivityDetail: this.state.lastActivityDetail,
      pendingSubagents: pending,
      todo: summarizeTodos(this.state.lastTodos) ?? summarizeTasks(this.state),
      lastText: this.state.lastText,
      firstPrompt: s.userTurns[0] ?? null,
      userTurns: s.userTurns,
      userResponses: s.userResponses,
      turnStartSec: s.lastUserTurnTsMs != null ? Math.floor(s.lastUserTurnTsMs / 1000) : null,
      turnTokens: s.userTurns.length > 0 ? s.turnTokens : null,
      endedTurn,
      runner: runnerFromEntrypoint(this.state.entrypoint, baseRef.workspace),
      model: this.state.model,
      mode: this.state.mode,
      version: this.state.version,
      context,
      pid: null,
      phase: s.phase,
      agentStatus: isChild ? agentStatusOf(s, activitySec, now, this.thresholds) : null,
      metrics: isChild ? { tokens: s.totalTokens, tools: s.toolCount, durationSec } : null,
      // Cumulative session tokens for every session (card + detail). Sub-agent trees
      // keep using `metrics.tokens` so the same value isn't shown twice.
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

  /**
   * Read bytes [byteOffset, targetSize) from disk, split on `\n`, fold each
   * complete line into state. A trailing partial line (no newline) is *not*
   * consumed — byteOffset stays at the start of that line so the next call
   * can retry once the writer finishes it.
   *
   * A malformed (but newline-terminated) line is treated as a partial write
   * too: we stop and roll back to the start of that line.
   */
  private async tail(targetSize: number): Promise<void> {
    const fh = await open(this.ref.source, "r");
    try {
      let pos = this.state.byteOffset;
      let leftover = Buffer.alloc(0);
      // Offset of the first byte of `leftover` within the file.
      let leftoverStart = pos;

      while (pos < targetSize) {
        const want = Math.min(CHUNK, targetSize - pos);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;

        const merged = leftover.length
          ? Buffer.concat([leftover, buf.subarray(0, bytesRead)])
          : buf.subarray(0, bytesRead);

        let cursor = 0;
        while (cursor < merged.length) {
          const nl = merged.indexOf(LF, cursor);
          if (nl === -1) break;
          const lineBuf = merged.subarray(cursor, nl);
          const lineStr = lineBuf.toString("utf8");
          const lineStart = leftoverStart + cursor;
          const lineEnd = leftoverStart + nl + 1;

          if (lineStr.trim().length > 0) {
            try {
              this.state = fold(this.state, lineStr);
            } catch {
              // Treat as partial/corrupt — roll back to start of this line.
              this.state.byteOffset = lineStart;
              return;
            }
          }
          this.state.byteOffset = lineEnd;
          cursor = nl + 1;
        }

        if (cursor < merged.length) {
          leftover = Buffer.from(merged.subarray(cursor));
          leftoverStart = this.state.byteOffset;
        } else {
          leftover = Buffer.alloc(0);
          leftoverStart = this.state.byteOffset;
        }
      }
      // Any trailing leftover without `\n` is left for the next call.
    } finally {
      await fh.close();
    }
  }
}
