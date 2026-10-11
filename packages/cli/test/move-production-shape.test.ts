import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import { runMove } from "../src/commands/move.js";
import { runRollback } from "../src/commands/rollback.js";

/**
 * 프로덕션 형태 move e2e — `CTK_CONFIG_DIR` **미설정**(configDirExplicit=false). 실제 .claude.json은
 * `$CTK_HOME/.claude.json`이고, `$CTK_HOME/.claude/.claude.json`은 내용이 다른 별개 파일이다.
 * 기존 move-rollback.test.ts는 CTK_CONFIG_DIR을 설정해 두 경로가 일치하므로 이 축을 못 태운다.
 *
 * 이음매(seam): 조치/캡처/검증을 `@ctk/actuator` 모듈 목으로 감싸 "조치 도중·직후 다른 세션이 실제 파일에 쓴다"를
 * 결정적으로 재현한다. 그 외(백업·감사·롤백·복원·journal)는 전부 실제 함수다. 플러그인 enable 자체(실제 claude)는
 * 목이다 — 이 테스트가 보는 것은 감사/롤백 배선이지 하네스가 아니다.
 */
const hooks = vi.hoisted(() => ({
  afterSkillApply: undefined as (() => void) | undefined,
  pluginApply: undefined as (() => void) | undefined,
  afterCapture: undefined as (() => void) | undefined,
  verifyFails: false,
  verifyPasses: false,
  beforeRestoreEntry: undefined as ((key: string) => void) | undefined,
}));

vi.mock("@ctk/actuator", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ctk/actuator")>();
  return {
    ...real,
    moveSkillDir: (...args: Parameters<typeof real.moveSkillDir>) => {
      const r = real.moveSkillDir(...args);
      hooks.afterSkillApply?.();
      return r;
    },
    movePluginEnablement: async () => {
      hooks.pluginApply?.();
    },
    // 복원 루프에 테스트 전용 이음매(onBeforeRestoreEntry)를 꽂는다 — 사전 CAS 통과 뒤의 경쟁을 결정적으로 재현.
    restoreFromBackup: (...args: Parameters<typeof real.restoreFromBackup>) => {
      const [backupRoot, home, manifestSha, shas, options] = args;
      return real.restoreFromBackupWithSeam(backupRoot, home, manifestSha, shas, options ?? {}, {
        onBeforeRestoreEntry: (key: string) => hooks.beforeRestoreEntry?.(key),
      });
    },
    verifyPluginEnablementMove: async (...args: Parameters<typeof real.verifyPluginEnablementMove>) => {
      if (hooks.verifyFails) throw new Error("verify failed (injected)");
      if (hooks.verifyPasses) return undefined as never; // 하네스 재스캔은 이 테스트의 관심사가 아니다
      return real.verifyPluginEnablementMove(...args);
    },
    // after 캡처만(before.cache를 넘기는 호출) 직후에 훅을 건다.
    captureRootSnapshot: (...args: Parameters<typeof real.captureRootSnapshot>) => {
      const r = real.captureRootSnapshot(...args);
      if (args[1] !== undefined) hooks.afterCapture?.();
      return r;
    },
  };
});

