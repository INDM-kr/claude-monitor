import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRef } from "@claude-monitor/core";
import { CodexWatcher, isIgnoredCodexPath, readFirstLine } from "../codex/watcher.js";
import { CodexAdapter } from "../codex/adapter.js";
import { CODEX_ADAPTER_ID } from "../codex/constants.js";

const PARENT = "01a0c3ac-0000-7000-8000-000000000001";
const CHILD = "01a0c3bf-0000-7000-8000-000000000002";
const GUARD = "01a0c3c0-0000-7000-8000-000000000003";
const EMPTY = "01a0c3c1-0000-7000-8000-000000000004";

function metaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload }) + "\n";
}
const userMeta = metaLine({ id: PARENT, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode", thread_source: "user" });
const childMeta = metaLine({ id: CHILD, cwd: "/Users/alice/projects/demo", originator: "codex_work_desktop", cli_version: "0.154.0", parent_thread_id: PARENT, subagent_history_start_ordinal: 6, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: "/root/x", agent_nickname: "Bacon", agent_role: null } } }, thread_source: "subagent" });
const guardMeta = metaLine({ id: GUARD, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", parent_thread_id: PARENT, source: { subagent: { other: "guardian" } }, thread_source: "guardian_review" });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("CodexWatcher", () => {
  let root: string;
  let day: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "cm-codex-watch-"));
    day = join(root, "2026", "09", "21");
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(join(day, `rollout-2026-09-21T20-14-22-${PARENT}.jsonl`), userMeta + JSON.stringify({ timestamp: "2026-09-21T11:14:22.358Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } }) + "\n");
    await fs.writeFile(join(day, `rollout-2026-09-21T20-20-00-${CHILD}.jsonl`), childMeta);
    await fs.writeFile(join(day, `rollout-2026-09-21T20-21-00-${GUARD}.jsonl`), guardMeta);
    await fs.writeFile(join(day, `rollout-2026-09-21T20-22-00-${EMPTY}.jsonl`), "");
    await fs.writeFile(join(day, "notes.txt"), "x");
    await fs.writeFile(join(root, ".DS_Store"), "");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("scan yields user + sub-agent threads with identity from cwd; hides guardian, empty, non-rollout files", async () => {
    const w = new CodexWatcher({ codexDir: root });
    const refs: SessionRef[] = [];
    for await (const r of w.scan()) refs.push(r);
    refs.sort((a, b) => a.id.localeCompare(b.id));
    expect(refs.map((r) => r.id)).toEqual([PARENT, CHILD]);
    const parent = refs[0]!;
    expect(parent.adapterId).toBe(CODEX_ADAPTER_ID);
    expect(parent.workspace).toBe("/Users/alice/projects/demo");
    expect(parent.workspaceShort).toBe("projects/demo");
    expect(parent.projectKey).toBe("/Users/alice/projects/demo");
    expect(parent.projectLabel).toBe("demo");
    expect(parent.owner).toBe("alice");
    expect(parent.parentId).toBeUndefined();
    expect(parent.source).toBe(join(day, `rollout-2026-09-21T20-14-22-${PARENT}.jsonl`));
    expect(refs[1]!.parentId).toBe(PARENT);
  });

  it("emits added/changed/removed for rollout files (chokidar)", async () => {
    const w = new CodexWatcher({ codexDir: root });
    const events: Array<{ kind: string; id: string }> = [];
    w.on("event", (e) => events.push({ kind: e.kind, id: e.kind === "removed" ? e.refId : e.ref.id }));
    await w.start();
    const NEW = "01a0c3c2-0000-7000-8000-000000000005";
    const newFile = join(day, `rollout-2026-09-21T20-30-00-${NEW}.jsonl`);
    await sleep(300);
    await fs.writeFile(newFile, metaLine({ id: NEW, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" }));
    await sleep(500);
    await fs.appendFile(newFile, JSON.stringify({ timestamp: "2026-09-21T11:14:23.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } }) + "\n");
    await sleep(500);
    await fs.rm(newFile);
    await sleep(500);
    await w.stop();
    expect(events.some((e) => e.kind === "added" && e.id === NEW)).toBe(true);
    expect(events.some((e) => e.kind === "changed" && e.id === NEW)).toBe(true);
    expect(events.some((e) => e.kind === "removed" && e.id === NEW)).toBe(true);
    expect(events.some((e) => e.id === GUARD && e.kind !== "removed")).toBe(false);
  });

  it("CodexAdapter.discover yields the scan and open returns a reader", async () => {
    const a = new CodexAdapter({ codexDir: root });
    const refs: SessionRef[] = [];
    for await (const r of a.discover()) refs.push(r);
    expect(refs.map((r) => r.id).sort()).toEqual([PARENT, CHILD].sort());
    expect(a.id).toBe("codex");
    const reader = a.open(refs[0]!);
    expect(typeof reader.readIncremental).toBe("function");
    await a.dispose();
  });
});

describe("readFirstLine", () => {
  it("returns the first line without its newline, null when no newline yet", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-codex-fl-"));
    const f = join(dir, "a.jsonl");
    await fs.writeFile(f, "abc\ndef\n");
    expect(await readFirstLine(f)).toBe("abc");
    await fs.writeFile(f, "partial");
    expect(await readFirstLine(f)).toBeNull();
    await fs.writeFile(f, "x".repeat(70_000) + "\nrest");
    expect((await readFirstLine(f))?.length).toBe(70_000);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("isIgnoredCodexPath", () => {
  it("ignores hidden segments inside the tree only", () => {
    expect(isIgnoredCodexPath("/Users/a/.codex/sessions", "/Users/a/.codex/sessions")).toBe(false);
    expect(isIgnoredCodexPath("/Users/a/.codex/sessions", "/Users/a/.codex/sessions/2026/09/21/rollout-x.jsonl")).toBe(false);
    expect(isIgnoredCodexPath("/Users/a/.codex/sessions", "/Users/a/.codex/sessions/.DS_Store")).toBe(true);
  });
});
