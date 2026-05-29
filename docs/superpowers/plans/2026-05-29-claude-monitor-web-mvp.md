# claude-monitor Web UI 확장 MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 세션 대시보드(Web)에 프로젝트 통합·그룹 토글·러너/모델/모드/컨텍스트% 표시·로컬 세션 kill·세션 상세(usage 추이)를 추가해 동료가 설치해 쓸 수 있는 기능형 MVP를 만든다.

**Architecture:** core(타입+순수 util) → adapter-claude-code(transcript 파서/리더) → web(LocalDataSource + Next.js App Router + SSE). 신규 메타데이터는 파서가 transcript 최상위 필드(`cwd`/`gitBranch`/`version`/`permissionMode`/`message.model`/`message.usage`)에서 흡수하고, 러너·PID·컨텍스트 한도는 `ps` 프로세스 프로브가 보강한다. projectKey/owner는 **반드시 transcript `cwd`** 에서 계산한다(decoded 디렉토리명은 비단사라 깨짐). Kill만 write 경로.

**Tech Stack:** TypeScript(ESM, NodeNext), pnpm monorepo, vitest, Next.js 14 App Router, React 18, zustand, Tailwind, lucide-react, Node `child_process`(ps).

> **패키지별 import 규약 (반드시 준수):** `packages/core`·`packages/adapter-claude-code`는 상대 import에 `.js` 확장자 필수(NodeNext). `packages/web`은 Next 번들러 — 확장자 없음. 테스트는 `src/**/__tests__/**/*.test.ts`(vitest).

> **참조 스펙:** `docs/superpowers/specs/2026-05-29-claude-monitor-web-mvp-design.md`

---

## Shared Contract (모든 Task가 참조하는 타입·시그니처)

아래는 Phase 1에서 생성/확장되며, 이후 모든 Phase가 이 이름·시그니처를 그대로 사용한다.

```ts
// @claude-monitor/core  (types/session.ts)
export type RunnerKind = "conductor" | "claude-code" | "claude-desktop" | "unknown";
export interface ContextUsage { tokens: number; limit: number; pct: number; }

// SessionRef += 다음 3개 (필수)
//   projectKey: string;     // 통합 키 (cwd서 파생)
//   projectLabel: string;   // 표시명
//   owner: string;          // OS 유저 (장래 팀)
// SessionSummary += 다음 6개 (필수)
//   runner: RunnerKind;
//   model: string | null;
//   mode: string | null;       // = permissionMode
//   version: string | null;
//   context: ContextUsage | null;
//   pid: number | null;        // 존재 시 kill 가능(로컬)

// @claude-monitor/core  (util/project-key.ts)
export interface ProjectIdentity { key: string; label: string; owner: string; }
export function projectIdentityFromCwd(cwd: string): ProjectIdentity;

// @claude-monitor/core  (util/context-limit.ts)
export function contextLimitForModel(model: string | null | undefined): number; // 기본 200_000
export function computeContext(tokens: number, limit: number): ContextUsage;

// @claude-monitor/adapter-claude-code (parser.ts)
export function usageContextTokens(u: Record<string, unknown>): number;
// ParserState += cwd, gitBranch, version, entrypoint, mode, model, contextTokens (모두 nullable)

// packages/web/lib/process-probe.ts
export interface ProbeEntry { sessionId: string; pid: number; runner: RunnerKind; contextLimit: number | null; }
export function classifyRunner(command: string): RunnerKind;
export function sessionIdFromCommand(command: string): string | null;
export function contextLimitFromCommand(command: string): number | null;
export function parsePsOutput(text: string): ProbeEntry[];
export function probeProcesses(opts?: { force?: boolean; now?: number }): Promise<Map<string, ProbeEntry>>;

// packages/web/lib/filter.ts
export function globToRegExp(g: string): RegExp;
export interface FilterOpts { maxAgeHours: number | null; all: boolean; filterGlob: string | null; now: number; }
export function sessionMatches(s: SessionSummary, o: FilterOpts): boolean;

// packages/web/lib/process-kill.ts
export interface KillResult { ok: boolean; reason?: string }
export function verifyKillTarget(command: string, sessionId: string): boolean;
export function killSession(sessionId: string): Promise<KillResult>;

// packages/web 그룹 데이터 형태 (page.tsx / api / Dashboard / ProjectGroup 공통)
interface ProjectGroupData { projectKey: string; projectLabel: string; sessions: SessionSummary[] }
```

---

## Phase 1 — 데이터 모델 + 파서 보강 + 순수 util

### Task 1: core 타입 확장 (RunnerKind, ContextUsage, SessionRef/SessionSummary 필드)

**Files:**
- Modify: `packages/core/src/types/session.ts`

- [ ] **Step 1: 타입 추가/확장**

`packages/core/src/types/session.ts` 상단(`SessionStatus` 아래)에 추가:

```ts
export type RunnerKind = "conductor" | "claude-code" | "claude-desktop" | "unknown";

export interface ContextUsage {
  /** 추정 컨텍스트 점유 토큰 (input + cache_read + cache_creation) */
  tokens: number;
  /** 모델 컨텍스트 윈도우 한도 */
  limit: number;
  /** tokens / limit, 0..1 (clamp) */
  pct: number;
}
```

`SessionRef`에 3필드 추가:

```ts
export interface SessionRef {
  id: string;
  adapterId: string;
  workspace: string;
  workspaceShort: string;
  /** 통합 키 — transcript cwd서 파생 (decoded dir 아님) */
  projectKey: string;
  /** 표시명 */
  projectLabel: string;
  /** OS 유저 (장래 팀 그룹용) */
  owner: string;
  source: string;
  mtime: number;
}
```

`SessionSummary`에 6필드 추가:

```ts
export interface SessionSummary {
  ref: SessionRef;
  status: SessionStatus;
  lastTool: string | null;
  pendingSubagents: PendingSubagent[];
  todo: TodoSnapshot | null;
  lastText: string | null;
  /** 세션 실행 러너 (프로세스 프로브서 보강; 기본 unknown) */
  runner: RunnerKind;
  /** 사용 모델 (<synthetic> 제외) */
  model: string | null;
  /** permissionMode */
  mode: string | null;
  /** Claude Code 버전 */
  version: string | null;
  /** 컨텍스트 사용량 */
  context: ContextUsage | null;
  /** 실행 프로세스 PID (존재 시 kill 가능) */
  pid: number | null;
  updatedAt: number;
}
```

- [ ] **Step 2: 컴파일 확인 (이 시점엔 실패 예상 — 생성처가 새 필드 미설정)**

Run: `pnpm --filter @claude-monitor/core build`
Expected: FAIL — `SessionRef`/`SessionSummary` 리터럴이 새 필수 필드 누락. (Task 2~5에서 해소.) 진행.

### Task 2: project-key util (cwd → projectKey/label/owner)

**Files:**
- Create: `packages/core/src/util/project-key.ts`
- Test: `packages/core/src/__tests__/project-key.test.ts`
- Modify: `packages/core/src/util/index.ts`

- [ ] **Step 1: 실패 테스트 작성**

`packages/core/src/__tests__/project-key.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { projectIdentityFromCwd } from "../util/project-key.js";

describe("projectIdentityFromCwd", () => {
  it("conductor 형제 worktree를 같은 키로 묶고 하이픈 보존", () => {
    const a = projectIdentityFromCwd("/Users/Nexist/conductor/workspaces/260507_gstack-ui/edinburgh");
    const b = projectIdentityFromCwd("/Users/Nexist/conductor/workspaces/260507_gstack-ui/lisbon");
    expect(a.key).toBe("conductor/260507_gstack-ui");
    expect(a.label).toBe("260507_gstack-ui");
    expect(a.key).toBe(b.key);
    expect(a.owner).toBe("Nexist");
  });

  it(".worktrees 형제를 repo 루트로 묶음", () => {
    const id = projectIdentityFromCwd("/Users/kim/repo/.worktrees/budapest");
    expect(id.key).toBe("/Users/kim/repo");
    expect(id.label).toBe("repo");
    expect(id.owner).toBe("kim");
  });

  it("평범 repo는 전체 cwd를 키로 (오병합 방지)", () => {
    const id = projectIdentityFromCwd("/Users/kim/projects/claude-monitor");
    expect(id.key).toBe("/Users/kim/projects/claude-monitor");
    expect(id.label).toBe("claude-monitor");
  });

  it("/Users 밖 경로는 owner unknown", () => {
    const id = projectIdentityFromCwd("/tmp/foo/bar");
    expect(id.owner).toBe("unknown");
    expect(id.label).toBe("bar");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/core test -- project-key`
