import { z } from "zod";

/**
 * gen/src/output-schema.ts — iter 8 · B1-2 (§1.3 결정 6 부속 「신뢰 경계」 통제 2: 출력 스키마
 * 강제, P6 — 하네스가 주는 것).
 *
 * `claude -p`의 `--json-schema <schema>` + `--output-format json`으로 산출을 **고정 스키마
 * JSON**(필드 목록 + 필드별 최대 길이)으로 받는다. 자유 텍스트 출력 경로를 남기지 않는다 —
 * 인젝션된 지시가 "산출물 전체를 대체"하는 형태로는 통과할 수 없고, 정의된 필드 안에서만
 * 텍스트가 나올 수 있다(그 필드 내용 자체의 인젝션은 `output-verify.ts`가 별도로 잡는다).
 *
 * 이 파일은 **`--json-schema` 인자로 넘길 JSON Schema(순수 데이터)**와, 그 계약을 코드에서도
 * 동일하게 강제하는 **zod 스키마**를 함께 정의한다 — 둘이 갈리면(하나만 갱신) 하네시가 통과시킨
 * JSON을 우리 코드가 다시 거부하는 조용한 불일치가 생긴다. `output-schema.test.ts`가 필드
 * 집합·길이 상한이 둘 사이에 정확히 일치하는지 단언한다.
 */

export const GEN_OUTPUT_FIELD_MAX_LENGTH = {
  role: 200,
  purpose: 500,
  when_to_use: 800,
  usage_title: 200,
  usage_body: 8000,
  citation_source_ref: 200,
} as const;

const MAX_CITATIONS = 40;

export const GenOutputCitationSchema = z
  .object({
    source_ref: z.string().min(1).max(GEN_OUTPUT_FIELD_MAX_LENGTH.citation_source_ref),
    line_start: z.number().int().min(1),
    line_end: z.number().int().min(1),
  })
  .strict();

export const GenOutputPayloadSchema = z
  .object({
    role: z.string().min(1).max(GEN_OUTPUT_FIELD_MAX_LENGTH.role),
    purpose: z.string().min(1).max(GEN_OUTPUT_FIELD_MAX_LENGTH.purpose),
    when_to_use: z.string().min(1).max(GEN_OUTPUT_FIELD_MAX_LENGTH.when_to_use),
    usage_title: z.string().min(1).max(GEN_OUTPUT_FIELD_MAX_LENGTH.usage_title),
    usage_body: z.string().min(1).max(GEN_OUTPUT_FIELD_MAX_LENGTH.usage_body),
    citations: z.array(GenOutputCitationSchema).max(MAX_CITATIONS),
  })
  .strict();

export type GenOutputPayload = z.infer<typeof GenOutputPayloadSchema>;

export class GenOutputSchemaViolationError extends Error {
  constructor(cause: unknown) {
    super(`claude -p의 --json-schema 산출물이 GenOutputPayloadSchema를 벗어난다: ${String(cause)}`);
    this.name = "GenOutputSchemaViolationError";
  }
}

/** `claude -p` stdout(원문 JSON 텍스트)을 파싱하고 zod strict로 검증한다. 벗어나면 거부한다 —
 * 필드 추가·길이 초과 0건이 AC-3.9의 단언 대상이다. */
export function parseGenOutputPayload(rawJson: string): GenOutputPayload {
  let data: unknown;
  try {
    data = JSON.parse(rawJson) as unknown;
  } catch (cause) {
    throw new GenOutputSchemaViolationError(cause);
  }
  const result = GenOutputPayloadSchema.safeParse(data);
  if (!result.success) {
    throw new GenOutputSchemaViolationError(result.error);
  }
  return result.data;
}

/**
 * `claude -p --json-schema`에 그대로 넘길 JSON Schema 리터럴(draft 호환 서브셋 — 표준 JSON
 * Schema `type`/`properties`/`required`/`additionalProperties`/`maxLength`/`minimum`만 쓴다).
 * 필드 집합·길이 상한은 `GenOutputPayloadSchema`와 반드시 일치해야 한다(테스트가 단언).
 */
