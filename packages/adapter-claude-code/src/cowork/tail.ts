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
    let offset = fromOffset;
    let leftover = Buffer.alloc(0);
    let leftoverStart = pos;

    while (pos < toSize) {
      const want = Math.min(CHUNK, toSize - pos);
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
        const lineStr = merged.subarray(cursor, nl).toString("utf8");
        const lineStart = leftoverStart + cursor;
        const lineEnd = leftoverStart + nl + 1;
        if (lineStr.trim().length > 0) {
          try {
            onLine(lineStr);
          } catch {
            return lineStart; // partial/corrupt — retry from the start of this line
          }
        }
        offset = lineEnd;
        cursor = nl + 1;
      }

      leftover = cursor < merged.length ? Buffer.from(merged.subarray(cursor)) : Buffer.alloc(0);
      leftoverStart = offset;
    }
    return offset;
  } finally {
    await fh.close();
  }
}
