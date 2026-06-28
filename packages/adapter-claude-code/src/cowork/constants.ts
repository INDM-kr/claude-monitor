import { homedir } from "node:os";
import { join } from "node:path";

/** Adapter id for Claude Desktop cowork (local-agent-mode) sessions. */
export const COWORK_ADAPTER_ID = "claude-cowork";

/** Display name + the synthetic workspace/project label for cowork sessions
 *  (they have no real repo — `cwd` points into a throwaway `…/outputs` dir). */
export const COWORK_DISPLAY = "Claude Desktop";

/**
 * Default Claude Desktop cowork sessions root on macOS:
 * `~/Library/Application Support/Claude/local-agent-mode-sessions`.
 * Layout: `<sid>/<sub>/local_<id>/audit.jsonl`.
 */
export function defaultCoworkDir(): string {
  return join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
}
