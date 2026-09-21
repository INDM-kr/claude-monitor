import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenTimeline, readUsageSeries } from "../usage-series.js";
import { fold, initial } from "../parser.js";

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

  it("timestamp가 _audit_timestamp보다 우선 (normalizeCoworkLine 별칭 규칙과 동일)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-usage-"));
    const file = join(dir, "t.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-23T18:00:00.000Z",
        _audit_timestamp: "2026-05-23T18:00:07.000Z",
        message: { id: "m1", usage: { input_tokens: 4, output_tokens: 6 } },
      }),
    );
    expect((await readTokenTimeline(file)).map((p) => p.ts)).toEqual([Date.parse("2026-05-23T18:00:00.000Z")]);
    expect((await readUsageSeries(file)).map((p) => p.ts)).toEqual([Date.parse("2026-05-23T18:00:00.000Z")]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("타임스탬프가 둘 다 없거나 파싱 불가한 assistant 레코드는 제외 (두 함수 공통)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-usage-"));
    const file = join(dir, "t.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "assistant", message: { id: "m0", usage: { input_tokens: 5, output_tokens: 5 } } }),
        JSON.stringify({ type: "assistant", _audit_timestamp: "garbage", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 5 } } }),
        JSON.stringify({
          type: "assistant",
          _audit_timestamp: "2026-05-23T18:00:00.000Z",
          message: { id: "m2", usage: { input_tokens: 7, output_tokens: 3 } },
        }),
      ].join("\n"),
    );
    const ts = Date.parse("2026-05-23T18:00:00.000Z");
    expect(await readTokenTimeline(file)).toEqual([{ ts, tokens: 10 }]); // metricTokens 7+3
    expect(await readUsageSeries(file)).toEqual([{ ts, tokens: 7 }]); // context = input (+cache)
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("목록 헤더 ↔ 상세 페이지 토큰 합계 일치 (같은 파일: fold vs readTokenTimeline)", () => {
  it("시작 시각: 자정을 넘는 분할 응답도 목록(fold)과 상세(timeline)가 같은 순간 (마지막 블록)", async () => {
    const a = (ts: string, id: string, out: number): string =>
      JSON.stringify({ type: "assistant", timestamp: ts, message: { id, usage: { output_tokens: out }, content: [{ type: "text", text: "." }] } });
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-06-10T23:59:50.000Z", message: { content: "요청" } }),
      a("2026-06-10T23:59:55.000Z", "msg_a", 10), // first block, before midnight
      a("2026-06-11T00:00:05.000Z", "msg_a", 10), // same message, after midnight
      a("2026-06-11T00:00:09.000Z", "msg_b", 5),
      a("2026-06-11T00:01:00.000Z", "msg_a", 10), // id seen again later → a new point; start stays
    ];
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-usage-"));
    const file = join(dir, "t.jsonl");
    await fs.writeFile(file, lines.join("\n") + "\n");

    let s = initial();
    for (const l of lines) s = fold(s, l);
    const detailStart = Math.min(...(await readTokenTimeline(file)).filter((p) => p.tokens > 0).map((p) => p.ts));

    // Same epoch in both paths ⇒ the same rendered date in any timezone.
    expect(s.firstTokenTsMs).toBe(detailStart);
    expect(s.firstTokenTsMs).toBe(Date.parse("2026-06-11T00:00:05.000Z"));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("Claude Code transcript: Σ readTokenTimeline == fold().totalTokens (블록 분할 · 스트리밍 증가 · id 없음 · 0 usage)", async () => {
    const a = (ts: string, id: string | undefined, usage: Record<string, number>): string =>
      JSON.stringify({ type: "assistant", timestamp: ts, message: { id, usage, content: [{ type: "text", text: "." }] } });
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-06-11T00:00:00.000Z", message: { content: "요청" } }),
      a("2026-06-11T00:00:01.000Z", "msg_a", { output_tokens: 100 }), // one message split into blocks…
      a("2026-06-11T00:00:02.000Z", "msg_a", { output_tokens: 100 }),
      a("2026-06-11T00:00:03.000Z", "msg_a", { output_tokens: 120 }), // …with streaming growth
      JSON.stringify({ type: "user", timestamp: "2026-06-11T00:00:04.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
      a("2026-06-11T00:00:05.000Z", "msg_b", { input_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 9999, output_tokens: 40 }),
      a("2026-06-11T00:00:06.000Z", undefined, { output_tokens: 7 }), // id-less
      a("2026-06-11T00:00:07.000Z", "msg_c", { input_tokens: 0, output_tokens: 0 }), // zero usage
    ];
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-usage-"));
    const file = join(dir, "t.jsonl");
    await fs.writeFile(file, lines.join("\n") + "\n");

    let s = initial();
    for (const l of lines) s = fold(s, l);
    const timeline = await readTokenTimeline(file);
    const timelineSum = timeline.reduce((acc, p) => acc + p.tokens, 0);

    expect(s.totalTokens).toBe(120 + 95 + 7); // cache_read excluded
    expect(timelineSum).toBe(s.totalTokens); // list header (fold) == detail total (timeline)
    // …and the start: msg_a is stamped at its last block (00:00:03) in both paths.
    expect(s.firstTokenTsMs).toBe(Math.min(...timeline.filter((p) => p.tokens > 0).map((p) => p.ts)));
    expect(s.firstTokenTsMs).toBe(Date.parse("2026-06-11T00:00:03.000Z"));
    await fs.rm(dir, { recursive: true, force: true });
  });
});
