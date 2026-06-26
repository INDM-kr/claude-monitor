import { basename } from "node:path";
import type { PendingSubagent, TodoSnapshot } from "@claude-monitor/core";

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const TODO_TOOL = "TodoWrite";
const TASK_CREATE = "TaskCreate";
const TASK_UPDATE = "TaskUpdate";
const LAST_TEXT_MAX = 200;
const SUBAGENT_DESC_MAX = 40;
const ACTIVITY_DETAIL_MAX = 60;
const HUMAN_TURN_MAX = 200;
const USER_TURNS_CAP = 100;

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
  /** TaskCreate/TaskUpdate task list (id → subject/status), creation order. */
  tasks: Map<string, { subject: string; status: string }>;
  taskSeq: number;
  /** Last non-empty assistant text (already truncated) */
  lastText: string | null;
  /** Real human turns in order (system/command/meta/tool-result skipped, truncated). */
  userTurns: string[];
  /** epoch ms of the most recent human turn (current turn start); null if none. */
  lastUserTurnTsMs: number | null;
  /** tokens processed since the last human turn (reset on each human turn). */
  turnTokens: number;
  /** type of the most recent record ("assistant"|"user"); drives endedTurn. */
  lastRecordType: "assistant" | "user" | null;
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
  // --- agent metrics + lifecycle (meaningful for sub-agent child transcripts) ---
  /** Σ(input + cache_creation + output) across the whole transcript. */
  totalTokens: number;
  /** Number of tool_use calls. */
  toolCount: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** stop_reason of the last assistant message ("end_turn" = finished cleanly). */
  lastStopReason: string | null;
  /** Saw an API-error / error line. */
  sawError: boolean;
  /** Saw an explicit user-interruption marker. */
  sawCancelled: boolean;
  /** Workflow phase, when the agent carries one (tool_use input.phase). */
  phase: string | null;
}

export function initial(): ParserState {
  return {
    lastToolName: null,
    lastActivityDetail: null,
    toolCallsById: new Map(),
    resolvedToolIds: new Set(),
    lastTodos: null,
    tasks: new Map(),
    taskSeq: 0,
    lastText: null,
    userTurns: [],
    lastUserTurnTsMs: null,
    turnTokens: 0,
    lastRecordType: null,
    byteOffset: 0,
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    mode: null,
    model: null,
    contextTokens: null,
    totalTokens: 0,
    toolCount: 0,
    firstTsMs: null,
    lastTsMs: null,
    lastStopReason: null,
    sawError: false,
    sawCancelled: false,
    phase: null,
  };
}

export interface ParsedLine {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  permissionMode?: string;
  timestamp?: string;
  isApiErrorMessage?: boolean;
  /** Conductor/harness-injected non-human record (skill preamble, etc.). */
  isMeta?: boolean;
  error?: unknown;
  message?: {
    model?: string;
    usage?: Record<string, unknown>;
    /** Human prompts are a STRING; tool_results/assistant blocks are an array. */
    content?: string | Array<Record<string, unknown>>;
    stop_reason?: string;
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

  if (typeof obj.timestamp === "string") {
    const ms = Date.parse(obj.timestamp);
    if (Number.isFinite(ms)) {
      if (state.firstTsMs == null) state.firstTsMs = ms;
      state.lastTsMs = ms;
    }
  }
  if (obj.isApiErrorMessage === true || obj.error != null) state.sawError = true;
  if (line.includes("interrupted by user") || line.includes("Request interrupted")) {
    state.sawCancelled = true;
  }

  const msg = obj.message;
  if (msg) {
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") state.model = msg.model;
    if (msg.usage) {
      state.contextTokens = usageContextTokens(msg.usage);
      const mt = metricTokens(msg.usage);
      state.totalTokens += mt;
      state.turnTokens += mt; // reset to 0 on each new human turn (below)
    }
    if (typeof msg.stop_reason === "string") state.lastStopReason = msg.stop_reason;
  }

  if (obj?.type === "assistant") {
    state.lastRecordType = "assistant";
    for (const c of content) {
      if (c.type === "tool_use") {
        const name = String(c.name ?? "");
        const id = String(c.id ?? "");
        state.toolCount++;
        const inputAny = (c.input ?? {}) as Record<string, unknown>;
        if (typeof inputAny.phase === "string" && inputAny.phase) state.phase = inputAny.phase;
        if (name) {
          state.lastToolName = name;
          state.lastActivityDetail = salientDetail(name, inputAny);
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
        if (name === TASK_CREATE) {
          const subject = typeof inputAny.subject === "string" ? inputAny.subject : "";
          state.taskSeq++;
          state.tasks.set(String(state.taskSeq), { subject, status: "pending" });
        }
        if (name === TASK_UPDATE) {
          const tid = inputAny.taskId != null ? String(inputAny.taskId) : "";
          const tk = state.tasks.get(tid);
          if (tk && typeof inputAny.status === "string") tk.status = inputAny.status;
        }
      } else if (c.type === "text") {
        const text = String(c.text ?? "").trim();
        if (text) {
          state.lastText = text.slice(0, LAST_TEXT_MAX);
        }
      }
    }
  } else if (obj?.type === "user") {
    state.lastRecordType = "user";
    // A real human turn = STRING content, not meta, not a wrapper (<system_instruction>,
    // <command-name>, …). tool_result records are arrays → skipped here.
    const raw = obj.message?.content;
    if (isHumanTurn(obj, raw)) {
      state.userTurns.push(raw.trim().slice(0, HUMAN_TURN_MAX));
      // Preserve the original task ([0]); drop oldest-after-first when over cap.
      if (state.userTurns.length > USER_TURNS_CAP) state.userTurns.splice(1, 1);
      state.turnTokens = 0; // a new turn begins
      if (state.lastTsMs != null) state.lastUserTurnTsMs = state.lastTsMs;
    }
    for (const c of content) {
      if (c.type === "tool_result") {
        const id = c.tool_use_id;
        if (typeof id === "string") state.resolvedToolIds.add(id);
      }
    }
  }

  return state;
}

/** Single-char option answers ("A", "B", "1", "2", optionally "A)" / "1.") that
 *  reply to a Claude question — not a real request, so excluded from the turns. */
const OPTION_ANSWER_RE = /^[A-Za-z0-9][).]?$/;

/** Real human turn: not meta, STRING content, non-empty, not a wrapper tag, and
 *  not a single-char answer to a Claude question. */
function isHumanTurn(obj: ParsedLine, raw: unknown): raw is string {
  if (obj.isMeta === true) return false;
  if (typeof raw !== "string") return false;
  const t = raw.trim();
  if (t.length === 0 || t.startsWith("<")) return false;
  if (OPTION_ANSWER_RE.test(t)) return false;
  return true;
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

/** Summarize the TaskCreate/TaskUpdate task list into the TodoSnapshot shape
 *  (so it renders through the same UI as TodoWrite todos). */
export function summarizeTasks(state: ParserState): TodoSnapshot | null {
  if (state.tasks.size === 0) return null;
  let done = 0;
  let current: string | null = null;
  let next: string | null = null;
  for (const t of state.tasks.values()) {
    if (t.status === "completed") done++;
    else if (!current && t.status === "in_progress") current = t.subject;
    else if (!next && t.status === "pending") next = t.subject;
  }
  return { total: state.tasks.size, done, current, next };
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

/** Tokens processed this turn (excludes cache_read re-reads), summed for metrics. */
export function metricTokens(u: Record<string, unknown>): number {
  const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
}
