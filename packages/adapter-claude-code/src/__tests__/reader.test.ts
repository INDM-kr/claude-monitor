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
});
