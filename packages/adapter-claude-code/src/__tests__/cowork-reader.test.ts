import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRef } from "@claude-monitor/core";
import { CoworkReader } from "../cowork/reader.js";
import { COWORK_ADAPTER_ID, COWORK_DISPLAY } from "../cowork/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, "fixtures", "cowork");

function fixtureLines(name: string): Promise<string> {
  return fs.readFile(join(FIXDIR, name), "utf8");
}

function refFor(source: string): SessionRef {
  return {
    id: "5e8dbba4-cowork",
    adapterId: COWORK_ADAPTER_ID,
    workspace: COWORK_DISPLAY,
    workspaceShort: COWORK_DISPLAY,
    projectKey: "cowork:aaaa/bbbb",
    projectLabel: COWORK_DISPLAY,
    owner: "example",
    source,
    mtime: Math.floor(Date.now() / 1000),
  };
}

describe("CoworkReader", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-cowork-reader-"));
    file = join(dir, "audit.jsonl");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Write content to the temp audit file with a controlled (recent) mtime so
   *  status assertions don't depend on the fixture's git-checkout time. */
  async function write(content: string, mtimeMs = Date.now()): Promise<void> {
    await fs.writeFile(file, content);
    const t = mtimeMs / 1000;
    await fs.utimes(file, t, t);
  }

  it("simple: one human turn via the isReplay copy, ended by the trailing result", async () => {
    await write(await fixtureLines("cowork-simple.jsonl"));
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.userTurns).toEqual(["build me a market dashboard"]);
    expect(s.firstPrompt).toBe("build me a market dashboard");
    expect(s.endedTurn).toBe(true);
    expect(s.status).toBe("waiting"); // ended + no pending + recent (mtime forced now)
    expect(s.lastText).toBe("I read 3 rows of price data and built a simple market dashboard from it.");
    expect(s.userResponses?.[0]).toBe(s.lastText);
    expect(s.runner).toBe("claude-desktop");
    expect(s.pid).toBeNull();
    expect(s.agentStatus).toBeNull();
    expect(s.metrics).toBeNull();
    expect(s.model).toBe("claude-opus-4-7"); // display model has no [1m]
    // Same Σ the project detail page's readTokenTimeline reports for this file —
    // the list header and the detail page must not disagree for cowork.
    expect(s.totalTokens).toBe(36965 + 4033);
    // startSec = first token-bearing assistant event (record 6's _audit_timestamp),
    // NOT the earlier pre-init user echo — matches the detail page's project-start basis.
    expect(s.startSec).toBe(Math.floor(Date.parse("2026-05-23T18:02:21.374Z") / 1000));
  });

  it("concurrent readIncremental calls fold each record once (== a sequential read)", async () => {
    await write(await fixtureLines("cowork-multiturn.jsonl"));
    const baseline = await new CoworkReader(refFor(file)).readIncremental();
    const r = new CoworkReader(refFor(file));
    const out = await Promise.all([r.readIncremental(), r.readIncremental(), r.readIncremental()]);
    for (const s of out) {
      expect(s.totalTokens).toBe(baseline.totalTokens);
      expect(s.userTurns).toEqual(baseline.userTurns);
    }
    expect((await r.readIncremental()).totalTokens).toBe(baseline.totalTokens);
  });

  it("a failed pass (file briefly missing) still rejects, and does not block later reads", async () => {
    const r = new CoworkReader(refFor(file)); // not written yet → stat ENOENT
    await expect(r.readIncremental()).rejects.toThrow();
    await write(await fixtureLines("cowork-simple.jsonl"));
    expect((await r.readIncremental()).userTurns).toEqual(["build me a market dashboard"]);
  });

  it("simple: a [1m] init model yields a 1M context window", async () => {
    await write(await fixtureLines("cowork-simple.jsonl"));
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.context?.limit).toBe(1_000_000);
    expect(s.context?.tokens).toBeGreaterThan(0);
  });

  it("multiturn: two distinct prompts in order, latest todo, non-[1m] 200k limit, per-turn token reset", async () => {
    await write(await fixtureLines("cowork-multiturn.jsonl"));
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.userTurns).toEqual([
      "build me a market dashboard",
      "focus on the asia region and track my open tasks",
    ]);
    expect(s.endedTurn).toBe(true); // closed by the SECOND (trailing) result
    expect(s.todo).not.toBeNull();
    expect(s.context?.limit).toBe(200_000); // init model has no [1m]
    expect(s.model).not.toMatch(/\[1m\]/);
    // turnTokens is reset on each human turn → only the last turn's tokens,
    // strictly less than the whole-session total.
    expect(s.turnTokens).toBeGreaterThan(0);
    expect(s.turnTokens!).toBeLessThan(s.totalTokens!);
  });

  it("incomplete: a mid-turn session (no trailing result) is not ended", async () => {
    await write(await fixtureLines("cowork-incomplete.jsonl"));
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.userTurns).toEqual(["build me a market dashboard"]);
    expect(s.endedTurn).toBe(false);
    expect(s.status).not.toBe("waiting");
  });

  it("subagent: a Task without its tool_result is pending; turn not ended", async () => {
    await write(await fixtureLines("cowork-subagent.jsonl"));
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.endedTurn).toBe(false);
    expect(s.pendingSubagents).toHaveLength(1);
    expect(s.pendingSubagents[0]).toMatchObject({ id: "toolu_01SubagentTaskAbcdef001", type: "Explore" });
  });

  it("ref carries the synthetic cowork identity (no repo)", async () => {
    await write(await fixtureLines("cowork-simple.jsonl"));
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.ref.adapterId).toBe(COWORK_ADAPTER_ID);
    expect(s.ref.projectKey).toBe("cowork:aaaa/bbbb");
    expect(s.ref.workspace).toBe(COWORK_DISPLAY);
  });

  // --- live-update machinery (the reason this is a stateful, incremental reader) ---

  it("incremental: appending the trailing result across calls matches a one-shot read", async () => {
    const all = (await fixtureLines("cowork-simple.jsonl")).split("\n").filter((l) => l.trim());
    const head = all.slice(0, all.length - 1); // everything but the trailing result
    const tail = all[all.length - 1]!;

    await write(head.join("\n") + "\n");
    const reader = new CoworkReader(refFor(file));
    const mid = await reader.readIncremental();
    expect(mid.endedTurn).toBe(false); // result not written yet → still in-progress

    await fs.appendFile(file, tail + "\n");
    const fin = await reader.readIncremental();
    expect(fin.endedTurn).toBe(true);
    expect(fin.lastText).toBe("I read 3 rows of price data and built a simple market dashboard from it.");

    const oneShot = await new CoworkReader(refFor(file)).readIncremental();
    expect(fin.userTurns).toEqual(oneShot.userTurns);
    expect(fin.totalTokens).toBe(oneShot.totalTokens); // no double-counting across calls
  });

  it("truncation: a shorter rewrite restarts state from byte 0 (no stale carryover)", async () => {
    await write(await fixtureLines("cowork-multiturn.jsonl"));
    const reader = new CoworkReader(refFor(file));
    const full = await reader.readIncremental();
    expect(full.userTurns).toHaveLength(2);
    expect(full.endedTurn).toBe(true);

    await write(await fixtureLines("cowork-incomplete.jsonl")); // shorter, different content
    const after = await reader.readIncremental();
    expect(after.userTurns).toEqual(["build me a market dashboard"]); // not the 2 stale turns
    expect(after.endedTurn).toBe(false); // latched-true endedTurn was reset

    // State is recomputed from scratch — identical to a fresh reader on the same bytes.
    await write(await fixtureLines("cowork-incomplete.jsonl"));
    const fresh = await new CoworkReader(refFor(file)).readIncremental();
    expect(after.totalTokens).toBe(fresh.totalTokens);
    expect(after.userTurns).toEqual(fresh.userTurns);
  });

  it("partial write: a line without a trailing newline is deferred, then applied once completed", async () => {
    const all = (await fixtureLines("cowork-simple.jsonl")).split("\n").filter((l) => l.trim());
    const tail = all[all.length - 1]!; // trailing clean result

    await write(all.slice(0, all.length - 1).join("\n") + "\n");
    const reader = new CoworkReader(refFor(file));
    await reader.readIncremental();

    // Append the result line WITHOUT a newline → must not be folded yet.
    await fs.appendFile(file, tail);
    const partial = await reader.readIncremental();
    expect(partial.endedTurn).toBe(false);

    await fs.appendFile(file, "\n");
    const done = await reader.readIncremental();
    expect(done.endedTurn).toBe(true);
  });

  it("malformed line: a newline-terminated broken record rolls back and applies once fixed", async () => {
    await write(await fixtureLines("cowork-incomplete.jsonl"));
    const reader = new CoworkReader(refFor(file));
    const before = await reader.readIncremental();
    const tokensBefore = before.totalTokens!;

    // A broken (newline-terminated) line — treated as a partial write, rolled back.
    await fs.appendFile(file, '{"type":"assistant","mess\n');
    const broken = await reader.readIncremental();
    expect(broken.totalTokens).toBe(tokensBefore); // not consumed

    // Overwrite the broken tail with a valid assistant record.
    const valid = JSON.stringify({
      type: "assistant",
      _audit_timestamp: "2026-05-23T18:10:00.000Z",
      message: { model: "claude-opus-4-7", content: [{ type: "text", text: "resumed" }], usage: { output_tokens: 5 } },
    });
    await write((await fixtureLines("cowork-incomplete.jsonl")) + valid + "\n");
    const fixed = await reader.readIncremental();
    expect(fixed.lastText).toBe("resumed");
  });

  it("slash command: an isReplay <command-message> wrapper yields no human turn (matches Claude Code)", async () => {
    const lines = [
      { type: "user", message: { role: "user", content: "/qa run" }, _audit_timestamp: "2026-05-23T18:00:00.000Z" },
      { type: "system", subtype: "init", model: "claude-opus-4-7", claude_code_version: "2.1.149", permissionMode: "default", _audit_timestamp: "2026-05-23T18:00:01.000Z" },
      { type: "user", isReplay: true, timestamp: "2026-05-23T18:00:02.000Z", message: { role: "user", content: "<command-message>qa is running…</command-message>\n<command-name>/qa</command-name>" }, _audit_timestamp: "2026-05-23T18:00:02.000Z" },
      { type: "assistant", _audit_timestamp: "2026-05-23T18:00:03.000Z", message: { model: "claude-opus-4-7", content: [{ type: "text", text: "running qa" }], usage: { output_tokens: 3 } } },
      { type: "result", subtype: "success", is_error: false, result: "qa passed", _audit_timestamp: "2026-05-23T18:00:04.000Z" },
    ].map((o) => JSON.stringify(o)).join("\n");
    await write(lines + "\n");
    const s = await new CoworkReader(refFor(file)).readIncremental();
    expect(s.userTurns).toEqual([]); // both the raw "/qa run" echo and the <…> replay are skipped
    expect(s.firstPrompt).toBeNull();
    expect(s.endedTurn).toBe(true);
    expect(s.lastText).toBe("qa passed");
  });
});
