import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundled, type BundledSourceResult } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-mcp-hooks.test.ts — B4-a-1.
 *
 * `.mcp.json`(번들 MCP → Asset)과 `hooks/`(건수만, Asset 아님 — 「결정 7」 유지)를 태운다.
 *
 * ⚠️ **실측에서 나온 세 형태를 모두 태운다.** 특히 **추가 최상위 키를 가진 래퍼형**(실측 14건 중
 * 3건, `recommendedCategories`)은 정본에 적혀 있던 옛 판별 규칙이 평면형으로 오분류하던 축이고,
 * 그 규칙을 따르면 `mcpServers`·`recommendedCategories`가 **서버 이름으로 둔갑해 쓰레기 자산**이 된다.
 */

const PARENT = "demo-plugin@synth-marketplace";

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-bundled-mcp-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(ctkConfigDir, { recursive: true });
  return { home: { ctkHome, ctkConfigDir, configDirExplicit: false }, cleanup: () => rmSync(ctkHome, { recursive: true, force: true }) };
}

function makePluginDir(home: HomeContext): string {
  const dir = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", "demo-plugin", "1.0.0");
  mkdirSync(dir, { recursive: true });
  const reg = path.join(home.ctkConfigDir, "plugins");
  mkdirSync(reg, { recursive: true });
  writeFileSync(
    path.join(reg, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        [PARENT]: [{ scope: "user", installPath: dir, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }],
      },
    }),
    "utf8",
  );
  return dir;
}

function collect(home: HomeContext): { result: BundledSourceResult; mcpNames: string[]; report: NonNullable<BundledSourceResult["perParent"][number]> } {
  const result = collectBundled({ home, pluginIds: [PARENT] });
  const report = result.perParent.find((r) => r.parentId === PARENT);
  if (report === undefined) throw new Error("부모 리포트가 없다 — 픽스처를 의심한다");
  return { result, mcpNames: result.assets.filter((a) => a.kind === "mcp").map((a) => a.name).sort(), report };
}

describe("probe/sources/bundled — 번들 MCP 편입(B4-a-1)", () => {
  let fx: { home: HomeContext; cleanup: () => void };
  afterEach(() => fx?.cleanup());

  it("래퍼형 — mcpServers 안의 서버가 `<부모id>:mcp:<서버명>` 자산이 된다", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: "npx" }, beta: { command: "uvx" } } }), "utf8");

    const { result, mcpNames, report } = collect(fx.home);
    expect(mcpNames).toEqual(["alpha", "beta"]);
    expect(report.mcpServers).toBe(2);
    const alpha = result.assets.find((a) => a.kind === "mcp" && a.name === "alpha");
    expect(alpha?.id).toBe(`${PARENT}:mcp:alpha`);
    expect(alpha?.parent_asset_id).toBe(PARENT);
  });

  it("⚠️ 추가 최상위 키를 가진 래퍼형도 래퍼형이다 — 추가 키가 서버로 둔갑하지 않는다(실측 3건)", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "npx" } }, recommendedCategories: ["docs"] }),
      "utf8",
    );

    const { mcpNames, report } = collect(fx.home);
    expect(mcpNames, "추가 키가 서버 이름으로 편입됐다 — 옛 판별 규칙의 결함이다").toEqual(["alpha"]);
    expect(mcpNames).not.toContain("recommendedCategories");
    expect(mcpNames).not.toContain("mcpServers");
    expect(report.mcpServers).toBe(1);
    // 무시한 키를 조용히 버리지 않는다 — 하네스가 형태를 바꾸면 여기가 먼저 커진다.
    expect(report.reasons.some((r) => r.includes("서버가 아닌 최상위 키"))).toBe(true);
  });

  it("평면형 — 최상위 키가 곧 서버다(실측 3건)", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ solo: { command: "npx" } }), "utf8");
    expect(collect(fx.home).mcpNames).toEqual(["solo"]);
  });

  it("`.mcp.json`이 없으면 0건이다 — '읽지 못했다'가 아니다", () => {
    fx = buildHome();
    makePluginDir(fx.home);
    const { mcpNames, report } = collect(fx.home);
    expect(mcpNames).toEqual([]);
    expect(report.mcpServers, "없음을 미측정(null)으로 보고했다").toBe(0);
  });

  it("형태가 깨지면 null이다 — 빈 결과(0건)로 삼키지 않는다", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: "oops" }), "utf8");
    const { mcpNames, report } = collect(fx.home);
    expect(mcpNames).toEqual([]);
    expect(report.mcpServers, "형태 오류를 0건으로 삼켰다 — '없음'과 '실패'가 뭉개졌다").toBeNull();
    expect(report.reasons.some((r) => r.includes(".mcp.json"))).toBe(true);
  });

  it("`.mcp.json`이 심볼릭 링크면 따라가지 않고 null이다", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    const outside = mkdtempSync(path.join(tmpdir(), "ctk-outside-mcp-"));
    writeFileSync(path.join(outside, "evil.json"), JSON.stringify({ leaked: { command: "cat /etc/passwd" } }), "utf8");
    symlinkSync(path.join(outside, "evil.json"), path.join(dir, ".mcp.json"));

    const { mcpNames, report } = collect(fx.home);
    expect(mcpNames, "링크를 따라가 경계 밖 정의를 편입했다").toEqual([]);
    expect(report.mcpServers).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("서버명이 안전한 세그먼트가 아니면 그 서버만 건너뛴다 — 부모 전체를 죽이지 않는다", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "../escape": { command: "x" }, ok: { command: "y" } } }), "utf8");
    const { mcpNames, report } = collect(fx.home);
    expect(mcpNames).toEqual(["ok"]);
    expect(report.reasons.some((r) => r.includes("안전한 카탈로그 세그먼트"))).toBe(true);
  });
});

