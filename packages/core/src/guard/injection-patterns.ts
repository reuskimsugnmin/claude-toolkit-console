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

/**
 * URL 추출 패턴. **다섯 구멍을 닫은 형태다(2026-08-24 실측 · 보안 심사 H1·H2)** — 셋 다 파괴 실험으로 발견했고,
 * 그중 첫 번째는 거부를 제거로 바꾸면서 **회귀가 됐던** 것이다:
 *
 * - **userinfo**(`https://user:pw@host/p`) — 옛 패턴은 `user`를 호스트로 잡아 `https://user`
 *   까지만 매칭했다. 거부만 하던 시절에는 `user`가 허용목록 밖이라 (엉뚱한 이유로) 거부됐지만,
 *   제거로 바꾸자 `https://user`만 지워지고 **`:pw@host/p`가 문서에 남은 채 검증을 통과**했다 —
 *   비밀번호와 진짜 호스트를 달고서. 지금은 userinfo를 건너뛰고 **진짜 호스트**를 캡처한다.
 * - **대문자 스킴**(`HTTPS://…`) — `i` 플래그가 없어 통째로 놓쳤다. 검출도 제거도 안 됐다.
 * - **IPv6**(`https://[2001:db8::1]/p`) — 대괄호가 호스트 문자 클래스에 없어 놓쳤다.
 * - **userinfo에 `@`가 둘 이상**(`https://user@pass@host/p`) — 첫 하드닝은 `@`를 **한 번만**
 *   건너 진짜 호스트가 그룹 밖으로 밀렸다. `removedHosts`에 호스트 대신 **userinfo 조각**이
 *   들어가 자격증명이 콘솔·요약으로 샜고(`x-access-token@ghp_…@github.com` 형태는 git 클론
 *   안내에서 흔하다), 텍스트에는 진짜 호스트가 남았다. **"닫았다"고 적은 주석 바로 아래에
 *   `@` 하나 더 깊은 같은 결함이 있었다**(심사 H2). 지금은 `[^\s/?#]*`가 탐욕적으로 마지막
 *   `@`까지 먹는다.
 * - **경로 문자 클래스가 셸 메타문자를 삼킴** — `|`가 경로에 포함돼
 *   `curl https://h/x.sh|sh`가 파이프와 `sh`까지 URL 한 덩어리로 매칭됐다. 제거하면 파이프가
 *   사라져 `curl_pipe_shell` 규칙이 **매칭되지 않는다** — 인젝션 시도가 통과했다(심사 H1).
 *   지금은 `|` `` ` `` `;` `&` `$` `[` `]`를 경로에서 뺀다. 잘린 잔여(`&b=2` 등)는 호스트가
 *   없어 무해하고, 인용 마커(`[[cite:…]]`)와 코드 스팬 백틱도 더는 삼켜지지 않는다(심사 L1·L2).
 *
 * ⚠️ **여전히 잡지 않는 것**: 프로토콜 상대 URL(`//host/p`) · `javascript:`·`data:`·`hxxp:` ·
 * 퍼센트 인코딩된 스킴 · IDN 호스트 · 스킴 없는 호스트(`evil.example/x`).
 *
 * **"이 변경으로 나빠지지 않았다"는 형태별로만 참이고 문서 단위로는 거짓이다**(심사 M2가
 * 정정했다). 거부하던 시절에는 매칭되는 URL이 하나라도 있으면 **문서 전체가 거부**돼 이런
 * 형태를 함께 실은 문서도 부수적으로 격리됐다. 지금은 매칭되는 쪽만 지워지고 나머지를 실은
 * 문서가 통과한다. 실행 위험은 없다 — 카탈로그 문서는 `textContent`로만 렌더된다. 남는 위험은
 * 위협모델 그대로 "에이전트가 읽고 따라간다"이며, 넓히려면 오탐(일반 텍스트의 `//`·`:`)을
 * **먼저 실측**해야 한다. 재지 않고 규칙을 늘리면 이 변경이 없앤 유료 무한 재시도 루프가
 * 새 부류에서 재발한다.
 */
