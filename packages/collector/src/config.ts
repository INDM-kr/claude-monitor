import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const DEFAULTS = {
  databaseFile: "usage.sqlite", lockFile: "writer.sqlite", backupsDirectory: "backups",
  busyTimeoutMs: 5000, batchSize: 250, startupTimeoutMs: 30000, shutdownTimeoutMs: 5000,
  pollMs: 1000, readChunkBytes: 262144, maxLineBytes: 16777216, requestTimeoutMs: 30000,
  runtimeHookTokenFile: "runtime-hook.token",
  /** Worktree tools that keep checkouts as `<root>/<repository name>/<workspace>` (home-relative). */
  worktreeRoots: [["conductor", "workspaces"], ["orca", "workspaces"]],
  /** Codex desktop scratch folders `<root>/<date>/<name>` (home-relative). */
  codexScratchRoots: [["Documents", "Codex"]],
  temporaryRoots: ["/tmp", "/private/tmp"],
  codexScratchLabel: "Codex 임시 작업",
  temporaryLabel: "임시·테스트",
} as const;

/**
 * How folders without a git remote find their project (the remote, when there is one, always decides).
 * Order: worktree tool path → parent folder → scratch bucket → the folder's own project.
 */
export interface ProjectRules {
  /** `<root>/<repository name>/…` joins the one project whose remote has that repository name. */
  worktreeRoots: string[];
  /** Every folder under one of `roots` shares one project, created with `label` when needed. */
  buckets: { id: string; label: string; roots: string[] }[];
}

export interface CollectorConfig {
  enabled: boolean;
  dataDir: string;
  timezone: string;
  busyTimeoutMs: number;
  batchSize: number;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  projectsDir: string;
  /** Codex rollout root (`CM_CODEX_DIR`); null when `CM_ENABLE_CODEX` turns Codex collection off. */
  codexDir: string | null;
  pollMs: number;
  projectRules: ProjectRules;
}

export class CollectorError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0 || n > 2147483647) {
    throw new CollectorError("invalid_config");
  }
  return n;
}

/** Same reading as the web monitor's flags: unset/empty keeps the default, else only 1/true/yes/on enable. */
function flag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function assertRuntime(version = process.versions.node): void {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 24 || minor === undefined || minor < 11) throw new CollectorError("unsupported_node");
}

/** Shared by the collector and the hook token so both always resolve the same private directory. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const base = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dataDir = env.CM_DATA_DIR ?? join(base, "Claude Monitor");
  if (!isAbsolute(dataDir)) throw new CollectorError("invalid_data_directory");
  return resolve(dataDir);
}

function pathList(env: NodeJS.ProcessEnv, key: string, fallback: string[]): string[] {
  const value = env[key];
  const list = value === undefined || value === "" ? fallback : value.split(delimiter).filter(Boolean);
  return [...new Set(list.map(path => resolve(path)))];
}

function realTemporaryDirectory(): string[] {
  try { return [tmpdir(), realpathSync(tmpdir())]; } catch { return [tmpdir()]; }
}

/** Defaults follow the tools' own folder layout; `CM_WORKTREE_ROOTS`, `CM_CODEX_SCRATCH_DIRS`, `CM_TEMPORARY_DIRS` override. */
export function projectRules(env: NodeJS.ProcessEnv = process.env): ProjectRules {
  const home = homedir();
  return {
    worktreeRoots: pathList(env, "CM_WORKTREE_ROOTS", DEFAULTS.worktreeRoots.map(parts => join(home, ...parts))),
    buckets: [
      { id: "codex-scratch", label: DEFAULTS.codexScratchLabel, roots: pathList(env, "CM_CODEX_SCRATCH_DIRS", DEFAULTS.codexScratchRoots.map(parts => join(home, ...parts))) },
      { id: "temporary", label: DEFAULTS.temporaryLabel, roots: pathList(env, "CM_TEMPORARY_DIRS", [...DEFAULTS.temporaryRoots, ...realTemporaryDirectory()]) },
    ],
  };
}

export function loadCollectorConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const enabled = env.CM_COLLECTOR_ENABLED ?? "true";
  if (!["true", "false", "1", "0"].includes(enabled)) throw new CollectorError("invalid_config");
  const dataDir = dataDirectory(env);
  const timezone = env.CM_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new CollectorError("invalid_timezone"); }
  return {
    enabled: enabled === "true" || enabled === "1", dataDir, timezone,
    projectsDir: resolve(env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects")),
    codexDir: flag(env, "CM_ENABLE_CODEX", true) ? resolve(env.CM_CODEX_DIR || join(homedir(), ".codex", "sessions")) : null,
    pollMs: positiveInteger(env, "CM_COLLECTOR_POLL_MS", DEFAULTS.pollMs),
    busyTimeoutMs: positiveInteger(env, "CM_DB_BUSY_TIMEOUT_MS", DEFAULTS.busyTimeoutMs),
    batchSize: positiveInteger(env, "CM_COLLECTOR_BATCH_SIZE", DEFAULTS.batchSize),
    startupTimeoutMs: positiveInteger(env, "CM_COLLECTOR_STARTUP_TIMEOUT_MS", DEFAULTS.startupTimeoutMs),
    shutdownTimeoutMs: positiveInteger(env, "CM_COLLECTOR_SHUTDOWN_TIMEOUT_MS", DEFAULTS.shutdownTimeoutMs),
    projectRules: projectRules(env),
  };
}

export function diagnosticCode(error: unknown): string {
  if (error instanceof CollectorError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") return "database_corrupt";
  if (code === "EACCES" || code === "EPERM" || code === "SQLITE_READONLY") return "storage_permission_denied";
  if (code === "ENOSPC" || code === "SQLITE_FULL") return "storage_full";
  return "storage_open_failed";
}
