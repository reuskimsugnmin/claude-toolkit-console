import { z } from "zod";
import { machineIndependentTag, schemaVersion } from "./common.js";

/** Annotation은 자동 생성된다(스펙 Ontology) — rule_extract 폴백(iter 7)과 LLM 생성을 구분해서 기록한다. */
export const GenModeSchema = z.enum(["llm", "rule_extract"]);
export type GenMode = z.infer<typeof GenModeSchema>;

/**
 * §1.3 결정 6 부속 「신뢰 경계」 통제 4 (iter 8 · B1-4 · R18) — 서드파티 원문의 출처.
 * `usage.md`/`annotation.md`는 "이 원문을 누가 썼는가"에 따라 신뢰 수준이 다르므로, gen이
 * 산출물 frontmatter에 항상 기록한다. `unknown`은 "출처를 특정하지 못했다"는 뜻이지 안전하다는
 * 뜻이 아니다 — `ctk doctor`가 `unknown` 건수를 노출한다(§7.3).
 */
export const GenSourceTrustSchema = z.enum(["marketplace", "local", "unknown"]);
export type GenSourceTrust = z.infer<typeof GenSourceTrustSchema>;

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
    /** iter 8 · B1-4 — 이 문서가 근거로 삼은 서드파티 원문의 출처. */
    gen_source_trust: GenSourceTrustSchema,
    generated_at: z.string().datetime(),
  })
  .strict();

export type Annotation = z.infer<typeof AnnotationSchema>;

export function parseAnnotation(data: unknown): Annotation {
  return AnnotationSchema.parse(data);
}
