import { describe, expect, it } from "vitest";
import {
  codexToolDetail,
  codexTodo,
  execScriptDetail,
  foldCodex,
  initialCodex,
  isCodexHumanTurn,
  metricOf,
  usageOf,
  type CodexState,
} from "../codex/parser.js";

const THREAD = "01a0c3ac-0000-7000-8000-000000000001";
let ord = 0;
function rec(type: string, payload: Record<string, unknown>, ts = "2026-09-21T11:14:22.358Z", ordinal?: number): string {
  return JSON.stringify({ timestamp: ts, ordinal: ordinal ?? ord++, type, payload });
}
function meta(extra: Record<string, unknown> = {}): string {
  return rec("session_meta", { id: THREAD, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode", ...extra });
}
function usage(input: number, cached: number, output: number, reasoning = 0) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
}
function tokenCount(total: ReturnType<typeof usage>, last = total, ts?: string): string {
  return rec("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 }, rate_limits: null }, ts);
}
function userMsg(text: string, ts?: string): string {
  return rec("response_item", { type: "message", id: "msg_u", role: "user", content: [{ type: "input_text", text }] }, ts);
}
function assistantMsg(text: string, ts?: string): string {
  return rec("response_item", { type: "message", id: "msg_a", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] }, ts);
}
function foldAll(lines: string[], state: CodexState = initialCodex()): CodexState {
  return lines.reduce((s, l) => foldCodex(s, l), state);
}

describe("isCodexHumanTurn", () => {
  it("keeps plain requests, including the gstack 'IMPORTANT:' prompt", () => {
    expect(isCodexHumanTurn("프로젝트 코드를 분석해줘\n")).toBe(true);
    expect(isCodexHumanTurn("IMPORTANT: Do NOT read SKILL.md files. Summarize.")).toBe(true);
  });
  it("drops app-injected wrappers", () => {
    expect(isCodexHumanTurn("<environment_context>\n<cwd>/x</cwd>\n</environment_context>")).toBe(false);
    expect(isCodexHumanTurn("<recommended_plugins>\n- Airtable")).toBe(false);
    expect(isCodexHumanTurn("<send_user_message_question_reply>[{}]")).toBe(false);
    expect(isCodexHumanTurn("\n# Files mentioned by the user:\n\n## a.md: /x/a.md")).toBe(false);
    expect(isCodexHumanTurn("# Files pasted by the user:\n")).toBe(false);
    expect(isCodexHumanTurn("# Selected text\nfoo")).toBe(false);
    expect(isCodexHumanTurn("# AGENTS.md instructions for /x\n")).toBe(false);
    expect(isCodexHumanTurn("   ")).toBe(false);
  });
});

describe("foldCodex — meta, turn lifecycle, model/mode", () => {
  it("takes cwd/version/originator from the first meta and ignores a repeated (parent) meta", () => {
    ord = 0;
    const s = foldAll([meta(), rec("session_meta", { id: "other", cwd: "/elsewhere", originator: "codex_exec", cli_version: "0.1.0", source: "exec" })]);
    expect(s.cwd).toBe("/Users/alice/projects/demo");
    expect(s.version).toBe("0.154.0");
    expect(s.originator).toBe("Codex Desktop");
  });

  it("latches endedTurn on task_complete, keeps it through passive records, clears on the next human turn", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      rec("event_msg", { type: "task_started", turn_id: "t1", model_context_window: 258400 }),
      userMsg("안녕"),
      assistantMsg("네"),
      rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "네" }),
      rec("event_msg", { type: "thread_settings_applied", thread_id: THREAD, thread_settings: {} }),
    ]);
    expect(s.endedTurn).toBe(true);
    expect(s.lastTurnClean).toBe(true);
    expect(s.contextLimit).toBe(258400);
    foldCodex(s, userMsg("다음"));
    expect(s.endedTurn).toBe(false);
    expect(s.turnTokens).toBe(0);
  });

  it("turn_aborted ends the turn as cancelled; a new task_started resets the flags", () => {
    ord = 0;
    const s = foldAll([meta(), rec("event_msg", { type: "task_started", turn_id: "t1" }), userMsg("x"), rec("event_msg", { type: "turn_aborted", turn_id: "t1", reason: "interrupted" })]);
    expect(s.endedTurn).toBe(true);
    expect(s.sawCancelled).toBe(true);
    expect(s.lastTurnClean).toBe(false);
    foldCodex(s, rec("event_msg", { type: "task_started", turn_id: "t2" }));
    expect(s.endedTurn).toBe(false);
    expect(s.sawCancelled).toBe(false);
  });

  it("reads model and approval policy from turn_context", () => {
    ord = 0;
    const s = foldAll([meta(), rec("turn_context", { turn_id: "t1", cwd: "/Users/alice/projects/demo", approval_policy: "on-request", model: "gpt-6-astra", effort: "high" })]);
    expect(s.model).toBe("gpt-6-astra");
    expect(s.mode).toBe("on-request");
  });

  it("throws on malformed JSON so the tail loop can roll back", () => {
    expect(() => foldCodex(initialCodex(), "{\"type\":\"event_msg\"")).toThrow();
  });
});

