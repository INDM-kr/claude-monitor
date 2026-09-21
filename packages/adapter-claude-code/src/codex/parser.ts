import type { TodoSnapshot } from "@claude-monitor/core";
import { summarizeTodos } from "../parser.js";
import { parseCodexMeta, type CodexMeta } from "./meta.js";

const LAST_TEXT_MAX = 200;
const HUMAN_TURN_MAX = 200;
const USER_TURNS_CAP = 100;
const ACTIVITY_DETAIL_MAX = 60;

/** `role:"user"` preambles the Codex app injects around the person's request
 *  (observed on disk; each is its own message record, so dropping them keeps
 *  the real request intact). Angle-bracket wrappers (`<environment_context>`,
 *  `<recommended_plugins>`, `<send_user_message_question_reply>`, …) are
 *  handled by the leading-`<` rule. */
const HIDDEN_USER_PREFIXES = [
  "# Files mentioned by the user",
  "# Files pasted by the user",
  "# Selected text",
  "# AGENTS.md instructions",
];

export interface CodexUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface CodexPlanStep {
  step: string;
  status: string;
}

export interface CodexState {
  meta: CodexMeta | null;
  /** Records with `ordinal` below this are the parent's copied history (sub-agent files). */
  skipBeforeOrdinal: number | null;
  /** Line counter, the ordinal fallback for records without one. */
  lineIndex: number;
  cwd: string | null;
  version: string | null;
  originator: string | null;
  model: string | null;
  /** `turn_context.approval_policy` ("on-request" | "never" | …). */
  mode: string | null;
  lastToolName: string | null;
  lastActivityDetail: string | null;
  toolCount: number;
  /** Latest `update_plan` steps. */
  lastPlan: CodexPlanStep[] | null;
  lastText: string | null;
  userTurns: string[];
  userResponses: string[];
  lastUserTurnTsMs: number | null;
  turnTokens: number;
  totalTokens: number;
  /** Last cumulative usage seen — the delta baseline. */
  lastCum: CodexUsage | null;
  /** Count of folded token_count events (with info) — lets series readers
   *  detect "this line was a token event" without re-parsing. */
  tokenEvents: number;
  contextTokens: number | null;
  contextLimit: number | null;
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** Timestamp of the first token_count that added tokens (session start). */
  firstTokenTsMs: number | null;
  /** The last turn-level event was task_complete/turn_aborted and nothing
   *  active (human turn, reply, tool call, task_started) came after. */
  endedTurn: boolean;
  /** The current/last turn finished with task_complete. */
  lastTurnClean: boolean;
  /** The current/last turn ended with turn_aborted. */
  sawCancelled: boolean;
}

export function initialCodex(): CodexState {
  return {
    meta: null,
    skipBeforeOrdinal: null,
    lineIndex: 0,
    cwd: null,
    version: null,
    originator: null,
    model: null,
    mode: null,
    lastToolName: null,
    lastActivityDetail: null,
    toolCount: 0,
    lastPlan: null,
    lastText: null,
    userTurns: [],
    userResponses: [],
    lastUserTurnTsMs: null,
    turnTokens: 0,
    totalTokens: 0,
    lastCum: null,
    tokenEvents: 0,
    contextTokens: null,
    contextLimit: null,
    firstTsMs: null,
    lastTsMs: null,
    firstTokenTsMs: null,
    endedTurn: false,
    lastTurnClean: false,
    sawCancelled: false,
  };
}

interface RawRecord {
  timestamp?: unknown;
  ordinal?: unknown;
  type?: unknown;
  payload?: Record<string, unknown> | null;
}

/**
 * Fold one rollout line into the state. Throws on malformed JSON (the tail
 * loop treats that as a partial write and rolls back to the line start).
 */