Expected: FAIL — `project-key.js` 없음.

- [ ] **Step 3: 구현**

`packages/core/src/util/project-key.ts`:

```ts
export interface ProjectIdentity {
  key: string;
  label: string;
  owner: string;
}

const HOME_RE = /^\/Users\/([^/]+)(?:\/|$)/;
const CONDUCTOR_RE = /\/conductor\/workspaces\/([^/]+)\/[^/]+\/?$/;
const WORKTREE_RE = /^(.*)\/\.worktrees\/[^/]+\/?$/;

export function projectIdentityFromCwd(cwd: string): ProjectIdentity {
  const owner = ownerFromPath(cwd);

  const cm = cwd.match(CONDUCTOR_RE);
  if (cm) return { key: `conductor/${cm[1]}`, label: cm[1]!, owner };

  const wm = cwd.match(WORKTREE_RE);
  if (wm) {
    const repo = stripTrailingSlash(wm[1]!);
    return { key: repo, label: basename(repo), owner };
  }

  const key = stripTrailingSlash(cwd);
  return { key, label: basename(key), owner };
}

function ownerFromPath(p: string): string {
  const m = p.match(HOME_RE);
  return m ? m[1]! : "unknown";
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

function basename(p: string): string {
  const t = stripTrailingSlash(p);
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}
```

- [ ] **Step 4: util/index.ts에 export 추가**

`packages/core/src/util/index.ts` 끝에:

```ts
export * from "./project-key.js";
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @claude-monitor/core test -- project-key`
Expected: PASS (4 tests).

- [ ] **Step 6: 커밋**

```bash
git add packages/core/src/util/project-key.ts packages/core/src/util/index.ts packages/core/src/__tests__/project-key.test.ts
git commit -m "feat(core): projectIdentityFromCwd — cwd 기반 프로젝트 통합 키"
```

### Task 3: context-limit util

**Files:**
- Create: `packages/core/src/util/context-limit.ts`
- Test: `packages/core/src/__tests__/context-limit.test.ts`
- Modify: `packages/core/src/util/index.ts`

- [ ] **Step 1: 실패 테스트**

`packages/core/src/__tests__/context-limit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { contextLimitForModel, computeContext } from "../util/context-limit.js";

describe("context-limit", () => {
  it("기본 한도 200k", () => {
    expect(contextLimitForModel("claude-opus-4-8")).toBe(200_000);
    expect(contextLimitForModel(null)).toBe(200_000);
  });

  it("computeContext는 pct를 0..1로 clamp", () => {
    expect(computeContext(50_000, 200_000)).toEqual({ tokens: 50_000, limit: 200_000, pct: 0.25 });
    expect(computeContext(300_000, 200_000).pct).toBe(1);
    expect(computeContext(10, 0).pct).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/core test -- context-limit`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`packages/core/src/util/context-limit.ts`:

```ts
import type { ContextUsage } from "../types/session.js";

const DEFAULT_LIMIT = 200_000;

/**
 * 모델명만으로는 1M 여부를 알 수 없다(transcript model엔 [1m] 접미사 없음).
 * 1M 감지는 프로세스 프로브의 --model 인자에서 별도 수행한다.
 */
export function contextLimitForModel(_model: string | null | undefined): number {
  return DEFAULT_LIMIT;
}

export function computeContext(tokens: number, limit: number): ContextUsage {
  const pct = limit > 0 ? Math.min(1, Math.max(0, tokens / limit)) : 0;
  return { tokens, limit, pct };
}
```

- [ ] **Step 4: export 추가**

`packages/core/src/util/index.ts` 끝에:

```ts
export * from "./context-limit.js";
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @claude-monitor/core test -- context-limit`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add packages/core/src/util/context-limit.ts packages/core/src/util/index.ts packages/core/src/__tests__/context-limit.test.ts
git commit -m "feat(core): context-limit util (기본 200k + pct 계산)"
```

### Task 4: 파서 보강 (cwd/git/version/mode/model/usage 흡수)

**Files:**
- Modify: `packages/adapter-claude-code/src/parser.ts`
- Test: `packages/adapter-claude-code/src/__tests__/parser.test.ts`
- Modify: `packages/adapter-claude-code/src/index.ts`

- [ ] **Step 1: 실패 테스트 추가**

`packages/adapter-claude-code/src/__tests__/parser.test.ts`에 `describe` 블록 추가:

```ts
import { fold, initial, usageContextTokens } from "../parser.js";

