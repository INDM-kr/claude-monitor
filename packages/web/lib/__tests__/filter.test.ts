import { describe, it, expect } from "vitest";
import { globToRegExp, sessionMatches, filterWithVisibleChildren } from "../filter";
import type { SessionSummary } from "@claude-monitor/core";

function mk(over: Partial<SessionSummary["ref"]> & { mtime: number }): SessionSummary {
  return {
    ref: { id: "i", adapterId: "claude-code", workspace: "/Users/x/proj/a", workspaceShort: "proj/a", projectKey: "k", projectLabel: "proj", owner: "x", source: "s", ...over },
    status: "live", lastTool: null, pendingSubagents: [], todo: null, lastText: null,
    firstPrompt: null, userTurns: [], turnStartSec: null, turnTokens: null, endedTurn: false,
    runner: "unknown", model: null, mode: null, version: null, context: null, pid: null, updatedAt: 0,
  } as SessionSummary;
}

describe("filter", () => {
  const now = 1_000_000;
  const base = { statuses: [] as string[] };
  it("maxAge 컷오프", () => {
    expect(sessionMatches(mk({ mtime: now - 100 }), { ...base, maxAgeHours: 1, all: false, filterGlob: null, now })).toBe(true);
    expect(sessionMatches(mk({ mtime: now - 7200 }), { ...base, maxAgeHours: 1, all: false, filterGlob: null, now })).toBe(false);
  });
  it("all=true는 age 무시", () => {
    expect(sessionMatches(mk({ mtime: 0 }), { ...base, maxAgeHours: 1, all: true, filterGlob: null, now })).toBe(true);
  });
  it("glob은 workspace/short/label 매칭", () => {
    expect(sessionMatches(mk({ mtime: now, projectLabel: "claude-monitor" }), { ...base, maxAgeHours: null, all: true, filterGlob: "*monitor*", now })).toBe(true);
    expect(sessionMatches(mk({ mtime: now, workspace: "/a/b" , workspaceShort:"b", projectLabel:"b"}), { ...base, maxAgeHours: null, all: true, filterGlob: "*zzz*", now })).toBe(false);
  });
  it("status 다중 필터: 선택된 상태 중 하나라도 일치하면 통과, 빈 배열=전체", () => {
    const live = mk({ mtime: now }); // status "live"
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, statuses: ["live"], now })).toBe(true);
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, statuses: ["stop"], now })).toBe(false);
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, statuses: ["idle", "live"], now })).toBe(true);
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, statuses: [], now })).toBe(true);
  });
  it("globToRegExp 이스케이프", () => {
    expect(globToRegExp("a.b*").test("a.bXY")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
  });
});

describe("filterWithVisibleChildren", () => {
  const now = 1_000_000;
  const opts = { statuses: [] as string[], maxAgeHours: 1, all: false, filterGlob: null, now };

  it("부모 루트가 보이면 오래된 자식도 유지(나이 면제)", () => {
    const root = mk({ id: "p", mtime: now - 100 }); // recent → visible
    const oldChild = mk({ id: "c", parentId: "p", mtime: now - 99999 }); // old, would be trimmed alone
    const out = filterWithVisibleChildren([root, oldChild], opts);
    expect(out.map((s) => s.ref.id).sort()).toEqual(["c", "p"]);
  });

  it("부모 루트가 잘리고 자식도 오래되면 둘 다 제외", () => {
    const oldRoot = mk({ id: "p", mtime: now - 99999 });
    const oldChild = mk({ id: "c", parentId: "p", mtime: now - 99999 });
    expect(filterWithVisibleChildren([oldRoot, oldChild], opts)).toEqual([]);
  });

  it("부모가 잘려도 자식이 독립적으로 매치하면 orphan으로 유지", () => {
    const oldRoot = mk({ id: "p", mtime: now - 99999 });
    const freshChild = mk({ id: "c", parentId: "p", mtime: now - 100 });
    const out = filterWithVisibleChildren([oldRoot, freshChild], opts);
    expect(out.map((s) => s.ref.id)).toEqual(["c"]);
  });
});
