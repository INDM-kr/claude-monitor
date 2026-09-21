# Codex 세션 어댑터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `~/.codex/sessions`의 Codex rollout JSONL을 읽어 Codex(CLI/Desktop) 세션을 Claude Code 세션과 같은 대시보드·프로젝트 그룹에 표시한다.

**Architecture:** `packages/adapter-claude-code/src/codex/`에 cowork와 같은 구조(constants·meta·watcher·parser·reader·usage-series·adapter)로 어댑터를 추가한다. 파일 첫 줄 `session_meta`로 ref를 만들고, 기존 `tailLines`로 증분 tail하며 Codex 전용 `foldCodex`로 `SessionSummary`를 만든다. web은 config 플래그로 어댑터를 등록하고, git remote 그룹핑 게이트·RunnerKind·토큰 시계열 분기를 확장한다.

**Tech Stack:** TypeScript(ESM, strict, noUncheckedIndexedAccess), Node 18+, chokidar 3, vitest 1, Next.js 14, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-21-codex-adapter-design.md`

## Global Constraints

- 하드코딩 금지: 기본 경로·어댑터 id·표시명은 `codex/constants.ts`에만 둔다. env 이름은 `CM_ENABLE_CODEX`, `CM_CODEX_DIR`.
- 어댑터 id `"codex"`, 표시명 `"Codex"`. RunnerKind 추가값은 `"codex"`, `"codex-desktop"`.
- 토큰 metric = `max(0, input_tokens − cached_input_tokens) + cache_write_input_tokens + output_tokens` (누적값 차분, total_tokens 감소 시 리셋).
- 컨텍스트 = `last_token_usage.total_tokens − reasoning_output_tokens`, 한도 = `model_context_window`.
- 변경 범위 격리: 기존 Claude/cowork/chat 동작 무변경. 기존 테스트 전부 통과 유지.
- 각 태스크 끝에 `pnpm --filter @claude-monitor/adapter-claude-code test` 또는 web test 통과 후 커밋. 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 라이브 서버(포트 11314 `next start`)가 떠 있으면 `next build`를 돌리지 않는다(ChunkLoadError). 작업 시작 시점엔 없음을 확인함.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `packages/adapter-claude-code/src/codex/constants.ts` | 어댑터 id·표시명·기본 디렉터리 |
| `packages/adapter-claude-code/src/codex/meta.ts` | `session_meta` 해석(순수), thread kind 판정, originator→runner, 파일명→id |
| `packages/adapter-claude-code/src/codex/parser.ts` | `CodexState` + `foldCodex` (레코드→상태), 사용자 wrapper 필터, 도구 상세, 토큰 차분 |
| `packages/adapter-claude-code/src/codex/reader.ts` | `CodexReader` (tail + fold → `SessionSummary`) |
| `packages/adapter-claude-code/src/codex/watcher.ts` | `CodexWatcher` (chokidar, scan, 첫 줄 meta로 ref) + `readFirstLine` |
| `packages/adapter-claude-code/src/codex/usage-series.ts` | 상세 페이지·프로젝트 히트맵용 시계열 |
| `packages/adapter-claude-code/src/codex/adapter.ts` | `CodexAdapter implements AISessionAdapter` |
| `packages/adapter-claude-code/src/index.ts` | export 추가 |
| `packages/adapter-claude-code/src/__tests__/codex-*.test.ts`, `fixtures/codex/*.jsonl` | 테스트 |
| `packages/core/src/types/session.ts` | `RunnerKind` 확장 |
| `packages/web/app/_components/RunnerBadge.tsx`, `packages/web/lib/i18n/ko.ts` | 배지 스타일·라벨 |
| `packages/web/lib/config.ts` | `enableCodex`, `codexDir` |
| `packages/web/lib/data-source/local.ts` | 어댑터 등록, enrich 게이트 |
| `packages/web/lib/token-series.ts` | adapterId별 시계열 분기 |
| `packages/web/app/session/[id]/page.tsx`, `packages/web/lib/project-activity.ts` | 분기 함수 사용 |
| `README.md` | 설정표·참고·아키텍처 |

---

### Task 1: constants + meta 해석

**Files:**
- Create: `packages/adapter-claude-code/src/codex/constants.ts`
- Create: `packages/adapter-claude-code/src/codex/meta.ts`
- Test: `packages/adapter-claude-code/src/__tests__/codex-meta.test.ts`

**Interfaces:**
- Produces: `CODEX_ADAPTER_ID`, `CODEX_DISPLAY`, `defaultCodexDir()`, `parseCodexMeta(line): CodexMeta | null`, `runnerFromOriginator(originator): RunnerKind`, `codexSessionIdFromPath(path): string | null`, `type CodexMeta`, `type CodexThreadKind`.
- Note: `runnerFromOriginator`는 Task 6에서 추가되는 RunnerKind 값을 쓴다. Task 6 전엔 타입 오류가 나므로 **Task 6을 먼저 수행해도 된다**(순서: 6 → 1 권장). 이 계획은 6을 1 앞에 실행한다고 가정하고 아래 Task 6을 먼저 배치했다.

(→ Task 6 참조. 코드는 Task 6 다음의 "Task 1(실행)"에 있다.)

---

### Task 6 (먼저 실행): RunnerKind 확장 + 배지 + 라벨

**Files:**
- Modify: `packages/core/src/types/session.ts:3`
- Modify: `packages/web/app/_components/RunnerBadge.tsx:5-20`
- Modify: `packages/web/lib/i18n/ko.ts:47-53`

- [ ] **Step 1: RunnerKind에 두 값 추가**

`packages/core/src/types/session.ts` 3행을 다음으로 교체:

```ts
export type RunnerKind =
  | "conductor"
  | "claude-code"
  | "claude-desktop"
  | "agent"
  | "codex"
  | "codex-desktop"
  | "unknown";
```

- [ ] **Step 2: 배지 스타일 추가**

`RunnerBadge.tsx`의 `STYLE`에 `agent` 다음 줄로:

```ts
  codex: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "codex-desktop": "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
```

`COMPACT`에 `agent` 다음 줄로:

```ts
  codex: "text-rose-300",
  "codex-desktop": "text-fuchsia-300",
```

- [ ] **Step 3: 한글 라벨 추가**

`ko.ts` `runner:` 블록의 `agent: "Agent",` 다음에:

```ts
    codex: "Codex",
    "codex-desktop": "Codex Desktop",
```

- [ ] **Step 4: 타입 검사**

Run: `pnpm --filter @claude-monitor/core build && cd packages/web && npx tsc --noEmit -p tsconfig.json`
Expected: 오류 없음 (`Record<RunnerKind, string>`이 두 키를 요구하므로 누락 시 오류).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/session.ts packages/web/app/_components/RunnerBadge.tsx packages/web/lib/i18n/ko.ts
git commit -m "core/web: RunnerKind에 codex·codex-desktop 추가 + 배지·라벨"
```

---

### Task 1 (실행): constants + meta

- [ ] **Step 1: 실패하는 테스트 작성** — `packages/adapter-claude-code/src/__tests__/codex-meta.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { codexSessionIdFromPath, parseCodexMeta, runnerFromOriginator } from "../codex/meta.js";
import { CODEX_ADAPTER_ID, CODEX_DISPLAY, defaultCodexDir } from "../codex/constants.js";

const PARENT = "01a0c3ac-0000-7000-8000-000000000001";
const CHILD = "01a0c3bf-0000-7000-8000-000000000002";

function metaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload });
}

describe("parseCodexMeta", () => {
  it("parses a user thread (string source)", () => {
    const m = parseCodexMeta(
      metaLine({ id: PARENT, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode", thread_source: "user" }),
    );
    expect(m).toEqual({
      id: PARENT,
      cwd: "/Users/alice/projects/demo",
      originator: "Codex Desktop",
      cliVersion: "0.154.0",
      parentThreadId: null,
      kind: "user",
      agentNickname: null,
      subagentHistoryStartOrdinal: null,
    });
  });

  it("parses a thread_spawn sub-agent (parent id, nickname, history start)", () => {
    const m = parseCodexMeta(
      metaLine({
        id: CHILD, cwd: "/Users/alice/projects/demo", originator: "codex_work_desktop", cli_version: "0.154.0",
        parent_thread_id: PARENT, subagent_history_start_ordinal: 9, thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: "/root/map_audit", agent_nickname: "McClintock", agent_role: null } } },
      }),
    );
    expect(m?.kind).toBe("subagent");
    expect(m?.parentThreadId).toBe(PARENT);
    expect(m?.agentNickname).toBe("McClintock");
    expect(m?.subagentHistoryStartOrdinal).toBe(9);
  });

  it("marks guardian / review internal threads hidden", () => {
    const g = parseCodexMeta(metaLine({ id: CHILD, cwd: "/x", originator: "Codex Desktop", cli_version: "0.154.0", parent_thread_id: PARENT, source: { subagent: { other: "guardian" } }, thread_source: "guardian_review" }));
    expect(g?.kind).toBe("hidden");
    const r = parseCodexMeta(metaLine({ id: CHILD, cwd: "/x", originator: "codex_exec", cli_version: "0.154.0", source: { subagent: "review" }, thread_source: "subagent" }));
    expect(r?.kind).toBe("hidden");
  });

  it("accepts an old-version meta without thread_source", () => {
    const m = parseCodexMeta(metaLine({ id: PARENT, cwd: "/Users/alice/w", originator: "codex_exec", cli_version: "0.128.0", source: "exec" }));
    expect(m?.kind).toBe("user");
    expect(m?.cliVersion).toBe("0.128.0");
  });

  it("returns null for non-meta, missing id/cwd, or malformed JSON", () => {
    expect(parseCodexMeta(JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }))).toBeNull();
    expect(parseCodexMeta(metaLine({ id: PARENT, originator: "x" }))).toBeNull();
    expect(parseCodexMeta(metaLine({ cwd: "/x" }))).toBeNull();
    expect(parseCodexMeta("{not json")).toBeNull();
  });
});

describe("runnerFromOriginator", () => {
  it("maps desktop originators to codex-desktop, everything else to codex", () => {
    expect(runnerFromOriginator("Codex Desktop")).toBe("codex-desktop");
    expect(runnerFromOriginator("codex_work_desktop")).toBe("codex-desktop");
    expect(runnerFromOriginator("codex_exec")).toBe("codex");
    expect(runnerFromOriginator("codex_cli_rs")).toBe("codex");
    expect(runnerFromOriginator(null)).toBe("codex");
  });
});

describe("codexSessionIdFromPath", () => {
  it("strips the rollout-<ts>- prefix and .jsonl", () => {
    expect(codexSessionIdFromPath(`/r/2026/09/21/rollout-2026-09-21T20-14-22-${PARENT}.jsonl`)).toBe(PARENT);
  });
  it("keeps the _<window> suffix of a continuation file", () => {
    expect(codexSessionIdFromPath(`/r/2026/09/17/rollout-2026-09-17T03-54-12-${PARENT}_${CHILD}.jsonl`)).toBe(`${PARENT}_${CHILD}`);
  });
  it("rejects other files", () => {
    expect(codexSessionIdFromPath("/r/2026/09/21/notes.txt")).toBeNull();
    expect(codexSessionIdFromPath("/r/2026/09/21/other.jsonl")).toBeNull();
  });
});

describe("constants", () => {
  it("exposes id, display and the default sessions dir", () => {
    expect(CODEX_ADAPTER_ID).toBe("codex");
    expect(CODEX_DISPLAY).toBe("Codex");
    expect(defaultCodexDir().endsWith("/.codex/sessions")).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-meta.test.ts`
Expected: FAIL — `Cannot find module '../codex/meta.js'`.

- [ ] **Step 3: 구현** — `packages/adapter-claude-code/src/codex/constants.ts`

```ts
import { homedir } from "node:os";
import { join } from "node:path";

/** Adapter id for OpenAI Codex (CLI / Desktop) rollout sessions. */
export const CODEX_ADAPTER_ID = "codex";

