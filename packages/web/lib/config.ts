import { homedir } from "node:os";
import { join } from "node:path";
import { defaultThresholds, type StatusThresholds } from "@claude-monitor/core";

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface AppConfig {
  projectsDir: string;
  thresholds: StatusThresholds;
  maxAgeHours: number;
  bearerToken: string | null;
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
  };
}
