import { describe, expect, it } from "vitest";
import { summarizeGenCost } from "../src/index.js";
import { readEnvelopeCostUsd, readEnvelopeProvenance } from "../src/output-schema.js";
import { GEN_MODEL } from "../src/run-claude-p.js";
import { GenCostSchema } from "@ctk/core";

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

/**
 * **모집단을 함께 싣는다 (2026-08-25).** 실측 단가를 쌓으면서 **어떤 모델이 만든 값인지**
 * 기록하지 않으면, 사용자가 기본 모델을 바꾸는 순간 그 단가는 서로 다른 모집단이 섞인 값이
 * 되고 다음 실행의 견적이 조용히 틀린다(안전 원칙 8).
 *
 * `gen`은 이제 `--model sonnet`으로 고정하지만, **고정했다는 사실과 실제로 그것이 처리했다는
 * 사실은 다르다** — 그래서 하네스가 보고한 값을 그대로 싣는다.
 */
describe("summarizeGenCost — 출처(모델·토큰)를 함께 센다", () => {
  const P = (model: string | null, i: number | null, o: number | null) => ({
    model,
    inputTokens: i,
    outputTokens: o,
  });

  it("관측된 모델을 중복 없이 모으고 토큰을 합산한다", () => {
    const c = summarizeGenCost([0.1, 0.2], 0, [P("sonnet", 100, 10), P("sonnet", 200, 20)]);
    expect(c.models).toEqual(["sonnet"]);
    expect(c.calls_model_unknown).toBe(0);
    expect(c.input_tokens).toBe(300);
    expect(c.output_tokens).toBe(30);
  });

  /** 모델이 섞이면 그 사실이 드러나야 한다 — 단가 하나로 뭉치면 다음 견적이 틀린다. */
  it("두 모델이 섞이면 둘 다 남긴다", () => {
    const c = summarizeGenCost([0.1, 0.9], 0, [P("sonnet", 1, 1), P("opus", 1, 1)]);
    expect(c.models).toEqual(["opus", "sonnet"]);
  });

  /** ⚠️ 못 읽은 것을 "기본 모델"로 지어내지 않는다 — 미보고를 0으로 삼키지 않는 것과 같은 규율. */
  it("모델을 못 읽은 호출은 models에 넣지 않고 따로 센다", () => {
    const c = summarizeGenCost([0.1, 0.2], 0, [P("sonnet", 5, 5), P(null, null, null)]);
    expect(c.models).toEqual(["sonnet"]);
    expect(c.calls_model_unknown).toBe(1);
  });

  /** 부분합을 총합으로 내보내지 않는다 — 하나라도 읽었으면 그 합, 전부 못 읽었으면 null이다. */
  /**
   * **축이 갈리는 유일한 입력**이다 — 다른 호출에 sonnet이 섞여 있으면 지어낸 값이 중복 제거로
   * 가려진다(파괴 실험에서 실제로 통과했다). 전부 미보고여야 "지어냈는가"가 드러난다.
   */
  it("전부 못 읽으면 models는 빈 배열이다 — '기본 모델'로 지어내지 않는다", () => {
    const c = summarizeGenCost([0.1], 0, [P(null, null, null)]);
    expect(c.models, "못 읽은 모델을 지어냈다").toEqual([]);
    expect(c.calls_model_unknown).toBe(1);
    expect(c.input_tokens).toBeNull();
    expect(c.output_tokens).toBeNull();
  });

  it("출처를 주지 않은 옛 호출도 스키마를 통과한다 — 기본값이 채워진다", () => {
    expect(GenCostSchema.parse(summarizeGenCost([0.1], 0)).models).toEqual([]);
  });
});

/**
 * 봉투 파서 — **못 읽으면 null이고 지어내지 않는다.** 한 호출이 두 모델을 탔다면 "어느 모델의
 * 단가인가"에 답할 수 없으므로 판정하지 않는다.
 */
describe("readEnvelopeProvenance", () => {
  it("모델 키가 정확히 하나면 그것을 낸다", () => {
    const r = readEnvelopeProvenance(JSON.stringify({ modelUsage: { sonnet: {} }, usage: { input_tokens: 9, output_tokens: 3 } }));
    expect(r).toEqual({ model: "sonnet", inputTokens: 9, outputTokens: 3 });
  });

  it("모델 키가 둘이면 판정하지 않는다 (null)", () => {
    expect(readEnvelopeProvenance(JSON.stringify({ modelUsage: { sonnet: {}, opus: {} } })).model).toBeNull();
  });

  it("봉투를 못 읽으면 전부 null이다 — 0이나 기본 모델로 대체하지 않는다", () => {
    expect(readEnvelopeProvenance("not json")).toEqual({ model: null, inputTokens: null, outputTokens: null });
  });
});

/**
 * **모델 고정은 argv로 확인한다.** 고정했다는 상수만 보면 배선이 끊겨도 통과한다 —
 * 실제로 자식에게 넘어가는 인자에 실려야 한다.
 */
describe("gen 모델 고정", () => {
  it("문서 생성은 sonnet으로 고정된다", () => {
    expect(GEN_MODEL).toBe("sonnet");
  });
});
