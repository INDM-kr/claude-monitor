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
