import { describe, expect, it } from "vitest";
import type { HomeContext } from "@ctk/probe";
import { CredentialMissingError, estimateGenCost } from "../src/estimate.js";
import type { GenPlanTarget } from "../src/plan.js";

const HOME: HomeContext = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: true };

function target(content: string): GenPlanTarget {
  return {
    asset: { schema_version: 1, _scope: "machine_independent", id: "x", kind: "skill", name: "x" },
    reason: "new",
    sections: [{ label: "SKILL.md", content }],
    sourceContentSha256: "deadbeef",
  };
}

describe("gen/estimate — 인증 선검사(0원) → (가능하면) 토큰 실측 → 비용 근사치", () => {
  it("인증이 없으면 API 호출 이전에 CredentialMissingError로 즉시 중단한다", async () => {
    const checkAuthFn = async () => ({ loggedIn: false });
    await expect(
      estimateGenCost({ home: HOME, targets: [target("x")], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn }),
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
    });
    expect(result.estimatedInputTokens).toBeNull();
    expect(result.approxCostUsd).toBeNull();
    expect(result.approxBytes).toBe(Buffer.byteLength("hello world", "utf8"));
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
    });
    expect(result.estimatedInputTokens).toBe(2000);
    expect(result.approxCostUsd).toBeCloseTo((2000 / 1_000_000) * 3, 10);
    expect(result.assetCount).toBe(2);
    expect(result.callCount).toBe(2);
  });

  it("대상이 0개면 0으로 채워진 결과를 반환한다(빈 계획도 유효한 실행)", async () => {
    const checkAuthFn = async () => ({ loggedIn: true });
    const result = await estimateGenCost({ home: HOME, targets: [], tokenizerModel: "m", cwd: "/tmp", timeoutSec: 5, checkAuthFn });
    expect(result.assetCount).toBe(0);
    expect(result.estimatedInputTokens).toBe(0);
    expect(result.approxCostUsd).toBe(0);
  });
});
