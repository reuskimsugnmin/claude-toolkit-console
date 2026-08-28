import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAsset, type Asset } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";
import { resolveAssetSource } from "../src/source-resolve.js";

/**
 * gen/test/source-resolve-mcp-axis.test.ts — B4-a-1.
 *
 * MCP가 **독립·번들 두 축으로 갈린 뒤**, 각 축이 제 판정을 받는지 태운다.
 *
 * ⚠️ **대조군이 핵심이다.** 번들 MCP에 원문이 생겼다고 독립 MCP까지 판정이 바뀌면,
 * `no_local_source`("유형상 원문 없음 — 드리프트가 아니다")가 붙어 있던 실측 근거
 * (mcp 4건·cli 2건 전부 description이 비어 있었다)가 무너지고 화면이 사용자에게
 * **있지도 않은 드리프트를 조사시킨다.** 보안·기능 수정이 반대 축을 죽이는 자리다.
 */

const PARENT = "demo-plugin@synth-marketplace";

function buildHome(): { home: HomeContext; pluginDir: string; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-gen-mcp-axis-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  const pluginDir = path.join(ctkConfigDir, "plugins", "cache", "synth-marketplace", "demo-plugin", "1.0.0");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(ctkConfigDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        [PARENT]: [{ scope: "user", installPath: pluginDir, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }],
      },
    }),
    "utf8",
  );
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    pluginDir,
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

/** ⚠️ `as T` 캐스팅 금지 — 실제 파서를 통과시킨다(kindConstraint가 parent 축을 강제한다). */
function bundledMcp(name: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: `${PARENT}:mcp:${name}`,
    kind: "mcp",
    name,
    parent_asset_id: PARENT,
  });
}

function standaloneMcp(name: string, description?: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: name,
    kind: "mcp",
    name,
    ...(description === undefined ? {} : { description }),
  });
}

describe("resolveAssetSource — MCP의 두 축(B4-a-1)", () => {
  let fx: ReturnType<typeof buildHome>;
  afterEach(() => fx?.cleanup());

  it("번들 MCP — `.mcp.json`에서 **그 서버 항목만** 원문으로 준다(파일 전체가 아니다)", () => {
    fx = buildHome();
    writeFileSync(
      path.join(fx.pluginDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "npx", args: ["alpha"] }, beta: { command: "uvx", args: ["beta-secret"] } } }),
      "utf8",
    );

    const r = resolveAssetSource(fx.home, bundledMcp("alpha"));
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0]?.label).toBe(".mcp.json");
    expect(r.sections[0]?.content).toContain("alpha");
    // 핵심 — 다른 서버의 정의가 섞이면 자산 정체가 흐려지고 프롬프트 비용도 서버 수만큼 곱해진다.
    expect(r.sections[0]?.content, "다른 서버 정의가 이 자산의 원문에 섞였다").not.toContain("beta-secret");
  });

  it("번들 MCP인데 `.mcp.json`이 없으면 source_missing이다 — 드리프트 조사 대상", () => {
    fx = buildHome();
    const r = resolveAssetSource(fx.home, bundledMcp("alpha"));
    expect(r).toEqual({ resolved: false, reason: "source_missing" });
  });

  it("번들 MCP인데 그 서버명이 파일에 없으면 source_missing이다", () => {
    fx = buildHome();
    writeFileSync(path.join(fx.pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "npx" } } }), "utf8");
    expect(resolveAssetSource(fx.home, bundledMcp("alpha"))).toEqual({ resolved: false, reason: "source_missing" });
  });

  it("⚠️ 대조군 — 독립 MCP는 종전 그대로다: description이 없으면 no_local_source", () => {
    fx = buildHome();
    // 실측 근거: 이 환경의 mcp 4건·cli 2건 전부 description이 비어 있었다(유형 전체 0%).
    expect(resolveAssetSource(fx.home, standaloneMcp("solo"))).toEqual({ resolved: false, reason: "no_local_source" });
  });

  it("⚠️ 대조군 — 독립 MCP에 description이 있으면 그것만 원문이다(.mcp.json을 찾지 않는다)", () => {
    fx = buildHome();
    // 부모의 .mcp.json이 존재해도 독립 MCP는 그것을 읽으면 안 된다 — 남의 파일이다.
    writeFileSync(path.join(fx.pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { solo: { command: "npx" } } }), "utf8");
    const r = resolveAssetSource(fx.home, standaloneMcp("solo", "사용자가 직접 등록한 서버"));
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sections[0]?.label).toBe("asset.description");
    expect(r.sections[0]?.content).toBe("사용자가 직접 등록한 서버");
  });
});

describe("resolveAssetSource — 번들 MCP의 자격증명은 프롬프트에 실리지 않는다(B4-a-1)", () => {
  let fx: ReturnType<typeof buildHome>;
  afterEach(() => fx?.cleanup());

  /**
   * ⚠️ **`redactMcpServerSecrets`가 옳게 동작해도 `gen`이 그것을 태우지 않으면 무의미하다**
   * (방어를 만든 것과 배선한 것은 다르다 — CLAUDE.md). 여기서는 `resolveAssetSource`가 내놓는
   * **최종 섹션 내용**에 값이 없는지를 본다.
   */
  it("env·headers의 리터럴 값이 최종 원문 섹션에 없다", () => {
    fx = buildHome();
    writeFileSync(
      path.join(fx.pluginDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: {
            command: "npx",
            args: ["-y", "alpha-server"],
            env: { ALPHA_API_KEY: "sk-live-must-not-leak" },
            headers: { Authorization: "Bearer must-not-leak-either" },
          },
        },
      }),
      "utf8",
    );

    const r = resolveAssetSource(fx.home, bundledMcp("alpha"));
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    const content = r.sections[0]?.content ?? "";

    expect(content, "env 리터럴이 프롬프트로 나갔다").not.toContain("sk-live-must-not-leak");
    expect(content, "headers 리터럴이 프롬프트로 나갔다").not.toContain("must-not-leak-either");
    // 키와 비-자격증명 필드는 남는다 — 문서가 "무엇을 요구하는 서버인가"를 말할 수 있어야 한다.
    expect(content).toContain("ALPHA_API_KEY");
    expect(content).toContain("Authorization");
    expect(content).toContain("npx");
    expect(content).toContain("alpha-server");
  });

  it("`${VAR}` 보간은 남는다 — 어떤 환경변수를 요구하는지가 사용자에게 필요한 정보다", () => {
    fx = buildHome();
    writeFileSync(
      path.join(fx.pluginDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "npx", env: { TOKEN: "${GITHUB_TOKEN}" } } } }),
      "utf8",
    );
    const r = resolveAssetSource(fx.home, bundledMcp("alpha"));
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sections[0]?.content).toContain("${GITHUB_TOKEN}");
  });
});