describe("parser metadata enrichment", () => {
  it("최상위 cwd/gitBranch/version/permissionMode를 흡수", () => {
    let s = initial();
    s = fold(s, JSON.stringify({
      type: "assistant",
      cwd: "/Users/x/conductor/workspaces/proj/edinburgh",
      gitBranch: "feature-1",
      version: "2.1.156",
      permissionMode: "plan",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 9 }, content: [] },
    }));
    expect(s.cwd).toBe("/Users/x/conductor/workspaces/proj/edinburgh");
    expect(s.gitBranch).toBe("feature-1");
    expect(s.version).toBe("2.1.156");
    expect(s.mode).toBe("plan");
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.contextTokens).toBe(110);
  });

  it("<synthetic> 모델은 무시", () => {
    let s = initial();
    s = fold(s, JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", content: [] } }));
    s = fold(s, JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }));
    expect(s.model).toBe("claude-opus-4-8");
  });

  it("usageContextTokens는 누락 필드를 0으로", () => {
    expect(usageContextTokens({ input_tokens: 5 })).toBe(5);
    expect(usageContextTokens({})).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test -- parser`
Expected: FAIL — `s.cwd` 등 undefined, `usageContextTokens` 미export.

- [ ] **Step 3: ParserState/ParsedLine 확장 + initial 갱신**

`packages/adapter-claude-code/src/parser.ts`의 `ParserState`에 필드 추가:

```ts
export interface ParserState {
  lastToolName: string | null;
  toolCallsById: Map<string, { name: string; desc: string }>;
  resolvedToolIds: Set<string>;
  lastTodos: TodoItem[] | null;
  lastText: string | null;
  byteOffset: number;
  // --- metadata enrichment ---
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  entrypoint: string | null;
  mode: string | null;
  model: string | null;
  contextTokens: number | null;
}
```

`initial()`의 return에 추가:

```ts
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    mode: null,
    model: null,
    contextTokens: null,
```

`ParsedLine` 인터페이스를 확장:

```ts
export interface ParsedLine {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  permissionMode?: string;
  message?: {
    model?: string;
    usage?: Record<string, unknown>;
    content?: Array<Record<string, unknown>>;
  };
}
```

- [ ] **Step 4: fold()에 메타 흡수 + usageContextTokens 추가**

`fold()`의 `const content = ...` 직후(`if (obj?.type === "assistant")` 위)에:

```ts
  if (typeof obj.cwd === "string") state.cwd = obj.cwd;
  if (typeof obj.gitBranch === "string") state.gitBranch = obj.gitBranch;
  if (typeof obj.version === "string") state.version = obj.version;
  if (typeof obj.entrypoint === "string") state.entrypoint = obj.entrypoint;
  if (typeof obj.permissionMode === "string") state.mode = obj.permissionMode;

  const msg = obj.message;
  if (msg) {
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") state.model = msg.model;
    if (msg.usage) state.contextTokens = usageContextTokens(msg.usage);
  }
```

파일 끝에 helper 추가:

```ts
export function usageContextTokens(u: Record<string, unknown>): number {
  const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
}
```

- [ ] **Step 5: index.ts에 usageContextTokens export**

`packages/adapter-claude-code/src/index.ts`의 parser export 라인을 교체:

```ts
export { fold, initial, pendingSubagents, summarizeTodos, usageContextTokens, type ParserState } from "./parser.js";
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test -- parser`
Expected: PASS (기존 + 신규 3 tests).

- [ ] **Step 7: 커밋**

```bash
git add packages/adapter-claude-code/src/parser.ts packages/adapter-claude-code/src/index.ts packages/adapter-claude-code/src/__tests__/parser.test.ts
git commit -m "feat(adapter): 파서가 cwd/git/version/mode/model/usage 흡수"
```

### Task 5: reader가 enriched summary 조립 + cwd로 ref 정정

**Files:**
- Modify: `packages/adapter-claude-code/src/reader.ts`
- Test: `packages/adapter-claude-code/src/__tests__/reader.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

기존 reader 테스트는 fixture JSONL을 읽는다. fixture에 메타 줄이 없을 수 있으니, **새 fixture**를 만들어 검증한다.

Create `packages/adapter-claude-code/src/__tests__/fixtures/enriched.jsonl`:

```
{"type":"assistant","cwd":"/Users/kim/conductor/workspaces/proj-x/lisbon","gitBranch":"main","version":"2.1.156","permissionMode":"acceptEdits","message":{"model":"claude-opus-4-8","usage":{"input_tokens":2,"cache_read_input_tokens":98,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"hello"}]}}
```

`reader.test.ts`에 추가:

```ts
import { join } from "node:path";

it("cwd로 ref(projectKey/label/owner/workspace)를 정정하고 메타를 채운다", async () => {
  const src = join(__dirname, "fixtures", "enriched.jsonl");
  const ref = {
    id: "s1", adapterId: "claude-code",
    workspace: "/wrong/decoded", workspaceShort: "wrong",
    projectKey: "tmp", projectLabel: "tmp", owner: "tmp",
    source: src, mtime: 0,
  };
  const reader = new ClaudeCodeReader(ref);
  const sum = await reader.readIncremental();
  expect(sum.ref.workspace).toBe("/Users/kim/conductor/workspaces/proj-x/lisbon");
  expect(sum.ref.projectKey).toBe("conductor/proj-x");
  expect(sum.ref.projectLabel).toBe("proj-x");
  expect(sum.ref.owner).toBe("kim");
  expect(sum.model).toBe("claude-opus-4-8");
  expect(sum.mode).toBe("acceptEdits");
  expect(sum.version).toBe("2.1.156");
  expect(sum.context).toEqual({ tokens: 100, limit: 200_000, pct: 100 / 200_000 });
  expect(sum.runner).toBe("unknown");
  expect(sum.pid).toBeNull();
});
```

> 기존 reader 테스트가 `SessionRef` 리터럴을 만든다면, 새 필수 필드(projectKey/projectLabel/owner)를 추가해 컴파일을 맞춘다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test -- reader`
Expected: FAIL — summary에 신규 필드 없음/ref 미정정.

- [ ] **Step 3: reader.ts import + summary 조립 수정**

import에 추가:

```ts
import { shortenWorkspace, projectIdentityFromCwd, contextLimitForModel, computeContext } from "@claude-monitor/core";
```

`readIncremental()`의 `const summary: SessionSummary = {...}` 블록을 교체:

```ts
    const now = Math.floor(Date.now() / 1000);

    // cwd가 있으면 lossy decoded ref를 정정
    const cwd = this.state.cwd;
    const baseRef = cwd
      ? (() => {
          const id = projectIdentityFromCwd(cwd);
          return {
            ...this.ref,
            workspace: cwd,
            workspaceShort: shortenWorkspace(cwd) || cwd,
            projectKey: id.key,
            projectLabel: id.label,
            owner: id.owner,
            mtime: mtimeSec,
          };
        })()
      : { ...this.ref, mtime: mtimeSec };

    const limit = contextLimitForModel(this.state.model);
    const context =
      this.state.contextTokens != null ? computeContext(this.state.contextTokens, limit) : null;

    const summary: SessionSummary = {
      ref: baseRef,
      status: statusFromMtime(mtimeSec, now, this.thresholds),
      lastTool: this.state.lastToolName,
      pendingSubagents: pendingSubagents(this.state),
      todo: summarizeTodos(this.state.lastTodos),
      lastText: this.state.lastText,
      runner: "unknown",
      model: this.state.model,
      mode: this.state.mode,
      version: this.state.version,
      context,
      pid: null,
      updatedAt: now,
    };
    this.cached = summary;
    return summary;
```

- [ ] **Step 4: watcher.refFromPath에 임시 projectKey/label/owner 채우기 (컴파일)**

`packages/adapter-claude-code/src/watcher.ts`의 `refFromPath` return을 수정 (import에 `projectIdentityFromCwd` 추가):

```ts
import { decodePath, shortenWorkspace, projectIdentityFromCwd } from "@claude-monitor/core";
```

```ts
    const workspace = decodePath(workspaceEncoded);
    const provisional = projectIdentityFromCwd(workspace); // 임시 — reader가 cwd로 정정
    return {
      id,
      adapterId: "claude-code",
      workspace,
      workspaceShort: shortenWorkspace(workspace) || workspace,
      projectKey: provisional.key,
      projectLabel: provisional.label,
      owner: provisional.owner,
      source: filePath,
      mtime: Math.floor(st.mtimeMs / 1000),
    };
```

- [ ] **Step 5: 통과 확인 + 전체 빌드**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test`
Expected: PASS.

Run: `pnpm --filter @claude-monitor/core build && pnpm --filter @claude-monitor/adapter-claude-code build`
Expected: 둘 다 성공 (Task 1 컴파일 캐스케이드 해소됨).

- [ ] **Step 6: 커밋**

```bash
git add packages/adapter-claude-code/src/reader.ts packages/adapter-claude-code/src/watcher.ts packages/adapter-claude-code/src/__tests__/reader.test.ts packages/adapter-claude-code/src/__tests__/fixtures/enriched.jsonl
git commit -m "feat(adapter): reader가 cwd로 ref 정정 + 메타/컨텍스트 채움"
```

---

## Phase 2 — 프로세스 프로브 (러너·PID·컨텍스트 한도)

### Task 6: process-probe 순수 파서

**Files:**
- Create: `packages/web/lib/process-probe.ts`
- Test: `packages/web/lib/__tests__/process-probe.test.ts`
- Create: `packages/web/vitest.config.ts`
- Modify: `packages/web/package.json`

- [ ] **Step 1: web에 vitest 추가**

`packages/web/package.json`의 `devDependencies`에 추가, `scripts`에 `test` 추가:

```jsonc
  "scripts": {
    "dev": "next dev -H 127.0.0.1 -p 11314",
    "build": "next build",
    "start": "next start -H 127.0.0.1 -p 11314",
    "lint": "next lint",
    "test": "vitest run"
  },
  // devDependencies에:
    "vitest": "^2.0.0"
```

Create `packages/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
```

Run: `pnpm install`
Expected: vitest 설치 성공.

- [ ] **Step 2: 실패 테스트 작성**

`packages/web/lib/__tests__/process-probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  classifyRunner,
  sessionIdFromCommand,
  contextLimitFromCommand,
  parsePsOutput,
} from "../process-probe";

const CONDUCTOR = "/Users/x/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.154/claude --resume 5a62fd30-6190-43e8-bf6a-bbbd8c8461f5 --model claude-opus-4-8[1m]";
const CASK = "/opt/homebrew/Caskroom/claude-code/2.1.145/claude --session-id 2f794145-3d65-414c-871d-469420887642 --model opus";
const DESKTOP = "/Applications/Claude.app/Contents/Helpers/x /Users/x/Library/Application Support/Claude/claude-code/2.1.156/claude.app/Contents/MacOS/claude --resume 163f7e2e-aad9-4dad-93f5-c304a8f1d986";

describe("process-probe parsing", () => {
  it("러너 분류", () => {
    expect(classifyRunner(CONDUCTOR)).toBe("conductor");
    expect(classifyRunner(CASK)).toBe("claude-code");
    expect(classifyRunner(DESKTOP)).toBe("claude-desktop");
    expect(classifyRunner("/usr/bin/python foo")).toBe("unknown");
  });

  it("sessionId 추출 (--resume / --session-id)", () => {
    expect(sessionIdFromCommand(CONDUCTOR)).toBe("5a62fd30-6190-43e8-bf6a-bbbd8c8461f5");
    expect(sessionIdFromCommand(CASK)).toBe("2f794145-3d65-414c-871d-469420887642");
    expect(sessionIdFromCommand("claude --foo")).toBeNull();
  });

  it("컨텍스트 한도는 [1m]만 1M, 아니면 null", () => {
    expect(contextLimitFromCommand(CONDUCTOR)).toBe(1_000_000);
    expect(contextLimitFromCommand(CASK)).toBeNull();
  });

  it("parsePsOutput: pid+sessionId 행만 추출, claude 아닌 행 제외", () => {
    const text = [
      ` 2881 ${CONDUCTOR}`,
      `10288 /opt/homebrew/Cellar/php/8.5.6/bin/php -S localhost:8082`,
      ` 6615 ${CASK}`,
    ].join("\n");
    const entries = parsePsOutput(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ sessionId: "5a62fd30-6190-43e8-bf6a-bbbd8c8461f5", pid: 2881, runner: "conductor", contextLimit: 1_000_000 });
    expect(entries[1].pid).toBe(6615);
    expect(entries[1].contextLimit).toBeNull();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @claude-monitor/web test -- process-probe`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`packages/web/lib/process-probe.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerKind } from "@claude-monitor/core";

const pexec = promisify(exec);
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export interface ProbeEntry {
  sessionId: string;
  pid: number;
  runner: RunnerKind;
  contextLimit: number | null;
}

export function classifyRunner(command: string): RunnerKind {
  if (command.includes("com.conductor.app")) return "conductor";
  if (command.includes("/Claude.app/")) return "claude-desktop";
  if (command.includes("Caskroom/claude-code")) return "claude-code";
  if (/(^|\/)claude(\s|$)/.test(command)) return "claude-code";
  return "unknown";
}

export function sessionIdFromCommand(command: string): string | null {
  const m = command.match(new RegExp(`--(?:resume|session-id)[ =](${UUID})`));
  return m ? m[1]! : null;
}

export function contextLimitFromCommand(command: string): number | null {
  const m = command.match(/--model[ =](\S+)/);
  if (m && /\[1m\]/i.test(m[1]!)) return 1_000_000;
  return null;
}

export function parsePsOutput(text: string): ProbeEntry[] {
  const out: ProbeEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const command = m[2]!;
    const sessionId = sessionIdFromCommand(command);
    if (!sessionId) continue;
    out.push({
      sessionId,
      pid: Number(m[1]),
      runner: classifyRunner(command),
      contextLimit: contextLimitFromCommand(command),
    });
  }
  return out;
}

let cache: { at: number; map: Map<string, ProbeEntry> } | null = null;
const TTL_MS = 4000;

export async function probeProcesses(
  opts: { force?: boolean; now?: number } = {},
): Promise<Map<string, ProbeEntry>> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < TTL_MS) return cache.map;
  const map = new Map<string, ProbeEntry>();
  try {
    const { stdout } = await pexec("ps -eo pid=,command=", { maxBuffer: 16 * 1024 * 1024 });
    for (const e of parsePsOutput(stdout)) map.set(e.sessionId, e);
  } catch {
    // ps 실패 시 빈 맵 (프로브 없음 = pid/runner 미보강, 치명적 아님)
  }
  cache = { at: now, map };
  return map;
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @claude-monitor/web test -- process-probe`
Expected: PASS (4 tests).

- [ ] **Step 6: 커밋**

```bash
git add packages/web/lib/process-probe.ts packages/web/lib/__tests__/process-probe.test.ts packages/web/vitest.config.ts packages/web/package.json pnpm-lock.yaml
git commit -m "feat(web): 프로세스 프로브 (ps→sessionId/pid/runner/한도) + web vitest"
```

### Task 7: LocalDataSource가 프로브를 summary에 병합

**Files:**
- Modify: `packages/web/lib/data-source/local.ts`

- [ ] **Step 1: import + enrich 메서드 추가**

`local.ts` import에 추가:

```ts
import { computeContext } from "@claude-monitor/core";
import { probeProcesses } from "../process-probe";
```

`LocalDataSource` 클래스 안(`private async runDiscover` 위 등)에 메서드 추가:

```ts
  private async enrich(summary: SessionSummary): Promise<SessionSummary> {
    const probe = await probeProcesses();
    const e = probe.get(summary.ref.id);
    if (!e) return summary;
    const limit = e.contextLimit ?? summary.context?.limit ?? null;
    const context =
      summary.context && limit ? computeContext(summary.context.tokens, limit) : summary.context;
    return { ...summary, runner: e.runner, pid: e.pid, context };
  }
```

- [ ] **Step 2: enrich를 4개 지점에 적용**

`snapshot()`:

```ts
  async snapshot(): Promise<SessionSummary[]> {
    await this.ensureDiscovered();
    const raw = [...this.entries.values()]
      .map((e) => e.lastSummary)
      .filter((s): s is SessionSummary => Boolean(s));
    return Promise.all(raw.map((s) => this.enrich(s)));
  }
```

`getById()`의 `return fresh;`를:

```ts
    const enriched = await this.enrich(fresh);
    e.lastSummary = enriched;
    return enriched;
```
(위 `e.lastSummary = fresh;` 줄 제거하고 위로 합침.)

`runDiscover()` 프라이밍 루프:

```ts
      try {
        const fresh = await entry.reader.readIncremental();
        entry.lastSummary = await this.enrich(fresh);
      } catch {
        // ignore per-file failure
      }
```

`scheduleFlush()`의 setTimeout 콜백:

```ts
      try {
        const summary = await entry.reader.readIncremental();
        const enriched = await this.enrich(summary);
        entry.lastSummary = enriched;
        getHub().publish({ kind: "summary", data: enriched });
      } catch {
        // Ignore — next tick will retry on the next change.
      }
```

- [ ] **Step 3: 빌드 확인**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공 (타입 OK).

- [ ] **Step 4: 실세션 PID 매칭 수동 확인**

Run:
```bash
pnpm --filter @claude-monitor/web dev &
sleep 5
curl -s http://127.0.0.1:11314/api/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print([(s['ref']['projectLabel'], s.get('runner'), s.get('pid'), (s.get('context') or {}).get('pct')) for p in d['projects'] for s in p['sessions']][:8])"
kill %1
```
Expected: 실행 중 세션은 `runner`가 conductor/claude-code/claude-desktop, `pid`가 숫자. 동일 프로젝트의 worktree들이 하나의 `projectLabel`로 묶임.

- [ ] **Step 5: 커밋**

```bash
git add packages/web/lib/data-source/local.ts
git commit -m "feat(web): LocalDataSource가 프로브로 runner/pid/컨텍스트한도 병합"
```

---

## Phase 3 — 대시보드: 통합 + 그룹 토글 + 보강 카드 + 필터 정합

### Task 8: 공유 filter 모듈 (중복 globToRegExp 제거)

**Files:**
- Create: `packages/web/lib/filter.ts`
- Test: `packages/web/lib/__tests__/filter.test.ts`
- Modify: `packages/web/app/page.tsx`, `packages/web/app/api/sessions/route.ts`

- [ ] **Step 1: 실패 테스트**

`packages/web/lib/__tests__/filter.test.ts`:

```ts
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
  it("maxAge 컷오프", () => {
    expect(sessionMatches(mk({ mtime: now - 100 }), { maxAgeHours: 1, all: false, filterGlob: null, now })).toBe(true);
    expect(sessionMatches(mk({ mtime: now - 7200 }), { maxAgeHours: 1, all: false, filterGlob: null, now })).toBe(false);
  });
  it("all=true는 age 무시", () => {
    expect(sessionMatches(mk({ mtime: 0 }), { maxAgeHours: 1, all: true, filterGlob: null, now })).toBe(true);
  });
  it("glob은 workspace/short/label 매칭", () => {
    expect(sessionMatches(mk({ mtime: now, projectLabel: "claude-monitor" }), { maxAgeHours: null, all: true, filterGlob: "*monitor*", now })).toBe(true);
    expect(sessionMatches(mk({ mtime: now, workspace: "/a/b" , workspaceShort:"b", projectLabel:"b"}), { maxAgeHours: null, all: true, filterGlob: "*zzz*", now })).toBe(false);
  });
  it("globToRegExp 이스케이프", () => {
    expect(globToRegExp("a.b*").test("a.bXY")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/web test -- filter`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`packages/web/lib/filter.ts`:

```ts
import type { SessionSummary } from "@claude-monitor/core";

export function globToRegExp(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(re);
}

export interface FilterOpts {
  maxAgeHours: number | null;
  all: boolean;
  filterGlob: string | null;
  now: number; // epoch seconds
}

export function sessionMatches(s: SessionSummary, o: FilterOpts): boolean {
  if (!o.all && o.maxAgeHours != null && Number.isFinite(o.maxAgeHours)) {
    const cutoff = o.now - o.maxAgeHours * 3600;
    if (s.ref.mtime < cutoff) return false;
  }
  if (o.filterGlob) {
    const re = globToRegExp(o.filterGlob);
    if (!(re.test(s.ref.workspace) || re.test(s.ref.workspaceShort) || re.test(s.ref.projectLabel))) {
      return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: page.tsx를 projectKey 그룹 + 공유 필터로 교체**

`packages/web/app/page.tsx` 전체:

```tsx
import type { SessionSummary } from "@claude-monitor/core";
import { getDataSource } from "../lib/data-source/local";
import { loadConfig } from "../lib/config";
import { sessionMatches } from "../lib/filter";
import { Dashboard } from "./_components/Dashboard";

export const dynamic = "force-dynamic";

export interface ProjectGroupData {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}

export default async function Page({
  searchParams,
}: {
  searchParams?: { maxAgeHours?: string; all?: string; filter?: string };
}) {
  const cfg = loadConfig();
  const all = searchParams?.all === "1";
  const maxAge = searchParams?.maxAgeHours ? Number(searchParams.maxAgeHours) : cfg.maxAgeHours;
  const filterGlob = searchParams?.filter ?? null;

  const ds = getDataSource();
  const now = Math.floor(Date.now() / 1000);
  const summaries = (await ds.snapshot()).filter((s) =>
    sessionMatches(s, { maxAgeHours: maxAge, all, filterGlob, now }),
  );
  const initial = groupByProject(summaries);

  return <Dashboard initial={initial} />;
}

export function groupByProject(list: SessionSummary[]): ProjectGroupData[] {
  const map = new Map<string, ProjectGroupData>();
  for (const s of list) {
    const key = s.ref.projectKey;
    let g = map.get(key);
    if (!g) {
      g = { projectKey: key, projectLabel: s.ref.projectLabel, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  for (const g of map.values()) g.sessions.sort((a, b) => b.ref.mtime - a.ref.mtime);
  return [...map.values()].sort((a, b) => {
    const am = Math.max(...a.sessions.map((s) => s.ref.mtime));
    const bm = Math.max(...b.sessions.map((s) => s.ref.mtime));
    return bm - am;
  });
}
```

- [ ] **Step 5: api/sessions/route.ts를 공유 필터 + projectKey 그룹으로 교체**

`packages/web/app/api/sessions/route.ts` 전체:

```ts
import type { NextRequest } from "next/server";
import type { SessionSummary } from "@claude-monitor/core";
import { getDataSource } from "../../../lib/data-source/local";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";
import { loadConfig } from "../../../lib/config";
import { sessionMatches } from "../../../lib/filter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();

  const cfg = loadConfig();
  const url = new URL(req.url);
  const maxAgeParam = url.searchParams.get("maxAgeHours");
  const all = url.searchParams.get("all") === "1";
  const filterGlob = url.searchParams.get("filter");
  const maxAgeHours = maxAgeParam ? Number(maxAgeParam) : cfg.maxAgeHours;

  const now = Math.floor(Date.now() / 1000);
  const ds = getDataSource();
  const summaries = (await ds.snapshot())
    .filter((s) => sessionMatches(s, { maxAgeHours, all, filterGlob, now }))
    .sort((a, b) => b.ref.mtime - a.ref.mtime);

  const projects = groupByProject(summaries);
  return Response.json(
    { projects },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

function groupByProject(list: SessionSummary[]) {
  const map = new Map<string, { projectKey: string; projectLabel: string; sessions: SessionSummary[] }>();
  for (const s of list) {
    const key = s.ref.projectKey;
    let g = map.get(key);
    if (!g) {
      g = { projectKey: key, projectLabel: s.ref.projectLabel, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...map.values()];
}
```

- [ ] **Step 6: 통과 + 빌드**

Run: `pnpm --filter @claude-monitor/web test -- filter && pnpm --filter @claude-monitor/web build`
Expected: 테스트 PASS, 빌드 성공.

- [ ] **Step 7: 커밋**

```bash
git add packages/web/lib/filter.ts packages/web/lib/__tests__/filter.test.ts packages/web/app/page.tsx packages/web/app/api/sessions/route.ts
git commit -m "feat(web): 공유 filter + projectKey 그룹화 (worktree 통합)"
```

### Task 9: 그룹 토글 훅 + ProjectGroup 접기/펼치기

**Files:**
- Create: `packages/web/app/_components/useCollapsed.ts`
- Modify: `packages/web/app/_components/ProjectGroup.tsx`
- Modify: `packages/web/app/_components/Dashboard.tsx`

- [ ] **Step 1: useCollapsed 훅**

`packages/web/app/_components/useCollapsed.ts`:

```ts
"use client";
import { useCallback, useEffect, useState } from "react";

export function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `cm:collapsed:${key}`;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(storageKey) === "1");
    } catch {
      /* localStorage 불가 — 기본 펼침 */
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [storageKey]);

  return [collapsed, toggle];
}
```

- [ ] **Step 2: Dashboard가 ProjectGroupData(projectKey/projectLabel)로 ProjectGroup 호출**

`packages/web/app/_components/Dashboard.tsx`를 수정:
- `InitialGroup` 인터페이스를 `{ projectKey; projectLabel; sessions }`로 교체.
- 로컬 `groupByWorkspace` → `groupByProject`(projectKey 기준)로 교체.
- `<ProjectGroup>` props를 projectKey/projectLabel로.

`Dashboard.tsx`에서 교체할 부분:

```tsx
interface InitialGroup {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}
```

```tsx
  const groups = useMemo(() => groupByProject([...sessions.values()]), [sessions]);
```

```tsx
        groups.map((g) => (
          <ProjectGroup
            key={g.projectKey}
            projectKey={g.projectKey}
            projectLabel={g.projectLabel}
            sessions={g.sessions}
          />
        ))
```

그리고 파일 하단의 `groupByWorkspace` 함수를 다음으로 교체:

```tsx
function groupByProject(list: SessionSummary[]): InitialGroup[] {
  const map = new Map<string, InitialGroup>();
  for (const s of list) {
    const key = s.ref.projectKey;
    let g = map.get(key);
    if (!g) {
      g = { projectKey: key, projectLabel: s.ref.projectLabel, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  for (const g of map.values()) g.sessions.sort((a, b) => b.ref.mtime - a.ref.mtime);
  return [...map.values()].sort((a, b) => {
    const am = Math.max(...a.sessions.map((s) => s.ref.mtime));
    const bm = Math.max(...b.sessions.map((s) => s.ref.mtime));
    return bm - am;
  });
}
```

- [ ] **Step 3: ProjectGroup 접기 UI**

`packages/web/app/_components/ProjectGroup.tsx` 전체를 교체 (기존 props명 확인 후 맞춤):

```tsx
"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SessionCard } from "./SessionCard";
import { WidgetSlot } from "./WidgetSlot";
import { useCollapsed } from "./useCollapsed";

export function ProjectGroup({
  projectKey,
  projectLabel,
  sessions,
}: {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}) {
  const [collapsed, toggle] = useCollapsed(projectKey);
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-2 w-full text-left text-sm text-zinc-300 hover:text-zinc-100"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="font-medium">{projectLabel}</span>
        <span className="text-xs text-zinc-500">({sessions.length})</span>
        <WidgetSlot slot="project-header" session={sessions[0]!} />
      </button>
      {!collapsed && (
        <div className="space-y-2 pl-1">
          {sessions.map((s) => (
            <SessionCard key={`${s.ref.adapterId}::${s.ref.id}`} session={s} />
          ))}
        </div>
      )}
    </section>
  );
}
```

> 실행자 주의: 기존 `ProjectGroup.tsx`의 import·props를 먼저 읽고, WidgetSlot 시그니처(`slot`, `session`)가 위와 다르면 기존 사용법에 맞춘다.

- [ ] **Step 4: 빌드 + 수동 확인**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공.

수동: `pnpm --filter @claude-monitor/web dev` → 브라우저서 프로젝트 헤더 클릭 시 접힘/펼침, 새로고침해도 유지(localStorage).

- [ ] **Step 5: 커밋**

```bash
git add packages/web/app/_components/useCollapsed.ts packages/web/app/_components/ProjectGroup.tsx packages/web/app/_components/Dashboard.tsx
git commit -m "feat(web): 프로젝트 그룹 접기/펼치기 토글 (localStorage 영속)"
```

### Task 10: 보강 카드 (러너 배지 · 모델 · 모드 · 컨텍스트% 바)

**Files:**
- Create: `packages/web/app/_components/RunnerBadge.tsx`
- Create: `packages/web/app/_components/ContextBar.tsx`
- Modify: `packages/web/app/_components/SessionCard.tsx`
- Modify: `packages/web/lib/i18n/ko.ts`

- [ ] **Step 1: i18n 키 추가**

`packages/web/lib/i18n/ko.ts`의 `card` 객체에 추가, 새 `runner`/`detail`/`kill` 섹션 추가:

```ts
  card: {
    tool: "도구",
    subagent: "sub-agent",
    todo: "todo",
    todoCurrent: "진행",
    todoNext: "다음",
    msg: "msg",
    model: "모델",
    mode: "모드",
    context: "컨텍스트",
  },
  runner: {
    conductor: "Conductor",
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    unknown: "—",
  },
```

- [ ] **Step 2: RunnerBadge**

`packages/web/app/_components/RunnerBadge.tsx`:

```tsx
import type { RunnerKind } from "@claude-monitor/core";

const STYLE: Record<RunnerKind, string> = {
  conductor: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "claude-code": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "claude-desktop": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  unknown: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40",
};

const LABEL: Record<RunnerKind, string> = {
  conductor: "Conductor",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  unknown: "—",
};

export function RunnerBadge({ runner }: { runner: RunnerKind }) {
  if (runner === "unknown") return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STYLE[runner]}`}>
      {LABEL[runner]}
    </span>
  );
}
```

- [ ] **Step 3: ContextBar**

`packages/web/app/_components/ContextBar.tsx`:

```tsx
import type { ContextUsage } from "@claude-monitor/core";

export function ContextBar({ context }: { context: ContextUsage | null }) {
  if (!context) return null;
  const pct = Math.round(context.pct * 100);
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 pl-1">
      <span>컨텍스트</span>
      <div className="h-1.5 w-24 rounded bg-zinc-800 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-zinc-400">{pct}%</span>
      <span className="text-zinc-600">
        ({(context.tokens / 1000).toFixed(0)}k/{(context.limit / 1000).toFixed(0)}k)
      </span>
    </div>
  );
}
```

- [ ] **Step 4: SessionCard에 배지/모델/모드/컨텍스트 + 상세 링크**

`packages/web/app/_components/SessionCard.tsx`의 header와 본문에 삽입. import 추가:

```tsx
import Link from "next/link";
import { RunnerBadge } from "./RunnerBadge";
import { ContextBar } from "./ContextBar";
```

header `<time>` 다음에 러너 배지 추가, 그리고 모델·모드 라인 + 컨텍스트 바를 `lastTool` 위에 삽입:

```tsx
      <header className="flex items-center gap-3 text-sm">
        <StatusBadge status={session.status} />
        <Link href={`/session/${session.ref.id}?adapter=${session.ref.adapterId}`} className="text-cyan-400 hover:underline">
          {shortSid(session.ref.id)}
        </Link>
        <time
          className="text-zinc-500"
          dateTime={new Date(session.ref.mtime * 1000).toISOString()}
          title={new Date(session.ref.mtime * 1000).toLocaleString()}
        >
          {ago(age)}
        </time>
        <RunnerBadge runner={session.runner} />
      </header>

      {(session.model || session.mode) && (
        <div className="flex items-center gap-3 text-xs text-zinc-500 pl-1">
          {session.model && <span>{session.model}</span>}
          {session.mode && <span className="text-zinc-600">· {session.mode}</span>}
        </div>
      )}

      <ContextBar context={session.context} />
```

- [ ] **Step 5: 빌드 + 수동 확인**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공. 수동: 카드에 러너 배지/모델/모드/컨텍스트% 바 표시.

- [ ] **Step 6: 커밋**

```bash
git add packages/web/app/_components/RunnerBadge.tsx packages/web/app/_components/ContextBar.tsx packages/web/app/_components/SessionCard.tsx packages/web/lib/i18n/ko.ts
git commit -m "feat(web): 카드에 러너 배지·모델·모드·컨텍스트% 표시 + 상세 링크"
```

---

## Phase 4 — 세션 상세 + usage 추이 + 에러/낫파운드

### Task 11: usage 시계열 reader

**Files:**
- Create: `packages/adapter-claude-code/src/usage-series.ts`
- Test: `packages/adapter-claude-code/src/__tests__/usage-series.test.ts`
- Modify: `packages/adapter-claude-code/src/index.ts`

- [ ] **Step 1: 실패 테스트 + fixture**

Create `packages/adapter-claude-code/src/__tests__/fixtures/usage.jsonl`:

```
{"type":"assistant","timestamp":"2026-05-29T00:00:00.000Z","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":99}}}
{"type":"user","message":{"content":[]}}
{"type":"assistant","timestamp":"2026-05-29T00:01:00.000Z","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":198}}}
```

`packages/adapter-claude-code/src/__tests__/usage-series.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readUsageSeries } from "../usage-series.js";

describe("readUsageSeries", () => {
  it("assistant 턴의 usage를 시계열로", async () => {
    const series = await readUsageSeries(join(__dirname, "fixtures", "usage.jsonl"));
    expect(series).toEqual([
      { ts: Date.parse("2026-05-29T00:00:00.000Z"), tokens: 100 },
      { ts: Date.parse("2026-05-29T00:01:00.000Z"), tokens: 200 },
    ]);
  });

  it("없는 파일은 빈 배열", async () => {
    expect(await readUsageSeries("/no/such/file.jsonl")).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test -- usage-series`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`packages/adapter-claude-code/src/usage-series.ts`:

```ts
import { readFile } from "node:fs/promises";
import { usageContextTokens } from "./parser.js";

export interface UsagePoint {
  ts: number; // epoch ms
  tokens: number;
}

const MAX_POINTS = 500;

export async function readUsageSeries(source: string): Promise<UsagePoint[]> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return [];
  }
  const out: UsagePoint[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, unknown> } };
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    out.push({ ts, tokens: usageContextTokens(obj.message.usage) });
  }
  return out.slice(-MAX_POINTS);
}
```

- [ ] **Step 4: index export**

`packages/adapter-claude-code/src/index.ts` 끝에:

```ts
export { readUsageSeries, type UsagePoint } from "./usage-series.js";
```

- [ ] **Step 5: 통과 + 빌드**

Run: `pnpm --filter @claude-monitor/adapter-claude-code test -- usage-series && pnpm --filter @claude-monitor/adapter-claude-code build`
Expected: PASS + 빌드 성공.

- [ ] **Step 6: 커밋**

```bash
git add packages/adapter-claude-code/src/usage-series.ts packages/adapter-claude-code/src/__tests__/usage-series.test.ts packages/adapter-claude-code/src/__tests__/fixtures/usage.jsonl packages/adapter-claude-code/src/index.ts
git commit -m "feat(adapter): readUsageSeries — 상세용 컨텍스트 추이"
```

### Task 12: 세션 상세 페이지 + usage 추이 + 에러/낫파운드

**Files:**
- Create: `packages/web/app/session/[id]/page.tsx`
- Create: `packages/web/app/_components/UsageTrend.tsx`
- Create: `packages/web/app/error.tsx`
- Create: `packages/web/app/not-found.tsx`
- Modify: `packages/web/lib/i18n/ko.ts`

- [ ] **Step 1: i18n 상세/에러 키**

`ko.ts`에 섹션 추가:

```ts
  detail: {
    back: "← 대시보드",
    source: "소스",
    branch: "브랜치",
    version: "버전",
    usageTrend: "컨텍스트 추이",
    noUsage: "usage 데이터 없음",
    todos: "할 일",
  },
  errors: {
    title: "문제가 발생했습니다",
    retry: "다시 시도",
    notFound: "세션을 찾을 수 없습니다",
  },
```

- [ ] **Step 2: UsageTrend (의존성 없는 인라인 SVG 스파크라인)**

`packages/web/app/_components/UsageTrend.tsx`:

```tsx
import type { UsagePoint } from "@claude-monitor/adapter-claude-code";

export function UsageTrend({ points }: { points: UsagePoint[] }) {
  if (points.length < 2) return <div className="text-xs text-zinc-600">usage 데이터 없음</div>;
  const w = 480;
  const h = 80;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.tokens);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1);
  const sx = (x: number) => (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * w);
  const sy = (y: number) => h - (y / maxY) * h;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.ts).toFixed(1)},${sy(p.tokens).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-lg h-20">
      <path d={d} fill="none" stroke="#34d399" strokeWidth={1.5} />
    </svg>
  );
}
```

- [ ] **Step 3: 상세 페이지 (server component)**

`packages/web/app/session/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { readUsageSeries } from "@claude-monitor/adapter-claude-code";
import { getDataSource } from "../../../lib/data-source/local";
import { UsageTrend } from "../../_components/UsageTrend";
import { StatusBadge } from "../../_components/StatusBadge";
import { ContextBar } from "../../_components/ContextBar";
import { RunnerBadge } from "../../_components/RunnerBadge";

export const dynamic = "force-dynamic";

export default async function SessionDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { adapter?: string };
}) {
  const adapterId = searchParams?.adapter ?? "claude-code";
  const ds = getDataSource();
  const s = await ds.getById(adapterId, params.id);
  if (!s) notFound();
  const series = await readUsageSeries(s.ref.source);

  return (
    <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <Link href="/" className="text-xs text-cyan-400 hover:underline">← 대시보드</Link>

      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <StatusBadge status={s.status} />
          <h1 className="text-base text-zinc-100">{s.ref.projectLabel}</h1>
          <RunnerBadge runner={s.runner} />
        </div>
        <div className="text-xs text-zinc-500 space-y-0.5">
          <div>{s.ref.workspace}</div>
          <div>소스: {s.ref.source}</div>
          <div>
            {s.model && <span>{s.model} </span>}
            {s.mode && <span>· {s.mode} </span>}
            {s.version && <span>· v{s.version}</span>}
          </div>
        </div>
        <ContextBar context={s.context} />
      </header>

      <section className="space-y-2">
        <h2 className="text-sm text-zinc-300">컨텍스트 추이</h2>
        <UsageTrend points={series} />
      </section>

      {s.todo && (
        <section className="space-y-1 text-sm">
          <h2 className="text-zinc-300">할 일 ({s.todo.done}/{s.todo.total})</h2>
          {s.todo.current && <div className="text-amber-300">▸ {s.todo.current}</div>}
          {s.todo.next && <div className="text-zinc-500">· {s.todo.next}</div>}
        </section>
      )}

      {s.pendingSubagents.length > 0 && (
        <section className="space-y-1 text-sm">
          <h2 className="text-zinc-300">대기 sub-agent ({s.pendingSubagents.length})</h2>
          {s.pendingSubagents.map((a) => (
            <div key={a.id} className="text-zinc-500">└ {a.desc}</div>
          ))}
        </section>
      )}

      {s.lastText && (
        <section className="space-y-1 text-sm">
          <h2 className="text-zinc-300">마지막 메시지</h2>
          <p className="text-zinc-400 whitespace-pre-wrap">{s.lastText}</p>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 4: error.tsx / not-found.tsx**

`packages/web/app/error.tsx`:

```tsx
"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-3 text-center">
      <h1 className="text-zinc-200">문제가 발생했습니다</h1>
      <button
        type="button"
        onClick={reset}
        className="text-sm text-cyan-400 border border-cyan-500/40 rounded px-3 py-1 hover:text-cyan-200"
      >
        다시 시도
      </button>
    </main>
  );
}
```

`packages/web/app/not-found.tsx`:

```tsx
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-3 text-center">
      <h1 className="text-zinc-200">세션을 찾을 수 없습니다</h1>
      <Link href="/" className="text-sm text-cyan-400 hover:underline">← 대시보드</Link>
    </main>
  );
}
```

- [ ] **Step 5: 빌드 + 수동 확인**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공.

수동: dev 서버서 카드 클릭 → 상세(풀 메시지·todo·subagent·usage 추이). `/session/bogus-id` → not-found.

- [ ] **Step 6: 커밋**

```bash
git add packages/web/app/session packages/web/app/_components/UsageTrend.tsx packages/web/app/error.tsx packages/web/app/not-found.tsx packages/web/lib/i18n/ko.ts
git commit -m "feat(web): 세션 상세 + usage 추이 + error/not-found 경계"
```

---

## Phase 5 — Kill (로컬·검증·SIGTERM)

### Task 13: process-kill (검증 후 SIGTERM)

**Files:**
- Create: `packages/web/lib/process-kill.ts`
- Test: `packages/web/lib/__tests__/process-kill.test.ts`

- [ ] **Step 1: 실패 테스트 (순수 검증 함수)**

`packages/web/lib/__tests__/process-kill.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { verifyKillTarget } from "../process-kill";

const SID = "5a62fd30-6190-43e8-bf6a-bbbd8c8461f5";
describe("verifyKillTarget", () => {
  it("claude 프로세스이며 sessionId 포함 시 true", () => {
    expect(verifyKillTarget(`/x/com.conductor.app/agent-binaries/claude --resume ${SID}`, SID)).toBe(true);
  });
  it("sessionId 불일치 시 false", () => {
    expect(verifyKillTarget(`claude --resume 00000000-0000-0000-0000-000000000000`, SID)).toBe(false);
  });
  it("claude 아닌 프로세스는 false (오살 방지)", () => {
    expect(verifyKillTarget(`/usr/bin/python --resume ${SID}`, SID)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @claude-monitor/web test -- process-kill`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`packages/web/lib/process-kill.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { probeProcesses, sessionIdFromCommand, classifyRunner } from "./process-probe";

const pexec = promisify(exec);

export interface KillResult {
  ok: boolean;
  reason?: string;
}

/** kill 직전 재검증: 해당 command가 진짜 그 세션의 claude 프로세스인가 (오살 방지). */
export function verifyKillTarget(command: string, sessionId: string): boolean {
  if (classifyRunner(command) === "unknown") return false;
  return sessionIdFromCommand(command) === sessionId;
}

export async function killSession(sessionId: string): Promise<KillResult> {
  const probe = await probeProcesses({ force: true });
  const e = probe.get(sessionId);
  if (!e) return { ok: false, reason: "not_found" };

  // TOCTOU 가드 — pid의 현재 command를 재확인
  let command = "";
  try {
    const { stdout } = await pexec(`ps -p ${e.pid} -o command=`);
    command = stdout.trim();
  } catch {
    return { ok: false, reason: "gone" };
  }
  if (!verifyKillTarget(command, sessionId)) return { ok: false, reason: "mismatch" };

  try {
    process.kill(e.pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: false, reason: "gone" };
    if (code === "EPERM") return { ok: false, reason: "eperm" };
    return { ok: false, reason: "error" };
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @claude-monitor/web test -- process-kill`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add packages/web/lib/process-kill.ts packages/web/lib/__tests__/process-kill.test.ts
git commit -m "feat(web): killSession — 프로브 확인 + TOCTOU 재검증 + SIGTERM"
```

### Task 14: Kill API 라우트 (write, 인증)

**Files:**
- Create: `packages/web/app/api/sessions/[id]/kill/route.ts`

- [ ] **Step 1: 라우트 구현**

`packages/web/app/api/sessions/[id]/kill/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { checkBearer, unauthorized } from "../../../../../lib/auth/middleware";
import { killSession } from "../../../../../lib/process-kill";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();

  const result = await killSession(ctx.params.id);
  const status = result.ok ? 200 : result.reason === "not_found" ? 404 : 409;
  return new Response(JSON.stringify(result), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
```

> 경로 깊이 주의: `app/api/sessions/[id]/kill/route.ts` → `lib`까지 `../../../../../` (5단계). 빌드 에러 시 상대경로 조정.

- [ ] **Step 2: 빌드 확인**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공 (import 경로 OK).

- [ ] **Step 3: 커밋**

```bash
git add packages/web/app/api/sessions/[id]/kill/route.ts
git commit -m "feat(web): POST /api/sessions/[id]/kill (인증 게이트)"
```

### Task 15: Kill 버튼 + 확인 다이얼로그

**Files:**
- Create: `packages/web/app/_components/KillButton.tsx`
- Modify: `packages/web/app/_components/SessionCard.tsx`
- Modify: `packages/web/lib/i18n/ko.ts`

- [ ] **Step 1: i18n kill 키**

`ko.ts`에 추가:

```ts
  kill: {
    button: "kill",
    confirm: "이 세션을 종료할까요?",
    yes: "종료",
    no: "취소",
    failed: "종료 실패",
  },
```

- [ ] **Step 2: KillButton (확인 다이얼로그 인라인)**

`packages/web/app/_components/KillButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Skull } from "lucide-react";
import type { SessionSummary } from "@claude-monitor/core";

export function KillButton({ session }: { session: SessionSummary }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.pid == null) return null; // kill 불가(로컬 프로세스 미발견)

  async function doKill() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.ref.id}/kill?adapter=${session.ref.adapterId}`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        setError(body.reason ?? String(res.status));
      } else {
        setConfirming(false);
      }
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-zinc-400">이 세션을 종료할까요?</span>
        <button type="button" disabled={busy} onClick={doKill} className="text-red-400 hover:text-red-300 px-1">
          종료
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="text-zinc-500 px-1">
          취소
        </button>
        {error && <span className="text-red-500">종료 실패: {error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-red-400"
      title="kill"
    >
      <Skull size={12} /> kill
    </button>
  );
}
```

- [ ] **Step 3: SessionCard footer에 KillButton**

`SessionCard.tsx` import 추가 `import { KillButton } from "./KillButton";`, 그리고 `<WidgetSlot slot="card-footer" ... />` 위에:

```tsx
      <div className="flex justify-end pt-1">
        <KillButton session={session} />
      </div>
```

- [ ] **Step 4: 빌드 + 수동 확인 (안전: 버릴 수 있는 세션으로)**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공.

수동(주의 — 실제 프로세스 종료): 종료해도 되는 테스트 세션 카드의 kill → 확인 → 종료 → 다음 틱에 상태가 `stop`으로. 확인 누르기 전엔 안 죽음. pid 없는(원격/종료된) 세션엔 버튼 미표시.

- [ ] **Step 5: 커밋**

```bash
git add packages/web/app/_components/KillButton.tsx packages/web/app/_components/SessionCard.tsx packages/web/lib/i18n/ko.ts
git commit -m "feat(web): 세션 kill 버튼 + 확인 다이얼로그 (pid 있을 때만)"
```

---

## Phase 6 — 복원력 + 빌드/설치 검증

### Task 16: SSE 재연결 시 스냅샷 재동기화

**Files:**
- Create: `packages/web/lib/sync.ts`
- Modify: `packages/web/app/_components/Dashboard.tsx`

- [ ] **Step 1: fetchSnapshot 헬퍼**

`packages/web/lib/sync.ts`:

```ts
import type { SessionSummary } from "@claude-monitor/core";

interface ApiProjects {
  projects: Array<{ sessions: SessionSummary[] }>;
}

/** /api/sessions 스냅샷을 평탄화해 반환 (재연결 후 누락분 복구용) */
export async function fetchSnapshot(): Promise<SessionSummary[]> {
  const res = await fetch("/api/sessions?all=1", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const data = (await res.json()) as ApiProjects;
  return data.projects.flatMap((p) => p.sessions);
}
```

- [ ] **Step 2: Dashboard에 재동기화 배선**

`Dashboard.tsx`의 SSE useEffect를 수정 — 에러 후 재연결(onopen) 시 스냅샷 재요청. import에 `import { fetchSnapshot } from "../../lib/sync";` 추가하고 effect 교체:

```tsx
  useEffect(() => {
    let wasErrored = false;
    const es = new EventSource("/api/events");
    es.addEventListener("summary", (e) => {
      try {
        upsert(JSON.parse((e as MessageEvent).data) as SessionSummary);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("removed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { refId: string };
        remove(data.refId);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("heartbeat", () => setConnected(true));
    es.onopen = () => {
      setConnected(true);
      if (wasErrored) {
        wasErrored = false;
        fetchSnapshot()
          .then((list) => setInitial(list))
          .catch(() => {
            /* 다음 틱에 재시도 */
          });
      }
    };
    es.onerror = () => {
      wasErrored = true;
      setConnected(false);
    };
    return () => es.close();
  }, [upsert, remove, setConnected, setInitial]);
```

- [ ] **Step 3: 빌드 + 수동 확인**

Run: `pnpm --filter @claude-monitor/web build`
Expected: 성공.

수동: dev 서버 띄우고 브라우저 연결 → 서버 재시작 → "연결 끊김" 배너 떴다가 재연결 시 사라지고 목록이 현재 상태로 재동기화.

- [ ] **Step 4: 커밋**

```bash
git add packages/web/lib/sync.ts packages/web/app/_components/Dashboard.tsx
git commit -m "feat(web): SSE 재연결 시 스냅샷 재동기화"
```

### Task 17: 전체 빌드/테스트 + 설치 + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 모노레포 전체 그린 확인**

Run: `pnpm install && pnpm -r build && pnpm -r test`
Expected: 모든 패키지 빌드 성공, 모든 테스트 PASS (core: project-key/context-limit/기존, adapter: parser/reader/usage-series/기존, web: process-probe/filter/process-kill).

- [ ] **Step 2: 설치 스크립트로 동료 실행 경로 검증**

Run:
```bash
bash scripts/install.sh
~/bin/claude-monitor-web &
sleep 5
curl -s http://127.0.0.1:11314/api/health
kill %1
```
Expected: install.sh가 web 빌드 + `~/bin/claude-monitor-web` 설치, health 200.

- [ ] **Step 3: README 갱신**

`README.md`에 반영:
- "읽기 전용" 문구 → kill은 예외(로컬 write)임을 명시.
- 새 카드 정보(러너·모델·모드·컨텍스트%) + 프로젝트 통합 + 그룹 토글 + 세션 상세 설명.
- Kill 보안: 기본 `127.0.0.1` 바인딩, LAN 노출 시 `CM_BEARER_TOKEN` 필수(write 차단).
- `CM_BEARER_TOKEN` 설정 시 브라우저 네비게이션 제약(알려진 한계) 한 줄.

- [ ] **Step 4: 커밋**

```bash
git add README.md
git commit -m "docs: README — 통합/토글/러너·컨텍스트/kill 반영"
```

---

## Phase 7 — Ship + 회고

### Task 18: PR 생성

- [ ] **Step 1: 푸시 + PR**

Run:
```bash
git push -u origin muscat
gh pr create --base main --title "Web UI 확장 MVP: 통합·토글·러너/컨텍스트·kill" --body "스펙: docs/superpowers/specs/2026-05-29-claude-monitor-web-mvp-design.md"
```
Expected: PR 생성. CI 있으면 그린 확인.

### Task 19: 회고 (KPT)

**Files:**
- Create: `.context/retros/2026-05-29-c12-web-mvp.md`

- [ ] **Step 1: 회고 작성 (§8.2 KPT)**

`.context/retros/2026-05-29-c12-web-mvp.md`에 Keep / Problem / Try 작성:
- Keep: 증거 기반 실현가능성 검증(transcript·ps), projectKey cwd-파생으로 통합 정확성 확보, kill 보안 게이트.
- Problem: 스코프가 "빠른 polish"에서 기능 빌드로 확장됨(읽기→write 전환), 컨텍스트 한도 추정 한계.
- Try: 다음 단계(원격 DataSource·유저 계층·CODEX adapter) 분리 페이즈로.

- [ ] **Step 2: 커밋**

```bash
git add .context/retros/2026-05-29-c12-web-mvp.md
git commit -m "docs: C12 web MVP 회고 (KPT)"
```

---

## Self-Review (작성자 체크)

**Spec coverage (스펙 요구 → Task):**
- 프로젝트 통합 → Task 2(util), 5(reader 정정), 8(그룹화). cwd-파생 ✓
- 그룹 토글 → Task 9 ✓
- 러너/모델/모드/컨텍스트 → Task 4(파서), 6(프로브 러너), 7(병합), 10(카드 표시) ✓
- 세션 kill (로컬·확인·검증) → Task 13(검증+SIGTERM), 14(API 인증), 15(버튼+확인) ✓
- 세션 상세 + usage 추이 → Task 11(시계열), 12(상세) ✓
- 에러/낫파운드/로딩 → Task 12 ✓
- 필터 정합(SSE도 준수) → Task 8(공유 필터) + 클라 store가 enrich된 summary 수신 ✓
- SSE 재연결 재동기화 → Task 16 ✓
- 최소 테스트 → core 2, adapter 2(+fixtures), web 3 ✓
- 빌드/설치/README → Task 17 ✓
- ship + 회고 → Task 18, 19 ✓
- 보안(127.0.0.1·토큰·TOCTOU) → Task 13, 14, 17 README ✓

**Type 일관성:** `RunnerKind`/`ContextUsage`/`ProbeEntry`/`ProjectIdentity`/`FilterOpts`/`KillResult`/`ProjectGroupData`/`UsagePoint`는 Contract 절 정의를 전 Task가 동일 사용. `projectIdentityFromCwd`/`computeContext`/`contextLimitForModel`/`usageContextTokens`/`probeProcesses`/`sessionMatches`/`verifyKillTarget`/`killSession`/`readUsageSeries` 시그니처 일치.

**알려진 한계(스펙 리스크와 동일):** 컨텍스트 한도는 `[1m]` 미검출 시 200k 추정. 러너/projectKey는 경로 휴리스틱(깨져도 unknown/분리 폴백). `CM_BEARER_TOKEN` 설정 시 브라우저 페이지 네비게이션 제약(write 전용 토큰 흐름은 비목표).
