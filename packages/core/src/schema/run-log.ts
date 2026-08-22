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
  })
  .strict();

export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

export function parseRunLogEntry(data: unknown): RunLogEntry {
  return RunLogEntrySchema.parse(data);
}
