import { describe, expect, it } from "vitest";
import { lintSkillBody, splitSkillDocument } from "../src/catalog/skill-body-lint.js";

/**
 * AC-3.2 판정기의 단위 테스트.
 *
 * **이 파일의 핵심은 "규칙이 존재한다"가 아니라 "규칙이 실제로 막는다"이다**(CLAUDE.md 검증 절 —
 * lint 규칙은 위반 코드를 만들어 실제로 걸리는지 확인한다). 그래서 통과 케이스보다 **위반
 * 픽스처**를 먼저 쓴다.
 */

describe("lintSkillBody — concrete_asset_path (본문만으로 판정 가능)", () => {
  it("자산 이름을 구체값으로 적은 경로는 위반이다 — 이 규칙이 막으려는 바로 그 문장", () => {
    const body = "예를 들어 catalog/assets/skill/pdf-converter/usage.md 를 읽는다.";
    const result = lintSkillBody(body);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe("concrete_asset_path");
    expect(result.violations[0]?.line).toBe(1);
    expect(result.violations[0]?.note).toContain("pdf-converter");
  });

  it("플레이스홀더로 쓴 경로 규약은 위반이 아니다 — 스킬 본문이 실제로 해야 하는 서술", () => {
    const body = [
      "catalog/assets/<kind>/<name>/annotation.md",
      "catalog/assets/{kind}/{name}/usage.md",
      "catalog/assets/skill/<name>/asset.json",
    ].join("\n");
    expect(lintSkillBody(body).violations).toHaveLength(0);
  });

  it("kind 자리가 스키마 열거값도 플레이스홀더도 아니면 위반이다", () => {
    const result = lintSkillBody("catalog/assets/agents/<name>/usage.md");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.note).toContain("agents");
  });

  it("여러 줄에 걸친 위반은 각각 자기 라인 번호로 보고된다 — 지적을 원문 위치로 되짚을 수 있어야 한다", () => {
    const body = ["머리말", "catalog/assets/plugin/alpha-tool/usage.md", "중간", "catalog/assets/mcp/beta-server/asset.json"].join(
      "\n",
    );
    const lines = lintSkillBody(body).violations.map((v) => v.line);
    expect(lines).toEqual([2, 4]);
  });
});

describe("lintSkillBody — asset_name_literal (이름 목록이 있어야 판정 가능)", () => {
  it("이름 목록을 주지 않으면 '위반 0건'이 아니라 unchecked다 — 미실행을 통과로 삼키지 않는다", () => {
    const result = lintSkillBody("아무 내용");
    expect(result.nameCheck).toEqual({ state: "unchecked", reason: "no_asset_names_provided" });
  });

  it("빈 목록을 주면 checked지만 대조한 이름이 0개임이 드러난다", () => {
    const result = lintSkillBody("아무 내용", { knownAssetNames: [] });
    expect(result.nameCheck).toEqual({ state: "checked", namesCompared: 0 });
  });

  it("카탈로그에 실재하는 이름이 본문에 등장하면 위반이다", () => {
    const result = lintSkillBody("먼저 alpha-tool 플러그인을 켠다.", { knownAssetNames: ["alpha-tool", "beta-server"] });
    const nameViolations = result.violations.filter((v) => v.rule === "asset_name_literal");
    expect(nameViolations).toHaveLength(1);
    expect(nameViolations[0]?.match).toBe("alpha-tool");
  });

  it("3자 미만 이름은 대조 대상에서 빠지고 그 사실이 namesCompared에 드러난다", () => {
    const result = lintSkillBody("이 문장에는 ab 가 있다.", { knownAssetNames: ["ab", "alpha-tool"] });
    expect(result.nameCheck).toEqual({ state: "checked", namesCompared: 1 });
    expect(result.violations.filter((v) => v.rule === "asset_name_literal")).toHaveLength(0);
  });
});

describe("splitSkillDocument", () => {
  it("frontmatter와 본문을 가른다 — 검사 대상은 본문뿐이다", () => {
    const content = ["---", "name: toolkit-search", "description: 한 줄 설명", "---", "", "본문 첫 줄"].join("\n");
    const { frontmatter, body } = splitSkillDocument(content);
    expect(frontmatter["name"]).toBe("toolkit-search");
    expect(frontmatter["description"]).toBe("한 줄 설명");
    expect(body).toBe("\n본문 첫 줄");
  });

  it("스킬 자신의 이름이 카탈로그 자산 이름이어도 본문 검사는 통과한다 — 가드가 자기편을 막지 않는다", () => {
    const content = ["---", "name: toolkit-search", "description: 설명", "---", "", "본문은 자산 이름을 담지 않는다."].join("\n");
    const { body } = splitSkillDocument(content);
    const result = lintSkillBody(body, { knownAssetNames: ["toolkit-search"] });
    expect(result.violations).toHaveLength(0);
  });

  it("frontmatter를 함께 검사하면 실제로 실패한다 — 위 케이스가 동어반복이 아님을 보인다", () => {
    const content = ["---", "name: toolkit-search", "description: 설명", "---", "", "본문"].join("\n");
    const result = lintSkillBody(content, { knownAssetNames: ["toolkit-search"] });
    expect(result.violations.filter((v) => v.rule === "asset_name_literal")).toHaveLength(1);
  });

  it("닫는 --- 가 없으면 frontmatter를 빈 값으로 두고 원문 전체를 본문으로 돌려준다 — 파싱 실패를 삼키지 않는다", () => {
    const content = ["---", "name: broken", "본문이 그냥 이어진다"].join("\n");
    const { frontmatter, body } = splitSkillDocument(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it("frontmatter가 아예 없는 문서는 전체가 본문이다", () => {
    const { frontmatter, body } = splitSkillDocument("# 제목\n\n본문");
    expect(frontmatter).toEqual({});
    expect(body).toBe("# 제목\n\n본문");
  });
});
