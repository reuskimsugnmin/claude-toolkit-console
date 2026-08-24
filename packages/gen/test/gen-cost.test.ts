import { describe, expect, it } from "vitest";
import { summarizeGenCost } from "../src/index.js";
import { readEnvelopeCostUsd } from "../src/output-schema.js";

/**
 * gen/test/gen-cost.test.ts — **실측 비용 집계.**
 *
 * ⚠️ 이 코드가 지켜야 하는 것은 합계가 맞는 것이 아니라 **"모른다"를 0으로 삼키지 않는 것**이다
 * (안전 원칙 7). 하네스가 `total_cost_usd`를 싣지 않은 호출을 0원으로 더하면 총액이 조용히
 * 낮아지고, 그 낮아진 값이 다음 실행의 견적 근거가 된다 — 틀린 숫자가 스스로를 재생산한다.
 *
 * 배경(2026-08-24 실측): 배치가 끝나고도 **실지출을 알 수 없었다.** 비용은 실패 항목의 stdout
 * 에만 우연히 남아 있었고 성공 호출의 비용은 어디에도 기록되지 않았다.
 */
describe("summarizeGenCost — 보고와 미보고를 구분한다", () => {
  it("보고된 값만 합산하고 미보고 건수를 따로 센다", () => {
    const cost = summarizeGenCost([0.1, 0.3, 0.2], 2);
    expect(cost.calls_reported).toBe(3);
    expect(cost.calls_unreported).toBe(2);
    expect(cost.reported_total_usd).toBeCloseTo(0.6, 10);
    expect(cost.median_usd).toBe(0.2);
    expect(cost.max_usd).toBe(0.3);
  });

  it("보고가 0건이면 중앙값·최대값은 null이다 — 0이 아니다", () => {
    const cost = summarizeGenCost([], 5);
    expect(cost.calls_reported).toBe(0);
    expect(cost.calls_unreported).toBe(5);
    expect(cost.reported_total_usd).toBe(0);
    // ⚠️ 여기가 이 파일의 핵심이다. 0을 넣으면 화면이 "자산당 $0.000"이라고 말하고,
    // 사용자는 공짜라고 읽는다. null이어야 "실측 없음"으로 표시된다.
    expect(cost.median_usd).toBeNull();
    expect(cost.max_usd).toBeNull();
  });

  it("호출이 아예 없었으면 미보고도 0이다 — '실행 안 함'과 '보고 안 함'은 다르다", () => {
    const cost = summarizeGenCost([], 0);
    expect(cost.calls_reported).toBe(0);
    expect(cost.calls_unreported).toBe(0);
    expect(cost.median_usd).toBeNull();
  });
});

describe("readEnvelopeCostUsd — 봉투에서 비용만 꺼낸다", () => {
  it("성공 봉투에서 읽는다", () => {
    expect(readEnvelopeCostUsd(JSON.stringify({ total_cost_usd: 0.184, result: "x" }))).toBe(0.184);
  });

  it("실패 봉투(is_error=true)에서도 읽는다 — 실패에 든 돈도 실지출이다", () => {
    // 실측 형태: is_error가 true여도 total_cost_usd는 실려 온다.
    const raw = JSON.stringify({ is_error: true, total_cost_usd: 0.406, stop_reason: "tool_use" });
    expect(readEnvelopeCostUsd(raw)).toBe(0.406);
  });

  it("필드가 없거나 JSON이 아니면 null이다 — 0으로 대체하지 않는다", () => {
    expect(readEnvelopeCostUsd(JSON.stringify({ result: "x" }))).toBeNull();
    expect(readEnvelopeCostUsd("not json at all")).toBeNull();
    expect(readEnvelopeCostUsd("")).toBeNull();
  });

  it("음수 같은 불가능한 값은 받지 않는다 — 스키마가 거른 뒤 null이 된다", () => {
    expect(readEnvelopeCostUsd(JSON.stringify({ total_cost_usd: -1 }))).toBeNull();
  });
});
