# claude-monitor Web UI — 기능 확장 MVP 설계

- 날짜: 2026-05-29
- 상태: 승인됨 (브레인스토밍 → 설계 합의)
- 대상 브랜치: `muscat` (origin/main 기준)

## Context

`claude-monitor`는 Mac에서 여러 Claude Code 세션을 한눈에 분류(triage)하는 읽기 전용 대시보드(CLI + Next.js Web UI). CLI·core·adapter는 완성·테스트됨, Web UI는 기본 모니터링이 동작(SSE 라이브 업데이트 포함).

데모(현 CLI/터미널) 검토 중 사용자가 한계를 지적했다:
- 동일 프로젝트가 Conductor worktree마다 **여러 줄로 분리**되어 나옴 → 통합 필요.
- 그룹이 항상 펼쳐져 있음 → **접기/펼치기 토글** 필요.
- 안 쓰는데 살아있는 세션을 **완전히 kill**할 수단이 없음.
- 세션의 **러너(Claude Code/Conductor/Claude Desktop)·모델·모드·컨텍스트 사용량**이 안 보임.
- (장래) 팀 단위로 **다른 팀원의 세션**도 보고 싶음 — 프로젝트는 유저 무관하게 통합, 세션은 유저별로.

이 설계는 위 요구를 Web UI에 반영해 "팀원이 설치해서 쓸 수 있는" 기능형 MVP로 만든다. CLI(터미널)는 현행 유지(범위 외).

**목표**: 통합·토글·러너/모델/모드/컨텍스트 표시·로컬 세션 kill을 갖춘, 동료 설치 가능한 로컬 Web 대시보드.

## 사용자 & JTBD

- 사용자: Conductor 등으로 **다수의 Claude Code 세션을 병렬 실행**하는 개발자.
- 핵심 작업: *"내 에이전트들 중 지금 나를 필요로 하거나, 멈췄거나, 죽여야 할 놈은 어디 있나?"*
- 부가(장래): 팀에서 누가 어떤 프로젝트를 어떻게 돌리는지 파악.

## 확정 결정 (브레인스토밍 합의)

1. **Kill 범위**: 로컬 세션만 종료 + 확인 다이얼로그. 서버는 `127.0.0.1` 바인딩 유지, LAN 노출 시 `CM_BEARER_TOKEN` 필수.
2. **팀 유저 계층**: 지금은 **평면 프로젝트→세션**. 유저 계층은 나중. 단 데이터모델에 `owner` 필드를 미리 심어 무파괴 확장.
3. **표시 깊이**: 카드에 러너배지+모델+모드+컨텍스트% 모두. 상세 화면에 usage 추이.
4. **품질 게이트**: 동작 우선 MVP. 테스트는 핵심 순수 로직(파서 보강, ps 파서, projectKey, 컨텍스트 계산, kill 검증)만 스모크.

## 비목표 (이번 MVP 제외)

- 원격(remote) DataSource / 다인 팀 공유 실시간 — 데이터모델만 대비, 기능은 나중.
- 2번째 AI 에이전트 adapter (CODEX 등 `~/.claude/projects` 밖) — 별도 adapter 필요.
- 위젯 플러그인 생태계 (`WidgetRegistry`는 유지, 신규 위젯 0).
- `AdapterRegistry` 배선(현 dead code) — 그대로 둠.
- CLI(터미널) 신기능 반영 — 현행 유지.
- 원격 세션 kill (다른 머신) — 로컬만.

## 실현 가능성 — 증거

실제 transcript(`~/.claude/projects/*/*.jsonl`)와 실행 프로세스(`ps`)를 조사해 확인:

