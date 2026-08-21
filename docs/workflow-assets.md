# omc 워크플로우 자산 — 단계별 스폰 대상

`CLAUDE.md`의 "작업 워크플로우" 절이 참조하는 상세 표다. 이 프로젝트는 omc(oh-my-claudecode)
플러그인만 쓴다 — 플러그인 성능을 검증하려는 의도적 제약이므로 다른 워크플로우 플러그인과
병행하지 않는다.

**작업을 시작하기 전에 해당 단계의 자산을 먼저 스폰한다. 단계를 건너뛰고 바로 손대지 않는다.**

| 단계 | 스폰할 것 |
|---|---|
| 요구사항 분석 | `Skill(oh-my-claudecode:deep-interview)` 또는 `Agent(oh-my-claudecode:analyst)` |
| 설계·구조 결정 | `Agent(oh-my-claudecode:architect)` — READ-ONLY |
| 계획 수립 | `Skill(oh-my-claudecode:plan)` 또는 `Agent(oh-my-claudecode:planner)` |
| 계획 검토 | `Agent(oh-my-claudecode:critic)` |
| 코드 탐색 | `Agent(oh-my-claudecode:explore)` |
| 구현 | `Agent(oh-my-claudecode:executor)` |
| 테스트 설계·작성 | `Agent(oh-my-claudecode:test-engineer)` |
| 디버깅 | `Skill(oh-my-claudecode:debug)` · `Agent(oh-my-claudecode:debugger)` · `Agent(oh-my-claudecode:tracer)` |
| 코드 리뷰 | `Agent(oh-my-claudecode:code-reviewer)` |
| 단순화 | `Agent(oh-my-claudecode:code-simplifier)` |
| 보안 검토 | `Agent(oh-my-claudecode:security-reviewer)` — `actuator` 변경 시 **필수** |
| 완료 검증 | `Skill(oh-my-claudecode:verify)` 또는 `Agent(oh-my-claudecode:verifier)` |
| 커밋 | `Agent(oh-my-claudecode:git-master)` |
| 문서 작성 | `Agent(oh-my-claudecode:writer)` |
| UI 설계 | `Agent(oh-my-claudecode:designer)` |
| PR 전 회고 | `Skill(claude-md-management:revise-claude-md)` |

## 세션 간 컨텍스트

omc MCP로 유지한다 — `project_memory_*` · `notepad_*` · `wiki_*` · `session_search`
(`mcp__plugin_oh-my-claudecode_t__*`). 결정과 진행 상황을 여기에 남긴다.

## 쓰지 않는 것 — 워크플로우 플러그인

`superpowers` 전체(brainstorming · writing-plans · executing-plans · test-driven-development ·
systematic-debugging · verification-before-completion · subagent-driven-development 등) ·
`feature-dev` · `pr-review-toolkit` · `code-review` · 비omc `code-simplifier` · `ccpm` ·
`ralph-loop`(비omc) · `codex` · `plugin-dev` 워크플로우 · 기타 프로세스 스킬.

**경계:** 금지 대상은 **워크플로우/프로세스** 플러그인이다. 도메인 도구는 계속 쓴다 —
`context7`(라이브러리 문서) · `vercel`·`supabase`(플랫폼) · `playwright`·`chrome-devtools`(브라우저 검증) ·
`github`(저장소 작업) · `document-skills`(문서 변환) · `claude-md-management`(PR 전 회고).

## 서브에이전트 운용 실측

- 긴 작업(수백 tool use)은 **세션 한도로 중단될 수 있다.** 중단 전까지의 커밋과 마지막 한 줄이
  유일한 산출물이 되므로, 에이전트에게 **단위마다 커밋**하도록 지시한다.
- 중단된 에이전트를 재스폰하기 전에 **이미 커밋된 것을 먼저 확인**한다(`git log main..HEAD`).
  중단 보고만 보고 작업이 없었다고 단정하면 같은 일을 두 번 시킨다.
