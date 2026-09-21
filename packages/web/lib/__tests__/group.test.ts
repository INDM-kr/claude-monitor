import { describe, it, expect } from "vitest";
import type { SessionSummary } from "@claude-monitor/core";
import { aggregateProjects } from "../group";

/** Minimal SessionSummary for aggregate tests; only the fields aggregate reads. */
function mk(
  id: string,
  over: {
    projectKey?: string;
    parentId?: string;
    totalTokens?: number | null;
    startSec?: number | null;
  } = {},
): SessionSummary {
  return {
    ref: {
      id,
      adapterId: "claude-code",
      workspace: "/Users/x/proj/a",
      workspaceShort: "proj/a",
      projectKey: over.projectKey ?? "k",
      projectLabel: "proj",
      owner: "x",
      source: `s-${id}`,
      mtime: 0,
      ...(over.parentId != null ? { parentId: over.parentId } : {}),
    },
    status: "live",
    lastTool: null,
    pendingSubagents: [],
    todo: null,
    lastText: null,
    firstPrompt: null,
    userTurns: [],
    turnStartSec: null,
    turnTokens: null,
    endedTurn: false,
    runner: "unknown",
    model: null,
    mode: null,
    version: null,
    context: null,
    pid: null,
    totalTokens: over.totalTokens,
    startSec: over.startSec,
    updatedAt: 0,
  } as SessionSummary;
}

describe("aggregateProjects", () => {
  it("projectKey별 토큰 합산 · 최소 startSec · 루트 세션 수", () => {
    const m = aggregateProjects([
      mk("a", { projectKey: "k1", totalTokens: 100, startSec: 300 }),
      mk("b", { projectKey: "k1", totalTokens: 250, startSec: 200 }),
      mk("z", { projectKey: "k2", totalTokens: 9, startSec: 999 }),
    ]);
    expect(m.get("k1")).toEqual({ sessionCount: 2, totalTokens: 350, startSec: 200 });
    expect(m.get("k2")).toEqual({ sessionCount: 1, totalTokens: 9, startSec: 999 });
  });

  it("같은 projectKey 자식은 합산하되 세션 수엔 미포함 (detail과 동일)", () => {
    const m = aggregateProjects([
      mk("p", { projectKey: "k", totalTokens: 100, startSec: 500 }),
      mk("c1", { projectKey: "k", parentId: "p", totalTokens: 900, startSec: 600 }),
      mk("c2", { projectKey: "k", parentId: "p", totalTokens: 40, startSec: 700 }),
    ]);
    expect(m.get("k")).toEqual({
      sessionCount: 1, // 루트만 카운트
      totalTokens: 1040, // 100 + 900 + 40 (같은 projectKey 자식 포함)
      startSec: 500,
    });
  });

  it("다른 cwd의 서브에이전트는 자기 projectKey로 귀속 (부모 프로젝트에 합산 안 됨)", () => {
    // 부모는 프로젝트 A, 서브에이전트는 다른 워크트리(B)에서 실행 — detail 페이지와 동일하게
    // 서브에이전트 토큰은 B에 귀속되고 A 헤더 합계엔 들어가지 않는다.
    const m = aggregateProjects([
      mk("p", { projectKey: "A", totalTokens: 100, startSec: 500 }),
      mk("c", { projectKey: "B", parentId: "p", totalTokens: 900, startSec: 600 }),
    ]);
    expect(m.get("A")).toEqual({ sessionCount: 1, totalTokens: 100, startSec: 500 });
    // B는 루트가 없으므로 sessionCount 0 (그룹으로 렌더되지 않음) — 하지만 집계는 존재
    expect(m.get("B")).toEqual({ sessionCount: 0, totalTokens: 900, startSec: 600 });
  });

  it("startSec 전부 없음 → null (chat 전용 그룹: 빈 값 안전)", () => {
    const m = aggregateProjects([
      mk("a", { projectKey: "chat", totalTokens: null, startSec: null }),
      mk("b", { projectKey: "chat" }), // totalTokens/startSec undefined
    ]);
    expect(m.get("chat")).toEqual({ sessionCount: 2, totalTokens: 0, startSec: null });
  });

  it("빈 입력 → 빈 맵 (Math.min([]) Infinity 회피)", () => {
    expect(aggregateProjects([]).size).toBe(0);
  });

  it("일부만 startSec 보유 → 존재하는 값 중 최소", () => {
    const m = aggregateProjects([
      mk("a", { totalTokens: 10, startSec: null }),
      mk("b", { totalTokens: 20, startSec: 420 }),
    ]);
    expect(m.get("k")?.startSec).toBe(420);
  });
});
