import { describe, it, expect } from "vitest";
import { globToRegExp, sessionMatches } from "../filter";
import type { SessionSummary } from "@claude-monitor/core";

function mk(over: Partial<SessionSummary["ref"]> & { mtime: number }): SessionSummary {
  return {
    ref: { id: "i", adapterId: "claude-code", workspace: "/Users/x/proj/a", workspaceShort: "proj/a", projectKey: "k", projectLabel: "proj", owner: "x", source: "s", ...over },
    status: "live", lastTool: null, pendingSubagents: [], todo: null, lastText: null,
    runner: "unknown", model: null, mode: null, version: null, context: null, pid: null, updatedAt: 0,
  } as SessionSummary;
}

describe("filter", () => {
  const now = 1_000_000;
  const base = { status: null as string | null };
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
  it("status 필터: 지정 시 해당 상태만 통과", () => {
    const live = mk({ mtime: now }); // status "live"
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, status: "live", now })).toBe(true);
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, status: "stop", now })).toBe(false);
    expect(sessionMatches(live, { maxAgeHours: null, all: true, filterGlob: null, status: null, now })).toBe(true);
  });
  it("globToRegExp 이스케이프", () => {
    expect(globToRegExp("a.b*").test("a.bXY")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
  });
});
