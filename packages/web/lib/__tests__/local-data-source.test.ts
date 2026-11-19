import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDataSource } from "../data-source/local";
import { fakeAdapter, refFor, snapshotEnv, summaryFor } from "./helpers";

const pexecFile = promisify(execFile);
const restoreEnv = snapshotEnv(["CM_ENABLE_CODEX", "CM_CODEX_DIR"]);

describe("LocalDataSource — adapter registration (CM_ENABLE_CODEX)", () => {
  afterEach(restoreEnv);

  it("registers the Codex adapter after Claude Code by default; CM_ENABLE_CODEX=0 leaves it out", () => {
    delete process.env.CM_ENABLE_CODEX;
    const ids = new LocalDataSource().adapters().map((a) => a.id);
    expect(ids[0]).toBe("claude-code");
    expect(ids).toContain("codex");
    process.env.CM_ENABLE_CODEX = "0";
    const off = new LocalDataSource().adapters().map((a) => a.id);
    expect(off).toContain("claude-code");
    expect(off).not.toContain("codex");
  });
});

describe("LocalDataSource.enrich — git remote grouping gate by adapter", () => {
  let base: string;
  let repo: string;
  let plain: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(join(tmpdir(), "cm-enrich-"));
    repo = join(base, "repo");
    plain = join(base, "plain");
    await fs.mkdir(repo);
    await fs.mkdir(plain);
    await pexecFile("git", ["init", "-q"], { cwd: repo });
    await pexecFile("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], { cwd: repo });
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("codex and claude-code sessions in a git workspace group by the origin remote; cowork in the same dir does not", async () => {
    const codex = summaryFor(refFor("codex", "c1", repo), { runner: "codex" });
    const claude = summaryFor(refFor("claude-code", "a1", repo));
    const cowork = summaryFor(refFor("claude-cowork", "w1", repo));
    const ds = new LocalDataSource([fakeAdapter("codex", [codex]), fakeAdapter("claude-code", [claude]), fakeAdapter("claude-cowork", [cowork])]);
    try {
      const byId = new Map((await ds.snapshot()).map((s) => [s.ref.id, s]));
      expect(byId.get("c1")?.ref.projectKey).toBe("git:github.com/acme/demo");
      expect(byId.get("c1")?.ref.projectLabel).toBe("demo");
      expect(byId.get("a1")?.ref.projectKey).toBe("git:github.com/acme/demo");
      expect(byId.get("w1")?.ref.projectKey).toBe(repo);
      // Codex has no live `claude` process: pid/runner come from the reader untouched.
      expect(byId.get("c1")?.pid).toBeNull();
      expect(byId.get("c1")?.runner).toBe("codex");
    } finally {
      await ds.dispose();
    }
  });

  it("a codex session in a non-git workspace keeps its cwd-derived projectKey (getById path)", async () => {
    const codex = summaryFor(refFor("codex", "c2", plain));
    const ds = new LocalDataSource([fakeAdapter("codex", [codex])]);
    try {
      const s = await ds.getById("codex", "c2");
      expect(s?.ref.projectKey).toBe(plain);
      expect(await ds.getById("claude-code", "c2")).toBeNull();
    } finally {
      await ds.dispose();
    }
  });
});

describe("LocalDataSource — ledger project mapping (/projects)", () => {
  const map = {
    workspaces: {
      "/work/conductor/workspaces/baro/monaco": { key: "git:github.com/acme/baro", label: "Baro" },
      "/work/notes": { key: "project:p-notes", label: "Notes" },
    },
    identities: { "git:github.com/acme/demo": { key: "project:p-demo", label: "Demo App" } },
  };
  function source(initial: typeof map | null) {
    let current = initial, changed = false;
    return {
      current: () => current,
      refresh: async () => { const was = changed; changed = false; return was; },
      set(next: typeof map) { current = next; changed = true; },
    };
  }

  it("groups mapped folders under their ledger project and leaves unmapped and cowork sessions automatic", async () => {
    const monaco = summaryFor(refFor("claude-code", "a1", "/work/conductor/workspaces/baro/monaco"));
    const notes = summaryFor(refFor("codex", "c1", "/work/notes/"));
    const other = summaryFor(refFor("claude-code", "a2", "/work/other"));
    const cowork = summaryFor(refFor("claude-cowork", "w1", "/work/notes"));
    const ds = new LocalDataSource([fakeAdapter("claude-code", [monaco, other]), fakeAdapter("codex", [notes]), fakeAdapter("claude-cowork", [cowork])], source(map));
    try {
      const byId = new Map((await ds.snapshot()).map((s) => [s.ref.id, s.ref]));
      expect([byId.get("a1")?.projectKey, byId.get("a1")?.projectLabel]).toEqual(["git:github.com/acme/baro", "Baro"]);
      expect([byId.get("c1")?.projectKey, byId.get("c1")?.projectLabel]).toEqual(["project:p-notes", "Notes"]);
      expect(byId.get("a2")?.projectKey).toBe("/work/other");
      expect(byId.get("w1")?.projectKey).toBe("/work/notes");
    } finally {
      await ds.dispose();
    }
  });

  it("maps a git repository the ledger knows by identity, and pushes only regrouped sessions when the mapping changes", async () => {
    const base = await fs.mkdtemp(join(tmpdir(), "cm-map-"));
    const repo = join(base, "repo");
    await fs.mkdir(repo);
    await pexecFile("git", ["init", "-q"], { cwd: repo });
    await pexecFile("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], { cwd: repo });
    const inRepo = summaryFor(refFor("claude-code", "a1", repo));
    const monaco = summaryFor(refFor("claude-code", "a2", "/work/conductor/workspaces/baro/monaco"));
    const projects = source(map);
    const ds = new LocalDataSource([fakeAdapter("claude-code", [inRepo, monaco])], projects);
    const { getHub } = await import("../sse/hub");
    const pushed: string[] = [];
    const off = getHub().subscribe((e) => { if (e.kind === "summary") pushed.push(`${e.data.ref.id}:${e.data.ref.projectLabel}`); });
    try {
      expect((await ds.snapshot()).find((s) => s.ref.id === "a1")?.ref).toMatchObject({ projectKey: "project:p-demo", projectLabel: "Demo App" });
      pushed.length = 0;
      projects.set({ ...map, workspaces: { ...map.workspaces, "/work/conductor/workspaces/baro/monaco": { key: "git:github.com/acme/baro", label: "Baro Renamed" } } });
      await ds.applyProjectChanges();
      expect(pushed).toEqual(["a2:Baro Renamed"]);
    } finally {
      off();
      await ds.dispose();
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
