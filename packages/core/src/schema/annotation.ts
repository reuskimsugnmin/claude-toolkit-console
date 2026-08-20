import { z } from "zod";
import { machineIndependentTag, schemaVersion } from "./common.js";

/** Annotation은 자동 생성된다(스펙 Ontology) — rule_extract 폴백(iter 7)과 LLM 생성을 구분해서 기록한다. */
export const GenModeSchema = z.enum(["llm", "rule_extract"]);
export type GenMode = z.infer<typeof GenModeSchema>;

/**
 * Annotation — 머신 독립. "언제 쓰는가"(문제 1의 답). 머신이 바뀌어도 유지돼야 한다
 * (CLAUDE.md 스키마의 척추) — Installation(머신 종속, "이 로컬에 깔려 있나")과 섞지 않는다.
 */
export const AnnotationSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineIndependentTag,
    asset_id: z.string().min(1),
    role: z.string().min(1),
    purpose: z.string().min(1),
    when_to_use: z.string().min(1),
    gen_mode: GenModeSchema,
    generated_at: z.string().datetime(),
  })
  .strict();

export type Annotation = z.infer<typeof AnnotationSchema>;

export function parseAnnotation(data: unknown): Annotation {
  return AnnotationSchema.parse(data);
}
