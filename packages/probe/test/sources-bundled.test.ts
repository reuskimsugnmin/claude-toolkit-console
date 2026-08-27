import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundled, type BundledSourceResult } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled.test.ts — B1 Step 5.
 *
 * 픽스처는 매 테스트마다 독립된 `mkdtempSync` 홈을 만든다(공유 픽스처를 쓰지 않는다) — 경로
 * 순회 주입 테스트는 "주입 하나에 실행 하나"가 원칙이라 각 테스트가 자기만의 최소 트리를 짓는다.
 * 모든 값은 합성이다(CLAUDE.md — public 저장소 위생).
 */

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-bundled-"));
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

/** `<config>/plugins` 경계 안의 정상적인 플러그인 설치 디렉터리를 만든다. */
function makePluginDir(home: HomeContext, name: string): string {
  const dir = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", name, "1.0.0");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(pluginDirAbs: string, dirName: string, frontmatterName: string | null, description = "합성 스킬"): void {
  const dir = path.join(pluginDirAbs, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  const nameLine = frontmatterName === null ? "" : `name: ${frontmatterName}\n`;
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${nameLine}description: ${description}\n---\n\n# ${dirName}\n`, "utf8");
}

function writeFlatMd(pluginDirAbs: string, kindDir: "commands" | "agents", fileName: string, frontmatterName: string | null): void {
  const dir = path.join(pluginDirAbs, kindDir);
  mkdirSync(dir, { recursive: true });
  const nameLine = frontmatterName === null ? "" : `name: ${frontmatterName}\n`;
  writeFileSync(path.join(dir, fileName), `---\n${nameLine}description: 합성 ${kindDir}\n---\n\n본문\n`, "utf8");
}

describe("probe/sources/bundled — 플러그인 번들 스킬·커맨드·에이전트 편입 (B1 Step 5)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it("AC-1 유형별 건수 — 스킬 2 · 커맨드 2(+중첩 1디렉터리 2건 unmeasured) · 에이전트 1이 정확히 잡힌다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });

    writeSkill(pluginDir, "alpha-skill", null);
    writeSkill(pluginDir, "beta-skill", null);
    writeFlatMd(pluginDir, "commands", "one.md", null);
    writeFlatMd(pluginDir, "commands", "two.md", null);
    mkdirSync(path.join(pluginDir, "commands", "nested"), { recursive: true });
    writeFileSync(path.join(pluginDir, "commands", "nested", "a.md"), "---\n---\n본문", "utf8");
    writeFileSync(path.join(pluginDir, "commands", "nested", "b.md"), "---\n---\n본문", "utf8");
    writeFlatMd(pluginDir, "agents", "helper.md", null);

    const result: BundledSourceResult = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });

    const report = result.perParent.find((r) => r.parentId === "demo-plugin@synth-marketplace");
    expect(report?.state).toBe("ok");
    expect(report?.skills).toBe(2);
    expect(report?.commands).toBe(2);
    expect(report?.agents).toBe(1);
    expect(report?.nestedUnmeasured).toBe(2);

    expect(result.assets.filter((a) => a.kind === "skill").map((a) => a.id).sort()).toEqual([
      "demo-plugin@synth-marketplace:skill:alpha-skill",
      "demo-plugin@synth-marketplace:skill:beta-skill",
    ]);
    expect(result.assets.filter((a) => a.kind === "command")).toHaveLength(2);
    expect(result.assets.filter((a) => a.kind === "agent").map((a) => a.id)).toEqual([
      "demo-plugin@synth-marketplace:agent:helper",
    ]);
    // 중첩 커맨드는 자산으로 편입되지 않는다.
    expect(result.assets.some((a) => a.id.includes("nested"))).toBe(false);
    // parent_asset_id가 전부 채워진다.
    expect(result.assets.every((a) => a.parent_asset_id === "demo-plugin@synth-marketplace")).toBe(true);
  });

  it("AC-1 축 — agents/ 디렉터리 자체가 없으면 agents는 null이 아니라 0이다(다른 유형은 그대로)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "alpha-skill", null);
    // commands/agents 디렉터리를 아예 만들지 않는다.

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("ok");
    expect(report?.skills).toBe(1);
    expect(report?.commands).toBe(0);
    expect(report?.agents).toBe(0);
  });

  it("AC-1 실패 축 — installPath가 디스크에 없으면 skills/commands/agents가 0이 아니라 null이고 state는 install_path_missing이다", () => {
    fixture = buildHome();
    const missingDir = path.join(fixture.home.ctkConfigDir, "plugins", "cache", "synth-marketplace", "ghost-plugin", "1.0.0");
    writeInstalledPlugins(fixture.home, { "ghost-plugin@synth-marketplace": missingDir }); // 디렉터리를 만들지 않는다.

    const result = collectBundled({ home: fixture.home, pluginIds: ["ghost-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("install_path_missing");
    expect(report?.skills).toBeNull();
    expect(report?.commands).toBeNull();
    expect(report?.agents).toBeNull();
    expect(report?.reasons.length).toBeGreaterThan(0);
    expect(result.assets).toHaveLength(0);
  });

  it("AC-2 — 서로 다른 두 부모가 같은 이름의 스킬을 번들해도 두 id가 모두 살아남는다(네임스페이싱, 하나도 사라지지 않는다)", () => {
    fixture = buildHome();
    const dirA = makePluginDir(fixture.home, "plugin-a");
    const dirB = makePluginDir(fixture.home, "plugin-b");
    writeInstalledPlugins(fixture.home, {
      "plugin-a@synth-marketplace": dirA,
      "plugin-b@synth-marketplace": dirB,
    });
    writeSkill(dirA, "shared-name", null);
    writeSkill(dirB, "shared-name", null);

    const result = collectBundled({
      home: fixture.home,
      pluginIds: ["plugin-a@synth-marketplace", "plugin-b@synth-marketplace"],
    });
    const skillIds = result.assets.filter((a) => a.kind === "skill").map((a) => a.id).sort();
    expect(skillIds).toEqual([
      "plugin-a@synth-marketplace:skill:shared-name",
      "plugin-b@synth-marketplace:skill:shared-name",
    ]);
  });

  it("AC-4 타입 — BundledSourceResult에 installations 필드가 없다(반환값에 키 자체가 없다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "alpha-skill", null);

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    expect(Object.keys(result)).toEqual(["assets", "perParent"]);
    expect("installations" in result).toBe(false);
  });

  it("AC-8 비활성 — 부모가 어떤 settings.json에서도 활성화되지 않아도 자식은 그대로 수집된다(D6, 활성 여부를 아예 조회하지 않는다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    // settings.json을 아예 쓰지 않는다 — enabledPlugins가 없으니 이 플러그인은 어디서도 "활성"이 아니다.
    writeSkill(pluginDir, "alpha-skill", null);

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    expect(result.perParent[0]?.state).toBe("ok");
    expect(result.assets.map((a) => a.id)).toEqual(["demo-plugin@synth-marketplace:skill:alpha-skill"]);
  });

  it("경로 순회 ⓐ — installPath가 리터럴 '../../etc'(순회 문자열)면 거부되고 사유가 남는다", () => {
    fixture = buildHome();
    writeInstalledPlugins(fixture.home, { "evil-plugin@synth-marketplace": "../../etc" });

    const result = collectBundled({ home: fixture.home, pluginIds: ["evil-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("install_path_rejected");
    expect(report?.reasons.join(" ")).toMatch(/절대경로가 아니다/);
    expect(result.assets).toHaveLength(0);
  });

  it("경로 순회 ⓑ — installPath가 (순회 문자열 없이) 그냥 상대경로여도 거부된다", () => {
    fixture = buildHome();
    writeInstalledPlugins(fixture.home, { "evil-plugin@synth-marketplace": "relative/cache/evil-plugin" });

    const result = collectBundled({ home: fixture.home, pluginIds: ["evil-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("install_path_rejected");
    expect(report?.reasons.join(" ")).toMatch(/절대경로가 아니다/);
    expect(result.assets).toHaveLength(0);
  });

  it("경로 순회 ⓒ — installPath가 <config>/plugins 밖의 실재 디렉터리를 절대경로로 직접 가리키면 거부된다", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-boundary-"));
    writeInstalledPlugins(fixture.home, { "evil-plugin@synth-marketplace": outsideDir });

    const result = collectBundled({ home: fixture.home, pluginIds: ["evil-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("install_path_rejected");
    expect(result.assets).toHaveLength(0);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("경로 순회 ⓓ — installPath가 경계 안 심볼릭 링크이고 realpath가 경계 밖이면 거부된다(따라가지 않는다)", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-target-"));
    writeFileSync(path.join(outsideDir, "secret.txt"), "not for the catalog");
    const linkAbs = path.join(fixture.home.ctkConfigDir, "plugins", "cache", "synth-marketplace", "linked-plugin", "1.0.0");
    mkdirSync(path.dirname(linkAbs), { recursive: true });
    symlinkSync(outsideDir, linkAbs);
    writeInstalledPlugins(fixture.home, { "evil-plugin@synth-marketplace": linkAbs });

    const result = collectBundled({ home: fixture.home, pluginIds: ["evil-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("install_path_rejected");
    expect(result.assets).toHaveLength(0);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("경로 순회 ⓔ — 정상 부모 안에서 스킬 하위 디렉터리 하나만 경계 밖 심볼릭 링크면 그 항목만 건너뛰고 나머지는 편입된다(반대 축 — 전부 거부가 아니다)", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-skill-"));
    writeFileSync(path.join(outsideDir, "SKILL.md"), "---\nname: leaked\n---\n\n외부 파일", "utf8");
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
    symlinkSync(outsideDir, path.join(pluginDir, "skills", "linked-skill"));
    writeSkill(pluginDir, "real-skill", null); // 정상 스킬 하나는 같이 둔다 — 반대 축.

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("ok"); // 부모 전체가 거부되지 않는다 — 항목 하나만 건너뛴다.
    expect(report?.symlinksSkipped).toBe(1);
    expect(report?.skills).toBe(1); // linked-skill은 세지 않는다.
    expect(result.assets.map((a) => a.id)).toEqual(["demo-plugin@synth-marketplace:skill:real-skill"]);
    expect(result.assets.some((a) => a.description === undefined && a.id.includes("leaked"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("심볼릭 링크 — 커맨드 파일 하나가 심볼릭 링크면 건너뛰고 사유가 남는다(다른 정상 커맨드는 그대로 편입된다)", () => {
    fixture = buildHome();
    const outsideFile = path.join(mkdtempSync(path.join(tmpdir(), "ctk-outside-cmd-")), "payload.md");
    writeFileSync(outsideFile, "---\nname: payload\n---\n\n외부 파일", "utf8");
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
    symlinkSync(outsideFile, path.join(pluginDir, "commands", "linked.md"));
    writeFlatMd(pluginDir, "commands", "real.md", null);

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.symlinksSkipped).toBe(1);
    expect(report?.commands).toBe(1);
    expect(result.assets.map((a) => a.id)).toEqual(["demo-plugin@synth-marketplace:command:real"]);
    rmSync(path.dirname(outsideFile), { recursive: true, force: true });
  });

  it("자칭 name 경로 순회 — frontmatter name이 '../../evil'이면 그 항목만 건너뛰고 unsafeNamesSkipped에 잡힌다(반대 축 — 정상 name은 그대로 편입)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "evil-dir", "../../evil");
    writeSkill(pluginDir, "benign-dir", "benign-skill");

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.unsafeNamesSkipped).toBe(1);
    expect(report?.skills).toBe(1);
    expect(result.assets.map((a) => a.id)).toEqual(["demo-plugin@synth-marketplace:skill:benign-skill"]);
    // 안전하지 않은 이름이 id에 그대로 남지 않는다(경로 순회 문자열이 카탈로그에 실리지 않는다).
    expect(result.assets.some((a) => a.id.includes(".."))).toBe(false);
  });

  it("dirName과 자칭 name이 다르면 경로는 dirName을 쓰고 정체(id)는 자칭 name을 쓴다", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    // 디렉터리명은 "actual-dir-name"이지만 SKILL.md는 "claimed-name"을 자칭한다(라우터 스킬 실측 사례와 동형).
    writeSkill(pluginDir, "actual-dir-name", "claimed-name");

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    // 실제 파일을 dirName으로 읽어냈으므로(경로가 맞았으므로) description이 채워진다 = 읽기에 성공했다는 뜻.
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.id).toBe("demo-plugin@synth-marketplace:skill:claimed-name");
    expect(result.assets[0]?.id.includes("actual-dir-name")).toBe(false);
    expect(result.assets[0]?.description).toBe("합성 스킬");
  });

  it("중첩 커맨드는 자산으로 편입되지 않고 unmeasured 건수로만 보고된다(자산 목록에 나타나지 않는다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    mkdirSync(path.join(pluginDir, "commands", "tasks"), { recursive: true });
    writeFileSync(path.join(pluginDir, "commands", "tasks", "build.md"), "---\nname: build\n---\n본문", "utf8");
    writeFileSync(path.join(pluginDir, "commands", "tasks", "plan.md"), "---\nname: plan\n---\n본문", "utf8");

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.commands).toBe(0); // 평면 커맨드는 0건 — 중첩은 세지 않는다.
    expect(report?.nestedUnmeasured).toBe(2);
    expect(result.assets.filter((a) => a.kind === "command")).toHaveLength(0);
    expect(report?.reasons.some((r) => r.includes("unmeasured"))).toBe(true);
  });

  it("위생 — source_ref에 홈 절대경로 원문이 남지 않는다(정규화됨)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "alpha-skill", null);

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const asset = result.assets[0];
    expect(asset?.source_ref).not.toContain(fixture.home.ctkHome);
    expect(asset?.source_ref?.startsWith("~/")).toBe(true);
  });

  // ── 보안 심사 H-1(머지 차단) — id 축에 kind를 넣어 "같은 부모 안 kind가 다른 동명 충돌"을
  // 구조적으로 없앤다. 실측(architect): 이 머신에서 부모 66개 중 8개·64건(command+skill 48,
  // agent+skill 16) — 두 축을 각각 회귀 테스트로 못박는다.

  it("H-1 ⓐ — 같은 부모 안에서 스킬과 커맨드가 같은 이름을 자칭해도 id가 서로 다르다(command+skill 축, 실측 48건 축)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "ask", "ask");
    writeFlatMd(pluginDir, "commands", "ask.md", "ask");

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("ok"); // 죽지 않는다 — mergeAssets가 예전이라면 여기서 throw했다.
    expect(report?.duplicateNamesSkipped).toBe(0); // kind가 다르므로 "같은 kind 충돌"이 아니다.
    const ids = result.assets.map((a) => a.id).sort();
    expect(ids).toEqual(["demo-plugin@synth-marketplace:command:ask", "demo-plugin@synth-marketplace:skill:ask"]);
    expect(new Set(ids).size).toBe(ids.length); // 서로 다른 id — 하나도 사라지지 않는다.
  });

  it("H-1 ⓑ — 같은 부모 안에서 스킬과 에이전트가 같은 이름을 자칭해도 id가 서로 다르다(agent+skill 축, 실측 16건 축)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "x", "x");
    writeFlatMd(pluginDir, "agents", "x.md", "x");

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    expect(result.perParent[0]?.state).toBe("ok");
    const ids = result.assets.map((a) => a.id).sort();
    expect(ids).toEqual(["demo-plugin@synth-marketplace:agent:x", "demo-plugin@synth-marketplace:skill:x"]);
  });

  it("H-1 ⓒ — 같은 kind 안에서 자칭 name이 충돌하면 그 자식들만 건너뛰고 부모는 죽지 않는다(어느 쪽도 승자로 고르지 않는다)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    writeSkill(pluginDir, "dir-one", "dup-name");
    writeSkill(pluginDir, "dir-two", "dup-name");
    writeSkill(pluginDir, "dir-three", "safe-name"); // 반대 축 — 충돌 없는 형제는 그대로 편입된다.

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("ok"); // 부모도 스캔도 죽지 않는다(안전 원칙 6·7).
    expect(report?.duplicateNamesSkipped).toBe(2); // 충돌한 둘 다 건너뛴다 — 승자를 고르지 않는다.
    expect(report?.skills).toBe(1); // safe-name만 살아남는다.
    expect(result.assets.map((a) => a.id)).toEqual(["demo-plugin@synth-marketplace:skill:safe-name"]);
    expect(result.assets.some((a) => a.id.includes("dup-name"))).toBe(false);
    expect(report?.reasons.some((r) => r.includes("충돌"))).toBe(true);
  });

  // ── 보안 심사 M-1(머지 전 필수) — kind 디렉터리(skills/commands/agents) 자체가 심볼릭 링크이면
  // 리프 방어(scanBundledSkills·scanFlatMdKind)를 우회해 경계 밖 트리를 그대로 열거·등재한다.

  it("M-1 — skills 디렉터리 자체가 경계 밖 심볼릭 링크면 그 kind 전체를 건너뛰고(내용을 열거하지 않고) 부모는 죽지 않는다", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-kinddir-"));
    mkdirSync(path.join(outsideDir, "leaked-skill"), { recursive: true });
    writeFileSync(path.join(outsideDir, "leaked-skill", "SKILL.md"), "---\nname: leaked\n---\n\n외부 파일", "utf8");
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });
    // 리프가 아니라 kind 디렉터리 자체를 경계 밖 심볼릭 링크로 만든다.
    symlinkSync(outsideDir, path.join(pluginDir, "skills"));
    writeFlatMd(pluginDir, "commands", "real.md", null); // 반대 축 — 다른 kind는 정상 편입된다.

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("ok"); // 부모 전체가 거부되지 않는다.
    expect(report?.kindDirSymlinksSkipped).toBe(1);
    expect(report?.skills).toBe(0); // "없음"이 아니라 "거부" — symlinksSkipped와 섞지 않고 reasons가 구분한다.
    expect(report?.symlinksSkipped).toBe(0); // 리프 카운트에는 섞이지 않는다.
    expect(report?.reasons.some((r) => r.startsWith("skills/") && r.includes("심볼릭 링크"))).toBe(true);
    expect(result.assets.some((a) => a.kind === "skill")).toBe(false);
    expect(result.assets.some((a) => a.id.includes("leaked"))).toBe(false); // 외부 트리가 새지 않는다.
    expect(result.assets.some((a) => a.kind === "command" && a.id.includes("real"))).toBe(true); // 반대 축.
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // ── 보안 심사 M-2(머지 전 필수) — 거부 사유에 원문 절대경로가 남으면 scan.ts의 warnings를
  // 거쳐 브라우저 응답까지 나간다(gen/file-hygiene.ts:40-45와 동형 규칙).

  it("M-2 — installPath 거부 사유에 원문 절대경로가 남지 않는다(비식별 요약으로 대체)", () => {
    fixture = buildHome();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-outside-reason-"));
    writeInstalledPlugins(fixture.home, { "evil-plugin@synth-marketplace": outsideDir });

    const result = collectBundled({ home: fixture.home, pluginIds: ["evil-plugin@synth-marketplace"] });
    const report = result.perParent[0];
    expect(report?.state).toBe("install_path_rejected");
    const reasonText = report?.reasons.join(" ") ?? "";
    expect(reasonText).not.toContain(outsideDir); // 원문 경로 자체가 없다.
    expect(reasonText).not.toContain(fixture.home.ctkHome);
    expect(reasonText).toMatch(/밖을 가리킨다/); // 사유 자체(무엇이 문제인지)는 그대로 남는다.
    rmSync(outsideDir, { recursive: true, force: true });
  });
  // ── 보안 재심 S-1 — `:`는 id 구분자다. 접미사에 허용하면 id 인코딩이 prefix-free가 아니게
  // 되어 서로 다른 (부모, kind, 이름) 조합이 같은 문자열로 접힌다. `assertCatalogSegment`는
  // 경로 축만 보므로 이 축을 막아주지 않는다.

  it("S-1 — 자칭 name에 콜론이 있으면 그 하위 툴만 건너뛴다(id 구분자 축)", () => {
    fixture = buildHome();
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { "demo-plugin@synth-marketplace": pluginDir });

    writeSkill(pluginDir, "evil-skill", "command:x"); // 부모 id에 `:`가 있으면 접히는 형태.
    writeSkill(pluginDir, "good-skill", null); // 반대 축 — 정상은 그대로 편입된다.

    const result = collectBundled({ home: fixture.home, pluginIds: ["demo-plugin@synth-marketplace"] });
    expect(result.assets.map((a) => a.id)).toEqual(["demo-plugin@synth-marketplace:skill:good-skill"]);
    expect(result.perParent[0]?.unsafeNamesSkipped).toBe(1);
    expect(result.perParent[0]?.state).toBe("ok"); // 부모도 스캔도 죽이지 않는다.
  });

  it("S-1 — 서로 다른 (부모, kind, 이름) 조합이 같은 id로 접히지 않는다", () => {
    fixture = buildHome();
    // 부모 id 자체에 `:`가 있는 경우 — 하네스가 이것을 금지한다는 실측이 없으므로 방어한다.
    const outer = makePluginDir(fixture.home, "outer");
    const inner = makePluginDir(fixture.home, "inner");
    writeInstalledPlugins(fixture.home, {
      "p@mkt": outer,
      "p@mkt:skill": inner,
    });
    writeSkill(outer, "s", "command:x"); // p@mkt + skill + "command:x" → 접히면 p@mkt:skill:command:x
    writeFlatMd(inner, "commands", "x.md", null); // p@mkt:skill + command + x → 같은 문자열

    const result = collectBundled({ home: fixture.home, pluginIds: ["p@mkt", "p@mkt:skill"] });
    const ids = result.assets.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length); // 중복 id가 없다 — mergeAssets가 죽지 않는다.
    expect(ids).toContain("p@mkt:skill:command:x"); // 정상 쪽은 남는다(반대 축).
  });
});
