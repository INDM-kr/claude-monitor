import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fold, initial, pendingSubagents, summarizeTodos } from "../parser.js";

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
