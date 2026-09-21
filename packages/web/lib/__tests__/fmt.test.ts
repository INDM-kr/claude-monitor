import { describe, it, expect } from "vitest";
import { fmtCount, fmtDate } from "../fmt";

// Shared by the project list header (ProjectGroup) and the project detail page.
describe("fmtCount", () => {
  it("1000 미만은 그대로", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(999)).toBe("999");
  });

  it("천 단위는 반올림한 k", () => {
    expect(fmtCount(1000)).toBe("1k");
    expect(fmtCount(1499)).toBe("1k");
    expect(fmtCount(1500)).toBe("2k");
    expect(fmtCount(3400)).toBe("3k");
    expect(fmtCount(999_499)).toBe("999k");
  });

  it("백만 이상은 소수 1자리 M", () => {
    expect(fmtCount(1_000_000)).toBe("1.0M");
    expect(fmtCount(82_600_000)).toBe("82.6M");
  });
});

describe("fmtDate", () => {
  // Built from LOCAL date parts so the expectation holds in any TZ: fmtDate renders
  // the local calendar date (same local-date basis as the detail page's buckets).
  const localNoonSec = (y: number, m0: number, d: number): number => new Date(y, m0, d, 12, 0, 0).getTime() / 1000;

  it("epoch 초 → ko-KR 연·월·일 (월/일 2자리 패딩)", () => {
    expect(fmtDate(localNoonSec(2026, 5, 23))).toBe("2026. 06. 23.");
    expect(fmtDate(localNoonSec(2026, 0, 5))).toBe("2026. 01. 05.");
  });
});
