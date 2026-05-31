import type { RunnerKind } from "../types/session.js";

/** Conductor workspaces live under this path segment (mirrors project-key.ts). */
const CONDUCTOR_WS = "/conductor/workspaces/";

/**
 * Classify the runner from the transcript's `entrypoint` field (+ workspace).
 *
 * Used as a fallback when no live process is matched by the ps probe, so
 * stopped sessions still show a runner badge. A positive live-probe result
 * still wins (see local.ts enrich()).
 *
 * Observed entrypoints: "cli", "sdk-cli", "sdk-ts", "claude-desktop".
 * sdk-ts is emitted by Conductor (and other Agent-SDK harnesses), so it is
 * disambiguated by the workspace path.
 */
export function runnerFromEntrypoint(
  entrypoint: string | null | undefined,
  workspace: string,
): RunnerKind {
  switch (entrypoint) {
    case "claude-desktop":
      return "claude-desktop";
    case "cli":
    case "sdk-cli":
      return "claude-code";
    case "sdk-ts":
      return workspace.includes(CONDUCTOR_WS) ? "conductor" : "agent";
    default:
      return "unknown";
  }
}
