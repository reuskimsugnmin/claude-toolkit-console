import { afterEach, describe, expect, it } from "vitest";
import { collectMcp } from "../src/sources/mcp.js";
import { buildFixtureHome, type FixtureHome } from "./support/fixture-home.js";

describe("probe/sources/mcp — 파일 직독 전용, 결정 7 분류 (AC-0.4ⓐⓑ 실측 반영)", () => {
  let fixture: FixtureHome;
  afterEach(() => fixture?.cleanup());

  it("정의를 찾은 서버(user/local/project)는 Asset(kind:mcp)이 된다", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set() });
    const ids = result.assets.map((a) => a.id).sort();
    // fixture: 루트 mcpServers.user-mcp / projects.alpha.mcpServers.local-mcp / alpha/.mcp.json.alpha-mcp
    expect(ids).toEqual(["alpha-mcp", "local-mcp", "user-mcp"]);
    expect(result.assets.every((a) => a.kind === "mcp")).toBe(true);
  });

  it("install_scope가 정의 출처에 따라 user/local/project로 나뉜다", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set() });
    const byId = new Map(result.installations.map((i) => [`${i.asset_id}:${i.install_scope}`, i]));
    expect(byId.has("user-mcp:user")).toBe(true);
    expect(byId.has("local-mcp:local")).toBe(true);
    expect(byId.has("alpha-mcp:project")).toBe(true);
  });

  it("프로젝트 토글이 정의된 자산에 mcp_enabled_state/mcp_state_source를 채운다", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set() });
    // alpha: enabledMcpServers에 "alpha-mcp" 포함 — 자체 정의된 project 스코프 설치에 병합돼야 한다.
    const alphaMcp = result.installations.find((i) => i.asset_id === "alpha-mcp" && i.install_scope === "project");
    expect(alphaMcp?.mcp_enabled_state).toBe("enabled");
    expect(alphaMcp?.mcp_state_source).toBe("enabledMcpServers");

    // beta: enabledMcpServers에 "user-mcp"(정의는 user 스코프) — user 스코프 서버를 프로젝트
    // 단위로 토글한 케이스이므로 install_scope:null인 새 레코드가 생겨야 한다.
    const betaToggle = result.installations.find(
      (i) => i.asset_id === "user-mcp" && i.install_scope === null && i.mcp_enabled_state !== null,
    );
    expect(betaToggle?.mcp_enabled_state).toBe("enabled");
    expect(betaToggle?.mcp_state_source).toBe("enabledMcpServers");
  });

  it("정의를 못 찾은 이름은 비-Asset 토글로 남고 결정 7 분류를 따른다 (computer-use=unclassified, claude.ai=name_pattern, plugin:=definition_found 조건부)", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({
      home: fixture.home,
      machineId: "m1",
      installedPluginNames: new Set(["demo-plugin"]), // fixture의 "plugin:demo-plugin:sub" 매칭용
    });

    const assetIds = new Set(result.assets.map((a) => a.id));
    // 부정 단언(AC-1.3) — 비-Asset 후보들이 Asset 집합에 나타나지 않는다.
    expect(assetIds.has("computer-use")).toBe(false);
    expect(assetIds.has("claude.ai Demo Connector")).toBe(false);
    expect(assetIds.has("plugin:demo-plugin:sub")).toBe(false);

    const computerUse = result.toggles.find((t) => t.name === "computer-use");
    expect(computerUse?.classification_source).toBe("unclassified");
    expect(computerUse?.state).toBe("enabled");
    expect(computerUse?.source_field).toBe("enabledMcpServers");

    const connector = result.toggles.find((t) => t.name === "claude.ai Demo Connector");
    expect(connector?.classification_source).toBe("name_pattern");
    expect(connector?.state).toBe("disabled");

    const pluginSub = result.toggles.find((t) => t.name === "plugin:demo-plugin:sub");
    expect(pluginSub?.classification_source).toBe("definition_found");
  });

  it("설치된 플러그인 이름 집합에 없는 plugin: 접두 항목은 unclassified로 방어적으로 남는다", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set() /* 비어있음 */ });
    const pluginSub = result.toggles.find((t) => t.name === "plugin:demo-plugin:sub");
    expect(pluginSub?.classification_source).toBe("unclassified");
  });

  it("모든 toggle 레코드는 __kind:'toggle' 판별 필드를 갖는다(Asset과 타입 수준 분리, 착수 조건 C4)", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set() });
    expect(result.toggles.length).toBeGreaterThan(0);
    expect(result.toggles.every((t) => t.__kind === "toggle")).toBe(true);
  });
});
