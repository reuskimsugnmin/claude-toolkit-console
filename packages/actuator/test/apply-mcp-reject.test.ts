import { describe, expect, it } from "vitest";
import {
  assertMovableAssetKind,
  CliToolMoveUnsupportedError,
  McpMoveRejectedError,
  MCP_MOVE_REJECTED_MESSAGE,
} from "../src/apply/mcp-reject.js";

describe("actuator/apply/mcp-reject — MCP·CLI 자산 이관 거부(AC-2.9)", () => {
  it("kind='mcp'는 McpMoveRejectedError를 던지고 확정된 문구를 그대로 담는다(OQ-7 안 C)", () => {
    expect(() => assertMovableAssetKind("mcp")).toThrow(McpMoveRejectedError);
    try {
      assertMovableAssetKind("mcp");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(MCP_MOVE_REJECTED_MESSAGE);
      expect((err as Error).message).toBe("v1 미지원 — MCP는 상태 조회만 가능합니다. 변경은 /mcp로 하세요.");
    }
  });

  it("kind='cli'는 CliToolMoveUnsupportedError를 던진다", () => {
    expect(() => assertMovableAssetKind("cli")).toThrow(CliToolMoveUnsupportedError);
  });

  it("kind='plugin'/'skill'은 통과한다(던지지 않는다)", () => {
    expect(() => assertMovableAssetKind("plugin")).not.toThrow();
    expect(() => assertMovableAssetKind("skill")).not.toThrow();
  });
});
