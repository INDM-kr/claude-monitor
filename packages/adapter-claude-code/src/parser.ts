import type { PendingSubagent, TodoSnapshot } from "@claude-monitor/core";

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const TODO_TOOL = "TodoWrite";
const LAST_TEXT_MAX = 200;
const SUBAGENT_DESC_MAX = 40;

interface TodoItem {
  status: string;
  content?: string;
}

export interface ParserState {
  lastToolName: string | null;
  /** Task/Agent calls only — id → desc */
  toolCallsById: Map<string, { name: string; desc: string }>;
  /** tool_use ids that have received a tool_result */
  resolvedToolIds: Set<string>;
  /** latest TodoWrite snapshot */
  lastTodos: TodoItem[] | null;
  /** Last non-empty assistant text (already truncated) */
  lastText: string | null;
  /** byte offset of the next unread byte in the source file */
  byteOffset: number;
}

export function initial(): ParserState {
  return {
    lastToolName: null,
    toolCallsById: new Map(),
    resolvedToolIds: new Set(),
    lastTodos: null,
    lastText: null,
    byteOffset: 0,
  };
}

export interface ParsedLine {
  type?: string;
  message?: {
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

  if (obj?.type === "assistant") {
    for (const c of content) {
      if (c.type === "tool_use") {
        const name = String(c.name ?? "");
        const id = String(c.id ?? "");
        if (name) state.lastToolName = name;
        if (SUBAGENT_TOOLS.has(name) && id) {
          const input = (c.input ?? {}) as Record<string, unknown>;
          const rawDesc = input.description ?? input.subagent_type ?? "agent";
          const desc = String(rawDesc).slice(0, SUBAGENT_DESC_MAX);
          state.toolCallsById.set(id, { name, desc });
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
  for (const [id, { desc }] of state.toolCallsById) {
    if (!state.resolvedToolIds.has(id)) out.push({ id, desc });
  }
  return out;
}