/** Display name (runner label lives in the web i18n table). */
export const CODEX_DISPLAY = "Codex";

/**
 * Default Codex rollout root:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<thread-id>[_<window-id>].jsonl`.
 */
export function defaultCodexDir(): string {
  return join(homedir(), ".codex", "sessions");
}
```

`packages/adapter-claude-code/src/codex/meta.ts`:

```ts
import { basename } from "node:path";
import type { RunnerKind } from "@claude-monitor/core";

/**
 * Which kind of Codex thread a rollout file holds:
 *  - "user": a thread the person drove (source "vscode" | "exec" | "cli").
 *  - "subagent": a `spawn_agent` child (source.subagent.thread_spawn) — shown
 *    nested under its parent.
 *  - "hidden": Codex-internal helper threads (guardian approval reviews,
 *    `{subagent: "review"}`) — not user work, never listed.
 */
export type CodexThreadKind = "user" | "subagent" | "hidden";

export interface CodexMeta {
  /** Thread id (`payload.id`). */
  id: string;
  cwd: string;
  /** "Codex Desktop" | "codex_work_desktop" | "codex_exec" | … */
  originator: string | null;
  cliVersion: string | null;
  parentThreadId: string | null;
  kind: CodexThreadKind;
  agentNickname: string | null;
  /** Sub-agent files open with a copy of the parent's history; records whose
   *  `ordinal` is below this belong to the parent and must be skipped. */
  subagentHistoryStartOrdinal: number | null;
}

interface RawMeta {
  type?: unknown;
  payload?: Record<string, unknown> | null;
}

/** Parse the first line of a rollout file. Null unless it is a usable `session_meta`. */
export function parseCodexMeta(line: string): CodexMeta | null {
  let obj: RawMeta;
  try {
    obj = JSON.parse(line) as RawMeta;
  } catch {
    return null;
  }
  if (obj?.type !== "session_meta" || obj.payload == null || typeof obj.payload !== "object") return null;
  const p = obj.payload;
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.cwd !== "string" || !p.cwd) return null;

  let kind: CodexThreadKind = "user";
  let agentNickname: string | null = null;
  const src = p.source;
  if (src != null && typeof src === "object") {
    const sub = (src as { subagent?: unknown }).subagent;
    const spawn =
      sub != null && typeof sub === "object" ? (sub as { thread_spawn?: unknown }).thread_spawn : undefined;
    if (spawn != null && typeof spawn === "object") {
      kind = "subagent";
      const nick = (spawn as { agent_nickname?: unknown }).agent_nickname;
      agentNickname = typeof nick === "string" ? nick : null;
    } else {
      kind = "hidden";
    }
  }
  const start = p.subagent_history_start_ordinal;
  return {
    id: p.id,
    cwd: p.cwd,
    originator: typeof p.originator === "string" ? p.originator : null,
    cliVersion: typeof p.cli_version === "string" ? p.cli_version : null,
    parentThreadId: typeof p.parent_thread_id === "string" && p.parent_thread_id ? p.parent_thread_id : null,
    kind,
    agentNickname,
    subagentHistoryStartOrdinal: typeof start === "number" && Number.isFinite(start) ? start : null,
  };
}

/** Originators written by the Codex desktop app (observed: both spellings). */
const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);

export function runnerFromOriginator(originator: string | null | undefined): RunnerKind {
  return originator != null && DESKTOP_ORIGINATORS.has(originator) ? "codex-desktop" : "codex";
}

const ROLLOUT_FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i;

/** Session id from a rollout file name: everything after `rollout-<ts>-`,
 *  so a post-compaction continuation (`<thread>_<window>.jsonl`) stays distinct. */
export function codexSessionIdFromPath(filePath: string): string | null {
  const m = basename(filePath).match(ROLLOUT_FILE_RE);
  return m ? m[1]! : null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-meta.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-claude-code/src/codex/constants.ts packages/adapter-claude-code/src/codex/meta.ts packages/adapter-claude-code/src/__tests__/codex-meta.test.ts
git commit -m "adapter: Codex session_meta 해석 + constants"
```

---

### Task 2: parser (`foldCodex`)

**Files:**
- Create: `packages/adapter-claude-code/src/codex/parser.ts`
- Test: `packages/adapter-claude-code/src/__tests__/codex-parser.test.ts`

**Interfaces:**
- Consumes: `parseCodexMeta`, `CodexMeta` (Task 1); `summarizeTodos` (`../parser.js`, 기존).
- Produces: `initialCodex(): CodexState`, `foldCodex(state, line): CodexState`(malformed JSON이면 throw), `isCodexHumanTurn(text): boolean`, `codexToolDetail(name, args): string | null`, `execScriptDetail(input): string | null`, `usageOf(u): CodexUsage | null`, `metricOf(u: CodexUsage): number`, `codexTodo(state): TodoSnapshot | null`, `type CodexState`, `type CodexUsage`.

- [ ] **Step 1: 실패하는 테스트 작성** — `codex-parser.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  codexToolDetail,
  codexTodo,
  execScriptDetail,
  foldCodex,
  initialCodex,
  isCodexHumanTurn,
  metricOf,
  usageOf,
  type CodexState,
} from "../codex/parser.js";

const THREAD = "01a0c3ac-0000-7000-8000-000000000001";
let ord = 0;
function rec(type: string, payload: Record<string, unknown>, ts = "2026-09-21T11:14:22.358Z", ordinal?: number): string {
  return JSON.stringify({ timestamp: ts, ordinal: ordinal ?? ord++, type, payload });
}
function meta(extra: Record<string, unknown> = {}): string {
  return rec("session_meta", { id: THREAD, cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode", ...extra });
}
function usage(input: number, cached: number, output: number, reasoning = 0) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
}
function tokenCount(total: ReturnType<typeof usage>, last = total, ts?: string): string {
  return rec("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 }, rate_limits: null }, ts);
}
function userMsg(text: string, ts?: string): string {
  return rec("response_item", { type: "message", id: "msg_u", role: "user", content: [{ type: "input_text", text }] }, ts);
}
function assistantMsg(text: string, ts?: string): string {
  return rec("response_item", { type: "message", id: "msg_a", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] }, ts);
}
function foldAll(lines: string[], state: CodexState = initialCodex()): CodexState {
  return lines.reduce((s, l) => foldCodex(s, l), state);
}

describe("isCodexHumanTurn", () => {
  it("keeps plain requests, including the gstack 'IMPORTANT:' prompt", () => {
    expect(isCodexHumanTurn("프로젝트 코드를 분석해줘\n")).toBe(true);
    expect(isCodexHumanTurn("IMPORTANT: Do NOT read SKILL.md files. Summarize.")).toBe(true);
  });
  it("drops app-injected wrappers", () => {
    expect(isCodexHumanTurn("<environment_context>\n<cwd>/x</cwd>\n</environment_context>")).toBe(false);
    expect(isCodexHumanTurn("<recommended_plugins>\n- Airtable")).toBe(false);
    expect(isCodexHumanTurn("<send_user_message_question_reply>[{}]")).toBe(false);
    expect(isCodexHumanTurn("\n# Files mentioned by the user:\n\n## a.md: /x/a.md")).toBe(false);
    expect(isCodexHumanTurn("# Files pasted by the user:\n")).toBe(false);
    expect(isCodexHumanTurn("# Selected text\nfoo")).toBe(false);
    expect(isCodexHumanTurn("# AGENTS.md instructions for /x\n")).toBe(false);
    expect(isCodexHumanTurn("   ")).toBe(false);
  });
});

describe("foldCodex — meta, turn lifecycle, model/mode", () => {
  it("takes cwd/version/originator from the first meta and ignores a repeated (parent) meta", () => {
    ord = 0;
    const s = foldAll([meta(), rec("session_meta", { id: "other", cwd: "/elsewhere", originator: "codex_exec", cli_version: "0.1.0", source: "exec" })]);
    expect(s.cwd).toBe("/Users/alice/projects/demo");
    expect(s.version).toBe("0.154.0");
    expect(s.originator).toBe("Codex Desktop");
  });

  it("latches endedTurn on task_complete, keeps it through passive records, clears on the next human turn", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      rec("event_msg", { type: "task_started", turn_id: "t1", model_context_window: 258400 }),
      userMsg("안녕"),
      assistantMsg("네"),
      rec("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "네" }),
      rec("event_msg", { type: "thread_settings_applied", thread_id: THREAD, thread_settings: {} }),
    ]);
    expect(s.endedTurn).toBe(true);
    expect(s.lastTurnClean).toBe(true);
    expect(s.contextLimit).toBe(258400);
    foldCodex(s, userMsg("다음"));
    expect(s.endedTurn).toBe(false);
    expect(s.turnTokens).toBe(0);
  });

  it("turn_aborted ends the turn as cancelled; a new task_started resets the flags", () => {
    ord = 0;
    const s = foldAll([meta(), rec("event_msg", { type: "task_started", turn_id: "t1" }), userMsg("x"), rec("event_msg", { type: "turn_aborted", turn_id: "t1", reason: "interrupted" })]);
    expect(s.endedTurn).toBe(true);
    expect(s.sawCancelled).toBe(true);
    expect(s.lastTurnClean).toBe(false);
    foldCodex(s, rec("event_msg", { type: "task_started", turn_id: "t2" }));
    expect(s.endedTurn).toBe(false);
    expect(s.sawCancelled).toBe(false);
  });

  it("reads model and approval policy from turn_context", () => {
    ord = 0;
    const s = foldAll([meta(), rec("turn_context", { turn_id: "t1", cwd: "/Users/alice/projects/demo", approval_policy: "on-request", model: "gpt-6-astra", effort: "high" })]);
    expect(s.model).toBe("gpt-6-astra");
    expect(s.mode).toBe("on-request");
  });

  it("throws on malformed JSON so the tail loop can roll back", () => {
    expect(() => foldCodex(initialCodex(), "{\"type\":\"event_msg\"")).toThrow();
  });
});

