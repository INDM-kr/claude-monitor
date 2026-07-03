import { homedir } from "node:os";
import { join } from "node:path";
import { defaultThresholds, type StatusThresholds } from "@claude-monitor/core";
import { defaultChatIdbDir, defaultCoworkDir } from "@claude-monitor/adapter-claude-code";

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Truthy env flag (`1`/`true`/`yes`/`on`, case-insensitive); else `fallback`. */
function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
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
  /** Expose Claude Desktop cowork (local-agent-mode) sessions. Opt-in via
   *  `CM_ENABLE_COWORK` — off by default (cowork data is local-only/historical). */
  enableCowork: boolean;
  /** Cowork sessions root (override with `CM_COWORK_DIR`). */
  coworkDir: string;
  /** Expose claude.ai chat conversations from Claude Desktop's IndexedDB cache.
   *  Opt-in via `CM_ENABLE_CHAT` — off by default (the cache's app schema can
   *  change with any claude.ai deploy; the adapter degrades to empty results). */
  enableChat: boolean;
  /** Claude Desktop IndexedDB root (override with `CM_CHAT_IDB_DIR`). */
  chatIdbDir: string;
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
    enableCowork: boolEnv("CM_ENABLE_COWORK", false),
    coworkDir: process.env.CM_COWORK_DIR || defaultCoworkDir(),
    enableChat: boolEnv("CM_ENABLE_CHAT", false),
    chatIdbDir: process.env.CM_CHAT_IDB_DIR || defaultChatIdbDir(),
  };
}
