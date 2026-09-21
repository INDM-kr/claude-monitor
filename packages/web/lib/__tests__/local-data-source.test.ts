import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AISessionAdapter, SessionRef, SessionSummary } from "@claude-monitor/core";
import { LocalDataSource } from "../data-source/local";

const pexecFile = promisify(execFile);

const KEYS = ["CM_ENABLE_CODEX", "CM_CODEX_DIR"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function refFor(adapterId: string, id: string, workspace: string): SessionRef {
  return { id, adapterId, workspace, workspaceShort: workspace, projectKey: workspace, projectLabel: "ws", owner: "alice", source: join(workspace, "x.jsonl"), mtime: 0 };
}

function summaryFor(ref: SessionRef): SessionSummary {
  return {
    ref, status: "stop", lastTool: null, pendingSubagents: [], todo: null, lastText: null, firstPrompt: null,
    userTurns: [], turnStartSec: null, turnTokens: null, endedTurn: false,
    runner: ref.adapterId === "codex" ? "codex" : "unknown", model: null, mode: null, version: null,
    context: null, pid: null, updatedAt: 0,
  };
}

/** Adapter that serves fixed summaries — exercises LocalDataSource.enrich() through snapshot(). */
function fakeAdapter(id: string, summaries: SessionSummary[]): AISessionAdapter {
  return {
    id,
    displayName: id,
    async *discover() {
      for (const s of summaries) yield s.ref;
    },
    open(ref) {
      const s = summaries.find((x) => x.ref.id === ref.id)!;
      return { status: () => s.status, readIncremental: async () => s, close() {} };
    },
    async dispose() {},
    onChange() {
      return () => {};
    },
  };
}

describe("LocalDataSource — adapter registration (CM_ENABLE_CODEX)", () => {
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

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
    const codex = summaryFor(refFor("codex", "c1", repo));
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
