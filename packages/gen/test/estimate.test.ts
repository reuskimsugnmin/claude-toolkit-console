import { describe, expect, it } from "vitest";
import type { Asset } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";
import { CredentialMissingError, estimateGenCost, UNGROUPED_PARENT_ID } from "../src/estimate.js";
import type { GenPlanTarget } from "../src/plan.js";

const HOME: HomeContext = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: true };

function target(content: string, asset: Partial<Asset> = {}): GenPlanTarget {
  return {
    asset: { schema_version: 1, _scope: "machine_independent", id: "x", kind: "skill", name: "x", ...asset },
    reason: "new",
    sections: [{ label: "SKILL.md", content }],
    sourceContentSha256: "deadbeef",
  };
}

/**
 * ⚠️ **이 파일이 지키는 것은 "숫자가 계산되는가"가 아니라 "그 숫자가 무엇인지 화면이 알 수
 * 있는가"다.** 실측(2026-08-24): 견적이 입력 토큰만 곱해 실제의 약 1/20을 표시했고, 필드명이
 * `approxCostUsd`("근사 비용")여서 그 값이 **총비용으로 읽혔다.** 그 20배 낮은 숫자 위에서
 * 승인이 이뤄졌다 — 이 저장소의 원칙은 "비용을 먼저 투명하게 알리고 승인받는다"이다.
 *
 * 그래서 반환값은 셋으로 갈린다: **하한**(입력만) · **정확한 상한**(호출수 × 호출당 상한) ·
 * **실측**(이 머신의 지난 실행, 없으면 null). 셋을 하나로 뭉치면 결함이 되돌아온다.
 */
