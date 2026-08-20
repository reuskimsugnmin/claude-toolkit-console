import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/**
 * 귀속(attribution) 출처. AC-0.6a 폴백값 `unverified`를 포함한다 — 원인 미확정을
 * 조용히 다른 값으로 뭉개지 않는다.
 */
export const AttributionSourceSchema = z.enum([
  "explicit_field", // attributionSkill/attributionPlugin/attributionMcpServer/attributionMcpTool 필드 존재
  "prefix_rule", // mcp__<plugin>__<tool> 접두 매칭 등 휴리스틱 귀속
  "unattributed", // 귀속 실패
]);
export type AttributionSource = z.infer<typeof AttributionSourceSchema>;

/**
 * 서브에이전트 귀속 상태 (R17 — isSidechain:true가 0건이어도 Agent tool_use는 존재하는 드리프트).
 * 경로를 못 찾으면 조용히 0으로 떨어뜨리지 않고 "unresolved"로 명시한다.
 */
export const SubagentAttributionSchema = z.enum(["resolved", "unresolved", "not_applicable"]);

/** UsageMetric — 머신 종속. 세션 트랜스크립트 실측 기반(추정 금지). */
export const UsageMetricSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    asset_id: z.string().min(1),
    machine_id: z.string().min(1),
    project_path_hash: z.string().nullable(),
    session_count: z.number().int().nonnegative(),
    token_sum: z.number().int().nonnegative(),
    last_used_at: z.string().datetime().nullable(),
    attribution_source: AttributionSourceSchema,
    subagent_attribution: SubagentAttributionSchema,
  })
  .strict();

export type UsageMetric = z.infer<typeof UsageMetricSchema>;

export function parseUsageMetric(data: unknown): UsageMetric {
  return UsageMetricSchema.parse(data);
}
