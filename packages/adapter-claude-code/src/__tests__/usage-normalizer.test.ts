import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sumUsageTokens, usageTotal, type NormalizedUsageObservation, type UsageSourceContext } from "@claude-monitor/core";
import { normalizeUsageRecord, reconcileUsageObservations, USAGE_PARSER_VERSION } from "../usage-normalizer.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/l0/${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(fixture("manifest.json"));
const cases = JSON.parse(fixture("synthetic-cases.json"));
const original = cases[0].entries[0].record;
const record = (): any => structuredClone(original);
function context(overrides: Partial<UsageSourceContext> = {}): UsageSourceContext {
  return { deviceId: "device-fixture", sourceId: "parent.jsonl", sourcePath: "parent.jsonl", generation: 1, byteStart: 0, byteEnd: 100, ingestedAt: Date.parse("2026-09-25T03:00:00.000Z"), ...overrides };
}
function normalize(input: unknown, overrides: Partial<UsageSourceContext> = {}): NormalizedUsageObservation {
  const result = normalizeUsageRecord(input, context(overrides));
  expect(result.observation).not.toBeNull();
  return result.observation!;
}
function normalizedEntries(entries: any[]): { observations: NormalizedUsageObservation[]; diagnostics: unknown[] } {
  const offsets = new Map<string, number>();
  const observations: NormalizedUsageObservation[] = [], diagnostics: unknown[] = [];
  for (const entry of entries) {
    const key = JSON.stringify([entry.source, entry.generation]);
    const byteStart = offsets.get(key) ?? 0;
    const byteEnd = byteStart + Buffer.byteLength(JSON.stringify(entry.record)) + 1;
    offsets.set(key, byteEnd);
    const result = normalizeUsageRecord(entry.record, context({ sourceId: entry.source, sourcePath: entry.source, generation: entry.generation, byteStart, byteEnd }));
    if (result.observation) observations.push(result.observation);
    diagnostics.push(...result.diagnostics);
  }
  return { observations, diagnostics };
}
function canonicalTotal(observations: NormalizedUsageObservation[]): bigint {
  return usageTotal(sumUsageTokens(reconcileUsageObservations(observations).records.filter((r) => r.validity === "valid").map((r) => r.tokens)));
}

describe("L0 golden observations through the product normalizer", () => {
  for (const golden of manifest.observed) it(golden.file, () => {
    const records = fixture(golden.file).trim().split("\n").map((line) => JSON.parse(line));
    const { observations, diagnostics } = normalizedEntries(records.map((value) => ({ source: golden.source ?? golden.file, generation: 1, record: value })));
    const projection = reconcileUsageObservations(observations);
    const valid = projection.records.filter((row) => row.validity === "valid");
    expect(valid).toHaveLength(golden.expectedRequests);
    expect(usageTotal(sumUsageTokens(valid.map((row) => row.tokens)))).toBe(BigInt(golden.expectedTokens));
    expect(projection.diagnostics).toHaveLength(0);
    expect(diagnostics).toHaveLength(golden.costEligible === false ? 1 : 0);
    if (golden.costEligible === false) expect(valid[0]?.costEligibility).toBe("invalid_cache_split");
    if (golden.parentSessionId) {
      expect(valid[0]?.run.parentNativeSessionId).toBe(golden.parentSessionId);
      expect(valid[0]?.run.nativeAgentId).toBe("agent-child");
      expect(valid[0]?.run.key).not.toBe(valid[0]?.run.parentKey);
    }
  });
  for (const golden of cases) it(golden.name, () => {
    // acceptedIndexes is deliberately never consulted: only raw records/locations
    // enter the implementation. Calendar scope is applied to its canonical rows.
    const { observations, diagnostics } = normalizedEntries(golden.entries);
    const projection = reconcileUsageObservations(observations);
    const valid = projection.records.filter((row) => row.validity === "valid" && (!golden.fromUtc || row.firstEventAt >= Date.parse(golden.fromUtc)) && (!golden.toUtc || row.firstEventAt < Date.parse(golden.toUtc)));
    expect(valid).toHaveLength(golden.expectedRequests);
    expect(usageTotal(sumUsageTokens(valid.map((row) => row.tokens)))).toBe(BigInt(golden.expectedTokens));
    expect([...diagnostics, ...projection.diagnostics]).toHaveLength(golden.expectedDiagnostics ?? 0);
    expect(reconcileUsageObservations([...observations].reverse())).toEqual(projection);
    if (golden.expectedByModel) for (const [model, total] of Object.entries(golden.expectedByModel)) {
      expect(usageTotal(sumUsageTokens(valid.filter((row) => row.model === model).map((row) => row.tokens)))).toBe(BigInt(total as number));
    }
    if (golden.name === "parent-child-rollup") {
      expect(new Set(valid.map((row) => row.run.key)).size).toBe(2);
      expect(new Set(valid.map((row) => row.run.nativeSessionId)).size).toBe(1);
      expect(valid.find((row) => row.run.nativeAgentId)?.run.parentKey).toBe(valid.find((row) => !row.run.nativeAgentId)?.run.key);
    }
    if (golden.name === "project-remap") {
      const labels = new Map(golden.entries.map((entry: any) => [entry.record.message.id, entry.project]));
      for (const [project, total] of Object.entries(golden.expectedByProject)) expect(usageTotal(sumUsageTokens(valid.filter((row) => labels.get(row.responseId) === project).map((row) => row.tokens)))).toBe(BigInt(total as number));
      expect(usageTotal(sumUsageTokens(valid.map((row) => row.tokens)))).toBe(BigInt(golden.remapExpected.alpha));
    }
  });
});

