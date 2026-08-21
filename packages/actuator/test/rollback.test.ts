import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HomeContext } from "@ctk/probe";
import { backupDirectory, backupFile, beginBackupRun, writeManifest } from "../src/backup.js";
import {
  BackupManifestTamperedError,
  ConfigClobberedError,
  ForbiddenRestoreTargetError,
  RollbackFailedError,
  restoreFromBackup,
} from "../src/rollback.js";

describe("actuator/rollback — 백업에서 직접 파일 복원(AC-2.5: 롤백 후 조치 이전과 완전히 동일)", () => {
  let home: string;
  let homeCtx: HomeContext;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ctk-rollback-"));
    // 이 테스트 스위트의 복원 대상은 전부 `home` 바로 아래에 있다 — assertRestorableTarget(H2)이
    // "config 또는 알려진 project/.claude 안"만 허용하므로, `home` 자체를 ctkConfigDir로 지정한다.
    homeCtx = { ctkHome: home, ctkConfigDir: home, configDirExplicit: false };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("파일을 백업한 뒤 변경하고 복원하면 원본 내용으로 돌아온다", () => {
    const target = path.join(home, "settings.json");
    writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8");
    const { backupRoot } = beginBackupRun(home, "run1");
    const entry = backupFile(backupRoot, "config_settings", target);
    writeManifest(backupRoot, "run1", { config_settings: entry });

    writeFileSync(target, '{"enabledPlugins":{"a@b":false}}', "utf8"); // 조치가 바꾼 상태 흉내

    restoreFromBackup(backupRoot, homeCtx);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledPlugins: { "a@b": true } });
  });

  it("백업 시점에 존재하지 않았던 파일은 롤백 시 삭제된다(생성물 제거)", () => {
    const target = path.join(home, "settings.json"); // 백업 시점엔 없음
    const { backupRoot } = beginBackupRun(home, "run2");
    const entry = backupFile(backupRoot, "to_settings", target);
    writeManifest(backupRoot, "run2", { to_settings: entry });

    writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8"); // 조치가 새로 만든 파일

    restoreFromBackup(backupRoot, homeCtx);
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

    restoreFromBackup(backupRoot, homeCtx);
    expect(readFileSync(path.join(sourceDir, "SKILL.md"), "utf8")).toBe("---\nname: demo-skill\n---\n");
  });

  it("manifest 자체가 없으면 RollbackFailedError를 던진다(부분 성공을 성공으로 보고하지 않는다)", () => {
    const fakeBackupRoot = path.join(home, "nonexistent-backup");
    expect(() => restoreFromBackup(fakeBackupRoot, homeCtx)).toThrow(RollbackFailedError);
  });

  it(
    "✅ H1/AC-2.11 재현 — 백업 저장 사본이 손상되면(sha256 불일치) preflight가 어떤 쓰기도 " +
      "하기 전에 RollbackFailedError를 던지고, 대상 파일은 0바이트도 바뀌지 않는다(수정 전에는 " +
      "복원이 먼저 대상에 손상된 내용을 써버린 뒤에야 검증 실패를 보고했다)",
    () => {
      const target = path.join(home, "settings.json");
      writeFileSync(target, "{}", "utf8");
      const { backupRoot } = beginBackupRun(home, "run4");
      const entry = backupFile(backupRoot, "config_settings", target);
      // 백업 저장소의 사본을 손상시켜 sha256 불일치를 인위적으로 재현한다.
      writeFileSync(path.join(backupRoot, entry.storedRelPath!), "{corrupted", "utf8");
      writeManifest(backupRoot, "run4", { config_settings: entry });

      writeFileSync(target, '{"changed":true}', "utf8"); // 조치가 대상을 바꿨다고 가정
      const beforeAttempt = readFileSync(target, "utf8");

      expect(() => restoreFromBackup(backupRoot, homeCtx)).toThrow(RollbackFailedError);
      // preflight에서 걸렸으므로 대상은 여전히 "조치 직후" 상태 그대로다 — 손상된 백업 내용이
      // 단 1바이트도 쓰이지 않았다.
      expect(readFileSync(target, "utf8")).toBe(beforeAttempt);
    },
  );

  it(
    "✅ H2/AC-2.12 재현 — manifest에 허용된 루트(config/알려진 project) 밖의 targetAbs를 " +
      "주입하면 ForbiddenRestoreTargetError(failure_class: forbidden_path_write)로 거부하고 " +
      "그 경로는 전혀 건드리지 않는다(수정 전에는 rmSync/atomicWriteFile 인자로 무검증 전달됐다)",
    () => {
      const outsideTarget = path.join(tmpdir(), `ctk-h2-outside-${Date.now()}`);
      writeFileSync(outsideTarget, "victim-original", "utf8");
      try {
        const { backupRoot } = beginBackupRun(home, "run-h2");
        writeManifest(backupRoot, "run-h2", {
          evil: {
            kind: "file",
            targetAbs: outsideTarget, // 허용 루트(home) 밖
            existed: true,
            sha256: "a".repeat(64),
            storedRelPath: null,
          },
        });

        expect(() => restoreFromBackup(backupRoot, homeCtx)).toThrow(ForbiddenRestoreTargetError);
        expect(readFileSync(outsideTarget, "utf8")).toBe("victim-original");
      } finally {
        rmSync(outsideTarget, { force: true });
      }
    },
  );

  it(
    "✅ H2 재현 — storedRelPath가 절대경로거나 경로 순회(..)를 담으면(백업 저장소 밖을 읽는 " +
      "manifest) ForbiddenRestoreTargetError로 거부한다",
    () => {
      const target = path.join(home, "settings.json");
      writeFileSync(target, "{}", "utf8");
      const { backupRoot } = beginBackupRun(home, "run-h2b");
      writeManifest(backupRoot, "run-h2b", {
        evil: {
          kind: "file",
          targetAbs: target,
          existed: true,
          sha256: "a".repeat(64),
          storedRelPath: "../../etc/passwd",
        },
      });
      expect(() => restoreFromBackup(backupRoot, homeCtx)).toThrow(ForbiddenRestoreTargetError);
    },
  );

  it(
    "✅ H2/AC-2.13 재현 — journal에 기록된 backup_manifest_sha256과 실측 manifest.json " +
      "sha256이 다르면(백업 저장소 자체가 변조됐을 가능성) BackupManifestTamperedError로 거부한다",
    () => {
      const target = path.join(home, "settings.json");
      writeFileSync(target, "{}", "utf8");
      const { backupRoot } = beginBackupRun(home, "run5");
      const entry = backupFile(backupRoot, "config_settings", target);
      writeManifest(backupRoot, "run5", { config_settings: entry });

      expect(() => restoreFromBackup(backupRoot, homeCtx, "f".repeat(64))).toThrow(BackupManifestTamperedError);
    },
  );

  it(
    "✅ M8 재현 — 백업~롤백 사이 다른 세션이 대상 파일을 바꾸면(lost update 위험), " +
      "expectedCurrentShas와 대조해 ConfigClobberedError로 중단하고 그 변경을 덮어쓰지 않는다 " +
      "(수정 전에는 확인 없이 그대로 덮어썼다)",
    () => {
      const target = path.join(home, "settings.json");
      writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8");
      const { backupRoot } = beginBackupRun(home, "run-m8");
      const entry = backupFile(backupRoot, "config_settings", target);
      writeManifest(backupRoot, "run-m8", { config_settings: entry });

      // "조치 직후 우리가 남긴 값" — 조치가 실제로 만든 상태.
      writeFileSync(target, '{"enabledPlugins":{"a@b":false}}', "utf8");
      const expectedCurrentSha = createHash("sha256").update(readFileSync(target)).digest("hex");

      // 다른 세션이 그 사이 끼어들어 파일을 또 바꿨다 — 우리가 예상한 값과 달라진다.
      writeFileSync(target, '{"enabledPlugins":{"a@b":false},"userEdit":true}', "utf8");

      expect(() =>
        restoreFromBackup(backupRoot, homeCtx, undefined, { config_settings: expectedCurrentSha }),
      ).toThrow(ConfigClobberedError);
      // 사용자가 끼어들어 만든 값이 그대로 남아있다 — 조용히 덮어써지지 않았다.
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledPlugins: { "a@b": false }, userEdit: true });
    },
  );

  it(
    "expectedCurrentShas가 실측과 일치하면(다른 세션의 개입 없음) 정상적으로 복원한다",
    () => {
      const target = path.join(home, "settings.json");
      writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8");
      const { backupRoot } = beginBackupRun(home, "run-m8b");
      const entry = backupFile(backupRoot, "config_settings", target);
      writeManifest(backupRoot, "run-m8b", { config_settings: entry });

      writeFileSync(target, '{"enabledPlugins":{"a@b":false}}', "utf8");
      const expectedCurrentSha = createHash("sha256").update(readFileSync(target)).digest("hex");

      restoreFromBackup(backupRoot, homeCtx, undefined, { config_settings: expectedCurrentSha });
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledPlugins: { "a@b": true } });
    },
  );

  it("복원 후 sha256이 기대와 다르면 RollbackFailedError를 던진다(백업 저장소 자체 손상 감지)", () => {
    const target = path.join(home, "settings.json");
    writeFileSync(target, "{}", "utf8");
    const { backupRoot } = beginBackupRun(home, "run4b");
    const entry = backupFile(backupRoot, "config_settings", target);
    // 백업 저장소의 사본을 손상시켜 sha256 불일치를 인위적으로 재현한다.
    writeFileSync(path.join(backupRoot, entry.storedRelPath!), "{corrupted", "utf8");
    writeManifest(backupRoot, "run4b", { config_settings: entry });

    expect(() => restoreFromBackup(backupRoot, homeCtx)).toThrow(RollbackFailedError);
  });
});
