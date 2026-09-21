import { basename } from "node:path";
import type { RunnerKind } from "@claude-monitor/core";

/**
 * Which kind of Codex thread a rollout file holds:
 *  - "user": a thread the person drove (source "vscode" | "exec" | "cli").
 *  - "subagent": a `spawn_agent` child (source.subagent.thread_spawn) — shown
 *    nested under its parent.
 *  - "hidden": Codex-internal helper threads (guardian approval reviews,
 *    `{subagent: "review"}`) — not user work, never listed.
 */
export type CodexThreadKind = "user" | "subagent" | "hidden";

export interface CodexMeta {
  /** Thread id (`payload.id`). */
  id: string;
  cwd: string;
  /** "Codex Desktop" | "codex_work_desktop" | "codex_exec" | … */
  originator: string | null;
  cliVersion: string | null;
  parentThreadId: string | null;
  kind: CodexThreadKind;
  agentNickname: string | null;
  /** Sub-agent files open with a copy of the parent's history; records whose
   *  `ordinal` is below this belong to the parent and must be skipped. */
  subagentHistoryStartOrdinal: number | null;
}

interface RawMeta {
  type?: unknown;
  payload?: Record<string, unknown> | null;
}

/** Parse the first line of a rollout file. Null unless it is a usable `session_meta`. */
export function parseCodexMeta(line: string): CodexMeta | null {
  let obj: RawMeta;
  try {
    obj = JSON.parse(line) as RawMeta;
  } catch {
    return null;
  }
  if (obj?.type !== "session_meta" || obj.payload == null || typeof obj.payload !== "object") return null;
  const p = obj.payload;
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.cwd !== "string" || !p.cwd) return null;

  let kind: CodexThreadKind = "user";
  let agentNickname: string | null = null;
  const src = p.source;
  if (src != null && typeof src === "object") {
    const sub = (src as { subagent?: unknown }).subagent;
    const spawn =
      sub != null && typeof sub === "object" ? (sub as { thread_spawn?: unknown }).thread_spawn : undefined;
    if (spawn != null && typeof spawn === "object") {
      kind = "subagent";
      const nick = (spawn as { agent_nickname?: unknown }).agent_nickname;
      agentNickname = typeof nick === "string" ? nick : null;
    } else {
      kind = "hidden";
    }
  }
  const start = p.subagent_history_start_ordinal;
  return {
    id: p.id,
    cwd: p.cwd,
    originator: typeof p.originator === "string" ? p.originator : null,
    cliVersion: typeof p.cli_version === "string" ? p.cli_version : null,
    parentThreadId: typeof p.parent_thread_id === "string" && p.parent_thread_id ? p.parent_thread_id : null,
    kind,
    agentNickname,
    subagentHistoryStartOrdinal: typeof start === "number" && Number.isFinite(start) ? start : null,
  };
}

/** Originators written by the Codex desktop app (observed: both spellings). */
const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);

export function runnerFromOriginator(originator: string | null | undefined): RunnerKind {
  return originator != null && DESKTOP_ORIGINATORS.has(originator) ? "codex-desktop" : "codex";
}

const ROLLOUT_FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i;

/** Session id from a rollout file name: everything after `rollout-<ts>-`,
 *  so a post-compaction continuation (`<thread>_<window>.jsonl`) stays distinct. */
export function codexSessionIdFromPath(filePath: string): string | null {
  const m = basename(filePath).match(ROLLOUT_FILE_RE);
  return m ? m[1]! : null;
}
