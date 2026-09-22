import { homedir } from "node:os";
import { join } from "node:path";

/** Adapter id for OpenAI Codex (CLI / Desktop) rollout sessions. */
export const CODEX_ADAPTER_ID = "codex";

/** Display name (runner label lives in the web i18n table). */
export const CODEX_DISPLAY = "Codex";

/**
 * Default Codex rollout root:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<thread-id>[_<window-id>].jsonl`.
 */
export function defaultCodexDir(): string {
  return join(homedir(), ".codex", "sessions");
}
