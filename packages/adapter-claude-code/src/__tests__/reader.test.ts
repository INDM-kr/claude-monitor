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
  });

  it("non-child session: agentStatus is null", async () => {
    await fs.writeFile(file, LINE_C + "\n");
    const sum = await new ClaudeCodeReader(mkRef(file)).readIncremental();
    expect(sum.agentStatus).toBeNull();
  });
});
