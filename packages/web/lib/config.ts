import { homedir } from "node:os";
import { join } from "node:path";
import { defaultThresholds, type StatusThresholds } from "@claude-monitor/core";

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Optional positive-int env (a token limit); null when unset/invalid. */
function intEnvOrNull(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface AppConfig {
  projectsDir: string;
  thresholds: StatusThresholds;
  maxAgeHours: number;
  bearerToken: string | null;
  /** Optional token limits for the usage gauge denominator (account/API value
   *  isn't available locally, so the user can supply it). null → fall back to
   *  the recent peak block. */
  blockTokenLimit: number | null;
  weeklyTokenLimit: number | null;
}

export function loadConfig(): AppConfig {
  return {
    projectsDir: process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects"),
    thresholds: {
      activeSec: intEnv("CM_ACTIVE_THRESHOLD_SEC", defaultThresholds.activeSec),
      recentSec: intEnv("CM_RECENT_THRESHOLD_SEC", defaultThresholds.recentSec),
    },
    maxAgeHours: intEnv("CM_MAX_AGE_HOURS", 24),
    bearerToken: process.env.CM_BEARER_TOKEN || null,
    blockTokenLimit: intEnvOrNull("CM_BLOCK_TOKEN_LIMIT"),
    weeklyTokenLimit: intEnvOrNull("CM_WEEKLY_TOKEN_LIMIT"),
  };
}
