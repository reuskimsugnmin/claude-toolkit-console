/**
 * Tier-2 churn 허용목록. 착수 조건 C3 — AC-0.8 실측값(spikes/results/AC-0.8.md)으로 갱신하되
 * tmp는 앵커된 정규식으로만 한정한다. 와일드카드는 화이트리스트를 과도하게 넓힌다.
 */
export interface AllowlistRule {
  /** 정확한 상대경로 매칭 */
  exact?: string;
  /** 앵커된 정규식 매칭. 절대 `.*`류 무앵커 와일드카드를 쓰지 않는다 (C3) */
  pattern?: RegExp;
  /** 근거 — AC-0.8 실측인지, 다른 명령에서 알려진 것(미실측)인지를 명시한다. 가드 약화 금지 */
  note: string;
}

export function matchesAllowlist(relativePath: string, rules: readonly AllowlistRule[]): AllowlistRule | undefined {
  return rules.find((rule) => {
    if (rule.exact !== undefined) return rule.exact === relativePath;
    if (rule.pattern !== undefined) return rule.pattern.test(relativePath);
    return false;
  });
}

/**
 * Tier-1 = ctk가 의도적으로 쓰는 경로 (plugin enable/disable의 settings.json, AC-0.8 실측).
 */
export const TIER1_INTENTIONAL_WRITES: readonly AllowlistRule[] = [
  { exact: "settings.json", note: "AC-0.8 실측 — enable/disable의 의도된 쓰기 대상 (Tier 1)" },
];

/**
 * Tier-2 churn 허용목록 최종값 (착수 조건 C3, AC-0.8 실측이 §2.7-b 잠정값을 대체).
 *
 * 위 3개 패턴(.claude.json · .claude.json.tmp.* · backups/*.backup.<ts>)만 AC-0.8의 4+1개 명령
 * 실측에서 직접 확인됐다. 나머지는 **이번 4개 명령으로는 재현되지 않았을 뿐** 다른 경로(세션 시작·
 * mcp 명령 등)에서 이미 알려진 항목이다 — 목록에서 빼지 않고 "다른 명령에서 알려짐"으로 병기
 * 유지한다(가드 약화 금지, AC-0.8.md 판정 근거).
 */
export const TIER2_CHURN_ALLOWLIST: readonly AllowlistRule[] = [
  { exact: ".claude.json", note: "AC-0.8 실측 — 읽기 명령(list/details)만 실행해도 매번 갱신" },
  {
    // 앵커된 정규식만 허용 (C3) — 원자적 쓰기 임시파일. 경로 순회(../) 시도는 이 패턴에 매치되지 않는다.
    pattern: /^\.claude\.json\.tmp\.\d+\.[A-Za-z0-9]+$/,
    note: "AC-0.8 실측 — plugin list --json 1회로도 생성되는 원자적 쓰기 임시파일",
  },
  {
    pattern: /^backups\/[^/]+\.backup\.\d+$/,
    note: "AC-0.8 실측 — list/details/enable/disable 전부 생성 (실패한 enable도 포함)",
  },
  // 아래는 미실측 — 다른 경로(AC-0.1의 10초 대조, §2.7-b 원안)에서 이미 알려진 항목의 병기.
  { exact: "mcp-needs-auth-cache.json", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { exact: "stats-cache.json", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { exact: "history.jsonl", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^shell-snapshots\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^paste-cache\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^sessions\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^projects\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^statsig\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^todos\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^plugins\/repos\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
];
