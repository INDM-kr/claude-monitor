import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDataSource } from "../data-source/local";
import { getProjectActivity } from "../project-activity";
import { fakeAdapter, refFor, summaryFor } from "./helpers";

const TS_A = "2026-09-21T11:14:27.100Z";
const TS_B = "2026-09-21T11:20:06.000Z";
const TS_C = "2026-09-18T12:00:00.000Z"; // midday UTC two days earlier: a distinct local day in every timezone

function usage(input: number, cached: number, output: number) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
}
function rollout(id: string, ts: string, u: ReturnType<typeof usage>): string {
  return [
    { timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload: { id, cwd: "/w", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } },
    { timestamp: ts, ordinal: 1, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: u, last_token_usage: u, model_context_window: 258400 }, rate_limits: null } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
}
const claudeLine = { type: "assistant", timestamp: TS_C, message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 1, output_tokens: 2 }, content: [] } };

const localDay = (ts: string): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("getProjectActivity — per-adapter timelines, one read per source", () => {
  let dir: string;
  let ds: LocalDataSource;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-activity-"));
  });
  afterEach(async () => {
    await ds?.dispose();
    globalThis.__claudeMonitorDataSource = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("sums codex (root + child) and claude-code sessions of one project; a shared source is read once", async () => {
    const a = join(dir, "rollout-a.jsonl");
    const b = join(dir, "rollout-b.jsonl");
    const c = join(dir, "claude.jsonl");
    await fs.writeFile(a, rollout("A", TS_A, usage(100, 40, 10))); // 70
    await fs.writeFile(b, rollout("B", TS_B, usage(3000, 0, 100))); // 3100
    await fs.writeFile(c, JSON.stringify(claudeLine) + "\n"); // 8
    const sessions = [
      summaryFor(refFor("codex", "A", dir, { source: a })),
      summaryFor(refFor("codex", "B", dir, { source: b, parentId: "A" })),
      summaryFor(refFor("codex", "A2", dir, { source: a })), // same file as A → must not double count
    ];
    const claude = [summaryFor(refFor("claude-code", "C", dir, { source: c }))];
    ds = new LocalDataSource([fakeAdapter("codex", sessions), fakeAdapter("claude-code", claude)]);
    globalThis.__claudeMonitorDataSource = ds;

    const act = await getProjectActivity(dir);
    expect(act).not.toBeNull();
    expect(act!.totalTokens).toBe(70 + 3100 + 8);
    expect(act!.sessionCount).toBe(3); // A, A2, C — the child B is not a root
    expect(act!.startSec).toBe(Math.floor(Date.parse(TS_C) / 1000));
    expect(act!.daily[localDay(TS_A)]).toBe(70 + 3100);
    expect(act!.daily[localDay(TS_C)]).toBe(8);
    const dA = new Date(TS_A);
    expect(act!.weekdayHour[dA.getDay()]![dA.getHours()]).toBe(70 + 3100);
    expect(await getProjectActivity("/no/such/project")).toBeNull();
  });
});
