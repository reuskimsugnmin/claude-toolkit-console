import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      // 디렉터리가 아예 없는 자산 = empty. 링크 자산 = skipped. 둘을 뭉치지 않는다.
      assets: [skillAsset("linked-skill"), skillAsset("missing-skill")],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.skipped.map((s) => s.assetId)).toEqual(["linked-skill"]);
    expect(result.emptyAssetIds).toEqual(["missing-skill"]);
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
      assets: [skillAsset("huge-skill"), skillAsset("normal-a")],
      index: { schema_version: 1, assets: [] },
    });
    expect(result.skipped.map((x) => x.assetId)).toEqual(["huge-skill"]);
    expect(result.skipped[0]?.failureClass).toBe("asset_source_too_large");
    expect(result.targets.map((t) => t.asset.id)).toEqual(["normal-a"]);
  });
});