describe("foldCodex — human turns and replies", () => {
  it("collects real user turns (wrappers skipped), stamps turn start, and pairs the assistant reply", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      userMsg("<environment_context>x</environment_context>", "2026-09-21T11:14:25.000Z"),
      userMsg("프로젝트 코드를 분석해줘\n", "2026-09-21T11:14:25.200Z"),
      assistantMsg("첫 답", "2026-09-21T11:14:26.000Z"),
      assistantMsg("프로젝트는 pnpm 모노레포입니다.", "2026-09-21T11:14:30.000Z"),
    ]);
    expect(s.userTurns).toEqual(["프로젝트 코드를 분석해줘"]);
    expect(s.userResponses).toEqual(["프로젝트는 pnpm 모노레포입니다."]);
    expect(s.lastText).toBe("프로젝트는 pnpm 모노레포입니다.");
    expect(s.lastUserTurnTsMs).toBe(Date.parse("2026-09-21T11:14:25.200Z"));
    expect(s.firstTsMs).toBe(Date.parse("2026-09-21T11:14:22.358Z"));
    expect(s.lastTsMs).toBe(Date.parse("2026-09-21T11:14:30.000Z"));
  });
});

describe("foldCodex — tokens", () => {
  it("sums cumulative deltas of uncached input + output, ignoring duplicate token_count events", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      userMsg("q", "2026-09-21T11:14:25.200Z"),
      tokenCount(usage(12880, 9600, 328, 29), undefined, "2026-09-21T11:14:27.100Z"),
      tokenCount(usage(26000, 21000, 500, 40), usage(13120, 11400, 172, 11), "2026-09-21T11:14:30.100Z"),
      tokenCount(usage(26000, 21000, 500, 40), usage(13120, 11400, 172, 11), "2026-09-21T11:14:30.200Z"),
    ]);
    expect(s.totalTokens).toBe(3608 + 1892);
    expect(s.turnTokens).toBe(5500);
    expect(s.tokenEvents).toBe(3);
    expect(s.contextTokens).toBe(13292 - 11);
    expect(s.contextLimit).toBe(258400);
    expect(s.firstTokenTsMs).toBe(Date.parse("2026-09-21T11:14:27.100Z"));
  });

  it("treats a drop in total_tokens as a reset (fresh cumulative)", () => {
    ord = 0;
    const s = foldAll([meta(), tokenCount(usage(50000, 40000, 1000)), tokenCount(usage(3000, 0, 100))]);
    expect(s.totalTokens).toBe(11000 + 3100);
  });

  it("ignores token_count without info", () => {
    ord = 0;
    const s = foldAll([meta(), rec("event_msg", { type: "token_count", info: null, rate_limits: {} })]);
    expect(s.totalTokens).toBe(0);
    expect(s.tokenEvents).toBe(0);
  });

  it("usageOf / metricOf", () => {
    expect(usageOf(null)).toBeNull();
    const u = usageOf(usage(100, 60, 10, 3))!;
    expect(u).toEqual({ input: 100, cached: 60, cacheWrite: 0, output: 10, reasoning: 3, total: 110 });
    expect(metricOf(u)).toBe(50);
  });
});

describe("foldCodex — sub-agent prefix skip", () => {
  it("skips records below subagent_history_start_ordinal (the parent's copied history)", () => {
    ord = 0;
    const s = foldAll([
      meta({ parent_thread_id: "p", subagent_history_start_ordinal: 4, source: { subagent: { thread_spawn: { parent_thread_id: "p", agent_nickname: "Bacon" } } } }),
      rec("session_meta", { id: "p", cwd: "/Users/alice/projects/demo", originator: "Codex Desktop", cli_version: "0.154.0", source: "vscode" }, "2026-09-21T11:14:22.358Z"),
      userMsg("부모의 요청", "2026-09-21T11:14:25.200Z"),
      tokenCount(usage(12880, 9600, 328), undefined, "2026-09-21T11:14:27.100Z"),
      userMsg("자식의 과제", "2026-09-21T11:20:00.400Z"),
      tokenCount(usage(3000, 0, 100), undefined, "2026-09-21T11:20:06.000Z"),
    ]);
    expect(s.userTurns).toEqual(["자식의 과제"]);
    expect(s.totalTokens).toBe(3100);
    expect(s.firstTsMs).toBe(Date.parse("2026-09-21T11:14:22.358Z"));
    expect(s.lastTsMs).toBe(Date.parse("2026-09-21T11:20:06.000Z"));
  });
});

