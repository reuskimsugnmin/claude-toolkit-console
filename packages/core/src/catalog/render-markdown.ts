import type { Annotation } from "../schema/annotation.js";
import type { DocPage } from "../schema/docpage.js";

/**
 * core/src/catalog/render-markdown.ts — `Annotation`/`DocPage`(구조화 레코드, gen이 만든다) →
 * `annotation.md`/`usage.md`(카탈로그 결정 2: "자산별 마크다운") 렌더링. **한쪽 방향만** 구현한다
 * (레코드 → 마크다운) — v1은 이미 만든 구조화 레코드를 그 자리에서 렌더링해 쓰는 흐름만 필요하고,
 * 커밋된 마크다운을 다시 레코드로 파싱하는 역방향은 이 단계의 범위 밖이다(`gen --check-citations`·
 * `--resume`은 gen 실행 안에서 만든 구조화 레코드를 그대로 재사용한다 — 디스크의 .md를 다시
 * 파싱하지 않는다).
 *
 * frontmatter에는 **스칼라 값만** 둔다(스키마의 짧은 필드) — `role`/`purpose`/`when_to_use`/
 * `body`처럼 콜론·개행이 섞일 수 있는 프로즈는 YAML 이스케이프 문제를 피하려고 본문 섹션으로만
 * 렌더링한다.
 */

function yamlFrontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * iter 8 · B1-4 — 두 문서 상단에 항상 붙는 고정 문구. `gen/src/source-trust.ts`가 그대로
 * 재노출하고, AC-3.9는 이 문자열의 정확한 존재를 단언한다 — 값이 바뀌면 한 곳(여기)만 고치면
 * 렌더러와 검사기가 함께 갱신된다.
 */
export const GEN_SOURCE_TRUST_HEADER = "출처: 서드파티 원문 기반 · 자동 생성";

const SOURCE_TRUST_HEADER_LINE = (trust: string) => `> ${GEN_SOURCE_TRUST_HEADER} (${trust})\n`;

export function renderAnnotationMarkdown(annotation: Annotation): string {
  const frontmatter = yamlFrontmatter({
    schema_version: String(annotation.schema_version),
    _scope: annotation._scope,
    asset_id: annotation.asset_id,
    gen_mode: annotation.gen_mode,
    gen_source_trust: annotation.gen_source_trust,
    generated_at: annotation.generated_at,
  });
  return [
    frontmatter,
    "",
    SOURCE_TRUST_HEADER_LINE(annotation.gen_source_trust),
    "",
    "## Role",
    "",
    annotation.role,
    "",
    "## Purpose",
    "",
    annotation.purpose,
    "",
    "## When to use",
    "",
    annotation.when_to_use,
    "",
  ].join("\n");
}

export function renderDocPageMarkdown(docPage: DocPage): string {
  const frontmatter = yamlFrontmatter({
    schema_version: String(docPage.schema_version),
    _scope: docPage._scope,
    asset_id: docPage.asset_id,
    catalog_relative_path: docPage.catalog_relative_path,
    gen_mode: docPage.gen_mode,
    gen_source_trust: docPage.gen_source_trust,
    generated_at: docPage.generated_at,
  });
  return [frontmatter, "", SOURCE_TRUST_HEADER_LINE(docPage.gen_source_trust), "", `# ${docPage.title}`, "", docPage.body, ""].join(
    "\n",
  );
}
