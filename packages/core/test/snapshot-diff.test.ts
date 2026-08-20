import { describe, expect, it } from "vitest";
import { diffById, DuplicateKeyDiffError } from "../src/snapshot/diff.js";

/**
 * core/test/snapshot-diff.test.ts — `diffById()`는 `ctk doctor --drift`의 유일한 계산 엔진이다
 * (cli/src/commands/doctor.ts). Step 2 실환경 검증에서 실측: Installation 191건을 스캔했는데
 * `doctor --drift`의 "무변경" 집계가 189건으로 나온 이례가 있었다. 근본 원인은
 * `collectSkills`(probe/sources/skills.ts)가 프론트매터 `name`이 충돌하는 두 스킬 디렉터리에
 * 대해 동일한 `(asset_id, install_scope, project_path_hash)` 키를 갖는 Installation을 2건 만들고,
 * 당시 `diffById()`가 `new Map(items.map(keyOf))`로 조용히 하나만 채택했기 때문이다(마지막 항목이
 * 흔적 없이 이겼다) — `unchanged.length`(Map 크기 기반)가 실제 항목 수보다 적게 나온 이유다.
 * 이 파일은 그 회귀를 막는다: 중복 키 입력은 조용히 흡수되지 않고 `DuplicateKeyDiffError`로
 * 거부되어야 한다(guard/tree-diff.ts의 `DuplicatePathVerdictError`와 동일한 P2 선례).
 */

interface Item {
  id: string;
  value: string;
}

const keyOf = (item: Item) => item.id;

describe("core/snapshot/diff — diffById()", () => {
  it("추가/제거/무변경을 id 기준으로 정확히 나눈다(중복 없는 정상 입력)", () => {
    const before: Item[] = [
      { id: "a", value: "1" },
      { id: "b", value: "2" },
    ];
    const after: Item[] = [
      { id: "b", value: "2" },
      { id: "c", value: "3" },
    ];
    const result = diffById(before, after, keyOf);
    expect(result.added.map((i) => i.id)).toEqual(["c"]);
    expect(result.removed.map((i) => i.id)).toEqual(["a"]);
    expect(result.unchanged.map((i) => i.id)).toEqual(["b"]);
  });

  it("unchanged.length + added.length는 항상 after.length와 같다(중복 없는 입력)", () => {
    const before: Item[] = [{ id: "a", value: "1" }];
    const after: Item[] = [
      { id: "a", value: "1" },
      { id: "b", value: "2" },
      { id: "c", value: "3" },
    ];
    const result = diffById(before, after, keyOf);
    expect(result.unchanged.length + result.added.length).toBe(after.length);
  });

  it(
    "값이 바뀐(같은 키, 다른 값) 레코드는 여전히 unchanged로 집계된다 — id 기반 diff의 알려진 " +
      "한계(값 변경은 add/remove로 보이지 않는다). 이 테스트는 그 한계를 문서화하지, 승인하지 않는다.",
    () => {
      const before: Item[] = [{ id: "a", value: "old" }];
      const after: Item[] = [{ id: "a", value: "new" }];
      const result = diffById(before, after, keyOf);
      expect(result.unchanged).toHaveLength(1);
      expect(result.unchanged[0]?.value).toBe("new"); // after 쪽 값이 채택됨 — 변경 자체는 드러나지 않는다.
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
    },
  );

  it(
    "✅ 회귀 방지 — after에 동일 키가 2회 이상 있으면 조용히 하나를 채택하지 않고 " +
      "DuplicateKeyDiffError를 던진다(Step 2 실환경 이례: Installation 191건 중 189건만 " +
      "무변경 집계됐던 근본 원인)",
    () => {
      const before: Item[] = [{ id: "a", value: "1" }];
      const after: Item[] = [
        { id: "a", value: "first-seen" },
        { id: "a", value: "second-seen" },
      ];
      let caught: unknown;
      try {
        diffById(before, after, keyOf);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DuplicateKeyDiffError);
      const error = caught as DuplicateKeyDiffError;
      expect(error.failureClass).toBe("duplicate_snapshot_key");
      expect(error.duplicates).toEqual([{ key: "a", list: "after" }]);
    },
  );

  it("before 쪽 중복도 동일하게 거부된다(before/after 대칭)", () => {
    const before: Item[] = [
      { id: "a", value: "1" },
      { id: "a", value: "2" },
    ];
    expect(() => diffById(before, [], keyOf)).toThrow(DuplicateKeyDiffError);
  });

  it("빈 배열 두 개는 정상적으로 빈 diff를 반환한다(회귀 방지 — 거부가 과도해지지 않았는가)", () => {
    const result = diffById<Item>([], [], keyOf);
    expect(result).toEqual({ added: [], removed: [], unchanged: [] });
  });
});
