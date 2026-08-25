import type { GenCost } from "../schema/run-log.js";

/**
 * core/src/view/gen-cost-projection.ts — 실측 단가에서 **이번 배치의 예상 총액**을 뽑는
 * 유일한 자리.
 *
 * ⚠️ **개별 값이 전부 정확해도 집계는 거짓 결론을 낸다**(안전 원칙 8). `GenCost`의
 * `median_usd`·`max_usd`는 각각 정확한데, 화면 둘(CLI `describeCostEstimate` · 웹
 * `ui-page.ts`)이 **`중앙값 × 건수`로 총액을 투사**하고 있었다. gen 호출당 비용 분포는
 * 오른쪽으로 길어서(실측: 중앙값 $0.17 · 최대 $0.70) 그 곱은 총액을 계속 낮게 말한다.
 *
 * 실측 3배치 대조 (2026-08-25):
 *
 * | 배치 | 중앙값×건수 | 실제 총액 | 오차 |
 * |---|---|---|---|
 * | 30건 | $5.80 | $6.58 | −11.7% |
 * | 30건 | $5.20 | $6.25 | −16.8% |
 * | 33건 | $5.61 | $7.10 | −21.0% |
 *
 * **합계는 건수 × 평균이다.** 그리고 평균은 이미 저장돼 있다 —
 * `reported_total_usd / calls_reported`. 스키마를 늘릴 필요가 없었고, 필요한 것은
 * 곱하는 값을 바꾸는 일뿐이었다.
 *
 * 중앙값을 버리지는 않는다. 둘은 서로 다른 질문에 답한다 — 중앙값은 "자산 하나가 보통
 * 얼마인가"(호출당 상한을 정할 때 쓴다), 평균은 "이 배치가 전부 얼마인가"다. 한 값으로
 * 뭉치지 않는다(안전 원칙 7).
 *
 * **이 모듈이 유일한 투사 지점이다.** 표시 계층이 직접 곱하면 같은 결함이 다시 갈라진다 —
 * 이번에도 두 자리가 똑같이 틀려 있었다(안전 원칙 5).
 */

export interface ObservedUnitCost {
  /** 배치 총액 투사에 쓰는 값. `reported_total_usd / calls_reported`. */
  meanUsd: number;
  /** 자산 하나의 통상 비용. **호출당 상한**을 정할 때 보는 값이다. */
  medianUsd: number;
  /** 관측된 최악의 호출 — 호출당 상한이 이보다 낮으면 사전 거부가 난다. */
  maxUsd: number;
  /** 이 단가가 몇 건의 보고에서 나왔는가. */
  sampleSize: number;
  /** 비용을 보고하지 않은 호출이 섞여 있었는가 — 그러면 이 단가는 표본의 일부에 대한 것이다. */
  partial: boolean;
}

/**
 * 실행 기록에서 단가를 뽑는다. **기록이 없거나 판정할 수 없으면 `null`이고 대체값을
 * 지어내지 않는다**(안전 원칙 7) — 없는 단가를 0이나 임의 상수로 채우면 화면은 근거 없는
 * 숫자 위에서 승인을 받는다.
 */
export function deriveObservedUnitCost(cost: GenCost | null | undefined): ObservedUnitCost | null {
  if (cost === null || cost === undefined) return null;
  if (cost.calls_reported <= 0) return null;
  if (cost.median_usd === null || cost.max_usd === null) return null;
  return {
    meanUsd: cost.reported_total_usd / cost.calls_reported,
    medianUsd: cost.median_usd,
    maxUsd: cost.max_usd,
    sampleSize: cost.calls_reported,
    partial: cost.calls_unreported > 0,
  };
}

/**
 * 이번 배치의 예상 총액. **평균 × 건수**다 — 중앙값이 아니다(위 표 참조).
 *
 * 이것은 상한이 아니라 **예상치**다. 상한은 `callCount × maxBudgetUsd`로 따로 계산되며
 * 하네스가 실제로 강제한다. 둘을 같은 줄에 적지 않는다.
 */
export function projectGenTotalUsd(observed: ObservedUnitCost, callCount: number): number {
  return observed.meanUsd * callCount;
}
