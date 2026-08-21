import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/**
 * SessionUsage — 머신 종속. AC-4.3의 "message.usage 4개 키는 자산별로 귀속하지 않고 세션 단위로
 * 별도 보관한다"를 구현하는 레코드. `Toggle`과 같은 방식으로 `__kind` 판별 필드를 둬서 같은
 * 스냅샷 jsonl 스트림에 Installation/Project/UsageMetric과 함께 append할 수 있게 한다(스냅샷
 * 파일 포맷을 새로 만들지 않는다 — 카탈로그 결정 2의 "스냅샷 1개 = 1회 스캔/측정" 규약 재사용).
 *
 * `session_id`는 트랜스크립트 파일의 basename(세션 UUID)이다 — 무작위 식별자일 뿐 홈 절대경로가
 * 아니므로 AC-1.7 위생 검사 대상이 아니다.
 */
export const SessionUsageSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    __kind: z.literal("session_usage"),
    session_id: z.string().min(1),
    machine_id: z.string().min(1),
    project_path_hash: z.string().nullable(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    measured_at: z.string().datetime(),
  })
  .strict();

export type SessionUsage = z.infer<typeof SessionUsageSchema>;

export function parseSessionUsage(data: unknown): SessionUsage {
  return SessionUsageSchema.parse(data);
}
