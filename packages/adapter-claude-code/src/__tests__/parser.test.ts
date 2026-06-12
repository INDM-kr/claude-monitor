import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fold, initial, metricTokens, pendingSubagents, salientDetail, summarizeTasks, summarizeTodos, usageContextTokens } from "../parser.js";

function taskLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name, input }] } });
}

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string[] {
  const path = join(HERE, "fixtures", name);
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

function parseFile(name: string) {
  let state = initial();
  for (const line of loadFixture(name)) {
    state = fold(state, line);
  }
  return state;
}

describe("parser fold — idle-session.jsonl", () => {
  it("captures last tool and last text", () => {
    const s = parseFile("idle-session.jsonl");
    expect(s.lastToolName).toBe("Read");
    expect(s.lastText).toBe("all done");
  });

  it("resolves the only tool call", () => {
    const s = parseFile("idle-session.jsonl");
    expect(pendingSubagents(s)).toEqual([]);
  });

  it("has no todos", () => {
    const s = parseFile("idle-session.jsonl");
    expect(summarizeTodos(s.lastTodos)).toBeNull();
  });
});

describe("parser fold — pending-subagent.jsonl", () => {
  it("detects one pending subagent", () => {
    const s = parseFile("pending-subagent.jsonl");
    const pending = pendingSubagents(s);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("tu_b");
    expect(pending[0]?.desc).toBe("map data sources");
    expect(pending[0]?.type).toBe("Explore");
  });

  it("lastToolName is Agent (the last tool_use)", () => {
    const s = parseFile("pending-subagent.jsonl");
    expect(s.lastToolName).toBe("Agent");
  });

  it("truncates subagent desc to 40 chars", () => {
    let state = initial();
    state = fold(
      state,
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_long",
              name: "Agent",
              input: { description: "a".repeat(100) },
            },
          ],
        },
      }),
    );
    expect(pendingSubagents(state)[0]?.desc.length).toBe(40);
    expect(pendingSubagents(state)[0]?.type).toBeNull();
  });
});

describe("parser fold — TaskCreate/TaskUpdate (Feature H)", () => {
  it("reconstructs a task snapshot from creation order + status updates", () => {
    let s = initial();
    s = fold(s, taskLine("TaskCreate", { subject: "build" }));
    s = fold(s, taskLine("TaskCreate", { subject: "test" }));
    s = fold(s, taskLine("TaskUpdate", { taskId: "1", status: "completed" }));
    s = fold(s, taskLine("TaskUpdate", { taskId: "2", status: "in_progress" }));
    expect(summarizeTasks(s)).toEqual({ total: 2, done: 1, current: "test", next: null });
  });

  it("summarizeTasks is null with no tasks", () => {
    expect(summarizeTasks(initial())).toBeNull();
  });
});

describe("parser fold — todowrite.jsonl", () => {
  it("computes total/done/current/next correctly", () => {
    const s = parseFile("todowrite.jsonl");
    const todo = summarizeTodos(s.lastTodos);
    expect(todo).toEqual({
      total: 5,
      done: 2,
      current: "Implement parser",
      next: "Wire SSE",
    });
  });

  it("lastText reflects the trailing assistant message", () => {
    const s = parseFile("todowrite.jsonl");
    expect(s.lastText).toBe("Updated todos.");
  });
});

describe("parser fold — last text truncation", () => {
  it("truncates last_text to 200 chars", () => {
    let state = initial();
    state = fold(
      state,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "x".repeat(500) }] },
      }),
    );
    expect(state.lastText?.length).toBe(200);
  });
});

describe("parser fold — malformed line", () => {
  it("throws on invalid JSON (caller handles)", () => {
    const state = initial();
    expect(() => fold(state, "not json")).toThrow();
  });
});