describe("foldCodex — human turns and replies", () => {
  it("collects real user turns (wrappers skipped), stamps turn start, and pairs the assistant reply", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      userMsg("<environment_context>x</environment_context>", "2026-09-21T11:14:25.000Z"),
      userMsg("프로젝트 코드를 분석해줘\n", "2026-09-21T11:14:25.200Z"),
      assistantMsg("첫 답", "2026-09-21T11:14:26.000Z"),
      assistantMsg("프로젝트는 pnpm 모노레포입니다.", "2026-09-21T11:14:30.000Z"),
    ]);
    expect(s.userTurns).toEqual(["프로젝트 코드를 분석해줘"]);
    expect(s.userResponses).toEqual(["프로젝트는 pnpm 모노레포입니다."]);
    expect(s.lastText).toBe("프로젝트는 pnpm 모노레포입니다.");
    expect(s.lastUserTurnTsMs).toBe(Date.parse("2026-09-21T11:14:25.200Z"));
    expect(s.firstTsMs).toBe(Date.parse("2026-09-21T11:14:22.358Z"));
    expect(s.lastTsMs).toBe(Date.parse("2026-09-21T11:14:30.000Z"));
  });
});

describe("foldCodex — tokens", () => {
  it("sums cumulative deltas of uncached input + output, ignoring duplicate token_count events", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      userMsg("q", "2026-09-21T11:14:25.200Z"),
      tokenCount(usage(12880, 9600, 328, 29), undefined, "2026-09-21T11:14:27.100Z"),
      tokenCount(usage(26000, 21000, 500, 40), usage(13120, 11400, 172, 11), "2026-09-21T11:14:30.100Z"),
      tokenCount(usage(26000, 21000, 500, 40), usage(13120, 11400, 172, 11), "2026-09-21T11:14:30.200Z"),
    ]);
    expect(s.totalTokens).toBe(3608 + 1892);
    expect(s.turnTokens).toBe(5500);
    expect(s.tokenEvents).toBe(3);
    expect(s.contextTokens).toBe(13292 - 11);
    expect(s.contextLimit).toBe(258400);
    expect(s.firstTokenTsMs).toBe(Date.parse("2026-09-21T11:14:27.100Z"));
  });

  it("treats a drop in total_tokens as a reset (fresh cumulative)", () => {
    ord = 0;
    const s = foldAll([meta(), tokenCount(usage(50000, 40000, 1000)), tokenCount(usage(3000, 0, 100))]);
    expect(s.totalTokens).toBe(11000 + 3100);
  });

  it("ignores token_count without info", () => {
    ord = 0;
    const s = foldAll([meta(), rec("event_msg", { type: "token_count", info: null, rate_limits: {} })]);
    expect(s.totalTokens).toBe(0);
    expect(s.tokenEvents).toBe(0);
  });

  it("usageOf / metricOf", () => {
    expect(usageOf(null)).toBeNull();
    const u = usageOf(usage(100, 60, 10, 3))!;
    expect(u).toEqual({ input: 100, cached: 60, cacheWrite: 0, output: 10, reasoning: 3, total: 110 });
    expect(metricOf(u)).toBe(50);
  });
});

