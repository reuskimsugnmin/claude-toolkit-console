# omc 워크플로우 자산 — 단계별 스폰 대상

`CLAUDE.md`의 "작업 워크플로우" 절이 참조하는 상세 표다. 이 프로젝트는 omc(oh-my-claudecode)
플러그인만 쓴다 — 플러그인 성능을 검증하려는 의도적 제약이므로 다른 워크플로우 플러그인과
병행하지 않는다.

**작업을 시작하기 전에 해당 단계의 자산을 먼저 스폰한다. 단계를 건너뛰고 바로 손대지 않는다.**

<!-- ctk:generated:workflow-assets:start -->
<!-- 이 구간의 마지막 열은 `ctk workflow-doc`이 카탈로그에서 채운다(B4-c). 1·2열은 손으로
     고친다 — 생성기는 각 행의 마지막 두 `|` 사이만 치환하고 그 앞 바이트는 다시 쓰지 않는다. -->
| 단계 | 스폰할 것 | 설명 |
|---|---|---|
| 요구사항 분석 | `Skill(oh-my-claudecode:deep-interview)` 또는 `Agent(oh-my-claudecode:analyst)` | Socratic deep interview with mathematical ambiguity gating before explicit execution approval · Pre-planning consultant for requirements analysis (Opus) |
| 설계·구조 결정 | `Agent(oh-my-claudecode:architect)` — READ-ONLY | Strategic Architecture &amp; Debugging Advisor (Opus, READ-ONLY) |
| 계획 수립 | `Skill(oh-my-claudecode:plan)` 또는 `Agent(oh-my-claudecode:planner)` | Strategic planning with optional interview workflow · Strategic planning consultant with interview workflow (Opus) |
| 계획 검토 | `Agent(oh-my-claudecode:critic)` | Work plan and code review expert — thorough, structured, multi-perspective (Opus) |
| 코드 탐색 | `Agent(oh-my-claudecode:explore)` | Codebase search specialist for finding files and code patterns |
| 구현 | `Agent(oh-my-claudecode:executor)` | Focused task executor for implementation work (Sonnet) |
| 테스트 설계·작성 | `Agent(oh-my-claudecode:test-engineer)` | Test strategy, integration/e2e coverage, flaky test hardening, TDD workflows |
| 디버깅 | `Skill(oh-my-claudecode:debug)` · `Agent(oh-my-claudecode:debugger)` · `Agent(oh-my-claudecode:tracer)` | Diagnose the current OMC session or repo state using logs, traces, state, and focused reproduction · Root-cause analysis, regression isolation, stack trace analysis, build/compilation error resolution · Evidence-driven causal tracing with competing hypotheses, evidence for/against, uncertainty tracking, and next-probe recommendations |
| 코드 리뷰 | `Agent(oh-my-claudecode:code-reviewer)` | Expert code review specialist with severity-rated feedback, logic defect detection, SOLID principle checks, style, performance, and quality strategy |
| 단순화 | `Agent(oh-my-claudecode:code-simplifier)` | Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise. |
| 보안 검토 | `Agent(oh-my-claudecode:security-reviewer)` — `actuator` 변경 시 **필수** | Security vulnerability detection specialist (OWASP Top 10, secrets, unsafe patterns) |
| 완료 검증 | `Skill(oh-my-claudecode:verify)` 또는 `Agent(oh-my-claudecode:verifier)` | Verify that a change really works before you claim completion · Verification strategy, evidence-based completion checks, test adequacy |
| 커밋 | `Agent(oh-my-claudecode:git-master)` | Git expert for atomic commits, rebasing, and history management with style detection |
| 문서 작성 | `Agent(oh-my-claudecode:writer)` | Technical documentation writer for README, API docs, and comments (Haiku) |
| UI 설계 | `Agent(oh-my-claudecode:designer)` | UI/UX Designer-Developer for stunning interfaces (Sonnet) |
| PR 전 회고 | `Skill(claude-md-management:revise-claude-md)` | Update CLAUDE.md with learnings from this session |
<!-- ctk:generated:workflow-assets:end -->

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