export function foldCodex(state: CodexState, line: string): CodexState {
  const obj = JSON.parse(line) as RawRecord | null;
  // A complete line that is valid JSON but not an object (`null`, a number, a
  // string) is a corrupt record, not a partial write. Skip it: throwing here
  // would make the tail loop roll back to this line on every pass and freeze
  // the reader at it forever while the file keeps growing.
  if (obj == null || typeof obj !== "object") {
    state.lineIndex++;
    return state;
  }
  const ordinal = typeof obj.ordinal === "number" ? obj.ordinal : state.lineIndex;
  state.lineIndex++;
  const p = (obj.payload != null && typeof obj.payload === "object" ? obj.payload : {}) as Record<string, unknown>;
  const tsMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;

  if (obj.type === "session_meta") {
    if (state.meta != null) return state; // sub-agent files repeat the parent's meta
    const meta = parseCodexMeta(line);
    if (!meta) return state;
    state.meta = meta;
    state.cwd = meta.cwd;
    state.version = meta.cliVersion;
    state.originator = meta.originator;
    state.skipBeforeOrdinal = meta.subagentHistoryStartOrdinal;
    stampTs(state, tsMs);
    return state;
  }
  if (state.skipBeforeOrdinal != null && ordinal < state.skipBeforeOrdinal) return state;
  stampTs(state, tsMs);

  switch (obj.type) {
    case "event_msg":
      foldEvent(state, p, tsMs);
      break;
    case "response_item":
      foldResponseItem(state, p, tsMs);
      break;
    case "turn_context":
      if (typeof p.model === "string" && p.model) state.model = p.model;
      if (typeof p.approval_policy === "string" && p.approval_policy) state.mode = p.approval_policy;
      break;
    default:
      break;
  }
  return state;
}

function stampTs(state: CodexState, tsMs: number): void {
  if (!Number.isFinite(tsMs)) return;
  if (state.firstTsMs == null) state.firstTsMs = tsMs;
  state.lastTsMs = tsMs;
}

function foldEvent(state: CodexState, p: Record<string, unknown>, tsMs: number): void {
  switch (p.type) {
    case "task_started":
      if (typeof p.model_context_window === "number" && p.model_context_window > 0) {
        state.contextLimit = p.model_context_window;
      }
      state.endedTurn = false;
      state.lastTurnClean = false;
      state.sawCancelled = false;
      break;
    case "task_complete":
      state.endedTurn = true;
      state.lastTurnClean = true;
      break;
    case "turn_aborted":
      state.endedTurn = true;
      state.lastTurnClean = false;
      state.sawCancelled = true;
      break;
    case "token_count":
      foldTokenCount(state, p.info, tsMs);
      break;
    default:
      break;
  }
}

function foldTokenCount(state: CodexState, info: unknown, tsMs: number): void {
  if (info == null || typeof info !== "object") return;
  const i = info as Record<string, unknown>;
  if (typeof i.model_context_window === "number" && i.model_context_window > 0) {
    state.contextLimit = i.model_context_window;
  }
  const last = usageOf(i.last_token_usage);
  // Context occupancy: the last response's total minus its reasoning output —
  // the formula the Codex TUI uses for "% context left" (as recalled from
  // codex-rs TokenUsage::tokens_in_context_window; not verified against source).
  if (last) state.contextTokens = Math.max(0, last.total - last.reasoning);
  const cum = usageOf(i.total_token_usage);
  if (!cum) return;
  state.tokenEvents++;
  // Cumulative deltas: token_count is re-emitted with identical usage (rate
  // limit refreshes), so summing last_token_usage would overcount. A drop in
  // total_tokens means a fresh cumulative (e.g. after a window switch).
  const m = metricOf(cum);
  const reset = state.lastCum != null && cumulativeDecreased(cum, state.lastCum);
  const delta = state.lastCum == null || reset ? m : Math.max(0, m - metricOf(state.lastCum));
  state.lastCum = cum;
  if (delta > 0) {
    state.totalTokens += delta;
    state.turnTokens += delta;
    if (state.firstTokenTsMs == null && Number.isFinite(tsMs)) state.firstTokenTsMs = tsMs;
  }
}

/** Any cumulative component going backwards means a fresh cumulative (new
 *  context window / thread), not a delta — checked per component, since a new
 *  cumulative's first total can already exceed the old one. */
function cumulativeDecreased(cur: CodexUsage, prev: CodexUsage): boolean {
  return cur.total < prev.total || cur.input < prev.input || cur.cached < prev.cached || cur.output < prev.output;
}

