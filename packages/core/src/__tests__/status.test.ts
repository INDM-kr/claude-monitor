import { describe, expect, it } from "vitest";
import { bucket, statusFromMtime } from "../util/status.js";

describe("status bucket", () => {
  it("live when age < 60s", () => {
    expect(bucket(0)).toBe("live");
    expect(bucket(59)).toBe("live");
  });

  it("idle when 60 <= age < 600", () => {
    expect(bucket(60)).toBe("idle");
    expect(bucket(599)).toBe("idle");
  });

  it("stop when age >= 600", () => {
    expect(bucket(600)).toBe("stop");
    expect(bucket(99999)).toBe("stop");
  });

  it("respects custom thresholds", () => {
    const cfg = { activeSec: 10, recentSec: 100 };
    expect(bucket(9, cfg)).toBe("live");
    expect(bucket(10, cfg)).toBe("idle");
    expect(bucket(100, cfg)).toBe("stop");
  });

  it("statusFromMtime clamps negative age", () => {
    const now = 1_000_000;
    expect(statusFromMtime(now + 100, now)).toBe("live");
  });
});
