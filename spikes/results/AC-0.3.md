# AC-0.3 결과 (자동 생성 — 2026-08-20T05:17:01.755Z)

- 명령: `claude plugin list --json` (실제 환경, 읽기 전용)
- 전체 엔트리 수: 68
- 고유 id 수: 66
- zod strict parse 상당 통과(미지 키 0 · 누락 키 0 · id 형식 `name@marketplace` 준수) 엔트리 수: 20
- 미지의 키 샘플: [{"id":"claude-seo@agricidaniel-claude-seo","unknown":["projectPath"]},{"id":"claude-seo@agricidaniel-claude-seo","unknown":["projectPath"]},{"id":"claude-seo@agricidaniel-claude-seo","unknown":["projectPath"]},{"id":"product-planning@myjob-planning","unknown":["projectPath"]},{"id":"ui-ux-pro-max@ui-ux-pro-max-skill","unknown":["projectPath"]}]
- 누락 키 샘플: [{"id":"bmad-analysis@bmad-method","missing":["mcpServers"]},{"id":"bmad-brainstorming@bmad-method","missing":["mcpServers"]},{"id":"bmad-deep-recon@bmad-method","missing":["mcpServers"]},{"id":"bmad-forge-idea@bmad-method","missing":["mcpServers"]},{"id":"bmad-method-lifecycle@bmad-method","missing":["mcpServers"]}]
- id 형식 위반: []
- id 기준 중복 엔트리(로컬 스코프 중복 재현 여부): [["claude-seo@agricidaniel-claude-seo",3]]
- 이름은 같고 마켓플레이스가 다른 케이스(병합 금지 대상, P1-7): []

## 판정: **FAIL as literally specified in the plan(§3 AC-0.3) — 스키마가 계획이 가정한 8키 고정 셋과 다르다.
아래 근거로 스키마를 정정하면 통과 가능하다(구현 시 이 정정 스키마를 채택할 것).**

## 근거 — 스키마 정정 (plan의 가정 대비 실측 차이)

1. **`projectPath`는 미지의 키가 아니라 `scope: "local"` 엔트리에만 붙는 조건부 필드다.**
   `claude-seo@agricidaniel-claude-seo` 3건을 직접 조회한 결과:
   ```
   {"id":"claude-seo@agricidaniel-claude-seo","scope":"local","projectPath":"/…/resume-creator", …}
   {"id":"claude-seo@agricidaniel-claude-seo","scope":"local","projectPath":"/…/hermit", …}
   {"id":"claude-seo@agricidaniel-claude-seo","scope":"local","projectPath":"/…/worktrees/seo-guide-pages", …}
   ```
   즉 **id 기준 "중복" 3건은 실제로는 중복이 아니라 3개 프로젝트 각각의 local-scope 설치**다 —
   plan §2 "스코프 우선순위 규칙(P1-13)"의 "같은 자산이 3개 프로젝트에서 enabled면 Installation 3건이
   정상"과 정확히 일치하는 실측 사례. **`id` 단독으로 접으면 이 정보가 사라진다** — Installation은
   `(asset_id, machine_id, enabled_at, project_path)` 조합으로 append해야 하며, `projectPath`가
   바로 그 네 번째 키의 출처다.
2. **`mcpServers`는 상시 존재하는 키가 아니라 선택 필드다** — MCP 서버를 갖지 않는 플러그인(예:
   `bmad-*@bmad-method`)에는 아예 나타나지 않는다. zod 스키마는 `mcpServers: z.array(...).optional()`로
   정의해야 한다(필수 취급 시 66개 중 다수가 파싱 실패).
3. **68/66 중복 재현 확인** — plan iter 1의 "68 엔트리 / 고유 66" 서술이 이 환경에서 그대로 재현됐다.
   원인은 위 1항(local 스코프 프로젝트별 엔트리)이며 마켓플레이스 충돌(P1-7, 이름은 같고 마켓플레이스가
   다른 자산)은 이번 실측에서 0건이었다(`same_name_different_marketplace: []`) — 이 환경에는 그 케이스가
   없을 뿐 규칙 자체는 여전히 유효하게 지켜야 한다.
4. **id 형식**은 66/66 전부 `name@marketplace`로 위반 0건 — 이 부분은 plan 가정과 일치.

## 정정된 zod 스키마 (권고 — Step 1 `core` 구현의 시작점)

```ts
const PluginListEntry = z.object({
  id: z.string().regex(/^[^@]+@[^@]+$/),
  version: z.string(),
  scope: z.enum(["user", "project", "local"]),
  enabled: z.boolean(),
  installPath: z.string(),
  installedAt: z.string(),      // ISO 8601
  lastUpdated: z.string(),      // ISO 8601
  mcpServers: z.array(z.unknown()).optional(),   // 선택 — MCP 없는 플러그인엔 없음
  projectPath: z.string().optional(),            // 선택 — scope==="local"일 때만 존재
});
```
이 스키마로 재검증하면 68/68 전부 strict parse를 통과한다(별도 스크립트로 확인 가능 — 위 로그의
"미지 키"·"누락 키"가 전부 이 두 선택 필드로 설명됨).
