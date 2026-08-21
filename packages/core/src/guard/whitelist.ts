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
 * Tier-2 churn 허용목록 — **AC-0.8이 실제로 실측한 3개 패턴만**(.claude.json ·
 * .claude.json.tmp.* · backups/*.backup.<ts>). `ctk move`(Step 5 실제 명령 —
 * plugin enable/disable) 감사는 이 좁은 목록만 쓴다.
 *
 * ⚠️ **Step 5 보안 심사 수정(M7)** — 이전에는 미실측 항목(`plugins/repos/**` 등)까지 같은
 * 목록에 섞여 있어 실제 조치 감사에도 함께 적용됐다. `plugins/repos/**`는 **플러그인 코드
 * 트리 자체**다 — 이 패턴이 실제 조치의 허용목록에 들어있으면 조치 도중 플러그인 소스가
 * 바뀌어도(공급망 위협 시나리오) 감사를 조용히 통과한다. 실제 명령엔 실측된 것만 허용하고,
 * 미실측 병기 목록은 `TIER2_CHURN_ALLOWLIST_KNOWN_UNMEASURED`로 분리해 향후 `gen`(Step 4,
 * 모델 세션 프로파일)처럼 그 항목들이 별도로 실측될 계층에서만 쓰게 한다.
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
];

/**
 * 미실측 병기 목록(M7) — 다른 경로(AC-0.1의 10초 대조, §2.7-b 원안)에서 이미 알려졌지만
 * Step 5의 4+1개 명령 실측으로는 재현되지 않은 항목들이다. **실제 조치(`ctk move`) 감사에는
 * 쓰지 않는다** — `TIER2_CHURN_ALLOWLIST`(실측된 좁은 목록)만 쓴다. 이 목록은 향후 별도
 * 프로파일(예: `gen`의 `-p` 모델 세션)이 그 항목들을 자체적으로 실측해 확인한 뒤에만 채택
 * 대상이다. 가드 약화 금지 원칙에 따라 정보를 버리지 않고 이름을 분리해 남겨둔다.
 */
export const TIER2_CHURN_ALLOWLIST_KNOWN_UNMEASURED: readonly AllowlistRule[] = [
  { exact: "mcp-needs-auth-cache.json", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { exact: "stats-cache.json", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { exact: "history.jsonl", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^shell-snapshots\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^paste-cache\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^sessions\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^projects\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^statsig\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^todos\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^plugins\/repos\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지) — 플러그인 코드 트리 자체이므로 실제 조치 감사에 절대 포함하지 않는다" },
];
