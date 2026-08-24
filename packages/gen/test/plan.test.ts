import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      assets: [skillAsset("huge2")],
      index: { schema_version: 1, assets: [] },
    });
    const reason = result.skipped[0]?.reason ?? "";
    expect(reason).toContain("바이트");
    expect(reason).not.toMatch(/\/[A-Za-z]/);
  });

  describe("classifyAssetDocState — 단건 조회가 일괄 산출과 갈리지 않는다", () => {
    /**
     * ⚠️ **범위 게이트다.** 화면이 말하는 사유와 `gen`이 실제로 할 일이 갈리면 그 드리프트는
     * 조용하다 — 사용자는 "생성 대기"를 보고 돈을 냈는데 gen은 그 자산을 건너뛴다. 항목이
     * 아니라 범위로 닫기 위해, **네 상태가 모두 등장하는 픽스처**를 만들고 전 자산에 대해
     * 두 경로의 판정이 일치하는지 대조한다. 두 경로가 각자 판정하도록 되돌리면 여기서 깨진다.
     */
    it("네 상태가 모두 나오는 표본에서 단건 판정과 일괄 산출이 전부 일치한다", () => {
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

      const ids = ["fresh-skill", "done-skill", "moved-skill", "stale-skill", "empty-skill", "linked-skill"];
      const assets = ids.map(skillAsset);

      // done-skill의 실제 해시를 얻어 "최신" 상태를 만든다 — 손으로 지어낸 해시는 판정을
      // 검증하지 못한다(픽스처가 결과를 지배해야 한다).
      const probe = planGenTargets({
        home,
        assets,
        index: { schema_version: 1, assets: ids.map((id) => ({ id, kind: "skill" as const, name: id })) },
      });
      const doneHash = probe.targets.find((t) => t.asset.id === "done-skill")?.sourceContentSha256;
      const staleHash = probe.targets.find((t) => t.asset.id === "stale-skill")?.sourceContentSha256;
      expect(doneHash).toBeDefined();
      expect(staleHash).toBeDefined();

      const index: CatalogIndex = {
        schema_version: 1,
        assets: ids.map((id) => {
          const base = { id, kind: "skill" as const, name: id };
          // 최신 — 실제 해시와 일치
          if (id === "done-skill") return { ...base, gen_state: "fresh" as const, gen_content_sha256: doneHash };
          // 원본이 바뀜 — 해시가 다르다
          if (id === "moved-skill") return { ...base, gen_state: "fresh" as const, gen_content_sha256: "0".repeat(64) };
          // 직전 실패 — 해시가 **일치해도** stale이면 대상이어야 한다(그래야 stale 분기가 실행된다)
          if (id === "stale-skill") return { ...base, gen_state: "stale" as const, gen_content_sha256: staleHash };
          return base;
        }),
      };

      const bulk = planGenTargets({ home, assets, index });
      const indexById = new Map(index.assets.map((e) => [e.id, e]));

      // 일괄 산출을 자산 id → 기대 상태로 펼친다.
      const fromBulk = new Map<string, string>();
      for (const t of bulk.targets) fromBulk.set(t.asset.id, `pending_generation:${t.reason}`);
      for (const id of bulk.emptyAssetIds) fromBulk.set(id, "source_missing");
      for (const sk of bulk.skipped) fromBulk.set(sk.assetId, "blocked");
      for (const a of assets) if (!fromBulk.has(a.id)) fromBulk.set(a.id, "generated");

      // ⚠️ **표본에 오답이 가능해야 대조가 의미를 갖는다.** 처음엔 상태 4종만 넣고
      // `size === 4`로 만족했는데, 실제로 갈릴 수 있는 축은 `pending_generation`의 **세 trigger**
      // 였다 — `stale` 자산이 없으니 stale 오분류를 주입해도 게이트가 통과했다(파괴 실험으로 발견).
      // 범위가 아니라 **축**이 어긋난 경우다. 판정이 만들 수 있는 값 전체를 표본에 넣는다.
      expect([...fromBulk.values()].sort()).toEqual(
        [
          "blocked",
          "generated",
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

});
