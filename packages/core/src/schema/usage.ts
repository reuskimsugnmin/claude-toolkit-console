import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/**
 * 귀속(attribution) 출처. AC-0.6a 폴백값 `unverified`를 포함한다 — 원인 미확정을
 * 조용히 다른 값으로 뭉개지 않는다.
 *
 * ⚠️ Step 3 정정 — `explicit_field`를 `harness_field`로 개명했다. §3 AC-4 귀속 규칙 표가
 * `attribution_source` 값으로 명시한 리터럴은 정확히 `harness_field`/`prefix_rule`/`unattributed`다
 * (P6 — "하네스가 답을 주면 우리가 추측하지 않는다"는 원칙의 이름 그대로). Step 1 골격 시점엔
 * 아직 이 표가 없어 임의로 지었던 이름을 여기서 계획 원문과 맞춘다. 이 스키마는 아직 스냅샷
 * fixture 1곳 외에 소비자가 없어(Step 3 착수 시점 grep 확인) 마이그레이션 코드 없이 이름만 바꾼다.
 */
export const AttributionSourceSchema = z.enum([
  "harness_field", // attributionSkill/attributionPlugin/attributionMcpServer/attributionMcpTool/attributionAgent 필드 존재
  "prefix_rule", // mcp__<plugin>__<tool> 접두 매칭 등 휴리스틱 귀속
  "unattributed", // 귀속 실패
]);
export type AttributionSource = z.infer<typeof AttributionSourceSchema>;

/**
 * 서브에이전트 귀속 상태 (R17 — isSidechain:true가 0건이어도 Agent tool_use는 존재하는 드리프트).
 * 경로를 못 찾으면 조용히 0으로 떨어뜨리지 않고 "unresolved"로 명시한다.
 */
export const SubagentAttributionSchema = z.enum(["resolved", "unresolved", "not_applicable"]);

/**
 * `token_sum`의 측정 정의 id. AC-4.3 — 귀속된 tool_result **페이로드**의 count_tokens 실측 합이라는
 * 정의를 레코드 자신에 새긴다(스키마·버전이 바뀌면 새 리터럴을 추가하고 과거 값과 섞지 않는다).
 */
export const TOKEN_SUM_DEFINITION_V1 = "tool_result_payload_count_tokens_v1" as const;
export const TokenSumDefinitionSchema = z.literal(TOKEN_SUM_DEFINITION_V1);

/**
 * UsageMetric — 머신 종속. 세션 트랜스크립트 실측 기반(추정 금지).
 *
 * **AC-4.3 경계 — `message.usage`의 4개 키(input_tokens·output_tokens·cache_creation_input_tokens·
 * cache_read_input_tokens)는 여기 없다.** 한 assistant 메시지의 usage는 특정 툴에 나눌 수 없으므로
 * 세션 단위 `SessionUsageSchema`(schema/session-usage.ts)로 별도 보관한다 — 섞으면 "무엇을 쟀는지"가
 * 흐려진다(CLAUDE.md "frontmatter 전체와 name+description은 2배 이상 차이" 경고와 동형의 함정).
 *
 * **AC-4.9 — `harness_usage_count`/`harness_last_used_at`은 교차검증 값이지 1차 값이 아니다.**
 * 1차 값은 항상 `call_count`/`last_used_at`(트랜스크립트 파싱 결과)이고, 하네스 값은 나란히 저장만
 * 한다 — 자동 보정·평균·둘 중 큰 값 채택 금지(§1.3 결정 5 "호출 실적의 교차 검증 소스").
 */
export const UsageMetricSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    asset_id: z.string().min(1),
    machine_id: z.string().min(1),
    project_path_hash: z.string().nullable(),
    /** 귀속된 tool_use 호출 건수. AC-4.1 — 귀속 우선순위대로 산출된다. */
    call_count: z.number().int().nonnegative(),
    token_sum: z.number().int().nonnegative(),
    token_sum_definition: TokenSumDefinitionSchema,
    /** 귀속된 tool_use의 최대 timestamp. AC-4.2. */
    last_used_at: z.string().datetime().nullable(),
    attribution_source: AttributionSourceSchema,
    /** 귀속을 성립시킨 규칙 이름(예: "harness_field:attributionSkill", "prefix_rule:skill_tool_input"). */
    attribution_rule: z.string().min(1),
    subagent_attribution: SubagentAttributionSchema,
    /** `~/.claude.json`의 skillUsage/pluginUsage — AC-4.9 교차검증. 대상 없음(CLI 등)이면 null. */
    harness_usage_count: z.number().int().nonnegative().nullable(),
    harness_last_used_at: z.string().datetime().nullable(),
    /** call_count vs harness_usage_count 괴리 플래그 — 자동 보정하지 않고 세워만 둔다(AC-4.9). */
    usage_divergence: z.boolean(),
  })
  .strict();

export type UsageMetric = z.infer<typeof UsageMetricSchema>;

export function parseUsageMetric(data: unknown): UsageMetric {
  return UsageMetricSchema.parse(data);
}