describe("foldCodex — tools", () => {
  it("function_call: name + salient detail, counts tools, clears endedTurn", () => {
    ord = 0;
    const s = foldAll([
      meta(),
      rec("event_msg", { type: "task_complete", turn_id: "t0" }),
      rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la", workdir: "/x" }), call_id: "c1" }),
    ]);
    expect(s.lastToolName).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("ls -la");
    expect(s.toolCount).toBe(1);
    expect(s.endedTurn).toBe(false);
  });

  it("custom exec: inner tools.<name> becomes the tool, cmd/q the detail", () => {
    ord = 0;
    const s = foldAll([meta(), rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c2", input: 'text(await tools.exec_command({cmd:"cat \'/x/a.md\'",max_output_tokens:1000}))' })]);
    expect(s.lastToolName).toBe("exec_command");
    expect(s.lastActivityDetail).toBe("cat '/x/a.md'");
    foldCodex(s, rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c3", input: "text(await tools.web__run({search_query:[{q:'site.law.go.kr 여신전문금융업법'}],response_length:'short'}))" }));
    expect(s.lastToolName).toBe("web__run");
    expect(s.lastActivityDetail).toBe("site.law.go.kr 여신전문금융업법");
    expect(s.toolCount).toBe(2);
  });

  it("update_plan becomes a todo snapshot", () => {
    ord = 0;
    const s = foldAll([meta(), rec("response_item", { type: "function_call", name: "update_plan", call_id: "c4", arguments: JSON.stringify({ explanation: "", plan: [{ step: "구조 확인", status: "completed" }, { step: "라우팅 파악", status: "in_progress" }, { step: "리스크 정리", status: "pending" }] }) })]);
    expect(codexTodo(s)).toEqual({ total: 3, done: 1, current: "라우팅 파악", next: "리스크 정리" });
    expect(codexTodo(initialCodex())).toBeNull();
  });

  it("codexToolDetail / execScriptDetail", () => {
    expect(codexToolDetail("js", { code: "await cua.getState();", title: "시뮬레이터 미리보기 탭 확인" })).toBe("시뮬레이터 미리보기 탭 확인");
    expect(codexToolDetail("js", { code: "await cua.getState();" })).toBe("await cua.getState();");
    expect(codexToolDetail("spawn_agent", { task_name: "map_audit", message: "enc" })).toBe("map_audit");
    expect(codexToolDetail("send_message", { target: "map_audit", message: "enc" })).toBe("map_audit");
    expect(codexToolDetail("followup_task", { target: "review", message: "enc" })).toBe("review");
    expect(codexToolDetail("request_user_input_async", { questions: [{ title: "어디에 쓰나요?", options: [] }] })).toBe("어디에 쓰나요?");
    expect(codexToolDetail("wait", {})).toBeNull();
    expect(codexToolDetail("exec_command", { cmd: "x".repeat(100) })?.length).toBe(60);
    expect(execScriptDetail("tools.exec_command({cmd:`echo hi`})")).toBe("echo hi");
    expect(execScriptDetail("tools.sleep({ms:100})")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 구현** — `packages/adapter-claude-code/src/codex/parser.ts`

```ts
import type { TodoSnapshot } from "@claude-monitor/core";
import { summarizeTodos } from "../parser.js";
import { parseCodexMeta, type CodexMeta } from "./meta.js";

const LAST_TEXT_MAX = 200;
const HUMAN_TURN_MAX = 200;
const USER_TURNS_CAP = 100;
const ACTIVITY_DETAIL_MAX = 60;

/** `role:"user"` preambles the Codex app injects around the person's request
 *  (observed on disk; each is its own message record, so dropping them keeps
 *  the real request intact). Angle-bracket wrappers (`<environment_context>`,
 *  `<recommended_plugins>`, `<send_user_message_question_reply>`, …) are
 *  handled by the leading-`<` rule. */
const HIDDEN_USER_PREFIXES = [
  "# Files mentioned by the user",
  "# Files pasted by the user",
  "# Selected text",
  "# AGENTS.md instructions",
];

export interface CodexUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface CodexPlanStep {
  step: string;
  status: string;
}

export interface CodexState {
  meta: CodexMeta | null;
  /** Records with `ordinal` below this are the parent's copied history (sub-agent files). */
  skipBeforeOrdinal: number | null;
  /** Line counter, the ordinal fallback for records without one. */
  lineIndex: number;
  cwd: string | null;
  version: string | null;
  originator: string | null;
  model: string | null;
  /** `turn_context.approval_policy` ("on-request" | "never" | …). */
  mode: string | null;
  lastToolName: string | null;
  lastActivityDetail: string | null;
  toolCount: number;
  /** Latest `update_plan` steps. */
  lastPlan: CodexPlanStep[] | null;
  lastText: string | null;
  userTurns: string[];
  userResponses: string[];
  lastUserTurnTsMs: number | null;
  turnTokens: number;
  totalTokens: number;
  /** Last cumulative usage seen — the delta baseline. */
  lastCum: CodexUsage | null;
  /** Count of folded token_count events (with info) — lets series readers
   *  detect "this line was a token event" without re-parsing. */
  tokenEvents: number;
  contextTokens: number | null;
  contextLimit: number | null;
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** Timestamp of the first token_count that added tokens (session start). */
  firstTokenTsMs: number | null;
  /** The last turn-level event was task_complete/turn_aborted and nothing
   *  active (human turn, reply, tool call, task_started) came after. */
  endedTurn: boolean;
  /** The current/last turn finished with task_complete. */
  lastTurnClean: boolean;
  /** The current/last turn ended with turn_aborted. */
  sawCancelled: boolean;
}

export function initialCodex(): CodexState {
  return {
    meta: null,
    skipBeforeOrdinal: null,
    lineIndex: 0,
    cwd: null,
    version: null,
    originator: null,
    model: null,
    mode: null,
    lastToolName: null,
    lastActivityDetail: null,
    toolCount: 0,
    lastPlan: null,
    lastText: null,
    userTurns: [],
    userResponses: [],
    lastUserTurnTsMs: null,
    turnTokens: 0,
    totalTokens: 0,
    lastCum: null,
    tokenEvents: 0,
    contextTokens: null,
    contextLimit: null,
    firstTsMs: null,
    lastTsMs: null,
    firstTokenTsMs: null,
    endedTurn: false,
    lastTurnClean: false,
    sawCancelled: false,
  };
}

interface RawRecord {
  timestamp?: unknown;
  ordinal?: unknown;
  type?: unknown;
  payload?: Record<string, unknown> | null;
}

/**
 * Fold one rollout line into the state. Throws on malformed JSON (the tail
 * loop treats that as a partial write and rolls back to the line start).
 */
export function foldCodex(state: CodexState, line: string): CodexState {
  const obj = JSON.parse(line) as RawRecord;
  const ordinal = typeof obj.ordinal === "number" ? obj.ordinal : state.lineIndex;
  state.lineIndex++;
  const p = (obj.payload != null && typeof obj.payload === "object" ? obj.payload : {}) as Record<string, unknown>;
  const tsMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;

  if (obj.type === "session_meta") {
    if (state.meta != null) return state; // sub-agent files repeat the parent's meta
    const meta = parseCodexMeta(line);
    if (!meta) return state;
    state.meta = meta;
    state.cwd = meta.cwd;
    state.version = meta.cliVersion;
    state.originator = meta.originator;
    state.skipBeforeOrdinal = meta.subagentHistoryStartOrdinal;
    stampTs(state, tsMs);
    return state;
  }
  if (state.skipBeforeOrdinal != null && ordinal < state.skipBeforeOrdinal) return state;
  stampTs(state, tsMs);

  switch (obj.type) {
    case "event_msg":
      foldEvent(state, p, tsMs);
      break;
    case "response_item":
      foldResponseItem(state, p, tsMs);
      break;
    case "turn_context":
      if (typeof p.model === "string" && p.model) state.model = p.model;
      if (typeof p.approval_policy === "string" && p.approval_policy) state.mode = p.approval_policy;
      break;
    default:
      break;
  }
  return state;
}

function stampTs(state: CodexState, tsMs: number): void {
  if (!Number.isFinite(tsMs)) return;
  if (state.firstTsMs == null) state.firstTsMs = tsMs;
  state.lastTsMs = tsMs;
}

function foldEvent(state: CodexState, p: Record<string, unknown>, tsMs: number): void {
  switch (p.type) {
    case "task_started":
      if (typeof p.model_context_window === "number" && p.model_context_window > 0) {
        state.contextLimit = p.model_context_window;
      }
      state.endedTurn = false;
      state.lastTurnClean = false;
      state.sawCancelled = false;
      break;
    case "task_complete":
      state.endedTurn = true;
      state.lastTurnClean = true;
      break;
    case "turn_aborted":
      state.endedTurn = true;
      state.lastTurnClean = false;
      state.sawCancelled = true;
      break;
    case "token_count":
      foldTokenCount(state, p.info, tsMs);
      break;
    default:
      break;
  }
}

function foldTokenCount(state: CodexState, info: unknown, tsMs: number): void {
  if (info == null || typeof info !== "object") return;
  const i = info as Record<string, unknown>;
  if (typeof i.model_context_window === "number" && i.model_context_window > 0) {
    state.contextLimit = i.model_context_window;
  }
  const last = usageOf(i.last_token_usage);
  // Context occupancy: the last response's total minus its reasoning output —
  // the formula the Codex TUI uses for "% context left" (as recalled from
  // codex-rs TokenUsage::tokens_in_context_window; not verified against source).
  if (last) state.contextTokens = Math.max(0, last.total - last.reasoning);
  const cum = usageOf(i.total_token_usage);
  if (!cum) return;
  state.tokenEvents++;
  // Cumulative deltas: token_count is re-emitted with identical usage (rate
  // limit refreshes), so summing last_token_usage would overcount. A drop in
  // total_tokens means a fresh cumulative (e.g. after a window switch).
  const m = metricOf(cum);
  const reset = state.lastCum != null && cum.total < state.lastCum.total;
  const delta = state.lastCum == null || reset ? m : Math.max(0, m - metricOf(state.lastCum));
  state.lastCum = cum;
  if (delta > 0) {
    state.totalTokens += delta;
    state.turnTokens += delta;
    if (state.firstTokenTsMs == null && Number.isFinite(tsMs)) state.firstTokenTsMs = tsMs;
  }
}

export function usageOf(u: unknown): CodexUsage | null {
  if (u == null || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const n = (k: string): number => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return {
    input: n("input_tokens"),
    cached: n("cached_input_tokens"),
    cacheWrite: n("cache_write_input_tokens"),
    output: n("output_tokens"),
    reasoning: n("reasoning_output_tokens"),
    total: n("total_tokens"),
  };
}

/** Work processed — comparable to the Claude adapter's metricTokens: uncached
 *  input + cache writes + output (OpenAI's input_tokens INCLUDES cached tokens). */
export function metricOf(u: CodexUsage): number {
  return Math.max(0, u.input - u.cached) + u.cacheWrite + u.output;
}

function foldResponseItem(state: CodexState, p: Record<string, unknown>, tsMs: number): void {
  switch (p.type) {
    case "message": {
      if (p.role === "user") {
        const text = joinText(p.content, "input_text");
        if (!isCodexHumanTurn(text)) return;
        state.userTurns.push(text.trim().slice(0, HUMAN_TURN_MAX));
        state.userResponses.push("");
        if (state.userTurns.length > USER_TURNS_CAP) {
          state.userTurns.splice(1, 1);
          state.userResponses.splice(1, 1);
        }
        state.turnTokens = 0;
        if (Number.isFinite(tsMs)) state.lastUserTurnTsMs = tsMs;
        state.endedTurn = false;
      } else if (p.role === "assistant") {
        const t = joinText(p.content, "output_text").trim();
        if (!t) return;
        state.lastText = t.slice(0, LAST_TEXT_MAX);
        if (state.userResponses.length > 0) state.userResponses[state.userResponses.length - 1] = state.lastText;
        state.endedTurn = false;
      }
      return;
    }
    case "function_call": {
      const name = typeof p.name === "string" ? p.name : "";
      if (!name) return;
      const args = parseArgs(p.arguments);
      state.toolCount++;
      state.lastToolName = name;
      state.lastActivityDetail = codexToolDetail(name, args);
      state.endedTurn = false;
      if (name === "update_plan" && Array.isArray(args.plan)) state.lastPlan = planSteps(args.plan);
      return;
    }
    case "custom_tool_call": {
      const name = typeof p.name === "string" ? p.name : "";
      if (!name) return;
      state.toolCount++;
      state.endedTurn = false;
      const input = typeof p.input === "string" ? p.input : "";
      // Codex's `exec` custom tool runs a JS snippet that calls `tools.<name>(…)`;
      // the inner tool is what the agent is actually doing.
      const inner = name === "exec" ? input.match(/tools\.([A-Za-z0-9_]+)\(/) : null;
      state.lastToolName = inner ? inner[1]! : name;
      state.lastActivityDetail = name === "exec" ? execScriptDetail(input) : null;
      return;
    }
    default:
      return;
  }
}

function joinText(content: unknown, wantedType: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c != null && typeof c === "object") {
      const r = c as { type?: unknown; text?: unknown };
      if (r.type === wantedType && typeof r.text === "string") out += r.text;
    }
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw != null && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function planSteps(plan: unknown[]): CodexPlanStep[] {
  const out: CodexPlanStep[] = [];
  for (const it of plan) {
    if (it == null || typeof it !== "object") continue;
    const r = it as { step?: unknown; status?: unknown };
    out.push({ step: typeof r.step === "string" ? r.step : "", status: typeof r.status === "string" ? r.status : "" });
  }
  return out;
}

/** A real human turn: non-empty, not an app wrapper (`<tag>` or a known `# …` preamble). */
export function isCodexHumanTurn(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.startsWith("<")) return false;
  return !HIDDEN_USER_PREFIXES.some((prefix) => t.startsWith(prefix));
}

/** Human-readable target of a `function_call` (≤ 60 chars) or null. */
export function codexToolDetail(name: string, args: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  let detail: string | null;
  switch (name) {
    case "exec_command":
      detail = str(args.cmd);
      break;
    case "js":
      detail = str(args.title) ?? str(args.code);
      break;
    case "spawn_agent":
      detail = str(args.task_name);
      break;
    case "send_message":
    case "followup_task":
      detail = str(args.target);
      break;
    case "request_user_input_async": {
      const q = Array.isArray(args.questions) ? args.questions[0] : null;
      detail = q != null && typeof q === "object" ? str((q as { title?: unknown }).title) : null;
      break;
    }
    default:
      detail = null;
  }
  return detail ? detail.slice(0, ACTIVITY_DETAIL_MAX) : null;
}

const CMD_RE = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const QUERY_RE = /\bq\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;

/** The shell command (`cmd:"…"`) or first search query (`q:'…'`) inside an
 *  `exec` JS snippet, ≤ 60 chars; null when neither is present. */
export function execScriptDetail(input: string): string | null {
  const m = input.match(CMD_RE) ?? input.match(QUERY_RE);
  const d = m ? m[2]!.trim() : "";
  return d ? d.slice(0, ACTIVITY_DETAIL_MAX) : null;
}

/** The latest `update_plan` as a TodoSnapshot (same UI as TodoWrite). */
export function codexTodo(state: CodexState): TodoSnapshot | null {
  if (!state.lastPlan) return null;
  return summarizeTodos(state.lastPlan.map((s) => ({ status: s.status, content: s.step })));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-claude-code/src/codex/parser.ts packages/adapter-claude-code/src/__tests__/codex-parser.test.ts
git commit -m "adapter: Codex rollout 파서(foldCodex) — 턴·토큰 차분·도구·plan"
```

---

### Task 3: reader + fixtures

**Files:**
- Create: `packages/adapter-claude-code/src/codex/reader.ts`
- Create: `packages/adapter-claude-code/src/__tests__/fixtures/codex/codex-simple.jsonl`
- Create: `packages/adapter-claude-code/src/__tests__/fixtures/codex/codex-subagent.jsonl`
- Create: `packages/adapter-claude-code/src/__tests__/fixtures/codex/codex-aborted.jsonl`
- Test: `packages/adapter-claude-code/src/__tests__/codex-reader.test.ts`

**Interfaces:**
- Consumes: `foldCodex`, `initialCodex`, `codexTodo` (Task 2); `runnerFromOriginator` (Task 1); `tailLines` (`../cowork/tail.js`, 기존); core `statusFromMtime`, `deriveSessionStatus`, `computeContext`, `defaultThresholds`.
- Produces: `class CodexReader implements SessionReader` (`constructor(ref: SessionRef, opts?: { thresholds?: StatusThresholds })`), `type CodexReaderOptions`.

- [ ] **Step 1: fixtures 작성**

`fixtures/codex/codex-simple.jsonl` (15줄, 한 줄에 하나):

```jsonl
{"timestamp":"2026-09-21T11:14:22.358Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0c3ac-0000-7000-8000-000000000001","id":"01a0c3ac-0000-7000-8000-000000000001","timestamp":"2026-09-21T11:14:22.084Z","cwd":"/Users/alice/projects/demo","originator":"Codex Desktop","cli_version":"0.154.0","source":"vscode","thread_source":"user","model_provider":"openai","base_instructions":{"text":"You are Codex."},"history_mode":"legacy","git":{"commit_hash":"33b3901ef69f80aed674a7913131a053b38e0bc2","branch":"main","repository_url":"git@github.com:alice/demo.git"}}}
{"timestamp":"2026-09-21T11:14:22.358Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1","model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-09-21T11:14:24.991Z","ordinal":2,"type":"response_item","payload":{"type":"message","id":"msg_dev","role":"developer","content":[{"type":"input_text","text":"<app-context>desktop</app-context>"}]}}
{"timestamp":"2026-09-21T11:14:25.000Z","ordinal":3,"type":"response_item","payload":{"type":"message","id":"msg_env","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/Users/alice/projects/demo</cwd>\n</environment_context>"}]}}
{"timestamp":"2026-09-21T11:14:25.100Z","ordinal":4,"type":"turn_context","payload":{"turn_id":"t1","cwd":"/Users/alice/projects/demo","approval_policy":"on-request","sandbox_policy":{"type":"workspace-write"},"model":"gpt-6-astra","effort":"high","summary":"none"}}
{"timestamp":"2026-09-21T11:14:25.200Z","ordinal":5,"type":"response_item","payload":{"type":"message","id":"msg_u1","role":"user","content":[{"type":"input_text","text":"프로젝트 코드를 분석해줘\n"}]}}
{"timestamp":"2026-09-21T11:14:26.000Z","ordinal":6,"type":"response_item","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"xxx"}}
{"timestamp":"2026-09-21T11:14:27.000Z","ordinal":7,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls -la\",\"workdir\":\"/Users/alice/projects/demo\",\"max_output_tokens\":200}","call_id":"call_1"}}
{"timestamp":"2026-09-21T11:14:27.100Z","ordinal":8,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12880,"cached_input_tokens":9600,"cache_write_input_tokens":0,"output_tokens":328,"reasoning_output_tokens":29,"total_tokens":13208},"last_token_usage":{"input_tokens":12880,"cached_input_tokens":9600,"cache_write_input_tokens":0,"output_tokens":328,"reasoning_output_tokens":29,"total_tokens":13208},"model_context_window":258400},"rate_limits":null}}
{"timestamp":"2026-09-21T11:14:28.000Z","ordinal":9,"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"total 0"}}
{"timestamp":"2026-09-21T11:14:30.000Z","ordinal":10,"type":"response_item","payload":{"type":"message","id":"msg_a1","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"프로젝트는 pnpm 모노레포입니다."}]}}
{"timestamp":"2026-09-21T11:14:30.100Z","ordinal":11,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26000,"cached_input_tokens":21000,"cache_write_input_tokens":0,"output_tokens":500,"reasoning_output_tokens":40,"total_tokens":26500},"last_token_usage":{"input_tokens":13120,"cached_input_tokens":11400,"cache_write_input_tokens":0,"output_tokens":172,"reasoning_output_tokens":11,"total_tokens":13292},"model_context_window":258400},"rate_limits":null}}
{"timestamp":"2026-09-21T11:14:30.200Z","ordinal":12,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26000,"cached_input_tokens":21000,"cache_write_input_tokens":0,"output_tokens":500,"reasoning_output_tokens":40,"total_tokens":26500},"last_token_usage":{"input_tokens":13120,"cached_input_tokens":11400,"cache_write_input_tokens":0,"output_tokens":172,"reasoning_output_tokens":11,"total_tokens":13292},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":1}}}}
{"timestamp":"2026-09-21T11:14:30.300Z","ordinal":13,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"프로젝트는 pnpm 모노레포입니다."}}
{"timestamp":"2026-09-21T11:14:31.000Z","ordinal":14,"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"01a0c3ac-0000-7000-8000-000000000001","thread_settings":{"model":"gpt-6-astra"}}}
```

`fixtures/codex/codex-subagent.jsonl` (15줄):

```jsonl
{"timestamp":"2026-09-21T11:20:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0c3ac-0000-7000-8000-000000000001","id":"01a0c3bf-0000-7000-8000-000000000002","parent_thread_id":"01a0c3ac-0000-7000-8000-000000000001","forked_from_id":"01a0c3ac-0000-7000-8000-000000000001","subagent_history_start_ordinal":6,"timestamp":"2026-09-21T11:20:00.000Z","cwd":"/Users/alice/projects/demo","originator":"codex_work_desktop","cli_version":"0.154.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a0c3ac-0000-7000-8000-000000000001","depth":1,"agent_path":"/root/map_audit","agent_nickname":"McClintock","agent_role":null}}},"thread_source":"subagent","model_provider":"openai","base_instructions":{"text":"You are Codex."},"history_mode":"legacy"}}
{"timestamp":"2026-09-21T11:14:22.358Z","ordinal":1,"type":"session_meta","payload":{"session_id":"01a0c3ac-0000-7000-8000-000000000001","id":"01a0c3ac-0000-7000-8000-000000000001","timestamp":"2026-09-21T11:14:22.084Z","cwd":"/Users/alice/projects/demo","originator":"Codex Desktop","cli_version":"0.154.0","source":"vscode","thread_source":"user","model_provider":"openai","base_instructions":{"text":"You are Codex."},"history_mode":"legacy"}}
{"timestamp":"2026-09-21T11:14:22.358Z","ordinal":2,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1","model_context_window":258400}}
{"timestamp":"2026-09-21T11:14:25.200Z","ordinal":3,"type":"response_item","payload":{"type":"message","id":"msg_u1","role":"user","content":[{"type":"input_text","text":"프로젝트 코드를 분석해줘\n"}]}}
{"timestamp":"2026-09-21T11:14:27.100Z","ordinal":4,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12880,"cached_input_tokens":9600,"cache_write_input_tokens":0,"output_tokens":328,"reasoning_output_tokens":29,"total_tokens":13208},"last_token_usage":{"input_tokens":12880,"cached_input_tokens":9600,"cache_write_input_tokens":0,"output_tokens":328,"reasoning_output_tokens":29,"total_tokens":13208},"model_context_window":258400},"rate_limits":null}}
{"timestamp":"2026-09-21T11:14:30.300Z","ordinal":5,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"프로젝트는 pnpm 모노레포입니다."}}
{"timestamp":"2026-09-21T11:20:00.100Z","ordinal":6,"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"01a0c3bf-0000-7000-8000-000000000002","thread_settings":{"model":"gpt-6-astra"}}}
{"timestamp":"2026-09-21T11:20:00.200Z","ordinal":7,"type":"event_msg","payload":{"type":"task_started","turn_id":"t2","model_context_window":258400}}
{"timestamp":"2026-09-21T11:20:00.300Z","ordinal":8,"type":"turn_context","payload":{"turn_id":"t2","cwd":"/Users/alice/projects/demo","approval_policy":"never","model":"gpt-6-astra","effort":"medium","summary":"none"}}
{"timestamp":"2026-09-21T11:20:00.400Z","ordinal":9,"type":"response_item","payload":{"type":"message","id":"msg_u2","role":"user","content":[{"type":"input_text","text":"지도 감사를 수행해\n"}]}}
{"timestamp":"2026-09-21T11:20:05.000Z","ordinal":10,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_1","status":"completed","call_id":"call_2","name":"exec","input":"text(await tools.exec_command({cmd:\"grep -rn foo src\",max_output_tokens:2000}))"}}
{"timestamp":"2026-09-21T11:20:05.500Z","ordinal":11,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_1","call_id":"call_2","output":"[]"}}
{"timestamp":"2026-09-21T11:20:06.000Z","ordinal":12,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":5,"total_tokens":3100},"last_token_usage":{"input_tokens":3000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":5,"total_tokens":3100},"model_context_window":258400},"rate_limits":null}}
{"timestamp":"2026-09-21T11:20:08.000Z","ordinal":13,"type":"response_item","payload":{"type":"message","id":"msg_a2","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"감사 완료: 이상 없음."}]}}
{"timestamp":"2026-09-21T11:20:08.100Z","ordinal":14,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t2","last_agent_message":"감사 완료: 이상 없음."}}
```

`fixtures/codex/codex-aborted.jsonl` (7줄, 구버전 codex exec):

```jsonl
{"timestamp":"2026-05-13T07:14:03.000Z","ordinal":0,"type":"session_meta","payload":{"id":"019e202f-0000-7000-8000-000000000003","timestamp":"2026-05-13T07:14:03.000Z","cwd":"/Users/alice/zz/project-x","originator":"codex_exec","cli_version":"0.128.0","source":"exec","model_provider":"openai","base_instructions":{"text":"You are Codex."}}}
{"timestamp":"2026-05-13T07:14:03.100Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1","model_context_window":258400}}
{"timestamp":"2026-05-13T07:14:03.200Z","ordinal":2,"type":"turn_context","payload":{"turn_id":"t1","cwd":"/Users/alice/zz/project-x","approval_policy":"never","model":"gpt-5.4","effort":"medium","summary":"none"}}
{"timestamp":"2026-05-13T07:14:03.300Z","ordinal":3,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"IMPORTANT: Do NOT read SKILL.md files. Summarize the repo."}]}}
{"timestamp":"2026-05-13T07:14:05.000Z","ordinal":4,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}","call_id":"call_1"}}
{"timestamp":"2026-05-13T07:14:05.100Z","ordinal":5,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":1000,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":0,"total_tokens":5050},"last_token_usage":{"input_tokens":5000,"cached_input_tokens":1000,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":0,"total_tokens":5050},"model_context_window":258400},"rate_limits":null}}
{"timestamp":"2026-05-13T07:14:44.000Z","ordinal":6,"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1","reason":"interrupted","completed_at":1778656484,"duration_ms":41503}}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `codex-reader.test.ts`

