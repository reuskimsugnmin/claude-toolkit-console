import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDirectory, backupFile, beginBackupRun, readManifest, writeManifest } from "../src/backup.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("actuator/backup — 백업(AC-2.3: 쓰기 직전 백업 존재 + 원본과 바이트 동일)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ctk-backup-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("존재하는 파일을 백업하면 sha256이 원본과 동일하고 existed=true다", () => {
    const target = path.join(home, "settings.json");
    writeFileSync(target, '{"a":1}', "utf8");
    const { backupRoot } = beginBackupRun(home, "run1");
    const entry = backupFile(backupRoot, "config_settings", target);
    expect(entry.existed).toBe(true);
    expect(entry.sha256).toBe(sha256('{"a":1}'));
    expect(entry.targetAbs).toBe(target);
    expect(existsSync(path.join(backupRoot, entry.storedRelPath!))).toBe(true);
  });

  it("존재하지 않는 파일은 existed=false로만 기록한다(없음과 실패를 구분 — 안전 원칙 5)", () => {
    const target = path.join(home, "does-not-exist.json");
    const { backupRoot } = beginBackupRun(home, "run2");
    const entry = backupFile(backupRoot, "to_settings", target);
    expect(entry.existed).toBe(false);
    expect(entry.sha256).toBeNull();
    expect(entry.storedRelPath).toBeNull();
    expect(entry.targetAbs).toBe(target);
  });

  it("디렉터리를 재귀 백업하면 내부 파일별 sha256이 원본과 전부 일치한다", () => {
    const skillDir = path.join(home, "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo-skill\n---\n", "utf8");
    mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    writeFileSync(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");

    const { backupRoot } = beginBackupRun(home, "run3");
    const entry = backupDirectory(backupRoot, "skill_dir", skillDir);
    expect(entry.existed).toBe(true);
    expect(entry.files.map((f) => f.relPath).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    for (const f of entry.files) {
      const original = readFileSync(path.join(skillDir, f.relPath), "utf8");
      expect(sha256(original)).toBe(f.sha256);
    }
  });

  it("manifest를 쓰고 다시 읽으면 항목이 그대로 복원된다(라운드트립)", () => {
    const target = path.join(home, "settings.json");
    writeFileSync(target, "{}", "utf8");
    const { backupRoot } = beginBackupRun(home, "run4");
    const entry = backupFile(backupRoot, "config_settings", target);
    writeManifest(backupRoot, "run4", { config_settings: entry });
    const manifest = readManifest(backupRoot);
    expect(manifest.entries.config_settings).toEqual(entry);
    expect(manifest.run_id).toBe("run4");
  });
});
