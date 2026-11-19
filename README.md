# claude-monitor

한 대의 Mac에서 프로젝트별 AI 사용량, 실행 신호, 작업과 결과를 확인하는 로컬 모니터.

## 1. claude-monitor란?

claude-monitor는 로컬 Claude Code 기록에서 프로젝트별 기간 사용량을 집계하고, 선택적인 hook으로 실행·대기 신호를 관측합니다. 작업 이름과 여러 실행을 연결하고 결과물·사용자 완료 확인을 남길 수 있습니다. 원본 트랜스크립트는 수정하지 않습니다. 로컬 원장과 사용자가 입력한 작업 기록만 관리합니다.

첫 화면 실시간 모니터(`/`)에는 최근 요청·컨텍스트·도구·하위 에이전트와 명시적인 종료(Kill) 기능이 유지됩니다. 새 개요·리포트는 처리 토큰과 API 환산 비용을 제공하며, 실제 청구액·구독 한도·업무 성과와 구분합니다.

첫 화면이자 주 메뉴 첫 항목인 **실시간 모니터**(`/`)는 세션·메시지·도구·하위 실행을 로그 변경에 따라 SSE로 갱신합니다(예전 `/sessions` 주소는 쿼리를 유지한 채 `/`로 이동). `/overview`에서 오늘 사용량을 보고, `/usage`에서 기간별 리포트, `/projects`에서 프로젝트 매핑, `/runs`에서 hook 기반 실행·대기 근거, `/work`에서 작업과 결과, `/settings`에서 백업·진단을 확인합니다. 모든 화면은 같은 사이드바·글꼴(UI 산세리프, 숫자·ID·로그 모노)을 쓰며, 상단의 `자동/다크/라이트`로 화면 모드를 바꿉니다(자동은 macOS 설정을 따르고 선택은 이 브라우저에 기억). 새 리포트·실행 화면의 조회 간격은 2초이며, hook 미연결 상태는 미확인으로 표시합니다. 기능별 연결 방법과 남은 실사용 검증은 아래 [개인용 로컬 모니터](#개인용-로컬-모니터-l1l3)를 참고하세요.

---

## 2. 설치 & 실행

### 설치

저장소 루트에서 다음을 실행합니다.

```bash
bash scripts/install.sh
```

이 명령은 다음을 설치합니다.

- CLI → `$HOME/bin/claude-monitor`
- macOS 앱 → `$HOME/Applications/ClaudeMonitor.app`
- 웹 실행기 → `$HOME/bin/claude-monitor-web`

설치 스크립트는 Next.js 웹 UI를 빌드한 뒤 실행 스크립트를 설치합니다. 스크립트는 **멱등(idempotent)** 하므로 다시 실행해도 안전합니다(재실행 시 `ClaudeMonitor.app`과 실행 스크립트에 박힌 저장소 경로를 덮어씁니다).

**사전 요구사항(웹 UI):** Node `>=24.11.0 <25`, pnpm `>=10 <11`. 설치·시작 시 버전을 검사하고 지원 범위를 벗어나면 원인을 출력하고 중단합니다. 웹 설치의 런타임 검사는 기존 설치 파일을 바꾸기 전에 실행합니다. CLI만 설치하려면 다음을 사용하세요.

```bash
SKIP_WEB=1 bash scripts/install.sh
```

> 참고: 설치 스크립트는 실행 스크립트 안의 저장소 경로 자리표시자(`@@CM_REPO_ROOT@@`)를 설치 시점의 실제 경로로 치환합니다. 따라서 설치 후 저장소를 다른 위치로 옮기면 다시 설치해야 합니다.

### 의존성

- **macOS** — `sips` · `iconutil` · `osacompile` · `Terminal.app` (시스템 기본 제공)
- **`jq`** (버전 무관) — CLI가 JSONL 파싱에 사용
- **`watch`** — `.app` 런처에서만 필요 (`brew install watch`)
- **웹 UI** — Node 24.11 이상 24.x, pnpm 10.x. `node -v`, `pnpm -v`로 확인합니다.
- **SQLite native 모듈** — 현재 Mac arm64에서 `better-sqlite3@13.0.3`의 node-gyp 설치를 확인했습니다. 소스 빌드 환경에는 Xcode Command Line Tools와 Python이 필요합니다.
- **아이콘 재빌드 시에만** — `rsvg-convert` (`brew install librsvg`) + ImageMagick (`brew install imagemagick`)

### 웹 UI 실행

설치 후:

```bash
$HOME/bin/claude-monitor-web
```

저장소에서 처음 실행할 때는 의존성과 패키지를 먼저 빌드합니다.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

개발 모드는 `pnpm dev`입니다. 이 명령은 core·adapter·collector를 먼저 빌드한 뒤 개발 서버를 시작합니다. 공유 패키지의 TypeScript 코드를 수정했다면 다시 빌드하고 개발 서버를 재시작합니다. 화면/API의 개발 재로딩은 같은 collector worker를 유지합니다.

`pnpm start`와 설치된 실행기는 `scripts/web.mjs`를 통해 HTTP 서버와 collector를 시작·종료합니다. `next start`를 직접 실행하면 이 수명 관리 경계를 거치지 않으므로 사용하지 않습니다. 사용자 정의 서버는 현재 로컬 실행 방식이며 Next.js standalone 배포는 구성하지 않았습니다.

### 접속 URL

기본 포트는 **11314** 이며, localhost에만 바인딩됩니다.

```
http://127.0.0.1:11314
```

### 로그인 자동 시작(선택)

로그인할 때 웹 UI가 자동으로 켜지도록 macOS LaunchAgent를 함께 설치하려면:

```bash
WITH_LAUNCHAGENT=1 bash scripts/install.sh
```

이 경우 `$HOME/Library/LaunchAgents/com.indm.claude-monitor-web.plist`가 설치되고, 로그는 `$HOME/Library/Logs/claude-monitor-web.log`에 기록됩니다. launchd는 셸 설정을 읽지 않으므로 설치 시점에 확인한 node·pnpm 폴더를 plist의 `PATH`에 기록합니다. nvm 등으로 Node 버전을 바꾼 뒤에는 이 명령을 다시 실행하세요.

### CLI 실행

웹 UI 대신 터미널 뷰를 쓰려면:

```bash
claude-monitor
```

사용 가능한 플래그:

- `--all` : 멈춘(stopped) 세션까지 모두 표시
- `--max-age-hours N` : 표시 대상 나이 컷오프(기본 24시간)
- `--filter PATTERN` : 프로젝트 디렉터리 glob 필터 (예: `--filter '*indm-codegen*'`)

CLI 역시 `$HOME/.claude/projects/`의 JSONL 트랜스크립트를 **읽기 전용**으로만 사용합니다.

연속 갱신은 `watch`로:

```bash
watch -ct -n 3 claude-monitor
```

또는 `$HOME/Applications/ClaudeMonitor.app`를 더블클릭하면 위 명령을 실행하는 터미널 창이 열립니다.

### 종료 / 언인스톨

웹 UI는 실행한 프로세스를 종료하면 멈춥니다(LaunchAgent로 띄운 경우 LaunchAgent를 unload).

설치된 산출물을 제거하려면 저장소 루트에서:

```bash
bash scripts/uninstall.sh
```

이 명령은 CLI(`$HOME/bin/claude-monitor`), 웹 실행기(`$HOME/bin/claude-monitor-web`), macOS 앱(`$HOME/Applications/ClaudeMonitor.app`), 그리고 존재한다면 LaunchAgent plist를 제거합니다. 저장소 소스 파일은 그대로 남습니다.

---

## 3. 설정 (환경변수)

웹 UI의 동작은 환경변수로 조정합니다. `PORT`, `HOSTNAME`은 공통 서버 진입점에서 읽고 기본값은 `scripts/web-config.json`에 둡니다. `CLAUDE_PROJECTS_DIR`와 `CM_*` 변수는 해당 설정 로딩 시 읽습니다. collector 설정을 바꾼 뒤에는 서버를 재시작합니다.

| 변수 | 역할 | 기본값 |
|---|---|---|
| `CM_ACTIVE_THRESHOLD_SEC` | 세션 나이가 이 값보다 작으면 `live`로 분류 | `60` (초) |
| `CM_RECENT_THRESHOLD_SEC` | 나이가 이 값보다 작으면 `idle`, 그 이상이면 `stop`으로 분류. `waiting` 상태도 이 임계값 안에서만 적용 | `600` (초, 10분) |
| `CM_MAX_AGE_HOURS` | 실시간 모니터(`/`)와 `/api/sessions`가 반환하는 세션 나이 컷오프. 새 원장 리포트에는 적용하지 않음 | `24` (시간) |
| `CM_BEARER_TOKEN` | health를 제외한 조회·관리 API 인증. 설정하면 `Authorization: Bearer <token>` 헤더 필요 | 미설정 (null) |
| `CM_BLOCK_TOKEN_LIMIT` | 토큰 사용량 게이지의 5시간 블록 분모(계정 블록 한도). 양의 정수만 유효 | 미설정 → 최근 피크값 사용 |
| `CM_WEEKLY_TOKEN_LIMIT` | 토큰 사용량 게이지의 7일 분모(주간 한도). 양의 정수만 유효 | 미설정 → 최근 피크값 사용 |
| `PORT` | 웹 UI HTTP 포트(`pnpm dev/start`, 설치 실행기 공통) | `11314` |
| `HOSTNAME` | 웹 UI 바인딩 주소. L1–L3는 loopback 개인용이며 관리 쓰기는 loopback Host만 허용 | `127.0.0.1` (localhost 전용) |
| `CLAUDE_PROJECTS_DIR` | 세션 트랜스크립트(JSONL) 소스 디렉터리 | `$HOME/.claude/projects` |
| `CM_ENABLE_COWORK` | Claude Desktop **cowork**(local-agent-mode) 대화를 세션 목록에 노출. `1`/`true`/`yes`/`on`이면 켜짐 | 미설정 → `false` (꺼짐) |
| `CM_COWORK_DIR` | cowork 세션 루트 디렉터리 | `$HOME/Library/Application Support/Claude/local-agent-mode-sessions` |
| `CM_ENABLE_CHAT` | Claude Desktop의 **claude.ai 일반 채팅** 대화를 세션 목록에 노출(실험 기능). `1`/`true`/`yes`/`on`이면 켜짐 | 미설정 → `false` (꺼짐) |
| `CM_CHAT_IDB_DIR` | Claude Desktop IndexedDB 루트(그 아래 `https_claude.ai_*.indexeddb.blob`을 스캔) | `$HOME/Library/Application Support/Claude/IndexedDB` |
| `CM_ENABLE_CODEX` | OpenAI **Codex**(CLI·Desktop) 세션을 실시간 모니터와 영속 원장(개요·사용량·실행)에 포함. `1`/`true`/`yes`/`on`이 아닌 값이면 꺼짐 | 미설정 → `true` (켜짐) |
| `CM_CODEX_DIR` | Codex rollout 로그 루트(`YYYY/MM/DD/rollout-*.jsonl`) | `$HOME/.codex/sessions` |
| `CM_COLLECTOR_ENABLED` | 새 원장 worker 시작 여부 (`true/false`, `1/0`) | `true` |
| `CM_DATA_DIR` | SQLite와 백업을 둘 전용 절대 경로 | macOS: `$HOME/Library/Application Support/Claude Monitor` |
| `CM_TIMEZONE` | 새 원장의 초기 IANA 시간대; 기존 DB 설정은 유지 | 기기 시간대 |
| `CM_DB_BUSY_TIMEOUT_MS` | 사용량 DB의 busy 대기 상한 | `5000` |
| `CM_COLLECTOR_BATCH_SIZE` | 수집 transaction의 관측 batch 상한 | `250` |
| `CM_COLLECTOR_POLL_MS` | 원천 변경 확인 주기 | `1000` |
| `CM_COLLECTOR_STARTUP_TIMEOUT_MS` | worker 시작 대기 상한 | `30000` |
| `CM_COLLECTOR_SHUTDOWN_TIMEOUT_MS` | 정상 종료 대기 후 worker 종료 상한 | `5000` |

> `CM_BEARER_TOKEN`: 새 리포트·실행·작업·설정 화면은 접근 토큰 입력 후 API를 호출합니다. 토큰은 페이지 메모리에만 두므로 새로고침 뒤 다시 입력합니다. 실시간 모니터(`/`)의 SSE·Kill UI에는 토큰 입력이 없어 토큰 모드에서 사용할 수 없습니다. HTML 화면 자체는 인증 경계가 아니며 API가 데이터를 보호합니다. hook 수신은 별도의 hook 토큰(`CM_RUNTIME_HOOK_TOKEN` 또는 데이터 폴더의 `runtime-hook.token`)을 요구합니다.
>
> 주의 (`CM_BLOCK_TOKEN_LIMIT` / `CM_WEEKLY_TOKEN_LIMIT`): 양의 정수가 아니면 미설정으로 간주되어 최근 피크값을 분모로 사용합니다.
>
> 참고 (`CM_ENABLE_COWORK`): 켜면 Claude Desktop cowork 세션이 `Claude Desktop` 러너 배지와 함께 한 프로젝트 그룹으로 묶여 표시됩니다. cowork는 본질적으로 과거 데이터일 수 있어 **`CM_MAX_AGE_HOURS` 컷오프에서 면제**됩니다(플래그를 켜면 나이와 무관하게 표시 — `status`·`filter` 필터는 그대로 적용). cowork `audit.jsonl`은 추가-전용(append-only) 로그라 일반 세션과 동일한 증분 와칭으로 라이브 갱신되며, 슬래시 명령 전용 턴은 (Claude Code와 동일하게) 프롬프트 라벨로 표시되지 않고, 토큰 합계는 공유 파서의 기존 집계 방식을 따릅니다.
>
> 참고 (`CM_ENABLE_CHAT`, 실험 기능): claude.ai 웹뷰가 IndexedDB에 남기는 react-query 캐시를 읽어 **최근 대화 목록**(제목·요약·모델·최근 활동, 라이브)을 `Claude Chat` 그룹으로 표시합니다. 최근에 **연** 대화는 캐시에 전문(tree)이 남아 있어 턴 내역까지 보이고, 나머지는 메타데이터만 보입니다(전체 이력 미러 아님 — 캐시에 있는 만큼만). cowork와 달리 `CM_MAX_AGE_HOURS` 컷오프가 **그대로 적용**됩니다(목록이 라이브라 최근 활동 채팅이 자연스럽게 노출; 전체는 `all` 파라미터로 열람). 캐시 포맷·앱 스키마는 claude.ai 배포에 따라 바뀔 수 있으며, 이 경우 어댑터는 에러 대신 **빈 결과로 조용히 강등**됩니다.
>
> 참고 (`CM_ENABLE_CODEX`): `~/.codex/sessions`의 rollout JSONL을 읽어 Codex 세션을 **Claude Code 세션과 같은 프로젝트 그룹**에 표시합니다(cwd의 git remote 기준 통합). 러너 배지는 `Codex`(CLI/`codex exec`) 또는 `Codex Desktop`입니다. Codex가 `spawn_agent`로 띄운 하위 스레드는 부모 카드 아래 하위 에이전트로 나오고, Codex 내부 승인 검토(guardian) 스레드는 표시하지 않습니다. 컨텍스트 압축 뒤 이어지는 새 창 파일(`…_<window>.jsonl`)은 별도 세션으로 표시됩니다. 스레드별 프로세스가 없어 Kill 버튼은 제공되지 않으며, 토큰 수치는 Claude와 같은 기준(비캐시 입력 + 출력)으로 집계되어 Codex 자체 합계(캐시 포함)와 다릅니다. Codex 토큰은 상단 Claude 사용량 게이지(5시간/7일)에는 합산되지 않습니다. 영속 원장(개요·사용량·실행)에는 응답 단위 기록(`token_usage_record`, CLI 0.153 이상)만 `response_id`로 한 번씩 합산하고, 입력은 Claude와 같이 캐시 제외분으로 저장합니다(관측 토큰 = Codex 자체 합계). 응답 id가 없는 구버전 파일은 진단 `missing_response_id`로만 남고, 내부 검토 스레드 토큰은 실행 없이 합산합니다. 단가 출처가 없어 비용은 미산정이며, 개요·사용량의 `도구` 필터로 Claude Code/Codex를 나눠 볼 수 있습니다. 실행 화면의 Codex 상태는 rollout의 작업 시작·항목 완료·응답 종료로 판단하며 승인·입력 대기와 프로세스 생존은 관측하지 않습니다.
>
> collector `ready`는 DB와 worker 준비를 의미합니다. `ingestionState`로 첫 색인(indexing), 감시(watching), 일부 기록(partial), 오류(error)를 별도로 확인하세요. 새 사용량 리포트는 영속 원장을 사용하며 기존 세션 탐색은 기존 어댑터를 유지합니다.

DB 디렉터리는 현재 OS 사용자 전용이어야 합니다(디렉터리 `0700`, 파일 `0600`). 공유 폴더·네트워크 디스크 대신 로컬 전용 경로를 사용합니다. 이미 존재하는 공개 디렉터리는 권한을 임의 변경하지 않고 오류를 표시하므로 새 전용 디렉터리를 지정하세요. DB는 `usage.sqlite`, writer 잠금은 `writer.sqlite`입니다. 실행 중 잠금 파일을 삭제하지 않습니다.

`GET /api/collector` 또는 `/api/health`의 `collector` 필드에서 `ready`, `disabled`, `error`와 진단 코드를 확인합니다. `writer_busy`면 같은 데이터 디렉터리를 사용하는 다른 앱을 종료한 뒤 재시작합니다. `database_corrupt`, `schema_too_new`, `migration_failed` 상태에서 DB를 지워 빈 DB로 대체하지 마세요. 비활성화가 필요하면 `CM_COLLECTOR_ENABLED=false pnpm start`로 기존 세션 화면만 실행할 수 있습니다.

마이그레이션 전 백업은 SQLite backup API로 `backups/`에 생성하며, 복원은 기존 DB를 보존하고 새 전용 디렉터리에서 수행합니다. 제거 스크립트는 사용량 DB를 삭제하지 않습니다.

---

## 4. 실시간 모니터 (`/`)

이 절부터 9절까지는 실시간 모니터 화면과 CLI의 설명입니다. 영속 원장을 쓰는 개요·리포트는 `/overview` 등 별도 메뉴에 있습니다.

### 상단 헤더 (고정)

화면 맨 위에 고정된 헤더가 붙어 있으며, 다음을 포함합니다.

- **제목 `실시간 모니터`** — 앞에 `LIVE` 표시 글리프(◐)가 라이브 색으로 붙습니다. 화면 이동은 왼쪽 사이드바(좁은 화면에서는 상단 메뉴)를 씁니다.
- **토큰 사용량 게이지(UsageBar)** — 두 개의 게이지를 나란히 보여 줍니다.
  - `5h` : 5시간 사용 창
  - `7d` : 7일 사용 창
  - 각 게이지는 가느다란 가로 막대 + 사용률(%)/토큰값 + 리셋 시각 표시(`↻HH:MM`, 예: `↻14:30`)로 구성됩니다. 리셋 표시에 마우스를 올리면 다음 리셋까지 남은 시간(예: `3h 45m`)이 툴팁으로 보입니다.
  - **색상 의미:** 70% 미만 = 초록, 70~89% = 노랑/앰버, 90% 이상 = 빨강.

연결이 끊겼거나 숨긴(dismiss) 세션이 있으면 헤더 아래에 연결 상태와 `Restore All` 버튼이 나타납니다.

> 기존 게이지의 출처는 로컬 추정치와 선택적인 OAuth 조회입니다. 기본값은 트랜스크립트의 5시간 블록/7일 추정치이며 구독 한도와 같지 않습니다. `CM_REMOTE_USAGE_ENABLED=true`일 때만 macOS 키체인과 Anthropic 사용량 API를 조회합니다. 원격 값은 약 180초 캐시하며 인증값이 없거나 호출이 실패하면 로컬 추정치로 폴백합니다. 새 원장 리포트는 이 게이지를 사용하지 않습니다.

### 필터 바 (고정)

헤더 바로 아래에 고정된 필터 행이 있습니다.

- **시간 창 버튼:** `1h`, `24h`, `7d`, `전체`
- **상태 필터 버튼:** `All`, `LIVE`, `waiting`, `idle`, `stop`
- **프로젝트 이름 검색 입력:** glob 패턴 입력칸 (예시 placeholder `*claude-monitor*`)

선택된 버튼은 에메랄드(초록) 텍스트/테두리로, 선택되지 않은 버튼은 회색으로 표시됩니다. 버튼을 누르면 URL 쿼리스트링(`?status=live,waiting&maxAgeHours=24&filter=...`)이 갱신되고, 보이는 세션이 실시간으로 필터링됩니다. 필터 상태가 URL에 담기므로 링크로 공유하거나 새로고침해도 유지됩니다.

---

## 5. 프로젝트 그룹

세션은 프로젝트 단위로 묶여 표시됩니다. 웹 레이어는 각 세션의 작업 디렉터리(cwd)에서 `git remote get-url origin`으로 원격 저장소 URL을 조회하고 이를 정규화한 키(`git:host/owner/repo`)로 그룹을 만듭니다. 덕분에 **같은 저장소의 Conductor worktree와 일반 Claude Code 클론이 파일 경로가 달라도 하나의 그룹으로 통합**됩니다. 원격 origin을 가져올 수 없으면 cwd 경로 기반 키로 폴백합니다(예: `/conductor/workspaces/<name>` 또는 `/.worktrees/` 패턴).

각 프로젝트 그룹은 `📁 {프로젝트명}` 라벨과 세션 개수 배지를 단 **고정(sticky) 서브헤더**로 표시됩니다. 라벨 옆에는 `시작 2026. 06. 23. · 누적 토큰 (캐시 읽기 제외) 82.6M` 같은 요약이 한 줄로 붙습니다(새 리포트의 관측 토큰은 캐시 읽기를 포함하므로 값이 더 큽니다) — 상세 페이지와 같은 기준(projectKey 귀속, 첫 토큰 응답 시각)으로 **현재 필터에 보이는 세션**을 집계하며, 좁은 화면(640px 미만)에서는 프로젝트명 공간을 위해 숨겨집니다. 헤더는 반투명 배경 + 블러 처리되어 있고, 스크롤하면 상단 메인 헤더 바로 아래에 달라붙습니다. 셰브론(▾/▸)을 누르면 그룹을 접거나 펼칠 수 있으며, 접힘 상태는 localStorage에 저장되어 유지됩니다.

고정 위치는 3단으로 쌓입니다: (1) 메인 헤더 → (2) 프로젝트 그룹 서브헤더 → (3) 펼친 세션 카드의 제목 줄. 스크롤 시 펼친 카드의 제목이 프로젝트 헤더 바로 아래에 달라붙습니다.

---

## 6. 세션 카드 (접힌 상태)

접힌 카드는 한 줄 요약입니다. 카드는 기본적으로 **접힌 상태**로 시작합니다.

### 상태 점 (5종)

제목 왼쪽의 작은 점이 실시간 활동을 나타냅니다.

- `●` (꽉 찬 원, 라이브 색, 깜빡임) — live
- `◐` (반원, waiting 색, 깜빡임) — waiting
- `○` (빈 원) — idle
- `·` (점) — stop

(상세 페이지의 StatusBadge에서는 점 뒤에 `LIVE` / `waiting` / `idle` / `stop` 라벨도 함께 표시됩니다.)

### 제목 = 가장 최근 요청

카드 제목에는 해당 세션의 **가장 최근 사용자 요청**이 표시됩니다(`userTurns`의 마지막 항목). 사용자 요청 기록이 없으면 세션의 최초 프롬프트(`firstPrompt`), 그것도 없으면 마지막 어시스턴트 메시지를 잘라 보여 줍니다. 접힌 상태에서는 한 줄로 잘리고, 펼치면 줄바꿈됩니다. 제목 줄을 누르면 카드가 열리고 닫힙니다.

### 러너 배지

제목 아래에 러너 종류가 색상 배지로 표시됩니다: `conductor`(보라), `claude-code`(에메랄드), `claude-desktop`(하늘색), `agent`(앰버). 종류가 `unknown`이면 배지는 표시되지 않습니다.

> 러너 분류는 2단계입니다. 트랜스크립트의 entrypoint 값으로 1차 추정한 뒤, 실행 중인 프로세스의 커맨드 문자열을 조사한 결과(`com.conductor.app`, `/Claude.app/`, `claude-code` 등)가 `unknown`이 아니면 그 실측 결과가 우선합니다.

### 모델 · 모드

러너 배지 옆 메타 줄에 모델 이름(작은 모노스페이스, 시안색)과 모드(가운뎃점 `·` + 보라색, 예: `· batch`)가 표시됩니다. 둘 중 하나가 없으면 그 항목은 표시되지 않습니다.

### 컨텍스트 %

접힌 줄 오른쪽에 컨텍스트 사용률이 표시됩니다: `{ctxPct}%` 숫자 + 가느다란 막대(채워진 폭 = 사용률). 색상은 70% 미만 초록, 70~89% 앰버, 90% 이상 빨강입니다.

> 기본 컨텍스트 한도는 200,000 토큰으로 계산합니다. 다만 실행 프로세스의 `--model` 플래그에 `[1m]` 접미사가 있으면(예: `claude-opus-4-8[1m]`) 한도를 1,000,000으로 인식해 % 계산에 반영합니다. 사용 토큰은 사람 턴마다 0으로 리셋되고, 이어지는 어시스턴트 메시지의 input + cache_creation_input + output 토큰을 누적합니다(cache_read는 제외).

### 현재 활동 줄

메타 줄 아래 활동 줄이 붙습니다.

- 상태가 `waiting`이면 🟡 아이콘과 `⏱ Waiting for input`(번역됨)이 표시됩니다.
- 그 외에 마지막 도구(lastTool)가 있으면: 라이브 인디케이터 `◐`(라이브일 때만) + 도구 이름 + 부가 상세(`— ...`) + 경과 시간(라이브이고 턴 시작 시각이 있을 때, 예: `2m 34s`) + 토큰 소모(`↓` 접두, 예: `↓1.2k`, `↓450`) 또는 마지막 활동 이후 경과(예: `2h ago`)가 표시됩니다.

경과 시간 표기: 60초 미만 `23s`, 1시간 미만 `2m 34s`, 1시간 이상 `1h 2m`. 토큰 표기: 1M 이상 `↓1.2M`, 1k 이상 `↓450k`, 1k 미만 `↓234`. 라이브 세션의 경과·상대 시간은 1초마다 갱신됩니다.

### 마지막 어시스턴트 메시지

`lastText`가 있으면 💬 아이콘과 함께 마지막 어시스턴트 메시지를 최대 120자까지 미리보기로 보여 줍니다. 잘린 줄은 `...`로 끝납니다. 이 미리보기는 읽기 전용입니다.

### todo 체크리스트

세션에 todo가 있으면 📋 아이콘 + 완료/전체 개수(예: `3/5`) + 현재(또는 다음) 항목(최대 56자)이 표시됩니다. 현재 항목은 노란색, 다음 항목은 회색입니다. **접힌 상태에서도 항상 보입니다**(펼치지 않아도 됨).

### Kill 버튼

행에 마우스를 올리면 해골 아이콘이 나타납니다. 누르면 확인 프롬프트(예/아니오)가 뜨고, 확인 시 해당 세션을 종료합니다. 이 버튼은 **로컬 프로세스(PID)가 발견된 세션에만** 나타납니다. PID가 없으면(원격 전용 등) 버튼이 보이지 않습니다.

> Kill(`POST /api/sessions/[id]/kill`)은 `SIGTERM`을 보냅니다. 대상 PID는 `ps`에서 해당 세션의 `--resume`/`--session-id <uuid>` 인자를 가진 프로세스를 찾아 해석하며, **신호 직전에 그 PID의 커맨드라인이 여전히 해당 세션의 것인지 재확인**(TOCTOU 가드)하므로 무관하거나 재활용된 PID는 절대 죽이지 않습니다. 이 머신의 로컬 세션만 종료할 수 있습니다.

### Dismiss(숨기기) 버튼과 되돌리기

행에 마우스를 올리면 눈-가림(eye-off) 아이콘이 나타납니다. 이 버튼은 **상태가 `stop`인 세션에만** 보입니다(live/idle/waiting은 숨길 수 없음). 누르면 카드가 대시보드에서 숨겨지며(비파괴적, 트랜스크립트는 그대로), 숨긴 목록은 localStorage(`cm:dismissed`)에 저장됩니다. 숨긴 세션이 있으면 대시보드 상단에 `Restore All ({개수})` 링크가 나타나 한 번에 되돌릴 수 있습니다.

---

## 7. 세션 카드 (펼친 상태)

제목 줄을 누르면 카드가 펼쳐집니다. 펼침/접힘 상태는 세션별로 localStorage(`cm:collapsed:{세션ID}`)에 저장되며, **새로고침하거나 페이지를 이동해도 유지**됩니다. 기본값은 접힘입니다.

### 요청 히스토리 (역순 · 번호 · 최신 강조)

점선 구분선 아래에 `REQUEST` 소제목이 나오고, 세션 동안 사용자가 보낸 모든 요청이 **최신순(newest-first)** 번호 목록으로 표시됩니다. 각 항목에는 시간 순서 번호(원래 첫 요청 = 1)가 보존되어 표시됩니다. 가장 최근 요청(맨 위)은 에메랄드 테두리/라이브 색으로 강조되고, 이전 요청들은 회색으로 표시됩니다.

### todo 체크리스트

펼친 뷰에서도 현재/다음 todo 항목을 확인할 수 있습니다.

### 하위 에이전트 / 워크플로 트리

자식 세션이 있으면 요청 히스토리 아래에 `CHILD AGENTS` 소제목과 함께 중첩 트리가 표시됩니다.

- 에이전트는 워크플로(`wf_*`) 단위로 묶입니다. 워크플로는 접을 수 있는 그룹으로 표시되며(워크플로별 별도 localStorage 키) `완료/전체` 개수를 보여 줍니다.
- 워크플로에 속하지 않은 직속 하위 에이전트는 부모에서 이어지는 트렁크 선(`│`)과 함께 평평한 행으로 표시됩니다.
- 각 에이전트 행: 상태 글리프(색 점) + 라벨 + 모델 약식 + 지표(토큰 수 · 도구 수 · 소요 시간). 트렁크 색은 라이브면 에메랄드, 아니면 회색입니다.

> 하위 에이전트 트랜스크립트는 부모 세션 디렉터리 아래 `subagents/agent-<id>.jsonl` 또는 `subagents/workflows/wf_<id>/agent-<id>.jsonl` 경로에 저장되며, 워크플로 ID는 이 경로 구조에서 추출합니다. 자식 세션의 상태는 파일 수정 시각(mtime) 기반으로만 계산됩니다.

### 세션 상세 페이지 (`/session/[id]`)

카드와 별도로 세션 상세 페이지가 있습니다. 뒤로 가기 링크, 상태 배지, 프로젝트 라벨, 러너 배지, 메타데이터(워크스페이스·소스·모델·모드·버전), 컨텍스트 막대(사용% + 토큰/한도, `k` 단위)에 더해, `Usage Trend`(토큰 소모 추이 SVG 라인 차트), `Todos`, `Sub-agents`, `Last Message`(마지막 어시스턴트 메시지 전문) 섹션을 보여 줍니다.

---

## 8. 세션 상태(Status)의 의미

상태는 두 개의 시간 임계값과 트랜스크립트 내용 신호로 결정됩니다. 기본 임계값은 `activeSec=60`(초), `recentSec=600`(초, 10분)입니다.

| 상태 | 조건 | 의미 |
|---|---|---|
| `live` | 나이 < 60초 | 최근 60초 안에 트랜스크립트가 기록됨 (작업 중) |
| `idle` | 60초 ≤ 나이 < 600초 | 최근 10분 안이지만 최근 60초 동안은 기록이 없음 |
| `stop` | 나이 ≥ 600초 | 최근 임계값(10분)을 넘어 비활성 |
| `waiting` | 턴이 깔끔히 끝남(`end_turn`) + 대기 중 하위 작업 없음 + 나이 < 600초 | 다음 프롬프트를 기다리는 상태. 600초가 지나면 일반 나이 기준(`stop`)으로 폴백 |

- `live`/`idle`/`stop`은 파일 수정 시각으로 나이를 계산한 단순 버킷입니다.
- `waiting`은 최상위 세션에만 적용되는 내용 신호입니다(마지막 레코드가 어시스턴트의 `end_turn`이고 대기 중 하위 작업이 없을 때). 하위(자식) 세션은 항상 mtime 기반 상태만 사용합니다.
- 위 임계값(초 단위)은 `CM_ACTIVE_THRESHOLD_SEC`, `CM_RECENT_THRESHOLD_SEC`로 조정할 수 있습니다.

---

## 9. 액션 & 상호작용

- **카드 펼치기/접기:** 제목 줄 클릭. 상태는 세션별로 localStorage에 저장되어 유지됩니다(기본 접힘).
- **프로젝트 그룹 접기/펼치기:** 그룹 헤더의 셰브론(▾/▸) 클릭. 상태는 localStorage에 유지됩니다.
- **세션 종료(Kill):** 카드 호버 → 해골 아이콘 → 확인. 로컬 PID가 있는 세션에만 가능합니다.
- **숨기기(Dismiss) / 되돌리기:** `stop` 상태 카드 호버 → 눈-가림 아이콘으로 숨김. 상단 `Restore All` 링크로 한 번에 복원. 숨김은 비파괴적입니다.
- **검색 · 필터:** 필터 바의 시간 창 버튼, 상태 칩, 프로젝트 이름 glob 입력으로 보이는 세션을 좁힙니다. 모든 필터는 URL 쿼리스트링에 반영되어 공유·새로고침 시 유지됩니다.

---

## 10. 설계 노트 & 한계

claude-monitor의 상태와 지표는 모두 **트랜스크립트 파일(JSONL)의 수정 시각과 내용 신호**에서 파생됩니다. 별도의 진행률·완료율 메타데이터는 트랜스크립트에 존재하지 않습니다. 이 때문에 다음과 같은 한계가 있습니다.

- **ETA · "% 완료" 막대를 보여 주지 않는 이유:** 트랜스크립트에는 작업의 진행률이나 완료까지 남은 시간을 알려 주는 신호가 없습니다. 따라서 "X% 완료" 같은 막대는 근거 없는 수치를 지어내는 것이 되므로 제공하지 않습니다. 대신 컨텍스트 사용률, 토큰 소모, 경과 시간 등 실제로 측정 가능한 값만 표시합니다.
- **승인/권한 대기의 정밀 감지 불가:** 권한·승인 대기는 트랜스크립트에 아무 레코드도 남기지 않으므로 이 데이터만으로는 감지할 수 없습니다. 정밀 감지는 Claude Code 훅(hooks)이 있어야 가능하며, 현재 범위 밖입니다. `waiting` 상태는 "턴이 깔끔히 끝났는지"라는 내용 신호로 근사한 것일 뿐, 권한 대기 그 자체를 가리키지는 않습니다.
- **파일 와칭 기반:** 모니터는 트랜스크립트 디렉터리를 파일 시스템 수준에서 감시(watch)하여 동작합니다. 따라서 모든 상태는 파일이 기록되는 시점에 갱신되며, 디스크에 흔적을 남기지 않는 활동은 보이지 않습니다.
- **컨텍스트 한도 계산:** 순수 reader 클라이언트(웹 레이어 보강을 거치지 않은 경우)는 항상 200,000 토큰 기준으로 컨텍스트 %를 계산합니다. `[1m]` 한도(1,000,000)는 웹 레이어가 실행 프로세스를 조사해 보강할 때만 반영됩니다.
- **사용량 게이지 출처 차이:** 5h/7d 게이지는 OAuth 실측치(키체인 토큰 사용 가능 시) 또는 로컬 추정치 중 하나입니다. 실측 API는 레이트 리밋이 있어 약 180초간 캐시되며 실패 시 로컬 추정치로 폴백합니다. 로컬 추정치는 "estimated"로 표시됩니다.

---

## 11. 아키텍처 요약

claude-monitor는 pnpm 모노레포로, 네 개의 패키지로 구성됩니다.

- `@claude-monitor/core` — 세션 타입, 상태 임계값/파생 로직, 프로젝트 키 산출, 컨텍스트 한도 계산 등 핵심 로직.
- `@claude-monitor/adapter-claude-code` — `~/.claude/projects/`의 JSONL 트랜스크립트를 읽고, chokidar로 파일을 감시(top-level + 하위 에이전트 디렉터리)하는 어댑터. 같은 패키지에 Claude Desktop cowork(`cowork/`), claude.ai chat(`chat/`), OpenAI Codex rollout(`codex/`) 어댑터가 함께 있다.
- `@claude-monitor/collector` — SQLite 원장 schema·마이그레이션·backup API·단일 writer·worker 수명 관리. 증분 수집·리포트·관찰 신호·작업/운영 기능의 단일 writer를 담당.
- `@claude-monitor/web` — Next.js 기반 웹 UI. 어댑터를 LocalDataSource로 감싸 git remote 기반 프로젝트 통합·러너 실측·컨텍스트 한도 보강을 수행하고, API와 대시보드 화면을 제공.

**데이터 흐름:** chokidar 파일 와칭 → 변경 감지 시 트랜스크립트 파싱 → SSE(`/api/events`)로 브라우저에 실시간 푸시 → 대시보드가 1초 간격 클라이언트 틱과 함께 상대 시간/경과/상태 감쇠를 갱신.

### 레포 구조

```
bin/claude-monitor       CLI 셸 스크립트 (bash 3.2 호환, jq 기반)
app/
  build-app.sh           osacompile로 ClaudeMonitor.app 재빌드
  ClaudeMonitor.app/     사전 빌드된 런처 (커밋됨)
icons/
  src/*.svg              디자인 소스 SVG
  rendered/*.png         1024×1024 PNG (rsvg-convert 출력)
  ClaudeMonitor.icns     컴파일된 멀티해상도 아이콘
scripts/
  build-icon.sh          SVG → PNG → .icns → 앱에 설치
  install.sh             bin/app 설치 + 웹 UI 빌드
  start-web.sh           웹 UI 런처 (~/bin/claude-monitor-web로 설치)
  web.mjs                Next.js HTTP 서버 + collector 시작·종료
  check-runtime.mjs      package engines 기반 설치·시작 요구사항 검사
  uninstall.sh           설치 산출물 제거 (소스는 유지)
packages/
  core/                  공유 타입·유틸·어댑터/위젯 레지스트리
  adapter-claude-code/   JSONL 파서·증분 tail 리더·chokidar 와처 (+ cowork/ chat/ codex/ 어댑터)
  collector/             원장·마이그레이션·백업·worker
  web/                   Next.js 14 App Router 대시보드 + SSE
```

### 주요 API 엔드포인트

| 메서드 · 경로 | 인증 | 설명 |
|---|---|---|
| `GET /api/health` | 불필요 | 웹 헬스 체크. 어댑터·세션 수와 별도의 collector 상태 반환. `ok`는 원장 수집 완료를 뜻하지 않음. **유일하게 인증이 필요 없는 엔드포인트** |
| `GET /api/collector` | Bearer 필요 | 원장 worker·schema·진단 상태. 원문·경로·SQL 오류는 반환하지 않음 |
| `GET /api/usage` | Bearer 필요 | 토큰 사용량. 출처(`api` 또는 `estimate`), OAuth 값, 로컬 값, 현재 시각 반환 |
| `GET /api/sessions` | Bearer 필요 | 프로젝트별로 묶인 세션 목록. 쿼리: `maxAgeHours`, `all`(1\|0), `filter`(glob), `status`. 자식 세션은 `children` 배열로 분리 반환 |
| `GET /api/sessions/[id]` | Bearer 필요 | 단일 세션 상세. 쿼리 `adapter`(기본 `claude-code`; `codex`, `claude-cowork`, `claude-chat`). 없으면 404 |
| `GET /api/events` | Bearer 필요 | SSE 스트림. 이벤트 종류: `summary`, `removed`, `heartbeat`(30초 간격). 초기 heartbeat 후 스트리밍 |
| `POST /api/sessions/[id]/kill` | Bearer 필요 | 세션 종료. 200(종료됨) / 404(없음) / 409(종료 실패·충돌) |

> 위 표에서 `/api/health`를 제외한 엔드포인트는 `CM_BEARER_TOKEN`이 설정된 경우 `Authorization: Bearer <token>` 헤더를 요구하며, 없거나 잘못되면 401을 반환합니다. `/api/events`는 JSON이 아닌 SSE(`text/event-stream`) 스트림이므로 클라이언트는 이벤트 이름을 파싱해야 합니다. `/api/sessions`는 의도적으로 부모 세션(`projects`)과 자식 세션(`children`)을 나눠 반환하는데, 이는 SSE 재연결 시 이미 끝난 하위 에이전트가 이벤트를 다시 내보내지 않는 경우에도 스냅샷으로 복원하기 위함입니다.

hook 수신은 조회용 Bearer와 별도의 인증값을 사용합니다.

---

## 12. 아이콘 재빌드

```bash
# icons/src/04-dashboard.svg (또는 다른 후보)를 편집한 뒤:
bash scripts/build-icon.sh 04-dashboard
```

`icons/ClaudeMonitor.icns`를 다시 생성하고 `app/ClaudeMonitor.app/Contents/Resources/applet.icns`로 복사합니다. `~/Applications`에 반영하려면 `scripts/install.sh`를 다시 실행하세요.

## 개인용 로컬 모니터 (L1–L3)

첫 화면(`/`)은 실시간 모니터이고, 원장 개요는 `/overview`이며 `/usage`·`/projects`·`/runs`·`/work`·`/settings`로 이어집니다. 예전 `/sessions` 주소는 `/`로 이동합니다. 원장은 첫 실행에 기존 기록을 가져온 뒤 완결 JSONL 줄을 증분 반영합니다. 데이터 파일은 현재 사용자만 읽고 쓸 수 있는 전용 디렉터리에 저장합니다.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Node 24.11 이상 24.x, pnpm 10.x가 필요합니다. `CLAUDE_PROJECTS_DIR`로 읽기 전용 원천, `CM_DATA_DIR`로 원장 위치, `CM_TIMEZONE`으로 최초 시간대를 지정할 수 있습니다. `CM_COLLECTOR_POLL_MS` 기본값은 1000입니다. 기존 구독 한도 조회는 `CM_REMOTE_USAGE_ENABLED=true`일 때만 Keychain/외부 API에 연결합니다. 새 리포트는 원격 계정을 요구하지 않습니다.

실행·승인·입력 대기 신호는 선택적인 Claude Code hook 연결이 필요합니다. `node scripts/runtime-hook-token.mjs`로 데이터 폴더에 본인 전용 토큰 파일(`runtime-hook.token`, `0600`)을 만들면 서버와 hook이 같은 값을 읽습니다(환경변수 `CM_RUNTIME_HOOK_TOKEN`이 있으면 우선). `node scripts/runtime-hook-settings.mjs`는 병합할 설정을 출력하고 기존 사용자 설정을 수정하지 않습니다. 미연결/오래된 신호는 미확인으로 남습니다.

작업 제목·실행 연결·결과물·사용자 확인은 수동으로 남깁니다. 응답 종료로 업무 완료를 자동 판정하지 않습니다. 설정 화면에서 백업·진단·보관 검토를 할 수 있으며 삭제는 범위 확인 후 백업과 함께 수행합니다.

14일 실사용과 실제 CLI hook 연결 검증이 남아 있으며, 기능 구현만으로 상용 출시 완료를 주장하지 않습니다.
