/**
 * 어떤 allowlist로도 허용될 수 없는 경로 패턴 — allowlist보다 항상 우선한다.
 * 착수 조건 C3의 방어선: tmp 정규식이 앵커되지 않으면(`.*` 와일드카드) 경로 순회로
 * 화이트리스트를 뚫을 수 있다. forbidden은 그 최후 방어선이다.
 */
export interface ForbiddenRule {
  pattern: RegExp;
  note: string;
}

export const FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  { pattern: /\.\./, note: "경로 순회(path traversal) 금지 — 어떤 allowlist보다 우선" },
  { pattern: /^\//, note: "절대경로는 상대화된 diff 입력에 나타나서는 안 된다" },
  { pattern: /\0/, note: "NUL 바이트 금지" },
];

/**
 * AC-2.7-c 금지 목록 — churn 예외 없음(§4 Step 5). 이 셋은 Tier-2 허용목록에 미래에 실수로
 * 추가돼도(Pre-mortem H — "가드가 살아는 있는데 아무것도 안 막는다") 여기서 항상 우선 차단된다
 * — forbidden은 allowlist보다 먼저 판정되므로(tree-diff.ts judgePath) 이것이 마지막 방어선이다.
 *
 * - CLAUDE.md — "모든 위치의"(config·project 어느 트리 루트에서 스캔하든 상대경로 어디든) 금지.
 * - `<config>/plugins/installed_plugins.json` — install scope 출처, v1 쓰기 금지 목록(P0-3).
 * - `<config>/settings.local.json` — Tier 1(`settings.json`) 밖의 개인 오버라이드 파일.
 *
 * Tier 1 대상 외의 `skills/*`는 별도 규칙을 두지 않는다 — 액션마다 동적으로 구성되는
 * Tier-1 allowlist(대상 스킬명만 정확히 포함)에 없으면 tree-diff.judgePath가 기본적으로
 * violation으로 떨어진다(allowlist 매치 실패 = 위반). 별도 forbidden 규칙 없이도 이미 막힌다.
 */
export const AC_2_7_C_FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  ...FORBIDDEN_RULES,
  { pattern: /(^|\/)CLAUDE\.md$/, note: "AC-2.7-c 금지 목록 — 모든 위치의 CLAUDE.md, churn 예외 없음" },
  {
    pattern: /^plugins\/installed_plugins\.json$/,
    note: "AC-2.7-c 금지 목록 — install scope 출처, v1 쓰기 금지(P0-3)",
  },
  { pattern: /^settings\.local\.json$/, note: "AC-2.7-c 금지 목록 — Tier 1 밖의 개인 오버라이드 파일" },
];

export function matchesForbidden(
  relativePath: string,
  rules: readonly ForbiddenRule[] = FORBIDDEN_RULES,
): ForbiddenRule | undefined {
  return rules.find((rule) => rule.pattern.test(relativePath));
}