```ts
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
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-reader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: 구현** — `packages/adapter-claude-code/src/codex/reader.ts`

```ts
import { stat } from "node:fs/promises";
import type { AgentStatus, SessionReader, SessionRef, SessionStatus, SessionSummary } from "@claude-monitor/core";
import {
  computeContext,
  defaultThresholds,
  deriveSessionStatus,
  statusFromMtime,
  type StatusThresholds,
} from "@claude-monitor/core";
import { tailLines } from "../cowork/tail.js";
import { runnerFromOriginator } from "./meta.js";
import { codexTodo, foldCodex, initialCodex, type CodexState } from "./parser.js";

export interface CodexReaderOptions {
  thresholds?: StatusThresholds;
}

/** Lifecycle of a sub-agent child from its own turn events. */
function agentStatusOf(s: CodexState, mtimeSec: number, now: number, thresholds: StatusThresholds): AgentStatus {
  if (s.sawCancelled) return "cancelled";
  if (s.lastTurnClean) return "done";
  return statusFromMtime(mtimeSec, now, thresholds) === "stop" ? "done" : "running";
}

/**
 * Stateful reader for one Codex rollout file. Same tail / rollback /
 * serialization discipline as {@link CoworkReader}; the record semantics live
 * in {@link foldCodex}. Codex sessions have no per-session process (pid null).
 */
