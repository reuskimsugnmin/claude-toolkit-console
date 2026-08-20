import { describe, expect, it } from "vitest";
import {
  parseInstalledPluginsFile,
  parseSettingsFile,
  parseClaudeJsonFile,
  parseMcpJsonFile,
  parseCatalogConfig,
  parseLocalConfig,
} from "../src/index.js";

describe("harness/installed-plugins.schema — 실측 형태(passthrough, 필수 필드만 강제)", () => {
  it("user/project/local 스코프 엔트리를 파싱한다(local·project만 projectPath 보유)", () => {
    const raw = {
      version: 2,
      plugins: {
        "demo@mp": [
          { scope: "user", installPath: "/x", version: "1.0.0", installedAt: "t", lastUpdated: "t" },
          { scope: "local", installPath: "/y", version: "1.0.0", installedAt: "t", lastUpdated: "t", projectPath: "/proj" },
        ],
      },
    };
    const parsed = parseInstalledPluginsFile(raw);
    expect(parsed.plugins["demo@mp"]).toHaveLength(2);
  });

  it("알 수 없는 최상위 키가 있어도 passthrough라 실패하지 않는다(R13 드리프트 내성)", () => {
    expect(() => parseInstalledPluginsFile({ version: 2, plugins: {}, futureKey: true })).not.toThrow();
  });

  it("scope가 4번째 값이면 실패한다(strict 열거값)", () => {
    const raw = { plugins: { x: [{ scope: "org", installPath: "/x", version: "1", installedAt: "t", lastUpdated: "t" }] } };
    expect(() => parseInstalledPluginsFile(raw)).toThrow();
  });
});

describe("harness/settings-file.schema — enabledPlugins만 강제, 나머지는 passthrough", () => {
  it("enabledPlugins의 {id: boolean} 형태를 파싱한다(결정 6 실측)", () => {
    const parsed = parseSettingsFile({ enabledPlugins: { "demo@mp": true, "other@mp": false }, someOtherKey: 1 });
    expect(parsed.enabledPlugins).toEqual({ "demo@mp": true, "other@mp": false });
  });

  it("enabledPlugins 없이도 통과한다(선택 필드)", () => {
    expect(() => parseSettingsFile({})).not.toThrow();
  });
});

describe("harness/claude-json.schema — MCP 소스로 쓰는 부분만 강제", () => {
  it("루트 mcpServers + projects.<path>의 5개 필드를 파싱한다(AC-0.4 실측 형)", () => {
    const parsed = parseClaudeJsonFile({
      mcpServers: { "user-mcp": {} },
      projects: {
        "/proj": {
          mcpServers: { "local-mcp": {} },
          enabledMcpServers: ["computer-use"],
          disabledMcpServers: ["claude.ai Demo"],
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
        },
      },
      unrelatedHarnessKey: "whatever",
    });
    expect(Object.keys(parsed.mcpServers ?? {})).toEqual(["user-mcp"]);
    expect(parsed.projects?.["/proj"]?.enabledMcpServers).toEqual(["computer-use"]);
  });
});

describe("harness/mcp-json.schema — 프로젝트 .mcp.json", () => {
  it("mcpServers를 파싱한다", () => {
    expect(parseMcpJsonFile({ mcpServers: { x: {} } }).mcpServers).toEqual({ x: {} });
  });
});

describe("schema/catalog-config — <catalog>/ctk.config.json vs ~/.config/ctk/config.json 분리", () => {
  it("CatalogConfig는 catalog_path 필드를 갖지 않는다(§1.3 결정 2 — 카탈로그 자기 경로 원문 금지)", () => {
    const parsed = parseCatalogConfig({
      schema_version: 1,
      verified_cli_version: "2.1.237 (Claude Code)",
      offset_cache_location: "catalog",
    });
    expect("catalog_path" in parsed).toBe(false);
    expect(() =>
      parseCatalogConfig({
        schema_version: 1,
        verified_cli_version: "x",
        offset_cache_location: "catalog",
        catalog_path: "/should/not/be/here",
      }),
    ).toThrow(); // strict — 예상 밖 키는 거부
  });

  it("LocalConfig는 catalog_path를 필수로 갖는다(카탈로그 밖 로컬 전용 파일)", () => {
    const parsed = parseLocalConfig({ schema_version: 1, catalog_path: "/synthetic/catalog" });
    expect(parsed.catalog_path).toBe("/synthetic/catalog");
  });
});
