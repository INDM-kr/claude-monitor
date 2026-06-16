import { deriveSessionStatus, type SessionStatus, type SessionSummary } from "@claude-monitor/core";

/**
 * Single source of truth for client-side status. The card badge AND the status
 * filter must derive from the same (now − mtime) bucket — otherwise a session
 * can render as "stop" while still matching the "idle" filter (the frozen
 * summary.status, baked at last read, diverges from the live clock).
 *
 * Adds the content-aware "waiting" state (turn finished cleanly, no sub-agents
 * running) on top of the mtime bucket — same logic the server applied.
 */
export function deriveStatus(now: number, s: SessionSummary): SessionStatus {
  return deriveSessionStatus(
    Math.max(0, now - s.ref.mtime),
    s.endedTurn,
    s.pendingSubagents.length > 0,
  );
}
