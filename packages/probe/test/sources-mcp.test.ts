import { writeFileSync } from "node:fs";
import path from "node:path";
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

  // 이전 테스트는 "enabledMcpServers에 이름이 있으면 일반 서버도 enabled"라는 옛 의미(AC-0.4 오독)를
  // 못박고 있었다. 실측(CLI 2.1.296, r7-prereq F1): 하네스는 computer-use 외 이름의 enabledMcpServers를
  // 읽지 않는다. fixture의 alpha-mcp(alpha)·user-mcp(beta)는 enabled 리스트에만 있다 → 상태 없음이 옳다.
  it("computer-use 외 이름이 enabledMcpServers에만 있으면 상태 신호가 아니다 (null, 새 레코드도 없음)", () => {
    fixture = buildFixtureHome();
    const result = collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set() });
    const alphaMcp = result.installations.find((i) => i.asset_id === "alpha-mcp" && i.install_scope === "project");
    expect(alphaMcp?.mcp_enabled_state).toBeNull();
    expect(alphaMcp?.mcp_state_source).toBeNull();
    expect(result.installations.some((i) => i.asset_id === "user-mcp" && i.install_scope === null)).toBe(false);
    expect(result.toggles.some((t) => t.name === "alpha-mcp" || t.name === "user-mcp")).toBe(false);
  });

  function writeProjects(projects: Record<string, unknown>): void {
    writeFileSync(
      path.join(fixture.home.ctkHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "user-mcp": { command: "true" } }, projects }, null, 2),
      "utf8",
    );
  }
  const collect = () => collectMcp({ home: fixture.home, machineId: "m1", installedPluginNames: new Set(["demo-plugin"]) });

  it("disabledMcpServers에만 있는 정의된 서버는 disabled/disabledMcpServers (user 서버는 프로젝트 단위 새 레코드)", () => {
    fixture = buildFixtureHome();
    writeProjects({ [fixture.projectAlpha]: { disabledMcpServers: ["user-mcp", "alpha-mcp"] } });
    const result = collect();
    const user = result.installations.find((i) => i.asset_id === "user-mcp" && i.install_scope === null);
    expect(user?.mcp_enabled_state).toBe("disabled");
    expect(user?.mcp_state_source).toBe("disabledMcpServers");
    const alpha = result.installations.find((i) => i.asset_id === "alpha-mcp" && i.install_scope === "project");
    expect(alpha?.mcp_enabled_state).toBe("disabled");
    expect(alpha?.mcp_state_source).toBe("disabledMcpServers");
  });

  it("양쪽 리스트에 모두 있는 이름은 disabled이고 source는 disabledMcpServers다 (both 아님)", () => {
    fixture = buildFixtureHome();
    writeProjects({ [fixture.projectAlpha]: { enabledMcpServers: ["user-mcp"], disabledMcpServers: ["user-mcp"] } });
    const result = collect();
    const states = result.installations.filter((i) => i.asset_id === "user-mcp" && i.install_scope === null);
    expect(states).toHaveLength(1);
    expect(states[0]?.mcp_enabled_state).toBe("disabled");
    expect(states[0]?.mcp_state_source).toBe("disabledMcpServers");
    expect(result.installations.some((i) => i.mcp_state_source === "both")).toBe(false);
  });

  it("computer-use는 enabledMcpServers가 신호다 — 비-Asset 토글로 enabled, disabled 리스트는 그대로 관측", () => {
    fixture = buildFixtureHome();
    writeProjects({
      [fixture.projectAlpha]: { enabledMcpServers: ["computer-use"] },
      [fixture.projectBeta]: { disabledMcpServers: ["computer-use"] },
    });
    const result = collect();
    const cu = result.toggles.filter((t) => t.name === "computer-use");
    expect(cu.map((t) => `${t.state}/${t.source_field}`).sort()).toEqual([
      "disabled/disabledMcpServers",
      "enabled/enabledMcpServers",
    ]);
  });

  it("정의 없는 이름이 enabledMcpServers에만 있으면 토글로도 남기지 않는다 (computer-use만 예외)", () => {
    fixture = buildFixtureHome();
    writeProjects({ [fixture.projectAlpha]: { enabledMcpServers: ["ghost-server", "computer-use"] } });
    const result = collect();
    expect(result.toggles.some((t) => t.name === "ghost-server")).toBe(false);
    expect(result.toggles.some((t) => t.name === "computer-use")).toBe(true);
  });

  it("플러그인 서버는 plugin:<p>:<s> 형태만 토글로 매칭된다 — 베어 서버명은 플러그인 서버가 아니다", () => {
    fixture = buildFixtureHome();
    writeProjects({ [fixture.projectAlpha]: { disabledMcpServers: ["plugin:demo-plugin:sub", "sub"] } });
    const result = collect();
    const full = result.toggles.find((t) => t.name === "plugin:demo-plugin:sub");
    expect(full?.classification_source).toBe("definition_found");
    // 베어 "sub"는 정의가 없고 plugin: 접두도 아니다 → 플러그인으로 분류되지 않는다.
    const bare = result.toggles.find((t) => t.name === "sub");
    expect(bare?.classification_source).toBe("unclassified");
    expect(result.installations.some((i) => i.asset_id.includes("sub"))).toBe(false);
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
