import { describe, expect, it } from "vitest";
import { ago, shortSid, truncate } from "../util/format.js";

describe("ago", () => {
  it("formats sub-minute as seconds", () => {
    expect(ago(0)).toBe("0s ago");
    expect(ago(59)).toBe("59s ago");
  });

  it("formats sub-hour as minutes", () => {
    expect(ago(60)).toBe("1m ago");
    expect(ago(3599)).toBe("59m ago");
  });

  it("formats sub-day as hours", () => {
    expect(ago(3600)).toBe("1h ago");
    expect(ago(86399)).toBe("23h ago");
  });

  it("formats >= day as days", () => {
    expect(ago(86400)).toBe("1d ago");
    expect(ago(172800)).toBe("2d ago");
  });
});

describe("truncate", () => {
  it("returns string unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });

  it("handles null/undefined", () => {
    expect(truncate(null, 5)).toBe("");
    expect(truncate(undefined, 5)).toBe("");
  });
});

describe("shortSid", () => {
  it("takes first 8 chars", () => {
    expect(shortSid("a1b2c3d4e5f6")).toBe("a1b2c3d4");
  });
});
