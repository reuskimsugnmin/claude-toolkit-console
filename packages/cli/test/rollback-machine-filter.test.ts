import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runRollback } from "../src/commands/rollback.js";
import { readLocalConfig, readOrCreateMachineIdentity } from "../src/local-config.js";
import { resolveHomeContext } from "@ctk/probe";
import { beginBackupRun, backupFile, writeManifest } from "@ctk/actuator";

/**
 * cli/test/rollback-machine-filter.test.ts — L4 재현. journal 파일명(`journal/<iso8601>.jsonl`)에
 * `machine_id`가 없다 — 카탈로그는 git으로 여러 머신에 동기화되므로, "가장 최근 파일"을 무조건
 * 고르면 다른 머신이 만든 레코드를 이 머신에서 롤백하려 시도할 수 있다(그 백업은 이 머신에
 * 존재하지 않는 로컬 전용 디렉터리를 가리킨다). `ctk rollback --last`는 **이 머신이 만든**
 * 레코드만 후보로 삼아야 한다.
 */
describe("cli — ctk rollback --last는 이 머신이 만든 journal 레코드만 대상으로 삼는다(L4)", () => {
  let ctkHome: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-rollback-machine-filter-"));
    mkdirSync(path.join(ctkHome, ".claude"), { recursive: true });
    originalEnv = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = path.join(ctkHome, ".claude");
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    rmSync(ctkHome, { recursive: true, force: true });
  });

  function writeJournalFile(catalogPath: string, filename: string, entry: unknown): void {
    const journalDir = path.join(catalogPath, "journal");
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, filename), `${JSON.stringify(entry)}\n`, "utf8");
  }

  it(
    "✅ L4 재현 — 더 최근 파일이 다른 머신의 레코드면 건너뛰고 이 머신의(더 오래된) 레코드를 " +
      "찾아 되돌린다(수정 전에는 '가장 최근 파일'을 무조건 골라, 존재하지 않는 로컬 백업을 " +
      "참조하는 다른 머신 레코드를 되돌리려다 RollbackFailedError로 죽었다)",
    async () => {
      const initResult = await runInit({});
      const home = resolveHomeContext();
      const machine = readOrCreateMachineIdentity(home, "local-machine");
      const catalogPath = readLocalConfig(home)!.catalog_path;

      // 이 머신이 실제로 되돌릴 수 있는 진짜 백업(settings.json)을 만든다.
      const target = path.join(home.ctkConfigDir, "settings.json");
      writeFileSync(target, '{"enabledPlugins":{"a@b":true}}', "utf8");
      const { backupRoot } = beginBackupRun(home.ctkHome, "2026-01-01T00-00-00-000Z");
      const entry = backupFile(backupRoot, "config_settings", target);
      const { manifestSha256 } = writeManifest(backupRoot, "2026-01-01T00-00-00-000Z", { config_settings: entry });
      writeFileSync(target, '{"enabledPlugins":{"a@b":false}}', "utf8"); // 조치가 바꾼 상태 흉내
      const backupRefOurs = `~${backupRoot.slice(home.ctkHome.length)}`;

      // 더 최근 시각(파일명이 뒤에 옴)의 "다른 머신" 레코드 — 존재하지 않는 백업을 가리킨다.
      writeJournalFile(catalogPath, "2026-01-02T00-00-00.000Z.jsonl", {
        schema_version: 1,
        _scope: "machine_dependent",
        action: "move_plugin_enablement",
        asset_id: "foreign-asset@mp",
        machine_id: "11111111-1111-1111-1111-111111111111", // 다른 머신
        before: { install_scope: "user", enabled_at: "user" },
        after: { install_scope: "user", enabled_at: "project" },
        backup_ref: "~/.ctk-backups/nonexistent-backup-on-this-machine",
        backup_manifest_sha256: "f".repeat(64),
        result: "success",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      // 더 오래된 시각의 "이 머신" 레코드 — 방금 만든 진짜 백업을 가리킨다.
      writeJournalFile(catalogPath, "2026-01-01T00-00-00.000Z.jsonl", {
        schema_version: 1,
        _scope: "machine_dependent",
        action: "move_plugin_enablement",
        asset_id: "our-asset@mp",
        machine_id: machine.machine_id, // 이 머신
        before: { install_scope: "user", enabled_at: "user" },
        after: { install_scope: "user", enabled_at: "project" },
        backup_ref: backupRefOurs,
        backup_manifest_sha256: manifestSha256,
        result: "success",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const summary = await runRollback({ last: true });
      // 다른 머신의 레코드(foreign-asset)가 아니라 이 머신의 레코드(our-asset)가 되돌려졌다.
      expect(summary.assetId).toBe("our-asset@mp");
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledPlugins: { "a@b": true } });

      void initResult;
    },
  );
});
