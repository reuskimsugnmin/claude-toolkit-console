import { describe, expect, it } from "vitest";
import { GenCostSchema } from "@ctk/core";
import { createActionHandlers, EstimateTokenStore } from "../src/commands/web-actions.js";

/**
 * cli/test/gen-estimate-payload.test.ts — **서버가 승인 화면에 무엇을 실어 보내는가.**
 *
 * ⚠️ 심사 M-4(2026-08-25): 이 조립부를 **어떤 테스트도 지나가지 않았다.**
 * `web/test/ui-gen-estimate-rows.test.ts`는 픽스처 안에서 파생 함수를 직접 불러 페이로드를
 * 만들므로 "브라우저가 곱하지 않는다"만 재고, `web/test/actions-route.test.ts`는 `genEstimate`를
 * 통째로 모킹한다. 그래서 서버가 **잘못된 개수**를 곱해도 전 스위트가 통과했다 — 승인 화면에
 * 실제로 뜨는 숫자가 그 값인데도.
 *
 * **두 축이 갈리는 입력으로 잰다** — `maxAssets`(사용자가 요청한 상한)와 `call_count`(dry-run이
 * 실제로 센 대상 수)를 **다르게** 둔다. 같으면 어느 것을 곱했는지 구분되지 않는다.
 */

const MAX_ASSETS = 40;
const CALL_COUNT = 7; // dry-run이 실제로 센 대상 — 요청 상한과 일부러 다르게 둔다.

/** 합성 표본 — 평균 $0.200 > 중앙값 $0.160. 대칭 표본이면 결함을 주입해도 통과한다. */
const OBSERVED = GenCostSchema.parse({
  calls_reported: 20,
  calls_unreported: 0,
  reported_total_usd: 4.0,
  median_usd: 0.16,
  max_usd: 0.65,
});

const MEAN_USD = 4.0 / 20;

function handlers(observed = OBSERVED) {
  return createActionHandlers({
    estimates: new EstimateTokenStore(),
    // 실제 카탈로그·실행 기록을 읽지 않는다 — 그러면 단언이 이 머신에 대한 진술이 된다.
    dryRunFn: () => ({
      assetCount: CALL_COUNT,
      approxBytes: 1000,
      skipped: [],
      unresolved: [],
    }),
    observedCostFn: () => observed,
  });
}

describe("genEstimate — 서버가 실어 보내는 실측 단가와 총액 투사", () => {
  it("총액을 call_count에 곱한다 — maxAssets가 아니다 (두 축이 갈리는 입력)", async () => {
    const result = (await handlers().genEstimate({ maxAssets: MAX_ASSETS, maxTotalUsd: 2 })) as {
      data: { call_count: number; observed_unit_cost: { projected_total_usd: number; mean_usd: number } };
    };
    expect(result.data.call_count).toBe(CALL_COUNT);
    expect(result.data.observed_unit_cost.projected_total_usd).toBeCloseTo(MEAN_USD * CALL_COUNT, 10);
    // maxAssets를 곱했다면 이 값이 나온다 — 승인 화면이 5배 넘게 부풀어 보인다.
    expect(result.data.observed_unit_cost.projected_total_usd).not.toBeCloseTo(MEAN_USD * MAX_ASSETS, 4);
  });

  it("단가는 평균이다 — 중앙값으로 곱하면 총액을 낮게 말한다", async () => {
    const result = (await handlers().genEstimate({ maxAssets: MAX_ASSETS, maxTotalUsd: 2 })) as {
      data: { observed_unit_cost: { mean_usd: number; median_usd: number; projected_total_usd: number } };
    };
    const unit = result.data.observed_unit_cost;
    expect(unit.mean_usd).toBeCloseTo(MEAN_USD, 10);
    expect(unit.mean_usd).toBeGreaterThan(unit.median_usd); // 실측 분포는 오른쪽으로 길다
    expect(unit.projected_total_usd).not.toBeCloseTo(unit.median_usd * CALL_COUNT, 4);
  });

  it("실측 기록이 없으면 null이다 — 대체값을 지어내지 않는다", async () => {
    const result = (await handlers(null as never).genEstimate({ maxAssets: MAX_ASSETS, maxTotalUsd: 2 })) as {
      data: { observed_unit_cost: unknown };
    };
    expect(result.data.observed_unit_cost).toBeNull();
  });

  /**
   * **표시만 바뀌어야 하고 상한 강제는 그대로여야 한다**(심사에서 확인 요청된 항목).
   * 호출당 상한은 승인 총액을 `call_count`로 나눈 값이지 투사값과 무관하다.
   */
  it("호출당 상한은 투사값이 아니라 승인 총액에서 나온다", async () => {
    const result = (await handlers().genEstimate({ maxAssets: MAX_ASSETS, maxTotalUsd: 2 })) as {
      data: { per_call_budget_usd: number; max_total_usd: number; call_count: number };
    };
    expect(result.data.per_call_budget_usd).toBeCloseTo(2 / CALL_COUNT, 10);
    expect(result.data.max_total_usd).toBe(2);
  });
});
