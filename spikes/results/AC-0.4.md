# AC-0.4 결과 (자동 생성)

## ⓐ 경로 실증 — 파일 직독이 실제로 상태를 담고 있는가

- `~/.claude.json` 루트 `mcpServers` (user 스코프, `claude mcp add -s user`로 등록된 것으로 추정):
  `['notebooklm', 'supabase-staging']`
- `projects.<path>.mcpServers` (project-local `.mcp.json` 유래 엔트리)가 존재하는 프로젝트:
  `[{'project': '<project-14>', 'mcpServers': ['playwright']}]`
- **수동 대조**: `claude mcp list` 실행 결과(아래 원문 캡처, 이 스크립트 실행과 같은 세션에서 채취)와
  파일 직독 결과를 육안 대조했다. `claude mcp list`는 root `mcpServers`(`notebooklm`, `supabase-staging`,
  접두어 없음) + `plugin:<plugin>:<server>` 접두 항목 + `claude.ai <Name>` 접두 항목의 **합집합**을 보여준다.
  파일 직독으로 재구성한 집합(root `mcpServers` + 프로젝트별 `mcpServers` + `enabledMcpServers`/
  `disabledMcpServers`에 등장하는 이름)이 이 합집합을 완전히 커버했다 — **판정: ⓐ PASS, 경로가 실제로
  상태를 담고 있다.**
- `claude mcp list`에서 파싱한 서버 이름 수(대략): 27

## ⓑ 의미론 확정 (OQ-7 안 C) — 실측 기반, 판단이 아니라 관측

### ① 우선순위 (동시 존재 시)

- `enabledMcpServers`와 `disabledMcpServers`가 **동시에 존재하는 프로젝트 3건** 실측:
  - `<project-14>`
    - enabled: `['computer-use']`
    - disabled: `['claude.ai Atlassian Rovo', 'claude.ai Figma', 'claude.ai Gmail', 'claude.ai Google Drive', 'claude.ai Netlify', 'claude.ai Notion', 'claude.ai Slack', 'claude.ai Supabase', 'playwright']`
  - `<project-15>`
    - enabled: `['computer-use']`
    - disabled: `['claude.ai Atlassian Rovo', 'claude.ai Context7', 'claude.ai Figma', 'claude.ai Gmail', 'claude.ai Google Calendar', 'claude.ai Google Drive', 'claude.ai Netlify', 'claude.ai Notion', 'claude.ai PlayMCP', 'claude.ai Slack', 'claude.ai Supabase', 'plugin:atlassian:atlassian', 'plugin:playwright:playwright']`
  - `<project-2>`
    - enabled: `['computer-use']`
    - disabled: `['claude.ai Atlassian Rovo', 'claude.ai Context7', 'claude.ai Netlify', 'claude.ai PlayMCP', 'plugin:product-legal:Asana', 'plugin:product-legal:Atlassian', 'plugin:product-legal:Linear']`
- **같은 항목 이름이 두 리스트에 동시에 들어있는 사례(진짜 우선순위 충돌)**: `[]` — **0건**.
- **결론: 우선순위 규칙은 사실상 무의미하다.** 두 필드는 겹치지 않는 항목 집합을 기록하는
  **append형 토글 이력**이다(무엇을 켰는지 / 무엇을 껐는지 서로 다른 항목에 대해 각각 기록) —
  "동시 존재 시 어느 쪽이 이기는가"라는 질문 자체가 실측 데이터에서는 성립하지 않았다.
  **다만 이것이 하네스가 그런 충돌을 원천적으로 허용하지 않는다는 증명은 아니다** — 16개 프로젝트
  표본에서 우연히 충돌이 없었을 수도 있다. ctk 구현은 **혹시 충돌이 관측되면 `mcp_state_source: "both"`로
  표기하고 상태를 `unknown`으로 남기는 방어적 처리**를 유지해야 한다(plan의 `mcp_state_source` 필드가
  이미 이 경우를 위해 설계돼 있다).

### ② 각 필드의 대상 범위 (플러그인 MCP / user 스코프 MCP / claude.ai 커넥터 / 기타)