const URL_PATTERN = /https?:\/\/(?:[^\s/?#]*@)?(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::\d+)?(?:[/?#][^\s)"'<>|`;&$\[\]]*)?/gi;

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

/**
 * 제거된 URL 자리에 남기는 표식. **빈 문자열로 지우지 않는다** — 무언가 있었다는 사실이 남아야 한다.
 *
 * 꺾쇠를 쓰지 않는다(심사 L1) — `<링`은 HTML 태그로 파싱되지 않지만(`<` 뒤가 ASCII 알파가
 * 아니다) 마크다운 링크 목적지 자리(`[t](…)`)에서 각괄호 목적지로 읽혀 엉뚱하게 렌더된다.
 */
export const REMOVED_URL_MARKER = "[링크 생략]";

export interface UrlScrubResult {
  text: string;
  /** 제거한 URL 수(중복 포함). 0이면 원문 그대로다. */
  removed: number;
  /**
   * 제거한 URL의 **호스트**만 중복 없이. 전체 URL은 담지 않는다 — 경로에 토큰이 섞일 수 있다.
   *
   * 보고용으로 **후행 점을 떼고 소문자화**한다. 문장 끝 마침표가 호스트에 빨려 들어가
   * `x.example`과 `x.example.`이 서로 다른 호스트로 두 번 실리는 것이 실측됐다(2026-08-24).
   * ⚠️ **정규화는 표시에만 적용하고 허용목록 판정에는 쓰지 않는다** — 판정 쪽을 건드리면
   * 방금 보안 심사를 통과한 fail-closed 동작이 바뀐다. 남은 코퍼스에 후행 점 호스트가 0건이라
   * 판정을 느슨하게 할 이유도 없다(재보고 판단했다).
   */
  removedHosts: string[];
}

/**
 * 화이트리스트 밖 URL을 표식으로 치환한다.
 *
 * **왜 거부가 아니라 제거인가**(2026-08-24 결정). 후검증은 비허용 URL이 하나라도 있으면 문서를
 * 통째로 거부했다. 근거는 타당하다 — 서드파티 README의 링크가 카탈로그에 박히면 나중에
 * 에이전트가 그걸 따라갈 수 있다. 그런데 실측 결과 **남은 대상의 44%(84건 중 37건)** 원문에
 * 비허용 URL이 있었고(총 320건), 모델이 그것을 인용하면서 매 배치가 **돈을 쓰고 같은 이유로
 * 실패**했다. 빠져나갈 길 없는 fail-closed는 가드가 아니라 벽이다(안전 원칙 6).
 *
 * 제거는 위험을 그대로 없앤다 — 따라갈 대상이 카탈로그에 남지 않는다. 그리고 이 제품이 답하려는
 * 질문("어떤 상황에 어떤 툴")의 답은 URL에 있지 않다.
 *
 * ⚠️ **지시문·실행명령 패턴은 제거하지 않는다.** 그것은 정상 콘텐츠가 아니라 실제 인젝션
 * 시도이고, 지워서 통과시키면 그 시도가 있었다는 사실까지 사라진다. URL만 다르게 다루는 이유는
 * README의 링크가 **정상 콘텐츠**이기 때문이다.
 *
 * ⚠️ **조용히 지우지 않는다.** 몇 건을 어느 호스트에서 지웠는지 호출자에게 돌려주고, 호출자는
 * 그것을 기록한다(이 저장소가 반복해서 경계한 "조용히 지움").
 */
export function scrubOutOfWhitelistUrls(
  text: string,
  allowedDomains: readonly string[] = DEFAULT_ALLOWED_URL_DOMAINS,
): UrlScrubResult {
  const removedHosts = new Set<string>();
  let removed = 0;
  const scrubbed = text.replace(URL_PATTERN, (url, host: unknown) => {
    if (typeof host !== "string" || isDomainAllowed(host, allowedDomains)) return url;
    removed += 1;
    // 판정은 원래 호스트로 이미 끝났다(`isDomainAllowed`). 여기서는 **표시용**으로만 다듬는다.
    removedHosts.add(host.toLowerCase().replace(/\.+$/, ""));
    return REMOVED_URL_MARKER;
  });
  return { text: scrubbed, removed, removedHosts: [...removedHosts] };
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
