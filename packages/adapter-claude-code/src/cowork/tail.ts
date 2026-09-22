import { open } from "node:fs/promises";

const LF = 0x0a;
const CHUNK = 64 * 1024;

/**
 * Read bytes `[fromOffset, toSize)` of `source`, split on `\n`, and invoke
 * `onLine` for each COMPLETE non-empty line. Returns the new byte offset — the
 * start of any trailing partial line (no newline yet), left unconsumed so a
 * later call can retry once the writer finishes it.
 *
 * If `onLine` throws on a line (malformed JSON = a still-being-written line),
 * tailing stops and the returned offset points at the START of that line, so
 * the caller re-reads it next time.
 *
 * Mirrors `ClaudeCodeReader.tail`'s partial-line / rollback semantics; factored
 * out so the cowork reader reuses the exact same logic. Append-only files only
 * (cowork `audit.jsonl` is append-only — confirmed: resumes append new
 * `system/init` blocks rather than rewriting). Truncation/rotation is handled by
 * the caller comparing `size < storedOffset` and restarting from 0.
 */
export async function tailLines(
  source: string,
  fromOffset: number,
  toSize: number,
  onLine: (line: string) => void,
): Promise<number> {
  const fh = await open(source, "r");
  try {
    let pos = fromOffset;
    /** Start of the line currently being assembled = the next unconsumed byte. */
    let offset = fromOffset;
    /** Chunks of the partial line that began at `offset` (no LF seen yet). Kept
     *  as a list and joined once per completed line: re-concatenating a growing
     *  leftover with every chunk (and rescanning it) was quadratic in the line
     *  length — Codex rollout records run to 10+ MB per line. */
    const pending: Buffer[] = [];

    while (pos < toSize) {
      const want = Math.min(CHUNK, toSize - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const chunkStart = pos;
      pos += bytesRead;

      let cursor = 0;
      while (cursor < chunk.length) {
        const nl = chunk.indexOf(LF, cursor);
        if (nl === -1) break;
        const tail = chunk.subarray(cursor, nl);
        const lineBuf = pending.length > 0 ? Buffer.concat([...pending, tail]) : tail;
        pending.length = 0;
        const lineStr = lineBuf.toString("utf8");
        if (lineStr.trim().length > 0) {
          try {
            onLine(lineStr);
          } catch {
            return offset; // partial/corrupt — retry from the start of this line
          }
        }
        offset = chunkStart + nl + 1;
        cursor = nl + 1;
      }
      if (cursor < chunk.length) pending.push(Buffer.from(chunk.subarray(cursor)));
    }
    return offset;
  } finally {
    await fh.close();
  }
}
