import { describe, expect, it } from "vitest";
import { normalizeCoworkLine } from "../cowork/normalize.js";

const parse = (line: string | null) => JSON.parse(line!) as Record<string, any>;

describe("normalizeCoworkLine", () => {
  it("aliases _audit_timestamp → timestamp and claude_code_version → version", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "claude-opus-4-7",
        claude_code_version: "2.1.149",
        _audit_timestamp: "2026-05-23T18:02:14.315Z",
      }),
    );
    const obj = parse(out.line);
    expect(obj.timestamp).toBe("2026-05-23T18:02:14.315Z");
    expect(obj.version).toBe("2.1.149");
  });

  it("does not clobber an existing timestamp/version", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "user", timestamp: "T", version: "V", _audit_timestamp: "X", claude_code_version: "Y", message: { content: "hi" }, isReplay: true }),
    );
    const obj = parse(out.line);
    expect(obj.timestamp).toBe("T");
    expect(obj.version).toBe("V");
  });

  it("surfaces the init model (with a [1m] suffix)", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-7[1m]" }),
    );
    expect(out.initModel).toBe("claude-opus-4-7[1m]");
    expect(out.isCleanResult).toBe(false);
  });

  it("does not surface a model for non-init records", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", content: [{ type: "text", text: "x" }] } }),
    );
    expect(out.initModel).toBeNull();
  });

  it("rewrites a clean result into a synthetic assistant text record (no usage)", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done.", usage: { input_tokens: 999 }, _audit_timestamp: "2026-05-23T18:04:15.701Z" }),
    );
    expect(out.isCleanResult).toBe(true);
    const obj = parse(out.line);
    expect(obj.type).toBe("assistant");
    expect(obj.message.content).toEqual([{ type: "text", text: "done." }]);
    expect(obj.message.usage).toBeUndefined(); // would double-count token totals
    expect(obj.message.stop_reason).toBeUndefined();
    expect(obj.timestamp).toBe("2026-05-23T18:04:15.701Z");
  });

  it("marks an errored result as not-clean (no end-of-turn) but as activity", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "partial" }),
    );
    expect(out.isCleanResult).toBe(false);
    expect(out.activity).toBe(true); // an error result clears a latched endedTurn
  });

  it("flags user/assistant records as activity, passive pings as non-activity", () => {
    const user = normalizeCoworkLine(JSON.stringify({ type: "user", isReplay: true, message: { content: "hi" } }));
    const asst = normalizeCoworkLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }));
    const status = normalizeCoworkLine(JSON.stringify({ type: "system", subtype: "status" }));
    const rate = normalizeCoworkLine(JSON.stringify({ type: "rate_limit_event" }));
    const cleanResult = normalizeCoworkLine(JSON.stringify({ type: "result", is_error: false, result: "done" }));
    expect(user.activity).toBe(true);
    expect(asst.activity).toBe(true);
    expect(status.activity).toBe(false);
    expect(rate.activity).toBe(false);
    expect(cleanResult.activity).toBe(false); // latched via isCleanResult, not activity
  });

  it("suppresses non-replay human-turn echoes via isMeta", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "the original prompt" } }),
    );
    expect(parse(out.line).isMeta).toBe(true);
  });

  it("keeps the isReplay:true copy as a real turn (no isMeta)", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "user", isReplay: true, message: { role: "user", content: "the original prompt" } }),
    );
    expect(parse(out.line).isMeta).toBeUndefined();
  });

  it("leaves tool_result (array-content) user records untouched", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } }),
    );
    expect(parse(out.line).isMeta).toBeUndefined();
  });

  it("strips a transient api_retry error (system records only)", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "system", subtype: "api_retry", error: "unknown", _audit_timestamp: "Z" }),
    );
    expect(parse(out.line).error).toBeUndefined();
  });

  it("preserves a genuine error on assistant/result records", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "assistant", error: "unknown", message: { content: [{ type: "text", text: "API Error" }] } }),
    );
    expect(parse(out.line).error).toBe("unknown");
  });

  it("throws on malformed JSON (caller treats as a partial write)", () => {
    expect(() => normalizeCoworkLine('{"type":"user"')).toThrow();
  });
});
