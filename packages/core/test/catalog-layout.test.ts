import { describe, expect, it } from "vitest";
import { assertCatalogSegment, assetDir, assetPathSegment } from "../src/index.js";

/**
 * core/test/catalog-layout.test.ts — B1 Step 1. `assetDir`/경로 빌더가 `(kind,name)`이 아니라
 * `(kind,name,id)`에서 경로를 유도하는지 검증한다. 이전에는 이름이 같고 id가 다른 자산이 같은
 * 디렉터리를 공유했다(architect 결정 문서 「최우선 — 카탈로그 경로 축 충돌」 참조).
 */
describe("core/catalog/layout — 경로 축은 id에서 유도한다(B1 Step 1)", () => {
  it("같은 (kind,name), 다른 id는 서로 다른 경로를 만든다", () => {
    const dirA = assetDir("skill", "shared-name", "shared-name@plugin-a");
    const dirB = assetDir("skill", "shared-name", "shared-name@plugin-b");
    expect(dirA).not.toBe(dirB);
    expect(dirA.startsWith("catalog/assets/skill/shared-name__")).toBe(true);
    expect(dirB.startsWith("catalog/assets/skill/shared-name__")).toBe(true);
  });

  it("같은 (kind,name,id)는 항상 같은 경로를 만든다(결정적)", () => {
    expect(assetDir("plugin", "demo", "demo@mp")).toBe(assetDir("plugin", "demo", "demo@mp"));
  });

  it("이름이 겹치지 않아도 id 해시 접미사가 무조건 붙는다(충돌 시에만 붙이면 나중에 고아가 생긴다)", () => {
    const segment = assetPathSegment("solo-name", "solo-name@mp");
    expect(segment).toMatch(/^solo-name__[0-9a-f]{8}$/);
  });

  it(
    "세그먼트 안전 — id에 ':'·'@'·'..'·'/'가 섞인 합성 자산도 유도 세그먼트에 그 문자가 남지 " +
      "않고 assertCatalogSegment를 통과한다(해시를 거치므로 우연이 아니라 설계다)",
    () => {
      const maliciousIds = ["evil:marketplace", "evil@marketplace", "../../evil", "evil/../../etc/passwd"];
      for (const id of maliciousIds) {
        const segment = assetPathSegment("safe-name", id);
        expect(segment).not.toMatch(/[:@]/);
        expect(segment.includes("..")).toBe(false);
        expect(segment.includes("/")).toBe(false);
        expect(() => assertCatalogSegment("test", segment)).not.toThrow();
      }
    },
  );
});
