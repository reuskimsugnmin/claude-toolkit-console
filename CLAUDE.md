# claude-toolkit-console

Claude Code 도구 환경(플러그인·스킬·MCP·CLI)을 **여러 로컬에 걸쳐** 보고, 배치하고, 옮기는
로컬 우선 웹 콘솔.

## 이 제품이 푸는 문제

1. **툴 선택** — 설치한 툴이 많아 어떤 상황에 무엇을 써야 할지 모른다. 툴 메타데이터만으로는
   자동 스폰에 한계가 있으므로, 사람이 **명시적으로 지시할 수 있도록** 툴별 사용 맥락을 보여준다.
2. **스코프 배치** — 전역 설치가 많아 기본 컨텍스트 비용이 과다하다. 전역에 두되 필요한
   프로젝트로 **스코프를 옮기고**, 한 프로젝트에만 있는 툴을 **다른 프로젝트로 복사**한다.
3. **로컬 간 가시성** — 다른 머신에서 이어 작업할 때 그 툴이 여기도 깔려 있는지 헷갈린다.
   **머신별 설치 현황**을 한 화면에서 본다.

## 아키텍처 결정 — 로컬 우선 + 동기화 어댑터

- **브라우저는 로컬 파일을 못 쓴다.** 따라서 로컬 에이전트(CLI)가 필수이고, 웹은 그 위의
  표현·조작 계층이다. 이 전제는 협상 대상이 아니다.
- v1 동기화 백엔드는 **Git 저장소** — 백엔드·인증·비용이 0이고 오프라인에서 동작한다.
- `sync`를 **어댑터 경계**로 분리한다. 나중에 Supabase 어댑터를 추가하면 클라우드로 이행한다.
- 조치(스코프 이동 등)는 **현재 로컬에서만** 실행한다. 타 로컬은 마지막 push 시점으로 조회한다.

### 계층 경계

| 계층 | 책임 | 위험도 |
|---|---|---|
| `core` | 스키마·타입·스냅샷 diff. 순수 로직, I/O 없음 | 없음 |
| `probe` | 로컬 설정 **읽기**만 | 낮음 |
| `actuator` | 로컬 설정 **쓰기** — 백업·롤백 필수 | **높음** |
| `sync` | 스냅샷 push/pull 어댑터 | 중간 |
| `cli` | 위를 오케스트레이션 | — |
| `web` | 표현·조작 UI | — |

**읽기와 쓰기를 한 모듈에 섞지 않는다.** 쓰기는 사용자의 실제 개발 환경을 바꾸므로 파괴적이다.
위험한 코드를 작게 가두어 감사 가능하게 유지한다.

### 스키마의 척추 — 머신 종속 / 머신 독립

| 성격 | 엔티티 | 동기화 |
|---|---|---|
| 머신 **종속** | Machine · Installation(scope·enabled·토큰) · Project · Usage | 머신별로 따로 쌓임 |
| 머신 **독립** | Asset(툴 정체) · **Annotation(언제 쓰는가)** · Tag | 전 머신 공유 |

문제 1의 "어떤 상황에 어떤 툴"은 **Annotation**이고 머신이 바뀌어도 유지돼야 한다.
문제 3의 "이 로컬에 깔려 있나"는 **Installation**이고 머신마다 달라야 한다. **이 둘을 섞지 않는다.**

**스냅샷은 append-only로 쌓고, 현재 상태와 드리프트는 파생값으로 계산한다.**
기록 없이 유입된 툴은 현재 상태만 봐서는 찾을 수 없고 두 시점을 diff해야 드러난다.

## 저장소 경계 — 3개는 서로 독립이다

| 저장소 | 공개 | 담는 것 |
|---|---|---|
| `claude-toolkit-console` (이곳) | **public** | 제품 코드만 |
| `../claude-toolkit-ops` | private | 사람이 쓰는 운영 이력 |
| 동기화 데이터 저장소 | **private** | `ctk`가 push/pull하는 스냅샷 |

### ⚠️ 이 저장소는 공개다

개인 환경 데이터를 코드·테스트·커밋에 넣지 않는다.

- 금지: 실제 머신명 · 홈 경로 · 프로젝트 절대경로 · 설치된 툴 목록 · 개인 사용량/토큰 수치
- 테스트 픽스처는 **익명화된 합성 데이터**로 만든다
- **스냅샷 결과물을 이 저장소에 커밋하지 않는다.** 동기화 저장소는 사용자가 설정으로 지정하며
  제품에 하드코딩하지 않는다 — 다른 사용자도 각자의 private 저장소를 쓸 수 있어야 한다

## 작업 워크플로우 — omc(oh-my-claudecode) 전용

