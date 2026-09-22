import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCodexTokenTimeline, readCodexUsageSeries } from "../codex/usage-series.js";
import { CodexReader } from "../codex/reader.js";
import { CODEX_ADAPTER_ID } from "../codex/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "codex");
const ms = (iso: string): number => Date.parse(iso);

describe("readCodexTokenTimeline", () => {
  it("one point per token_count event with the cumulative delta; Σ equals the reader's totalTokens", async () => {
    const src = join(FIX, "codex-simple.jsonl");
    const points = await readCodexTokenTimeline(src);
    expect(points).toEqual([
      { ts: ms("2026-09-21T11:14:27.100Z"), tokens: 3608 },
      { ts: ms("2026-09-21T11:14:30.100Z"), tokens: 1892 },
      { ts: ms("2026-09-21T11:14:30.200Z"), tokens: 0 },
    ]);
    const s = await new CodexReader({ id: "x", adapterId: CODEX_ADAPTER_ID, workspace: "/w", workspaceShort: "w", projectKey: "/w", projectLabel: "w", owner: "o", source: src, mtime: 0 }).readIncremental();
    expect(points.reduce((a, p) => a + p.tokens, 0)).toBe(s.totalTokens);
    // startSec is floored to seconds; the first positive point is the same instant
    expect(Math.floor(points.find((p) => p.tokens > 0)!.ts / 1000)).toBe(s.startSec);
  });

  it("excludes the parent's copied prefix in a sub-agent file", async () => {
    const points = await readCodexTokenTimeline(join(FIX, "codex-subagent.jsonl"));
    expect(points).toEqual([{ ts: ms("2026-09-21T11:20:06.000Z"), tokens: 3100 }]);
  });

  it("returns [] for a missing file", async () => {
    expect(await readCodexTokenTimeline(join(FIX, "nope.jsonl"))).toEqual([]);
  });
});

describe("readCodexUsageSeries", () => {
  it("tracks context occupancy per token_count event", async () => {
    const points = await readCodexUsageSeries(join(FIX, "codex-simple.jsonl"));
    expect(points.map((p) => p.tokens)).toEqual([13208 - 29, 13292 - 11, 13292 - 11]);
  });
});

describe("codex usage series — corrupt lines and the 500-point cap", () => {
  const meta = { timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload: { id: "t", cwd: "/w", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } };
  const tokenCount = (ordinal: number, ts: string, total: number, output: number) => ({
    timestamp: ts, ordinal, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: total - output, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total }, last_token_usage: { input_tokens: total - output, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total }, model_context_window: 258400 }, rate_limits: null },
  });

  it("skips a corrupt line in the middle and keeps folding the rest", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-codex-series-"));
    const f = join(dir, "rollout.jsonl");
    await fs.writeFile(f, [JSON.stringify(meta), JSON.stringify(tokenCount(1, "2026-09-21T11:14:27.100Z", 1000, 100)), '{"type":"event_msg"', "", JSON.stringify(tokenCount(3, "2026-09-21T11:14:30.100Z", 2500, 200))].join("\n") + "\n");
    expect(await readCodexTokenTimeline(f)).toEqual([
      { ts: ms("2026-09-21T11:14:27.100Z"), tokens: 1000 },
      { ts: ms("2026-09-21T11:14:30.100Z"), tokens: 1500 },
    ]);
    expect((await readCodexUsageSeries(f)).map((p) => p.tokens)).toEqual([1000, 2500]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("caps the usage series at the last 500 points while the timeline keeps every event", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-codex-series-"));
    const f = join(dir, "rollout.jsonl");
    const lines = [JSON.stringify(meta)];
    for (let i = 1; i <= 600; i++) lines.push(JSON.stringify(tokenCount(i, new Date(ms("2026-09-21T11:14:27.100Z") + i * 1000).toISOString(), i * 10, 1)));
    await fs.writeFile(f, lines.join("\n") + "\n");
    const series = await readCodexUsageSeries(f);
    expect(series).toHaveLength(500);
    expect(series[0]!.tokens).toBe(101 * 10);
    expect(series[499]!.tokens).toBe(600 * 10);
    const timeline = await readCodexTokenTimeline(f);
    expect(timeline).toHaveLength(600);
    expect(timeline.reduce((a, p) => a + p.tokens, 0)).toBe(6000);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
