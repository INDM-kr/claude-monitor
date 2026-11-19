import { afterEach, describe, expect, it, vi } from "vitest";
const collector = vi.hoisted(() => ({ state: "ready", request: vi.fn() }));
vi.mock("@claude-monitor/collector", () => ({ getProcessCollector: () => ({ status: () => ({ state: collector.state }), request: collector.request }) }));
import { CollectorProjectMap, mappedProject } from "../project-mapping";

afterEach(() => { collector.state = "ready"; collector.request.mockReset(); vi.restoreAllMocks(); });

describe("project mapping for the live monitor", () => {
  it("prefers the folder mapping, then the repository, and normalizes the folder path", () => {
    const map = { workspaces: { "/w/app": { key: "project:a", label: "A" } }, identities: { "git:h/o/r": { key: "git:h/o/r", label: "R" } } };
    expect(mappedProject(map, "/w/app/", "git:h/o/r")).toEqual({ key: "project:a", label: "A" });
    expect(mappedProject(map, "/w/other", "git:h/o/r")).toEqual({ key: "git:h/o/r", label: "R" });
    expect(mappedProject(map, "/w/other", null)).toBeNull();
    expect(mappedProject(null, "/w/app", null)).toBeNull();
  });

  it("stays quiet while the collector is not ready, and reports a ready collector's failure once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = new CollectorProjectMap();
    collector.state = "starting";
    expect(await source.refresh(true)).toBe(false);
    expect(collector.request).not.toHaveBeenCalled();
    collector.state = "ready";
    collector.request.mockRejectedValue(Object.assign(new Error("request_timeout"), { code: "request_timeout" }));
    expect(await source.refresh(true)).toBe(false);
    expect(await source.refresh(true)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain("request_timeout");
    collector.request.mockResolvedValue({ workspaces: {}, identities: {} });
    expect(await source.refresh(true)).toBe(true);
    expect(await source.refresh(true)).toBe(false);
    expect(source.current()).toEqual({ workspaces: {}, identities: {} });
  });
});
