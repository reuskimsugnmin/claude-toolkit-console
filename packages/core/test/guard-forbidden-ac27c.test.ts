import { describe, expect, it } from "vitest";
import { matchesForbidden, AC_2_7_C_FORBIDDEN_RULES, FORBIDDEN_RULES } from "../src/guard/forbidden.js";
import { verdict, type FileEntry } from "../src/guard/tree-diff.js";
import { TIER2_CHURN_ALLOWLIST } from "../src/guard/whitelist.js";

describe("core/guard/forbidden — AC-2.7-c 금지 목록(churn 예외 없음)", () => {
  it("모든 위치의 CLAUDE.md가 금지된다", () => {
    expect(matchesForbidden("CLAUDE.md", AC_2_7_C_FORBIDDEN_RULES)).toBeDefined();
    expect(matchesForbidden("some/nested/dir/CLAUDE.md", AC_2_7_C_FORBIDDEN_RULES)).toBeDefined();
  });

  it("<config>/plugins/installed_plugins.json이 금지된다", () => {
    expect(matchesForbidden("plugins/installed_plugins.json", AC_2_7_C_FORBIDDEN_RULES)).toBeDefined();
  });

  it("<config>/settings.local.json이 금지된다", () => {
    expect(matchesForbidden("settings.local.json", AC_2_7_C_FORBIDDEN_RULES)).toBeDefined();
  });

  it("Tier-1 대상 settings.json은 금지되지 않는다(오탐 방지)", () => {
    expect(matchesForbidden("settings.json", AC_2_7_C_FORBIDDEN_RULES)).toBeUndefined();
  });

  it("일반 FORBIDDEN_RULES(경로 순회 등)는 그대로 포함된다", () => {
    expect(matchesForbidden("../escape", AC_2_7_C_FORBIDDEN_RULES)).toBeDefined();
    expect(AC_2_7_C_FORBIDDEN_RULES.length).toBeGreaterThan(FORBIDDEN_RULES.length);
  });

  it("금지 목록은 Tier-2 churn 허용목록이 잘못 넓어져도 우선한다(Pre-mortem H 방어)", () => {
    const before: FileEntry[] = [{ path: "CLAUDE.md", sha256: "a" }];
    const after: FileEntry[] = [{ path: "CLAUDE.md", sha256: "b" }];
    // 실수로 CLAUDE.md를 Tier-2에 추가했다고 가정해도(방어적 시나리오) forbidden이 항상 이긴다.
    const mistakenAllowlist = [...TIER2_CHURN_ALLOWLIST, { exact: "CLAUDE.md", note: "실수로 추가된 예외" }];
    const result = verdict(before, after, mistakenAllowlist, AC_2_7_C_FORBIDDEN_RULES);
    expect(result.overallStatus).toBe("violation");
  });
});
