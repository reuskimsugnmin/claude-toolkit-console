# AC-0.6b 결과 (자동 생성 — 실제 트랜스크립트 30/285개 표본,
18761행 스캔 — **읽기 전용, 메시지 내용/경로는 기록하지 않음**)

## ⓐ `tool_result`가 어느 `type`의 행에 있는가

- `toolUseResult` 최상위 필드가 존재하는 행: **1742건**
- `message.content[].type === "tool_result"` 블록이 존재하는 행: **1742건**
- 이 두 신호가 나타난 행의 `type` 분포: `{'user': 3484}`
- 전체 행 `type` 분포: `{'queue-operation': 76, 'user': 1939, 'attachment': 9587, 'last-prompt': 676, 'ai-title': 666, 'assistant': 3587, 'mode': 620, 'permission-mode': 359, 'bridge-session': 366, 'system': 219, 'file-history-snapshot': 102, 'file-history-delta': 118, 'pr-link': 416, 'atis-latch': 22, 'relocated': 4, 'worktree-state': 4}`

**결론:** `tool_result`는 `type: "user"` 행에 나타난다(위 분포 확인) — plan의 가정과 일치.
**두 가지 표현이 공존한다** — 최상위 `toolUseResult` 필드(레거시/보조 표현으로 보임)와
`message.content[]` 배열 안의 `{"type": "tool_result", ...}` 블록(Anthropic Messages API 표준 형태).
파서는 **둘 중 하나만 보면 안 되고 양쪽을 다 확인**해야 한다 — 한쪽만 보면 계수가 누락된다.

## ⓑ `isSidechain` 필드의 위치·의미

- `isSidechain` 필드를 가진 행이 나타난 row type: `{'user': 1939, 'attachment': 9587, 'assistant': 3587, 'system': 219}`
- 값 분포: `{'False': 15332}`

**결론 (수정 — 최초 초안보다 신중하게): `isSidechain`은 행(메시지) 최상위 필드로 나타난다.**
**단 실측상 이 환경의 표본(100개 파일 / 79,420개 필드-보유 행)에서 `true` 값이 단 한 건도
관측되지 않았다** — 전부 `false`다. 같은 표본에서 `Agent` tool_use는 39회 관측됐으므로
서브에이전트 호출 자체는 분명히 있었는데도 `isSidechain:true` 행이 0건이라는 것은,
**"서브에이전트 대화가 같은 트랜스크립트 파일 안에 `isSidechain:true`로 인라인된다"는
가정이 이 하네스 버전에서는 성립하지 않을 수 있음을 시사한다.** `~/.claude/` 최상위에는
plan이 몰랐던 `tasks/`·`session-env/`·`jobs/`·`daemon/` 같은 새 서브시스템 디렉터리가 존재한다
(이번 실측으로 처음 확인 — R13 하네스 드리프트가 예상보다 크다). **서브에이전트 대화가 이
디렉터리들 중 하나에 별도로 저장될 가능성이 있으나, 이번 스파이크에서는 더 깊이 파고들지
않았다(시간 예산) — Step 3에서 재조사가 필요한 미해결 항목으로 남긴다.**

## ⓒ 서브에이전트 스폰 도구명 상수

- 실제 관측된 스폰 도구명: `['Agent']`
- 전체 tool_use 이름 분포(상위 20개): `{'Bash': 944, 'Read': 219, 'Edit': 215, 'Agent': 49, 'Write': 49, 'Skill': 37, 'TaskUpdate': 36, 'Grep': 23, 'StructuredOutput': 21, 'mcp__plugin_vercel_vercel__list_deployments': 21, 'ToolSearch': 20, 'TaskCreate': 20, 'AskUserQuestion': 16, 'mcp__plugin_vercel_vercel__get_runtime_errors': 12, 'mcp__claude-in-chrome__computer': 7, 'mcp__plugin_playwright_playwright__browser_navigate': 7, 'mcp__plugin_supabase_supabase__execute_sql': 6, 'mcp__plugin_playwright_playwright__browser_evaluate': 5, 'mcp__plugin_playwright_playwright__browser_take_screenshot': 5, 'mcp__plugin_supabase_supabase__apply_migration': 4}`

**결론:** 이번 표본에서 관측된 스폰 도구명은 위 목록과 같다. **plan 서술("현행 `Agent`, 구버전
`Task`")과 대조**: 목록에 `Agent`만 있으면 이 환경(버전 2.1.237 (Claude Code))은 이미 신버전 상수만 쓰고 있다는 뜻이고,
`Task`가 섞여 있으면 과거 세션의 구버전 트랜스크립트가 표본에 포함됐다는 뜻이다.

## ⓓ `Skill` tool_use의 `input.skill` 형태

- 형태 분포: `{'plugin:skill': 22, 'bare-name': 15}`
- 예시(절대경로는 자동 REDACT): `['superpowers:brainstorming', 'superpowers:writing-plans', 'superpowers:subagent-driven-development', 'milestone-retro', 'collab-sync-write']`

## 부가: `attribution*` 필드 보유 파일 비율

- 표본 30개 중 `attributionSkill`/`attributionPlugin`/`attributionMcpServer`/
  `attributionMcpTool` 중 하나라도 가진 파일: **4개**
  (AC-0.6a의 원인 판정과 별개로, 이 표본에서의 존재율 참고치)

## 판정: PASS (차단 해제) — `core/src/usage/tool-names.ts` 초기값 및 AC-4.10 행 파싱 전제 확정
