import {
  usageIdentityKey, usageRunKey,
  type NormalizedUsageObservation, type UsageDiagnostic, type UsageDiagnosticCode,
  type UsageRunIdentity, type UsageSourceContext, type UsageTokens,
} from "@claude-monitor/core";
import { eventTimestamp, token, validateContext } from "../usage-normalizer.js";
import { CODEX_ADAPTER_ID } from "./constants.js";
import { parseCodexMetaRecord, type CodexThreadKind } from "./meta.js";

export const CODEX_USAGE_PARSER_VERSION = "codex-usage-v1";
/** Turns remembered for model/cwd lookup; a usage record belongs to the turn it was produced in. */
const TURN_MEMORY = 64;

/**
 * Per-file reading state. Codex usage lines carry no cwd or model, so the ledger
 * checkpoints this (JSON) with the byte offset and resumes mid-file from it.
 */
export interface CodexUsageState {
  threadId: string | null;
  /** `session_meta.session_id`: the top-level thread of a spawn tree (itself for a user thread). */
  rootThreadId: string | null;
  kind: CodexThreadKind | null;
  cwd: string | null;
  /** Spawned sub-agent files open with a replay of the parent's history below this ordinal. Internal
   *  (review/approval) threads set it past their own last line, so it only filters activity, never usage. */
  historyStart: number | null;
  /** Most recent turns as [turnId, model, cwd]. */
  turns: [string, string | null, string | null][];
  lastModel: string | null;
  sawUsageRecord: boolean;
  legacyReported: boolean;
}

export function initialCodexUsageState(): CodexUsageState {
  return { threadId: null, rootThreadId: null, kind: null, cwd: null, historyStart: null, turns: [], lastModel: null, sawUsageRecord: false, legacyReported: false };
}

/** Rollout events mapped onto the runtime vocabulary (approval/input waits are not in the rollout log). */
export type CodexActivityEvent = "UserPromptSubmit" | "PostToolUse" | "Stop" | "StopFailure";
const ACTIVITY: Record<string, CodexActivityEvent> = {
  task_started: "UserPromptSubmit", item_completed: "PostToolUse", task_complete: "Stop", turn_aborted: "StopFailure",
};
export interface CodexActivity { run: UsageRunIdentity; cwd: string | null; eventName: CodexActivityEvent; observedAt: number }
export interface CodexUsageStep {
  observation: NormalizedUsageObservation | null;
  activity: CodexActivity | null;
  diagnostics: UsageDiagnostic[];
  ignored: boolean;
}

const ownObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

function runIdentity(deviceId: string, state: CodexUsageState): UsageRunIdentity {
  const thread = state.threadId!, root = state.rootThreadId ?? thread;
  const internal = state.kind === "hidden" ? { internal: true } : {};
  if (state.kind === "user" || root === thread) {
    return { key: usageRunKey(deviceId, CODEX_ADAPTER_ID, thread), nativeSessionId: thread, nativeAgentId: null, parentNativeSessionId: null, parentKey: null, workflowId: null, ...internal };
  }
  // Nested spawns are flattened under the top-level thread, like Claude sub-agents under their session.
  return {
    key: usageRunKey(deviceId, CODEX_ADAPTER_ID, root, root, thread, null), nativeSessionId: root, nativeAgentId: thread,
    parentNativeSessionId: root, parentKey: usageRunKey(deviceId, CODEX_ADAPTER_ID, root), workflowId: null, ...internal,
  };
}

function turnOf(state: CodexUsageState, turnId: string | null): [string, string | null, string | null] | undefined {
  return turnId === null ? undefined : state.turns.find((turn) => turn[0] === turnId);
}

/**
 * Advance `state` by one parsed rollout line. Usage comes only from `token_usage_record`
 * (one per model response, keyed by `response_id`); older rollouts that only carry
 * cumulative `token_count` snapshots are reported once per file and not counted.
 */