describe("foldCodex — sub-agent prefix skip", () => {
  it("skips records below subagent_history_start_ordinal (the parent's copied history)", () => {
    ord = 0;
    const s = foldAll([
      meta({ parent_thread_id: "p", subagent_history_start_ordinal: 4, source: { subagent: { thread_spawn: { parent_thread_id: "p", agent_nickname: "Bacon" } } } }),
      rec("session_meta", { id: "p", cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode" }, "2026-09-21T11:14:22.358Z"),
      userMsg("부모의 요청", "2026-09-21T11:14:25.200Z"),
      tokenCount(usage(12880, 9600, 328), undefined, "2026-09-21T11:14:27.100Z"),
      userMsg("자식의 과제", "2026-09-21T11:20:00.400Z"),
      tokenCount(usage(3000, 0, 100), undefined, "2026-09-21T11:20:06.000Z"),
    ]);
    expect(s.userTurns).toEqual(["자식의 과제"]);
    expect(s.totalTokens).toBe(3100);
    expect(s.firstTsMs).toBe(Date.parse("2026-09-21T11:14:22.358Z"));
    expect(s.lastTsMs).toBe(Date.parse("2026-09-21T11:20:06.000Z"));
  });
});

describe("foldCodex — tools", () => {
  it("function_call: name + salient detail, counts tools, clears endedTurn", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      rec("event_msg", { type: "task_complete", turn_id: "t0" }),
      rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la", workdir: "/x" }), call_id: "c1" }),
    ]);
    expect(s.lastToolName).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("ls -la");
    expect(s.toolCount).toBe(1);
    expect(s.endedTurn).toBe(false);
  });

  it("custom exec: inner tools.<name> becomes the tool, cmd/q the detail", () => {
    ord = 0;
    const s = foldAll([meta(), rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c2", input: 'text(await tools.exec_command({cmd:"cat \'/x/a.md\'",max_output_tokens:1000}))' })]);
    expect(s.lastToolName).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("cat '/x/a.md'");
    foldCodex(s, rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c3", input: "text(await tools.web__run({search_query:[{q:'site.law.go.kr 여신전문금융업법'}],response_length:'short'}))" }));
    expect(s.lastToolName).toBe("web__run");
    expect(s.lastActivityDetail).toBe("site.law.go.kr 여신전문금융업법");
    expect(s.toolCount).toBe(2);
  });

  it("update_plan becomes a todo snapshot", () => {
    ord = 0;
    const s = foldAll([meta(), rec("response_item", { type: "function_call", name: "update_plan", call_id: "c4", arguments: JSON.stringify({ explanation: "", plan: [{ step: "구조 확인", status: "completed" }, { step: "라우팅 파악", status: "in_progress" }, { step: "리스크 정리", status: "pending" }] }) })]);
    expect(codexTodo(s)).toEqual({ total: 3, done: 1, current: "라우팅 파악", next: "리스크 정리" });
    expect(codexTodo(initialCodex())).toBeNull();
  });

  it("codexToolDetail / execScriptDetail", () => {
    expect(codexToolDetail("js", { code: "await cua.getState();", title: "시뮬레이터 미리보기 탭 확인" })).toBe("시뮬레이터 미리보기 탭 확인");
    expect(codexToolDetail("js", { code: "await cua.getState();" })).toBe("await cua.getState();");
    expect(codexToolDetail("spawn_agent", { task_name: "map_audit", message: "enc" })).toBe("map_audit");
    expect(codexToolDetail("send_message", { target: "map_audit", message: "enc" })).toBe("map_audit");
    expect(codexToolDetail("followup_task", { target: "review", message: "enc" })).toBe("review");
    expect(codexToolDetail("request_user_input_async", { questions: [{ title: "어디에 쓰나요?", options: [] }] })).toBe("어디에 쓰나요?");
    expect(codexToolDetail("wait", {})).toBeNull();
    expect(codexToolDetail("exec_command", { cmd: "x".repeat(100) })?.length).toBe(60);
    expect(execScriptDetail("tools.exec_command({cmd:`echo hi`})")).toBe("echo hi");
    expect(execScriptDetail("tools.sleep({ms:100})")).toBeNull();
  });
});

