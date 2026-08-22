/**
 * gen/src/citation-check.ts — P5(인용 강제) 구조 규칙 검사 (AC-3.6).
 *
 * `usage.md`(body)와 `annotation.md`(role·purpose·when_to_use) 양쪽의 **모든 문단과 모든
 * 불릿**에 최소 1개의 인용 태그(`[[cite:<source_ref>#L<line_start>-L<line_end>]]`)가 붙어
 * 있는지 검사한다. **구조 규칙만** 본다(어떤 문장이 "판정형"인지 의미 분류를 하지 않는다 — P5
 * 원문: 분류기 자체가 부정문을 오독하는 대상이기 때문이다).
 *
 * 인용 태그는 gen이 생성물(LLM 산출 `usage_body`/`when_to_use` 등 프로즈 필드) 안에 직접
 * 심는 인라인 마커다 — `citations` 배열(구조화 필드)은 프로그램적 조회용 재진술일 뿐, 이
 * 검사기가 실제로 훑는 것은 프로즈 텍스트 안의 인라인 태그다.
 */

export const CITATION_TAG_PATTERN = /\[\[cite:([^\]#]+)#L(\d+)-L(\d+)\]\]/;

export function citationTag(sourceRef: string, lineStart: number, lineEnd: number): string {
  return `[[cite:${sourceRef}#L${lineStart}-L${lineEnd}]]`;
}

export interface CitationCheckViolation {
  /** 위반이 발견된 블록(문단/불릿)의 원문 앞 60자 — 어디가 문제인지 사람이 알아볼 수 있게. */
  snippet: string;
}

export interface CitationCheckResult {
  status: "clean" | "violation";
  violations: CitationCheckViolation[];
}

/** 텍스트를 문단/불릿 블록으로 나눈다 — 빈 줄로 문단을 가르고, `-`/`*`로 시작하는 줄은 각각
 * 독립된 불릿 블록으로 취급한다. 제목(`#`)·코드블록(```로 감싼 구간)은 검사 대상에서 뺀다. */
function splitBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  function flush(): void {
    const joined = current.join("\n").trim();
    if (joined.length > 0) blocks.push(joined);
    current = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue; // 코드블록 구획 마커·본문은 인용 검사 대상이 아니다.
    }
    if (inCodeBlock) continue;
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (trimmed.startsWith("#")) {
      flush();
      continue; // 제목은 인용 대상이 아니다.
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flush(); // 불릿은 한 줄이 한 블록이다(여러 줄 이어지는 불릿은 v1 범위 밖 — 단순화).
      blocks.push(trimmed);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/** 하나의 프로즈 필드(문자열)에 대해 문단/불릿 단위 인용 검사를 한다. */
export function checkCitations(text: string): CitationCheckResult {
  const blocks = splitBlocks(text);
  const violations: CitationCheckViolation[] = [];
  for (const block of blocks) {
    if (!CITATION_TAG_PATTERN.test(block)) {
      violations.push({ snippet: block.slice(0, 60) });
    }
  }
  return { status: violations.length > 0 ? "violation" : "clean", violations };
}

/** usage.md/annotation.md에 실릴 여러 프로즈 필드를 한 번에 검사한다 — 하나라도 위반이면
 * 전체가 위반이다(해당 자산 문서 커밋 거부, §7.2 `citation_missing`류 취급은 호출자 몫). */
export function checkAllCitations(fields: Readonly<Record<string, string>>): CitationCheckResult {
  const violations: CitationCheckViolation[] = [];
  for (const [field, text] of Object.entries(fields)) {
    const result = checkCitations(text);
    if (result.status === "violation") {
      violations.push(...result.violations.map((v) => ({ snippet: `[${field}] ${v.snippet}` })));
    }
  }
  return { status: violations.length > 0 ? "violation" : "clean", violations };
}
