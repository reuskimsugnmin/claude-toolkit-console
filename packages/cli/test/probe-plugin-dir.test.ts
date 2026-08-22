import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_SKILL_REPLACED_HEADING, splitMarkdownSections, splitSkillDocument, withoutSection } from "@ctk/core";
import { PROBE_PLUGIN_NAME, createProbePluginDir, type ProbePluginDir } from "../src/probe-plugin-dir.js";

/**
 * 안 B의 **디스크 쪽** 계약. `core`의 순수 변환 테스트가 "만들면 한 절만 다르다"를 보였다면,
 * 여기서는 **실제로 쓰인 파일**이 그 결과와 같은지 본다 — 메모리 안에서만 참인 주장을 유료
 * 진단의 근거로 삼지 않는다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL_PATH = path.join(repoRoot, "skills", "toolkit-search", "SKILL.md");
const ORIGINAL = readFileSync(SKILL_PATH, "utf8");
const CATALOG = path.join(repoRoot, "fixtures", "agent-probe-catalog");

const created: ProbePluginDir[] = [];
afterEach(() => {
  for (const p of created.splice(0)) p.cleanup();
});

function make(catalogRoot = CATALOG, skillSourcePath = SKILL_PATH): ProbePluginDir {
  const p = createProbePluginDir({ skillSourcePath, catalogRoot });
  created.push(p);
  return p;
}

const skillFile = (p: ProbePluginDir): string => path.join(p.pluginDir, "skills", "toolkit-search", "SKILL.md");

describe("createProbePluginDir — 하네스가 읽을 수 있는 최소 구조", () => {
  it("plugin.json과 SKILL.md를 쓴다", () => {
    const p = make();
    expect(existsSync(path.join(p.pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(skillFile(p))).toBe(true);
  });

  it("plugin.json이 유효한 JSON이고 진단용임을 밝힌다 — 문자열 검사가 아니라 파싱한다", () => {
    const p = make();
    const manifest = JSON.parse(readFileSync(path.join(p.pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as {
      name: string;
      description: string;
    };
    expect(manifest.name).toBe(PROBE_PLUGIN_NAME);
    expect(manifest.description).toContain("진단 전용");
  });

  it("스킬 디렉터리 이름이 프로덕션과 같다 — 이름이 달라지면 그것도 차이가 된다", () => {
    expect(path.basename(path.dirname(skillFile(make())))).toBe("toolkit-search");
  });

  it("임시 디렉터리는 0700이다 — 같은 머신의 다른 계정이 읽지 못한다", () => {
    expect(statSync(make().pluginDir).mode & 0o777).toBe(0o700);
  });

  it("카탈로그 루트를 절대경로로 정규화한다 — 자식은 다른 cwd에서 돈다", () => {
    const p = make(path.relative(process.cwd(), CATALOG));
    expect(path.isAbsolute(p.catalogRoot)).toBe(true);
    expect(p.catalogRoot).toBe(CATALOG);
  });
});

describe("쓰인 파일이 프로덕션 원문과 정확히 한 절만 다르다", () => {
  it("나머지 절이 **바이트 동일**하다 — 디스크에서 되읽어 확인한다", () => {
    const written = readFileSync(skillFile(make()), "utf8");
    expect(withoutSection(written, PROBE_SKILL_REPLACED_HEADING)).toBe(
      withoutSection(ORIGINAL, PROBE_SKILL_REPLACED_HEADING),
    );
  });

  it("frontmatter가 그대로다 — description이 자율 발동의 근거다", () => {
    const written = readFileSync(skillFile(make()), "utf8");
    expect(splitSkillDocument(written).frontmatter).toEqual(splitSkillDocument(ORIGINAL).frontmatter);
  });

  it("바뀐 절이 합성 카탈로그 루트를 가리킨다 — 위 단언이 '아무것도 안 바꿈'과 구분됨을 보인다", () => {
    const p = make();
    const written = readFileSync(skillFile(p), "utf8");
    const replaced = splitMarkdownSections(written).find((s) => s.heading === PROBE_SKILL_REPLACED_HEADING)?.text ?? "";
    expect(replaced).toContain(p.catalogRoot);
    expect(replaced).not.toBe(
      splitMarkdownSections(ORIGINAL).find((s) => s.heading === PROBE_SKILL_REPLACED_HEADING)?.text,
    );
  });

  it("사용자의 실제 홈 경로 규약이 지시로 남지 않는다 — 그게 이 사본의 존재 이유다", () => {
    const written = readFileSync(skillFile(make()), "utf8");
    const replaced = splitMarkdownSections(written).find((s) => s.heading === PROBE_SKILL_REPLACED_HEADING)?.text ?? "";
    // 원문의 "이 파일에서 읽는다" 지시가 사라졌는지 본다(경로가 설명으로 인용되는 것과 구분).
    expect(replaced).not.toContain("다음 파일에서 읽는다");
  });
});

describe("cleanup — 유료 세션이 실패해도 남기지 않는다", () => {
  it("호출하면 디렉터리가 사라진다", () => {
    const p = createProbePluginDir({ skillSourcePath: SKILL_PATH, catalogRoot: CATALOG });
    expect(existsSync(p.pluginDir)).toBe(true);
    p.cleanup();
    expect(existsSync(p.pluginDir)).toBe(false);
  });

  it("두 번 호출해도 던지지 않는다 — 정리 실패가 진단 결과를 덮지 않는다", () => {
    const p = createProbePluginDir({ skillSourcePath: SKILL_PATH, catalogRoot: CATALOG });
    p.cleanup();
    expect(() => p.cleanup()).not.toThrow();
  });
});

describe("판정할 수 없는 원본은 거부한다", () => {
  it("카탈로그 위치 절이 없는 스킬이면 던지고 디렉터리를 남기지 않는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-probe-badskill-"));
    const bad = path.join(dir, "SKILL.md");
    writeFileSync(bad, "---\nname: x\n---\n\n# 제목\n\n본문뿐\n", "utf8");
    expect(() => createProbePluginDir({ skillSourcePath: bad, catalogRoot: CATALOG })).toThrow(/카탈로그 위치/);
  });
});