**Transcript 최상위 라인 필드**: `cwd`, `gitBranch`, `version`, `entrypoint`, `permissionMode`, `userType`, `sessionId`, `timestamp`, `message.{model, usage}`.
- 관측값: `entrypoint ∈ {cli, sdk-ts, sdk-cli, claude-desktop}`, `permissionMode ∈ {plan, acceptEdits, bypassPermissions, auto, default}`, `model ∈ {claude-opus-4-7, claude-opus-4-8, <synthetic>}`.
- `usage = {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, ...}`. 컨텍스트 점유 ≈ `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (마지막 assistant 턴 기준).

**프로세스(`ps`)** — kill·러너·컨텍스트 한도의 출처:
- 실행 인자에 sessionId 노출: `claude … --resume <sessionId>` 또는 `--session-id <sessionId>` → **sessionId↔PID 매핑 가능**.
- 러너는 바이너리 경로로 판별:
  - `…/com.conductor.app/agent-binaries/claude/…` → **Conductor**
  - `…/Caskroom/claude-code/…` → **Claude Code (CLI)**
  - `…/Claude.app/…/claude-code/…` → **Claude Desktop**
- 모델 인자 `--model claude-opus-4-8[1m]` → `[1m]` 접미사로 1M 컨텍스트 한도 감지.

**결론**: 5개 요구 전부 로컬에서 구현 가능. kill은 read-write로의 전환(보안 처리 필요)을 수반.

## 아키텍처

### 데이터 모델 (`packages/core/src/types`)

- `SessionRef` 확장: `projectKey: string`(통합 키), `owner: string`(예: OS 유저, 장래 팀용).
- `SessionSummary` 확장:
  - `runner: "conductor" | "claude-code" | "claude-desktop" | "unknown"`
  - `model: string | null` (`<synthetic>` 제외)
  - `mode: string | null` (= `permissionMode`)
  - `context: { tokens: number; limit: number; pct: number } | null`
  - `pid: number | null` (kill 가능 여부 = pid 존재)
  - `version: string | null`

### 파서 보강 (`packages/adapter-claude-code/src/parser.ts`)

`fold()`가 현재 `message.content`만 읽음 → 라인 최상위 필드도 흡수하도록 확장:
- `cwd`, `gitBranch`, `version`, `entrypoint`, `permissionMode` 마지막값 보존.
- assistant 라인의 `message.model`(synthetic 제외 마지막값), `message.usage` 보존.
- `usage`로 컨텍스트 점유 토큰 계산(한도는 프로세스 프로브가 보완; 없으면 모델별 기본 테이블).
- 기존 jq CLI와의 동작 일치는 깨지 않음(추가 필드만).

### 프로세스 프로브 (신규, 로컬 전용 — `packages/web/lib/process-probe.ts`)

- `ps -eo pid,command` 실행 → claude 프로세스 라인 파싱.
- 각 라인에서 추출: `sessionId`(`--resume`/`--session-id`), `pid`, `runner`(경로 판별), 모델 인자→컨텍스트 한도(`[1m]`→1,000,000, 없으면 기본).
- 출력: `Map<sessionId, { pid, runner, contextLimit }>`.
- 주기적 갱신(예 3–5초) 또는 스냅샷 요청 시 갱신. 순수 파싱 함수(문자열→구조)는 분리해 테스트.

### LocalDataSource 병합 (`packages/web/lib/data-source/local.ts`)

- 세션 요약 생성 시 프로세스 프로브 결과를 병합: `runner`, `pid`, `context.limit`.
- transcript 파서 결과(model, mode, usage tokens)와 합쳐 `SessionSummary` 완성.
- `pct = tokens / limit`.

### 프로젝트 통합 (신규 util — `packages/core/src/util/project-key.ts`)

**⚠️ 입력은 반드시 transcript의 `cwd` 필드 (decoded 디렉토리명 아님).** `~/.claude/projects/<encoded>`의 `decodePath`는 `-`→`/` 전부 치환하는 비단사(non-injective) 변환이라 하이픈 포함 경로를 깨뜨린다 (예: `260507_gstack-ui` → `260507/gstack/ui`). 따라서 projectKey/owner는 **파서가 캡처한 `cwd`로 reader에서 계산**한다. watcher의 `refFromPath`는 임시값만 채우고 reader가 정정한다.

`cwd → projectKey` 휴리스틱:
- Conductor: `…/conductor/workspaces/<project>/<worktree>` → `key = conductor/<project>`, `label = <project>` (예: `260507_gstack-ui`).
- `.worktrees/<name>`: `<repoAbs>/.worktrees/<name>` → `key = <repoAbs>`, `label = basename(repoAbs)`.
- 그 외(평범 repo, worktree 형제 없음): `key = cwd`(전체), `label = basename(cwd)`. — 전체 경로를 키로 써 무관한 동명 디렉토리 오병합 방지.
- `owner = /Users/<owner>/` 추출. 순수 함수 → 테스트.

### Kill (write 경로)

- API: `POST /api/sessions/[id]/kill` (`runtime=nodejs`).
- 절차: 프로세스 프로브로 해당 sessionId의 `pid` 확인 → **kill 직전 재검증**(해당 pid의 command가 여전히 그 sessionId를 포함하고 claude 바이너리인지 — TOCTOU 가드) → `process.kill(pid, "SIGTERM")`.
- 검증 실패(엉뚱한 pid·불일치) 시 거부(4xx), 임의 pid kill 금지.
- 인증: 기존 `checkBearer` 미들웨어 적용. `CM_BEARER_TOKEN` 설정 시 write 필수. 기본 `127.0.0.1` 바인딩.
- 응답 후 세션은 다음 틱에 `stop`으로 자연 전환(파일 mtime 정지). 즉시 UI 반영 위해 낙관적 표시 가능.

### UI / IA (`packages/web/app`)

```
[대시보드]
 └ 프로젝트 그룹 (통합, projectKey)        ▼ 토글(접기/펼치기, 상태 영속)
    └ 세션 카드
       status · 러너배지 · 모델 · 모드 · 컨텍스트%바 · todo n/m · subagent · 마지막메시지
       └ [kill] 버튼 (확인 다이얼로그)
 카드 클릭 → [세션 상세]  (풀 정보 + usage 추이 + kill)
