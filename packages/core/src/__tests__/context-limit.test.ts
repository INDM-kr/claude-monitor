import { describe, it, expect } from "vitest";
import { contextLimitForModel, computeContext } from "../util/context-limit.js";

describe("context-limit", () => {
  it("기본 한도 200k", () => {
    expect(contextLimitForModel("claude-opus-4-8")).toBe(200_000);
    expect(contextLimitForModel(null)).toBe(200_000);
  });

  it("computeContext는 pct를 0..1로 clamp", () => {
    expect(computeContext(50_000, 200_000)).toEqual({ tokens: 50_000, limit: 200_000, pct: 0.25 });
    expect(computeContext(300_000, 200_000).pct).toBe(1);
    expect(computeContext(10, 0).pct).toBe(0);
  });
});
