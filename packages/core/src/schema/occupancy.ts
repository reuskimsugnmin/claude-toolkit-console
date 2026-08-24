import { z } from "zod";
import { machineIndependentTag, schemaVersion } from "./common.js";

/**
 * core/src/schema/occupancy.ts — §1.3 결정 5 · ADR-005의 3상태 점유 토큰 계약(AC-4.4/4.5/4.8).
 *
 * **3상태는 절대 규칙이다.** `measured`만 `value_tokens`에 숫자를 담는다. 크레덴셜이 없거나
 * (이 환경 — API 키 부재) 측정 자체가 실패하면 `unmeasured`로 남기고 `value_tokens`는 항상
 * `null`이다. 문자 수/4 같은 바이트 근사치는 `approx_bytes`로만 노출하고 **토큰이 아니라고
 * 필드명 자체에 새긴다**(AC-4.5 — 추정치가 `occupancy_*_tokens` 자리에 숫자로 들어가면 실패다).
 */
export const OccupancyReasonSchema = z.enum([
  "credential_missing", // count_tokens 크레덴셜(API 키) 없음 — 이 환경의 기본 상태
  "definition_pending", // 측정 대상 콘텐츠 정의가 아직 없음(예: plugin의 loaded — Step 3 범위 밖 문서화된 단순화)
  "not_applicable", // 이 자산 유형엔 개념 자체가 없음(예: cli의 idle/loaded는 항상 0)
  "measurement_failed", // count_tokens 호출 자체가 실패함(네트워크 오류 등)
]);
export type OccupancyReason = z.infer<typeof OccupancyReasonSchema>;

/**
 * `measurement_failed`의 **원인 분류**(안전 원칙 6 — fail-closed 가드에는 복구 경로와 진단을
 * 함께 만든다). `measurement_failed`만으로는 사용자가 무엇을 고쳐야 하는지 알 수 없다 — 실제로
 * TLS 가로채기 프록시가 있는 회선에서 크레덴셜은 멀쩡한데 Node의 번들 CA가 체인을 검증하지 못해
 * 전 자산이 `measurement_failed`로 떨어지는 사례가 관측됐다(2026-08-24). 그때 화면이 알려준
 * 것은 "실패"뿐이었고 원인(`SELF_SIGNED_CERT_IN_CHAIN`)은 직접 파헤쳐야 나왔다.
 *
 * ⚠️ **분류만 싣고 원문 메시지·값은 절대 싣지 않는다.** 오류 메시지에는 URL·헤더·토큰 조각이
 * 섞일 수 있다(env-whitelist의 `leakedKeys`가 키 이름만 담는 것과 동형의 설계).
 *
 * ⚠️ **분류할 수 없으면 `unclassified`다.** 그럴듯한 분류를 지어내지 않는다(안전 원칙 7).
 */
export const OccupancyFailureKindSchema = z.enum([
  "tls_chain_untrusted", // 체인 검증 실패 — 가로채기 프록시의 루트 CA가 Node 신뢰 저장소에 없음
  "network_unreachable", // DNS/연결 실패 — 오프라인·방화벽·프록시 미도달
  "rate_limited", // 429
  "api_error", // 그 밖의 API 상태 코드 응답(4xx/5xx)
  "unclassified", // 위 어디에도 해당한다고 판정할 수 없음
]);
export type OccupancyFailureKind = z.infer<typeof OccupancyFailureKindSchema>;

const MeasuredValueSchema = z
  .object({
    state: z.literal("measured"),
    value_tokens: z.number().int().nonnegative(),
    tokenizer_model: z.string().min(1),
    measured_at: z.string().datetime(),
  })
  .strict();

const UnmeasuredValueSchema = z
  .object({
    state: z.literal("unmeasured"),
    value_tokens: z.null(),
    reason: OccupancyReasonSchema,
    /**
     * `reason === "measurement_failed"`일 때만 채운다 — 그 외 사유는 원인이 사유 자체로 이미
     * 확정돼 있다. **선택 필드다**: 이 필드가 생기기 전에 쌓인 스냅샷은 append-only로 남아 있고
     * 그대로 파싱돼야 한다(옛 레코드에 없다고 해서 파싱 실패로 뒤집으면 기록이 소급 손상된다).
     */
    failure_kind: OccupancyFailureKindSchema.optional(),
  })
  .strict();

