import { describe, expect, it } from "vitest";
import { attribute, type AttributionInput } from "../src/usage/attribution.js";

/**
 * core/test/usage-attribution.test.ts — AC-4.1 "합성 트랜스크립트 픽스처에서 call_count가 귀속
 * 우선순위대로 산출" 대응. attribute()는 순수 함수이므로 여기서는 트랜스크립트 파싱 없이
 * 이미 추출된 입력 형태로 직접 단언한다(probe/transcripts 통합 테스트는 별도).
 */
describe("usage/attribution — 3단 우선순위 귀속 규칙", () => {
  it("① harness_field — attributionSkill이 있으면 최우선으로 귀속된다", () => {
    const input: AttributionInput = {
      toolName: "Skill",
      toolInput: { skill: "demo-plugin:demo-skill" },
      explicit: { attributionSkill: "demo-plugin:demo-skill", attributionPlugin: "demo-plugin" },
    };
    const result = attribute(input);
    expect(result).toEqual({
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionSkill",
      kind: "skill",
      ref: "demo-plugin:demo-skill",
    });
  });

  it("① harness_field — attributionAgent가 있으면 agent로 귀속된다", () => {
    const result = attribute({
      toolName: "Agent",
      toolInput: { subagent_type: "general-purpose" },
      explicit: { attributionAgent: "oh-my-claudecode:critic" },
    });
    expect(result.attribution_source).toBe("harness_field");
    expect(result.attribution_rule).toBe("harness_field:attributionAgent");
    expect(result.kind).toBe("agent");
    expect(result.ref).toBe("oh-my-claudecode:critic");
  });

  it("② prefix_rule — attribution* 필드가 없으면 Skill tool_use의 input.skill로 귀속된다(bare-name)", () => {
    const result = attribute({ toolName: "Skill", toolInput: { skill: "loose-skill" }, explicit: undefined });
    expect(result).toEqual({
      attribution_source: "prefix_rule",
      attribution_rule: "prefix_rule:skill_tool_input",
      kind: "skill",
      ref: "loose-skill",
    });
  });

  it("② prefix_rule — mcp__<server>__<tool> 접두로 MCP 자산에 귀속된다", () => {
    const result = attribute({ toolName: "mcp__notebooklm__add_notebook", toolInput: {}, explicit: undefined });
    expect(result).toEqual({
      attribution_source: "prefix_rule",
      attribution_rule: "prefix_rule:mcp_tool",
      kind: "mcp",
      ref: "notebooklm",
    });
  });

  it("② prefix_rule — mcp__plugin_<...>__<tool> 접두로 plugin 자산에 귀속된다(세그먼트 전체를 ref로)", () => {
    const result = attribute({
      toolName: "mcp__plugin_oh-my-claudecode_t__ast_grep_search",
      toolInput: {},
      explicit: undefined,
    });
    expect(result).toEqual({
      attribution_source: "prefix_rule",
      attribution_rule: "prefix_rule:mcp_plugin_tool",
      kind: "plugin",
      ref: "oh-my-claudecode_t",
    });
  });

  it("② prefix_rule — Agent tool_use의 input.subagent_type으로 귀속된다", () => {
    const result = attribute({
      toolName: "Agent",
      toolInput: { subagent_type: "oh-my-claudecode:executor" },
      explicit: undefined,
    });
    expect(result).toEqual({
      attribution_source: "prefix_rule",
      attribution_rule: "prefix_rule:agent_subagent_type",
      kind: "agent",
      ref: "oh-my-claudecode:executor",
    });
  });

  it("③ unattributed — 어느 규칙에도 걸리지 않으면 null + unattributed다(임의 배분 금지, AC-4.7)", () => {
    const result = attribute({ toolName: "Read", toolInput: { file_path: "/tmp/x" }, explicit: undefined });
    expect(result).toEqual({
      attribution_source: "unattributed",
      attribution_rule: "none",
      kind: null,
      ref: null,
    });
  });

  it("③ unattributed — Bash 명령은 OQ-3 미결에 따라 v1에서 귀속하지 않는다(구현자가 임의 결정하지 않음)", () => {
    const result = attribute({ toolName: "Bash", toolInput: { command: "claude --version" }, explicit: undefined });
    expect(result.attribution_source).toBe("unattributed");
    expect(result.kind).toBeNull();
  });

  it("explicit 필드가 있어도 값이 빈 문자열이면 무시하고 prefix_rule로 폴백한다", () => {
    const result = attribute({
      toolName: "Skill",
      toolInput: { skill: "loose-skill" },
      explicit: { attributionSkill: "" },
    });
    expect(result.attribution_source).toBe("prefix_rule");
  });
});
