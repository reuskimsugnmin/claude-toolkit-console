import { describe, expect, it } from "vitest";
import { extractSpawnMetadata, parseFrontmatterWithLines } from "../src/extract-frontmatter.js";

const SKILL_MD = `---
name: demo-skill
description: PDF를 마크다운으로 바꾼다
allowed-tools: Read,Write
model: sonnet
---

# 본문
`;

describe("gen/extract-frontmatter — spawn_metadata는 원본에서 문자열 그대로 (LLM 재서술 금지)", () => {
  it("키별 1-based 라인 번호를 정확히 추적한다", () => {
    const parsed = parseFrontmatterWithLines(SKILL_MD);
    expect(parsed.name).toEqual({ value: "demo-skill", line: 2 });
    expect(parsed.description).toEqual({ value: "PDF를 마크다운으로 바꾼다", line: 3 });
    expect(parsed.model).toEqual({ value: "sonnet", line: 5 });
  });

  it("SPAWN_METADATA_KEYS에 해당하는 값만 추출값+extractedFrom으로 반환한다", () => {
    const meta = extractSpawnMetadata(SKILL_MD, "SKILL.md");
    expect(meta.name).toEqual({ value: "demo-skill", extractedFrom: { sourceRef: "SKILL.md", lineStart: 2, lineEnd: 2 } });
    expect(meta.description?.value).toBe("PDF를 마크다운으로 바꾼다");
    expect(meta["allowed-tools"]?.value).toBe("Read,Write");
  });

  it("문자열 값이 정확히 원문과 같다 — AC-3.4가 요구하는 동일성", () => {
    const meta = extractSpawnMetadata(SKILL_MD, "SKILL.md");
    const frontmatterLine = SKILL_MD.split("\n")[2]; // "description: PDF를 ..."
    expect(frontmatterLine).toContain(meta.description?.value ?? "__missing__");
  });

  it("frontmatter가 없는 내용은 빈 결과를 반환한다", () => {
    expect(parseFrontmatterWithLines("그냥 본문일 뿐")).toEqual({});
    expect(extractSpawnMetadata("그냥 본문일 뿐", "x")).toEqual({});
  });

  it("빈 값은 추출하지 않는다(있어도 무의미한 필드로 남기지 않는다)", () => {
    const content = "---\nname: x\ndescription:\n---\n";
    const meta = extractSpawnMetadata(content, "SKILL.md");
    expect(meta.description).toBeUndefined();
  });
});
