import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Asset } from "@ctk/core";
import type { CatalogIndex } from "@ctk/sync";
import type { HomeContext } from "@ctk/probe";
import { classifyAssetDocState, planGenTargets } from "../src/plan.js";

function skillAsset(id: string): Asset {
  return { schema_version: 1, _scope: "machine_independent", id, kind: "skill", name: id, description: `${id} 설명` };
}

/**
 * 번들 자식 자산(결정 6) — `parent_asset_id`가 있는 agent. D2 형식(`<parent>:<kind>:<suffix>`)을
 * 따른다. `name`은 `findBundledToolPath`의 매칭 키다 — id 전체가 아니라 D2 접미사와 같아야
 * 실제 파일을 찾는다(보안 재심 L-3 처방 이후, `bundledChildSource`가 실제 원문을 읽는다).
 */
function bundledAgentAsset(id: string, parentAssetId: string, name: string): Asset {
  return {
    schema_version: 1,
    _scope: "machine_independent",
    id,
    kind: "agent",
    name,
    description: `${id} 설명`,
    parent_asset_id: parentAssetId,
  };
}

describe("gen/plan — 콘텐츠 해시 기반 증분 대상 산출", () => {
  let ctkHome: string;
  let home: HomeContext;

  afterEach(() => {
    if (ctkHome) rmSync(ctkHome, { recursive: true, force: true });
  });

  function setupSkill(name: string, description: string): void {
    const skillDir = path.join(home.ctkConfigDir, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n본문\n`);
  }

  /**
   * 디렉터리명과 frontmatter `name`을 **따로** 준다 — 실측된 중복 설치의 모양이다
   * (`~/.claude/skills/_gstack-command`와 `.../gstack`이 둘 다 `name: gstack`을 자칭했다).
   */
  function setupSkillAt(dirName: string, declaredName: string, body: string): void {
    const skillDir = path.join(home.ctkConfigDir, "skills", dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${declaredName}\ndescription: d\n---\n\n${body}\n`);
  }

  /** 번들 부모의 `installed_plugins.json` 항목을 만든다(probe/test/sources-bundled.test.ts와 동형). */
  function writeInstalledPlugin(parentId: string, installPath: string): void {
    const dir = path.join(home.ctkConfigDir, "plugins");
    mkdirSync(dir, { recursive: true });
    const registryPath = path.join(dir, "installed_plugins.json");
    let plugins: Record<string, unknown[]> = {};
    try {
      plugins = (JSON.parse(readFileSync(registryPath, "utf8")) as { plugins: Record<string, unknown[]> }).plugins;
    } catch {
      // 첫 등록.
    }
    plugins[parentId] = [
      { scope: "user", installPath, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" },
    ];
    writeFileSync(registryPath, JSON.stringify({ version: 2, plugins }), "utf8");
  }

  /** 번들 에이전트 실 파일을 만든다 — `findBundledToolPath`가 찾는 실제 위치(`<installPath>/agents/<file>.md`). */
  function writeBundledAgent(parentId: string, suffix: string): string {
    const installPath = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", parentId, "1.0.0");
    mkdirSync(path.join(installPath, "agents"), { recursive: true });
    writeFileSync(path.join(installPath, "agents", `${suffix}.md`), `---\nname: ${suffix}\n---\n\n번들 에이전트 본문\n`, "utf8");
    writeInstalledPlugin(parentId, installPath);
    return installPath;
  }

  function init(): void {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-plan-test-"));
    home = { ctkHome, ctkConfigDir: path.join(ctkHome, ".claude"), configDirExplicit: true };
    mkdirSync(home.ctkConfigDir, { recursive: true });
  }

  it("인덱스에 없는(신규) 자산은 new 사유로 대상에 들어간다", () => {
    init();
    setupSkill("demo-skill", "v1");
    const asset = skillAsset("demo-skill");
    const emptyIndex: CatalogIndex = { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] };
    const result = planGenTargets({ home, bundledParents: [], assets: [asset], index: emptyIndex });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.reason).toBe("new");
    expect(result.upToDateCount).toBe(0);
  });

  it("gen_content_sha256이 같으면 최신 상태로 건너뛴다", () => {
    init();
    setupSkill("demo-skill", "v1");
    const asset = skillAsset("demo-skill");
    // 먼저 한 번 계산해 해시를 얻고, 그 값을 인덱스에 넣어 "이미 처리됨"을 시뮬레이션한다.
    const first = planGenTargets({
      home,
      bundledParents: [],
      assets: [asset],
      index: { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] },
    });
    const sha = first.targets[0]?.sourceContentSha256;
    expect(sha).toBeDefined();

    const upToDateIndex: CatalogIndex = {
      schema_version: 1,
      assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill", gen_state: "fresh", gen_content_sha256: sha }],
    };
    const second = planGenTargets({ home, bundledParents: [], assets: [asset], index: upToDateIndex });
    expect(second.targets).toHaveLength(0);
    expect(second.upToDateCount).toBe(1);
  });

  it("원본이 바뀌면 changed 사유로 다시 대상이 된다", () => {
    init();
    setupSkill("demo-skill", "v1");
    const asset = skillAsset("demo-skill");
    const first = planGenTargets({
      home,
      bundledParents: [],
      assets: [asset],
      index: { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] },
    });
    const staleHash = first.targets[0]?.sourceContentSha256;

    // 원본 SKILL.md를 바꾼다.
    setupSkill("demo-skill", "v2 — 바뀜");

    const changedIndex: CatalogIndex = {
      schema_version: 1,
      assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill", gen_state: "fresh", gen_content_sha256: staleHash }],
    };
    const second = planGenTargets({ home, bundledParents: [], assets: [asset], index: changedIndex });
    expect(second.targets).toHaveLength(1);
    expect(second.targets[0]?.reason).toBe("changed");
  });

  it("gen_state가 stale이면 원본이 그대로여도 항상 대상에 넣는다(직전 실행 실패 잔여)", () => {
    init();
    setupSkill("demo-skill", "v1");
    const asset = skillAsset("demo-skill");
    const first = planGenTargets({
      home,
      bundledParents: [],
      assets: [asset],
      index: { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] },
    });
    const sha = first.targets[0]?.sourceContentSha256;

    const staleIndex: CatalogIndex = {
      schema_version: 1,
      assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill", gen_state: "stale", gen_content_sha256: sha }],
    };
    const result = planGenTargets({ home, bundledParents: [], assets: [asset], index: staleIndex });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.reason).toBe("stale");
  });

  it("원본도 asset.description도 없으면 unresolved(source_missing)로 분류하고 대상에 넣지 않는다", () => {
    init();
    const asset: Asset = { schema_version: 1, _scope: "machine_independent", id: "no-source", kind: "skill", name: "no-source" };
    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [asset],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.targets).toHaveLength(0);
    expect(result.unresolved).toEqual([{ assetId: "no-source", reason: "source_missing" }]);
  });

  it("maxAssets로 대상 수를 제한한다", () => {
    init();
    setupSkill("a", "a설명");
    setupSkill("b", "b설명");
    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("a"), skillAsset("b")],
      index: { schema_version: 1, assets: [] },
      maxAssets: 1,
    });
    expect(result.targets).toHaveLength(1);
  });

  // ── 회귀: 한 자산의 위생 실패가 전체 실행을 죽이지 않는다 ──────────────────────────────
  //
  // 실측(2026-08-22): 이 환경의 스킬 55개가 심볼릭 링크였고, `resolveAssetSource`가 던진
  // 예외가 그대로 위로 올라가 `ctk gen`이 **통째로** 실패했다. 거부 자체는 옳다(링크를
  // 따라가면 `~/.ssh` 내용이 카탈로그에 박힌다) — 틀린 것은 범위였다.

  function setupSymlinkedSkill(name: string, targetContent: string): void {
    const realDir = path.join(ctkHome, "elsewhere", name);
    mkdirSync(realDir, { recursive: true });
    const realFile = path.join(realDir, "SKILL.md");
    writeFileSync(realFile, targetContent);
    const skillDir = path.join(home.ctkConfigDir, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(realFile, path.join(skillDir, "SKILL.md"));
  }

  it("심볼릭 링크 자산은 건너뛰고 이유와 함께 보고된다 — 던지지 않는다", () => {
    init();
    setupSymlinkedSkill("linked-skill", "---\nname: linked-skill\n---\n본문\n");
    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("linked-skill")],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.assetId).toBe("linked-skill");
    expect(result.skipped[0]?.failureClass).toBe("path_traversal_detected");
  });

  it("링크 자산 하나가 있어도 나머지는 정상 처리된다 — 이것이 이 수정의 핵심이다", () => {
    init();
    setupSymlinkedSkill("linked-skill", "---\nname: linked-skill\n---\n본문\n");
    setupSkill("normal-a", "정상 A");
    setupSkill("normal-b", "정상 B");
    const result = planGenTargets({
      home,
      bundledParents: [],
      // 링크 자산을 **맨 앞에** 둔다 — 예전 구현이라면 첫 자산에서 죽어 뒤를 못 봤다.
      assets: [skillAsset("linked-skill"), skillAsset("normal-a"), skillAsset("normal-b")],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.targets.map((t) => t.asset.id)).toEqual(["normal-a", "normal-b"]);
    expect(result.skipped).toHaveLength(1);
  });

  it("건너뛴 자산은 '원본이 비어 있음'과 다르게 분류된다 — 사용자가 무엇을 고쳐야 할지 갈린다", () => {
    init();
    setupSymlinkedSkill("linked-skill", "본문\n");
    const result = planGenTargets({
      home,
      bundledParents: [],
      // 디렉터리가 아예 없는 자산 = empty. 링크 자산 = skipped. 둘을 뭉치지 않는다.
      assets: [skillAsset("linked-skill"), skillAsset("missing-skill")],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.skipped.map((s) => s.assetId)).toEqual(["linked-skill"]);
    expect(result.unresolved).toEqual([{ assetId: "missing-skill", reason: "source_missing" }]);
  });

  it("크기 상한 규칙도 같은 기반으로 잡힌다 — 새 위생 규칙이 다시 gen을 죽이지 않는다", () => {
    init();
    // FileHygieneError 공통 기반을 만든 이유가 이것이다. 규칙별 클래스를 나열해 잡으면
    // 규칙이 늘어날 때 그 나열을 빠뜨리고, 그 순간 새 규칙 하나가 전체 실행을 다시 죽인다.
    const skillDir = path.join(home.ctkConfigDir, "skills", "huge-skill");
    mkdirSync(skillDir, { recursive: true });
    const body = "가".repeat(120_000); // UTF-8로 360KB — 상한 200KB를 넘긴다
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: huge-skill\ndescription: 큼\n---\n\n${body}\n`);
    setupSkill("normal-a", "정상 A");

    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("huge-skill"), skillAsset("normal-a")],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.skipped.map((x) => x.assetId)).toEqual(["huge-skill"]);
    expect(result.skipped[0]?.failureClass).toBe("asset_source_too_large");
    expect(result.targets.map((t) => t.asset.id)).toEqual(["normal-a"]);
  });

  // ── H2 결합 불변식: 승인 총액이 실제 상한과 같으려면 **두 조건이 함께** 성립해야 한다 ──
  //
  // ⓐ 호출당 예산 = 총액 / max(호출수, 1)  ⓑ 실행 시 maxAssets = min(승인 maxAssets, 승인 호출수)
  //
  // 호출수가 0이면 ⓐ만으로는 안전하지 않다 — 분모 가드가 총액을 그대로 돌려주므로 호출당
  // 상한이 총액과 같아진다. 0원이 되는 진짜 이유는 ⓑ가 `maxAssets: 0`을 주고 planGenTargets가
  // 첫 자산에서 즉시 break하기 때문이다. 재심(H2)이 지적한 대로 이 결합에는 주석만 있고
  // 테스트가 없었다 — 리팩터가 ⓑ를 지우면 호출당 총액이 무제한 자산에 걸린다.

  it("maxAssets가 0이면 대상이 0건이다 — H2 안전성이 이 성질에 달려 있다", () => {
    init();
    setupSkill("a", "A");
    setupSkill("b", "B");
    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("a"), skillAsset("b")],
      index: { schema_version: 1, assets: [] },
      maxAssets: 0,
    });
    expect(result.targets).toHaveLength(0);
  });

  it("maxAssets가 양수면 그만큼만 대상이 된다 — 위 케이스가 '항상 0건'과 구분됨을 보인다", () => {
    init();
    setupSkill("a", "A");
    setupSkill("b", "B");
    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("a"), skillAsset("b")],
      index: { schema_version: 1, assets: [] },
      maxAssets: 1,
    });
    expect(result.targets).toHaveLength(1);
  });

  // ── L-b 회귀: 건너뛴 이유에 절대경로가 섞이지 않는다 ────────────────────────────────
  it("홈 **밖** 프로젝트 스킬이 거부돼도 이유에 경로가 실리지 않는다", () => {
    init();
    // 홈 상대화로는 가려지지 않는 위치를 일부러 고른다 — 이 경우가 심사 L-b의 사례다.
    const outside = path.join(ctkHome, "..", `ctk-outside-${path.basename(ctkHome)}`, "Clients", "Acme-secret");
    mkdirSync(outside, { recursive: true });
    const realFile = path.join(outside, "SKILL.md");
    writeFileSync(realFile, "---\nname: proj-skill\n---\n본문\n");
    const skillDir = path.join(home.ctkConfigDir, "skills", "proj-skill");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(realFile, path.join(skillDir, "SKILL.md"));

    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("proj-skill")],
      index: { schema_version: 1, assets: [] },
    });
    rmSync(path.dirname(path.dirname(outside)), { recursive: true, force: true });

    expect(result.skipped).toHaveLength(1);
    const reason = result.skipped[0]?.reason ?? "";
    expect(reason).not.toContain("Acme-secret");
    expect(reason).not.toMatch(/\/[A-Za-z]/); // 절대경로 조각이 남지 않는다
    expect(reason).toContain("심볼릭 링크");   // 그러면서 이유는 여전히 말해준다
  });

  it("크기 초과 이유는 경로 없이 크기만 알려준다 — 무엇을 줄여야 하는지는 남긴다", () => {
    init();
    const skillDir = path.join(home.ctkConfigDir, "skills", "huge2");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: huge2\ndescription: x\n---\n${"가".repeat(120_000)}`);
    const result = planGenTargets({
      home,
      bundledParents: [],
      assets: [skillAsset("huge2")],
      index: { schema_version: 1, assets: [] },
    });
    const reason = result.skipped[0]?.reason ?? "";
    expect(reason).toContain("바이트");
    expect(reason).not.toMatch(/\/[A-Za-z]/);
  });

  describe("스킬 링크의 봉쇄 루트는 skills/ 하나다 — 넓히면 민감 파일이 사정권에 든다", () => {
    /**
     * ⚠️ **이 테스트가 막는 것은 "넓히는 변경"이다.** 파괴 실험에서 봉쇄 루트를 `<configDir>`
     * 전체로 넓혀도 아무 테스트가 깨지지 않았다 — 그 방향이 바로 위험한 쪽인데도.
     * `<configDir>` 안에는 `.credentials.json`·`settings.json`이 있고, 그리로 링크된 SKILL.md가
     * 카탈로그 문서에 박혀 저장소로 동기화된다. 실측상 넓힐 필요도 없다(54건 전부 skills/ 안).
     */
    it("configDir 안이지만 skills/ 밖을 가리키는 링크는 거부된다", () => {
      init();
      // configDir 바로 아래의 민감 파일을 흉내낸다.
      writeFileSync(path.join(home.ctkConfigDir, "credentials.json"), '{"token":"SECRET"}');
      const dir = path.join(home.ctkConfigDir, "skills", "leaky");
      mkdirSync(dir, { recursive: true });
      symlinkSync(path.join(home.ctkConfigDir, "credentials.json"), path.join(dir, "SKILL.md"));

      const result = planGenTargets({
        home,
        bundledParents: [],
        assets: [skillAsset("leaky")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.targets, "민감 파일이 생성 대상이 됐다").toEqual([]);
      expect(result.skipped.map((s) => s.assetId)).toEqual(["leaky"]);
      expect(result.skipped[0]?.failureClass).toBe("path_traversal_detected");
    });

    /**
     * ⚠️ **디렉터리 링크 축.** 위생 검사는 `SKILL.md` **파일 하나**만 본다. 스킬 디렉터리
     * 자체가 링크이고 대상이 봉쇄 밖이면 어떻게 되는가 — 이 축을 직접 실증했다.
     *
     * 결과: `readSkillDir`의 `readdirSync(withFileTypes)`가 심볼릭 링크를 `isDirectory()`로
     * 보지 않으므로(lstat 의미) `probe`가 **아예 발견하지 못한다.** 봉쇄 검사에 도달하기 전에
     * 닫혀 있는 셈이다. 그 성질에 기대고 있으므로 여기서 고정한다 — `readSkillDir`이 나중에
     * 링크를 따라가게 바뀌면 이 테스트가 깨져 봉쇄 검사를 디렉터리 축까지 넓혀야 함을 알린다.
     */
    it("스킬 디렉터리 자체가 봉쇄 밖으로 링크돼 있으면 발견되지 않는다", () => {
      init();
      mkdirSync(path.join(home.ctkConfigDir, "skills"), { recursive: true }); // init()은 skills/를 만들지 않는다
      const outside = path.join(ctkHome, "outside-bundle");
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, "SKILL.md"), "---\nname: dirlink\ndescription: d\n---\n\n봉쇄 밖 본문\n");
      symlinkSync(outside, path.join(home.ctkConfigDir, "skills", "dirlink"));

      const result = planGenTargets({
        home,
        bundledParents: [],
        assets: [skillAsset("dirlink")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.targets, "봉쇄 밖 내용이 생성 대상이 됐다").toEqual([]);
      // 발견 자체가 안 되므로 `blocked`가 아니라 `source_missing`이다 — 두 상태의 의미가 다르다.
      expect(result.unresolved).toEqual([{ assetId: "dirlink", reason: "source_missing" }]);
    });

    /**
     * ⚠️ **보안 심사 M-4.** 봉쇄는 **스킬 경로에만** 준다 — 플러그인 원문(README·plugin.json)이
     * 링크면 지금도 거부된다. 그 성질이 코드에만 있고 게이트에 없으면, 나중에 플러그인 호출에
     * 봉쇄를 붙이는 변경이 **아무 테스트도 깨지 않고** 들어온다("가드는 호출자만큼만 강하다").
     */
    it("플러그인 원문이 링크면 봉쇄와 무관하게 거부된다 — 봉쇄는 스킬 경로에만 준다", () => {
      init();
      const installPath = path.join(ctkHome, "plugins", "demo-plugin");
      mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
      writeFileSync(path.join(installPath, ".claude-plugin", "plugin.json"), '{"name":"demo-plugin"}');
      // README를 <configDir>/skills 안(= 스킬 봉쇄 루트 안)의 파일로 링크한다.
      const inSkills = path.join(home.ctkConfigDir, "skills", "bait");
      mkdirSync(inSkills, { recursive: true });
      writeFileSync(path.join(inSkills, "README.md"), "봉쇄 안이지만 플러그인 경로다");
      symlinkSync(path.join(inSkills, "README.md"), path.join(installPath, "README.md"));
      // installed_plugins.json에 등재해 findPluginInstallPath가 찾게 한다.
      mkdirSync(path.join(home.ctkConfigDir, "plugins"), { recursive: true });
      writeFileSync(
        path.join(home.ctkConfigDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "demo-plugin": [
              { scope: "user", installPath, version: "1.0.0", installedAt: "2026-08-24T00:00:00Z", lastUpdated: "2026-08-24T00:00:00Z" },
            ],
          },
        }),
      );

      const asset: Asset = {
        schema_version: 1, _scope: "machine_independent", id: "demo-plugin", kind: "plugin", name: "demo-plugin",
      };
      const result = planGenTargets({ home, bundledParents: [], assets: [asset], index: { schema_version: 1, assets: [] } });
      expect(result.skipped.map((sk) => sk.assetId), "플러그인 링크가 통과했다").toEqual(["demo-plugin"]);
      expect(result.skipped[0]?.failureClass).toBe("path_traversal_detected");
    });

    it("skills/ 안의 다른 스킬을 가리키는 링크는 허용된다 — 실측 54건이 이 모양이다", () => {
      init();
      setupSkillAt("bundle-inner", "linked-skill", "번들 본문");
      const dir = path.join(home.ctkConfigDir, "skills", "linked-skill");
      mkdirSync(dir, { recursive: true });
      symlinkSync(
        path.join(home.ctkConfigDir, "skills", "bundle-inner", "SKILL.md"),
        path.join(dir, "SKILL.md"),
      );

      const result = planGenTargets({
        home,
        bundledParents: [],
        assets: [skillAsset("linked-skill")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.skipped, "봉쇄 안의 링크가 거부됐다").toEqual([]);
      expect(result.targets.map((t) => t.asset.id)).toEqual(["linked-skill"]);
      expect(result.targets[0]?.sections[0]?.content).toContain("번들 본문");
    });
  });

  describe("원문을 못 구한 사유를 뭉개지 않는다 — 처방이 서로 다르다", () => {
    /**
     * ⚠️ **이것이 이 수정의 핵심이다.** `findSkillDirsById`가 2건 이상을 거부하는 근거(H6)는
     * "어느 디렉터리를 **이동**시킬지 모른다"는 **쓰기 축**의 판단인데, `gen`은 읽기다.
     * 내용이 바이트 단위로 같으면 어느 쪽을 읽어도 결과가 같으므로 읽기 축에는 모호성이 없다.
     * 실측(2026-08-24): 이 환경의 중복 6건이 **전부** SKILL.md 해시 일치였고, 그 6건이
     * "원본 없음"으로 잘못 분류돼 문서 생성에서 빠져 있었다.
     */
    it("같은 이름이 두 곳에 있어도 내용이 같으면 읽어서 대상에 넣는다", () => {
      init();
      setupSkillAt("dup-a", "dup", "완전히 같은 본문");
      setupSkillAt("dup-b", "dup", "완전히 같은 본문");
      const result = planGenTargets({ home, bundledParents: [], assets: [skillAsset("dup")], index: { schema_version: 1, assets: [] } });
      expect(result.unresolved).toEqual([]);
      expect(result.targets.map((t) => t.asset.id)).toEqual(["dup"]);
      expect(result.targets[0]?.sections[0]?.content).toContain("완전히 같은 본문");
    });

    it("내용이 다르면 여전히 거부한다 — ambiguous_source이고 source_missing이 아니다", () => {
      init();
      setupSkillAt("dup-a", "dup", "본문 A");
      setupSkillAt("dup-b", "dup", "본문 B");
      const result = planGenTargets({ home, bundledParents: [], assets: [skillAsset("dup")], index: { schema_version: 1, assets: [] } });
      expect(result.targets).toEqual([]);
      expect(result.unresolved).toEqual([{ assetId: "dup", reason: "ambiguous_source", locationCount: 2 }]);
    });

    it("중복 중 하나가 심볼릭 링크면 위생 거부가 이긴다 — 안전 축에서는 가장 엄격한 판정을 취한다", () => {
      init();
      setupSkillAt("dup-a", "dup", "본문");
      const linkedDir = path.join(home.ctkConfigDir, "skills", "dup-b");
      mkdirSync(linkedDir, { recursive: true });
      const outside = path.join(ctkHome, "outside.md");
      writeFileSync(outside, "---\nname: dup\ndescription: d\n---\n\n본문\n");
      symlinkSync(outside, path.join(linkedDir, "SKILL.md"));

      const result = planGenTargets({ home, bundledParents: [], assets: [skillAsset("dup")], index: { schema_version: 1, assets: [] } });
      // 링크가 아닌 사본을 골라 우회하지 않는다.
      expect(result.targets).toEqual([]);
      expect(result.skipped.map((sk) => sk.assetId)).toEqual(["dup"]);
    });

    /**
     * 실측(2026-08-24): 이 환경의 mcp 4건·cli 2건 **전부** `description`이 비어 있다 —
     * 유형 전체가 0%다. 이것을 `source_missing`으로 분류하면 화면이 "드리프트인지 확인하라"고
     * 말하는데, **조사할 것이 없다.** 사라진 것이 아니라 애초에 그런 파일이 없다.
     */
    it("mcp·cli는 description이 없으면 no_local_source다 — 드리프트가 아니다", () => {
      init();
      const bare = (id: string, kind: "mcp" | "cli"): Asset => ({
        schema_version: 1, _scope: "machine_independent", id, kind, name: id,
      });
      const result = planGenTargets({
        home,
        bundledParents: [],
        assets: [bare("some-server", "mcp"), bare("some-cli", "cli")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.unresolved).toEqual([
        { assetId: "some-server", reason: "no_local_source" },
        { assetId: "some-cli", reason: "no_local_source" },
      ]);
    });
  });

  describe("classifyAssetDocState — 단건 조회가 일괄 산출과 갈리지 않는다", () => {
    /**
     * ⚠️ **범위 게이트다.** 화면이 말하는 사유와 `gen`이 실제로 할 일이 갈리면 그 드리프트는
     * 조용하다 — 사용자는 "생성 대기"를 보고 돈을 냈는데 gen은 그 자산을 건너뛴다. 항목이
     * 아니라 범위로 닫기 위해, **판정이 낼 수 있는 값이 전부 등장하는 픽스처**를 만들고 전
     * 자산에 대해 두 경로의 판정이 일치하는지 대조한다. 두 경로가 각자 판정하도록 되돌리면
     * 여기서 깨진다.
     *
     * ⚠️ **판정값이 늘면 표본도 함께 늘린다.** 사유가 셋으로 갈리면서(source_missing ·
     * no_local_source · ambiguous_source) 판정값이 6종에서 8종이 됐다 — 표본을 그대로 두면
     * 이 게이트는 이름만 남고 새 두 사유의 오분류를 놓친다.
     */
    it("판정값 8종이 모두 나오는 표본에서 단건 판정과 일괄 산출이 전부 일치한다", () => {
      init();

      // ① pending(new) — 원본 있고 인덱스에 해시 없음
      setupSkill("fresh-skill", "v1");
      // ② generated — 해시가 일치하도록 먼저 일괄 산출로 실제 해시를 얻어 인덱스에 넣는다
      setupSkill("done-skill", "v1");
      // ⑤ pending(changed) — 인덱스에 **다른** 해시가 박혀 있다
      setupSkill("moved-skill", "v1");
      // ⑥ pending(stale) — 직전 실행이 실패로 남긴 상태. 해시가 일치해도 대상이어야 한다
      setupSkill("stale-skill", "v1");
      // ③ source_missing — 자산은 있는데 SKILL.md가 없다
      mkdirSync(path.join(home.ctkConfigDir, "skills", "empty-skill"), { recursive: true });
      // ④ blocked — 원본이 심볼릭 링크
      const linkedDir = path.join(home.ctkConfigDir, "skills", "linked-skill");
      mkdirSync(linkedDir, { recursive: true });
      const outside = path.join(ctkHome, "outside.md");
      writeFileSync(outside, "---\nname: linked-skill\ndescription: x\n---\n본문\n");
      symlinkSync(outside, path.join(linkedDir, "SKILL.md"));
      // ⑦ ambiguous_source — 같은 이름이 두 곳에 있고 내용이 **다르다**
      setupSkillAt("dup-a", "dup-skill", "본문 A");
      setupSkillAt("dup-b", "dup-skill", "본문 B");

      const ids = [
        "fresh-skill", "done-skill", "moved-skill", "stale-skill", "empty-skill", "linked-skill", "dup-skill",
      ];
      // ⑧ no_local_source — description 없는 mcp 자산
      const bareMcp: Asset = {
        schema_version: 1, _scope: "machine_independent", id: "bare-mcp", kind: "mcp", name: "bare-mcp",
      };
      const assets = [...ids.map(skillAsset), bareMcp];

      // done-skill의 실제 해시를 얻어 "최신" 상태를 만든다 — 손으로 지어낸 해시는 판정을
      // 검증하지 못한다(픽스처가 결과를 지배해야 한다).
      const probe = planGenTargets({
        home,
        bundledParents: [],
        assets,
        index: {
          schema_version: 1,
          assets: [
            ...ids.map((id) => ({ id, kind: "skill" as const, name: id })),
            { id: "bare-mcp", kind: "mcp" as const, name: "bare-mcp" },
          ],
        },
      });
      const doneHash = probe.targets.find((t) => t.asset.id === "done-skill")?.sourceContentSha256;
      const staleHash = probe.targets.find((t) => t.asset.id === "stale-skill")?.sourceContentSha256;
      expect(doneHash).toBeDefined();
      expect(staleHash).toBeDefined();

      const index: CatalogIndex = {
        schema_version: 1,
        assets: [
          ...ids.map((id) => {
          const base = { id, kind: "skill" as const, name: id };
          // 최신 — 실제 해시와 일치
          if (id === "done-skill") return { ...base, gen_state: "fresh" as const, gen_content_sha256: doneHash };
          // 원본이 바뀜 — 해시가 다르다
          if (id === "moved-skill") return { ...base, gen_state: "fresh" as const, gen_content_sha256: "0".repeat(64) };
          // 직전 실패 — 해시가 **일치해도** stale이면 대상이어야 한다(그래야 stale 분기가 실행된다)
          if (id === "stale-skill") return { ...base, gen_state: "stale" as const, gen_content_sha256: staleHash };
          return base;
        }),
          { id: "bare-mcp", kind: "mcp" as const, name: "bare-mcp" },
        ],
      };

      const bulk = planGenTargets({ home, bundledParents: [], assets, index });
      const indexById = new Map(index.assets.map((e) => [e.id, e]));

      // 일괄 산출을 자산 id → 기대 상태로 펼친다.
      const fromBulk = new Map<string, string>();
      for (const t of bulk.targets) fromBulk.set(t.asset.id, `pending_generation:${t.reason}`);
      for (const u of bulk.unresolved) fromBulk.set(u.assetId, u.reason);
      for (const sk of bulk.skipped) fromBulk.set(sk.assetId, "blocked");
      for (const a of assets) if (!fromBulk.has(a.id)) fromBulk.set(a.id, "generated");

      // ⚠️ **표본에 오답이 가능해야 대조가 의미를 갖는다.** 처음엔 상태 4종만 넣고
      // `size === 4`로 만족했는데, 실제로 갈릴 수 있는 축은 `pending_generation`의 **세 trigger**
      // 였다 — `stale` 자산이 없으니 stale 오분류를 주입해도 게이트가 통과했다(파괴 실험으로 발견).
      // 범위가 아니라 **축**이 어긋난 경우다. 판정이 만들 수 있는 값 전체를 표본에 넣는다.
      expect([...fromBulk.values()].sort()).toEqual(
        [
          "ambiguous_source",
          "blocked",
          "generated",
          "no_local_source",
          "pending_generation:changed",
          "pending_generation:new",
          "pending_generation:stale",
          "source_missing",
        ].sort(),
      );

      for (const asset of assets) {
        const single = classifyAssetDocState(home, asset, indexById.get(asset.id));
        const flattened =
          single.kind === "pending_generation" ? `pending_generation:${single.trigger}` : single.kind;
        expect(flattened, `자산 ${asset.id}에서 단건/일괄 판정이 갈렸다`).toBe(fromBulk.get(asset.id));
      }
    });

    it("blocked의 reason에는 절대경로가 실리지 않는다(무인증 조회 채널로 나간다)", () => {
      init();
      const linkedDir = path.join(home.ctkConfigDir, "skills", "linked-skill");
      mkdirSync(linkedDir, { recursive: true });
      const outside = path.join(ctkHome, "outside.md");
      writeFileSync(outside, "---\nname: linked-skill\ndescription: x\n---\n본문\n");
      symlinkSync(outside, path.join(linkedDir, "SKILL.md"));

      const state = classifyAssetDocState(home, skillAsset("linked-skill"), undefined);
      expect(state.kind).toBe("blocked");
      if (state.kind === "blocked") {
        expect(state.reason).not.toMatch(/\/[^\s:]+/);
        expect(state.failure_class).toBe("path_traversal_detected");
      }
    });
  });


  /**
   * **정책 차단 자산은 재시도 대상이 아니다 (2026-08-26 실측).**
   *
   * 인젝션 후검증에 걸리는 자산 3건이 **매 배치마다 돈을 쓰고 매번 실패했다** — 원문이
   * `rm -rf`·`sudo` 같은 파괴적 명령을 **문서화**하고 있어서다. `stale`로 기록하면 plan이 항상
   * 다시 대상에 넣으므로 무한 재시도가 된다.
   *
   * ⚠️ **영구 차단은 아니다.** 인젝션 탐지는 확정적이지 않다(모델이 그 토큰을 인용할지가 매번
   * 다르다). 그래서 **원문이 그대로일 때만** 건너뛰고, 원문이 바뀌면 자동으로 다시 대상이 된다.
   * 이 두 축을 갈라 재지 않으면 "항상 차단"과 구분되지 않는다.
   */
  describe("planGenTargets — policy_blocked는 원문이 그대로일 때만 건너뛴다", () => {
    function planWith(genContentSha256: string | undefined, opts: { retry?: boolean } = {}) {
      return planGenTargets({
        home,
        bundledParents: [],
        assets: [skillAsset("demo-skill")],
        index: {
          schema_version: 1,
          assets: [
            { id: "demo-skill", kind: "skill", name: "demo-skill", gen_state: "policy_blocked", gen_content_sha256: genContentSha256 },
          ],
        },
        retryPolicyBlocked: opts.retry,
      });
    }
    function currentSha(): string {
      const p = planGenTargets({
        home,
        bundledParents: [],
        assets: [skillAsset("demo-skill")],
        index: { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] },
      });
      const sha = p.targets[0]?.sourceContentSha256;
      expect(sha, "기준 해시를 못 구했다").toBeDefined();
      return sha as string;
    }
    it("원문이 그대로면 대상이 아니고 사유와 함께 skipped에 남는다", () => {
      init();
      setupSkill("demo-skill", "rm -rf 를 문서화한 원문");
      const plan = planWith(currentSha());
      expect(plan.targets).toHaveLength(0);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0]?.failureClass).toBe("injection_pattern_detected");
      expect(plan.skipped[0]?.reason).toContain("--retry-blocked");
    });
    /** **축이 갈리는 입력.** 원문이 바뀌면 자동으로 다시 시도해야 한다 — 자기 치유. */
    it("원문이 바뀌면 다시 대상이 된다 (항상 차단이 아니다)", () => {
      init();
      setupSkill("demo-skill", "rm -rf 를 문서화한 원문");
      const plan = planWith("옛-해시-원문이-바뀌었다");
      expect(plan.targets, "원문이 바뀌었는데도 건너뛰었다").toHaveLength(1);
      expect(plan.skipped).toHaveLength(0);
    });
    /** 가드에는 빠져나갈 길이 있어야 한다(안전 원칙 6). */
    it("--retry-blocked면 원문이 그대로여도 다시 시도한다", () => {
      init();
      setupSkill("demo-skill", "rm -rf 를 문서화한 원문");
      const plan = planWith(currentSha(), { retry: true });
      expect(plan.targets).toHaveLength(1);
    });
  });

  // ── B1 Step 4 (결정 6) — 번들 자식은 부모를 명시해야만 대상이 된다 ─────────────────────
  //
  // 자식이 카탈로그에 들어오는 순간(Step 5) 인자 없는 `ctk gen`이 자동으로 대량 백필을
  // 시작하지 않게 문을 먼저 닫는다. 지금은 자식이 0건이라 안전하게 닫을 수 있다.
  describe("bundledParents — 번들 자식은 부모를 지정해야만 대상이 된다", () => {
    it("bundledParents가 빈 배열(기본)이면 parent_asset_id가 있는 자산은 전부 제외되고 건수가 남는다", () => {
      init();
      // 실 파일을 두지 않는다 — 이 축은 부모 지정 여부만 보고, `excludedBundled`가 걸리면
      // `judgeAsset`(원문 해석)까지 가지 않으므로 파일이 없어도 통과해야 정확한 검증이다.
      const result = planGenTargets({
        home,
        bundledParents: [],
        assets: [bundledAgentAsset("p1:child-a", "p1", "child-a"), bundledAgentAsset("p1:child-b", "p1", "child-b")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.targets).toHaveLength(0);
      expect(result.excludedBundled).toBe(2);
      // 판정(judgeAsset)까지 가지 않는다 — unresolved/skipped 어느 쪽에도 남지 않는다.
      expect(result.unresolved).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it("bundledParents에 부모를 지정하면 그 자식만 대상이 되고 다른 부모의 자식은 여전히 제외된다", () => {
      init();
      // p1 쪽은 bundledParents에 들어가므로 judgeAsset까지 도달한다 — 실제 번들 에이전트 파일을
      // 준비해야 `bundledChildSource`가 원문을 읽고 target으로 판정한다(재심 L-3 처방 이후).
      writeBundledAgent("p1", "child-a");
      const result = planGenTargets({
        home,
        bundledParents: ["p1"],
        assets: [bundledAgentAsset("p1:agent:child-a", "p1", "child-a"), bundledAgentAsset("p2:agent:child-b", "p2", "child-b")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.targets.map((t) => t.asset.id)).toEqual(["p1:agent:child-a"]);
      expect(result.excludedBundled).toBe(1); // p2:child-b만 제외됐다
    });

    it("parent_asset_id가 없는 최상위 자산은 bundledParents와 무관하게 그대로 대상이 된다(회귀)", () => {
      init();
      setupSkill("top-level", "최상위 스킬");
      const result = planGenTargets({
        home,
        bundledParents: [], // 기본값이어도 최상위 자산은 좁히지 않는다 — 좁히는 축은 번들 자식뿐.
        assets: [skillAsset("top-level")],
        index: { schema_version: 1, assets: [] },
      });
      expect(result.targets.map((t) => t.asset.id)).toEqual(["top-level"]);
      expect(result.excludedBundled).toBe(0);
    });
  });
});
