import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenTimelineFor, usageSeriesFor } from "../token-series";

const codexLines = [
  { timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload: { id: "t", cwd: "/w", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } },
  { timestamp: "2026-09-21T11:14:27.100Z", ordinal: 1, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, model_context_window: 258400 }, rate_limits: null } },
];
const claudeLine = { type: "assistant", timestamp: "2026-09-21T11:14:27.100Z", message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 1, output_tokens: 2 }, content: [] } };

describe("token-series dispatch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-token-series-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("routes codex refs to the Codex readers", async () => {
    const f = join(dir, "rollout.jsonl");
    await fs.writeFile(f, codexLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await tokenTimelineFor({ adapterId: "codex", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 70 }]);
    expect(await usageSeriesFor({ adapterId: "codex", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 108 }]);
    // the Claude readers see no assistant records in a rollout file
    expect(await tokenTimelineFor({ adapterId: "claude-code", source: f })).toEqual([]);
  });

  it("routes other adapters to the Claude readers", async () => {
    const f = join(dir, "s.jsonl");
    await fs.writeFile(f, JSON.stringify(claudeLine) + "\n");
    expect(await tokenTimelineFor({ adapterId: "claude-code", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 8 }]);
    expect(await usageSeriesFor({ adapterId: "claude-cowork", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 13 }]);
  });
});
