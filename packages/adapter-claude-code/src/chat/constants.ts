import { homedir } from "node:os";
import { join } from "node:path";

/** Adapter id for claude.ai chat conversations cached by Claude Desktop. */
export const CHAT_ADAPTER_ID = "claude-chat";

/** Display name + the synthetic workspace/project label for chat conversations
 *  (they have no repo — the source is a browser-profile cache, not a workspace). */
export const CHAT_DISPLAY = "Claude Chat";

/** Synthetic project key grouping all chat conversations into one card group. */
export const CHAT_PROJECT_KEY = "claude-chat";

/**
 * Default Claude Desktop IndexedDB root on macOS:
 * `~/Library/Application Support/Claude/IndexedDB`.
 * The claude.ai webview keeps its react-query persistent cache in
 * `https_claude.ai_<n>.indexeddb.blob` below it.
 */
export function defaultChatIdbDir(): string {
  return join(homedir(), "Library", "Application Support", "Claude", "IndexedDB");
}

/** Matches the claude.ai origin's IndexedDB *blob* dir (not the `.leveldb`
 *  sibling — the cache value lives in an external blob; leveldb only holds the
 *  reference and is locked while the app runs, so it is never opened). */
export const CHAT_BLOB_DIR_RE = /^https_claude\.ai_\d+\.indexeddb\.blob$/;
