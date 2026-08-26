import { describe, expect, it } from "vitest";
import {
  assertMovableAssetKind,
  BundledAssetMoveUnsupportedError,
  CliToolMoveUnsupportedError,
  McpMoveRejectedError,
  MCP_MOVE_REJECTED_MESSAGE,
} from "../src/apply/mcp-reject.js";

describe("actuator/apply/mcp-reject — MCP·CLI·번들 자식 자산 이관 거부(AC-2.9, B1 Step 2)", () => {
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

  // B1 Step 2 — AssetKind가 agent/command를 얻었다. 번들 자식은 부모 플러그인에 종속돼
  // 독립적으로 이관할 개념이 없다(D2) — moveSkillAsset으로 새면 actuator 인접 결함이 된다.
  it("kind='agent'/'command'는 BundledAssetMoveUnsupportedError를 던진다(moveSkillAsset으로 새지 않는다)", () => {
    expect(() => assertMovableAssetKind("agent")).toThrow(BundledAssetMoveUnsupportedError);
    expect(() => assertMovableAssetKind("command")).toThrow(BundledAssetMoveUnsupportedError);
  });
});
