/**
 * gen/src/extract-frontmatter.ts — spawn_metadata는 **생성하지 않고 원본 frontmatter에서
 * 문자열 그대로 추출**한다(name·description·allowed-tools·model 등). LLM 재서술을 절대 하지
 * 않는다 — AC-3.4는 이 값과 최종 산출물의 문자열이 완전히 같아야 한다고 단언한다.
 *
 * `probe/src/frontmatter.ts`의 `parseSimpleFrontmatter`(키:값만, 중첩·리스트 없음)를 그대로
 * 쓰되, 이 모듈은 **라인 번호**까지 추적한다 — 추출값에는 원문 라인 범위가 자동으로 붙으므로
 * P5(인용 강제)와 상성이 가장 좋다(citation-check.ts의 인용 태그 대신 `extracted_from`
 * 경로를 갖는다 — 생성물이 아니므로).
 */

export interface ExtractedField {
  value: string;
  /** 인용 태그(`citation-check.ts`)가 아니라 이 형태로 추적한다 — 생성물이 아니라 원문
   * 그대로의 추출이기 때문이다(AC-3.6 예외). */
  extractedFrom: { sourceRef: string; lineStart: number; lineEnd: number };
}

/** SKILL.md/plugin.json frontmatter에서 spawn_metadata로 쓸 표준 필드 이름. */
export const SPAWN_METADATA_KEYS = ["name", "description", "allowed-tools", "model"] as const;
export type SpawnMetadataKey = (typeof SPAWN_METADATA_KEYS)[number];

/** `parseSimpleFrontmatter`와 동일한 최소 파서지만, 키별 1-based 라인 번호를 함께 반환한다. */
export function parseFrontmatterWithLines(content: string): Record<string, { value: string; line: number }> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const result: Record<string, { value: string; line: number }> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") break;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length > 0) {
      result[key] = { value, line: i + 1 }; // 1-based
    }
  }
  return result;
}

/**
 * frontmatter 원문(`content`)에서 `SPAWN_METADATA_KEYS`에 해당하는 값만 골라 문자열 그대로 +
 * 라인 인용과 함께 반환한다. `sourceRef`는 이 frontmatter가 담긴 파일의 표시용 라벨(예:
 * "SKILL.md") — 절대경로를 담지 않는다(AC-1.7).
 */
export function extractSpawnMetadata(content: string, sourceRef: string): Partial<Record<SpawnMetadataKey, ExtractedField>> {
  const parsed = parseFrontmatterWithLines(content);
  const result: Partial<Record<SpawnMetadataKey, ExtractedField>> = {};
  for (const key of SPAWN_METADATA_KEYS) {
    const entry = parsed[key];
    if (entry === undefined || entry.value.length === 0) continue;
    result[key] = {
      value: entry.value,
      extractedFrom: { sourceRef, lineStart: entry.line, lineEnd: entry.line },
    };
  }
  return result;
}
