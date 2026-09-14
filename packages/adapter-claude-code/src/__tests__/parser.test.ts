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

// Real-shape line builders (human prompt = STRING content; tool_result = array).
const uStr = (content: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
const uTool = (id: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id }] } });
const aTurn = (
  text: string,
  opts: { stop_reason?: string; usage?: Record<string, number>; timestamp?: string; id?: string } = {},
): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: opts.timestamp,
    message: {
      role: "assistant",
      id: opts.id,
      content: [{ type: "text", text }],
      stop_reason: opts.stop_reason,
      usage: opts.usage,
    },
  });

describe("parser fold — user turns + waiting signal", () => {
  it("captures real human turns in order, skipping system/command/meta/tool_result", () => {
    let s = initial();
    [
      uStr("<system_instruction>\nYou are working inside Conductor…"),
      uStr("<command-name>/design-html</command-name>"),
      uStr("ignored skill preamble", { isMeta: true }),
      uStr("첫 진짜 요청"),
      uTool("tu_1"),
      uStr("두번째 요청"),
    ].forEach((l) => (s = fold(s, l)));
    expect(s.userTurns).toEqual(["첫 진짜 요청", "두번째 요청"]);
  });

  it("단일문자 옵션 답변(A/B, 1/2, '1)')은 요청에서 제외", () => {
    let s = initial();
    [uStr("진짜 요청"), uStr("A"), uStr("2"), uStr("1)"), uStr("실제 후속 요청")].forEach((l) => (s = fold(s, l)));
    expect(s.userTurns).toEqual(["진짜 요청", "실제 후속 요청"]);
  });

  it("userResponses: 요청별로 그 턴의 마지막 assistant 텍스트가 같은 인덱스로 페어링", () => {
    let s = initial();
    [
      uStr("첫 요청"),
      aTurn("중간 응답"),
      aTurn("첫 요청 최종 응답"),
      uStr("두번째 요청"),
      aTurn("두번째 최종 응답"),
    ].forEach((l) => (s = fold(s, l)));
    expect(s.userTurns).toEqual(["첫 요청", "두번째 요청"]);
    expect(s.userResponses).toEqual(["첫 요청 최종 응답", "두번째 최종 응답"]);
  });

  it("turnTokens reset on each human turn, accumulate over assistant msgs after", () => {
    let s = initial();
    [
      uStr("첫 요청", { timestamp: "2026-06-16T00:00:00.000Z" }),
      aTurn("작업중", { usage: { output_tokens: 100 } }),
      aTurn("계속", { usage: { output_tokens: 50 }, stop_reason: "end_turn" }),
      uStr("둘째 요청", { timestamp: "2026-06-16T01:00:00.000Z" }),
      aTurn("응답", { usage: { output_tokens: 30 } }),
    ].forEach((l) => (s = fold(s, l)));
    expect(s.turnTokens).toBe(30); // only since the last human turn
    expect(s.lastUserTurnTsMs).toBe(Date.parse("2026-06-16T01:00:00.000Z"));
  });

  it("token totals: repeated usage of one message id (per-content-block split) counts once", () => {
    let s = initial();
    [
      uStr("요청"),
      // one API message split into 3 records, all repeating the same usage
      aTurn("thinking", { id: "msg_a", usage: { output_tokens: 100 } }),
      aTurn("본문", { id: "msg_a", usage: { output_tokens: 100 } }),
      aTurn("툴", { id: "msg_a", usage: { output_tokens: 100 } }),
      // a distinct message adds on top
      aTurn("다음", { id: "msg_b", usage: { output_tokens: 40 } }),
    ].forEach((l) => (s = fold(s, l)));
    expect(s.totalTokens).toBe(140); // not 340
    expect(s.turnTokens).toBe(140);
  });

  it("token totals: streaming growth of one message id lands as a delta (final value wins)", () => {
    let s = initial();
    [
      uStr("요청"),
      aTurn("스트리밍중", { id: "msg_a", usage: { output_tokens: 10 } }),
      aTurn("스트리밍끝", { id: "msg_a", usage: { output_tokens: 250 } }),
    ].forEach((l) => (s = fold(s, l)));
    expect(s.totalTokens).toBe(250);
  });

  it("token totals: id-less usage records keep legacy per-record summing", () => {
    let s = initial();
    [uStr("요청"), aTurn("a", { usage: { output_tokens: 10 } }), aTurn("b", { usage: { output_tokens: 20 } })].forEach(
      (l) => (s = fold(s, l)),
    );
    expect(s.totalTokens).toBe(30);
  });

  it("endedTurn signal: assistant end_turn last → ended; tool_result last → mid-tool", () => {
    let ended = initial();
    [uStr("요청"), aTurn("끝", { stop_reason: "end_turn" })].forEach((l) => (ended = fold(ended, l)));
    expect(ended.lastRecordType).toBe("assistant");
    expect(ended.lastStopReason).toBe("end_turn");

    let mid = initial();
    [uStr("요청"), aTurn("툴", { stop_reason: "tool_use" }), uTool("tu_x")].forEach((l) => (mid = fold(mid, l)));
    expect(mid.lastRecordType).toBe("user"); // tool running → not a finished turn
  });
});

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

  it("cwd는 first-wins — 세션 중 cd해도 시작 디렉토리 유지", () => {
    // 실제 사례: pickko에서 시작한 세션이 도중에 pickko/pickko_admin으로 cd →
    // last-wins면 프로젝트가 pickko_admin으로 오분류됨.
    let s = initial();
    s = fold(s, JSON.stringify({ type: "user", cwd: "/Users/x/PhpstormProjects/pickko" }));
    s = fold(s, JSON.stringify({ type: "assistant", cwd: "/Users/x/PhpstormProjects/pickko/pickko_admin", message: { content: [] } }));
    expect(s.cwd).toBe("/Users/x/PhpstormProjects/pickko");
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
    expect(s.firstTokenTsMs).toBe(Date.parse("2026-06-11T00:00:00.000Z")); // first token-bearing assistant
    expect(s.lastTsMs).toBe(Date.parse("2026-06-11T00:01:30.000Z"));
    expect(s.sawError).toBe(false);
  });

  it("firstTokenTsMs = first token-bearing assistant event, skipping earlier non-token records", () => {
    let s = initial();
    // 1) user prompt (timestamped, no usage) — sets firstTsMs but NOT firstTokenTsMs
    s = fold(
      s,
      JSON.stringify({ type: "user", timestamp: "2026-06-10T23:59:50.000Z", message: { content: [{ type: "text", text: "hi" }] } }),
    );
    // 2) assistant with zero-token usage — still not a token event
    s = fold(
      s,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-10T23:59:55.000Z",
        message: { usage: { input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "" }] },
      }),
    );
    // 3) first assistant with positive tokens — THIS is the project start (detail-page basis)
    s = fold(
      s,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-11T00:00:10.000Z",
        message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 15 }, content: [{ type: "text", text: "ok" }] },
      }),
    );
    expect(s.firstTsMs).toBe(Date.parse("2026-06-10T23:59:50.000Z")); // first timestamped record (the prompt)
    expect(s.firstTokenTsMs).toBe(Date.parse("2026-06-11T00:00:10.000Z")); // first positive-token event (a day later)
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
