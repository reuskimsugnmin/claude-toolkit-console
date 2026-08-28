import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBundledToolPath, type BundledToolLocation } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-find.test.ts — 보안 재심 L-3 처방.
 *
 * `findBundledToolPath`가 `collectBundled`와 같은 방어(`validateInstallPath`·`isKindDirRejected`·
 * H6)를 실제로 재사용하는지, 그리고 봉쇄 루트가 **부모 단위**로 좁혀지는지를 태운다.
 * 픽스처는 매 테스트마다 독립 `mkdtempSync` 홈을 쓴다(주입 하나에 실행 하나).
 */

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-find-bundled-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(ctkConfigDir, { recursive: true });
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

function writeInstalledPlugins(home: HomeContext, entries: Record<string, string>): void {
  const plugins: Record<string, unknown[]> = {};
  for (const [id, installPath] of Object.entries(entries)) {
    plugins[id] = [
      {
        scope: "user",
        installPath,
        version: "1.0.0",
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
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

function writeSkill(pluginDirAbs: string, dirName: string, frontmatterName: string | null, body = "본문"): void {
  const dir = path.join(pluginDirAbs, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  const nameLine = frontmatterName === null ? "" : `name: ${frontmatterName}\n`;
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${nameLine}description: 합성 스킬\n---\n\n${body}\n`, "utf8");
}

function writeFlatMd(
  pluginDirAbs: string,
  kindDir: "commands" | "agents",
  fileName: string,
  frontmatterName: string | null,
  body = "본문",
): void {
  const dir = path.join(pluginDirAbs, kindDir);
  mkdirSync(dir, { recursive: true });
  const nameLine = frontmatterName === null ? "" : `name: ${frontmatterName}\n`;
  writeFileSync(path.join(dir, fileName), `---\n${nameLine}description: 합성 ${kindDir}\n---\n\n${body}\n`, "utf8");
}

/**
 * ⚠️ 보안 재심 L-1(2026-08-28) — `findBundledToolPath`의 반환이 맨 배열에서
 * `BundledToolLookup` 유니온으로 바뀌었다. **"부모 경로가 거부됐다"와 "못 찾았다"가 똑같이
 * `[]`였기 때문이다.** 아래 헬퍼는 `ok`를 단언하고 위치 배열만 꺼낸다 — 거부 축을 다루는
 * 테스트는 헬퍼를 쓰지 않고 `state`를 직접 본다.
 */
function locationsOf(lookup: ReturnType<typeof findBundledToolPath>): BundledToolLocation[] {
  if (!lookup.ok) throw new Error(`경로 검증이 실패했다(${lookup.state}) — 이 테스트의 픽스처를 의심한다`);
  return lookup.locations;
}

describe("probe/sources/bundled — findBundledToolPath (보안 재심 L-3)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it("번들 스킬 — 실제 스킬 디렉터리와 그 부모의 installPath를 봉쇄 루트로 돌려준다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "alpha-skill", null);

    const locations = locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "skill", "alpha-skill"));
    expect(locations).toHaveLength(1);
    expect(locations[0]?.absPath).toBe(path.join(pluginDir, "skills", "alpha-skill"));
    expect(locations[0]?.containmentRoot).toBe(pluginDir);
  });

  it("번들 커맨드·에이전트 — 실제 .md 파일 경로를 돌려준다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeFlatMd(pluginDir, "commands", "one.md", null);
    writeFlatMd(pluginDir, "agents", "helper.md", null);

    const cmd = locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "command", "one"));
    expect(cmd).toHaveLength(1);
    expect(cmd[0]?.absPath).toBe(path.join(pluginDir, "commands", "one.md"));

    const agent = locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "agent", "helper"));
    expect(agent).toHaveLength(1);
    expect(agent[0]?.absPath).toBe(path.join(pluginDir, "agents", "helper.md"));
  });

  it("H6 — 자칭 name과 실제 디렉터리명이 다른 스킬도 올바른 디렉터리에서 찾는다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    // 디렉터리명은 actual-dir-name, frontmatter는 claimed-name을 자칭한다(라우터 스킬 실측과 동형).
    writeSkill(pluginDir, "actual-dir-name", "claimed-name", "H6 검증용 본문");

    const byClaimedName = locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "skill", "claimed-name"));
    expect(byClaimedName).toHaveLength(1);
    expect(byClaimedName[0]?.absPath).toBe(path.join(pluginDir, "skills", "actual-dir-name"));
    // 실제 디렉터리명으로는 찾지 못한다 — 매칭 축은 자칭 name(=Asset.name)이다.
    expect(locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "skill", "actual-dir-name"))).toHaveLength(0);
  });

  it("경계 — 플러그인 A의 이름으로 플러그인 B의 스킬을 찾을 수 없다(부모 단위 격리)", () => {
    fixture = buildHome();
    const dirA = makePluginDir(fixture.home, "plugin-a");
    const dirB = makePluginDir(fixture.home, "plugin-b");
    writeInstalledPlugins(fixture.home, {
      "plugin-a@synth-marketplace": dirA,
      "plugin-b@synth-marketplace": dirB,
    });
    writeSkill(dirB, "only-in-b", null);

    expect(locationsOf(findBundledToolPath(fixture.home, "plugin-a@synth-marketplace", "skill", "only-in-b"))).toHaveLength(0);
    expect(locationsOf(findBundledToolPath(fixture.home, "plugin-b@synth-marketplace", "skill", "only-in-b"))).toHaveLength(1);
  });

  it("경계(심볼릭 링크 주입) — 플러그인 A의 번들 스킬이 심볼릭 링크로 플러그인 B(사실은 임의 경로)를 가리켜도 그 파일을 읽는 위치로 내주지 않는다", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-find-"));
    writeFileSync(path.join(outsideDir, "SKILL.md"), "---\nname: leaked\n---\n\n외부 파일", "utf8");
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
    symlinkSync(outsideDir, path.join(pluginDir, "skills", "linked-skill"));

    // scanBundledSkills가 리프 심볼릭 링크를 skip하므로 못 찾는다(0건) — leaked 내용이 새지 않는다.
    // ⚠️ 부모 installPath **자체는 정상**이므로 `ok: true` + 빈 배열이다(L-1의 거부 축과 다르다).
    expect(locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "skill", "leaked"))).toHaveLength(0);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("M-1 — kind 디렉터리 자체가 경계 밖 심볼릭 링크면 그 kind 전체에서 못 찾는다", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-kinddir-find-"));
    mkdirSync(path.join(outsideDir, "leaked-skill"), { recursive: true });
    writeFileSync(path.join(outsideDir, "leaked-skill", "SKILL.md"), "---\nname: leaked\n---\n\n외부 파일", "utf8");
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    symlinkSync(outsideDir, path.join(pluginDir, "skills"));

    expect(locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "skill", "leaked"))).toHaveLength(0);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("모호 — 같은 kind 안에서 자칭 name이 충돌하면 2건을 그대로 돌려준다(승자를 고르지 않는다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "dir-one", "dup-name");
    writeSkill(pluginDir, "dir-two", "dup-name");

    const locations = locationsOf(findBundledToolPath(fixture.home, "demo-plugin@synth-marketplace", "skill", "dup-name"));
    expect(locations).toHaveLength(2);
    expect(new Set(locations.map((l) => l.absPath)).size).toBe(2);
  });

  it("L-1 — installPath가 없는 부모는 install_path_missing이다(예외를 던지지 않고, '못 찾음'과도 다르다)", () => {
    fixture = buildHome();
    const lookup = findBundledToolPath(fixture.home, "ghost-plugin@synth-marketplace", "skill", "anything");
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.state).toBe("install_path_missing");
  });

  /**
   * ⚠️ **보안 재심 L-1** — 예전에는 이 경우도 그냥 `[]`였다. 그러면 `gen`의
   * `bundledChildSource`가 `source_missing`(= 드리프트 조사하라)으로 표시해, 오염된 플러그인의
   * **부모 1건만** "설치 경로 거부"로 뜨고 **자식 수십 건은 "원본 없음"**으로 떴다.
   * 읽기 자체는 막혀 유출이 없었지만 **사용자는 보안 사건을 드리프트로 조사한다.**
   */
  it("L-1 — installPath가 경계 밖이면 install_path_rejected다(읽지 않고, '못 찾음'으로 뭉개지도 않는다)", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-installpath-"));
    writeSkill(outsideDir, "leaked", null);
    writeInstalledPlugins(fixture.home, { "evil-plugin@synth-marketplace": outsideDir });

    const lookup = findBundledToolPath(fixture.home, "evil-plugin@synth-marketplace", "skill", "leaked");
    expect(lookup.ok, "경계 밖 경로가 성공으로 통과했다").toBe(false);
    if (lookup.ok) return;
    expect(lookup.state, "거부가 '없음'으로 뭉개졌다 — L-1 결함이 살아 있다").toBe("install_path_rejected");
    // 사유 문자열에 원문 절대경로가 실리지 않는다(M-2와 같은 계약).
    expect(lookup.reason).not.toContain(outsideDir);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
