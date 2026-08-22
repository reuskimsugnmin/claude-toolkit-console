import { describe, expect, it } from "vitest";
import { rankUnusedExpensive } from "../src/usage/rank.js";
import type { Occupancy } from "../src/schema/occupancy.js";
import type { UsageMetric } from "../src/schema/usage.js";

function occ(assetId: string, idleTokens: number | null): Occupancy {
  return {
    schema_version: 1,
    _scope: "machine_independent",
    asset_id: assetId,
    idle:
      idleTokens === null
        ? { state: "unmeasured", value_tokens: null, reason: "credential_missing" }
        : { state: "measured", value_tokens: idleTokens, tokenizer_model: "claude-demo", measured_at: "2026-08-01T00:00:00.000Z" },
    loaded: { state: "unmeasured", value_tokens: null, reason: "credential_missing" },
    idle_definition: "harness-parity",
    harness_alwayson: { state: "unmeasured", value_tokens: null, reason: "not_a_plugin" },
    occupancy_divergence: false,
    occupancy_divergence_ratio: null,
  };
}

function usage(assetId: string, callCount: number, tokenSum: number): UsageMetric {
  return {
    schema_version: 1,
    _scope: "machine_dependent",
    asset_id: assetId,
    machine_id: "machine-alpha",
    project_path_hash: null,
    call_count: callCount,
    token_sum: tokenSum,
    token_sum_definition: "tool_result_payload_count_tokens_v1",
    last_used_at: null,
    attribution_source: "prefix_rule",
    attribution_rule: "prefix_rule:skill_tool_input",
    subagent_attribution: "not_applicable",
    harness_usage_count: null,
    harness_last_used_at: null,
    usage_divergence: false,
  };
}

describe("usage/rank — ctk usage --unused-expensive N (AC-4.6)", () => {
  it("idle 토큰 내림차순으로 정렬하고, 동률이면 call_count 오름차순(안 쓸수록 위)이다", () => {
    const { ranked } = rankUnusedExpensive({
      usage: [usage("a", 10, 100), usage("b", 0, 0), usage("c", 5, 50)],
      occupancy: [occ("a", 500), occ("b", 500), occ("c", 1000)],
      limit: 5,
    });
    expect(ranked.map((r) => r.asset_id)).toEqual(["c", "b", "a"]);
  });

  it("idle이 unmeasured인 자산은 순위에서 제외되고 별도로 노출된다(R8 — 추정치로 순위를 뒤집지 않는다)", () => {
    const { ranked, excludedUnmeasuredAssetIds } = rankUnusedExpensive({
      usage: [usage("a", 1, 1)],
      occupancy: [occ("a", 100), occ("unmeasured-asset", null)],
      limit: 5,
    });
    expect(ranked.map((r) => r.asset_id)).toEqual(["a"]);
    expect(excludedUnmeasuredAssetIds).toEqual(["unmeasured-asset"]);
  });

  it("limit으로 상위 N개만 반환한다", () => {
    const { ranked } = rankUnusedExpensive({
      usage: [],
      occupancy: [occ("a", 300), occ("b", 200), occ("c", 100)],
      limit: 2,
    });
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.asset_id)).toEqual(["a", "b"]);
  });

  it("UsageMetric이 없는 자산(호출 0건)도 call_count=0으로 순위에 포함된다", () => {
    const { ranked } = rankUnusedExpensive({ usage: [], occupancy: [occ("never-called", 999)], limit: 5 });
    expect(ranked[0]).toMatchObject({ asset_id: "never-called", call_count: 0, attribution_source: null });
  });
});
