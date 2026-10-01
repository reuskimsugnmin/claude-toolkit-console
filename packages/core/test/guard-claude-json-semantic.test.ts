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

describe("core/guard/claude-json-semantic — plugin enable의 pluginUsage 흔적(CLI 2.1.284 실측)", () => {
  const ID = "demo@demo-mp";
  const verdict = (before: unknown, after: unknown, id: string | null = ID) =>
    claudeJsonSemanticVerdict({ pluginUsage: before }, { pluginUsage: after }, [], id).overallStatus;

  it("기존 항목: usageCount 보존 + lastUsedAt·lastUsedNumStartups 변경은 allowed_churn", () => {
    const before = { [ID]: { usageCount: 7, lastUsedAt: 1, lastUsedNumStartups: 3 }, "other@mp": { usageCount: 2, lastUsedAt: 5 } };
    const after = { [ID]: { usageCount: 7, lastUsedAt: 999, lastUsedNumStartups: 0 }, "other@mp": { usageCount: 2, lastUsedAt: 5 } };
    expect(verdict(before, after)).toBe("allowed_churn");
  });

  it("pluginUsage 키 자체가 없다가 usageCount 0 항목 하나로 생기면 allowed_churn", () => {
    expect(
      claudeJsonSemanticVerdict({}, { pluginUsage: { [ID]: { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 0 } } }, [], ID).overallStatus,
    ).toBe("allowed_churn");
  });

  it.each([
    ["다른 플러그인 항목이 바뀜", { "other@mp": { usageCount: 2, lastUsedAt: 5 } }, { [ID]: { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 0 }, "other@mp": { usageCount: 3, lastUsedAt: 5 } }, ID],
    ["대상 항목의 usageCount가 바뀜", { [ID]: { usageCount: 7, lastUsedAt: 1 } }, { [ID]: { usageCount: 8, lastUsedAt: 9, lastUsedNumStartups: 0 } }, ID],
    ["새 항목인데 usageCount가 0이 아님", {}, { [ID]: { usageCount: 5, lastUsedAt: 9, lastUsedNumStartups: 0 } }, ID],
    ["새 항목에 모르는 필드", {}, { [ID]: { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 0, extra: 1 } }, ID],
    ["대상이 아닌 id의 흔적", {}, { "other@mp": { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 0 } }, ID],
    ["대상 항목이 지워짐", { [ID]: { usageCount: 1, lastUsedAt: 1 } }, {}, ID],
    ["신호(enabledPluginId) 없음 — 종전대로 엄격", {}, { [ID]: { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 0 } }, null],
  ])("%s → violation", (_name, before, after, id) => {
    expect(verdict(before, after, id)).toBe("violation");
  });

  it("__proto__ 같은 id여도 프로토타입 체인으로 통과하지 않는다", () => {
    expect(verdict({}, { [ID]: { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 0 } }, "__proto__")).toBe("violation");
  });
});

describe("core/guard/claude-json-semantic — 보안 심사 재현 입력(자기 키 `__proto__` · 필드 형태)", () => {
  const ID = "demo@demo-mp";
  const entry = `"${ID}":{"usageCount":0,"lastUsedAt":9,"lastUsedNumStartups":0}`;

  it("pluginUsage 안에 자기 키 __proto__:{}가 생기면 violation(대상 흔적과 함께여도)", () => {
    const after = JSON.parse(`{"pluginUsage":{${entry},"__proto__":{}}}`) as unknown;
    expect(claudeJsonSemanticVerdict({}, after, [], ID).overallStatus).toBe("violation");
  });

  it("최상위에 자기 키 __proto__:{}가 생기면 clean이 아니다", () => {
    expect(claudeJsonSemanticVerdict({}, JSON.parse(`{"__proto__":{}}`) as unknown).overallStatus).toBe("violation");
  });

  it("projects 아래 자기 키 __proto__ 프로젝트의 MCP 정의는 violation(수정 전에도 막혔다 — 회귀 방지)", () => {
    const after = JSON.parse(`{"projects":{"__proto__":{"mcpServers":{"x":{}}}}}`) as unknown;
    expect(claudeJsonSemanticVerdict({ projects: {} }, after).overallStatus).toBe("violation");
  });

  it.each([
    ["lastUsedAt가 객체", { usageCount: 0, lastUsedAt: { x: 1 }, lastUsedNumStartups: 0 }],
    ["lastUsedNumStartups가 문자열", { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: "evil" }],
    ["lastUsedNumStartups가 0이 아님", { usageCount: 0, lastUsedAt: 9, lastUsedNumStartups: 4 }],
    ["두 필드가 모두 없음", { usageCount: 0 }],
  ])("%s → violation", (_name, after) => {
    const before = { [ID]: { usageCount: 0, lastUsedAt: 1, lastUsedNumStartups: 2 } };
    expect(claudeJsonSemanticVerdict({ pluginUsage: before }, { pluginUsage: { [ID]: after } }, [], ID).overallStatus).toBe("violation");
  });
});
