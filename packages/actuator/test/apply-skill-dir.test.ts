import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveSkillDir, SkillDirMoveError } from "../src/apply/skill-dir.js";

describe("actuator/apply/skill-dir — 스킬 디렉터리 이동(결정 6C: 6B, CLI 없음)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-skill-move-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("같은 파일시스템이면 rename으로 이동하고 내용이 그대로 보존된다", () => {
    const source = path.join(root, "config", "skills", "demo-skill");
    const dest = path.join(root, "project", ".claude", "skills", "demo-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: demo-skill\n---\n# demo\n", "utf8");

    const result = moveSkillDir(source, dest);
    expect(result.method).toBe("rename");
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("---\nname: demo-skill\n---\n# demo\n");
  });

  it("원본이 없으면 SkillDirMoveError를 던진다", () => {
    const source = path.join(root, "does-not-exist");
    const dest = path.join(root, "dest");
    expect(() => moveSkillDir(source, dest)).toThrow(SkillDirMoveError);
  });

  it("대상이 이미 존재하면 조용히 덮어쓰지 않고 SkillDirMoveError를 던진다", () => {
    const source = path.join(root, "source-skill");
    const dest = path.join(root, "dest-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "new", "utf8");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "SKILL.md"), "existing", "utf8");

    expect(() => moveSkillDir(source, dest)).toThrow(SkillDirMoveError);
    // 대상이 손상되지 않고 원래 내용 그대로 남아있다.
    expect(readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("existing");
    // 원본도 그대로 남아있다(부분 실패 없음).
    expect(existsSync(source)).toBe(true);
  });

  it("서브디렉터리를 포함한 여러 파일도 전부 이동된다", () => {
    const source = path.join(root, "config", "skills", "multi-file-skill");
    const dest = path.join(root, "project", ".claude", "skills", "multi-file-skill");
    mkdirSync(path.join(source, "scripts"), { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "root", "utf8");
    writeFileSync(path.join(source, "scripts", "run.sh"), "script", "utf8");

    moveSkillDir(source, dest);
    expect(readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("root");
    expect(readFileSync(path.join(dest, "scripts", "run.sh"), "utf8")).toBe("script");
  });
});
