import { describe, expect, it } from "vitest";
import { parseAsset, type Asset } from "@ctk/core";
import { DuplicateAssetIdError, mergeAssets } from "../src/commands/scan.js";

/**
 * cli/test/scan-merge-assets.test.ts — B1 Step 3, AC-2-a.
 *
 * `mergeAssets()`는 이전에 `Map`으로 모으며 동일 id를 first-wins로 조용히 삼켰다(경로 축
 * 충돌이 실제로 터지면 자산이 조용히 사라지는 결함, `.omc/state/ctk-b1-architect-decisions.md`
 * 최우선 항목). `core/snapshot/diff.ts`의 `DuplicateKeyDiffError` 선례를 따라 throw로 바꾼다.
 */

function asset(id: string, name: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id,
    kind: "plugin",
    name,
    marketplace: "demo-marketplace",
  });
}

describe("cli/commands/scan — mergeAssets 중복 id(AC-2-a)", () => {
  it("서로 다른 id는 정상적으로 병합된다(회귀 방지)", () => {
    const merged = mergeAssets([asset("a@mp", "a")], [asset("b@mp", "b")]);
    expect(merged.map((a) => a.id).sort()).toEqual(["a@mp", "b@mp"]);
  });

  it("동일 id가 서로 다른 그룹(예: plugin/skill 수집 결과)에 2건 주입되면 DuplicateAssetIdError를 던진다", () => {
    const groupA = [asset("dup@mp", "dup-a")];
    const groupB = [asset("dup@mp", "dup-b")];
    expect(() => mergeAssets(groupA, groupB)).toThrow(DuplicateAssetIdError);
  });

  it("던져진 오류는 failure_class: duplicate_asset_id를 싣는다(run-log 분류용)", () => {
    const groupA = [asset("dup@mp", "dup-a")];
    const groupB = [asset("dup@mp", "dup-b")];
    try {
      mergeAssets(groupA, groupB);
      expect.unreachable("mergeAssets가 던졌어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateAssetIdError);
      expect((err as DuplicateAssetIdError).failureClass).toBe("duplicate_asset_id");
      expect((err as DuplicateAssetIdError).duplicateIds).toEqual(["dup@mp"]);
    }
  });

  it("같은 그룹 내부의 중복도 던진다(그룹 경계와 무관하게 전역 id 유일성)", () => {
    const group = [asset("dup@mp", "dup-a"), asset("dup@mp", "dup-b")];
    expect(() => mergeAssets(group)).toThrow(DuplicateAssetIdError);
  });
});