export function normalizeCodexUsageRecord(record: unknown, context: UsageSourceContext, state: CodexUsageState): CodexUsageStep {
  validateContext(context);
  const diagnostics: UsageDiagnostic[] = [];
  let identityKey: string | null = null;
  const diagnostic = (code: UsageDiagnosticCode): void => {
    diagnostics.push({ code, sourceId: context.sourceId, generation: context.generation, byteStart: context.byteStart, identityKey });
  };
  const ignored = (): CodexUsageStep => ({ observation: null, activity: null, diagnostics, ignored: true });
  const invalid = (code: UsageDiagnosticCode): CodexUsageStep => {
    diagnostic(code);
    return { observation: null, activity: null, diagnostics, ignored: false };
  };
  const data = ownObject(record);
  if (!data) return invalid("invalid_record");
  const payload = ownObject(data.payload);

  if (data.type === "session_meta") {
    const meta = parseCodexMetaRecord(record);
    if (!meta) return invalid("missing_session_id");
    if (state.threadId === null) {
      state.threadId = meta.id;
      state.rootThreadId = identifier(payload?.session_id) ?? meta.id;
      state.kind = meta.kind;
      state.cwd = meta.cwd;
      state.historyStart = meta.subagentHistoryStartOrdinal;
    }
    return ignored();
  }
  if (data.type === "turn_context" && payload) {
    const turnId = identifier(payload.turn_id), model = identifier(payload.model), cwd = identifier(payload.cwd);
    if (model) state.lastModel = model;
    if (turnId) {
      state.turns = [...state.turns.filter((turn) => turn[0] !== turnId), [turnId, model, cwd]];
      if (state.turns.length > TURN_MEMORY) state.turns = state.turns.slice(-TURN_MEMORY);
    }
    return ignored();
  }
  const ordinal = typeof data.ordinal === "number" ? data.ordinal : null;
  const replayed = state.historyStart !== null && ordinal !== null && ordinal < state.historyStart;

  if (data.type === "event_msg" && payload) {
    // Replayed parent events describe the parent's turns, not this thread's.
    if (replayed) return ignored();
    if (payload.type === "token_count" && payload.info != null && !state.sawUsageRecord && !state.legacyReported) {
      state.legacyReported = true;
      return invalid("missing_response_id");
    }
    const eventName = typeof payload.type === "string" ? ACTIVITY[payload.type] : undefined;
    if (!eventName || state.threadId === null || state.kind === "hidden") return ignored();
    const observedAt = eventTimestamp(data.timestamp);
    if (observedAt === null) return ignored();
    return { observation: null, activity: { run: runIdentity(context.deviceId, state), cwd: state.cwd, eventName, observedAt }, diagnostics, ignored: false };
  }
  if (data.type !== "token_usage_record") return ignored();
  if (!payload) return invalid("invalid_record");
  if (state.threadId === null) return invalid("missing_session_id");
  // Usage belongs to the thread named on the record; without one, fall back to the replay boundary.
  const recordThread = identifier(payload.thread_id);
  if (recordThread !== null ? recordThread !== state.threadId : replayed) return ignored();
  const responseId = identifier(payload.response_id);
  if (!responseId) return invalid("missing_response_id");
  identityKey = usageIdentityKey(context.deviceId, CODEX_ADAPTER_ID, responseId);
  state.sawUsageRecord = true;
  if (data.timestamp === undefined || data.timestamp === null) return invalid("missing_timestamp");
  const eventAt = eventTimestamp(data.timestamp);
  if (eventAt === null) return invalid("invalid_timestamp");
  const turn = turnOf(state, identifier(payload.turn_id));
  const model = turn?.[1] ?? state.lastModel;
  if (!model) return invalid("missing_model");
  const usage = ownObject(payload.usage);
  if (!usage) return invalid("missing_usage");
  const input = token(usage.input_tokens), cached = token(usage.cached_input_tokens), output = token(usage.output_tokens);
  const cacheWrite = usage.cache_write_input_tokens === undefined || usage.cache_write_input_tokens === null ? 0n : token(usage.cache_write_input_tokens);
  for (const value of [input, cached, output, cacheWrite]) if (typeof value === "string") return invalid(value);
  const inputTotal = input as bigint, cacheRead = cached as bigint, written = cacheWrite as bigint;
  // Codex input counts cached tokens; the ledger stores the uncached part like Claude's input_tokens.
  let costEligibility: NormalizedUsageObservation["costEligibility"] = "eligible";
  if (cacheRead > inputTotal) costEligibility = "invalid_cache_split";
  // Unobserved so far: whether cache writes are also counted inside input_tokens.
  else if (written > 0n) costEligibility = "unknown_cache_split";
  if (costEligibility !== "eligible") diagnostic(costEligibility);
  const tokens: UsageTokens = { input: cacheRead > inputTotal ? 0n : inputTotal - cacheRead, output: output as bigint, cacheRead, cacheWrite: written };
  const observation: NormalizedUsageObservation = {
    identityKey, deviceId: context.deviceId, providerId: CODEX_ADAPTER_ID,
    sourceId: context.sourceId, generation: context.generation, byteStart: context.byteStart,
    byteEnd: context.byteEnd, ingestedAt: context.ingestedAt,
    recordId: null, responseId, requestId: null, model, eventAt, tokens,
    cache5m: written === 0n ? 0n : null, cache1h: written === 0n ? 0n : null, costEligibility,
    run: runIdentity(context.deviceId, state), cwd: turn?.[2] ?? state.cwd,
    serviceTier: null, inferenceGeo: null, speed: null, parserVersion: CODEX_USAGE_PARSER_VERSION,
  };
  return { observation, activity: null, diagnostics, ignored: false };
}
