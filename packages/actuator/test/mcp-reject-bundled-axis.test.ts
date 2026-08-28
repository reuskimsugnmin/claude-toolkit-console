import { describe, expect, it } from "vitest";
import {
  BundledAssetMoveUnsupportedError,
  MCP_MOVE_REJECTED_MESSAGE,
  McpMoveRejectedError,
  assertMovableAssetKind,
} from "../src/apply/mcp-reject.js";

/**
 * actuator/test/mcp-reject-bundled-axis.test.ts — B4-a-1.
 *
 * MCP가 **독립·번들 양쪽에 살게 된 뒤** 이 판정이 두 축 모두에서 옳은지 태운다.
 * `assertMovableAssetKind`는 `kind`만 보므로 번들 여부로 갈라지지 않는데, **그것이 의도다**:
 * 번들 MCP도 `/mcp`로 토글하므로 `McpMoveRejectedError`의 처방이 그대로 맞다. `bundled_child`로
 * 바꾸면 "부모에 종속돼 이관할 수 없다"고만 말해 **빠져나갈 길을 지운다**(안전 원칙 6).
 *
 * ⚠️ 이 테스트가 없으면 다음 사람이 "MCP에 parent가 생겼는데 왜 bundled_child가 아니지?"를
 * 다시 따지거나, 놓친 것으로 오해해 바꿔 버린다. **재검토했다는 사실 자체를 고정한다.**
 */
describe("assertMovableAssetKind — MCP는 부모 유무와 무관하게 같은 처방을 준다(B4-a-1)", () => {
  it("mcp는 McpMoveRejectedError이고 메시지가 `/mcp` 경로를 준다", () => {
    expect(() => assertMovableAssetKind("mcp")).toThrow(McpMoveRejectedError);
    try {
      assertMovableAssetKind("mcp");
    } catch (err) {
      // 빠져나갈 길이 메시지에 있어야 한다 — 번들 MCP도 이 경로로 토글한다.
      expect((err as Error).message).toBe(MCP_MOVE_REJECTED_MESSAGE);
      expect((err as Error).message).toContain("/mcp");
    }
  });

  it("agent·command는 여전히 bundled_child다 — MCP와 축이 다르다(뭉개지 않았다)", () => {
    for (const kind of ["agent", "command"] as const) {
      expect(() => assertMovableAssetKind(kind)).toThrow(BundledAssetMoveUnsupportedError);
    }
  });

  it("plugin·skill만 통과한다 — 이관 대상 집합은 넓어지지 않았다", () => {
    expect(() => assertMovableAssetKind("plugin")).not.toThrow();
    expect(() => assertMovableAssetKind("skill")).not.toThrow();
  });
});
