import { verdictInjectionPatterns, type InjectionPatternsVerdict } from "@ctk/core";

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
    const verdict = verdictInjectionPatterns(text);
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

/** 위반이면 던진다(§7.2 — sync 쓰기 이전에 거부). `sync` 호출 직전 유일한 관문. */
export function assertOutputFieldsClean(assetId: string, fields: OutputVerifyFields): InjectionFindingsSummary {
  const result = verifyOutputFields(fields);
  if (result.status === "violation") {
    throw new InjectionPatternDetectedError(assetId, result);
  }
  return result.summary;
}
