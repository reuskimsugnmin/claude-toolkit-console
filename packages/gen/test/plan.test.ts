import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Asset } from "@ctk/core";
import type { CatalogIndex } from "@ctk/sync";
import type { HomeContext } from "@ctk/probe";
import { planGenTargets } from "../src/plan.js";

function skillAsset(id: string): Asset {
  return { schema_version: 1, _scope: "machine_independent", id, kind: "skill", name: id, description: `${id} 설명` };
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
    const result = planGenTargets({ home, assets: [asset], index: emptyIndex });
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
      assets: [asset],
      index: { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] },
    });
    const sha = first.targets[0]?.sourceContentSha256;
    expect(sha).toBeDefined();

    const upToDateIndex: CatalogIndex = {
      schema_version: 1,
      assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill", gen_state: "fresh", gen_content_sha256: sha }],
    };
    const second = planGenTargets({ home, assets: [asset], index: upToDateIndex });
    expect(second.targets).toHaveLength(0);
    expect(second.upToDateCount).toBe(1);
  });

  it("원본이 바뀌면 changed 사유로 다시 대상이 된다", () => {
    init();
    setupSkill("demo-skill", "v1");
    const asset = skillAsset("demo-skill");
    const first = planGenTargets({
      home,
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
    const second = planGenTargets({ home, assets: [asset], index: changedIndex });
    expect(second.targets).toHaveLength(1);
    expect(second.targets[0]?.reason).toBe("changed");
  });

  it("gen_state가 stale이면 원본이 그대로여도 항상 대상에 넣는다(직전 실행 실패 잔여)", () => {
    init();
    setupSkill("demo-skill", "v1");
    const asset = skillAsset("demo-skill");
    const first = planGenTargets({
      home,
      assets: [asset],
      index: { schema_version: 1, assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill" }] },
    });
    const sha = first.targets[0]?.sourceContentSha256;

    const staleIndex: CatalogIndex = {
      schema_version: 1,
      assets: [{ id: "demo-skill", kind: "skill", name: "demo-skill", gen_state: "stale", gen_content_sha256: sha }],
    };
    const result = planGenTargets({ home, assets: [asset], index: staleIndex });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.reason).toBe("stale");
  });

  it("원본도 asset.description도 없으면 emptyAssetIds로 분류하고 대상에 넣지 않는다", () => {
    init();
    const asset: Asset = { schema_version: 1, _scope: "machine_independent", id: "no-source", kind: "skill", name: "no-source" };
    const result = planGenTargets({
      home,
      assets: [asset],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.targets).toHaveLength(0);
    expect(result.emptyAssetIds).toEqual(["no-source"]);
  });

  it("maxAssets로 대상 수를 제한한다", () => {
    init();
    setupSkill("a", "a설명");
    setupSkill("b", "b설명");
    const result = planGenTargets({
      home,
      assets: [skillAsset("a"), skillAsset("b")],
      index: { schema_version: 1, assets: [] },
      maxAssets: 1,
    });
    expect(result.targets).toHaveLength(1);
  });
});
