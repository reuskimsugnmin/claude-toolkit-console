import { describe, expect, it } from "vitest";
import { describeProbeCost } from "../src/commands/agent-probe.js";

/**
 * cli/test/probe-cost-display.test.ts — **진단 1회의 지출과 모집단을 화면이 말하는가.**
 *
 * ⚠️ 이 줄이 없던 동안 `ctk agent-probe`는 유료 실행인데 지출을 **어디에도** 남기지 않았다.
 * `gen`은 중단돼도 run-log를 쓰는데(#24) 진단 경로만 0이었고, AC-3.3의 과거 유료 진단 4회
 * 지출은 지금도 알 수 없다. `agent-probe`는 `sync`를 호출하지 않는 계약이라 **남길 자리는
 * 화면뿐**이므로, 여기서 판정하는 것은 계산이 아니라 **화면이 무엇을 말하는가**이다.
 */

const base = {
  reportedCostUsd: 0.0523,
  provenance: { model: "sonnet", inputTokens: 100, outputTokens: 200 },
  requestedModel: "sonnet",
};

describe("describeProbeCost", () => {
  it("실제 지출과 모델·토큰을 함께 말한다", () => {
    const line = describeProbeCost(base);
    expect(line).toContain("$0.0523");
    expect(line).toContain("sonnet");
    expect(line).toContain("입력 100");
  });

  // **"못 읽었다"와 "0원"은 다르다**(안전 원칙 7). 0으로 말하면 지출이 없었던 것으로 읽힌다.
  it("비용을 못 읽으면 미보고라고 말한다 — 0원이라 하지 않는다", () => {
    const line = describeProbeCost({ ...base, reportedCostUsd: null });
    expect(line).toContain("미보고");
    expect(line, "0원으로 말하면 지출이 없었던 것으로 읽힌다").not.toContain("$0.0000");
  });

  // 요청과 실제가 다르면 **이 진단 결과는 의도한 모집단의 것이 아니다.** 조용히 넘기면
  // 다음 진단과 비교할 때 서로 다른 모델의 결과를 같은 선에 놓게 된다(안전 원칙 8).
  it("요청한 모델과 실제 태운 모델이 다르면 드러낸다", () => {
    const line = describeProbeCost({
      ...base,
      provenance: { ...base.provenance, model: "opus" },
      requestedModel: "sonnet",
    });
    expect(line).toContain("요청 sonnet");
    expect(line).toContain("opus");
    expect(line, "다르다는 사실 자체를 표시해야 한다").toContain("다르다");
  });

  it("모델을 못 읽으면 판정불가라고 말한다 — 요청값으로 추측하지 않는다", () => {
    const line = describeProbeCost({ ...base, provenance: { ...base.provenance, model: null } });
    expect(line).toContain("판정불가");
  });

  it("토큰을 못 읽으면 미보고라고 말한다", () => {
    const line = describeProbeCost({
      ...base,
      provenance: { model: "sonnet", inputTokens: null, outputTokens: null },
    });
    expect(line).toContain("토큰: 미보고");
  });
});
