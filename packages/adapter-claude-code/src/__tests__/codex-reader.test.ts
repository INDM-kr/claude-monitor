import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRef } from "@claude-monitor/core";
import { CodexReader } from "../codex/reader.js";
import { CODEX_ADAPTER_ID } from "../codex/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, "fixtures", "codex");
const PARENT = "01a0c3ac-0000-7000-8000-000000000001";
const CHILD = "01a0c3bf-0000-7000-8000-000000000002";

function fixture(name: string): Promise<string> {
  return fs.readFile(join(FIXDIR, name), "utf8");
}

function refFor(source: string, id = PARENT, parentId?: string): SessionRef {
  const ref: SessionRef = {
    id,
    adapterId: CODEX_ADAPTER_ID,
    workspace: "/Users/alice/projects/demo",
    workspaceShort: "projects/demo",
    projectKey: "/Users/alice/projects/demo",
    projectLabel: "demo",
    owner: "alice",
    source,
    mtime: Math.floor(Date.now() / 1000),
  };
  if (parentId) ref.parentId = parentId;
  return ref;
}

const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** A live, unfinished turn with timestamps relative to now (for status tests). */
function inflightTranscript(ageSec: number): string {
  const at = (offset: number): string => new Date(Date.now() - ageSec * 1000 + offset * 1000).toISOString();
  const lines = [
    { timestamp: at(0), ordinal: 0, type: "session_meta", payload: { id: PARENT, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode" } },
    { timestamp: at(0), ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "t1", model_context_window: 258400 } },
    { timestamp: at(1), ordinal: 2, type: "turn_context", payload: { turn_id: "t1", cwd: "/Users/alice/projects/demo", approval_policy: "on-request", model: "gpt-6-astra" } },
    { timestamp: at(2), ordinal: 3, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "테스트 돌려줘" }] } },
    { timestamp: at(3), ordinal: 4, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "pnpm test" }), call_id: "c1" } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("CodexReader", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-codex-reader-"));
    file = join(dir, `rollout-2026-09-21T20-14-22-${PARENT}.jsonl`);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("simple: one finished turn — request, reply, tool, tokens, context, identity", async () => {
    await fs.writeFile(file, await fixture("codex-simple.jsonl"));
    const s = await new CodexReader(refFor(file)).readIncremental();
    expect(s.userTurns).toEqual(["프로젝트 코드를 분석해줘"]);
    expect(s.firstPrompt).toBe("프로젝트 코드를 분석해줘");
    expect(s.userResponses).toEqual(["프로젝트는 pnpm 모노레포입니다."]);
    expect(s.lastText).toBe("프로젝트는 pnpm 모노레포입니다.");
    expect(s.lastTool).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("ls -la");
    expect(s.endedTurn).toBe(true);
    expect(s.totalTokens).toBe(5500);
    expect(s.turnTokens).toBe(5500);
    expect(s.context).toEqual({ tokens: 13281, limit: 258400, pct: 13281 / 258400 });
    expect(s.model).toBe("gpt-6-astra");
    expect(s.mode).toBe("on-request");
    expect(s.version).toBe("0.154.0");
    expect(s.runner).toBe("codex-desktop");
    expect(s.pid).toBeNull();
    expect(s.todo).toBeNull();
    expect(s.pendingSubagents).toEqual([]);
    expect(s.agentStatus).toBeNull();
    expect(s.metrics).toBeNull();
    expect(s.turnStartSec).toBe(sec("2026-09-21T11:14:25.200Z"));
    expect(s.startSec).toBe(sec("2026-09-21T11:14:27.100Z"));
    // last activity = last timestamped record (the trailing settings ping), not the file mtime
    expect(s.ref.mtime).toBe(sec("2026-09-21T11:14:31.000Z"));
    expect(s.ref.adapterId).toBe(CODEX_ADAPTER_ID);
    expect(s.status).toBe("stop"); // 2026-09-21 timestamps are far older than recentSec
  });

  it("sub-agent child: skips the parent's copied prefix, reports lifecycle + metrics", async () => {
    const childFile = join(dir, `rollout-2026-09-21T20-20-00-${CHILD}.jsonl`);
    await fs.writeFile(childFile, await fixture("codex-subagent.jsonl"));
    const s = await new CodexReader(refFor(childFile, CHILD, PARENT)).readIncremental();
    expect(s.ref.parentId).toBe(PARENT);
    expect(s.userTurns).toEqual(["지도 감사를 수행해"]);
    expect(s.totalTokens).toBe(3100);
    expect(s.lastTool).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("grep -rn foo src");
    expect(s.mode).toBe("never");
    expect(s.runner).toBe("codex-desktop");
    expect(s.agentStatus).toBe("done");
    expect(s.metrics).toEqual({ tokens: 3100, tools: 1, durationSec: 8 });
    expect(s.startSec).toBe(sec("2026-09-21T11:20:06.000Z"));
    expect(s.status).toBe("stop"); // children use the plain age bucket
  });

  it("aborted turn (old codex exec): ended + cancelled lifecycle when read as a child", async () => {
    await fs.writeFile(file, await fixture("codex-aborted.jsonl"));
    const root = await new CodexReader(refFor(file, "019e202f-0000-7000-8000-000000000003")).readIncremental();
    expect(root.endedTurn).toBe(true);
    expect(root.runner).toBe("codex");
    expect(root.model).toBe("gpt-5.4");
    expect(root.version).toBe("0.128.0");
    expect(root.userTurns).toEqual(["IMPORTANT: Do NOT read SKILL.md files. Summarize the repo."]);
    expect(root.totalTokens).toBe(4050);
    const child = await new CodexReader(refFor(file, "019e202f-0000-7000-8000-000000000003", PARENT)).readIncremental();
    expect(child.agentStatus).toBe("cancelled");
  });

  it("in-flight turn: live status, endedTurn false, turn timer running", async () => {
    await fs.writeFile(file, inflightTranscript(10));
    const s = await new CodexReader(refFor(file)).readIncremental();
    expect(s.endedTurn).toBe(false);
    expect(s.status).toBe("live");
    expect(s.lastTool).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("pnpm test");
    expect(s.turnStartSec).not.toBeNull();
    expect(s.turnTokens).toBe(0);
    expect(s.context).toBeNull(); // no token_count yet
  });

  it("finished turn that is recent → waiting", async () => {
    const at = (offset: number): string => new Date(Date.now() - 20_000 + offset * 1000).toISOString();
    const lines = [
      { timestamp: at(0), ordinal: 0, type: "session_meta", payload: { id: PARENT, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } },
      { timestamp: at(1), ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
      { timestamp: at(2), ordinal: 2, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
      { timestamp: at(3), ordinal: 3, type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
    ];
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const s = await new CodexReader(refFor(file)).readIncremental();
    expect(s.status).toBe("waiting");
    expect(s.runner).toBe("codex");
  });

  it("incremental: a trailing partial line is retried once completed", async () => {
    const full = await fixture("codex-simple.jsonl");
    const lines = full.split("\n").filter(Boolean);
    const head = lines.slice(0, 10).join("\n") + "\n";
    const partial = lines[10]!.slice(0, 40);
    await fs.writeFile(file, head + partial);
    const r = new CodexReader(refFor(file));
    const s1 = await r.readIncremental();
    expect(s1.lastText).toBeNull();
    expect(s1.endedTurn).toBe(false);
    await fs.writeFile(file, head + lines.slice(10).join("\n") + "\n");
    const s2 = await r.readIncremental();
    expect(s2.lastText).toBe("프로젝트는 pnpm 모노레포입니다.");
    expect(s2.endedTurn).toBe(true);
    expect(s2.totalTokens).toBe(5500);
  });

  it("concurrent readIncremental calls fold each record once", async () => {
    await fs.writeFile(file, await fixture("codex-simple.jsonl"));
    const r = new CodexReader(refFor(file));
    const out = await Promise.all([r.readIncremental(), r.readIncremental(), r.readIncremental()]);
    for (const s of out) expect(s.totalTokens).toBe(5500);
    expect((await r.readIncremental()).userTurns).toEqual(["프로젝트 코드를 분석해줘"]);
  });

  it("truncation restarts from byte 0", async () => {
    await fs.writeFile(file, await fixture("codex-simple.jsonl"));
    const r = new CodexReader(refFor(file));
    expect((await r.readIncremental()).totalTokens).toBe(5500);
    await fs.writeFile(file, inflightTranscript(5));
    const s = await r.readIncremental();
    expect(s.totalTokens).toBe(0);
    expect(s.userTurns).toEqual(["테스트 돌려줘"]);
  });
});

describe("CodexReader — timestamp fallback, status(), failed pass, child lifecycle", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-codex-reader2-"));
    file = join(dir, `rollout-2026-09-21T20-14-22-${PARENT}.jsonl`);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records without timestamps (and an empty file) fall back to the file mtime; turn/start seconds stay null", async () => {
    const noTs = [
      { ordinal: 0, type: "session_meta", payload: { id: PARENT, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } },
      { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "no clock" }] } },
      { ordinal: 2, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 } }, rate_limits: null } },
    ];
    await fs.writeFile(file, noTs.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const mtime = Math.floor((await fs.stat(file)).mtimeMs / 1000);
    const s = await new CodexReader(refFor(file)).readIncremental();
    expect(s.ref.mtime).toBe(mtime);
    expect(s.userTurns).toEqual(["no clock"]);
    expect(s.turnStartSec).toBeNull();
    expect(s.startSec).toBeNull();
    expect(s.totalTokens).toBe(1100);
    expect(s.turnTokens).toBe(1100);
    expect(s.status).toBe("live"); // file was just written

    const empty = join(dir, `rollout-2026-09-21T20-15-00-${CHILD}.jsonl`);
    await fs.writeFile(empty, "");
    const e = await new CodexReader(refFor(empty, CHILD)).readIncremental();
    expect(e.ref.mtime).toBe(Math.floor((await fs.stat(empty)).mtimeMs / 1000));
    expect(e.userTurns).toEqual([]);
    expect(e.firstPrompt).toBeNull();
    expect(e.turnTokens).toBeNull();
    expect(e.totalTokens).toBe(0);
    expect(e.context).toBeNull();
    expect(e.lastTool).toBeNull();
    expect(e.todo).toBeNull();
    expect(e.runner).toBe("codex");
  });

  it("status(): ref mtime before the first read, last-record activity after, ref mtime again after close()", async () => {
    await fs.writeFile(file, inflightTranscript(10));
    const now = Math.floor(Date.now() / 1000);
    const ref = { ...refFor(file), mtime: now - 5000 };
    const r = new CodexReader(ref);
    expect(r.status(now)).toBe("stop");
    await r.readIncremental();
    expect(r.status(now)).toBe("live");
    r.close();
    expect(r.status(now)).toBe("stop");
  });

  it("a pass that fails (file missing) rejects without blocking the next pass", async () => {
    const r = new CodexReader(refFor(file));
    await expect(r.readIncremental()).rejects.toThrow();
    await fs.writeFile(file, inflightTranscript(5));
    const s = await r.readIncremental();
    expect(s.userTurns).toEqual(["테스트 돌려줘"]);
  });

  it("child lifecycle: running while an unfinished turn is recent, done once it goes stale", async () => {
    const childFile = join(dir, `rollout-2026-09-21T20-20-00-${CHILD}.jsonl`);
    await fs.writeFile(childFile, inflightTranscript(10));
    const live = await new CodexReader(refFor(childFile, CHILD, PARENT)).readIncremental();
    expect(live.agentStatus).toBe("running");
    expect(live.status).toBe("live");
    expect(live.metrics).toEqual({ tokens: 0, tools: 1, durationSec: 3 });
    expect(live.endedTurn).toBe(false);

    await fs.writeFile(childFile, inflightTranscript(700));
    const stale = await new CodexReader(refFor(childFile, CHILD, PARENT)).readIncremental();
    expect(stale.agentStatus).toBe("done");
    expect(stale.status).toBe("stop");
  });
});