export class CodexReader implements SessionReader {
  private state: CodexState = initialCodex();
  private byteOffset = 0;
  private cached: SessionSummary | null = null;
  /** Tail of this reader's pass queue — passes are serialized per reader. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly thresholds: StatusThresholds;

  constructor(public readonly ref: SessionRef, opts: CodexReaderOptions = {}) {
    this.thresholds = opts.thresholds ?? defaultThresholds;
  }

  status(now: number): SessionStatus {
    const mtime = this.cached?.ref.mtime ?? this.ref.mtime;
    return statusFromMtime(mtime, now, this.thresholds);
  }

  readIncremental(): Promise<SessionSummary> {
    const run = this.queue.then(() => this.readPass());
    this.queue = run.catch(() => undefined); // a failed pass must not block later ones
    return run;
  }

  private async readPass(): Promise<SessionSummary> {
    const st = await stat(this.ref.source);
    const size = st.size;
    const mtimeSec = Math.floor(st.mtimeMs / 1000);

    // Truncate/rotate detection — restart from byte 0.
    if (size < this.byteOffset) {
      this.state = initialCodex();
      this.byteOffset = 0;
      this.cached = null;
    }
    if (size > this.byteOffset) {
      this.byteOffset = await tailLines(this.ref.source, this.byteOffset, size, (line) => {
        this.state = foldCodex(this.state, line);
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const s = this.state;
    // Last activity = last timestamped record (every rollout record carries one);
    // file mtime only as a fallback for an empty/unreadable file.
    const activitySec = s.lastTsMs != null ? Math.floor(s.lastTsMs / 1000) : mtimeSec;
    const ref: SessionRef = { ...this.ref, mtime: activitySec };

    const context =
      s.contextTokens != null && s.contextLimit != null ? computeContext(s.contextTokens, s.contextLimit) : null;

    const isChild = ref.parentId != null;
    const ageSec = Math.max(0, now - activitySec);
    // Codex has no "pending sub-agent" signal in the parent's own file (children
    // are separate files, nested by parentId), so hasPending is always false.
    const status = isChild
      ? statusFromMtime(activitySec, now, this.thresholds)
      : deriveSessionStatus(ageSec, s.endedTurn, false, this.thresholds);
    const durationSec =
      s.firstTsMs != null && s.lastTsMs != null ? Math.max(0, Math.round((s.lastTsMs - s.firstTsMs) / 1000)) : 0;

    const summary: SessionSummary = {
      ref,
      status,
      lastTool: s.lastToolName,
      lastActivityDetail: s.lastActivityDetail,
      pendingSubagents: [],
      todo: codexTodo(s),
      lastText: s.lastText,
      firstPrompt: s.userTurns[0] ?? null,
      userTurns: s.userTurns,
      userResponses: s.userResponses,
      turnStartSec: s.lastUserTurnTsMs != null ? Math.floor(s.lastUserTurnTsMs / 1000) : null,
      turnTokens: s.userTurns.length > 0 ? s.turnTokens : null,
      endedTurn: s.endedTurn,
      runner: runnerFromOriginator(s.originator),
      model: s.model,
      mode: s.mode,
      version: s.version,
      context,
      pid: null,
      phase: null,
      agentStatus: isChild ? agentStatusOf(s, activitySec, now, this.thresholds) : null,
      metrics: isChild ? { tokens: s.totalTokens, tools: s.toolCount, durationSec } : null,
      totalTokens: s.totalTokens,
      startSec: s.firstTokenTsMs != null ? Math.floor(s.firstTokenTsMs / 1000) : null,
      updatedAt: now,
    };
    this.cached = summary;
    return summary;
  }

  close(): void {
    this.cached = null;
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-reader.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-claude-code/src/codex/reader.ts packages/adapter-claude-code/src/__tests__/codex-reader.test.ts packages/adapter-claude-code/src/__tests__/fixtures/codex/
git commit -m "adapter: CodexReader + fixtures"
```

---

### Task 4: watcher + adapter + exports

**Files:**
- Create: `packages/adapter-claude-code/src/codex/watcher.ts`
- Create: `packages/adapter-claude-code/src/codex/adapter.ts`
- Modify: `packages/adapter-claude-code/src/index.ts` (끝에 export 추가)
- Test: `packages/adapter-claude-code/src/__tests__/codex-watcher.test.ts`

**Interfaces:**
- Consumes: `parseCodexMeta`, `codexSessionIdFromPath` (Task 1); `CodexReader` (Task 3); core `projectIdentityFromCwd`, `shortenWorkspace`.
- Produces: `class CodexWatcher extends EventEmitter` (`start()`, `stop()`, `scan(): AsyncIterable<SessionRef>`, `on("event", cb)`), `readFirstLine(path, maxBytes?): Promise<string | null>`, `isIgnoredCodexPath(root, p): boolean`, `class CodexAdapter implements AISessionAdapter` (`id = "codex"`, `constructor(opts?: { codexDir?: string; thresholds?: StatusThresholds })`).

- [ ] **Step 1: 실패하는 테스트 작성** — `codex-watcher.test.ts`

```ts
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
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(newFile, metaLine({ id: NEW, cwd: "/Users/alice/projects/demo", originator: "codex_exec", cli_version: "0.154.0", source: "exec" }));
    await new Promise((r) => setTimeout(r, 500));
    await fs.appendFile(newFile, JSON.stringify({ timestamp: "2026-09-21T11:14:23.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } }) + "\n");
    await new Promise((r) => setTimeout(r, 500));
    await fs.rm(newFile);
    await new Promise((r) => setTimeout(r, 500));
    await w.stop();
    expect(events.some((e) => e.kind === "added" && e.id === NEW)).toBe(true);
    expect(events.some((e) => e.kind === "changed" && e.id === NEW)).toBe(true);
    expect(events.some((e) => e.kind === "removed" && e.id === NEW)).toBe(true);
    expect(events.some((e) => e.id === GUARD && e.kind !== "removed")).toBe(false);
  });

  it("CodexAdapter.discover yields the scan and open returns a reader", async () => {
    const a = new CodexAdapter({ codexDir: root });
    const ids: string[] = [];
    for await (const r of a.discover()) ids.push(r.id);
    expect(ids.sort()).toEqual([PARENT, CHILD].sort());
    expect(a.id).toBe("codex");
    const reader = a.open((await firstRef(a)) as SessionRef);
    expect(typeof reader.readIncremental).toBe("function");
    await a.dispose();
  });
});

async function firstRef(a: CodexAdapter): Promise<SessionRef | undefined> {
  for await (const r of a.discover()) return r;
  return undefined;
}

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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 구현** — `packages/adapter-claude-code/src/codex/watcher.ts`

```ts
import { EventEmitter } from "node:events";
import { promises as fs, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import { projectIdentityFromCwd, shortenWorkspace } from "@claude-monitor/core";
import { CODEX_ADAPTER_ID } from "./constants.js";
import { codexSessionIdFromPath, parseCodexMeta } from "./meta.js";

export interface CodexWatcherOptions {
  /** Absolute path to the Codex rollout root (`~/.codex/sessions`). */
  codexDir: string;
}

const LF = 0x0a;
const CHUNK = 64 * 1024;
/** The first line holds `base_instructions` (the whole system prompt) — tens
 *  of KB is normal; anything past this is not a rollout file. */
const FIRST_LINE_MAX = 8 * 1024 * 1024;

/** Read the first `\n`-terminated line of a file (without the newline). Null
 *  when the file has no complete first line yet (still being created) or the
 *  first line exceeds `maxBytes`. */
