import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel } from "@ctk/core";
import { UI_HTML } from "../server/ui-page.js";
import { createElClass } from "./helpers/dom-stub.js";

/**
 * 롤백 결과 화면 — .claude.json 잔여 경고(N-M1). 서빙되는 스크립트를 최소 DOM 위에서 실제로 실행한다
 * (템플릿 리터럴 안의 이스케이프·정규식이 깨지면 문자열 검사로는 못 잡는다).
 */
const El = createElClass({ textJoin: "" });
type El = InstanceType<typeof El>;

const VIEW_MODEL = JSON.parse(
  JSON.stringify(
    buildConsoleViewModel({
      machineId: "synthetic-machine", projects: [], projectsUnavailable: null, assets: [], installations: [],
      occupancy: [], usage: [], lastScanAt: null, docPresence: new Map(), unusedExpensiveLimit: 5,
      now: new Date("2026-08-22T00:00:00.000Z"),
    }),
  ),
) as unknown;

async function runRollbackWith(data: unknown): Promise<El> {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id) as El;
  };
  const fetchStub = (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url === "/api/actions" ? { ok: true, data } : VIEW_MODEL),
    });
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => el(id), createElement: (tag: string) => new El(tag), querySelectorAll: () => [], querySelector: () => new El("main") },
    location: { hash: "#token=" + "s".repeat(43), pathname: "/" },
    history: { replaceState: () => {} },
    URLSearchParams,
    fetch: fetchStub,
    console,
  };
  vm.createContext(ctx);
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(UI_HTML);
  new vm.Script(match?.[1] ?? "").runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await (ctx["runSimpleAction"] as (l: string, b: unknown) => Promise<void>)("롤백", { action: "rollback" });
  return el("action-area");
}

describe("롤백 결과 화면이 .claude.json 잔여 경고를 보여준다", () => {
  it("note가 있으면 JSON 덤프에 묻히지 않고 맨 앞에 경고로 나오며, MCP면 실패 스타일이다", async () => {
    const area = await runRollbackWith({
      asset_id: "demo@mp", action: "move_plugin_enablement",
      claude_json_status: "violation", claude_json_mcp_forbidden: true,
      claude_json_note: "MCP 서브트리 변경이 관측되었습니다 — 반드시 직접 확인하세요.",
    });
    const result = area.find("result fail");
    expect(result, "MCP 잔여는 실패 스타일").not.toBeNull();
    expect(result?.textContent.startsWith("⚠ MCP 서브트리 변경이 관측되었습니다")).toBe(true);
    expect(result?.textContent).toContain("롤백 완료");
  });

  it("note가 없으면 경고 줄이 없다 — 위 케이스가 '항상 경고'와 구분됨을 보인다", async () => {
    const area = await runRollbackWith({ asset_id: "demo@mp", action: "x", claude_json_status: "absent", claude_json_mcp_forbidden: false, claude_json_note: null });
    const result = area.find("result");
    expect(result?.textContent.startsWith("롤백 완료")).toBe(true);
    expect(result?.textContent).not.toContain("⚠");
  });
});
