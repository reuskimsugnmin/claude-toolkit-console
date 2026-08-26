import { describe, expect, it } from "vitest";
import { AssetKindSchema } from "@ctk/core";
import { buildUiPage } from "../server/ui-page.js";

/**
 * web/test/ui-kind-options.test.ts — B1 Step 2(결정 2 #20)의 런타임 게이트.
 *
 * `<select id="kind">`의 `<option>` 목록은 HTML 문자열로 박혀 있어 **타입 축이 안 닿는다** —
 * `tsc -b`는 문자열 리터럴 안을 보지 않으므로 `AssetKindSchema`가 새 값을 얻어도 이 목록은
 * 컴파일에서 절대 깨지지 않는다. `gate:asset-kind`(타입 축 게이트)의 선언 목록에도 이 파일이
 * 없는 이유가 이것이다 — 대신 여기서 **실행된 산출물**에 `AssetKindSchema.options`의 전 값이
 * 실제로 나타나는지 직접 센다(안전 원칙 5 — 등재 ≠ 도달을 여기서도 지킨다).
 */
describe("web/ui-page — <select id=kind>는 AssetKindSchema.options 전 값을 담는다(B1 Step 2 #20)", () => {
  it("buildUiPage()의 산출물에 모든 AssetKind 값이 <option value=...>로 있다", () => {
    const html = buildUiPage("test-nonce");
    for (const kind of AssetKindSchema.options) {
      expect(html, `<option value="${kind}">가 없다`).toContain(`<option value="${kind}">`);
    }
  });

  it("AssetKindSchema.options가 늘어나도(6종) 옛 4종이 빠지지 않는다 — 회귀 방지", () => {
    // AssetKindSchema.options 자체가 진실의 원천이므로 이 목록은 여기서만 손으로 적는다:
    // "빠짐없이 있다"를 이 값들이 실제로 6종을 담고 있다는 사실과 함께 확인하기 위해서다.
    // (options가 실수로 4종으로 되돌아가면 위 테스트만으로는 "4종 다 있다"로 통과해 버린다.)
    expect(AssetKindSchema.options).toEqual(["plugin", "skill", "mcp", "cli", "agent", "command"]);
  });

  it("종류가 아닌 값은 option으로 새지 않는다(프로브 회귀 방지)", () => {
    const html = buildUiPage("test-nonce");
    expect(html).not.toContain('<option value="__probe__">');
  });
});
