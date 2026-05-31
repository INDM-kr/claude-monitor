import { describe, expect, it } from "vitest";
import { isIgnoredWatchPath } from "../watcher.js";

describe("isIgnoredWatchPath", () => {
  // Regression: the watch root lives under `~/.claude/projects`. A dot in that
  // ancestor must NOT cause the whole tree to be ignored, or chokidar emits no
  // change events and the dashboard never updates live.
  const root = "/Users/alice/.claude/projects";

  it("does not ignore the watch root itself", () => {
    expect(isIgnoredWatchPath(root, root)).toBe(false);
  });

  it("does not ignore a project dir under a dotted ancestor", () => {
    expect(isIgnoredWatchPath(root, `${root}/-Users-alice-proj`)).toBe(false);
  });

  it("does not ignore a session file under a dotted ancestor", () => {
    expect(isIgnoredWatchPath(root, `${root}/-Users-alice-proj/abc123.jsonl`)).toBe(false);
  });

  it("ignores hidden files inside the watched tree", () => {
    expect(isIgnoredWatchPath(root, `${root}/.DS_Store`)).toBe(true);
    expect(isIgnoredWatchPath(root, `${root}/-Users-alice-proj/.hidden.jsonl`)).toBe(true);
  });

  it("ignores hidden sub-directories inside the watched tree", () => {
    expect(isIgnoredWatchPath(root, `${root}/.git/HEAD`)).toBe(true);
  });

  it("does not ignore paths outside projectsDir", () => {
    expect(isIgnoredWatchPath(root, "/tmp/elsewhere/x.jsonl")).toBe(false);
  });
});
