import { describe, expect, it, vi } from "vitest";

const summary = vi.hoisted(() => ({
  value: {
    assetId: "demo@mp",
    action: "move_plugin_enablement",
    backupRef: "~/.ctk-backups/run1",
    journalPath: "/synthetic/journal/path.json",
    claudeJsonNote: null as string | null,
    claudeJsonStatus: "absent" as "absent" | "ok" | "violation" | "unjudgeable",
    claudeJsonMcpForbidden: false,
  },
}));

vi.mock("../src/commands/rollback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/rollback.js")>()),
  runRollback: async () => summary.value,
}));

import { createActionHandlers } from "../src/commands/web-actions.js";

describe("web 롤백 응답 — .claude.json 점검 신호를 웹까지 싣는다 (N-M1)", () => {
  it("MCP 위반 잔여가 있으면 note·status·mcp 플래그가 응답에 있다 — 그리고 절대경로(journalPath)는 여전히 없다", async () => {
    summary.value = {
      ...summary.value,
      claudeJsonNote: "MCP 서브트리 변경이 관측되었습니다 (projects.#abcd1234.mcpServers) ~/.ctk-backups/run1/config_claude_json",
      claudeJsonStatus: "violation",
      claudeJsonMcpForbidden: true,
    };
    const data = (await createActionHandlers().rollback()) as Record<string, unknown>;
    expect(data).toMatchObject({ claude_json_status: "violation", claude_json_mcp_forbidden: true });
    expect(String(data["claude_json_note"])).toContain("MCP 서브트리");
    expect(JSON.stringify(data)).not.toContain("/synthetic/journal");
  });

  it("남긴 사정이 없으면 note는 null, status는 absent다 — 위 케이스가 '항상 채움'과 구분됨을 보인다", async () => {
    summary.value = { ...summary.value, claudeJsonNote: null, claudeJsonStatus: "absent", claudeJsonMcpForbidden: false };
    const data = (await createActionHandlers().rollback()) as Record<string, unknown>;
    expect(data).toMatchObject({ claude_json_status: "absent", claude_json_note: null });
  });
});
