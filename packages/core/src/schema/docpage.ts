import { z } from "zod";
import { machineIndependentTag, schemaVersion } from "./common.js";
import { GenModeSchema } from "./annotation.js";

/** 인용 근거 — P5(인용 강제). 원문 라인 범위를 자동으로 붙인다 (특히 rule_extract 경로). */
export const CitationSchema = z
  .object({
    source_ref: z.string().min(1),
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
  })
  .strict();

/**
 * DocPage — 머신 독립. 자동 생성된 사용법 문서(`usage.md`에 대응, 카탈로그 결정 2).
 * 카탈로그 상대 경로만 담고 절대경로는 금지한다.
 */
export const DocPageSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineIndependentTag,
    asset_id: z.string().min(1),
    /** 카탈로그 루트 상대 경로 (예: "assets/skill/demo-skill/usage.md") */
    catalog_relative_path: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    citations: z.array(CitationSchema),
    gen_mode: GenModeSchema,
    generated_at: z.string().datetime(),
  })
  .strict();

export type DocPage = z.infer<typeof DocPageSchema>;

export function parseDocPage(data: unknown): DocPage {
  return DocPageSchema.parse(data);
}