export async function readFirstLine(path: string, maxBytes = FIRST_LINE_MAX): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let pos = 0;
    while (pos < maxBytes) {
      const buf = Buffer.alloc(Math.min(CHUNK, maxBytes - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const view = buf.subarray(0, bytesRead);
      const nl = view.indexOf(LF);
      if (nl !== -1) {
        chunks.push(Buffer.from(view.subarray(0, nl)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(view));
      pos += bytesRead;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Ignore hidden segments inside the watched tree (`.DS_Store`…), judged
 *  relative to the root so the `.codex` ancestor never ignores everything. */
export function isIgnoredCodexPath(codexDir: string, p: string): boolean {
  const rel = relative(codexDir, p);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(sep).some((s) => s.startsWith("."));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function statOrNull(p: string): Promise<Stats | null> {
  return fs.stat(p).catch(() => null);
}

/**
 * Watches `<codexDir>/YYYY/MM/DD/rollout-*.jsonl`. Every rollout file is one
 * session; identity (cwd, parent thread) comes from its first line, so a file
 * whose first line is not complete yet is skipped until its next change event.
 * Codex-internal threads (guardian reviews) are never emitted.
 */
export class CodexWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly codexDir: string;

  constructor(opts: CodexWatcherOptions) {
    super();
    this.codexDir = opts.codexDir;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.codexDir, {
      depth: 3, // YYYY → MM → DD → rollout-*.jsonl
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      ignored: (p) => isIgnoredCodexPath(this.codexDir, p),
    });
    this.watcher.on("add", (path) => void this.handle(path, "added").catch(() => {}));
    this.watcher.on("change", (path) => void this.handle(path, "changed").catch(() => {}));
    this.watcher.on("unlink", (path) => this.handleUnlink(path));
    // An unhandled FSWatcher "error" would crash the whole monitor.
    this.watcher.on("error", () => {});
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  emitEvent(event: AdapterEvent): void {
    this.emit("event", event);
  }

  on(event: "event", listener: (e: AdapterEvent) => void): this {
    return super.on(event, listener);
  }

  /** Initial scan — every rollout file under YYYY/MM/DD. */
  async *scan(): AsyncIterable<SessionRef> {
    for (const y of await safeReaddir(this.codexDir)) {
      if (y.startsWith(".")) continue;
      const yDir = join(this.codexDir, y);
      if (!(await statOrNull(yDir))?.isDirectory()) continue;
      for (const m of await safeReaddir(yDir)) {
        if (m.startsWith(".")) continue;
        const mDir = join(yDir, m);
        if (!(await statOrNull(mDir))?.isDirectory()) continue;
        for (const d of await safeReaddir(mDir)) {
          if (d.startsWith(".")) continue;
          const dDir = join(mDir, d);
          if (!(await statOrNull(dDir))?.isDirectory()) continue;
          for (const f of await safeReaddir(dDir)) {
            if (!codexSessionIdFromPath(f)) continue;
            const ref = await this.refFromPath(join(dDir, f));
            if (ref) yield ref;
          }
        }
      }
    }
  }

  private async handle(path: string, kind: "added" | "changed"): Promise<void> {
    if (!codexSessionIdFromPath(path)) return;
    const ref = await this.refFromPath(path);
    if (ref) this.emitEvent({ kind, ref });
  }

  private handleUnlink(path: string): void {
    const id = codexSessionIdFromPath(path);
    if (id) this.emitEvent({ kind: "removed", refId: id });
  }

  private async refFromPath(filePath: string): Promise<SessionRef | null> {
    const id = codexSessionIdFromPath(filePath);
    if (!id) return null;
    const st = await statOrNull(filePath);
    if (!st || !st.isFile()) return null;
    const first = await readFirstLine(filePath).catch(() => null);
    if (first == null) return null;
    const meta = parseCodexMeta(first);
    if (!meta || meta.kind === "hidden") return null;
    const identity = projectIdentityFromCwd(meta.cwd);
    const ref: SessionRef = {
      id,
      adapterId: CODEX_ADAPTER_ID,
      workspace: meta.cwd,
      workspaceShort: shortenWorkspace(meta.cwd) || meta.cwd,
      projectKey: identity.key,
      projectLabel: identity.label,
      owner: identity.owner,
      source: filePath,
      mtime: Math.floor(st.mtimeMs / 1000),
    };
    if (meta.kind === "subagent" && meta.parentThreadId) ref.parentId = meta.parentThreadId;
    return ref;
  }
}
```

`packages/adapter-claude-code/src/codex/adapter.ts`:

```ts
import type { AISessionAdapter, AdapterEvent, SessionReader, SessionRef } from "@claude-monitor/core";
import type { StatusThresholds } from "@claude-monitor/core";
import { CodexReader } from "./reader.js";
import { CodexWatcher } from "./watcher.js";
import { CODEX_ADAPTER_ID, CODEX_DISPLAY, defaultCodexDir } from "./constants.js";

export interface CodexAdapterOptions {
  codexDir?: string;
  thresholds?: StatusThresholds;
}

/**
 * Exposes OpenAI Codex (CLI / Desktop) rollout threads as monitor sessions.
 * On by default — see `loadConfig().enableCodex`; a missing `~/.codex/sessions`
 * simply yields no sessions.
 */
export class CodexAdapter implements AISessionAdapter {
  readonly id = CODEX_ADAPTER_ID;
  readonly displayName = CODEX_DISPLAY;
  private readonly watcher: CodexWatcher;
  private readonly thresholds: StatusThresholds | undefined;

  constructor(opts: CodexAdapterOptions = {}) {
    this.watcher = new CodexWatcher({ codexDir: opts.codexDir ?? defaultCodexDir() });
    this.thresholds = opts.thresholds;
  }

  async *discover(): AsyncIterable<SessionRef> {
    await this.watcher.start();
    for await (const ref of this.watcher.scan()) {
      yield ref;
    }
  }

  open(ref: SessionRef): SessionReader {
    return new CodexReader(ref, this.thresholds ? { thresholds: this.thresholds } : {});
  }

  async dispose(): Promise<void> {
    await this.watcher.stop();
  }

  onChange(cb: (event: AdapterEvent) => void): () => void {
    this.watcher.on("event", cb);
    return () => {
      this.watcher.off("event", cb);
    };
  }
}
```

`packages/adapter-claude-code/src/index.ts` 끝에 추가:

```ts
export { CodexAdapter, type CodexAdapterOptions } from "./codex/adapter.js";
export { CodexReader, type CodexReaderOptions } from "./codex/reader.js";
export { CodexWatcher, isIgnoredCodexPath, readFirstLine, type CodexWatcherOptions } from "./codex/watcher.js";
export {
  codexToolDetail,
  codexTodo,
  execScriptDetail,
  foldCodex,
  initialCodex,
  isCodexHumanTurn,
  metricOf,
  usageOf,
  type CodexState,
  type CodexUsage,
} from "./codex/parser.js";
export {
  codexSessionIdFromPath,
  parseCodexMeta,
  runnerFromOriginator,
  type CodexMeta,
  type CodexThreadKind,
} from "./codex/meta.js";
export { readCodexTokenTimeline, readCodexUsageSeries } from "./codex/usage-series.js";
export { CODEX_ADAPTER_ID, CODEX_DISPLAY, defaultCodexDir } from "./codex/constants.js";
```

(`usage-series` export는 Task 5에서 파일이 생기므로, Task 4 커밋 시점엔 그 두 줄을 제외하고 Task 5에서 추가한다.)

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-watcher.test.ts`
Expected: PASS (5 tests). chokidar 이벤트 테스트는 타이밍에 민감하므로 실패 시 대기 시간을 늘려 재확인.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-claude-code/src/codex/watcher.ts packages/adapter-claude-code/src/codex/adapter.ts packages/adapter-claude-code/src/index.ts packages/adapter-claude-code/src/__tests__/codex-watcher.test.ts
git commit -m "adapter: CodexWatcher/CodexAdapter + exports"
```

---

### Task 5: usage-series (상세 추이·프로젝트 히트맵)

**Files:**
- Create: `packages/adapter-claude-code/src/codex/usage-series.ts`
- Modify: `packages/adapter-claude-code/src/index.ts` (Task 4에서 보류한 두 export 추가)
- Test: `packages/adapter-claude-code/src/__tests__/codex-usage-series.test.ts`

**Interfaces:**
- Consumes: `foldCodex`, `initialCodex` (Task 2); `UsagePoint` (`../usage-series.js`).
- Produces: `readCodexUsageSeries(source): Promise<UsagePoint[]>`, `readCodexTokenTimeline(source): Promise<UsagePoint[]>`.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCodexTokenTimeline, readCodexUsageSeries } from "../codex/usage-series.js";
import { CodexReader } from "../codex/reader.js";
import { CODEX_ADAPTER_ID } from "../codex/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "codex");
const ms = (iso: string): number => Date.parse(iso);

describe("readCodexTokenTimeline", () => {
  it("one point per token_count event with the cumulative delta; Σ equals the reader's totalTokens", async () => {
    const src = join(FIX, "codex-simple.jsonl");
    const points = await readCodexTokenTimeline(src);
    expect(points).toEqual([
      { ts: ms("2026-09-21T11:14:27.100Z"), tokens: 3608 },
      { ts: ms("2026-09-21T11:14:30.100Z"), tokens: 1892 },
      { ts: ms("2026-09-21T11:14:30.200Z"), tokens: 0 },
    ]);
    const s = await new CodexReader({ id: "x", adapterId: CODEX_ADAPTER_ID, workspace: "/w", workspaceShort: "w", projectKey: "/w", projectLabel: "w", owner: "o", source: src, mtime: 0 }).readIncremental();
    expect(points.reduce((a, p) => a + p.tokens, 0)).toBe(s.totalTokens);
    expect(points.find((p) => p.tokens > 0)!.ts).toBe((s.startSec ?? 0) * 1000);
  });

  it("excludes the parent's copied prefix in a sub-agent file", async () => {
    const points = await readCodexTokenTimeline(join(FIX, "codex-subagent.jsonl"));
    expect(points).toEqual([{ ts: ms("2026-09-21T11:20:06.000Z"), tokens: 3100 }]);
  });

  it("returns [] for a missing file", async () => {
    expect(await readCodexTokenTimeline(join(FIX, "nope.jsonl"))).toEqual([]);
  });
});

describe("readCodexUsageSeries", () => {
  it("tracks context occupancy per token_count event", async () => {
    const points = await readCodexUsageSeries(join(FIX, "codex-simple.jsonl"));
    expect(points.map((p) => p.tokens)).toEqual([13208 - 29, 13292 - 11, 13292 - 11]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code exec vitest run src/__tests__/codex-usage-series.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 구현** — `packages/adapter-claude-code/src/codex/usage-series.ts`

```ts
import { readFile } from "node:fs/promises";
import type { UsagePoint } from "../usage-series.js";
import { foldCodex, initialCodex } from "./parser.js";

const MAX_POINTS = 500;

/**
 * Walk a rollout file with the same fold the reader uses, invoking `onToken`
 * once per folded token_count event (so a sub-agent's copied parent prefix and
 * malformed lines are excluded exactly as the reader excludes them, and the
 * timeline's Σ equals the summary's totalTokens).
 */
async function walkTokenEvents(
  source: string,
  onToken: (tsMs: number, deltaTokens: number, contextTokens: number) => void,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return;
  }
  let state = initialCodex();
  let events = 0;
  let total = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      state = foldCodex(state, t);
    } catch {
      continue;
    }
    if (state.tokenEvents !== events) {
      events = state.tokenEvents;
      if (state.lastTsMs != null) onToken(state.lastTsMs, state.totalTokens - total, state.contextTokens ?? 0);
      total = state.totalTokens;
    }
  }
}

/** Context occupancy after each token_count event (session detail trend). */
export async function readCodexUsageSeries(source: string): Promise<UsagePoint[]> {
  const out: UsagePoint[] = [];
  await walkTokenEvents(source, (ts, _delta, context) => out.push({ ts, tokens: context }));
  return out.slice(-MAX_POINTS);
}

/** Tokens processed per token_count event (project activity heatmap). */
export async function readCodexTokenTimeline(source: string): Promise<UsagePoint[]> {
  const out: UsagePoint[] = [];
  await walkTokenEvents(source, (ts, delta) => out.push({ ts, tokens: delta }));
  return out;
}
```

index.ts에 `export { readCodexTokenTimeline, readCodexUsageSeries } from "./codex/usage-series.js";` 추가.

- [ ] **Step 4: 통과 확인 + 패키지 전체 테스트**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test`
Expected: 기존 + 신규 전부 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-claude-code/src/codex/usage-series.ts packages/adapter-claude-code/src/index.ts packages/adapter-claude-code/src/__tests__/codex-usage-series.test.ts
git commit -m "adapter: Codex 토큰 시계열(readCodexUsageSeries/TokenTimeline)"
```

---

### Task 7: web 배선 — config, 어댑터 등록, enrich 게이트, 시계열 분기

**Files:**
- Modify: `packages/web/lib/config.ts`
- Modify: `packages/web/lib/data-source/local.ts:11,37-49,120-140`
- Create: `packages/web/lib/token-series.ts`
- Modify: `packages/web/app/session/[id]/page.tsx:3,30`
- Modify: `packages/web/lib/project-activity.ts:1,28-35`
- Test: `packages/web/lib/__tests__/config.test.ts`, `packages/web/lib/__tests__/token-series.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter`, `CODEX_ADAPTER_ID`, `defaultCodexDir`, `readCodexUsageSeries`, `readCodexTokenTimeline` (Tasks 1·4·5).
- Produces: `AppConfig.enableCodex: boolean`, `AppConfig.codexDir: string`, `usageSeriesFor(ref)`, `tokenTimelineFor(ref)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/web/lib/__tests__/config.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";

const KEYS = ["CM_ENABLE_CODEX", "CM_CODEX_DIR"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig — Codex", () => {
  it("is on by default and points at ~/.codex/sessions", () => {
    delete process.env.CM_ENABLE_CODEX;
    delete process.env.CM_CODEX_DIR;
    const c = loadConfig();
    expect(c.enableCodex).toBe(true);
    expect(c.codexDir.endsWith("/.codex/sessions")).toBe(true);
  });
  it("CM_ENABLE_CODEX=0 turns it off; CM_CODEX_DIR overrides the root", () => {
    process.env.CM_ENABLE_CODEX = "0";
    process.env.CM_CODEX_DIR = "/tmp/codex-sessions";
    const c = loadConfig();
    expect(c.enableCodex).toBe(false);
    expect(c.codexDir).toBe("/tmp/codex-sessions");
  });
});
```

`packages/web/lib/__tests__/token-series.test.ts`:

```ts
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenTimelineFor, usageSeriesFor } from "../token-series";

const codexLines = [
  { timestamp: "2026-09-21T11:14:22.358Z", ordinal: 0, type: "session_meta", payload: { id: "t", cwd: "/w", originator: "codex_exec", cli_version: "0.154.0", source: "exec" } },
  { timestamp: "2026-09-21T11:14:27.100Z", ordinal: 1, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, model_context_window: 258400 }, rate_limits: null } },
];
const claudeLine = { type: "assistant", timestamp: "2026-09-21T11:14:27.100Z", message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 1, output_tokens: 2 }, content: [] } };

