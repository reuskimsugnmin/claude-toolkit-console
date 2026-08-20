import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSkills } from "../src/sources/skills.js";
import { buildFixtureHome, type FixtureHome } from "./support/fixture-home.js";

describe("probe/sources/skills — 전역+프로젝트 스킬 열거, plugin.json 유무로 오분류 방지 (P2-6)", () => {
  let fixture: FixtureHome;
  afterEach(() => fixture?.cleanup());

  it("전역 스킬 1건 + 프로젝트(alpha) 스킬 1건을 탐지한다", () => {
    fixture = buildFixtureHome();
    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    expect(result.assets.map((a) => a.id).sort()).toEqual(["global-skill", "project-skill"]);
    const global = result.installations.find((i) => i.asset_id === "global-skill");
    expect(global?.enabled_at).toBe("user");
    expect(global?.project_path_hash).toBeNull();
    const project = result.installations.find((i) => i.asset_id === "project-skill");
    expect(project?.enabled_at).toBe("project");
    expect(project?.project_path_hash).not.toBeNull();
  });

  it("SKILL.md 없는 디렉터리는 건너뛴다", () => {
    fixture = buildFixtureHome();
    mkdirSync(path.join(fixture.home.ctkConfigDir, "skills", "not-a-skill"), { recursive: true });
    writeFileSync(path.join(fixture.home.ctkConfigDir, "skills", "not-a-skill", "README.md"), "no SKILL.md here");
    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    expect(result.assets.some((a) => a.id === "not-a-skill")).toBe(false);
  });

  it("SKILL.md가 있어도 .claude-plugin/plugin.json이 있으면 스킬로 잡지 않는다(P2-6)", () => {
    fixture = buildFixtureHome();
    const dir = path.join(fixture.home.ctkConfigDir, "skills", "actually-a-plugin");
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: actually-a-plugin\n---\n");
    writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "actually-a-plugin" }));
    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    expect(result.assets.some((a) => a.id === "actually-a-plugin")).toBe(false);
  });
});
