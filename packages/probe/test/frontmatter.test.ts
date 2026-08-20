import { describe, expect, it } from "vitest";
import { parseSimpleFrontmatter } from "../src/frontmatter.js";

describe("probe/frontmatter — 최소 YAML frontmatter 파서", () => {
  it("name/description 단일 라인 키:값을 추출한다", () => {
    const content = "---\nname: loose-skill\ndescription: A synthetic marker skill.\n---\n\n# loose-skill\n";
    expect(parseSimpleFrontmatter(content)).toEqual({
      name: "loose-skill",
      description: "A synthetic marker skill.",
    });
  });

  it("frontmatter 블록이 없으면 빈 객체를 반환한다", () => {
    expect(parseSimpleFrontmatter("# just a heading\n")).toEqual({});
  });

  it("값에 콜론이 더 있어도 첫 콜론만 구분자로 쓴다", () => {
    const content = "---\ndescription: URL: https://example.com\n---\n";
    expect(parseSimpleFrontmatter(content).description).toBe("URL: https://example.com");
  });

  it("닫는 --- 없이 파일이 끝나면 그 시점까지만 파싱한다(안전한 종료)", () => {
    const content = "---\nname: unterminated\n";
    expect(parseSimpleFrontmatter(content)).toEqual({ name: "unterminated" });
  });
});