```

- 그룹 토글 상태: `localStorage` 영속.
- 카드 보강: `StatusBadge` 옆 러너배지, 모델·모드 텍스트, 컨텍스트% 바.
- 상세 화면(신규 라우트 `app/session/[id]/page.tsx`): 안 잘린 마지막 메시지, 전체 todo, 모든 subagent, source 경로, runner/model/mode/version, **usage 추이**(transcript의 assistant 턴별 컨텍스트 점유 시계열 → 스파크라인/간단 차트).
- 에러/로딩 경계: `app/error.tsx`, `app/not-found.tsx`.
- 필터 정합: `globToRegExp`+predicate를 `lib/filter.ts`로 단일화(현재 `page.tsx`·`api/sessions/route.ts` 중복), SSE 도착 세션도 활성 필터 준수.
- i18n: 신규 문자열 `ko.ts`에 추가(러너·모드·컨텍스트·kill·상세·에러).

## 페이즈 & 검증

| P | 내용 | 검증 |
|---|---|---|
| 1 | 데이터모델 확장 + 파서 보강(model·mode·gitBranch·cwd·version·usage) + `project-key` util | 파서·projectKey·컨텍스트 계산 단위테스트 green |
| 2 | 프로세스 프로브(러너·pid·컨텍스트 한도) → LocalDataSource 병합 | ps-파서 테스트(샘플 문자열), 실세션서 pid 매칭 확인 |
| 3 | 대시보드: 프로젝트 통합 + 그룹 토글(영속) + 보강 카드(러너배지·모델·모드·컨텍스트%바) + 필터 정합 | worktree들이 1개 프로젝트로 합쳐짐, 토글 동작, SSE도 필터 준수 |
| 4 | 세션 상세 + usage 추이 + `error.tsx`/`not-found.tsx`/loading | 클릭→상세 풀정보·추이 렌더, 잘못된 id→not-found |
| 5 | Kill(로컬·재검증·SIGTERM) + 확인 다이얼로그 + write 토큰 게이트 | 죽인 세션 stop 전환, 확인 없이 안 죽음, 불일치 pid 거부 |
| 6 | SSE 재연결 재동기화 + 연결배너 + 최소 스모크 테스트 + 빌드/설치 검증 | `pnpm -r build/test` green, `install.sh`로 동료 실행, README 갱신 |
| 7 | `/ship` → PR + 회고 KPT(`.context/retros/2026-05-29-c12-…md`) | PR·CI green, 회고 작성 |

## 보안

- **read-only → read-write 전환**: kill만 write. 기본 `127.0.0.1` 바인딩으로 외부 접근 차단.
- LAN 노출(`HOSTNAME=0.0.0.0`) 시 `CM_BEARER_TOKEN` 필수 — write(kill) 요청은 토큰 없으면 거부.
- kill 대상은 프로브가 sessionId로 검증한 pid만. kill 직전 재검증으로 TOCTOU/오살(誤殺) 방지.
- 임의 pid·임의 명령 실행 경로 없음. `ps` 출력 파싱은 읽기 전용.

## 전체 검증 (E2E)

```bash
pnpm install && pnpm -r build && pnpm -r test     # 전부 green
~/bin/claude-monitor-web                           # 또는 pnpm dev → 127.0.0.1:11314
```
브라우저: ① worktree들이 프로젝트 1개로 통합 → ② 그룹 토글 → ③ 카드에 러너/모델/모드/컨텍스트% 표시 → ④ 라이브 SSE 갱신 → ⑤ 카드 클릭→상세+usage 추이 → ⑥ 안 쓰는 세션 kill(확인 다이얼로그)→stop 전환 → ⑦ 필터/age 즉시 반영 → ⑧ 서버 재시작 시 재연결+재동기화 → ⑨ 잘못된 세션 URL→not-found.

## 리스크 / 열린 점

- **컨텍스트 한도**: 프로세스 인자에 `[1m]` 없거나 프로브가 못 잡은 세션은 모델별 기본 한도 테이블에 의존(추정 표시). 한도 불명 시 토큰 수만 표시.
- **러너 판별**: 경로 휴리스틱 — Claude/Conductor 버전 업데이트로 경로가 바뀌면 `unknown` 폴백. 깨져도 치명적이지 않음.
- **projectKey 휴리스틱**: 비표준 디렉토리 구조는 통합 안 될 수 있음 → 경로 그대로 표시(분리 폴백, 데이터 손실 없음).
- **kill 권한**: 동일 OS 유저 프로세스만 kill 가능(권한 경계는 OS가 강제).
- **usage 추이 파싱 비용**: 큰 transcript 전체 재스캔은 비쌈 → 상세 진입 시에만 계산, 필요하면 증분/상한.
