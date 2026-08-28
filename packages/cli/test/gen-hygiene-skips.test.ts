import { describe, expect, it } from "vitest";
import type { FailureClass } from "@ctk/core";
import { countHygieneSkips } from "../src/commands/gen.js";

/**
 * cli/test/gen-hygiene-skips.test.ts — 보안 재심 L-2(2026-08-28).
 *
 * ⚠️ **위생 거부의 사후 감사 경로가 0이었다.** `plan.skipped`는 stdout에만 나갔고 run-log에는
 * 흔적이 없었다. 특히 `install_path_rejected`는 `installed_plugins.json` 오염 신호인데
 * (그 파일은 AC-2.7-c가 "최우선 경보"로 지정한 파일이다) 나중에 되짚을 방법이 없었다.
 *
 * **`failure_class`에 넣지 않은 이유**: 그 필드는 "무엇이 실행을 **중단시켰는가"**이고 위생
 * 거부는 자산 1건만 빼는 것이다. 뭉개면 "한 자산을 건너뛴 성공"이 "실패한 실행"으로 읽힌다.
 */

function skip(failureClass: FailureClass): { failureClass: FailureClass } {
  return { failureClass };
}

describe("countHygieneSkips — 위생 거부를 분류별로 센다(L-2)", () => {
  it("분류별로 세고, 같은 분류는 합산한다", () => {
    expect(
      countHygieneSkips([
        skip("install_path_rejected"),
        skip("path_traversal_detected"),
        skip("install_path_rejected"),
      ]),
    ).toEqual({ install_path_rejected: 2, path_traversal_detected: 1 });
  });

  it("거부가 없으면 빈 객체다 — '없음'을 그대로 기록한다(0을 지어내지 않는다)", () => {
    expect(countHygieneSkips([])).toEqual({});
  });

  it("합이 입력 건수와 같다 — 어떤 분류도 어디에도 안 잡히는 일이 없다", () => {
    // ⚠️ 개별 카운터만 단언하면 "안 잡힘"이 통과한다(`policy_blocked`가 요약에서 통째로
    // 사라졌던 사고와 같은 형태) — 합으로 완전성을 본다.
    const input = [
      skip("install_path_rejected"),
      skip("asset_source_not_a_file"),
      skip("asset_source_too_large"),
      skip("asset_source_missing"),
      skip("path_traversal_detected"),
      skip("injection_pattern_detected"),
    ];
    const counts = countHygieneSkips(input);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(input.length);
  });
});
