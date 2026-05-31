import { basename } from "node:path";
import type { PendingSubagent, TodoSnapshot } from "@claude-monitor/core";

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const TODO_TOOL = "TodoWrite";
const LAST_TEXT_MAX = 200;
const SUBAGENT_DESC_MAX = 40;
const ACTIVITY_DETAIL_MAX = 60;

interface TodoItem {
  status: string;
  content?: string;
}

export interface ParserState {
  lastToolName: string | null;
  /** Salient target of the last tool call (see salientDetail). */
  lastActivityDetail: string | null;
  /** Task/Agent calls only — id → desc/type */
  toolCallsById: Map<string, { name: string; desc: string; type: string | null }>;
  /** tool_use ids that have received a tool_result */
  resolvedToolIds: Set<string>;
  /** latest TodoWrite snapshot */
  lastTodos: TodoItem[] | null;
  /** Last non-empty assistant text (already truncated) */
  lastText: string | null;
  /** byte offset of the next unread byte in the source file */
  byteOffset: number;
  // --- metadata enrichment ---
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  entrypoint: string | null;
  mode: string | null;
  model: string | null;
  contextTokens: number | null;
}

export function initial(): ParserState {
  return {
    lastToolName: null,
    lastActivityDetail: null,
    toolCallsById: new Map(),
    resolvedToolIds: new Set(),
    lastTodos: null,
    lastText: null,
    byteOffset: 0,
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    mode: null,
    model: null,
    contextTokens: null,
  };
}

export interface ParsedLine {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  permissionMode?: string;
  message?: {
    model?: string;
    usage?: Record<string, unknown>;
    content?: Array<Record<string, unknown>>;
  };
}

/**
 * Fold one JSONL line into the parser state.
 *
 * Mirrors the jq program at bin/claude-monitor:53-80.
 * Throws nothing — malformed lines are passed by the caller via try/catch.
 */
export function fold(state: ParserState, line: string): ParserState {
  const obj = JSON.parse(line) as ParsedLine;
  const content = Array.isArray(obj?.message?.content) ? obj.message!.content! : [];

  if (typeof obj.cwd === "string") state.cwd = obj.cwd;
  if (typeof obj.gitBranch === "string") state.gitBranch = obj.gitBranch;
  if (typeof obj.version === "string") state.version = obj.version;
  if (typeof obj.entrypoint === "string") state.entrypoint = obj.entrypoint;
  if (typeof obj.permissionMode === "string") state.mode = obj.permissionMode;

  const msg = obj.message;
  if (msg) {
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") state.model = msg.model;
    if (msg.usage) state.contextTokens = usageContextTokens(msg.usage);
  }

  if (obj?.type === "assistant") {
    for (const c of content) {
      if (c.type === "tool_use") {
        const name = String(c.name ?? "");
        const id = String(c.id ?? "");
        if (name) {
          state.lastToolName = name;
          state.lastActivityDetail = salientDetail(name, (c.input ?? {}) as Record<string, unknown>);
        }
        if (SUBAGENT_TOOLS.has(name) && id) {
          const input = (c.input ?? {}) as Record<string, unknown>;
          const rawDesc = input.description ?? input.subagent_type ?? "agent";
          const desc = String(rawDesc).slice(0, SUBAGENT_DESC_MAX);
          const type = typeof input.subagent_type === "string" ? input.subagent_type : null;
          state.toolCallsById.set(id, { name, desc, type });
        }
        if (name === TODO_TOOL) {
          const input = (c.input ?? {}) as { todos?: TodoItem[] };
          if (Array.isArray(input.todos)) {
            state.lastTodos = input.todos;
          }
        }
      } else if (c.type === "text") {
        const text = String(c.text ?? "").trim();
        if (text) {
          state.lastText = text.slice(0, LAST_TEXT_MAX);
        }
      }
    }
  } else if (obj?.type === "user") {
    for (const c of content) {
      if (c.type === "tool_result") {
        const id = c.tool_use_id;
        if (typeof id === "string") state.resolvedToolIds.add(id);
      }
    }
  }

  return state;
}

/**
 * Human-readable target of a tool call — "what it's doing now" beyond the bare
 * tool name. Returns null when no useful target exists (truncated to 60 chars).
 */
export function salientDetail(name: string, input: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  let detail: string | null;
  switch (name) {
    case "Bash":
      detail = str(input.description) ?? str(input.command);
      break;
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const p = str(input.file_path) ?? str(input.notebook_path);
      detail = p ? basename(p) : null;
      break;
    }
    case "Grep":
    case "Glob":
      detail = str(input.pattern);
      break;
    case "Task":
    case "Agent":
      detail = str(input.description) ?? str(input.subagent_type);
      break;
    default:
      detail = null;
  }
  return detail ? detail.slice(0, ACTIVITY_DETAIL_MAX) : null;
}

export function summarizeTodos(todos: TodoItem[] | null): TodoSnapshot | null {
  if (!todos || todos.length === 0) return null;
  let done = 0;
  let current: string | null = null;
  let next: string | null = null;
  for (const t of todos) {
    if (t.status === "completed") done++;
    else if (!current && t.status === "in_progress") current = t.content ?? "";
    else if (!next && t.status === "pending") next = t.content ?? "";
  }
  return { total: todos.length, done, current, next };
}

export function pendingSubagents(state: ParserState): PendingSubagent[] {
  const out: PendingSubagent[] = [];
  for (const [id, { desc, type }] of state.toolCallsById) {
    if (!state.resolvedToolIds.has(id)) out.push({ id, desc, type });
  }
  return out;
}

export function usageContextTokens(u: Record<string, unknown>): number {
  const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
}