export function buildGenOutputJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["role", "purpose", "when_to_use", "usage_title", "usage_body", "citations"],
    properties: {
      role: { type: "string", maxLength: GEN_OUTPUT_FIELD_MAX_LENGTH.role },
      purpose: { type: "string", maxLength: GEN_OUTPUT_FIELD_MAX_LENGTH.purpose },
      when_to_use: { type: "string", maxLength: GEN_OUTPUT_FIELD_MAX_LENGTH.when_to_use },
      usage_title: { type: "string", maxLength: GEN_OUTPUT_FIELD_MAX_LENGTH.usage_title },
      usage_body: { type: "string", maxLength: GEN_OUTPUT_FIELD_MAX_LENGTH.usage_body },
      citations: {
        type: "array",
        maxItems: MAX_CITATIONS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source_ref", "line_start", "line_end"],
          properties: {
            source_ref: { type: "string", maxLength: GEN_OUTPUT_FIELD_MAX_LENGTH.citation_source_ref },
            line_start: { type: "integer", minimum: 1 },
            line_end: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  };
}

/**
 * `claude -p --output-format json`의 **봉투**에서 모델 산출물만 꺼낸다.
 *
 * 실측 봉투 최상위 키(2.1.239): `result`·`is_error`·`usage`·`modelUsage`·`session_id`·
 * `stop_reason`·`subagent_stats`·`structured_output`·`ttft_ms` 등 20여 개. 이 봉투를 그대로
 * `GenOutputPayloadSchema`에 넣으면 당연히 거부된다 — 실제로 그 버그가 있었다.
 *
 * 꺼내는 순서: `--json-schema`를 쓰면 `structured_output`에 파싱된 객체가 오고, 없으면
 * `result` 문자열을 파싱한다. `result`는 모델이 ```json 펜스로 감싸 보내는 경우가 있어
 * (실측) 펜스를 벗겨낸다.
 *
 * **봉투는 하네스 소유라 키가 계속 늘어난다**(전략상 passthrough), **페이로드는 우리 소유라
 * strict를 유지한다**(B1-2 — 산출 형태 원천 통제가 인젝션 방어의 축이다). 이 비대칭이 의도된
 * 설계다.
 */
const GenEnvelopeSchema = z
  .object({
    is_error: z.boolean().optional(),
    result: z.unknown().optional(),
    structured_output: z.unknown().optional(),
    /** 하네스가 싣는 이 호출의 실비용. **없을 수 있다** — 없으면 null이고 0으로 대체하지 않는다. */
    total_cost_usd: z.number().nonnegative().optional(),
    /**
     * 이 호출을 실제로 처리한 모델과 토큰. **기록하지 않으면 실측 단가가 어떤 모집단의
     * 것인지 말할 수 없다**(안전 원칙 8 — 모집단이 결론을 지탱하는지 함께 싣는다).
     * 봉투는 하네스 소유라 키가 늘 수 있으므로 전부 optional이고, 없으면 null이다.
     */
    modelUsage: z.record(z.string(), z.unknown()).optional(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative().finite().optional(),
        output_tokens: z.number().nonnegative().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** 이 호출이 실제로 무엇으로 처리됐는가. 판정할 수 없으면 `null`이다 — 지어내지 않는다. */
export interface GenCallProvenance {
  /** 하네스가 보고한 모델 id. 못 읽으면 null — "기본 모델"로 추측하지 않는다. */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export class GenEnvelopeError extends Error {
  constructor(message: string) {
    super(`claude -p --output-format json 봉투를 해석할 수 없다: ${message}`);
    this.name = "GenEnvelopeError";
  }
}

function stripJsonFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * 봉투에서 **비용만** 꺼낸다 — 실패한 호출에도 `total_cost_usd`가 실려 오므로(실측 2026-08-24)
 * 페이로드 검증과 분리해야 실패 경로에서도 읽을 수 있다.
 *
 * ⚠️ **파싱 실패를 0으로 삼키지 않는다**(안전 원칙 7) — 못 읽으면 `null`이고, 호출자는 그것을
 * "0원"이 아니라 "미보고"로 센다. 합계에 0을 더하면 총액이 조용히 낮아진다.
 */
export function readEnvelopeCostUsd(rawStdout: string): number | null {
  try {
    const parsed = GenEnvelopeSchema.safeParse(JSON.parse(rawStdout));
    return parsed.success ? (parsed.data.total_cost_usd ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * 봉투에서 **모델과 토큰**을 꺼낸다. 비용과 마찬가지로 실패 경로에서도 읽혀야 하므로
 * 페이로드 검증과 분리한다.
 *
 * ⚠️ **못 읽으면 `null`이고 "기본 모델"로 추측하지 않는다**(안전 원칙 7). 모델을 모르는 채
 * 단가를 쌓으면 그 단가는 서로 다른 모집단이 섞인 값이 되고, 견적이 조용히 틀린다.
 *
 * 모델 id는 `modelUsage` 맵의 키로 실린다(하네스가 모델별로 사용량을 나눠 담는다).
 * 키가 여럿이면 **판정하지 않는다** — 한 호출이 두 모델을 탔다는 뜻이고, 그 경우 "어느
 * 모델의 단가인가"에 답할 수 없다.
 */
export function readEnvelopeProvenance(rawStdout: string): GenCallProvenance {
  const empty: GenCallProvenance = { model: null, inputTokens: null, outputTokens: null };
  try {
    const parsed = GenEnvelopeSchema.safeParse(JSON.parse(rawStdout));
    if (!parsed.success) return empty;
    const keys = Object.keys(parsed.data.modelUsage ?? {});
    return {
      model: keys.length === 1 ? (keys[0] ?? null) : null,
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      outputTokens: parsed.data.usage?.output_tokens ?? null,
    };
  } catch {
    return empty;
  }
}

/** 봉투 stdout → 엄격 검증된 페이로드. 봉투 해석과 페이로드 검증을 분리한다. */
export function parseGenEnvelope(rawStdout: string): GenOutputPayload {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawStdout);
  } catch (err) {
    throw new GenEnvelopeError(`JSON 파싱 실패: ${String(err)}`);
  }
  const parsed = GenEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new GenEnvelopeError(String(parsed.error));

  if (parsed.data.is_error === true) {
    throw new GenEnvelopeError(`is_error=true — 세션이 오류로 끝났다: ${String(parsed.data.result).slice(0, 200)}`);
  }

  // `--json-schema` 경로: 이미 객체다.
  if (parsed.data.structured_output !== undefined && parsed.data.structured_output !== null) {
    return GenOutputPayloadSchema.parse(parsed.data.structured_output);
  }
  // 폴백: result 문자열을 펜스 제거 후 파싱한다.
  if (typeof parsed.data.result !== "string") {
    throw new GenEnvelopeError("structured_output도 result 문자열도 없다 — 산출물을 꺼낼 수 없다");
  }
  return parseGenOutputPayload(stripJsonFence(parsed.data.result));
}
