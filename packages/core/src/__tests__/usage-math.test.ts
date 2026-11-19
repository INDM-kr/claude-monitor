import { describe, expect, it } from "vitest";
import { sumUsageTokens, usageIdentityKey, usageObservedContext, usageRunKey, usageTotal } from "../util/usage-math.js";

describe("exact usage arithmetic and identities", () => {
  it("sums the four disjoint categories and derives observed context without output", () => {
    const tokens = { input: 100n, output: 50n, cacheRead: 800n, cacheWrite: 200n };
    expect(usageTotal(tokens)).toBe(1150n);
    expect(usageObservedContext(tokens)).toBe(1100n);
    expect(sumUsageTokens([tokens, { input: 20n, output: 10n, cacheRead: 0n, cacheWrite: 0n }])).toEqual({ input: 120n, output: 60n, cacheRead: 800n, cacheWrite: 200n });
    expect(tokens.input).toBe(100n);
  });
  it("keeps large sums exact and empty sums known zero", () => {
    const value = { input: 9007199254740991n, output: 1n, cacheRead: 0n, cacheWrite: 0n };
    expect(usageTotal(sumUsageTokens([value, value]))).toBe(18014398509481984n);
    expect(usageTotal(sumUsageTokens([]))).toBe(0n);
  });
  it("encodes identities without delimiter collisions and separates parent/workflow children", () => {
    expect(usageIdentityKey("a:b", "c", "d")).not.toBe(usageIdentityKey("a", "b:c", "d"));
    expect(usageRunKey("device", "provider", "session")).not.toBe(usageRunKey("device", "provider", "session", "session", "agent"));
    expect(usageRunKey("device", "provider", "session", "session", "agent", "wf_a")).not.toBe(usageRunKey("device", "provider", "session", "session", "agent", "wf_b"));
  });
});
