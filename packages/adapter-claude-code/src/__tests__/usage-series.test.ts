import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readUsageSeries } from "../usage-series.js";

describe("readUsageSeries", () => {
  it("assistant 턴의 usage를 시계열로", async () => {
    const series = await readUsageSeries(join(__dirname, "fixtures", "usage.jsonl"));
    expect(series).toEqual([
      { ts: Date.parse("2026-05-29T00:00:00.000Z"), tokens: 100 },
      { ts: Date.parse("2026-05-29T00:01:00.000Z"), tokens: 200 },
    ]);
  });

  it("없는 파일은 빈 배열", async () => {
    expect(await readUsageSeries("/no/such/file.jsonl")).toEqual([]);
  });
});
