import { describe, expect, it } from "vitest";
import { codexSessionIdFromPath, parseCodexMeta, runnerFromOriginator } from "../codex/meta.js";
import { CODEX_ADAPTER_ID, CODEX_DISPLAY, defaultCodexDir } from "../codex/constants.js";

const PARENT = "01a0c3ac-0000-7000-8000-000000000001";
const CHILD = "01a0c3bf-0000-7000-8000-000000000002";

function metaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload });
}

describe("parseCodexMeta", () => {
  it("parses a user thread (string source)", () => {
    const m = parseCodexMeta(
      metaLine({ id: PARENT, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode", thread_source: "user" }),
    );
    expect(m).toEqual({
      id: PARENT,
      cwd: "/Users/alice/projects/demo",
      originator: "Codex Desktop",
      cliVersion: "0.154.0",
      parentThreadId: null,
      kind: "user",
      agentNickname: null,
      subagentHistoryStartOrdinal: null,
    });
  });

  it("parses a thread_spawn sub-agent (parent id, nickname, history start)", () => {
    const m = parseCodexMeta(
      metaLine({
        id: CHILD, cwd: "/Users/alice/projects/demo", originator: "codex_work_desktop", cli_version: "0.154.0",
        parent_thread_id: PARENT, subagent_history_start_ordinal: 9, thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: "/root/map_audit", agent_nickname: "McClintock", agent_role: null } } },
      }),
    );
    expect(m?.kind).toBe("subagent");
    expect(m?.parentThreadId).toBe(PARENT);
    expect(m?.agentNickname).toBe("McClintock");
    expect(m?.subagentHistoryStartOrdinal).toBe(9);
  });

  it("marks guardian / review internal threads hidden", () => {
    const g = parseCodexMeta(metaLine({ id: CHILD, cwd: "/x", originator: "Codex Desktop", cli_version: "0.154.0", parent_thread_id: PARENT, source: { subagent: { other: "guardian" } }, thread_source: "guardian_review" }));
    expect(g?.kind).toBe("hidden");
    const r = parseCodexMeta(metaLine({ id: CHILD, cwd: "/x", originator: "codex_exec", cli_version: "0.154.0", source: { subagent: "review" }, thread_source: "subagent" }));
    expect(r?.kind).toBe("hidden");
  });

  it("accepts an old-version meta without thread_source", () => {
    const m = parseCodexMeta(metaLine({ id: PARENT, cwd: "/Users/alice/w", originator: "codex_exec", cli_version: "0.128.0", source: "exec" }));
    expect(m?.kind).toBe("user");
    expect(m?.cliVersion).toBe("0.128.0");
  });

  it("returns null for non-meta, missing id/cwd, or malformed JSON", () => {
    expect(parseCodexMeta(JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }))).toBeNull();
    expect(parseCodexMeta(metaLine({ id: PARENT, originator: "x" }))).toBeNull();
    expect(parseCodexMeta(metaLine({ cwd: "/x" }))).toBeNull();
    expect(parseCodexMeta("{not json")).toBeNull();
  });
});

describe("runnerFromOriginator", () => {
  it("maps desktop originators to codex-desktop, everything else to codex", () => {
    expect(runnerFromOriginator("Codex Desktop")).toBe("codex-desktop");
    expect(runnerFromOriginator("codex_work_desktop")).toBe("codex-desktop");
    expect(runnerFromOriginator("codex_exec")).toBe("codex");
    expect(runnerFromOriginator("codex_cli_rs")).toBe("codex");
    expect(runnerFromOriginator(null)).toBe("codex");
  });
});

describe("codexSessionIdFromPath", () => {
  it("strips the rollout-<ts>- prefix and .jsonl", () => {
    expect(codexSessionIdFromPath(`/r/2026/09/21/rollout-2026-09-21T20-14-22-${PARENT}.jsonl`)).toBe(PARENT);
  });
  it("keeps the _<window> suffix of a continuation file", () => {
    expect(codexSessionIdFromPath(`/r/2026/09/17/rollout-2026-09-17T03-54-12-${PARENT}_${CHILD}.jsonl`)).toBe(`${PARENT}_${CHILD}`);
  });
  it("rejects other files", () => {
    expect(codexSessionIdFromPath("/r/2026/09/21/notes.txt")).toBeNull();
    expect(codexSessionIdFromPath("/r/2026/09/21/other.jsonl")).toBeNull();
  });
});

describe("constants", () => {
  it("exposes id, display and the default sessions dir", () => {
    expect(CODEX_ADAPTER_ID).toBe("codex");
    expect(CODEX_DISPLAY).toBe("Codex");
    expect(defaultCodexDir().endsWith("/.codex/sessions")).toBe(true);
  });
});
