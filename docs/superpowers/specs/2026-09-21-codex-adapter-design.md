# Codex 세션 어댑터 — 설계

- 날짜: 2026-09-21
- 상태: 자율 모드 진행 (가정 명시, 사용자 사후 검토)
- 대상 브랜치: `bern` (origin/main 기준)

## Context

claude-monitor는 `~/.claude/projects/`의 Claude Code 트랜스크립트를 읽어 프로젝트별 세션을 보여주는 로컬 대시보드다. Claude Desktop cowork(#7)과 claude.ai chat(#8) 어댑터가 같은 `AISessionAdapter` 계약으로 추가되어 있다.

사용자 요청: **Codex(OpenAI Codex CLI / Codex Desktop)에서 실행한 프로젝트도 함께 모니터링**되게 할 것.

## 조사 결과 (2026-09-21, 이 머신 기준)

- codex-cli 0.154.0. 로그: `~/.codex/sessions/YYYY/MM/DD/rollout-<로컬시각>-<thread-uuid>[_<window-uuid>].jsonl`. 92개 파일, cli_version 0.116~0.154 혼재.
- 레코드 공통 형태: `{timestamp: ISO, ordinal: number, type, payload}`. `ordinal`은 0.116 파일에도 존재한다.
- `type` 분포: session_meta, event_msg(item_completed·token_count·task_started·task_complete·thread_settings_applied·user_message·agent_message·turn_aborted…), response_item(message·reasoning·function_call·function_call_output·custom_tool_call·custom_tool_call_output·agent_message·compaction), turn_context, token_usage_record(0.153+), world_state, compacted, realtime_item, inter_agent_communication_metadata.
- **첫 줄은 항상 `session_meta`**: `id`(thread id), `session_id`, `cwd`, `originator`("Codex Desktop" | "codex_work_desktop" | "codex_exec"), `cli_version`, `source`("vscode" | "exec" | `{subagent: {thread_spawn: {parent_thread_id, agent_nickname, agent_path}}}` | `{subagent: {other: "guardian"}}` | `{subagent: "review"}`), `thread_source`(user | avatar_quick_chat | voice_chat | subagent | guardian_review, 구버전은 없음), `parent_thread_id`, `subagent_history_start_ordinal`, `forked_from_id`, `history_base`, `git{commit_hash, branch, repository_url?}`(71/120).
- 턴 경계: `event_msg.task_started{turn_id, model_context_window}` → … → `event_msg.task_complete{last_agent_message}` | `event_msg.turn_aborted{reason}`. 파일 마지막 레코드: task_complete 75, turn_aborted 3, thread_settings_applied 12(수동적 레코드), item_completed 2.
- 사용자 입력: `response_item.message{role:"user", content:[{type:"input_text", text}]}`. 같은 role로 앱 주입 wrapper가 섞임(빈도순): `<recommended_plugins>` 43, `<environment_context>` 36, `<realtime_delegation>` 27, `# Files mentioned by the user` 14, `<send_user_message_question_reply>` 10, `# Files pasted by the user` 3, `# Selected text` 2, `<turn_aborted>` 1, `# AGENTS.md instructions` 1, `<user_action>` 1. 실제 사용자 텍스트 327.
- 어시스턴트 텍스트: `response_item.message{role:"assistant", phase: "commentary"|"final_answer", content:[{type:"output_text", text}]}`.
- 도구: `response_item.function_call{name, arguments(JSON 문자열), call_id}`(exec_command 69, js 135, spawn_agent 33, send_message 68, followup_task 25, wait/sleep/update_plan/request_user_input_async/list_agents/wait_agent) + `response_item.custom_tool_call{name:"exec", input: JS 코드}` 625(그 중 `cmd:"…"` 패턴 369, 나머지는 `tools.web__run({…})` 등).
- 토큰: `event_msg.token_count{info: {total_token_usage, last_token_usage, model_context_window} | null, rate_limits}`. 사용량 필드: input_tokens(캐시 포함), cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens(=input+output). info null 3/1287. **연속 동일 last_token_usage 62/1284** → 마지막값 합산은 과대집계, 누적값 차분 필요. 누적값 감소(리셋) 2건.
- 서브에이전트(thread_spawn): 별도 파일. 첫 meta가 자기 것(parent_thread_id 포함), 두 번째 레코드로 부모 meta 사본, 이어서 부모 히스토리 사본. `subagent_history_start_ordinal`부터 자기 기록(파일 내 ordinal은 0부터 재번호). `spawn_agent` 인자: `{task_name, fork_turns, message(암호화)}`.
- guardian(`source.subagent.other:"guardian"`, thread_source guardian_review): 35/120. 부모 행동 승인 검토용 내부 스레드. 사용자 메시지가 "The following is the Codex agent history whose request action you are assessing…"로 시작.
- 압축 새 창: `…<thread>_<window>.jsonl` 2건. 같은 `id`, `history_base{thread_id, end_ordinal_exclusive, end_byte_offset}`, ordinal이 원본 파일 뒤를 이음. 원본은 turn_aborted로 끝남.
- `turn_context.cwd`는 meta.cwd와 항상 동일(414/414). `turn_context.model`, `approval_policy`, `sandbox_policy`, `effort` 제공.
- 프로세스: Codex Desktop은 `codex app-server` 단일 프로세스가 모든 스레드 처리. argv에 thread id 없음 → 스레드별 pid 매핑 불가. `~/.codex/thread-writer-locks/<thread>.lock`(0바이트)이 있으나 앱 실행 중 열린 스레드 전부에 남아 라이브 신호로 부적합.

## 가정

1. `CM_ENABLE_CODEX` 기본 true(디렉터리가 없으면 세션 0개), `CM_CODEX_DIR` 기본 `~/.codex/sessions`.
2. 토큰 수치 정의는 Claude 어댑터의 metricTokens와 비교 가능한 **비캐시 입력 + 캐시 쓰기 + 출력** = `(input_tokens − cached_input_tokens) + cache_write_input_tokens + output_tokens`. 누적값(total_token_usage) 차분으로 이벤트별 증분을 구하고, 컴포넌트 감소 시 리셋으로 보고 현재값을 증분으로 삼는다.
3. 컨텍스트 = `last_token_usage.total_tokens − reasoning_output_tokens`, 한도 = `model_context_window`(token_count 또는 task_started). Codex TUI의 `tokens_in_context_window` 공식으로 기억하나 소스 미검증 → 코드 주석에 가정 표기. 한도 정보가 없으면 context null.
4. thread_spawn이 아닌 subagent(guardian, review)는 목록에서 제외. thread_spawn은 `ref.parentId = parent_thread_id`로 자식 표시, 자식 파일의 부모 사본(ordinal < subagent_history_start_ordinal)은 건너뜀.
5. 압축 새 창 파일은 별도 세션. id = 파일명에서 `rollout-<시각>-`을 뗀 나머지(`<thread>` 또는 `<thread>_<window>`).
6. RunnerKind에 `codex`(CLI/exec/기타)와 `codex-desktop`(originator "Codex Desktop"·"codex_work_desktop") 추가.
7. pid null(Kill 미노출). 프로세스 프로브는 Codex에 적용하지 않음.
8. 범위 밖: bash CLI, Claude 사용량 게이지(`lib/usage.ts`)에 Codex 합산, sqlite(state/thread_history) 활용, 다중 파일 스레드 병합.
9. Codex 세션은 `CM_MAX_AGE_HOURS` 컷오프 면제 대상이 아니다(라이브 데이터).

## 접근 방식 결정

**A. `packages/adapter-claude-code/src/codex/` 하위 모듈** (채택). cowork·chat과 동일 위치, `tailLines` 직접 공유, web 배선 변경 최소(next.config externals·install.sh·web deps 무변경).

기각: B 새 패키지(tail 공유를 위한 패키지 간 의존 + install.sh/next.config/lockfile 변경), C Claude 형태 normalize 후 fold 재사용(턴 이벤트·누적 토큰·JS 도구 호출 구조 불일치로 정확도 손실).

## 컴포넌트

### `codex/constants.ts`
- `CODEX_ADAPTER_ID = "codex"`, `CODEX_DISPLAY = "Codex"`, `defaultCodexDir()` = `~/.codex/sessions`.

### `codex/meta.ts` (session_meta 해석, 순수 함수)
- `parseCodexMeta(line) → CodexMeta | null`: id, cwd, originator, cliVersion, parentThreadId, kind("user" | "subagent" | "hidden"), agentNickname, subagentHistoryStartOrdinal.
- `kind`: `source`가 문자열 → user; `source.subagent.thread_spawn` → subagent; 그 외 subagent(guardian·review 등) → hidden.
- `runnerFromOriginator(originator) → RunnerKind`.
- `codexSessionIdFromPath(path) → string | null`: `rollout-<ts>-` 접두 제거, `.jsonl` 제거. 형식 불일치 시 null.

### `codex/watcher.ts`
- chokidar `depth: 3`(YYYY/MM/DD/파일), `ignoreInitial: false`, `ignored`: 숨김 세그먼트. 에러 무시 가드(cowork 동일).
- `scan()`: `YYYY/MM/DD` 순회, `rollout-*.jsonl`마다 `refFromPath`.
- `refFromPath(path)`: stat + **첫 줄만 읽어** meta 파싱(base_instructions 때문에 첫 줄이 수십 KB일 수 있음 → 스트리밍으로 첫 `\n`까지). hidden → null. ref: `{id, adapterId, workspace: cwd, workspaceShort: shortenWorkspace(cwd), projectKey/Label/owner: projectIdentityFromCwd(cwd), source, mtime, parentId?}`.
- 첫 줄이 아직 없으면(빈 파일) null → 다음 change 이벤트에서 재시도.
- unlink → `removed{refId}`.

### `codex/parser.ts`
`CodexState`와 `foldCodex(state, line)`:
- `session_meta`(첫 것만): cwd, version(cli_version), originator, subagentStart. 두 번째 meta 이후는 무시.
- prefix skip: `subagentStart != null && ordinal != null && ordinal < subagentStart` → 레코드 무시(타임스탬프도 반영하지 않음).
- 타임스탬프: 모든 레코드의 `timestamp` → firstTsMs/lastTsMs.
- `event_msg.task_started`: contextLimit ← model_context_window; endedTurn=false.
- `event_msg.task_complete` / `turn_aborted`: endedTurn=true; turn_aborted → sawCancelled=true(자식 lifecycle용). task_complete → lastStopClean=true.
- `event_msg.token_count`(info 있을 때): contextLimit ← model_context_window; contextTokens ← last.total − last.reasoning; 누적 metric 차분 → totalTokens/turnTokens 증가, firstTokenTsMs 설정(증분>0인 첫 이벤트).
- `turn_context`: model, mode(approval_policy).
- `response_item.message role=user`: wrapper 필터 통과 시 userTurns push(200자), userResponses push(""), turnTokens=0, lastUserTurnTsMs=ts, endedTurn=false.
- `response_item.message role=assistant`: output_text 결합 → lastText(200자), userResponses[last]; endedTurn=false.
- `response_item.function_call`: toolCount++, lastToolName=name, detail(exec_command→cmd, spawn_agent→task_name, js→코드 앞 60자, 그 외 null); endedTurn=false.
- `response_item.custom_tool_call name=exec`: toolCount++; `tools.<name>(` 매치 시 lastToolName=<name>, detail=`cmd:"…"` 매치 값 또는 `q:'…'` 매치 값; endedTurn=false.
- 사용자 wrapper 필터 `isCodexHumanTurn(text)`: 공백 제거 후 빈 문자열, `<`로 시작, `# Files mentioned by the user`, `# Files pasted by the user`, `# Selected text`, `# AGENTS.md instructions` 로 시작하면 제외.

### `codex/reader.ts`
- cowork reader 구조 미러: 직렬화 큐, 절단 감지, `tailLines` 재사용, 부분 줄 롤백.
- activitySec = lastTsMs ?? mtime. status = 자식이면 statusFromMtime, 아니면 deriveSessionStatus(age, endedTurn, false).
- agentStatus(자식): sawCancelled → cancelled; lastStopClean → done; 그 외 statusFromMtime==stop ? done : running.
- metrics(자식): tokens/toolCount/duration. runner: runnerFromOriginator. pid null. pendingSubagents [].
- context: contextTokens·contextLimit 모두 있을 때 computeContext.

### `codex/usage-series.ts`
- `readCodexUsageSeries(source)`: token_count마다 `{ts, tokens: 컨텍스트 토큰}` (최대 500).
- `readCodexTokenTimeline(source)`: token_count마다 `{ts, tokens: 증분 metric}` (0 제외 안 함, 호출부가 `tokens <= 0` 스킵).

### `codex/adapter.ts`
- `CodexAdapter implements AISessionAdapter` — cowork adapter와 동일 구조.

### web
- `lib/config.ts`: `enableCodex`(`CM_ENABLE_CODEX`, 기본 true), `codexDir`(`CM_CODEX_DIR`, 기본 defaultCodexDir()).
- `lib/data-source/local.ts`: enableCodex 시 등록. `enrich()`의 git remote·프로젝트 루트 그룹핑 게이트를 `hasRepoWorkspace(adapterId)`(claude-code | codex)로 확장. ps 프로브 게이트는 claude-code 유지.
- `lib/token-series.ts`(신규): `usageSeriesFor(ref)` / `tokenTimelineFor(ref)` — adapterId가 codex면 Codex 함수, 아니면 기존 함수. `app/session/[id]/page.tsx`, `lib/project-activity.ts`가 이를 사용(프로젝트 활동은 source→adapterId 매핑 필요).
- `core/types/session.ts` RunnerKind 확장, `RunnerBadge.tsx` STYLE/COMPACT, `i18n/ko.ts` runner 라벨(`codex: "Codex"`, `"codex-desktop": "Codex Desktop"`).
- README: 설정표 2행, 참고 문단, 아키텍처·레포 구조·API `adapter` 값.

## 데이터 흐름

watcher(첫 줄 meta로 ref) → LocalDataSource(adapter.open → CodexReader) → readIncremental(tail + foldCodex) → SessionSummary → enrich(git remote 그룹핑) → SSE/API → 대시보드(Claude 세션과 같은 프로젝트 그룹에 섞여 표시).

## 에러 처리

- 첫 줄 미완성/JSON 오류 → ref 생성 보류(다음 이벤트 재시도).
- 본문 부분 줄 → tailLines 롤백(기존 동작).
- token_count.info null → 무시. 컴포넌트 감소 → 리셋 처리.
- chokidar error → 무시 가드.

## 테스트

- `__tests__/codex-meta.test.ts`: meta 파싱(user/subagent/hidden/구버전 thread_source 없음), id 추출(원본·`_window`·비정형), runnerFromOriginator.
- `__tests__/codex-parser.test.ts`: wrapper 필터, 토큰 차분(중복 이벤트·리셋), 도구 상세(exec_command/custom exec cmd/web__run), 턴 래치(task_complete 뒤 thread_settings_applied가 와도 유지), prefix skip.
- `__tests__/codex-reader.test.ts`(fixtures `fixtures/codex/*.jsonl`, 실제 레코드 익명화): simple(waiting), inflight(live, endedTurn false), subagent(child: parentId, prefix 제외, agentStatus done), aborted(cancelled), partial line 재시도, 동시 호출 직렬화.
- `__tests__/codex-watcher.test.ts`: scan이 user·subagent만 yield, guardian 제외, 빈 파일 무시, unlink removed.
- `__tests__/codex-usage-series.test.ts`: 시계열 값과 reader totalTokens 일치.
- web `lib/__tests__/config.test.ts`(신규 또는 기존 확장): 기본값·플래그. `token-series.test.ts`: 분기.

## 비목표

CLI, Claude 사용량 게이지 합산, sqlite 활용, 다중 파일 스레드 병합, Codex 프로세스 kill, guardian 스레드 표시.
