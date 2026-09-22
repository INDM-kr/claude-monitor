import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    try {
      await fs.writeFile(newFile, metaLine({ id: NEW, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" }));
      await vi.waitFor(() => expect(events.some((e) => e.kind === "added" && e.id === NEW)).toBe(true), { timeout: 3000 });
      await fs.appendFile(newFile, JSON.stringify({ timestamp: "2026-09-21T11:14:23.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } }) + "\n");
      await vi.waitFor(() => expect(events.some((e) => e.kind === "changed" && e.id === NEW)).toBe(true), { timeout: 3000 });
      await fs.rm(newFile);
      await vi.waitFor(() => expect(events.some((e) => e.kind === "removed" && e.id === NEW)).toBe(true), { timeout: 3000 });
      // A guardian thread that exists at start never surfaces (scan hides it, chokidar ignores initial files).
      expect(events.some((e) => e.id === GUARD && e.kind !== "removed")).toBe(false);
    } finally {
      await w.stop();
    }
  });

  it("a change to a guardian (hidden) thread emits nothing — the hidden verdict is cached as null", async () => {
    const w = new CodexWatcher({ codexDir: root });
    const ids: string[] = [];
    w.on("event", (e) => ids.push(e.kind === "removed" ? e.refId : e.ref.id));
    await w.start();
    await sleep(300);
    const guardFile = join(day, `rollout-2026-09-21T20-21-00-${GUARD}.jsonl`);
    await fs.appendFile(guardFile, JSON.stringify({ timestamp: "2026-09-21T11:14:23.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } }) + "\n");
    await sleep(400);
    await fs.appendFile(guardFile, JSON.stringify({ timestamp: "2026-09-21T11:14:24.000Z", ordinal: 2, type: "event_msg", payload: { type: "task_complete" } }) + "\n");
    await sleep(600);
    await w.stop();
    expect(ids).not.toContain(GUARD);
  });

  it("a rollout file whose first line is not a session_meta is skipped; a thread_spawn meta without parent_thread_id is a root", async () => {
    const BAD = "01a0c3c6-0000-7000-8000-000000000009";
    const ORPHAN = "01a0c3c7-0000-7000-8000-00000000000a";
    await fs.writeFile(join(day, `rollout-2026-09-21T20-14-22-${BAD}.jsonl`), JSON.stringify({ timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "event_msg", payload: { type: "task_started" } }) + "\n");
    await fs.writeFile(join(day, `rollout-2026-09-21T20-14-22-${ORPHAN}.jsonl`), metaLine({ id: ORPHAN, cwd: "/Users/alice/projects/demo", originator: "codex_work_desktop", cli_version: "0.154.0", source: { subagent: { thread_spawn: { depth: 1 } } } }));
    const w = new CodexWatcher({ codexDir: root });
    const refs: SessionRef[] = [];
    for await (const r of w.scan()) refs.push(r);
    expect(refs.map((r) => r.id)).not.toContain(BAD);
    expect(refs.find((r) => r.id === ORPHAN)?.parentId).toBeUndefined();
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

describe("CodexWatcher — missing root, stray entries, partial first line, thresholds", () => {
  let root: string;
  let day: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "cm-codex-watch2-"));
    day = join(root, "2026", "09", "21");
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(join(day, `rollout-2026-09-21T20-14-22-${PARENT}.jsonl`), userMeta);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a missing sessions dir (no ~/.codex) yields nothing; dispose without discover is a no-op; stray files at Y/M/D levels are skipped", async () => {
    const missing = join(root, "nope");
    const w = new CodexWatcher({ codexDir: missing });
    const scanned: SessionRef[] = [];
    for await (const r of w.scan()) scanned.push(r);
    expect(scanned).toEqual([]);

    const untouched = new CodexAdapter({ codexDir: missing });
    await untouched.dispose();

    const a = new CodexAdapter({ codexDir: missing });
    const refs: SessionRef[] = [];
    for await (const r of a.discover()) refs.push(r);
    expect(refs).toEqual([]);
    await a.dispose();

    // plain files sitting at the year/month/day levels are skipped by scan
    await fs.writeFile(join(root, "2025"), "x");
    await fs.writeFile(join(root, "2026", "08"), "x");
    await fs.writeFile(join(root, "2026", "09", "20"), "x");
    const w2 = new CodexWatcher({ codexDir: root });
    const scanned2: SessionRef[] = [];
    for await (const r of w2.scan()) scanned2.push(r);
    expect(scanned2.map((r) => r.id)).toEqual([PARENT]);
  });

  it("a file whose first line is incomplete emits nothing until the line completes; an unsubscribed listener gets nothing", async () => {
    const a = new CodexAdapter({ codexDir: root });
    const seen: Array<{ kind: string; id: string; at: number }> = [];
    const off = a.onChange(() => {
      throw new Error("unsubscribed listener must not be called");
    });
    a.onChange((e) => seen.push({ kind: e.kind, id: e.kind === "removed" ? e.refId : e.ref.id, at: Date.now() }));
    off();
    for await (const _ of a.discover()) void _;
    const NEW = "01a0c3c3-0000-7000-8000-000000000006";
    const newFile = join(day, `rollout-2026-09-21T20-40-00-${NEW}.jsonl`);
    const full = metaLine({ id: NEW, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" });
    await sleep(300);
    await fs.writeFile(newFile, full.slice(0, 40));
    await sleep(500);
    expect(seen.filter((e) => e.id === NEW)).toEqual([]);
    const completedAt = Date.now();
    await fs.appendFile(newFile, full.slice(40));
    await vi.waitFor(() => expect(seen.some((e) => e.id === NEW)).toBe(true), { timeout: 3000 });
    await a.dispose();
    const mine = seen.filter((e) => e.id === NEW);
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) expect(e.at).toBeGreaterThanOrEqual(completedAt);
    expect(mine.every((e) => e.kind === "changed" || e.kind === "added")).toBe(true);
  });

  it("CodexAdapter.open passes thresholds through: a 7s-old unfinished turn is idle with activeSec=5", async () => {
    const lines = [
      { timestamp: new Date(Date.now() - 10_000).toISOString(), ordinal: 0, type: "session_meta", payload: { id: PARENT, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } },
      { timestamp: new Date(Date.now() - 7_000).toISOString(), ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] } },
    ];
    const f = join(day, `rollout-2026-09-21T20-50-00-${PARENT}.jsonl`);
    await fs.writeFile(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ref: SessionRef = { id: PARENT, adapterId: CODEX_ADAPTER_ID, workspace: "/w", workspaceShort: "w", projectKey: "/w", projectLabel: "w", owner: "o", source: f, mtime: 0 };
    const tuned = await new CodexAdapter({ codexDir: root, thresholds: { activeSec: 5, recentSec: 600 } }).open(ref).readIncremental();
    expect(tuned.status).toBe("idle");
    const plain = await new CodexAdapter({ codexDir: root }).open(ref).readIncremental();
    expect(plain.status).toBe("live");
  });
});

describe("watcher helpers — readFirstLine limits, isIgnoredCodexPath outside/nested", () => {
  it("readFirstLine: null for an empty file, RangeError for a first line over maxBytes; isIgnoredCodexPath: outside paths never ignored, nested hidden dirs ignored", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "cm-codex-fl2-"));
    const f = join(dir, "a.jsonl");
    await fs.writeFile(f, "");
    expect(await readFirstLine(f)).toBeNull();
    await fs.writeFile(f, "x".repeat(20) + "\nrest\n");
    await expect(readFirstLine(f, 10)).rejects.toThrow(RangeError);
    expect(await readFirstLine(f, 21)).toBe("x".repeat(20));
    await fs.rm(dir, { recursive: true, force: true });
    expect(isIgnoredCodexPath("/Users/a/.codex/sessions", "/Users/a/.codex/other/.hidden")).toBe(false);
    expect(isIgnoredCodexPath("/Users/a/.codex/sessions", "/Users/a/.codex/sessions/2026/.tmp/rollout-x.jsonl")).toBe(true);
  });
});

describe("CodexWatcher — review fixes: depth guard, cached identity, no initial re-emission", () => {
  let root: string;
  let day: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "cm-codex-watch3-"));
    day = join(root, "2026", "09", "21");
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(join(day, `rollout-2026-09-21T20-14-22-${PARENT}.jsonl`), userMeta);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("existing files are yielded by scan only — chokidar does not re-emit them as `added` at startup", async () => {
    const w = new CodexWatcher({ codexDir: root });
    const events: string[] = [];
    w.on("event", (e) => events.push(e.kind === "removed" ? `removed:${e.refId}` : `${e.kind}:${e.ref.id}`));
    await sleep(300); // let fsevents settle after beforeEach wrote the file
    await w.start();
    const scanned: SessionRef[] = [];
    for await (const r of w.scan()) scanned.push(r);
    await sleep(600);
    await w.stop();
    expect(scanned.map((r) => r.id)).toEqual([PARENT]);
    // A late fsevents notification for the just-written file may still surface as
    // `changed`; what must not happen is a second `added` for a scanned file.
    expect(events.filter((e) => e.startsWith("added:"))).toEqual([]);
  });

  it("a rollout-named file at the wrong depth is ignored by the watcher", async () => {
    const w = new CodexWatcher({ codexDir: root });
    const events: string[] = [];
    w.on("event", (e) => events.push(e.kind === "removed" ? `removed:${e.refId}` : `${e.kind}:${e.ref.id}`));
    await w.start();
    await sleep(300);
    const STRAY = "01a0c3c4-0000-7000-8000-000000000007";
    await fs.writeFile(join(root, "2026", "09", `rollout-2026-09-21T20-14-22-${STRAY}.jsonl`), metaLine({ id: STRAY, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" }));
    await sleep(600);
    await w.stop();
    expect(events.filter((e) => e.includes(STRAY))).toEqual([]);
  });

  it("identity is parsed from the first line once: a change event after the first line was cached still emits the same ref", async () => {
    const w = new CodexWatcher({ codexDir: root });
    const events: Array<{ kind: string; id: string; workspace: string }> = [];
    w.on("event", (e) => {
      if (e.kind !== "removed") events.push({ kind: e.kind, id: e.ref.id, workspace: e.ref.workspace });
    });
    await w.start();
    await sleep(300);
    const NEW = "01a0c3c5-0000-7000-8000-000000000008";
    const f = join(day, `rollout-2026-09-21T20-14-22-${NEW}.jsonl`);
    await fs.writeFile(f, metaLine({ id: NEW, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" }));
    await sleep(500);
    await fs.appendFile(f, JSON.stringify({ timestamp: "2026-09-21T11:14:23.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } }) + "\n");
    await vi.waitFor(() => expect(events.filter((e) => e.id === NEW).length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await w.stop();
    const mine = events.filter((e) => e.id === NEW);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(new Set(mine.map((e) => e.workspace))).toEqual(new Set(["/Users/alice/projects/demo"]));
  });
});
