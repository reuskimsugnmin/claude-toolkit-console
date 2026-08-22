import { checkSealedLiveAuthStatus, countTokensMeasured, createNullTokenCacheStore, type HomeContext, type TokenCacheStore } from "@ctk/probe";
import type { GenPlanTarget } from "./plan.js";

/**
 * gen/src/estimate.ts — 실행 전 비용 고지 + 승인 대기(전역 CLAUDE.md 토큰 규칙, P4).
 *
 * **인증 선검사(iter 7 개정 — `sealed-live` 기준).** `gen`의 기본 경로는 `sealed-live`이며
 * 실제 `CLAUDE_CONFIG_DIR`를 유지한 채 구독(OAuth) 로그인으로 동작한다. 여기서 확인하는 것은
 * "API 키 유무"가 아니라 **`sealed-live` 기준 인증 가용성**이다 — `claude auth status --json`
 * (0원, docs/harness-facts.md)으로 API 호출·모델 세션 spawn **이전에** 확인하고, 어떤 인증
 * 수단도 없을 때만 `credential_missing`으로 즉시 중단한다.
 *
 * 예상 토큰 산출에 쓰는 `count_tokens`는 별개로 `ANTHROPIC_API_KEY`류 크레덴셜을 요구한다(SDK
 * 크레덴셜 체인, probe/occupancy/count-tokens.ts) — 그것이 없으면 예상치를 **`approxBytes`
 * (바이트, 토큰 아님)로만** 표시한다. 비용 고지 자체는 건너뛰지 않는다(ADR-005) — 토큰 수를
 * 모를 뿐 "대상 자산 수 + 호출 건수"는 항상 보여준다.
 */

export class CredentialMissingError extends Error {
  readonly failureClass = "credential_missing" as const;
  constructor() {
    super(
      "sealed-live 기준 인증 가용성이 없다(claude auth status --json: loggedIn=false) — " +
        "API 호출/서브프로세스 spawn 이전에 중단한다. `ctk gen --no-llm`로 규칙 기반 폴백을 쓸 수 있다",
    );
    this.name = "CredentialMissingError";
  }
}

export interface EstimateOptions {
  home: HomeContext;
  targets: readonly GenPlanTarget[];
  tokenizerModel: string;
  cache?: TokenCacheStore;
  cwd: string;
  timeoutSec: number;
  /** 테스트 주입용. */
  checkAuthFn?: typeof checkSealedLiveAuthStatus;
  countTokensFn?: typeof countTokensMeasured;
  /** $/1M input 토큰 근사치 — 실제 과금은 각 `claude -p` 호출의 `--max-budget-usd`가 최종
   * 상한이다. 이 값은 사전 고지용 근사치일 뿐 정확한 청구 근거가 아니다. */
  approxUsdPerMillionInputTokens?: number;
}

export interface EstimateResult {
  assetCount: number;
  callCount: number;
  /** 크레덴셜이 있어 실측 가능했으면 토큰 수, 없으면 null(그 경우 approxBytes를 대신 본다). */
  estimatedInputTokens: number | null;
  approxBytes: number;
  /** 근사치 — 정확한 상한은 각 spawn의 --max-budget-usd다. */
  approxCostUsd: number | null;
}

const DEFAULT_APPROX_USD_PER_MILLION_INPUT_TOKENS = 3; // Claude Sonnet급 input 요율 근사치(공개 가격 참고치, 정확한 청구 근거 아님).

function totalSectionBytes(target: GenPlanTarget): number {
  return target.sections.reduce((sum, s) => sum + Buffer.byteLength(s.content, "utf8"), 0);
}

/**
 * 인증 선검사 → (가능하면) 토큰 실측 → 비용 근사치 계산. 인증이 아예 없으면
 * `CredentialMissingError`를 던진다(비용 0의 조기 실패, API 호출 이전).
 */
export async function estimateGenCost(options: EstimateOptions): Promise<EstimateResult> {
  const {
    home,
    targets,
    tokenizerModel,
    cache = createNullTokenCacheStore(),
    cwd,
    timeoutSec,
    checkAuthFn = checkSealedLiveAuthStatus,
    countTokensFn = countTokensMeasured,
    approxUsdPerMillionInputTokens = DEFAULT_APPROX_USD_PER_MILLION_INPUT_TOKENS,
  } = options;

  const auth = await checkAuthFn({ home, cwd, timeoutSec });
  if (!auth.loggedIn) {
    throw new CredentialMissingError();
  }

  const approxBytes = targets.reduce((sum, t) => sum + totalSectionBytes(t), 0);

  let estimatedInputTokens: number | null = 0;
  for (const target of targets) {
    const text = target.sections.map((s) => s.content).join("\n");
    const measured = await countTokensFn({ text, tokenizerModel, cache });
    if (measured.state !== "measured" || measured.value_tokens === null) {
      estimatedInputTokens = null;
      break;
    }
    estimatedInputTokens += measured.value_tokens;
  }

  const approxCostUsd =
    estimatedInputTokens !== null ? (estimatedInputTokens / 1_000_000) * approxUsdPerMillionInputTokens : null;

  return {
    assetCount: targets.length,
    callCount: targets.length, // 자산 1개당 claude -p 1회(직렬) — §1.3 결정 6 H3.
    estimatedInputTokens,
    approxBytes,
    approxCostUsd,
  };
}
