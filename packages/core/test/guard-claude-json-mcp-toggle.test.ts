import { describe, expect, it } from "vitest";
import { claudeJsonSemanticVerdict, isMcpDisableToggleTouch, maskedProjectPath, type McpToggleException } from "../src/guard/claude-json-semantic.js";

/**
 * R7 Step 3 — `claudeJsonSemanticVerdict` 6번째 인자(MCP 토글 예외). 가드 규칙마다 위반 입력이 위반으로
 * 판정되는지(막는 축)와, 정확히 일치하는 입력은 통과하는지(통과 축)를 함께 본다. 입력은 전부 합성이다.
 */
const P = "/synthetic/projects/alpha";
const Q = "/synthetic/projects/beta";

const verdict = (before: unknown, after: unknown, toggle: McpToggleException | null) =>
  claudeJsonSemanticVerdict(before, after, [], null, false, toggle);
const proj = (entry: Record<string, unknown>, key = P) => ({ projects: { [key]: entry } });
const disable = (name: string): McpToggleException => ({ projectKey: P, name, op: "disable" });
const enable = (name: string): McpToggleException => ({ projectKey: P, name, op: "enable" });

describe("MCP 토글 예외 — 통과 축(정확 일치)", () => {
  it("목록이 없던 엔트리에 이름 하나를 추가하면 allowed_churn이고 마스킹 경로 하나뿐이다", () => {
    const r = verdict(proj({ allowedTools: [] }), proj({ allowedTools: [], disabledMcpServers: ["x"] }), disable("x"));
    expect(r.overallStatus).toBe("allowed_churn");
    expect(r.changed).toEqual([{ path: maskedProjectPath(P, "disabledMcpServers"), status: "allowed_churn", mcpForbidden: false }]);
  });
  it("기존 목록 끝에 추가하면 통과한다", () => {
    expect(verdict(proj({ disabledMcpServers: ["a"] }), proj({ disabledMcpServers: ["a", "x"] }), disable("x")).overallStatus).toBe("allowed_churn");
  });
  it("enable: 이름 하나를 빼면 통과하고, 마지막 하나를 빼면 []가 된다", () => {
    expect(verdict(proj({ disabledMcpServers: ["a", "x", "b"] }), proj({ disabledMcpServers: ["a", "b"] }), enable("x")).overallStatus).toBe("allowed_churn");
    expect(verdict(proj({ disabledMcpServers: ["x"] }), proj({ disabledMcpServers: [] }), enable("x")).overallStatus).toBe("allowed_churn");
  });
  it("예외 없이(null) 같은 diff는 기존대로 MCP 위반이다", () => {
    const r = verdict(proj({}), proj({ disabledMcpServers: ["x"] }), null);
    expect(r.overallStatus).toBe("violation");
    expect(r.violations[0]?.mcpForbidden).toBe(true);
  });
});