const ApproxBytesValueSchema = z
  .object({
    state: z.literal("approx_bytes"),
    value_tokens: z.null(),
    approx_bytes: z.number().int().nonnegative(),
  })
  .strict();

export const OccupancyValueSchema = z.discriminatedUnion("state", [
  MeasuredValueSchema,
  UnmeasuredValueSchema,
  ApproxBytesValueSchema,
]);
export type OccupancyValue = z.infer<typeof OccupancyValueSchema>;

/**
 * idle 정의 규칙 id. AC-0.7 실측이 확정한 폴백 — MCP/hooks는 하네스 판정("not counted"/
 * "no model context cost")을 그대로 받아쓴다(P6, `harness-parity`). ctk 자체 정의로 반박하는
 * 안(`ctk-v1-mcp-included`)은 열거값만 남겨두고 v1에서는 채택하지 않는다.
 */
export const IdleDefinitionSchema = z.enum(["ctk-v1-mcp-included", "harness-parity"]);
export type IdleDefinition = z.infer<typeof IdleDefinitionSchema>;

/**
 * 5D 교차검증 값 — `claude plugin details`의 "Projected token cost — Always-on" 파싱 결과.
 * 1차 소스가 아니다(§1.3 결정 5) — plugin 자산에만 존재하고, 파싱 실패·비-plugin 자산은
 * unmeasured로 남는다.
 */
const HarnessAlwaysOnMeasuredSchema = z
  .object({
    state: z.literal("measured"),
    value_tokens: z.number().int().nonnegative(),
    source: z.literal("plugin_details_parse"),
    measured_at: z.string().datetime(),
  })
  .strict();

const HarnessAlwaysOnUnmeasuredSchema = z
  .object({
    state: z.literal("unmeasured"),
    value_tokens: z.null(),
    reason: z.enum(["not_a_plugin", "parse_failed", "command_failed"]),
  })
  .strict();

export const HarnessAlwaysOnSchema = z.discriminatedUnion("state", [
  HarnessAlwaysOnMeasuredSchema,
  HarnessAlwaysOnUnmeasuredSchema,
]);
export type HarnessAlwaysOn = z.infer<typeof HarnessAlwaysOnSchema>;

/**
 * Occupancy — 머신 독립(Asset과 동형의 신뢰 모델). "이 자산이 항상/호출 시 얼마나 컨텍스트를
 * 쓰는가"는 콘텐츠(name+description, SKILL.md 전문 등)의 성질이지 이 머신의 성질이 아니다 —
 * Asset.description이 이미 같은 방식(매 스캔마다 덮어쓰기)으로 다뤄진다(sync/asset-store.ts 주석
 * 참조). `harness_alwayson`은 로컬에서 `claude plugin details`를 실행해 얻으므로 엄밀히는 그
 * 실행이 일어난 머신의 관측이지만, 값 자체(플러그인 번들 콘텐츠 기반 산출)는 설치 버전이 같으면
 * 머신이 달라도 같아야 하는 값이라 Asset과 동일한 신뢰 모델을 따른다(매 `ctk measure`가 최신값으로
 * 덮어쓴다).
 *
 * **`idle_definition`은 레코드 최상위 필드다** — AC-4.4가 "idle/loaded 각각 state·tokenizer_model·
 * measured_at·idle_definition을 보유"라고 적었으나, idle_definition은 측정 규칙(정책)이지 개별
 * 측정값의 속성이 아니다. idle과 loaded 양쪽에 같은 값을 중복 저장하면 두 필드가 서로 다른 값으로
 * 드리프트할 여지만 생기고 실익이 없다 — 레코드 하나에 정책 하나만 있으면 되므로 최상위로 올렸다
 * (문서화된 설계 선택, executor 판단).
 */
export const OccupancySchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineIndependentTag,
    asset_id: z.string().min(1),
    idle: OccupancyValueSchema,
    loaded: OccupancyValueSchema,
    idle_definition: IdleDefinitionSchema,
    harness_alwayson: HarnessAlwaysOnSchema,
    /** AC-4.8 — ctk idle 합계 vs harness_alwayson 괴리율이 임계(기본 ±20%)를 넘으면 true. 자동 보정 없음. */
    occupancy_divergence: z.boolean(),
    occupancy_divergence_ratio: z.number().nonnegative().nullable(),
  })
  .strict();

export type Occupancy = z.infer<typeof OccupancySchema>;

export function parseOccupancy(data: unknown): Occupancy {
  return OccupancySchema.parse(data);
}