describe("foldCodex — caps, fallbacks, malformed inputs", () => {
  it("caps userTurns at 100 keeping the first turn, and truncates a long turn to 200 chars", () => {
    ord = 0;
    const s = foldAll([meta(), ...Array.from({ length: 101 }, (_, i) => userMsg(`t${i}`))]);
    expect(s.userTurns).toHaveLength(100);
    expect(s.userResponses).toHaveLength(100);
    expect(s.userTurns[0]).toBe("t0");
    expect(s.userTurns[1]).toBe("t2"); // the 2nd turn is the one evicted
    expect(s.userTurns[99]).toBe("t100");
    foldCodex(s, userMsg("t101"));
    expect(s.userTurns).toHaveLength(100);
    expect(s.userTurns[1]).toBe("t3");
    expect(s.userTurns[99]).toBe("t101");
    foldCodex(s, userMsg("  " + "x".repeat(250) + "  "));
    expect(s.userTurns[99]).toBe("x".repeat(200));
  });

  it("truncates lastText to 200 chars, ignores an empty reply, and tolerates a reply before any human turn", () => {
    ord = 0;
    const s = foldAll([meta(), assistantMsg("solo")]);
    expect(s.lastText).toBe("solo");
    expect(s.userResponses).toEqual([]);
    foldAll([userMsg("q"), assistantMsg("y".repeat(300))], s);
    expect(s.lastText).toBe("y".repeat(200));
    expect(s.userResponses).toEqual(["y".repeat(200)]);
    foldCodex(s, assistantMsg("   "));
    expect(s.lastText).toBe("y".repeat(200));
    expect(s.userResponses).toEqual(["y".repeat(200)]);
  });

  it("falls back to the line index as ordinal for records without one (sub-agent prefix skip)", () => {
    const noOrd = (type: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: "2026-09-21T11:14:22.358Z", type, payload });
    const s = foldAll([
      noOrd("session_meta", { id: THREAD, cwd: "/w", originator: "Codex Desktop", cli_version: "0.154.0", parent_thread_id: "p", subagent_history_start_ordinal: 2, source: { subagent: { thread_spawn: { parent_thread_id: "p" } } } }),
      noOrd("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "parent turn" }] }),
      noOrd("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "child turn" }] }),
    ]);
    expect(s.lineIndex).toBe(3);
    expect(s.userTurns).toEqual(["child turn"]);
  });

  it("tool calls: malformed/object function_call arguments, non-exec custom tools, and nameless calls", () => {
    ord = 0;
    const s = foldAll([meta(), rec("response_item", { type: "function_call", name: "exec_command", arguments: "{not json", call_id: "c1" })]);
    expect(s.toolCount).toBe(1);
    expect(s.lastToolName).toBe("exec_command");
    expect(s.lastActivityDetail).toBeNull();
    foldCodex(s, rec("response_item", { type: "function_call", name: "exec_command", arguments: { cmd: "pwd" }, call_id: "c2" }));
    expect(s.lastActivityDetail).toBe("pwd");
    foldCodex(s, rec("response_item", { type: "function_call", arguments: "{}", call_id: "c3" }));
    expect(s.toolCount).toBe(2);
    expect(s.lastToolName).toBe("exec_command");
    // custom_tool_call: a non-exec tool keeps its own name; exec without tools.<name>() stays exec
    foldCodex(s, rec("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "c4", input: "*** Begin Patch\n*** End Patch" }));
    expect(s.lastToolName).toBe("apply_patch");
    expect(s.lastActivityDetail).toBeNull();
    expect(s.toolCount).toBe(3);
    foldCodex(s, rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c5", input: "await sleep(10)" }));
    expect(s.lastToolName).toBe("exec");
    expect(s.lastActivityDetail).toBeNull();
    foldCodex(s, rec("response_item", { type: "custom_tool_call", call_id: "c6", input: "x" }));
    expect(s.toolCount).toBe(4);
  });

  it("token_count with only last_token_usage updates context but not totals; a later event without last keeps the context", () => {
    ord = 0;
    const s = foldAll([meta(), rec("event_msg", { type: "token_count", info: { last_token_usage: usage(1000, 0, 50, 5), model_context_window: 100 }, rate_limits: null })]);
    expect(s.contextTokens).toBe(1045);
    expect(s.contextLimit).toBe(100);
    expect(s.tokenEvents).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.firstTokenTsMs).toBeNull();
    foldCodex(s, rec("event_msg", { type: "token_count", info: { total_token_usage: usage(1000, 0, 50, 5) }, rate_limits: null }));
    expect(s.contextTokens).toBe(1045);
    expect(s.tokenEvents).toBe(1);
    expect(s.totalTokens).toBe(1050);
  });

  it("a first session_meta without cwd is ignored, later records still fold, and a later valid meta is accepted", () => {
    ord = 0;
    const s = foldAll([rec("session_meta", { id: THREAD, originator: "codex_exec" }), userMsg("hi")]);
    expect(s.meta).toBeNull();
    expect(s.cwd).toBeNull();
    expect(s.userTurns).toEqual(["hi"]);
    foldCodex(s, meta());
    expect(s.cwd).toBe("/Users/alice/projects/demo");
    expect(s.version).toBe("0.154.0");
  });
});