describe("probe/sources/bundled — 훅은 건수만 센다(「결정 7」 유지)", () => {
  let fx: { home: HomeContext; cleanup: () => void };
  afterEach(() => fx?.cleanup());

  it("hooks/ 항목 수를 세되 **Asset은 만들지 않는다**", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    mkdirSync(path.join(dir, "hooks"), { recursive: true });
    writeFileSync(path.join(dir, "hooks", "pre.sh"), "#!/bin/sh\n", "utf8");
    writeFileSync(path.join(dir, "hooks", "post.sh"), "#!/bin/sh\n", "utf8");

    const { result, report } = collect(fx.home);
    expect(report.hooks).toBe(2);
    // 핵심 — 훅은 자동 발동이라 "사람이 명시적으로 지시한다"(문제 1)의 대상이 아니다.
    expect(result.assets.map((a) => a.kind), "훅이 Asset으로 편입됐다 — 「결정 7」을 어겼다").not.toContain("hook");
    expect(result.assets).toHaveLength(0);
  });

  it("hooks/ 가 없으면 0이다 — 미측정(null)이 아니다", () => {
    fx = buildHome();
    makePluginDir(fx.home);
    expect(collect(fx.home).report.hooks).toBe(0);
  });

  it("hooks/ 가 심볼릭 링크면 null이다 — 0건과 구별한다", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    const outside = mkdtempSync(path.join(tmpdir(), "ctk-outside-hooks-"));
    mkdirSync(path.join(outside, "h"), { recursive: true });
    symlinkSync(path.join(outside, "h"), path.join(dir, "hooks"));

    const { report } = collect(fx.home);
    expect(report.hooks, "링크된 hooks/를 세어 0건과 뭉갰다").toBeNull();
    expect(report.reasons.some((r) => r.includes("hooks/"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it("hooks/ 가 FIFO면 null이다(디렉터리가 아니다)", () => {
    fx = buildHome();
    const dir = makePluginDir(fx.home);
    execFileSync("mkfifo", [path.join(dir, "hooks")]);
    expect(collect(fx.home).report.hooks).toBeNull();
  });
});
