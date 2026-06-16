import { describe, expect, it } from "vitest";
import { bucket, statusFromMtime, deriveSessionStatus } from "../util/status.js";

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

describe("deriveSessionStatus — waiting (content signal over mtime)", () => {
  it("ended turn + recent + no pending → waiting", () => {
    expect(deriveSessionStatus(5, true, false)).toBe("waiting");
    expect(deriveSessionStatus(120, true, false)).toBe("waiting");
  });

  it("mid-turn + recent → live (not waiting)", () => {
    expect(deriveSessionStatus(5, false, false)).toBe("live");
  });

  it("ended but pending subagents → still working (mtime bucket)", () => {
    expect(deriveSessionStatus(5, true, true)).toBe("live");
  });

  it("beyond recentSec → stop regardless of ended", () => {
    expect(deriveSessionStatus(700, true, false)).toBe("stop");
  });

  it("mid-turn gone quiet (idle window) → idle", () => {
    expect(deriveSessionStatus(120, false, false)).toBe("idle");
  });
});
