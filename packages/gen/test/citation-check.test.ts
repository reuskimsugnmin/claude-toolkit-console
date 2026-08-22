import { describe, expect, it } from "vitest";
import { checkAllCitations, checkCitations, citationTag } from "../src/citation-check.js";

describe("gen/citation-check — P5 구조 규칙 검사 (AC-3.6)", () => {
  it("모든 문단에 인용 태그가 있으면 clean이다", () => {
    const text = `첫 문단입니다 ${citationTag("SKILL.md", 1, 2)}\n\n두 번째 문단 ${citationTag("SKILL.md", 3, 4)}`;
    expect(checkCitations(text).status).toBe("clean");
  });

  it("인용이 없는 문단이 하나라도 있으면 violation이다", () => {
    const text = `인용 있음 ${citationTag("SKILL.md", 1, 2)}\n\n인용 없는 문단입니다`;
    const result = checkCitations(text);
    expect(result.status).toBe("violation");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.snippet).toContain("인용 없는 문단");
  });

  it("불릿마다 개별적으로 인용을 요구한다", () => {
    const text = `- 첫 항목 ${citationTag("SKILL.md", 1, 1)}\n- 인용 없는 항목`;
    const result = checkCitations(text);
    expect(result.status).toBe("violation");
    expect(result.violations).toHaveLength(1);
  });

  it("제목(#)은 검사 대상이 아니다", () => {
    const text = `# 제목 — 인용 없음\n\n본문 ${citationTag("SKILL.md", 1, 1)}`;
    expect(checkCitations(text).status).toBe("clean");
  });

  it("코드블록 내부는 검사 대상이 아니다", () => {
    const text = "```\nconst x = 1; // 인용 없음\n```";
    expect(checkCitations(text).status).toBe("clean");
  });

  it("빈 문자열은 clean이다(블록이 없으므로 위반도 없다)", () => {
    expect(checkCitations("").status).toBe("clean");
  });

  it("checkAllCitations는 필드별로 위반을 모아 필드명을 스니펫 앞에 붙인다", () => {
    const result = checkAllCitations({
      role: `역할 ${citationTag("SKILL.md", 1, 1)}`,
      when_to_use: "인용 없음",
    });
    expect(result.status).toBe("violation");
    expect(result.violations[0]?.snippet).toContain("[when_to_use]");
  });

  it("citationTag는 정확한 형식을 만든다(citation-check가 파싱하는 것과 동일한 패턴)", () => {
    expect(citationTag("SKILL.md", 3, 7)).toBe("[[cite:SKILL.md#L3-L7]]");
  });
});
