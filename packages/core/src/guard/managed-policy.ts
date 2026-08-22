/**
 * core/src/guard/managed-policy.ts — iter 8 · M1 (R15의 등급화).
 *
 * `--safe-mode`는 사용자 커스터마이즈를 전면 차단하지만 **Admin/policy(managed) 설정은
 * 여전히 적용된다**(`claude --help` 명시). 기업 관리 훅이 걸린 환경에서는 `sealed-live` 봉인이
 * 원리상 불완전하다 — 우리가 끌 수 없는 훅이 유료 서브프로세스와 함께 돈다.
 *
 * "존재 여부"만으로는 부족하다: ⓐ nightly·CI·웹 버튼은 사용자가 보지 않는 시점에 유료 세션을
 * 띄운다(경고를 아무도 읽지 않는다) ⓑ 모델만 고정하는 정책과 `hooks`가 든 정책은 위험도가
 * 다르다. 그래서 내용을 파싱해 위험 키(`hooks`·`apiKeyHelper`·`awsAuthRefresh`·`env`) 존재를
 * 등급으로 기록하고, 하나라도 있으면 **비대화형 실행은 명시 옵트인 없이 거부**한다.
 *
 * 이 파일은 판정만 한다(순수 함수, I/O 없음) — managed 정책 파일을 실제로 읽는 것(OS별 경로)은
 * `probe/src/managed-policy.ts`의 몫이다. 정책 **내용 원문**은 이 판정기의 반환값에도, 호출자가
 * 로그에 남길 값에도 절대 담기지 않는다 — 키 이름만 남는다(§7.1).
 */

export const MANAGED_POLICY_RISK_KEYS = ["hooks", "apiKeyHelper", "awsAuthRefresh", "env"] as const;
export type ManagedPolicyRiskKey = (typeof MANAGED_POLICY_RISK_KEYS)[number];

export interface ManagedPolicyGrade {
  keysPresent: ManagedPolicyRiskKey[];
  hasRisk: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 하나 이상의 파싱된 managed 정책 객체(존재하지 않는 경로는 호출자가 애초에 배열에 넣지
 * 않는다)에서 위험 키 존재 여부를 등급화한다. 여러 정책 파일에 걸쳐 하나라도 그 키가 있으면
 * 그 키는 "존재"로 카운트한다.
 */
export function gradeManagedPolicy(policies: readonly unknown[]): ManagedPolicyGrade {
  const present = new Set<ManagedPolicyRiskKey>();
  for (const policy of policies) {
    if (!isPlainObject(policy)) continue;
    for (const key of MANAGED_POLICY_RISK_KEYS) {
      if (key in policy) present.add(key);
    }
  }
  const keysPresent = MANAGED_POLICY_RISK_KEYS.filter((k) => present.has(k));
  return { keysPresent, hasRisk: keysPresent.length > 0 };
}

export type ManagedPolicyDecision = "allowed" | "blocked";

export interface ManagedPolicyGateOptions {
  interactive: boolean;
  /** `--allow-managed-policy` 명시 옵트인. */
  allowManagedPolicy: boolean;
  /**
   * managed 정책 파일이 **존재하는데 파싱하지 못했으면** `true`.
   *
   * ⚠️ 이것을 빼면 `readManagedPolicies()`의 파싱 실패가 빈 배열로 흘러들어와
   * `hasRisk: false`가 되고, **깨진 정책 파일이 "정책 없음"과 같은 판정을 받는다.**
   * 위험이 없는 것이 아니라 **위험을 판정할 수 없는 것**이다(안전 원칙 7).
   */
  unreadablePolicyPresent?: boolean;
}

/**
 * §7.2 `managed_policy_blocked` 판정 — 위험 키가 있거나 **판정 불가**이고, 비대화형이며,
 * 옵트인이 없으면 거부한다. 대화형은 경고 후 진행(이 분류를 쓰지 않는다) — 사용자가 그 자리에서
 * 직접 판단할 수 있다.
 */
export function decideManagedPolicyGate(
  grade: ManagedPolicyGrade,
  options: ManagedPolicyGateOptions,
): ManagedPolicyDecision {
  // 판정 불가를 "위험 없음"과 같이 취급하지 않는다 — 깨진 정책 파일이 게이트를 여는 열쇠가 된다.
  const needsGate = grade.hasRisk || options.unreadablePolicyPresent === true;
  if (!needsGate) return "allowed";
  if (options.interactive) return "allowed";
  if (options.allowManagedPolicy) return "allowed";
  return "blocked";
}
