import { describe, expect, it } from "vitest";
import type { RunGenAssetResult } from "@ctk/gen";
import { countGenOutcomes, describeGenSummary } from "../src/commands/gen.js";

/**
 * cli/test/gen-summary-display.test.ts — **`gen` 실행 요약 문구.**
 *
 * ⚠️ 이 파일이 생긴 이유: 이 문자열은 `bin/ctk.ts` 안에 인라인으로 있었고 **어떤 테스트도 태우지
 * 않았다.** 그 사이 `policy_blocked` outcome이 어느 카운터에도 잡히지 않아 **3건이 요약에서
 * 통째로 사라지는** 회귀가 생겼고, 타입도 그것을 막지 못했다(`filter(...).length`였다).
 * 여기서 판정하는 것은 계산이 아니라 **화면이 무엇을 말하는가**이다.
 */

const r = (outcome: RunGenAssetResult["outcome"]): RunGenAssetResult => ({ assetId: `a-${outcome}`, outcome });

describe("countGenOutcomes — 어떤 outcome도 조용히 빠지지 않는다", () => {
  it("네 상태를 각각 센다", () => {
    const counts = countGenOutcomes([r("fresh"), r("fresh"), r("pending"), r("stale"), r("policy_blocked")]);
    expect(counts).toEqual({ fresh: 2, pending: 1, stale: 1, policy_blocked: 1 });
  });

  // ⚠️ **합이 보존되는지 본다.** 개별 카운터를 각각 단언하면 새 outcome이 추가됐을 때 "어디에도
  // 안 잡힘"이 그대로 통과한다 — 실제로 그렇게 3건이 사라졌다.
  it("센 것의 합이 입력 건수와 같다 — 어디에도 안 잡히는 값이 없다", () => {
    const results = [r("fresh"), r("pending"), r("stale"), r("policy_blocked")];
    const counts = countGenOutcomes(results);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total, "합이 줄었다면 어떤 outcome이 조용히 빠졌다는 뜻이다").toBe(results.length);
  });
});

describe("describeGenSummary — stale과 policy_blocked를 뭉치지 않는다", () => {
  it("정책차단을 갱신필요와 **다른 칸**에 센다", () => {
    const lines = describeGenSummary([r("policy_blocked"), r("policy_blocked"), r("stale")]);
    expect(lines[0]).toContain("갱신필요 1건");
    expect(lines[0]).toContain("정책차단 2건");
  });

  // #25의 목적은 "재시도 루프를 끊는다"였다. 값 계층에서 끊어 놓고 화면이 재시도를 권하면
  // 사용자에게는 끊기지 않은 것과 같다 — 그래서 **안내가 실제로 붙는지**를 단언한다.
  it("정책차단이 있으면 재시도가 무의미함과 탈출구를 함께 알린다", () => {
    const lines = describeGenSummary([r("policy_blocked")]);
    expect(lines.join("\n")).toContain("재시도로 풀리지 않는다");
    expect(lines.join("\n"), "빠져나갈 길을 함께 준다(안전 원칙 6)").toContain("--retry-blocked");
  });

  it("정책차단이 0건이면 안내를 붙이지 않는다 — 잡음이 신호를 묻지 않게", () => {
    expect(describeGenSummary([r("fresh"), r("stale")])).toHaveLength(1);
  });
});
