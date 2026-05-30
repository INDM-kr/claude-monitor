## 필수 규칙 (Mandatory Rules)

다음 8개 규칙은 사용자가 명시적으로 면제하지 않는 한 모든 작업에 우선 적용된다.
1. **하드코딩 금지** — 값(URL, 경로, API 키, 환경별 상수)을 코드에 직접 박지 말 것. config·env·constants 파일로 분리. 단, 진짜 불변값(π, HTTP 상태 코드 등)은 예외.
2. **에러 근본 원인** — 에러를 만나면 근본 원인까지 추적. try/catch로 묻거나 retry 추가하거나 메시지 우회로 가리는 패치 금지. **원인 파악 → 사용자에게 보고 → 승인 후 수정** 순서.
3. **추측 금지, 증거 기반** — "아마도/그럴 것이다" 류 표현이 떠오르면 멈추고 검증. 추측을 사실처럼 진술 금지. 모르면 모른다고 보고.
4. **시크릿 커밋 금지** — `.env`, credentials, API 키, 토큰 등은 절대 `git add`·commit 금지. 발견 시 사용자에게 보고하고 `.gitignore` 처리.
5. **변경 범위 격리** — 한 번에 한 가지. 요청과 무관한 리팩토링·포맷팅·코멘트 정리 동반 금지. 발견하면 별도로 보고만.
6. **영향 범위 확인** — 함수·모듈 동작 변경 시 모든 호출자(코드·CLI·설정·문서)를 확인하고 함께 수정. 누락 시 사용자에게 보고.
7. **가정 명시 후 작업** — 구현 전 가정을 한 줄로 명시. 해석이 여러 가지면 조용히 고르지 말고 선택지 제시. 불명확하면 멈추고 질문.
8. **다단계 작업은 계획 먼저** — 여러 단계 작업은 구현 전 검증 기준 포함 계획 제시. 형식: `1. [단계] → 검증: [확인 방법]`.

---

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).
