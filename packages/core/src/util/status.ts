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