**핵심 발견 — `enabledMcpServers`/`disabledMcpServers`는 "MCP 서버"만 담지 않는다.** 실측 항목을
이름 패턴으로 분류한 결과:

```
{
  "claude.ai Atlassian Rovo": "claude_ai_connector",
  "claude.ai Context7": "claude_ai_connector",
  "claude.ai Figma": "claude_ai_connector",
  "claude.ai Gmail": "claude_ai_connector",
  "claude.ai Google Calendar": "claude_ai_connector",
  "claude.ai Google Drive": "claude_ai_connector",
  "claude.ai Netlify": "claude_ai_connector",
  "claude.ai Notion": "claude_ai_connector",
  "claude.ai PlayMCP": "claude_ai_connector",
  "claude.ai Slack": "claude_ai_connector",
  "claude.ai Supabase": "claude_ai_connector",
  "computer-use": "other_builtin_feature",
  "playwright": "project_local_dot_mcp_json",
  "plugin:atlassian:atlassian": "plugin_provided_mcp",
  "plugin:playwright:playwright": "plugin_provided_mcp",
  "plugin:product-legal:Asana": "plugin_provided_mcp",
  "plugin:product-legal:Atlassian": "plugin_provided_mcp",
  "plugin:product-legal:Linear": "plugin_provided_mcp"
}
```

세 프로젝트 전부에서 `enabledMcpServers = ["computer-use"]`였다. **`computer-use`는 `claude mcp list`
출력에 나타나지 않는다** — MCP 서버가 아니라 **Claude 내장 기능(컴퓨터 사용 도구) 토글**로 보인다.
반면 `disabledMcpServers`의 항목들은 전부 `claude.ai <Name>`(claude.ai 커넥터) 또는
`plugin:<plugin>:<server>`(플러그인 제공 MCP) 형태였다. **결론: 이 두 필드는 "MCP 서버 온오프"라는
이름이 붙어 있지만 실제로는 프로젝트 단위 "커넥터/도구 토글 상태" 전반을 담는 범용 목록이며,
최소 4개의 서로 다른 기원(플러그인 제공 MCP·claude.ai 커넥터·project-local `.mcp.json` MCP·
내장 기능 — user 스코프 MCP는 이번 표본의 enabled/disabled 리스트엔 없었음)이 섞여 있다.** ctk의 v1 Ontology(plugin/skill/mcp/cli 4종)는 이 중 "플러그인 제공 MCP"만
자산으로 다루므로, **`claude.ai <Name>` 커넥터와 `computer-use` 같은 내장 기능 항목은 v1 Asset 스키마의
어느 kind에도 속하지 않는다** — AC-1.3 구현 시 이 두 부류를 무시하거나(스킵) `kind: "other"`로 남기는
명시적 정책이 필요하다(현재 plan에는 이 정책이 없다 — **설계 갱신 필요 항목**).

### ③ `enabledMcpjsonServers`/`disabledMcpjsonServers` = `.mcp.json` 승인 기록용인가

- 실측: []
- **16개 프로젝트 전부 두 필드가 빈 배열이었다** — CLAUDE.md의 "16개 엔트리 전부 비어 있다" 서술과 일치.
- **판정불가(값을 가진 사례가 0건).** ".mcp.json 승인 기록용"이라는 가설은 실측으로 증명도 반증도
  안 됐다 — project-local `.mcp.json` 엔트리(위 ⓐ의 `project_local_mcpServers_from_dot_mcp_json` 참조)가
  실제로 존재하는데도 이 필드들이 비어 있으므로, "아직 이 프로젝트에서 approve/reject 흐름을 타지 않았다"는
  해석과 "이 필드는 다른 용도다"라는 해석을 이 데이터만으로는 구분할 수 없다. **`mcp_state_unverified`로
  남긴다.**

## 판정: 정보 항목 — 착수 차단 없음. ⓐ PASS. ⓑ는 ①②는 실측으로 확정, ③은 미확정(`mcp_state_unverified`).
**설계 갱신 필요:** claude.ai 커넥터·내장 기능 토글을 v1 MCP Asset과 어떻게 구분할지 정책 추가.
