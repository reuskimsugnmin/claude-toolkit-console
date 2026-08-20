/**
 * core/src/guard/injection-patterns.ts — iter 8 · B1-3 (§1.3 결정 6 부속 "신뢰 경계" 절).
 *
 * `gen`이 서드파티 자산 원문(SKILL.md·README·plugin.json)을 근거로 생성한 산출물(usage.md 등)을
 * `sync`가 카탈로그에 커밋하기 직전에 거치는 산출물 후검증 4규칙(순수 함수) — B1-3 통제 3.
 *
 * ⚠️ P5(인용 강제)의 재해석이 아니다. P5는 날조(fabrication) 방어이고, 이 판정기는 인젝션 방어다.
 * 인젝션 문자열은 원문에 실제로 존재하므로 인용 검사(citation-check.ts)는 통과한다 — "인용이 있으니
 * 검증됐다"는 오독이 가장 위험하다(§1.3). 아래 4규칙은 인용 여부와 무관하게 별도로 통과해야 한다.
 * `--no-llm` 규칙 기반 폴백 경로에도 동일하게 적용된다(M3 — 축자 복사가 인젝션 문자열을 오히려
 * 원형 그대로 보존한다).
 *
 * core/guard 판정기이므로 순수 함수다 — I/O 없음, "어느 홈이냐"를 모른다(C2와 같은 제약,
 * eslint.config.js의 ctk/no-home-literals가 packages/core/src/guard/**에 강제한다).
 */

export interface PatternRule {
  id: string;
  pattern: RegExp;
  note: string;
}

/** ⓐ 지시문 패턴 — "이전 지시 무시"류 · "반드시 ~해야 한다"류 · <system> 태그 · 도구 호출 유사 구문. */
export const INSTRUCTION_PATTERN_RULES: readonly PatternRule[] = [
  {
    id: "ignore_previous_instructions",
    pattern:
      /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|preceding)\s+(instructions?|prompts?|rules?)/i,
    note: "이전 지시 무시 유도 — 대표적 프롬프트 인젝션 패턴",
  },
  {
    id: "you_must_directive",
    pattern: /\byou\s+must\b/i,
    note: "명령형 지시문 — 데이터여야 할 문서가 에이전트에게 행동을 지시하는 형태",
  },
  {
    id: "system_tag",
    pattern: /<\s*system\s*>/i,
    note: "시스템 프롬프트 영역을 흉내내는 태그",
  },
  {
    id: "tool_call_like_syntax",
    pattern: /<\s*(tool_use|tool_call|function_calls?|invoke)\b/i,
    note: "도구 호출 구문을 흉내내는 문자열",
  },
];

/** ⓑ 실행 가능 명령 — curl|sh 계열 · rm -rf · sudo · base64 디코드 파이프. */
export const EXECUTABLE_COMMAND_RULES: readonly PatternRule[] = [
  {
    id: "curl_pipe_shell",
    pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    note: "다운로드 후 즉시 실행 — 원격 코드 실행 패턴",
  },
  {
    id: "rm_rf",
    pattern: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i,
    note: "재귀 강제 삭제 명령",
  },
  {
    id: "sudo",
    pattern: /\bsudo\b/i,
    note: "권한 상승 명령",
  },
  {
    id: "base64_decode_pipe",
    pattern: /base64\s+(-d|--decode)[^\n]*\|/i,
    note: "base64 디코드 후 파이프 — 난독화된 페이로드 실행 패턴",
  },
];

export interface PatternMatch {
  id: string;
  note: string;
  snippet: string;
}

/** 규칙 목록을 텍스트에 대해 스캔하고 최초 매칭 1건씩 반환한다(규칙별 존재 여부 판정이므로 충분). */
export function findPatternMatches(text: string, rules: readonly PatternRule[]): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (match) {
      matches.push({ id: rule.id, note: rule.note, snippet: match[0] });
    }
  }
  return matches;
}

/** ⓒ URL 화이트리스트 — 밖 도메인은 링크로 렌더하지 않고 평문 표기해야 한다. */
export const DEFAULT_ALLOWED_URL_DOMAINS: readonly string[] = [
  "docs.claude.com",
  "claude.com",
  "anthropic.com",
  "github.com",
];

const URL_PATTERN = /https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?(?:[/?#][^\s)"'<>]*)?/g;

function isDomainAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  return allowedDomains.some((domain) => {
    const normalizedDomain = domain.toLowerCase();
    return normalized === normalizedDomain || normalized.endsWith(`.${normalizedDomain}`);
  });
}

/** 화이트리스트 밖 도메인을 가리키는 URL 원문 목록(중복 제거)을 반환한다. */
export function findOutOfWhitelistUrls(
  text: string,
  allowedDomains: readonly string[] = DEFAULT_ALLOWED_URL_DOMAINS,
): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    const host = match[1];
    if (host !== undefined && !isDomainAllowed(host, allowedDomains)) {
      found.add(url);
    }
  }
  return [...found];
}

/** ⓓ 자산당 문서 길이 상한 — 증폭(amplification) 방지. */
export const DEFAULT_MAX_DOCUMENT_LENGTH = 20_000;

export interface LengthViolation {
  length: number;
  max: number;
}

export function checkDocumentLength(
  text: string,
  maxLength: number = DEFAULT_MAX_DOCUMENT_LENGTH,
): LengthViolation | null {
  return text.length > maxLength ? { length: text.length, max: maxLength } : null;
}

export interface InjectionPatternsVerdictOptions {
  allowedUrlDomains?: readonly string[];
  maxLength?: number;
  instructionRules?: readonly PatternRule[];
  executableCommandRules?: readonly PatternRule[];
}

export interface InjectionPatternsVerdict {
  status: "clean" | "violation";
  instructionMatches: PatternMatch[];
  executableCommandMatches: PatternMatch[];
  outOfWhitelistUrls: string[];
  lengthViolation: LengthViolation | null;
}

/**
 * 산출물 후검증 4규칙 전체 판정. `(text, options?) → verdict` 순수 함수.
 * 넷 중 하나라도 위반이면 전체 `status`는 "violation"이며, 호출자(sync 쓰기 직전)는
 * `injection_pattern_detected`로 해당 자산 문서 커밋을 거부한다(§1.3 통제 3).
 */
export function verdictInjectionPatterns(
  text: string,
  options: InjectionPatternsVerdictOptions = {},
): InjectionPatternsVerdict {
  const instructionMatches = findPatternMatches(text, options.instructionRules ?? INSTRUCTION_PATTERN_RULES);
  const executableCommandMatches = findPatternMatches(
    text,
    options.executableCommandRules ?? EXECUTABLE_COMMAND_RULES,
  );
  const outOfWhitelistUrls = findOutOfWhitelistUrls(text, options.allowedUrlDomains ?? DEFAULT_ALLOWED_URL_DOMAINS);
  const lengthViolation = checkDocumentLength(text, options.maxLength ?? DEFAULT_MAX_DOCUMENT_LENGTH);

  const status: InjectionPatternsVerdict["status"] =
    instructionMatches.length > 0 ||
    executableCommandMatches.length > 0 ||
    outOfWhitelistUrls.length > 0 ||
    lengthViolation !== null
      ? "violation"
      : "clean";

  return { status, instructionMatches, executableCommandMatches, outOfWhitelistUrls, lengthViolation };
}
