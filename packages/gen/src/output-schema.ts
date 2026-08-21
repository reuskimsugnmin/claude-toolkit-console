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
