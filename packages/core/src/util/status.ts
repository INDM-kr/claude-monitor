import type { SessionStatus } from "../types/session.js";

export interface StatusThresholds {
  /** seconds: < this → "live" */
  activeSec: number;
  /** seconds: < this → "idle"; otherwise → "stop" */
  recentSec: number;
}

export const defaultThresholds: StatusThresholds = {
  activeSec: 60,
  recentSec: 600,
};

/**
 * Bucket the age (seconds since mtime) into a SessionStatus.
 * Mirrors bin/claude-monitor lines 125-131.
 */
export function bucket(ageSec: number, cfg: StatusThresholds = defaultThresholds): SessionStatus {
  if (ageSec < cfg.activeSec) return "live";
  if (ageSec < cfg.recentSec) return "idle";
  return "stop";
}

export function statusFromMtime(mtimeSec: number, nowSec: number, cfg?: StatusThresholds): SessionStatus {
  return bucket(Math.max(0, nowSec - mtimeSec), cfg);
}

/**
 * Status for a top-level session: the mtime bucket plus a content signal. A
 * session that cleanly finished its turn (assistant `end_turn`, no sub-agents
 * still running) is "waiting" for the next prompt rather than "live" working.
 * Falls back to the plain age bucket once it ages past `recentSec` (a turn that
 * finished an hour ago is "stop", not "waiting").
 *
 * Permission/approval waits are NOT detectable here — they leave no transcript
 * record and would need Claude Code hooks (out of scope).
 */
export function deriveSessionStatus(
  ageSec: number,
  endedTurn: boolean,
  hasPending: boolean,
  cfg: StatusThresholds = defaultThresholds,
): SessionStatus {
  if (endedTurn && !hasPending && ageSec < cfg.recentSec) return "waiting";
  return bucket(ageSec, cfg);
}