const PLUGIN = "demo-plugin@demo-marketplace";
const PLUGIN_LIST = JSON.stringify([
  { id: PLUGIN, version: "1.0.0", scope: "user", enabled: true, installPath: "/synthetic/cache/demo-plugin", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" },
]);
const fakeSpawn = (stdout: string) => async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

describe("cli — ctk move 프로덕션 형태(CTK_CONFIG_DIR 미설정, 실제 .claude.json = $HOME/.claude.json)", () => {
  let ctkHome: string;
  let configDir: string;
  let projectDir: string;
  let realJson: string;
  let innerJson: string;
  let settingsAbs: string;
  let catalogPath = "";
  let toSettingsAbs: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };

  const writeJson = (abs: string, v: unknown) => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(v), "utf8");
  };
  const read = (abs: string) => readFileSync(abs, "utf8");
  /** 지속 기록(run-log) — 화면 메시지는 사라지므로 롤백 점검 신호는 여기서 읽는다. */
  const lastRunLog = (command: string) => {
    const machinesDir = path.join(catalogPath, "machines");
    const runsDir = path.join(machinesDir, readdirSync(machinesDir)[0]!, "runs");
    const logs = readdirSync(runsDir).sort().map((f) => JSON.parse(read(path.join(runsDir, f))) as { command: string; args: Record<string, unknown> });
    return logs.filter((l) => l.command === command).at(-1)!;
  };

  beforeEach(() => {
    hooks.afterSkillApply = undefined;
    hooks.pluginApply = undefined;
    hooks.afterCapture = undefined;
    hooks.verifyFails = false;
    hooks.verifyPasses = false;
    hooks.beforeRestoreEntry = undefined;
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-move-prod-home-"));
    configDir = path.join(ctkHome, ".claude");
    projectDir = mkdtempSync(path.join(tmpdir(), "ctk-move-prod-project-"));
    realJson = path.join(ctkHome, ".claude.json");
    innerJson = path.join(configDir, ".claude.json");
    settingsAbs = path.join(configDir, "settings.json");
    toSettingsAbs = path.join(projectDir, ".claude", "settings.json");
    writeJson(realJson, { projects: { [projectDir]: { mcpServers: {} } }, cachedGrowthBookFeaturesAt: 1 });
    writeJson(innerJson, { inner: "distinct file" });
    writeJson(settingsAbs, { enabledPlugins: { [PLUGIN]: true } });
    writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { [PLUGIN]: [{ scope: "user", installPath: "/synthetic/cache/demo-plugin", version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }] },
    });
    originalEnv = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    delete process.env.CTK_CONFIG_DIR; // 프로덕션 형태
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    rmSync(ctkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("(i) 스킬 이동 중 실제 $HOME/.claude.json에 허용 밖 변경(MCP 서브트리)이 생기면 위반 + 롤백된다 — before 캡처가 조치 전에 있어야 성립", async () => {
    await runInit({});
    const skillDir = path.join(configDir, "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: fixture\n---\n", "utf8");
    await runScan({ spawnFn: fakeSpawn("[]") });
    const innerBefore = read(innerJson);

    hooks.afterSkillApply = () => writeJson(realJson, { projects: { [projectDir]: { mcpServers: { evil: { command: "x" } } } }, cachedGrowthBookFeaturesAt: 1 });

    const err = await runMove({ assetId: "demo-skill", to: "project", toProjectIndex: 0 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(".claude.json 의미 위반");
    expect((err as Error).message).toContain("mcpServers");
    expect((err as Error).message).toContain("[롤백 완료]");
    expect((err as Error).message).toContain("다른 Claude Code 세션");
    expect((err as Error).message).toContain("ctk가 의도한 변경이 아닙니다"); // N5
    expect((err as Error).message).toContain("MCP 서브트리 변경이 관측되었습니다"); // N5
    expect((err as Error).message).not.toContain(projectDir); // 프로젝트 경로 원문 없음(해시만)
    expect(existsSync(skillDir)).toBe(true); // 스킬은 원위치로 롤백
    expect(existsSync(path.join(projectDir, ".claude", "skills", "demo-skill"))).toBe(false);
    expect(read(innerJson)).toBe(innerBefore); // 별개 파일은 건드리지 않았다
  });

  async function setupPluginMove() {
    catalogPath = (await runInit({})).catalogPath;
    await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST) });
    // 조치 흉내: 이동 대상 플러그인의 enable 흔적 + 설정 변경.
    hooks.pluginApply = () => {
      writeJson(settingsAbs, { enabledPlugins: { [PLUGIN]: false } });
      writeJson(toSettingsAbs, { enabledPlugins: { [PLUGIN]: true } });
      writeJson(realJson, { projects: { [projectDir]: { mcpServers: {} } }, cachedGrowthBookFeaturesAt: 1, pluginUsage: { [PLUGIN]: { usageCount: 0, lastUsedAt: 2, lastUsedNumStartups: 0 } } });
    };
  }

  it("(ii-a) H1 — 롤백 직전 to_settings를 다른 세션이 바꿨으면 사전 검사가 막아 한 파일도 복원하지 않는다: '[롤백 미실행]'", async () => {
    await setupPluginMove();
    hooks.verifyFails = true;
    hooks.afterCapture = () => writeJson(toSettingsAbs, { enabledPlugins: { concurrent: true } });

    const err = await runMove({ assetId: PLUGIN, to: "project", toProjectIndex: 0 }).catch((e: unknown) => e as Error);

    expect((err as Error).name).toBe("ConfigClobberedError");
    expect((err as Error).message).toContain("[롤백 미실행]");
    expect((err as Error).message).toContain("적용된 상태로 남아 있습니다");
    expect((err as Error).message).toContain("~/.ctk-backups/"); // 백업 위치는 backup_ref 형식
    expect((err as Error).message).not.toContain(ctkHome);
    expect(JSON.parse(read(settingsAbs))).toEqual({ enabledPlugins: { [PLUGIN]: false } }); // 복원되지 않았다
  });

  it("(ii-b) N1 — 사전 검사 통과 뒤 복원 도중 경쟁이 나면 '[롤백 부분 실행]'으로 복원된/안 된 키를 사실대로 말한다", async () => {
    await setupPluginMove();
    hooks.verifyFails = true;
    hooks.beforeRestoreEntry = (key) => {
      if (key === "to_settings") writeJson(toSettingsAbs, { enabledPlugins: { raced: true } });
    };

    const err = await runMove({ assetId: PLUGIN, to: "project", toProjectIndex: 0 }).catch((e: unknown) => e as Error);

    expect((err as Error).name).toBe("RollbackFailedError");
    expect((err as Error).message).toContain("[롤백 부분 실행]");
    expect((err as Error).message).toContain("복원됨: from_settings");
    expect((err as Error).message).toContain("미복원: to_settings");
    expect((err as Error).message).not.toContain("[롤백 미실행]");
    expect(JSON.parse(read(settingsAbs))).toEqual({ enabledPlugins: { [PLUGIN]: true } }); // 앞 항목은 실제로 복원됐다
    expect(JSON.parse(read(toSettingsAbs))).toEqual({ enabledPlugins: { raced: true } }); // 경쟁 쓰기는 보존
    // N-L2: 부분 롤백은 지속 기록에도 남는다(journal은 스키마가 엄격해 run-log가 그 자리).
    expect(lastRunLog("move").args).toMatchObject({ restored_keys: ["from_settings"], unrestored_keys: ["to_settings"] });
  });

  it("(iii) N2 — 감사는 통과했지만 이후 검증이 실패해 롤백해도 .claude.json(다른 세션의 쓰기)은 복원하지 않는다", async () => {
    await setupPluginMove();
    const otherSession = { projects: { [projectDir]: { mcpServers: {} } }, cachedGrowthBookFeaturesAt: 77, pluginUsage: { [PLUGIN]: { usageCount: 0, lastUsedAt: 2, lastUsedNumStartups: 0 } } };
    hooks.afterCapture = () => writeJson(realJson, otherSession); // 측정된 churn(허용)
    hooks.verifyFails = true; // 감사 뒤 검증 실패 → 롤백

    const err = await runMove({ assetId: PLUGIN, to: "project", toProjectIndex: 0 }).catch((e: unknown) => e as Error);

    expect((err as Error).message).toContain("verify failed (injected)");
    expect(JSON.parse(read(realJson))).toEqual(otherSession); // 다른 세션의 쓰기가 살아 있다
    expect(JSON.parse(read(settingsAbs))).toEqual({ enabledPlugins: { [PLUGIN]: true } }); // ctk가 바꾼 파일은 복원
  });

  it("(iv) N2/N5 — 플러그인 이동 중 MCP 서브트리가 바뀌어 감사가 실패하면 롤백하되 .claude.json은 두고, MCP 변경을 눈에 띄게 알린다", async () => {
    await setupPluginMove();
    const evil = { projects: { [projectDir]: { mcpServers: { evil: { command: "x" } } } }, cachedGrowthBookFeaturesAt: 1 };
    hooks.afterCapture = () => writeJson(realJson, evil);

    const err = await runMove({ assetId: PLUGIN, to: "project", toProjectIndex: 0 }).catch((e: unknown) => e as Error);

    expect((err as Error).message).toContain("[롤백 완료]");
    expect((err as Error).message).toContain("MCP 서브트리 변경이 관측되었습니다");
    expect((err as Error).message).toMatch(/projects\.#[0-9a-f]{8}\.mcpServers/);
    expect((err as Error).message).toContain("~/.ctk-backups/");
    expect((err as Error).message).not.toContain(projectDir);
    expect(JSON.parse(read(realJson))).toEqual(evil); // 되돌리지 않았다
    expect(lastRunLog("move").args).toMatchObject({ claude_json: "violation", claude_json_mcp_forbidden: true });
    expect(JSON.parse(read(settingsAbs))).toEqual({ enabledPlugins: { [PLUGIN]: true } });
  });

  it("(v) N2 — 성공한 이동을 한참 뒤 `ctk rollback --last`로 되돌려도 그 사이 다른 세션이 쓴 .claude.json은 지워지지 않는다", async () => {
    await setupPluginMove();
    hooks.verifyPasses = true;
    await runMove({ assetId: PLUGIN, to: "project", toProjectIndex: 0 });
    // 이동 뒤 오래 지나 다른 세션이 쓴 것(허용 churn + 새 pluginUsage 항목 — 전체 복원이었다면 사라졌을 내용).
    const later = { projects: { [projectDir]: { mcpServers: {} } }, cachedGrowthBookFeaturesAt: 999, pluginUsage: { "other@mp": { usageCount: 5, lastUsedAt: 9 } } };
    writeJson(realJson, later);

    const summary = await runRollback({ last: true });

    expect(JSON.parse(read(realJson))).toEqual(later);
    expect(JSON.parse(read(settingsAbs))).toEqual({ enabledPlugins: { [PLUGIN]: true } }); // 설정은 이동 전으로
    expect(summary.claudeJsonNote).toContain("ctk가 의도한 것이 아닙니다"); // 새 pluginUsage 항목은 허용 밖 → 보고
    expect(summary.claudeJsonNote).toContain("~/.ctk-backups/");
    expect(summary.claudeJsonStatus).toBe("violation");
    expect(lastRunLog("rollback").args).toMatchObject({ claude_json: "violation", claude_json_mcp_forbidden: false });
  });

  // unjudgeable은 여기서 만들 수 없다 — 실제 파일이 깨지면 알려진 프로젝트 목록(= 복원 허용 루트)도 함께 사라져 복원 자체가
  // 거부된다. 그 상태 보고는 actuator 테스트가 다룬다.
  it.each([["ok", () => undefined]] as const)("(vi) 롤백 run-log가 .claude.json 점검 상태(%s)를 기록한다", async (status, mutate) => {
    await setupPluginMove();
    hooks.verifyPasses = true;
    await runMove({ assetId: PLUGIN, to: "project", toProjectIndex: 0 });
    mutate();

    const summary = await runRollback({ last: true });

    expect(summary.claudeJsonStatus).toBe(status);
    expect(lastRunLog("rollback").args).toMatchObject({ claude_json: status, claude_json_mcp_forbidden: false });
  });
});