describe("parser metadata enrichment", () => {
  it("최상위 cwd/gitBranch/version/permissionMode를 흡수", () => {
    let s = initial();
    s = fold(s, JSON.stringify({
      type: "assistant",
      cwd: "/Users/x/conductor/workspaces/proj/edinburgh",
      gitBranch: "feature-1",
      version: "2.1.156",
      permissionMode: "plan",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 9 }, content: [] },
    }));
    expect(s.cwd).toBe("/Users/x/conductor/workspaces/proj/edinburgh");
    expect(s.gitBranch).toBe("feature-1");
    expect(s.version).toBe("2.1.156");
    expect(s.mode).toBe("plan");
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.contextTokens).toBe(110);
  });

  it("<synthetic> 모델은 무시", () => {
    let s = initial();
    s = fold(s, JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", content: [] } }));
    s = fold(s, JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }));
    expect(s.model).toBe("claude-opus-4-8");
  });

  it("usageContextTokens는 누락 필드를 0으로", () => {
    expect(usageContextTokens({ input_tokens: 5 })).toBe(5);
    expect(usageContextTokens({})).toBe(0);
  });
});

describe("parser fold — lastActivityDetail (Feature D)", () => {
  it("salientDetail: Bash uses description, falls back to command", () => {
    expect(salientDetail("Bash", { description: "run tests", command: "pnpm test" })).toBe("run tests");
    expect(salientDetail("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("salientDetail: file tools use basename", () => {
    expect(salientDetail("Edit", { file_path: "/a/b/SessionCard.tsx" })).toBe("SessionCard.tsx");
    expect(salientDetail("Read", { file_path: "/x/y/reader.ts" })).toBe("reader.ts");
  });

  it("salientDetail: Grep/Glob use pattern; Task uses description", () => {
    expect(salientDetail("Grep", { pattern: "foo.*bar" })).toBe("foo.*bar");
    expect(salientDetail("Task", { description: "explore", subagent_type: "Explore" })).toBe("explore");
  });

  it("salientDetail: unknown tool or no target → null; truncates to 60", () => {
    expect(salientDetail("WeirdTool", { x: 1 })).toBeNull();
    expect(salientDetail("Bash", {})).toBeNull();
    expect(salientDetail("Bash", { command: "x".repeat(100) })?.length).toBe(60);
  });

  it("accumulates agent metrics: totalTokens, toolCount, phase, stop_reason, ts", () => {
    let s = initial();
    s = fold(
      s,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-11T00:00:00.000Z",
        message: {
          stop_reason: "tool_use",
          usage: { input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 20 },
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", phase: "Review" } }],
        },
      }),
    );
    s = fold(
      s,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-11T00:01:30.000Z",
        message: {
          stop_reason: "end_turn",
          usage: { input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 15 },
          content: [{ type: "text", text: "done" }],
        },
      }),
    );
    expect(s.totalTokens).toBe(150); // (10+100+20) + (5+0+15)
    expect(s.toolCount).toBe(1);
    expect(s.phase).toBe("Review");
    expect(s.lastStopReason).toBe("end_turn");
    expect(s.firstTsMs).toBe(Date.parse("2026-06-11T00:00:00.000Z"));
    expect(s.lastTsMs).toBe(Date.parse("2026-06-11T00:01:30.000Z"));
    expect(s.sawError).toBe(false);
  });

  it("sawError on an api-error line; sawCancelled on interruption; metricTokens excludes cache_read", () => {
    let s = initial();
    s = fold(s, JSON.stringify({ type: "assistant", isApiErrorMessage: true, message: { content: [] } }));
    expect(s.sawError).toBe(true);
    const c = fold(initial(), JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    expect(c.sawCancelled).toBe(true);
    expect(
      metricTokens({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 9999, output_tokens: 20 }),
    ).toBe(130);
  });

  it("fold sets lastActivityDetail on a tool_use; initial is null", () => {
    expect(initial().lastActivityDetail).toBeNull();
    let s = initial();
    s = fold(
      s,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { description: "build dist" } }] },
      }),
    );
    expect(s.lastToolName).toBe("Bash");
    expect(s.lastActivityDetail).toBe("build dist");
  });
});
