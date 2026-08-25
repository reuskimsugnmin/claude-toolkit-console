import { describe, expect, it } from "vitest";
import { GenCostSchema } from "../src/schema/run-log.js";
import { deriveObservedUnitCost, projectGenTotalUsd } from "../src/view/gen-cost-projection.js";

/**
 * core/test/gen-cost-projection.test.ts — 총액 투사가 **중앙값이 아니라 평균**을 쓰는지 고정한다.
 *
 * ⚠️ **픽스처는 실제 파서를 통과시킨다**(`as GenCost` 금지) — 손으로 만든 객체는 스키마가
 * 요구하는 필드를 조용히 빼고도 통과해서, 테스트가 코드가 아니라 그 픽스처를 단언하게 된다.
 *
 * 표본은 **실측 분포의 모양을 담는다.** 대칭 표본이면 평균과 중앙값이 같아 결함을 주입해도
 * 테스트가 통과한다 — 갈릴 수 있는 축(오른쪽 꼬리)이 표본에 없으면 파괴 실험이 무력하다.
 */

/**
 * **합성 표본** — 값은 지어냈고 **모양만** 실측을 따른다(오른쪽 꼬리: 최대가 중앙값의 약 4배).
 * 이 저장소는 public이라 픽스처에 실제 지출을 넣지 않는다. 다만 평균과 중앙값이 **갈리는**
 * 표본이어야 한다 — 대칭 표본이면 결함을 주입해도 통과한다.
 *
 * 평균 $0.200(= 4.00 ÷ 20) · 중앙값 $0.160 · 최대 $0.650
 */
function skewedCost() {
  return GenCostSchema.parse({
    calls_reported: 20,
    calls_unreported: 0,
    reported_total_usd: 4.0,
    median_usd: 0.16,
    max_usd: 0.65,
  });
}

describe("deriveObservedUnitCost", () => {
  it("평균을 총액÷건수로 낸다 — 스키마에 이미 있는 값에서 파생된다", () => {
    const observed = deriveObservedUnitCost(skewedCost());
    expect(observed).not.toBeNull();
    expect(observed?.meanUsd).toBeCloseTo(4.0 / 20, 10);
    expect(observed?.sampleSize).toBe(20);
    expect(observed?.partial).toBe(false);
  });

  it("실측 분포는 오른쪽으로 길다 — 평균이 중앙값보다 크다(이 축이 없으면 결함이 안 드러난다)", () => {
    const observed = deriveObservedUnitCost(skewedCost());
    expect(observed!.meanUsd).toBeGreaterThan(observed!.medianUsd);
  });

  it("미보고가 섞이면 partial로 표시한다 — 단가가 표본의 일부에 대한 것이라고 말한다", () => {
    const observed = deriveObservedUnitCost(
      GenCostSchema.parse({
        calls_reported: 2,
        calls_unreported: 3,
        reported_total_usd: 0.4,
        median_usd: 0.2,
        max_usd: 0.3,
      }),
    );
    expect(observed?.partial).toBe(true);
    expect(observed?.sampleSize).toBe(2);
  });

  it("기록이 없으면 null이다 — 대체값을 지어내지 않는다", () => {
    expect(deriveObservedUnitCost(null)).toBeNull();
    expect(deriveObservedUnitCost(undefined)).toBeNull();
  });

  it("보고 0건이면 null이다 — 0으로 나눈 NaN을 단가로 내보내지 않는다", () => {
    const observed = deriveObservedUnitCost(
      GenCostSchema.parse({
        calls_reported: 0,
        calls_unreported: 5,
        reported_total_usd: 0,
        median_usd: null,
        max_usd: null,
      }),
    );
    expect(observed).toBeNull();
  });
});

describe("projectGenTotalUsd", () => {
  /**
   * **회귀 고정.** 실측 3배치에서 `중앙값 × 건수`는 실제 총액을 11.7~21.0% 낮게 말했다.
   * 여기서 재는 것은 "투사가 실제 총액을 맞히는가"다 — 같은 표본 크기로 투사하면 정확히
   * 실제 총액이 나와야 한다(평균의 정의). 중앙값을 쓰면 이 단언이 깨진다.
   */
  it("표본과 같은 건수로 투사하면 실제 총액과 일치한다 (중앙값이면 깨진다)", () => {
    const cost = skewedCost();
    const observed = deriveObservedUnitCost(cost)!;
    expect(projectGenTotalUsd(observed, cost.calls_reported)).toBeCloseTo(cost.reported_total_usd, 10);
    // 결함이 있던 식이 실제로 낮게 나온다는 것을 같은 표본에서 함께 고정한다.
    expect(observed.medianUsd * cost.calls_reported).toBeLessThan(cost.reported_total_usd * 0.9);
  });

  it("건수에 비례한다", () => {
    const observed = deriveObservedUnitCost(skewedCost())!;
    expect(projectGenTotalUsd(observed, 64)).toBeCloseTo(observed.meanUsd * 64, 10);
  });
});

/**
 * **심사 L-4 — 오염된 run log가 `Infinity`를 승인 화면에 띄울 수 있었다.**
 *
 * JSON의 `1e400`은 `JSON.parse`에서 `Infinity`가 되고, `z.number().nonnegative()`는
 * `Infinity >= 0`이 참이라 **통과시킨다.** run log는 private 동기화 저장소를 통해 **다른
 * 머신에서 흘러 들어오므로** 이 값을 신뢰하지 않는다. 스키마 한 줄(`.finite()`)로 닫힌다.
 */
describe("GenCostSchema — 유한하지 않은 값은 단가가 될 수 없다", () => {
  it("Infinity를 거부한다 (JSON의 1e400이 파싱되면 Infinity다)", () => {
    const raw: unknown = JSON.parse(
      '{"calls_reported":1,"calls_unreported":0,"reported_total_usd":1e400,"median_usd":0.1,"max_usd":0.2}',
    );
    expect((raw as { reported_total_usd: number }).reported_total_usd).toBe(Infinity);
    expect(GenCostSchema.safeParse(raw).success, "Infinity가 단가로 통과했다").toBe(false);
  });

  it("median·max에도 같은 가드가 걸려 있다 — 한 필드만 막으면 나머지로 샌다", () => {
    for (const field of ["median_usd", "max_usd"] as const) {
      const raw = {
        calls_reported: 1,
        calls_unreported: 0,
        reported_total_usd: 1,
        median_usd: 0.1,
        max_usd: 0.2,
        [field]: Number.POSITIVE_INFINITY,
      };
      expect(GenCostSchema.safeParse(raw).success, field).toBe(false);
    }
  });

  it("정상 유한값은 그대로 통과한다 — 위 케이스가 '항상 거부'와 구분된다", () => {
    expect(GenCostSchema.safeParse({
      calls_reported: 1,
      calls_unreported: 0,
      reported_total_usd: 1,
      median_usd: 0.1,
      max_usd: 0.2,
    }).success).toBe(true);
  });
});