describe("snapshot reconciliation", () => {
  it("replaces the entire snapshot when later output decreases, regardless of input order", () => {
    const older = record(), newer = record();
    older.message.usage.output_tokens = 500;
    newer.message.usage.output_tokens = 5;
    newer.message.usage.input_tokens = 2;
    const values = [normalize(older), normalize(newer, { byteStart: 100, byteEnd: 200 })];
    expect(canonicalTotal(values)).toBe(1007n);
    expect(reconcileUsageObservations(values).records[0]?.tokens.input).toBe(2n);
    expect(reconcileUsageObservations(values)).toEqual(reconcileUsageObservations([...values].reverse()));
  });
  it("corrects firstEventAt for late earlier data while keeping the newest cross-source snapshot", () => {
    const old = record(), current = record();
    old.timestamp = "2026-09-17T23:59:00.000Z";
    old.message.usage.output_tokens = 5;
    current.timestamp = "2026-09-18T00:01:00.000Z";
    const currentObservation = normalize(current), olderObservation = normalize(old, { sourceId: "copy", sourcePath: "copy.jsonl", ingestedAt: context().ingestedAt + 100 });
    const row = reconcileUsageObservations([currentObservation, olderObservation]).records[0]!;
    expect(row.firstEventAt).toBe(Date.parse(old.timestamp));
    expect(row.snapshotAt).toBe(Date.parse(current.timestamp));
    expect(row.tokens.output).toBe(50n);
  });
  it.each(["requestId", "model"])("excludes a conflicting %s even when one snapshot is older", (field) => {
    const a = record(), b = record();
    if (field === "model") b.message.model = "different-model";
    else b.requestId = "different-request";
    b.timestamp = "2026-09-19T00:00:00.000Z";
    const result = reconcileUsageObservations([normalize(a), normalize(b, { byteStart: 100, byteEnd: 200 })]);
    expect(result.records[0]?.validity).toBe("conflict");
    expect(result.diagnostics.map((d) => d.code)).toEqual([field === "model" ? "model_conflict" : "request_id_conflict"]);
  });
  it("allows a missing requestId and later reconciles the non-null identity", () => {
    const a = record(), b = record();
    delete a.requestId;
    const result = reconcileUsageObservations([normalize(a), normalize(b, { byteStart: 100, byteEnd: 200 })]);
    expect(result.records[0]?.requestId).toBe("request-a");
    expect(result.records[0]?.validity).toBe("valid");
  });
  it("counts conflicting ownership once and flags unassigned attribution", () => {
    const a = record(), b = record();
    b.cwd = "/workspace/beta";
    const result = reconcileUsageObservations([normalize(a), normalize(b, { sourceId: "copy", sourcePath: "copy.jsonl" })]);
    expect(result.records[0]?.attributionConflict).toBe(true);
    expect(result.records[0]?.validity).toBe("valid");
    expect(canonicalTotal(result.records)).toBe(1150n);
    expect(result.diagnostics[0]?.code).toBe("attribution_conflict");
  });
  it("preserves workflow identity when native agent stems repeat", () => {
    const first = normalize(record(), { sourcePath: "session-parent/subagents/workflows/wf_one/agent-child.jsonl" });
    const second = normalize(record(), { sourcePath: "session-parent/subagents/workflows/wf_two/agent-child.jsonl" });
    expect(first.run.key).not.toBe(second.run.key);
    expect(first.run.nativeAgentId).toBe("wf_one/agent-child");
    expect(first.run.parentKey).toBe(second.run.parentKey);
  });
  it("keeps device scope distinct and delimiter-bearing identities collision free", () => {
    const a = normalize(record()), b = normalize(record(), { deviceId: "another-device" });
    expect(reconcileUsageObservations([a, b]).records).toHaveLength(2);
  });
  it("deduplicates replayed source positions and retains distinct source links", () => {
    const a = normalize(record()), b = normalize(record(), { sourceId: "copy", sourcePath: "copy.jsonl" });
    const result = reconcileUsageObservations([a, b, a]);
    expect(result.records[0]?.sourceLinks).toHaveLength(2);
    expect(canonicalTotal([a, b, a])).toBe(1150n);
  });
});

