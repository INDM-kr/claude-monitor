import { describe, expect, it } from "vitest";
import { usageRunKey, type UsageSourceContext } from "@claude-monitor/core";
import {
  CODEX_USAGE_PARSER_VERSION, initialCodexUsageState, normalizeCodexUsageRecord, type CodexUsageState,
} from "../codex/usage-normalizer.js";

const DEVICE = "device-fixture";
const ROOT = "11111111-1111-7111-8111-111111111111";
const CHILD = "22222222-2222-7222-8222-222222222222";
let offset = 0;
function context(): UsageSourceContext {
  const byteStart = offset;
  offset += 100;
  return { deviceId: DEVICE, sourceId: "rollout.jsonl", sourcePath: "/codex/rollout.jsonl", generation: 0, byteStart, byteEnd: byteStart + 100, ingestedAt: 1 };
}
function meta(id: string, extra: Record<string, unknown> = {}) {
  return { timestamp: "2026-09-30T07:00:00.000Z", type: "session_meta", payload: { id, session_id: id, cwd: "/work/alpha", originator: "codex-tui", source: "vscode", ...extra } };
}
const turn = (turnId: string, model: string, cwd = "/work/alpha") =>
  ({ timestamp: "2026-09-30T07:00:01.000Z", type: "turn_context", payload: { turn_id: turnId, model, cwd } });
function usage(responseId: string | undefined, extra: Record<string, unknown> = {}, usageOverride: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-09-30T07:58:57.549Z", ordinal: 13, type: "token_usage_record",
    payload: {
      thread_id: ROOT, turn_id: "turn-1", session_id: ROOT, response_id: responseId,
      usage: { input_tokens: 20608, cached_input_tokens: 12928, cache_write_input_tokens: 0, output_tokens: 154, reasoning_output_tokens: 40, total_tokens: 20762, ...usageOverride },
      ...extra,
    },
  };
}
const event = (type: string, timestamp = "2026-09-30T08:00:00.000Z", ordinal = 20) => ({ timestamp, ordinal, type: "event_msg", payload: { type } });
function run(state: CodexUsageState, ...records: unknown[]) {
  return records.map((record) => normalizeCodexUsageRecord(record, context(), state));
}

