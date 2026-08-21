import { describe, expect, it } from "vitest";
import { claudeJsonSemanticVerdict } from "../src/guard/claude-json-semantic.js";

describe("core/guard/claude-json-semantic — AC-2.7-c .claude.json 의미 diff", () => {
  it("완전히 동일하면 clean이다(키 순서가 달라도)", () => {
    const before = { a: 1, b: { c: 2 } };
    const after = { b: { c: 2 }, a: 1 };
    const result = claudeJsonSemanticVerdict(before, after);
    expect(result.overallStatus).toBe("clean");
  });

  it("허용 churn 키 집합에 없는 최상위 키가 바뀌면 violation이다(화이트리스트 방향, F5)", () => {
    const before = { numStartups: 1 };
    const after = { numStartups: 2 };
    const result = claudeJsonSemanticVerdict(before, after, []);
    expect(result.overallStatus).toBe("violation");
    expect(result.violations).toEqual([{ path: "numStartups", status: "violation", mcpForbidden: false }]);
  });

  it("허용 churn 키로 명시하면 allowed_churn이다", () => {
    const before = { numStartups: 1 };
    const after = { numStartups: 2 };
    const result = claudeJsonSemanticVerdict(before, after, ["numStartups"]);
    expect(result.overallStatus).toBe("allowed_churn");
  });

  it("루트 mcpServers는 churn 키로 명시해도 항상 violation이다(MCP 서브트리 — churn 예외 없음)", () => {
    const before = { mcpServers: { a: {} } };
    const after = { mcpServers: { a: {}, b: {} } };
    const result = claudeJsonSemanticVerdict(before, after, ["mcpServers"]);
    expect(result.overallStatus).toBe("violation");
    expect(result.violations[0]?.mcpForbidden).toBe(true);
  });

  it("project 엔트리의 MCP 서브키(enabledMcpServers 등)는 churn 키로 명시해도 항상 violation이다", () => {
    const before = { projects: { "/synthetic/projects/alice-project": { enabledMcpServers: ["x"] } } };
    const after = { projects: { "/synthetic/projects/alice-project": { enabledMcpServers: ["x", "y"] } } };
    const result = claudeJsonSemanticVerdict(before, after, ["projects.*.enabledMcpServers"]);
    expect(result.overallStatus).toBe("violation");
    expect(result.violations[0]?.mcpForbidden).toBe(true);
    // AC-1.7 — 원문 프로젝트 경로가 위반 경로 문자열에 남지 않는다.
    expect(result.violations[0]?.path).not.toContain("/synthetic/projects/alice-project");
    expect(result.violations[0]?.path).toMatch(/^projects\.#[0-9a-f]{8}\.enabledMcpServers$/);
  });

  it("project 엔트리의 비-MCP 서브키는 churn 키로 명시하면 allowed_churn이다", () => {
    const before = { projects: { "/synthetic/projects/alice-project": { lastOpenedAt: "2026-01-01" } } };
    const after = { projects: { "/synthetic/projects/alice-project": { lastOpenedAt: "2026-01-02" } } };
    const result = claudeJsonSemanticVerdict(before, after, ["projects.*.lastOpenedAt"]);
    expect(result.overallStatus).toBe("allowed_churn");
  });

  it("동일 프로젝트 경로는 매번 같은 해시로 마스킹된다(결정적)", () => {
    const before = { projects: { "/synthetic/projects/alice-project": { lastOpenedAt: "1" } } };
    const after = { projects: { "/synthetic/projects/alice-project": { lastOpenedAt: "2" } } };
    const r1 = claudeJsonSemanticVerdict(before, after, ["projects.*.lastOpenedAt"]);
    const r2 = claudeJsonSemanticVerdict(before, after, ["projects.*.lastOpenedAt"]);
    expect(r1.changed[0]?.path).toBe(r2.changed[0]?.path);
  });

  it("변경 없음이면 clean이고 changed가 빈 배열이다", () => {
    const value = { a: 1, projects: { "/x": { mcpServers: {} } } };
    const result = claudeJsonSemanticVerdict(value, value, []);
    expect(result.overallStatus).toBe("clean");
    expect(result.changed).toEqual([]);
  });
});