describe("validation and privacy", () => {
  it.each([
    [undefined, "missing_token"], [null, "missing_token"], [-1, "invalid_token"], [0.5, "invalid_token"],
    ["1", "invalid_token"], [NaN, "invalid_token"], [Infinity, "invalid_token"], [Number.MAX_SAFE_INTEGER + 1, "unsafe_token_integer"],
  ])("rejects invalid usage %s with %s", (value, code) => {
    const input = record(); input.message.usage.output_tokens = value;
    const result = normalizeUsageRecord(input, context());
    expect(result.observation).toBeNull();
    expect(result.diagnostics[0]?.code).toBe(code);
  });
  it("sums safe input components exactly beyond the JS safe integer total", () => {
    const input = record();
    input.message.usage.input_tokens = Number.MAX_SAFE_INTEGER;
    input.message.usage.output_tokens = Number.MAX_SAFE_INTEGER;
    expect(usageTotal(normalize(input).tokens)).toBe(18014398509482982n);
  });
  it.each(["2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-18T24:00:00Z", "2026-09-18T00:00:00", "2026-09-18", "2026-09-18T00:00:00+25:00", 0])("rejects ambiguous/invalid timestamp %s", (timestamp) => {
    const input = record(); input.timestamp = timestamp;
    expect(normalizeUsageRecord(input, context()).diagnostics[0]?.code).toBe("invalid_timestamp");
  });
  it("accepts explicit timezone offsets and genuine leap dates", () => {
    const input = record(); input.timestamp = "2024-02-29T09:00:00+09:00";
    expect(normalize(input).eventAt).toBe(Date.parse("2024-02-29T00:00:00Z"));
  });
  it("keeps tokens with missing cache TTL and treats explicitly zero cache as known", () => {
    const input = record(); delete input.message.usage.cache_creation;
    const unknown = normalizeUsageRecord(input, context());
    expect(unknown.observation?.costEligibility).toBe("unknown_cache_split");
    expect(unknown.diagnostics[0]?.code).toBe("unknown_cache_split");
    expect(usageTotal(unknown.observation!.tokens)).toBe(1150n);
    input.message.usage.cache_creation_input_tokens = 0;
    expect(normalize(input).costEligibility).toBe("eligible");
    expect(normalize(input).cache5m).toBe(0n);
  });
  it("reports invalid TTL without discarding valid four-component usage", () => {
    const input = record(); input.message.usage.cache_creation.ephemeral_5m_input_tokens = -1;
    const result = normalizeUsageRecord(input, context());
    expect(result.observation?.costEligibility).toBe("invalid_cache_split");
    expect(usageTotal(result.observation!.tokens)).toBe(1150n);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["invalid_cache_split"]);
  });
  it("returns only whitelisted fields and does not retain prompt, tool or error bodies", () => {
    const input = record();
    input.message.content = [{ type: "text", text: "PRIVATE_PROMPT" }, { type: "tool_use", input: { secret: "PRIVATE_SECRET" } }];
    input.error = { message: "PRIVATE_ERROR" };
    input.credential = "PRIVATE_KEY";
    const result = normalizeUsageRecord(input, context({ sourcePath: "/PRIVATE_PATH/parent.jsonl" }));
    const serialized = JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("PRIVATE_");
    expect(result.observation?.parserVersion).toBe(USAGE_PARSER_VERSION);
    expect(input.message.content[0].text).toBe("PRIVATE_PROMPT");
  });
  it("ignores progress and synthetic responses, but retains failed real-model usage", () => {
    const progress = record(); progress.type = "progress";
    const synthetic = record(); synthetic.message.model = "<synthetic>";
    for (const input of [progress, synthetic]) expect(normalizeUsageRecord(input, context())).toEqual({ observation: null, diagnostics: [], ignored: true });
    const failed = record(); failed.isApiErrorMessage = true;
    expect(normalizeUsageRecord(failed, context()).observation).not.toBeNull();
  });
});
