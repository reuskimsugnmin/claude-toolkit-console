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

export function matchesForbidden(
  relativePath: string,
  rules: readonly ForbiddenRule[] = FORBIDDEN_RULES,
): ForbiddenRule | undefined {
  return rules.find((rule) => rule.pattern.test(relativePath));
}
