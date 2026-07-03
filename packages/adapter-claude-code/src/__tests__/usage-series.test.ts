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
