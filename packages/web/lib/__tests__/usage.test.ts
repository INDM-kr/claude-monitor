import { describe, expect, it } from "vitest";
import { computeUsageWindows, usageTokens, type UsageEvent } from "../usage";

const H = 3600;

describe("usageTokens", () => {
  it("sums input + cache_creation + output, excludes cache_read", () => {
    expect(
      usageTokens({
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 999999,
        output_tokens: 50,
      }),
    ).toBe(160);
  });
  it("handles missing/empty usage", () => {
    expect(usageTokens(null)).toBe(0);
    expect(usageTokens({})).toBe(0);
  });
});

describe("computeUsageWindows", () => {
  const now = 1_000_000; // arbitrary epoch sec

  it("current 5h block = events since the last block start; reset = start + 5h", () => {
    const events: UsageEvent[] = [
      { ts: now - 7 * H, tokens: 500 }, // previous block (>=5h before the next event)
      { ts: now - 2 * H, tokens: 100 }, // current block start
      { ts: now - 1 * H, tokens: 200 },
      { ts: now - 10 * 60, tokens: 50 },
    ];
    const w = computeUsageWindows(events, now);
    expect(w.block.active).toBe(true);
    expect(w.block.tokens).toBe(350); // 100+200+50 (not the 500 in the old block)
    expect(w.block.startSec).toBe(now - 2 * H);
    expect(w.block.resetSec).toBe(now - 2 * H + 5 * H);
  });

  it("block expired when now is past start + 5h", () => {
    const events: UsageEvent[] = [{ ts: now - 6 * H, tokens: 500 }];
    const w = computeUsageWindows(events, now);
    expect(w.block.active).toBe(false);
    expect(w.block.tokens).toBe(0);
    expect(w.block.resetSec).toBeNull();
  });

  it("week = rolling 7d sum, drops older events", () => {
    const events: UsageEvent[] = [
      { ts: now - 8 * 86400, tokens: 1000 }, // >7d → excluded
      { ts: now - 3 * 86400, tokens: 400 },
      { ts: now - 1 * H, tokens: 60 },
    ];
    const w = computeUsageWindows(events, now);
    expect(w.week.tokens).toBe(460);
  });

  it("peakPrior = largest block BEFORE the current one (gauge denominator)", () => {
    const events: UsageEvent[] = [
      { ts: now - 20 * H, tokens: 1000 }, // prior block
      { ts: now - 10 * H, tokens: 3000 }, // prior block (the peak)
      { ts: now - 1 * H, tokens: 200 }, // current block
    ];
    const w = computeUsageWindows(events, now);
    expect(w.block.tokens).toBe(200);
    expect(w.block.peakPrior).toBe(3000);
  });

  it("passes through configured limits", () => {
    const w = computeUsageWindows([], now, { block: 5000, week: 99000 });
    expect(w.limits).toEqual({ block: 5000, week: 99000 });
  });

  it("empty events → zeros, inactive block", () => {
    const w = computeUsageWindows([], now);
    expect(w.block.active).toBe(false);
    expect(w.week.tokens).toBe(0);
    expect(w.totalEvents).toBe(0);
  });
});
