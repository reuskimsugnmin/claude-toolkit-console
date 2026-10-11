import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeJsonPath, resolveHomeContext, type HomeContext } from "@ctk/probe";
import { backupFile, beginBackupRun, writeBeforeSnapshot, writeManifest } from "../src/backup.js";
import { captureRootSnapshot } from "../src/audit.js";
import { ConfigClobberedError, RollbackFailedError, describeClaudeJsonLeftover, restoreFromBackup, restoreFromBackupWithSeam } from "../src/rollback.js";
import { atomicWriteFile, AtomicWriteVerifyError } from "../src/guard/atomic-write.js";

/**
 * 프로덕션 형태(CTK_CONFIG_DIR 미설정) 롤백 — 실제 .claude.json은 `$HOME/.claude.json`이고
 * `$HOME/.claude/.claude.json`은 별개 파일이다. 실제 home 계산·백업·manifest·복원 함수를 그대로 쓴다.
 */
describe("actuator/rollback — .claude.json은 어떤 롤백에서도 복원하지 않는다(N2) · H1 사전 CAS · N1 부분 복원 보고 (프로덕션 형태)", () => {
  const PLUGIN = "demo@market";
  let root: string;
  let home: HomeContext;
  let settingsAbs: string;
  let toSettingsAbs: string;
  let realAbs: string;
  let innerAbs: string;

  const sha = (abs: string) => createHash("sha256").update(readFileSync(abs)).digest("hex");
  const write = (abs: string, value: unknown) => writeFileSync(abs, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  const read = (abs: string) => readFileSync(abs, "utf8");

  /** 백업을 만들고(조치 직전), 조치가 두 settings와 enable 흔적을 바꾼 상태를 흉내 낸다. */
  function backupThenApply(backupJson: unknown, afterApplyJson: unknown) {
    write(settingsAbs, '{"enabledPlugins":{"p":false}}');
    write(toSettingsAbs, '{"enabledPlugins":{}}');
    write(realAbs, backupJson);
    write(innerAbs, { unrelated: true });
    const { backupRoot } = beginBackupRun(root, "run1");
    const entries = {
      from_settings: backupFile(backupRoot, "from_settings", settingsAbs),
      config_claude_json: backupFile(backupRoot, "config_claude_json", claudeJsonPath(home)),
      to_settings: backupFile(backupRoot, "to_settings", toSettingsAbs),
    };
    writeManifest(backupRoot, "run1", entries);
    writeBeforeSnapshot(backupRoot, { roots: [{ rootAbs: home.ctkConfigDir, entries: captureRootSnapshot(home.ctkConfigDir).entries }] });
    write(settingsAbs, '{"enabledPlugins":{"p":true}}'); // 조치
    write(toSettingsAbs, '{"enabledPlugins":{"p":true}}'); // 조치
    write(realAbs, afterApplyJson); // 조치(enable 흔적)
    return { backupRoot, expected: { from_settings: sha(settingsAbs), to_settings: sha(toSettingsAbs) } };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-rollback-cj-"));
    home = resolveHomeContext({ CTK_HOME: root }); // CTK_CONFIG_DIR 없음
    expect(home.configDirExplicit).toBe(false);
    mkdirSync(home.ctkConfigDir, { recursive: true });
    settingsAbs = path.join(home.ctkConfigDir, "settings.json");
    toSettingsAbs = path.join(home.ctkConfigDir, "to-settings.json"); // config 루트 안(허용 루트)이면 충분하다
    realAbs = claudeJsonPath(home);
    innerAbs = path.join(home.ctkConfigDir, ".claude.json");
    expect(realAbs).not.toBe(innerAbs);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("N2 — 허용 churn뿐이어도, 백업 이후 다른 세션이 쓴 .claude.json은 복원되지 않고 설정 파일들만 복원된다", () => {
    const { backupRoot, expected } = backupThenApply(
      { pluginUsage: { [PLUGIN]: { usageCount: 1, lastUsedAt: 1, lastUsedNumStartups: 4 } }, cachedGrowthBookFeaturesAt: 1 },
      { pluginUsage: { [PLUGIN]: { usageCount: 1, lastUsedAt: 2, lastUsedNumStartups: 0 } }, cachedGrowthBookFeaturesAt: 1 },
    );
    write(realAbs, { pluginUsage: { [PLUGIN]: { usageCount: 1, lastUsedAt: 2, lastUsedNumStartups: 0 } }, cachedGrowthBookFeaturesAt: 77 });
    const otherSessionBytes = read(realAbs);

    const report = restoreFromBackup(backupRoot, home, undefined, expected, { enabledPluginId: PLUGIN });

    expect(report.leftUntouchedKeys).toEqual(["config_claude_json"]);
    expect(report.claudeJson?.status).toBe("ok");
    expect(read(realAbs)).toBe(otherSessionBytes);
    expect(read(settingsAbs)).toBe('{"enabledPlugins":{"p":false}}');
    expect(read(toSettingsAbs)).toBe('{"enabledPlugins":{}}');
  });

  it("N2 — MCP 서브트리 위반도 복원하지 않고 **보고**한다(해시된 경로 · mcpForbidden · 백업 위치는 backup_ref로)", () => {
    const { backupRoot, expected } = backupThenApply(
      { projects: { "/synthetic/p": { mcpServers: {} } } },
      { projects: { "/synthetic/p": { mcpServers: { evil: { command: "x" } } } } },
    );
    const evilBytes = read(realAbs);

    const report = restoreFromBackup(backupRoot, home, undefined, expected, { enabledPluginId: PLUGIN });

    expect(read(realAbs)).toBe(evilBytes); // 되돌리지 않았다
    expect(report.claudeJson?.status).toBe("violation");
    expect(report.claudeJson?.mcpForbidden).toBe(true);
    expect(read(settingsAbs)).toBe('{"enabledPlugins":{"p":false}}'); // 나머지는 복원
    const note = describeClaudeJsonLeftover(report, "~/.ctk-backups/run1");
    expect(note).toMatch(/projects\.#[0-9a-f]{8}\.mcpServers/);
    expect(note).not.toContain("/synthetic/p"); // 프로젝트 경로 원문 없음
    expect(note).toContain("MCP 서브트리");
    expect(note).toContain("~/.ctk-backups/run1/config_claude_json");
    expect(note).not.toContain(root);
    // 백업본은 수동 복구용으로 남아 있다.
    expect(read(path.join(backupRoot, "config_claude_json", ".claude.json"))).toBe(JSON.stringify({ projects: { "/synthetic/p": { mcpServers: {} } } }));
  });

  it("N2 — 현재 파일이 없거나 깨져 판정할 수 없으면 unjudgeable로 보고한다(조용히 ok로 두지 않는다)", () => {
    // (파일이 깨진 경우는 여기까지 오지 않는다 — 알려진 프로젝트 목록을 읽는 preflight가 먼저 fail-closed로 던진다.)
    const { backupRoot, expected } = backupThenApply({ a: 1 }, { a: 1 });
    rmSync(realAbs);
    const report = restoreFromBackup(backupRoot, home, undefined, expected, { enabledPluginId: PLUGIN });
    expect(report.claudeJson?.status).toBe("unjudgeable");
    expect(describeClaudeJsonLeftover(report, "~/.ctk-backups/run1")).toContain("판정하지 못했습니다");
  });

  it("H1 — 사전 CAS: 뒤 항목(to_settings)을 다른 세션이 바꿨으면 앞 항목(from_settings)도 복원하지 않는다(0건 복원)", () => {
    const { backupRoot, expected } = backupThenApply({ a: 1 }, { a: 1 });
    const settingsApplied = read(settingsAbs);
    write(toSettingsAbs, '{"enabledPlugins":{"concurrent":true}}');

    let error: unknown;
    try {
      restoreFromBackup(backupRoot, home, undefined, expected, { enabledPluginId: PLUGIN });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigClobberedError);
    expect((error as Error).message).not.toContain(root); // N4: 절대경로 없음
    expect(read(settingsAbs)).toBe(settingsApplied);
  });

  it("N1 — 사전 검사 통과 뒤 복원 도중 뒤 항목이 바뀌면 '한 파일도 복원 안 함'이 아니라 부분 복원(restoredKeys/unrestoredKeys)으로 던진다", () => {
    const { backupRoot, expected } = backupThenApply({ a: 1 }, { a: 1 });

    let error: unknown;
    try {
      restoreFromBackupWithSeam(backupRoot, home, undefined, expected, { enabledPluginId: PLUGIN }, {
        onBeforeRestoreEntry: (key) => {
          if (key === "to_settings") write(toSettingsAbs, '{"enabledPlugins":{"raced":true}}');
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RollbackFailedError);
    const failed = error as RollbackFailedError;
    expect(failed.restoredKeys).toEqual(["from_settings"]);
    expect(failed.unrestoredKeys).toEqual(["to_settings"]);
    expect(failed.message).toContain("복원됨: [from_settings]");
    expect(failed.message).not.toContain(root);
    expect(read(settingsAbs)).toBe('{"enabledPlugins":{"p":false}}'); // 앞 항목은 실제로 복원됐다
    expect(read(toSettingsAbs)).toBe('{"enabledPlugins":{"raced":true}}'); // 경쟁 쓰기는 덮어쓰지 않았다
  });

  it("별개 파일 $HOME/.claude/.claude.json은 진짜 파일로 오인되지 않는다 — 트리 안 변경은 잔존 diff 검사가 잡는다", () => {
    const { backupRoot, expected } = backupThenApply({ a: 1 }, { a: 1 });
    write(innerAbs, { unrelated: "changed" });
    let error: unknown;
    try {
      restoreFromBackup(backupRoot, home, undefined, expected, { enabledPluginId: PLUGIN });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toMatch(/잔존 diff/);
    // N-L1: 잔존 diff로 실패해도 이미 복원된 키를 보고한다(부분 상태를 숨기지 않는다).
    expect((error as RollbackFailedError).restoredKeys).toEqual(["from_settings", "to_settings"]);
  });

  it("N-L3 — 백업 키(config_claude_json)로도 제외한다: CTK_CONFIG_DIR을 설정하고 만든 백업을 설정 없이 롤백해도 .claude.json을 CAS 없이 통째로 복원하지 않는다", () => {
    // 백업 시점: 격리 모드(.claude.json이 config dir 안). 롤백 시점: 프로덕션 모드(claudeJsonPath = $HOME/.claude.json).
    const isolated = resolveHomeContext({ CTK_HOME: root, CTK_CONFIG_DIR: home.ctkConfigDir });
    expect(claudeJsonPath(isolated)).toBe(innerAbs);
    write(settingsAbs, '{"enabledPlugins":{"p":false}}');
    write(innerAbs, { backedUp: true });
    const { backupRoot } = beginBackupRun(root, "run1");
    writeManifest(backupRoot, "run1", {
      from_settings: backupFile(backupRoot, "from_settings", settingsAbs),
      config_claude_json: backupFile(backupRoot, "config_claude_json", claudeJsonPath(isolated)),
    });
    write(settingsAbs, '{"enabledPlugins":{"p":true}}');
    write(innerAbs, { otherSession: "later write" });
    const later = read(innerAbs);

    const report = restoreFromBackup(backupRoot, home); // home = 프로덕션 형태

    expect(report.leftUntouchedKeys).toEqual(["config_claude_json"]);
    expect(read(innerAbs)).toBe(later);
    expect(read(settingsAbs)).toBe('{"enabledPlugins":{"p":false}}');
  });

  it("N4 — 원인 표기에 fs 경로도 파일 내용 조각도 싣지 않는다(오류 이름·코드만)", () => {
    const fsError = Object.assign(new Error(`ENOENT: no such file, open '${root}/secret-dir/settings.json'`), { code: "ENOENT" });
    const failed = new RollbackFailedError(path.join(root, ".ctk-backups", "run1"), fsError);
    expect(failed.message).toContain("ENOENT");
    expect(failed.message).not.toContain(root);

    const target = path.join(root, "w.json");
    let verifyError: unknown;
    try {
      atomicWriteFile(target, '{"env": SECRET_VALUE_123}', { reparse: (raw) => JSON.parse(raw) as unknown });
    } catch (e) {
      verifyError = e;
    }
    expect(verifyError).toBeInstanceOf(AtomicWriteVerifyError);
    expect((verifyError as Error).message).not.toContain("SECRET");
    expect((verifyError as Error).message).not.toContain(root);
  });
});
