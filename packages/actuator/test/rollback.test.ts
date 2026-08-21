import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDirectory, backupFile, beginBackupRun, writeManifest } from "../src/backup.js";
import { restoreFromBackup, RollbackFailedError } from "../src/rollback.js";

describe("actuator/rollback — 백업에서 직접 파일 복원(AC-2.5: 롤백 후 조치 이전과 완전히 동일)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ctk-rollback-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("파일을 백업한 뒤 변경하고 복원하면 원본 내용으로 돌아온다", () => {
    const target = path.join(home, "settings.json");
    writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8");
    const { backupRoot } = beginBackupRun(home, "run1");
    const entry = backupFile(backupRoot, "config_settings", target);
    writeManifest(backupRoot, "run1", { config_settings: entry });

    writeFileSync(target, '{"enabledPlugins":{"a@b":false}}', "utf8"); // 조치가 바꾼 상태 흉내

    restoreFromBackup(backupRoot);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledPlugins: { "a@b": true } });
  });

  it("백업 시점에 존재하지 않았던 파일은 롤백 시 삭제된다(생성물 제거)", () => {
    const target = path.join(home, "settings.json"); // 백업 시점엔 없음
    const { backupRoot } = beginBackupRun(home, "run2");
    const entry = backupFile(backupRoot, "to_settings", target);
    writeManifest(backupRoot, "run2", { to_settings: entry });

    writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8"); // 조치가 새로 만든 파일

    restoreFromBackup(backupRoot);
    expect(existsSync(target)).toBe(false);
  });

  it("디렉터리를 백업한 뒤 이동시키고 복원하면 원래 위치에 파일이 다시 생긴다", () => {
    const sourceDir = path.join(home, "skills", "demo-skill");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: demo-skill\n---\n", "utf8");
    const { backupRoot } = beginBackupRun(home, "run3");
    const entry = backupDirectory(backupRoot, "skill_dir", sourceDir);
    writeManifest(backupRoot, "run3", { skill_dir: entry });

    rmSync(sourceDir, { recursive: true, force: true }); // 조치가 이동시켰다고 가정(원본 삭제)

    restoreFromBackup(backupRoot);
    expect(readFileSync(path.join(sourceDir, "SKILL.md"), "utf8")).toBe("---\nname: demo-skill\n---\n");
  });

  it("manifest 자체가 없으면 RollbackFailedError를 던진다(부분 성공을 성공으로 보고하지 않는다)", () => {
    const fakeBackupRoot = path.join(home, "nonexistent-backup");
    expect(() => restoreFromBackup(fakeBackupRoot)).toThrow(RollbackFailedError);
  });

  it("복원 후 sha256이 기대와 다르면 RollbackFailedError를 던진다(백업 저장소 자체 손상 감지)", () => {
    const target = path.join(home, "settings.json");
    writeFileSync(target, "{}", "utf8");
    const { backupRoot } = beginBackupRun(home, "run4");
    const entry = backupFile(backupRoot, "config_settings", target);
    // 백업 저장소의 사본을 손상시켜 sha256 불일치를 인위적으로 재현한다.
    writeFileSync(path.join(backupRoot, entry.storedRelPath!), "{corrupted", "utf8");
    writeManifest(backupRoot, "run4", { config_settings: entry });

    expect(() => restoreFromBackup(backupRoot)).toThrow(RollbackFailedError);
  });
});
