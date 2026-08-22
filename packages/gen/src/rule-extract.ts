import { usageMdPath, type Annotation, type Asset, type Citation, type DocPage } from "@ctk/core";
import { citationTag } from "./citation-check.js";
import { extractSpawnMetadata } from "./extract-frontmatter.js";
import type { PromptEnvelopeSection } from "./prompt-envelope.js";
import { determineSourceTrust } from "./source-trust.js";

/**
 * gen/src/rule-extract.ts — `--no-llm` 폴백 계층 (상시 구현, iter 7·ADR-004).
 *
 * `claude -p`를 전혀 띄우지 않고 frontmatter·README 헤딩·`plugin.json`을 **규칙 기반으로**
 * 추출해 `Annotation`/`DocPage`를 채운다. 추출값에는 원문 라인 범위가 자동으로 붙으므로 P5
 * (인용 강제)와 상성이 가장 좋다 — `extract-frontmatter.ts`의 라인 추적을 그대로 재사용한다.
 *
 * ⚠️ **파서 안전성(M3).** 이 경로는 `probe/src/frontmatter.ts`의 최소 파서(키:값 단일 라인만,
 * 중첩·앵커·별칭 없음)와 `JSON.parse`만 쓴다 — 둘 다 YAML 앵커/별칭 폭탄 계열 DoS를 구조적으로
 * 만들 수 없다(그런 구문 자체를 해석하지 않는다). 별도의 "safe load 모드"를 켜는 것이 아니라
 * **그 위험이 존재할 수 있는 기능 자체가 이 파서에 없다.**
 *
 * ⚠️ **인젝션은 사라지지 않는다(M3).** 이 경로는 원문을 요약하지 않고 그대로 옮기므로 인젝션
 * 문자열이 축자 복사로 원형 보존된다 — `output-verify.ts`의 후검증을 **LLM 경로와 동일하게**
 * 거친다(호출자 책임, 이 모듈은 검증을 생략할 수 있는 값을 만들지 않는다는 것만 보장한다).
 */

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const WHEN_TO_USE_HEADING_PATTERN = /when\s*to\s*use|사용\s*시점|언제\s*쓰|use\s*case/i;

interface HeadingSection {
  heading: string;
  body: string;
  lineStart: number;
  lineEnd: number;
}

/** 마크다운 본문(frontmatter 제외)을 헤딩 단위 섹션으로 나눈다 — 헤딩이 없으면 전체를 본문
 * 하나짜리 섹션으로 취급한다(빈 heading 문자열). */
function extractHeadingSections(bodyContent: string, bodyStartLine: number): HeadingSection[] {
  const lines = bodyContent.split(/\r?\n/);
  const sections: HeadingSection[] = [];
  let current: { heading: string; lines: string[]; startLine: number } | null = null;

  function flush(endLine: number): void {
    if (current === null) return;
    const body = current.lines.join("\n").trim();
    if (body.length > 0 || current.heading.length > 0) {
      sections.push({ heading: current.heading, body, lineStart: current.startLine, lineEnd: endLine });
    }
    current = null;
  }

  lines.forEach((line, idx) => {
    const lineNo = bodyStartLine + idx;
    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      flush(lineNo - 1);
      current = { heading: headingMatch[2] ?? "", lines: [], startLine: lineNo };
      return;
    }
    if (current === null) {
      current = { heading: "", lines: [], startLine: lineNo };
    }
    current.lines.push(line);
  });
  flush(bodyStartLine + lines.length - 1);
  return sections.filter((s) => s.body.length > 0);
}

/** frontmatter 블록(`---`…`---`)을 건너뛰고 그 뒤 본문의 시작 라인 번호(1-based)를 구한다. */
function bodyAfterFrontmatter(content: string): { body: string; startLine: number } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: content, startLine: 1 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return { body: lines.slice(i + 1).join("\n"), startLine: i + 2 };
    }
  }
  return { body: content, startLine: 1 }; // 닫는 --- 없음 — 전체를 본문으로 취급(방어적).
}

/** `plugin.json`의 최상위 `"description"` 문자열 값과, 그 키가 처음 등장하는 라인 번호를 구한다. */
function extractPluginJsonDescription(content: string): { value: string; line: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("description" in parsed)) return null;
  const value = (parsed as { description?: unknown }).description;
  if (typeof value !== "string" || value.length === 0) return null;
  const lines = content.split(/\r?\n/);
  const lineIndex = lines.findIndex((l) => l.includes('"description"'));
  return { value, line: lineIndex === -1 ? 1 : lineIndex + 1 };
}

export interface RuleExtractResult {
  annotation: Annotation;
  docPage: DocPage;
}

/**
 * `asset` + 원본 섹션들(`source-resolve.ts`가 구한 것)로부터 규칙 기반 `Annotation`/`DocPage`를
 * 만든다. `sections`가 비어 있으면(원문을 하나도 못 찾음) `asset.description`만으로 최소한의
 * 문서를 채운다 — 그마저 없으면 이 함수는 호출하지 않는다(호출자가 "빈 자산"을 걸러야 한다).
 */
