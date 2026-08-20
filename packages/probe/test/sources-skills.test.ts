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

  it(
    "✅ 회귀 방지 — 서로 다른 두 디렉터리가 SKILL.md 프론트매터 name을 동일하게 선언하면(같은 " +
      "스코프) Installation을 2건이 아니라 1건만 만든다. 실환경 검증에서 발견된 이례의 근본 원인: " +
      "라우터 스킬 디렉터리가 실제 스킬과 동일한 name을 자칭해 (asset_id, install_scope, " +
      "project_path_hash) 키가 충돌하는 Installation이 2건 생겼고, 이는 diffById()가 " +
      "DuplicateKeyDiffError로 거부하는 입력이 된다(core/snapshot/diff.ts) — 여기서 애초에 " +
      "그런 입력을 만들지 않는다(Asset 쪽 first-wins 정책과 동일하게 first-wins).",
    () => {
      fixture = buildFixtureHome();
      const skillsRoot = path.join(fixture.home.ctkConfigDir, "skills");
      // 디렉터리명은 다르지만(라우터 vs 실제 스킬) 프론트매터 name이 둘 다 "shared-name"으로 충돌한다.
      mkdirSync(path.join(skillsRoot, "router-alias"), { recursive: true });
      writeFileSync(
        path.join(skillsRoot, "router-alias", "SKILL.md"),
        "---\nname: shared-name\ndescription: 라우터 별칭\n---\n",
      );
      mkdirSync(path.join(skillsRoot, "shared-name"), { recursive: true });
      writeFileSync(
        path.join(skillsRoot, "shared-name", "SKILL.md"),
        "---\nname: shared-name\ndescription: 실제 스킬\n---\n",
      );

      const result = collectSkills({ home: fixture.home, machineId: "m1" });

      const matchingInstallations = result.installations.filter((i) => i.asset_id === "shared-name");
      expect(matchingInstallations).toHaveLength(1);
      // Asset 쪽도 여전히 하나로 고유 집계된다(기존 first-wins와 일관).
      expect(result.assets.filter((a) => a.id === "shared-name")).toHaveLength(1);
    },
  );
});
