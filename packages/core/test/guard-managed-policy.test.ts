import { describe, expect, it } from "vitest";
import { decideManagedPolicyGate, gradeManagedPolicy } from "../src/guard/managed-policy.js";

describe("core/guard/managed-policy — iter 8 · M1 (순수 함수)", () => {
  it("관리 정책이 하나도 없으면 위험 없음이다", () => {
    const grade = gradeManagedPolicy([]);
    expect(grade).toEqual({ keysPresent: [], hasRisk: false });
  });

  it("관리 정책은 있지만 위험 키가 없으면 위험 없음이다", () => {
    const grade = gradeManagedPolicy([{ model: "sonnet" }]);
    expect(grade).toEqual({ keysPresent: [], hasRisk: false });
  });

  it("hooks 키가 있으면 위험으로 등급화된다", () => {
    const grade = gradeManagedPolicy([{ hooks: { PreToolUse: [] } }]);
    expect(grade.hasRisk).toBe(true);
    expect(grade.keysPresent).toEqual(["hooks"]);
  });

  it("여러 정책 파일에 걸친 위험 키를 모두 모은다(순서는 상수 정의 순서)", () => {
    const grade = gradeManagedPolicy([{ env: {} }, { apiKeyHelper: "x" }, { hooks: {} }]);
    expect(grade.keysPresent).toEqual(["hooks", "apiKeyHelper", "env"]);
    expect(grade.hasRisk).toBe(true);
  });

  it("정책 내용 원문은 등급 결과 어디에도 직렬화되지 않는다", () => {
    const grade = gradeManagedPolicy([{ hooks: { secret: "should-not-leak" } }]);
    expect(JSON.stringify(grade)).not.toContain("should-not-leak");
  });

  it("null/배열 등 객체가 아닌 항목은 무시한다(방어적)", () => {
    const grade = gradeManagedPolicy([null, undefined, "x", [1, 2], { hooks: {} }]);
    expect(grade.keysPresent).toEqual(["hooks"]);
  });

  it("위험 키가 없으면 비대화형이어도 허용한다", () => {
    const grade = gradeManagedPolicy([]);
    expect(decideManagedPolicyGate(grade, { interactive: false, allowManagedPolicy: false })).toBe("allowed");
  });

  it("위험 키가 있고 대화형이면 허용한다(경고 후 진행 — 이 분류를 쓰지 않는다)", () => {
    const grade = gradeManagedPolicy([{ hooks: {} }]);
    expect(decideManagedPolicyGate(grade, { interactive: true, allowManagedPolicy: false })).toBe("allowed");
  });

  it("위험 키가 있고 비대화형이며 옵트인이 없으면 거부한다 (managed_policy_blocked)", () => {
    const grade = gradeManagedPolicy([{ hooks: {} }]);
    expect(decideManagedPolicyGate(grade, { interactive: false, allowManagedPolicy: false })).toBe("blocked");
  });

  it("위험 키가 있고 비대화형이어도 --allow-managed-policy 옵트인이 있으면 허용한다", () => {
    const grade = gradeManagedPolicy([{ hooks: {} }]);
    expect(decideManagedPolicyGate(grade, { interactive: false, allowManagedPolicy: true })).toBe("allowed");
  });
});
