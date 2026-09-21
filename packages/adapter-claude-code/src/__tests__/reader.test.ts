import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeReader } from "../reader.js";
import type { SessionRef } from "@claude-monitor/core";

const LINE_A = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "tu_1", name: "Agent", input: { description: "explore" } },
    ],
  },
});
const LINE_B = JSON.stringify({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
  },
});
const LINE_C = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "finished" }] },
});

function mkRef(source: string): SessionRef {
  return {
    id: "sess1",
    adapterId: "claude-code",
    workspace: "/tmp/ws",
    workspaceShort: "ws",
    projectKey: "/tmp/ws",
    projectLabel: "ws",
    owner: "unknown",
    source,
    mtime: Math.floor(Date.now() / 1000),
  };
}

describe("ClaudeCodeReader incremental tail", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-reader-"));
    file = join(dir, "sess1.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads from empty → appended lines", async () => {
    await fs.writeFile(file, "");
    const r = new ClaudeCodeReader(mkRef(file));
    let s = await r.readIncremental();
    expect(s.pendingSubagents).toEqual([]);

    await fs.appendFile(file, LINE_A + "\n");
    s = await r.readIncremental();
    expect(s.pendingSubagents).toHaveLength(1);
    expect(s.lastTool).toBe("Agent");

    await fs.appendFile(file, LINE_B + "\n" + LINE_C + "\n");
    s = await r.readIncremental();
    expect(s.pendingSubagents).toEqual([]);
    expect(s.lastText).toBe("finished");
  });

  it("does not re-read unchanged content (idempotent)", async () => {
    await fs.writeFile(file, LINE_A + "\n" + LINE_B + "\n");
    const r = new ClaudeCodeReader(mkRef(file));
    const s1 = await r.readIncremental();
    const s2 = await r.readIncremental();
    expect(s1.pendingSubagents).toEqual(s2.pendingSubagents);
  });

  it("handles truncate by restarting from byte 0", async () => {
    await fs.writeFile(file, LINE_A + "\n" + LINE_B + "\n");
    const r = new ClaudeCodeReader(mkRef(file));
    await r.readIncremental();

    // Truncate and rewrite shorter content
    await fs.writeFile(file, LINE_C + "\n");
    const s = await r.readIncremental();
    expect(s.lastText).toBe("finished");
    expect(s.pendingSubagents).toEqual([]);
  });

  it("rolls back on partial-write line", async () => {
    await fs.writeFile(file, LINE_A + "\n");
    const r = new ClaudeCodeReader(mkRef(file));
    await r.readIncremental();

    // Append a half-line (no newline, broken JSON)
    await fs.appendFile(file, '{"type":"assistant","mess');
    const s1 = await r.readIncremental();
    expect(s1.pendingSubagents).toHaveLength(1);
    // Now complete the line
    await fs.appendFile(
      file,
      'age":{"content":[{"type":"tool_use","id":"tu_2","name":"Agent","input":{"description":"d"}}]}}\n',
    );
    const s2 = await r.readIncremental();
    expect(s2.pendingSubagents).toHaveLength(2);
  });

  it("cwd로 ref(projectKey/label/owner/workspace)를 정정하고 메타를 채운다", async () => {
    const enriched = JSON.stringify({
      type: "assistant",
      cwd: "/Users/kim/conductor/workspaces/proj-x/lisbon",
      gitBranch: "main",
      version: "2.1.156",
      permissionMode: "acceptEdits",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 2, cache_read_input_tokens: 98, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "hello" }],
      },
    });
    await fs.writeFile(file, enriched + "\n");
    const sum = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    expect(sum.ref.workspace).toBe("/Users/kim/conductor/workspaces/proj-x/lisbon");
    expect(sum.ref.projectKey).toBe("conductor/proj-x");
    expect(sum.ref.projectLabel).toBe("proj-x");
    expect(sum.ref.owner).toBe("kim");
    expect(sum.model).toBe("claude-opus-4-8");
    expect(sum.mode).toBe("acceptEdits");
    expect(sum.version).toBe("2.1.156");
    expect(sum.context).toEqual({ tokens: 100, limit: 200_000, pct: 100 / 200_000 });
    expect(sum.runner).toBe("unknown");
    expect(sum.pid).toBeNull();
  });

  it("runner를 transcript entrypoint에서 폴백한다 (sdk-ts + conductor cwd → conductor)", async () => {
    const withEntrypoint = JSON.stringify({
      type: "assistant",
      entrypoint: "sdk-ts",
      cwd: "/Users/kim/conductor/workspaces/proj-x/lisbon",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    await fs.writeFile(file, withEntrypoint + "\n");
    const sum = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    expect(sum.runner).toBe("conductor");
  });

  it("child agent: agentStatus=done + metrics from an end_turn transcript", async () => {
    const childRef: SessionRef = { ...mkRef(file), parentId: "PARENT-UUID" };
    const l1 = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-11T00:00:00.000Z",
      message: {
        stop_reason: "tool_use",
        usage: { input_tokens: 1, cache_creation_input_tokens: 50, output_tokens: 9 },
        content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }],
      },
    });
    const l2 = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-11T00:00:20.000Z",
      message: {
        stop_reason: "end_turn",
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
        content: [{ type: "text", text: "ok" }],
      },
    });
    await fs.writeFile(file, l1 + "\n" + l2 + "\n");
    const sum = await new ClaudeCodeReader(childRef).readIncremental();
    expect(sum.agentStatus).toBe("done");
    expect(sum.metrics).toEqual({ tokens: 65, tools: 1, durationSec: 20 });
    // startSec = first token-bearing assistant event (matches the detail page's basis).
    expect(sum.startSec).toBe(Math.floor(Date.parse("2026-06-11T00:00:00.000Z") / 1000));
  });

  it("non-child session: agentStatus is null", async () => {
    await fs.writeFile(file, LINE_C + "\n");
    const sum = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    expect(sum.agentStatus).toBeNull();
  });

  it("ref.mtime tracks the last TIMESTAMPED record, not a bumped file mtime", async () => {
    // Conversation ended at a fixed past time; a later metadata write bumps the
    // file mtime to ~now. ref.mtime must reflect the conversation, not the file.
    const turnTs = "2026-06-11T00:00:00.000Z";
    const turnSec = Math.floor(Date.parse(turnTs) / 1000);
    const convo = JSON.stringify({
      type: "assistant",
      timestamp: turnTs,
      message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    });
    // A trailing metadata record with NO timestamp (mirrors file-history-snapshot
    // / ai-title bridge records that bump the file long after the last turn).
    const meta = JSON.stringify({ type: "file-history-snapshot", snapshot: {} });
    await fs.writeFile(file, convo + "\n" + meta + "\n");
    // Force the file mtime far into the "recent" window.
    const nowSec = Math.floor(Date.now() / 1000);
    await fs.utimes(file, nowSec, nowSec);

    const sum = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    expect(sum.ref.mtime).toBe(turnSec); // last timestamped record, not the bumped file mtime
    expect(sum.status).toBe("stop"); // genuinely old → not "live"/"waiting" despite fresh file mtime
  });

  it("falls back to file mtime when no record carries a timestamp", async () => {
    await fs.writeFile(file, LINE_A + "\n" + LINE_C + "\n"); // neither line has a timestamp
    const fileMtime = Math.floor((await fs.stat(file)).mtimeMs / 1000);
    const sum = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    expect(sum.ref.mtime).toBe(fileMtime);
  });

  it("startSec: null until the first token-bearing assistant event, then fixed across later appends", async () => {
    // A brand-new session: the prompt is on disk before Claude has answered.
    const prompt = JSON.stringify({ type: "user", timestamp: "2026-06-11T00:00:00.000Z", message: { content: "build it" } });
    await fs.writeFile(file, prompt + "\n");
    const r = new ClaudeCodeReader(mkRef(file));
    expect((await r.readIncremental()).startSec).toBeNull(); // no token event yet → header shows no start

    const reply = (ts: string, id: string): string =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: { id, usage: { input_tokens: 3, output_tokens: 7 }, content: [{ type: "text", text: "ok" }] },
      });
    await fs.appendFile(file, reply("2026-06-11T00:00:05.500Z", "msg_1") + "\n");
    const start = Math.floor(Date.parse("2026-06-11T00:00:05.500Z") / 1000);
    expect((await r.readIncremental()).startSec).toBe(start); // the reply, not the earlier prompt

    await fs.appendFile(file, reply("2026-06-11T00:10:00.000Z", "msg_2") + "\n");
    expect((await r.readIncremental()).startSec).toBe(start); // later token events don't move it
  });

  it("startSec after a shorter rewrite reflects the NEW content (or null), not the pre-truncate value", async () => {
    const sec = (ts: string): number => Math.floor(Date.parse(ts) / 1000);
    const reply = (ts: string, id: string, text = "ok"): string =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: { id, usage: { input_tokens: 3, output_tokens: 7 }, content: [{ type: "text", text }] },
      });
    const prompt = (ts: string, text: string): string =>
      JSON.stringify({ type: "user", timestamp: ts, message: { content: text } });

    // Original transcript: first token-bearing reply at T_OLD, padded so every
    // rewrite below is strictly shorter (the reset only fires on size < byteOffset).
    const T_OLD = "2026-06-11T00:00:05.000Z";
    const original =
      [
        prompt("2026-06-11T00:00:00.000Z", "old question"),
        reply(T_OLD, "msg_old_1", "x".repeat(4000)),
        reply("2026-06-11T00:05:00.000Z", "msg_old_2"),
      ].join("\n") + "\n";
    await fs.writeFile(file, original);
    const r = new ClaudeCodeReader(mkRef(file));
    expect((await r.readIncremental()).startSec).toBe(sec(T_OLD));

    // Rewritten in place with a different session whose first reply is at T_NEW.
    const T_NEW = "2026-06-12T09:30:00.000Z";
    const rewritten = [prompt("2026-06-12T09:29:58.000Z", "new question"), reply(T_NEW, "msg_new_1")].join("\n") + "\n";
    expect(Buffer.byteLength(rewritten)).toBeLessThan(Buffer.byteLength(original)); // truncate precondition
    await fs.writeFile(file, rewritten);
    const afterRewrite = await r.readIncremental();
    expect(afterRewrite.userTurns).toEqual(["new question"]); // the new content was read from byte 0
    expect(afterRewrite.startSec).toBe(sec(T_NEW)); // not the stale T_OLD (first-wins must restart)

    // Rewritten again, shorter still, with no token-bearing assistant event at all.
    const noReply = prompt("2026-06-13T08:00:00.000Z", "fresh") + "\n";
    expect(Buffer.byteLength(noReply)).toBeLessThan(Buffer.byteLength(rewritten)); // truncate precondition
    await fs.writeFile(file, noReply);
    const afterSecond = await r.readIncremental();
    expect(afterSecond.userTurns).toEqual(["fresh"]);
    expect(afterSecond.startSec).toBeNull(); // no reply yet → no start, not a carried-over value
  });

  // --- concurrency: LocalDataSource can call one reader from two paths at once
  // (observed at startup: a watcher-triggered flush still in flight when the
  // priming loop reaches the same entry). Every byte must still fold exactly once.

  /** Timestamped human turns + per-message usage, padded so one pass spans many
   *  64 KiB chunk reads (i.e. it yields mid-tail). Ends mid-turn (no end_turn). */
  function bigTranscript(turns: number): string {
    const lines: string[] = [];
    for (let i = 0; i < turns; i++) {
      const ts = new Date(Date.UTC(2026, 5, 11, 0, 0, i)).toISOString();
      lines.push(JSON.stringify({ type: "user", timestamp: ts, message: { content: `question ${i}` } }));
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: ts,
          message: {
            id: `msg_${i}`,
            stop_reason: "tool_use",
            usage: { input_tokens: 1, cache_creation_input_tokens: 10, output_tokens: 100 },
            content: [{ type: "text", text: "x".repeat(8000) }],
          },
        }),
      );
    }
    return lines.join("\n") + "\n";
  }

  it("concurrent readIncremental calls fold each byte once (== a sequential read)", async () => {
    await fs.writeFile(file, bigTranscript(400));
    const baseline = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    const r = new ClaudeCodeReader(mkRef(file));
    const out = await Promise.all([r.readIncremental(), r.readIncremental(), r.readIncremental()]);
    for (const s of out) {
      expect(s.totalTokens).toBe(baseline.totalTokens);
      expect(s.userTurns).toEqual(baseline.userTurns);
    }
    // …and the reader's state is intact for the next (sequential) read.
    expect((await r.readIncremental()).totalTokens).toBe(baseline.totalTokens);
  });

  it("a call issued after an append reflects it, even while an earlier pass is in flight", async () => {
    await fs.writeFile(file, bigTranscript(400));
    const r = new ClaudeCodeReader(mkRef(file));
    const first = r.readIncremental(); // stats the file, then tails ~3 MB across many awaits
    await new Promise((res) => setImmediate(res)); // usually past its stat by now (not guaranteed)
    await fs.appendFile(
      file,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-11T01:00:00.000Z",
        message: { id: "msg_final", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      }) + "\n",
    );
    const second = r.readIncremental(); // issued AFTER the append (e.g. the flush that append triggered)
    // Pass 1's own result is not asserted: whether its stat ran before or after the
    // append is up to the fs threadpool, and either answer is correct for pass 1.
    await first;
    // Joining the in-flight pass would serve its pre-append snapshot and never see
    // the closing end_turn — the card would miss "waiting" until some later write.
    expect((await second).endedTurn).toBe(true);
  });

  it("a failed pass (file briefly missing) still rejects, and does not block later reads", async () => {
    const r = new ClaudeCodeReader(mkRef(file)); // not created yet → stat ENOENT
    await expect(r.readIncremental()).rejects.toThrow();
    await fs.writeFile(file, LINE_C + "\n");
    expect((await r.readIncremental()).lastText).toBe("finished");
  });
});
