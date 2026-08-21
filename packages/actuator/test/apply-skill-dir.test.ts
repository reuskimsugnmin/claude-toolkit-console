import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it(
    "✅ M3 재현 — EXDEV(파일시스템 간 이동) 경로에서 소스에 심볼릭 링크가 있으면 " +
      "copy→verify→delete로 진행하지 않고 SkillDirMoveError를 던진다(sha256 검증이 심볼릭 링크를 " +
      "건너뛰므로 삭제 전에 그 존재를 확인할 방법이 없다 — 수정 전에는 검증을 '통과'로 보고 " +
      "원본을 지워 심볼릭 링크를 조용히 잃어버렸다)",
    () => {
      const source = path.join(root, "config", "skills", "symlink-skill");
      const dest = path.join(root, "project", ".claude", "skills", "symlink-skill");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "root", "utf8");
      writeFileSync(path.join(root, "external-target.txt"), "target", "utf8");
      symlinkSync(path.join(root, "external-target.txt"), path.join(source, "link.txt"));

      const fakeRenameForcesExdev = (): never => {
        const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      };

      expect(() => moveSkillDir(source, dest, fakeRenameForcesExdev)).toThrow(SkillDirMoveError);
      // 원본이 그대로 남아있다 — 검증되지 않은 채로 지워지지 않았다.
      expect(existsSync(source)).toBe(true);
      expect(existsSync(path.join(source, "link.txt"))).toBe(true);
      expect(existsSync(dest)).toBe(false);
    },
  );
});
