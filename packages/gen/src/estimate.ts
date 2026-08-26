import { checkSealedLiveAuthStatus, countTokensMeasured, createNullTokenCacheStore, type HomeContext, type TokenCacheStore } from "@ctk/probe";
import { deriveObservedUnitCost, type GenCost, type ObservedUnitCost } from "@ctk/core";
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
  /** $/1M input 토큰 근사치. **입력분만** 곱하므로 이것만으로는 총비용이 되지 않는다. */
  approxUsdPerMillionInputTokens?: number;
  /**
   * `--max-budget-usd` — **호출당** 상한. 하네스가 이 값을 넘는 호출을 사전 견적으로 거부하므로
   * `callCount × maxBudgetUsd`가 **이 실행의 정확한 상한**이다(추정이 아니다).
   *
   * **필수 필드다.** 선택으로 두면 상한 없는 견적이 조용히 통과하고, 승인 화면은 다시 하한
   * 하나만 보여주게 된다 — 이 수정이 없애려는 상태 그대로다(안전 원칙 5).
   */
  maxBudgetUsd: number;
  /** 이 머신의 지난 `gen` 실행에서 관측된 실비용. 없으면 생략 — **지어내지 않는다.** */
  observedCost?: GenCost | null;
}

export interface EstimateResult {
  assetCount: number;
  callCount: number;
  /** 크레덴셜이 있어 실측 가능했으면 토큰 수, 없으면 null(그 경우 approxBytes를 대신 본다). */
  estimatedInputTokens: number | null;
  approxBytes: number;
  /**
   * **입력 토큰만 계산한 하한.** 총비용이 아니다 — 출력·캐시 생성이 빠져 있고, 실측(2026-08-24)
   * 에서 실제 비용은 이 값의 약 20배였다. 이름이 `approxCostUsd`였을 때 이 값은 "예상 비용"으로
   * 읽혔고 그 숫자 위에서 승인이 이뤄졌다 — **이름이 곧 오해의 원인이었다.**
   */
  costFloorUsd: number | null;
  /**
   * **정확한 상한** = `callCount × maxBudgetUsd`. 추정이 아니다 — 하네스가 호출당 상한을
   * 넘는 요청을 사전 견적으로 거부하므로 이 값을 넘길 수 없다.
   */
  costCeilingUsd: number;
  /**
   * 이 머신의 지난 실행에서 관측된 자산당 실비용. **없으면 null이고 대체값을 만들지 않는다.**
   * 실측 단가는 그 머신에 깔린 툴의 원문 크기에 달린 **머신 종속** 사실이라 카탈로그의
   * 머신별 영역에 쌓이고, 제품 코드에 상수로 박히지 않는다.
   */
  observed: ObservedUnitCost | null;
  /**
   * `targets`를 부모별로 나눈 호출 수 — **모든 대상을 빠짐없이 분할한다.** 번들 자식은 실제
   * 부모 id로, `parent_asset_id`가 없는 최상위 자산은 전부 `UNGROUPED_PARENT_ID`("")로 묶인다.
   *
   * 이렇게 완전히 분할해 두는 이유: 표시 계층(`cli/gen.ts`)이 총액을 **행마다**
   * `projectGenTotalUsd(observed, row.callCount)`를 불러 더하게 하기 위해서다 — 그러면
   * "행의 합 = 총액"이 별도 검산이 아니라 구조적으로 보장된다(core/view/gen-cost-projection.ts
   * 주석: "표시 계층이 직접 곱하면 같은 결함이 다시 갈라진다").
   */
  byParent: Array<{ parent_id: string; callCount: number }>;
}

/**
 * `byParent`에서 `parent_asset_id`가 없는(최상위) 대상을 묶는 자리 표시자. 실제 자산 id는
 * 스키마상 빈 문자열일 수 없으므로(`AssetSchema.id: z.string().min(1)`) 충돌하지 않는다.
 */
export const UNGROUPED_PARENT_ID = "";

const DEFAULT_APPROX_USD_PER_MILLION_INPUT_TOKENS = 3; // Claude Sonnet급 input 요율 근사치(공개 가격 참고치, 정확한 청구 근거 아님).

function totalSectionBytes(target: GenPlanTarget): number {
  return target.sections.reduce((sum, s) => sum + Buffer.byteLength(s.content, "utf8"), 0);
}

/** `targets`를 부모별로 나눈다 — 모든 대상이 정확히 한 행에 들어간다(빠짐없이 분할). */
function groupByParent(targets: readonly GenPlanTarget[]): Array<{ parent_id: string; callCount: number }> {
  const counts = new Map<string, number>();
  for (const t of targets) {
    const key = t.asset.parent_asset_id ?? UNGROUPED_PARENT_ID;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([parent_id, callCount]) => ({ parent_id, callCount }));
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
    maxBudgetUsd,
    observedCost = null,
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

  const costFloorUsd =
    estimatedInputTokens !== null ? (estimatedInputTokens / 1_000_000) * approxUsdPerMillionInputTokens : null;

  return {
    assetCount: targets.length,
    callCount: targets.length, // 자산 1개당 claude -p 1회(직렬) — §1.3 결정 6 H3.
    estimatedInputTokens,
    approxBytes,
    costFloorUsd,
    costCeilingUsd: targets.length * maxBudgetUsd,
    observed: toObserved(observedCost),
    byParent: groupByParent(targets),
  };
}

/**
 * 지난 실행의 실측을 표시용으로 옮긴다. **보고 0건이면 null** — 중앙값을 0으로 채우면
 * "실측했더니 공짜였다"로 읽힌다(안전 원칙 7).
 *
 * `partial`은 미보고 호출이 섞였다는 뜻이다. 그 경우 중앙값·최대값은 **보고된 부분만**의
 * 값이므로 화면이 그 사실을 함께 말해야 한다.
 */
function toObserved(cost: GenCost | null): EstimateResult["observed"] {
  // 파생은 core가 한다 — 표시 계층 둘이 각자 곱하다가 둘 다 중앙값을 쓰는 결함이 났다.
  return deriveObservedUnitCost(cost);
}