describe("token-series dispatch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-token-series-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("routes codex refs to the Codex readers", async () => {
    const f = join(dir, "rollout.jsonl");
    await fs.writeFile(f, codexLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await tokenTimelineFor({ adapterId: "codex", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 70 }]);
    expect(await usageSeriesFor({ adapterId: "codex", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 108 }]);
    // the Claude readers see no assistant records in a rollout file
    expect(await tokenTimelineFor({ adapterId: "claude-code", source: f })).toEqual([]);
  });

  it("routes other adapters to the Claude readers", async () => {
    const f = join(dir, "s.jsonl");
    await fs.writeFile(f, JSON.stringify(claudeLine) + "\n");
    expect(await tokenTimelineFor({ adapterId: "claude-code", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 8 }]);
    expect(await usageSeriesFor({ adapterId: "claude-cowork", source: f })).toEqual([{ ts: Date.parse("2026-09-21T11:14:27.100Z"), tokens: 13 }]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/web exec vitest run lib/__tests__/config.test.ts lib/__tests__/token-series.test.ts`
Expected: FAIL (`enableCodex` undefined / module not found).

- [ ] **Step 3: 구현**

`packages/web/lib/config.ts` — import 줄을 다음으로 교체:

```ts
import { defaultChatIdbDir, defaultCodexDir, defaultCoworkDir } from "@claude-monitor/adapter-claude-code";
```

`AppConfig`의 `chatIdbDir: string;` 뒤에:

```ts
  /** Expose OpenAI Codex (CLI / Desktop) rollout threads. On by default —
   *  `CM_ENABLE_CODEX=0` turns it off; a missing sessions dir just yields none. */
  enableCodex: boolean;
  /** Codex rollout root (override with `CM_CODEX_DIR`). */
  codexDir: string;
```

`loadConfig()` 반환 객체의 `chatIdbDir: …,` 뒤에:

```ts
    enableCodex: boolEnv("CM_ENABLE_CODEX", true),
    codexDir: process.env.CM_CODEX_DIR || defaultCodexDir(),
```

`packages/web/lib/data-source/local.ts`:

import 교체:

```ts
import {
  ChatAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  CoworkAdapter,
  CODEX_ADAPTER_ID,
} from "@claude-monitor/adapter-claude-code";
```

생성자에서 `new ClaudeCodeAdapter(...)` 항목 다음에:

```ts
      if (cfg.enableCodex) {
        list.push(new CodexAdapter({ codexDir: cfg.codexDir, thresholds: cfg.thresholds }));
      }
```

`enrich()`의 첫 블록을 다음으로 교체:

```ts
    // Group by the repo's origin remote URL when resolvable (unifies worktrees /
    // clones of the same repo regardless of path). cwd gone / no remote → keep
    // the reader's cwd-derived projectKey. Only adapters whose workspace is a
    // real directory (Claude Code, Codex) get the `git` spawn; cowork/chat use a
    // synthetic label, and walking up could mis-resolve against an ancestor `.git`.
    const hasRepoWorkspace = summary.ref.adapterId === "claude-code" || summary.ref.adapterId === CODEX_ADAPTER_ID;
    const remote = hasRepoWorkspace ? await remoteProject(summary.ref.workspace) : null;
    let ref: SessionRef = summary.ref;
    if (remote) {
      ref = { ...summary.ref, projectKey: remote.key, projectLabel: remote.label };
    } else if (hasRepoWorkspace) {
```

(이후 `findProjectRoot` 블록과 ps 프로브 게이트 `summary.ref.adapterId === "claude-code"`는 그대로 둔다 — Codex는 세션별 프로세스가 없다.)

`packages/web/lib/token-series.ts` (신규):

```ts
import type { SessionRef } from "@claude-monitor/core";
import {
  CODEX_ADAPTER_ID,
  readCodexTokenTimeline,
  readCodexUsageSeries,
  readTokenTimeline,
  readUsageSeries,
  type UsagePoint,
} from "@claude-monitor/adapter-claude-code";

type SeriesRef = Pick<SessionRef, "adapterId" | "source">;

/** Context-occupancy trend for the session detail page, by adapter. The Claude
 *  readers parse Claude/cowork record shapes and yield nothing for a Codex
 *  rollout file, so the dispatch is by adapterId, not by sniffing the file. */
export function usageSeriesFor(ref: SeriesRef): Promise<UsagePoint[]> {
  return ref.adapterId === CODEX_ADAPTER_ID ? readCodexUsageSeries(ref.source) : readUsageSeries(ref.source);
}

/** Tokens-processed timeline for project activity aggregation, by adapter. */
export function tokenTimelineFor(ref: SeriesRef): Promise<UsagePoint[]> {
  return ref.adapterId === CODEX_ADAPTER_ID ? readCodexTokenTimeline(ref.source) : readTokenTimeline(ref.source);
}
```

`packages/web/app/session/[id]/page.tsx`: 3행 `import { readUsageSeries } from "@claude-monitor/adapter-claude-code";` → `import { usageSeriesFor } from "../../../lib/token-series";`, 30행 `const series = await readUsageSeries(s.ref.source);` → `const series = await usageSeriesFor(s.ref);`.

`packages/web/lib/project-activity.ts`: 1행 `import { readTokenTimeline } from "@claude-monitor/adapter-claude-code";` → `import { tokenTimelineFor } from "./token-series";`, 그리고

```ts
  const sources = [...new Set(sessions.map((s) => s.ref.source))];
```

→

```ts
  // One read per transcript file (roots + sub-agents may share none, but a
  // session's ref is what picks the adapter-specific reader).
  const byPath = new Map<string, (typeof sessions)[number]["ref"]>();
  for (const s of sessions) if (!byPath.has(s.ref.source)) byPath.set(s.ref.source, s.ref);
```

```ts
  for (const src of sources) {
    const events = await readTokenTimeline(src);
```

→

```ts
  for (const ref of byPath.values()) {
    const events = await tokenTimelineFor(ref);
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code build && pnpm --filter @claude-monitor/web test`
Expected: 신규 2개 파일 포함 전부 PASS. (web 테스트가 어댑터 패키지의 `dist`를 import하므로 어댑터 build가 선행되어야 한다.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/config.ts packages/web/lib/data-source/local.ts packages/web/lib/token-series.ts "packages/web/app/session/[id]/page.tsx" packages/web/lib/project-activity.ts packages/web/lib/__tests__/config.test.ts packages/web/lib/__tests__/token-series.test.ts
git commit -m "web: Codex 어댑터 등록(CM_ENABLE_CODEX/CM_CODEX_DIR) + git 그룹핑·토큰 시계열 분기"
```

---

### Task 8: README

**Files:**
- Modify: `README.md:135` 뒤(설정표), `README.md:145` 뒤(참고 문단), `README.md:322-326`(아키텍처), `README.md:347`(레포 구조), `README.md:358`(API adapter 값)

- [ ] **Step 1: 설정표에 두 행 추가** (`CM_CHAT_IDB_DIR` 행 다음)

```markdown
| `CM_ENABLE_CODEX` | OpenAI **Codex**(CLI·Desktop) 세션을 목록에 노출. `0`/`false`/`no`/`off`면 꺼짐 | 미설정 → `true` (켜짐) |
| `CM_CODEX_DIR` | Codex rollout 로그 루트(`YYYY/MM/DD/rollout-*.jsonl`) | `$HOME/.codex/sessions` |
```

- [ ] **Step 2: 참고 문단 추가** (`CM_ENABLE_CHAT` 참고 문단 다음, 같은 `>` 인용 블록 스타일)

```markdown
>
> 참고 (`CM_ENABLE_CODEX`): `~/.codex/sessions`의 rollout JSONL을 읽어 Codex 세션을 **Claude Code 세션과 같은 프로젝트 그룹**에 표시합니다(cwd의 git remote 기준 통합). 러너 배지는 `Codex`(CLI/`codex exec`) 또는 `Codex Desktop`입니다. Codex가 `spawn_agent`로 띄운 하위 스레드는 부모 카드 아래 하위 에이전트로 나오고, Codex 내부 승인 검토(guardian) 스레드는 표시하지 않습니다. 컨텍스트 압축 뒤 이어지는 새 창 파일(`…_<window>.jsonl`)은 별도 세션으로 표시됩니다. 스레드별 프로세스가 없어 Kill 버튼은 제공되지 않으며, 토큰 수치는 Claude와 같은 기준(비캐시 입력 + 출력)으로 집계되어 Codex 자체 합계(캐시 포함)와 다릅니다. Codex 토큰은 상단 Claude 사용량 게이지(5시간/7일)에는 합산되지 않습니다.
```

- [ ] **Step 3: 아키텍처 문단 수정**

`- \`@claude-monitor/adapter-claude-code\` — …` 항목을 다음으로 교체:

```markdown
- `@claude-monitor/adapter-claude-code` — `~/.claude/projects/`의 JSONL 트랜스크립트를 읽고, chokidar로 파일을 감시(top-level + 하위 에이전트 디렉터리)하는 어댑터. 같은 패키지에 Claude Desktop cowork(`cowork/`), claude.ai chat(`chat/`), OpenAI Codex rollout(`codex/`) 어댑터가 함께 있다.
```

레포 구조의 `adapter-claude-code/   JSONL 파서·증분 tail 리더·chokidar 와처` 줄을:

```
  adapter-claude-code/   JSONL 파서·증분 tail 리더·chokidar 와처 (+ cowork/ chat/ codex/ 어댑터)
```

API 표의 `GET /api/sessions/[id]` 행 설명 `쿼리 \`adapter\`(기본 \`claude-code\`)`를 `쿼리 \`adapter\`(기본 \`claude-code\`; \`codex\`, \`claude-cowork\`, \`claude-chat\`)`로.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README에 Codex 어댑터 설정·동작 추가"
```

---

### Task 9: 전체 빌드·테스트·실기 확인

- [ ] **Step 1: 라이브 서버 확인**

Run: `lsof -nP -iTCP:11314 -sTCP:LISTEN`
Expected: 출력 없음. (있으면 `next build` 금지 — 사용자에게 보고.)

- [ ] **Step 2: 전체 빌드·테스트**

Run: `pnpm -r build && pnpm -r test`
Expected: 3개 패키지 build 성공, 테스트 전부 PASS.

- [ ] **Step 3: 실기 확인 (dev 서버, 다른 포트)**

Run: `cd packages/web && PORT=11399 npx next dev -H 127.0.0.1 -p 11399` (백그라운드) 후
`curl -s 'http://127.0.0.1:11399/api/sessions?all=1' | python3 -c 'import sys,json; d=json.load(sys.stdin); ss=[s for p in d["projects"] for s in p["sessions"] if s["ref"]["adapterId"]=="codex"]; print(len(ss)); [print(s["ref"]["projectLabel"], s["runner"], s["status"], s["model"], (s["firstPrompt"] or "")[:40]) for s in ss[:10]]'`
Expected: Codex 세션 수 > 0, 러너 `codex`/`codex-desktop`, 프로젝트 라벨이 cwd/remote 기준. `children`에 parentId가 있는 Codex 하위 스레드 존재.
그리고 `curl -s 'http://127.0.0.1:11399/session/<id>?adapter=codex' | grep -c 'Codex'` > 0.
확인 후 dev 서버 종료.

- [ ] **Step 4: 최종 커밋 여부 확인**

Run: `git status --short`
Expected: 비어 있음(모든 변경이 커밋됨).
