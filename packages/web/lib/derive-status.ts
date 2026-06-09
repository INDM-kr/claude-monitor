import { bucket, type SessionStatus } from "@claude-monitor/core";

/**
 * Single source of truth for client-side status. The card badge AND the status
 * filter must derive from the same (now − mtime) bucket — otherwise a session
 * can render as "stop" while still matching the "idle" filter (the frozen
 * summary.status, baked at last read, diverges from the live clock).
 */
export function deriveStatus(now: number, mtimeSec: number): SessionStatus {
  return bucket(Math.max(0, now - mtimeSec));
}