describe("MCP 토글 예외 — 막는 축(각각 위반이어야 한다)", () => {
  it("두 번째 이름이 같이 추가되면 위반", () => {
    expect(verdict(proj({}), proj({ disabledMcpServers: ["x", "y"] }), disable("x")).overallStatus).toBe("violation");
  });
  it("다른 프로젝트의 disabledMcpServers 변경은 위반", () => {
    expect(verdict({ projects: { [P]: {}, [Q]: {} } }, { projects: { [P]: {}, [Q]: { disabledMcpServers: ["x"] } } }, disable("x")).overallStatus).toBe("violation");
  });
  it("다른 MCP 서브키는 토글 모양이어도 위반 유지", () => {
    for (const sub of ["enabledMcpServers", "disabledMcpjsonServers", "enabledMcpjsonServers", "mcpServers"]) {
      const after = sub === "mcpServers" ? { x: {} } : ["x"];
      const before = sub === "mcpServers" ? {} : [];
      const r = verdict(proj({ [sub]: before }), proj({ [sub]: after }), disable("x"));
      expect(r.overallStatus, sub).toBe("violation");
      expect(r.violations[0]?.mcpForbidden, sub).toBe(true);
    }
  });
  it("순서가 바뀌면(앞에 삽입) 위반", () => {
    expect(verdict(proj({ disabledMcpServers: ["a", "b"] }), proj({ disabledMcpServers: ["x", "a", "b"] }), disable("x")).overallStatus).toBe("violation");
  });
  it("문자열이 아닌 원소는 위반 (before·after 양쪽)", () => {
    expect(verdict(proj({ disabledMcpServers: ["a"] }), proj({ disabledMcpServers: ["a", 1] }), disable("x")).overallStatus).toBe("violation");
    expect(verdict(proj({ disabledMcpServers: ["a", 1] }), proj({ disabledMcpServers: ["a", 1, "x"] }), disable("x")).overallStatus).toBe("violation");
  });
  it("이름이 이미 있는데 또 추가하면 위반 (name ∉ before)", () => {
    expect(verdict(proj({ disabledMcpServers: ["x"] }), proj({ disabledMcpServers: ["x", "x"] }), disable("x")).overallStatus).toBe("violation");
  });
  it("enable인데 이름이 없던 목록이면 위반 (name ∈ before)", () => {
    expect(verdict(proj({ disabledMcpServers: ["a"] }), proj({ disabledMcpServers: [] }), enable("x")).overallStatus).toBe("violation");
  });
  it("같은 엔트리의 형제 키가 같이 바뀌면 위반", () => {
    const r = verdict(proj({ allowedTools: [] }), proj({ allowedTools: ["t"], disabledMcpServers: ["x"] }), disable("x"));
    expect(r.overallStatus).toBe("violation");
  });
  it("방향이 틀리면 위반 (disable 예외로 제거 / enable 예외로 추가)", () => {
    expect(verdict(proj({ disabledMcpServers: ["x"] }), proj({ disabledMcpServers: [] }), disable("x")).overallStatus).toBe("violation");
    expect(verdict(proj({}), proj({ disabledMcpServers: ["x"] }), enable("x")).overallStatus).toBe("violation");
  });
  it("프로젝트 키가 before에 없으면(엔트리 생성) 예외 불성립 — 부재→{} 기본값 우회 차단", () => {
    expect(verdict({ projects: {} }, proj({ disabledMcpServers: ["x"] }), disable("x")).overallStatus).toBe("violation");
    expect(verdict({ projects: {} }, proj({ disabledMcpServers: ["x"] }), disable("x")).violations[0]?.mcpForbidden).toBe(true);
  });
  it("프로젝트 키가 after에서 사라지면 예외 불성립", () => {
    expect(verdict(proj({ disabledMcpServers: ["x"] }), { projects: {} }, enable("x")).overallStatus).toBe("violation");
  });
  it("엔트리가 plain object가 아니면 예외 불성립", () => {
    expect(verdict({ projects: { [P]: null } }, proj({ disabledMcpServers: ["x"] }), disable("x")).overallStatus).toBe("violation");
  });
  it('"__proto__" 키: JSON.parse가 만든 자기 키가 before에 없으면 예외 불성립', () => {
    const before = JSON.parse('{"projects":{}}') as unknown;
    const after = JSON.parse('{"projects":{"__proto__":{"disabledMcpServers":["x"]}}}') as unknown;
    const r = verdict(before, after, { projectKey: "__proto__", name: "x", op: "disable" });
    expect(r.overallStatus).toBe("violation");
  });
  it('"__proto__" 키가 양쪽에 자기 키로 있으면 정상 키처럼 통과한다(반대 축)', () => {
    const before = JSON.parse('{"projects":{"__proto__":{}}}') as unknown;
    const after = JSON.parse('{"projects":{"__proto__":{"disabledMcpServers":["x"]}}}') as unknown;
    expect(verdict(before, after, { projectKey: "__proto__", name: "x", op: "disable" }).overallStatus).toBe("allowed_churn");
  });
});

describe("빈 엔트리의 생성·삭제·형 변경 — 토글 옆에 숨어도 위반 (보안 심사 A M1)", () => {
  const withToggle = (extraBefore: Record<string, unknown>, extraAfter: Record<string, unknown>) =>
    verdict({ projects: { [P]: {}, ...extraBefore } }, { projects: { [P]: { disabledMcpServers: ["x"] }, ...extraAfter } }, disable("x"));
  const E = "/synthetic/projects/evil";
  const shapes: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["새 빈 엔트리 {}", {}, { [E]: {} }],
    ["새 엔트리 null", {}, { [E]: null }],
    ["새 엔트리 []", {}, { [E]: [] }],
    ["기존 빈 엔트리 삭제", { [E]: {} }, {}],
    ["빈 엔트리 → 문자열", { [E]: {} }, { [E]: "str" }],
    ["빈 엔트리 → 숫자", { [E]: {} }, { [E]: 5 }],
  ];
  for (const [label, b, a] of shapes) {
    it(label, () => {
      const r = withToggle(b, a);
      expect(r.overallStatus).toBe("violation");
      expect(r.violations.map((v) => v.path)).toEqual([maskedProjectPath(E)]);
    });
  }
  it("최상위 projects의 형 변경([]↔{})은 'projects' 위반", () => {
    expect(claudeJsonSemanticVerdict({ projects: [] }, { projects: {} }, []).violations.map((v) => v.path)).toEqual(["projects"]);
    expect(claudeJsonSemanticVerdict({ projects: {} }, { projects: [] }, []).violations.map((v) => v.path)).toEqual(["projects"]);
  });
  it("반대 축: 엔트리가 양쪽에 같으면(변화 없음) 조용하다", () => {
    expect(withToggle({ [E]: {} }, { [E]: {} }).overallStatus).toBe("allowed_churn");
  });
});

describe("isMcpDisableToggleTouch — 술어 직접", () => {
  it("before가 배열도 undefined도 아니면 false", () => {
    expect(isMcpDisableToggleTouch("x", ["x"], "x", "disable")).toBe(false);
    expect(isMcpDisableToggleTouch(null, ["x"], "x", "disable")).toBe(false);
  });
  it("enable은 before가 undefined면 false", () => {
    expect(isMcpDisableToggleTouch(undefined, [], "x", "enable")).toBe(false);
  });
});
