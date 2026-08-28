import { describe, expect, it } from "vitest";
import { describeAssetDocState, type AssetDocState } from "../src/view/asset-doc-state.js";
import { FAILURE_CLASSES, type FailureClass } from "../src/failure/classes.js";

/**
 * core/test/asset-doc-state-blocked.test.ts — B1 보안 심사 L-D(2026-08-28).
 *
 * **무엇이 틀렸었나.** `blocked` 분기가 사유와 무관하게 한 문장이었다 — "스킬 원본이 심볼릭
 * 링크인 경우가 흔한 사유다 / 링크 대상을 허용할 범위를 정하는 문제". FIFO(`asset_source_not_a_file`)로
 * 막힌 사용자는 있지도 않은 링크를 찾게 되고, 크기 초과로 막힌 사용자는 "정책 결정이 필요하다"는
 * 말을 듣는다. **처방이 다른 것을 같은 문장으로 말하면 그 안내는 틀린 안내다.**
 *
 * 이 테스트는 **처방이 실제로 갈렸는지**를 본다 — 문구를 그대로 못박지 않고(문구는 다듬을 수
 * 있다) ⓐ 세 필드가 다 차 있는지 ⓑ 사유마다 action이 서로 다른지 ⓒ 링크가 아닌 사유에
 * "링크"를 처방하지 않는지를 단언한다.
 */

/** `gen/plan.ts`의 `judgeAsset`이 실제로 `blocked`으로 낼 수 있는 분류(도달 가능 집합). */
const REACHABLE: readonly FailureClass[] = [
  "path_traversal_detected",
  "asset_source_not_a_file",
  "asset_source_too_large",
  "asset_source_missing",
  "injection_pattern_detected",
];

function blocked(failure_class: FailureClass): AssetDocState {
  return { kind: "blocked", failure_class, reason: "테스트 사유(경로 없음)" };
}

describe("describeAssetDocState — blocked은 사유별로 다른 처방을 준다(L-D)", () => {
  it("도달 가능한 다섯 사유가 전부 세 필드를 채운다", () => {
    for (const fc of REACHABLE) {
      const d = describeAssetDocState(blocked(fc));
      expect(d.label.length, fc).toBeGreaterThan(0);
      expect(d.detail.length, fc).toBeGreaterThan(0);
      expect(d.action.length, fc).toBeGreaterThan(0);
    }
  });

  it("다섯 사유의 action이 서로 다르다 — 하나로 뭉개지 않았다", () => {
    const actions = REACHABLE.map((fc) => describeAssetDocState(blocked(fc)).action);
    expect(new Set(actions).size).toBe(REACHABLE.length);
  });

  it("FIFO·크기 초과는 링크 처방을 받지 않는다 — 예전 결함이 바로 이것이었다", () => {
    for (const fc of ["asset_source_not_a_file", "asset_source_too_large"] as const) {
      const d = describeAssetDocState(blocked(fc));
      expect(`${d.detail} ${d.action}`, fc).not.toContain("링크 대상");
    }
    // 양성 대조군 — 링크 사유에는 링크 얘기가 **있어야** 한다. 없으면 위 단언은 "아무 문구나
    // 링크를 안 담는다"는 공허한 통과가 된다.
    const link = describeAssetDocState(blocked("path_traversal_detected"));
    expect(`${link.detail} ${link.action}`).toContain("링크 대상");
  });

  it("전용 안내가 없는 분류도 action이 비지 않는다 — 기본 분기가 모른다고 말한다", () => {
    const others = FAILURE_CLASSES.filter((fc) => !REACHABLE.includes(fc));
    expect(others.length).toBeGreaterThan(20); // 양성 대조군 — 목록이 비면 아래가 공허하다.
    for (const fc of others) {
      const d = describeAssetDocState(blocked(fc));
      expect(d.action.length, fc).toBeGreaterThan(0);
      expect(d.detail, fc).toContain(fc); // 사유 코드를 그대로 보여준다(진단 경로).
    }
  });
});
