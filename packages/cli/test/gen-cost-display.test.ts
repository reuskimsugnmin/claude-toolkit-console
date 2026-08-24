import { describe, expect, it } from "vitest";
import { describeActualCost, describeCostEstimate } from "../src/commands/gen.js";

/**
 * cli/test/gen-cost-display.test.ts — **비용 고지 문구.**
 *
 * ⚠️ 이 수정의 대상은 계산이 아니라 **문구**였다. 예전 한 줄은 `근사 비용: $0.2890`이었고 그
 * 값은 입력 토큰만 곱한 것이었다 — 실제는 약 20배였다(2026-08-24 실측). 계산은 "틀리지 않았고"
 * 이름이 틀렸다. 그래서 여기서 판정하는 것은 **화면이 그 값이 무엇인지 말하는가**이다.
 */

const BASE = { assetCount: 30, callCount: 30, estimatedInputTokens: 96_320, approxBytes: 1_000_000 };

describe("describeCostEstimate — 하한·상한·실측을 갈라 말한다", () => {
  it("하한을 '총비용'으로 읽히게 두지 않는다", () => {
    const lines = describeCostEstimate({ ...BASE, costFloorUsd: 0.289, costCeilingUsd: 13.5, observed: null }, 0.45);
    const text = lines.join("\n");
    expect(text).toContain("비용 하한");
    expect(text).toContain("입력 토큰만");
    expect(text).toContain("총비용이 아니다");
  });

  it("상한을 계산 근거와 함께 말한다 — 사용자가 검산할 수 있어야 한다", () => {
    const text = describeCostEstimate({ ...BASE, costFloorUsd: 0.289, costCeilingUsd: 13.5, observed: null }, 0.45).join("\n");
    expect(text).toContain("$13.50");
    expect(text).toContain("30회");
    expect(text).toContain("0.45");
  });

  it("실측이 없으면 '없음'이라고 말한다 — 추정치를 지어내지 않는다", () => {
    const text = describeCostEstimate({ ...BASE, costFloorUsd: 0.289, costCeilingUsd: 13.5, observed: null }, 0.45).join("\n");
    expect(text).toContain("실측 단가: 없음");
    expect(text).toContain("지어내지 않는다");
  });

  it("실측이 있으면 자산당 단가와 이번 실행 환산액을 함께 낸다", () => {
    const text = describeCostEstimate(
      { ...BASE, costFloorUsd: 0.289, costCeilingUsd: 13.5, observed: { medianUsd: 0.184, maxUsd: 0.406, sampleSize: 19, partial: false } },
      0.45,
    ).join("\n");
    expect(text).toContain("중앙값 $0.184");
    expect(text).toContain("최대 $0.406");
    expect(text).toContain("$5.52"); // 0.184 × 30 — 하한 $0.289와 자릿수가 다르다
  });

  it("표본이 불완전하면 그 사실을 함께 말한다", () => {
    const text = describeCostEstimate(
      { ...BASE, costFloorUsd: 0.289, costCeilingUsd: 13.5, observed: { medianUsd: 0.184, maxUsd: 0.406, sampleSize: 4, partial: true } },
      0.45,
    ).join("\n");
    expect(text).toContain("표본이 불완전");
  });

  it("토큰을 못 재도 상한은 말한다 — '비용을 모른다'로 끝나지 않는다", () => {
    const text = describeCostEstimate(
      { ...BASE, estimatedInputTokens: null, costFloorUsd: null, costCeilingUsd: 13.5, observed: null },
      0.45,
    ).join("\n");
    expect(text).toContain("측정 불가");
    expect(text).toContain("비용 상한");
    expect(text).not.toContain("비용 하한"); // 없는 값을 0으로 적지 않는다
  });
});

describe("describeActualCost — 실행 뒤 실제로 나간 돈", () => {
  it("미보고가 섞이면 총액이 아니라 하한이라고 말한다", () => {
    const text = describeActualCost({ calls_reported: 11, calls_unreported: 4, reported_total_usd: 1.9, median_usd: 0.17, max_usd: 0.4 });
    expect(text).toContain("$1.90이상(하한)");
    expect(text).toContain("미보고 4건");
  });

  it("전부 보고되면 하한 표기를 붙이지 않는다", () => {
    const text = describeActualCost({ calls_reported: 11, calls_unreported: 0, reported_total_usd: 1.9, median_usd: 0.17, max_usd: 0.4 });
    expect(text).toContain("$1.90 ");
    expect(text).not.toContain("하한");
    expect(text).not.toContain("미보고");
  });

  it("보고가 하나도 없으면 '0원이 아니다'라고 못박는다", () => {
    const text = describeActualCost({ calls_reported: 0, calls_unreported: 7, reported_total_usd: 0, median_usd: null, max_usd: null });
    expect(text).toContain("보고 없음");
    expect(text).toContain("0원이라는 뜻이 아니다");
    expect(text).not.toContain("$0.00 ");
  });
});
