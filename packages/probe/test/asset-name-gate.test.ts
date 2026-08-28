import { describe, expect, it } from "vitest";
import { MAX_ASSET_NAME_BYTES, safeAssetNameSegment } from "../src/sources/asset-name.js";

/**
 * probe/test/asset-name-gate.test.ts — 보안 재심 M-2 · L-10.
 *
 * ⚠️ **이 관문은 `bundled.ts`의 private 함수였고, 그래서 독립 MCP 축은 검사 없이 지나갔다**
 * (`validateInstallPath`가 M-B에서 겪은 것과 **똑같은 형태**의 결함이다). 그리고 이전 호출자는
 * 전부 frontmatter `name`이나 파일명이라 **개행과 과길이가 표현될 수 없었는데**, JSON 키는
 * 임의 바이트를 담는다.
 *
 * ⚠️ 제어문자는 **코드값으로 만든다** — 소스에 리터럴로 넣으면 diff·리뷰에서 보이지 않는다.
 */
const CTX = "테스트";

/** 개행(10) · 캐리지리턴(13) · 탭(9) · NUL(0) · US(31) · DEL(127). */
const CONTROL_CODES = [10, 13, 9, 0, 31, 127];

describe("safeAssetNameSegment — id 정체를 깨뜨리는 이름을 기각한다", () => {
  it("정상 이름은 그대로 통과한다(과잉 차단 아님)", () => {
    for (const name of ["context7", "my-server", "server_2", "한글이름", "a.b"]) {
      expect(safeAssetNameSegment(name, CTX), name).toBe(name);
    }
  });

  it("`:` 는 기각한다 — 번들 자산 id를 참칭해 `ctk scan` 전체를 죽일 수 있다(M-2)", () => {
    // 재현: 저장소에 담겨 배포되는 프로젝트 `.mcp.json`이 이 이름을 자칭하면 번들 자산과
    // id가 겹쳐 `mergeAssets`가 DuplicateAssetIdError를 던진다.
    expect(safeAssetNameSegment("oh-my-claudecode@mkt:mcp:t", CTX)).toBeNull();
    expect(safeAssetNameSegment("a:b", CTX)).toBeNull();
  });

  it("경로 순회·구분자를 기각한다", () => {
    for (const name of ["..", "../escape", "a/b", "a\\b", ""]) {
      expect(safeAssetNameSegment(name, CTX), JSON.stringify(name)).toBeNull();
    }
  });

  it("제어문자를 기각한다 — JSON 키에는 표현되지만 경로·제목에는 들어가면 안 된다(L-10)", () => {
    for (const code of CONTROL_CODES) {
      const name = `a${String.fromCharCode(code)}b`;
      expect(safeAssetNameSegment(name, CTX), `code=${code}`).toBeNull();
    }
  });

  it("과길이를 기각한다 — 카탈로그 쓰기에서 ENAMETOOLONG이 난다(L-10)", () => {
    expect(safeAssetNameSegment("a".repeat(MAX_ASSET_NAME_BYTES), CTX)).not.toBeNull();
    expect(safeAssetNameSegment("a".repeat(MAX_ASSET_NAME_BYTES + 1), CTX)).toBeNull();
    // 바이트 기준이다 — 한글은 문자 수보다 바이트가 크다.
    expect(safeAssetNameSegment("가".repeat(MAX_ASSET_NAME_BYTES), CTX)).toBeNull();
  });
});
