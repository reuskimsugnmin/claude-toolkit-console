import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it(
    "✅ L2 재현 — 동일한 run_id(밀리초 해상도 충돌 흉내)로 beginBackupRun을 두 번 불러도 " +
      "서로 다른 백업 디렉터리가 만들어진다(랜덤 접미사) — 수정 전에는 mkdirSync가 이미 있는 " +
      "디렉터리를 조용히 재사용해 두 번째 런이 첫 번째 런의 manifest를 덮어쓸 뻔했다",
    () => {
      const first = beginBackupRun(home, "2026-08-21T00-00-00-000Z"); // 같은 밀리초 run_id
      const second = beginBackupRun(home, "2026-08-21T00-00-00-000Z");
      expect(first.backupRoot).not.toBe(second.backupRoot);
      expect(existsSync(first.backupRoot)).toBe(true);
      expect(existsSync(second.backupRoot)).toBe(true);
    },
  );

  it("백업 런 디렉터리는 0700 모드다(M1 — 그룹/타인 접근 차단)", () => {
    const { backupRoot } = beginBackupRun(home, "run5");
    expect(statSync(backupRoot).mode & 0o777).toBe(0o700);
  });
});
