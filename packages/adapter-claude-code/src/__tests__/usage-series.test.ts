import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenTimeline, readUsageSeries } from "../usage-series.js";

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

describe("readTokenTimeline", () => {
  const rec = (ts: string, id: string | undefined, output: number): string =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { id, usage: { output_tokens: output } },
    });

  it("같은 message id의 per-block 반복 usage는 포인트 1개(최종값)로 — 합산 과대 방지", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-usage-"));
    const file = join(dir, "t.jsonl");
    await fs.writeFile(
      file,
      [
        rec("2026-05-29T00:00:00.000Z", "msg_a", 100),
        rec("2026-05-29T00:00:01.000Z", "msg_a", 100), // same message, next block
        rec("2026-05-29T00:00:02.000Z", "msg_a", 120), // streaming growth
        rec("2026-05-29T00:01:00.000Z", "msg_b", 40),
      ].join("\n"),
    );
    const points = await readTokenTimeline(file);
    expect(points).toEqual([
      { ts: Date.parse("2026-05-29T00:00:02.000Z"), tokens: 120 },
      { ts: Date.parse("2026-05-29T00:01:00.000Z"), tokens: 40 },
    ]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("id 없는 레코드는 레코드별 포인트 유지 (dedup 불가)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-usage-"));
    const file = join(dir, "t.jsonl");
    await fs.writeFile(
      file,
      [rec("2026-05-29T00:00:00.000Z", undefined, 10), rec("2026-05-29T00:00:01.000Z", undefined, 20)].join("\n"),
    );
    const points = await readTokenTimeline(file);
    expect(points.map((p) => p.tokens)).toEqual([10, 20]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("cowork audit.jsonl (_audit_timestamp instead of timestamp)", () => {
  const fixture = join(__dirname, "fixtures", "cowork", "cowork-simple.jsonl");
  // Σ metricTokens after per-message dedup: msg_..001 (2+36935+28) + msg_..002 (2+3990+41).
  // Identical to what fold() accumulates for the same file, so the project list header
  // (fold totalTokens) and the project detail page (this timeline) agree for cowork.
  const COWORK_METRIC_TOKENS = 36965 + 4033;

  it("readTokenTimeline: cowork 레코드를 버리지 않는다 (상세페이지 토큰 0 버그)", async () => {
    const points = await readTokenTimeline(fixture);
    expect(points.length).toBe(2); // two distinct message ids, per-block repeats deduped
    expect(points.reduce((a, p) => a + p.tokens, 0)).toBe(COWORK_METRIC_TOKENS);
    expect(points.every((p) => Number.isFinite(p.ts))).toBe(true);
    // start = a real date, not null → the detail header renders 시작 and the heatmap fills
    expect(new Date(Math.min(...points.map((p) => p.ts))).toISOString().slice(0, 10)).toBe("2026-05-23");
  });

  it("readUsageSeries: cowork 컨텍스트 그래프도 비지 않는다", async () => {
    const series = await readUsageSeries(fixture);
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((p) => Number.isFinite(p.ts) && p.tokens > 0)).toBe(true);
  });
});
