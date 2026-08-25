import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";
import { FailureClassSchema } from "../failure/classes.js";

/**
 * §7.1 — spawn 직전 claude --version 대조 결과 (iter 8 · B5). `core/guard/preflight-version.ts`의
 * `PreflightVersionMatch`와 값 집합이 동일한 판정 결과이지만, 이쪽은 **로그 레코드에 영구
 * 저장되는 필드의 타입**이라 별도 이름을 쓴다(판정기의 런타임 반환 타입과 저장 스키마를
 * 같은 이름으로 두면 모듈 양쪽에서 이름이 충돌한다).
 */
export const PreflightVersionMatchSchema = z.enum(["match", "mismatch_routing_reproduced", "mismatch_rejected"]);
export type RunLogPreflightVersionMatch = z.infer<typeof PreflightVersionMatchSchema>;

/**
 * §7.1 — managed 정책에서 관측된 위험 키 집합 (iter 8 · M1). 정책 내용 원문은 절대 담지 않는다 —
 * 키 이름만. `core/guard/managed-policy.ts`의 `ManagedPolicyGrade`(판정기 반환 타입,
 * `keysPresent`/`hasRisk`)와는 필드 형태가 다른 **로그 저장 스키마**라 별도 이름을 쓴다.
 */
export const ManagedPolicyGradeSchema = z
  .object({
    keys_present: z.array(z.enum(["hooks", "apiKeyHelper", "awsAuthRefresh", "env"])),
    interactive: z.boolean(),
  })
  .strict();
export type RunLogManagedPolicyGrade = z.infer<typeof ManagedPolicyGradeSchema>;

/** §7.1 — 이 실행이 쓴 봉인 프로파일. */
export const SealProfileLogSchema = z.enum(["test-isolated", "sealed-live", "agent-probe"]);
export type SealProfileLog = z.infer<typeof SealProfileLogSchema>;

/**
 * §7.1 — 산출물 후검증(B1-3)에서 걸린 규칙별 건수. 걸린 문자열 원문은 절대 담지 않는다
 * (원문을 로그에 담으면 오염이 로그로 전파된다) — 규칙 id와 건수만.
 */
export const InjectionFindingsSchema = z
  .object({
    directive: z.number().int().nonnegative(),
    executable: z.number().int().nonnegative(),
    url: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  })
  .strict();
export type InjectionFindings = z.infer<typeof InjectionFindingsSchema>;

/**
 * RunLog — 머신 종속. §7 관측 가능성의 실행 로그(`runs/<iso8601>.jsonl`, 카탈로그 결정 2).
 * 자유 문자열·경로 원문 금지 — args는 값이 아니라 이미 정규화된 키만 담아야 한다(호출자 책임).
 */
/**
 * `gen` 실행의 **실측 비용**(2026-08-24 추가). 사전 견적만으로는 비용을 알 수 없다는 것이
 * 실측으로 드러나서 만들었다 — 견적은 입력 토큰만 계산해 실제의 약 1/20을 표시하고 있었고,
 * 그 숫자 위에서 승인이 이뤄지고 있었다(이 저장소의 원칙은 "비용을 먼저 투명하게 알린다"이다).
 *
 * **머신 종속이다.** 자산당 실비용은 그 머신에 깔린 툴의 원문 크기에 달렸으므로 카탈로그의
 * 머신별 영역에 쌓이고, **제품 코드에 상수로 박지 않는다**(이 저장소는 public이며 개인 사용량
 * 수치를 담지 않는다).
 *
 * ⚠️ **합계를 "전부"로 읽지 않기 위해 미보고 건수를 함께 남긴다**(안전 원칙 7). 하네스가
 * `total_cost_usd`를 싣지 않은 호출이 있으면 `reported_total_usd`는 총액이 아니라 **하한**이다.
 */
