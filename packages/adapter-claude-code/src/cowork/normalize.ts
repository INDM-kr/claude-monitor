/**
 * Normalize one Claude Desktop **cowork** `audit.jsonl` record into a line the
 * shared Claude-Code `fold()` parser can consume, plus two out-of-band signals
 * the cowork reader needs (`initModel`, `isCleanResult`).
 *
 * Why a shim instead of editing `fold()`: cowork records carry the SAME
 * `message.content` shape as a Claude Code transcript (string human turn; array
 * of thinking/text/tool_use/tool_result), but wrap it in an audit envelope with
 * three cowork-only quirks (verified across all on-disk audit files):
 *
 *  1. Timestamps live in `_audit_timestamp` (not `timestamp`); the version lives
 *     in the `system/init` record's `claude_code_version` (not `version`).
 *  2. Every submitted human turn is logged TWICE sharing one `uuid`: a
 *     non-replay original and an `isReplay:true` replay. The first turn's
 *     original is emitted BEFORE `system/init` (the "pre-init echo"); edited
 *     drafts also appear as non-replay originals with no replay twin. Keeping
 *     only `isReplay:true` user-string records yields exactly one entry per
 *     turn, order-preserving, and drops echoes/drafts. We express that to
 *     `fold()` by marking every non-replay user-string record `isMeta:true`
 *     (which `fold`'s `isHumanTurn` already skips).
 *  3. A finished turn ends with a top-level `type:"result"` record (NOT an
 *     assistant `stop_reason:"end_turn"` — cowork streams each content block as
 *     its own assistant record with `stop_reason:null`). We rewrite a `result`
 *     into a synthetic assistant text record so its `.result` summary flows into
 *     `lastText`/`userResponses`, and surface `isCleanResult` so the reader can
 *     drive `endedTurn` off "the last record was a clean result".
 *
 * Throws on malformed JSON — the caller's tail loop treats that as a partial
 * write and rolls back (same as the Claude Code reader).
 */
export interface NormalizedCoworkLine {
  /** Line to feed to `fold()`, or null to skip this record entirely. */
  line: string | null;
  /** The `system/init` record's model (may carry a `[1m]` suffix); else null. */
  initModel: string | null;
  /** This record is a `result` with `is_error === false` (a cleanly finished
   *  turn). The reader latches `endedTurn` on this. */
  isCleanResult: boolean;
  /** This record is real turn progress (a human turn or assistant content) — as
   *  opposed to a passive ping (`system/status`, `rate_limit_event`, permission
   *  prompts). The reader clears `endedTurn` only on activity, so a finished
   *  turn stays "ended" even if a trailing status ping arrives after the
   *  `result`. */
  activity: boolean;
}

interface CoworkRecord {
  type?: string;
  subtype?: string;
  timestamp?: string;
  version?: string;
  _audit_timestamp?: string;
  claude_code_version?: string;
  model?: string;
  isReplay?: boolean;
  isMeta?: boolean;
  is_error?: boolean;
  result?: unknown;
  error?: unknown;
  message?: { content?: unknown };
  [k: string]: unknown;
}

export function normalizeCoworkLine(raw: string): NormalizedCoworkLine {
  const obj = JSON.parse(raw) as CoworkRecord;

  // Quirk 1 — envelope field aliases.
  if (typeof obj._audit_timestamp === "string" && obj.timestamp == null) {
    obj.timestamp = obj._audit_timestamp;
  }
  if (typeof obj.claude_code_version === "string" && obj.version == null) {
    obj.version = obj.claude_code_version;
  }
  // Transient `api_retry` records carry a top-level `error:"unknown"`; strip it
  // only on `system` records so `fold()` doesn't read a mere retry as an error.
  // (Real failures live on assistant/result records — leave those intact. Note:
  // cowork is always top-level, so `fold`'s sawError isn't read today anyway.)
  if (obj.error != null && obj.type === "system") delete obj.error;

  const initModel =
    obj.type === "system" && obj.subtype === "init" && typeof obj.model === "string"
      ? obj.model
      : null;

  // Quirk 3 — a `result` record closes a turn. Rewrite it into a synthetic
  // assistant text record (carrying the final summary) WITHOUT usage/stop_reason.
  // We drop result.usage deliberately: it's a cumulative aggregate that would
  // compound the per-content-block usage repetition `fold()` already sums (a
  // pre-existing shared-parser trait — Claude Code transcripts repeat usage
  // across split records too). So `totalTokens` is an over-estimate for both
  // adapters; correcting it belongs in `fold()`, not here.
  if (obj.type === "result") {
    const isClean = obj.is_error === false;
    const text = typeof obj.result === "string" ? obj.result : "";
    const synthetic = {
      type: "assistant",
      timestamp: obj.timestamp,
      message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
    };
    return { line: JSON.stringify(synthetic), initModel: null, isCleanResult: isClean, activity: !isClean };
  }

  // Quirk 2 — suppress the non-replay echo/draft copies of human turns.
  if (
    obj.type === "user" &&
    typeof obj.message?.content === "string" &&
    obj.isReplay !== true
  ) {
    obj.isMeta = true;
  }

  const activity = obj.type === "user" || obj.type === "assistant";
  return { line: JSON.stringify(obj), initModel, isCleanResult: false, activity };
}