export function usageOf(u: unknown): CodexUsage | null {
  if (u == null || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  // Token counts are non-negative finite integers; anything else (negative,
  // NaN, Infinity, non-number) is a corrupt field and counts as 0.
  const n = (k: string): number => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  return {
    input: n("input_tokens"),
    cached: n("cached_input_tokens"),
    cacheWrite: n("cache_write_input_tokens"),
    output: n("output_tokens"),
    reasoning: n("reasoning_output_tokens"),
    total: n("total_tokens"),
  };
}

/** Work processed — comparable to the Claude adapter's metricTokens: uncached
 *  input + cache writes + output (OpenAI's input_tokens INCLUDES cached tokens). */
export function metricOf(u: CodexUsage): number {
  return Math.max(0, u.input - u.cached) + u.cacheWrite + u.output;
}

function foldResponseItem(state: CodexState, p: Record<string, unknown>, tsMs: number): void {
  switch (p.type) {
    case "message": {
      if (p.role === "user") {
        const text = joinText(p.content, "input_text");
        if (!isCodexHumanTurn(text)) return;
        state.userTurns.push(text.trim().slice(0, HUMAN_TURN_MAX));
        state.userResponses.push("");
        if (state.userTurns.length > USER_TURNS_CAP) {
          state.userTurns.splice(1, 1);
          state.userResponses.splice(1, 1);
        }
        state.turnTokens = 0;
        if (Number.isFinite(tsMs)) state.lastUserTurnTsMs = tsMs;
        state.endedTurn = false;
      } else if (p.role === "assistant") {
        const t = joinText(p.content, "output_text").trim();
        if (!t) return;
        state.lastText = t.slice(0, LAST_TEXT_MAX);
        if (state.userResponses.length > 0) state.userResponses[state.userResponses.length - 1] = state.lastText;
        state.endedTurn = false;
      }
      return;
    }
    case "function_call": {
      const name = typeof p.name === "string" ? p.name : "";
      if (!name) return;
      const args = parseArgs(p.arguments);
      state.toolCount++;
      state.lastToolName = name;
      state.lastActivityDetail = codexToolDetail(name, args);
      state.endedTurn = false;
      if (name === "update_plan" && Array.isArray(args.plan)) state.lastPlan = planSteps(args.plan);
      return;
    }
    case "custom_tool_call": {
      const name = typeof p.name === "string" ? p.name : "";
      if (!name) return;
      state.toolCount++;
      state.endedTurn = false;
      const input = typeof p.input === "string" ? p.input : "";
      // Codex's `exec` custom tool runs a JS snippet that calls `tools.<name>(…)`;
      // the inner tool is what the agent is actually doing.
      const inner = name === "exec" ? input.match(/tools\.([A-Za-z0-9_]+)\(/) : null;
      state.lastToolName = inner ? inner[1]! : name;
      state.lastActivityDetail = name === "exec" ? execScriptDetail(input) : null;
      return;
    }
    default:
      return;
  }
}

function joinText(content: unknown, wantedType: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c != null && typeof c === "object") {
      const r = c as { type?: unknown; text?: unknown };
      if (r.type === wantedType && typeof r.text === "string") out += r.text;
    }
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw != null && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function planSteps(plan: unknown[]): CodexPlanStep[] {
  const out: CodexPlanStep[] = [];
  for (const it of plan) {
    if (it == null || typeof it !== "object") continue;
    const r = it as { step?: unknown; status?: unknown };
    out.push({ step: typeof r.step === "string" ? r.step : "", status: typeof r.status === "string" ? r.status : "" });
  }
  return out;
}

/** A real human turn: non-empty, not an app wrapper (`<tag>` or a known `# …` preamble). */
export function isCodexHumanTurn(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.startsWith("<")) return false;
  return !HIDDEN_USER_PREFIXES.some((prefix) => t.startsWith(prefix));
}

/** Human-readable target of a `function_call` (≤ 60 chars) or null. */
export function codexToolDetail(name: string, args: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  let detail: string | null;
  switch (name) {
    case "exec_command":
      detail = str(args.cmd);
      break;
    case "js":
      detail = str(args.title) ?? str(args.code);
      break;
    case "spawn_agent":
      detail = str(args.task_name);
      break;
    case "send_message":
    case "followup_task":
      detail = str(args.target);
      break;
    case "request_user_input_async": {
      const q = Array.isArray(args.questions) ? args.questions[0] : null;
      detail = q != null && typeof q === "object" ? str((q as { title?: unknown }).title) : null;
      break;
    }
    default:
      detail = null;
  }
  return detail ? detail.slice(0, ACTIVITY_DETAIL_MAX) : null;
}

const CMD_RE = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const QUERY_RE = /\bq\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;

/** The shell command (`cmd:"…"`) or first search query (`q:'…'`) inside an
 *  `exec` JS snippet, ≤ 60 chars; null when neither is present. */
export function execScriptDetail(input: string): string | null {
  const m = input.match(CMD_RE) ?? input.match(QUERY_RE);
  const d = m ? m[2]!.trim() : "";
  return d ? d.slice(0, ACTIVITY_DETAIL_MAX) : null;
}

/** The latest `update_plan` as a TodoSnapshot (same UI as TodoWrite). */
export function codexTodo(state: CodexState): TodoSnapshot | null {
  if (!state.lastPlan) return null;
  return summarizeTodos(state.lastPlan.map((s) => ({ status: s.status, content: s.step })));
}
