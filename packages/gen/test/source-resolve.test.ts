import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Asset } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";
import { resolveAssetSource } from "../src/source-resolve.js";
import { AssetSourceTooLargeError } from "../src/file-hygiene.js";

/**
 * gen/test/source-resolve.test.ts — 보안 재심 L-3 처방 검증.
 *
 * `resolveAssetSource`의 `case "skill"`(parent_asset_id가 있는 번들 스킬)과 `case "agent"`·
 * `"command"`(항상 번들)가 실제 원문 파일로 해석되는지, 그리고 독립 스킬 경로가 그대로인지를
 * 태운다. 픽스처는 매 테스트마다 독립 `mkdtempSync` 홈을 쓴다.
 */

function buildHome(): { home: HomeContext; ctkHome: string; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-gen-source-resolve-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(ctkConfigDir, { recursive: true });
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: true },
    ctkHome,
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

function writeInstalledPlugins(home: HomeContext, entries: Record<string, string>): void {
  const plugins: Record<string, unknown[]> = {};
  for (const [id, installPath] of Object.entries(entries)) {
    plugins[id] = [
      { scope: "user", installPath, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" },
    ];
  }
  const dir = path.join(home.ctkConfigDir, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }), "utf8");
}

function makePluginDir(home: HomeContext, name: string): string {
  const dir = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", name, "1.0.0");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBundledSkill(pluginDirAbs: string, dirName: string, frontmatterName: string | null, body = "번들 스킬 본문"): void {
  const dir = path.join(pluginDirAbs, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  const nameLine = frontmatterName === null ? "" : `name: ${frontmatterName}\n`;
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${nameLine}description: 합성 스킬\n---\n\n${body}\n`, "utf8");
}

function writeBundledFlatMd(pluginDirAbs: string, kindDir: "commands" | "agents", fileName: string, body: string): void {
  const dir = path.join(pluginDirAbs, kindDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), `---\ndescription: 합성 ${kindDir}\n---\n\n${body}\n`, "utf8");
}

function bundledAsset(kind: "skill" | "agent" | "command", parentId: string, suffix: string): Asset {
  return {
    schema_version: 1,
    _scope: "machine_independent",
    id: `${parentId}:${kind}:${suffix}`,
    kind,
    name: suffix,
    parent_asset_id: parentId,
  };
}

describe("gen/source-resolve — 번들 자식 원문 해석 (보안 재심 L-3)", () => {
  let fixture: { home: HomeContext; ctkHome: string; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it("번들 스킬 — source_missing이 아니라 실제 SKILL.md 내용으로 해석된다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeBundledSkill(pluginDir, "alpha-skill", null, "실제 스킬 본문 — L-3 검증용");

    const asset = bundledAsset("skill", "demo-plugin@synth-marketplace", "alpha-skill");
    const result = resolveAssetSource(fixture.home, asset);

    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("unreachable");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.label).toBe("SKILL.md");
    expect(result.sections[0]?.content).toContain("실제 스킬 본문 — L-3 검증용");
  });

  it("번들 에이전트 — description 한 줄이 아니라 실제 .md 파일로 해석된다(재심 S-3 처방)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeBundledFlatMd(pluginDir, "agents", "helper.md", "실제 에이전트 본문 — description이 아니다");

    const asset = bundledAsset("agent", "demo-plugin@synth-marketplace", "helper");
    const result = resolveAssetSource(fixture.home, asset);

    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("unreachable");
    expect(result.sections[0]?.content).toContain("실제 에이전트 본문 — description이 아니다");
    expect(result.sections[0]?.label).toBe("helper.md");
  });

  it("번들 커맨드 — 실제 .md 파일로 해석된다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeBundledFlatMd(pluginDir, "commands", "one.md", "실제 커맨드 본문");

    const asset = bundledAsset("command", "demo-plugin@synth-marketplace", "one");
    const result = resolveAssetSource(fixture.home, asset);

    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("unreachable");
    expect(result.sections[0]?.content).toContain("실제 커맨드 본문");
  });

  it("반대 축 — 독립 스킬(parent_asset_id 없음)의 해석 경로는 바뀌지 않는다(회귀)", () => {
    fixture = buildHome();
    const skillDir = path.join(fixture.home.ctkConfigDir, "skills", "standalone-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: standalone-skill\n---\n\n독립 스킬 본문\n", "utf8");

    const asset: Asset = {
      schema_version: 1,
      _scope: "machine_independent",
      id: "standalone-skill",
      kind: "skill",
      name: "standalone-skill",
      // parent_asset_id 없음 — 독립 스킬.
    };
    const result = resolveAssetSource(fixture.home, asset);
    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("unreachable");
    expect(result.sections[0]?.content).toContain("독립 스킬 본문");
  });

  it("경계 — 플러그인 A의 번들 스킬이 플러그인 B의 파일을 읽지 못한다(부모 스코프 격리)", () => {
    fixture = buildHome();
    const dirA = makePluginDir(fixture.home, "plugin-a");
    const dirB = makePluginDir(fixture.home, "plugin-b");
    writeInstalledPlugins(fixture.home, {
      "plugin-a@synth-marketplace": dirA,
      "plugin-b@synth-marketplace": dirB,
    });
    writeBundledSkill(dirB, "only-in-b", null, "플러그인 B 전용 내용");
    // A의 번들 스킬이라고 주장하지만 실제로는 A 안에 없다(B에만 있다).
    const asset = bundledAsset("skill", "plugin-a@synth-marketplace", "only-in-b");

    const result = resolveAssetSource(fixture.home, asset);
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.reason).toBe("source_missing");
  });

  it("경계(심볼릭 링크 주입) — A의 번들 스킬 디렉터리 안에서 SKILL.md가 B의 실제 파일을 가리켜도 내용이 새지 않는다", () => {
    fixture = buildHome();
    const dirA = makePluginDir(fixture.home, "plugin-a");
    const dirB = makePluginDir(fixture.home, "plugin-b");
    writeInstalledPlugins(fixture.home, {
      "plugin-a@synth-marketplace": dirA,
      "plugin-b@synth-marketplace": dirB,
    });
    writeBundledSkill(dirB, "victim-skill", null, "B의 비밀 내용 — 새면 안 된다");
    // A 안에 스킬 디렉터리를 만들고 그 SKILL.md만 B의 실제 파일을 가리키는 심볼릭 링크로 심는다.
    const linkedSkillDirAbs = path.join(dirA, "skills", "leak-skill");
    mkdirSync(linkedSkillDirAbs, { recursive: true });
    symlinkSync(path.join(dirB, "skills", "victim-skill", "SKILL.md"), path.join(linkedSkillDirAbs, "SKILL.md"));

    const asset = bundledAsset("skill", "plugin-a@synth-marketplace", "leak-skill");
    const result = resolveAssetSource(fixture.home, asset);
    // probe의 scanBundledSkills가 리프 심볼릭 링크를 거부하므로 애초에 후보에 오르지 않는다 —
    // "내용이 샌다"가 아니라 "못 찾는다"로 안전하게 끝난다.
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.reason).toBe("source_missing");
  });

  it("H6 — 자칭 name과 실제 디렉터리명이 다른 번들 스킬도 올바른 디렉터리에서 읽는다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeBundledSkill(pluginDir, "actual-dir-name", "claimed-name", "H6 본문 — dirName과 자칭 name이 다르다");

    const asset = bundledAsset("skill", "demo-plugin@synth-marketplace", "claimed-name");
    const result = resolveAssetSource(fixture.home, asset);
    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("unreachable");
    expect(result.sections[0]?.content).toContain("H6 본문 — dirName과 자칭 name이 다르다");
  });

  it("모호 — 같은 kind 안에서 자칭 name이 충돌하면 ambiguous_source로 판정한다(승자를 고르지 않는다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeBundledSkill(pluginDir, "dir-one", "dup-name", "내용 1");
    writeBundledSkill(pluginDir, "dir-two", "dup-name", "내용 2");

    const asset = bundledAsset("skill", "demo-plugin@synth-marketplace", "dup-name");
    const result = resolveAssetSource(fixture.home, asset);
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.reason).toBe("ambiguous_source");
    if (result.reason !== "ambiguous_source") throw new Error("unreachable");
    expect(result.locationCount).toBe(2);
  });

  it("S-3 회귀 — 번들 에이전트 원문이 200KB 상한을 초과하면 거부된다(예전엔 description 한 줄이라 상한이 걸리지 않았다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    const bigBody = "x".repeat(210_000); // DEFAULT_MAX_ASSET_SOURCE_BYTES(200_000) 초과.
    writeBundledFlatMd(pluginDir, "agents", "huge.md", bigBody);

    const asset = bundledAsset("agent", "demo-plugin@synth-marketplace", "huge");
    expect(() => resolveAssetSource(fixture.home, asset)).toThrow(AssetSourceTooLargeError);
  });

  it("못 찾음 — 부모가 아예 설치돼 있지 않으면 source_missing이다", () => {
    fixture = buildHome();
    const asset = bundledAsset("agent", "ghost-plugin@synth-marketplace", "anything");
    const result = resolveAssetSource(fixture.home, asset);
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.reason).toBe("source_missing");
  });
});