describe("gen/estimate — 비용은 하한·상한·실측 셋으로 갈라 보고한다", () => {
  it("인증이 없으면 API 호출 이전에 CredentialMissingError로 즉시 중단한다", async () => {
    const checkAuthFn = async () => ({ loggedIn: false });
    await expect(
      estimateGenCost({ home: HOME, targets: [target("x")], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn, maxBudgetUsd: 0.5 }),
    ).rejects.toBeInstanceOf(CredentialMissingError);
  });

  it("인증이 있고 count_tokens가 크레덴셜 없이 unmeasured로 열화하면 approxBytes만 채워지고 토큰/비용은 null이다", async () => {
    const checkAuthFn = async () => ({ loggedIn: true });
    const countTokensFn = async () => ({ state: "unmeasured" as const, value_tokens: null, reason: "credential_missing" as const });
    const result = await estimateGenCost({
      home: HOME,
      targets: [target("hello world")],
      tokenizerModel: "m",
      cwd: "/tmp",
      timeoutSec: 5,
      checkAuthFn,
      countTokensFn,
      maxBudgetUsd: 0.5,
    });
    expect(result.estimatedInputTokens).toBeNull();
    expect(result.costFloorUsd).toBeNull();
    expect(result.approxBytes).toBe(Buffer.byteLength("hello world", "utf8"));
    // 토큰을 못 재도 **상한은 정확히 알 수 있다** — 하네스가 호출당 상한을 강제하기 때문이다.
    // 여기서 상한까지 null이 되면 화면은 다시 "비용을 모른다"만 말하게 된다.
    expect(result.costCeilingUsd).toBe(0.5);
  });

  it("count_tokens가 실측되면 자산별 합계와 근사 비용을 계산한다", async () => {
    const checkAuthFn = async () => ({ loggedIn: true });
    const countTokensFn = async () => ({ state: "measured" as const, value_tokens: 1000, tokenizer_model: "m", measured_at: "now" });
    const result = await estimateGenCost({
      home: HOME,
      targets: [target("a"), target("b")],
      tokenizerModel: "m",
      cwd: "/tmp",
      timeoutSec: 5,
      checkAuthFn,
      countTokensFn,
      approxUsdPerMillionInputTokens: 3,
      maxBudgetUsd: 0.25,
    });
    expect(result.estimatedInputTokens).toBe(2000);
    expect(result.costFloorUsd).toBeCloseTo((2000 / 1_000_000) * 3, 10);
    expect(result.costCeilingUsd).toBeCloseTo(0.5, 10); // 2회 × $0.25
    expect(result.assetCount).toBe(2);
    expect(result.callCount).toBe(2);
    // 하한이 상한보다 크면 둘 중 하나가 틀린 것이다 — 뭉쳐 있던 시절에는 물어볼 수도 없던 질문이다.
    expect(result.costFloorUsd).toBeLessThan(result.costCeilingUsd);
  });

  it("지난 실행의 실측이 있으면 그대로 싣고, 없으면 null이다 — 지어내지 않는다", async () => {
    const checkAuthFn = async () => ({ loggedIn: true });
    const countTokensFn = async () => ({ state: "measured" as const, value_tokens: 10, tokenizer_model: "m", measured_at: "now" });
    const base = { home: HOME, targets: [target("a")], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn, countTokensFn, maxBudgetUsd: 0.5 };

    const withHistory = await estimateGenCost({
      ...base,
      observedCost: { calls_reported: 4, calls_unreported: 1, reported_total_usd: 0.8, median_usd: 0.2, max_usd: 0.3 },
    });
    // 평균은 총액÷보고건수로 함께 실린다 — 배치 총액 투사는 중앙값이 아니라 이 값으로 한다.
    expect(withHistory.observed).toEqual({
      meanUsd: 0.2, // 0.8 ÷ 4
      medianUsd: 0.2,
      maxUsd: 0.3,
      sampleSize: 4,
      partial: true,
    });

    expect((await estimateGenCost({ ...base, observedCost: null })).observed).toBeNull();
    expect((await estimateGenCost(base)).observed).toBeNull();
  });

  it("보고 0건인 실측 이력은 null로 떨어뜨린다 — 중앙값 0은 '공짜였다'로 읽힌다", async () => {
    const checkAuthFn = async () => ({ loggedIn: true });
    const countTokensFn = async () => ({ state: "measured" as const, value_tokens: 10, tokenizer_model: "m", measured_at: "now" });
    const result = await estimateGenCost({
      home: HOME, targets: [target("a")], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5,
      checkAuthFn, countTokensFn, maxBudgetUsd: 0.5,
      observedCost: { calls_reported: 0, calls_unreported: 3, reported_total_usd: 0, median_usd: null, max_usd: null },
    });
    expect(result.observed).toBeNull();
  });

  it("대상이 0개면 0으로 채워진 결과를 반환한다(빈 계획도 유효한 실행)", async () => {
    const checkAuthFn = async () => ({ loggedIn: true });
    const result = await estimateGenCost({ home: HOME, targets: [], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn, maxBudgetUsd: 0.5 });
    expect(result.assetCount).toBe(0);
    expect(result.estimatedInputTokens).toBe(0);
    expect(result.costFloorUsd).toBe(0);
    expect(result.costCeilingUsd).toBe(0); // 호출이 0회면 상한도 0이다 — maxBudgetUsd가 아니라.
  });

  /**
   * B1 Step 4(결정 6) — `byParent`는 `targets`를 **빠짐없이** 분할해야 한다. cli 표시 계층이
   * "행마다 투사해 더한 값"을 총액으로 쓰므로(구조적 단일화), 분할이 새면 총액이 조용히
   * 줄어든다 — `estimate.callCount`와 `byParent` 합이 항상 같아야 하는 이유다.
   */
  describe("byParent — targets를 부모별로 빠짐없이 분할한다", () => {
    it("parent_asset_id가 없는 최상위 대상은 전부 UNGROUPED_PARENT_ID 한 행으로 묶인다", async () => {
      const checkAuthFn = async () => ({ loggedIn: true });
      const result = await estimateGenCost({
        home: HOME, targets: [target("a"), target("b")], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn, maxBudgetUsd: 0.5,
      });
      expect(result.byParent).toEqual([{ parent_id: UNGROUPED_PARENT_ID, callCount: 2 }]);
    });

    it("번들 자식은 실제 부모 id로 갈리고, 최상위와 번들이 섞여도 전체 건수가 보존된다", async () => {
      const checkAuthFn = async () => ({ loggedIn: true });
      const targets = [
        target("top", {}), // 최상위(부모 없음)
        target("c1", { id: "p1:c1", parent_asset_id: "p1" }),
        target("c2", { id: "p1:c2", parent_asset_id: "p1" }),
        target("c3", { id: "p2:c1", parent_asset_id: "p2" }),
      ];
      const result = await estimateGenCost({
        home: HOME, targets, tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn, maxBudgetUsd: 0.5,
      });
      const byId = new Map(result.byParent.map((r) => [r.parent_id, r.callCount]));
      expect(byId.get(UNGROUPED_PARENT_ID)).toBe(1);
      expect(byId.get("p1")).toBe(2);
      expect(byId.get("p2")).toBe(1);
      // ⚠️ 이 합이 곧 "행의 합 = 총액"이 구조적으로 보장되는 근거다.
      const sum = result.byParent.reduce((s, r) => s + r.callCount, 0);
      expect(sum).toBe(result.callCount);
      expect(result.callCount).toBe(targets.length);
    });
  });
});
