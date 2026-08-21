import { describe, expect, it } from "vitest";
import { parseTranscriptRow } from "@ctk/core";
import { extractRow } from "../src/transcripts/extract.js";

describe("probe/transcripts/extract", () => {
  it("assistant 행 — tool_use 블록과 message.usage를 함께 추출한다", () => {
    const row = parseTranscriptRow({
      type: "assistant",
      isSidechain: false,
      sessionId: "sess-1",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: "/synthetic/project",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "demo:demo" } }],
        usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 6585, cache_read_input_tokens: 0 },
      },
      attributionSkill: "demo:demo",
      attributionPlugin: "demo",
    });
    const extracted = extractRow(row);
    expect(extracted.sessionId).toBe("sess-1");
    expect(extracted.projectPath).toBe("/synthetic/project");
    expect(extracted.toolUses).toHaveLength(1);
    expect(extracted.toolUses[0]).toMatchObject({
      toolUseId: "toolu_1",
      toolName: "Skill",
      toolInput: { skill: "demo:demo" },
      explicit: { attributionSkill: "demo:demo", attributionPlugin: "demo" },
    });
    expect(extracted.usage).toEqual({
      input_tokens: 2,
      output_tokens: 10,
      cache_creation_input_tokens: 6585,
      cache_read_input_tokens: 0,
    });
  });

  it("user 행 — 표준 표현(message.content[].tool_result)이 있으면 그것만 쓰고 레거시 toolUseResult는 중복 집계하지 않는다", () => {
    const row = parseTranscriptRow({
      type: "user",
      isSidechain: false,
      toolUseResult: { ok: true, duplicate_of_standard_form: true },
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello world" }] },
    });
    const extracted = extractRow(row);
    expect(extracted.toolResults).toHaveLength(1);
    expect(extracted.toolResults[0]).toEqual({ toolUseId: "toolu_1", text: "hello world" });
  });

  it("user 행 — 표준 표현이 없으면 레거시 toolUseResult로 폴백한다", () => {
    const row = parseTranscriptRow({
      type: "user",
      isSidechain: false,
      toolUseResult: { stdout: "legacy output" },
    });
    const extracted = extractRow(row);
    expect(extracted.toolResults).toHaveLength(1);
    expect(extracted.toolResults[0]?.text).toContain("legacy output");
  });

  it("tool_result content가 텍스트 블록 배열이면 이어붙인다", () => {
    const row = parseTranscriptRow({
      type: "user",
      isSidechain: false,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
        ],
      },
    });
    const extracted = extractRow(row);
    expect(extracted.toolResults[0]?.text).toBe("line1\nline2");
  });

  it("system 행 — tool_use/tool_result/usage 어느 것도 추출하지 않는다(빈 결과)", () => {
    const row = parseTranscriptRow({ type: "system" });
    const extracted = extractRow(row);
    expect(extracted.toolUses).toHaveLength(0);
    expect(extracted.toolResults).toHaveLength(0);
    expect(extracted.usage).toBeNull();
  });

  it("user 행 — message.content가 평문 문자열(사람이 직접 입력한 프롬프트의 표준 단축형)이어도 예외 없이 빈 결과를 낸다", () => {
    // 실측 정정(2026-08-21, 실제 트랜스크립트 -claude-toolkit-ops 프로젝트에서 재현): 문자열
    // content를 배열로 for...of 순회하면 예외 없이 개별 문자를 도는 조용한 버그가 될 뻔했다.
    const row = parseTranscriptRow({
      type: "user",
      isSidechain: false,
      message: { content: "그냥 사람이 입력한 프롬프트 텍스트" },
    });
    const extracted = extractRow(row);
    expect(extracted.toolResults).toHaveLength(0);
    expect(extracted.toolUses).toHaveLength(0);
  });

  it("assistant 행 — message.content가 문자열이어도(텍스트 전용 응답) 예외 없이 빈 tool_use 목록을 낸다", () => {
    const row = parseTranscriptRow({
      type: "assistant",
      isSidechain: false,
      message: { content: "순수 텍스트 응답" },
    });
    const extracted = extractRow(row);
    expect(extracted.toolUses).toHaveLength(0);
  });

  it("서브에이전트 행 — attributionAgent가 explicit 필드로 전달된다", () => {
    const row = parseTranscriptRow({
      type: "assistant",
      isSidechain: true,
      agentId: "abc123",
      attributionAgent: "oh-my-claudecode:critic",
      message: { content: [], usage: { input_tokens: 2, output_tokens: 3 } },
    });
    const extracted = extractRow(row);
    expect(extracted.isSidechain).toBe(true);
    expect(extracted.usage).toEqual({
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});