**이 프로젝트의 개발 워크플로우는 omc 플러그인만 사용한다.** 플러그인 성능을 검증하려는
의도적 제약이므로 다른 워크플로우 플러그인과 병행하지 않는다.

### 단계별로 반드시 스폰할 omc 자산

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

작업을 시작하기 전에 해당 단계의 omc 자산을 먼저 스폰한다. 단계를 건너뛰고 바로 손대지 않는다.

### 세션 간 컨텍스트는 omc MCP로 유지

`project_memory_*` · `notepad_*` · `wiki_*` · `session_search`
(`mcp__plugin_oh-my-claudecode_t__*`). 결정과 진행 상황을 여기에 남긴다.

### 쓰지 않는 것 — 워크플로우 플러그인

`superpowers` 전체(brainstorming · writing-plans · executing-plans · test-driven-development ·
systematic-debugging · verification-before-completion · subagent-driven-development 등) ·
`feature-dev` · `pr-review-toolkit` · `code-review` · 비omc `code-simplifier` · `ccpm` ·
`ralph-loop`(비omc) · `codex` · `plugin-dev` 워크플로우 · 기타 프로세스 스킬.

**경계:** 금지 대상은 **워크플로우/프로세스** 플러그인이다. 도메인 도구는 계속 쓴다 —
`context7`(라이브러리 문서) · `vercel`·`supabase`(플랫폼) · `playwright`·`chrome-devtools`(브라우저 검증) ·
`github`(저장소 작업) · `document-skills`(문서 변환).

## 도메인 지식 — 자산 유형마다 다루는 법이 다르다

`actuator` 설계의 핵심이다. **유형을 하나로 추상화하려 하지 말 것.**

| 자산 유형 | 스코프가 사는 곳 | 끄는 방법 |
|---|---|---|
| 플러그인 | `settings.json` / `settings.local.json`의 `enabledPlugins` | `claude plugin disable` |
| MCP 서버 | `claude mcp add -s user\|project\|local` | **비활성 명령 없음** — remove/add만 |
| 전역 스킬 | `~/.claude/skills/<name>/` 존재 여부 | **명령 없음** — 디렉터리 이동 |
| CLI 도구 | PATH | 해당 없음 (상시 토큰 0) |

**실측으로 확인된 함정:**

- 일부 설치 스크립트는 `CLAUDE.md`까지 수정한다. 설치 로그의 **마지막 줄까지** 읽고,
  설치 전 백업 → 사후 diff로 확인한다.
- `.gitignore`는 **미추적 파일에만** 작용한다. 이미 추적 중인 파일은 막지 못한다.
- 플러그인 자동 갱신이 **비활성 상태를 되돌릴 수 있다.** "껐다"는 기록만으로 현재 상태를
  단정하지 않는다. 상태는 항상 실측한다.
- `claude plugin list`는 local 스코프 항목을 **중복 출력**한다. 이름 기준 고유 집계로 센다.
- 토큰 수치는 실측만 쓴다. 그리고 **무엇을 재는지를 먼저 확정한다** —
  frontmatter 전체와 `name`+`description`은 2배 이상 차이가 난다.
- 자동 스캐너는 **부정문을 오독한다.** 판정을 결론으로 쓰지 말고 원문을 확인한다.

## 안전 원칙

1. `actuator`의 모든 쓰기는 **백업 → 수정 → 검증 → (실패 시) 롤백** 순서를 지킨다.
2. 되돌릴 수 없는 조치(삭제)보다 **되돌릴 수 있는 조치(비활성·이동)를 먼저** 제안한다.
3. 조치 결과는 **실행 전/후 상태를 함께** 기록한다. 실행했다는 사실만 남기지 않는다.
4. 사용자 환경을 바꾸는 코드는 `Agent(oh-my-claudecode:security-reviewer)`를 반드시 거친다.

## 커밋 규칙

- 이 저장소는 **제품 코드 전용**이다. 운영 기록은 `../claude-toolkit-ops`에 남긴다. 섞지 않는다.
- 커밋은 `Agent(oh-my-claudecode:git-master)`로 수행한다.
- 커밋·푸시는 사용자가 요청할 때만 한다.

## 상속

사용자 전역 `~/.claude/CLAUDE.md`의 규칙이 이 프로젝트에도 그대로 적용된다 —
**토큰 과다 소비 작업의 사전 고지·승인**, **백그라운드 대기의 데드라인과 직접 검수**.

## 현재 상태

요구사항 정의 단계. 코드 없음. 다음 단계는 `Skill(oh-my-claudecode:deep-interview)`로
요구사항을 확정하는 것이다.
