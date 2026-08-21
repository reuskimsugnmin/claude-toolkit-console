import { describe, expect, it } from "vitest";
import {
  buildPluginEnablementJournalEntry,
  buildRollbackJournalEntry,
  buildSkillDirJournalEntry,
  PathNormalizeFailedError,
} from "../src/journal.js";
import { JournalEntrySchema } from "@ctk/core";

const HOME = "/Users/synthtest/home";

describe("actuator/journal — before/after 필수, 반환만 한다(P1-5)", () => {
  it("플러그인 enablement 저널이 스키마를 통과하고 before/after가 둘 다 존재한다(AC-2.4)", () => {
    const entry = buildPluginEnablementJournalEntry({
      assetId: "demo@demo-mp",
      machineId: "m1",
      homeDir: HOME,
      before: { install_scope: "user", enabled_at: "user" },
      after: { install_scope: "user", enabled_at: "project" },
      backupRootAbs: `${HOME}/.ctk-backups/run1`,
      result: "success",
    });
    expect(() => JournalEntrySchema.parse(entry)).not.toThrow();
    expect(entry.action).toBe("move_plugin_enablement");
    expect(entry.before).toEqual({ install_scope: "user", enabled_at: "user" });
    expect(entry.after).toEqual({ install_scope: "user", enabled_at: "project" });
    expect(entry.backup_ref).toBe("~/.ctk-backups/run1");
  });

  it("스킬 디렉터리 저널도 스키마를 통과한다", () => {
    const entry = buildSkillDirJournalEntry({
      assetId: "demo-skill",
      machineId: "m1",
      homeDir: HOME,
      before: { location: "user", project_path_hash: null },
      after: { location: "project", project_path_hash: "abcd1234" },
      backupRootAbs: `${HOME}/.ctk-backups/run2`,
      result: "success",
    });
    expect(() => JournalEntrySchema.parse(entry)).not.toThrow();
    expect(entry.action).toBe("move_skill_dir");
  });

  it("rollback 저널은 action이 항상 'rollback'이고 original_action을 before에 담는다", () => {
    const entry = buildRollbackJournalEntry({
      originalAction: "move_plugin_enablement",
      assetId: "demo@demo-mp",
      machineId: "m1",
      homeDir: HOME,
      before: { enabled_at: "project" },
      after: { enabled_at: "user" },
      backupRootAbs: `${HOME}/.ctk-backups/run1`,
      result: "success",
    });
    expect(entry.action).toBe("rollback");
    expect(entry.before).toMatchObject({ original_action: "move_plugin_enablement", enabled_at: "project" });
  });

  it("backup_ref가 홈 상대화될 수 없으면 path_hash로 폴백하지 않고 PathNormalizeFailedError를 던진다(F4)", () => {
    expect(() =>
      buildPluginEnablementJournalEntry({
        assetId: "demo@demo-mp",
        machineId: "m1",
        homeDir: HOME,
        before: { install_scope: "user", enabled_at: "user" },
        after: { install_scope: "user", enabled_at: "project" },
        backupRootAbs: "/completely/unrelated/path/run1", // HOME 접두사 밖
        result: "success",
      }),
    ).toThrow(PathNormalizeFailedError);
  });
});