export function ruleExtract(asset: Asset, sections: readonly PromptEnvelopeSection[], now: Date = new Date()): RuleExtractResult {
  const generatedAt = now.toISOString();
  const sourceTrust = determineSourceTrust(asset);

  // frontmatter가 있는 첫 섹션(SKILL.md 또는 plugin.json)에서 spawn_metadata성 필드를 뽑는다 —
  // description은 role/purpose의 1차 후보다.
  let roleText: string | undefined;
  let roleCitation: string | undefined;
  const bodySections: string[] = [];
  const citations: Citation[] = [];
  let whenToUseText: string | undefined;
  let whenToUseCitation: string | undefined;

  function pushCitation(sourceRef: string, lineStart: number, lineEnd: number): void {
    citations.push({ source_ref: sourceRef, line_start: lineStart, line_end: lineEnd });
  }

  for (const section of sections) {
    if (section.label === "SKILL.md") {
      const meta = extractSpawnMetadata(section.content, section.label);
      if (meta.description !== undefined) {
        roleText = meta.description.value;
        roleCitation = citationTag(
          meta.description.extractedFrom.sourceRef,
          meta.description.extractedFrom.lineStart,
          meta.description.extractedFrom.lineEnd,
        );
        pushCitation(
          meta.description.extractedFrom.sourceRef,
          meta.description.extractedFrom.lineStart,
          meta.description.extractedFrom.lineEnd,
        );
      }
      const { body, startLine } = bodyAfterFrontmatter(section.content);
      for (const heading of extractHeadingSections(body, startLine)) {
        const tag = citationTag(section.label, heading.lineStart, heading.lineEnd);
        pushCitation(section.label, heading.lineStart, heading.lineEnd);
        const headingLine = heading.heading.length > 0 ? `### ${heading.heading}\n\n` : "";
        bodySections.push(`${headingLine}${heading.body} ${tag}`);
        if (whenToUseText === undefined && WHEN_TO_USE_HEADING_PATTERN.test(heading.heading)) {
          whenToUseText = heading.body;
          whenToUseCitation = tag;
        }
      }
    } else if (section.label === "plugin.json") {
      const desc = extractPluginJsonDescription(section.content);
      if (desc !== null) {
        roleText = desc.value;
        roleCitation = citationTag(section.label, desc.line, desc.line);
        pushCitation(section.label, desc.line, desc.line);
        bodySections.push(`${desc.value} ${roleCitation}`);
      }
    } else if (section.label.toLowerCase().startsWith("readme")) {
      const { body, startLine } = bodyAfterFrontmatter(section.content);
      for (const heading of extractHeadingSections(body, startLine)) {
        const tag = citationTag(section.label, heading.lineStart, heading.lineEnd);
        pushCitation(section.label, heading.lineStart, heading.lineEnd);
        const headingLine = heading.heading.length > 0 ? `### ${heading.heading}\n\n` : "";
        bodySections.push(`${headingLine}${heading.body} ${tag}`);
        if (whenToUseText === undefined && WHEN_TO_USE_HEADING_PATTERN.test(heading.heading)) {
          whenToUseText = heading.body;
          whenToUseCitation = tag;
        }
      }
    } else if (section.label === "asset.description") {
      roleText = section.content;
      roleCitation = citationTag("asset.description", 1, 1);
      pushCitation("asset.description", 1, 1);
      bodySections.push(`${section.content} ${roleCitation}`);
    }
  }

  // 원문에서 아무것도 못 뽑았으면 asset.description으로 최소 채움(그마저 없으면 호출자가
  // 이 함수를 부르지 않아야 한다 — plan.ts가 "빈 자산"으로 건너뛴다).
  if (roleText === undefined) {
    roleText = asset.description ?? asset.name;
    roleCitation = citationTag("asset.description", 1, 1);
    pushCitation("asset.description", 1, 1);
    if (bodySections.length === 0) bodySections.push(`${roleText} ${roleCitation}`);
  }

  const role = `${roleText} ${roleCitation}`;
  const purpose = role; // 규칙 기반 폴백은 role과 purpose를 같은 원문에서 뽑는다(단순화, v1 범위).
  const whenToUse =
    whenToUseText !== undefined && whenToUseCitation !== undefined
      ? `${whenToUseText} ${whenToUseCitation}`
      : `${roleText} 설명을 참고한다 ${roleCitation}`;

  const annotation: Annotation = {
    schema_version: 1,
    _scope: "machine_independent",
    asset_id: asset.id,
    role,
    purpose,
    when_to_use: whenToUse,
    gen_mode: "rule_extract",
    gen_source_trust: sourceTrust,
    generated_at: generatedAt,
  };

  const docPage: DocPage = {
    schema_version: 1,
    _scope: "machine_independent",
    asset_id: asset.id,
    catalog_relative_path: usageMdPath(asset.kind, asset.name),
    title: `${asset.name} 사용법`,
    body: bodySections.join("\n\n"),
    citations,
    gen_mode: "rule_extract",
    gen_source_trust: sourceTrust,
    generated_at: generatedAt,
  };

  return { annotation, docPage };
}
