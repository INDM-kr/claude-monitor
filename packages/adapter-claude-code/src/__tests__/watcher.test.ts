import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isIgnoredWatchPath, ProjectsWatcher } from "../watcher.js";

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

describe("ProjectsWatcher.scan — sub-agent child discovery", () => {
  let dir: string;
  let watcher: ProjectsWatcher;
  const ENC = "-Users-x-conductor-workspaces-proj-lisbon";
  const UUID = "613cd51c-826c-4e8c-9ab7-893f23025373";

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-watcher-"));
    const proj = join(dir, ENC);
    await fs.mkdir(join(proj, UUID, "subagents", "workflows", "wf_a"), { recursive: true });
    await fs.writeFile(join(proj, `${UUID}.jsonl`), '{"type":"assistant"}\n');
    await fs.writeFile(join(proj, UUID, "subagents", "agent-a1.jsonl"), '{"type":"user"}\n');
    await fs.writeFile(
      join(proj, UUID, "subagents", "workflows", "wf_a", "agent-a2.jsonl"),
      '{"type":"user"}\n',
    );
    watcher = new ProjectsWatcher({ projectsDir: dir });
  });

  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("yields the parent (no parentId) plus both child layouts (parentId set)", async () => {
    const refs = [];
    for await (const ref of watcher.scan()) refs.push(ref);

    const parent = refs.find((r) => r.id === UUID);
    expect(parent).toBeDefined();
    expect(parent?.parentId).toBeUndefined();

    const direct = refs.find((r) => r.id === `${UUID}/agent-a1`);
    expect(direct?.parentId).toBe(UUID);

    const nested = refs.find((r) => r.id === `${UUID}/agent-a2`);
    expect(nested?.parentId).toBe(UUID);
    expect(nested?.wfId).toBe("wf_a");
    expect(direct?.wfId).toBeUndefined();

    // exactly one root, two children
    expect(refs.filter((r) => !r.parentId)).toHaveLength(1);
    expect(refs.filter((r) => r.parentId === UUID)).toHaveLength(2);
  });
});