export const GenCostSchema = z
  .object({
    calls_reported: z.number().int().nonnegative(),
    calls_unreported: z.number().int().nonnegative(),
    /** 보고된 호출들의 합. `calls_unreported > 0`이면 하한이다. */
    // ⚠️ `.finite()`가 없으면 `Infinity`가 통과한다 — JSON의 `1e400`은 `JSON.parse`에서
    // `Infinity`가 되고 `Infinity >= 0`은 참이다(심사 L-4). run log는 private 동기화 저장소를
    // 통해 **다른 머신에서 흘러 들어오므로** 이 값을 신뢰하지 않는다.
    reported_total_usd: z.number().finite().nonnegative(),
    /** 보고된 호출당 비용의 중앙값·최대값. 보고가 0건이면 null — 0으로 대체하지 않는다. */
    median_usd: z.number().finite().nonnegative().nullable(),
    max_usd: z.number().finite().nonnegative().nullable(),
    /**
     * **이 단가가 어떤 모집단의 것인가.** 없이 쌓으면 서로 다른 모델의 비용이 한 통에 섞이고,
     * 다음 실행의 견적이 조용히 틀린다(안전 원칙 8 — 모집단이 결론을 지탱하는지 함께 싣는다).
     *
     * `models`는 이 실행에서 **실제로 관측된** 모델 id들이다. 하나면 단가가 그 모델의 것이고,
     * 둘 이상이면 섞였다는 뜻이다. 빈 배열은 **못 읽었다**는 뜻이지 "기본 모델"이 아니다.
     * `calls_model_unknown`이 그 건수를 따로 센다 — 미보고를 0으로 삼키지 않는 것과 같은 규율이다.
     */
    models: z.array(z.string()).default([]),
    calls_model_unknown: z.number().int().nonnegative().default(0),
    /** 보고된 입출력 토큰 합. 못 읽은 호출은 빼고 센다(위 `calls_model_unknown`과 짝). */
    input_tokens: z.number().int().finite().nonnegative().nullable().default(null),
    output_tokens: z.number().int().finite().nonnegative().nullable().default(null),
  })
  .strict();
export type GenCost = z.infer<typeof GenCostSchema>;

/**
 * 허용 도메인 밖 링크를 **제거한** 집계(보안 심사 M1). 거부에서 제거로 바꾸면서 만들었다.
 *
 * ⚠️ **`injection_findings.url`과 다른 축이다.** 제거를 도입한 뒤로 통과한 문서의
 * `injection_findings.url`은 **구조적으로 항상 0**이다(URL 규칙이 제거본만 보므로). 그 필드만
 * 남기면 "URL 문제가 사라졌다"로 읽히고 실제로 무엇을 몇 건 지웠는지는 어디에도 없다 —
 * 이 저장소가 반복해서 경계한 "조용히 지움"과 "항상 같은 값인 신호는 신호가 아니다"가 겹친다.
 *
 * 제거를 도입하면서 제거 기록을 안 남기면 **다음에 이 결정을 재검토할 근거 자체가 없어진다.**
 * `hosts`는 호스트만 담는다 — 전체 URL은 경로에 토큰이 섞일 수 있어 담지 않는다.
 */
export const UrlScrubSchema = z
  .object({
    removed: z.number().int().nonnegative(),
    hosts: z.array(z.string().min(1)),
  })
  .strict();
export type UrlScrub = z.infer<typeof UrlScrubSchema>;

export const RunLogEntrySchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    command: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    machine_id: z.string().min(1),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime().nullable(),
    exit_code: z.number().int().nullable(),
    failure_class: FailureClassSchema.nullable(),
    /** ctk doctor --managed-policy (R15) — Admin/policy(managed) 설정 존재 시 true */
    managed_policy_present: z.boolean().optional(),
    /** iter 8 · B5 — spawn 직전 claude --version 대조 결과 (sealed-live/agent-probe 실행에만 존재) */
    preflight_version_match: PreflightVersionMatchSchema.optional(),
    /** iter 8 · M1 — managed 정책에서 관측된 위험 키 등급 */
    managed_policy_grade: ManagedPolicyGradeSchema.optional(),
    /** iter 8 — 이 실행이 쓴 봉인 프로파일 */
    seal_profile: SealProfileLogSchema.optional(),
    /** iter 8 · B1-3 — 후검증에서 걸린 규칙별 건수 (gen 실행에만 존재) */
    injection_findings: InjectionFindingsSchema.optional(),
    /** 실측 비용 (gen 실행에만 존재). 다음 실행의 견적이 이 값을 근거로 범위를 보여준다. */
    gen_cost: GenCostSchema.optional(),
    /** 제거한 링크 집계 (gen 실행에만 존재). `injection_findings.url`과 **다른 축**이다. */
    url_scrub: UrlScrubSchema.optional(),
  })
  .strict();

export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

export function parseRunLogEntry(data: unknown): RunLogEntry {
  return RunLogEntrySchema.parse(data);
}
