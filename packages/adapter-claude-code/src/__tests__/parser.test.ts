import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fold, initial, pendingSubagents, summarizeTodos, usageContextTokens } from "../parser.js";

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