describe("normalizeCodexUsageRecord", () => {
  it("projects a response usage record onto the ledger's uncached-input basis with the turn's model and cwd", () => {
    const state = initialCodexUsageState();
    const [, , step] = run(state, meta(ROOT), turn("turn-1", "gpt-test", "/work/alpha/sub"), usage("resp_1"));
    const o = step!.observation!;
    expect(o.providerId).toBe("codex");
    expect(o.responseId).toBe("resp_1");
    expect(o.model).toBe("gpt-test");
    expect(o.cwd).toBe("/work/alpha/sub");
    expect(o.tokens).toEqual({ input: 7680n, cacheRead: 12928n, cacheWrite: 0n, output: 154n });
    expect(o.tokens.input + o.tokens.cacheRead + o.tokens.cacheWrite + o.tokens.output).toBe(20762n);
    expect([o.cache5m, o.cache1h, o.costEligibility, o.parserVersion]).toEqual([0n, 0n, "eligible", CODEX_USAGE_PARSER_VERSION]);
    expect(o.eventAt).toBe(Date.parse("2026-09-30T07:58:57.549Z"));
    expect(o.run).toEqual({ key: usageRunKey(DEVICE, "codex", ROOT), nativeSessionId: ROOT, nativeAgentId: null, parentNativeSessionId: null, parentKey: null, workflowId: null });
    expect(step!.diagnostics).toEqual([]);
  });

  it("attributes a spawned sub-agent to the top-level thread and skips the replayed parent history", () => {
    const state = initialCodexUsageState();
    const spawn = { source: { subagent: { thread_spawn: { parent_thread_id: "mid-thread", depth: 2 } } }, parent_thread_id: "mid-thread", session_id: ROOT, subagent_history_start_ordinal: 10 };
    const recordAt = (thread: string | undefined, responseId: string, ordinal: number) => ({ ...usage(responseId, { thread_id: thread }), ordinal });
    const [, , replayed, unnamedReplay, replayedEvent, own] = run(state, meta(CHILD, spawn), turn("turn-1", "gpt-test"),
      recordAt(ROOT, "resp_parent", 5), recordAt(undefined, "resp_unnamed", 6), { ...event("task_started"), ordinal: 7 }, recordAt(CHILD, "resp_child", 12));
    expect([replayed!.ignored, unnamedReplay!.ignored, replayedEvent!.activity]).toEqual([true, true, null]);
    expect(own!.observation!.run).toEqual({
      key: usageRunKey(DEVICE, "codex", ROOT, ROOT, CHILD, null), nativeSessionId: ROOT, nativeAgentId: CHILD,
      parentNativeSessionId: ROOT, parentKey: usageRunKey(DEVICE, "codex", ROOT), workflowId: null,
    });
  });

  it("counts an internal review thread's usage without a run and emits no activity for it", () => {
    const state = initialCodexUsageState();
    // Observed: internal threads point the replay boundary past their own last line; their records name their own thread.
    const hidden = { source: { subagent: "review" }, session_id: ROOT, subagent_history_start_ordinal: 90 };
    const [, , step, activity] = run(state, meta(CHILD, hidden), turn("turn-1", "gpt-test"), usage("resp_review", { thread_id: CHILD }), { ...event("task_started"), ordinal: 95 });
    expect(step!.observation!.run.internal).toBe(true);
    expect(step!.observation!.run.nativeAgentId).toBe(CHILD);
    expect(activity!.activity).toBeNull();
  });

  it("ignores usage recorded for another thread", () => {
    const state = initialCodexUsageState();
    const [, , step] = run(state, meta(ROOT), turn("turn-1", "gpt-test"), usage("resp_x", { thread_id: CHILD }));
    expect(step!.ignored).toBe(true);
    expect(step!.observation).toBeNull();
  });

  it("reports a legacy file without response ids once, and never for a file that has usage records", () => {
    const legacy = initialCodexUsageState();
    const tokenCount = { timestamp: "2026-09-30T08:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1 } } } };
    const [, first, second] = run(legacy, meta(ROOT), tokenCount, tokenCount);
    expect(first!.diagnostics.map((d) => d.code)).toEqual(["missing_response_id"]);
    expect(second!.diagnostics).toEqual([]);
    const current = initialCodexUsageState();
    const steps = run(current, meta(ROOT), turn("turn-1", "gpt-test"), usage("resp_1"), tokenCount);
    expect(steps.flatMap((s) => s.diagnostics)).toEqual([]);
  });

  it("rejects records it cannot attribute or read", () => {
    expect(run(initialCodexUsageState(), usage("resp_1"))[0]!.diagnostics.map((d) => d.code)).toEqual(["missing_session_id"]);
    const noModel = initialCodexUsageState();
    expect(run(noModel, meta(ROOT), usage("resp_1"))[1]!.diagnostics.map((d) => d.code)).toEqual(["missing_model"]);
    const noId = initialCodexUsageState();
    expect(run(noId, meta(ROOT), turn("turn-1", "gpt-test"), usage(undefined))[2]!.diagnostics.map((d) => d.code)).toEqual(["missing_response_id"]);
    const badToken = initialCodexUsageState();
    expect(run(badToken, meta(ROOT), turn("turn-1", "gpt-test"), usage("resp_1", {}, { output_tokens: -1 }))[2]!.diagnostics.map((d) => d.code)).toEqual(["invalid_token"]);
    const badTime = initialCodexUsageState();
    expect(run(badTime, meta(ROOT), turn("turn-1", "gpt-test"), { ...usage("resp_1"), timestamp: "yesterday" })[2]!.diagnostics.map((d) => d.code)).toEqual(["invalid_timestamp"]);
  });

  it("flags cache splits it cannot vouch for without losing the observed tokens", () => {
    const over = initialCodexUsageState();
    const bad = run(over, meta(ROOT), turn("turn-1", "gpt-test"), usage("resp_1", {}, { cached_input_tokens: 30000 }))[2]!;
    expect(bad.observation!.costEligibility).toBe("invalid_cache_split");
    expect(bad.observation!.tokens.input).toBe(0n);
    expect(bad.diagnostics.map((d) => d.code)).toEqual(["invalid_cache_split"]);
    const writes = initialCodexUsageState();
    const unknown = run(writes, meta(ROOT), turn("turn-1", "gpt-test"), usage("resp_2", {}, { cache_write_input_tokens: 500 }))[2]!;
    expect(unknown.observation!.costEligibility).toBe("unknown_cache_split");
    expect([unknown.observation!.cache5m, unknown.observation!.cache1h, unknown.observation!.tokens.cacheWrite]).toEqual([null, null, 500n]);
  });

  it("maps rollout task events onto runtime activity for the thread's run", () => {
    const state = initialCodexUsageState();
    const steps = run(state, meta(ROOT), event("task_started", "2026-09-30T08:00:00.000Z"), event("item_completed", "2026-09-30T08:00:05.000Z"),
      event("task_complete", "2026-09-30T08:00:09.000Z"), event("turn_aborted", "2026-09-30T08:01:00.000Z"), event("thread_settings_applied"), event("task_started", "not-a-time"));
    expect(steps.slice(1).map((s) => s.activity?.eventName ?? null)).toEqual(["UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", null, null]);
    expect(steps[3]!.activity).toEqual({ run: expect.objectContaining({ nativeSessionId: ROOT, nativeAgentId: null }), cwd: "/work/alpha", eventName: "Stop", observedAt: Date.parse("2026-09-30T08:00:09.000Z") });
  });

  it("resumes from a JSON checkpoint of its state and bounds remembered turns", () => {
    const state = initialCodexUsageState();
    run(state, meta(ROOT));
    for (let i = 0; i < 70; i++) run(state, turn(`turn-${i}`, `model-${i}`));
    expect(state.turns).toHaveLength(64);
    const resumed = JSON.parse(JSON.stringify(state)) as CodexUsageState;
    const step = run(resumed, usage("resp_1", { turn_id: "turn-69" }))[0]!;
    expect(step.observation!.model).toBe("model-69");
    const forgotten = run(resumed, usage("resp_2", { turn_id: "turn-0" }))[0]!;
    expect(forgotten.observation!.model).toBe("model-69");
  });
});
