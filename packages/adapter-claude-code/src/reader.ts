import { open, stat } from "node:fs/promises";
import type { SessionReader, SessionRef, SessionStatus, SessionSummary } from "@claude-monitor/core";
import { defaultThresholds, statusFromMtime, type StatusThresholds } from "@claude-monitor/core";
import { fold, initial, pendingSubagents, summarizeTodos, type ParserState } from "./parser.js";

export interface ReaderOptions {
  thresholds?: StatusThresholds;
}

const LF = 0x0a;
const CHUNK = 64 * 1024;

export class ClaudeCodeReader implements SessionReader {
  private state: ParserState = initial();
  private cached: SessionSummary | null = null;
  private readonly thresholds: StatusThresholds;

  constructor(public readonly ref: SessionRef, opts: ReaderOptions = {}) {
    this.thresholds = opts.thresholds ?? defaultThresholds;
  }

  status(now: number): SessionStatus {
    const mtime = this.cached?.ref.mtime ?? this.ref.mtime;
    return statusFromMtime(mtime, now, this.thresholds);
  }

  async readIncremental(): Promise<SessionSummary> {
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
    const summary: SessionSummary = {
      ref: { ...this.ref, mtime: mtimeSec },
      status: statusFromMtime(mtimeSec, now, this.thresholds),
      lastTool: this.state.lastToolName,
      pendingSubagents: pendingSubagents(this.state),
      todo: summarizeTodos(this.state.lastTodos),
      lastText: this.state.lastText,
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
